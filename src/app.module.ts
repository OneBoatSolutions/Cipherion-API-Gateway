import { Module, OnApplicationShutdown } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { envFilePath } from './config/env.js';
import { envSchema } from './config/env.schema.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com,
    // then run `npx @nestjs/observe link` to write your key pair into .env.

    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath,
      validationSchema: envSchema,
    }),

    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'Cipherion-API_Gateway',
    }),

    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements OnApplicationShutdown {
  // The shared clients live for the whole process, so close them with the app.
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([redis.quit(), prisma.$disconnect()]);
  }
}
