import { describe, expect, it } from 'vitest';
import type { TransactionSql } from '@auto-mb/db';
import { assertWorkAccess, hasFullWorkScope } from '../src/authz.js';

/**
 * What the scope helpers answer when there is no membership to read.
 *
 * `hasFullWorkScope` is the ENTIRE work-scope predicate of the cross-Work
 * registers: its answer is interpolated straight into the SQL as
 * `(${full} or exists (select 1 from work_assignments …))`, so `true`
 * means every Work in the organisation. It used to be written
 * `membership?.work_scope !== 'assigned'`, which reads like a safe default
 * and is the opposite of one — an absent membership makes `work_scope`
 * `undefined`, which is not `'assigned'`, which was `true`.
 *
 * A bound request cannot normally reach it without a membership; the
 * tenant binding refuses first. That is exactly why this is worth pinning
 * rather than trusting: the failure is invisible in every ordinary path
 * and total in the one that isn't. `assertWorkAccess` beside it is the
 * posture being matched — a missing membership is no access at all.
 *
 * A stub transaction rather than a database, because the question is what
 * this function does with an empty result set, not what PostgreSQL returns
 * for it. Both helpers read through `membershipOf`, whose only statement is
 * the membership select.
 */

/** A transaction whose every tagged-template query answers with `rows`. */
function txAnswering(rows: readonly unknown[]): TransactionSql {
  return (() => Promise.resolve(rows)) as unknown as TransactionSql;
}

const USER_ID = 'user-with-no-membership';
const WORK_ID = '33333333-3333-4333-8333-333333333333';

describe('work-scope helpers with no membership row', () => {
  it('does not grant full work scope', async () => {
    await expect(hasFullWorkScope(txAnswering([]), USER_ID)).resolves.toBe(false);
  });

  it('refuses Work access, as the routes already relied on', async () => {
    await expect(assertWorkAccess(txAnswering([]), USER_ID, WORK_ID)).rejects.toThrow(
      'No such Work.',
    );
  });

  it('still grants full scope to a membership that carries it', async () => {
    const full = txAnswering([
      {
        role: 'office',
        work_scope: 'all',
        can_issue_documents: false,
        can_cancel_documents: false,
        can_manage_statutory_reporting: false,
      },
    ]);
    await expect(hasFullWorkScope(full, USER_ID)).resolves.toBe(true);

    const assigned = txAnswering([
      {
        role: 'office',
        work_scope: 'assigned',
        can_issue_documents: false,
        can_cancel_documents: false,
        can_manage_statutory_reporting: false,
      },
    ]);
    await expect(hasFullWorkScope(assigned, USER_ID)).resolves.toBe(false);
  });
});
