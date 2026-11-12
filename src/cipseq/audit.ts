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
  | 'device.envelope_job_dismissed'
  | 'device.envelope_delivered'
  | 'device.certificate_enrolled'
  | 'device.certificate_renewed'
  | 'device.certificate_refused'
  | 'device.certificate_issue_failed'
  | 'device.certificate_notice_dismissed'
  // The account type lives in the auth database; its audit rows live here,
  // written after the change commits (src/dashboard/account-type.ts).
  | 'account.type_set'
  | 'account.company_renamed';

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
  | { groupId: string; gdekVersion: number; count?: number }
  | {
      deviceId: string;
      serialNumber: string;
      previousSerial: string | null;
      notAfter: string;
    }
  | { deviceId: string; serialNumber: string }
  | { deviceId: string; operation: string }
  | { noticeId: string }
  | { accountType: 'INDIVIDUAL' | 'COMPANY' }
  | {
      deviceId: string;
      groupId: string;
      gdekVersion: number;
      requestId: string;
      operation: 'ENCRYPT' | 'DECRYPT';
    };

// Runs inside the transaction of the change it records, so the two commit
// together. Metadata must never hold passphrases or key material. A device isn't
// tied to one project, so its own events have no project id. Inside an interactive
// transaction, pass its client: the global one would commit on its own, even if
// the transaction rolled back.
export function auditEvent(
  userId: string,
  action: AuditAction,
  projectId: string | null,
  metadata?: AuditMetadata,
  client: Pick<typeof cipseqPrisma, 'auditEvent'> = cipseqPrisma,
) {
  return client.auditEvent.create({
    data: { userId, action, projectId, metadata },
  });
}
