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
- [ ] Reject `null` on `PATCH` routes (`@IsOptional()` lets it through; projects use `@ValidateIf`)
- [ ] Account activity: last login, last CipSeq operation and its time
- [ ] Billing/subscription (provider not chosen; tables live in the CipSeq database)

## CipSeq

- [x] Separate PostgreSQL database with its own Prisma schema, client and migrations
- [x] Cipherion KMS client (gRPC + TLS), with a KMS check in `/ready`
- [ ] Optional concurrency limit on KMS calls, if the KMS needs protection from bursts
- [x] Projects and initialisation with the user's passphrase
- [x] Audit events for successful project writes
- [x] Key rotation and key versions (old wrapped keys aren't kept; only the admin rotates)
- [x] Groups and group members (only the project admin creates or deletes a group and is a group admin by default; they can assign acting admins)
- [x] Rotate group keys manually and when a member is revoked (a new group root key and GDEK each time; old wrapped pairs aren't kept)
- [x] `GET /workspace`: one read for everything the signed-in user is a part of
- [x] In-app invitations (send, accept and decline; an acting admin's invitations need the project admin's approval; shown in `/workspace` notifications)
- [x] Removal requests from acting admins, approved by the project admin with the passphrase
- [ ] Require verified emails before production (anyone can sign up with an invited address and accept; this needs email sending, so it also means delivering invitations by email)
- [ ] Expire invitations that stay open
- [ ] Add device requests to `/workspace` notifications
- [ ] Device registration and device key material (decide who provides the passphrase `CreateDeviceEnvelope` needs when a member registers a device, and for remaining members after each rotation; add the RPC to the wrong-passphrase mapping and attempt limit, since it answers `502` today)
- [ ] Device revocation (soft delete all versions of a device's or member's envelopes; decide whether revoking one device rotates the GDEK, since a stolen device can keep decrypting new data with a saved envelope until the next rotation)
- [x] Per-project limit on passphrase attempts in Redis (the KMS is stateless and can't count them)
- [ ] Test rotation against a KMS that accepts the connection and never answers (a closed port is tested; the deadline and its `503` mapping are only unit tested)
- [ ] Rate-limit project, group and invitation routes (group writes also call the KMS, and invitations can be created without limit)
- [ ] Paginate the project list
- [ ] Revisit `/workspace` for very large accounts (return `memberCount` and load members per group; 51 groups with 10,003 members and 51 notifications took 134–319 ms locally, with 12 SQL statements)
- [ ] Audit reads and failed attempts
- [ ] Restore and purge for soft-deleted projects
- [ ] Project admin handover and a plan for lost passphrases (one admin per project, no recovery today)
- [ ] Confirm with the KMS: where the master key lives and how it is backed up and rotated (the proto has no RPC to re-wrap root keys), and whether wrapped keys are bound to their project id

## Deferred

- [ ] Cipherion EnQrypt
- [ ] Zentriq

## Operations

- [x] Health and readiness endpoints (PostgreSQL and Redis)
- [x] Database startup check (exit with code 1 if either database is unreachable) and connection-loss logging for both databases
- [ ] Require SSL (`sslmode=require` or stricter) on `DATABASE_URL` and `CIPSEQ_DATABASE_URL` in production, like `rediss://` for Redis
- [ ] Return `503` instead of `500` from Dashboard routes while a database is unreachable
- [ ] Backups and point-in-time recovery for the CipSeq database, with a tested restore (it holds the only copy of the wrapped keys)
- [ ] Optionally require Redis and the KMS at startup too
- [ ] Compress responses before production (`/workspace` was 1.71 MB for 10,003 members, 109 KB gzipped)
- [ ] Decide whether the public `/ready` response should name its dependencies (`database`, `cipseq`, `redis`, `kms`)
- [x] OpenAPI / Swagger documentation (`/api/v1/docs`, not served in production)
- [ ] Drop the accepted `glob`/`minimatch` advisories (GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249) once `@fastify/static` moves to glob 14; they only affect a startup glob over Swagger UI's own files
- [ ] CI pipeline (lint, test, build)
