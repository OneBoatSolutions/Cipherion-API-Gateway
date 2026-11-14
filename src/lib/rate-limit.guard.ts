import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  countInWindow,
  RATE_LIMIT_WINDOW_SECONDS,
  RATE_LIMITS,
  TOO_MANY_REQUESTS_MESSAGE,
} from './rate-limit.js';

// One bucket today, shared by every CipSeq and Dashboard write. A tighter one
// for some routes is a new name here and a limit in RATE_LIMITS.
export type RateLimitBucket = 'writes';

const LIMITS: Record<RateLimitBucket, () => number> = {
  writes: () => RATE_LIMITS.userWritesPerMinute,
};

const BUCKET = 'rateLimitBucket';

// Runs after the global AuthGuard, so request.user is set, and is keyed by it.
// Fails closed, like the session store: without Redis the limit can't be
// enforced, so the write answers 503.
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.get<RateLimitBucket>(
      BUCKET,
      context.getHandler(),
    );
    const http = context.switchToHttp();
    const { user } = http.getRequest<FastifyRequest>();
    if (!bucket || !user) {
      return true;
    }

    let count: number;
    try {
      count = await countInWindow(
        `ratelimit:user:${bucket}:${user.id}`,
        RATE_LIMIT_WINDOW_SECONDS,
      );
    } catch {
      throw new ServiceUnavailableException(
        'Unavailable. Please try again shortly.',
      );
    }
    if (count > LIMITS[bucket]()) {
      http
        .getResponse<FastifyReply>()
        .header('Retry-After', String(RATE_LIMIT_WINDOW_SECONDS));
      throw new HttpException(
        { statusCode: 429, message: TOO_MANY_REQUESTS_MESSAGE },
        429,
      );
    }
    return true;
  }
}

// On every write route of the main app: POST, PATCH, PUT and DELETE.
export const RateLimit = (bucket: RateLimitBucket = 'writes') =>
  applyDecorators(SetMetadata(BUCKET, bucket), UseGuards(RateLimitGuard));
