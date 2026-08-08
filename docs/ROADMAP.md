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

- private PDF upload;
- text extraction;
- adopted deterministic parser;
- field provenance/confidence;
- review/correction UI;
- atomic creation of Work, schedules, and items;
- parser and confirmation integration tests.

Exit: all six legacy LOA fixtures can be reviewed and confirmed without losing source evidence.

## Milestone 3 — Work to issued Delivery Challan

- DC draft and one-draft invariant;
- item picker with quantity balance;
- issue authority;
- serialised per-Work numbering;
- concurrency-safe quantity validation;
- immutable snapshot;
- PDF generation and signed-copy upload;
- cancellation and audit timeline.

Exit: a design partner completes the exact LOA→DC workflow in staging.

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
