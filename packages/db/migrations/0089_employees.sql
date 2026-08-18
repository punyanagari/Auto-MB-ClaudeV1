SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0089: the employee master, and the dated statutory schedules
-- a payroll run reads to work out what the law takes off a salary.
--
-- Migration 0090 builds the run itself. This file builds the two things
-- the run needs before it can exist: WHO is paid, and WHAT the statute
-- said on the day they were paid.
--
-- The mock draws the register at `app/employees/page.tsx` through
-- `components/hr/employee-workspace.tsx`, at fdfd610 — the freeze this
-- pack replicates. `docs/UX.md` § 15 records every place the screen and
-- this schema part company, and there are more than usual: the mock's
-- workspace is a browser-local prototype that says so on its own banner
-- ("sensitive HR data, photos and attendance are stored only on this
-- browser"), so most of what it draws has no server behind it by its own
-- admission.
--
-- ---------------------------------------------------------------------
-- WHY AN EMPLOYEE IS A `contacts` ROW WITH A SATELLITE, AND NOT A TABLE
-- OF ITS OWN.
--
-- Migration 0080 already decided this and stated the reason: "The vendor
-- and the employee are both rows in `contacts`, the party master
-- migration 0028 established... A parallel party table would have to be
-- kept in step with that one forever, and the only thing an employee
-- needs that `contacts` lacks is a flag, which this migration adds."
--
-- That decision is now load-bearing rather than merely tidy, because the
-- payroll handoff of 0090 raises a `payment_requests` row per employee
-- and `payment_requests.beneficiary_contact_id` is a foreign key INTO
-- `contacts`. An employee who is not a contact cannot be paid through the
-- payments workspace at all, and building a second disbursement path so
-- that a second party table could exist is the tail wagging the dog.
--
-- So the party facts stay on `contacts`, where they already are:
--
--   designation           the employee's name (0080's own employee index
--                         is `(organisation_id, lower(designation))
--                         WHERE active AND is_employee`)
--   phone, email          contact details
--   pan                   0080's column, and the one section 192 needs
--   bank_account_holder / _number / bank_ifsc / _branch / _type
--                         0078's beneficiary block, which is exactly the
--                         salary credit instruction
--   is_employee           0080's role flag
--
-- and this migration adds ONE table for the facts that are true of a
-- person only because they are employed: the employment dates, the
-- statutory identifiers, the coverage elections, and the salary
-- structure. None of them mean anything on a vendor.
--
-- ---------------------------------------------------------------------
-- THE ONE THING THIS MIGRATION CHANGES ABOUT THE SHARED MASTER, AND WHY.
--
-- `contacts_org_designation_address_active` (0028) makes
-- `(lower(designation), lower(coalesce(address, '')))` unique per
-- organisation among active rows. That rule was written for railway
-- postings — "a railway contact is a DESIGNATION posted at an ADDRESS",
-- says 0028's own comment — and it is right about postings. It is wrong
-- about people. Two employees called Amit Patil is not a duplicate; it is
-- Tuesday. With no address on either row the pair folds to the same key
-- and the second one cannot be created at all.
--
-- So the index is narrowed to exclude employee rows, and the uniqueness
-- an employee actually has — the employee code the organisation issues —
-- is enforced on the new table instead. This is a NARROWING of a
-- uniqueness rule on a shared master and it is called out in the pull
-- request for that reason.
--
-- The deliberate consequence: a contact that is BOTH a vendor and an
-- employee leaves the vendor-duplicate rule as well. That is a party the
-- operator marked as a person, and the person rule is the one that
-- should win when the two disagree.
--
-- ---------------------------------------------------------------------
-- STATUTORY VALUES LIVE IN DATED TABLES, NOT IN CONSTANTS.
--
-- `packages/contracts/src/statutory.ts` holds the vendor-side TDS rates
-- as TypeScript constants, and says why: those are read by both halves of
-- the product to render a label, they are not editable configuration, and
-- a rate is snapshotted onto each payment when it is deducted so a
-- quarterly return is never restated by a later Finance Act.
--
-- Payroll cannot use that shape, for a reason that is about payroll
-- rather than about taste. A vendor payment is deducted once, on one day,
-- and the rate that applied is frozen on the row. A payroll run is
-- RE-COMPUTED: a draft run for July is calculated, corrected and
-- calculated again, and a run for a month in the past has to produce the
-- same figures it would have produced then. EPF ceilings, ESI rates and
-- State professional-tax schedules all move by notification with an
-- effective date in the middle of a financial year — ESI's employee share
-- went from 1.75% to 0.75% on 1 July 2019, the EPS wage ceiling went from
-- ₹6,500 to ₹15,000 on 1 September 2014 — and a constant in a deployed
-- build cannot answer "what was the rate in June" and "what is the rate
-- in July" at the same time.
--
-- The precedent taken is therefore `gst_rates` (migration 0048), not
-- `statutory.ts`: an org-editable master of notified values, each with
-- the date range it was in force, seeded for existing organisations here
-- and for new ones by the server (`apps/server/src/payroll-rates.ts`,
-- exactly as `apps/server/src/gst-rates.ts` does for 0048). Rows retire
-- by end-dating; nothing is ever deleted, because a run for a past month
-- must still find the row that governed it.
--
-- ─────────────────────────────────────────────────────────────────────
-- EVERY SEEDED VALUE BELOW IS UNVERIFIED AND AWAITS A PRACTITIONER'S
-- SIGN-OFF.
--
-- These were written from an engineer's reading of the statutes named
-- beside them, not from a chartered accountant's advice.
-- `docs/PRODUCT.md` § 5.9 already records the CA statutory sign-off as a
-- PRE-PRODUCTION gate for the vendor-side TDS table; the payroll
-- schedules seeded here join it on the same footing. Building does not
-- wait for the gate; using the product to file a PF, ESI, PT or 24Q
-- return does.
-- ─────────────────────────────────────────────────────────────────────
--
-- ---------------------------------------------------------------------
-- NAMED SQLSTATES. The 23H block is this pack's, allocated by the wave
-- coordinator, and 0090 uses the rest of it. This file raises one:
--
--   23H01  no statutory schedule covers this date, or more than one does
--
-- `apps/server/src/routes/hr.ts` maps every code in the block.
--
-- ---------------------------------------------------------------------
-- LOCK ORDER. Nothing here takes a lock beyond the row being written.
-- The schedules are read-mostly reference data and the employee row
-- hangs off `contacts`, which this migration never locks.

-- ---------------------------------------------------------------------
-- 1. The duplicate rule, narrowed off people.
--
-- See the header. The replacement index is created before the old one is
-- dropped would be the safe order for a live system, but a migration
-- runs inside one transaction on a locked table, so the pair is atomic
-- either way and the readable order is used.
-- ---------------------------------------------------------------------
DROP INDEX contacts_org_designation_address_active;

CREATE UNIQUE INDEX contacts_org_designation_address_active
  ON contacts (organisation_id, lower(designation), lower(coalesce(address, '')))
  WHERE active AND NOT is_employee;

COMMENT ON INDEX contacts_org_designation_address_active IS
  'A railway contact is a designation posted at an address, and two of those is a duplicate (0028). A PERSON is not: two employees of one name is ordinary, so employee rows are outside the rule and carry their uniqueness on employees.employee_code instead (0089).';

-- ---------------------------------------------------------------------
-- 2. The employee.
--
-- One row per employed person, hanging off the `contacts` row that
-- carries their name, their PAN and the bank account their salary is
-- credited to.
--
-- WHAT IS HERE AND WHAT IS NOT. Every column below is read by the payroll
-- arithmetic of 0090 or by the statutory return that arithmetic feeds.
-- Nothing is stored because a form could collect it: the mock's employee
-- record also carries a worksite, a latitude, a longitude, a geofence
-- radius, an ID photograph, an approval state for that photograph and a
-- leave balance, and every one of those belongs to a feature this pack
-- does not build (`docs/UX.md` § 15 rows 15c–15f).
--
-- NO AADHAAR, ANYWHERE. Not a column, not a payload, not a log line. The
-- Aadhaar Act's section 29 restricts who may store the number and what
-- for; a works-contract manager is not on that list, and the UAN below is
-- the identifier a PF return actually needs.
-- ---------------------------------------------------------------------
CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- The party row: name, phone, email, PAN, bank beneficiary details.
  -- One contact is at most one employee, which is what the unique key
  -- says; a person rehired after leaving keeps the same row and has their
  -- exit date cleared, because their PF and PT history is continuous.
  contact_id uuid NOT NULL,

  -- The organisation's own identifier for the person, printed on a
  -- payslip and typed into a PF return. Free-form because every agency
  -- numbers its people differently, and unique per organisation because
  -- the whole point of it is to name one person.
  employee_code text NOT NULL CHECK (
    btrim(employee_code) = employee_code
    AND length(employee_code) BETWEEN 1 AND 40
  ),

  department text CHECK (
    department IS NULL OR length(btrim(department)) BETWEEN 2 AND 100
  ),

  -- Legal dates, date-only per rule 6. Joining is required because every
  -- statutory register asks for it; exit is null while the person is
  -- employed.
  date_of_joining date NOT NULL,
  date_of_exit date,

  -- Required, and the reason is arithmetic rather than record-keeping:
  -- the OLD income-tax regime's basic exemption depends on age (sixty and
  -- eighty at any time during the previous year), so a payroll run cannot
  -- pick the right slab ladder without it. § 5 seeds all three ladders.
  date_of_birth date NOT NULL,

  -- ── Statutory identifiers ──────────────────────────────────────────
  --
  -- Both nullable, and neither is a formality: a first-time employee has
  -- no UAN until the EPFO allots one, and an employee who has never been
  -- ESI-covered has no insurance number. A payroll run computes the
  -- contribution regardless; it is the RETURN that needs the number, and
  -- refusing to run payroll over a missing UAN would stop the salary of
  -- somebody whose paperwork is with the EPFO.
  uan text CHECK (uan IS NULL OR uan ~ '^[0-9]{12}$'),
  esic_number text CHECK (esic_number IS NULL OR esic_number ~ '^[0-9]{17}$'),

  -- ── Provident fund election ────────────────────────────────────────
  --
  -- Coverage is not automatic. An employee joining above the statutory
  -- wage ceiling with no existing PF membership is an EXCLUDED EMPLOYEE
  -- under paragraph 2(f) of the EPF Scheme, and an establishment below
  -- the employee threshold is outside the Act altogether.
  pf_covered boolean NOT NULL DEFAULT true,

  -- Whether the employer contributes on the whole PF wage or restricts it
  -- to the statutory ceiling. Both are lawful and both are common, and
  -- the difference is thousands of rupees a month, so it is an election
  -- the organisation records rather than a rule the product picks.
  pf_wage_basis text NOT NULL DEFAULT 'ceiling' CHECK (
    pf_wage_basis IN ('actual', 'ceiling')
  ),

  -- ── Employees' State Insurance ─────────────────────────────────────
  --
  -- Whether the person works at an establishment the ESI Act covers.
  -- Whether they are covered THIS MONTH is a separate question the run
  -- answers from the wage ceiling, and 0090 also holds the rule that
  -- keeps a mid-period riser contributing to the end of the contribution
  -- period. This column is the outer gate: a site in a district ESIC has
  -- not notified is outside the Act however small the wage.
  esi_applicable boolean NOT NULL DEFAULT true,

  -- ── Professional tax ───────────────────────────────────────────────
  --
  -- The State whose schedule applies, as the two-digit GST State code
  -- (`GST_STATE_NAMES`, packages/contracts/src/primitives.ts). NULL for a
  -- State that levies no profession tax at all — Delhi, Haryana, Uttar
  -- Pradesh and several others do not — which is a real answer and not a
  -- missing one.
  professional_tax_state_code text CHECK (
    professional_tax_state_code IS NULL
    OR professional_tax_state_code ~ '^[0-9]{2}$'
  ),

  -- Which arm of the State's schedule applies to this person.
  --
  -- This column exists for exactly one reason and its name says so: the
  -- Maharashtra schedule, and several others, set a different exemption
  -- threshold for women — ₹25,000 a month against ₹7,500 since the 2023
  -- amendment. Ignoring the distinction would deduct ₹200 a month from
  -- every woman earning between those two figures who owes nothing, which
  -- is money taken from a payslip by a product that did not read the
  -- schedule. Required whenever a State is named, because a schedule
  -- cannot be resolved without it.
  professional_tax_category text CHECK (
    professional_tax_category IS NULL
    OR professional_tax_category IN ('male', 'female')
  ),

  -- ── Income tax, section 192 ────────────────────────────────────────
  --
  -- The regime the employee has elected for the year. `new` is the
  -- default under section 115BAC(1A) — the employee opts OUT of it, not
  -- into it — so the column defaults the same way the statute does.
  tax_regime text NOT NULL DEFAULT 'new' CHECK (tax_regime IN ('old', 'new')),

  -- What the employee declared on their Form 12BB, as two annual totals.
  --
  -- WHY TWO NUMBERS AND NOT A DECLARATION SUBSYSTEM. Under section 192
  -- the employer estimates the year's tax on what the employee DECLARES,
  -- and the declaration is a form the employee signs. Modelling every
  -- head of it — house rent and the landlord's PAN, the let-out property,
  -- each Chapter VI-A section with its own cap — is a product of its own,
  -- and the mock draws no screen for any of it. Two totals is what the
  -- payroll clerk transcribes off the signed form, and it is the smallest
  -- input that does not make the old regime a lie.
  --
  -- Both are ignored under the new regime, where neither is available.
  declared_exempt_allowances_annual money_amount NOT NULL DEFAULT 0
    CHECK (declared_exempt_allowances_annual >= 0),
  declared_chapter_via_annual money_amount NOT NULL DEFAULT 0
    CHECK (declared_chapter_via_annual >= 0),

  -- ── The salary structure ───────────────────────────────────────────
  --
  -- The monthly entitlement at full attendance. A payroll run reads these
  -- and SNAPSHOTS them onto its line (0090), so a raise recorded in
  -- August never restates July's finalised run.
  --
  -- WHY THERE IS NO EFFECTIVE-DATED SALARY HISTORY. A revision overwrites
  -- these columns, and the history lives in the finalised runs, which are
  -- immutable and carry the figures they were computed from. A second,
  -- dated copy of the same fact would be a table whose only reader is a
  -- report that the run table already answers, and whose rows could
  -- disagree with the runs they claim to explain. If a future pack needs
  -- to schedule a raise before it takes effect, that is a different
  -- feature — a pending revision with an effective date — and it can be
  -- added without moving these.
  --
  -- Basic and dearness allowance are separated because the PF wage is
  -- their SUM and nothing else: section 2(b) of the EPF Act defines basic
  -- wages, and paragraph 29 adds dearness allowance and retaining
  -- allowance to it. House rent and other allowances are in the ESI and
  -- income-tax bases and out of the PF one, and a single "gross" column
  -- could not tell the three apart.
  basic_monthly money_amount NOT NULL CHECK (basic_monthly > 0),
  dearness_allowance_monthly money_amount NOT NULL DEFAULT 0
    CHECK (dearness_allowance_monthly >= 0),
  house_rent_allowance_monthly money_amount NOT NULL DEFAULT 0
    CHECK (house_rent_allowance_monthly >= 0),
  other_allowances_monthly money_amount NOT NULL DEFAULT 0
    CHECK (other_allowances_monthly >= 0),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, contact_id),
  FOREIGN KEY (organisation_id, contact_id)
    REFERENCES contacts(organisation_id, id),

  CONSTRAINT employees_exit_after_joining_check CHECK (
    date_of_exit IS NULL OR date_of_exit >= date_of_joining
  ),
  -- Nobody is employed before they are born, and nobody is employed at
  -- three. Fourteen is the floor the Child Labour (Prohibition and
  -- Regulation) Act sets for employment at all.
  CONSTRAINT employees_born_before_joining_check CHECK (
    date_of_joining >= date_of_birth + INTERVAL '14 years'
  ),
  -- A State without an arm of its schedule cannot be resolved, and an arm
  -- without a State names nothing. They travel together.
  CONSTRAINT employees_professional_tax_shape_check CHECK (
    (professional_tax_state_code IS NULL) = (professional_tax_category IS NULL)
  )
);

COMMENT ON TABLE employees IS
  'The employment facts about a person the organisation pays a salary to. Their name, PAN and bank beneficiary details are on the contacts row this points at (0028, 0078, 0080), because payment_requests pays a CONTACT and a second party master could not be paid at all. Every column here is read by the payroll arithmetic of 0090 or by a statutory return it feeds.';
COMMENT ON COLUMN employees.pf_wage_basis IS
  '''ceiling'' restricts the provident-fund wage to the statutory monthly ceiling; ''actual'' contributes on the whole of basic plus dearness allowance. Both are lawful, the difference is thousands of rupees a month, so it is recorded as the organisation''s election rather than decided by the product.';
COMMENT ON COLUMN employees.professional_tax_category IS
  'Which arm of the State profession-tax schedule applies. It exists because Maharashtra and several other States set a higher exemption threshold for women — ₹25,000 a month against ₹7,500 since 2023 — and deducting without reading that would take ₹200 a month off a payslip that owes nothing.';
COMMENT ON COLUMN employees.declared_chapter_via_annual IS
  'The Chapter VI-A total the employee declared on their signed Form 12BB, transcribed as one figure. Section 192 estimates the year''s tax on what the employee declares; modelling every head of the declaration is a product of its own and the mock draws no screen for it. Ignored under the new regime, where the deductions are not available.';
COMMENT ON COLUMN employees.basic_monthly IS
  'The monthly entitlement at full attendance. A payroll run snapshots this onto its line, so a raise recorded in August never restates July''s finalised run — which is why there is no effective-dated salary history table beside it.';

CREATE UNIQUE INDEX employees_code_per_organisation
  ON employees (organisation_id, lower(employee_code));

-- The register's own list: employed people first, newest joiner first,
-- with the id closing the key so a keyset page has a total order.
CREATE INDEX employees_register_idx
  ON employees (organisation_id, date_of_joining DESC, id);

-- Who is on the payroll for a given month. Partial on the live rows
-- because a run enumerates them and the leavers are the long tail.
CREATE INDEX employees_current_idx
  ON employees (organisation_id, id)
  WHERE date_of_exit IS NULL;

CREATE TRIGGER employees_touch_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the
-- planner treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY employees_tenant_policy ON employees
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. An employee row is referenced by every payroll line ever
-- computed for that person, and those lines are issued records. Somebody
-- who has left is end-dated, which is what `date_of_exit` is for.
GRANT SELECT, INSERT, UPDATE ON employees TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 3. The statutory parameters.
--
-- One notified number, with the range of dates it was in force. Rates and
-- money ceilings share one table because they share one lifecycle — both
-- move by notification, both must be answerable for a past month — and
-- splitting them would mean two tables, two seeds, two resolvers and two
-- places for an effective date to be wrong.
--
-- THE UNIT IS IN THE NAME. `value` is a bare numeric and a reader has to
-- know whether 12 means twelve percent or twelve rupees, so every
-- parameter name ends in `_percent` or `_rupees` and the CHECK below is
-- the closed list. A parameter added without a unit in its name is a
-- syntax error in review.
-- ---------------------------------------------------------------------
CREATE TABLE payroll_statutory_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  parameter text NOT NULL CHECK (parameter IN (
    -- Employees' Provident Funds and Miscellaneous Provisions Act, 1952
    'epf_employee_percent',
    'epf_employer_total_percent',
    'eps_employer_percent',
    'eps_monthly_wage_ceiling_rupees',
    'epf_monthly_wage_ceiling_rupees',
    -- Employees' State Insurance Act, 1948
    'esi_employee_percent',
    'esi_employer_percent',
    'esi_monthly_gross_ceiling_rupees',
    -- Income-tax Act, 1961, section 192 and the computation behind it
    'income_tax_cess_percent',
    'income_tax_surcharge_floor_rupees',
    'standard_deduction_old_rupees',
    'standard_deduction_new_rupees',
    'rebate_87a_old_income_limit_rupees',
    'rebate_87a_old_cap_rupees',
    'rebate_87a_new_income_limit_rupees',
    'rebate_87a_new_cap_rupees'
  )),

  -- Scale 4 because 8.33% needs two places and a future notification
  -- stated in basis points needs more; precision 14 because the largest
  -- value here is a surcharge floor in whole rupees.
  value numeric(14, 4) NOT NULL CHECK (value >= 0),

  effective_from date NOT NULL,
  -- NULL: in force with no announced end, exactly as gst_rates (0048)
  -- reads it.
  effective_to date CHECK (effective_to IS NULL OR effective_to >= effective_from),

  -- The notification or Finance Act the value comes from, as an operator
  -- would cite it. Not a foreign key to anything: it is evidence for a
  -- reviewer and for the CA sign-off, and there is nothing to join to.
  notification text NOT NULL CHECK (
    length(btrim(notification)) BETWEEN 3 AND 300
  ),

  -- NULL: seeded by this migration or by organisation bootstrap rather
  -- than typed by a person, following gst_rates.created_by_user_id.
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, parameter, effective_from)
);

COMMENT ON TABLE payroll_statutory_rates IS
  'Org-editable master of notified payroll rates and ceilings, each with the range of dates it was in force. Read by every payroll computation at the run''s own month, so a run for a past month produces the figures that month''s notification produced. Values retire by end-dating, never by deletion. Every seeded value awaits the chartered accountant''s sign-off recorded in docs/PRODUCT.md § 5.9.';
COMMENT ON COLUMN payroll_statutory_rates.parameter IS
  'The notified quantity. Every name ends in _percent or _rupees because the column beside it is a bare numeric and a reader must not have to guess whether 12 is a rate or a sum of money.';

CREATE INDEX payroll_statutory_rates_lookup_idx
  ON payroll_statutory_rates (organisation_id, parameter, effective_from DESC);

CREATE TRIGGER payroll_statutory_rates_touch_updated_at
  BEFORE UPDATE ON payroll_statutory_rates
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE payroll_statutory_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_statutory_rates FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_statutory_rates_tenant_policy ON payroll_statutory_rates
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE ON payroll_statutory_rates TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 4. The professional-tax schedule.
--
-- Profession tax is a STATE levy under Article 276 of the Constitution,
-- so there is no national rate and no national schedule: there are as
-- many schedules as there are States that levy it, several States levy
-- none at all, and each schedule is a table of monthly wage bands.
--
-- Only Maharashtra's is seeded, because that is the one this product's
-- users work under and a schedule nobody has checked is worse than no
-- schedule — the resolver refuses loudly when no band covers a wage, so
-- an organisation in another State is told to record its own rather than
-- silently deducted nothing (or, worse, deducted Maharashtra's figures).
--
-- THE FEBRUARY COLUMN IS NOT A QUIRK OF THIS SCHEMA, IT IS THE SCHEDULE.
-- Maharashtra's entry is written as ₹2,500 a year collected as ₹200 a
-- month for eleven months and ₹300 in February. The extra hundred rupees
-- has to land in February or the year's total is ₹2,400 and the annual
-- return does not reconcile.
-- ---------------------------------------------------------------------
CREATE TABLE professional_tax_slabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- The two-digit GST State code (`GST_STATE_NAMES`). Reused rather than
  -- invented because the organisation profile and every contact already
  -- name their State that way, so an employee's State and the schedule's
  -- State are comparable without a mapping.
  state_code text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),

  -- 'any' where the State's schedule makes no distinction; 'male' and
  -- 'female' where it does. Matched against employees.professional_tax_category,
  -- with 'any' matching either.
  payee_category text NOT NULL CHECK (payee_category IN ('any', 'male', 'female')),

  effective_from date NOT NULL,
  effective_to date CHECK (effective_to IS NULL OR effective_to >= effective_from),

  -- The band, in monthly wage. Inclusive at the bottom and EXCLUSIVE at
  -- the top, so consecutive bands share a boundary figure and neither the
  -- gap nor the double-cover of a "from/to both inclusive" reading can
  -- happen. NULL upper bound is the top band.
  monthly_wage_from money_amount NOT NULL CHECK (monthly_wage_from >= 0),
  monthly_wage_to money_amount CHECK (
    monthly_wage_to IS NULL OR monthly_wage_to > monthly_wage_from
  ),

  monthly_amount money_amount NOT NULL CHECK (monthly_amount >= 0),
  -- NULL means February is the same as every other month. Set only where
  -- the State's schedule collects an annual figure that does not divide
  -- by twelve.
  february_amount money_amount CHECK (
    february_amount IS NULL OR february_amount >= 0
  ),

  notification text NOT NULL CHECK (
    length(btrim(notification)) BETWEEN 3 AND 300
  ),

  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, state_code, payee_category, effective_from,
          monthly_wage_from)
);

COMMENT ON TABLE professional_tax_slabs IS
  'One State profession-tax schedule, band by band, with the dates it was in force. A State levy under Article 276 of the Constitution, so there is no national table: only Maharashtra''s is seeded, and the resolver refuses by name when no band covers a wage rather than deducting another State''s figures.';
COMMENT ON COLUMN professional_tax_slabs.monthly_wage_to IS
  'Exclusive upper bound; NULL is the top band. Exclusive so that consecutive bands share one boundary figure and a wage sitting exactly on it is covered once — a from/to pair read as both-inclusive is how a schedule ends up double-covering ₹10,000.';
COMMENT ON COLUMN professional_tax_slabs.february_amount IS
  'What February collects where the State''s annual figure does not divide by twelve. Maharashtra''s ₹2,500 a year is ₹200 for eleven months and ₹300 in February, and putting the extra hundred anywhere else leaves the annual return short.';

CREATE INDEX professional_tax_slabs_lookup_idx
  ON professional_tax_slabs (
    organisation_id, state_code, payee_category, effective_from DESC
  );

CREATE TRIGGER professional_tax_slabs_touch_updated_at
  BEFORE UPDATE ON professional_tax_slabs
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE professional_tax_slabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_tax_slabs FORCE ROW LEVEL SECURITY;

CREATE POLICY professional_tax_slabs_tenant_policy ON professional_tax_slabs
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE ON professional_tax_slabs TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 5. The income-tax slab ladders.
--
-- Two regimes, three age categories, and a band table rather than a
-- formula, for the same reason profession tax gets one: the ladder moves
-- with every Finance Act and a build cannot answer for two years at once.
--
-- WHY THE NEW REGIME IS SEEDED FOR ALL THREE AGE CATEGORIES WHEN IT
-- DISTINGUISHES NONE. Section 115BAC(1A) sets one ladder for everybody,
-- so the three sets of new-regime rows below are identical. Seeding them
-- keeps the resolver a single indexed lookup on (regime, category, date)
-- with no fallback branch — and a fallback branch is exactly where "we
-- meant the general ladder" turns into a senior citizen taxed on the
-- wrong one when a future Finance Act does introduce a distinction.
-- ---------------------------------------------------------------------
CREATE TABLE income_tax_slabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  regime text NOT NULL CHECK (regime IN ('old', 'new')),
  -- Age at any time during the previous year, which is what sections
  -- 80-and-over and 60-and-over are written against.
  payee_category text NOT NULL CHECK (
    payee_category IN ('general', 'senior', 'super_senior')
  ),

  effective_from date NOT NULL,
  effective_to date CHECK (effective_to IS NULL OR effective_to >= effective_from),

  -- Annual total income, inclusive bottom and exclusive top, as § 4's
  -- bands are and for the same reason.
  annual_income_from money_amount NOT NULL CHECK (annual_income_from >= 0),
  annual_income_to money_amount CHECK (
    annual_income_to IS NULL OR annual_income_to > annual_income_from
  ),

  rate numeric(5, 2) NOT NULL CHECK (rate >= 0 AND rate <= 100),

  notification text NOT NULL CHECK (
    length(btrim(notification)) BETWEEN 3 AND 300
  ),

  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, regime, payee_category, effective_from,
          annual_income_from)
);

COMMENT ON TABLE income_tax_slabs IS
  'The section 192 slab ladders, per regime and per age category, with the dates each was in force. A band table rather than a formula because the ladder moves with every Finance Act and a deployed build cannot answer for two financial years at once. The new regime''s three age categories are identical because section 115BAC(1A) sets one ladder; they are seeded anyway so the resolver never needs a fallback branch.';

CREATE INDEX income_tax_slabs_lookup_idx
  ON income_tax_slabs (
    organisation_id, regime, payee_category, effective_from DESC
  );

CREATE TRIGGER income_tax_slabs_touch_updated_at
  BEFORE UPDATE ON income_tax_slabs
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE income_tax_slabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_tax_slabs FORCE ROW LEVEL SECURITY;

CREATE POLICY income_tax_slabs_tenant_policy ON income_tax_slabs
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE ON income_tax_slabs TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 6. Reading one parameter.
--
-- THE RESOLVER REFUSES RATHER THAN GUESSES, in both directions.
--
-- No covering row means the organisation has not recorded what the law
-- said on that date. Returning zero would compute a payroll with no
-- provident fund in it and pay the money to the employee, which nobody
-- would notice until the EPFO did. Returning "the latest row" would
-- silently apply next year's rate to last year's month.
--
-- More than one covering row means two records disagree about the same
-- day, and `LIMIT 1` over them is a coin toss that lands the same way
-- until the planner changes its mind. There is no honest answer to give,
-- so neither is given.
--
-- This is why there is no overlap-prevention trigger on the three tables
-- above: a range guard fires when a row is written, and this fires when
-- the ambiguity is actually about to change somebody's pay. The second
-- catches a schedule that was unambiguous when it was recorded and became
-- ambiguous when a later row was end-dated wrongly, which the first does
-- not.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.payroll_statutory_value(
  p_organisation_id uuid,
  p_parameter text,
  p_on_date date
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
-- Not SECURITY DEFINER: every row it reads is one the caller may already
-- read under RLS, and a definer function here would read across tenants.
-- The tenancy predicate is written out anyway, because a caller that is
-- not RLS-bound must not get another organisation's schedule.
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_values numeric[];
BEGIN
  SELECT array_agg(r.value ORDER BY r.effective_from)
    INTO v_values
    FROM payroll_statutory_rates r
   WHERE r.organisation_id = p_organisation_id
     AND r.parameter = p_parameter
     AND r.effective_from <= p_on_date
     AND (r.effective_to IS NULL OR r.effective_to >= p_on_date);

  IF v_values IS NULL OR array_length(v_values, 1) = 0 THEN
    RAISE EXCEPTION
      'no % is recorded as being in force on %; add the notification to the payroll statutory master first',
      p_parameter, p_on_date
      USING ERRCODE = '23H01';
  END IF;

  IF array_length(v_values, 1) > 1 THEN
    RAISE EXCEPTION
      'the payroll statutory master records % values for % on %; end-date all but one',
      array_length(v_values, 1), p_parameter, p_on_date
      USING ERRCODE = '23H01';
  END IF;

  RETURN v_values[1];
END;
$$;

COMMENT ON FUNCTION app_private.payroll_statutory_value(uuid, text, date) IS
  'One notified rate or ceiling, as it stood on one date. Refuses when no row covers the date and refuses when more than one does: computing a payroll against a guessed rate is money out of somebody''s pay, and there is no honest default for either failure.';

REVOKE ALL ON FUNCTION app_private.payroll_statutory_value(uuid, text, date)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION
      app_private.payroll_statutory_value(uuid, text, date) TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 7. The seed, for every organisation that already exists.
--
-- New organisations are seeded by the server at creation
-- (`apps/server/src/payroll-rates.ts` holds the same three lists);
-- tenant tables are never globally seeded, so the rows are per
-- organisation, exactly as 0048 § 2 does it.
--
-- HOW FAR BACK THE SEED REACHES, AND WHY NOT FURTHER. Each list starts at
-- the notification this product's users would actually have to answer
-- for, not at the beginning of the statute. A row seeded for 2003 is a
-- claim about 2003 that nobody has checked and no payroll run will ever
-- read, and every unchecked claim is one more line on the CA's list.
--
-- The income-tax ladders start at 1 April 2025 — the Finance Act 2025
-- shape, which is the current financial year's — for the same reason plus
-- one more: the resolver above refuses a month it has no ladder for, so a
-- run for an earlier year fails loudly and an operator records the ladder
-- they need rather than being handed a number from the wrong year.
-- ---------------------------------------------------------------------

INSERT INTO payroll_statutory_rates (
  organisation_id, parameter, value, effective_from, effective_to, notification
)
SELECT org.id, seed.parameter, seed.value, seed.effective_from,
       seed.effective_to, seed.notification
FROM organisations org
CROSS JOIN (
  VALUES
    -- ── Provident fund ──────────────────────────────────────────────
    --
    -- The employee's 12% and the employer's matching 12%, of which 8.33%
    -- goes to the Pension Scheme up to the pension wage ceiling and the
    -- remainder to the provident fund. The much-quoted "3.67%" is that
    -- remainder and is only exactly 3.67% while the wage is at or below
    -- the ceiling; above it the employer's fund share is larger, which is
    -- why 0090 computes it as a subtraction rather than as a third rate.
    ('epf_employee_percent'::text, 12.0000::numeric(14,4),
     DATE '2014-09-01', NULL::date,
     'Paragraph 29, Employees'' Provident Funds Scheme, 1952'::text),
    ('epf_employer_total_percent', 12.0000, DATE '2014-09-01', NULL,
     'Section 6, Employees'' Provident Funds and Miscellaneous Provisions Act, 1952'),
    ('eps_employer_percent', 8.3300, DATE '2014-09-01', NULL,
     'Paragraph 3, Employees'' Pension Scheme, 1995'),
    -- The 1 September 2014 revision, G.S.R. 609(E). The ₹6,500 ceiling it
    -- replaced is NOT seeded: 1 September 2014 is this table's floor, no
    -- run can reach behind it, and a row nobody reads is one more
    -- unverified claim on the practitioner's list.
    ('eps_monthly_wage_ceiling_rupees', 15000.0000, DATE '2014-09-01', NULL,
     'G.S.R. 609(E) dated 22 August 2014, effective 1 September 2014'),
    ('epf_monthly_wage_ceiling_rupees', 15000.0000, DATE '2014-09-01', NULL,
     'Paragraph 2(f), Employees'' Provident Funds Scheme, 1952, read with G.S.R. 609(E)'),

    -- ── Employees' State Insurance ──────────────────────────────────
    --
    -- The rate cut of 1 July 2019 is seeded with the rates it replaced,
    -- because it is the clearest demonstration in the whole table of why
    -- these are rows and not constants: June 2019 and July 2019 are
    -- different arithmetic on the same salary.
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

    -- ── Income tax, section 192 ─────────────────────────────────────
    ('income_tax_cess_percent', 4.0000, DATE '2018-04-01', NULL,
     'Health and Education Cess, Finance Act 2018'),
    -- Not a rate the product applies: the figure above which it REFUSES
    -- to compute. See 0090 § 6 — surcharge and its marginal relief are
    -- not implemented, and a refusal is the honest answer where an
    -- under-deduction would be the silent one.
    ('income_tax_surcharge_floor_rupees', 5000000.0000, DATE '2025-04-01', NULL,
     'Section 2, Finance Act 2025 — first surcharge threshold on total income'),
    ('standard_deduction_old_rupees', 50000.0000, DATE '2025-04-01', NULL,
     'Section 16(ia), Income-tax Act, 1961'),
    ('standard_deduction_new_rupees', 75000.0000, DATE '2025-04-01', NULL,
     'Section 16(ia) as applied to section 115BAC(1A), Finance Act 2024'),
    ('rebate_87a_old_income_limit_rupees', 500000.0000, DATE '2025-04-01', NULL,
     'Section 87A, Income-tax Act, 1961 — old regime'),
    ('rebate_87a_old_cap_rupees', 12500.0000, DATE '2025-04-01', NULL,
     'Section 87A, Income-tax Act, 1961 — old regime'),
    ('rebate_87a_new_income_limit_rupees', 1200000.0000, DATE '2025-04-01', NULL,
     'Section 87A as amended by Finance Act 2025 — new regime'),
    ('rebate_87a_new_cap_rupees', 60000.0000, DATE '2025-04-01', NULL,
     'Section 87A as amended by Finance Act 2025 — new regime')
) AS seed (parameter, value, effective_from, effective_to, notification);

-- ── Maharashtra's profession-tax schedule ────────────────────────────
--
-- Maharashtra State Tax on Professions, Trades, Callings and Employments
-- Act 1975, Schedule I entry 1, as amended with effect from 1 April 2023
-- by Maharashtra Act No. XXII of 2023 — which is the amendment that
-- raised the women's exemption from ₹10,000 to ₹25,000 a month, and the
-- reason employees.professional_tax_category exists.
--
-- Bands are [from, to) so ₹10,000 exactly falls in the ₹175 band and
-- ₹10,000.01 in the ₹200 one, which is how the entry is written.
INSERT INTO professional_tax_slabs (
  organisation_id, state_code, payee_category, effective_from, effective_to,
  monthly_wage_from, monthly_wage_to, monthly_amount, february_amount,
  notification
)
SELECT org.id, '27', seed.payee_category, DATE '2023-04-01', NULL,
       seed.wage_from, seed.wage_to, seed.amount, seed.february,
       'Schedule I entry 1, Maharashtra State Tax on Professions, Trades, Callings and Employments Act 1975, as amended by Maharashtra Act No. XXII of 2023 with effect from 1 April 2023'
FROM organisations org
CROSS JOIN (
  VALUES
    ('male'::text, 0.00::money_amount, 7500.01::money_amount,
     0.00::money_amount, NULL::money_amount),
    ('male', 7500.01, 10000.01, 175.00, NULL),
    ('male', 10000.01, NULL, 200.00, 300.00),
    ('female', 0.00, 25000.01, 0.00, NULL),
    ('female', 25000.01, NULL, 200.00, 300.00)
) AS seed (payee_category, wage_from, wage_to, amount, february);

-- ── The income-tax ladders ───────────────────────────────────────────
--
-- New regime first, one ladder cross-joined onto all three age
-- categories (see § 5 for why they are stored rather than resolved by
-- fallback), then the old regime's three genuinely different ladders.
INSERT INTO income_tax_slabs (
  organisation_id, regime, payee_category, effective_from, effective_to,
  annual_income_from, annual_income_to, rate, notification
)
SELECT org.id, 'new', category.name, DATE '2025-04-01', NULL,
       band.income_from, band.income_to, band.rate,
       'Section 115BAC(1A), Income-tax Act, 1961, as substituted by Finance Act 2025 for assessment year 2026-27'
FROM organisations org
CROSS JOIN (VALUES ('general'::text), ('senior'), ('super_senior'))
  AS category (name)
CROSS JOIN (
  VALUES
    (0.00::money_amount, 400000.00::money_amount, 0.00::numeric(5,2)),
    (400000.00, 800000.00, 5.00),
    (800000.00, 1200000.00, 10.00),
    (1200000.00, 1600000.00, 15.00),
    (1600000.00, 2000000.00, 20.00),
    (2000000.00, 2400000.00, 25.00),
    (2400000.00, NULL, 30.00)
) AS band (income_from, income_to, rate);

INSERT INTO income_tax_slabs (
  organisation_id, regime, payee_category, effective_from, effective_to,
  annual_income_from, annual_income_to, rate, notification
)
SELECT org.id, 'old', seed.payee_category, DATE '2025-04-01', NULL,
       seed.income_from, seed.income_to, seed.rate,
       'Paragraph A of Part III of the First Schedule, Finance Act 2025 — rates outside section 115BAC'
FROM organisations org
CROSS JOIN (
  VALUES
    -- Under sixty: ₹2,50,000 exempt.
    ('general'::text, 0.00::money_amount, 250000.00::money_amount,
     0.00::numeric(5,2)),
    ('general', 250000.00, 500000.00, 5.00),
    ('general', 500000.00, 1000000.00, 20.00),
    ('general', 1000000.00, NULL, 30.00),
    -- Sixty or over at any time during the previous year: ₹3,00,000.
    ('senior', 0.00, 300000.00, 0.00),
    ('senior', 300000.00, 500000.00, 5.00),
    ('senior', 500000.00, 1000000.00, 20.00),
    ('senior', 1000000.00, NULL, 30.00),
    -- Eighty or over: ₹5,00,000, and no 5% band at all.
    ('super_senior', 0.00, 500000.00, 0.00),
    ('super_senior', 500000.00, 1000000.00, 20.00),
    ('super_senior', 1000000.00, NULL, 30.00)
) AS seed (payee_category, income_from, income_to, rate);
