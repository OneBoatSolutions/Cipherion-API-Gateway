# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Windsurf, Cursor, etc.) working in this repository.

## Project

**Cipherion API Gateway** is the unified API gateway for the Cipherion product suite. It hosts the Dashboard and CipSeq backends as Nest modules; CipSeq delegates all crypto to the Cipherion KMS over gRPC with mutual TLS and has its own PostgreSQL database. EnQrypt and Zentriq are deferred. See [README.md](README.md) for architecture and setup.

- NestJS 12 on the Fastify adapter, TypeScript, ESM (`"type": "module"`; relative imports use the `.js` extension)
- Two PostgreSQL databases through Prisma ORM 7 (`@prisma/adapter-pg`), each with its own schema, config, migrations and generated client (never edit generated code by hand):
  - auth (users, sessions, settings): `prisma/schema.prisma`, `prisma7.config.ts`, client `src/generated/prisma`, used through `src/lib/prisma.ts`
  - CipSeq (projects, groups, keys, invitations, devices, audit, billing): `prisma/cipseq/schema.prisma`, `prisma7.cipseq.config.ts`, client `src/generated/cipseq`, used through `src/lib/cipseq-prisma.ts`. No foreign keys to the auth database: reference users by the Better Auth user id
  - Each database has one `pg` pool, exported from its `src/lib/*prisma.ts` file and watched by `src/lib/database-watch.ts`. Don't create other pools or Prisma clients; `src/main.ts` checks both databases at startup and exits with code 1 if either is unreachable
- Cipherion KMS over gRPC with mutual TLS: contract in `proto/kms/v1/` (copied from the KMS, don't edit it here), typed client generated into `src/generated/kms` (never edit by hand), shared client in `src/lib/kms.ts`. Call RPCs only through `kmsCall()` in `src/kms/kms-call.ts` (deadline + gRPC→HTTP mapping), never retry them, and never log KMS request data (it carries passphrases and key material)
- CipSeq writes: call the KMS first, outside any transaction, then commit the change and its `auditEvent()` (`src/cipseq/audit.ts`) in one `cipseqPrisma.$transaction`. The KMS is stateless, so the database holds the only copy of the wrapped keys. Never return wrapped keys or salts, and never store or audit a passphrase. An RPC that checks a passphrase goes in `PASSPHRASE_CHECKING_METHODS` (`src/kms/kms-call.ts`), and its endpoint runs inside `withPassphraseAttempt()` (`src/cipseq/with-passphrase-attempt.ts`). A project has one admin (`Project.adminUserId`), and only that admin writes to the project and its groups; check access with `src/cipseq/project-access.ts` and `src/cipseq/group-access.ts`. New data for the signed-in user's first load also goes in `GET /workspace` (`src/workspace/`), scoped to what they're a part of
- Better Auth for authentication ([src/auth.ts](src/auth.ts))
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
