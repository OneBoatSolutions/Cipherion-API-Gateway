import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

// How often an idle pool is checked, and how long one check may take.
export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 2000;

type WatchedPool = Pick<Pool, 'query' | 'on'>;

const stopFunctions = new Set<() => void>();

// Mirrors the Redis and KMS logging: one error when a database connection is
// lost and one line when it is back, instead of a log per failed query.
// pg has no "reconnected" event, so a heartbeat (SELECT 1) notices both the
// outage, even without traffic, and the recovery.
//
// It also listens for the pool's `error` event, which pg emits when an idle
// connection dies (e.g. a Postgres restart). Without a listener Node treats
// that event as an uncaught error and crashes the process.
export function watchDatabase(
  pool: WatchedPool,
  logger: Pick<Logger, 'error' | 'log'>,
): () => void {
  let connectionLost = false;
  let stopped = false;
  let checking = false;

  const lost = (error: unknown): void => {
    if (stopped || connectionLost) {
      return;
    }
    connectionLost = true;
    logger.error(
      `Connection lost, reconnecting: ${connectionErrorReason(error)}`,
    );
  };

  const heartbeat = async (): Promise<void> => {
    if (checking) {
      return; // the previous check is still waiting for its timeout
    }
    checking = true;
    try {
      await withTimeout(pool.query('SELECT 1'), HEARTBEAT_TIMEOUT_MS);
      if (connectionLost && !stopped) {
        connectionLost = false;
        logger.log('Connection restored');
      }
    } catch (error) {
      lost(error);
    } finally {
      checking = false;
    }
  };

  pool.on('error', lost);
  const timer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
  timer.unref(); // never keeps the process alive on its own

  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
    stopFunctions.delete(stop);
  };
  stopFunctions.add(stop);
  return stop;
}

// Stops every heartbeat; called on shutdown before the pools are closed, so
// closing them isn't reported as a lost connection.
export function stopDatabaseWatches(): void {
  for (const stop of stopFunctions) {
    stop();
  }
}

// A short reason like the Redis and KMS log lines: the socket error code
// (ECONNREFUSED, ECONNRESET, ...), or the Postgres SQLSTATE with its message
// (57P01 terminating connection due to administrator command), or the message.
// pg's messages never contain the connection string or password.
export function connectionErrorReason(error: unknown): string {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === 'string' ? message : '';

  if (typeof code === 'string') {
    if (/^E[A-Z]+$/.test(code)) {
      return code;
    }
    if (/^[0-9A-Z]{5}$/.test(code)) {
      return text ? `${code} ${text}` : code;
    }
  }
  return text || 'unknown error';
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
