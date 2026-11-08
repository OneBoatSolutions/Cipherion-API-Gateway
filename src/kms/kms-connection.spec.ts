import { connectivityState } from '@grpc/grpc-js';
import {
  checkClientCertificateExpiry,
  failureReason,
  watchKmsConnection,
} from './kms-connection.js';

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

describe('watchKmsConnection', () => {
  const logger = { error: vi.fn(), log: vi.fn() };
  const describeFailure = vi.fn();

  beforeEach(() => {
    logger.error.mockReset();
    logger.log.mockReset();
    describeFailure.mockReset().mockResolvedValue('ECONNREFUSED');
  });

  it('connects at startup and stays quiet while the KMS is healthy', async () => {
    const { channel, move } = fakeChannel(IDLE);
    watchKmsConnection(channel, describeFailure, logger);

    expect(channel.getConnectivityState).toHaveBeenCalledWith(true);
    move(CONNECTING);
    move(READY);
    await flush();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    expect(describeFailure).not.toHaveBeenCalled();
  });

  it('logs a lost connection once, with the reason, and its recovery once', async () => {
    const { channel, move } = fakeChannel(READY);
    watchKmsConnection(channel, describeFailure, logger);

    // Several failed reconnect attempts produce a single error.
    move(TRANSIENT_FAILURE);
    move(CONNECTING);
    move(TRANSIENT_FAILURE);
    move(IDLE);
    move(CONNECTING);
    await flush();
    move(READY);
    move(READY);

    expect(describeFailure).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Connection lost, reconnecting: ECONNREFUSED',
    );
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith('Connection restored');
  });

  it('still logs when the reason cannot be found', async () => {
    describeFailure.mockRejectedValue(new Error('boom'));
    const { channel, move } = fakeChannel(CONNECTING);
    watchKmsConnection(channel, describeFailure, logger);

    move(TRANSIENT_FAILURE);
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      'Connection lost, reconnecting: unknown error',
    );
  });

  it('asks an idle channel to connect again', () => {
    const { channel, move, connectRequests } = fakeChannel(READY);
    watchKmsConnection(channel, describeFailure, logger);

    move(IDLE);

    expect(connectRequests).toHaveLength(1);
  });

  it('stops watching once the channel is shut down', () => {
    const { channel, move, isWatching } = fakeChannel(READY);
    watchKmsConnection(channel, describeFailure, logger);
    expect(isWatching()).toBe(true);

    move(SHUTDOWN);

    expect(isWatching()).toBe(false);
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
