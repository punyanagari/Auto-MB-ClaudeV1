SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0084: OEM production — the item master the agency
-- manufactures against, its recursive bill of material, the job card that
-- turns a contract line into physical units, the serial genealogy of
-- those units, and the despatch that hands them to stock.
--
-- Everything up to here models a contract the agency EXECUTES: a letter
-- arrives, material is delivered, quantities are measured, money is
-- billed. This migration models the half before that, which the product
-- has never held: the agency is an OEM, it BUILDS what it delivers, and
-- between the LOA and the Delivery Challan there is a factory whose
-- output has to be accounted for unit by unit. The mock draws it at
-- `app/production/page.tsx`, `app/production/items/page.tsx` and
-- `components/production-job-card-page.tsx` (fdfe5ef).
--
-- TEN TABLES, AND WHY EACH EXISTS.
--
--   production_items              the OEM item master: what is made and
--                                 what is bought to make it
--   production_bom_lines          one parent-component edge; recursive,
--                                 and cycle-refused here rather than in
--                                 application code
--   production_job_cards          one production order
--   production_job_card_counters  per-organisation, per-financial-year
--                                 job numbering
--   production_serials            one physical finished unit
--   production_serial_counters    per-item finished-serial numbering
--   production_component_serials  which component serial went into which
--                                 finished unit — the genealogy
--   production_dispatches         the handoff: finished units leave
--                                 production and become stock
--   production_dispatch_counters  per-job-card despatch numbering
--   production_dispatch_serials   which units a despatch released
--
-- ---------------------------------------------------------------------
-- WHY NOT `canonical_items` (migration 0078).
--
-- The coordinating brief asked this question first, and the answer is a
-- SEPARATE table, deliberately. `canonical_items` is not an item master
-- that happens to lack a few columns; it is a different kind of record.
--
--   * Its identity is a WORDING. Its own comment says so — it exists to
--     say that "Ahuja UHC-30 XT horn speaker" and "30 watt outdoor horn
--     speaker" are the same thing, and its unique index is on
--     `lower(btrim(name))`. A production item's identity is a PART
--     NUMBER (`PEB-IPDB-6L`), which is exactly what the mock's OEM
--     catalogue puts first and what the Masters items table does not
--     show at all. Two masters keyed on two different things are two
--     masters.
--
--   * It is deliberately not an FK target. 0078 records the decision:
--     there is no `work_items.canonical_item_id`, the mapping is DERIVED
--     by matching descriptions, and a nullable key with no writer is
--     dead flexibility. Nothing in the schema references it today.
--     Making it the anchor of a BOM edge and a serial series would
--     reverse that decision by a side door, and would put a retire guard
--     on a masters screen that has never needed one.
--
--   * `default_unit` is documented there as "a suggestion for a form
--     default, not a value any document is validated against". A BOM
--     quantity is validated against its unit. The same column cannot be
--     both.
--
-- The two are RELATED, and the relation is a mapping, not an identity:
-- the mock draws it as its own card ("OEM production mapping",
-- `components/work-controls.tsx`), which is a Work-workspace feature this
-- pack does not build. So there is deliberately NO `canonical_item_id`
-- column here either. It would be 0078's dead nullable key a second
-- time — nothing in these three screens reads it, and nothing writes it.
-- When the mapping card is built, the column it needs is one statement,
-- and it will arrive with the writer that earns it.
--
-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * No material shortage. The mock's Production register badges "2277
--     units short" and its job card refuses to build while short. Both
--     read `stockItems.onHand`, which is the INVENTORY pack's table and
--     does not exist yet. A shortage column computed against no stock
--     ledger would read zero for everything and would be a lie the
--     moment stock arrived. What this migration holds is the BOM
--     requirement — real, computable, and the left-hand side of the
--     subtraction Inventory completes. `docs/UX.md` § 11 records it.
--
--   * No stored `material-short` / `material-ready` / `dispatch-ready`
--     status. The mock's own fixture proves why: its `status` field
--     disagrees with its own derived shortage on two of three plans, so
--     the "Ready" badge branch is dead code and every job card renders
--     "Material blocked". A stored copy of a computed fact is a field
--     that can disagree with the fact. The lifecycle stored below is the
--     part an operator DECIDES; readiness is derived on read.
--
--   * No `type` column on a BOM line. The mock's `BomNode.type` is
--     'raw' | 'sub-assembly', which is precisely "has children or does
--     not". It is rendered, not decided, so it is computed.
--
--   * No per-line unit or per-line serial flag. The mock puts `unit` and
--     `serialControlled` on the BOM NODE, so the same bolt could be Nos
--     in one assembly and Kg in another, and serialised in one place and
--     not in another. Both are facts about the PART. They live on
--     `production_items` and the BOM line renders them.
--
--   * No new number series. Job cards and despatches are numbered by the
--     counters below, not through `apps/server/src/number-series.ts`,
--     for the reason 0080 and 0082 both give: that module configures the
--     operator-visible formats of ISSUED STATUTORY documents, and a
--     works order is internal.
--
--   * No despatch-to-challan link. The mock's job card draws a "Create
--     delivery challan" button; wiring it would make production write
--     into the statutory challan series, which is the highest-risk
--     surface in the product, from a screen whose own quantities are not
--     yet reconciled against stock. The boundary this migration defines
--     (§ 7) is the seam a later pack crosses.
--
-- ---------------------------------------------------------------------
-- NUMBERING OF THE MIGRATION ITSELF. 0084 is allocated by the wave
-- coordinator; 0081 is permanently empty and 0085 is this pack's unused
-- buffer. The series is allocated, not contiguous, and has been since
-- 0066: a gap is the cheap outcome, two packs writing one number is the
-- expensive one, and a renumber after a migration has been applied
-- anywhere is refused by the runner's checksum.
--
-- ---------------------------------------------------------------------
-- NAMED SQLSTATES. Every RAISE below carries a code from the 23D block,
-- which this migration is the first to use, so a guard that fires
-- because a writer reached the table by another path surfaces as the
-- same 409 the route would have raised rather than an unexplained 500.
-- `apps/server/src/routes/production.ts` maps every one of them.
--
--   Item master and bill of material
--     23D01  the edge would close a cycle in the bill of material
--     23D02  the edge's parent or component is not a legal end of one
--     23D03  the item master row cannot change this way
--     23D04  the item master row is still referenced and cannot be retired
--
--   Job cards, serials and despatch
--     23D11  the job card cannot move between these two states
--     23D12  the job card is finished and cannot be edited
--     23D13  the job card cannot complete: units are still outstanding
--     23D14  the finished serial cannot be written this way
--     23D15  the component serial cannot be consumed into this unit
--     23D16  the despatch cannot release these units
--     23D17  the organisation's own today cannot be resolved
--
-- ---------------------------------------------------------------------
-- LOCK ORDER. `routes/inspections.ts` declares the product's ordering as
-- works -> work_items -> inspection_calls. Production extends it to the
-- right: works -> work_items -> production_job_cards -> production_serials.
-- The BOM guard takes an advisory lock that no other module holds, named
-- at § 2. No path here takes a Work lock after a job-card lock, so no
-- cycle is introduced.

-- ---------------------------------------------------------------------
-- 0. Shared reading helpers.
--
-- A CHECK constraint may not contain a subquery, and the specification
-- list below needs one to walk its own elements. An IMMUTABLE function
-- is the standing way round that, and it also gives the rule a name the
-- route's refusal message can point at.
-- ---------------------------------------------------------------------

-- `SET search_path` for the reason 0067, 0077 and 0079 all give: a
-- function that resolves its own identifiers through the caller's path
-- is a rule a shadowing object in a writable schema can rewrite into
-- whatever it likes. Every function in this migration pins it, and none
-- is SECURITY DEFINER.
CREATE FUNCTION app_private.production_specifications_valid(specifications jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_typeof(specifications) = 'array'
     AND jsonb_array_length(specifications) <= 50
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(specifications) AS spec
       WHERE jsonb_typeof(spec.value) <> 'object'
          OR jsonb_typeof(spec.value -> 'attribute') <> 'string'
          OR jsonb_typeof(spec.value -> 'value') <> 'string'
          OR btrim(spec.value ->> 'attribute') <> (spec.value ->> 'attribute')
          OR btrim(spec.value ->> 'value') <> (spec.value ->> 'value')
          OR spec.value ->> 'attribute' = ''
          OR spec.value ->> 'value' = ''
          OR length(spec.value ->> 'attribute') > 100
          OR length(spec.value ->> 'value') > 200
     )
$$;

COMMENT ON FUNCTION app_private.production_specifications_valid(jsonb) IS
  'Whether a production item''s specification list is a bounded array of trimmed, non-empty attribute/value string pairs. A function because a CHECK constraint may not contain the subquery this needs.';

-- ---------------------------------------------------------------------
-- 1. The OEM item master.
--
-- One table for everything the factory names: the products the agency
-- sells AND the parts it buys to build them. They are one table because
-- a BOM edge joins them to each other and a sub-assembly is both — the
-- mock's own `BomNode.type` admits this by having a 'sub-assembly'
-- value, and a schema with a products table and a separate materials
-- table cannot express an edge from one to the other without a
-- polymorphic key.
--
-- `manufactured` is the discriminator and it is stored rather than
-- derived from "has BOM lines". Derived, the OEM catalogue would gain
-- and lose entries as somebody edited a bill of material, and a job card
-- for an item whose last BOM line was deleted would become
-- retrospectively illegal. It is a decision, so it is a column.
--
-- A MANUFACTURED ITEM IS ALWAYS SERIALISED. The CHECK below binds
-- `manufactured` to a serial prefix and to serial control, because every
-- OEM item the mock draws carries a serial series and because the whole
-- point of the module is that a unit the agency made can be named. An
-- unserialised manufactured item — bulk cable, say — would need this
-- relaxed, and relaxing it is one statement; shipping it loose now would
-- mean job cards that complete without producing anything nameable.
-- ---------------------------------------------------------------------
CREATE TABLE production_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- The part number an operator says out loud. Uppercase-insensitive
  -- unique per organisation; the index below is on the folded value.
  item_code text NOT NULL CHECK (
    btrim(item_code) = item_code
    AND length(item_code) BETWEEN 2 AND 40
  ),
  name text NOT NULL CHECK (
    btrim(name) = name
    AND length(name) BETWEEN 2 AND 200
  ),
  -- The mock renders this as a plain Badge, not a foreign key, for the
  -- reason 0078 gives about its own group label: the distinct values are
  -- the list, and a second master screen buys nothing.
  category text NOT NULL CHECK (
    btrim(category) = category
    AND length(category) BETWEEN 2 AND 100
  ),
  -- The unit this part is counted in, everywhere it appears. See the
  -- header for why it is not on the BOM line.
  unit text NOT NULL CHECK (
    btrim(unit) = unit
    AND length(unit) BETWEEN 1 AND 20
  ),

  manufactured boolean NOT NULL DEFAULT false,

  -- The finished-serial series, e.g. 'IPDB6' -> IPDB6-00129. Frozen once
  -- the first unit is minted (guard below): moving it would leave two
  -- prefixes inside one series and no way to tell which unit is which.
  serial_prefix text CHECK (
    serial_prefix IS NULL OR serial_prefix ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'
  ),
  -- Whether this part's serials are captured when it is CONSUMED as a
  -- component. Distinct from having a prefix of its own: a bought-in
  -- controller card carries the supplier's serials, which are scanned,
  -- not minted.
  serial_controlled boolean NOT NULL DEFAULT false,

  -- User-named attribute/value pairs, exactly as the mock's
  -- Specifications card collects them ("Attribute names are created by
  -- users"). A jsonb array rather than a child table for the reason 0078
  -- gives for its aliases: they are read and written as one list, always
  -- with their item, and never queried on their own.
  specifications jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (app_private.production_specifications_valid(specifications)),

  active boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  CONSTRAINT production_items_manufactured_shape_check CHECK (
    manufactured = false
    OR (serial_prefix IS NOT NULL AND serial_controlled)
  )
);

COMMENT ON TABLE production_items IS
  'The OEM item master: what the organisation manufactures and what it buys to manufacture it, in one table because a bill-of-material edge joins one to the other. Separate from canonical_items (0078), whose identity is a wording rather than a part number — see this migration''s header for the full reasoning.';
COMMENT ON COLUMN production_items.manufactured IS
  'Whether a job card may be raised for this item. Stored rather than derived from "has BOM lines": the OEM catalogue must not gain and lose entries as somebody edits a bill of material.';
COMMENT ON COLUMN production_items.serial_prefix IS
  'The finished-serial series for a manufactured item. Frozen once the first unit is minted; moving it would leave two prefixes inside one series.';
COMMENT ON COLUMN production_items.serial_controlled IS
  'Whether this part''s serials are captured when it is consumed as a component. A bought-in card carries the supplier''s serials, which are scanned rather than minted, so this is independent of holding a prefix.';
COMMENT ON COLUMN production_items.specifications IS
  'User-named attribute/value pairs, as the mock''s Specifications card collects them. A jsonb list rather than a child table because it is read and written whole, with its item, and never queried on its own.';

-- One part number per organisation, case-insensitively. Two rows
-- claiming one code would make a BOM edge ambiguous to a human reading
-- it, which is the failure a part number exists to prevent. Unlike a
-- masters name, a RETIRED code still blocks: the code is printed on
-- physical labels, and reissuing it to a different part would make an
-- old label name a new thing.
CREATE UNIQUE INDEX production_items_code_per_org
  ON production_items (organisation_id, upper(item_code));

-- One serial series per organisation. Two manufactured items sharing a
-- prefix would mint colliding serials, which the organisation-wide
-- uniqueness in § 4 would then refuse at an unrelated-looking moment.
CREATE UNIQUE INDEX production_items_serial_prefix_per_org
  ON production_items (organisation_id, serial_prefix)
  WHERE serial_prefix IS NOT NULL;

-- The catalogue list orders by category then name; the OEM catalogue
-- pane filters on `manufactured` first.
CREATE INDEX production_items_catalogue_idx
  ON production_items (organisation_id, manufactured, lower(category), lower(name));

-- The item master's own guard. Two rules, and both exist because the row
-- is referenced by physical objects rather than only by other rows. It
-- reads tables defined in § 3 and § 4 below, which plpgsql resolves when
-- the trigger fires rather than when the function is created.
CREATE FUNCTION app_private.guard_production_item_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Provenance is a fact about an act that already happened, and the
  -- tenant is not a property anything may edit: re-pointing
  -- `organisation_id` would move a part number and every job card behind
  -- it into another organisation in one statement, which RLS cannot
  -- catch because the row passes the policy on the way out and on the
  -- way in. The ROW form is 0079's, and `issued-immutability-coverage`
  -- reads it out of the stored function body to prove that every column
  -- of this table is either frozen here or declared mutable there.
  IF ROW(NEW.organisation_id, NEW.created_at, NEW.created_by_user_id)
     IS DISTINCT FROM ROW(OLD.organisation_id, OLD.created_at, OLD.created_by_user_id)
  THEN
    RAISE EXCEPTION
      'a production item''s tenant and provenance are immutable'
      USING ERRCODE = '23D03';
  END IF;

  -- The serial series is frozen once it has minted anything. Moving it
  -- would put two prefixes inside one series with no way to tell which
  -- unit belongs to which, and the labels are already on the hardware.
  IF NEW.serial_prefix IS DISTINCT FROM OLD.serial_prefix AND EXISTS (
    SELECT 1 FROM production_serials s
    WHERE s.organisation_id = OLD.organisation_id AND s.item_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'item % has already minted serials, so its serial series cannot change',
      OLD.item_code
      USING ERRCODE = '23D03';
  END IF;

  -- Likewise the manufactured flag: clearing it would leave job cards
  -- referencing an item no job card may be raised for.
  IF OLD.manufactured AND NOT NEW.manufactured AND EXISTS (
    SELECT 1 FROM production_job_cards j
    WHERE j.organisation_id = OLD.organisation_id AND j.item_id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'item % has job cards and cannot stop being a manufactured item',
      OLD.item_code
      USING ERRCODE = '23D03';
  END IF;

  -- Retiring is the masters delete, so it asks the question a delete
  -- would: is anything still relying on this? An OPEN job card is; a
  -- finished one is history and does not block.
  IF OLD.active AND NOT NEW.active AND EXISTS (
    SELECT 1 FROM production_job_cards j
    WHERE j.organisation_id = OLD.organisation_id
      AND j.item_id = OLD.id
      AND j.status IN ('planned', 'in_production')
  ) THEN
    RAISE EXCEPTION
      'item % has open job cards and cannot be retired',
      OLD.item_code
      USING ERRCODE = '23D04';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_production_item_update() IS
  'Freezes a production item''s tenant, its serial series once units are minted, and its manufactured flag once job cards exist; refuses retirement while a job card is open.';

-- Sorts before production_items_touch_updated_at, so a refused write
-- raises before updated_at moves (the 0003 ordering note).
CREATE TRIGGER production_items_guard_update
BEFORE UPDATE ON production_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_item_update();

CREATE TRIGGER production_items_touch_updated_at
BEFORE UPDATE ON production_items
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE production_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_items FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the
-- planner treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY production_items_tenant_policy ON production_items
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- Masters retire via the active flag, as every master since 0013. No
-- DELETE: a part number is printed on labels and referenced by every job
-- card that ever consumed it.
GRANT SELECT, INSERT, UPDATE ON production_items TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 2. The bill of material, and the cycle refusal.
--
-- One row is one edge: this parent takes this much of this component.
-- Recursion is the point — a component may be a manufactured item with a
-- bill of its own — and recursion is also the hazard, because a bill
-- that reaches itself explodes forever. The mock's `explodeBom`
-- (`lib/data.ts`) recurses with no visited set, no depth cap and no
-- cycle check; it survives only because its fixture is a literal tree.
-- The moment the "Material" button it draws is wired to real data, that
-- function stack-overflows.
--
-- So the refusal is HERE, at the layer no writer can go around. A route
-- check would hold for the route and not for the importer, a repair
-- script, or a second route written later.
--
-- WHY AN ADVISORY LOCK. The recursive search below is correct against
-- committed data and blind to a concurrent transaction: two sessions
-- inserting A->B and B->A at the same moment each search a graph that
-- does not yet contain the other's edge, both find no cycle, and both
-- commit. Row locks cannot fix this, because the rows that would have to
-- be locked are the ones that do not exist yet. The lock is therefore
-- taken on the ORGANISATION's bill-of-material graph as a whole.
--
-- ponytail: one lock per organisation serialises every BOM edit in that
-- organisation. A bill of material is configuration written by one
-- engineer at a time, so the contention is theoretical; if it ever is
-- not, the upgrade is a lock per connected component rather than per
-- organisation, which needs the component identity this table does not
-- carry.
-- ---------------------------------------------------------------------
CREATE TABLE production_bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  parent_item_id uuid NOT NULL,
  component_item_id uuid NOT NULL,

  -- Per ONE unit of the parent. The explosion multiplies up the tree.
  quantity quantity_amount NOT NULL CHECK (quantity > 0),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, parent_item_id, component_item_id),

  FOREIGN KEY (organisation_id, parent_item_id)
    REFERENCES production_items(organisation_id, id),
  FOREIGN KEY (organisation_id, component_item_id)
    REFERENCES production_items(organisation_id, id),

  -- The one-step cycle. The recursive guard below reaches it first and
  -- raises the cycle refusal, so this is the backstop that still holds if
  -- the trigger is ever disabled for a bulk operation — which is exactly
  -- what 0043 did to two other tables.
  CONSTRAINT production_bom_lines_not_self_check
    CHECK (parent_item_id <> component_item_id)
);

COMMENT ON TABLE production_bom_lines IS
  'One parent-component edge of a recursive bill of material, quantity per single unit of the parent. Cycles are refused by app_private.guard_production_bom_edge() under a per-organisation advisory lock, not by application code.';
COMMENT ON COLUMN production_bom_lines.quantity IS
  'Per ONE unit of the parent. A job card multiplies it by its own quantity, and the explosion multiplies it again at every level of nesting.';

CREATE INDEX production_bom_lines_parent_idx
  ON production_bom_lines (organisation_id, parent_item_id);
-- The cycle search walks downward from the new component, and the
-- where-used read walks upward; both need the component side indexed.
CREATE INDEX production_bom_lines_component_idx
  ON production_bom_lines (organisation_id, component_item_id);

-- How deep a bill of material may nest. Not a safety net for the cycle
-- check — that is exact — but a bound on the explosion an honest tree can
-- produce, and a second answer if a cycle ever did exist in stored data.
CREATE FUNCTION app_private.production_bom_max_depth()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT 12
$$;

COMMENT ON FUNCTION app_private.production_bom_max_depth() IS
  'The deepest a bill of material may nest, counted in EDGES along one chain. A bound on an honest tree''s explosion, and a second answer if a cycle ever existed in stored data.';

-- What one unit of an item requires of each distinct part, exploded.
--
-- LEVEL-SYNCHRONOUS, NOT PATH-ENUMERATING, and that is the whole point
-- of it being a function rather than a recursive CTE in the route.
--
-- A bill of material is a DAG, not a tree: two sub-assemblies that share
-- a part are the ordinary case, and a plain recursive CTE walks one row
-- per PATH, so a diamond doubles the row count at every level it
-- reappears. Twelve levels of modest fan-out is an exponential answer to
-- a question with a linear one — and it was being asked on every read of
-- a job card, under that card's row lock.
--
-- This walks a FRONTIER instead: at each level it aggregates the
-- requirement per distinct item before descending, so the work is
-- bounded by levels times edges no matter how many paths reach a part.
-- The quantities are summed in `numeric` throughout; nothing here
-- touches floating point (AGENTS.md rule 5).
CREATE FUNCTION app_private.production_bom_requirements(org uuid, root uuid)
RETURNS TABLE (item_id uuid, quantity_per_unit numeric)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  frontier_items uuid[] := ARRAY[root];
  frontier_qty numeric[] := ARRAY[1::numeric];
  total_items uuid[] := '{}'::uuid[];
  total_qty numeric[] := '{}'::numeric[];
  level integer := 0;
BEGIN
  WHILE coalesce(array_length(frontier_items, 1), 0) > 0
    AND level < app_private.production_bom_max_depth() LOOP
    level := level + 1;

    SELECT coalesce(array_agg(step.item_id), '{}'::uuid[]),
           coalesce(array_agg(step.qty), '{}'::numeric[])
      INTO frontier_items, frontier_qty
    FROM (
      SELECT line.component_item_id AS item_id,
             sum(f.qty * line.quantity) AS qty
      FROM unnest(frontier_items, frontier_qty) AS f(item_id, qty)
      JOIN production_bom_lines line
        ON line.organisation_id = org AND line.parent_item_id = f.item_id
      GROUP BY line.component_item_id
    ) AS step;

    total_items := total_items || frontier_items;
    total_qty := total_qty || frontier_qty;
  END LOOP;

  -- A part reachable at two different depths contributes at each, so the
  -- accumulated rows are summed once at the end.
  RETURN QUERY
    SELECT t.item_id, sum(t.qty)
    FROM unnest(total_items, total_qty) AS t(item_id, qty)
    GROUP BY t.item_id;
END
$$;

COMMENT ON FUNCTION app_private.production_bom_requirements(uuid, uuid) IS
  'Per one unit of the root item, how much of each distinct part it takes. Aggregates per level rather than enumerating paths, so a shared sub-assembly costs one row per level instead of one row per path through it.';

CREATE FUNCTION app_private.guard_production_bom_edge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_manufactured boolean;
  parent_active boolean;
  component_active boolean;
  reached_above integer;
  reached_below integer;
BEGIN
  -- Serialise every bill-of-material edit in this organisation against
  -- every other. See the section header: two sessions adding opposite
  -- edges cannot see each other's uncommitted row, and no row lock can
  -- be taken on a row that does not exist yet.
  PERFORM pg_advisory_xact_lock(
    hashtext('production_bom_lines'), hashtext(NEW.organisation_id::text)
  );

  SELECT manufactured, active INTO parent_manufactured, parent_active
  FROM production_items
  WHERE organisation_id = NEW.organisation_id AND id = NEW.parent_item_id
  FOR SHARE;

  -- A bill of material says how a thing is BUILT. Hanging one off an
  -- item nobody builds would produce requirements no job card can ever
  -- consume, and the OEM catalogue would not show the parent at all.
  IF parent_manufactured IS NULL OR NOT parent_manufactured THEN
    RAISE EXCEPTION
      'item % is not manufactured and cannot carry a bill of material',
      NEW.parent_item_id
      USING ERRCODE = '23D02';
  END IF;

  IF NOT parent_active THEN
    RAISE EXCEPTION
      'item % is retired and its bill of material cannot be changed',
      NEW.parent_item_id
      USING ERRCODE = '23D02';
  END IF;

  SELECT active INTO component_active
  FROM production_items
  WHERE organisation_id = NEW.organisation_id AND id = NEW.component_item_id
  FOR SHARE;

  -- A retired part must not be designed into a new assembly. Bills that
  -- already name it are left alone: the units built from it exist.
  IF component_active IS NULL OR NOT component_active THEN
    RAISE EXCEPTION
      'item % is retired and cannot be added to a bill of material',
      NEW.component_item_id
      USING ERRCODE = '23D02';
  END IF;

  -- The cycle search. Walk DOWNWARD from the component being added: if
  -- the parent is reachable that way, the new edge closes a loop. The
  -- CYCLE clause is what makes this terminate even if stored data
  -- already contained one, so the guard can never be the thing that
  -- hangs.
  IF EXISTS (
    WITH RECURSIVE reachable(item_id) AS (
      SELECT NEW.component_item_id
      UNION ALL
      SELECT line.component_item_id
      FROM production_bom_lines line
      JOIN reachable ON reachable.item_id = line.parent_item_id
      WHERE line.organisation_id = NEW.organisation_id
    ) CYCLE item_id SET is_cycle USING path
    SELECT 1 FROM reachable WHERE item_id = NEW.parent_item_id
  ) THEN
    RAISE EXCEPTION
      'item % already sits below % in the bill of material, so this edge would close a cycle',
      NEW.parent_item_id, NEW.component_item_id
      USING ERRCODE = '23D01';
  END IF;

  -- THE DEPTH BOUND MEASURES BOTH DIRECTIONS, and it has to.
  --
  -- Measuring only downward from the new component bounds a BOTTOM-UP
  -- build and lets a top-down one through entirely: adding A->B, then
  -- B->C, then C->D, the new component is a leaf every single time, so
  -- the descent is always one level and the cap never fires however
  -- long the chain gets. The longest chain THROUGH this edge is what
  -- matters, and that is the height standing above the parent, plus this
  -- edge, plus the depth hanging below the component.
  --
  -- Both walks are bounded one past the cap — enough to know the cap is
  -- exceeded, and no further — and both carry the CYCLE clause for the
  -- reason the search above does.
  SELECT coalesce(max(height), 0) INTO reached_above
  FROM (
    WITH RECURSIVE ascent(item_id, height) AS (
      SELECT NEW.parent_item_id, 0
      UNION ALL
      SELECT line.parent_item_id, ascent.height + 1
      FROM production_bom_lines line
      JOIN ascent ON ascent.item_id = line.component_item_id
      WHERE line.organisation_id = NEW.organisation_id
        AND ascent.height <= app_private.production_bom_max_depth()
    ) CYCLE item_id SET is_cycle USING path
    SELECT height FROM ascent
  ) AS above;

  SELECT coalesce(max(depth), 0) INTO reached_below
  FROM (
    WITH RECURSIVE descent(item_id, depth) AS (
      SELECT NEW.component_item_id, 0
      UNION ALL
      SELECT line.component_item_id, descent.depth + 1
      FROM production_bom_lines line
      JOIN descent ON descent.item_id = line.parent_item_id
      WHERE line.organisation_id = NEW.organisation_id
        AND descent.depth <= app_private.production_bom_max_depth()
    ) CYCLE item_id SET is_cycle USING path
    SELECT depth FROM descent
  ) AS below;

  -- Edges, not nodes: the chain through this edge is everything above
  -- the parent, the edge itself, and everything below the component.
  IF reached_above + 1 + reached_below > app_private.production_bom_max_depth() THEN
    RAISE EXCEPTION
      'this edge would nest the bill of material % levels deep, past the limit of %',
      reached_above + 1 + reached_below, app_private.production_bom_max_depth()
      USING ERRCODE = '23D01';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_production_bom_edge() IS
  'Refuses a bill-of-material edge that would close a cycle, nest past the depth bound measured through the edge in BOTH directions (a top-down build hits it too), hang off an item nobody manufactures, or name a retired part. Takes a per-organisation advisory lock first: two sessions adding opposite edges cannot see each other''s uncommitted row.';

CREATE TRIGGER production_bom_lines_guard_edge
BEFORE INSERT OR UPDATE ON production_bom_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_bom_edge();

CREATE TRIGGER production_bom_lines_touch_updated_at
BEFORE UPDATE ON production_bom_lines
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE production_bom_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_bom_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY production_bom_lines_tenant_policy ON production_bom_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- DELETE is granted: a bill of material is design working material, and
-- a line added in error is removed rather than cancelled (AGENTS.md rule
-- 8). A job card already built against the old bill keeps the units it
-- produced and their component genealogy, which live in their own rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON production_bom_lines TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 3. The job card, and its numbering.
--
-- One production order: build this many of this item, for this contract
-- line or this private purchase order, by this date.
--
-- FOUR STATES AND NO OTHERS:
--
--   planned        raised, nothing built
--   in_production  the first unit has been serialised
--   completed      every planned unit exists as a serial
--   cancelled      abandoned, with a reason
--
-- The mock draws six, and three of them (`material-short`,
-- `material-ready`, `dispatch-ready`) are derived from stock and serial
-- counts rather than decided by anybody. See the header for why they are
-- not stored.
--
-- THE SOURCE IS EITHER A WORK OR A PRIVATE ORDER, never both and never
-- neither. The mock's `sourceType` is a stored string; here it is the
-- shape of the row, so the two cannot disagree. A Work-sourced card
-- takes its customer from the Work; a private one types it.
-- ---------------------------------------------------------------------
CREATE TABLE production_job_card_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, fy_label)
);

COMMENT ON TABLE production_job_card_counters IS
  'Per organisation, per financial year, the next job-card sequence. Claimed by upsert, never by reading max()+1, so concurrent raises cannot collide.';

ALTER TABLE production_job_card_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_job_card_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY production_job_card_counters_tenant_policy ON production_job_card_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: a counter records what a series reached, and a reset would
-- reissue a number a cancelled job card still holds.
GRANT SELECT, INSERT, UPDATE ON production_job_card_counters TO auto_mb_app;

-- Migration 0064's rule for every counter in this schema: a counter may
-- only ever go up. Rewinding one re-issues a number already given out.
CREATE TRIGGER production_job_card_counters_guard_decrease
BEFORE UPDATE ON production_job_card_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TABLE production_job_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- 'PP-26-081' is built from these two for display, not stored a third
  -- time (`routes/production.ts` builds it, as `routes/inspections.ts`
  -- builds its own call reference).
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  sequence_number integer NOT NULL CHECK (sequence_number >= 1),

  item_id uuid NOT NULL,

  -- Whole units, not `quantity_amount`. Every unit becomes a serial, and
  -- half a serialised unit is not a thing the factory can make.
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 100000),

  -- The Work this order serves, or NULL for a private purchase order.
  -- The mock's 'Railway LOA' / 'Private PO' label is this column being
  -- null or not, so the two cannot disagree.
  work_id uuid,
  -- 'WR-MMCT-SnT-STTD-34-2025 · A2/1' or 'PO/KE/2026/177': what the
  -- order is called on the paper it came from. Typed either way, because
  -- a schedule reference is finer than a Work code.
  source_reference text NOT NULL CHECK (
    btrim(source_reference) = source_reference
    AND length(source_reference) BETWEEN 1 AND 200
  ),
  -- Only for a private order. A Work-sourced card reads its customer
  -- from the Work, and a second copy is a second thing that can
  -- disagree.
  customer_name text CHECK (
    customer_name IS NULL
    OR (btrim(customer_name) = customer_name AND length(customer_name) BETWEEN 2 AND 200)
  ),

  status text NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'in_production', 'completed', 'cancelled')
  ),

  -- A legal-ish date the operator commits to, date-only per rule 6.
  due_date date NOT NULL,
  completed_on date,
  cancellation_reason text CHECK (
    cancellation_reason IS NULL
    OR (btrim(cancellation_reason) = cancellation_reason
        AND length(cancellation_reason) BETWEEN 3 AND 500)
  ),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- The three-column key a child uses to prove its serial and its job
  -- card name the same item (0082's shape).
  UNIQUE (organisation_id, id, item_id),

  FOREIGN KEY (organisation_id, item_id)
    REFERENCES production_items(organisation_id, id),
  FOREIGN KEY (organisation_id, work_id)
    REFERENCES works(organisation_id, id),

  CONSTRAINT production_job_cards_source_shape_check CHECK (
    (work_id IS NOT NULL AND customer_name IS NULL)
    OR (work_id IS NULL AND customer_name IS NOT NULL)
  ),
  CONSTRAINT production_job_cards_terminal_shape_check CHECK (
    CASE status
      WHEN 'completed' THEN completed_on IS NOT NULL AND cancellation_reason IS NULL
      WHEN 'cancelled' THEN cancellation_reason IS NOT NULL AND completed_on IS NULL
      ELSE completed_on IS NULL AND cancellation_reason IS NULL
    END
  )
);

COMMENT ON TABLE production_job_cards IS
  'One production order: build this many of this manufactured item for a Work or a private purchase order. Four states — planned, in_production, completed, cancelled. The mock''s material and dispatch readiness are derived on read, never stored (migration 0084 header).';
COMMENT ON COLUMN production_job_cards.quantity IS
  'Whole units. Not quantity_amount: every unit becomes a serial, and half a serialised unit is not a thing the factory can make.';
COMMENT ON CONSTRAINT production_job_cards_source_shape_check ON production_job_cards IS
  'A job card serves a Work or a private order, never both and never neither. The mock''s stored sourceType label is this shape instead, so the two cannot disagree.';

CREATE UNIQUE INDEX production_job_cards_number_per_year
  ON production_job_cards (organisation_id, fy_label, sequence_number);

-- The register reads soonest-due first across every Work in reach; the
-- keyset predicate seeks on (due_date, id).
CREATE INDEX production_job_cards_register_idx
  ON production_job_cards (organisation_id, due_date, id);
-- The two foreign-key indexes. Not partial on `work_id`, even though a
-- private order leaves it null and the `?work=` filter never reads those
-- rows: a partial index does not cover the foreign key, and covering the
-- key is what stops a Work delete scanning this table.
CREATE INDEX production_job_cards_work_idx
  ON production_job_cards (organisation_id, work_id);
CREATE INDEX production_job_cards_item_idx
  ON production_job_cards (organisation_id, item_id);

ALTER TABLE production_job_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_job_cards FORCE ROW LEVEL SECURITY;

CREATE POLICY production_job_cards_tenant_policy ON production_job_cards
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: a job card that came to nothing is the answer to "why did
-- we build none of these", and it holds a number that must never be
-- reissued. It cancels with a reason instead (AGENTS.md rule 8).
GRANT SELECT, INSERT, UPDATE ON production_job_cards TO auto_mb_app;

CREATE FUNCTION app_private.guard_production_job_card_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  item_manufactured boolean;
  made integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A job card begins where a job card begins. Inserting one already
    -- `completed` would claim units that were never serialised.
    IF NEW.status <> 'planned' THEN
      RAISE EXCEPTION
        'a job card is created as planned, not as %', NEW.status
        USING ERRCODE = '23D11';
    END IF;

    SELECT manufactured INTO item_manufactured
    FROM production_items
    WHERE organisation_id = NEW.organisation_id AND id = NEW.item_id;

    IF item_manufactured IS NULL OR NOT item_manufactured THEN
      RAISE EXCEPTION
        'item % is not manufactured, so no job card can be raised for it',
        NEW.item_id
        USING ERRCODE = '23D11';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status THEN
    -- A finished job card is finished being edited. Its quantity is what
    -- its serials were counted against and its due date is what the
    -- record says was promised.
    IF OLD.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION
        'job card % is % and cannot be edited', OLD.id, OLD.status
        USING ERRCODE = '23D12';
    END IF;

    -- The quantity is the ceiling every serial insert is counted
    -- against. Lowering it below what already exists would leave units
    -- the card does not admit to having made.
    IF NEW.quantity < OLD.quantity THEN
      SELECT count(*) INTO made
      FROM production_serials s
      WHERE s.organisation_id = OLD.organisation_id AND s.job_card_id = OLD.id;

      IF NEW.quantity < made THEN
        RAISE EXCEPTION
          'job card % has already produced % units and cannot be reduced to %',
          OLD.id, made, NEW.quantity
          USING ERRCODE = '23D13';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION
      'job card % is already % and cannot change state', OLD.id, OLD.status
      USING ERRCODE = '23D12';
  END IF;

  -- planned -> in_production -> completed, and either live state ->
  -- cancelled. Nothing reopens: the units a completed card produced have
  -- serials and may already have left the factory.
  IF NOT (
    (OLD.status = 'planned' AND NEW.status IN ('in_production', 'cancelled'))
    OR (OLD.status = 'in_production' AND NEW.status IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION
      'job card % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23D11';
  END IF;

  -- Completing means the planned units exist as serials. The route says
  -- so first, naming the shortfall; this is the layer that holds when a
  -- writer reaches the table another way.
  IF NEW.status = 'completed' THEN
    SELECT count(*) INTO made
    FROM production_serials s
    WHERE s.organisation_id = OLD.organisation_id AND s.job_card_id = OLD.id;

    IF made < OLD.quantity THEN
      RAISE EXCEPTION
        'job card % has produced % of % units and cannot be completed',
        OLD.id, made, OLD.quantity
        USING ERRCODE = '23D13';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_production_job_card_transition() IS
  'The job card''s four-state machine, its manufactured-item requirement at birth, and the rule that completion means every planned unit exists as a serial.';

-- Sorts before production_job_cards_touch_updated_at.
CREATE TRIGGER production_job_cards_guard_transition
BEFORE INSERT OR UPDATE ON production_job_cards
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_job_card_transition();

CREATE TRIGGER production_job_cards_touch_updated_at
BEFORE UPDATE ON production_job_cards
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. Finished serials.
--
-- One row is one physical unit the factory made.
--
-- THE UNIQUENESS SCOPE IS THE ORGANISATION, and that is a deliberate
-- departure from `challan_item_serials` (0006), which is unique per
-- WORK. The scopes differ because the records mean different things. A
-- challan serial is a claim about what was delivered under one contract,
-- and two contracts legitimately carry unrelated equipment whose
-- supplier numbering happens to collide. A production serial is minted
-- HERE, from a series this organisation owns, before any contract has
-- been chosen for it — a job card may even have no Work at all. Two
-- units of one factory bearing one number is the failure the nameplate
-- exists to prevent.
--
-- SERIALS ARE NEVER UPDATED. There is no UPDATE grant: a serial number
-- is not a field that gets corrected, because the number is stamped on
-- the hardware. A unit recorded in error is deleted while it is still in
-- the factory, and the foreign keys from § 5 and § 7 are what stop that
-- once anything has been hung on it — a serial with components consumed
-- into it, or one that has been despatched, cannot be deleted at all,
-- and the refusal comes from the reference rather than from a guard that
-- has to remember to look.
-- ---------------------------------------------------------------------
CREATE TABLE production_serial_counters (
  organisation_id uuid NOT NULL,
  production_item_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, production_item_id),
  FOREIGN KEY (organisation_id, production_item_id)
    REFERENCES production_items(organisation_id, id)
);

COMMENT ON TABLE production_serial_counters IS
  'Per manufactured item, the next finished-serial number in its series. Claimed by upsert, never by reading max()+1, so two operators serialising units at the same moment cannot mint one number twice.';

ALTER TABLE production_serial_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_serial_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY production_serial_counters_tenant_policy ON production_serial_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: the counter records how far the series has gone, and a
-- deleted unit does not release its number — the label was printed.
GRANT SELECT, INSERT, UPDATE ON production_serial_counters TO auto_mb_app;

CREATE TRIGGER production_serial_counters_guard_decrease
BEFORE UPDATE ON production_serial_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

CREATE TABLE production_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  job_card_id uuid NOT NULL,
  -- Carried rather than joined for, so the composite key below can prove
  -- that this unit and its job card name the same item (0082's shape),
  -- and so the component guard can read the bill of material without a
  -- second hop.
  item_id uuid NOT NULL,

  serial_number text NOT NULL CHECK (
    btrim(serial_number) = serial_number
    AND length(serial_number) BETWEEN 1 AND 100
  ),
  sequence_number integer NOT NULL CHECK (sequence_number >= 1),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- The three-column key § 7 uses to prove a despatched unit belongs to
  -- the job card the despatch names.
  UNIQUE (organisation_id, id, job_card_id),
  -- See the section header: organisation-wide, not per Work.
  UNIQUE (organisation_id, serial_number),
  UNIQUE (organisation_id, item_id, sequence_number),

  FOREIGN KEY (organisation_id, job_card_id, item_id)
    REFERENCES production_job_cards(organisation_id, id, item_id)
);

COMMENT ON TABLE production_serials IS
  'One physical finished unit. Serial numbers are unique per ORGANISATION, not per Work as challan_item_serials (0006) are: a production serial is minted from a series this organisation owns before any contract has been chosen for it.';
COMMENT ON COLUMN production_serials.item_id IS
  'Carried rather than joined for. The composite foreign key proves this unit and its job card name one item, and the component guard reads the bill of material from it without a second hop.';

-- Leads with the composite foreign key's own columns, which is what
-- `test/fk-index-coverage` demands of every key in this schema: an
-- unindexed key turns a parent delete or update into a sequential scan
-- of the child. `item_id` is fixed within a job card (the key itself
-- guarantees it), so `sequence_number` behind it still orders the units
-- of one card.
CREATE INDEX production_serials_job_card_idx
  ON production_serials (organisation_id, job_card_id, item_id, sequence_number);

ALTER TABLE production_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_serials FORCE ROW LEVEL SECURITY;

CREATE POLICY production_serials_tenant_policy ON production_serials
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No UPDATE: the number is stamped on the hardware. DELETE is for a unit
-- recorded in error while it is still in the factory; the references
-- from § 5 and § 7 refuse it once anything hangs off it.
GRANT SELECT, INSERT, DELETE ON production_serials TO auto_mb_app;

CREATE FUNCTION app_private.guard_production_serial_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  card_status text;
  card_quantity integer;
  card_prefix text;
  made integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO card_status
    FROM production_job_cards
    WHERE organisation_id = OLD.organisation_id AND id = OLD.job_card_id
    FOR UPDATE;

    -- A finished or abandoned card's unit count is what its state was
    -- decided on. Removing a unit afterwards would make `completed`
    -- untrue with nothing recording the change.
    IF card_status IS NOT NULL AND card_status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION
        'job card % is % and its units cannot be removed', OLD.job_card_id, card_status
        USING ERRCODE = '23D14';
    END IF;

    RETURN OLD;
  END IF;

  -- The row lock is what makes the ceiling below hold under
  -- concurrency: two operators serialising the last unit at the same
  -- moment both read the same count without it, and both insert.
  SELECT status, quantity INTO card_status, card_quantity
  FROM production_job_cards
  WHERE organisation_id = NEW.organisation_id AND id = NEW.job_card_id
  FOR UPDATE;

  IF card_status IS NULL THEN
    RAISE EXCEPTION
      'serial names job card %, which this transaction cannot read', NEW.job_card_id
      USING ERRCODE = '23D14';
  END IF;

  IF card_status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION
      'job card % is % and cannot produce more units', NEW.job_card_id, card_status
      USING ERRCODE = '23D14';
  END IF;

  SELECT count(*) INTO made
  FROM production_serials s
  WHERE s.organisation_id = NEW.organisation_id AND s.job_card_id = NEW.job_card_id;

  -- The planned quantity is a ceiling, exactly as the LOA quantity is a
  -- ceiling on delivery. Building more than was ordered is not a bonus,
  -- it is stock nobody asked for charged to a contract.
  IF made >= card_quantity THEN
    RAISE EXCEPTION
      'job card % has already produced its planned % units', NEW.job_card_id, card_quantity
      USING ERRCODE = '23D14';
  END IF;

  -- The serial has to come from the item's own series, or the prefix
  -- stops being able to say which item a number names.
  SELECT serial_prefix INTO card_prefix
  FROM production_items
  WHERE organisation_id = NEW.organisation_id AND id = NEW.item_id;

  IF card_prefix IS NULL OR NEW.serial_number NOT LIKE card_prefix || '-%' THEN
    RAISE EXCEPTION
      'serial % is not from the series of item %', NEW.serial_number, NEW.item_id
      USING ERRCODE = '23D14';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_production_serial_write() IS
  'Holds the job card''s planned quantity as a ceiling on units produced, under the card''s own row lock; refuses a serial outside the item''s series, and refuses adding to or removing from a finished or cancelled card.';

CREATE TRIGGER production_serials_guard_write
BEFORE INSERT OR DELETE ON production_serials
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_serial_write();

-- ---------------------------------------------------------------------
-- 5. The genealogy: which component serial went into which unit.
--
-- This is the table the mock cannot express. Its `ProductionPlan`
-- carries `componentSerials: Record<string, string[]>` — a bag of
-- strings per PLAN, keyed by bill-of-material node — so it can say that
-- twelve power supplies were consumed somewhere in a batch of twelve
-- display boards, and cannot say which one went into which. That is the
-- question a field failure asks: this board is dead, whose power supply
-- is in it, and which other boards have one from the same batch.
--
-- So the link is per FINISHED UNIT, and it is append-only once the unit
-- has left the factory. Before that a mis-scan is removed, because a
-- scanner typo on a unit still on the bench is a data-entry error rather
-- than evidence of anything. After despatch nothing can be removed: the
-- unit is somewhere else and the record is the only account of what is
-- inside it. There is no UPDATE grant in either case — the link is never
-- rewritten, only made or unmade.
-- ---------------------------------------------------------------------
CREATE TABLE production_component_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  finished_serial_id uuid NOT NULL,
  component_item_id uuid NOT NULL,

  -- The supplier's number, scanned. Not minted here: the part was made
  -- somewhere else, which is why this table has no counter.
  serial_number text NOT NULL CHECK (
    btrim(serial_number) = serial_number
    AND length(serial_number) BETWEEN 1 AND 100
  ),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- One physical component is consumed into exactly one finished unit.
  -- Scoped by item because two different part numbers may legitimately
  -- carry the same supplier serial.
  UNIQUE (organisation_id, component_item_id, serial_number),

  FOREIGN KEY (organisation_id, finished_serial_id)
    REFERENCES production_serials(organisation_id, id),
  FOREIGN KEY (organisation_id, component_item_id)
    REFERENCES production_items(organisation_id, id)
);

COMMENT ON TABLE production_component_serials IS
  'Per-unit genealogy: which component serial was consumed into which finished serial. The mock keys its component serials by plan and bill-of-material node, which cannot answer "what is inside THIS board" — the question a field failure asks. Append-only once the unit is despatched; never updated.';

CREATE INDEX production_component_serials_finished_idx
  ON production_component_serials (organisation_id, finished_serial_id);
-- The trace read runs the other way: given a component serial, which
-- unit is it in.
CREATE INDEX production_component_serials_lookup_idx
  ON production_component_serials (organisation_id, serial_number);

ALTER TABLE production_component_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_component_serials FORCE ROW LEVEL SECURITY;

CREATE POLICY production_component_serials_tenant_policy ON production_component_serials
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No UPDATE, ever: the link is made or unmade, never rewritten. DELETE
-- is the mis-scan correction, and the guard below refuses it once the
-- unit has been despatched.
GRANT SELECT, INSERT, DELETE ON production_component_serials TO auto_mb_app;

CREATE FUNCTION app_private.guard_production_component_serial()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_item uuid;
  parent_card uuid;
  required quantity_amount;
  controlled boolean;
  consumed integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM production_dispatch_serials d
      WHERE d.organisation_id = OLD.organisation_id
        AND d.production_serial_id = OLD.finished_serial_id
    ) THEN
      RAISE EXCEPTION
        'unit % has been despatched and its component record is closed',
        OLD.finished_serial_id
        USING ERRCODE = '23D15';
    END IF;

    RETURN OLD;
  END IF;

  SELECT item_id, job_card_id INTO parent_item, parent_card
  FROM production_serials
  WHERE organisation_id = NEW.organisation_id AND id = NEW.finished_serial_id;

  IF parent_item IS NULL THEN
    RAISE EXCEPTION
      'component serial names unit %, which this transaction cannot read',
      NEW.finished_serial_id
      USING ERRCODE = '23D15';
  END IF;

  -- The lock orders concurrent scans against the same unit, so the
  -- per-unit requirement below is counted once rather than twice.
  --
  -- It is taken on the JOB CARD rather than on the unit, and that is not
  -- a convenience. `SELECT ... FOR UPDATE` needs the UPDATE privilege on
  -- the table it locks, and § 4 deliberately withholds UPDATE on
  -- production_serials — a serial number is stamped on hardware and is
  -- never corrected. The job card is the row the route locks before it
  -- reaches here (`routes/production.ts`, lockJobCard), so both layers
  -- queue on the same row in the same order and cannot deadlock against
  -- each other. It is coarser than a per-unit lock: two operators
  -- scanning two DIFFERENT units of one card serialise. That is the
  -- right trade for a bench operation, and a finer lock would need an
  -- UPDATE grant this table must not have.
  PERFORM 1 FROM production_job_cards
  WHERE organisation_id = NEW.organisation_id AND id = parent_card
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM production_dispatch_serials d
    WHERE d.organisation_id = NEW.organisation_id
      AND d.production_serial_id = NEW.finished_serial_id
  ) THEN
    RAISE EXCEPTION
      'unit % has been despatched and takes no further components',
      NEW.finished_serial_id
      USING ERRCODE = '23D15';
  END IF;

  -- The component must be one the unit is actually built from, at the
  -- top level of its bill of material. A serial captured against a part
  -- the assembly does not contain is a record of nothing.
  SELECT line.quantity, component.serial_controlled
    INTO required, controlled
  FROM production_bom_lines line
  JOIN production_items component
    ON component.organisation_id = line.organisation_id
   AND component.id = line.component_item_id
  WHERE line.organisation_id = NEW.organisation_id
    AND line.parent_item_id = parent_item
    AND line.component_item_id = NEW.component_item_id;

  IF required IS NULL THEN
    RAISE EXCEPTION
      'item % is not in the bill of material of the unit''s product',
      NEW.component_item_id
      USING ERRCODE = '23D15';
  END IF;

  IF NOT controlled THEN
    RAISE EXCEPTION
      'item % is not serial controlled, so it has no serials to consume',
      NEW.component_item_id
      USING ERRCODE = '23D15';
  END IF;

  SELECT count(*) INTO consumed
  FROM production_component_serials existing
  WHERE existing.organisation_id = NEW.organisation_id
    AND existing.finished_serial_id = NEW.finished_serial_id
    AND existing.component_item_id = NEW.component_item_id;

  -- The bill of material says how many of this part one unit takes.
  -- Scanning a thirteenth power supply into a board that takes one means
  -- somebody scanned the wrong thing, and the moment to say so is now.
  IF consumed >= required THEN
    RAISE EXCEPTION
      'unit % already has its % of item %',
      NEW.finished_serial_id, required, NEW.component_item_id
      USING ERRCODE = '23D15';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_production_component_serial() IS
  'Binds a component serial to a part the unit is actually built from, in no greater number than the bill of material calls for, under the unit''s row lock; closes the record once the unit is despatched.';

CREATE TRIGGER production_component_serials_guard_write
BEFORE INSERT OR DELETE ON production_component_serials
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_component_serial();

-- ---------------------------------------------------------------------
-- 6. Despatch numbering.
-- ---------------------------------------------------------------------
CREATE TABLE production_dispatch_counters (
  organisation_id uuid NOT NULL,
  job_card_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, job_card_id),
  FOREIGN KEY (organisation_id, job_card_id)
    REFERENCES production_job_cards(organisation_id, id)
);

COMMENT ON TABLE production_dispatch_counters IS
  'Per job card, the next despatch sequence. Claimed by upsert, never by reading max()+1, so two releases raised together cannot collide.';

ALTER TABLE production_dispatch_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_dispatch_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY production_dispatch_counters_tenant_policy ON production_dispatch_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE ON production_dispatch_counters TO auto_mb_app;

CREATE TRIGGER production_dispatch_counters_guard_decrease
BEFORE UPDATE ON production_dispatch_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- ---------------------------------------------------------------------
-- 7. THE DESPATCH BOUNDARY. Read this section before building on it.
--
-- This is the seam between production and everything downstream, and it
-- is the one interface this migration asks a later pack to hold to.
--
-- WHAT A DESPATCH IS. Named finished units leave the factory floor on a
-- given date. That is all. It is not a Delivery Challan, it does not
-- name a consignee, it moves no money and it makes no statutory claim.
-- It is the moment production stops being responsible for a unit.
--
-- WHAT THE INVENTORY PACK FKs INTO. A stock ledger records a receipt of
-- finished goods, and its source document is a despatch:
--
--   FOREIGN KEY (organisation_id, production_dispatch_id)
--     REFERENCES production_dispatches(organisation_id, id)
--
-- and, where the ledger is serialised, the individual unit:
--
--   FOREIGN KEY (organisation_id, production_serial_id)
--     REFERENCES production_serials(organisation_id, id)
--
-- Both targets carry the `UNIQUE (organisation_id, id)` those keys need.
-- The quantity received equals the number of `production_dispatch_serials`
-- rows the despatch carries; production never states a quantity of its
-- own, so the two cannot disagree.
--
-- WHAT DOWNSTREAM MUST NOT DO. It must not write these tables. The
-- despatch is production's statement, and a stock correction is a stock
-- movement, not a rewrite of what the factory said it released.
--
-- AND IT MUST KEY ON `production_serials.id`, NEVER ON serial_number.
-- Whenever a despatched unit is later linked to a Delivery Challan, the
-- link is by row id. The number is unique per organisation TODAY, and
-- that is a constraint this migration chose rather than a law: it is a
-- human-facing label read off a nameplate, it is the field an importer
-- of legacy data is most likely to arrive with duplicates in, and
-- `challan_item_serials` already scopes the same kind of string per WORK
-- rather than per organisation. A join on text would silently bind the
-- wrong unit the first time those two scopes met.
--
-- THE DELETE PATH, AND WHY IT IS SAFE TO LEAVE OPEN. A despatch raised
-- in error can be deleted today, which releases its units. That is
-- deliberate and it is self-closing: the moment Inventory's ledger
-- carries the foreign key above, PostgreSQL refuses the delete, because
-- stock has already moved on the strength of it. The guard is the
-- reference rather than a rule somebody has to remember to write. Until
-- then nothing downstream exists to be wrong.
--
-- A despatch is NOT gap-free for that reason, and it does not need to
-- be: the gap-free rule (AGENTS.md rule 8) is about numbers that appear
-- on documents handed to a third party, and this number never leaves the
-- organisation.
-- ---------------------------------------------------------------------
CREATE TABLE production_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  job_card_id uuid NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number >= 1),

  -- Date-only per rule 6, and compared against the ORGANISATION's today
  -- (`app_private.organisation_today`, migration 0082) at the route, so
  -- a release recorded at 00:30 IST is not refused as being in the
  -- future by a server thinking in UTC.
  dispatched_on date NOT NULL,

  remarks text CHECK (
    remarks IS NULL
    OR (btrim(remarks) = remarks AND length(remarks) BETWEEN 1 AND 500)
  ),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- The three-column key the line uses to prove that the unit it names
  -- and the despatch it belongs to came from one job card.
  UNIQUE (organisation_id, id, job_card_id),
  UNIQUE (organisation_id, job_card_id, sequence_number),

  FOREIGN KEY (organisation_id, job_card_id)
    REFERENCES production_job_cards(organisation_id, id)
);

COMMENT ON TABLE production_dispatches IS
  'The production-to-stock boundary: named finished units leave the factory on a date. Not a Delivery Challan — no consignee, no money, no statutory claim. Inventory''s stock ledger takes its receipt source from here; see § 7 of migration 0084 for the interface.';

ALTER TABLE production_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_dispatches FORCE ROW LEVEL SECURITY;

CREATE POLICY production_dispatches_tenant_policy ON production_dispatches
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No UPDATE: a despatch states what left and when, and both are facts
-- about a past moment. DELETE releases a release raised in error, and
-- closes itself the moment a stock ledger references it (§ 7).
GRANT SELECT, INSERT, DELETE ON production_dispatches TO auto_mb_app;

-- Whether a unit still owes a serial-controlled component its product's
-- bill of material calls for.
--
-- ONE expression, because three callers ask it and a disagreement
-- between them is a wrong answer on a screen: the despatch-line guard
-- below, the dispatch-readiness function under it, and the route. The
-- mock's own defect is exactly this — its plan status and its computed
-- shortage disagree — so the fix cannot be three copies of the rule.
-- The parameter is `finished_serial`, not `unit`: `production_items.unit`
-- is a column in scope here, and PostgreSQL resolves the bare name to
-- the column, which turns `s.id = unit` into `uuid = text`.
CREATE FUNCTION app_private.production_unit_incomplete(org uuid, finished_serial uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM production_serials s
    JOIN production_bom_lines line
      ON line.organisation_id = s.organisation_id
     AND line.parent_item_id = s.item_id
    JOIN production_items component
      ON component.organisation_id = line.organisation_id
     AND component.id = line.component_item_id
    WHERE s.organisation_id = org
      AND s.id = finished_serial
      AND component.serial_controlled
      AND (
        SELECT count(*) FROM production_component_serials c
        WHERE c.organisation_id = s.organisation_id
          AND c.finished_serial_id = s.id
          AND c.component_item_id = line.component_item_id
      ) < ceil(line.quantity)
  )
$$;

COMMENT ON FUNCTION app_private.production_unit_incomplete(uuid, uuid) IS
  'Whether a finished unit is still missing a serial-controlled component its bill of material calls for. The single expression the despatch guard, the readiness function and the route all ask.';

-- The despatch header's own guard. § 2 of this migration states the
-- principle these exist for: a rule the route checks is a rule that
-- holds for the route, and this is the layer a writer arriving another
-- way still meets.
CREATE FUNCTION app_private.guard_production_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  card_status text;
  today date;
BEGIN
  SELECT status INTO card_status
  FROM production_job_cards
  WHERE organisation_id = NEW.organisation_id AND id = NEW.job_card_id
  FOR UPDATE;

  IF card_status IS NULL THEN
    RAISE EXCEPTION
      'despatch names job card %, which this transaction cannot read', NEW.job_card_id
      USING ERRCODE = '23D16';
  END IF;

  IF card_status = 'cancelled' THEN
    RAISE EXCEPTION
      'job card % is cancelled and releases nothing', NEW.job_card_id
      USING ERRCODE = '23D16';
  END IF;

  -- The ORGANISATION's today, not UTC's (rule 6 and 0082's own
  -- `organisation_today`): a release recorded at 00:30 IST is today, and
  -- a server thinking in UTC would call it tomorrow and refuse it.
  today := app_private.organisation_today(NEW.organisation_id);

  -- A missing timezone is not a reason to wave the check through. It
  -- gets its own code so the route can say what is actually wrong
  -- instead of reporting a future-dated despatch.
  IF today IS NULL THEN
    RAISE EXCEPTION
      'the organisation has no resolvable calendar date, so a despatch cannot be dated'
      USING ERRCODE = '23D17';
  END IF;

  IF NEW.dispatched_on > today THEN
    RAISE EXCEPTION
      'a despatch cannot be dated in the future (% is after %)',
      NEW.dispatched_on, today
      USING ERRCODE = '23D16';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_production_dispatch() IS
  'Refuses a despatch on a cancelled job card, or dated after the organisation''s own today — and refuses outright when that date cannot be resolved rather than falling back to UTC.';

CREATE TRIGGER production_dispatches_guard_write
BEFORE INSERT ON production_dispatches
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_dispatch();

CREATE TABLE production_dispatch_serials (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  production_dispatch_id uuid NOT NULL,
  production_serial_id uuid NOT NULL,
  -- Carried by both composite keys below, which is how the schema proves
  -- without a trigger that the unit and the despatch came from one job
  -- card.
  job_card_id uuid NOT NULL,

  PRIMARY KEY (organisation_id, production_dispatch_id, production_serial_id),
  -- A unit leaves the factory once.
  UNIQUE (organisation_id, production_serial_id),

  FOREIGN KEY (organisation_id, production_dispatch_id, job_card_id)
    REFERENCES production_dispatches(organisation_id, id, job_card_id),
  FOREIGN KEY (organisation_id, production_serial_id, job_card_id)
    REFERENCES production_serials(organisation_id, id, job_card_id)
);

-- Covers the despatch-side composite key; the unit-side one is covered
-- by the UNIQUE above.
CREATE INDEX production_dispatch_serials_dispatch_idx
  ON production_dispatch_serials
     (organisation_id, production_dispatch_id, job_card_id);

COMMENT ON TABLE production_dispatch_serials IS
  'Which units a despatch released. The two composite foreign keys share job_card_id, so a unit from one job card cannot be released on another card''s despatch — proved by the keys rather than by a trigger.';

ALTER TABLE production_dispatch_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_dispatch_serials FORCE ROW LEVEL SECURITY;

CREATE POLICY production_dispatch_serials_tenant_policy ON production_dispatch_serials
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No UPDATE: a line is made or unmade, never moved to another despatch.
-- DELETE exists only so deleting a despatch can take its lines with it.
GRANT SELECT, INSERT, DELETE ON production_dispatch_serials TO auto_mb_app;

-- Completeness is checked HERE rather than on the header, because the
-- header does not yet know which units it carries: the lines arrive
-- after it. A unit still owing a component serial is not finished, and
-- letting it leave would close its component record (§ 5) with the
-- record incomplete.
CREATE FUNCTION app_private.guard_production_dispatch_serial()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_private.production_unit_incomplete(
       NEW.organisation_id, NEW.production_serial_id
     ) THEN
    RAISE EXCEPTION
      'unit % is still missing a component serial its bill of material calls for',
      NEW.production_serial_id
      USING ERRCODE = '23D16';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.guard_production_dispatch_serial() IS
  'Refuses the release of a unit that still owes a serial-controlled component. Checked on the line rather than the header because the header does not yet know which units it carries.';

CREATE TRIGGER production_dispatch_serials_guard_write
BEFORE INSERT ON production_dispatch_serials
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_dispatch_serial();

-- Whether a job card has units ready to leave the factory.
--
-- THE ONE EXPRESSION the register tile and the job card's own badge both
-- read. They disagreed before: the tile counted `in_production` cards
-- whose serial count had been reached and said nothing about components,
-- while the detail also required every unit's components. A tile that
-- counts a different thing from the badge it links to is the defect
-- § 11b of `docs/UX.md` accuses the mock of, committed here.
--
-- The status semantics, decided rather than inherited:
--
--   * `cancelled` is never ready. Nothing leaves a withdrawn order.
--   * `completed` IS ready while units remain in the factory, and that
--     is the stated home for the case the review asked about. Completing
--     a card means every planned unit was BUILT; it says nothing about
--     whether they have shipped, and a completed card holding twelve
--     unreleased boards is precisely what an operator wants the tile to
--     surface.
--   * A card with nothing left to release is NOT ready — there is
--     nothing to be ready for. Without this the tile would keep counting
--     cards forever after their last unit shipped.
CREATE FUNCTION app_private.production_job_card_dispatch_ready(org uuid, card uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT j.status <> 'cancelled'
     AND (
       SELECT count(*) FROM production_serials s
       WHERE s.organisation_id = j.organisation_id AND s.job_card_id = j.id
     ) >= j.quantity
     AND EXISTS (
       SELECT 1 FROM production_serials s
       WHERE s.organisation_id = j.organisation_id
         AND s.job_card_id = j.id
         AND NOT EXISTS (
           SELECT 1 FROM production_dispatch_serials d
           WHERE d.organisation_id = s.organisation_id
             AND d.production_serial_id = s.id
         )
     )
     AND NOT EXISTS (
       SELECT 1 FROM production_serials s
       WHERE s.organisation_id = j.organisation_id
         AND s.job_card_id = j.id
         AND NOT EXISTS (
           SELECT 1 FROM production_dispatch_serials d
           WHERE d.organisation_id = s.organisation_id
             AND d.production_serial_id = s.id
         )
         AND app_private.production_unit_incomplete(s.organisation_id, s.id)
     )
  FROM production_job_cards j
  WHERE j.organisation_id = org AND j.id = card
$$;

COMMENT ON FUNCTION app_private.production_job_card_dispatch_ready(uuid, uuid) IS
  'Whether a job card has units ready to leave: not cancelled, every planned unit built, at least one still in the factory, and none of those missing a component serial. Read by the register tile and the job card badge alike, so the two cannot disagree.';
