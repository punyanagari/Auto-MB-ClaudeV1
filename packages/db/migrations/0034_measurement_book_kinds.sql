-- Migration 0034: three kinds of Measurement Book.
--
-- The field practice this models: several consignees measure the same Work
-- at the same time, each filling their own RECORD MB. One main consignee
-- then merges those records into an ON-ACCOUNT MB, which is what gets
-- finalized and billed. Where a single measurement suffices, an on-account
-- MB is simply started directly. The FINAL MB is the last word on the Work
-- — after it, no further MB may be raised, and its snapshot is immutable
-- like every finalized MB's.
--
-- What changes and what does not:
--
-- - `kind` ('record' | 'on_account' | 'final') becomes the stored truth.
-- - `is_final` becomes a GENERATED column over kind. This is deliberate:
--   the 0027 final-sweep functions, the 0031 completed-work guards and the
--   0026 audit trigger all read mb.is_final, and every one of them keeps
--   working untouched because the column still exists and still means
--   exactly what it meant. Only writers change: nothing may insert
--   is_final any more, it must insert kind.
-- - Record MBs never finalize and never take a number. They end in one of
--   two ways: merged into an on-account draft (status 'merged', pointing
--   at the MB that absorbed their sources), or deleted while still drafts
--   like any other draft.
-- - The one-draft-per-Work rule splits: still exactly one BILLING draft
--   (on-account or final) per Work, but record drafts may run in parallel,
--   one per consignee, because parallel measurement is their whole point.

-- ---------------------------------------------------------------------
-- 1. kind, backfilled from the boolean it replaces.

ALTER TABLE measurement_books ADD COLUMN kind text;

-- The backfill is mechanical — kind restates is_final — but the lifecycle
-- guard rightly refuses ANY update to a cancelled MB, and cancelled MBs
-- exist in live data. User triggers pause for exactly this statement; the
-- audit trail gains nothing from a per-row echo of a column rename either.
ALTER TABLE measurement_books DISABLE TRIGGER USER;
UPDATE measurement_books
   SET kind = CASE WHEN is_final THEN 'final' ELSE 'on_account' END;
ALTER TABLE measurement_books ENABLE TRIGGER USER;

ALTER TABLE measurement_books
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN kind SET DEFAULT 'on_account',
  ADD CONSTRAINT measurement_books_kind_check
    CHECK (kind IN ('record', 'on_account', 'final'));

COMMENT ON COLUMN measurement_books.kind IS
  'record: one consignee''s parallel measurement sheet, merged before '
  'billing. on_account: the billable MB. final: the Work''s last MB.';

-- ---------------------------------------------------------------------
-- 2. The record-MB machinery: who is filling it, and where it went.

ALTER TABLE measurement_books
  ADD COLUMN consignee_contact_id uuid,
  ADD COLUMN merged_into_id uuid,
  ADD CONSTRAINT measurement_books_consignee_fk
    FOREIGN KEY (organisation_id, consignee_contact_id)
      REFERENCES contacts (organisation_id, id),
  -- RESTRICT on purpose: deleting the on-account draft that absorbed a
  -- record MB must first put the records back (the route un-merges), not
  -- leave them pointing at nothing.
  ADD CONSTRAINT measurement_books_merged_into_fk
    FOREIGN KEY (organisation_id, merged_into_id)
      REFERENCES measurement_books (organisation_id, id);

COMMENT ON COLUMN measurement_books.consignee_contact_id IS
  'Record MBs only: the consignee filling this sheet. One record draft per '
  'consignee per Work.';

-- ---------------------------------------------------------------------
-- 3. Status gains ''merged''. The three CHECKs from 0024 that constrain
-- status are anonymous, so they are found by their definitions.

DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'measurement_books'::regclass
       AND contype = 'c'
       AND (
         pg_get_constraintdef(oid) LIKE '%''draft''%''finalized''%''cancelled''%'
         OR pg_get_constraintdef(oid) LIKE '%mb_number IS NULL%'
         OR pg_get_constraintdef(oid) LIKE '%cancelled_by_user_id%'
       )
       AND conname <> 'measurement_books_kind_check'
  LOOP
    EXECUTE format('ALTER TABLE measurement_books DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$$;

ALTER TABLE measurement_books
  ADD CONSTRAINT measurement_books_status_check
    CHECK (status IN ('draft', 'finalized', 'cancelled', 'merged')),
  -- Draft and merged carry no finalize artefacts; finalized and cancelled
  -- carry all of them. (A cancelled MB was finalized first — drafts are
  -- deleted, and merged records are simply merged.)
  ADD CONSTRAINT measurement_books_status_shape CHECK (
    (status IN ('draft', 'merged')
      AND mb_number IS NULL AND sequence_number IS NULL
      AND total_amount IS NULL AND remark_template_version IS NULL
      AND finalized_at IS NULL AND finalized_by_user_id IS NULL)
    OR
    (status IN ('finalized', 'cancelled')
      AND mb_number IS NOT NULL AND sequence_number IS NOT NULL
      AND total_amount IS NOT NULL AND remark_template_version IS NOT NULL
      AND finalized_at IS NOT NULL AND finalized_by_user_id IS NOT NULL)
  ),
  ADD CONSTRAINT measurement_books_cancel_shape CHECK (
    (status = 'cancelled'
      AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
      AND cancellation_note IS NOT NULL
      AND length(btrim(cancellation_note)) >= 3)
    OR
    (status <> 'cancelled'
      AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL
      AND cancellation_note IS NULL)
  ),
  -- Only records merge; records ONLY draft or merge. Everything a record
  -- gathers flows onward through the merge — a record MB finalizing or
  -- cancelling on its own would fork the billing pipeline.
  ADD CONSTRAINT measurement_books_kind_status_coherence CHECK (
    (kind = 'record' AND status IN ('draft', 'merged'))
    OR
    (kind <> 'record' AND status <> 'merged')
  ),
  ADD CONSTRAINT measurement_books_merged_shape CHECK (
    (status = 'merged') = (merged_into_id IS NOT NULL)
  ),
  ADD CONSTRAINT measurement_books_consignee_kind CHECK (
    consignee_contact_id IS NULL OR kind = 'record'
  );

-- ---------------------------------------------------------------------
-- 4. is_final becomes generated. The dependent index goes first and is
-- recreated identically over the regenerated column, so the one-live-final
-- rule never lapses.

DROP INDEX measurement_books_one_live_final_per_work;
ALTER TABLE measurement_books DROP COLUMN is_final;
ALTER TABLE measurement_books
  ADD COLUMN is_final boolean
    GENERATED ALWAYS AS (kind = 'final') STORED NOT NULL;

CREATE UNIQUE INDEX measurement_books_one_live_final_per_work
  ON measurement_books (organisation_id, work_id)
  WHERE is_final AND status <> 'cancelled';

-- ---------------------------------------------------------------------
-- 5. The draft rules. One billing draft per Work; record drafts run in
-- parallel, one per named consignee. (Two record drafts with no consignee
-- named are tolerated by SQL NULL semantics — the route requires the
-- consignee, this index is the backstop for the named ones.)

DROP INDEX measurement_books_one_draft_per_work;

CREATE UNIQUE INDEX measurement_books_one_billing_draft_per_work
  ON measurement_books (organisation_id, work_id)
  WHERE status = 'draft' AND kind <> 'record';

CREATE UNIQUE INDEX measurement_books_one_record_draft_per_consignee
  ON measurement_books (organisation_id, work_id, consignee_contact_id)
  WHERE status = 'draft' AND kind = 'record';
