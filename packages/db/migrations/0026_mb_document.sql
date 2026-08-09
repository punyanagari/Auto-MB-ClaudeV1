SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 8 phase 3: the Measurement Book document (PDF) render
-- evidence (spec §5.9 "MB document (PDF)"; §11 document conventions).
-- A FINALIZED Measurement Book renders to a persisted, content-addressed
-- PDF (template mb-v1, Gotenberg conversion) whose object key and
-- SHA-256 are recorded here, exactly like delivery challans (0001) and
-- extension letters (0011). Drafts stream a watermarked live preview and
-- persist NOTHING: a draft recomputes on every read, so a stored draft
-- artifact would be stale the moment a source selection changed.
--
-- No new tables: the render evidence is three columns on the existing
-- measurement_books row, so RLS, the privilege matrix, and the tenancy
-- suite are untouched.

ALTER TABLE measurement_books
  ADD COLUMN template_version text,
  ADD COLUMN rendered_object_key text,
  ADD COLUMN rendered_sha256 text
    CHECK (rendered_sha256 IS NULL OR rendered_sha256 ~ '^[0-9a-f]{64}$');

-- The render evidence is complete or absent: the object key, its
-- SHA-256, and the template version it was rendered under travel
-- together (0011 pair discipline).
ALTER TABLE measurement_books
  ADD CONSTRAINT measurement_books_render_pair_check
  CHECK (
    (rendered_object_key IS NULL) = (rendered_sha256 IS NULL)
    AND (rendered_object_key IS NULL) = (template_version IS NULL)
  );

-- Status shape: only FINALIZED Measurement Books render, and a
-- cancelled-after-finalized MB keeps the render it already carried —
-- so drafts carry no render fields, ever.
ALTER TABLE measurement_books
  ADD CONSTRAINT measurement_books_render_status_check
  CHECK (
    status <> 'draft'
    OR (
      template_version IS NULL
      AND rendered_object_key IS NULL
      AND rendered_sha256 IS NULL
    )
  );

-- 0024 guard_measurement_book_update, restated with its full original
-- body. The finalized-row frozen ROW deliberately EXCLUDES the three
-- render columns (the challans/extension pattern: render evidence is
-- re-recordable presentation, not frozen business data), so a finalized
-- MB may update ONLY status (to cancelled, with its cancellation
-- fields) and the render fields. Cancelled MBs stay fully immutable:
-- rendering is a finalized-only act, and a cancelled-after-finalized MB
-- keeps the render it already recorded.
CREATE OR REPLACE FUNCTION app_private.guard_measurement_book_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Measurement Books are immutable';
  END IF;

  IF OLD.status = 'finalized' THEN
    IF NEW.status NOT IN ('finalized', 'cancelled') THEN
      RAISE EXCEPTION 'finalized Measurement Books may only remain finalized or be cancelled';
    END IF;
    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.is_final, NEW.mb_date,
      NEW.mb_number, NEW.sequence_number, NEW.total_amount,
      NEW.remark_template_version, NEW.created_by_user_id,
      NEW.finalized_by_user_id, NEW.created_at, NEW.finalized_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.is_final, OLD.mb_date,
      OLD.mb_number, OLD.sequence_number, OLD.total_amount,
      OLD.remark_template_version, OLD.created_by_user_id,
      OLD.finalized_by_user_id, OLD.created_at, OLD.finalized_at
    ) THEN
      RAISE EXCEPTION 'finalized Measurement Book business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Measurement Books are deleted, not cancelled';
  END IF;

  RETURN NEW;
END
$$;
