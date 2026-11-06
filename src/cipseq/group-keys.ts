import { ConflictException } from '@nestjs/common';
import { kmsCall } from '../kms/kms-call.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { assertSameId } from './cipseq-errors.js';

// The project's wrapped keys, which every call that checks the passphrase needs.
export async function loadProjectKeyChain(projectId: string) {
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
  return {
    wrappedProjectRootKeyIv: keys.wrappedProjectRootKeyIv,
    wrappedProjectRootKey: keys.wrappedProjectRootKey,
    wrappedProjectRootKeyTag: keys.wrappedProjectRootKeyTag,
    wrappedProjectEncryptionKeyIv: keys.wrappedProjectEncryptionKeyIv,
    wrappedProjectEncryptionKey: keys.wrappedProjectEncryptionKey,
    wrappedProjectEncryptionKeyTag: keys.wrappedProjectEncryptionKeyTag,
    userPassphraseSalt: keys.userPassphraseSalt,
  };
}

// Creating and rotating both use this RPC, which makes a new group root key and
// GDEK each time. The passphrase goes to the KMS and is then dropped: it is never
// stored, logged or written to the audit trail.
export async function createGroupKeys(
  projectId: string,
  groupId: string,
  passphrase: string,
) {
  const keys = await loadProjectKeyChain(projectId);

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
