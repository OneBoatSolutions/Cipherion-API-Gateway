import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheckResponse_ServingStatus } from '../generated/kms/grpc/health/v1/health.js';
import { CHECK_TIMEOUT_MS, HealthController } from './health.controller.js';

const { queryRaw, cipseqQueryRaw, ping, healthCheck } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  cipseqQueryRaw: vi.fn(),
  ping: vi.fn(),
  healthCheck: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: { $queryRaw: cipseqQueryRaw },
}));
vi.mock('../lib/redis.js', () => ({ redis: { ping } }));
vi.mock('../lib/kms.js', () => ({ kmsHealth: { check: healthCheck } }));

// Makes the mocked grpc.health.v1 Check answer with a status or an error.
const kmsAnswers = (status: HealthCheckResponse_ServingStatus | Error) =>
  healthCheck.mockImplementation((_req, _md, _opts, callback) =>
    status instanceof Error ? callback(status) : callback(null, { status }),
  );

const allUp = { database: 'up', cipseq: 'up', redis: 'up', kms: 'up' };

describe('HealthController', () => {
  const controller = new HealthController();

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    cipseqQueryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    ping.mockReset().mockResolvedValue('PONG');
    healthCheck.mockReset();
    kmsAnswers(HealthCheckResponse_ServingStatus.SERVING);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports liveness without checking dependencies', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(cipseqQueryRaw).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('is ready when both databases, Redis and the KMS are up', async () => {
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      checks: allUp,
    });
    expect(healthCheck.mock.calls[0][0]).toEqual({ service: '' });
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

  it.each([
    ['is unreachable', new Error('14 UNAVAILABLE: No connection established')],
    ['reports NOT_SERVING', HealthCheckResponse_ServingStatus.NOT_SERVING],
    [
      'reports SERVICE_UNKNOWN',
      HealthCheckResponse_ServingStatus.SERVICE_UNKNOWN,
    ],
  ])('counts the KMS as down when it %s', async (_label, answer) => {
    kmsAnswers(answer);

    const error = await controller.ready().catch((e: unknown) => e);

    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { ...allUp, kms: 'down' },
    });
  });

  it('logs a KMS failure once, with the reason, and then its recovery', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    // Start from a healthy KMS, whatever earlier tests left behind.
    await controller.ready();
    warn.mockClear();
    log.mockClear();

    kmsAnswers(new Error('14 UNAVAILABLE: No connection established'));
    await controller.ready().catch(() => {});
    kmsAnswers(HealthCheckResponse_ServingStatus.NOT_SERVING);
    await controller.ready().catch(() => {});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Readiness check failed: 14 UNAVAILABLE: No connection established',
    );

    kmsAnswers(HealthCheckResponse_ServingStatus.SERVING);
    await controller.ready();
    await controller.ready();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Readiness check passing again');
    warn.mockRestore();
    log.mockRestore();
  });

  it('names the serving status when the KMS is not serving', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    kmsAnswers(HealthCheckResponse_ServingStatus.SERVING);
    await controller.ready();

    kmsAnswers(HealthCheckResponse_ServingStatus.NOT_SERVING);
    await controller.ready().catch(() => {});

    expect(warn).toHaveBeenCalledWith(
      'Readiness check failed: health check answered NOT_SERVING',
    );
    warn.mockRestore();
    kmsAnswers(HealthCheckResponse_ServingStatus.SERVING);
    await controller.ready();
  });

  it('gives the KMS health check a deadline', async () => {
    const before = Date.now();
    await controller.ready();

    const { deadline } = healthCheck.mock.calls[0][2] as { deadline: number };
    expect(deadline).toBeGreaterThanOrEqual(before + CHECK_TIMEOUT_MS);
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
