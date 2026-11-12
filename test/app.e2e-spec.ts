import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  // One app per file: closing it also closes the shared Prisma and Redis clients.
  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  it('/api/v1 (GET)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello Cipherion :)');
  });

  afterAll(async () => {
    await app.close();
  });
});
