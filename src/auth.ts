import { apiDocsEnabled, trustedOrigins } from './config/env.js';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { bearer, openAPI } from 'better-auth/plugins';
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

const rejectProfileImage = createAuthMiddleware(async (ctx) => {
  const body = ctx.body as Record<string, unknown> | undefined;
  if (USER_WRITE_PATHS.has(ctx.path) && body?.image !== undefined) {
    throw new APIError('BAD_REQUEST', {
      message: 'Profile images are not supported',
    });
  }
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
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
    // User, session and account ids are UUIDs. On Postgres, Better Auth leaves the
    // id to the database, so prisma/schema.prisma gives each model a uuid() (v4) default.
    database: { generateId: 'uuid' },
  },

  hooks: {
    before: rejectProfileImage,
  },

  plugins: [
    // How the engine sends the owner's session. It takes the signed token from the
    // set-auth-token header at sign-in, and an unsigned token is refused.
    bearer({ requireSignature: true }),
    // Feeds the auth endpoints into the gateway's Swagger document. Its schema
    // endpoint is public, so the plugin is left out entirely in production; its
    // own Scalar page is disabled in favour of Swagger UI.
    ...(apiDocsEnabled ? [openAPI({ disableDefaultReference: true })] : []),
  ],
});
