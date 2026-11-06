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
import {
  INVITATION_FIELDS,
  OPEN_INVITATION_STATUSES,
  toInvitationResponse,
} from '../cipseq/invitations.controller.js';
import { PROJECT_FIELDS, toProjectResponse } from '../cipseq/project-access.js';
import {
  REMOVAL_REQUEST_FIELDS,
  toRemovalRequestResponse,
} from '../cipseq/removal-requests.controller.js';
import { toProfileResponse } from '../dashboard/profile.dto.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
} from '../dashboard/settings.dto.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { prisma } from '../lib/prisma.js';
import { WorkspaceNotification, WorkspaceResponse } from './workspace.dto.js';

const logger = new Logger('Workspace');

// Everything the signed-in user is a part of. Scoped in the queries themselves,
// so rows the user can't see never leave the database.
async function loadCipSeq(
  user: AuthUser,
): Promise<Pick<WorkspaceResponse, 'projects' | 'notifications'>> {
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

  const projectsById = new Map(projects.map((found) => [found.id, found]));
  const isProjectAdmin = (projectId: string) =>
    projectsById.get(projectId)?.adminUserId === user.id;

  // Only the project admin and acting admins see what's open in a group.
  const managedGroupIds = groups
    .filter(
      (group) =>
        isProjectAdmin(group.projectId) ||
        group.members.some(
          ({ userId, role }) => userId === user.id && role === 'ADMIN',
        ),
    )
    .map((group) => group.id);

  const [openInvitations, pendingRemovals, received] = await Promise.all([
    managedGroupIds.length === 0
      ? []
      : cipseqPrisma.groupInvitation.findMany({
          where: {
            groupId: { in: managedGroupIds },
            status: { in: [...OPEN_INVITATION_STATUSES] },
          },
          orderBy: { createdAt: 'desc' },
          select: INVITATION_FIELDS,
        }),
    managedGroupIds.length === 0
      ? []
      : cipseqPrisma.groupMemberRemovalRequest.findMany({
          where: {
            groupId: { in: managedGroupIds },
            status: 'PENDING_APPROVAL',
          },
          orderBy: { createdAt: 'desc' },
          select: REMOVAL_REQUEST_FIELDS,
        }),
    // By email, because the invitee may not be in the project yet.
    cipseqPrisma.groupInvitation.findMany({
      where: {
        inviteeEmail: user.email.toLowerCase(),
        status: 'PENDING_ACCEPTANCE',
        group: { deletedAt: null, project: { deletedAt: null } },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        invitedByUserId: true,
        createdAt: true,
        group: {
          select: {
            id: true,
            name: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);

  // The auth database is separate, so names and emails can't be joined.
  const userIds = [
    ...new Set([
      ...groups.flatMap((group) => group.members.map(({ userId }) => userId)),
      ...openInvitations.map(({ invitedByUserId }) => invitedByUserId),
      ...pendingRemovals.flatMap((request) => [
        request.targetUserId,
        request.requestedByUserId,
      ]),
      ...received.map(({ invitedByUserId }) => invitedByUserId),
    ]),
  ];
  const users =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        });
  const usersById = new Map(users.map((found) => [found.id, found]));
  const nameOf = (userId: string) => usersById.get(userId)?.name ?? null;

  const notifications: WorkspaceNotification[] = received.map((invitation) => ({
    type: 'INVITATION_RECEIVED',
    id: invitation.id,
    projectId: invitation.group.project.id,
    projectName: invitation.group.project.name,
    groupId: invitation.group.id,
    groupName: invitation.group.name,
    invitedByName: nameOf(invitation.invitedByUserId),
    createdAt: invitation.createdAt,
  }));

  const responseProjects = projects.map((project) =>
    Object.assign(toProjectResponse(project, user.id), {
      groups: groups
        .filter((group) => group.projectId === project.id)
        .map((group) => {
          const own = group.members.find(({ userId }) => userId === user.id);
          const role =
            project.adminUserId === user.id ? 'ADMIN' : (own?.role ?? 'MEMBER');
          const invitations = openInvitations.filter(
            ({ groupId }) => groupId === group.id,
          );
          const removals = pendingRemovals.filter(
            ({ groupId }) => groupId === group.id,
          );

          if (project.adminUserId === user.id) {
            const where = {
              projectId: project.id,
              projectName: project.name,
              groupId: group.id,
              groupName: group.name,
            };
            for (const invitation of invitations) {
              if (invitation.status === 'PENDING_APPROVAL') {
                notifications.push({
                  type: 'INVITATION_APPROVAL',
                  id: invitation.id,
                  ...where,
                  inviteeEmail: invitation.inviteeEmail,
                  invitedByName: nameOf(invitation.invitedByUserId),
                  createdAt: invitation.createdAt,
                });
              }
            }
            for (const removal of removals) {
              notifications.push({
                type: 'REMOVAL_APPROVAL',
                id: removal.id,
                ...where,
                targetUserId: removal.targetUserId,
                targetName: nameOf(removal.targetUserId),
                requestedByName: nameOf(removal.requestedByUserId),
                createdAt: removal.createdAt,
              });
            }
          }

          return Object.assign(toGroupResponse(group, role), {
            members: group.members.map((member) => ({
              ...member,
              name: usersById.get(member.userId)?.name ?? null,
              email: usersById.get(member.userId)?.email ?? null,
            })),
            pendingInvitations: invitations.map((invitation) =>
              toInvitationResponse(invitation, project.id),
            ),
            pendingRemovals: removals.map((removal) =>
              toRemovalRequestResponse(removal, project.id),
            ),
          });
        }),
    }),
  );

  notifications.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { projects: responseProjects, notifications };
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
      const [settings, cipseq] = await Promise.all([
        prisma.userSettings.findUnique({
          where: { userId: user.id },
          select: SETTINGS_FIELDS,
        }),
        loadCipSeq(user),
      ]);
      return {
        profile: toProfileResponse(user),
        settings: settings ?? DEFAULT_SETTINGS,
        ...cipseq,
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
