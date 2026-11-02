import { ServiceUnavailableException } from '@nestjs/common';
import { CHECK_TIMEOUT_MS, HealthController } from './health.controller.js';

const { queryRaw, ping } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  ping: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock('../lib/redis.js', () => ({ redis: { ping } }));

describe('HealthController', () => {
  const controller = new HealthController();

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    ping.mockReset().mockResolvedValue('PONG');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports liveness without checking dependencies', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it('is ready when the database and Redis are up', async () => {
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('answers 503 and names the dependency that is down', async () => {
    ping.mockRejectedValue(new Error('Connection is closed.'));

    const error = await controller.ready().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { database: 'up', redis: 'down' },
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
      checks: { database: 'down', redis: 'up' },
    });
  });
});
