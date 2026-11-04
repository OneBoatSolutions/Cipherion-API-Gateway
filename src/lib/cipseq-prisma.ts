import '../config/env.js';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/cipseq/client.js';
import { watchDatabase } from './database-watch.js';

// Client for the CipSeq database (prisma/cipseq/schema.prisma). It is separate
// from the auth database in lib/prisma.ts, so the two can't be joined.
const databaseUrl = process.env.CIPSEQ_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('CIPSEQ_DATABASE_URL is not configured');
}

// Owned and watched like the auth database's pool in lib/prisma.ts.
export const cipseqPool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2000,
});

watchDatabase(cipseqPool, new Logger('CipSeqDatabase'));

const adapter = new PrismaPg(cipseqPool, { disposeExternalPool: true });

export const cipseqPrisma = new PrismaClient({ adapter });
