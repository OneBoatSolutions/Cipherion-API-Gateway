import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Loaded as a side effect so modules that read process.env at import time
// (auth.ts, lib/prisma.ts) see the same file ConfigModule validates.
// Variables already set by the host are never overwritten.
export const envFilePath = existsSync(resolve('.env'))
  ? '.env'
  : process.env.NODE_ENV === 'production'
    ? '.env.prod'
    : '.env.dev';

dotenv.config({ path: envFilePath, quiet: true });

export const trustedOrigins = (process.env.AUTH_TRUSTED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
