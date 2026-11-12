import { connectivityState } from '@grpc/grpc-js';
import { HealthCheckResponse_ServingStatus } from '../generated/kms/grpc/health/v1/health.js';
import {
  checkClientCertificateExpiry,
  failureReason,
  servingFailure,
  watchKmsConnection,
} from './kms-connection.js';

// The default reporter would load the database clients; every test passes its own.
vi.mock('../lib/connection-events.js', () => ({
  reportLost: vi.fn(),
  reportRestored: vi.fn(),
}));

describe('checkClientCertificateExpiry', () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  const inDays = (days: number) => new Date(now + days * 86_400_000);

  it.each([0, -1])('refuses a certificate %i days from expiry', (days) => {
    expect(() =>
      checkClientCertificateExpiry(inDays(days), { warn: vi.fn() }, now),
    ).toThrow('KMS_CLIENT_CERT has expired');
  });

  it('warns under 30 days', () => {
    const warn = vi.fn();
    checkClientCertificateExpiry(inDays(29.5), { warn }, now);
    expect(warn).toHaveBeenCalledWith(
      'KMS_CLIENT_CERT expires in 29 days. Run make renew-transport.',
    );
  });

  it('stays quiet from 30 days', () => {
    const warn = vi.fn();
    checkClientCertificateExpiry(inDays(30), { warn }, now);
    expect(warn).not.toHaveBeenCalled();
  });
});

const { IDLE, CONNECTING, READY, TRANSIENT_FAILURE, SHUTDOWN } =
  connectivityState;

// A channel whose state the test drives: move() changes the state and fires
// the pending watch callback, like grpc-js does.
function fakeChannel(initial: connectivityState) {
  let state = initial;
  let pending: (() => void) | undefined;
  const connectRequests: connectivityState[] = [];

  const channel = {
    getConnectivityState: vi.fn((tryToConnect: boolean) => {
      if (tryToConnect && state === IDLE) {
        connectRequests.push(state);
      }
      return state;
    }),
    watchConnectivityState: vi.fn(
      (
        _current: connectivityState,
        _deadline: number,
        callback: () => void,
      ) => {
        pending = callback;
      },
    ),
  };

  const move = (next: connectivityState) => {
    state = next;
    const callback = pending;
    pending = undefined;
    callback?.();
  };

  return { channel, move, connectRequests, isWatching: () => !!pending };
}

// Lets the async failure description resolve before asserting on the log.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// connection-events.ts turns these reports into one log line each way; its own
// spec covers that.
describe('watchKmsConnection', () => {
  const report = { lost: vi.fn(), restored: vi.fn() };
  const describeFailure = vi.fn();

  beforeEach(() => {
    report.lost.mockReset();
    report.restored.mockReset();
    describeFailure.mockReset().mockResolvedValue('ECONNREFUSED');
  });

  it('connects at startup and reports no outage while the KMS is healthy', async () => {
    const { channel, move } = fakeChannel(IDLE);
    watchKmsConnection(channel, describeFailure, report);

    expect(channel.getConnectivityState).toHaveBeenCalledWith(true);
    move(CONNECTING);
    move(READY);
    await flush();

    expect(report.lost).not.toHaveBeenCalled();
    expect(describeFailure).not.toHaveBeenCalled();
  });

  it('reports a lost connection once, with the reason, then the recovery', async () => {
    const { channel, move } = fakeChannel(READY);
    watchKmsConnection(channel, describeFailure, report);

    // Several failed reconnect attempts ask for the reason only once.
    move(TRANSIENT_FAILURE);
    move(CONNECTING);
    move(TRANSIENT_FAILURE);
    move(IDLE);
    move(CONNECTING);
    await flush();
    move(READY);

    expect(describeFailure).toHaveBeenCalledTimes(1);
    expect(report.lost).toHaveBeenCalledTimes(1);
    expect(report.lost).toHaveBeenCalledWith('ECONNREFUSED');
    expect(report.restored).toHaveBeenCalled();
  });

  it('still reports when the reason cannot be found', async () => {
    describeFailure.mockRejectedValue(new Error('boom'));
    const { channel, move } = fakeChannel(CONNECTING);
    watchKmsConnection(channel, describeFailure, report);

    move(TRANSIENT_FAILURE);
    await flush();

    expect(report.lost).toHaveBeenCalledWith('unknown error');
  });

  it('asks an idle channel to connect again', () => {
    const { channel, move, connectRequests } = fakeChannel(READY);
    watchKmsConnection(channel, describeFailure, report);

    move(IDLE);

    expect(connectRequests).toHaveLength(1);
  });

  it('stops watching once the channel is shut down', () => {
    const { channel, move, isWatching } = fakeChannel(READY);
    watchKmsConnection(channel, describeFailure, report);
    expect(isWatching()).toBe(true);

    move(SHUTDOWN);

    expect(isWatching()).toBe(false);
  });
});

describe('servingFailure', () => {
  it('is undefined only for SERVING', () => {
    expect(
      servingFailure(null, HealthCheckResponse_ServingStatus.SERVING),
    ).toBeUndefined();
  });

  it.each([
    [HealthCheckResponse_ServingStatus.NOT_SERVING, 'NOT_SERVING'],
    [HealthCheckResponse_ServingStatus.SERVICE_UNKNOWN, 'SERVICE_UNKNOWN'],
  ])('names a %s answer', (status, name) => {
    expect(servingFailure(null, status)).toBe(`health check answered ${name}`);
  });

  it('shortens an error to its cause', () => {
    expect(
      servingFailure({
        details:
          'No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:50051. Resolution note: ',
      }),
    ).toBe('ECONNREFUSED');
  });
});

describe('failureReason', () => {
  it.each([
    [
      'No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:50051. Resolution note: ',
      'ECONNREFUSED',
    ],
    [
      'No connection established. Last error: read ECONNRESET (2026-11-03T12:36:45.665Z). Resolution note:',
      'ECONNRESET',
    ],
  ])('extracts the socket error code', (details, code) => {
    expect(failureReason(details)).toBe(code);
  });

  it('extracts the TLS alert when the KMS rejects the certificate', () => {
    const details =
      'No connection established. Last error: A4880000:error:0A000418:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:openssl\\ssl\\record\\rec_layer_s3.c:918:SSL alert number 48\n (2026-11-03T13:24:38.143Z). Resolution note: ';

    expect(failureReason(details)).toBe('TLS: tlsv1 alert unknown ca');
  });

  it('keeps any other last error as it is', () => {
    expect(
      failureReason(
        'No connection established. Last error: getaddrinfo failed (2026-11-03T13:24:38.143Z). Resolution note: ',
      ),
    ).toBe('getaddrinfo failed');
  });

  it('falls back to the first sentence of the details', () => {
    expect(
      failureReason('Connection dropped. Something else happened later'),
    ).toBe('Connection dropped');
  });
});
