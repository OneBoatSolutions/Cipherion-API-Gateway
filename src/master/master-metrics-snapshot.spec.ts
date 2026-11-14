import { masterBuckets, fillPeriods } from './master-metrics.js';
import {
  lastBoundary,
  nextBoundary,
  revivePeriods,
} from './master-metrics-snapshot.js';

vi.mock('../lib/cipseq-prisma.js', () => ({ cipseqPrisma: {} }));
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));

const at = (iso: string) => new Date(iso);
const iso = (date: Date) => date.toISOString();

describe('master metrics snapshot', () => {
  it.each([
    [
      '2026-11-14T05:59:59.999Z',
      '2026-11-14T00:00:00.000Z',
      '2026-11-14T06:00:00.000Z',
    ],
    [
      '2026-11-14T06:00:00.000Z',
      '2026-11-14T06:00:00.000Z',
      '2026-11-14T12:00:00.000Z',
    ],
    [
      '2026-11-14T06:00:05.000Z',
      '2026-11-14T06:00:00.000Z',
      '2026-11-14T12:00:00.000Z',
    ],
    [
      '2026-11-14T13:30:00.000Z',
      '2026-11-14T12:00:00.000Z',
      '2026-11-14T18:00:00.000Z',
    ],
    // The last one of the day rolls over to the next midnight.
    [
      '2026-11-14T23:59:59.000Z',
      '2026-11-14T18:00:00.000Z',
      '2026-11-15T00:00:00.000Z',
    ],
    [
      '2026-12-31T19:00:00.000Z',
      '2026-12-31T18:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ],
  ])(
    'at %s, the last refresh boundary is %s and the next %s',
    (now, last, next) => {
      expect(iso(lastBoundary(at(now)))).toBe(last);
      expect(iso(nextBoundary(at(now)))).toBe(next);
    },
  );

  it('gets the stored periods back with their dates', () => {
    const periods = fillPeriods(masterBuckets(at('2026-11-14T12:00:05.000Z')), {
      encryptions: [{ bucket: '2026-11-14T07:00:00Z', count: 4 }],
    } as never);
    const stored = JSON.parse(JSON.stringify(periods)) as never;

    const revived = revivePeriods(stored);

    expect(revived).toEqual(periods);
    expect(revived.today.start).toBeInstanceOf(Date);
    expect(revived.today.series[1].end).toBeInstanceOf(Date);
    expect(revived.today.series[1].encryptions).toBe(4);
  });

  it('puts the keys back in order, since jsonb reorders them', () => {
    const periods = fillPeriods(
      masterBuckets(at('2026-11-14T12:00:05.000Z')),
      {} as never,
    );
    // Reverse every object's keys, as a stand-in for jsonb's order.
    const scramble = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(scramble)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, inner]) => [key, scramble(inner)]),
            )
          : value;
    const stored = scramble(JSON.parse(JSON.stringify(periods))) as never;

    const revived = revivePeriods(stored);

    expect(JSON.stringify(revived)).toBe(JSON.stringify(periods));
    expect(Object.keys(revived)).toEqual(['today', 'week', 'month', 'year']);
  });
});
