import { envSchema } from './env.schema.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/cipherion_gateway',
  CIPSEQ_DATABASE_URL: 'postgresql://postgres:password@localhost:5432/cipherion_cipseq',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
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
