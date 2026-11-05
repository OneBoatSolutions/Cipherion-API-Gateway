import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { Prisma } from '../generated/cipseq/client.js';
import { IncorrectPassphraseException } from '../kms/incorrect-passphrase.exception.js';
import { GroupsController } from './groups.controller.js';

const mocks = vi.hoisted(() => ({
  kmsCall: vi.fn(),
  reservePassphraseAttempt: vi.fn(),
  releasePassphraseAttempt: vi.fn(),
  clearPassphraseAttempts: vi.fn(),
  $transaction: vi.fn(),
  project: { findFirst: vi.fn() },
  projectKeys: { findUniqueOrThrow: vi.fn() },
  group: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  groupKeys: { update: vi.fn() },
  groupKeyVersion: { create: vi.fn() },
  groupMember: {
    delete: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  auditEvent: { create: vi.fn() },
}));

vi.mock('../kms/kms-call.js', () => ({ kmsCall: mocks.kmsCall }));
vi.mock('./passphrase-attempts.js', () => ({
  reservePassphraseAttempt: mocks.reservePassphraseAttempt,
  releasePassphraseAttempt: mocks.releasePassphraseAttempt,
  clearPassphraseAttempts: mocks.clearPassphraseAttempts,
}));
vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: {
    $transaction: mocks.$transaction,
    project: mocks.project,
    projectKeys: mocks.projectKeys,
    group: mocks.group,
    groupKeys: mocks.groupKeys,
    groupKeyVersion: mocks.groupKeyVersion,
    groupMember: mocks.groupMember,
    auditEvent: mocks.auditEvent,
  },
}));

const PASSPHRASE = 'correct horse battery staple';
const projectId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const groupId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const date = new Date('2026-11-05T06:36:46.000Z');
const admin = { id: 'admin-1' } as AuthUser;
const member = { id: 'member-1' } as AuthUser;
const target = 'target-1';

const projectRow = (currentKeyVersion: number | null = 1) => ({
  id: projectId,
  name: 'Payments',
  description: 'Card and invoice data',
  adminUserId: admin.id,
  createdAt: date,
  updatedAt: date,
  keys: { currentKeyVersion },
});

const groupRow = (currentGdekVersion = 1) => ({
  id: groupId,
  projectId,
  name: 'Finance',
  description: 'Invoices and payroll',
  createdAt: date,
  updatedAt: date,
  keys: { currentGdekVersion },
});

const groupResponse = (gdekVersion: number) => ({
  id: groupId,
  projectId,
  name: 'Finance',
  description: 'Invoices and payroll',
  role: 'ADMIN',
  gdekVersion,
  createdAt: date,
  updatedAt: date,
});

const projectKeys = {
  projectId,
  wrappedProjectRootKeyIv: 'root-iv',
  wrappedProjectRootKey: 'root-key',
  wrappedProjectRootKeyTag: 'root-tag',
  wrappedProjectEncryptionKeyIv: 'enc-iv',
  wrappedProjectEncryptionKey: 'enc-key',
  wrappedProjectEncryptionKeyTag: 'enc-tag',
  userPassphraseSalt: 'salt',
  currentKeyVersion: 1,
};

const kmsRequest = {
  WrappedProjectRootKeyIV: 'root-iv',
  WrappedProjectRootKey: 'root-key',
  WrappedProjectRootKeyTag: 'root-tag',
  WrappedProjectEncryptionKeyIV: 'enc-iv',
  WrappedProjectEncryptionKey: 'enc-key',
  WrappedProjectEncryptionKeyTag: 'enc-tag',
  UserPassphrase: PASSPHRASE,
  UserPassphraseSalt: 'salt',
};

const kmsResponse = (GroupId: string) => ({
  GroupId,
  WrappedGroupRootKeyIV: 'grk-iv',
  WrappedGroupRootKey: 'grk',
  WrappedGroupRootKeyTag: 'grk-tag',
  WrappedGroupDataEncryptionKeyIV: 'gdek-iv',
  WrappedGroupDataEncryptionKey: 'gdek',
  WrappedGroupDataEncryptionKeyTag: 'gdek-tag',
});

const storedKeys = {
  wrappedGroupRootKeyIv: 'grk-iv',
  wrappedGroupRootKey: 'grk',
  wrappedGroupRootKeyTag: 'grk-tag',
  wrappedGroupDataEncryptionKeyIv: 'gdek-iv',
  wrappedGroupDataEncryptionKey: 'gdek',
  wrappedGroupDataEncryptionKeyTag: 'gdek-tag',
};

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('failed', {
    code,
    clientVersion: 'test',
  });

describe('GroupsController', () => {
  const controller = new GroupsController();

  // Every call the controller can make as someone other than the project admin.
  const writes: [string, (user: AuthUser) => Promise<unknown>][] = [
    [
      'create',
      (user) =>
        controller.create(user, projectId, {
          name: 'Finance',
          description: 'Invoices and payroll',
          passphrase: PASSPHRASE,
        }),
    ],
    ['update', (user) => controller.update(user, projectId, groupId, {})],
    ['delete', (user) => controller.delete(user, projectId, groupId)],
    [
      'rotate',
      (user) =>
        controller.rotate(user, projectId, groupId, { passphrase: PASSPHRASE }),
    ],
    [
      'updateMember',
      (user) =>
        controller.updateMember(user, projectId, groupId, target, {
          role: 'ADMIN',
        }),
    ],
    [
      'revoke',
      (user) =>
        controller.revoke(user, projectId, groupId, target, {
          passphrase: PASSPHRASE,
        }),
    ],
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
    mocks.project.findFirst.mockResolvedValue(projectRow());
    mocks.group.findFirst.mockResolvedValue(groupRow());
    mocks.projectKeys.findUniqueOrThrow.mockResolvedValue(projectKeys);
    mocks.groupMember.findUnique.mockResolvedValue({ userId: target });
    mocks.kmsCall.mockImplementation((_method, request: { GroupId: string }) =>
      Promise.resolve(kmsResponse(request.GroupId)),
    );
  });

  describe('access', () => {
    it.each(writes)('%s gives a project member 403', async (_name, call) => {
      await expect(call(member)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.kmsCall).not.toHaveBeenCalled();
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it.each(writes)('%s gives a non-member 404', async (_name, call) => {
      mocks.project.findFirst.mockResolvedValue(null);

      await expect(call(member)).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });

    it('answers 404 for a group that is deleted or in another project', async () => {
      mocks.group.findFirst.mockResolvedValue(null);

      await expect(
        controller.rotate(admin, projectId, groupId, {
          passphrase: PASSPHRASE,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.group.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: groupId, projectId, deletedAt: null },
        }),
      );
    });
  });

  describe('create', () => {
    const dto = {
      name: 'Finance',
      description: 'Invoices and payroll',
      passphrase: PASSPHRASE,
    };

    it('stores the wrapped pair as version 1 with the admin as a group admin', async () => {
      mocks.group.create.mockResolvedValue(groupRow());

      await expect(controller.create(admin, projectId, dto)).resolves.toEqual(
        groupResponse(1),
      );

      const { data } = mocks.group.create.mock.calls[0][0] as {
        data: { id: string };
      };
      expect(data).toEqual({
        id: expect.any(String),
        projectId,
        name: 'Finance',
        description: 'Invoices and payroll',
        keys: { create: { ...storedKeys, currentGdekVersion: 1 } },
        keyVersions: { create: { gdekVersion: 1 } },
        members: { create: { userId: admin.id, role: 'ADMIN' } },
      });
      expect(mocks.kmsCall).toHaveBeenCalledWith(
        'createAndWrapNewGroupRootKeyAndGroupDataEncryptionKey',
        { ...kmsRequest, GroupId: data.id },
      );
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'group.created',
          projectId,
          metadata: { groupId: data.id },
        },
      });
      expect(JSON.stringify(mocks.group.create.mock.calls)).not.toContain(
        PASSPHRASE,
      );
      expect(JSON.stringify(mocks.auditEvent.create.mock.calls)).not.toContain(
        PASSPHRASE,
      );
    });

    it('answers 409 and uses no attempt if the project is not initialised', async () => {
      mocks.project.findFirst.mockResolvedValue(projectRow(null));

      await expect(
        controller.create(admin, projectId, dto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });

    it('refuses keys returned for a different group', async () => {
      mocks.kmsCall.mockResolvedValue(kmsResponse('another-group'));

      await expect(
        controller.create(admin, projectId, dto),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
      expect(mocks.releasePassphraseAttempt).toHaveBeenCalledWith(projectId);
    });
  });

  describe('update', () => {
    it('updates only the fields sent and records them', async () => {
      mocks.group.update.mockResolvedValue({
        ...groupRow(),
        name: 'Accounts',
      });

      await expect(
        controller.update(admin, projectId, groupId, { name: 'Accounts' }),
      ).resolves.toEqual({ ...groupResponse(1), name: 'Accounts' });

      expect(mocks.group.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: groupId },
          data: { name: 'Accounts', description: undefined },
        }),
      );
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'group.updated',
          projectId,
          metadata: { groupId, changed: ['name'] },
        },
      });
    });

    it('writes nothing when no field is sent', async () => {
      await expect(
        controller.update(admin, projectId, groupId, {}),
      ).resolves.toEqual(groupResponse(1));
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('soft deletes the group', async () => {
      await controller.delete(admin, projectId, groupId);

      expect(mocks.group.update).toHaveBeenCalledWith({
        where: { id: groupId },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'group.deleted',
          projectId,
          metadata: { groupId },
        },
      });
    });
  });

  describe('rotate', () => {
    const rotate = () =>
      controller.rotate(admin, projectId, groupId, { passphrase: PASSPHRASE });

    it('overwrites the pair, bumps the version and keeps no key material on the version row', async () => {
      await expect(rotate()).resolves.toEqual(groupResponse(2));

      expect(mocks.kmsCall).toHaveBeenCalledWith(
        'createAndWrapNewGroupRootKeyAndGroupDataEncryptionKey',
        { ...kmsRequest, GroupId: groupId },
      );
      expect(mocks.groupKeyVersion.create).toHaveBeenCalledWith({
        data: { groupId, gdekVersion: 2 },
      });
      expect(mocks.groupKeys.update).toHaveBeenCalledWith({
        where: { groupId },
        data: { ...storedKeys, currentGdekVersion: 2 },
      });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'group.key_rotated',
          projectId,
          metadata: { groupId, fromVersion: 1, toVersion: 2 },
        },
      });
      expect(mocks.clearPassphraseAttempts).toHaveBeenCalledWith(projectId);
    });

    it('keeps a wrong passphrase counted and writes nothing', async () => {
      mocks.kmsCall.mockRejectedValue(new IncorrectPassphraseException());

      await expect(rotate()).rejects.toBeInstanceOf(
        IncorrectPassphraseException,
      );
      expect(mocks.reservePassphraseAttempt).toHaveBeenCalledWith(projectId);
      expect(mocks.releasePassphraseAttempt).not.toHaveBeenCalled();
      expect(mocks.clearPassphraseAttempts).not.toHaveBeenCalled();
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('gives the attempt back when the KMS is down', async () => {
      mocks.kmsCall.mockRejectedValue(new ServiceUnavailableException());

      await expect(rotate()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(mocks.releasePassphraseAttempt).toHaveBeenCalledWith(projectId);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 409 when a concurrent rotation got there first', async () => {
      mocks.$transaction.mockRejectedValue(prismaError('P2002'));

      await expect(rotate()).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.releasePassphraseAttempt).toHaveBeenCalledWith(projectId);
      expect(mocks.clearPassphraseAttempts).not.toHaveBeenCalled();
    });

    it('does not call the KMS over the attempt limit', async () => {
      mocks.reservePassphraseAttempt.mockRejectedValue(new Error('limit'));

      await expect(rotate()).rejects.toThrow('limit');
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });
  });

  describe('updateMember', () => {
    const update = (userId = target) =>
      controller.updateMember(admin, projectId, groupId, userId, {
        role: 'ADMIN',
      });

    it('changes the role and records it', async () => {
      const row = { userId: target, role: 'ADMIN', createdAt: date };
      mocks.groupMember.update.mockResolvedValue(row);

      await expect(update()).resolves.toEqual(row);

      expect(mocks.groupMember.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { groupId_userId: { groupId, userId: target } },
          data: { role: 'ADMIN' },
        }),
      );
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'group.member_role_changed',
          projectId,
          metadata: { groupId, targetUserId: target, role: 'ADMIN' },
        },
      });
    });

    it('protects the project admin', async () => {
      await expect(update(admin.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 404 for someone who is not in the group', async () => {
      mocks.$transaction.mockRejectedValue(prismaError('P2025'));

      await expect(update()).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('revoke', () => {
    const revoke = (userId = target) =>
      controller.revoke(admin, projectId, groupId, userId, {
        passphrase: PASSPHRASE,
      });

    it('removes the member and rotates in one transaction', async () => {
      await expect(revoke()).resolves.toEqual(groupResponse(2));

      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
      expect(mocks.groupMember.delete).toHaveBeenCalledWith({
        where: { groupId_userId: { groupId, userId: target } },
      });
      expect(mocks.groupKeyVersion.create).toHaveBeenCalledWith({
        data: { groupId, gdekVersion: 2 },
      });
      expect(mocks.groupKeys.update).toHaveBeenCalledWith({
        where: { groupId },
        data: { ...storedKeys, currentGdekVersion: 2 },
      });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'group.member_revoked',
          projectId,
          metadata: {
            groupId,
            targetUserId: target,
            fromVersion: 1,
            toVersion: 2,
          },
        },
      });
      expect(JSON.stringify(mocks.auditEvent.create.mock.calls)).not.toContain(
        PASSPHRASE,
      );
    });

    it('protects the project admin', async () => {
      await expect(revoke(admin.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });

    it('uses no attempt for someone who is not in the group', async () => {
      mocks.groupMember.findUnique.mockResolvedValue(null);

      await expect(revoke()).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });

    it('leaves the member in place when the KMS is down', async () => {
      mocks.kmsCall.mockRejectedValue(new ServiceUnavailableException());

      await expect(revoke()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(mocks.$transaction).not.toHaveBeenCalled();
      expect(mocks.releasePassphraseAttempt).toHaveBeenCalledWith(projectId);
    });

    it('answers 409 when it loses a race, so it can be retried', async () => {
      mocks.$transaction.mockRejectedValue(prismaError('P2002'));

      await expect(revoke()).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 404 when the member was removed meanwhile', async () => {
      mocks.$transaction.mockRejectedValue(prismaError('P2025'));

      await expect(revoke()).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
