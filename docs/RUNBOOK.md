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

## 3. Upgrades

```bash
git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build
# then re-run the bootstrap command from §2 if the release added migrations
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

## 8. Design-partner onboarding checklist

Per partner (3–5 for the pilot):

- [ ] owner signs up; organisation created; slug/name confirmed;
- [ ] owner enrols MFA (release blocker: MFA enforcement for owners ships
      before the first partner account exists — docs/ROADMAP.md);
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
      purchase order → receipt, and submitted GST invoice → rendered PDF →
      operator-assisted IRP/NIC response recording;
- [ ] partner told, in writing, what the pilot does NOT yet include
      (automatic Whitebooks submission, security-deposit/price-variation bill
      maths, offline sync — docs/ROADMAP.md).

## 9. External items before paid production

Tracked in docs/SECURITY.md; not satisfiable by this repository alone:

- DAST against the staging deployment;
- external application-security review;
- key rotation procedure executed once;
- threat model review with the pilot's real usage in view.
