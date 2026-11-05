import { BadGatewayException, Logger } from '@nestjs/common';
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
