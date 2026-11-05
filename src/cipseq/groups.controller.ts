import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { kmsCall } from '../kms/kms-call.js';
import { cipseqPrisma } from '../lib/cipseq-prisma.js';
import { auditEvent } from './audit.js';
import {
  assertSameId,
  isRecordNotFound,
  isUniqueViolation,
} from './cipseq-errors.js';
import {
  currentGdekVersion,
  findGroupForAdmin,
  GROUP_FIELDS,
  toGroupResponse,
} from './group-access.js';
import {
  CreateGroupDto,
  GroupMemberResponse,
  GroupPassphraseDto,
  GroupResponse,
  UpdateGroupDto,
  UpdateGroupMemberDto,
} from './groups.dto.js';
import { findProjectForAdmin } from './project-access.js';
import { withPassphraseAttempt } from './with-passphrase-attempt.js';

const FIRST_GDEK_VERSION = 1;
const MEMBER_FIELDS = { userId: true, role: true, createdAt: true } as const;

// Creating, rotating and revoking all use this RPC, which makes a new group root
// key and GDEK each time. The passphrase goes to the KMS and is then dropped: it
// is never stored, logged or written to the audit trail.
async function createGroupKeys(
  projectId: string,
  groupId: string,
  passphrase: string,
) {
  const keys = await cipseqPrisma.projectKeys.findUniqueOrThrow({
    where: { projectId },
  });
  if (
    keys.userPassphraseSalt === null ||
    keys.wrappedProjectEncryptionKeyIv === null ||
    keys.wrappedProjectEncryptionKey === null ||
    keys.wrappedProjectEncryptionKeyTag === null
  ) {
    throw new ConflictException('The project is not initialised');
  }

  const wrapped = await kmsCall(
    'createAndWrapNewGroupRootKeyAndGroupDataEncryptionKey',
    {
      GroupId: groupId,
      WrappedProjectRootKeyIV: keys.wrappedProjectRootKeyIv,
      WrappedProjectRootKey: keys.wrappedProjectRootKey,
      WrappedProjectRootKeyTag: keys.wrappedProjectRootKeyTag,
      WrappedProjectEncryptionKeyIV: keys.wrappedProjectEncryptionKeyIv,
      WrappedProjectEncryptionKey: keys.wrappedProjectEncryptionKey,
      WrappedProjectEncryptionKeyTag: keys.wrappedProjectEncryptionKeyTag,
      UserPassphrase: passphrase,
      UserPassphraseSalt: keys.userPassphraseSalt,
    },
  );
  assertSameId(groupId, wrapped.GroupId);

  return {
    wrappedGroupRootKeyIv: wrapped.WrappedGroupRootKeyIV,
    wrappedGroupRootKey: wrapped.WrappedGroupRootKey,
    wrappedGroupRootKeyTag: wrapped.WrappedGroupRootKeyTag,
    wrappedGroupDataEncryptionKeyIv: wrapped.WrappedGroupDataEncryptionKeyIV,
    wrappedGroupDataEncryptionKey: wrapped.WrappedGroupDataEncryptionKey,
    wrappedGroupDataEncryptionKeyTag: wrapped.WrappedGroupDataEncryptionKeyTag,
  };
}

@ApiTags('cipseq')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@Controller('cipseq/projects/:projectId/groups')
export class GroupsController {
  @ApiOperation({
    summary: 'Create a group with the project admin as its admin',
  })
  @ApiCreatedResponse({ type: GroupResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({
    description: 'Not the project admin, or an incorrect passphrase',
  })
  @ApiNotFoundResponse({ description: 'No such project' })
  @ApiConflictResponse({ description: 'The project is not initialised' })
  @ApiTooManyRequestsResponse({ description: 'Too many incorrect passphrases' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  @ApiBadGatewayResponse({ description: 'The KMS call failed' })
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() { name, description, passphrase }: CreateGroupDto,
  ): Promise<GroupResponse> {
    const project = await findProjectForAdmin(projectId, user.id);
    if (project.keys?.currentKeyVersion == null) {
      throw new ConflictException('The project is not initialised');
    }

    const id = randomUUID();
    const group = await withPassphraseAttempt(projectId, async () => {
      const keys = await createGroupKeys(projectId, id, passphrase);
      const [created] = await cipseqPrisma.$transaction([
        cipseqPrisma.group.create({
          data: {
            id,
            projectId,
            name,
            description,
            keys: {
              create: { ...keys, currentGdekVersion: FIRST_GDEK_VERSION },
            },
            keyVersions: { create: { gdekVersion: FIRST_GDEK_VERSION } },
            members: { create: { userId: user.id, role: 'ADMIN' } },
          },
          select: GROUP_FIELDS,
        }),
        auditEvent(user.id, 'group.created', projectId, { groupId: id }),
      ]);
      return created;
    });
    return toGroupResponse(group, 'ADMIN');
  }

  @ApiOperation({ summary: "Update a group's name or description" })
  @ApiOkResponse({ type: GroupResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project or group' })
  @Patch(':groupId')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() { name, description }: UpdateGroupDto,
  ): Promise<GroupResponse> {
    const { group } = await findGroupForAdmin(projectId, groupId, user.id);

    // Fields that weren't sent are undefined, which Prisma leaves unchanged.
    const changes = { name, description };
    const changed = Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    if (changed.length === 0) {
      return toGroupResponse(group, 'ADMIN');
    }

    const [updated] = await cipseqPrisma.$transaction([
      cipseqPrisma.group.update({
        where: { id: groupId },
        data: changes,
        select: GROUP_FIELDS,
      }),
      auditEvent(user.id, 'group.updated', projectId, { groupId, changed }),
    ]);
    return toGroupResponse(updated, 'ADMIN');
  }

  // A soft delete: the rows and wrapped keys stay, but the API no longer serves
  // the group.
  @ApiOperation({ summary: 'Delete a group' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiBadRequestResponse({ description: 'Invalid id' })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project or group' })
  @HttpCode(204)
  @Delete(':groupId')
  async delete(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
  ): Promise<void> {
    await findGroupForAdmin(projectId, groupId, user.id);

    await cipseqPrisma.$transaction([
      cipseqPrisma.group.update({
        where: { id: groupId },
        data: { deletedAt: new Date() },
      }),
      auditEvent(user.id, 'group.deleted', projectId, { groupId }),
    ]);
  }

  // Replaces the wrapped group root key and GDEK, and bumps the version. The old
  // pair is overwritten, not kept.
  @ApiOperation({ summary: "Rotate a group's keys" })
  @ApiOkResponse({ type: GroupResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({
    description: 'Not the project admin, or an incorrect passphrase',
  })
  @ApiNotFoundResponse({ description: 'No such project or group' })
  @ApiConflictResponse({
    description: 'A concurrent rotation or revocation got there first',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many incorrect passphrases' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  @ApiBadGatewayResponse({ description: 'The KMS call failed' })
  @HttpCode(200)
  @Post(':groupId/rotate')
  async rotate(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() { passphrase }: GroupPassphraseDto,
  ): Promise<GroupResponse> {
    const { group } = await findGroupForAdmin(projectId, groupId, user.id);
    const fromVersion = currentGdekVersion(group);
    const toVersion = fromVersion + 1;

    await withPassphraseAttempt(projectId, async () => {
      const keys = await createGroupKeys(projectId, groupId, passphrase);
      try {
        await cipseqPrisma.$transaction([
          // The primary key rejects a second rotation from the same version.
          cipseqPrisma.groupKeyVersion.create({
            data: { groupId, gdekVersion: toVersion },
          }),
          cipseqPrisma.groupKeys.update({
            where: { groupId },
            data: { ...keys, currentGdekVersion: toVersion },
          }),
          auditEvent(user.id, 'group.key_rotated', projectId, {
            groupId,
            fromVersion,
            toVersion,
          }),
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException(
            'The group was rotated by another request',
          );
        }
        throw error;
      }
    });

    return toGroupResponse(
      { ...group, keys: { currentGdekVersion: toVersion } },
      'ADMIN',
    );
  }

  @ApiOperation({ summary: "Change a group member's role" })
  @ApiOkResponse({ type: GroupMemberResponse })
  @ApiBadRequestResponse({
    description: 'Validation failed, or the member is the project admin',
  })
  @ApiForbiddenResponse({ description: 'Not the project admin' })
  @ApiNotFoundResponse({ description: 'No such project, group or member' })
  @Patch(':groupId/members/:userId')
  async updateMember(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('userId') userId: string,
    @Body() { role }: UpdateGroupMemberDto,
  ): Promise<GroupMemberResponse> {
    const { project } = await findGroupForAdmin(projectId, groupId, user.id);
    if (userId === project.adminUserId) {
      throw new BadRequestException(
        "The project admin's group role can't be changed",
      );
    }

    try {
      const [member] = await cipseqPrisma.$transaction([
        cipseqPrisma.groupMember.update({
          where: { groupId_userId: { groupId, userId } },
          data: { role },
          select: MEMBER_FIELDS,
        }),
        auditEvent(user.id, 'group.member_role_changed', projectId, {
          groupId,
          targetUserId: userId,
          role,
        }),
      ]);
      return member;
    } catch (error) {
      if (isRecordNotFound(error)) {
        throw new NotFoundException();
      }
      throw error;
    }
  }

  // The member's removal and the new keys commit together, so a member is never
  // removed without a rotation. The project member row stays.
  @ApiOperation({
    summary: 'Revoke a member from a group and rotate its keys',
  })
  @ApiOkResponse({ type: GroupResponse })
  @ApiBadRequestResponse({
    description: 'Validation failed, or the member is the project admin',
  })
  @ApiForbiddenResponse({
    description: 'Not the project admin, or an incorrect passphrase',
  })
  @ApiNotFoundResponse({ description: 'No such project, group or member' })
  @ApiConflictResponse({
    description: 'A concurrent rotation or revocation got there first',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many incorrect passphrases' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unavailable' })
  @ApiBadGatewayResponse({ description: 'The KMS call failed' })
  @HttpCode(200)
  @Post(':groupId/members/:userId/revoke')
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('userId') userId: string,
    @Body() { passphrase }: GroupPassphraseDto,
  ): Promise<GroupResponse> {
    const { project, group } = await findGroupForAdmin(
      projectId,
      groupId,
      user.id,
    );
    if (userId === project.adminUserId) {
      throw new BadRequestException("The project admin can't be revoked");
    }
    // Checked before the KMS call, so a mistyped id doesn't use up an attempt.
    const member = await cipseqPrisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { userId: true },
    });
    if (!member) {
      throw new NotFoundException();
    }

    const fromVersion = currentGdekVersion(group);
    const toVersion = fromVersion + 1;

    await withPassphraseAttempt(projectId, async () => {
      const keys = await createGroupKeys(projectId, groupId, passphrase);
      try {
        await cipseqPrisma.$transaction([
          // The primary key rejects a second rotation from the same version.
          cipseqPrisma.groupKeyVersion.create({
            data: { groupId, gdekVersion: toVersion },
          }),
          cipseqPrisma.groupKeys.update({
            where: { groupId },
            data: { ...keys, currentGdekVersion: toVersion },
          }),
          cipseqPrisma.groupMember.delete({
            where: { groupId_userId: { groupId, userId } },
          }),
          auditEvent(user.id, 'group.member_revoked', projectId, {
            groupId,
            targetUserId: userId,
            fromVersion,
            toVersion,
          }),
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException(
            'The group was rotated by another request',
          );
        }
        if (isRecordNotFound(error)) {
          throw new NotFoundException();
        }
        throw error;
      }
    });

    return toGroupResponse(
      { ...group, keys: { currentGdekVersion: toVersion } },
      'ADMIN',
    );
  }
}
