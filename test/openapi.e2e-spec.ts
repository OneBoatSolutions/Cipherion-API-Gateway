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

  it('documents the dashboard routes behind the session cookie', () => {
    for (const path of ['profile', 'settings']) {
      const route = document.paths[`/api/v1/dashboard/${path}`];

      expect(route.get?.tags).toEqual(['dashboard']);
      expect(route.patch?.security).toEqual([{ cookie: [] }]);
    }
    expect(document.components?.schemas).toHaveProperty('UpdateProfileDto');
    expect(document.components?.schemas).toHaveProperty('UpdateSettingsDto');
  });

  it('documents the account type, set once with a 409', () => {
    const route = document.paths['/api/v1/dashboard/account-type'];

    expect(route.get?.tags).toEqual(['dashboard']);
    expect(Object.keys(route.put?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '409',
    ]);
    const schemas = document.components?.schemas ?? {};
    expect(schemas).toHaveProperty('SetAccountTypeDto');
    for (const name of [
      'AccountTypeResponse',
      'ProfileWithAccountResponse',
      'SettingsWithAccountResponse',
    ]) {
      expect(JSON.stringify(schemas[name])).toContain('accountType');
    }
    expect(JSON.stringify(schemas.WorkspaceResponse)).toContain('"account"');
  });

  it('documents the metrics endpoints fully for the frontend', () => {
    const parameters = (path: string) =>
      Object.fromEntries(
        (document.paths[path].get?.parameters ?? []).map((parameter) => {
          const { name, required, schema } = parameter as {
            name: string;
            required?: boolean;
            schema?: { enum?: string[] };
          };
          return [name, { required: Boolean(required), enum: schema?.enum }];
        }),
      );

    const leaderboard =
      document.paths['/api/v1/cipseq/metrics/leaderboard'].get;
    expect(leaderboard?.tags).toEqual(['cipseq']);
    expect(leaderboard?.description).toContain('| `today` |');
    expect(parameters('/api/v1/cipseq/metrics/leaderboard')).toEqual({
      period: {
        required: false,
        enum: ['today', 'week', 'month', 'year', 'all'],
      },
    });
    expect(Object.keys(leaderboard?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
    ]);

    const usage = document.paths['/api/v1/cipseq/metrics/usage'].get;
    expect(parameters('/api/v1/cipseq/metrics/usage')).toEqual({
      scope: {
        required: true,
        enum: ['project', 'group', 'user', 'device'],
      },
      id: { required: true, enum: undefined },
      period: { required: true, enum: ['today', 'week', 'month', 'year'] },
    });
    expect(Object.keys(usage?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '404',
    ]);
    const examples = (
      (usage?.responses ?? {})['200'] as unknown as {
        content: { 'application/json': { examples: Record<string, unknown> } };
      }
    ).content['application/json'].examples;
    expect(Object.keys(examples)).toEqual(['today', 'week', 'year']);

    const schemas = document.components?.schemas ?? {};
    for (const name of [
      'MetricsTotals',
      'MetricsBucket',
      'LeaderboardProject',
      'LeaderboardUser',
      'LeaderboardDevice',
      'LeaderboardResponse',
      'UsageResponse',
    ]) {
      expect(schemas, name).toHaveProperty(name);
    }
    expect(schemas.MetricsBucket).toMatchObject({
      properties: {
        start: { type: 'string', format: 'date-time' },
        encryptions: { type: 'integer' },
      },
    });
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
