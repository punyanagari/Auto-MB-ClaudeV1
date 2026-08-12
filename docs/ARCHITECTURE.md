# Auto-MB architecture

## 1. Architectural objective

Deliver a secure shared multi-tenant SaaS for the first 100–500 customers while preserving clear paths to larger scale. Optimise for correctness, operability, and a small team—not speculative infrastructure.

## 2. System shape

```text
React/Vite web
      ↓ REST/JSON
Fastify modular API
      ├── PostgreSQL (system of record, RLS, jobs)
      ├── private S3-compatible object storage
      └── Gotenberg (private HTML-to-PDF service)

Worker (reserved boundary; no asynchronous jobs currently run)
```

Deploy as a modular monolith: one web build, one API service, one worker service, one PostgreSQL database.

## 3. Repository boundaries

- `apps/web`: React UI; no authoritative money or quantity logic.
- `apps/server`: HTTP routes and product modules.
- `apps/worker`: asynchronous execution.
- `packages/db`: SQL migrations, DB connection, organisation-scoped transactions.
- `packages/contracts`: TypeBox schemas shared by server and web.
- `packages/loa-parser`: pure parser and real regression corpus.

Deterministic issued-snapshot rendering contracts and reusable test support live inside the modules that consume them; each becomes a package only when a real second consumer exists.

Inside the API, modules initially remain folders rather than independent packages:

```text
identity/
organisations/
works/
loa/
delivery/
installation/
measurement/
procurement/
tax-documents/
documents/
audit/
```

## 4. Multi-tenancy

Every tenant-owned table contains `organisation_id uuid not null`.

Tenant isolation is enforced by:

1. explicit organisation scope in normal queries;
2. PostgreSQL Row-Level Security;
3. `FORCE ROW LEVEL SECURITY`;
4. a non-owner, non-superuser application role without `BYPASSRLS`;
5. transaction-local `app.organisation_id` context;
6. the membership floor: `app_private.current_organisation_id()` returns the context organisation only when `app.user_id` holds an active membership in it, so every policy fails closed against a stamped-but-illegitimate organisation id;
7. integration tests that attempt cross-tenant access through the real pool and the real HTTP endpoints.

A user may belong to multiple organisations through memberships. The client names its selected organisation with the `x-organisation-id` header, but the database membership floor decides whether that selection binds; a client-supplied organisation id is never trusted by itself. Organisation creation goes through `app_private.create_organisation_with_owner`, the atomic SECURITY DEFINER bootstrap owned by the non-login `auto_mb_definer` role.

Identity lives in Better Auth (email/password, server-side sessions, two-factor path) over its own `auth_*` tables; those tables are identity-level rather than tenant-owned and carry explicit service RLS policies.

## 5. Database and transactions

PostgreSQL is the source of truth. Use SQL constraints for durable invariants and transactions/advisory locks for concurrency-sensitive behaviour.

Critical operations are atomic:

- confirm LOA → create Work/schedules/items;
- issue DC → authorise, validate quantity, allocate number, snapshot, and audit;
- cancel DC → authorise, validate downstream state, mark cancelled, audit.
- finalise MB → lock sources, compute exact staged values, allocate number,
  snapshot, audit;
- submit tax invoice → lock its value source, allocate the configured number,
  freeze parties, explicit localities, the operator-confirmed forward-charge
  fact, and exact GST values, close the MB when applicable, and audit;
- start a statutory-provider operation → lock and validate the document,
  append a pending operation row, and commit the in-progress provider state;
  perform HTTP outside the database transaction; then persist the outcome,
  evidence, and audit event in a second transaction. A pending operation older
  than two minutes becomes unknown. Unknown registration or generation is
  lookup-only and never repeats the mutation blindly.

Money uses `numeric`. Dates use `date`. IDs use opaque UUIDs. Indexes begin with `organisation_id` when serving tenant-scoped access paths.

## 6. Document architecture

Original uploads and generated PDFs live in private object storage. The
storage boundary is an interface (`apps/server/src/storage.ts`); the
current implementation is filesystem-backed with server-generated,
tenant-prefixed keys — the same prefix rule the database enforces on
`loa_documents.object_key` — and an S3-compatible implementation slots in
behind it for the deployed environments (Milestone 4).

Issued documents store:

- immutable JSON snapshot;
- rendering-template version;
- rendered-object key;
- SHA-256 hash;
- issue/cancel metadata;
- signed-copy attachment metadata.

Tax invoices follow the same legal-document posture: supplier, buyer,
ship-to, line, tax, reverse-charge selection, rounding, words, numbering
inputs, and template version are frozen before rendering. Reverse charge is
not yet computed, so issue accepts only an explicit forward-charge selection;
historical missing values stay unknown. IRP acknowledgements and signed QR
data arrive after local issue and are append-only external evidence; they do
not rewrite the issued snapshot.

Implemented PDF render paths are synchronous and idempotent. Delivery
Challans, Issue Challans, extensions, correction notices, finalized
Measurement Books, and submitted tax invoices render from immutable snapshots.
Tax invoices embed a real QR from the exact signed IRP payload when available.
Every successful render appends a version containing the exact source hash,
PDF hash, and a content-addressed frozen copy of the logo. Database guards keep
the current pointer on the newest tenant-prefixed version; downloads re-hash
the stored bytes before serving them. Prior versions remain in the owner export
and after local cancellation. A failed render never reallocates a document
number or replaces the previously referenced PDF.

## 7. LOA extraction

```text
private PDF
  → text/layout extraction
  → deterministic parser
  → optional model/OCR fallback for unresolved fields
  → field-level provenance/confidence
  → human review
  → atomic confirmation
```

The existing six-letter / 281-item corpus is a regression baseline. AI output is untrusted proposal data until reviewed.

As delivered in Milestone 2: extraction runs complementary Poppler views from
the same PDF: `pdftotext -layout` remains authoritative for headers,
schedules, and numeric columns, while `pdftotext -raw` supplies exact item-row
description ownership behind a strict whole-letter tuple gate. Both run in
parallel inline at upload because extraction is sub-second. No product
workflow currently requires a background job; implemented PDF routes are
synchronous and idempotent (§9). The
parser's review payload — per-field value plus printed raw source plus
needsReview, item rows with exact-decimal reconciliation, pricing-shape
classification, and the trap flags — is stored verbatim on the document
row. Confirmation is one transaction: Work + schedules + items, each item
carrying `source_evidence` that links back to its parsed source block,
and the document keeps the full payload after confirmation. The
model/OCR fallback step remains unbuilt until a real letter defeats both
deterministic views.

## 8. API contracts

Fastify route schemas are JSON Schema generated with TypeBox. The same schemas provide runtime validation, TypeScript inference, and OpenAPI documentation.

API rules:

- decimal values cross the API as strings;
- date-only values cross as `YYYY-MM-DD` strings;
- errors use stable machine codes and a request id;
- response schemas prevent accidental leakage of internal fields;
- request bodies are never logged.

## 9. Background jobs

Use PostgreSQL-backed jobs before introducing a second datastore. Adopt `pg-boss` when the first real async workflow lands. Jobs are idempotent, bounded, observable, and refer to records by ids rather than embedding sensitive documents.

Milestone 3 status: challan PDF rendering is a synchronous, idempotent
endpoint (`POST /api/challans/:id/render`) — issue-state correctness never
depends on it, a failure is a clean 502 with the challan unaffected, and a
retry re-renders from the immutable snapshot. That keeps pg-boss at its
trigger: the first workflow that must retry unattended.

## 10. Statutory provider boundary

Tax-invoice and e-way-bill records remain provider-neutral. `StatutoryProvider`
is the server boundary; `WhitebooksProvider` implements authenticated B2B IRP
registration, document lookup, IRP cancellation, EWB-by-IRN lookup, and
standalone EWB cancellation. Browser code never receives credentials.

IRP operations use the e-invoice client pair. Standalone EWB cancellation first
authenticates against `/ewaybillapi/v1.03/authenticate` and uses the separate
`WHITEBOOKS_EWAY_CLIENT_ID` / `WHITEBOOKS_EWAY_CLIENT_SECRET` pair. Cancellation
fails closed when that pair is absent. The configured credential set is bound
to one exact `WHITEBOOKS_GSTIN`; mismatched supplier GSTINs are refused.

Provider HTTP calls use bounded timeouts and response sizes. The durable
provider-operation ledger stores target, provider/environment, correlation id,
request SHA-256, status, timestamps, redacted provider code, and HTTP status;
it never stores request bodies, response wrappers, tokens, passwords, secrets,
or signed documents. Failed outcomes may be retried where safe. Unknown
registration or generation outcomes are reconciled by lookup only; unknown
cancellations require externally confirmed evidence and are not resent blindly.

NIC seller, buyer, and ship-to locality is explicit frozen data and is never
guessed from an address. The application currently models cumulative SAC
service invoices, so fresh EWB provider generation and NIC payload exposure are
deliberately refused until goods/HSN delivery facts exist.

## 11. Scale target

Initial capacity validation target:

- 1,000 organisations;
- 500 Works per organisation;
- 20 million Work-item rows;
- 25 million document metadata rows;
- 50 million audit events;
- 300–500 concurrent active sessions.

This is a test target, not a claim until the k6 and database benchmark passes.

## 12. Deliberate exclusions

No Redis, Kafka, microservices, Kubernetes, read replicas, search cluster, policy service, or multi-region database until a measured production constraint requires it.
