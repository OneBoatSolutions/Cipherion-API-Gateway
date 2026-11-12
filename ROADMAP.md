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
- [x] Email sending over SMTP, with Mailpit locally
- [x] Email verification, required before email sign-in
- [x] Password reset by email (ends every session and marks the email verified)
- [x] Change password signs out every other session and emails the owner
- [x] Google and GitHub sign-in (optional; only joins verified accounts)
- [x] Branded verification, reset and password changed emails
- [ ] Change email address, verifying the new one first (Better Auth's `/change-email` is off; the README no longer claims it works)
- [ ] Delete account: password and an email link, end every session; in CipSeq remove group memberships, revoke devices and certificates, cancel invitations and approvals, stop jobs; keep audit events under the old id; decide what happens to projects the user is admin of (refuse until handed over, or delete them), which probably needs project admin handover first. Write an `account.deleted` audit row, which the master metrics count
- [ ] Add the hosted frontend's origin to `AUTH_TRUSTED_ORIGINS` once it's deployed
- [ ] Rate limiting against floods from many IPs needs a proxy or WAF in front of the gateway (Better Auth's limits are per IP)
- [ ] Forward the client IP to Better Auth so rate limits are per client, not one shared bucket (decide which proxy headers to trust)
- [ ] API keys for service-to-service and programmatic clients
- [ ] Separate `.env.test` database for e2e tests (they currently use the `.env.dev` database)

## Dashboard

- [x] Profile (`GET`/`PATCH /api/v1/dashboard/profile`)
- [x] Settings: timezone, locale, in-app security alerts (`GET`/`PATCH /api/v1/dashboard/settings`)
- [ ] Reject `null` on `PATCH` routes (`@IsOptional()` lets it through; projects use `@ValidateIf`)
- [ ] Account activity: last login, last CipSeq operation and its time
- [x] Account type, individual or company with a company name, set once (`PUT /dashboard/account-type`), shown in profile, settings and `/workspace`
- [x] Free-plan limits until there's billing (1 project, 2 groups per project, 3 people per group, 1 device, 500 encryptions and 500 decryptions a month), each set in the environment, with usage in `/workspace`
- [x] Master accounts (`MASTER_EMAILS`) without limits, and platform metrics for them (`GET /api/v1/master/metrics`) in 6-hour, daily, weekly and monthly buckets
- [ ] Billing/subscription (provider not chosen; tables live in the CipSeq database). Refuse to start a subscription until the account type is set, and collect the tax id and country with the provider. Replace the free-plan environment variables with per-tier limits
- [ ] An "all time" period for the master metrics, and daily totals once the raw counts get slow
- [ ] A way to change the master list without a restart, if it changes often
- [ ] A support or admin tool to change an account type (today it's changed by hand in the database)

## CipSeq

- [x] Separate PostgreSQL database with its own Prisma schema, client and migrations
- [x] Cipherion KMS client (gRPC + TLS), with a KMS check in `/ready`
- [x] Treat `PERMISSION_DENIED` as a wrong passphrase only for the KMS's exact `incorrect passphrase` text, so a refused gateway certificate can't lock a project out
- [ ] Test against the real KMS that a wrong passphrase still answers `403` and is counted (if the KMS's wording changes, wrong guesses would stop counting towards the limit)
- [ ] Optional concurrency limit on KMS calls, if the KMS needs protection from bursts
- [x] Projects and initialisation with the user's passphrase
- [x] Audit events for successful project writes
- [x] Key rotation and key versions (old wrapped keys aren't kept; only the admin rotates)
- [x] Groups and group members (only the project admin creates or deletes a group and is a group admin by default; they can assign acting admins)
- [x] Rotate group keys manually, project admin only, at most once per group in 48 hours (a new group root key and GDEK each time; old wrapped pairs aren't kept)
- [x] `GET /workspace`: one read for everything the signed-in user is a part of
- [x] In-app invitations (send, accept and decline; an acting admin's invitations need the project admin's approval; shown in `/workspace` notifications)
- [x] Project-wide removal by the project admin only; acting admins remove members and devices from their own group
- [x] Require verified emails before production (email sign-in now needs a verified address)
- [ ] Activity emails, in their own branch: first invitations (the only way someone without an account learns of one), certificate issued and envelope job stopped; then members and devices approved, rejected, revoked or removed, role changes, deleted projects and groups, and new sign-ins; with a setting for which emails each person gets
- [ ] Expire invitations that stay open
- [x] Add device requests to `/workspace` notifications
- [x] Device registration and approval, with envelopes created by a background job that holds the passphrase in memory only
- [x] Device and member revocation (soft delete all versions of the envelopes, with no rotation)
- [x] Show envelope jobs as in progress, stopped or completed, and resume a stopped one with the passphrase
- [x] Certificate branch: port 3443, device certificates, enrol and renew, `POST /cipseq/crypto/encrypt` and `/decrypt`, Better Auth bearer plugin and fixed 1-day sessions. This is what delivers envelopes to devices, and proves a device is genuine
- [x] TLS pin tooling (now `make pin-setup` and `make local-gateway` in the KMS repository) and docs for generating, delivering and rotating pins
- [x] Revoke a device's certificates with the device
- [x] Dockerfile for Coolify, with certificates mounted at `/certs` instead of baked into the image
- [ ] Run the built image on Coolify with the engine port published, and check the live pin ([docs/tls-pins.md](docs/tls-pins.md))
- [x] UUID v4 ids for users, sessions and accounts, and `npm run users:migrate-ids` for existing ones
- [ ] Complete the encrypt and decrypt response to the agreed 11-field contract (only `requestId`, `status` and `envelope` today). Blocks shipping these routes to an engine
- [ ] Send the certificate-issued notice by email, through a retrying outbox worker on `deviceCertificateNotice`. Blocks production, because a stolen session can enrol a certificate
- [ ] Derive device ids from the device's key and check them at registration (today only the format is checked, so an id can be squatted)
- [ ] Decide on F-01 from the KMS audit: wrapped keys aren't bound to their project or group
- [ ] Deploy port 3443 directly, not through Traefik, prove the served pin on staging, and add a firewall connection limit
- [x] Metrics: an `envelopeDelivery` row per delivery (encrypt or decrypt, linked to its audit row), a leaderboard of the top 10 projects, users and devices in the admin's projects, and usage for a project, group, user or device, as UTC time series (`GET /api/v1/cipseq/metrics/leaderboard` and `/usage`)
- [ ] Daily totals for the metrics once raw counts get slow (100,000 deliveries took about 100 ms for the leaderboard's `all`, and the cost grows with the rows in the period)
- [ ] Engine usage report: an endpoint the engine calls after each operation, matched by `requestId`, that fills the 10 nullable columns on `envelopeDelivery` (decide its limits, a cap on `errorReason`'s length, the salt for `fileNameHash` and whether sizes are rounded; then make the columns required and add metrics by data kind, size and failures)
- [ ] Remaining `pending.md` items: more audit fields and audit refusals (A1, A2), last delivery per device (A3), an audit read API (A4), and the engine-side items (A5–A7)
- [ ] Load test envelope delivery (a device lock and an audit row per request), and decide whether to keep the lock and how long to keep `device.envelope_delivered` rows
- [ ] Test certificates from the old and new device CAs, a real expired `KMS_CLIENT_CERT`, and a KMS outage on the certificate routes
- [ ] Agree with the team: the updated KMS proto with `IssueDeviceCertificate` (applied here; compare with the KMS's file), `/api/v1/cipseq` paths, the 1-day session, `503` with `Retry-After` while a device's new envelope isn't ready (a 10,000-device job takes about 5 minutes), the `403` `PLAN_LIMIT_REACHED` refusal with `resetsAt` on encrypt and decrypt, and who generates and protects pins B and C
- [ ] Ask the KMS team why `CreateDeviceEnvelope` slows from about 90 ms to 120–146 ms after a few minutes of sustained load, and how many calls at once it can take (a 10,000-device job took 314 s at 5 at a time; the KMS alone stayed at about 50% CPU)
- [ ] Decide whether to allow one early rotation after a revocation (a modified engine can keep a revoked envelope until the next rotation, and the 48-hour limit can extend that)
- [ ] Limit repeat `request-approval` calls after a refusal
- [ ] Alert the project admin by email or push when an envelope job stops (today they see it only on their next `/workspace` load)
- [ ] Let a running envelope job finish before shutdown (a deploy interrupts it, and the admin has to resume it)
- [ ] Retention for old envelope versions (they're kept indefinitely: about 26 MB and 2,000 audit rows per rotation of a 10,000-device group)
- [ ] Make `envelopeCount` on `ENVELOPES_COMPLETED` exact (it's the number missing when the job or its last resume started)
- [ ] Test a KMS that stops during a job against the real KMS (only unit tested)
- [x] Per-project limit on passphrase attempts in Redis (the KMS is stateless and can't count them)
- [ ] Test rotation against a KMS that accepts the connection and never answers (a closed port is tested; the deadline and its `503` mapping are only unit tested)
- [ ] Rate-limit project, group, invitation and device routes (group writes also call the KMS, and invitations and devices can be created without limit)
- [ ] Paginate the project list
- [ ] Revisit `/workspace` for very large accounts (return `memberCount` and load members per group; a 10,000-member group with one device each took 262–558 ms locally and returned 2.8 MB)
- [ ] Audit reads and failed attempts
- [ ] Restore and purge for soft-deleted projects
- [ ] Project admin handover and a plan for lost passphrases (one admin per project, no recovery today)
- [ ] Confirm with the KMS: where the master key lives and how it is backed up and rotated (the proto has no RPC to re-wrap root keys), and whether wrapped keys are bound to their project id

## Deferred

- [ ] Cipherion EnQrypt
- [ ] Zentriq

## Operations

- [x] Health and readiness endpoints (PostgreSQL and Redis)
- [x] Database startup check and connection-loss logging for both databases
- [ ] Require SSL (`sslmode=require` or stricter) on `DATABASE_URL` and `CIPSEQ_DATABASE_URL` in production, like `rediss://` for Redis
- [ ] Return `503` instead of `500` from Dashboard routes while a database is unreachable
- [ ] Backups and point-in-time recovery for the CipSeq database, with a tested restore (it holds the only copy of the wrapped keys)
- [x] Refuse to start unless both databases, Redis, the KMS and the SMTP server can all be reached, with an exit code per dependency (10–14)
- [x] One log line when any dependency's connection is lost and one when it's back (SMTP watched too), recorded in a `systemEvent` table apart from the user audit trail
- [ ] Retention for `systemEvent` rows, and a read API or dashboard for them
- [ ] Alert someone (email or a monitoring hook) when a dependency stays down, rather than only logging it
- [ ] Compress responses before production (`/workspace` was 2.26 MB for 10,000 members and devices, 102 KB gzipped)
- [ ] Decide whether the public `/ready` response should name its dependencies (`database`, `cipseq`, `redis`, `kms`)
- [x] OpenAPI / Swagger documentation (`/api/v1/docs`, not served in production)
- [ ] Drop the accepted `glob`/`minimatch` advisories (GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249) once `@fastify/static` moves to glob 14; they only affect a startup glob over Swagger UI's own files
- [x] Container entrypoint that applies both databases' migrations on every start, then starts the gateway (exit 20/21 if migrations fail)
- [ ] Confirm on Coolify that a deploy reaches `healthy` with the `/api/v1/health` check (not tested locally: the local KMS isn't reachable from a container)
- [ ] CI pipeline (lint, test, build, and building the Docker image)
