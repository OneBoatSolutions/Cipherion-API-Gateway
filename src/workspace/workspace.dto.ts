import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupMemberResponse, GroupResponse } from '../cipseq/groups.dto.js';
import { InvitationResponse } from '../cipseq/invitations.dto.js';
import { ProjectResponse } from '../cipseq/projects.dto.js';
import { RemovalRequestResponse } from '../cipseq/removal-requests.dto.js';
import { ProfileResponse } from '../dashboard/profile.dto.js';
import { SettingsResponse } from '../dashboard/settings.dto.js';

export class WorkspaceMember extends GroupMemberResponse {
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null if the account no longer exists',
    example: 'Ada Lovelace',
  })
  name!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null if the account no longer exists',
    example: 'ada@cipherion.com',
  })
  email!: string | null;
}

export class WorkspaceGroup extends GroupResponse {
  @ApiProperty({ type: [WorkspaceMember] })
  members!: WorkspaceMember[];

  @ApiProperty({
    type: [InvitationResponse],
    description:
      'Open invitations. Empty unless the user is the project admin or an acting admin',
  })
  pendingInvitations!: InvitationResponse[];

  @ApiProperty({
    type: [RemovalRequestResponse],
    description:
      'Pending removal requests. Empty unless the user is the project admin or an acting admin',
  })
  pendingRemovals!: RemovalRequestResponse[];
}

export class WorkspaceProject extends ProjectResponse {
  @ApiProperty({
    type: [WorkspaceGroup],
    description:
      'The project admin gets every group, anyone else only the groups they belong to',
  })
  groups!: WorkspaceGroup[];
}

export const NOTIFICATION_TYPES = [
  'INVITATION_RECEIVED',
  'INVITATION_APPROVAL',
  'REMOVAL_APPROVAL',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const NULL_IF_GONE = 'Null if the account no longer exists';

// Something for the signed-in user to act on. The id is the invitation or request.
export class WorkspaceNotification {
  @ApiProperty({ enum: NOTIFICATION_TYPES })
  type!: NotificationType;

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ example: 'Payments' })
  projectName!: string;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 'Finance' })
  groupName!: string;

  @ApiProperty({ example: '2026-11-05T06:36:46.000Z' })
  createdAt!: Date;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: `Invitations only. ${NULL_IF_GONE}`,
  })
  invitedByName?: string | null;

  @ApiPropertyOptional({ description: 'INVITATION_APPROVAL only' })
  inviteeEmail?: string;

  @ApiPropertyOptional({ description: 'REMOVAL_APPROVAL only' })
  targetUserId?: string;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: `REMOVAL_APPROVAL only. ${NULL_IF_GONE}`,
  })
  targetName?: string | null;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: `REMOVAL_APPROVAL only. ${NULL_IF_GONE}`,
  })
  requestedByName?: string | null;
}

export class WorkspaceResponse {
  @ApiProperty({ type: ProfileResponse })
  profile!: ProfileResponse;

  @ApiProperty({ type: SettingsResponse })
  settings!: SettingsResponse;

  @ApiProperty({ type: [WorkspaceProject] })
  projects!: WorkspaceProject[];

  @ApiProperty({ type: [WorkspaceNotification] })
  notifications!: WorkspaceNotification[];
}
