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

### Changed

- `.env.example` now includes `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
- `prisma7.config.ts` no longer imports `dotenv/config`, so `.env` can't override the `NODE_ENV`-specific env file.
- All routes are now served under the global prefix `/api/v1` (`GET /` moved to `GET /api/v1`).
- `dotenv` moved from dev dependencies to dependencies, since the app now loads env files at runtime.
- Routes now require authentication by default; `/api/v1` and `/api/v1/auth/*` are marked `@Public()`.
- `GET /api/v1` now returns `Hello Cipherion :)`.
- `.gitignore` ignores `/playground`, a local login and landing page for trying the auth flow.

### Fixed

- The e2e test now boots the app on the Fastify adapter instead of Nest's default Express platform.

### Removed

- Empty root `auth.ts` and the unused `prisma/schema.backup.prisma`.
- Unused `@types/express` and the redundant `@better-auth/prisma-adapter` dependency (already bundled with `better-auth`).
