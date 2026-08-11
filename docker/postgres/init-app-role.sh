#!/usr/bin/env sh
set -eu

if [ -z "${AUTO_MB_APP_DB_PASSWORD:-}" ]; then
  echo "AUTO_MB_APP_DB_PASSWORD is required" >&2
  exit 1
fi

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$AUTO_MB_APP_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE auto_mb_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app')
\gexec
SQL
