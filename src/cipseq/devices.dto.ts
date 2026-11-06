import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { isSent } from './projects.dto.js';

export const DEVICE_ID_PATTERN = /^dvc_[A-Za-z0-9_-]{43}$/;
export const DEVICE_NAME_MAX_LENGTH = 100;
// ML-KEM-1024 public keys are 1568 bytes, which is at most 2092 base64 characters.
export const ML_KEM_1024_PUBLIC_KEY_BYTES = 1568;
export const PUBLIC_KEY_MAX_LENGTH = 2092;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

export const DEVICE_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const GROUP_DEVICE_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'REVOKED',
] as const;
export type GroupDeviceStatus = (typeof GROUP_DEVICE_STATUSES)[number];

export const OPEN_DEVICE_STATUSES = ['PENDING_APPROVAL', 'APPROVED'] as const;

export class DeviceResponse {
  @ApiProperty({ example: 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
  id!: string;

  @ApiProperty({ type: 'string', nullable: true, example: 'Work laptop' })
  name!: string | null;

  @ApiProperty({ enum: DEVICE_STATUSES, example: 'ACTIVE' })
  status!: DeviceStatus;

  @ApiProperty({ example: '2026-11-06T06:36:46.000Z' })
  createdAt!: Date;
}

export class RegisterDeviceDto {
  @ApiProperty({
    description: 'dvc_ plus 43 base64url characters, supplied by the device',
    example: 'dvc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  @IsString()
  @Matches(DEVICE_ID_PATTERN)
  deviceId!: string;

  @ApiProperty({
    maxLength: PUBLIC_KEY_MAX_LENGTH,
    description:
      "The device's ML-KEM-1024 public key, in base64 or base64url. It decodes to 1568 bytes",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PUBLIC_KEY_MAX_LENGTH)
  @Matches(BASE64_PATTERN)
  publicKey!: string;

  @ApiPropertyOptional({
    maxLength: DEVICE_NAME_MAX_LENGTH,
    example: 'Work laptop',
  })
  @ValidateIf(isSent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(DEVICE_NAME_MAX_LENGTH)
  name?: string;
}

export class EnvelopesToCreateResponse {
  @ApiProperty({
    type: 'integer',
    description:
      'Envelopes the background job still has to create. Anything it can not finish shows as ENVELOPES_MISSING',
    example: 2,
  })
  envelopesToCreate!: number;
}
