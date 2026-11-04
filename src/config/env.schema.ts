import Joi from 'joi';

// CipSeq holds key material, so in production it must not live in the auth
// database.
const separateFromAuthDatabase: Joi.CustomValidator<string> = (
  value,
  helpers,
) => {
  const env = helpers.state.ancestors[0] as {
    NODE_ENV?: string;
    DATABASE_URL?: string;
  };
  if (env.NODE_ENV !== 'production' || !env.DATABASE_URL) {
    return value;
  }

  const auth = new URL(env.DATABASE_URL);
  const cipseq = new URL(value);
  if (auth.host === cipseq.host && auth.pathname === cipseq.pathname) {
    return helpers.error('cipseq.sharedDatabase');
  }
  return value;
};

// Validated by ConfigModule at startup, so a misconfigured deployment fails immediately.
export const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  PORT: Joi.number().port().default(3000),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),

  CIPSEQ_DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required()
    .custom(separateFromAuthDatabase)
    .messages({
      'cipseq.sharedDatabase':
        '"CIPSEQ_DATABASE_URL" must point to a different database than "DATABASE_URL" when NODE_ENV is production',
    }),

  BETTER_AUTH_SECRET: Joi.string().min(32).required(),
  BETTER_AUTH_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  AUTH_TRUSTED_ORIGINS: Joi.string().required(),

  // Sessions travel over this connection, so production must use TLS (rediss://).
  REDIS_URL: Joi.when('NODE_ENV', {
    is: 'production',
    // `then` is Joi's conditional API here, not a Promise-like object.
    // oxlint-disable-next-line unicorn/no-thenable
    then: Joi.string()
      .uri({ scheme: ['rediss'] })
      .required()
      .messages({
        'string.uriCustomScheme':
          '"REDIS_URL" must use rediss:// (TLS) when NODE_ENV is production',
      }),
    otherwise: Joi.string()
      .uri({ scheme: ['redis', 'rediss'] })
      .required(),
  }),

  // Cipherion KMS over gRPC with mutual TLS. The three paths point to PEM files.
  KMS_ADDRESS: Joi.string()
    .pattern(/^[^\s:/]+:\d{1,5}$/)
    .required()
    .messages({
      'string.pattern.base':
        '"KMS_ADDRESS" must be host:port, e.g. localhost:50051',
    }),
  KMS_CA_CERT: Joi.string().required(),
  KMS_CLIENT_CERT: Joi.string().required(),
  KMS_CLIENT_KEY: Joi.string().required(),

  OBSERVE_APP_KEY: Joi.string().optional(),
  OBSERVE_APP_SECRET: Joi.string().optional(),
});
