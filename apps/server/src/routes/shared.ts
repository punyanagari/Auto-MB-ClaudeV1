import { ApiErrorSchema } from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { httpError } from '../http.js';

/** The error envelope every tenant-scoped route can answer: schema and
 * field refusals (400), a missing session (401), the membership and
 * authority walls (403), unknown ids (404), and state conflicts (409). */
export const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

/** `errorResponses` plus 502, for routes that call an upstream — the PDF
 * renderer, the malware scanner, or a statutory provider — and surface
 * its failure as their own named refusal. */
export const upstreamErrorResponses = {
  ...errorResponses,
  502: ApiErrorSchema,
} as const;

/** How far ahead "expiring" reaches, in days.
 *
 * One number, because "expiring soon" has to mean the same thing on the
 * Dashboard's PBG alert and in the company document library — an operator
 * who learns that amber means two months on one screen must not have to
 * relearn it on the next. The value is the mock's own — its
 * `expiringGuarantees` helper defaults to sixty days at fdfe5ef — and it
 * is the lead time a bank guarantee renewal actually needs. */
export const EXPIRY_WARNING_DAYS = 60;

export const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

/** The optional twin: absent stays absent, and a value of nothing but
 * spaces is absent too rather than a blank string in the column. */
export function optionalTrimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** One audit row, written inside the caller's tenant transaction. The
 * entity type is the table the event is about; routes that carry
 * before/after diffs or actor-free facts still write their own inline
 * inserts. A null entity id records an organisation-level fact. */
export async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, ${entityType}, ${entityId},
      ${jsonb(tx, details)}
    )
  `;
}

/**
 * A trust-boundary string, trimmed, refusing one that is only whitespace.
 *
 * `minLength: 1` in a schema admits a string of spaces, and the CHECK
 * constraints that back these columns refuse an untrimmed or blank value.
 * Without this the refusal arrives as SQLSTATE 23514 — a 500 rather than a
 * 400, and on an upload route one raised AFTER the bytes have been written
 * to object storage, so the caller gets an unexplained server error and
 * leaves an orphan object behind. Call it BEFORE the malware scan, which
 * is the expensive step no ill-formed request should reach.
 */
export function requireTrimmed(value: string, refusal: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw httpError(400, 'FIELD_TOO_SHORT', refusal);
  return trimmed;
}

/**
 * How much of a purchase order line has actually arrived, as one SQL
 * expression over an alias `pol` bound to `purchase_order_lines`.
 *
 * ONE FRAGMENT, THREE READERS: `readLines` below, the `status=open`
 * filter beside it, and `routes/challans.ts`'s over-receipt warning. They
 * had three copies of this arithmetic between them, and three copies of a
 * number that decides whether an order may be CLOSED is three chances to
 * answer differently.
 *
 * ## The channel is per line, and it is declared when the line is written
 *
 * Material reaches an order two ways, and a line takes exactly one of
 * them:
 *
 *   * a line carrying `production_item_id` is STOCK-received — it names a
 *     part, so a receipt can add to a shelf;
 *   * a line without one is CHALLAN-received — it names a contract item
 *     or a typed description, and its material is passed on to site.
 *
 * That column IS the declaration the review asked for: it is set when the
 * line is created and never afterwards, so a line cannot change channel
 * under a balance that has already counted it. No second column is needed
 * to say the same thing twice.
 *
 * Summing the two channels would double-count the moment one line was
 * both, so this picks ONE by the declaration rather than adding them —
 * and `app_private.guard_challan_line_receipt_channel` (0087) refuses a
 * challan item that points at a stock line, so the branch this expression
 * does not read can never contain a row.
 */
export function receivedQuantitySql(
  options: {
    /** A SQL expression naming a delivery challan to leave OUT of the
     * challan channel — a placeholder like `$1`, never request text. The
     * challan editor passes its own id so it can add its draft lines on
     * top and project what the balance WILL be; every other caller wants
     * the settled figure and omits this. */
    readonly excludingChallan?: string;
  } = {},
): string {
  const exclusion =
    options.excludingChallan === undefined
      ? ''
      : ` and dci.delivery_challan_id <> ${options.excludingChallan}`;
  return `
  case when pol.production_item_id is null then
    coalesce((
      select sum(dci.quantity)
      from delivery_challan_items dci
      join delivery_challans dc on dc.id = dci.delivery_challan_id
      where dci.purchase_order_line_id = pol.id and dc.status = 'issued'${exclusion}
    ), 0)
  else
    coalesce((
      select sum(sm.quantity)
      from stock_movements sm
      where sm.purchase_order_line_id = pol.id
    ), 0)
  end`;
}
