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
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { auditEvent } from './audit.js';
import {
  countMissingEnvelopes,
  createFirstMissingEnvelope,
  removeIneligibleEnvelopes,
  startEnvelopeJob,
  wrapEnvelope,
} from './device-envelopes.js';
import { isEnvelopeJobRunning } from './envelope-jobs.js';
import {
  EnvelopesToCreateResponse,
  OPEN_DEVICE_STATUSES,
} from './devices.dto.js';
import { findGroupForAdmin, findGroupForGroupAdmin } from './group-access.js';
import { GroupPassphraseDto } from './groups.dto.js';
import { findProjectForAdmin } from './project-access.js';
import {
  assertMayRevokeDeviceOf,
  deviceFromGroupWrites,
  deviceFromProjectWrites,
} from './revocations.js';
import { withPassphraseAttempt } from './with-passphrase-attempt.js';
import { RateLimit } from '../lib/rate-limit.guard.js';

function pendingInProject(projectId: string, deviceId: string) {
  return {
    deviceId,
    status: 'PENDING_APPROVAL',
    group: { projectId, deletedAt: null },
  } as const;
}

@ApiTags('cipseq')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@Controller('cipseq/projects/:projectId')
export class ProjectDevicesController {
  // The first envelope is created inside the request, so a wrong passphrase is
  // answered and counted here. The job creates the rest at the latest GDEK version.
  @ApiOperation({ summary: 'Approve a device for all its waiting groups' })
  @ApiOkResponse({ type: EnvelopesToCreateResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({
    description: 'Not the project admin, or an incorrect passphrase',
  })
  @ApiNotFoundResponse({ description: 'No such project or waiting device' })
  @ApiConflictResponse({ description: 'Already handled' })
  @ApiTooManyRequestsResponse({ description: 'Too many incorrect passphrases' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  @ApiBadGatewayResponse({ description: 'The KMS call failed' })
  @HttpCode(200)
  @RateLimit()
  @Post('devices/:deviceId/approve')
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('deviceId') deviceId: string,
    @Body() { passphrase }: GroupPassphraseDto,
  ): Promise<EnvelopesToCreateResponse> {
    await findProjectForAdmin(projectId, user.id);

    const pending = await cipseqPrisma.groupDevice.findMany({
      where: pendingInProject(projectId, deviceId),
      select: {
        groupId: true,
        device: { select: { id: true, publicKey: true } },
      },
    });
    const first = pending[0];
    if (!first) {
      throw new NotFoundException();
    }
    const groupIds = pending.map(({ groupId }) => groupId);
    const firstGroupId = first.groupId;

    await withPassphraseAttempt(projectId, async () => {
      const envelope = await wrapEnvelope(
        projectId,
        firstGroupId,
        first.device,
        passphrase,
      );
      const [approved] = await cipseqPrisma.$transaction([
        cipseqPrisma.groupDevice.updateMany({
          where: {
            ...pendingInProject(projectId, deviceId),
            groupId: { in: groupIds },
          },
          data: {
            status: 'APPROVED',
            reviewedByUserId: user.id,
            reviewedAt: new Date(),
          },
        }),
        cipseqPrisma.deviceEnvelope.create({ data: envelope }),
        auditEvent(user.id, 'device.approved', projectId, {
          deviceId,
          groupIds,
        }),
      ]);
      await removeIneligibleEnvelopes(firstGroupId, [deviceId]);
      if (approved.count === 0) {
        throw new ConflictException('This has already been handled');
      }
    });

    const envelopesToCreate = await countMissingEnvelopes(groupIds);
    await startEnvelopeJob(
      user.id,
      projectId,
      groupIds,
      passphrase,
      'APPROVAL',
    );
    return { envelopesToCreate };
  }

  @ApiOperation({ summary: 'Reject a device for all its waiting groups' })
  @ApiNoContentResponse({ description: 'Rejected' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project or waiting device' })
  @HttpCode(204)
  @RateLimit()
  @Post('devices/:deviceId/reject')
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    await findProjectForAdmin(projectId, user.id);

    const [rejected] = await cipseqPrisma.$transaction([
      cipseqPrisma.groupDevice.updateMany({
        where: pendingInProject(projectId, deviceId),
        data: {
          status: 'REJECTED',
          reviewedByUserId: user.id,
          reviewedAt: new Date(),
        },
      }),
      auditEvent(user.id, 'device.rejected', projectId, { deviceId }),
    ]);
    if (rejected.count === 0) {
      throw new NotFoundException();
    }
  }

  @ApiOperation({ summary: 'Revoke a device for the whole project' })
  @ApiNoContentResponse({ description: 'Revoked' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project or device' })
  @HttpCode(204)
  @RateLimit()
  @Post('devices/:deviceId/revoke')
  async revokeFromProject(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    await findProjectForAdmin(projectId, user.id);

    const open = await cipseqPrisma.groupDevice.findFirst({
      where: {
        deviceId,
        status: { in: [...OPEN_DEVICE_STATUSES] },
        group: { projectId },
      },
      select: { id: true },
    });
    if (!open) {
      throw new NotFoundException();
    }

    await cipseqPrisma.$transaction([
      ...deviceFromProjectWrites(user.id, projectId, deviceId),
      auditEvent(user.id, 'device.revoked', projectId, { deviceId }),
    ]);
  }

  @ApiOperation({ summary: 'Revoke a device for one group' })
  @ApiNoContentResponse({ description: 'Revoked' })
  @ApiBadRequestResponse({
    description: "The device is the project admin's or the caller's own",
  })
  @ApiForbiddenResponse({ description: 'Not a group admin' })
  @ApiNotFoundResponse({ description: 'No such project, group or device' })
  @HttpCode(204)
  @RateLimit()
  @Post('groups/:groupId/devices/:deviceId/revoke')
  async revokeFromGroup(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    const { project } = await findGroupForGroupAdmin(
      projectId,
      groupId,
      user.id,
    );

    const open = await cipseqPrisma.groupDevice.findFirst({
      where: {
        groupId,
        deviceId,
        status: { in: [...OPEN_DEVICE_STATUSES] },
      },
      select: { device: { select: { userId: true } } },
    });
    if (!open) {
      throw new NotFoundException();
    }
    assertMayRevokeDeviceOf({
      actorUserId: user.id,
      adminUserId: project.adminUserId,
      targetUserId: open.device.userId,
    });

    await cipseqPrisma.$transaction([
      ...deviceFromGroupWrites(user.id, groupId, deviceId),
      auditEvent(user.id, 'device.revoked', projectId, { deviceId, groupId }),
    ]);
  }

  // For when a job stopped or the gateway restarted. Without anything missing, no
  // KMS call is made, so the passphrase isn't checked.
  @ApiOperation({ summary: "Create a group's missing envelopes" })
  @ApiOkResponse({ type: EnvelopesToCreateResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({
    description: 'Not the project admin, or an incorrect passphrase',
  })
  @ApiNotFoundResponse({ description: 'No such project or group' })
  @ApiConflictResponse({ description: 'A job is still running for this group' })
  @ApiTooManyRequestsResponse({ description: 'Too many incorrect passphrases' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  @ApiBadGatewayResponse({ description: 'The KMS call failed' })
  @HttpCode(200)
  @RateLimit()
  @Post('groups/:groupId/envelopes/renew')
  async renew(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() { passphrase }: GroupPassphraseDto,
  ): Promise<EnvelopesToCreateResponse> {
    await findGroupForAdmin(projectId, groupId, user.id);

    const missing = await countMissingEnvelopes([groupId]);
    if (missing === 0) {
      return { envelopesToCreate: 0 };
    }

    const job = await cipseqPrisma.envelopeJob.findUnique({
      where: { groupId },
      select: { status: true, lastActiveAt: true },
    });
    if (isEnvelopeJobRunning(job)) {
      throw new ConflictException(
        'The envelopes for this group are still being created',
      );
    }

    await withPassphraseAttempt(projectId, () =>
      createFirstMissingEnvelope(user.id, projectId, groupId, passphrase),
    );

    const envelopesToCreate = await countMissingEnvelopes([groupId]);
    await startEnvelopeJob(
      user.id,
      projectId,
      [groupId],
      passphrase,
      'RENEWAL',
    );
    return { envelopesToCreate };
  }

  // Answers the same if there's nothing to dismiss, so a repeat click isn't an error.
  @ApiOperation({ summary: 'Dismiss the envelopes completed notification' })
  @ApiNoContentResponse({ description: 'Dismissed' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project or group' })
  @HttpCode(204)
  @RateLimit()
  @Post('groups/:groupId/envelopes/completed/dismiss')
  async dismissCompleted(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
  ): Promise<void> {
    await findGroupForAdmin(projectId, groupId, user.id);

    const open = {
      groupId,
      status: 'COMPLETED',
      dismissedAt: null,
    } as const;
    const job = await cipseqPrisma.envelopeJob.findFirst({
      where: open,
      select: { gdekVersion: true },
    });
    if (!job) {
      return;
    }
    await cipseqPrisma.$transaction([
      cipseqPrisma.envelopeJob.updateMany({
        where: open,
        data: { dismissedAt: new Date() },
      }),
      auditEvent(user.id, 'device.envelope_job_dismissed', projectId, {
        groupId,
        gdekVersion: job.gdekVersion,
      }),
    ]);
  }
}
