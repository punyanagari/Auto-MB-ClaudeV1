SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- Migration 0107: how many periods an AMC schedule bills in, and what
-- the agency calls one of them.
--
-- Numbering: 0106 is this pack's measured-quantity adjustment; 0107 is
-- its second half. Two files because the two rulings share nothing — one
-- is a measurement edit and one is a maintenance-billing cadence — and a
-- reviewer should be able to read either alone.
--
-- THE RULING, 2026-08-19, derived from six real AMC letters (live-testing
-- ledger item 6, LOCKED): storage is TWO nullable columns on
-- `work_schedules` — `amc_billing_periods` (integer M, CHECK > 0) and
-- `amc_cycle_noun` (the word only; an open set: quarter, month, year,
-- half-year, visit, ...). No payment-matrix change, no per-item axis,
-- R10 untouched. The split of a schedule's sanctioned quantity Q over M
-- periods is the running total
--
--     q(n) = round3(Q * n / M) - round3(Q * (n-1) / M)
--
-- which sums to exactly Q, so 0068's certification cap and R8's
-- completion hold by construction rather than by a reconciliation step.
--
-- WHY ON THE SCHEDULE AND NOT ON THE ITEM. The letters answer it. PL-218
-- (Nagpur, SECR) carries two schedules with two different cadences — a
-- quarterly maintenance schedule and a visit schedule billed per trip,
-- twelve and eighteen periods over the same three years. One Work-level
-- cadence could not describe it, and a per-ITEM cadence would ask an
-- operator to type the same number against every one of a schedule's
-- items and would let them disagree. The schedule is the unit the letter
-- itself prices a cadence on.
--
-- WHY THE NOUN IS FREE TEXT AND NOT AN ENUM. The corpus already prints
-- quarter, month, year and visit, and "1 Nos = 1 Quarter maintenance"
-- appears as a UNIT gloss in one letter and as a schedule title in
-- another. An enum would have to be widened by a migration the first time
-- a railway writes "half-yearly inspection", and the value is rendered
-- into a sentence, never resolved against anything. It is bounded by
-- length and by a shape CHECK, and nothing branches on it.
--
-- WHAT THESE COLUMNS DO NOT DO. They do not move money. The certification
-- remains the money gate: an acceptance certificate is still capped at
-- the sanctioned quantity by 0068, `computeStageAmounts` and
-- `resolveFinalBillBase` are untouched, and the accepted rate is still
-- the rate `apps/server/src/accepted-rate.ts` derives. The cadence only
-- PROPOSES the next period's certified quantity (a read endpoint) and
-- renders period language in the Measurement Book remark. An operator who
-- ignores both is billed exactly as they are billed today.
--
-- WHY NO DEFAULT. A schedule with no cadence stated is a schedule the
-- product must not invent one for: the owner's Q1 ruling defaults a
-- no-cycle letter to M = 1 ("final bill for the total") and Q2 defaults a
-- monthly-PRICED letter to quarterly, and both are defaults the IMPORT
-- PROPOSES and the operator confirms — propose-and-prove, never guess.
-- A database DEFAULT would make the guess silently and permanently.
--
-- SQLSTATE: 23R03, the next free code in 0106's block.
-- ---------------------------------------------------------------------

ALTER TABLE work_schedules
  ADD COLUMN amc_billing_periods integer
    CHECK (amc_billing_periods IS NULL OR amc_billing_periods > 0),
  -- The word only — "quarter", not "quarterly" and not "1 quarter". It
  -- is rendered into a sentence beside a number, so it is trimmed,
  -- bounded, and refused if it carries a digit or a full stop, which is
  -- what a pasted phrase looks like.
  ADD COLUMN amc_cycle_noun text
    CHECK (
      amc_cycle_noun IS NULL
      OR (
        length(btrim(amc_cycle_noun)) BETWEEN 1 AND 30
        AND amc_cycle_noun ~ '^[A-Za-z][A-Za-z -]*$'
      )
    );

-- Neither column says anything alone: a period count with no word for a
-- period renders no sentence, and a word with no count proposes no
-- quantity. The same coherence shape 0063 gave the accepted-percentage
-- pair on this table.
ALTER TABLE work_schedules
  ADD CONSTRAINT work_schedules_amc_cycle_coherent CHECK (
    (amc_billing_periods IS NULL AND amc_cycle_noun IS NULL)
    OR (amc_billing_periods IS NOT NULL AND amc_cycle_noun IS NOT NULL)
  );

COMMENT ON COLUMN work_schedules.amc_billing_periods IS
  'M — how many billing periods this schedule''s maintenance is measured in over the whole contract. Owner ruling of 2026-08-19. NULL means no cadence has been stated, which is not the same as one period: the import PROPOSES a default and the operator confirms it. Each period''s certified quantity is round3(Q*n/M) - round3(Q*(n-1)/M), which sums to Q exactly.';
COMMENT ON COLUMN work_schedules.amc_cycle_noun IS
  'What this schedule calls one billing period — the word alone (quarter, month, year, half-year, visit). Deliberately an open set: it is rendered into the Measurement Book remark beside a period count and nothing branches on it. Coherent with amc_billing_periods: both set, or neither.';

-- ── The schedule becomes editable, in exactly two columns ────────────
--
-- WHY THIS TRIGGER EXISTS AT ALL. Before this migration `work_schedules`
-- had no UPDATE route anywhere in the product and no trigger of any kind:
-- a schedule was written once, by `POST /api/loa-documents/:id/confirm`,
-- and 0063's own header names discard-and-reconfirm as the remedy for a
-- wrong accepted percentage. Opening an UPDATE route for the cadence
-- opens the table's UPDATE privilege for everything else on the row,
-- including `accepted_percentage` — the multiplier every rate on the
-- Work is derived through. So the route's refusal gets its database half
-- here: the two cadence columns move, and nothing else does, whoever is
-- writing.
--
-- Not SECURITY DEFINER: it compares the row it is handed against itself.
CREATE FUNCTION app_private.guard_work_schedule_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.id, NEW.organisation_id, NEW.work_id, NEW.schedule_code, NEW.title,
    NEW.position, NEW.created_at, NEW.accepted_percentage,
    NEW.accepted_percentage_direction
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.organisation_id, OLD.work_id, OLD.schedule_code, OLD.title,
    OLD.position, OLD.created_at, OLD.accepted_percentage,
    OLD.accepted_percentage_direction
  ) THEN
    RAISE EXCEPTION
      'a schedule is written from the letter it was confirmed from; only its AMC billing cycle is editable afterwards'
      USING ERRCODE = '23R03', CONSTRAINT = 'work_schedule_frozen';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_work_schedule_update() IS
  'Database half of the AMC-cycle edit route (owner ruling of 2026-08-19): opening UPDATE on work_schedules for the cadence must not open it for the schedule''s identity or for accepted_percentage, which every derived rate on the Work is computed through. 23R03.';

CREATE TRIGGER work_schedules_guard_update
BEFORE UPDATE ON work_schedules
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_schedule_update();
