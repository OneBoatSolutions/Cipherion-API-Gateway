# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project setup: NestJS 12 on Fastify, Joi environment validation, global validation pipe and NestJS Observe instrumentation.
- Prisma ORM 7 with PostgreSQL, plus the Better Auth schema (User, Session, Account, Verification, RateLimit).
- Better Auth configuration with email/password sign-in, database sessions and database-backed rate limiting.
- README covering the gateway's purpose, architecture, setup, environment variables and deployment.
- AGENTS.md / CLAUDE.md describing the agent workflow (approval → CHANGELOG/ROADMAP updates, `cm` commit shorthand).
- CHANGELOG.md and ROADMAP.md.
- Initial Prisma migration (`prisma/migrations/*_init`) for the Better Auth tables.
- Joi validation for `BETTER_AUTH_SECRET` (min. 32 characters), `BETTER_AUTH_URL` and `AUTH_TRUSTED_ORIGINS`, so a missing or weak auth config fails at startup.
- `dotenv` as a dev dependency (used by `prisma7.config.ts`).
- Better Auth endpoints mounted at `/api/v1/auth/*` (sign-up, sign-in, sign-out, get-session) through an `AuthController` that forwards requests to the Better Auth handler.
- CORS for the origins in `AUTH_TRUSTED_ORIGINS`, with credentials so the dashboard can send session cookies.
- `src/config/env.ts`, which loads the environment file before `auth.ts` and `lib/prisma.ts` read `process.env`.
- `configureApp()` in `src/app.setup.ts`, shared by `main.ts` and the e2e tests.
- Auth e2e tests covering sign-up, sign-in, get-session and CORS preflight.
- Global `AuthGuard` that requires a valid Better Auth session on every route and returns `401 Unauthorized` without one; on success it sets `request.user` and `request.session`.
- `@Public()` decorator to open a route or controller, and `@CurrentUser()` decorator to inject the signed-in user into a handler.
- `AuthUser` / `AuthSession` types inferred from Better Auth, with `user` and `session` typed on `FastifyRequest`.
- Unit tests for `AuthGuard` and e2e tests for protected routes and `@CurrentUser()`.
- Redis via `ioredis`, with a shared client in `src/lib/redis.ts` for sessions, rate limits and later business caching.
- Better Auth secondary storage in Redis (`get`, `set`, `delete`, `getAndDelete`, plus an atomic Lua `increment`), so sessions are read from Redis and sign-out revokes them immediately.
- `REDIS_URL` environment variable, validated by Joi (`redis://` or `rediss://`).
- Shutdown hooks that close the Redis and Prisma connections when the app stops.
- e2e test for session caching, database fallback and revocation, and a `deleteTestUser` helper that cleans up both PostgreSQL and Redis.
- Unit tests for the environment schema (`src/config/env.schema.spec.ts`) and for the `AuthGuard` 503 path.
- Redis connection loss and recovery are logged once each through the Nest logger (`[Redis]`) instead of ioredis printing every failed reconnect.
- Public health endpoints in a new `HealthModule`: `GET /api/v1/health` (liveness, never checks dependencies) and `GET /api/v1/ready` (readiness: PostgreSQL `SELECT 1` and Redis `PING`, `503` with the failing dependency when either is down or exceeds a 2-second timeout).
- Unit and e2e tests for the health endpoints.
- OpenAPI 3.1 documentation with `@nestjs/swagger`: Swagger UI at `/api/v1/docs` and the JSON document at `/api/v1/docs-json`, set up by `setupOpenApi()` in `src/openapi.ts`.
- Better Auth's `openAPI()` plugin, whose generated endpoints are merged into the document under `/api/v1/auth` (tagged `auth`, with Better Auth's bearer/API-key security entries removed since the gateway uses the session cookie).
- Swagger summaries and response schemas for the hello and health routes, including the `503` readiness response (`src/health/health.dto.ts`).
- `@nestjs/swagger` and `@fastify/static` (required by Swagger UI on Fastify) dependencies.
- Unit and e2e tests for the API docs.
- Dashboard settings in a new `DashboardModule`: `GET /api/v1/dashboard/settings` (defaults when nothing is saved) and `PATCH /api/v1/dashboard/settings` (partial update of `timezone`, `locale` and `securityAlerts`, validated as IANA timezone, BCP 47 tag and boolean).
- `UserSettings` model and the `user_settings` migration (one row per user, deleted with the user).
- Unit and e2e tests for the dashboard settings.
- Dashboard profile: `GET /api/v1/dashboard/profile` (id, name, email, emailVerified, createdAt, read from the session) and `PATCH /api/v1/dashboard/profile` (name only, 1–100 characters, saved through Better Auth so the session cache in Redis stays current).
- Unit and e2e tests for the dashboard profile, and a `uniqueClientIp()` e2e helper.
- Separate CipSeq database: `CIPSEQ_DATABASE_URL` (validated by Joi), its own Prisma schema (`prisma/cipseq/schema.prisma`), config (`prisma7.cipseq.config.ts`), migrations folder and client (`src/generated/cipseq`), shared through `src/lib/cipseq-prisma.ts`. No tables yet; they arrive with the CipSeq endpoints.
- `GET /api/v1/ready` also checks the CipSeq database (`cipseq` in `checks`), and its client is disconnected on shutdown.
- `db:generate`, `db:migrate`, `db:migrate:cipseq` and `db:deploy` npm scripts covering both databases.
- Cipherion KMS client over gRPC with mutual TLS (`src/lib/kms.ts`), configured by `KMS_ADDRESS`, `KMS_CA_CERT`, `KMS_CLIENT_CERT` and `KMS_CLIENT_KEY` (validated by Joi).
- KMS contract `proto/kms/v1/prototypeBufferV1.proto` and the standard `grpc.health.v1` health proto, with typed clients generated into `src/generated/kms` by `ts-proto` through `buf` (`npm run proto:generate`).
- `kmsCall()` (`src/kms/kms-call.ts`): one KMS RPC with a 2-second deadline and no retries, mapping gRPC status to HTTP (`UNAVAILABLE`/`DEADLINE_EXCEEDED` → 503, `INVALID_ARGUMENT`/`FAILED_PRECONDITION` → 400, `NOT_FOUND` → 404, `ALREADY_EXISTS` → 409, anything else → 502).
- `GET /api/v1/ready` also checks the KMS (`kms` in `checks`): `grpc.health.v1.Health/Check` must answer `SERVING` within 2 seconds. A failing check is logged once with its reason, and again when it passes.
- KMS connection logging like Redis's: `[KMS] Connection lost, reconnecting: <reason>` (e.g. `ECONNREFUSED`, `ECONNRESET` or a TLS alert) once per outage and `Connection restored` once it is back. The gateway connects to the KMS at startup and reconnects an idle channel, so outages are noticed without traffic.
- Unit tests for the KMS call helper, connection watcher and readiness check, and env schema tests for the KMS variables.
- Startup check (`src/lib/startup-checks.ts`): before Nest starts, `SELECT 1` runs on both databases (5-second timeout). If either fails, the gateway logs `[Startup] Can't connect to the <auth|CipSeq> database (host:port/db): <reason>` without credentials and exits with code 1.
- Database connection logging like Redis and the KMS (`src/lib/database-watch.ts`): a 5-second `SELECT 1` heartbeat and the pool's `error` event log `[Database]` / `[CipSeqDatabase] Connection lost, reconnecting: <reason>` (e.g. `ECONNREFUSED`, `57P01 …`) once per outage and `Connection restored` once it is back.
- Unit tests for the startup check and the database watcher.

### Changed

- `.env.example` now includes `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
- `prisma7.config.ts` no longer imports `dotenv/config`, so `.env` can't override the `NODE_ENV`-specific env file.
- All routes are now served under the global prefix `/api/v1` (`GET /` moved to `GET /api/v1`).
- `dotenv` moved from dev dependencies to dependencies, since the app now loads env files at runtime.
- Routes now require authentication by default; `/api/v1` and `/api/v1/auth/*` are marked `@Public()`.
- `GET /api/v1` now returns `Hello Cipherion :)`.
- `.gitignore` ignores `/playground`, a local login and landing page for trying the auth flow.
- Better Auth rate limiting now uses Redis (`secondary-storage`) instead of PostgreSQL; the `RateLimit` table is no longer written to.
- Sessions are cached in Redis and still stored in PostgreSQL (`storeSessionInDatabase`), which stays the source of truth.
- The Joi environment schema moved from `app.module.ts` to `src/config/env.schema.ts`.
- Project scope in README, AGENTS.md, ROADMAP and the OpenAPI description: the gateway now hosts the Dashboard and CipSeq (formerly written "Cipsec") backends as modules instead of routing to upstream services. CipSeq uses the Cipherion KMS over gRPC + TLS and its own PostgreSQL database. EnQrypt and Zentriq are deferred. Commit scopes now include `cipseq` and `kms`, and the Swagger document has a `dashboard` tag.

### Fixed

- A Postgres restart or a dropped idle connection can no longer crash the gateway: both databases now use a `pg` pool owned by the gateway (`connectionTimeoutMillis: 2000`) with an `error` listener, passed to Prisma with `disposeExternalPool`.

- The e2e test now boots the app on the Fastify adapter instead of Nest's default Express platform.
- e2e tests no longer share one Better Auth rate-limit bucket (sign-up/sign-in: 3 per 10 s per IP), which made the fourth sign-up in a run fail with `429`: each test now sends its own `x-forwarded-for` address from the reserved 198.18.0.0/15 range.
- When Redis is unreachable, auth requests no longer hang for over a minute: the Redis client fails commands within about 2 seconds (`maxRetriesPerRequest: 1`, `commandTimeout: 2000`) and auth routes and protected routes answer `503 Service Unavailable` instead of `500`.

### Security

- `REDIS_URL` must use TLS (`rediss://`) when `NODE_ENV` is `production`; startup fails otherwise.
- Auth fails closed while Redis is down: sessions can't be read, created or revoked, so a session revoked during an outage can't come back from a stale cache.
- README production checklist now requires a dedicated Redis ACL user with a strong password and Redis reachable only from the private network.
- API docs are never served in production: Swagger UI, the JSON document and the Better Auth `openAPI()` plugin (whose schema endpoint is public) are only enabled when `NODE_ENV` isn't `production`. The wildcard auth route is hidden from the docs.
- Profile images are not supported: a Better Auth `before` hook rejects an `image` field on `/api/v1/auth/sign-up/email` and `/api/v1/auth/update-user` with `400`. The column stays because Better Auth's user schema requires it, but it is always `null`.
- Startup is refused in production when `CIPSEQ_DATABASE_URL` points to the same database as `DATABASE_URL`, so CipSeq key material never shares the auth database.
- The KMS connection always uses mutual TLS (no plaintext mode). KMS request data, which carries passphrases and key material, is never logged, and clients never see the KMS's error details.

### Removed

- Empty root `auth.ts` and the unused `prisma/schema.backup.prisma`.
- Unused `@types/express` and the redundant `@better-auth/prisma-adapter` dependency (already bundled with `better-auth`).
