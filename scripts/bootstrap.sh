#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example; replace local placeholder secrets before shared use."
fi

# Export configuration before anything reads it (db:migrate requires
# DATABASE_ADMIN_URL from the process environment).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm install --frozen-lockfile

docker compose up -d postgres gotenberg
pnpm db:migrate

echo "Bootstrap complete. Run: pnpm dev"
