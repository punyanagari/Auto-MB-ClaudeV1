-- Migration 0064: every document counter is monotonic, and a tax invoice
-- sequence number is unique inside its financial year.
--
-- Two numbering invariants that the product has always relied on but that
-- the database enforced only in part.
--
-- 1. COUNTER MONOTONICITY. `app_private.guard_counter_decrease()` has
--    existed since 0003, and 0051 and 0056 wrote their own copies of it,
--    but only six of the eleven counter tables ever carried the trigger:
--
--      guarded   delivery_challan_counters, issue_challan_counters,
--                correction_notice_counters, measurement_book_counters,
--                credit_note_counters, standalone_challan_counters
--      unguarded bill_counters, budgetary_quotation_counters,
--                purchase_order_counters, tax_invoice_counters
--      exempt    extension_request_counters
--
--    A decreased counter is how a number gets reused, and a reused number
--    on a statutory document is the failure this whole family of guards
--    exists to prevent. `tax_invoice_counters` being in the unguarded half
--    is the worst of the four: it numbers the GST invoice.
--
--    `extension_request_counters` is deliberately NOT guarded, and this is
--    the one counter where that is correct. Migration 0029 gave the manual
--    back-fill of paper extension letters a delete path, and the mechanism
--    that keeps the sequence gapless is a DECREMENT: deleting the
--    top-of-sequence letter runs
--    `UPDATE extension_request_counters SET next_value = next_value - 1
--     WHERE ... AND next_value = OLD.sequence_number`, and the row not
--    being found is exactly how a non-top delete is refused. 0029 also
--    relaxed that table's CHECK to `next_value >= 0` for the same reason.
--    Its invariant is gaplessness, not monotonicity, and a decrease guard
--    would break the delete path outright. Recorded here, and in
--    `packages/db/test/migration-contract.test.ts`, so the exemption is a
--    decision rather than another gap.
--
--    The four missing triggers are added here. The shared 0003 function is
--    replaced so its message names the table that refused the write rather
--    than always saying "delivery challan"; it also gains the explicit
--    `search_path` and the `23514` SQLSTATE its 0051 and 0056 siblings
--    already carry, so a caller sees one integrity-violation class for all
--    ten guarded tables. No caller matches on the old message text.
--
-- 2. TAX INVOICE SEQUENCE UNIQUENESS. `tax_invoices` constrains
--    `invoice_number` to be unique per organisation, but nothing
--    constrained the (financial year, sequence number) pair the number is
--    rendered FROM. A number template change, a prefix edit, or a counter
--    repair could therefore produce two invoices carrying sequence 7 of
--    2026-27 under two different invoice_number strings — a gap-free
--    series is only provable if the sequence itself is unique.
--    `delivery_challans` has carried exactly this index since 0003; tax
--    invoices get the financial-year form of it here.
--
-- Neither change rewrites a row. Rollback is `DROP TRIGGER` on the four
-- tables plus `DROP INDEX tax_invoices_sequence_per_fy`; the replaced
-- function's previous body is in 0003 and is restored by replacing it
-- back.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. The shared monotonicity guard, told which table it is protecting.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_private.guard_counter_decrease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION '% must not decrease', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 2. The four counter tables that never had the trigger and should.
--
-- Named after the 0003/0014/0019/0024 convention so the ten triggers read
-- as one family in the catalog.
-- ---------------------------------------------------------------------

CREATE TRIGGER bill_counters_guard_decrease
BEFORE UPDATE ON bill_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TRIGGER budgetary_quotation_counters_guard_decrease
BEFORE UPDATE ON budgetary_quotation_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TRIGGER purchase_order_counters_guard_decrease
BEFORE UPDATE ON purchase_order_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TRIGGER tax_invoice_counters_guard_decrease
BEFORE UPDATE ON tax_invoice_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- ---------------------------------------------------------------------
-- 3. One tax invoice per (organisation, financial year, sequence number).
--
-- The preflight names the offending rows before the index could report a
-- generic uniqueness violation with no way to find them. Drafts carry a
-- NULL sequence_number and are excluded by the partial predicate, exactly
-- as delivery_challans_sequence_per_work does for draft challans.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(
           format('%s/%s/%s (%s invoices)',
                  duplicates.organisation_id, duplicates.fy_label,
                  duplicates.sequence_number, duplicates.repeats),
           '; ')
    INTO offender
  FROM (
    SELECT organisation_id, fy_label, sequence_number, count(*) AS repeats
    FROM tax_invoices
    WHERE sequence_number IS NOT NULL
    GROUP BY organisation_id, fy_label, sequence_number
    HAVING count(*) > 1
  ) duplicates;

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'tax invoice sequence numbers repeat inside a financial year: %', offender
      USING ERRCODE = '23505';
  END IF;
END
$$;

CREATE UNIQUE INDEX tax_invoices_sequence_per_fy
  ON tax_invoices (organisation_id, fy_label, sequence_number)
  WHERE sequence_number IS NOT NULL;
