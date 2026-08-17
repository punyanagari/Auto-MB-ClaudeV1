SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0083: the tender pipeline — everything BEFORE the award.
--
-- NUMBERING. This migration follows 0082 with a gap at 0081, and the gap
-- is permanent. The wave allocated 0078 to masters, 0079 to the company
-- document library, 0080 and 0081 to payments, 0082 to inspection and
-- 0083 here; payments shipped only 0080, so 0081 was reserved and used by
-- nothing. It stays empty rather than being backfilled by whoever comes
-- next, because a number that has been handed out is spent.
--
-- The series is allocated, not contiguous, and it has been since 0066,
-- which likewise took a number ahead of migrations that merged after it.
-- A gap is the cheap outcome; two packs writing the same number is the
-- expensive one, and a renumber after a migration has been applied
-- anywhere is refused by the runner's checksum. Nothing here depends on
-- 0080-0082, and this file applies with or without them.
--
-- Every table in this schema so far describes a contract the agency
-- already holds. The work that decides whether it holds one at all is
-- invisible to the product: a Notice Inviting Tender arrives, somebody
-- reads the closing date off it, somebody else assembles thirty
-- credentials into a bid package, the package is uploaded to iREPS, and
-- weeks later the answer comes back. Today that lives in a spreadsheet,
-- and the two things it gets wrong are the two things that lose bids: a
-- deadline nobody watched, and a certificate that had lapsed by the day
-- the bid was opened.
--
-- So this is the pre-award half of the ledger. It is organisation-level
-- by definition: a tender belongs to no Work, because the Work is what
-- winning it produces.
--
-- WHY FOUR TABLES.
--
--   * `tender_notices` is the NIT PDF and the machine's PROPOSAL about
--     what it says. It is never authoritative (engineering rule 10), and
--     it is a table of its own for the same reason `loa_documents` is:
--     the proposal has to exist, be readable, and be reviewable BEFORE
--     anything authoritative is written, and it survives the confirmation
--     as the evidence the confirmed record was derived from.
--   * `tenders` is the confirmed record — the identity, the deadline and
--     the money, as a human accepted them.
--   * `tender_checklist_items` is the bid package: one row per document
--     the tender demands, each optionally pointing at a credential in the
--     company document library (migration 0079). The point of the pointer
--     is the validity question — see below.
--   * `tender_status_events` is the trail. `tenders.status` says where a
--     bid stands now; the trail says when it got there and who said so,
--     which is the whole of what "iREPS tracking" can honestly be.
--
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * No iREPS integration, and no column that could be mistaken for
--     one. iREPS has no public API; the portal is driven by a human with
--     a CAPTCHA, an OTP and a local DSC. Everything here is a record of
--     what a human did on that portal, entered by that human. There is a
--     free-text `ireps_reference` for the acknowledgement number the
--     portal prints, and that is the entire extent of the coupling. The
--     screens say so in words.
--   * No validity STATUS column on a checklist row. Whether an attached
--     certificate is valid is a question about a date — the tender's
--     closing date — against another date on the credential's newest
--     version. Both are stored; the answer is derived on read, exactly as
--     0079 derives its own expiry reading, and for the same reason: an
--     answer to a dated question is wrong the morning after it is
--     written.
--   * No awarded-Work column. An awarded tender points at the LOA that
--     awarded it (`award_loa_document_id`), and `loa_documents` already
--     points at the Work it was confirmed into. Storing the Work here as
--     well would be a second edge that can disagree with the first.
--   * No bid-document storage. A bid attaches credentials the library
--     already holds; it does not become a third place to keep files.

-- ---------------------------------------------------------------------
-- 1. The confirmed tender.
-- ---------------------------------------------------------------------
CREATE TABLE tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  tender_number text NOT NULL CHECK (
    btrim(tender_number) = tender_number
    AND length(tender_number) BETWEEN 1 AND 120
  ),
  -- The inviting body. Called "railway" on the tender documents of a
  -- railway tender and "authority" on everything else, which is why the
  -- column takes the general word and the screen prints the general
  -- label.
  authority text NOT NULL CHECK (
    btrim(authority) = authority
    AND length(authority) BETWEEN 1 AND 200
  ),
  title text NOT NULL CHECK (
    btrim(title) = title
    AND length(title) BETWEEN 3 AND 1000
  ),

  -- An INSTANT, not a legal date, and the one place in this schema where
  -- that distinction goes the other way from engineering rule 6. A
  -- railway tender closes at 15:00 on its closing day and a bid uploaded
  -- at 15:01 is not late by a rounding convention — it is rejected. The
  -- rule protects dates PRINTED on documents from being timezone-round-
  -- tripped into the wrong day; a closing moment is genuinely a moment,
  -- and storing it as a date would throw away the half of it that
  -- decides the outcome.
  bid_closes_at timestamptz NOT NULL,

  -- Both optional: an NIT states them, but a tender can be recorded from
  -- a corrigendum or a phone call before the figures are known.
  estimated_value money_amount CHECK (estimated_value IS NULL OR estimated_value >= 0),
  emd_amount money_amount CHECK (emd_amount IS NULL OR emd_amount >= 0),
  eligibility_summary text CHECK (
    eligibility_summary IS NULL OR length(eligibility_summary) BETWEEN 1 AND 2000
  ),

  -- The trail's current position. Constrained text rather than an enum
  -- type, on the same reasoning 0079 gives: a sixth position is one
  -- migration statement here and a type-level change there.
  --
  --   drafted    the bid is being assembled
  --   submitted  uploaded to iREPS by a human, who says so
  --   opened     the technical bid was opened
  --   awarded    won; the LOA follows
  --   lost       not won, or withdrawn
  status text NOT NULL DEFAULT 'drafted' CHECK (status IN (
    'drafted',
    'submitted',
    'opened',
    'awarded',
    'lost'
  )),

  -- What the portal printed back, typed in by the person who uploaded.
  -- Not a foreign key to anything; there is nothing to key it to.
  ireps_reference text CHECK (
    ireps_reference IS NULL
    OR (btrim(ireps_reference) = ireps_reference AND length(ireps_reference) BETWEEN 1 AND 120)
  ),

  -- The Letter of Acceptance this tender turned into. Set by the award
  -- conversion, which deep-links into the ordinary LOA intake rather
  -- than creating a Work by a second route; the Work itself is read
  -- through `loa_documents.confirmed_work_id`.
  award_loa_document_id uuid,

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, award_loa_document_id)
    REFERENCES loa_documents(organisation_id, id),

  -- One letter awards one tender. Without this, two tenders could both
  -- claim the same LOA and the Work would appear to have been won twice.
  UNIQUE (organisation_id, award_loa_document_id),

  -- An award letter only belongs to an awarded tender.
  CONSTRAINT tenders_award_shape_check CHECK (
    award_loa_document_id IS NULL OR status = 'awarded'
  )
);

COMMENT ON TABLE tenders IS
  'A tender the organisation is bidding for, or has bid for. Organisation-level: a tender belongs to no Work, because the Work is what winning it produces.';
COMMENT ON COLUMN tenders.bid_closes_at IS
  'The closing INSTANT, not a legal date: a railway tender closes at a stated time of day and a bid one minute late is rejected.';
COMMENT ON COLUMN tenders.ireps_reference IS
  'The acknowledgement the iREPS portal printed, typed in by the person who uploaded. iREPS has no API; nothing here is machine-verified.';
COMMENT ON COLUMN tenders.award_loa_document_id IS
  'The LOA that awarded this tender. The Work is reached through loa_documents.confirmed_work_id rather than stored again here.';

-- One tender number, one record. Case-folded, because a tender number
-- retyped in a different case is the same tender to everyone but a byte
-- comparison.
CREATE UNIQUE INDEX tenders_number_unique
  ON tenders (organisation_id, lower(tender_number));

-- The register's own order: the whole pipeline of one organisation, by
-- closing moment, soonest first.
CREATE INDEX tenders_register_idx
  ON tenders (organisation_id, bid_closes_at, id);

ALTER TABLE tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenders FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the
-- planner treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY tenders_tenant_policy ON tenders
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- UPDATE is for the status trail, the award link, and correcting the
-- facts of a tender that has not been submitted. DELETE is not granted:
-- a tender that came to nothing is the answer to "why did we not bid",
-- and the trail is the record of it.
GRANT SELECT, INSERT, UPDATE ON tenders TO auto_mb_app;

CREATE TRIGGER tenders_touch_updated_at
BEFORE UPDATE ON tenders
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- The trail runs one way. Written as a trigger rather than as route code
-- because four routes can reach this column and a guard that lives in
-- one of them protects one of them.
-- `SET search_path` for the reason 0067, 0077 and 0079 all give: a
-- trigger function that resolves its own identifiers through the caller's
-- path is a guard that a shadowing object in a writable schema can
-- rewrite into whatever it likes.
CREATE FUNCTION app_private.guard_tender_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- awarded and lost are terminal. A tender that was lost and is now
  -- claimed to be awarded is a different tender, or a mistake; either
  -- way it is not an edit.
  IF OLD.status IN ('awarded', 'lost') THEN
    RAISE EXCEPTION
      'tender % is already %, which is final', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
    (OLD.status = 'drafted' AND NEW.status IN ('submitted', 'lost'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('opened', 'awarded', 'lost'))
    OR (OLD.status = 'opened' AND NEW.status IN ('awarded', 'lost'))
  ) THEN
    RAISE EXCEPTION
      'a tender cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER tenders_status_transition_guard
BEFORE UPDATE ON tenders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tender_status();

-- Provenance is a fact about an act that already happened, and the tenant
-- is not a property anything may edit: re-pointing `organisation_id`
-- would move a tender and its whole checklist into another organisation
-- in one statement, which RLS cannot catch because the row passes the
-- policy on the way out.
--
-- `tender_number` is here too, and it is the interesting one. The
-- facts-correction route deliberately DOES let a drafted tender's number
-- be fixed — a mistyped NIT number is the commonest correction there is —
-- so this guard cannot freeze it outright. What it freezes is changing it
-- after the bid has gone out, when the number is no longer a typo to fix
-- but the identity a submitted package was filed under.
CREATE FUNCTION app_private.guard_tender_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'a tender''s tenant and provenance are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'drafted'
     AND (
       NEW.tender_number IS DISTINCT FROM OLD.tender_number
       OR NEW.authority IS DISTINCT FROM OLD.authority
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.bid_closes_at IS DISTINCT FROM OLD.bid_closes_at
       OR NEW.estimated_value IS DISTINCT FROM OLD.estimated_value
       OR NEW.emd_amount IS DISTINCT FROM OLD.emd_amount
       OR NEW.eligibility_summary IS DISTINCT FROM OLD.eligibility_summary
     )
  THEN
    RAISE EXCEPTION
      'tender % is % and its facts can no longer be corrected', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER tenders_update_guard
BEFORE UPDATE ON tenders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tender_update();

-- ---------------------------------------------------------------------
-- 2. The NIT and what the machine read off it.
--
-- The propose-then-confirm holding row, modelled on `loa_documents`:
-- extraction writes a PROPOSAL here and nothing authoritative, and the
-- `tenders` row above exists only once a human has read the proposal and
-- said yes (engineering rule 10).
--
-- Unlike the LOA the reading is synchronous, because there is no item
-- table to parse — six labelled fields off the first page of a short
-- notice, which is a `pdftotext` run and a handful of regexes. There is
-- therefore no `pending`/`processing`: a notice is `review` or `failed`
-- by the time the upload responds, which is also what lets the intake
-- screen be the mock's two-card wizard rather than a poll.
-- ---------------------------------------------------------------------
CREATE TABLE tender_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  object_key text NOT NULL,
  original_filename text NOT NULL CHECK (
    length(btrim(original_filename)) BETWEEN 1 AND 255
  ),
  sha256 sha256_hex NOT NULL,
  media_type text NOT NULL CHECK (media_type = 'application/pdf'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),

  extraction_status text NOT NULL CHECK (extraction_status IN ('review', 'failed')),
  -- `{ sourceText, review }` on success, `{ error }` on failure. Proposal
  -- only: nothing downstream reads it as authority.
  extraction_payload jsonb NOT NULL,

  -- NULL until a human confirms the proposal into a tender.
  confirmed_tender_id uuid,

  uploaded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, object_key),

  FOREIGN KEY (organisation_id, confirmed_tender_id)
    REFERENCES tenders(organisation_id, id),

  -- One notice becomes one tender.
  UNIQUE (organisation_id, confirmed_tender_id),

  -- Object keys are `<org>/<area>/<name>.<ext>` and the tenant prefix is
  -- checked here as well as in `packages/documents/src/storage.ts`,
  -- exactly as 0003 does for loa_documents and 0079 for company document
  -- versions. Two layers, because a path is a filesystem escape.
  CONSTRAINT tender_notices_object_key_tenant_prefix_check
    CHECK (object_key LIKE organisation_id::text || '/%')

  -- Deliberately NO constraint tying confirmation to a successful
  -- reading. A photocopied notice with no text layer is still the notice:
  -- it is stored, it is flagged `failed`, and a human types the seven
  -- fields in and confirms it. Refusing that would leave the commonest
  -- real document with nowhere to go.
);

COMMENT ON TABLE tender_notices IS
  'An uploaded Notice Inviting Tender and the machine PROPOSAL read off it. Never authoritative: the tenders row is written only when a human confirms the proposal.';
COMMENT ON COLUMN tender_notices.extraction_payload IS
  'The proposal: { sourceText, review } on success, { error } on failure. Evidence for the confirmed tender, never a substitute for it.';

CREATE UNIQUE INDEX tender_notices_object_key_unique
  ON tender_notices (object_key);

-- ponytail: no index on the unconfirmed notices, because nothing reads
-- them. A notice abandoned between the upload and the confirmation is
-- inert — the intake screen holds its id while the operator is on it, and
-- the PDF is re-uploaded in seconds if they leave — so there is no
-- register listing them and therefore no query to index. Add both
-- together, or neither.

ALTER TABLE tender_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_notices FORCE ROW LEVEL SECURITY;

CREATE POLICY tender_notices_tenant_policy ON tender_notices
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- UPDATE is for stamping `confirmed_tender_id` and nothing else, which
-- the trigger below enforces. DELETE is not granted: the notice is the
-- evidence the tender was derived from.
GRANT SELECT, INSERT, UPDATE ON tender_notices TO auto_mb_app;

CREATE TRIGGER tender_notices_touch_updated_at
BEFORE UPDATE ON tender_notices
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- The stored bytes, the hash and the machine's reading of them are
-- evidence, and evidence does not get edited after the fact. The one
-- mutable column is the confirmation link, and it is one-way.
CREATE FUNCTION app_private.guard_tender_notice()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.extraction_status IS DISTINCT FROM OLD.extraction_status
     OR NEW.extraction_payload IS DISTINCT FROM OLD.extraction_payload
     OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'a tender notice and its extraction are immutable; upload the notice again instead'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.confirmed_tender_id IS NOT NULL
     AND NEW.confirmed_tender_id IS DISTINCT FROM OLD.confirmed_tender_id
  THEN
    RAISE EXCEPTION
      'tender notice % was already confirmed into tender %',
      OLD.id, OLD.confirmed_tender_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER tender_notices_evidence_guard
BEFORE UPDATE ON tender_notices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tender_notice();

-- ---------------------------------------------------------------------
-- 3. The bid checklist.
--
-- One row per document the tender demands. A row that points at a
-- company credential (migration 0079) is answerable: the library knows
-- the file, the version and the validity window, and this tender knows
-- the day the bid closes, so "will this certificate still be valid when
-- the bid is opened" is a join rather than somebody's memory.
--
-- A row with no credential attached is a demand nobody has answered yet.
-- That is the useful default, and it is why the pointer is nullable.
-- ---------------------------------------------------------------------
CREATE TABLE tender_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  tender_id uuid NOT NULL,

  title text NOT NULL CHECK (
    btrim(title) = title
    AND length(title) BETWEEN 1 AND 200
  ),
  -- The tender's own word. A mandatory line missing its document blocks
  -- the package; an optional one does not.
  mandatory boolean NOT NULL DEFAULT true,

  -- The library credential answering this line, if one has been
  -- attached. Composite so a checklist row can never reach a credential
  -- in another organisation.
  company_document_id uuid,
  attached_at timestamptz,
  attached_by_user_id text,

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, tender_id)
    REFERENCES tenders(organisation_id, id),
  FOREIGN KEY (organisation_id, company_document_id)
    REFERENCES company_documents(organisation_id, id),

  CONSTRAINT tender_checklist_items_attachment_shape_check CHECK (
    (company_document_id IS NULL AND attached_at IS NULL AND attached_by_user_id IS NULL)
    OR (company_document_id IS NOT NULL AND attached_at IS NOT NULL AND attached_by_user_id IS NOT NULL)
  )
);

COMMENT ON TABLE tender_checklist_items IS
  'One document the tender demands. An attached company_document_id makes the line answerable: the credential carries the validity window, this tender carries the closing date, and the reading is derived from the two.';
COMMENT ON COLUMN tender_checklist_items.company_document_id IS
  'The library credential answering this line (migration 0079). NULL means nobody has answered it yet, which is the useful default.';

-- One line per demand. Case-folded, for the same reason the tender
-- number is: "GST Registration" and "GST registration" are one demand.
CREATE UNIQUE INDEX tender_checklist_items_title_unique
  ON tender_checklist_items (organisation_id, tender_id, lower(title));

-- The checklist reads one tender's rows in creation order.
CREATE INDEX tender_checklist_items_tender_idx
  ON tender_checklist_items (organisation_id, tender_id, created_at, id);

-- "Which bids does renewing this certificate unblock" reads the other
-- way, and the composite FK above needs its own index either way. NOT
-- partial: `fk-index-coverage.integration.test.ts` asks every foreign key
-- for an index leading on its columns, and a partial one does not answer
-- a plain key lookup — the unanswered lines this would leave out are the
-- ones the FK's own delete-time check has to scan for.
CREATE INDEX tender_checklist_items_document_idx
  ON tender_checklist_items (organisation_id, company_document_id);

ALTER TABLE tender_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_checklist_items FORCE ROW LEVEL SECURITY;

CREATE POLICY tender_checklist_items_tenant_policy ON tender_checklist_items
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- DELETE IS granted here, and only here in this migration. A checklist
-- line is draft working material — the operator typing the tender's
-- requirements out of a PDF will mistype one — and `AGENTS.md` rule 8
-- lets drafts be deleted. The route refuses it once the bid has been
-- submitted, because from that moment the checklist is a record of what
-- was submitted rather than a list of what to assemble.
GRANT SELECT, INSERT, UPDATE, DELETE ON tender_checklist_items TO auto_mb_app;

CREATE TRIGGER tender_checklist_items_touch_updated_at
BEFORE UPDATE ON tender_checklist_items
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- A checklist line belongs to the tender it was created on and to the
-- organisation that created it. Moving either would carry an answered
-- line — and the credential behind it — onto a bid it was never assembled
-- for, which is the same class of defect as re-pointing the tenant and is
-- invisible to RLS for the same reason.
--
-- `attached_by_user_id` and `attached_at` are provenance of the ATTACH,
-- so they move only together with what they are provenance of: the route
-- writes all three in one statement and the shape CHECK already refuses
-- two of the three. What this adds is that they cannot be rewritten while
-- the credential stays the same, which would relabel who vouched for it.
CREATE FUNCTION app_private.guard_tender_checklist_item_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.tender_id IS DISTINCT FROM OLD.tender_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'a tender checklist line''s tender and provenance are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.company_document_id IS NOT DISTINCT FROM OLD.company_document_id
     AND (
       NEW.attached_at IS DISTINCT FROM OLD.attached_at
       OR NEW.attached_by_user_id IS DISTINCT FROM OLD.attached_by_user_id
     )
  THEN
    RAISE EXCEPTION
      'the attachment provenance of a tender checklist line moves only with its credential'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER tender_checklist_items_update_guard
BEFORE UPDATE ON tender_checklist_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tender_checklist_item_update();

-- ---------------------------------------------------------------------
-- 4. The status trail.
--
-- Append-only. `tenders.status` is where the bid stands; this is how it
-- got there, and it is the only honest form "iREPS submission tracking"
-- can take without a portal that will talk to us.
-- ---------------------------------------------------------------------
CREATE TABLE tender_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  tender_id uuid NOT NULL,

  -- NULL on the row written when the tender is created.
  from_status text CHECK (from_status IS NULL OR from_status IN (
    'drafted', 'submitted', 'opened', 'awarded', 'lost'
  )),
  to_status text NOT NULL CHECK (to_status IN (
    'drafted', 'submitted', 'opened', 'awarded', 'lost'
  )),
  -- What the operator said about it: the iREPS acknowledgement, the
  -- opening minutes, the reason a bid was not pursued.
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),

  actor_user_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, tender_id)
    REFERENCES tenders(organisation_id, id)
);

COMMENT ON TABLE tender_status_events IS
  'Append-only trail of a tender''s progress. Every row is a human saying what happened on a portal this product cannot talk to.';

CREATE INDEX tender_status_events_tender_idx
  ON tender_status_events (organisation_id, tender_id, occurred_at, id);

ALTER TABLE tender_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tender_status_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tender_status_events_tenant_policy ON tender_status_events
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- Append-only for the application role: no UPDATE, no DELETE. The absent
-- grants are the whole mechanism; there is no second layer here because
-- there is nothing conditional to enforce — unlike 0079's version guard,
-- which had a parent state to check, every row in this table is legal the
-- moment it is written and illegal to touch afterwards.
GRANT SELECT, INSERT ON tender_status_events TO auto_mb_app;
