import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const NAME_MAX_LENGTH = 100;

export class ProfileResponse {
  @ApiProperty({ example: 'y7GQvKJgV0mOa6vS1kq0nZ3d' })
  id!: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  name!: string;

  @ApiProperty({ example: 'ada@cipherion.com' })
  email!: string;

  @ApiProperty({ example: true })
  emailVerified!: boolean;

  @ApiProperty({ example: '2026-11-03T06:36:46.000Z' })
  createdAt!: Date;
}

export function toProfileResponse({
  id,
  name,
  email,
  emailVerified,
  createdAt,
}: ProfileResponse): ProfileResponse {
  return { id, name, email, emailVerified, createdAt };
}

// Email and password are changed through Better Auth's own endpoints
// (/api/v1/auth/change-email, /api/v1/auth/change-password), not here.
export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: NAME_MAX_LENGTH, example: 'Ada Lovelace' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  name?: string;
}
