import { randomUUID } from 'node:crypto';
import {
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
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { prisma } from '../lib/prisma.js';
import { auditEvent } from './audit.js';
import { isUniqueViolation, whileStatusCurrent } from './cipseq-errors.js';
import {
  findGroupForAdmin,
  findGroupForGroupAdmin,
  findGroupForMember,
} from './group-access.js';
import { CreateInvitationDto, InvitationResponse } from './invitations.dto.js';

export const INVITATION_FIELDS = {
  id: true,
  groupId: true,
  inviteeEmail: true,
  status: true,
  invitedByUserId: true,
  createdAt: true,
} as const;

export const OPEN_INVITATION_STATUSES = [
  'PENDING_APPROVAL',
  'PENDING_ACCEPTANCE',
] as const;

export function toInvitationResponse(
  { groupId, ...invitation }: Omit<InvitationResponse, 'projectId'>,
  projectId: string,
): InvitationResponse {
  return { ...invitation, projectId, groupId };
}

async function findInvitation(groupId: string, id: string) {
  const invitation = await cipseqPrisma.groupInvitation.findFirst({
    where: { id, groupId },
    select: INVITATION_FIELDS,
  });
  if (!invitation) {
    throw new NotFoundException();
  }
  return invitation;
}

@ApiTags('cipseq')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@ApiNotFoundResponse({ description: 'No such project, group or invitation' })
@Controller('cipseq/projects/:projectId/groups/:groupId/invitations')
export class InvitationsController {
  // Nothing is emailed: the invitee sees it in GET /workspace. The answer doesn't
  // depend on whether the address has an account, so inviting can't be used to
  // discover who has signed up.
  @ApiOperation({
    summary:
      "Invite someone to a group. An acting admin's invitation waits for the project admin's approval",
  })
  @ApiCreatedResponse({ type: InvitationResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({ description: 'Not a group admin' })
  @ApiConflictResponse({
    description: 'Already a member, or an invitation is already open',
  })
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() { email }: CreateInvitationDto,
  ): Promise<InvitationResponse> {
    const { isProjectAdmin } = await findGroupForGroupAdmin(
      projectId,
      groupId,
      user.id,
    );

    const inviteeEmail = email.toLowerCase();
    const account = await prisma.user.findUnique({
      where: { email: inviteeEmail },
      select: { id: true },
    });
    const existing =
      account &&
      (await cipseqPrisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: account.id } },
        select: { userId: true },
      }));
    if (existing) {
      throw new ConflictException('Already a member of this group');
    }

    const id = randomUUID();
    try {
      const [invitation] = await cipseqPrisma.$transaction([
        cipseqPrisma.groupInvitation.create({
          data: {
            id,
            groupId,
            inviteeEmail,
            invitedByUserId: user.id,
            status: isProjectAdmin ? 'PENDING_ACCEPTANCE' : 'PENDING_APPROVAL',
          },
          select: INVITATION_FIELDS,
        }),
        auditEvent(user.id, 'invitation.created', projectId, {
          groupId,
          invitationId: id,
        }),
      ]);
      return toInvitationResponse(invitation, projectId);
    } catch (error) {
      // A partial unique index allows one open invitation per group and email.
      if (isUniqueViolation(error)) {
        throw new ConflictException('An invitation is already open');
      }
      throw error;
    }
  }

  @ApiOperation({ summary: "Approve an acting admin's invitation" })
  @ApiOkResponse({ type: InvitationResponse })
  @ApiBadRequestResponse({ description: 'Invalid id' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiConflictResponse({ description: 'Already handled' })
  @HttpCode(200)
  @Post(':id/approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvitationResponse> {
    return this.review(
      user,
      projectId,
      groupId,
      id,
      'PENDING_ACCEPTANCE',
      'invitation.approved',
    );
  }

  @ApiOperation({ summary: "Reject an acting admin's invitation" })
  @ApiOkResponse({ type: InvitationResponse })
  @ApiBadRequestResponse({ description: 'Invalid id' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiConflictResponse({ description: 'Already handled' })
  @HttpCode(200)
  @Post(':id/reject')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvitationResponse> {
    return this.review(
      user,
      projectId,
      groupId,
      id,
      'REJECTED',
      'invitation.rejected',
    );
  }

  @ApiOperation({ summary: 'Cancel an open invitation' })
  @ApiOkResponse({ type: InvitationResponse })
  @ApiBadRequestResponse({ description: 'Invalid id' })
  @ApiForbiddenResponse({
    description: 'Neither the inviter nor the project admin',
  })
  @ApiConflictResponse({ description: 'Already handled' })
  @HttpCode(200)
  @Post(':id/cancel')
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvitationResponse> {
    const { isProjectAdmin } = await findGroupForMember(
      projectId,
      groupId,
      user.id,
    );
    const invitation = await findInvitation(groupId, id);
    if (!isProjectAdmin && invitation.invitedByUserId !== user.id) {
      throw new ForbiddenException();
    }

    const [updated] = await whileStatusCurrent(() =>
      cipseqPrisma.$transaction([
        cipseqPrisma.groupInvitation.update({
          where: { id, status: { in: [...OPEN_INVITATION_STATUSES] } },
          data: {
            status: 'CANCELLED',
            reviewedByUserId: user.id,
            reviewedAt: new Date(),
          },
          select: INVITATION_FIELDS,
        }),
        auditEvent(user.id, 'invitation.cancelled', projectId, {
          groupId,
          invitationId: id,
        }),
      ]),
    );
    return toInvitationResponse(updated, projectId);
  }

  private async review(
    user: AuthUser,
    projectId: string,
    groupId: string,
    id: string,
    status: 'PENDING_ACCEPTANCE' | 'REJECTED',
    action: 'invitation.approved' | 'invitation.rejected',
  ): Promise<InvitationResponse> {
    await findGroupForAdmin(projectId, groupId, user.id);
    await findInvitation(groupId, id);

    const [updated] = await whileStatusCurrent(() =>
      cipseqPrisma.$transaction([
        cipseqPrisma.groupInvitation.update({
          where: { id, status: 'PENDING_APPROVAL' },
          data: {
            status,
            reviewedByUserId: user.id,
            reviewedAt: new Date(),
          },
          select: INVITATION_FIELDS,
        }),
        auditEvent(user.id, action, projectId, { groupId, invitationId: id }),
      ]),
    );
    return toInvitationResponse(updated, projectId);
  }
}
