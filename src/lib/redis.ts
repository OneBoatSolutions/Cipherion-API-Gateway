import '../config/env.js';
import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error('REDIS_URL is not configured');
}

// Shared client: Better Auth sessions and rate limits, and later business caching.
export const redis = new Redis(redisUrl, {
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
