import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import type { ProjectResponse } from './projects.dto.js';

export const PROJECT_FIELDS = {
  id: true,
  name: true,
  description: true,
  adminUserId: true,
  createdAt: true,
  updatedAt: true,
  keys: { select: { currentKeyVersion: true } },
} as const;

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  adminUserId: string;
  createdAt: Date;
  updatedAt: Date;
  keys: { currentKeyVersion: number | null } | null;
}

export function toProjectResponse(
  project: ProjectRow,
  userId: string,
): ProjectResponse {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    role: project.adminUserId === userId ? 'ADMIN' : 'MEMBER',
    keyVersion: project.keys?.currentKeyVersion ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

// A project has no direct members: it belongs to its admin and to whoever is in
// one of its live groups.
export function projectsOf(userId: string) {
  return {
    deletedAt: null,
    OR: [
      { adminUserId: userId },
      { groups: { some: { deletedAt: null, members: { some: { userId } } } } },
    ],
  };
}

// A project that doesn't exist, was deleted, or that the user isn't a part of all
// answer 404, so outsiders can't discover which projects exist.
export async function findProjectForMember(
  projectId: string,
  userId: string,
): Promise<ProjectRow> {
  const project = await cipseqPrisma.project.findFirst({
    where: { id: projectId, ...projectsOf(userId) },
    select: PROJECT_FIELDS,
  });
  if (!project) {
    throw new NotFoundException();
  }
  return project;
}

export async function findProjectForAdmin(
  projectId: string,
  userId: string,
): Promise<ProjectRow> {
  const project = await findProjectForMember(projectId, userId);
  if (project.adminUserId !== userId) {
    throw new ForbiddenException();
  }
  return project;
}
