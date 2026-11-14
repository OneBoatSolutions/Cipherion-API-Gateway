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
import { loadAccountType, toAccountTypeSummary } from './account-type.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  SettingsWithAccountResponse,
  UpdateSettingsDto,
} from './settings.dto.js';
import { RateLimit } from '../lib/rate-limit.guard.js';

@ApiTags('dashboard')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@Controller('dashboard/settings')
export class SettingsController {
  // A user who never saved settings has no row yet and gets the defaults.
  @ApiOperation({ summary: "Get the signed-in user's settings" })
  @ApiOkResponse({ type: SettingsWithAccountResponse })
  @Get()
  async get(
    @CurrentUser() user: AuthUser,
  ): Promise<SettingsWithAccountResponse> {
    const [settings, account] = await Promise.all([
      prisma.userSettings.findUnique({
        where: { userId: user.id },
        select: SETTINGS_FIELDS,
      }),
      loadAccountType(user.id),
    ]);
    return {
      ...(settings ?? DEFAULT_SETTINGS),
      ...toAccountTypeSummary(account),
    };
  }

  // The account type is read-only here; it's chosen through
  // PUT /dashboard/account-type.
  @ApiOperation({ summary: "Update the signed-in user's settings" })
  @ApiOkResponse({ type: SettingsWithAccountResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @RateLimit()
  @Patch()
  async update(
    @CurrentUser() user: AuthUser,
    @Body() { timezone, locale, securityAlerts }: UpdateSettingsDto,
  ): Promise<SettingsWithAccountResponse> {
    // Fields that weren't sent are undefined, which Prisma leaves unchanged.
    const changes = { timezone, locale, securityAlerts };
    const [settings, account] = await Promise.all([
      prisma.userSettings.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...changes },
        update: changes,
        select: SETTINGS_FIELDS,
      }),
      loadAccountType(user.id),
    ]);
    return { ...settings, ...toAccountTypeSummary(account) };
  }
}
