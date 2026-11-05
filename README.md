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
           rate limits)             settings)        devices, audit, billing)
```

**Responsibilities**

- **Authentication**: email/password sign-in through [Better Auth](https://better-auth.com). Sessions last 7 days and are refreshed every 24 hours. They are cached in Redis and also stored in PostgreSQL, which stays the source of truth: if a Redis entry is missing, the session is read from the database. Signing out removes the Redis entry, so a revoked session stops working immediately. If Redis is unreachable, auth fails closed: auth and protected routes answer `503 Service Unavailable` within about 2 seconds, and work again as soon as Redis is back.
- **Rate limiting**: 100 requests per 60-second window, counted atomically in Redis so the limit holds across instances.
- **Request validation**: a global `ValidationPipe` that removes unknown fields, rejects requests containing them, and returns errors in one consistent format.
- **Configuration safety**: environment variables are checked with Joi when the app starts, so a misconfigured deployment fails immediately.
- **Observability**: tracing, metrics, logs and error tracking through [NestJS Observe](https://observe.nestjs.com).
- **Dashboard** *(in progress)*: profile, settings and account activity for the signed-in user. Billing/subscription is deferred.
- **CipSeq** *(in progress)*: projects and key rotation (available), groups, invitations and device registration. CipSeq calls the Cipherion KMS over gRPC for every crypto operation and keeps its data, including an audit event for each operation, in a separate PostgreSQL database.
- **EnQrypt and Zentriq** *(deferred)*.

## Tech stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 22+, TypeScript (ESM) |
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
│   ├── auth/                # AuthController (/api/v1/auth/*), global AuthGuard, @Public() / @CurrentUser()
│   ├── dashboard/           # Dashboard routes (/api/v1/dashboard/profile, /settings)
│   ├── cipseq/              # CipSeq routes (/api/v1/cipseq/projects), access checks and audit events
│   ├── health/              # Liveness (/api/v1/health) and readiness (/api/v1/ready) endpoints
│   ├── lib/prisma.ts        # Shared pg pool and PrismaClient for the auth database
│   ├── lib/cipseq-prisma.ts # Shared pg pool and PrismaClient for the CipSeq database
│   ├── lib/database-watch.ts# Heartbeat and connection-loss logging for both pools
│   ├── lib/startup-checks.ts# Exits with code 1 if a database is unreachable at startup
│   ├── lib/redis.ts         # Shared Redis client (sessions, rate limits, caching)
│   ├── lib/kms.ts           # Shared KMS gRPC client (mTLS) and its health client
│   ├── kms/kms-call.ts      # kmsCall(): one KMS RPC with a 2 s deadline, gRPC status → HTTP error
│   └── generated/           # Generated clients: prisma/, cipseq/ (Prisma) and kms/ (gRPC). Do not edit by hand
├── test/                    # End-to-end tests (helpers/ cleans up test users in Postgres and Redis)
├── .env.example             # Template for environment variables
└── package.json
```

---

## Getting started

### Prerequisites

- **Node.js** 22 or later, and npm
- **PostgreSQL** 14 or later, running locally, in Docker, or hosted
- **Redis** 6.2 or later (`GETDEL` is required), running locally, in Docker, or hosted
- **Cipherion KMS** running and reachable over gRPC with mutual TLS (locally on `localhost:50051`), plus a CA certificate for the KMS and a client certificate and key for the gateway

To run both quickly with Docker:

```bash
docker run -d --name cipherion-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=cipherion_gateway \
  -p 5432:5432 postgres:16

docker run -d --name cipherion-redis -p 6379:6379 redis:7
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
| `KMS_ADDRESS` | **Yes** | – | Cipherion KMS gRPC address as `host:port`, e.g. `localhost:50051` |
| `KMS_CA_CERT` | **Yes** | – | Path to the PEM CA certificate that signed the KMS server certificate |
| `KMS_CLIENT_CERT` | **Yes** | – | Path to the gateway's PEM client certificate (mutual TLS), signed by a CA the KMS trusts |
| `KMS_CLIENT_KEY` | **Yes** | – | Path to the gateway's PEM client private key |
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
  | `PERMISSION_DENIED` from an RPC that checks a passphrase (rotation) | `403` |
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
| `POST` | `/api/v1/auth/sign-up/email` | Create an account (`name`, `email`, `password`) |
| `POST` | `/api/v1/auth/sign-in/email` | Sign in (`email`, `password`) and receive the session cookie |
| `GET` | `/api/v1/auth/get-session` | Current user and session, or `null` |
| `POST` | `/api/v1/auth/sign-out` | End the current session |

```bash
# sign up, then sign in and store the session cookie
curl -X POST http://localhost:3000/api/v1/auth/sign-up/email \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"name":"Jane","email":"jane@example.com","password":"a-strong-password"}'

curl -X POST http://localhost:3000/api/v1/auth/sign-in/email -c cookies.txt \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"email":"jane@example.com","password":"a-strong-password"}'

# read the session with the stored cookie
curl http://localhost:3000/api/v1/auth/get-session -b cookies.txt
```

The e2e tests (`npm run test:e2e`) exercise these endpoints against the `.env.dev` database and Redis, and delete the test user and its cached sessions afterwards.

> **Always delete users and revoke sessions through Better Auth** (`auth.api.*`), never with raw Prisma. Better Auth also removes the cached copy from Redis. A session deleted only from PostgreSQL stays valid in Redis until its TTL (up to 7 days) runs out.

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

Email and password are changed through Better Auth's `/api/v1/auth/change-email` and `/api/v1/auth/change-password`.

Cipherion has no profile images. Better Auth's user table requires an `image` column, so the column stays, but `/api/v1/auth/sign-up/email` and `/api/v1/auth/update-user` reject an `image` field with `400` and it is always `null`.

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

- **Access:** someone who isn't a member gets `404`, the same as for a project that doesn't exist. A member who isn't the admin gets `403` on admin routes.
- **Passphrase:** it goes to the KMS and is never stored, logged or audited. The admin can change it, but a lost passphrase can't be recovered.
- **Rotation:** the KMS re-wraps the project encryption key under the new passphrase and a new salt. The key itself and the root key don't change, so anything wrapped under it stays valid. Old wrapped keys aren't kept: `projectKeyVersion` records only each version and its date.
- **Attempt limit:** 5 wrong passphrases per project in 15 minutes, then `429`, even for the correct passphrase, until the window ends. Attempts are counted in Redis, so rotation answers `503` while Redis is unreachable. A successful rotation resets the count, and a KMS failure doesn't use up an attempt.
- **KMS failures:** `503` when the KMS is unreachable or slower than 2 seconds. Other failures follow the `kmsCall()` mapping, usually `502`. Nothing is written, so the client can try again.
- **Audit:** each successful write records an event in the same transaction: `project.created`, `project.initialized`, `project.key_rotated`, `project.updated` or `project.deleted`.

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
- CipSeq backups are protected and expire on a schedule. A backup from before a rotation still opens with the old passphrase, so after rotating because of a leak, old backups stay a risk until they expire.
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
