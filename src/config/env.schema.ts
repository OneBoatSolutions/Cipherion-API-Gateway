import Joi from 'joi';
import { FREE_PLAN_DEFAULTS } from './free-plan.js';

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

// A comma-separated list in which every entry is an email.
const everyEmail: Joi.CustomValidator<string> = (value, helpers) => {
  const invalid = value
    .split(',')
    .map((email) => email.trim())
    .filter((email) => Joi.string().email().validate(email).error);
  return invalid.length
    ? helpers.error('emails.invalid', { invalid: invalid.join(', ') || '""' })
    : value;
};

// A path to a PEM file the engine listener can't start without.
const engineFile = Joi.when('DEVICE_ENGINE_ENABLED', {
  is: true,
  // `then` is Joi's conditional API here, not a Promise-like object.
  // oxlint-disable-next-line unicorn/no-thenable
  then: Joi.string().required(),
  otherwise: Joi.string().optional(),
});

// Required everywhere except NODE_ENV=test.
const outsideTests = (schema: Joi.Schema) =>
  Joi.when('NODE_ENV', {
    is: 'test',
    // `then` is Joi's conditional API here, not a Promise-like object.
    // oxlint-disable-next-line unicorn/no-thenable
    then: schema.optional(),
    otherwise: schema.required(),
  });

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
  // A PEM file of CAs to trust for both databases' TLS certificates, for a
  // Postgres signed by a private CA (self-hosted, or a platform's own CA). May
  // hold several CAs, for rotation. Not needed when a public CA signed it.
  DATABASE_CA_CERT: Joi.string().optional(),
  // A PEM CA to trust for Redis's TLS certificate, for a self-signed one such
  // as the local docker Redis. Not needed when a public CA signed it. Only
  // meaningful with rediss://.
  REDIS_CA_CERT: Joi.string().when('REDIS_URL', {
    is: Joi.string().pattern(/^rediss:\/\//),
    // `then` is Joi's conditional API here, not a Promise-like object.
    // oxlint-disable-next-line unicorn/no-thenable
    then: Joi.optional(),
    otherwise: Joi.forbidden().messages({
      'any.unknown': '"REDIS_CA_CERT" needs a rediss:// (TLS) REDIS_URL',
    }),
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

  // The engine's own TLS listener, published directly and never through a proxy.
  // Turning it off closes the port. Nothing turns the certificate checks off.
  DEVICE_ENGINE_ENABLED: Joi.boolean().default(false),
  DEVICE_ENGINE_HOST: Joi.string().default('0.0.0.0'),
  DEVICE_ENGINE_PORT: Joi.number()
    .port()
    .default(3443)
    .invalid(Joi.ref('PORT'))
    .messages({
      'any.invalid': '"DEVICE_ENGINE_PORT" must differ from "PORT"',
    }),
  DEVICE_TLS_KEY: engineFile,
  DEVICE_TLS_CERT: engineFile,
  DEVICE_TLS_PIN_FILE: engineFile,
  DEVICE_CA_BUNDLE: engineFile,

  // Verification, password reset and password changed emails, over SMTP.
  // Tests replace the sender instead. Port 465 uses TLS from the start; other
  // ports upgrade with STARTTLS, which production requires.
  EMAIL_HOST: outsideTests(Joi.string().hostname()),
  EMAIL_PORT: outsideTests(Joi.number().port()),
  // Both or neither: a local catcher such as Mailpit takes no login.
  EMAIL_USER: Joi.string().optional(),
  EMAIL_PASS: Joi.string().optional(),
  EMAIL_FROM: outsideTests(Joi.string()),

  // Google and GitHub sign-in, each on only when both of its values are set.
  GOOGLE_CLIENT_ID: Joi.string().optional(),
  GOOGLE_CLIENT_SECRET: Joi.string().optional(),
  GITHUB_CLIENT_ID: Joi.string().optional(),
  GITHUB_CLIENT_SECRET: Joi.string().optional(),

  // Comma-separated emails of the master accounts: no free-plan limits, and
  // the only ones that can read the platform metrics. Unset means no master.
  // Each counts only once its address is verified.
  MASTER_EMAILS: Joi.string()
    .custom(everyEmail)
    .messages({
      'emails.invalid':
        '"MASTER_EMAILS" must be a comma-separated list of emails ({{#invalid}})',
    })
    .optional(),
  MASTER_EMAIL: Joi.forbidden().messages({
    'any.unknown':
      '"MASTER_EMAIL" was renamed to "MASTER_EMAILS" (a comma-separated list)',
  }),
  ...Object.fromEntries(
    Object.entries(FREE_PLAN_DEFAULTS).map(([name, value]) => [
      name,
      Joi.number().integer().min(0).default(value),
    ]),
  ),

  OBSERVE_APP_KEY: Joi.string().optional(),
  OBSERVE_APP_SECRET: Joi.string().optional(),
})
  .and('EMAIL_USER', 'EMAIL_PASS')
  .and('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
  .and('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET');
