import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export const USER_ID_MAX_LENGTH = 255;

export const REMOVAL_REQUEST_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type RemovalRequestStatus = (typeof REMOVAL_REQUEST_STATUSES)[number];

export class RemovalRequestResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 'y7GQvKJgV0mOa6vS1kq0nZ3d' })
  targetUserId!: string;

  @ApiProperty({ enum: REMOVAL_REQUEST_STATUSES, example: 'PENDING_APPROVAL' })
  status!: RemovalRequestStatus;

  @ApiProperty({ example: 'y7GQvKJgV0mOa6vS1kq0nZ3d' })
  requestedByUserId!: string;

  @ApiProperty({ example: '2026-11-05T06:36:46.000Z' })
  createdAt!: Date;
}

export class CreateRemovalRequestDto {
  @ApiProperty({
    maxLength: USER_ID_MAX_LENGTH,
    example: 'y7GQvKJgV0mOa6vS1kq0nZ3d',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(USER_ID_MAX_LENGTH)
  userId!: string;
}
