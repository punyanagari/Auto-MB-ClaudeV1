# ADR-0002: Shared multi-tenancy from the first pilot

- Status: Accepted
- Date: 2026-08-06

## Context

One deployment per customer increases operational cost and postpones proof that tenant isolation works.

## Decision

Use one shared application and PostgreSQL database. Every tenant-owned row carries `organisation_id`; normal queries are scoped; PostgreSQL RLS and `FORCE ROW LEVEL SECURITY` provide defense in depth; the application role cannot bypass RLS.

## Consequences

Every new tenant table and endpoint requires cross-tenant tests. Dedicated deployments remain a future enterprise option, not the default product architecture.
