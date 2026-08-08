# Auto-MB delivery roadmap

This roadmap is outcome-based. Dates are planning targets, not claims.

## Milestone 0 — executable foundation

Exit criteria:

- web, API, worker, PostgreSQL, and PDF service start locally;
- CI runs from a clean checkout;
- shared multi-tenant schema and RLS baseline exist;
- LOA parser corpus runs unchanged;
- authoritative documentation and agent instructions are in place.

## Milestone 1 — organisation, identity, and isolation

Delivered:

- Better Auth integration (email/password, server-side sessions, sign-out revocation, two-factor path via the twoFactor plugin);
- organisation creation (atomic SECURITY DEFINER bootstrap) and selection via the validated `x-organisation-id` header;
- the database-enforced membership floor: tenant context binds only when the authenticated user holds an active membership in the selected organisation, so a compromised or buggy handler cannot stamp an arbitrary organisation id — proven live at both the SQL and HTTP layers;
- four roles with Work scope and issue/cancel authority stored per membership; member management is owner-only;
- RLS and authorisation tests through the real application role, pool, and HTTP endpoints;
- audit events for organisation creation and membership changes;
- web screens for sign-in/sign-up, organisation selection and creation, and member management — token-based design system, print-aware styles, component tests, and a blocking Playwright + axe accessibility smoke against the production bundle.

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
  assignments — all audited, with the last active owner protected from
  demotion or disablement.

Closing decisions (2026-08-08):

- MFA enrolment/enforcement for owners is deferred to Milestone 4: the twoFactor capability is live, and the enforcement policy lands with design-partner onboarding, where real contractor data first appears;
- identity-level audit events (sign-up/sign-in/sign-out) are recorded in the user-scoped, append-only `identity_audit_events` table (migration 0005) — `audit_events` keeps its NOT NULL organisation invariant;
- role/authority enforcement on Work operations activates with the Milestone 2 endpoints (upload and confirm are owner/office-only).

Exit: Organisation A cannot access Organisation B through any endpoint, identifier, job, or attachment path.

## Milestone 2 — LOA to Work

Delivered:

- private PDF upload: raw `application/pdf` body, magic-byte and 25 MB validation, server-generated tenant-prefixed object keys in filesystem-backed object storage behind an interface;
- text extraction via `pdftotext -layout` (poppler, system dependency) — the same layout-preserving extraction the parser corpus was built with — inline at upload;
- the adopted deterministic parser produces the stored review payload: per-field provenance (value, printed raw source, needsReview), item rows with exact-decimal reconciliation, pricing-shape classification, and the trap flag set;
- review/correction UI: parsed prefills, a flag panel with printed sources, per-item editing beside each item's printed source row, and owner/office-gated confirmation;
- atomic confirmation creating the Work, schedules, and items, each item carrying `source_evidence` linked to its parsed source block, with the full extraction payload retained on the document;
- parser and confirmation integration tests: all six legacy fixtures reviewed and confirmed over live HTTP, with schedule/item counts and contract values matching the corpus manifest and zero unresolved evidence links.

Remaining (tracked for the pre-pilot hardening pass):

- ~~rate limiting on upload/extraction~~ — shipped 2026-08-08 (ops batch): sliding-window limits on login and every upload endpoint;
- ClamAV upload quarantine before design-partner uploads (Milestone 4 trigger);
- the model/OCR fallback for unresolved fields waits for the first real letter the deterministic parser cannot serve.

Exit: all six legacy LOA fixtures can be reviewed and confirmed without losing source evidence — met (`apps/server/test/loa.integration.test.ts`).

## Milestone 3 — Work to issued Delivery Challan

Delivered:

- draft challans with the one-draft-per-Work invariant (DB partial unique index, surfaced as 409), consignee snapshot, and line snapshots (description/unit/rate copied and the line amount computed in exact SQL numeric arithmetic at line creation);
- balance-aware item picker: per-item awarded/delivered/remaining, where delivered counts issued challans only — cancellation releases its quantities;
- issue and cancel as explicit per-member authorities (`can_issue_documents` / `can_cancel_documents`), separate from roles and enforced over live HTTP;
- serialised per-Work numbering via the counter row lock (`prefix/sequence`; a rolled-back issue rolls its number back with it, so numbers are gapless per Work);
- concurrency-safe quantity validation inside the issue transaction (proved: a concurrent double-issue produces exactly one issued challan; exact-boundary issues pass, one-paisa-over fails);
- the immutable issued snapshot (organisation, work, consignee, lines, totals) stored on issue; DB triggers keep issued business data and cancelled challans immutable;
- deterministic HTML template (`dc-v1`) rendered from the snapshot only, converted by Gotenberg, stored with its SHA-256; signed-copy upload with magic-byte validation; authenticated PDF streaming;
- cancellation with mandatory note and the full audit timeline (created → updated → issued → rendered → signed-copy uploaded → cancelled).

Remaining:

- the render call is a synchronous idempotent endpoint retried by the operator; unattended retry (pg-boss) arrives if the pilot shows renders failing when nobody is watching;
- the real Gotenberg service is exercised locally via compose; CI proves the render path against a stub PDF service, and the live-service proof lands with the staging deployment.

Exit: a design partner completes the exact LOA→DC workflow in staging — pending Milestone 4's staging deployment; the workflow itself is complete and CI-proven end to end (`apps/server/test/challans.integration.test.ts`).

## Milestone 4 — controlled design-partner pilot

Delivered (the engineering half):

- upload malware scanning: a dependency-free clamd INSTREAM client wired into both upload endpoints, fail-closed when configured (unreachable scanner rejects the upload), proven at the protocol level and over live HTTP against a stub daemon; production compose runs the real ClamAV service;
- monitoring: a dependency-free Prometheus text-format `/metrics` endpoint (requests by method/route/status, latency histogram) behind a bearer token, refused publicly by the edge proxy;
- export: owner-only `GET /api/export` returning the organisation's complete business record (works, items with evidence, challans with snapshots, audit trail), itself audit-logged;
- backup plus successful restore: `scripts/backup.sh` / `scripts/restore.sh` (custom-format dump + object store + SHA-256 manifest), with the dump→restore→verify cycle proven live in `packages/db/test/backup-restore.integration.test.ts`;
- deployment assets: production Dockerfiles, `deploy/docker-compose.prod.yml` (Caddy TLS + web, server, PostgreSQL 17, Gotenberg, ClamAV), env template, and the pilot runbook (docs/RUNBOOK.md: deploy, upgrade, backup cron, restore drill, alert thresholds, incident steps, partner onboarding checklist).

Remaining (needs the operator, real infrastructure, or third parties):

- MFA enrolment/enforcement for owners — the Milestone 1 deferred decision comes due before the first partner account exists (docs/RUNBOOK.md §8);
- ~~rate limiting on login and upload/extraction~~ — shipped 2026-08-08 (ops batch), alongside authorize-before-scan ordering, extraction outside the tenant transaction, the idempotent role/grant bootstrap (deployed on every release), the public auth base URL, edge security headers with CSP, the component-aware readiness probe, a production-compose smoke test in CI, and a restore proof that fails CI instead of skipping;
- the India-region VM, DNS, and TLS hostname (operator accounts and decisions);
- external uptime monitor and metrics scraper pointed at the deployment;
- DAST against staging and the external application-security review;
- three to five design partners recruited and onboarded per the checklist;
- backup-age visibility (thin pre-pilot slice, ADR-0005): the backup
  script updates a last-success marker only after the dump, the object
  archive, and manifest verification all complete; `/metrics` exposes the
  marker as a `backup_last_success_timestamp_seconds` gauge so the
  external monitor alerts on staleness — no in-app backup controls.

## Milestone 5 — retention workflow

Delivered (backend, migration 0006 + live HTTP proofs):

- delivery receipts: one per issued challan, writer-recorded, duplicate-proof;
- serial traceability: serials unique per Work, capped at the shipped line quantity under a row lock, installation recorded in place, and a per-Work trace listing serial → challan number → item → installation;
- PBG/PAC/DOC instruments per Work: unique references, amounts, issue/expiry dates, forward status management, an expiry index for alerting;
- Measurement Book: entries capped so cumulative measurement never exceeds delivered (issued) quantity — checked in exact SQL arithmetic under a row lock; billed entries freeze via a DB trigger;
- first partial-billing cycle: bill preparation under issue authority sweeps all unbilled MB entries into an immutable per-item snapshot (quantity × rate in exact numeric), numbered gaplessly per Work through a counter row lock; status moves forward only (prepared → submitted → paid, DB-enforced); bills cannot be deleted;
- the sixteen-table tenant-isolation matrix now covers every retention table, and the audit trail spans the whole flow (received → serials → installed → measured → billed → paid).

Integrity hardening (2026-08-08, following the external code review):

- bill preparation aggregates and stamps exactly the locked set of unbilled MB entries, so a measurement recorded concurrently can never ride a bill whose immutable snapshot did not count it (proved with a concurrent bill-versus-measurement test);
- cancellation policy: an issued challan with downstream evidence (receipt, serials, or MB entries) can no longer be cancelled — received goods cannot be un-delivered; enforced in the route and by a database trigger, with the evidence-recording paths taking the challan row lock so cancellation cannot race them;
- instrument statuses are forward-only from `active` (released/expired/closed are terminal), enforced in the API and by a database trigger;
- measurement provenance and serial lineage are now database-proven: `mb_entries.delivery_challan_id` carries a composite foreign key to the same organisation and Work, and serial rows prove their challan line belongs to their challan;
- signed copies are stored content-addressed with their SHA-256 (replacements never overwrite earlier evidence), and a render that loses a race with a status change is discarded instead of leaving a false audit entry;
- the organisation export (`export-v2`) now includes receipts, serials, instruments, MB entries, and bills — the complete business record again.

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
  future (organisation-timezone today) nor before the LOA letter date —
  API validation plus a database trigger (migration 0010);
- export-v3 adds the organisation profile, work assignments, and a
  portable object manifest (keys + hashes) for offboarding/incident
  packages.

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
  requirement (what the LOA demands) stays distinct from the instrument
  (what the contractor submitted), enabling required-but-missing,
  under-value, window-missed, and expiring alerts beside the existing
  instrument expiry alerts.

## Milestone 6 — contract administration and change control

Scope (from the 2026-08-08 legacy UI audit as corrected by its author —
adr/0005-legacy-ui-audit-disposition.md records the dispositions):

- original and current completion dates on the Work, with approaching and
  overdue alerts — the works table currently has no completion date,
  which blocks every validity-versus-completion rule downstream; the
  current date changes only through a recorded extension or amendment
  event, never a free-form Work edit;
- DOC extension requests as first-class records: draft → finalised →
  responded, sequential `<work_code>-Extension-NN` numbering, generated
  request PDF, railway response attachment, full history retained;
- controlled baseline amendments — add or omit an item, change quantity,
  description, unit, or a legally authorised rate — with reason and
  evidence, preserving original LOA values so the original, amended, and
  effective baselines each stay visible; plus a real setter for
  `allow_excess_delivery`, dead code since migration 0001;
- the issued-record amendment and edit-approval workflow guarding those
  amendments: immutable proposed snapshot with a structured before/after
  diff, one pending request per record, mandatory reason, revalidation of
  authority and business invariants at apply time, an approvals holder
  may apply directly with the self-approval automatically recorded,
  rejection takes a note, and the new revision links back to the
  untouched original;
- add/remove-row editing on the LOA review screen, so a letter the parser
  cannot fully serve still has a path to a confirmed Work;
- audit writers start capturing before/after values (today only
  changed-key names are recorded, so diff evidence is being lost daily),
  and a per-Work/entity timeline read API and view make the trail
  inspectable in the product — organisation-wide search waits for
  Milestone 9.

Discovery gates (partner paperwork required before these enter committed
scope): the Contract Agreement register and a formal Variation Order
register — the operative change-control mechanics above ship without
them, and real agreements and variation orders from a design partner
settle their reference fields, legal precedence, and lifecycle.

Exit: a reviewer can reconstruct original LOA baseline → every approved
amendment → every completion extension → current effective baseline with
no historical record overwritten, and every change shows who proposed it
and who applied it.

## Milestone 7 — site material movement and document control

Scope:

- Issue Challans as a first-class document (legacy lifecycle: draft →
  issued → cancelled, plus loan/return type; independent per-Work
  numbering; manual lines permitted by design) recording material moving
  from store/consignee custody to site, distinguishing railway-issued
  from contractor-provided material;
- quantity-level installation records with location, alongside the
  existing per-serial installation facts;
- consignee, location, and unit masters — kept in this milestone because
  installation and Issue Challans consume them (legacy installation picks
  its location from the master, inline-creatable): retire-not-delete,
  always snapshot-on-use so issued documents stay frozen; units seeded
  from the parser's canonical list; signatory names join the organisation
  profile;
- warranty/guarantee certificate page on the Delivery Challan: org-level
  template text, rendered from the issued snapshot, template version and
  content hash recorded;
- the Milestone 6 amendment/approval mechanism extends to issued
  documents: a wrong challan with downstream evidence (unfixable since
  the 2026-08-08 cancellation policy) gets an approval-gated
  cancel-and-replace or adjustment document — the promise migration 0008
  already makes — never an edit of the issued snapshot;
- tenant-wide serial lookup (work-scope filtered) with the full trace,
  and enforcement of the `requires_serials` flag (stored since migration
  0001, never enforced): serial count must equal shipped quantity at
  issue. Multiline batch capture already shipped in Milestone 5; range
  expansion and spreadsheet import stay evidence-gated in Milestone 9.

Exit: a material unit can be traced awarded → delivered → received →
issued to site → installed, including its documents, custody, serial
identity, and location, and a wrong issued document has a lawful
correction path that preserves the original.

## Milestone 8 — stage-wise payment eligibility

Scope:

- item payment categories assigned at LOA review, and a per-Work payment
  matrix keyed by category — each category defines supply, installation,
  PAC, and final-bill percentages summing exactly to 100; per the legacy
  settled decision there is deliberately no per-item percentage-entry
  interface;
- PAC certificates recording certified quantities per item, capped at
  installed-minus-already-certified;
- stage-wise bill preparation: eligible stage quantity × authoritative
  rate × stage percentage − previously billed for that stage, in exact
  decimal arithmetic, with per-stage billed memory so no stage can be
  billed twice;
- every finalised MB and bill snapshots the item's category assignment,
  the resolved percentages, eligible stage quantities, rates, and prior
  billed amounts — changing the Work matrix later never alters a
  finalised record;
- compensating entries for corrections — paid bills are never rewritten.

The matrix schema lands before the first design partner prepares a bill:
bills are immutable and undeletable, so a 100%-of-measured bill on a
staged contract would be a permanently wrong financial record. The
richer maths already deferred (security deposit deductions, price
variation) still wait for a partner's real bill format.

Exit: the first stage-based bill is computed entirely from recorded
contract terms and operational evidence, with no payment percentages
calculated in an external spreadsheet.

## Milestone 9 — operational depth, evidence-gated

Each item enters build only when a design partner supplies the evidence
named with it:

- Excel Work-item import with validation, mapping preview, and
  review-before-accept — first real letter or BOQ the PDF path cannot
  serve (Milestone 6's row editing covers the known failure mode until
  then);
- organisation-wide audit search with structured diffs — first
  investigation need the per-Work timeline cannot answer (capture starts
  in Milestone 6, so the evidence exists by then);
- multiple numbering series and per-document signatory selection within
  one organisation — first partner needing more than the single profile;
  a series or signatory never changes the legal entity that owns the
  record (multiple legal entities remain multiple organisations,
  ADR-0005);
- a unified cross-document register — first partner request the per-type
  surfaces cannot satisfy (the concept has no legacy-spec antecedent);
- standalone/non-Work material movements with a separate company-level
  numbering series — real demand only; it forks the one-draft-per-Work,
  per-Work-numbering, and LOA-date invariants.

## Deferred until usage proves demand

- GST IRN/e-way-bill automation;
- procurement, POs, and BQs;
- broad reporting;
- department expansion;
- enterprise SSO/custom policy engine;
- offline sync and native mobile;
- embedded finance;
- an in-app backup console — rejected in ADR-0005; the backup-age gauge
  in Milestone 4's remaining list is the accepted slice.
