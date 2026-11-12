import { EventEmitter } from 'node:events';
import {
  resetConnectionEvents,
  startConnectionEvents,
} from './connection-events.js';
import {
  connectionErrorReason,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  stopDatabaseWatches,
  watchDatabase,
} from './database-watch.js';

// A pool that can emit `error` and whose SELECT 1 the test controls.
function fakePool() {
  const emitter = new EventEmitter();
  const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
  const pool = {
    query,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return pool;
    },
  };
  return { pool: pool as never, query, emit: emitter.emit.bind(emitter) };
}

const refused = Object.assign(new Error(''), { code: 'ECONNREFUSED' });

// Events are recorded through system-events.ts, which would write to the
// database; the log lines are what these tests check.
vi.mock('./system-events.js', () => ({ recordSystemEvent: vi.fn() }));

describe('watchDatabase', () => {
  const logger = { error: vi.fn(), log: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    logger.error.mockReset();
    logger.log.mockReset();
    // The watch reports through connection-events.ts, which logs once each way.
    resetConnectionEvents(() => logger);
    startConnectionEvents();
  });

  afterEach(() => {
    stopDatabaseWatches();
    vi.useRealTimers();
  });

  const tick = () => vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

  it('checks the database regularly and stays quiet while it is up', async () => {
    const { pool, query } = fakePool();
    watchDatabase(pool, 'AUTH_DATABASE');

    await tick();
    await tick();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs an outage once with its reason and the recovery once', async () => {
    const { pool, query } = fakePool();
    watchDatabase(pool, 'AUTH_DATABASE');

    query.mockRejectedValue(refused);
    await tick();
    await tick();
    await tick();
    query.mockResolvedValue({ rows: [] });
    await tick();
    await tick();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Connection lost, reconnecting: ECONNREFUSED',
    );
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith('Connection restored');
  });

  it('handles the pool error event instead of crashing, and logs it once', async () => {
    const { pool, emit, query } = fakePool();
    watchDatabase(pool, 'AUTH_DATABASE');
    const restart = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' },
    );

    expect(() => emit('error', restart)).not.toThrow();
    query.mockRejectedValue(refused);
    await tick();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Connection lost, reconnecting: 57P01 terminating connection due to administrator command',
    );
  });

  it('counts a heartbeat that does not answer in time as an outage', async () => {
    const { pool, query } = fakePool();
    watchDatabase(pool, 'AUTH_DATABASE');

    query.mockReturnValue(new Promise(() => {}));
    await tick();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);

    expect(logger.error).toHaveBeenCalledWith(
      'Connection lost, reconnecting: timed out after 2000 ms',
    );
  });

  it('stops checking and logging once stopped', async () => {
    const { pool, query } = fakePool();
    watchDatabase(pool, 'AUTH_DATABASE');

    stopDatabaseWatches();
    query.mockRejectedValue(refused);
    await tick();

    expect(query).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not report a heartbeat that fails because the pool is closing', async () => {
    const { pool, query } = fakePool();
    watchDatabase(pool, 'AUTH_DATABASE');

    let fail: (error: Error) => void = () => {};
    query.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    await tick();
    stopDatabaseWatches();
    fail(new Error('Cannot use a pool after calling end on the pool'));
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('connectionErrorReason', () => {
  it.each([
    [Object.assign(new Error(''), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    [
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      'ECONNRESET',
    ],
    [
      Object.assign(
        new Error('password authentication failed for user "postgres"'),
        { code: '28P01' },
      ),
      '28P01 password authentication failed for user "postgres"',
    ],
    [
      Object.assign(new Error('database "cipherion_cipseq" does not exist'), {
        code: '3D000',
      }),
      '3D000 database "cipherion_cipseq" does not exist',
    ],
    [
      new Error('timeout exceeded when trying to connect'),
      'timeout exceeded when trying to connect',
    ],
    [undefined, 'unknown error'],
  ])('shortens %o', (error, reason) => {
    expect(connectionErrorReason(error)).toBe(reason);
  });
});
