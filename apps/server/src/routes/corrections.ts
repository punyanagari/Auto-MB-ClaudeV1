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
import { assertChallanDate, cancellationNote, normaliseConsignee } from './challans.js';
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
  return items.map((item) => `${item.label} ×${item.quantity}`).join('; ');
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
          const replacementItems: { workItemId: string; quantity: string }[] = [];
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

          const diff: AmendmentDiffEntry[] = [];
          if (challan.challan_date !== body.replacement.challanDate) {
            diff.push({
              field: 'challanDate',
              before: challan.challan_date,
              after: body.replacement.challanDate,
            });
          }
          if (challan.prefix !== body.replacement.prefix) {
            diff.push({
              field: 'prefix',
              before: challan.prefix,
              after: body.replacement.prefix,
            });
          }
          const consigneeBefore = summariseConsignee(currentConsignee);
          const consigneeAfter = summariseConsignee(replacementConsignee);
          if (consigneeBefore !== consigneeAfter) {
            diff.push({
              field: 'consignee',
              before: consigneeBefore,
              after: consigneeAfter,
            });
          }
          const itemsBefore = summariseItems(
            currentItems.map((row) => ({
              label: row.item_number,
              quantity: row.quantity,
            })),
          );
          const itemsAfter = summariseItems(replacementLabels);
          if (itemsBefore !== itemsAfter) {
            diff.push({ field: 'items', before: itemsBefore, after: itemsAfter });
          }
          if (diff.length === 0) {
            throw httpError(
              400,
              'CORRECTION_EMPTY',
              'The replacement is identical to the issued challan.',
            );
          }

          const proposed: ChallanCancelReplaceProposal = {
            kind: 'cancel_replace_challan',
            challanId: id,
            challanNumber: challan.challan_number ?? '',
            replacement: {
              challanDate: body.replacement.challanDate,
              prefix: body.replacement.prefix,
              consignee: replacementConsignee,
              items: replacementItems,
            },
          };
          const created = await insertCorrectionRequest(
            tx,
            organisationId,
            'challan_cancel_replace',
            id,
            challan.work_id,
            proposed,
            diff,
            body.reason,
            user.id,
          );
          await audit(
            tx,
            organisationId,
            user.id,
            'correction.proposed',
            'approval_requests',
            created.id,
            {
              type: 'challan_cancel_replace',
              workId: challan.work_id,
              challanId: id,
              challanNumber: challan.challan_number,
              diff,
              reason: body.reason,
            },
          );
          if (await isApprover(tx, user.id)) {
            await applyApproval(
              tx,
              organisationId,
              user.id,
              { ...created, proposed, diff },
              null,
            );
          }
          return readApproval(tx, created.id);
        },
      );
      return reply.status(201).send(approval);
    },
  );

  // --- Path A: propose cancel-and-replace for an Issue Challan --------------
  app.post(
    '/api/issue-challans/:id/corrections/cancel-replace',
    {
      schema: {
        params: IdParamsSchema,
        body: ProposeIssueChallanCancelReplaceRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as ProposeIssueChallanCancelReplaceRequest;
      const header = normaliseHeader(body.replacement);

      const approval = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          const [challan] = await tx<
            {
              id: string;
              work_id: string;
              status: string;
              challan_number: string | null;
              challan_date: string;
              movement_type: string;
              issued_to_name: string;
              issued_to_role: string | null;
              location: string | null;
              remarks: string | null;
            }[]
          >`
            select id, work_id, status, challan_number,
                   challan_date::text as challan_date, movement_type,
                   issued_to_name, issued_to_role, location, remarks
            from issue_challans where id = ${id}
            for update
          `;
          if (!challan) {
            throw httpError(404, 'ISSUE_CHALLAN_NOT_FOUND', 'No such Issue Challan.');
          }
          await assertWorkAccess(tx, user.id, challan.work_id);
          await requireActiveWork(tx, challan.work_id);
          if (challan.status !== 'issued') {
            throw httpError(
              409,
              'ISSUE_CHALLAN_STATUS_CONFLICT',
              'Corrections target ISSUED Issue Challans; edit or delete drafts directly.',
            );
          }
          await assertChallanDate(tx, challan.work_id, body.replacement.challanDate);

          // Validate lines: work-item lines must belong to this Work;
          // quantities must be positive (looser IC content rules keep
          // manual lines and un-ceilinged quantities by design). EVERY
          // quantity — manual lines included — normalises through the
          // same numeric(18,3) cast, so the diff below compares
          // like-for-like against the stored numeric columns and the
          // stored proposal carries exactly what apply will write.
          const labels: { label: string; quantity: string }[] = [];
          const normalisedLines: typeof body.replacement.lines = [];
          for (const line of body.replacement.lines) {
            if (line.quantity.startsWith('-') || Number(line.quantity) === 0) {
              throw httpError(
                400,
                'QUANTITY_INVALID',
                'Every replacement quantity must be greater than zero.',
              );
            }
            if ('workItemId' in line) {
              const [row] = await tx<{ item_number: string; quantity: string }[]>`
                select wi.item_number, ${line.quantity}::numeric(18,3)::text as quantity
                from work_items wi
                where wi.id = ${line.workItemId} and wi.work_id = ${challan.work_id}
                  and wi.deleted_at is null
              `;
              if (!row) {
                throw httpError(
                  404,
                  'WORK_ITEM_NOT_FOUND',
                  'A replacement line does not belong to this Work.',
                );
              }
              labels.push({ label: row.item_number, quantity: row.quantity });
              normalisedLines.push({ ...line, quantity: row.quantity });
            } else {
              const [normalised] = await tx<{ quantity: string }[]>`
                select ${line.quantity}::numeric(18,3)::text as quantity
              `;
              if (!normalised) throw new Error('normalisation returned no row');
              labels.push({
                label: line.description.trim(),
                quantity: normalised.quantity,
              });
              normalisedLines.push({ ...line, quantity: normalised.quantity });
            }
          }

          const currentLines = await tx<
            {
              description_snapshot: string;
              item_number: string | null;
              quantity: string;
            }[]
          >`
            select icl.description_snapshot, wi.item_number,
                   icl.quantity::text as quantity
            from issue_challan_lines icl
            left join work_items wi on wi.id = icl.work_item_id
            where icl.issue_challan_id = ${id}
            order by icl.position
          `;

          const diff: AmendmentDiffEntry[] = [];
          const push = (field: string, before: string | null, after: string | null) => {
            if (before !== after) diff.push({ field, before, after });
          };
          push('challanDate', challan.challan_date, body.replacement.challanDate);
          push('movementType', challan.movement_type, body.replacement.movementType);
          push('issuedToName', challan.issued_to_name, header.issuedToName);
          push('issuedToRole', challan.issued_to_role, header.issuedToRole);
          push('location', challan.location, header.location);
          push('remarks', challan.remarks, header.remarks);
          push(
            'lines',
            summariseItems(
              currentLines.map((row) => ({
                label: row.item_number ?? row.description_snapshot,
                quantity: row.quantity,
              })),
            ),
            summariseItems(labels),
          );
          if (diff.length === 0) {
            throw httpError(
              400,
              'CORRECTION_EMPTY',
              'The replacement is identical to the issued Issue Challan.',
            );
          }

          const proposed: IssueChallanCancelReplaceProposal = {
            kind: 'cancel_replace_issue_challan',
            issueChallanId: id,
            challanNumber: challan.challan_number ?? '',
            replacement: {
              ...body.replacement,
              lines: normalisedLines,
              issuedToName: header.issuedToName,
              ...(header.issuedToRole !== null
                ? { issuedToRole: header.issuedToRole }
                : {}),
              ...(header.location !== null ? { location: header.location } : {}),
              ...(header.remarks !== null ? { remarks: header.remarks } : {}),
            },
          };
          const created = await insertCorrectionRequest(
            tx,
            organisationId,
            'issue_challan_cancel_replace',
            id,
            challan.work_id,
            proposed,
            diff,
            body.reason,
            user.id,
          );
          await audit(
            tx,
            organisationId,
            user.id,
            'correction.proposed',
            'approval_requests',
            created.id,
            {
              type: 'issue_challan_cancel_replace',
              workId: challan.work_id,
              issueChallanId: id,
              challanNumber: challan.challan_number,
              diff,
              reason: body.reason,
            },
          );
          if (await isApprover(tx, user.id)) {
            await applyApproval(
              tx,
              organisationId,
              user.id,
              { ...created, proposed, diff },
              null,
            );
          }
          return readApproval(tx, created.id);
        },
      );
      return reply.status(201).send(approval);
    },
  );

  // --- Path B: propose a numbered correction notice -------------------------
  app.post(
    '/api/challans/:id/corrections/notice',
    {
      schema: {
        params: IdParamsSchema,
        body: ProposeCorrectionNoticeRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as ProposeCorrectionNoticeRequest;
      const corrections: CorrectionNoticeEntry[] = (body.corrections ?? []).map(
        (entry) => ({ field: entry.field.trim(), corrected: entry.corrected.trim() }),
      );
      const statement = body.statement?.trim() ?? '';
      if (
        corrections.some(
          (entry) => entry.field.length === 0 || entry.corrected.length === 0,
        )
      ) {
        throw httpError(
          400,
          'CORRECTION_INVALID',
          'Every field correction needs both a field and a corrected reading.',
        );
      }
      if (corrections.length === 0 && statement.length === 0) {
        throw httpError(
          400,
          'CORRECTION_EMPTY',
          'A correction notice needs at least one field correction or a correction statement.',
        );
      }

      const approval = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          const challan = await lockDeliveryChallan(tx, id);
          await assertWorkAccess(tx, user.id, challan.work_id);
          await requireActiveWork(tx, challan.work_id);
          if (challan.status !== 'issued') {
            throw httpError(
              409,
              'CHALLAN_STATUS_CONFLICT',
              'Correction notices target ISSUED challans.',
            );
          }
          // Path B exists for challans whose cancellation the evidence
          // lawfully blocks; an evidence-free challan takes Path A so the
          // wrong document does not stay in force.
          const evidence = await challanEvidenceCounts(tx, id);
          if (
            evidence.receipts === 0 &&
            evidence.serials === 0 &&
            evidence.measurements === 0
          ) {
            throw httpError(
              409,
              'CORRECTION_USE_CANCEL_REPLACE',
              'This challan has no downstream evidence; correct it by cancel-and-replace instead.',
            );
          }

          const diff: AmendmentDiffEntry[] = corrections.map((entry) => ({
            field: entry.field,
            before: null,
            after: entry.corrected,
          }));
          if (statement.length > 0) {
            diff.push({ field: 'statement', before: null, after: statement });
          }

          const proposed: CorrectionNoticeProposal = {
            kind: 'correction_notice',
            challanId: id,
            challanNumber: challan.challan_number ?? '',
            corrections,
            statement: statement.length > 0 ? statement : null,
            reason: body.reason,
          };
          const created = await insertCorrectionRequest(
            tx,
            organisationId,
            'challan_correction_notice',
            id,
            challan.work_id,
            proposed,
            diff,
            body.reason,
            user.id,
          );
          await audit(
            tx,
            organisationId,
            user.id,
            'correction.proposed',
            'approval_requests',
            created.id,
            {
              type: 'challan_correction_notice',
              workId: challan.work_id,
              challanId: id,
              challanNumber: challan.challan_number,
              diff,
              reason: body.reason,
            },
          );
          if (await isApprover(tx, user.id)) {
            await applyApproval(
              tx,
              organisationId,
              user.id,
              { ...created, proposed, diff },
              null,
            );
          }
          return readApproval(tx, created.id);
        },
      );
      return reply.status(201).send(approval);
    },
  );

  // --- Correction notice reads ----------------------------------------------
  app.get(
    '/api/works/:id/correction-notices',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: CorrectionNoticeListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await assertWorkAccess(tx, user.id, workId);
          const [work] = await tx<{ id: string }[]>`
            select id from works where id = ${workId} and deleted_at is null
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
          return tx<NoticeRow[]>`
            select ${tx.unsafe(NOTICE_COLUMNS)}
            from correction_notices
            where work_id = ${workId}
            order by created_at desc, id
          `;
        },
      );
      return { notices: rows.map(toNotice) };
    },
  );

  app.get(
    '/api/challans/:id/correction-notices',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: CorrectionNoticeListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [challan] = await tx<{ work_id: string }[]>`
            select work_id from delivery_challans where id = ${id}
          `;
          if (!challan) {
            throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
          }
          await assertWorkAccess(tx, user.id, challan.work_id);
          return tx<NoticeRow[]>`
            select ${tx.unsafe(NOTICE_COLUMNS)}
            from correction_notices
            where delivery_challan_id = ${id}
            order by created_at desc, id
          `;
        },
      );
      return { notices: rows.map(toNotice) };
    },
  );

  app.get(
    '/api/correction-notices/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: CorrectionNoticeDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const [ref] = await tx<{ work_id: string }[]>`
          select work_id from correction_notices where id = ${id}
        `;
        if (!ref)
          throw httpError(404, 'NOTICE_NOT_FOUND', 'No such correction notice.');
        await assertWorkAccess(tx, user.id, ref.work_id);
        return readNoticeDetail(tx, id);
      });
    },
  );

  // --- The notice PDF (existing Gotenberg pipeline) -------------------------
  app.post(
    '/api/correction-notices/:id/render',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: CorrectionNoticeDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };

      // Snapshot read and PDF write live in separate transactions so the
      // slow external call holds no database locks; the legal content is
      // the immutable snapshot, so re-rendering reproduces the notice.
      const { snapshot, branding } = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          const notice = await lockNotice(tx, id);
          await assertWorkAccess(tx, user.id, notice.work_id);
          if (notice.status !== 'issued') {
            throw httpError(
              409,
              'NOTICE_STATUS_CONFLICT',
              `This operation requires an issued correction notice (current status: ${notice.status}).`,
            );
          }
          const [row] = await tx<{ snapshot: unknown }[]>`
            select snapshot from correction_notices where id = ${id}
          `;
          const [organisation] = await tx<
            {
              address: string | null;
              gstin: string | null;
              contact_phone: string | null;
              contact_email: string | null;
              logo_object_key: string | null;
              logo_media_type: string | null;
            }[]
          >`
            select address, gstin, contact_phone, contact_email,
                   logo_object_key, logo_media_type
            from organisations
          `;
          return {
            snapshot: parseJsonbColumn(row?.snapshot) as CorrectionNoticeSnapshot,
            branding: organisation ?? null,
          };
        },
      );

      let logoDataUri: string | undefined;
      if (branding?.logo_object_key && branding.logo_media_type) {
        try {
          const logo = await storage.get(branding.logo_object_key);
          logoDataUri = `data:${branding.logo_media_type};base64,${logo.toString('base64')}`;
        } catch (error) {
          // A missing logo object must not block an issued document.
          request.log.warn(
            { err: error },
            'correction notice render: logo unavailable',
          );
        }
      }
      const html = renderCorrectionNoticeHtml(snapshot, {
        ...(logoDataUri !== undefined ? { logoDataUri } : {}),
        address: branding?.address ?? null,
        gstin: branding?.gstin ?? null,
        contactPhone: branding?.contact_phone ?? null,
        contactEmail: branding?.contact_email ?? null,
      });
      const form = new FormData();
      form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
      let pdf: Buffer;
      try {
        const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, {
          method: 'POST',
          body: form,
        });
        if (!response.ok) {
          throw new Error(`Gotenberg answered ${String(response.status)}`);
        }
        pdf = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        request.log.error({ err: error }, 'correction notice render failed');
        throw httpError(
          502,
          'RENDER_FAILED',
          'The PDF service is unavailable; the issued notice is unaffected — retry later.',
        );
      }
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/cn/${id}.pdf`;
      await storage.put(objectKey, pdf);

      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const updated = await tx`
          update correction_notices
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id} and status = 'issued'
        `;
        if (updated.count === 0) {
          // The notice stopped being issued while Gotenberg rendered; the
          // stored PDF is an orphan, not evidence — no audit entry.
          throw httpError(
            409,
            'NOTICE_STATUS_CONFLICT',
            'The correction notice is no longer issued; the render was discarded.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'correction_notice.rendered',
          'correction_notices',
          id,
          { sha256 },
        );
        return readNoticeDetail(tx, id);
      });
    },
  );

  app.get(
    '/api/correction-notices/:id/pdf',
    {
      schema: { params: IdParamsSchema },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const key = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [row] = await tx<
            { work_id: string; rendered_object_key: string | null }[]
          >`
            select work_id, rendered_object_key
            from correction_notices where id = ${id}
          `;
          if (!row) {
            throw httpError(404, 'NOTICE_NOT_FOUND', 'No such correction notice.');
          }
          await assertWorkAccess(tx, user.id, row.work_id);
          if (row.rendered_object_key === null) {
            throw httpError(
              404,
              'PDF_NOT_AVAILABLE',
              'This correction notice has not been rendered yet.',
            );
          }
          return row.rendered_object_key;
        },
      );
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="correction-notice-${id}.pdf"`,
      );
      return reply.send(bytes);
    },
  );

  // --- Notice cancel (same conventions as instrument/challan cancels) -------
  app.post(
    '/api/correction-notices/:id/cancel',
    {
      schema: {
        params: IdParamsSchema,
        body: CancelCorrectionNoticeRequestSchema,
        response: { 200: CorrectionNoticeDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as CancelCorrectionNoticeRequest;
      const note = cancellationNote(body.note);
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireAuthority(tx, user.id, 'cancel');
        const notice = await lockNotice(tx, id);
        await assertWorkAccess(tx, user.id, notice.work_id);
        if (notice.status !== 'issued') {
          throw httpError(
            409,
            'NOTICE_STATUS_CONFLICT',
            `This operation requires an issued correction notice (current status: ${notice.status}).`,
          );
        }
        await tx`
          update correction_notices
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${note}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'correction_notice.cancelled',
          'correction_notices',
          id,
          { noticeNumber: notice.notice_number, note },
        );
        return readNoticeDetail(tx, id);
      });
    },
  );
}
