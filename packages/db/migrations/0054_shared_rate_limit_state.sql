-- Migration 0054: shared rate-limit and account-lockout state (finding 38,
-- docs/AUDIT-DISPOSITION-2026-08-10.md).
--
-- A sibling of 0053 rather than part of it on purpose: 0053 changes
-- statutory evidence, this changes operational throttling state, and the
-- two must be reviewable and revertable independently. 0051/0052 are
-- reserved by parallel work.
--
-- The login/upload sliding windows and the account-scoped login lockout
-- used to live in per-process Maps (apps/server/src/rate-limit.ts), which
-- a second API instance silently divides — each replica enforces its own
-- window, so the effective limit multiplies by the replica count. The
-- state moves here so every instance counts the same attempts.
--
-- UNLOGGED on purpose: this state is reconstructible (a crash forgets at
-- most one open window, which then simply refills) and sits on the
-- sign-in hot path, so it should not pay WAL. Keys are SHA-256 hashes —
-- the per-address limiter hashes the client address, the account lockout
-- reuses the existing normalised-email hash — so no raw address or email
-- rests in the database. Cleanup is opportunistic from the application
-- (expired rows are swept as windows roll over); no scheduled job exists
-- or is needed.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5min';

CREATE UNLOGGED TABLE rate_limit_attempts (
  scope text NOT NULL CHECK (scope IN ('auth', 'upload', 'account_lockout')),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rate_limit_attempts_window
  ON rate_limit_attempts (scope, key_hash, occurred_at);

CREATE UNLOGGED TABLE account_lockout_locks (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  locked_until timestamptz NOT NULL
);

COMMENT ON TABLE rate_limit_attempts IS
  'Sliding-window attempt marks for login/upload throttling and account-lockout failure counting. Not tenant data: rows are keyed by hashed client address or hashed submitted email, shared by every API instance.';
COMMENT ON TABLE account_lockout_locks IS
  'Active account-scoped login locks, keyed by the SHA-256 of the normalised submitted email (the same key the lockout audit trail uses). A row past locked_until is dead and swept opportunistically.';

-- Throttle state is not tenant-scoped (it exists before any session or
-- organisation binds); the service policy states that explicitly instead
-- of leaving RLS half-applied — the same posture as the auth_* tables.
ALTER TABLE rate_limit_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE account_lockout_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_lockout_locks FORCE ROW LEVEL SECURITY;

CREATE POLICY rate_limit_attempts_service_policy ON rate_limit_attempts
  USING (true) WITH CHECK (true);
CREATE POLICY account_lockout_locks_service_policy ON account_lockout_locks
  USING (true) WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
    -- DELETE is required: windows decay by deleting expired marks, and a
    -- successful sign-in clears its account's failure history and lock.
    GRANT SELECT, INSERT, DELETE ON rate_limit_attempts TO auto_mb_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON account_lockout_locks TO auto_mb_app;
  END IF;
END
$$;
