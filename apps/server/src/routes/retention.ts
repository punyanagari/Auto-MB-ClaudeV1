import {
  ApiErrorSchema,
  BillListResponseSchema,
  BillSchema,
  InstallSerialRequestSchema,
  InstrumentListResponseSchema,
  InstrumentSchema,
  MbEntryListResponseSchema,
  MbEntrySchema,
  ReceiptSchema,
  RecordMbEntryRequestSchema,
  RecordReceiptRequestSchema,
  RecordSerialsRequestSchema,
  SaveInstrumentRequestSchema,
  SerialListResponseSchema,
  UpdateBillStatusRequestSchema,
  UpdateInstrumentRequestSchema,
  type Bill,
  type InstallSerialRequest,
  type Instrument,
  type MbEntry,
  type Receipt,
  type RecordMbEntryRequest,
  type RecordReceiptRequest,
  type RecordSerialsRequest,
  type SaveInstrumentRequest,
  type UpdateBillStatusRequest,
  type UpdateInstrumentRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import {
  assertWorkAccess,
  requireAuthority,
  requireEvidenceRole,
  requireWriterRole,
} from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
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

interface InstrumentRow {
  id: string;
  work_id: string;
  kind: Instrument['kind'];
  reference: string;
  amount: string | null;
  issued_on: string;
  expires_on: string | null;
  status: Instrument['status'];
  notes: string | null;
  created_at: Date;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    workId: row.work_id,
    kind: row.kind,
    reference: row.reference,
    amount: row.amount,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

interface MbEntryRow {
  id: string;
  work_item_id: string;
  item_number: string;
  delivery_challan_id: string | null;
  measured_quantity: string;
  measured_on: string;
  mb_book_ref: string | null;
  remarks: string | null;
  bill_id: string | null;
  created_at: Date;
}

function toMbEntry(row: MbEntryRow): MbEntry {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    deliveryChallanId: row.delivery_challan_id,
    measuredQuantity: row.measured_quantity,
    measuredOn: row.measured_on,
    mbBookRef: row.mb_book_ref,
    remarks: row.remarks,
    billId: row.bill_id,
    createdAt: row.created_at.toISOString(),
  };
}

interface BillRow {
  id: string;
  work_id: string;
  bill_number: number;
  status: Bill['status'];
  lines_snapshot: unknown;
  total_amount: string;
  created_at: Date;
  submitted_at: Date | null;
  paid_at: Date | null;
}

function toBill(row: BillRow): Bill {
  return {
    id: row.id,
    workId: row.work_id,
    billNumber: row.bill_number,
    status: row.status,
    totalAmount: row.total_amount,
    linesSnapshot: parseJsonbColumn(row.lines_snapshot),
    createdAt: row.created_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    paidAt: row.paid_at?.toISOString() ?? null,
  };
}

export function registerRetentionRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
): void {
  // --- Delivery receipt ---------------------------------------------------
  app.post(
    '/api/challans/:id/receipt',
    {
      schema: {
        params: IdParamsSchema,
        body: RecordReceiptRequestSchema,
        response: { 201: ReceiptSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: challanId } = request.params as { id: string };
      const body = request.body as RecordReceiptRequest;
      const receipt = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireEvidenceRole(tx, user.id);
          // The row lock serialises receipt recording against concurrent
          // cancellation: whichever transaction wins, the other sees the
          // final status.
          const [challan] = await tx<{ status: string; work_id: string }[]>`
            select status, work_id from delivery_challans
            where id = ${challanId}
            for update
          `;
          if (!challan) {
            throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
          }
          await assertWorkAccess(tx, user.id, challan.work_id);
          if (challan.status !== 'issued') {
            throw httpError(
              409,
              'CHALLAN_STATUS_CONFLICT',
              'Receipts are recorded against issued challans.',
            );
          }
          const [row] = await tx<
            {
              id: string;
              received_on: string;
              received_by: string;
              remarks: string | null;
              created_at: Date;
            }[]
          >`
            insert into challan_receipts (
              organisation_id, delivery_challan_id, work_id, received_on,
              received_by, remarks, recorded_by_user_id
            )
            values (
              ${organisationId}, ${challanId}, ${challan.work_id},
              ${body.receivedOn}, ${body.receivedBy}, ${body.remarks ?? null},
              ${user.id}
            )
            returning id, received_on::text as received_on, received_by,
                      remarks, created_at
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'RECEIPT_EXISTS',
                'A receipt is already recorded for this challan.',
              );
            }
            throw error;
          });
          if (!row) throw new Error('receipt insert returned no row');
          await audit(
            tx,
            organisationId,
            user.id,
            'challan.received',
            'challan_receipts',
            row.id,
            {
              challanId,
              receivedOn: body.receivedOn,
            },
          );
          return {
            id: row.id,
            deliveryChallanId: challanId,
            receivedOn: row.received_on,
            receivedBy: row.received_by,
            remarks: row.remarks,
            createdAt: row.created_at.toISOString(),
          } satisfies Receipt;
        },
      );
      return reply.status(201).send(receipt);
    },
  );

  app.get(
    '/api/challans/:id/receipt',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: ReceiptSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: challanId } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const [ref] = await tx<{ work_id: string }[]>`
          select work_id from delivery_challans where id = ${challanId}
        `;
        if (!ref) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertWorkAccess(tx, user.id, ref.work_id);
        const [row] = await tx<
          {
            id: string;
            received_on: string;
            received_by: string;
            remarks: string | null;
            created_at: Date;
          }[]
        >`
          select id, received_on::text as received_on, received_by, remarks,
                 created_at
          from challan_receipts where delivery_challan_id = ${challanId}
        `;
        if (!row) {
          throw httpError(404, 'RECEIPT_NOT_FOUND', 'No receipt recorded yet.');
        }
        return {
          id: row.id,
          deliveryChallanId: challanId,
          receivedOn: row.received_on,
          receivedBy: row.received_by,
          remarks: row.remarks,
          createdAt: row.created_at.toISOString(),
        } satisfies Receipt;
      });
    },
  );

  // --- Serial traceability ------------------------------------------------
  app.post(
    '/api/challans/:id/serials',
    {
      schema: {
        params: IdParamsSchema,
        body: RecordSerialsRequestSchema,
        response: { 201: SerialListResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: challanId } = request.params as { id: string };
      const body = request.body as RecordSerialsRequest;
      const serials = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireEvidenceRole(tx, user.id);
          // Lock the line so the quantity cap cannot race.
          const [line] = await tx<
            { id: string; work_id: string; quantity: string; challan_status: string }[]
          >`
            select dci.id, dci.work_id, dci.quantity::text as quantity, dc.status as challan_status
            from delivery_challan_items dci
            join delivery_challans dc on dc.id = dci.delivery_challan_id
            where dci.id = ${body.challanItemId}
              and dci.delivery_challan_id = ${challanId}
            for update of dci, dc
          `;
          if (!line) {
            throw httpError(404, 'CHALLAN_ITEM_NOT_FOUND', 'No such challan line.');
          }
          if (line.challan_status !== 'issued') {
            throw httpError(
              409,
              'CHALLAN_STATUS_CONFLICT',
              'Serials are recorded against issued challans.',
            );
          }
          await assertWorkAccess(tx, user.id, line.work_id);
          const [existing] = await tx<{ count: string }[]>`
            select count(*)::text as count from challan_item_serials
            where delivery_challan_item_id = ${body.challanItemId}
          `;
          const already = Number(existing?.count ?? '0');
          if (already + body.serialNumbers.length > Math.floor(Number(line.quantity))) {
            throw httpError(
              409,
              'SERIAL_LIMIT',
              `This line shipped ${line.quantity}; ${String(already)} serials are already recorded.`,
            );
          }
          for (const serialNumber of body.serialNumbers) {
            await tx`
              insert into challan_item_serials (
                organisation_id, work_id, delivery_challan_id,
                delivery_challan_item_id, serial_number
              )
              values (
                ${organisationId}, ${line.work_id}, ${challanId},
                ${body.challanItemId}, ${serialNumber}
              )
            `.catch((error: unknown) => {
              if (error instanceof Error && 'code' in error && error.code === '23505') {
                throw httpError(
                  409,
                  'DUPLICATE_SERIAL',
                  `Serial ${serialNumber} already exists in this Work.`,
                );
              }
              throw error;
            });
          }
          await audit(
            tx,
            organisationId,
            user.id,
            'serials.recorded',
            'challan_item_serials',
            challanId,
            {
              challanItemId: body.challanItemId,
              count: body.serialNumbers.length,
            },
          );
          return listSerials(tx, line.work_id);
        },
      );
      return reply.status(201).send({ serials });
    },
  );

  app.put(
    '/api/serials/:id/installation',
    {
      schema: {
        params: IdParamsSchema,
        body: InstallSerialRequestSchema,
        response: { 200: SerialListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as InstallSerialRequest;
      const serials = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireEvidenceRole(tx, user.id);
          const [serial] = await tx<
            {
              work_id: string;
              installed_on: string | null;
              installation_remarks: string | null;
            }[]
          >`
            select work_id, installed_on::text as installed_on,
                   installation_remarks
            from challan_item_serials where id = ${id}
            for update
          `;
          if (!serial) {
            throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
          }
          await assertWorkAccess(tx, user.id, serial.work_id);
          const [updated] = await tx<{ work_id: string }[]>`
            update challan_item_serials
            set installed_on = ${body.installedOn},
                installation_remarks = ${body.remarks ?? null}
            where id = ${id}
            returning work_id
          `;
          if (!updated) {
            throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
          }
          // Re-recording an installation overwrites the previous date, so
          // the trail keeps the old value alongside the new one.
          const changes = auditDiff(
            {
              installedOn: serial.installed_on,
              installationRemarks: serial.installation_remarks,
            },
            {
              installedOn: body.installedOn,
              installationRemarks: body.remarks ?? null,
            },
          );
          await audit(
            tx,
            organisationId,
            user.id,
            'serial.installed',
            'challan_item_serials',
            id,
            { before: changes.before, after: changes.after },
          );
          return listSerials(tx, updated.work_id);
        },
      );
      return { serials };
    },
  );

  app.get(
    '/api/works/:id/serials',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: SerialListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const serials = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await assertWorkAccess(tx, user.id, workId);
          return listSerials(tx, workId);
        },
      );
      return { serials };
    },
  );

  // --- Contract instruments -----------------------------------------------
  app.get(
    '/api/works/:id/instruments',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: InstrumentListResponseSchema, ...errorResponses },
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
          return tx<InstrumentRow[]>`
            select id, work_id, kind, reference, amount::text as amount,
                   issued_on::text as issued_on, expires_on::text as expires_on,
                   status, notes, created_at
            from work_instruments
            where work_id = ${workId}
            order by kind, issued_on, reference
          `;
        },
      );
      return { instruments: rows.map(toInstrument) };
    },
  );

  app.post(
    '/api/works/:id/instruments',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveInstrumentRequestSchema,
        response: { 201: InstrumentSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as SaveInstrumentRequest;
      const instrument = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          await assertWorkAccess(tx, user.id, workId);
          const [work] = await tx<{ id: string }[]>`
            select id from works where id = ${workId} and deleted_at is null
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
          const [row] = await tx<InstrumentRow[]>`
            insert into work_instruments (
              organisation_id, work_id, kind, reference, amount, issued_on,
              expires_on, notes, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.kind}, ${body.reference},
              ${body.amount ?? null}, ${body.issuedOn}, ${body.expiresOn ?? null},
              ${body.notes ?? null}, ${user.id}
            )
            returning id, work_id, kind, reference, amount::text as amount,
                      issued_on::text as issued_on, expires_on::text as expires_on,
                      status, notes, created_at
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'INSTRUMENT_EXISTS',
                'This instrument reference already exists for the Work.',
              );
            }
            throw error;
          });
          if (!row) throw new Error('instrument insert returned no row');
          await audit(
            tx,
            organisationId,
            user.id,
            'instrument.created',
            'work_instruments',
            row.id,
            {
              workId,
              kind: body.kind,
              reference: body.reference,
            },
          );
          return toInstrument(row);
        },
      );
      return reply.status(201).send(instrument);
    },
  );

  app.put(
    '/api/instruments/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: UpdateInstrumentRequestSchema,
        response: { 200: InstrumentSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as UpdateInstrumentRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        // The row lock serialises concurrent status edits, and the locked
        // values are the audit trail's before-image.
        const [existing] = await tx<
          {
            work_id: string;
            status: string;
            expires_on: string | null;
            notes: string | null;
          }[]
        >`
          select work_id, status, expires_on::text as expires_on, notes
          from work_instruments where id = ${id}
          for update
        `;
        if (!existing) {
          throw httpError(404, 'INSTRUMENT_NOT_FOUND', 'No such instrument.');
        }
        await assertWorkAccess(tx, user.id, existing.work_id);
        if (
          body.status !== undefined &&
          existing.status !== body.status &&
          existing.status !== 'active'
        ) {
          throw httpError(
            409,
            'INSTRUMENT_STATUS_TERMINAL',
            `A ${existing.status} instrument cannot change status.`,
          );
        }
        const [row] = await tx<InstrumentRow[]>`
          update work_instruments
          set status = coalesce(${body.status ?? null}, status),
              expires_on = coalesce(${body.expiresOn ?? null}, expires_on),
              notes = coalesce(${body.notes ?? null}, notes)
          where id = ${id}
          returning id, work_id, kind, reference, amount::text as amount,
                    issued_on::text as issued_on, expires_on::text as expires_on,
                    status, notes, created_at
        `;
        if (!row) throw httpError(404, 'INSTRUMENT_NOT_FOUND', 'No such instrument.');
        const changes = auditDiff(
          {
            status: existing.status,
            expiresOn: existing.expires_on,
            notes: existing.notes,
          },
          {
            status: body.status ?? existing.status,
            expiresOn: body.expiresOn ?? existing.expires_on,
            notes: body.notes ?? existing.notes,
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'instrument.updated',
          'work_instruments',
          id,
          { before: changes.before, after: changes.after },
        );
        return toInstrument(row);
      });
    },
  );

  // --- Measurement Book ---------------------------------------------------
  app.get(
    '/api/works/:id/mb-entries',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: MbEntryListResponseSchema, ...errorResponses },
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
          return tx<MbEntryRow[]>`
            select mb.id, mb.work_item_id, wi.item_number,
                   mb.delivery_challan_id, mb.measured_quantity::text as measured_quantity,
                   mb.measured_on::text as measured_on, mb.mb_book_ref, mb.remarks,
                   mb.bill_id, mb.created_at
            from mb_entries mb
            join work_items wi on wi.id = mb.work_item_id
            where mb.work_id = ${workId}
            order by mb.measured_on, mb.created_at
          `;
        },
      );
      return { entries: rows.map(toMbEntry) };
    },
  );

  app.post(
    '/api/works/:id/mb-entries',
    {
      schema: {
        params: IdParamsSchema,
        body: RecordMbEntryRequestSchema,
        response: { 201: MbEntrySchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as RecordMbEntryRequest;
      const entry = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireEvidenceRole(tx, user.id);
          await assertWorkAccess(tx, user.id, workId);
          // Lock the item: cumulative measurement must not exceed delivered
          // (issued challans), and this check must not race.
          const [item] = await tx<{ id: string; item_number: string }[]>`
            select id, item_number from work_items
            where id = ${body.workItemId} and work_id = ${workId}
              and deleted_at is null
            for update
          `;
          if (!item) {
            throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
          }
          if (body.deliveryChallanId !== undefined) {
            // The claimed provenance must be a real, issued challan of this
            // Work; the row lock serialises against cancellation, and the
            // composite foreign key backs this check in the database.
            const [source] = await tx<{ status: string }[]>`
              select status from delivery_challans
              where id = ${body.deliveryChallanId} and work_id = ${workId}
              for update
            `;
            if (!source) {
              throw httpError(
                404,
                'CHALLAN_NOT_FOUND',
                'The referenced challan does not belong to this Work.',
              );
            }
            if (source.status !== 'issued') {
              throw httpError(
                409,
                'CHALLAN_STATUS_CONFLICT',
                'Measurements reference issued challans.',
              );
            }
          }
          const [exceeds] = await tx<{ exceeded: boolean }[]>`
            select (
              coalesce((
                select sum(measured_quantity) from mb_entries
                where work_item_id = ${body.workItemId}
              ), 0) + ${body.measuredQuantity}::numeric(18,3)
            ) > coalesce((
              select sum(dci.quantity)
              from delivery_challan_items dci
              join delivery_challans dc on dc.id = dci.delivery_challan_id
              where dci.work_item_id = ${body.workItemId}
                and dc.status = 'issued'
            ), 0) as exceeded
          `;
          if (exceeds?.exceeded === true) {
            throw httpError(
              409,
              'MEASUREMENT_EXCEEDS_DELIVERY',
              `Cumulative measurement for ${item.item_number} would exceed the delivered quantity.`,
            );
          }
          const [row] = await tx<MbEntryRow[]>`
            insert into mb_entries (
              organisation_id, work_id, work_item_id, delivery_challan_id,
              measured_quantity, measured_on, mb_book_ref, remarks,
              recorded_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.workItemId},
              ${body.deliveryChallanId ?? null}, ${body.measuredQuantity},
              ${body.measuredOn}, ${body.mbBookRef ?? null},
              ${body.remarks ?? null}, ${user.id}
            )
            returning id, work_item_id, ${item.item_number} as item_number,
                      delivery_challan_id,
                      measured_quantity::text as measured_quantity,
                      measured_on::text as measured_on, mb_book_ref, remarks,
                      bill_id, created_at
          `;
          if (!row) throw new Error('mb entry insert returned no row');
          await audit(
            tx,
            organisationId,
            user.id,
            'mb.recorded',
            'mb_entries',
            row.id,
            {
              workItemId: body.workItemId,
              measuredQuantity: body.measuredQuantity,
            },
          );
          return toMbEntry(row);
        },
      );
      return reply.status(201).send(entry);
    },
  );

  // --- Bills ----------------------------------------------------------------
  app.get(
    '/api/works/:id/bills',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: BillListResponseSchema, ...errorResponses },
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
          return tx<BillRow[]>`
          select id, work_id, bill_number, status, lines_snapshot,
                 total_amount::text as total_amount, created_at, submitted_at,
                 paid_at
          from bills where work_id = ${workId}
          order by bill_number desc
        `;
        },
      );
      return { bills: rows.map(toBill) };
    },
  );

  app.post(
    '/api/works/:id/bills',
    {
      schema: {
        params: IdParamsSchema,
        response: { 201: BillSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const bill = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          // Preparing a bill is a financial act: issue authority required.
          await requireAuthority(tx, user.id, 'issue');
          await assertWorkAccess(tx, user.id, workId);

          // The counter row lock serialises concurrent bill preparation for
          // the Work (numbering AND the unbilled-set selection).
          const [counter] = await tx<{ next_value: number }[]>`
            insert into bill_counters (organisation_id, work_id)
            values (${organisationId}, ${workId})
            on conflict (organisation_id, work_id)
            do update set next_value = bill_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
          if (!counter) throw new Error('bill counter upsert returned no row');

          const unbilled = await tx<
            {
              id: string;
              work_item_id: string;
              item_number: string;
              unit_code: string;
              effective_rate: string;
              measured: string;
            }[]
          >`
            select mb.id, mb.work_item_id, wi.item_number, wi.unit_code,
                   wi.effective_rate::text as effective_rate,
                   mb.measured_quantity::text as measured
            from mb_entries mb
            join work_items wi on wi.id = mb.work_item_id
            where mb.work_id = ${workId} and mb.bill_id is null
            for update of mb
          `;
          if (unbilled.length === 0) {
            throw httpError(
              409,
              'NO_UNBILLED_MEASUREMENTS',
              'Every Measurement Book entry for this Work is already billed.',
            );
          }

          // Aggregate over the EXACT locked ID set — never a fresh
          // bill_id-is-null scan. A measurement committed after the lock
          // stays unbilled and lands on the next bill; it must not be
          // stamped into a snapshot that never counted it.
          const lockedIds = unbilled.map((entry) => entry.id);
          const [totals] = await tx<{ lines: unknown; total: string }[]>`
            select jsonb_agg(line order by item_number) as lines,
                   sum(amount)::numeric(18,2)::text as total
            from (
              select wi.item_number,
                     jsonb_build_object(
                       'workItemId', wi.id,
                       'itemNumber', wi.item_number,
                       'unitCode', wi.unit_code,
                       'quantity', sum(mb.measured_quantity)::text,
                       'rate', wi.effective_rate::text,
                       'amount', (sum(mb.measured_quantity) * wi.effective_rate)::numeric(18,2)::text
                     ) as line,
                     (sum(mb.measured_quantity) * wi.effective_rate)::numeric(18,2) as amount
              from mb_entries mb
              join work_items wi on wi.id = mb.work_item_id
              where mb.id = any(${lockedIds}::uuid[])
              group by wi.id
            ) grouped
          `;
          if (!totals) throw new Error('bill aggregation returned no row');

          const [row] = await tx<BillRow[]>`
            insert into bills (
              organisation_id, work_id, bill_number, lines_snapshot,
              total_amount, prepared_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${counter.next_value},
              ${jsonb(tx, parseJsonbColumn(totals.lines))}, ${totals.total},
              ${user.id}
            )
            returning id, work_id, bill_number, status, lines_snapshot,
                      total_amount::text as total_amount, created_at,
                      submitted_at, paid_at
          `;
          if (!row) throw new Error('bill insert returned no row');

          await tx`
            update mb_entries set bill_id = ${row.id}
            where id = any(${lockedIds}::uuid[])
          `;
          await audit(tx, organisationId, user.id, 'bill.prepared', 'bills', row.id, {
            billNumber: row.bill_number,
            totalAmount: totals.total,
            entryCount: unbilled.length,
          });
          return toBill(row);
        },
      );
      return reply.status(201).send(bill);
    },
  );

  app.post(
    '/api/bills/:id/status',
    {
      schema: {
        params: IdParamsSchema,
        body: UpdateBillStatusRequestSchema,
        response: { 200: BillSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as UpdateBillStatusRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireAuthority(tx, user.id, 'issue');
        const [current] = await tx<{ status: Bill['status']; work_id: string }[]>`
          select status, work_id from bills where id = ${id} for update
        `;
        if (!current) throw httpError(404, 'BILL_NOT_FOUND', 'No such bill.');
        await assertWorkAccess(tx, user.id, current.work_id);
        const allowed =
          (current.status === 'prepared' && body.status === 'submitted') ||
          (current.status === 'submitted' && body.status === 'paid');
        if (!allowed) {
          throw httpError(
            409,
            'BILL_STATUS_CONFLICT',
            `A ${current.status} bill cannot move to ${body.status}.`,
          );
        }
        const [row] = await tx<BillRow[]>`
          update bills
          set status = ${body.status},
              submitted_at = case when ${body.status} = 'submitted' then now() else submitted_at end,
              paid_at = case when ${body.status} = 'paid' then now() else paid_at end
          where id = ${id}
          returning id, work_id, bill_number, status, lines_snapshot,
                    total_amount::text as total_amount, created_at,
                    submitted_at, paid_at
        `;
        if (!row) throw new Error('bill status update returned no row');
        await audit(tx, organisationId, user.id, `bill.${body.status}`, 'bills', id, {
          before: { status: current.status },
          after: { status: body.status },
        });
        return toBill(row);
      });
    },
  );
}

async function listSerials(
  tx: TransactionSql,
  workId: string,
): Promise<
  {
    id: string;
    deliveryChallanId: string;
    challanItemId: string;
    challanNumber: string | null;
    itemDescription: string;
    serialNumber: string;
    installedOn: string | null;
    installationRemarks: string | null;
  }[]
> {
  const rows = await tx<
    {
      id: string;
      delivery_challan_id: string;
      delivery_challan_item_id: string;
      challan_number: string | null;
      description_snapshot: string;
      serial_number: string;
      installed_on: string | null;
      installation_remarks: string | null;
    }[]
  >`
    select s.id, s.delivery_challan_id, s.delivery_challan_item_id,
           dc.challan_number, dci.description_snapshot, s.serial_number,
           s.installed_on::text as installed_on, s.installation_remarks
    from challan_item_serials s
    join delivery_challans dc on dc.id = s.delivery_challan_id
    join delivery_challan_items dci on dci.id = s.delivery_challan_item_id
    where s.work_id = ${workId}
    order by s.serial_number
  `;
  return rows.map((row) => ({
    id: row.id,
    deliveryChallanId: row.delivery_challan_id,
    challanItemId: row.delivery_challan_item_id,
    challanNumber: row.challan_number,
    itemDescription: row.description_snapshot,
    serialNumber: row.serial_number,
    installedOn: row.installed_on,
    installationRemarks: row.installation_remarks,
  }));
}
