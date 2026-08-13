# Pilot deployment and operations runbook

The concrete procedures for the design-partner pilot deployment. The
principles they implement live in docs/OPERATIONS.md; where the two ever
disagree, OPERATIONS.md wins and this file gets fixed.

The pilot runs on one production-like host in an India region
(data residency: docs/SECURITY.md), on the `deploy/docker-compose.prod.yml`
topology: Caddy (TLS, static web, API proxy) → server → PostgreSQL,
Gotenberg, ClamAV, with Prometheus and Alertmanager alongside. Every
service has a healthcheck, a memory and CPU limit, and rotated logs
(10 MB × 5 files); a `docker compose ps` therefore reports health, not
just "running".

## 1. Provisioning

- one VM in an India region (any major provider's Mumbai/Hyderabad
  region), Docker and the compose plugin installed. **4 vCPU / 8 GB /
  80 GB** for the full topology: ClamAV alone holds its signature
  database in memory and is capped at 2 GiB, and PostgreSQL, the API,
  Gotenberg and Prometheus have their own limits in
  `deploy/docker-compose.prod.yml`. The older 2 vCPU / 4 GB figure
  predates the scanner and the monitoring pair;
- a DNS A record for the chosen `SITE_ADDRESS` pointing at the VM;
- inbound 80/443 only; SSH by key; everything else closed. Prometheus and
  Alertmanager publish no ports at all and are reached over an SSH tunnel
  (§6);
- outbound open (Caddy's certificate issuance, ClamAV signature updates,
  and the Trivy vulnerability database the deploy's image scan downloads);
- three host directories, created once:

  ```bash
  sudo mkdir -p /var/lib/auto-mb/backup-status \
                /var/lib/auto-mb/prometheus/secrets \
                /var/lib/auto-mb/alertmanager/secrets
  ```

## 2. First deploy

```bash
git clone https://github.com/punyanagari/Auto-MB-ClaudeV1 && cd Auto-MB-ClaudeV1
cp deploy/.env.production.example deploy/.env.production   # fill in real values
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build

# one-time: application role + schema migrations (admin credentials stay
# on the host, never in the app container's environment)
# DATABASE_ADMIN_URL is the owner connection string: user auto_mb_owner,
# the POSTGRES_PASSWORD from .env.production, host postgres, db auto_mb.
# The image ships compiled JavaScript and production dependencies only, so
# the bootstrap is a node entry point — there is no pnpm or tsx inside it.
docker compose -f deploy/docker-compose.prod.yml exec \
  -e DATABASE_ADMIN_URL="<owner connection string>" \
  -e AUTO_MB_APP_DB_PASSWORD="<AUTO_MB_APP_DB_PASSWORD>" \
  -e DATABASE_URL="<application connection string>" \
  server node apps/server/dist/bootstrap.mjs

# the metrics token, as a file, for Prometheus (§6). Prometheus does not
# expand environment variables in its configuration, so the token is
# mounted rather than templated.
printf '%s' '<METRICS_TOKEN from .env.production>' \
  | sudo tee /var/lib/auto-mb/prometheus/secrets/metrics-token >/dev/null
sudo chmod 0644 /var/lib/auto-mb/prometheus/secrets/metrics-token
docker compose -f deploy/docker-compose.prod.yml restart prometheus
```

Verify: `https://<SITE_ADDRESS>/api/ready` answers `200`, sign-up works,
and ClamAV is active (upload the EICAR test file — it must be rejected
with `MALWARE_DETECTED`; give the clamav container a few minutes on first
boot to download signatures).

`/api/ready` answers `503` with `"reason":"schema-migrations-behind"` until
the bootstrap above has run: the server compares the applied-migration
ledger with the migrations its own image carries and refuses traffic when
the image is ahead of the database. A ledger _ahead_ of the image is the
rollback posture (§3) and stays ready. Also check
`docker compose -f deploy/docker-compose.prod.yml ps` — every service
should read `healthy`, ClamAV last, after its first signature download.

## 2a. Deploy secrets and host-key rotation

`.github/workflows/deploy.yml` needs three repository secrets
(Settings → Secrets and variables → Actions). With none of them set the
workflow skips; with `DEPLOY_HOST`/`DEPLOY_SSH_KEY` set but no
`DEPLOY_HOST_KEY` it FAILS rather than falling back to `ssh-keyscan`.

| Secret            | What it holds                                         |
| ----------------- | ----------------------------------------------------- |
| `DEPLOY_HOST`     | the host's public IP (the Elastic IP)                 |
| `DEPLOY_SSH_KEY`  | the deploy private key (verbatim PEM or base64 of it) |
| `DEPLOY_HOST_KEY` | the host's PUBLIC `known_hosts` line(s), pinned       |

**Capturing the pin (once, and after any host rebuild).** Take it from
the host itself over a channel you already trust — the provider's serial
console, or an SSH session whose fingerprint you have already verified —
never from a `ssh-keyscan` you cannot authenticate:

```bash
# ON THE HOST:
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub     # note the SHA256 fingerprint
awk '{print "<DEPLOY_HOST-ip> " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

Paste that one line into `DEPLOY_HOST_KEY`. To confirm from a workstation
before saving it, run `ssh-keyscan <ip> | ssh-keygen -lf -` and check the
fingerprint equals the one printed on the host — comparing, not trusting.

**Rotation.** Rotate the host key when the VM is rebuilt or restored from
an image, when the deploy key is rotated as part of an incident, and
whenever the host key may have been exposed:

1. On the host: `sudo rm /etc/ssh/ssh_host_*_key*` then
   `sudo ssh-keygen -A` and `sudo systemctl restart ssh`. Existing SSH
   sessions survive; new ones will warn until step 2.
2. Re-capture the fingerprint and the `known_hosts` line as above and
   update the `DEPLOY_HOST_KEY` secret.
3. Remove the stale entry from any operator workstation:
   `ssh-keygen -R <ip>`.
4. Run the deploy workflow. A mismatch is a hard failure at the SSH step
   (`StrictHostKeyChecking yes`) — a failed deploy here means the pin and
   the host disagree, which is either an incomplete rotation or an
   attacker; treat it as the latter until proven otherwise.

Record every rotation in the ops log with the new fingerprint.

### Optional Whitebooks transport

Whitebooks is disabled by default. Enable it first in sandbox by setting
`WHITEBOOKS_ENABLED=true` and supplying the e-invoice email, username,
password, client id, client secret, authorised public IP, exact GSTIN, IRP, and
timeout values from the deployment secret store. The process supports exactly
that configured GSTIN and refuses every mismatch.

`WHITEBOOKS_EWAY_CLIENT_ID` and `WHITEBOOKS_EWAY_CLIENT_SECRET` are a separate
pair used only by standalone EWB cancellation and must be supplied together.
Do not reuse or substitute the e-invoice pair. Keep EWB cancellation disabled
when the separate pair is unavailable.

Do not enable production transport until sandbox requests, IP allowlisting,
credential rotation, redacted failure handling, unknown-outcome recovery, and
provider-specific monitoring have been reviewed. Fresh EWB generation remains
blocked for every invoice, cumulative or itemised, until the applicability
decision follows from the document's own goods lines and a dispatch model
exists to carry it.

## 3. Upgrades

The supported path is the **Deploy** workflow (Actions → Deploy → Run
workflow), which enforces the ordering the operations contract requires:
it refuses a commit with no successful CI run, connects over the pinned
host key, builds images, **scans them with Trivy and stops if a fixable
HIGH/CRITICAL vulnerability is present**, runs migrations to completion
while the OLD containers keep serving, recreates the app containers only
after the migration succeeds, and rolls back automatically unless
`/api/ready` answers ready with all four components `ok`. Read the job
log: it prints the state before the deploy, the commit being served, and —
on failure — both the failed state and the restored one.

A scan failure is a release decision, not a deploy bug. Either take the
fix (usually a base-image digest bump, which Renovate raises) or record
the acceptance in `deploy/.trivyignore` with who accepted it and why. To
see the findings without deploying, run the scan by hand on the host:

```bash
cd /opt/auto-mb && bash scripts/scan-images.sh
```

Manual upgrade on the host, for when Actions is unavailable, in the same
order (never `up -d --build` first: that serves new code against an
un-migrated schema):

```bash
cd /opt/auto-mb && git pull
COMPOSE="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production"
docker inspect --format '{{.Image}}' "$($COMPOSE ps -q server)"   # note this, for rollback
$COMPOSE build                       # build only; nothing is recreated yet
bash scripts/scan-images.sh           # stop here if it fails
$COMPOSE up -d --wait postgres
set -a; . deploy/.env.production; set +a
$COMPOSE run --rm --no-deps -T \
  -e DATABASE_ADMIN_URL="postgres://auto_mb_owner:${POSTGRES_PASSWORD}@postgres:5432/auto_mb" \
  -e AUTO_MB_APP_DB_PASSWORD="${AUTO_MB_APP_DB_PASSWORD}" \
  -e DATABASE_URL="postgres://auto_mb_app:${AUTO_MB_APP_DB_PASSWORD}@postgres:5432/auto_mb" \
  server node apps/server/dist/bootstrap.mjs    # migrations to completion
$COMPOSE up -d                       # only now recreate the app containers
curl -fsSk --resolve "${SITE_ADDRESS}:443:127.0.0.1" "https://${SITE_ADDRESS}/api/ready"
```

To roll back manually, retag the noted image id and recreate without
building — migrations are forward-only and stay applied:

```bash
docker tag <noted-image-id> auto-mb-prod-server:latest
$COMPOSE up -d --no-build --force-recreate
```

Migrations are additive and advisory-lock-guarded (packages/db); a
concurrent double-run is harmless.

## 4. Backups

Nightly cron on the host, not inside a container. Two lines: the backup
itself, and the operator's own pruning — `scripts/backup.sh` never deletes
anything, so retention is exactly what this cron says it is.

```cron
30 21 * * * cd /opt/auto-mb && DATABASE_ADMIN_URL=... OBJECT_STORAGE_DIR=/var/lib/docker/volumes/auto-mb-prod_objects/_data BACKUP_ROOT=/backup BACKUP_MARKER_DIR=/var/lib/auto-mb/backup-status BACKUP_ENCRYPTION_PUBLIC_KEY=/etc/auto-mb/backup/backup-public.pem BACKUP_REQUIRE_ENCRYPTION=1 BACKUP_SECRETS_FILE=/opt/auto-mb/deploy/.env.production BACKUP_OFFHOST_COMMAND='rclone --config /etc/auto-mb/rclone.conf copy' ./scripts/backup.sh >> /var/log/auto-mb-backup.log 2>&1
15 23 * * * find /backup -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```

One run writes one dated directory under `BACKUP_ROOT`:

| File             | What it is                                                        |
| ---------------- | ----------------------------------------------------------------- |
| `database.dump`  | custom-format `pg_dump`                                           |
| `objects.tar.gz` | the object store                                                  |
| `secrets.env`    | the recovery secrets, when `BACKUP_SECRETS_FILE` is set           |
| `data-key.enc`   | the AES data key, sealed to the RSA public key (encrypted runs)   |
| `MANIFEST`       | format, both snapshot times, encryption, secrets, off-host status |
| `SHA256SUMS`     | checksums over the bytes as stored, re-verified before success    |

With encryption configured every artefact gains a `.enc` suffix and is
written as ciphertext — `pg_dump` and `tar` stream straight into the
cipher, so no plaintext copy ever exists in `BACKUP_ROOT`.

The **last-success marker** (`${BACKUP_MARKER_DIR}/last-success`, epoch
seconds, temp file + atomic rename) is written only after the dump, the
archive, the recovery secrets, the manifest re-verification **and the
off-host copy** have all succeeded; any failure exits first and leaves the
previous marker untouched. `BACKUP_MARKER_DIR` defaults to `BACKUP_ROOT`;
production points it at `/var/lib/auto-mb/backup-status`, which
`deploy/docker-compose.prod.yml` mounts read-only into the server
container so `/metrics` can expose the
`backup_last_success_timestamp_seconds` gauge (§6) without ever exposing
the dumps themselves to the app container.

**Configuration reference** (`scripts/backup.sh`):

| Variable                       | Effect                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `DATABASE_ADMIN_URL`           | required; the owner connection string                                           |
| `OBJECT_STORAGE_DIR`           | required; the object-store volume's host path                                   |
| `BACKUP_ROOT`                  | where dated directories are written (default `./backups`)                       |
| `BACKUP_MARKER_DIR`            | where the freshness marker is written (default `BACKUP_ROOT`)                   |
| `BACKUP_ENCRYPTION_PUBLIC_KEY` | PEM RSA public key; its presence is what turns encryption on                    |
| `BACKUP_REQUIRE_ENCRYPTION`    | non-empty and not `0` → a missing public key is a hard failure                  |
| `BACKUP_SECRETS_FILE`          | env file carrying `AUTH_SECRET`; refused unless encryption is on                |
| `BACKUP_OFFHOST_COMMAND`       | command line receiving the finished directory as its one argument; must succeed |

**Off-host destination — owner decision.** The mechanism is implemented
and gated; the target is not chosen. The command above is an example, not
a configured account. Pick object storage in a different provider account
and region (India, per docs/SECURITY.md), give it write-and-list but not
delete for the host's credential, and put the real command in the cron
line. Until then the backups live only on the VM they protect, which is
the failure the off-host copy exists for.

**Not implemented, so not claimed:** point-in-time recovery — there is no
WAL archive, and the recovery point is therefore the last nightly run
(RPO 24 h). RTO has not been measured. Object-storage versioning does not
exist. `scripts/backup.sh` prunes nothing.

## 4a. Backup encryption keys

Envelope encryption: each run generates a random AES-256 data key, seals
the artefacts with it, and seals the data key itself to an RSA public key
(OAEP/SHA-256). The consequence that matters operationally is that **the
production host holds only the public half and cannot read its own
backups** — an attacker who takes the host takes ciphertext.

**Generate the pair OFF the production host**, on an operator workstation
or an air-gapped machine:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  -out auto-mb-backup-private.pem
chmod 600 auto-mb-backup-private.pem
openssl pkey -in auto-mb-backup-private.pem -pubout \
  -out auto-mb-backup-public.pem
openssl pkey -in auto-mb-backup-public.pem -pubin -noout -text | head -1
```

**Where each half lives.**

- _Public key_ → the production host at
  `/etc/auto-mb/backup/backup-public.pem`, mode `0644`, root-owned. It is
  not a secret; it is referenced by `BACKUP_ENCRYPTION_PUBLIC_KEY` in the
  cron line above.
- _Private key_ → **never on the production host, never in this
  repository, never in GitHub secrets.** Two copies: one in the
  organisation's password manager as a secure note or attachment, one on
  encrypted offline media held by the owner. Record the public key's
  fingerprint alongside both so a restore can confirm it holds the
  matching half before a real incident.

**Restoring** happens on a recovery machine, not the production host:
place the private key there temporarily, point
`BACKUP_ENCRYPTION_PRIVATE_KEY` at it, run `scripts/restore.sh` (§5), then
remove it. The script refuses an encrypted backup without the key rather
than failing halfway through a restore.

**Rotation.** Generate a new pair and install the new public key; nothing
else changes. Old backups still require the OLD private key, so retired
private keys are kept for as long as any backup they sealed is retained —
destroying a retired key destroys every backup taken under it. Rotate on
owner change, on suspected exposure of the private key, and otherwise
every two years. Record each rotation in the ops log with both
fingerprints and the date the old key may be destroyed.

**Losing the private key** means every encrypted backup is permanently
unreadable. That is the intended property, and it is why there are two
copies in two places.

## 5. Restore drill

A backup is not accepted until a restore has succeeded (OPERATIONS.md §5).
Monthly during the pilot, and after any schema-heavy release:

```bash
createdb auto_mb_drill
RESTORE_DATABASE_URL="<owner connection string for auto_mb_drill>" \
RESTORE_OBJECT_STORAGE_DIR=/tmp/drill-objects \
RESTORE_WORK_DIR=/var/tmp \
BACKUP_ENCRYPTION_PRIVATE_KEY=/path/to/auto-mb-backup-private.pem \
RESTORE_SECRETS_OUT=/root/recovered.env \
  ./scripts/restore.sh /backup/<latest>
# verify: row counts vs production, open one restored PDF; confirm the
# recovered AUTH_SECRET matches the one the deployment runs with; then
# shred /root/recovered.env and drop the drill db
```

`restore.sh` verifies `SHA256SUMS` over the stored bytes BEFORE it decrypts
anything, so a truncated or tampered artefact is caught without a key being
involved. Only `RESTORE_DATABASE_URL` and `RESTORE_OBJECT_STORAGE_DIR` are
required; the other three matter for encrypted backups:
`BACKUP_ENCRYPTION_PRIVATE_KEY` (§4a), `RESTORE_WORK_DIR` (scratch space
for the decrypted copy — the default system temp directory is often a
small tmpfs), and `RESTORE_SECRETS_OUT` (where the recovered `AUTH_SECRET`
and database passwords are written, mode `0600`).

**`AUTH_SECRET` is part of the restore, not an afterthought.** Better Auth
encrypts every stored TOTP secret and backup code with it. A database
restored under a different `AUTH_SECRET` comes back with second factors
that cannot be decrypted, and with `MFA_ENFORCE=true` that is every
privilege holder locked out, each needing the §7a operator reset
individually. Restore the secret with the data.

Record date, backup used, and outcome in the ops log. Both flows are
proven automatically:
`packages/db/test/backup-restore.integration.test.ts` (the plain
round trip) and `packages/db/test/backup-encryption.integration.test.ts`
(encryption, the recovery set, and the off-host gate).

**Disaster recovery onto a FRESH cluster** (the real disaster shape: the
whole PostgreSQL instance is gone, so `auto_mb_app` and `auto_mb_definer`
do not exist and the dump's ACLs reference absent roles). The order
matters:

```bash
# 1. Roles first — they are cluster-level and never travel in the dump.
DATABASE_ADMIN_URL="<owner connection string on the new cluster>" \
AUTO_MB_APP_DB_PASSWORD="<application password>" \
  pnpm --filter @auto-mb/db exec tsx src/bootstrap.ts --roles-only

# 2. The restore itself (empty auto_mb database on the new cluster).
RESTORE_DATABASE_URL=... RESTORE_OBJECT_STORAGE_DIR=... \
  ./scripts/restore.sh /backup/<latest>

# 3. Full bootstrap: reapplies the grant matrix and repairs the
#    SECURITY DEFINER function ownership that pg_restore --no-owner
#    cannot carry over, then proves an application-role query.
DATABASE_ADMIN_URL=... AUTO_MB_APP_DB_PASSWORD=... DATABASE_URL=... \
  pnpm --filter @auto-mb/db bootstrap
```

CI proves this whole sequence on every change: the `restore-fresh-cluster`
job restores a scripted backup onto a brand-new PostgreSQL 17 container
and requires the application role to connect afterwards.

## 6. Monitoring and alerts

Prometheus and Alertmanager run in the compose stack. The scrape config is
`deploy/prometheus/prometheus.yml`, the rules are
`deploy/prometheus/alert_rules.yml`, and the routing is
`deploy/alertmanager/alertmanager.yml` — all three committed, so a rule
change is a reviewed diff rather than a hand edit on the host.

- **uptime**: an external monitor probing `https://<SITE_ADDRESS>/api/ready`
  every minute; alert on two consecutive failures. This is the one signal
  that must come from outside the host, because it is the one that has to
  survive the host;
- **metrics**: `GET /metrics` (Prometheus text format) with
  `Authorization: Bearer <METRICS_TOKEN>`. Caddy refuses `/metrics`
  publicly; Prometheus scrapes `server:3000` on the private compose
  network every 30 s, reading the token from
  `/var/lib/auto-mb/prometheus/secrets/metrics-token` (§2). Rotating
  `METRICS_TOKEN` means rewriting that file and restarting both `server`
  and `prometheus`;
- **retention**: 15 days or 4 GB, whichever comes first. Metrics older
  than a fortnight have never been needed to answer an incident, and the
  pilot disk is finite;
- **the rules themselves**: `ApiDown`, `ApiErrorRateHigh` (>1% 5xx over
  5 min), `ApiLatencyHigh` (p95 >2 s), `BackupStale` (>26 h — the nightly
  cron plus slack, i.e. one missed backup), `BackupMarkerAbsent`,
  `AccountLockout`, `AuthFailureSpike`, `TenantDenial`,
  `MalwareUploadDetected`, `MalwareScannerUnavailable`,
  `RateLimitRejectionSpike`, `DatabasePoolSaturated`, and
  `StatutoryProviderUnknownOutcome`. Every one is written against a series
  `apps/server/src/metrics.ts` actually exports (OPERATIONS.md §6 lists
  them); the thresholds are set for a 3–5 partner pilot and should be
  revisited when the partner count changes rather than silenced;
- **delivery — owner decision, currently unset.** Alertmanager's receiver
  holds and groups firing alerts and sends them nowhere. Choose email or a
  webhook, uncomment the matching block in
  `deploy/alertmanager/alertmanager.yml`, put the credential in
  `/var/lib/auto-mb/alertmanager/secrets/` (the file the config's
  `*_file` directive names), and redeploy. **Until that is done, nothing
  pages anyone**: the rules fire into a UI no one is watching, and the
  external uptime monitor is the only alert that reaches a human;
- **reaching the UIs**: neither service publishes a port. From a
  workstation, `ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093
<host>` after `docker compose ... port` — or more simply run
  `docker compose -f deploy/docker-compose.prod.yml exec prometheus
wget -qO- 'http://127.0.0.1:9090/api/v1/alerts'` on the host to read
  firing alerts without a tunnel at all;
- **disk**: alert at 80% on the VM (PostgreSQL volume + objects volume).
  Not yet a metric — there is no node exporter in the stack — so this
  stays a provider-side or cron-side alert;
- **logs**: the server logs structured JSON to stdout
  (`docker compose logs server`), capped at 10 MB × 5 files per service by
  the compose logging block, so a chatty week can no longer fill the disk.
  Review after every alert and weekly. Anything older than the rotation
  window is gone: there is no central log store.

## 7. Incident quick reference

Severities and obligations: OPERATIONS.md §7. The concrete first steps:

1. Acknowledge; note the time and the alert.
2. Triage: `/api/ready`, `docker compose ps`, server logs.
3. Mitigate: restart the affected service; if data corruption is
   suspected, STOP — take a filesystem snapshot before any restore.
4. If tenant data may be affected: `GET /api/export` (owner-scoped) for
   the affected organisation as an evidence snapshot.
5. Communicate to affected partners within 4 business hours; incidents
   touching their data get a written summary within 3 days.
6. Post-incident note in the ops log: cause, fix, prevention.

Security-relevant events (suspected breach, spiking malware-upload
rejections, auth anomalies in `identity_audit_events`) additionally follow
docs/SECURITY.md and India's CERT-In reporting expectations.

## 7a. Two-factor reset (operator recovery)

There is deliberately **no in-app reset endpoint**: an application path
that removes a second factor is exactly what an attacker who has stolen a
password needs, so recovery runs out-of-band over the same administrative
channel as migrations (host SSH, owner database credentials — §2), never
through the API.

When a user reports a lost authenticator AND exhausted backup codes:

1. **Verify identity out-of-band.** Call back on the phone number agreed
   at onboarding (§8) — never a number supplied in the request itself —
   and have the partner's owner confirm the request when the locked-out
   user is not the owner. Note the verification in the ops log.
2. **Reset on the host**, in one transaction, with the user's account
   email in place of the placeholder:

   ```sql
   BEGIN;
   DELETE FROM auth_two_factors
     WHERE "userId" = (SELECT "id" FROM auth_users WHERE "email" = '<email>');
   UPDATE auth_users SET "twoFactorEnabled" = false
     WHERE "email" = '<email>';
   DELETE FROM auth_sessions
     WHERE "userId" = (SELECT "id" FROM auth_users WHERE "email" = '<email>');
   INSERT INTO identity_audit_events (user_id, action, request_id, details)
     VALUES (
       (SELECT "id" FROM auth_users WHERE "email" = '<email>'),
       'two_factor_reset',
       'operator-manual',
       '{"procedure": "RUNBOOK 7a", "verifiedBy": "<operator>"}'::jsonb
     );
   COMMIT;
   ```

   Deleting the sessions signs every device out; the `two_factor_reset`
   audit row is mandatory — the application never writes that action, so
   its presence always means this procedure ran.

3. **The user signs back in and re-enrols immediately.** While
   `MFA_ENFORCE=true` a privilege-holding user is walled into enrolment
   on their next sign-in, so the reset window closes itself. Confirm the
   new enrolment (`two_factor_enabled` audit row) before closing the
   ticket.

## 8. Design-partner onboarding checklist

Per partner (3–5 for the pilot):

- [ ] owner signs up; organisation created; slug/name confirmed;
- [ ] owner enrols MFA — with `MFA_ENFORCE=true` (the production default,
      required before the first partner account exists) the product walls
      the owner into TOTP enrolment on first sign-in; confirm the backup
      codes were stored and record the §7a callback phone number;
- [ ] members added with the right roles; issue/cancel authority granted
      to the specific people who sign documents (not by default);
- [ ] walkthrough completed: LOA upload → review → confirm → challan
      draft → issue → PDF → signed-copy upload;
- [ ] their first real LOA processed together, extraction quality noted;
- [ ] support channel agreed (shared chat/phone), response expectations
      set (pilot: business hours, same-day);
- [ ] retention walkthrough completed: receipt → serials/installation →
      record/on-account/final Measurement Book → bill preparation and status
      progression;
- [ ] procurement and tax walkthrough completed where enabled: vendor →
      purchase order → receipt, and submitted GST invoice → PDF → explicit
      Whitebooks IRP registration or reconciliation → provider cancellation
      before local cancellation. Confirm that an unknown result is shown as
      unknown and is never blindly resubmitted;
- [ ] partner told, in writing, what the pilot does NOT yet include
      (unattended statutory filing, fresh e-way-bill generation for the current
      SAC service invoice, security-deposit/price-variation bill maths, offline
      sync — docs/ROADMAP.md).

## 9. External items before paid production

Tracked in docs/SECURITY.md; not satisfiable by this repository alone:

- DAST against the staging deployment;
- external application-security review;
- key rotation procedure executed once;
- threat model review with the pilot's real usage in view.
