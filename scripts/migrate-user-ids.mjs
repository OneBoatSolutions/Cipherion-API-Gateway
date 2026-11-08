#!/usr/bin/env node
// Gives every existing user a UUID v4 id, in both databases, and signs them out.
//
//   npm run users:migrate-ids              # dry run: shows what would change
//   npm run users:migrate-ids -- --apply   # does it
//
// Stop the gateway first and back up both databases. Uses the same .env file as
// the gateway. Safe to run again: users that already have a UUID are skipped,
// and a run that stops part-way resumes from where it stopped.
//
// Why a script and not a Prisma migration: user ids live in two databases, and
// no single transaction can cover both. A mapping table in the auth database
// remembers each new id until every step is done, so a failure in between can
// always be finished, never left half-applied.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { Redis } from 'ioredis';
import pg from 'pg';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const MAPPING = '_userIdMigration';

// Every CipSeq column holding a Better Auth user id. They are plain text, with
// no foreign key, because users live in the other database.
export const CIPSEQ_USER_COLUMNS = [
  ['project', 'adminUserId'],
  ['groupMember', 'userId'],
  ['groupInvitation', 'invitedByUserId'],
  ['groupInvitation', 'reviewedByUserId'],
  ['device', 'userId'],
  ['groupDevice', 'reviewedByUserId'],
  ['groupDevice', 'revokedByUserId'],
  ['auditEvent', 'userId'],
  ['deviceCertificateNotice', 'userId'],
];

const log = (message) => console.log(`migrate-user-ids: ${message}`);

async function ensureMapping(auth, onlyUserIds) {
  await auth.query(`
    CREATE TABLE IF NOT EXISTS "${MAPPING}" (
      "oldId" TEXT PRIMARY KEY,
      "newId" TEXT NOT NULL UNIQUE,
      "cipseqDoneAt" TIMESTAMP(3),
      "authDoneAt" TIMESTAMP(3)
    )`);
  const { rows } = await auth.query(
    `SELECT id FROM "user" WHERE id !~ $1 AND ($2::text[] IS NULL OR id = ANY($2))`,
    [UUID, onlyUserIds ?? null],
  );
  for (const { id } of rows) {
    await auth.query(
      `INSERT INTO "${MAPPING}" ("oldId", "newId") VALUES ($1, $2) ON CONFLICT ("oldId") DO NOTHING`,
      [id, randomUUID()],
    );
  }
  const pending = await auth.query(
    `SELECT "oldId", "newId", "cipseqDoneAt" FROM "${MAPPING}"
     WHERE "authDoneAt" IS NULL AND ($1::text[] IS NULL OR "oldId" = ANY($1))`,
    [onlyUserIds ?? null],
  );
  return pending.rows;
}

// One transaction for the whole CipSeq database. Idempotent: once a row has its
// new id, the old one no longer matches.
async function migrateCipseq(cipseq, mapping) {
  const oldIds = mapping.map((row) => row.oldId);
  const newIds = mapping.map((row) => row.newId);
  const counts = {};
  await cipseq.query('BEGIN');
  try {
    for (const [table, column] of CIPSEQ_USER_COLUMNS) {
      const result = await cipseq.query(
        `UPDATE "${table}" t SET "${column}" = m.new_id
         FROM unnest($1::text[], $2::text[]) AS m(old_id, new_id)
         WHERE t."${column}" = m.old_id`,
        [oldIds, newIds],
      );
      counts[`${table}.${column}`] = result.rowCount;
    }
    // Revocations record who was removed inside the audit metadata.
    const audit = await cipseq.query(
      `UPDATE "auditEvent" t
       SET metadata = jsonb_set(t.metadata::jsonb, '{targetUserId}', to_jsonb(m.new_id))
       FROM unnest($1::text[], $2::text[]) AS m(old_id, new_id)
       WHERE t.metadata::jsonb ->> 'targetUserId' = m.old_id`,
      [oldIds, newIds],
    );
    counts['auditEvent.metadata.targetUserId'] = audit.rowCount;
    await cipseq.query('COMMIT');
  } catch (error) {
    await cipseq.query('ROLLBACK');
    throw error;
  }
  return counts;
}

// Cached sessions hold the old user id, so every session of a migrated user is
// removed: from Redis first, so that nothing can read a stale one, and then from
// the database below. The users sign in again.
async function clearCachedSessions(auth, redis, oldIds) {
  const { rows } = await auth.query(
    `SELECT token FROM "session" WHERE "userId" = ANY($1)`,
    [oldIds],
  );
  const keys = [
    ...rows.map(({ token }) => token),
    ...oldIds.map((id) => `active-sessions-${id}`),
  ];
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  return rows.length;
}

async function migrateAuth(auth, mapping) {
  const oldIds = mapping.map((row) => row.oldId);
  const newIds = mapping.map((row) => row.newId);
  await auth.query('BEGIN');
  try {
    await auth.query(`DELETE FROM "session" WHERE "userId" = ANY($1)`, [oldIds]);
    // Email and password accounts keep a copy of the user id in accountId.
    await auth.query(
      `UPDATE "account" a SET "accountId" = m.new_id
       FROM unnest($1::text[], $2::text[]) AS m(old_id, new_id)
       WHERE a."userId" = m.old_id AND a."providerId" = 'credential' AND a."accountId" = m.old_id`,
      [oldIds, newIds],
    );
    // account, session and userSettings follow through ON UPDATE CASCADE.
    const users = await auth.query(
      `UPDATE "user" u SET id = m.new_id
       FROM unnest($1::text[], $2::text[]) AS m(old_id, new_id)
       WHERE u.id = m.old_id`,
      [oldIds, newIds],
    );
    await auth.query(
      `UPDATE "${MAPPING}" SET "authDoneAt" = now() WHERE "oldId" = ANY($1)`,
      [oldIds],
    );
    await auth.query('COMMIT');
    return users.rowCount;
  } catch (error) {
    await auth.query('ROLLBACK');
    throw error;
  }
}

// The mapping is only needed until every row in it is done. Prisma would report
// a table it doesn't know about as drift, so it never stays behind.
async function dropMappingWhenFinished(auth) {
  const { rows } = await auth.query(
    `SELECT count(*)::int AS n FROM "${MAPPING}" WHERE "authDoneAt" IS NULL`,
  );
  if (rows[0].n > 0) {
    return false;
  }
  await auth.query(`DROP TABLE "${MAPPING}"`);
  return true;
}

async function remaining(auth, cipseq) {
  const users = await auth.query(`SELECT count(*)::int AS n FROM "user" WHERE id !~ $1`, [UUID]);
  let cipseqLeft = 0;
  for (const [table, column] of CIPSEQ_USER_COLUMNS) {
    const result = await cipseq.query(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" !~ $1`,
      [UUID],
    );
    cipseqLeft += result.rows[0].n;
  }
  return { users: users.rows[0].n, cipseqRows: cipseqLeft };
}

// `onlyUserIds` limits the run to those users. Tests use it; the command line doesn't.
export async function migrateUserIds({ apply, env = process.env, onlyUserIds } = {}) {
  const auth = new pg.Client({ connectionString: env.DATABASE_URL });
  const cipseq = new pg.Client({ connectionString: env.CIPSEQ_DATABASE_URL });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  await auth.connect();
  await cipseq.connect();
  try {
    if (!apply) {
      const { rows } = await auth.query(
        `SELECT count(*)::int AS n FROM "user" WHERE id !~ $1 AND ($2::text[] IS NULL OR id = ANY($2))`,
        [UUID, onlyUserIds ?? null],
      );
      const left = await remaining(auth, cipseq);
      log(`dry run: ${rows[0].n} users would get a UUID; ${left.cipseqRows} CipSeq rows hold an old id.`);
      log('nothing was changed. Run again with --apply.');
      return { migrated: 0, dryRun: true, ...left };
    }

    await redis.connect();
    const mapping = await ensureMapping(auth, onlyUserIds);
    if (mapping.length === 0) {
      await dropMappingWhenFinished(auth);
      log('every user already has a UUID.');
      return { migrated: 0, ...(await remaining(auth, cipseq)) };
    }
    log(`${mapping.length} users to migrate.`);

    const counts = await migrateCipseq(cipseq, mapping);
    await auth.query(
      `UPDATE "${MAPPING}" SET "cipseqDoneAt" = now() WHERE "oldId" = ANY($1)`,
      [mapping.map((row) => row.oldId)],
    );
    for (const [column, count] of Object.entries(counts)) {
      if (count > 0) log(`CipSeq ${column}: ${count} rows`);
    }

    const sessions = await clearCachedSessions(auth, redis, mapping.map((row) => row.oldId));
    const migrated = await migrateAuth(auth, mapping);
    log(`${migrated} users migrated; ${sessions} sessions removed, so they sign in again.`);

    const left = await remaining(auth, cipseq);
    if (!(await dropMappingWhenFinished(auth)) && !onlyUserIds) {
      log(`still not UUIDs: ${left.users} users, ${left.cipseqRows} CipSeq rows. Kept ${MAPPING}; run again to finish.`);
    }
    return { migrated, sessions, counts, ...left };
  } finally {
    await auth.end();
    await cipseq.end();
    redis.disconnect();
  }
}

// The same file the gateway loads (src/config/env.ts).
function loadEnv() {
  const file = existsSync(resolve('.env'))
    ? '.env'
    : process.env.NODE_ENV === 'production'
      ? '.env.prod'
      : '.env.dev';
  dotenv.config({ path: file, quiet: true });
  return file;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
  const file = loadEnv();
  log(`using ${file}.`);
  migrateUserIds({ apply: values.apply }).catch((error) => {
    console.error(`migrate-user-ids failed: ${error.message}`);
    console.error('Nothing is half-applied: run it again to finish.');
    process.exit(1);
  });
}
