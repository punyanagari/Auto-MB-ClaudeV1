SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0086: the correspondence register.
--
-- NUMBERING. 0084 and 0085 belong to packs landing beside this one, and
-- 0081 has been a permanent gap since Wave 3. The series is allocated by
-- the coordinator rather than being contiguous; a gap is never reused,
-- because a number that has been quoted in a pull request must keep
-- meaning the same file.
--
-- WHAT THIS IS. A works contractor's contract is executed as much on
-- paper as on site. Approval of makes, submission of datasheets, a
-- clarification the railway asked for, a reply to it, an invitation to
-- re-quote — each one is a numbered letter that goes out or comes in, and
-- the trade keeps them in an inward/outward register because a letter
-- nobody can produce is a letter that was never sent. Today this product
-- models the Work, the goods, the money and the certificates, and models
-- none of the letters. They live in the same laptop folder 0079 was
-- written about.
--
-- WHAT IS DELIBERATELY NOT HERE, and this is most of the migration:
--
--   * NO extension-request letters. `extension_requests` (0011, 0029) is
--     already the extension-of-time letter register: it numbers the
--     letter, holds the reason and the addressee, renders the outward
--     PDF, stores the railway's reply, and moves the Work's completion
--     date when the reply arrives. The correspondence screen READS that
--     table for its "Extension requests" tab. There is no
--     `extension_request_id` column here and no extension row is ever
--     written into this table: two registers for one letter is how the
--     two disagree.
--
--   * NO inspection call letters. 0082 already holds both halves — the
--     outward call request as `inspection_calls.sequence_number` (the
--     route renders it `INS/<work>/<n>`), and the agency's inward call
--     letter as `agency_call_number` + `call_letter_received_on` with the
--     scan in `inspection_call_documents` of kind `call_letter`. Same
--     rule, same reason: the correspondence screen reads them.
--
--   * NO draft state. Every row here is a letter that has been dispatched
--     or has arrived, which is why `letter_number` is NOT NULL. A draft
--     would need a screen to reopen it on, and the design contract draws
--     no correspondence detail route to put one on; a draft nobody can
--     finish is a row that rots.
--
--   * NO approval or amendment workflow. A letter is not an issued
--     statutory document: it carries no money, no quantity and no tax. It
--     can be CANCELLED with a reason — a misrecorded letter would
--     otherwise be permanent, since the application role holds no DELETE
--     — and the number it took is retained forever.
--
--   * NO rendered-PDF storage for outward letters. The outward letter's
--     content is frozen at insert by the update guard below, so the PDF
--     is a pure function of columns that cannot change and is rendered on
--     demand. Storing it would buy byte-stability this product does not
--     need and cost an object, a hash, an orphan-cleanup path and an
--     export bucket. The INWARD scan is stored, because that one is
--     evidence we did not author and cannot reproduce.
--
-- WHY ONE TABLE. Outward and inward letters share their whole identity —
-- number, date, subject, counterparty, Work, and the thread pointer that
-- makes a reply a reply. They differ in four optional columns, each
-- constrained to its direction below. Two tables would duplicate the
-- shared half and make the thread pointer a polymorphic reference into
-- one of two places, which is the shape that cannot be a foreign key.

-- ---------------------------------------------------------------------
-- 1. The numbering counters.
--
-- Two independent series per organisation, restarting each Indian
-- financial year: OUT/<yy-yy>/<nnn> and IN/<yy-yy>/<nnn>. Organisation-
-- scoped rather than Work-scoped, because the register is read across
-- Works and a letter need not belong to one at all — an invitation to
-- quote arrives before there is a Work to file it under.
--
-- The inward series is OURS even though the letter is theirs. What the
-- sender printed on their own paper is kept verbatim in
-- `sender_reference`; the inward number is the register's own handle, the
-- way an inward register in a railway office stamps a serial on arrival.
-- ---------------------------------------------------------------------
CREATE TABLE correspondence_letter_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  direction text NOT NULL CHECK (direction IN ('outward', 'inward')),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, direction, fy_label)
);

COMMENT ON TABLE correspondence_letter_counters IS
  'Gap-free letter serials, one series per direction per financial year. Claimed by the upsert-returning pattern, so a rolled-back registration rolls its number back with it.';
COMMENT ON COLUMN correspondence_letter_counters.fy_label IS
  'The full April-to-March label, 2026-27. The rendered number abbreviates it to 26-27; the counter keys on the unambiguous form.';

ALTER TABLE correspondence_letter_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE correspondence_letter_counters FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the
-- planner treats it as an InitPlan and evaluates it once per statement
-- rather than once per row.
CREATE POLICY correspondence_letter_counters_tenant_policy
  ON correspondence_letter_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE ON correspondence_letter_counters TO auto_mb_app;

CREATE TRIGGER correspondence_letter_counters_guard_decrease
BEFORE UPDATE ON correspondence_letter_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- ---------------------------------------------------------------------
-- 2. The letters.
-- ---------------------------------------------------------------------
CREATE TABLE correspondence_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- Nullable on purpose: "General correspondence" is a real filing, and
  -- an invitation to quote arrives before the Work exists. MATCH SIMPLE
  -- (the default) leaves the composite unchecked when work_id is NULL,
  -- which is the behaviour wanted here.
  work_id uuid,

  direction text NOT NULL CHECK (direction IN ('outward', 'inward')),

  -- Allocated at registration; there is no draft state, so it is never
  -- null and never changes. A cancelled letter keeps it forever.
  letter_number text NOT NULL CHECK (
    btrim(letter_number) = letter_number
    AND length(letter_number) BETWEEN 1 AND 40
  ),
  financial_year text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),

  -- The date the register is about: the day an outward letter was
  -- dispatched, or the day an inward letter arrived. Date-only per
  -- engineering rule 6 — these are legal dates on paper and must not be
  -- timezone-round-tripped.
  letter_date date NOT NULL,

  subject text NOT NULL CHECK (
    btrim(subject) = subject
    AND length(subject) BETWEEN 2 AND 200
  ),

  -- A SNAPSHOT of the contact's designation as it read when the letter
  -- was filed, not a foreign key to `contacts`. Rule 7: a master-data
  -- edit never rewrites history, and "Sr. DSTE/MMCT" being renamed next
  -- year must not silently readdress a letter that went out last year.
  -- The route resolves the caller's chosen contact and copies the name;
  -- no `contact_id` column exists because nothing would read it.
  counterparty_name text NOT NULL CHECK (
    btrim(counterparty_name) = counterparty_name
    AND length(counterparty_name) BETWEEN 1 AND 200
  ),

  -- OUTWARD ONLY. What the letter says. Frozen by the guard below, which
  -- is what lets the PDF be rendered on demand instead of stored.
  body text CHECK (body IS NULL OR length(btrim(body)) BETWEEN 2 AND 20000),

  -- INWARD ONLY. What the sender printed on their own paper, verbatim,
  -- and the date they put on it. Neither is generated and neither is
  -- validated beyond length: the series is theirs.
  sender_reference text CHECK (
    sender_reference IS NULL
    OR length(btrim(sender_reference)) BETWEEN 1 AND 100
  ),
  sender_letter_date date,

  -- INWARD ONLY. When a reply is owed. Optional, because most letters
  -- ask for nothing.
  response_due_on date,

  -- The thread. A reply points at the letter it answers, in either
  -- direction: our reply to their clarification, and their reply to ours,
  -- are the same relationship read from two ends.
  reply_to_letter_id uuid,

  -- INWARD ONLY. The scanned paper, on the same terms as every other
  -- uploaded document. All four columns move together or none does.
  scan_object_key text,
  scan_original_filename text CHECK (
    scan_original_filename IS NULL
    OR length(btrim(scan_original_filename)) BETWEEN 1 AND 255
  ),
  scan_sha256 sha256_hex,
  scan_size_bytes bigint CHECK (scan_size_bytes IS NULL OR scan_size_bytes > 0),

  -- Cancel, never delete. The row and its number survive so the series
  -- stays provably gap-free; the application role holds no DELETE.
  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancellation_reason text CHECK (
    cancellation_reason IS NULL
    OR length(btrim(cancellation_reason)) BETWEEN 3 AND 500
  ),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- The tenant-composite key the self-reference below points at, and the
  -- leading index the organisations foreign key and the tenant predicate
  -- both use.
  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),

  -- A thread may only run inside one organisation. The composite is what
  -- makes that structural rather than a hope: a bare
  -- `REFERENCES correspondence_letters(id)` would happily point across
  -- the tenant boundary, and RLS would not see it because the write
  -- names only an id.
  FOREIGN KEY (organisation_id, reply_to_letter_id)
    REFERENCES correspondence_letters(organisation_id, id),

  CONSTRAINT correspondence_letters_no_self_reply_check
    CHECK (reply_to_letter_id IS NULL OR reply_to_letter_id <> id),

  -- The direction shapes, said once each.
  --
  -- An outward letter is one we wrote: it has a body and no scan, and it
  -- carries none of the sender's facts. An inward letter is one that
  -- arrived: it has the scan and no body. The scan is REQUIRED, not
  -- optional as the mock's form leaves it — an inward register whose rows
  -- may lack the paper is the laptop folder this module replaces.
  CONSTRAINT correspondence_letters_outward_shape_check CHECK (
    direction <> 'outward'
    OR (
      body IS NOT NULL
      AND sender_reference IS NULL
      AND sender_letter_date IS NULL
      AND response_due_on IS NULL
      AND scan_object_key IS NULL
      AND scan_original_filename IS NULL
      AND scan_sha256 IS NULL
      AND scan_size_bytes IS NULL
    )
  ),
  CONSTRAINT correspondence_letters_inward_shape_check CHECK (
    direction <> 'inward'
    OR (
      body IS NULL
      AND scan_object_key IS NOT NULL
      AND scan_original_filename IS NOT NULL
      AND scan_sha256 IS NOT NULL
      AND scan_size_bytes IS NOT NULL
    )
  ),

  -- Object keys are `<org>/<area>/<name>.<ext>` and the tenant prefix is
  -- checked here as well as in `packages/documents/src/storage.ts`,
  -- exactly as 0003 does for loa_documents and 0079 for company document
  -- versions. Two layers, because a path is a filesystem escape.
  CONSTRAINT correspondence_letters_scan_key_tenant_prefix_check
    CHECK (scan_object_key IS NULL OR scan_object_key LIKE organisation_id::text || '/%'),

  CONSTRAINT correspondence_letters_cancel_shape_check CHECK (
    (cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_reason IS NULL)
    OR (cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
        AND cancellation_reason IS NOT NULL)
  ),

  -- A reply cannot be owed before the letter that asks for it arrived.
  CONSTRAINT correspondence_letters_response_due_order_check CHECK (
    response_due_on IS NULL OR response_due_on >= letter_date
  ),

  -- A sender does not date their letter after we received it.
  CONSTRAINT correspondence_letters_sender_date_order_check CHECK (
    sender_letter_date IS NULL OR sender_letter_date <= letter_date
  )
);

COMMENT ON TABLE correspondence_letters IS
  'The inward/outward letters register. Extension-of-time letters live in extension_requests and inspection call letters in inspection_calls; neither is duplicated here.';
COMMENT ON COLUMN correspondence_letters.counterparty_name IS
  'Snapshot of the contact designation at filing time, not a foreign key: renaming a railway office must not readdress last year''s letters.';
COMMENT ON COLUMN correspondence_letters.sender_reference IS
  'The inward letter''s own number, as the sender printed it. Never generated — that series belongs to them.';
COMMENT ON COLUMN correspondence_letters.body IS
  'Outward only, and immutable once written. The dispatched PDF is rendered from it on demand rather than stored, which is only sound because the guard below freezes it.';
COMMENT ON COLUMN correspondence_letters.cancelled_at IS
  'A misrecorded letter is cancelled with a reason and keeps its number forever. There is no DELETE grant, so the series cannot develop a hole.';

-- The number is the operator-facing identity and must be unique. The
-- sequence is unique separately, which is what makes gap-freeness
-- PROVABLE rather than merely intended: without it a repaired counter or
-- a changed prefix could mint two different strings from serial 7.
CREATE UNIQUE INDEX correspondence_letters_number_unique
  ON correspondence_letters (organisation_id, letter_number);
CREATE UNIQUE INDEX correspondence_letters_sequence_unique
  ON correspondence_letters (organisation_id, direction, financial_year, sequence_number);

CREATE UNIQUE INDEX correspondence_letters_scan_key_unique
  ON correspondence_letters (scan_object_key)
  WHERE scan_object_key IS NOT NULL;

-- The register's own read: one direction, newest first, keyset-paged by
-- (letter_date, id). This is the only index the module adds, and it
-- matches that ORDER BY exactly.
CREATE INDEX correspondence_letters_register_idx
  ON correspondence_letters (organisation_id, direction, letter_date DESC, id DESC);

-- The thread lookup: "has this letter been replied to" runs once per
-- rendered row, so the pointer is indexed from the side that is read. Not
-- partial, deliberately: it is also the index the self-referencing
-- foreign key needs, and `test/fk-index-coverage` measures a key as
-- covered only by an index that leads on its columns unconditionally.
CREATE INDEX correspondence_letters_reply_to_idx
  ON correspondence_letters (organisation_id, reply_to_letter_id);

-- The Work foreign key's index, and the one the Work timeline's scoping
-- subselect reads.
CREATE INDEX correspondence_letters_work_idx
  ON correspondence_letters (organisation_id, work_id);

ALTER TABLE correspondence_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE correspondence_letters FORCE ROW LEVEL SECURITY;

CREATE POLICY correspondence_letters_tenant_policy ON correspondence_letters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- UPDATE exists for exactly one act — cancellation — and the guard below
-- narrows it to that. No DELETE at all.
GRANT SELECT, INSERT, UPDATE ON correspondence_letters TO auto_mb_app;

-- Guards sort alphabetically before `…_touch_updated_at`, so a refused
-- write raises before `updated_at` moves.
--
-- `search_path` is pinned for the reason 0067, 0077 and 0079 pin theirs:
-- a trigger function resolves its own identifiers, and leaving that to
-- the caller's search_path is how a shadowing object in a writable schema
-- turns a guard into whatever it wants. Not SECURITY DEFINER — the guard
-- reads only the row it is handed.
CREATE FUNCTION app_private.guard_correspondence_letter_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Everything except the cancellation triple is frozen. This is one
  -- comparison rather than a column-by-column list on purpose: a column
  -- added later is immutable by default, which is the safe direction to
  -- fail in for a register whose whole value is that it says what was
  -- actually sent.
  IF ROW(
       NEW.organisation_id, NEW.work_id, NEW.direction, NEW.letter_number,
       NEW.financial_year, NEW.sequence_number, NEW.letter_date, NEW.subject,
       NEW.counterparty_name, NEW.body, NEW.sender_reference,
       NEW.sender_letter_date, NEW.response_due_on, NEW.reply_to_letter_id,
       NEW.scan_object_key, NEW.scan_original_filename, NEW.scan_sha256,
       NEW.scan_size_bytes, NEW.created_by_user_id, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.organisation_id, OLD.work_id, OLD.direction, OLD.letter_number,
       OLD.financial_year, OLD.sequence_number, OLD.letter_date, OLD.subject,
       OLD.counterparty_name, OLD.body, OLD.sender_reference,
       OLD.sender_letter_date, OLD.response_due_on, OLD.reply_to_letter_id,
       OLD.scan_object_key, OLD.scan_original_filename, OLD.scan_sha256,
       OLD.scan_size_bytes, OLD.created_by_user_id, OLD.created_at
     )
  THEN
    RAISE EXCEPTION
      'a registered letter is immutable; cancel it and file the correct one'
      USING ERRCODE = '23E01';
  END IF;

  -- Un-cancelling would resurrect a letter two readers already disagree
  -- about, and the number is not released by cancellation, so there is
  -- nothing to reclaim by going back.
  IF OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NULL THEN
    RAISE EXCEPTION
      'a cancelled letter cannot be reinstated; file the correct letter instead'
      USING ERRCODE = '23E02';
  END IF;

  -- And once written, the cancellation is as frozen as everything else.
  -- The comparison above deliberately excludes the triple so that the ONE
  -- legal update can write it; without this, that exemption would stay
  -- open forever and the reason, the actor and the moment of a
  -- cancellation could all be rewritten afterwards — on a record whose
  -- whole purpose is to explain why a retained number stands for nothing.
  -- The route's own re-cancel refusal is the first layer; this is the one
  -- that holds against a writer that never went through it.
  IF OLD.cancelled_at IS NOT NULL
     AND ROW(NEW.cancelled_at, NEW.cancelled_by_user_id, NEW.cancellation_reason)
         IS DISTINCT FROM
         ROW(OLD.cancelled_at, OLD.cancelled_by_user_id, OLD.cancellation_reason)
  THEN
    RAISE EXCEPTION
      'a letter''s cancellation is immutable once recorded'
      USING ERRCODE = '23E01';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER correspondence_letters_guard_update
BEFORE UPDATE ON correspondence_letters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_correspondence_letter_update();

-- A thread may not point at a cancelled letter, and a letter may not be
-- cancelled out from under a reply that already cites it. Both halves are
-- the same rule read from the two ends, so they live in one function.
--
-- FOR SHARE on the parent, not a bare read, for the reason 0079 states:
-- under READ COMMITTED a plain SELECT sees the parent as it stood when
-- the statement began, so a cancellation committing between the read and
-- this INSERT would be invisible and the reply would land on it anyway.
CREATE FUNCTION app_private.guard_correspondence_letter_thread()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_cancelled_at timestamptz;
  live_reply_count integer;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.reply_to_letter_id IS NOT NULL THEN
    SELECT cancelled_at INTO parent_cancelled_at
    FROM correspondence_letters
    WHERE id = NEW.reply_to_letter_id
      AND organisation_id = NEW.organisation_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'no letter % in this organisation to reply to', NEW.reply_to_letter_id
        USING ERRCODE = '23E03';
    END IF;

    IF parent_cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION
        'letter % was cancelled and cannot be answered', NEW.reply_to_letter_id
        USING ERRCODE = '23E04';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL
  THEN
    SELECT count(*) INTO live_reply_count
    FROM correspondence_letters
    WHERE reply_to_letter_id = NEW.id
      AND organisation_id = NEW.organisation_id
      AND cancelled_at IS NULL;

    IF live_reply_count > 0 THEN
      RAISE EXCEPTION
        'letter % has been answered and cannot be cancelled; cancel the reply first',
        NEW.letter_number
        USING ERRCODE = '23E05';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER correspondence_letters_guard_thread
BEFORE INSERT OR UPDATE ON correspondence_letters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_correspondence_letter_thread();

CREATE TRIGGER correspondence_letters_touch_updated_at
BEFORE UPDATE ON correspondence_letters
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
