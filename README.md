# Cipherion API Gateway

A unified API gateway for the Cipherion product suite. It gives clients a single entry point, with shared authentication, rate limiting, validation and observability, in front of these services:

| Service | Description |
| --- | --- |
| **Cipherion Enqrypt** | Encryption service |
| **Zentriq** | Zentriq service |
| **Cipsec** | Security service |
| **Dashboard** | Cipherion web dashboard (the main browser client of the gateway) |

> **Status:** early development. The core runtime (NestJS on Fastify, environment validation, Prisma/PostgreSQL, Better Auth and Nest Observe) is set up, and the auth endpoints are live under `/api/v1/auth`. Routing to the upstream services has not been built yet.

---

## Architecture

```
                 ┌──────────────────────────────────────────┐
  Dashboard ───► │          Cipherion API Gateway           │ ───► Cipherion Enqrypt
  API clients ─► │  Auth · Rate limit · Validation · Tracing│ ───► Zentriq
                 │                                          │ ───► Cipsec
                 └───────────────────┬──────────────────────┘
                                     │
                                PostgreSQL
                     (users, sessions, rate limits)
```

**Responsibilities**

- **Authentication**: email/password sign-in and database-backed sessions through [Better Auth](https://better-auth.com). Sessions last 7 days and are refreshed every 24 hours.
- **Rate limiting**: 100 requests per 60-second window, stored in PostgreSQL so the limit holds across instances.
- **Request validation**: a global `ValidationPipe` that removes unknown fields, rejects requests containing them, and returns errors in one consistent format.
- **Configuration safety**: environment variables are checked with Joi when the app starts, so a misconfigured deployment fails immediately.
- **Observability**: tracing, metrics, logs and error tracking through [NestJS Observe](https://observe.nestjs.com).
- **Routing** *(planned)*: forwarding requests to Enqrypt, Zentriq, Cipsec and the dashboard backend.

## Tech stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 22+, TypeScript (ESM) |
| Framework | NestJS 12 with the Fastify adapter |
| Database | PostgreSQL, Prisma ORM 7 (`@prisma/adapter-pg` driver adapter) |
| Auth | Better Auth with the Prisma adapter |
| Validation | class-validator, class-transformer, Joi (environment) |
| Observability | `@nestjs/observe` |
| Tooling | Vitest, oxlint, Prettier |

## Project structure

```
.
├── prisma/
│   ├── schema.prisma        # Database schema (User, Session, Account, Verification, RateLimit)
│   └── migrations/          # Prisma migrations (commit every migration)
├── prisma7.config.ts        # Prisma config; loads .env.dev / .env.prod / .env.test from NODE_ENV
├── src/
│   ├── main.ts              # Bootstrap: Fastify adapter, configureApp(), port binding
│   ├── app.setup.ts         # configureApp(): /api/v1 prefix, CORS, global ValidationPipe
│   ├── app.module.ts        # Root module: ConfigModule (Joi validation), ObserveModule, AuthModule
│   ├── config/env.ts        # Loads the env file before anything reads process.env
│   ├── auth.ts              # Better Auth configuration
│   ├── auth/                # AuthController (/api/v1/auth/*), global AuthGuard, @Public() / @CurrentUser()
│   ├── lib/prisma.ts        # Shared PrismaClient
│   └── generated/prisma/    # Generated Prisma Client (do not edit by hand)
├── test/                    # End-to-end tests
├── .env.example             # Template for environment variables
└── package.json
```

---

## Getting started

### Prerequisites

- **Node.js** 22 or later, and npm
- **PostgreSQL** 14 or later, running locally, in Docker, or hosted

To run PostgreSQL quickly with Docker:

```bash
docker run -d --name cipherion-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=cipherion_gateway \
  -p 5432:5432 postgres:16
```

### 1. Clone and install

```bash
git clone <repository-url>
cd Cipherion-API_Gateway
npm install
```

### 2. Configure the environment

Copy the template and fill in your values:

```bash
cp .env.example .env.dev
```

The application loads its environment file in this order:

1. `.env`, if it exists
2. Otherwise `.env.prod` when `NODE_ENV=production`
3. Otherwise `.env.dev`

The Prisma CLI (`prisma7.config.ts`) chooses `.env.dev`, `.env.prod` or `.env.test` based on `NODE_ENV`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | `development`, `test` or `production` |
| `PORT` | No | `3000` | Port the gateway listens on (binds to `0.0.0.0`) |
| `DATABASE_URL` | **Yes** | – | PostgreSQL connection string, e.g. `postgresql://postgres:password@localhost:5432/cipherion_gateway` |
| `BETTER_AUTH_SECRET` | **Yes** | – | Secret used to sign sessions. Must be **at least 32 characters** |
| `BETTER_AUTH_URL` | **Yes** | – | Public base URL of the gateway, e.g. `http://localhost:3000` |
| `AUTH_TRUSTED_ORIGINS` | **Yes** | – | Comma-separated list of origins allowed to call auth endpoints (for example, the dashboard URL) |
| `OBSERVE_APP_KEY` | No | – | NestJS Observe app key |
| `OBSERVE_APP_SECRET` | No | – | NestJS Observe app secret |

To generate a strong `BETTER_AUTH_SECRET`:

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Example `.env.dev`:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://postgres:password@localhost:5432/cipherion_gateway

BETTER_AUTH_SECRET=replace-with-a-random-string-of-at-least-32-chars
BETTER_AUTH_URL=http://localhost:3000
AUTH_TRUSTED_ORIGINS="http://localhost:3000,http://localhost:5173"
```

> Never commit `.env`, `.env.dev` or `.env.prod`. Only `.env.example` belongs in version control.

### 3. Set up the database

The Prisma config file is named `prisma7.config.ts`, so pass it to every Prisma command with `--config`:

```bash
# Generate the Prisma Client into src/generated/prisma
npx prisma generate --config prisma7.config.ts

# Create and apply migrations (development)
npx prisma migrate dev --name init --config prisma7.config.ts
```

Optionally, open Prisma Studio to browse the data:

```bash
npx prisma studio --config prisma7.config.ts
```

### 4. Run the gateway

```bash
# development
npm run start

# watch mode (recommended for local work)
npm run start:dev

# debug mode with watch
npm run start:debug
```

The gateway starts on `http://localhost:3000` (or on `PORT` if set). Every route is served under the `/api/v1` prefix. To check that it is running:

```bash
curl http://localhost:3000/api/v1
```

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run start` | Start the app |
| `npm run start:dev` | Start in watch mode |
| `npm run start:debug` | Start in debug mode with watch |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build (`node dist/main`) |
| `npm run lint` | Lint `src/` and `test/` with oxlint (type-aware) |
| `npm run format` | Format code with Prettier |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:watch` | Run unit tests in watch mode |
| `npm run test:cov` | Run unit tests with coverage |
| `npm run test:e2e` | Run end-to-end tests |

## Auth endpoints

Better Auth is mounted at `/api/v1/auth/*`. Sessions are returned as cookies, and browsers can only call these endpoints from an origin listed in `AUTH_TRUSTED_ORIGINS` (CORS with credentials). Better Auth also checks the `Origin` header of state-changing requests against that list, so the curl examples below send one.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/v1/auth/sign-up/email` | Create an account (`name`, `email`, `password`) |
| `POST` | `/api/v1/auth/sign-in/email` | Sign in (`email`, `password`) and receive the session cookie |
| `GET` | `/api/v1/auth/get-session` | Current user and session, or `null` |
| `POST` | `/api/v1/auth/sign-out` | End the current session |

```bash
# sign up, then sign in and store the session cookie
curl -X POST http://localhost:3000/api/v1/auth/sign-up/email \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"name":"Jane","email":"jane@example.com","password":"a-strong-password"}'

curl -X POST http://localhost:3000/api/v1/auth/sign-in/email -c cookies.txt \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"email":"jane@example.com","password":"a-strong-password"}'

# read the session with the stored cookie
curl http://localhost:3000/api/v1/auth/get-session -b cookies.txt
```

The e2e tests (`npm run test:e2e`) exercise these endpoints against the `.env.dev` database and delete the test user afterwards.

## Protecting routes

A global `AuthGuard` runs before every route. Without a valid session cookie the request is rejected with `401 Unauthorized`, so **new routes are protected by default**.

- `@Public()` on a route or controller lets requests through without a session. `GET /api/v1` and `/api/v1/auth/*` are public.
- `@CurrentUser()` injects the signed-in user into a handler.

```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator.js';
import { CurrentUser } from './auth/decorators/current-user.decorator.js';
import type { AuthUser } from './auth/auth.types.js';

@Controller('example')
export class ExampleController {
  @Public()
  @Get('status')
  status() {
    return { ok: true }; // reachable without signing in
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email }; // 401 when signed out
  }
}
```

## Validation error format

Requests that fail DTO validation return `400 Bad Request` in this format:

```json
{
  "message": "Validation failed",
  "errors": [
    { "property": "email", "constraints": ["email must be an email"] }
  ]
}
```

---

## Deployment

1. Set `NODE_ENV=production` and provide every required variable through the host's environment or `.env.prod`.
2. Install dependencies, generate the client and build:
   ```bash
   npm ci
   npx prisma generate --config prisma7.config.ts
   npm run build
   ```
3. Apply migrations. Use `migrate deploy` in production, never `migrate dev`:
   ```bash
   NODE_ENV=production npx prisma migrate deploy --config prisma7.config.ts
   ```
4. Start the gateway:
   ```bash
   npm run start:prod
   ```

**Production checklist**

- `BETTER_AUTH_SECRET` is unique for each environment and at least 32 characters long.
- `BETTER_AUTH_URL` uses `https://`. Secure cookies are turned on automatically when `NODE_ENV=production`.
- `AUTH_TRUSTED_ORIGINS` lists only the real dashboard and client origins.
- `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` are set so that telemetry is sent.

## Observability

The gateway is instrumented with NestJS Observe under the service ID `Cipherion-API_Gateway`. To connect it locally:

```bash
npx @nestjs/observe link
```

In production, set `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment.

---

## Roadmap and changelog

- Planned and completed work: [ROADMAP.md](ROADMAP.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md)

## Contributing

Branch from `dev` (`feature/<name>`, `fix/<name>`), use [Conventional Commits](https://www.conventionalcommits.org), and open PRs into `dev`. Agent workflow rules are in [AGENTS.md](AGENTS.md).

## License

UNLICENSED. Proprietary to OneBoat Solutions. All rights reserved.
