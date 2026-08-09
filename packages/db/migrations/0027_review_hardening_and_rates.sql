SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Review hardening (Milestone 8 + importer adversarial review) and the
-- approved rate-precision widening, in one migration:
--
--   1. pac_certificates cancellation CHECK gains the explicit
--      cancellation_note IS NOT NULL conjunct (the 0023 defect class:
--      with note NULL the cancelled branch evaluates to NULL, and
--      NULL OR FALSE passes the CHECK). 0023 fixed every sibling table
--      but never touched pac_certificates.
--   2. Rate columns widen from numeric(18,2) to numeric(18,6) (approved
--      product change): v1 agreement rates carry up to 6 decimals
--      (0.8517/mtr), and 2dp storage rounded authoritative money inputs.
--      AMOUNT columns stay numeric(18,2) — R13 line rounding unchanged.
--   3. guard_measurement_book_update gains the database half of two
--      cancel rules that were app-level only: a billed MB is permanently
--      locked (ADR-0006 decision 3; bills.mb_id EXISTS), and only the
--      newest live MB may be cancelled (spec §5.9 delta coherence).
--   4. guard_installation_update gains the R18 backstop on the cancel
--      transition: a cancel may not leave PAC-certified quantity above
--      the remaining installed quantity for the item.
--   5. A live final Measurement Book freezes the Work's source-creating
--      transitions (spec §5.9: the final MB "closes the work's payment
--      cycle"): issuing a delivery challan, recording an installation,
--      and recording a PAC certificate are refused while a live final MB
--      exists — otherwise the new source could never be billed, because
--      no further MB may be raised. The challan half restates
--      guard_delivery_challan_update (0018 body — the latest); the
--      installation/PAC halves are INSERT guards (those tables had no
--      insert-time guard function to extend), following the 0024
--      guard_measurement_book_insert pattern.
--
-- Every restated function carries its previous body verbatim plus the
-- new clause; nothing is dropped. All guards run as the invoking role:
-- same-tenant writers see the referenced rows through RLS, and the
-- administrator (importer) sees everything.

-- 1. pac_certificates cancellation CHECK, NULL-proofed (0023 pattern;
-- the constraint keeps its original auto-generated name).
ALTER TABLE pac_certificates
  DROP CONSTRAINT pac_certificates_check1;
ALTER TABLE pac_certificates
  ADD CONSTRAINT pac_certificates_check1 CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancellation_note IS NOT NULL AND length(btrim(cancellation_note)) >= 3)
    OR
    (status = 'recorded' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_note IS NULL)
  );

-- 2. Rate precision: every rate-typed column widens to numeric(18,6).
-- Audited 0001..0026: the rate columns are work_items.effective_rate
-- (0001), delivery_challan_items.rate_snapshot (0001),
-- work_items.effective_unit_rate (0012), and
-- measurement_book_lines.effective_rate (0024). Amount/quantity columns
-- (numeric(18,2)/numeric(18,3)) are deliberately untouched.
ALTER TABLE work_items
  ALTER COLUMN effective_rate TYPE numeric(18,6),
  ALTER COLUMN effective_unit_rate TYPE numeric(18,6);
ALTER TABLE delivery_challan_items
  ALTER COLUMN rate_snapshot TYPE numeric(18,6);
ALTER TABLE measurement_book_lines
  ALTER COLUMN effective_rate TYPE numeric(18,6);

-- 3. 0026 guard_measurement_book_update, restated with its full body,
-- plus the two cancel-transition backstops on the finalized branch:
--   - a Measurement Book referenced by a bill can never cancel
--     (ADR-0006 decision 3 — cancelling would release its sources for
--     re-billing while the bill stays payable: double payment);
--   - only the newest live (finalized) MB of the Work may cancel
--     (spec §5.9 — cancelling an older MB would break the delta
--     coherence baked into newer MBs' prior-cumulative memory).
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

  RETURN NEW;
END
$$;

-- 4. 0024 guard_installation_update, restated with its full body, plus
-- the R18 backstop on the cancel transition: the certified total over
-- recorded PAC certificates may never exceed the installed total, so an
-- installation whose quantity is needed to cover recorded certificates
-- cannot cancel — the covering certificate(s) must cancel first.
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

-- 5a. 0018 guard_delivery_challan_update, restated with its full body,
-- plus the final-MB clause on the draft -> issued transition.
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
  END IF;

  RETURN NEW;
END
$$;

-- 5b. New billable sources cannot be recorded once a live final MB
-- exists (0024 guard_measurement_book_insert pattern; installations and
-- pac_certificates had no INSERT-time guard function to extend, so each
-- gets one).
CREATE FUNCTION app_private.guard_installation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM measurement_books mb
    WHERE mb.organisation_id = NEW.organisation_id
      AND mb.work_id = NEW.work_id
      AND mb.is_final
      AND mb.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION
      'a final Measurement Book exists for this Work; recording this installation would create a source that can never be billed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app_private.guard_pac_certificate_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM measurement_books mb
    WHERE mb.organisation_id = NEW.organisation_id
      AND mb.work_id = NEW.work_id
      AND mb.is_final
      AND mb.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION
      'a final Measurement Book exists for this Work; recording this PAC certificate would create a source that can never be billed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER installations_guard_insert
BEFORE INSERT ON installations
FOR EACH ROW EXECUTE FUNCTION app_private.guard_installation_insert();

CREATE TRIGGER pac_certificates_guard_insert
BEFORE INSERT ON pac_certificates
FOR EACH ROW EXECUTE FUNCTION app_private.guard_pac_certificate_insert();
