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

### Fixed

- The e2e test now boots the app on the Fastify adapter instead of Nest's default Express platform.
- When Redis is unreachable, auth requests no longer hang for over a minute: the Redis client fails commands within about 2 seconds (`maxRetriesPerRequest: 1`, `commandTimeout: 2000`) and auth routes and protected routes answer `503 Service Unavailable` instead of `500`.

### Security

- `REDIS_URL` must use TLS (`rediss://`) when `NODE_ENV` is `production`; startup fails otherwise.
- Auth fails closed while Redis is down: sessions can't be read, created or revoked, so a session revoked during an outage can't come back from a stale cache.
- README production checklist now requires a dedicated Redis ACL user with a strong password and Redis reachable only from the private network.

### Removed

- Empty root `auth.ts` and the unused `prisma/schema.backup.prisma`.
- Unused `@types/express` and the redundant `@better-auth/prisma-adapter` dependency (already bundled with `better-auth`).
