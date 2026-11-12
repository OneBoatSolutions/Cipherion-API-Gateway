import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  assertDeviceRequestLimit,
  ipRequestLimitHook,
} from './engine-limits.js';

const { evalScript } = vi.hoisted(() => ({ evalScript: vi.fn() }));

vi.mock('../lib/redis.js', () => ({ redis: { eval: evalScript } }));

const fakeReply = () => {
  const reply = {
    code: vi.fn(() => reply),
    header: vi.fn(() => reply),
    send: vi.fn(() => reply),
  };
  return reply;
};

describe('assertDeviceRequestLimit', () => {
  beforeEach(() => {
    evalScript.mockReset();
  });

  it('allows the 60th request in a minute', async () => {
    evalScript.mockResolvedValue(60);
    await expect(assertDeviceRequestLimit('dvc_1')).resolves.toBeUndefined();
  });

  it('answers the 61st with 429 and how long to wait', async () => {
    evalScript.mockResolvedValue(61);
    const error = await assertDeviceRequestLimit('dvc_1').catch(
      (caught: HttpException) => caught,
    );
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      retryAfter: 60,
    });
  });

  it('fails closed when Redis is down', async () => {
    evalScript.mockRejectedValue(new Error('down'));
    await expect(assertDeviceRequestLimit('dvc_1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('ipRequestLimitHook', () => {
  beforeEach(() => {
    evalScript.mockReset();
  });

  const run = async () => {
    const reply = fakeReply();
    await ipRequestLimitHook(
      { ip: '203.0.113.9' },
      reply as unknown as FastifyReply,
    );
    return reply;
  };

  it('counts per address and lets the request through under the limit', async () => {
    evalScript.mockResolvedValue(600);
    const reply = await run();
    expect(evalScript.mock.calls[0][2]).toBe('cipseq:engine-ip:203.0.113.9');
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('answers over the limit with 429 and Retry-After', async () => {
    evalScript.mockResolvedValue(601);
    const reply = await run();
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('fails closed when Redis is down', async () => {
    evalScript.mockRejectedValue(new Error('down'));
    const reply = await run();
    expect(reply.code).toHaveBeenCalledWith(503);
  });
});
