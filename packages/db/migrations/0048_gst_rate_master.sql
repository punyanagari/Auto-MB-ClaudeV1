SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- The GST rate master (finding 19, docs/AUDIT-DISPOSITION-2026-08-10.md).
--
-- A tax invoice is a locally finalised, gap-free numbered, immutably
-- snapshotted legal document — and until now its gst_rate column accepted
-- ANY value from 0 to 100. A mistyped 1.8 instead of 18 produced an
-- invoice the Government would reject, and finding 5's refusal posture
-- makes the correction path afterwards deliberately narrow. The rate a
-- works contractor may charge is not an opinion: it is the set of rates
-- the GST Council has notified, each with the date range it was in force.
--
-- This migration adds an ORG-EDITABLE master of notified rates with
-- effective-date ranges. The server refuses an invoice whose (rate, date)
-- pair no master row covers; the trigger below binds the same rule
-- against direct SQL, exactly as 0046 binds the quantity ceilings. The
-- master is org-editable because notifications change (the 22 September
-- 2025 GST 2.0 reform abolished 12% and 28% and introduced 40%) and an
-- organisation must be able to record a new notification without a
-- software release. Rows are never destructively edited or deleted:
-- like every master here, a rate retires by END-DATING (effective_to),
-- so history stays covered and stored invoices stay explainable.

-- ---------------------------------------------------------------------
-- 1. The master table.

CREATE TABLE gst_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  rate numeric(5, 2) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 100),
  effective_from date NOT NULL,
  -- NULL: in force with no announced end. A CHECK keeps an end date from
  -- preceding its own start, which would cover nothing.
  effective_to date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- NULL: seeded by this migration or by organisation bootstrap rather
  -- than typed by a person (every hand-created row records its author).
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, rate, effective_from)
);

COMMENT ON TABLE gst_rates IS
  'Org-editable master of Government-notified GST rates with the date '
  'range each was in force. Tax invoices must carry a (rate, date) pair '
  'a row here covers. Rates retire by end-dating, never by deletion.';

CREATE TRIGGER gst_rates_touch_updated_at
BEFORE UPDATE ON gst_rates
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. Seed every EXISTING organisation with the notified rate history.
-- New organisations are seeded by the server at creation
-- (apps/server/src/gst-rates.ts holds the same list); tenant tables are
-- never globally seeded, so the rows are per organisation.
--
-- The history: {0, 0.25, 1.5, 3, 5, 12, 18, 28} from GST introduction on
-- 1 July 2017; the GST 2.0 reform (56th Council meeting) abolished the
-- 12% and 28% slabs effective 22 September 2025 — so both end-date on
-- 21 September 2025 — and introduced the 40% demerit rate from
-- 22 September 2025.

INSERT INTO gst_rates (organisation_id, rate, label, effective_from, effective_to)
SELECT org.id, seed.rate, seed.label, seed.effective_from, seed.effective_to
FROM organisations org
CROSS JOIN (
  VALUES
    (0.00::numeric(5, 2), 'Nil-rated / exempt supply',
     DATE '2017-07-01', NULL::date),
    (0.25, 'Special rate 0.25% (rough diamonds)', DATE '2017-07-01', NULL),
    (1.50, 'Special rate 1.5% (cut and polished diamonds)',
     DATE '2017-07-01', NULL),
    (3.00, 'Special rate 3% (gold and precious metals)',
     DATE '2017-07-01', NULL),
    (5.00, 'Merit rate 5%', DATE '2017-07-01', NULL),
    (12.00, 'Standard 12% — abolished 22 Sep 2025 (GST 2.0)',
     DATE '2017-07-01', DATE '2025-09-21'),
    (18.00, 'Standard 18%', DATE '2017-07-01', NULL),
    (28.00, 'Demerit 28% — abolished 22 Sep 2025 (GST 2.0)',
     DATE '2017-07-01', DATE '2025-09-21'),
    (40.00, 'Demerit 40% (GST 2.0)', DATE '2025-09-22', NULL)
) AS seed (rate, label, effective_from, effective_to);

-- ---------------------------------------------------------------------
-- 3. Preflight with an actionable message (0047 style): if any stored
-- tax invoice carries a (rate, date) pair the seed above does not cover,
-- the guard trigger would strand that row — an UPDATE that touches its
-- rate or date could never succeed. Name every offender and the fix
-- instead of letting the operator discover it one refusal at a time.

DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(
           format('invoice %s of organisation %s: rate %s on %s',
                  ti.id, ti.organisation_id, ti.gst_rate, ti.invoice_date),
           '; ')
    INTO offending
    FROM tax_invoices ti
   WHERE NOT EXISTS (
           SELECT 1 FROM gst_rates g
            WHERE g.organisation_id = ti.organisation_id
              AND g.rate = ti.gst_rate
              AND g.effective_from <= ti.invoice_date
              AND (g.effective_to IS NULL OR g.effective_to >= ti.invoice_date)
         );
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'tax invoices carry GST rates the rate master does not cover: %s. '
        'Insert a gst_rates row covering each pair (or correct the '
        'invoice data), then rerun the upgrade.',
        offending);
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 4. The guard: a tax invoice may only carry a (rate, date) pair the
-- organisation's own master covers. BEFORE INSERT OR UPDATE OF the two
-- deciding columns, so submit-time updates (which freeze money but touch
-- neither) pass without a redundant read; the server re-checks at submit
-- through the route.
--
-- SECURITY DEFINER (owner bypasses RLS), so the read must carry its own
-- tenancy predicate: organisation_id = NEW.organisation_id. The 0046
-- review found a definer guard reading across tenants once; this one
-- deliberately does not repeat it.

CREATE FUNCTION app_private.guard_gst_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM gst_rates g
     WHERE g.organisation_id = NEW.organisation_id
       AND g.rate = NEW.gst_rate
       AND g.effective_from <= NEW.invoice_date
       AND (g.effective_to IS NULL OR g.effective_to >= NEW.invoice_date)
  ) THEN
    RAISE EXCEPTION
      'GST rate % is not notified on % — no gst_rates row of this organisation covers the pair. Pick a rate the master lists for that date, or add the notification to the master first.',
      NEW.gst_rate, NEW.invoice_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_invoices_gst_rate_guard
BEFORE INSERT OR UPDATE OF gst_rate, invoice_date ON tax_invoices
FOR EACH ROW EXECUTE FUNCTION app_private.guard_gst_rate();

-- ---------------------------------------------------------------------
-- 5. RLS: forced, tenant-scoped, exactly as every tenant table (0035).

ALTER TABLE gst_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_rates FORCE ROW LEVEL SECURITY;

CREATE POLICY gst_rates_tenant_policy ON gst_rates
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- ---------------------------------------------------------------------
-- 6. Grants. Masters retire via end-dating; a hard delete does not
-- exist, so the application role holds no DELETE (0013 posture). The
-- bootstrap privilege matrix (packages/db/src/bootstrap.ts) declares the
-- same final state.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON gst_rates TO auto_mb_app;
  END IF;
END
$$;
