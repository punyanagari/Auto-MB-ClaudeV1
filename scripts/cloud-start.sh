#!/usr/bin/env bash
# Cloud-agent environment start: runs on every agent boot. Brings up Docker,
# PostgreSQL, and Gotenberg, then applies migrations so agents can run
# `pnpm verify` and the dev servers immediately. Must stay idempotent.
set -euo pipefail

# Configuration comes from .env alone: create it when absent and export it
# so readiness checks, migrations, and everything below see the same values
# the managed dev terminal uses.
[ -f .env ] || cp .env.example .env
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Just-in-time boots (no build snapshot) land on base VMs without Docker or
# with docker but no Compose plugin; snapshot-backed boots already carry
# both from cloud-install.sh.
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker or the Compose plugin missing from this VM; installing"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2
fi

# The agent user is not guaranteed docker-group membership, so every docker
# invocation here goes through sudo.
if ! sudo docker info >/dev/null 2>&1; then
  # These VMs are containerized without systemd (PID 1 is tini), so the
  # daemon is launched directly. The vfs storage driver is required: nested
  # overlayfs cannot create whiteout nodes, which breaks extraction of some
  # images (verified with gotenberg:8) while letting others through.
  sudo install -d -m 0755 /etc/docker
  printf '{"storage-driver":"vfs"}\n' | sudo tee /etc/docker/daemon.json >/dev/null
  sudo sh -c 'nohup dockerd >/var/log/dockerd.log 2>&1 &'
  for _ in $(seq 1 60); do
    sudo docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
sudo docker info >/dev/null 2>&1 || {
  echo "Docker daemon did not start; see /var/log/dockerd.log" >&2
  exit 1
}

sudo docker compose up -d postgres gotenberg

pg_ready() {
  sudo docker compose exec -T postgres \
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

# DATABASE_ADMIN_URL was exported from .env above; the fallback only covers
# a hand-stripped .env.
DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:-postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb}" \
  pnpm db:migrate
