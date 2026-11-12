import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import {
  ACCOUNT_TYPE_CHANGE_REFUSED,
  loadAccountType,
  setAccountType,
} from './account-type.js';
import { SetAccountTypeDto } from './account-type.dto.js';

const { create, findUnique, updateMany } = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { accountProfile: { create, findUnique, updateMany } },
}));

// The same options as the global ValidationPipe in src/app.setup.ts.
async function errorsFor(body: object): Promise<string[]> {
  const dto = plainToInstance(SetAccountTypeDto, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  return errors.map((error) => error.property);
}

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('SetAccountTypeDto', () => {
  it.each([
    [{ accountType: 'INDIVIDUAL' }],
    [{ accountType: 'COMPANY', companyName: 'Acme Labs' }],
    [{ accountType: 'COMPANY', companyName: 'x'.repeat(200) }],
  ])('accepts %j', async (body) => {
    await expect(errorsFor(body)).resolves.toEqual([]);
  });

  it.each([
    ['an unknown type', { accountType: 'NONPROFIT' }, 'accountType'],
    ['no type', {}, 'accountType'],
    ['a company without a name', { accountType: 'COMPANY' }, 'companyName'],
    [
      'a company with a blank name',
      { accountType: 'COMPANY', companyName: '   ' },
      'companyName',
    ],
    [
      'a company name over 200 characters',
      { accountType: 'COMPANY', companyName: 'x'.repeat(201) },
      'companyName',
    ],
    [
      'a company name for an individual',
      { accountType: 'INDIVIDUAL', companyName: 'Acme Labs' },
      'companyName',
    ],
    [
      'a null company name for an individual',
      { accountType: 'INDIVIDUAL', companyName: null },
      'companyName',
    ],
    [
      'an extra field',
      { accountType: 'INDIVIDUAL', taxId: '123' },
      'taxId',
    ],
  ])('refuses %s', async (_case, body, property) => {
    await expect(errorsFor(body)).resolves.toContain(property);
  });

  it('trims the company name', () => {
    const dto = plainToInstance(SetAccountTypeDto, {
      accountType: 'COMPANY',
      companyName: '  Acme Labs  ',
    });
    expect(dto.companyName).toBe('Acme Labs');
  });
});

describe('account type', () => {
  const chosenAt = new Date('2026-11-12T09:30:00.000Z');

  beforeEach(() => {
    create.mockReset().mockResolvedValue({});
    findUnique.mockReset();
    updateMany.mockReset();
  });

  it('returns nulls before the user chooses', async () => {
    findUnique.mockResolvedValue(null);

    await expect(loadAccountType('user-1')).resolves.toEqual({
      accountType: null,
      companyName: null,
      chosenAt: null,
    });
  });

  it('creates the row on the first choice', async () => {
    findUnique.mockResolvedValue({
      accountType: 'COMPANY',
      companyName: 'Acme Labs',
      createdAt: chosenAt,
    });

    await expect(
      setAccountType('user-1', {
        accountType: 'COMPANY',
        companyName: 'Acme Labs',
      }),
    ).resolves.toEqual({
      accountType: 'COMPANY',
      companyName: 'Acme Labs',
      chosenAt,
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        accountType: 'COMPANY',
        companyName: 'Acme Labs',
      },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('stores no company name for an individual', async () => {
    findUnique.mockResolvedValue(null);

    await setAccountType('user-1', { accountType: 'INDIVIDUAL' });

    expect(create).toHaveBeenCalledWith({
      data: { userId: 'user-1', accountType: 'INDIVIDUAL', companyName: null },
    });
  });

  it('accepts the same type again, renaming a company', async () => {
    create.mockRejectedValue(uniqueViolation());
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({
      accountType: 'COMPANY',
      companyName: 'Acme Labs Ltd',
      createdAt: chosenAt,
    });

    await expect(
      setAccountType('user-1', {
        accountType: 'COMPANY',
        companyName: 'Acme Labs Ltd',
      }),
    ).resolves.toMatchObject({ companyName: 'Acme Labs Ltd' });
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', accountType: 'COMPANY' },
      data: { companyName: 'Acme Labs Ltd' },
    });
  });

  it('refuses a different type with 409', async () => {
    create.mockRejectedValue(uniqueViolation());
    updateMany.mockResolvedValue({ count: 0 });

    const error = await setAccountType('user-1', {
      accountType: 'INDIVIDUAL',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(
      ACCOUNT_TYPE_CHANGE_REFUSED,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('passes other database errors through', async () => {
    const failure = new Error('connection refused');
    create.mockRejectedValue(failure);

    await expect(
      setAccountType('user-1', { accountType: 'INDIVIDUAL' }),
    ).rejects.toBe(failure);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
