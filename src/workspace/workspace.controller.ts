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
import { OPEN_DEVICE_STATUSES } from '../cipseq/devices.dto.js';
import { isEnvelopeJobRunning } from '../cipseq/envelope-jobs.js';
import {
  currentGdekVersion,
  GROUP_FIELDS,
  toGroupResponse,
} from '../cipseq/group-access.js';
import {
  INVITATION_FIELDS,
  OPEN_INVITATION_STATUSES,
  toInvitationResponse,
} from '../cipseq/invitations.controller.js';
import {
  PROJECT_FIELDS,
  projectsOf,
  toProjectResponse,
} from '../cipseq/project-access.js';
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
): Promise<Pick<WorkspaceResponse, 'projects' | 'devices' | 'notifications'>> {
  const projects = await cipseqPrisma.project.findMany({
    where: projectsOf(user.id),
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
      // Only a rotation updates the row, so this is when the version was created.
      keys: { select: { currentGdekVersion: true, updatedAt: true } },
      envelopeJob: {
        select: {
          kind: true,
          gdekVersion: true,
          status: true,
          failureReason: true,
          envelopeCount: true,
          startedAt: true,
          lastActiveAt: true,
          finishedAt: true,
          dismissedAt: true,
        },
      },
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
          ({ userId, role }) => userId === user.id && role === 'ACTING_ADMIN',
        ),
    )
    .map((group) => group.id);

  const [openInvitations, received, groupDevices, latestEnvelopes, ownDevices] =
    await Promise.all([
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
      managedGroupIds.length === 0
        ? []
        : cipseqPrisma.groupDevice.findMany({
            where: {
              groupId: { in: managedGroupIds },
              status: { in: [...OPEN_DEVICE_STATUSES] },
              device: { status: 'ACTIVE' },
            },
            orderBy: { createdAt: 'asc' },
            select: {
              groupId: true,
              status: true,
              createdAt: true,
              reviewedAt: true,
              device: { select: { id: true, name: true, userId: true } },
            },
          }),
      managedGroupIds.length === 0
        ? []
        : cipseqPrisma.deviceEnvelope.groupBy({
            by: ['groupId', 'deviceId'],
            where: { groupId: { in: managedGroupIds }, deletedAt: null },
            _max: { envelopeVersion: true },
          }),
      cipseqPrisma.device.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          groups: {
            where: { group: { deletedAt: null, project: { deletedAt: null } } },
            // Newest first: a group's earlier rows are history.
            orderBy: { createdAt: 'desc' },
            select: {
              groupId: true,
              status: true,
              group: { select: { name: true, projectId: true } },
            },
          },
        },
      }),
    ]);

  const latestByDevice = new Map(
    latestEnvelopes.map((envelope) => [
      `${envelope.groupId}:${envelope.deviceId}`,
      envelope._max.envelopeVersion,
    ]),
  );
  const latestEnvelopeVersion = (groupId: string, deviceId: string) =>
    latestByDevice.get(`${groupId}:${deviceId}`) ?? null;

  // The auth database is separate, so names and emails can't be joined.
  const userIds = [
    ...new Set([
      ...groups.flatMap((group) => group.members.map(({ userId }) => userId)),
      ...openInvitations.map(({ invitedByUserId }) => invitedByUserId),
      ...received.map(({ invitedByUserId }) => invitedByUserId),
      ...groupDevices.map(({ device }) => device.userId),
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
          const devices = groupDevices.filter(
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
            const missing = devices.filter(
              ({ status, device }) =>
                status === 'APPROVED' &&
                (latestEnvelopeVersion(group.id, device.id) ?? 0) <
                  currentGdekVersion(group),
            );
            const job = group.envelopeJob;
            if (missing.length > 0 && job && isEnvelopeJobRunning(job)) {
              notifications.push({
                type: 'ENVELOPES_IN_PROGRESS',
                id: group.id,
                ...where,
                jobKind: job.kind,
                missingCount: missing.length,
                createdAt: job.startedAt,
              });
            } else if (missing.length > 0) {
              // A device's envelope went missing at the rotation, or at its
              // approval if that came later.
              const keysUpdatedAt = group.keys?.updatedAt.getTime() ?? 0;
              const missingSince = missing.map(({ reviewedAt }) =>
                Math.max(keysUpdatedAt, reviewedAt?.getTime() ?? 0),
              );
              // Without a row for this version, the job never got to record itself.
              const current =
                job?.gdekVersion === currentGdekVersion(group) ? job : null;
              notifications.push({
                type: 'ENVELOPES_MISSING',
                id: group.id,
                ...where,
                ...(current && { jobKind: current.kind }),
                failureReason: current?.failureReason ?? 'INTERRUPTED',
                missingCount: missing.length,
                createdAt: new Date(Math.min(...missingSince)),
              });
            } else if (
              job?.status === 'COMPLETED' &&
              job.finishedAt &&
              !job.dismissedAt
            ) {
              // Stays until the project admin dismisses it.
              notifications.push({
                type: 'ENVELOPES_COMPLETED',
                id: group.id,
                ...where,
                jobKind: job.kind,
                envelopeCount: job.envelopeCount,
                createdAt: job.finishedAt,
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
            devices: devices.map(({ device, status }) => ({
              deviceId: device.id,
              name: device.name,
              userId: device.userId,
              status,
              latestEnvelopeVersion: latestEnvelopeVersion(group.id, device.id),
            })),
          });
        }),
    }),
  );

  // One request per device and project, however many groups it's waiting for.
  for (const project of projects) {
    if (project.adminUserId !== user.id) {
      continue;
    }
    const waiting = new Map<string, typeof groupDevices>();
    for (const row of groupDevices) {
      const inProject = groups.some(
        ({ id, projectId }) => id === row.groupId && projectId === project.id,
      );
      if (inProject && row.status === 'PENDING_APPROVAL') {
        waiting.set(row.device.id, [
          ...(waiting.get(row.device.id) ?? []),
          row,
        ]);
      }
    }
    for (const [deviceId, rows] of waiting) {
      const first = rows[0];
      if (first) {
        notifications.push({
          type: 'DEVICE_APPROVAL',
          id: deviceId,
          projectId: project.id,
          projectName: project.name,
          deviceId,
          deviceName: first.device.name,
          deviceUserName: nameOf(first.device.userId),
          groups: rows.flatMap(({ groupId }) => {
            const group = groups.find(({ id }) => id === groupId);
            return group ? [{ id: group.id, name: group.name }] : [];
          }),
          createdAt: first.createdAt,
        });
      }
    }
  }

  // A closed row stays as history, so only each group's newest row counts.
  const devices = ownDevices.map((device) => {
    const seen = new Set<string>();
    return {
      id: device.id,
      name: device.name,
      status: device.status,
      createdAt: device.createdAt,
      groups: device.groups.flatMap((row) => {
        if (seen.has(row.groupId)) {
          return [];
        }
        seen.add(row.groupId);
        return [
          {
            projectId: row.group.projectId,
            groupId: row.groupId,
            groupName: row.group.name,
            status: row.status,
          },
        ];
      }),
    };
  });

  notifications.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { projects: responseProjects, devices, notifications };
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
