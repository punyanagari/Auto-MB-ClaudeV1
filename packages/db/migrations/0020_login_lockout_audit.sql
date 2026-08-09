SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Pre-pilot hardening (Wave 3): login throttling gains an account-scoped
-- lockout beside the per-address limiter, and repeated-failure lockouts
-- are audited. No signed-in user exists when a lockout fires — the
-- account may not exist at all, and recording which would be an existence
-- oracle — so the row's user_id carries 'email-sha256:<hash>' of the
-- normalised submitted email instead of an auth_users id. The raw email
-- and the submitted password never reach this table.
ALTER TABLE identity_audit_events
  DROP CONSTRAINT identity_audit_events_action_check;
ALTER TABLE identity_audit_events
  ADD CONSTRAINT identity_audit_events_action_check
  CHECK (action IN ('sign_up', 'sign_in', 'sign_out', 'login_locked'));
