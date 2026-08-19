SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------
-- Migration 0104: three owner rulings taken on 2026-08-19.
--
-- Numbering: 0100, 0101 and 0102 stay reserved by the wave ledger and
-- 0103 is the statutory seed function, so this pack takes 0104. The
-- runner sorts file names and requires only that ids be unique
-- (`packages/db/src/migration-runner.ts`), so the gaps cost nothing.
--
-- Three rulings, one file, because all three are one owner session and
-- landing them as one drop is what makes the ledger readable a year from
-- now. They touch three different modules and share nothing, so each
-- section below stands alone and can be read alone.
--
--   § 1  Liquidated damages: the cap is a percentage of the WORK'S
--        CONTRACT VALUE, not of the operator's assessment basis, and the
--        contract's usual cap becomes 5%.
--   § 2  Notifications: an inbound STOP revokes consent, and a consent
--        recorded for staff at onboarding is a real register row.
--   § 3  Platform: nothing. The organisation-export window moved from
--        seven days to thirty, and it lives entirely in TypeScript —
--        `apps/server/src/routes/platform.ts`. Recorded here so a reader
--        looking for the third ruling in the migration finds the reason
--        it is not one rather than concluding it was forgotten.
--
-- WHAT THIS MIGRATION APPLIES TO. 0098 and 0092 are both APPLIED IN
-- PRODUCTION, which is why none of this is an edit to those files: the
-- rows they created already exist and this migration moves them. It
-- applies at a future drop, and § 1's back-fill is written for a table
-- that already holds assessments.
-- ---------------------------------------------------------------------

-- ═════════════════════════════════════════════════════════════════════
-- § 1. THE LIQUIDATED-DAMAGES CAP IS A PERCENTAGE OF THE CONTRACT VALUE
-- ═════════════════════════════════════════════════════════════════════
--
-- THE RULING, 2026-08-19, verbatim in substance: "LD is always calculated
-- on total contract value and maximum LD is capped at 5%; penalty clauses
-- for defective items not repaired within stipulated time or AMC
-- penalties have NO capping and are calculated separately per tender
-- clauses."
--
-- 0098 § 3 left this open and said so: `cap_amount` was
-- `basis_amount * ld_cap_percent / 100`, and `basis_amount` is a snapshot
-- the route defaults from `works.contract_value` but which an operator
-- may set LOWER — the late portion of a contract, for instance. The two
-- readings agree whenever the basis is the whole contract and diverge
-- whenever it is not, and 0098 capped at the smaller figure. `docs/UX.md`
-- § 21 recorded the visible consequence: a railway that levied the full
-- contractual maximum against a partial basis could not be recorded here,
-- because the levy exceeded the assessment and 23P06 refused it. The
-- ruling settles it the other way.
--
-- WHAT MOVES AND WHAT DOES NOT. Only the CEILING moves. The rate arm
-- still charges `basis_amount * rate * periods`, because `basis_amount`
-- with `basis_label` beside it is the record of what this assessment was
-- charged ON and an assessment charged on the late portion of a contract
-- is a real thing an agency records. What the ruling changes is the
-- ceiling that arm is held under: it is now the whole contract's cap
-- percentage, whatever the arm was computed on.
--
-- HOW, given that a generated column cannot reference another table.
-- `cap_amount` is generated and `works.contract_value` is on another row
-- of another table, so the value has to be ON this row before the
-- generation can see it. It is SNAPSHOTTED at assessment, which is not a
-- workaround but the discipline 0098 § 3 already holds for every other
-- input: `works.contract_value` is exactly the thing an amendment moves,
-- and an assessment that silently recomputed its own ceiling when a
-- variation order landed would be a levy nobody made.
--
-- So: one new stored column, filled by a trigger from the Work, frozen
-- afterwards, and the two generated columns re-derived from it.

ALTER TABLE ld_assessments
  ADD COLUMN contract_value_amount money_amount;

-- THE BACK-FILL IS `basis_amount`, NOT `works.contract_value`, and the
-- choice is the whole of engineering rule 7 in one statement.
--
-- Filling it from the Work would move `cap_amount` — and through it
-- `assessed_amount` — on every assessment already made against a partial
-- basis. Those are figures an agency has already put in front of a
-- railway. Rewriting them because a rule changed afterwards is precisely
-- the master-data edit rewriting history that rule 7 forbids, and it
-- would do it silently, to a money column, on rows in a terminal state.
--
-- `basis_amount` is what 0098's arithmetic used, so every existing row
-- keeps the exact cap and the exact assessment it already had. The ruling
-- governs assessments made from here on, which is what a ruling can
-- honestly govern.
UPDATE ld_assessments SET contract_value_amount = basis_amount;

ALTER TABLE ld_assessments
  ALTER COLUMN contract_value_amount SET NOT NULL,
  ADD CONSTRAINT ld_assessments_contract_value_positive
    CHECK (contract_value_amount > 0);

COMMENT ON COLUMN ld_assessments.contract_value_amount IS
  'The Work''s contract value as it stood when this assessment was made, snapshotted so the cap can be generated from it. Owner ruling of 2026-08-19: the liquidated-damages cap is a percentage of the whole contract, never of the assessment basis. Frozen afterwards, like every other input on this row — a variation order that moves the contract value does not move a levy already claimed. Rows written before 0104 carry their own basis_amount here, so their arithmetic is unchanged.';

-- PostgreSQL has no ALTER for a generation expression, so the two money
-- columns are dropped and re-added. Both are STORED GENERATED and neither
-- is referenced by a view, an index or a foreign key —
-- `work_retention_positions` reads `levied_amount` and `status` only — so
-- the drop takes nothing with it. Re-adding recomputes every row, and the
-- back-fill above is what makes that recomputation land on the values the
-- rows already held.
--
-- Column ORDER changes: both move to the end of the table. Every reader
-- in the product names its columns (`ASSESSMENT_COLUMNS` in
-- `apps/server/src/routes/retention-ledger.ts`), and the export writes
-- named columns too, so nothing depends on the position.
ALTER TABLE ld_assessments DROP COLUMN cap_amount;
ALTER TABLE ld_assessments DROP COLUMN assessed_amount;

ALTER TABLE ld_assessments
  -- The contractual maximum, in rupees: a percentage of the WHOLE
  -- contract, per the ruling.
  ADD COLUMN cap_amount money_amount GENERATED ALWAYS AS (
    round(contract_value_amount * ld_cap_percent / 100, 2)
  ) STORED,
  -- The assessment: the lesser of what the rate charges on the stated
  -- basis and the contract-wide ceiling. `least(...)` applied to the
  -- whole assessment and not to each period, which is what "subject to a
  -- maximum of N%" says — unchanged from 0098 except for what the second
  -- argument is a percentage of.
  ADD COLUMN assessed_amount money_amount GENERATED ALWAYS AS (
    least(
      round(
        basis_amount
        * ld_rate_percent
        / 100
        * ceil(
            greatest(assessed_to_date - scheduled_completion_date, 0)::numeric
            / ld_period_days
          ),
        2
      ),
      round(contract_value_amount * ld_cap_percent / 100, 2)
    )
  ) STORED;

COMMENT ON COLUMN ld_assessments.cap_amount IS
  'The contractual maximum in rupees: ld_cap_percent of the Work''s contract value as snapshotted on this row. Owner ruling of 2026-08-19 — a percentage of the whole contract, never of the assessment basis, so a railway that levied the full maximum against a partial basis is recordable.';
COMMENT ON COLUMN ld_assessments.assessed_amount IS
  'The lesser of rate x periods x basis and the contract-wide cap, in exact PostgreSQL numeric. Generated, so no route and no browser can compute a second answer; the inputs beside it are the frozen snapshot it was computed from.';

-- ── 1a. Filling and freezing the snapshot ────────────────────────────
--
-- A SEPARATE TRIGGER RATHER THAN A REPLACEMENT of 0098's
-- `guard_ld_assessment_write`, for the reason 0098 § 5b gives when it
-- takes the same branch against 0067's payment guard: re-creating another
-- migration's function puts this migration's name on rules it did not
-- write, and an additive trigger says exactly what it adds.
--
-- IT FIRES FIRST, and that is load-bearing rather than incidental.
-- Trigger order is alphabetical: `ld_assessments_contract_value_snapshot`
-- precedes `ld_assessments_touch_updated_at` and `ld_assessments_write_guard`.
-- The route never sends this column, so the snapshot has to be on NEW
-- before 0098's guard reads the row and before the generated columns are
-- computed at the end of the BEFORE chain.
--
-- THE COLUMN IS NEVER SUPPLIED BY A CALLER, on purpose. A route argument
-- would be a number the application could get wrong and a refusal the
-- database would have to make; taking it from the Work inside the
-- transaction that already locked that Work means there is no second
-- reading to disagree with.
--
-- 23P10 is the next free code in 0098's 23P block. It carries
-- `CONSTRAINT` like every other code in that block, so a log line names
-- the rule without anybody decoding the number.
CREATE FUNCTION app_private.snapshot_ld_contract_value()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_contract_value numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Frozen with the rest of the snapshot. 23P05 and 0098's own
    -- constraint name, because for an operator this is the same rule:
    -- the facts an assessment was computed from are written once.
    IF NEW.contract_value_amount IS DISTINCT FROM OLD.contract_value_amount THEN
      RAISE EXCEPTION
        'the contract value a liquidated-damages cap was computed from is written once; make a new assessment instead'
        USING ERRCODE = '23P05', CONSTRAINT = 'ld_assessment_frozen';
    END IF;
    RETURN NEW;
  END IF;

  SELECT w.contract_value INTO v_contract_value
  FROM works w
  WHERE w.organisation_id = NEW.organisation_id AND w.id = NEW.work_id;

  -- Not this trigger's refusal to make. 0098's guard runs next and names
  -- an unreadable Work with 23P07 and its own sentence; raising a second
  -- refusal for the same fact here would mean the operator met whichever
  -- trigger happened to sort first.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- A cap that is a percentage of nothing is zero, and a zero cap turns
  -- every assessment on the Work into zero rupees through `least(...)`.
  -- That is a silently wrong number rather than an error, which is why it
  -- is refused rather than stored. The route makes the same refusal first
  -- with a sentence naming the field.
  IF v_contract_value <= 0 THEN
    RAISE EXCEPTION
      'Work % carries no contract value, and the liquidated-damages cap is a percentage of it',
      NEW.work_id
      USING ERRCODE = '23P10', CONSTRAINT = 'ld_cap_basis_missing';
  END IF;

  NEW.contract_value_amount := v_contract_value;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app_private.snapshot_ld_contract_value() IS
  'Puts the Work''s contract value on a liquidated-damages assessment as it is written, so the cap can be generated from it, and freezes it afterwards. Owner ruling of 2026-08-19. Fires before 0098''s own guard, which is why it leaves an unreadable Work to that guard''s 23P07 rather than raising a second refusal for the same fact.';

CREATE TRIGGER ld_assessments_contract_value_snapshot
BEFORE INSERT OR UPDATE ON ld_assessments
FOR EACH ROW EXECUTE FUNCTION app_private.snapshot_ld_contract_value();

-- ── 1b. Five per cent is the figure the terms form steers to ─────────
--
-- The second half of the ruling. 0098 carried no default and the form's
-- hint said "usually 10%", which was the figure this codebase's examples
-- used. The ruling states 5%, and it is a DEFAULT rather than a CHECK
-- because tenders vary and a ceiling the product refused to record would
-- send the operator back to a spreadsheet on the one occasion the
-- difference mattered — the same reasoning 0098's header gives for
-- recording what the railway did rather than what the contract said.
--
-- The DEFAULT only fires for an INSERT that omits the column. The route
-- always sends all three LD terms explicitly, including an explicit NULL,
-- so a Work whose contract states no damages terms still records none:
-- an explicit NULL beats a DEFAULT. It is set here so that the schema
-- states the ruled figure rather than leaving it to a placeholder in a
-- form.
ALTER TABLE work_retention_terms
  ALTER COLUMN ld_cap_percent SET DEFAULT 5;

COMMENT ON COLUMN work_retention_terms.ld_cap_percent IS
  'The maximum liquidated damages, as a percentage of the Work''s CONTRACT VALUE (owner ruling of 2026-08-19; migration 0098 read it as a percentage of the assessment basis). Defaults to 5, the ruled figure, and is overridable because tenders vary. Snapshotted onto every assessment, so editing it never rewrites one already made.';

-- ── 1c. The uncapped penalties, which are not liquidated damages ─────
--
-- The third clause of the ruling: "penalty clauses for defective items
-- not repaired within stipulated time or AMC penalties have NO capping
-- and are calculated separately per tender clauses."
--
-- NOTHING IS ADDED FOR IT, AND THE ABSENCE IS THE POINT. The category
-- already exists and already has no cap:
--
--   * `bill_payment_deductions.category` has carried `PENALTY` since 0067
--     and kept it when 0080 added `LIQUIDATED_DAMAGES` beside it. 0080's
--     own column comment calls `PENALTY` "any other imposed recovery",
--     and `packages/contracts/src/statutory.ts` records why the two were
--     deliberately not merged.
--
--   * The cap lives entirely on `ld_assessments`, which only liquidated
--     damages ever reach. A `PENALTY` deduction is recorded on the
--     payment advice and touches no cap, no percentage and no assessment.
--
--   * `work_retention_positions.ld_deducted_total` filters
--     `d.category = 'LIQUIDATED_DAMAGES'`, so a penalty is not summed
--     into the LD position either.
--
--   * 23P06 — a levy may not exceed the assessment — is raised only by
--     `guard_ld_assessment_write`, on `ld_assessments`. It has never
--     applied to a penalty and does not now.
--
-- Adding a second uncapped category would have been a second place to
-- record the same fact, which is the defect 0087 and 0098 both refuse. So
-- the ruling is honoured by what the UI CALLS the existing head and by
-- the tests that hold the separation, not by a schema change. See
-- `packages/contracts/src/statutory.ts` § Railway-side deduction heads.

-- ═════════════════════════════════════════════════════════════════════
-- § 2. NOTIFICATIONS CONSENT: INBOUND STOP REVOKES, STAFF ARE RECORDED
-- ═════════════════════════════════════════════════════════════════════
--
-- THE RULING, 2026-08-19: "Employees: consent auto-recorded at onboarding
-- (mandatory by policy, still a visible register row). External contacts:
-- explicit opt-in required, inbound STOP auto-revokes and audits."
--
-- 0092 § THE WEBHOOK stated the open question exactly: "this receiver
-- reads the `statuses` array and ignores the `messages` array. Parsing a
-- reply means deciding what 'STOP' does to a consent row, and that is a
-- rule the owner has to state before it is coded." It is now stated.
--
-- THE REVOCATION APPLIES TO EVERY CONSENT, NOT ONLY TO EXTERNAL
-- CONTACTS, and that is a deliberate widening of the ruling's own split.
-- Meta requires an opt-out to be honoured whoever sends it, and a product
-- that ignored STOP from a number because the number happened to belong
-- to a member of staff would be putting the organisation's WhatsApp
-- Business account at risk to preserve a policy the organisation can
-- re-record in one click. So: anybody who texts STOP is opted out, and
-- the organisation records consent again at its own discretion, through
-- the register, with evidence.
--
-- ONLY THE STAFF HALF IS SCHEMA. The revocation is one SECURITY DEFINER
-- function here (the write crosses tenancy, exactly as the receipt writer
-- does) plus the parser in `apps/server/src/notify/transport.ts`. The
-- staff half needs no schema at all — it is a bulk action over the
-- existing register, argued in § 2b below.

-- ── 2a. What an inbound STOP does ────────────────────────────────────
--
-- SECURITY DEFINER FOR THE SAME REASON `record_notification_receipt` IS,
-- and no wider than it. The webhook is unauthenticated by construction:
-- Meta is not a member of anything, the organisation is not known until
-- the WABA phone number id has been resolved, and there is therefore no
-- tenant to bind before the write. 0092 argued this once and this
-- function inherits the argument; what it adds is that the write is
-- narrower still — it moves consents to `opted_out` and never to
-- `opted_in`, so the worst a forged call could do (past the HMAC the
-- route checks first) is stop this organisation sending messages.
--
-- IT NEVER CREATES A CONSENT ROW. An address nobody ever opted in is not
-- opted out; it is unknown, and recording an opt-out against a contact
-- that does not exist would be inventing a party. An unmatched address is
-- a no-op and a 200, because Meta must not retry a message it delivered
-- correctly to somebody this organisation has no record of.
--
-- THE AUDIT ROW IS WRITTEN HERE, in the same statement, and its actor is
-- NULL. `audit_events.actor_user_id` is nullable and this is what it is
-- for: no member did this. The recipient did, and the recipient is not a
-- user of this product. The reason rides in `details` so the register can
-- tell an inbound revocation from an office one.
--
-- `recorded_by_user_id` DELIBERATELY DOES NOT MOVE. It is a NOT NULL
-- column naming a member, and no member is available; overwriting it with
-- a sentinel would put a fake user id in a consent register that is a
-- legal record. The truth of who revoked is in `evidence`, which the
-- register prints, and in the audit row.
--
-- Answers, so the route can log honestly:
--   revoked          at least one live consent moved to opted_out
--   unmatched        the address is not opted in here; nothing to do
--   unknown_channel  no organisation on this cluster owns that number
CREATE FUNCTION app_private.record_notification_opt_out(
  p_phone_number_id text,
  p_from text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $$
DECLARE
  v_organisation_id uuid;
  v_address text;
  v_revoked integer;
BEGIN
  SELECT c.organisation_id INTO v_organisation_id
  FROM notification_channels c
  WHERE c.waba_phone_number_id = p_phone_number_id;

  IF v_organisation_id IS NULL THEN
    RETURN 'unknown_channel';
  END IF;

  -- Meta sends the sender as E.164 WITHOUT the leading plus
  -- ("919812345678"); `notification_consents.address` stores it WITH one,
  -- and its own CHECK enforces the shape. Normalising to digits and
  -- re-adding the plus makes both spellings match, and an address that is
  -- not a phone number at all simply matches nothing.
  v_address := '+' || regexp_replace(coalesce(p_from, ''), '[^0-9]', '', 'g');

  -- EVERY matching consent, not one. Two contacts may legitimately carry
  -- the same handset — a site office and the engineer who answers it —
  -- and an opt-out from that handset is an opt-out for the handset. The
  -- unique key is (organisation, contact, channel), so this is a set.
  WITH revoked AS (
    UPDATE notification_consents
    SET state = 'opted_out',
        evidence = 'Inbound STOP from this address; consent revoked automatically.'
    WHERE organisation_id = v_organisation_id
      AND channel = 'whatsapp'
      AND address = v_address
      AND state = 'opted_in'
    RETURNING id, contact_id
  )
  INSERT INTO audit_events (
    organisation_id, actor_user_id, action, entity_type, entity_id, details
  )
  SELECT
    v_organisation_id,
    NULL,
    'notification_consent.revoked',
    'notification_consents',
    revoked.id,
    jsonb_build_object(
      'channel', 'whatsapp',
      'state', 'opted_out',
      'reason', 'inbound stop',
      'contactId', revoked.contact_id
    )
  FROM revoked;

  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  RETURN CASE WHEN v_revoked > 0 THEN 'revoked' ELSE 'unmatched' END;
END
$$;

ALTER FUNCTION app_private.record_notification_opt_out(text, text)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.record_notification_opt_out(text, text)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.record_notification_opt_out(text, text)
      TO auto_mb_app;
  END IF;
  -- BYPASSRLS lifts the POLICY and never the table privilege, so the
  -- definer role needs the grant even though it owns the function. As
  -- narrow as the function is: it reads and moves consent rows and does
  -- not create or delete one. `audit_events` is already granted
  -- SELECT, INSERT to this role by migration 0004 and repaired by
  -- `packages/db/src/bootstrap.ts`.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_definer') THEN
    GRANT SELECT, UPDATE ON notification_consents TO auto_mb_definer;
  END IF;
END
$$;

COMMENT ON FUNCTION app_private.record_notification_opt_out(text, text) IS
  'The second write that crosses tenancy for the notifications lane: an inbound STOP from a recipient, applied to every live consent on that address in the organisation that owns the WABA number, with an audit row whose actor is NULL because no member did it. Owner ruling of 2026-08-19. Only ever moves a consent to opted_out and never creates one — an address nobody opted in is unmatched, which is a 200 and never a retry.';

-- ── 2b. Consent recorded for staff at onboarding ─────────────────────
--
-- NO SCHEMA, and the reason is worth stating because the alternative
-- looks like the obvious one.
--
-- The ruling asks that an employee's consent be recorded automatically
-- when they gain a messaging address, and the apparent place for that is
-- the employee write path. It is the wrong place here, for three reasons
-- that are facts about this schema rather than preferences:
--
--   1. An employee has no address. `employees` (0089) carries no phone
--      and no email at all — it is a satellite on `contacts`, and the
--      phone and email are `contacts.phone` and `contacts.email` (0028).
--      An employee create or update never sees an address, so there is no
--      moment on that path at which one is "gained".
--
--   2. The addresses are not interchangeable. `contacts.phone` is free
--      text of 3 to 30 characters; `notification_consents.address` for
--      WhatsApp must satisfy `^\+[1-9][0-9]{7,14}$`. A hook that wrote a
--      consent from whatever was in `contacts.phone` would fail the CHECK
--      on ordinary data and take the employee write down with it.
--
--   3. The authorities differ. `POST /api/employees` carries the payroll
--      authority; the consent register carries the notifications
--      authority, and it carries it because the register is a list of
--      personal telephone numbers. Writing one from the other would let
--      the payroll authority create rows the notifications authority
--      exists to protect.
--
-- So the honest minimum is a bulk action on the register itself —
-- `POST /api/notification-consents/staff`, writer role and notifications
-- authority — which records an opted-in consent for every active staff
-- contact carrying a usable address on that channel, with the source
-- named in the evidence and one audit row per consent. It writes nothing
-- where a consent already exists, so a member of staff who texted STOP
-- stays opted out until somebody records consent for them deliberately.
--
-- Nothing in the schema needs to change for it: it is INSERT ... ON
-- CONFLICT DO NOTHING over the table 0092 already created, under the
-- authority 0092 already requires. `docs/UX.md` § 17 records the choice.
