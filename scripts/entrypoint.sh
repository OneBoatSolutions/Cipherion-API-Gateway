#!/bin/sh
# Container entrypoint. On every start it applies both databases' migrations,
# then replaces itself with the gateway (or whatever command was given), so
# the gateway is PID 1 and gets the platform's SIGTERM for a clean shutdown.
#
# Settings (all optional):
#   SKIP_MIGRATIONS=true      skip both migration steps (a release job runs them)
#   MIGRATE_ATTEMPTS=5        tries per database while it is still starting
#   MIGRATE_RETRY_SECONDS=5   wait between tries
#
# Exit codes: 1 a database URL is missing, 20 the auth database's migrations
# failed, 21 the CipSeq database's did. The gateway itself uses 10-14.
#
# Never prints a connection URL: Prisma's output names the database and host only.
set -eu

cd "$(dirname "$0")/.."

log() {
  printf '%s entrypoint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

require() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    log "$1 is not set"
    exit 1
  fi
}

# No "update available" banner in the container logs.
export PRISMA_HIDE_UPDATE_MESSAGE=true

attempts=${MIGRATE_ATTEMPTS:-5}
wait_seconds=${MIGRATE_RETRY_SECONDS:-5}
prisma=./node_modules/.bin/prisma

# migrate <label> <prisma config> <exit code>
migrate() {
  try=1
  while :; do
    log "Applying $1 migrations (attempt $try of $attempts)"
    if "$prisma" migrate deploy --config "$2"; then
      return 0
    fi
    if [ "$try" -ge "$attempts" ]; then
      log "Giving up: the $1 migrations failed $attempts times"
      exit "$3"
    fi
    try=$((try + 1))
    sleep "$wait_seconds"
  done
}

if [ "${SKIP_MIGRATIONS:-false}" = "true" ]; then
  log "SKIP_MIGRATIONS=true, not applying migrations"
else
  require DATABASE_URL
  require CIPSEQ_DATABASE_URL
  # migrate deploy takes a Postgres advisory lock, so replicas starting
  # together apply each migration once.
  migrate "auth database" prisma7.config.ts 20
  migrate "CipSeq database" prisma7.cipseq.config.ts 21
  log "Migrations done"
fi

if [ "$#" -eq 0 ]; then
  set -- node dist/main
fi
log "Starting: $*"
exec "$@"
