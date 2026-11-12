import {
  closeSystemEvents,
  flushSystemEvents,
  MAX_QUEUED_SYSTEM_EVENTS,
  queuedSystemEvents,
  recordSystemEvent,
  resetSystemEvents,
  SYSTEM_EVENT_RETRY_MS,
} from './system-events.js';

vi.mock('./prisma.js', () => ({ prisma: {} }));

describe('system events', () => {
  const createMany = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    createMany.mockReset().mockResolvedValue({ count: 1 });
    resetSystemEvents({ createMany } as never);
  });

  afterEach(() => {
    resetSystemEvents({ createMany } as never);
    vi.useRealTimers();
  });

  it('writes an event with the time it happened and this instance', async () => {
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
    recordSystemEvent({ service: 'REDIS', kind: 'CONNECTION_LOST', reason: 'ECONNREFUSED' });
    await flushSystemEvents();

    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          service: 'REDIS',
          kind: 'CONNECTION_LOST',
          reason: 'ECONNREFUSED',
          occurredAt: new Date('2026-11-12T10:00:00Z'),
          instance: expect.stringMatching(/:\d+$/) as string,
        },
      ],
    });
    expect(queuedSystemEvents()).toHaveLength(0);
  });

  it('keeps events while the database is down and writes them, with their original time, later', async () => {
    createMany.mockRejectedValue(new Error('ECONNREFUSED'));
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
    recordSystemEvent({ service: 'AUTH_DATABASE', kind: 'CONNECTION_LOST', reason: 'ECONNREFUSED' });
    await flushSystemEvents();
    expect(queuedSystemEvents()).toHaveLength(1);

    createMany.mockResolvedValue({ count: 1 });
    vi.setSystemTime(new Date('2026-11-12T10:05:00Z'));
    await vi.advanceTimersByTimeAsync(SYSTEM_EVENT_RETRY_MS);

    expect(queuedSystemEvents()).toHaveLength(0);
    expect(createMany).toHaveBeenLastCalledWith({
      data: [
        expect.objectContaining({
          kind: 'CONNECTION_LOST',
          occurredAt: new Date('2026-11-12T10:00:00Z'),
        }) as object,
      ],
    });
  });

  it('drops the oldest events beyond the cap', async () => {
    createMany.mockRejectedValue(new Error('down'));
    for (let i = 0; i < MAX_QUEUED_SYSTEM_EVENTS + 5; i += 1) {
      recordSystemEvent({ service: 'KMS', kind: 'CONNECTION_LOST', reason: String(i) });
    }
    await flushSystemEvents();

    const queued = queuedSystemEvents();
    expect(queued).toHaveLength(MAX_QUEUED_SYSTEM_EVENTS);
    expect(queued[0].reason).toBe('5');
  });

  it('gives up waiting at shutdown when the database does not answer', async () => {
    createMany.mockReturnValue(new Promise(() => {}));
    recordSystemEvent({ service: 'SMTP', kind: 'CONNECTION_LOST', reason: 'ETIMEDOUT' });

    const closed = closeSystemEvents(2000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(closed).resolves.toBeUndefined();
  });
});
