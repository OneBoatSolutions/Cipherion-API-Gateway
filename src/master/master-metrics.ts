import { Prisma } from '../generated/cipseq/client.js';
import { buckets, USAGE_PERIODS, type UsagePeriod } from '../cipseq/metrics.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { prisma } from '../lib/prisma.js';

// Platform-wide counts for the master account, in UTC buckets:
//   today  4 buckets of 6 hours, from midnight
//   week   7 days, ending today
//   month  4 weeks of 7 days (the last 28 days), ending today
//   year   12 calendar months, ending this month
// Every bucket is present, empty ones as 0, and the current one is partial.

export const MASTER_METRICS = [
  'encryptions',
  'decryptions',
  'accountsCreated',
  'accountsDeleted',
  'projectsCreated',
  'projectsDeleted',
  'groupsCreated',
  'groupsDeleted',
  'devicesRegistered',
  'membersRevoked',
  'devicesRevoked',
] as const;
export type MasterMetric = (typeof MASTER_METRICS)[number];

export type MasterCounts = Record<MasterMetric, number>;
export interface MasterBucket extends MasterCounts {
  start: Date;
  end: Date;
}
export interface MasterPeriod {
  start: Date;
  end: Date;
  totals: MasterCounts;
  series: MasterBucket[];
}

type Range = { start: Date; end: Date };
export type PeriodBuckets = Record<UsagePeriod, Range[]>;

// One row per hour today and per day before that: fine enough for every
// period's buckets, which all start on an hour (today) or a midnight.
export interface CountRow {
  bucket: string;
  count: number;
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKS_IN_MONTH = 4;

export function masterBuckets(now: Date): PeriodBuckets {
  const week = buckets('week', now);
  // Tomorrow's midnight, so the last week includes today.
  const end = week[week.length - 1].end.getTime();
  const month = Array.from({ length: WEEKS_IN_MONTH }, (_, index) => ({
    start: new Date(end - (WEEKS_IN_MONTH - index) * 7 * DAY),
    end: new Date(end - (WEEKS_IN_MONTH - index - 1) * 7 * DAY),
  }));
  return {
    today: buckets('today', now),
    week,
    month,
    year: buckets('year', now),
  };
}

const firstStart = (periods: PeriodBuckets) =>
  new Date(
    Math.min(...USAGE_PERIODS.map((p) => periods[p][0].start.getTime())),
  );

// Table and column names come only from the calls below, never from a request.
function bucketSql(column: string, todayStart: Date) {
  const ref = Prisma.raw(`"${column}"`);
  return Prisma.sql`to_char(CASE WHEN ${ref} >= ${todayStart}
      THEN date_trunc('hour', ${ref}) ELSE date_trunc('day', ${ref}) END,
      'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
}

function cipseqRows(
  table: string,
  column: string,
  periods: PeriodBuckets,
  condition: Prisma.Sql = Prisma.empty,
): Promise<CountRow[]> {
  return cipseqPrisma.$queryRaw<CountRow[]>`
    SELECT ${bucketSql(column, periods.today[0].start)} AS "bucket",
      count(*)::int AS "count"
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE ${Prisma.raw(`"${column}"`)} >= ${firstStart(periods)} ${condition}
    GROUP BY 1`;
}

const actionIn = (actions: string[]) =>
  Prisma.sql`AND "action" IN (${Prisma.join(actions)})`;

// The auth database has its own client, so the same query is written out.
function accountRows(periods: PeriodBuckets): Promise<CountRow[]> {
  const todayStart = periods.today[0].start;
  return prisma.$queryRaw<CountRow[]>`
    SELECT to_char(CASE WHEN "createdAt" >= ${todayStart}
        THEN date_trunc('hour', "createdAt") ELSE date_trunc('day', "createdAt") END,
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "bucket",
      count(*)::int AS "count"
    FROM "user"
    WHERE "createdAt" >= ${firstStart(periods)}
    GROUP BY 1`;
}

export async function masterMetrics(
  now = new Date(),
): Promise<Record<UsagePeriod, MasterPeriod>> {
  const periods = masterBuckets(now);
  const queries: Record<MasterMetric, Promise<CountRow[]>> = {
    encryptions: cipseqRows(
      'envelopeDelivery',
      'createdAt',
      periods,
      Prisma.sql`AND "operation" = 'ENCRYPT'`,
    ),
    decryptions: cipseqRows(
      'envelopeDelivery',
      'createdAt',
      periods,
      Prisma.sql`AND "operation" = 'DECRYPT'`,
    ),
    accountsCreated: accountRows(periods),
    // Deleting an account isn't possible yet, so this stays 0 until the
    // delete-account work writes account.deleted.
    accountsDeleted: cipseqRows(
      'auditEvent',
      'createdAt',
      periods,
      actionIn(['account.deleted']),
    ),
    // Created counts include rows deleted since; deletions are soft.
    projectsCreated: cipseqRows('project', 'createdAt', periods),
    projectsDeleted: cipseqRows('project', 'deletedAt', periods),
    groupsCreated: cipseqRows('group', 'createdAt', periods),
    groupsDeleted: cipseqRows('group', 'deletedAt', periods),
    devicesRegistered: cipseqRows('device', 'createdAt', periods),
    membersRevoked: cipseqRows(
      'auditEvent',
      'createdAt',
      periods,
      actionIn(['group.member_revoked', 'project.member_revoked']),
    ),
    // From a group, from a project, and by the device's own user everywhere.
    devicesRevoked: cipseqRows(
      'auditEvent',
      'createdAt',
      periods,
      actionIn(['device.revoked']),
    ),
  };
  const rows = Object.fromEntries(
    await Promise.all(
      MASTER_METRICS.map(
        async (metric) => [metric, await queries[metric]] as const,
      ),
    ),
  ) as Record<MasterMetric, CountRow[]>;
  return fillPeriods(periods, rows);
}

const zeros = (): MasterCounts =>
  Object.fromEntries(MASTER_METRICS.map((m) => [m, 0])) as MasterCounts;

// Places each row in the bucket that contains it, for every period. Totals
// are the sum of the series.
export function fillPeriods(
  periods: PeriodBuckets,
  rows: Record<MasterMetric, CountRow[]>,
): Record<UsagePeriod, MasterPeriod> {
  return Object.fromEntries(
    USAGE_PERIODS.map((period) => {
      const ranges = periods[period];
      const series: MasterBucket[] = ranges.map((range) => ({
        ...range,
        ...zeros(),
      }));
      const totals = zeros();
      for (const metric of MASTER_METRICS) {
        for (const row of rows[metric] ?? []) {
          const at = new Date(row.bucket).getTime();
          const bucket = series.find(
            ({ start, end }) => start.getTime() <= at && at < end.getTime(),
          );
          if (bucket) {
            bucket[metric] += Number(row.count);
            totals[metric] += Number(row.count);
          }
        }
      }
      return [
        period,
        {
          start: ranges[0].start,
          end: ranges[ranges.length - 1].end,
          totals,
          series,
        },
      ];
    }),
  ) as Record<UsagePeriod, MasterPeriod>;
}
