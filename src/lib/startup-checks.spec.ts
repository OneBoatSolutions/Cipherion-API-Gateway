import {
  checkDatabasesOnStartup,
  describeTarget,
  STARTUP_TIMEOUT_MS,
  type StartupDatabase,
} from './startup-checks.js';

// The real pools are never touched: the check gets fake databases.
vi.mock('./prisma.js', () => ({ pool: {} }));
vi.mock('./cipseq-prisma.js', () => ({ cipseqPool: {} }));

const database = (
  label: string,
  url: string,
  query: () => Promise<unknown>,
): StartupDatabase & { end: ReturnType<typeof vi.fn> } => {
  const end = vi.fn().mockResolvedValue(undefined);
  return { label, url, pool: { query: vi.fn(query), end } as never, end };
};

const authUrl = 'postgresql://postgres:s3cret@localhost:5432/cipherion_gateway';
const cipseqUrl =
  'postgresql://postgres:s3cret@localhost:5432/cipherion_cipseq';

describe('checkDatabasesOnStartup', () => {
  const logger = { error: vi.fn(), log: vi.fn() };
  const exit = vi.fn() as unknown as ((code: number) => never) &
    ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger.error.mockReset();
    logger.log.mockReset();
    exit.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues when both databases answer', async () => {
    const dbs = [
      database('auth', authUrl, () => Promise.resolve()),
      database('CipSeq', cipseqUrl, () => Promise.resolve()),
    ];

    await checkDatabasesOnStartup(dbs, exit, logger);

    expect(exit).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      'Connected to the auth and CipSeq databases',
    );
  });

  it('logs the failing database without its password and exits with code 1', async () => {
    const missing = Object.assign(
      new Error('database "cipherion_cipseq" does not exist'),
      { code: '3D000' },
    );
    const auth = database('auth', authUrl, () => Promise.resolve());
    const cipseq = database('CipSeq', cipseqUrl, () => Promise.reject(missing));

    await checkDatabasesOnStartup([auth, cipseq], exit, logger);

    expect(logger.error).toHaveBeenNthCalledWith(
      1,
      `Can't connect to the CipSeq database (localhost:5432/cipherion_cipseq): 3D000 database "cipherion_cipseq" does not exist`,
    );
    expect(logger.error).toHaveBeenLastCalledWith(
      'Exiting: a database is unreachable',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('s3cret');
    expect(auth.end).toHaveBeenCalled();
    expect(cipseq.end).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('counts a database that does not answer in time as unreachable', async () => {
    vi.useFakeTimers();
    const dbs = [
      database('auth', authUrl, () => new Promise(() => {})),
      database('CipSeq', cipseqUrl, () => Promise.resolve()),
    ];

    const done = checkDatabasesOnStartup(dbs, exit, logger);
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    await done;

    expect(logger.error).toHaveBeenCalledWith(
      `Can't connect to the auth database (localhost:5432/cipherion_gateway): timed out after ${STARTUP_TIMEOUT_MS} ms`,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('describeTarget', () => {
  it('keeps host, port and database name only', () => {
    expect(describeTarget(authUrl)).toBe('localhost:5432/cipherion_gateway');
  });

  it('does not echo an unparseable URL', () => {
    expect(describeTarget('not a url with p@ssword')).toBe('invalid URL');
  });
});
