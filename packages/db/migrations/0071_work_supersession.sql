SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Migration 0071: an exit for a confirmed Work whose extracted data is
-- wrong — the remedy migration 0063's own header prescribes, made
-- executable.
--
-- THE DEADLOCK. 0063 ends by saying that Works confirmed before it still
-- carry ADVERTISED rates, and that "the remedy is the product's existing
-- one for a wrong extracted value: discard the LOA document and confirm
-- it again." That remedy does not exist for a confirmed Work. Migration
-- 0055 makes a confirmed letter undiscardable — by route refusal, by CHECK
-- constraint and by trigger — precisely because it is the Work's source of
-- truth, and nothing in the product has ever written `works.deleted_at`,
-- which has sat on the table unused since migration 0001. So a Work
-- confirmed with the wrong rates, the wrong quantities or the wrong
-- letter number has no exit at all: it cannot be corrected (the awarded
-- baseline is immutable and amendments need a railway variation order),
-- and it cannot be withdrawn.
--
-- THE EXIT, and its three limits. A confirmed Work may be SUPERSEDED:
-- soft-deleted, with its LOA document released back to review so the
-- ordinary intake flow can produce a successor. Three limits make that
-- safe rather than a delete button on contract records.
--
--   1. APPROVAL-GATED. Superseding travels through the existing approval
--      engine (0012/0019) as entity_type 'work_supersede', with the Work
--      itself as the entity — so the 0012 one-pending-per-entity index
--      gives one pending supersede request per Work for free, the 0023
--      not-null entity rule is satisfied, and the queue, the audit trail
--      and the withdraw path all work unchanged. No parallel approval
--      path is invented.
--
--   2. NO DOWNSTREAM DOCUMENTS. A Work that has issued or received
--      anything is not superseded; it is corrected through the paths that
--      already exist (amendment, cancel-and-replace, correction notice).
--      The census below is the database's own statement of that rule, and
--      it is deliberately written as an explicit list of tables rather
--      than "any child row": the seven per-Work counter tables are
--      created eagerly by the numbering paths and are not documents, and
--      the Work's own body — schedules, items, payment matrix, consignee
--      preferences, assignments, the LOA document itself — is what is
--      being withdrawn, not something downstream of it.
--
--      Approval requests count as downstream, but only while pending or
--      approved. A pending one must be decided first (it proposes a
--      change to a Work that is about to stop existing); an approved one
--      has already moved the item table, so the Work is no longer purely
--      what the letter said and the successor could not reproduce it. A
--      rejected or withdrawn request changed nothing and does not block —
--      otherwise one rejected proposal would re-lock the deadlock this
--      migration exists to open.
--
--   3. SOFT, AND ONE-WAY. `works.deleted_at` is terminal: it is never
--      cleared and the row freezes when it is set. The predecessor keeps
--      its work code, its letter number, its items and its rates forever,
--      because the question "what did we think this contract said, and
--      when did we stop thinking it" has to stay answerable. What it
--      stops holding is the organisation's live claim on that work code
--      and letter number, which is why the two identity constraints
--      become partial indexes over live rows: a successor for the same
--      contract carries the same identity, since it IS the same contract.
--
-- NUMBERING. Nothing here reuses a number. Every per-Work counter is keyed
-- (organisation_id, work_id) and the successor is a new Work with new
-- counters starting at 1, so the predecessor's series — empty by the
-- eligibility rule — is frozen at whatever it reached and no value is ever
-- minted twice. The counter rows are left exactly where they are; the
-- 0064 decrease guard would refuse to move them anyway, and that is the
-- correct posture: a counter records what a series reached, not what
-- survives.
--
-- WHAT THIS GUARD DOES NOT DO. It backstops eligibility and provenance —
-- no Work is soft-deleted without a supersession record, and none while a
-- document points at it. It does not backstop the deciding AUTHORITY,
-- which is the route's job here exactly as it is for every other approval
-- kind: the trigger cannot see whether the transaction that is superseding
-- is the one that is also approving, because the approval engine marks the
-- request approved after the apply step runs.

-- ---------------------------------------------------------------------
-- 1. Live identity. A superseded Work keeps its work code and letter
--    number; it just stops claiming them.
-- ---------------------------------------------------------------------

ALTER TABLE works DROP CONSTRAINT works_organisation_id_work_code_key;
ALTER TABLE works DROP CONSTRAINT works_organisation_id_letter_number_key;

CREATE UNIQUE INDEX works_live_work_code_key
  ON works (organisation_id, work_code)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX works_live_letter_number_key
  ON works (organisation_id, letter_number)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- 2. The approval engine admits the supersede request.
-- ---------------------------------------------------------------------

ALTER TABLE approval_requests
  DROP CONSTRAINT approval_requests_entity_type_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_entity_type_check
  CHECK (entity_type IN (
    'work_item_amendment',
    'challan_cancel_replace',
    'issue_challan_cancel_replace',
    'challan_correction_notice',
    'work_supersede'
  ));

-- ---------------------------------------------------------------------
-- 3. The supersession record: one row per superseded Work, carrying the
--    provenance in both directions.
-- ---------------------------------------------------------------------

CREATE TABLE work_supersessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  -- The withdrawn Work. One supersession per Work: a Work is superseded
  -- once and then frozen, so a second attempt has nothing to withdraw.
  superseded_work_id uuid NOT NULL,
  -- The letter that produced it, released back to 'review' by the same
  -- transaction. Recorded here because `loa_documents.confirmed_work_id`
  -- is cleared by the release and would otherwise lose the link.
  loa_document_id uuid NOT NULL,
  -- The Work confirmed in its place, bound when the released document is
  -- confirmed again. NULL is a legitimate resting state: an operator who
  -- discards the released letter and uploads a corrected copy leaves a
  -- supersession with no successor, and that is the truth about what
  -- happened rather than a link worth fabricating.
  successor_work_id uuid,
  approval_request_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  superseded_at timestamptz NOT NULL DEFAULT now(),
  superseded_by_user_id text NOT NULL,
  successor_bound_at timestamptz,
  successor_bound_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, superseded_work_id),
  UNIQUE (organisation_id, approval_request_id),
  FOREIGN KEY (organisation_id, superseded_work_id)
    REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, successor_work_id)
    REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, loa_document_id)
    REFERENCES loa_documents(organisation_id, id),
  FOREIGN KEY (organisation_id, approval_request_id)
    REFERENCES approval_requests(organisation_id, id),
  CHECK (successor_work_id IS NULL OR successor_work_id <> superseded_work_id),
  -- The successor triple is all-or-nothing, in the 0023/0055 style.
  CHECK (
    (successor_work_id IS NULL
      AND successor_bound_at IS NULL
      AND successor_bound_by_user_id IS NULL)
    OR
    (successor_work_id IS NOT NULL
      AND successor_bound_at IS NOT NULL
      AND successor_bound_by_user_id IS NOT NULL)
  )
);

-- A Work stands at the end of at most one supersession chain. Written
-- total rather than partial so it also serves the successor foreign key
-- (the FK-index census reads leading index columns): NULLs are DISTINCT by
-- default, so any number of unbound supersessions still coexist.
CREATE UNIQUE INDEX work_supersessions_one_successor
  ON work_supersessions (organisation_id, successor_work_id);

CREATE INDEX work_supersessions_document_idx
  ON work_supersessions (organisation_id, loa_document_id);
CREATE INDEX work_supersessions_org_idx
  ON work_supersessions (organisation_id, superseded_at DESC, id);

COMMENT ON TABLE work_supersessions IS
  'One row per confirmed Work withdrawn by an approved supersede request '
  '(migration 0071): what was withdrawn, why, on whose approval, which '
  'letter was released, and — once the letter is confirmed again — which '
  'Work replaced it.';

-- Only the successor binding ever changes, and only once.
CREATE FUNCTION app_private.guard_work_supersession_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.organisation_id, NEW.superseded_work_id, NEW.loa_document_id,
    NEW.approval_request_id, NEW.reason, NEW.superseded_at,
    NEW.superseded_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.superseded_work_id, OLD.loa_document_id,
    OLD.approval_request_id, OLD.reason, OLD.superseded_at,
    OLD.superseded_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'a supersession record is immutable; only its successor may be bound'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.successor_work_id IS NOT NULL
    AND NEW.successor_work_id IS DISTINCT FROM OLD.successor_work_id THEN
    RAISE EXCEPTION 'this supersession already names its successor Work'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER work_supersessions_guard_update
BEFORE UPDATE ON work_supersessions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_supersession_update();

CREATE TRIGGER work_supersessions_touch_updated_at
BEFORE UPDATE ON work_supersessions
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. The soft-delete guard: the eligibility census, in the database.
-- ---------------------------------------------------------------------

CREATE FUNCTION app_private.guard_work_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  blocker text;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    -- Terminal. A withdrawn Work is the record of what was withdrawn;
    -- nothing about it moves again, including the deletion stamp itself.
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'Work % is superseded and is immutable', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.deleted_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Provenance: nothing withdraws a Work except an approved supersession,
  -- whose row this transaction has already written.
  IF NOT EXISTS (
    SELECT 1 FROM work_supersessions s
    WHERE s.organisation_id = NEW.organisation_id
      AND s.superseded_work_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'a Work is withdrawn only by a supersession record; none names Work %',
      NEW.id
      USING ERRCODE = '23514';
  END IF;

  -- Eligibility. Every table below is a document the agency issued,
  -- received, or is bound by. The Work's own body (work_schedules,
  -- work_items, payment_matrices, work_consignees, work_assignments,
  -- loa_documents) and the seven per-Work counters are deliberately
  -- absent: see this migration's header. `apps/server/src/work-supersede.ts`
  -- carries the same list, and `packages/db/test/work-supersession.integration.test.ts`
  -- proves the two agree with the catalog.
  SELECT x.label INTO blocker FROM (
    SELECT 'delivery challan' AS label WHERE EXISTS (
      SELECT 1 FROM delivery_challans t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'issue challan' WHERE EXISTS (
      SELECT 1 FROM issue_challans t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'installation' WHERE EXISTS (
      SELECT 1 FROM installations t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'Measurement Book' WHERE EXISTS (
      SELECT 1 FROM measurement_books t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'Measurement Book merge record' WHERE EXISTS (
      SELECT 1 FROM measurement_book_merge_provenance t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'Measurement Book entry' WHERE EXISTS (
      SELECT 1 FROM mb_entries t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'tax invoice' WHERE EXISTS (
      SELECT 1 FROM tax_invoices t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'credit note' WHERE EXISTS (
      SELECT 1 FROM credit_notes t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'PAC certificate' WHERE EXISTS (
      SELECT 1 FROM pac_certificates t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'correction notice' WHERE EXISTS (
      SELECT 1 FROM correction_notices t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'submitted instrument' WHERE EXISTS (
      SELECT 1 FROM work_instruments t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'bill' WHERE EXISTS (
      SELECT 1 FROM bills t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'extension request' WHERE EXISTS (
      SELECT 1 FROM extension_requests t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'purchase order' WHERE EXISTS (
      SELECT 1 FROM purchase_orders t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'cited variation order' WHERE EXISTS (
      SELECT 1 FROM amendment_variation_orders t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id)
    UNION ALL
    SELECT 'live change request' WHERE EXISTS (
      SELECT 1 FROM approval_requests t
      WHERE t.organisation_id = NEW.organisation_id AND t.work_id = NEW.id
        AND t.entity_type <> 'work_supersede'
        AND t.status IN ('pending', 'approved'))
  ) AS x LIMIT 1;

  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION
      'Work % cannot be superseded while a % names it', NEW.id, blocker
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- Named to sort before works_touch_updated_at, like the 0031 guards.
CREATE TRIGGER works_supersede_guard
BEFORE UPDATE ON works
FOR EACH ROW EXECUTE FUNCTION app_private.guard_work_soft_delete();

-- ---------------------------------------------------------------------
-- 5. Releasing the letter. 0055 froze a confirmed document because it is
--    its Work's source of truth. That reason expires exactly when the
--    Work does, and not one moment sooner.
-- ---------------------------------------------------------------------

CREATE FUNCTION app_private.guard_loa_document_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.extraction_status <> 'confirmed' THEN
    RETURN NEW;
  END IF;
  IF NEW.extraction_status = 'confirmed' THEN
    -- Still confirmed. 0055 already refuses the discard transition and
    -- 0040 freezes the bytes; nothing to add.
    RETURN NEW;
  END IF;

  IF NEW.extraction_status <> 'review' OR NEW.confirmed_work_id IS NOT NULL THEN
    RAISE EXCEPTION
      'a confirmed LOA document leaves confirmation only by returning to review with no Work'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM work_supersessions s
    JOIN works w
      ON w.organisation_id = s.organisation_id
     AND w.id = s.superseded_work_id
    WHERE s.organisation_id = NEW.organisation_id
      AND s.loa_document_id = NEW.id
      AND s.superseded_work_id = OLD.confirmed_work_id
      AND w.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'LOA document % is the source of truth of a live Work and cannot be released',
      OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER loa_documents_release_guard
BEFORE UPDATE ON loa_documents
FOR EACH ROW EXECUTE FUNCTION app_private.guard_loa_document_release();

-- ---------------------------------------------------------------------
-- 6. RLS and grants. InitPlan form from the start (0069): a policy created
--    after that migration cannot be reached by its ALTER statements, and
--    the catalog census refuses bare-call style.
-- ---------------------------------------------------------------------

ALTER TABLE work_supersessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_supersessions FORCE ROW LEVEL SECURITY;

CREATE POLICY work_supersessions_tenant_policy ON work_supersessions
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: a supersession is the only record that a Work was withdrawn
-- and why, so it outlives everyone's second thoughts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON work_supersessions TO auto_mb_app;
  END IF;
END
$$;
