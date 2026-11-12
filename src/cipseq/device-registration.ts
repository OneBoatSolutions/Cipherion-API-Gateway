import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { auditEvent } from './audit.js';
import { isUniqueViolation } from './cipseq-errors.js';
import {
  DeviceResponse,
  ML_KEM_1024_PUBLIC_KEY_BYTES,
  type RegisterDeviceDto,
} from './devices.dto.js';
import { assertDeviceAllowed } from './plan-limits.js';

export const DEVICE_FIELDS = {
  id: true,
  name: true,
  status: true,
  createdAt: true,
} as const;

// Node's base64 decoder also reads base64url, and ignores the padding.
function assertPublicKeySize(publicKey: string): void {
  if (
    Buffer.from(publicKey, 'base64').length !== ML_KEM_1024_PUBLIC_KEY_BYTES
  ) {
    throw new BadRequestException(
      'publicKey must be an ML-KEM-1024 public key',
    );
  }
}

async function findRegistered(
  deviceId: string,
  userId: string,
  publicKey: string,
): Promise<DeviceResponse | null> {
  const device = await cipseqPrisma.device.findUnique({
    where: { id: deviceId },
    select: { ...DEVICE_FIELDS, userId: true, publicKey: true },
  });
  if (!device) {
    return null;
  }
  // Another account's id gets the same answer, so it reveals nothing about them.
  if (
    device.userId !== userId ||
    device.publicKey !== publicKey ||
    device.status !== 'ACTIVE'
  ) {
    throw new ConflictException('This device id can not be registered');
  }
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    createdAt: device.createdAt,
  };
}

// Grants nothing by itself: it asks each project admin for approval, for every
// group the user is in. With no groups, the device is just registered. Shared by
// the console and the engine listener.
export async function registerDevice(
  user: AuthUser,
  { deviceId, publicKey, name }: RegisterDeviceDto,
): Promise<DeviceResponse> {
  assertPublicKeySize(publicKey);

  const existing = await findRegistered(deviceId, user.id, publicKey);
  if (existing) {
    return existing;
  }
  await assertDeviceAllowed(user, deviceId);

  const memberships = await cipseqPrisma.groupMember.findMany({
    where: {
      userId: user.id,
      group: { deletedAt: null, project: { deletedAt: null } },
    },
    select: { groupId: true },
  });

  try {
    return await cipseqPrisma.$transaction(async (tx) => {
      await assertDeviceAllowed(user, deviceId, tx);
      const device = await tx.device.create({
        data: {
          id: deviceId,
          userId: user.id,
          name,
          publicKey,
          groups: {
            create: memberships.map(({ groupId }) => ({
              groupId,
              status: 'PENDING_APPROVAL' as const,
            })),
          },
        },
        select: DEVICE_FIELDS,
      });
      await auditEvent(user.id, 'device.registered', null, { deviceId }, tx);
      return device;
    });
  } catch (error) {
    // Two registrations of one device at the same time.
    if (isUniqueViolation(error)) {
      const device = await findRegistered(deviceId, user.id, publicKey);
      if (device) {
        return device;
      }
    }
    throw error;
  }
}
