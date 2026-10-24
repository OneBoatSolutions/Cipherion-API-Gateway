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
