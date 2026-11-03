import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { uniqueClientIp } from './helpers/client-ip.js';
import { deleteTestUser } from './helpers/delete-test-user.js';

// Runs against the .env.dev database; the test user is removed afterwards.
describe('Dashboard profile (e2e)', () => {
  let app: NestFastifyApplication;
  let cookie: string;
  const email = `e2e-profile-${Date.now()}@cipherion.test`;
  const url = '/api/v1/dashboard/profile';

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

    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: {
        origin: trustedOrigins[0],
        'x-forwarded-for': uniqueClientIp(),
      },
      payload: {
        name: 'E2E Profile User',
        email,
        password: 'e2e-password-123',
      },
    });
    expect(signUp.statusCode).toBe(200);
    cookie = signUp.cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  });

  afterAll(async () => {
    await deleteTestUser(email);
    await app.close();
  });

  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it('returns the profile of the signed-in user', async () => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const profile = response.json<Record<string, unknown>>();
    expect(profile).toMatchObject({
      name: 'E2E Profile User',
      email,
      emailVerified: false,
    });
    expect(Object.keys(profile).sort()).toEqual([
      'createdAt',
      'email',
      'emailVerified',
      'id',
      'name',
    ]);
  });

  it('renames the user, and the session sees the new name', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url,
      headers: { cookie },
      payload: { name: 'Renamed User' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ name: 'Renamed User', email });

    // GET reads the user cached with the session, so this checks the cache.
    const get = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(get.json()).toMatchObject({ name: 'Renamed User' });
  });

  it('rejects an empty name and fields other than name', async () => {
    for (const payload of [{ name: '' }, { email: 'other@cipherion.test' }]) {
      const response = await app.inject({
        method: 'PATCH',
        url,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
