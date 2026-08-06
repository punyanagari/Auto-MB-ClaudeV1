SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- The application role must remain unable to bypass the security boundary.
DO $$
DECLARE
  role_is_super boolean;
  role_bypasses_rls boolean;
BEGIN
  SELECT rolsuper, rolbypassrls
  INTO role_is_super, role_bypasses_rls
  FROM pg_roles
  WHERE rolname = 'auto_mb_app';

  IF role_is_super IS TRUE OR role_bypasses_rls IS TRUE THEN
    RAISE EXCEPTION 'auto_mb_app must not be superuser or BYPASSRLS';
  END IF;
END
$$;

-- audit_events is append-only for the application role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM auto_mb_app;
  END IF;
END
$$;
