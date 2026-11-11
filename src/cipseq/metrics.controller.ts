import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { prisma } from '../lib/prisma.js';
import {
  type LeaderboardDevice,
  type LeaderboardProject,
  LeaderboardQuery,
  LeaderboardResponse,
  type LeaderboardUser,
  USAGE_SCOPES,
  UsageQuery,
  UsageResponse,
} from './metrics.dto.js';
import {
  countsOf,
  type DeliveryFilter,
  LEADERBOARD_PERIODS,
  series,
  sumBuckets,
  topBy,
  USAGE_PERIODS,
} from './metrics.js';
import {
  BAD_REQUEST_EXAMPLE,
  BUCKETS_TABLE,
  EMPTY_LEADERBOARD_EXAMPLE,
  LEADERBOARD_EXAMPLE,
  NOT_FOUND_EXAMPLE,
  UNAUTHORIZED_EXAMPLE,
  USAGE_EXAMPLES,
} from './metrics.examples.js';

const adminProjectIds = async (userId: string) =>
  (
    await cipseqPrisma.project.findMany({
      where: { adminUserId: userId, deletedAt: null },
      select: { id: true },
    })
  ).map(({ id }) => id);

// Whether a user or device has anything to do with the admin's projects: a
// membership or approval there, or a delivery made there.
async function inProjects(
  projectIds: string[],
  target: { userId: string } | { deviceId: string },
): Promise<boolean> {
  if (projectIds.length === 0) {
    return false;
  }
  const group = { projectId: { in: projectIds } };
  const [link, delivery] = await Promise.all([
    'userId' in target
      ? cipseqPrisma.groupMember.findFirst({
          where: { userId: target.userId, group },
          select: { userId: true },
        })
      : cipseqPrisma.groupDevice.findFirst({
          where: { deviceId: target.deviceId, group },
          select: { id: true },
        }),
    cipseqPrisma.envelopeDelivery.findFirst({
      where: { ...target, projectId: { in: projectIds } },
      select: { id: true },
    }),
  ]);
  return Boolean(link ?? delivery);
}

// The deliveries a caller may count for one scope and id. Anything they can't
// see answers 404, the same as something that doesn't exist.
async function usageFilter(
  callerId: string,
  { scope, id }: UsageQuery,
): Promise<DeliveryFilter> {
  if (scope === 'user' && id === callerId) {
    return { userId: id };
  }
  if (scope === 'device') {
    const device = await cipseqPrisma.device.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (device?.userId === callerId) {
      return { deviceId: id };
    }
    if (!device) {
      throw new NotFoundException();
    }
  }

  const projectIds = await adminProjectIds(callerId);
  switch (scope) {
    case 'project':
      if (!projectIds.includes(id)) {
        throw new NotFoundException();
      }
      return { projectIds: [id] };
    case 'group': {
      const group = await cipseqPrisma.group.findFirst({
        where: { id, deletedAt: null, projectId: { in: projectIds } },
        select: { id: true },
      });
      if (!group) {
        throw new NotFoundException();
      }
      return { groupId: id };
    }
    case 'user':
      if (!(await inProjects(projectIds, { userId: id }))) {
        throw new NotFoundException();
      }
      return { userId: id, projectIds };
    case 'device':
      if (!(await inProjects(projectIds, { deviceId: id }))) {
        throw new NotFoundException();
      }
      return { deviceId: id, projectIds };
  }
}

const COUNTED = `**What's counted:** each successful envelope delivery to the engine (\`POST /cipseq/crypto/encrypt\` or \`/decrypt\` on port 3443). The engine fetches an envelope for every operation, so one delivery is one encryption or decryption. Refused requests (404, 503, 429…) aren't counted. Counting started when this was deployed.`;

const SERIES_NOTES = `**Buckets** (all times UTC):

${BUCKETS_TABLE}

- \`series\` has every bucket, oldest first, with zeros where nothing happened, so it can be plotted directly.
- The current bucket is partial: it only counts up to now. For \`today\`, the buckets after now are present and 0.
- Boundaries are always UTC. To label the x-axis in the viewer's time zone, format \`start\` in that zone; the counts don't change.
- \`totals\` is the sum of \`series\`.`;

@ApiTags('cipseq')
@ApiCookieAuth()
@ApiUnauthorizedResponse({
  description: 'No valid session',
  example: UNAUTHORIZED_EXAMPLE,
})
@Controller('cipseq/metrics')
export class MetricsController {
  @ApiOperation({
    summary:
      'Top 10 projects, users and devices by encryptions and decryptions, across the projects you are admin of',
    description: `${COUNTED}

**Who sees what:** only deliveries inside projects where you are the project admin (deleted projects are left out). A user or device that also works in other people's projects shows only what happened in yours. If you're admin of no project, every list is empty and every count is 0.

**Order:** highest \`total\` first, then highest \`encryptions\`, then by id, so ties always sort the same. Each list has at most 10 entries.

**Charts:** \`series\` is the overall activity of all your projects together. For one project, user or device over time, call \`GET /cipseq/metrics/usage\` with its id.

${SERIES_NOTES}`,
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: LEADERBOARD_PERIODS,
    description:
      'Time window and bucket size (see the table above). Defaults to `month`',
    example: 'month',
  })
  @ApiOkResponse({
    type: LeaderboardResponse,
    examples: {
      filled: { summary: 'period=month', value: LEADERBOARD_EXAMPLE },
      empty: {
        summary: 'Admin of no project (period=today)',
        value: EMPTY_LEADERBOARD_EXAMPLE,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Unknown `period`',
    example: BAD_REQUEST_EXAMPLE.period,
  })
  @Get('leaderboard')
  async leaderboard(
    @CurrentUser() user: AuthUser,
    @Query() { period = 'month' }: LeaderboardQuery,
  ): Promise<LeaderboardResponse> {
    const now = new Date();
    const projectIds = await adminProjectIds(user.id);
    const filter = { projectIds };
    const buckets = await series(filter, period, now);
    const from = buckets[0].start;
    const to = buckets[buckets.length - 1].end;

    const [projectRows, userRows, deviceRows] = await Promise.all([
      topBy('projectId', filter, from, to),
      topBy('userId', filter, from, to),
      topBy('deviceId', filter, from, to),
    ]);

    const [projects, devices] = await Promise.all([
      cipseqPrisma.project.findMany({
        where: { id: { in: projectRows.map(({ id }) => id) } },
        select: { id: true, name: true },
      }),
      cipseqPrisma.device.findMany({
        where: { id: { in: deviceRows.map(({ id }) => id) } },
        select: { id: true, name: true, status: true, userId: true },
      }),
    ]);
    const users = await prisma.user.findMany({
      where: {
        id: {
          in: [
            ...userRows.map(({ id }) => id),
            ...devices.map(({ userId }) => userId),
          ],
        },
      },
      select: { id: true, name: true, email: true },
    });
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    const userById = new Map(users.map((u) => [u.id, u]));

    return {
      period,
      from,
      to,
      totals: sumBuckets(buckets),
      series: buckets,
      projects: projectRows.map((row): LeaderboardProject => ({
        projectId: row.id,
        name: projectById.get(row.id)?.name ?? '',
        ...countsOf(row),
      })),
      users: userRows.map((row): LeaderboardUser => ({
        userId: row.id,
        name: userById.get(row.id)?.name ?? null,
        email: userById.get(row.id)?.email ?? null,
        ...countsOf(row),
      })),
      devices: deviceRows.map((row): LeaderboardDevice => {
        const device = deviceById.get(row.id);
        return {
          deviceId: row.id,
          name: device?.name ?? null,
          status: device?.status ?? 'ACTIVE',
          userId: device?.userId ?? '',
          userName: device ? (userById.get(device.userId)?.name ?? null) : null,
          ...countsOf(row),
        };
      }),
    };
  }

  @ApiOperation({
    summary:
      'Encryptions and decryptions over time for one project, group, user or device',
    description: `${COUNTED}

**Who can ask for what:**

| \`scope\` | Allowed | What's counted |
|---|---|---|
| \`project\` | Its project admin | Everything in the project |
| \`group\` | Its project's admin | Everything in the group |
| \`user\` | That user themselves | Everything they did, in every project |
| \`user\` | A project admin, for a user in one of their projects | Only what the user did in the caller's admin projects |
| \`device\` | The device's owner | Everything it did, in every project |
| \`device\` | A project admin, for a device in one of their projects | Only what it did in the caller's admin projects |

Anything else answers \`404\`, the same as an id that doesn't exist, so the API never reveals what exists outside what you can see.

${SERIES_NOTES}`,
  })
  @ApiQuery({
    name: 'scope',
    required: true,
    enum: USAGE_SCOPES,
    description: 'What `id` refers to',
    example: 'device',
  })
  @ApiQuery({
    name: 'id',
    required: true,
    type: String,
    description:
      'For `project` and `group`: a UUID. For `user`: the Better Auth user id (a UUID; older accounts may have another id). For `device`: `dvc_` followed by 43 base64url characters',
    example: 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  @ApiQuery({
    name: 'period',
    required: true,
    enum: USAGE_PERIODS,
    description: 'Time window and bucket size (see the table above)',
    example: 'today',
  })
  @ApiOkResponse({ type: UsageResponse, examples: USAGE_EXAMPLES })
  @ApiBadRequestResponse({
    description:
      'A missing or unknown `scope` or `period`, or an `id` in the wrong format for its scope',
    examples: {
      scope: { summary: 'Unknown scope', value: BAD_REQUEST_EXAMPLE.scope },
      id: {
        summary: 'Wrong id format for the scope',
        value: BAD_REQUEST_EXAMPLE.id,
      },
    },
  })
  @ApiNotFoundResponse({
    description:
      "The project, group, user or device doesn't exist, or you aren't allowed to see it",
    example: NOT_FOUND_EXAMPLE,
  })
  @Get('usage')
  async usage(
    @CurrentUser() user: AuthUser,
    @Query() query: UsageQuery,
  ): Promise<UsageResponse> {
    const filter = await usageFilter(user.id, query);
    const buckets = await series(filter, query.period, new Date());
    return {
      scope: query.scope,
      id: query.id,
      period: query.period,
      from: buckets[0].start,
      to: buckets[buckets.length - 1].end,
      totals: sumBuckets(buckets),
      series: buckets,
    };
  }
}
