# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** email verification and password reset use a 6-digit emailed code instead of a link (Better Auth's `emailOTP` plugin). New routes: `POST /auth/email-otp/verify-email`, `/email-otp/send-verification-otp`, `/email-otp/request-password-reset` and `/email-otp/reset-password`. The link routes (`/verify-email`, `/send-verification-email`, `/request-password-reset`, `/reset-password`, `/reset-password/:token`) and the plugin's unused routes now answer `404`. A code lasts 10 minutes, works once, and is deleted after 3 wrong tries; only a keyed hash (HMAC with `BETTER_AUTH_SECRET`) is stored, in Redis. Verifying still creates no session. The emails contain no links. Frontend changes are in `docs/email-codes-for-frontend.md`.
- Removed `npm run certs:engine` and `scripts/setup-device-tls.mjs`. The engine listener's key, certificate and pin now come from the KMS repository (`make setup-all`, then `make local-gateway GATEWAY_DIR=<this folder>` for local testing, `make server-push` for a server), which also handles the spare key, renewal, rotation and rollback.
- `.env.example`, `docs/environment.md` and `docs/device-certificates.md` now point `DEVICE_TLS_KEY`, `DEVICE_TLS_CERT` and `DEVICE_TLS_PIN_FILE` at `certs/deploy/gateway/engine-server.*`, where the KMS repository puts every file the gateway needs. `certs/engine/` is no longer used.
- Documented the Coolify certificate layout (`/data/cipherion/gateway` mounted at `/certs`) in `docs/environment.md` and `docs/tls-pins.md`.

### Added

- `DATABASE_CA_CERT`: an optional PEM file of CAs to trust for both databases' TLS certificates, for a Postgres signed by a private CA such as Coolify's. It may hold several CAs for rotation, the certificate and host name are still always verified, and it ignores the URL's `sslmode` (except `disable`). Without it, behaviour is unchanged. `docs/environment.md` explains private CAs and rotation, and now lists `REDIS_CA_CERT`.
- `Dockerfile` and `.dockerignore` for Coolify: a two-stage Node 24 build (OpenSSL 3.5, needed by the engine listener) that runs as the `node` user, exposes 3000 and 3443, and has a `/health` check. Certificates are never copied into the image.
- `scripts/entrypoint.sh`, the image's `ENTRYPOINT`: applies both databases' migrations with `prisma migrate deploy` on every container start, then `exec`s the gateway so it stays PID 1 and gets `SIGTERM`. Each database is retried `MIGRATE_ATTEMPTS` times (default 5) `MIGRATE_RETRY_SECONDS` apart (default 5); it exits `1` without a database URL, `20` if the auth migrations fail and `21` if the CipSeq ones do, so the gateway never starts on an old schema. `SKIP_MIGRATIONS=true` skips both steps. Replaces the manual `npm run db:deploy` per release.
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
- CipSeq projects in a new `CipSeqModule`, under `/api/v1/cipseq/projects`: `POST /` (create with `name` and `description`; the caller becomes the project's one admin), `POST /:id/initialize` (set the passphrase), `GET /`, `GET /:id`, `PATCH /:id` (`name` and `description`) and `DELETE /:id` (soft delete). Responses never contain wrapped keys or salts; non-members get `404` and members who aren't the admin get `403` on writes.
- Create calls `CreateAndWrapNewProjectRootKey` and initialize calls `CreateAndWrapNewProjectEncryptionKey` on the KMS. A KMS response for a different project id answers `502` and stores nothing.
- CipSeq tables and migrations (`cipseq_projects`, `project_description`): `project`, `projectKeys` (current wrapped keys), `projectKeyVersion`, `projectMember` and `auditEvent`.
- Audit events for successful project writes (`project.created`, `project.initialized`, `project.key_rotated`, `project.updated`, `project.deleted`), committed in the same transaction as the change.
- Unit and e2e tests for the project endpoints.
- `POST /api/v1/cipseq/projects/:id/rotate`: the project admin changes the passphrase with `currentPassphrase` and `newPassphrase`. It calls `RotateWrappingKeyforProjectEncryptionKey`, stores the new wrapped project encryption key and salt, and bumps the key version. A wrong current passphrase answers `403`, an uninitialised project or a concurrent rotation `409`.
- Limit of 5 wrong passphrases per project in 15 minutes (`src/cipseq/passphrase-attempts.ts`), counted in Redis before the KMS call. Over the limit answers `429`, and `503` if Redis is unreachable.
- CipSeq groups under `/api/v1/cipseq/projects/:projectId/groups`, all project admin only: `POST /` (create with `name`, `description` and the project `passphrase`; the project admin becomes a group admin), `PATCH /:groupId` (`name` and `description`), `DELETE /:groupId` (soft delete), `POST /:groupId/rotate` (`passphrase`), `PATCH /:groupId/members/:userId` (`role`, for acting admins) and `POST /:groupId/members/:userId/revoke` (`passphrase`; removes the member and rotates in one transaction, and they stay in the project). The project admin can't be demoted or revoked.
- Create, rotate and revoke call `CreateAndWrapNewGroupRootKeyAndGroupDataEncryptionKey`, which makes a new group root key and GDEK each time. The GDEK version goes up by one on every rotation and revocation. They share the project's passphrase attempt limit.
- CipSeq group tables and migration (`cipseq_groups`): `group`, `groupKeys` (current wrapped keys and `currentGdekVersion`), `groupKeyVersion` (version numbers only) and `groupMember`.
- Audit events for group writes: `group.created`, `group.updated`, `group.deleted`, `group.key_rotated`, `group.member_role_changed` and `group.member_revoked`.
- `GET /api/v1/workspace` in a new `WorkspaceModule`: one read returning the signed-in user's profile, settings, projects, groups, current key versions, members and notifications. The project admin gets every group, anyone else only the groups they belong to. It answers `503` if a database is unavailable and is sent with `Cache-Control: no-store`.
- Unit and e2e tests for groups and the workspace.
- In-app invitations under `/api/v1/cipseq/projects/:projectId/groups/:groupId/invitations`: `POST /` (`email`), `POST /:id/approve`, `POST /:id/reject` and `POST /:id/cancel`. Nothing is emailed. A project admin's invitation goes straight to the invitee, and an acting admin's waits for the project admin's approval.
- `POST /api/v1/cipseq/invitations/:id/accept` and `/decline` for the signed-in user whose email matches. Accepting adds them to the project and the group as a `MEMBER`, with no key change.
- Removal requests under `/api/v1/cipseq/projects/:projectId/groups/:groupId/removal-requests`: an acting admin asks with `POST /` (`userId`), and the project admin uses `POST /:id/approve` (`passphrase`; revokes and rotates in one transaction) or `POST /:id/reject`. The requester or project admin can use `POST /:id/cancel`.
- CipSeq invitation tables and migration (`cipseq_invitations`): `groupInvitation` and `groupMemberRemovalRequest`, with partial unique indexes allowing one open invitation per group and email, and one pending request per group and member.
- `GET /api/v1/workspace` returns `notifications` (`INVITATION_RECEIVED`, `INVITATION_APPROVAL`, `REMOVAL_APPROVAL`), and `pendingInvitations` and `pendingRemovals` on each group for the project admin and acting admins.
- Audit events: `invitation.created`, `.approved`, `.rejected`, `.cancelled`, `.accepted` and `.declined`, and `removal_request.created`, `.rejected` and `.cancelled`.
- Unit and e2e tests for invitations and removal requests.
- Unit and e2e tests for rotation and the attempt limit.
- CipSeq devices under `/api/v1/cipseq/devices`: `POST /` registers a device (`deviceId`, ML-KEM-1024 `publicKey`, optional `name`) and sends an approval request for each group its user is in, `POST /:deviceId/groups/:groupId/request-approval` asks again for one group, and `POST /:deviceId/revoke` lets its user revoke it everywhere, permanently. Joining a group also sends requests for the user's devices.
- Project admin routes under `/api/v1/cipseq/projects/:projectId`: `POST /devices/:deviceId/approve` (`passphrase`; covers the device's waiting groups), `POST /devices/:deviceId/reject`, `POST /devices/:deviceId/revoke` (whole project) and `POST /members/:userId/revoke` (every group in the project). The project admin or the group's acting admin can use `POST /groups/:groupId/devices/:deviceId/revoke`.
- A background job (`src/cipseq/device-envelopes.ts`) calls `CreateDeviceEnvelope` after an approval or rotation, 5 at a time. It holds the passphrase in memory only and stops at the first failure without retrying.
- Job status in a new `envelopeJob` table, so the project admin sees `ENVELOPES_IN_PROGRESS`, `ENVELOPES_MISSING` (with `failureReason`: `WRONG_PASSPHRASE`, `KMS_UNAVAILABLE` or `INTERRUPTED`) and `ENVELOPES_COMPLETED` in `/workspace`. A running job that hasn't updated for 2 minutes counts as interrupted.
- `POST /groups/:groupId/envelopes/renew` (`passphrase`) resumes a stopped job, and answers `409` while one is running. `POST /groups/:groupId/envelopes/completed/dismiss` dismisses the completed notice, which otherwise stays.
- `GET /api/v1/workspace` returns `devices` for the signed-in user and `devices` on each group for the project admin and acting admins, plus `DEVICE_APPROVAL` notifications. No envelope is ever returned.
- CipSeq device tables and migrations (`cipseq_devices`, `cipseq_envelope_jobs`): `device`, `groupDevice`, `deviceEnvelope` and `envelopeJob`, with partial unique indexes allowing one open approval per group and device, one live envelope per group, device and version, and one acting admin per group.
- Audit events: `project.member_revoked`, `device.registered`, `.approval_requested`, `.approved`, `.rejected`, `.revoked`, `.envelopes_created` and `.envelope_job_dismissed`.
- Unit and e2e tests for devices, revocation and envelope jobs.
- Engine listener: a second Nest app on `DEVICE_ENGINE_PORT` (default `3443`, off until `DEVICE_ENGINE_ENABLED=true`) with its own TLS 1.3, `SecP256r1MLKEM768` only and a pinned server key. It mounts only `EngineModule`, so sign-in, the dashboard and `/ready` aren't reachable there, and enrol and renew aren't reachable on the console port. Start-up refuses a key that doesn't match its certificate or `DEVICE_TLS_PIN_FILE`, a bad CA bundle, or an OpenSSL build without the group.
- Device certificates over the engine listener: `POST /api/v1/cipseq/devices/:deviceId/certificate` enrols with a session and a CSR, and `.../certificate/renew` renews with only the certificate and a new key, keeping the old one for 24 hours. Both return exactly `certificate`, `serialNumber`, `notBefore` and `notAfter`: `201` when new and `200` for an exact retry. The KMS signs through the new `IssueDeviceCertificate` RPC and is never called twice for one CSR.
- Device identity from the TLS socket only, checked against the database on every request (including keep-alive and resumed TLS sessions), through `@CertificateOnly()` and `@SessionAndCertificate()`. `495` means re-enrol, and `403` means enrolling wouldn't help.
- `POST /api/v1/cipseq/crypto/encrypt` and `/decrypt` on the engine listener, needing a session and a certificate. Encrypt answers `503` with `Retry-After` while a device's new envelope is being created, and never returns an older version.
- `POST /api/v1/cipseq/devices` on the engine listener, sharing registration with the console route.
- `deviceCertificate`, `deviceCertificateAttempt` and `deviceCertificateNotice` tables (migration `device_certificates`), with a partial unique index allowing one current certificate per device and a unique CSR hash across history.
- Limits: 30 enrol or renew requests per device an hour, 5 new enrolments an hour, 5 renewals a day, 60 requests per device and 600 per IP a minute, and a 2-second wait for a busy device before `503` with `Retry-After`.
- `DEVICE_CERTIFICATE_ISSUED` notification and each device's `certificate` state in `GET /api/v1/workspace`, plus `POST /api/v1/cipseq/devices/certificate-notices/:noticeId/dismiss`. The notice can't be turned off in the settings.
- Audit events: `device.certificate_enrolled`, `.certificate_renewed`, `.certificate_refused`, `.certificate_issue_failed`, `.certificate_notice_dismissed` and `device.envelope_delivered`.
- `DEVICE_ENGINE_ENABLED`, `DEVICE_ENGINE_HOST`, `DEVICE_ENGINE_PORT`, `DEVICE_TLS_KEY`, `DEVICE_TLS_CERT`, `DEVICE_TLS_PIN_FILE` and `DEVICE_CA_BUNDLE` settings; the four files are required only when the listener is enabled.
- The gateway refuses to start with an expired `KMS_CLIENT_CERT`, warns under 30 days, and logs the expiry of every KMS and engine certificate daily.
- Better Auth `bearer()` plugin with signed tokens only.
- `npm run certs:engine`, which creates a development server key, certificate and pin, never replaces a key, and keeps the pin on `--renew`.
- `npm run users:migrate-ids`, a resumable one-off that gives existing users a UUID v4 id in both databases and signs them out.
- `docs/` pages: device certificates, TLS pins, envelope signing and environment settings.
- e2e tests with real TLS handshakes and real KMS signing for the listener, enrolment, renewal, certificate checks, races, delivery and the workspace; unit tests for TLS setup, device identity, CSR parsing, issued-certificate checks, limits and expiry.
- Email sending over SMTP (`src/lib/mailer.ts`, `nodemailer`), configured by `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS` and `EMAIL_FROM`. Emails are queued and never awaited by a request, over 2 pooled connections with 10-second timeouts; at most 200 wait, and the rest are dropped and logged. Port 465 uses TLS from the start, other ports STARTTLS, and production refuses a connection without TLS.
- Email verification: sign-up sends a link (`callbackURL` sets where it lands), an unverified sign-in sends a new one, and `POST /api/v1/auth/send-verification-email` resends it. Links last 1 hour.
- Password reset: `POST /api/v1/auth/request-password-reset` (the same answer for unknown emails) emails a one-time link valid for 1 hour, which redirects to `redirectTo?token=…`, then `POST /api/v1/auth/reset-password`.
- Google and GitHub sign-in through `POST /api/v1/auth/sign-in/social`, each on only when both `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` or `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are set.
- A "Your password was changed" email after `POST /api/v1/auth/change-password`.
- Branded HTML emails with a plain-text part (`src/auth/emails.ts`): verification, password reset and password changed, with no images or tracking.
- `test/helpers/users.ts` (`signUpVerified()`), shared by the e2e tests, and `test/setup-e2e.ts`, which replaces the mailer in every e2e test.
- e2e tests for verification, reset, change password, social sign-in, the reset rate limit and a burst of 20 sign-ins (about 460 ms, with the event loop never stalled over 24 ms); unit tests for the mailer, email templates, env schema, social providers and the callback timeout.
- `envelopeDelivery` table in the CipSeq database: one row per successful envelope delivery, with `operation` (`ENCRYPT` or `DECRYPT`), status, user, device, group, project, GDEK version and certificate serial. It's written in the same transaction as its `device.envelope_delivered` audit row, linked by `auditEventId` and the shared `requestId`, and indexed by project, group, user and device with the time. The audit row's metadata also gains `operation`. Counting starts from this deploy, with no backfill.
- Ten nullable engine-reported columns on `envelopeDelivery`, for the engine's usage report later: `dataKind`, `mimeType`, `sizeBytes`, `fileNameHash`, `outcome`, `errorCode`, `errorReason`, `durationMs`, `engineVersion` and `occurredAt`. Nothing writes or returns them yet.
- `GET /api/v1/cipseq/metrics/leaderboard?period=today|week|month|year|all` (default `month`): for the caller's own admin projects, the top 10 projects, users and devices by encryptions and decryptions, the totals, and one time series.
- `GET /api/v1/cipseq/metrics/usage?scope=project|group|user|device&id=…&period=today|week|month|year`: totals and a time series for one project or group (its admin), for yourself or your own device, or for another user or device within the caller's admin projects. Anything else answers `404`.
- Time series in UTC with every bucket present, empty ones as zeros: `today` in 4 six-hour buckets, `week` and `month` one per day for the last 7 or 30 days, `year` one per calendar month for the last 12, and `all` monthly from the first delivery.
- Full Swagger documentation for both metrics endpoints: Markdown descriptions, parameter enums and defaults, response schemas, and example responses for each period and for `400`, `401` and `404`.
- Unit tests for the buckets (month lengths, leap years, the year boundary, just after midnight) and query validation; e2e tests for both endpoints, access, ordering, the top-10 cut-off and periods, the delivery row written by a real encrypt and decrypt, and the OpenAPI document. Over 100,000 deliveries in one project, the slowest call (leaderboard `all`) took about 100 ms.
- Account type, for choosing a subscription tier later: `GET` and `PUT /api/v1/dashboard/account-type` with `accountType` (`INDIVIDUAL` or `COMPANY`) and, for a company, `companyName` (1–200 characters, trimmed; refused for an individual). It's set once: the same type again answers `200` and renames a company, a different type answers `409`, and support changes it by hand. It's `null` until chosen, and sign-up is unchanged.
- `accountProfile` table in the auth database, one row per user, deleted with the user, with a CHECK constraint that a company has a name and an individual has none.
- `accountType` and `companyName` in `GET` and `PATCH /dashboard/profile` and `/dashboard/settings` (read-only there), and a top-level `account` in `GET /workspace`.
- `REDIS_CA_CERT`: an optional PEM CA to trust for Redis's TLS certificate, for a self-signed one such as the local docker Redis. Only with `rediss://`; the certificate is still verified. The gateway and `npm run users:migrate-ids` both use it. Previously only `NODE_EXTRA_CA_CERTS`, set in every shell, worked.
- Unit and e2e tests for the account type (validation, set once, renames, two first choices at once, the CHECK constraint, the cascade and the OpenAPI document) and for `REDIS_CA_CERT`.
- Startup checks for every dependency (`checkDependenciesOnStartup()`): both databases, Redis (`PING`), the KMS (`grpc.health.v1` must answer `SERVING`) and the SMTP server (a login, nothing sent), in parallel with a 5-second timeout each. Any failure is logged with host, port and reason, and the gateway exits with that dependency's code: `10` auth database, `11` CipSeq database, `12` Redis, `13` KMS, `14` SMTP (the lowest when several fail). Success logs one line.
- SMTP connection watch: a login every 60 seconds, and a failed send with a connection error marks SMTP down at once. During an outage, failed emails are counted instead of logged one by one, and the restored line gives the count.
- `systemEvent` table in the auth database for infrastructure events, apart from the user audit trail: `CONNECTION_ESTABLISHED` for each dependency at startup, and `CONNECTION_LOST` (with the reason) and `CONNECTION_RESTORED` afterwards, with the gateway instance (`hostname:pid`) and when it happened. Written from an in-memory queue of up to 1,000 events, so an outage of the auth database itself is recorded once it's back.
- `account.type_set` and `account.company_renamed` audit rows in CipSeq's `auditEvent`. Sending the same values again or a refused change writes none.
- Unit tests for connection events, the event queue, the startup checks, the SMTP watch and the KMS serving status; e2e tests that start the built gateway with an unreachable SMTP server (exit `14`) and with Redis and SMTP unreachable (exit `12`, both logged), and for the account-type audit rows.
- Master accounts: `MASTER_EMAILS`, a comma-separated list of emails, each counting once its address is verified. Masters have no free-plan limits, and nothing in the API can grant the status.
- Free-plan limits for every other account, each an environment variable: `FREE_PLAN_MAX_PROJECTS` (1), `FREE_PLAN_MAX_GROUPS_PER_PROJECT` (2), `FREE_PLAN_MAX_PEOPLE_PER_GROUP` (3 members besides the project admin, counting open invitations), `FREE_PLAN_MAX_DEVICES` (1 active) and `FREE_PLAN_MAX_ENCRYPTIONS_PER_MONTH` / `FREE_PLAN_MAX_DECRYPTIONS_PER_MONTH` (500 each per calendar month, UTC). A refusal answers `403` with `code: PLAN_LIMIT_REACHED`, the limit and its `max` (plus `resetsAt` for the monthly ones), before any KMS call or passphrase attempt. Each check counts and writes in one transaction under a Postgres advisory lock. Group and people limits follow the project admin's plan, the rest the caller's. Existing data over a limit is kept.
- `GET /api/v1/master/metrics` (master accounts only, `404` for anyone else): encryptions, decryptions, accounts, projects and groups created and deleted, devices registered, and members and devices revoked, for `today` (4 buckets of 6 hours), `week` (7 days), `month` (4 weeks of 7 days) and `year` (12 months), each with `totals` and a `series`, in UTC.
- `account.limits` in `GET /api/v1/workspace`: each free-plan maximum (`null` for a master) and what the user has used, including this month's encryptions and decryptions.
- CipSeq indexes for the master metrics: `auditEvent(action, createdAt)`, `envelopeDelivery(createdAt)`, and `deletedAt` on `project` and `group` (migration `master_metrics`). The `account.deleted` audit action is named for the future delete-account work.
- Unit tests for the limits, the master check, the metric buckets and the new environment variables; e2e tests for every limit against the real databases, the master going past them, the master metrics and the monthly limit on the engine listener.

### Changed

- **Breaking:** acting admins now have the role `ACTING_ADMIN` instead of `ADMIN`, which means the project admin only. A group has at most one, and assigning a second answers `409`. The migration keeps the earliest assigned in each group and makes the others members.
- **Breaking:** revoking a member no longer rotates keys or takes a `passphrase`, so it works while the KMS is down. It takes effect at once by soft deleting that member's envelopes for the group. The group's acting admin can do it too, without approval, and someone who is an acting admin elsewhere counts as a plain member of this group.
- **Breaking:** a project has no direct members. Anyone but the project admin sees a project only while they're in one of its live groups, and gets `404` otherwise.
- **Breaking:** rotating a group is limited to once in 48 hours per group, answering `409` with `rotationAllowedAt` (creating a group doesn't start the limit). The response adds `envelopesToCreate`.
- `CreateDeviceEnvelope` is in `PASSPHRASE_CHECKING_METHODS`, so a wrong passphrase answers `403` and counts towards the attempt limit.

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
- `kmsCall()` maps gRPC `PERMISSION_DENIED` to `403 Incorrect passphrase` for the project rotation and group key RPCs. Other RPCs keep `502`, because there the status means the gateway itself was refused.
- Reserving, releasing and clearing a passphrase attempt moved into `withPassphraseAttempt()` (`src/cipseq/with-passphrase-attempt.ts`), shared by project rotation and the group endpoints.
- A direct member revoke now also cancels any pending removal request for that member. Group key creation and revocation moved into `src/cipseq/group-keys.ts`, shared with approving a removal request.
- **Breaking:** sessions last a fixed 1 day and are never extended, instead of 7 days refreshed daily, on the dashboard too.
- **Breaking:** new users, sessions and accounts get UUID v4 ids (`generateId: 'uuid'`, with `@default(uuid())` in the schema). Existing ids need `npm run users:migrate-ids`, which signs those users out.
- Revoking a device everywhere also revokes its certificates, under a per-device lock. Revoking from a group or project leaves them alone.
- `issueDeviceCertificate` has its own KMS error mapping: `INVALID_ARGUMENT` answers `400` and anything else `503`, so the engine keeps its CSR and retries.
- `auditEvent()` takes an optional transaction client, for the first interactive transactions.
- The validation pipe moved into `validationPipe()`, shared by both apps. Device registration moved into `registerDevice()`, shared by both ports.
- The KMS proto adds `IssueDeviceCertificate`.
- `package.json` requires Node 22.23.2 or later; the engine listener needs Node's OpenSSL 3.5 or later.
- `test/cipseq-devices.e2e-spec.ts` makes ML-KEM-1024 keys with OpenSSL, because Node 22 can't.
- `.env.example` documents every setting and when it's required.
- **Breaking:** email sign-in requires a verified email and answers `403` `EMAIL_NOT_VERIFIED` until then, and sign-up returns no session. Existing unverified users get a link on their next sign-in; their open sessions last until they expire.
- **Breaking:** the gateway won't start without `EMAIL_HOST`, `EMAIL_PORT` and `EMAIL_FROM`, except when `NODE_ENV=test`.
- The Google and GitHub callback answers `504` after 10 seconds, because Better Auth's calls to the providers have no time limit.
- **Breaking:** an unreachable database at startup exits with `10` (auth) or `11` (CipSeq) instead of `1`, and the gateway no longer starts without Redis, the KMS or the SMTP server. `1` now means invalid configuration only.
- Lost and restored connections for every dependency are logged from one place (`src/lib/connection-events.ts`): exactly one ERROR line when a connection is lost and one line when it's back, and nothing during startup or shutdown. `/ready` no longer logs its own KMS "Readiness check failed" and "passing again" lines.
- Choosing or renaming an account type no longer prints a console line; it's audited instead.
- **Breaking:** accounts other than the master accounts can no longer create more than the free plan allows (projects, groups, people per group, devices) or encrypt and decrypt more than 500 times each a month. `/crypto/encrypt` and `/crypto/decrypt` can answer `403` `PLAN_LIMIT_REACHED`, which the engine needs to handle.
- Creating a project, group, invitation or device and accepting an invitation now run in interactive transactions, so the limit check and the write commit together. `OPEN_INVITATION_STATUSES` moved to `invitations.dto.ts`.
- e2e tests run with the free-plan limits lifted and no master (`test/setup-e2e.ts`); `test/plan-limits.e2e-spec.ts` sets the defaults back.

### Fixed

- The image failed to build on Coolify with `nest: not found`: Coolify passes every environment variable as a build argument, including `NODE_ENV=production`, so `npm ci` skipped the devDependencies the build needs. The build stage now runs `npm ci --include=dev` (they're still pruned from the runtime image) and installs `openssl`, which silences Prisma's "failed to detect libssl" warnings.
- The image's health check requested `/health`, which answers `404` because every route is under `/api/v1`, so every container was marked unhealthy. It now checks `/api/v1/health`, with a 90-second start period instead of 30 to cover migrations and the dependency checks.
- A `PERMISSION_DENIED` from the KMS only counts as a wrong passphrase when its text is exactly `incorrect passphrase`. A refused gateway certificate now answers `502` instead of "Incorrect passphrase", no longer uses up the project's passphrase attempts, and no longer stops envelope jobs with `WRONG_PASSPHRASE`.
- A Postgres restart or a dropped idle connection can no longer crash the gateway: both databases now use a `pg` pool owned by the gateway (`connectionTimeoutMillis: 2000`) with an `error` listener, passed to Prisma with `disposeExternalPool`.

- The e2e test now boots the app on the Fastify adapter instead of Nest's default Express platform.
- e2e tests no longer share one Better Auth rate-limit bucket (sign-up/sign-in: 3 per 10 s per IP), which made the fourth sign-up in a run fail with `429`: each test now sends its own `x-forwarded-for` address from the reserved 198.18.0.0/15 range.
- When Redis is unreachable, auth requests no longer hang for over a minute: the Redis client fails commands within about 2 seconds (`maxRetriesPerRequest: 1`, `commandTimeout: 2000`) and auth routes and protected routes answer `503 Service Unavailable` instead of `500`.
- `test/migrate-user-ids.e2e-spec.ts` sorts its two audit rows by `action`, not `createdAt`, which they share, so it no longer fails at random.
- CORS now allows `PATCH` and `DELETE`. Fastify's default (`GET`, `HEAD`, `POST`) made browsers block them, including Dashboard profile and settings saves.
- CORS now allows `PUT`, which browsers blocked for `PUT /dashboard/account-type`.

### Security

- `REDIS_URL` must use TLS (`rediss://`) when `NODE_ENV` is `production`; startup fails otherwise.
- Auth fails closed while Redis is down: sessions can't be read, created or revoked, so a session revoked during an outage can't come back from a stale cache.
- README production checklist now requires a dedicated Redis ACL user with a strong password and Redis reachable only from the private network.
- API docs are never served in production: Swagger UI, the JSON document and the Better Auth `openAPI()` plugin (whose schema endpoint is public) are only enabled when `NODE_ENV` isn't `production`. The wildcard auth route is hidden from the docs.
- Profile images are not supported: a Better Auth `before` hook rejects an `image` field on `/api/v1/auth/sign-up/email` and `/api/v1/auth/update-user` with `400`. The column stays because Better Auth's user schema requires it, but it is always `null`.
- Startup is refused in production when `CIPSEQ_DATABASE_URL` points to the same database as `DATABASE_URL`, so CipSeq key material never shares the auth database.
- The KMS connection always uses mutual TLS (no plaintext mode). KMS request data, which carries passphrases and key material, is never logged, and clients never see the KMS's error details.
- Project passphrases go to the KMS and are never stored, logged or written to audit events. Only wrapped keys and salts are kept, in their own tables, so a project query can't return them by accident.
- Old wrapped keys aren't kept after a rotation, so an old passphrase can't open anything in the live database. `projectKeyVersion` now holds only the version and its date (migration `drop_key_version_material`), and the README production checklist warns that older backups still open with the old passphrase.
- Old wrapped group key pairs aren't kept either: a rotation overwrites `groupKeys`. Wrapped keys stay in their own table, so a group query or `/workspace` can't return them by accident.
- A certificate counts only if the TLS handshake authorized it **and** its row in the database is current, so a self-made look-alike, a revoked or retired certificate, and a resumed TLS session from before a revocation are all refused. No setting turns these checks off.
- The engine listener trusts no proxy: forwarded and client-certificate headers are ignored, and identity comes only from the socket.
- No table stores a private key, a raw CSR or a session token, and the workspace never returns certificate or key material.
- The engine listener closes idle connections at shutdown and everything else after 8 seconds, so a connected client can't hold up a deploy.
- Better Auth's origin, callback URL and CSRF checks are on in every environment (`disableOriginCheck: false`). Better Auth turned them off when `NODE_ENV=test`, so the e2e tests never exercised them.
- A password reset ends every session and marks the email verified, which is how someone recovers an address another person registered. A password change always signs out every other session, whatever the client sends, and keeps the current one.
- Verification links never create a session (`autoSignInAfterVerification: false`), and Google or GitHub sign-in only joins an existing account whose email is verified (`requireLocalEmailVerified`).
- Reset and resend requests are limited to 3 per minute per IP, against inbox flooding.
- Logs from the mailer carry the user id and error code only, never the address, link or token.

### Removed

- **Breaking:** removal requests (`/removal-requests` routes, the `groupMemberRemovalRequest` table, `pendingRemovals` and `REMOVAL_APPROVAL`). Removing someone from a whole project now belongs to the project admin alone.
- The `projectMember` table, whose rows are dropped by the `cipseq_devices` migration.
- Empty root `auth.ts` and the unused `prisma/schema.backup.prisma`.
- Unused `@types/express` and the redundant `@better-auth/prisma-adapter` dependency (already bundled with `better-auth`).
