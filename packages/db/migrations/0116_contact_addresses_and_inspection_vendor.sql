SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0116: a contact keeps more than one address, and an
-- inspection call names the vendor whose premises it is held at.
--
-- TWO CHANGES, AND WHY THEY ARE ONE MIGRATION.
--
-- The owner's ruling on the inspection clause tab asked for a structured
-- inspection vendor: pick the vendor, then pick WHICH OF ITS PREMISES the
-- agency is being sent to. A vendor with one address does not need that
-- screen. Every vendor in the corpus that matters — the ones with a works
-- at one town and an office at another — has two or three, and the
-- contacts master could hold exactly one. So the address list is not a
-- separate nicety that happened to land in the same wave; it is the
-- prerequisite the vendor picker is built on, and splitting them would
-- ship a picker with nothing to pick from.
--
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * No new address columns on any issued document. A challan's
--     consignee and an invoice's buyer are already snapshots — free text
--     on the challan, jsonb on the invoice — and choosing WHICH address
--     to copy changes what is copied, not where it is stored. An issued
--     record that already carries the text it printed needs nothing from
--     this migration, and rule 7 is best served by not touching it.
--   * No DELETE on the address list. An address is retired like every
--     other master row, because a document may have copied it and the
--     register has to be able to explain where that text came from.
--   * No second "primary" concept. `contacts.address` does not become
--     legacy and it does not become a rival: the trigger below keeps it
--     equal to the primary address row, so every reader that already
--     joins `contacts` for an address — the e-way bill's state code, the
--     invoice buyer snapshot, the purchase order's vendor block, the
--     duplicate-designation index — keeps working, unchanged, and now
--     means "the contact's primary address" precisely.

-- ---------------------------------------------------------------------
-- 1. The address list.
--
-- A child of `contacts`, org-scoped and RLS'd like every tenant table.
-- The four address fields are the four `contacts` already carries, with
-- the same CHECKs, because they are the same fields moved down a level
-- and a looser copy would let a row into the child that the parent
-- mirror could not hold.
-- ---------------------------------------------------------------------
CREATE TABLE contact_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  contact_id uuid NOT NULL,

  -- What the operator calls this place: "Works, Hosur", "Regd. office".
  -- Optional, because the first address of a one-address contact needs no
  -- name to be unambiguous, and the backfill below has none to give it.
  label text CHECK (
    label IS NULL
    OR (btrim(label) = label AND length(label) BETWEEN 1 AND 100)
  ),

  address text NOT NULL CHECK (length(btrim(address)) BETWEEN 3 AND 1000),
  pincode text CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
  locality text CHECK (locality IS NULL OR length(btrim(locality)) BETWEEN 2 AND 100),
  state_code text CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),

  -- The one a picker offers first, and the one mirrored onto `contacts`.
  is_primary boolean NOT NULL DEFAULT false,
  -- Display order among the rest, so the list reads the way the operator
  -- arranged it rather than by insertion accident.
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  active boolean NOT NULL DEFAULT true,

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- Three columns, so a record naming BOTH a contact and one of its
  -- addresses proves in the database that the address really belongs to
  -- that contact. Without it the inspection call below could cite vendor
  -- A and vendor B's premises, and no screen would notice.
  --
  -- The CONTACT comes before the id, and that order is load-bearing
  -- rather than aesthetic: it makes this index lead with
  -- (organisation_id, contact_id), so it covers the parent foreign key
  -- below AND every citing key that names the vendor first — one index
  -- for three keys, which is what the FK-coverage census asks for.
  UNIQUE (organisation_id, contact_id, id),
  FOREIGN KEY (organisation_id, contact_id) REFERENCES contacts(organisation_id, id),

  -- A retired address is not anybody's primary. The mirror below reads
  -- the primary row and writes it onto `contacts`; if a retired row could
  -- stay primary, retiring it would leave the contact advertising an
  -- address its own list says is out of use. Retiring the primary is
  -- therefore two facts in one statement — not primary, not active — and
  -- the route promotes the next address as it does so.
  CONSTRAINT contact_addresses_retired_is_never_primary_check CHECK (
    active OR NOT is_primary
  )
);

COMMENT ON TABLE contact_addresses IS
  'The addresses one contact keeps. The primary row is mirrored onto contacts(address, pincode, locality, state_code) by trigger, so every existing reader of those columns means "the primary address" without being changed.';
COMMENT ON COLUMN contact_addresses.is_primary IS
  'At most one per contact (partial unique index), never a retired row (CHECK), and the one the mirror trigger writes onto contacts.';

-- At most one primary per contact. Partial, because the interesting
-- uniqueness is among the trues.
CREATE UNIQUE INDEX contact_addresses_one_primary
  ON contact_addresses (organisation_id, contact_id)
  WHERE is_primary;

-- No second index for the list read. The unique constraint above already
-- leads with (organisation_id, contact_id), which is the only lookup this
-- table gets; the handful of rows it returns are then ordered in memory,
-- and an index over `sort_order` would be a second thing to maintain for
-- a sort of three rows.

-- ---------------------------------------------------------------------
-- 2. The backfill: the one address each contact already had becomes its
-- first and primary one.
--
-- Before RLS is enabled, like 0028's own copy, so the migration runs for
-- a non-superuser owner role too. `contacts.address` carries a CHECK of
-- exactly the same shape, so no row can fail the child's.
-- ---------------------------------------------------------------------
INSERT INTO contact_addresses (
  organisation_id, contact_id, address, pincode, locality, state_code,
  is_primary, sort_order, active, created_by_user_id, created_at, updated_at
)
SELECT organisation_id, id, address, pincode, locality, state_code,
       true, 0, true, created_by_user_id, created_at, updated_at
FROM contacts
WHERE address IS NOT NULL;

ALTER TABLE contact_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_addresses FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the
-- planner treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY contact_addresses_tenant_policy ON contact_addresses
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE, exactly like the parent (0013/0028 posture): a document may
-- have copied this address, and the register has to keep being able to
-- say where that text came from. Addresses retire.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON contact_addresses TO auto_mb_app;
  END IF;
END
$$;

CREATE TRIGGER contact_addresses_touch_updated_at
BEFORE UPDATE ON contact_addresses
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. The mirror.
--
-- `contacts.address`, `.pincode`, `.locality` and `.state_code` are read
-- by the invoice buyer snapshot, the ship-to completeness gate, the
-- purchase order's vendor block, the quotation's customer block, the
-- e-way bill's state code, the payment beneficiary block and the
-- duplicate-designation unique index. Rewriting all of them to join a
-- child table would be seven edits for one fact, and the v1 importer
-- writing through the 0028 compatibility view would still not know.
--
-- So the child is authoritative and the parent is kept equal to it. The
-- mirror runs AFTER the write, statement-ordered, and recomputes the four
-- columns from whichever row is primary now — which is also correct when
-- the primary moves, because the clearing statement and the setting
-- statement each re-derive the same answer from the table's state at the
-- time they run.
--
-- It writes only when the answer CHANGES, so an ordinary edit of a
-- non-primary address touches nothing and cannot trip the parent's
-- duplicate-designation index.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.mirror_contact_primary_address()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  subject uuid;
  org uuid;
BEGIN
  subject := NEW.contact_id;
  org := NEW.organisation_id;

  UPDATE contacts c
  SET address = primary_row.address,
      pincode = primary_row.pincode,
      locality = primary_row.locality,
      state_code = primary_row.state_code
  FROM (
    SELECT a.address, a.pincode, a.locality, a.state_code
    FROM contact_addresses a
    WHERE a.organisation_id = org AND a.contact_id = subject AND a.is_primary
    UNION ALL
    -- No primary row at all: the contact has no address, and the parent
    -- must say so rather than keep the last one it happened to hold.
    SELECT NULL::text, NULL::text, NULL::text, NULL::text
    WHERE NOT EXISTS (
      SELECT 1 FROM contact_addresses a
      WHERE a.organisation_id = org AND a.contact_id = subject AND a.is_primary
    )
  ) AS primary_row
  WHERE c.organisation_id = org
    AND c.id = subject
    AND (c.address, c.pincode, c.locality, c.state_code)
        IS DISTINCT FROM
        (primary_row.address, primary_row.pincode, primary_row.locality,
         primary_row.state_code);

  RETURN NULL;
END
$$;

COMMENT ON FUNCTION app_private.mirror_contact_primary_address() IS
  'Keeps contacts(address, pincode, locality, state_code) equal to the contact''s primary address row, so every existing reader of those columns means the primary address without being rewritten.';

CREATE TRIGGER contact_addresses_mirror_primary
AFTER INSERT OR UPDATE ON contact_addresses
FOR EACH ROW EXECUTE FUNCTION app_private.mirror_contact_primary_address();

-- ---------------------------------------------------------------------
-- 4. The inspection vendor, on the clause and on the call.
--
-- 0082 made the premises free text and said why: "half of them are
-- sub-vendors this organisation has no master row for". That reasoning
-- survives — the free text stays, and it is what a premises with no
-- master row is still recorded as. What it did not anticipate is the
-- ordinary case, where the vendor IS in the contacts master and the
-- operator retypes its address onto every clause, differently each time,
-- until the placing request goes to the wrong works.
--
-- So both records gain the structured pair, and the pair and the free
-- text are alternatives rather than companions:
--
--   clause  configuration. Names the vendor and one of its addresses, OR
--           carries free text. Reading it joins the address live, because
--           a clause is not a document and an address corrected in the
--           master should reach the next call.
--   call    a record. Copies the vendor's NAME and the ADDRESS TEXT at
--           the moment it is raised, and keeps the ids beside them as
--           provenance. Renaming or retiring the master afterwards
--           changes nothing the agency was sent.
-- ---------------------------------------------------------------------

ALTER TABLE inspection_clauses
  ADD COLUMN vendor_contact_id uuid,
  ADD COLUMN vendor_address_id uuid;

ALTER TABLE inspection_clauses
  ADD CONSTRAINT inspection_clauses_vendor_contact_fkey
    FOREIGN KEY (organisation_id, vendor_contact_id)
    REFERENCES contacts(organisation_id, id),
  -- Three columns: the address must belong to the vendor named. A
  -- MATCH SIMPLE foreign key is not enforced while any of its columns is
  -- NULL, which is why the CHECK below makes the contact mandatory
  -- whenever the address is present — without it the pair could be
  -- half-stated and the key would never fire.
  ADD CONSTRAINT inspection_clauses_vendor_address_fkey
    FOREIGN KEY (organisation_id, vendor_contact_id, vendor_address_id)
    REFERENCES contact_addresses(organisation_id, contact_id, id),
  ADD CONSTRAINT inspection_clauses_vendor_address_needs_contact_check CHECK (
    vendor_address_id IS NULL OR vendor_contact_id IS NOT NULL
  ),
  -- One answer to "where is this inspected". A clause holding both a
  -- saved address and free text would make the placing request pick, and
  -- whichever it picked the other would be a standing contradiction on
  -- the screen.
  ADD CONSTRAINT inspection_clauses_one_premises_check CHECK (
    vendor_address_id IS NULL OR vendor_premises IS NULL
  );

CREATE INDEX inspection_clauses_vendor_idx
  ON inspection_clauses (organisation_id, vendor_contact_id, vendor_address_id);

COMMENT ON COLUMN inspection_clauses.vendor_contact_id IS
  'The vendor-role contact whose premises this item is inspected at. Joined live: a clause is configuration, not a document.';
COMMENT ON COLUMN inspection_clauses.vendor_premises IS
  'Free-text premises, for a sub-vendor with no master row. Mutually exclusive with vendor_address_id (see the CHECK).';

ALTER TABLE inspection_calls
  ADD COLUMN vendor_contact_id uuid,
  ADD COLUMN vendor_address_id uuid,
  -- The vendor's name as it stood when the call was raised. A snapshot
  -- for the same reason the PAC certificate snapshots the consignee
  -- designation: the placing request printed this name, and renaming the
  -- master afterwards must not rewrite what was sent.
  ADD COLUMN vendor_name text CHECK (
    vendor_name IS NULL
    OR (btrim(vendor_name) = vendor_name AND length(vendor_name) BETWEEN 1 AND 200)
  );

-- The premises text on a CALL is now a snapshot of a master address as
-- well as a free-text field, and a master address runs to a thousand
-- characters. 0082's 200 was the width of a typed premises name; the
-- bound is widened to the parent column's own, not removed.
ALTER TABLE inspection_calls
  DROP CONSTRAINT inspection_calls_vendor_premises_check;
ALTER TABLE inspection_calls
  ADD CONSTRAINT inspection_calls_vendor_premises_check CHECK (
    vendor_premises IS NULL
    OR (btrim(vendor_premises) = vendor_premises
        AND length(vendor_premises) BETWEEN 1 AND 1000)
  );

ALTER TABLE inspection_calls
  ADD CONSTRAINT inspection_calls_vendor_contact_fkey
    FOREIGN KEY (organisation_id, vendor_contact_id)
    REFERENCES contacts(organisation_id, id),
  ADD CONSTRAINT inspection_calls_vendor_address_fkey
    FOREIGN KEY (organisation_id, vendor_contact_id, vendor_address_id)
    REFERENCES contact_addresses(organisation_id, contact_id, id),
  ADD CONSTRAINT inspection_calls_vendor_address_needs_contact_check CHECK (
    vendor_address_id IS NULL OR vendor_contact_id IS NOT NULL
  ),
  -- The snapshot is the point. A call citing a master address with no
  -- copied text would have to re-read the master to say where it went,
  -- which is the thing the snapshot exists to stop.
  ADD CONSTRAINT inspection_calls_vendor_snapshot_check CHECK (
    vendor_contact_id IS NULL
    OR (vendor_name IS NOT NULL AND vendor_premises IS NOT NULL)
  );

CREATE INDEX inspection_calls_vendor_idx
  ON inspection_calls (organisation_id, vendor_contact_id, vendor_address_id);

COMMENT ON COLUMN inspection_calls.vendor_name IS
  'The vendor''s designation copied at the moment the call was raised. Snapshot, not a join: the placing request printed this.';
COMMENT ON COLUMN inspection_calls.vendor_premises IS
  'Where the agency was sent, as text, always. Copied from the chosen master address when there is one, typed when there is not.';

-- ---------------------------------------------------------------------
-- 5. The one rule the columns cannot state.
--
-- A foreign key proves the address belongs to the contact. It cannot
-- prove that the contact is a VENDOR — and a clause pointing the agency
-- at a consignee's goods shed, or at a client's registered office, is a
-- placing request that will be refused at the gate. The masters route
-- refuses it first, in a sentence; this is the layer that holds when a
-- writer reaches the table another way (the 0028 work-consignee guard's
-- own shape, and its reasoning about an invisible row: with no tenant
-- bound the lookup yields NULL and the write is refused rather than
-- waved through).
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_inspection_vendor_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_is_vendor boolean;
BEGIN
  IF NEW.vendor_contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.is_vendor INTO v_is_vendor
  FROM contacts c
  WHERE c.organisation_id = NEW.organisation_id AND c.id = NEW.vendor_contact_id;

  IF v_is_vendor IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'an inspection vendor must be a vendor-role contact'
      USING ERRCODE = '23Y01';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_inspection_vendor_role() IS
  'The inspection vendor named by a clause or a call must carry the vendor role. Raised as 23Y01 by both triggers, because for an operator it is one refusal.';

CREATE TRIGGER inspection_clauses_guard_vendor_role
BEFORE INSERT OR UPDATE ON inspection_clauses
FOR EACH ROW EXECUTE FUNCTION app_private.guard_inspection_vendor_role();

CREATE TRIGGER inspection_calls_guard_vendor_role
BEFORE INSERT OR UPDATE ON inspection_calls
FOR EACH ROW EXECUTE FUNCTION app_private.guard_inspection_vendor_role();
