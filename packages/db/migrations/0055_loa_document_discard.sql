SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- An exit for an LOA intake package that should never have been uploaded.
--
-- Until now loa_documents could only be created. The routes are upload,
-- list, read and confirm; nothing removes a row. Upload the wrong PDF —
-- last year's letter, a scan of the wrong work, somebody else's tender —
-- and it sits in the organisation's document list forever, permanently
-- offering a Review button that creates a Work nobody wants.
--
-- Hard deletion is deliberately unavailable: loa_documents carries no
-- DELETE privilege for the application role (migration 0003, restated in
-- the bootstrap privilege matrix), because an uploaded contract document
-- is retention material — the fact that a file was received, by whom and
-- when, survives the operator's change of mind. So the exit is a SOFT
-- DISCARD: a terminal 'discarded' extraction status carrying who
-- discarded it, when, and an optional reason. The stored object is left
-- exactly where it is for the retention path to age out; nothing about
-- the bytes, the hash or the uploader is rewritten.
--
-- The rule that matters: a document may be discarded only while it is
-- still nobody's Work. Once confirmation has created a Work from a
-- letter, that letter IS the Work's source of truth — every work_item
-- carries source_evidence pointing back into its extraction payload, and
-- the confirmed document is the only record of what the reviewer's data
-- was derived from. Discarding it would leave the Work's evidence
-- pointing at a document the product presents as thrown away. The route
-- refuses it by name; this trigger refuses it again, so no writer — a
-- future route, a script, a repair session — can reach past the API and
-- do it anyway.

ALTER TABLE loa_documents
  ADD COLUMN discarded_at timestamptz,
  ADD COLUMN discarded_by_user_id text,
  ADD COLUMN discard_reason text;

ALTER TABLE loa_documents
  DROP CONSTRAINT loa_documents_extraction_status_check;

ALTER TABLE loa_documents
  ADD CONSTRAINT loa_documents_extraction_status_check
  CHECK (extraction_status IN (
    'pending', 'processing', 'review', 'confirmed', 'failed', 'discarded'
  )),
  -- Discard is complete or absent, NULL-proof in the 0023/0024 style:
  -- actor and time travel with the status, and a reason — optional,
  -- because discarding an unconfirmed upload is a draft deletion rather
  -- than the cancellation of an issued document — is either absent or
  -- says something.
  ADD CONSTRAINT loa_documents_discard_shape_check
  CHECK (
    (
      extraction_status = 'discarded'
      AND discarded_at IS NOT NULL
      AND discarded_by_user_id IS NOT NULL
      AND (discard_reason IS NULL OR length(btrim(discard_reason)) >= 3)
    )
    OR
    (
      extraction_status <> 'discarded'
      AND discarded_at IS NULL
      AND discarded_by_user_id IS NULL
      AND discard_reason IS NULL
    )
  ),
  -- The invariant in its simplest form: a discarded document never
  -- carries a Work. The trigger below states the same rule with the
  -- message an operator can act on; this constraint holds it even for a
  -- row written in an order the trigger's transition test would miss.
  ADD CONSTRAINT loa_documents_discard_never_confirmed_check
  CHECK (extraction_status <> 'discarded' OR confirmed_work_id IS NULL);

-- The default list and the byte-identical duplicate check both read live
-- documents only, so both partial indexes exclude the discarded rows.
CREATE INDEX loa_documents_live_idx
  ON loa_documents (organisation_id, document_kind, created_at DESC, id)
  WHERE extraction_status <> 'discarded';

CREATE INDEX loa_documents_live_sha256_idx
  ON loa_documents (organisation_id, sha256)
  WHERE extraction_status <> 'discarded';

CREATE FUNCTION app_private.guard_loa_document_discard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.extraction_status = 'discarded' THEN
      RAISE EXCEPTION
        'an LOA document cannot be uploaded already discarded'
        USING ERRCODE = 'check_violation';
    END IF;

    -- A supporting contract document joins an intake package. Joining a
    -- discarded one would revive a package the operator threw away.
    IF NEW.document_kind <> 'loa' AND EXISTS (
      SELECT 1 FROM loa_documents parent
      WHERE parent.organisation_id = NEW.organisation_id
        AND parent.id = NEW.parent_loa_document_id
        AND parent.extraction_status = 'discarded'
    ) THEN
      RAISE EXCEPTION
        'the LOA this supporting document belongs to was discarded; upload the letter again first'
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  END IF;

  -- Terminal state. Nothing about a discarded document changes again —
  -- not its status, not its extraction payload, and above all not a
  -- confirmed_work_id arriving later from the confirm path.
  IF OLD.extraction_status = 'discarded' THEN
    IF ROW(
      NEW.extraction_status, NEW.extraction_payload, NEW.confirmed_work_id,
      NEW.discarded_at, NEW.discarded_by_user_id, NEW.discard_reason
    ) IS DISTINCT FROM ROW(
      OLD.extraction_status, OLD.extraction_payload, OLD.confirmed_work_id,
      OLD.discarded_at, OLD.discarded_by_user_id, OLD.discard_reason
    ) THEN
      RAISE EXCEPTION
        'discarded LOA documents are immutable; upload the correct file instead'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.extraction_status = 'discarded' THEN
    IF OLD.extraction_status = 'confirmed'
      OR OLD.confirmed_work_id IS NOT NULL
      OR NEW.confirmed_work_id IS NOT NULL
    THEN
      RAISE EXCEPTION
        'LOA document % has already been confirmed into a Work and is that Work''s source of truth; it cannot be discarded',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER loa_documents_discard_guard
BEFORE INSERT OR UPDATE ON loa_documents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_loa_document_discard();
