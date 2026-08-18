import type { JobHandler } from '../runtime.js';
import { PermanentJobError } from '../runtime.js';

/**
 * The recurring guarantee-and-certificate expiry review (migration 0096).
 *
 * A performance guarantee that lapses is a contract breach, and no bank
 * issues one retrospectively — so this is the check an agency loses real
 * money by missing, and it is the one recurring kind this pack ships.
 *
 * ## What it does, and what it deliberately does not
 *
 * It reads `work_instruments` under the schedule's own tenant binding and
 * records what it found: how many are inside the horizon, and enough about
 * each to act on. It sends nothing. There is no notification channel in
 * this product yet, and inventing one here would be a second place to
 * decide who gets told.
 *
 * The finding lands in two places, on purpose:
 *
 *   the JOB OUTCOME, which the platform screen renders as run history —
 *   the operator's answer to "did this run, and what did it say";
 *   an AUDIT EVENT, which is the organisation's durable record and travels
 *   in the export. The queue is purged on a retention window (0072 § 5b),
 *   so an outcome alone would be a finding that quietly disappears.
 *
 * ## Why it re-reads the horizon from the schedule
 *
 * `horizonDays` arrives on the payload because the scheduler read it from
 * the schedule row at enqueue time. It is used as given rather than
 * re-read here: the job's finding should describe the schedule as it stood
 * when the run was commissioned, not as somebody edited it mid-flight.
 */
export function createInstrumentExpiryReviewHandler(): JobHandler {
  return async ({ job, tenant }) => {
    const horizonDays = Number(job.payloadRef.horizonDays);
    if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 365) {
      // A payload the scheduler could not have written. Retrying would
      // re-discover the same answer on every attempt.
      throw new PermanentJobError(
        `instrument_expiry_review needs a horizon between 1 and 365 days, not ${String(job.payloadRef.horizonDays)}`,
      );
    }

    return tenant(async (tx) => {
      const rows = await tx<
        {
          id: string;
          work_id: string;
          kind: string;
          expires_on: string;
          days_remaining: number;
        }[]
      >`
        select i.id, i.work_id, i.kind,
               to_char(i.expires_on, 'YYYY-MM-DD') as expires_on,
               (i.expires_on - current_date) as days_remaining
        from work_instruments i
        where i.status = 'active'
          and i.expires_on is not null
          and i.expires_on <= current_date + ${horizonDays}
        order by i.expires_on, i.id
      `;

      // Capped in the outcome, uncapped in the count. An organisation with
      // four hundred expiring instruments has a different problem from one
      // with three, and the operator needs the number either way — but
      // `worker_jobs.outcome` sits on a table no tenant policy protects,
      // so what travels into it is bounded on purpose.
      const expiring = rows.slice(0, 50).map((row) => ({
        instrumentId: row.id,
        workId: row.work_id,
        kind: row.kind,
        expiresOn: row.expires_on,
        daysRemaining: row.days_remaining,
      }));

      const lapsed = rows.filter((row) => row.days_remaining < 0).length;

      await tx`
        insert into audit_events (
          organisation_id, actor_user_id, action, entity_type, details
        )
        values (
          ${job.organisationId}, ${job.userId},
          'instrument_expiry.reviewed', 'work_instruments',
          ${tx.json({ horizonDays, expiring: rows.length, lapsed })}
        )
      `;

      return { horizonDays, reviewed: rows.length, lapsed, expiring };
    });
  };
}
