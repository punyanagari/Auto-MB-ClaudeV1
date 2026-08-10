SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Migration 0036: guard_measurement_book_update must freeze `kind`, not
-- the generated `is_final`.
--
-- 0034 made is_final GENERATED ALWAYS AS (kind = 'final'). PostgreSQL
-- leaves generated columns NULL in a BEFORE trigger's NEW row (they are
-- computed only after BEFORE triggers run), so the 0032 guard body's
-- frozen-ROW comparison — which includes NEW.is_final — saw NULL IS
-- DISTINCT FROM OLD.is_final on EVERY update of a finalized Measurement
-- Book and raised 'finalized Measurement Book business data is
-- immutable' against perfectly legitimate writes: cancellation and the
-- render-evidence stamps. The fix is the 0032 body verbatim with `kind`
-- (the base column is_final is generated FROM) in the frozen ROW; the
-- immutability proven is identical, because is_final is a pure function
-- of kind.
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
      NEW.organisation_id, NEW.work_id, NEW.kind, NEW.mb_date,
      NEW.mb_number, NEW.sequence_number, NEW.total_amount,
      NEW.remark_template_version, NEW.created_by_user_id,
      NEW.finalized_by_user_id, NEW.created_at, NEW.finalized_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.kind, OLD.mb_date,
      OLD.mb_number, OLD.sequence_number, OLD.total_amount,
      OLD.remark_template_version, OLD.created_by_user_id,
      OLD.finalized_by_user_id, OLD.created_at, OLD.finalized_at
    ) THEN
      RAISE EXCEPTION 'finalized Measurement Book business data is immutable';
    END IF;
    IF NEW.status = 'cancelled' THEN
      IF EXISTS (
        SELECT 1 FROM bills b
        WHERE b.organisation_id = OLD.organisation_id AND b.mb_id = OLD.id
      ) THEN
        RAISE EXCEPTION
          'Measurement Book % has a prepared bill and is permanently locked; corrections happen as compensating entries on a subsequent MB',
          OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM measurement_books newer
        WHERE newer.organisation_id = OLD.organisation_id
          AND newer.work_id = OLD.work_id
          AND newer.status = 'finalized'
          AND newer.sequence_number > OLD.sequence_number
      ) THEN
        RAISE EXCEPTION
          'Measurement Book % is not the newest live Measurement Book of its Work; only the newest may be cancelled',
          OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Measurement Books are deleted, not cancelled';
  END IF;

  -- R8 (0032): cancelling releases this book's claimed sources, so a
  -- completed Work must be reopened first.
  IF OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = OLD.organisation_id
        AND w.id = OLD.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before cancelling a Measurement Book'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;
