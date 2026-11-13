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
// test/setup-e2e.ts replaces the mailer, so the codes are read from its calls.
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

  // The 6-digit code from the plain-text part of a sent email.
  const codeIn = (call = send.mock.calls.length - 1): string =>
    /Your code: (\d{6})/.exec(send.mock.calls[call][0].text)![1];

  // A code that's surely wrong: the right one with its first digit changed.
  const wrong = (code: string): string =>
    `${(Number(code[0]) + 1) % 10}${code.slice(1)}`;

  const verifyEmail = (address: string, otp: string) =>
    post('/email-otp/verify-email', { email: address, otp });

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

  it('verifies the email with a code before the first sign-in', async () => {
    const signUp = await post('/sign-up/email', {
      name: 'E2E User',
      email,
      password,
    });
    expect(signUp.statusCode).toBe(200);
    expect(signUp.json().token).toBeNull();
    expect(signUp.cookies).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.lastCall![0]).toMatchObject({
      to: email,
      subject: 'Verify your Cipherion email address',
    });
    const first = codeIn(0);

    // Unverified: refused, and a fresh code replaces the first.
    const early = await signIn(email);
    expect(early.statusCode).toBe(403);
    expect(early.json().code).toBe('EMAIL_NOT_VERIFIED');
    expect(send).toHaveBeenCalledTimes(2);
    const code = codeIn(1);

    if (first !== code) {
      expect((await verifyEmail(email, first)).statusCode).toBe(400);
    }
    expect((await verifyEmail(email, wrong(code))).statusCode).toBe(400);

    const verify = await verifyEmail(email, code);
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({
      status: true,
      token: null,
      user: { email, emailVerified: true },
    });
    // A code never creates a session.
    expect(verify.cookies).toHaveLength(0);

    // Used once.
    expect((await verifyEmail(email, code)).statusCode).toBe(400);

    const signedIn = await signIn(email);
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookieOf(signedIn);
    expect(cookie).toContain('session_token');

    const session = await getSession(cookie);
    expect(session.json().user).toMatchObject({ email, emailVerified: true });
  });

  describe('verification codes', () => {
    const codeEmail = `e2e-code-${stamp}@cipherion.test`;
    const redisKey = `verification:email-verification-otp-${codeEmail}`;

    const newCode = async (): Promise<string> => {
      send.mockClear();
      const response = await post('/email-otp/send-verification-otp', {
        email: codeEmail,
        type: 'email-verification',
      });
      expect(response.statusCode).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      return codeIn();
    };

    beforeAll(async () => {
      await post('/sign-up/email', {
        name: 'E2E Code',
        email: codeEmail,
        password,
      });
    });

    afterAll(async () => {
      await deleteTestUser(codeEmail);
    });

    it('stores only a keyed hash of the code', async () => {
      const code = await newCode();
      const stored = await redis.get(redisKey);
      expect(stored).not.toBeNull();
      expect(stored).not.toContain(`"${code}:`);
    });

    it('refuses even the right code after 3 wrong tries', async () => {
      const code = await newCode();
      for (let i = 0; i < 3; i++) {
        expect((await verifyEmail(codeEmail, wrong(code))).statusCode).toBe(
          400,
        );
      }
      const locked = await verifyEmail(codeEmail, code);
      expect(locked.statusCode).toBe(403);
      expect(locked.json().code).toBe('TOO_MANY_ATTEMPTS');
    });

    it('refuses an expired code', async () => {
      const code = await newCode();
      const stored = JSON.parse((await redis.get(redisKey))!);
      stored.expiresAt = new Date(Date.now() - 1000).toISOString();
      await redis.set(redisKey, JSON.stringify(stored), 'EX', 60);

      const expired = await verifyEmail(codeEmail, code);
      expect(expired.statusCode).toBe(400);
      expect(expired.json().code).toBe('OTP_EXPIRED');
    });

    it('sends nothing for an unknown email, and answers the same', async () => {
      send.mockClear();
      const response = await post('/email-otp/send-verification-otp', {
        email: `nobody-${stamp}@cipherion.test`,
        type: 'email-verification',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(send).not.toHaveBeenCalled();
    });

    it.each(['sign-in', 'forget-password', 'change-email'])(
      'refuses to send a %s code from this route',
      async (type) => {
        const response = await post('/email-otp/send-verification-otp', {
          email: codeEmail,
          type,
        });
        expect(response.statusCode).toBe(400);
        expect(send).not.toHaveBeenCalled();
      },
    );
  });

  it.each([
    ['POST', '/send-verification-email'],
    ['GET', '/verify-email?token=x'],
    ['POST', '/request-password-reset'],
    ['POST', '/reset-password'],
    ['GET', '/reset-password/some-token?callbackURL=%2F'],
    ['POST', '/sign-in/email-otp'],
    ['POST', '/forget-password/email-otp'],
    ['POST', '/email-otp/check-verification-otp'],
    ['POST', '/email-otp/request-email-change'],
    ['POST', '/email-otp/change-email'],
  ] as const)('turns off %s %s', async (method, path) => {
    const response = await app.inject({
      method,
      url: `/api/v1/auth${path}`,
      headers: { origin, 'x-forwarded-for': uniqueClientIp() },
      ...(method === 'POST' ? { payload: { email } } : {}),
    });
    expect(response.statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
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
    const requestReset = (address: string, extra: object = {}) =>
      post('/email-otp/request-password-reset', { email: address }, extra);
    const reset = (address: string, otp: string, newPassword: string) =>
      post('/email-otp/reset-password', {
        email: address,
        otp,
        password: newPassword,
      });

    it('answers the same for an unknown email, and sends nothing', async () => {
      const response = await requestReset(`nobody-${stamp}@cipherion.test`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(send).not.toHaveBeenCalled();
    });

    it('resets once, ends every session and verifies the email', async () => {
      // Registered but never verified: the reset code proves the inbox.
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
      const request = await requestReset(resetEmail);
      expect(request.statusCode).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.lastCall![0]).toMatchObject({
        to: resetEmail,
        subject: 'Reset your Cipherion password',
      });
      const code = codeIn();

      const newPassword = 'e2e-new-password-456';
      expect((await reset(resetEmail, wrong(code), newPassword)).statusCode).toBe(
        400,
      );
      // Still unchanged after a wrong code.
      expect((await getSession(before)).json()).not.toBeNull();

      const done = await reset(resetEmail, code, newPassword);
      expect(done.statusCode).toBe(200);

      const again = await reset(resetEmail, code, 'e2e-other-password-789');
      expect(again.statusCode).toBe(400);

      expect((await getSession(before)).json()).toBeNull();
      expect((await signIn(resetEmail)).statusCode).toBe(401);
      const after = await signIn(resetEmail, newPassword);
      expect(after.statusCode).toBe(200);
      expect(
        (await getSession(cookieOf(after))).json().user.emailVerified,
      ).toBe(true);
    });

    it('refuses a code nobody requested', async () => {
      const response = await reset(
        `nobody-${stamp}@cipherion.test`,
        '123456',
        'e2e-new-password-456',
      );
      expect(response.statusCode).toBe(400);
    });

    it('allows 3 requests a minute from one address', async () => {
      const headers = { 'x-forwarded-for': uniqueClientIp() };
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await requestReset(
          `nobody-${stamp}@cipherion.test`,
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
