import { Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import type {
  SystemEventKind,
  SystemService,
} from '../generated/prisma/enums.js';
import type { prisma } from './prisma.js';

// Infrastructure events go to the auth database's systemEvent table, never to
// CipSeq's auditEvent, which is the user audit trail.
//
// Events are queued in memory and written in the background, so recording one
// never waits on (or fails) anything else, and an outage of the auth database
// itself is written once it's back, with the time it happened.

export const MAX_QUEUED_SYSTEM_EVENTS = 1000;
export const SYSTEM_EVENT_RETRY_MS = 30_000;

export interface SystemEventInput {
  service: SystemService;
  kind: SystemEventKind;
  reason?: string;
  metadata?: Record<string, string | number | boolean>;
}

interface QueuedSystemEvent extends SystemEventInput {
  occurredAt: Date;
}

type SystemEventWriter = Pick<typeof prisma.systemEvent, 'createMany'>;

const logger = new Logger('SystemEvents');
const instance = `${hostname()}:${process.pid}`;

let queue: QueuedSystemEvent[] = [];
let flushing: Promise<void> | undefined;
let retryTimer: NodeJS.Timeout | undefined;
// Loaded on the first write: prisma.ts imports the database watch, which
// reports here, so a static import would be a cycle.
let writer: SystemEventWriter | undefined;

export function recordSystemEvent(event: SystemEventInput): void {
  queue.push({ ...event, occurredAt: new Date() });
  if (queue.length > MAX_QUEUED_SYSTEM_EVENTS) {
    const dropped = queue.length - MAX_QUEUED_SYSTEM_EVENTS;
    queue = queue.slice(dropped);
    logger.error(`${dropped} system events dropped: the queue is full`);
  }
  void flushSystemEvents();
}

// Writes everything queued. Only one write runs at a time; a failed one keeps
// the events and tries again later, without logging, because the outage that
// caused it is already reported as a lost connection.
export function flushSystemEvents(): Promise<void> {
  flushing ??= (async () => {
    try {
      while (queue.length > 0) {
        const batch = queue.slice(0, 100);
        writer ??= (await import('./prisma.js')).prisma.systemEvent;
        await writer.createMany({
          data: batch.map((event) => ({ ...event, instance })),
        });
        queue = queue.slice(batch.length);
      }
    } catch {
      scheduleRetry();
    } finally {
      flushing = undefined;
    }
  })();
  return flushing;
}

function scheduleRetry(): void {
  if (retryTimer) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void flushSystemEvents();
  }, SYSTEM_EVENT_RETRY_MS);
  retryTimer.unref(); // never keeps the process alive on its own
}

// For shutdown: one last write, bounded so a down database can't hold it up.
export async function closeSystemEvents(timeoutMs = 2000): Promise<void> {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    flushSystemEvents(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

// For tests.
export function resetSystemEvents(next?: SystemEventWriter): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  queue = [];
  flushing = undefined;
  writer = next;
}

export function queuedSystemEvents(): readonly QueuedSystemEvent[] {
  return queue;
}
