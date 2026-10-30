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

## Auth

- [x] Load env before `auth.ts` / `lib/prisma.ts` are imported (they read `process.env` at import time)
- [x] Mount the Better Auth handler on the gateway (`/api/v1/auth/*`)
- [x] CORS for trusted origins
- [ ] Auth guard for protected routes
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
