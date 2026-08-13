-- Migration 0056: the Delivery Challan becomes a top-level module.
--
-- The owner's domain correction (2026-08-12): the Issue Challan is stock
-- issuance out of a consignee's store and is NOT the movement instrument.
-- The DELIVERY Challan is the movement document, and it has to cover three
-- cases rather than one:
--
--   (a) work challans whose lines are LOA schedule items — today's supply
--       flow, unchanged in every respect;
--   (b) work challans that also carry NON-LOA lines (installation material:
--       poles, bolts, consumables) which belong to no schedule item;
--   (c) standalone challans with no Work at all — factory to a private
--       customer, a vendor, or a job worker.
--
-- The invariant this migration exists to protect is LEDGER INERTNESS: only
-- a line that names a work_item, on a challan that names a Work, may move
-- the quantity ledger. Manual lines and standalone challans are movement
-- paperwork and nothing else. Section 4 binds that in the delivery-ceiling
-- guard; every other ledger reader already keys on work_item_id and is
-- inert by construction (measurement-book sourcing, work-completion maths,
-- the work balance, the purchase-order receipt joins).
--
-- Statutory facts (HSN, movement reason, party GSTIN) and e-way bills are
-- stage 3b and deliberately absent here.
--
-- Existing rows are all work challans, so challan_kind's DEFAULT 'work'
-- and the nullable columns require zero backfill.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. delivery_challans: a kind, an optional Work, a consignee contact,
--    and the financial year a standalone number counts in.
-- ---------------------------------------------------------------------

ALTER TABLE delivery_challans ALTER COLUMN work_id DROP NOT NULL;

ALTER TABLE delivery_challans
  ADD COLUMN challan_kind text NOT NULL DEFAULT 'work'
    CHECK (challan_kind IN ('work', 'standalone'));

-- The consignee of a standalone challan comes from the contacts master:
-- there is no Work to hang the party off, and "one open draft per
-- consignee" (section 3) needs a stable identity to count against. Work
-- challans keep their free-text consignee snapshot and leave this null.
ALTER TABLE delivery_challans ADD COLUMN consignee_contact_id uuid;

ALTER TABLE delivery_challans
  ADD CONSTRAINT delivery_challans_consignee_contact_fkey
  FOREIGN KEY (organisation_id, consignee_contact_id)
  REFERENCES contacts(organisation_id, id);

-- The financial year a standalone sequence counts in, frozen at issue.
-- Work challans count per Work and carry none.
ALTER TABLE delivery_challans
  ADD COLUMN fy_label text
    CHECK (fy_label IS NULL OR fy_label ~ '^[0-9]{4}-[0-9]{2}$');

-- The shape check: kind and work_id are one fact written twice, and the
-- standalone consignee is mandatory because the draft rule counts on it.
ALTER TABLE delivery_challans
  ADD CONSTRAINT delivery_challans_kind_shape CHECK (
    (challan_kind = 'work'
      AND work_id IS NOT NULL
      AND consignee_contact_id IS NULL
      AND fy_label IS NULL)
    OR
    (challan_kind = 'standalone'
      AND work_id IS NULL
      AND consignee_contact_id IS NOT NULL)
  );

-- A standalone challan's sequence is unique per (organisation, financial
-- year), the same shape 0003 gave the per-Work sequence. It needs saying
-- separately because 0003's index leads with work_id, which is NULL here,
-- and NULLs never collide in a unique index — every standalone row would
-- be distinct from every other one and the index would prove nothing.
CREATE UNIQUE INDEX delivery_challans_standalone_sequence_per_fy
  ON delivery_challans (organisation_id, fy_label, sequence_number)
  WHERE challan_kind = 'standalone' AND sequence_number IS NOT NULL;

-- Register listing: the module's own screen orders by date across kinds.
CREATE INDEX delivery_challans_register_idx
  ON delivery_challans (organisation_id, challan_kind, status, challan_date DESC, id);

CREATE INDEX delivery_challans_consignee_contact_idx
  ON delivery_challans (organisation_id, consignee_contact_id);

COMMENT ON COLUMN delivery_challans.challan_kind IS
  'work = the challan belongs to a Work (LOA supply and/or non-LOA '
  'installation material); standalone = factory to a private customer, '
  'vendor, or job worker, with no Work and no quantity-ledger effect.';

-- ---------------------------------------------------------------------
-- 2. delivery_challan_items: manual (non-LOA) lines.
-- ---------------------------------------------------------------------

ALTER TABLE delivery_challan_items ALTER COLUMN work_item_id DROP NOT NULL;
ALTER TABLE delivery_challan_items ALTER COLUMN work_id DROP NOT NULL;

-- Parentage must stay enforced when work_id is NULL. The existing
-- (organisation_id, delivery_challan_id, work_id) foreign key is MATCH
-- SIMPLE, so a NULL work_id switches it off entirely — on a standalone
-- line it would check nothing at all. This two-column key never has a
-- NULL and therefore always fires; the three-column one keeps binding the
-- line's Work to the challan's Work whenever both are present.
ALTER TABLE delivery_challan_items
  ADD CONSTRAINT delivery_challan_items_challan_fkey
  FOREIGN KEY (organisation_id, delivery_challan_id)
  REFERENCES delivery_challans(organisation_id, id);

-- The uniqueness rule "one line per work item per challan" is about work
-- items, so it has to stop applying where there is no work item: as a
-- plain UNIQUE constraint two manual lines both read (org, challan, NULL)
-- and, while SQL NULLs do not collide, the constraint also stops carrying
-- any meaning. A partial index says exactly what is meant and lets a
-- challan carry as many manual lines as the movement needs.
ALTER TABLE delivery_challan_items
  DROP CONSTRAINT delivery_challan_items_organisation_id_delivery_challan_id__key;

CREATE UNIQUE INDEX delivery_challan_items_one_line_per_work_item
  ON delivery_challan_items (organisation_id, delivery_challan_id, work_item_id)
  WHERE work_item_id IS NOT NULL;

-- A work_item line always names the Work it belongs to; the three-column
-- foreign key then proves the Work is the challan's own.
ALTER TABLE delivery_challan_items
  ADD CONSTRAINT delivery_challan_items_work_item_needs_work CHECK (
    work_item_id IS NULL OR work_id IS NOT NULL
  );

-- A manual line snapshots nothing from a work item, so its printed text
-- has to stand on its own. description_snapshot and unit_snapshot are
-- already NOT NULL; what was missing is that they must not be BLANK —
-- this document is handed to the consignee. rate_snapshot and line_amount
-- are NOT NULL with >= 0 checks from 0001 and stay as they are.
ALTER TABLE delivery_challan_items
  ADD CONSTRAINT delivery_challan_items_manual_line_printable CHECK (
    work_item_id IS NOT NULL
    OR (length(btrim(description_snapshot)) BETWEEN 1 AND 500
        AND length(btrim(unit_snapshot)) BETWEEN 1 AND 30)
  );

CREATE INDEX delivery_challan_items_manual_idx
  ON delivery_challan_items (organisation_id, delivery_challan_id)
  WHERE work_item_id IS NULL;

COMMENT ON COLUMN delivery_challan_items.work_item_id IS
  'The LOA schedule item this line delivers, or NULL for a manual '
  '(non-LOA) line. Only non-NULL lines reach the quantity ledger.';

-- ---------------------------------------------------------------------
-- 3. The kind is structural: it binds the lines and never changes.
-- ---------------------------------------------------------------------

-- A standalone challan carries ONLY manual lines. Without this a caller
-- with direct SQL could attach a work_item line to a challan with no
-- Work: the three-column foreign key is MATCH SIMPLE and the line's NULL
-- work_id switches it off, so nothing else in the schema would object,
-- and that line WOULD count in the ledger aggregates.
CREATE FUNCTION app_private.guard_delivery_challan_item_kind()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text;
  v_work uuid;
BEGIN
  SELECT challan_kind, work_id INTO v_kind, v_work
  FROM delivery_challans
  WHERE organisation_id = NEW.organisation_id
    AND id = NEW.delivery_challan_id;

  IF v_kind IS NULL THEN
    RAISE EXCEPTION
      'delivery challan line names challan %, which this transaction cannot read',
      NEW.delivery_challan_id
      USING ERRCODE = '23514';
  END IF;

  IF v_kind = 'standalone' THEN
    IF NEW.work_item_id IS NOT NULL THEN
      RAISE EXCEPTION
        'a standalone Delivery Challan carries no work item lines'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.work_id IS NOT NULL THEN
      RAISE EXCEPTION
        'a standalone Delivery Challan line belongs to no Work'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.work_id IS DISTINCT FROM v_work THEN
    -- Manual lines on a work challan escape the three-column foreign key
    -- only when work_id is NULL; say the rule directly instead.
    RAISE EXCEPTION
      'a Delivery Challan line must name the challan''s own Work'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- Fires alongside delivery_challan_items_guard_mutation (0001), which
-- decides whether the line may be written at all.
CREATE TRIGGER delivery_challan_items_guard_kind
BEFORE INSERT OR UPDATE ON delivery_challan_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_delivery_challan_item_kind();

-- Serial traceability (R6) is a Work-item guarantee: a serial identifies
-- a physical unit of a sanctioned item, and installation reads it back
-- through work_item_id. challan_item_serials.work_id is NOT NULL and its
-- foreign key names delivery_challans(organisation_id, id, work_id), so a
-- standalone challan is already unreachable; a MANUAL line on a work
-- challan is not, and it has no work item to be traceable against.
CREATE FUNCTION app_private.guard_challan_item_serial_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_work_item uuid;
  v_found boolean;
BEGIN
  SELECT line.work_item_id, true INTO v_work_item, v_found
  FROM delivery_challan_items line
  WHERE line.organisation_id = NEW.organisation_id
    AND line.id = NEW.delivery_challan_item_id;

  IF v_found IS NULL THEN
    RAISE EXCEPTION
      'serial names delivery challan line %, which this transaction cannot read',
      NEW.delivery_challan_item_id
      USING ERRCODE = '23514';
  END IF;

  IF v_work_item IS NULL THEN
    RAISE EXCEPTION
      'serials are recorded against LOA item lines, not manual lines'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER challan_item_serials_guard_line
BEFORE INSERT OR UPDATE ON challan_item_serials
FOR EACH ROW EXECUTE FUNCTION app_private.guard_challan_item_serial_line();

-- The kind is decided when the challan is created and never again: a
-- flip would strand the lines already written under the other rule, and
-- on an issued challan it would rewrite what the consignee was handed.
--
-- The body below is 0032's VERBATIM — which is 0031's, which restated
-- 0018's, which restated 0001's — plus two additions: the kind clause,
-- and challan_kind / consignee_contact_id / fy_label in the
-- issued-immutability row comparison. Nothing is dropped: the warranty
-- columns (0018), the final-Measurement-Book and completed-Work issue
-- refusals (0031), and the completed-Work cancel refusal (0032) all
-- survive intact. The Work-shaped clauses are guarded on NEW.work_id so
-- a standalone challan, which has none, does not run a lookup that could
-- never match.
CREATE OR REPLACE FUNCTION app_private.guard_delivery_challan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Delivery Challans are immutable';
  END IF;

  IF NEW.challan_kind IS DISTINCT FROM OLD.challan_kind THEN
    RAISE EXCEPTION 'a Delivery Challan''s kind is fixed when it is created';
  END IF;

  IF OLD.status = 'issued' THEN
    IF NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION 'issued Delivery Challans may only remain issued or be cancelled';
    END IF;

    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.challan_date, NEW.challan_number,
      NEW.sequence_number, NEW.prefix, NEW.consignee_snapshot, NEW.issued_snapshot,
      NEW.template_version, NEW.warranty_template_version, NEW.warranty_text_sha256,
      NEW.created_by_user_id, NEW.issued_by_user_id, NEW.issued_at,
      NEW.challan_kind, NEW.consignee_contact_id, NEW.fy_label
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.challan_date, OLD.challan_number,
      OLD.sequence_number, OLD.prefix, OLD.consignee_snapshot, OLD.issued_snapshot,
      OLD.template_version, OLD.warranty_template_version, OLD.warranty_text_sha256,
      OLD.created_by_user_id, OLD.issued_by_user_id, OLD.issued_at,
      OLD.challan_kind, OLD.consignee_contact_id, OLD.fy_label
    ) THEN
      RAISE EXCEPTION 'issued Delivery Challan business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Delivery Challans are deleted, not cancelled';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'issued' AND NEW.work_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM measurement_books mb
      WHERE mb.organisation_id = NEW.organisation_id
        AND mb.work_id = NEW.work_id
        AND mb.is_final
        AND mb.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION
        'a final Measurement Book exists for this Work; issuing this delivery challan would create a source that can never be billed'
        USING ERRCODE = 'check_violation';
    END IF;

    -- R8: a completed Work accepts no new operational documents.
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = NEW.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before issuing a delivery challan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- R8 (0032): nor may the delivered quantity the completion predicate
  -- was measured against be withdrawn from under it.
  IF OLD.status <> 'cancelled' AND NEW.status = 'cancelled'
     AND NEW.work_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = NEW.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before cancelling a delivery challan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- One open draft per consignee, for standalone challans only. The 0001
-- index on (organisation_id, work_id) WHERE draft self-excludes these
-- rows — their work_id is NULL and NULLs never collide — so the per-Work
-- rule is untouched and this is a genuinely new statement, not a
-- replacement.
CREATE UNIQUE INDEX delivery_challans_one_standalone_draft_per_consignee
  ON delivery_challans (organisation_id, consignee_contact_id)
  WHERE status = 'draft' AND challan_kind = 'standalone';

-- ---------------------------------------------------------------------
-- 4. LEDGER INERTNESS: the delivery ceiling counts work_item lines only.
--
-- 0046 bound the delivery ceiling at the issue transition. Its aggregate
-- joined delivery_challan_items to work_items, which alone would already
-- drop NULL work_item_id lines — a join predicate is not a stated rule,
-- and this is the invariant the whole module rests on. Both halves now
-- say it outright, and a standalone challan returns before the ceiling
-- machinery starts: it has no Work, so there is no sanctioned quantity
-- for it to be measured against.
--
-- Everything else in section 3 of 0046 is reproduced verbatim: the
-- issued-only gate, the draft -> issued transition test, the
-- allow_excess_delivery escape hatch, the ascending-item-id FOR UPDATE
-- lock order shared with the issue route, and the breach message.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_delivery_challan_quantity_ceiling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_allow_excess boolean;
  v_line record;
  v_delivered numeric(18,3);
  v_breaches text[] := ARRAY[]::text[];
BEGIN
  IF NEW.status <> 'issued' THEN
    RETURN NEW;
  END IF;
  -- Only the draft -> issued transition adds delivered quantity. Later updates
  -- of an already-issued challan (render pointers, warranty stamps) change no
  -- line, and 0001 keeps the lines themselves frozen once the challan leaves
  -- draft. OLD is read only under an explicit TG_OP test: plpgsql leaves it
  -- unassigned on INSERT and SQL boolean operators do not promise
  -- short-circuit evaluation.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'issued' THEN
      RETURN NEW;
    END IF;
  END IF;

  -- A standalone challan (0056) belongs to no Work, carries no work_item
  -- lines, and delivers nothing against a sanctioned quantity. It never
  -- enters the ceiling path at all.
  IF NEW.work_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT work.allow_excess_delivery INTO v_allow_excess
  FROM works work
  WHERE work.organisation_id = NEW.organisation_id AND work.id = NEW.work_id;
  -- An unreadable Work leaves v_allow_excess NULL, which is not true, so the
  -- check below still runs: the cap is lifted only by a Work that says so.
  IF v_allow_excess THEN
    RETURN NEW;
  END IF;

  FOR v_line IN
    SELECT item.id AS work_item_id,
           item.item_number,
           COALESCE(item.effective_quantity, item.awarded_quantity) AS ceiling,
           line.quantity
    FROM delivery_challan_items line
    JOIN work_items item
      ON item.organisation_id = line.organisation_id AND item.id = line.work_item_id
    WHERE line.organisation_id = NEW.organisation_id
      AND line.delivery_challan_id = NEW.id
      -- Manual (non-LOA) lines are movement paperwork: they name no
      -- sanctioned item, so no ceiling applies to them.
      AND line.work_item_id IS NOT NULL
    ORDER BY item.id
    FOR UPDATE OF item
  LOOP
    SELECT COALESCE(sum(issued_line.quantity), 0) INTO v_delivered
    FROM delivery_challan_items issued_line
    JOIN delivery_challans issued
      ON issued.organisation_id = issued_line.organisation_id
     AND issued.id = issued_line.delivery_challan_id
    WHERE issued_line.organisation_id = NEW.organisation_id
      AND issued_line.work_item_id = v_line.work_item_id
      -- Redundant beside the equality above and stated anyway: this sum
      -- IS the delivered quantity the ledger reports, and it must be
      -- readable as "work_item lines only" without inference.
      AND issued_line.work_item_id IS NOT NULL
      AND issued_line.delivery_challan_id <> NEW.id
      AND issued.status = 'issued';

    IF v_delivered + v_line.quantity > v_line.ceiling THEN
      v_breaches := v_breaches || (
        v_line.item_number || ' (' || (v_delivered + v_line.quantity)::text
        || ' against ' || v_line.ceiling::text || ')'
      );
    END IF;
  END LOOP;

  IF array_length(v_breaches, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'delivery ceiling: issuing this Delivery Challan would exceed the sanctioned quantity for: %',
      array_to_string(v_breaches, ', ')
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 5. Standalone numbering: gap-free per (organisation, financial year).
--
-- A standalone challan has no Work, so the per-Work counter of 0001 has
-- no key to count under. The financial year is the scope the trade
-- already uses for every Work-free series in this product (tax invoices,
-- credit notes), and it is the scope this counter restarts on.
-- ---------------------------------------------------------------------
CREATE TABLE standalone_challan_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organisation_id, fy_label)
);

COMMENT ON TABLE standalone_challan_counters IS
  'Gap-free standalone Delivery Challan sequence per (organisation, '
  'financial year), mirroring tax_invoice_counters. The counter row lock '
  'serialises concurrent issues and a rolled-back issue rolls the counter '
  'back with it.';

CREATE FUNCTION app_private.guard_standalone_challan_counter_decrease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'standalone challan counters must not decrease'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER standalone_challan_counters_guard_decrease
BEFORE UPDATE ON standalone_challan_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_standalone_challan_counter_decrease();

-- ---------------------------------------------------------------------
-- 6. The number series learns the new document type — including its
--    SCOPE arm.
--
-- 0047's CHECK ends in ELSE true, so a document type that is added to the
-- document_type list and not to the CASE is exempted from the scope rule
-- entirely. That is finding 8 coming back in through the door it was
-- closed at, so the arm is written here in the same migration that makes
-- 'standalone_challan' a legal value.
--
-- The counter restarts each financial year while challan_number is unique
-- across the organisation, so {FY}/{FY2} is the structural scope mark.
-- {PREFIX} is admitted on the same footing 0047 gives it to the work
-- challan: the prefix is operator text on an editable DRAFT, so a
-- collision answers as a named 409 at issue time with the prefix as the
-- way out, and the series does not wedge. It is the weaker mark of the
-- two — an operator who scopes only by prefix has to change it each year
-- — and the product default below uses {FY} precisely so nobody has to.
-- ---------------------------------------------------------------------

-- Preflight with an actionable message, exactly as 0047 and 0051 do.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(
           format('organisation %s: %s template %L',
                  organisation_id, document_type, template),
           '; ')
    INTO offending
    FROM document_number_series
   WHERE document_type = 'standalone_challan'
     AND template NOT LIKE '%{FY%'
     AND template NOT LIKE '%{PREFIX%';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'standalone challan number templates lack their counter''s scope '
        'token: %s. Add {FY} or {FY2} (or, accepting the yearly prefix '
        'change, {PREFIX}) to standalone challan templates, then rerun '
        'the upgrade.',
        offending);
  END IF;
END
$$;

ALTER TABLE document_number_series
  DROP CONSTRAINT document_number_series_document_type_check;
ALTER TABLE document_number_series
  ADD CONSTRAINT document_number_series_document_type_check
    CHECK (document_type IN (
      'delivery_challan', 'issue_challan', 'tax_invoice',
      'budgetary_quotation', 'credit_note', 'standalone_challan'
    ));

ALTER TABLE document_number_series
  DROP CONSTRAINT document_number_series_scope;
ALTER TABLE document_number_series
  ADD CONSTRAINT document_number_series_scope CHECK (
    CASE document_type
      WHEN 'delivery_challan' THEN
        template LIKE '%{WORK%' OR template LIKE '%{PREFIX%'
      WHEN 'issue_challan' THEN
        template LIKE '%{WORK%' OR template LIKE '%{PREFIX%'
      WHEN 'tax_invoice' THEN
        template LIKE '%{FY%'
      WHEN 'credit_note' THEN
        template LIKE '%{FY%'
      WHEN 'standalone_challan' THEN
        template LIKE '%{FY%' OR template LIKE '%{PREFIX%'
      ELSE true
    END
  );

-- ---------------------------------------------------------------------
-- 7. Tenant isolation and least privilege for the new counter table.
-- ---------------------------------------------------------------------

ALTER TABLE standalone_challan_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE standalone_challan_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY standalone_challan_counters_tenant_policy
  ON standalone_challan_counters
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    -- Counters are never deleted: a released number is not reused.
    GRANT SELECT, INSERT, UPDATE ON standalone_challan_counters TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 8. The RLS posture 0003 asserts at catalog level still holds.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  unprotected_count integer;
BEGIN
  SELECT count(*) INTO unprotected_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname <> 'schema_migrations'
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected_count > 0 THEN
    RAISE EXCEPTION
      'every public table except schema_migrations must have RLS enabled and forced';
  END IF;
END
$$;
