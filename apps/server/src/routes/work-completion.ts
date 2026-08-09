/**
 * R8 work completion and reopen (Milestone 6/7 retrofit, migration 0031).
 *
 * "A work can be marked `completed` only at 100% executed value — every
 * item fully installed and every supply item fully delivered. Short
 * closure = first amend quantities down (which itself requires approval),
 * then complete. Completion/reopen takes an audit note." (legacy §6 R8)
 *
 * Authority. Both transitions require the owner/office writer role and a
 * mandatory note — deliberately NOT the can_issue_documents authority.
 * That authority governs assigning a number to a legal document (R2's
 * gap-free series); completion assigns no number and issues nothing. It
 * is a contract-administration state change, and it sits with the same
 * authority as the other contract-administration acts on a Work: setting
 * the completion date, proposing an amendment, raising an extension
 * request. Site members record evidence; they do not close contracts.
 *
 * Concurrency. Completion takes the works row lock and then the
 * work_items locks (the works -> work_items order every other writer
 * uses), so it serialises against every writer that can move a
 * delivered/installed/effective quantity: delivery-challan issue,
 * installation recording, PAC recording and MB finalisation all take the
 * works lock, and amendment apply takes the work_items lock. Whichever
 * commits second sees the other. The 0031 guard functions are the
 * database backstop for the losing side.
 */

import {
  ApiErrorSchema,
  CompleteWorkRequestSchema,
  ReopenWorkRequestSchema,
  WorkStatusResponseSchema,
  type CompleteWorkRequest,
  type ReopenWorkRequest,
  type UnfinishedWorkItem,
  type WorkCompletionBlocker,
  type WorkNotCleanDetails,
  type WorkNotFullyExecutedDetails,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import { httpError } from '../http.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

interface WorkStatusRow {
  id: string;
  work_code: string;
  letter_number: string;
  letter_date: string;
  title: string;
  advertised_value: string;
  contract_value: string;
  pricing_shape: 'letter_percentage' | 'per_schedule';
  letter_percentage: string | null;
  letter_percentage_direction: 'below' | 'at_par' | 'above' | null;
  pbg_required_amount: string | null;
  pbg_submission_days: number | null;
  pbg_extension_days: number | null;
  pbg_penal_interest_percent: string | null;
  status: 'active' | 'completed' | 'cancelled';
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_note: string | null;
  created_at: Date;
  allow_excess_delivery: boolean;
}

const WORK_COLUMNS = `
  id, work_code, letter_number, letter_date::text as letter_date, title,
  advertised_value, contract_value, pricing_shape, letter_percentage,
  letter_percentage_direction,
  pbg_required_amount::text as pbg_required_amount,
  pbg_submission_days, pbg_extension_days,
  pbg_penal_interest_percent::text as pbg_penal_interest_percent,
  status, completed_at, completed_by_user_id, completion_note,
  created_at, allow_excess_delivery
`;

function toWorkStatusResponse(row: WorkStatusRow) {
  return {
    work: {
      id: row.id,
      workCode: row.work_code,
      letterNumber: row.letter_number,
      letterDate: row.letter_date,
      title: row.title,
      advertisedValue: row.advertised_value,
      contractValue: row.contract_value,
      pricingShape: row.pricing_shape,
      letterPercentage: row.letter_percentage,
      letterPercentageDirection: row.letter_percentage_direction,
      pbgRequiredAmount: row.pbg_required_amount,
      pbgSubmissionDays: row.pbg_submission_days,
      pbgExtensionDays: row.pbg_extension_days,
      pbgPenalInterestPercent: row.pbg_penal_interest_percent,
      status: row.status,
      completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
      completedByUserId: row.completed_by_user_id,
      completionNote: row.completion_note,
      createdAt: row.created_at.toISOString(),
      allowExcessDelivery: row.allow_excess_delivery,
    },
  };
}

/** Locks the Work row for the rest of the transaction. Both transitions
 * start here, so a complete and a reopen — and every source writer that
 * takes the same lock — serialise. */
async function lockWork(tx: TransactionSql, workId: string): Promise<WorkStatusRow> {
  const [row] = await tx<WorkStatusRow[]>`
    select ${tx.unsafe(WORK_COLUMNS)}
    from works where id = ${workId} and deleted_at is null
    for update
  `;
  if (!row) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return row;
}

async function readWork(tx: TransactionSql, workId: string): Promise<WorkStatusRow> {
  const [row] = await tx<WorkStatusRow[]>`
    select ${tx.unsafe(WORK_COLUMNS)}
    from works where id = ${workId} and deleted_at is null
  `;
  if (!row) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return row;
}

interface UnfinishedRow {
  id: string;
  item_number: string;
  payment_category: UnfinishedWorkItem['category'];
  requirement: UnfinishedWorkItem['requirement'];
  required_quantity: string;
  delivered_quantity: string;
  installed_quantity: string;
}

/**
 * The R8 predicate, in exact SQL over EFFECTIVE quantities. "Fully" is
 * numeric EQUALITY against coalesce(effective_quantity, awarded_quantity)
 * — no tolerance, no >=; an over-delivered item (possible only with the
 * excess toggle) is as unfinished as a short one, and short closure means
 * amending the baseline down first. Soft-deleted items are excluded (a
 * removed item owes nothing). An item amended to quantity 0 — the
 * omission case — is satisfied by delivering and installing nothing.
 *
 * The requirement per payment category (spec §8 / the settled matrix):
 *   SUPPLY, SPARE_SUPPLY        -> fully delivered
 *   PURE_INSTALLATION           -> fully installed
 *   SUPPLY_AND_INSTALLATION     -> fully delivered AND fully installed
 *   uncategorised               -> effective description mentioning
 *                                  'installation' (case-insensitive)
 *                                  -> fully installed, else fully
 *                                  delivered.
 */
async function unfinishedItems(
  tx: TransactionSql,
  workId: string,
): Promise<readonly UnfinishedWorkItem[]> {
  // Lock every item first, in id order: amendment apply takes the same
  // row lock before lowering a ceiling, so no effective quantity can move
  // under the predicate. Lock order works -> work_items matches every
  // other writer taking both.
  await tx`
    select id from work_items
    where work_id = ${workId} and deleted_at is null
    order by id
    for update
  `;
  const rows = await tx<UnfinishedRow[]>`
    select measured.id, measured.item_number, measured.payment_category,
           measured.requirement,
           measured.required_quantity::text as required_quantity,
           measured.delivered_quantity::text as delivered_quantity,
           measured.installed_quantity::text as installed_quantity
    from (
      select wi.id, wi.item_number, wi.payment_category,
             coalesce(wi.effective_quantity, wi.awarded_quantity)
               as required_quantity,
             case
               when wi.payment_category in ('SUPPLY', 'SPARE_SUPPLY')
                 then 'delivery'
               when wi.payment_category = 'PURE_INSTALLATION'
                 then 'installation'
               when wi.payment_category = 'SUPPLY_AND_INSTALLATION'
                 then 'delivery_and_installation'
               when coalesce(wi.effective_description, wi.description)
                    ilike '%installation%'
                 then 'installation'
               else 'delivery'
             end as requirement,
             coalesce((
               select sum(dci.quantity)
               from delivery_challan_items dci
               join delivery_challans dc on dc.id = dci.delivery_challan_id
               where dci.work_item_id = wi.id and dc.status = 'issued'
             ), 0)::numeric(18,3) as delivered_quantity,
             coalesce((
               select sum(i.quantity)
               from installations i
               where i.work_item_id = wi.id and i.status = 'recorded'
             ), 0)::numeric(18,3) as installed_quantity
      from work_items wi
      where wi.work_id = ${workId} and wi.deleted_at is null
    ) measured
    where (
      measured.requirement in ('delivery', 'delivery_and_installation')
      and measured.delivered_quantity <> measured.required_quantity
    ) or (
      measured.requirement in ('installation', 'delivery_and_installation')
      and measured.installed_quantity <> measured.required_quantity
    )
    order by measured.item_number
  `;
  return rows.map((row) => ({
    workItemId: row.id,
    itemNumber: row.item_number,
    category: row.payment_category,
    requirement: row.requirement,
    requiredQuantity: row.required_quantity,
    deliveredQuantity: row.delivered_quantity,
    installedQuantity: row.installed_quantity,
  }));
}

interface BlockerRow {
  kind: WorkCompletionBlocker['kind'];
  record_id: string;
  label: string;
}

/**
 * The adopted CLEAN-STATE rule. Completing a Work while something live
 * still holds a claim on it would strand that record behind the
 * completed-work refusals: a draft challan could never be issued, a draft
 * Measurement Book could never be finalised, and a pending approval could
 * never be applied. The draft-MB and pending-approval cases matter most —
 * both hold claims on quantities the R8 predicate has just been measured
 * against. So completion refuses while any of them exists, and the 409
 * names every one.
 */
async function completionBlockers(
  tx: TransactionSql,
  workId: string,
): Promise<readonly WorkCompletionBlocker[]> {
  const rows = await tx<BlockerRow[]>`
    select 'draft_delivery_challan' as kind, dc.id as record_id,
           'Draft delivery challan dated ' || dc.challan_date::text as label
    from delivery_challans dc
    where dc.work_id = ${workId} and dc.status = 'draft'
    union all
    select 'draft_issue_challan', ic.id,
           'Draft issue challan dated ' || ic.challan_date::text
    from issue_challans ic
    where ic.work_id = ${workId} and ic.status = 'draft'
    union all
    select 'draft_extension_request', er.id,
           'Draft extension request proposing '
             || er.proposed_completion_date::text
    from extension_requests er
    where er.work_id = ${workId} and er.status = 'draft'
    union all
    select 'draft_measurement_book', mb.id,
           'Draft Measurement Book dated ' || mb.mb_date::text
    from measurement_books mb
    where mb.work_id = ${workId} and mb.status = 'draft'
    union all
    select 'pending_approval_request', ar.id,
           'Pending change proposal (' || ar.entity_type || ')'
    from approval_requests ar
    where ar.work_id = ${workId} and ar.status = 'pending'
    order by 1, 3
  `;
  return rows.map((row) => ({
    kind: row.kind,
    recordId: row.record_id,
    label: row.label,
  }));
}

async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  workId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, 'works', ${workId},
      ${jsonb(tx, details)}
    )
  `;
}

export function registerWorkCompletionRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
): void {
  app.post(
    '/api/works/:id/complete',
    {
      schema: {
        params: IdParamsSchema,
        body: CompleteWorkRequestSchema,
        response: { 200: WorkStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as CompleteWorkRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);
        if (work.status === 'completed') {
          throw httpError(
            409,
            'WORK_ALREADY_COMPLETED',
            'This Work is already completed.',
          );
        }
        if (work.status !== 'active') {
          throw httpError(409, 'WORK_NOT_ACTIVE', `This Work is ${work.status}.`);
        }

        const blockers = await completionBlockers(tx, workId);
        if (blockers.length > 0) {
          const details: WorkNotCleanDetails = { blockers: [...blockers] };
          throw httpError(
            409,
            'WORK_NOT_CLEAN',
            `Finish or discard these before completing the Work: ${blockers
              .map((blocker) => blocker.label)
              .join('; ')}.`,
            details,
          );
        }

        const unfinished = await unfinishedItems(tx, workId);
        if (unfinished.length > 0) {
          const details: WorkNotFullyExecutedDetails = {
            unfinishedItems: [...unfinished],
          };
          throw httpError(
            409,
            'WORK_NOT_FULLY_EXECUTED',
            `A Work completes only at 100% executed value; ${String(unfinished.length)} item(s) are short: ${unfinished
              .map((item) => item.itemNumber)
              .join(
                ', ',
              )}. For a short closure, amend those quantities down through the approval path first, then complete.`,
            details,
          );
        }

        await tx`
          update works
          set status = 'completed',
              completed_at = now(),
              completed_by_user_id = ${user.id},
              completion_note = ${body.note},
              reopened_at = null,
              reopened_by_user_id = null,
              reopen_note = null
          where id = ${workId}
        `;
        await audit(tx, organisationId, user.id, 'work.completed', workId, {
          before: { status: work.status },
          after: { status: 'completed' },
          note: body.note,
        });
        return toWorkStatusResponse(await readWork(tx, workId));
      });
    },
  );

  app.post(
    '/api/works/:id/reopen',
    {
      schema: {
        params: IdParamsSchema,
        body: ReopenWorkRequestSchema,
        response: { 200: WorkStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as ReopenWorkRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);
        if (work.status !== 'completed') {
          throw httpError(
            409,
            'WORK_NOT_COMPLETED',
            `Only a completed Work can be reopened (current status: ${work.status}).`,
          );
        }
        // Reopening carries no predicate by design: a Work is reopened
        // precisely because reality contradicted the closure, and the
        // note records why.
        await tx`
          update works
          set status = 'active',
              completed_at = null,
              completed_by_user_id = null,
              completion_note = null,
              reopened_at = now(),
              reopened_by_user_id = ${user.id},
              reopen_note = ${body.note}
          where id = ${workId}
        `;
        await audit(tx, organisationId, user.id, 'work.reopened', workId, {
          before: { status: 'completed', completionNote: work.completion_note },
          after: { status: 'active' },
          note: body.note,
        });
        return toWorkStatusResponse(await readWork(tx, workId));
      });
    },
  );
}
