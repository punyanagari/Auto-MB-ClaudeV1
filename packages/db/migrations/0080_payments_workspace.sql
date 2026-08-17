SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0080: the payments workspace — money going OUT.
--
-- Everything the product has modelled about money until now is money
-- coming IN: a prepared bill, the railway's On-Account Bill that settles
-- it, and the receipts and deductions of migration 0067. The other half
-- of a contractor's cash position has had no home at all — the advance a
-- site engineer draws before travelling, the reimbursement he claims
-- afterwards, and the vendor invoices that fall due on credit terms.
-- The mock has drawn that half since its payments workspace component,
-- and `docs/UX.md` § Bills is a Work section names the Payments module
-- as the place cross-Work money questions get answered.
--
-- THREE TABLES, AND WHY NOT FEWER.
--
--   * `payment_requests` is an employee advance or reimbursement moving
--     through an approval. Its subject is a PERSON and its lifecycle is
--     a decision.
--   * `vendor_invoices` is a liability: what a vendor billed, when it
--     falls due on its credit terms, and how much of it is still open.
--     Its subject is a DOCUMENT and it has no lifecycle of its own —
--     it is simply outstanding until payments consume it.
--   * `vendor_payments` is money actually leaving against one of those
--     invoices, carrying the TDS the agency deducted at source.
--
-- Collapsing the first two loses the approval; collapsing the last two
-- loses partial payment, which is the ordinary case on credit terms.
--
-- WHAT IS DELIBERATELY REUSED. The vendor and the employee are both
-- rows in `contacts`, the party master migration 0028 established and
-- `purchase_orders.vendor_contact_id` already references. A parallel
-- party table would have to be kept in step with that one forever, and
-- the only thing an employee needs that `contacts` lacks is a flag,
-- which this migration adds. Note the deliberate consequence: a paid
-- site worker does not need a login to be paid, because the beneficiary
-- is a contact and not an `organisation_memberships` row.
--
-- WHAT IS DELIBERATELY NOT REUSED. `approval_requests` (migration 0012)
-- is not generalised to carry payment approvals. It is amendment-shaped
-- in three ways that would each have to be weakened: `work_id` is NOT
-- NULL and an employee reimbursement need not belong to a Work; its
-- `proposed`/`diff` jsonb pair describes an EDIT to an existing row and
-- a payment request is a new record, not a diff; and its
-- one-pending-per-entity index assumes the entity exists independently
-- of the request. A payment request's approval state is therefore a
-- status column on the request itself. Bending someone else's machine
-- until it fits is how both callers end up wrong.
--
-- MONEY IS ENFORCED TWICE. Recurring finding 2 of the improvement
-- programme is that this repository enforces security twice and money
-- once. The route checks are not enough on their own, so the arithmetic
-- that matters here — that vendor payments never exceed the invoice
-- they settle, that an approved amount is never altered after approval,
-- and that a settled request is never re-settled — is enforced by
-- trigger below as well as in `apps/server/src/routes/payments.ts`.

-- ── The employee flag on the shared party master ─────────────────────

ALTER TABLE contacts
  ADD COLUMN is_employee boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN contacts.is_employee IS
  'A person this organisation pays an advance or reimbursement to. Joins is_consignee/is_vendor/is_client as a role flag rather than a separate table, so one party may be several things at once. Deliberately independent of organisation_memberships: being paid is not being granted access, and a site worker with no login is still paid.';

CREATE INDEX contacts_org_employee_idx
  ON contacts (organisation_id, lower(designation))
  WHERE active AND is_employee;

-- ── The payee's PAN, as a column rather than a derivation ────────────
--
-- Tax deducted at source needs the payee's PAN, because section 206AA
-- floors the rate at 20% when none has been furnished. The first cut of
-- this pack had no column and read characters 3-12 of the GSTIN, which
-- is where a registered party's PAN genuinely lives — and that is a real
-- over-deduction, not a cosmetic shortcut. An unregistered vendor has no
-- GSTIN and therefore no derivable PAN, so a small labour contractor who
-- HAS furnished a PAN on paper was deducted at 20% instead of the
-- ordinary 1-2% under 194C. Money withheld from the vendor who can least
-- afford it.
--
-- PAN presence is now one authoritative fact instead of a derivation.

ALTER TABLE contacts
  ADD COLUMN pan text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

COMMENT ON COLUMN contacts.pan IS
  'The party''s Permanent Account Number. Decides whether section 206AA''s 20% floor applies to a vendor payment. Backfilled from the GSTIN, whose characters 3-12 are the holder''s PAN, so no deduction made before this migration changes.';

-- The backfill states exactly what the route already derived, so every
-- deduction recorded before this migration would be recomputed
-- identically after it. The regex is checked BEFORE substring rather
-- than after: `contacts.gstin` accepts a 15-character deductor GSTIN
-- ending in 'D' as well as a standard one, and the middle ten of a
-- malformed or deductor GSTIN need not be a PAN. A row that would fail
-- the CHECK is left NULL instead of failing the migration.
UPDATE contacts
SET pan = substring(gstin from 3 for 10)
WHERE gstin IS NOT NULL
  AND substring(gstin from 3 for 10) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$';

-- ── The authority that gates the whole module ────────────────────────
--
-- Following 0061's precedent exactly: a new explicit per-member
-- authority rather than a role, defaulting to false and deliberately
-- NOT backfilled. Someone who may issue a challan has not thereby been
-- granted the authority to move the organisation's money out of its
-- bank, and an owner must say so per member.

ALTER TABLE organisation_memberships
  ADD COLUMN can_manage_payments boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organisation_memberships.can_manage_payments IS
  'Authority to approve employee payment requests, record vendor invoices, and pay them. Separate from can_issue_documents because issuing a document the agency is owed for is not the same act as sending the agency''s money out. Not backfilled: an owner grants it per member.';

-- ── Numbering ────────────────────────────────────────────────────────
--
-- A payment request carries a number operators speak aloud ("PR-2026-
-- 018" in the mock), so it needs one. It does NOT go through
-- `document_number_series`: that machinery configures the operator-
-- editable formats of ISSUED STATUTORY documents — challans, tax
-- invoices, quotations — and a payment request is an internal record
-- with no statutory format to configure. Extending that CHECK
-- constraint would put an internal counter inside the statutory
-- numbering surface, which is a high-risk surface for a reason.
-- `bill_counters` (migration 0006) is the right precedent: a plain
-- counter row, incremented under its own row lock.

CREATE TABLE payment_request_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, fy_label)
);

COMMENT ON TABLE payment_request_counters IS
  'Per organisation, per financial year, the next payment-request sequence. Incremented with UPDATE ... RETURNING so concurrent requests serialise on the counter row.';

-- Migration 0064's rule for every counter in this schema: a counter may
-- only ever go up. Rewinding one re-issues a number that has already
-- been given out, and the uniqueness constraint then refuses a write
-- that looks unrelated to whatever moved the counter.
CREATE TRIGGER payment_request_counters_guard_decrease
  BEFORE UPDATE ON payment_request_counters
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- ── Employee advances and reimbursements ─────────────────────────────

CREATE TABLE payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  request_number text NOT NULL
    CHECK (length(btrim(request_number)) BETWEEN 3 AND 40),

  kind text NOT NULL CHECK (kind IN ('advance', 'reimbursement')),

  -- Nullable because an office reimbursement need not belong to a Work.
  -- Where it IS set, the work-scope middleware applies to reads.
  work_id uuid,

  beneficiary_contact_id uuid NOT NULL,
  -- Snapshotted at submission, exactly as purchase_orders snapshots its
  -- vendor: a later correction to the contact master must not rewrite
  -- who an approved payment was approved for.
  beneficiary_snapshot jsonb,

  purpose text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 3 AND 500),
  category text NOT NULL CHECK (category IN (
    'travel', 'materials', 'labour', 'site_expenses', 'general'
  )),
  amount money_amount NOT NULL CHECK (amount > 0),

  -- The mock refuses to submit without proof, and so does this. Both
  -- columns move together or neither is set.
  proof_object_key text,
  proof_filename text,

  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'approved', 'rejected', 'paid', 'settled'
  )),

  -- The advance gate. An advance is not finished when it is paid, it is
  -- finished when the final bills for it are recorded; a reimbursement
  -- arrives WITH its bills and so is born compliant.
  bills_recorded_at timestamptz,

  requested_by_user_id text NOT NULL,
  decided_by_user_id text,
  decided_at timestamptz,
  decision_note text,

  paid_at timestamptz,
  paid_reference text CHECK (
    paid_reference IS NULL
    OR (btrim(paid_reference) = paid_reference
        AND length(paid_reference) BETWEEN 1 AND 100)
  ),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, fy_label, sequence_number),
  UNIQUE (organisation_id, request_number),
  FOREIGN KEY (organisation_id, beneficiary_contact_id)
    REFERENCES contacts(organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),

  CONSTRAINT payment_requests_proof_shape_check CHECK (
    (proof_object_key IS NULL AND proof_filename IS NULL)
    OR (proof_object_key IS NOT NULL AND proof_filename IS NOT NULL)
  ),
  -- Proof is required to leave draft, which is the mock's rule ("Every
  -- expense requires proof before it can be submitted").
  CONSTRAINT payment_requests_submitted_needs_proof_check CHECK (
    status = 'draft' OR proof_object_key IS NOT NULL
  ),
  CONSTRAINT payment_requests_decision_shape_check CHECK (
    (status IN ('draft', 'submitted')
      AND decided_by_user_id IS NULL AND decided_at IS NULL)
    OR (status NOT IN ('draft', 'submitted')
      AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  -- A refusal must say why. Approval need not: the amount and the proof
  -- already say what was agreed to.
  CONSTRAINT payment_requests_rejection_needs_note_check CHECK (
    status <> 'rejected'
    OR (decision_note IS NOT NULL AND length(btrim(decision_note)) >= 3)
  ),
  CONSTRAINT payment_requests_paid_shape_check CHECK (
    (status IN ('paid', 'settled')) = (paid_at IS NOT NULL)
  ),
  -- `settled` means the money moved AND the paperwork closed. For a
  -- reimbursement the bills arrived up front, so payment settles it
  -- immediately; for an advance the bills are recorded later.
  CONSTRAINT payment_requests_settled_needs_bills_check CHECK (
    status <> 'settled' OR bills_recorded_at IS NOT NULL
  )
);

COMMENT ON TABLE payment_requests IS
  'An employee advance or reimbursement, from draft through approval to payment and closure. The beneficiary is a contacts row, not a member: being paid is not being granted access.';
COMMENT ON COLUMN payment_requests.bills_recorded_at IS
  'When the final bills for a PAID ADVANCE were recorded. Null on an open advance, which blocks that beneficiary from drawing another one (app_private.assert_no_advance_bills_due).';
COMMENT ON COLUMN payment_requests.beneficiary_snapshot IS
  'Who the beneficiary was when the request was submitted. A later master-data correction never rewrites an approved payment, per AGENTS.md rule 7.';

CREATE INDEX payment_requests_queue_idx
  ON payment_requests (organisation_id, status, created_at DESC, id);
CREATE INDEX payment_requests_beneficiary_idx
  ON payment_requests (organisation_id, beneficiary_contact_id, created_at DESC, id);
-- Leads with the foreign key's own columns and carries no WHERE, so it
-- serves the FK as well as the register: a partial index does not, and
-- an unindexed FK turns every delete on the parent into a scan here.
CREATE INDEX payment_requests_work_idx
  ON payment_requests (organisation_id, work_id, created_at DESC, id);

-- The advance gate, as an index rather than as a query the route
-- remembers to run: at most one unsettled paid advance per beneficiary.
-- A partial unique index makes the second one impossible rather than
-- merely refused, which is what makes the rule survive a caller that
-- forgets to check.
CREATE UNIQUE INDEX payment_requests_one_open_advance_per_beneficiary
  ON payment_requests (organisation_id, beneficiary_contact_id)
  WHERE kind = 'advance' AND status = 'paid' AND bills_recorded_at IS NULL;

-- ── Vendor liabilities ───────────────────────────────────────────────

CREATE TABLE vendor_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  vendor_contact_id uuid NOT NULL,
  vendor_snapshot jsonb,

  invoice_number text NOT NULL
    CHECK (btrim(invoice_number) = invoice_number
           AND length(invoice_number) BETWEEN 1 AND 60),
  invoice_date date NOT NULL,
  -- Credit terms in days, from which the due date is derived rather
  -- than stored: storing both invites the two to disagree.
  credit_days integer NOT NULL DEFAULT 0
    CHECK (credit_days BETWEEN 0 AND 365),
  amount money_amount NOT NULL CHECK (amount > 0),

  -- Optional Work attribution. A vendor invoice for stores bought
  -- against no particular Work is ordinary.
  work_id uuid,

  -- Which TDS section this vendor's work falls under, decided when the
  -- liability is recorded rather than at payment time, because it is a
  -- property of what was bought and not of when it was paid.
  tds_section text CHECK (tds_section IS NULL OR tds_section IN ('194C', '194J')),
  tds_payee_class text CHECK (
    tds_payee_class IS NULL OR tds_payee_class IN ('individual_huf', 'other')
  ),

  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancel_reason text,

  recorded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, vendor_contact_id)
    REFERENCES contacts(organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),

  -- A section without a payee class cannot produce a rate, so neither
  -- is useful alone.
  CONSTRAINT vendor_invoices_tds_shape_check CHECK (
    (tds_section IS NULL) = (tds_payee_class IS NULL)
  ),
  CONSTRAINT vendor_invoices_cancel_shape_check CHECK (
    (cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancel_reason IS NULL)
    OR (
      cancelled_at IS NOT NULL
      AND cancelled_by_user_id IS NOT NULL
      AND cancel_reason IS NOT NULL
      AND length(btrim(cancel_reason)) BETWEEN 3 AND 500
    )
  )
);

COMMENT ON TABLE vendor_invoices IS
  'What a vendor has billed this organisation. A liability, not a document this organisation issues: it is outstanding until vendor_payments consume it. The due date is derived from invoice_date + credit_days and is never stored.';

CREATE UNIQUE INDEX vendor_invoices_number_per_vendor
  ON vendor_invoices (organisation_id, vendor_contact_id, lower(btrim(invoice_number)))
  WHERE cancelled_at IS NULL;
CREATE INDEX vendor_invoices_vendor_idx
  ON vendor_invoices (organisation_id, vendor_contact_id, invoice_date DESC, id);
CREATE INDEX vendor_invoices_open_idx
  ON vendor_invoices (organisation_id, invoice_date DESC, id)
  WHERE cancelled_at IS NULL;
-- The Work foreign key's own index, unfiltered, for the same reason
-- payment_requests_work_idx is unfiltered.
CREATE INDEX vendor_invoices_work_idx
  ON vendor_invoices (organisation_id, work_id, invoice_date DESC, id);

-- ── Vendor payments, with TDS captured at source ─────────────────────

CREATE TABLE vendor_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  vendor_invoice_id uuid NOT NULL,
  paid_on date NOT NULL,

  -- THE THREE FIGURES. `gross_amount` is what the payment discharges of
  -- the invoice; `tds_amount` is what was withheld and paid to the
  -- Government instead; `net_amount` is what reached the vendor's bank.
  -- gross = tds + net, checked here rather than trusted from the
  -- caller, and the invoice is consumed by the GROSS. Recording only
  -- the net would leave every invoice permanently short by its own TDS,
  -- which is the same mistake bill_payment_deductions exists to prevent
  -- on the receivable side.
  gross_amount money_amount NOT NULL CHECK (gross_amount > 0),
  tds_amount money_amount NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
  net_amount money_amount NOT NULL CHECK (net_amount >= 0),

  -- The TDS facts, snapshotted. The rate is stored ON THE PAYMENT and
  -- not looked up when the quarterly return is drawn, because the rate
  -- in force is the one that applied on the day of deduction and
  -- Finance Acts move it. A return re-derived from today's rate table
  -- would restate last quarter's deductions.
  tds_section text CHECK (tds_section IS NULL OR tds_section IN ('194C', '194J')),
  tds_rate numeric(5,2) CHECK (tds_rate IS NULL OR (tds_rate >= 0 AND tds_rate <= 100)),
  -- Section 206AA: the payee furnished no PAN, so the rate was floored
  -- at 20%. Flagged rather than inferred, because the PAN may be added
  -- to the contact master afterwards and the deduction still stands.
  pan_absent boolean NOT NULL DEFAULT false,
  -- The PAN the deduction was made against, snapshotted for the return.
  vendor_pan text CHECK (
    vendor_pan IS NULL OR vendor_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'
  ),

  reference text CHECK (
    reference IS NULL
    OR (btrim(reference) = reference AND length(reference) BETWEEN 1 AND 100)
  ),
  remarks text CHECK (
    remarks IS NULL OR length(btrim(remarks)) BETWEEN 1 AND 500
  ),

  recorded_by_user_id text NOT NULL,
  voided_at timestamptz,
  voided_by_user_id text,
  void_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, vendor_invoice_id)
    REFERENCES vendor_invoices(organisation_id, id),

  CONSTRAINT vendor_payments_splits_check CHECK (
    gross_amount = tds_amount + net_amount
  ),
  -- A withheld amount without the section and rate that produced it
  -- cannot be reported on a return, so it may not be recorded at all.
  CONSTRAINT vendor_payments_tds_shape_check CHECK (
    (tds_amount = 0 AND tds_section IS NULL AND tds_rate IS NULL)
    OR (tds_amount > 0 AND tds_section IS NOT NULL AND tds_rate IS NOT NULL)
  ),
  CONSTRAINT vendor_payments_pan_absent_shape_check CHECK (
    NOT pan_absent OR vendor_pan IS NULL
  ),
  CONSTRAINT vendor_payments_void_shape_check CHECK (
    (voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
    OR (
      voided_at IS NOT NULL
      AND voided_by_user_id IS NOT NULL
      AND void_reason IS NOT NULL
      AND length(btrim(void_reason)) BETWEEN 3 AND 500
    )
  )
);

COMMENT ON TABLE vendor_payments IS
  'Money paid to a vendor against one invoice, with the tax deducted at source. gross = tds + net; the invoice is consumed by the gross, because tax withheld is money the vendor has been credited with and paid to the Government on its behalf.';
COMMENT ON COLUMN vendor_payments.tds_rate IS
  'The rate in force on the day of deduction, snapshotted. A quarterly return re-derived from the current rate table would restate earlier quarters whenever a Finance Act moves a rate.';
COMMENT ON COLUMN vendor_payments.pan_absent IS
  'Section 206AA applied: no PAN was furnished, so the rate was floored at 20%. Recorded as a fact of the deduction, not inferred from the contact master, which may gain a PAN later.';

CREATE UNIQUE INDEX vendor_payments_reference_per_invoice
  ON vendor_payments (organisation_id, vendor_invoice_id, btrim(reference))
  WHERE reference IS NOT NULL AND voided_at IS NULL;
CREATE INDEX vendor_payments_invoice_idx
  ON vendor_payments (organisation_id, vendor_invoice_id, paid_on DESC, id);
-- The quarterly TDS return reads by date and section across all
-- vendors, so it gets its own index rather than scanning the register.
CREATE INDEX vendor_payments_tds_return_idx
  ON vendor_payments (organisation_id, paid_on, tds_section)
  WHERE tds_amount > 0 AND voided_at IS NULL;

-- ── Money enforced twice: the vendor-payment guard ───────────────────

CREATE FUNCTION app_private.vendor_invoice_paid_total(p_invoice_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(sum(gross_amount), 0)::numeric
  FROM vendor_payments
  WHERE vendor_invoice_id = p_invoice_id AND voided_at IS NULL
$$;

COMMENT ON FUNCTION app_private.vendor_invoice_paid_total(uuid) IS
  'What has been discharged against a vendor invoice: the sum of the GROSS of its live payments. Voided rows are ignored.';

CREATE FUNCTION app_private.guard_vendor_payment_write()
RETURNS trigger
LANGUAGE plpgsql
-- VOLATILE deliberately, for the same reason 0067's deduction guard is:
-- a STABLE function reads the snapshot from the start of the statement
-- and would not see sibling rows inserted earlier in the same
-- transaction, so two payments inserted together could each believe the
-- other did not exist and jointly overshoot the invoice.
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invoice   vendor_invoices%ROWTYPE;
  v_paid      numeric;
BEGIN
  -- A recorded payment is immutable except for the void. Correcting a
  -- payment means voiding it and recording the right one, so that the
  -- wrong figure stays visible in the register.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'A voided vendor payment cannot be changed.'
        USING ERRCODE = '23B04';
    END IF;
    -- Every column of the row except the three void columns and the
    -- maintained `updated_at`. Listed exhaustively rather than by
    -- exception, because a ROW guard is a denylist: a column added later
    -- and forgotten here would be silently editable on a recorded
    -- payment. `packages/db/test/issued-immutability-coverage.integration.test.ts`
    -- is what refuses to let that happen quietly.
    IF ROW(NEW.organisation_id, NEW.vendor_invoice_id, NEW.paid_on,
           NEW.gross_amount, NEW.tds_amount, NEW.net_amount,
           NEW.tds_section, NEW.tds_rate, NEW.pan_absent, NEW.vendor_pan,
           NEW.reference, NEW.remarks, NEW.recorded_by_user_id,
           NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.organisation_id, OLD.vendor_invoice_id, OLD.paid_on,
           OLD.gross_amount, OLD.tds_amount, OLD.net_amount,
           OLD.tds_section, OLD.tds_rate, OLD.pan_absent, OLD.vendor_pan,
           OLD.reference, OLD.remarks, OLD.recorded_by_user_id,
           OLD.created_at)
    THEN
      RAISE EXCEPTION 'A recorded vendor payment is immutable; void it and record a correct one.'
        USING ERRCODE = '23B04';
    END IF;
    -- Only the void transition remains, and it reduces the paid total,
    -- so it needs no ceiling check.
    RETURN NEW;
  END IF;

  -- Lock the invoice so two concurrent payments serialise on it rather
  -- than both reading the same pre-payment total.
  SELECT * INTO v_invoice FROM vendor_invoices
    WHERE id = NEW.vendor_invoice_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The vendor invoice this payment names is not visible to this transaction.'
      USING ERRCODE = '23B03';
  END IF;

  IF v_invoice.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'A cancelled vendor invoice cannot be paid.'
      USING ERRCODE = '23B02';
  END IF;

  v_paid := app_private.vendor_invoice_paid_total(NEW.vendor_invoice_id);

  IF v_paid + NEW.gross_amount > v_invoice.amount THEN
    RAISE EXCEPTION
      'Paying % would exceed the vendor invoice: % already paid of %.',
      NEW.gross_amount, v_paid, v_invoice.amount
      USING ERRCODE = '23B01';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_vendor_payment_write
  BEFORE INSERT OR UPDATE ON vendor_payments
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_vendor_payment_write();

-- ── Money enforced twice: the payment-request guard ──────────────────

CREATE FUNCTION app_private.guard_payment_request_write()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND NEW.status <> 'submitted' THEN
      RAISE EXCEPTION 'A payment request is created as a draft or a submission, not as %.', NEW.status
        USING ERRCODE = '23B12';
    END IF;
    RETURN NEW;
  END IF;

  -- Never editable at any stage, not even in draft: who owns the row,
  -- who raised it, and when. Frozen separately from the money below
  -- because these are true from the first write rather than from the
  -- decision.
  IF ROW(NEW.organisation_id, NEW.requested_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.organisation_id, OLD.requested_by_user_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'A payment request cannot change organisation, requester or creation time.'
      USING ERRCODE = '23B11';
  END IF;

  -- The approved amount is the thing being protected. Everything about
  -- a request may be corrected while it is a draft; once it has been
  -- decided, the money it authorises is frozen.
  IF OLD.status NOT IN ('draft', 'submitted') THEN
    IF NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.beneficiary_contact_id IS DISTINCT FROM OLD.beneficiary_contact_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.request_number IS DISTINCT FROM OLD.request_number
    THEN
      RAISE EXCEPTION 'A decided payment request cannot have its amount, kind, beneficiary or number changed.'
        USING ERRCODE = '23B11';
    END IF;
  END IF;

  -- A terminal state is terminal.
  IF OLD.status = 'rejected' AND NEW.status <> 'rejected' THEN
    RAISE EXCEPTION 'A rejected payment request cannot be revived; raise a new one.'
      USING ERRCODE = '23B12';
  END IF;
  IF OLD.status = 'settled' AND NEW.status <> 'settled' THEN
    RAISE EXCEPTION 'A settled payment request cannot be reopened.'
      USING ERRCODE = '23B12';
  END IF;

  -- Paying is the irreversible step, so it may only follow an approval.
  IF NEW.status IN ('paid', 'settled') AND OLD.status NOT IN ('approved', 'paid', 'settled') THEN
    RAISE EXCEPTION 'A payment request must be approved before it is paid.'
      USING ERRCODE = '23B12';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_payment_request_write
  BEFORE INSERT OR UPDATE ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_payment_request_write();

-- ── The advance gate, callable from the route ────────────────────────
--
-- The partial unique index above makes a second open advance
-- impossible. This function is how the ROUTE refuses it in advance with
-- a sentence an operator can act on, instead of surfacing a unique
-- violation. Both exist on purpose: the index is the guarantee, this is
-- the manners.

CREATE FUNCTION app_private.open_advance_for_beneficiary(p_contact_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT id FROM payment_requests
  WHERE beneficiary_contact_id = p_contact_id
    AND kind = 'advance'
    AND status = 'paid'
    AND bills_recorded_at IS NULL
  LIMIT 1
$$;

COMMENT ON FUNCTION app_private.open_advance_for_beneficiary(uuid) IS
  'The paid advance whose final bills are still outstanding for this beneficiary, if any. The route reads it to refuse a new advance by name; payment_requests_one_open_advance_per_beneficiary is what makes the refusal a guarantee.';

-- ── Two more statutory deduction heads on the receivable side ────────
--
-- `bill_payment_deductions.category` (migration 0067) had five heads,
-- and two real ones were falling into the wrong box. BOCW cess is a
-- statutory levy under section 3 of the Building and Other Construction
-- Workers' Welfare Cess Act 1996, reconciled against a cess return to
-- the State welfare board, and it was going into OTHER. Liquidated
-- damages are the pre-agreed contractual recovery for delay, argued
-- under a named GCC clause, and they were going into PENALTY alongside
-- unrelated recoveries. A head reconciled through its own form needs
-- its own row — the same reasoning that separated GST TDS from
-- income-tax TDS when this table was created.
--
-- PENALTY is kept. It is not a synonym for liquidated damages, and rows
-- already carry it.
--
-- Widening a CHECK constraint accepts every row that was already
-- valid, so this needs no backfill and no NOT VALID/VALIDATE dance.

ALTER TABLE bill_payment_deductions
  DROP CONSTRAINT bill_payment_deductions_category_check;

ALTER TABLE bill_payment_deductions
  ADD CONSTRAINT bill_payment_deductions_category_check CHECK (category IN (
    'GST_TDS',
    'INCOME_TAX_TDS',
    'SECURITY_DEPOSIT',
    'LIQUIDATED_DAMAGES',
    'BOCW_CESS',
    'PENALTY',
    'OTHER'
  ));

COMMENT ON COLUMN bill_payment_deductions.category IS
  'GST_TDS (CGST s.51), INCOME_TAX_TDS (s.194C), SECURITY_DEPOSIT (retention), LIQUIDATED_DAMAGES (contractual delay recovery), BOCW_CESS (s.3 of the BOCW Welfare Cess Act 1996), PENALTY (any other imposed recovery), or OTHER — which requires a description. Rates and citations live in packages/contracts/src/statutory.ts.';

-- ── Row-level security ───────────────────────────────────────────────

ALTER TABLE payment_request_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_request_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE vendor_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_payments FORCE ROW LEVEL SECURITY;

-- The scalar subselect form is migration 0069's InitPlan rule: it makes
-- the tenant lookup a once-per-statement InitPlan instead of a
-- per-row call.
CREATE POLICY payment_request_counters_tenant_policy ON payment_request_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
CREATE POLICY payment_requests_tenant_policy ON payment_requests
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
CREATE POLICY vendor_invoices_tenant_policy ON vendor_invoices
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));
CREATE POLICY vendor_payments_tenant_policy ON vendor_payments
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE anywhere: a payment record is voided or cancelled, never
-- removed. Drafts are the exception the product allows elsewhere, and
-- payment_requests deliberately does not follow it — an abandoned draft
-- is rejected, which keeps who asked for what in the register.
GRANT SELECT, INSERT, UPDATE ON payment_request_counters TO auto_mb_app;
GRANT SELECT, INSERT, UPDATE ON payment_requests TO auto_mb_app;
GRANT SELECT, INSERT, UPDATE ON vendor_invoices TO auto_mb_app;
GRANT SELECT, INSERT, UPDATE ON vendor_payments TO auto_mb_app;

-- `app_private` is not on the application role's search_path, so the
-- role gets each readable helper by name. The trigger guards need no
-- grant — a trigger function runs as part of the statement that fired
-- it — but these two are read by the route to answer "how much is left
-- on this invoice" and "does this person owe bills", so their grants
-- are real rather than a formality.
REVOKE ALL ON FUNCTION app_private.vendor_invoice_paid_total(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.open_advance_for_beneficiary(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.vendor_invoice_paid_total(uuid)
      TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.open_advance_for_beneficiary(uuid)
      TO auto_mb_app;
  END IF;
END
$$;
