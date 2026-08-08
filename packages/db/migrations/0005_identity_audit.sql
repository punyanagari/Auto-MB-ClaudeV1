SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Identity-level audit trail (Milestone 1 close-out decision, 2026-08-08):
-- sign-up/sign-in/sign-out are acts of a USER, not of an organisation, so
-- they cannot live in audit_events — whose organisation_id is NOT NULL by
-- design and stays that way. This table is user-scoped and append-only.
CREATE TABLE identity_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('sign_up', 'sign_in', 'sign_out')),
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX identity_audit_events_user_idx
  ON identity_audit_events (user_id, occurred_at DESC);

ALTER TABLE identity_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_audit_events FORCE ROW LEVEL SECURITY;

-- Service policy, like the Better Auth tables in 0004: rows are written by
-- the server process itself, and no tenant context exists at sign-in time.
-- The application role receives INSERT and SELECT only — with no UPDATE or
-- DELETE grant the trail is append-only even for the service.
CREATE POLICY identity_audit_events_service_policy ON identity_audit_events
  USING (true)
  WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT ON identity_audit_events TO auto_mb_app;
  END IF;
END
$$;
