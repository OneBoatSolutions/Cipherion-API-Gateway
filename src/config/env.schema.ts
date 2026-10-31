import Joi from 'joi';

// Validated by ConfigModule at startup, so a misconfigured deployment fails immediately.
export const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  PORT: Joi.number().port().default(3000),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),

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

  OBSERVE_APP_KEY: Joi.string().optional(),
  OBSERVE_APP_SECRET: Joi.string().optional(),
});
