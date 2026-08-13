-- Readiness schema-version gate (pack P6): let the application role READ
-- the migration ledger.
--
-- `/api/ready` compares the applied-migration ledger with the migrations
-- the running image carries and refuses traffic when the image is ahead
-- (apps/server/src/routes/health.ts). Without this grant the query is
-- refused, the gate reports `schema-migrations-unreadable`, and the
-- server is permanently not-ready.
--
-- The grant belongs HERE and not only in the bootstrap privilege matrix.
-- Migrations grant, and `bootstrap.ts` reapplies the canonical matrix to
-- repair a database whose migrations ran before the role existed
-- (packages/db/src/bootstrap.ts). A privilege that lives only in the
-- repair step makes migrating insufficient to produce a serviceable
-- database — which is exactly how this was found: CI migrates without
-- bootstrapping, and every readiness assertion in the suite began
-- answering 503.
--
-- SELECT only, and deliberately so. `runMigrations` writes this table
-- under the owner role; the application must never be able to forge
-- migration history. `packages/db/test/bootstrap.integration.test.ts`
-- holds the privilege at exactly SELECT and fails if it ever widens.
--
-- Migration id note: 0066-0069 are reserved in
-- docs/IMPROVEMENT-PROGRAMME-2026-08-13.md §2.1 for wave-3 packs that have
-- not started. P6 had no reserved number, so it takes the next free one
-- rather than disturbing those reservations. The runner applies any
-- unapplied id regardless of relative order, so a lower id arriving later
-- still runs.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT ON schema_migrations TO auto_mb_app;
  END IF;
END
$$;
