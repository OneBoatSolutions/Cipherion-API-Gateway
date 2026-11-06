import {
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
import {
  isRecordNotFound,
  isUniqueViolation,
  whileStatusCurrent,
} from './cipseq-errors.js';
import { InvitationResponse } from './invitations.dto.js';
import {
  INVITATION_FIELDS,
  toInvitationResponse,
} from './invitations.controller.js';

// Someone else's invitation answers 404, so its id reveals nothing. Emails aren't
// verified yet: accepting gives no keys, because those need an approved device.
async function findOwnInvitation(id: string, user: AuthUser) {
  const invitation = await cipseqPrisma.groupInvitation.findFirst({
    where: {
      id,
      inviteeEmail: user.email.toLowerCase(),
      group: { deletedAt: null, project: { deletedAt: null } },
    },
    select: {
      id: true,
      groupId: true,
      status: true,
      group: { select: { projectId: true } },
    },
  });
  if (!invitation) {
    throw new NotFoundException();
  }
  if (invitation.status !== 'PENDING_ACCEPTANCE') {
    throw new ConflictException('This has already been handled');
  }
  return invitation;
}

@ApiTags('cipseq')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@ApiBadRequestResponse({ description: 'Invalid id' })
@ApiNotFoundResponse({ description: 'No such invitation for this user' })
@Controller('cipseq/invitations')
export class InvitationResponsesController {
  // No KMS call, because no keys change. The new member gets the current GDEK
  // through device registration.
  @ApiOperation({ summary: 'Accept an invitation and join the group' })
  @ApiOkResponse({ type: InvitationResponse })
  @ApiConflictResponse({ description: 'Already handled, or already a member' })
  @HttpCode(200)
  @Post(':id/accept')
  async accept(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvitationResponse> {
    const { groupId, group } = await findOwnInvitation(id, user);
    const { projectId } = group;

    try {
      const [updated] = await cipseqPrisma.$transaction([
        cipseqPrisma.groupInvitation.update({
          where: { id, status: 'PENDING_ACCEPTANCE' },
          data: { status: 'ACCEPTED', respondedAt: new Date() },
          select: INVITATION_FIELDS,
        }),
        cipseqPrisma.projectMember.upsert({
          where: { projectId_userId: { projectId, userId: user.id } },
          create: { projectId, userId: user.id },
          update: {},
        }),
        cipseqPrisma.groupMember.create({
          data: { groupId, userId: user.id, role: 'MEMBER' },
        }),
        auditEvent(user.id, 'invitation.accepted', projectId, {
          groupId,
          invitationId: id,
        }),
      ]);
      return toInvitationResponse(updated, projectId);
    } catch (error) {
      if (isRecordNotFound(error)) {
        throw new ConflictException('This has already been handled');
      }
      if (isUniqueViolation(error)) {
        throw new ConflictException('Already a member of this group');
      }
      throw error;
    }
  }

  @ApiOperation({ summary: 'Decline an invitation' })
  @ApiOkResponse({ type: InvitationResponse })
  @ApiConflictResponse({ description: 'Already handled' })
  @HttpCode(200)
  @Post(':id/decline')
  async decline(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvitationResponse> {
    const { groupId, group } = await findOwnInvitation(id, user);
    const { projectId } = group;

    const [updated] = await whileStatusCurrent(() =>
      cipseqPrisma.$transaction([
        cipseqPrisma.groupInvitation.update({
          where: { id, status: 'PENDING_ACCEPTANCE' },
          data: { status: 'DECLINED', respondedAt: new Date() },
          select: INVITATION_FIELDS,
        }),
        auditEvent(user.id, 'invitation.declined', projectId, {
          groupId,
          invitationId: id,
        }),
      ]),
    );
    return toInvitationResponse(updated, projectId);
  }
}
