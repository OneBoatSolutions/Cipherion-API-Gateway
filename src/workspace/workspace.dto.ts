import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DeviceResponse,
  GROUP_DEVICE_STATUSES,
  type GroupDeviceStatus,
} from '../cipseq/devices.dto.js';
import { GroupMemberResponse, GroupResponse } from '../cipseq/groups.dto.js';
import { InvitationResponse } from '../cipseq/invitations.dto.js';
import { ProjectResponse } from '../cipseq/projects.dto.js';
import { ProfileResponse } from '../dashboard/profile.dto.js';
import { SettingsResponse } from '../dashboard/settings.dto.js';
import type {
  EnvelopeJobFailure,
  EnvelopeJobKind,
} from '../generated/cipseq/enums.js';

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

export class WorkspaceGroupDevice {
  @ApiProperty({ example: 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
  deviceId!: string;

  @ApiProperty({ type: 'string', nullable: true, example: 'Work laptop' })
  name!: string | null;

  @ApiProperty({ example: 'y7GQvKJgV0mOa6vS1kq0nZ3d' })
  userId!: string;

  @ApiProperty({ enum: GROUP_DEVICE_STATUSES, example: 'APPROVED' })
  status!: GroupDeviceStatus;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Null until the device has an envelope for this group',
    example: 1,
  })
  latestEnvelopeVersion!: number | null;
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
    type: [WorkspaceGroupDevice],
    description:
      'Devices with an open approval. Empty unless the user is the project admin or an acting admin. Never includes an envelope',
  })
  devices!: WorkspaceGroupDevice[];
}

export class WorkspaceProject extends ProjectResponse {
  @ApiProperty({
    type: [WorkspaceGroup],
    description:
      'The project admin gets every group, anyone else only the groups they belong to',
  })
  groups!: WorkspaceGroup[];
}

export class WorkspaceDeviceGroup {
  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 'Finance' })
  groupName!: string;

  @ApiProperty({ enum: GROUP_DEVICE_STATUSES, example: 'APPROVED' })
  status!: GroupDeviceStatus;
}

export class WorkspaceDevice extends DeviceResponse {
  @ApiProperty({ type: [WorkspaceDeviceGroup] })
  groups!: WorkspaceDeviceGroup[];
}

export const NOTIFICATION_TYPES = [
  'INVITATION_RECEIVED',
  'INVITATION_APPROVAL',
  'DEVICE_APPROVAL',
  'ENVELOPES_IN_PROGRESS',
  'ENVELOPES_COMPLETED',
  'ENVELOPES_MISSING',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const NULL_IF_GONE = 'Null if the account no longer exists';

export class WorkspaceNotificationGroup {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Finance' })
  name!: string;
}

// Something for the signed-in user to act on. The id is the invitation, request,
// device or group the notification is about.
export class WorkspaceNotification {
  @ApiProperty({ enum: NOTIFICATION_TYPES })
  type!: NotificationType;

  @ApiProperty()
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ example: 'Payments' })
  projectName!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Not on DEVICE_APPROVAL',
  })
  groupId?: string;

  @ApiPropertyOptional({
    example: 'Finance',
    description: 'Not on DEVICE_APPROVAL',
  })
  groupName?: string;

  @ApiProperty({ example: '2026-11-05T06:36:46.000Z' })
  createdAt!: Date;

  @ApiPropertyOptional({
    type: [WorkspaceNotificationGroup],
    description: 'DEVICE_APPROVAL only: the groups the device is waiting for',
  })
  groups?: WorkspaceNotificationGroup[];

  @ApiPropertyOptional({ description: 'DEVICE_APPROVAL only' })
  deviceId?: string;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: 'DEVICE_APPROVAL only',
  })
  deviceName?: string | null;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: `DEVICE_APPROVAL only: the device's user. ${NULL_IF_GONE}`,
  })
  deviceUserName?: string | null;

  @ApiPropertyOptional({
    type: 'integer',
    description:
      'ENVELOPES_IN_PROGRESS and ENVELOPES_MISSING: the envelopes still to create',
  })
  missingCount?: number;

  @ApiPropertyOptional({
    enum: ['ROTATION', 'APPROVAL', 'RENEWAL'],
    description:
      "What started the job, on the ENVELOPES_ types. A renewal keeps the kind of the job it resumes. Not on ENVELOPES_MISSING if the job didn't get to record itself",
  })
  jobKind?: EnvelopeJobKind;

  @ApiPropertyOptional({
    enum: ['WRONG_PASSPHRASE', 'KMS_UNAVAILABLE', 'INTERRUPTED'],
    description:
      'ENVELOPES_MISSING only: why it stopped. The project admin resumes it by entering the passphrase on the renew route',
  })
  failureReason?: EnvelopeJobFailure;

  @ApiPropertyOptional({
    type: 'integer',
    description:
      'ENVELOPES_COMPLETED only: the envelopes missing when the job started',
  })
  envelopeCount?: number;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: `Invitations only. ${NULL_IF_GONE}`,
  })
  invitedByName?: string | null;

  @ApiPropertyOptional({ description: 'INVITATION_APPROVAL only' })
  inviteeEmail?: string;
}

export class WorkspaceResponse {
  @ApiProperty({ type: ProfileResponse })
  profile!: ProfileResponse;

  @ApiProperty({ type: SettingsResponse })
  settings!: SettingsResponse;

  @ApiProperty({ type: [WorkspaceProject] })
  projects!: WorkspaceProject[];

  @ApiProperty({
    type: [WorkspaceDevice],
    description: "The signed-in user's devices and their status per group",
  })
  devices!: WorkspaceDevice[];

  @ApiProperty({ type: [WorkspaceNotification] })
  notifications!: WorkspaceNotification[];
}
