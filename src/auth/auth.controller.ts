import { All, Controller, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth.js';
import { Public } from './decorators/public.decorator.js';

// Forwards every /api/v1/auth/* request to the Better Auth handler.
@Public()
@Controller('auth')
export class AuthController {
  @All('*')
  async handle(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const url = new URL(req.url, `${req.protocol}://${req.host}`);
    const hasBody =
      req.method !== 'GET' && req.method !== 'HEAD' && req.body != null;

    const response = await auth
      .handler(
        new Request(url, {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          body: hasBody ? JSON.stringify(req.body) : undefined,
        }),
      )
      .catch((error: unknown) => {
        // The rate limiter runs before Better Auth's own error handling, so a
        // failure there (e.g. Redis down, 503) is thrown instead of returned.
        if (error instanceof APIError) {
          return Response.json(error.body, { status: error.statusCode });
        }
        throw error;
      });

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') {
        reply.header(key, value);
      }
    });

    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) {
      reply.header('set-cookie', cookies);
    }

    reply.send(response.body ? await response.text() : null);
  }
}
