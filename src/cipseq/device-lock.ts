import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../generated/cipseq/client.js';
import { Prisma as PrismaRuntime } from '../generated/cipseq/client.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';

export type CipSeqTransaction = Prisma.TransactionClient;

const BUSY_RETRY_AFTER_SECONDS = 5;

// Serialises every change to one device's status or certificates, across all
// gateway instances. Released when the transaction ends. $executeRaw, not
// $queryRaw: this function returns void, which $queryRaw may fail to decode.
export const lockDevice = (
  client: Pick<typeof cipseqPrisma, '$executeRaw'>,
  deviceId: string,
) =>
  client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`device-cert:${deviceId}`}::text, 0))`;

// 55P03 is Postgres's lock_not_available, and P2028 is Prisma's transaction timeout.
export function isDeviceBusy(error: unknown): boolean {
  if (!(error instanceof PrismaRuntime.PrismaClientKnownRequestError)) {
    return false;
  }
  return (
    error.code === 'P2028' ||
    error.message.includes('55P03') ||
    error.message.includes('lock timeout')
  );
}

// A waiting request holds a pooled connection, so a wait must stay short: requests
// piling up on one device must not starve the rest of CipSeq of connections.
export async function withDeviceLock<T>(
  deviceId: string,
  work: (tx: CipSeqTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await cipseqPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        await lockDevice(tx, deviceId);
        return work(tx);
      },
      { maxWait: 2000, timeout: 5000 },
    );
  } catch (error) {
    if (isDeviceBusy(error)) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: 'Unavailable. Please try again shortly.',
        retryAfter: BUSY_RETRY_AFTER_SECONDS,
      });
    }
    throw error;
  }
}
