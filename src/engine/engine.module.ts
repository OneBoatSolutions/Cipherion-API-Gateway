import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from '../auth/auth.guard.js';
import { CryptoController } from './crypto.controller.js';
import { DeviceCertificatesController } from './device-certificates.controller.js';
import { EngineDevicesController } from './engine-devices.controller.js';

// Everything reachable on the public engine port. A route that isn't mounted can't
// be reached, which is why this is its own module and not a URL allow-list. Not
// AuthModule, which would also mount sign-in here. Not HealthModule either: /ready
// names the gateway's dependencies, and monitoring can use the console port.
//
// It doesn't close the shared clients: AppModule owns those and outlives this app.
@Module({
  controllers: [
    EngineDevicesController,
    DeviceCertificatesController,
    CryptoController,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class EngineModule {}
