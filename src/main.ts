import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule, ObserveInstrument } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      instrument: ObserveInstrument,
    },
  );

  configureApp(app);

  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port, '0.0.0.0');

  console.log(`Application is running on port ${port}`);
}

await bootstrap();
