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

## Dashboard

- [x] Profile (`GET`/`PATCH /api/v1/dashboard/profile`)
- [x] Settings: timezone, locale, in-app security alerts (`GET`/`PATCH /api/v1/dashboard/settings`)
- [ ] Account activity: last login, last CipSeq operation and its time
- [ ] Billing/subscription (provider not chosen; tables live in the CipSeq database)

## CipSeq

- [x] Separate PostgreSQL database with its own Prisma schema, client and migrations
- [x] Cipherion KMS client (gRPC + TLS), with a KMS check in `/ready`
- [ ] Optional concurrency limit on KMS calls, if the KMS needs protection from bursts
- [ ] Projects and initialisation with the user's passphrase
- [ ] Key rotation and key versions
- [ ] Groups and group members
- [ ] Invitations (send and accept)
- [ ] Device registration and device key material
- [ ] Audit event for every operation

## Deferred

- [ ] Cipherion EnQrypt
- [ ] Zentriq

## Operations

- [x] Health and readiness endpoints (PostgreSQL and Redis)
- [x] Database startup check (exit with code 1 if either database is unreachable) and connection-loss logging for both databases
- [ ] Require SSL (`sslmode=require` or stricter) on `DATABASE_URL` and `CIPSEQ_DATABASE_URL` in production, like `rediss://` for Redis
- [ ] Return `503` instead of `500` from Dashboard routes while a database is unreachable
- [ ] Optionally require Redis and the KMS at startup too
- [x] OpenAPI / Swagger documentation (`/api/v1/docs`, not served in production)
- [ ] Drop the accepted `glob`/`minimatch` advisories (GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249) once `@fastify/static` moves to glob 14; they only affect a startup glob over Swagger UI's own files
- [ ] CI pipeline (lint, test, build)
