import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import type { GroupResponse, GroupRole } from './groups.dto.js';
import {
  findProjectForAdmin,
  findProjectForMember,
  type ProjectRow,
} from './project-access.js';

export const GROUP_FIELDS = {
  id: true,
  projectId: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  keys: { select: { currentGdekVersion: true } },
} as const;

export interface GroupRow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  keys: { currentGdekVersion: number } | null;
}

// A group is created in one transaction with its keys, so they are always there.
export function currentGdekVersion(group: GroupRow): number {
  if (!group.keys) {
    throw new Error(`Group ${group.id} has no keys`);
  }
  return group.keys.currentGdekVersion;
}

export function toGroupResponse(
  group: GroupRow,
  role: GroupRole,
): GroupResponse {
  return {
    id: group.id,
    projectId: group.projectId,
    name: group.name,
    description: group.description,
    role,
    gdekVersion: currentGdekVersion(group),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

// Only the project admin changes a group. The project is checked first, so
// someone outside it gets 404 and a member gets 403 whether or not the group exists.
export async function findGroupForAdmin(
  projectId: string,
  groupId: string,
  userId: string,
): Promise<{ project: ProjectRow; group: GroupRow }> {
  const project = await findProjectForAdmin(projectId, userId);
  const group = await cipseqPrisma.group.findFirst({
    where: { id: groupId, projectId, deletedAt: null },
    select: GROUP_FIELDS,
  });
  if (!group) {
    throw new NotFoundException();
  }
  return { project, group };
}

export interface GroupAccess {
  project: ProjectRow;
  group: GroupRow;
  isProjectAdmin: boolean;
  isGroupAdmin: boolean;
}

// The project admin and the group's own members. Anyone else in the project gets
// 404, so they can't confirm that a group they aren't in exists.
export async function findGroupForMember(
  projectId: string,
  groupId: string,
  userId: string,
): Promise<GroupAccess> {
  const project = await findProjectForMember(projectId, userId);
  const group = await cipseqPrisma.group.findFirst({
    where: { id: groupId, projectId, deletedAt: null },
    select: {
      ...GROUP_FIELDS,
      members: { where: { userId }, select: { role: true } },
    },
  });
  const isProjectAdmin = project.adminUserId === userId;
  const member = group?.members[0];
  if (!group || (!isProjectAdmin && !member)) {
    throw new NotFoundException();
  }
  return {
    project,
    group,
    isProjectAdmin,
    isGroupAdmin: isProjectAdmin || member?.role === 'ACTING_ADMIN',
  };
}

// The project admin and acting admins.
export async function findGroupForGroupAdmin(
  projectId: string,
  groupId: string,
  userId: string,
): Promise<GroupAccess> {
  const access = await findGroupForMember(projectId, groupId, userId);
  if (!access.isGroupAdmin) {
    throw new ForbiddenException();
  }
  return access;
}
