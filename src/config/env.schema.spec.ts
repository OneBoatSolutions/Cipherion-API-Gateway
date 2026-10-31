import { envSchema } from './env.schema.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://postgres:password@localhost:5432/cipherion_gateway',
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
