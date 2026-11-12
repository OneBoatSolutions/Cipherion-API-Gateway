import { ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AccountType } from '../generated/prisma/enums.js';
import { prisma } from '../lib/prisma.js';
import type { SetAccountTypeDto } from './account-type.dto.js';

// Plain shapes of AccountTypeSummary and AccountTypeResponse (the classes are
// for Swagger), so they can be spread into other responses.
export interface AccountTypeFields {
  accountType: AccountType | null;
  companyName: string | null;
}

export interface AccountTypeState extends AccountTypeFields {
  chosenAt: Date | null;
}

const logger = new Logger('AccountType');

export const ACCOUNT_TYPE_CHANGE_REFUSED =
  'The account type is already set. Contact support to change it.';

const FIELDS = { accountType: true, companyName: true, createdAt: true } as const;

// No row means the user hasn't chosen yet.
export async function loadAccountType(
  userId: string,
): Promise<AccountTypeState> {
  const row = await prisma.accountProfile.findUnique({
    where: { userId },
    select: FIELDS,
  });
  return {
    accountType: row?.accountType ?? null,
    companyName: row?.companyName ?? null,
    chosenAt: row?.createdAt ?? null,
  };
}

export function toAccountTypeSummary({
  accountType,
  companyName,
}: AccountTypeFields): AccountTypeFields {
  return { accountType, companyName };
}

// The type is set once. Sending the same type again succeeds (and renames a
// company); a different type is refused, so nobody switches to whichever tier
// is cheaper. Support changes it by hand.
export async function setAccountType(
  userId: string,
  { accountType, companyName }: SetAccountTypeDto,
): Promise<AccountTypeState> {
  const name = accountType === AccountType.COMPANY ? companyName! : null;

  try {
    await prisma.accountProfile.create({
      data: { userId, accountType, companyName: name },
    });
    logger.log(`User ${userId} chose the account type ${accountType}`);
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // Already chosen, possibly by a request running at the same time. Only a
    // row with the same type matches, so a different type changes nothing.
    const { count } = await prisma.accountProfile.updateMany({
      where: { userId, accountType },
      data: { companyName: name },
    });
    if (count === 0) {
      throw new ConflictException(ACCOUNT_TYPE_CHANGE_REFUSED);
    }
  }

  return loadAccountType(userId);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
