SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0114: the opening billing position of a pre-system Work.
--
-- Owner ruling, live-testing corrections item 23.
--
-- ---------------------------------------------------------------------
-- THE HOLE.
--
-- Works imported at the v1 cutover arrive with their delivery challans,
-- their installations and their serial numbers, and with NO Measurement
-- Books and NO bills — the v1 product did not model either. Migration
-- 0066 then requires a received railway bill to name a Measurement Book,
-- and 0111 requires that book to carry a matched railway measurement, so
-- an imported Work's billing history is not merely absent: it is
-- unrecordable. The agency knows it has been paid up to a bill; the
-- product cannot be told.
--
-- Everything downstream inherits the hole. The next Measurement Book
-- raised on such a Work bills from a prior cumulative of zero, so it
-- re-bills quantities the railway paid for years ago and its remarks
-- narrate a history that did not happen. Its number restarts at MB-01
-- beside a railway series already at 04. And the receivables position
-- reads gross with no deductions against it, because the security
-- deposit, the retention and the two TDS heads live in bills this product
-- never saw.
--
-- ---------------------------------------------------------------------
-- THE SHAPE THE OWNER RULED: the last bill, the last measurement, and a
-- line-by-line confirmation.
--
-- The operator uploads the LAST RAILWAY BILL — the document that says
-- what has been paid — and, where the agency still holds it, the LAST
-- RAILWAY MEASUREMENT SHEET, which is the document that says what those
-- payments were for, item by item. The bill is read by the machinery
-- 0066 already uses; the sheet is read by 0111's. From the sheet's
-- per-item remarks the system PROPOSES a per-stage split for every item;
-- the operator then confirms each line by name.
--
-- PROPOSE AND PROVE, not extract and trust. AGENTS.md rule 10 is that AI
-- and parser extraction may propose data and never commit an
-- authoritative contract record, and an opening billing position is as
-- authoritative as a record gets — every Measurement Book after it counts
-- from these numbers. So a proposal is a starting point on a form, the
-- figures are editable while the baseline is a draft, and each line
-- carries the name of the member who said it is right. A Work whose
-- documents cannot be read at all still gets a baseline: every line is
-- simply entered by hand, which is an ACT with an author rather than a
-- bypass with none.
--
-- WHAT IS DELIBERATELY NOT MODELLED, so the omission is posture rather
-- than oversight. Per-item amounts are NOT read out of the bill's own
-- item table. That table is real and the figures in it are the ones an
-- accountant would want, but three committed corpus bills say it cannot
-- be read reliably: its numeric cells wrap across up to three lines with
-- their fragments right-aligned into different columns, adjacent columns
-- collide into single `-layout` cells ("2151227. toPrepaid"), and the
-- column positions move between pages. A parser built against it read 82
-- of BILL-3's 129 item blocks and silently mis-read some of the rest,
-- and a silently wrong MONEY proposal under a confirmation button is the
-- worst thing this table could contain. The bill therefore anchors the
-- DOCUMENT-level facts it prints unambiguously — its number, its date,
-- its total, and the measurement sequence the next book resumes from —
-- and the per-item money is proposed from the item's own accepted rate
-- through the same `computeStageAmounts` every Measurement Book line is
-- priced with, with the bill's own total on screen beside the proposed
-- one as the operator's cross-check. If a future pack cracks the item
-- table, the proposal source changes and nothing else does.
--
-- ---------------------------------------------------------------------
-- WHAT THE LOCK IS FOR.
--
-- A baseline is a draft until somebody locks it, and locking is what
-- makes it load-bearing: from that moment the Measurement Book engine
-- adds these figures to its prior-cumulative memory and the MB counter
-- resumes at the recorded sequence plus one. So the lock is guarded three
-- ways — every line confirmed, no system-native finalized Measurement
-- Book on the Work, and terminal once taken.
--
-- "No system-native finalized Measurement Book" is the rule that keeps
-- this from being a back door into a live Work's history. A baseline
-- states what happened BEFORE this product; a Work that has finalized a
-- book here has a history this product already holds, and a second
-- opening position would double-count it. Checked at insert AND at lock,
-- because the two can be minutes apart.
--
-- ---------------------------------------------------------------------
-- DEDUCTIONS.
--
-- Cumulative-to-date figures per head — security deposit, retention,
-- liquidated damages, income-tax TDS, GST TDS — recorded per Work and
-- editable until the same lock. They are typed rather than extracted and
-- the table says so in its column names: these are what the agency's own
-- ledger says has been withheld, and the bills they were withheld on are
-- exactly the bills this product never saw.
--
-- They ride on the baseline's lock rather than one of their own. A gross
-- billed-to-date figure with editable deductions under it is a net
-- receivable that changes when nobody billed anything, and one lock over
-- the whole opening position is one decision instead of two.
--
-- ---------------------------------------------------------------------
-- SQLSTATEs: the 23W block, this pack's, opened here.
--
--   23W01  this Work has a system-native finalized Measurement Book, so
--          it has no pre-system opening position to state.
--   23W02  a locked baseline is immutable, and does not delete.
--   23W03  a baseline locks only when every line is confirmed.
--   23W04  a locked baseline's lines are frozen.
--   23W05  the opening deductions are frozen with the baseline.
--   23W06  a baseline line is about a live item of its own Work.
--
-- 23S and 23T remain held by the wave ledger for E-whatsapp-delivery and
-- E-msme (0111 § SQLSTATEs records why); 23M is free and unclaimed. This
-- pack was allocated 23W and takes nothing else.

-- ---------------------------------------------------------------------
-- 1. The baseline.
-- ---------------------------------------------------------------------
CREATE TABLE work_billing_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,

  -- THE LAST RAILWAY BILL. Required: a baseline says money has been paid,
  -- and the document that says so is the point. Stored on the same terms
  -- as every other inbound document (0066 § 1, 0111 § 1) — tenant-prefixed
  -- key, digest, declared size, PDF only.
  bill_object_key text NOT NULL,
  bill_filename text NOT NULL,
  bill_sha256 sha256_hex NOT NULL,
  bill_media_type text NOT NULL CHECK (bill_media_type = 'application/pdf'),
  bill_size_bytes bigint NOT NULL CHECK (bill_size_bytes > 0),

  -- How the four figures below came to be known.
  --
  --   extracted  read out of the uploaded PDF's own text by
  --              `parseReceivedRailwayBill`, and `bill_extraction` holds
  --              everything that reading found.
  --   recorded   the PDF carries no text this product can read — a scan,
  --              a layout the parser cannot resolve — and a named member
  --              typed them from the document in front of them. 0111's
  --              `unreadable` posture, applied to the document one step
  --              further back: an act with an author, not a waiver.
  bill_source text NOT NULL CHECK (bill_source IN ('extracted', 'recorded')),
  bill_extraction jsonb CHECK (
    bill_extraction IS NULL OR jsonb_typeof(bill_extraction) = 'object'
  ),

  bill_number text NOT NULL CHECK (
    btrim(bill_number) = bill_number AND length(bill_number) BETWEEN 1 AND 100
  ),
  bill_date date NOT NULL,
  bill_amount money_amount NOT NULL CHECK (bill_amount > 0),

  -- The measurement sequence the bill settles: the next Measurement Book
  -- this product raises is this plus one, and the MB counter is moved to
  -- match when the baseline locks.
  last_mb_sequence_number integer NOT NULL CHECK (last_mb_sequence_number > 0),

  -- THE LAST RAILWAY MEASUREMENT SHEET, optional. It is what the per-item
  -- proposal is derived from; a Work whose sheet is lost still gets a
  -- baseline, entered line by line. All five columns travel together.
  measurement_object_key text,
  measurement_filename text,
  measurement_sha256 sha256_hex,
  measurement_size_bytes bigint CHECK (
    measurement_size_bytes IS NULL OR measurement_size_bytes > 0
  ),
  measurement_extraction jsonb CHECK (
    measurement_extraction IS NULL
    OR jsonb_typeof(measurement_extraction) = 'object'
  ),

  created_by_user_id text NOT NULL,
  locked_at timestamptz,
  locked_by_user_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- AT MOST ONCE PER WORK. Not a partial index over some "live" flag:
  -- there is no discard here, because an unlocked baseline deletes and a
  -- locked one is the Work's opening position forever.
  UNIQUE (organisation_id, work_id),
  UNIQUE (organisation_id, bill_object_key),

  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),

  CONSTRAINT work_billing_baselines_bill_key_tenant_prefix_check
    CHECK (bill_object_key LIKE organisation_id::text || '/%'),
  CONSTRAINT work_billing_baselines_measurement_key_tenant_prefix_check
    CHECK (
      measurement_object_key IS NULL
      OR measurement_object_key LIKE organisation_id::text || '/%'
    ),

  CONSTRAINT work_billing_baselines_bill_reading_shape_check CHECK (
    (bill_source = 'extracted' AND bill_extraction IS NOT NULL)
    OR (bill_source = 'recorded' AND bill_extraction IS NULL)
  ),

  CONSTRAINT work_billing_baselines_measurement_shape_check CHECK (
    (
      measurement_object_key IS NULL
      AND measurement_filename IS NULL
      AND measurement_sha256 IS NULL
      AND measurement_size_bytes IS NULL
      AND measurement_extraction IS NULL
    )
    OR
    (
      measurement_object_key IS NOT NULL
      AND measurement_filename IS NOT NULL
      AND measurement_sha256 IS NOT NULL
      AND measurement_size_bytes IS NOT NULL
      AND measurement_extraction IS NOT NULL
    )
  ),

  CONSTRAINT work_billing_baselines_lock_shape_check CHECK (
    (locked_at IS NULL AND locked_by_user_id IS NULL)
    OR (locked_at IS NOT NULL AND locked_by_user_id IS NOT NULL)
  )
);

COMMENT ON TABLE work_billing_baselines IS
  'The opening billing position of a Work whose history predates this product: the last railway bill it was paid on, the last measurement sheet that bill was raised from, and — in work_billing_baseline_lines — what each item had been billed for by then. Locked once, after which it seeds the Measurement Book engine''s prior-cumulative memory and its numbering.';
COMMENT ON COLUMN work_billing_baselines.bill_source IS
  'extracted (read from the PDF''s own text) or recorded (the PDF carries no readable text and a named member typed the figures from it). The same split migration 0111 draws between a read measurement and an unreadable one.';
COMMENT ON COLUMN work_billing_baselines.last_mb_sequence_number IS
  'The measurement sequence the recorded bill settles. Locking the baseline moves the Work''s Measurement Book counter to this plus one, so the next book this product numbers continues the railway''s series instead of restarting it.';

CREATE INDEX work_billing_baselines_work_idx
  ON work_billing_baselines (organisation_id, work_id);

ALTER TABLE work_billing_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_billing_baselines FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY work_billing_baselines_tenant_policy ON work_billing_baselines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- DELETE is granted, and the guard below is what makes that safe: an
-- UNLOCKED baseline is a form somebody is filling in and abandoning it
-- should leave nothing behind, while a locked one never leaves.
GRANT SELECT, INSERT, UPDATE, DELETE ON work_billing_baselines TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 2. The per-item opening position.
--
-- One row per Work item the baseline states anything about. The four
-- quantity columns are the SAME four stages a Measurement Book line
-- carries, and they are physical quantities, not coefficient ones — this
-- feeds `prior_supplied` and its siblings directly, and those have always
-- been physical (migration 0113 explains why the two readings exist and
-- which one the snapshot holds).
--
-- The PROPOSED columns are kept beside the confirmed ones rather than
-- overwritten by them. What the machine read and what a person accepted
-- are two different statements, and a baseline that kept only the second
-- could never answer "did anybody actually change this?" — which is the
-- first question anyone will ask of a figure that turns out wrong.
-- ---------------------------------------------------------------------
CREATE TABLE work_billing_baseline_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_billing_baseline_id uuid NOT NULL,
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,

  prior_supplied quantity_amount NOT NULL DEFAULT 0 CHECK (prior_supplied >= 0),
  prior_installed quantity_amount NOT NULL DEFAULT 0 CHECK (prior_installed >= 0),
  prior_pac quantity_amount NOT NULL DEFAULT 0 CHECK (prior_pac >= 0),
  prior_final_bill quantity_amount NOT NULL DEFAULT 0 CHECK (prior_final_bill >= 0),

  -- What this item had been paid, cumulative, by the recorded bill.
  amount money_amount NOT NULL DEFAULT 0 CHECK (amount >= 0),

  -- The proposal, exactly as it was made. NULL on a line nothing was
  -- proposed for — no measurement sheet, or a sheet that carried no
  -- reading for this item.
  proposed_supplied quantity_amount,
  proposed_installed quantity_amount,
  proposed_pac quantity_amount,
  proposed_final_bill quantity_amount,
  proposed_amount money_amount,
  -- The remark the proposal was derived from, verbatim, so the figures
  -- can be argued with rather than only accepted.
  proposed_from_remark text,

  confirmed_by_user_id text,
  confirmed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_billing_baseline_id, work_item_id),

  FOREIGN KEY (organisation_id, work_billing_baseline_id)
    REFERENCES work_billing_baselines(organisation_id, id),
  FOREIGN KEY (organisation_id, work_item_id, work_id)
    REFERENCES work_items(organisation_id, id, work_id),

  CONSTRAINT work_billing_baseline_lines_confirmation_shape_check CHECK (
    (confirmed_at IS NULL AND confirmed_by_user_id IS NULL)
    OR (confirmed_at IS NOT NULL AND confirmed_by_user_id IS NOT NULL)
  )
);

COMMENT ON TABLE work_billing_baseline_lines IS
  'What one Work item had been billed for, per payment stage and in rupees, by the bill the baseline records. Physical quantities, on the same footing as measurement_book_lines.prior_*, which is what these are added to once the baseline locks. Each line names the member who confirmed it.';

CREATE INDEX work_billing_baseline_lines_baseline_idx
  ON work_billing_baseline_lines (organisation_id, work_billing_baseline_id);
CREATE INDEX work_billing_baseline_lines_item_idx
  ON work_billing_baseline_lines (organisation_id, work_item_id);

ALTER TABLE work_billing_baseline_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_billing_baseline_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY work_billing_baseline_lines_tenant_policy
  ON work_billing_baseline_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON work_billing_baseline_lines TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 3. The opening deductions.
--
-- Five heads, closed. A free-text head would make the receivables
-- arithmetic a sum over whatever anybody typed, and two spellings of
-- "retention" would each be half the money.
-- ---------------------------------------------------------------------
CREATE TABLE work_deduction_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,

  head text NOT NULL CHECK (
    head IN (
      'security_deposit',
      'retention',
      'liquidated_damages',
      'income_tax_tds',
      'gst_tds'
    )
  ),
  -- Cumulative to date, in rupees. Zero is a legitimate statement — "we
  -- checked, nothing was withheld under this head" — and is why the row
  -- exists at all rather than being inferred from absence.
  amount money_amount NOT NULL CHECK (amount >= 0),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500),

  recorded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_id, head),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

COMMENT ON TABLE work_deduction_entries IS
  'Cumulative-to-date deductions per head on a Work whose billing history predates this product: what the agency''s own ledger says has been withheld against bills this product never saw. Editable until the Work''s billing baseline is locked, and frozen with it — a gross figure with editable deductions under it is a net receivable that moves when nobody billed anything.';

CREATE INDEX work_deduction_entries_work_idx
  ON work_deduction_entries (organisation_id, work_id);

ALTER TABLE work_deduction_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_deduction_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY work_deduction_entries_tenant_policy ON work_deduction_entries
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON work_deduction_entries TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 4. A baseline is only ever raised on a Work that has no history here.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_billing_baseline_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM measurement_books mb
    WHERE mb.organisation_id = NEW.organisation_id
      AND mb.work_id = NEW.work_id
      AND mb.status IN ('finalized', 'cancelled')
  ) THEN
    RAISE EXCEPTION
      'Work % has finalized a Measurement Book in this system, so its billing history is already recorded here and has no opening baseline',
      NEW.work_id
      USING ERRCODE = '23W01';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_work_billing_baseline_insert() IS
  'An opening billing position states what happened BEFORE this product. A Work that has numbered a Measurement Book here has a history this product already holds, and a baseline beside it would be counted twice.';

-- Cancelled counts as well as finalized, and that is deliberate: a
-- cancelled book still took a number out of the Work's series, so a Work
-- that has one is a Work this product has already been billing.
CREATE TRIGGER work_billing_baselines_guard_insert
BEFORE INSERT ON work_billing_baselines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_billing_baseline_insert();

-- ---------------------------------------------------------------------
-- 5. The lock, and what it costs to take.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_billing_baseline_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  unconfirmed text;
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'the billing baseline of Work % is locked and states its opening position permanently',
      OLD.work_id
      USING ERRCODE = '23W02';
  END IF;

  -- The evidence is written once. Everything a person may still change
  -- while the baseline is a draft lives on the LINES; the documents and
  -- what was read out of them do not move, for the reason 0111 gives
  -- about its own bytes: the point of extracting a fact was that nobody
  -- gets to assert it. Replacing the bill means deleting the draft and
  -- uploading again.
  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.bill_object_key, NEW.bill_filename,
    NEW.bill_sha256, NEW.bill_media_type, NEW.bill_size_bytes,
    NEW.bill_source, NEW.bill_extraction, NEW.bill_number, NEW.bill_date,
    NEW.bill_amount, NEW.last_mb_sequence_number, NEW.created_by_user_id,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.bill_object_key, OLD.bill_filename,
    OLD.bill_sha256, OLD.bill_media_type, OLD.bill_size_bytes,
    OLD.bill_source, OLD.bill_extraction, OLD.bill_number, OLD.bill_date,
    OLD.bill_amount, OLD.last_mb_sequence_number, OLD.created_by_user_id,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'a billing baseline''s recorded bill and its reading are written once and never change'
      USING ERRCODE = '23W02';
  END IF;

  IF NEW.locked_at IS NOT NULL THEN
    -- Re-checked at the lock as well as at the insert: a Measurement Book
    -- can be finalized between the two, and the lock is the moment this
    -- row starts changing what other books compute.
    IF EXISTS (
      SELECT 1 FROM measurement_books mb
      WHERE mb.organisation_id = NEW.organisation_id
        AND mb.work_id = NEW.work_id
        AND mb.status IN ('finalized', 'cancelled')
    ) THEN
      RAISE EXCEPTION
        'Work % finalized a Measurement Book while this baseline was being filled in; its opening position cannot be locked',
        NEW.work_id
        USING ERRCODE = '23W01';
    END IF;

    -- Every line, or none of it. `string_agg` over the shortfall rather
    -- than a bare count, so the refusal names the items somebody still
    -- has to look at instead of a number they then have to go and find
    -- (0111 § 5's phrasing, and its reason).
    SELECT string_agg(wi.item_number, ', ' ORDER BY wi.item_number)
      INTO unconfirmed
    FROM work_billing_baseline_lines l
    JOIN work_items wi
      ON wi.organisation_id = l.organisation_id AND wi.id = l.work_item_id
    WHERE l.organisation_id = NEW.organisation_id
      AND l.work_billing_baseline_id = NEW.id
      AND l.confirmed_at IS NULL;

    IF unconfirmed IS NOT NULL THEN
      RAISE EXCEPTION
        'these baseline lines are not confirmed yet: %', unconfirmed
        USING ERRCODE = '23W03';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_work_billing_baseline_update() IS
  'A billing baseline locks only when every one of its lines has been confirmed by name and the Work still has no Measurement Book of its own; after that it is immutable. Its uploaded documents and their readings never change at all.';

CREATE TRIGGER work_billing_baselines_guard_update
BEFORE UPDATE ON work_billing_baselines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_billing_baseline_update();

CREATE TRIGGER work_billing_baselines_touch_updated_at
BEFORE UPDATE ON work_billing_baselines
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 6. A locked baseline does not leave.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_billing_baseline_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'the billing baseline of Work % is locked; every Measurement Book raised since counts from it',
      OLD.work_id
      USING ERRCODE = '23W02';
  END IF;
  RETURN OLD;
END
$$;

COMMENT ON FUNCTION app_private.guard_work_billing_baseline_delete() IS
  'An unlocked baseline is a form somebody is filling in and deletes without residue. A locked one is the Work''s opening position and the memory every book after it counts from.';

CREATE TRIGGER work_billing_baselines_guard_delete
BEFORE DELETE ON work_billing_baselines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_billing_baseline_delete();

-- ---------------------------------------------------------------------
-- 7. Lines: editable while the baseline is a draft, about a real item of
--    its own Work, and frozen the moment the baseline locks.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_billing_baseline_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  baseline work_billing_baselines%ROWTYPE;
  row_organisation uuid;
  row_baseline uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_organisation := OLD.organisation_id;
    row_baseline := OLD.work_billing_baseline_id;
  ELSE
    row_organisation := NEW.organisation_id;
    row_baseline := NEW.work_billing_baseline_id;
  END IF;

  SELECT * INTO baseline FROM work_billing_baselines
  WHERE id = row_baseline AND organisation_id = row_organisation;

  -- An invisible parent refuses rather than waves through: the 0017/0022
  -- posture this schema takes everywhere a guard reads a parent row.
  IF NOT FOUND OR baseline.locked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'the lines of a locked billing baseline are frozen'
      USING ERRCODE = '23W04';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- The line is about a live item of the baseline's OWN Work. The
  -- composite foreign key already ties the item to `work_id`; this ties
  -- `work_id` to the baseline, which the key cannot, and refuses an item
  -- the schedule has since dropped.
  IF NEW.work_id IS DISTINCT FROM baseline.work_id THEN
    RAISE EXCEPTION
      'baseline line names Work % and its baseline is about Work %',
      NEW.work_id, baseline.work_id
      USING ERRCODE = '23W06';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM work_items wi
    WHERE wi.organisation_id = NEW.organisation_id
      AND wi.id = NEW.work_item_id
      AND wi.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'baseline line names an item that is not live on this Work'
      USING ERRCODE = '23W06';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_work_billing_baseline_line_mutation() IS
  'A baseline line is editable only while its baseline is a draft, and only about a live item of the Work that baseline is for. Once the baseline locks the lines are the Work''s opening position and nothing writes them again.';

CREATE TRIGGER work_billing_baseline_lines_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON work_billing_baseline_lines
FOR EACH ROW
EXECUTE FUNCTION app_private.guard_work_billing_baseline_line_mutation();

CREATE TRIGGER work_billing_baseline_lines_touch_updated_at
BEFORE UPDATE ON work_billing_baseline_lines
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 8. Deductions freeze with the baseline.
--
-- A Work with NO baseline at all keeps its deductions editable: nothing
-- has been locked, so there is nothing to be inconsistent with. What is
-- refused is editing them after the opening position they belong to has
-- been settled.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_work_deduction_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_organisation uuid;
  row_work uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_organisation := OLD.organisation_id;
    row_work := OLD.work_id;
  ELSE
    row_organisation := NEW.organisation_id;
    row_work := NEW.work_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM work_billing_baselines b
    WHERE b.organisation_id = row_organisation
      AND b.work_id = row_work
      AND b.locked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'the opening deductions of Work % were locked with its billing baseline',
      row_work
      USING ERRCODE = '23W05';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_work_deduction_entry_mutation() IS
  'The opening deductions are part of the opening position and are settled by the same act. One lock over the whole of it is one decision rather than two that can disagree.';

CREATE TRIGGER work_deduction_entries_guard_mutation
BEFORE INSERT OR UPDATE OR DELETE ON work_deduction_entries
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_deduction_entry_mutation();

CREATE TRIGGER work_deduction_entries_touch_updated_at
BEFORE UPDATE ON work_deduction_entries
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
