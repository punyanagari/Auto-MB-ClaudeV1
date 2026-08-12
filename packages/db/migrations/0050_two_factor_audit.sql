SET lock_timeout = '2s';
SET statement_timeout = '5min';

-- Finding 36 (owner MFA): two-factor lifecycle events join the user-scoped
-- identity audit trail. Enrolment completion, verification at sign-in,
-- backup-code consumption, disablement, and the built-in verification
-- lockout (auth_two_factors."lockedUntil") are acts of a USER before or
-- outside any tenant context, so they belong here beside sign-in, not in
-- audit_events. 'two_factor_reset' is written only by the operator recovery
-- procedure in docs/RUNBOOK.md — there is deliberately no in-app reset
-- endpoint, so an application-written row with that action is itself an
-- anomaly worth investigating.
ALTER TABLE identity_audit_events
  DROP CONSTRAINT identity_audit_events_action_check;
ALTER TABLE identity_audit_events
  ADD CONSTRAINT identity_audit_events_action_check
  CHECK (action IN (
    'sign_up', 'sign_in', 'sign_out', 'login_locked',
    'two_factor_enabled', 'two_factor_disabled', 'two_factor_verified',
    'two_factor_backup_code_used', 'two_factor_locked', 'two_factor_reset'
  ));
