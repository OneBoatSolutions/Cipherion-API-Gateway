import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { DEFAULT_SETTINGS } from './../src/dashboard/settings.dto.js';
import { uniqueClientIp } from './helpers/client-ip.js';
import { deleteTestUser } from './helpers/delete-test-user.js';

// Runs against the .env.dev database; the test user (and, by cascade, its
// settings row) is removed afterwards.
describe('Dashboard settings (e2e)', () => {
  let app: NestFastifyApplication;
  let cookie: string;
  const email = `e2e-settings-${Date.now()}@cipherion.test`;
  const url = '/api/v1/dashboard/settings';

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
        name: 'E2E Settings User',
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

  it('returns the defaults before anything is saved', async () => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves a partial update and keeps the other fields', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url,
      headers: { cookie },
      payload: { timezone: 'Asia/Kolkata', securityAlerts: false },
    });
    expect(patch.statusCode).toBe(200);

    const expected = {
      timezone: 'Asia/Kolkata',
      locale: DEFAULT_SETTINGS.locale,
      securityAlerts: false,
    };
    expect(patch.json()).toEqual(expected);

    const get = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(get.json()).toEqual(expected);
  });

  it('rejects invalid values and unknown fields', async () => {
    const invalid = await app.inject({
      method: 'PATCH',
      url,
      headers: { cookie },
      payload: { timezone: 'Mars/Olympus', locale: 'not a locale' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      (invalid.json() as { errors: { property: string }[] }).errors.map(
        ({ property }) => property,
      ),
    ).toEqual(['timezone', 'locale']);

    const unknown = await app.inject({
      method: 'PATCH',
      url,
      headers: { cookie },
      payload: { theme: 'dark' },
    });
    expect(unknown.statusCode).toBe(400);
  });
});
