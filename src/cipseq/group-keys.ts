import { ConflictException, NotFoundException } from '@nestjs/common';
import { kmsCall } from '../kms/kms-call.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { auditEvent } from './audit.js';
import {
  assertSameId,
  isRecordNotFound,
  isUniqueViolation,
} from './cipseq-errors.js';
import {
  currentGdekVersion,
  type GroupRow,
  toGroupResponse,
} from './group-access.js';
import type { GroupResponse } from './groups.dto.js';
import { withPassphraseAttempt } from './with-passphrase-attempt.js';

// Creating, rotating and revoking all use this RPC, which makes a new group root
// key and GDEK each time. The passphrase goes to the KMS and is then dropped: it
// is never stored, logged or written to the audit trail.
export async function createGroupKeys(
  projectId: string,
  groupId: string,
  passphrase: string,
) {
  const keys = await cipseqPrisma.projectKeys.findUniqueOrThrow({
    where: { projectId },
  });
  if (
    keys.userPassphraseSalt === null ||
    keys.wrappedProjectEncryptionKeyIv === null ||
    keys.wrappedProjectEncryptionKey === null ||
    keys.wrappedProjectEncryptionKeyTag === null
  ) {
    throw new ConflictException('The project is not initialised');
  }

  const wrapped = await kmsCall(
    'createAndWrapNewGroupRootKeyAndGroupDataEncryptionKey',
    {
      GroupId: groupId,
      WrappedProjectRootKeyIV: keys.wrappedProjectRootKeyIv,
      WrappedProjectRootKey: keys.wrappedProjectRootKey,
      WrappedProjectRootKeyTag: keys.wrappedProjectRootKeyTag,
      WrappedProjectEncryptionKeyIV: keys.wrappedProjectEncryptionKeyIv,
      WrappedProjectEncryptionKey: keys.wrappedProjectEncryptionKey,
      WrappedProjectEncryptionKeyTag: keys.wrappedProjectEncryptionKeyTag,
      UserPassphrase: passphrase,
      UserPassphraseSalt: keys.userPassphraseSalt,
    },
  );
  assertSameId(groupId, wrapped.GroupId);

  return {
    wrappedGroupRootKeyIv: wrapped.WrappedGroupRootKeyIV,
    wrappedGroupRootKey: wrapped.WrappedGroupRootKey,
    wrappedGroupRootKeyTag: wrapped.WrappedGroupRootKeyTag,
    wrappedGroupDataEncryptionKeyIv: wrapped.WrappedGroupDataEncryptionKeyIV,
    wrappedGroupDataEncryptionKey: wrapped.WrappedGroupDataEncryptionKey,
    wrappedGroupDataEncryptionKeyTag: wrapped.WrappedGroupDataEncryptionKeyTag,
  };
}

interface RevokeMember {
  actorUserId: string;
  projectId: string;
  group: GroupRow;
  targetUserId: string;
  passphrase: string;
  // Set when this revocation approves an acting admin's request.
  requestId?: string;
}

// The member's removal and the new keys commit together, so a member is never
// removed without a rotation. The project member row stays. A direct revoke also
// closes any pending request for the member, which is no longer needed.
export async function revokeGroupMember({
  actorUserId,
  projectId,
  group,
  targetUserId,
  passphrase,
  requestId,
}: RevokeMember): Promise<GroupResponse> {
  const groupId = group.id;
  const fromVersion = currentGdekVersion(group);
  const toVersion = fromVersion + 1;

  await withPassphraseAttempt(projectId, async () => {
    const keys = await createGroupKeys(projectId, groupId, passphrase);
    const review = { reviewedByUserId: actorUserId, reviewedAt: new Date() };
    try {
      await cipseqPrisma.$transaction([
        // The primary key rejects a second rotation from the same version.
        cipseqPrisma.groupKeyVersion.create({
          data: { groupId, gdekVersion: toVersion },
        }),
        cipseqPrisma.groupKeys.update({
          where: { groupId },
          data: { ...keys, currentGdekVersion: toVersion },
        }),
        cipseqPrisma.groupMember.delete({
          where: { groupId_userId: { groupId, userId: targetUserId } },
        }),
        requestId
          ? cipseqPrisma.groupMemberRemovalRequest.update({
              where: { id: requestId, status: 'PENDING_APPROVAL' },
              data: { status: 'APPROVED', ...review },
            })
          : cipseqPrisma.groupMemberRemovalRequest.updateMany({
              where: { groupId, targetUserId, status: 'PENDING_APPROVAL' },
              data: { status: 'CANCELLED', ...review },
            }),
        auditEvent(actorUserId, 'group.member_revoked', projectId, {
          groupId,
          targetUserId,
          fromVersion,
          toVersion,
          ...(requestId && { requestId }),
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('The group was rotated by another request');
      }
      if (isRecordNotFound(error)) {
        // With a request, that request or its member changed while this ran.
        throw requestId
          ? new ConflictException('This has already been handled')
          : new NotFoundException();
      }
      throw error;
    }
  });

  return toGroupResponse(
    { ...group, keys: { currentGdekVersion: toVersion } },
    'ADMIN',
  );
}
