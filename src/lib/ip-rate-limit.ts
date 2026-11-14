import { Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { clientIp } from './client-ip.js';
import {
  countInWindow,
  RATE_LIMIT_WINDOW_SECONDS,
  RATE_LIMITS,
  TOO_MANY_REQUESTS_MESSAGE,
} from './rate-limit.js';

const logger = new Logger('RateLimit');

// Better Auth limits its own routes, and probes must always answer. Preflights
// are skipped: browsers send one before most writes, and they cost nothing.
const SKIPPED_PREFIXES = ['/api/v1/auth/', '/api/v1/health', '/api/v1/ready'];

const isSkipped = (request: Pick<FastifyRequest, 'method' | 'url'>) => {
  if (request.method === 'OPTIONS') {
    return true;
  }
  const path = request.url.split('?', 1)[0];
  return (
    path === '/api/v1/auth' ||
    SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
};

let countingDown = false;

// Every main-app request, before the session lookup, so a flood is refused
// cheaply. A Fastify hook runs before Nest's exception filters, so it answers
// directly. Unlike the per-user write limit, it lets requests through while
// Redis is down: it's only flood protection, and refusing would also block
// every read. That's logged once each way.
export async function ipRateLimitHook(
  request: Pick<FastifyRequest, 'method' | 'url' | 'headers' | 'ip'>,
  reply: FastifyReply,
): Promise<void> {
  if (isSkipped(request)) {
    return;
  }
  const ip = clientIp(request.headers['x-forwarded-for'], request.ip);
  let count: number;
  try {
    count = await countInWindow(
      `ratelimit:ip:${ip}`,
      RATE_LIMIT_WINDOW_SECONDS,
    );
  } catch (error) {
    if (!countingDown) {
      countingDown = true;
      logger.warn(
        `Per-IP rate limit is off until Redis answers: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    return;
  }
  if (countingDown) {
    countingDown = false;
    logger.log('Per-IP rate limit is counting again');
  }
  if (count > RATE_LIMITS.ipRequestsPerMinute) {
    await reply
      .code(429)
      .header('Retry-After', String(RATE_LIMIT_WINDOW_SECONDS))
      .send({ statusCode: 429, message: TOO_MANY_REQUESTS_MESSAGE });
  }
}
