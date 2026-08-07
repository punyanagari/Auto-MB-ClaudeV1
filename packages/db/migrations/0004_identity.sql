SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- 1. Better Auth tables, exactly as `@better-auth/cli generate` emits for
-- the configuration in apps/server/src/auth.ts (model names overridden to
-- auth_*; column names are Better Auth's camelCase and stay quoted).
-- These tables are identity-level, not tenant-owned: they carry no
-- organisation_id and are read/written by Better Auth through the
-- application role before any tenant context exists. They still get
-- ENABLE+FORCE RLS with an explicit service policy so the repository's
-- blanket RLS contract holds.

create table auth_users (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz default CURRENT_TIMESTAMP not null,
  "twoFactorEnabled" boolean
);

create table auth_sessions (
  "id" text not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references auth_users ("id") on delete cascade
);

create table auth_accounts (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references auth_users ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz not null
);

create table auth_verifications (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
);

create table auth_two_factors (
  "id" text not null primary key,
  "secret" text not null,
  "backupCodes" text not null,
  "userId" text not null references auth_users ("id") on delete cascade,
  "verified" boolean,
  "failedVerificationCount" integer,
  "lockedUntil" timestamptz
);

create index auth_sessions_user_idx on auth_sessions ("userId");
create index auth_accounts_user_idx on auth_accounts ("userId");
create index auth_verifications_identifier_idx on auth_verifications ("identifier");
create index auth_two_factors_secret_idx on auth_two_factors ("secret");
create index auth_two_factors_user_idx on auth_two_factors ("userId");

ALTER TABLE auth_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_users FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_two_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_two_factors FORCE ROW LEVEL SECURITY;

-- Identity data is not tenant-scoped; the service policy states that
-- explicitly instead of leaving RLS half-applied.
CREATE POLICY auth_users_service_policy ON auth_users
  USING (true) WITH CHECK (true);
CREATE POLICY auth_sessions_service_policy ON auth_sessions
  USING (true) WITH CHECK (true);
CREATE POLICY auth_accounts_service_policy ON auth_accounts
  USING (true) WITH CHECK (true);
CREATE POLICY auth_verifications_service_policy ON auth_verifications
  USING (true) WITH CHECK (true);
CREATE POLICY auth_two_factors_service_policy ON auth_two_factors
  USING (true) WITH CHECK (true);

-- 2. The definer role: owns the two functions below so they can read
-- memberships without tripping RLS recursion (policies on
-- organisation_memberships themselves call current_organisation_id()).
-- NOLOGIN — nothing can connect as it; it exists only as a function owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_definer') THEN
    CREATE ROLE auto_mb_definer NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app_private TO auto_mb_definer;
GRANT SELECT, INSERT ON organisations, organisation_memberships, audit_events
  TO auto_mb_definer;

-- 3. The membership floor (ROADMAP Milestone 1): tenant context binds only
-- when the session's user holds an active membership in the organisation
-- the GUC names. A handler that stamps an arbitrary organisation id gets
-- NULL — every tenant policy then denies. SECURITY DEFINER + BYPASSRLS
-- owner prevents policy recursion on organisation_memberships.
CREATE OR REPLACE FUNCTION app_private.current_organisation_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app_private, pg_temp
AS $$
  SELECT candidate.org_id
  FROM (
    SELECT nullif(current_setting('app.organisation_id', true), '')::uuid AS org_id
  ) AS candidate
  WHERE candidate.org_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM organisation_memberships m
      WHERE m.organisation_id = candidate.org_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')
        AND m.status = 'active'
    )
$$;

ALTER FUNCTION app_private.current_organisation_id() OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.current_organisation_id() FROM PUBLIC;

-- 4. Organisation bootstrap: the only path that may create an organisation
-- and its first membership in one atomic step (the floor otherwise makes
-- the first insert impossible — no membership exists yet to bind with).
CREATE FUNCTION app_private.create_organisation_with_owner(
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
    can_issue_documents, can_cancel_documents, status
  )
  VALUES (p_id, v_user_id, 'owner', 'all', true, true, 'active');

  INSERT INTO audit_events (
    organisation_id, actor_user_id, action, entity_type, entity_id
  )
  VALUES (p_id, v_user_id, 'organisation.created', 'organisations', p_id);

  RETURN p_id;
END
$$;

ALTER FUNCTION app_private.create_organisation_with_owner(text, text, uuid)
  OWNER TO auto_mb_definer;
REVOKE ALL ON FUNCTION app_private.create_organisation_with_owner(text, text, uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      auth_users, auth_sessions, auth_accounts, auth_verifications, auth_two_factors
    TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.current_organisation_id() TO auto_mb_app;
    GRANT EXECUTE ON FUNCTION app_private.create_organisation_with_owner(text, text, uuid) TO auto_mb_app;
  END IF;
END
$$;

-- 5. Members of an organisation may list the organisations they belong to
-- before selecting one (the org-picker needs names, not just ids).
CREATE POLICY organisations_member_select_policy ON organisations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM organisation_memberships m
      WHERE m.organisation_id = organisations.id
        AND m.user_id = app_private.current_user_id()
        AND m.status = 'active'
    )
  );

-- 6. Guardrail: the app role must not inherit the definer's RLS bypass.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app')
    AND pg_has_role('auto_mb_app', 'auto_mb_definer', 'MEMBER') THEN
    RAISE EXCEPTION 'auto_mb_app must not be a member of auto_mb_definer';
  END IF;
END
$$;
