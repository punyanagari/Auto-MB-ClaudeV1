SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- A number template must carry its counter's scope (finding 8,
-- docs/AUDIT-DISPOSITION-2026-08-10.md). Delivery and issue challans
-- count per Work and tax invoices per financial year, while every
-- number is unique across the organisation — so a scope-free template
-- such as {SEQ} or TI/{SEQ} mints the same number again from the second
-- Work or the second financial year onward. Because the counter update
-- rolls back with the failed issue, every retry then requests the same
-- number: the series wedges at issue time, with a finished document in
-- hand and only a template change able to clear it.
--
-- The server refuses such a template when it is saved
-- (apps/server/src/number-series.ts); this constraint binds the same
-- rule against direct SQL, exactly as 0039 already binds "must consume
-- {SEQ}". The LIKE '%{FY%' arm covers {FY} and {FY2}. The calendar-year
-- tokens {YYYY}/{YY} deliberately do NOT satisfy the invoice rule: a
-- financial year straddles the calendar boundary, so invoices of two
-- financial years can share a calendar year and collide. Budgetary
-- quotations count per organisation — exactly as wide as their
-- uniqueness key — and need no scope mark.

-- Preflight with an actionable message: name every offending row and
-- the fix, instead of letting ADD CONSTRAINT fail with a bare
-- violation the operator has to decode.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(
           format('organisation %s: %s template %L',
                  organisation_id, document_type, template),
           '; ')
    INTO offending
    FROM document_number_series
   WHERE (document_type IN ('delivery_challan', 'issue_challan')
          AND template NOT LIKE '%{WORK%'
          AND template NOT LIKE '%{PREFIX%')
      OR (document_type = 'tax_invoice'
          AND template NOT LIKE '%{FY%');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'number templates lack their counter''s scope token: %s. '
        'Add {WORK} or {PREFIX} to challan templates and {FY} or {FY2} '
        'to tax invoice templates, then rerun the upgrade.',
        offending);
  END IF;
END
$$;

ALTER TABLE document_number_series
  ADD CONSTRAINT document_number_series_scope CHECK (
    CASE document_type
      WHEN 'delivery_challan' THEN
        template LIKE '%{WORK%' OR template LIKE '%{PREFIX%'
      WHEN 'issue_challan' THEN
        template LIKE '%{WORK%' OR template LIKE '%{PREFIX%'
      WHEN 'tax_invoice' THEN
        template LIKE '%{FY%'
      ELSE true
    END
  );
