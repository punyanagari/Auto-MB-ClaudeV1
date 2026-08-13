# Auto-MB operations contract

The concrete pilot procedures implementing this contract live in
docs/RUNBOOK.md.

## 1. Environments

- `local`: Docker PostgreSQL and Gotenberg; synthetic or approved fixtures.
- `staging`: production-like networking, database roles, object storage, monitoring, and deployment.
- `production`: India-region deployment where customer/government requirements demand it; private database and storage; controlled egress.

No production secret, database dump, or customer document belongs in local development or an AI-agent workspace.

## 2. Service topology

- static web assets;
- API service;
- worker service;
- PostgreSQL;
- private object storage;
- private Gotenberg;
- outbound Whitebooks GSP adapter when statutory submission is enabled;
- edge/WAF and TLS termination;
- central logs, metrics, traces, and alerting.

The Whitebooks adapter is disabled unless `WHITEBOOKS_ENABLED=true`. Enable it
only with one exact configured GSTIN, an e-invoice credential set, the
authorised public IP, and—when standalone EWB cancellation is required—the
separate E-way Bill API client-id/client-secret pair.

Tax-invoice rendering bounds the Gotenberg request to 45 seconds and the PDF
response to 20 MiB. A timeout, oversized/invalid response, branding read error,
or storage error leaves the previous render pointer unchanged. Each successful
version freezes its logo and is retained; object-storage lifecycle policy must
therefore preserve every key listed in `tax_invoice_renders`, not only the
invoice's current pointer.

Password recovery is the one thing the product mails, and its transport is
mandatory: outside development and test the API refuses to start unless
both `SMTP_URL` (a nodemailer `smtp://`/`smtps://` connection URL) and
`MAIL_FROM` (a sender address the relay accepts) are present in its
environment (`assertProductionMailSettings` in `apps/server/src/auth.ts`;
docs/SECURITY.md, "Authentication and authorisation"). Both values come
from `deploy/.env.production` exactly like `AUTH_SECRET` — mailbox
credentials belong in the deployment secret store, never in source
control — and `deploy/docker-compose.prod.yml` marks them required, so a
deploy without them fails at compose interpolation rather than shipping a
container that boot-loops. After configuring or changing them, verify
delivery end-to-end: use "Forgot your password?" on the sign-in screen
with a real staff address and confirm the mail arrives and its link opens.
The request endpoint deliberately answers the same neutral message whether
or not the send succeeded (no account-existence oracle), so an arrived
mail is the only proof of a working transport.

The API's login/upload rate limits and the account-scoped login lockout
keep their counters in process memory: they protect a SINGLE API
instance only. Running more than one API instance divides (and for the
lockout, weakens) these thresholds — before scaling out, move that state
into PostgreSQL or a shared store (docs/SECURITY.md).

## 3. Deployment rules

1. Build immutable artifacts from a reviewed commit.
2. Run unit, integration, tenant-isolation, migration, and smoke tests.
3. Apply backward-compatible migrations before or during controlled rollout.
4. Deploy staging and run smoke/DAST checks.
5. Production deployment requires human approval.
6. Failed health checks trigger rollback.
7. Never depend on an agent session as the sole deployment record.

These are the rules the deployment must meet, not a description of the
current workflow. `.github/workflows/deploy.yml` now satisfies rules 2, 3
and 6, and no longer trusts a deploy-time `ssh-keyscan`:

- **rule 2** — the workflow refuses to deploy a commit that has no
  successful CI run (`gh api .../actions/workflows/ci.yml/runs`
  filtered to the dispatched ref's head SHA), and the host re-checks that
  the checkout it is about to serve is that same commit;
- **rule 3** — images are built, then migrations run to completion in a
  one-off container built from the NEW image while the OLD containers keep
  serving, and only a successful migration recreates the app containers. A
  failed migration leaves the previously running release untouched;
- **rule 6** — the readiness gate rolls back automatically. The image ids
  serving before the deploy are recorded first; if `/api/ready` does not
  answer READY WITH EVERY COMPONENT OK within the retry window, the
  checkout returns to the previous commit, the previous images are
  restored under the compose build tags, the containers are recreated from
  them, and the job exits nonzero with both the failed and the restored
  state logged. A 200 alone is not the gate: the four per-component
  assertions CI has always made now run on the deployment path too, so a
  release that quietly lost `CLAMAV_HOST` or `GOTENBERG_URL` — leaving the
  component `unconfigured` rather than failed — is refused instead of
  shipped. Forward-only migrations are deliberately NOT rolled back (§4);
- **host key** — pinned from the `DEPLOY_HOST_KEY` secret with
  `StrictHostKeyChecking yes`; an unset pin fails the job rather than
  falling back to trust-on-first-use. Rotation: docs/RUNBOOK.md §2a.

Two further properties of the build itself:

- **the artifact is minimal** — the server image ships compiled
  JavaScript bundles and a production-only dependency install, not the
  workspace source under `tsx` with the whole dev toolchain beside it.
  Migrations therefore run as `node apps/server/dist/bootstrap.mjs`; there
  is no `pnpm` or `tsx` in the image;
- **the artifact is scanned** — every base image is pinned by digest as
  well as tag, and `scripts/scan-images.sh` runs Trivy against both built
  images between the build and the migration. Fixable HIGH/CRITICAL
  findings stop the release while the previous containers are still
  serving. Accepting one is an edit to `deploy/.trivyignore`, which is
  reviewable, rather than a flag;
- **the artifact's Poppler matches CI's** — `poppler-version.txt` at the
  repository root holds one version, the production image pins
  `poppler-utils` to it and asserts the installed banner, and the base is
  `node:22.16.0-alpine3.21` because that is the Alpine release carrying it.
  LOA extraction reads `pdftotext -layout` geometry, so a runner and a
  production image on different Poppler versions means the corpus proves
  nothing about production (docs/DEPENDENCIES.md).

Rules 1 and 5 remain open, and closing them is still a pre-production
gate: images are built ON the production host rather than pulled as a
reviewed immutable digest from a registry, and there is no protected
GitHub environment requiring a second person's approval — `workflow_dispatch`
proves a human pressed the button, not that a reviewer approved the
release. Recorded as finding 32 in `docs/AUDIT-DISPOSITION-2026-08-10.md`.

## 4. Database changes

- forward-only SQL migrations;
- one migration id per file;
- migration content is hashed and recorded;
- lock and statement timeouts are explicit;
- destructive changes use expand/migrate/contract sequencing;
- every migration has a tested rollback/mitigation plan even when SQL rollback is not automatic.

## 5. Backup and recovery

The requirements, before a paid pilot:

- automated encrypted backups;
- point-in-time recovery;
- documented RPO and RTO;
- quarterly restore test at minimum during pilot, more often while the system changes rapidly;
- object-storage versioning/retention appropriate to legal records;
- restore evidence retained.

A backup is not accepted until a restore has succeeded.

### What `scripts/backup.sh` actually does

Stated exactly, because these paragraphs previously promised encryption,
point-in-time recovery and retention that the script did not implement.
The concrete procedure and its configuration are docs/RUNBOOK.md §4/§4a.

One run produces one dated directory containing:

- a custom-format `pg_dump` of the database;
- a gzip archive of the object store;
- the `AUTH_SECRET` and database passwords, when a secrets file is
  configured — without `AUTH_SECRET` a restored database cannot decrypt a
  single stored TOTP secret or backup code, so an MFA-enforcing deployment
  comes back with every privileged user locked out;
- a `MANIFEST` recording the format, both snapshot times, whether the
  artefacts are encrypted, and whether an off-host copy was configured;
- `SHA256SUMS` over the bytes as stored, re-verified before the run is
  allowed to call itself successful.

**Encryption** is envelope encryption: a fresh random data key encrypts the
artefacts with AES-256, and the data key is encrypted to an RSA public key
with OAEP/SHA-256. Only the public half lives on the production host, so a
host compromise yields no readable backup and the host cannot decrypt its
own history. `pg_dump` and `tar` stream straight into the cipher — no
plaintext artefact is ever written to the backup directory. It is enabled
by configuration (`BACKUP_ENCRYPTION_PUBLIC_KEY`); production also sets
`BACKUP_REQUIRE_ENCRYPTION`, which turns a missing key into a refusal
rather than a plaintext backup. Recovery secrets are refused outright
unless encryption is on.

**Snapshot consistency** (finding 33) is established by ordering rather
than by a single instant, which a shell script spanning a database and a
filesystem cannot have. The dump is taken first, so it can only reference
objects that already existed; the object store is enumerated after it,
which yields a superset of everything the dump can reach; and the archive
is built from exactly that enumeration, so an object disappearing
mid-backup aborts the run instead of certifying a pair that cannot be
restored together. Extra members are orphan files a restore ignores; a
dangling reference — the direction that actually breaks a restore — is no
longer reachable.

**Off-host copy** runs an operator-supplied command with the finished
backup directory as its argument, and the last-success marker is published
only if that command succeeds: a backup that exists only on the host it
protects has not survived the failure it exists for. The destination is an
owner decision and is empty by default.

**Still not implemented, and therefore still gates rather than claims:**
point-in-time recovery (there is no WAL archive, so the recovery point is
the last nightly run), pruning of old backup directories (the cron in
docs/RUNBOOK.md §4 does that, not the script), and object-storage
versioning. RPO is one backup interval, currently 24 hours; RTO has not
been measured.

Object writes are crash-consistent (finding 34, atomic-write slice): the
filesystem store writes each object to a temp file in the SAME directory,
fsyncs it, atomically renames it onto the final key, then fsyncs the
directory. A stored object therefore either exists complete or does not
exist — a backup, a reader, or a restore can never observe a half-written
object, and a crash mid-write leaves at most an inert orphan temp file
whose dotted name no object key can resolve to. Directory fsync is real on
Linux, where production runs; on Windows (development only) libuv cannot
open a directory handle, so that one step degrades to a no-op while the
rename stays atomic. Of the rest of finding 34, off-host copying and
encryption at rest are now implemented in the backup path above;
object-storage versioning and a delete path remain open.

## 6. Observability

Minimum signals:

- API request rate, errors, and latency;
- database saturation and slow queries;
- job queue depth, retries, and dead letters;
- LOA extraction failures and review rate;
- PDF generation failures;
- authentication failures and suspicious access;
- object-storage errors;
- before Whitebooks production enablement: statutory-provider request
  failures, latency, authentication expiry, unknown operations, and locally
  issued documents awaiting external registration;
- tenant-boundary denial events;
- backup recency: age of the last fully verified backup, exposed as a
  metric and alerted on before it exceeds one missed backup cycle;
- deployment and migration status.

### What `/metrics` actually exposes

`apps/server/src/metrics.ts`, served at `GET /metrics` behind
`METRICS_TOKEN` (RUNBOOK §6). Every label value is drawn from a closed set
— route templates, not URLs; bounded reason/scope/operation/status words,
never document ids, organisation ids, email addresses, client addresses or
provider codes:

| Series                                  | Type      | Labels                | Source                                                       |
| --------------------------------------- | --------- | --------------------- | ------------------------------------------------------------ |
| `http_requests_total`                   | counter   | method, route, status | response hook                                                |
| `http_request_duration_seconds`         | histogram | —                     | response hook                                                |
| `auth_failures_total`                   | counter   | surface               | auth handler, off the same response the identity audit reads |
| `account_lockouts_total`                | counter   | —                     | account lockout, once per episode                            |
| `tenant_denials_total`                  | counter   | reason                | error handler, every `NOT_A_MEMBER` refusal                  |
| `rate_limit_rejections_total`           | counter   | scope                 | rate limiter and account lockout, at refusal                 |
| `statutory_provider_operations_total`   | counter   | operation, status     | provider-operation ledger completion                         |
| `upload_scan_failures_total`            | counter   | reason                | malware gate                                                 |
| `db_pool_connections` / `_max`          | gauge     | state                 | `pg_stat_activity`, sampled per scrape                       |
| `backup_last_success_timestamp_seconds` | gauge     | —                     | backup marker file (§5, RUNBOOK §4)                          |

Counters are process-cumulative, which is what Prometheus expects; a
restart resets them and `rate()` handles it. The pool gauge and the backup
gauge omit their series entirely when they cannot be sampled — absence is
honest, a fabricated `0` would read as a real measurement.

### What reads them

`deploy/docker-compose.prod.yml` runs Prometheus and Alertmanager beside
the application. Prometheus scrapes `server:3000/metrics` every 30 s with
the `METRICS_TOKEN` bearer, keeps 15 days, and evaluates the rules
committed at `deploy/prometheus/alert_rules.yml` — every one of them
written against a series the table above actually lists, because a rule
over an absent series is permanently silent and reads as healthy. Neither
service publishes a port; an operator reaches them over an SSH tunnel
(docs/RUNBOOK.md §6).

The one part that is not settled in the repository is the delivery
channel: Alertmanager ships with a receiver that holds and groups firing
alerts but sends them nowhere, because the destination is an owner
decision. Until one is made, alerts are visible rather than delivered, and
that gap is deliberate and visible rather than a config posting into
nothing.

Still NOT instrumented, and therefore still gates rather than claims: job
queue depth/retries/dead letters, LOA extraction failure and review rate,
PDF generation failures, object-storage errors, provider latency
histograms and authentication-expiry signals, locally issued documents
awaiting external registration, and deployment/migration status as a
metric.

Logs include request id, route, status, duration, actor id when available, and organisation id when safe. Logs exclude bodies, passwords, tokens, LOA text, and document contents.

The current durable provider-operation ledger records operation name, document
id, provider/environment, correlation id, request SHA-256, terminal status,
timestamps, redacted provider code, and HTTP status. Since migration `0053` it
also retains the raw provider request and response bodies, bounded at 256 KiB
with explicit truncation markers. It never stores credentials, tokens,
encrypted/decrypted session material, or signed QR payloads. Provider call
outcomes are now counted (`statutory_provider_operations_total`); latency
histograms, authentication-expiry signals, and alerts are not yet implemented
and remain production-enablement gates.

## 7. Incident response

Initial severities:

- SEV-1: confirmed/suspected cross-tenant exposure, credential compromise, material document corruption, or widespread outage.
- SEV-2: one-customer critical workflow unavailable, failed issue/numbering integrity, restore risk.
- SEV-3: degraded non-critical function or isolated retryable job failure.

For every material incident: contain, preserve evidence, communicate, remediate, verify, and record prevention work.

## 8. Digital-signature trust anchors

Inbound railway PDFs (LOAs, tender documents, and — as the consumers are
added — variation orders, Measurement Book copies, tax invoices, bill
copies and agreements) have their digital signatures verified at upload
and the verdict stored with the document (migration 0060). Verifying the
signature MATHEMATICS needs nothing; deciding WHO signed needs trust
anchors.

### What the image ships, and what it does not decide

Indian digital signatures chain to the Controller of Certifying
Authorities hierarchy: signer certificate -> licensed CA's sub-CA -> that
CA's root -> a `CCA India <year>` root. There is no platform trust store to
delegate to: the CCA roots are in neither Adobe's AATL, the Microsoft
Trusted Root Program, nor Mozilla's store (Mozilla closed the application
WONTFIX). That absence is also the direct cause of the "Signature Not
Verified" banner Adobe shows on perfectly good IREPS documents — the chain
is complete inside the file, the reader simply has no anchor for it.

Since pack P9 the image carries a **default** set of roots at
`/etc/auto-mb/pdf-trust`, and `AUTO_MB_PDF_TRUST_ANCHORS` points at it out
of the box (`deploy/trust-anchors/`, `deploy/Dockerfile.server`). Before
that, a stock deployment showed every reviewer "no certifying authorities
are installed" — accurate, and impossible for a new operator to act on.
`deploy/trust-anchors/README.md` records where each certificate was fetched
from and its SHA-256; `scripts/check-config.mjs` re-pins every one of them
on every build, so the bundle cannot change without the change being
deliberate. `CCA India 2015 SPL` is deliberately absent — the file the CCA
publishes fails its own self-signature check, and the README says so rather
than shipping something unverified.

**The default is a starting point, not the trust decision.** The roots are
re-issued on their own schedule and licensed CAs are added and rekeyed
several times a year, so a bundle frozen in an image goes stale — silently,
if nobody looks. The quarterly refresh below still owns this, and it is
what makes the trust decision auditable and its age knowable. Mounting a
host directory over `/etc/auto-mb/pdf-trust` (or pointing the variable at
another path — see `deploy/docker-compose.prod.yml`) refreshes anchors
without an image rebuild.

### Layout

`AUTO_MB_PDF_TRUST_ANCHORS` points at a directory:

```
/etc/auto-mb/pdf-trust/
  cca-india-2022.pem
  cca-india-2022-spl.pem
  cca-india-2014.pem          # kept: 2020 documents still need it
  intermediates/              # chain completion only, NEVER trust anchors
    prodigisign-ca-2022.pem
    ...
```

`*.pem`, `*.crt` and `*.cer` are read (PEM text; convert DER with
`openssl x509 -inform der -in X.cer -out X.pem`). A single bundle file
also works.

**Only CCA roots belong at the top level.** Certificates in
`intermediates/` complete a path when a signer embedded no chain, and can
never end one. Installing a licensed CA as an anchor would make that one
CA's compromise indistinguishable from a compromise of the CCA root, and
would accept chains that never reach the root at all.

### Refresh procedure

Quarterly, by a human, never automatically:

1. Download the roots from <https://cca.gov.in/root_certificate.html> and
   the licensed-CA certificates from
   <https://cca.gov.in/display_cert2022.php> over TLS.
2. Confirm each root's SHA-256 fingerprint independently. The CCA
   publishes no fingerprints on the page and no signed trust list; the
   documented out-of-band channel is an automated reply from
   `verifyroot@cca.gov.in`. Use it — a download alone is one channel.
   The anchor in use at the time of writing is
   `CCA India 2022`, SHA-256
   `9A:3F:D3:17:67:98:E8:42:DD:CB:12:C2:62:F1:1C:FA:CC:A7:0A:8B:84:C6:EA:6F:DA:30:84:2A:95:A9:4C:D8`,
   valid 2022-02-02 to 2042-02-02.
3. Diff against what is installed — which, on a stock deployment, is the
   bundle in `deploy/trust-anchors/` with the fingerprints its README
   records. Any ADDITION to the anchor directory is a two-person change
   with a ticket, exactly like a manual database edit. If the addition is
   made in the repository rather than on the host, the manifest in
   `scripts/check-config.mjs` moves in the same commit; the build fails
   otherwise, which is the point.
4. Never remove an expired root: a document signed in 2021 still needs the
   root that was current in 2021 to have its chain read.
5. Restart the server. Anchors are loaded once at boot, and a configured
   but unreadable path REFUSES to start rather than silently degrading
   every railway document to "issuer not checked".

Leaving `AUTO_MB_PDF_TRUST_ANCHORS` unset is a legitimate posture and is
not a silent one: every signature is still verified cryptographically, no
document can reach the `signed_and_intact` state, and the review screen
says that no certifying authorities are installed.

### What is NOT checked

Revocation. CRL download, live OCSP, and fetching a missing intermediate
from a certificate's own AIA URL all need network egress this deployment
does not assume — and AIA fetching in particular turns an
attacker-supplied URL into a server-side request. Every verdict therefore
records revocation as `not_checked` with its reason, and the screen says
so on every signature. A certificate revoked after issue still reads as
valid here. Closing that gap means either allowing egress to the CAs'
OCSP/CRL endpoints, or receiving documents in PAdES-LT form with a `/DSS`
dictionary carrying their own revocation material (no IREPS document seen
so far does).

## 9. Support and data operations

- support impersonation is explicit, temporary, and audited;
- customer exports are scoped and reproducible;
- deletion/erasure requests preserve legally required immutable records while removing eligible personal data;
- no manual database edit without a ticket, peer review, backup, and audit record.

## 10. v1 cutover runbook (legacy-data import)

The v1 legacy product's SQLite backup is imported once per organisation
with `scripts/import-v1.ts` (engine: `apps/server/src/import/`). The
importer is an administrator-role operational tool: it runs with
`DATABASE_ADMIN_URL`, keeps every schema guard and trigger active
(`session_replication_role` tricks are forbidden), records provenance in
`import_batches` / `import_records` (migration 0025), and is idempotent —
re-running the same input is a no-op; a changed source row is reported as
drift and never silently repaired.

Order of operations:

1. **Dry run.** Against the production database (or a restored copy):
   `pnpm exec tsx scripts/import-v1.ts --backup <v1.sqlite> --mapping
scripts/import-v1.mapping.json --mode dry-run`. The whole pipeline runs
   in one transaction and rolls back; only the reconciliation report
   remains.
2. **Review the report** with the customer: per-organisation source vs
   imported counts, contract-value and challan-line totals, per-Work
   challan-number continuity (gaps are reported, never filled; counters
   land so the next issued number continues the historical series),
   serial counts, quantization statistics, and EVERY exception with its
   source id and violated rule. Exceptions are expected in real data
   (non-numeric challan suffixes, variation-only zero-quantity items,
   duplicate serials); agree what, if anything, is fixed in v1 first.
3. **Freeze v1.** Stop all v1 data entry; announce the cutover window.
4. **Fresh backup.** Take a new v1 backup AFTER the freeze and re-run the
   dry run on it; the report must match expectations.
5. **Apply.** Same command with `--mode apply` (one transaction per
   organisation). Store the printed report with the change ticket; it is
   also persisted in `import_batches.reconciliation`.
6. **Verify reconciliation.** Re-run `--mode dry-run` on the same input:
   every entity must now show `unchanged`, zero `imported`, zero drift.
   Spot-check a handful of challans against printed v1 documents.
7. **Invite users.** Imported organisations are created idle (no
   memberships): create owner invitations through the product; assign
   roles and authorities explicitly.
8. **Launch.** Enable access, monitor the first issued challan per Work —
   its number must be `highest imported sequence + 1` in the historical
   series.

The v1 backup contains customer production data: it never enters the
repository, agent workspaces, or fixtures. The importer's tests build
synthetic SQLite fixtures; the optional real-backup smoke test runs only
where an operator has placed a backup locally.
