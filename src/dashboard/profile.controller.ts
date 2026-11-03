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
import { ProfileResponse, UpdateProfileDto } from './profile.dto.js';

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
  // Served from the session the guard already loaded, so no extra query.
  @ApiOperation({ summary: "Get the signed-in user's profile" })
  @ApiOkResponse({ type: ProfileResponse })
  @Get()
  get(@CurrentUser() user: AuthUser): ProfileResponse {
    const { id, name, email, emailVerified, createdAt } = user;
    return { id, name, email, emailVerified, createdAt };
  }

  // Goes through Better Auth rather than Prisma so the user cached with the
  // session in Redis is refreshed too.
  @ApiOperation({ summary: "Update the signed-in user's name" })
  @ApiOkResponse({ type: ProfileResponse })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @Patch()
  async update(
    @Req() request: FastifyRequest,
    @CurrentUser() user: AuthUser,
    @Body() { name }: UpdateProfileDto,
  ): Promise<ProfileResponse> {
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

    return prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: PROFILE_FIELDS,
    });
  }
}
