import { cipseqPrisma } from '../lib/cipseq-prisma.js';

export type AuditAction =
  | 'project.created'
  | 'project.initialized'
  | 'project.key_rotated'
  | 'project.updated'
  | 'project.deleted';

// Runs inside the transaction of the change it records, so the two commit
// together. Metadata must never hold passphrases or key material.
export function auditEvent(
  userId: string,
  action: AuditAction,
  projectId: string,
  metadata?: { changed: string[] } | { fromVersion: number; toVersion: number },
) {
  return cipseqPrisma.auditEvent.create({
    data: { userId, action, projectId, metadata },
  });
}
