import { cipseqPrisma } from '../lib/cipseq-prisma.js';

export type AuditAction =
  | 'project.created'
  | 'project.initialized'
  | 'project.key_rotated'
  | 'project.updated'
  | 'project.deleted'
  | 'project.member_revoked'
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
  | 'device.registered'
  | 'device.approval_requested'
  | 'device.approved'
  | 'device.rejected'
  | 'device.revoked'
  | 'device.envelopes_created'
  | 'device.envelope_job_dismissed';

type AuditMetadata =
  | { groupId: string; invitationId: string }
  | { changed: string[] }
  | { fromVersion: number; toVersion: number }
  | { groupId: string; changed?: string[] }
  | { groupId: string; fromVersion: number; toVersion: number }
  | { groupId: string; targetUserId: string; role?: string }
  | { targetUserId: string }
  | { deviceId: string; groupId?: string }
  | { deviceId: string; groupIds: string[] }
  | { groupId: string; gdekVersion: number; count?: number };

// Runs inside the transaction of the change it records, so the two commit
// together. Metadata must never hold passphrases or key material. A device isn't
// tied to one project, so its own events have no project id.
export function auditEvent(
  userId: string,
  action: AuditAction,
  projectId: string | null,
  metadata?: AuditMetadata,
) {
  return cipseqPrisma.auditEvent.create({
    data: { userId, action, projectId, metadata },
  });
}
