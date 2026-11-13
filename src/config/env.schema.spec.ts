import { envSchema } from './env.schema.js';

const baseEnv = {
  DATABASE_URL:
    'postgresql://postgres:password@localhost:5432/cipherion_gateway',
  CIPSEQ_DATABASE_URL:
    'postgresql://postgres:password@localhost:5432/cipherion_cipseq',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
  KMS_ADDRESS: 'localhost:50051',
  KMS_CA_CERT: '/certs/kms/ca.crt',
  KMS_CLIENT_CERT: '/certs/kms/gateway.crt',
  KMS_CLIENT_KEY: '/certs/kms/gateway.key',
  EMAIL_HOST: 'localhost',
  EMAIL_PORT: '1025',
  EMAIL_FROM: 'Cipherion <no-reply@cipherion.test>',
};

const validate = (env: Record<string, string>) =>
  envSchema.validate({ ...baseEnv, ...env });

describe('envSchema engine listener', () => {
  const redis = { REDIS_URL: 'redis://localhost:6379' };
  const files = {
    DEVICE_TLS_KEY: '/certs/engine.key',
    DEVICE_TLS_CERT: '/certs/engine.crt',
    DEVICE_TLS_PIN_FILE: '/certs/engine.pin',
    DEVICE_CA_BUNDLE: '/certs/device-ca-trust.pem',
  };

  it('is off by default and needs no files then', () => {
    const { error, value } = validate(redis);
    expect(error).toBeUndefined();
    expect(value.DEVICE_ENGINE_ENABLED).toBe(false);
    expect(value.DEVICE_ENGINE_PORT).toBe(3443);
  });

  it('accepts all four files when enabled', () => {
    const { error } = validate({
      ...redis,
      ...files,
      DEVICE_ENGINE_ENABLED: 'true',
    });
    expect(error).toBeUndefined();
  });

  it.each(Object.keys(files))('requires %s when enabled', (missing) => {
    const { [missing as keyof typeof files]: _, ...rest } = files;
    const { error } = validate({
      ...redis,
      ...rest,
      DEVICE_ENGINE_ENABLED: 'true',
    });
    expect(error?.message).toContain(missing);
  });

  it('refuses the same port as the console', () => {
    const { error } = validate({
      ...redis,
      PORT: '3000',
      DEVICE_ENGINE_PORT: '3000',
    });
    expect(error?.message).toBe('"DEVICE_ENGINE_PORT" must differ from "PORT"');
  });
});

describe('envSchema REDIS_URL', () => {
  it('accepts redis:// outside production', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const { error } = validate({
        NODE_ENV,
        REDIS_URL: 'redis://localhost:6379',
      });
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
    expect(
      validate({ REDIS_URL: 'http://localhost:6379' }).error,
    ).toBeDefined();
    expect(validate({}).error?.message).toBe('"REDIS_URL" is required');
  });
});

describe('envSchema DATABASE_CA_CERT', () => {
  const redis = { REDIS_URL: 'redis://localhost:6379' };

  it('is optional', () => {
    const { error, value } = validate(redis);
    expect(error).toBeUndefined();
    expect(value.DATABASE_CA_CERT).toBeUndefined();
  });

  it('accepts a path', () => {
    const { error, value } = validate({
      ...redis,
      DATABASE_CA_CERT: '/certs/database-ca.pem',
    });
    expect(error).toBeUndefined();
    expect(value.DATABASE_CA_CERT).toBe('/certs/database-ca.pem');
  });
});

describe('envSchema REDIS_CA_CERT', () => {
  const REDIS_CA_CERT = '/home/you/.cipherion/redis-tls/ca.crt';

  it('is optional with rediss://', () => {
    const REDIS_URL = 'rediss://:secret@localhost:6380';
    expect(validate({ REDIS_URL }).error).toBeUndefined();
    expect(validate({ REDIS_URL, REDIS_CA_CERT }).error).toBeUndefined();
  });

  it('needs a rediss:// URL', () => {
    const { error } = validate({
      REDIS_URL: 'redis://localhost:6379',
      REDIS_CA_CERT,
    });
    expect(error?.message).toBe(
      '"REDIS_CA_CERT" needs a rediss:// (TLS) REDIS_URL',
    );
  });
});

describe('envSchema CIPSEQ_DATABASE_URL', () => {
  const redis = { REDIS_URL: 'rediss://gateway:secret@redis.internal:6380' };
  const authDatabase =
    'postgresql://postgres:password@localhost:5432/cipherion_gateway';

  it('is required and must be a PostgreSQL URL', () => {
    expect(
      envSchema.validate({
        ...baseEnv,
        ...redis,
        CIPSEQ_DATABASE_URL: undefined,
      }).error?.message,
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

describe('envSchema email and social sign-in', () => {
  const redis = { REDIS_URL: 'redis://localhost:6379' };
  const without = (...names: string[]) =>
    envSchema.validate({
      ...baseEnv,
      ...redis,
      ...Object.fromEntries(names.map((name) => [name, undefined])),
    });

  it('requires the host, port and sender outside tests', () => {
    for (const name of ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_FROM']) {
      expect(without(name).error?.message).toBe(`"${name}" is required`);
    }
  });

  it('lets tests run without an email sender', () => {
    const { error } = envSchema.validate({
      ...baseEnv,
      ...redis,
      NODE_ENV: 'test',
      EMAIL_HOST: undefined,
      EMAIL_PORT: undefined,
      EMAIL_FROM: undefined,
    });
    expect(error).toBeUndefined();
  });

  it('accepts a login with special characters, and none for Mailpit', () => {
    expect(validate(redis).error).toBeUndefined();
    const { error, value } = validate({
      ...redis,
      EMAIL_HOST: 'smtp.example.com',
      EMAIL_PORT: '587',
      EMAIL_USER: 'mailer@example.com',
      EMAIL_PASS: 'p@ss:w/rd#1',
    });
    expect(error).toBeUndefined();
    expect(value.EMAIL_PORT).toBe(587);
  });

  it('needs both the user and the password, or neither', () => {
    expect(
      validate({ ...redis, EMAIL_USER: 'mailer@example.com' }).error?.message,
    ).toContain('EMAIL_PASS');
    expect(
      validate({ ...redis, EMAIL_PASS: 'secret' }).error?.message,
    ).toContain('EMAIL_USER');
  });

  it('rejects an invalid host or port', () => {
    expect(
      validate({ ...redis, EMAIL_HOST: 'smtp://smtp.example.com' }).error,
    ).toBeDefined();
    expect(validate({ ...redis, EMAIL_PORT: '70000' }).error).toBeDefined();
  });

  it('needs both values of a sign-in provider, or neither', () => {
    expect(validate(redis).error).toBeUndefined();
    expect(
      validate({
        ...redis,
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
      }).error,
    ).toBeUndefined();
    expect(
      validate({ ...redis, GOOGLE_CLIENT_ID: 'id' }).error?.message,
    ).toContain('GOOGLE_CLIENT_SECRET');
    expect(
      validate({ ...redis, GITHUB_CLIENT_SECRET: 'secret' }).error?.message,
    ).toContain('GITHUB_CLIENT_ID');
  });
});

describe('envSchema KMS', () => {
  const redis = { REDIS_URL: 'redis://localhost:6379' };

  it('accepts host:port addresses', () => {
    for (const KMS_ADDRESS of [
      'localhost:50051',
      'kms.internal:443',
      '10.0.0.5:50051',
    ]) {
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

describe('envSchema master accounts and free plan', () => {
  const redis = { REDIS_URL: 'redis://localhost:6379' };

  it('accepts a comma-separated list of master emails', () => {
    const { error } = validate({
      ...redis,
      MASTER_EMAILS: 'you@cipherion.com, ops@cipherion.com',
    });
    expect(error).toBeUndefined();
  });

  it('names the entries that are not emails', () => {
    const { error } = validate({
      ...redis,
      MASTER_EMAILS: 'you@cipherion.com,nope,',
    });
    expect(error?.message).toBe(
      '"MASTER_EMAILS" must be a comma-separated list of emails (nope, )',
    );
  });

  it('refuses the old MASTER_EMAIL with the new name', () => {
    const { error } = validate({ ...redis, MASTER_EMAIL: 'you@cipherion.com' });
    expect(error?.message).toBe(
      '"MASTER_EMAIL" was renamed to "MASTER_EMAILS" (a comma-separated list)',
    );
  });

  it('defaults the free-plan limits and refuses negative ones', () => {
    const { value } = validate(redis);
    expect(value.FREE_PLAN_MAX_PROJECTS).toBe(1);
    expect(value.FREE_PLAN_MAX_ENCRYPTIONS_PER_MONTH).toBe(500);
    expect(
      validate({ ...redis, FREE_PLAN_MAX_DEVICES: '-1' }).error?.message,
    ).toContain('FREE_PLAN_MAX_DEVICES');
  });
});
