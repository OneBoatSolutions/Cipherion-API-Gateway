import {
  Body,
  Controller,
  Get,
  HttpException,
  Patch,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import { auth } from '../auth.js';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { prisma } from '../lib/prisma.js';
import { loadAccountType, toAccountTypeSummary } from './account-type.js';
import {
  ProfileResponse,
  ProfileWithAccountResponse,
  toProfileResponse,
  UpdateProfileDto,
} from './profile.dto.js';

const PROFILE_FIELDS = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  createdAt: true,
} as const;

@ApiTags('dashboard')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'No valid session' })
@Controller('dashboard/profile')
export class ProfileController {
  // The profile comes from the session the guard already loaded; only the
  // account type is read.
  @ApiOperation({ summary: "Get the signed-in user's profile" })
  @ApiOkResponse({ type: ProfileWithAccountResponse })
  @Get()
  async get(
    @CurrentUser() user: AuthUser,
  ): Promise<ProfileWithAccountResponse> {
    return withAccountType(toProfileResponse(user));
  }

  // Goes through Better Auth rather than Prisma so the user cached with the
  // session in Redis is refreshed too.
  @ApiOperation({ summary: "Update the signed-in user's name" })
  @ApiOkResponse({ type: ProfileWithAccountResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @Patch()
  async update(
    @Req() request: FastifyRequest,
    @CurrentUser() user: AuthUser,
    @Body() { name }: UpdateProfileDto,
  ): Promise<ProfileWithAccountResponse> {
    if (name === undefined) {
      return this.get(user);
    }

    await auth.api
      .updateUser({ headers: fromNodeHeaders(request.headers), body: { name } })
      .catch((error: unknown) => {
        if (error instanceof APIError) {
          throw new HttpException(
            error.body ?? error.message,
            error.statusCode,
          );
        }
        throw error;
      });

    return withAccountType(
      await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: PROFILE_FIELDS,
      }),
    );
  }
}

async function withAccountType(
  profile: Pick<ProfileResponse, keyof ProfileResponse>,
): Promise<ProfileWithAccountResponse> {
  return {
    ...profile,
    ...toAccountTypeSummary(await loadAccountType(profile.id)),
  };
}
