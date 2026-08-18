SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0090: the monthly payroll run — what the organisation owes
-- each employee for a month, what the statute takes off it, and the
-- handoff that turns the remainder into money leaving the bank.
--
-- 0089 built who is paid and what the law said. This builds the act.
--
-- The mock draws it at `app/hr/payroll/page.tsx` through
-- `components/payroll-run-workspace.tsx`, at fdfd610. `docs/UX.md` § 15
-- records where the screen and this schema part company.
--
-- ---------------------------------------------------------------------
-- A FINALISED PAYROLL RUN IS AN ISSUED DOCUMENT. That is the decision
-- everything else in this file follows from.
--
-- It is the document a PF inspector, an ESIC inspector and the assessing
-- officer all read. It is the basis of a Form 16. It is what an employee
-- is handed as a payslip. AGENTS.md rule 7 therefore applies to it
-- without qualification: it is an immutable snapshot, master-data edits
-- never rewrite it, and rule 8 gives it a number it keeps forever even
-- when it is cancelled.
--
-- Concretely:
--
--   * a run is numbered gap-free per organisation per financial year off
--     a counter row claimed by upsert, never by max()+1;
--   * a cancelled run keeps its number and nothing reuses it;
--   * `payroll_runs` has no DELETE grant at all, and
--     `payroll_run_lines` has one only for the recalculation of a DRAFT,
--     refused by trigger the moment the run leaves that state;
--   * every figure a line rests on is SNAPSHOTTED onto the line — the
--     employee's name and PAN, the salary heads, and the statutory rates
--     and ceilings themselves. The rate tables of 0089 are org-editable
--     by design, so a run that re-derived its rates on read would
--     restate a finalised month the day an owner corrected a
--     notification. 0080 already made this argument for vendor TDS and
--     it is the same argument.
--
-- ---------------------------------------------------------------------
-- MONEY IS ENFORCED TWICE, which recurring finding 2 of the improvement
-- programme asks for and which a payroll needs more than most surfaces.
--
-- The computation below is the only writer of a line's figures, and it
-- runs in SQL numeric — never in JavaScript, per rule 5. On top of that
-- the table carries the arithmetic as CHECK constraints: the four paid
-- heads sum to the gross, and the gross less the four statutory
-- deductions equals the net. A CHECK cannot be reached around, so a
-- future caller that assembled a line by hand cannot produce a payslip
-- whose own figures do not add up.
--
-- ---------------------------------------------------------------------
-- THE DISBURSEMENT IS THE PAYMENTS WORKSPACE'S, NOT A SECOND ONE.
--
-- Finalising a run raises one `payment_requests` row per employee, of a
-- new kind `salary`, and that is the whole of the handoff. The payments
-- workspace already holds the approval, the maker-checker rule enforced
-- in both the route and the trigger, the paid-once guard, the bank
-- reference, and the register an accountant reads. A second path to move
-- money out would duplicate every one of those and split the answer to
-- "what left the bank this month" across two screens.
--
-- Three small widenings make the existing table fit, and each is
-- additive — a widened CHECK accepts every row that was already valid,
-- so none of them needs a backfill:
--
--   kind      gains 'salary'. A salary is neither an advance nor a
--             reimbursement, and calling it one of those would put it in
--             the wrong bucket of a register somebody reconciles.
--   category  gains 'payroll', for the same reason: 'labour' means a
--             labour contractor's bill.
--   the proof shape admits a salary request carrying a REFERENCE with no
--             FILENAME. 0080 requires both because its proof is an
--             uploaded bill. The proof of a salary payment is the
--             finalised payroll run, which is a record inside this
--             product; inventing a filename for a file that does not
--             exist would be the lie the constraint was written to stop.
--
-- The LINK is held here, on `payroll_run_lines.payment_request_id`, and
-- not as a column on `payment_requests`. It belongs to the module that
-- knows about both, the unique index on it is what makes the handoff
-- idempotent, and it leaves the payments schema alone.
--
-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * No attendance capture. The mock's workspace clocks in against a
--     geofence, and its own banner says the record lives in the browser.
--     A payroll needs loss-of-pay days and this takes them as a number
--     the payroll clerk enters per line, which is what a monthly payroll
--     actually consumes. Attendance is a product, not a column.
--
--   * No leave ledger. Same reason, plus a sharper one: the mock's own
--     loss-of-pay arithmetic subtracts a leave BALANCE from a leave
--     REQUEST and calls the remainder LOP, which double-counts every
--     approved leave inside its balance.
--
--   * No PF ECR, ESI contribution or 24Q file generation. The mock's
--     "Generate" buttons produce nothing; the figures those files carry
--     are all on the line, and writing a Government file format is a
--     pack with its own certification.
--
--   * No income-tax SURCHARGE. See § 6: the computation REFUSES an
--     employee whose projected total income reaches the first surcharge
--     threshold rather than under-deducting quietly.
--
-- ---------------------------------------------------------------------
-- NAMED SQLSTATES. The 23H block is this pack's; 0089 opened it with
-- 23H01. `apps/server/src/routes/hr.ts` maps every one.
--
--   23H01  no statutory schedule covers this, or more than one does
--          (raised by 0089's resolver and by § 6 below)
--   23H02  a finalised or cancelled payroll run cannot be changed
--   23H03  the payroll run state transition is not allowed
--   23H04  the line cannot be written this way
--   23H05  the income-tax computation is out of its declared scope
--
-- ---------------------------------------------------------------------
-- LOCK ORDER. One lock, taken once: the run row, FOR UPDATE, by the
-- calculation and by the finalise path. Lines hang off it and nothing
-- else in the product references a run, so no path here can be half of
-- a cycle. The counter row is claimed by upsert as its own statement,
-- before the run row exists.

-- ---------------------------------------------------------------------
-- 1. The number.
--
-- `payment_request_counters` (0080) is the precedent, down to the shape:
-- a plain counter row per organisation per financial year, claimed by
-- upsert so two operators opening a run at once serialise on it. A
-- payroll run does NOT go through `document_number_series`: that
-- machinery configures the operator-editable formats of issued STATUTORY
-- documents, and while a payroll run is issued, its number is internal
-- and has no format anybody outside the organisation reads.
-- ---------------------------------------------------------------------
CREATE TABLE payroll_run_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, fy_label)
);

COMMENT ON TABLE payroll_run_counters IS
  'Per organisation, per financial year, the next payroll-run sequence. Claimed by upsert so concurrent openings serialise on the counter row rather than both reading the same next value.';

-- Migration 0064's rule for every counter in this schema: a counter may
-- only ever go up. A cancelled run keeps its number, so rewinding would
-- hand a number out twice.
CREATE TRIGGER payroll_run_counters_guard_decrease
  BEFORE UPDATE ON payroll_run_counters
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TRIGGER payroll_run_counters_touch_updated_at
  BEFORE UPDATE ON payroll_run_counters
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE payroll_run_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_run_counters_tenant_policy ON payroll_run_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE ON payroll_run_counters TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 2. The run.
--
-- One month of payroll for the whole organisation. NOT per Work: a
-- salary is paid by the agency, not by a contract, and the same site
-- engineer works on three Works in a month. That is why nothing here
-- carries a `work_id` and why the work-supersession census (0071) lists
-- these tables as exempt with that argument.
-- ---------------------------------------------------------------------
CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  run_number text NOT NULL CHECK (
    btrim(run_number) = run_number AND length(run_number) BETWEEN 3 AND 40
  ),

  -- The month being paid, as its FIRST DAY. Date-only per rule 6, and a
  -- date rather than a (year, month) pair because every comparison this
  -- schema makes — is the schedule in force, which contribution period
  -- is this, how many months are left in the year — is a date
  -- comparison, and a pair would be reassembled into one at every site.
  period_month date NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),

  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'finalized', 'cancelled')
  ),

  -- When the figures were last computed. A draft that has been opened
  -- and not yet calculated has no lines and no timestamp.
  calculated_at timestamptz,

  finalized_at timestamptz,
  finalized_by_user_id text,

  cancelled_at timestamptz,
  cancelled_by_user_id text,
  cancel_reason text,

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, fy_label, sequence_number),
  UNIQUE (organisation_id, run_number),

  -- `finalized_at` records that the run WAS finalised, which stays true
  -- after it is cancelled.
  --
  -- Written as three one-way rules rather than as the equivalence
  -- `(status = 'finalized') = (finalized_at IS NOT NULL)`, which is what
  -- this was first and which made a finalised run impossible to cancel:
  -- the equivalence demanded the timestamp be cleared the moment the
  -- status left 'finalized', and clearing it would erase the fact that
  -- the run had ever been issued — on the one record a provident-fund
  -- inspector reads to see what happened. A cancelled run that was
  -- finalised first keeps both marks, which is the truth about it.
  CONSTRAINT payroll_runs_finalized_shape_check CHECK (
    (finalized_at IS NULL) = (finalized_by_user_id IS NULL)
    AND (status <> 'finalized' OR finalized_at IS NOT NULL)
    AND (status <> 'draft' OR finalized_at IS NULL)
  ),
  CONSTRAINT payroll_runs_cancel_shape_check CHECK (
    (cancelled_at IS NULL AND cancelled_by_user_id IS NULL
      AND cancel_reason IS NULL)
    OR (
      cancelled_at IS NOT NULL
      AND cancelled_by_user_id IS NOT NULL
      AND cancel_reason IS NOT NULL
      AND length(btrim(cancel_reason)) BETWEEN 3 AND 500
    )
  ),
  CONSTRAINT payroll_runs_cancelled_status_check CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),
  -- The financial year on the row and the one its month falls in are the
  -- same statement, so they may not disagree — and this is the copy the
  -- counter is keyed by, so a disagreement would number a run into the
  -- wrong series.
  --
  -- Written as two shifts rather than a CASE because it has to be an
  -- immutable expression a CHECK can carry, and because the arithmetic
  -- is then obvious: the Indian year starts in April, so three months
  -- back always lands in its first calendar year and nine months forward
  -- always lands in its second. August 2026 → '2026' and '27'; March
  -- 2027 → '2026' and '27'; April 2027 → '2027' and '28'.
  --
  -- Deliberately NOT a SQL twin of `financialYearLabel`
  -- (apps/server/src/financial-year.ts), whose own header says it must be
  -- the only implementation because the statutory adapter hashes over its
  -- output. This is a constraint on one column, not a second producer of
  -- the label.
  CONSTRAINT payroll_runs_fy_matches_period_check CHECK (
    fy_label = to_char(period_month - INTERVAL '3 months', 'YYYY')
               || '-' || to_char(period_month + INTERVAL '9 months', 'YY')
  )
);

COMMENT ON TABLE payroll_runs IS
  'One month of payroll for the whole organisation. Organisation-scoped and never per Work: a salary is paid by the agency, and the same engineer works on three contracts in a month. Once finalised it is an issued document — immutable, numbered gap-free per financial year, and cancelled with a reason rather than deleted.';
COMMENT ON COLUMN payroll_runs.period_month IS
  'The month being paid, as its first day. A date rather than a (year, month) pair because every question this schema asks of it — which schedule was in force, which ESI contribution period this is, how many months of the year remain — is a date comparison.';
COMMENT ON CONSTRAINT payroll_runs_fy_matches_period_check ON payroll_runs IS
  'The stored financial-year label and the one the period month falls in are the same statement. Two copies of one fact eventually disagree, and this is the copy a counter is keyed by.';

-- ONE LIVE RUN PER MONTH. A cancelled run keeps its number and its
-- figures, and the month may then be run again — which is exactly what
-- cancelling is for. A partial unique index makes the second LIVE run
-- impossible rather than merely refused.
CREATE UNIQUE INDEX payroll_runs_one_live_per_month
  ON payroll_runs (organisation_id, period_month)
  WHERE status <> 'cancelled';

-- The register, newest month first, with the id closing the key so a
-- keyset page has a total order.
CREATE INDEX payroll_runs_register_idx
  ON payroll_runs (organisation_id, period_month DESC, id);

CREATE TRIGGER payroll_runs_touch_updated_at
  BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_runs_tenant_policy ON payroll_runs
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE, at any status. Rule 8's drafts-may-be-deleted exception is
-- deliberately not taken: a run has already claimed a number by the time
-- it exists, and deleting it would leave a gap in a series a PF
-- inspector reads. An abandoned draft is cancelled with a reason.
GRANT SELECT, INSERT, UPDATE ON payroll_runs TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 3. The line — one employee, one month, one payslip.
--
-- Thirty-odd columns, and each of them is a figure a payslip prints or a
-- statutory return asks for. The alternative shapes were considered and
-- both are worse: a jsonb blob puts money outside numeric where rule 5
-- forbids it, and a narrow line with the deductions in a child table
-- makes the net-pay arithmetic a join that no CHECK can see.
--
-- EVERYTHING IS SNAPSHOTTED, INCLUDING THE RATES. The employee's name
-- and PAN are here because a master-data correction must not rewrite a
-- finalised payslip (rule 7). The rates and ceilings are here because
-- 0089's schedules are ORG-EDITABLE — an owner correcting a mistyped
-- notification would otherwise silently restate every finalised month
-- that read it.
-- ---------------------------------------------------------------------
CREATE TABLE payroll_run_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  payroll_run_id uuid NOT NULL,
  employee_id uuid NOT NULL,

  -- ── Identity, snapshotted ──────────────────────────────────────────
  employee_code text NOT NULL,
  employee_name text NOT NULL,
  -- Nullable exactly as they are on the master: an employee may not yet
  -- have furnished a PAN or been allotted a UAN, and the run still has to
  -- pay them.
  pan text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  uan text CHECK (uan IS NULL OR uan ~ '^[0-9]{12}$'),
  esic_number text CHECK (esic_number IS NULL OR esic_number ~ '^[0-9]{17}$'),

  -- ── Attendance, as the payroll clerk states it ─────────────────────
  --
  -- Paid days is DERIVED and not stored: calendar less loss of pay is a
  -- subtraction, and a stored third number is somewhere for the two to
  -- disagree.
  calendar_days integer NOT NULL CHECK (calendar_days BETWEEN 28 AND 31),
  lop_days numeric(5, 2) NOT NULL DEFAULT 0 CHECK (lop_days >= 0),

  -- ── Earnings, pro-rated for the days actually paid ─────────────────
  basic money_amount NOT NULL CHECK (basic >= 0),
  dearness_allowance money_amount NOT NULL CHECK (dearness_allowance >= 0),
  house_rent_allowance money_amount NOT NULL CHECK (house_rent_allowance >= 0),
  other_allowances money_amount NOT NULL CHECK (other_allowances >= 0),
  gross_earnings money_amount NOT NULL CHECK (gross_earnings >= 0),

  -- ── Provident fund ─────────────────────────────────────────────────
  --
  -- `pf_wages` is basic plus dearness allowance as actually paid, capped
  -- at the ceiling where the employee's election says so. The employer's
  -- fund share is the TOTAL less the pension share, computed as a
  -- subtraction rather than as a third rate: the much-quoted 3.67% is
  -- only exactly 3.67% while the wage is at or below the pension
  -- ceiling, and asserting it as a rate would under-fund every employee
  -- above it.
  pf_wages money_amount NOT NULL DEFAULT 0 CHECK (pf_wages >= 0),
  epf_employee money_amount NOT NULL DEFAULT 0 CHECK (epf_employee >= 0),
  epf_employer money_amount NOT NULL DEFAULT 0 CHECK (epf_employer >= 0),
  eps_employer money_amount NOT NULL DEFAULT 0 CHECK (eps_employer >= 0),
  epf_employee_rate numeric(14, 4) CHECK (
    epf_employee_rate IS NULL OR epf_employee_rate >= 0
  ),
  epf_employer_total_rate numeric(14, 4) CHECK (
    epf_employer_total_rate IS NULL OR epf_employer_total_rate >= 0
  ),
  eps_rate numeric(14, 4) CHECK (eps_rate IS NULL OR eps_rate >= 0),
  eps_wage_ceiling money_amount CHECK (
    eps_wage_ceiling IS NULL OR eps_wage_ceiling >= 0
  ),

  -- ── Employees' State Insurance ─────────────────────────────────────
  --
  -- `esi_covered` is a fact about this month, not about the employee:
  -- coverage turns on the gross against the ceiling, and on the rule
  -- that keeps a mid-period riser contributing to the end of the
  -- contribution period.
  esi_covered boolean NOT NULL DEFAULT false,
  esi_wages money_amount NOT NULL DEFAULT 0 CHECK (esi_wages >= 0),
  esi_employee money_amount NOT NULL DEFAULT 0 CHECK (esi_employee >= 0),
  esi_employer money_amount NOT NULL DEFAULT 0 CHECK (esi_employer >= 0),
  esi_employee_rate numeric(14, 4) CHECK (
    esi_employee_rate IS NULL OR esi_employee_rate >= 0
  ),
  esi_employer_rate numeric(14, 4) CHECK (
    esi_employer_rate IS NULL OR esi_employer_rate >= 0
  ),
  esi_gross_ceiling money_amount CHECK (
    esi_gross_ceiling IS NULL OR esi_gross_ceiling >= 0
  ),

  -- ── Profession tax ─────────────────────────────────────────────────
  professional_tax money_amount NOT NULL DEFAULT 0
    CHECK (professional_tax >= 0),
  professional_tax_state_code text CHECK (
    professional_tax_state_code IS NULL
    OR professional_tax_state_code ~ '^[0-9]{2}$'
  ),

  -- ── Income tax, section 192 ────────────────────────────────────────
  --
  -- The two projections are stored beside the deduction because a
  -- monthly TDS figure is otherwise unexplainable: it is one twelfth-ish
  -- of a year's estimated tax net of what has already been deducted, and
  -- an employee asking "why did ₹3,100 come off" needs the year the
  -- employer estimated, not the month.
  tax_regime text NOT NULL CHECK (tax_regime IN ('old', 'new')),
  projected_annual_income money_amount NOT NULL DEFAULT 0
    CHECK (projected_annual_income >= 0),
  projected_annual_tax money_amount NOT NULL DEFAULT 0
    CHECK (projected_annual_tax >= 0),
  tds money_amount NOT NULL DEFAULT 0 CHECK (tds >= 0),

  net_pay money_amount NOT NULL CHECK (net_pay >= 0),

  -- The handoff, held here rather than on payment_requests. Unique so
  -- finalising twice cannot raise a second request for one line, and
  -- nullable because a line of a draft run has not been handed off yet.
  payment_request_id uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- One line per employee per run. The whole computation assumes it.
  UNIQUE (organisation_id, payroll_run_id, employee_id),
  FOREIGN KEY (organisation_id, payroll_run_id)
    REFERENCES payroll_runs(organisation_id, id),
  FOREIGN KEY (organisation_id, employee_id)
    REFERENCES employees(organisation_id, id),
  FOREIGN KEY (organisation_id, payment_request_id)
    REFERENCES payment_requests(organisation_id, id),

  CONSTRAINT payroll_run_lines_paid_days_check CHECK (
    lop_days <= calendar_days
  ),
  -- MONEY ENFORCED TWICE, first arm: the heads add up to the gross.
  CONSTRAINT payroll_run_lines_gross_check CHECK (
    gross_earnings = basic + dearness_allowance + house_rent_allowance
                     + other_allowances
  ),
  -- Second arm: the gross less the four statutory deductions is the net.
  -- The employer's contributions are a cost to the organisation and
  -- never come off the employee's pay, which is the mistake this CHECK
  -- exists to make impossible.
  CONSTRAINT payroll_run_lines_net_check CHECK (
    net_pay = gross_earnings - epf_employee - esi_employee
              - professional_tax - tds
  ),
  -- A contribution without the rate that produced it cannot be put on a
  -- return, so it may not be recorded at all. Both arms of each pair.
  CONSTRAINT payroll_run_lines_pf_shape_check CHECK (
    (pf_wages = 0 AND epf_employee = 0 AND epf_employer = 0
      AND eps_employer = 0 AND epf_employee_rate IS NULL
      AND epf_employer_total_rate IS NULL AND eps_rate IS NULL
      AND eps_wage_ceiling IS NULL)
    OR (epf_employee_rate IS NOT NULL AND epf_employer_total_rate IS NOT NULL
      AND eps_rate IS NOT NULL AND eps_wage_ceiling IS NOT NULL)
  ),
  CONSTRAINT payroll_run_lines_esi_shape_check CHECK (
    esi_covered = (esi_employee_rate IS NOT NULL)
    AND esi_covered = (esi_employer_rate IS NOT NULL)
    AND esi_covered = (esi_gross_ceiling IS NOT NULL)
    AND (esi_covered OR (esi_wages = 0 AND esi_employee = 0 AND esi_employer = 0))
  ),
  CONSTRAINT payroll_run_lines_professional_tax_shape_check CHECK (
    professional_tax = 0 OR professional_tax_state_code IS NOT NULL
  )
);

COMMENT ON TABLE payroll_run_lines IS
  'One employee''s payslip for one month: the days paid, the earnings pro-rated to them, every statutory deduction with the rate and ceiling that produced it, and the net. Every figure is snapshotted, including the rates, because the schedules of 0089 are org-editable and a finalised month must never restate.';
COMMENT ON COLUMN payroll_run_lines.epf_employer IS
  'The employer''s provident-fund share: the total employer contribution less the pension share, computed as a subtraction. The widely quoted 3.67% is only exactly 3.67% while the wage is at or below the pension ceiling; above it the fund share is larger, and storing 3.67% as a rate would under-fund every such employee.';
COMMENT ON COLUMN payroll_run_lines.esi_covered IS
  'Whether ESI was deducted for THIS month. It turns on the gross against the ceiling and on the rule that an employee who crosses the ceiling mid-period keeps contributing to the end of that contribution period, so it is a fact about the month and not about the person.';
COMMENT ON COLUMN payroll_run_lines.projected_annual_tax IS
  'The year''s tax the employer estimated under section 192, of which this month''s TDS is the instalment. Stored because a monthly deduction is otherwise unexplainable to the employee it came off.';
COMMENT ON COLUMN payroll_run_lines.payment_request_id IS
  'The payments-workspace request this line was handed off to when the run was finalised. Held here rather than as a column on payment_requests: this module knows about both, and the unique index below is what makes finalising idempotent.';
COMMENT ON CONSTRAINT payroll_run_lines_net_check ON payroll_run_lines IS
  'Money enforced twice. The employer''s provident-fund and insurance contributions are a cost to the organisation and never come off the employee''s pay; this CHECK makes a payslip that took them off impossible rather than merely unlikely.';

CREATE INDEX payroll_run_lines_run_idx
  ON payroll_run_lines (organisation_id, payroll_run_id, employee_code);
-- The employee's own history, which the year-to-date arithmetic of § 6
-- reads on every recalculation.
CREATE INDEX payroll_run_lines_employee_idx
  ON payroll_run_lines (organisation_id, employee_id, id);
-- The foreign key's own leading index, non-partial, for the reason
-- `test/fk-index-coverage.integration.test.ts` states: referential
-- integrity cannot use a partial one.
CREATE INDEX payroll_run_lines_payment_request_idx
  ON payroll_run_lines (organisation_id, payment_request_id);
-- One request per line, and therefore at most one salary request per
-- employee per run. This is what makes the handoff idempotent under a
-- retried finalise.
CREATE UNIQUE INDEX payroll_run_lines_one_request_per_line
  ON payroll_run_lines (organisation_id, payment_request_id)
  WHERE payment_request_id IS NOT NULL;

CREATE TRIGGER payroll_run_lines_touch_updated_at
  BEFORE UPDATE ON payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE payroll_run_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY payroll_run_lines_tenant_policy ON payroll_run_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- DELETE is granted, and § 7's guard is what keeps it honest: a DRAFT is
-- recalculated by clearing its lines and computing them again, which is
-- rule 8's drafts-may-be-deleted applied to the only rows it fits. The
-- moment the run is finalised or cancelled the guard refuses every
-- delete, so the payslips of an issued run cannot be removed.
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_run_lines TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 4. The payments workspace, widened by three additive changes.
--
-- See the header for the argument. A widened CHECK accepts every row
-- that was already valid, so none of this needs a backfill or the NOT
-- VALID / VALIDATE dance — the same reasoning 0080 § bill_payment_
-- deductions used when it added two heads.
-- ---------------------------------------------------------------------
ALTER TABLE payment_requests
  DROP CONSTRAINT payment_requests_kind_check;

ALTER TABLE payment_requests
  ADD CONSTRAINT payment_requests_kind_check CHECK (
    kind IN ('advance', 'reimbursement', 'salary')
  );

ALTER TABLE payment_requests
  DROP CONSTRAINT payment_requests_category_check;

ALTER TABLE payment_requests
  ADD CONSTRAINT payment_requests_category_check CHECK (
    category IN (
      'travel', 'materials', 'labour', 'site_expenses', 'general', 'payroll'
    )
  );

ALTER TABLE payment_requests
  DROP CONSTRAINT payment_requests_proof_shape_check;

ALTER TABLE payment_requests
  ADD CONSTRAINT payment_requests_proof_shape_check CHECK (
    (proof_reference IS NULL AND proof_filename IS NULL)
    OR (proof_reference IS NOT NULL AND proof_filename IS NOT NULL)
    -- The proof of a salary payment is the finalised payroll run, which
    -- is a record inside this product and not an uploaded bill. Naming a
    -- file that does not exist is the lie the constraint was written to
    -- prevent, so the salary arm carries the reference alone.
    OR (kind = 'salary' AND proof_reference IS NOT NULL
        AND proof_filename IS NULL)
  );

COMMENT ON COLUMN payment_requests.kind IS
  'An employee advance, a reimbursement, or a salary handed off from a finalised payroll run (0090). A salary is neither of the first two and putting it in one of their buckets would misstate a register somebody reconciles; the one-open-advance rule and the bills gate apply to advances only, so a salary settles on payment exactly as a reimbursement does.';

-- ---------------------------------------------------------------------
-- 5. The contribution period, and the month arithmetic the run needs.
--
-- ESI runs two contribution periods a year — 1 April to 30 September and
-- 1 October to 31 March — and they are not the financial year's halves
-- by coincidence but by regulation 4 of the ESI (General) Regulations.
-- The continuation rule in § 6 needs the START of the period a month
-- falls in, so it is written once here rather than inline at the one
-- call site that will become three.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.esi_contribution_period_start(p_month date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN EXTRACT(MONTH FROM p_month) BETWEEN 4 AND 9
      THEN make_date(EXTRACT(YEAR FROM p_month)::integer, 4, 1)
    WHEN EXTRACT(MONTH FROM p_month) >= 10
      THEN make_date(EXTRACT(YEAR FROM p_month)::integer, 10, 1)
    ELSE make_date(EXTRACT(YEAR FROM p_month)::integer - 1, 10, 1)
  END
$$;

COMMENT ON FUNCTION app_private.esi_contribution_period_start(date) IS
  'The first day of the ESI contribution period a month falls in: April to September, or October to March. Regulation 4 of the ESI (General) Regulations 1950, and the boundary the mid-period continuation rule is measured from.';

-- ---------------------------------------------------------------------
-- 6. The computation.
--
-- ONE FUNCTION, because the payslip, the register total and the payment
-- request are all this arithmetic and three implementations of it would
-- be three answers to "what is this person paid".
--
-- IT RUNS IN SQL, per rule 5. Every figure below is PostgreSQL numeric.
-- Nothing about a payroll goes through JavaScript floating point, and the
-- route's only job is to say which run to compute.
--
-- ponytail: a FOR loop, one employee at a time, and the ceiling is real —
-- a set-based INSERT ... SELECT would be faster on thousands of rows.
-- Taken deliberately: a monthly run for a works contractor is tens to low
-- hundreds of lines, the loop is what lets a refusal NAME the employee it
-- is about, and the year-to-date reads are per employee anyway. The
-- upgrade, if an organisation ever runs thousands, is lateral joins.
--
-- ROUNDING IS PER STATUTE AND NOT PER TASTE, and the three differ:
--
--   * EPF and EPS contributions round to the NEAREST rupee. The EPFO's
--     ECR file carries whole rupees and its own instruction is to round
--     each contribution.
--   * ESI contributions round UP to the next rupee, both shares.
--     Regulation 40 of the ESI (General) Regulations says so in those
--     words, and rounding an ESI share down is a short remittance.
--   * The year's income tax rounds to the nearest multiple of TEN rupees
--     under section 288B; the monthly instalment then rounds to the
--     nearest rupee.
--
--   Earnings themselves are pro-rated to the PAISA, because the gross is
--   what the employee is owed and the statutory bases are computed from
--   it before anything is rounded.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.calculate_payroll_run(p_run_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
-- Not SECURITY DEFINER: every table it touches is one the caller may
-- already read and write under RLS, and a definer function here would
-- compute one organisation's payroll from another's schedules.
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run             payroll_runs%ROWTYPE;
  v_period_end      date;
  v_calendar_days   integer;
  v_months_left     integer;
  v_fy_start        date;
  v_fy_end          date;
  v_esi_period      date;
  v_line            record;
  -- The loss-of-pay days already on the run, carried across the rebuild.
  -- A jsonb map rather than a temporary table: a temp table needs TEMP
  -- privilege on the database, which nothing else in this schema assumes
  -- of the application role, and the map is a few dozen entries.
  v_lop_carry       jsonb;
  v_age_category    text;

  -- Rates, read once per run rather than once per employee: they are the
  -- same for everybody in a month, and the resolver refuses loudly, so
  -- reading them up front fails the whole run before it writes a row.
  v_epf_employee_rate       numeric;
  v_epf_employer_rate       numeric;
  v_eps_rate                numeric;
  v_eps_ceiling             numeric;
  v_epf_ceiling             numeric;
  v_esi_employee_rate       numeric;
  v_esi_employer_rate       numeric;
  v_esi_ceiling             numeric;
  v_cess_rate               numeric;
  v_surcharge_floor         numeric;

  v_basic           numeric;
  v_da              numeric;
  v_hra             numeric;
  v_other           numeric;
  v_gross           numeric;
  v_paid_days       numeric;

  v_pf_wages        numeric;
  v_epf_employee    numeric;
  v_epf_employer    numeric;
  v_eps_employer    numeric;
  v_epf_total       numeric;

  v_esi_covered     boolean;
  v_esi_employee    numeric;
  v_esi_employer    numeric;

  v_pt              numeric;
  v_pt_rows         integer;

  v_ytd_gross       numeric;
  v_ytd_pt          numeric;
  v_ytd_tds         numeric;
  v_projected       numeric;
  v_standard        numeric;
  v_total_income    numeric;
  v_tax             numeric;
  v_rebate_limit    numeric;
  v_rebate_cap      numeric;
  v_annual_tax      numeric;
  v_tds             numeric;
  v_net             numeric;
  v_written         integer := 0;
BEGIN
  -- The run row is the only lock this function takes, and it is taken
  -- first: two operators pressing Calculate at once serialise here, so
  -- the second recomputes from a state the first has finished writing
  -- rather than interleaving deletes and inserts with it.
  SELECT * INTO v_run FROM payroll_runs WHERE id = p_run_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'the payroll run this transaction is calculating is not visible to it'
      USING ERRCODE = '23H04';
  END IF;

  IF v_run.status <> 'draft' THEN
    RAISE EXCEPTION
      'payroll run % is % and its figures are settled', v_run.run_number,
      v_run.status
      USING ERRCODE = '23H02';
  END IF;

  v_period_end := (v_run.period_month + INTERVAL '1 month' - INTERVAL '1 day')::date;
  v_calendar_days := EXTRACT(DAY FROM v_period_end)::integer;
  v_esi_period := app_private.esi_contribution_period_start(v_run.period_month);
  v_fy_start := CASE
    WHEN EXTRACT(MONTH FROM v_run.period_month) >= 4
      THEN make_date(EXTRACT(YEAR FROM v_run.period_month)::integer, 4, 1)
    ELSE make_date(EXTRACT(YEAR FROM v_run.period_month)::integer - 1, 4, 1)
  END;
  -- 31 March. The age tests below are written against it because both
  -- sections say "at any time during the previous year", which is the
  -- last day of it.
  v_fy_end := (v_fy_start + INTERVAL '1 year' - INTERVAL '1 day')::date;
  -- This month included: section 192 spreads the year's remaining tax
  -- over the months still to be paid, and this is one of them.
  v_months_left := 12 - (
    (EXTRACT(YEAR FROM v_run.period_month)::integer * 12
      + EXTRACT(MONTH FROM v_run.period_month)::integer)
    - (EXTRACT(YEAR FROM v_fy_start)::integer * 12
      + EXTRACT(MONTH FROM v_fy_start)::integer)
  );

  -- Every rate the run needs, resolved AT THE RUN'S OWN MONTH. A run for
  -- June 2019 reads June 2019's ESI rate, which is not July's.
  v_epf_employee_rate := app_private.payroll_statutory_value(
    v_run.organisation_id, 'epf_employee_percent', v_run.period_month);
  v_epf_employer_rate := app_private.payroll_statutory_value(
    v_run.organisation_id, 'epf_employer_total_percent', v_run.period_month);
  v_eps_rate := app_private.payroll_statutory_value(
    v_run.organisation_id, 'eps_employer_percent', v_run.period_month);
  v_eps_ceiling := app_private.payroll_statutory_value(
    v_run.organisation_id, 'eps_monthly_wage_ceiling_rupees', v_run.period_month);
  v_epf_ceiling := app_private.payroll_statutory_value(
    v_run.organisation_id, 'epf_monthly_wage_ceiling_rupees', v_run.period_month);
  v_esi_employee_rate := app_private.payroll_statutory_value(
    v_run.organisation_id, 'esi_employee_percent', v_run.period_month);
  v_esi_employer_rate := app_private.payroll_statutory_value(
    v_run.organisation_id, 'esi_employer_percent', v_run.period_month);
  v_esi_ceiling := app_private.payroll_statutory_value(
    v_run.organisation_id, 'esi_monthly_gross_ceiling_rupees', v_run.period_month);
  v_cess_rate := app_private.payroll_statutory_value(
    v_run.organisation_id, 'income_tax_cess_percent', v_run.period_month);
  v_surcharge_floor := app_private.payroll_statutory_value(
    v_run.organisation_id, 'income_tax_surcharge_floor_rupees', v_run.period_month);

  -- The recalculation. Loss-of-pay days are the one figure an operator
  -- states rather than the product deriving, so they are carried across
  -- the rebuild instead of being retyped every time the run is
  -- recomputed.
  SELECT coalesce(jsonb_object_agg(employee_id::text, lop_days), '{}'::jsonb)
    INTO v_lop_carry
    FROM payroll_run_lines
   WHERE payroll_run_id = p_run_id;

  DELETE FROM payroll_run_lines WHERE payroll_run_id = p_run_id;

  FOR v_line IN
    SELECT e.*, c.designation AS name, c.pan AS contact_pan,
           coalesce((v_lop_carry ->> e.id::text)::numeric, 0) AS carried_lop
    FROM employees e
    JOIN contacts c
      ON c.organisation_id = e.organisation_id AND c.id = e.contact_id
    WHERE e.organisation_id = v_run.organisation_id
      -- Employed for at least part of the month: joined on or before its
      -- last day, and not gone before its first.
      AND e.date_of_joining <= v_period_end
      AND (e.date_of_exit IS NULL OR e.date_of_exit >= v_run.period_month)
    ORDER BY lower(e.employee_code)
  LOOP
    IF v_line.carried_lop > v_calendar_days THEN
      RAISE EXCEPTION
        'employee % has % loss-of-pay days recorded in a month of % days',
        v_line.employee_code, v_line.carried_lop, v_calendar_days
        USING ERRCODE = '23H04';
    END IF;

    v_paid_days := v_calendar_days - v_line.carried_lop;

    -- Earnings, pro-rated to the paisa. Each head separately, because the
    -- provident-fund base is two of them and the insurance base is all
    -- four, and pro-rating a total would lose the split.
    v_basic := round(v_line.basic_monthly * v_paid_days / v_calendar_days, 2);
    v_da := round(
      v_line.dearness_allowance_monthly * v_paid_days / v_calendar_days, 2);
    v_hra := round(
      v_line.house_rent_allowance_monthly * v_paid_days / v_calendar_days, 2);
    v_other := round(
      v_line.other_allowances_monthly * v_paid_days / v_calendar_days, 2);
    v_gross := v_basic + v_da + v_hra + v_other;

    -- ── Provident fund ────────────────────────────────────────────────
    IF v_line.pf_covered THEN
      -- Section 2(b) read with paragraph 29: the provident-fund wage is
      -- basic wages plus dearness allowance, and nothing else here is in
      -- it.
      v_pf_wages := v_basic + v_da;
      IF v_line.pf_wage_basis = 'ceiling' THEN
        v_pf_wages := least(v_pf_wages, v_epf_ceiling);
      END IF;
      v_epf_employee := round(v_pf_wages * v_epf_employee_rate / 100);
      -- The pension share is capped by the PENSION ceiling, which is a
      -- different figure from the fund ceiling above and moves
      -- separately.
      v_eps_employer := round(
        least(v_pf_wages, v_eps_ceiling) * v_eps_rate / 100);
      v_epf_total := round(v_pf_wages * v_epf_employer_rate / 100);
      v_epf_employer := v_epf_total - v_eps_employer;

      IF v_epf_employer < 0 THEN
        RAISE EXCEPTION
          'the provident-fund schedule in force on % puts the pension share above the whole employer contribution',
          v_run.period_month
          USING ERRCODE = '23H01';
      END IF;
    ELSE
      v_pf_wages := 0;
      v_epf_employee := 0;
      v_eps_employer := 0;
      v_epf_employer := 0;
    END IF;

    -- ── Employees' State Insurance ────────────────────────────────────
    --
    -- Coverage this month is the ceiling test OR the continuation rule:
    -- an employee whose wages rise above the ceiling in the middle of a
    -- contribution period goes on contributing until that period ends.
    -- Reading it off the FINALISED runs of the period is what makes it a
    -- fact rather than an opinion — a draft is not yet anything.
    v_esi_covered := v_line.esi_applicable AND (
      v_gross <= v_esi_ceiling
      OR EXISTS (
        SELECT 1
        FROM payroll_run_lines pl
        JOIN payroll_runs pr
          ON pr.organisation_id = pl.organisation_id
         AND pr.id = pl.payroll_run_id
        WHERE pl.organisation_id = v_run.organisation_id
          AND pl.employee_id = v_line.id
          AND pl.esi_covered
          AND pr.status = 'finalized'
          AND pr.period_month >= v_esi_period
          AND pr.period_month < v_run.period_month
      )
    );

    IF v_esi_covered THEN
      -- Regulation 40: both shares round UP to the next rupee. Rounding
      -- an insurance share down is a short remittance, so this is ceil
      -- and not round.
      v_esi_employee := ceil(v_gross * v_esi_employee_rate / 100);
      v_esi_employer := ceil(v_gross * v_esi_employer_rate / 100);
    ELSE
      v_esi_employee := 0;
      v_esi_employer := 0;
    END IF;

    -- ── Profession tax ────────────────────────────────────────────────
    IF v_line.professional_tax_state_code IS NULL THEN
      v_pt := 0;
    ELSE
      SELECT count(*),
             -- February is the month a State's annual figure that does
             -- not divide by twelve is trued up in.
             max(CASE
               WHEN EXTRACT(MONTH FROM v_run.period_month) = 2
                 THEN coalesce(s.february_amount, s.monthly_amount)
               ELSE s.monthly_amount
             END)
        INTO v_pt_rows, v_pt
        FROM professional_tax_slabs s
       WHERE s.organisation_id = v_run.organisation_id
         AND s.state_code = v_line.professional_tax_state_code
         AND s.payee_category IN ('any', v_line.professional_tax_category)
         AND s.effective_from <= v_run.period_month
         AND (s.effective_to IS NULL OR s.effective_to >= v_run.period_month)
         AND s.monthly_wage_from <= v_gross
         AND (s.monthly_wage_to IS NULL OR s.monthly_wage_to > v_gross);

      IF v_pt_rows = 0 THEN
        RAISE EXCEPTION
          'no profession-tax band of State % covers a monthly wage of % on %; record the State schedule first',
          v_line.professional_tax_state_code, v_gross, v_run.period_month
          USING ERRCODE = '23H01';
      END IF;
      IF v_pt_rows > 1 THEN
        RAISE EXCEPTION
          'the profession-tax schedule of State % covers a monthly wage of % on % with % bands; correct the overlap',
          v_line.professional_tax_state_code, v_gross, v_run.period_month,
          v_pt_rows
          USING ERRCODE = '23H01';
      END IF;
    END IF;

    -- ── Income tax, section 192 ───────────────────────────────────────
    --
    -- The estimate the employer is required to make: the year's salary,
    -- the year's tax on it, less what has already been deducted, spread
    -- over the months still to be paid. Read from FINALISED runs only,
    -- for the same reason the ESI continuation rule is.
    SELECT coalesce(sum(pl.gross_earnings), 0),
           coalesce(sum(pl.professional_tax), 0),
           coalesce(sum(pl.tds), 0)
      INTO v_ytd_gross, v_ytd_pt, v_ytd_tds
      FROM payroll_run_lines pl
      JOIN payroll_runs pr
        ON pr.organisation_id = pl.organisation_id AND pr.id = pl.payroll_run_id
     WHERE pl.organisation_id = v_run.organisation_id
       AND pl.employee_id = v_line.id
       AND pr.status = 'finalized'
       AND pr.period_month >= v_fy_start
       AND pr.period_month < v_run.period_month;

    -- This month and every month left in the year at this month's rate.
    -- That is what an estimate is: the best statement available today.
    v_projected := v_ytd_gross + v_gross * v_months_left;

    IF v_line.tax_regime = 'old' THEN
      v_standard := app_private.payroll_statutory_value(
        v_run.organisation_id, 'standard_deduction_old_rupees',
        v_run.period_month);
      v_rebate_limit := app_private.payroll_statutory_value(
        v_run.organisation_id, 'rebate_87a_old_income_limit_rupees',
        v_run.period_month);
      v_rebate_cap := app_private.payroll_statutory_value(
        v_run.organisation_id, 'rebate_87a_old_cap_rupees', v_run.period_month);
      -- Section 10 exemptions the employee declared, then section 16's
      -- standard deduction and section 16(iii)'s profession tax, then
      -- Chapter VI-A. Profession tax for the year is what has been
      -- deducted plus what the remaining months will deduct.
      v_total_income := greatest(
        v_projected
          - v_line.declared_exempt_allowances_annual
          - v_standard
          - (v_ytd_pt + v_pt * v_months_left)
          - v_line.declared_chapter_via_annual,
        0);
    ELSE
      v_standard := app_private.payroll_statutory_value(
        v_run.organisation_id, 'standard_deduction_new_rupees',
        v_run.period_month);
      v_rebate_limit := app_private.payroll_statutory_value(
        v_run.organisation_id, 'rebate_87a_new_income_limit_rupees',
        v_run.period_month);
      v_rebate_cap := app_private.payroll_statutory_value(
        v_run.organisation_id, 'rebate_87a_new_cap_rupees', v_run.period_month);
      -- Section 115BAC(1A) allows the standard deduction and almost
      -- nothing else. Neither declaration above is available, and
      -- profession tax is not deductible either.
      v_total_income := greatest(v_projected - v_standard, 0);
    END IF;

    -- SURCHARGE IS OUT OF SCOPE, AND THE ANSWER IS A REFUSAL.
    --
    -- Surcharge and its marginal relief are not implemented. Computing
    -- the slab tax alone for somebody the surcharge reaches would
    -- UNDER-DEDUCT, and an under-deduction under section 192 is the
    -- employer's liability with interest. A refusal naming the employee
    -- sends the figure to a practitioner, which is where it belongs.
    --
    -- Strictly ABOVE the threshold, because the Finance Act says
    -- "exceeds": a total income of exactly ₹50,00,000 bears no surcharge
    -- and is computed here correctly. The same reading `statutory.ts`
    -- applies to the 194C thresholds, and the same boundary an operator
    -- meets on a round figure.
    IF v_total_income > v_surcharge_floor THEN
      RAISE EXCEPTION
        'employee % projects a total income of %, above the surcharge threshold of %, and this product does not compute surcharge',
        v_line.employee_code, v_total_income, v_surcharge_floor
        USING ERRCODE = '23H05';
    END IF;

    -- Sections 80-and-over and 60-and-over are written "at any time
    -- during the previous year", so the test is the age reached by 31
    -- March. The new regime's three ladders are identical (0089 § 5), so
    -- this selects the same numbers either way there.
    v_age_category := CASE
      WHEN (v_line.date_of_birth + INTERVAL '80 years')::date <= v_fy_end
        THEN 'super_senior'
      WHEN (v_line.date_of_birth + INTERVAL '60 years')::date <= v_fy_end
        THEN 'senior'
      ELSE 'general'
    END;

    IF NOT EXISTS (
      SELECT 1 FROM income_tax_slabs s
       WHERE s.organisation_id = v_run.organisation_id
         AND s.regime = v_line.tax_regime
         AND s.payee_category = v_age_category
         AND s.effective_from <= v_run.period_month
         AND (s.effective_to IS NULL OR s.effective_to >= v_run.period_month)
    ) THEN
      RAISE EXCEPTION
        'no % regime slab ladder for a % taxpayer is recorded as being in force on %; add the Finance Act schedule first',
        v_line.tax_regime, v_age_category, v_run.period_month
        USING ERRCODE = '23H01';
    END IF;

    -- The ladder, summed band by band over the part of the income each
    -- band actually covers. A band entirely above the income contributes
    -- a negative width, which `greatest(…, 0)` drops.
    SELECT coalesce(sum(
             greatest(
               least(v_total_income,
                     coalesce(s.annual_income_to, v_total_income))
               - s.annual_income_from,
               0)
             * s.rate / 100
           ), 0)
      INTO v_tax
      FROM income_tax_slabs s
     WHERE s.organisation_id = v_run.organisation_id
       AND s.regime = v_line.tax_regime
       AND s.payee_category = v_age_category
       AND s.effective_from <= v_run.period_month
       AND (s.effective_to IS NULL OR s.effective_to >= v_run.period_month);

    -- Section 87A. A rebate, capped, and only below the limit.
    IF v_total_income <= v_rebate_limit THEN
      v_tax := greatest(v_tax - v_rebate_cap, 0);
    ELSIF v_line.tax_regime = 'new' THEN
      -- Marginal relief, new regime: tax cannot exceed the income above
      -- the rebate limit. Without it an income one rupee over ₹12,00,000
      -- pays ₹60,000 of tax on that one rupee.
      v_tax := least(v_tax, v_total_income - v_rebate_limit);
    END IF;

    -- Health and education cess, then section 288B's rounding of the
    -- year's tax to the nearest ten rupees.
    v_annual_tax := round((v_tax * (1 + v_cess_rate / 100)) / 10) * 10;
    -- The instalment: what is still owed for the year over the months
    -- still to be paid. Floored at zero — an over-deduction earlier in
    -- the year is refunded by the department, not by a negative payslip
    -- line.
    v_tds := greatest(round((v_annual_tax - v_ytd_tds) / v_months_left), 0);

    v_net := v_gross - v_epf_employee - v_esi_employee - v_pt - v_tds;
    IF v_net < 0 THEN
      RAISE EXCEPTION
        'employee % has statutory deductions of % against earnings of %, which would pay a negative salary',
        v_line.employee_code, v_gross - v_net, v_gross
        USING ERRCODE = '23H04';
    END IF;

    INSERT INTO payroll_run_lines (
      organisation_id, payroll_run_id, employee_id,
      employee_code, employee_name, pan, uan, esic_number,
      calendar_days, lop_days,
      basic, dearness_allowance, house_rent_allowance, other_allowances,
      gross_earnings,
      pf_wages, epf_employee, epf_employer, eps_employer,
      epf_employee_rate, epf_employer_total_rate, eps_rate, eps_wage_ceiling,
      esi_covered, esi_wages, esi_employee, esi_employer,
      esi_employee_rate, esi_employer_rate, esi_gross_ceiling,
      professional_tax, professional_tax_state_code,
      tax_regime, projected_annual_income, projected_annual_tax, tds,
      net_pay
    )
    VALUES (
      v_run.organisation_id, p_run_id, v_line.id,
      v_line.employee_code, v_line.name, v_line.contact_pan, v_line.uan,
      v_line.esic_number,
      v_calendar_days, v_line.carried_lop,
      v_basic, v_da, v_hra, v_other, v_gross,
      v_pf_wages, v_epf_employee, v_epf_employer, v_eps_employer,
      CASE WHEN v_line.pf_covered THEN v_epf_employee_rate END,
      CASE WHEN v_line.pf_covered THEN v_epf_employer_rate END,
      CASE WHEN v_line.pf_covered THEN v_eps_rate END,
      CASE WHEN v_line.pf_covered THEN v_eps_ceiling END,
      v_esi_covered,
      CASE WHEN v_esi_covered THEN v_gross ELSE 0 END,
      v_esi_employee, v_esi_employer,
      CASE WHEN v_esi_covered THEN v_esi_employee_rate END,
      CASE WHEN v_esi_covered THEN v_esi_employer_rate END,
      CASE WHEN v_esi_covered THEN v_esi_ceiling END,
      v_pt, v_line.professional_tax_state_code,
      v_line.tax_regime, v_projected, v_annual_tax, v_tds,
      v_net
    );

    v_written := v_written + 1;
  END LOOP;

  UPDATE payroll_runs SET calculated_at = now() WHERE id = p_run_id;

  RETURN v_written;
END;
$$;

COMMENT ON FUNCTION app_private.calculate_payroll_run(uuid) IS
  'Computes every line of a draft payroll run in SQL numeric: earnings pro-rated to the days paid, provident fund on basic plus dearness allowance against two separate ceilings, insurance on the gross with the mid-period continuation rule, the State profession-tax band, and the section 192 instalment on a year projected from the finalised runs already behind it. Rounds per statute — nearest rupee for PF, up for ESI, nearest ten rupees for the year''s tax. Refuses rather than guesses wherever a schedule does not cover the case.';

REVOKE ALL ON FUNCTION app_private.calculate_payroll_run(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.calculate_payroll_run(uuid)
      TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 7. The guards.
--
-- The route makes each of these refusals first, under no lock, so an
-- operator gets a named 409 with a remedy. These are the arm that holds
-- when a writer reaches the table another way, and the arm that holds
-- under concurrency, which the route cannot.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_payroll_run_write()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A payroll run is opened as a draft, not as %.', NEW.status
        USING ERRCODE = '23H03';
    END IF;
    RETURN NEW;
  END IF;

  -- The identity of the document, frozen from the first write. These are
  -- true before anything is calculated, so they are frozen separately
  -- from the figures below.
  IF ROW(NEW.organisation_id, NEW.fy_label, NEW.sequence_number,
         NEW.run_number, NEW.period_month, NEW.created_by_user_id,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.organisation_id, OLD.fy_label, OLD.sequence_number,
         OLD.run_number, OLD.period_month, OLD.created_by_user_id,
         OLD.created_at)
  THEN
    RAISE EXCEPTION
      'A payroll run cannot change its number, its month or who opened it.'
      USING ERRCODE = '23H02';
  END IF;

  -- Terminal states are terminal, in both directions. A finalised run is
  -- an issued document and a cancelled one keeps its number forever.
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION
      'A cancelled payroll run is never reopened; run the month again.'
      USING ERRCODE = '23H03';
  END IF;

  -- A FINALISED RUN TAKES EXACTLY ONE FURTHER WRITE: the cancel.
  --
  -- Stated as one rule over the status rather than as three rules over
  -- the columns each would protect, and that is worth a sentence because
  -- the three-rule version was written first. It refused a return to
  -- draft, a second finalise that moved `finalized_at`, and a
  -- recalculation that moved `calculated_at` — and the state machine
  -- already implied all three, so each was a second statement of a rule
  -- that could drift from it. The wide rule is also STRONGER: it refuses
  -- a fourth change nobody thought of, where the narrow ones would each
  -- have let it through.
  --
  -- It is what makes finalising happen once. A retried finalise is the
  -- two-approvers race, and through the route it would raise a second
  -- set of salary payment requests — a second month's salary out of the
  -- bank.
  IF OLD.status = 'finalized' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION
      'Payroll run % is finalised: its figures are settled and the only change left to it is a cancellation.',
      OLD.run_number
      USING ERRCODE = '23H02';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_private.guard_payroll_run_write() IS
  'Holds the payroll run''s lifecycle: opened as a draft, finalised once, cancelled with a reason and never reopened, and its number, month and opener frozen from the first write. A finalised run takes exactly one further write, the cancel — which is what stops a retried finalise raising a second set of salary payment requests, and a second month''s salary leaving the bank.';

CREATE TRIGGER guard_payroll_run_write
  BEFORE INSERT OR UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_payroll_run_write();

CREATE FUNCTION app_private.guard_payroll_run_line_write()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_number text;
BEGIN
  SELECT status, run_number INTO v_status, v_number
  FROM payroll_runs
  WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.payroll_run_id
                  ELSE NEW.payroll_run_id END;

  IF v_status IS NULL THEN
    RAISE EXCEPTION
      'the payroll run this line belongs to is not visible to this transaction'
      USING ERRCODE = '23H04';
  END IF;

  -- A DRAFT is recalculated by clearing its lines and writing them
  -- again, which is the only reason DELETE is granted on this table at
  -- all. Everything else is an issued payslip.
  IF v_status <> 'draft' THEN
    -- The one write a finalised run's line still takes: the handoff
    -- stamping its payment request, once, on a line that has none.
    --
    -- Every other column is listed exhaustively rather than excluded by
    -- name, for the reason 0080's vendor-payment guard gives: a ROW
    -- comparison written as a denylist is a list somebody has to
    -- remember to extend, and the column added later and forgotten would
    -- be silently editable on an issued payslip.
    -- `packages/db/test/issued-immutability-coverage.integration.test.ts`
    -- is what refuses to let that happen quietly.
    IF TG_OP = 'UPDATE'
       AND OLD.payment_request_id IS NULL
       AND NEW.payment_request_id IS NOT NULL
       AND ROW(NEW.id, NEW.organisation_id, NEW.payroll_run_id,
               NEW.employee_id, NEW.employee_code, NEW.employee_name,
               NEW.pan, NEW.uan, NEW.esic_number,
               NEW.calendar_days, NEW.lop_days,
               NEW.basic, NEW.dearness_allowance, NEW.house_rent_allowance,
               NEW.other_allowances, NEW.gross_earnings,
               NEW.pf_wages, NEW.epf_employee, NEW.epf_employer,
               NEW.eps_employer, NEW.epf_employee_rate,
               NEW.epf_employer_total_rate, NEW.eps_rate,
               NEW.eps_wage_ceiling,
               NEW.esi_covered, NEW.esi_wages, NEW.esi_employee,
               NEW.esi_employer, NEW.esi_employee_rate,
               NEW.esi_employer_rate, NEW.esi_gross_ceiling,
               NEW.professional_tax, NEW.professional_tax_state_code,
               NEW.tax_regime, NEW.projected_annual_income,
               NEW.projected_annual_tax, NEW.tds, NEW.net_pay,
               NEW.created_at)
           IS NOT DISTINCT FROM
           ROW(OLD.id, OLD.organisation_id, OLD.payroll_run_id,
               OLD.employee_id, OLD.employee_code, OLD.employee_name,
               OLD.pan, OLD.uan, OLD.esic_number,
               OLD.calendar_days, OLD.lop_days,
               OLD.basic, OLD.dearness_allowance, OLD.house_rent_allowance,
               OLD.other_allowances, OLD.gross_earnings,
               OLD.pf_wages, OLD.epf_employee, OLD.epf_employer,
               OLD.eps_employer, OLD.epf_employee_rate,
               OLD.epf_employer_total_rate, OLD.eps_rate,
               OLD.eps_wage_ceiling,
               OLD.esi_covered, OLD.esi_wages, OLD.esi_employee,
               OLD.esi_employer, OLD.esi_employee_rate,
               OLD.esi_employer_rate, OLD.esi_gross_ceiling,
               OLD.professional_tax, OLD.professional_tax_state_code,
               OLD.tax_regime, OLD.projected_annual_income,
               OLD.projected_annual_tax, OLD.tds, OLD.net_pay,
               OLD.created_at)
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'Payroll run % is % and its payslips are a record of what was paid.',
      v_number, v_status
      USING ERRCODE = '23H02';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

COMMENT ON FUNCTION app_private.guard_payroll_run_line_write() IS
  'A payslip may be written, rewritten and cleared while its run is a draft, and after that only stamped once with the payment request the handoff raised. This is what makes the DELETE grant on this table safe: it exists for recalculating a draft and closes the moment the run is finalised or cancelled.';

CREATE TRIGGER guard_payroll_run_line_write
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_payroll_run_line_write();

-- `esi_contribution_period_start` is pure date arithmetic over its
-- argument and reads no table, but it follows the same revoke-then-grant
-- posture as its neighbours so the application role's access to
-- `app_private` stays an explicit list rather than a default.
REVOKE ALL ON FUNCTION app_private.esi_contribution_period_start(date)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.esi_contribution_period_start(date)
      TO auto_mb_app;
  END IF;
END
$$;
