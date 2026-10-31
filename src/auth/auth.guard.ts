import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { auth, SESSION_STORE_UNAVAILABLE } from '../auth.js';
import { IS_PUBLIC_KEY } from './decorators/public.decorator.js';

// Registered globally: every route needs a valid session unless it is @Public().
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const result = await auth.api
      .getSession({ headers: fromNodeHeaders(request.headers) })
      .catch((error: unknown) => {
        // Without the session store the session can't be checked: fail closed with 503.
        if (error instanceof APIError && error.statusCode === 503) {
          throw new ServiceUnavailableException(SESSION_STORE_UNAVAILABLE);
        }
        throw error;
      });

    if (!result) {
      throw new UnauthorizedException();
    }

    request.user = result.user;
    request.session = result.session;

    return true;
  }
}
