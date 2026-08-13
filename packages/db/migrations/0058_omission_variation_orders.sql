SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Owner ruling, 2026-08-13: omitting an item from a Work after the LOA has
-- been accepted is a CONTRACTUAL EVENT — a railway variation order — not a
-- correction. An omission may therefore not be APPROVED unless the railway
-- order that authorises it has been produced, and the facts cited from it
-- have been VERIFIED AGAINST THE DOCUMENT ITSELF.
--
-- This extends to amendments the truth-source discipline the LOA already
-- has (apps/server/src/loa-extracted-values.ts): a value nobody checked
-- against the letter is not evidence. A typed letter number is a claim; a
-- letter number found in the uploaded order's own text layer is a fact.
-- Every identifying column below is therefore EXTRACTED from the uploaded
-- PDF by apps/server/src/variation-order-verify.ts, never typed by the
-- operator — there is no field here for anyone to assert.
--
-- WHAT ALREADY HELD, and still does: the omission is approval-gated (0012),
-- evidence-blocked against delivery challans, installations, PAC
-- certificates and Measurement Book lines (0030), and a soft-delete that
-- reserves the item number forever (0001 + 0030). This migration adds the
-- authorisation half.
--
-- WHY A NEW TABLE RATHER THAN loa_documents' contract-source rows.
-- Migration 0040's supporting-document model is an LOA INTAKE PACKAGE: its
-- CHECK requires every non-'loa' row to hang off a parent LOA document
-- (`parent_loa_document_id IS NOT NULL`) and to carry a `matched` tender
-- identity proved against that parent's extraction payload. A variation
-- order fails both by nature — it arrives AFTER award, it is not tender
-- evidence the contract terms were read from, and a Work that reached the
-- product by import or manual entry has no parent LOA row to hang it on at
-- all, which would make its items unomittable forever. Reusing that table
-- would mean widening its kind list, adding a fourth branch to its shape
-- CHECK, and teaching every existing reader of the intake package to
-- exclude the new kind. The MACHINERY is reused instead — the same
-- ObjectStorage boundary, the same PDF magic-byte gate, the same malware
-- scan, the same Poppler-only text extraction, the same immutability,
-- audit and RLS posture — while the row lives where its own truth is.

-- ---------------------------------------------------------------------
-- 1. The variation order attached to an omission amendment.
--
-- At most one per approval request. Only a VERIFIED order is ever stored:
-- the route refuses an unverified upload before it inserts, and the CHECK
-- below refuses one to any other writer, so the mere existence of a row
-- is the authorisation. `verdict` keeps the structured claim-by-claim
-- result that justified it, for the audit trail and for the approver's
-- screen.
-- ---------------------------------------------------------------------
CREATE TABLE amendment_variation_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  approval_request_id uuid NOT NULL,
  work_id uuid NOT NULL,
  -- The contract link, read off the order's own "Agreement Details" block.
  -- An IREPS Variation Statement carries no letter number of its own: its
  -- identity within a contract is the agreement number plus the variation
  -- number, and its link to OUR Work is the LOA Number it prints — which is
  -- exactly works.letter_number. Both are held in that column's grammar and
  -- bounds (migration 0001): free text, trimmed, 1..200 characters. Railway
  -- references are not a closed format and are preserved verbatim; what
  -- makes these trustworthy is not their shape but that the verifier found
  -- them in the uploaded order and matched them against the Work.
  loa_number text NOT NULL
    CHECK (length(btrim(loa_number)) BETWEEN 1 AND 200),
  loa_date date NOT NULL,
  agreement_number text NOT NULL
    CHECK (length(btrim(agreement_number)) BETWEEN 1 AND 200),
  -- The railway's numbering of this variation within the agreement ("1",
  -- "3"). Recorded and shown, deliberately NOT required to be sequential:
  -- a Work adopted mid-contract legitimately never saw the earlier ones,
  -- so enforcing an order would refuse lawful paperwork.
  variation_number text NOT NULL
    CHECK (length(btrim(variation_number)) BETWEEN 1 AND 50),
  object_key text NOT NULL,
  original_filename text NOT NULL
    CHECK (length(btrim(original_filename)) BETWEEN 1 AND 500),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (media_type = 'application/pdf'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  -- The structured verdict: every claim, whether it was verified, and the
  -- excerpt that verified it.
  verdict jsonb NOT NULL CHECK (jsonb_typeof(verdict) = 'object'),
  -- Only verified orders exist. Kept as a column rather than implied so
  -- the guards below read one boolean instead of re-deriving the verdict.
  verified boolean NOT NULL CHECK (verified),
  uploaded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, approval_request_id),
  FOREIGN KEY (organisation_id, approval_request_id)
    REFERENCES approval_requests(organisation_id, id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

CREATE INDEX amendment_variation_orders_work_idx
  ON amendment_variation_orders (organisation_id, work_id, created_at, id);

-- The uploaded order is evidence: nothing about it may be rewritten, and
-- it is never erased. The privilege matrix grants the application role
-- SELECT and INSERT only; this trigger is the floor under that, so a
-- future grant slip cannot quietly turn evidence into a scratchpad.
CREATE FUNCTION app_private.guard_amendment_variation_order_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'a cited variation order is immutable evidence; it is neither edited nor deleted'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER amendment_variation_orders_immutable
BEFORE UPDATE OR DELETE ON amendment_variation_orders
FOR EACH ROW EXECUTE FUNCTION
  app_private.guard_amendment_variation_order_immutable();

ALTER TABLE amendment_variation_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE amendment_variation_orders FORCE ROW LEVEL SECURITY;

CREATE POLICY amendment_variation_orders_tenant_policy
  ON amendment_variation_orders
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT ON amendment_variation_orders TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. The rule, at the approval request: an omission cannot become
-- approved without one.
--
-- The shape does not fit a CHECK — it is a relationship between two
-- tables — so it is a trigger, in the same posture 0030 established for
-- the rest of R7. Kinds other than remove_item are untouched: a quantity
-- or rate amendment is arguably a variation order too (see docs/PRODUCT.md
-- §5 invariant 15), but the owner scoped this ruling to omissions.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_omission_variation_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'approved' OR OLD.status = 'approved' THEN
    RETURN NEW;
  END IF;
  IF NEW.entity_type <> 'work_item_amendment'
     OR NEW.proposed->>'kind' IS DISTINCT FROM 'remove_item' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM amendment_variation_orders avo
    WHERE avo.organisation_id = NEW.organisation_id
      AND avo.approval_request_id = NEW.id
      AND avo.verified
  ) THEN
    RAISE EXCEPTION
      'an omission cannot be approved without a verified railway variation order'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER approval_requests_omission_variation_guard
BEFORE UPDATE ON approval_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_omission_variation_order();

-- ---------------------------------------------------------------------
-- 3. The same rule at the item, because the item is what actually
-- changes.
--
-- 0030's omission guard already refuses a soft-delete against every
-- writer when the item carries evidence. The authorisation requirement
-- belongs in exactly the same place rather than beside it: one function,
-- one trigger, every writer bound. The evidence test is unchanged and
-- runs first — an item that cannot be omitted at all should say so
-- before it is asked for paperwork.
--
-- The approval request is looked up in either the pending or the approved
-- state deliberately: the route soft-deletes the item and marks the
-- request approved in that order within one transaction, so at the moment
-- this trigger fires the authorising request is still pending.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_work_item_omission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence text[] := ARRAY[]::text[];
  hits numeric;
BEGIN
  IF NOT (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(sum(dci.quantity), 0) INTO hits
  FROM delivery_challan_items dci
  JOIN delivery_challans dc ON dc.id = dci.delivery_challan_id
  WHERE dci.work_item_id = NEW.id AND dc.status <> 'cancelled';
  IF hits > 0 THEN
    evidence := evidence || ('delivery challans (' || hits::text || ')');
  END IF;

  SELECT COALESCE(sum(i.quantity), 0) INTO hits
  FROM installations i
  WHERE i.work_item_id = NEW.id AND i.status = 'recorded';
  IF hits > 0 THEN
    evidence := evidence || ('installations (' || hits::text || ')');
  END IF;

  SELECT COALESCE(sum(pci.certified_quantity), 0) INTO hits
  FROM pac_certificate_items pci
  JOIN pac_certificates pc ON pc.id = pci.pac_certificate_id
  WHERE pci.work_item_id = NEW.id AND pc.status = 'recorded';
  IF hits > 0 THEN
    evidence := evidence || ('PAC certificates (' || hits::text || ')');
  END IF;

  SELECT count(*) INTO hits
  FROM measurement_book_lines mbl
  JOIN measurement_books mb ON mb.id = mbl.measurement_book_id
  WHERE mbl.work_item_id = NEW.id
    AND mb.status <> 'cancelled'
    AND (
      mbl.delta_supplied <> 0 OR mbl.delta_installed <> 0
      OR mbl.delta_pac <> 0 OR mbl.delta_final_bill <> 0
      OR mbl.prior_supplied <> 0 OR mbl.prior_installed <> 0
      OR mbl.prior_pac <> 0 OR mbl.prior_final_bill <> 0
    );
  IF hits > 0 THEN
    evidence := evidence || ('Measurement Book lines (' || hits::text || ')');
  END IF;

  IF array_length(evidence, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'item % carries evidence and cannot be omitted: %',
      NEW.item_number, array_to_string(evidence, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM approval_requests ar
    JOIN amendment_variation_orders avo
      ON avo.organisation_id = ar.organisation_id
     AND avo.approval_request_id = ar.id
    WHERE ar.organisation_id = NEW.organisation_id
      AND ar.entity_type = 'work_item_amendment'
      AND ar.entity_id = NEW.id
      AND ar.proposed->>'kind' = 'remove_item'
      AND ar.status IN ('pending', 'approved')
      AND avo.verified
  ) THEN
    RAISE EXCEPTION
      'item % cannot be omitted without an approved amendment citing a verified railway variation order',
      NEW.item_number
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;
