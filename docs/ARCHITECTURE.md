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

Worker
      ├── PDF jobs
      ├── upload scanning
      ├── extraction jobs
      └── notifications/exports
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
  freeze parties and exact GST values, close the MB when applicable, audit;
- generate or cancel an e-way bill → lock the invoice and movement row,
  preserve the external response, and audit every lifecycle transition.

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
ship-to, line, tax, rounding, words, numbering inputs, and template version
are frozen before rendering. IRP acknowledgements and signed QR data arrive
after local issue and are append-only external evidence; they do not rewrite
the issued snapshot.

PDF generation is asynchronous but issue-state correctness does not depend on the renderer being available. A failed PDF job retries without reallocating the number.

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
parallel inline at upload because extraction is sub-second; the first
genuinely asynchronous job remains Milestone 3's PDF rendering (§9). The
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

Tax invoice and e-way-bill domain records do not depend on one GSP. The server
currently builds deterministic IRP and NIC payloads from stored snapshots and
records verified external responses without inventing IRN, acknowledgement,
or e-way-bill values locally.

Direct Whitebooks transport belongs behind a server-side adapter. Browser code
never receives provider credentials. The adapter must use bounded timeouts,
idempotency/correlation identifiers, redacted logs, stable internal errors, and
an auditable request/response summary while keeping full sensitive payloads out
of request logs. Local issue and external registration remain distinct states.

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
