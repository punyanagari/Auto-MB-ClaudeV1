SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0095: reading the audit trail, and saying how long it is kept.
--
-- `audit_events` has existed since 0001 and is written by every mutating
-- route in the product. Nothing has ever READ it across the organisation:
-- `routes/timeline.ts` reads one Work's trail and one record's history,
-- both scoped by `assertWorkAccess`, and the file says so in as many words
-- ("This is NOT organisation-wide audit search"). This migration adds the
-- two facts an organisation-wide reader needs and nothing else.
--
-- NO NEW TABLE. The register reads `audit_events` exactly as it stands,
-- through the index 0001 already built for the timeline
-- (`audit_events_timeline_idx (organisation_id, occurred_at DESC, id)`),
-- which leads with the register's own sort key so a date window seeks
-- inside it. Two columns are added to tables that already exist, and one
-- SECURITY DEFINER function is restated.
--
-- ---------------------------------------------------------------------
-- 1. The authority.
--
-- Owner ruling of 2026-08-18, following the `can_manage_payments` (0080),
-- `can_manage_payroll` (0089) and `can_sign_documents` (0091) precedents
-- exactly: a new explicit per-member grant, defaulting to false,
-- deliberately NOT backfilled, granted per member by an owner.
--
-- WHY IT IS NOT COVERED BY THE WRITER ROLE. The per-Work timeline is open
-- to every member whose scope reaches the Work, viewers included, and that
-- stays true — it shows a Work's own history to the people working on it.
-- The organisation-wide register is a different object: it answers "what
-- did this person do", across every Work, every module and every member,
-- and it prints the before/after of each change. That is a surveillance
-- surface over colleagues, and the payroll precedent already settled that
-- a READ can be sensitive enough to need its own grant. An office member
-- who drafts challans has no default business reading the actions of the
-- member who runs payroll.
--
-- AND THE REGISTER ADDITIONALLY REQUIRES FULL WORK SCOPE. Two walls, both
-- checked on every read (`routes/audit.ts`): the authority, and
-- `hasFullWorkScope`.
--
-- The second wall is the more interesting one, because the obvious
-- alternative — narrow the register to the assigned member's own Works, as
-- every other cross-Work register does — is both more expensive and less
-- honest here. `audit_events` carries no `work_id`; the only way to ask
-- which Work an event belongs to is the twenty-five-arm entity-to-Work
-- mapping `routes/timeline.ts` maintains for the per-Work trail, and that
-- mapping covers the entity types a WORK has. It does not cover a member
-- being added, a GST rate being changed, an organisation profile being
-- edited, or any of the other organisation-level facts the register exists
-- to show. An assigned-scope reader would therefore get a register that
-- silently omitted most of its own subject matter while looking complete —
-- a cross-Work oversight screen showing a slice, with nothing on it saying
-- so. A member who should see one Work's history already has a complete
-- and honest view of it on that Work's Timeline tab, so the refusal costs
-- them nothing and names where to go.
ALTER TABLE organisation_memberships
  ADD COLUMN can_view_audit_trail boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organisation_memberships.can_view_audit_trail IS
  'Authority to open the organisation-wide audit register (0095) and to export it. Separate from the writer role because the register answers "what did this person do" across every Work and every module and prints the before/after of each change, which is a different secret from being allowed to draft a challan. It additionally requires full work scope: an assigned-scope reader would get a silent slice, because audit_events carries no work_id and the Work mapping does not cover organisation-level facts. Not backfilled: an owner grants it per member. MFA-required, like every grant this table carries.';

-- The owner of a NEW organisation holds it implicitly, exactly as it holds
-- every other authority.
--
-- CREATE OR REPLACE STATES THE WHOLE BODY RATHER THAN AMENDING IT, so this
-- restates every grant its predecessors added. 0089 added
-- can_manage_payroll and 0091 added can_sign_documents on top of 0004's
-- issue and cancel; 0091's own comment records what it costs to forget one
-- — a founder who cannot use a feature in the organisation they just
-- created, with no error anywhere, because nothing refuses a column left
-- false. This is the fourth restatement and the same rule applies to the
-- next.
--
-- AND IT CARRIES TWO GRANTS THAT ARE NOT THIS PACK'S. Migrations 0092
-- (can_manage_notifications) and 0094 (can_import_data) replace this same
-- function earlier in the same wave, and 0095 runs after both, so this body
-- is the one that survives — a plain restatement of only this pack's
-- columns would silently revoke theirs from every organisation created
-- afterwards. They are set through the guarded loop below rather than named
-- in the INSERT above, because this file must also apply to a database that
-- does NOT have those columns: its own branch before the train is
-- assembled, and any rollback that drops a sibling migration. The list is a
-- CLOSED LITERAL, never the catalog — a new authority must not become
-- granted-by-default just by existing, which is the rule
-- `apps/server/src/authz.ts` states about silent defaults.
--
-- ponytail: delete the loop and add the two columns to the INSERT once
-- 0092 and 0094 are on main and no supported database lacks them.
--
-- This is NOT a backfill: it reaches new organisations only. An owner of an
-- organisation that already exists self-grants the authority on the Members
-- screen, exactly as they would grant any other.
CREATE OR REPLACE FUNCTION app_private.create_organisation_with_owner(
  p_name text,
  p_slug text,
  p_id uuid DEFAULT gen_random_uuid()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
DECLARE
  v_user_id text;
  v_column text;
BEGIN
  v_user_id := nullif(current_setting('app.user_id', true), '');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'organisation creation requires an authenticated user context'
      USING ERRCODE = '28000';
  END IF;

  INSERT INTO organisations (id, name, slug) VALUES (p_id, p_name, p_slug);

  INSERT INTO organisation_memberships (
    organisation_id, user_id, role, work_scope,
    can_issue_documents, can_cancel_documents, can_sign_documents,
    can_manage_payroll, can_view_audit_trail, status
  )
  VALUES (p_id, v_user_id, 'owner', 'all', true, true, true, true, true, 'active');

  -- The sibling authorities of this wave, each granted only where its
  -- column exists. See the note above the function for why this is a loop
  -- over a literal list rather than two more values in the INSERT.
  FOR v_column IN
    SELECT name
    FROM unnest(ARRAY['can_manage_notifications', 'can_import_data']) AS name
    WHERE EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.organisation_memberships'::regclass
        AND attname = name AND attnum > 0 AND NOT attisdropped
    )
  LOOP
    EXECUTE format(
      'UPDATE organisation_memberships SET %I = true'
      || ' WHERE organisation_id = $1 AND user_id = $2',
      v_column
    ) USING p_id, v_user_id;
  END LOOP;

  INSERT INTO audit_events (
    organisation_id, actor_user_id, action, entity_type, entity_id
  )
  VALUES (p_id, v_user_id, 'organisation.created', 'organisations', p_id);

  RETURN p_id;
END
$$;

-- CREATE OR REPLACE keeps the existing owner and grants, but says so
-- explicitly rather than relying on that: this function is SECURITY
-- DEFINER, and a definer function that silently changed hands would be a
-- privilege change nobody reviewed. Same three statements 0091 wrote, for
-- the same reason.
ALTER FUNCTION app_private.create_organisation_with_owner(text, text, uuid)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.create_organisation_with_owner(text, text, uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION
      app_private.create_organisation_with_owner(text, text, uuid) TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. The retention policy, and the honest name for the mechanism.
--
-- THE POLICY IS A VIEWING AND EXPORT WINDOW. IT DELETES NOTHING. That is a
-- deliberate design decision rather than an unfinished one, and it is
-- recorded here because "retention policy" normally implies a purge and
-- this one has none.
--
-- Three reasons, in the order they decide it:
--
--   1. THE LAW FORBIDS THE PURGE. Rule 3(1) of the Companies (Accounts)
--      Rules, as amended for the audit-trail mandate, requires the audit
--      trail to be preserved for the period section 128 of the Companies
--      Act 2013 sets for the books of account: eight financial years. A
--      product whose "retention" feature quietly destroyed the record its
--      customers are legally required to keep would be shipping a
--      compliance defect as a configuration option. So the floor below is
--      96 months and the column can only ever be raised above it.
--
--   2. THE APPLICATION ROLE CANNOT DELETE, BY DESIGN. Migration 0002
--      revoked UPDATE, DELETE and TRUNCATE on `audit_events` from
--      `auto_mb_app` and called the table append-only in the same breath.
--      Implementing a purge means handing the application a definer
--      function that erases audit history — that is, giving the code that
--      is being audited the ability to edit its own trail. The whole value
--      of an append-only grant is that no application bug and no stolen
--      session can reach past it, and a purge job is a door through it
--      that would exist all the time to be used once a year.
--
--   3. THE EXPORT WOULD STOP BEING A RECORD. `routes/export.ts` publishes
--      `auditEvents` as a section of the organisation's own portability
--      package, and `test/integrity.integration.test.ts` fails the build
--      when a tenant table has no section. A package whose trail had been
--      purged is a package you cannot reconstruct the account's history
--      from.
--
-- What the column therefore configures is what the PRODUCT SHOWS: the
-- audit register's date filter will not reach further back than the
-- window, and neither will its export. The rows stay. An organisation that
-- must destroy history for a reason the law recognises does it through the
-- documented database procedure with the definer role, under review, not
-- through a screen.
--
-- 96 months is also the default, so an organisation that never opens the
-- setting is already on the statutory figure rather than on a number
-- chosen to look tidy. The ceiling of 600 months (fifty years) is a
-- sanity bound on a free integer, not a policy.
ALTER TABLE organisations
  ADD COLUMN audit_retention_months integer NOT NULL DEFAULT 96
    CONSTRAINT organisations_audit_retention_months_check
      CHECK (audit_retention_months BETWEEN 96 AND 600);

COMMENT ON COLUMN organisations.audit_retention_months IS
  'How far back the audit register and its exports may look, in months (0095). A VIEWING WINDOW, not a purge: nothing is ever deleted from audit_events, because Rule 3(1) of the Companies (Accounts) Rules requires the trail to be preserved for the section 128 period (eight financial years, hence the floor of 96) and because 0002 revoked DELETE on the table from the application role on purpose. The route schema refuses a value outside the range first; this CHECK is the backstop that must never fire.';
