import { createHash, randomBytes } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
import { trustedOrigins } from './../src/config/env.js';
import { newFlowId, saveFlow } from './../src/auth/desktop-sign-in.js';
import { uniqueClientIp } from './helpers/client-ip.js';
import { deleteTestUser } from './helpers/delete-test-user.js';
import { signUpVerified } from './helpers/users.js';

// The browser half of the desktop agent's Google and GitHub sign-in, and the
// PKCE check on /one-time-token/verify. The provider round trip itself can't run
// here, so a flow is stored directly and an email session stands in for the one
// the provider's callback would make.
describe('Desktop sign-in (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = Date.now();
  const emails: string[] = [];
  const origin = trustedOrigins[0];

  const random43 = () => randomBytes(32).toString('base64url');
  const challengeOf = (verifier: string) =>
    createHash('sha256').update(verifier).digest('base64url');

  const get = (url: string, cookie?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: {
        'x-forwarded-for': uniqueClientIp(),
        ...(cookie ? { cookie } : {}),
      },
    });

  const verify = (payload: object) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/one-time-token/verify',
      headers: { origin, 'x-forwarded-for': uniqueClientIp() },
      payload,
    });

  // A stored flow, a session made after it, and the redirect /finish answers.
  const finishWithNewSession = async (label: string) => {
    const verifier = random43();
    const state = random43();
    const flowId = newFlowId();
    await saveFlow(flowId, {
      provider: 'google',
      port: 53682,
      state,
      challenge: challengeOf(verifier),
      createdAt: Date.now() - 1000,
    });
    const email = `e2e-desktop-${label}-${stamp}@cipherion.test`;
    emails.push(email);
    const user = await signUpVerified(app, 'Desktop', email);
    const finish = await get(
      `/api/v1/auth/desktop/finish?flow=${flowId}`,
      user.cookie,
    );
    return { finish, verifier, state, user, flowId };
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

  afterAll(async () => {
    for (const email of emails) {
      await deleteTestUser(email);
    }
    await app.close();
  });

  it('refuses a start link that is malformed or names no configured provider', async () => {
    const challenge = challengeOf(random43());
    for (const query of [
      `provider=google&port=80&state=${random43()}&challenge=${challenge}`,
      `provider=facebook&port=53682&state=${random43()}&challenge=${challenge}`,
      `provider=google&port=53682&state=short&challenge=${challenge}`,
    ]) {
      const response = await get(`/api/v1/auth/desktop/start?${query}`);
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
    }
  });

  it('answers an unknown or used flow with a page, not a redirect', async () => {
    const response = await get(
      `/api/v1/auth/desktop/finish?flow=${random43()}`,
    );
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it('hands a new session to the agent once, only with its verifier', async () => {
    const { finish, verifier, state, user, flowId } =
      await finishWithNewSession('ok');
    expect(finish.statusCode).toBe(302);
    const location = new URL(finish.headers.location as string);
    expect(location.origin).toBe('http://127.0.0.1:53682');
    expect(location.pathname).toBe('/callback');
    expect(location.searchParams.get('state')).toBe(state);
    const code = location.searchParams.get('code')!;
    expect(code).toBeTruthy();
    // The browser's copy of the session cookie is cleared.
    expect(String(finish.headers['set-cookie'])).toMatch(
      /session_token=;.*Max-Age=0/,
    );

    // The flow can't be finished twice.
    const again = await get(
      `/api/v1/auth/desktop/finish?flow=${flowId}`,
      user.cookie,
    );
    expect(again.statusCode).toBe(400);

    const redeemed = await verify({ token: code, verifier });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().user.id).toBe(user.id);
    expect(typeof redeemed.headers['set-auth-token']).toBe('string');

    // One use only.
    expect((await verify({ token: code, verifier })).statusCode).toBe(400);
  });

  it('refuses the code without the right verifier, and burns it', async () => {
    const { finish, verifier } = await finishWithNewSession('wrong');
    const code = new URL(finish.headers.location as string).searchParams.get(
      'code',
    )!;
    expect((await verify({ token: code })).statusCode).toBe(400);
    expect((await verify({ token: code, verifier })).statusCode).toBe(400);
  });

  it('never hands over a session older than the flow', async () => {
    const email = `e2e-desktop-old-${stamp}@cipherion.test`;
    emails.push(email);
    const user = await signUpVerified(app, 'Desktop', email);
    const flowId = newFlowId();
    await saveFlow(flowId, {
      provider: 'google',
      port: 53682,
      state: random43(),
      challenge: challengeOf(random43()),
      createdAt: Date.now() + 1000,
    });
    const finish = await get(
      `/api/v1/auth/desktop/finish?flow=${flowId}`,
      user.cookie,
    );
    expect(finish.statusCode).toBe(302);
    const location = new URL(finish.headers.location as string);
    expect(location.searchParams.get('error')).toBe('sign_in_failed');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('passes a provider error on to the agent', async () => {
    const flowId = newFlowId();
    await saveFlow(flowId, {
      provider: 'google',
      port: 53682,
      state: random43(),
      challenge: challengeOf(random43()),
      createdAt: Date.now(),
    });
    const finish = await get(
      `/api/v1/auth/desktop/finish?flow=${flowId}&error=access_denied&error_description=x`,
    );
    expect(finish.statusCode).toBe(302);
    expect(
      new URL(finish.headers.location as string).searchParams.get('error'),
    ).toBe('access_denied');
  });

  it('keeps one-time tokens from being made over HTTP', async () => {
    const email = `e2e-desktop-gen-${stamp}@cipherion.test`;
    emails.push(email);
    const user = await signUpVerified(app, 'Desktop', email);
    const response = await get(
      '/api/v1/auth/one-time-token/generate',
      user.cookie,
    );
    expect(response.statusCode).toBe(400);
  });
});
