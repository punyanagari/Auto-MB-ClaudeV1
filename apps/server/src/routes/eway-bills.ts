import {
  ApiErrorSchema,
  CancelStatutoryDocumentRequestSchema,
  CancelEwayBillRequestSchema,
  EwayBillDetailResponseSchema,
  EwayBillListResponseSchema,
  RecordManualStatutoryCancellationRequestSchema,
  RecordEwayNicResponseRequestSchema,
  SaveEwayBillRequestSchema,
  type CancelEwayBillRequest,
  type CancelStatutoryDocumentRequest,
  type EwayBill,
  type EwayProviderState,
  type EwayBillStatus,
  type RecordManualStatutoryCancellationRequest,
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
import {
  assertWorkAccess as assertScopedWorkAccess,
  requireAuthority,
  requireWriterRole,
} from '../authz.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import {
  finishStatutoryOperation,
  providerFailure,
  recoverStaleStatutoryOperation,
  sha256Hex,
  startStatutoryOperation,
} from '../gsp/provider-operations.js';
import type {
  EwayBillProviderEvidence,
  StatutoryProvider,
} from '../gsp/statutory-provider.js';
import {
  exactJsonInteger,
  stringifyStatutoryJson,
} from '../gsp/statutory-json.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { requireUser } from '../session.js';
import {
  parseTaxInvoiceIssuedSnapshot,
  TaxInvoiceSnapshotError,
} from '../tax-invoice-snapshot.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { cancellationNote } from './challans.js';

/**
 * The e-way bill (migration 0035): the movement document for a SUBMITTED
 * tax invoice â€” a draft invoice has no legal number to move, and a
 * cancelled one moves nothing (the 0035 insert trigger backstops both).
 *
 * Draft (the carriage details being filled in) -> generated (NIC, via
 * the GSP, answered with the 12-digit EWB number and validity window â€”
 * recorded verbatim, never made up locally) -> cancelled with a note it
 * keeps forever. One live e-way bill per invoice (the 0035 partial
 * unique index); cancelling one frees the slot for a corrected movement.
 *
 * The carriage rule â€” a road movement names a vehicle, every other mode
 * a transport document â€” is the 0035 CHECK; this route refuses the same
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

// --- Row shapes -------------------------------------------------------------

interface EwayBillRow {
  id: string;
  tax_invoice_id: string;
  invoice_number: string | null;
  work_id: string | null;
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
  provider: 'manual' | 'whitebooks' | null;
  provider_state: EwayProviderState;
  ewb_date: Date | null;
  valid_until: Date | null;
  ewb_date_text: string | null;
  valid_until_text: string | null;
  legacy_evidence_missing: boolean;
  provider_cancelled_at: Date | null;
  provider_cancelled_at_text: string | null;
  provider_cancel_reason_code: string | null;
  provider_cancel_remark: string | null;
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
  eb.from_pincode, eb.to_pincode, eb.ewb_number, eb.provider, eb.provider_state,
  eb.ewb_date, eb.valid_until, eb.ewb_date_text, eb.valid_until_text,
  eb.legacy_evidence_missing,
  eb.provider_cancelled_at, eb.provider_cancelled_at_text,
  eb.provider_cancel_reason_code, eb.provider_cancel_remark,
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
    provider: row.provider,
    providerState: row.provider_state,
    ewbDate: row.ewb_date?.toISOString() ?? null,
    validUntil: row.valid_until?.toISOString() ?? null,
    ewbDateText: row.ewb_date_text,
    validUntilText: row.valid_until_text,
    legacyEvidenceMissing: row.legacy_evidence_missing,
    providerCancelledAt: row.provider_cancelled_at?.toISOString() ?? null,
    providerCancelledAtText: row.provider_cancelled_at_text,
    providerCancelReasonCode: row.provider_cancel_reason_code,
    providerCancelRemark: row.provider_cancel_remark,
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
 * it; every state transition starts here (`of eb` â€” the joined invoice
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

async function assertWorkAccess(
  tx: TransactionSql,
  userId: string,
  workId: string | null,
): Promise<void> {
  if (workId !== null) await assertScopedWorkAccess(tx, userId, workId);
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
 * payload is assembled and when NIC's response is recorded â€” the two
 * moments the carriage must actually be complete. */
function assertCarriageComplete(row: CarriageFields): void {
  if (row.transport_mode === 'road') {
    if (row.vehicle_number === null) {
      throw httpError(
        400,
        'VEHICLE_REQUIRED',
        'A road movement names the vehicle â€” set vehicleNumber on the e-way bill first.',
      );
    }
    return;
  }
  if (row.transport_doc_number === null || row.transport_doc_date === null) {
    throw httpError(
      400,
      'TRANSPORT_DOC_REQUIRED',
      `A ${row.transport_mode} movement names its transport document â€” set transportDocNumber and transportDocDate on the e-way bill first.`,
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
  provider?: StatutoryProvider,
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
          const [invoice] = await tx<{ work_id: string | null }[]>`
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
              `An e-way bill moves a submitted invoice (current status: ${invoice.status}) â€” a draft has no legal number to move, and a cancelled invoice moves nothing.`,
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
            returniçÏ9¶‰žËkºwµç}É­•ÍÌ¡Ñà°ÕÍ•È¹¥°É½Ü¹Ý½É­}¥¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€]e}	%11}9=Q}AA1%	1}Q=}MIY%}%9Y=%œ°(€€€€€€€€€€€€Q¡¥ÌÕµÕ±…Ñ¥Ù”Ñ…à¥¹Ù½¥”½¹Ñ…¥¹Ì„MÍ•ÉÙ¥”±¥¹”¸9¼µÝ…ä	¥±°Á…å±½…¥Ì•áÁ½Í•Õ¹Ñ¥°½½‘Ì½!M8‘•±¥Ù•Éä™…ÑÌ•á¥ÍÐ¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€Ù½¥É•Á±ä¹ÑåÁ” …ÁÁ±¥…Ñ¥½¸½©Í½¸ì¡…ÉÍ•ÐõÕÑ˜´àœ¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹Í•¹¡Á…å±½…‘)Í½¸¤ì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½•Ý…äµ‰¥±±Ì¼é¥½¹¥ŒµÉ•ÍÁ½¹Í”œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äèI•½É‘Ý…å9¥I•ÍÁ½¹Í•I•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…ÌI•½É‘Ý…å9¥I•ÍÁ½¹Í•I•ÅÕ•ÍÐì(€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€¼¼½µÁ…Ñ¥‰¥±¥Ñä¥µÁ½ÉÐ½¹±ä¸5…¹Õ…±±äÑåÁ••Ù¥‘•¹”¥Ì•áÁ±¥¥Ñ±ä(€€€€€€€€¼¼Õ¹Ù•É¥™¥•…¹É•ÅÕ¥É•Ì¥ÍÍÕ”…ÕÑ¡½É¥Ñä¸(€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•ÕÑ¡½É¥Ñä¡Ñà°ÕÍ•È¹¥°€¥ÍÍÕ”œ¤ì(€€€€€€€½¹ÍÐÉ½Ü€ô…Ý…¥Ð±½­Ý…å	¥±°¡Ñà°¥¤ì(€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°É½Ü¹Ý½É­}¥¤ì(€€€€€€€¥˜€¡ÁÉ½Ù¥‘•È€„ôôÕ¹‘•™¥¹•¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€59U1}AI=Y%I}Y%9}%M	1œ°(€€€€€€€€€€€€5…¹Õ…°9%•Ù¥‘•¹”•¹ÑÉä¥Ì‘¥Í…‰±•Ý¡¥±”]¡¥Ñ•‰½½­ÌÑÉ…¹ÍÁ½ÉÐ¥Ì½¹™¥ÕÉ•¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€É•ÅÕ¥É•MÑ…ÑÕÌ¡É½Ü°€‘É…™Ðœ¤ì(€€€€€€€¥˜€¡É½Ü¹ÁÉ½Ù¥‘•È€„ôô¹Õ±°ñðÉ½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€„ôô€¹½Ñ}É•ÅÕ•ÍÑ•œ¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€59U1}AI=Y%I}Y%9}=91%Pœ°(€€€€€€€€€€€€5…¹Õ…°9%•Ù¥‘•¹”…¹¹½ÐÉ•Á±…”½È½µÁ±•Ñ”…¸•á¥ÍÑ¥¹œÁÉ½Ù¥‘•È…ÑÑ•µÁÐ¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€€¼¼É¥•¹‘±ä™½É´½˜Ñ¡”€ÀÀÌÔ…ÉÉ¥…”!,ìÑ¡”…Ñ ‰•±½Ü¥Ì(€€€€€€€€¼¼¥ÑÌ‰…­ÍÑ½À™½È…¹äÍ¡…Á”Ñ¡¥Ìµ¥ÍÍ•Ì¸(€€€€€€€…ÍÍ•ÉÑ…ÉÉ¥…•½µÁ±•Ñ”¡É½Ü¤ì(€€€€€€€…Ý…¥ÐÑá€(€€€€€€€€€ÕÁ‘…Ñ”•Ý…å}‰¥±±Ì(€€€€€€€€€Í•ÐÍÑ…ÑÕÌ€ô€•¹•É…Ñ•œ°•Ý‰}¹Õµ‰•È€ô€‘í‰½‘ä¹•Ý‰9Õµ‰•Éô°(€€€€€€€€€€€€€•Ý‰}‘…Ñ”€ô€‘í‰½‘ä¹•Ý‰…Ñ•ô°Ù…±¥‘}Õ¹Ñ¥°€ô€‘í‰½‘ä¹Ù…±¥‘U¹Ñ¥±ô°(€€€€€€€€€€€€€•Ý‰}‘…Ñ•}Ñ•áÐ€ô€‘í‰½‘ä¹•Ý‰…Ñ•Q•áÐ¹ÑÉ¥´ ¥ô°(€€€€€€€€€€€€€Ù…±¥‘}Õ¹Ñ¥±}Ñ•áÐ€ô€‘í‰½‘ä¹Ù…±¥‘U¹Ñ¥±Q•áÐ¹ÑÉ¥´ ¥ô°(€€€€€€€€€€€€€ÁÉ½Ù¥‘•È€ô€µ…¹Õ…°œ°ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ô€•¹•É…Ñ•œ°(€€€€€€€€€€€€€•¹•É…Ñ•‘}‰å}ÕÍ•É}¥€ô€‘íÕÍ•È¹¥‘ô°•¹•É…Ñ•‘}…Ð€ô¹½Ü ¤(€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½Ý¸¤€ôøì(€€€€€€€€€¥˜€¡•ÉÉ½È¥¹ÍÑ…¹•½˜ÉÉ½È€˜˜€½‘”œ¥¸•ÉÉ½È€˜˜•ÉÉ½È¹½‘”€ôôô€œÈÌÔÄÐœ¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀÀ°(€€€€€€€€€€€€€É½Ü¹ÑÉ…¹ÍÁ½ÉÑ}µ½‘”€ôôô€É½…œ(€€€€€€€€€€€€€€€€ü€Y!%1}IEU%Iœ(€€€€€€€€€€€€€€€€è€QI9MA=IQ}=}IEU%Iœ°(€€€€€€€€€€€€€É½Ü¹ÑÉ…¹ÍÁ½ÉÑ}µ½‘”€ôôô€É½…œ(€€€€€€€€€€€€€€€€ü€É½…µ½Ù•µ•¹Ð¹…µ•ÌÑ¡”Ù•¡¥±”ƒŠPÍ•ÐÙ•¡¥±•9Õµ‰•È½¸Ñ¡””µÝ…ä‰¥±°™¥ÉÍÐ¸œ(€€€€€€€€€€€€€€€€è€‘íÉ½Ü¹ÑÉ…¹ÍÁ½ÉÑ}µ½‘•ôµ½Ù•µ•¹Ð¹…µ•Ì¥ÑÌÑÉ…¹ÍÁ½ÉÐ‘½Õµ•¹ÐƒŠPÍ•ÐÑÉ…¹ÍÁ½ÉÑ½9Õµ‰•È…¹ÑÉ…¹ÍÁ½ÉÑ½…Ñ”½¸Ñ¡””µÝ…ä‰¥±°™¥ÉÍÐ¹€°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€ô¤ì(€€€€€€€…Ý…¥Ð…Õ‘¥ÑÝ…å	¥±°¡Ñà°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°€•Ý…å}‰¥±°¹•¹•É…Ñ•œ°¥°ì(€€€€€€€€€Ñ…á%¹Ù½¥•%èÉ½Ü¹Ñ…á}¥¹Ù½¥•}¥°(€€€€€€€€€¥¹Ù½¥•9Õµ‰•ÈèÉ½Ü¹¥¹Ù½¥•}¹Õµ‰•È°(€€€€€€€€€•Ý‰9Õµ‰•Èè‰½‘ä¹•Ý‰9Õµ‰•È°(€€€€€€€€€•Ý‰…Ñ”è‰½‘ä¹•Ý‰…Ñ”°(€€€€€€€€€Ù…±¥‘U¹Ñ¥°è‰½‘ä¹Ù…±¥‘U¹Ñ¥°°(€€€€€€€€€•Ù¥‘•¹”è€µ…¹Õ…±}Õ¹Ù•É¥™¥•œ°(€€€€€€€ô¤ì(€€€€€€€É•ÑÕÉ¸ì•Ý…å	¥±°èÑ½Ý…å	¥±°¡…Ý…¥ÐÉ•…‘Ý…å	¥±°¡Ñà°¥¤¤ôì(€€€€€ô¤ì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½•Ý…äµ‰¥±±Ì¼é¥½µ…¹Õ…°µ…¹•°µÉ•ÍÁ½¹Í”œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äèI•½É‘5…¹Õ…±MÑ…ÑÕÑ½Éå…¹•±±…Ñ¥½¹I•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…ÌI•½É‘5…¹Õ…±MÑ…ÑÕÑ½Éå…¹•±±…Ñ¥½¹I•ÅÕ•ÍÐì(€€€€€½¹ÍÐÉ•µ…É¬€ô‰½‘ä¹É•µ…É¬¹ÑÉ¥´ ¤ì(€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•ÕÑ¡½É¥Ñä¡Ñà°ÕÍ•È¹¥°€…¹•°œ¤ì(€€€€€€€½¹ÍÐÉ½Ü€ô…Ý…¥Ð±½­Ý…å	¥±°¡Ñà°¥¤ì(€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°É½Ü¹Ý½É­}¥¤ì(€€€€€€€¥˜€¡É½Ü¹ÍÑ…ÑÕÌ€„ôô€•¹•É…Ñ•œ€˜˜É½Ü¹ÍÑ…ÑÕÌ€„ôô€…¹•±±•œ¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€]e}	%11}MQQUM}=91%Pœ°(€€€€€€€€€€€€=¹±ä…¸¥ÍÍÕ•µÝ…ä	¥±°…¸É••¥Ù”•áÑ•É¹…°…¹•±±…Ñ¥½¸•Ù¥‘•¹”¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€½¹ÍÐµ…¹Õ…±Ñ¥Ù”€ô(€€€€€€€€€É½Ü¹ÁÉ½Ù¥‘•È€ôôô€µ…¹Õ…°œ€˜˜(€€€€€€€€€€¡É½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ôôô€•¹•É…Ñ•œñð(€€€€€€€€€€€É½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ôôô€…¹•±±…Ñ¥½¹}Õ¹­¹½Ý¸œ¤ì(€€€€€€€½¹ÍÐÝ¡¥Ñ•‰½½­ÍU¹­¹½Ý¸€ô(€€€€€€€€€É½Ü¹ÁÉ½Ù¥‘•È€ôôô€Ý¡¥Ñ•‰½½­Ìœ€˜˜(€€€€€€€€€É½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ôôô€…¹•±±…Ñ¥½¹}Õ¹­¹½Ý¸œì(€€€€€€€¥˜€ …µ…¹Õ…±Ñ¥Ù”€˜˜€…Ý¡¥Ñ•‰½½­ÍU¹­¹½Ý¸¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€]e}AI=Y%I}MQQ}=91%Pœ°(€€€€€€€€€€€€áÑ•É¹…°…¹•±±…Ñ¥½¸•Ù¥‘•¹”¥Ì…•ÁÑ•½¹±ä™½Èµ…¹Õ…°É•½É‘Ì½È…¸Õ¹É•Í½±Ù•]¡¥Ñ•‰½½­Ì…¹•±±…Ñ¥½¸¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€…Ý…¥ÐÑá€(€€€€€€€€€ÕÁ‘…Ñ”•Ý…å}‰¥±±Ì(€€€€€€€€€Í•ÐÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ô€…¹•±±•œ°(€€€€€€€€€€€€€ÁÉ½Ù¥‘•É}…¹•±±•‘}…Ð€ô€‘í‰½‘ä¹…¹•±±•‘Ñô°(€€€€€€€€€€€€€ÁÉ½Ù¥‘•É}…¹•±±•‘}…Ñ}Ñ•áÐ€ô€‘í‰½‘ä¹…¹•±±•‘ÑQ•áÐ¹ÑÉ¥´ ¥ô°(€€€€€€€€€€€€€ÁÉ½Ù¥‘•É}…¹•±}É•…Í½¹}½‘”€ô€‘í‰½‘ä¹É•…Í½¹½‘•ô°(€€€€€€€€€€€€€ÁÉ½Ù¥‘•É}…¹•±}É•µ…É¬€ô€‘íÉ•µ…É­ô(€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€ì(€€€€€€€…Ý…¥Ð…Õ‘¥ÑÝ…å	¥±° (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€•Ý…å}‰¥±°¹•áÑ•É¹…±}…¹•±±…Ñ¥½¹}É•½É‘•œ°(€€€€€€€€€¥°(€€€€€€€€€ì(€€€€€€€€€€€•Ý‰9Õµ‰•ÈèÉ½Ü¹•Ý‰}¹Õµ‰•È°(€€€€€€€€€€€…¹•±±•‘Ðè‰½‘ä¹…¹•±±•‘Ð°(€€€€€€€€€€€•Ù¥‘•¹”è€µ…¹Õ…±}Õ¹Ù•É¥™¥•œ°(€€€€€€€€€€€É•½¹¥±•‘AÉ½Ù¥‘•ÉU¹­¹½Ý¸èÝ¡¥Ñ•‰½½­ÍU¹­¹½Ý¸°(€€€€€€€€€ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸ì•Ý…å	¥±°èÑ½Ý…å	¥±°¡…Ý…¥ÐÉ•…‘Ý…å	¥±°¡Ñà°¥¤¤ôì(€€€€€ô¤ì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½•Ý…äµ‰¥±±Ì¼é¥½…¹•°µÁÉ½Ù¥‘•Èœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äè…¹•±MÑ…ÑÕÑ½Éå½Õµ•¹ÑI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì(€€€€€€€€€€ÈÀÀèÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°(€€€€€€€€€€ÈÀÈèÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°(€€€€€€€€€€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ì°(€€€€€€€ô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ°É•Á±ä¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…Ì…¹•±MÑ…ÑÕÑ½Éå½Õµ•¹ÑI•ÅÕ•ÍÐì(€€€€€½¹ÍÐÉ•µ…É¬€ô‰½‘ä¹É•µ…É¬¹ÑÉ¥´ ¤ì(€€€€€½¹ÍÐÁÉ•Á…É•€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•ÕÑ¡½É¥Ñä¡Ñà°ÕÍ•È¹¥°€…¹•°œ¤ì(€€€€€€€€€½¹ÍÐÉ•½Ù•É•‘=Á•É…Ñ¥½¹Ì€ô…Ý…¥ÐÉ•½Ù•ÉMÑ…±•MÑ…ÑÕÑ½Éå=Á•É…Ñ¥½¸¡Ñà°ì(€€€€€€€€€€€•Ý…å	¥±±%è¥°(€€€€€€€€€ô¤ì(€€€€€€€€€½¹ÍÐÉ½Ü€ô…Ý…¥Ð±½­Ý…å	¥±°¡Ñà°¥¤ì(€€€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°É½Ü¹Ý½É­}¥¤ì(€€€€€€€€€¥˜€¡ÁÉ½Ù¥‘•È€ôôôÕ¹‘•™¥¹•¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€MQQUQ=Ie}AI=Y%I}9=Q}=9%UIœ°(€€€€€€€€€€€€€€]¡¥Ñ•‰½½­ÌÑÉ…¹ÍÁ½ÉÐ¥Ì¹½Ð½¹™¥ÕÉ•¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€É•ÅÕ¥É•MÑ…ÑÕÌ¡É½Ü°€•¹•É…Ñ•œ¤ì(€€€€€€€€€¥˜€ (€€€€€€€€€€€É½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ôôô€…¹•±±…Ñ¥½¹}Õ¹­¹½Ý¸œ€˜˜(€€€€€€€€€€€É•½Ù•É•‘=Á•É…Ñ¥½¹Ì¹¥¹±Õ‘•Ì …¹•±}•Ý…å}‰¥±°œ¤(€€€€€€€€€€¤ì(€€€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€€€€€É•½Ù•É•èÑÉÕ”…Ì½¹ÍÐ°(€€€€€€€€€€€€€‘•Ñ…¥°èì•Ý…å	¥±°èÑ½Ý…å	¥±°¡…Ý…¥ÐÉ•…‘Ý…å	¥±°¡Ñà°¥¤¤ô°(€€€€€€€€€€€ôì(€€€€€€€€€ô(€€€€€€€€€¥˜€ (€€€€€€€€€€€É½Ü¹ÁÉ½Ù¥‘•È€„ôô€Ý¡¥Ñ•‰½½­Ìœñð(€€€€€€€€€€€É½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€„ôô€•¹•É…Ñ•œñð(€€€€€€€€€€€É½Ü¹•Ý‰}¹Õµ‰•È€ôôô¹Õ±°(€€€€€€€€€€¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€]e}AI=Y%I}MQQ}=91%Pœ°(€€€€€€€€€€€€€É½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ôôô€…¹•±±…Ñ¥½¹}Õ¹­¹½Ý¸œ(€€€€€€€€€€€€€€€€ü€Q¡”•…É±¥•È…¹•±±…Ñ¥½¸É•ÍÕ±Ð¥ÌÕ¹­¹½Ý¸…¹…¹¹½Ð‰”Í•¹Ð……¥¸‰±¥¹‘±ä¸I•½¹¥±”Ý¥Ñ ]¡¥Ñ•‰½½­Ì½9%ÍÕÁÁ½ÉÐ¸œ(€€€€€€€€€€€€€€€€è€=¹±ä„]¡¥Ñ•‰½½­Ìµ•¹•É…Ñ•…Ñ¥Ù””µÝ…ä‰¥±°…¸ÕÍ”ÁÉ½Ù¥‘•È…¹•±±…Ñ¥½¸¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€½¹ÍÐm¥¹Ù½¥•t€ô…Ý…¥ÐÑàñì¥ÍÍÕ•‘}Í¹…ÁÍ¡½ÐèÕ¹­¹½Ý¸õmtù€(€€€€€€€€€€€Í•±•Ð¥ÍÍÕ•‘}Í¹…ÁÍ¡½Ð™É½´Ñ…á}¥¹Ù½¥•Ì(€€€€€€€€€€€Ý¡•É”¥€ô€‘íÉ½Ü¹Ñ…á}¥¹Ù½¥•}¥‘ô(€€€€€€€€€€ì(€€€€€€€€€¥˜€ …¥¹Ù½¥”¤Ñ¡É½Ü¹•ÜÉÉ½È¡”µÝ…ä‰¥±°€‘í¥‘ô±½ÍÐ¥ÑÌ¥¹Ù½¥•€¤ì(€€€€€€€€€½¹ÍÐÍÑ¥¸€ôÁ…ÉÍ•Q…á%¹Ù½¥•%ÍÍÕ•‘M¹…ÁÍ¡½Ð (€€€€€€€€€€€Á…ÉÍ•)Í½¹‰½±Õµ¸¡¥¹Ù½¥”¹¥ÍÍÕ•‘}Í¹…ÁÍ¡½Ð¤°(€€€€€€€€€€¤¹ÍÕÁÁ±¥•È¹ÍÑ¥¸ì(€€€€€€€€€½¹ÍÐÉ•ÅÕ•ÍÑ)Í½¸€ôÍÑÉ¥¹¥™åMÑ…ÑÕÑ½Éå)Í½¸¡ì(€€€€€€€€€€€•Ý‰9¼è•á…Ñ)Í½¹%¹Ñ••È¡É½Ü¹•Ý‰}¹Õµ‰•È¤°(€€€€€€€€€€€…¹•±IÍ¹½‘”è•á…Ñ)Í½¹%¹Ñ••È¡‰½‘ä¹É•…Í½¹½‘”¤°(€€€€€€€€€€€…¹•±IµÉ¬èÉ•µ…É¬°(€€€€€€€€€ô¤ì(€€€€€€€€€½¹ÍÐ½Á•É…Ñ¥½¹%€ô…Ý…¥ÐÍÑ…ÉÑMÑ…ÑÕÑ½Éå=Á•É…Ñ¥½¸¡Ñà°ì(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€ÕÍ•É%èÕÍ•È¹¥°(€€€€€€€€€€€ÁÉ½Ù¥‘•È°(€€€€€€€€€€€½Á•É…Ñ¥½¸è€…¹•±}•Ý…å}‰¥±°œ°(€€€€€€€€€€€É•ÅÕ•ÍÑM¡„ÈÔØèÍ¡„ÈÔÙ!•à¡É•ÅÕ•ÍÑ)Í½¸¤°(€€€€€€€€€€€•Ý…å	¥±±%è¥°(€€€€€€€€€ô¤ì(€€€€€€€€€…Ý…¥ÐÑá€(€€€€€€€€€€€ÕÁ‘…Ñ”•Ý…å}‰¥±±ÌÍ•ÐÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ô€…¹•±±¥¹œœ(€€€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€€ì(€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€€€É•½Ù•É•è™…±Í”…Ì½¹ÍÐ°(€€€€€€€€€€€½Á•É…Ñ¥½¹%°(€€€€€€€€€€€•Ý‰9Õµ‰•ÈèÉ½Ü¹•Ý‰}¹Õµ‰•È°(€€€€€€€€€€€ÍÑ¥¸°(€€€€€€€€€€€ÁÉ½Ù¥‘•È°(€€€€€€€€€ôì(€€€€€€€ô°(€€€€€€¤ì((€€€€€¥˜€¡ÁÉ•Á…É•¹É•½Ù•É•¤ì(€€€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÈ¤¹Í•¹¡ÁÉ•Á…É•¹‘•Ñ…¥°¤ì(€€€€€ô((€€€€€±•Ð…¹•±±•è(€€€€€€€ðìÉ•…‘½¹±ä…¹•±±•‘ÑQ•áÐèÍÑÉ¥¹œìÉ•…‘½¹±ä…¹•±±•‘ÐèÍÑÉ¥¹œô(€€€€€€€ð¹Õ±°€ô¹Õ±°ì(€€€€€±•Ð™…¥±ÕÉ”èI•ÑÕÉ¹QåÁ”ñÑåÁ•½˜ÁÉ½Ù¥‘•É…¥±ÕÉ”øð¹Õ±°€ô¹Õ±°ì(€€€€€ÑÉäì(€€€€€€€…¹•±±•€ô…Ý…¥ÐÁÉ•Á…É•¹ÁÉ½Ù¥‘•È¹…¹•±Ý…å	¥±°¡ì(€€€€€€€€€ÍÑ¥¸èÁÉ•Á…É•¹ÍÑ¥¸°(€€€€€€€€€•Ý‰9Õµ‰•ÈèÁÉ•Á…É•¹•Ý‰9Õµ‰•È°(€€€€€€€€€É•…Í½¹½‘”è‰½‘ä¹É•…Í½¹½‘”°(€€€€€€€€€É•µ…É¬°(€€€€€€€ô¤ì(€€€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€€€™…¥±ÕÉ”€ôÁÉ½Ù¥‘•É…¥±ÕÉ”¡•ÉÉ½È¤ì(€€€€€ô((€€€€€½¹ÍÐ‘•Ñ…¥°€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•ÕÑ¡½É¥Ñä¡Ñà°ÕÍ•È¹¥°€…¹•°œ¤ì(€€€€€€€€€½¹ÍÐÉ½Ü€ô…Ý…¥Ð±½­Ý…å	¥±°¡Ñà°¥¤ì(€€€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°É½Ü¹Ý½É­}¥¤ì(€€€€€€€€€¥˜€¡É½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€„ôô€…¹•±±¥¹œœ¤ì(€€€€€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È¡”µÝ…ä‰¥±°€‘í¥‘ô±•™ÐÑ¡”…¹•±±¥¹œÍÑ…Ñ•€¤ì(€€€€€€€€€ô(€€€€€€€€€¥˜€¡…¹•±±•€„ôô¹Õ±°¤ì(€€€€€€€€€€€…Ý…¥ÐÑá€(€€€€€€€€€€€€€ÕÁ‘…Ñ”•Ý…å}‰¥±±Ì(€€€€€€€€€€€€€Í•ÐÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ô€…¹•±±•œ°(€€€€€€€€€€€€€€€€€ÁÉ½Ù¥‘•É}…¹•±±•‘}…Ð€ô€‘í…¹•±±•¹…¹•±±•‘Ñô°(€€€€€€€€€€€€€€€€€ÁÉ½Ù¥‘•É}…¹•±±•‘}…Ñ}Ñ•áÐ€ô€‘í…¹•±±•¹…¹•±±•‘ÑQ•áÑô°(€€€€€€€€€€€€€€€€€ÁÉ½Ù¥‘•É}…¹•±}É•…Í½¹}½‘”€ô€‘í‰½‘ä¹É•…Í½¹½‘•ô°(€€€€€€€€€€€€€€€€€ÁÉ½Ù¥‘•É}…¹•±}É•µ…É¬€ô€‘íÉ•µ…É­ô(€€€€€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€€€€ì(€€€€€€€€€€€…Ý…¥Ð™¥¹¥Í¡MÑ…ÑÕÑ½Éå=Á•É…Ñ¥½¸¡Ñà°ÁÉ•Á…É•¹½Á•É…Ñ¥½¹%°ì(€€€€€€€€€€€€€ÍÑ…ÑÕÌè€ÍÕ••‘•œ°(€€€€€€€€€€€ô¤ì(€€€€€€€€€ô•±Í”ì(€€€€€€€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô™…¥±ÕÉ”€üüì(€€€€€€€€€€€€€ÍÑ…ÑÕÌè€Õ¹­¹½Ý¸œ…Ì½¹ÍÐ°(€€€€€€€€€€€€€ÁÉ½Ù¥‘•É½‘”è¹Õ±°°(€€€€€€€€€€€€€¡ÑÑÁMÑ…ÑÕÌè¹Õ±°°(€€€€€€€€€€€ôì(€€€€€€€€€€€…Ý…¥ÐÑá€(€€€€€€€€€€€€€ÕÁ‘…Ñ”•Ý…å}‰¥±±Ì(€€€€€€€€€€€€€Í•ÐÁÉ½Ù¥‘•É}ÍÑ…Ñ”€ô€‘íÉ•ÍÕ±Ð¹ÍÑ…ÑÕÌ€ôôô€™…¥±•œ(€€€€€€€€€€€€€€€€ü€•¹•É…Ñ•œ(€€€€€€€€€€€€€€€€è€…¹•±±…Ñ¥½¹}Õ¹­¹½Ý¸ô(€€€€€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€€€€ì(€€€€€€€€€€€…Ý…¥Ð™¥¹¥Í¡MÑ…ÑÕÑ½Éå=Á•É…Ñ¥½¸¡Ñà°ÁÉ•Á…É•¹½Á•É…Ñ¥½¹%°ì(€€€€€€€€€€€€€ÍÑ…ÑÕÌèÉ•ÍÕ±Ð¹ÍÑ…ÑÕÌ°(€€€€€€€€€€€€€ÁÉ½Ù¥‘•É½‘”èÉ•ÍÕ±Ð¹ÁÉ½Ù¥‘•É½‘”°(€€€€€€€€€€€€€¡ÑÑÁMÑ…ÑÕÌèÉ•ÍÕ±Ð¹¡ÑÑÁMÑ…ÑÕÌ°(€€€€€€€€€€€ô¤ì(€€€€€€€€€ô(€€€€€€€€€…Ý…¥Ð…Õ‘¥ÑÝ…å	¥±° (€€€€€€€€€€€Ñà°(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€€…¹•±±•€ôôô¹Õ±°(€€€€€€€€€€€€€€ü€•Ý…å}‰¥±°¹ÁÉ½Ù¥‘•É}…¹•±±…Ñ¥½¹}Õ¹É•Í½±Ù•œ(€€€€€€€€€€€€€€è€•Ý…å}‰¥±°¹ÁÉ½Ù¥‘•É}…¹•±±•œ°(€€€€€€€€€€€¥°(€€€€€€€€€€€ì(€€€€€€€€€€€€€•Ý‰9Õµ‰•ÈèÁÉ•Á…É•¹•Ý‰9Õµ‰•È°(€€€€€€€€€€€€€½ÕÑ½µ”è…¹•±±•€ôôô¹Õ±°€ü€¡™…¥±ÕÉ”ü¹ÍÑ…ÑÕÌ€üü€Õ¹­¹½Ý¸œ¤€è€ÍÕ••‘•œ°(€€€€€€€€€€€€€ÁÉ½Ù¥‘•ÈèÁÉ•Á…É•¹ÁÉ½Ù¥‘•È¹¹…µ”°(€€€€€€€€€€€€€½Á•É…Ñ¥½¹%èÁÉ•Á…É•¹½Á•É…Ñ¥½¹%°(€€€€€€€€€€€ô°(€€€€€€€€€€¤ì(€€€€€€€€€É•ÑÕÉ¸ì•Ý…å	¥±°èÑ½Ý…å	¥±°¡…Ý…¥ÐÉ•…‘Ý…å	¥±°¡Ñà°¥¤¤ôì(€€€€€€€ô°(€€€€€€¤ì(€€€€€¥˜€¡…¹•±±•€„ôô¹Õ±°¤É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÀ¤¹Í•¹¡‘•Ñ…¥°¤ì(€€€€€¥˜€¡™…¥±ÕÉ”ü¹ÍÑ…ÑÕÌ€ôôô€™…¥±•œ¤ì(€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€ÔÀÈ°(€€€€€€€€€™…¥±ÕÉ”¹ÁÕ‰±¥½‘”°(€€€€€€€€€€]¡¥Ñ•‰½½­ÌÉ•©•Ñ•”µÝ…ä‰¥±°…¹•±±…Ñ¥½¸¸Q¡”ÁÉ½Ù¥‘•È‘½Õµ•¹ÐÉ•µ…¥¹Ì…Ñ¥Ù”¸œ°(€€€€€€€€¤ì(€€€€€ô(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÈ¤¹Í•¹¡‘•Ñ…¥°¤ì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½•Ý…äµ‰¥±±Ì¼é¥½…¹•°œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äè…¹•±Ý…å	¥±±I•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…Ì…¹•±Ý…å	¥±±I•ÅÕ•ÍÐì(€€€€€½¹ÍÐ¹½Ñ”€ô…¹•±±…Ñ¥½¹9½Ñ”¡‰½‘ä¹¹½Ñ”¤ì(€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•ÕÑ¡½É¥Ñä¡Ñà°ÕÍ•È¹¥°€…¹•°œ¤ì(€€€€€€€½¹ÍÐÉ½Ü€ô…Ý…¥Ð±½­Ý…å	¥±°¡Ñà°¥¤ì(€€€€€€€…Ý…¥Ð…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°É½Ü¹Ý½É­}¥¤ì(€€€€€€€¥˜€¡É½Ü¹ÍÑ…ÑÕÌ€ôôô€‘É…™Ðœ¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€]e}	%11}MQQUM}=91%Pœ°(€€€€€€€€€€€€É…™Ð”µÝ…ä‰¥±±Ì…É”‘•±•Ñ•°¹½Ð…¹•±±•¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€É•ÅÕ¥É•MÑ…ÑÕÌ¡É½Ü°€•¹•É…Ñ•œ¤ì(€€€€€€€¥˜€¡É½Ü¹ÁÉ½Ù¥‘•È€„ôô¹Õ±°€˜˜É½Ü¹ÁÉ½Ù¥‘•É}ÍÑ…Ñ”€„ôô€…¹•±±•œ¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€]e}AI=Y%I}911Q%=9}IEU%Iœ°(€€€€€€€€€€€€I•½É½¹™¥Éµ••áÑ•É¹…°…¹•±±…Ñ¥½¸‰•™½É”…¹•±±¥¹œÑ¡¥Ì±½…°µÝ…ä	¥±°É•½É¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€€¼¼…¹•±±…Ñ¥½¸¹•Ù•È•É…Í•Ì…¸½™™¥¥…°]¹Õµ‰•È°‘…Ñ”°Ù…±¥‘¥Ñä°(€€€€€€€€¼¼•¹•É…Ñ¥½¸…Ñ½È°½È•Ù¥‘•¹”¸5…¹Õ…°…¹•±±…Ñ¥½¸É•µ…¥¹Ì(€€€€€€€€¼¼•áÁ±¥¥Ñ±äÕ¹É•Í½±Ù•…ÐÑ¡”ÁÉ½Ù¥‘•È‰½Õ¹‘…Éä¸(€€€€€€€…Ý…¥ÐÑá€(€€€€€€€€€ÕÁ‘…Ñ”•Ý…å}‰¥±±Ì(€€€€€€€€€Í•ÐÍÑ…ÑÕÌ€ô€…¹•±±•œ°(€€€€€€€€€€€€€…¹•±±•‘}‰å}ÕÍ•É}¥€ô€‘íÕÍ•È¹¥‘ô°…¹•±±•‘}…Ð€ô¹½Ü ¤°(€€€€€€€€€€€€€…¹•±±…Ñ¥½¹}¹½Ñ”€ô€‘í¹½Ñ•ô(€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€ì(€€€€€€€…Ý…¥Ð…Õ‘¥ÑÝ…å	¥±°¡Ñà°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°€•Ý…å}‰¥±°¹…¹•±±•œ°¥°ì(€€€€€€€€€•Ý‰9Õµ‰•ÈèÉ½Ü¹•Ý‰}¹Õµ‰•È°(€€€€€€€€€Ñ…á%¹Ù½¥•%èÉ½Ü¹Ñ…á}¥¹Ù½¥•}¥°(€€€€€€€€€¹½Ñ”°(€€€€€€€ô¤ì(€€€€€€€É•ÑÕÉ¸ì•Ý…å	¥±°èÑ½Ý…å	¥±°¡…Ý…¥ÐÉ•…‘Ý…å	¥±°¡Ñà°¥¤¤ôì(€€€€€ô¤ì(€€€ô°(€€¤ì)ô