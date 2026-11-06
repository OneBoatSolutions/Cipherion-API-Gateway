import { randomUUID } from 'node:crypto';
import { ConflictException, HttpException, Logger } from '@nestjs/common';
import type {
  EnvelopeJobFailure,
  EnvelopeJobKind,
} from '../generated/cipseq/enums.js';
import { IncorrectPassphraseException } from '../kms/incorrect-passphrase.exception.js';
import { kmsCall } from '../kms/kms-call.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { auditEvent } from './audit.js';
import {
  closeEnvelopeJobs,
  finishEnvelopeJobs,
  markEnvelopeJobsStarted,
  touchEnvelopeJobs,
} from './envelope-jobs.js';
import { loadProjectKeyChain } from './group-keys.js';

const logger = new Logger('DeviceEnvelopes');

const ML_KEM_1024_SUITE = 2;
// How many KMS calls a job makes at once.
const ENVELOPE_BATCH_SIZE = 5;

export interface EnvelopeDevice {
  id: string;
  publicKey: string;
}

export interface WrappedEnvelope {
  groupId: string;
  deviceId: string;
  envelopeVersion: number;
  envelopeJson: string;
}

function loadGroupKeys(projectId: string, groupId: string) {
  return cipseqPrisma.groupKeys.findFirst({
    where: { groupId, group: { projectId, deletedAt: null } },
  });
}

type GroupKeyRow = NonNullable<Awaited<ReturnType<typeof loadGroupKeys>>>;

// Approved devices with no live envelope at this version.
function missingEnvelopes(groupId: string, version: number) {
  return {
    groupId,
    status: 'APPROVED',
    device: {
      status: 'ACTIVE',
      envelopes: {
        none: { groupId, envelopeVersion: version, deletedAt: null },
      },
    },
  } as const;
}

// The KMS checks the passphrase here. The passphrase goes to the KMS and is then
// dropped: it is never stored, logged or written to the audit trail.
async function callKms(
  projectId: string,
  groupKeys: GroupKeyRow,
  device: EnvelopeDevice,
  passphrase: string,
): Promise<WrappedEnvelope> {
  const projectKeys = await loadProjectKeyChain(projectId);
  const { EnvelopeJson } = await kmsCall('createDeviceEnvelope', {
    Suite: ML_KEM_1024_SUITE,
    ProjectId: projectId,
    GroupId: groupKeys.groupId,
    DeviceId: device.id,
    GdekVersion: groupKeys.currentGdekVersion,
    DeviceEncapsulationKey: device.publicKey,
    WrappedProjectRootKeyIV: projectKeys.wrappedProjectRootKeyIv,
    WrappedProjectRootKey: projectKeys.wrappedProjectRootKey,
    WrappedProjectRootKeyTag: projectKeys.wrappedProjectRootKeyTag,
    WrappedProjectEncryptionKeyIV: projectKeys.wrappedProjectEncryptionKeyIv,
    WrappedProjectEncryptionKey: projectKeys.wrappedProjectEncryptionKey,
    WrappedProjectEncryptionKeyTag: projectKeys.wrappedProjectEncryptionKeyTag,
    WrappedGroupRootKeyIV: groupKeys.wrappedGroupRootKeyIv,
    WrappedGroupRootKey: groupKeys.wrappedGroupRootKey,
    WrappedGroupRootKeyTag: groupKeys.wrappedGroupRootKeyTag,
    WrappedGroupDataEncryptionKeyIV: groupKeys.wrappedGroupDataEncryptionKeyIv,
    WrappedGroupDataEncryptionKey: groupKeys.wrappedGroupDataEncryptionKey,
    WrappedGroupDataEncryptionKeyTag:
      groupKeys.wrappedGroupDataEncryptionKeyTag,
    UserPassphrase: passphrase,
    UserPassphraseSalt: projectKeys.userPassphraseSalt,
  });
  return {
    groupId: groupKeys.groupId,
    deviceId: device.id,
    envelopeVersion: groupKeys.currentGdekVersion,
    // Signed by the KMS, so it is stored exactly as returned.
    envelopeJson: EnvelopeJson,
  };
}

// For an approval, which creates its first envelope inside the request so that a
// wrong passphrase is reported and counted.
export async function wrapEnvelope(
  projectId: string,
  groupId: string,
  device: EnvelopeDevice,
  passphrase: string,
): Promise<WrappedEnvelope> {
  const groupKeys = await loadGroupKeys(projectId, groupId);
  if (!groupKeys) {
    throw new ConflictException('The group no longer exists');
  }
  return callKms(projectId, groupKeys, device, passphrase);
}

// Runs after an envelope commits. A revocation that commits first is caught here,
// and one that commits later soft deletes the envelope itself, so an envelope
// never stays live for a revoked device.
export async function removeIneligibleEnvelopes(
  groupId: string,
  deviceIds: string[],
): Promise<void> {
  await cipseqPrisma.deviceEnvelope.updateMany({
    where: {
      groupId,
      deviceId: { in: deviceIds },
      deletedAt: null,
      NOT: {
        device: {
          status: 'ACTIVE',
          groups: { some: { groupId, status: 'APPROVED' } },
        },
      },
    },
    data: { deletedAt: new Date() },
  });
}

async function commitEnvelopes(
  actorUserId: string,
  projectId: string,
  groupId: string,
  version: number,
  envelopes: WrappedEnvelope[],
): Promise<void> {
  await cipseqPrisma.$transaction([
    // A partial unique index keeps one live envelope per device and version, so a
    // job overlapping another one just skips what already exists.
    cipseqPrisma.deviceEnvelope.createMany({
      data: envelopes,
      skipDuplicates: true,
    }),
    auditEvent(actorUserId, 'device.envelopes_created', projectId, {
      groupId,
      gdekVersion: version,
      count: envelopes.length,
    }),
  ]);
  await removeIneligibleEnvelopes(
    groupId,
    envelopes.map(({ deviceId }) => deviceId),
  );
}

// For a renewal, which also checks the passphrase inside the request. Returns
// false if the group has nothing missing.
export async function createFirstMissingEnvelope(
  actorUserId: string,
  projectId: string,
  groupId: string,
  passphrase: string,
): Promise<boolean> {
  const groupKeys = await loadGroupKeys(projectId, groupId);
  if (!groupKeys) {
    throw new ConflictException('The group no longer exists');
  }
  const version = groupKeys.currentGdekVersion;
  const missing = await cipseqPrisma.groupDevice.findFirst({
    where: missingEnvelopes(groupId, version),
    select: { device: { select: { id: true, publicKey: true } } },
  });
  if (!missing) {
    return false;
  }
  const envelope = await callKms(
    projectId,
    groupKeys,
    missing.device,
    passphrase,
  );
  await commitEnvelopes(actorUserId, projectId, groupId, version, [envelope]);
  return true;
}

async function missingByGroup(groupIds: string[]) {
  const groups = await cipseqPrisma.groupKeys.findMany({
    where: { groupId: { in: groupIds } },
    select: { groupId: true, currentGdekVersion: true },
  });
  return Promise.all(
    groups.map(async ({ groupId, currentGdekVersion }) => ({
      groupId,
      gdekVersion: currentGdekVersion,
      envelopeCount: await cipseqPrisma.groupDevice.count({
        where: missingEnvelopes(groupId, currentGdekVersion),
      }),
    })),
  );
}

export async function countMissingEnvelopes(
  groupIds: string[],
): Promise<number> {
  const groups = await missingByGroup(groupIds);
  return groups.reduce((total, group) => total + group.envelopeCount, 0);
}

async function createMissingEnvelopes(
  actorUserId: string,
  projectId: string,
  groupId: string,
  passphrase: string,
  onBatch: () => Promise<void>,
): Promise<void> {
  let version: number | undefined;
  // Continues from the last row, because starting from the top would walk past
  // every device already done, slowing each batch as the job goes on.
  let afterId: string | undefined;
  for (;;) {
    const groupKeys = await loadGroupKeys(projectId, groupId);
    // A newer version has its own job, started by the rotation that made it.
    if (
      !groupKeys ||
      (version !== undefined && groupKeys.currentGdekVersion !== version)
    ) {
      return;
    }
    const currentVersion = groupKeys.currentGdekVersion;
    version = currentVersion;

    const batch = await cipseqPrisma.groupDevice.findMany({
      where: {
        ...missingEnvelopes(groupId, currentVersion),
        ...(afterId !== undefined && { id: { gt: afterId } }),
      },
      orderBy: { id: 'asc' },
      select: { id: true, device: { select: { id: true, publicKey: true } } },
      take: ENVELOPE_BATCH_SIZE,
    });
    const last = batch.at(-1);
    if (!last) {
      // One last pass from the top, for anything added behind the job.
      if (afterId === undefined) {
        return;
      }
      afterId = undefined;
      continue;
    }
    afterId = last.id;

    const results = await Promise.allSettled(
      batch.map(({ device }) =>
        callKms(projectId, groupKeys, device, passphrase),
      ),
    );
    const envelopes = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (envelopes.length > 0) {
      await commitEnvelopes(
        actorUserId,
        projectId,
        groupId,
        currentVersion,
        envelopes,
      );
    }
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
    await onBatch();
  }
}

function failureReason(error: unknown): EnvelopeJobFailure {
  if (error instanceof IncorrectPassphraseException) {
    return 'WRONG_PASSPHRASE';
  }
  // kmsCall answers every KMS failure with an HttpException.
  return error instanceof HttpException ? 'KMS_UNAVAILABLE' : 'INTERRUPTED';
}

function logJobError(message: string, error: unknown): void {
  logger.warn(
    `${message}: ${error instanceof Error ? error.name : 'unknown error'}`,
  );
}

// Creates the groups' missing envelopes in the background, holding the passphrase
// in memory only until it finishes. It stops at the first failure without
// retrying. The passphrase is gone after that, so what's left, including after a
// restart, shows as ENVELOPES_MISSING for the project admin to resume by entering
// it again. Only ids and the error's name reach the log.
//
// Resolves once the job is recorded as running, so a client that reloads straight
// away sees it in progress. The envelopes are created after that.
export async function startEnvelopeJob(
  actorUserId: string,
  projectId: string,
  groupIds: string[],
  passphrase: string,
  kind: EnvelopeJobKind,
): Promise<void> {
  const jobId = randomUUID();
  let jobGroupIds = groupIds;
  // The keys have committed by now, so failing to record the job can't fail the
  // request. It reads as interrupted, which still shows the admin what's missing.
  try {
    const groups = await missingByGroup(groupIds);
    const toCreate = groups.filter(({ envelopeCount }) => envelopeCount > 0);
    jobGroupIds = toCreate.map(({ groupId }) => groupId);
    const nothingToCreate = groups
      .filter(({ envelopeCount }) => envelopeCount === 0)
      .map(({ groupId }) => groupId);
    if (nothingToCreate.length > 0) {
      await closeEnvelopeJobs(nothingToCreate);
    }
    await markEnvelopeJobsStarted(jobId, kind, toCreate);
  } catch (error) {
    logJobError('Could not record the envelope job', error);
  }

  void (async () => {
    for (const [index, groupId] of jobGroupIds.entries()) {
      try {
        await createMissingEnvelopes(
          actorUserId,
          projectId,
          groupId,
          passphrase,
          () => touchEnvelopeJobs(jobId, jobGroupIds),
        );
        await finishEnvelopeJobs(jobId, [groupId]);
      } catch (error) {
        logJobError(`Envelope job stopped for group ${groupId}`, error);
        // The groups it hasn't reached stop with it.
        await finishEnvelopeJobs(
          jobId,
          jobGroupIds.slice(index),
          failureReason(error),
        ).catch((recordError: unknown) => {
          logJobError('Could not record the stopped job', recordError);
        });
        return;
      }
    }
  })();
}
