import '../config/env.js';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { watchDatabase } from './database-watch.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not configured');
}

// The gateway owns the pool so it can watch its connection. A dead database
// fails a new connection within 2 s instead of hanging the request.
export const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2000,
});

watchDatabase(pool, new Logger('Database'));

// disposeExternalPool: prisma.$disconnect() also closes the pool.
const adapter = new PrismaPg(pool, { disposeExternalPool: true });

export const prisma = new PrismaClient({ adapter });
