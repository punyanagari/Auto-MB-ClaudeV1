import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  CancelChallanRequestSchema,
  ChallanDetailResponseSchema,
  ChallanListResponseSchema,
  SaveChallanRequestSchema,
  WorkBalanceResponseSchema,
  type CancelChallanRequest,
  type Challan,
  type ChallanDetailResponse,
  type ChallanItem,
  type Consignee,
  type SaveChallanRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import {
  CHALLAN_TEMPLATE_VERSION,
  WARRANTY_TEMPLATE_VERSION,
  renderChallanHtml,
  type ChallanSnapshot,
} from '../challan-html.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { MalwareScanner } from '../malware-scan.js';
import { assertSourceNotBilled } from './measurement-books.js';
import { assertNotMalware } from '../upload-guards.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

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

const PdfQuerySchema = Type.Object(
  {
    kind: Type.Optional(Type.Union([Type.Literal('rendered'), Type.Literal('signed')])),
  },
  { additionalProperties: false },
);

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 25 * 1024 * 1024;

interface ChallanRow {
  id: string;
  work_id: string;
  status: Challan['status'];
  challan_date: string;
  challan_number: string | null;
  sequence_number: number | null;
  prefix: string;
  consignee_snapshot: unknown;
  template_version: string | null;
  warranty_template_version: string | null;
  warranty_text_sha256: string | null;
  rendered_object_key: string | null;
  signed_copy_object_key: string | null;
  cancellation_note: string | null;
  created_at: Date;
  issued_at: Date | null;
  cancelled_at: Date | null;
}

const CHALLAN_COLUMNS = `
  id, work_id, status, challan_date::text as challan_date, challan_number,
  sequence_number, prefix, consignee_snapshot, template_version,
  warranty_template_version, warranty_text_sha256,
  rendered_object_key, signed_copy_object_key, cancellation_note,
  created_at, issued_at, cancelled_at
`;

function toChallan(row: ChallanRow): Challan {
  return {
    id: row.id,
    workId: row.work_id,
    status: row.status,
    challanDate: row.challan_date,
    challanNumber: row.challan_number,
    sequenceNumber: row.sequence_number,
    prefix: row.prefix,
    consignee: parseJsonbColumn(row.consignee_snapshot) as Consignee,
    templateVersion: row.template_version,
    warrantyTemplateVersion: row.warranty_template_version,
    warrantyTextSha256: row.warranty_text_sha256,
    renderedAvailable: row.rendered_object_key !== null,
    signedCopyAvailable: row.signed_copy_object_key !== null,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    issuedAt: row.issued_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

interface ChallanItemRow {
  id: string;
  work_item_id: string;
  description_snapshot: string;
  unit_snapshot: string;
  quantity: string;
  rate_snapshot: string;
  line_amount: string;
  position: number;
}

function toChallanItem(row: ChallanItemRow): ChallanItem {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    description: row.description_snapshot,
    unit: row.unit_snapshot,
    quantity: row.quantity,
    rate: row.rate_snapshot,
    lineAmount: row.line_amount,
    position: row.position,
  };
}

async function readItems(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanItem[]> {
  const rows = await tx<ChallanItemRow[]>`
    select id, work_item_id, description_snapshot, unit_snapshot,
           quantity::text as quantity, rate_snapshot::text as rate_snapshot,
           line_amount::text as line_amount, position
    from delivery_challan_items
    where delivery_challan_id = ${challanId}
    order by position
  `;
  return rows.map(toChallanItem);
}

async function readDetail(
  tx: TransactionSql,
  challanId: string,
): Promise<ChallanDetailResponse> {
  const [row] = await tx<(ChallanRow & { issued_snapshot: unknown })[]>`
    select ${tx.unsafe(CHALLAN_COLUMNS)}, issued_snapshot
    from delivery_challans where id = ${challanId}
  `;
  if (!row) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
  return {
    challan: toChallan(row),
    items: await readItems(tx, challanId),
    issuedSnapshot: parseJsonbColumn(row.issued_snapshot),
  };
}

/** Product contract: a document date is never in the future and never
 * before the Work's LOA letter date. "Today" is the organisation's own
 * timezone (default Asia/Kolkata), not the server clock — an evening
 * entry in India must not be rejected as tomorrow's date. (Exported for
 * the correction flow, which validates replacement drafts.) */
export async function assertChallanDate(
  tx: TransactionSql,
  workId: string,
  challanDate: string,
): Promise<void> {
  const [bounds] = await tx<{ letter_date: string; today: string }[]>`
    select w.letter_date::text as letter_date,
           (now() at time zone o.timezone)::date::text as today
    from works w
    join organisations o on o.id = w.organisation_id
    where w.id = ${workId}
  `;
  if (!bounds) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  // ISO dates compare correctly as strings.
  if (challanDate > bounds.today) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot be in the future (today is ${bounds.today}).`,
    );
  }
  if (challanDate < bounds.letter_date) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot precede the LOA letter date (${bounds.letter_date}).`,
    );
  }
}

/** Locks the challan row for the rest of the transaction and returns it.
 * Every state transition starts here so concurrent requests serialise. */
async function lockChallan(tx: TransactionSql, challanId: string): Promise<ChallanRow> {
  const [row] = await tx<ChallanRow[]>`
    select ${tx.unsafe(CHALLAN_COLUMNS)}
    from delivery_challans where id = ${challanId}
    for update
  `;
  if (!row) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
  return row;
}

function requireStatus(row: ChallanRow, status: Challan['status']): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'CHALLAN_STATUS_CONFLICT',
      `This operation requires a ${status} challan (current status: ${row.status}).`,
    );
  }
}

/** Replaces the challan's lines from the request, snapshotting
 * description/unit/rate from the live work items and computing the line
 * amount in exact SQL numeric arithmetic. (Exported for the correction
 * flow, which writes replacement drafts through the same path.) */
export async function writeLines(
  tx: TransactionSql,
  organisationId: string,
  challanId: string,
  workId: string,
  body: SaveChallanRequest,
): Promise<void> {
  // Draft-time serials hang off the line rows being replaced (serial
  // lineage FK); they are draft-stage records — deletable by rule — and
  // cannot outlive their lines, so a line rewrite clears them and they
  // are re-recorded against the new lines before issue.
  await tx`
    delete from challan_item_serials where delivery_challan_id = ${challanId}
  `;
  await tx`
    delete from delivery_challan_items where delivery_challan_id = ${challanId}
  `;
  for (const [index, item] of body.items.entries()) {
    const [inserted] = await tx<{ id: string }[]>`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position
      )
      select ${organisationId}, ${challanId}, ${workId}, wi.id,
             coalesce(wi.effective_description, wi.description),
             coalesce(wi.effective_unit, wi.unit_code), ${item.quantity},
             coalesce(wi.effective_unit_rate, wi.effective_rate),
             (${item.quantity}::numeric(18,3)
               * coalesce(wi.effective_unit_rate, wi.effective_rate))::numeric(18,2),
             ${index + 1}
      from work_items wi
      where wi.id = ${item.workItemId} and wi.work_id = ${workId}
        and wi.deleted_at is null
      returning id
    `.catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        throw httpError(
          409,
          'DUPLICATE_ITEM',
          'The same Work item appears more than once on this challan.',
        );
      }
      throw error;
    });
    if (!inserted) {
      throw httpError(
        404,
        'WORK_ITEM_NOT_FOUND',
        'A selected item does not belong to this Work.',
      );
    }
  }
}

/** The challan's lines in request-input shape ({workItemId, quantity})
 * for audit diffing; quantity text comes normalised from the numeric
 * column so before/after compare like for like. */
async function readLineInputs(
  tx: TransactionSql,
  challanId: string,
): Promise<{ workItemId: string; quantity: string }[]> {
  const rows = await tx<{ work_item_id: string; quantity: string }[]>`
    select work_item_id, quantity::text as quantity
    from delivery_challan_items
    where delivery_challan_id = ${challanId}
    order by position
  `;
  return rows.map((row) => ({ workItemId: row.work_item_id, quantity: row.quantity }));
}

async function auditChallan(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  challanId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, 'delivery_challans',
      ${challanId}, ${jsonb(tx, details)}
    )
  `;
}

export function registerChallanRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  scanner: MalwareScanner,
): void {
  app.get(
    '/api/works/:id/balance',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkBalanceResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ allow_excess_delivery: boolean }[]>`
          select allow_excess_delivery from works
          where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // The delivery ceiling is COALESCE(effective_quantity,
        // awarded_quantity): approved amendments (Milestone 6) raise or
        // lower it, and the rate/description an amendment changed is what
        // new challan lines will snapshot.
        const rows = await tx<
          {
            work_item_id: string;
            item_number: string;
            description: string;
            unit_code: string;
            awarded: string;
            effective: string | null;
            delivered: string;
            remaining: string;
            rate: string;
          }[]
        >`
          select wi.id as work_item_id, wi.item_number,
                 coalesce(wi.effective_description, wi.description) as description,
                 coalesce(wi.effective_unit, wi.unit_code) as unit_code,
                 wi.awarded_quantity::text as awarded,
                 wi.effective_quantity::text as effective,
                 coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0)::text as delivered,
                 (coalesce(wi.effective_quantity, wi.awarded_quantity)
                   - coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0))::text as remaining,
                 coalesce(wi.effective_unit_rate, wi.effective_rate)::text as rate
          from work_items wi
          left join delivery_challan_items dci on dci.work_item_id = wi.id
          left join delivery_challans dc on dc.id = dci.delivery_challan_id
          where wi.work_id = ${workId} and wi.deleted_at is null
          group by wi.id
          order by wi.item_number
        `;
        return {
          allowExcessDelivery: work.allow_excess_delivery,
          items: rows.map((row) => ({
            workItemId: row.work_item_id,
            itemNumber: row.item_number,
            description: row.description,
            unitCode: row.unit_code,
            awardedQuantity: row.awarded,
            effectiveQuantity: row.effective,
            deliveredQuantity: row.delivered,
            remainingQuantity: row.remaining,
            effectiveRate: row.rate,
          })),
        };
      });
    },
  );

  app.get(
    '/api/works/:id/challans',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanListResponseSchema, ...errorResponses },
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
          return tx<ChallanRow[]>`
            select ${tx.unsafe(CHALLAN_COLUMNS)}
            from delivery_challans
            where work_id = ${workId}
            order by created_at desc, id
          `;
        },
      );
      return { challans: rows.map(toChallan) };
    },
  );

  app.post(
    '/api/works/:id/challans',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveChallanRequestSchema,
        response: { 201: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as SaveChallanRequest;

      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          await assertWorkAccess(tx, user.id, workId);
          const [work] = await tx<{ status: string }[]>`
            select status from works where id = ${workId} and deleted_at is null
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
          if (work.status !== 'active') {
            throw httpError(
              409,
              'WORK_NOT_ACTIVE',
              'Delivery Challans can only be drafted for active Works.',
            );
          }
          await assertChallanDate(tx, workId, body.challanDate);

          // One open draft per Work (the partial unique index is the
          // arbiter): the 409 names the existing draft so the client can
          // open it instead of parsing the message.
          const [existingDraft] = await tx<{ id: string }[]>`
            select id from delivery_challans
            where work_id = ${workId} and status = 'draft'
          `;
          if (existingDraft) {
            throw draftConflictError(
              'DRAFT_EXISTS',
              'This Work already has a draft challan; issue or delete it first.',
              existingDraft.id,
            );
          }

          const [created] = await tx<{ id: string }[]>`
            insert into delivery_challans (
              organisation_id, work_id, challan_date, prefix,
              consignee_snapshot, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.challanDate}, ${body.prefix},
              ${jsonb(tx, body.consignee)}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              // A concurrent create won between the pre-check and this
              // insert; the transaction is aborted, so the route-level
              // catch names the winner from a fresh read.
              throw httpError(
                409,
                'DRAFT_EXISTS',
                'This Work already has a draft challan; issue or delete it first.',
              );
            }
            throw error;
          });
          if (!created) throw new Error('challan insert returned no row');

          await writeLines(tx, organisationId, created.id, workId, body);
          await auditChallan(
            tx,
            organisationId,
            user.id,
            'challan.created',
            created.id,
            {
              workId,
              itemCount: body.items.length,
            },
          );
          return readDetail(tx, created.id);
        },
      ).catch(async (error: unknown) => {
        // The unique-index race path could not name the winning draft
        // inside its aborted transaction; do it from a fresh read.
        throw await nameDraftConflict(error, 'DRAFT_EXISTS', () =>
          withBoundTenant(database, organisationId, user.id, async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from delivery_challans
              where work_id = ${workId} and status = 'draft'
            `;
            return row?.id ?? null;
          }),
        );
      });
      return reply.status(201).send(detail);
    },
  );

  app.get(
    '/api/challans/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
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
          select work_id from delivery_challans where id = ${id}
        `;
        if (!ref) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
    },
  );

  app.put(
    '/api/challans/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveChallanRequestSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as SaveChallanRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'draft');
        await assertChallanDate(tx, challan.work_id, body.challanDate);
        const linesBefore = await readLineInputs(tx, id);
        await tx`
          update delivery_challans
          set challan_date = ${body.challanDate}, prefix = ${body.prefix},
              consignee_snapshot = ${jsonb(tx, body.consignee)}
          where id = ${id}
        `;
        await writeLines(tx, organisationId, id, challan.work_id, body);
        // Milestone 6: the trail records what each changed field was and
        // became. Lines round-trip through the database on both sides so
        // quantities compare in the same normalised numeric text.
        const changes = auditDiff(
          {
            challanDate: challan.challan_date,
            prefix: challan.prefix,
            consignee: parseJsonbColumn(challan.consignee_snapshot),
            items: linesBefore,
          },
          {
            challanDate: body.challanDate,
            prefix: body.prefix,
            consignee: body.consignee,
            items: await readLineInputs(tx, id),
          },
        );
        await auditChallan(tx, organisationId, user.id, 'challan.updated', id, {
          before: changes.before,
          after: changes.after,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.delete(
    '/api/challans/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'draft');
        // A deleted draft takes its draft-stage serials with it (they
        // reference the lines and would otherwise orphan the delete).
        await tx`delete from challan_item_serials where delivery_challan_id = ${id}`;
        await tx`delete from delivery_challan_items where delivery_challan_id = ${id}`;
        await tx`delete from delivery_challans where id = ${id}`;
        await auditChallan(tx, organisationId, user.id, 'challan.deleted', id, {
          workId: challan.work_id,
        });
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/challans/:id/issue',
    {
      schema: {
        params: IdParamsSchema,
        response: { 201: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireAuthority(tx, user.id, 'issue');
          const challan = await lockChallan(tx, id);
          await assertWorkAccess(tx, user.id, challan.work_id);
          requireStatus(challan, 'draft');

          const [work] = await tx<
            {
              allow_excess_delivery: boolean;
              work_code: string;
              title: string;
              letter_number: string;
              letter_date: string;
            }[]
          >`
            select allow_excess_delivery, work_code, title, letter_number,
                   letter_date::text as letter_date
            from works where id = ${challan.work_id}
          `;
          if (!work) throw new Error('challan without a Work');

          // Concurrency-safe quantity validation: this challan's lines plus
          // everything already ISSUED must stay within the delivery ceiling
          // COALESCE(effective_quantity, awarded_quantity) — exact numeric
          // arithmetic in SQL. The challan row lock above serialises
          // competing issues of this work's single draft, and the item row
          // locks below serialise against amendment apply (Milestone 6),
          // which takes the same locks before lowering a ceiling.
          await tx`
            select wi.id from work_items wi
            where wi.id in (
              select dci.work_item_id from delivery_challan_items dci
              where dci.delivery_challan_id = ${id}
            )
            for update
          `;
          if (!work.allow_excess_delivery) {
            const exceeded = await tx<{ item_number: string }[]>`
              select wi.item_number
              from delivery_challan_items dci
              join work_items wi on wi.id = dci.work_item_id
              where dci.delivery_challan_id = ${id}
                and dci.quantity + coalesce((
                  select sum(q.quantity)
                  from delivery_challan_items q
                  join delivery_challans dc on dc.id = q.delivery_challan_id
                  where q.work_item_id = dci.work_item_id
                    and dc.status = 'issued'
                ), 0) > coalesce(wi.effective_quantity, wi.awarded_quantity)
              order by wi.item_number
            `;
            if (exceeded.length > 0) {
              throw httpError(
                409,
                'QUANTITY_EXCEEDED',
                `Issuing would exceed the permitted quantity for: ${exceeded
                  .map((row) => row.item_number)
                  .join(', ')}.`,
              );
            }
          }

          // requires_serials enforcement. The challan's work_items rows
          // are locked FOR UPDATE (no flag predicate) so a concurrent
          // flag toggle serialises with this check in both orders: a
          // toggle that committed first is visible in the locked read;
          // a toggle waiting on these locks re-validates against the
          // now-issued lines after we commit. Serial recording/deletion
          // already serialises against issue through the challan row
          // lock taken above.
          const challanWorkItems = await tx<
            { id: string; item_number: string; requires_serials: boolean }[]
          >`
            select wi.id, wi.item_number, wi.requires_serials
            from work_items wi
            where wi.id in (
              select work_item_id from delivery_challan_items
              where delivery_challan_id = ${id}
            )
            order by wi.id
            for update of wi
          `;
          const flaggedItemIds = challanWorkItems
            .filter((item) => item.requires_serials)
            .map((item) => item.id);
          if (flaggedItemIds.length > 0) {
            // Exact count check in SQL: recorded serials must equal the
            // line quantity (numeric comparison, no floats).
            const incomplete = await tx<
              { item_number: string; quantity: string; recorded: string }[]
            >`
              select wi.item_number, dci.quantity::text as quantity,
                     (
                       select count(*) from challan_item_serials s
                       where s.delivery_challan_item_id = dci.id
                     )::text as recorded
              from delivery_challan_items dci
              join work_items wi on wi.id = dci.work_item_id
              where dci.delivery_challan_id = ${id}
                and dci.work_item_id = any(${flaggedItemIds}::uuid[])
                and (
                  select count(*) from challan_item_serials s
                  where s.delivery_challan_item_id = dci.id
                ) <> dci.quantity
              order by wi.item_number
            `;
            if (incomplete.length > 0) {
              const detail = incomplete
                .map(
                  (line) =>
                    `${line.item_number} (${line.recorded} of ${line.quantity} serials recorded)`,
                )
                .join('; ');
              throw httpError(
                409,
                'SERIALS_INCOMPLETE',
                `These items require one serial per unit before issue: ${detail}.`,
              );
            }
          }

          // Serialised per-Work numbering: the counter row lock orders
          // concurrent issues; a rolled-back transaction rolls the counter
          // back with it, so numbers are gapless per Work.
          const [counter] = await tx<{ next_value: number }[]>`
            insert into delivery_challan_counters (organisation_id, work_id)
            values (${organisationId}, ${challan.work_id})
            on conflict (organisation_id, work_id)
            do update set next_value = delivery_challan_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
          if (!counter) throw new Error('counter upsert returned no row');
          const sequence = counter.next_value;
          const challanNumber = `${challan.prefix}/${String(sequence)}`;

          const [organisation] = await tx<
            { name: string; warranty_template_text: string | null }[]
          >`
            select name, warranty_template_text from organisations
          `;
          const lines = await tx<(ChallanItemRow & { item_number: string })[]>`
            select dci.id, dci.work_item_id, dci.description_snapshot,
                   dci.unit_snapshot, dci.quantity::text as quantity,
                   dci.rate_snapshot::text as rate_snapshot,
                   dci.line_amount::text as line_amount, dci.position,
                   wi.item_number
            from delivery_challan_items dci
            join work_items wi on wi.id = dci.work_item_id
            where dci.delivery_challan_id = ${id}
            order by dci.position
          `;
          const [total] = await tx<{ amount: string }[]>`
            select coalesce(sum(line_amount), 0)::numeric(18,2)::text as amount
            from delivery_challan_items where delivery_challan_id = ${id}
          `;

          // Legacy §11: the warranty/guarantee certificate page is
          // optional — it exists exactly when the organisation has
          // template text at issue time. The FULL text is frozen into
          // the immutable snapshot (with the certificate template
          // version and the SHA-256 of the exact text), so later
          // profile edits never change an issued certificate.
          const warrantyText = organisation?.warranty_template_text ?? null;
          const warranty =
            warrantyText !== null
              ? {
                  templateVersion: WARRANTY_TEMPLATE_VERSION,
                  textSha256: createHash('sha256')
                    .update(warrantyText, 'utf8')
                    .digest('hex'),
                  text: warrantyText,
                }
              : undefined;

          const issuedAt = new Date().toISOString();
          const snapshot: ChallanSnapshot = {
            templateVersion: CHALLAN_TEMPLATE_VERSION,
            organisationName: organisation?.name ?? '',
            challanNumber,
            challanDate: challan.challan_date,
            issuedAt,
            work: {
              workCode: work.work_code,
              title: work.title,
              letterNumber: work.letter_number,
              letterDate: work.letter_date,
            },
            consignee: parseJsonbColumn(challan.consignee_snapshot) as Consignee,
            items: lines.map((line) => ({
              position: line.position,
              itemNumber: line.item_number,
              description: line.description_snapshot,
              unit: line.unit_snapshot,
              quantity: line.quantity,
              rate: line.rate_snapshot,
              lineAmount: line.line_amount,
            })),
            totalAmount: total?.amount ?? '0.00',
            ...(warranty !== undefined ? { warranty } : {}),
          };

          await tx`
            update delivery_challans
            set status = 'issued', challan_number = ${challanNumber},
                sequence_number = ${sequence},
                issued_snapshot = ${jsonb(tx, snapshot)},
                issued_by_user_id = ${user.id}, issued_at = ${issuedAt},
                template_version = ${CHALLAN_TEMPLATE_VERSION},
                warranty_template_version = ${warranty?.templateVersion ?? null},
                warranty_text_sha256 = ${warranty?.textSha256 ?? null}
            where id = ${id}
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'NUMBER_CONFLICT',
                `Challan number ${challanNumber} already exists in this organisation; use a distinct prefix for this Work.`,
              );
            }
            throw error;
          });

          await auditChallan(tx, organisationId, user.id, 'challan.issued', id, {
            challanNumber,
            sequence,
            totalAmount: snapshot.totalAmount,
          });
          return readDetail(tx, id);
        },
      );
      return reply.status(201).send(detail);
    },
  );

  app.post(
    '/api/challans/:id/cancel',
    {
      schema: {
        params: IdParamsSchema,
        body: CancelChallanRequestSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as CancelChallanRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireAuthority(tx, user.id, 'cancel');
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'issued');
        // Received goods cannot be un-delivered: once a receipt, serial,
        // or Measurement Book entry references this challan, cancellation
        // is forbidden (policy 2026-08-08; the DB trigger backs this up).
        const [evidence] = await tx<
          { receipts: string; serials: string; measurements: string }[]
        >`
          select
            (select count(*) from challan_receipts
              where delivery_challan_id = ${id})::text as receipts,
            (select count(*) from challan_item_serials
              where delivery_challan_id = ${id})::text as serials,
            (select count(*) from mb_entries
              where delivery_challan_id = ${id})::text as measurements
        `;
        if (
          evidence &&
          (evidence.receipts !== '0' ||
            evidence.serials !== '0' ||
            evidence.measurements !== '0')
        ) {
          throw httpError(
            409,
            'CHALLAN_HAS_EVIDENCE',
            'This challan has a recorded receipt, serials, or measurements and can no longer be cancelled.',
          );
        }
        // R19: a challan billed in a live Measurement Book cannot be
        // cancelled — the MB must be cancelled first (the 0024 database
        // guard backstops this against every writer).
        await assertSourceNotBilled(tx, 'delivery_challan', id);
        await tx`
          update delivery_challans
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${body.note}
          where id = ${id}
        `;
        await auditChallan(tx, organisationId, user.id, 'challan.cancelled', id, {
          challanNumber: challan.challan_number,
          note: body.note,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.post(
    '/api/challans/:id/render',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
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
      // the immutable issued snapshot, so re-rendering reproduces the
      // record. Branding (logo, company details) is presentation and
      // comes from the organisation's current profile.
      const { snapshot, branding } = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          const challan = await lockChallan(tx, id);
          await assertWorkAccess(tx, user.id, challan.work_id);
          requireStatus(challan, 'issued');
          const [row] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from delivery_challans where id = ${id}
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
            snapshot: parseJsonbColumn(row?.issued_snapshot) as ChallanSnapshot,
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
          request.log.warn({ err: error }, 'challan render: logo unavailable');
        }
      }
      const html = renderChallanHtml(snapshot, {
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
        request.log.error({ err: error }, 'challan render failed');
        throw httpError(
          502,
          'RENDER_FAILED',
          'The PDF service is unavailable; the issued challan is unaffected — retry later.',
        );
      }
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/dc/${id}.pdf`;
      await storage.put(objectKey, pdf);

      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const updated = await tx`
          update delivery_challans
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id} and status = 'issued'
        `;
        if (updated.count === 0) {
          // The challan stopped being issued while Gotenberg rendered; the
          // stored PDF is an orphan, not evidence — no audit entry.
          throw httpError(
            409,
            'CHALLAN_STATUS_CONFLICT',
            'The challan is no longer issued; the render was discarded.',
          );
        }
        await auditChallan(tx, organisationId, user.id, 'challan.rendered', id, {
          sha256,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.post(
    '/api/challans/:id/signed-copy',
    {
      bodyLimit: MAX_PDF_BYTES,
      schema: {
        params: IdParamsSchema,
        response: { 200: ChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw httpError(
          400,
          'PDF_REQUIRED',
          'Send the signed copy as an application/pdf request body.',
        );
      }
      if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        throw httpError(400, 'NOT_A_PDF', 'The uploaded file is not a PDF.');
      }
      // Authorisation before the expensive scan (ops batch): an
      // unauthorised caller must not spend scanner capacity.
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
      });
      await assertNotMalware(scanner, body);
      // Content-addressed key: a replacement upload gets a new object and
      // never overwrites earlier evidence; the hash is recorded like the
      // rendered PDF's.
      const signedSha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/signed/${id}-${signedSha256.slice(0, 16)}.pdf`;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'issued');
        await storage.put(objectKey, body);
        await tx`
          update delivery_challans
          set signed_copy_object_key = ${objectKey},
              signed_copy_sha256 = ${signedSha256}
          where id = ${id}
        `;
        await auditChallan(
          tx,
          organisationId,
          user.id,
          'challan.signed_copy_uploaded',
          id,
          { sizeBytes: body.length, sha256: signedSha256 },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.get(
    '/api/challans/:id/pdf',
    {
      schema: { params: IdParamsSchema, querystring: PdfQuerySchema },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const { kind = 'rendered' } = request.query as { kind?: 'rendered' | 'signed' };
      const key = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [row] = await tx<
            {
              work_id: string;
              rendered_object_key: string | null;
              signed_copy_object_key: string | null;
            }[]
          >`
            select work_id, rendered_object_key, signed_copy_object_key
            from delivery_challans where id = ${id}
          `;
          if (!row) {
            throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
          }
          await assertWorkAccess(tx, user.id, row.work_id);
          const found =
            kind === 'rendered' ? row.rendered_object_key : row.signed_copy_object_key;
          if (found === null) {
            throw httpError(
              404,
              'PDF_NOT_AVAILABLE',
              kind === 'rendered'
                ? 'This challan has not been rendered yet.'
                : 'No signed copy has been uploaded for this challan.',
            );
          }
          return found;
        },
      );
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="challan-${id}-${kind}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
