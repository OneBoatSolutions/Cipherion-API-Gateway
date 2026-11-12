# syntax=docker/dockerfile:1
# Cipherion API gateway. Coolify builds this: Base Directory "/", Dockerfile "/Dockerfile".
# Node 24 ships OpenSSL 3.5, which the engine listener needs (SecP256r1MLKEM768).
# For tamper-evident builds, pin the base image by digest:  FROM node:24-bookworm-slim@sha256:<digest>

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Prisma generate looks for the system openssl too.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --include=dev: Coolify passes every environment variable as a build argument,
# including NODE_ENV=production, which would otherwise make npm skip the
# devDependencies the build needs (@nestjs/cli, typescript, prisma).
# They are pruned again below, so the runtime image stays production-only.
RUN npm ci --include=dev
COPY . .
# Prisma clients are generated into src/generated; nest build then compiles to dist/.
# The URLs below are placeholders: generate and build never connect to a database.
RUN DATABASE_URL=postgresql://x@localhost/x CIPSEQ_DATABASE_URL=postgresql://x@localhost/y npm run db:generate \
 && npm run build \
 && npm prune --omit=dev \
 && npm install --no-save --omit=dev --ignore-scripts prisma@7.10.1

FROM node:24-bookworm-slim AS run
ENV NODE_ENV=production
WORKDIR /app
# Prisma's migrate command looks for the system openssl.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
# Production modules, the Prisma CLI (for `npm run db:deploy`), the compiled app, and the migrations.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma7.config.ts /app/prisma7.cipseq.config.ts /app/package.json ./
# The generated Prisma and gRPC clients (imported at run time).
COPY --from=build --chown=node:node /app/src/generated ./src/generated
# Applies both databases' migrations on every start, then execs the CMD.
COPY --from=build --chown=node:node --chmod=755 /app/scripts/entrypoint.sh ./scripts/entrypoint.sh
USER node
# 3000 = console (behind Traefik).  3443 = engine listener (publish directly, never through a proxy).
EXPOSE 3000 3443
# Every route is under /api/v1. The start period covers migrations and the dependency checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["./scripts/entrypoint.sh"]
CMD ["node", "dist/main"]
