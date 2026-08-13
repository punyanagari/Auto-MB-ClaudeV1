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
- rate limiting on login and expensive extraction, in two dimensions:
  a per-address sliding window, plus an account-scoped lockout on
  repeated failed sign-ins keyed by a SHA-256 hash of the normalised
  submitted email (never the raw address), which decays over its window,
  clears on successful login, and answers with the same 429 envelope for
  existing and non-existing accounts (no account-existence oracle).
  Lockouts are audited by email hash only. Both limiters keep their state
  in PostgreSQL (migration 0054, finding 38): every API instance counts
  the same attempts, so adding a replica no longer divides the windows.
  The tables are UNLOGGED (the state is reconstructible and must not pay
  WAL on the sign-in path) and hold only SHA-256 hashes — the client
  address and the already-hashed email never rest raw in the database.
  Per-key mutations serialise on a transaction-scoped advisory lock, so
  the count-and-record step stays exact under concurrency; expired rows
  are swept opportunistically as windows roll over. The pre-request
  checks fail CLOSED — a database failure answers the standard 503, and
  the protected endpoints could not have served the request without the
  database anyway. Production replicas all share the default throttle
  namespace; an explicitly-test process without explicit configuration
  gets an instance-scoped namespace so parallel suites sharing one
  database cannot throttle each other, and the cross-instance sharing
  proof passes a shared namespace explicitly
  (`apps/server/test/ops.integration.test.ts`). Only a database-less
  instance — which exposes no login or upload surface — falls back to
  the in-process maps;
- MFA for privilege holders: any user holding, in any organisation, an
  active owner membership or a document authority (issue, cancel, approve
  amendments, manage statutory reporting) must have TOTP two-factor
  enabled. The requirement is
  computed on every tenant-scoped request after the membership floor
  binds and refused with 403 `MFA_ENROLMENT_REQUIRED` until enrolment;
  two-factor disable is refused for such users (`MFA_REQUIRED_BY_POLICY`);
  enabling or disabling the second factor revokes the account's other
  sessions; enable-completion, verification, backup-code use, disable,
  and the verification lockout are appended to `identity_audit_events`.
  There is no grace period and no in-app reset — operator recovery is the
  out-of-band procedure in docs/RUNBOOK.md. The refusals deploy dark
  behind `MFA_ENFORCE=true` (the gate itself always computes and is
  reported by `/api/me`); production compose defaults it to true, and it
  must be on before the first design-partner account exists. Because the
  whole wall hangs on that one variable, boot asserts it: when
  `NODE_ENV` is not explicitly `development` or `test`, the server
  refuses to start unless `MFA_ENFORCE` is exactly `true`
  (`assertProductionMfaEnforcement`, mirroring the auth-secret gate
  below), so a production process can no longer come up one unset or
  mistyped environment variable away from an open gate;
- sensitive issue/cancel actions require explicit authority. The
  per-member authorities are boolean columns on
  `organisation_memberships`, granted by an owner and checked
  server-side inside the bound-tenant transaction:
  - `can_issue_documents` — issue a numbered document;
  - `can_cancel_documents` — cancel an issued document;
  - `can_approve_amendments` — decide an approval request;
  - `can_manage_statutory_reporting` (migration 0061) — the compliance
    authority: register, reconcile-by-lookup or cancel a document at the
    IRP or the NIC E-way Bill portal, drive stale-operation recovery, and
    record manual portal evidence. It closes the "no dedicated compliance
    authority" residue of audit finding 2: binding the organisation's
    statutory identity at a government portal is a different act from
    issuing a document of our own. It is checked IN ADDITION to the
    document authority, never instead of it, so every statutory route
    demands both. It defaults false and is never backfilled from
    `can_issue_documents` — the owner's ruling of 13 August 2026 is that
    it is granted deliberately, accepting that existing issue-holders
    lose IRP access until it is. Local acts on the same records — issuing
    a credit note, cancelling a local e-way-bill record, reading a frozen
    payload — are not statutory acts and keep their own authorities
    alone. Proven by the finding-2 authority describe in
    `apps/server/test/tax-invoices.integration.test.ts`;
- **work-free documents and work scope** (migration 0056): work scope is the
  reach mechanism and it binds THROUGH a Work — an `assigned`-scoped membership
  reaches exactly the Works it is assigned to. A standalone Delivery Challan
  has no Work, so no assignment could ever grant it, and such a membership
  reaches none of them: they are excluded from the register in SQL, and an
  addressed one answers 404 (never 403 — a guessed id must not confirm the
  document exists). Full-scope memberships see them, and writing, issuing, and
  cancelling still need the writer role and the issue/cancel authorities on top.
  Proved in `apps/server/test/delivery-challan-module.integration.test.ts` with
  an office member who holds both authorities and an assignment to the fixture
  Work, so only the scope gate can be what turns them away;
- every membership read that runs inside a bound-tenant transaction
  filters on `app_private.current_organisation_id()` as well as the user.
  The SELECT policy on `organisation_memberships` deliberately carries an
  `OR user_id = current_user_id()` branch so the unbound organisation
  picker can list a user's own memberships, and that branch stays active
  under a bound tenant. A read filtered on `user_id` alone therefore sees
  the caller's rows in _every_ organisation and resolves an arbitrary one,
  which would let a role or authority held elsewhere answer for the bound
  organisation. Only the unbound picker endpoints may omit the predicate.
  The same OR'd-policy hazard applies to the `organisations` table itself:
  `organisations_member_select_policy` (migration 0004) exposes every
  organisation the caller is an active member of so the picker can list
  names, and it stays active under a bound tenant. Every organisations
  read inside a bound-tenant transaction therefore filters on
  `id = app_private.current_organisation_id()` — an unqualified read
  resolves a planner-chosen row for a multi-organisation user and can
  print another tenant's name, warranty text, or branding onto an issued
  document. No other tenant-owned table carries a second SELECT policy.
  One deliberate exception to the membership predicate: the MFA gate (`mfa-policy.ts`) reads the
  caller's memberships across every organisation on purpose, because the
  MFA obligation is user-level — authority held anywhere makes the
  account worth protecting — and the read answers no authority question
  for the bound organisation;
- the authentication secret is rejected when it is absent, shorter than 32
  characters, or the documented placeholder, unless `NODE_ENV` is
  explicitly `development` or `test`. An unset `NODE_ENV` is treated as
  production, so a bare start cannot fall back to a known constant;
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
  proves nothing about logic-level vulnerabilities.

  **Narrowed lint ruleset.** Five of the plugin's rules are disabled in
  `eslint.config.js`, and the narrowing is part of this baseline's honest
  scope rather than an accident:
  - `security/detect-object-injection` (repo-wide) — fires on every
    computed member access; with strict TypeScript and
    `noUncheckedIndexedAccess` the signal is almost entirely noise;
  - `security/detect-non-literal-fs-filename` (repo-wide) — the
    migration runner and tests legitimately read paths built at runtime
    from repository-controlled directories; upload paths are guarded by
    their own validation and tests instead;
  - `security/detect-unsafe-regex`, `security/detect-possible-timing-attacks`,
    and `security/detect-non-literal-regexp` (`packages/loa-parser` only)
    — the parser's corpus-tested extraction regexes trip the static
    ReDoS heuristic, its value comparisons trip the timing heuristic
    (they guard no secrets), and its regexes are composed from
    module-internal constants, never parsed input. Text from uploaded
    LOA PDFs DOES reach these regexes (the upload route runs
    `reviewLoaLetter` on extracted text after magic-byte, size, and
    malware validation) — the config's earlier claim that only pinned
    fixtures did was stale and is corrected with this disclosure — so
    the ReDoS exemption rests on review of the regexes themselves and
    the corpus tests, not on input provenance, and deserves re-audit if
    the extraction grammar grows.

  Everything else in the plugin's recommended set runs at zero warnings;
  timing-sensitive comparisons outside the parser (the /metrics bearer
  token) use `crypto.timingSafeEqual` rather than relying on the lint;

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
- identity audit trail — sign-up/sign-in/sign-out and the two-factor
  lifecycle (enable-completion, verification, backup-code use, disable,
  verification lockout) are appended to the user-scoped
  `identity_audit_events` table (INSERT/SELECT grants only, so the trail
  is append-only even for the service role), proven by live tests;
- MFA enforcement for privilege holders — the tenant-transaction wall,
  the disable refusal, per-address rate limiting on the two-factor
  endpoints, other-session revocation on enable/disable, and the
  no-session `twoFactorRedirect` sign-in answer are proven by live HTTP
  tests against a real TOTP implementation
  (`apps/server/test/two-factor.integration.test.ts`).

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
  HTTP, separate from roles; drafting alone never issues a document, and
  the issue authority alone never registers one at the IRP (the
  compliance authority above is checked on top of it);
  approval-gated correction applies revalidate the same flags on the
  deciding user at apply time — cancel-and-replace requires the cancel
  authority and correction-notice issuance requires the issue authority,
  in addition to the amendment-approval authority;
- business integrity — serialised per-Work numbering, exact-arithmetic
  quantity validation, and snapshot immutability proven by live tests,
  including a concurrent double-issue race producing exactly one issued
  challan;
- document integrity — rendered PDFs are hashed (SHA-256) and produced
  only from the immutable issued snapshot; signed copies are magic-byte
  validated; both stream through authenticated, tenant-scoped requests.

Activated with Milestone 4 (pilot engineering):

- upload malware scanning — a clamd INSTREAM client wired into every
  upload endpoint, fail-closed when configured (an unreachable scanner
  rejects the upload rather than waving it through), proven by protocol
  and live-HTTP tests; the production compose runs ClamAV and configures
  it. Local development runs unscanned by explicit posture (magic-byte,
  size, and media-type validation still apply, and uploads are never
  executed). Because that posture is one unset variable away from
  production, a process that is not an explicit `NODE_ENV=development` or
  `NODE_ENV=test` run and would register the upload routes refuses to
  boot without `CLAMAV_HOST`
  (`assertProductionMalwareScanning`, `apps/server/src/upload-guards.ts`),
  on the same reasoning as the auth-secret and `MFA_ENFORCE` gates;
- one upload guard, derived — the magic-byte, size and media-type checks
  live in a single `consumeUpload()` (`apps/server/src/upload-guards.ts`)
  rather than being copied into each handler, and the per-address upload
  throttle is derived from the routes the tenant-route registrar
  registered with a raw-body `bodyLimit` instead of from a path list.
  `apps/server/test/upload-inventory.integration.test.ts` enumerates every
  upload route and proves, per route, that the guard refuses a
  wrong-signature body and that the throttle covers it, so a new upload
  route cannot be added without both;
- metrics — Prometheus text format behind a bearer token, refused at the
  public edge; route templates as labels, never raw URLs, so tenant and
  document ids cannot leak into label values. The bearer comparison is
  constant-time: both sides fold through SHA-256 and compare with
  `crypto.timingSafeEqual`, so neither the token's length nor its bytes
  leak through response timing;
- export — owner-only full-organisation export, audit-logged, as the
  incident procedure's evidence snapshot and the contractor's data
  portability;
- backup/restore — scripted, manifest-sealed, and proven by an automated
  dump→restore→verify test; the operational drill cadence lives in
  docs/RUNBOOK.md.

Activated with contract administration, procurement, and tax documents:

- high-risk baseline changes use immutable proposals, structured before/after
  evidence, authority revalidation at decision time, row-lock serialisation,
  and database floors that refuse reductions below delivered, installed, or
  PAC-certified evidence;
- purchase orders, quotations, number-series settings, tax invoices, and
  e-way bills are tenant-owned, forced-RLS records with live cross-tenant
  endpoint tests;
- authoritative quantities and money use PostgreSQL numeric arithmetic;
  submitted invoices freeze supplier, buyer, ship-to, tax split, rounding,
  totals, amount in words, explicit NIC locality, reverse-charge selection,
  numbering inputs, and rendering data. Issue currently requires explicit
  forward charge and refuses unsupported reverse charge;
- tax-invoice renders are append-only versions with source, PDF, and frozen-logo
  hashes. Database guards enforce contiguous versions, tenant-prefixed keys,
  immutable history, and a current pointer to the latest version; download
  verifies the retained bytes against the recorded SHA-256 before serving;
- every action that speaks to the IRP or the NIC E-way Bill portal — or
  records what one of them is said to have answered — requires the
  dedicated `can_manage_statutory_reporting` authority in addition to the
  issue or cancel authority the action already needed (migration 0061);
- IRN, acknowledgement, signed QR, e-way-bill number, and validity are never
  minted locally. Local document status stays distinct from provider status;
  unknown registration or generation is lookup-only and is never blindly
  replayed. Manual compatibility evidence carries its own provider state,
  `registered_unverified` (migration 0053): it behaves as registered for
  local rules (the cancel interlock, the reporting window) but renders
  distinctly, is excluded from every provider-verified claim, and a CHECK
  constraint refuses a manual row ever claiming the provider-verified
  `registered` state — even under raw SQL with triggers suspended;
- the provider operation ledger retains the raw request and response
  bodies beside the request hash, provider code, and status (migration
  0053): the request body is part of the operation's immutable identity,
  the response body lands exactly once when the operation completes, and
  both are bounded at 256 KiB with an explicit truncation marker rather
  than silent loss. Provider AUTHENTICATION calls never open ledger
  operations, so auth tokens and credentials cannot land in the ledger,
  and auth failures are re-wrapped without their response bodies;
- provider credentials belong only in server-side secret configuration. The
  e-invoice client pair and the separate E-way Bill API client pair are distinct
  secrets and are never substituted for one another.
  Browser payloads, application logs, audit details, and committed fixtures
  must never contain GSP passwords, app keys, auth tokens, decrypted session
  material, or production GST data.

Activated with inbound signed-document intake:

- **digital-signature verification on inbound railway PDFs** — every LOA
  and contract-source upload is verified at the boundary and the verdict
  is stored with the document (migration 0060), append-once, and carried
  into the organisation export. The verifier reads the PDF ByteRange and
  the CMS SignedData blob and delegates every cryptographic operation to
  `node:crypto`; no third-party cryptography or ASN.1 package is on the
  path of a verdict.

  What it proves, offline and with no network egress: that the bytes now
  present are the bytes each signature covers; that each signature
  verifies under the public key of the certificate its CMS names; that a
  certificate path reaches a trust anchor an operator installed
  (docs/OPERATIONS.md §8) rather than one the document supplied; that no
  bytes follow the last signature; and, where a timestamp token is
  embedded, the time a TSA attested to.

  What it does NOT prove, stated in the data and on the screen rather than
  assumed: revocation (`not_checked`, reason
  `network_egress_not_available`), and whether a legitimate-looking
  incremental update after an earlier signature changed what the document
  SAYS (the "shadow attack" class needs revision-by-revision rendering
  comparison; what is checked is whether the final bytes are covered by a
  signature at all).

  The posture, matching `registered_unverified` in 0053 and the Poppler
  guard in `loa-extract.ts`: **verification never silently passes
  something it could not check.** `not_checked`, `unsigned`,
  `signature_unverifiable`, `signed_chain_not_checked`,
  `signed_chain_expired`, `signed_but_untrusted_chain`,
  `signature_invalid`, `signed_but_modified_after_signing` and
  `signed_and_intact` are nine distinct values, a CHECK constraint refuses
  a verdict with no evidence behind it, and exactly one of them renders
  green. Proven by `apps/server/test/pdf-signature.test.ts` (a synthetic
  PKI, both SubFilter shapes, tampering, wrapping, and decoy cases),
  `apps/server/test/pdf-signature-evidence.integration.test.ts`, and
  `apps/web/test/views/signature-panel.test.tsx`;

- **nothing is gated on a signature verdict yet.** Verification records
  and reports; it refuses no upload. Turning a bad verdict into a refusal
  is a policy decision the owner takes per document type, because the
  consequence differs: refusing an unsigned tax invoice blocks billing,
  while accepting an unsigned variation order authorises removing
  contracted scope. The recommendation on record is that variation-order
  APPROVAL should require `signed_and_intact`, since that is the step
  where a signature is doing legal work.

Controls that activate with their product surface (adopting the surface
without the control is a release blocker, not an option):

- container image scan — when the deploy/ images are first published to a
  registry (building locally on the host does not publish an artifact).

Before paid production:

- DAST against staging;
- external application-security review;
- successful backup restore;
- incident and rollback exercise;
- key rotation procedure;
- threat model review.
- Whitebooks production-readiness review and provider sandbox/live
  certification covering credential storage, single-GSTIN binding, TLS,
  timeouts, replay/idempotency, redaction, provider outages, separate EWB
  authentication, cancellation authority, and unknown-outcome recovery;
- provider-specific metrics and alerts; current `/metrics` exposes HTTP and
  backup signals, not Whitebooks operation or authentication series.

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
