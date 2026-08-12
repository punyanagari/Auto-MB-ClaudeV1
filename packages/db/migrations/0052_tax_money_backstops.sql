-- Migration 0052: bind the tax-invoice MONEY invariants in the database.
--
-- Source: the 12 August 2026 security review found two route-only money
-- invariants on tax_invoices with no database enforcement — novel findings,
-- not recorded in docs/AUDIT-DISPOSITION-2026-08-10.md:
--
--   A. Nothing ties the stored tax heads to the stored rate. A direct-SQL
--      writer or importer could store a SUBMITTED 18% invoice with ZERO tax
--      heads: the 0035 split-coherence CHECK passes (igst = 0, cgst >= 0,
--      sgst >= 0), the 0037 total-reconciliation CHECK passes (the total
--      faithfully re-adds the wrong parts), and the row becomes a frozen
--      legal document that under-charges the Government's tax.
--
--   B. Nothing ties WHICH heads carry the tax to the place of supply. An
--      inter-state invoice carrying a CGST/SGST split (or the reverse)
--      passes every existing CHECK for the same reason: the 0035 shape
--      constraint only proves the split is internally coherent, not that it
--      matches the supply geography the submit route decided it from.
--
-- Both rules live in apps/server/src/routes/tax-invoices.ts at submit; this
-- is the same writer class migration 0046 closed for quantities ("the route
-- is not the only writer the future holds", 0035 §3). Two guard triggers
-- below bind them, mirroring the route's arithmetic exactly.
--
-- Numbering note: 0051 is deliberately skipped — it is reserved by the
-- credit-notes branch in flight. The migration machinery keys strictly on
-- the four-digit id (packages/db/src/migration-runner.ts refuses duplicates
-- and hash/rename drift but never requires contiguity), so the gap is safe
-- and 0051 can land later in either order.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. Preflight for finding A: every stored money-carrying invoice must
-- already reconcile its heads with its rate, else the triggers below would
-- strand it — an UPDATE touching its money columns could never succeed.
-- Name every offender and the repair (0047/0048 style) instead of letting
-- the operator discover them one refusal at a time.
--
-- The arithmetic mirrors the submit route verbatim: intra-state charges
-- two equal halves of round(taxable * rate / 200, 2); inter-state charges
-- round(taxable * rate / 100, 2) as IGST. EITHER branch's figure is
-- accepted within one rupee, because this check owns the AMOUNT only —
-- which heads carry it is finding B's check — and because a one-rupee
-- tolerance absorbs paisa-level rounding drift in imported history without
-- ever excusing a materially wrong charge.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(
           format('invoice %s (%s) of organisation %s: heads %s + %s + %s '
                  'against taxable %s at rate %s%%',
                  ti.id, ti.invoice_number, ti.organisation_id,
                  ti.cgst_amount, ti.sgst_amount, ti.igst_amount,
                  ti.taxable_value, ti.gst_rate),
           '; ')
    INTO offending
    FROM tax_invoices ti
   WHERE ti.status <> 'draft'
     AND abs((ti.cgst_amount + ti.sgst_amount + ti.igst_amount)
             - 2 * round(ti.taxable_value * ti.gst_rate / 200, 2)) > 1.00
     AND abs((ti.cgst_amount + ti.sgst_amount + ti.igst_amount)
             - round(ti.taxable_value * ti.gst_rate / 100, 2)) > 1.00;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'tax invoices carry heads that do not reconcile with their GST rate: '
        '%s. Correct each row in a maintenance session (an issued row''s '
        'money is frozen by tax_invoices_issued_update_guard — disable it '
        'around the repair, as 0043 did), then rerun the upgrade.',
        offending);
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. Preflight for finding B: the split each stored invoice carries must
-- match its supply geography.
--
-- The organisation's state_code is MUTABLE while issued invoices are
-- frozen, so judging old invoices against the LIVE org state would produce
-- false positives for any organisation that moved states after issuing —
-- and a false positive here wedges the whole upgrade. The judgement
-- therefore prefers the supplier state FROZEN inside issued_snapshot at
-- submit (issued_snapshot->'supplier'->>'stateCode', the same path
-- apps/server/src/tax-invoice-snapshot.ts reads), falling back to the live
-- org state only when the snapshot does not carry one. A row for which
-- NEITHER state is known is undecidable and is deliberately not named: no
-- truth exists to check it against, wedging the upgrade on it would be a
-- false positive by construction, and the trigger below still binds every
-- future write of such a row (refusing outright while the org has no
-- state, exactly as the submit route does).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(
           format('invoice %s (%s) of organisation %s: place of supply %s '
                  'against supplier state %s carries cgst %s / sgst %s / igst %s',
                  judged.id, judged.invoice_number, judged.organisation_id,
                  judged.place_of_supply, judged.supplier_state,
                  judged.cgst_amount, judged.sgst_amount, judged.igst_amount),
           '; ')
    INTO offending
    FROM (
      SELECT ti.*,
             COALESCE(ti.issued_snapshot->'supplier'->>'stateCode',
                      org.state_code) AS supplier_state
        FROM tax_invoices ti
        JOIN organisations org ON org.id = ti.organisation_id
       WHERE ti.status <> 'draft'
    ) judged
   WHERE judged.supplier_state IS NOT NULL
     AND ((judged.supplier_state = judged.place_of_supply
           AND judged.igst_amount <> 0)
          OR (judged.supplier_state <> judged.place_of_supply
              AND (judged.cgst_amount <> 0 OR judged.sgst_amount <> 0)));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'tax invoices carry a CGST+SGST/IGST split that contradicts their '
        'place of supply: %s. Correct each row in a maintenance session (an '
        'issued row''s money is frozen by tax_invoices_issued_update_guard — '
        'disable it around the repair, as 0043 did), then rerun the upgrade.',
        offending);
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 3. Finding A's guard: the tax heads reconcile with the rate.
--
-- Fires only for rows carrying money (status <> 'draft'; the 0035/0037
-- draft-shape CHECK keeps every money column NULL on drafts, so a draft
-- has nothing to reconcile). The expected figure is computed BOTH ways the
-- submit route can — intra-state as 2 * round(taxable * rate / 200, 2),
-- inter-state as round(taxable * rate / 100, 2) — and either is accepted
-- within one rupee. Accepting either branch's arithmetic is what lets this
-- trigger and the split-placement trigger below compose without
-- double-firing: this one owns HOW MUCH tax the row carries, the sibling
-- owns WHICH heads carry it. A zero rate expects zero from both branches,
-- so a rate-0 invoice with zero heads passes naturally.
--
-- SECURITY INVOKER: the check reads nothing beyond NEW, so it needs no
-- privilege and no tenancy predicate.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_tax_invoice_tax_heads()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_heads numeric(18, 2);
  v_intra numeric(18, 2);
  v_inter numeric(18, 2);
BEGIN
  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Transitions of an already-issued row (cancel, IRP evidence arrival)
  -- leave the money columns untouched — the 0041/0049 issued-update guard
  -- freezes them — so a figure this guard already accepted is not re-judged.
  -- OLD is read only under an explicit TG_OP test: plpgsql leaves it
  -- unassigned on INSERT and SQL boolean operators do not promise
  -- short-circuit evaluation.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'draft'
       AND NEW.taxable_value IS NOT DISTINCT FROM OLD.taxable_value
       AND NEW.gst_rate IS NOT DISTINCT FROM OLD.gst_rate
       AND NEW.cgst_amount IS NOT DISTINCT FROM OLD.cgst_amount
       AND NEW.sgst_amount IS NOT DISTINCT FROM OLD.sgst_amount
       AND NEW.igst_amount IS NOT DISTINCT FROM OLD.igst_amount THEN
      RETURN NEW;
    END IF;
  END IF;

  v_heads := NEW.cgst_amount + NEW.sgst_amount + NEW.igst_amount;
  v_intra := 2 * round(NEW.taxable_value * NEW.gst_rate / 200, 2);
  v_inter := round(NEW.taxable_value * NEW.gst_rate / 100, 2);
  IF abs(v_heads - v_intra) > 1.00 AND abs(v_heads - v_inter) > 1.00 THEN
    RAISE EXCEPTION
      'tax heads do not reconcile with the GST rate: cgst % + sgst % + igst % = % against taxable % at rate %, which the submit arithmetic puts at % (intra) or % (inter)',
      NEW.cgst_amount, NEW.sgst_amount, NEW.igst_amount, v_heads,
      NEW.taxable_value, NEW.gst_rate, v_intra, v_inter
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 4. Finding B's guard: the split head matches the place of supply.
--
-- For rows carrying money: place_of_supply equal to the organisation's own
-- state means intra-state supply, so IGST must be zero (the 0035 shape
-- CHECK then keeps CGST/SGST coherent); any other place of supply means
-- inter-state, so CGST and SGST must both be zero. This is exactly the
-- branch the submit route takes when it computes the money.
--
-- The organisation's state_code is mutable while issued invoices are
-- frozen. That is not a contradiction here: this trigger fires only on
-- WRITES, so a new or changed money row must match the org state at write
-- time — precisely what the route enforces at submit — while historical
-- rows are never re-fired, and the 0041/0049 issued-update guard prevents
-- their money from being rewritten anyway. The frozen-row skip below keeps
-- that honest in the one place they meet: cancelling (or stamping IRP
-- evidence on) an issued invoice after the organisation moved states
-- changes no deciding column and therefore is not re-judged against the
-- new state, which would otherwise wedge a legitimate cancel.
--
-- SECURITY DEFINER (the owner bypasses RLS), so the cross-table read
-- carries its own tenancy pin: organisations is the tenant ROOT — its
-- primary key IS the tenant id — so the pinned predicate is
-- id = NEW.organisation_id. Deliberately NOT current_organisation_id():
-- direct writers may run as admin outside a bound tenant transaction, and
-- the trigger must still bind there (an unbound read would find no row and
-- judge nothing). The 0046 review found a definer guard reading across
-- tenants once; this one does not repeat it.
--
-- Lock order: the parent organisations row is read with a plain SELECT, no
-- FOR UPDATE. 0046's guards lock work_items because their invariant is an
-- AGGREGATE over child rows — two concurrent writers each inside the
-- ceiling could jointly breach it, so the sum must serialise on the parent
-- row. This invariant is row-local against a single parent attribute:
-- concurrent invoice writers cannot jointly breach it, so there is no sum
-- to protect and nothing for the lock to serialise. A concurrent
-- organisation state change committing after this read is the mutable-
-- state case above — the invoice is judged against the state current at
-- its own write, and a later change never re-opens it — and the submit
-- route reads the organisation row with a plain SELECT for the same
-- decision, so taking a lock here would add a works-vs-organisations lock
-- edge no route holds today.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_tax_invoice_split_place()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
BEGIN
  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Frozen-row skip; see the trigger comment. OLD only under TG_OP.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'draft'
       AND NEW.place_of_supply IS NOT DISTINCT FROM OLD.place_of_supply
       AND NEW.cgst_amount IS NOT DISTINCT FROM OLD.cgst_amount
       AND NEW.sgst_amount IS NOT DISTINCT FROM OLD.sgst_amount
       AND NEW.igst_amount IS NOT DISTINCT FROM OLD.igst_amount THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT org.state_code INTO v_state
    FROM organisations org
   WHERE org.id = NEW.organisation_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION
      'the organisation has no GST state code, so the CGST+SGST/IGST split of this money-carrying invoice is undecidable — set it first (the submit route refuses the same way)'
      USING ERRCODE = '23514';
  END IF;

  IF v_state = NEW.place_of_supply THEN
    IF NEW.igst_amount <> 0 THEN
      RAISE EXCEPTION
        'place of supply % equals the organisation state, an intra-state supply — IGST must be 0, not %',
        NEW.place_of_supply, NEW.igst_amount
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.cgst_amount <> 0 OR NEW.sgst_amount <> 0 THEN
      RAISE EXCEPTION
        'place of supply % differs from organisation state %, an inter-state supply — CGST and SGST must be 0, not % and %',
        NEW.place_of_supply, v_state, NEW.cgst_amount, NEW.sgst_amount
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 5. The triggers. BEFORE INSERT OR UPDATE OF the deciding money/status
-- columns, so submit-time updates (which set all of them) are judged while
-- unrelated updates of a draft (description, notes) never pay the read.
-- Both fire after tax_invoices_issued_update_guard in the alphabetical
-- BEFORE order, so a rewrite of frozen money is refused by the freeze
-- before either guard would re-judge it.
-- ---------------------------------------------------------------------
CREATE TRIGGER tax_invoices_split_place_guard
BEFORE INSERT OR UPDATE OF
  status, place_of_supply, cgst_amount, sgst_amount, igst_amount
ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_split_place();

CREATE TRIGGER tax_invoices_tax_heads_guard
BEFORE INSERT OR UPDATE OF
  status, gst_rate, taxable_value, cgst_amount, sgst_amount, igst_amount
ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_tax_heads();
