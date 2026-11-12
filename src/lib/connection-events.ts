import { Logger } from '@nestjs/common';
import type { SystemService } from '../generated/prisma/enums.js';
import { recordSystemEvent } from './system-events.js';

// The one place that decides when a dependency is down or back. Watchers report
// every failure and every success; only a change is logged (one ERROR line when
// it's lost, one line when it's restored) and recorded as a systemEvent.
//
// Off until startConnectionEvents(), so failures during startup are reported
// only by the startup check, and off again at shutdown, so closing the
// connections isn't reported as an outage.

// The same logger contexts as before, so log searches keep working.
const LOGGER_CONTEXT: Record<SystemService, string> = {
  AUTH_DATABASE: 'Database',
  CIPSEQ_DATABASE: 'CipSeqDatabase',
  REDIS: 'Redis',
  KMS: 'KMS',
  SMTP: 'Mailer',
};

type ServiceLogger = Pick<Logger, 'error' | 'log'>;

let enabled = false;
const down = new Set<SystemService>();
let loggerFor = (service: SystemService): ServiceLogger =>
  new Logger(LOGGER_CONTEXT[service]);

export function startConnectionEvents(): void {
  enabled = true;
}

export function stopConnectionEvents(): void {
  enabled = false;
}

export function isDown(service: SystemService): boolean {
  return down.has(service);
}

export function reportLost(service: SystemService, reason: string): void {
  if (!enabled || down.has(service)) {
    return;
  }
  down.add(service);
  loggerFor(service).error(`Connection lost, reconnecting: ${reason}`);
  recordSystemEvent({ service, kind: 'CONNECTION_LOST', reason });
}

// `note` adds to the log line, e.g. "3 emails not sent during the outage".
export function reportRestored(
  service: SystemService,
  details?: { note: string; metadata: Record<string, number> },
): void {
  if (!enabled || !down.has(service)) {
    return;
  }
  down.delete(service);
  loggerFor(service).log(
    details ? `Connection restored (${details.note})` : 'Connection restored',
  );
  recordSystemEvent({
    service,
    kind: 'CONNECTION_RESTORED',
    metadata: details?.metadata,
  });
}

// Only from the startup check, which logs one summary line for all services.
export function reportEstablished(service: SystemService): void {
  recordSystemEvent({ service, kind: 'CONNECTION_ESTABLISHED' });
}

// For tests.
export function resetConnectionEvents(
  logger?: (service: SystemService) => ServiceLogger,
): void {
  enabled = false;
  down.clear();
  loggerFor = logger ?? ((service) => new Logger(LOGGER_CONTEXT[service]));
}
