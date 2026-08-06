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
- `packages/documents`: deterministic issued-snapshot rendering contracts.
- `packages/testkit`: reusable PostgreSQL and browser test support.

Inside the API, modules initially remain folders rather than independent packages:

```text
identity/
organisations/
works/
loa/
delivery/
installation/
measurement/
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
6. integration tests that attempt cross-tenant access through the real pool.

A user may belong to multiple organisations through memberships. The selected organisation is resolved server-side from the authenticated session and membership; a client-supplied organisation id is never trusted by itself.

## 5. Database and transactions

PostgreSQL is the source of truth. Use SQL constraints for durable invariants and transactions/advisory locks for concurrency-sensitive behaviour.

Critical operations are atomic:

- confirm LOA → create Work/schedules/items;
- issue DC → authorise, validate quantity, allocate number, snapshot, audit, queue PDF;
- cancel DC → authorise, validate downstream state, mark cancelled, audit.

Money uses `numeric`. Dates use `date`. IDs use opaque UUIDs. Indexes begin with `organisation_id` when serving tenant-scoped access paths.

## 6. Document architecture

Original uploads and generated PDFs live in private object storage.

Issued documents store:

- immutable JSON snapshot;
- rendering-template version;
- rendered-object key;
- SHA-256 hash;
- issue/cancel metadata;
- signed-copy attachment metadata.

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

## 10. Scale target

Initial capacity validation target:

- 1,000 organisations;
- 500 Works per organisation;
- 20 million Work-item rows;
- 25 million document metadata rows;
- 50 million audit events;
- 300–500 concurrent active sessions.

This is a test target, not a claim until the k6 and database benchmark passes.

## 11. Deliberate exclusions

No Redis, Kafka, microservices, Kubernetes, read replicas, search cluster, policy service, or multi-region database until a measured production constraint requires it.
