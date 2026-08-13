# Pilot deployment and operations runbook

The concrete procedures for the design-partner pilot deployment. The
principles they implement live in docs/OPERATIONS.md; where the two ever
disagree, OPERATIONS.md wins and this file gets fixed.

The pilot runs on one production-like host in an India region
(data residency: docs/SECURITY.md), on the `deploy/docker-compose.prod.yml`
topology: Caddy (TLS, static web, API proxy) → server → PostgreSQL,
Gotenberg, ClamAV.

## 1. Provisioning

- one VM in an India region (any major provider's Mumbai/Hyderabad
  region; 2 vCPU / 4 GB / 40 GB is enough for the pilot), Docker and the
  compose plugin installed;
- a DNS A record for the chosen `SITE_ADDRESS` pointing at the VM;
- inbound 80/443 only; SSH by key; everything else closed;
- outbound open (Caddy's certificate issuance, ClamAV signature updates).

## 2. First deploy

```bash
git clone https://github.com/punyanagari/Auto-MB-ClaudeV1 && cd Auto-MB-ClaudeV1
cp deploy/.env.production.example deploy/.env.production   # fill in real values
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build

# one-time: application role + schema migrations (admin credentials stay
# on the host, never in the app container's environment)
# DATABASE_ADMIN_URL is the owner connection string: user auto_mb_owner,
# the POSTGRES_PASSWORD from .env.production, host postgres, db auto_mb.
docker compose -f deploy/docker-compose.prod.yml exec \
  -e DATABASE_ADMIN_URL="<owner connection string>" \
  -e AUTO_MB_APP_DB_PASSWORD="<AUTO_MB_APP_DB_PASSWORD>" \
  -e DATABASE_URL="<application connection string>" \
  server pnpm --filter @auto-mb/db bootstrap
```

Verify: `https://<SITE_ADDRESS>/api/ready` answers `200`, sign-up works,
and ClamAV is active (upload the EICAR test file — it must be rejected
with `MALWARE_DETECTED`; give the clamav container a few minutes on first
boot to download signatures).

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
host key, builds images, runs migrations to completion while the OLD
containers keep serving, recreates the app containers only after the
migration succeeds, and rolls back automatically if `/api/ready` never
answers. Read the job log: it prints the state before the deploy, the
commit being served, and — on failure — both the failed state and the
restored one.

Manual upgrade on the host, for when Actions is unavailable, in the same
order (never `up -d --build` first: that serves new code against an
un-migrated schema):

```bash
cd /opt/auto-mb && git pull
COMPOSE="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production"
docker inspect --format '{{.Image}}' "$($COMPOSE ps -q server)"   # note this, for rollback
$COMPOSE build                       # build only; nothing is recreated yet
$COMPOSE up -d --wait postgres
set -a; . deploy/.env.production; set +a
$COMPOSE run --rm --no-deps -T \
  -e DATABASE_ADMIN_URL="postgres://auto_mb_owner:${POSTGRES_PASSWORD}@postgres:5432/auto_mb" \
  -e AUTO_MB_APP_DB_PASSWORD="${AUTO_MB_APP_DB_PASSWORD}" \
  -e DATABASE_URL="postgres://auto_mb_app:${AUTO_MB_APP_DB_PASSWORD}@postgres:5432/auto_mb" \
  server pnpm --filter @auto-mb/db bootstrap    # migrations to completion
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

Nightly cron on the host (not inside a container), keeping 14 daily and 8
weekly copies, with every backup copied off the VM (object storage in a
different account/region):

```cron
30 21 * * * cd /opt/auto-mb && DATABASE_ADMIN_URL=... OBJECT_STORAGE_DIR=/var/lib/docker/volumes/auto-mb-prod_objects/_data BACKUP_ROOT=/backup BACKUP_MARKER_DIR=/var/lib/auto-mb/backup-status ./scripts/backup.sh >> /var/log/auto-mb-backup.log 2>&1
```

`scripts/backup.sh` produces a custom-format `pg_dump`, an object-store
tarball, and a SHA-256 manifest, then re-verifies the manifest. Only after
all of that succeeds does it atomically update the last-success marker
(`${BACKUP_MARKER_DIR}/last-success`, epoch seconds; temp file + rename) —
a failed run leaves the previous marker untouched. `BACKUP_MARKER_DIR`
defaults to `BACKUP_ROOT`; production points it at
`/var/lib/auto-mb/backup-status`, which `deploy/docker-compose.prod.yml`
mounts read-only into the server container so `/metrics` can expose the
`backup_last_success_timestamp_seconds` gauge (§6) without ever exposing
the dumps themselves to the app container.

## 5. Restore drill

A backup is not accepted until a restore has succeeded (OPERATIONS.md §5).
Monthly during the pilot, and after any schema-heavy release:

```bash
createdb auto_mb_drill
RESTORE_DATABASE_URL="<owner connection string for auto_mb_drill>" \
RESTORE_OBJECT_STORAGE_DIR=/tmp/drill-objects \
  ./scripts/restore.sh /backup/<latest>
# verify: row counts vs production, open one restored PDF; drop the drill db
```

Record date, backup used, and outcome in the ops log. The same flow is
proven automatically by `packages/db/test/backup-restore.integration.test.ts`.

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

- **uptime**: an external monitor probing `https://<SITE_ADDRESS>/api/ready`
  every minute; alert on two consecutive failures;
- **metrics**: `GET /metrics` (Prometheus text format) with
  `Authorization: Bearer <METRICS_TOKEN>`, scraped from inside the host
  network only — Caddy refuses it publicly. Alert on: 5xx rate above 1%
  over 5 minutes; p95 latency above 2 s; scrape silence (server down);
- **backup age**: `backup_last_success_timestamp_seconds` on `/metrics` is
  the epoch of the last backup whose dump, object archive, and manifest
  verification all succeeded (§4). Alert when
  `time() - backup_last_success_timestamp_seconds > 26 * 3600` — the
  nightly cron plus slack, i.e. one missed backup — and treat
  `absent(backup_last_success_timestamp_seconds)` as the same alert once
  the first backup has ever run: the series is deliberately omitted (not
  `0`) when the marker is unset or unreadable, so absence after go-live
  means the cron or the marker mount is broken;
- **security and saturation signals** (OPERATIONS.md §6 lists every series
  and its labels). Suggested pilot alerts, all off `/metrics`:
  - `increase(auth_failures_total[15m])` above the pilot's normal band, and
    ANY `increase(account_lockouts_total[15m]) > 0` — a lockout is rare
    enough during a 3–5 partner pilot to be worth a look every time;
  - `increase(tenant_denials_total[15m]) > 0` — a tenant-boundary denial is
    either a client bug or someone probing; both want eyes;
  - `increase(upload_scan_failures_total{reason="malware_detected"}[1h]) > 0`
    (security event, RUNBOOK §7) and any sustained
    `reason="scanner_unavailable"` (uploads are failing closed);
  - `increase(rate_limit_rejections_total[15m])` spiking — either an attack
    or a limit set too tight for real use;
  - `sum(db_pool_connections) / db_pool_connections_max > 0.8` for 5
    minutes — the API is about to start queueing on connections;
  - `increase(statutory_provider_operations_total{status="unknown"}[1h]) > 0`
    — an unknown provider outcome always needs a human reconciliation
    decision, never a blind retry.
- **disk**: alert at 80% on the VM (PostgreSQL volume + objects volume);
- **logs**: the server logs structured JSON to stdout
  (`docker compose logs server`); review after every alert and weekly.

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
