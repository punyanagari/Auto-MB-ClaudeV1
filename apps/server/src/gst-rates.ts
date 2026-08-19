import type { TransactionSql } from '@auto-mb/db';
import { httpError } from './http.js';

/**
 * The GST rate master (migration 0048, audit finding 19): an invoice's
 * rate is not an opinion but a Government notification with a date range,
 * so every write of a (rate, date) pair is checked against the
 * organisation's own `gst_rates` rows. The 0048 trigger backstops tax
 * invoices in the database; this helper makes the refusal a named 400
 * with the rates that WOULD be accepted, instead of a plpgsql message
 * surfacing as a 500.
 *
 * The default rate history this file used to carry as a TypeScript
 * constant is gone: it was the same statutory list migration 0048 § 2
 * already held, and two copies of a notified rate drift. Migration 0103
 * made `app_private.seed_default_statutory_rows` the single source, and
 * organisation creation and the v1 importer call that. Nothing here reads
 * a list — the check below reads the organisation's own rows, which is
 * what it always did.
 */

/**
 * Refuses a (rate, date) pair no `gst_rates` row of the bound
 * organisation covers. RLS scopes the read, so the master consulted is
 * always the caller's own. `context` prefixes the message when the rate
 * sits on a numbered line ("Line 2: …") so the operator knows where to
 * look.
 */
export async function assertGstRateNotified(
  tx: TransactionSql,
  rate: string,
  onDate: string,
  context?: string,
): Promise<void> {
  const prefix = context === undefined ? '' : `${context}: `;
  const [covered] = await tx<{ ok: boolean }[]>`
    select true as ok from gst_rates
    where rate = ${rate}::numeric(5,2)
      and effective_from <= ${onDate}
      and (effective_to is null or effective_to >= ${onDate})
    limit 1
  `;
  if (covered) return;
  // Ordered by the NUMERIC column — the text alias would sort '12.00'
  // before '5.00'.
  const effective = await tx<{ rate_text: string }[]>`
    select distinct rate::text as rate_text, rate from gst_rates
    where effective_from <= ${onDate}
      and (effective_to is null or effective_to >= ${onDate})
    order by rate
  `;
  const list = effective.map((row) => `${row.rate_text}%`).join(', ');
  throw httpError(
    400,
    'GST_RATE_NOT_NOTIFIED',
    `${prefix}GST rate ${rate}% is not notified on ${onDate}. Rates effective on that date: ${
      list === '' ? 'none — the GST rate master is empty' : list
    }. Pick one of them, or have an organisation owner add the notification to the GST rate master first.`,
  );
}
