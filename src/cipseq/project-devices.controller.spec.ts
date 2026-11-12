import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { IncorrectPassphraseException } from '../kms/incorrect-passphrase.exception.js';
import { ProjectDevicesController } from './project-devices.controller.js';

const mocks = vi.hoisted(() => ({
  reservePassphraseAttempt: vi.fn(),
  releasePassphraseAttempt: vi.fn(),
  clearPassphraseAttempts: vi.fn(),
  countMissingEnvelopes: vi.fn(),
  createFirstMissingEnvelope: vi.fn(),
  removeIneligibleEnvelopes: vi.fn(),
  startEnvelopeJob: vi.fn(),
  wrapEnvelope: vi.fn(),
  $transaction: vi.fn(),
  project: { findFirst: vi.fn() },
  group: { findFirst: vi.fn() },
  groupMember: { findFirst: vi.fn() },
  groupDevice: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  deviceEnvelope: { create: vi.fn(), updateMany: vi.fn() },
  envelopeJob: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  auditEvent: { create: vi.fn() },
}));

vi.mock('./passphrase-attempts.js', () => ({
  reservePassphraseAttempt: mocks.reservePassphraseAttempt,
  releasePassphraseAttempt: mocks.releasePassphraseAttempt,
  clearPassphraseAttempts: mocks.clearPassphraseAttempts,
}));
vi.mock('./device-envelopes.js', () => ({
  countMissingEnvelopes: mocks.countMissingEnvelopes,
  createFirstMissingEnvelope: mocks.createFirstMissingEnvelope,
  removeIneligibleEnvelopes: mocks.removeIneligibleEnvelopes,
  startEnvelopeJob: mocks.startEnvelopeJob,
  wrapEnvelope: mocks.wrapEnvelope,
}));
vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: {
    $transaction: mocks.$transaction,
    project: mocks.project,
    group: mocks.group,
    groupMember: mocks.groupMember,
    groupDevice: mocks.groupDevice,
    deviceEnvelope: mocks.deviceEnvelope,
    envelopeJob: mocks.envelopeJob,
    auditEvent: mocks.auditEvent,
  },
}));

const PASSPHRASE = 'correct horse battery staple';
const projectId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const groupId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const deviceId = 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const date = new Date('2026-11-06T06:36:46.000Z');
const admin = { id: 'admin-1' } as AuthUser;
const acting = { id: 'acting-1' } as AuthUser;
const owner = 'device-user';
const device = { id: deviceId, publicKey: 'public-key' };
const envelope = {
  groupId,
  deviceId,
  envelopeVersion: 2,
  envelopeJson: '{"signed":true}',
};

const projectRow = {
  id: projectId,
  name: 'Payments',
  description: 'Card and invoice data',
  adminUserId: admin.id,
  createdAt: date,
  updatedAt: date,
  keys: { currentKeyVersion: 1 },
};

const groupRow = (role?: string) => ({
  id: groupId,
  projectId,
  name: 'Finance',
  description: 'Invoices and payroll',
  createdAt: date,
  updatedAt: date,
  keys: { currentGdekVersion: 2 },
  members: role ? [{ role }] : [],
});

describe('ProjectDevicesController', () => {
  const controller = new ProjectDevicesController();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
    mocks.project.findFirst.mockResolvedValue(projectRow);
    mocks.group.findFirst.mockResolvedValue(groupRow());
    mocks.groupDevice.findMany.mockResolvedValue([
      { groupId, device },
      { groupId: 'group-2', device },
    ]);
    mocks.groupDevice.updateMany.mockResolvedValue({ count: 2 });
    mocks.wrapEnvelope.mockResolvedValue(envelope);
    mocks.countMissingEnvelopes.mockResolvedValue(1);
  });

  describe('approve', () => {
    const approve = (user = admin) =>
      controller.approve(user, projectId, deviceId, { passphrase: PASSPHRASE });

    it('approves all waiting groups with the first envelope, then starts the job', async () => {
      await expect(approve()).resolves.toEqual({ envelopesToCreate: 1 });

      expect(mocks.wrapEnvelope).toHaveBeenCalledWith(
        projectId,
        groupId,
        device,
        PASSPHRASE,
      );
      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
      expect(mocks.groupDevice.updateMany).toHaveBeenCalledWith({
        where: {
          deviceId,
          status: 'PENDING_APPROVAL',
          group: { projectId, deletedAt: null },
          groupId: { in: [groupId, 'group-2'] },
        },
        data: {
          status: 'APPROVED',
          reviewedByUserId: admin.id,
          reviewedAt: expect.any(Date),
        },
      });
      expect(mocks.deviceEnvelope.create).toHaveBeenCalledWith({
        data: envelope,
      });
      expect(mocks.removeIneligibleEnvelopes).toHaveBeenCalledWith(groupId, [
        deviceId,
      ]);
      expect(mocks.startEnvelopeJob).toHaveBeenCalledWith(
        admin.id,
        projectId,
        [groupId, 'group-2'],
        PASSPHRASE,
        'APPROVAL',
      );
      expect(JSON.stringify(mocks.auditEvent.create.mock.calls)).not.toContain(
        PASSPHRASE,
      );
      expect(mocks.clearPassphraseAttempts).toHaveBeenCalledWith(projectId);
    });

    it('keeps a wrong passphrase counted and changes nothing', async () => {
      mocks.wrapEnvelope.mockRejectedValue(new IncorrectPassphraseException());

      await expect(approve()).rejects.toBeInstanceOf(
        IncorrectPassphraseException,
      );
      expect(mocks.reservePassphraseAttempt).toHaveBeenCalledWith(projectId);
      expect(mocks.releasePassphraseAttempt).not.toHaveBeenCalled();
      expect(mocks.$transaction).not.toHaveBeenCalled();
      expect(mocks.startEnvelopeJob).not.toHaveBeenCalled();
    });

    it('gives the attempt back when the KMS is down', async () => {
      mocks.wrapEnvelope.mockRejectedValue(new ServiceUnavailableException());

      await expect(approve()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(mocks.releasePassphraseAttempt).toHaveBeenCalledWith(projectId);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 404 and uses no attempt with nothing waiting', async () => {
      mocks.groupDevice.findMany.mockResolvedValue([]);

      await expect(approve()).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });

    it('answers 409 and removes the envelope if it was handled meanwhile', async () => {
      mocks.groupDevice.updateMany.mockResolvedValue({ count: 0 });

      await expect(approve()).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.removeIneligibleEnvelopes).toHaveBeenCalled();
      expect(mocks.startEnvelopeJob).not.toHaveBeenCalled();
    });

    it('gives an acting admin 403 and uses no attempt', async () => {
      await expect(approve(acting)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('closes the waiting groups without a KMS call', async () => {
      await controller.reject(admin, projectId, deviceId);

      expect(mocks.groupDevice.updateMany).toHaveBeenCalledWith({
        where: {
          deviceId,
          status: 'PENDING_APPROVAL',
          group: { projectId, deletedAt: null },
        },
        data: {
          status: 'REJECTED',
          reviewedByUserId: admin.id,
          reviewedAt: expect.any(Date),
        },
      });
      expect(mocks.wrapEnvelope).not.toHaveBeenCalled();
    });

    it('answers 404 with nothing waiting', async () => {
      mocks.groupDevice.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        controller.reject(admin, projectId, deviceId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('gives an acting admin 403', async () => {
      await expect(
        controller.reject(acting, projectId, deviceId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('revokeFromProject', () => {
    it('soft deletes every envelope in the project, with no key change', async () => {
      mocks.groupDevice.findFirst.mockResolvedValue({ id: 'row' });

      await controller.revokeFromProject(admin, projectId, deviceId);

      expect(mocks.deviceEnvelope.updateMany).toHaveBeenCalledWith({
        where: { deviceId, group: { projectId }, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });

    it('is only for the project admin, not an acting admin', async () => {
      await expect(
        controller.revokeFromProject(acting, projectId, deviceId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 404 for a device with no open approval here', async () => {
      mocks.groupDevice.findFirst.mockResolvedValue(null);

      await expect(
        controller.revokeFromProject(admin, projectId, deviceId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('revokeFromGroup', () => {
    const revoke = (user: AuthUser) =>
      controller.revokeFromGroup(user, projectId, groupId, deviceId);

    beforeEach(() => {
      mocks.groupDevice.findFirst.mockResolvedValue({
        device: { userId: owner },
      });
    });

    it("soft deletes only that group's envelopes", async () => {
      await revoke(admin);

      expect(mocks.groupDevice.updateMany).toHaveBeenCalledWith({
        where: {
          deviceId,
          groupId,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
        data: {
          status: 'REVOKED',
          revokedByUserId: admin.id,
          revokedAt: expect.any(Date),
        },
      });
      expect(mocks.deviceEnvelope.updateMany).toHaveBeenCalledWith({
        where: { deviceId, groupId, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'device.revoked',
          projectId,
          metadata: { deviceId, groupId },
        },
      });
    });

    it("lets the group's acting admin revoke at once", async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ACTING_ADMIN'));

      await revoke(acting);

      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    });

    it('lets the project admin revoke their own device', async () => {
      mocks.groupDevice.findFirst.mockResolvedValue({
        device: { userId: admin.id },
      });

      await revoke(admin);

      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    });

    it("refuses an acting admin on the project admin's or their own device", async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('ACTING_ADMIN'));

      for (const userId of [admin.id, acting.id]) {
        mocks.groupDevice.findFirst.mockResolvedValue({ device: { userId } });
        await expect(revoke(acting)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('gives a plain member 403 and someone outside the group 404', async () => {
      mocks.group.findFirst.mockResolvedValue(groupRow('MEMBER'));
      await expect(revoke(acting)).rejects.toBeInstanceOf(ForbiddenException);

      mocks.group.findFirst.mockResolvedValue(groupRow());
      await expect(revoke(acting)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for a device with no open approval in the group', async () => {
      mocks.groupDevice.findFirst.mockResolvedValue(null);

      await expect(revoke(admin)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('renew', () => {
    const renew = (user = admin) =>
      controller.renew(user, projectId, groupId, { passphrase: PASSPHRASE });

    it('creates the first envelope in the request, then starts the job', async () => {
      mocks.countMissingEnvelopes
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2);
      mocks.createFirstMissingEnvelope.mockResolvedValue(true);

      await expect(renew()).resolves.toEqual({ envelopesToCreate: 2 });

      expect(mocks.createFirstMissingEnvelope).toHaveBeenCalledWith(
        admin.id,
        projectId,
        groupId,
        PASSPHRASE,
      );
      expect(mocks.startEnvelopeJob).toHaveBeenCalledWith(
        admin.id,
        projectId,
        [groupId],
        PASSPHRASE,
        'RENEWAL',
      );
    });

    it('refuses while a job is running and uses no attempt', async () => {
      mocks.countMissingEnvelopes.mockResolvedValue(3);
      mocks.envelopeJob.findUnique.mockResolvedValue({
        status: 'RUNNING',
        lastActiveAt: new Date(),
      });

      await expect(renew()).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
    });

    it('resumes a job that stopped updating', async () => {
      mocks.countMissingEnvelopes
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2);
      mocks.createFirstMissingEnvelope.mockResolvedValue(true);
      mocks.envelopeJob.findUnique.mockResolvedValue({
        status: 'RUNNING',
        lastActiveAt: new Date(Date.now() - 3 * 60 * 1000),
      });

      await expect(renew()).resolves.toEqual({ envelopesToCreate: 2 });
    });

    it('uses no attempt with nothing missing', async () => {
      mocks.countMissingEnvelopes.mockResolvedValue(0);

      await expect(renew()).resolves.toEqual({ envelopesToCreate: 0 });
      expect(mocks.reservePassphraseAttempt).not.toHaveBeenCalled();
      expect(mocks.startEnvelopeJob).not.toHaveBeenCalled();
    });

    it('keeps a wrong passphrase counted and starts no job', async () => {
      mocks.createFirstMissingEnvelope.mockRejectedValue(
        new IncorrectPassphraseException(),
      );

      await expect(renew()).rejects.toBeInstanceOf(
        IncorrectPassphraseException,
      );
      expect(mocks.releasePassphraseAttempt).not.toHaveBeenCalled();
      expect(mocks.startEnvelopeJob).not.toHaveBeenCalled();
    });

    it('gives an acting admin 403', async () => {
      await expect(renew(acting)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('dismissCompleted', () => {
    const dismiss = (user = admin) =>
      controller.dismissCompleted(user, projectId, groupId);

    it('dismisses a completed job and records it', async () => {
      mocks.envelopeJob.findFirst.mockResolvedValue({ gdekVersion: 2 });

      await dismiss();

      expect(mocks.envelopeJob.updateMany).toHaveBeenCalledWith({
        where: { groupId, status: 'COMPLETED', dismissedAt: null },
        data: { dismissedAt: expect.any(Date) },
      });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: admin.id,
          action: 'device.envelope_job_dismissed',
          projectId,
          metadata: { groupId, gdekVersion: 2 },
        },
      });
    });

    it('changes nothing if there is nothing to dismiss', async () => {
      mocks.envelopeJob.findFirst.mockResolvedValue(null);

      await expect(dismiss()).resolves.toBeUndefined();
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('gives an acting admin 403', async () => {
      await expect(dismiss(acting)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
