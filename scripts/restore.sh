#!/usr/bin/env bash
# Restores a backup produced by scripts/backup.sh. The target database must
# be EMPTY (freshly created); the object directory is created if missing.
# The manifest is verified before anything is touched. A restore drill on a
# disposable database is part of the operations calendar
# (docs/OPERATIONS.md) — a backup that has never been restored is a hope,
# not a backup.
#
# Encrypted backups need the RSA PRIVATE key, which deliberately does not
# live on the production host (docs/RUNBOOK.md §4a): point
# BACKUP_ENCRYPTION_PRIVATE_KEY at it on the recovery machine.
set -euo pipefail

backup_dir="${1:?usage: restore.sh <backup-directory>}"
: "${RESTORE_DATABASE_URL:?set RESTORE_DATABASE_URL (an empty database)}"
: "${RESTORE_OBJECT_STORAGE_DIR:?set RESTORE_OBJECT_STORAGE_DIR}"
BACKUP_ENCRYPTION_PRIVATE_KEY="${BACKUP_ENCRYPTION_PRIVATE_KEY:-}"
# Where the recovered AUTH_SECRET and database passwords are written when
# the backup carries them. Restoring a database without its AUTH_SECRET
# leaves every stored TOTP secret and backup code undecryptable, which
# locks every privileged user out of an MFA-enforcing deployment.
RESTORE_SECRETS_OUT="${RESTORE_SECRETS_OUT:-}"
# Scratch space for the DECRYPTED dump and object archive. The default is
# the system temp directory, which on many hosts is a small tmpfs; point
# this at a volume with room for a full plaintext copy of the backup, and
# at one whose permissions you are willing to hold that copy under. The
# directory is created fresh and removed on exit, successful or not.
RESTORE_WORK_DIR="${RESTORE_WORK_DIR:-${TMPDIR:-/tmp}}"

# Integrity first, over the bytes as stored: an encrypted backup is checked
# before it is decrypted, so a truncated or tampered artefact is caught
# without a key being involved at all.
( cd "${backup_dir}" && sha256sum --check --quiet SHA256SUMS )

if [ -r "${backup_dir}/MANIFEST" ]; then
  echo "=== backup manifest ==="
  cat "${backup_dir}/MANIFEST"
  echo "======================="
fi

work="$(mktemp -d "${RESTORE_WORK_DIR%/}/auto-mb-restore.XXXXXX")"
chmod 700 "${work}"
cleanup() { rm -rf "${work}"; }
trap cleanup EXIT

if [ -f "${backup_dir}/database.dump.enc" ]; then
  if [ -z "${BACKUP_ENCRYPTION_PRIVATE_KEY}" ]; then
    echo "this backup is encrypted; set BACKUP_ENCRYPTION_PRIVATE_KEY to the" >&2
    echo "RSA private key that matches the public key it was sealed to" >&2
    echo "(docs/RUNBOOK.md 4a)." >&2
    exit 1
  fi
  data_key="${work}/data-key"
  ( umask 077
    openssl pkeyutl -decrypt -inkey "${BACKUP_ENCRYPTION_PRIVATE_KEY}" \
      -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 \
      -in "${backup_dir}/data-key.enc" -out "${data_key}" )
  unseal() {
    openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter 600000 \
      -pass "file:${data_key}" -in "$1" -out "$2"
  }
  ( umask 077
    unseal "${backup_dir}/database.dump.enc" "${work}/database.dump"
    unseal "${backup_dir}/objects.tar.gz.enc" "${work}/objects.tar.gz" )
  dump="${work}/database.dump"
  objects="${work}/objects.tar.gz"
  secrets_source="${backup_dir}/secrets.env.enc"
else
  dump="${backup_dir}/database.dump"
  objects="${backup_dir}/objects.tar.gz"
  secrets_source="${backup_dir}/secrets.env"
fi

pg_restore --no-owner --dbname "${RESTORE_DATABASE_URL}" "${dump}"

mkdir -p "${RESTORE_OBJECT_STORAGE_DIR}"
tar -xzf "${objects}" -C "${RESTORE_OBJECT_STORAGE_DIR}"

if [ -f "${secrets_source}" ]; then
  if [ -z "${RESTORE_SECRETS_OUT}" ]; then
    echo "this backup carries the recovery secrets (AUTH_SECRET and the" >&2
    echo "database passwords). Set RESTORE_SECRETS_OUT to the path they" >&2
    echo "should be written to, then re-run; nothing else has to be redone." >&2
  else
    ( umask 077
      if [ "${secrets_source}" = "${backup_dir}/secrets.env.enc" ]; then
        unseal "${secrets_source}" "${RESTORE_SECRETS_OUT}"
      else
        cp "${secrets_source}" "${RESTORE_SECRETS_OUT}"
      fi )
    chmod 600 "${RESTORE_SECRETS_OUT}"
    echo "recovery secrets written to ${RESTORE_SECRETS_OUT} (mode 0600)"
    echo "AUTH_SECRET from that file must be the one the restored"
    echo "deployment runs with, or every stored TOTP secret and backup"
    echo "code becomes undecryptable (docs/RUNBOOK.md 7a)."
  fi
fi

echo "restore complete"
