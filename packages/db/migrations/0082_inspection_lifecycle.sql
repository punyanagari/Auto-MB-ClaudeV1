SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0082: the railway inspection lifecycle.
--
-- Nothing manufactured for Indian Railways moves until somebody the
-- railway trusts has looked at it. RDSO and RITES inspect at the vendor's
-- premises against the specification the LOA cites; the agency issues a
-- certificate; the material despatches under that certificate. An item
-- despatched without one is not merely undocumented — it is rejected at
-- the consignee's gate and comes back at the contractor's cost.
--
-- The product has modelled the despatch (migration 0056) and the schedule
-- it despatches against (0003) since the first milestone, and had nowhere
-- to record the act that legitimises it. This migration adds that act, and
-- one interlock: an item the Work has CONFIGURED as inspection-gated
-- cannot be despatched beyond the quantity a live certificate covers.
--
-- SIX TABLES, AND WHY EACH EXISTS.
--
--   inspection_clauses           what the contract requires, per ITEM
--   inspection_checklist_fields  what the agency demands, per AGENCY
--   inspection_calls             one call and its whole life
--   inspection_call_counters     the per-Work call sequence
--   inspection_call_items        which items a call covers, and how much
--   inspection_call_documents    the evidence, one row per demanded paper
--
-- The split that matters is the first from the third. A clause is a fact
-- about the CONTRACT — "item 2 is inspected by RDSO at RailTech" — and it
-- outlives every call raised under it. A call is one EVENT. Folding the
-- clause into the call would mean the configuration disappeared with the
-- last call, and the dispatch gate below reads the clause on every issue,
-- including for items no call has ever been raised for.
--
-- WHY THE CALL IS ALSO THE JOB CARD. The mock draws them as one thing
-- (`components/inspection-lifecycle-workspace.tsx` at fdfe5ef: receiving
-- the inward call letter materialises the job card for that call, and the
-- card carries the documents and the certificate). They are one row here
-- for the same reason: a job card with no call is not a record of
-- anything, and every field the card holds is a field about the call it
-- belongs to.
--
-- THE GATE IS QUANTITATIVE, NOT MERELY PRESENT. A certificate covers a
-- LOT, and a staged contract offers its lots one at a time. If the gate
-- asked only whether some certificate existed, a single call for 10 of an
-- item would unlock the despatch of all 500 — which is exactly the
-- inspection evasion the clause exists to prevent. So it compares
-- cumulative despatched quantity against cumulative certified quantity,
-- item by item, using the same arithmetic shape as the delivery ceiling
-- in `routes/challans.ts`. That is also why the coverage is a join table
-- carrying a quantity rather than a column on the call.
--
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * No new number series. The outward request is numbered per Work by
--     the counter below, not through `apps/server/src/number-series.ts` —
--     that module configures operator-visible prefixes for the four
--     statutory document types, and an inspection call is internal
--     correspondence. The INWARD letter carries the agency's own number
--     (`RDSO/CALL/8821`), which is typed, because it is the agency's to
--     assign and not ours.
--   * No `result` column. The certificate IS the result: an agency that
--     accepted the material says so by issuing one, and a second field
--     saying the same thing is a field that can disagree with the
--     document. A call that did not pass is CANCELLED with a reason,
--     which is this schema's existing idiom for a numbered record that
--     terminated badly (AGENTS.md rule 8), and the rectified material is
--     offered again under a fresh call.
--   * No `media_type` column on the evidence. Every upload path here
--     admits PDF and nothing else, checked by magic bytes before the
--     bytes are stored; a column that can only hold one value records
--     nothing.
--   * No document versioning. Evidence uploaded against a call is
--     replaceable while the call is open and frozen the moment it closes;
--     there is no `v2` of a routine test report, there is a second call.
--     The company document library (0079) versions because a credential
--     is renewed; a call is not renewed, it is re-raised.
--   * No expiry notification. `certificate_valid_until` is read against
--     the organisation's own today at the gate and on the register, never
--     stored as a status, for the reason 0079 gives at length.
--
-- Numbering note: 0080 and 0081 belong to the payments pack, which lands
-- from a sibling branch of the same wave. The runner keys strictly on the
-- four-digit id and never requires contiguity
-- (`packages/db/src/migration-runner.ts`); 0052, 0057, 0060, 0066 and 0070
-- set the same precedent. What must hold is that no two migrations claim
-- one id, and a gap is not that.

-- ---------------------------------------------------------------------
-- 0. Shared reading helpers.
--
-- One definition of "today" and one of "live", because the same question
-- is asked in four places — the dispatch refusal in the route, the
-- backstop trigger, the register's per-call flag, and the count of items
-- currently blocked — and four copies of a date comparison drift. The
-- review that produced this section found exactly that drift.
-- ---------------------------------------------------------------------

-- The organisation's own calendar date. A certificate that lapses "today"
-- lapses on the operator's today, not on UTC's: at 04:00 IST those are
-- different days, and the difference decides whether a lorry may leave.
CREATE FUNCTION app_private.organisation_today(org uuid)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT (now() AT TIME ZONE o.timezone)::date
  FROM organisations o
  WHERE o.id = org
$$;

COMMENT ON FUNCTION app_private.organisation_today(uuid) IS
  'The organisation''s own calendar date, from its configured timezone. Every inspection liveness comparison uses this rather than UTC.';

-- Whether a call would satisfy the dispatch gate on the given day.
-- `closed` already means inspected and certified (the closed-shape CHECK
-- below is what makes that true), so liveness is that plus an unexpired
-- window. Immutable, so the planner may inline it into the joins below.
CREATE FUNCTION app_private.inspection_certificate_live(
  call_status text,
  valid_until date,
  today date
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT call_status = 'closed' AND (valid_until IS NULL OR valid_until >= today)
$$;

COMMENT ON FUNCTION app_private.inspection_certificate_live(text, date, date) IS
  'The single definition of a live inspection certificate, shared by the dispatch refusal, its backstop trigger, and both register readings.';

-- ---------------------------------------------------------------------
-- 1. The clause: what the contract requires of an item.
--
-- One row per work item, and its ABSENCE is the default. That is the whole
-- of the "no retroactive blocking" guarantee this migration owes: every
-- Work already in the database ends this migration with zero clause rows,
-- so `gates_dispatch` is false for every item that exists, so no challan
-- that could be issued before it can be refused after. There is no
-- backfill below and there must never be one.
-- ---------------------------------------------------------------------
CREATE TABLE inspection_clauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,

  -- Who inspects. Constrained text rather than an enum type, for the
  -- reason 0079 records: the set grows (CORE and IRISET both inspect on
  -- some contracts) and growing a CHECK is one ordinary statement.
  --
  -- `consignee` is the third value and it is not a third agency. An item
  -- "inspected by consignee" is checked by the receiving railway AFTER it
  -- arrives — the mock states the consequence outright ("Consignee items
  -- remain work-specific and do not appear in the RDSO or RITES Inspection
  -- workspace"), and the CHECK below draws the harder conclusion.
  agency text NOT NULL CHECK (agency IN ('RDSO', 'RITES', 'consignee')),

  -- The LOT SIZE the contract inspects in, when it inspects in lots. It is
  -- a hint and nothing more: the raise-a-call form offers it as the
  -- default quantity, and the dispatch gate never reads it. The gate's
  -- arithmetic is over quantities actually certified, which is the only
  -- figure that says what an agency has actually seen.
  inspection_quantity quantity_amount CHECK (
    inspection_quantity IS NULL OR inspection_quantity > 0
  ),

  -- Where the inspection happens. Free text and not a foreign key to the
  -- contacts master on purpose: a vendor's premises is an address the
  -- agency is told to visit, and half of them are sub-vendors this
  -- organisation has no master row for.
  vendor_premises text CHECK (
    vendor_premises IS NULL
    OR (btrim(vendor_premises) = vendor_premises
        AND length(vendor_premises) BETWEEN 1 AND 200)
  ),

  -- THE INTERLOCK SWITCH. False by default and false for every row this
  -- migration creates, which is none.
  gates_dispatch boolean NOT NULL DEFAULT false,

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- One clause per item: the mapping screen is a table of items, and two
  -- rival clauses for one item would make "which agency inspects this"
  -- a question with two answers at the moment the gate asks it.
  UNIQUE (organisation_id, work_item_id),

  -- Three columns in the reference, not two: `work_items` carries a
  -- UNIQUE (organisation_id, id, work_id), so this proves in the database
  -- that the item named really belongs to the Work named. Without it a
  -- clause could point at another Work's item and the gate would read the
  -- wrong contract.
  FOREIGN KEY (organisation_id, work_item_id, work_id)
    REFERENCES work_items(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),

  -- A consignee-inspected item may NOT gate dispatch, and this is the
  -- constraint that keeps the interlock from deadlocking the product.
  -- Consignee inspection happens after the material arrives; a certificate
  -- for it cannot exist before despatch, so an item configured both
  -- `consignee` and `gates_dispatch` could never be despatched at all and
  -- no screen would explain why. Refusing the combination outright is
  -- kinder than refusing every challan raised under it.
  CONSTRAINT inspection_clauses_consignee_never_gates_check CHECK (
    agency <> 'consignee' OR gates_dispatch = false
  )
);

COMMENT ON TABLE inspection_clauses IS
  'What the contract requires of one work item: which agency inspects it, at whose premises, in what lot size, and whether a live certificate is required before it may be despatched.';
COMMENT ON COLUMN inspection_clauses.gates_dispatch IS
  'The dispatch interlock, per item, default false. No row means no gate, which is why existing Works are unaffected by this migration.';
COMMENT ON COLUMN inspection_clauses.inspection_quantity IS
  'The contract lot size, offered as the default when a call is raised. The gate never reads it: what a certificate covers is what its call recorded.';
COMMENT ON COLUMN inspection_clauses.agency IS
  'RDSO or RITES inspect before despatch; consignee inspects after arrival and therefore can never gate despatch (see the CHECK).';

-- The mapping screen's own read: every clause of one Work, in item order
-- once joined. The gate's read is by `work_item_id`, which the unique
-- constraint above already indexes.
CREATE INDEX inspection_clauses_work_idx
  ON inspection_clauses (organisation_id, work_id);

ALTER TABLE inspection_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_clauses FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY inspection_clauses_tenant_policy ON inspection_clauses
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- DELETE is granted: a clause is configuration, not evidence. Clearing an
-- item's agency is how an operator says "this item is not inspected", and
-- the audit trail carries what it was.
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_clauses TO auto_mb_app;

CREATE TRIGGER inspection_clauses_touch_updated_at
BEFORE UPDATE ON inspection_clauses
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. The checklist: what an agency demands.
--
-- RDSO wants a datasheet, an undertaking and a routine test report; RITES
-- wants the approved QAP and calibration certificates. The list differs by
-- agency and it can differ by contract, so:
--
--   work_id IS NULL  -> the ORGANISATION's default for that agency
--   work_id = <work> -> that Work's own list, overriding the default
--
-- The nullable column rather than a second table, because the two are the
-- same shape answering the same question at two scopes, and because the
-- alternative the review rejected — per-Work rows only — meant every new
-- Work started with an empty checklist, which makes the close gate vacuous
-- exactly when nobody is looking. A default the organisation sets once is
-- the difference between a checklist that is enforced and one that is
-- merely available.
--
-- Either way the list is SNAPSHOT onto each call when the call is raised.
-- Editing it afterwards must not silently change what a call in progress
-- is being held to — which is what a live join would do.
-- ---------------------------------------------------------------------
CREATE TABLE inspection_checklist_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  -- NULL means the organisation-wide default for this agency.
  work_id uuid,

  -- Only the two agencies that raise calls. `consignee` is absent by
  -- construction: there is no call, so there is nothing to snapshot onto.
  agency text NOT NULL CHECK (agency IN ('RDSO', 'RITES')),

  label text NOT NULL CHECK (
    btrim(label) = label AND length(label) BETWEEN 1 AND 200
  ),
  mandatory boolean NOT NULL DEFAULT true,

  -- Display order within the agency's list, so the checklist reads in the
  -- order the operator arranged it rather than by insertion accident.
  position integer NOT NULL CHECK (position >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

COMMENT ON TABLE inspection_checklist_fields IS
  'The document checklist one agency demands. work_id NULL is the organisation default; a Work''s own rows override it. Snapshot onto each call at creation, so editing it never changes a call already raised.';
COMMENT ON COLUMN inspection_checklist_fields.work_id IS
  'NULL is the organisation-wide default for the agency, which is what a new Work inherits so its first call is not held to an empty list.';

-- One paper per name per agency per scope, case-folded: "Approved QAP" and
-- "approved qap" are the same demand, and two rows would make the close
-- gate count one obligation twice. Two indexes because NULL work_id does
-- not compare equal to itself in a plain unique constraint.
CREATE UNIQUE INDEX inspection_checklist_fields_work_label_unique
  ON inspection_checklist_fields (organisation_id, work_id, agency, lower(label))
  WHERE work_id IS NOT NULL;
CREATE UNIQUE INDEX inspection_checklist_fields_default_label_unique
  ON inspection_checklist_fields (organisation_id, agency, lower(label))
  WHERE work_id IS NULL;

CREATE INDEX inspection_checklist_fields_order_idx
  ON inspection_checklist_fields (organisation_id, work_id, agency, position);

ALTER TABLE inspection_checklist_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_checklist_fields FORCE ROW LEVEL SECURITY;

CREATE POLICY inspection_checklist_fields_tenant_policy ON inspection_checklist_fields
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- A template row is configuration and is deleted outright when the demand
-- is dropped. Nothing points at it: the snapshot copied the text.
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_checklist_fields TO auto_mb_app;

CREATE TRIGGER inspection_checklist_fields_touch_updated_at
BEFORE UPDATE ON inspection_checklist_fields
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. The per-Work call sequence.
--
-- The house counter shape (0001's `delivery_challan_counters`): an upsert
-- that returns the number it claimed, so two writers never read the same
-- `max + 1`. This replaces taking the WORKS row lock to number a call,
-- which serialised every inspection call against every other writer of
-- the Work — a Measurement Book finalize, an issue, an amendment apply —
-- for no reason but a number.
-- ---------------------------------------------------------------------
CREATE TABLE inspection_call_counters (
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

COMMENT ON TABLE inspection_call_counters IS
  'Per-Work inspection call numbering. Claimed by upsert, never by reading max()+1, so concurrent raises cannot collide.';

ALTER TABLE inspection_call_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_call_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY inspection_call_counters_tenant_policy ON inspection_call_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: a counter records what a series reached, and a reset would
-- reissue a number a cancelled call still holds.
GRANT SELECT, INSERT, UPDATE ON inspection_call_counters TO auto_mb_app;

-- Every counter table in this schema carries the 0003 decrease guard, and
-- for the same reason: a counter that can be wound back is a number that
-- can be minted twice, and a cancelled call keeps its number forever.
CREATE TRIGGER inspection_call_counters_guard_decrease
BEFORE UPDATE ON inspection_call_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- ---------------------------------------------------------------------
-- 4. The call.
--
-- One row from the outward request to the certificate, in four states:
--
--   requested   the placing request has gone to the agency
--   scheduled   the agency's inward call letter has come back
--   closed      inspected, every mandatory paper on file, certificate on
--               file — this is the only state the dispatch gate accepts
--   cancelled   withdrawn, or inspected and not passed
--
-- The shape CHECKs below are what make those words mean something. Every
-- one of them exists because the alternative is a row that claims a state
-- whose evidence is absent — a `closed` call with no certificate is
-- precisely the row the dispatch gate would then wave through.
-- ---------------------------------------------------------------------
CREATE TABLE inspection_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,

  -- 1, 2, 3 … within the Work, claimed from the counter above. Cancelled
  -- calls keep their number forever and it is never reissued, because
  -- nothing here renumbers and nothing deletes.
  sequence_number integer NOT NULL CHECK (sequence_number >= 1),

  agency text NOT NULL CHECK (agency IN ('RDSO', 'RITES')),

  status text NOT NULL DEFAULT 'requested' CHECK (
    status IN ('requested', 'scheduled', 'closed', 'cancelled')
  ),

  -- Legal dates, date-only, per engineering rule 6. These are dates
  -- printed on letters and certificates and they must not be
  -- timezone-round-tripped.
  requested_on date NOT NULL,

  -- The agency's own letter and its number. `RDSO/CALL/8821` belongs to
  -- RDSO's series, not ours, so it is recorded as typed and never
  -- generated.
  agency_call_number text CHECK (
    agency_call_number IS NULL
    OR (btrim(agency_call_number) = agency_call_number
        AND length(agency_call_number) BETWEEN 1 AND 100)
  ),
  call_letter_received_on date,

  certificate_number text CHECK (
    certificate_number IS NULL
    OR (btrim(certificate_number) = certificate_number
        AND length(certificate_number) BETWEEN 1 AND 100)
  ),
  certificate_date date,
  -- Optional. Most inspection certificates do not lapse; some carry a
  -- despatch window. NULL means "does not lapse", which the gate reads as
  -- live forever, and a date in the past makes the gate refuse again
  -- without anything having to be cancelled.
  certificate_valid_until date,

  vendor_premises text CHECK (
    vendor_premises IS NULL
    OR (btrim(vendor_premises) = vendor_premises
        AND length(vendor_premises) BETWEEN 1 AND 200)
  ),

  closed_at timestamptz,
  closed_by_user_id text,

  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancellation_reason text CHECK (
    cancellation_reason IS NULL
    OR (btrim(cancellation_reason) = cancellation_reason
        AND length(cancellation_reason) BETWEEN 1 AND 500)
  ),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_id, sequence_number),
  -- Three columns, so a call's coverage rows can prove in the database
  -- that their item belongs to the same Work as their call.
  UNIQUE (organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),

  -- A call is `scheduled` (or beyond) exactly when the inward letter has
  -- arrived, and the letter is its number and its date together.
  CONSTRAINT inspection_calls_inward_letter_shape_check CHECK (
    CASE
      WHEN status IN ('scheduled', 'closed')
        THEN agency_call_number IS NOT NULL AND call_letter_received_on IS NOT NULL
      ELSE true
    END
  ),
  CONSTRAINT inspection_calls_inward_letter_pairing_check CHECK (
    (agency_call_number IS NULL) = (call_letter_received_on IS NULL)
  ),

  -- THE CONSTRAINT THE DISPATCH GATE RESTS ON. `closed` means inspected
  -- and certified, so the gate can read `status` alone and does not have
  -- to re-derive the facts every time a challan is issued.
  CONSTRAINT inspection_calls_closed_shape_check CHECK (
    CASE
      WHEN status = 'closed'
        THEN certificate_number IS NOT NULL
          AND certificate_date IS NOT NULL
          AND closed_at IS NOT NULL
          AND closed_by_user_id IS NOT NULL
      -- A withdrawn certificate KEEPS the closure that produced it. The
      -- call really was closed, a challan may have been issued on the
      -- strength of it, and erasing `closed_at` on withdrawal would make
      -- that despatch unexplainable. So `cancelled` asserts nothing about
      -- these columns; the cancellation shape below is what it asserts.
      WHEN status = 'cancelled' THEN true
      ELSE closed_at IS NULL AND closed_by_user_id IS NULL
    END
  ),
  CONSTRAINT inspection_calls_certificate_pairing_check CHECK (
    (certificate_number IS NULL) = (certificate_date IS NULL)
  ),
  -- A window that closes before it opens is a typo. So, in practice, is
  -- one that runs for a century: five years is longer than any inspection
  -- certificate an Indian Railways contract issues, and the bound is what
  -- stops a mistyped year (2226 for 2026) from making an item permanently
  -- despatchable on one call.
  CONSTRAINT inspection_calls_certificate_window_check CHECK (
    certificate_valid_until IS NULL
    OR certificate_date IS NULL
    OR (certificate_valid_until >= certificate_date
        AND certificate_valid_until <= certificate_date + INTERVAL '5 years')
  ),

  CONSTRAINT inspection_calls_cancellation_shape_check CHECK (
    CASE
      WHEN status = 'cancelled'
        THEN cancelled_at IS NOT NULL
          AND cancelled_by_user_id IS NOT NULL
          AND cancellation_reason IS NOT NULL
      ELSE cancelled_at IS NULL
        AND cancelled_by_user_id IS NULL
        AND cancellation_reason IS NULL
    END
  ),

  -- A letter cannot come back before it went out, and a certificate cannot
  -- predate the inspection that produced it. The upper bound on the
  -- certificate date — not later than the organisation's today — is the
  -- route's, because a CHECK cannot see a clock it is allowed to trust.
  CONSTRAINT inspection_calls_date_order_check CHECK (
    (call_letter_received_on IS NULL OR call_letter_received_on >= requested_on)
    AND (certificate_date IS NULL OR certificate_date >= requested_on)
  )
);

COMMENT ON TABLE inspection_calls IS
  'One RDSO or RITES inspection call against a Work, from outward request to certificate. Also the job card: the documents and the certificate belong to the call.';
COMMENT ON COLUMN inspection_calls.sequence_number IS
  'Per-Work, gap-free, never reused. Claimed from inspection_call_counters by upsert, so concurrent raises cannot collide.';
COMMENT ON COLUMN inspection_calls.status IS
  'closed is the only state the dispatch gate accepts, and the closed shape CHECK is what makes it mean inspected-and-certified.';
COMMENT ON COLUMN inspection_calls.certificate_valid_until IS
  'Optional despatch window, bounded to five years past the certificate date so a mistyped year cannot unlock an item forever.';

-- The register's order: newest call of the organisation first, which is
-- how the Inspection workspace lists them.
CREATE INDEX inspection_calls_register_idx
  ON inspection_calls (organisation_id, created_at DESC, id);
CREATE INDEX inspection_calls_work_idx
  ON inspection_calls (organisation_id, work_id, sequence_number DESC);

ALTER TABLE inspection_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_calls FORCE ROW LEVEL SECURITY;

CREATE POLICY inspection_calls_tenant_policy ON inspection_calls
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. A call is correspondence with a government inspecting agency
-- and a challan may have been issued on the strength of its certificate;
-- it cancels with a reason and stays.
GRANT SELECT, INSERT, UPDATE ON inspection_calls TO auto_mb_app;

-- The state machine, in the database as well as in the route. The CHECKs
-- above police the SHAPE of a state; this polices the MOVE between states,
-- which no CHECK can see because a CHECK cannot read the old row — and it
-- polices the DOOR, because a row inserted straight into a terminal state
-- would otherwise skip every rule the moves enforce.
CREATE FUNCTION app_private.guard_inspection_call_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A call begins where a call begins. Inserting one already `closed`
    -- would hand the dispatch gate a certificate nobody uploaded, and
    -- inserting one already `cancelled` would mint a number for a record
    -- that never existed.
    IF NEW.status <> 'requested' THEN
      RAISE EXCEPTION
        'an inspection call is created as requested, not as %', NEW.status
        USING ERRCODE = '23C01';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    -- A terminal call is finished being edited. Without this, a closed
    -- call's certificate number or validity window could be rewritten
    -- after a challan was issued against it, which would make the
    -- despatch unexplainable. Withdrawing it is a STATE change and is
    -- handled below; editing it in place is not available at all.
    IF OLD.status IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION
        'inspection call % is % and cannot be edited', OLD.id, OLD.status
        USING ERRCODE = '23C02';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION
      'inspection call % is already cancelled and cannot change state', OLD.id
      USING ERRCODE = '23C02';
  END IF;

  -- requested -> scheduled -> closed, and any state -> cancelled.
  -- Anything else — a closed call reopened, a jump straight past the
  -- inward call letter — is refused.
  --
  -- CLOSED -> CANCELLED IS DELIBERATE AND IT IS THE INTERLOCK'S RELEASE
  -- VALVE. An agency does withdraw a certificate, and when it does the
  -- material behind it must stop being despatchable immediately. The gate
  -- reads `status = 'closed'`, so the withdrawal needs no second
  -- mechanism: cancelling puts every item the call covered straight back
  -- behind the wall. Challans ALREADY issued keep their snapshots and
  -- their numbers, because an issued document is a record of what was
  -- despatched and not a claim that is still true.
  IF NOT (
    (OLD.status = 'requested' AND NEW.status IN ('scheduled', 'cancelled'))
    OR (OLD.status = 'scheduled' AND NEW.status IN ('closed', 'cancelled'))
    OR (OLD.status = 'closed' AND NEW.status = 'cancelled')
  ) THEN
    RAISE EXCEPTION
      'inspection call % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23C01';
  END IF;

  -- Closing requires that every MANDATORY paper on the call's own
  -- checklist snapshot has a file behind it, and that the certificate is
  -- one of the files. The route says the same thing first, in a sentence
  -- naming what is missing; this is the layer that holds when a writer
  -- reaches the table another way.
  IF NEW.status = 'closed' THEN
    IF EXISTS (
      SELECT 1 FROM inspection_call_documents d
      WHERE d.inspection_call_id = NEW.id
        AND d.mandatory
        AND d.object_key IS NULL
    ) THEN
      RAISE EXCEPTION
        'inspection call % still has mandatory documents outstanding', NEW.id
        USING ERRCODE = '23C03';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM inspection_call_documents d
      WHERE d.inspection_call_id = NEW.id
        AND d.kind = 'certificate'
        AND d.object_key IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        'inspection call % cannot close without the inspection certificate', NEW.id
        USING ERRCODE = '23C03';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- The guard sorts alphabetically before the touch trigger, so a refused
-- transition raises before `updated_at` is touched (the 0003 ordering
-- note, and the shape 0014 and 0022 follow).
CREATE TRIGGER inspection_calls_guard_transition
BEFORE INSERT OR UPDATE ON inspection_calls
FOR EACH ROW EXECUTE FUNCTION app_private.guard_inspection_call_transition();

CREATE TRIGGER inspection_calls_touch_updated_at
BEFORE UPDATE ON inspection_calls
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 5. What the call covers, and how much of it.
--
-- A join table rather than a `work_item_id` on the call, because one
-- inspection visit certifies several items at once and the certificate
-- that comes back names all of them — and because a staged contract
-- offers the same item in lots, so the QUANTITY on this row is what the
-- dispatch gate adds up. Modelling coverage as a column on the call would
-- lose both facts.
-- ---------------------------------------------------------------------
CREATE TABLE inspection_call_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  inspection_call_id uuid NOT NULL,
  -- Carried, not derived, so the two foreign keys below can prove in the
  -- database that the item and the call belong to the SAME Work. Without
  -- it a call on Work A could claim coverage of Work B's item, and the
  -- gate would read a certificate that was never about this contract.
  work_id uuid NOT NULL,
  work_item_id uuid NOT NULL,

  -- The quantity offered under this call, and the figure the dispatch
  -- gate sums. A staged contract inspects in lots, so the same item
  -- legitimately appears on several calls.
  quantity quantity_amount NOT NULL CHECK (quantity > 0),

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, inspection_call_id, work_item_id),

  FOREIGN KEY (organisation_id, inspection_call_id, work_id)
    REFERENCES inspection_calls(organisation_id, id, work_id),
  FOREIGN KEY (organisation_id, work_item_id, work_id)
    REFERENCES work_items(organisation_id, id, work_id)
);

COMMENT ON TABLE inspection_call_items IS
  'Which work items one inspection call covers and in what quantity. The quantity is what the dispatch gate sums; the work_id is what ties call and item to one contract.';

-- The dispatch gate's read runs from the item to its calls, so it is
-- indexed that way — and this index leads on the (organisation, item,
-- work) foreign key, which the FK-coverage census requires. The second
-- index leads on the call-side key and is the read the register does.
CREATE INDEX inspection_call_items_item_idx
  ON inspection_call_items (organisation_id, work_item_id, work_id);
CREATE INDEX inspection_call_items_call_idx
  ON inspection_call_items (organisation_id, inspection_call_id, work_id);

ALTER TABLE inspection_call_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_call_items FORCE ROW LEVEL SECURITY;

CREATE POLICY inspection_call_items_tenant_policy ON inspection_call_items
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- DELETE is granted so an item can be taken off a call that has not yet
-- gone to the agency; the trigger below is what confines that to the open
-- states.
GRANT SELECT, INSERT, DELETE ON inspection_call_items TO auto_mb_app;

CREATE FUNCTION app_private.guard_inspection_call_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected uuid;
  call_status text;
BEGIN
  affected := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.inspection_call_id ELSE NEW.inspection_call_id END;

  -- One column, not the whole rowtype: this runs per affected row and the
  -- only fact it needs is the state.
  SELECT status INTO call_status FROM inspection_calls WHERE id = affected;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no inspection call %', affected
      USING ERRCODE = '23C06';
  END IF;

  -- The coverage of a call is settled before the agency is asked to come.
  -- Adding an item to a closed call would silently extend a certificate
  -- over material nobody inspected, which is the one thing the dispatch
  -- gate must never be told.
  IF call_status <> 'requested' THEN
    RAISE EXCEPTION
      'inspection call % is % and its item coverage is settled',
      affected, call_status
      USING ERRCODE = '23C04';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER inspection_call_items_guard_coverage
BEFORE INSERT OR DELETE ON inspection_call_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_inspection_call_item();

-- ---------------------------------------------------------------------
-- 6. The evidence.
--
-- One row per paper the call is held to. Rows are created EMPTY when the
-- call is raised — the checklist snapshot — and filled by upload, which is
-- why every file column is nullable and they are nullable together. An
-- empty row is a demand outstanding, and that is what the close gate
-- counts.
-- ---------------------------------------------------------------------
CREATE TABLE inspection_call_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  inspection_call_id uuid NOT NULL,

  -- Three kinds, because two of them gate a transition and the rest do
  -- not. `call_letter` is the agency's inward letter, `certificate` is the
  -- paper the dispatch gate exists for, and `evidence` is everything the
  -- checklist demanded — datasheets, undertakings, routine test reports,
  -- QAPs, calibration certificates.
  kind text NOT NULL CHECK (kind IN ('call_letter', 'certificate', 'evidence')),

  label text NOT NULL CHECK (
    btrim(label) = label AND length(label) BETWEEN 1 AND 200
  ),
  -- Copied from the checklist field at snapshot time. The close gate reads
  -- this row, never the template, so editing the template afterwards
  -- cannot change what a call in progress owes.
  mandatory boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),

  -- The stored PDF, on the same terms as every other uploaded document,
  -- and null together until it arrives. There is no media_type column:
  -- the upload path admits PDF alone and proves it from the bytes.
  object_key text,
  original_filename text CHECK (
    original_filename IS NULL
    OR length(btrim(original_filename)) BETWEEN 1 AND 255
  ),
  sha256 sha256_hex,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  uploaded_by_user_id text,
  uploaded_at timestamptz,

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, object_key),
  FOREIGN KEY (organisation_id, inspection_call_id)
    REFERENCES inspection_calls(organisation_id, id),

  -- Object keys are `<org>/<area>/<name>.<ext>` and the tenant prefix is
  -- checked here as well as in `packages/documents/src/storage.ts`, as
  -- 0003, 0066 and 0079 all do. Two layers, because a path is a filesystem
  -- escape.
  CONSTRAINT inspection_call_documents_object_key_tenant_prefix_check CHECK (
    object_key IS NULL OR object_key LIKE organisation_id::text || '/%'
  ),

  -- All of the file or none of it. A row holding a filename and no bytes
  -- would read as satisfied to the close gate and resolve to nothing when
  -- somebody clicked it.
  CONSTRAINT inspection_call_documents_file_shape_check CHECK (
    (object_key IS NULL AND original_filename IS NULL AND sha256 IS NULL
      AND size_bytes IS NULL
      AND uploaded_by_user_id IS NULL AND uploaded_at IS NULL)
    OR (object_key IS NOT NULL AND original_filename IS NOT NULL
      AND sha256 IS NOT NULL
      AND size_bytes IS NOT NULL AND uploaded_by_user_id IS NOT NULL
      AND uploaded_at IS NOT NULL)
  )
);

COMMENT ON TABLE inspection_call_documents IS
  'The papers one inspection call is held to. Created empty as the checklist snapshot and filled by upload; an empty mandatory row is what stops the call closing.';
COMMENT ON COLUMN inspection_call_documents.mandatory IS
  'Snapshot of the checklist field at call creation. Read here and never joined back to the template, so a later edit cannot move the goalposts on a call in progress.';

CREATE UNIQUE INDEX inspection_call_documents_object_key_unique
  ON inspection_call_documents (object_key)
  WHERE object_key IS NOT NULL;

-- One inward letter and one certificate per call. Both are singular facts
-- about the call — the second certificate is a second call — and the
-- close gate would otherwise have to decide which of two to believe.
CREATE UNIQUE INDEX inspection_call_documents_one_call_letter
  ON inspection_call_documents (inspection_call_id)
  WHERE kind = 'call_letter';
CREATE UNIQUE INDEX inspection_call_documents_one_certificate
  ON inspection_call_documents (inspection_call_id)
  WHERE kind = 'certificate';

-- The checklist reads in order, and the close gate scans for outstanding
-- mandatory rows.
CREATE INDEX inspection_call_documents_call_idx
  ON inspection_call_documents (organisation_id, inspection_call_id, position, id);

ALTER TABLE inspection_call_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_call_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY inspection_call_documents_tenant_policy ON inspection_call_documents
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- UPDATE fills or replaces the file while the call is open; the trigger
-- below confines it. No DELETE: a demand the checklist made is part of the
-- record of what the call was held to, even if it was never met.
GRANT SELECT, INSERT, UPDATE ON inspection_call_documents TO auto_mb_app;

CREATE FUNCTION app_private.guard_inspection_call_document()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  call_status text;
BEGIN
  SELECT status INTO call_status
  FROM inspection_calls
  WHERE id = NEW.inspection_call_id
    AND organisation_id = NEW.organisation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'no inspection call % in this organisation', NEW.inspection_call_id
      USING ERRCODE = '23C06';
  END IF;

  -- A terminal call's evidence is frozen. A challan may already have been
  -- issued against the certificate below; swapping the bytes afterwards
  -- would leave the despatch resting on a document that no longer exists.
  IF call_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION
      'inspection call % is % and its documents are frozen',
      NEW.inspection_call_id, call_status
      USING ERRCODE = '23C02';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Only the file may change. The demand itself — what paper this is and
    -- whether it was compulsory — is the snapshot, and a snapshot that can
    -- be edited is not one.
    IF NEW.inspection_call_id <> OLD.inspection_call_id
      OR NEW.kind <> OLD.kind
      OR NEW.label <> OLD.label
      OR NEW.mandatory <> OLD.mandatory
    THEN
      RAISE EXCEPTION
        'the checklist snapshot of inspection call % is immutable; only its file may be attached or replaced',
        OLD.inspection_call_id
        USING ERRCODE = '23C02';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER inspection_call_documents_guard_evidence
BEFORE INSERT OR UPDATE ON inspection_call_documents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_inspection_call_document();

-- ---------------------------------------------------------------------
-- 7. The dispatch interlock.
--
-- ONE definition, used by both layers. `routes/challans.ts` calls this
-- function inside the issue transaction, at the same altitude as the
-- delivery-ceiling check and under the same `work_items` row locks, and
-- turns its rows into a sentence naming the items. The trigger below
-- calls the SAME function on the row that would make the despatch real.
-- Two enforcement points, one arithmetic — which is the correction the
-- review demanded, because two copies of a quantity comparison are two
-- answers waiting to differ.
--
-- The comparison is CUMULATIVE and per item:
--
--     despatched  = this challan's line + every issued challan's lines
--     certified   = every live call's coverage of the item, same agency
--
-- and the item is blocked when despatched exceeds certified. Existence is
-- not enough: a single call for 10 units must not release 500.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.inspection_dispatch_shortfall(
  challan uuid,
  today date
)
RETURNS TABLE (
  item_number text,
  agency text,
  despatched quantity_amount,
  certified quantity_amount
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT wi.item_number,
         c.agency,
         moved.despatched,
         coalesce(cover.certified, 0)::quantity_amount
  FROM delivery_challan_items dci
  JOIN work_items wi ON wi.id = dci.work_item_id
  JOIN inspection_clauses c ON c.work_item_id = wi.id
  CROSS JOIN LATERAL (
    SELECT (dci.quantity + coalesce((
      SELECT sum(q.quantity)
      FROM delivery_challan_items q
      JOIN delivery_challans dc ON dc.id = q.delivery_challan_id
      WHERE q.work_item_id = dci.work_item_id
        AND q.work_item_id IS NOT NULL
        AND dc.status = 'issued'
        -- Excluded explicitly so the answer does not depend on whether
        -- the caller runs before or after the status moves.
        AND dc.id <> challan
    ), 0))::quantity_amount AS despatched
  ) moved
  CROSS JOIN LATERAL (
    SELECT sum(ici.quantity) AS certified
    FROM inspection_call_items ici
    JOIN inspection_calls ic ON ic.id = ici.inspection_call_id
    WHERE ici.work_item_id = wi.id
      -- Same contract, and same agency as the clause names. A RITES
      -- certificate does not answer an RDSO clause.
      AND ici.work_id = c.work_id
      AND ic.agency = c.agency
      AND app_private.inspection_certificate_live(
            ic.status, ic.certificate_valid_until, today)
  ) cover
  WHERE dci.delivery_challan_id = challan
    AND dci.work_item_id IS NOT NULL
    AND c.gates_dispatch
    AND moved.despatched > coalesce(cover.certified, 0)
  ORDER BY wi.item_number
$$;

COMMENT ON FUNCTION app_private.inspection_dispatch_shortfall(uuid, date) IS
  'Items on a challan whose cumulative despatch would exceed the quantity a live certificate of the clause''s own agency covers. Called by the issue route and by the backstop trigger, so both enforce one arithmetic.';

CREATE FUNCTION app_private.guard_delivery_challan_inspection_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  blocked text;
BEGIN
  -- The door AND the transition: an INSERT straight into `issued` skips
  -- every UPDATE guard there is, so it is covered here too.
  IF NEW.status <> 'issued' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'issued' THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(
           format('%s (%s: %s certified, %s despatched)',
                  s.item_number, s.agency, s.certified, s.despatched),
           ', ' ORDER BY s.item_number)
  INTO blocked
  FROM app_private.inspection_dispatch_shortfall(
         NEW.id, app_private.organisation_today(NEW.organisation_id)) s;

  IF blocked IS NOT NULL THEN
    RAISE EXCEPTION
      'inspection certificate missing for: %', blocked
      USING ERRCODE = '23C05';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER delivery_challans_guard_inspection_gate
BEFORE INSERT OR UPDATE ON delivery_challans
FOR EACH ROW EXECUTE FUNCTION app_private.guard_delivery_challan_inspection_gate();
