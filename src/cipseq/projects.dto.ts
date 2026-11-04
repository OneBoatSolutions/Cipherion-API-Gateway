import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const PROJECT_NAME_MAX_LENGTH = 100;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;
export const PASSPHRASE_MIN_LENGTH = 12;
export const PASSPHRASE_MAX_LENGTH = 256;

export type ProjectRole = 'ADMIN' | 'MEMBER';

// Wrapped keys and salts stay in the database and are never part of a response.
export class ProjectResponse {
  @ApiProperty({
    format: 'uuid',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  id!: string;

  @ApiProperty({ example: 'Marketing Dept.' })
  name!: string;

  @ApiProperty({ example: 'Campaign plans and customer lists' })
  description!: string;

  @ApiProperty({
    enum: ['ADMIN', 'MEMBER'],
    description: "The signed-in user's role in the project",
    example: 'ADMIN',
  })
  role!: ProjectRole;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Current key version, null until the project is initialised',
    example: 1,
  })
  keyVersion!: number | null;

  @ApiProperty({ example: '2026-11-04T06:36:46.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-11-04T06:36:46.000Z' })
  updatedAt!: Date;
}

export class CreateProjectDto {
  @ApiProperty({ maxLength: PROJECT_NAME_MAX_LENGTH, example: 'Payments' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    maxLength: PROJECT_DESCRIPTION_MAX_LENGTH,
    example: 'Campaign plans and customer lists',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_DESCRIPTION_MAX_LENGTH)
  description!: string;
}

export class InitializeProjectDto {
  @ApiProperty({
    format: 'password',
    minLength: PASSPHRASE_MIN_LENGTH,
    maxLength: PASSPHRASE_MAX_LENGTH,
    description: 'Sent to the KMS and never stored',
  })
  @IsString()
  @MinLength(PASSPHRASE_MIN_LENGTH)
  @MaxLength(PASSPHRASE_MAX_LENGTH)
  passphrase!: string;
}

const isSent = (_: object, value: unknown) => value !== undefined;

// Every field is optional, so a client sends only what it changes. ValidateIf
// instead of IsOptional, which would let null through to these required columns.
export class UpdateProjectDto {
  @ApiPropertyOptional({
    maxLength: PROJECT_NAME_MAX_LENGTH,
    example: 'Payments',
  })
  @ValidateIf(isSent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    maxLength: PROJECT_DESCRIPTION_MAX_LENGTH,
    example: 'Campaign plans and customer lists',
  })
  @ValidateIf(isSent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_DESCRIPTION_MAX_LENGTH)
  description?: string;
}
