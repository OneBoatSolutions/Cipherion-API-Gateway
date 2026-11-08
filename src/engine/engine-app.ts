import type { TlsOptions } from 'node:tls';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { API_PREFIX, validationPipe } from '../app.setup.js';
import { EngineExceptionFilter } from './engine-exception.filter.js';
import { ipRequestLimitHook } from './engine-limits.js';
import { EngineModule } from './engine.module.js';

const MAX_CONNECTIONS = 5000;
const HEADERS_TIMEOUT_MS = 10_000;
// Below the 10 seconds a container usually gets between SIGTERM and SIGKILL.
const SHUTDOWN_GRACE_MS = 8000;

let engineApp: NestFastifyApplication | undefined;

// Read directly: ConfigModule doesn't write Joi's defaults back to process.env.
export const engineEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DEVICE_ENGINE_ENABLED?.toLowerCase() === 'true';

// Separate from the console app because it has different rules: its own TLS, no
// CORS, no proxy, and a small body limit. It doesn't call configureApp(), and it has
// no shutdown hooks of its own: AppModule closes it first (see app.module.ts).
export async function createEngineApp(
  tls: TlsOptions,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    EngineModule,
    new FastifyAdapter({
      https: tls,
      // The largest legitimate body is an ML-KEM-1024 key, about 2.1 KB.
      bodyLimit: 8192,
      // Identity comes from this socket only.
      trustProxy: false,
      requestTimeout: 15_000,
      keepAliveTimeout: 60_000,
    }),
    { abortOnError: false },
  );
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(validationPipe());
  app.useGlobalFilters(new EngineExceptionFilter());

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', ipRequestLimitHook);
  fastify.addHook('onSend', async (_request, reply) => {
    void reply.header('Cache-Control', 'no-store');
  });
  const server = app.getHttpServer();
  server.maxConnections = MAX_CONNECTIONS;
  // A client that connects and never sends a request can't hold a slot on this
  // public port for long.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return app;
}

// Waits for requests in flight, but a connected client can't hold up shutdown: idle
// connections close at once, and anything left closes when the grace period ends.
export async function closeEngine(
  app: NestFastifyApplication,
  graceMs: number = SHUTDOWN_GRACE_MS,
): Promise<void> {
  const server = app.getHttpServer();
  const deadline = setTimeout(() => server.closeAllConnections(), graceMs);
  try {
    const closing = app.close();
    server.closeIdleConnections();
    await closing;
  } finally {
    clearTimeout(deadline);
  }
}

export async function startEngineApp(tls: TlsOptions): Promise<void> {
  const app = await createEngineApp(tls);
  const port = Number(process.env.DEVICE_ENGINE_PORT ?? 3443);
  await app.listen(port, process.env.DEVICE_ENGINE_HOST ?? '0.0.0.0');
  engineApp = app;
  new Logger('Engine').log(`Engine listener is running on port ${port}`);
}

export const closeEngineApp = async (): Promise<void> => {
  if (engineApp) {
    await closeEngine(engineApp);
    engineApp = undefined;
  }
};
