SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

-- Migration 0096: the platform controls — three operator surfaces that
-- have nothing to do with contract execution and everything to do with
-- running the product for an organisation.
--
--   organisation_entitlements     which modules this organisation may use
--   statutory_job_schedules       which recurring checks run, and when
--   organisation_export_requests  the organisation's own copy of itself
--
-- They are one migration because they are one screen (docs/UX.md § 20)
-- and one authority pair, not because they share a table.
--
-- ---------------------------------------------------------------------
-- WHAT AN ENTITLEMENT IS, AND WHAT IT IS NOT.
--
-- It is NOT a permission. `AGENTS.md` forbids replacing the per-feature
-- permission matrix with a role system, and nothing here comes near it: a
-- membership says what a PERSON may do, and an entitlement says whether a
-- MODULE is available to the organisation at all. The two compose — a
-- member holding `can_manage_statutory_reporting` in an organisation whose
-- `eway_bill` entitlement is off is refused, and so is an owner — and
-- neither can stand in for the other.
--
-- The reason it exists is procurement, not product. Two modules on `main`
-- today are finished code waiting on somebody else's paperwork: the e-way
-- bill module cannot be used in production until NIC re-certification
-- lands, and outbound signing cannot until the ESP/TSA procurement of
-- ADR-0012 completes. Before this migration the only ways to express
-- "built, but this organisation must not use it yet" were a deployment
-- flag (wrong: it is per-organisation, not per-installation) and not
-- deploying the code (wrong: it is deployed, and the other organisations
-- want it).
--
-- BOTH FLAGS DEFAULT TO ENABLED, which is the opposite of what the
-- procurement story suggests and is deliberate. This migration must not
-- change the behaviour of any organisation on the day it applies; a
-- default of `false` would switch off two live modules for every existing
-- tenant as a side effect of shipping a mechanism. Turning them off is an
-- operator act with a note attached, and flipping the shipped default is a
-- one-line migration on the day the owner decides to. The default lives in
-- `apps/server/src/entitlements.ts` beside the flag's description, because
-- a default nobody can read next to the thing it defaults is a default
-- nobody audits.
--
-- ---------------------------------------------------------------------
-- HOW A RECURRING JOB GETS AN AUTHORITY, WHICH IS THE ONE HARD QUESTION.
--
-- ADR-0011 is absolute that a job runs as the user who caused it: there is
-- no service identity, and `app_private.enqueue_job` takes no organisation
-- argument precisely so that a cross-tenant enqueue has no syntax. A
-- recurring job has no bound transaction to be born from and no live user
-- at the moment it becomes due, so it cannot use `enqueue_job` at all.
--
-- The answer here does not invent an identity. A schedule row RECORDS the
-- member who enabled it (`authority_user_id`), written from the bound
-- transaction that enabled it, and the sweep below stamps the queue row
-- with exactly that pair. Everything ADR-0011 guarantees then holds
-- unchanged: `withJobAuthority` re-proves the membership with
-- `bind_tenant` at execution, and a schedule whose member has since left
-- parks its next run in `refused_bind` rather than running on a departed
-- person's authority. The operator remedy is the one the queue already
-- teaches — a current member re-enables the schedule, which re-stamps it.
--
-- The alternative, a system user the scheduler binds as, was rejected: it
-- is exactly the service identity ADR-0011 refused, and it would be
-- reachable from every job kind rather than from this one.
--
-- ---------------------------------------------------------------------
-- WHY THERE IS NO CRON.
--
-- The scheduler is one function, called by the worker's existing idle
-- poll. It takes due schedules with FOR UPDATE SKIP LOCKED, writes the
-- queue rows, and advances `next_run_at` in the same statement — so N
-- workers ticking concurrently produce one enqueue per due schedule, and a
-- worker that dies mid-tick has either committed the enqueue and the
-- advance together or neither.
--
-- pg_cron would need an extension the managed-database story does not
-- promise; a host crontab would need a second deployment artefact, its own
-- credential, and its own monitoring; a timer inside the worker process
-- would need leader election the moment there are two workers. All three
-- buy precision this product does not want — these are daily and monthly
-- checks whose useful resolution is hours — at the price of a component
-- that can fail silently. A tick on an existing loop cannot: if the worker
-- is down, the queue is visibly not draining, which docs/RUNBOOK.md § 7b
-- already tells an operator to look at.

-- ---------------------------------------------------------------------
-- 1. Entitlements.
--
-- One row per flag an organisation has an opinion about. Absence is not
-- "off": it means the shipped default stands, which is what keeps this
-- table empty for every organisation that has never been configured, and
-- keeps a flag's default in one place rather than smeared across a
-- backfill.
--
-- The key list is a CHECK rather than a free-text column, in the idiom
-- migration 0072 used for job kinds: the database is the authority, and a
-- typo'd flag is refused at write time instead of being stored and then
-- silently never consulted.
-- ---------------------------------------------------------------------
CREATE TABLE organisation_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  flag_key text NOT NULL CHECK (flag_key IN (
    -- The NIC E-way Bill module (0035, 0076, ADR-0013). Off until the
    -- organisation's own NIC re-certification lands.
    'eway_bill',
    -- Outbound digital signing (0091, ADR-0012). Off until the kiosk or
    -- the ESP lane is procured and a certificate is registered.
    'outbound_signing'
  )),

  enabled boolean NOT NULL,

  -- Why it was set this way. Operational, and the reason this table is
  -- not a two-column key/value store: "off" without "waiting on NIC
  -- re-certification, ticket 4471" is a fact nobody can act on six months
  -- later.
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),

  set_by_user_id text NOT NULL CHECK (length(set_by_user_id) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, flag_key)
);

COMMENT ON TABLE organisation_entitlements IS
  'Per-organisation module availability (0096). An OPERATOR control, not a permission: a membership says what a person may do, this says whether a module is available to the organisation at all. A missing row means the shipped default in apps/server/src/entitlements.ts stands.';
COMMENT ON COLUMN organisation_entitlements.enabled IS
  'The organisation''s explicit answer. There is no third state: an organisation with no opinion has no row.';

ALTER TABLE organisation_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_entitlements FORCE ROW LEVEL SECURITY;

-- ADR-0010: the helper call is wrapped in a scalar subquery so the planner
-- treats it as an InitPlan and evaluates it once per statement.
CREATE POLICY organisation_entitlements_tenant_policy ON organisation_entitlements
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. Deleting a row would silently restore the shipped default and
-- erase who decided otherwise; turning a flag back on is an UPDATE that
-- keeps the trail.
GRANT SELECT, INSERT, UPDATE ON organisation_entitlements TO auto_mb_app;

CREATE TRIGGER organisation_entitlements_touch_updated_at
BEFORE UPDATE ON organisation_entitlements
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. The recurring statutory checks.
--
-- ONE KIND SHIPS, and that is a decision rather than a stopping point.
-- `instrument_expiry_review` reads `work_instruments` (0006) and reports
-- the performance guarantees and PAC certificates whose `expires_on` falls
-- inside the horizon — the check an agency loses real money by missing,
-- because a lapsed PBG is a contract breach and a bank does not renew one
-- retrospectively.
--
-- The company document library (0079) is the obvious second candidate and
-- is deliberately NOT given a schedule: that migration's header states
-- that credential expiry is DERIVED on read rather than notified, and
-- contradicting a stated design decision to make a new mechanism look
-- general is how a facility acquires jobs nobody asked for. A second kind
-- is one CHECK value and one handler when there is a second real need.
-- ---------------------------------------------------------------------
CREATE TABLE statutory_job_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  kind text NOT NULL CHECK (kind IN (
    -- Performance guarantees and PAC certificates approaching expiry.
    'instrument_expiry_review'
  )),

  enabled boolean NOT NULL DEFAULT true,

  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),

  -- Not before this instant. Advanced by the sweep in the same statement
  -- that enqueues, so a schedule cannot be run twice by two workers.
  next_run_at timestamptz NOT NULL DEFAULT now(),

  last_run_at timestamptz,
  -- The queue row the last run produced. Not a foreign key: `worker_jobs`
  -- is purged on a retention window (0072 § 5b) and a schedule must not
  -- pin the queue's rows or lose its own history when they go.
  last_job_id uuid,

  -- Whose authority the enqueued job runs under. See the header: this is
  -- ADR-0011's rule kept rather than worked around. Stamped from the bound
  -- transaction that enabled the schedule; re-proved by bind_tenant at
  -- execution.
  authority_user_id text NOT NULL
    CHECK (length(authority_user_id) BETWEEN 1 AND 255),

  -- How far ahead the review looks, in days. On the schedule rather than
  -- in the handler because it is the organisation's judgement: an agency
  -- whose bank takes six weeks to renew a guarantee needs a longer horizon
  -- than one whose bank takes a week.
  horizon_days integer NOT NULL DEFAULT 45
    CHECK (horizon_days BETWEEN 1 AND 365),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),
  -- One schedule per kind per organisation. Two schedules for one check
  -- would produce two identical jobs and two identical reports.
  UNIQUE (organisation_id, kind)
);

COMMENT ON TABLE statutory_job_schedules IS
  'Recurring checks an organisation has switched on (0096). Each row names the kind, its cadence, and the member whose authority its jobs run under — ADR-0011''s rule, kept: there is no service identity, so a schedule borrows a real membership and stops working when that membership does.';
COMMENT ON COLUMN statutory_job_schedules.authority_user_id IS
  'The member whose authority the enqueued job runs under. Re-proved by app_private.bind_tenant at execution: a schedule enabled by somebody who has since left parks its next run in refused_bind rather than running on their authority.';
COMMENT ON COLUMN statutory_job_schedules.next_run_at IS
  'Advanced by app_private.enqueue_due_statutory_jobs in the same statement that writes the queue row, so two workers ticking together enqueue once.';

ALTER TABLE statutory_job_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE statutory_job_schedules FORCE ROW LEVEL SECURITY;

CREATE POLICY statutory_job_schedules_tenant_policy ON statutory_job_schedules
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE: a schedule is switched off, not forgotten, so the run history
-- it points at keeps a row to hang from and an operator can see that a
-- check they expected is deliberately not running.
GRANT SELECT, INSERT, UPDATE ON statutory_job_schedules TO auto_mb_app;

-- The sweep runs as auto_mb_definer, across tenants, because a due
-- schedule has to be found before any tenant is bound. BYPASSRLS lifts the
-- POLICY, not the table privilege, so the grant is separate and explicit.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_definer') THEN
    GRANT SELECT, UPDATE ON statutory_job_schedules TO auto_mb_definer;
  END IF;
END
$$;

CREATE TRIGGER statutory_job_schedules_touch_updated_at
BEFORE UPDATE ON statutory_job_schedules
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. The organisation's own copy of itself.
--
-- `GET /api/export` has always produced the whole tenant record, and it
-- has always done it synchronously into an owner's browser: minutes of
-- streaming that a proxy timeout, a laptop lid or a flaky train connection
-- ends with a truncated file and nothing to resume. This table turns the
-- same package into an artefact — requested, built once, downloaded as
-- many times as the operator needs until it expires.
--
-- THE EXPIRY IS THE SECURITY PROPERTY, not a housekeeping convenience.
-- The bundle is every contract, every price, every payslip and every bank
-- detail the organisation holds, sitting as one file in object storage. A
-- download link that outlives its purpose is a copy of the whole business
-- with a longer half-life than the decision to make it, so the artefact
-- expires on a clock the requester does not choose and the sweep in § 5
-- deletes the bytes when it does.
--
-- WHAT IS DELIBERATELY ABSENT: any token. The download route is an
-- ordinary session-authenticated, tenant-bound route gated on
-- `can_export_org`, so there is no bearer value to leak into a proxy log,
-- a referrer header or a chat message, and no credential that could
-- outlive the expiry because there is no credential at all. The row id in
-- the URL is not a secret: RLS scopes it to one organisation and the
-- authority scopes it to members who may export.
-- ---------------------------------------------------------------------
CREATE TABLE organisation_export_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),

  -- queued   → accepted, the build has not started
  -- running  → the build holds a snapshot open
  -- ready    → the artefact exists and can be downloaded
  -- failed   → the build stopped; failure_reason says why
  -- expired  → the artefact's window closed and its bytes are gone
  state text NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'running', 'ready', 'failed', 'expired')
  ),

  requested_by_user_id text NOT NULL
    CHECK (length(requested_by_user_id) BETWEEN 1 AND 255),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,

  -- The format the artefact was written in, copied from the server's
  -- EXPORT_FORMAT_VERSION at build time. A bundle downloaded weeks later
  -- must say which format it IS, not which format the product now emits.
  format_version text CHECK (
    format_version IS NULL OR format_version ~ '^export-v[0-9]+$'
  ),

  -- Two layers on the tenant prefix, because a path is a filesystem
  -- escape: `assertSafeObjectKey` in packages/documents/src/storage.ts
  -- validates the shape, and this CHECK refuses a key that names another
  -- organisation's directory even if the shape is perfect.
  object_key text CHECK (
    object_key IS NULL OR object_key LIKE organisation_id::text || '/%'
  ),
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 sha256_hex,
  expires_at timestamptz,

  failure_reason text CHECK (
    failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 500
  ),

  download_count integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  last_downloaded_at timestamptz,

  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organisation_id, id),

  -- A ready artefact is one fact with five parts. Without this a row could
  -- claim `ready` with no key to fetch, which is the shape that turns a
  -- failed build into a download button that 500s.
  CONSTRAINT organisation_export_requests_ready_shape CHECK (
    (
      state = 'ready'
      AND object_key IS NOT NULL
      AND byte_size IS NOT NULL
      AND sha256 IS NOT NULL
      AND expires_at IS NOT NULL
      AND format_version IS NOT NULL
      AND completed_at IS NOT NULL
    )
    OR state <> 'ready'
  ),

  -- A failure says why. An operator reading `failed` with no reason has
  -- to go to the server log to learn anything at all.
  CONSTRAINT organisation_export_requests_failure_shape CHECK (
    (state = 'failed' AND failure_reason IS NOT NULL)
    OR (state <> 'failed' AND failure_reason IS NULL)
  ),

  -- An expired artefact keeps everything it was, except the bytes.
  CONSTRAINT organisation_export_requests_expired_shape CHECK (
    state <> 'expired' OR (expires_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

COMMENT ON TABLE organisation_export_requests IS
  'One self-service export of the whole tenant record (0096). The artefact expires and its bytes are deleted by the worker sweep; the download route is session-authenticated and gated on can_export_org, so no token exists that could outlive the expiry.';
COMMENT ON COLUMN organisation_export_requests.expires_at IS
  'When the artefact stops being downloadable. Enforced twice: the download route refuses a lapsed row, and app_private.expire_lapsed_organisation_exports hands the worker the key to delete.';
COMMENT ON COLUMN organisation_export_requests.format_version IS
  'The export format the artefact WAS written in, not the one the product now emits. A bundle restored years later has to say which shape it is.';

ALTER TABLE organisation_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_export_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY organisation_export_requests_tenant_policy
  ON organisation_export_requests
  USING (organisation_id = (SELECT app_private.current_organisation_id()))
  WITH CHECK (organisation_id = (SELECT app_private.current_organisation_id()));

-- No DELETE. An export is a disclosure of the entire organisation to
-- whoever received the file, and a record of a disclosure that can be
-- removed is not a record. Expiry empties the storage, never the row.
GRANT SELECT, INSERT, UPDATE ON organisation_export_requests TO auto_mb_app;

-- The sweep in § 5 reaches this table across tenants for the same reason
-- the scheduler reaches the schedules: an artefact that has lapsed has to
-- be found before any tenant is bound.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_definer') THEN
    GRANT SELECT, UPDATE ON organisation_export_requests TO auto_mb_definer;
  END IF;
END
$$;

CREATE TRIGGER organisation_export_requests_touch_updated_at
BEFORE UPDATE ON organisation_export_requests
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- What the download route and the sweep both ask: which of this
-- organisation's artefacts are live, newest first.
CREATE INDEX organisation_export_requests_state_idx
  ON organisation_export_requests (organisation_id, state, requested_at DESC, id);

-- What the cross-tenant sweep asks, and the only query that is not
-- organisation-scoped. Partial, because a lapsed artefact is a rounding
-- error against the rows that will accumulate.
CREATE INDEX organisation_export_requests_expiry_idx
  ON organisation_export_requests (expires_at)
  WHERE state = 'ready';

-- ---------------------------------------------------------------------
-- 4. The write guards.
--
-- Every rule below is also checked by the route, first, under no lock, so
-- an operator gets a named 409 with a remedy. These are the arm that holds
-- when a writer reaches the table another way, and the arm that holds
-- under concurrency, which the route cannot.
--
-- SQLSTATEs come from the 23N block, one per rule.
--
-- `SET search_path` for the reason 0067, 0079, 0087 and 0091 all give: a
-- function that resolves its own identifiers through the caller's path is
-- a rule a shadowing object in a writable schema can rewrite into whatever
-- it likes. Not SECURITY DEFINER: every table touched is one the caller
-- may already read under RLS, and a definer function here would read
-- across tenants.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_private.guard_organisation_export_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Born queued, always. A row inserted straight into `ready` would be
    -- an artefact nothing built, pointing at a key nothing wrote.
    IF NEW.state <> 'queued' THEN
      RAISE EXCEPTION 'an export request is raised queued, not %', NEW.state
        USING ERRCODE = '23N01';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE from here down.

  -- The request's own facts are written once. The denylist shape of a ROW
  -- guard means a column left out of it is silently editable, which is
  -- what issued-immutability-coverage.integration.test.ts exists to catch.
  IF ROW(NEW.id, NEW.organisation_id, NEW.requested_by_user_id, NEW.requested_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organisation_id, OLD.requested_by_user_id, OLD.requested_at)
  THEN
    RAISE EXCEPTION 'who asked for an export, and when, are written once'
      USING ERRCODE = '23N02';
  END IF;

  -- The artefact is frozen once it exists. A key, a digest or a size that
  -- could be edited after the fact would make the recorded SHA-256 a
  -- claim rather than a check.
  IF OLD.state IN ('ready', 'expired')
     AND ROW(NEW.object_key, NEW.byte_size, NEW.sha256, NEW.format_version,
             NEW.expires_at, NEW.completed_at)
         IS DISTINCT FROM
         ROW(OLD.object_key, OLD.byte_size, OLD.sha256, OLD.format_version,
             OLD.expires_at, OLD.completed_at)
     -- Except the key, and only on the way to `expired`: the sweep clears
     -- it when it deletes the bytes, so a NULL key is how the row says
     -- there is nothing left to fetch.
     AND NOT (
       NEW.state = 'expired'
       AND NEW.object_key IS NULL
       AND ROW(NEW.byte_size, NEW.sha256, NEW.format_version,
               NEW.expires_at, NEW.completed_at)
           IS NOT DISTINCT FROM
           ROW(OLD.byte_size, OLD.sha256, OLD.format_version,
               OLD.expires_at, OLD.completed_at)
     )
  THEN
    RAISE EXCEPTION 'the artefact facts of a built export never change'
      USING ERRCODE = '23N02';
  END IF;

  IF NEW.state <> OLD.state THEN
    -- Forward only, and every door that is open is one a real path
    -- reaches:
    --   queued  -> running  the build started
    --   queued  -> failed   the process died before it started, and the
    --                       sweep reconciled it
    --   running -> ready    the artefact was written
    --   running -> failed   the build stopped, or the sweep found the
    --                       build's process gone
    --   ready   -> expired  the window closed
    -- Nothing rewinds. A `ready` row that could return to `queued` would
    -- re-use an id an operator has already been given a download link for.
    IF NOT (
      (OLD.state = 'queued' AND NEW.state IN ('running', 'failed'))
      OR (OLD.state = 'running' AND NEW.state IN ('ready', 'failed'))
      OR (OLD.state = 'ready' AND NEW.state = 'expired')
    ) THEN
      RAISE EXCEPTION 'an export request cannot move from % to %',
        OLD.state, NEW.state
        USING ERRCODE = '23N01';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER organisation_export_requests_guard
BEFORE INSERT OR UPDATE ON organisation_export_requests
FOR EACH ROW EXECUTE FUNCTION app_private.guard_organisation_export_request();

CREATE FUNCTION app_private.guard_statutory_job_schedule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- A schedule's identity is its id, its organisation and its kind.
  -- Letting the last of those move would silently repoint a run history at
  -- a different check, and the UNIQUE (organisation_id, kind) above would
  -- not notice, because the row that moved is the row that would have
  -- collided with itself. The id and the creation instant are frozen for
  -- the reason issued-immutability-coverage.integration.test.ts exists: a
  -- ROW guard is a denylist, so a column left out of it is silently
  -- editable, and this census refuses one that is neither frozen nor
  -- declared changeable.
  IF ROW(NEW.id, NEW.organisation_id, NEW.kind, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organisation_id, OLD.kind, OLD.created_at)
  THEN
    RAISE EXCEPTION 'a schedule''s identity and creation instant are written once'
      USING ERRCODE = '23N03';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER statutory_job_schedules_guard
BEFORE UPDATE ON statutory_job_schedules
FOR EACH ROW EXECUTE FUNCTION app_private.guard_statutory_job_schedule();

-- ---------------------------------------------------------------------
-- 5. The two cross-tenant sweeps the worker ticks.
--
-- Both are SECURITY DEFINER and both are argued rather than assumed. The
-- shared reason is the one 0072 gives for `claim_next_job`: the worker has
-- to find the work before it can know whose it is, so no tenant policy can
-- express the read. Neither function takes an organisation argument, so
-- neither can be pointed at a tenant by a caller; both are granted to
-- `auto_mb_app` because the worker connects as that role and holds no
-- privilege a request handler does not.
-- ---------------------------------------------------------------------

-- The scheduler. Enqueues every due, enabled schedule and advances it in
-- the same statement.
--
-- `FOR UPDATE SKIP LOCKED` is the whole concurrency story: two workers
-- ticking at the same instant take disjoint sets of rows, and a schedule
-- whose row is already locked is simply left for the next tick a second
-- later. The INSERT and the advance are one transaction, so a worker that
-- dies mid-tick has either enqueued and advanced or done neither — the
-- failure a naive "read due, enqueue, then update" loop produces is a job
-- enqueued twice, which for a monthly statutory check means two reports
-- and a support call.
--
-- It writes `worker_jobs` DIRECTLY rather than calling `enqueue_job`, and
-- that is not a shortcut around ADR-0011's rule: `enqueue_job` reads the
-- organisation and user from the caller's binding, and this function has
-- no binding to read because there is no request. It supplies the same
-- pair from the schedule row instead — a `(organisation_id,
-- authority_user_id)` written earlier BY a bound transaction — so the
-- queue row is identical in every respect to one `enqueue_job` would have
-- produced, and `bind_tenant` proves the membership at execution exactly
-- as it would have.
CREATE FUNCTION app_private.enqueue_due_statutory_jobs(p_limit integer DEFAULT 50)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $$
DECLARE
  v_due record;
  v_job_id uuid;
  v_enqueued integer := 0;
BEGIN
  -- `check_violation`, not a 23N code, and 0072's `claim_next_job` argues
  -- the same distinction: the 23N block is for refusals an operator can
  -- read and act on, and a caller passing a limit of zero is a programming
  -- error no remedy text helps with.
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'a scheduler tick must take at least one schedule'
      USING ERRCODE = 'check_violation';
  END IF;

  FOR v_due IN
    SELECT s.id, s.organisation_id, s.kind, s.cadence,
           s.authority_user_id, s.horizon_days
      FROM statutory_job_schedules AS s
     WHERE s.enabled
       AND s.next_run_at <= now()
     ORDER BY s.next_run_at
       FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  LOOP
    INSERT INTO worker_jobs (organisation_id, user_id, kind, payload_ref)
    VALUES (
      v_due.organisation_id,
      v_due.authority_user_id,
      v_due.kind,
      jsonb_build_object(
        'scheduleId', v_due.id::text,
        'horizonDays', v_due.horizon_days
      )
    )
    RETURNING id INTO v_job_id;

    UPDATE statutory_job_schedules AS s
       SET last_run_at = now(),
           last_job_id = v_job_id,
           -- From `now()`, not from the old `next_run_at`. A worker that
           -- was down for a week would otherwise wake and enqueue seven
           -- daily jobs in a row, each reporting the same guarantees.
           -- A missed statutory review is caught up by running it once.
           next_run_at = now() + CASE s.cadence
             WHEN 'daily' THEN interval '1 day'
             WHEN 'weekly' THEN interval '7 days'
             ELSE interval '1 month'
           END
     WHERE s.id = v_due.id;

    v_enqueued := v_enqueued + 1;
  END LOOP;

  RETURN v_enqueued;
END
$$;

ALTER FUNCTION app_private.enqueue_due_statutory_jobs(integer)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.enqueue_due_statutory_jobs(integer) FROM PUBLIC;

-- The expiry sweep. Marks lapsed artefacts `expired`, clears their keys,
-- and RETURNS those keys so the caller can delete the bytes.
--
-- The order is deliberate and it is the safe one. The row is marked first
-- and the bytes are deleted afterwards, so the failure mode is an orphan
-- file in object storage — inert, findable, and reclaimable by hand. The
-- other order has a window in which the bytes are gone and the row still
-- says `ready`, which is a download button that fails for a reason nobody
-- can see.
--
-- Returning keys rather than deleting them here is the boundary: SQL has
-- no business reaching object storage, and the worker already holds the
-- storage handle.
CREATE FUNCTION app_private.expire_lapsed_organisation_exports(
  p_limit integer DEFAULT 50
)
RETURNS TABLE (object_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'an expiry sweep must take at least one artefact'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  WITH lapsed AS (
    SELECT e.id, e.object_key AS key
      FROM organisation_export_requests AS e
     WHERE e.state = 'ready'
       AND e.expires_at <= now()
     ORDER BY e.expires_at
       FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE organisation_export_requests AS e
     SET state = 'expired',
         object_key = NULL
    FROM lapsed
   WHERE e.id = lapsed.id
  RETURNING lapsed.key;
END
$$;

ALTER FUNCTION app_private.expire_lapsed_organisation_exports(integer)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.expire_lapsed_organisation_exports(integer)
  FROM PUBLIC;

-- The run history, and the one definer read in this migration that needs
-- a real argument rather than a restatement of 0072's.
--
-- The admin screen has to be able to say what a scheduled check found and
-- when it last failed. That answer lives in `worker_jobs`, which the
-- application role holds NO privilege on at all — 0072's central decision,
-- taken because a direct SELECT grant would turn any SQL-injection foothold
-- into an enumeration oracle over every organisation's job metadata.
--
-- So the answer is a function rather than a grant, and it is narrowed on
-- four axes so that it widens the reachable set by a page of one
-- organisation's own rows and nothing else:
--
--   IT TAKES NO ORGANISATION. Like `enqueue_job`, it reads
--   `current_organisation_id()` from the binding `bind_tenant` already
--   proved, so an unbound caller gets nothing and a bound one cannot name
--   a tenant that is not theirs. There is no argument to craft.
--
--   IT REFUSES THE UNBOUND CALLER outright rather than returning an empty
--   set, so a missing binding is a fault somebody sees.
--
--   IT NEVER RETURNS `claim_token`, `claimed_by` or `user_id`. The token
--   is the queue's unforgeable capability and the whole reason the table
--   is unreachable; a read that handed it out would be worse than the
--   grant 0072 refused. The commissioning user is already on the schedule
--   row the screen renders beside this.
--
--   IT ONLY SEES SCHEDULED KINDS. `loa_document_intake` rows belong to the
--   letter they are reading and are surfaced there; this is the platform
--   screen's history, not a queue browser.
--
-- `last_error` does travel, capped at 500 characters by `fail_job` for the
-- reason that function states. It is the organisation's own error about
-- the organisation's own data, read back to the organisation.
CREATE FUNCTION app_private.organisation_job_history(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  kind text,
  state text,
  attempts integer,
  created_at timestamptz,
  finished_at timestamptz,
  outcome jsonb,
  last_error text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, pg_temp
AS $$
DECLARE
  v_organisation_id uuid;
BEGIN
  v_organisation_id := app_private.current_organisation_id();
  IF v_organisation_id IS NULL THEN
    RAISE EXCEPTION
      'job history can only be read inside a bound tenant transaction'
      USING ERRCODE = '28A01';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'a job history page is between one and two hundred rows'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  SELECT j.id, j.kind, j.state, j.attempts, j.created_at, j.finished_at,
         j.outcome, j.last_error
    FROM worker_jobs AS j
   WHERE j.organisation_id = v_organisation_id
     AND j.kind IN ('instrument_expiry_review')
   ORDER BY j.created_at DESC, j.id DESC
   LIMIT p_limit;
END
$$;

ALTER FUNCTION app_private.organisation_job_history(integer)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.organisation_job_history(integer) FROM PUBLIC;

-- The definer role writes queue rows for the scheduler. 0072 already
-- grants it SELECT/INSERT/UPDATE/DELETE on worker_jobs; this is stated
-- again for the reason that migration states it — a fresh-cluster restore
-- brings the function back without the grant, and the scheduler would then
-- fail silently on a tick nobody is watching.
GRANT SELECT, INSERT, UPDATE, DELETE ON worker_jobs TO auto_mb_definer;

-- The queue learns the scheduled kind. The CHECK is the authority (0072
-- § 1): a kind the database does not admit is refused at write time
-- rather than accepted and then never dispatched.
ALTER TABLE worker_jobs DROP CONSTRAINT worker_jobs_kind_check;
ALTER TABLE worker_jobs ADD CONSTRAINT worker_jobs_kind_check CHECK (kind IN (
  'loa_document_intake',
  'instrument_expiry_review'
));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT EXECUTE ON FUNCTION app_private.enqueue_due_statutory_jobs(integer)
      TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.expire_lapsed_organisation_exports(integer)
      TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.organisation_job_history(integer)
      TO auto_mb_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 6. The two authorities.
--
-- `can_manage_entitlements` is OWNER-ONLY, and that is stricter than this
-- schema's usual "the owner holds it implicitly" default. The column is an
-- ordinary per-member grant like every other — it has to be, or the
-- finding-36 MFA census in apps/server/test/mfa-policy-census.integration.test.ts
-- cannot classify it — and the owner-only rule lives on the ROUTE, which
-- declares `role: 'owner'` AND `authority: 'entitlements'` together. That
-- is 0091's kiosk layering: the authority gates the doing, the owner role
-- gates who may do it at all. Granting the column to a non-owner is
-- therefore not an error and not a hole; it simply does not confer
-- anything until that member is made an owner.
--
-- `can_export_org` is an ordinary authority. It widens the export beyond
-- the owner-only `GET /api/export` deliberately: an owner who wants their
-- accountant to pull the annual package should not have to hand over the
-- owner role to do it. The route adds one more test the authority cannot
-- express — full work scope — because the package is not work-scoped and
-- an assigned-scope member would otherwise receive every Work they cannot
-- see in the product.
--
-- Both are NOT NULL DEFAULT false and neither is backfilled: 0061's,
-- 0080's, 0089's and 0091's rule, and it holds for the same reason. The
-- founding owner gets both from `create_organisation_with_owner` below, so
-- a NEW organisation is configurable on the day it is created and an
-- EXISTING one grants once on the Members screen.
-- ---------------------------------------------------------------------
ALTER TABLE organisation_memberships
  ADD COLUMN can_manage_entitlements boolean NOT NULL DEFAULT false;
ALTER TABLE organisation_memberships
  ADD COLUMN can_export_org boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organisation_memberships.can_manage_entitlements IS
  'Authority to switch this organisation''s modules on and off, and to configure its recurring statutory checks (0096). Owner-only in effect: every route carrying it also declares role owner, so the grant confers nothing to a non-owner. Not backfilled.';
COMMENT ON COLUMN organisation_memberships.can_export_org IS
  'Authority to request and download a copy of the whole organisation record (0096). Separate from the owner role so an owner can delegate the annual package without delegating the organisation. The route additionally requires full work scope, because the package is not work-scoped. Not backfilled.';

-- CREATE OR REPLACE STATES THE WHOLE BODY, NEVER AMENDS IT, so this
-- replacement must restate every grant the founder already had or silently
-- revoke it. Four are inherited — 0004's issue and cancel, 0089's payroll,
-- 0091's signing — and two are this migration's. A founder who could not
-- export the organisation they had just created would at least be visible;
-- one who quietly lost the ability to sign, because this file forgot a
-- column 0091 added, is the failure that costs the most to diagnose, and
-- the 0089/0091 collision is the burned precedent it is written against.
--
-- Deliberately still absent: `can_approve_amendments`,
-- `can_manage_statutory_reporting`, `can_manage_payments`. 0089 gives the
-- reason for the last of them — sending money out of the bank is the one
-- act 0080 refuses to make automatic — and the same restraint applies to
-- the other two.
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
    can_manage_payroll, can_manage_entitlements, can_export_org, status
  )
  VALUES (
    p_id, v_user_id, 'owner', 'all', true, true, true, true, true, true, 'active'
  );

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
-- privilege change nobody reviewed.
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
