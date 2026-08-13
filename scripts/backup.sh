#!/usr/bin/env bash
# Auto-MB backup: a PostgreSQL custom-format dump, the object store, and
# — where configured — the secrets without which a restored database is
# not a working deployment. Sealed with a SHA-256 manifest, optionally
# public-key encrypted, optionally copied off the host. Run from cron on
# the production host (docs/RUNBOOK.md §4); restore with
# scripts/restore.sh.
#
# What this script does NOT do, so nothing downstream claims it: no
# point-in-time recovery (there is no WAL archive), no pruning of old
# backup directories (the cron in docs/RUNBOOK.md §4 does that), and no
# object-storage versioning.
set -euo pipefail

: "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL}"
: "${OBJECT_STORAGE_DIR:?set OBJECT_STORAGE_DIR}"
BACKUP_ROOT="${BACKUP_ROOT:-./backups}"
# Where the last-success marker lives. Defaults into BACKUP_ROOT; production
# points it at a dedicated directory that the server container mounts
# read-only, so the app never sees the dumps themselves (docs/RUNBOOK.md §4).
BACKUP_MARKER_DIR="${BACKUP_MARKER_DIR:-${BACKUP_ROOT}}"

# --- encryption --------------------------------------------------------
# Envelope encryption. A fresh random data key encrypts the artefacts with
# AES-256; the data key itself is encrypted to an RSA public key. Only the
# PUBLIC half ever lives on the production host, so a host compromise
# yields no readable backup and the host cannot decrypt its own history.
# Key generation, storage and rotation: docs/RUNBOOK.md §4a.
BACKUP_ENCRYPTION_PUBLIC_KEY="${BACKUP_ENCRYPTION_PUBLIC_KEY:-}"
# Set to a non-empty value other than 0 to make a missing public key a hard
# failure. Production sets it (docs/RUNBOOK.md §4); the repository's own
# backup/restore proof runs without it and is the reason the default is
# permissive rather than the reason encryption is optional.
BACKUP_REQUIRE_ENCRYPTION="${BACKUP_REQUIRE_ENCRYPTION:-}"
# An env-shaped file (typically deploy/.env.production) carrying AUTH_SECRET
# and the database passwords. A restored database whose AUTH_SECRET is lost
# cannot decrypt any stored TOTP secret or backup code, so every privileged
# user is locked out of an MFA-enforcing deployment with no in-app recovery
# path. Included ONLY when encryption is on; never written in the clear.
BACKUP_SECRETS_FILE="${BACKUP_SECRETS_FILE:-}"
# A command line that receives the finished backup directory as its single
# argument, e.g. `rclone --config /etc/rclone.conf copy` or
# `aws s3 sync --sse AES256`. The marker below is published only if it
# succeeds, so "verified backup" means "verified and off this host".
BACKUP_OFFHOST_COMMAND="${BACKUP_OFFHOST_COMMAND:-}"

encrypting=no
if [ -n "${BACKUP_ENCRYPTION_PUBLIC_KEY}" ]; then
  if [ ! -r "${BACKUP_ENCRYPTION_PUBLIC_KEY}" ]; then
    echo "BACKUP_ENCRYPTION_PUBLIC_KEY ${BACKUP_ENCRYPTION_PUBLIC_KEY} is not readable" >&2
    exit 1
  fi
  encrypting=yes
elif [ -n "${BACKUP_REQUIRE_ENCRYPTION}" ] && [ "${BACKUP_REQUIRE_ENCRYPTION}" != "0" ]; then
  echo "BACKUP_REQUIRE_ENCRYPTION is set but BACKUP_ENCRYPTION_PUBLIC_KEY is not" >&2
  echo "Refusing to write an unencrypted backup (docs/RUNBOOK.md 4a)." >&2
  exit 1
fi

if [ "${encrypting}" = "no" ] && [ -n "${BACKUP_SECRETS_FILE}" ]; then
  echo "BACKUP_SECRETS_FILE is set but encryption is not configured." >&2
  echo "AUTH_SECRET and the database passwords are never written in the clear." >&2
  exit 1
fi

if [ ! -d "${OBJECT_STORAGE_DIR}" ]; then
  echo "object storage directory ${OBJECT_STORAGE_DIR} does not exist" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${BACKUP_ROOT}/${stamp}"
mkdir -p "${dest}"

# Scratch space for the plaintext data key and the object member list.
# Deliberately inside BACKUP_ROOT rather than the system temp directory:
# BACKUP_ROOT is already the operator-owned, non-world-readable directory
# this deployment keeps dumps in, whereas /tmp is shared with every other
# process on the host. Removed on exit, successful or not.
work="$(mktemp -d "${BACKUP_ROOT}/.work.XXXXXX")"
chmod 700 "${work}"
cleanup() { rm -rf "${work}"; }
trap cleanup EXIT

suffix=''
if [ "${encrypting}" = "yes" ]; then
  suffix='.enc'
  data_key="${work}/data-key"
  # 48 random bytes, base64 on one line: `openssl enc -pass file:` reads
  # the first line, so both halves of the round trip see the same bytes.
  ( umask 077; openssl rand -base64 48 > "${data_key}" )
  # RSA-OAEP/SHA-256 rather than the PKCS#1 v1.5 default.
  openssl pkeyutl -encrypt -pubin -inkey "${BACKUP_ENCRYPTION_PUBLIC_KEY}" \
    -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 \
    -in "${data_key}" -out "${dest}/data-key${suffix}"
fi

# Reads a stream on stdin and writes the artefact, encrypting on the way
# through when configured. Nothing plaintext is ever written to
# BACKUP_ROOT: pg_dump and tar both stream straight into the cipher.
seal() {
  if [ "${encrypting}" = "yes" ]; then
    openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 600000 -salt \
      -pass "file:${data_key}" -out "$1"
  else
    cat > "$1"
  fi
}

# --- consistency between the two snapshots (finding 33) ----------------
# The dump and the object archive are taken at different instants, and
# nothing established that the pair could be restored together. Ordering
# and an explicit member list now make the pair provably consistent:
#
#   1. the dump is taken FIRST, so it can only reference objects that
#      already existed when it started — the object store is written
#      before the referencing row commits, and there is no delete path
#      (docs/OPERATIONS.md §5);
#   2. the object store is enumerated AFTER the dump, which therefore
#      yields a superset of everything the dump can reference;
#   3. the archive is built from EXACTLY that list rather than from a
#      second, later walk of the tree. tar fails if any listed member has
#      vanished, so the one way step 2's reasoning could break — an object
#      disappearing mid-backup — abandons the backup instead of
#      certifying an unrestorable pair.
#
# Members archived beyond the dump's reach are orphan files a restore
# simply ignores; a dangling reference, the direction that actually breaks
# a restore, is no longer possible.
database_snapshot_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
pg_dump --format=custom --no-owner "${DATABASE_ADMIN_URL}" \
  | seal "${dest}/database.dump${suffix}"

objects_snapshot_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Directories included, so the list is never empty (tar refuses to build an
# empty archive) and the restored tree keeps its shape.
#
# The store's atomic writes go to `.put-<uuid>.tmp` in the destination
# directory and are then renamed onto the key (apps/server/src/storage.ts).
# Those names are the one thing here that legitimately disappears, and no
# object key can ever resolve to one, so they are excluded — otherwise a
# concurrent upload completing between the enumeration and the archive
# would abort a perfectly good backup.
( cd "${OBJECT_STORAGE_DIR}" && find . -name '.put-*.tmp' -prune -o -print \
    | LC_ALL=C sort ) > "${work}/objects.members"
if ! tar -czf - -C "${OBJECT_STORAGE_DIR}" --no-recursion \
  -T "${work}/objects.members" | seal "${dest}/objects.tar.gz${suffix}"; then
  echo "the object store changed under the archive; the dump and the" >&2
  echo "archive are not a restorable pair, so this backup is abandoned" >&2
  exit 1
fi

if [ -n "${BACKUP_SECRETS_FILE}" ]; then
  if [ ! -r "${BACKUP_SECRETS_FILE}" ]; then
    echo "BACKUP_SECRETS_FILE ${BACKUP_SECRETS_FILE} is not readable" >&2
    exit 1
  fi
  seal "${dest}/secrets.env${suffix}" < "${BACKUP_SECRETS_FILE}"
fi

# Machine-readable statement of what this directory is, so a restore three
# years from now does not have to infer it from file names.
{
  echo "backup_format=1"
  echo "created_utc=${stamp}"
  echo "database_snapshot_utc=${database_snapshot_utc}"
  echo "objects_snapshot_utc=${objects_snapshot_utc}"
  echo "objects_consistency=enumerated-after-dump"
  echo "encryption=$([ "${encrypting}" = yes ] && echo rsa-oaep-sha256+aes-256-cbc || echo none)"
  echo "secrets_included=$([ -n "${BACKUP_SECRETS_FILE}" ] && echo yes || echo no)"
  echo "offhost_copy=$([ -n "${BACKUP_OFFHOST_COMMAND}" ] && echo configured || echo none)"
} > "${dest}/MANIFEST"

# The checksums cover the bytes as stored — ciphertext where encrypted —
# so restore.sh can prove integrity before it decrypts anything.
artefacts=("database.dump${suffix}" "objects.tar.gz${suffix}" MANIFEST)
if [ "${encrypting}" = "yes" ]; then artefacts+=("data-key${suffix}"); fi
if [ -n "${BACKUP_SECRETS_FILE}" ]; then artefacts+=("secrets.env${suffix}"); fi
( cd "${dest}" && sha256sum "${artefacts[@]}" > SHA256SUMS )
# Re-verify the manifest against the files on disk: the marker below must
# only ever certify a backup that would pass restore.sh's own check.
( cd "${dest}" && sha256sum --check --quiet SHA256SUMS )

if [ "${encrypting}" = "no" ]; then
  echo "WARNING: this backup is NOT encrypted." >&2
  echo "WARNING: it holds customer documents and a full database dump in the clear." >&2
  echo "WARNING: set BACKUP_ENCRYPTION_PUBLIC_KEY (docs/RUNBOOK.md 4a)." >&2
fi

# Off-host copy, before the marker: a backup that exists only on the host
# it protects does not survive the failure it exists for. The command is
# run with the backup directory as its single, quoted argument.
if [ -n "${BACKUP_OFFHOST_COMMAND}" ]; then
  if ! sh -c "${BACKUP_OFFHOST_COMMAND} \"\$1\"" sh "${dest}"; then
    echo "off-host copy failed; the last-success marker was NOT updated" >&2
    exit 1
  fi
  echo "off-host copy complete"
fi

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
