import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import {
  type CountRow,
  fillPeriods,
  MASTER_METRICS,
  type MasterMetric,
  masterBuckets,
} from './master-metrics.js';
import { MasterGuard } from './master.guard.js';

vi.mock('../lib/cipseq-prisma.js', () => ({ cipseqPrisma: {} }));
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));

const at = (iso: string) => new Date(iso);
const span = (period: { start: Date; end: Date }[]) =>
  period.map(({ start, end }) => [start.toISOString(), end.toISOString()]);

describe('master metrics', () => {
  const now = at('2026-11-12T10:15:00.000Z');

  it('splits today into 6 hours, a week into days, a month into weeks and a year into months', () => {
    const periods = masterBuckets(now);

    expect(span(periods.today)).toEqual([
      ['2026-11-12T00:00:00.000Z', '2026-11-12T06:00:00.000Z'],
      ['2026-11-12T06:00:00.000Z', '2026-11-12T12:00:00.000Z'],
      ['2026-11-12T12:00:00.000Z', '2026-11-12T18:00:00.000Z'],
      ['2026-11-12T18:00:00.000Z', '2026-11-13T00:00:00.000Z'],
    ]);
    expect(periods.week).toHaveLength(7);
    expect(periods.week[0].start).toEqual(at('2026-11-06T00:00:00.000Z'));
    expect(periods.week[6].end).toEqual(at('2026-11-13T00:00:00.000Z'));
    expect(span(periods.month)).toEqual([
      ['2026-10-16T00:00:00.000Z', '2026-10-23T00:00:00.000Z'],
      ['2026-10-23T00:00:00.000Z', '2026-10-30T00:00:00.000Z'],
      ['2026-10-30T00:00:00.000Z', '2026-11-06T00:00:00.000Z'],
      ['2026-11-06T00:00:00.000Z', '2026-11-13T00:00:00.000Z'],
    ]);
    expect(periods.year).toHaveLength(12);
    expect(periods.year[0].start).toEqual(at('2025-12-01T00:00:00.000Z'));
    expect(periods.year[11]).toEqual({
      start: at('2026-11-01T00:00:00.000Z'),
      end: at('2026-12-01T00:00:00.000Z'),
    });
  });

  it('places hourly and daily rows in every period that contains them', () => {
    const rows = Object.fromEntries(
      MASTER_METRICS.map((metric) => [metric, [] as CountRow[]]),
    ) as Record<MasterMetric, CountRow[]>;
    rows.encryptions = [
      { bucket: '2026-11-12T07:00:00Z', count: 3 }, // today, 06–12
      { bucket: '2026-11-12T01:00:00Z', count: 1 }, // today, 00–06
      { bucket: '2026-11-10T00:00:00Z', count: 5 }, // this week
      { bucket: '2026-10-20T00:00:00Z', count: 7 }, // month, first week
      { bucket: '2026-01-15T00:00:00Z', count: 11 }, // year only
    ];
    rows.devicesRevoked = [{ bucket: '2026-11-12T07:00:00Z', count: 2 }];

    const periods = fillPeriods(masterBuckets(now), rows);

    expect(periods.today.series.map((b) => b.encryptions)).toEqual([
      1, 3, 0, 0,
    ]);
    expect(periods.today.totals).toMatchObject({
      encryptions: 4,
      devicesRevoked: 2,
      decryptions: 0,
    });
    expect(periods.today.start).toEqual(at('2026-11-12T00:00:00.000Z'));
    expect(periods.today.end).toEqual(at('2026-11-13T00:00:00.000Z'));

    expect(periods.week.series.map((b) => b.encryptions)).toEqual([
      0, 0, 0, 0, 5, 0, 4,
    ]);
    expect(periods.month.series.map((b) => b.encryptions)).toEqual([
      7, 0, 0, 9,
    ]);
    expect(periods.year.totals.encryptions).toBe(27);
    expect(periods.year.series[1].encryptions).toBe(11);
    expect(periods.year.series[11].encryptions).toBe(9);
    expect(periods.year.series[10].encryptions).toBe(7);
  });
});

describe('MasterGuard', () => {
  const guard = new MasterGuard();
  const context = (user: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    vi.stubEnv('MASTER_EMAILS', 'boss@cipherion.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets the verified master in', () => {
    expect(
      guard.canActivate(
        context({ email: 'boss@cipherion.test', emailVerified: true }),
      ),
    ).toBe(true);
  });

  it('answers 404 to anyone else, so the route stays hidden', () => {
    expect(() =>
      guard.canActivate(
        context({ email: 'ada@cipherion.test', emailVerified: true }),
      ),
    ).toThrow(NotFoundException);
    expect(() =>
      guard.canActivate(
        context({ email: 'boss@cipherion.test', emailVerified: false }),
      ),
    ).toThrow(NotFoundException);
  });
});
