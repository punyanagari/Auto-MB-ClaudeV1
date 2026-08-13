-- Migration 0063: the ACCEPTED rate, and the advertised rate it came from.
--
-- Owner ruling, 13 August 2026, ruling 1 of
-- docs/FINDING-2026-08-13-invoice-money-basis.md: work_items.effective_rate
-- holds the ACCEPTED rate — the rate the railway actually pays — and the
-- server derives it from the printed rate and the letter's own percentage.
--
-- WHAT WAS WRONG. An LOA item table prints ADVERTISED rates. The tender
-- result (`14.35% Below`, `24.5% Above`) is printed once per schedule on a
-- per-schedule letter and once for the whole letter otherwise, and it is
-- what turns an advertised rate into the agreement rate. Nothing in the
-- product ever applied it: `letter_percentage` was stored and displayed but
-- never multiplied into anything. So every challan value, Measurement Book
-- total, bill and invoice was computed at the advertised rate.
--
-- The error follows the letter, so it ran both ways. On the five real
-- corpus letters that are not at par: four are below par (up to 29%) and
-- were OVERSTATED, while PL281-BB is 24.5% above par and was UNDERSTATED —
-- the contractor invoicing a quarter less than the agreement entitles them
-- to. `sum(awarded_quantity * effective_rate)` did not equal the Work's own
-- `contract_value` on any of them.
--
-- TWO COLUMNS, NOT ONE. `work_items.advertised_rate` retains the figure
-- printed in the letter, and `effective_rate` becomes the derived accepted
-- rate. Keeping both is not redundancy: the letter's rate is what a
-- reviewer sees on the page and what the extracted-value lock holds the
-- confirmation to, while the accepted rate is what every downstream money
-- figure is measured at. A screen that shows one without the other cannot
-- explain itself, and an auditor asking "where did this rate come from"
-- deserves both ends of the derivation rather than a recomputation.
--
-- The percentage lands on `work_schedules` because that is the granularity
-- the letter prints it at. A per-schedule letter legitimately mixes
-- percentages AND directions across its own schedules — PL276-GTL runs
-- 7.77% Above, 8.88% Above, 49.49% Below and 28.28% Below across four —
-- so a single per-Work column could not hold the truth. On a
-- letter-percentage letter every schedule carries the letter's one
-- percentage, denormalised deliberately so that every reader asks the same
-- question of the same column and no consumer has to branch on
-- pricing_shape to find out what rate applies.
--
-- BACKFILL, and what it deliberately does NOT do. `advertised_rate` is
-- backfilled from `effective_rate`, which is exactly true of every existing
-- row: today's effective_rate IS the advertised rate. `effective_rate` is
-- then LEFT ALONE, and the schedule percentages are left NULL.
--
-- Recomputing would be guessing. For a letter-percentage Work the letter's
-- percentage is on the row and the arithmetic is available, but for a
-- per-schedule Work the per-schedule percentages were never stored and
-- cannot be recovered from anything in the database — the letter has to be
-- read again. Rewriting money on the Works we could while silently leaving
-- the others wrong would produce a table where the rate's meaning varies by
-- row with nothing to say which is which. So no row's money moves here, and
-- a NULL percentage marks a Work whose rates predate this ruling, honestly
-- and visibly.
--
-- Existing Works therefore still carry advertised rates. The remedy is the
-- product's existing one for a wrong extracted value: discard the LOA
-- document and confirm it again. To find them:
--
--   SELECT w.id, w.work_code, w.pricing_shape
--   FROM works w
--   WHERE EXISTS (
--     SELECT 1 FROM work_schedules s
--     WHERE s.work_id = w.id AND s.accepted_percentage IS NULL
--   );
--
-- The owner confirmed on 13 August 2026 that no production work depends on
-- existing rows, which is why this is acceptable rather than a data
-- migration with a reconciliation report.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE work_schedules
  ADD COLUMN accepted_percentage numeric(6,3)
    CHECK (accepted_percentage IS NULL
           OR (accepted_percentage >= 0 AND accepted_percentage <= 100)),
  ADD COLUMN accepted_percentage_direction text
    CHECK (accepted_percentage_direction IS NULL
           OR accepted_percentage_direction IN ('below', 'at_par', 'above'));

-- The pair is all-or-nothing: a percentage with no direction does not say
-- which way it moves the rate, and a direction with no percentage says
-- nothing at all. 'at_par' is the one case that pins the value, and it
-- pins it to zero rather than leaving it open.
ALTER TABLE work_schedules
  ADD CONSTRAINT work_schedules_accepted_percentage_coherent CHECK (
    (accepted_percentage IS NULL AND accepted_percentage_direction IS NULL)
    OR (
      accepted_percentage IS NOT NULL
      AND accepted_percentage_direction IS NOT NULL
      AND (accepted_percentage_direction <> 'at_par' OR accepted_percentage = 0)
    )
  );

ALTER TABLE work_items
  ADD COLUMN advertised_rate numeric(18,6)
    CHECK (advertised_rate IS NULL OR advertised_rate >= 0);

-- True of every existing row by construction: until this migration the
-- confirmed rate WAS the printed one.
UPDATE work_items SET advertised_rate = effective_rate WHERE advertised_rate IS NULL;

COMMENT ON COLUMN work_schedules.accepted_percentage IS
  'The accepted-rate percentage printed for this schedule (per-schedule letter) or for the whole letter (letter-percentage letter, denormalised onto every schedule). NULL on Works confirmed before migration 0063, whose item rates are still the advertised ones.';

COMMENT ON COLUMN work_items.advertised_rate IS
  'The rate as PRINTED in the LOA item table. work_items.effective_rate carries the ACCEPTED rate derived from it by the schedule''s percentage (migration 0063); this column keeps the derivation''s input so the pair can be shown and audited without recomputation.';

COMMENT ON COLUMN work_items.effective_rate IS
  'The ACCEPTED rate — what the railway pays per unit, and what every downstream money figure is computed at. Derived by the server from advertised_rate and the schedule''s accepted percentage (migration 0063). Before 0063 this column held the advertised rate, which was the defect that migration records.';
