import type {
  EnvelopeJobFailure,
  EnvelopeJobKind,
  EnvelopeJobStatus,
} from '../generated/cipseq/enums.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';

// A running job updates lastActiveAt after every batch, and a batch is bound by
// the KMS deadline, so this long without an update means the job has died.
export const ENVELOPE_JOB_STALE_MS = 2 * 60 * 1000;

export function isEnvelopeJobRunning(
  job: { status: EnvelopeJobStatus; lastActiveAt: Date } | null | undefined,
): boolean {
  return (
    job?.status === 'RUNNING' &&
    Date.now() - job.lastActiveAt.getTime() < ENVELOPE_JOB_STALE_MS
  );
}

export async function markEnvelopeJobsStarted(
  jobId: string,
  kind: EnvelopeJobKind,
  groups: { groupId: string; gdekVersion: number; envelopeCount: number }[],
): Promise<void> {
  const now = new Date();
  const started = {
    jobId,
    status: 'RUNNING',
    failureReason: null,
    startedAt: now,
    lastActiveAt: now,
    finishedAt: null,
    dismissedAt: null,
  } as const;
  await cipseqPrisma.$transaction(
    groups.map(({ groupId, gdekVersion, envelopeCount }) =>
      cipseqPrisma.envelopeJob.upsert({
        where: { groupId },
        create: { groupId, kind, gdekVersion, envelopeCount, ...started },
        // A renewal resumes what stopped, so it keeps saying what that was.
        update: {
          ...(kind !== 'RENEWAL' && { kind }),
          gdekVersion,
          envelopeCount,
          ...started,
        },
      }),
    ),
  );
}

export async function touchEnvelopeJobs(
  jobId: string,
  groupIds: string[],
): Promise<void> {
  await cipseqPrisma.envelopeJob.updateMany({
    where: { jobId, groupId: { in: groupIds } },
    data: { lastActiveAt: new Date() },
  });
}

export async function finishEnvelopeJobs(
  jobId: string,
  groupIds: string[],
  failureReason?: EnvelopeJobFailure,
): Promise<void> {
  await cipseqPrisma.envelopeJob.updateMany({
    where: { jobId, groupId: { in: groupIds } },
    data: {
      status: failureReason ? 'FAILED' : 'COMPLETED',
      failureReason: failureReason ?? null,
      finishedAt: new Date(),
    },
  });
}

// For groups with nothing left to create, such as when a renewal's first envelope
// was the last one, so a job that stopped earlier now reads as finished.
export async function closeEnvelopeJobs(groupIds: string[]): Promise<void> {
  await cipseqPrisma.envelopeJob.updateMany({
    where: { groupId: { in: groupIds }, status: { not: 'COMPLETED' } },
    data: {
      status: 'COMPLETED',
      failureReason: null,
      finishedAt: new Date(),
    },
  });
}
