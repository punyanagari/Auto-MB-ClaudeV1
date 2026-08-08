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

- rate limiting on upload/extraction (docs/SECURITY.md lists it with login rate limiting);
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

- onboarding and support tools;
- production-like India-region deployment;
- monitoring and alerts;
- backup plus successful restore;
- upload scanning;
- DAST and external high-risk review;
- export and incident procedures;
- three to five design partners.

## Milestone 5 — retention workflow

- delivery receipt/installation records;
- serial traceability;
- PBG/PAC/DOC tracking;
- Measurement Book and first partial-billing cycle.

## Deferred until usage proves demand

- GST IRN/e-way-bill automation;
- procurement, POs, and BQs;
- broad reporting;
- department expansion;
- enterprise SSO/custom policy engine;
- offline sync and native mobile;
- embedded finance.
