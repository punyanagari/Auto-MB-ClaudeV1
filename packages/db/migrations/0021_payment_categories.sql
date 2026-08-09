SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 8 phase 1: item payment categories and the per-Work payment
-- matrix (legacy spec §8, rule R10; ADR-0006 decision 5). Payment
-- eligibility resolves through an item's payment category into a
-- per-Work matrix row whose four stage percentages (supply,
-- installation, PAC, final bill) sum to exactly 100. Per the settled
-- legacy decision R10 there is deliberately NO per-item percentage
-- entry — percentages live only in the matrix, keyed by category
-- (built once in the legacy product, reverted on user request; do not
-- re-add).

-- 1. Constrain the existing work_items.payment_category column to the
-- four legacy categories. NULL = uncategorised: an uncategorised item
-- resolves through the optional UNCATEGORISED matrix row instead.
-- Shipped data has never carried a non-NULL value; only scratch
-- databases could hold arbitrary text, so any out-of-vocabulary value
-- is folded back to NULL (uncategorised) before the constraint lands.
UPDATE work_items
SET payment_category = NULL
WHERE payment_category IS NOT NULL
  AND payment_category NOT IN (
    'SUPPLY', 'SUPPLY_AND_INSTALLATION', 'PURE_INSTALLATION', 'SPARE_SUPPLY'
  );

ALTER TABLE work_items
  ADD CONSTRAINT work_items_payment_category_check
  CHECK (
    payment_category IS NULL
    OR payment_category IN (
      'SUPPLY', 'SUPPLY_AND_INSTALLATION', 'PURE_INSTALLATION', 'SPARE_SUPPLY'
    )
  );

-- 2. The per-Work payment matrix. One row per category per Work; the
-- UNCATEGORISED row serves items with no category. All four
-- percentages are exact numeric(5,2); the sum-to-100 CHECK runs in
-- exact numeric arithmetic — a matrix row can never leak or double-pay
-- value across stages.
CREATE TABLE payment_matrices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  category text NOT NULL CHECK (
    category IN (
      'SUPPLY', 'SUPPLY_AND_INSTALLATION', 'PURE_INSTALLATION',
      'SPARE_SUPPLY', 'UNCATEGORISED'
    )
  ),
  pct_supply numeric(5,2) NOT NULL CHECK (pct_supply BETWEEN 0 AND 100),
  pct_installation numeric(5,2) NOT NULL CHECK (pct_installation BETWEEN 0 AND 100),
  pct_pac numeric(5,2) NOT NULL CHECK (pct_pac BETWEEN 0 AND 100),
  pct_final_bill numeric(5,2) NOT NULL CHECK (pct_final_bill BETWEEN 0 AND 100),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pct_supply + pct_installation + pct_pac + pct_final_bill = 100),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_id, category),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

CREATE TRIGGER payment_matrices_touch_updated_at
BEFORE UPDATE ON payment_matrices
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- 3. RLS: tenant policy, enabled and forced like every tenant table.
ALTER TABLE payment_matrices ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_matrices FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_matrices_tenant_policy ON payment_matrices
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

-- 4. Grants. DELETE is deliberately granted: matrix rows are per-Work
-- payment CONFIGURATION, not issued documents — removing the row for a
-- category the Work never uses is a legitimate correction, and history
-- is safe because every finalised Measurement Book snapshots the
-- percentages it billed with (ADR-0006 decision 5); deleting or
-- editing a matrix row can never alter a finalised MB.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_matrices TO auto_mb_app;
  END IF;
END
$$;
