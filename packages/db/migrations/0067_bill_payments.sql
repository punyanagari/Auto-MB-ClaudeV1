SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0067: the money that actually arrived, and what the railway
-- kept out of it.
--
-- Until now `bills.status = 'paid'` was the whole of this product's
-- knowledge of payment: a word, with no amount, no date, no reference and
-- no breakup. Both reviews of 2026-08-13 said the same thing about it —
-- the spreadsheet an operator still keeps beside this product is the
-- payment register, because a railway payment is never the bill amount.
-- It arrives net of statutory deductions, and the deductions are the part
-- an agency has to be able to name years later:
--
--   * GST TDS under section 51 of the CGST Act — 2% of the taxable value,
--     which the railway deposits and the agency reclaims in GSTR-7A;
--   * income-tax TDS under section 194C, which lands on Form 26AS;
--   * security deposit / retention, held against the contract and
--     released at PAC or at the end of the maintenance period;
--   * penalties and recoveries, which are neither of the above and are
--     argued about individually.
--
-- Those four are not free text. Each one is a different conversation with
-- a different authority on a different form, so each is a typed row, and
-- everything genuinely outside them is `OTHER` with a written
-- description — a category that cannot be reached without saying what it
-- is.
--
-- THE ARITHMETIC, AND WHY IT IS THE POINT.
--
--   received  +  deductions  =  what the railway settled
--
-- Deductions are money the railway KEPT, not money still owed. The
-- distinction is the whole reason a status could never carry this: a bill
-- of ₹10,00,000 credited as ₹9,52,000 is fully settled if ₹48,000 was
-- deducted, and 4.8% outstanding if it was not. One of those is a closed
-- matter and the other is a phone call. So the outstanding position
-- reports three figures and never one — received, deducted, outstanding —
-- and `bill_settlement_positions` at the end of this migration is that
-- statement.
--
-- WHAT "WHAT THE RAILWAY SETTLED" MEANS. It is the amount on the
-- railway's own On-Account Bill (`received_railway_bills.bill_amount`,
-- migration 0066), reached through the Measurement Book that bill closed
-- — never `bills.total_amount`, which is what the agency PREPARED. Two
-- reasons, and the second is the load-bearing one:
--
--   1. The railway pays its own bill. Where its certified figure differs
--      from the prepared one, the difference is a conversation about the
--      measurement, not an unpaid balance, and reporting it as an unpaid
--      balance would put a permanent phantom in the register.
--   2. `docs/PRODUCT.md` §5.2's rule is "compare like with like". A bank
--      credit is GST-INCLUSIVE, always. `received_railway_bills.bill_amount`
--      is GST-inclusive, always, and says so in 0066's own comment.
--      `bills.total_amount` is the measured total on the WORK'S recorded
--      basis, which is GST-exclusive on a GST-exclusive Work. Subtracting
--      an inclusive figure from an exclusive one is exactly the mixing
--      §5.2 names as the natural mistake, and it moves the answer by the
--      whole GST wedge. Taking the railway's figure as the reference makes
--      the comparison basis-free rather than basis-correct, which is
--      stronger.
--
-- It follows that a payment cannot be recorded before the Measurement
-- Book is closed, because until then there is no railway figure to
-- measure against. That is the same precondition 0066 already put on
-- `bills.status = 'paid'`, reached from the same direction, and it is
-- deliberately CLOSED for a bill with no Measurement Book for the reason
-- 0066 gives: since ADR-0006 exactly one statement inserts a bill and it
-- always sets `mb_id`, so such a row could only predate 0024 and is better
-- served by an explicit migration than by a hole nobody watches.
--
-- ENFORCED TWICE, AS MONEY MUST BE. Recurring finding 2 of the improvement
-- programme is that this repository enforces security twice and money
-- once. Every rule below is in `apps/server/src/routes/bill-payments.ts`
-- as well, and — following 0066's cautionary example, where a bill could
-- be BORN paid because the guard watched only UPDATE — every trigger here
-- is BEFORE INSERT OR UPDATE.
--
-- The split between the layers is the same one §5.5 states for the
-- railway bill, and is worth being exact about rather than saying "twice".
-- The database enforces the ARITHMETIC and the STRUCTURE: that a
-- reference figure exists, that the running total never passes it, that a
-- recorded fact never changes, and that `paid` is unreachable while
-- anything is outstanding. The route enforces the same rules first, so an
-- operator gets a sentence rather than a SQLSTATE, and adds what is not
-- structural: authority, work scope, and the audit entry.

-- ---------------------------------------------------------------------
-- 1. The payment.
--
-- One row per credit the railway made — a payment advice, an NEFT, a
-- cheque. Partial payment is ordinary: the railway pays an On-Account
-- Bill in instalments and each instalment carries its own deductions, so
-- the register is a list and the position is a sum over it.
--
-- `received_amount` is what reached the bank. It may be zero, and zero is
-- not a degenerate case: a bill entirely consumed by a recovery is a real
-- event that the register has to be able to state, and refusing it would
-- push the operator back to the spreadsheet for the one case that most
-- needs recording.
-- ---------------------------------------------------------------------
CREATE TABLE bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- The prepared bill this money settles. Work is reached through it
  -- rather than stored again: `bills` already carries `work_id` under a
  -- unique key, and a second copy is a second thing that can be wrong.
  bill_id uuid NOT NULL,

  -- A legal date, date-only, per engineering rule 6.
  received_on date NOT NULL,

  received_amount money_amount NOT NULL CHECK (received_amount >= 0),

  -- The UTR, advice number or cheque number the railway quoted. Optional
  -- because a bank statement line sometimes carries no usable reference,
  -- and a required field with nothing to put in it becomes a field full
  -- of dashes.
  reference text CHECK (
    reference IS NULL
    OR (btrim(reference) = reference AND length(reference) BETWEEN 1 AND 100)
  ),
  remarks text CHECK (
    remarks IS NULL OR length(btrim(remarks)) BETWEEN 1 AND 500
  ),

  recorded_by_user_id text NOT NULL,

  -- There is no DELETE grant on this table and no edit path: a recorded
  -- receipt is a financial fact. A mis-keyed one is VOIDED, which leaves
  -- the row and its reason in place and takes it out of every sum, on the
  -- same terms as a discarded railway bill (0066) and a cancelled
  -- challan.
  voided_at timestamptz,
  voided_by_user_id text,
  void_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, bill_id) REFERENCES bills(organisation_id, id),

  -- Void travels as one fact — who, when and why — and unlike a discarded
  -- railway bill the reason is REQUIRED. Discarding an uploaded document
  -- can be self-evident from the document; retracting a recorded receipt
  -- of money never is.
  CONSTRAINT bill_payments_void_shape_check CHECK (
    (voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
    OR (
      voided_at IS NOT NULL
      AND voided_by_user_id IS NOT NULL
      AND length(btrim(void_reason)) BETWEEN 3 AND 500
    )
  )
);

COMMENT ON TABLE bill_payments IS
  'A credit received from the railway against a prepared bill. Partial payment is ordinary; the position is the sum over the live rows of this table and their deductions.';
COMMENT ON COLUMN bill_payments.received_amount IS
  'What reached the bank, GST-inclusive as every bank credit is. The bill amount less this is NOT the outstanding balance — see bill_payment_deductions.';
COMMENT ON COLUMN bill_payments.voided_at IS
  'A retracted receipt. The row and its reason stay; every settlement sum ignores it. Voiding is refused once the bill is paid, because the arithmetic that made it paid would stop holding.';

-- ---------------------------------------------------------------------
-- 2. The deductions.
--
-- Typed rows, not free text and not four nullable columns on the payment.
-- Four columns would make "no penalty" and "a penalty of zero" the same
-- statement and would need a fifth column added by migration the first
-- time a railway invents a recovery head; rows carry their own evidence
-- and their own count.
--
-- The four named categories are the ones with a statutory or contractual
-- identity. `OTHER` exists because the fifth head always turns up, and it
-- is the one category that cannot be written without saying what it is.
-- ---------------------------------------------------------------------
CREATE TABLE bill_payment_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  bill_payment_id uuid NOT NULL,

  category text NOT NULL CHECK (category IN (
    -- Section 51 of the CGST Act: the deductor's 2%, reclaimed in GSTR-7A.
    'GST_TDS',
    -- Section 194C: works-contract TDS, visible on Form 26AS.
    'INCOME_TAX_TDS',
    -- Retention / security deposit, released at PAC or maintenance end.
    'SECURITY_DEPOSIT',
    -- Liquidated damages, price reductions, recoveries of earlier excess.
    'PENALTY',
    -- Anything else, which must say what it is.
    'OTHER'
  )),

  amount money_amount NOT NULL CHECK (amount > 0),

  description text CHECK (
    description IS NULL OR length(btrim(description)) BETWEEN 3 AND 200
  ),

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, bill_payment_id)
    REFERENCES bill_payments(organisation_id, id),

  CONSTRAINT bill_payment_deductions_other_needs_description_check CHECK (
    category <> 'OTHER' OR description IS NOT NULL
  )
);

COMMENT ON TABLE bill_payment_deductions IS
  'What the railway kept out of a payment, one typed row per head. Money deducted is settled money, not outstanding money; only the outstanding column measures what is still owed.';
COMMENT ON COLUMN bill_payment_deductions.category IS
  'GST_TDS (CGST s.51), INCOME_TAX_TDS (s.194C), SECURITY_DEPOSIT (retention), PENALTY, or OTHER — which requires a description.';

-- One row per named head per payment. A payment advice states each
-- statutory deduction once; two GST TDS rows on one advice are a
-- double-entry, and catching it here is cheaper than reconciling it
-- against GSTR-7A next quarter. `OTHER` is deliberately outside the rule:
-- two unrelated recoveries on one advice are two different facts and both
-- have to be nameable.
CREATE UNIQUE INDEX bill_payment_deductions_one_per_named_category
  ON bill_payment_deductions (organisation_id, bill_payment_id, category)
  WHERE category <> 'OTHER';

-- ---------------------------------------------------------------------
-- 3. Indexes.
--
-- Both foreign keys get a non-partial index LEADING with the referencing
-- columns, which is the rule `packages/db/test/fk-index-coverage` states
-- and enforces: a partial index cannot serve a referential check, because
-- a parent delete does not know about the predicate.
-- ---------------------------------------------------------------------
CREATE INDEX bill_payments_bill_idx
  ON bill_payments (organisation_id, bill_id, received_on DESC, id);

CREATE INDEX bill_payment_deductions_payment_idx
  ON bill_payment_deductions (organisation_id, bill_payment_id);

ALTER TABLE bill_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE bill_payment_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_payment_deductions FORCE ROW LEVEL SECURITY;

-- ADR-0010 (accepted 2026-08-13), applied by migration 0069: the helper
-- call is wrapped in a scalar subquery so the planner treats it as an
-- InitPlan and evaluates it once per statement rather than once per row.
-- New policies are authored this way from the start, and
-- `packages/db/test/rls-initplan.integration.test.ts` names the packs
-- whose policies arrive already wrapped — this pack is named there.
CREATE POLICY bill_payments_tenant_policy ON bill_payments
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

CREATE POLICY bill_payment_deductions_tenant_policy ON bill_payment_deductions
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- A financial record does not leave. UPDATE exists on the payment only so
-- it can be voided, and the guard below allows nothing else through it;
-- a deduction has no UPDATE at all, because a wrong breakup is corrected
-- by voiding the whole advice and recording it again.
GRANT SELECT, INSERT, UPDATE ON bill_payments TO auto_mb_app;
GRANT SELECT, INSERT ON bill_payment_deductions TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 4. The two readings every rule below is written against.
--
-- Both are plain SECURITY INVOKER functions, so row-level security
-- applies to their reads exactly as it applies to the trigger that calls
-- them: a guard that could see another tenant's bill would be a hole in
-- the floor rather than a backstop for it.
-- ---------------------------------------------------------------------

-- What the railway agreed to pay for this bill, or NULL when it has not
-- agreed yet. NULL is the gate: no railway figure, no payment record.
CREATE FUNCTION app_private.bill_settlement_reference(p_bill_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT rb.bill_amount::numeric
  FROM bills b
  JOIN measurement_books mb
    ON mb.organisation_id = b.organisation_id AND mb.id = b.mb_id
  JOIN received_railway_bills rb
    ON rb.organisation_id = mb.organisation_id
   AND rb.id = mb.closed_by_received_bill_id
  WHERE b.id = p_bill_id
$$;

COMMENT ON FUNCTION app_private.bill_settlement_reference(uuid) IS
  'The railway''s own On-Account Bill amount for a prepared bill, reached through the Measurement Book that bill closed. NULL until the measurement is closed, which is what makes closure a precondition of recording payment.';

-- What has already been settled against this bill: money received plus
-- money the railway kept, over the live payments only.
CREATE FUNCTION app_private.bill_settled_total(p_bill_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(sum(p.received_amount::numeric + coalesce(d.total, 0)), 0)
  FROM bill_payments p
  LEFT JOIN LATERAL (
    SELECT sum(x.amount::numeric) AS total
    FROM bill_payment_deductions x
    WHERE x.organisation_id = p.organisation_id AND x.bill_payment_id = p.id
  ) d ON true
  WHERE p.bill_id = p_bill_id AND p.voided_at IS NULL
$$;

COMMENT ON FUNCTION app_private.bill_settled_total(uuid) IS
  'Received plus deducted, over the live payments of one bill. Deductions count as settled because they are money the railway kept, not money it still owes.';

-- ---------------------------------------------------------------------
-- 5. Recording a payment.
--
-- Concurrency: two advices that each fit on their own can jointly pass
-- the bill amount, so the `bills` row is taken FOR UPDATE before the
-- running total is read — 0046's pattern for the quantity ceilings, for
-- the same reason. The route locks the same row first and in the same
-- order, so re-taking it there costs nothing and no lock order is
-- inverted.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_bill_payment_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_reference numeric;
  v_settled numeric;
BEGIN
  -- An existing row may only be voided. Nothing else about a recorded
  -- receipt is editable, and void is terminal: OLD is read only under an
  -- explicit TG_OP test, because plpgsql leaves it unassigned on INSERT.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a voided bill payment is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.bill_id, NEW.received_on, NEW.received_amount,
      NEW.reference, NEW.remarks, NEW.recorded_by_user_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.bill_id, OLD.received_on, OLD.received_amount,
      OLD.reference, OLD.remarks, OLD.recorded_by_user_id, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'a recorded bill payment is immutable; void it instead'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT b.status INTO v_status
  FROM bills b
  WHERE b.organisation_id = NEW.organisation_id AND b.id = NEW.bill_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'bill payment names bill %, which this transaction cannot read',
      NEW.bill_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A paid bill's register is closed. Adding to it or retracting from it
  -- would leave `paid` resting on arithmetic that no longer reaches the
  -- bill amount, and `bills` moves forward only, so there is no honest
  -- way back. The correction is a compensating record on a later bill,
  -- exactly as ADR-0006 already requires of a billed Measurement Book.
  IF v_status = 'paid' THEN
    RAISE EXCEPTION
      'bill % is paid; its payment register is closed', NEW.bill_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Voiding only ever reduces the settled total, so it needs no ceiling
  -- check. Everything below is about the money going IN.
  IF TG_OP = 'UPDATE' AND NEW.voided_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_reference := app_private.bill_settlement_reference(NEW.bill_id);
  IF v_reference IS NULL THEN
    RAISE EXCEPTION
      'bill % cannot take a payment: its Measurement Book is not closed by a verified railway bill, so there is no settled amount to measure against',
      NEW.bill_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_settled := app_private.bill_settled_total(NEW.bill_id);
  IF v_settled + NEW.received_amount::numeric > v_reference THEN
    RAISE EXCEPTION
      'bill % would be settled to % against a railway bill of %',
      NEW.bill_id, v_settled + NEW.received_amount::numeric, v_reference
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER bill_payments_write_guard
BEFORE INSERT OR UPDATE ON bill_payments
FOR EACH ROW EXECUTE FUNCTION app_private.guard_bill_payment_write();

CREATE TRIGGER bill_payments_touch_updated_at
BEFORE UPDATE ON bill_payments
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 6. Recording a deduction.
--
-- A deduction arrives with its payment, in the same transaction, so this
-- guard runs while the parent row is already visible and the running
-- total already includes it. There is no UPDATE privilege on this table;
-- the UPDATE arm exists so that a future grant cannot open an unguarded
-- path, which is the shape 0066's own INSERT hole taught.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_bill_payment_deduction_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_bill_id uuid;
  v_voided_at timestamptz;
  v_status text;
  v_reference numeric;
  v_settled numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a recorded deduction is immutable; void its payment instead'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.bill_id, p.voided_at INTO v_bill_id, v_voided_at
  FROM bill_payments p
  WHERE p.organisation_id = NEW.organisation_id AND p.id = NEW.bill_payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'deduction names bill payment %, which this transaction cannot read',
      NEW.bill_payment_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_voided_at IS NOT NULL THEN
    RAISE EXCEPTION
      'bill payment % is voided and takes no further deductions',
      NEW.bill_payment_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT b.status INTO v_status
  FROM bills b
  WHERE b.organisation_id = NEW.organisation_id AND b.id = v_bill_id
  FOR UPDATE;

  IF v_status = 'paid' THEN
    RAISE EXCEPTION
      'bill % is paid; its payment register is closed', v_bill_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_reference := app_private.bill_settlement_reference(v_bill_id);
  IF v_reference IS NULL THEN
    RAISE EXCEPTION
      'bill % cannot take a deduction: its Measurement Book is not closed by a verified railway bill',
      v_bill_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_settled := app_private.bill_settled_total(v_bill_id);
  IF v_settled + NEW.amount::numeric > v_reference THEN
    RAISE EXCEPTION
      'bill % would be settled to % against a railway bill of %',
      v_bill_id, v_settled + NEW.amount::numeric, v_reference
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER bill_payment_deductions_write_guard
BEFORE INSERT OR UPDATE ON bill_payment_deductions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_bill_payment_deduction_write();

-- ---------------------------------------------------------------------
-- 7. `paid` stops being a word.
--
-- Migration 0066 made `paid` mean "the railway settled the measurement".
-- This makes it mean "and the money is all accounted for". Both gates sit
-- on the same table and fire in name order, so
-- `bills_paid_needs_closed_book_guard` refuses first and an operator who
-- has not filed the railway bill hears about that rather than about an
-- arithmetic they cannot yet do.
--
-- The status stays a MANUAL act, deliberately. Every state change in this
-- product is an explicit, audited transition — a Measurement Book is
-- finalized, a challan is issued, an invoice is submitted — and a status
-- that flipped itself the moment a sum reached a threshold would be the
-- only one that nobody performed and no audit row explains. What changes
-- here is not who performs the act but what the act is allowed to assert:
-- `paid` may now only be claimed where the register supports it, exactly
-- as an issued document may only be claimed where its evidence does.
--
-- Equality, not "at least". The register cannot exceed the railway bill —
-- section 5 refuses that — so the only way to be short of equality is to
-- be genuinely outstanding.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_bill_paid_needs_full_settlement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reference numeric;
  v_settled numeric;
BEGIN
  IF NEW.status <> 'paid' THEN
    RETURN NEW;
  END IF;
  -- An already-paid row updated for some other reason is not the
  -- transition this guards; only the move INTO paid is. Same shape, and
  -- the same TG_OP care, as 0066's closed-book guard beside it.
  IF TG_OP = 'UPDATE' AND OLD.status = 'paid' THEN
    RETURN NEW;
  END IF;

  v_reference := app_private.bill_settlement_reference(NEW.id);
  IF v_reference IS NULL THEN
    -- Unreachable through the closed-book guard, which refuses this same
    -- row first. Stated anyway: a guard that assumes another guard ran is
    -- a guard that stops working when trigger names change.
    RAISE EXCEPTION
      'bill % cannot be marked paid: no railway bill has settled its measurement',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  v_settled := app_private.bill_settled_total(NEW.id);
  IF v_settled <> v_reference THEN
    RAISE EXCEPTION
      'bill % cannot be marked paid: % of % is accounted for, leaving % outstanding',
      NEW.id, v_settled, v_reference, v_reference - v_settled
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER bills_paid_needs_full_settlement_guard
BEFORE INSERT OR UPDATE ON bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_bill_paid_needs_full_settlement();

-- ---------------------------------------------------------------------
-- 8. Outstanding with the railway.
--
-- One row per prepared bill, stating the position in the three figures it
-- takes to state it honestly. `security_invoker`, like the 0028 and 0065
-- views: row-level security is re-checked against the caller through the
-- base tables, so the view grants no visibility that `bills` would not.
--
-- Deliberately a view and not a column on `bills`: it is a derived
-- reading of four tables and would be stale the moment a deduction
-- landed. And deliberately its own statement rather than a join folded
-- into an existing loader — the Measurement Book loader's buffer ratchet
-- is the standing reason this repository does not put new reads on hot
-- paths.
-- ---------------------------------------------------------------------
CREATE VIEW bill_settlement_positions
WITH (security_invoker = true)
AS
  SELECT
    b.organisation_id,
    b.id                                        AS bill_id,
    b.work_id,
    b.bill_number,
    b.status,
    -- What the agency prepared, on the Work's recorded GST basis. Shown
    -- so a difference against the railway's figure is visible, never
    -- used as the settlement reference; see the header.
    b.total_amount                              AS prepared_amount,
    b.mb_id                                     AS measurement_book_id,
    mb.mb_number                                AS measurement_book_number,
    mb.closed_at                                AS measurement_closed_at,
    rb.id                                       AS received_railway_bill_id,
    rb.bill_number                              AS railway_bill_number,
    rb.bill_date                                AS railway_bill_date,
    -- The railway's own figure: GST-inclusive, extracted from its bill,
    -- never typed. NULL until the measurement is closed, and while it is
    -- NULL nothing can be recorded against this bill.
    rb.bill_amount                              AS railway_bill_amount,
    coalesce(s.received_total, 0)::money_amount  AS received_total,
    coalesce(s.deduction_total, 0)::money_amount AS deduction_total,
    CASE
      WHEN rb.bill_amount IS NULL THEN NULL
      ELSE (
        rb.bill_amount::numeric
        - coalesce(s.received_total, 0)
        - coalesce(s.deduction_total, 0)
      )::money_amount
    END                                         AS outstanding_amount,
    coalesce(s.payment_count, 0)                AS payment_count
  FROM bills b
  LEFT JOIN measurement_books mb
    ON mb.organisation_id = b.organisation_id AND mb.id = b.mb_id
  LEFT JOIN received_railway_bills rb
    ON rb.organisation_id = mb.organisation_id
   AND rb.id = mb.closed_by_received_bill_id
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int                         AS payment_count,
      sum(p.received_amount::numeric)       AS received_total,
      sum(coalesce(d.total, 0))             AS deduction_total
    FROM bill_payments p
    LEFT JOIN LATERAL (
      SELECT sum(x.amount::numeric) AS total
      FROM bill_payment_deductions x
      WHERE x.organisation_id = p.organisation_id
        AND x.bill_payment_id = p.id
    ) d ON true
    WHERE p.organisation_id = b.organisation_id
      AND p.bill_id = b.id
      AND p.voided_at IS NULL
  ) s ON true;

COMMENT ON VIEW bill_settlement_positions IS
  'Outstanding with the railway, per prepared bill. Not a tenant table: RLS lives on bills, measurement_books, received_railway_bills and bill_payments and applies through security_invoker. outstanding_amount is NULL while the measurement is unclosed, because there is no agreed figure to be outstanding against.';

-- The two readings are narrowed exactly as 0001 narrows the tenancy
-- helpers: nothing in `app_private` is reachable by default, and the
-- application role gets each one by name. The route reads them directly
-- to answer "what is outstanding", so the grant is real rather than a
-- formality — a trigger function's own body would not have needed it.
REVOKE ALL ON FUNCTION app_private.bill_settlement_reference(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.bill_settled_total(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT ON bill_settlement_positions TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.bill_settlement_reference(uuid)
      TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.bill_settled_total(uuid) TO auto_mb_app;
  END IF;
END
$$;
