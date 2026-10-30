import {
  BadRequestException,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { trustedOrigins } from './config/env.js';

export const API_PREFIX = 'api/v1';

// Shared by main.ts and the e2e tests so both run the same app configuration.
export function configureApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix(API_PREFIX);

  app.enableCors({
    origin: trustedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      stopAtFirstError: false,
      exceptionFactory: (validationErrors: ValidationError[] = []) => {
        const errors = validationErrors.map((error) => ({
          property: error.property,
          constraints: error.constraints
            ? Object.values(error.constraints)
            : [],
        }));

        return new BadRequestException({
          message: 'Validation failed',
          errors,
        });
      },
    }),
  );
}
