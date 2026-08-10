-- Migration 0037: everything the printed TAX INVOICE needs that 0035 did
-- not know it would need.
--
-- 0035 built the invoice as data. This migration makes it a DOCUMENT: the
-- fields a real invoice carries, the whole-rupee rounding a real invoice
-- performs, and the issue-time freeze that stops a Settings edit from
-- rewriting a document the Government has already signed.
--
-- Measured against two live invoices supplied by the product owner, both
-- already carried through the e-invoicing system. What they showed:
--
-- 1. THE TOTAL IS ROUNDED TO THE WHOLE RUPEE and the delta prints on its
--    own line. 42,26,994.01 + 3,80,429.46 + 3,80,429.46 = 49,87,852.93,
--    and the invoice says Rounding 0.07 / Total Rs.49,87,853.00. The
--    second sample lands exactly and simply omits the line. Without
--    round_off we would print a total that disagrees with the customer's
--    own document by seven paise and spell the wrong words underneath it.
-- 2. THE SUPPLIER MASTHEAD IS PART OF THE DOCUMENT. 0035 froze the buyer
--    and read our own name, address and GSTIN live, so correcting the
--    company address in Settings silently rewrote the masthead of every
--    past invoice — including ones whose IRN attests the old value. The
--    asymmetry was an oversight, not a decision; issued_snapshot ends it.
-- 3. THE CUSTOMER'S OWN ORDER REFERENCE IS ON THE FACE OF THE INVOICE
--    ('MUMBAI-CST-DIVISION-S AND T / CR BB-TELE-2023-27 / 00341490086684
--    Dt. 12.09.2023'). It is what the paying division matches the bill
--    against, and it pointed nowhere: works.letter_number is OUR letter
--    and purchase_orders.po_number is our OUTBOUND order.
-- 4. BILL TO AND SHIP TO GENUINELY DIFFER — the ship-to drops the parent
--    railway line and carries NO GSTIN. Printing the buyer block twice
--    would put a GSTIN on a block the real document deliberately leaves
--    without one, which on a GST document is substantive.
--
-- TWO DELIBERATE CHOICES, recorded here because a reviewer should be able
-- to overrule them knowingly:
--
-- (a) total_amount is REDEFINED to mean the ROUNDED, PAYABLE figure,
--     with one signed round_off column beside it — rather than adding a
--     second 'rounded total'. Every consumer already means the payable
--     figure by total_amount (the invoice's Total and Balance Due, the
--     IRP's TotInvVal, the e-way bill's total invoice value), the
--     unrounded sum stays exactly recoverable as total_amount -
--     round_off, and it lets one CHECK make the printed totals block
--     self-proving. This is only safe because no invoice has ever been
--     submitted and no invoice renderer has ever existed; on a table with
--     history it would be the wrong call.
-- (b) ship_to_contact_id is a real nullable column, not the audit-trail
--     carriage the buyer uses. That trick exists solely to dodge the
--     draft-shape CHECK, which an optional nullable column never trips —
--     and an absent audit key cannot tell 'no ship-to named' apart from
--     'no event recorded'. The buyer is NOT refactored to match.

-- ---------------------------------------------------------------------
-- 1. The supplier's own masthead facts.
--
-- 0007 gave the organisation an address, a GSTIN, a phone and a logo.
-- The invoice masthead needs three more, and one of them is load-bearing
-- rather than decorative: the e-invoice payload has been recovering the
-- seller's PIN by scraping the last six-digit run out of the free-text
-- address, and the sample's address line contains no six-digit run at
-- all. Every column is nullable, matching 0007's posture — a profile
-- fills in over time, and only submitting an invoice demands the facts.

ALTER TABLE organisations
  ADD COLUMN pincode text
    CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
  ADD COLUMN trade_name text
    CHECK (trade_name IS NULL OR length(btrim(trade_name)) BETWEEN 2 AND 200),
  -- UDYAM-MH-26-0224294: the Udyam registration number, printed as
  -- 'Our MSME No.:-'. State letters, a two-digit district, seven digits.
  ADD COLUMN msme_number text
    CHECK (msme_number IS NULL OR msme_number ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$');

COMMENT ON COLUMN organisations.pincode IS
  'Six-digit PIN of the registered place of business. The e-invoice '
  'payload needs it as a number in its own right — an address line is '
  'not required to contain one.';
COMMENT ON COLUMN organisations.trade_name IS
  'The name traded under, when it differs from the legal name the '
  'organisation row carries.';

-- ---------------------------------------------------------------------
-- 2. The invoice's own document fields.

ALTER TABLE tax_invoices
  -- SIGNED, unlike every other money column here, and bounded by what
  -- half-away-from-zero rounding to the rupee can actually produce: it
  -- can add at most 0.50 and take off at most 0.49. Copying the >= 0
  -- CHECK the other five money columns carry would forbid the commoner
  -- direction outright.
  ADD COLUMN round_off numeric(18, 2)
    CHECK (round_off IS NULL OR (round_off > -0.50 AND round_off <= 0.50)),
  -- The buyer's own order reference, verbatim and unparsed. It is one
  -- free-text field on purpose: the observed shape is division / tender
  -- number / order number and date, but that grammar is the railway's,
  -- it varies by division, and a parser would refuse the first invoice
  -- that did not match it.
  ADD COLUMN customer_po_reference text
    CHECK (customer_po_reference IS NULL
           OR length(btrim(customer_po_reference)) BETWEEN 3 AND 500),
  -- The unit word beside the quantity ('set'). Stored per invoice, not
  -- hard-coded in the template: work billed per metre or per job says
  -- something else, and a template that cannot say it would be a lie
  -- waiting to be printed.
  ADD COLUMN unit_label text
    CHECK (unit_label IS NULL OR length(btrim(unit_label)) BETWEEN 1 AND 20),
  -- The Notes block. Distinct in every way from cancellation_note, which
  -- the cancel-shape CHECK forces NULL unless the invoice is cancelled.
  ADD COLUMN notes text
    CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 3 AND 4000),
  ADD COLUMN ship_to_contact_id uuid,
  ADD COLUMN ship_to_snapshot jsonb,
  -- The whole document as issued: supplier masthead, both parties, the
  -- line, the totals and the words. Same posture as delivery_challans'
  -- issued_snapshot — the legal record is what the snapshot says, and a
  -- re-render reproduces it rather than recomputing it.
  ADD COLUMN issued_snapshot jsonb,
  -- The acknowledgement's own wall clock, exactly as the portal wrote it
  -- ('2026-07-30 12:09:00'). ack_date stays as the instant for querying;
  -- this is what prints. It lives OUTSIDE issued_snapshot because the
  -- IRP answers after submit, and writing into a frozen snapshot
  -- afterwards would mutate an immutable document.
  ADD COLUMN ack_date_text text
    CHECK (ack_date_text IS NULL
           OR ack_date_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'),
  -- The number's prefix, chosen per invoice: the owner's live series runs
  -- P10 26 044 / P14 26 048 — a prefix, the financial year's opening
  -- year, and one gapless serial per year shared across prefixes. The
  -- prefix's MEANING is the owner's business (division, region, or
  -- something else), so it is stored, never derived.
  ADD COLUMN number_prefix text
    CHECK (number_prefix IS NULL OR number_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'),
  -- The rendered document, when one has been produced. 0026's pairing
  -- rule: an object key and the SHA-256 of what was stored travel
  -- together or not at all.
  ADD COLUMN template_version text,
  ADD COLUMN rendered_object_key text,
  ADD COLUMN rendered_sha256 text
    CHECK (rendered_sha256 IS NULL OR rendered_sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN tax_invoices.round_off IS
  'Signed delta added to the sum of taxable value and taxes to reach a '
  'whole-rupee payable total. Prints as the Rounding line, and is '
  'omitted from the document when zero.';
COMMENT ON COLUMN tax_invoices.total_amount IS
  'The PAYABLE total: whole rupees, after round_off. The unrounded sum '
  'is exactly total_amount - round_off.';
COMMENT ON COLUMN tax_invoices.customer_po_reference IS
  'The buyer''s order reference as printed, verbatim and unparsed.';

ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_ship_to_fk
    FOREIGN KEY (organisation_id, ship_to_contact_id)
      REFERENCES contacts (organisation_id, id);

-- ---------------------------------------------------------------------
-- 3. The freeze. Both arms of the draft shape are restated — extending
-- only one would leave the freeze decorative.

ALTER TABLE tax_invoices DROP CONSTRAINT tax_invoices_draft_shape;

ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_draft_shape CHECK (
    (status = 'draft'
      AND invoice_number IS NULL AND sequence_number IS NULL
      AND fy_label IS NULL AND buyer_snapshot IS NULL
      AND taxable_value IS NULL AND cgst_amount IS NULL
      AND sgst_amount IS NULL AND igst_amount IS NULL
      AND total_amount IS NULL AND round_off IS NULL
      AND issued_snapshot IS NULL
      AND submitted_at IS NULL AND submitted_by_user_id IS NULL)
    OR
    (status <> 'draft'
      AND invoice_number IS NOT NULL AND sequence_number IS NOT NULL
      AND fy_label IS NOT NULL AND buyer_snapshot IS NOT NULL
      AND taxable_value IS NOT NULL AND cgst_amount IS NOT NULL
      AND sgst_amount IS NOT NULL AND igst_amount IS NOT NULL
      AND total_amount IS NOT NULL AND round_off IS NOT NULL
      AND issued_snapshot IS NOT NULL
      AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL)
  ),
  -- The printed totals block, proving itself. Sub Total + taxes +
  -- Rounding = Total is the arithmetic the reader performs by eye; this
  -- is the same statement, enforced. It holds only under the
  -- redefinition of total_amount recorded at the top of this file.
  ADD CONSTRAINT tax_invoices_total_reconciles CHECK (
    status = 'draft'
    OR total_amount =
         taxable_value + cgst_amount + sgst_amount + igst_amount + round_off
  ),
  -- A whole-rupee payable total, stated as such rather than left to be
  -- inferred from round_off's bound.
  ADD CONSTRAINT tax_invoices_total_is_whole_rupees CHECK (
    total_amount IS NULL OR total_amount = trunc(total_amount)
  ),
  -- 0026's rule: the stored document and its digest travel together.
  ADD CONSTRAINT tax_invoices_render_pair CHECK (
    (rendered_object_key IS NULL) = (rendered_sha256 IS NULL)
      AND (rendered_object_key IS NULL OR template_version IS NOT NULL)
  ),
  -- A ship-to snapshot is taken at submit from the named contact, so the
  -- snapshot cannot exist without a submitted invoice.
  ADD CONSTRAINT tax_invoices_ship_to_shape CHECK (
    ship_to_snapshot IS NULL OR status <> 'draft'
  );

-- ---------------------------------------------------------------------
-- 4. The number's prefix travels with the number.
--
-- A submitted invoice has a prefix exactly when it has a number; a draft
-- may carry the operator's chosen prefix before it is numbered, which is
-- why this is not folded into the draft shape above.

ALTER TABLE tax_invoices
  ADD CONSTRAINT tax_invoices_prefix_with_number CHECK (
    status = 'draft' OR number_prefix IS NOT NULL
  );
