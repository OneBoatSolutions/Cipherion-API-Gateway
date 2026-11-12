import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { Prisma } from '../generated/cipseq/client.js';
import { DevicesController } from './devices.controller.js';

const mocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
  deviceCertificate: { updateMany: vi.fn() },
  device: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  groupMember: { findFirst: vi.fn(), findMany: vi.fn() },
  groupDevice: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  deviceEnvelope: { updateMany: vi.fn() },
  auditEvent: { create: vi.fn() },
}));

const plan = vi.hoisted(() => ({ assertDeviceAllowed: vi.fn() }));
vi.mock('./plan-limits.js', () => plan);

// Array transactions run their operations; interactive ones get the mocked
// models as their client.
const runTransaction = (operations: unknown) =>
  typeof operations === 'function'
    ? (operations as (tx: unknown) => Promise<unknown>)(mocks)
    : Promise.all(operations as unknown[]);
vi.mock('../lib/cipseq-prisma.js', () => ({
  cipseqPrisma: {
    $transaction: mocks.$transaction,
    $executeRaw: mocks.$executeRaw,
    deviceCertificate: mocks.deviceCertificate,
    device: mocks.device,
    groupMember: mocks.groupMember,
    groupDevice: mocks.groupDevice,
    deviceEnvelope: mocks.deviceEnvelope,
    auditEvent: mocks.auditEvent,
  },
}));

const user = { id: 'user-1' } as AuthUser;
const deviceId = 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const groupId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const projectId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const date = new Date('2026-11-06T06:36:46.000Z');
const publicKey = Buffer.alloc(1568, 7).toString('base64');

const deviceRow = (status = 'ACTIVE') => ({
  id: deviceId,
  name: 'Work laptop',
  status,
  createdAt: date,
});
const stored = (overrides = {}) => ({
  ...deviceRow(),
  userId: user.id,
  publicKey,
  ...overrides,
});

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('failed', {
    code,
    clientVersion: 'test',
  });

describe('DevicesController', () => {
  const controller = new DevicesController();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.$transaction.mockImplementation(runTransaction);
    mocks.device.findUnique.mockResolvedValue(null);
    mocks.groupMember.findMany.mockResolvedValue([]);
    mocks.device.create.mockResolvedValue(deviceRow());
    mocks.device.findFirst.mockResolvedValue(deviceRow());
  });

  describe('register', () => {
    const register = (key = publicKey) =>
      controller.register(user, {
        deviceId,
        publicKey: key,
        name: 'Work laptop',
      });

    it('refuses a new device past the free-plan limit', async () => {
      plan.assertDeviceAllowed.mockRejectedValue(new ForbiddenException());

      await expect(register()).rejects.toBeInstanceOf(ForbiddenException);
      expect(plan.assertDeviceAllowed).toHaveBeenCalledWith(user, deviceId);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('checks the limit again inside the transaction', async () => {
      await register();

      expect(plan.assertDeviceAllowed).toHaveBeenLastCalledWith(
        user,
        deviceId,
        mocks,
      );
    });

    it('lets a retry of a registered device through without a limit check', async () => {
      mocks.device.findUnique.mockResolvedValue(stored());

      await expect(register()).resolves.toEqual(deviceRow());
      expect(plan.assertDeviceAllowed).not.toHaveBeenCalled();
    });

    it('just registers a device for someone in no groups', async () => {
      await expect(register()).resolves.toEqual(deviceRow());

      expect(mocks.device.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            id: deviceId,
            userId: user.id,
            name: 'Work laptop',
            publicKey,
            groups: { create: [] },
          },
        }),
      );
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: user.id,
          action: 'device.registered',
          projectId: null,
          metadata: { deviceId },
        },
      });
    });

    it('asks for approval in every live group the user is in', async () => {
      mocks.groupMember.findMany.mockResolvedValue([
        { groupId: 'group-1' },
        { groupId: 'group-2' },
      ]);

      await register();

      expect(mocks.groupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: user.id,
            group: { deletedAt: null, project: { deletedAt: null } },
          },
        }),
      );
      expect(mocks.device.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            groups: {
              create: [
                { groupId: 'group-1', status: 'PENDING_APPROVAL' },
                { groupId: 'group-2', status: 'PENDING_APPROVAL' },
              ],
            },
          }) as object,
        }),
      );
    });

    it('accepts base64url', async () => {
      await expect(
        register(Buffer.alloc(1568, 251).toString('base64url')),
      ).resolves.toEqual(deviceRow());
    });

    it('refuses a key that is not 1568 bytes', async () => {
      await expect(
        register(Buffer.alloc(1184).toString('base64')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.device.create).not.toHaveBeenCalled();
    });

    it('changes nothing when the same user registers the same key again', async () => {
      mocks.device.findUnique.mockResolvedValue(stored());

      await expect(register()).resolves.toEqual(deviceRow());
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['another account', { userId: 'someone-else' }],
      ['a different key', { publicKey: 'other' }],
      ['a revoked device', { status: 'REVOKED' }],
    ])('answers 409 for %s', async (_name, overrides) => {
      mocks.device.findUnique.mockResolvedValue(stored(overrides));

      await expect(register()).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('treats a race with the same registration as already registered', async () => {
      mocks.device.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(stored());
      mocks.$transaction.mockRejectedValue(prismaError('P2002'));

      await expect(register()).resolves.toEqual(deviceRow());
    });
  });

  describe('requestApproval', () => {
    const request = () => controller.requestApproval(user, deviceId, groupId);

    beforeEach(() => {
      mocks.groupMember.findFirst.mockResolvedValue({
        group: { projectId },
      });
      mocks.groupDevice.findFirst.mockResolvedValue(null);
    });

    it('opens a request for that one group only', async () => {
      await expect(request()).resolves.toEqual(deviceRow());

      expect(mocks.groupDevice.create).toHaveBeenCalledTimes(1);
      expect(mocks.groupDevice.create).toHaveBeenCalledWith({
        data: { groupId, deviceId, status: 'PENDING_APPROVAL' },
      });
      expect(mocks.auditEvent.create).toHaveBeenCalledWith({
        data: {
          userId: user.id,
          action: 'device.approval_requested',
          projectId,
          metadata: { deviceId, groupId },
        },
      });
    });

    it("answers 404 for someone else's device", async () => {
      mocks.device.findFirst.mockResolvedValue(null);

      await expect(request()).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.device.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: deviceId, userId: user.id } }),
      );
    });

    it('answers 404 for a group they are not in', async () => {
      mocks.groupMember.findFirst.mockResolvedValue(null);

      await expect(request()).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.groupDevice.create).not.toHaveBeenCalled();
    });

    it('answers 409 for a device revoked everywhere', async () => {
      mocks.device.findFirst.mockResolvedValue(deviceRow('REVOKED'));

      await expect(request()).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 409 when a request is already open', async () => {
      mocks.groupDevice.findFirst.mockResolvedValue({ id: 'row' });

      await expect(request()).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.groupDevice.create).not.toHaveBeenCalled();
    });

    it('answers 409 when it loses a race for the open row', async () => {
      mocks.$transaction.mockRejectedValue(prismaError('P2002'));

      await expect(request()).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('revoke', () => {
    it('permanently revokes the device everywhere, in one transaction', async () => {
      await controller.revoke(user, deviceId);

      expect(mocks.$transaction).toHaveBeenCalledTimes(1);
      expect(mocks.device.update).toHaveBeenCalledWith({
        where: { id: deviceId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: expect.any(Date) },
      });
      expect(mocks.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mocks.deviceCertificate.updateMany).toHaveBeenCalledWith({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mocks.groupDevice.updateMany).toHaveBeenCalledWith({
        where: {
          deviceId,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
        data: {
          status: 'REVOKED',
          revokedByUserId: user.id,
          revokedAt: expect.any(Date),
        },
      });
      expect(mocks.deviceEnvelope.updateMany).toHaveBeenCalledWith({
        where: { deviceId, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it("answers 404 for someone else's device", async () => {
      mocks.device.findFirst.mockResolvedValue(null);

      await expect(controller.revoke(user, deviceId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.$transaction).not.toHaveBeenCalled();
    });

    it('answers 409 when it was already revoked', async () => {
      mocks.device.findFirst.mockResolvedValue(deviceRow('REVOKED'));

      await expect(controller.revoke(user, deviceId)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
