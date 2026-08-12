# Auto-MB delivery roadmap

This roadmap is outcome-based. Dates are planning targets, not claims.

## Milestone 0 â€” executable foundation

Exit criteria:

- web, API, worker, PostgreSQL, and PDF service start locally;
- CI runs from a clean checkout;
- shared multi-tenant schema and RLS baseline exist;
- LOA parser corpus runs unchanged;
- authoritative documentation and agent instructions are in place.

## Milestone 1 â€” organisation, identity, and isolation

Delivered:

- Better Auth integration (email/password, server-side sessions, sign-out revocation, two-factor path via the twoFactor plugin);
- organisation creation (atomic SECURITY DEFINER bootstrap) and selection via the validated `x-organisation-id` header;
- the database-enforced membership floor: tenant context binds only when the authenticated user holds an active membership in the selected organisation, so a compromised or buggy handler cannot stamp an arbitrary organisation id â€” proven live at both the SQL and HTTP layers;
- four roles with Work scope and issue/cancel authority stored per membership; member management is owner-only;
- RLS and authorisation tests through the real application role, pool, and HTTP endpoints;
- audit events for organisation creation and membership changes;
- web screens for sign-in/sign-up, organisation selection and creation, and member management â€” token-based design system, print-aware styles, component tests, and a blocking Playwright + axe accessibility smoke against the production bundle.

Authorization completion (2026-08-08, following the external code review):

- `work_scope = 'assigned'` is now enforced, not merely stored: a
  membership-to-Work assignment model (migration 0009, seventeenth
  tenant table) filters the Works list and dashboard and answers 404 for
  any guessed identifier outside the assignment, on every Work, challan,
  PDF, receipt, serial, instrument, MB, and bill path;
- the site role can now do the site job: receipts, serials,
  installations, and Measurement Book entries accept owner, office, and
  site members (viewers are refused); drafting, instruments, and billing
  remain office/owner and authority-gated;
- member lifecycle management exists end to end: owners edit role,
  scope, and issue/cancel authorities, disable and re-enable members
  (denial is immediate through the membership floor), and manage Work
  assignments â€” all audited, with the last active owner protected from
  demotion or disablement.

Closing decisions (2026-08-08):

- MFA enrolment/enforcement for owners is deferred to Milestone 4: the twoFactor capability is live, and the enforcement policy lands with design-partner onboarding, where real contractor data first appears;
- identity-level audit events (sign-up/sign-in/sign-out) are recorded in the user-scoped, append-only `identity_audit_events` table (migration 0005) â€” `audit_events` keeps its NOT NULL organisation invariant;
- role/authority enforcement on Work operations activates with the Milestone 2 endpoints (upload and confirm are owner/office-only).

Exit: Organisation A cannot access Organisation B through any endpoint, identifier, job, or attachment path.

## Milestone 2 â€” LOA to Work

Delivered:

- private PDF upload: raw `application/pdf` body, magic-byte and 25 MB validation, server-generated tenant-prefixed object keys in filesystem-backed object storage behind an interface;
- text extraction via `pdftotext -layout` (poppler, system dependency) â€” the same layout-preserving extraction the parser corpus was built with â€” inline at upload;
- the adopted deterministic parser produces the stored review payload: per-field provenance (value, printed raw source, needsReview), item rows with exact-decimal reconciliation, pricing-shape classification, and the trap flag set;
- review/correction UI: parsed prefills, a flag panel with printed sources, per-item editing beside each item's printed source row, and owner/office-gated confirmation;
- atomic confirmation creating the Work, schedules, and items, each item carrying `source_evidence` linked to its parsed source block, with the full extraction payload retained on the document;
- parser and confirmation integration tests: all six legacy fixtures reviewed and confirmed over live HTTP, with schedule/item counts and contract values matching the corpus manifest and zero unresolved evidence links.

Remaining (tracked for the pre-pilot hardening pass):

- ~~rate limiting on upload/extraction~~ â€” shipped 2026-08-08 (ops batch): sliding-window limits on login and every upload endpoint;
- ClamAV upload quarantine before design-partner uploads (Milestone 4 trigger);
- the model/OCR fallback for unresolved fields waits for the first real letter the deterministic parser cannot serve.

Exit: all six legacy LOA fixtures can be reviewed and confirmed without losing source evidence â€” met (`apps/server/test/loa.integration.test.ts`).

## Milestone 3 â€” Work to issued Delivery Challan

Delivered:

- draft challans with the one-draft-per-Work invariant (DB partial unique index, surfaced as 409), consignee snapshot, and line snapshots (description/unit/rate copied and the line amount computed in exact SQL numeric arithmetic at line creation);
- balance-aware item picker: per-item awarded/delivered/remaining, where delivered counts issued challans only â€” cancellation releases its quantities;
- issue and cancel as explicit per-member authorities (`can_issue_documents` / `can_cancel_documents`), separate from roles and enforced over live HTTP;
- serialised per-Work numbering via the counter row lock (`prefix/sequence`; a rolled-back issue rolls its number back with it, so numbers are gapless per Work);
- concurrency-safe quantity validation inside the issue transaction (proved: a concurrent double-issue produces exactly one issued challan; exact-boundary issues pass, one-paisa-over fails);
- the immutable issued snapshot (organisation, work, consignee, lines, totals) stored on issue; DB triggers keep issued business data and cancelled challans immutable;
- deterministic HTML template (`dc-v1`) rendered from the snapshot only, converted by Gotenberg, stored with its SHA-256; signed-copy upload with magic-byte validation; authenticated PDF streaming;
- cancellation with mandatory note and the full audit timeline (created â†’ updated â†’ issued â†’ rendered â†’ signed-copy uploaded â†’ cancelled).

Remaining:

- the render call is a synchronous idempotent endpoint retried by the operator; unattended retry (pg-boss) arrives if the pilot shows renders failing when nobody is watching;
- the real Gotenberg service is exercised locally via compose; CI proves the render path against a stub PDF service, and the live-service proof lands with the staging deployment.

Exit: a design partner completes the exact LOAâ†’DC workflow in staging â€” pending Milestone 4's staging deployment; the workflow itself is complete and CI-proven end to end (`apps/server/test/challans.integration.test.ts`).

## Milestone 4 â€” controlled design-partner pilot

Delivered (the engineering half):

- upload malware scanning: a dependency-free clamd INSTREAM client wired into both upload endpoints, fail-closed when configured (unreachable scanner rejects the upload), proven at the protocol level and over live HTTP against a stub daemon; production compose runs the real ClamAV service;
- monitoring: a dependency-free Prometheus text-format `/metrics` endpoint (requests by method/route/status, latency histogram) behind a bearer token, refused publicly by the edge proxy;
- export: owner-only `GET /api/export` using current wire format `export-v8`,
  returning the organisation profile and localities, memberships and
  assignments, operational records, masters, procurement, tax invoices,
  e-way bills, statutory-provider operations, import provenance, every retained
  tax-invoice render, numbering counters, object manifest, and audit trail; the
  export itself is audit-logged;
- backup plus successful restore: `scripts/backup.sh` / `scripts/restore.sh` (custom-format dump + object store + SHA-256 manifest), with the dumpâ†’restoreâ†’verify cycle proven live in `packages/db/test/backup-restore.integration.test.ts`;
- deployment assets: production Dockerfiles, `deploy/docker-compose.prod.yml` (Caddy TLS + web, server, PostgreSQL 17, Gotenberg, ClamAV), env template, and the pilot runbook (docs/RUNBOOK.md: deploy, upgrade, backup cron, restore drill, alert thresholds, incident steps, partner onboarding checklist).

Remaining (needs the operator, real infrastructure, or third parties):

- MFA enrolment/enforcement for owners â€” the Milestone 1 deferred decision comes due before the first partner account exists (docs/RUNBOOK.md Â§8);
- ~~rate limiting on login and upload/extraction~~ â€” shipped 2026-08-08 (ops batch), alongside authorize-before-scan ordering, extraction outside the tenant transaction, the idempotent role/grant bootstrap (deployed on every release), the public auth base URL, edge security headers with CSP, the component-aware readiness probe, a production-compose smoke test in CI, and a restore proof that fails CI instead of skipping;
- the India-region VM, DNS, and TLS hostname (operator accounts and decisions);
- external uptime monitor and metrics scraper pointed at the deployment;
- DAST against staging and the external application-security review;
- three to five design partners recruited and onboarded per the checklist;
- backup-age visibility (thin pre-pilot slice, ADR-0005): the backup
  script updates a last-success marker only after the dump, the object
  archive, and manifest verification all complete; `/metrics` exposes the
  marker as a `backup_last_success_timestamp_seconds` gauge so the
  external monitor alerts on staleness â€” no in-app backup controls.

## Milestone 5 â€” retention workflow

Delivered (backend, migration 0006 + live HTTP proofs):

- delivery receipts: one per issued challan, writer-recorded, duplicate-proof;
- serial traceability: serials unique per Work, capped at the shipped line quantity under a row lock, installation recorded in place, and a per-Work trace listing serial â†’ challan number â†’ item â†’ installation;
- PBG/PAC/DOC instruments per Work: unique references, amounts, issue/expiry dates, forward status management, an expiry index for alerting;
- Measurement Book: entries capped so cumulative measurement never exceeds delivered (issued) quantity â€” checked in exact SQL arithmetic under a row lock; billed entries freeze via a DB trigger;
- first partial-billing cycle: bill preparation under issue authority sweeps all unbilled MB entries into an immutable per-item snapshot (quantity Ã— rate in exact numeric), numbered gaplessly per Work through a counter row lock; status moves forward only (prepared â†’ submitted â†’ paid, DB-enforced); bills cannot be deleted;
- the sixteen-table tenant-isolation matrix now covers every retention table, and the audit trail spans the whole flow (received â†’ serials â†’ installed â†’ measured â†’ billed â†’ paid).

Integrity hardening (2026-08-08, following the external code review):

- bill preparation aggregates and stamps exactly the locked set of unbilled MB entries, so a measurement recorded concurrently can never ride a bill whose immutable snapshot did not count it (proved with a concurrent bill-versus-measurement test);
- cancellation policy: an issued challan with downstream evidence (receipt, serials, or MB entries) can no longer be cancelled â€” received goods cannot be un-delivered; enforced in the route and by a database trigger, with the evidence-recording paths taking the challan row lock so cancellation cannot race them;
- instrument statuses are forward-only from `active` (released/expired/closed are terminal), enforced in the API and by a database trigger;
- measurement provenance and serial lineage are now database-proven: `mb_entries.delivery_challan_id` carries a composite foreign key to the same organisation and Work, and serial rows prove their challan line belongs to their challan;
- signed copies are stored content-addressed with their SHA-256 (replacements never overwrite earlier evidence), and a render that loses a race with a status change is discarded instead of leaving a false audit entry;
- the organisation export (`export-v2`) now includes receipts, serials, instruments, MB entries, and bills â€” the complete business record again.

Re-audit remediation (2026-08-08, second external review):

- concurrency-safe last-owner protection: membership edits serialise on
  the organisation row, proved with a simultaneous mutual-demotion test;
- per-client rate limiting behind Caddy via a narrowly trusted proxy hop
  (`TRUST_PROXY_HOPS=1` in production; forwarded headers ignored
  otherwise);
- LOA documents follow work scope: owner/office keep the review
  workspace, other roles see only documents confirmed into Works within
  their scope;
- the readiness storage probe overwrites one fixed key instead of
  leaving a file per poll;
- the CI production smoke gates on complete readiness including the
  malware scanner, and a new `restore-fresh-cluster` CI job proves
  disaster recovery onto a roleless cluster (bootstrap now ensures the
  definer role and repairs SECURITY DEFINER function ownership);
- the product date invariant holds: challan dates can be neither in the
  future (organisation-timezone today) nor before the LOA letter date â€”
  API validation plus a database trigger (migration 0010);
- export-v3 adds the organisation profile, work assignments, and a
  portable object manifest (keys + hashes) for offboarding/incident
  packages.

These `export-v2` and `export-v3` entries record historical progression. The
current wire format is `export-v8` (Milestone 10).

Retention UI (2026-08-08):

- challan screen: delivery receipt (record + facts), per-line serial recording, installation recording, all gated on the evidence roles (owner/office/site);
- Work screen: PBG/PAC/DOC instruments with forward-only status transitions, Measurement Book with challan provenance, bill preparation and status progression under the issue authority, and the per-Work serial trace;
- covered by view tests and the axe accessibility scans (work detail with retention sections, challan detail with evidence forms).

Remaining:

- retention-money maths beyond the measured-quantity bill (security deposit deductions, price variation) wait for a design partner's real bill format;
- PBG requirement wiring (thin pre-pilot slice, ADR-0005): surface the
  parser's already-extracted performance-guarantee field on the LOA
  review screen, persist the reviewer-confirmed requirement (required
  amount, submission and extension windows, penal-interest terms, source
  evidence, parser-proposed versus reviewer-corrected) onto the Work at
  confirmation, and derive submission-due dates from the LOA date. The
  requirement (what the LOA demands) stays distinct from the insÛO|¶‰ËkºwµçEÍ¡‰½…É½µÁ±•Ñ¥½¸…±•ÉÑÌ¸HÄÔÌ)Ñ¡¥ÉÍÑ…ÑÕÌ°…¹•±±•‘€°ÍÑ…åÌ‘•±¥‰•É…Ñ•±äÕ¹É•…¡…‰±”èÑ¡”)ÑÉ…¹Í¥Ñ¥½¸Õ…ÉÉ•™ÕÍ•Ì…¹äµ½Ù”¥¹Ñ¼½È½ÕĞ½˜…¹•±±•‘€É…Ñ¡•È)Ñ¡…¸±•…Ù¥¹œ…¸Õ¹¥µÁ±•µ•¹Ñ•ÍÑ…Ñ”É•…¡…‰±”Ñ¡É½Õ ME0¸]½É¬¡…Ì)¹¼É•µ½Ù…°Á…Ñ …Ğ…±°Ñ½‘…äƒŠPİ½É­Ì¹‘•±•Ñ•‘}…Ñ€•á¥ÍÑÌ™É½´µ¥É…Ñ¥½¸(ÀÀÀÄ…¹•Ù•ÉäÉ•…¡½¹½ÕÉÌ¥Ğ°‰ÕĞ¹½Ñ¡¥¹œİÉ¥Ñ•Ì¥ĞƒŠPÍ¼…¹•±±•‘€)ÍÑ…åÌÉ•™ÕÍ•Õ¹Ñ¥°İ½É¬É•µ½Ù…°¥Ì‰Õ¥±Ğİ¥Ñ ¥ÑÌ½İ¸ÉÕ±•Ì…¹)•Ù¥‘•¹”É•™ÕÍ…±Ì¸()I•ÑÉ½™¥Ğ°±½Í¥¹œ¡…É‘•¹¥¹œ€ ÈÀÈØ´Àà´Àä°µ¥É…Ñ¥½¸€ÀÀÌÈ¤èÑ¡”™É••é”½¸)„½µÁ±•Ñ•]½É¬¹½ÜÉÕ¹Ì¥¸‰½Ñ ‘¥É•Ñ¥½¹Ì¸€ÀÀÌÄ±½Í••Ù•ÉäÁ…Ñ )Ñ¡…ĞL„‘½Õµ•¹Ğì¹½Ñ¡¥¹œÍÑ½ÁÁ•Ñ¡”•Ù¥‘•¹”Ñ¡”ÁÉ•‘¥…Ñ”İ…Ì)µ•…ÍÕÉ•……¥¹ÍĞ‰•¥¹œ…¹•±±•½ÕĞ™É½´Õ¹‘•È¥Ğ…™Ñ•Éİ…É‘Ì°Í¼„)]½É¬½Õ±Í¥Ğ…Ğ½µÁ±•Ñ•‘€İ¡¥±”¥ÑÌ‘•±¥Ù•É•…¹¥¹ÍÑ…±±•ÍÕµÌ)¡…™…±±•¸‰•±½ÜÑ¡”ÅÕ…¹Ñ¥Ñ¥•ÌÑ¡…Ğ…‘µ¥ÑÑ•¥Ğ¸…¹•±±¥¹œ„‘•±¥Ù•Éä)¡…±±…¸°…¸¥ÍÍÕ”¡…±±…¸°…¸¥¹ÍÑ…±±…Ñ¥½¸É•½É°„A•ÉÑ¥™¥…Ñ”½È)„5•…ÍÕÉ•µ•¹Ğ	½½¬½¸„½µÁ±•Ñ•]½É¬¥Ì¹½ÜÉ•™ÕÍ•…ĞÑ¡”É½ÕÑ”(¡Õ¹‘•ÈÑ¡”İ½É­ÌÉ½Ü±½¬°Ñ…­•¸…™Ñ•ÈÑ¡”‘½Õµ•¹ĞÉ½ÜÍ¼…¹•°…¹)½µÁ±•Ñ¥½¸Í•É¥…±¥Í”¤…¹…ĞÑ¡”‘…Ñ…‰…Í”°•… ¹…µ¥¹œÑ¡”É•½Á•¸ìÑ¡”)‘•¥Í¥½¸¥ÌÉ•™ÕÍ”°¹½Ğ…ÕÑ¼µÉ•½Á•¸°Í¼Ñ¡”½Á•É…Ñ½ÈÍÑ…Ñ•Ìİ¡äÑ¡”)±½ÍÕÉ”İ…ÌİÉ½¹œ¥¸Ñ¡”¹½Ñ”Hà…±É•…‘ä…Õ‘¥ÑÌ¸	¥±°ÍÑ…ÑÕÌÑÉ…¹Í¥Ñ¥½¹Ì(¡ÁÉ•Á…É•ƒŠHÍÕ‰µ¥ÑÑ•ƒŠHÁ…¥¤ÍÑ…ä½Á•¸‰ä‘•Í¥¸èÁ…åµ•¹Ğ½¹Ñ¥¹Õ•Ì)±½¹œ…™Ñ•È•á•ÕÑ¥½¸™¥¹¥Í¡•Ì…¹µ½Ù•Ì¹¼ÅÕ…¹Ñ¥Ñä¸Q¡”HÜ¥Ñ•´µÉ•µ½Ù…°)ÁÉ½Á½Í…°É½ÕÑ”°İ¡¥ Ñ¡”Ñİ¼É•ÑÉ½™¥ĞÑÉ…­Ìµ•É•Á…ÍĞİ¥Ñ¡½ÕĞ)½¹Ù•ÉÑ¥¹œ°¹½ÜÑ…­•ÌÑ¡”Í…µ”İ½É­Ì±½¬…¹Ñ¡”Í…µ”Í¡…É•É•™ÕÍ…°…Ì)¥ÑÌÍ¥‰±¥¹œÁÉ½Á½Í…°É½ÕÑ•Ì¸Q¡”Õ¹™¥¹¥Í¡•µ¥Ñ•´İ½É­±¥ÍĞ…ÉÉ¥•ÌÑ¡”)%IQ%=8½˜•… ¥Ñ•´ÌÉ•µ•‘äƒŠP„]½É¬İ¥Ñ Ñ¡”•á•ÍÌµ‘•±¥Ù•ÉäÑ½±”)½¸…¸‰”½Ù•Èµ‘•±¥Ù•É•°…¹Ñ¡”HÜ™±½½ÈÉ•™ÕÍ•Ì…µ•¹‘¥¹œ‘½İ¸°Í¼)Ñ¡½Í”É½İÌ…É”Ñ½±Ñ¼…µ•¹Ñ¡”Í…¹Ñ¥½¹•ÅÕ…¹Ñ¥ÑäU@Ñ¼µ…Ñ Ñ¡”)‘•±¥Ù•Éä¥¹ÍÑ•…¸%¸Ñ¡”İ•ˆ±¥•¹Ğ°€‰=µ¥Ğ…¸¥Ñ•´ˆ™¥±•ÌÑ¡É½Õ Ñ¡”HÜ)É•µ½Ù…°Á…Ñ É…Ñ¡•ÈÑ¡…¸„ÅÕ…¹Ñ¥Ñä´À¡…¹”°…¹…¸¥Ñ•´…ÉÉå¥¹œ…¸)Õ¹‘•¥‘•½µ¥ÍÍ¥½¸Í¡½İÌ¥Ğ¸((ŒŒ5¥±•ÍÑ½¹”€ÜƒŠPÍ¥Ñ”µ…Ñ•É¥…°µ½Ù•µ•¹Ğ…¹‘½Õµ•¹Ğ½¹ÑÉ½°()M½Á”è((´%ÍÍÕ”¡…±±…¹Ì…Ì„™¥ÉÍĞµ±…ÍÌ‘½Õµ•¹Ğ€¡±•…ä±¥™•å±”è‘É…™ĞƒŠH(€¥ÍÍÕ•ƒŠH…¹•±±•°Á±ÕÌ±½…¸½É•ÑÕÉ¸ÑåÁ”ì¥¹‘•Á•¹‘•¹ĞÁ•Èµ]½É¬(€¹Õµ‰•É¥¹œìµ…¹Õ…°±¥¹•ÌÁ•Éµ¥ÑÑ•‰ä‘•Í¥¸¤É•½É‘¥¹œµ…Ñ•É¥…°µ½Ù¥¹œ(€™É½´ÍÑ½É”½½¹Í¥¹•”ÕÍÑ½‘äÑ¼Í¥Ñ”°‘¥ÍÑ¥¹Õ¥Í¡¥¹œÉ…¥±İ…äµ¥ÍÍÕ•(€™É½´½¹ÑÉ…Ñ½ÈµÁÉ½Ù¥‘•µ…Ñ•É¥…°ì(´ÅÕ…¹Ñ¥Ñäµ±•Ù•°¥¹ÍÑ…±±…Ñ¥½¸É•½É‘Ìİ¥Ñ ±½…Ñ¥½¸°…±½¹Í¥‘”Ñ¡”(€•á¥ÍÑ¥¹œÁ•ÈµÍ•É¥…°¥¹ÍÑ…±±…Ñ¥½¸™…ÑÌì(´½¹Í¥¹•”°±½…Ñ¥½¸°…¹Õ¹¥Ğµ…ÍÑ•ÉÌƒŠP­•ÁĞ¥¸Ñ¡¥Ìµ¥±•ÍÑ½¹”‰•…ÕÍ”(€¥¹ÍÑ…±±…Ñ¥½¸…¹%ÍÍÕ”¡…±±…¹Ì½¹ÍÕµ”Ñ¡•´€¡±•…ä¥¹ÍÑ…±±…Ñ¥½¸Á¥­Ì(€¥ÑÌ±½…Ñ¥½¸™É½´Ñ¡”µ…ÍÑ•È°¥¹±¥¹”µÉ•…Ñ…‰±”¤èÉ•Ñ¥É”µ¹½Ğµ‘•±•Ñ”°(€…±İ…åÌÍ¹…ÁÍ¡½Ğµ½¸µÕÍ”Í¼¥ÍÍÕ•‘½Õµ•¹ÑÌÍÑ…ä™É½é•¸ìÕ¹¥ÑÌÍ••‘•(€™É½´Ñ¡”Á…ÉÍ•ÈÌ…¹½¹¥…°±¥ÍĞìÍ¥¹…Ñ½Éä¹…µ•Ì©½¥¸Ñ¡”½É…¹¥Í…Ñ¥½¸(€ÁÉ½™¥±”ì(´İ…ÉÉ…¹Ñä½Õ…É…¹Ñ•”•ÉÑ¥™¥…Ñ”Á…”½¸Ñ¡”•±¥Ù•Éä¡…±±…¸è½Éœµ±•Ù•°(€Ñ•µÁ±…Ñ”Ñ•áĞ°É•¹‘•É•™É½´Ñ¡”¥ÍÍÕ•Í¹…ÁÍ¡½Ğ°Ñ•µÁ±…Ñ”Ù•ÉÍ¥½¸…¹(€½¹Ñ•¹Ğ¡…Í É•½É‘•ì(´Ñ¡”5¥±•ÍÑ½¹”€Ø…µ•¹‘µ•¹Ğ½…ÁÁÉ½Ù…°µ•¡…¹¥Í´•áÑ•¹‘ÌÑ¼¥ÍÍÕ•(€‘½Õµ•¹ÑÌè„İÉ½¹œ¡…±±…¸İ¥Ñ ‘½İ¹ÍÑÉ•…´•Ù¥‘•¹”€¡Õ¹™¥á…‰±”Í¥¹”(€Ñ¡”€ÈÀÈØ´Àà´Àà…¹•±±…Ñ¥½¸Á½±¥ä¤•ÑÌ…¸…ÁÁÉ½Ù…°µ…Ñ•(€…¹•°µ…¹µÉ•Á±…”½È…‘©ÕÍÑµ•¹Ğ‘½Õµ•¹ĞƒŠPÑ¡”ÁÉ½µ¥Í”µ¥É…Ñ¥½¸€ÀÀÀà(€…±É•…‘äµ…­•ÌƒŠP¹•Ù•È…¸•‘¥Ğ½˜Ñ¡”¥ÍÍÕ•Í¹…ÁÍ¡½Ğì(´Í•ÑÑ±•Í½Á”¹…ÉÉ½İ¥¹œè¥¹ÍÑ…±±…Ñ¥½¸µÉ•½ÉÅÕ…¹Ñ¥Ñä•‘¥ÑÌ…É”(€‘•±¥‰•É…Ñ•±ä…¹•°µ…¹µÉ”µÉ•½É¥¸Ñ¡¥Ìµ¥±•ÍÑ½¹”ƒŠPÑ¡•É”¥Ì¹¼(€…ÁÁÉ½Ù…°µ…Ñ•¥¸µÁ±…”¥¹ÍÑ…±±…Ñ¥½¸•‘¥ĞìÑ¡”…ÁÁÉ½Ù…°µ…Ñ•Ù…É¥…¹Ğ(€€¡±•…äƒ
œÔ¸Ğ¿
œÔ¸Ø°‰±½­•İ¡¥±”Í•É¥…±Ì…É”…ÑÑ…¡•¤¥Ì‘•™•ÉÉ•Ñ¼(€Ñ¡”5¥±•ÍÑ½¹”€Ø¼ÜÉ•ÑÉ½™¥Ğİ…Ù”ì(´Ñ•¹…¹Ğµİ¥‘”Í•É¥…°±½½­ÕÀ€¡İ½É¬µÍ½Á”™¥±Ñ•É•¤İ¥Ñ Ñ¡”™Õ±°ÑÉ…”°(€…¹•¹™½É•µ•¹Ğ½˜Ñ¡”É•ÅÕ¥É•Í}Í•É¥…±Í€™±…œ€¡ÍÑ½É•Í¥¹”µ¥É…Ñ¥½¸(€€ÀÀÀÄ°¹•Ù•È•¹™½É•¤èÍ•É¥…°½Õ¹ĞµÕÍĞ•ÅÕ…°Í¡¥ÁÁ•ÅÕ…¹Ñ¥Ñä…Ğ(€¥ÍÍÕ”¸5Õ±Ñ¥±¥¹”‰…Ñ …ÁÑÕÉ”…±É•…‘äÍ¡¥ÁÁ•¥¸5¥±•ÍÑ½¹”€ÔìÉ…¹”(€•áÁ…¹Í¥½¸…¹ÍÁÉ•…‘Í¡••Ğ¥µÁ½ÉĞÍÑ…ä•Ù¥‘•¹”µ…Ñ•¥¸5¥±•ÍÑ½¹”€ä¸()•±¥Ù•É•€ ÈÀÈØ´Àà´Àä°µ¥É…Ñ¥½¹Ì€ÀÀÄßŠLÀÀÄäÁ±ÕÌÑ¡”É•Ù¥•Üµ¡…É‘•¹¥¹œ)Á…ÍÌ¥¸€ÀÀÈÌ¤èÅÕ…¹Ñ¥Ñäµ±•Ù•°¥¹ÍÑ…±±…Ñ¥½¸É•½É‘Ìİ¥Ñ ¥¹±¥¹”µÉ•…Ñ…‰±”)±½…Ñ¥½¸Í¹…ÁÍ¡½ÑÌ°Í•É¥…°…ÑÑ…¡µ•¹Ğ……¥¹ÍĞÑ¡”‘•±¥Ù•É•Á½½°°…¹)•á…Ğµ…É¥Ñ¡µ•Ñ¥Œ…ÁÌÕ¹‘•ÈÉ½Ü±½­ÌìÑ¡”İ…ÉÉ…¹Ñä½Õ…É…¹Ñ•”)•ÉÑ¥™¥…Ñ”…ÌÁ…”€È½˜Ñ¡”•±¥Ù•Éä¡…±±…¸°™É½é•¸¥¹Ñ¼Ñ¡”¥ÍÍÕ•)Í¹…ÁÍ¡½Ğİ¥Ñ Ñ•µÁ±…Ñ”Ù•ÉÍ¥½¸…¹½¹Ñ•¹Ğ¡…Í ìÑ¡”½ÉÉ•Ñ¥½¸™±½Ü)Ñ¡É½Õ Ñ¡”5¥±•ÍÑ½¹”€Ø…ÁÁÉ½Ù…°•¹¥¹”ƒŠP•Ù¥‘•¹”µ™É•”¥ÍÍÕ•)‘½Õµ•¹ÑÌ•Ğ…ÁÁÉ½Ù…°µ…Ñ•…¹•°µ…¹µÉ•Á±…”İ¥Ñ ÁÉ½Ù•¹…¹”°)•Ù¥‘•¹”µ±½­•½¹•Ì•Ğ…Á±•ÍÌ¹Õµ‰•É•½ÉÉ•Ñ¥½¸¹½Ñ¥•Ì°…¹)‘•¥‘•ÉÌÉ•Ù…±¥‘…Ñ”Ñ¡”‘½Õµ•¹Ğ…ÕÑ¡½É¥Ñ¥•Ì…Ğ…ÁÁ±äÑ¥µ”ì¥ÍÍÕ”)¡…±±…¹Ì©½¥¹•Ñ¡”Ñ¥µ•±¥¹”…¹•áÁ½ÉĞìÑ¡”…µ•¹‘µ•¹Ğ™±½½È¥¹±Õ‘•Ì)¥¹ÍÑ…±±•ÅÕ…¹Ñ¥Ñ¥•Ì¸Q¡”½¹Ñ…ÑÌÕ¹¥™¥…Ñ¥½¸€ ÈÀÈØ´Àà´Àä°µ¥É…Ñ¥½¸€ÀÀÈà¤ÕÁÉ…‘•Ñ¡”½¹Í¥¹•”µ…ÍÑ•È¥¹Ñ¼Ñ¡”É½±”µ™±…•½¹Ñ…ÑÌ)µ½‘•°ƒŠP½¹Í¥¹•”É½±”…Ñ¥Ù”°Ù•¹‘½È½±¥•¹Ğ‘½Éµ…¹ĞÕ¹Ñ¥°ÁÉ½ÕÉ•µ•¹Ğ+ŠPİ¥Ñ MQ%8Ù…±¥‘…Ñ¥½¸€¡‘•‘ÕÑ½ÈƒŠ™€…•ÁÑ•¤°HÄØ…ÕÑ¡½É¥Ñä)É•™ÕÍ…°°…¹Á•Èµ]½É¬½¹Í¥¹•”…ÍÍ½¥…Ñ¥½¹Ì¸()á¥Ğè„µ…Ñ•É¥…°Õ¹¥Ğ…¸‰”ÑÉ…•…İ…É‘•ƒŠH‘•±¥Ù•É•ƒŠHÉ••¥Ù•ƒŠH)¥ÍÍÕ•Ñ¼Í¥Ñ”ƒŠH¥¹ÍÑ…±±•°¥¹±Õ‘¥¹œ¥ÑÌ‘½Õµ•¹ÑÌ°ÕÍÑ½‘ä°Í•É¥…°)¥‘•¹Ñ¥Ñä°…¹±½…Ñ¥½¸°…¹„İÉ½¹œ¥ÍÍÕ•‘½Õµ•¹Ğ¡…Ì„±…İ™Õ°)½ÉÉ•Ñ¥½¸Á…Ñ Ñ¡…ĞÁÉ•Í•ÉÙ•ÌÑ¡”½É¥¥¹…°ƒŠPµ•Ğ(¡…ÁÁÌ½Í•ÉÙ•È½Ñ•ÍĞ½¥¹ÍÑ…±±…Ñ¥½¹Ì¹¥¹Ñ•É…Ñ¥½¸¹Ñ•ÍĞ¹ÑÍ€°)½ÉÉ•Ñ¥½¹Ì¹¥¹Ñ•É…Ñ¥½¸¹Ñ•ÍĞ¹ÑÍ€°¡…±±…¹Ì¹¥¹Ñ•É…Ñ¥½¸¹Ñ•ÍĞ¹ÑÍ€¤¸((ŒŒ5¥±•ÍÑ½¹”€àƒŠPÍÑ…”µİ¥Í”5•…ÍÕÉ•µ•¹Ğ	½½¬±¥™•å±”…¹Á…åµ•¹Ğ•±¥¥‰¥±¥Ñä((¡I•¹…µ•™É½´€‰ÍÑ…”µİ¥Í”Á…åµ•¹Ğ•±¥¥‰¥±¥Ñäˆ…™Ñ•ÈÑ¡”Í•½¹…Õ‘¥Ñ½È)É•Ù¥•ÜèÑ¡”±•…äÍÁ•Œ‘•™¥¹•Ì„5•…ÍÕÉ•µ•¹Ğ	½½¬±¥™•å±”°¹½Ğ©ÕÍĞ„)‰¥±°™½ÉµÕ±„¸H´ÀÀÀØÉ•½É‘ÌÑ¡”Í•ÑÑ±•‘•Í¥¸¸¤()M½Á”è((´¥Ñ•´Á…åµ•¹Ğ…Ñ•½É¥•Ì…ÍÍ¥¹•…Ğ1=É•Ù¥•Ü°…¹„Á•Èµ]½É¬Á…åµ•¹Ğ(€µ…ÑÉ¥à­•å•‰ä…Ñ•½ÉäƒŠP•… …Ñ•½Éä‘•™¥¹•ÌÍÕÁÁ±ä°¥¹ÍÑ…±±…Ñ¥½¸°(€A°…¹™¥¹…°µ‰¥±°Á•É•¹Ñ…•ÌÍÕµµ¥¹œ•á…Ñ±äÑ¼€ÄÀÀìÁ•ÈÑ¡”±•…ä(€Í•ÑÑ±•‘•¥Í¥½¸Ñ¡•É”¥Ì‘•±¥‰•É…Ñ•±ä¹¼Á•Èµ¥Ñ•´Á•É•¹Ñ…”µ•¹ÑÉä(€¥¹Ñ•É™…”ì(´A•ÉÑ¥™¥…Ñ•ÌÉ•½É‘¥¹œ•ÉÑ¥™¥•ÅÕ…¹Ñ¥Ñ¥•ÌÁ•È¥Ñ•´°…ÁÁ•…Ğ(€¥¹ÍÑ…±±•µµ¥¹ÕÌµ…±É•…‘äµ•ÉÑ¥™¥•ì(´ÍÑ…”µİ¥Í”‰¥±°ÁÉ•Á…É…Ñ¥½¸è•±¥¥‰±”ÍÑ…”ÅÕ…¹Ñ¥Ñäƒ\…ÕÑ¡½É¥Ñ…Ñ¥Ù”(€É…Ñ”ƒ\ÍÑ…”Á•É•¹Ñ…”ƒŠ"HÁÉ•Ù¥½ÕÍ±ä‰¥±±•™½ÈÑ¡…ĞÍÑ…”°¥¸•á…Ğ(€‘•¥µ…°…É¥Ñ¡µ•Ñ¥Œ°İ¥Ñ Á•ÈµÍÑ…”‰¥±±•µ•µ½ÉäÍ¼¹¼ÍÑ…”…¸‰”(€‰¥±±•Ñİ¥”ì(´•Ù•Éä™¥¹…±¥Í•5…¹‰¥±°Í¹…ÁÍ¡½ÑÌÑ¡”¥Ñ•´Ì…Ñ•½Éä…ÍÍ¥¹µ•¹Ğ°(€Ñ¡”É•Í½±Ù•Á•É•¹Ñ…•Ì°•±¥¥‰±”ÍÑ…”ÅÕ…¹Ñ¥Ñ¥•Ì°É…Ñ•Ì°…¹ÁÉ¥½È(€‰¥±±•…µ½Õ¹ÑÌƒŠP¡…¹¥¹œÑ¡”]½É¬µ…ÑÉ¥à±…Ñ•È¹•Ù•È…±Ñ•ÉÌ„(€™¥¹…±¥Í•É•½Éì(´½µÁ•¹Í…Ñ¥¹œ•¹ÑÉ¥•Ì™½È½ÉÉ•Ñ¥½¹ÌƒŠPÁ…¥‰¥±±Ì…É”¹•Ù•ÈÉ•İÉ¥ÑÑ•¸¸()Q¡”µ…ÑÉ¥àÍ¡•µ„±…¹‘Ì‰•™½É”Ñ¡”™¥ÉÍĞ‘•Í¥¸Á…ÉÑ¹•ÈÁÉ•Á…É•Ì„‰¥±°è)‰¥±±Ì…É”¥µµÕÑ…‰±”…¹Õ¹‘•±•Ñ…‰±”°Í¼„€ÄÀÀ”µ½˜µµ•…ÍÕÉ•‰¥±°½¸„)ÍÑ…•½¹ÑÉ…Ğİ½Õ±‰”„Á•Éµ…¹•¹Ñ±äİÉ½¹œ™¥¹…¹¥…°É•½É¸Q¡”)É¥¡•Èµ…Ñ¡Ì…±É•…‘ä‘•™•ÉÉ•€¡Í•ÕÉ¥Ñä‘•Á½Í¥Ğ‘•‘ÕÑ¥½¹Ì°ÁÉ¥”)Ù…É¥…Ñ¥½¸¤ÍÑ¥±°İ…¥Ğ™½È„Á…ÉÑ¹•ÈÌÉ•…°‰¥±°™½Éµ…Ğ¸()•±¥Ù•É•€ ÈÀÈØ´Àà´Àä°µ¥É…Ñ¥½¹Ì€ÀÀÈÇŠLÀÀÈÜ¤è¥Ñ•´Á…åµ•¹Ğ…Ñ•½É¥•Ì)İ¥Ñ Ñ¡”Á•Èµ]½É¬µ…ÑÉ¥à€¡™½ÕÈ…Ñ•½É¥•ÌÁ±ÕÌ…¸½ÁÑ¥½¹…°U9Q=I%M)É½Üì™¥¹…±¥é…Ñ¥½¸¹…µ•Ì•Ù•ÉäÕ¹É•Í½±Ù•¥Ñ•´ìHÄÀ¡½¹½ÕÉ•ƒŠP¹¼)Á•Èµ¥Ñ•´Á•É•¹Ñ…•Ì¤ìA•ÉÑ¥™¥…Ñ•Ìİ¥Ñ Ñ¡”HÄà)¥¹ÍÑ…±±•µµ¥¹ÕÌµ½Ù•É•…ÀÕ¹‘•ÈÉ½Ü±½­Ì°½¹Í¥¹•”Í¹…ÁÍ¡½ÑÌ°…¹)‘¥ÍÁ±…äµ½¹±äÉ•±•…Í•Ù…±Õ•ÌìÑ¡”5•…ÍÕÉ•µ•¹Ğ	½½¬±¥™•å±”Á•È)H´ÀÀÀØƒŠP‘…Ñ…‰…Í”µ•¹™½É•½¹”µ±¥Ù”µ5µÁ•ÈµÍ½ÕÉ”°‘É…™ĞÉ•½µÁÕÑ”°)…Á±•ÍÌ€ñİ½É­}½‘”øµ5µ99€™¥¹…±¥Í…Ñ¥½¸Í¹…ÁÍ¡½ÑÑ¥¹œ…Ñ•½É¥•Ì°)Á•É•¹Ñ…•Ì°É…Ñ•Ì°Á•ÈµÍÑ…”‘•±Ñ…Ì…¹ÑÉÕ”µÕµÕ±…Ñ¥Ù”ÁÉ¥½ÉÌ°)¹•İ•ÍĞµ±¥Ù”µ½¹±ä…¹•°€¡İ½É­ÌµÉ½ÜÍ•É¥…±¥Í•İ¥Ñ ‰…­ÍÑ½ÁÌ¤°)™¥¹…°µ5Íİ••À•¹™½É•µ•¹Ğİ¥Ñ „Á½ÍĞµ™¥¹…°Í½ÕÉ”™É••é”°…¹HÄä)½¡•É•¹”Õ…É‘Ì‰½Ñ ‘¥É•Ñ¥½¹Ì…ĞA$…¹‘…Ñ…‰…Í”±•Ù•°ì‰¥±±Ì)ÁÉ•Á…É•€ÄèÄ™É½´™¥¹…±¥é•5	Ì€¡Ñ¡”5¥±•ÍÑ½¹”€Ôµ•…ÍÕÉ•µÅÕ…¹Ñ¥Ñä)Íİ••À¥ÌÉ•Ñ¥É•¤ìÑ¡”½¹ÑÉ…ÑÕ…°5É•µ…É¬…±½É¥Ñ¡´ÁÉ½Ù•¸)¡…É…Ñ•Èµ™½Èµ¡…É…Ñ•È……¥¹ÍĞÑ¡”…•¹äİ½É­‰½½¬™¥áÑÕÉ”ìÑ¡”5)‘½Õµ•¹Ğİ¥Ñ IPİ…Ñ•Éµ…É¬°%90	%10‰…¹¹•È°…¹%¹‘¥…¸µÍåÍÑ•´)…µ½Õ¹Ğ¥¸İ½É‘ÌìÉ…Ñ•Ì…ĞÍ¥àµ‘•¥µ…°ÁÉ•¥Í¥½¸•¹Ñ¼•¹€¡…µ½Õ¹ÑÌ)ÍÑ…äÑİ¼µ‘•¥µ…°Á•ÈHÄÌ¤¸()á¥ĞèÑ¡”™¥ÉÍĞÍÑ…”µ‰…Í•‰¥±°¥Ì½µÁÕÑ••¹Ñ¥É•±ä™É½´É•½É‘•)½¹ÑÉ…ĞÑ•ÉµÌ…¹½Á•É…Ñ¥½¹…°•Ù¥‘•¹”°İ¥Ñ ¹¼Á…åµ•¹ĞÁ•É•¹Ñ…•Ì)…±Õ±…Ñ•¥¸…¸•áÑ•É¹…°ÍÁÉ•…‘Í¡••ĞƒŠPµ•Ğ(¡…ÁÁÌ½Í•ÉÙ•È½Ñ•ÍĞ½µ•…ÍÕÉ•µ•¹Ğµ‰½½­Ì¹¥¹Ñ•É…Ñ¥½¸¹Ñ•ÍĞ¹ÑÍ€°)µˆµÉ•µ…É¬¹Ñ•ÍĞ¹ÑÍ€……¥¹ÍĞ)…ÁÁÌ½Í•ÉÙ•È½Ñ•ÍĞ½™¥áÑÕÉ•Ì½µˆµÉ•µ…É¬µİ½É­‰½½¬¹ØÄ¹©Í½¹€¤¸((ŒŒ1•…äØÄÕÑ½Ù•È()Q¡”±¥Ù”ØÄÍåÍÑ•´€¡ME1¥Ñ”¤¡½±‘ÌÉ•…°ÁÉ½‘ÕÑ¥½¸‘…Ñ„ƒŠP€ÌĞİ½É­Ì°(ØÔÀ‘•±¥Ù•Éä¡…±±…¹Ìİ¥Ñ Í•É¥…±Ì…É½ÍÌÑİ¼±•…°•¹Ñ¥Ñ¥•ÌƒŠP…¹)ÍÑ½ÁÌ…Ğ±…Õ¹ ¸•±¥Ù•É•€ ÈÀÈØ´Àà´Àä°µ¥É…Ñ¥½¸€ÀÀÈÔ¤èÑ¡”¥‘•µÁ½Ñ•¹Ğ)ÕÑ½Ù•È¥µÁ½ÉÑ•È€¡ÍÉ¥ÁÑÌ½¥µÁ½ÉĞµØÄ¹ÑÍ€¤İ¥Ñ …ÁÁ•¹µ½¹±ä¥µÁ½ÉĞ)ÁÉ½Ù•¹…¹”°•á…ĞÁÉ•Í•ÉÙ…Ñ¥½¸½˜ÁÉ¥¹Ñ•¡…±±…¸¹Õµ‰•ÉÌ€¡¥¹±Õ‘¥¹œ)ÍÕ™™¥á•½¹•Ì¤°¡¥ÍÑ½É¥…°Ñ¥µ•ÍÑ…µÁÌ°½Õ¹Ñ•È½¹Ñ¥¹Õ¥Ñä…™Ñ•ÈÑ¡”)¡¥¡•ÍĞ¡¥ÍÑ½É¥…°¹Õµ‰•È°Í•É¥…°Á…ÉÍ¥¹œİ¥Ñ ¹…µ••á•ÁÑ¥½¹Ì(¡¹•Ù•ÈÍ¥±•¹Ğ‘•‘ÕÀ°É…¹•Ì¹•Ù•È™…‰É¥…Ñ•¤°‘•Ñ•Éµ¥¹¥ÍÑ¥Œ)ÅÕ…¹Ñ¥é…Ñ¥½¸İ¥Ñ ¡½¹•ÍĞ‘É¥™Ğ…½Õ¹Ñ¥¹œ°Á•Èµ½É…¹¥Í…Ñ¥½¸)É•½¹¥±¥…Ñ¥½¸É•Á½ÉÑÌ°…¹‘ÉäµÉÕ¸É½±±‰…¬¸Q¡”ÕÑ½Ù•ÈÉÕ¹‰½½¬¥Ì)¥¸‘½Ì½=AIQ%=9L¹µè‘ÉäµÉÕ¸¹½Ü°™É••é”ØÄ…Ğ±…Õ¹ °™¥¹…°‰…­ÕÀ°)…ÁÁ±ä°É•½¹¥±”°¥¹Ù¥Ñ”ÕÍ•ÉÌ¸…Ñ„µÅÕ…±¥Ñä•á•ÁÑ¥½¹Ì™½Õ¹¥¸Ñ¡”)É•…°‰…­ÕÀİ•É”‘•±¥Ù•É•Ñ¼Ñ¡”½Á•É…Ñ½È™½È½ÉÉ•Ñ¥½¸¥¸ØÄ‰•™½É”)Ñ¡”™¥¹…°ÉÕ¸¸((ŒŒ5¥±•ÍÑ½¹”€äƒŠPÁÉ½ÕÉ•µ•¹Ğ…¹Á…É…±±•°µ•…ÍÕÉ•µ•¹Ğ()•±¥Ù•É•€ ÈÀÈØ´Àà´ÄÀ°µ¥É…Ñ¥½¹Ì€ÀÀÌÏŠLÀÀÌĞ¤è((´Ù•¹‘½È½¹Ñ…ÑÌ°ÁÕÉ¡…Í”½É‘•ÉÌİ¥Ñ ]½É¬µ¥Ñ•´±¥¹•Ì°…Á±•ÍÌ¥ÍÍÕ”°(€¥µµÕÑ…‰±”Ù•¹‘½È½±¥¹”Í¹…ÁÍ¡½ÑÌ°É••¥ÁĞµ…İ…É”±½ÍÕÉ”°…¹…¹•±±…Ñ¥½¸ì(´]½É¬µ¥¹‘•Á•¹‘•¹Ğ‰Õ‘•Ñ…ÉäÅÕ½Ñ…Ñ¥½¹Ìİ¥Ñ ‘É…™Ğ°¥ÍÍÕ”°½ÕÑ½µ”°…¹(€…¹•±±…Ñ¥½¸±¥™•å±•Ìì(´ÍÕÁÁ±¥•ÈÍÑ…Ñ”Á±ÕÌ½ÁÑ¥½¹…°]½É¬µ¥Ñ•´!M8½M°MPÉ…Ñ”°…¹½½‘Ì½Í•ÉÙ¥”(€™…ÑÌ¹••‘•‰äÁÉ½ÕÉ•µ•¹Ğ…¹ÍÑ…ÑÕÑ½Éä‘½Õµ•¹ÑÌì(´É•½É5•…ÍÕÉ•µ•¹Ğ	½½­Ì™½ÈÁ…É…±±•°½¹Í¥¹•”µ•…ÍÕÉ•µ•¹Ğ°µ•É”¥¹Ñ¼…¸(€½¸µ…½Õ¹Ğ‘É…™Ğ°…¹™¥¹…°5•…ÍÕÉ•µ•¹Ğ	½½­ÌÑ¡…Ğ±½Í”™ÕÉÑ¡•Èµ•…ÍÕÉ•µ•¹Ğ¸((ŒŒ5¥±•ÍÑ½¹”€ÄÀƒŠPMP¥¹Ù½¥•Ì…¹”µİ…ä‰¥±±Ì()•±¥Ù•É•±½…±±ä€ ÈÀÈØ´Àà´ÄÀÑ¡É½Õ €ÈÀÈØ´Àà´ÄÈ°µ¥É…Ñ¥½¹Ì€ÀÀÌ×ŠLÀÀĞÔ¤è((´‘¥É•Ğ…¹™¥¹…±¥é•µ5µ‰…­•MP¥¹Ù½¥•Ìİ¥Ñ ‘É…™Ğ°ÍÕ‰µ¥ÑÑ•°…¹(€…¹•±±•±¥™•å±•Ìì(´½¹™¥ÕÉ…‰±”½É…¹¥Í…Ñ¥½¸¹Õµ‰•É¥¹œÑ•µÁ±…Ñ•Ì°™¥¹…¹¥…°µå•…È½Õ¹Ñ•ÉÌ°(€‰Õå•È‘¥Ù¥Í¥½¸Ñ½­•¹Ì°‘¥É•Ğµ¥¹Ù½¥”Ù…±Õ•Ì°…¹¡½ÕÍ”‘•™…Õ±ÑÌì(´•á…Ğ¥¹ÑÉ„µÍÑ…Ñ”MP½MMP½È¥¹Ñ•ÈµÍÑ…Ñ”%MPÍÁ±¥Ğ°İ¡½±”µÉÕÁ•”É½Õ¹‘¥¹œ°(€¥µµÕÑ…‰±”ÍÕÁÁ±¥•È½‰Õå•È½Í¡¥ÀµÑ¼Í¹…ÁÍ¡½ÑÌ°…µ½Õ¹Ğ¥¸İ½É‘Ì°…¹(€É•¹‘•ÈµÉ•…‘ä¥¹Ù½¥”‘…Ñ„¸I•Ù•ÉÍ”¡…É”¥Ì…¸•áÁ±¥¥Ğ™…Ğì¥ÍÍÕ”…•ÁÑÌ(€½¹™¥Éµ•™½Éİ…É¡…É”…¹É•™ÕÍ•ÌÑ¡”Õ¹ÍÕÁÁ½ÉÑ•É•Ù•ÉÍ”µ¡…É”‰É…¹ ì(´‘•Ñ•Éµ¥¹¥ÍÑ¥Œ%I@Í¡•µ„€Ä¸Ä…¹9%”µİ…äµ‰¥±°Á…å±½…‘Ì°…ÁÁ•¹µ½¹±ä%I8¼(€…­¹½İ±•‘•µ•¹Ğ½Í¥¹•µEH•Ù¥‘•¹”°”µİ…ä¹Õµ‰•È½Ù…±¥‘¥Ñä•Ù¥‘•¹”°…¹(€…¹•±±…Ñ¥½¸½É‘•É¥¹œÑ¡…ĞÉ•™ÕÍ•Ì…¸¥¹Ù½¥”…¹•±±…Ñ¥½¸İ¡¥±”„±¥Ù”(€”µİ…ä‰¥±°•á¥ÍÑÌì(´•áÁ±¥¥ĞÍ•±±•È°‰Õå•È°…¹Í¡¥ÀµÑ¼9%±½…±¥Ñä°¹•Ù•È¥¹™•ÉÉ•™É½´…¸(€…‘‘É•ÍÌì(´ÁÉ½Ù¥‘•Èµ¹•ÕÑÉ…°ÑÉ…¹ÍÁ½ÉĞÁ±ÕÌÑ¡”½Á•É…Ñ½ÈµÑÉ¥•É•]¡¥Ñ•‰½½­ÌÉ%I@(€É•¥ÍÑ•È°‘½Õµ•¹Ğ±½½­ÕÀ°…¹…¹•±±…Ñ¥½¸…‘…ÁÑ•Èì(´‘ÕÉ…‰±”ÁÉ½Ù¥‘•Èµ½Á•É…Ñ¥½¸±•…Í•Ì°½ÉÉ•±…Ñ¥½¸¥‘Ì°É•ÅÕ•ÍĞ¡…Í¡•Ì°™…¥±•(€…¹Õ¹­¹½İ¸ÍÑ…Ñ•Ì°±½½­ÕÀµ½¹±äÉ•½¹¥±¥…Ñ¥½¸°ÍÑ…±”µ½Á•É…Ñ¥½¸É•½Ù•Éä°(€…¹•áÁ±¥¥Ğµ…¹Õ…°µÕ¹Ù•É¥™¥•…¹•±±…Ñ¥½¸½¹™¥Éµ…Ñ¥½¸ì(´Í•Á…É…Ñ”µİ…ä	¥±°A$…ÕÑ¡•¹Ñ¥…Ñ¥½¸…¹±¥•¹ĞÉ•‘•¹Ñ¥…±Ì™½ÈÍÑ…¹‘…±½¹”(€]…¹•±±…Ñ¥½¸ì(´½¹Í•ÉÙ…Ñ¥Ù”±•…äµ•Ù¥‘•¹”µ…É­•ÉÌİ¡•É”µ¥É…Ñ•Á½ÉÑ…°Ñ•áĞ…¹¹½Ğ‰”(€ÁÉ½Ù••á…Ğì(´™É•Í ]•¹•É…Ñ¥½¸…¹9%Á…å±½…•áÁ½ÍÕÉ”‰±½­•™½ÈÑ¡”ÕÉÉ•¹Ğ(€ÕµÕ±…Ñ¥Ù”MÍ•ÉÙ¥”¥¹Ù½¥”°İ¡¥±”¡¥ÍÑ½É¥…°É•½É‘ÌÉ•µ…¥¸É•…‘…‰±”°(€É•½¹¥±…‰±”°…¹…¹•±±…‰±”ì(´‘•Ñ•Éµ¥¹¥ÍÑ¥ŒÑ…àµ¥¹Ù½¥”!Q50½AÉ•¹‘•É¥¹œ™É½´™É½é•¸™…ÑÌ°É•…°MYEH(€•¹½‘¥¹œ½˜Í¥¹•%I@•Ù¥‘•¹”°…ÁÁ•¹µ½¹±äÉ•¹‘•ÈÙ•ÉÍ¥½¹Ì°™É½é•¸µ±½¼…¹(€Í½ÕÉ”½A¡…Í¡•Ì°Ñ•¹…¹Ğµ­•ä‘…Ñ…‰…Í”Õ…É‘Ì°Ù•É¥™¥•‘½İ¹±½…‘Ì°…¹(€É•Ñ…¥¹•É•……•ÍÌ…™Ñ•È…¹•±±…Ñ¥½¸ì(´‘…Ñ…‰…Í”‘•±•Ñ”Õ…É‘ÌÁÉ•Í•ÉÙ”¥ÍÍÕ•½µ…¹Õ…°½ÁÉ½Ù¥‘•ÈµÑ½Õ¡•ÍÑ…ÑÕÑ½Éä(€É•½É‘Ì°…¹Ñ¡”±•…äµ•Ù¥‘•¹”±…ÍÍ¥™¥•È¥ÌÁÉ½Ù•¸…É½ÍÌÑ¡”ÍÑ…•(€€ÀÀĞËŠHÀÀĞÏŠHÀÀĞĞÕÁÉ…‘”Á…Ñ İ¥Ñ ¥ÑÌÕÁ‘…Ñ”Õ…É‘ÌÉ”µ•¹…‰±•ì(´¹½Éµ…±¥é•5•…ÍÕÉ•µ•¹Ğ	½½¬µ•É”ÁÉ½Ù•¹…¹”°Á•Èµ]½É¬½Ù•¹‘½ÈA<‘É…™ÑÌ°(€¥µµÕÑ…‰±”¥ÍÍÕ•A<½	DÁ…É•¹ÑÌ°…¹…ÕÑ½µ…Ñ¥ŒA<É•½Á•¹¥¹œİ¡•¸„±¥¹­•(€¡…±±…¸…¹•±±…Ñ¥½¸É•±•…Í•ÌÉ••¥ÁĞÅÕ…¹Ñ¥Ñäì(´•áÁ½ÉĞµØá€°¥¹±Õ‘¥¹œÕÉÉ•¹Ğµ…ÍÑ•ÉÌ°ÁÉ½ÕÉ•µ•¹Ğ°ÍÑ…ÑÕÑ½Éä‘½Õµ•¹ÑÌ°(€ÁÉ½Ù¥‘•Èµ½Á•É…Ñ¥½¸…¹5µµ•É”¡¥ÍÑ½Éä°¥µÁ½ÉĞÁÉ½Ù•¹…¹”°•Ù•ÉäÉ•Ñ…¥¹•(€É•¹‘•È°¹Õµ‰•È½Õ¹Ñ•ÉÌ°…¹½‰©•Ğ•Ù¥‘•¹”ì(´™Õ±°I1L°İ½É¬µÍ½Á”°…ÕÑ¡½É¥Ñä°…Õ‘¥Ğ°½¹ÕÉÉ•¹ä°±¥™•å±”°…¹‘…Ñ…‰…Í”(€‰…­ÍÑ½ÀÑ•ÍÑÌ™½ÈÑ¡”¹•ÜÉ•½É‘Ì¸()I•µ…¥¹¥¹œè±¥Ù”]¡¥Ñ•‰½½­ÌÍ…¹‘‰½à½ÁÉ½‘ÕÑ¥½¸•ÉÑ¥™¥…Ñ¥½¸°ÁÉ½Ù¥‘•ÈµÍÁ•¥™¥Œ)µ•ÑÉ¥Ì…¹…±•ÉÑÌ°…¸½É…¹¥Í…Ñ¥½¸µİ¥‘”İ½É­ÍÁ…”™½È‘¥É•Ğ¥¹Ù½¥•Ì°Ñ¡”)ÍÑ…¥¹œ½Ñ•¹‰•ÉœÁÉ½½˜°…¹Ñ¡”™½ÕÍ•ÁÉ½‘ÕÑ¥½¸Í•ÕÉ¥ÑäÉ•Ù¥•Ü¸AÉ½Ù¥‘•È)…Ñ¥½¹ÌÉ•µ…¥¸½Á•É…Ñ½ÈµÑÉ¥•É•…¹…Õ‘¥Ñ…‰±”°¹•Ù•ÈÕ¹…ÑÑ•¹‘•™¥±¥¹œ¸((ŒŒ5¥±•ÍÑ½¹”€ÄÄƒŠP½¹ÑÉ…ĞµÍ½ÕÉ”¥¹Ñ…­”…¹ÁÉ½‘ÕĞ•áÁ•É¥•¹”()•±¥Ù•É•½¸Ñ¡”€ÈÀÈØ´Àà´ÄÄµ•É”…¹‘¥‘…Ñ”€¡µ¥É…Ñ¥½¸€ÀÀĞÀ¤è((´½ÁÑ¥½¹…°9%P°½¹ÑÉ…ĞÉ••µ•¹Ğ°…¹Ñ•¹‘•È½ÍÁ•¥™¥…Ñ¥½¸AÌÕ¹‘•ÈÑ¡”(€1=Á…­…”°…•ÁÑ•½¹±äİ¡•¸Ñ•¹‘•È¹Õµ‰•È…¹¹…µ”½˜İ½É¬µ…Ñ ì(´½µÁ±•µ•¹Ñ…ÉäA½ÁÁ±•È±…å½ÕĞ½É…Ü•áÑÉ…Ñ¥½¸Ñ¡…ĞÁÉ•Í•ÉÙ•Ì•á…Ğ1=¥Ñ•´(€‘•ÍÉ¥ÁÑ¥½¹Ì…É½ÍÌİÉ…ÁÁ•±¥¹•Ì…¹Á…”‰É•…­Ìì(´…‘Ù•ÉÑ¥Í•µÙ…±Õ”É•½¹¥±¥…Ñ¥½¸™½ÈÁÉ¥¹Ñ•¥Ñ•´É½İÌ°İ¥Ñ Á•É•¹Ñ…”…¹(€Í¡•‘Õ±”ÁÉ¥¥¹œ•áÁ±…¥¹¥¹œ…•ÁÑ•½¹ÑÉ…ĞÙ…±Õ”¥¹ÍÑ•…½˜™…±Í”µ¥ÍÍ¥¹œ(€µ½¹•äì(´Ñ…Í¬µ™¥ÉÍĞ¹…Ù¥…Ñ¥½¸°]½É¬µ•¹ÑÉ••á•ÕÑ¥½¸°É•ÍÁ½¹Í¥Ù”½µ½‰¥±”Í¡•±±Ì°…¹(€•áÁ±¥¥Ğ±½…‘¥¹œ°•µÁÑä°•ÉÉ½È°É•ÑÉä°Á•Éµ¥ÍÍ¥½¸°…¹‰±½­•µ…Ñ¥½¸ÍÑ…Ñ•Ìì(´Í…™”‘…Ñ…‰…Í”µÕ¹…Ù…¥±…‰±”É•ÍÁ½¹Í•ÌÑ¡…ĞÁÉ•Í•ÉÙ”É•Ù¥•Ü•‘¥ÑÌ…¹¥¹±Õ‘”„(€É•ÅÕ•ÍĞÉ•™•É•¹”¸((ŒŒI•µ…¥¹¥¹œ•Ù¥‘•¹”µ…Ñ•‘•ÁÑ ((´á•°]½É¬µ¥Ñ•´¥µÁ½ÉĞİ¥Ñ Ù…±¥‘…Ñ¥½¸°µ…ÁÁ¥¹œÁÉ•Ù¥•Ü°…¹(€É•Ù¥•Üµ‰•™½É”µ…•ÁĞƒŠP™¥ÉÍĞÉ•…°±•ÑÑ•È½È	=DÑ¡”AÁ…Ñ …¹¹½ĞÍ•ÉÙ”ì(´½É…¹¥Í…Ñ¥½¸µİ¥‘”…Õ‘¥ĞÍ•…É ƒŠP™¥ÉÍĞ¥¹Ù•ÍÑ¥…Ñ¥½¸Ñ¡”Á•Èµ]½É¬Ñ¥µ•±¥¹”(€…¹¹½Ğ…¹Íİ•Èì(´ÍÑ…¹‘…±½¹”½¹½¸µ]½É¬µ…Ñ•É¥…°µ½Ù•µ•¹ÑÌƒŠPÉ•…°‘•µ…¹½¹±äìÑ¡¥Ì™½É­Ì]½É¬(€Í½Á”°¹Õµ‰•É¥¹œ°…¹1=µ‘…Ñ”¥¹Ù…É¥…¹ÑÌì(´‰É½…É•Á½ÉÑ¥¹œ°‘•Á…ÉÑµ•¹Ğ•áÁ…¹Í¥½¸°…¹Á•Èµ‘½Õµ•¹ĞÍ¥¹…Ñ½ÉäÍ•±•Ñ¥½¸(€İ¡•¸Á…ÉÑ¹•È•Ù¥‘•¹”‘•™¥¹•ÌÑ¡”É•ÅÕ¥É•½ÕÑÁÕÑÌ¸((ŒŒ•™•ÉÉ•Õ¹Ñ¥°ÕÍ…”ÁÉ½Ù•Ì‘•µ…¹((´Õ¹…ÑÑ•¹‘•½‰…­É½Õ¹ÍÑ…ÑÕÑ½Éä™¥±¥¹œİ¥Ñ¡½ÕĞ…¸½Á•É…Ñ½ÈµÙ¥Í¥‰±”ÁÉ½Ù¥‘•ÈÉ•ÅÕ•ÍĞ°(€É•ÍÁ½¹Í”°…¹…Õ‘¥ĞÑÉ…¥°ì(´‰É½…É•Á½ÉÑ¥¹œì(´‘•Á…ÉÑµ•¹Ğ•áÁ…¹Í¥½¸ì(´•¹Ñ•ÉÁÉ¥Í”MM<½ÕÍÑ½´Á½±¥ä•¹¥¹”ì(´½™™±¥¹”Íå¹Œ…¹¹…Ñ¥Ù”µ½‰¥±”ì(´•µ‰•‘‘•™¥¹…¹”ì(´…¸¥¸µ…ÁÀ‰…­ÕÀ½¹Í½±”ƒŠPÉ•©•Ñ•¥¸H´ÀÀÀÔìÑ¡”‰…­ÕÀµ…”…Õ”(€¥¸5¥±•ÍÑ½¹”€ĞÌÉ•µ…¥¹¥¹œ±¥ÍĞ¥ÌÑ¡”…•ÁÑ•Í±¥”¸