SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0078: the three master-data records the redesign asks for and
-- the schema had nowhere to put — a contact's payment beneficiary details,
-- the organisation's own bank accounts, and a canonical item catalogue.
--
-- All three come from the v0 mock at fdfe5ef, which is the binding UI
-- contract (AGENTS.md § Design contract): `components/contact-form-dialog`
-- carries a "Bank details" block on the contact form, `app/settings/page`
-- puts a "Company bank accounts" card inside the Company tab, and
-- `app/masters/page` opens on an Items tab the application has no table
-- behind. The admin pack (pull request #107) found all three unsupported.
--
-- Each of the three is shaped by what the mock actually shows, and the
-- shapes are deliberately different from one another. The reasoning is
-- recorded per section rather than in one paragraph here, because the
-- three answers are independent and a reader arriving at one of them
-- should not have to read the other two.

-- ---------------------------------------------------------------------
-- 1. A contact's bank beneficiary details: COLUMNS, not a table.
--
-- The owner's decision was explicit — bank fields live on the contact
-- form, not behind a tab of their own — and the mock's form says the same
-- thing: six inputs under a "Bank details" divider captioned "Used when
-- this contact is selected as a payment beneficiary." One contact, one
-- beneficiary, one form. A child table would model a plurality neither
-- the decision nor the form has, and would make the ordinary read (fill a
-- payment instruction for this vendor) a join.
--
-- SHAPE VALIDATION IS TWO-LAYERED, as it is for the GSTIN this table
-- already carries. `apps/server/src/contact-fields.ts` normalises and
-- refuses at the trust boundary with a sentence an operator can act on;
-- the CHECKs below bind the same shapes against a writer that never went
-- through the route. The route is where the message lives, the database
-- is where the guarantee lives, and 0028 established that split for this
-- exact table.
--
-- The IFSC shape is the RBI's: four letters naming the bank, a fixed '0'
-- reserved for future use, and six alphanumerics naming the branch.
--
-- The account-number shape is deliberately WIDER than the NPCI 9-to-18
-- digit range a validator would reach for first. Indian account numbers
-- are not uniformly numeric or uniformly long — cooperative and older
-- district banks issue shorter and occasionally alphanumeric numbers, and
-- refusing a real account is a worse failure here than accepting an
-- unlikely-looking one.
--
-- The AT LEAST ONE DIGIT clause is what keeps that width honest, and it
-- is not decorative: the route strips the spaces and hyphens a passbook
-- prints, which turns the note "ASK RAMESH" into a nine-character
-- all-letter string that a plain [0-9A-Z]{6,18} accepts. No bank issues
-- an account identified purely by letters, so a value with no digit in it
-- is prose. With the clause, the shape refuses everything an optional
-- field actually collects: "n/a", "---", a note, a second account after a
-- slash.
--
-- The four PAYABLE fields travel together. An account number without an
-- IFSC cannot be paid to and a holder name alone is not a beneficiary, so
-- the CHECK admits all four or none of them; branch and account type are
-- decoration on a payment advice and stay independently optional. This is
-- the same guard the mock's own dialog applies before it will add a row.
-- ---------------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN bank_account_holder text
    CHECK (bank_account_holder IS NULL
           OR length(btrim(bank_account_holder)) BETWEEN 2 AND 200),
  ADD COLUMN bank_name text
    CHECK (bank_name IS NULL OR length(btrim(bank_name)) BETWEEN 2 AND 100),
  ADD COLUMN bank_account_number text
    CHECK (bank_account_number IS NULL OR bank_account_number ~ '^(?=.*[0-9])[0-9A-Z]{6,18}$'),
  ADD COLUMN bank_ifsc text
    CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  ADD COLUMN bank_branch text
    CHECK (bank_branch IS NULL OR length(btrim(bank_branch)) BETWEEN 2 AND 100),
  ADD COLUMN bank_account_type text
    CHECK (bank_account_type IS NULL
           OR length(btrim(bank_account_type)) BETWEEN 2 AND 50);

ALTER TABLE contacts
  ADD CONSTRAINT contacts_bank_details_shape_check
  CHECK (
    (
      bank_account_holder IS NULL
      AND bank_name IS NULL
      AND bank_account_number IS NULL
      AND bank_ifsc IS NULL
    )
    OR
    (
      bank_account_holder IS NOT NULL
      AND bank_name IS NOT NULL
      AND bank_account_number IS NOT NULL
      AND bank_ifsc IS NOT NULL
    )
  );

COMMENT ON COLUMN contacts.bank_account_number IS
  'The beneficiary account number, uppercased. Six to eighteen alphanumerics rather than the NPCI 9-to-18 digit range: cooperative and older district banks issue shorter and occasionally alphanumeric numbers, and refusing a real account is worse than accepting an unlikely one. Never written to an audit event or a log.';
COMMENT ON CONSTRAINT contacts_bank_details_shape_check ON contacts IS
  'Holder, bank, account number and IFSC are all present or all absent — a partial set is not a beneficiary anyone can be paid as. Branch and account type stay independently optional.';

-- ---------------------------------------------------------------------
-- 2. The organisation's own bank accounts: a TABLE, because the mock's
--    card is a list.
--
-- Section 1 gave a contact columns because its form holds one beneficiary.
-- The Company tab's card is the opposite shape and gets the opposite
-- answer: `components/company-bank-accounts` renders rows with an "Add
-- account" dialog above them, so an organisation has as many of these as
-- it has told us about, and columns on `organisations` would model one.
--
-- WHAT IS NOT HERE, and why:
--
--   * `primary`. The mock renders a Primary badge on one row and offers no
--     control that could move it, and nothing in the product chooses an
--     account yet — no template prints bank details, no payment advice
--     names one. A stored flag would be configuration with no reader and
--     no writer. The web card badges the oldest live account instead,
--     which puts the badge on exactly one row and is true of what "the
--     account we set up first" means. When something has to CHOOSE, it
--     will need a column, and adding one then is a smaller change than
--     maintaining one now.
--
--   * DELETE. Masters retire via the active flag here (0013, 0028, 0048),
--     and this is a master. The application role gets no DELETE grant.
--
-- The four payable fields are NOT NULL rather than jointly checked as in
-- section 1: a contact may legitimately have no bank details at all, and
-- a row in this table exists only because somebody added a bank account.
-- ---------------------------------------------------------------------
CREATE TABLE organisation_bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  account_holder text NOT NULL
    CHECK (length(btrim(account_holder)) BETWEEN 2 AND 200),
  bank_name text NOT NULL CHECK (length(btrim(bank_name)) BETWEEN 2 AND 100),
  -- Same two shapes as section 1, for the same reasons, bound the same way.
  account_number text NOT NULL CHECK (account_number ~ '^(?=.*[0-9])[0-9A-Z]{6,18}$'),
  ifsc text NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  branch text CHECK (branch IS NULL OR length(btrim(branch)) BETWEEN 2 AND 100),

  active boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id)
);

COMMENT ON TABLE organisation_bank_accounts IS
  'Bank accounts the organisation owns, for printing on invoices and receiving payment. A list rather than columns on organisations because the Company settings card is a list. Retires via the active flag; the application role holds no DELETE.';

-- One live row per (branch, account). Adding the same account twice is
-- the mistake this catches; a RETIRED row does not block re-adding the
-- account it names, which is how an account retired in error comes back.
CREATE UNIQUE INDEX organisation_bank_accounts_live_account
  ON organisation_bank_accounts (organisation_id, ifsc, account_number)
  WHERE active;

CREATE TRIGGER organisation_bank_accounts_touch_updated_at
BEFORE UPDATE ON organisation_bank_accounts
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE organisation_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_bank_accounts FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- evaluates it once per statement rather than once per row.
CREATE POLICY organisation_bank_accounts_tenant_policy ON organisation_bank_accounts
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON organisation_bank_accounts TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 3. The canonical item catalogue.
--
-- The mock's Items tab states its own purpose: "Canonical items group
-- differently worded tender lines so they can be searched and compared
-- across Works." That is not `work_items` renamed. A work item is a line
-- of one Work's sanctioned schedule, worded however that tender worded it
-- — "Ahuja UHC-30 XT horn speaker", "30 watt outdoor horn speaker",
-- "Horn type loudspeaker 30W" are three schedule lines naming one product
-- across three Works, and nothing in the schema says so. This table is
-- where an organisation says so.
--
-- WHAT IS DELIBERATELY NOT MODELLED:
--
--   * An `item_groups` table. The mock groups items and renders the group
--     as a Badge; a group is a label, and the distinct labels in this
--     column are the group list. A second table would buy referential
--     tidiness at the cost of a join, a second master screen, and a
--     rename path — for a string on a badge.
--
--   * A `canonical_item_id` column on `work_items`, which is the obvious
--     way to count "mapped lines" and is the wrong one here. It would need
--     a writer, and the mock has no mapping control anywhere: the Items
--     tab shows a COUNT and a warning, and nothing in it assigns a
--     schedule line to a canonical item. A nullable foreign key with no
--     writer is dead flexibility, and the counts it fed would all read
--     zero.
--
--     So the mapping is DERIVED from the aliases, which is what the mock's
--     own sentence says the aliases are for: a schedule line is mapped to
--     a canonical item when its description matches that item's name or
--     one of its aliases, compared lowercased and trimmed. Nothing has to
--     be maintained, the counts move on their own as Works arrive, and the
--     operator's lever — add the wording you actually saw as an alias — is
--     the one control the mock draws.
--
--     The ceiling of that choice, stated plainly: matching is EXACT on the
--     normalised string, not fuzzy. A line differing by a comma is
--     unmapped until somebody adds its wording. Trigram or embedding
--     matching is the upgrade, and it belongs behind a review step rather
--     than silently claiming lines; see `apps/server/src/routes/masters.ts`.
--
-- Aliases are a text[] rather than a child table for the same reason the
-- group is a column: they are read and written as one list, always with
-- their item, and never queried on their own.
-- ---------------------------------------------------------------------
CREATE TABLE canonical_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  -- The group label, rendered as a badge. See the header for why this is
  -- not a foreign key.
  group_name text NOT NULL CHECK (length(btrim(group_name)) BETWEEN 2 AND 100),
  make text CHECK (make IS NULL OR length(btrim(make)) BETWEEN 1 AND 100),
  model text CHECK (model IS NULL OR length(btrim(model)) BETWEEN 1 AND 100),
  -- Free text rather than a foreign key to unit_masters: the mock prints
  -- it as a mono string and this is a suggestion for a form default, not
  -- a value any document is validated against.
  default_unit text NOT NULL CHECK (length(btrim(default_unit)) BETWEEN 1 AND 20),

  -- The wordings that mean this item. Bounded so a paste accident cannot
  -- put a schedule in here, and non-empty per element so a blank alias
  -- cannot match a blank description.
  aliases text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(aliases) <= 50)
    CHECK (array_position(aliases, NULL) IS NULL)
    CHECK (array_position(aliases, '') IS NULL),

  active boolean NOT NULL DEFAULT true,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id)
);

COMMENT ON TABLE canonical_items IS
  'An organisation''s catalogue of the products behind its differently worded schedule lines. Mapping to work_items is DERIVED by matching a line description against this row''s name and aliases, lowercased and trimmed; there is no stored link (migration 0078).';
COMMENT ON COLUMN canonical_items.aliases IS
  'Other wordings that mean this item. The mapping mechanism, not decoration: a schedule line counts as mapped when its normalised description equals the normalised name or one of these.';

-- One canonical item per name, case- and space-insensitively. Two rows
-- claiming the same wording would both count the same schedule lines.
CREATE UNIQUE INDEX canonical_items_name_per_org
  ON canonical_items (organisation_id, lower(btrim(name)));

-- The list query orders by group then name.
CREATE INDEX canonical_items_group_idx
  ON canonical_items (organisation_id, lower(btrim(group_name)), lower(btrim(name)));

CREATE TRIGGER canonical_items_touch_updated_at
BEFORE UPDATE ON canonical_items
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE canonical_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_items FORCE ROW LEVEL SECURITY;

CREATE POLICY canonical_items_tenant_policy ON canonical_items
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- Masters retire via the active flag; no DELETE, as for every master
-- since 0013.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON canonical_items TO auto_mb_app;
  END IF;
END
$$;
