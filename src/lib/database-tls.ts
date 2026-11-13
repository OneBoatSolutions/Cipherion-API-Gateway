import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

// Options for one database's pool, shared by lib/prisma.ts and
// lib/cipseq-prisma.ts so both trust the same CAs.
//
// DATABASE_CA_CERT is a PEM file for a database whose certificate a private CA
// signed (a self-hosted or platform-managed Postgres). It may hold several
// CAs, so a CA can be rotated by listing the old and the new one together. The
// certificate and its host name are still fully verified; this only adds a CA
// to trust and never turns a check off. Unset, Node's built-in CAs are used,
// which is right for a managed database with a public CA.
//
// pg lets the connection string override the `ssl` option, so with a CA set
// the URL's `sslmode` is dropped and the `ssl` option decides. `sslmode=disable`
// stays disabled.
export const databasePoolConfig = (
  connectionString: string,
  caPath: string | undefined = process.env.DATABASE_CA_CERT,
): PoolConfig => {
  if (!caPath) {
    return { connectionString };
  }

  let ca: Buffer;
  try {
    ca = readFileSync(caPath);
  } catch (error) {
    throw new Error(`DATABASE_CA_CERT can't be read from ${caPath}`, {
      cause: error,
    });
  }

  const url = new URL(connectionString);
  if (url.searchParams.get('sslmode') === 'disable') {
    return { connectionString };
  }
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');

  return {
    connectionString: url.toString(),
    ssl: { ca, rejectUnauthorized: true },
  };
};
