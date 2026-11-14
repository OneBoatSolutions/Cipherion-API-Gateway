import { createHmac } from 'node:crypto';
import { apiDocsEnabled, trustedOrigins } from './config/env.js';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { bearer, emailOTP, oneTimeToken, openAPI } from 'better-auth/plugins';
import {
  CODE_LIFETIME_MINUTES,
  passwordChangedEmail,
  passwordResetCodeEmail,
  verificationCodeEmail,
} from './auth/emails.js';
import {
  CODE_TTL_MINUTES,
  codeMatchesVerifier,
} from './auth/desktop-sign-in.js';
import { socialProviders } from './auth/social-providers.js';
import { mailer } from './lib/mailer.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';

const authSecret = process.env.BETTER_AUTH_SECRET;
const authUrl = process.env.BETTER_AUTH_URL;

if (!authSecret || authSecret.length < 32) {
  throw new Error('BETTER_AUTH_SECRET must be configured securely');
}

if (!authUrl) {
  throw new Error('BETTER_AUTH_URL is required');
}

if (trustedOrigins.length === 0) {
  throw new Error('AUTH_TRUSTED_ORIGINS must contain trusted origins');
}

// Atomic counter for rate limiting: the TTL is set only when the key is created.
const INCREMENT_SCRIPT = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value
`;

export const SESSION_STORE_UNAVAILABLE =
  'Unavailable. Please try again shortly.';

// Fail closed: without Redis, sessions can't be checked or revoked safely, so
// auth answers 503 instead of a 500 or falling back to a possibly stale state.
const sessionStoreUnavailable = (cause: unknown): never => {
  throw new APIError('SERVICE_UNAVAILABLE', {
    message: SESSION_STORE_UNAVAILABLE,
    cause,
  });
};

// Cipherion has no profile images. Better Auth's user table must keep the
// image column, so clients are stopped from setting it instead.
const USER_WRITE_PATHS = new Set(['/sign-up/email', '/update-user']);

// Email codes replace links. These routes are turned off: the link flows
// (nothing sends links any more), and the email OTP plugin's routes Cipherion
// doesn't use: passwordless sign-in, the deprecated reset alias, a bare code
// check, and email change. They answer 404 and are left out of the API docs.
export const DISABLED_AUTH_PATHS = [
  '/send-verification-email',
  '/verify-email',
  '/request-password-reset',
  '/reset-password',
  '/sign-in/email-otp',
  '/forget-password/email-otp',
  '/email-otp/check-verification-otp',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
];

const hashCode = (otp: string): string =>
  createHmac('sha256', authSecret)
    .update(`email-otp:${otp}`)
    .digest('base64url');

// Sends the code, never awaited by the request. The plugin calls this only for
// a registered address; the lookup gets the name and the id for the log.
const sendCodeEmail = async ({
  email,
  otp,
  type,
}: {
  email: string;
  otp: string;
  type: string;
}): Promise<void> => {
  const build =
    type === 'email-verification'
      ? verificationCodeEmail
      : type === 'forget-password'
        ? passwordResetCodeEmail
        : undefined;
  if (!build) {
    return;
  }
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true },
  });
  if (user) {
    mailer.send(build(user, otp), user.id);
  }
};

const beforeAuth = createAuthMiddleware(async (ctx) => {
  const body = ctx.body as Record<string, unknown> | undefined;
  if (USER_WRITE_PATHS.has(ctx.path) && body?.image !== undefined) {
    throw new APIError('BAD_REQUEST', {
      message: 'Profile images are not supported',
    });
  }

  // The reset link's landing route has a token in its path, which
  // disabledPaths (exact paths only) can't match.
  if (ctx.path === '/reset-password/:token') {
    throw new APIError('NOT_FOUND');
  }

  // Only verification codes go out here. Reset codes come from
  // /email-otp/request-password-reset, and sign-in and email-change codes
  // aren't used.
  if (
    ctx.path === '/email-otp/send-verification-otp' &&
    body?.type !== 'email-verification'
  ) {
    throw new APIError('BAD_REQUEST', {
      message: 'type must be "email-verification"',
    });
  }

  // The desktop agent's code is redeemed only with the verifier of the flow that
  // made it (PKCE, see auth/desktop-sign-in.ts). The verifier is checked here and
  // left out of the body the plugin sees.
  if (ctx.path === '/one-time-token/verify') {
    const token = typeof body?.token === 'string' ? body.token : '';
    const verifier = typeof body?.verifier === 'string' ? body.verifier : '';
    if (!(await codeMatchesVerifier(token, verifier))) {
      throw new APIError('BAD_REQUEST', { message: 'Invalid token' });
    }
    return { context: { body: { token } } };
  }

  // A password change always signs out every other session, whatever the
  // client sends, so a stolen session can't outlive it. Better Auth gives the
  // current one a new session in the response.
  if (ctx.path === '/change-password') {
    return { context: { body: { ...body, revokeOtherSessions: true } } };
  }
});

// Tells the owner, so a change made from a stolen session doesn't go unnoticed.
const afterAuth = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== '/change-password') {
    return;
  }
  const returned = ctx.context.returned as
    { user?: { id: string; name: string; email: string } } | undefined;
  if (returned instanceof APIError || !returned?.user) {
    return;
  }
  const { user } = returned;
  mailer.send(passwordChangedEmail(user, new Date()), user.id);
});

export const auth = betterAuth({
  appName: 'Cipherion',
  secret: authSecret,
  baseURL: authUrl,
  basePath: '/api/v1/auth',
  trustedOrigins,

  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  // Sessions and rate limits are read from Redis first.
  secondaryStorage: {
    get: (key) => redis.get(key).catch(sessionStoreUnavailable),
    getAndDelete: (key) => redis.getdel(key).catch(sessionStoreUnavailable),
    set: (key, value, ttl) =>
      (ttl ? redis.set(key, value, 'EX', ttl) : redis.set(key, value)).catch(
        sessionStoreUnavailable,
      ),
    delete: async (key) => {
      await redis.del(key).catch(sessionStoreUnavailable);
    },
    increment: async (key, ttl) =>
      Number(
        await redis
          .eval(INCREMENT_SCRIPT, 1, key, ttl)
          .catch(sessionStoreUnavailable),
      ),
  },

  emailAndPassword: {
    enabled: true,
    // Sign-up returns no session, and email sign-in answers 403 until the
    // address is verified, so nobody can use someone else's email.
    requireEmailVerification: true,
    // Resets use an emailed code (emailOTP below), never a link.
    // A stolen session ends when the owner resets their password.
    revokeSessionsOnPasswordReset: true,
    // The reset code proves the inbox. This is how someone recovers an address
    // another person registered: the reset replaces that person's password.
    onPasswordReset: async ({ user }) => {
      await prisma.user.updateMany({
        where: { id: user.id, emailVerified: false },
        data: { emailVerified: true },
      });
    },
  },

  // No sendVerificationEmail here: emailOTP supplies it and sends a code, and
  // one set here would silently win over the plugin's and send links again.
  emailVerification: {
    sendOnSignUp: true,
    // An unverified sign-in with the right password sends a new code.
    sendOnSignIn: true,
    // A code never creates a session: the user signs in with their password
    // afterwards.
    autoSignInAfterVerification: false,
  },

  disabledPaths: DISABLED_AUTH_PATHS,

  // Each provider is on only when both its id and secret are set.
  socialProviders: socialProviders(),

  account: {
    accountLinking: {
      // Better Auth's default, stated so it can't drift: social sign-in only
      // joins an existing account whose email is verified.
      requireLocalEmailVerified: true,
    },
  },

  session: {
    // Fixed at one day and never extended, because a stolen session can enrol a
    // device certificate for as long as it lasts.
    expiresIn: 60 * 60 * 24,
    disableSessionRefresh: true,
    // Postgres stays the source of truth; a missing Redis entry falls back to it.
    storeSessionInDatabase: true,
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: 'secondary-storage',
    // Each of these sends an email, so they're limited harder against flooding
    // an inbox. Per IP, like the rest.
    customRules: {
      '/email-otp/send-verification-otp': { window: 60, max: 3 },
      '/email-otp/request-password-reset': { window: 60, max: 3 },
      // Guessing: each code also allows only 3 wrong tries, then it's deleted.
      '/email-otp/verify-email': { window: 60, max: 5 },
      '/email-otp/reset-password': { window: 60, max: 5 },
      // The desktop agent's sign-in code: one try each, and few per minute.
      '/one-time-token/verify': { window: 60, max: 10 },
    },
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
    // Better Auth skips its origin, callback URL and CSRF checks when
    // NODE_ENV=test. Stated so they also run in tests, and are never off.
    disableOriginCheck: false,
    // User, session and account ids are UUIDs. On Postgres, Better Auth leaves the
    // id to the database, so prisma/schema.prisma gives each model a uuid() (v4) default.
    database: { generateId: 'uuid' },
  },

  hooks: {
    before: beforeAuth,
    after: afterAuth,
  },

  plugins: [
    // How the engine sends the owner's session. It takes the signed token from the
    // set-auth-token header at sign-in, and an unsigned token is refused.
    bearer({ requireSignature: true }),
    // Email verification and password reset by a 6-digit code instead of a link.
    emailOTP({
      overrideDefaultEmailVerification: true,
      otpLength: 6,
      expiresIn: CODE_LIFETIME_MINUTES * 60,
      // After 3 wrong tries the code is deleted, and a new one must be requested.
      allowedAttempts: 3,
      // Keyed, so whoever reads the stored value (Redis) can't recover the
      // code by hashing all million of them, as with a plain SHA-256.
      storeOTP: { hash: async (otp) => hashCode(otp) },
      // A code never creates an account.
      disableSignUp: true,
      sendVerificationOTP: sendCodeEmail,
    }),
    // Hands a Google or GitHub session to the desktop agent (auth/desktop-sign-in.ts).
    // Codes are made only by the gateway (never over HTTP), stored hashed, and
    // redeemed with the agent's PKCE verifier (beforeAuth above).
    oneTimeToken({
      expiresIn: CODE_TTL_MINUTES,
      storeToken: 'hashed',
      disableClientRequest: true,
    }),
    // Feeds the auth endpoints into the gateway's Swagger document. Its schema
    // endpoint is public, so the plugin is left out entirely in production; its
    // own Scalar page is disabled in favour of Swagger UI.
    ...(apiDocsEnabled ? [openAPI({ disableDefaultReference: true })] : []),
  ],
});
