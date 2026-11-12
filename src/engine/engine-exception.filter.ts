import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

// The engine waits for Retry-After on 429 and 503. Anything that isn't an
// HttpException still goes to Nest's default handler.
@Catch(HttpException)
export class EngineExceptionFilter implements ExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status = error.getStatus();
    const body = error.getResponse();
    if (typeof body === 'object' && 'retryAfter' in body) {
      void reply.header('Retry-After', String(body.retryAfter));
    }
    void reply
      .status(status)
      .send(
        typeof body === 'string' ? { statusCode: status, message: body } : body,
      );
  }
}
