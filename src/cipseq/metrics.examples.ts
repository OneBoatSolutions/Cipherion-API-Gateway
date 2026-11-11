// Example responses for the API docs, built with the same bucket code as the
// endpoints so they always match it.
import { buckets, type LeaderboardPeriod, sumBuckets } from './metrics.js';

// A fixed "now" for the examples: Wednesday 11 November 2026, 14:30 UTC.
const NOW = new Date('2026-11-11T14:30:00.000Z');

export const BUCKETS_TABLE = `| \`period\` | Window | Buckets |
|---|---|---|
| \`today\` | Today, 00:00 to 24:00 | 4 buckets of 6 hours: 00–06, 06–12, 12–18, 18–24 |
| \`week\` | The last 7 days, ending today | 7 buckets of 1 day, each 00:00 to 24:00 |
| \`month\` | The last 30 days, ending today | 30 buckets of 1 day |
| \`year\` | The last 12 months, ending this month | 12 buckets of 1 calendar month |
| \`all\` (leaderboard only) | From the month of the first delivery to this month | 1 calendar month each |`;

function exampleSeries(period: LeaderboardPeriod, counts: [number, number][]) {
  const empty = buckets(period, NOW, new Date('2026-09-03T10:00:00.000Z'));
  const series = empty.map((bucket, index) => {
    const [encryptions, decryptions] = counts[index] ?? [0, 0];
    return {
      start: bucket.start.toISOString(),
      end: bucket.end.toISOString(),
      encryptions,
      decryptions,
      total: encryptions + decryptions,
    };
  });
  return {
    from: series[0].start,
    to: series[series.length - 1].end,
    totals: sumBuckets(series),
    series,
  };
}

const DEVICE_ID = 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USER_ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const PROJECT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

export const USAGE_EXAMPLES = {
  today: {
    summary: 'scope=device, period=today (4 buckets; 18–24 is still 0)',
    value: {
      scope: 'device',
      id: DEVICE_ID,
      period: 'today',
      ...exampleSeries('today', [
        [0, 0],
        [30, 9],
        [12, 8],
      ]),
    },
  },
  week: {
    summary: 'scope=user, period=week (7 daily buckets)',
    value: {
      scope: 'user',
      id: USER_ID,
      period: 'week',
      ...exampleSeries('week', [
        [12, 4],
        [0, 0],
        [8, 3],
        [15, 9],
        [22, 11],
        [5, 2],
        [42, 17],
      ]),
    },
  },
  year: {
    summary:
      'scope=project, period=year (12 monthly buckets). month has the same shape with 30 daily buckets',
    value: {
      scope: 'project',
      id: PROJECT_ID,
      period: 'year',
      ...exampleSeries('year', [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [210, 96],
        [455, 230],
        [140, 61],
      ]),
    },
  },
};

const counts = (encryptions: number, decryptions: number) => ({
  encryptions,
  decryptions,
  total: encryptions + decryptions,
});

export const LEADERBOARD_EXAMPLE = {
  period: 'month',
  ...exampleSeries(
    'month',
    Array.from({ length: 30 }, (_, day) => [day * 3, day]),
  ),
  projects: [
    { projectId: PROJECT_ID, name: 'Payments', ...counts(980, 412) },
    {
      projectId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      name: 'Payroll',
      ...counts(325, 23),
    },
  ],
  users: [
    {
      userId: USER_ID,
      name: 'Ada Lovelace',
      email: 'ada@cipherion.com',
      ...counts(610, 250),
    },
    {
      userId: '9b2f0a4e-5c1d-4f6e-8a7b-1c2d3e4f5a6b',
      name: 'Grace Hopper',
      email: 'grace@cipherion.com',
      ...counts(695, 185),
    },
  ],
  devices: [
    {
      deviceId: DEVICE_ID,
      name: 'Work laptop',
      status: 'ACTIVE',
      userId: USER_ID,
      userName: 'Ada Lovelace',
      ...counts(540, 230),
    },
    {
      deviceId: 'dvc_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      name: null,
      status: 'REVOKED',
      userId: '9b2f0a4e-5c1d-4f6e-8a7b-1c2d3e4f5a6b',
      userName: 'Grace Hopper',
      ...counts(300, 60),
    },
  ],
};

export const EMPTY_LEADERBOARD_EXAMPLE = {
  period: 'today',
  ...exampleSeries('today', []),
  projects: [],
  users: [],
  devices: [],
};

export const BAD_REQUEST_EXAMPLE = {
  period: {
    message: 'Validation failed',
    errors: [
      {
        property: 'period',
        constraints: [
          'period must be one of the following values: today, week, month, year, all',
        ],
      },
    ],
  },
  scope: {
    message: 'Validation failed',
    errors: [
      {
        property: 'scope',
        constraints: [
          'scope must be one of the following values: project, group, user, device',
        ],
      },
    ],
  },
  id: {
    message: 'Validation failed',
    errors: [
      { property: 'id', constraints: ['id must be a device id (dvc_…)'] },
    ],
  },
};

export const NOT_FOUND_EXAMPLE = { message: 'Not Found', statusCode: 404 };
export const UNAUTHORIZED_EXAMPLE = {
  message: 'Unauthorized',
  statusCode: 401,
};
