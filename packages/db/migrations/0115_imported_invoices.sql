SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0115: the invoices this organisation raised before this
-- product existed.
--
-- Owner ruling, live-testing corrections item 25 (Zoho half).
--
-- ---------------------------------------------------------------------
-- THE PROBLEM, EXACTLY.
--
-- 638 invoices raised in Zoho Books between January 2023 and today —
-- railway work billed against LOAs, and private orders billed against
-- nothing — are unanswerable from inside this application. "What have we
-- billed this customer", "what has been billed on this Work", "which
-- financial year did that invoice fall in" all have answers, and all of
-- the answers are in a CSV on somebody's laptop.
--
-- ---------------------------------------------------------------------
-- WHY THESE CANNOT BE `tax_invoices` ROWS, WHICH IS THE FIRST THING
-- ANYBODY WOULD TRY.
--
-- Migration 0035 built `tax_invoices` as the register of invoices THIS
-- APPLICATION RAISES, and every one of its load-bearing rules is false of
-- a historical row:
--
--   * `measurement_book_id` is NOT NULL. A history row has no Measurement
--     Book, because the measurement it was billed from was made in a
--     different system or on paper. Making the column nullable to admit
--     history would remove the one link that makes a live invoice
--     traceable to what was measured.
--   * The number is minted from `tax_invoice_counters`, gap-free per
--     financial year, and 0064's unique index is on the SEQUENCE. A
--     historical number was minted by Zoho, in Zoho's series, and pouring
--     638 of them into this counter would either collide with the live
--     series or fabricate a sequence that never existed.
--   * A submitted invoice freezes `issued_snapshot`, and 0044 makes the
--     frozen shape the truth the PDF and the e-way bill are rendered
--     from. There is no such snapshot for a Zoho invoice, and
--     manufacturing one would be this application asserting the contents
--     of a document it never produced.
--   * The 0052 money backstops recompute the tax heads from
--     `taxable_value` and `gst_rate` and refuse a row whose arithmetic
--     they cannot reproduce. Zoho's rounding is Zoho's, and a history row
--     that fails our arithmetic is still what was filed with the
--     government.
--
-- So this is a SEPARATE, IMMUTABLE REGISTER. It is not the invoice
-- register with a flag on it; it is a record of what another system
-- already did, and the schema says so by sharing no counter, no snapshot
-- and no guard with `tax_invoices`.
--
-- WHAT IT DELIBERATELY IS NOT:
--
--   * Not a receivable. `Balance` is imported as EVIDENCE and nothing
--     reads it as money owed — the receipts against these invoices are in
--     Tally, which this pack does not touch at all. A ledger built on a
--     balance from a system that never saw the payments would be
--     confidently wrong.
--   * Not billable. Nothing downstream may raise, measure, adjust or
--     settle against a row here. It answers questions; it does not
--     participate.
--   * Not an e-invoice record. The IRN, acknowledgement and QR travel as
--     evidence of what the IRP returned in 2023. No route re-registers,
--     cancels or verifies them.
--
-- ---------------------------------------------------------------------
-- ISSUED-NESS IS DERIVED FROM THE IRN, AND THE RAW STATUS IS EVIDENCE.
--
-- The export's `Invoice Status` column says `Draft` on 372 of the 638
-- invoices, and 586 of the 638 carry an Invoice Reference Number. The two
-- populations overlap heavily: the column is a Zoho workflow flag that
-- nobody advanced after the invoice was e-invoiced and sent. Believing it
-- would file most of this organisation's billing history as drafts.
--
-- An IRN is the government's own acknowledgement that the invoice was
-- registered. So `issued` is GENERATED from `irn IS NOT NULL` — not a
-- column a writer sets, because a derived fact that can also be asserted
-- is a fact with two answers — and `zoho_status` is kept verbatim beside
-- it so the disagreement stays visible rather than being resolved away.
--
-- ---------------------------------------------------------------------
-- THE RAW ROW, AND WHY THE WHOLE OF IT.
--
-- The export carries 193 columns; this schema types 22 of them. The rest
-- are kept as jsonb on the row, which is 0066's `extraction_payload`
-- discipline and 0094's cells rule read from the other side: the typed
-- columns are what the register is QUERIED on, and the raw row is what
-- answers a question nobody anticipated without asking the organisation
-- to find the CSV again.
--
-- It is stored on BOTH tables, and the duplication is deliberate. Zoho
-- repeats every invoice-level column on every line row, so the header's
-- copy is its first line's row and each line carries its own. The
-- alternative — deriving the header's raw row by subtracting the columns
-- this schema decided are per-line — would encode that decision in code,
-- which is a second, weaker truth sitting in front of the first.
--
-- ⚠ The raw row is UNTRUSTED TEXT from outside this organisation's
-- control. It is stored, never resolved: nothing derives a path, a
-- template or an identifier from it, every write below is parameterised,
-- and the reader never coerces a cell before the typed column's own
-- CHECK has seen it.
--
-- ---------------------------------------------------------------------
-- IMMUTABLE, WITH EXACTLY THREE HINGES.
--
-- A row here is a record of a document another system issued, so it is
-- frozen on arrival — with three exceptions, each of which is an
-- ANNOTATION this organisation makes about the record rather than a
-- change to it:
--
--   * the Work link (`work_id`, `link_method`), because it is proposed by
--     a regex and confirmed by a person, and a person who confirms wrongly
--     has to be able to correct it;
--   * the contact link (`contact_id`, `contact_match_method`), same
--     reasoning, plus: a customer added to the master AFTER the import
--     should become linkable without a re-import;
--   * the discard, because there is no DELETE grant and a row imported
--     from the wrong file needs an exit that leaves the mistake on the
--     record.
--
-- Everything else — the number, the date, the customer identity, the
-- money, the IRN, the raw row — raises 23X01. The lines raise 23X02 and
-- have no hinge at all.
--
-- RE-UPLOAD INSERTS, IT DOES NOT REWRITE. A partial unique index on
-- `(organisation_id, zoho_invoice_id) WHERE discarded_at IS NULL` makes
-- the export's own stable id the idempotency key, and the import route
-- inserts `ON CONFLICT DO NOTHING`: uploading the same file twice adds
-- the invoices that were not there and leaves the ones that were exactly
-- as they are. That is the only reading compatible with the immutability
-- above — an upsert that UPDATED would let a second export silently
-- rewrite a filed invoice's amount, which is precisely what the guard
-- exists to refuse. An invoice whose historical record is genuinely wrong
-- is discarded and re-imported, visibly — which is the whole reason the
-- key is partial, and § 1 states that argument where the index is.
--
-- ---------------------------------------------------------------------
-- SQLSTATEs: the 23X block, which this migration is the first to use, by
-- coordinator allocation rather than by taking the next free letter —
-- which is how 23R came to be claimed twice (0111's header tells that
-- story in full). `I` and `O` are skipped throughout the family because
-- they read as 1 and 0, and the one thing an operator does with a
-- SQLSTATE is read it aloud.
--
--   23X01  an imported invoice's record is what the export said
--   23X02  an imported invoice's lines are what the export said
--
-- ---------------------------------------------------------------------
-- WORK SUPERSESSION (0071). Both tables reach `works` and NEITHER blocks
-- a supersede; they are declared exempt in
-- `apps/server/src/work-supersede.ts` with the reason. In short: a Work
-- eligible for withdrawal has no challan, no Measurement Book and no
-- invoice of its own, and a historical invoice is not a document raised
-- FROM that Work — it is a record of billing that happened before the
-- Work existed here, annotated afterwards with a link a person may clear.
--
-- ROLLBACK. Nothing here rewrites an existing row: it is two new tables,
-- their policies, their indexes and two guards. Reversing it is dropping
-- them, which is only lossless while nothing has been imported.
--
-- CENSUS.
--
--   Tables created                2
--   Tables altered                0
--   Functions created             2
--   Triggers created              2
--   Indexes created               8
--   RLS policies created          2

-- ═════════════════════════════════════════════════════════════════════
-- § 1. THE INVOICE
-- ═════════════════════════════════════════════════════════════════════

CREATE TABLE imported_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- Zoho's own identifier for the invoice, and therefore the idempotency
  -- key. Opaque text rather than a number: it is another system's id and
  -- this schema has no business asserting its shape beyond bounding it.
  zoho_invoice_id text NOT NULL CHECK (
    btrim(zoho_invoice_id) = zoho_invoice_id
    AND length(zoho_invoice_id) BETWEEN 1 AND 60
    AND zoho_invoice_id !~ '[[:cntrl:]]'
  ),

  -- The number as it was printed. NOT minted here, not unique here: a
  -- Zoho series may legitimately repeat a number across financial years,
  -- and refusing that would refuse history that actually happened.
  invoice_number text NOT NULL CHECK (
    btrim(invoice_number) = invoice_number
    AND length(invoice_number) BETWEEN 1 AND 60
    AND invoice_number !~ '[[:cntrl:]]'
  ),
  invoice_date date NOT NULL,

  -- The customer as the invoice named them. Stored on the row rather than
  -- reached through the link below, because the link is an annotation
  -- that may be absent, corrected or pointed at a master row whose name
  -- has since been edited — and what the invoice SAID does not change
  -- when the master does. Same rule 7 as every issued document here.
  customer_zoho_id text CHECK (
    customer_zoho_id IS NULL OR length(btrim(customer_zoho_id)) BETWEEN 1 AND 60
  ),
  customer_name text NOT NULL CHECK (
    length(btrim(customer_name)) BETWEEN 1 AND 300
  ),
  -- 0028's contacts GSTIN shape, both arms, so a historical GSTIN and a
  -- master one are the same kind of value.
  customer_gstin text CHECK (
    customer_gstin IS NULL
    OR customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
    OR customer_gstin ~ '^[0-9]{2}[0-9A-Z]{12}D$'
  ),
  place_of_supply text CHECK (
    place_of_supply IS NULL OR length(btrim(place_of_supply)) BETWEEN 1 AND 120
  ),

  -- The contacts master row this customer was matched to, where one was
  -- found. Nullable and correctable: an unmatched invoice is a visible,
  -- fixable state, and a WRONG match is neither.
  contact_id uuid,
  -- 'manual' is a person pointing this invoice at a customer the
  -- importer never proposed. Settled here rather than left to be noticed:
  -- the relink route can set this column, and recording a person's choice
  -- as 'name' would put a claim about automatic matching on a row nothing
  -- automatic touched.
  contact_match_method text CHECK (
    contact_match_method IS NULL
      OR contact_match_method IN ('gstin', 'name', 'manual')
  ),

  -- Zoho's workflow flag, verbatim, as EVIDENCE. See the header: it says
  -- `Draft` on invoices that were e-invoiced and filed.
  zoho_status text CHECK (
    zoho_status IS NULL OR length(btrim(zoho_status)) BETWEEN 1 AND 60
  ),

  -- The e-invoice evidence. `irn` is what the IRP returned; the
  -- acknowledgement and the QR payload are what came back with it.
  irn text CHECK (irn IS NULL OR length(btrim(irn)) BETWEEN 1 AND 100),
  ack_number text CHECK (
    ack_number IS NULL OR length(btrim(ack_number)) BETWEEN 1 AND 60
  ),
  ack_date date,
  qr_payload text CHECK (
    qr_payload IS NULL OR length(qr_payload) BETWEEN 1 AND 8000
  ),

  -- DERIVED, not asserted. An invoice that reached the IRP was issued,
  -- whatever the workflow flag says. A generated column is the only shape
  -- in which this fact cannot acquire a second answer.
  issued boolean NOT NULL GENERATED ALWAYS AS (irn IS NOT NULL) STORED,

  -- The `PurchaseOrder` column: free text carrying the LOA or PO
  -- reference, which is what the Work proposal reads.
  reference_text text CHECK (
    reference_text IS NULL OR length(reference_text) BETWEEN 1 AND 2000
  ),

  sub_total money_amount NOT NULL,
  total money_amount NOT NULL,
  -- EVIDENCE, NOT A RECEIVABLE. See the header.
  balance money_amount,
  round_off money_amount,

  -- The Work this invoice bills for, where a person confirmed one.
  --
  --   pl_code    a v1 work code was found in the invoice's text
  --   loa_match  the Work's LOA letter number was found in it
  --   manual     a person chose the Work with no machine proposal behind
  --              it, or corrected one
  --
  -- Every one of the three is a person's decision: the first two name
  -- what the machine PROPOSED and the person accepted, which is the
  -- distinction AGENTS.md rule 10 draws.
  work_id uuid,
  link_method text CHECK (
    link_method IS NULL OR link_method IN ('pl_code', 'loa_match', 'manual')
  ),
  linked_by_user_id text,
  linked_at timestamptz,

  -- The whole CSV row, verbatim. See the header.
  raw_row jsonb NOT NULL CHECK (jsonb_typeof(raw_row) = 'object'),

  imported_by_user_id text NOT NULL,

  -- The exit, because there is no DELETE grant: a row imported from the
  -- wrong file, or an invoice Zoho itself voided and re-issued, is
  -- discarded and stays. 0066's and 0111's shape verbatim.
  discarded_at timestamptz,
  discarded_by_user_id text,
  discard_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  -- The idempotency key is NOT here. It is a partial unique index below,
  -- because it must exclude discarded rows, and a table constraint cannot
  -- be partial. The index carries the reasoning.

  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, contact_id) REFERENCES contacts(organisation_id, id),

  -- A link travels as one fact: the Work, how it was arrived at, who
  -- decided and when. A `work_id` with no method is a link nobody can
  -- explain, and a method with no Work is a claim about nothing.
  CONSTRAINT imported_invoices_work_link_shape_check CHECK (
    (work_id IS NULL AND link_method IS NULL
      AND linked_by_user_id IS NULL AND linked_at IS NULL)
    OR
    (work_id IS NOT NULL AND link_method IS NOT NULL
      AND linked_by_user_id IS NOT NULL AND linked_at IS NOT NULL)
  ),

  CONSTRAINT imported_invoices_contact_link_shape_check CHECK (
    (contact_id IS NULL) = (contact_match_method IS NULL)
  ),

  -- The acknowledgement belongs to the IRN. An ack number or a QR with no
  -- IRN behind it is e-invoice evidence for an invoice that was never
  -- registered.
  CONSTRAINT imported_invoices_irn_shape_check CHECK (
    irn IS NOT NULL
    OR (ack_number IS NULL AND ack_date IS NULL AND qr_payload IS NULL)
  ),

  CONSTRAINT imported_invoices_discard_shape_check CHECK (
    (discarded_at IS NULL AND discarded_by_user_id IS NULL
      AND discard_reason IS NULL)
    OR
    (discarded_at IS NOT NULL AND discarded_by_user_id IS NOT NULL
      AND (discard_reason IS NULL
           OR length(btrim(discard_reason)) BETWEEN 3 AND 500))
  )
);

COMMENT ON TABLE imported_invoices IS
  'An invoice this organisation raised in Zoho Books before this product existed, imported so the billing history is queryable in-system. Immutable evidence of another system''s document: it shares no counter, no snapshot and no guard with tax_invoices, nothing downstream may bill or settle against it, and only its Work link, its contact link and its discard may ever change.';
COMMENT ON COLUMN imported_invoices.zoho_invoice_id IS
  'Zoho''s own stable identifier, and therefore the idempotency key: re-uploading the export inserts the invoices that are missing and collides on the ones that are not.';
COMMENT ON COLUMN imported_invoices.zoho_status IS
  'The export''s Invoice Status column, verbatim, as evidence. NOT the issued signal: it reads Draft on 372 of the 638 real invoices, most of which carry an IRN. Read `issued` instead.';
COMMENT ON COLUMN imported_invoices.issued IS
  'Derived from IRN presence: an invoice the IRP registered was issued, whatever the workflow flag says. Generated rather than asserted, so the fact cannot acquire a second answer.';
COMMENT ON COLUMN imported_invoices.balance IS
  'What Zoho believed was outstanding. EVIDENCE ONLY — the receipts against these invoices are in Tally, which this register does not read, so nothing here treats this as an amount owed.';
COMMENT ON COLUMN imported_invoices.raw_row IS
  'The whole CSV row, verbatim, keyed by the file''s own header spelling. The typed columns are what the register is queried on; this is what answers a question nobody anticipated without a re-import. Untrusted text: stored, never resolved.';
COMMENT ON COLUMN imported_invoices.link_method IS
  'How the Work link was arrived at: a v1 work code found in the invoice text, the LOA letter number found in it, or a person''s own choice. All three are a person''s decision — the first two name what the importer proposed and the person confirmed.';

ALTER TABLE imported_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_invoices FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY imported_invoices_tenant_policy ON imported_invoices
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- Evidence never leaves. Discard is the only exit, as for loa_documents,
-- received_railway_bills and railway_measurements.
GRANT SELECT, INSERT, UPDATE ON imported_invoices TO auto_mb_app;

-- ─────────────────────────────────────────────────────────────────────
-- THE IDEMPOTENCY KEY, AND WHY IT IS PARTIAL.
--
-- Re-uploading the export inserts the invoices that are missing and
-- collides on the ones that are not. That is what makes a cutover import
-- survivable: an operator who is unsure whether it ran can run it again.
--
-- The uniqueness is over the LIVE rows only, because the discard is the
-- register's correction mechanism and a non-partial key silently disarms
-- it. An invoice imported from the wrong file is discarded — the row
-- stays, with the reason, because there is no DELETE grant — and the
-- corrected export is then uploaded. Under a non-partial key the
-- discarded row still owns the id, `ON CONFLICT DO NOTHING` skips the
-- corrected invoice, and the import reports it as ALREADY IMPORTED. The
-- operator is told the work is done and the register is left holding only
-- the withdrawn copy, which is the worst of the three possible outcomes:
-- wrong, and confidently reported as right.
--
-- Discarded rows keep no uniqueness of their own, deliberately: an
-- invoice may be imported and discarded more than once, and each attempt
-- is a separate thing that happened.
CREATE UNIQUE INDEX imported_invoices_zoho_id_key
  ON imported_invoices (organisation_id, zoho_invoice_id)
  WHERE discarded_at IS NULL;

-- The register reads newest first, per organisation.
CREATE INDEX imported_invoices_org_date_idx
  ON imported_invoices (organisation_id, invoice_date DESC, id DESC);

-- The Work deep-link (`?work=`), and the panel on Work detail. NON-partial
-- so it also serves the composite foreign key: the FK-index census
-- measures exactly this.
CREATE INDEX imported_invoices_work_idx
  ON imported_invoices (organisation_id, work_id, invoice_date DESC, id);

-- The contacts foreign key's own index, for the reason
-- vendor_invoices_work_idx gives: an unindexed foreign key turns every
-- parent delete into a scan.
CREATE INDEX imported_invoices_contact_idx
  ON imported_invoices (organisation_id, contact_id, invoice_date DESC, id);

-- The customer filter on the register, which is by NAME rather than by
-- contact: 83 distinct customers appear in the real export and not all of
-- them are in the master.
CREATE INDEX imported_invoices_customer_idx
  ON imported_invoices (organisation_id, lower(btrim(customer_name)), invoice_date DESC);

-- ═════════════════════════════════════════════════════════════════════
-- § 2. THE LINES
-- ═════════════════════════════════════════════════════════════════════
--
-- One row per CSV row, which is one row per invoice line. 585 of the 638
-- real invoices have exactly one; the longest has 27.
--
-- EVERY MONEY AND QUANTITY FIGURE IS NULLABLE, and that is not laxity. A
-- Zoho line legitimately carries no quantity (a lump-sum charge), no unit
-- and no HSN, and 14 of the 809 real rows carry no item name either.
-- Requiring them would refuse the history rather than record it; the one
-- thing that is NOT relaxed is the SHAPE of a figure that IS present,
-- which the `money_amount` and `quantity_amount` domains hold.
--
-- No UPDATE grant and no DELETE grant. A line is what the export said,
-- with no annotation to make about it: the two hinges this register has
-- are both on the header.

CREATE TABLE imported_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  imported_invoice_id uuid NOT NULL,

  -- The line's place in the export's own order, from 1. Not a sequence
  -- Zoho stated — it has none — so it is the reading order, which is what
  -- an operator comparing this screen to the PDF is looking at.
  position integer NOT NULL CHECK (position >= 1),

  item_name text CHECK (
    item_name IS NULL OR length(btrim(item_name)) BETWEEN 1 AND 300
  ),
  item_description text CHECK (
    item_description IS NULL OR length(item_description) BETWEEN 1 AND 4000
  ),
  quantity quantity_amount,
  usage_unit text CHECK (
    usage_unit IS NULL OR length(btrim(usage_unit)) BETWEEN 1 AND 40
  ),
  -- A RATE, not a money amount, and the real export is what settled it:
  -- `Item Price` carries three fraction digits on real lines (rates like
  -- 1234.568), because a unit price in this business is a rate per
  -- metre or per unit rather than a rupee figure. `money_amount` is
  -- numeric(18,2) and would have rounded the third digit away silently —
  -- so this takes the shape 0027 gave every rate column in this schema,
  -- numeric(18,6), and the reader refuses anything finer rather than
  -- truncating it. `item_total` IS money and stays money: it is what the
  -- line was billed at.
  item_price numeric(18, 6),
  item_total money_amount,

  -- Mixes a service code and goods HSNs in one column, because the
  -- organisation bills both. Text, and nothing infers a supply kind from
  -- it.
  hsn_sac text CHECK (hsn_sac IS NULL OR length(btrim(hsn_sac)) BETWEEN 1 AND 20),
  supply_type text CHECK (
    supply_type IS NULL OR length(btrim(supply_type)) BETWEEN 1 AND 40
  ),

  -- The per-line split as Zoho computed it. Stored, never recomputed: the
  -- 0052 backstops judge invoices this application raised, and a
  -- historical row that fails our arithmetic is still what was filed.
  cgst_rate numeric(5, 2) CHECK (
    cgst_rate IS NULL OR (cgst_rate >= 0 AND cgst_rate <= 100)
  ),
  sgst_rate numeric(5, 2) CHECK (
    sgst_rate IS NULL OR (sgst_rate >= 0 AND sgst_rate <= 100)
  ),
  igst_rate numeric(5, 2) CHECK (
    igst_rate IS NULL OR (igst_rate >= 0 AND igst_rate <= 100)
  ),
  cgst_amount money_amount,
  sgst_amount money_amount,
  igst_amount money_amount,

  raw_row jsonb NOT NULL CHECK (jsonb_typeof(raw_row) = 'object'),

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  -- The composite tenant reference 0087, 0091 and 0094 all use: the
  -- invoice is named with its organisation, so a line cannot be attached
  -- to another tenant's invoice even by a writer reaching the table
  -- another way.
  FOREIGN KEY (organisation_id, imported_invoice_id)
    REFERENCES imported_invoices (organisation_id, id),

  UNIQUE (organisation_id, imported_invoice_id, position)
);

COMMENT ON TABLE imported_invoice_lines IS
  'One line of an imported historical invoice, in the export''s own reading order, with the per-line tax split as Zoho computed it. Append-only: no UPDATE and no DELETE, because a line is what the export said and the two annotations this register admits are both on the header.';
COMMENT ON COLUMN imported_invoice_lines.position IS
  'The line''s place in the export''s reading order, from 1. Zoho states no line sequence; this is the order an operator comparing the screen to the printed invoice is looking at.';
COMMENT ON COLUMN imported_invoice_lines.cgst_rate IS
  'The rate Zoho applied, stored rather than recomputed. The 0052 money backstops judge invoices this application raised; a historical row whose arithmetic they cannot reproduce is still what was filed with the government.';

ALTER TABLE imported_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_invoice_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY imported_invoice_lines_tenant_policy ON imported_invoice_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT ON imported_invoice_lines TO auto_mb_app;

-- The FK's own index, unfiltered, and the order the detail screen reads.
CREATE INDEX imported_invoice_lines_invoice_idx
  ON imported_invoice_lines (organisation_id, imported_invoice_id, position);

-- The register's HSN/SAC filter — "what have we billed as a service" is
-- one of the two questions this history is being brought in to answer.
CREATE INDEX imported_invoice_lines_hsn_idx
  ON imported_invoice_lines (organisation_id, hsn_sac)
  WHERE hsn_sac IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════
-- § 3. THE GUARDS
-- ═════════════════════════════════════════════════════════════════════
--
-- Layer two of two. The import and link routes refuse first, under no
-- lock, so an operator gets a named 409 with a remedy; these are the arm
-- that holds when a writer reaches the tables another way.
--
-- `SET search_path` for the reason 0067, 0077, 0079, 0084, 0087, 0091 and
-- 0094 all give: a function that resolves its own identifiers through the
-- caller's path is a rule a shadowing object in a writable schema can
-- rewrite into whatever it likes. Not SECURITY DEFINER: every table
-- touched is one the caller may already read under RLS, and a definer
-- function here would read across tenants.

CREATE FUNCTION app_private.guard_imported_invoice()
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
         NEW.id, NEW.organisation_id, NEW.zoho_invoice_id, NEW.invoice_number,
         NEW.invoice_date, NEW.customer_zoho_id, NEW.customer_name,
         NEW.customer_gstin, NEW.place_of_supply, NEW.zoho_status,
         NEW.irn, NEW.ack_number, NEW.ack_date, NEW.qr_payload,
         NEW.reference_text, NEW.sub_total, NEW.total, NEW.balance,
         NEW.round_off, NEW.raw_row, NEW.imported_by_user_id, NEW.created_at
       ) IS DISTINCT FROM ROW(
         OLD.id, OLD.organisation_id, OLD.zoho_invoice_id, OLD.invoice_number,
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
    --
    -- Written as "no UPDATE at all", not "no CHANGE", and deliberately
    -- not as `ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*)` — the shape 0094's
    -- terminal-batch arm uses. `issued` is GENERATED, and PostgreSQL
    -- computes a generated column AFTER the BEFORE triggers run, so
    -- `NEW.*` carries a null there against OLD's stored value and the
    -- whole-row comparison is unconditionally true. It would happen to
    -- refuse the right writes, for a reason that is not the one written
    -- down, until somebody dropped the generated column and quietly
    -- reopened the hole.
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

COMMENT ON FUNCTION app_private.guard_imported_invoice() IS
  'An imported invoice is a record of a document another system issued: everything the export stated is frozen on arrival, a discard is final, and the only writes an UPDATE may make are the Work link, the contact link and the discard itself. The routes refuse each of these first so an operator gets a remedy; this is the arm that holds under concurrency and against a writer reaching the table another way.';

CREATE TRIGGER imported_invoices_guard
BEFORE INSERT OR UPDATE ON imported_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_imported_invoice();

CREATE FUNCTION app_private.guard_imported_invoice_line()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_discarded timestamptz;
  v_imported timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The application role holds no UPDATE on this table, so this arm is
    -- for a writer that reaches it another way. It is not decoration:
    -- 0080 recorded a vendor invoice as facts nobody could rewrite and
    -- the one thing that made that true was a grant, which a future
    -- migration can widen without noticing.
    RAISE EXCEPTION
      'imported invoice line % is what the export said and is never edited',
      OLD.id
      USING ERRCODE = '23X02';
  END IF;

  -- A line belongs to an invoice that is still being imported. Adding one
  -- to an invoice imported last month would change what a completed
  -- import is on record as having contained — and adding one to a
  -- DISCARDED invoice would revive withdrawn evidence a line at a time.
  SELECT i.discarded_at, i.created_at INTO v_discarded, v_imported
  FROM imported_invoices i
  WHERE i.organisation_id = NEW.organisation_id AND i.id = NEW.imported_invoice_id;

  IF v_imported IS NULL THEN
    RAISE EXCEPTION
      'imported invoice % is not one this transaction can read',
      NEW.imported_invoice_id
      USING ERRCODE = '23X02';
  END IF;

  IF v_discarded IS NOT NULL THEN
    RAISE EXCEPTION
      'imported invoice % was discarded and takes no further lines',
      NEW.imported_invoice_id
      USING ERRCODE = '23X02';
  END IF;

  -- AND THE ARM THE PARAGRAPH ABOVE ACTUALLY PROMISED: the invoice must be
  -- one THIS transaction imported. `created_at` defaults to `now()`, which
  -- is `transaction_timestamp()`, so an invoice inserted by this
  -- transaction carries this transaction's own timestamp and one imported
  -- last month does not.
  --
  -- Without it the two checks above only refuse a MISSING or DISCARDED
  -- parent, and appending a line to a completed, live import — which
  -- changes what a finished import is on record as having contained, and
  -- with it every total the register computes from the lines — was
  -- allowed. The import route writes its lines in the same transaction as
  -- its invoices, so nothing legitimate is refused here.
  IF v_imported <> transaction_timestamp() THEN
    RAISE EXCEPTION
      'imported invoice % was imported by an earlier transaction and its lines are complete',
      NEW.imported_invoice_id
      USING ERRCODE = '23X02';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_imported_invoice_line() IS
  'A line of an imported invoice is written once, into an invoice that exists in this tenant, has not been discarded, and is being imported by this same transaction. Never edited: the application role holds no UPDATE, and this refuses one anyway so the rule survives a grant somebody widens later.';

CREATE TRIGGER imported_invoice_lines_guard
BEFORE INSERT OR UPDATE ON imported_invoice_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_imported_invoice_line();
