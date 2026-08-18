SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0088: maintenance — the site material request, from the
-- engineer who finds a dead power supply on a platform to the defective
-- unit arriving back at the office for repair.
--
-- The design contract draws three screens: `app/maintenance/page.tsx`
-- (the stage strip and the job-card list), `app/maintenance/[id]`
-- (approve, dispatch, receive defects, close) and
-- `app/maintenance/new` (the request form), all at mock commit fdfd610.
--
-- ---------------------------------------------------------------------
-- THIS IS NOT AMC, AND THE NAME COLLIDES.
--
-- "Maintenance" already means something in this product. Migration 0068
-- gave `work_items` an `amc` payment category: an annual maintenance
-- SCHEDULE quoted in the LOA, served over a period and certified by the
-- railway, which `routes/challans.ts` and `routes/installations.ts`
-- refuse to let anybody despatch or install because a year of service is
-- not a thing you put on a lorry.
--
-- What this migration builds is the opposite shape. It is not a contract
-- line and it earns no money: it is the internal logistics of getting a
-- replacement part out of the store, onto a platform, and the failed unit
-- back to the bench. Nothing here touches `work_items`, no row here is
-- billable, and no quantity here counts toward an LOA ceiling. The two
-- meanings share a word and nothing else, and every table below is
-- prefixed `maintenance_request` / `maintenance_dispatch` rather than
-- bare `maintenance_*` so a reader of the schema is never left guessing
-- which one they have found.
--
-- ---------------------------------------------------------------------
-- SEVEN TABLES, AND WHY EACH EXISTS.
--
--   maintenance_request_counters   gap-free MR serial, per financial year
--   maintenance_requests           the job card: fault, site, priority
--   maintenance_request_lines      what was asked for
--   maintenance_dispatch_counters  gap-free challan serial, per Work
--   maintenance_dispatches         one issue of material, one paper
--   maintenance_dispatch_lines     how much of each line went on it
--   maintenance_returns            the defective unit coming back
--
-- ---------------------------------------------------------------------
-- FOUR OF THE MOCK'S LINE QUANTITIES HAVE NO WRITER, AND ARE DERIVED
-- HERE INSTEAD.
--
-- `app/actions/maintenance.ts` carries six numbers on every material
-- line: `quantity`, `availableQuantity`, `reservedQuantity`,
-- `dispatchedQuantity`, `cancelledQuantity` and
-- `receivedReturnQuantity`. Only the first is a fact anybody states.
--
--   availableQuantity   the fixture computes it as `max(quantity, 2)`.
--                       What is actually on the shelf is
--                       `app_private.stock_on_hand` (0087), read at the
--                       moment the screen asks.
--
--   reservedQuantity    the mock's approve action sets it to
--                       `min(quantity, available)` and nothing ever
--                       reduces it again — so a fully dispatched line
--                       still reads as holding stock. Here it is the
--                       line's own outstanding approved quantity,
--                       `quantity - dispatched - cancelled`, and it can
--                       only be wrong if the dispatches are wrong.
--                       Migration 0087 refused a stored `reserved`
--                       column on the item for the same reason and in
--                       almost the same words; this is that rule applied
--                       one table further out.
--
--   dispatchedQuantity  the sum of this line's `maintenance_dispatch_lines`.
--                       Stored, it would be a second writer beside the
--                       challans that are the evidence for it.
--
--   receivedReturnQuantity  the sum of this line's `maintenance_returns`.
--                       Same reason.
--
-- `cancelledQuantity` IS stored, and it is the one of the five the mock
-- gets right in principle and wrong in practice: its closure gate reads
-- `dispatched + cancelled >= quantity` and no action in the mock ever
-- writes `cancelledQuantity`, so a request whose stock never arrives can
-- never be closed and never disappears from the list. This migration
-- gives it a writer — a line's undispatched remainder may be cancelled
-- with a reason — because otherwise the closure gate is unreachable.
--
-- ---------------------------------------------------------------------
-- A DISPATCH MOVES REAL STOCK.
--
-- Material leaving the store for a platform is a stock issue, and the
-- ledger built in 0087 is the only place this product records one. A
-- maintenance dispatch line naming a `production_items` row therefore
-- posts an `issue` movement, and § 8 below gives `stock_movements` the
-- one nullable column that lets the ledger say which dispatch caused it
-- — 0087's own rule that "a ledger whose rows cannot be traced back to
-- what caused them is a list of numbers", applied to the document this
-- migration adds.
--
-- A line with NO `production_item_id` is a custom material bought or
-- fabricated for this fault alone; the mock allows one (`itemType`
-- `custom`, free-text description, no code) and there is nothing on a
-- shelf for it to come off. Those lines dispatch without a movement, and
-- that is the whole of the difference between the two kinds.
--
-- THE DEFECTIVE RETURN POSTS NOTHING. A unit received back for repair is
-- not stock: it is broken, it is on a bench, and adding it to the
-- available balance would let somebody dispatch it again. The mock reads
-- the same way — "Receive defective items … repair disposition" — and
-- the repair itself, when it exists, is a `return` or an `adjustment_in`
-- posted by whoever fixed it.
--
-- ---------------------------------------------------------------------
-- WHY THE DISPATCH IS NOT AN ISSUE CHALLAN.
--
-- It very nearly is. `issue_challans` (0014) is already "material issued
-- out (to site, job work, loan/return)" with a gap-free per-Work number,
-- a frozen snapshot, a cancellation that retains the number, and lines
-- that may be manual — the exact shape of the paper a store hands a site
-- receiver. Reusing it was the first design and it was dropped for one
-- structural reason:
--
--   `issue_challans_one_draft_per_work` (0014) holds ONE draft per Work,
--   and `app_private.guard_issue_challan_insert` (0031) admits a row
--   only as a draft. A maintenance dispatch would therefore have to pass
--   through the draft state — and would be refused for any Work that
--   already has an issue challan open on somebody else's screen. Two
--   unrelated clerks would block each other for reasons neither can see.
--
-- Relaxing that index is a uniqueness-and-numbering change to an
-- issued-document surface, with the correction flow (0019), the
-- supersession guard (0071) and the whole of `routes/issue-challans.ts`
-- resting on it. That is 0087's posture on `purchase_orders.work_id`,
-- for the same reason: it belongs in its own pack with its own review,
-- not as a side effect of a maintenance module. Recorded in
-- `docs/UX.md` § 14 so the owner can rule on merging the two registers
-- later; nothing here forecloses it.
--
-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * NO REJECT. The mock's approval is one-way: `approveMaintenanceRequest`
--     exists and nothing declines. A request that should not be fulfilled
--     therefore has one exit, which is to cancel every line with a reason
--     and close it — the same evidence a rejection would carry, filed
--     against the lines rather than the header. A `rejected` status with
--     no screen behind it would be a state nothing can leave.
--
--   * NO DISPATCH CANCELLATION. A dispatch is inserted issued, numbered
--     and append-only; there is no draft to delete and no cancel action
--     in the mock. Engineering rule 8 wants a cancel path on issued
--     records and this one does not have it yet, which is stated plainly
--     in `docs/UX.md` § 14 rather than half-built: cancelling a dispatch
--     means reversing its stock movements, which means an
--     `adjustment_in` the ledger deliberately makes somebody justify.
--
--   * NO SERIALISED ASSET REGISTER. `asset_serials` is a `text[]` of what
--     the site says is on the failed equipment, exactly as the mock
--     collects it, and it is NOT a foreign key into `production_serials`.
--     The units being replaced are usually not ours — they are whatever
--     the railway had on that platform — so a key would be null for the
--     cases that matter. Same call `canonical_items.aliases` (0078) made,
--     for the same reason: read and written as one list, with their line,
--     never queried alone.
--
--   * NO WAREHOUSE. 0087 refused a location dimension and explained why;
--     `stock_location` here is a label on the paper, snapshot text, and
--     participates in no arithmetic.
--
-- ---------------------------------------------------------------------
-- NAMED SQLSTATES. Every RAISE below carries a code from the 23G block,
-- which this migration is the first to use, so a guard that fires
-- because a writer reached the table by another path surfaces as the
-- same 409 the route would have raised rather than an unexplained 500.
-- `apps/server/src/routes/maintenance.ts` maps every one of them.
--
--   23G01  the request's state does not admit this act
--   23G02  the dispatch exceeds what the line has left to dispatch
--   23G03  the return exceeds what the line still owes back
--   23G04  closure is blocked: material or defects are outstanding
--   23G05  the request's terms are frozen once it is raised
--
-- There is no code for "this record is append-only": the dispatch, its
-- lines and the returns hold no UPDATE or DELETE grant at all, so the
-- refusal is a 42501 from the privilege system rather than a guard, and
-- inventing a SQLSTATE for a rule no RAISE can reach would be a code
-- nothing raises.
--
-- ---------------------------------------------------------------------
-- LOCK ORDER. `routes/inspections.ts` declares the product's ordering as
-- works -> work_items -> inspection_calls; 0084 extended it to
-- works -> work_items -> production_job_cards -> production_serials, and
-- 0087 hangs the per-item stock counter off the far end. Maintenance
-- takes locks in this order and no other:
--
--   maintenance_request_counters (or maintenance_dispatch_counters)
--     -> maintenance_requests -> maintenance_request_lines
--     -> stock_movement_counters (0087, inside the movement insert)
--
-- The counter is always the FIRST write, as it is everywhere else in
-- this schema, and the stock counter is always the LAST — so a
-- maintenance dispatch and a plain stock issue queue behind the same
-- per-item row in the same direction and cannot deadlock against each
-- other.
--
-- ---------------------------------------------------------------------
-- NUMBERING OF THE MIGRATION ITSELF. 0088 was allocated to this pack by
-- 0087's own header ("0088 is this pack's"); 0085 is production's unused
-- buffer. The series is allocated, not contiguous, and has been since
-- 0066.

-- ---------------------------------------------------------------------
-- 1. The request numbering counter.
--
-- One series per organisation, restarting each Indian financial year:
-- `MR/26-27/00142`. Organisation-scoped rather than Work-scoped because
-- the register is read across Works — a store clerk's morning is a queue
-- of requests from every contract at once — and because the number is
-- quoted on the phone before anybody has looked up which Work the
-- station belongs to.
--
-- Claimed by the upsert-returning pattern (0064's rule for every counter
-- in this schema), never `max()+1`: a rolled-back request rolls its
-- number back with it, so the series is gap-free.
-- ---------------------------------------------------------------------
CREATE TABLE maintenance_request_counters (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  fy_label text NOT NULL CHECK (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, fy_label)
);

COMMENT ON TABLE maintenance_request_counters IS
  'Gap-free maintenance request serials, one series per organisation per financial year. Claimed by the upsert-returning pattern, so a rolled-back request rolls its number back with it.';
COMMENT ON COLUMN maintenance_request_counters.fy_label IS
  'The full April-to-March label, 2026-27. The rendered number abbreviates it to 26-27; the counter keys on the unambiguous form, as correspondence (0086) does.';

ALTER TABLE maintenance_request_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_request_counters FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the
-- planner treats it as an InitPlan and evaluates it once per statement
-- rather than once per row.
CREATE POLICY maintenance_request_counters_tenant_policy
  ON maintenance_request_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: resetting a counter would reissue a serial a closed request
-- still holds.
GRANT SELECT, INSERT, UPDATE ON maintenance_request_counters TO auto_mb_app;

CREATE TRIGGER maintenance_request_counters_guard_decrease
BEFORE UPDATE ON maintenance_request_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- ---------------------------------------------------------------------
-- 2. The request.
--
-- The mock's "job card": one fault at one station, with the engineer who
-- reported it and the operational impact that decides how fast anybody
-- has to move.
-- ---------------------------------------------------------------------
CREATE TABLE maintenance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- NOT NULL, unlike correspondence's optional Work. Material comes off
  -- the shelf against a contract: the site is a station on some Work's
  -- scope, and the dispatch challan is numbered in that Work's series.
  work_id uuid NOT NULL,

  -- Allocated at insert; there is no draft state, so it never changes
  -- and a closed request keeps it forever.
  request_number text NOT NULL CHECK (
    btrim(request_number) = request_number
    AND length(request_number) BETWEEN 1 AND 40
  ),
  financial_year text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),

  -- Free text, not a foreign key. A railway station is not a master in
  -- this product and inventing one here would be a table with one writer
  -- and no reader; `work_consignees` is the nearest thing and it is a
  -- delivery address, not a fault location.
  station text NOT NULL CHECK (
    btrim(station) = station AND length(station) BETWEEN 2 AND 200
  ),

  -- The site engineer, as a SNAPSHOT of who reported it. Not
  -- `created_by_user_id` and not a contact key: the person who phones in
  -- a dead display is routinely not the person with the login, and rule
  -- 7 says a master-data edit never rewrites history.
  requester_name text NOT NULL CHECK (
    btrim(requester_name) = requester_name
    AND length(requester_name) BETWEEN 2 AND 200
  ),
  requester_phone text CHECK (
    requester_phone IS NULL
    OR (btrim(requester_phone) = requester_phone
        AND length(requester_phone) BETWEEN 4 AND 30)
  ),

  priority text NOT NULL DEFAULT 'routine' CHECK (
    priority IN ('routine', 'urgent', 'critical')
  ),

  -- Date-only per engineering rule 6. Optional: most faults are wanted
  -- as soon as there is stock, and a made-up deadline on every request
  -- is a deadline nobody reads.
  required_by date,

  fault_summary text NOT NULL CHECK (
    btrim(fault_summary) = fault_summary
    AND length(fault_summary) BETWEEN 3 AND 1000
  ),
  operational_impact text CHECK (
    operational_impact IS NULL
    OR length(btrim(operational_impact)) BETWEEN 3 AND 2000
  ),
  delivery_instructions text CHECK (
    delivery_instructions IS NULL
    OR length(btrim(delivery_instructions)) BETWEEN 3 AND 2000
  ),

  -- The mock's four stages, stored with underscores and rendered with
  -- hyphens by the chip map, as 0084 stores `in_production` for the
  -- chip's `in-production`.
  status text NOT NULL DEFAULT 'awaiting_approval' CHECK (
    status IN ('awaiting_approval', 'approved', 'partially_dispatched', 'closed')
  ),

  approval_comment text CHECK (
    approval_comment IS NULL OR length(btrim(approval_comment)) BETWEEN 3 AND 1000
  ),
  approved_by_user_id text,
  approved_at timestamptz,

  closed_by_user_id text,
  closed_at timestamptz,

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, id, work_id),

  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id),

  -- Approval is what moves a request off the first stage, so the three
  -- approval facts arrive together or not at all.
  CONSTRAINT maintenance_requests_approval_shape_check CHECK (
    (status = 'awaiting_approval'
      AND approved_at IS NULL
      AND approved_by_user_id IS NULL
      AND approval_comment IS NULL)
    OR
    (status <> 'awaiting_approval'
      AND approved_at IS NOT NULL
      AND approved_by_user_id IS NOT NULL)
  ),

  CONSTRAINT maintenance_requests_closure_shape_check CHECK (
    (status = 'closed' AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL)
    OR
    (status <> 'closed' AND closed_at IS NULL AND closed_by_user_id IS NULL)
  )
);

COMMENT ON TABLE maintenance_requests IS
  'A site material request: one fault at one station, from the engineer who reported it to the closure gate. NOT the LOA''s annual maintenance schedule — see migration 0088''s header for why the two share a word and nothing else.';
COMMENT ON COLUMN maintenance_requests.requester_name IS
  'The site engineer who reported the fault, snapshotted. Deliberately not created_by_user_id: the person who phones it in is routinely not the person holding the login.';
COMMENT ON COLUMN maintenance_requests.station IS
  'The fault location as the site names it. Free text: a station is not a master in this product, and work_consignees is a delivery address rather than a place equipment lives.';

-- The number is unique, and so is the SEQUENCE it was rendered from:
-- gap-freeness is only provable if two rows cannot share serial 7.
CREATE UNIQUE INDEX maintenance_requests_number_unique
  ON maintenance_requests (organisation_id, request_number);
CREATE UNIQUE INDEX maintenance_requests_sequence_unique
  ON maintenance_requests (organisation_id, financial_year, sequence_number);

-- The dashboard list: open requests first, newest first, and the
-- non-partial leading index the Work foreign key needs.
CREATE INDEX maintenance_requests_register_idx
  ON maintenance_requests (organisation_id, created_at DESC, id);
CREATE INDEX maintenance_requests_work_idx
  ON maintenance_requests (organisation_id, work_id);

ALTER TABLE maintenance_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_requests_tenant_policy ON maintenance_requests
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: a request carries a number from the moment it is raised,
-- and a numbered record is closed rather than removed.
GRANT SELECT, INSERT, UPDATE ON maintenance_requests TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 3. The material lines.
--
-- Either a part from the item master — in which case the dispatch moves
-- stock — or a custom material with nothing on a shelf behind it. The
-- mock's `itemType` is exactly this distinction and is DERIVED here from
-- whether `production_item_id` is set, rather than stored beside it
-- where the two could disagree.
-- ---------------------------------------------------------------------
CREATE TABLE maintenance_request_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  maintenance_request_id uuid NOT NULL,

  production_item_id uuid,

  -- SNAPSHOTS, both of them, for the part lines as well as the custom
  -- ones: renaming a part next year must not rewrite what a challan said
  -- went out last year (rule 7).
  description text NOT NULL CHECK (
    btrim(description) = description AND length(description) BETWEEN 3 AND 300
  ),
  unit text NOT NULL CHECK (
    btrim(unit) = unit AND length(unit) BETWEEN 1 AND 20
  ),

  quantity quantity_amount NOT NULL CHECK (quantity > 0),

  purpose text CHECK (
    purpose IS NULL OR length(btrim(purpose)) BETWEEN 2 AND 300
  ),

  -- How many of the failed units the site owes back. Zero is the normal
  -- answer for a consumable; it may not exceed what is being sent, since
  -- the return is a swap.
  expected_return_quantity quantity_amount NOT NULL DEFAULT 0
    CHECK (expected_return_quantity >= 0),

  -- The remainder nobody is going to send, written off with a reason.
  -- The mock carries this column and never writes it, which leaves its
  -- own closure gate unreachable; see the header.
  cancelled_quantity quantity_amount NOT NULL DEFAULT 0
    CHECK (cancelled_quantity >= 0),
  cancellation_reason text CHECK (
    cancellation_reason IS NULL
    OR length(btrim(cancellation_reason)) BETWEEN 3 AND 500
  ),

  -- What the site says is written on the failed equipment. Not a key
  -- into production_serials: the unit being replaced is usually not one
  -- we built. Bounded so a paste accident cannot put an asset register
  -- in here, and non-empty per element so a blank serial cannot match a
  -- blank one on receipt.
  asset_serials text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(asset_serials) <= 100)
    CHECK (array_position(asset_serials, NULL) IS NULL)
    CHECK (array_position(asset_serials, '') IS NULL),

  position integer NOT NULL CHECK (position > 0),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, maintenance_request_id, position),

  FOREIGN KEY (organisation_id, maintenance_request_id)
    REFERENCES maintenance_requests(organisation_id, id),
  FOREIGN KEY (organisation_id, production_item_id)
    REFERENCES production_items(organisation_id, id),

  CONSTRAINT maintenance_request_lines_return_ceiling_check
    CHECK (expected_return_quantity <= quantity),
  CONSTRAINT maintenance_request_lines_cancel_ceiling_check
    CHECK (cancelled_quantity <= quantity),
  -- A write-off states why. Nothing cancelled, nothing to explain.
  CONSTRAINT maintenance_request_lines_cancel_shape_check
    CHECK ((cancelled_quantity > 0) = (cancellation_reason IS NOT NULL))
);

COMMENT ON TABLE maintenance_request_lines IS
  'What a maintenance request asked for. Only quantity, expected_return_quantity and cancelled_quantity are stored: available, reserved, dispatched and received-back are all derived, because the mock stores four numbers with no writer (migration 0088 header).';
COMMENT ON COLUMN maintenance_request_lines.production_item_id IS
  'The part from the item master, or NULL for a custom material. This column IS the mock''s itemType: a line that names a part moves stock when it is dispatched, and a line that does not has nothing on a shelf behind it.';
COMMENT ON COLUMN maintenance_request_lines.cancelled_quantity IS
  'The undispatched remainder written off with a reason. The one of the mock''s derived-looking columns that keeps a stored form, because without a writer for it the closure gate can never be satisfied on a line whose stock never arrives.';

CREATE INDEX maintenance_request_lines_request_idx
  ON maintenance_request_lines (organisation_id, maintenance_request_id, position);
CREATE INDEX maintenance_request_lines_item_idx
  ON maintenance_request_lines (organisation_id, production_item_id);

ALTER TABLE maintenance_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_request_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_request_lines_tenant_policy
  ON maintenance_request_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- UPDATE is granted for exactly one column pair — the cancellation — and
-- the guard below freezes everything else. No DELETE: a line that was
-- asked for and not sent is cancelled on the record, not erased from it.
GRANT SELECT, INSERT, UPDATE ON maintenance_request_lines TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 4. The dispatch numbering counter.
--
-- Per Work, as every challan series in this product is (0014's
-- `issue_challan_counters`, 0056's for delivery challans): the paper
-- carries the Work's code and the store's copies are filed by contract.
-- The eighth per-Work counter, and like the other seven it is exempt
-- from the supersession blocker list (0071's header states the rule).
-- ---------------------------------------------------------------------
CREATE TABLE maintenance_dispatch_counters (
  organisation_id uuid NOT NULL,
  work_id uuid NOT NULL,
  next_value integer NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, work_id),
  FOREIGN KEY (organisation_id, work_id) REFERENCES works(organisation_id, id)
);

COMMENT ON TABLE maintenance_dispatch_counters IS
  'Per Work, the next maintenance dispatch serial. Claimed by upsert rather than max()+1, and claimed first, so a rolled-back dispatch rolls its challan number back with it.';

ALTER TABLE maintenance_dispatch_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_dispatch_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_dispatch_counters_tenant_policy
  ON maintenance_dispatch_counters
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT, UPDATE ON maintenance_dispatch_counters TO auto_mb_app;

CREATE TRIGGER maintenance_dispatch_counters_guard_decrease
BEFORE UPDATE ON maintenance_dispatch_counters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_counter_decrease();

-- ---------------------------------------------------------------------
-- 5. The dispatch.
--
-- One issue of material against one request, and one piece of paper. It
-- is inserted already numbered — there is no draft, because there is
-- nothing to compose: the quantities come off lines that were approved
-- and the receiver signs on the spot.
--
-- APPEND-ONLY, and the grant is the enforcement, as 0087's ledger does
-- it. See the header for why there is no cancellation yet.
-- ---------------------------------------------------------------------
CREATE TABLE maintenance_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  maintenance_request_id uuid NOT NULL,

  -- Carried alongside the request so the per-Work counter and the
  -- challan number can be proven to belong to the same Work by a
  -- composite key rather than by a join nobody re-checks.
  work_id uuid NOT NULL,

  challan_number text NOT NULL CHECK (
    btrim(challan_number) = challan_number
    AND length(challan_number) BETWEEN 1 AND 60
  ),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),

  -- Date-only per engineering rule 6, bounded against the ORGANISATION's
  -- today by the guard below rather than the server's, so a dispatch
  -- recorded at 00:30 IST is not refused as being in the future.
  dispatch_date date NOT NULL,

  -- Snapshot labels on the paper. Neither participates in arithmetic:
  -- 0087 refused a warehouse dimension and this is not one.
  stock_location text NOT NULL CHECK (
    btrim(stock_location) = stock_location
    AND length(stock_location) BETWEEN 2 AND 200
  ),
  receiver_name text NOT NULL CHECK (
    btrim(receiver_name) = receiver_name
    AND length(receiver_name) BETWEEN 2 AND 200
  ),
  transporter text CHECK (
    transporter IS NULL OR length(btrim(transporter)) BETWEEN 2 AND 200
  ),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 2 AND 2000),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, maintenance_request_id, work_id)
    REFERENCES maintenance_requests(organisation_id, id, work_id)
);

COMMENT ON TABLE maintenance_dispatches IS
  'One issue of maintenance material and the paper that went with it. Inserted already numbered and append-only: there is no draft to compose and no cancellation yet (migration 0088 header, and docs/UX.md § 14).';

CREATE UNIQUE INDEX maintenance_dispatches_number_unique
  ON maintenance_dispatches (organisation_id, challan_number);
CREATE UNIQUE INDEX maintenance_dispatches_sequence_per_work
  ON maintenance_dispatches (organisation_id, work_id, sequence_number);
-- The request's own challan list, and the non-partial index leading on
-- the three-column foreign key above — `test/fk-index-coverage` measures
-- a key as covered only by an index that leads on its columns
-- unconditionally, so `work_id` sits before the sequence rather than
-- being left off. It costs nothing: `work_id` is constant within a
-- request, so the sequence still orders each request's challans.
CREATE INDEX maintenance_dispatches_request_idx
  ON maintenance_dispatches
     (organisation_id, maintenance_request_id, work_id, sequence_number);

ALTER TABLE maintenance_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_dispatches FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_dispatches_tenant_policy ON maintenance_dispatches
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT ON maintenance_dispatches TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 6. The dispatch lines.
--
-- How much of each material line went on this challan. One row per line
-- per dispatch — a second dispatch of the same line is a second challan,
-- which is what "partial dispatch" means on the mock's screen.
-- ---------------------------------------------------------------------
CREATE TABLE maintenance_dispatch_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  maintenance_dispatch_id uuid NOT NULL,
  maintenance_request_line_id uuid NOT NULL,

  quantity quantity_amount NOT NULL CHECK (quantity > 0),

  UNIQUE (organisation_id, id),
  -- One row per line per challan. Two rows would be two answers to "how
  -- much of this line went on this paper".
  UNIQUE (organisation_id, maintenance_dispatch_id, maintenance_request_line_id),

  FOREIGN KEY (organisation_id, maintenance_dispatch_id)
    REFERENCES maintenance_dispatches(organisation_id, id),
  FOREIGN KEY (organisation_id, maintenance_request_line_id)
    REFERENCES maintenance_request_lines(organisation_id, id)
);

COMMENT ON TABLE maintenance_dispatch_lines IS
  'How much of each material line went on one maintenance dispatch challan. The sum of these rows IS a line''s dispatched quantity; nothing stores that total separately.';

CREATE INDEX maintenance_dispatch_lines_line_idx
  ON maintenance_dispatch_lines (organisation_id, maintenance_request_line_id);

ALTER TABLE maintenance_dispatch_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_dispatch_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_dispatch_lines_tenant_policy
  ON maintenance_dispatch_lines
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT ON maintenance_dispatch_lines TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 7. The defective return.
--
-- The failed unit arriving back at the office. Append-only, and it posts
-- no stock movement: a broken unit on a repair bench is not available
-- material (header, § "THE DEFECTIVE RETURN POSTS NOTHING").
-- ---------------------------------------------------------------------
CREATE TABLE maintenance_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  maintenance_request_id uuid NOT NULL,
  maintenance_request_line_id uuid NOT NULL,

  quantity quantity_amount NOT NULL CHECK (quantity > 0),

  -- Date-only per rule 6: the day the office took delivery is a fact on
  -- a receipt, not a moment in a timezone.
  received_on date NOT NULL,

  serials text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(serials) <= 100)
    CHECK (array_position(serials, NULL) IS NULL)
    CHECK (array_position(serials, '') IS NULL),

  -- Free text, both of them, as the mock collects them. A typed
  -- disposition vocabulary is a real improvement and it needs somebody
  -- who repairs these units to write the list; inventing one here would
  -- be four words nobody chose.
  condition_note text NOT NULL CHECK (
    btrim(condition_note) = condition_note
    AND length(condition_note) BETWEEN 2 AND 500
  ),
  repair_disposition text NOT NULL CHECK (
    btrim(repair_disposition) = repair_disposition
    AND length(repair_disposition) BETWEEN 2 AND 200
  ),
  received_by text NOT NULL CHECK (
    btrim(received_by) = received_by AND length(received_by) BETWEEN 2 AND 200
  ),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 2 AND 2000),

  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  FOREIGN KEY (organisation_id, maintenance_request_id)
    REFERENCES maintenance_requests(organisation_id, id),
  FOREIGN KEY (organisation_id, maintenance_request_line_id)
    REFERENCES maintenance_request_lines(organisation_id, id)
);

COMMENT ON TABLE maintenance_returns IS
  'A defective unit received back at the office against a maintenance line. Append-only, and deliberately posts no stock movement: a unit on a repair bench is not available material.';

CREATE INDEX maintenance_returns_request_idx
  ON maintenance_returns (organisation_id, maintenance_request_id, received_on);
CREATE INDEX maintenance_returns_line_idx
  ON maintenance_returns (organisation_id, maintenance_request_line_id);

ALTER TABLE maintenance_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_returns FORCE ROW LEVEL SECURITY;

CREATE POLICY maintenance_returns_tenant_policy ON maintenance_returns
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

GRANT SELECT, INSERT ON maintenance_returns TO auto_mb_app;

-- ---------------------------------------------------------------------
-- 8. The stock ledger's new source document.
--
-- 0087 admits an `issue` that names a job card or a Work. A maintenance
-- dispatch is neither: it names a Work, but so would every unrelated
-- issue, and the ledger would then be unable to say which of a Work's
-- movements a given challan caused. One nullable column, with a writer
-- (`routes/maintenance.ts` posts it inside the dispatch transaction) and
-- a reader (the ledger's source label, and the dispatch's own detail).
--
-- The shape CHECK is rewritten rather than extended, because the
-- `issue` and `return` arms said "exactly one of two" and now say
-- "exactly one of three". Written as a count so a fourth source added
-- later is one more term rather than a truth table.
-- ---------------------------------------------------------------------
ALTER TABLE stock_movements
  ADD COLUMN maintenance_dispatch_id uuid,
  ADD CONSTRAINT stock_movements_maintenance_dispatch_fkey
    FOREIGN KEY (organisation_id, maintenance_dispatch_id)
    REFERENCES maintenance_dispatches(organisation_id, id);

COMMENT ON COLUMN stock_movements.maintenance_dispatch_id IS
  'The maintenance dispatch challan that took this material off the shelf (migration 0088). One of the three documents an issue may name, alongside a production job card and a bare Work.';

-- The non-partial leading index the foreign key needs
-- (`test/fk-index-coverage.integration.test.ts`), and the seek that
-- answers "which movements did this challan cause".
CREATE INDEX stock_movements_maintenance_dispatch_idx
  ON stock_movements (organisation_id, maintenance_dispatch_id);

ALTER TABLE stock_movements
  DROP CONSTRAINT stock_movements_source_shape_check;

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_source_shape_check CHECK (
    CASE movement_type
      WHEN 'production_receipt' THEN
        production_dispatch_id IS NOT NULL
        AND purchase_order_line_id IS NULL
        AND production_job_card_id IS NULL AND work_id IS NULL
        AND maintenance_dispatch_id IS NULL
        AND reason IS NULL
      WHEN 'purchase_receipt' THEN
        purchase_order_line_id IS NOT NULL
        AND production_dispatch_id IS NULL
        AND production_job_card_id IS NULL AND work_id IS NULL
        AND maintenance_dispatch_id IS NULL
        AND reason IS NULL
      WHEN 'issue' THEN
        (production_job_card_id IS NOT NULL)::int
        + (work_id IS NOT NULL)::int
        + (maintenance_dispatch_id IS NOT NULL)::int = 1
        AND production_dispatch_id IS NULL AND purchase_order_line_id IS NULL
        AND reason IS NULL
      WHEN 'return' THEN
        (production_job_card_id IS NOT NULL)::int
        + (work_id IS NOT NULL)::int
        + (maintenance_dispatch_id IS NOT NULL)::int = 1
        AND production_dispatch_id IS NULL AND purchase_order_line_id IS NULL
        AND reason IS NULL
      ELSE
        reason IS NOT NULL
        AND production_dispatch_id IS NULL AND purchase_order_line_id IS NULL
        AND production_job_card_id IS NULL AND work_id IS NULL
        AND maintenance_dispatch_id IS NULL
    END
  );

COMMENT ON CONSTRAINT stock_movements_source_shape_check ON stock_movements IS
  'Every movement names the document that caused it or carries a typed reason. Rewritten by 0088 to admit a maintenance dispatch as the third document an issue may name; the arms are counted rather than paired so a fourth source is one more term.';

-- ---------------------------------------------------------------------
-- 9. The guards.
--
-- Every rule below is made twice. `routes/maintenance.ts` makes it first,
-- under no lock, so an operator gets a named 409 with a remedy. These
-- make it again inside the write — the arm that holds when a writer
-- reaches the table by another path, and the arm that holds under
-- concurrency, which the route cannot.
--
-- `SET search_path` on every one, for the reason 0067, 0077, 0079, 0084
-- and 0087 all give: a function that resolves its own identifiers
-- through the caller's path is a rule a shadowing object in a writable
-- schema can rewrite. None is SECURITY DEFINER: every table touched is
-- one the caller may already read under RLS, and a definer function here
-- would read across tenants.
-- ---------------------------------------------------------------------

-- A line's outstanding approved quantity — the mock's `reservedQuantity`,
-- derived. Everything that needs to know how much of a line is still
-- owed reads THIS, so the dispatch ceiling and the closure gate cannot
-- be computed against two different ideas of the same number.
CREATE FUNCTION app_private.maintenance_line_outstanding(org uuid, line uuid)
RETURNS quantity_amount
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT (
    l.quantity - l.cancelled_quantity - coalesce(
      (
        SELECT sum(d.quantity)
        FROM maintenance_dispatch_lines d
        WHERE d.organisation_id = org AND d.maintenance_request_line_id = l.id
      ),
      0
    )
  )::quantity_amount
  FROM maintenance_request_lines l
  WHERE l.organisation_id = org AND l.id = line
$$;

COMMENT ON FUNCTION app_private.maintenance_line_outstanding(uuid, uuid) IS
  'What a maintenance line still owes the site: ordered less cancelled less dispatched. The mock stores this as reservedQuantity and never reduces it; here it is derived, so it cannot disagree with the challans that are its evidence.';

-- How many of a line's failed units are still owed back.
CREATE FUNCTION app_private.maintenance_line_return_due(org uuid, line uuid)
RETURNS quantity_amount
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT (
    l.expected_return_quantity - coalesce(
      (
        SELECT sum(r.quantity)
        FROM maintenance_returns r
        WHERE r.organisation_id = org AND r.maintenance_request_line_id = l.id
      ),
      0
    )
  )::quantity_amount
  FROM maintenance_request_lines l
  WHERE l.organisation_id = org AND l.id = line
$$;

COMMENT ON FUNCTION app_private.maintenance_line_return_due(uuid, uuid) IS
  'How many failed units a maintenance line still owes back: expected less received. The closure gate and the returns form read the same expression.';

-- A request may not be raised against a Work that has stopped taking
-- work. The same check `guard_issue_challan_insert` (0031) makes, for
-- the same reason: the challan this request will produce carries the
-- Work's code and its number comes out of the Work's series.
CREATE FUNCTION app_private.guard_maintenance_request_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  work_state text;
BEGIN
  SELECT w.status INTO work_state
  FROM works w
  WHERE w.organisation_id = NEW.organisation_id AND w.id = NEW.work_id;

  IF work_state IS NULL THEN
    RAISE EXCEPTION
      'request names Work %, which this transaction cannot read', NEW.work_id
      USING ERRCODE = '23G01';
  END IF;

  IF work_state <> 'active' THEN
    RAISE EXCEPTION
      'Work % is %, so it takes no new maintenance requests',
      NEW.work_id, work_state
      USING ERRCODE = '23G01';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER maintenance_requests_guard_insert
BEFORE INSERT ON maintenance_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_maintenance_request_insert();

-- The lifecycle, and the freeze around it.
--
-- Guards sort alphabetically before `…_touch_updated_at`, so a refused
-- write raises before `updated_at` moves — the ordering 0086 relies on
-- and states.
CREATE FUNCTION app_private.guard_maintenance_request_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  blocker text;
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION
      'maintenance request % is closed and cannot be reopened', OLD.request_number
      USING ERRCODE = '23G01';
  END IF;

  -- THE TERMS ARE FROZEN FROM THE MOMENT THE REQUEST IS RAISED. There is
  -- no draft state, so there is no window in which the fault, the site,
  -- the priority or the Work were ever editable. What may move is the
  -- status and the two evidence sets that record why it moved.
  IF ROW(
    NEW.organisation_id, NEW.work_id, NEW.request_number, NEW.financial_year,
    NEW.sequence_number, NEW.station, NEW.requester_name, NEW.requester_phone,
    NEW.priority, NEW.required_by, NEW.fault_summary, NEW.operational_impact,
    NEW.delivery_instructions, NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.work_id, OLD.request_number, OLD.financial_year,
    OLD.sequence_number, OLD.station, OLD.requester_name, OLD.requester_phone,
    OLD.priority, OLD.required_by, OLD.fault_summary, OLD.operational_impact,
    OLD.delivery_instructions, OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'a raised maintenance request is immutable; close it and raise the corrected one'
      USING ERRCODE = '23G05';
  END IF;

  -- The approval is written once and frozen behind the exemption that
  -- let it be written at all.
  IF OLD.approved_at IS NOT NULL
     AND ROW(NEW.approved_at, NEW.approved_by_user_id, NEW.approval_comment)
         IS DISTINCT FROM
         ROW(OLD.approved_at, OLD.approved_by_user_id, OLD.approval_comment)
  THEN
    RAISE EXCEPTION
      'a maintenance request''s approval is immutable once recorded'
      USING ERRCODE = '23G05';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'awaiting_approval' AND NEW.status = 'approved')
      OR (OLD.status = 'approved'
          AND NEW.status IN ('partially_dispatched', 'closed'))
      OR (OLD.status = 'partially_dispatched' AND NEW.status = 'closed')
    ) THEN
      RAISE EXCEPTION
        'a maintenance request cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = '23G01';
    END IF;
  END IF;

  -- THE CLOSURE GATE. Every line is settled — sent or written off — and
  -- every failed unit that was promised back has arrived. The mock draws
  -- this as a disabled button; a disabled button is a suggestion, and
  -- this is the rule.
  IF NEW.status = 'closed' THEN
    SELECT x.label INTO blocker FROM (
      SELECT 'no material lines' AS label
      WHERE NOT EXISTS (
        SELECT 1 FROM maintenance_request_lines l
        WHERE l.organisation_id = NEW.organisation_id
          AND l.maintenance_request_id = NEW.id)
      UNION ALL
      SELECT 'material still to dispatch or cancel'
      WHERE EXISTS (
        SELECT 1 FROM maintenance_request_lines l
        WHERE l.organisation_id = NEW.organisation_id
          AND l.maintenance_request_id = NEW.id
          AND app_private.maintenance_line_outstanding(
                NEW.organisation_id, l.id) > 0)
      UNION ALL
      SELECT 'defective units still owed back'
      WHERE EXISTS (
        SELECT 1 FROM maintenance_request_lines l
        WHERE l.organisation_id = NEW.organisation_id
          AND l.maintenance_request_id = NEW.id
          AND app_private.maintenance_line_return_due(
                NEW.organisation_id, l.id) > 0)
    ) x
    LIMIT 1;

    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION
        'maintenance request % cannot be closed: %', NEW.request_number, blocker
        USING ERRCODE = '23G04';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER maintenance_requests_guard_update
BEFORE UPDATE ON maintenance_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_maintenance_request_update();

CREATE TRIGGER maintenance_requests_touch_updated_at
BEFORE UPDATE ON maintenance_requests
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- A line's terms are frozen too; the cancellation is the one thing that
-- may be written, once, and only over quantity nobody has dispatched.
CREATE FUNCTION app_private.guard_maintenance_request_line_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  dispatched quantity_amount;
BEGIN
  IF ROW(
    NEW.organisation_id, NEW.maintenance_request_id, NEW.production_item_id,
    NEW.description, NEW.unit, NEW.quantity, NEW.purpose,
    NEW.expected_return_quantity, NEW.asset_serials, NEW.position, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organisation_id, OLD.maintenance_request_id, OLD.production_item_id,
    OLD.description, OLD.unit, OLD.quantity, OLD.purpose,
    OLD.expected_return_quantity, OLD.asset_serials, OLD.position, OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'a maintenance material line is immutable; cancel it and raise the corrected request'
      USING ERRCODE = '23G05';
  END IF;

  IF OLD.cancelled_quantity > 0 THEN
    RAISE EXCEPTION
      'this maintenance line is already written off; the cancellation is on the record'
      USING ERRCODE = '23G05';
  END IF;

  IF NEW.cancelled_quantity > 0 THEN
    SELECT coalesce(sum(d.quantity), 0) INTO dispatched
    FROM maintenance_dispatch_lines d
    WHERE d.organisation_id = NEW.organisation_id
      AND d.maintenance_request_line_id = NEW.id;

    IF NEW.cancelled_quantity > NEW.quantity - dispatched THEN
      RAISE EXCEPTION
        'cannot write off % of a line that has already sent % of %',
        NEW.cancelled_quantity, dispatched, NEW.quantity
        USING ERRCODE = '23G02';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER maintenance_request_lines_guard_update
BEFORE UPDATE ON maintenance_request_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_maintenance_request_line_update();

-- A dispatch happens against an approved request, on a real date, and
-- never after the request has been closed.
CREATE FUNCTION app_private.guard_maintenance_dispatch_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_status text;
BEGIN
  SELECT r.status INTO request_status
  FROM maintenance_requests r
  WHERE r.organisation_id = NEW.organisation_id
    AND r.id = NEW.maintenance_request_id;

  IF request_status IS NULL THEN
    RAISE EXCEPTION
      'dispatch names maintenance request %, which this transaction cannot read',
      NEW.maintenance_request_id
      USING ERRCODE = '23G01';
  END IF;

  IF request_status NOT IN ('approved', 'partially_dispatched') THEN
    RAISE EXCEPTION
      'maintenance request % is % and admits no dispatch',
      NEW.maintenance_request_id, request_status
      USING ERRCODE = '23G01';
  END IF;

  -- The organisation's today, not the server's (0082), for the reason
  -- 0087 gives: a dispatch recorded at 00:30 IST is not in the future.
  IF NEW.dispatch_date > app_private.organisation_today(NEW.organisation_id) THEN
    RAISE EXCEPTION
      'dispatch date % is in the future', NEW.dispatch_date
      USING ERRCODE = '23G01';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER maintenance_dispatches_guard_insert
BEFORE INSERT ON maintenance_dispatches
FOR EACH ROW EXECUTE FUNCTION app_private.guard_maintenance_dispatch_insert();

-- The dispatch ceiling, under the request line's row lock so two clerks
-- dispatching the last unit at the same moment serialise here rather
-- than both passing a check they each ran on a stale read.
CREATE FUNCTION app_private.guard_maintenance_dispatch_line_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  line_request uuid;
  dispatch_request uuid;
  outstanding quantity_amount;
BEGIN
  -- THE MUTEX, AND IT IS FIRST. Nothing below reads a dispatched total
  -- before this lock is held.
  SELECT l.maintenance_request_id INTO line_request
  FROM maintenance_request_lines l
  WHERE l.organisation_id = NEW.organisation_id
    AND l.id = NEW.maintenance_request_line_id
  FOR UPDATE;

  IF line_request IS NULL THEN
    RAISE EXCEPTION
      'dispatch line names material line %, which this transaction cannot read',
      NEW.maintenance_request_line_id
      USING ERRCODE = '23G01';
  END IF;

  SELECT d.maintenance_request_id INTO dispatch_request
  FROM maintenance_dispatches d
  WHERE d.organisation_id = NEW.organisation_id
    AND d.id = NEW.maintenance_dispatch_id;

  -- Both foreign keys are composite and tenant-safe, and neither proves
  -- the pair belong to the SAME request. A dispatch on request A
  -- carrying a line from request B would pass every constraint above and
  -- corrupt both requests' arithmetic.
  IF dispatch_request IS DISTINCT FROM line_request THEN
    RAISE EXCEPTION
      'material line % does not belong to the request this challan is against',
      NEW.maintenance_request_line_id
      USING ERRCODE = '23G01';
  END IF;

  outstanding := app_private.maintenance_line_outstanding(
    NEW.organisation_id, NEW.maintenance_request_line_id);

  IF NEW.quantity > outstanding THEN
    RAISE EXCEPTION
      'material line % has % left to dispatch, and this challan claims %',
      NEW.maintenance_request_line_id, outstanding, NEW.quantity
      USING ERRCODE = '23G02';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER maintenance_dispatch_lines_guard_insert
BEFORE INSERT ON maintenance_dispatch_lines
FOR EACH ROW EXECUTE FUNCTION app_private.guard_maintenance_dispatch_line_insert();

-- A defective return arrives against a line that owes one, and never
-- more than it owes.
CREATE FUNCTION app_private.guard_maintenance_return_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  line_request uuid;
  request_status text;
  due quantity_amount;
BEGIN
  SELECT l.maintenance_request_id INTO line_request
  FROM maintenance_request_lines l
  WHERE l.organisation_id = NEW.organisation_id
    AND l.id = NEW.maintenance_request_line_id
  FOR UPDATE;

  IF line_request IS NULL THEN
    RAISE EXCEPTION
      'return names material line %, which this transaction cannot read',
      NEW.maintenance_request_line_id
      USING ERRCODE = '23G01';
  END IF;

  IF line_request IS DISTINCT FROM NEW.maintenance_request_id THEN
    RAISE EXCEPTION
      'material line % does not belong to the request this return is against',
      NEW.maintenance_request_line_id
      USING ERRCODE = '23G01';
  END IF;

  SELECT r.status INTO request_status
  FROM maintenance_requests r
  WHERE r.organisation_id = NEW.organisation_id
    AND r.id = NEW.maintenance_request_id;

  IF request_status = 'awaiting_approval' THEN
    RAISE EXCEPTION
      'maintenance request % has not been approved, so nothing has gone out to come back',
      NEW.maintenance_request_id
      USING ERRCODE = '23G01';
  END IF;

  IF request_status = 'closed' THEN
    RAISE EXCEPTION
      'maintenance request % is closed', NEW.maintenance_request_id
      USING ERRCODE = '23G01';
  END IF;

  IF NEW.received_on > app_private.organisation_today(NEW.organisation_id) THEN
    RAISE EXCEPTION
      'receipt date % is in the future', NEW.received_on
      USING ERRCODE = '23G01';
  END IF;

  due := app_private.maintenance_line_return_due(
    NEW.organisation_id, NEW.maintenance_request_line_id);

  IF NEW.quantity > due THEN
    RAISE EXCEPTION
      'material line % owes % back, and this receipt claims %',
      NEW.maintenance_request_line_id, due, NEW.quantity
      USING ERRCODE = '23G03';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER maintenance_returns_guard_insert
BEFORE INSERT ON maintenance_returns
FOR EACH ROW EXECUTE FUNCTION app_private.guard_maintenance_return_insert();

-- ---------------------------------------------------------------------
-- 10. WORK SUPERSESSION: all seven tables are exempt, and this is where
--     the argument lives rather than only in the census.
--
-- 0071 withdraws a Work only when no document the agency issued, received
-- or is bound by hangs off it, and its blocker list is checked twice —
-- `app_private.guard_work_soft_delete()` in that migration, and
-- `DOWNSTREAM_REGISTERS` in `apps/server/src/work-supersede.ts`, with
-- `apps/server/test/work-supersede.integration.test.ts` asserting that
-- the set of `FROM <table> t` clauses in 0071's FILE equals the server
-- list exactly. A new blocker is therefore an edit to an applied
-- migration, which `packages/db/src/migration-runner.ts` rejects as
-- checksum drift. Every pack since 0071 — inspections, tenders,
-- production, correspondence, inventory — has been exempt for that
-- reason, and this one is too.
--
-- It is also the right answer, and correspondence (0086) gives it: a
-- maintenance request records a fault that exists on a platform, and
-- superseding a Work does not repair it. The dead display is still dead;
-- the store still owes it a power supply. Blocking would mean the first
-- spare part ordered against a Work closed the door on ever correcting
-- how that Work was read from its LOA — and re-reading a misread LOA is
-- what supersession is FOR.
--
-- The consequence, stated so it is not discovered later: a request whose
-- Work is withdrawn mid-flight stays dispatchable, and its challans keep
-- naming the withdrawn Work. That is deliberate. What is refused is
-- raising a NEW request against a Work that is no longer active, which
-- `app_private.guard_maintenance_request_insert` above does.
--
-- The two counters are numbering state rather than documents, exempt for
-- the reason 0071's header gives about the other seven per-Work
-- counters. `apps/server/src/work-supersede.ts` carries all seven
-- entries with these reasons.
-- ---------------------------------------------------------------------
