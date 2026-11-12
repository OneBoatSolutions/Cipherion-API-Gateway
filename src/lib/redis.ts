import '../config/env.js';
import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { reportLost, reportRestored } from './connection-events.js';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error('REDIS_URL is not configured');
}

// The CA to trust for a self-signed Redis certificate (rediss:// only, checked
// in env.schema.ts). Without it, Node's built-in CAs are used. The certificate
// is still verified either way; this never turns verification off.
const caPath = process.env.REDIS_CA_CERT;
const readCa = (path: string): Buffer => {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`REDIS_CA_CERT can't be read from ${path}`, {
      cause: error,
    });
  }
};

// Shared client: Better Auth sessions and rate limits, and later business caching.
export const redis = new Redis(redisUrl, {
  ...(caPath ? { tls: { ca: readCa(caPath) } } : {}),
  // While Redis is unreachable, fail commands within seconds instead of queueing
  // them through 20 reconnect attempts (over a minute), which hangs every auth call.
  maxRetriesPerRequest: 1,
  commandTimeout: 2000,
});

// Without an `error` listener ioredis prints every failed reconnect to stderr.
// connection-events.ts logs the outage once and its recovery once instead.
let lastError: string | undefined;

redis.on('error', (error: NodeJS.ErrnoException) => {
  lastError = error.code || error.message || error.name;
  reportLost('REDIS', lastError);
});

redis.on('ready', () => {
  lastError = undefined;
  reportRestored('REDIS');
});

// The connection's own error (ECONNREFUSED, SELF_SIGNED_CERT_IN_CHAIN, ...),
// which says more than a failed command's "max retries" error.
export const redisErrorReason = (fallback: string): string =>
  lastError ?? fallback;
