import { Logger } from '@nestjs/common';
import { USAGE_PERIODS, type UsagePeriod } from '../cipseq/metrics.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import {
  MASTER_METRICS,
  type MasterCounts,
  type MasterMetric,
  type MasterPeriod,
  masterMetrics,
} from './master-metrics.js';

// GET /master/metrics serves a stored snapshot, because computing it counts a
// year of rows in both databases. The snapshot is refreshed at 00:00, 06:00,
// 12:00 and 18:00 UTC: the edges of today's 6-hour buckets, so every bucket
// before the current one is complete and `today` moves to the new day at
// midnight. Data is therefore at most 6 hours old, and `generatedAt` says when.

export interface MasterMetricsSnapshot {
  generatedAt: Date;
  periods: Record<UsagePeriod, MasterPeriod>;
}

const SNAPSHOT_ID = 'master';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
// A few seconds past the boundary, so rows written on the stroke are counted.
const AFTER_BOUNDARY_MS = 5_000;
const RETRY_MS = 5 * 60 * 1000;

const logger = new Logger('MasterMetrics');

// The Unix epoch is a UTC midnight and 6 hours divide a day, so these fall on
// 00:00, 06:00, 12:00 and 18:00 UTC.
export const lastBoundary = (now: Date) =>
  new Date(Math.floor(now.getTime() / SIX_HOURS_MS) * SIX_HOURS_MS);
export const nextBoundary = (now: Date) =>
  new Date(lastBoundary(now).getTime() + SIX_HOURS_MS);

// Stored as JSON, so the dates come back as ISO strings.
type StoredPeriod = Omit<MasterPeriod, 'start' | 'end' | 'series'> & {
  start: string;
  end: string;
  series: (Omit<MasterPeriod['series'][number], 'start' | 'end'> & {
    start: string;
    end: string;
  })[];
};

const countsOf = (stored: Record<MasterMetric, number>): MasterCounts =>
  Object.fromEntries(
    MASTER_METRICS.map((metric) => [metric, stored[metric] ?? 0]),
  ) as MasterCounts;

// jsonb doesn't keep key order, so every object is rebuilt in the order the
// live response used: today, week, month, year; start, end, then the metrics.
export function revivePeriods(
  stored: Record<UsagePeriod, StoredPeriod>,
): Record<UsagePeriod, MasterPeriod> {
  return Object.fromEntries(
    USAGE_PERIODS.map((period) => {
      const value = stored[period];
      return [
        period,
        {
          start: new Date(value.start),
          end: new Date(value.end),
          totals: countsOf(value.totals),
          series: value.series.map((bucket) => ({
            start: new Date(bucket.start),
            end: new Date(bucket.end),
            ...countsOf(bucket),
          })),
        },
      ];
    }),
  ) as Record<UsagePeriod, MasterPeriod>;
}

// Callers that arrive while a refresh runs share it instead of starting another.
let inFlight: Promise<MasterMetricsSnapshot> | null = null;

export function refreshMasterMetrics(
  now = new Date(),
): Promise<MasterMetricsSnapshot> {
  inFlight ??= (async () => {
    const periods = await masterMetrics(now);
    // Through JSON, so Dates are stored as ISO strings.
    const stored = JSON.parse(JSON.stringify(periods)) as object;
    await cipseqPrisma.masterMetricsSnapshot.upsert({
      where: { id: SNAPSHOT_ID },
      create: { id: SNAPSHOT_ID, generatedAt: now, periods: stored },
      update: { generatedAt: now, periods: stored },
    });
    return { generatedAt: now, periods };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// The stored snapshot, or a fresh one if there's none yet (the first start,
// before the startup refresh finishes).
export async function readMasterMetrics(): Promise<MasterMetricsSnapshot> {
  const row = await cipseqPrisma.masterMetricsSnapshot.findUnique({
    where: { id: SNAPSHOT_ID },
  });
  if (!row) {
    return refreshMasterMetrics();
  }
  return {
    generatedAt: row.generatedAt,
    periods: revivePeriods(
      row.periods as unknown as Record<UsagePeriod, StoredPeriod>,
    ),
  };
}

const untilNextRefresh = (now = new Date()) =>
  nextBoundary(now).getTime() - now.getTime() + AFTER_BOUNDARY_MS;

function arm(delayMs: number): void {
  setTimeout(() => void run(false), delayMs).unref(); // never keeps the process alive
}

async function run(onlyIfStale: boolean): Promise<void> {
  try {
    if (onlyIfStale) {
      const row = await cipseqPrisma.masterMetricsSnapshot.findUnique({
        where: { id: SNAPSHOT_ID },
        select: { generatedAt: true },
      });
      if (!row || row.generatedAt < lastBoundary(new Date())) {
        await refreshMasterMetrics();
      }
    } else {
      await refreshMasterMetrics();
    }
    arm(untilNextRefresh());
  } catch (error) {
    // The old snapshot stays. Only the error's name and code reach the log.
    const code = (error as { code?: unknown } | null)?.code;
    logger.warn(
      `Refreshing the master metrics failed: ${error instanceof Error ? error.name : 'unknown error'}${typeof code === 'string' ? ` (${code})` : ''}. Retrying in 5 minutes`,
    );
    arm(Math.min(RETRY_MS, untilNextRefresh()));
  }
}

// Called once from main.ts: refreshes now if the snapshot is missing or from
// before the last boundary (so a deploy never serves an old one), then at
// every boundary.
export function scheduleMasterMetricsRefresh(): void {
  void run(true);
}
