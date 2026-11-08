import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../lib/redis.js';

// One device can't queue up on its own lock and hold every pooled connection. This
// is on top of the attempt limits in the database, which only count once a request
// has the lock.
const DEVICE_REQUESTS_PER_MINUTE = 60;
// Port 3443 is public, so this runs before any session or database work. It's high
// because many devices can share one office IP. A firewall connection limit is
// still needed in front of it, because this can't stop TLS handshakes.
const IP_REQUESTS_PER_MINUTE = 600;
const WINDOW_SECONDS = 60;

// The first increment starts the window, atomically, so a crash can't leave a
// counter that never expires.
const COUNT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

async function countRequest(key: string): Promise<number> {
  return Number(await redis.eval(COUNT_SCRIPT, 1, key, WINDOW_SECONDS));
}

// Fails closed, like the session store: without Redis the limit can't be enforced.
export async function assertDeviceRequestLimit(
  deviceId: string,
): Promise<void> {
  let count: number;
  try {
    count = await countRequest(`cipseq:engine-device:${deviceId}`);
  } catch {
    throw new ServiceUnavailableException(
      'Unavailable. Please try again shortly.',
    );
  }
  if (count > DEVICE_REQUESTS_PER_MINUTE) {
    throw new HttpException(
      {
        statusCode: 429,
        message: 'Too many requests.',
        retryAfter: WINDOW_SECONDS,
      },
      429,
    );
  }
}

// A Fastify hook runs before Nest's exception filters, so it answers directly. The
// app sets trustProxy to false, so request.ip is the socket's address.
export async function ipRequestLimitHook(
  request: Pick<FastifyRequest, 'ip'>,
  reply: FastifyReply,
): Promise<void> {
  let count: number;
  try {
    count = await countRequest(`cipseq:engine-ip:${request.ip}`);
  } catch {
    await reply.code(503).send({
      statusCode: 503,
      message: 'Unavailable. Please try again shortly.',
    });
    return;
  }
  if (count > IP_REQUESTS_PER_MINUTE) {
    await reply
      .code(429)
      .header('Retry-After', String(WINDOW_SECONDS))
      .send({ statusCode: 429, message: 'Too many requests.' });
  }
}
