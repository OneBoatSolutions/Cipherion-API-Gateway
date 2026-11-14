import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { RATE_LIMIT_DEFAULTS, RATE_LIMITS } from './../src/lib/rate-limit.js';
import { uniqueClientIp } from './helpers/client-ip.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { type SignedInUser, signUpVerified } from './helpers/users.js';

// The per-user write limit and the per-IP limit at their defaults (setup-e2e.ts
// lifts them for every other file). Counts live in Redis and other files run at
// the same time, so every request here comes from its own uniqueClientIp().
describe('Rate limits (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = Date.now();
  const emails: string[] = [];
  let first: SignedInUser;
  let second: SignedInUser;

  const request = (
    method: 'GET' | 'PATCH',
    path: string,
    ip: string,
    user?: SignedInUser,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        'x-forwarded-for': ip,
        ...(user ? { cookie: user.cookie } : {}),
      },
      payload,
    });

  const signUp = (name: string) => {
    const email = `e2e-ratelimit-${name}-${stamp}@cipherion.test`;
    emails.push(email);
    return signUpVerified(app, `E2E ${name}`, email);
  };

  beforeAll(async () => {
    Object.assign(RATE_LIMITS, RATE_LIMIT_DEFAULTS);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    first = await signUp('first');
    second = await signUp('second');
  });

  afterAll(async () => {
    for (const email of emails) {
      await deleteTestUser(email);
    }
    await app.close();
  });

  it('allows 60 writes a minute per user, then answers 429 with Retry-After', async () => {
    const ip = uniqueClientIp();
    const write = () =>
      request('PATCH', '/dashboard/settings', ip, first, {
        securityAlerts: true,
      });
    for (let i = 0; i < 60; i++) {
      const response = await write();
      expect(response.statusCode, response.body).toBe(200);
    }
    const refused = await write();
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.json()).toEqual({
      statusCode: 429,
      message: 'Too many requests. Please wait a moment and try again.',
    });

    // Reads aren't limited per user, and another user has their own count.
    expect(
      (await request('GET', '/dashboard/settings', ip, first)).statusCode,
    ).toBe(200);
    const other = await request('PATCH', '/dashboard/settings', ip, second, {
      securityAlerts: true,
    });
    expect(other.statusCode, other.body).toBe(200);
  });

  it('allows 600 requests a minute per IP, then answers 429; other IPs get through', async () => {
    const ip = uniqueClientIp();
    // Unauthenticated: the limit runs before the session lookup.
    for (let i = 0; i < 600; i++) {
      const response = await request('GET', '/cipseq/projects', ip);
      expect(response.statusCode).toBe(401);
    }
    const refused = await request('GET', '/cipseq/projects', ip);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');

    expect(
      (await request('GET', '/cipseq/projects', uniqueClientIp())).statusCode,
    ).toBe(401);
    // Probes are never limited.
    expect((await request('GET', '/health', ip)).statusCode).toBe(200);
  });
});
