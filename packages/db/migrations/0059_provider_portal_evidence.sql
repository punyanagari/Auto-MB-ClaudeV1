-- Migration 0059: record WHICH portal answered a statutory provider
-- operation (finding 2 residue, docs/AUDIT-DISPOSITION-2026-08-10.md).
--
-- The operation ledger already retained WHAT was sent and WHAT came back
-- (0053's raw request and response bodies) and WHICH GSP was configured
-- (`provider`). It did not retain which government portal actually
-- answered. Those are different facts: `provider` is which GSP the
-- deployment bought, while a GSP routes an organisation to one of NIC's
-- IRPs and can move it between them without any change here. A later
-- dispute over one registration has to know whose records to ask for, and
-- a signature check against the answering portal's certificate — the half
-- of local verification this pack deliberately does NOT implement — needs
-- to know which certificate that would be.
--
-- So `provider_portal` is written at operation start from the answering
-- adapter's own configuration, and joins the operation's immutable
-- identity: it is part of what the operation WAS, not something learned
-- from the response, and it must not be rewritten afterwards.
--
-- Rows that predate this migration keep NULL. Backfilling them from the
-- current configuration would be a fabrication — the portal in force when
-- those operations ran is not recoverable from anything in the database —
-- and NULL honestly reads "not recorded" rather than asserting a portal
-- that may be wrong. The column is therefore nullable by design.
--
-- Numbering note: 0058 is deliberately skipped — it is reserved by the
-- omission/variation reference branch in flight. The migration runner keys
-- strictly on the four-digit id (packages/db/src/migration-runner.ts
-- refuses duplicates and hash/rename drift but never requires
-- contiguity), so the gap is safe and 0058 can land later in either
-- order. 0052 and 0057 set the same precedent.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE statutory_provider_operations
  ADD COLUMN provider_portal text
    CHECK (
      provider_portal IS NULL
      OR (length(provider_portal) BETWEEN 1 AND 120)
    );

COMMENT ON COLUMN statutory_provider_operations.provider_portal IS
  'Which portal answered: the NIC IRP the adapter routed to and the provider host it routed through. NULL on rows that predate migration 0059; never backfilled, because the portal then in force is not recoverable.';

-- ---------------------------------------------------------------------------
-- The append-once guard, recreated verbatim from 0053's text with one
-- addition: provider_portal joins the immutable identity ROW. Every other
-- clause — 0041's completed-row immutability, 0051's credit-note pinning,
-- 0053's raw-body arms — is carried across unchanged.

CREATE OR REPLACE FUNCTION app_private.guard_statutory_operation_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'completed statutory provider operations are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.tax_invoice_id, NEW.eway_bill_id,
    NEW.credit_note_id,
    NEW.provider, NEW.provider_portal, NEW.environment, NEW.operation,
    NEW.correlation_id,
    NEW.request_sha256, NEW.request_body, NEW.request_body_truncated,
    NEW.created_by_user_id, NEW.started_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.tax_invoice_id, OLD.eway_bill_id,
    OLD.credit_note_id,
    OLD.provider, OLD.provider_portal, OLD.environment, OLD.operation,
    OLD.correlation_id,
    OLD.request_sha256, OLD.request_body, OLD.request_body_truncated,
    OLD.created_by_user_id, OLD.started_at
  ) THEN
    RAISE EXCEPTION 'statutory provider operation identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'pending' AND ROW(
    NEW.response_body, NEW.response_body_truncated
  ) IS DISTINCT FROM ROW(
    OLD.response_body, OLD.response_body_truncated
  ) THEN
    RAISE EXCEPTION 'provider response evidence lands only when the operation completes'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
