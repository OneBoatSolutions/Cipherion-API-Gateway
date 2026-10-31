# Roadmap

`- [x]` done · `- [ ]` planned

## Foundation

- [x] NestJS + Fastify project setup
- [x] Environment validation (Joi)
- [x] Global request validation pipe
- [x] Prisma ORM 7 + PostgreSQL
- [x] Better Auth configuration
- [x] NestJS Observe instrumentation
- [x] README and agent workflow docs
- [x] Add `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` to `.env.example`
- [x] Add `dotenv` to dev dependencies (needed by `prisma7.config.ts`)
- [x] Initial database migration
- [x] Validate auth environment variables with Joi
- [x] Remove unused files and dependencies
- [x] Redis for session caching and rate limiting
- [x] Require TLS (`rediss://`) for Redis in production
- [x] Fail fast with `503` when Redis is unreachable, and log outages through the Nest logger
- [ ] Use Redis for business-logic caching
- [ ] Keep sessions working through PostgreSQL during a Redis outage (reads and writes fall back, revocation and rate limiting stay strict)
- [ ] Drop the unused `RateLimit` table (rate limits now live in Redis)
- [ ] Bump `joi` to 18.3.1 (GHSA-4528-x5fx-h6hg, not used by our code)

## Auth

- [x] Load env before `auth.ts` / `lib/prisma.ts` are imported (they read `process.env` at import time)
- [x] Mount the Better Auth handler on the gateway (`/api/v1/auth/*`)
- [x] CORS for trusted origins
- [x] Auth guard for protected routes (`@Public()`, `@CurrentUser()`)
- [ ] Forward the client IP to Better Auth so rate limits are per client, not one shared bucket (decide which proxy headers to trust)
- [ ] API keys for service-to-service and programmatic clients
- [ ] Separate `.env.test` database for e2e tests (they currently use the `.env.dev` database)

## Gateway routing

- [ ] Cipherion Enqrypt
- [ ] Zentriq
- [ ] Cipsec
- [ ] Dashboard backend endpoints

## Operations

- [ ] Health and readiness endpoints, including each upstream service
- [ ] OpenAPI / Swagger documentation
- [ ] CI pipeline (lint, test, build)
