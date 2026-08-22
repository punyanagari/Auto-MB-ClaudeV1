SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0119: the Tally ↔ Zoho invoice cross-reference, and the
-- pre-Zoho half of the billing history — wave T2 of the Tally migration
-- train.
--
-- Survey: `docs/reference/TALLY-MAPPING-CENSUS.md`, § 4.3 and § 5.
-- Owner rulings of 22 Aug 2026: 2, 12, 21, 22, 23.
--
-- ---------------------------------------------------------------------
-- THE PROBLEM, EXACTLY.
--
-- Migration 0115 brought in 638 invoices raised in Zoho Books from
-- January 2023. TallyPrime has been this organisation's books since
-- April 2020, and its `Sales` vouchers are the SAME billing history seen
-- from the other side — plus three years of it that Zoho never saw.
-- Read against the real export:
--
--   * 1,044 live `Sales` vouchers (1,052 less 8 cancelled or optional).
--   * 626 of them correspond to a Zoho invoice, covering 623 of the 638.
--   * 418 correspond to none — 366 of those dated before 2023 (₹47.49
--     crore), which is the pre-Zoho billing history ruling 23 admits.
--
-- Two different things therefore land here, and the schema keeps them
-- apart because the rulings do:
--
--   1. A CROSS-REFERENCE, where both systems hold the invoice. Zoho is
--      authoritative and the Tally voucher is provenance (ruling 23), so
--      NO register row is created — only a link.
--   2. A REGISTER ROW, where only Tally holds it. It joins 0115's
--      historical register behind a source discriminator.
--
-- ---------------------------------------------------------------------
-- § A. WHY THE CROSS-REFERENCE IS A TABLE AND NOT A COLUMN.
--
-- Ruling 12 asked exactly this and answered "a separate
-- provenance-stamped link table; the 0115 register is not touched". The
-- ruling is also the only shape the DATA admits: the correspondence is
-- MANY-TO-MANY. Read against the real files, 97 vouchers link to more
-- than one invoice (one accounting entry covering several bills) and 47
-- invoices link to more than one voucher (one bill entered as several).
-- A `tally_guid` column on `imported_invoices` could hold neither.
--
-- ---------------------------------------------------------------------
-- § B. WHAT RULING 23 DOES TOUCH ON 0115, AND WHY IT IS THE MINIMUM.
--
-- The register gains ONE column of meaning — `source` — and two of its
-- NOT NULLs are relaxed to admit a row Tally sourced. Nothing else moves.
--
--   * `source` ('zoho' | 'tally'), NOT NULL DEFAULT 'zoho'. Existing rows
--     backfill through the default, which is correct rather than merely
--     convenient: every row in the register before this migration came
--     from a Zoho export. It is FROZEN by the 0115 guard, extended below
--     — a row that changed which system it came from would carry one
--     system's provenance under another's rules.
--
--   * `zoho_invoice_id` becomes NULLABLE, and the shape check below binds
--     it to `source`: a 'zoho' row has one, a 'tally' row does not. It is
--     Zoho's own identifier and a Tally-sourced row has no honest value
--     to put in it; filling it with the voucher GUID would make a column
--     whose comment says "Zoho's own stable identifier" hold something
--     else. The partial unique index over it is untouched and keeps
--     working: NULLs do not collide in a unique index, so it continues to
--     be the Zoho idempotency key and simply ignores Tally rows.
--
--   * `sub_total` becomes NULLABLE, and only a 'tally' row may leave it
--     null. TALLY DOES NOT STATE A SUB-TOTAL. A sales voucher carries the
--     document total on the party line and its taxable value spread
--     across income legs that are told apart from tax legs only by which
--     GROUP their ledger sits in — which is `tally_ledgers` (0118), a
--     different import that may not have been run. Deriving the figure
--     here would be this register recomputing money another system
--     stated, which is the one thing 0115's header forbids on every line
--     of it. So the column says "not stated" rather than saying a number
--     nobody wrote down. `total` is stated, and is taken from the party
--     line exactly as the census defines a voucher's value.
--
-- The idempotency key for a Tally-sourced row is NOT on the register: it
-- is the voucher GUID, and it lives on the link table with the rest of
-- the Tally identity. See § D.
--
-- ---------------------------------------------------------------------
-- § C. DISPUTED FIGURES (ruling 21), AND WHY THE COMPARISON IS OVER A
-- COMPONENT RATHER THAN OVER A ROW.
--
-- Because the correspondence is many-to-many, "does Tally agree with
-- Zoho" is not a question about a pair. One voucher against three
-- invoices agrees when the voucher's total equals the three invoices'
-- total, and each individual pair disagrees wildly. So the importer
-- reconciles by CONNECTED COMPONENT — the census's own method — and
-- stores each component's two sums on every link in it. Read against the
-- real files: 526 components, of which 5 disagree by more than ₹1 (gaps
-- of ₹36.37, ₹8.73, ₹1.50, ₹0.31 and ₹0.04 lakh).
--
-- Ruling 21: import both figures, flag them disputed, and a disputed
-- figure JOINS NO SUM until the owner rules on that row. The register's
-- billed total therefore excludes an invoice carrying a disputed link,
-- exactly as it already excludes a voided one, and the screen says so.
--
-- ---------------------------------------------------------------------
-- § D. IDEMPOTENCY, AND THE DISCARD-AND-REIMPORT PATH.
--
-- 0115's register is INSERT-ONLY with a partial unique key, because a
-- document another system issued does not change and the correction path
-- is to discard a row and import the corrected file. A link is a record
-- of a correspondence found in one export, so it keeps the same posture:
-- there is no UPDATE grant and no DELETE grant.
--
--   * `(organisation_id, tally_guid, imported_invoice_id)` is unique. One
--     voucher may link to several invoices and one invoice to several
--     vouchers; the PAIR appears once.
--   * A re-import inserts `ON CONFLICT DO NOTHING`, so running the same
--     export twice adds the links that were missing and leaves the rest
--     exactly as they are — the property that makes a cutover import
--     survivable.
--   * The route's own "already there" check reads links whose invoice is
--     NOT discarded, which is the same reading 0115's partial index takes.
--     Discarding a Tally-sourced invoice and importing the corrected
--     export therefore creates a fresh row and a fresh link; the withdrawn
--     row and its link both stay, as the record of what happened.
--
-- `match_method = 'origin'` is the arm that makes this work for a
-- Tally-SOURCED row: the link says "this register row exists because this
-- voucher does", so the voucher GUID is on the record and the re-import
-- can find it without a provenance column on the register (§ A). The
-- guard below refuses a SECOND live origin link for one voucher, which is
-- the database's own arm of that rule.
--
-- ---------------------------------------------------------------------
-- § E. WHAT THIS MIGRATION DELIBERATELY DOES NOT HAVE.
--
--   * NO CREDIT AND DEBIT NOTES IN THE REGISTER. The reader reads all
--     three voucher types the census names, and the import REPORTS the
--     69 credit and 64 debit notes it saw — but `imported_invoices` is a
--     register of invoices RAISED, and a credit note reverses one. Adding
--     them to it would overstate "what we have billed" by whatever was
--     credited, which is precisely the error the Void exclusion already
--     exists to prevent. `tally_voucher_type` is on the link so the wave
--     that models reversals has the vouchers named.
--   * NO WORK LINK OF ITS OWN. A Tally-sourced register row is proposed a
--     Work by 0115's own `proposeWorkLink`, through the same
--     propose-and-prove discipline and the same three link methods. This
--     migration adds no fourth.
--   * NO PAYMENTS. The receipts are wave T3, and are blocked on ruling 14.
--   * NOTHING WRITES `match_method = 'manual'` IN THIS WAVE. The value is
--     admitted because a person linking a voucher by hand must not be
--     recorded as an automatic match — the same reason 0115 admits
--     `manual` on both of its link methods — and the route that writes it
--     lands with the wave that needs it.
--
-- ---------------------------------------------------------------------
-- SQLSTATEs: the 23T block, continuing 0118's allocation.
--
--   23T01  a census row's Tally identity is fixed          (0118)
--   23T02  a Tally invoice link is what the export said
--   23T03  one voucher sources at most one live register row
--
-- ---------------------------------------------------------------------
-- ROLLBACK. One new table with its policy, indexes and guard; one column
-- and two dropped NOT NULLs on `imported_invoices`; one replaced guard
-- function. Reversing it is dropping the table, dropping `source`, and
-- restoring the two NOT NULLs — which is lossless only while no
-- Tally-sourced invoice has been imported, because such a row has no
-- `zoho_invoice_id` and no `sub_total` to restore a NOT NULL over. That
-- is stated here rather than discovered: the reversal window closes at
-- the first Tally invoice import, and after it the exit is discarding
-- those rows, which the register already supports.
--
-- CENSUS.
--
--   Tables created                1
--   Tables altered                1
--   Functions created             1
--   Functions replaced            1
--   Triggers created              1
--   Indexes created               4
--   RLS policies created          1

-- ═════════════════════════════════════════════════════════════════════
-- § 1. THE REGISTER GAINS A SOURCE
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE imported_invoices
  ADD COLUMN source text NOT NULL DEFAULT 'zoho'
    CHECK (source IN ('zoho', 'tally'));

COMMENT ON COLUMN imported_invoices.source IS
  'Which system this historical invoice was read from. Owner ruling 23: the pre-Zoho Tally sales vouchers join this register behind a discriminator, and where BOTH systems hold an invoice Zoho is authoritative and the Tally voucher is provenance — so no Tally row is imported for an invoice Zoho already carries. Frozen on arrival like everything else the export stated.';

-- ZOHO'S IDENTIFIER IS ZOHO'S. A Tally-sourced row carries none, and the
-- partial unique index over this column is untouched: NULLs do not
-- collide, so it stays the Zoho idempotency key and ignores Tally rows.
ALTER TABLE imported_invoices ALTER COLUMN zoho_invoice_id DROP NOT NULL;

-- TALLY STATES NO SUB-TOTAL. See § B: deriving one would mean this
-- register recomputing money another system stated.
ALTER TABLE imported_invoices ALTER COLUMN sub_total DROP NOT NULL;

ALTER TABLE imported_invoices
  ADD CONSTRAINT imported_invoices_source_shape_check CHECK (
    (source = 'zoho') = (zoho_invoice_id IS NOT NULL)
    AND (source = 'tally' OR sub_total IS NOT NULL)
  );

-- The register reads by source on the census screen and the Tally import
-- counts its own rows; partial because 'zoho' is and will remain the bulk
-- of the register and an index over it would be the table.
CREATE INDEX imported_invoices_tally_source_idx
  ON imported_invoices (organisation_id, invoice_date DESC, id)
  WHERE source = 'tally';

-- ═════════════════════════════════════════════════════════════════════
-- § 2. THE CROSS-REFERENCE
-- ═════════════════════════════════════════════════════════════════════

CREATE TABLE tally_invoice_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- Tally's own identifier for the VOUCHER, present on 83,061 of 83,061
  -- real vouchers, and therefore the idempotency key. Opaque text: it is
  -- another system's id and this schema bounds it and asserts nothing
  -- else about its shape. The real ones are 45 characters.
  tally_guid text NOT NULL CHECK (
    btrim(tally_guid) = tally_guid
    AND length(tally_guid) BETWEEN 1 AND 80
    AND tally_guid !~ '[[:cntrl:]]'
  ),

  -- Tally's edit counter for the voucher. Ruling 2 stores it on every
  -- imported row so the single post-training top-up re-read can see what
  -- moved without any sync machinery. NULLABLE, and null means UNKNOWN
  -- rather than zero, for 0118's reason exactly.
  tally_alterid bigint CHECK (tally_alterid IS NULL OR tally_alterid >= 0),

  -- Which of the three voucher types the census admits this is. Stored
  -- rather than inferred: a credit note reverses an invoice and a sales
  -- voucher raises one, and the wave that models reversals needs to find
  -- them without re-reading the file.
  tally_voucher_type text NOT NULL CHECK (
    tally_voucher_type IN ('Sales', 'Credit Note', 'Debit Note')
  ),
  tally_voucher_date date NOT NULL,

  -- The voucher's own number, and the reference it carries. BOTH ARE
  -- NULLABLE and the reason is a real property of this company's Tally:
  -- `Sales` is the one voucher type numbered MANUALLY, so 341 real sales
  -- vouchers carry no `VOUCHERNUMBER` at all and the document number
  -- lives in `REFERENCE` or in the bill allocation instead. A schema that
  -- required a voucher number would refuse a third of the history.
  tally_voucher_number text CHECK (
    tally_voucher_number IS NULL
    OR (length(btrim(tally_voucher_number)) BETWEEN 1 AND 60
        AND tally_voucher_number !~ '[[:cntrl:]]')
  ),
  tally_reference text CHECK (
    tally_reference IS NULL
    OR (length(btrim(tally_reference)) BETWEEN 1 AND 200
        AND tally_reference !~ '[[:cntrl:]]')
  ),

  -- The party ledger the voucher names. Kept verbatim on the link for
  -- rule 7's reason — what the voucher SAID does not change when a
  -- ledger is renamed in Tally — and it is what an operator searches
  -- TallyPrime for when they go and look.
  tally_party_ledger text NOT NULL CHECK (
    btrim(tally_party_ledger) = tally_party_ledger
    AND length(tally_party_ledger) BETWEEN 1 AND 300
    AND tally_party_ledger !~ '[[:cntrl:]]'
  ),

  -- The voucher's value, as the census defines it: the party line's own
  -- figure, which carries the document total even on the two thirds of
  -- sales vouchers that are in inventory mode and book their income
  -- inside the stock allocations.
  tally_amount money_amount NOT NULL,

  imported_invoice_id uuid NOT NULL,

  -- How the correspondence was found.
  --
  --   origin           this register row EXISTS because this voucher
  --                    does — the pre-Zoho half of ruling 23. There is no
  --                    Zoho counterpart and nothing was matched.
  --   exact_number     the voucher's number, reference or bill
  --                    allocation equals the invoice's number once case
  --                    and punctuation are removed. 721 real links.
  --   serial_tolerant  the same five-digit serial with a DIFFERENT
  --                    customer-code segment, confirmed on the amount,
  --                    the GSTIN or the party name. 5 real links, and the
  --                    confirmation is not optional — see § 4.3 of the
  --                    census and the reader's own note: one real pair
  --                    shares a serial across two unrelated customers
  --                    five months apart, and serial alone would have
  --                    linked them.
  --   manual           a person's own choice. Nothing in wave T2 writes
  --                    it; it is admitted so that when a route does, the
  --                    row cannot claim an automatic match that never
  --                    happened.
  match_method text NOT NULL CHECK (
    match_method IN ('origin', 'exact_number', 'serial_tolerant', 'manual')
  ),

  -- The text that produced the match, so a person reads WHY two
  -- documents were tied together rather than only that they were.
  match_evidence text CHECK (
    match_evidence IS NULL OR length(btrim(match_evidence)) BETWEEN 1 AND 300
  ),

  -- RULING 21. The two systems state different figures for this
  -- correspondence, and neither is overwritten. A disputed figure joins
  -- no sum until the owner rules on the row.
  disputed boolean NOT NULL DEFAULT false,

  -- The two sums the dispute is BETWEEN, over the whole connected
  -- component (§ C). Stored so the disagreement can be read without
  -- re-deriving the component, which needs the whole file.
  component_tally_total money_amount,
  component_invoice_total money_amount,

  source_filename text NOT NULL CHECK (
    btrim(source_filename) = source_filename
    AND length(source_filename) BETWEEN 1 AND 260
    AND source_filename !~ '[[:cntrl:]]'
  ),
  imported_by_user_id text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  -- The composite tenant reference 0115 uses for its own lines: the
  -- invoice is named with its organisation, so a link cannot be attached
  -- to another tenant's invoice even by a writer reaching the table
  -- another way.
  FOREIGN KEY (organisation_id, imported_invoice_id)
    REFERENCES imported_invoices (organisation_id, id),

  -- AN ORIGIN LINK MATCHED NOTHING, so it claims nothing. It carries no
  -- evidence, and it cannot be disputed: there is no second figure to
  -- disagree with.
  CONSTRAINT tally_invoice_links_origin_shape_check CHECK (
    match_method <> 'origin'
    OR (match_evidence IS NULL AND disputed = false
        AND component_tally_total IS NULL AND component_invoice_total IS NULL)
  ),

  -- A dispute travels as one fact: the flag and both figures it is
  -- between. A flag with no figures is a claim nobody can check.
  CONSTRAINT tally_invoice_links_dispute_shape_check CHECK (
    disputed = false
    OR (component_tally_total IS NOT NULL AND component_invoice_total IS NOT NULL)
  )
);

COMMENT ON TABLE tally_invoice_links IS
  'One correspondence between a TallyPrime sales-side voucher and a row of the historical invoice register (0115). Owner ruling 12: the cross-reference is a separate provenance-stamped table rather than a column, which is also the only shape the data admits — 97 real vouchers name more than one invoice and 47 real invoices name more than one voucher. Insert-only, like the register it points at: no UPDATE and no DELETE, and a correction is a discard and a re-import.';
COMMENT ON COLUMN tally_invoice_links.tally_guid IS
  'Tally''s own stable identifier for the voucher, and therefore the idempotency key: re-importing the same export adds the links that are missing and collides on the ones that are not.';
COMMENT ON COLUMN tally_invoice_links.match_method IS
  'How the correspondence was found: origin (this register row exists because this voucher does — the pre-Zoho half of ruling 23), exact_number, serial_tolerant (confirmed on amount, GSTIN or party name, never on the serial alone), or a person''s own choice.';
COMMENT ON COLUMN tally_invoice_links.disputed IS
  'Owner ruling 21: Tally and Zoho state different figures for this correspondence, both are imported, and a disputed figure joins no sum until the owner rules on the row. The register''s billed total excludes an invoice carrying one, exactly as it excludes a voided invoice.';
COMMENT ON COLUMN tally_invoice_links.component_tally_total IS
  'The Tally side of the disagreement, summed over the whole connected component rather than over this pair — the correspondence is many-to-many, so a per-pair comparison is meaningless where one voucher covers several bills.';

ALTER TABLE tally_invoice_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_invoice_links FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY tally_invoice_links_tenant_policy ON tally_invoice_links
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No UPDATE and no DELETE. A link records what one export said about one
-- correspondence; it is superseded by a discard on the invoice it points
-- at, not by being rewritten. 0115's lines table keeps the same posture
-- for the same reason.
GRANT SELECT, INSERT ON tally_invoice_links TO auto_mb_app;

-- THE IDEMPOTENCY KEY, over the PAIR. See § D: one voucher may name
-- several invoices and one invoice several vouchers, and it is the pair
-- that appears once.
CREATE UNIQUE INDEX tally_invoice_links_pair_key
  ON tally_invoice_links (organisation_id, tally_guid, imported_invoice_id);

-- The register's own read: which vouchers correspond to this invoice.
-- Doubles as the composite foreign key's index, for the reason 0115
-- gives — an unindexed foreign key turns every parent delete into a scan.
CREATE INDEX tally_invoice_links_invoice_idx
  ON tally_invoice_links (organisation_id, imported_invoice_id, tally_voucher_date);

-- The register's billed total excludes invoices carrying a disputed
-- link (ruling 21), which is an anti-join this index answers directly.
-- Partial, because 10 of 736 real links are disputed.
CREATE INDEX tally_invoice_links_disputed_idx
  ON tally_invoice_links (organisation_id, imported_invoice_id)
  WHERE disputed;

-- ═════════════════════════════════════════════════════════════════════
-- § 3. THE GUARDS
-- ═════════════════════════════════════════════════════════════════════
--
-- Layer two of two. The import route refuses first, under an advisory
-- lock, so an operator gets a named refusal with a remedy; these are the
-- arm that holds when a writer reaches the tables another way.
--
-- `SET search_path` for the reason every guard in this schema gives: a
-- function that resolves its own identifiers through the caller's path is
-- a rule a shadowing object in a writable schema can rewrite. Not
-- SECURITY DEFINER: every table touched is one the caller may already
-- read under RLS.

CREATE FUNCTION app_private.guard_tally_invoice_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_discarded timestamptz;
  v_source text;
  v_conflict uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The application role holds no UPDATE on this table, so this arm is
    -- for a writer that reaches it another way. It is not decoration:
    -- 0115 records its lines as facts nobody can rewrite and the one
    -- thing that makes that true is a grant, which a future migration can
    -- widen without noticing.
    RAISE EXCEPTION
      'tally invoice link % records what an export said and is never edited',
      OLD.id
      USING ERRCODE = '23T02';
  END IF;

  -- A link points at an invoice that exists in this tenant and has not
  -- been withdrawn. Linking a Tally voucher to a discarded invoice would
  -- revive withdrawn evidence sideways.
  SELECT i.discarded_at, i.source INTO v_discarded, v_source
  FROM imported_invoices i
  WHERE i.organisation_id = NEW.organisation_id AND i.id = NEW.imported_invoice_id;

  IF v_source IS NULL THEN
    RAISE EXCEPTION
      'historical invoice % is not one this transaction can read',
      NEW.imported_invoice_id
      USING ERRCODE = '23T02';
  END IF;

  IF v_discarded IS NOT NULL THEN
    RAISE EXCEPTION
      'historical invoice % was discarded and takes no further Tally links',
      NEW.imported_invoice_id
      USING ERRCODE = '23T02';
  END IF;

  -- AN ORIGIN LINK IS THE PROVENANCE OF A TALLY-SOURCED ROW, so the two
  -- have to agree about which system the invoice came from. A 'zoho' row
  -- claiming a Tally origin would say the register imported a document
  -- from a file it never read.
  IF (NEW.match_method = 'origin') <> (v_source = 'tally') THEN
    RAISE EXCEPTION
      'a Tally-sourced historical invoice carries exactly one origin link and a Zoho-sourced one carries none; invoice % is %',
      NEW.imported_invoice_id, v_source
      USING ERRCODE = '23T02';
  END IF;

  -- ONE VOUCHER SOURCES AT MOST ONE LIVE REGISTER ROW. The import route
  -- checks this first, under the per-organisation advisory lock, so this
  -- arm is what holds if two imports ever run without it. The check is
  -- over LIVE rows only, which is the same reading 0115's partial unique
  -- index takes: discarding a Tally-sourced invoice and importing the
  -- corrected export is the correction path, and a rule that counted the
  -- withdrawn row would close it.
  IF NEW.match_method = 'origin' THEN
    SELECT l.imported_invoice_id INTO v_conflict
    FROM tally_invoice_links l
    JOIN imported_invoices i
      ON i.organisation_id = l.organisation_id AND i.id = l.imported_invoice_id
    WHERE l.organisation_id = NEW.organisation_id
      AND l.tally_guid = NEW.tally_guid
      AND l.match_method = 'origin'
      AND l.imported_invoice_id <> NEW.imported_invoice_id
      AND i.discarded_at IS NULL
    LIMIT 1;
    IF v_conflict IS NOT NULL THEN
      RAISE EXCEPTION
        'Tally voucher % already sourced historical invoice %, which is still on the register',
        NEW.tally_guid, v_conflict
        USING ERRCODE = '23T03';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_tally_invoice_link() IS
  'A Tally invoice link is written once, against an invoice that exists in this tenant and has not been discarded, and its origin arm agrees with that invoice''s own source. One voucher sources at most one LIVE register row, so a discard-and-reimport works and a double import does not. Never edited: the application role holds no UPDATE, and this refuses one anyway so the rule survives a grant somebody widens later.';

CREATE TRIGGER tally_invoice_links_guard
BEFORE INSERT OR UPDATE ON tally_invoice_links
FOR EACH ROW EXECUTE FUNCTION app_private.guard_tally_invoice_link();

-- ---------------------------------------------------------------------
-- 0115'S OWN GUARD GAINS THE NEW COLUMN.
--
-- The function is REPLACED rather than left alone, and the reason is the
-- whole point of it: it freezes the register row by naming every column
-- the export stated, and a column absent from that list is a column an
-- UPDATE may move. `source` is what the export said about where the row
-- came from, so it is frozen with the rest. Everything else below is
-- byte-identical to 0115.

CREATE OR REPLACE FUNCTION app_private.guard_imported_invoice()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- EVERYTHING THE EXPORT SAID, frozen. The three hinges — the Work
    -- link, the contact link and the discard — are absent from this row
    -- comparison and are the only columns an UPDATE may move.
    --
    -- `issued` is generated from `irn`, so freezing `irn` freezes it too;
    -- listing a generated column here would compare a value PostgreSQL
    -- has not computed yet.
    IF ROW(
         NEW.id, NEW.organisation_id, NEW.source, NEW.zoho_invoice_id,
         NEW.invoice_number,
         NEW.invoice_date, NEW.customer_zoho_id, NEW.customer_name,
         NEW.customer_gstin, NEW.place_of_supply, NEW.zoho_status,
         NEW.irn, NEW.ack_number, NEW.ack_date, NEW.qr_payload,
         NEW.reference_text, NEW.sub_total, NEW.total, NEW.balance,
         NEW.round_off, NEW.raw_row, NEW.imported_by_user_id, NEW.created_at
       ) IS DISTINCT FROM ROW(
         OLD.id, OLD.organisation_id, OLD.source, OLD.zoho_invoice_id,
         OLD.invoice_number,
         OLD.invoice_date, OLD.customer_zoho_id, OLD.customer_name,
         OLD.customer_gstin, OLD.place_of_supply, OLD.zoho_status,
         OLD.irn, OLD.ack_number, OLD.ack_date, OLD.qr_payload,
         OLD.reference_text, OLD.sub_total, OLD.total, OLD.balance,
         OLD.round_off, OLD.raw_row, OLD.imported_by_user_id, OLD.created_at
       ) THEN
      RAISE EXCEPTION
        'imported invoice % records what the export said and cannot be rewritten; only its Work link, its contact link and its discard may change',
        OLD.id
        USING ERRCODE = '23X01';
    END IF;

    -- A discard is final. Un-discarding would make the record of a
    -- mistake a suggestion, and re-linking a discarded row would file
    -- withdrawn evidence against a live Work.
    IF OLD.discarded_at IS NOT NULL THEN
      RAISE EXCEPTION
        'imported invoice % was discarded on % and cannot be changed',
        OLD.id, OLD.discarded_at::date
        USING ERRCODE = '23X01';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;
