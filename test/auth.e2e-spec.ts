import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { redis } from './../src/lib/redis.js';
import { deleteTestUser } from './helpers/delete-test-user.js';

// Runs against the .env.dev database; the test user is removed afterwards.
describe('Auth (e2e)', () => {
  let app: NestFastifyApplication;
  const email = `e2e-${Date.now()}@cipherion.test`;
  const password = 'e2e-password-123';
  const origin = trustedOrigins[0];

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

  afterAll(async () => {
    await deleteTestUser(email);
    await app.close();
  });

  it('signs up, signs in and returns the session', async () => {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { origin },
      payload: { name: 'E2E User', email, password },
    });

    expect(signUp.statusCode).toBe(200);
    expect(signUp.json().user.email).toBe(email);

    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { origin },
      payload: { email, password },
    });

    expect(signIn.statusCode).toBe(200);
    const cookie = signIn.cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    expect(cookie).toContain('session_token');

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/get-session',
      headers: { cookie },
    });

    expect(session.statusCode).toBe(200);
    expect(session.json().user.email).toBe(email);
  });

  it('caches the session in Redis and revokes it on sign-out', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { origin },
      payload: { email, password },
    });
    const cookie = signIn.cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    const getSession = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/auth/get-session',
        headers: { cookie },
      });

    const { token } = (await getSession()).json().session;
    expect(await redis.get(token)).not.toBeNull();

    // A missing Redis entry falls back to the database copy.
    await redis.del(token);
    expect((await getSession()).json().user.email).toBe(email);

    const signOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { origin, cookie },
      payload: {},
    });
    expect(signOut.statusCode).toBe(200);
    expect(await redis.get(token)).toBeNull();
    expect((await getSession()).json()).toBeNull();
  });

  it('returns no session without a cookie', async () => {
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/get-session',
    });

    expect(session.statusCode).toBe(200);
    expect(session.json()).toBeNull();
  });

  it('answers CORS preflight for trusted origins only', async () => {
    const preflight = (requestOrigin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/api/v1/auth/sign-in/email',
        headers: {
          origin: requestOrigin,
          'access-control-request-method': 'POST',
        },
      });

    const trusted = await preflight(origin);
    expect(trusted.headers['access-control-allow-origin']).toBe(origin);
    expect(trusted.headers['access-control-allow-credentials']).toBe('true');

    const untrusted = await preflight('https://evil.example');
    expect(untrusted.headers['access-control-allow-origin']).toBeUndefined();
  });
});
