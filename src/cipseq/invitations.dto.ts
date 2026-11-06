import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export const EMAIL_MAX_LENGTH = 254;

export const INVITATION_STATUSES = [
  'PENDING_APPROVAL',
  'REJECTED',
  'PENDING_ACCEPTANCE',
  'ACCEPTED',
  'DECLINED',
  'CANCELLED',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export class InvitationResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 'ada@cipherion.com' })
  inviteeEmail!: string;

  @ApiProperty({ enum: INVITATION_STATUSES, example: 'PENDING_ACCEPTANCE' })
  status!: InvitationStatus;

  @ApiProperty({ example: 'y7GQvKJgV0mOa6vS1kq0nZ3d' })
  invitedByUserId!: string;

  @ApiProperty({ example: '2026-11-05T06:36:46.000Z' })
  createdAt!: Date;
}

export class CreateInvitationDto {
  @ApiProperty({ maxLength: EMAIL_MAX_LENGTH, example: 'ada@cipherion.com' })
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;
}
