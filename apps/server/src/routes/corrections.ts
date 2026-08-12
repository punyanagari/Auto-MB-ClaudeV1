import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  ApprovalRequestSchema,
  CancelCorrectionNoticeRequestSchema,
  CorrectionEligibilityResponseSchema,
  CorrectionNoticeDetailResponseSchema,
  CorrectionNoticeListResponseSchema,
  ProposeChallanCancelReplaceRequestSchema,
  ProposeCorrectionNoticeRequestSchema,
  ProposeIssueChallanCancelReplaceRequestSchema,
  type AmendmentDiffEntry,
  type CancelCorrectionNoticeRequest,
  type CorrectionEligibilityResponse,
  type CorrectionNotice,
  type CorrectionNoticeDetailResponse,
  type CorrectionNoticeEntry,
  type Consignee,
  type ProposeChallanCancelReplaceRequest,
  type ProposeCorrectionNoticeRequest,
  type ProposeIssueChallanCancelReplaceRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import {
  challanEvidenceCounts,
  type ChallanCancelReplaceProposal,
  type CorrectionNoticeProposal,
  type IssueChallanCancelReplaceProposal,
} from '../corrections-apply.js';
import {
  renderCorrectionNoticeHtml,
  type CorrectionNoticeSnapshot,
} from '../correction-notice-html.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { applyApproval, isApprover, readApproval } from './amendments.js';
import {
  assertChallanDate,
  cancellationNote,
  lockLinkedPurchaseOrdersForChallan,
  normaliseConsignee,
} from './challans.js';
import { normaliseHeader } from './issue-challans.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { assertWorkOperable } from '../work-status.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  502: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

interface NoticeRow {
  id: string;
  work_id: string;
  delivery_challan_id: string;
  approval_request_id: string;
  notice_number: string;
  sequence_number: number;
  status: CorrectionNotice['status'];
  template_version: string;
  rendered_object_key: string | null;
  cancellation_note: string | null;
  created_at: Date;
  cancelled_at: Date | null;
}

const NOTICE_COLUMNS = `
  id, work_id, delivery_challan_id, approval_request_id, notice_number,
  sequence_number, status, template_version, rendered_object_key,
  cancellation_note, created_at, cancelled_at
`;

function toNotice(row: NoticeRow): CorrectionNotice {
  return {
    id: row.id,
    workId: row.work_id,
    deliveryChallanId: row.delivery_challan_id,
    approvalRequestId: row.approval_request_id,
    noticeNumber: row.notice_number,
    sequenceNumber: row.sequence_number,
    status: row.status,
    templateVersion: row.template_version,
    renderedAvailable: row.rendered_object_key !== null,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

async function readNoticeDetail(
  tx: TransactionSql,
  noticeId: string,
): Promise<CorrectionNoticeDetailResponse> {
  const [row] = await tx<(NoticeRow & { snapshot: unknown })[]>`
    select ${tx.unsafe(NOTICE_COLUMNS)}, snapshot
    from correction_notices where id = ${noticeId}
  `;
  if (!row) throw httpError(404, 'NOTICE_NOT_FOUND', 'No such correction notice.');
  return { notice: toNotice(row), snapshot: parseJsonbColumn(row.snapshot) };
}

/** Locks the notice row so state transitions serialise. */
async function lockNotice(tx: TransactionSql, noticeId: string): Promise<NoticeRow> {
  const [row] = await tx<NoticeRow[]>`
    select ${tx.unsafe(NOTICE_COLUMNS)}
    from correction_notices where id = ${noticeId}
    for update
  `;
  if (!row) throw httpError(404, 'NOTICE_NOT_FOUND', 'No such correction notice.');
  return row;
}

interface LockedChallan {
  id: string;
  work_id: string;
  status: string;
  challan_number: string | null;
  challan_date: string;
  prefix: string;
  consignee_snapshot: unknown;
}

/** Locks a delivery challan for a correction proposal: the same row lock
 * every state transition takes, so a propose serialises against a
 * concurrent cancel or evidence write. */
async function lockDeliveryChallan(
  tx: TransactionSql,
  challanId: string,
): Promise<LockedChallan> {
  const [row] = await tx<LockedChallan[]>`
    select id, work_id, status, challan_number,
           challan_date::text as challan_date, prefix, consignee_snapshot
    from delivery_challans where id = ${challanId}
    for update
  `;
  if (!row) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
  return row;
}

async function requireActiveWork(tx: TransactionSql, workId: string): Promise<void> {
  // The works row lock pairs with the one POST /api/works/:id/complete
  // holds, so a correction proposal can never be stranded behind a
  // completed Work; the 0031 approval-request insert guard backstops it.
  const [work] = await tx<{ status: string }[]>`
    select status from works where id = ${workId} and deleted_at is null
    for update
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  assertWorkOperable(work.status, 'proposing a correction');
}

async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
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

function summariseItems(items: readonly { label: string; quantity: string }[]): string {
  return items.map((item) => `${item.label} Ã—${item.quantity}`).join('; ');
}

function summariseConsignee(consignee: Consignee): string {
  return [consignee.name, consignee.address, consignee.phone]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(', ');
}

/** Inserts the correction approval request; a 23505 from either
 * one-pending index answers as the familiar conflict. */
async function insertCorrectionRequest(
  tx: TransactionSql,
  organisationId: string,
  entityType: string,
  entityId: string,
  workId: string,
  proposed: unknown,
  diff: AmendmentDiffEntry[],
  reason: string,
  userId: string,
): Promise<{ id: string; entity_id: string | null; work_id: string }> {
  const [created] = await tx<
    { id: string; entity_id: string | null; work_id: string }[]
  >`
    insert into approval_requests (
      organisation_id, entity_type, entity_id, work_id, proposed,
      diff, reason, requested_by_user_id
    )
    values (
      ${organisationId}, ${entityType}, ${entityId}, ${workId},
      ${jsonb(tx, proposed)}, ${jsonb(tx, diff)}, ${reason}, ${userId}
    )
    returning id, entity_id, work_id
  `.catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      throw httpError(
        409,
        'PENDING_EXISTS',
        'This document already has a pending correction request; decide or withdraw it first.',
      );
    }
    throw error;
  });
  if (!created) throw new Error('approval insert returned no row');
  return created;
}

export function registerCorrectionRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
): void {
  // --- Which lawful path applies to this challan? ---------------------------
  app.get(
    '/api/challans/:id/correction-eligibility',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: CorrectionEligibilityResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx): Promise<CorrectionEligibilityResponse> => {
          const [challan] = await tx<{ work_id: string; status: string }[]>`
            select work_id, status from delivery_challans where id = ${id}
          `;
          if (!challan) {
            throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
          }
          await assertWorkAccess(tx, user.id, challan.work_id);
          const evidence = await challanEvidenceCounts(tx, id);
          const hasEvidence =
            evidence.receipts > 0 || evidence.serials > 0 || evidence.measurements > 0;
          const [pending] = await tx<{ id: string }[]>`
            select id from approval_requests
            where entity_id = ${id} and status = 'pending'
              and entity_type in ('challan_cancel_replace', 'challan_correction_notice')
          `;
          return {
            challanId: id,
            status: challan.status as CorrectionEligibilityResponse['status'],
            evidence,
            path:
              challan.status !== 'issued'
                ? null
                : hasEvidence
                  ? 'correction_notice'
                  : 'cancel_replace',
            pendingRequestId: pending?.id ?? null,
          };
        },
      );
    },
  );

  // --- Path A: propose cancel-and-replace for a Delivery Challan ------------
  app.post(
    '/api/challans/:id/corrections/cancel-replace',
    {
      schema: {
        params: IdParamsSchema,
        body: ProposeChallanCancelReplaceRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as ProposeChallanCancelReplaceRequest;
      // The replacement becomes a real draft challan on apply, so its
      // consignee is held to what the challan routes hold theirs to: not
      // blank once trimmed, and stored trimmed.
      const replacementConsignee = normaliseConsignee(body.replacement.consignee);

      const approval = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          // Self-approving proposals apply cancellation in this same
          // transaction. Authorise before locking linked POs, then follow
          // PO-close order (POs -> challan) to avoid a deadlock.
          const [challanRef] = await tx<{ work_id: string }[]>`
            select work_id from delivery_challans where id = ${id}
          `;
          if (!challanRef) {
            throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
          }
          await assertWorkAccess(tx, user.id, challanRef.work_id);
          await lockLinkedPurchaseOrdersForChallan(tx, id);
          const challan = await lockDeliveryChallan(tx, id);
          await assertWorkAccess(tx, user.id, challan.work_id);
          await requireActiveWork(tx, challan.work_id);
          if (challan.status !== 'issued') {
            throw httpError(
              409,
              'CHALLAN_STATUS_CONFLICT',
              'Corrections target ISSUED challans; edit or delete drafts directly.',
            );
          }
          const evidence = await challanEvidenceCounts(tx, id);
          if (
            evidence.receipts > 0 ||
            evidence.serials > 0 ||
            evidence.measurements > 0
          ) {
            throw httpError(
              409,
              'CHALLAN_HAS_EVIDENCE',
              'This challan has recorded evidence and can no longer be cancelled; file a correction notice instead.',
            );
          }
          await assertChallanDate(tx, challan.work_id, body.replacement.challanDate);

          // Normalise the replacement lines through SQL numeric and prove
          // each item belongs to this Work, so the stored proposal is
          // exactly what apply will write.
          const seen = new Set<string>();
          const replacementItems: (typeof body.replacement.items)[number][] = [];
          const replacementLabels: { label: string; quantity: string }[] = [];
          for (const item of body.replacement.items) {
            if (seen.has(item.workItemId)) {
              throw httpError(
                409,
                'DUPLICATE_ITEM',
                'The same Work item appears more than once on the replacement.',
              );
            }
            seen.add(item.workItemId);
            if (item.quantity.startsWith('-') || Number(item.quantity) === 0) {
              throw httpError(
                400,
                'QUANTITY_INVALID',
                'Every replacement quantity must be greater than zero.',
              );
            }
            const [row] = await tx<{ item_number: string; quantity: string }[]>`
              select wi.item_number, ${item.quantity}::numeric(18,3)::text as quantity
              from work_items wi
              where wi.id = ${item.workItemId} and wi.work_id = ${challan.work_id}
                and wi.deleted_at is null
            `;
            if (!row) {
              throw httpError(
                404,
                'WORK_ITEM_NOT_FOUND',
                'A replacement item does not belong to this Work.',
              );
            }
            replacementItems.push({
              workItemId: item.workItemId,
              quantity: row.quantity,
              ...(item.purchaseOrderLineId !== undefined
                ? { purchaseOrderLineId: item.purchaseOrderLineId }
                : {}),
            });
            replacementLabels.push({ label: row.item_number, quantity: row.quantity });
          }

          const currentItems = await tx<{ item_number: string; quantity: string }[]>`
            select wi.item_number, dci.quantity::text as quantity
            from delivery_challan_items dci
            join work_items wi on wi.id = dci.work_item_id
            where dci.delivery_challan_id = ${id}
            order by dci.position
          `;
          const currentConsignee = parseJsonbColumn(
            challan.consignee_snapshot,
          ) as Consignee;

          const diff: AmßÎù¶‰žËkºwµçA½ÉÉ•Ñ¥½¹9½Ñ¥•¹ÑÉåmt€ô€¡‰½‘ä¹½ÉÉ•Ñ¥½¹Ì€üümt¤¹µ…À (€€€€€€€€¡•¹ÑÉä¤€ôø€¡ì™¥•±è•¹ÑÉä¹™¥•±¹ÑÉ¥´ ¤°½ÉÉ•Ñ•è•¹ÑÉä¹½ÉÉ•Ñ•¹ÑÉ¥´ ¤ô¤°(€€€€€€¤ì(€€€€€½¹ÍÐÍÑ…Ñ•µ•¹Ð€ô‰½‘ä¹ÍÑ…Ñ•µ•¹Ðü¹ÑÉ¥´ ¤€üü€œœì(€€€€€¥˜€ (€€€€€€€½ÉÉ•Ñ¥½¹Ì¹Í½µ” (€€€€€€€€€€¡•¹ÑÉä¤€ôø•¹ÑÉä¹™¥•±¹±•¹Ñ €ôôô€Àñð•¹ÑÉä¹½ÉÉ•Ñ•¹±•¹Ñ €ôôô€À°(€€€€€€€€¤(€€€€€€¤ì(€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€ÐÀÀ°(€€€€€€€€€€=IIQ%=9}%9Y1%œ°(€€€€€€€€€€Ù•Éä™¥•±½ÉÉ•Ñ¥½¸¹••‘Ì‰½Ñ „™¥•±…¹„½ÉÉ•Ñ•É•…‘¥¹œ¸œ°(€€€€€€€€¤ì(€€€€€ô(€€€€€¥˜€¡½ÉÉ•Ñ¥½¹Ì¹±•¹Ñ €ôôô€À€˜˜ÍÑ…Ñ•µ•¹Ð¹±•¹Ñ €ôôô€À¤ì(€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€ÐÀÀ°(€€€€€€€€€€=IIQ%=9}5AQdœ°(€€€€€€€€€€½ÉÉ•Ñ¥½¸¹½Ñ¥”¹••‘Ì…Ð±•…ÍÐ½¹”™¥•±½ÉÉ•Ñ¥½¸½È„½ÉÉ•Ñ¥½¸ÍÑ…Ñ•µ•¹Ð¸œ°(€€€€€€€€¤ì(€€€€€ô((€€€€€½¹ÍÐ…ÁÁÉ½Ù…°€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€€€½¹ÍÐ¡…±±…¸€ô…Ý…¥Ð±½­•±¥Ù•Éå¡…±±…¸¡Ñà°¥¤ì(€€€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°¡…±±…¸¹Ý½É­}¥¤ì(€€€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•Ñ¥Ù•]½É¬¡Ñà°¡…±±…¸¹Ý½É­}¥¤ì(€€€€€€€€€¥˜€¡¡…±±…¸¹ÍÑ…ÑÕÌ€„ôô€¥ÍÍÕ•œ¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€!119}MQQUM}=91%Pœ°(€€€€€€€€€€€€€€½ÉÉ•Ñ¥½¸¹½Ñ¥•ÌÑ…É•Ð%MMU¡…±±…¹Ì¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€€¼¼A…Ñ •á¥ÍÑÌ™½È¡…±±…¹ÌÝ¡½Í”…¹•±±…Ñ¥½¸Ñ¡”•Ù¥‘•¹”(€€€€€€€€€€¼¼±…Ý™Õ±±ä‰±½­Ìì…¸•Ù¥‘•¹”µ™É•”¡…±±…¸Ñ…­•ÌA…Ñ Í¼Ñ¡”(€€€€€€€€€€¼¼ÝÉ½¹œ‘½Õµ•¹Ð‘½•Ì¹½ÐÍÑ…ä¥¸™½É”¸(€€€€€€€€€½¹ÍÐ•Ù¥‘•¹”€ô…Ý…¥Ð¡…±±…¹Ù¥‘•¹•½Õ¹ÑÌ¡Ñà°¥¤ì(€€€€€€€€€¥˜€ (€€€€€€€€€€€•Ù¥‘•¹”¹É••¥ÁÑÌ€ôôô€À€˜˜(€€€€€€€€€€€•Ù¥‘•¹”¹Í•É¥…±Ì€ôôô€À€˜˜(€€€€€€€€€€€•Ù¥‘•¹”¹µ•…ÍÕÉ•µ•¹ÑÌ€ôôô€À(€€€€€€€€€€¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€=IIQ%=9}UM}91}IA1œ°(€€€€€€€€€€€€€€Q¡¥Ì¡…±±…¸¡…Ì¹¼‘½Ý¹ÍÑÉ•…´•Ù¥‘•¹”ì½ÉÉ•Ð¥Ð‰ä…¹•°µ…¹µÉ•Á±…”¥¹ÍÑ•…¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô((€€€€€€€€€½¹ÍÐ‘¥™˜èµ•¹‘µ•¹Ñ¥™™¹ÑÉåmt€ô½ÉÉ•Ñ¥½¹Ì¹µ…À ¡•¹ÑÉä¤€ôø€¡ì(€€€€€€€€€€€™¥•±è•¹ÑÉä¹™¥•±°(€€€€€€€€€€€‰•™½É”è¹Õ±°°(€€€€€€€€€€€…™Ñ•Èè•¹ÑÉä¹½ÉÉ•Ñ•°(€€€€€€€€€ô¤¤ì(€€€€€€€€€¥˜€¡ÍÑ…Ñ•µ•¹Ð¹±•¹Ñ €ø€À¤ì(€€€€€€€€€€€‘¥™˜¹ÁÕÍ ¡ì™¥•±è€ÍÑ…Ñ•µ•¹Ðœ°‰•™½É”è¹Õ±°°…™Ñ•ÈèÍÑ…Ñ•µ•¹Ðô¤ì(€€€€€€€€€ô((€€€€€€€€€½¹ÍÐÁÉ½Á½Í•è½ÉÉ•Ñ¥½¹9½Ñ¥•AÉ½Á½Í…°€ôì(€€€€€€€€€€€­¥¹è€½ÉÉ•Ñ¥½¹}¹½Ñ¥”œ°(€€€€€€€€€€€¡…±±…¹%è¥°(€€€€€€€€€€€¡…±±…¹9Õµ‰•Èè¡…±±…¸¹¡…±±…¹}¹Õµ‰•È€üü€œœ°(€€€€€€€€€€€½ÉÉ•Ñ¥½¹Ì°(€€€€€€€€€€€ÍÑ…Ñ•µ•¹ÐèÍÑ…Ñ•µ•¹Ð¹±•¹Ñ €ø€À€üÍÑ…Ñ•µ•¹Ð€è¹Õ±°°(€€€€€€€€€€€É•…Í½¸è‰½‘ä¹É•…Í½¸°(€€€€€€€€€ôì(€€€€€€€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð¥¹Í•ÉÑ½ÉÉ•Ñ¥½¹I•ÅÕ•ÍÐ (€€€€€€€€€€€Ñà°(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€€¡…±±…¹}½ÉÉ•Ñ¥½¹}¹½Ñ¥”œ°(€€€€€€€€€€€¥°(€€€€€€€€€€€¡…±±…¸¹Ý½É­}¥°(€€€€€€€€€€€ÁÉ½Á½Í•°(€€€€€€€€€€€‘¥™˜°(€€€€€€€€€€€‰½‘ä¹É•…Í½¸°(€€€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€¤ì(€€€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€€€Ñà°(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€€€½ÉÉ•Ñ¥½¸¹ÁÉ½Á½Í•œ°(€€€€€€€€€€€€…ÁÁÉ½Ù…±}É•ÅÕ•ÍÑÌœ°(€€€€€€€€€€€É•…Ñ•¹¥°(€€€€€€€€€€€ì(€€€€€€€€€€€€€ÑåÁ”è€¡…±±…¹}½ÉÉ•Ñ¥½¹}¹½Ñ¥”œ°(€€€€€€€€€€€€€Ý½É­%è¡…±±…¸¹Ý½É­}¥°(€€€€€€€€€€€€€¡…±±…¹%è¥°(€€€€€€€€€€€€€¡…±±…¹9Õµ‰•Èè¡…±±…¸¹¡…±±…¹}¹Õµ‰•È°(€€€€€€€€€€€€€‘¥™˜°(€€€€€€€€€€€€€É•…Í½¸è‰½‘ä¹É•…Í½¸°(€€€€€€€€€€€ô°(€€€€€€€€€€¤ì(€€€€€€€€€¥˜€¡…Ý…¥Ð¥ÍÁÁÉ½Ù•È¡Ñà°ÕÍ•È¹¥¤¤ì(€€€€€€€€€€€…Ý…¥Ð…ÁÁ±åÁÁÉ½Ù…° (€€€€€€€€€€€€€Ñà°(€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€€€€ì€¸¸¹É•…Ñ•°ÁÉ½Á½Í•°‘¥™˜ô°(€€€€€€€€€€€€€¹Õ±°°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€É•ÑÕÉ¸É•…‘ÁÁÉ½Ù…°¡Ñà°É•…Ñ•¹¥¤ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÄ¤¹Í•¹¡…ÁÁÉ½Ù…°¤ì(€€€ô°(€€¤ì((€€¼¼€´´´½ÉÉ•Ñ¥½¸¹½Ñ¥”É•…‘Ì€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(€…ÁÀ¹•Ð (€€€€œ½…Á¤½Ý½É­Ì¼é¥½½ÉÉ•Ñ¥½¸µ¹½Ñ¥•Ìœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀè½ÉÉ•Ñ¥½¹9½Ñ¥•1¥ÍÑI•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥èÝ½É­%ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐÉ½ÝÌ€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°Ý½É­%¤ì(€€€€€€€€€½¹ÍÐmÝ½É­t€ô…Ý…¥ÐÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€€€Í•±•Ð¥™É½´Ý½É­ÌÝ¡•É”¥€ô€‘íÝ½É­%‘ô…¹‘•±•Ñ•‘}…Ð¥Ì¹Õ±°(€€€€€€€€€€ì(€€€€€€€€€¥˜€ …Ý½É¬¤Ñ¡É½Ü¡ÑÑÁÉÉ½È ÐÀÐ°€]=I-}9=Q}=U9œ°€9¼ÍÕ ]½É¬¸œ¤ì(€€€€€€€€€É•ÑÕÉ¸Ñàñ9½Ñ¥•I½Ýmtù€(€€€€€€€€€€€Í•±•Ð€‘íÑà¹Õ¹Í…™”¡9=Q%}=1U59L¥ô(€€€€€€€€€€€™É½´½ÉÉ•Ñ¥½¹}¹½Ñ¥•Ì(€€€€€€€€€€€Ý¡•É”Ý½É­}¥€ô€‘íÝ½É­%‘ô(€€€€€€€€€€€½É‘•È‰äÉ•…Ñ•‘}…Ð‘•ÍŒ°¥(€€€€€€€€€€ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸ì¹½Ñ¥•ÌèÉ½ÝÌ¹µ…À¡Ñ½9½Ñ¥”¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹•Ð (€€€€œ½…Á¤½¡…±±…¹Ì¼é¥½½ÉÉ•Ñ¥½¸µ¹½Ñ¥•Ìœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀè½ÉÉ•Ñ¥½¹9½Ñ¥•1¥ÍÑI•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐÉ½ÝÌ€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€½¹ÍÐm¡…±±…¹t€ô…Ý…¥ÐÑàñìÝ½É­}¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€€€Í•±•ÐÝ½É­}¥™É½´‘•±¥Ù•Éå}¡…±±…¹ÌÝ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€€ì(€€€€€€€€€¥˜€ …¡…±±…¸¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È ÐÀÐ°€!119}9=Q}=U9œ°€9¼ÍÕ •±¥Ù•Éä¡…±±…¸¸œ¤ì(€€€€€€€€€ô(€€€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°¡…±±…¸¹Ý½É­}¥¤ì(€€€€€€€€€É•ÑÕÉ¸Ñàñ9½Ñ¥•I½Ýmtù€(€€€€€€€€€€€Í•±•Ð€‘íÑà¹Õ¹Í…™”¡9=Q%}=1U59L¥ô(€€€€€€€€€€€™É½´½ÉÉ•Ñ¥½¹}¹½Ñ¥•Ì(€€€€€€€€€€€Ý¡•É”‘•±¥Ù•Éå}¡…±±…¹}¥€ô€‘í¥‘ô(€€€€€€€€€€€½É‘•È‰äÉ•…Ñ•‘}…Ð‘•ÍŒ°¥(€€€€€€€€€€ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸ì¹½Ñ¥•ÌèÉ½ÝÌ¹µ…À¡Ñ½9½Ñ¥”¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹•Ð (€€€€œ½…Á¤½½ÉÉ•Ñ¥½¸µ¹½Ñ¥•Ì¼é¥œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀè½ÉÉ•Ñ¥½¹9½Ñ¥••Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍÐmÉ•™t€ô…Ý…¥ÐÑàñìÝ½É­}¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€Í•±•ÐÝ½É­}¥™É½´½ÉÉ•Ñ¥½¹}¹½Ñ¥•ÌÝ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€ì(€€€€€€€¥˜€ …É•˜¤(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È ÐÀÐ°€9=Q%}9=Q}=U9œ°€9¼ÍÕ ½ÉÉ•Ñ¥½¸¹½Ñ¥”¸œ¤ì(€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°É•˜¹Ý½É­}¥¤ì(€€€€€€€É•ÑÕÉ¸É•…‘9½Ñ¥••Ñ…¥°¡Ñà°¥¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì((€€¼¼€´´´Q¡”¹½Ñ¥”A€¡•á¥ÍÑ¥¹œ½Ñ•¹‰•ÉœÁ¥Á•±¥¹”¤€´´´´´´´´´´´´´´´´´´´´´´´´´(€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½½ÉÉ•Ñ¥½¸µ¹½Ñ¥•Ì¼é¥½É•¹‘•Èœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀè½ÉÉ•Ñ¥½¹9½Ñ¥••Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì((€€€€€€¼¼M¹…ÁÍ¡½ÐÉ•……¹AÝÉ¥Ñ”±¥Ù”¥¸Í•Á…É…Ñ”ÑÉ…¹Í…Ñ¥½¹ÌÍ¼Ñ¡”(€€€€€€¼¼Í±½Ü•áÑ•É¹…°…±°¡½±‘Ì¹¼‘…Ñ…‰…Í”±½­ÌìÑ¡”±•…°½¹Ñ•¹Ð¥Ì(€€€€€€¼¼Ñ¡”¥µµÕÑ…‰±”Í¹…ÁÍ¡½Ð°Í¼É”µÉ•¹‘•É¥¹œÉ•ÁÉ½‘Õ•ÌÑ¡”¹½Ñ¥”¸(€€€€€½¹ÍÐìÍ¹…ÁÍ¡½Ð°‰É…¹‘¥¹œô€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€€€½¹ÍÐ¹½Ñ¥”€ô…Ý…¥Ð±½­9½Ñ¥”¡Ñà°¥¤ì(€€€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°¹½Ñ¥”¹Ý½É­}¥¤ì(€€€€€€€€€¥˜€¡¹½Ñ¥”¹ÍÑ…ÑÕÌ€„ôô€¥ÍÍÕ•œ¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€9=Q%}MQQUM}=91%Pœ°(€€€€€€€€€€€€€Q¡¥Ì½Á•É…Ñ¥½¸É•ÅÕ¥É•Ì…¸¥ÍÍÕ•½ÉÉ•Ñ¥½¸¹½Ñ¥”€¡ÕÉÉ•¹ÐÍÑ…ÑÕÌè€‘í¹½Ñ¥”¹ÍÑ…ÑÕÍô¤¹€°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñìÍ¹…ÁÍ¡½ÐèÕ¹­¹½Ý¸õmtù€(€€€€€€€€€€€Í•±•ÐÍ¹…ÁÍ¡½Ð™É½´½ÉÉ•Ñ¥½¹}¹½Ñ¥•ÌÝ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€€ì(€€€€€€€€€½¹ÍÐm½É…¹¥Í…Ñ¥½¹t€ô…Ý…¥ÐÑàð(€€€€€€€€€€€ì(€€€€€€€€€€€€€…‘‘É•ÍÌèÍÑÉ¥¹œð¹Õ±°ì(€€€€€€€€€€€€€ÍÑ¥¸èÍÑÉ¥¹œð¹Õ±°ì(€€€€€€€€€€€€€½¹Ñ…Ñ}Á¡½¹”èÍÑÉ¥¹œð¹Õ±°ì(€€€€€€€€€€€€€½¹Ñ…Ñ}•µ…¥°èÍÑÉ¥¹œð¹Õ±°ì(€€€€€€€€€€€€€±½½}½‰©•Ñ}­•äèÍÑÉ¥¹œð¹Õ±°ì(€€€€€€€€€€€€€±½½}µ•‘¥…}ÑåÁ”èÍÑÉ¥¹œð¹Õ±°ì(€€€€€€€€€€€õmt(€€€€€€€€€€ù€(€€€€€€€€€€€Í•±•Ð…‘‘É•ÍÌ°ÍÑ¥¸°½¹Ñ…Ñ}Á¡½¹”°½¹Ñ…Ñ}•µ…¥°°(€€€€€€€€€€€€€€€€€€±½½}½‰©•Ñ}­•ä°±½½}µ•‘¥…}ÑåÁ”(€€€€€€€€€€€™É½´½É…¹¥Í…Ñ¥½¹Ì(€€€€€€€€€€ì(€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€€€Í¹…ÁÍ¡½ÐèÁ…ÉÍ•)Í½¹‰½±Õµ¸¡É½Üü¹Í¹…ÁÍ¡½Ð¤…Ì½ÉÉ•Ñ¥½¹9½Ñ¥•M¹…ÁÍ¡½Ð°(€€€€€€€€€€€‰É…¹‘¥¹œè½É…¹¥Í…Ñ¥½¸€üü¹Õ±°°(€€€€€€€€€ôì(€€€€€€€ô°(€€€€€€¤ì((€€€€€±•Ð±½½…Ñ…UÉ¤èÍÑÉ¥¹œðÕ¹‘•™¥¹•ì(€€€€€¥˜€¡‰É…¹‘¥¹œü¹±½½}½‰©•Ñ}­•ä€˜˜‰É…¹‘¥¹œ¹±½½}µ•‘¥…}ÑåÁ”¤ì(€€€€€€€ÑÉäì(€€€€€€€€€½¹ÍÐ±½¼€ô…Ý…¥ÐÍÑ½É…”¹•Ð¡‰É…¹‘¥¹œ¹±½½}½‰©•Ñ}­•ä¤ì(€€€€€€€€€±½½…Ñ…UÉ¤€ô‘…Ñ„è‘í‰É…¹‘¥¹œ¹±½½}µ•‘¥…}ÑåÁ•ôí‰…Í”ØÐ°‘í±½¼¹Ñ½MÑÉ¥¹œ ‰…Í”ØÐœ¥õ€ì(€€€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€€€€¼¼µ¥ÍÍ¥¹œ±½¼½‰©•ÐµÕÍÐ¹½Ð‰±½¬…¸¥ÍÍÕ•‘½Õµ•¹Ð¸(€€€€€€€€€É•ÅÕ•ÍÐ¹±½œ¹Ý…É¸ (€€€€€€€€€€€ì•ÉÈè•ÉÉ½Èô°(€€€€€€€€€€€€½ÉÉ•Ñ¥½¸¹½Ñ¥”É•¹‘•Èè±½¼Õ¹…Ù…¥±…‰±”œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€ô(€€€€€½¹ÍÐ¡Ñµ°€ôÉ•¹‘•É½ÉÉ•Ñ¥½¹9½Ñ¥•!Ñµ°¡Í¹…ÁÍ¡½Ð°ì(€€€€€€€€¸¸¸¡±½½…Ñ…UÉ¤€„ôôÕ¹‘•™¥¹•€üì±½½…Ñ…UÉ¤ô€èíô¤°(€€€€€€€…‘‘É•ÍÌè‰É…¹‘¥¹œü¹…‘‘É•ÍÌ€üü¹Õ±°°(€€€€€€€ÍÑ¥¸è‰É…¹‘¥¹œü¹ÍÑ¥¸€üü¹Õ±°°(€€€€€€€½¹Ñ…ÑA¡½¹”è‰É…¹‘¥¹œü¹½¹Ñ…Ñ}Á¡½¹”€üü¹Õ±°°(€€€€€€€½¹Ñ…Ñµ…¥°è‰É…¹‘¥¹œü¹½¹Ñ…Ñ}•µ…¥°€üü¹Õ±°°(€€€€€ô¤ì(€€€€€½¹ÍÐ™½É´€ô¹•Ü½Éµ…Ñ„ ¤ì(€€€€€™½É´¹…ÁÁ•¹ ™¥±•Ìœ°¹•Ü	±½ˆ¡m¡Ñµ±t°ìÑåÁ”è€Ñ•áÐ½¡Ñµ°œô¤°€¥¹‘•à¹¡Ñµ°œ¤ì(€€€€€±•ÐÁ‘˜è	Õ™™•Èì(€€€€€ÑÉäì(€€€€€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð™•Ñ ¡€‘í½Ñ•¹‰•ÉUÉ±ô½™½ÉµÌ½¡É½µ¥Õ´½½¹Ù•ÉÐ½¡Ñµ±€°ì(€€€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€€€‰½‘äè™½É´°(€€€€€€€ô¤ì(€€€€€€€¥˜€ …É•ÍÁ½¹Í”¹½¬¤ì(€€€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È¡½Ñ•¹‰•Éœ…¹ÍÝ•É•€‘íMÑÉ¥¹œ¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÌ¥õ€¤ì(€€€€€€€ô(€€€€€€€Á‘˜€ô	Õ™™•È¹™É½´¡…Ý…¥ÐÉ•ÍÁ½¹Í”¹…ÉÉ…å	Õ™™•È ¤¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€É•ÅÕ•ÍÐ¹±½œ¹•ÉÉ½È¡ì•ÉÈè•ÉÉ½Èô°€½ÉÉ•Ñ¥½¸¹½Ñ¥”É•¹‘•È™…¥±•œ¤ì(€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€ÔÀÈ°(€€€€€€€€€€I9I}%1œ°(€€€€€€€€€€Q¡”AÍ•ÉÙ¥”¥ÌÕ¹…Ù…¥±…‰±”ìÑ¡”¥ÍÍÕ•¹½Ñ¥”¥ÌÕ¹…™™•Ñ•ƒŠPÉ•ÑÉä±…Ñ•È¸œ°(€€€€€€€€¤ì(€€€€€ô(€€€€€½¹ÍÐÍ¡„ÈÔØ€ôÉ•…Ñ•!…Í  Í¡„ÈÔØœ¤¹ÕÁ‘…Ñ”¡Á‘˜¤¹‘¥•ÍÐ ¡•àœ¤ì(€€€€€½¹ÍÐ½‰©•Ñ-•ä€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô½¸¼‘í¥‘ô¹Á‘™€ì(€€€€€…Ý…¥ÐÍÑ½É…”¹ÁÕÐ¡½‰©•Ñ-•ä°Á‘˜¤ì((€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€½¹ÍÐÕÁ‘…Ñ•€ô…Ý…¥ÐÑá€(€€€€€€€€€ÕÁ‘…Ñ”½ÉÉ•Ñ¥½¹}¹½Ñ¥•Ì(€€€€€€€€€Í•ÐÉ•¹‘•É•‘}½‰©•Ñ}­•ä€ô€‘í½‰©•Ñ-•åô°É•¹‘•É•‘}Í¡„ÈÔØ€ô€‘íÍ¡„ÈÔÙô(€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô…¹ÍÑ…ÑÕÌ€ô€¥ÍÍÕ•œ(€€€€€€€€ì(€€€€€€€¥˜€¡ÕÁ‘…Ñ•¹½Õ¹Ð€ôôô€À¤ì(€€€€€€€€€€¼¼Q¡”¹½Ñ¥”ÍÑ½ÁÁ•‰•¥¹œ¥ÍÍÕ•Ý¡¥±”½Ñ•¹‰•ÉœÉ•¹‘•É•ìÑ¡”(€€€€€€€€€€¼¼ÍÑ½É•A¥Ì…¸½ÉÁ¡…¸°¹½Ð•Ù¥‘•¹”ƒŠP¹¼…Õ‘¥Ð•¹ÑÉä¸(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€9=Q%}MQQUM}=91%Pœ°(€€€€€€€€€€€€Q¡”½ÉÉ•Ñ¥½¸¹½Ñ¥”¥Ì¹¼±½¹•È¥ÍÍÕ•ìÑ¡”É•¹‘•ÈÝ…Ì‘¥Í…É‘•¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€½ÉÉ•Ñ¥½¹}¹½Ñ¥”¹É•¹‘•É•œ°(€€€€€€€€€€½ÉÉ•Ñ¥½¹}¹½Ñ¥•Ìœ°(€€€€€€€€€¥°(€€€€€€€€€ìÍ¡„ÈÔØô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸É•…‘9½Ñ¥••Ñ…¥°¡Ñà°¥¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì((€…ÁÀ¹•Ð (€€€€œ½…Á¤½½ÉÉ•Ñ¥½¸µ¹½Ñ¥•Ì¼é¥½Á‘˜œ°(€€€ì(€€€€€Í¡•µ„èìÁ…É…µÌè%‘A…É…µÍM¡•µ„ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ°É•Á±ä¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ­•ä€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàð(€€€€€€€€€€€ìÝ½É­}¥èÍÑÉ¥¹œìÉ•¹‘•É•‘}½‰©•Ñ}­•äèÍÑÉ¥¹œð¹Õ±°õmt(€€€€€€€€€€ù€(€€€€€€€€€€€Í•±•ÐÝ½É­}¥°É•¹‘•É•‘}½‰©•Ñ}­•ä(€€€€€€€€€€€™É½´½ÉÉ•Ñ¥½¹}¹½Ñ¥•ÌÝ¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€€ì(€€€€€€€€€¥˜€ …É½Ü¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È ÐÀÐ°€9=Q%}9=Q}=U9œ°€9¼ÍÕ ½ÉÉ•Ñ¥½¸¹½Ñ¥”¸œ¤ì(€€€€€€€€€ô(€€€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°É½Ü¹Ý½É­}¥¤ì(€€€€€€€€€¥˜€¡É½Ü¹É•¹‘•É•‘}½‰©•Ñ}­•ä€ôôô¹Õ±°¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀÐ°(€€€€€€€€€€€€€€A}9=Q}Y%1	1œ°(€€€€€€€€€€€€€€Q¡¥Ì½ÉÉ•Ñ¥½¸¹½Ñ¥”¡…Ì¹½Ð‰••¸É•¹‘•É•å•Ð¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€É•ÑÕÉ¸É½Ü¹É•¹‘•É•‘}½‰©•Ñ}­•äì(€€€€€€€ô°(€€€€€€¤ì(€€€€€½¹ÍÐ‰åÑ•Ì€ô…Ý…¥ÐÍÑ½É…”¹•Ð¡­•ä¤ì(€€€€€Ù½¥É•Á±ä¹ÑåÁ” …ÁÁ±¥…Ñ¥½¸½Á‘˜œ¤ì(€€€€€Ù½¥É•Á±ä¹¡•…‘•È (€€€€€€€€½¹Ñ•¹Ðµ‘¥ÍÁ½Í¥Ñ¥½¸œ°(€€€€€€€¥¹±¥¹”ì™¥±•¹…µ”ô‰½ÉÉ•Ñ¥½¸µ¹½Ñ¥”´‘í¥‘ô¹Á‘˜‰€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹Í•¹¡‰åÑ•Ì¤ì(€€€ô°(€€¤ì((€€¼¼€´´´9½Ñ¥”…¹•°€¡Í…µ”½¹Ù•¹Ñ¥½¹Ì…Ì¥¹ÍÑÉÕµ•¹Ð½¡…±±…¸…¹•±Ì¤€´´´´´´´(€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½½ÉÉ•Ñ¥½¸µ¹½Ñ¥•Ì¼é¥½…¹•°œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äè…¹•±½ÉÉ•Ñ¥½¹9½Ñ¥•I•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀè½ÉÉ•Ñ¥½¹9½Ñ¥••Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…Ì…¹•±½ÉÉ•Ñ¥½¹9½Ñ¥•I•ÅÕ•ÍÐì(€€€€€½¹ÍÐ¹½Ñ”€ô…¹•±±…Ñ¥½¹9½Ñ”¡‰½‘ä¹¹½Ñ”¤ì(€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•ÕÑ¡½É¥Ñä¡Ñà°ÕÍ•È¹¥°€…¹•°œ¤ì(€€€€€€€½¹ÍÐ¹½Ñ¥”€ô…Ý…¥Ð±½­9½Ñ¥”¡Ñà°¥¤ì(€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°¹½Ñ¥”¹Ý½É­}¥¤ì(€€€€€€€¥˜€¡¹½Ñ¥”¹ÍÑ…ÑÕÌ€„ôô€¥ÍÍÕ•œ¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€9=Q%}MQQUM}=91%Pœ°(€€€€€€€€€€€Q¡¥Ì½Á•É…Ñ¥½¸É•ÅÕ¥É•Ì…¸¥ÍÍÕ•½ÉÉ•Ñ¥½¸¹½Ñ¥”€¡ÕÉÉ•¹ÐÍÑ…ÑÕÌè€‘í¹½Ñ¥”¹ÍÑ…ÑÕÍô¤¹€°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€…Ý…¥ÐÑá€(€€€€€€€€€ÕÁ‘…Ñ”½ÉÉ•Ñ¥½¹}¹½Ñ¥•Ì(€€€€€€€€€Í•ÐÍÑ…ÑÕÌ€ô€…¹•±±•œ°…¹•±±•‘}‰å}ÕÍ•É}¥€ô€‘íÕÍ•È¹¥‘ô°(€€€€€€€€€€€€€…¹•±±•‘}…Ð€ô¹½Ü ¤°…¹•±±…Ñ¥½¹}¹½Ñ”€ô€‘í¹½Ñ•ô(€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€ì(€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€½ÉÉ•Ñ¥½¹}¹½Ñ¥”¹…¹•±±•œ°(€€€€€€€€€€½ÉÉ•Ñ¥½¹}¹½Ñ¥•Ìœ°(€€€€€€€€€¥°(€€€€€€€€€ì¹½Ñ¥•9Õµ‰•Èè¹½Ñ¥”¹¹½Ñ¥•}¹Õµ‰•È°¹½Ñ”ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸É•…‘9½Ñ¥••Ñ…¥°¡Ñà°¥¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì)ô(