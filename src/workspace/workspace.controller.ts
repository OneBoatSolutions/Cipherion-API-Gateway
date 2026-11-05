import {
  Controller,
  Get,
  Header,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { GROUP_FIELDS, toGroupResponse } from '../cipseq/group-access.js';
import { PROJECT_FIELDS, toProjectResponse } from '../cipseq/project-access.js';
import { toProfileResponse } from '../dashboard/profile.dto.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
} from '../dashboard/settings.dto.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { prisma } from '../lib/prisma.js';
import { WorkspaceProject, WorkspaceResponse } from './workspace.dto.js';

const logger = new Logger('Workspace');

// Everything the signed-in user is a part of. Scoped in the queries themselves,
// so rows the user can't see never leave the database.
async function loadProjects(user: AuthUser): Promise<WorkspaceProject[]> {
  const projects = await cipseqPrisma.project.findMany({
    where: { deletedAt: null, members: { some: { userId: user.id } } },
    orderBy: { createdAt: 'desc' },
    select: PROJECT_FIELDS,
  });

  const adminProjectIds = projects
    .filter((project) => project.adminUserId === user.id)
    .map((project) => project.id);
  const groups = await cipseqPrisma.group.findMany({
    where: {
      deletedAt: null,
      projectId: { in: projects.map((project) => project.id) },
      OR: [
        { projectId: { in: adminProjectIds } },
        { members: { some: { userId: user.id } } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      ...GROUP_FIELDS,
      members: {
        orderBy: { createdAt: 'asc' },
        select: { userId: true, role: true, createdAt: true },
      },
    },
  });

  // The auth database is separate, so names and emails can't be joined.
  const userIds = [
    ...new Set(
      groups.flatMap((group) => group.members.map(({ userId }) => userId)),
    ),
  ];
  const users =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        });
  const usersById = new Map(users.map((found) => [found.id, found]));

  return projects.map((project) =>
    Object.assign(toProjectResponse(project, user.id), {
      groups: groups
        .filter((group) => group.projectId === project.id)
        .map((group) => {
          const own = group.members.find(({ userId }) => userId === user.id);
          const role =
            project.adminUserId === user.id ? 'ADMIN' : (own?.role ?? 'MEMBER');
          return Object.assign(toGroupResponse(group, role), {
            members: group.members.map((member) => ({
              ...member,
              name: usersById.get(member.userId)?.name ?? null,
              email: usersById.get(member.userId)?.email ?? null,
            })),
          });
        }),
    }),
  );
}

@ApiTags('workspace')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@Controller('workspace')
export class WorkspaceController {
  // One read for sign-in and page load. It is all or nothing, so a client never
  // shows a partial workspace as if it were complete.
  @ApiOperation({
    summary: 'Get everything the signed-in user is a part of',
  })
  @ApiOkResponse({ type: WorkspaceResponse })
  @ApiServiceUnavailableResponse({ description: 'A database is unavailable' })
  @Header('Cache-Control', 'no-store')
  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<WorkspaceResponse> {
    try {
      const [settings, projects] = await Promise.all([
        prisma.userSettings.findUnique({
          where: { userId: user.id },
          select: SETTINGS_FIELDS,
        }),
        loadProjects(user),
      ]);
      return {
        profile: toProfileResponse(user),
        settings: settings ?? DEFAULT_SETTINGS,
        projects,
        notifications: [],
      };
    } catch (error) {
      logger.error(
        `Could not load the workspace: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw new ServiceUnavailableException(
        'Unavailable. Please try again shortly.',
      );
    }
  }
}
