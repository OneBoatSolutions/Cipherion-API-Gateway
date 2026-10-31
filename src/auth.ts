import { trustedOrigins } from './config/env.js';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
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
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
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
  },
});
