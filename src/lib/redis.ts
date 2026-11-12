import '../config/env.js';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';

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
// Log the outage once and its recovery once instead.
const logger = new Logger('Redis');
let connectionLost = false;

redis.on('error', (error: NodeJS.ErrnoException) => {
  if (connectionLost) {
    return;
  }
  connectionLost = true;
  logger.error(
    `Connection lost, reconnecting: ${error.message || error.code || error.name}`,
  );
});

redis.on('ready', () => {
  if (connectionLost) {
    connectionLost = false;
    logger.log('Connection restored');
  }
});
