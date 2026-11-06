import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { Prisma } from '../generated/cipseq/client.js';
import { IncorrectPassphraseException } from '../kms/incorrect-passphrase.exception.js';
import { RemovalRequestsController } from './removal-requests.controller.js';

const mocks = vi.hoisted(() => ({
  kmsCall: vi.fn(),
  reservePassphraseAttempt: vi.fn(),
  releasePassphraseAttempt: vi.fn(),
  clearPassphraseAttempts: vi.fn(),
  $transaction: vi.fn(),
  project: { findFirst: vi.fn() },
  projectKeys: { findUniqueOrThrow: vi.fn() },
  group: { findFirst: vi.fn() },
  groupKeys: { update: vi.fn() },
  groupKeyVersion: { create: vi.fn() },
  groupMember: { delete: vi.fn(), findUnique: vi.fn() },
  groupMemberRemovalRequest: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
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
    groupMemberRemovalRequest: mocks.groupMemberRemovalRequest,
    auditEvent: mocks.auditEvent,
  },
}));

const PASSPHRASE = 'correct horse battery staple';
const projectId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const groupId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const id = '3d6f0a51-3f0e-4d3e-9a3a-0f4f6f6d9b11';
const date = new Date('2026-11-05T06:36:46.000Z');
const admin = { id: 'admin-1' } as AuthUser;
const acting = { id: 'acting-1' } as AuthUser;
const member = { id: 'member-1' } as AuthUser;
const target = 'target-1';

const requestRow = (status = 'PENDING_APPROVAL') => ({
  id,
  groupId,
  targetUserId: target,
  status,
  requestedByUserId: acting.id,
  createdAt: date,
});

const groupRow = (role: string | null) => ({
  id: groupId,
  projectId,
  name: 'Finance',
  description: 'Invoices and payroll',
  createdAt: date,
  updatedAt: date,
  keys: { currentGdekVersion: 1 },
  members: role ? [{ role }] : [],
});

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('failed', {
    code,
    clientVersion: 'test',
  });

describe('RemovalRequestsController', () => {
  const controller = new RemovalRequestsController();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
    mocks.project.findFirst.mockResolvedValue({
      id: projectId,
      name: 'Payments',
      description: 'Card and invoice data',
      adminUserId: admin.id,
      createdAt: date,
      updatedAt: date,
      keys: { currentKeyVersion: 1 },
    });
    mocks.group.findFirst.mockResolvedValue(groupRow('ADMIN'));
    mocks.groupMember.findUnique.mockResolvedValue({ userId: target });
    mocks.groupMemberRemovalRequest.findFirst.mockResolvedValue(requestRow());
    mocks.projectKeys.findUniqueOrThrow.mockResolvedValue({
      projectId,
      wrappedProjectRootKeyIv: 'root-iv',
      wrappedProjectRootKey: 'root-key',
      wrappedProjectRootKeyTag: 'root-tag',
      wrappedProjectEncryptionKeyIv: 'enc-iv',
      wrappedProjectEncryptionKey: 'enc-key',
      wrappedProjectEncryptionKeyTag: 'enc-tag',
      userPassphraseSalt: 'salt',
      currentKeyVersion: 1,
    });
    mocks.kmsCall.mockImplementation((_method, request: { GroupId: string }) =>
      Promise.resolve({
        GroupId: request.GroupId,
        WrappedGroupRootKeyIV: 'grk-iv',
        WrappedGroupRootKey: 'grk',
        WrappedGroupRootKeyTag: 'grk-tag',
        WrappedGroupDataEncryptionKeyIV: 'gdek-iv',
        WrappedGroupDataEncryptionKey: 'gdek',
        WrappedGroupDataEncryptionKeyTag: 'gdek-tag',
      }),
    );
  });

  describe('create', () => {
    const create = (user: AuthUser, userId = target) =>
      controller.create(user, projectId, groupId, { userId });

    it('stores a pending request for an acting admin, and leaves the member', async () => {
      mocks.groupMemberRemovalRequest.create.mockResolvedValue(requestRow());

      await expect(create(acting)).resolves.toMatchObject({
        projectId,
        targetUserId: target,
        status: 'PENDING_APPROVAL',
      });

      expect(mocks.groupMember.delete).not.toHaveBeenCalled();
      expect(mocks.kmsCall).not.toHaveBeenCalled();
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: acting.id,
          action: 'removal_request.created',
          projectId,
          metadata: {
            groupId,
            requestId: expect.any(String),
            targetUserId: target,
          },
        },
      });
      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    });

    it('sends the project admin to the direct revoke', async () => {
      await expect(create(admin)).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['the project admin', admin.id],
      ['the caller', acting.id],
    ])('refuses to target %s', async (_name, userId) => {
      await expect(create(acting, userId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('gives a plain member 403 and someone outside the group 404', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('MEMBER'));
      await expect(create(member)).rejects.toBeInstanceOf(ForbiddenException);

      mocks.group.findFirst.mockResolvedValue(groupRow(null));
      await expect(create(member)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for someone not in the group', async () => {
      mocks.groupMember.findUnique.mockResolvedValue(null);

      await expect(create(acting)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 409 when a request is already pending', async () => {
      mocks.groupMemberRemovalRequest.create.mockRejectedValue(
        prismaError('P2002'),
      );

      await expect(create(acting)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('approve', () => {
    const approve = (user = admin) =>
      controller.approve(user, projectId, groupId, id, {
        passphrase: PASSPHRASE,
      });

    it('revokes the member, rotates and approves in one transaction', async () => {
      await expect(approve()).resolves.toMatchObject({ gdekVersion: 2 });

      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
      expect(mocks.groupMember.delete).toHaveBeenCalledWith({
        where: { groupId_userId: { groupId, userId: target } },
      });
      expect(mocks.groupKeyVersion.create).toHaveBeenCalledWith({
        data: { groupId, gdekVersion: 2 },
      });
      expect(mocks.groupMemberRemovalRequest.update).toHaveBeenCalledWith({
        where: { id, status: 'PENDING_APPROVAL' },
        data: {
          status: 'APPROVED',
          reviewedByUserId: admin.id,
          reviewedAt: expect.any(Date),
        },
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
            requestId: id,
          },
        },
      });
      expect(JSON.stringify(mocks.auditEvent.create.mock.calls)).not.toContain(
        PASSPHRASE,
      );
    });

    it('only lets the project admin approve', async () => {
      await expect(approve(acting)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.kmsCall).not.toHaveBeenCalled();
    });

    it('uses no attempt on a request that was already handled', async () => {
      mocks.groupMemberRemovalRequest.findFirst.mockResolvedValue(
        requestRow('REJECTED'),
      );

      await expect(approve()).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });

    it('keeps a wrong passphrase counted and changes nothing', async () => {
      mocks.kmsCall.mockRejectedValue(new IncorrectPassphraseException());

      await expect(approve()).rejects.toBeInstanceOf(
        IncorrectPassphraseException,
      );
      expect(mocks.releasePassphraseAttempt).not.toHaveBeenCalled();
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('gives the attempt back when the KMS is down', async () => {
      mocks.kmsCall.mockRejectedValue(new ServiceUnavailableException());

      await expect(approve()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(mocks.releasePassphraseAttempt).toHaveBeenCalledWith(projectId);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it.each(['P2002', 'P2025'])(
      'answers 409 when a %s race loses',
      async (code) => {
        mocks.$transaction.mockRejectedValue(prismaError(code));

        await expect(approve()).rejects.toBeInstanceOf(ConflictException);
      },
    );
  });

  describe('reject and cancel', () => {
    it('rejects, leaving the member in the group', async () => {
      mocks.groupMemberRemovalRequest.update.mockResolvedValue(
        requestRow('REJECTED'),
      );

      await expect(
        controller.reject(admin, projectId, groupId, id),
      ).resolves.toMatchObject({ status: 'REJECTED' });
      expect(mocks.groupMember.delete).not.toHaveBeenCalled();
    });

    it('only lets the project admin reject', async () => {
      await expect(
        controller.reject(acting, projectId, groupId, id),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets the requester cancel, even after losing the acting admin role', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('MEMBER'));
      mocks.groupMemberRemovalRequest.update.mockResolvedValue(
        requestRow('CANCELLED'),
      );

      await expect(
        controller.cancel(acting, projectId, groupId, id),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
    });

    it('refuses to let another member cancel', async () => {
      await expect(
        controller.cancel(member, projectId, groupId, id),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('answers 409 when it was already handled', async () => {
      mocks.$transaction.mockRejectedValue(prismaError('P2025'));

      await expect(
        controller.reject(admin, projectId, groupId, id),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 404 for a request in another group', async () => {
      mocks.groupMemberRemovalRequest.findFirst.mockResolvedValue(null);

      await expect(
        controller.reject(admin, projectId, groupId, id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
