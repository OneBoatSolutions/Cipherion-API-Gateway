import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { setupOpenApi } from './../src/openapi.js';

describe('OpenAPI docs (e2e)', () => {
  let app: NestFastifyApplication;
  let document: OpenAPIObject;

  // One app per file: closing it also closes the shared Prisma and Redis clients.
  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await setupOpenApi(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/docs-json',
    });
    expect(response.statusCode).toBe(200);
    document = response.json();
  });

  it('serves Swagger UI without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/docs' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('documents the gateway routes under /api/v1', () => {
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/api/v1', '/api/v1/health', '/api/v1/ready']),
    );
    expect(document.paths['/api/v1/ready'].get?.responses).toHaveProperty(
      '503',
    );
  });

  it('lists the Better Auth endpoints instead of the wildcard route', () => {
    const signIn = document.paths['/api/v1/auth/sign-in/email'].post;

    expect(signIn?.tags).toEqual(['auth']);
    expect(signIn?.security).toBeUndefined();
    expect(document.paths).toHaveProperty('/api/v1/auth/get-session');
    expect(Object.keys(document.paths).some((p) => p.includes('*'))).toBe(
      false,
    );
    expect(document.components?.schemas).toHaveProperty('User');
  });

  afterAll(async () => {
    await app.close();
  });
});
