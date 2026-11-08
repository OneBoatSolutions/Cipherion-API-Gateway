import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule, ObserveInstrument } from './app.module.js';
import { configureApp } from './app.setup.js';
import { watchCertificateExpiry } from './engine/certificate-expiry.js';
import { engineEnabled, startEngineApp } from './engine/engine-app.js';
import { engineTlsOptions } from './engine/engine-tls.js';
import { checkDatabasesOnStartup } from './lib/startup-checks.js';
import { setupOpenApi } from './openapi.js';

async function bootstrap() {
  // Exits with code 1 if either database is unreachable.
  await checkDatabasesOnStartup();

  // Created first, because AppModule is what validates the environment.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      instrument: ObserveInstrument,
    },
  );

  configureApp(app);
  await setupOpenApi(app);

  // Before either port opens, so a wrong key or pin never serves anything.
  const engineTls = engineEnabled() ? engineTlsOptions() : undefined;

  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port, '0.0.0.0');

  console.log(`Application is running on port ${port}`);

  if (engineTls) {
    await startEngineApp(engineTls);
  }
  watchCertificateExpiry();
}

await bootstrap();
