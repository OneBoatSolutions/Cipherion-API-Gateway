import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { cipseqPool } from './cipseq-prisma.js';
import { connectionErrorReason, withTimeout } from './database-watch.js';
import { pool } from './prisma.js';

// Longer than the 2 s runtime checks, to allow for a slow first connection.
export const STARTUP_TIMEOUT_MS = 5000;

export interface StartupDatabase {
  label: string;
  url: string;
  pool: Pick<Pool, 'query' | 'end'>;
}

const defaultDatabases = (): StartupDatabase[] => [
  { label: 'auth', url: process.env.DATABASE_URL ?? '', pool },
  {
    label: 'CipSeq',
    url: process.env.CIPSEQ_DATABASE_URL ?? '',
    pool: cipseqPool,
  },
];

// Refuses to start the gateway when a database is unreachable: each failure
// is logged with its reason, then the process exits with code 1 so the
// orchestrator's restart policy takes over. Redis and the KMS are not
// required here; they are logged and reported by /ready instead.
export async function checkDatabasesOnStartup(
  databases: StartupDatabase[] = defaultDatabases(),
  exit: (code: number) => never = (code) => process.exit(code),
  logger: Pick<Logger, 'error' | 'log'> = new Logger('Startup'),
): Promise<void> {
  const results = await Promise.allSettled(
    databases.map((db) =>
      withTimeout(db.pool.query('SELECT 1'), STARTUP_TIMEOUT_MS),
    ),
  );

  const failed = databases.filter((_, i) => results[i].status === 'rejected');
  if (failed.length === 0) {
    logger.log(
      `Connected to the ${databases.map((db) => db.label).join(' and ')} databases`,
    );
    return;
  }

  databases.forEach((db, i) => {
    const result = results[i];
    if (result.status === 'rejected') {
      logger.error(
        `Can't connect to the ${db.label} database (${describeTarget(db.url)}): ${connectionErrorReason(result.reason)}`,
      );
    }
  });
  logger.error('Exiting: a database is unreachable');

  await Promise.allSettled(databases.map((db) => db.pool.end()));
  exit(1);
}

// host:port/database, never the user or password.
export function describeTarget(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    return `${host}${pathname}`;
  } catch {
    return 'invalid URL';
  }
}
