import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule, ObserveInstrument } from './app.module.js';
import { configureApp } from './app.setup.js';
import { checkDatabasesOnStartup } from './lib/startup-checks.js';
import { setupOpenApi } from './openapi.js';

async function bootstrap() {
  // Exits with code 1 if either database is unreachable.
  await checkDatabasesOnStartup();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      instrument: ObserveInstrument,
    },
  );

  configureApp(app);
  await setupOpenApi(app);

  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port, '0.0.0.0');

  console.log(`Application is running on port ${port}`);
}

await bootstrap();
