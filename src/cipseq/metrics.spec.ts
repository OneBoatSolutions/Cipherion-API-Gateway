import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LeaderboardQuery, UsageQuery } from './metrics.dto.js';
import { buckets, fillBuckets, sumBuckets } from './metrics.js';

const iso = (date: Date) => date.toISOString();
const bounds = (list: { start: Date; end: Date }[]) =>
  list.map(({ start, end }) => [iso(start), iso(end)]);

describe('buckets', () => {
  // A Wednesday afternoon.
  const now = new Date('2026-11-11T14:30:00.000Z');

  it('splits today into four 6-hour buckets, including the hours to come', () => {
    expect(bounds(buckets('today', now))).toEqual([
      ['2026-11-11T00:00:00.000Z', '2026-11-11T06:00:00.000Z'],
      ['2026-11-11T06:00:00.000Z', '2026-11-11T12:00:00.000Z'],
      ['2026-11-11T12:00:00.000Z', '2026-11-11T18:00:00.000Z'],
      ['2026-11-11T18:00:00.000Z', '2026-11-12T00:00:00.000Z'],
    ]);
  });

  it('gives the last 7 and 30 days, ending with today', () => {
    const week = buckets('week', now);
    expect(week).toHaveLength(7);
    expect(iso(week[0].start)).toBe('2026-11-05T00:00:00.000Z');
    expect(iso(week[6].start)).toBe('2026-11-11T00:00:00.000Z');
    expect(iso(week[6].end)).toBe('2026-11-12T00:00:00.000Z');

    const month = buckets('month', now);
    expect(month).toHaveLength(30);
    expect(iso(month[0].start)).toBe('2026-10-13T00:00:00.000Z');
    expect(iso(month[29].end)).toBe('2026-11-12T00:00:00.000Z');
  });

  it('gives the last 12 calendar months, across a year boundary', () => {
    const year = buckets('year', now);
    expect(year).toHaveLength(12);
    expect(bounds(year)[0]).toEqual([
      '2025-12-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect(bounds(year)[11]).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z',
    ]);
    // February in a leap year ends on the 29th.
    const leap = buckets('year', new Date('2028-03-10T00:00:00.000Z'));
    expect(iso(leap[10].start)).toBe('2028-02-01T00:00:00.000Z');
    expect(iso(leap[10].end)).toBe('2028-03-01T00:00:00.000Z');
  });

  it('uses the UTC day just after midnight', () => {
    const justAfter = new Date('2026-01-01T00:00:00.001Z');
    expect(iso(buckets('today', justAfter)[0].start)).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(iso(buckets('week', justAfter)[6].start)).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('covers every month since the first delivery for all, or just this one', () => {
    expect(
      bounds(buckets('all', now, new Date('2026-09-20T08:00:00.000Z'))),
    ).toEqual([
      ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
      ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
      ['2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'],
    ]);
    expect(buckets('all', now, null)).toHaveLength(1);
  });
});

describe('fillBuckets', () => {
  const empty = buckets('today', new Date('2026-11-11T14:30:00.000Z'));

  it('puts hourly rows into their 6-hour bucket and leaves the rest at zero', () => {
    const filled = fillBuckets(empty, [
      { bucket: '2026-11-11T07:00:00Z', encryptions: 3, decryptions: 1 },
      { bucket: '2026-11-11T11:00:00Z', encryptions: 2, decryptions: 0 },
      { bucket: '2026-11-11T12:00:00Z', encryptions: 0, decryptions: 4 },
      // Outside the window: ignored.
      { bucket: '2026-11-10T23:00:00Z', encryptions: 9, decryptions: 9 },
    ]);
    expect(
      filled.map(({ encryptions, decryptions, total }) => [
        encryptions,
        decryptions,
        total,
      ]),
    ).toEqual([
      [0, 0, 0],
      [5, 1, 6],
      [0, 4, 4],
      [0, 0, 0],
    ]);
    expect(sumBuckets(filled)).toEqual({
      encryptions: 5,
      decryptions: 5,
      total: 10,
    });
  });
});

describe('metrics query validation', () => {
  const errorsOf = async (cls: new () => object, query: object) =>
    (await validate(plainToInstance(cls, query))).flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );
  const device = `dvc_${'A'.repeat(43)}`;
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('accepts each period on the leaderboard, and none', async () => {
    for (const period of ['today', 'week', 'month', 'year', 'all', undefined]) {
      expect(await errorsOf(LeaderboardQuery, { period })).toEqual([]);
    }
    expect(await errorsOf(LeaderboardQuery, { period: 'decade' })).toHaveLength(
      1,
    );
  });

  it('checks the id against its scope', async () => {
    const ok = [
      { scope: 'project', id: uuid },
      { scope: 'group', id: uuid },
      { scope: 'user', id: uuid },
      { scope: 'user', id: 'legacy_Id-123' },
      { scope: 'device', id: device },
    ];
    for (const query of ok) {
      expect(await errorsOf(UsageQuery, { ...query, period: 'week' })).toEqual(
        [],
      );
    }
    expect(
      await errorsOf(UsageQuery, { scope: 'device', id: uuid, period: 'week' }),
    ).toEqual(['id must be a device id (dvc_…)']);
    expect(
      await errorsOf(UsageQuery, {
        scope: 'group',
        id: device,
        period: 'week',
      }),
    ).toEqual(['id must be a group id (UUID)']);
  });

  it("requires scope and period, and refuses 'all' for usage", async () => {
    expect(
      await errorsOf(UsageQuery, { scope: 'team', id: uuid, period: 'week' }),
    ).toHaveLength(1);
    expect(
      await errorsOf(UsageQuery, { scope: 'project', id: uuid, period: 'all' }),
    ).toHaveLength(1);
    expect(await errorsOf(UsageQuery, { id: uuid })).toHaveLength(2);
  });
});
