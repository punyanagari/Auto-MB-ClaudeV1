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
import type { Auth } from '../auth.js';
import { requireAuthority, requireWriterRole } from '../authz.js';
import {
  CHALLAN_TEMPLATE_VERSION,
  renderChallanHtml,
  type ChallanSnapshot,
} from '../challan-html.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { MalwareScanner } from '../malware-scan.js';
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
 * amount in exact SQL numeric arithmetic. */
async function writeLines(
  tx: TransactionSql,
  organisationId: string,
  challanId: string,
  workId: string,
  body: SaveChallanRequest,
): Promise<void> {
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
             wi.description, wi.unit_code, ${item.quantity},
             wi.effective_rate,
             (${item.quantity}::numeric(18,3) * wi.effective_rate)::numeric(18,2),
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
        const [work] = await tx<{ allow_excess_delivery: boolean }[]>`
          select allow_excess_delivery from works
          where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const rows = await tx<
          {
            work_item_id: string;
            item_number: string;
            description: string;
            unit_code: string;
            awarded: string;
            delivered: string;
            remaining: string;
            rate: string;
          }[]
        >`
          select wi.id as work_item_id, wi.item_number, wi.description,
                 wi.unit_code,
                 wi.awarded_quantity::text as awarded,
                 coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0)::text as delivered,
                 (wi.awarded_quantity
                   - coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0))::text as remaining,
                 wi.effective_rate::text as rate
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
        (tx) => tx<ChallanRow[]>`
          select ${tx.unsafe(CHALLAN_COLUMNS)}
          from delivery_challans
          where work_id = ${workId}
          order by created_at desc, id
        `,
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
      );
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
      return withBoundTenant(database, organisationId, user.id, (tx) =>
        readDetail(tx, id),
      );
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
        requireStatus(challan, 'draft');
        await tx`
          update delivery_challans
          set challan_date = ${body.challanDate}, prefix = ${body.prefix},
              consignee_snapshot = ${jsonb(tx, body.consignee)}
          where id = ${id}
        `;
        await writeLines(tx, organisationId, id, challan.work_id, body);
        await auditChallan(tx, organisationId, user.id, 'challan.updated', id, {
          itemCount: body.items.length,
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
        requireStatus(challan, 'draft');
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
          // everything already ISSUED must stay within the awarded quantity
          // (exact numeric arithmetic in SQL). The row lock above serialises
          // competing issues of this work's single draft.
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
                ), 0) > wi.awarded_quantity
              order by wi.item_number
            `;
            if (exceeded.length > 0) {
              throw httpError(
                409,
                'QUANTITY_EXCEEDED',
                `Issuing would exceed the awarded quantity for: ${exceeded
                  .map((row) => row.item_number)
                  .join(', ')}.`,
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

          const [organisation] = await tx<{ name: string }[]>`
            select name from organisations
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
          };

          await tx`
            update delivery_challans
            set status = 'issued', challan_number = ${challanNumber},
                sequence_number = ${sequence},
                issued_snapshot = ${jsonb(tx, snapshot)},
                issued_by_user_id = ${user.id}, issued_at = ${issuedAt},
                template_version = ${CHALLAN_TEMPLATE_VERSION}
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
        requireStatus(challan, 'issued');
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
      // slow external call holds no database locks; the input is the
      // immutable issued snapshot, so re-rendering is idempotent.
      const snapshot = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          const challan = await lockChallan(tx, id);
          requireStatus(challan, 'issued');
          const [row] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from delivery_challans where id = ${id}
          `;
          return parseJsonbColumn(row?.issued_snapshot) as ChallanSnapshot;
        },
      );

      const html = renderChallanHtml(snapshot);
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
        await tx`
          update delivery_challans
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id} and status = 'issued'
        `;
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
      await assertNotMalware(scanner, body);
      const objectKey = `${organisationId}/signed/${id}.pdf`;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockChallan(tx, id);
        requireStatus(challan, 'issued');
        await storage.put(objectKey, body);
        await tx`
          update delivery_challans
          set signed_copy_object_key = ${objectKey}
          where id = ${id}
        `;
        await auditChallan(
          tx,
          organisationId,
          user.id,
          'challan.signed_copy_uploaded',
          id,
          { sizeBytes: body.length },
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
              rendered_object_key: string | null;
              signed_copy_object_key: string | null;
            }[]
          >`
            select rendered_object_key, signed_copy_object_key
            from delivery_challans where id = ${id}
          `;
          if (!row) {
            throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
          }
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
