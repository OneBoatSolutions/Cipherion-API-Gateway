import type { SystemService } from '../generated/prisma/enums.js';
import {
  checkDependenciesOnStartup,
  describeTarget,
  EXIT_CODES,
  STARTUP_TIMEOUT_MS,
  type StartupCheck,
} from './startup-checks.js';

// The real clients are never touched: every test passes its own checks.
vi.mock('./prisma.js', () => ({ pool: {} }));
vi.mock('./cipseq-prisma.js', () => ({ cipseqPool: {} }));
vi.mock('./redis.js', () => ({ redis: {}, redisErrorReason: vi.fn() }));
vi.mock('./kms.js', () => ({ checkKmsServing: vi.fn(), closeKms: vi.fn() }));
vi.mock('./mailer.js', () => ({ mailer: { enabled: true } }));
vi.mock('./connection-events.js', () => ({ reportEstablished: vi.fn() }));

const LABELS: Record<SystemService, [string, string]> = {
  AUTH_DATABASE: ['the auth database', 'localhost:5432/cipherion_gateway'],
  CIPSEQ_DATABASE: ['the CipSeq database', 'localhost:5432/cipherion_cipseq'],
  REDIS: ['Redis', 'localhost:6380'],
  KMS: ['the KMS', 'localhost:50051'],
  SMTP: ['the SMTP server', 'localhost:1025'],
};

const ok = () => Promise.resolve();

// All five, with the probes given for some services and success elsewhere.
const checks = (
  probes: Partial<Record<SystemService, () => Promise<unknown>>> = {},
): StartupCheck[] =>
  (Object.keys(LABELS) as SystemService[]).map((service) => ({
    service,
    label: LABELS[service][0],
    target: LABELS[service][1],
    probe: probes[service] ?? ok,
  }));

const refused = Object.assign(new Error(''), { code: 'ECONNREFUSED' });

describe('checkDependenciesOnStartup', () => {
  const logger = { error: vi.fn(), log: vi.fn() };
  const exit = vi.fn() as unknown as ((code: number) => never) &
    ReturnType<typeof vi.fn>;
  const close = vi.fn();
  const established = vi.fn();

  const run = (list: StartupCheck[]) =>
    checkDependenciesOnStartup(list, exit, logger, close, established);

  beforeEach(() => {
    logger.error.mockReset();
    logger.log.mockReset();
    exit.mockReset();
    close.mockReset().mockResolvedValue(undefined);
    established.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues when every dependency answers, logging one line', async () => {
    await run(checks());

    expect(exit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      'Connected to the auth database, the CipSeq database, Redis, the KMS and the SMTP server',
    );
  });

  it('records a CONNECTION_ESTABLISHED event for each dependency', async () => {
    await run(checks());

    expect(established.mock.calls.map(([service]) => service)).toEqual([
      'AUTH_DATABASE',
      'CIPSEQ_DATABASE',
      'REDIS',
      'KMS',
      'SMTP',
    ]);
  });

  it.each(Object.entries(EXIT_CODES) as [SystemService, number][])(
    'exits with its own code when %s is unreachable',
    async (service, code) => {
      await run(checks({ [service]: () => Promise.reject(refused) }));

      expect(logger.error).toHaveBeenCalledWith(
        `Can't connect to ${LABELS[service][0]} (${LABELS[service][1]}): ECONNREFUSED`,
      );
      expect(logger.error).toHaveBeenLastCalledWith(
        `Exiting: can't reach ${LABELS[service][0]}`,
      );
      expect(close).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(code);
      expect(established).not.toHaveBeenCalled();
    },
  );

  it('logs every failure and exits with the first code in order', async () => {
    await run(
      checks({
        SMTP: () => Promise.reject(refused),
        REDIS: () => Promise.reject(refused),
      }),
    );

    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenLastCalledWith(
      "Exiting: can't reach Redis and the SMTP server",
    );
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.REDIS);
  });

  it('uses the check’s own reason when it has one', async () => {
    const list = checks({ KMS: () => Promise.reject(new Error('TLS: unknown ca')) });
    list[3] = { ...list[3], reason: (error) => (error as Error).message };

    await run(list);

    expect(logger.error).toHaveBeenCalledWith(
      "Can't connect to the KMS (localhost:50051): TLS: unknown ca",
    );
  });

  it('counts a dependency that does not answer in time as unreachable', async () => {
    vi.useFakeTimers();
    const done = run(checks({ KMS: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    await done;

    expect(logger.error).toHaveBeenCalledWith(
      `Can't connect to the KMS (localhost:50051): timed out after ${STARTUP_TIMEOUT_MS} ms`,
    );
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.KMS);
  });

  it('never logs a password from a database URL', async () => {
    const list = checks({ AUTH_DATABASE: () => Promise.reject(refused) });
    list[0] = {
      ...list[0],
      target: describeTarget(
        'postgresql://postgres:s3cret@localhost:5432/cipherion_gateway',
      ),
    };

    await run(list);

    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('s3cret');
  });
});

describe('describeTarget', () => {
  it('keeps host, port and path only', () => {
    expect(
      describeTarget('postgresql://postgres:s3cret@localhost:5432/cipherion_gateway'),
    ).toBe('localhost:5432/cipherion_gateway');
    expect(describeTarget('rediss://:s3cret@localhost:6380')).toBe(
      'localhost:6380',
    );
  });

  it('does not echo an unparseable URL', () => {
    expect(describeTarget('not a url with p@ssword')).toBe('invalid URL');
  });
});
