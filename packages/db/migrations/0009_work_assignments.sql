SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Work assignments: the relationship that makes work_scope = 'assigned'
-- meaningful. A membership scoped to 'assigned' sees and touches only
-- the Works listed here; 'all' memberships are unaffected. Owner-managed,
-- and removable (an assignment is access control, not business record).

CREATE TABLE work_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  work_id uuid NOT NULL,
  user_id text NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  UNIQUE (organisation_id, work_id, user_id),
  FOREIGN KEY (organisation_id, work_id)
    REFERENCES works(organisation_id, id),
  FOREIGN KEY (organisation_id, user_id)
    REFERENCES organisation_memberships(organisation_id, user_id)
    ON DELETE CASCADE
);

CREATE INDEX work_assignments_user_idx
  ON work_assignments (organisation_id, user_id);

ALTER TABLE work_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY work_assignments_tenant_policy ON work_assignments
  USING (organisation_id = app_private.current_organisation_id())
  WITH CHECK (organisation_id = app_private.current_organisation_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    GRANT SELECT, INSERT, DELETE ON work_assignments TO auto_mb_app;
  END IF;
END
$$;
