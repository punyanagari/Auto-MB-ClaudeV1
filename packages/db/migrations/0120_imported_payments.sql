SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0120: railway receipts as imported payments, with per-head
-- deduction attribution — wave T3 of the Tally migration train.
--
-- Survey: `docs/reference/TALLY-MAPPING-CENSUS.md`, § 3 and § 4.4.
-- Owner rulings of 22 Aug 2026: 2, 4, 10, 13, 15, 16, 17, 19, 20; and the
-- ruling of 23 Aug 2026 that closed question 14.
--
-- ---------------------------------------------------------------------
-- THE PROBLEM, EXACTLY.
--
-- A railway does not pay a bill. It pays a bill MINUS the deductions it
-- makes against it, and it says so on one voucher: the gross booked to
-- the customer, the net to a bank, and every deduction to its own head.
-- The census read 2,025 `Receipt` vouchers and found 769 of them carrying
-- deduction lines in exactly that shape (§ 3).
--
-- Migration 0114 already names five deduction heads for the OPENING
-- position of a Work — what was withheld before this product existed. It
-- states a cumulative figure per head per Work. This states the same five
-- heads per RECEIPT, which is the evidence under that figure, and it is a
-- separate table for the reason 0115 is separate from `tax_invoices`:
-- these are another system's documents, imported frozen, and nothing in
-- this product measures, bills or settles against them.
--
-- ---------------------------------------------------------------------
-- § A. WHY GROSS, NET AND THE HEADS ARE ALL STORED, AND ALL THREE CHECKED.
--
-- The one arithmetic fact this wave exists to preserve is
--
--     gross = net + Σ heads
--
-- and it is true on every conforming receipt in the real file — the
-- dry-run reconciled 750 of 750 to the paise. It is stored three ways and
-- checked twice because each figure answers a different question and a
-- reader that derived one from the other two would be recomputing money
-- another system stated:
--
--   * `gross_amount` is what the railway settled — the credited customer
--     line, which is the figure the bill was raised for.
--   * `net_amount` is what actually reached the bank.
--   * the deduction lines are where the difference went, per head.
--
-- MONEY THE RAILWAY KEPT IS SETTLED MONEY AND MONEY THAT NEVER ARRIVED IS
-- OUTSTANDING MONEY — the same distinction `bill_payments` (P15) is built
-- on. A register that stored only the bank credit would report every bill
-- as short by its own statutory deductions forever.
--
-- The row CHECK holds the three header figures together. The DEFERRED
-- constraint trigger at the foot holds the header against its own lines,
-- because that is a cross-row fact no CHECK can see, and it is the one
-- place this schema could otherwise drift into saying that ₹1 crore was
-- deducted while listing ₹80 lakh of heads.
--
-- ---------------------------------------------------------------------
-- § B. THE HEADS, AND THE TWO RULINGS THAT DECIDE THEM.
--
-- 0114's five heads are a CLOSED union by deliberate design — its own
-- comment argues it: a free-text head makes the receivables arithmetic a
-- sum over whatever anybody typed, and two spellings of "retention" would
-- each be half the money. The census then found that about a third of
-- real deduction lines have no 0114 head at all, and asked (questions
-- 13–16). The answers:
--
--   * RULING 15 — every unmapped head books into ONE `other` bucket
--     carrying the Tally ledger name per line, so `gross = net + Σ heads`
--     still holds. A bucket can be promoted to a first-class head later
--     without a re-import, because the ledger name is on every line.
--   * RULING 16 — round-off is not a head. It folds into the net, and
--     `round_off_amount` is the note that says by how much. 129 real
--     lines, ₹107 in total, and the fold is what keeps the arithmetic
--     above exact in both directions: a debited round-off raises the net,
--     a credited one lowers it.
--   * RULING 13 — `retention` stays permanently empty for imported
--     payments. No ledger in the file contains the word.
--   * RULING 14, CLOSED 23 Aug 2026 — the `Contracual Deduction` ledger
--     (sic; 240 real lines, ₹80.6 lakh) is liquidated damages, not
--     retention, and books to `liquidated_damages`. It was the one head
--     the whole wave was blocked on, because it decided whether either of
--     0114's two unreachable heads was reachable at all. One of them now
--     is.
--
-- `retention` is admitted by the CHECK and written by nothing, which is
-- 0119's posture towards `manual`: a head this product knows about, that
-- this import has no honest value for, must not become a head this
-- import invents a value for.
--
-- ---------------------------------------------------------------------
-- § C. A HEAD LINE WITH NO AMOUNT (ruling 10).
--
-- 77 real receipts name a head with no `AMOUNT` element at all. Tally
-- displays that as nil; a reader that assumed the tag would crash, and one
-- that dropped the line would lose the fact that the head was named.
-- Ruling 10: import as 0.00 with a provenance flag, and list every such
-- line on the reconciliation report. `amount_missing` is that flag, and
-- the CHECK beside it refuses the combination that would make it a lie —
-- a flagged line carrying a figure.
--
-- ---------------------------------------------------------------------
-- § D. WHICH WORK, AND THE QUEUE FOR THE ONES WITH NO ANSWER (ruling 17).
--
-- Three routes, in the order ruling 17 sets, and every one of them a
-- PROPOSAL that a person can overrule (ruling 6):
--
--   1. the security-deposit head's own `PL-<code>` — the census's single
--      most valuable finding is that the SD ledgers are already keyed to
--      the v1 work code, and no receipt splits security deposit across two
--      works;
--   2. a bill allocation naming an invoice this register can reach;
--   3. a `PL-<code>` in the narration.
--
-- A receipt with no route imports UNLINKED — `work_id` null — which is
-- the manual-link queue ruling 17 asks for. It is a queue rather than a
-- table: the rows are the payments with no Work, and the wave that adds
-- the route to link one by hand adds the UPDATE grant with it. Nothing in
-- this wave may edit a payment, so nothing here can widen it by accident.
--
-- A Tally code NEVER creates a Work (ruling 5), and the ~158 codes naming
-- works this system does not have import unlinked with the code preserved
-- as text on the deduction line (ruling 4).
--
-- ---------------------------------------------------------------------
-- § E. WHAT IS REFUSED RATHER THAN GUESSED, AND WHY IT IS THE ROUTE'S JOB.
--
-- Four shapes are refused per voucher, by name and with the line the
-- voucher opened on, in BOTH the preview and the commit:
--
--   * more than one credited customer line (ruling 20 — a person splits
--     the receipt into two clean ones);
--   * a credited line that is neither the customer nor a round-off — a
--     deduction head on the credit side, which is a reversal this wave
--     does not model;
--   * a customer ledger on the DEBIT side, as if it were a head (ruling
--     19 — held with a named refusal and listed for the owner);
--   * anything that does not reconcile.
--
-- They are refusals in the READER, not constraints here, and that is
-- deliberate: a CHECK meets a bad row mid-commit as a 23514 naming a
-- constraint, after a thousand other rows have been built, with nothing
-- saying which voucher or where. The schema's job is the invariant; the
-- reader's job is the sentence.
--
-- BANK-PARTY RECEIPTS ARE NOT REFUSED AND NOT IMPORTED. The 845 receipts
-- whose party is a bank credit no customer at all — they are loan
-- drawdowns, EMD refunds and FDR maturities (census § 3), and 401 of them
-- are the RELEASE side of the instruments wave T5 reconciles. They are
-- counted, reported and left for T4. So are the 415 receipts that carry
-- no deduction at all.
--
-- ---------------------------------------------------------------------
-- § F. IDEMPOTENCY (ruling 2).
--
-- `tally_guid` is unique per organisation, so re-importing the export
-- adds the receipts that are missing and collides on the ones that are
-- not — the property that makes a cutover import survivable, and the one
-- the post-training top-up re-read depends on. `tally_alterid` rides
-- along so that re-read can see what moved without any sync machinery.
--
-- There is NO DISCARD PATH in this wave, and that is a choice rather than
-- an omission: 0115's register has one because a Zoho export can be
-- corrected and re-imported, and nothing here can be corrected yet
-- because nothing here can be edited. A wave that needs to withdraw an
-- imported payment adds `discarded_at`, the grant, the route and the
-- audit event together, which is one migration and no data loss —
-- against a column now that nothing writes and every index would have to
-- be partial over.
--
-- ---------------------------------------------------------------------
-- SQLSTATEs: the 23T block, continuing 0118's and 0119's allocation.
--
--   23T01  a census row's Tally identity is fixed                 (0118)
--   23T02  a Tally invoice link is what the export said           (0119)
--   23T03  one voucher sources at most one live register row      (0119)
--   23T04  an imported payment is what the export said
--   23T05  an imported payment's heads sum to its deduction total
--   23T06  a payment's invoice allocation names a live invoice
--
-- ---------------------------------------------------------------------
-- ROLLBACK.
--
-- Nothing outside these three tables is altered, so the reversal is the
-- three drops in dependency order and the two functions behind them:
--
--   1. DROP TABLE imported_payment_invoice_links;
--      DROP TABLE imported_payment_deductions;   -- takes the deferred
--        -- constraint trigger with it
--      DROP TABLE imported_payments;
--   2. DROP FUNCTION app_private.check_imported_payment_heads();
--      DROP FUNCTION app_private.guard_imported_payment();
--      DROP FUNCTION app_private.guard_imported_payment_invoice_link();
--
-- CENSUS.
--
--   Tables created                3
--   Tables altered                0
--   Functions created             3
--   Triggers created              5 (4 plain, 1 deferred constraint)
--   Indexes created               7
--   RLS policies created          3

-- ═════════════════════════════════════════════════════════════════════
-- § 1. THE RECEIPT
-- ═════════════════════════════════════════════════════════════════════

CREATE TABLE imported_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- Tally's own identifier for the voucher, present on 83,061 of 83,061
  -- real vouchers, and therefore the idempotency key. Opaque text: it is
  -- another system's id and this schema bounds it and asserts nothing
  -- else about its shape.
  tally_guid text NOT NULL CHECK (
    btrim(tally_guid) = tally_guid
    AND length(tally_guid) BETWEEN 1 AND 80
    AND tally_guid !~ '[[:cntrl:]]'
  ),

  -- Tally's edit counter (ruling 2). NULL means UNKNOWN and never zero,
  -- for 0118's reason exactly: zero is a real counter value, and
  -- conflating it with "unknown" makes every re-import of such a record
  -- look like progress or regression.
  tally_alterid bigint CHECK (tally_alterid IS NULL OR tally_alterid >= 0),

  -- Receipt is one of the voucher types TallyPrime numbers
  -- automatically, so every real one carries a number — unlike `Sales`,
  -- where 341 do not. Nullable anyway, because the schema's job is to
  -- hold what the file says rather than to require what this file
  -- happened to contain.
  tally_voucher_number text CHECK (
    tally_voucher_number IS NULL
    OR (length(btrim(tally_voucher_number)) BETWEEN 1 AND 60
        AND tally_voucher_number !~ '[[:cntrl:]]')
  ),
  tally_voucher_date date NOT NULL,

  -- The operator's own note on the voucher. 1,581 real receipts carry
  -- one, and 273 of the deduction-bearing ones carry a `PL-` code in it,
  -- which is the third route to a Work (§ D).
  tally_narration text CHECK (
    tally_narration IS NULL
    OR (length(btrim(tally_narration)) BETWEEN 1 AND 2000
        AND tally_narration !~ '[[:cntrl:]]')
  ),

  -- TWO LEDGER NAMES, AND THEY ARE NOT THE SAME FACT.
  --
  -- `tally_party_ledger` is the voucher's `PARTYLEDGERNAME` — the side
  -- the operator entered from. `counterparty_ledger` is the ledger the
  -- voucher CREDITED, which is who actually paid. On every conforming
  -- railway receipt they name the same customer, and the census's § 3
  -- re-scan is why both are kept: on 845 receipts the party field names a
  -- BANK, and those turn out to be a different voucher class entirely
  -- rather than a bad field. Storing only one of the two would leave a
  -- later reader unable to tell which fact it was looking at.
  tally_party_ledger text NOT NULL CHECK (
    btrim(tally_party_ledger) = tally_party_ledger
    AND length(tally_party_ledger) BETWEEN 1 AND 300
    AND tally_party_ledger !~ '[[:cntrl:]]'
  ),
  counterparty_ledger text NOT NULL CHECK (
    btrim(counterparty_ledger) = counterparty_ledger
    AND length(counterparty_ledger) BETWEEN 1 AND 300
    AND counterparty_ledger !~ '[[:cntrl:]]'
  ),

  -- The contact the counterparty ledger was matched to, through the
  -- proposal the ledger census (0118) already holds: GSTIN first, then
  -- exact name, ambiguity proposes nothing (ruling 8). Null is the
  -- ordinary case — 30 of 82 real customers match by name at all — and
  -- nothing is auto-created from a ledger name.
  contact_id uuid,
  contact_match_method text CHECK (
    contact_match_method IS NULL OR contact_match_method IN ('gstin', 'name')
  ),

  -- Which Work this receipt is about, and by which of ruling 17's three
  -- routes. NULL is the manual-link queue (§ D). `manual` is admitted so
  -- that when a route to link one by hand lands, the row cannot claim an
  -- automatic proposal that never happened — 0119's argument for its own
  -- `manual`.
  work_id uuid,
  work_link_method text CHECK (
    work_link_method IS NULL
    OR work_link_method IN ('sd_ledger', 'bill_reference', 'narration', 'manual')
  ),

  -- § A. What the railway settled, what reached the bank, and what the
  -- difference was.
  gross_amount money_amount NOT NULL CHECK (gross_amount > 0),
  net_amount money_amount NOT NULL CHECK (net_amount >= 0),
  deduction_total money_amount NOT NULL CHECK (deduction_total >= 0),

  -- RULING 16. Round-off folds into the net and this is the note saying
  -- by how much. SIGNED, because it goes both ways: a debited round-off
  -- raises the net figure this row reports, a credited one lowers it.
  -- ₹107 across 129 real lines — immaterial in rupees and load-bearing in
  -- arithmetic, because without the fold the reconciliation below is off
  -- by paise on 129 receipts and every one of them would be refused.
  round_off_amount money_amount NOT NULL DEFAULT 0,

  -- Every non-boolean, non-empty direct field of the voucher, keyed by
  -- Tally's own tag: 0115's `raw_row` discipline, trimmed to this file's
  -- noise floor by `keepSourceField` — a voucher carries about 150
  -- engine flags and storing them would be megabytes of the word "No".
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(source_fields) = 'object'
  ),

  source_filename text NOT NULL CHECK (
    btrim(source_filename) = source_filename
    AND length(source_filename) BETWEEN 1 AND 260
    AND source_filename !~ '[[:cntrl:]]'
  ),
  imported_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  -- § F. The idempotency key. One voucher, one payment.
  UNIQUE (organisation_id, tally_guid),

  -- The composite tenant references this schema uses everywhere: the Work
  -- and the contact are named with their organisation, so a payment
  -- cannot be attached to another tenant's Work even by a writer reaching
  -- the table another way.
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id),
  FOREIGN KEY (organisation_id, contact_id) REFERENCES contacts (organisation_id, id),

  -- § A. The three header figures are one fact and are checked as one.
  CONSTRAINT imported_payments_reconciles_check CHECK (
    gross_amount = net_amount + deduction_total
  ),

  -- A link travels with the method that found it. A Work with no method
  -- is a link nobody can be asked about; a method with no Work is a claim
  -- about nothing.
  CONSTRAINT imported_payments_work_link_shape_check CHECK (
    (work_id IS NULL) = (work_link_method IS NULL)
  ),
  CONSTRAINT imported_payments_contact_link_shape_check CHECK (
    (contact_id IS NULL) = (contact_match_method IS NULL)
  )
);

COMMENT ON TABLE imported_payments IS
  'One TallyPrime railway receipt: the gross the railway settled, the net that reached the bank, and the deductions between them (migration 0114''s five heads plus an `other` bucket). Insert-only — it records what an export said, and nothing in this product measures, bills or settles against it. Owner rulings 10, 13-17, 19, 20 and the ruling of 23 Aug 2026 on question 14.';
COMMENT ON COLUMN imported_payments.tally_guid IS
  'Tally''s own stable identifier for the voucher, and therefore the idempotency key: re-importing the same export adds the receipts that are missing and collides on the ones that are not.';
COMMENT ON COLUMN imported_payments.counterparty_ledger IS
  'The ledger this receipt CREDITED — who actually paid — as against `tally_party_ledger`, which is the side the operator entered the voucher from. They agree on every conforming railway receipt; on the 845 bank-party receipts wave T4 takes, they do not, which is why both are stored.';
COMMENT ON COLUMN imported_payments.gross_amount IS
  'What the railway settled: the credited customer line, which is the figure the bill was raised for. Money the railway kept is settled money — a register storing only the bank credit would report every bill as short by its own statutory deductions forever.';
COMMENT ON COLUMN imported_payments.round_off_amount IS
  'Owner ruling 16: round-off is not a head, it folds into the net, and this is the note saying by how much. Signed, because it goes both ways.';
COMMENT ON COLUMN imported_payments.work_id IS
  'The Work this receipt is about, proposed by ruling 17''s three routes in order — the security-deposit head''s own PL code, a bill allocation, then the narration. NULL is the manual-link queue: 176 real receipts have no route at all and import unlinked rather than guessed.';

ALTER TABLE imported_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_payments FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY imported_payments_tenant_policy ON imported_payments
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- NO UPDATE AND NO DELETE. A receipt is what an export said, and this
-- wave has no annotation to make about one — see § F on the discard path
-- and § D on the manual link, both of which are a later migration's grant
-- and a later route's audit event. The guard below refuses an UPDATE
-- anyway, so the rule survives a grant somebody widens without noticing.
GRANT SELECT, INSERT ON imported_payments TO auto_mb_app;

-- The register's own read: newest first, per organisation.
CREATE INDEX imported_payments_date_idx
  ON imported_payments (organisation_id, tally_voucher_date DESC, id);

-- The manual-link queue (§ D). Partial, because the linked half is the
-- bulk of the register and an index over it would be the table.
CREATE INDEX imported_payments_unlinked_idx
  ON imported_payments (organisation_id, tally_voucher_date DESC, id)
  WHERE work_id IS NULL;

-- What has been received against one Work, which is the question the
-- Work's own screens ask. Doubles as the composite foreign key's index,
-- for the reason 0115 gives: an unindexed foreign key turns every parent
-- delete into a scan.
--
-- NOT PARTIAL, deliberately, even though a third of real receipts carry
-- no Work: `test/fk-index-coverage.integration.test.ts` requires an index
-- LEADING with a foreign key's own columns, and a partial one does not
-- serve a parent delete — the rows it excludes are exactly the ones the
-- delete would have to scan for.
CREATE INDEX imported_payments_work_idx
  ON imported_payments (organisation_id, work_id, tally_voucher_date);

-- The contacts foreign key's own index, for the same reason.
CREATE INDEX imported_payments_contact_idx
  ON imported_payments (organisation_id, contact_id);

-- ═════════════════════════════════════════════════════════════════════
-- § 2. THE DEDUCTION HEADS
-- ═════════════════════════════════════════════════════════════════════

CREATE TABLE imported_payment_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  imported_payment_id uuid NOT NULL,

  -- 0114'S FIVE HEADS, PLUS ONE BUCKET. See § B: the five are closed by
  -- design and `other` is ruling 15's answer to the third of real lines
  -- that have no head among them — one bucket that keeps the arithmetic
  -- exact, never a free-text head that would make the receivables sum a
  -- sum over whatever anybody typed.
  --
  -- `retention` is admitted and written by NOTHING in this wave (ruling
  -- 13): no ledger in the export contains the word, and a head this
  -- import has no honest value for must not become one it invents a
  -- value for.
  head text NOT NULL CHECK (
    head IN (
      'security_deposit',
      'retention',
      'liquidated_damages',
      'income_tax_tds',
      'gst_tds',
      'other'
    )
  ),

  -- THE SOURCE LEDGER NAME, ON EVERY LINE, and rulings 13 and 15 both
  -- rest on it: a head that is remapped later — an `other` bucket
  -- promoted to a first-class head, or a ledger the owner reads
  -- differently — is remapped from this column, with no re-import.
  tally_ledger_name text NOT NULL CHECK (
    btrim(tally_ledger_name) = tally_ledger_name
    AND length(tally_ledger_name) BETWEEN 1 AND 300
    AND tally_ledger_name !~ '[[:cntrl:]]'
  ),

  amount money_amount NOT NULL CHECK (amount >= 0),

  -- RULING 10 (§ C). The head was named on the voucher with no `AMOUNT`
  -- element at all — 88 such lines across 77 real receipts. Imported as
  -- 0.00 and FLAGGED, so the reconciliation report can list them and
  -- nobody mistakes a nil somebody typed for a nil this reader invented.
  amount_missing boolean NOT NULL DEFAULT false,

  -- The v1 work code the ledger name carries, canonical, where it carries
  -- exactly one (ruling 4: preserved as text, linkable later, nothing
  -- auto-created). 428 of the real security-deposit lines have one and it
  -- is the first of ruling 17's three routes to a Work.
  pl_code text CHECK (pl_code IS NULL OR pl_code ~ '^PL-[0-9]{1,4}$'),

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, imported_payment_id)
    REFERENCES imported_payments (organisation_id, id),

  -- The census's own line key (§ 5): no line-level identifier exists in
  -- the export, and the pair is unique per voucher in practice. It is
  -- also what makes a re-import of one receipt idempotent at the line
  -- level rather than only at the voucher level.
  UNIQUE (organisation_id, imported_payment_id, tally_ledger_name),

  -- A FLAG THAT CANNOT LIE. `amount_missing` says the export stated no
  -- figure; a flagged line carrying one would be a claim about the export
  -- that the export does not support.
  CONSTRAINT imported_payment_deductions_missing_shape_check CHECK (
    NOT amount_missing OR amount = 0
  )
);

COMMENT ON TABLE imported_payment_deductions IS
  'One deduction the railway made against one receipt, under migration 0114''s five heads or ruling 15''s single `other` bucket, with the Tally ledger name kept on every line so a later remapping needs no re-import. Append-only, like every other row that records what an export said.';
COMMENT ON COLUMN imported_payment_deductions.head IS
  '0114''s five closed heads plus `other`. `retention` is admitted and written by nothing (ruling 13); `liquidated_damages` receives the `Contracual Deduction` ledger by the owner''s ruling of 23 Aug 2026 on question 14.';
COMMENT ON COLUMN imported_payment_deductions.tally_ledger_name IS
  'The ledger the deduction was booked to in Tally, verbatim. Ruling 15: the `other` bucket is only honest because this is on every line — the bucket can be promoted to a first-class head later by reading this column, with no re-import.';
COMMENT ON COLUMN imported_payment_deductions.amount_missing IS
  'Owner ruling 10: the voucher named this head with no AMOUNT element at all. Imported as 0.00 and flagged, and listed on the reconciliation report — 88 such lines across 77 real receipts.';

ALTER TABLE imported_payment_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_payment_deductions FORCE ROW LEVEL SECURITY;

CREATE POLICY imported_payment_deductions_tenant_policy ON imported_payment_deductions
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT ON imported_payment_deductions TO auto_mb_app;

CREATE INDEX imported_payment_deductions_payment_idx
  ON imported_payment_deductions (organisation_id, imported_payment_id, head);

-- ═════════════════════════════════════════════════════════════════════
-- § 3. THE BILL ALLOCATIONS
-- ═════════════════════════════════════════════════════════════════════
--
-- Where the receipt names a bill, this is which invoice on the historical
-- register (0115) it settled. MANY-TO-MANY, like 0119's cross-reference
-- and for the same reason the data gives: 407 real receipts carry 442
-- bill references between them, and one receipt settling three invoices
-- is an ordinary payment advice.
--
-- Only 331 of the deduction-bearing receipts carry one at all, so this
-- table covers less than half the register and that is the finding rather
-- than a gap: for most receipts TallyPrime does not say which invoice was
-- paid, which is exactly why the SD head's work code is the FIRST route
-- to a Work and a bill allocation only the second (§ D).

CREATE TABLE imported_payment_invoice_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  imported_payment_id uuid NOT NULL,
  imported_invoice_id uuid NOT NULL,

  -- The allocation's `NAME`, verbatim — what the voucher called the bill.
  -- Kept as evidence for rule 7's reason: what the voucher SAID does not
  -- change when a document is renumbered somewhere else.
  tally_bill_reference text NOT NULL CHECK (
    btrim(tally_bill_reference) = tally_bill_reference
    AND length(tally_bill_reference) BETWEEN 1 AND 200
    AND tally_bill_reference !~ '[[:cntrl:]]'
  ),

  -- The allocation's own figure. NULLABLE, and null means the export
  -- stated none rather than zero: a receipt settling one bill often
  -- carries the allocation with no amount on it, and inventing the
  -- receipt's own total here would be this register recomputing money
  -- another system stated.
  amount money_amount,

  -- How the allocation was tied to a register row. `exact_number` is the
  -- document number compared with case and punctuation removed —
  -- `squeeze`, the same normalisation the Zoho and Tally invoice
  -- importers use. NO SERIAL-TOLERANT ARM HERE: that arm exists on 0119
  -- because Tally and Zoho renumbered the same sales document, and it is
  -- only safe there because it confirms on the amount, the GSTIN or the
  -- party name. A receipt offers none of those about the bill it names.
  -- `manual` is admitted and written by nothing in this wave.
  match_method text NOT NULL CHECK (match_method IN ('exact_number', 'manual')),

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, imported_payment_id)
    REFERENCES imported_payments (organisation_id, id),
  FOREIGN KEY (organisation_id, imported_invoice_id)
    REFERENCES imported_invoices (organisation_id, id),

  -- The pair appears once: one receipt may settle several invoices and
  -- one invoice may be settled by several receipts, and a re-import
  -- collides on what is already there.
  UNIQUE (organisation_id, imported_payment_id, imported_invoice_id)
);

COMMENT ON TABLE imported_payment_invoice_links IS
  'Which invoice on the historical register (0115) a TallyPrime receipt settled, where the voucher carries a bill allocation naming one. Many-to-many, like 0119''s cross-reference: one receipt settles several bills and one bill is settled by several receipts. Append-only.';
COMMENT ON COLUMN imported_payment_invoice_links.amount IS
  'The allocation''s own figure, or null where the export stated none. Null is not zero: inventing the receipt''s total here would be this register recomputing money another system stated.';

ALTER TABLE imported_payment_invoice_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE imported_payment_invoice_links FORCE ROW LEVEL SECURITY;

CREATE POLICY imported_payment_invoice_links_tenant_policy
  ON imported_payment_invoice_links
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT ON imported_payment_invoice_links TO auto_mb_app;

-- What has been received against one invoice, which is the question the
-- register's own detail asks. Doubles as the invoice foreign key's index.
CREATE INDEX imported_payment_invoice_links_invoice_idx
  ON imported_payment_invoice_links (organisation_id, imported_invoice_id);

-- ═════════════════════════════════════════════════════════════════════
-- § 4. THE GUARDS
-- ═════════════════════════════════════════════════════════════════════
--
-- Layer two of two. The import route refuses first, under an advisory
-- lock, so an operator gets a named refusal with a line number; these are
-- the arm that holds when a writer reaches the tables another way.
--
-- `SET search_path` for the reason every guard in this schema gives: a
-- function that resolves its own identifiers through the caller's path is
-- a rule a shadowing object in a writable schema can rewrite. Not
-- SECURITY DEFINER: every table touched is one the caller may already
-- read under RLS.

CREATE FUNCTION app_private.guard_imported_payment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- WRITTEN ONCE AND NEVER REWRITTEN. The application role holds no
  -- UPDATE and no DELETE; this refuses one anyway, so the rule survives a
  -- grant a later migration widens without carrying the argument with it.
  -- There is no hinge to exempt: the Work link, the discard and any other
  -- annotation this register might grow all arrive with their own route,
  -- their own audit event and their own column-scoped grant.
  -- NAMED BY ITS OWN TABLE, because this one function guards three of
  -- them: a refusal quoting a deduction line's id under the word
  -- "payment" would send somebody looking for a receipt that does not
  -- carry that id.
  RAISE EXCEPTION
    '%.% records what a TallyPrime export said and is never edited or deleted',
    TG_TABLE_NAME, OLD.id
    USING ERRCODE = '23T04';
END
$$;

COMMENT ON FUNCTION app_private.guard_imported_payment() IS
  'An imported payment is what the export said. No UPDATE and no DELETE: the application role holds neither, and this refuses both so the rule survives a grant somebody widens later.';

CREATE TRIGGER imported_payments_guard
BEFORE UPDATE OR DELETE ON imported_payments
FOR EACH ROW EXECUTE FUNCTION app_private.guard_imported_payment();

-- The same posture on the lines. A deduction head and a bill allocation
-- are part of the receipt, not annotations about it.
CREATE TRIGGER imported_payment_deductions_guard
BEFORE UPDATE OR DELETE ON imported_payment_deductions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_imported_payment();

CREATE TRIGGER imported_payment_invoice_links_guard
BEFORE UPDATE OR DELETE ON imported_payment_invoice_links
FOR EACH ROW EXECUTE FUNCTION app_private.guard_imported_payment();

-- ---------------------------------------------------------------------
-- AN ALLOCATION NAMES A LIVE INVOICE IN THIS TENANT.
--
-- The composite foreign key already refuses another tenant's invoice.
-- What it cannot see is the DISCARD: 0115's register withdraws a row
-- rather than deleting it, and tying a receipt to withdrawn evidence
-- would revive it sideways — which is exactly the rule 0119's own guard
-- states for its links.

CREATE FUNCTION app_private.guard_imported_payment_invoice_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_discarded timestamptz;
  v_found boolean;
BEGIN
  SELECT true, i.discarded_at INTO v_found, v_discarded
  FROM imported_invoices i
  WHERE i.organisation_id = NEW.organisation_id AND i.id = NEW.imported_invoice_id;

  IF v_found IS NULL THEN
    RAISE EXCEPTION
      'historical invoice % is not one this transaction can read',
      NEW.imported_invoice_id
      USING ERRCODE = '23T06';
  END IF;

  IF v_discarded IS NOT NULL THEN
    RAISE EXCEPTION
      'historical invoice % was discarded and takes no further receipt allocations',
      NEW.imported_invoice_id
      USING ERRCODE = '23T06';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_imported_payment_invoice_link() IS
  'A receipt''s bill allocation names an invoice that exists in this tenant and has not been withdrawn. Tying a payment to a discarded invoice would revive withdrawn evidence sideways.';

CREATE TRIGGER imported_payment_invoice_links_invoice_guard
BEFORE INSERT ON imported_payment_invoice_links
FOR EACH ROW EXECUTE FUNCTION app_private.guard_imported_payment_invoice_link();

-- ---------------------------------------------------------------------
-- THE HEADS SUM TO THE TOTAL (§ A), CHECKED AT COMMIT.
--
-- The row CHECK on `imported_payments` holds gross against net plus the
-- stated deduction total. This holds that total against the lines it is
-- supposed to be the total OF, which is a cross-row fact no CHECK can
-- see — and it is the one place the schema could otherwise say that
-- ₹1 crore was deducted while listing ₹80 lakh of heads.
--
-- DEFERRED, and it has to be: the header is inserted before its lines,
-- so an immediate trigger would refuse every payment at the moment it is
-- written. 0057 takes the same shape for the same reason.
--
-- Fired from the LINES rather than from the header, which is deliberate:
-- a header with no lines at all is refused too, because a receipt whose
-- deduction total is not zero and whose heads are absent is not a
-- receipt this register can explain. A zero-deduction payment is not
-- imported by this wave at all (§ E), so there is no honest row here with
-- no lines.

CREATE FUNCTION app_private.check_imported_payment_heads()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_stated money_amount;
  v_summed money_amount;
BEGIN
  SELECT p.deduction_total INTO v_stated
  FROM imported_payments p
  WHERE p.organisation_id = NEW.organisation_id AND p.id = NEW.imported_payment_id;

  -- The payment is gone: another statement in this transaction refused
  -- it, or it never existed. The foreign key is what says so, and it says
  -- it with a better message than this could.
  IF v_stated IS NULL THEN RETURN NULL; END IF;

  SELECT coalesce(sum(d.amount), 0) INTO v_summed
  FROM imported_payment_deductions d
  WHERE d.organisation_id = NEW.organisation_id
    AND d.imported_payment_id = NEW.imported_payment_id;

  IF v_summed <> v_stated THEN
    RAISE EXCEPTION
      'imported payment % states % of deductions and its heads sum to %; gross = net + heads is the one arithmetic this register keeps',
      NEW.imported_payment_id, v_stated, v_summed
      USING ERRCODE = '23T05';
  END IF;

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION app_private.check_imported_payment_heads() IS
  'Holds a receipt''s stated deduction total against the heads it is the total of — the cross-row half of gross = net + heads, which the row CHECK cannot see. Deferred, because the header is written before its lines.';

CREATE CONSTRAINT TRIGGER imported_payment_heads_sum_check
AFTER INSERT ON imported_payment_deductions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.check_imported_payment_heads();
