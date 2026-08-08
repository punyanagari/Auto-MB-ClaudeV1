# Auto-MB security contract

## 1. Security posture

Auto-MB is designed to become STQC/GIGW/CERT-In audit-ready. It is not described as certified or compliant until an authorised independent assessment covers the deployed release, infrastructure, operations, and organisational evidence.

Primary risks:

1. cross-organisation data exposure;
2. broken authorisation on issued legal documents;
3. malicious or unsafe uploads;
4. quantity, numbering, money, and date integrity failures;
5. account/session compromise;
6. sensitive logging or object-storage exposure;
7. unsafe migrations, deployment, backup, or restore;
8. over-trust in parser/model output.

## 2. Mandatory controls from the first feature

### Tenant isolation

- `organisation_id` on every tenant-owned table;
- RLS and `FORCE ROW LEVEL SECURITY`;
- application role is not superuser, owner, or `BYPASSRLS`;
- organisation context set transaction-locally;
- explicit query scoping plus RLS defense in depth;
- cross-tenant tests for every table and endpoint.

### Authentication and authorisation

- secure, HTTP-only, SameSite cookies;
- server-side membership and permission checks;
- session revocation;
- rate limiting on login and expensive extraction;
- MFA before general availability for owners/admins;
- sensitive issue/cancel actions require explicit authority;
- support access is time-limited and fully audited.

### Uploads and documents

- private buckets/containers only;
- server-generated opaque object keys;
- validate magic bytes and size, not only declared MIME type;
- quarantine and malware-scan before trusted processing;
- never execute uploaded content;
- authenticated streaming or short-lived signed URLs;
- hash originals and generated documents;
- original filenames are display metadata only.

### Application security

- schema validation on every endpoint;
- parameterised SQL only;
- origin/CSRF protection for mutations;
- secure headers and same-origin script policy;
- no request-body or secret logging;
- stable request ids returned to clients;
- generic external errors, detailed internal diagnostics;
- secrets are supplied from a secret manager in production;
- production refuses placeholder or short signing secrets.

### Business integrity

- issue, numbering, quantity validation, snapshots, audit, and job enqueue occur atomically;
- concurrency tests prove no duplicate/gapped numbers or quantity overruns;
- models cannot authorise, issue, cancel, or calculate authoritative money.

## 3. CI security baseline

Enforced by CI today, with what each control proves:

- TypeScript type check, lint, and format check — static correctness only;
- static security analysis (`eslint-plugin-security` at zero warnings) —
  catches known-dangerous JavaScript patterns; it is not a full SAST and
  proves nothing about logic-level vulnerabilities;
- secret scan (`secretlint` with the recommend preset; `.secretlintignore`
  excludes the lockfile, the imported LOA fixtures, historical reference
  docs, and the untracked local `.env`) — catches committed credentials
  matching known formats; it cannot detect novel secret formats;
- web production bundle build (server and worker run from source via tsx
  and have no separate build artifact yet);
- unit and PostgreSQL integration tests, including tenant-isolation and
  concurrent-migration proofs against the real application role on every
  tenant-owned table;
- dependency audit (`pnpm audit --audit-level=high`) on pull requests,
  pushes to main, and a weekly schedule — known advisories only;
- shell script validation (`bash -n` and shellcheck) — parse and static
  correctness of operational scripts, not their runtime behaviour;
- configuration parse checks (compose config, environment and package
  JSON) — structural validity only;
- migration validation and architecture boundary checks.

Third-party CI actions are pinned to full commit SHAs.

Activated with Milestone 1 (authenticated endpoints exist):

- authorisation tests — live HTTP proofs that non-members are denied with
  a valid organisation id, member management is owner-only, and sign-out
  revokes access;
- deeper SAST — Semgrep (pinned version, curated `p/ci` ruleset,
  `--metrics=off`) as a blocking CI job; it proves no match against those
  rules, not the absence of logic-level vulnerabilities;
- the database membership floor — `current_organisation_id()` binds only
  for an active membership of the session user, proven by live tests;
- identity audit trail — sign-up/sign-in/sign-out are appended to the
  user-scoped `identity_audit_events` table (INSERT/SELECT grants only, so
  the trail is append-only even for the service role), proven by live
  tests.

Activated with the first browser workflow (the Milestone 1 screens):

- browser accessibility/security smoke — Playwright + axe against the
  production bundle as a blocking CI job; it proves the auth, organisation,
  and member screens render with no serious axe violations and that the
  frontend sends the tenant header on scoped requests. The API is mocked
  there; server-side authorisation is proven by the integration tests.

Activated with Milestone 2 (uploads and Works exist):

- upload validation — magic bytes and a 25 MB cap enforced server-side,
  the media type constrained by a database CHECK, bytes never executed,
  and objects stored under server-generated tenant-prefixed keys that the
  database and the storage layer validate independently — proven by live
  tests;
- source-evidence preservation — confirming a Work never overwrites the
  extraction payload; reviewer corrections live beside the parsed source,
  not instead of it — proven across all six corpus letters;
- role enforcement — upload and confirm are owner/office-only over live
  HTTP.

Activated with Milestone 3 (issued documents exist):

- issue/cancel authority — explicit per-member flags checked over live
  HTTP, separate from roles; drafting alone never issues a document;
- business integrity — serialised per-Work numbering, exact-arithmetic
  quantity validation, and snapshot immutability proven by live tests,
  including a concurrent double-issue race producing exactly one issued
  challan;
- document integrity — rendered PDFs are hashed (SHA-256) and produced
  only from the immutable issued snapshot; signed copies are magic-byte
  validated; both stream through authenticated, tenant-scoped requests.

Controls that activate with their product surface (adopting the surface
without the control is a release blocker, not an option):

- container image scan — when an Auto-MB application image exists;
- upload malware scanning (ClamAV) — before uploads are accepted from
  design partners (Milestone 4), matching docs/DEPENDENCIES.md; until
  then uploads are development-only and covered by the magic-byte, size,
  and media-type validation plus the never-execute rule above.

Before paid production:

- DAST against staging;
- external application-security review;
- successful backup restore;
- incident and rollback exercise;
- key rotation procedure;
- threat model review.

Before a government/STQC-mandated deployment:

- stable release candidate and evidence package;
- independent assessment by the required authorised laboratory;
- remediation and re-test;
- accessibility review when full GIGW certification applies;
- recurring review after material changes as required by the applicable scheme.

## 4. Evidence

Each control must link to at least one of:

- automated test;
- CI result;
- configuration;
- operational record;
- external assessment;
- approved risk acceptance with owner and expiry.

A plan or matrix entry without implementation evidence is not a completed control.

## 5. Agent-development safety

- agents receive no production credentials or customer data;
- use synthetic/redacted fixtures unless the repository explicitly contains approved private test data;
- development commands run with least privilege;
- production deploys require separate CI identity and human approval;
- generated security claims require human verification;
- a fresh review session is required for high-risk changes.
