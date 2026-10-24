import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com,
    // then run `npx @nestjs/observe link` to write your key pair into .env.

    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: existsSync(resolve('.env'))
        ? '.env'
        : process.env.NODE_ENV === 'production'
          ? '.env.prod'
          : '.env.dev',
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),

        PORT: Joi.number().port().default(3000),

        DATABASE_URL: Joi.string()
          .uri({ scheme: ['postgresql', 'postgres'] })
          .required(),

        OBSERVE_APP_KEY: Joi.string().optional(),
        OBSERVE_APP_SECRET: Joi.string().optional(),
      }),
    }),

    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'Cipherion-API_Gateway',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
