import type { TransactionSql } from '@auto-mb/db';
import type { DocumentAuthority } from './authz.js';
import { httpError } from './http.js';

/**
 * Finding 36 (owner MFA): the multi-factor requirement is USER-level, not
 * membership-level. A user who holds authority anywhere — an owner role or
 * any document authority (issue, cancel, approve amendments, manage
 * statutory reporting) in ANY organisation — must have TOTP two-factor
 * enabled before any tenant-scoped request is served. There is deliberately no grace period: the wall stands
 * from the first privileged request, and enrolment happens through the
 * always-reachable identity endpoints (/api/me, /api/organisations,
 * /api/auth/two-factor/*).
 */
export interface MfaGate {
  /** The caller holds a privilege that requires MFA, in any organisation. */
  readonly required: boolean;
  /** The caller has completed TOTP enrolment (auth_users."twoFactorEnabled"). */
  readonly enabled: boolean;
}

/**
 * Whether the 403 refusals are live. The GATE is always computed — /api/me
 * reports it and the enrolment wall renders from it — but the refusals
 * themselves deploy dark behind MFA_ENFORCE=true so the control can ship
 * ahead of the operator flipping it for the pilot. Process-wide state, set
 * once from configuration: buildApp overrides it only when the option is
 * explicitly provided, so test instances in one process do not silently
 * reconfigure each other.
 */
let enforceMfaRefusals = process.env.MFA_ENFORCE === 'true';

export function configureMfaEnforcement(enabled: boolean): void {
  enforceMfaRefusals = enabled;
}

/** The named boot refusal for a production process whose MFA refusals are
 * off. Carrying its own name lets operators and tests recognise the exact
 * hazard rather than a generic startup failure. */
export class MfaEnforcementDisabledInProductionError extends Error {
  constructor() {
    super(
      'MFA_ENFORCE must be exactly "true" outside development and test. ' +
        'The finding-36 MFA wall deploys dark behind this single variable: ' +
        'an unset, mistyped, or false value silently turns the refusals off ' +
        'for every privilege-holding account, so a production boot refuses ' +
        'to start one environment variable away from an open gate. Set ' +
        'MFA_ENFORCE=true (or run with NODE_ENV=development/test).',
    );
    this.name = 'MfaEnforcementDisabledInProductionError';
  }
}

/**
 * Boot assertion mirroring assertProductionSecret (auth.ts): anything that
 * is not an explicit development or test run counts as production, and a
 * production process must not come up with the MFA refusals resolved off.
 * `enforce` is the resolved value of the MFA_ENFORCE flag (exactly the
 * `=== 'true'` read above — any other spelling already resolves false).
 */
export function assertProductionMfaEnforcement(enforce: boolean): boolean {
  const isNonProduction =
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  if (!isNonProduction && !enforce) {
    throw new MfaEnforcementDisabledInProductionError();
  }
  return enforce;
}

export function mfaEnforcementEnabled(): boolean {
  return enforceMfaRefusals;
}

/**
 * Every document authority requires MFA. The value type is the literal
 * `true` rather than `boolean`, so an authority cannot be quietly relaxed
 * to `false` in passing — dropping one out of the wall means editing the
 * type and saying so. Adding a member to `DocumentAuthority` fails
 * typechecking here until the new authority is classified, which is the
 * first half of the guarantee that a new authority cannot be silently
 * MFA-exempt.
 */
export const MFA_REQUIRING_AUTHORITIES: Record<DocumentAuthority, true> = {
  issue: true,
  cancel: true,
  statutory: true,
  // Moving the organisation's money out of its bank is the single most
  // worthwhile thing to steal this account for.
  payments: true,
  // Payroll sees every colleague's salary, PAN, UAN and bank account, and
  // finalising a run authorises the salaries — worth stealing on both
  // counts, so it joins the wall beside payments.
  payroll: true,
};

/** The `organisation_memberships` column each document authority is
 * granted through — the same exhaustive `Record<DocumentAuthority, …>`
 * shape, so a new authority fails typechecking here too. */
const AUTHORITY_GRANT_COLUMNS: Record<DocumentAuthority, string> = {
  issue: 'can_issue_documents',
  cancel: 'can_cancel_documents',
  statutory: 'can_manage_statutory_reporting',
  payments: 'can_manage_payments',
  payroll: 'can_manage_payroll',
};

/** Grants that are not `DocumentAuthority` values but still make the
 * account worth stealing. Approving an amendment rewrites the contract
 * quantities and rates every later document is computed from, so it sits
 * with the three authorities rather than with the plain writer role. */
const NON_AUTHORITY_MFA_REQUIRING_COLUMNS = ['can_approve_amendments'] as const;

/**
 * `can_%` columns on `organisation_memberships` that deliberately do NOT
 * require MFA. Empty today: every grant the table carries is worth
 * stealing. A future low-power grant belongs here WITH a stated reason —
 * the census test refuses any `can_%` column that appears in neither this
 * list nor `MFA_REQUIRING_GRANT_COLUMNS`, so the decision cannot be made
 * by omission.
 */
export const MFA_EXEMPT_GRANT_COLUMNS: readonly string[] = [];

/**
 * The single source of truth for both the gate query below and the
 * `can_%` column census in `test/mfa-policy-census.integration.test.ts`.
 * Because the query reads these column names rather than restating them
 * in SQL, the list and the wall it enforces cannot drift apart.
 */
export const MFA_REQUIRING_GRANT_COLUMNS: readonly string[] = [
  ...(Object.keys(MFA_REQUIRING_AUTHORITIES) as DocumentAuthority[]).map(
    (authority) => AUTHORITY_GRANT_COLUMNS[authority],
  ),
  ...NON_AUTHORITY_MFA_REQUIRING_COLUMNS,
];

/**
 * Computes the caller's MFA gate from the transaction's own user context
 * (`app.user_id`, set by withUserContext/withTenant).
 *
 * This read deliberately spans the caller's memberships in EVERY
 * organisation, not just a bound tenant. docs/SECURITY.md requires
 * bound-tenant membership reads to filter on current_organisation_id()
 * because a row from another organisation must never answer an authority
 * question FOR the bound organisation — but this is the opposite question:
 * a user-level obligation that exists precisely because authority held
 * ANYWHERE makes the account worth stealing. The SELECT policy's
 * `user_id = current_user_id()` branch (migration 0001) is what makes the
 * cross-organisation read possible, and only the caller's own rows are
 * visible through it.
 */
export async function mfaGate(tx: TransactionSql): Promise<MfaGate> {
  const rows = await tx<
    {
      role: string;
      grants: Record<string, unknown>;
      enabled: boolean | null;
    }[]
  >`
    select
      m.role,
      -- The whole membership row, so the grants that require MFA are read
      -- from MFA_REQUIRING_GRANT_COLUMNS above instead of being restated
      -- as a hand-written OR chain here. Adding a grant to that list is
      -- honoured by this query with no second edit, and adding a can_%
      -- column to the table without classifying it fails the census test.
      to_jsonb(m) as grants,
      u."twoFactorEnabled" as enabled
    from organisation_memberships m
    join auth_users u on u."id" = m.user_id
    where m.user_id = app_private.current_user_id()
      and m.status = 'active'
  `;
  return {
    required: rows.some(
      (row) =>
        row.role === 'owner' ||
        MFA_REQUIRING_GRANT_COLUMNS.some((column) => row.grants[column] === true),
    ),
    enabled: rows.some((row) => row.enabled === true),
  };
}

/** The tenant-wall refusal: the account must enrol before tenant data is
 * served. Enrolment endpoints stay reachable, so the client renders the
 * enrolment wall from this code rather than a dead end. */
export function mfaEnrolmentRequiredError(): Error {
  return httpError(
    403,
    'MFA_ENROLMENT_REQUIRED',
    'This account holds document authority and must enrol in two-factor authentication before using organisation data.',
  );
}

/** The disable refusal: a required user may rotate their enrolment but
 * never stand without one while holding authority. */
export function mfaRequiredByPolicyError(): Error {
  return httpError(
    403,
    'MFA_REQUIRED_BY_POLICY',
    'Two-factor authentication is required for accounts holding document authority and cannot be disabled.',
  );
}
