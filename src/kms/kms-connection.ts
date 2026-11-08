import { type Channel, connectivityState } from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';

// How long one watch waits for a state change before it is simply re-armed.
const WATCH_INTERVAL_MS = 60_000;

const DAY_MS = 86_400_000;
const CLIENT_CERT_WARNING_DAYS = 30;

// Mirrors the Redis client's logging: one error when the KMS connection is
// lost and one line when it is back, instead of a log per failed attempt.
// gRPC lets an unused channel go IDLE and only reconnects on the next call,
// so an IDLE channel is told to connect again: the gateway stays connected,
// a broken KMS shows up in the log without waiting for traffic, and the
// first CipSeq request doesn't pay for the TLS handshake.
//
// The channel's state doesn't say why it failed, so `describeFailure` (a
// quick call that fails the same way) supplies the reason for the log line.
export function watchKmsConnection(
  channel: Pick<Channel, 'getConnectivityState' | 'watchConnectivityState'>,
  describeFailure: () => Promise<string>,
  logger: Pick<Logger, 'error' | 'log'> = new Logger('KMS'),
): void {
  let connectionLost = false;

  const onState = (state: connectivityState): void => {
    if (state === connectivityState.SHUTDOWN) {
      return; // closeKms() was called
    }

    if (state === connectivityState.TRANSIENT_FAILURE && !connectionLost) {
      connectionLost = true;
      void describeFailure()
        .catch(() => 'unknown error')
        .then((reason) =>
          logger.error(`Connection lost, reconnecting: ${reason}`),
        );
    } else if (state === connectivityState.READY && connectionLost) {
      connectionLost = false;
      logger.log('Connection restored');
    }

    if (state === connectivityState.IDLE) {
      channel.getConnectivityState(true);
    }

    channel.watchConnectivityState(state, Date.now() + WATCH_INTERVAL_MS, () =>
      onState(channel.getConnectivityState(false)),
    );
  };

  onState(channel.getConnectivityState(true));
}

// An expired certificate only shows up at the first KMS call, as an UNAVAILABLE
// that looks like an outage, so the gateway refuses to start with one.
export function checkClientCertificateExpiry(
  notAfter: Date,
  logger: Pick<Logger, 'warn'> = new Logger('KMS'),
  now: number = Date.now(),
): void {
  const daysLeft = (notAfter.getTime() - now) / DAY_MS;
  if (daysLeft <= 0) {
    throw new Error('KMS_CLIENT_CERT has expired. Run make renew-transport.');
  }
  if (daysLeft < CLIENT_CERT_WARNING_DAYS) {
    logger.warn(
      `KMS_CLIENT_CERT expires in ${Math.floor(daysLeft)} days. Run make renew-transport.`,
    );
  }
}

// Turns gRPC error details into a short reason like the Redis log's. grpc-js
// puts the cause after "Last error:", either a socket error
// ("connect ECONNREFUSED 127.0.0.1:50051") or an OpenSSL error
// ("...SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca:..." when the KMS
// rejects the gateway's certificate).
export function failureReason(details: string): string {
  const lastError =
    /Last error: ([^]*?)(?: \(\d{4}-\d\d-\d\dT[^)]*\))?\. Resolution note/.exec(
      details,
    )?.[1];
  if (!lastError) {
    return details.split('.')[0];
  }

  const socketCode = /\b(E[A-Z]{3,})\b/.exec(lastError)?.[1];
  if (socketCode) {
    return socketCode;
  }

  const tlsReason = /SSL routines:[^:]*:([^:]+):/.exec(lastError)?.[1];
  if (tlsReason) {
    return `TLS: ${tlsReason}`;
  }

  return lastError.trim();
}
