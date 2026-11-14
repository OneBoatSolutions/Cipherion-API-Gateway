import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply } from 'fastify';
import { ipRateLimitHook } from './ip-rate-limit.js';
import {
  countInWindow,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMITS,
} from './rate-limit.js';
import { RateLimit, RateLimitGuard } from './rate-limit.guard.js';

const { redisMock } = vi.hoisted(() => ({ redisMock: { eval: vi.fn() } }));
vi.mock('./redis.js', () => ({ redis: redisMock }));

// A Redis counter per key, like the Lua script.
const counts = new Map<string, number>();
beforeEach(() => {
  counts.clear();
  Object.assign(RATE_LIMITS, RATE_LIMIT_DEFAULTS);
  redisMock.eval.mockReset();
  redisMock.eval.mockImplementation(
    async (_script: string, _keys: number, key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts.get(key);
    },
  );
});

describe('countInWindow', () => {
  it('counts per key, with the window as the expiry', async () => {
    await expect(countInWindow('a', 60)).resolves.toBe(1);
    await expect(countInWindow('a', 60)).resolves.toBe(2);
    await expect(countInWindow('b', 60)).resolves.toBe(1);
    expect(redisMock.eval).toHaveBeenCalledWith(expect.any(String), 1, 'a', 60);
  });
});

describe('RateLimitGuard', () => {
  class Routes {
    @RateLimit()
    write() {}
    read() {}
  }

  const guard = new RateLimitGuard(new Reflector());
  const call = (handler: keyof Routes, userId?: string) => {
    const reply = { header: vi.fn() };
    const context = {
      getHandler: () => Routes.prototype[handler],
      switchToHttp: () => ({
        getRequest: () => ({ user: userId ? { id: userId } : undefined }),
        getResponse: () => reply,
      }),
    } as unknown as ExecutionContext;
    return { result: guard.canActivate(context), reply };
  };

  it('allows 60 writes a minute per user, then answers 429 with Retry-After', async () => {
    for (let i = 0; i < 60; i++) {
      await expect(call('write', 'u1').result).resolves.toBe(true);
    }
    const { result, reply } = call('write', 'u1');
    await expect(result).rejects.toMatchObject({ status: 429 });
    await expect(call('write', 'u1').result).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '60');
    expect(counts.has('ratelimit:user:writes:u1')).toBe(true);
  });

  it('counts each user separately', async () => {
    RATE_LIMITS.userWritesPerMinute = 1;
    await expect(call('write', 'u1').result).resolves.toBe(true);
    await expect(call('write', 'u1').result).rejects.toMatchObject({
      status: 429,
    });
    await expect(call('write', 'u2').result).resolves.toBe(true);
  });

  it('leaves routes without @RateLimit, and requests without a user, alone', async () => {
    await expect(call('read', 'u1').result).resolves.toBe(true);
    await expect(call('write').result).resolves.toBe(true);
    expect(redisMock.eval).not.toHaveBeenCalled();
  });

  it('answers 503 when Redis is down', async () => {
    redisMock.eval.mockRejectedValueOnce(new Error('down'));
    await expect(call('write', 'u1').result).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('ipRateLimitHook', () => {
  const send = (method: string, url: string, forwardedFor?: string) => {
    const reply = {
      code: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const done = ipRateLimitHook(
      {
        method,
        url,
        ip: '10.0.1.7',
        headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
      },
      reply as unknown as FastifyReply,
    );
    return { done, reply };
  };

  it('allows 600 requests a minute per client IP, then answers 429', async () => {
    RATE_LIMITS.ipRequestsPerMinute = 3;
    for (let i = 0; i < 3; i++) {
      const { done, reply } = send('GET', '/api/v1/workspace', '203.0.113.1');
      await done;
      expect(reply.code).not.toHaveBeenCalled();
    }
    const { done, reply } = send('GET', '/api/v1/workspace', '203.0.113.1');
    await done;
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '60');

    // Another client behind the same proxy has its own count.
    const other = send('GET', '/api/v1/workspace', '203.0.113.2');
    await other.done;
    expect(other.reply.code).not.toHaveBeenCalled();
    expect(counts.has('ratelimit:ip:203.0.113.1')).toBe(true);
  });

  it('defaults to 600', () => {
    expect(RATE_LIMIT_DEFAULTS.ipRequestsPerMinute).toBe(600);
    expect(RATE_LIMIT_DEFAULTS.userWritesPerMinute).toBe(60);
  });

  it.each([
    ['POST', '/api/v1/auth/sign-in/email'],
    ['GET', '/api/v1/auth'],
    ['GET', '/api/v1/health'],
    ['GET', '/api/v1/ready?verbose=1'],
    ['OPTIONS', '/api/v1/cipseq/projects'],
  ])('skips %s %s', async (method, url) => {
    await send(method, url).done;
    expect(redisMock.eval).not.toHaveBeenCalled();
  });

  it('lets requests through while Redis is down', async () => {
    redisMock.eval.mockRejectedValue(new Error('down'));
    const { done, reply } = send('GET', '/api/v1/workspace');
    await done;
    expect(reply.code).not.toHaveBeenCalled();
  });
});
