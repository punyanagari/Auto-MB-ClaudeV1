-- Migration 0038: the organisation's house defaults for its tax invoices.
--
-- Two settled product decisions, both of the same shape — a default the
-- organisation sets once, overridable on the invoice that needs it:
--
-- 1. THE NUMBER PREFIX. The owner keeps their existing series rather than
--    adopting ours. The live numbers decompose as prefix + the financial
--    year's opening year + one gapless serial per year shared across
--    prefixes: P10 26 044 and P14 26 048 are the 44th and 48th invoices
--    of 2026-27, raised under two different prefixes. Most invoices take
--    the house prefix; the ones that do not name their own on the
--    invoice (0037's number_prefix). What the prefix MEANS — division,
--    region, or something else entirely — is the owner's business, so it
--    is stored and never derived.
--
-- 2. THE NOTES LINE. 'Thanks for your business.' is a standing line, not
--    something retyped per invoice — but one sample carries it and the
--    other does not, so the invoice's own notes still win when set.
--
-- Both nullable: an organisation that has set neither behaves exactly as
-- it did before this migration.

ALTER TABLE organisations
  ADD COLUMN invoice_number_prefix text
    CHECK (invoice_number_prefix IS NULL
           OR invoice_number_prefix ~ '^[A-Z][A-Z0-9]{0,7}$'),
  ADD COLUMN invoice_notes text
    CHECK (invoice_notes IS NULL
           OR length(btrim(invoice_notes)) BETWEEN 3 AND 4000);

COMMENT ON COLUMN organisations.invoice_number_prefix IS
  'House prefix for tax invoice numbers, e.g. P10. An invoice that names '
  'its own prefix overrides this; the serial behind it is one gapless '
  'per-financial-year sequence shared across every prefix.';
COMMENT ON COLUMN organisations.invoice_notes IS
  'Standing Notes line printed on tax invoices unless the invoice sets '
  'its own.';
