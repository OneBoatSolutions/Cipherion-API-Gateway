import { BadRequestException } from '@nestjs/common';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { lockDevice } from './device-lock.js';
import { OPEN_DEVICE_STATUSES } from './devices.dto.js';

// Revoking never rotates keys and needs no passphrase. Each function returns the
// writes for the caller's transaction, so they commit with its audit event. Every
// version of an envelope is soft deleted. A saved copy can't be recalled, which
// is why a rotation is still what cuts off a device that kept one.

function closeDeviceAccess(
  actorUserId: string,
  devices: { deviceId: string } | { device: { userId: string } },
  groups: { groupId: string } | { group: { projectId: string } } | object,
) {
  const now = new Date();
  return [
    cipseqPrisma.groupDevice.updateMany({
      where: {
        ...devices,
        ...groups,
        status: { in: [...OPEN_DEVICE_STATUSES] },
      },
      data: {
        status: 'REVOKED',
        revokedByUserId: actorUserId,
        revokedAt: now,
      },
    }),
    cipseqPrisma.deviceEnvelope.updateMany({
      where: { ...devices, ...groups, deletedAt: null },
      data: { deletedAt: now },
    }),
  ];
}

export function memberFromGroupWrites(
  actorUserId: string,
  groupId: string,
  targetUserId: string,
) {
  return [
    cipseqPrisma.groupMember.delete({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    }),
    ...closeDeviceAccess(
      actorUserId,
      { device: { userId: targetUserId } },
      {
        groupId,
      },
    ),
  ];
}

// A project has no direct members, so this removes them from each of its groups.
export function memberFromProjectWrites(
  actorUserId: string,
  projectId: string,
  targetUserId: string,
) {
  return [
    cipseqPrisma.groupMember.deleteMany({
      where: { userId: targetUserId, group: { projectId } },
    }),
    ...closeDeviceAccess(
      actorUserId,
      { device: { userId: targetUserId } },
      {
        group: { projectId },
      },
    ),
  ];
}

export function deviceFromGroupWrites(
  actorUserId: string,
  groupId: string,
  deviceId: string,
) {
  return closeDeviceAccess(actorUserId, { deviceId }, { groupId });
}

export function deviceFromProjectWrites(
  actorUserId: string,
  projectId: string,
  deviceId: string,
) {
  return closeDeviceAccess(actorUserId, { deviceId }, { group: { projectId } });
}

// Permanent: the device's id can't be registered again. Its certificates go with
// it, under the lock, so one being issued right now can't survive this. The other
// revocations leave certificates alone: a device removed from one group or project
// is still the same device everywhere else.
export function deviceEverywhereWrites(actorUserId: string, deviceId: string) {
  const now = new Date();
  return [
    lockDevice(cipseqPrisma, deviceId),
    cipseqPrisma.device.update({
      where: { id: deviceId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: now },
    }),
    cipseqPrisma.deviceCertificate.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: now },
    }),
    ...closeDeviceAccess(actorUserId, { deviceId }, {}),
  ];
}

interface RevocationTarget {
  actorUserId: string;
  adminUserId: string;
  targetUserId: string;
}

// Nobody can target the project admin, and an acting admin can't target themselves.
// A group has one acting admin, so everyone else in it is a plain member there,
// whatever role they have in another group.
export function assertMayRevokeMember({
  actorUserId,
  adminUserId,
  targetUserId,
}: RevocationTarget): void {
  if (targetUserId === adminUserId) {
    throw new BadRequestException("The project admin can't be revoked");
  }
  if (targetUserId === actorUserId) {
    throw new BadRequestException("You can't target yourself");
  }
}

// The same rules, for the person a device belongs to. The project admin can revoke
// any device in their project, including their own.
export function assertMayRevokeDeviceOf({
  actorUserId,
  adminUserId,
  targetUserId,
}: RevocationTarget): void {
  if (actorUserId === adminUserId) {
    return;
  }
  if (targetUserId === adminUserId) {
    throw new BadRequestException(
      "The project admin's device can't be revoked",
    );
  }
  if (targetUserId === actorUserId) {
    throw new BadRequestException("You can't target yourself");
  }
}
