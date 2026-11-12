import {
  isDown,
  reportEstablished,
  reportLost,
  reportRestored,
  resetConnectionEvents,
  startConnectionEvents,
  stopConnectionEvents,
} from './connection-events.js';
import { recordSystemEvent } from './system-events.js';

vi.mock('./system-events.js', () => ({ recordSystemEvent: vi.fn() }));

const recorded = vi.mocked(recordSystemEvent);

describe('connection events', () => {
  type FakeLogger = {
    error: ReturnType<typeof vi.fn<(message: string) => void>>;
    log: ReturnType<typeof vi.fn<(message: string) => void>>;
  };
  const loggers = new Map<string, FakeLogger>();
  const loggerFor = (service: string): FakeLogger => {
    if (!loggers.has(service)) {
      loggers.set(service, { error: vi.fn(), log: vi.fn() });
    }
    return loggers.get(service)!;
  };

  beforeEach(() => {
    loggers.clear();
    recorded.mockReset();
    resetConnectionEvents(loggerFor);
    startConnectionEvents();
  });

  it('logs and records an outage once, however often it is reported', () => {
    reportLost('REDIS', 'ECONNREFUSED');
    reportLost('REDIS', 'ECONNREFUSED');
    reportLost('REDIS', 'ETIMEDOUT');

    expect(loggerFor('REDIS').error).toHaveBeenCalledTimes(1);
    expect(loggerFor('REDIS').error).toHaveBeenCalledWith(
      'Connection lost, reconnecting: ECONNREFUSED',
    );
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledWith({
      service: 'REDIS',
      kind: 'CONNECTION_LOST',
      reason: 'ECONNREFUSED',
    });
    expect(isDown('REDIS')).toBe(true);
  });

  it('logs and records the recovery once, and ignores successes while up', () => {
    reportRestored('KMS');
    reportLost('KMS', 'TLS: unknown ca');
    reportRestored('KMS');
    reportRestored('KMS');

    expect(loggerFor('KMS').log).toHaveBeenCalledTimes(1);
    expect(loggerFor('KMS').log).toHaveBeenCalledWith('Connection restored');
    expect(recorded.mock.calls.map(([event]) => event.kind)).toEqual([
      'CONNECTION_LOST',
      'CONNECTION_RESTORED',
    ]);
    expect(isDown('KMS')).toBe(false);
  });

  it('tracks each service on its own', () => {
    reportLost('AUTH_DATABASE', 'ECONNREFUSED');
    reportLost('CIPSEQ_DATABASE', 'ECONNREFUSED');

    expect(loggerFor('AUTH_DATABASE').error).toHaveBeenCalledTimes(1);
    expect(loggerFor('CIPSEQ_DATABASE').error).toHaveBeenCalledTimes(1);
  });

  it('adds a note to the restored line and its metadata to the event', () => {
    reportLost('SMTP', 'ECONNECTION');
    reportRestored('SMTP', {
      note: '3 emails not sent during the outage',
      metadata: { emailsNotSent: 3 },
    });

    expect(loggerFor('SMTP').log).toHaveBeenCalledWith(
      'Connection restored (3 emails not sent during the outage)',
    );
    expect(recorded).toHaveBeenLastCalledWith({
      service: 'SMTP',
      kind: 'CONNECTION_RESTORED',
      metadata: { emailsNotSent: 3 },
    });
  });

  it('reports nothing before startup or after shutdown', () => {
    resetConnectionEvents(loggerFor);
    reportLost('REDIS', 'ECONNREFUSED');
    startConnectionEvents();
    stopConnectionEvents();
    reportLost('REDIS', 'ECONNREFUSED');

    expect(loggerFor('REDIS').error).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
  });

  it('records an established connection without a log line', () => {
    reportEstablished('SMTP');

    expect(recorded).toHaveBeenCalledWith({
      service: 'SMTP',
      kind: 'CONNECTION_ESTABLISHED',
    });
    expect(loggerFor('SMTP').log).not.toHaveBeenCalled();
  });
});
