import { cipseqPrisma } from '../lib/cipseq-prisma.js';

export type AuditAction =
  | 'project.created'
  | 'project.initialized'
  | 'project.key_rotated'
  | 'project.updated'
  | 'project.deleted'
  | 'group.created'
  | 'group.updated'
  | 'group.deleted'
  | 'group.key_rotated'
  | 'group.member_role_changed'
  | 'group.member_revoked'
  | 'invitation.created'
  | 'invitation.approved'
  | 'invitation.rejected'
  | 'invitation.cancelled'
  | 'invitation.accepted'
  | 'invitation.declined'
  | 'removal_request.created'
  | 'removal_request.rejected'
  | 'removal_request.cancelled';

type AuditMetadata =
  | { groupId: string; invitationId: string }
  | { groupId: string; requestId: string; targetUserId: string }
  | { changed: string[] }
  | { fromVersion: number; toVersion: number }
  | { groupId: string; changed?: string[] }
  | { groupId: string; fromVersion: number; toVersion: number }
  | { groupId: string; targetUserId: string; role: string }
  | {
      groupId: string;
      targetUserId: string;
      fromVersion: number;
      toVersion: number;
      requestId?: string;
    };

// Runs inside the transaction of the change it records, so the two commit
// together. Metadata must never hold passphrases or key material.
export function auditEvent(
  userId: string,
  action: AuditAction,
  projectId: string,
  metadata?: AuditMetadata,
) {
  return cipseqPrisma.auditEvent.create({
    data: { userId, action, projectId, metadata },
  });
}
