SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Numbering: 0100, 0101 and 0102 are reserved by the wave ledger and are
-- deliberately skipped here; this pack takes 0103.

-- ---------------------------------------------------------------------
-- Migration 0103: the statutory seed lists become one SQL source.
--
-- ## The defect this closes
--
-- Two copies of the same statutory money data existed. Migration 0048 § 2
-- carried the notified GST rate history as SQL literals and seeded the
-- organisations that existed when it ran; `apps/server/src/gst-rates.ts`
-- carried the identical list in TypeScript and seeded every organisation
-- created afterwards. Migration 0089 § 7 and a sibling server module,
-- `payroll-rates`, were the same arrangement for the payroll schedules —
-- statutory rates, Maharashtra's profession-tax bands, and both
-- income-tax ladders.
--
-- The duplication was known and was papered over with a drift test,
-- `payroll-rates-parity`, which parsed the migration text with regular
-- expressions and compared it to the TypeScript constant. Both are
-- deleted by this pack, which is why they are named without a path here.
-- A test that watches two copies is not a fix; it is
-- a smoke alarm over a fuel store. A rate corrected in one place and not
-- the other would still be a payroll run that computes different figures
-- depending on WHEN the organisation was created — and the income-tax
-- ladders could not be compared at all, because the migration builds them
-- with cross-joins, so that third census asserted only the server list's
-- own shape.
--
-- From here there is one copy: this function. The TypeScript lists and the
-- drift test are deleted in the same change.
--
-- ## Why a function rather than another INSERT
--
-- A migration runs once. An organisation created tomorrow needs the same
-- rows and cannot get them by re-running a migration — which is precisely
-- why the TypeScript copy existed. A function is the thing a migration can
-- create that a request can still call in a year.
--
-- ## Why this is NOT SECURITY DEFINER
--
-- Stated rather than left to inference, because every other function this
-- schema adds in `app_private` gets that question asked of it.
--
-- Definer rights would be a genuine loss here. The function takes an
-- organisation id, so a definer version owned by the BYPASSRLS role would
-- hand `auto_mb_app` a primitive that writes statutory money rows into ANY
-- organisation, named by argument, outside RLS — a cross-tenant write with
-- no caller check. Invoker rights give the opposite: the four tables are
-- forced-RLS tenant tables (0048 § 5, 0089), the application role already
-- holds `SELECT, INSERT, UPDATE` on all four, and the policies' WITH CHECK
-- refuses any organisation but the bound one. The function therefore adds
-- no authority at all — it is the same INSERTs the caller could already
-- write, with the values held in one place.
--
-- This is the standard migration 0096 § 4 states for its own guards: a
-- definer function is argued when the caller demonstrably cannot reach the
-- rows any other way, and refused when it can.
--
-- Both callers already have the reach. Organisation creation
-- (`apps/server/src/routes/identity.ts`) binds the new organisation before
-- calling, and the membership the bootstrap function just wrote makes that
-- binding legitimate. The v1 importer runs as the administrator role and
-- refuses to start as anything else, so RLS does not apply to it.
--
-- `SET search_path` is pinned for the reason 0067, 0079, 0087, 0091 and
-- 0096 all give: a function that resolves its own identifiers through the
-- caller's path is a rule a shadowing object in a writable schema can
-- rewrite into whatever it likes. That reason is independent of definer
-- rights and applies here unchanged.
--
-- ## Idempotency and the returned counts
--
-- Every INSERT is `ON CONFLICT DO NOTHING` against the table's own
-- uniqueness key, so a re-run converges and an owner's later corrections
-- are never overwritten — the posture the two TypeScript seeders held. The
-- two counts are returned for the same reason they were returned before:
-- organisation creation writes an audit event per register and must be
-- able to record a real change and stay silent on a no-op.
--
-- Two counts rather than one because there are two audit events, and one
-- function rather than two because there is one call site pattern and one
-- reason to call it.
--
-- ## No triggers
--
-- This migration creates no trigger, so it is absent from
-- MIGRATION_TRIGGERS in `packages/db/test/migration-contract.test.ts`
-- rather than present with a zero — the same treatment 0095 gets, and the
-- absence is asserted there.
--
-- ## The values below
--
-- Transcribed from migrations 0048 § 2 and 0089 § 7, which the deleted
-- drift test proved identical to the TypeScript lists it also deleted. The
-- practitioner sign-off `docs/PRODUCT.md` § 5.9 records as outstanding for
-- the payroll figures is outstanding still; moving them does not verify
-- them.
-- ---------------------------------------------------------------------

CREATE FUNCTION app_private.seed_default_statutory_rows(p_organisation_id uuid)
RETURNS TABLE (gst_rate_rows integer, payroll_rows integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_gst integer;
  v_rates integer;
  v_profession integer;
  v_income_new integer;
  v_income_old integer;
BEGIN
  -- ── The notified GST rate history (0048 § 2) ──────────────────────
  --
  -- {0, 0.25, 1.5, 3, 5, 12, 18, 28} from GST introduction on 1 July
  -- 2017; the GST 2.0 reform (56th Council meeting) abolished 12% and 28%
  -- effective 22 September 2025 — so both end-date on 21 September 2025 —
  -- and introduced the 40% demerit rate from 22 September 2025.
  INSERT INTO gst_rates (
    organisation_id, rate, label, effective_from, effective_to
  )
  SELECT p_organisation_id, seed.rate, seed.label, seed.effective_from,
         seed.effective_to
  FROM (
    VALUES
      (0.00::numeric(5, 2), 'Nil-rated / exempt supply'::text,
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
  ) AS seed (rate, label, effective_from, effective_to)
  ON CONFLICT (organisation_id, rate, effective_from) DO NOTHING;
  GET DIAGNOSTICS v_gst = ROW_COUNT;

  -- ── The payroll statutory rates (0089 § 7) ────────────────────────
  --
  -- Provident fund: the employee's 12% and the employer's matching 12%,
  -- of which 8.33% goes to the Pension Scheme up to the pension wage
  -- ceiling and the remainder to the provident fund. ESI carries the rate
  -- cut of 1 July 2019 WITH the rates it replaced, because June 2019 and
  -- July 2019 are different arithmetic on the same salary. The income-tax
  -- parameters start at 1 April 2025, the Finance Act 2025 shape.
  INSERT INTO payroll_statutory_rates (
    organisation_id, parameter, value, effective_from, effective_to,
    notification
  )
  SELECT p_organisation_id, seed.parameter, seed.value, seed.effective_from,
         seed.effective_to, seed.notification
  FROM (
    VALUES
      ('epf_employee_percent'::text, 12.0000::numeric(14, 4),
       DATE '2014-09-01', NULL::date,
       'Paragraph 29, Employees'' Provident Funds Scheme, 1952'::text),
      ('epf_employer_total_percent', 12.0000, DATE '2014-09-01', NULL,
       'Section 6, Employees'' Provident Funds and Miscellaneous Provisions Act, 1952'),
      ('eps_employer_percent', 8.3300, DATE '2014-09-01', NULL,
       'Paragraph 3, Employees'' Pension Scheme, 1995'),
      ('eps_monthly_wage_ceiling_rupees', 15000.0000, DATE '2014-09-01', NULL,
       'G.S.R. 609(E) dated 22 August 2014, effective 1 September 2014'),
      ('epf_monthly_wage_ceiling_rupees', 15000.0000, DATE '2014-09-01', NULL,
       'Paragraph 2(f), Employees'' Provident Funds Scheme, 1952, read with G.S.R. 609(E)'),
      ('esi_employee_percent', 1.7500, DATE '2017-01-01', DATE '2019-06-30',
       'Rule 51, Employees'' State Insurance (Central) Rules, 1950, before G.S.R. 423(E). 1 January 2017 is this table''s floor, not the date the rate was introduced'),
      ('esi_employee_percent', 0.7500, DATE '2019-07-01', NULL,
       'G.S.R. 423(E) dated 13 June 2019, effective 1 July 2019'),
      ('esi_employer_percent', 4.7500, DATE '2017-01-01', DATE '2019-06-30',
       'Rule 51, Employees'' State Insurance (Central) Rules, 1950, before G.S.R. 423(E). 1 January 2017 is this table''s floor, not the date the rate was introduced'),
      ('esi_employer_percent', 3.2500, DATE '2019-07-01', NULL,
       'G.S.R. 423(E) dated 13 June 2019, effective 1 July 2019'),
      ('esi_monthly_gross_ceiling_rupees', 21000.0000, DATE '2017-01-01', NULL,
       'Rule 50, Employees'' State Insurance (Central) Rules, 1950, as amended with effect from 1 January 2017'),
      ('income_tax_cess_percent', 4.0000, DATE '2018-04-01', NULL,
       'Health and Education Cess, Finance Act 2018'),
      ('income_tax_surcharge_floor_rupees', 5000000.0000, DATE '2025-04-01',
       NULL,
       'Section 2, Finance Act 2025 — first surcharge threshold on total income'),
      ('standard_deduction_old_rupees', 50000.0000, DATE '2025-04-01', NULL,
       'Section 16(ia), Income-tax Act, 1961'),
      ('standard_deduction_new_rupees', 75000.0000, DATE '2025-04-01', NULL,
       'Section 16(ia) as applied to section 115BAC(1A), Finance Act 2024'),
      ('rebate_87a_old_income_limit_rupees', 500000.0000, DATE '2025-04-01',
       NULL, 'Section 87A, Income-tax Act, 1961 — old regime'),
      ('rebate_87a_old_cap_rupees', 12500.0000, DATE '2025-04-01', NULL,
       'Section 87A, Income-tax Act, 1961 — old regime'),
      ('rebate_87a_new_income_limit_rupees', 1200000.0000, DATE '2025-04-01',
       NULL, 'Section 87A as amended by Finance Act 2025 — new regime'),
      ('rebate_87a_new_cap_rupees', 60000.0000, DATE '2025-04-01', NULL,
       'Section 87A as amended by Finance Act 2025 — new regime')
  ) AS seed (parameter, value, effective_from, effective_to, notification)
  ON CONFLICT (organisation_id, parameter, effective_from) DO NOTHING;
  GET DIAGNOSTICS v_rates = ROW_COUNT;

  -- ── Maharashtra's profession-tax schedule (0089 § 7) ──────────────
  --
  -- Only Maharashtra's, and deliberately: profession tax is a State levy
  -- under Article 276, so there is no national schedule to seed, and an
  -- organisation in another State meets `PAYROLL_SCHEDULE_MISSING` rather
  -- than being deducted Maharashtra's figures. Bands are [from, to), so
  -- ₹10,000 exactly falls in the ₹175 band and ₹10,000.01 in the ₹200 one.
  INSERT INTO professional_tax_slabs (
    organisation_id, state_code, payee_category, effective_from, effective_to,
    monthly_wage_from, monthly_wage_to, monthly_amount, february_amount,
    notification
  )
  SELECT p_organisation_id, '27', seed.payee_category, DATE '2023-04-01',
         NULL, seed.wage_from, seed.wage_to, seed.amount, seed.february,
         'Schedule I entry 1, Maharashtra State Tax on Professions, Trades, Callings and Employments Act 1975, as amended by Maharashtra Act No. XXII of 2023 with effect from 1 April 2023'
  FROM (
    VALUES
      ('male'::text, 0.00::money_amount, 7500.01::money_amount,
       0.00::money_amount, NULL::money_amount),
      ('male', 7500.01, 10000.01, 175.00, NULL),
      ('male', 10000.01, NULL, 200.00, 300.00),
      ('female', 0.00, 25000.01, 0.00, NULL),
      ('female', 25000.01, NULL, 200.00, 300.00)
  ) AS seed (payee_category, wage_from, wage_to, amount, february)
  ON CONFLICT (
    organisation_id, state_code, payee_category, effective_from,
    monthly_wage_from
  ) DO NOTHING;
  GET DIAGNOSTICS v_profession = ROW_COUNT;

  -- ── The new regime's single ladder (0089 § 7) ─────────────────────
  --
  -- Section 115BAC(1A) draws no age distinction, so one band list is
  -- cross-joined onto all three categories — which keeps the resolver a
  -- single indexed lookup with no fallback branch (0089 § 5).
  INSERT INTO income_tax_slabs (
    organisation_id, regime, payee_category, effective_from, effective_to,
    annual_income_from, annual_income_to, rate, notification
  )
  SELECT p_organisation_id, 'new', category.name, DATE '2025-04-01', NULL,
         band.income_from, band.income_to, band.rate,
         'Section 115BAC(1A), Income-tax Act, 1961, as substituted by Finance Act 2025 for assessment year 2026-27'
  FROM (VALUES ('general'::text), ('senior'), ('super_senior'))
    AS category (name)
  CROSS JOIN (
    VALUES
      (0.00::money_amount, 400000.00::money_amount, 0.00::numeric(5, 2)),
      (400000.00, 800000.00, 5.00),
      (800000.00, 1200000.00, 10.00),
      (1200000.00, 1600000.00, 15.00),
      (1600000.00, 2000000.00, 20.00),
      (2000000.00, 2400000.00, 25.00),
      (2400000.00, NULL, 30.00)
  ) AS band (income_from, income_to, rate)
  ON CONFLICT (
    organisation_id, regime, payee_category, effective_from,
    annual_income_from
  ) DO NOTHING;
  GET DIAGNOSTICS v_income_new = ROW_COUNT;

  -- ── The old regime's three ladders (0089 § 7) ─────────────────────
  --
  -- These genuinely differ: the basic exemption rises at sixty and again
  -- at eighty, and the eighty-and-over ladder has no 5% band at all.
  INSERT INTO income_tax_slabs (
    organisation_id, regime, payee_category, effective_from, effective_to,
    annual_income_from, annual_income_to, rate, notification
  )
  SELECT p_organisation_id, 'old', seed.payee_category, DATE '2025-04-01',
         NULL, seed.income_from, seed.income_to, seed.rate,
         'Paragraph A of Part III of the First Schedule, Finance Act 2025 — rates outside section 115BAC'
  FROM (
    VALUES
      ('general'::text, 0.00::money_amount, 250000.00::money_amount,
       0.00::numeric(5, 2)),
      ('general', 250000.00, 500000.00, 5.00),
      ('general', 500000.00, 1000000.00, 20.00),
      ('general', 1000000.00, NULL, 30.00),
      ('senior', 0.00, 300000.00, 0.00),
      ('senior', 300000.00, 500000.00, 5.00),
      ('senior', 500000.00, 1000000.00, 20.00),
      ('senior', 1000000.00, NULL, 30.00),
      ('super_senior', 0.00, 500000.00, 0.00),
      ('super_senior', 500000.00, 1000000.00, 20.00),
      ('super_senior', 1000000.00, NULL, 30.00)
  ) AS seed (payee_category, income_from, income_to, rate)
  ON CONFLICT (
    organisation_id, regime, payee_category, effective_from,
    annual_income_from
  ) DO NOTHING;
  GET DIAGNOSTICS v_income_old = ROW_COUNT;

  gst_rate_rows := v_gst;
  payroll_rows := v_rates + v_profession + v_income_new + v_income_old;
  RETURN NEXT;
END
$$;

COMMENT ON FUNCTION app_private.seed_default_statutory_rows(uuid) IS
  'Seeds one organisation with the default notified GST rate history and the '
  'default payroll statutory schedules, idempotently. The single source for '
  'both lists; migrations 0048 and 0089 seeded the organisations that existed '
  'when they ran, and this seeds every organisation created since.';

-- Invoker rights, so no ownership repair and no BYPASSRLS role — but the
-- EXECUTE grant is still named rather than left to PUBLIC, and is repeated
-- in `packages/db/src/bootstrap.ts` so a fresh-cluster restore that drops
-- the ACL puts it back. Without it, organisation creation fails with a
-- bare permission-denied.
REVOKE ALL ON FUNCTION app_private.seed_default_statutory_rows(uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.seed_default_statutory_rows(uuid)
      TO auto_mb_app;
  END IF;
END
$$;
