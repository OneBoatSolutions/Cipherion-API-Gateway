import '../config/env.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/cipseq/client.js';

// Client for the CipSeq database (prisma/cipseq/schema.prisma). It is separate
// from the auth database in lib/prisma.ts, so the two can't be joined.
const databaseUrl = process.env.CIPSEQ_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('CIPSEQ_DATABASE_URL is not configured');
}

const adapter = new PrismaPg({
  connectionString: databaseUrl,
});

export const cipseqPrisma = new PrismaClient({ adapter });
