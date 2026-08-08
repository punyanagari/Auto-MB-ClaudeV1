SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 5 (remaining slice): the Performance Bank Guarantee REQUIREMENT
-- the LOA letter demands, confirmed onto the Work at LOA review time.
--
-- This is deliberately distinct from work_instruments kind='pbg' rows:
-- the requirement records what the LETTER demands (amount, submission
-- window, extension window, penal interest), while an instrument records
-- what the contractor actually SUBMITTED. There is intentionally no
-- foreign key between them — the dashboard compares the two sides at
-- read time (missing / under-value / window missed).
--
-- Letters without a performance-guarantee clause exist, so every column
-- is nullable and a Work confirms legally with no requirement at all.
-- pbg_requirement_source retains the printed raw source block plus
-- whether the values are parser-proposed or reviewer-corrected, in the
-- same evidence spirit as work_items.source_evidence.

ALTER TABLE works
  ADD COLUMN pbg_required_amount numeric(18,2)
    CHECK (pbg_required_amount IS NULL OR pbg_required_amount > 0),
  ADD COLUMN pbg_submission_days integer
    CHECK (pbg_submission_days IS NULL OR pbg_submission_days BETWEEN 1 AND 180),
  ADD COLUMN pbg_extension_days integer
    CHECK (pbg_extension_days IS NULL OR pbg_extension_days >= 0),
  ADD COLUMN pbg_penal_interest_percent numeric(6,3)
    CHECK (pbg_penal_interest_percent IS NULL OR pbg_penal_interest_percent >= 0),
  ADD COLUMN pbg_requirement_source jsonb;

-- A requirement is all-or-nothing: recording one requires the amount,
-- the submission window, and the provenance payload together (extension
-- days and penal interest stay optional even then). A Work without a
-- requirement carries NULL in every requirement column.
ALTER TABLE works
  ADD CONSTRAINT works_pbg_requirement_coherent CHECK (
    (
      pbg_required_amount IS NULL
      AND pbg_submission_days IS NULL
      AND pbg_extension_days IS NULL
      AND pbg_penal_interest_percent IS NULL
      AND pbg_requirement_source IS NULL
    )
    OR (
      pbg_required_amount IS NOT NULL
      AND pbg_submission_days IS NOT NULL
      AND pbg_requirement_source IS NOT NULL
    )
  );

-- The dashboard scans for Works whose letter demands a PBG; the partial
-- index keeps that scan off Works without a requirement.
CREATE INDEX works_pbg_requirement_idx
  ON works (organisation_id, letter_date)
  WHERE pbg_required_amount IS NOT NULL AND deleted_at IS NULL;
