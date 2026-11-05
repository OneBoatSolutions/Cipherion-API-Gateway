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
import { ProjectsController } from './projects.controller.js';

const mocks = vi.hoisted(() => ({
  kmsCall: vi.fn(),
  reservePassphraseAttempt: vi.fn(),
  releasePassphraseAttempt: vi.fn(),
  clearPassphraseAttempts: vi.fn(),
  $transaction: vi.fn(),
  project: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  projectKeys: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  projectKeyVersion: { create: vi.fn() },
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
    projectKeyVersion: mocks.projectKeyVersion,
    auditEvent: mocks.auditEvent,
  },
}));

const PASSPHRASE = 'correct horse battery staple';
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const date = new Date('2026-11-04T06:36:46.000Z');
const admin = { id: 'admin-1' } as AuthUser;
const member = { id: 'member-1' } as AuthUser;

const DESCRIPTION = 'Card and invoice data';

const row = (currentKeyVersion: number | null = null) => ({
  id,
  name: 'Payments',
  description: DESCRIPTION,
  adminUserId: admin.id,
  createdAt: date,
  updatedAt: date,
  keys: { currentKeyVersion },
});

const rootKey = {
  wrappedProjectRootKeyIv: 'root-iv',
  wrappedProjectRootKey: 'root-key',
  wrappedProjectRootKeyTag: 'root-tag',
};

const encryptionKeyResponse = {
  ProjectId: id,
  WrappedProjectEncryptionKeyIV: 'enc-iv',
  WrappedProjectEncryptionKey: 'enc-key',
  WrappedProjectEncryptionKeyTag: 'enc-tag',
  UserPassphraseSalt: 'salt',
};

describe('ProjectsController', () => {
  const controller = new ProjectsController();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
  });

  describe('create', () => {
    const kmsResponse = (ProjectId: string) => ({
      ProjectId,
      WrappedProjectRootKeyIV: 'root-iv',
      WrappedProjectRootKey: 'root-key',
      WrappedProjectRootKeyTag: 'root-tag',
    });

    it('stores the wrapped root key and makes the caller the admin', async () => {
      mocks.kmsCall.mockImplementation(
        (_method, request: { ProjectId: string }) =>
          Promise.resolve(kmsResponse(request.ProjectId)),
      );
      mocks.project.create.mockResolvedValue(row());

      await expect(
        controller.create(admin, {
          name: 'Payments',
          description: DESCRIPTION,
        }),
      ).resolves.toEqual({
        id,
        name: 'Payments',
        description: DESCRIPTION,
        role: 'ADMIN',
        keyVersion: null,
        createdAt: date,
        updatedAt: date,
      });

      const { data } = mocks.project.create.mock.calls[0][0] as {
        data: { id: string };
      };
      expect(data).toEqual({
        id: expect.any(String),
        name: 'Payments',
        description: DESCRIPTION,
        adminUserId: admin.id,
        keys: { create: rootKey },
        members: { create: { userId: admin.id } },
      });
      expect(mocks.kmsCall).toHaveBeenCalledWith(
        'createAndWrapNewProjectRootKey',
        { ProjectId: data.id },
      );
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'project.created',
          projectId: data.id,
          metadata: undefined,
        },
      });
    });

    it('stores nothing when the KMS fails', async () => {
      mocks.kmsCall.mockRejectedValue(new ServiceUnavailableException());

      await expect(
        controller.create(admin, {
          name: 'Payments',
          description: DESCRIPTION,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('stores nothing when the KMS answers for another project', async () => {
      mocks.kmsCall.mockResolvedValue(kmsResponse('another-project'));

      await expect(
        controller.create(admin, {
          name: 'Payments',
          description: DESCRIPTION,
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('initialize', () => {
    beforeEach(() => {
      mocks.project.findFirst.mockResolvedValue(row());
      mocks.projectKeys.findUniqueOrThrow.mockResolvedValue(rootKey);
      mocks.kmsCall.mockResolvedValue(encryptionKeyResponse);
    });

    it('stores the wrapped key and salt, and records version 1 without them', async () => {
      await expect(
        controller.initialize(admin, id, { passphrase: PASSPHRASE }),
      ).resolves.toMatchObject({ id, role: 'ADMIN', keyVersion: 1 });

      expect(mocks.kmsCall).toHaveBeenCalledWith(
        'createAndWrapNewProjectEncryptionKey',
        {
          ProjectId: id,
          WrappedProjectRootKeyIV: 'root-iv',
          WrappedProjectRootKey: 'root-key',
          WrappedProjectRootKeyTag: 'root-tag',
          UserPassphrase: PASSPHRASE,
        },
      );

      const encryptionKey = {
        wrappedProjectEncryptionKeyIv: 'enc-iv',
        wrappedProjectEncryptionKey: 'enc-key',
        wrappedProjectEncryptionKeyTag: 'enc-tag',
        userPassphraseSalt: 'salt',
      };
      expect(mocks.projectKeyVersion.create).toHaveBeenCalledWith({
        data: { projectId: id, version: 1 },
      });
      expect(mocks.projectKeys.update).toHaveBeenCalledWith({
        where: { projectId: id },
        data: { ...encryptionKey, currentKeyVersion: 1 },
      });
    });

    it('never writes the passphrase to the database', async () => {
      await controller.initialize(admin, id, { passphrase: PASSPHRASE });

      const written = JSON.stringify([
        mocks.projectKeyVersion.create.mock.calls,
        mocks.projectKeys.update.mock.calls,
        mocks.auditEvent.create.mock.calls,
      ]);
      expect(written).not.toContain(PASSPHRASE);
    });

    it('answers 409 without calling the KMS when already initialised', async () => {
      mocks.project.findFirst.mockResolvedValue(row(1));

      await expect(
        controller.initialize(admin, id, { passphrase: PASSPHRASE }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });

    it('answers 409 when a concurrent request saved version 1 first', async () => {
      mocks.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        controller.initialize(admin, id, { passphrase: PASSPHRASE }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows other database errors', async () => {
      const error = new Error('connection lost');
      mocks.$transaction.mockRejectedValue(error);

      await expect(
        controller.initialize(admin, id, { passphrase: PASSPHRASE }),
      ).rejects.toBe(error);
    });

    it('stores nothing when the KMS answers for another project', async () => {
      mocks.kmsCall.mockResolvedValue({
        ...encryptionKeyResponse,
        ProjectId: 'another-project',
      });

      await expect(
        controller.initialize(admin, id, { passphrase: PASSPHRASE }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 403 to a member who is not the admin', async () => {
      await expect(
        controller.initialize(member, id, { passphrase: PASSPHRASE }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });
  });

  describe('rotate', () => {
    const NEW_PASSPHRASE = 'a brand new passphrase';
    const passphrases = {
      currentPassphrase: PASSPHRASE,
      newPassphrase: NEW_PASSPHRASE,
    };
    const currentKeys = {
      ...rootKey,
      wrappedProjectEncryptionKeyIv: 'enc-iv',
      wrappedProjectEncryptionKey: 'enc-key',
      wrappedProjectEncryptionKeyTag: 'enc-tag',
      userPassphraseSalt: 'salt',
      currentKeyVersion: 1,
    };
    const rotated = {
      ProjectId: id,
      NewWrappedProjectEncryptionKeyIV: 'new-iv',
      NewWrappedProjectEncryptionKey: 'new-key',
      NewWrappedProjectEncryptionKeyTag: 'new-tag',
      NewUserPassphraseSalt: 'new-salt',
    };

    beforeEach(() => {
      mocks.project.findFirst.mockResolvedValue(row(1));
      mocks.projectKeys.findUniqueOrThrow.mockResolvedValue(currentKeys);
      mocks.kmsCall.mockResolvedValue(rotated);
    });

    it('stores the new wrapped key and salt, and bumps the version', async () => {
      await expect(
        controller.rotate(admin, id, passphrases),
      ).resolves.toMatchObject({ id, role: 'ADMIN', keyVersion: 2 });

      expect(mocks.kmsCall).toHaveBeenCalledWith(
        'rotateWrappingKeyforProjectEncryptionKey',
        {
          ProjectId: id,
          CurrentUserPassphrase: PASSPHRASE,
          CurrentUserPassphraseSalt: 'salt',
          NewUserPassphrase: NEW_PASSPHRASE,
          CurrentWrappedProjectRootKeyIV: 'root-iv',
          CurrentWrappedProjectRootKey: 'root-key',
          CurrentWrappedProjectRootKeyTag: 'root-tag',
          CurrentWrappedProjectEncryptionKeyIV: 'enc-iv',
          CurrentWrappedProjectEncryptionKey: 'enc-key',
          CurrentWrappedProjectEncryptionKeyTag: 'enc-tag',
        },
      );
      expect(mocks.projectKeys.update).toHaveBeenCalledWith({
        where: { projectId: id },
        data: {
          wrappedProjectEncryptionKeyIv: 'new-iv',
          wrappedProjectEncryptionKey: 'new-key',
          wrappedProjectEncryptionKeyTag: 'new-tag',
          userPassphraseSalt: 'new-salt',
          currentKeyVersion: 2,
        },
      });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'project.key_rotated',
          projectId: id,
          metadata: { fromVersion: 1, toVersion: 2 },
        },
      });
    });

    it('records the new version without any key material', async () => {
      await controller.rotate(admin, id, passphrases);

      expect(mocks.projectKeyVersion.create).toHaveBeenCalledWith({
        data: { projectId: id, version: 2 },
      });
    });

    it('never writes either passphrase to the database', async () => {
      await controller.rotate(admin, id, passphrases);

      const written = JSON.stringify([
        mocks.projectKeyVersion.create.mock.calls,
        mocks.projectKeys.update.mock.calls,
        mocks.auditEvent.create.mock.calls,
      ]);
      expect(written).not.toContain(PASSPHRASE);
      expect(written).not.toContain(NEW_PASSPHRASE);
    });

    it('reserves an attempt before the KMS call and clears them on success', async () => {
      await controller.rotate(admin, id, passphrases);

      expect(
        mocks.reservePassphraseAttempt.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.kmsCall.mock.invocationCallOrder[0]);
      expect(mocks.clearPassphraseAttempts).toHaveBeenCalledWith(id);
      expect(mocks.releasePassphraseAttempt).not.toHaveBeenCalled();
    });

    it('keeps a wrong passphrase counted and stores nothing', async () => {
      mocks.kmsCall.mockRejectedValue(new IncorrectPassphraseException());

      await expect(
        controller.rotate(admin, id, passphrases),
      ).rejects.toBeInstanceOf(IncorrectPassphraseException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
      expect(mocks.releasePassphraseAttempt).not.toHaveBeenCalled();
      expect(mocks.clearPassphraseAttempts).not.toHaveBeenCalled();
    });

    it("doesn't call the KMS once the attempt limit is reached", async () => {
      const tooMany = new Error('too many');
      mocks.reservePassphraseAttempt.mockRejectedValue(tooMany);

      await expect(controller.rotate(admin, id, passphrases)).rejects.toBe(
        tooMany,
      );
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });

    it('gives the attempt back when the KMS is down', async () => {
      mocks.kmsCall.mockRejectedValue(new ServiceUnavailableException());

      await expect(
        controller.rotate(admin, id, passphrases),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mocks.releasePassphraseAttempt).toHaveBeenCalledWith(id);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 409 and gives the attempt back when a concurrent rotation won', async () => {
      mocks.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        controller.rotate(admin, id, passphrases),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.releasePassphraseAttempt).toHaveBeenCalledWith(id);
    });

    it('stores nothing when the KMS answers for another project', async () => {
      mocks.kmsCall.mockResolvedValue({
        ...rotated,
        ProjectId: 'another-project',
      });

      await expect(
        controller.rotate(admin, id, passphrases),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 409 without an attempt when the project is not initialised', async () => {
      mocks.project.findFirst.mockResolvedValue(row(null));

      await expect(
        controller.rotate(admin, id, passphrases),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });

    it('answers 400 without an attempt when the passphrase is unchanged', async () => {
      await expect(
        controller.rotate(admin, id, {
          currentPassphrase: PASSPHRASE,
          newPassphrase: PASSPHRASE,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });

    it('answers 403 to a member who is not the admin', async () => {
      await expect(
        controller.rotate(member, id, passphrases),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it("returns the caller's projects without key material", async () => {
      mocks.project.findMany.mockResolvedValue([row(1)]);

      await expect(controller.list(member)).resolves.toEqual([
        {
          id,
          name: 'Payments',
          description: DESCRIPTION,
          role: 'MEMBER',
          keyVersion: 1,
          createdAt: date,
          updatedAt: date,
        },
      ]);
      expect(mocks.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, members: { some: { userId: member.id } } },
        }),
      );
    });
  });

  describe('get', () => {
    it('answers 404 to a non-member or for a deleted project', async () => {
      mocks.project.findFirst.mockResolvedValue(null);

      await expect(controller.get(member, id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.project.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id,
            deletedAt: null,
            members: { some: { userId: member.id } },
          },
        }),
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      mocks.project.findFirst.mockResolvedValue(row());
    });

    it('renames the project and records the changed field', async () => {
      mocks.project.update.mockResolvedValue({ ...row(), name: 'Billing' });

      await expect(
        controller.update(admin, id, { name: 'Billing' }),
      ).resolves.toMatchObject({ name: 'Billing' });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'project.updated',
          projectId: id,
          metadata: { changed: ['name'] },
        },
      });
    });

    it('updates the description and records only that field', async () => {
      mocks.project.update.mockResolvedValue({
        ...row(),
        description: 'Updated',
      });

      await expect(
        controller.update(admin, id, { description: 'Updated' }),
      ).resolves.toMatchObject({ name: 'Payments', description: 'Updated' });
      expect(mocks.project.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { name: undefined, description: 'Updated' },
        }),
      );
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: { changed: ['description'] },
        }),
      });
    });

    it('records both fields when both change', async () => {
      mocks.project.update.mockResolvedValue(row());

      await controller.update(admin, id, {
        name: 'Billing',
        description: 'Updated',
      });

      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: { changed: ['name', 'description'] },
        }),
      });
    });

    it('changes and records nothing for an empty body', async () => {
      await expect(controller.update(admin, id, {})).resolves.toMatchObject({
        name: 'Payments',
      });
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 403 to a member who is not the admin', async () => {
      await expect(
        controller.update(member, id, { name: 'Billing' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      mocks.project.findFirst.mockResolvedValue(row(1));
    });

    it('soft-deletes the project and keeps its keys', async () => {
      await controller.delete(admin, id);

      expect(mocks.project.update).toHaveBeenCalledWith({
        where: { id },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'project.deleted',
          projectId: id,
          metadata: undefined,
        },
      });
    });

    it('answers 403 to a member who is not the admin', async () => {
      await expect(controller.delete(member, id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });
  });
});
