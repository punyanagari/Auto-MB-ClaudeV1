#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example; replace local placeholder secrets before shared use."
fi

corepack enable
pnpm install

docker compose up -d postgres gotenberg
pnpm db:migrate

echo "Bootstrap complete. Run: pnpm dev"
