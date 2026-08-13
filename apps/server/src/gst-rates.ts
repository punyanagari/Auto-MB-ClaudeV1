import type { TransactionSql } from '@auto-mb/db';
import { httpError } from './http.js';

/**
 * The GST rate master (migration 0048, audit finding 19): an invoice's
 * rate is not an opinion but a Government notification with a date range,
 * so every write of a (rate, date) pair is checked against the
 * organisation's own `gst_rates` rows. The 0048 trigger backstops tax
 * invoices in the database; these helpers make the refusal a named 400
 * with the rates that WOULD be accepted, instead of a plpgsql message
 * surfacing as a 500.
 */

/** The notified rate history seeded for every organisation. Kept in one
 * place so organisation creation (routes/identity.ts) and the cutover
 * importer seed exactly what migration 0048 seeded for organisations
 * that already existed. The 22 September 2025 GST 2.0 reform (56th GST
 * Council meeting) abolished 12% and 28% and introduced 40%. */
export const DEFAULT_GST_RATES: readonly {
  readonly rate: string;
  readonly label: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}[] = [
  {
    rate: '0.00',
    label: 'Nil-rated / exempt supply',
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
  {
    rate: '0.25',
    label: 'Special rate 0.25% (rough diamonds)',
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
  {
    rate: '1.50',
    label: 'Special rate 1.5% (cut and polished diamonds)',
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
  {
    rate: '3.00',
    label: 'Special rate 3% (gold and precious metals)',
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
  {
    rate: '5.00',
    label: 'Merit rate 5%',
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
  {
    rate: '12.00',
    label: 'Standard 12% — abolished 22 Sep 2025 (GST 2.0)',
    effectiveFrom: '2017-07-01',
    effectiveTo: '2025-09-21',
  },
  {
    rate: '18.00',
    label: 'Standard 18%',
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
  {
    rate: '28.00',
    label: 'Demerit 28% — abolished 22 Sep 2025 (GST 2.0)',
    effectiveFrom: '2017-07-01',
    effectiveTo: '2025-09-21',
  },
  {
    rate: '40.00',
    label: 'Demerit 40% (GST 2.0)',
    effectiveFrom: '2025-09-22',
    effectiveTo: null,
  },
];

/**
 * Seeds the default notified-rate history for one organisation,
 * idempotently: ON CONFLICT against the (organisation, rate, start)
 * uniqueness skips every row that already exists — a re-run converges
 * and an owner's own later edits are never overwritten. Returns how many
 * rows were actually inserted so the caller can audit a real change and
 * stay silent on a no-op.
 */
export async function seedDefaultGstRates(
  tx: TransactionSql,
  organisationId: string,
): Promise<number> {
  // One statement for the whole default history: `ON CONFLICT DO
  // NOTHING` still skips each row that already exists, and the
  // statement's own count is exactly the number the per-row loop
  // accumulated.
  const result = await tx`
    insert into gst_rates (
      organisation_id, rate, label, effective_from, effective_to
    )
    select ${organisationId}, seed.rate, seed.label, seed.effective_from,
           seed.effective_to
    from unnest(
      ${DEFAULT_GST_RATES.map((seed) => seed.rate)}::numeric(5,2)[],
      ${DEFAULT_GST_RATES.map((seed) => seed.label)}::text[],
      ${DEFAULT_GST_RATES.map((seed) => seed.effectiveFrom)}::date[],
      ${DEFAULT_GST_RATES.map((seed) => seed.effectiveTo)}::date[]
    ) as seed(rate, label, effective_from, effective_to)
    on conflict (organisation_id, rate, effective_from) do nothing
  `;
  return result.count;
}

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
