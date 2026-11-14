import {
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { trustedOrigins } from './config/env.js';
import { ipRateLimitHook } from './lib/ip-rate-limit.js';

export const API_PREFIX = 'api/v1';

// Shared by main.ts and the e2e tests so both run the same app configuration.
export function configureApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();

  app.enableCors({
    origin: trustedOrigins,
    credentials: true,
    // Every method a route uses must be listed, or browsers block it (Fastify's
    // default leaves out PATCH, PUT and DELETE).
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  app.useGlobalPipes(validationPipe());

  // Per client IP, before any route or session lookup (src/lib/ip-rate-limit.ts).
  app.getHttpAdapter().getInstance().addHook('onRequest', ipRateLimitHook);
}

// Shared with the engine listener, which doesn't use the rest of configureApp().
export function validationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    stopAtFirstError: false,
    exceptionFactory: (validationErrors: ValidationError[] = []) => {
      const errors = validationErrors.map((error) => ({
        property: error.property,
        constraints: error.constraints ? Object.values(error.constraints) : [],
      }));

      return new BadRequestException({
        message: 'Validation failed',
        errors,
      });
    },
  });
}
