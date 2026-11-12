import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { mailer } from './../src/lib/mailer.js';
import { prisma } from './../src/lib/prisma.js';
import { redis } from './../src/lib/redis.js';
import { uniqueClientIp } from './helpers/client-ip.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { cookieOf, signUpVerified } from './helpers/users.js';

// Runs against the .env.dev database; the test users are removed afterwards.
// test/setup-e2e.ts replaces the mailer, so the links are read from its calls.
describe('Auth (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = Date.now();
  const email = `e2e-${stamp}@cipherion.test`;
  const resetEmail = `e2e-reset-${stamp}@cipherion.test`;
  const burstEmail = `e2e-burst-${stamp}@cipherion.test`;
  const password = 'e2e-password-123';
  const origin = trustedOrigins[0];
  const callbackURL = `${origin}/verified`;
  const send = vi.mocked(mailer.send);

  const post = (url: string, payload: object, extra: object = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/auth${url}`,
      headers: { origin, 'x-forwarded-for': uniqueClientIp(), ...extra },
      payload,
    });

  const signIn = (address: string, pass = password) =>
    post('/sign-in/email', { email: address, password: pass });

  const getSession = (cookie: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/auth/get-session',
      headers: { cookie },
    });

  // The link points at BETTER_AUTH_URL; inject needs only its path and query.
  const linkIn = (call = send.mock.calls.length - 1): string => {
    const [email_] = send.mock.calls[call];
    const link = /(https?:\/\/\S+)/.exec(email_.text)![1];
    const { pathname, search } = new URL(link);
    return pathname + search;
  };

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

  beforeEach(() => {
    send.mockClear();
  });

  afterAll(async () => {
    for (const address of [email, resetEmail, burstEmail]) {
      await deleteTestUser(address);
    }
    await app.close();
  });

  it('verifies the email before the first sign-in', async () => {
    const signUp = await post('/sign-up/email', {
      name: 'E2E User',
      email,
      password,
      callbackURL,
    });
    expect(signUp.statusCode).toBe(200);
    expect(signUp.json().token).toBeNull();
    expect(signUp.cookies).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.lastCall![0]).toMatchObject({
      to: email,
      subject: 'Verify your Cipherion email address',
    });

    // Unverified: refused, and a fresh link is sent.
    const early = await signIn(email);
    expect(early.statusCode).toBe(403);
    expect(early.json().code).toBe('EMAIL_NOT_VERIFIED');
    expect(send).toHaveBeenCalledTimes(2);

    // The sign-up email carries the callbackURL; the one from sign-in doesn't.
    const verify = await app.inject({ method: 'GET', url: linkIn(0) });
    expect(verify.statusCode).toBe(302);
    expect(verify.headers.location).toBe(callbackURL);
    // A link in an email never creates a session.
    expect(verify.cookies).toHaveLength(0);

    const signedIn = await signIn(email);
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookieOf(signedIn);
    expect(cookie).toContain('session_token');

    const session = await getSession(cookie);
    expect(session.json().user).toMatchObject({ email, emailVerified: true });
  });

  it('refuses a callbackURL outside the trusted origins', async () => {
    const response = await post('/sign-up/email', {
      name: 'E2E User',
      email: `x-${email}`,
      password,
      callbackURL: 'https://evil.example/',
    });
    expect(response.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('caches the session in Redis and revokes it on sign-out', async () => {
    const cookie = cookieOf(await signIn(email));

    const { token } = (await getSession(cookie)).json().session;
    expect(await redis.get(token)).not.toBeNull();

    // A missing Redis entry falls back to the database copy.
    await redis.del(token);
    expect((await getSession(cookie)).json().user.email).toBe(email);

    const signOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { origin, cookie },
      payload: {},
    });
    expect(signOut.statusCode).toBe(200);
    expect(await redis.get(token)).toBeNull();
    expect((await getSession(cookie)).json()).toBeNull();
  });

  it('rejects a profile image on sign-up and update-user', async () => {
    const image = 'https://example.com/avatar.png';

    const signUp = await post('/sign-up/email', {
      name: 'E2E User',
      email: `x-${email}`,
      password,
      image,
    });
    expect(signUp.statusCode).toBe(400);

    const cookie = cookieOf(await signIn(email));
    const update = await post('/update-user', { image }, { cookie });
    expect(update.statusCode).toBe(400);
  });

  describe('password reset', () => {
    const redirectTo = `${origin}/reset-password`;

    it('answers the same for an unknown email, and sends nothing', async () => {
      const response = await post('/request-password-reset', {
        email: `nobody-${stamp}@cipherion.test`,
        redirectTo,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('resets once, ends every session and verifies the email', async () => {
      // Registered but never verified: the reset link proves the inbox.
      await post('/sign-up/email', {
        name: 'E2E Reset',
        email: resetEmail,
        password,
      });
      // A session from before the reset, which the reset must end.
      await prisma.user.update({
        where: { email: resetEmail },
        data: { emailVerified: true },
      });
      const before = cookieOf(await signIn(resetEmail));
      await prisma.user.update({
        where: { email: resetEmail },
        data: { emailVerified: false },
      });
      expect((await getSession(before)).json()).not.toBeNull();

      send.mockClear();
      const request = await post('/request-password-reset', {
        email: resetEmail,
        redirectTo,
      });
      expect(request.statusCode).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.lastCall![0].subject).toBe(
        'Reset your Cipherion password',
      );

      const link = await app.inject({ method: 'GET', url: linkIn() });
      expect(link.statusCode).toBe(302);
      const location = new URL(link.headers.location as string);
      expect(location.origin + location.pathname).toBe(redirectTo);
      const token = location.searchParams.get('token')!;

      const newPassword = 'e2e-new-password-456';
      const reset = await post('/reset-password', { newPassword, token });
      expect(reset.statusCode).toBe(200);

      const again = await post('/reset-password', { newPassword, token });
      expect(again.statusCode).toBe(400);

      expect((await getSession(before)).json()).toBeNull();
      expect((await signIn(resetEmail)).statusCode).toBe(401);
      const after = await signIn(resetEmail, newPassword);
      expect(after.statusCode).toBe(200);
      expect(
        (await getSession(cookieOf(after))).json().user.emailVerified,
      ).toBe(true);
    });

    it('refuses an unknown token', async () => {
      const response = await post('/reset-password', {
        newPassword: 'e2e-new-password-456',
        token: 'not-a-real-token',
      });
      expect(response.statusCode).toBe(400);
    });

    it('allows 3 requests a minute from one address', async () => {
      const headers = { 'x-forwarded-for': uniqueClientIp() };
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await post(
          '/request-password-reset',
          { email: `nobody-${stamp}@cipherion.test`, redirectTo },
          headers,
        );
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    });
  });

  describe('change password', () => {
    const changeEmail = `e2e-change-${stamp}@cipherion.test`;
    const newPassword = 'e2e-changed-password-789';

    afterAll(async () => {
      await deleteTestUser(changeEmail);
    });

    it('refuses a wrong current password and sends nothing', async () => {
      const { cookie } = await signUpVerified(app, 'E2E Change', changeEmail);
      send.mockClear();

      const response = await post(
        '/change-password',
        { currentPassword: 'not-the-password', newPassword },
        { cookie },
      );
      expect(response.statusCode).toBe(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('signs out every other session, keeps this one and emails the owner', async () => {
      const here = cookieOf(await signIn(changeEmail));
      const elsewhere = cookieOf(await signIn(changeEmail));
      send.mockClear();

      // revokeOtherSessions isn't sent: the gateway always turns it on.
      const response = await post(
        '/change-password',
        { currentPassword: password, newPassword },
        { cookie: here },
      );
      expect(response.statusCode).toBe(200);

      expect((await getSession(elsewhere)).json()).toBeNull();
      // The current browser gets a fresh session in the response.
      const fresh = cookieOf(response);
      expect(fresh).toContain('session_token');
      expect((await getSession(fresh)).json().user.email).toBe(changeEmail);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.lastCall![0]).toMatchObject({
        to: changeEmail,
        subject: 'Your Cipherion password was changed',
      });

      expect((await signIn(changeEmail)).statusCode).toBe(401);
      expect((await signIn(changeEmail, newPassword)).statusCode).toBe(200);
    });
  });

  it('starts Google sign-in only when it is configured', async () => {
    const response = await post('/sign-in/social', {
      provider: 'google',
      callbackURL,
    });
    if (process.env.GOOGLE_CLIENT_ID) {
      expect(response.statusCode).toBe(200);
      expect(response.json().url).toMatch(/^https:\/\/accounts\.google\.com\//);
    } else {
      expect(response.statusCode).toBe(404);
    }
  });

  // Password hashing runs on libuv's thread pool, so a burst of sign-ins must
  // not hold up the event loop that serves everyone else.
  it('keeps serving other requests during a burst of sign-ins', async () => {
    await signUpVerified(app, 'E2E Burst', burstEmail);

    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    const burst = Array.from({ length: 20 }, () => signIn(burstEmail));
    const hello = app.inject({ method: 'GET', url: '/api/v1' });
    const [first] = await Promise.all([hello, ...burst]);
    delay.disable();

    expect(first.statusCode).toBe(200);
    for (const response of await Promise.all(burst)) {
      expect(response.statusCode).toBe(200);
    }
    // Event loop delay is in nanoseconds.
    const maxMs = delay.max / 1e6;
    process.stdout.write(
      `20 sign-ins in ${Math.round(performance.now() - started)} ms, ` +
        `longest event loop stall ${maxMs.toFixed(1)} ms\n`,
    );
    expect(maxMs).toBeLessThan(200);
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
