import {
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
  ApiForbiddenResponse,
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
import { DEVICE_FIELDS, registerDevice } from './device-registration.js';
import {
  DeviceResponse,
  OPEN_DEVICE_STATUSES,
  RegisterDeviceDto,
} from './devices.dto.js';
import { deviceEverywhereWrites } from './revocations.js';
import { RateLimit } from '../lib/rate-limit.guard.js';

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
  @ApiForbiddenResponse({
    description:
      'PLAN_LIMIT_REACHED: the free plan allows no more active devices',
  })
  @RateLimit()
  @Post()
  async register(
    @CurrentUser() user: AuthUser,
    @Body() body: RegisterDeviceDto,
  ): Promise<DeviceResponse> {
    return registerDevice(user, body);
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
  @RateLimit()
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

  // Stays until dismissed, and can't be turned off in the settings: it's how an
  // owner finds out that a stolen session enrolled a certificate. A repeat click
  // answers the same, so it isn't an error.
  @ApiOperation({ summary: 'Dismiss a certificate issued notification' })
  @ApiNoContentResponse({ description: 'Dismissed' })
  @ApiBadRequestResponse({ description: 'Invalid id' })
  @HttpCode(204)
  @RateLimit()
  @Post('certificate-notices/:noticeId/dismiss')
  async dismissCertificateNotice(
    @CurrentUser() user: AuthUser,
    @Param('noticeId', ParseUUIDPipe) noticeId: string,
  ): Promise<void> {
    await cipseqPrisma.$transaction(async (tx) => {
      const { count } = await tx.deviceCertificateNotice.updateMany({
        where: { id: noticeId, userId: user.id, dismissedAt: null },
        data: { dismissedAt: new Date() },
      });
      if (count > 0) {
        await auditEvent(
          user.id,
          'device.certificate_notice_dismissed',
          null,
          { noticeId },
          tx,
        );
      }
    });
  }

  // Permanent, because the device's user is the only one with rights in every
  // project it's used in. Its certificates are revoked with it.
  @ApiOperation({ summary: 'Revoke your own device everywhere, permanently' })
  @ApiNoContentResponse({ description: 'Revoked' })
  @ApiNotFoundResponse({ description: 'Not your device' })
  @ApiConflictResponse({ description: 'Already revoked' })
  @HttpCode(204)
  @RateLimit()
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
