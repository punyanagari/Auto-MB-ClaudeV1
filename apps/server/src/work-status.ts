/**
 * The one refusal every operational-document route shares once a Work can
 * be completed (R8, migration 0031): a completed Work accepts no new
 * challan, issue challan, installation, PAC certificate, Measurement
 * Book, extension request, or change proposal until it is reopened.
 *
 * Several routes have carried a `status <> 'active'` refusal since before
 * the transition existed; they all route through here now so the operator
 * gets one stable code and one instruction. The database backstops every
 * one of these checks (0031 guard functions), so raw SQL is refused too.
 */

import { httpError } from './http.js';

/** Refuses on a completed Work with the reopen instruction. `action` is
 * the operator-facing gerund phrase, e.g. "issuing a delivery challan". */
export function assertWorkOperable(status: string, action: string): void {
  if (status === 'completed') {
    throw httpError(
      409,
      'WORK_COMPLETED',
      `This Work is completed; reopen it before ${action}.`,
    );
  }
  if (status !== 'active') {
    throw httpError(409, 'WORK_NOT_ACTIVE', `This Work is ${status}.`);
  }
}
