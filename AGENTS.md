# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Windsurf, Cursor, etc.) working in this repository.

## Project

**Cipherion API Gateway** is the unified API gateway for the Cipherion product suite. It hosts the Dashboard and CipSeq backends as Nest modules; CipSeq delegates all crypto to the Cipherion KMS over gRPC with mutual TLS and has its own PostgreSQL database. EnQrypt and Zentriq are deferred. See [README.md](README.md) for architecture and setup.

- NestJS 12 on the Fastify adapter, TypeScript, ESM (`"type": "module"`; relative imports use the `.js` extension)
- Two PostgreSQL databases through Prisma ORM 7 (`@prisma/adapter-pg`), each with its own schema, config, migrations and generated client (never edit generated code by hand):
  - auth (users, sessions, settings): `prisma/schema.prisma`, `prisma7.config.ts`, client `src/generated/prisma`, used through `src/lib/prisma.ts`
  - CipSeq (projects, groups, keys, invitations, devices, audit, billing): `prisma/cipseq/schema.prisma`, `prisma7.cipseq.config.ts`, client `src/generated/cipseq`, used through `src/lib/cipseq-prisma.ts`. No foreign keys to the auth database: reference users by the Better Auth user id. The CipSeq migrations have hand-written partial unique indexes that the schema can't express, so create such a migration with `--create-only` and add them before applying it
  - Each database has one `pg` pool, exported from its `src/lib/*prisma.ts` file and watched by `src/lib/database-watch.ts`. Don't create other pools or Prisma clients
- Container start: `scripts/entrypoint.sh` (the Dockerfile's `ENTRYPOINT`) applies both databases' migrations with `prisma migrate deploy` (exit 20 auth, 21 CipSeq; `SKIP_MIGRATIONS`, `MIGRATE_ATTEMPTS`, `MIGRATE_RETRY_SECONDS`), then `exec`s the command, so the gateway stays PID 1 and gets `SIGTERM`. A new step at container start goes there, before the final `exec`; keep it POSIX `sh` and never print a connection URL
- Startup and connection events: `src/main.ts` runs `checkDependenciesOnStartup()` (`src/lib/startup-checks.ts`) before Nest starts. Both databases, Redis, the KMS and SMTP must answer, or the process exits with 10, 11, 12, 13 or 14 (`EXIT_CODES`); 1 stays for invalid configuration. A new dependency gets a check there and an exit code. After startup, watchers report every failure and success to `src/lib/connection-events.ts`, the only place that logs a lost or restored connection (once each way) and records it. Infrastructure events go only to the auth database's `systemEvent` table, through `src/lib/system-events.ts`, never to CipSeq's `auditEvent`, which is for what users do. `/ready` reports but never logs
- Cipherion KMS over gRPC with mutual TLS: contract in `proto/kms/v1/` (copied from the KMS, don't edit it here), typed client generated into `src/generated/kms` (never edit by hand), shared client in `src/lib/kms.ts`. Call RPCs only through `kmsCall()` in `src/kms/kms-call.ts` (deadline + gRPC→HTTP mapping), never retry them, and never log KMS request data (it carries passphrases and key material)
- CipSeq writes: call the KMS first, outside any transaction, then commit the change and its `auditEvent()` (`src/cipseq/audit.ts`) in one `cipseqPrisma.$transaction`. The KMS is stateless, so the database holds the only copy of the wrapped keys. Never return wrapped keys or salts, and never store or audit a passphrase. An RPC that checks a passphrase goes in `PASSPHRASE_CHECKING_METHODS` (`src/kms/kms-call.ts`), and its endpoint runs inside `withPassphraseAttempt()` (`src/cipseq/with-passphrase-attempt.ts`). A project has one admin (`Project.adminUserId`) and no direct members: anyone else reaches it only through a group. Only that admin writes to the project and its groups, except that a group's one `ACTING_ADMIN` can invite to it (with the admin's approval) and revoke members and devices from it; check access with `src/cipseq/project-access.ts` and `src/cipseq/group-access.ts`. Revoking never rotates keys or needs a passphrase (`src/cipseq/revocations.ts`). Device envelopes are created by a background job in `src/cipseq/device-envelopes.ts`, which holds the passphrase in memory only, and its state is in `src/cipseq/envelope-jobs.ts`. New data for the signed-in user's first load also goes in `GET /workspace` (`src/workspace/`), scoped to what they're a part of
- Engine listener: a second Nest app on its own TLS port, in `src/engine/`, for the engine on each device. Mount a route there only by adding it to `EngineModule`, never `AuthModule` or `DevicesController`. Identity comes only from the TLS socket (`device-peer.ts`), and `socket.authorized` plus the database check in `checkCertificate()` must both pass on every request. Use `@CertificateOnly()` or `@SessionAndCertificate()`, not a bare `@Public()`. Inside an interactive transaction, pass its `tx` to `auditEvent()`, and return refusals instead of throwing them, or the attempt count rolls back. Any change to a device's status or certificates takes `lockDevice()` (`src/cipseq/device-lock.ts`) first. Never add a setting that turns certificate checks off, and never add a field to the four-field certificate response without a coordinated engine release. Docs are in `docs/`
- Metrics (`src/cipseq/metrics.ts`): encryptions and decryptions are counted only from `envelopeDelivery`, never from audit rows. Every successful delivery writes one, with its `device.envelope_delivered` audit row and the same `requestId`, in the delivery's transaction. Metrics queries are `$queryRaw` tagged templates (column names only from a whitelist), and buckets are in UTC with every bucket present. Anything the caller can't see answers `404`, like an unknown id
- Account type (`accountProfile` in the auth database, `src/dashboard/account-type.ts`): `INDIVIDUAL` or `COMPANY`, for choosing a subscription tier. It's set once through `setAccountType()` (a different type answers `409`); read it with `loadAccountType()`, never by switching on a missing row elsewhere. A hand-written CHECK keeps `companyName` set exactly for `COMPANY`. Changes are audited as `account.type_set` and `account.company_renamed` in CipSeq's `auditEvent`, after the auth-database write commits (two databases, no shared transaction): a failed audit write is logged, not thrown. Don't log account changes to the console
- Free plan and master account (`src/cipseq/plan-limits.ts`): every account except those in `MASTER_EMAILS` (comma-separated, verified addresses only) is limited by the `FREE_PLAN_MAX_*` variables, read on each call. A new limit or a new route that creates a limited thing goes through an `assert*Allowed()` there: once before any KMS call or passphrase attempt, then again with `tx` inside an interactive `$transaction` that also writes the row, so `lockPlan()` makes count-then-write safe. Refusals are `403` with `code: PLAN_LIMIT_REACHED`; on the engine routes they're returned, not thrown (`usageRefusal()`). Group and people limits follow the project admin's plan, the rest the caller's. Master-only routes go in `src/master/` behind `@MasterOnly()`, which answers `404` to everyone else. e2e tests run with the limits lifted (`test/setup-e2e.ts`); `test/plan-limits.e2e-spec.ts` sets the defaults back
- Better Auth for authentication ([src/auth.ts](src/auth.ts)). Email sign-in requires a verified email. Keep `advanced.disableOriginCheck: false`: Better Auth otherwise skips its origin, callback URL and CSRF checks when `NODE_ENV=test`. e2e tests that need a signed-in user use `signUpVerified()` (`test/helpers/users.ts`)
- Email: send only through `mailer.send()` (`src/lib/mailer.ts`), never awaited by a request and never from anywhere else, with templates in `src/auth/emails.ts` (escape anything a user typed). Never log an email address, link or token; log the user id and error code. `test/setup-e2e.ts` replaces the mailer in e2e tests, which read links from its calls
- Environment validated with Joi in [src/config/env.schema.ts](src/config/env.schema.ts)

### Commands

```bash
npm run start:dev                                   # run in watch mode
npm run build                                       # compile
npm run lint                                        # oxlint (type-aware)
npm run format                                      # prettier
npm run test                                        # unit tests (vitest)
npm run test:e2e                                    # e2e tests (need the KMS running locally)
npm run db:generate                                 # regenerate both Prisma clients
npm run proto:generate                              # regenerate the KMS gRPC client after a .proto change
npm run users:migrate-ids                           # one-off: move pre-UUID user ids to UUID v4 (dry run; -- --apply)
npx prisma migrate dev --name <name> --config prisma7.config.ts          # auth database
npx prisma migrate dev --name <name> --config prisma7.cipseq.config.ts   # CipSeq database
```

Always pass `--config` to Prisma commands: `prisma7.config.ts` for the auth database, `prisma7.cipseq.config.ts` for CipSeq.

### Conventions

- Add every new environment variable to the Joi schema in `src/config/env.schema.ts`, to `.env.example` and to the variables table in `README.md`.
- Never commit `.env`, `.env.dev`, `.env.prod` or secrets.
- Run `npm run lint` and `npm run test` before calling a change finished.

---

## Workflow

### Branches

- `main`: production
- `dev`: integration branch; every feature PR targets `dev`
- `feature/<short-name>`, `fix/<short-name>`, `chore/<short-name>`: work branches, created from `dev`

### After each change or iteration

1. Make the change and tell the user what was done.
2. **Wait for the user to approve it** (e.g. "ok", "approved", "looks good", "done", "next").
3. Once it is approved, record it straight away:
   - **CHANGELOG.md**: add an entry under `## [Unreleased]` in the right group (`Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Deprecated`).
   - **ROADMAP.md**: mark the matching item done (`- [x]`). If the work wasn't on the roadmap, add it as done in the right section, and add any follow-up work you found as new unchecked items.
4. Don't change CHANGELOG or ROADMAP for work the user hasn't approved, or has rejected.

### Commit shorthand: `cm`

When the user types **`cm`** (or asks "give me commit message", "commit message", "ready to commit", "wrap up"):

1. **Review everything on the branch.** Run `git status`, `git diff dev...HEAD` and `git diff` (plus staged changes) to see all work since the branch left `dev`.
2. **Bring the docs up to date** where it applies:
   - `CHANGELOG.md`: every approved change is listed under `[Unreleased]`.
   - `ROADMAP.md`: finished items are checked.
   - `README.md`: setup steps, environment variables, scripts, architecture, endpoints or status changed by this work are reflected.
   - `.env.example`: contains every new environment variable.
   - `AGENTS.md`: commands or conventions changed by this work are updated.
3. **Give the user** the output below. Don't commit, push or open the PR unless the user explicitly asks.

````markdown
### Commit message
```
<type>(<scope>): <imperative summary, max 72 chars>

- <what changed and why>
- <what changed and why>
```

### PR title
```
<type>(<scope>): <summary>
```

### PR description (`feature/<name>` → `dev`)
```markdown
## Summary
<1–3 sentences on what this PR does and why>

## Changes
- <change>
- <change>

## How to test
1. <step>
2. <step>

## Checklist
- [ ] Lint and tests pass
- [ ] CHANGELOG.md updated
- [ ] ROADMAP.md updated
- [ ] README.md / .env.example updated (if applicable)
- [ ] Migrations included (if schema changed)

## Notes
<breaking changes, new env vars, migrations, follow-ups — or "None">
```
````

**Commit message rules** ([Conventional Commits](https://www.conventionalcommits.org)):

- Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style`, `revert`
- Scope: the affected area, such as `auth`, `gateway`, `dashboard`, `cipseq`, `kms`, `enqrypt`, `zentriq`, `prisma`, `config` or `setup`
- Summary: imperative mood, lowercase, no trailing period
- Put `BREAKING CHANGE:` in the body when behaviour or the API changes in a way that isn't backward compatible
