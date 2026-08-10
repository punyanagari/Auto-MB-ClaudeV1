import {
  ApiErrorSchema,
  CancelEwayBillRequestSchema,
  EwayBillDetailResponseSchema,
  EwayBillListResponseSchema,
  RecordEwayNicResponseRequestSchema,
  SaveEwayBillRequestSchema,
  type CancelEwayBillRequest,
  type EwayBill,
  type EwayBillStatus,
  type RecordEwayNicResponseRequest,
  type SaveEwayBillRequest,
  type TransportMode,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { buildEwbPayload } from '../gsp/ewb-payload.js';
import { extractLocation, extractPincode } from '../gsp/irp-payload.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { cancellationNote } from './challans.js';

/**
 * The e-way bill (migration 0035): the movement document for a SUBMITTED
 * tax invoice — a draft invoice has no legal number to move, and a
 * cancelled one moves nothing (the 0035 insert trigger backstops both).
 *
 * Draft (the carriage details being filled in) -> generated (NIC, via
 * the GSP, answered with the 12-digit EWB number and validity window —
 * recorded verbatim, never made up locally) -> cancelled with a note it
 * keeps forever. One live e-way bill per invoice (the 0035 partial
 * unique index); cancelling one frees the slot for a corrected movement.
 *
 * The carriage rule — a road movement names a vehicle, every other mode
 * a transport document — is the 0035 CHECK; this route refuses the same
 * shapes as named 400s (VEHICLE_REQUIRED / TRANSPORT_DOC_REQUIRED) both
 * when assembling the NIC payload and when recording NIC's response, so
 * the CHECK never surfaces as an opaque 500.
 *
 * Posture is the delivery challan's throughout: one transaction per
 * request, the row locked before every transition, cancel behind its
 * explicit authority, every change audited, cross-tenant reads answered
 * with 404.
 */

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

// --- Row shapes -------------------------------------------------------------

interface EwayBillRow {
  id: string;
  tax_invoice_id: string;
  invoice_number: string | null;
  work_id: string;
  status: EwayBillStatus;
  transport_mode: TransportMode;
  transporter_id: string | null;
  transporter_name: string | null;
  vehicle_number: string | null;
  transport_doc_number: string | null;
  transport_doc_date: string | null;
  distance_km: number;
  from_pincode: string;
  to_pincode: string;
  ewb_number: string | null;
  ewb_date: Date | null;
  valid_until: Date | null;
  cancellation_note: string | null;
  created_at: Date;
  generated_at: Date | null;
  cancelled_at: Date | null;
}

const EB_COLUMNS = `
  eb.id, eb.tax_invoice_id, ti.invoice_number, ti.work_id, eb.status,
  eb.transport_mode, eb.transporter_id, eb.transporter_name,
  eb.vehicle_number, eb.transport_doc_number,
  eb.transport_doc_date::text as transport_doc_date, eb.distance_km,
  eb.from_pincode, eb.to_pincode, eb.ewb_number, eb.ewb_date, eb.valid_until,
  eb.cancellation_note, eb.created_at, eb.generated_at, eb.cancelled_at
`;

const EB_FROM = `
  from eway_bills eb
  join tax_invoices ti on ti.id = eb.tax_invoice_id
`;

function toEwayBill(row: EwayBillRow): EwayBill {
  return {
    id: row.id,
    taxInvoiceId: row.tax_invoice_id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    transportMode: row.transport_mode,
    transporterId: row.transporter_id,
    transporterName: row.transporter_name,
    vehicleNumber: row.vehicle_number,
    transportDocNumber: row.transport_doc_number,
    transportDocDate: row.transport_doc_date,
    distanceKm: row.distance_km,
    fromPincode: row.from_pincode,
    toPincode: row.to_pincode,
    ewbNumber: row.ewb_number,
    ewbDate: row.ewb_date?.toISOString() ?? null,
    validUntil: row.valid_until?.toISOString() ?? null,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    generatedAt: row.generated_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

async function readEwayBill(tx: TransactionSql, id: string): Promise<EwayBillRow> {
  const rows = (await tx.unsafe(`select ${EB_COLUMNS} ${EB_FROM} where eb.id = $1`, [
    id,
  ])) as unknown as EwayBillRow[];
  const row = rows[0];
  if (!row) throw httpError(404, 'EWAY_BILL_NOT_FOUND', 'No such e-way bill.');
  return row;
}

/** Locks the e-way bill row for the rest of the transaction and returns
 * it; every state transition starts here (`of eb` — the joined invoice
 * row is read, never written here). */
async function lockEwayBill(tx: TransactionSql, id: string): Promise<EwayBillRow> {
  const rows = (await tx.unsafe(
    `select ${EB_COLUMNS} ${EB_FROM} where eb.id = $1 for update of eb`,
    [id],
  )) as unknown as EwayBillRow[];
  const row = rows[0];
  if (!row) throw httpError(404, 'EWAY_BILL_NOT_FOUND', 'No such e-way bill.');
  return row;
}

function requireStatus(row: EwayBillRow, status: EwayBillStatus): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'EWAY_BILL_STATUS_CONFLICT',
      `This operation requires a ${status} e-way bill (current status: ${row.status}).`,
    );
  }
}

// --- Field guards -----------------------------------------------------------

interface CarriageFields {
  transport_mode: TransportMode;
  vehicle_number: string | null;
  transport_doc_number: string | null;
  transport_doc_date: string | null;
}

/** The 0035 carriage CHECK in friendly form: road names a vehicle, the
 * other modes a transport document with its date. Applied when the
 * payload is assembled and when NIC's response is recorded — the two
 * moments the carriage must actually be complete. */
function assertCarriageComplete(row: CarriageFields): void {
  if (row.transport_mode === 'road') {
    if (row.vehicle_number === null) {
      throw httpError(
        400,
        'VEHICLE_REQUIRED',
        'A road movement names the vehicle — set vehicleNumber on the e-way bill first.',
      );
    }
    return;
  }
  if (row.transport_doc_number === null || row.transport_doc_date === null) {
    throw httpError(
      400,
      'TRANSPORT_DOC_REQUIRED',
      `A ${row.transport_mode} movement names its transport document — set transportDocNumber and transportDocDate on the e-way bill first.`,
    );
  }
}

interface NormalisedSave {
  transportMode: TransportMode;
  transporterId: string | null;
  transporterName: string | null;
  vehicleNumber: string | null;
  transportDocNumber: string | null;
  transportDocDate: string | null;
  distanceKm: number;
  fromPincode: string;
  toPincode: string;
}

/** The optional text fields trimmed the way their CHECKs measure them;
 * the schema already proved the trimmed floors. */
function normalisedSave(body: SaveEwayBillRequest): NormalisedSave {
  return {
    transportMode: body.transportMode,
    transporterId: body.transporterId ?? null,
    transporterName: body.transporterName?.trim() ?? null,
    vehicleNumber: body.vehicleNumber ?? null,
    transportDocNumber: body.transportDocNumber?.trim() ?? null,
    transportDocDate: body.transportDocDate ?? null,
    distanceKm: body.distanceKm,
    fromPincode: body.fromPincode,
    toPincode: body.toPincode,
  };
}

async function auditEwayBill(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  ewayBillId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, 'eway_bills', ${ewayBillId},
      ${jsonb(tx, details)}
    )
  `;
}

// --- Routes -----------------------------------------------------------------

export function registerEwayBillRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
): void {
  app.get(
    '/api/tax-invoices/:id/eway-bills',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: EwayBillListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: invoiceId } = request.params as { id: string };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [invoice] = await tx<{ work_id: string }[]>`
            select work_id from tax_invoices where id = ${invoiceId}
          `;
          if (!invoice) {
            throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
          }
          await assertWorkAccess(tx, user.id, invoice.work_id);
          return (await tx.unsafe(
            `select ${EB_COLUMNS} ${EB_FROM}
             where eb.tax_invoice_id = $1
             order by eb.created_at desc, eb.id`,
            [invoiceId],
          )) as unknown as EwayBillRow[];
        },
      );
      return { ewayBills: rows.map(toEwayBill) };
    },
  );

  app.post(
    '/api/tax-invoices/:id/eway-bills',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveEwayBillRequestSchema,
        response: { 201: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: invoiceId } = request.params as { id: string };
      const body = normalisedSave(request.body as SaveEwayBillRequest);
      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          // The invoice row lock serialises this create against the
          // invoice's cancel (which refuses while a live e-way bill
          // exists) and against a concurrent create on the same invoice.
          const [invoice] = await tx<
            {
              id: string;
              work_id: string;
              status: string;
              invoice_number: string | null;
            }[]
          >`
            select id, work_id, status, invoice_number from tax_invoices
            where id = ${invoiceId}
            for update
          `;
          if (!invoice) {
            throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
          }
          await assertWorkAccess(tx, user.id, invoice.work_id);
          if (invoice.status !== 'submitted') {
            throw httpError(
              409,
              'TAX_INVOICE_STATUS_CONFLICT',
              `An e-way bill moves a submitted invoice (current status: ${invoice.status}) — a draft has no legal number to move, and a cancelled invoice moves nothing.`,
            );
          }
          // One live e-way bill per invoice (the 0035 partial unique
          // index is the arbiter); the 409 names the live one.
          const [live] = await tx<{ id: string; ewb_number: string | null }[]>`
            select id, ewb_number from eway_bills
            where tax_invoice_id = ${invoiceId} and status <> 'cancelled'
          `;
          if (live) {
            throw draftConflictError(
              'EWAY_BILL_EXISTS',
              `This invoice already has a live e-way bill${live.ewb_number === null ? '' : ` (${live.ewb_number})`}; cancel or delete it before raising another.`,
              live.id,
            );
          }
          const [created] = await tx<{ id: string }[]>`
            insert into eway_bills (
              organisation_id, tax_invoice_id, transport_mode, transporter_id,
              transporter_name, vehicle_number, transport_doc_number,
              transport_doc_date, distance_km, from_pincode, to_pincode,
              created_by_user_id
            )
            values (
              ${organisationId}, ${invoiceId}, ${body.transportMode},
              ${body.transporterId}, ${body.transporterName},
              ${body.vehicleNumber}, ${body.transportDocNumber},
              ${body.transportDocDate}, ${body.distanceKm}, ${body.fromPincode},
              ${body.toPincode}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'EWAY_BILL_EXISTS',
                'This invoice already has a live e-way bill; cancel or delete it before raising another.',
              );
            }
            throw error;
          });
          if (!created) throw new Error('eway bill insert returned no row');
          await auditEwayBill(
            tx,
            organisationId,
            user.id,
            'eway_bill.created',
            created.id,
            {
              taxInvoiceId: invoiceId,
              invoiceNumber: invoice.invoice_number,
              transportMode: body.transportMode,
              distanceKm: body.distanceKm,
            },
          );
          return { ewayBill: toEwayBill(await readEwayBill(tx, created.id)) };
        },
      ).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'EWAY_BILL_EXISTS', () =>
          withBoundTenant(database, organisationId, user.id, async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from eway_bills
              where tax_invoice_id = ${invoiceId} and status <> 'cancelled'
            `;
            return row?.id ?? null;
          }),
        );
      });
      return reply.status(201).send(detail);
    },
  );

  app.get(
    '/api/eway-bills/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const row = await readEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        return { ewayBill: toEwayBill(row) };
      });
    },
  );

  app.put(
    '/api/eway-bills/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveEwayBillRequestSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = normalisedSave(request.body as SaveEwayBillRequest);
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        // A generated e-way bill is NIC's record: no edits, ever. Vehicle
        // updates and extensions are their own NIC transactions and out
        // of scope here.
        requireStatus(row, 'draft');
        await tx`
          update eway_bills
          set transport_mode = ${body.transportMode},
              transporter_id = ${body.transporterId},
              transporter_name = ${body.transporterName},
              vehicle_number = ${body.vehicleNumber},
              transport_doc_number = ${body.transportDocNumber},
              transport_doc_date = ${body.transportDocDate},
              distance_km = ${body.distanceKm},
              from_pincode = ${body.fromPincode}, to_pincode = ${body.toPincode}
          where id = ${id}
        `;
        const changes = auditDiff(
          {
            transportMode: row.transport_mode,
            transporterId: row.transporter_id,
            transporterName: row.transporter_name,
            vehicleNumber: row.vehicle_number,
            transportDocNumber: row.transport_doc_number,
            transportDocDate: row.transport_doc_date,
            distanceKm: row.distance_km,
            fromPincode: row.from_pincode,
            toPincode: row.to_pincode,
          },
          { ...body },
        );
        await auditEwayBill(tx, organisationId, user.id, 'eway_bill.updated', id, {
          before: changes.before,
          after: changes.after,
        });
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );

  app.delete(
    '/api/eway-bills/:id',
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
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        // Rule 8: a draft is not yet a document, so it deletes; a
        // generated e-way bill cancels and keeps its number forever.
        requireStatus(row, 'draft');
        await tx`delete from eway_bills where id = ${id}`;
        await auditEwayBill(tx, organisationId, user.id, 'eway_bill.deleted', id, {
          taxInvoiceId: row.tax_invoice_id,
        });
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/eway-bills/:id/nic-payload',
    { schema: { params: IdParamsSchema } },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const row = await readEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.status === 'cancelled') {
          throw httpError(
            409,
            'EWAY_BILL_STATUS_CONFLICT',
            'A cancelled e-way bill moves nothing; there is no payload to carry.',
          );
        }
        // The payload NIC would accept needs the carriage complete —
        // refused here as the same 400s nic-response answers, not
        // rejected by NIC later.
        assertCarriageComplete(row);
        const [invoice] = await tx<
          {
            status: string;
            invoice_number: string | null;
            invoice_date: string;
            sac_code: string;
            service_description: string;
            gst_rate: string;
            taxable_value: string | null;
            cgst_amount: string | null;
            sgst_amount: string | null;
            igst_amount: string | null;
            total_amount: string | null;
            buyer_snapshot: unknown;
          }[]
        >`
          select status, invoice_number, invoice_date::text as invoice_date,
                 sac_code, service_description, gst_rate::text as gst_rate,
                 taxable_value::text as taxable_value,
                 cgst_amount::text as cgst_amount,
                 sgst_amount::text as sgst_amount,
                 igst_amount::text as igst_amount,
                 total_amount::text as total_amount, buyer_snapshot
          from tax_invoices where id = ${row.tax_invoice_id}
        `;
        if (
          !invoice ||
          invoice.invoice_number === null ||
          invoice.taxable_value === null ||
          invoice.cgst_amount === null ||
          invoice.sgst_amount === null ||
          invoice.igst_amount === null ||
          invoice.total_amount === null
        ) {
          // The 0035 insert trigger admits e-way bills only against
          // submitted (numbered, frozen) invoices.
          throw new Error(`eway bill ${id} points at an unfrozen invoice`);
        }
        const [organisation] = await tx<
          {
            name: string;
            address: string | null;
            gstin: string | null;
            state_code: string | null;
          }[]
        >`
          select name, address, gstin, state_code from organisations
        `;
        if (!organisation?.gstin) {
          throw httpError(
            400,
            'ORG_GSTIN_REQUIRED',
            'The organisation profile has no GSTIN; the e-way bill payload cannot name the consignor.',
          );
        }
        if (!organisation.state_code) {
          throw httpError(
            400,
            'ORG_STATE_REQUIRED',
            'The organisation profile has no GST state code; the e-way bill payload cannot name the dispatch state.',
          );
        }
        if (organisation.address === null) {
          throw httpError(
            400,
            'ORG_ADDRESS_REQUIRED',
            'The organisation profile has no address; the e-way bill payload needs the dispatch address.',
          );
        }
        const snapshot = parseJsonbColumn(invoice.buyer_snapshot) as {
          designation?: string;
          gstin?: string | null;
          address?: string | null;
          stateCode?: string | null;
          pincode?: string | null;
        } | null;
        if (
          !snapshot ||
          snapshot.designation === undefined ||
          typeof snapshot.address !== 'string' ||
          typeof snapshot.stateCode !== 'string'
        ) {
          throw new Error(
            `tax invoice ${row.tax_invoice_id} has an incomplete buyer snapshot`,
          );
        }
        const sellerPincode = extractPincode(organisation.address);
        return buildEwbPayload({
          invoiceNumber: invoice.invoice_number,
          invoiceDate: invoice.invoice_date,
          sacCode: invoice.sac_code,
          serviceDescription: invoice.service_description,
          gstRate: invoice.gst_rate,
          taxableValue: invoice.taxable_value,
          cgstAmount: invoice.cgst_amount,
          sgstAmount: invoice.sgst_amount,
          igstAmount: invoice.igst_amount,
          totalAmount: invoice.total_amount,
          seller: {
            gstin: organisation.gstin,
            tradeName: organisation.name,
            address: organisation.address,
            location: extractLocation(organisation.address, sellerPincode),
            stateCode: organisation.state_code,
          },
          buyer: {
            gstin: snapshot.gstin ?? null,
            tradeName: snapshot.designation,
            address: snapshot.address,
            location: extractLocation(snapshot.address, snapshot.pincode ?? null),
            stateCode: snapshot.stateCode,
          },
          transportMode: row.transport_mode,
          transporterId: row.transporter_id,
          transporterName: row.transporter_name,
          vehicleNumber: row.vehicle_number,
          transportDocNumber: row.transport_doc_number,
          transportDocDate: row.transport_doc_date,
          distanceKm: row.distance_km,
          fromPincode: row.from_pincode,
          toPincode: row.to_pincode,
        });
      });
    },
  );

  app.post(
    '/api/eway-bills/:id/nic-response',
    {
      schema: {
        params: IdParamsSchema,
        body: RecordEwayNicResponseRequestSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as RecordEwayNicResponseRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        // Recording what NIC already decided is clerical — writer role;
        // the legal act was the invoice's submit.
        await requireWriterRole(tx, user.id);
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        requireStatus(row, 'draft');
        // Friendly form of the 0035 carriage CHECK; the catch below is
        // its backstop for any shape this misses.
        assertCarriageComplete(row);
        await tx`
          update eway_bills
          set status = 'generated', ewb_number = ${body.ewbNumber},
              ewb_date = ${body.ewbDate}, valid_until = ${body.validUntil},
              generated_by_user_id = ${user.id}, generated_at = now()
          where id = ${id}
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23514') {
            throw httpError(
              400,
              row.transport_mode === 'road'
                ? 'VEHICLE_REQUIRED'
                : 'TRANSPORT_DOC_REQUIRED',
              row.transport_mode === 'road'
                ? 'A road movement names the vehicle — set vehicleNumber on the e-way bill first.'
                : `A ${row.transport_mode} movement names its transport document — set transportDocNumber and transportDocDate on the e-way bill first.`,
            );
          }
          throw error;
        });
        await auditEwayBill(tx, organisationId, user.id, 'eway_bill.generated', id, {
          taxInvoiceId: row.tax_invoice_id,
          invoiceNumber: row.invoice_number,
          ewbNumber: body.ewbNumber,
          ewbDate: body.ewbDate,
          validUntil: body.validUntil,
        });
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );

  app.post(
    '/api/eway-bills/:id/cancel',
    {
      schema: {
        params: IdParamsSchema,
        body: CancelEwayBillRequestSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as CancelEwayBillRequest;
      const note = cancellationNote(body.note);
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireAuthority(tx, user.id, 'cancel');
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.status === 'draft') {
          throw httpError(
            409,
            'EWAY_BILL_STATUS_CONFLICT',
            'Draft e-way bills are deleted, not cancelled.',
          );
        }
        requireStatus(row, 'generated');
        // The 0035 generated-shape CHECK holds the NIC response fields
        // to the generated status: a cancelled e-way bill clears them —
        // NIC has voided the number, and a cleared row cannot be mistaken
        // for a live movement document. The number lives on in the audit
        // event below (and in the generation event before it).
        await tx`
          update eway_bills
          set status = 'cancelled', ewb_number = null, ewb_date = null,
              valid_until = null, generated_at = null,
              generated_by_user_id = null,
              cancelled_by_user_id = ${user.id}, cancelled_at = now(),
              cancellation_note = ${note}
          where id = ${id}
        `;
        await auditEwayBill(tx, organisationId, user.id, 'eway_bill.cancelled', id, {
          ewbNumber: row.ewb_number,
          taxInvoiceId: row.tax_invoice_id,
          note,
        });
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );
}
