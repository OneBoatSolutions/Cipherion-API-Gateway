import { ConflictException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import {
  ACCOUNT_TYPE_CHANGE_REFUSED,
  loadAccountType,
  setAccountType,
} from './account-type.js';
import { SetAccountTypeDto } from './account-type.dto.js';

const { create, findUnique, updateMany, auditEvent } = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  auditEvent: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { accountProfile: { create, findUnique, updateMany } },
}));
vi.mock('../cipseq/audit.js', () => ({ auditEvent }));

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
    auditEvent.mockReset().mockResolvedValue({ id: 'audit-1' });
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

  it('audits the first choice instead of logging it', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    findUnique.mockResolvedValue(null);

    await setAccountType('user-1', { accountType: 'INDIVIDUAL' });

    expect(auditEvent).toHaveBeenCalledWith(
      'user-1',
      'account.type_set',
      null,
      { accountType: 'INDIVIDUAL' },
    );
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('renames a company sent again with another name, and audits it', async () => {
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
      where: {
        userId: 'user-1',
        accountType: 'COMPANY',
        companyName: { not: 'Acme Labs Ltd' },
      },
      data: { companyName: 'Acme Labs Ltd' },
    });
    expect(auditEvent).toHaveBeenCalledWith(
      'user-1',
      'account.company_renamed',
      null,
      { changed: ['companyName'] },
    );
  });

  it('accepts the same values again without a write or an audit row', async () => {
    create.mockRejectedValue(uniqueViolation());
    updateMany.mockResolvedValue({ count: 0 });
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
    ).resolves.toMatchObject({ accountType: 'COMPANY' });
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it('accepts INDIVIDUAL again without trying to rename', async () => {
    create.mockRejectedValue(uniqueViolation());
    findUnique.mockResolvedValue({
      accountType: 'INDIVIDUAL',
      companyName: null,
      createdAt: chosenAt,
    });

    await setAccountType('user-1', { accountType: 'INDIVIDUAL' });

    expect(updateMany).not.toHaveBeenCalled();
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it('refuses a different type with 409', async () => {
    create.mockRejectedValue(uniqueViolation());
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ accountType: 'COMPANY' });

    const error = await setAccountType('user-1', {
      accountType: 'INDIVIDUAL',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(
      ACCOUNT_TYPE_CHANGE_REFUSED,
    );
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it('still succeeds when the audit row cannot be written, and logs it', async () => {
    const logError = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    auditEvent.mockRejectedValue(new Error('ECONNREFUSED'));
    findUnique.mockResolvedValue(null);

    await expect(
      setAccountType('user-1', { accountType: 'INDIVIDUAL' }),
    ).resolves.toBeDefined();
    expect(logError).toHaveBeenCalledWith(
      'Audit row not written for user user-1: account.type_set',
    );
    logError.mockRestore();
  });

  it('passes other database errors through', async () => {
    const failure = new Error('connection refused');
    create.mockRejectedValue(failure);

    await expect(
      setAccountType('user-1', { accountType: 'INDIVIDUAL' }),
    ).rejects.toBe(failure);
    expect(updateMany).not.toHaveBeenCalled();
    expect(auditEvent).not.toHaveBeenCalled();
  });
});
