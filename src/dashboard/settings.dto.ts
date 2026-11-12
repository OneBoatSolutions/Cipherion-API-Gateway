import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { IsBoolean, IsLocale, IsOptional, IsTimeZone } from 'class-validator';
import { AccountTypeSummary } from './account-type.dto.js';

export const SETTINGS_FIELDS = {
  timezone: true,
  locale: true,
  securityAlerts: true,
} as const;

// Same values as the column defaults on UserSettings in prisma/schema.prisma.
export const DEFAULT_SETTINGS = {
  timezone: 'UTC',
  locale: 'en',
  securityAlerts: true,
} satisfies SettingsResponse;

export class SettingsResponse {
  @ApiProperty({ description: 'IANA timezone', example: 'Asia/Kolkata' })
  timezone!: string;

  @ApiProperty({ description: 'BCP 47 language tag', example: 'en-IN' })
  locale!: string;

  @ApiProperty({
    description: 'Show in-app alerts for security events',
    example: true,
  })
  securityAlerts!: boolean;
}

// The settings from GET and PATCH /dashboard/settings. The account type is
// read-only here: it's chosen through PUT /dashboard/account-type. /workspace
// returns it once at its top level instead, so it keeps SettingsResponse.
export class SettingsWithAccountResponse extends IntersectionType(
  SettingsResponse,
  AccountTypeSummary,
) {}

// Every field is optional, so a client sends only what it changes.
export class UpdateSettingsDto {
  @ApiPropertyOptional({
    description: 'IANA timezone',
    example: 'Asia/Kolkata',
  })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ description: 'BCP 47 language tag', example: 'en-IN' })
  @IsOptional()
  @IsLocale()
  locale?: string;

  @ApiPropertyOptional({
    description: 'Show in-app alerts for security events',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  securityAlerts?: boolean;
}
