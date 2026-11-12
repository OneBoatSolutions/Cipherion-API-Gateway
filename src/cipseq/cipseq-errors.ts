import { BadGatewayException, ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '../generated/cipseq/client.js';

const logger = new Logger('CipSeq');

// A key is bound to the id sent to the KMS, so a key returned for another id
// must never be saved.
export function assertSameId(sent: string, received: string): void {
  if (sent !== received) {
    logger.error('The KMS returned keys for a different id');
    throw new BadGatewayException();
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

export function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
  );
}

// For a write that only applies while a row still has the expected status, so
// two people can't both act on one invitation or request.
export async function whileStatusCurrent<T>(
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new ConflictException('This has already been handled');
    }
    throw error;
  }
}
