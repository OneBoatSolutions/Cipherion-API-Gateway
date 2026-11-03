import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { prisma } from '../lib/prisma.js';
import {
  DEFAULT_SETTINGS,
  SettingsResponse,
  UpdateSettingsDto,
} from './settings.dto.js';

const SETTINGS_FIELDS = {
  timezone: true,
  locale: true,
  securityAlerts: true,
} as const;

@ApiTags('dashboard')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@Controller('dashboard/settings')
export class SettingsController {
  // A user who never saved settings has no row yet and gets the defaults.
  @ApiOperation({ summary: "Get the signed-in user's settings" })
  @ApiOkResponse({ type: SettingsResponse })
  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<SettingsResponse> {
    const settings = await prisma.userSettings.findUnique({
      where: { userId: user.id },
      select: SETTINGS_FIELDS,
    });
    return settings ?? DEFAULT_SETTINGS;
  }

  @ApiOperation({ summary: "Update the signed-in user's settings" })
  @ApiOkResponse({ type: SettingsResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @Patch()
  update(
    @CurrentUser() user: AuthUser,
    @Body() { timezone, locale, securityAlerts }: UpdateSettingsDto,
  ): Promise<SettingsResponse> {
    // Fields that weren't sent are undefined, which Prisma leaves unchanged.
    const changes = { timezone, locale, securityAlerts };
    return prisma.userSettings.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...changes },
      update: changes,
      select: SETTINGS_FIELDS,
    });
  }
}
