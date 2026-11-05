import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { isSent, PASSPHRASE_MAX_LENGTH } from './projects.dto.js';

export const GROUP_NAME_MAX_LENGTH = 100;
export const GROUP_DESCRIPTION_MAX_LENGTH = 500;

export const GROUP_ROLES = ['ADMIN', 'MEMBER'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

// Wrapped keys stay in the database and are never part of a response.
export class GroupResponse {
  @ApiProperty({
    format: 'uuid',
    example: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  projectId!: string;

  @ApiProperty({ example: 'Finance' })
  name!: string;

  @ApiProperty({ example: 'Invoices and payroll' })
  description!: string;

  @ApiProperty({
    enum: GROUP_ROLES,
    description: "The signed-in user's role in the group",
    example: 'ADMIN',
  })
  role!: GroupRole;

  @ApiProperty({
    type: 'integer',
    description: 'Current group data encryption key version',
    example: 1,
  })
  gdekVersion!: number;

  @ApiProperty({ example: '2026-11-05T06:36:46.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-11-05T06:36:46.000Z' })
  updatedAt!: Date;
}

export class GroupMemberResponse {
  @ApiProperty({ example: 'y7GQvKJgV0mOa6vS1kq0nZ3d' })
  userId!: string;

  @ApiProperty({ enum: GROUP_ROLES, example: 'MEMBER' })
  role!: GroupRole;

  @ApiProperty({ example: '2026-11-05T06:36:46.000Z' })
  createdAt!: Date;
}

export class CreateGroupDto {
  @ApiProperty({ maxLength: GROUP_NAME_MAX_LENGTH, example: 'Finance' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(GROUP_NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    maxLength: GROUP_DESCRIPTION_MAX_LENGTH,
    example: 'Invoices and payroll',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(GROUP_DESCRIPTION_MAX_LENGTH)
  description!: string;

  @ApiProperty({
    format: 'password',
    maxLength: PASSPHRASE_MAX_LENGTH,
    description: "The project's passphrase. Sent to the KMS and never stored",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSPHRASE_MAX_LENGTH)
  passphrase!: string;
}

export class GroupPassphraseDto {
  @ApiProperty({
    format: 'password',
    maxLength: PASSPHRASE_MAX_LENGTH,
    description: "The project's passphrase. Sent to the KMS and never stored",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSPHRASE_MAX_LENGTH)
  passphrase!: string;
}

// Every field is optional, so a client sends only what it changes. ValidateIf
// instead of IsOptional, which would let null through to these required columns.
export class UpdateGroupDto {
  @ApiPropertyOptional({ maxLength: GROUP_NAME_MAX_LENGTH, example: 'Finance' })
  @ValidateIf(isSent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(GROUP_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    maxLength: GROUP_DESCRIPTION_MAX_LENGTH,
    example: 'Invoices and payroll',
  })
  @ValidateIf(isSent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(GROUP_DESCRIPTION_MAX_LENGTH)
  description?: string;
}

export class UpdateGroupMemberDto {
  @ApiProperty({ enum: GROUP_ROLES, example: 'ADMIN' })
  @IsIn(GROUP_ROLES)
  role!: GroupRole;
}
