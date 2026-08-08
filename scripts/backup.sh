#!/usr/bin/env bash
# Auto-MB backup: a PostgreSQL custom-format dump plus the object store,
# sealed with a SHA-256 manifest. Run from cron on the production host
# (docs/OPERATIONS.md); restore with scripts/restore.sh.
set -euo pipefail

: "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL}"
: "${OBJECT_STORAGE_DIR:?set OBJECT_STORAGE_DIR}"
BACKUP_ROOT="${BACKUP_ROOT:-./backups}"

if [ ! -d "${OBJECT_STORAGE_DIR}" ]; then
  echo "object storage directory ${OBJECT_STORAGE_DIR} does not exist" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${BACKUP_ROOT}/${stamp}"
mkdir -p "${dest}"

pg_dump --format=custom --no-owner --file "${dest}/database.dump" "${DATABASE_ADMIN_URL}"
tar -czf "${dest}/objects.tar.gz" -C "${OBJECT_STORAGE_DIR}" .
(cd "${dest}" && sha256sum database.dump objects.tar.gz > SHA256SUMS)

echo "backup written to ${dest}"
