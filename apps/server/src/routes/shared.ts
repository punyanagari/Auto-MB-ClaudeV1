import { ApiErrorSchema } from '@auto-mb/contracts';
import { httpError } from '../http.js';
import { Type } from '@sinclair/typebox';
import type { TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';

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
