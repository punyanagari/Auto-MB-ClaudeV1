SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0057: the ITEMISED tax invoice — stage 1 of the e-way-bill
-- programme.
--
-- 0035 recorded the owner's model at the time: a works contract is a
-- supply of services, so the tax invoice is CUMULATIVE — one service line
-- at a SAC for the finalized Measurement Book's total, "never a per-item
-- HSN document". That statement has been corrected by the owner: practice
-- VARIES BY COMPANY. Some vendors put HSN goods items on Railway invoices
-- too, and private customers commonly take HSN goods supply outright.
--
-- The consequence, settled with the owner and binding on everything that
-- follows: the goods-vs-service shape of an invoice is a PER-DOCUMENT
-- choice with an ORGANISATION DEFAULT for the create form. It is NEVER
-- derived from the buyer, from the Work, or from anything else about who
-- is being billed — a Railway invoice may be itemised and a private one
-- cumulative. E-way-bill applicability will later follow from the
-- document's CONTENT (does it carry goods lines), not from its buyer;
-- that is stage 2 and no part of this migration.
--
-- Zero backfill: line_shape defaults to 'service_cumulative', which is
-- exactly what every stored invoice is, so no existing row changes and no
-- existing document's meaning moves.
--
-- Numbering note: 0056 is deliberately skipped — it is reserved by the
-- Delivery Challan branch in flight. The migration runner keys strictly on
-- the four-digit id (packages/db/src/migration-runner.ts refuses duplicates
-- and hash/rename drift but never requires contiguity), so the gap is safe
-- and 0056 can land later in either order. 0052 set the same precedent.

-- ---------------------------------------------------------------------
-- 1. The per-document choice, and the organisation default behind it.

ALTER TABLE organisations
  ADD COLUMN default_invoice_shape text NOT NULL DEFAULT 'service_cumulative'
    CHECK (default_invoice_shape IN ('service_cumulative', 'itemised'));

COMMENT ON COLUMN organisations.default_invoice_shape IS
  'Which line shape the invoice CREATE FORM starts on. A default only: '
  'the shape is chosen per document and this never overrides, migrates '
  'or re-interprets an invoice that already exists.';

ALTER TABLE tax_invoices
  ADD COLUMN line_shape text NOT NULL DEFAULT 'service_cumulative'
    CHECK (line_shape IN ('service_cumulative', 'itemised'));

COMMENT ON COLUMN tax_invoices.line_shape IS
  'service_cumulative: one cumulative SERVICE line carried by the header '
  'columns (sac_code, service_description, gst_rate), no tax_invoice_lines '
  'rows. itemised: those three header columns are NULL and the document is '
  'the tax_invoice_lines rows, each with its own HSN/SAC, quantity, rate '
  'and GST rate. A per-document fact, never derived from the buyer.';

-- ---------------------------------------------------------------------
-- 2. The cumulative line's header columns become conditional.
--
-- An itemised invoice has no header SAC, no header description and no
-- header GST rate — it has per-line ones — so the three NOT NULLs from
-- 0035 are relaxed and replaced by a shape constraint that is strictly
-- STRONGER for a cumulative invoice (all three present, as before) and
-- exact for an itemised one (all three absent, so nothing can read a
-- header rate off an itemised document and get an answer).
--
-- The column CHECKs from 0035 survive untouched and keep applying to
-- whatever is present: a NULL passes a column CHECK by definition.

ALTER TABLE tax_invoices
  ALTER COLUMN sac_code DROP NOT NULL,
  ALTER COLUMN service_description DROP NOT NULL,
  ALTER COLUMN gst_rate DROP NOT NULL;

ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_line_shape_header_shape CHECK (
    (line_shape = 'service_cumulative'
      AND sac_code IS NOT NULL
      AND service_description IS NOT NULL
      AND gst_rate IS NOT NULL)
    OR
    (line_shape = 'itemised'
      AND sac_code IS NULL
      AND service_description IS NULL
      AND gst_rate IS NULL)
  );

COMMENT ON CONSTRAINT tax_invoices_line_shape_header_shape ON tax_invoices IS
  'The cumulative header line exists exactly when the invoice is cumulative. An itemised invoice carries no header SAC, description or GST rate — the lines carry theirs.';

-- ---------------------------------------------------------------------
-- 3. The lines.
--
-- Money posture is 0035's draft shape, one level down: the four money
-- columns are NULL while the parent invoice is a draft and are written
-- once, in the submit transaction, from quantity x rate at the line's own
-- GST rate. Both the per-line taxable value and the per-line tax heads are
-- CHECK-exact rather than tolerance-bounded — unlike the 0052 header
-- guard, these rows have NO imported history to absorb, so nothing here
-- needs a rupee of slack.

CREATE TABLE tax_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  tax_invoice_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  -- The goods/services distinction, stated rather than inferred from the
  -- code's length: it decides IsServc on the IRP wire and, in stage 2,
  -- whether the document moves goods at all.
  is_service boolean NOT NULL,
  -- Six digits for a SAC (services take no deepening), six to eight for a
  -- goods HSN. The pairing is enforced below, not by the reader.
  hsn_sac_code text NOT NULL CHECK (hsn_sac_code ~ '^[0-9]{6,8}$'),
  description text NOT NULL
    CHECK (length(btrim(description)) BETWEEN 3 AND 1000),
  quantity numeric(18, 3) NOT NULL CHECK (quantity > 0),
  unit_label text
    CHECK (unit_label IS NULL OR length(btrim(unit_label)) BETWEEN 1 AND 20),
  unit_rate numeric(18, 2) NOT NULL CHECK (unit_rate >= 0),
  gst_rate numeric(5, 2) NOT NULL CHECK (gst_rate >= 0 AND gst_rate <= 100),
  -- Submit-frozen. NULL together while the parent invoice is a draft.
  taxable_value numeric(18, 2) CHECK (taxable_value IS NULL OR taxable_value >= 0),
  cgst_amount numeric(18, 2) CHECK (cgst_amount IS NULL OR cgst_amount >= 0),
  sgst_amount numeric(18, 2) CHECK (sgst_amount IS NULL OR sgst_amount >= 0),
  igst_amount numeric(18, 2) CHECK (igst_amount IS NULL OR igst_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, tax_invoice_id, position),
  FOREIGN KEY (organisation_id, tax_invoice_id)
    REFERENCES tax_invoices (organisation_id, id),
  -- A service line is a SAC and a SAC is six digits; a goods line is an
  -- HSN and may be deepened to eight.
  CONSTRAINT tax_invoice_lines_code_shape CHECK (
    (is_service AND hsn_sac_code ~ '^[0-9]{6}$')
    OR (NOT is_service AND hsn_sac_code ~ '^[0-9]{6,8}$')
  ),
  -- All four money columns arrive together at submit, or none has.
  CONSTRAINT tax_invoice_lines_money_shape CHECK (
    (taxable_value IS NULL AND cgst_amount IS NULL
      AND sgst_amount IS NULL AND igst_amount IS NULL)
    OR
    (taxable_value IS NOT NULL AND cgst_amount IS NOT NULL
      AND sgst_amount IS NOT NULL AND igst_amount IS NOT NULL)
  ),
  -- The line's taxable value IS quantity x rate, to the paisa.
  CONSTRAINT tax_invoice_lines_taxable_is_quantity_times_rate CHECK (
    taxable_value IS NULL
    OR taxable_value = round(quantity * unit_rate, 2)
  ),
  -- And its tax heads are exactly the submit arithmetic at its own rate:
  -- intra-state two equal halves of round(taxable * rate / 200, 2), or
  -- inter-state round(taxable * rate / 100, 2) as IGST. A zero rate
  -- satisfies both branches with zeroes, as it should.
  CONSTRAINT tax_invoice_lines_tax_heads CHECK (
    taxable_value IS NULL
    OR (cgst_amount = round(taxable_value * gst_rate / 200, 2)
        AND sgst_amount = cgst_amount
        AND igst_amount = 0)
    OR (igst_amount = round(taxable_value * gst_rate / 100, 2)
        AND cgst_amount = 0 AND sgst_amount = 0)
  )
);

COMMENT ON TABLE tax_invoice_lines IS
  'The lines of an ITEMISED tax invoice: per-line HSN (goods) or SAC '
  '(services), quantity, unit rate and GST rate. A cumulative invoice has '
  'none of these rows; an itemised one has at least one. Money is frozen '
  'at submit from quantity x rate, and the header totals are their sum.';
COMMENT ON COLUMN tax_invoice_lines.is_service IS
  'Whether this line supplies a SERVICE (SAC, six digits) or GOODS (HSN, six to eight). Stated, not inferred; it becomes IsServc on the IRP wire.';

CREATE INDEX tax_invoice_lines_invoice_idx
  ON tax_invoice_lines (organisation_id, tax_invoice_id, position);

CREATE TRIGGER tax_invoice_lines_touch_updated_at
BEFORE UPDATE ON tax_invoice_lines
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. Lines are mutable only while the parent invoice is a draft.
--
-- Exactly the delivery_challan_items posture (0001): the parent's freeze
-- is not worth much if its children can be rewritten underneath it, and
-- the route is not the only writer the future holds. SECURITY DEFINER with
-- an explicit tenancy pin, like the 0051 cross-record guards — a direct
-- writer may run as administrator outside a bound tenant transaction, and
-- an unbound read must not silently find nothing and permit the write.

CREATE FUNCTION app_private.guard_tax_invoice_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_organisation uuid;
  v_invoice uuid;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_organisation := OLD.organisation_id;
    v_invoice := OLD.tax_invoice_id;
  ELSE
    v_organisation := NEW.organisation_id;
    v_invoice := NEW.tax_invoice_id;
  END IF;

  SELECT status INTO v_status
    FROM tax_invoices
   WHERE id = v_invoice AND organisation_id = v_organisation;

  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'tax invoice lines are mutable only while the invoice is draft (invoice % is %)',
      v_invoice, COALESCE(v_status, 'missing')
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tax_invoice_lines_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON tax_invoice_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_line_mutation();

-- ---------------------------------------------------------------------
-- 5. The shape constraint that spans the two tables.
--
-- A cumulative invoice must carry NO line rows and an itemised one at
-- least one; and the lines' money must be frozen exactly when the parent's
-- is. Neither statement fits in a CHECK — both span rows — and neither can
-- be an immediate row trigger either, because the submit transaction
-- legitimately passes through states where it is momentarily false (the
-- lines are written, then the header; the invoice is inserted, then its
-- first line). A DEFERRABLE INITIALLY DEFERRED constraint trigger judges
-- the transaction by its RESULT, which is the only honest moment to judge
-- it: at COMMIT the pair either says one coherent thing or the whole
-- transaction fails.
--
-- The judgement itself is a plain function called by two thin trigger
-- functions, one per table. Deliberately NOT one shared trigger function
-- branching on TG_TABLE_NAME: plpgsql resolves a record field when it plans
-- the statement that mentions it, so a single body naming both NEW.id and
-- NEW.tax_invoice_id fails on whichever table lacks the other column.
--
-- SECURITY DEFINER with an explicit tenancy pin, for the reason in §4.

CREATE FUNCTION app_private.assert_tax_invoice_line_shape(
  p_organisation uuid,
  p_invoice uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invoice uuid := p_invoice;
  v_shape text;
  v_status text;
  v_lines bigint;
  v_unpriced bigint;
  v_priced bigint;
BEGIN
  SELECT line_shape, status INTO v_shape, v_status
    FROM tax_invoices
   WHERE id = v_invoice AND organisation_id = p_organisation;
  -- The invoice was deleted later in the same transaction (a discarded
  -- draft takes its lines with it): there is no document left to judge.
  IF v_shape IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE taxable_value IS NULL),
         count(*) FILTER (WHERE taxable_value IS NOT NULL)
    INTO v_lines, v_unpriced, v_priced
    FROM tax_invoice_lines
   WHERE tax_invoice_id = v_invoice AND organisation_id = p_organisation;

  IF v_shape = 'service_cumulative' AND v_lines > 0 THEN
    RAISE EXCEPTION
      'tax invoice % is service_cumulative and carries its line in its header columns, so it must have no tax_invoice_lines rows (found %)',
      v_invoice, v_lines
      USING ERRCODE = '23514';
  END IF;

  IF v_shape = 'itemised' AND v_lines = 0 THEN
    RAISE EXCEPTION
      'tax invoice % is itemised, so it must have at least one tax_invoice_lines row',
      v_invoice
      USING ERRCODE = '23514';
  END IF;

  IF v_status = 'draft' AND v_priced > 0 THEN
    RAISE EXCEPTION
      'tax invoice % is a draft, so its lines carry no frozen money yet (% priced line(s))',
      v_invoice, v_priced
      USING ERRCODE = '23514';
  END IF;

  IF v_status <> 'draft' AND v_unpriced > 0 THEN
    RAISE EXCEPTION
      'tax invoice % is %, so every line must carry its frozen money (% line(s) without)',
      v_invoice, v_status, v_unpriced
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE FUNCTION app_private.check_tax_invoice_line_shape()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM app_private.assert_tax_invoice_line_shape(
    NEW.organisation_id, NEW.id
  );
  RETURN NULL;
END
$$;

CREATE FUNCTION app_private.check_tax_invoice_lines_shape()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app_private.assert_tax_invoice_line_shape(
      OLD.organisation_id, OLD.tax_invoice_id
    );
    RETURN NULL;
  END IF;
  PERFORM app_private.assert_tax_invoice_line_shape(
    NEW.organisation_id, NEW.tax_invoice_id
  );
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER tax_invoices_line_shape_coherence_check
AFTER INSERT OR UPDATE OF line_shape, status ON tax_invoices
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.check_tax_invoice_line_shape();

CREATE CONSTRAINT TRIGGER tax_invoice_lines_shape_coherence_check
AFTER INSERT OR UPDATE OR DELETE ON tax_invoice_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.check_tax_invoice_lines_shape();

-- ---------------------------------------------------------------------
-- 6. The GST rate master (0048) now covers per-line rates too.
--
-- 0048's trigger judged the HEADER rate against the organisation's own
-- notified rates for the invoice date. An itemised invoice has no header
-- rate, so that guard must step aside for a NULL — and the rule it
-- enforces must reappear one level down, per line, against the parent
-- invoice's date. Recreated verbatim from 0048 with exactly one added
-- clause; the message and the tenancy pin are unchanged.

CREATE OR REPLACE FUNCTION app_private.guard_gst_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- An ITEMISED invoice carries no header rate (0057); its lines are
  -- judged by guard_tax_invoice_line_gst_rate() below. The shape CHECK
  -- guarantees a NULL here means exactly that.
  IF NEW.gst_rate IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM gst_rates g
     WHERE g.organisation_id = NEW.organisation_id
       AND g.rate = NEW.gst_rate
       AND g.effective_from <= NEW.invoice_date
       AND (g.effective_to IS NULL OR g.effective_to >= NEW.invoice_date)
  ) THEN
    RAISE EXCEPTION
      'GST rate % is not notified on % — no gst_rates row of this organisation covers the pair. Pick a rate the master lists for that date, or add the notification to the master first.',
      NEW.gst_rate, NEW.invoice_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app_private.guard_tax_invoice_line_gst_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_date date;
BEGIN
  SELECT invoice_date INTO v_date
    FROM tax_invoices
   WHERE id = NEW.tax_invoice_id AND organisation_id = NEW.organisation_id;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'tax invoice % is missing', NEW.tax_invoice_id
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM gst_rates g
     WHERE g.organisation_id = NEW.organisation_id
       AND g.rate = NEW.gst_rate
       AND g.effective_from <= v_date
       AND (g.effective_to IS NULL OR g.effective_to >= v_date)
  ) THEN
    RAISE EXCEPTION
      'GST rate % is not notified on % — no gst_rates row of this organisation covers the pair. Pick a rate the master lists for that date, or add the notification to the master first.',
      NEW.gst_rate, v_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_invoice_lines_gst_rate_guard
BEFORE INSERT OR UPDATE OF gst_rate ON tax_invoice_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_line_gst_rate();

-- A date edit on an itemised DRAFT can carry a line rate out of its
-- window exactly as it can a header rate, and 0048's trigger only ever
-- watched the header. This one re-judges every line of the invoice when
-- its date moves.
CREATE FUNCTION app_private.guard_tax_invoice_date_line_gst_rates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_offending numeric(5, 2);
BEGIN
  IF NEW.line_shape <> 'itemised' THEN
    RETURN NEW;
  END IF;
  SELECT l.gst_rate INTO v_offending
    FROM tax_invoice_lines l
   WHERE l.tax_invoice_id = NEW.id
     AND l.organisation_id = NEW.organisation_id
     AND NOT EXISTS (
       SELECT 1 FROM gst_rates g
        WHERE g.organisation_id = NEW.organisation_id
          AND g.rate = l.gst_rate
          AND g.effective_from <= NEW.invoice_date
          AND (g.effective_to IS NULL OR g.effective_to >= NEW.invoice_date)
     )
   ORDER BY l.position
   LIMIT 1;
  IF v_offending IS NOT NULL THEN
    RAISE EXCEPTION
      'GST rate % is not notified on % — no gst_rates row of this organisation covers the pair. Pick a rate the master lists for that date, or add the notification to the master first.',
      v_offending, NEW.invoice_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_invoices_line_gst_rate_date_guard
BEFORE UPDATE OF invoice_date ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_date_line_gst_rates();

-- ---------------------------------------------------------------------
-- 7. THE COLLISION-PRONE CORE: 0052's tax-heads guard learns the itemised
-- shape without losing a paisa of the cumulative one.
--
-- 0052 reconciles cgst + sgst + igst against taxable_value * gst_rate/100
-- using the HEADER rate. An itemised invoice has a NULL header rate and
-- per-line rates, so that arithmetic would divide by nothing and the guard
-- would either crash or — worse — pass everything. Recreated on top of
-- what main holds NOW, with the cumulative branch VERBATIM (same two
-- expectations, same one-rupee tolerance, same frozen-row skip, same
-- message) and an itemised branch that expects the SUM of the per-line
-- figures instead. Neither branch is weakened:
--
--   * cumulative: unchanged, to the character;
--   * itemised: the header taxable value must equal the sum of the lines'
--     EXACTLY (no tolerance — these rows are new and were computed by the
--     same SQL), and the heads must reconcile with the sum of the per-line
--     intra or inter expectations within the same one rupee 0052 allows.
--
-- The frozen-row skip now also passes when the header rate is NULL on both
-- sides, which is every itemised transition of an already-issued row.
--
-- SECURITY DEFINER, unlike 0052's SECURITY INVOKER original, because the
-- itemised branch reads tax_invoice_lines: the read therefore carries its
-- own tenancy pin (organisation_id = NEW.organisation_id), deliberately
-- NOT current_organisation_id(), for the reason 0052 §4 records — a direct
-- writer may run as administrator outside a bound tenant transaction and
-- the guard must still bind there.

CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_tax_heads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_heads numeric(18, 2);
  v_intra numeric(18, 2);
  v_inter numeric(18, 2);
  v_lines_taxable numeric(18, 2);
  v_line_count bigint;
BEGIN
  IF NEW.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Transitions of an already-issued row (cancel, IRP evidence arrival)
  -- leave the money columns untouched — the 0041/0049/0051/0053
  -- issued-update guard freezes them — so a figure this guard already
  -- accepted is not re-judged. OLD is read only under an explicit TG_OP
  -- test: plpgsql leaves it unassigned on INSERT and SQL boolean
  -- operators do not promise short-circuit evaluation.
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

  IF NEW.line_shape = 'itemised' THEN
    SELECT count(*),
           sum(l.taxable_value)::numeric(18, 2),
           sum(2 * round(l.taxable_value * l.gst_rate / 200, 2))::numeric(18, 2),
           sum(round(l.taxable_value * l.gst_rate / 100, 2))::numeric(18, 2)
      INTO v_line_count, v_lines_taxable, v_intra, v_inter
      FROM tax_invoice_lines l
     WHERE l.tax_invoice_id = NEW.id
       AND l.organisation_id = NEW.organisation_id
       AND l.taxable_value IS NOT NULL;

    IF v_line_count = 0 THEN
      RAISE EXCEPTION
        'an itemised tax invoice carrying money must have at least one priced line to reconcile its tax heads against'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.taxable_value <> v_lines_taxable THEN
      RAISE EXCEPTION
        'the itemised invoice taxable value % is not the sum of its % line(s), which is %',
        NEW.taxable_value, v_line_count, v_lines_taxable
        USING ERRCODE = '23514';
    END IF;

    IF abs(v_heads - v_intra) > 1.00 AND abs(v_heads - v_inter) > 1.00 THEN
      RAISE EXCEPTION
        'tax heads do not reconcile with the itemised lines: cgst % + sgst % + igst % = % against taxable % over % line(s), which the submit arithmetic puts at % (intra) or % (inter)',
        NEW.cgst_amount, NEW.sgst_amount, NEW.igst_amount, v_heads,
        NEW.taxable_value, v_line_count, v_intra, v_inter
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

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

-- The trigger's column list gains line_shape, so a direct writer cannot
-- flip an invoice's shape without the guard re-judging its money.
DROP TRIGGER tax_invoices_tax_heads_guard ON tax_invoices;
CREATE TRIGGER tax_invoices_tax_heads_guard
BEFORE INSERT OR UPDATE OF
  status, line_shape, gst_rate, taxable_value,
  cgst_amount, sgst_amount, igst_amount
ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tax_invoice_tax_heads();

-- tax_invoices_split_place_guard (0052) is untouched on purpose. It judges
-- a HEADER fact — place of supply against the organisation's own state —
-- and neither of its inputs moved, so it keeps working identically for
-- both shapes. Asserted by test rather than assumed.

-- ---------------------------------------------------------------------
-- 8. The issued-update freeze learns line_shape, and NOTHING else changes.
--
-- Recreated from 0053's text — itself 0051's text (supersession) over
-- 0049's (the frozen irp_reporting_deadline) over 0041's. Every arm main
-- holds today survives verbatim:
--
--   * draft -> superseded refused outright                        (0051)
--   * the frozen business-facts ROW, now with line_shape added
--     alongside irp_reporting_deadline                     (0041/0049/0051)
--   * cancelled is terminal, its evidence immutable               (0041)
--   * submitted -> superseded only under an issued credit note and no
--     in-flight provider operation                                (0051)
--   * superseded is terminal but for the guarded revert to submitted
--     while no issued credit note remains                         (0051)
--   * IRP registration evidence immutable once an IRN exists      (0041)
--   * provider identity immutable                                 (0041)
--   * IRP cancellation evidence immutable                         (0041)
--   * the provider-state transition matrix INCLUDING the two
--     registered_unverified arms                                  (0053)
--   * local cancel gated on a resolved provider state             (0041)
--
-- The ONLY change is line_shape joining the frozen ROW: an issued
-- invoice's shape is as much a business fact as its rate, and flipping it
-- afterwards would silently re-interpret which columns the document's line
-- lives in. SECURITY DEFINER is retained from 0051 for the credit_notes
-- reads.

CREATE OR REPLACE FUNCTION app_private.guard_tax_invoice_issued_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'superseded' THEN
    RAISE EXCEPTION 'only a submitted tax invoice can be superseded by a credit note'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status <> 'draft' THEN
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.measurement_book_id,
      NEW.invoice_number, NEW.sequence_number, NEW.fy_label,
      NEW.invoice_date, NEW.line_shape, NEW.sac_code, NEW.service_description,
      NEW.gst_rate, NEW.place_of_supply, NEW.buyer_contact_id,
      NEW.buyer_snapshot, NEW.taxable_value, NEW.cgst_amount,
      NEW.sgst_amount, NEW.igst_amount, NEW.total_amount, NEW.round_off,
      NEW.customer_po_reference, NEW.unit_label, NEW.notes,
      NEW.ship_to_contact_id, NEW.ship_to_snapshot, NEW.issued_snapshot,
      NEW.number_prefix, NEW.stated_taxable_value,
      NEW.irp_reporting_deadline,
      NEW.submitted_by_user_id, NEW.submitted_at,
      NEW.created_by_user_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.measurement_book_id,
      OLD.invoice_number, OLD.sequence_number, OLD.fy_label,
      OLD.invoice_date, OLD.line_shape, OLD.sac_code, OLD.service_description,
      OLD.gst_rate, OLD.place_of_supply, OLD.buyer_contact_id,
      OLD.buyer_snapshot, OLD.taxable_value, OLD.cgst_amount,
      OLD.sgst_amount, OLD.igst_amount, OLD.total_amount, OLD.round_off,
      OLD.customer_po_reference, OLD.unit_label, OLD.notes,
      OLD.ship_to_contact_id, OLD.ship_to_snapshot, OLD.issued_snapshot,
      OLD.number_prefix, OLD.stated_taxable_value,
      OLD.irp_reporting_deadline,
      OLD.submitted_by_user_id, OLD.submitted_at,
      OLD.created_by_user_id, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'submitted tax invoice business facts are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'cancelled tax invoices cannot be reopened'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'cancelled' AND ROW(
      NEW.cancelled_at, NEW.cancelled_by_user_id, NEW.cancellation_note
    ) IS DISTINCT FROM ROW(
      OLD.cancelled_at, OLD.cancelled_by_user_id, OLD.cancellation_note
    ) THEN
      RAISE EXCEPTION 'tax invoice cancellation evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'submitted' AND NEW.status = 'superseded' THEN
      IF OLD.irp_provider_state IN ('registering', 'cancelling') THEN
        RAISE EXCEPTION 'resolve the in-flight provider operation before superseding the invoice'
          USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM credit_notes
         WHERE tax_invoice_id = OLD.id
           AND organisation_id = OLD.organisation_id
           AND status = 'issued'
      ) THEN
        RAISE EXCEPTION 'a tax invoice is superseded only by an issued credit note'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
      IF NEW.status <> 'submitted' THEN
        RAISE EXCEPTION 'a superseded tax invoice is terminal (it may only revert to submitted when its credit note is cancelled)'
          USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1 FROM credit_notes
         WHERE tax_invoice_id = OLD.id
           AND organisation_id = OLD.organisation_id
           AND status = 'issued'
      ) THEN
        RAISE EXCEPTION 'the invoice stays superseded while an issued credit note exists for it'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF OLD.irn IS NOT NULL AND ROW(
      NEW.irn, NEW.ack_number, NEW.ack_date, NEW.ack_date_text,
      NEW.signed_qr, NEW.signed_invoice, NEW.irp_provider,
      NEW.irp_legacy_evidence_missing
    ) IS DISTINCT FROM ROW(
      OLD.irn, OLD.ack_number, OLD.ack_date, OLD.ack_date_text,
      OLD.signed_qr, OLD.signed_invoice, OLD.irp_provider,
      OLD.irp_legacy_evidence_missing
    ) THEN
      RAISE EXCEPTION 'IRP registration evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.irp_provider IS NOT NULL
       AND NEW.irp_provider IS DISTINCT FROM OLD.irp_provider THEN
      RAISE EXCEPTION 'IRP provider identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.irp_cancelled_at IS NOT NULL AND ROW(
      NEW.irp_cancelled_at, NEW.irp_cancelled_at_text,
      NEW.irp_cancel_reason_code, NEW.irp_cancel_remark
    ) IS DISTINCT FROM ROW(
      OLD.irp_cancelled_at, OLD.irp_cancelled_at_text,
      OLD.irp_cancel_reason_code, OLD.irp_cancel_remark
    ) THEN
      RAISE EXCEPTION 'IRP cancellation evidence is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.irp_provider_state IS DISTINCT FROM OLD.irp_provider_state
       AND NOT (
         (OLD.irp_provider_state = 'not_requested'
          AND NEW.irp_provider_state IN (
            'registering', 'registered', 'registered_unverified'
          ))
         OR (OLD.irp_provider_state = 'registering'
          AND NEW.irp_provider_state IN (
            'registered', 'registration_failed', 'registration_unknown'
          ))
         OR (OLD.irp_provider_state IN (
               'registration_failed', 'registration_unknown'
             ) AND NEW.irp_provider_state = 'registering')
         OR (OLD.irp_provider_state = 'registered'
          AND NEW.irp_provider_state IN ('cancelling', 'cancelled'))
         OR (OLD.irp_provider_state = 'registered_unverified'
          AND NEW.irp_provider_state = 'cancelled')
         OR (OLD.irp_provider_state = 'cancelling'
          AND NEW.irp_provider_state IN (
            'registered', 'cancelled', 'cancellation_unknown'
          ))
         OR (OLD.irp_provider_state = 'cancellation_unknown'
          AND NEW.irp_provider_state = 'cancelled')
       ) THEN
      RAISE EXCEPTION 'invalid IRP provider-state transition'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'submitted' AND NEW.status = 'cancelled'
       AND OLD.irp_provider_state NOT IN ('not_requested', 'cancelled') THEN
      RAISE EXCEPTION 'resolve provider registration/cancellation before cancelling the local invoice'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- 9. RLS: forced, tenant-scoped, exactly as every tenant table (0035).

ALTER TABLE tax_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tax_invoice_lines_tenant_policy ON tax_invoice_lines
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- ---------------------------------------------------------------------
-- 10. Grants. A draft invoice's lines are edited and discarded freely;
-- once the invoice leaves draft the §4 mutation guard refuses every write,
-- so DELETE here is a draft-editing privilege, not a history-erasing one
-- (the delivery_challan_items posture, 0001). The bootstrap privilege
-- matrix (packages/db/src/bootstrap.ts) declares the same final state.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tax_invoice_lines TO auto_mb_app;
  END IF;
END
$$;
