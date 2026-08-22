SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0118: the Tally ledger census — wave T1 of the Tally
-- migration train.
--
-- Survey: `docs/reference/TALLY-MAPPING-CENSUS.md`, § 1 and § 5.
-- Owner rulings of 22 Aug 2026: 2, 3, 4, 5, 6, 7, 8.
--
-- ---------------------------------------------------------------------
-- THE PROBLEM, EXACTLY.
--
-- This organisation has kept its books in TallyPrime since 2020. Its
-- `All Masters` export holds 4,327 ledger masters, and inside those names
-- and groups sit three things this product needs and cannot currently
-- see:
--
--   * WHO IT TRADES WITH. 178 customer ledgers and 2,057 vendor ledgers,
--     against a contacts master that was typed in by hand.
--   * WHICH INSTRUMENTS ARE OUTSTANDING. 357 ledgers whose names carry a
--     v1 work code — the security deposits the railway holds, the FDRs,
--     the bank guarantees, the tender EMDs. The census calls this the
--     single most valuable fact in the masters: the instruments are
--     ALREADY keyed to the work.
--   * WHAT THE DEDUCTION HEADS ARE, which waves T3 and T4 map onto
--     migration 0114's five closed heads.
--
-- Waves T2 through T5 all need to name a Tally ledger. This table is
-- what they name.
--
-- ---------------------------------------------------------------------
-- A MIRROR, NOT A REGISTER — AND THAT IS THE ONE PLACE THIS DEPARTS FROM
-- 0115, WHICH IS OTHERWISE ITS MODEL.
--
-- 0115 records invoices ANOTHER SYSTEM ISSUED. A document that was filed
-- with the government does not change afterwards, so that register is
-- immutable, its idempotency key is partial, and its correction path is
-- to discard a row and re-import.
--
-- A ledger master is not a document. It is the CURRENT STATE of a row in
-- a file the organisation is still using every day — Tally remains the
-- general accounting books (ruling 1) — and owner ruling 3 says the
-- import runs on a FRESH export taken on import day, not on the 19 Aug
-- survey file. So the honest shape is a mirror:
--
--   * `(organisation_id, tally_guid)` is unique OUTRIGHT, not partially.
--   * A re-import UPDATES the row it already has. `tally_alterid` is
--     Tally's own edit counter, so a row whose ALTERID moved is a master
--     the organisation edited between the two exports, and the mirror
--     showing the OLD name would be the mirror lying.
--   * There is no discard, and no discarded-row lifecycle to keep in
--     step with an index predicate.
--
-- Applying 0115's insert-only pattern here would have produced exactly
-- the failure 0115's own header warns about, with the arms reversed:
-- the second import would report every edited ledger as ALREADY
-- IMPORTED, write nothing, and leave the census describing a file the
-- organisation stopped using in August.
--
-- WHAT REPLACES THE DISCARD: `last_seen_at`.
--
-- Every import stamps every row it saw with its own transaction
-- timestamp. That single column answers all three things a discard would
-- have been reached for:
--
--   * a ledger DELETED in Tally stops being stamped;
--   * an import of the WRONG FILE — another company's export, a
--     colleague's test data — is superseded the moment the right file is
--     imported, because none of its rows are stamped again;
--   * the census reads the LATEST import by default, so a stale row is
--     absent from every count without being destroyed.
--
-- No row is ever deleted (there is no DELETE grant) and no row ever
-- lies: it says which import last saw it, and the reader decides.
--
-- ---------------------------------------------------------------------
-- THE CLASSIFICATION IS TALLY'S, NOT THIS COMPANY'S.
--
-- `classification` is derived from the group ANCESTRY, and the two names
-- it reads — `Sundry Debtors` and `Sundry Creditors` — are Tally's own
-- reserved groups, present in every company file ever created.
--
-- The alternative was a list of this organisation's group spellings:
-- `Railway Authority`, `Private Parties`, `Amc`, eleven `Creditors for
-- A–K` categories, `Sub Contract Advance`. Owner ruling 7 says the
-- letter categories are an accounting taxonomy to be DROPPED, and any
-- such list is stale the first time somebody adds a twelfth category in
-- Tally. Read against the real export, ancestry selects exactly the 178
-- ledgers the census counted as customer-ish, and no ledger descends
-- from both roots.
--
-- `instrument` is the fourth arm and it is not a group at all: a ledger
-- OUTSIDE the party tree whose own name carries a `PL-<n>` work code.
-- 357 real ledgers across 202 distinct codes, and every one of them a
-- security deposit, an FDR, a bank guarantee or an EMD. Nothing else in
-- the file is shaped that way.
--
-- ---------------------------------------------------------------------
-- WHAT THIS TABLE DELIBERATELY DOES NOT HAVE.
--
--   * NO `work_id`. Owner rulings 4 and 5: 202 distinct work codes
--     appear here against 38 works in the system, the surplus is
--     pre-cutover history, and a Tally code NEVER creates a Work. The
--     code is preserved as TEXT in `pl_code`, linkable by a later wave,
--     and because there is no reference to `works` there is no
--     work-scope predicate and no 0071 supersession question to answer.
--   * NO CONTACT LINK — only a contact PROPOSAL. Ruling 6: parsing
--     produces proposals, a person confirms, and ambiguity proposes
--     nothing. The columns are named `proposed_*` so that nothing
--     downstream can mistake one for a confirmed link, and this wave
--     ships no route that confirms one.
--   * NO INSTRUMENT RECORDS. Ruling 18: a reconciliation report first,
--     and no instrument fabricated from a ledger name. This is the
--     staging that report reads.
--   * NO VOUCHERS. T1 is masters only.
--
-- ---------------------------------------------------------------------
-- WHAT A LATER WAVE MUST DO ABOUT STALENESS, PINNED HERE SO IT IS NOT
-- REDECIDED PER WAVE.
--
-- `last_seen_at` makes "the census" a moving target: the rows carrying
-- the newest stamp. Every wave that JOINS to this table — T2's invoice
-- cross-reference first — has to say which reading it means, because a
-- link built against a row that a later import stopped naming is a link
-- to a master Tally no longer has.
--
-- THE RULE: a link wave joins through the latest-census filter, exactly
-- as `routes/tally-masters.ts` does —
--
--   last_seen_at = (SELECT max(last_seen_at) FROM tally_ledgers)
--
-- — and never to `tally_ledgers` unfiltered. A row that falls out of the
-- census is not deleted, so an existing link keeps resolving and stays
-- readable as history; what the filter prevents is a NEW link being made
-- to a master the current export does not carry.
--
-- The alternative — a per-row `superseded` boolean maintained by the
-- import — is deliberately NOT taken here: it is a second answer to a
-- question the timestamp already answers, and two answers drift. If a
-- later wave finds the filter genuinely unworkable (a join that cannot
-- carry a subquery, say), the boolean lands WITH that wave and this
-- comment is what it argues against.

-- ---------------------------------------------------------------------
-- `source_fields`, AND WHY IT IS NOT THE WHOLE MASTER.
--
-- 0115 stores every cell of its CSV row, because all 193 of a Zoho
-- export's columns are somebody's data. A Tally ledger master is not
-- like that: it carries about 165 tags of which roughly 150 are engine
-- flags whose value is the literal word `Yes` or `No`
-- (`ISBNFCODESUPPORTED`, `INTERESTINCLDAYOFADDITION`). Storing them
-- would be 13 MB of the word "No" per import, preserving nothing.
--
-- So the reader keeps every non-empty, non-boolean direct field — about
-- 770 bytes per ledger — and that is 0066's `extraction_payload`
-- discipline applied to a file with a different noise floor.
--
-- ⚠ UNTRUSTED TEXT from a file. Stored, never resolved: nothing derives
-- a path, a template or an identifier from it, and every write is
-- parameterised.
--
-- ---------------------------------------------------------------------
-- SQLSTATEs: the 23T block, by coordinator allocation.
--
--   23T01  a census row's Tally identity is fixed
--
-- ---------------------------------------------------------------------
-- ROLLBACK. One new table, its policy, its indexes and one guard.
-- Reversing it is dropping them, which is lossless: nothing else in the
-- schema references it, and no row here is the only copy of anything —
-- the export it was read from is a file the owner still holds.
--
-- CENSUS.
--
--   Tables created                1
--   Tables altered                0
--   Functions created             1
--   Triggers created              1
--   Indexes created               5
--   RLS policies created          1

CREATE TABLE tally_ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- Tally's own identifier for the master, and therefore the idempotency
  -- key. Present on 4,327 of 4,327 real ledgers. Opaque text: it is
  -- another system's id and this schema has no business asserting its
  -- shape beyond bounding it.
  tally_guid text NOT NULL CHECK (
    btrim(tally_guid) = tally_guid
    AND length(tally_guid) BETWEEN 1 AND 80
    AND tally_guid !~ '[[:cntrl:]]'
  ),

  -- Tally's edit counter, which increments whenever the master is
  -- altered. Ruling 2 stores it on every imported row so the one
  -- post-training top-up re-read can find what moved without any sync
  -- machinery.
  --
  -- NULLABLE, and null means UNKNOWN rather than zero. Zero is a real
  -- counter value — a master Tally has never altered — so a column that
  -- spelled "no counter in the export" as 0 would make the two
  -- indistinguishable, and the regression guard below would then read
  -- every such master as having gone backwards the moment a real counter
  -- appeared. The guard skips a comparison either side of which is null.
  tally_alterid bigint CHECK (tally_alterid IS NULL OR tally_alterid >= 0),

  -- The ledger name. Unique in Tally, and the join key used INSIDE the
  -- export: a voucher names its ledgers by this string and by nothing
  -- else, which is what makes waves T3 and T4 possible at all.
  --
  -- NOT unique here, and that is not an oversight. Two of the 4,327 real
  -- masters differ only by an illegal `&#4;` character reference, which
  -- the reader strips because every text CHECK in this schema refuses a
  -- control character. They are two masters with two GUIDs and both
  -- belong in the census; what they lose is `name_ambiguous` below.
  ledger_name text NOT NULL CHECK (
    btrim(ledger_name) = ledger_name
    AND length(ledger_name) BETWEEN 1 AND 300
    AND ledger_name !~ '[[:cntrl:]]'
  ),

  -- The immediate group, verbatim. EMPTY IS LEGAL: one real ledger (the
  -- Profit & Loss account) is a primary master with no parent at all.
  parent_group text NOT NULL CHECK (
    btrim(parent_group) = parent_group
    AND length(parent_group) <= 300
    AND parent_group !~ '[[:cntrl:]]'
  ),

  -- The group ancestry, ROOT FIRST, ending at the immediate parent —
  -- e.g. {'Current Assets','Deposits (Asset)','Railway Security
  -- Deposits'}. Stored rather than recomputed on read because the tree
  -- it was resolved against is the tree in the FILE, and the next export
  -- may reorganise it; a census that re-derived ancestry from whatever
  -- groups are current would silently restate history.
  group_path text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(group_path) <= 20 AND NOT ('' = ANY (group_path))
  ),

  -- Derived by the reader from `group_path`, and from Tally's own
  -- reserved group names. See the header.
  --
  --   customer    descends from Sundry Debtors
  --   vendor      descends from Sundry Creditors
  --   instrument  outside both, and its name carries a work code
  --   other       everything else: taxes, banks, expenses, capital
  classification text NOT NULL CHECK (
    classification IN ('customer', 'vendor', 'instrument', 'other')
  ),

  -- 0028's contacts GSTIN shape, both arms, so a ledger GSTIN and a
  -- master one are the same kind of value and the GSTIN-first match
  -- (ruling 8) compares like with like. 1,297 real ledgers carry one; a
  -- further 23 carry something that is not a GSTIN, which the reader
  -- nulls and counts rather than refusing the ledger over.
  gstin text CHECK (
    gstin IS NULL
    OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
    OR gstin ~ '^[0-9]{2}[0-9A-Z]{12}D$'
  ),

  -- EVIDENCE, NOT A BALANCE THIS PRODUCT COMPUTES WITH. 474 real ledgers
  -- carry an opening balance in the master; the movements that matter to
  -- the instruments report are in the vouchers, which is wave T4.
  opening_balance money_amount,

  -- The v1 work code the ledger's own NAME carries, canonical `PL-<n>`.
  -- TEXT, NEVER A LINK — ruling 4. Null where the name carries none, and
  -- null where it carries two different ones, because ambiguity proposes
  -- nothing (ruling 6).
  pl_code text CHECK (pl_code IS NULL OR pl_code ~ '^PL-[0-9]{1,4}$'),

  -- Tally's own ISDELETED flag on the master, verbatim.
  tally_is_deleted boolean NOT NULL DEFAULT false,

  -- Another master in the same export cleans to the same name. Such a
  -- row may still be proposed a contact by GSTIN — a different, better
  -- identifier — but never by name.
  name_ambiguous boolean NOT NULL DEFAULT false,

  -- A PROPOSAL, not a link. Ruling 6: a person confirms, and this wave
  -- ships nothing that confirms. Named `proposed_` so no later reader can
  -- mistake it for a decision anybody made.
  proposed_contact_id uuid,
  proposed_contact_method text CHECK (
    proposed_contact_method IS NULL OR proposed_contact_method IN ('gstin', 'name')
  ),

  -- Every non-empty, non-boolean field of the master. See the header.
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(source_fields) = 'object'
  ),

  -- The file this row was last read from, so "where did this come from"
  -- is answerable from the row rather than only from whoever ran the
  -- import.
  source_filename text NOT NULL CHECK (
    btrim(source_filename) = source_filename
    AND length(source_filename) BETWEEN 1 AND 260
    AND source_filename !~ '[[:cntrl:]]'
  ),

  imported_by_user_id text NOT NULL,

  -- The import that last saw this ledger. THE SUPERSESSION MECHANISM —
  -- see the header. Every row an import touches carries that import's
  -- transaction timestamp, so the latest census is
  -- `last_seen_at = (SELECT max(last_seen_at) …)` and a row that stopped
  -- being exported simply falls out of it.
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- So a later wave can reference a census row with its organisation,
  -- the composite shape 0087, 0091, 0094 and 0115 all use.
  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, proposed_contact_id)
    REFERENCES contacts (organisation_id, id),

  -- A proposal travels as one fact: the contact and how it was arrived
  -- at. A contact with no method is a proposal nobody can explain; a
  -- method with no contact is a claim about nothing.
  CONSTRAINT tally_ledgers_proposal_shape_check CHECK (
    (proposed_contact_id IS NULL) = (proposed_contact_method IS NULL)
  ),

  -- Only a party ledger is ever proposed a contact. A security deposit
  -- is not a contact however closely its name resembles a railway
  -- division's, and proposing one would be exactly the confident wrong
  -- answer ruling 6 refuses.
  CONSTRAINT tally_ledgers_proposal_class_check CHECK (
    proposed_contact_id IS NULL
    OR classification IN ('customer', 'vendor')
  ),

  -- A name that is not a key cannot have produced a match BY name.
  CONSTRAINT tally_ledgers_ambiguous_name_check CHECK (
    NOT (name_ambiguous AND proposed_contact_method = 'name')
  )
);

COMMENT ON TABLE tally_ledgers IS
  'One ledger master from a TallyPrime All Masters export, mirrored so the Tally migration waves can name a ledger and so the organisation can read its own trading parties, work-coded instruments and deduction heads in-system. A MIRROR of a file still in use, not an immutable register: a re-import of a fresher export updates the row, and last_seen_at is what supersedes a ledger that stopped being exported. Proposes contacts; links nothing, creates nothing.';
COMMENT ON COLUMN tally_ledgers.tally_guid IS
  'Tally''s own stable identifier, and therefore the idempotency key: re-importing a fresh export updates the masters it already holds and inserts the ones it does not.';
COMMENT ON COLUMN tally_ledgers.tally_alterid IS
  'Tally''s edit counter for this master, or NULL where the export carried none — unknown, which is not the same as zero. Stored per owner ruling 2 so the single post-training top-up re-read can see what the organisation changed, without any sync machinery.';
COMMENT ON COLUMN tally_ledgers.classification IS
  'Derived from Tally''s OWN reserved group ancestry (Sundry Debtors / Sundry Creditors), never from this organisation''s group spellings, plus an instrument arm for a non-party ledger whose name carries a work code. Owner ruling 7 dropped the letter categories as accounting taxonomy.';
COMMENT ON COLUMN tally_ledgers.pl_code IS
  'The v1 work code carried in the ledger''s own name, canonical PL-<n>. TEXT, NEVER A LINK: owner rulings 4 and 5 — the surplus codes are pre-cutover history and a Tally code never creates a Work.';
COMMENT ON COLUMN tally_ledgers.proposed_contact_id IS
  'A PROPOSAL a person has not confirmed. Owner rulings 6 and 8: GSTIN first then exact name, ambiguity proposes nothing, and a person decides. Nothing in this wave confirms one, and nothing downstream may read it as a link.';
COMMENT ON COLUMN tally_ledgers.last_seen_at IS
  'The transaction timestamp of the import that last saw this ledger. The census reads the latest import, so a master deleted in Tally — or a whole import of the wrong file — falls out of every count without any row being destroyed.';
COMMENT ON COLUMN tally_ledgers.source_fields IS
  'Every non-empty, non-boolean field of the Tally master, keyed by Tally''s own tag. The ~150 Yes/No engine flags are dropped: storing them would be 13 MB of the word "No" per import. Untrusted text: stored, never resolved.';

ALTER TABLE tally_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_ledgers FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY tally_ledgers_tenant_policy ON tally_ledgers
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. A census row is superseded by not being seen again, never
-- destroyed — the same posture loa_documents, received_railway_bills and
-- imported_invoices keep, reached by a different mechanism.
GRANT SELECT, INSERT, UPDATE ON tally_ledgers TO auto_mb_app;

-- THE IDEMPOTENCY KEY, and it is NOT partial. See the header: this table
-- has no discard, so there is no discarded-row exclusion for a predicate
-- to have to stay in step with, and the import's ON CONFLICT DO UPDATE
-- needs an arbiter that covers every row.
CREATE UNIQUE INDEX tally_ledgers_guid_key
  ON tally_ledgers (organisation_id, tally_guid);

-- The census screen: the classes in turn, each in name order.
CREATE INDEX tally_ledgers_class_idx
  ON tally_ledgers (organisation_id, classification, ledger_name);

-- The contacts foreign key's own index, for the reason 0115 gives: an
-- unindexed foreign key turns every parent delete into a scan.
CREATE INDEX tally_ledgers_contact_idx
  ON tally_ledgers (organisation_id, proposed_contact_id);

-- What waves T3, T4 and T5 join on: which ledgers name this work.
CREATE INDEX tally_ledgers_pl_code_idx
  ON tally_ledgers (organisation_id, pl_code)
  WHERE pl_code IS NOT NULL;

-- Every read of the census carries `last_seen_at = (SELECT max(…))`, and
-- the subquery is the same index's rightmost entry.
CREATE INDEX tally_ledgers_last_seen_idx
  ON tally_ledgers (organisation_id, last_seen_at DESC);

-- ═════════════════════════════════════════════════════════════════════
-- THE GUARD
-- ═════════════════════════════════════════════════════════════════════
--
-- Layer two of two. The import route upserts on the GUID, so it cannot
-- reach the case below; this is the arm that holds when a writer reaches
-- the table another way.
--
-- WHAT IS FROZEN IS THE IDENTITY, not the contents. The contents are a
-- mirror and are meant to move when the file does. But a row that
-- changed which Tally master it is about would carry one master's
-- history under another's id, and every wave downstream joins on exactly
-- that.
--
-- `SET search_path` for the reason every guard here gives: a function
-- that resolves its own identifiers through the caller's path is a rule
-- a shadowing object in a writable schema can rewrite. Not SECURITY
-- DEFINER: every table touched is one the caller may already read under
-- RLS.

CREATE FUNCTION app_private.guard_tally_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.tally_guid IS DISTINCT FROM OLD.tally_guid
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION
        'tally ledger census row % is about Tally master %, and which master a census row is about never changes',
        OLD.id, OLD.tally_guid
        USING ERRCODE = '23T01';
    END IF;

    -- A mirror normally only moves forward. Tally's ALTERID increments on
    -- every alteration, so an update carrying a LOWER one is an older
    -- export being imported after a newer one — which would quietly
    -- replace the current census with a stale one and leave the counts
    -- describing neither file.
    --
    -- TWO THINGS MAKE THIS A RULE RATHER THAN AN INVARIANT, and both are
    -- written out because a guard that refused unconditionally would be
    -- refusing reality:
    --
    --   * NULL IS UNKNOWN. A master with no counter in either the census
    --     or the export cannot be compared, and comparing it against zero
    --     would refuse the honest case forever.
    --   * A RESTORED TALLY BACKUP GENUINELY GOES BACKWARDS. When the
    --     company restores last week's company file, every counter drops
    --     and the FILE is the current truth while the census is the stale
    --     one. That is a real Tuesday, not corruption. The operator says
    --     so with the import route's `force` flag, which sets this
    --     transaction-local setting and writes its own audit event; the
    --     override is therefore explicit, scoped to one transaction, and
    --     on the record. `app.` is the same GUC namespace 0001 reads the
    --     organisation and user from.
    IF NEW.tally_alterid IS NOT NULL
       AND OLD.tally_alterid IS NOT NULL
       AND NEW.tally_alterid < OLD.tally_alterid
       AND coalesce(nullif(current_setting('app.tally_force', true), ''), 'off')
           <> 'on' THEN
      RAISE EXCEPTION
        'tally ledger census row % was read from an export older than the one already imported (ALTERID % against %); import the fresher export, or re-run the import with the override if a Tally backup was restored',
        OLD.id, NEW.tally_alterid, OLD.tally_alterid
        USING ERRCODE = '23T01';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_tally_ledger() IS
  'A census row mirrors one Tally master: its contents move when a fresher export is imported, but which master it is about — the organisation, the GUID and when it first arrived — never changes. An export older than the one already read cannot overwrite it either, unless the operator sets app.tally_force for one transaction because a Tally backup was restored, which the import route does only on an explicit, audited override. The route refuses first so an operator gets a remedy; this is the arm that holds under concurrency and against a writer reaching the table another way.';

CREATE TRIGGER tally_ledgers_guard
BEFORE INSERT OR UPDATE ON tally_ledgers
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tally_ledger();
