#!/usr/bin/env bash
# Restores a backup produced by scripts/backup.sh. The target database must
# be EMPTY (freshly created); the object directory is created if missing.
# The manifest is verified before anything is touched. A restore drill on a
# disposable database is part of the operations calendar
# (docs/OPERATIONS.md) — a backup that has never been restored is a hope,
# not a backup.
set -euo pipefail

backup_dir="${1:?usage: restore.sh <backup-directory>}"
: "${RESTORE_DATABASE_URL:?set RESTORE_DATABASE_URL (an empty database)}"
: "${RESTORE_OBJECT_STORAGE_DIR:?set RESTORE_OBJECT_STORAGE_DIR}"

(cd "${backup_dir}" && sha256sum --check --quiet SHA256SUMS)

pg_restore --no-owner --dbname "${RESTORE_DATABASE_URL}" "${backup_dir}/database.dump"

mkdir -p "${RESTORE_OBJECT_STORAGE_DIR}"
tar -xzf "${backup_dir}/objects.tar.gz" -C "${RESTORE_OBJECT_STORAGE_DIR}"

echo "restore complete"
