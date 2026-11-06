import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { auditEvent } from './audit.js';
import { isUniqueViolation, whileStatusCurrent } from './cipseq-errors.js';
import {
  DeviceResponse,
  ML_KEM_1024_PUBLIC_KEY_BYTES,
  OPEN_DEVICE_STATUSES,
  RegisterDeviceDto,
} from './devices.dto.js';
import { deviceEverywhereWrites } from './revocations.js';

const DEVICE_FIELDS = {
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

async function findOwnActiveDevice(deviceId: string, userId: string) {
  const device = await cipseqPrisma.device.findFirst({
    where: { id: deviceId, userId },
    select: DEVICE_FIELDS,
  });
  if (!device) {
    throw new NotFoundException();
  }
  if (device.status !== 'ACTIVE') {
    throw new ConflictException('This device was revoked');
  }
  return device;
}

@ApiTags('cipseq')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@Controller('cipseq/devices')
export class DevicesController {
  // Grants nothing by itself: it asks each project admin for approval, for every
  // group the user is in. With no groups, the device is just registered.
  @ApiOperation({
    summary: 'Register a device and request approval for its groups',
  })
  @ApiCreatedResponse({ type: DeviceResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiConflictResponse({
    description:
      'The id belongs to someone else, has a different key, or was revoked',
  })
  @Post()
  async register(
    @CurrentUser() user: AuthUser,
    @Body() { deviceId, publicKey, name }: RegisterDeviceDto,
  ): Promise<DeviceResponse> {
    assertPublicKeySize(publicKey);

    const existing = await findRegistered(deviceId, user.id, publicKey);
    if (existing) {
      return existing;
    }

    const memberships = await cipseqPrisma.groupMember.findMany({
      where: {
        userId: user.id,
        group: { deletedAt: null, project: { deletedAt: null } },
      },
      select: { groupId: true },
    });

    try {
      const [device] = await cipseqPrisma.$transaction([
        cipseqPrisma.device.create({
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
        }),
        auditEvent(user.id, 'device.registered', null, { deviceId }),
      ]);
      return device;
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

  // Per group, so that one request can never give access to all of a member's groups.
  @ApiOperation({
    summary: 'Ask for a revoked or rejected device to be approved for a group',
  })
  @ApiOkResponse({ type: DeviceResponse })
  @ApiBadRequestResponse({ description: 'Invalid id' })
  @ApiNotFoundResponse({
    description: 'Not your device, or not a group you are in',
  })
  @ApiConflictResponse({
    description: 'The device was revoked everywhere, or a request is open',
  })
  @HttpCode(200)
  @Post(':deviceId/groups/:groupId/request-approval')
  async requestApproval(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
  ): Promise<DeviceResponse> {
    const device = await findOwnActiveDevice(deviceId, user.id);
    const member = await cipseqPrisma.groupMember.findFirst({
      where: {
        groupId,
        userId: user.id,
        group: { deletedAt: null, project: { deletedAt: null } },
      },
      select: { group: { select: { projectId: true } } },
    });
    if (!member) {
      throw new NotFoundException();
    }

    const open = await cipseqPrisma.groupDevice.findFirst({
      where: {
        groupId,
        deviceId,
        status: { in: [...OPEN_DEVICE_STATUSES] },
      },
      select: { id: true },
    });
    if (open) {
      throw new ConflictException('A request is already open');
    }

    try {
      await cipseqPrisma.$transaction([
        cipseqPrisma.groupDevice.create({
          data: { groupId, deviceId, status: 'PENDING_APPROVAL' },
        }),
        auditEvent(
          user.id,
          'device.approval_requested',
          member.group.projectId,
          { deviceId, groupId },
        ),
      ]);
    } catch (error) {
      // A partial unique index allows one open row per group and device.
      if (isUniqueViolation(error)) {
        throw new ConflictException('A request is already open');
      }
      throw error;
    }
    return device;
  }

  // Permanent, because the device's user is the only one with rights in every
  // project it's used in. Certificates join this in the certificate branch.
  @ApiOperation({ summary: 'Revoke your own device everywhere, permanently' })
  @ApiNoContentResponse({ description: 'Revoked' })
  @ApiNotFoundResponse({ description: 'Not your device' })
  @ApiConflictResponse({ description: 'Already revoked' })
  @HttpCode(204)
  @Post(':deviceId/revoke')
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    await findOwnActiveDevice(deviceId, user.id);

    await whileStatusCurrent(() =>
      cipseqPrisma.$transaction([
        ...deviceEverywhereWrites(user.id, deviceId),
        auditEvent(user.id, 'device.revoked', null, { deviceId }),
      ]),
    );
  }
}
