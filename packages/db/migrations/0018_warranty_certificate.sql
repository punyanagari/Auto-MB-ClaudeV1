SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Milestone 7: the optional warranty/guarantee certificate page on the
-- Delivery Challan (legacy §11). The certificate CONTENT (the full
-- template text) is frozen inside issued_snapshot at issue time; these
-- two columns record which warranty template version produced it and the
-- SHA-256 of the exact text, so a certificate can be verified against
-- the organisation's template history without parsing the snapshot.
--
-- The page is optional by design: an organisation with no
-- warranty_template_text (0013) issues challans with neither a
-- certificate page nor these columns. Later profile edits never touch an
-- issued challan — the snapshot carries the text, and the immutability
-- guard below freezes these columns alongside it.
--
-- No new tenant table: the certificate is a facet of delivery_challans,
-- covered by that table's existing RLS policy, grants, and
-- tenant-isolation matrix entry.

-- 1. Columns. Both nullable; a challan carries both or neither, and
--    drafts never carry them (they exist only from issue time).
ALTER TABLE delivery_challans
  ADD COLUMN warranty_template_version text
    CHECK (
      warranty_template_version IS NULL
      OR length(warranty_template_version) BETWEEN 1 AND 50
    ),
  ADD COLUMN warranty_text_sha256 text
    CHECK (warranty_text_sha256 IS NULL OR warranty_text_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE delivery_challans
  ADD CONSTRAINT delivery_challans_warranty_pair_check
    CHECK ((warranty_template_version IS NULL) = (warranty_text_sha256 IS NULL)),
  ADD CONSTRAINT delivery_challans_warranty_status_check
    CHECK (status <> 'draft' OR warranty_template_version IS NULL);

-- 2. Immutability: extend the 0001 issued-challan guard so the warranty
--    version and content hash freeze with the rest of the issued record
--    (same body as 0001 plus the two new columns in the frozen ROW).
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

  RETURN NEW;
END
$$;
