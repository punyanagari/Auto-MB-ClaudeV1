SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0111: the railway's own measurement, and the gate it holds.
--
-- Owner ruling, live-testing corrections item 17.
--
-- ---------------------------------------------------------------------
-- THE DOCUMENT, AND THE HOLE IT FILLS.
--
-- Migration 0066 modelled the end of the settlement chain: the railway's
-- On-Account Bill, which says the railway agreed and how much it owes.
-- What it did not model is the step BEFORE it. IWRCMS does not raise a
-- bill from thin air — it raises one from a MEASUREMENT its own system
-- holds, and the agency's finalized Measurement Book is only a claim
-- until that measurement is recorded on the railway's side and agrees
-- with it.
--
-- Between "we finalized our measurement" and "the railway billed us"
-- there was therefore nothing at all. A bill could be recorded against a
-- Measurement Book whose quantities the railway had never accepted, and
-- the first anyone would know is that the amounts did not reconcile.
-- Everything in 0066's chain — closure, and the `paid` gate that rests on
-- closure — was resting on an unverified middle.
--
-- This migration records that middle document and makes the chain refuse
-- to skip it:
--
--   finalized MB
--     -> railway measurement uploaded AND matched (or confirmed)   0111
--     -> received railway bill recorded                            0066
--     -> Measurement Book closed by that bill                      0066
--     -> the prepared bill may be marked paid                      0066
--
-- Each arrow is enforced twice, in the route and here.
--
-- ---------------------------------------------------------------------
-- MATCHED, MISMATCHED, UNREADABLE — and why the third is not a bypass.
--
-- The uploaded PDF is read with the same Poppler-only extraction every
-- other inbound document uses, and its line table is compared to the
-- Measurement Book's own stored lines: item by item, on the stage
-- quantities AND on the contractual remark. The comparison is done once,
-- at upload, and its per-line verdicts are stored — the same posture the
-- signature verdict takes, and for the same reason: the matcher moves,
-- and a re-read next year is a different statement from the one the
-- organisation relied on.
--
-- Extraction is not guaranteed. Some IWRCMS exports are scans, some carry
-- a text layer this product's parser cannot make a line table out of, and
-- refusing those outright would mean an agency holding a perfectly good
-- railway measurement could never record its bill. So `unreadable` is a
-- real outcome, and its exit is a RECORDED, LINE-BY-LINE CONFIRMATION:
-- for every line of the Measurement Book, a named member states that the
-- railway's document says the same thing. That is an act, not a waiver.
-- It costs one row per line, it names who did it and when, the audit
-- trail carries it, and the gate below counts the rows rather than
-- trusting a flag anybody could set.
--
-- What is deliberately NOT confirmable is a MISMATCH. A measurement the
-- parser read and found to disagree with the Measurement Book is not a
-- reading problem — it is a disagreement about quantities, and the remedy
-- is to correct the measurement or upload the right document, never to
-- click past it. The guard refuses the confirmation outright rather than
-- leaving the distinction to a route.
--
-- ---------------------------------------------------------------------
-- THE SPLIT BETWEEN THE TWO LAYERS, stated rather than implied.
--
-- 0066 § 3 drew this line and it is drawn the same way here. The database
-- enforces the STRUCTURAL half — that a measurement exists for this book,
-- belongs to this organisation, is not discarded, and either matched or
-- carries a confirmation for every line the book has. The MATCHING RULE
-- itself — what counts as an equal quantity, how a remark is compared,
-- how a line the measurement does not carry is described — lives once, in
-- `apps/server/src/railway-measurement-match.ts`, because it is a reading
-- of two documents rather than a fact about the schema, and a rule that
-- lives in two languages drifts between them.
--
-- ---------------------------------------------------------------------
-- SQLSTATEs: the 23R block, which this migration is the first to use.
-- (`I` and `O` are skipped in this schema's allocation because they read
-- as digits at a glance, and the one thing an operator does with a
-- SQLSTATE is read it aloud.)

-- ---------------------------------------------------------------------
-- 1. The measurement.
-- ---------------------------------------------------------------------
CREATE TABLE railway_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,

  -- The finalized Measurement Book this document is the railway's copy
  -- of. Enforced finalized by the route and by the closure the gate sits
  -- in front of; the column itself only says which book.
  measurement_book_id uuid NOT NULL,

  -- The stored PDF, on the same terms as every other inbound document
  -- (0066 § 1). The tenant prefix is checked here as well as in
  -- `storage.ts`, exactly as 0003 does for loa_documents: a path is a
  -- filesystem escape and one layer of checking is one bug from none.
  object_key text NOT NULL,
  original_filename text NOT NULL,
  sha256 sha256_hex NOT NULL,
  media_type text NOT NULL CHECK (media_type = 'application/pdf'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),

  -- What the reading found.
  --
  --   matched     every Measurement Book line has a line in this
  --               document with the same quantities and the same remark,
  --               and the document carries no line the book does not.
  --   mismatched  the document was read and it disagrees. Named per line
  --               in `line_verdicts`; not confirmable.
  --   unreadable  no line table could be extracted. The manual
  --               confirmation path below is this state's only exit.
  match_status text NOT NULL CHECK (
    match_status IN ('matched', 'mismatched', 'unreadable')
  ),

  -- One entry per line compared, in the Measurement Book's own order.
  -- Empty exactly when nothing could be read.
  line_verdicts jsonb NOT NULL CHECK (jsonb_typeof(line_verdicts) = 'array'),

  -- The whole extraction, kept as evidence of what was read and by what
  -- rules — 0066's reason, unchanged: the parser moves, and a re-read
  -- next year is a different statement from the one relied on.
  extraction_payload jsonb CHECK (
    extraction_payload IS NULL OR jsonb_typeof(extraction_payload) = 'object'
  ),

  uploaded_by_user_id text NOT NULL,

  -- A measurement attached to the wrong book has to have an exit, and
  -- there is no DELETE grant on this table. Discard is that exit: the row
  -- and its bytes stay, and the partial unique index below stops counting
  -- it.
  discarded_at timestamptz,
  discarded_by_user_id text,
  discard_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, object_key),

  FOREIGN KEY (organisation_id, work_id)
    REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, measurement_book_id)
    REFERENCES measurement_books(organisation_id, id),

  CONSTRAINT railway_measurements_object_key_tenant_prefix_check
    CHECK (object_key LIKE organisation_id::text || '/%'),

  -- An unreadable document has nothing extracted and nothing compared;
  -- a read one has both. The two halves cannot disagree.
  CONSTRAINT railway_measurements_reading_shape_check CHECK (
    (
      match_status = 'unreadable'
      AND extraction_payload IS NULL
      AND line_verdicts = '[]'::jsonb
    )
    OR
    (
      match_status <> 'unreadable'
      AND extraction_payload IS NOT NULL
      AND jsonb_array_length(line_verdicts) > 0
    )
  ),

  -- Discard travels as one fact: who, when, and optionally why. 0066's
  -- shape verbatim.
  CONSTRAINT railway_measurements_discard_shape_check CHECK (
    (
      discarded_at IS NULL
      AND discarded_by_user_id IS NULL
      AND discard_reason IS NULL
    )
    OR
    (
      discarded_at IS NOT NULL
      AND discarded_by_user_id IS NOT NULL
      AND (
        discard_reason IS NULL
        OR length(btrim(discard_reason)) BETWEEN 3 AND 500
      )
    )
  )
);

COMMENT ON TABLE railway_measurements IS
  'The railway''s own copy of a finalized Measurement Book, uploaded as a PDF and read against the book''s stored lines. The middle document of the settlement chain: no On-Account Bill may be recorded against a measurement the railway has not confirmed.';
COMMENT ON COLUMN railway_measurements.match_status IS
  'matched / mismatched / unreadable. The structural gate on received_railway_bills reads this column together with the confirmation count; the per-line rule that produced it lives in apps/server/src/railway-measurement-match.ts.';
COMMENT ON COLUMN railway_measurements.line_verdicts IS
  'One verdict per Measurement Book line, in the book''s order: the item number, whether it matched, and — when it did not — one sentence naming what differs. Stored rather than recomputed, because the matcher moves and a re-read is a different statement.';

-- One live measurement per Measurement Book. A second live one would mean
-- the link is wrong, and the gate would have two answers to believe.
CREATE UNIQUE INDEX railway_measurements_one_live_per_book
  ON railway_measurements (organisation_id, measurement_book_id)
  WHERE discarded_at IS NULL;

-- The Measurement Book foreign key's own index, NON-partial: a partial
-- index cannot serve a referential check, and the unique index above is
-- partial. The FK-index census measures exactly this.
CREATE INDEX railway_measurements_book_idx
  ON railway_measurements (organisation_id, measurement_book_id);

CREATE INDEX railway_measurements_work_idx
  ON railway_measurements (organisation_id, work_id, created_at DESC, id);

ALTER TABLE railway_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE railway_measurements FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY railway_measurements_tenant_policy ON railway_measurements
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- Evidence never leaves. Discard is the only exit, as for loa_documents
-- and received_railway_bills.
GRANT SELECT, INSERT, UPDATE ON railway_measurements TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 2. The manual confirmation, one row per line.
--
-- The fallback for an unreadable document, and the shape is what makes it
-- an act rather than a bypass: a member confirms ONE line at a time, each
-- confirmation names the line and its author, and the gate counts them
-- against the Measurement Book's own lines. There is no column anywhere
-- that says "confirmed" as a single fact, because a single fact is a
-- single click.
--
-- No UPDATE grant and no DELETE grant. A confirmation is a statement a
-- named person made; withdrawing it is discarding the measurement and
-- uploading another, which is the same posture every other piece of
-- evidence in this schema holds.
-- ---------------------------------------------------------------------
CREATE TABLE railway_measurement_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  railway_measurement_id uuid NOT NULL,

  -- The Measurement Book line this confirmation is about, by the item
  -- number the book prints. Not the line's uuid: an operator confirms
  -- what they can see on both documents, and the item number is the only
  -- identifier the railway's copy carries.
  item_number text NOT NULL CHECK (
    btrim(item_number) = item_number AND length(item_number) BETWEEN 1 AND 100
  ),

  confirmed_by_user_id text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- One confirmation per line. A second is the same statement twice.
  UNIQUE (organisation_id, railway_measurement_id, item_number),
  FOREIGN KEY (organisation_id, railway_measurement_id)
    REFERENCES railway_measurements(organisation_id, id)
);

COMMENT ON TABLE railway_measurement_confirmations IS
  'One member''s statement that one line of the Measurement Book reads the same on the railway''s document, for the case where the PDF could not be extracted. Counted by the gate on received_railway_bills; never summarised into a single flag.';

CREATE INDEX railway_measurement_confirmations_measurement_idx
  ON railway_measurement_confirmations (organisation_id, railway_measurement_id);

ALTER TABLE railway_measurement_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE railway_measurement_confirmations FORCE ROW LEVEL SECURITY;

CREATE POLICY railway_measurement_confirmations_tenant_policy
  ON railway_measurement_confirmations
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT ON railway_measurement_confirmations TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 3. The measurement's own guards.
--
-- Its bytes and everything read out of them are frozen: the point of
-- extracting a fact was that nobody gets to assert it. Discard is
-- terminal. The same posture `guard_received_railway_bill_update` takes,
-- with 0066's own words.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_railway_measurement_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'a discarded railway measurement is immutable'
      USING ERRCODE = '23R04';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.measurement_book_id,
    NEW.object_key, NEW.original_filename, NEW.sha256, NEW.media_type,
    NEW.size_bytes, NEW.match_status, NEW.line_verdicts,
    NEW.extraction_payload, NEW.uploaded_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.measurement_book_id,
    OLD.object_key, OLD.original_filename, OLD.sha256, OLD.media_type,
    OLD.size_bytes, OLD.match_status, OLD.line_verdicts,
    OLD.extraction_payload, OLD.uploaded_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'a railway measurement''s bytes and its reading are written once and never change'
      USING ERRCODE = '23R04';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_railway_measurement_update() IS
  'A railway measurement''s bytes, its extraction and its per-line verdicts are written once; discard is terminal. Re-reading a document is uploading it again, so that the reading a gate relied on stays exactly what it was.';

CREATE TRIGGER railway_measurements_immutability_guard
BEFORE UPDATE ON railway_measurements
FOR EACH ROW EXECUTE FUNCTION app_private.guard_railway_measurement_update();

CREATE TRIGGER railway_measurements_touch_updated_at
BEFORE UPDATE ON railway_measurements
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. What a confirmation may be about.
--
-- Three refusals, and each one closes a different way of turning the
-- fallback back into a bypass:
--
--   * the measurement was READ. A mismatch is a disagreement about
--     quantities, not a reading problem, and clicking past it would make
--     the whole match theatre. A `matched` one needs no confirmation at
--     all.
--   * the measurement is DISCARDED. Confirming a retired document is
--     confirming nothing.
--   * the line is not a line of the Measurement Book. A confirmation
--     against an invented item number would let the count be reached
--     without every real line being looked at, which is precisely the
--     property the gate depends on.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_railway_measurement_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  measurement railway_measurements%ROWTYPE;
BEGIN
  SELECT * INTO measurement FROM railway_measurements
  WHERE id = NEW.railway_measurement_id
    AND organisation_id = NEW.organisation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'no railway measurement % in this organisation', NEW.railway_measurement_id
      USING ERRCODE = '23R05';
  END IF;

  IF measurement.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION
      'railway measurement % is discarded and cannot be confirmed', measurement.id
      USING ERRCODE = '23R05';
  END IF;

  IF measurement.match_status <> 'unreadable' THEN
    RAISE EXCEPTION
      'railway measurement % was read (%); its lines are matched by the reading, not confirmed by hand',
      measurement.id, measurement.match_status
      USING ERRCODE = '23R05';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM measurement_book_lines l
    WHERE l.organisation_id = NEW.organisation_id
      AND l.measurement_book_id = measurement.measurement_book_id
      AND l.item_number = NEW.item_number
  ) THEN
    RAISE EXCEPTION
      'item % is not a line of the Measurement Book this measurement is about',
      NEW.item_number
      USING ERRCODE = '23R06';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_railway_measurement_confirmation() IS
  'A manual confirmation is only ever about a real line of the Measurement Book, on a live measurement the parser could not read. A mismatch is a disagreement about quantities and is not confirmable.';

CREATE TRIGGER railway_measurement_confirmations_guard
BEFORE INSERT ON railway_measurement_confirmations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_railway_measurement_confirmation();

-- ---------------------------------------------------------------------
-- 5. THE GATE.
--
-- A received railway bill records against a Measurement Book only if that
-- book's railway measurement is uploaded and either matched or confirmed
-- line by line. The route refuses first, under no lock, so an operator
-- gets a named 409 with a remedy; this is the arm that holds under
-- concurrency and against a writer that arrives another way.
--
-- INSERT only, and that is not an oversight. 0066 froze
-- `received_railway_bills.measurement_book_id` in
-- `guard_received_railway_bill_update`, so the book a bill settles cannot
-- change after it is written — there is no UPDATE that could move a bill
-- onto an ungated measurement. An UPDATE arm here would be a rule with no
-- reachable violation, watching a door that is welded shut.
--
-- It composes with 0066 § 4 rather than replacing it: that guard says a
-- bill cannot be marked PAID until its book is CLOSED, and closure needs
-- a verified bill. This one says the bill cannot be recorded at all until
-- the measurement behind it agrees. The two are the same chain read from
-- both ends, and neither subsumes the other.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_railway_bill_needs_measurement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  measurement railway_measurements%ROWTYPE;
  unconfirmed text;
BEGIN
  SELECT * INTO measurement FROM railway_measurements
  WHERE organisation_id = NEW.organisation_id
    AND measurement_book_id = NEW.measurement_book_id
    AND discarded_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Measurement Book % has no railway measurement on record, so no On-Account Bill can be recorded against it',
      NEW.measurement_book_id
      USING ERRCODE = '23R01';
  END IF;

  IF measurement.match_status = 'mismatched' THEN
    RAISE EXCEPTION
      'the railway measurement for Measurement Book % disagrees with it, so no On-Account Bill can be recorded against it',
      NEW.measurement_book_id
      USING ERRCODE = '23R02';
  END IF;

  IF measurement.match_status = 'unreadable' THEN
    -- Every line of the book, or none of it. `string_agg` over the
    -- shortfall rather than a bare count, so the refusal names the lines
    -- somebody still has to look at instead of a number they then have to
    -- go and find.
    SELECT string_agg(l.item_number, ', ' ORDER BY l.item_number)
      INTO unconfirmed
    FROM measurement_book_lines l
    WHERE l.organisation_id = NEW.organisation_id
      AND l.measurement_book_id = NEW.measurement_book_id
      AND NOT EXISTS (
        SELECT 1 FROM railway_measurement_confirmations c
        WHERE c.organisation_id = NEW.organisation_id
          AND c.railway_measurement_id = measurement.id
          AND c.item_number = l.item_number
      );

    IF unconfirmed IS NOT NULL THEN
      RAISE EXCEPTION
        'the railway measurement for Measurement Book % could not be read and these lines are not confirmed yet: %',
        NEW.measurement_book_id, unconfirmed
        USING ERRCODE = '23R03';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_railway_bill_needs_measurement() IS
  'The structural half of item 17''s gate: an On-Account Bill records against a Measurement Book only when that book''s railway measurement is on file and either matched by the reading or confirmed line by line. Composes with 0066''s paid-needs-closed-book guard, which holds the far end of the same chain.';

CREATE TRIGGER received_railway_bills_needs_measurement_guard
BEFORE INSERT ON received_railway_bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_railway_bill_needs_measurement();
