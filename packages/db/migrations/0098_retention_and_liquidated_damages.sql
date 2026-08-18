SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0098: the money the railway keeps and does not give back yet
-- — retention / security deposit — and the money it keeps because the
-- work was late: liquidated damages.
--
-- Migration 0067 already records BOTH as deduction heads on a payment
-- advice: `SECURITY_DEPOSIT` since 0067 and `LIQUIDATED_DAMAGES` since
-- 0080. That is the right place for them and none of it moves. What was
-- missing is everything a deduction cannot say on its own:
--
--   * retention is WITHHELD, not spent. It comes back — half at the
--     Provisional Acceptance Certificate, the rest at the end of the
--     defect-liability period, or all of it at once against a bank
--     guarantee lodged in substitution. A deduction register that only
--     ever counts downwards can state what was taken and can never state
--     what is still held, which is the single figure an agency chases.
--
--   * liquidated damages are COMPUTED, from a rate, a delay and a cap.
--     Until now the product could record that the railway kept ₹7,50,000
--     under that head and had no way to say whether ₹7,50,000 was the
--     right number. LD is the one deduction an agency argues about, and
--     arguing needs the arithmetic written down.
--
-- ---------------------------------------------------------------------
-- WHAT IS DERIVED AND WHAT IS STORED, WHICH IS THE WHOLE DESIGN.
--
-- The retention HELD on a Work is NOT a column and not a ledger of
-- credits. It is the sum of the `SECURITY_DEPOSIT` deductions on the live
-- payments of that Work's bills — money the railway actually withheld,
-- recorded once, in the register that already owns it. A second table
-- mirroring those rows would be a second thing that can be wrong, and
-- 0087's rule against exactly that is why it does not exist here.
--
-- Only the RELEASE side is stored, because nothing in the product records
-- it. `retention_releases` is therefore one-directional on purpose: the
-- ledger is `held (derived) - released (stored) = balance`, and the one
-- invariant the database enforces is that the balance can never go
-- negative.
--
-- ---------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO.
--
-- It does not refuse a `LIQUIDATED_DAMAGES` deduction that disagrees with
-- an assessment on this table, and it does not refuse a
-- `SECURITY_DEPOSIT` deduction that carries the retention past the
-- contractual ceiling. Both were considered and both are wrong:
--
--   the deduction is what the RAILWAY DID. It is copied off a payment
--   advice that has already been acted on by a bank. An assessment on
--   this side is the AGENCY'S OWN reading of the contract, and it is a
--   check ON the advice, not a gate in front of it. A product that
--   refused to record a deduction because its own arithmetic disagreed
--   would send the operator straight back to the spreadsheet on the one
--   occasion the disagreement is the thing worth recording.
--
-- So the two figures are reported side by side and never netted. The
-- difference between "assessed" and "deducted" is the conversation; a
-- single number would hide it.
--
-- It also mints no number. A retention release and an LD assessment are
-- internal records — the railway issues its own advice with its own
-- reference, which is stored as free text — so there is no series to be
-- gap-free in, and inventing a counter would be numbering ceremony for a
-- row no counterparty ever reads. This follows 0091's reasoning for the
-- signing queue exactly.
--
-- ---------------------------------------------------------------------
-- THE SQLSTATE BLOCK IS 23P, one code per rule, for the reason 0067 § THE
-- REFUSALS CARRY THEIR OWN SQLSTATEs gives at length: the route turns a
-- trigger refusal that beat it to the row into a named 409, and matching
-- on the English of a RAISE means a reworded message silently downgrades
-- a 409 to a 500. Class 23 with a letter in the fourth position, so
-- PostgreSQL can never assign the same code to something else.
--
--   23P01  the release would exceed the retention actually withheld
--   23P02  a recorded release is immutable; withdraw it instead
--   23P03  the release is dated in the future in the organisation's own
--          timezone
--   23P04  the Work carries no liquidated-damages terms to assess against
--   23P05  an assessment's facts are frozen and its states run one way
--   23P06  the levied amount exceeds the assessment it is levied against
--   23P07  the row names a Work this transaction cannot read
--
-- Each also carries `CONSTRAINT`, so `error.constraint_name` names the
-- rule in a log without anybody decoding the number.
--
-- ENFORCED TWICE, AS MONEY MUST BE (0067 § ENFORCED TWICE). Every rule
-- below is also in `apps/server/src/routes/retention-ledger.ts`, checked
-- first and under a row lock so an operator gets a sentence rather than a
-- SQLSTATE. The split is the same: the database owns the arithmetic and
-- the structure, the route owns authority, work scope, the audit entry,
-- and the remedy.
--
-- ---------------------------------------------------------------------
-- THE NUMBERING GAP. This is migration 0098 and the series jumps from
-- 0091. 0092-0097 are allocated to another wave's packs and are not in
-- this tree. The runner sorts file names and requires only that ids be
-- unique (`packages/db/src/migration-runner.ts`), the ledger is keyed by
-- id, and the series already skips 0081 and 0085 for the same reason, so
-- the gap costs nothing. Recorded here so a reader does not go looking
-- for a lost file.

-- ── The authority ────────────────────────────────────────────────────
--
-- 0061's, 0080's and 0091's shape: an explicit per-member grant rather
-- than a role, defaulting to false and deliberately NOT backfilled.
--
-- Why it is its own authority rather than `payments`. The payments
-- authority (0080) governs money going OUT of the agency's bank — a
-- vendor invoice, an employee advance. This one governs the agency's
-- claim on money the RAILWAY is holding, and the two are read by
-- different people: the person who chases a security-deposit release at
-- the end of a maintenance period is the contracts clerk, not whoever
-- approves a travel claim. Granting one because someone holds the other
-- is the conflation the column exists to undo.
--
-- And why not `issue`. Recording a retention release states that money
-- came back. Nothing in the product can check that against a bank feed,
-- so the record is only as good as the authority behind it — which is
-- precisely the argument 0091 makes for separating signing from issuing.
--
-- NOT ADDED to `app_private.create_organisation_with_owner`, following
-- 0061 and 0080 rather than 0091. The founder of a new organisation
-- grants it once on the Members screen, exactly as they must for the
-- payments and statutory authorities. 0091 took the other branch and
-- argued the owner holds every authority implicitly; that argument is
-- about a NEW organisation being able to sign on day one, and this
-- authority has no day-one act — a retention release cannot exist before
-- a bill has been paid, which is months away. Re-creating a SECURITY
-- DEFINER function to save a checkbox nobody needs on the first day is
-- privilege change for no outcome.
ALTER TABLE organisation_memberships
  ADD COLUMN can_manage_retention boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organisation_memberships.can_manage_retention IS
  'Authority to record the contract''s retention and liquidated-damages terms, to record and withdraw a retention release, and to assess, levy or waive liquidated damages (0098). Separate from can_manage_payments: that authority sends the agency''s money out, this one states what the railway is holding and what it may keep. Not backfilled: an owner grants it per member.';

-- ── 1. The contract's own deduction terms ────────────────────────────
--
-- One row per Work, and only for the Works whose letter states these
-- terms — which is not all of them. A row here is the agency's reading of
-- the contract, recorded once so that every later assessment computes
-- from the same numbers rather than from whatever the person doing the
-- assessing remembered.
--
-- THE PERCENTAGES ARE TERMS, NOT COMPUTATIONS. Nothing in this table is
-- ever multiplied by anything at read time: an LD assessment SNAPSHOTS
-- the three LD terms onto its own row (see section 3), so editing this
-- table never rewrites an assessment already made. That is engineering
-- rule 7 — master-data edits never rewrite history — applied to a rate
-- rather than to a party name.
--
-- The retention pair is different in kind and is deliberately advisory.
-- `retention_percent` is what the contract says the railway may withhold
-- from each bill and `retention_limit_percent` is the ceiling on the
-- cumulative hold; both are shown beside what was ACTUALLY withheld so a
-- clerk can see an over-recovery. Neither refuses a deduction — see the
-- header for why a product must record what the railway did rather than
-- what the contract said it would do.
CREATE TABLE work_retention_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,

  -- Withheld from each on-account bill, as a percentage of the bill.
  retention_percent numeric(6,3)
    CHECK (retention_percent IS NULL OR retention_percent BETWEEN 0 AND 100),
  -- The ceiling on the cumulative hold, as a percentage of contract
  -- value. Typically 5% against a 10% per-bill rate, which is why the two
  -- are separate numbers and not one.
  retention_limit_percent numeric(6,3)
    CHECK (retention_limit_percent IS NULL OR retention_limit_percent BETWEEN 0 AND 100),

  -- How long after acceptance the balance is held. Shown on the screen as
  -- the period the release becomes chaseable after; it decides nothing on
  -- its own and so carries no guard.
  defect_liability_months integer
    CHECK (defect_liability_months IS NULL OR defect_liability_months BETWEEN 0 AND 120),

  -- The LD triple. All three together or none: an assessment needs a
  -- rate, a period and a cap, and two of the three is a computation that
  -- cannot be made. 0016's `works_pbg_requirement_coherent` is the same
  -- shape for the same reason.
  ld_rate_percent numeric(6,3)
    CHECK (ld_rate_percent IS NULL OR ld_rate_percent BETWEEN 0 AND 100),

  -- THE PERIOD IS A NUMBER OF DAYS, NOT A CALENDAR UNIT, and this is the
  -- one modelling decision in this migration worth arguing over.
  --
  -- Railway conditions of contract are written as "0.5% per week or part
  -- of a week" and "2% per month". A calendar month is not a fixed
  -- quantity — February and July differ by 10% — so "per month" over a
  -- delay measured in days has two defensible readings that give
  -- different money, and a product that picks one silently is asserting a
  -- contract term it was never told.
  --
  -- So the term is stored as the number of DAYS in one chargeable period.
  -- The screen offers 7 (per week) and 30 (per month) and lets the clerk
  -- type any other number the contract states. The arithmetic is then one
  -- exact integer division with no calendar in it, the stored value says
  -- exactly what was charged, and a contract that really does say
  -- "calendar month" is recorded by whoever read it rather than guessed
  -- at by whoever wrote this file. `docs/UX.md` § 21 records the
  -- divergence.
  ld_period_days integer
    CHECK (ld_period_days IS NULL OR ld_period_days BETWEEN 1 AND 366),

  -- The maximum LD, as a percentage of the assessment basis. Ten per cent
  -- is the usual figure and it is the reason an assessment is worth
  -- making at all: past the cap the railway may not levy more, and
  -- nothing else in the product would notice.
  ld_cap_percent numeric(6,3)
    CHECK (ld_cap_percent IS NULL OR ld_cap_percent BETWEEN 0 AND 100),

  -- Where the terms came from. Free text, and short: the clause number
  -- an operator would quote back at the railway.
  source_clause text CHECK (
    source_clause IS NULL
    OR (btrim(source_clause) = source_clause AND length(source_clause) BETWEEN 1 AND 200)
  ),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),

  recorded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- One row per Work. The terms are the contract's, and a contract has
  -- one set of them.
  UNIQUE (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id),

  CONSTRAINT work_retention_terms_ld_triple_coherent CHECK (
    (ld_rate_percent IS NULL AND ld_period_days IS NULL AND ld_cap_percent IS NULL)
    OR (ld_rate_percent IS NOT NULL AND ld_period_days IS NOT NULL
        AND ld_cap_percent IS NOT NULL)
  ),

  -- A row that states nothing is not a record, it is noise on the screen
  -- and an empty section in the export. At least one term has to be
  -- present for the row to exist.
  CONSTRAINT work_retention_terms_not_empty CHECK (
    retention_percent IS NOT NULL
    OR retention_limit_percent IS NOT NULL
    OR defect_liability_months IS NOT NULL
    OR ld_rate_percent IS NOT NULL
  )
);

COMMENT ON TABLE work_retention_terms IS
  'What one Work''s contract says about retention and liquidated damages. Advisory for retention — the railway withholds what it withholds and 0067 records that — and the SOURCE of the snapshot an LD assessment freezes onto itself, so editing this table never rewrites an assessment already made.';
COMMENT ON COLUMN work_retention_terms.ld_period_days IS
  'The length of one chargeable LD period, in days. Days rather than a calendar unit because "per month" over a delay measured in days has two defensible readings that give different money; 7 is per week, 30 the usual reading of per month, and any other figure the contract states is typed in.';
COMMENT ON COLUMN work_retention_terms.retention_limit_percent IS
  'The ceiling on the cumulative retention, as a percentage of contract value. Advisory: it is shown beside what was actually withheld so an over-recovery is visible, and it refuses no deduction.';

CREATE INDEX work_retention_terms_work_idx
  ON work_retention_terms (organisation_id, work_id);

ALTER TABLE work_retention_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_retention_terms FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY work_retention_terms_tenant_policy ON work_retention_terms
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- DELETE is granted, and it is the only table in this migration that gets
-- it. These are configuration, not a record of an act: a Work whose
-- letter turns out to state no retention terms at all should be able to
-- go back to having none, and the alternative — a row of NULLs that the
-- not-empty CHECK refuses anyway — is worse. Every assessment already
-- made keeps its own snapshot and is unaffected.
GRANT SELECT, INSERT, UPDATE, DELETE ON work_retention_terms TO auto_mb_app;

CREATE TRIGGER work_retention_terms_touch_updated_at
BEFORE UPDATE ON work_retention_terms
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ── 2. The retention that came back ──────────────────────────────────
--
-- One row per release event. A release is ordinarily partial — half at
-- PAC and half at the end of the defect-liability period is the standard
-- shape — so this is a list and the balance is a sum over it.
CREATE TABLE retention_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,

  -- A legal date, date-only, per engineering rule 6. The day the railway
  -- released the money, which is the day the agency quotes when it
  -- reconciles a bank credit against it.
  released_on date NOT NULL,

  amount money_amount NOT NULL CHECK (amount > 0),

  -- Why it came back. Each of the four is a different conversation with
  -- the railway and a different document behind it, which is the same
  -- reasoning that made 0067's deduction heads typed rows rather than
  -- free text.
  basis text NOT NULL CHECK (basis IN (
    -- The Provisional Acceptance Certificate released the first tranche.
    'pac',
    -- The defect-liability / maintenance period ended and the balance
    -- was released.
    'defect_liability_end',
    -- A bank guarantee was lodged and the cash retention returned
    -- against it. `work_instrument_id` names the guarantee.
    'bank_guarantee_substitution',
    -- Anything else, which must say what it is.
    'other'
  )),

  -- The guarantee lodged in substitution, where there is one. A real
  -- composite tenant foreign key rather than a reference by convention:
  -- 0006's `work_instruments` publishes `(organisation_id, id)`, so the
  -- database refuses an instrument of another organisation. It is
  -- REQUIRED for a substitution release and OPTIONAL otherwise, because a
  -- PAC-stage release is sometimes also made against a guarantee and
  -- forbidding the reference there would lose the link for no gain.
  work_instrument_id uuid,

  -- The railway's own advice or letter reference. Optional for the reason
  -- 0067 makes `bill_payments.reference` optional: a bank statement line
  -- sometimes carries none, and a required field with nothing to put in
  -- it becomes a field full of dashes.
  reference text CHECK (
    reference IS NULL
    OR (btrim(reference) = reference AND length(reference) BETWEEN 1 AND 100)
  ),
  description text CHECK (
    description IS NULL OR length(btrim(description)) BETWEEN 3 AND 200
  ),
  remarks text CHECK (remarks IS NULL OR length(btrim(remarks)) BETWEEN 1 AND 500),

  recorded_by_user_id text NOT NULL,

  -- No DELETE grant and no edit path: a recorded release is a financial
  -- fact. A mis-keyed one is WITHDRAWN, which leaves the row and its
  -- reason in place and takes it out of every sum — the same posture
  -- `bill_payments` (0067) takes on a receipt, and for the same reason.
  voided_at timestamptz,
  voided_by_user_id text,
  void_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id),
  FOREIGN KEY (organisation_id, work_instrument_id)
    REFERENCES work_instruments (organisation_id, id),

  CONSTRAINT retention_releases_substitution_needs_instrument CHECK (
    basis <> 'bank_guarantee_substitution' OR work_instrument_id IS NOT NULL
  ),
  CONSTRAINT retention_releases_other_needs_description CHECK (
    basis <> 'other' OR description IS NOT NULL
  ),

  -- Withdrawal travels as one fact — who, when and why — and the reason
  -- is REQUIRED. `void_reason IS NOT NULL` is stated separately and is
  -- not redundant: a CHECK passes when it evaluates to NULL, and
  -- `length(btrim(NULL)) BETWEEN 3 AND 500` is NULL rather than false, so
  -- the length test alone would admit exactly the row this refuses. 0067
  -- records finding that the hard way.
  CONSTRAINT retention_releases_void_shape CHECK (
    (voided_at IS NULL AND voided_by_user_id IS NULL AND void_reason IS NULL)
    OR (
      voided_at IS NOT NULL
      AND voided_by_user_id IS NOT NULL
      AND void_reason IS NOT NULL
      AND length(btrim(void_reason)) BETWEEN 3 AND 500
    )
  )
);

COMMENT ON TABLE retention_releases IS
  'Retention money the railway gave back, one row per release event. The held side is NOT stored here: it is the sum of the SECURITY_DEPOSIT deductions of 0067, which is money the railway actually withheld. Balance is held minus released, and the guard below refuses any release that would make it negative.';
COMMENT ON COLUMN retention_releases.basis IS
  'pac, defect_liability_end, bank_guarantee_substitution (which names the guarantee) or other (which must say what it is). Four different conversations with the railway, so four typed values rather than free text.';
COMMENT ON COLUMN retention_releases.voided_at IS
  'A withdrawn release. The row and its reason stay; every retention sum ignores it, so the money goes back to being held.';

-- The foreign keys' leading indexes, non-partial: a referential check
-- cannot use a partial index
-- (`packages/db/test/fk-index-coverage.integration.test.ts`).
CREATE INDEX retention_releases_work_idx
  ON retention_releases (organisation_id, work_id, released_on DESC, id);
CREATE INDEX retention_releases_instrument_idx
  ON retention_releases (organisation_id, work_instrument_id);

-- One live release per reference per Work. The same release letter
-- recorded twice is a MONEY mistake and not a tidiness one: it moves the
-- balance by its whole amount and can empty a retention position that is
-- still held. `bill_payments` takes the same posture on a receipt
-- reference (0067), with the same partial predicate — a withdrawn release
-- stops counting, so its reference is free for the one that replaces it.
-- Releases with NO reference are outside the rule; two of those are two
-- facts.
CREATE UNIQUE INDEX retention_releases_reference_per_work
  ON retention_releases (organisation_id, work_id, btrim(reference))
  WHERE reference IS NOT NULL AND voided_at IS NULL;

ALTER TABLE retention_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_releases FORCE ROW LEVEL SECURITY;

CREATE POLICY retention_releases_tenant_policy ON retention_releases
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- A financial record does not leave. UPDATE exists only so a release can
-- be withdrawn, and the guard below allows nothing else through it.
GRANT SELECT, INSERT, UPDATE ON retention_releases TO auto_mb_app;

-- ── 3. Liquidated damages, computed by the database ──────────────────
--
-- EVERY MONEY FIGURE ON THIS TABLE IS A GENERATED COLUMN, and that is the
-- point of the table rather than a detail of it.
--
-- LD arithmetic is four operations — a delay, a count of chargeable
-- periods, a percentage of a basis, and a cap — and every one of them is
-- a place a browser or a route could disagree with the database about a
-- rounding or a boundary. Generating them means there is exactly one
-- arithmetic and it is PostgreSQL numeric: the route cannot compute a
-- different answer because it never computes one at all, and the browser
-- renders a decimal string it was handed.
--
-- The boundaries the generation fixes, each of which is a real argument
-- with a railway:
--
--   * "or part thereof". `ceil` on the period count, so a delay of eight
--     days at a weekly rate is two weeks and not one and one seventh.
--   * a delay that is not a delay. `greatest(…, 0)`, so an assessment
--     made against a Work that finished on time states zero rather than a
--     negative levy.
--   * the cap. `least(…)`, applied to the whole assessment and not to
--     each period, which is what "subject to a maximum of 10% of the
--     contract value" says.
--
-- A generated column cannot reference another generated column in
-- PostgreSQL, so the period count is written out twice — once as the
-- column an operator reads and once inside the amount. They cannot drift:
-- they are the same expression over the same stored inputs, and
-- `apps/server/test/retention-ledger.integration.test.ts` asserts the
-- relationship on a corpus rather than trusting the eye.
CREATE TABLE ld_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,

  -- A legal date: the day the assessment was made. Not the delay window.
  assessed_on date NOT NULL,

  -- ── The snapshot ──────────────────────────────────────────────────
  --
  -- Every input is copied onto the row at assessment. `work_retention_terms`
  -- and `works` may both change afterwards — an extension moves the
  -- completion date, an amendment moves the contract value — and an
  -- assessment that silently recomputed itself when they did would be a
  -- levy nobody made. Engineering rule 7 for a computation.

  -- What LD is charged ON. Defaulted from `works.contract_value` by the
  -- route and stored, never read back through a join, because a contract
  -- value is exactly the thing an amendment moves.
  basis_amount money_amount NOT NULL CHECK (basis_amount > 0),
  -- What the basis is, in one phrase, so a reader knows whether this
  -- assessment charged the whole contract or the late portion of it.
  basis_label text NOT NULL CHECK (
    btrim(basis_label) = basis_label AND length(basis_label) BETWEEN 3 AND 200
  ),

  -- The contractual completion date the delay is measured FROM: the
  -- current one, including every granted extension, because an extension
  -- is precisely the railway agreeing that those days are not a delay.
  scheduled_completion_date date NOT NULL,
  -- The date the delay is measured TO: the day the Work was actually
  -- completed, or — for an assessment made while the Work is still
  -- running — the day it is being assessed as at.
  assessed_to_date date NOT NULL,

  ld_rate_percent numeric(6,3) NOT NULL
    CHECK (ld_rate_percent BETWEEN 0 AND 100),
  ld_period_days integer NOT NULL CHECK (ld_period_days BETWEEN 1 AND 366),
  ld_cap_percent numeric(6,3) NOT NULL CHECK (ld_cap_percent BETWEEN 0 AND 100),

  -- ── The arithmetic ────────────────────────────────────────────────

  -- Days late. Floored at zero: an assessment against a Work that
  -- finished on time is a legitimate thing to record and its answer is
  -- nothing owed, not a negative levy. A measured-to date BEFORE the
  -- contractual completion is refused outright by
  -- `ld_assessments_window_ordered` rather than floored — see there.
  delay_days integer GENERATED ALWAYS AS (
    greatest(assessed_to_date - scheduled_completion_date, 0)
  ) STORED,

  -- Chargeable periods, "or part thereof".
  chargeable_periods integer GENERATED ALWAYS AS (
    ceil(
      greatest(assessed_to_date - scheduled_completion_date, 0)::numeric
      / ld_period_days
    )::integer
  ) STORED,

  -- What the rate alone would charge, before the cap. Shown beside the
  -- capped figure so an operator can see that the cap bit, which is the
  -- fact worth arguing about.
  uncapped_amount money_amount GENERATED ALWAYS AS (
    round(
      basis_amount
      * ld_rate_percent
      / 100
      * ceil(
          greatest(assessed_to_date - scheduled_completion_date, 0)::numeric
          / ld_period_days
        ),
      2
    )
  ) STORED,

  -- The contractual maximum, in rupees.
  cap_amount money_amount GENERATED ALWAYS AS (
    round(basis_amount * ld_cap_percent / 100, 2)
  ) STORED,

  -- The assessment: the lesser of the two above. This is the number the
  -- agency takes to the railway.
  assessed_amount money_amount GENERATED ALWAYS AS (
    least(
      round(
        basis_amount
        * ld_rate_percent
        / 100
        * ceil(
            greatest(assessed_to_date - scheduled_completion_date, 0)::numeric
            / ld_period_days
          ),
        2
      ),
      round(basis_amount * ld_cap_percent / 100, 2)
    )
  ) STORED,

  -- ── The outcome ───────────────────────────────────────────────────
  --
  -- Four states, and the shape CHECK binds each to the columns it may
  -- have filled:
  --
  --   draft      the agency's own computation, not yet acted on
  --   levied     the railway imposed it; `levied_amount` is what it took
  --   waived     the railway did not take it, or gave it back
  --   cancelled  the assessment was made in error
  --
  -- `waived` and `cancelled` are both terminal and are deliberately NOT
  -- one state: "the railway forgave the delay" and "we computed this
  -- wrongly" are different facts about the same Work, and a register that
  -- could not tell them apart would be unable to answer the only question
  -- anybody asks a year later.
  --
  -- The state machine, stated once and enforced by the guard below:
  --
  --   draft  -> levied | waived | cancelled
  --   levied -> waived | cancelled
  --
  -- `levied -> waived` is a REMISSION and is real: LD taken on an
  -- on-account bill and returned at final settlement is ordinary. The
  -- levied amount stays on the row, so the record says what was taken and
  -- that it came back — which is what a remission is.
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'levied', 'waived', 'cancelled')
  ),

  -- What the railway ACTUALLY took, which need not be the assessment: a
  -- negotiated levy below the computed figure is the usual outcome. It
  -- may not exceed the assessment — 23P06 — because an assessment is the
  -- contractual maximum and a levy above it is not one this contract
  -- authorises.
  levied_amount money_amount CHECK (levied_amount IS NULL OR levied_amount >= 0),
  -- The railway's own advice or letter for the levy.
  levy_reference text CHECK (
    levy_reference IS NULL
    OR (btrim(levy_reference) = levy_reference
        AND length(levy_reference) BETWEEN 1 AND 100)
  ),

  -- Why it was waived, or why the assessment was cancelled. Required in
  -- both terminal states for the reason 0067 requires a void reason:
  -- retracting a money record is never self-evident from the record.
  outcome_reason text CHECK (
    outcome_reason IS NULL OR length(btrim(outcome_reason)) BETWEEN 3 AND 500
  ),

  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),

  assessed_by_user_id text NOT NULL,
  decided_by_user_id text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works (organisation_id, id),

  -- The window has to be a window. An assessment measured to a date
  -- before the Work's own contractual completion is not a zero-delay
  -- assessment, it is a data-entry mistake with a plausible-looking zero
  -- in it, and `delay_days` floors the difference so nothing downstream
  -- would ever notice. Refused here rather than floored.
  CONSTRAINT ld_assessments_window_ordered CHECK (
    assessed_to_date >= scheduled_completion_date
  ),
  -- The assessment cannot be dated before the period it assesses.
  CONSTRAINT ld_assessments_assessed_on_after_window CHECK (
    assessed_on >= assessed_to_date
  ),

  CONSTRAINT ld_assessments_outcome_shape CHECK (
    CASE status
      WHEN 'draft' THEN
        levied_amount IS NULL AND levy_reference IS NULL
        AND outcome_reason IS NULL
        AND decided_by_user_id IS NULL AND decided_at IS NULL
      WHEN 'levied' THEN
        levied_amount IS NOT NULL AND outcome_reason IS NULL
        AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
      -- Waived and cancelled both carry a reason. A waiver AFTER a levy
      -- keeps the levied amount, which is why `levied_amount` is not
      -- forced to NULL here: the row has to be able to say that money was
      -- taken and then returned.
      ELSE
        outcome_reason IS NOT NULL
        AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
    END
  )
);

COMMENT ON TABLE ld_assessments IS
  'One assessment of liquidated damages against one Work: the terms and the dates it was computed from, frozen, and the arithmetic PostgreSQL derived from them. The agency''s own reading of what the contract permits — deliberately not a gate on the LIQUIDATED_DAMAGES deduction of 0067, which records what the railway actually did.';
COMMENT ON COLUMN ld_assessments.assessed_amount IS
  'The lesser of rate x periods x basis and the contractual cap, in exact PostgreSQL numeric. Generated, so no route and no browser can compute a second answer; the inputs beside it are the frozen snapshot it was computed from.';
COMMENT ON COLUMN ld_assessments.chargeable_periods IS
  'Periods charged, rounded UP — the "or part thereof" of every railway LD clause. A delay of eight days at a weekly rate is two weeks.';
COMMENT ON COLUMN ld_assessments.levied_amount IS
  'What the railway actually took, which is ordinarily negotiated below the assessment. Never above it: an assessment is the contractual maximum. Kept on a row later waived, so a remission reads as money taken and returned.';
COMMENT ON CONSTRAINT ld_assessments_window_ordered ON ld_assessments IS
  'The assessment window runs forwards. A measured-to date before the contractual completion date is a mistyped year, not a zero-delay assessment, and delay_days would floor it to a plausible zero.';

-- ONE DRAFT PER WORK. A draft is a working computation an operator is
-- still adjusting; two of them are two answers to one question with
-- nothing to say which is current. The same rule as one open delivery
-- challan draft per Work, for the same reason. Levied and terminal rows
-- are excluded, so a Work legitimately accumulates an assessment per bill
-- over its life.
CREATE UNIQUE INDEX ld_assessments_one_draft_per_work
  ON ld_assessments (organisation_id, work_id)
  WHERE status = 'draft';

-- The foreign key's leading index, non-partial for the reason above.
CREATE INDEX ld_assessments_work_idx
  ON ld_assessments (organisation_id, work_id, assessed_on DESC, id);

ALTER TABLE ld_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ld_assessments FORCE ROW LEVEL SECURITY;

CREATE POLICY ld_assessments_tenant_policy ON ld_assessments
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. An assessment that was made in error is CANCELLED with a
-- reason, which leaves both the mistake and the correction on the record
-- — the posture the audit trail (0002), the tender status trail (0083)
-- and the signing queue (0091) all hold.
GRANT SELECT, INSERT, UPDATE ON ld_assessments TO auto_mb_app;

-- ── 4. The two readings every rule below is written against ──────────
--
-- Both are plain SECURITY INVOKER functions, so row-level security
-- applies to their reads exactly as it applies to the trigger that calls
-- them: a guard that could see another tenant's retention would be a hole
-- in the floor rather than a backstop for it.

-- What the railway has actually withheld as retention on this Work: the
-- SECURITY_DEPOSIT deductions of every LIVE payment against every one of
-- the Work's bills. This is the held side of the ledger, derived rather
-- than stored — see the header.
--
-- A withdrawn (voided) receipt takes its deductions out of the sum with
-- it, exactly as it does in `app_private.bill_settled_total`, because a
-- receipt that did not happen withheld nothing.
CREATE FUNCTION app_private.work_retention_held(p_work_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(sum(d.amount::numeric), 0)
  FROM bills b
  JOIN bill_payments p
    ON p.organisation_id = b.organisation_id AND p.bill_id = b.id
  JOIN bill_payment_deductions d
    ON d.organisation_id = p.organisation_id AND d.bill_payment_id = p.id
  WHERE b.work_id = p_work_id
    AND p.voided_at IS NULL
    AND d.category = 'SECURITY_DEPOSIT'
$$;

COMMENT ON FUNCTION app_private.work_retention_held(uuid) IS
  'Retention actually withheld on a Work: the SECURITY_DEPOSIT deductions of its bills'' live payments. The held side of the retention ledger, derived from the register that already owns the fact rather than mirrored into a second table.';

-- What has already been released and not withdrawn.
CREATE FUNCTION app_private.work_retention_released(p_work_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(sum(r.amount::numeric), 0)
  FROM retention_releases r
  WHERE r.work_id = p_work_id AND r.voided_at IS NULL
$$;

COMMENT ON FUNCTION app_private.work_retention_released(uuid) IS
  'Retention released back to the agency on a Work, over the live rows only. A withdrawn release counts for nothing, so the money goes back to being held.';

-- ── 5. Recording a release ───────────────────────────────────────────
--
-- Concurrency: two releases that each fit on their own can jointly pass
-- the retention held, so the `works` row is taken FOR UPDATE before the
-- running total is read — 0046's pattern for the quantity ceilings and
-- 0067's for the settlement ceiling, for the same reason. The route locks
-- the same row first and in the same order, so re-taking it there costs
-- nothing and no lock order is inverted.
--
-- VOLATILE, and it must stay so — the same load-bearing invisible that
-- 0067 § 6 records at length. Row locking is illegal in a non-volatile
-- PL/pgSQL function, and a multi-row INSERT of releases would stop seeing
-- its own earlier rows if the volatility were tidied away.
CREATE FUNCTION app_private.guard_retention_release_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_today date;
  v_held numeric;
  v_released numeric;
BEGIN
  -- An existing row may only be withdrawn. Nothing else about a recorded
  -- release is editable, and withdrawal is terminal: OLD is read only
  -- under an explicit TG_OP test, because plpgsql leaves it unassigned on
  -- INSERT.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a withdrawn retention release is immutable'
        USING ERRCODE = '23P02', CONSTRAINT = 'retention_release_immutable';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.released_on, NEW.amount, NEW.basis,
      NEW.work_instrument_id, NEW.reference, NEW.description, NEW.remarks,
      NEW.recorded_by_user_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.released_on, OLD.amount, OLD.basis,
      OLD.work_instrument_id, OLD.reference, OLD.description, OLD.remarks,
      OLD.recorded_by_user_id, OLD.created_at
    ) THEN
      RAISE EXCEPTION
        'a recorded retention release is immutable; withdraw it instead'
        USING ERRCODE = '23P02', CONSTRAINT = 'retention_release_immutable';
    END IF;
  END IF;

  -- The Work has to be readable in this transaction, and it is locked
  -- before the running total is read.
  SELECT (now() AT TIME ZONE o.timezone)::date INTO v_today
  FROM works w
  JOIN organisations o ON o.id = w.organisation_id
  WHERE w.organisation_id = NEW.organisation_id AND w.id = NEW.work_id
  FOR UPDATE OF w;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'retention release names Work %, which this transaction cannot read',
      NEW.work_id
      USING ERRCODE = '23P07', CONSTRAINT = 'retention_work_unreadable';
  END IF;

  -- Withdrawing only ever reduces the released total, so it needs no
  -- ceiling check and no date check. Everything below is about money
  -- coming OUT of the held balance.
  IF TG_OP = 'UPDATE' AND NEW.voided_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- The same window every other dated operational record obeys (challans
  -- 0010, installations 0017, PACs 0022, instruments 0006): not in the
  -- future in the ORGANISATION'S OWN timezone, never the server clock.
  -- Back-dating stays fully supported — a release letter is typed up
  -- weeks after it arrives.
  IF NEW.released_on > v_today THEN
    RAISE EXCEPTION
      'a retention release cannot be dated in the future (today is % here)',
      v_today
      USING ERRCODE = '23P03', CONSTRAINT = 'retention_release_date_future';
  END IF;

  v_held := app_private.work_retention_held(NEW.work_id);
  v_released := app_private.work_retention_released(NEW.work_id);

  IF v_released + NEW.amount::numeric > v_held THEN
    RAISE EXCEPTION
      'releasing % would take the retention released on Work % to % against % ever withheld',
      NEW.amount, NEW.work_id, v_released + NEW.amount::numeric, v_held
      USING ERRCODE = '23P01', CONSTRAINT = 'retention_release_exceeds_held';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_retention_release_write() IS
  'Everything a retention release is allowed to be: dated no later than today in the organisation''s timezone, never more than the railway actually withheld, immutable once recorded, and withdrawable exactly once. The route makes each refusal first so an operator gets a remedy; this is the arm that holds under concurrency.';

CREATE TRIGGER retention_releases_write_guard
BEFORE INSERT OR UPDATE ON retention_releases
FOR EACH ROW EXECUTE FUNCTION app_private.guard_retention_release_write();

CREATE TRIGGER retention_releases_touch_updated_at
BEFORE UPDATE ON retention_releases
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ── 6. Assessing, levying and waiving ────────────────────────────────
CREATE FUNCTION app_private.guard_ld_assessment_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_terms_present boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The Work has to be readable here. The composite foreign key already
    -- refuses another organisation's Work; this names the case rather
    -- than letting it surface as a bare 23503, and it is asked FIRST so a
    -- caller who cannot see the Work is told that rather than being told
    -- about its contract terms.
    IF NOT EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id AND w.id = NEW.work_id
    ) THEN
      RAISE EXCEPTION
        'liquidated-damages assessment names Work %, which this transaction cannot read',
        NEW.work_id
        USING ERRCODE = '23P07', CONSTRAINT = 'retention_work_unreadable';
    END IF;

    -- An assessment is a reading of the contract, so the contract's terms
    -- have to have been read. Without this a clerk could type any rate
    -- and any cap into an assessment and the row would look exactly like
    -- one derived from the letter.
    SELECT t.ld_rate_percent IS NOT NULL INTO v_terms_present
    FROM work_retention_terms t
    WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.work_id;

    IF NOT FOUND OR NOT v_terms_present THEN
      RAISE EXCEPTION
        'Work % carries no liquidated-damages terms, so nothing can be assessed against it',
        NEW.work_id
        USING ERRCODE = '23P04', CONSTRAINT = 'ld_terms_missing';
    END IF;

    IF NEW.levied_amount IS NOT NULL
       AND NEW.levied_amount > NEW.assessed_amount THEN
      RAISE EXCEPTION
        'a levy of % exceeds the assessment of %',
        NEW.levied_amount, NEW.assessed_amount
        USING ERRCODE = '23P06', CONSTRAINT = 'ld_levy_exceeds_assessment';
    END IF;

    RETURN NEW;
  END IF;

  -- UPDATE from here down.

  -- The snapshot is frozen. Everything the assessment was computed from,
  -- and everything that says which Work it is about, is written once —
  -- re-assessing is a NEW assessment, so the two readings stay side by
  -- side in the register instead of one overwriting the other.
  --
  -- The list is exhaustive on purpose: the denylist shape of a ROW guard
  -- means a column left out of it is silently editable, which is what
  -- `issued-immutability-coverage.integration.test.ts` exists to catch.
  -- The generated columns are NOT listed: they cannot be written at all,
  -- and they are functions of the columns that are.
  IF ROW(
       NEW.id, NEW.organisation_id, NEW.work_id, NEW.assessed_on,
       NEW.basis_amount, NEW.basis_label, NEW.scheduled_completion_date,
       NEW.assessed_to_date, NEW.ld_rate_percent, NEW.ld_period_days,
       NEW.ld_cap_percent, NEW.assessed_by_user_id, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.organisation_id, OLD.work_id, OLD.assessed_on,
       OLD.basis_amount, OLD.basis_label, OLD.scheduled_completion_date,
       OLD.assessed_to_date, OLD.ld_rate_percent, OLD.ld_period_days,
       OLD.ld_cap_percent, OLD.assessed_by_user_id, OLD.created_at
     ) THEN
    RAISE EXCEPTION
      'the facts a liquidated-damages assessment was computed from are written once; make a new assessment instead'
      USING ERRCODE = '23P05', CONSTRAINT = 'ld_assessment_frozen';
  END IF;

  -- Terminal is terminal.
  IF OLD.status IN ('waived', 'cancelled')
     AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION
      'liquidated-damages assessment % is already % and cannot change again',
      OLD.id, OLD.status
      USING ERRCODE = '23P05', CONSTRAINT = 'ld_assessment_terminal';
  END IF;

  -- The state machine:
  --
  --   draft  -> levied | waived | cancelled
  --   levied -> waived | cancelled
  --
  -- Nothing goes backwards, and in particular nothing returns to draft: a
  -- draft is an unacted computation, and a levy that could be rewound to
  -- one would let the amount the railway took be edited afterwards.
  -- `levied -> waived` is a remission and `levied -> cancelled` is an
  -- assessment recorded in error; both keep the levied amount on the row.
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status IN ('levied', 'waived', 'cancelled'))
      OR (OLD.status = 'levied' AND NEW.status IN ('waived', 'cancelled'))
    ) THEN
      RAISE EXCEPTION
        'a liquidated-damages assessment cannot move from % to %',
        OLD.status, NEW.status
        USING ERRCODE = '23P05', CONSTRAINT = 'ld_assessment_transition';
    END IF;
  END IF;

  -- The levied amount is bounded by the assessment in every state that
  -- carries one, including a waiver that follows a levy — the amount that
  -- was taken is still bounded by what could have been taken.
  IF NEW.levied_amount IS NOT NULL
     AND NEW.levied_amount > NEW.assessed_amount THEN
    RAISE EXCEPTION
      'a levy of % exceeds the assessment of %',
      NEW.levied_amount, NEW.assessed_amount
      USING ERRCODE = '23P06', CONSTRAINT = 'ld_levy_exceeds_assessment';
  END IF;

  -- A levied amount is written once too. Correcting what the railway took
  -- is not an edit of this row; it is a waiver of this one and a new
  -- assessment, so the trail says what was claimed and what replaced it.
  IF OLD.levied_amount IS NOT NULL
     AND NEW.levied_amount IS DISTINCT FROM OLD.levied_amount THEN
    RAISE EXCEPTION
      'the levied amount of a liquidated-damages assessment is written once'
      USING ERRCODE = '23P05', CONSTRAINT = 'ld_assessment_frozen';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_ld_assessment_write() IS
  'Everything a liquidated-damages assessment is allowed to be: raised only against a Work whose contract terms have been read, its computation snapshot frozen, its states walked forwards only, its levy never above the assessment, and terminal rows immutable.';

CREATE TRIGGER ld_assessments_write_guard
BEFORE INSERT OR UPDATE ON ld_assessments
FOR EACH ROW EXECUTE FUNCTION app_private.guard_ld_assessment_write();

CREATE TRIGGER ld_assessments_touch_updated_at
BEFORE UPDATE ON ld_assessments
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ── 7. The retention position ────────────────────────────────────────
--
-- One row per live Work, stating the position in the figures it takes to
-- state it honestly. `security_invoker`, like the 0028, 0065 and 0067
-- views: row-level security is re-checked against the caller through the
-- base tables, so the view grants no visibility that `works` would not.
--
-- Deliberately a view and not columns on `works`: every figure is a
-- derived reading of five tables and would be stale the moment a payment
-- advice landed.
--
-- THE LD COLUMNS ARE REPORTED AND NEVER NETTED AGAINST EACH OTHER.
-- `ld_levied_total` is the agency's own assessment record and
-- `ld_deducted_total` is what the railway actually took under that head.
-- Subtracting one from the other would produce a number that looks like
-- an outstanding LD balance and is not one — the two are different claims
-- about the same event, and the difference between them is the
-- conversation rather than a balance. See the header.
CREATE VIEW work_retention_positions
WITH (security_invoker = true)
AS
  SELECT
    w.organisation_id,
    w.id                                            AS work_id,
    w.work_code,
    w.contract_value,
    t.retention_percent,
    t.retention_limit_percent,
    t.defect_liability_months,
    t.ld_rate_percent,
    t.ld_period_days,
    t.ld_cap_percent,
    -- The contractual ceiling on the cumulative hold, in rupees. NULL
    -- when the contract's terms were never recorded, because a ceiling
    -- nobody stated is not a ceiling of zero.
    CASE
      WHEN t.retention_limit_percent IS NULL THEN NULL
      ELSE round(w.contract_value * t.retention_limit_percent / 100, 2)::money_amount
    END                                             AS retention_ceiling_amount,
    held.total::money_amount                        AS retention_held_total,
    released.total::money_amount                    AS retention_released_total,
    (held.total - released.total)::money_amount     AS retention_balance,
    coalesce(ld.levied_total, 0)::money_amount      AS ld_levied_total,
    coalesce(ld_deducted.total, 0)::money_amount    AS ld_deducted_total,
    coalesce(ld.open_assessments, 0)                AS ld_open_assessments
  FROM works w
  LEFT JOIN work_retention_terms t
    ON t.organisation_id = w.organisation_id AND t.work_id = w.id
  CROSS JOIN LATERAL (
    SELECT app_private.work_retention_held(w.id) AS total
  ) held
  CROSS JOIN LATERAL (
    SELECT app_private.work_retention_released(w.id) AS total
  ) released
  LEFT JOIN LATERAL (
    SELECT
      sum(a.levied_amount::numeric) FILTER (WHERE a.status = 'levied')
                                              AS levied_total,
      count(*) FILTER (WHERE a.status IN ('draft', 'levied'))::int
                                              AS open_assessments
    FROM ld_assessments a
    WHERE a.organisation_id = w.organisation_id AND a.work_id = w.id
  ) ld ON true
  LEFT JOIN LATERAL (
    SELECT sum(d.amount::numeric) AS total
    FROM bills b
    JOIN bill_payments p
      ON p.organisation_id = b.organisation_id AND p.bill_id = b.id
    JOIN bill_payment_deductions d
      ON d.organisation_id = p.organisation_id AND d.bill_payment_id = p.id
    WHERE b.organisation_id = w.organisation_id
      AND b.work_id = w.id
      AND p.voided_at IS NULL
      AND d.category = 'LIQUIDATED_DAMAGES'
  ) ld_deducted ON true
  WHERE w.deleted_at IS NULL;

COMMENT ON VIEW work_retention_positions IS
  'The retention and liquidated-damages position of one Work. Not a tenant table: RLS lives on works, work_retention_terms, retention_releases, bills and bill_payments, and applies through security_invoker. ld_levied_total and ld_deducted_total are reported side by side and never netted — one is the agency''s assessment and the other is what the railway took, and their difference is a conversation rather than a balance.';

-- The readings are narrowed exactly as 0001 narrows the tenancy helpers
-- and 0067 narrows its own: nothing in `app_private` is reachable by
-- default, and the application role gets each one by name. The route
-- reads them directly to answer "what is still held", so the grants are
-- real rather than a formality.
REVOKE ALL ON FUNCTION app_private.work_retention_held(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.work_retention_released(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT ON work_retention_positions TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.work_retention_held(uuid) TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.work_retention_released(uuid) TO auto_mb_app;
  END IF;
END
$$;
