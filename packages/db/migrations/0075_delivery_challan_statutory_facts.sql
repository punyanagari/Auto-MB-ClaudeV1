-- Migration 0075: the Delivery Challan learns its stage-3b statutory facts.
--
-- 0056 built the module and said so plainly: "Statutory facts (HSN,
-- movement reason, party GSTIN) and e-way bills are stage 3b and
-- deliberately absent here." ADR-0013 is the ruling that makes stage 3b
-- due. A standalone Delivery Challan carries goods to a private customer,
-- a vendor or a job worker; above the value threshold that movement needs
-- an e-way bill, and NIC will not issue one without the item facts (its
-- own error 4009: "E Way Bill can be generated provided at least HSN of
-- one item belongs to goods", observed live in the 12 August sandbox
-- certification).
--
-- Two additions, both nullable, both zero-backfill:
--
--   (a) per line, the HSN/SAC code and the goods/service marker, in the
--       SAME shape 0057 gave tax_invoice_lines — including its CHECK
--       pairing code length to kind, so one rule reads identically on
--       both documents;
--   (b) per challan, the movement reason in NIC's vocabulary, the
--       consignee's GSTIN where the party has one, and the transport
--       block, reusing the shapes 0035 proved on eway_bills.
--
-- Optional everywhere. A work challan may carry the same facts and most
-- will not; they become MANDATORY only on the path that raises an e-way
-- bill, which is a route-level rule about one transition and not a
-- property of the table. Existing rows therefore need no backfill and no
-- default beyond NULL.
--
-- Where the transport facts are authoritative: the Delivery Challan is
-- the paper that travels WITH the goods, so the transport particulars
-- belong on it in their own right, independent of any e-way bill. The
-- eway_bills row keeps its own transport columns and remains the single
-- source for what goes on the NIC wire (0035's carriage CHECK measures
-- those, not these); the challan's block is the recorded fact and the
-- prefill the draft opens with. Two records of one movement, each
-- answerable to its own authority, neither reading the other at write
-- time.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- 1. delivery_challan_items: the goods/service marker and its code.
-- ---------------------------------------------------------------------

-- Stated rather than inferred from the code's length, exactly as 0057
-- argued for tax_invoice_lines: it decides whether this line moves GOODS,
-- and that single question is what ADR-0013 keys e-way-bill applicability
-- on. A line that has not been classified yet leaves both NULL.
ALTER TABLE delivery_challan_items ADD COLUMN is_service boolean;

ALTER TABLE delivery_challan_items
  ADD COLUMN hsn_sac_code text
    CHECK (hsn_sac_code IS NULL OR hsn_sac_code ~ '^[0-9]{6,8}$');

-- 0057's tax_invoice_lines_code_shape, with one branch added for the
-- unclassified line this table (unlike an itemised invoice's) may hold:
-- a service line is a SAC and a SAC is six digits; a goods line is an HSN
-- and may be deepened to eight. The two columns arrive together or not at
-- all, so "classified" is never a half state a reader has to interpret.
--
-- The both-or-neither rule is stated as its own equality rather than folded
-- into the OR chain. A three-valued disjunction like
--   (hsn IS NULL AND is_service IS NULL)
--   OR (is_service AND hsn ~ ...) OR (NOT is_service AND hsn ~ ...)
-- evaluates to NULL — not FALSE — on a HALF-classified line (hsn set,
-- is_service NULL: false OR NULL OR NULL = NULL), and a CHECK passes on
-- NULL. That let a half-state into the table, which readChallanSourceFacts
-- then silently filters out of the NIC declaration — an understated
-- consignment. `(a IS NULL) = (b IS NULL)` is FALSE (never NULL) when
-- exactly one is null, so the half-state is refused at the database.
ALTER TABLE delivery_challan_items
  ADD CONSTRAINT delivery_challan_items_code_shape CHECK (
    (hsn_sac_code IS NULL) = (is_service IS NULL)
    AND (
      hsn_sac_code IS NULL
      OR (is_service AND hsn_sac_code ~ '^[0-9]{6}$')
      OR (NOT is_service AND hsn_sac_code ~ '^[0-9]{6,8}$')
    )
  );

-- The applicability rule's read: "does this challan carry at least one
-- goods line". Partial on the goods marker so the index holds only the
-- rows the question is ever asked about.
CREATE INDEX delivery_challan_items_goods_idx
  ON delivery_challan_items (organisation_id, delivery_challan_id)
  WHERE is_service = false;

COMMENT ON COLUMN delivery_challan_items.is_service IS
  'Whether this line supplies a SERVICE (SAC, six digits) or GOODS (HSN, '
  'six to eight), or NULL where the line carries no statutory '
  'classification. Stated, not inferred; at least one goods line is what '
  'makes the challan an e-way bill source (ADR-0013).';

-- ---------------------------------------------------------------------
-- 2. delivery_challans: movement reason, consignee GSTIN, transport.
-- ---------------------------------------------------------------------

-- NIC's own vocabulary for why the goods are moving, stored in the
-- product's snake_case and mapped to the portal's wording by the payload
-- builder. Restricting the set here means an unknown reason cannot reach
-- the wire and come back as an opaque provider rejection.
ALTER TABLE delivery_challans
  ADD COLUMN movement_reason text
    CHECK (
      movement_reason IS NULL
      OR movement_reason IN ('supply', 'job_work', 'for_own_use', 'others')
    );

-- The consignee's GSTIN, frozen onto the document like the rest of the
-- consignee block. 0028 keeps the party's current GSTIN on the contacts
-- master and rule 7 forbids reading master data back through history, so
-- the fact the challan was issued with lives here. Same two-branch shape
-- the contacts master uses: a regular GSTIN, or a UIN/non-resident
-- registration ending in D. An unregistered consignee simply has none.
ALTER TABLE delivery_challans
  ADD COLUMN consignee_gstin text
    CHECK (
      consignee_gstin IS NULL
      OR consignee_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
      OR consignee_gstin ~ '^[0-9]{2}[0-9A-Z]{12}D$'
    );

-- The transport block, shapes taken verbatim from 0035's eway_bills so
-- one movement is never described two incompatible ways.
ALTER TABLE delivery_challans
  ADD COLUMN transporter_id text
    CHECK (transporter_id IS NULL OR transporter_id ~ '^[0-9]{2}[0-9A-Z]{13}$');

ALTER TABLE delivery_challans
  ADD COLUMN transporter_name text
    CHECK (
      transporter_name IS NULL
      OR length(btrim(transporter_name)) BETWEEN 2 AND 200
    );

ALTER TABLE delivery_challans
  ADD COLUMN vehicle_number text
    CHECK (vehicle_number IS NULL OR vehicle_number ~ '^[A-Z0-9]{6,12}$');

ALTER TABLE delivery_challans
  ADD COLUMN transport_doc_number text
    CHECK (
      transport_doc_number IS NULL
      OR length(btrim(transport_doc_number)) BETWEEN 1 AND 30
    );

ALTER TABLE delivery_challans ADD COLUMN transport_doc_date date;

ALTER TABLE delivery_challans
  ADD COLUMN transport_distance_km integer
    CHECK (
      transport_distance_km IS NULL
      OR (transport_distance_km >= 0 AND transport_distance_km <= 4000)
    );

-- A transport document is a number and a date together: half of one is
-- not a reference anybody can follow back to a carrier.
ALTER TABLE delivery_challans
  ADD CONSTRAINT delivery_challans_transport_doc_shape CHECK (
    (transport_doc_number IS NULL) = (transport_doc_date IS NULL)
  );

COMMENT ON COLUMN delivery_challans.movement_reason IS
  'Why the goods move, in NIC''s e-way bill vocabulary: supply, job work, '
  'for own use, or others. Optional on the document; required before an '
  'e-way bill can be raised from it (ADR-0013).';
COMMENT ON COLUMN delivery_challans.consignee_gstin IS
  'The consignee''s GSTIN as it stood when this challan was drafted, '
  'frozen onto the document. NULL where the party is unregistered.';

-- ---------------------------------------------------------------------
-- 3. The new facts are issued-document business data.
--
-- They are entered on the DRAFT and frozen at issue, like every other
-- fact the consignee is handed. That is what lets the e-way bill path
-- trust them: it reads an ISSUED challan, and an issued challan's facts
-- cannot move under it afterwards.
--
-- The body below is 0056's VERBATIM — which is 0032's, which is 0031's,
-- which restated 0018's, which restated 0001's — plus the eight new header
-- columns (movement_reason, consignee_gstin, and the six-field transport
-- block) in the issued-immutability row comparison. Nothing is dropped:
-- the kind clause (0056), the warranty columns (0018), the
-- final-Measurement-Book and completed-Work issue refusals (0031) and
-- the completed-Work cancel refusal (0032) all survive intact.
--
-- The LINE facts need no equivalent: delivery_challan_items_guard_mutation
-- (0001) already refuses every write to a line whose challan is not a
-- draft, so hsn_sac_code and is_service are frozen the moment the challan
-- is issued, by a rule that was already there.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.guard_delivery_challan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled Delivery Challans are immutable';
  END IF;

  IF NEW.challan_kind IS DISTINCT FROM OLD.challan_kind THEN
    RAISE EXCEPTION 'a Delivery Challan''s kind is fixed when it is created';
  END IF;

  IF OLD.status = 'issued' THEN
    IF NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION 'issued Delivery Challans may only remain issued or be cancelled';
    END IF;

    IF ROW(
      NEW.organisation_id, NEW.work_id, NEW.challan_date, NEW.challan_number,
      NEW.sequence_number, NEW.prefix, NEW.consignee_snapshot, NEW.issued_snapshot,
      NEW.template_version, NEW.warranty_template_version, NEW.warranty_text_sha256,
      NEW.created_by_user_id, NEW.issued_by_user_id, NEW.issued_at,
      NEW.challan_kind, NEW.consignee_contact_id, NEW.fy_label,
      NEW.movement_reason, NEW.consignee_gstin, NEW.transporter_id,
      NEW.transporter_name, NEW.vehicle_number, NEW.transport_doc_number,
      NEW.transport_doc_date, NEW.transport_distance_km
    ) IS DISTINCT FROM ROW(
      OLD.organisation_id, OLD.work_id, OLD.challan_date, OLD.challan_number,
      OLD.sequence_number, OLD.prefix, OLD.consignee_snapshot, OLD.issued_snapshot,
      OLD.template_version, OLD.warranty_template_version, OLD.warranty_text_sha256,
      OLD.created_by_user_id, OLD.issued_by_user_id, OLD.issued_at,
      OLD.challan_kind, OLD.consignee_contact_id, OLD.fy_label,
      OLD.movement_reason, OLD.consignee_gstin, OLD.transporter_id,
      OLD.transporter_name, OLD.vehicle_number, OLD.transport_doc_number,
      OLD.transport_doc_date, OLD.transport_distance_km
    ) THEN
      RAISE EXCEPTION 'issued Delivery Challan business data is immutable';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'draft Delivery Challans are deleted, not cancelled';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'issued' AND NEW.work_id IS NOT NULL THEN
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
  IF OLD.status <> 'cancelled' AND NEW.status = 'cancelled'
     AND NEW.work_id IS NOT NULL THEN
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

-- ---------------------------------------------------------------------
-- 4. The RLS posture 0003 asserts at catalog level still holds.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  unprotected_count integer;
BEGIN
  SELECT count(*) INTO unprotected_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname <> 'schema_migrations'
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected_count > 0 THEN
    RAISE EXCEPTION
      'every public table except schema_migrations must have RLS enabled and forced';
  END IF;
END
$$;
