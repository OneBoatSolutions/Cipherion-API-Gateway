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

### Changed

- `.env.example` now includes `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
- `prisma7.config.ts` no longer imports `dotenv/config`, so `.env` can't override the `NODE_ENV`-specific env file.

### Removed

- Empty root `auth.ts` and the unused `prisma/schema.backup.prisma`.
- Unused `@types/express` and the redundant `@better-auth/prisma-adapter` dependency (already bundled with `better-auth`).
