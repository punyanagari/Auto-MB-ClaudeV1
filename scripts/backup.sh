#!/usr/bin/env bash
# Auto-MB backup: a PostgreSQL custom-format dump plus the object store,
# sealed with a SHA-256 manifest. Run from cron on the production host
# (docs/OPERATIONS.md); restore with scripts/restore.sh.
set -euo pipefail

: "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL}"
: "${OBJECT_STORAGE_DIR:?set OBJECT_STORAGE_DIR}"
BACKUP_ROOT="${BACKUP_ROOT:-./backups}"
# Where the last-success marker lives. Defaults into BACKUP_ROOT; production
# points it at a dedicated directory that the server container mounts
# read-only, so the app never sees the dumps themselves (docs/RUNBOOK.md §4).
BACKUP_MARKER_DIR="${BACKUP_MARKER_DIR:-${BACKUP_ROOT}}"

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
# Re-verify the manifest against the files on disk: the marker below must
# only ever certify a backup that would pass restore.sh's own check.
(cd "${dest}" && sha256sum --check --quiet SHA256SUMS)

# Everything above succeeded (set -e), so publish the last-success marker:
# epoch seconds, written to a temp file and renamed into place so readers
# (the backup_last_success_timestamp_seconds gauge on /metrics) never see a
# partial write. Any earlier failure exits before this point and leaves the
# previous marker untouched.
mkdir -p "${BACKUP_MARKER_DIR}"
marker_tmp="$(mktemp "${BACKUP_MARKER_DIR}/.last-success.XXXXXX")"
date +%s > "${marker_tmp}"
mv -f "${marker_tmp}" "${BACKUP_MARKER_DIR}/last-success"

echo "backup written to ${dest}"
