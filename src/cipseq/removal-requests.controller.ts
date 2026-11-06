import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { isUniqueViolation, whileStatusCurrent } from './cipseq-errors.js';
import {
  findGroupForAdmin,
  findGroupForGroupAdmin,
  findGroupForMember,
} from './group-access.js';
import { revokeGroupMember } from './group-keys.js';
import { GroupPassphraseDto, GroupResponse } from './groups.dto.js';
import {
  CreateRemovalRequestDto,
  RemovalRequestResponse,
} from './removal-requests.dto.js';

export const REMOVAL_REQUEST_FIELDS = {
  id: true,
  groupId: true,
  targetUserId: true,
  status: true,
  requestedByUserId: true,
  createdAt: true,
} as const;

export function toRemovalRequestResponse(
  { groupId, ...request }: Omit<RemovalRequestResponse, 'projectId'>,
  projectId: string,
): RemovalRequestResponse {
  return { ...request, projectId, groupId };
}

async function findRequest(groupId: string, id: string) {
  const request = await cipseqPrisma.groupMemberRemovalRequest.findFirst({
    where: { id, groupId },
    select: REMOVAL_REQUEST_FIELDS,
  });
  if (!request) {
    throw new NotFoundException();
  }
  return request;
}

@ApiTags('cipseq')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@ApiNotFoundResponse({
  description: 'No such project, group, member or request',
})
@Controller('cipseq/projects/:projectId/groups/:groupId/removal-requests')
export class RemovalRequestsController {
  // The member stays in the group until the project admin approves.
  @ApiOperation({
    summary: 'Ask the project admin to remove a member from a group',
  })
  @ApiCreatedResponse({ type: RemovalRequestResponse })
  @ApiBadRequestResponse({
    description:
      'Validation failed, or the caller is the project admin, or the target is the project admin or the caller',
  })
  @ApiForbiddenResponse({ description: 'Not a group admin' })
  @ApiConflictResponse({ description: 'A request is already pending' })
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() { userId }: CreateRemovalRequestDto,
  ): Promise<RemovalRequestResponse> {
    const { project, isProjectAdmin } = await findGroupForGroupAdmin(
      projectId,
      groupId,
      user.id,
    );
    if (isProjectAdmin) {
      throw new BadRequestException(
        'The project admin revokes members directly',
      );
    }
    if (userId === project.adminUserId || userId === user.id) {
      throw new BadRequestException("This member can't be removed");
    }
    const member = await cipseqPrisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { userId: true },
    });
    if (!member) {
      throw new NotFoundException();
    }

    const id = randomUUID();
    try {
      const [request] = await cipseqPrisma.$transaction([
        cipseqPrisma.groupMemberRemovalRequest.create({
          data: {
            id,
            groupId,
            targetUserId: userId,
            requestedByUserId: user.id,
            status: 'PENDING_APPROVAL',
          },
          select: REMOVAL_REQUEST_FIELDS,
        }),
        auditEvent(user.id, 'removal_request.created', projectId, {
          groupId,
          requestId: id,
          targetUserId: userId,
        }),
      ]);
      return toRemovalRequestResponse(request, projectId);
    } catch (error) {
      // A partial unique index allows one pending request per group and member.
      if (isUniqueViolation(error)) {
        throw new ConflictException('A request is already pending');
      }
      throw error;
    }
  }

  @ApiOperation({
    summary: 'Approve a request: revoke the member and rotate the group keys',
  })
  @ApiOkResponse({ type: GroupResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({
    description: 'Not the project admin, or an incorrect passphrase',
  })
  @ApiConflictResponse({
    description: 'Already handled, or a concurrent rotation got there first',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many incorrect passphrases' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  @ApiBadGatewayResponse({ description: 'The KMS call failed' })
  @HttpCode(200)
  @Post(':id/approve')
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() { passphrase }: GroupPassphraseDto,
  ): Promise<GroupResponse> {
    const { group } = await findGroupForAdmin(projectId, groupId, user.id);
    const request = await findRequest(groupId, id);
    // Checked before the KMS call, so a stale request doesn't use up an attempt.
    if (request.status !== 'PENDING_APPROVAL') {
      throw new ConflictException('This has already been handled');
    }

    return revokeGroupMember({
      actorUserId: user.id,
      projectId,
      group,
      targetUserId: request.targetUserId,
      passphrase,
      requestId: id,
    });
  }

  @ApiOperation({ summary: 'Reject a request. The member stays in the group' })
  @ApiOkResponse({ type: RemovalRequestResponse })
  @ApiBadRequestResponse({ description: 'Invalid id' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiConflictResponse({ description: 'Already handled' })
  @HttpCode(200)
  @Post(':id/reject')
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RemovalRequestResponse> {
    await findGroupForAdmin(projectId, groupId, user.id);
    const request = await findRequest(groupId, id);
    return this.close(
      user,
      projectId,
      request,
      'REJECTED',
      'removal_request.rejected',
    );
  }

  @ApiOperation({ summary: 'Cancel a pending request' })
  @ApiOkResponse({ type: RemovalRequestResponse })
  @ApiBadRequestResponse({ description: 'Invalid id' })
  @ApiForbiddenResponse({
    description: 'Neither the requester nor the project admin',
  })
  @ApiConflictResponse({ description: 'Already handled' })
  @HttpCode(200)
  @Post(':id/cancel')
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RemovalRequestResponse> {
    const { isProjectAdmin } = await findGroupForMember(
      projectId,
      groupId,
      user.id,
    );
    const request = await findRequest(groupId, id);
    if (!isProjectAdmin && request.requestedByUserId !== user.id) {
      throw new ForbiddenException();
    }
    return this.close(
      user,
      projectId,
      request,
      'CANCELLED',
      'removal_request.cancelled',
    );
  }

  private async close(
    user: AuthUser,
    projectId: string,
    request: { id: string; groupId: string; targetUserId: string },
    status: 'REJECTED' | 'CANCELLED',
    action: 'removal_request.rejected' | 'removal_request.cancelled',
  ): Promise<RemovalRequestResponse> {
    const [updated] = await whileStatusCurrent(() =>
      cipseqPrisma.$transaction([
        cipseqPrisma.groupMemberRemovalRequest.update({
          where: { id: request.id, status: 'PENDING_APPROVAL' },
          data: {
            status,
            reviewedByUserId: user.id,
            reviewedAt: new Date(),
          },
          select: REMOVAL_REQUEST_FIELDS,
        }),
        auditEvent(user.id, action, projectId, {
          groupId: request.groupId,
          requestId: request.id,
          targetUserId: request.targetUserId,
        }),
      ]),
    );
    return toRemovalRequestResponse(updated, projectId);
  }
}
