import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databasePoolConfig } from './database-tls.js';

const url = 'postgresql://user:p%40ss@db.internal:5432/app';

describe('databasePoolConfig', () => {
  let dir: string;
  let caPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'database-tls-'));
    caPath = join(dir, 'ca.pem');
    writeFileSync(caPath, 'PEM-BUNDLE');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the URL alone when no CA is set', () => {
    expect(databasePoolConfig(`${url}?sslmode=require`, undefined)).toEqual({
      connectionString: `${url}?sslmode=require`,
    });
  });

  it('trusts the CA and keeps verifying the certificate', () => {
    const config = databasePoolConfig(url, caPath);
    expect(config.ssl).toEqual({
      ca: Buffer.from('PEM-BUNDLE'),
      rejectUnauthorized: true,
    });
    expect(config.connectionString).toBe(url);
  });

  it('drops sslmode, which would otherwise override the ssl option', () => {
    const config = databasePoolConfig(
      `${url}?sslmode=require&uselibpqcompat=true&application_name=gw`,
      caPath,
    );
    expect(config.connectionString).toBe(`${url}?application_name=gw`);
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it('keeps the password and database in the URL', () => {
    const { connectionString } = databasePoolConfig(
      `${url}?sslmode=verify-full`,
      caPath,
    );
    const parsed = new URL(connectionString as string);
    expect(decodeURIComponent(parsed.password)).toBe('p@ss');
    expect(parsed.pathname).toBe('/app');
  });

  it('respects sslmode=disable', () => {
    expect(databasePoolConfig(`${url}?sslmode=disable`, caPath)).toEqual({
      connectionString: `${url}?sslmode=disable`,
    });
  });

  it('names the file when the CA cannot be read', () => {
    expect(() => databasePoolConfig(url, join(dir, 'missing.pem'))).toThrow(
      /DATABASE_CA_CERT can't be read from .*missing\.pem/,
    );
  });
});
