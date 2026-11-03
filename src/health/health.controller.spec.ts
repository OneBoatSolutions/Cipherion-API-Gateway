import { ServiceUnavailableException } from '@nestjs/common';
import { CHECK_TIMEOUT_MS, HealthController } from './health.controller.js';

const { queryRaw, cipseqQueryRaw, ping } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  cipseqQueryRaw: vi.fn(),
  ping: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: { $queryRaw: cipseqQueryRaw },
}));
vi.mock('../lib/redis.js', () => ({ redis: { ping } }));

describe('HealthController', () => {
  const controller = new HealthController();

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    cipseqQueryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    ping.mockReset().mockResolvedValue('PONG');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports liveness without checking dependencies', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(cipseqQueryRaw).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it('is ready when both databases and Redis are up', async () => {
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', cipseq: 'up', redis: 'up' },
    });
  });

  it('answers 503 and names the dependency that is down', async () => {
    ping.mockRejectedValue(new Error('Connection is closed.'));

    const error = await controller.ready().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { database: 'up', cipseq: 'up', redis: 'down' },
    });
  });

  it('answers 503 when only the CipSeq database is down', async () => {
    cipseqQueryRaw.mockRejectedValue(new Error('database does not exist'));

    const error = await controller.ready().catch((e: unknown) => e);

    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { database: 'up', cipseq: 'down', redis: 'up' },
    });
  });

  it('counts a dependency that does not answer in time as down', async () => {
    vi.useFakeTimers();
    queryRaw.mockReturnValue(new Promise(() => {}));

    const result = controller.ready().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);

    const error = (await result) as ServiceUnavailableException;
    expect(error.getResponse()).toEqual({
      status: 'error',
      checks: { database: 'down', cipseq: 'up', redis: 'up' },
    });
  });
});
