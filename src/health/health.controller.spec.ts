import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { CHECK_TIMEOUT_MS, HealthController } from './health.controller.js';

const { queryRaw, cipseqQueryRaw, ping, checkKmsServing } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  cipseqQueryRaw: vi.fn(),
  ping: vi.fn(),
  checkKmsServing: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: { $queryRaw: cipseqQueryRaw },
}));
vi.mock('../lib/redis.js', () => ({ redis: { ping } }));
vi.mock('../lib/kms.js', () => ({ checkKmsServing }));

const allUp = { database: 'up', cipseq: 'up', redis: 'up', kms: 'up' };

describe('HealthController', () => {
  const controller = new HealthController();

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    cipseqQueryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    ping.mockReset().mockResolvedValue('PONG');
    checkKmsServing.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports liveness without checking dependencies', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(cipseqQueryRaw).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    expect(checkKmsServing).not.toHaveBeenCalled();
  });

  it('is ready when both databases, Redis and the KMS are up', async () => {
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      checks: allUp,
    });
  });

  it('answers 503 and names the dependency that is down', async () => {
    ping.mockRejectedValue(new Error('Connection is closed.'));

    const error = await controller.ready().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { ...allUp, redis: 'down' },
    });
  });

  it('answers 503 when only the CipSeq database is down', async () => {
    cipseqQueryRaw.mockRejectedValue(new Error('database does not exist'));

    const error = await controller.ready().catch((e: unknown) => e);

    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { ...allUp, cipseq: 'down' },
    });
  });

  it('counts the KMS as down when it is unreachable or not serving', async () => {
    checkKmsServing.mockRejectedValue(
      new Error('health check answered NOT_SERVING'),
    );

    const error = await controller.ready().catch((e: unknown) => e);

    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { ...allUp, kms: 'down' },
    });
  });

  // The KMS connection watch logs an outage once; /ready must not add lines.
  it('logs nothing when a dependency is down', async () => {
    const spies = (['error', 'warn', 'log'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => {}),
    );
    checkKmsServing.mockRejectedValue(new Error('ECONNREFUSED'));
    ping.mockRejectedValue(new Error('Connection is closed.'));

    await controller.ready().catch(() => {});
    await controller.ready().catch(() => {});

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('gives the KMS health check the readiness deadline', async () => {
    await controller.ready();

    expect(checkKmsServing).toHaveBeenCalledWith(CHECK_TIMEOUT_MS);
  });

  it('counts a dependency that does not answer in time as down', async () => {
    vi.useFakeTimers();
    queryRaw.mockReturnValue(new Promise(() => {}));

    const result = controller.ready().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);

    const error = (await result) as ServiceUnavailableException;
    expect(error.getResponse()).toEqual({
      status: 'error',
      checks: { ...allUp, database: 'down' },
    });
  });
});
