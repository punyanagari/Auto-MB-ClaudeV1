SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Wave 4 closing hardening: a completed Work's operational record is
-- frozen in BOTH directions.
--
-- Migration 0031 closed every path that ADDS an operational document to a
-- completed Work. It left the removals open: cancelling a delivery
-- challan, an issue challan, an installation record, a PAC certificate or
-- a Measurement Book carried no work-status check at either layer. So a
-- Work could sit at status 'completed' — with completed_at, its note, the
-- dashboard alert suppressed and every new document refused — while the
-- delivered/installed sums the R8 100%-executed predicate was measured
-- against had since fallen below the effective quantities that admitted
-- it. No transition, no audit of the invariant breaking, and no repair
-- possible without a reopen (the 0031 insert guards refuse the
-- replacement document).
--
-- The decision is REFUSE, not auto-reopen. Cancelling evidence under a
-- completed Work is a contradiction of the closure, and the operator who
-- means it must say so: reopen with a note (which R8 already requires and
-- audits), cancel, then complete again. An automatic reopen would move a
-- Work's lifecycle as a side effect of an evidence correction, with no
-- note recording why the closure was wrong — exactly the audit hole R8
-- exists to close. So each cancel route now takes the works row FOR
-- UPDATE (lock order: document row first, then works — the creation
-- paths' order, so cancel and completion serialise instead of
-- deadlocking) and refuses through the shared assertWorkOperable helper,
-- and every one of those refusals gets the matching database clause here.
--
-- Bills are deliberately NOT frozen. A bill moving prepared -> submitted
-- -> paid records what the payer did with a bill already prepared; it
-- moves no quantity and creates no document, and payment legitimately
-- continues for months after execution finishes. Refusing it would force
-- an operator to reopen a finished Work merely to record that the railway
-- paid. guard_bill_update is therefore untouched.
--
-- Correction to migration 0031's header. That header justified leaving
-- works.status = 'cancelled' unreachable by citing "the removal path this
-- product actually implements … the soft delete (works.deleted_at,
-- migration 0001, guarded by the R15 'no challans or installations'
-- refusal in the retention routes)". That path does not exist. The
-- works.deleted_at column exists from 0001 and every read filters on it,
-- but NO writer in apps/server ever sets it, and no such R15 refusal is
-- implemented anywhere (the phrase survives only in
-- docs/reference/legacy-product-spec.md, which is historical evidence,
-- not active instruction). So today a Work has NO removal path at all:
-- neither a cancellation nor a soft delete can be performed through the
-- product. The decision 0031 took still stands on its own — 'cancelled'
-- stays refused by guard_work_status_transition until someone builds work
-- removal with its own rules, UI and evidence refusals, and whoever does
-- decides then whether it is the soft delete or the third status. 0031
-- itself is not edited: applied migrations are hash-frozen.
--
-- Contents: the five *_update guard functions, each restated from its
-- CURRENT body (pg_get_functiondef on a database migrated through 0031)
-- plus one new clause on the cancel transition. Nothing is dropped; the
-- triggers already point at these functions. This layers on 0031 exactly
-- as 0031 layered on 0027/0024/0018/0014.

-- 1. Delivery challans. The 0031 body (which restated 0027's, which
-- restated 0018's) verbatim, plus the completed-work clause on the
-- cancel transition. The draft -> cancelled case is already refused
-- above it, so in practice this fires on issued -> cancelled.
CREATE OR REPLACE FUNCTION app_private.guard_delivery_challan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Delivery Challans are immutable';
  END IF;

  IF OLD.status = 'issued' THEN
    IF NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION 'issued Delivery Challans may only remain issued or be cancelled';
    END IF;

    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.challan_date, NEW.challan_number,
      NEW.sequence_number, NEW.prefix, NEW.consignee_snapshot, NEW.issued_snapshot,
      NEW.template_version, NEW.warranty_template_version, NEW.warranty_text_sha256,
      NEW.created_by_user_id, NEW.issued_by_user_id, NEW.issued_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.challan_date, OLD.challan_number,
      OLD.sequence_number, OLD.prefix, OLD.consignee_snapshot, OLD.issued_snapshot,
      OLD.template_version, OLD.warranty_template_version, OLD.warranty_text_sha256,
      OLD.created_by_user_id, OLD.issued_by_user_id, OLD.issued_at
    ) THEN
      RAISE EXCEPTION 'issued Delivery Challan business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Delivery Challans are deleted, not cancelled';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
    IF EXISTS (
      SELECT 1 FROM measurement_books mb
      WHERE mb.organisation_id = NEW.organisation_id
        AND mb.work_id = NEW.work_id
        AND mb.is_final
        AND mb.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION
        'a final Measurement Book exists for this Work; issuing this delivery challan would create a source that can never be billed'
        USING ERRCODE = 'check_violation';
    END IF;

    -- R8: a completed Work accepts no new operational documents.
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = NEW.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before issuing a delivery challan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- R8 (0032): nor may the delivered quantity the completion predicate
  -- was measured against be withdrawn from under it.
  IF OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = NEW.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before cancelling a delivery challan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 2. Issue challans. The 0031 body (which restated 0014's) verbatim,
-- plus the same clause.
CREATE OR REPLACE FUNCTION app_private.guard_issue_challan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Issue Challans are immutable';
  END IF;

  IF OLD.status = 'issued' THEN
    IF NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION 'issued Issue Challans may only remain issued or be cancelled';
    END IF;

    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.movement_type, NEW.challan_date,
      NEW.challan_number, NEW.sequence_number, NEW.prefix, NEW.issued_to_name,
      NEW.issued_to_role, NEW.location, NEW.remarks, NEW.issued_snapshot,
      NEW.template_version, NEW.created_by_user_id, NEW.issued_by_user_id,
      NEW.issued_at
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.movement_type, OLD.challan_date,
      OLD.challan_number, OLD.sequence_number, OLD.prefix, OLD.issued_to_name,
      OLD.issued_to_role, OLD.location, OLD.remarks, OLD.issued_snapshot,
      OLD.template_version, OLD.created_by_user_id, OLD.issued_by_user_id,
      OLD.issued_at
    ) THEN
      RAISE EXCEPTION 'issued Issue Challan business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Issue Challans are deleted, not cancelled';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
    -- R8: a completed Work accepts no new operational documents.
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = NEW.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before issuing an issue challan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- R8 (0032): a completed Work's issued documents cannot be withdrawn
  -- behind it either.
  IF OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = NEW.organisation_id
        AND w.id = NEW.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before cancelling an issue challan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 3. Installation records. The 0027 body verbatim, plus the clause.
CREATE OR REPLACE FUNCTION app_private.guard_installation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled installation records are immutable';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.work_item_id, NEW.quantity,
    NEW.installed_on, NEW.location_id, NEW.location_name, NEW.remarks,
    NEW.recorded_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.work_item_id, OLD.quantity,
    OLD.installed_on, OLD.location_id, OLD.location_name, OLD.remarks,
    OLD.recorded_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'installation business data is immutable; cancel and re-record instead';
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'recorded' THEN
    -- R8 (0032): the installed quantity the completion predicate was
    -- measured against cannot be withdrawn from under it. Checked before
    -- the R19/R18 refusals so a completed Work answers with the reopen
    -- instruction rather than a downstream reason the operator cannot act
    -- on, matching the route's own order.
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = OLD.organisation_id
        AND w.id = OLD.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before cancelling an installation record'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1 FROM mb_sources ms
        WHERE ms.source_type = 'installation'
          AND ms.source_id = OLD.id
          AND ms.released_at IS NULL
      ) THEN
      RAISE EXCEPTION
        'installation % is billed in a live Measurement Book and cannot be cancelled', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (
      SELECT coalesce(sum(pci.certified_quantity), 0)
      FROM pac_certificate_items pci
      JOIN pac_certificates pc ON pc.id = pci.pac_certificate_id
      WHERE pci.organisation_id = OLD.organisation_id
        AND pci.work_item_id = OLD.work_item_id
        AND pc.status = 'recorded'
    ) > (
      SELECT coalesce(sum(i.quantity), 0)
      FROM installations i
      WHERE i.organisation_id = OLD.organisation_id
        AND i.work_item_id = OLD.work_item_id
        AND i.status = 'recorded'
        AND i.id <> OLD.id
    ) THEN
      RAISE EXCEPTION
        'installation % is covered by recorded PAC certificates; cancelling it would leave certified quantity above installed (R18) — cancel the covering PAC certificate(s) first',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 4. PAC certificates. The 0027 body verbatim, plus the clause.
CREATE OR REPLACE FUNCTION app_private.guard_pac_certificate_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled PAC certificates are immutable';
  END IF;

  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.reference, NEW.issue_date,
    NEW.consignee_master_id, NEW.consignee_designation,
    NEW.recorded_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.reference, OLD.issue_date,
    OLD.consignee_master_id, OLD.consignee_designation,
    OLD.recorded_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PAC certificate business data is immutable; cancel and re-record instead';
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'recorded' THEN
    -- R8 (0032): the acceptance evidence a completed Work was closed on
    -- cannot be withdrawn behind it.
    IF EXISTS (
      SELECT 1 FROM works w
      WHERE w.organisation_id = OLD.organisation_id
        AND w.id = OLD.work_id
        AND w.status = 'completed'
    ) THEN
      RAISE EXCEPTION
        'this Work is completed; reopen it before cancelling a PAC certificate'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1 FROM mb_sources ms
        WHERE ms.source_type = 'pac_certificate'
          AND ms.source_id = OLD.id
          AND ms.released_at IS NULL
      ) THEN
      RAISE EXCEPTION
        'PAC certificate % is billed in a live Measurement Book and cannot be cancelled', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 5. Measurement Books. The 0027 body verbatim, plus the clause. Cancel
-- releases the book's claimed sources, so it moves quantities back into
-- play on a Work whose closure was measured with them claimed.
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
