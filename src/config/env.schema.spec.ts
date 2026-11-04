import { envSchema } from './env.schema.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/cipherion_gateway',
  CIPSEQ_DATABASE_URL: 'postgresql://postgres:password@localhost:5432/cipherion_cipseq',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
  KMS_ADDRESS: 'localhost:50051',
  KMS_CA_CERT: '/certs/kms/ca.crt',
  KMS_CLIENT_CERT: '/certs/kms/gateway.crt',
  KMS_CLIENT_KEY: '/certs/kms/gateway.key',
};

const validate = (env: Record<string, string>) =>
  envSchema.validate({ ...baseEnv, ...env });

describe('envSchema REDIS_URL', () => {
  it('accepts redis:// outside production', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const { error } = validate({ NODE_ENV, REDIS_URL: 'redis://localhost:6379' });
      expect(error).toBeUndefined();
    }
  });

  it('defaults NODE_ENV to development and accepts redis://', () => {
    const { error, value } = validate({ REDIS_URL: 'redis://localhost:6379' });
    expect(error).toBeUndefined();
    expect(value.NODE_ENV).toBe('development');
  });

  it('requires rediss:// in production', () => {
    const { error } = validate({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://redis.internal:6379',
    });
    expect(error?.message).toBe(
      '"REDIS_URL" must use rediss:// (TLS) when NODE_ENV is production',
    );
  });

  it('accepts rediss:// with credentials in production', () => {
    const { error } = validate({
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://gateway:secret@redis.internal:6380',
    });
    expect(error).toBeUndefined();
  });

  it('rejects non-redis schemes and a missing value', () => {
    expect(validate({ REDIS_URL: 'http://localhost:6379' }).error).toBeDefined();
    expect(validate({}).error?.message).toBe('"REDIS_URL" is required');
  });
});

describe('envSchema CIPSEQ_DATABASE_URL', () => {
  const redis = { REDIS_URL: 'rediss://gateway:secret@redis.internal:6380' };
  const authDatabase =
    'postgresql://postgres:password@localhost:5432/cipherion_gateway';

  it('is required and must be a PostgreSQL URL', () => {
    expect(
      envSchema.validate({ ...baseEnv, ...redis, CIPSEQ_DATABASE_URL: undefined })
        .error?.message,
    ).toBe('"CIPSEQ_DATABASE_URL" is required');
    expect(
      validate({ ...redis, CIPSEQ_DATABASE_URL: 'mysql://localhost/cipseq' })
        .error,
    ).toBeDefined();
  });

  it('may point to the auth database outside production', () => {
    const { error } = validate({ ...redis, CIPSEQ_DATABASE_URL: authDatabase });
    expect(error).toBeUndefined();
  });

  it('must not point to the auth database in production', () => {
    const { error } = validate({
      NODE_ENV: 'production',
      ...redis,
      CIPSEQ_DATABASE_URL: authDatabase,
    });
    expect(error?.message).toBe(
      '"CIPSEQ_DATABASE_URL" must point to a different database than "DATABASE_URL" when NODE_ENV is production',
    );
  });

  it('accepts a separate database in production, even with the same user', () => {
    const { error } = validate({ NODE_ENV: 'production', ...redis });
    expect(error).toBeUndefined();
  });
});

describe('envSchema KMS', () => {
  const redis = { REDIS_URL: 'redis://localhost:6379' };

  it('accepts host:port addresses', () => {
    for (const KMS_ADDRESS of ['localhost:50051', 'kms.internal:443', '10.0.0.5:50051']) {
      expect(validate({ ...redis, KMS_ADDRESS }).error).toBeUndefined();
    }
  });

  it('rejects an address without a port or with a scheme', () => {
    for (const KMS_ADDRESS of ['localhost', 'https://kms.internal:443']) {
      expect(validate({ ...redis, KMS_ADDRESS }).error?.message).toBe(
        '"KMS_ADDRESS" must be host:port, e.g. localhost:50051',
      );
    }
  });

  it('requires the address and all three mTLS files', () => {
    for (const name of [
      'KMS_ADDRESS',
      'KMS_CA_CERT',
      'KMS_CLIENT_CERT',
      'KMS_CLIENT_KEY',
    ]) {
      const { error } = envSchema.validate({
        ...baseEnv,
        ...redis,
        [name]: undefined,
      });
      expect(error?.message).toBe(`"${name}" is required`);
    }
  });
});
