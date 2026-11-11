# Cipherion API Gateway

A unified API gateway for the Cipherion product suite. It gives clients a single entry point, with shared authentication, rate limiting, validation and observability, and it hosts the backends of these products as modules of the same service:

| Product | Description | Status |
| --- | --- | --- |
| **Dashboard** | Backend of the Cipherion web dashboard: profile, settings, account activity, billing/subscription | In progress |
| **CipSeq** | Projects, groups, invitations, devices and key management. All crypto runs in the Cipherion KMS (gRPC over TLS); CipSeq stores the wrapped keys in its own PostgreSQL database | In progress |
| **Cipherion EnQrypt** | Encryption service | Deferred |
| **Zentriq** | Zentriq service | Deferred |

> **Status:** early development. The core runtime (NestJS on Fastify, environment validation, Prisma/PostgreSQL, Redis, Better Auth and Nest Observe) is set up, and the auth, Dashboard and CipSeq project endpoints are live under `/api/v1`. The rest of the Dashboard and CipSeq modules are being built.

---

## Architecture

```
                 ┌──────────────────────────────────────────┐
  Dashboard ───► │          Cipherion API Gateway           │
  API clients ─► │  Auth · Rate limit · Validation · Tracing│
                 │  ┌──────────────────┐ ┌───────────────┐  │
                 │  │ Dashboard module │ │ CipSeq module │  │ ── gRPC + TLS ──► Cipherion KMS
                 │  └──────────────────┘ └───────────────┘  │                  (all crypto)
                 └─────┬──────────────────┬────────────┬────┘
                       │                  │            │
                     Redis           PostgreSQL    PostgreSQL (CipSeq)
          (session cache,          (users, sessions, (projects, groups, keys,
           rate limits)             settings)        devices, certificates, audit)

  Device engine ──► engine listener :3443 (own TLS, pinned key, device certificates) ──► same modules
```

The console app sits behind Traefik on `PORT`. The [engine listener](#engine-listener) is a second Nest app in the same process, published directly.

**Responsibilities**

- **Authentication**: email/password sign-in through [Better Auth](https://better-auth.com). Sessions last a fixed 1 day and are never extended, because a stolen session can enrol a device certificate for as long as it lasts. The engine sends the session as `Authorization: Bearer <token>`, using the signed token from the `set-auth-token` header at sign-in. User, session and account ids are UUID v4. They are cached in Redis and also stored in PostgreSQL, which stays the source of truth: if a Redis entry is missing, the session is read from the database. Signing out removes the Redis entry, so a revoked session stops working immediately. If Redis is unreachable, auth fails closed: auth and protected routes answer `503 Service Unavailable` within about 2 seconds, and work again as soon as Redis is back.
- **Rate limiting**: 100 requests per 60-second window, counted atomically in Redis so the limit holds across instances.
- **Request validation**: a global `ValidationPipe` that removes unknown fields, rejects requests containing them, and returns errors in one consistent format.
- **Configuration safety**: environment variables are checked with Joi when the app starts, so a misconfigured deployment fails immediately.
- **Observability**: tracing, metrics, logs and error tracking through [NestJS Observe](https://observe.nestjs.com).
- **Dashboard** *(in progress)*: profile, settings and account activity for the signed-in user. Billing/subscription is deferred.
- **CipSeq** *(in progress)*: projects, groups, key rotation, in-app invitations, device registration and revocation, device certificates, and delivering keys to devices over the engine listener (available; the encrypt and decrypt response is not yet the full agreed contract). CipSeq calls the Cipherion KMS over gRPC for every crypto operation and keeps its data, including an audit event for each operation, in a separate PostgreSQL database.
- **EnQrypt and Zentriq** *(deferred)*.

## Tech stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 22.23.2+, TypeScript (ESM) |
| Framework | NestJS 12 with the Fastify adapter |
| Database | PostgreSQL, Prisma ORM 7 (`@prisma/adapter-pg` driver adapter) |
| Cache | Redis 7, `ioredis` |
| KMS client | gRPC with mutual TLS (`@grpc/grpc-js`), types generated from `.proto` by `ts-proto` through `buf` |
| Auth | Better Auth with the Prisma adapter and Redis secondary storage |
| Validation | class-validator, class-transformer, Joi (environment) |
| Observability | `@nestjs/observe` |
| API docs | `@nestjs/swagger` (Swagger UI) with Better Auth's `openAPI()` plugin |
| Tooling | Vitest, oxlint, Prettier |

## Project structure

```
.
├── prisma/
│   ├── schema.prisma        # Auth database schema (User, Session, Account, Verification, RateLimit, UserSettings)
│   ├── migrations/          # Auth database migrations (commit every migration)
│   └── cipseq/              # CipSeq database: schema.prisma and migrations/
├── prisma7.config.ts        # Prisma config for the auth database; loads .env.dev / .env.prod / .env.test from NODE_ENV
├── prisma7.cipseq.config.ts # Prisma config for the CipSeq database
├── proto/kms/               # KMS gRPC contract copied from the KMS (v1/) and the standard grpc/health/v1 proto
├── buf.yaml, buf.gen.yaml   # buf module and ts-proto generation into src/generated/kms
├── src/
│   ├── main.ts              # Bootstrap: Fastify adapter, configureApp(), setupOpenApi(), port binding
│   ├── app.setup.ts         # configureApp(): /api/v1 prefix, CORS, global ValidationPipe
│   ├── openapi.ts           # setupOpenApi(): Swagger UI at /api/v1/docs (not in production)
│   ├── app.module.ts        # Root module: ConfigModule (Joi validation), ObserveModule, AuthModule, HealthModule
│   ├── config/env.ts        # Loads the env file before anything reads process.env
│   ├── auth.ts              # Better Auth configuration
│   ├── auth/                # AuthController (/api/v1/auth/*), global AuthGuard, @Public() / @CurrentUser(), email templates, Google/GitHub providers
│   ├── dashboard/           # Dashboard routes (/api/v1/dashboard/profile, /settings)
│   ├── cipseq/              # CipSeq routes (projects, groups, invitations, devices), envelope jobs, access checks, audit events, device certificates and envelope delivery
│   ├── engine/              # Engine listener on :3443: TLS setup, device identity, guards, enrol/renew and encrypt/decrypt controllers
│   ├── workspace/           # GET /api/v1/workspace: everything the signed-in user is a part of
│   ├── health/              # Liveness (/api/v1/health) and readiness (/api/v1/ready) endpoints
│   ├── lib/prisma.ts        # Shared pg pool and PrismaClient for the auth database
│   ├── lib/cipseq-prisma.ts # Shared pg pool and PrismaClient for the CipSeq database
│   ├── lib/database-watch.ts# Heartbeat and connection-loss logging for both pools
│   ├── lib/startup-checks.ts# Exits with code 1 if a database is unreachable at startup
│   ├── lib/redis.ts         # Shared Redis client (sessions, rate limits, caching)
│   ├── lib/kms.ts           # Shared KMS gRPC client (mTLS) and its health client
│   ├── lib/mailer.ts        # Shared SMTP sender: queued, pooled, never awaited by a request
│   ├── kms/kms-call.ts      # kmsCall(): one KMS RPC with a 2 s deadline, gRPC status → HTTP error
│   └── generated/           # Generated clients: prisma/, cipseq/ (Prisma) and kms/ (gRPC). Do not edit by hand
├── scripts/                 # certs:engine (engine key and pin) and users:migrate-ids (one-off UUID migration)
├── docs/                    # Device certificates, TLS pins, envelope signing and environment settings
├── test/                    # End-to-end tests (helpers/ cleans up test users and makes throwaway keys)
├── .env.example             # Template for environment variables
└── package.json
```

---

## Getting started

### Prerequisites

- **Node.js** 22.23.2 or later, and npm. The engine listener needs Node's OpenSSL to be 3.5 or later, and start-up fails if it isn't
- **OpenSSL** 3.5 or later on the `PATH`, only for `npm run certs:engine` and the e2e tests
- **PostgreSQL** 14 or later, running locally, in Docker, or hosted
- **Redis** 6.2 or later (`GETDEL` is required), running locally, in Docker, or hosted
- **Cipherion KMS** running and reachable over gRPC with mutual TLS (locally on `localhost:50051`), plus a CA certificate for the KMS and a client certificate and key for the gateway
- **An SMTP server** for verification and password reset emails. Locally, Mailpit (see [Auth endpoints](#auth-endpoints))

To run PostgreSQL, Redis and Mailpit quickly with Docker:

```bash
docker run -d --name cipherion-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=cipherion_gateway \
  -p 5432:5432 postgres:16

docker run -d --name cipherion-redis -p 6379:6379 redis:7

docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
```

CipSeq has its own database. Locally it can live in the same container:

```bash
docker exec cipherion-postgres psql -U postgres -c "CREATE DATABASE cipherion_cipseq"
```

### 1. Clone and install

```bash
git clone <repository-url>
cd Cipherion-API_Gateway
npm install
```

### 2. Configure the environment

Copy the template and fill in your values:

```bash
cp .env.example .env.dev
```

The application loads its environment file in this order:

1. `.env`, if it exists
2. Otherwise `.env.prod` when `NODE_ENV=production`
3. Otherwise `.env.dev`

The Prisma CLI configs (`prisma7.config.ts`, `prisma7.cipseq.config.ts`) choose `.env.dev`, `.env.prod` or `.env.test` based on `NODE_ENV`.

See [docs/environment.md](docs/environment.md) for when each one is required, local and production values, and the two CA files that are easy to mix up.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | `development`, `test` or `production` |
| `PORT` | No | `3000` | Port the gateway listens on (binds to `0.0.0.0`) |
| `DATABASE_URL` | **Yes** | – | Auth database (users, sessions, settings), e.g. `postgresql://postgres:password@localhost:5432/cipherion_gateway` |
| `CIPSEQ_DATABASE_URL` | **Yes** | – | CipSeq database (projects, groups, keys, devices, audit, billing), e.g. `postgresql://postgres:password@localhost:5432/cipherion_cipseq`. Must be a different database from `DATABASE_URL` when `NODE_ENV=production` |
| `BETTER_AUTH_SECRET` | **Yes** | – | Secret used to sign sessions. Must be **at least 32 characters** |
| `BETTER_AUTH_URL` | **Yes** | – | Public base URL of the gateway, e.g. `http://localhost:3000` |
| `AUTH_TRUSTED_ORIGINS` | **Yes** | – | Comma-separated list of origins allowed to call auth endpoints (for example, the dashboard URL) |
| `REDIS_URL` | **Yes** | – | Redis connection string (`redis://` or `rediss://` for TLS; `rediss://` is required when `NODE_ENV=production`), e.g. `redis://localhost:6379` |
| `EMAIL_HOST` | **Yes**, except `NODE_ENV=test` | – | SMTP server for verification, password reset and password changed emails, e.g. `localhost` (Mailpit) |
| `EMAIL_PORT` | **Yes**, except `NODE_ENV=test` | – | SMTP port. `465` uses TLS from the start, other ports upgrade with STARTTLS. Production requires TLS |
| `EMAIL_USER`, `EMAIL_PASS` | No | – | SMTP login, both or neither (Mailpit takes none). `EMAIL_PASS` is **secret** |
| `EMAIL_FROM` | **Yes**, except `NODE_ENV=test` | – | Sender of those emails, e.g. `Cipherion <no-reply@cipherion.com>`. Most providers only send as the login's own address |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | – | Google sign-in, on when both are set. Redirect URI: `<BETTER_AUTH_URL>/api/v1/auth/callback/google` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | No | – | GitHub sign-in, on when both are set. Redirect URI: `<BETTER_AUTH_URL>/api/v1/auth/callback/github` |
| `KMS_ADDRESS` | **Yes** | – | Cipherion KMS gRPC address as `host:port`, e.g. `localhost:50051` |
| `KMS_CA_CERT` | **Yes** | – | Path to the PEM CA certificate that signed the KMS server certificate |
| `KMS_CLIENT_CERT` | **Yes** | – | Path to the gateway's PEM client certificate (mutual TLS), signed by a CA the KMS trusts |
| `KMS_CLIENT_KEY` | **Yes** | – | Path to the gateway's PEM client private key |
| `DEVICE_ENGINE_ENABLED` | No | `false` | Starts the engine's TLS listener. `false` closes the port, and nothing turns the certificate checks off |
| `DEVICE_ENGINE_HOST` | No | `0.0.0.0` | Listener address (`127.0.0.1` locally) |
| `DEVICE_ENGINE_PORT` | No | `3443` | Listener port. Must differ from `PORT` |
| `DEVICE_TLS_KEY` | When enabled | – | **Secret.** Path to the private key of the active server key |
| `DEVICE_TLS_CERT` | When enabled | – | Path to its certificate |
| `DEVICE_TLS_PIN_FILE` | When enabled | – | Path to the active pin. Start-up refuses a key that doesn't match it |
| `DEVICE_CA_BUNDLE` | When enabled | – | Path to the device CAs (`device-ca-trust.pem`), holding every CA currently in a slot. Not the same file as `KMS_CA_CERT` |
| `OBSERVE_APP_KEY` | No | – | NestJS Observe app key |
| `OBSERVE_APP_SECRET` | No | – | NestJS Observe app secret |

To generate a strong `BETTER_AUTH_SECRET`:

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Example `.env.dev`:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://postgres:password@localhost:5432/cipherion_gateway
CIPSEQ_DATABASE_URL=postgresql://postgres:password@localhost:5432/cipherion_cipseq

BETTER_AUTH_SECRET=replace-with-a-random-string-of-at-least-32-chars
BETTER_AUTH_URL=http://localhost:3000
AUTH_TRUSTED_ORIGINS="http://localhost:3000,http://localhost:5173"

REDIS_URL=redis://localhost:6379

EMAIL_HOST=localhost
EMAIL_PORT=1025
EMAIL_FROM="Cipherion <no-reply@cipherion.local>"

KMS_ADDRESS=localhost:50051
KMS_CA_CERT=/home/you/.cipherion/kms-tls/ca.crt
KMS_CLIENT_CERT=/home/you/.cipherion/kms-tls/gateway.crt
KMS_CLIENT_KEY=/home/you/.cipherion/kms-tls/gateway.key
```

> Never commit `.env`, `.env.dev` or `.env.prod`. Only `.env.example` belongs in version control.

### 3. Set up the databases

There are two Prisma setups, one per database. Every Prisma command needs `--config` to pick one:

| Database | Config | Schema | Client |
| --- | --- | --- | --- |
| Auth (`DATABASE_URL`) | `prisma7.config.ts` | `prisma/schema.prisma` | `src/generated/prisma` |
| CipSeq (`CIPSEQ_DATABASE_URL`) | `prisma7.cipseq.config.ts` | `prisma/cipseq/schema.prisma` | `src/generated/cipseq` |

```bash
# Generate both Prisma Clients
npm run db:generate

# Apply migrations (development)
npm run db:migrate          # auth database
npm run db:migrate:cipseq   # CipSeq database

# Create a new migration after changing a schema
npx prisma migrate dev --name <name> --config prisma7.config.ts
npx prisma migrate dev --name <name> --config prisma7.cipseq.config.ts
```

Optionally, open Prisma Studio to browse the data:

```bash
npx prisma studio --config prisma7.config.ts
npx prisma studio --config prisma7.cipseq.config.ts
```

### 4. Connect to the KMS

CipSeq delegates every crypto operation to the Cipherion KMS over gRPC with **mutual TLS**: the gateway verifies the KMS certificate against `KMS_CA_CERT` and presents its own certificate (`KMS_CLIENT_CERT` / `KMS_CLIENT_KEY`). There is no plaintext mode.

The contract lives in `proto/kms/v1/prototypeBufferV1.proto`, copied from the KMS. When the KMS contract changes, copy the new `.proto` over it and regenerate the typed client into `src/generated/kms`:

```bash
npm run proto:generate
```

The gateway calls the KMS through `kmsCall()` (`src/kms/kms-call.ts`):

- **Deadline:** every call has a 2-second deadline.
- **No retries:** creating or rotating keys twice isn't safe.
- **Error mapping:**

  | gRPC status from the KMS | HTTP status |
  | --- | --- |
  | `UNAVAILABLE`, `DEADLINE_EXCEEDED` | `503` |
  | `INVALID_ARGUMENT`, `FAILED_PRECONDITION` | `400` |
  | `NOT_FOUND` | `404` |
  | `ALREADY_EXISTS` | `409` |
  | `PERMISSION_DENIED` from an RPC listed in `PASSPHRASE_CHECKING_METHODS` (project rotation, group keys) | `403` |
  | anything else | `502` |

- **No leaks:** clients get a generic message; the gRPC details go only to the `[KMS]` log. Request data, which includes passphrases, is never logged.

The gateway connects to the KMS at startup and keeps the connection open. Like Redis, a lost connection is logged once with its reason and once when it is back:

```
ERROR [KMS] Connection lost, reconnecting: ECONNREFUSED
LOG   [KMS] Connection restored
```

`ECONNRESET` or `TLS: tlsv1 alert unknown ca` usually means the KMS doesn't trust the gateway's client certificate.

### 5. Startup checks and connection logs

Before Nest starts, the gateway runs `SELECT 1` on both databases (5-second timeout). If either fails, it logs which one and why, then **exits with code 1**, so Docker, Kubernetes or systemd treat it as a failed start:

```
LOG   [Startup] Connected to the auth and CipSeq databases
ERROR [Startup] Can't connect to the CipSeq database (localhost:5432/cipherion_cipseq): 3D000 database "cipherion_cipseq" does not exist
ERROR [Startup] Exiting: a database is unreachable
```

Only host, port and database name are logged, never the user or password. Redis and the KMS aren't required at startup: their outages are logged and reported by `/ready`.

While the gateway runs, every dependency logs a lost connection once, with its reason, and its recovery once:

| Dependency | Log context | Example reason |
| --- | --- | --- |
| Auth database | `[Database]` | `ECONNREFUSED`, `57P01 terminating connection due to administrator command` |
| CipSeq database | `[CipSeqDatabase]` | same as above |
| Redis | `[Redis]` | `ECONNREFUSED` |
| KMS | `[KMS]` | `ECONNREFUSED`, `TLS: tlsv1 alert unknown ca` |

```
ERROR [Database] Connection lost, reconnecting: ECONNREFUSED
LOG   [Database] Connection restored
```

The databases are checked by a `SELECT 1` every 5 seconds, so an outage is noticed even without traffic.

### 6. Run the gateway

```bash
# development
npm run start

# watch mode (recommended for local work)
npm run start:dev

# debug mode with watch
npm run start:debug
```

The gateway starts on `http://localhost:3000` (or on `PORT` if set). Every route is served under the `/api/v1` prefix. To check that it is running:

```bash
curl http://localhost:3000/api/v1
curl http://localhost:3000/api/v1/ready   # also checks PostgreSQL and Redis
```

The API documentation is at http://localhost:3000/api/v1/docs.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run start` | Start the app |
| `npm run start:dev` | Start in watch mode |
| `npm run start:debug` | Start in debug mode with watch |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build (`node dist/main`) |
| `npm run lint` | Lint `src/` and `test/` with oxlint (type-aware) |
| `npm run format` | Format code with Prettier |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:watch` | Run unit tests in watch mode |
| `npm run test:cov` | Run unit tests with coverage |
| `npm run test:e2e` | Run end-to-end tests (needs both databases, Redis and the KMS running locally) |
| `npm run proto:generate` | Regenerate the typed KMS gRPC client from `proto/kms` into `src/generated/kms` |
| `npm run users:migrate-ids` | One-off: gives users created before UUID ids a UUID v4, in both databases, and signs them out. Dry run by default; `-- --apply` makes the change. Stop the gateway and back up both databases first. Safe to rerun, and resumes if interrupted |
| `npm run certs:engine` | Create a development server key, certificate and pin in `certs/engine`. Never replaces a key; `-- --renew` renews the certificate and keeps the pin |

## API documentation

Outside production, the gateway serves an OpenAPI 3.1 document:

| Path | Description |
| --- | --- |
| `/api/v1/docs` | Swagger UI |
| `/api/v1/docs-json` | The OpenAPI document as JSON (for Postman, client generators, etc.) |

The document combines the gateway's own controllers with every Better Auth endpoint, generated by Better Auth's `openAPI()` plugin and listed under `/api/v1/auth` with the `auth` tag. The docs routes need no session.

**In production (`NODE_ENV=production`) the docs are not served**, and the Better Auth `openAPI()` plugin isn't registered, so `/api/v1/docs`, `/api/v1/docs-json` and `/api/v1/auth/open-api/generate-schema` all return `404`. This keeps the full API surface from being advertised publicly.

When you add a route, document it with `@nestjs/swagger` decorators. Declare response shapes as classes with `@ApiProperty()` (see `src/health/health.dto.ts`), and mark routes that need a session with `@ApiCookieAuth()`:

```ts
@ApiTags('example')
@Controller('example')
export class ExampleController {
  @ApiCookieAuth()
  @ApiOkResponse({ type: ProfileResponse })
  @Get('me')
  me(@CurrentUser() user: AuthUser): ProfileResponse { /* … */ }
}
```

## Auth endpoints

Better Auth is mounted at `/api/v1/auth/*`. Sessions are returned as cookies, and browsers can only call these endpoints from an origin listed in `AUTH_TRUSTED_ORIGINS` (CORS with credentials). Better Auth also checks the `Origin` header of state-changing requests against that list, so the curl examples below send one.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/v1/auth/sign-up/email` | Create an account (`name`, `email`, `password`, optional `callbackURL`). Returns no session; emails a verification link |
| `GET` | `/api/v1/auth/verify-email?token=…&callbackURL=…` | The link in that email. Verifies the address and redirects to `callbackURL` (with `?error=…` if the link is invalid or expired). Creates no session |
| `POST` | `/api/v1/auth/send-verification-email` | Send a new link (`email`, optional `callbackURL`). 3 per minute per IP |
| `POST` | `/api/v1/auth/sign-in/email` | Sign in (`email`, `password`) and receive the session cookie. `403` `EMAIL_NOT_VERIFIED` until verified, which also sends a new link |
| `POST` | `/api/v1/auth/request-password-reset` | Email a reset link (`email`, `redirectTo`). Answers the same whether or not the account exists. 3 per minute per IP |
| `GET` | `/api/v1/auth/reset-password/:token?callbackURL=…` | The link in that email. Redirects to `redirectTo?token=…`, or `?error=INVALID_TOKEN` |
| `POST` | `/api/v1/auth/reset-password` | Set the new password (`newPassword`, `token`). Works once; ends every session and marks the email verified |
| `POST` | `/api/v1/auth/change-password` | Signed in: `currentPassword`, `newPassword`. Always signs out every other session, keeps this one with a fresh cookie, and emails the owner |
| `POST` | `/api/v1/auth/sign-in/social` | `provider` (`google` or `github`), `callbackURL`, optional `errorCallbackURL`. Returns `{ url }` for the browser; `404` if that provider isn't configured |
| `GET` | `/api/v1/auth/callback/:provider` | Where Google or GitHub send the user back. Sets the session cookie and redirects to `callbackURL`. `504` after 10 seconds |
| `GET` | `/api/v1/auth/get-session` | Current user and session, or `null` |
| `POST` | `/api/v1/auth/sign-out` | End the current session |

`callbackURL`, `redirectTo` and `errorCallbackURL` are the frontend's own pages. Their origin must be in `AUTH_TRUSTED_ORIGINS`, or the request answers `403`.

**Rules worth knowing**

- Links in emails last 1 hour, and never create a session: after verifying, the user signs in with their password.
- Google or GitHub sign-in joins an existing account only if its email is verified. Otherwise it fails with `account_not_linked`, and the user verifies first (by signing in with the password, or with a reset).
- Someone who registered with Google or GitHub has no password, so change password answers `400` `CREDENTIAL_ACCOUNT_NOT_FOUND`. A password reset sets one.
- Signing up with an email that already has an account answers like a new sign-up, creates nothing and changes nothing.
- Emails are queued and sent in the background, so no request waits on the mail server, and a failure is only logged.

**Email locally:** [Mailpit](https://mailpit.axllent.org) catches every email, with an inbox at http://localhost:8025 and no login:

```bash
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
```

with `EMAIL_HOST=localhost` and `EMAIL_PORT=1025`.

**Google and GitHub:** create an OAuth app with each, with the redirect URI `<BETTER_AUTH_URL>/api/v1/auth/callback/google` (or `/github`), and set both of its variables.

```bash
# sign up; the verification link arrives by email (Mailpit locally)
curl -X POST http://localhost:3000/api/v1/auth/sign-up/email \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"name":"Jane","email":"jane@example.com","password":"a-strong-password","callbackURL":"http://localhost:3000/"}'

# open the link from the email, then sign in and store the session cookie
curl -X POST http://localhost:3000/api/v1/auth/sign-in/email -c cookies.txt \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"email":"jane@example.com","password":"a-strong-password"}'

# read the session with the stored cookie
curl http://localhost:3000/api/v1/auth/get-session -b cookies.txt
```

The e2e tests (`npm run test:e2e`) exercise these endpoints against the `.env.dev` database and Redis, and delete the test user and its cached sessions afterwards. They never send email: `test/setup-e2e.ts` replaces the mailer, and tests read the links from its calls. Tests that only need a signed-in user use `signUpVerified()` from `test/helpers/users.ts`.

> **Always delete users and revoke sessions through Better Auth** (`auth.api.*`), never with raw Prisma. Better Auth also removes the cached copy from Redis. A session deleted only from PostgreSQL stays valid in Redis until its TTL (up to 1 day) runs out.

## Health checks

Both endpoints are public, so load balancers and orchestrators can call them without a session.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Liveness: `200 {"status":"ok"}` whenever the process is running. It never checks dependencies, so a database or Redis outage doesn't get healthy instances restarted. |
| `GET` | `/api/v1/ready` | Readiness: checks the auth database and the CipSeq database (`SELECT 1`), Redis (`PING`) and the KMS (`grpc.health.v1.Health/Check` must answer `SERVING`) together. `200` when all four answer; `503` when any is down or takes longer than 2 seconds. |

```json
// GET /api/v1/ready while Redis is down → 503
{ "status": "error", "checks": { "database": "up", "cipseq": "up", "redis": "down", "kms": "up" } }
```

The response only says `up` or `down` for each dependency, never error details.

## Dashboard

Routes for the signed-in user's dashboard. They need the session cookie.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/dashboard/profile` | The user's `id`, `name`, `email`, `emailVerified` and `createdAt`, served from the session without a database query. |
| `PATCH` | `/api/v1/dashboard/profile` | Changes the `name` (1–100 characters). It goes through Better Auth, so the user cached with the session in Redis is refreshed too. Other fields return `400`. |
| `GET` | `/api/v1/dashboard/settings` | The user's settings. A user who has never saved settings gets the defaults: `{"timezone":"UTC","locale":"en","securityAlerts":true}`. |
| `PATCH` | `/api/v1/dashboard/settings` | Updates only the fields sent: `timezone` (IANA, e.g. `Asia/Kolkata`), `locale` (BCP 47, e.g. `en-IN`) and `securityAlerts` (in-app alerts for security events). Invalid values or unknown fields return `400`. |

The password is changed through Better Auth's `/api/v1/auth/change-password` (see [Auth endpoints](#auth-endpoints)). Changing the email address isn't available yet.

Cipherion has no profile images. Better Auth's user table requires an `image` column, so the column stays, but `/api/v1/auth/sign-up/email` and `/api/v1/auth/update-user` reject an `image` field with `400` and it is always `null`.

## Workspace

`GET /api/v1/workspace` returns everything the signed-in user is a part of in one read, for sign-in and page load. Writes return the changed object, so a client doesn't need to reload it after each one.

```json
{
  "profile": { "id": "...", "name": "Ada Lovelace", "email": "ada@cipherion.com", "emailVerified": true, "createdAt": "..." },
  "settings": { "timezone": "UTC", "locale": "en", "securityAlerts": true },
  "projects": [
    {
      "id": "...", "name": "Payments", "description": "...", "role": "ADMIN", "keyVersion": 2,
      "createdAt": "...", "updatedAt": "...",
      "groups": [
        {
          "id": "...", "projectId": "...", "name": "Finance", "description": "...", "role": "ADMIN", "gdekVersion": 3,
          "createdAt": "...", "updatedAt": "...",
          "members": [
            { "userId": "...", "name": "Ada Lovelace", "email": "ada@cipherion.com", "role": "ADMIN", "createdAt": "..." }
          ],
          "pendingInvitations": [
            { "id": "...", "projectId": "...", "groupId": "...", "inviteeEmail": "grace@cipherion.com", "status": "PENDING_APPROVAL", "invitedByUserId": "...", "createdAt": "..." }
          ],
          "devices": [
            { "deviceId": "dvc_...", "name": "Work laptop", "userId": "...", "status": "APPROVED", "latestEnvelopeVersion": 3 }
          ]
        }
      ]
    }
  ],
  "devices": [
    {
      "id": "dvc_...", "name": "Work laptop", "status": "ACTIVE", "createdAt": "...",
      "groups": [
        { "projectId": "...", "groupId": "...", "groupName": "Finance", "status": "APPROVED" }
      ]
    }
  ],
  "notifications": [
    {
      "type": "INVITATION_APPROVAL", "id": "...", "projectId": "...", "projectName": "Payments",
      "groupId": "...", "groupName": "Finance", "inviteeEmail": "grace@cipherion.com",
      "invitedByName": "Linus Torvalds", "createdAt": "..."
    }
  ]
}
```

- **Who sees what:** a project's admin gets all its groups and their members. Anyone else gets only the projects where they're in a live group, those groups and those groups' members.
- **Keys:** only the current version numbers. Wrapped keys, salts and envelopes are never returned.
- **Members:** `name` and `email` come from the auth database, and are `null` if the account no longer exists.
- **Notifications:** things for the user to act on or know about, newest first. The `id` is the invitation, device or group it's about.

  | `type` | Who gets it | Extra fields | Goes away when |
  | --- | --- | --- | --- |
  | `INVITATION_RECEIVED` | The invitee, by signed-in email | `invitedByName` | They answer it |
  | `INVITATION_APPROVAL` | Project admin | `inviteeEmail`, `invitedByName` | It's handled |
  | `DEVICE_APPROVAL` | Project admin | `deviceId`, `deviceName`, `deviceUserName`, `groups` | It's handled |
  | `ENVELOPES_IN_PROGRESS` | Project admin | `jobKind`, `missingCount` | The job ends |
  | `ENVELOPES_MISSING` | Project admin | `jobKind`, `failureReason`, `missingCount` | The admin resumes it and nothing is missing |
  | `ENVELOPES_COMPLETED` | Project admin | `jobKind`, `envelopeCount` | The admin dismisses it |

- **Pending lists:** `pendingInvitations` and a group's `devices` are filled for the project admin and acting admins, and empty for everyone else.
- **Errors:** `401` without a session, and `503` if any query fails, so a client never shows a partial workspace as complete. The cause goes to the `[Workspace]` log.
- **Cost:** each call runs several database queries (about 20 SQL statements when measured), so call it on sign-in and page load, and only poll it while a job is in progress. There's no pagination yet.

## CipSeq projects

Routes under `/api/v1/cipseq/projects`. They need the session cookie. The KMS does all the crypto, and the gateway stores the wrapped keys it returns.

| Method | Path | Who | Description |
| --- | --- | --- | --- |
| `POST` | `/` | Signed-in user | Creates a project from `name` (1–100 characters) and `description` (1–500 characters). The caller becomes its one admin. Answers `201`. |
| `POST` | `/:id/initialize` | Admin | Sets the project's `passphrase` (12–256 characters) and creates key version 1. Answers `409` if it is already initialised. |
| `POST` | `/:id/rotate` | Admin | Changes the passphrase from `currentPassphrase` to `newPassphrase` (12–256 characters, different from the current one) and moves to the next key version. Answers `200` with the project, `403` for a wrong current passphrase, and `409` if the project isn't initialised or another rotation got there first. |
| `GET` | `/` | Signed-in user | The caller's projects, newest first. |
| `GET` | `/:id` | Member | One project. |
| `PATCH` | `/:id` | Admin | Updates only the fields sent: `name` and `description`. |
| `DELETE` | `/:id` | Admin | Soft delete, answering `204`: the API stops serving the project, but its rows and wrapped keys stay in the database. |
| `POST` | `/:id/members/:userId/revoke` | Admin | Removes someone from every group in the project and soft deletes all their envelopes there, answering `204`. No passphrase or key change. |

Every project response has this shape. `role` is the caller's role, and `keyVersion` is `null` until the project is initialised:

```json
{
  "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "name": "Payments",
  "description": "Card and invoice data",
  "role": "ADMIN",
  "keyVersion": 1,
  "createdAt": "2026-11-04T06:36:46.000Z",
  "updatedAt": "2026-11-04T06:36:46.000Z"
}
```

- **Access:** a project has no direct members, only members of its groups. Someone in none of its live groups gets `404`, the same as for a project that doesn't exist. A group member who isn't the admin gets `403` on admin routes.
- **Passphrase:** it goes to the KMS and is never stored, logged or audited. The admin can change it, but a lost passphrase can't be recovered.
- **Rotation:** the KMS re-wraps the project encryption key under the new passphrase and a new salt. The key itself and the root key don't change, so anything wrapped under it stays valid. Old wrapped keys aren't kept: `projectKeyVersion` records only each version and its date.
- **Attempt limit:** 5 wrong passphrases per project in 15 minutes, then `429`, even for the correct passphrase, until the window ends. Project rotation and the group and device endpoints that take a passphrase share this limit. Attempts are counted in Redis, so those routes answer `503` while Redis is unreachable. A successful call resets the count, and a KMS failure doesn't use up an attempt.
- **KMS failures:** `503` when the KMS is unreachable or slower than 2 seconds. Other failures follow the `kmsCall()` mapping, usually `502`. Nothing is written, so the client can try again.
- **Audit:** each successful write records an event in the same transaction: `project.created`, `project.initialized`, `project.key_rotated`, `project.updated` or `project.deleted`.

## CipSeq groups

Routes under `/api/v1/cipseq/projects/:projectId/groups`. They need the session cookie. Only the project admin can use them, except that a group's acting admin can revoke members from it: being an admin is per project, so anyone can create their own project, but can't change or approve anything in a project they aren't the admin of. Groups are read through `GET /api/v1/workspace`.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/` | Creates a group from `name` (1–100 characters), `description` (1–500 characters) and the project's `passphrase`, at GDEK version 1. The project admin becomes a group admin. Answers `201`, or `409` if the project isn't initialised. |
| `PATCH` | `/:groupId` | Updates only the fields sent: `name` and `description`. |
| `DELETE` | `/:groupId` | Soft delete, answering `204`: the API stops serving the group, but its rows and wrapped keys stay in the database. |
| `POST` | `/:groupId/rotate` | Replaces the group's keys using the `passphrase`, and moves to the next GDEK version. Answers `200` straight away with `envelopesToCreate` added, and a background job creates the envelopes. A group can rotate once in 48 hours, then `409` with `rotationAllowedAt`. |
| `PATCH` | `/:groupId/members/:userId` | Sets `role` to `ACTING_ADMIN` or `MEMBER`. A group has at most one acting admin, so a second answers `409` until the first is changed back. |
| `POST` | `/:groupId/members/:userId/revoke` | The project admin or the group's acting admin removes the member and soft deletes their devices' envelopes for this group. No passphrase, KMS call or key change. |

Create, update, rotate and revoke answer with the group, and the role change answers with `userId`, `role` and `createdAt`:

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "projectId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "name": "Finance",
  "description": "Invoices and payroll",
  "role": "ADMIN",
  "gdekVersion": 2,
  "createdAt": "2026-11-05T06:36:46.000Z",
  "updatedAt": "2026-11-05T06:36:46.000Z"
}
```

- **Access:** someone outside the project gets `404`. Any other project member gets `403` on project admin routes, including an acting admin. The project admin can't be demoted or revoked (`400`), and an acting admin can't revoke themselves (`400`).
- **Roles are per group:** someone who is an acting admin of another group is a plain member here, and revoking them here leaves their role there unchanged.
- **Keys:** each create and rotate calls `CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey`, which makes a new group root key and GDEK. Only the current pair is stored, in `groupKeys`. `groupKeyVersion` records each version number and its date.
- **Old versions are gone for new devices:** because old pairs aren't kept, a device registered after a rotation can't get an envelope for an older version, so it can't read older data.
- **What revoking protects:** the engine asks for the envelope on every operation and clears it straight away, so a normal engine is cut off at its next request. A modified engine could keep a copy, which opens anything encrypted with that GDEK until the project admin next rotates.
- **Concurrent changes:** `409` if another rotation got there first.
- **Errors and passphrases:** a wrong passphrase answers `403`, and the attempt limit and KMS failures work as for projects. The passphrase is never stored, logged or audited.
- **Audit:** `group.created`, `group.updated`, `group.deleted`, `group.key_rotated`, `group.member_role_changed` and `group.member_revoked`, each in the same transaction as the change.

## CipSeq invitations

Invitations are in-app only: nothing is emailed, and the admin has to tell the person separately. An invitation is stored against an email address and appears in `GET /api/v1/workspace` when someone with that address signs in, including if they sign up later.

Routes under `/api/v1/cipseq/projects/:projectId/groups/:groupId/invitations`:

| Method | Path | Who | Description |
| --- | --- | --- | --- |
| `POST` | `/` | Project admin or acting admin | Invites `email`, answering `201`. The project admin's invitation goes straight to the invitee (`PENDING_ACCEPTANCE`), and an acting admin's waits for approval (`PENDING_APPROVAL`). |
| `POST` | `/:id/approve` | Project admin | Sends an acting admin's invitation on to the invitee. |
| `POST` | `/:id/reject` | Project admin | Refuses an acting admin's invitation. |
| `POST` | `/:id/cancel` | The inviter or project admin | Cancels an open invitation. |

The invitee answers under `/api/v1/cipseq/invitations`:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/:id/accept` | Joins the group as `MEMBER`, and sends an approval request for each of their devices. No keys change: a new member gets the current GDEK once a device is approved. |
| `POST` | `/:id/decline` | Declines. They can be invited again. |

An invitation answers with `{ id, projectId, groupId, inviteeEmail, status, invitedByUserId, createdAt }`.

- **Access:** someone outside the group gets `404`, so they can't confirm it exists. A plain group member gets `403`. An invitation for another email answers `404`.
- **Conflicts:** `409` if the person is already a member, an invitation is already open, or it has already been handled. Each status change applies only if the row still has the expected status, so two people can't act on one invitation.
- **No account check:** inviting answers the same whether or not the address has an account, so it can't be used to discover who has signed up.
- **Emails aren't verified:** anyone can sign up with an invited address and accept. They get no keys, because those need an approved device, but they can see the project and group details and members' names and emails. See the production checklist.

## CipSeq devices

A device registers once, the project admin approves it, and the gateway stores an envelope: the group's GDEK wrapped by the KMS for that device's ML-KEM-1024 key. The device gets the envelope from the [engine listener](#engine-listener), which also proves the device is genuine.

The device's user, under `/api/v1/cipseq/devices`:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/` | Registers `deviceId` (`dvc_` plus 43 base64url characters), `publicKey` (decodes to 1568 bytes) and an optional `name`, answering `201`. Sends an approval request for each group the user is in; with none, it's just registered. Repeating it with the same user and key changes nothing. |
| `POST` | `/:deviceId/groups/:groupId/request-approval` | Asks again for one group, after a rejection or revoke, if they're still a member. Never project-wide, because that would give access to every group at once. |
| `POST` | `/:deviceId/revoke` | Revokes it and its certificates everywhere, answering `204`. Permanent: the id can't be used again. |
| `POST` | `/certificate-notices/:noticeId/dismiss` | Dismisses `DEVICE_CERTIFICATE_ISSUED`, answering `204`, also if there's nothing to dismiss. |

The admins, under `/api/v1/cipseq/projects/:projectId`:

| Method | Path | Who | Description |
| --- | --- | --- | --- |
| `POST` | `/devices/:deviceId/approve` | Project admin | Takes the `passphrase` and approves the device for all its waiting groups in the project. Creates the first envelope in the request, then starts the job. Answers with `envelopesToCreate`. |
| `POST` | `/devices/:deviceId/reject` | Project admin | Rejects it for all its waiting groups, answering `204`. |
| `POST` | `/devices/:deviceId/revoke` | Project admin | Soft deletes all its envelopes in the project, answering `204`. |
| `POST` | `/groups/:groupId/devices/:deviceId/revoke` | Project admin or the group's acting admin | Soft deletes its envelopes for this group, answering `204`. |
| `POST` | `/groups/:groupId/envelopes/renew` | Project admin | Resumes a stopped job with the `passphrase`, answering with `envelopesToCreate`. `409` while a job is running. With nothing missing, it doesn't check the passphrase. |
| `POST` | `/groups/:groupId/envelopes/completed/dismiss` | Project admin | Dismisses `ENVELOPES_COMPLETED`, answering `204`, also if there's nothing to dismiss. |

- **Revoking:** no passphrase, KMS call or key change, so it works while the KMS is down. All versions of the envelopes are soft deleted at once. The device stays registered, so it can still be used in other groups and projects, unless its user revoked it everywhere.
- **Acting admins:** they can only remove members and devices from their own group, and can't target the project admin or themselves (`400`). Only the project admin can remove someone or something from a whole project.
- **The background job:** after an approval or rotation it creates the missing envelopes at the latest GDEK version, 5 at a time, and older envelopes stay live. It holds the passphrase in gateway memory until it finishes, and never in Redis, the database or logs. A revoke during a job is caught either by the revoke's own update or by the job re-checking after it saves.
- **When a job stops:** a wrong passphrase, a KMS failure or a restart stops it, with no retry. The passphrase is gone by then, so it can't restart itself: the admin sees `ENVELOPES_MISSING` and enters the passphrase again on the renew route. After a crash it shows as in progress, and renew answers `409`, for up to 2 minutes.
- **Timing:** a rotation of a 10,000-device group answered in about 200 ms and its job took about 5 minutes locally, with the gateway, KMS and database on one machine. It stored about 26 MB of envelopes and 2,000 audit rows.
- **Bulk imports:** run `ANALYZE` after inserting thousands of rows into near-empty tables. Until Postgres refreshes its statistics, `/workspace` can take about 15 seconds.
- **Errors:** `403` for a wrong passphrase or not being allowed, `404` for something hidden or missing, including another user's device, and `409` if the id belongs to someone else, has a different key or was revoked everywhere, or a request is already open. The attempt limit and KMS failures work as for projects.
- **Audit:** `device.registered`, `.approval_requested`, `.approved`, `.rejected`, `.revoked`, `.envelopes_created` and `.envelope_job_dismissed`, each in the same transaction as the change.

## Engine listener

A second Nest app in the same process, for the engine on each device. It serves its own TLS on `DEVICE_ENGINE_PORT` and **must be published directly, never through Traefik**, because a proxy would break both the [TLS pin](docs/tls-pins.md) and the device certificate. It's off until `DEVICE_ENGINE_ENABLED=true`. Only the routes below are mounted, so sign-in, the dashboard and `/ready` return `404` here, and enrol and renew return `404` on the console port.

Under `/api/v1/cipseq`:

| Method | Path | Session | Certificate | Description |
| --- | --- | --- | --- | --- |
| `POST` | `/devices` | Yes | No | Registers a device, as on the console port |
| `POST` | `/devices/:deviceId/certificate` | Yes | No | Enrols with `{ "csr": "<PEM>" }`. `201` for a new certificate and `200` for an exact retry. Retires the old certificate at once |
| `POST` | `/devices/:deviceId/certificate/renew` | No | Yes | Renews with a new key. The old certificate keeps working for 24 hours |
| `POST` | `/crypto/encrypt` | Yes | Yes | Takes `groupId` and returns the current envelope. `503` with `Retry-After` while a new one is being created, and never an older one |
| `POST` | `/crypto/decrypt` | Yes | Yes | Takes `groupId` and `gdekVersion`, and returns that version |

- **Connection:** TLS 1.3 with `SecP256r1MLKEM768` only, so ordinary `curl` and most monitoring probes fail the handshake. Check the console port's `/ready` instead, and the pin as in [docs/tls-pins.md](docs/tls-pins.md).
- **Session:** `Authorization: Bearer <token>`, using the signed token from the `set-auth-token` header at sign-in. Sessions last a fixed 1 day and aren't extended, on the dashboard too.
- **Certificate answers:** enrol and renew return exactly `certificate`, `serialNumber`, `notBefore` and `notAfter`. `495` means the certificate is missing, invalid, expired or retired, so enrol again. `403` means enrolling won't help. `409` means the CSR belongs to a retired certificate, so make a new key. `429` and `503` carry `Retry-After`.
- **Limits:** 30 enrol or renew requests per device an hour, 5 new enrolments an hour, 5 renewals a day, 60 requests per device and 600 per IP a minute. These need Redis and answer `503` without it. A firewall connection limit is still needed in front of the port, because they can't stop TLS handshakes.
- **Revoking:** `POST /cipseq/devices/:deviceId/revoke` also revokes its certificates, and the next request gets `495`. Revoking from a group or project leaves the certificate alone, because the device stays in its other groups.
- **Audit:** `device.certificate_enrolled`, `.certificate_renewed`, `.certificate_refused`, `.certificate_issue_failed`, `.certificate_notice_dismissed` and `.envelope_delivered`.

See [docs/device-certificates.md](docs/device-certificates.md) for what's implemented and tested, [docs/tls-pins.md](docs/tls-pins.md) for keys and rotation, and [docs/envelope-signing.md](docs/envelope-signing.md) for signing.

## Protecting routes

A global `AuthGuard` runs before every route. Without a valid session cookie the request is rejected with `401 Unauthorized`, so **new routes are protected by default**.

- `@Public()` on a route or controller lets requests through without a session. `GET /api/v1`, `/api/v1/auth/*`, `/api/v1/health` and `/api/v1/ready` are public.
- `@CurrentUser()` injects the signed-in user into a handler.

```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator.js';
import { CurrentUser } from './auth/decorators/current-user.decorator.js';
import type { AuthUser } from './auth/auth.types.js';

@Controller('example')
export class ExampleController {
  @Public()
  @Get('status')
  status() {
    return { ok: true }; // reachable without signing in
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email }; // 401 when signed out
  }
}
```

## Validation error format

Requests that fail DTO validation return `400 Bad Request` in this format:

```json
{
  "message": "Validation failed",
  "errors": [
    { "property": "email", "constraints": ["email must be an email"] }
  ]
}
```

---

## Deployment

1. Set `NODE_ENV=production` and provide every required variable through the host's environment or `.env.prod`.
2. Install dependencies, generate the client and build:
   ```bash
   npm ci
   npm run db:generate
   npm run build
   ```
3. Apply migrations to both databases. Use `migrate deploy` in production, never `migrate dev`:
   ```bash
   NODE_ENV=production npm run db:deploy
   ```
4. Start the gateway:
   ```bash
   npm run start:prod
   ```

**Production checklist**

- `BETTER_AUTH_SECRET` is unique for each environment and at least 32 characters long.
- `BETTER_AUTH_URL` uses `https://`. Secure cookies are turned on automatically when `NODE_ENV=production`.
- `AUTH_TRUSTED_ORIGINS` lists only the real dashboard and client origins.
- `REDIS_URL` points to a managed or replicated Redis over TLS. Startup is refused unless it uses `rediss://` when `NODE_ENV=production`. Auth requests answer `503` while Redis is unreachable.
- Redis requires authentication: a dedicated ACL user with a strong password in the URL, e.g. `rediss://gateway:<password>@redis.internal:6380`. Never use the passwordless `default` user.
- Redis is reachable only from the gateway's private network (VPC / security group / firewall); port 6379/6380 is never exposed to the public internet.
- The KMS is reachable only from the gateway's private network. Each environment has its own gateway client certificate for mTLS; the private key file is readable only by the gateway's user and never committed. Rotate the client certificate before it expires.
- `CIPSEQ_DATABASE_URL` points to a different database from `DATABASE_URL` (startup is refused otherwise). CipSeq holds key material, so preferably give it its own database user too, with access to that database only.
- The CipSeq database has backups and point-in-time recovery, with a tested restore. The KMS is stateless, so this database holds the only copy of the wrapped keys: losing it makes the encrypted data unrecoverable.
- `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS` and `EMAIL_FROM` point to a real SMTP provider, the connection uses TLS (port 465, or STARTTLS on 587; the gateway refuses anything else in production), and `EMAIL_FROM` is an address the provider is allowed to send from (SPF and DKIM set up for its domain), so verification and reset emails don't land in spam.
- `AUTH_TRUSTED_ORIGINS` includes the frontend pages that verification, reset and Google/GitHub sign-in redirect to.
- Google and GitHub OAuth apps, if used, have the production redirect URIs (`<BETTER_AUTH_URL>/api/v1/auth/callback/google` and `/github`).
- CipSeq backups are protected and expire on a schedule. A backup from before a rotation still opens with the old passphrase and holds the old group keys, so after rotating because of a leak, old backups stay a risk until they expire.
- `NODE_ENV=production` is set, which also turns off the API docs (`/api/v1/docs`) and Better Auth's schema endpoint.
- The orchestrator restarts the gateway when it exits (it exits with code 1 if a database is unreachable at startup), and starts the databases before the gateway.
- The load balancer or orchestrator uses `/api/v1/health` as the liveness probe and `/api/v1/ready` as the readiness probe, so instances stop receiving traffic while either database, Redis or the KMS is unreachable.
- `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` are set so that telemetry is sent.

## Observability

The gateway is instrumented with NestJS Observe under the service ID `Cipherion-API_Gateway`. To connect it locally:

```bash
npx @nestjs/observe link
```

In production, set `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment.

---

## Roadmap and changelog

- Planned and completed work: [ROADMAP.md](ROADMAP.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md)

## Contributing

Branch from `dev` (`feature/<name>`, `fix/<name>`), use [Conventional Commits](https://www.conventionalcommits.org), and open PRs into `dev`. Agent workflow rules are in [AGENTS.md](AGENTS.md).

## License

UNLICENSED. Proprietary to OneBoat Solutions. All rights reserved.
