#!/usr/bin/env bash
# SessionStart hook for Claude Code on the web.
#
# The container is rebuilt for every session and the repository is cloned
# fresh, so without this an agent spends its first minutes reinstalling
# dependencies, hunting for a database that is not running, and
# rediscovering where the browser lives. Whatever this script does is
# baked into the cached container image once it completes, so the cost is
# paid at image-build time rather than at the start of every session.
#
# Three things this environment does NOT give us, all learned the hard
# way in a real session:
#
#   1. PostgreSQL 16 is installed but the cluster is DOWN, and nothing
#      has created the roles or the database. The Docker Compose path the
#      repo uses locally (scripts/bootstrap.sh) is not usable here: the
#      daemon ships stopped (section 2b starts it) and pulling the
#      postgres image can be denied by the session's egress policy. The
#      native cluster needs neither, and it is lighter anyway.
#   2. The database URLs live in .env, which the repo does not commit, so
#      `pnpm db:migrate` fails with "DATABASE_ADMIN_URL is required"
#      until something exports them.
#   3. Playwright's pinned browser build is not the one installed at
#      /opt/pw-browsers, so `pnpm test:e2e` fails with "Executable
#      doesn't exist" until PLAYWRIGHT_CHROMIUM_PATH points at the
#      system Chromium (playwright.config.ts already reads that
#      variable).
#
# Idempotent throughout: safe to run against a warm container as well as
# a cold one.
set -euo pipefail

# Local machines have their own setup (scripts/bootstrap.sh, Docker
# Compose). This hook is for the remote environment only.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

log() { printf '[session-start] %s\n' "$*"; }

# ---------------------------------------------------------------------
# 1. Configuration. .env is the single source of truth the repo's own
# scripts use; create it from the committed example when absent, then
# export it so everything below sees the same values.

if [ ! -f .env ]; then
  cp .env.example .env
  log "created .env from .env.example"
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Hand the same values to the SESSION, so an agent can run pnpm
# db:migrate or the integration suites without re-deriving them.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export DATABASE_ADMIN_URL='${DATABASE_ADMIN_URL}'"
    echo "export DATABASE_URL='${DATABASE_URL}'"
    echo "export AUTO_MB_APP_DB_PASSWORD='${AUTO_MB_APP_DB_PASSWORD}'"
    # playwright.config.ts falls back to this when the pinned browser
    # download is unavailable, which is the case in this sandbox.
    echo "export PLAYWRIGHT_CHROMIUM_PATH='/opt/pw-browsers/chromium'"
  } >> "${CLAUDE_ENV_FILE}"
  log "exported database and Playwright variables to the session"
fi

# ---------------------------------------------------------------------
# 2. System packages. The LOA parser shells out to `pdftotext -layout`
# (docs/DEPENDENCIES.md) — the parser corpus was built with exactly that
# extraction, so its absence fails real tests rather than a nicety.

if ! command -v pdftotext >/dev/null 2>&1; then
  log "installing poppler-utils"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq poppler-utils
fi

# ---------------------------------------------------------------------
# 2b. Docker daemon. dockerd and containerd are installed in this image but
# nothing starts them — PID 1 is not an init system — so `docker compose`
# fails with a bare "cannot connect to the Docker socket" that reads like
# Docker is unavailable rather than merely stopped. Start it so the CLI
# works and failures name their real cause.
#
# This does NOT make docker-compose.yml usable on its own: pulling images
# reaches Docker Hub's blob CDN (production.cloudfront.docker.com), which
# the session's egress policy may deny with a 403. When it does, the pull
# is the thing to report — never work around the policy. The database is
# provisioned natively below, so nothing in the test suite depends on this.

if command -v dockerd >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  log "starting the Docker daemon"
  nohup dockerd >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 20); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null 2>&1 ||
    log "Docker daemon did not start; see /var/log/dockerd.log (non-fatal)"
fi

# ---------------------------------------------------------------------
# 3. Node dependencies. --frozen-lockfile keeps the install reproducible
# and still reuses the pnpm content-addressed store, which is what makes
# a warm container cheap.

corepack enable
# The whole `name@version` spec, verbatim from package.json — corepack
# rejects a bare version, and hard-coding the number here would drift
# from the manifest the moment pnpm is upgraded.
corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
log "installing workspace dependencies"
pnpm install --frozen-lockfile

# ---------------------------------------------------------------------
# 4. PostgreSQL. Every database-backed suite runs against a real server
# (AGENTS.md), so this is not optional: without it roughly half the
# server tests and the whole packages/db suite fail to even connect.

pg_running() { pg_isready -h 127.0.0.1 -p 5432 -q; }

if ! pg_running; then
  log "starting the PostgreSQL cluster"
  # A container that was snapshotted with the server up leaves a stale
  # pid file behind; pg_ctlcluster clears it itself and says so.
  pg_ctlcluster 16 main start || true
  for _ in $(seq 1 30); do
    pg_running && break
    sleep 1
  done
fi
pg_running || {
  echo "[session-start] PostgreSQL did not start; see /var/log/postgresql/postgresql-16-main.log" >&2
  exit 1
}

# The Docker image the repo uses locally creates the admin role and the
# database from POSTGRES_* variables. The native cluster does not, so do
# it here — as the postgres OS user, which is what local peer
# authentication accepts.
as_postgres() { su postgres -c "$1"; }

if ! as_postgres "psql -tAc \"select 1 from pg_roles where rolname = '${POSTGRES_ADMIN_USER}'\"" | grep -q 1; then
  log "creating the ${POSTGRES_ADMIN_USER} role"
  # SUPERUSER to match the postgres Docker image's POSTGRES_USER: the
  # migrations create extensions, SECURITY DEFINER functions and roles.
  as_postgres "psql -qc \"create role ${POSTGRES_ADMIN_USER} login superuser password '${POSTGRES_ADMIN_PASSWORD}'\""
fi

# The application role is deliberately NOT a superuser and does not
# inherit: AGENTS.md rule 4 turns row-level security into a real boundary
# rather than a decoration, and BYPASSRLS would quietly undo it.
if ! as_postgres "psql -tAc \"select 1 from pg_roles where rolname = 'auto_mb_app'\"" | grep -q 1; then
  log "creating the auto_mb_app role"
  as_postgres "psql -qc \"create role auto_mb_app login nosuperuser nocreatedb nocreaterole noinherit password '${AUTO_MB_APP_DB_PASSWORD}'\""
fi

if ! as_postgres "psql -tAc \"select 1 from pg_database where datname = '${POSTGRES_DB}'\"" | grep -q 1; then
  log "creating the ${POSTGRES_DB} database"
  as_postgres "createdb -O ${POSTGRES_ADMIN_USER} ${POSTGRES_DB}"
fi

# ---------------------------------------------------------------------
# 5. Schema. Migrations are idempotent by ledger — an already-migrated
# database is a no-op — and the bootstrap step (re)applies the
# application role's grants against whatever the migrations just built.

log "applying migrations"
pnpm db:migrate
log "applying the application role's grants"
pnpm --filter @auto-mb/db bootstrap

log "ready: pnpm verify, pnpm test and the integration suites can run"
