#!/usr/bin/env bash
set -euo pipefail

# The LOA and contract-source extraction paths invoke `pdftotext` directly
# (docs/DEPENDENCIES.md). A missing binary surfaces late and confusingly —
# as rejected uploads at runtime and ENOENT failures in the server suite —
# so refuse to bootstrap an environment that cannot run them.
if ! command -v pdftotext >/dev/null 2>&1; then
  echo "pdftotext not found: install poppler-utils (Debian/Ubuntu: apt-get install poppler-utils; macOS: brew install poppler)." >&2
  exit 1
fi

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
