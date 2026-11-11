import { Prisma } from '../generated/cipseq/client.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';

// Encryptions and decryptions are counted from envelopeDelivery: the engine
// fetches an envelope for every operation, and the gateway writes one row per
// successful delivery. All times are UTC.

export const USAGE_PERIODS = ['today', 'week', 'month', 'year'] as const;
export const LEADERBOARD_PERIODS = [...USAGE_PERIODS, 'all'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

export interface Counts {
  encryptions: number;
  decryptions: number;
  total: number;
}

export interface Bucket extends Counts {
  start: Date;
  end: Date;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const utcMidnight = (date: Date) =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
const monthStart = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 1));

// The SQL truncation unit that each period's buckets are built from: today's
// 6-hour buckets are filled from hourly rows.
export const TRUNCATE_UNIT: Record<
  LeaderboardPeriod,
  'hour' | 'day' | 'month'
> = {
  today: 'hour',
  week: 'day',
  month: 'day',
  year: 'month',
  all: 'month',
};

function monthlyBuckets(first: Date, now: Date): { start: Date; end: Date }[] {
  const buckets = [];
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  const lastYear = now.getUTCFullYear();
  const lastMonth = now.getUTCMonth();
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    buckets.push({
      start: monthStart(year, month),
      end: monthStart(year, month + 1),
    });
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return buckets;
}

function dailyBuckets(days: number, now: Date) {
  const tomorrow = utcMidnight(now).getTime() + DAY;
  return Array.from({ length: days }, (_, index) => ({
    start: new Date(tomorrow - (days - index) * DAY),
    end: new Date(tomorrow - (days - index - 1) * DAY),
  }));
}

// The empty buckets for a period, oldest first. `firstDelivery` is only used by
// 'all', which starts at the month of the first delivery (or this month).
export function buckets(
  period: LeaderboardPeriod,
  now: Date,
  firstDelivery?: Date | null,
): { start: Date; end: Date }[] {
  switch (period) {
    case 'today': {
      const midnight = utcMidnight(now).getTime();
      return Array.from({ length: 4 }, (_, index) => ({
        start: new Date(midnight + index * 6 * HOUR),
        end: new Date(midnight + (index + 1) * 6 * HOUR),
      }));
    }
    case 'week':
      return dailyBuckets(7, now);
    case 'month':
      return dailyBuckets(30, now);
    case 'year':
      return monthlyBuckets(
        monthStart(now.getUTCFullYear(), now.getUTCMonth() - 11),
        now,
      );
    case 'all':
      return monthlyBuckets(firstDelivery ?? now, now);
  }
}

export interface CountRow {
  // UTC, as text, so the driver can't shift it into the server's time zone.
  bucket: string;
  encryptions: number;
  decryptions: number;
}

// Places each truncated row in the bucket that contains it; buckets without rows
// stay at zero.
export function fillBuckets(
  empty: { start: Date; end: Date }[],
  rows: CountRow[],
): Bucket[] {
  const filled = empty.map((bucket) => ({
    ...bucket,
    encryptions: 0,
    decryptions: 0,
    total: 0,
  }));
  for (const row of rows) {
    const at = new Date(row.bucket).getTime();
    const bucket = filled.find(
      ({ start, end }) => start.getTime() <= at && at < end.getTime(),
    );
    if (bucket) {
      bucket.encryptions += Number(row.encryptions);
      bucket.decryptions += Number(row.decryptions);
      bucket.total = bucket.encryptions + bucket.decryptions;
    }
  }
  return filled;
}

export function sumBuckets(series: Counts[]): Counts {
  const encryptions = series.reduce((sum, b) => sum + b.encryptions, 0);
  const decryptions = series.reduce((sum, b) => sum + b.decryptions, 0);
  return { encryptions, decryptions, total: encryptions + decryptions };
}

// Which deliveries a query covers. Every field present is ANDed.
export interface DeliveryFilter {
  projectIds?: string[];
  groupId?: string;
  userId?: string;
  deviceId?: string;
}

function whereOf(filter: DeliveryFilter, from?: Date, to?: Date): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filter.projectIds) {
    conditions.push(
      Prisma.sql`"projectId" = ANY(${filter.projectIds}::uuid[])`,
    );
  }
  if (filter.groupId) {
    conditions.push(Prisma.sql`"groupId" = ${filter.groupId}::uuid`);
  }
  if (filter.userId) {
    conditions.push(Prisma.sql`"userId" = ${filter.userId}`);
  }
  if (filter.deviceId) {
    conditions.push(Prisma.sql`"deviceId" = ${filter.deviceId}`);
  }
  // The column holds UTC without a time zone, so the bounds are converted the
  // same way rather than through the session's time zone.
  if (from) {
    conditions.push(
      Prisma.sql`"createdAt" >= (${from.toISOString()}::timestamptz AT TIME ZONE 'UTC')`,
    );
  }
  if (to) {
    conditions.push(
      Prisma.sql`"createdAt" < (${to.toISOString()}::timestamptz AT TIME ZONE 'UTC')`,
    );
  }
  return conditions.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;
}

const COUNTS = Prisma.sql`
  count(*) FILTER (WHERE "operation" = 'ENCRYPT')::int AS "encryptions",
  count(*) FILTER (WHERE "operation" = 'DECRYPT')::int AS "decryptions"`;

export async function firstDeliveryAt(
  filter: DeliveryFilter,
): Promise<Date | null> {
  const [row] = await cipseqPrisma.$queryRaw<{ first: string | null }[]>`
    SELECT to_char(min("createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "first"
    FROM "envelopeDelivery" ${whereOf(filter)}`;
  return row?.first ? new Date(row.first) : null;
}

export async function series(
  filter: DeliveryFilter,
  period: LeaderboardPeriod,
  now: Date,
): Promise<Bucket[]> {
  const empty = buckets(
    period,
    now,
    period === 'all' ? await firstDeliveryAt(filter) : undefined,
  );
  const from = empty[0].start;
  const to = empty[empty.length - 1].end;
  const unit = TRUNCATE_UNIT[period];
  const rows = await cipseqPrisma.$queryRaw<CountRow[]>`
    SELECT to_char(date_trunc(${unit}, "createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "bucket",
      ${COUNTS}
    FROM "envelopeDelivery" ${whereOf(filter, from, to)}
    GROUP BY 1`;
  return fillBuckets(empty, rows);
}

// Column names can't be parameters, so only these three are allowed.
const RANKED_COLUMNS = {
  projectId: Prisma.raw('"projectId"'),
  userId: Prisma.raw('"userId"'),
  deviceId: Prisma.raw('"deviceId"'),
} as const;

export interface RankedRow {
  id: string;
  encryptions: number;
  decryptions: number;
}

export const LEADERBOARD_SIZE = 10;

// Top entries by total, then encryptions, then id, so ties always sort the same.
export function topBy(
  column: keyof typeof RANKED_COLUMNS,
  filter: DeliveryFilter,
  from: Date,
  to: Date,
): Promise<RankedRow[]> {
  const key = RANKED_COLUMNS[column];
  return cipseqPrisma.$queryRaw<RankedRow[]>`
    SELECT ${key}::text AS "id", ${COUNTS}
    FROM "envelopeDelivery" ${whereOf(filter, from, to)}
    GROUP BY ${key}
    ORDER BY count(*) DESC,
      count(*) FILTER (WHERE "operation" = 'ENCRYPT') DESC,
      ${key} ASC
    LIMIT ${LEADERBOARD_SIZE}`;
}

export const countsOf = (row: {
  encryptions: number;
  decryptions: number;
}): Counts => {
  const encryptions = Number(row.encryptions);
  const decryptions = Number(row.decryptions);
  return { encryptions, decryptions, total: encryptions + decryptions };
};
