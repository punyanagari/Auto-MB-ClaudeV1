SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0094: bringing a register in from a spreadsheet — the staging
-- area an uploaded workbook lands in, and the authority to use it.
--
-- Every organisation that adopts this product already keeps its party
-- master and its item catalogue in Excel, and typing a thousand rows back
-- in by hand is the reason adoption stalls. This migration builds the
-- place those rows wait while somebody looks at them.
--
-- TWO TABLES.
--
--   spreadsheet_import_batches  one uploaded file, its target, its outcome
--   spreadsheet_import_rows     one sheet row, its raw cells, its verdict
--
-- THE `spreadsheet_` PREFIX IS NOT DECORATION. Migration 0025 already owns
-- `import_batches` and `import_records`, and they are a different feature
-- entirely: the one-off v1 cutover, driven by a CLI against a SQLite
-- backup (apps/server/src/import/), which reconciles a whole legacy
-- database in a single administrator-run transaction. This is the
-- product feature an operator uses from a screen, repeatedly, against one
-- register at a time. Two things that stage rows are not one thing, and
-- the first draft of this migration discovered the collision by being
-- refused — which is the schema doing its job.
--
-- ---------------------------------------------------------------------
-- THE LOAD-BEARING RULE: NOTHING REACHES A LIVE REGISTER UNTIL A PERSON
-- SAYS SO.
--
-- An upload parses, stages and validates. It writes staged rows and
-- nothing else. `contacts` and `canonical_items` are untouched until a
-- second, explicit call commits the batch, and a batch that is never
-- committed is inert for ever.
--
-- That is not caution for its own sake. A spreadsheet an operator
-- assembled over two years has typos in it, and the useful question is
-- not "did the import succeed" but "which eleven rows are wrong and
-- why". A pipeline that writes as it reads cannot answer that: it has
-- already half-written the register by the time it finds row 400, and
-- the operator is left reconciling two states. Staging makes the whole
-- file's verdict readable before any of it counts.
--
-- The rows are therefore SCRATCH, and the schema says so in the one way
-- that matters: a staged row has no foreign key into the register it
-- feeds, carries no business constraint of that register's, and can hold
-- a row that is nonsense. Its CHECKs are about the STAGING record — a row
-- knows whether it has been judged and what was said — never about
-- whether a GSTIN is well formed. The register's own CHECKs decide that,
-- at commit, which is the only moment the value becomes a claim.
--
-- ---------------------------------------------------------------------
-- CELLS ARE INERT TEXT, AND THE COLUMN TYPE IS PART OF THE ARGUMENT.
--
-- `cells` is a jsonb object of column key to STRING. Not typed values,
-- not numbers, not dates — strings, exactly as the sheet spelled them.
--
-- The bytes arrive from outside the organisation's control (a workbook
-- is forwarded, downloaded, assembled by a vendor), so the cells are
-- user input at a trust boundary and are treated as such the whole way
-- through: the reader never evaluates a formula, only ever lifting the
-- cached value a writer left on disk; nothing here interpolates a cell
-- into SQL, because every write is parameterised; and no cell is coerced
-- to a type before the target's own validator has seen it. A pipeline
-- that guesses "12" is a number upstream of the rule that decides what
-- the column means has put a second, weaker validator in front of the
-- real one.
--
-- ---------------------------------------------------------------------
-- WHY THERE IS NO JOB QUEUE HERE, WHICH THE FIRST DESIGN ASSUMED.
--
-- 0072's worker queue exists and this feature does not use it. The
-- request cap is 8 MB and the sheet cap is 5,000 rows; parsing that
-- synchronously is milliseconds, and the validation is pure function
-- calls plus one uniqueness probe per row. An asynchronous lane would
-- add a job kind, a handler, a polling screen and a whole class of
-- "where did my upload go" question, to move work that is already fast
-- enough off a request that is already waiting.
--
-- The ceiling is stated rather than hidden: a file that needs longer
-- than a request should live is refused by the row cap, with a sentence
-- telling the operator to split it. When a register arrives that
-- genuinely cannot be split, the queue is there and this becomes a job
-- kind. Not before.
--
-- ---------------------------------------------------------------------
-- THE IMPORT AUTHORITY.
--
-- Provisional owner ruling, in the shape 0061 (statutory), 0080
-- (payments), 0089 (payroll) and 0091 (signing) all use: a per-member
-- column, default false, not backfilled.
--
-- The reason importing is not simply the writer role — which is what the
-- registers themselves require — is the asymmetry between the two acts.
-- Adding one contact is a considered act with a form in front of it and
-- a person reading the fields. Committing a batch writes eight hundred
-- rows from a file whose provenance is a forwarded attachment, and the
-- member doing it is frequently the most junior person in the office,
-- because "type in the vendor list" is the job that gets delegated. The
-- authority is what lets an owner grant that delegation deliberately
-- instead of it arriving free with the ability to add a contact.
--
-- It confers nothing on its own: a batch still commits into the
-- register's own writer role and the register's own CHECKs. It answers
-- WHO MAY POINT A FILE AT A REGISTER, which is a question no existing
-- authority was asked.

ALTER TABLE organisation_memberships
  ADD COLUMN can_import_data boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organisation_memberships.can_import_data IS
  'Authority to upload a spreadsheet against a register, and to commit the rows it staged (0094). Separate from the writer role that governs the registers themselves: adding one row is a considered act with a form in front of it, and committing a batch writes hundreds from a file somebody forwarded. Not backfilled: an owner grants it per member.';

-- THE FOUNDING OWNER HOLDS IT, and every existing member does not —
-- 0089's and 0091's rule, for 0089's and 0091's reason.
--
-- ⚠ CROSS-PACK HAZARD, STATED LOUDLY BECAUSE IT HAS ALREADY COST ONCE.
-- `CREATE OR REPLACE` states the WHOLE body rather than amending it, so
-- every grant any earlier migration wrote must be restated here or it is
-- silently revoked from every founder — with no error anywhere, because
-- nothing refuses a column left false. 0089 added `can_manage_payroll`
-- and 0091 added `can_sign_documents` for exactly this reason, each
-- restating its predecessor's.
--
-- This migration runs in a wave whose sibling packs (0092, 0095, 0096)
-- may each replace this same function to add an authority of their own.
-- Disjoint migration numbers do not help: they all touch this one body,
-- and the LAST one to apply wins outright. Whoever merges this wave must
-- reconcile the replacements into a single final grant list rather than
-- assuming three independently-correct migrations compose. The
-- migration-contract test pins the VALUES line so a dropped grant fails
-- there rather than in a founder's first import.
CREATE OR REPLACE FUNCTION app_private.create_organisation_with_owner(
  p_name text,
  p_slug text,
  p_id uuid DEFAULT gen_random_uuid()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
DECLARE
  v_user_id text;
BEGIN
  v_user_id := nullif(current_setting('app.user_id', true), '');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'organisation creation requires an authenticated user context'
      USING ERRCODE = '28000';
  END IF;

  INSERT INTO organisations (id, name, slug) VALUES (p_id, p_name, p_slug);

  -- Five authorities, and only the last is this migration's own. The
  -- other four are 0091's, 0089's and 0004's, restated because a
  -- replacement that omits one revokes it.
  INSERT INTO organisation_memberships (
    organisation_id, user_id, role, work_scope,
    can_issue_documents, can_cancel_documents, can_sign_documents,
    can_manage_payroll, can_import_data, status
  )
  VALUES (p_id, v_user_id, 'owner', 'all', true, true, true, true, true, 'active');

  INSERT INTO audit_events (
    organisation_id, actor_user_id, action, entity_type, entity_id
  )
  VALUES (p_id, v_user_id, 'organisation.created', 'organisations', p_id);

  RETURN p_id;
END
$$;

-- 0091's discipline: a SECURITY DEFINER function that silently changed
-- hands would be a privilege change nobody reviewed, so ownership and
-- the grant are restated rather than inherited.
ALTER FUNCTION app_private.create_organisation_with_owner(text, text, uuid)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.create_organisation_with_owner(text, text, uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION
      app_private.create_organisation_with_owner(text, text, uuid) TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 1. The batch.
--
-- FOUR STATES, walked forwards only:
--
--   pending    the file is staged and its rows are not yet judged
--   validated  every row carries a verdict; the operator may commit
--   completed  terminal — the valid rows were written to the register
--   cancelled  terminal — withdrawn, and nothing was written
--
-- `pending` and `validated` are separate even though one request today
-- moves through both, because the state that matters to an operator is
-- "has this been checked", and collapsing them would make a batch whose
-- validation failed indistinguishable from one nobody has looked at.
--
-- WHY THE FILE IS NOT STORED. There is no object key here and no PDF-
-- style blob: the sheet's whole content is in `spreadsheet_import_rows` as text, and
-- keeping the original bytes as well would store every contact list twice
-- — once as scratch and once as an attachment nobody opens — in a store
-- whose keys are otherwise all issued documents. `source_sha256` is kept
-- instead, which answers the only question the bytes were needed for:
-- whether this is the same file as that one. `original_filename` is kept
-- because "Vendors-FINAL-v3.xlsx" is how the operator refers to it.
--
-- ⚠ `original_filename` IS USER-CONTROLLED TEXT and is stored, never
-- resolved. Nothing derives a path from it — the staging area is rows in
-- a table, not files on a disk — so the traversal question the upload
-- guards ask of an object key does not arise here. It is bounded and
-- newline-free so it cannot forge a line in a log or a screen.
-- ---------------------------------------------------------------------
CREATE TABLE spreadsheet_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- Which register the rows are aimed at. A closed vocabulary, not a
  -- table name the caller supplies: this value selects a hard-coded
  -- importer in the application, and anything else is refused here
  -- rather than reaching code that looks a table up by string.
  target text NOT NULL CHECK (target IN ('contacts', 'canonical_items')),

  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'validated', 'completed', 'cancelled')
  ),

  original_filename text NOT NULL CHECK (
    btrim(original_filename) = original_filename
    AND length(original_filename) BETWEEN 1 AND 255
    AND original_filename !~ '[[:cntrl:]]'
  ),
  source_sha256 sha256_hex NOT NULL,

  -- The census the screen reads. Derived from `spreadsheet_import_rows` and stored
  -- because a register listing twenty batches would otherwise be twenty
  -- aggregate subqueries, and because a terminal batch's numbers are a
  -- record of what happened rather than a live count.
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  valid_row_count integer NOT NULL DEFAULT 0 CHECK (valid_row_count >= 0),
  error_row_count integer NOT NULL DEFAULT 0 CHECK (error_row_count >= 0),
  -- Rows that actually reached the register. At most `valid_row_count`,
  -- and less than it when a row that validated cleanly lost a race to a
  -- concurrent write — which is a real outcome, not a bug, and the
  -- reason this is a third number rather than a repeat of the second.
  imported_row_count integer NOT NULL DEFAULT 0 CHECK (imported_row_count >= 0),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  completed_at timestamptz,
  completed_by_user_id text,
  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancelled_reason text CHECK (
    cancelled_reason IS NULL
    OR (btrim(cancelled_reason) = cancelled_reason
        AND length(cancelled_reason) BETWEEN 3 AND 500)
  ),

  UNIQUE (organisation_id, id),

  -- The verdicts partition the rows: every staged row is valid or in
  -- error, never both and never neither, once the batch has been judged.
  -- Written as an implication rather than an equality so a `pending`
  -- batch — whose rows have no verdict yet — is not refused.
  CONSTRAINT spreadsheet_import_batches_verdict_census CHECK (
    status = 'pending'
    OR (valid_row_count + error_row_count = row_count
        AND imported_row_count <= valid_row_count)
  ),
  CONSTRAINT spreadsheet_import_batches_completion_shape CHECK (
    (completed_at IS NULL) = (completed_by_user_id IS NULL)
    AND (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT spreadsheet_import_batches_cancellation_shape CHECK (
    (cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)
    AND (cancelled_at IS NULL) = (cancelled_reason IS NULL)
    AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
  )
);

COMMENT ON TABLE spreadsheet_import_batches IS
  'One uploaded spreadsheet aimed at one register: what it was called, what it hashed to, how its rows were judged, and whether a person ever committed it. Nothing here touches a live register — that happens once, at commit, and this row records that it did.';
COMMENT ON COLUMN spreadsheet_import_batches.target IS
  'The register the rows are aimed at. A closed vocabulary selecting a hard-coded importer, never a table name taken from the caller.';
COMMENT ON COLUMN spreadsheet_import_batches.source_sha256 IS
  'SHA-256 of the uploaded bytes. The file itself is not stored — the rows are — and this answers the only question the bytes were kept for: whether this is the same file as that one.';
COMMENT ON COLUMN spreadsheet_import_batches.imported_row_count IS
  'Rows that actually reached the register. Below valid_row_count when a row that validated cleanly lost a race to a concurrent write at commit.';

ALTER TABLE spreadsheet_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE spreadsheet_import_batches FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY spreadsheet_import_batches_tenant_policy ON spreadsheet_import_batches
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. A batch is the answer to "where did these eight hundred
-- contacts come from", and an abandoned one cancels with a reason rather
-- than vanishing — the same rule every register in this schema follows.
--
-- ponytail: nothing purges a cancelled batch's staged rows, so scratch
-- accumulates at the rate people upload. Bounded per batch by the row
-- cap; add a retention sweep when the audit/retention pack (which owns
-- retention policy) arrives, rather than inventing a second policy here.
GRANT SELECT, INSERT, UPDATE ON spreadsheet_import_batches TO auto_mb_app;

-- The register lists newest first, per organisation, and filters by
-- target on the batch screen.
CREATE INDEX spreadsheet_import_batches_org_created_idx
  ON spreadsheet_import_batches (organisation_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------
-- 2. The staged row.
--
-- `row_number` is the SHEET's row, not a sequence — row 1 is the header,
-- so the first data row is 2. That is what the operator sees in the
-- corner of Excel, and an error report that renumbers the rows it is
-- describing is an error report nobody can act on.
--
-- `errors` is an array of objects, each naming a column and a sentence.
-- The column reference is what makes a batch fixable: "row 47" sends
-- somebody scanning a row of eighteen fields, and "row 47, GSTIN" does
-- not. The sentences are the register's OWN refusals, produced by the
-- same validators the single-record route uses, so an operator reads
-- the same words whichever door they came through.
-- ---------------------------------------------------------------------
CREATE TABLE spreadsheet_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  batch_id uuid NOT NULL,

  row_number integer NOT NULL CHECK (row_number >= 2),

  -- Column key to raw cell text, exactly as the sheet spelled it.
  -- Strings only, never coerced: see the header.
  cells jsonb NOT NULL CHECK (jsonb_typeof(cells) = 'object'),

  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'valid', 'error')
  ),

  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),

  -- The register row this became, once it became one.
  imported_record_id uuid,

  -- The composite tenant reference 0087 and 0091 both use: the batch is
  -- named with its organisation, so a row cannot be attached to another
  -- tenant's batch even by a writer that reaches the table another way.
  FOREIGN KEY (organisation_id, batch_id)
    REFERENCES spreadsheet_import_batches (organisation_id, id),

  UNIQUE (organisation_id, batch_id, row_number),

  -- A verdict and its evidence agree, in both directions: a row in error
  -- says why, and a row that is not in error carries no complaint.
  CONSTRAINT spreadsheet_import_rows_verdict_shape CHECK (
    (status = 'error') = (jsonb_array_length(errors) > 0)
  ),
  -- Only a row that passed can have reached the register.
  CONSTRAINT spreadsheet_import_rows_imported_shape CHECK (
    imported_record_id IS NULL OR status = 'valid'
  )
);

COMMENT ON TABLE spreadsheet_import_rows IS
  'One row of an uploaded sheet: its cells as inert text, the verdict the target register''s own validators returned, and — after commit — the record it became. Carries no foreign key into the registers it feeds and none of their constraints: it is scratch until it is committed, and the register decides at that moment.';
COMMENT ON COLUMN spreadsheet_import_rows.row_number IS
  'The row number in the sheet, where 1 is the header. Not a sequence: an error report that renumbers the rows it describes cannot be acted on.';
COMMENT ON COLUMN spreadsheet_import_rows.cells IS
  'Column key to raw cell text. Strings only — never coerced to a number or a date before the target''s validator has seen the value, because a guess upstream of the rule is a second, weaker validator.';
COMMENT ON COLUMN spreadsheet_import_rows.errors IS
  'Array of {column, message}. The message is the register''s own refusal, from the same validator the single-record route uses, so the same mistake reads the same words whichever door it came through.';

ALTER TABLE spreadsheet_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE spreadsheet_import_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY spreadsheet_import_rows_tenant_policy ON spreadsheet_import_rows
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE ON spreadsheet_import_rows TO auto_mb_app;

-- The detail screen reads one batch in sheet order; the errors-first
-- filter reads the same index and sorts in memory over one page.
CREATE INDEX spreadsheet_import_rows_batch_idx
  ON spreadsheet_import_rows (organisation_id, batch_id, row_number);

-- ---------------------------------------------------------------------
-- 3. The guards.
--
-- Every rule below is also checked by the route, first, under no lock, so
-- an operator gets a named 409 with a remedy. These are the arm that
-- holds when a writer reaches the table another way, and the arm that
-- holds under concurrency, which the route cannot.
--
-- SQLSTATEs come from the 23L block, one per rule. (`I` is skipped in
-- this schema's block allocation: `23I0…` reads as a digit at a glance
-- and the one thing an operator does with a SQLSTATE is read it aloud.)
--
-- `SET search_path` for the reason 0067, 0077, 0079, 0084, 0087 and 0091
-- all give: a function that resolves its own identifiers through the
-- caller's path is a rule a shadowing object in a writable schema can
-- rewrite into whatever it likes. Not SECURITY DEFINER: every table
-- touched is one the caller may already read under RLS, and a definer
-- function here would read across tenants.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_spreadsheet_import_batch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- What the file WAS is written once. Re-pointing a staged batch at a
    -- different register, or relabelling it as a different file, would
    -- rewrite the provenance of rows already judged against the first
    -- answer.
    IF ROW(
         NEW.id, NEW.organisation_id, NEW.target, NEW.original_filename,
         NEW.source_sha256, NEW.created_by_user_id, NEW.created_at
       ) IS DISTINCT FROM ROW(
         OLD.id, OLD.organisation_id, OLD.target, OLD.original_filename,
         OLD.source_sha256, OLD.created_by_user_id, OLD.created_at
       ) THEN
      RAISE EXCEPTION
        'an import batch''s file and target register are recorded once; upload the file again instead'
        USING ERRCODE = '23L02';
    END IF;

    -- Terminal is terminal. A committed batch is the record of rows that
    -- are now in a register, and a cancelled one is the record of a
    -- decision not to; re-opening either would make both a suggestion.
    IF OLD.status IN ('completed', 'cancelled')
       AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION
        'import batch % is already %, and a finished batch cannot be changed',
        OLD.id, OLD.status
        USING ERRCODE = '23L01';
    END IF;

    -- Forwards only, and only along edges that exist. `pending` may be
    -- judged or withdrawn; `validated` may be committed or withdrawn.
    IF NEW.status <> OLD.status THEN
      IF NOT (
        (OLD.status = 'pending' AND NEW.status IN ('validated', 'cancelled'))
        OR (OLD.status = 'validated' AND NEW.status IN ('completed', 'cancelled'))
      ) THEN
        RAISE EXCEPTION
          'an import batch cannot move from % to %', OLD.status, NEW.status
          USING ERRCODE = '23L01';
      END IF;
    END IF;

    -- A batch is committed against the verdicts it actually holds. The
    -- census columns are maintained by the same statement that writes
    -- the rows, so a disagreement here means the two went out of step —
    -- and a batch reporting "800 imported" over 300 staged rows is a
    -- number somebody will quote in a meeting.
    IF NEW.status = 'completed' AND NEW.imported_row_count > NEW.valid_row_count THEN
      RAISE EXCEPTION
        'an import batch cannot report more imported rows (%) than valid ones (%)',
        NEW.imported_row_count, NEW.valid_row_count
        USING ERRCODE = '23L05';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_spreadsheet_import_batch() IS
  'Everything an import batch is allowed to be: its file and target written once, its states walked forwards along the edges that exist, terminal rows immutable, and its census never claiming more imported rows than it judged valid. The route makes each refusal first so an operator gets a remedy; this is the arm that holds under concurrency.';

CREATE TRIGGER spreadsheet_import_batches_guard
BEFORE INSERT OR UPDATE ON spreadsheet_import_batches
FOR EACH ROW EXECUTE FUNCTION app_private.guard_spreadsheet_import_batch();

CREATE FUNCTION app_private.guard_spreadsheet_import_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  batch_status text;
BEGIN
  -- A staged row belongs to a batch that is still open. Writing rows
  -- into a finished batch — in either direction — would change what a
  -- committed import is on record as having contained.
  SELECT b.status INTO batch_status
  FROM spreadsheet_import_batches b
  WHERE b.organisation_id = NEW.organisation_id AND b.id = NEW.batch_id;

  IF batch_status IS NULL OR batch_status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION
      'import batch % is %, and its rows can no longer be written',
      NEW.batch_id, coalesce(batch_status, 'missing')
      USING ERRCODE = '23L04';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- The cells are what the sheet said. A verdict may be written over
    -- them and a record id attached to them, but the evidence itself is
    -- never edited — a staging row whose content could be corrected in
    -- place is one where nobody can tell what was uploaded from what was
    -- fixed afterwards.
    IF ROW(
         NEW.id, NEW.organisation_id, NEW.batch_id, NEW.row_number, NEW.cells
       ) IS DISTINCT FROM ROW(
         OLD.id, OLD.organisation_id, OLD.batch_id, OLD.row_number, OLD.cells
       ) THEN
      RAISE EXCEPTION
        'a staged row''s cells are what the sheet contained and are not edited; upload a corrected sheet instead'
        USING ERRCODE = '23L03';
    END IF;

    -- A row reaches the register once. Re-pointing it at a second record
    -- would leave the first orphaned from the row that explains it.
    IF OLD.imported_record_id IS NOT NULL
       AND NEW.imported_record_id IS DISTINCT FROM OLD.imported_record_id THEN
      RAISE EXCEPTION
        'staged row % has already been imported as %', OLD.row_number, OLD.imported_record_id
        USING ERRCODE = '23L03';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_spreadsheet_import_row() IS
  'A staged row is evidence: its cells are written once, its batch must still be open, and it reaches a register at most once. Verdicts and the imported record id are the only things that may be written over it.';

CREATE TRIGGER spreadsheet_import_rows_guard
BEFORE INSERT OR UPDATE ON spreadsheet_import_rows
FOR EACH ROW EXECUTE FUNCTION app_private.guard_spreadsheet_import_row();
