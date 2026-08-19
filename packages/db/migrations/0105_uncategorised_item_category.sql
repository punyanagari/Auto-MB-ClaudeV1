-- 0105 — "Uncategorised" splits into two states, and the residual
-- category gets a name the operator chose.
--
-- WHAT WAS WRONG. `work_items.payment_category` had exactly two readings
-- of NULL and no way to tell them apart: "nobody has decided yet" and
-- "decided — this item bills through the Work's residual row". The
-- select offered one option for both ("Uncategorised"), and
-- `resolvePaymentPercentages` read every NULL as the second, so an item
-- nobody had looked at billed silently through the UNCATEGORISED row on
-- any Work that happened to have one. The operator's own worklist —
-- "N items still uncategorised" — was counting a mixture of a to-do and
-- a decision, which is why it never reached zero on a Work that was
-- fully configured.
--
-- WHAT THIS MIGRATION DOES.
--
-- 1. `UNCATEGORISED` becomes a value an ITEM may carry, not only a
--    matrix-row key. NULL then means one thing: not selected yet.
--
-- 2. Every existing NULL is backfilled to `UNCATEGORISED`. This is the
--    load-bearing step and it is deliberately not optional: the meaning
--    of NULL changes in this migration, so every row that carries the
--    OLD meaning has to be moved to the value that preserves it. Without
--    the backfill, a live Work that bills through its residual row today
--    would stop resolving tomorrow, and the operator would meet the
--    change as a Measurement Book refusing to finalize.
--
-- 3. The residual matrix row gains a per-Work display LABEL. Railway
--    schedules name their residual bucket differently — "Other items",
--    "Miscellaneous", "Balance work" — and an operator reconciling a
--    printed schedule against this screen should read the schedule's own
--    word. It is display only: the key stays `UNCATEGORISED`, nothing
--    resolves through the label, and a finalised Measurement Book
--    snapshots the key exactly as before.
--
-- WHAT IT DOES NOT DO. It does not make an uncategorised item billable
-- or unbillable by itself — resolution still needs the row to exist, and
-- the Measurement Book still refuses to finalize while any line cannot
-- resolve. It adds no trigger: the two changes are a widened CHECK and a
-- display column, and there is nothing here a trigger could say that the
-- CHECK does not.

SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. The sixth item category — a widening, so no existing row can fail.
-- ---------------------------------------------------------------------

ALTER TABLE work_items
  DROP CONSTRAINT work_items_payment_category_check;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_payment_category_check
  CHECK (
    payment_category IS NULL
    OR payment_category IN (
      'SUPPLY', 'SUPPLY_AND_INSTALLATION', 'PURE_INSTALLATION',
      'SPARE_SUPPLY', 'AMC', 'UNCATEGORISED'
    )
  );

COMMENT ON CONSTRAINT work_items_payment_category_check ON work_items IS
  'NULL is "not selected yet" (0105) and resolves through no matrix row. '
  'UNCATEGORISED is a decision: the item bills through the Work''s '
  'residual row.';

-- ---------------------------------------------------------------------
-- 2. The backfill that preserves today's behaviour.
--
-- Live items only. A soft-deleted item bills nothing and resolves
-- nothing, so moving it would be rewriting history for no reader —
-- and 0065's `work_items_live` view is the one that answers for the
-- rest of the product.
-- ---------------------------------------------------------------------

UPDATE work_items
SET payment_category = 'UNCATEGORISED'
WHERE payment_category IS NULL
  AND deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- 3. The residual row's per-Work name.
--
-- Constrained to the residual row: a label on the SUPPLY row would be a
-- second name for a category the whole product already agrees on, and
-- the first screen to render it would disagree with the second.
-- ---------------------------------------------------------------------

ALTER TABLE payment_matrices
  ADD COLUMN category_label text
    CHECK (category_label IS NULL
           OR length(btrim(category_label)) BETWEEN 1 AND 60);

ALTER TABLE payment_matrices
  ADD CONSTRAINT payment_matrices_label_is_residual_only
  CHECK (category_label IS NULL OR category = 'UNCATEGORISED');

COMMENT ON COLUMN payment_matrices.category_label IS
  'Display-only per-Work name for the residual row (0105). Nothing '
  'resolves through it; the key is always UNCATEGORISED. NULL renders '
  'the product''s own default wording.';
