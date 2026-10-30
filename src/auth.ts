import { trustedOrigins } from './config/env.js';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { prisma } from './lib/prisma.js';

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

export const auth = betterAuth({
  appName: 'Cipherion',
  secret: authSecret,
  baseURL: authUrl,
  basePath: '/api/v1/auth',
  trustedOrigins,

  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  emailAndPassword: {
    enabled: true,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: 'database',
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
  },
});
