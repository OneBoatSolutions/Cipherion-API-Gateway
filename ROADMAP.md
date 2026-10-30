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

- [ ] Load env before `auth.ts` / `lib/prisma.ts` are imported (they read `process.env` at import time)
- [ ] Mount the Better Auth handler on the gateway
- [ ] Auth guard for protected routes
- [ ] API keys for service-to-service and programmatic clients

## Gateway routing

- [ ] Cipherion Enqrypt
- [ ] Zentriq
- [ ] Cipsec
- [ ] Dashboard backend endpoints

## Operations

- [ ] Health and readiness endpoints, including each upstream service
- [ ] OpenAPI / Swagger documentation
- [ ] CI pipeline (lint, test, build)
