#!/usr/bin/env bash
# Cloud-agent environment start: runs on every agent boot. Brings up Docker,
# PostgreSQL, and Gotenberg, then applies migrations so agents can run
# `pnpm verify` and the dev servers immediately. Must stay idempotent.
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  sudo service docker start >/dev/null 2>&1 || sudo systemctl start docker >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
docker info >/dev/null 2>&1 || {
  echo "Docker daemon did not start" >&2
  exit 1
}

[ -f .env ] || cp .env.example .env

docker compose up -d postgres gotenberg

pg_ready() {
  docker compose exec -T postgres \
    pg_isready -U "${POSTGRES_ADMIN_USER:-auto_mb_owner}" -d "${POSTGRES_DB:-auto_mb}" >/dev/null 2>&1
}

for _ in $(seq 1 60); do
  pg_ready && break
  sleep 1
done
pg_ready || {
  echo "PostgreSQL did not become ready" >&2
  exit 1
}

DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:-postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb}" \
  pnpm db:migrate
