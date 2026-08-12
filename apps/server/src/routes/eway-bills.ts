import {
  CancelStatutoryDocumentRequestSchema,
  CancelEwayBillRequestSchema,
  EwayBillDetailResponseSchema,
  EwayBillListResponseSchema,
  RecordManualStatutoryCancellationRequestSchema,
  RecordEwayNicResponseRequestSchema,
  SaveEwayBillRequestSchema,
  type EwayBill,
  type EwayProviderState,
  type EwayBillStatus,
  type SaveEwayBillRequest,
  type TransportMode,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
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
import { exactJsonInteger, stringifyStatutoryJson } from '../gsp/statutory-json.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import {
  parseTaxInvoiceIssuedSnapshot,
  TaxInvoiceSnapshotError,
} from '../tax-invoice-snapshot.js';
import { cancellationNote } from './challans.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

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

// --- Routes -----------------------------------------------------------------

export function registerEwayBillRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  provider?: StatutoryProvider,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/tax-invoices/:id/eway-bills',
      schema: {
        params: IdParamsSchema,
        response: { 200: EwayBillListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: invoiceId } = request.params;
      const rows = await tenant(async (tx) => {
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
      });
      return { ewayBills: rows.map(toEwayBill) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/eway-bills',
      schema: {
        params: IdParamsSchema,
        body: SaveEwayBillRequestSchema,
        response: { 201: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: invoiceId } = request.params;
      const body = normalisedSave(request.body);
      const detail = await tenant(async (tx) => {
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
        await audit(
          tx,
          organisationId,
          user.id,
          'eway_bill.created',
          'eway_bills',
          created.id,
          {
            taxInvoiceId: invoiceId,
            invoiceNumber: invoice.invoice_number,
            transportMode: body.transportMode,
            distanceKm: body.distanceKm,
          },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, created.id)) };
      }).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'EWAY_BILL_EXISTS', () =>
          tenant(async (tx) => {
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

  tenantRoute(
    {
      method: 'GET',
      url: '/api/eway-bills/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const row = await readEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        return { ewayBill: toEwayBill(row) };
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/eway-bills/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveEwayBillRequestSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = normalisedSave(request.body);
      return tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        // A generated e-way bill is NIC's record: no edits, ever. Vehicle
        // updates and extensions are their own NIC transactions and out
        // of scope here.
        requireStatus(row, 'draft');
        if (
          row.provider_state !== 'not_requested' &&
          row.provider_state !== 'generation_failed'
        ) {
          throw httpError(
            409,
            'EWAY_PROVIDER_STATE_CONFLICT',
            'Carriage facts are frozen while a provider operation is in progress or its result is unknown.',
          );
        }
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
        await audit(
          tx,
          organisationId,
          user.id,
          'eway_bill.updated',
          'eway_bills',
          id,
          {
            before: changes.before,
            after: changes.after,
          },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/eway-bills/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        // Rule 8: a draft is not yet a document, so it deletes; a
        // generated e-way bill cancels and keeps its number forever.
        requireStatus(row, 'draft');
        if (row.provider !== null || row.provider_state !== 'not_requested') {
          throw httpError(
            409,
            'EWAY_PROVIDER_HISTORY_EXISTS',
            'This draft has provider-operation history and cannot be deleted. Reconcile it instead.',
          );
        }
        await tx`delete from eway_bills where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'eway_bill.deleted',
          'eway_bills',
          id,
          {
            taxInvoiceId: row.tax_invoice_id,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/eway-bills/:id/recover-provider-operation',
      schema: {
        params: IdParamsSchema,
        response: { 202: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.provider_state === 'generating') {
          await requireAuthority(tx, user.id, 'issue');
        } else if (row.provider_state === 'cancelling') {
          await requireAuthority(tx, user.id, 'cancel');
        } else {
          throw httpError(
            409,
            'EWAY_PROVIDER_STATE_CONFLICT',
            'Only an in-progress E-way Bill provider operation can be checked for stale recovery.',
          );
        }
        const recovered = await recoverStaleStatutoryOperation(tx, {
          ewayBillId: id,
        });
        if (recovered.length === 0) {
          throw httpError(
            409,
            'STATUTORY_OPERATION_IN_PROGRESS',
            'The provider operation is still within its two-minute lease.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'eway_bill.provider_operation_recovered',
          'eway_bills',
          id,
          { operations: recovered },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
      return reply.status(202).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/eway-bills/:id/generate',
      schema: {
        params: IdParamsSchema,
        response: {
          200: EwayBillDetailResponseSchema,
          202: EwayBillDetailResponseSchema,
          ...errorResponses,
        },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;

      const prepared = await tenant(async (tx) => {
        await recoverStaleStatutoryOperation(tx, { ewayBillId: id });
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        requireStatus(row, 'draft');
        if (row.provider_state === 'generating') {
          throw httpError(
            409,
            'STATUTORY_OPERATION_IN_PROGRESS',
            'An e-way bill provider operation is already in progress.',
          );
        }
        if (
          row.provider_state === 'cancelling' ||
          row.provider_state === 'cancelled' ||
          row.provider_state === 'cancellation_unknown'
        ) {
          throw httpError(
            409,
            'EWAY_PROVIDER_STATE_CONFLICT',
            `E-way bill generation cannot start from ${row.provider_state}.`,
          );
        }
        const reconcileOnly = row.provider_state === 'generation_unknown';
        if (!reconcileOnly) {
          throw httpError(
            409,
            'EWAY_BILL_NOT_APPLICABLE_TO_SERVICE_INVOICE',
            'This cumulative tax invoice contains a SAC service line. Fresh E-way Bill generation is disabled until a goods/HSN delivery-challan model supplies the legally required item facts.',
          );
        }
        if (provider === undefined) {
          throw httpError(
            409,
            'STATUTORY_PROVIDER_NOT_CONFIGURED',
            'Whitebooks transport is not configured.',
          );
        }
        const [priorEwayBill] = await tx<{ id: string }[]>`
            select id from eway_bills
            where tax_invoice_id = ${row.tax_invoice_id} and id <> ${id}
            limit 1
          `;
        if (priorEwayBill) {
          throw httpError(
            409,
            'EWAY_REGENERATION_RECONCILIATION_UNSUPPORTED',
            'This IRN already has earlier local EWB history. Automatic regeneration is disabled because an IRN-only lookup could attach old or cancelled provider evidence.',
          );
        }
        const [invoice] = await tx<
          {
            status: string;
            irn: string | null;
            irp_provider: string | null;
            irp_provider_state: string;
            issued_snapshot: unknown;
          }[]
        >`
            select status, irn, irp_provider, irp_provider_state,
                   issued_snapshot
            from tax_invoices where id = ${row.tax_invoice_id}
          `;
        if (!invoice) throw new Error(`e-way bill ${id} lost its invoice`);
        if (
          invoice.status !== 'submitted' ||
          invoice.irn === null ||
          invoice.irp_provider !== 'whitebooks' ||
          invoice.irp_provider_state !== 'registered'
        ) {
          throw httpError(
            409,
            'EWAY_IRP_REGISTRATION_REQUIRED',
            'Generate an e-way bill through Whitebooks only after this invoice has a provider-verified, active IRN.',
          );
        }
        const issued = parseJsonbColumn(invoice.issued_snapshot);
        let snapshot: ReturnType<typeof parseTaxInvoiceIssuedSnapshot>;
        try {
          snapshot = parseTaxInvoiceIssuedSnapshot(issued);
        } catch (error) {
          if (error instanceof TaxInvoiceSnapshotError) {
            throw httpError(409, error.code, error.message);
          }
          throw error;
        }
        const requestSha256 = sha256Hex(stringifyStatutoryJson({ Irn: invoice.irn }));
        const operationId = await startStatutoryOperation(tx, {
          organisationId,
          userId: user.id,
          provider,
          operation: 'reconcile_eway_bill',
          requestSha256,
          ewayBillId: id,
        });
        await tx`
            update eway_bills
            set provider = 'whitebooks', provider_state = 'generating'
            where id = ${id}
          `;
        return {
          operationId,
          gstin: snapshot.supplier.gstin,
          irn: invoice.irn,
          provider,
        };
      });

      let evidence: EwayBillProviderEvidence | null = null;
      let failure: ReturnType<typeof providerFailure> | null = null;
      try {
        evidence = await prepared.provider.findEwayBillByIrn({
          gstin: prepared.gstin,
          irn: prepared.irn,
        });
        if (evidence === null) {
          failure = {
            status: 'unknown',
            providerCode: null,
            httpStatus: null,
            publicCode: 'WHITEBOOKS_EWB_NOT_FOUND',
          };
        }
      } catch (error) {
        const lookupFailure = providerFailure(error);
        failure = { ...lookupFailure, status: 'unknown' };
      }

      const detail = await tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.status !== 'draft' || row.provider_state !== 'generating') {
          throw new Error(`e-way bill ${id} left the generating state`);
        }
        if (evidence !== null) {
          await tx`
              update eway_bills
              set status = 'generated', provider = 'whitebooks',
                  provider_state = 'generated',
                  ewb_number = ${evidence.ewbNumber},
                  ewb_date = ${evidence.ewbDate},
                  valid_until = ${evidence.validUntil},
                  ewb_date_text = ${evidence.ewbDateText},
                  valid_until_text = ${evidence.validUntilText},
                  legacy_evidence_missing = false,
                  generated_by_user_id = ${user.id}, generated_at = now()
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: 'succeeded',
          });
          await audit(
            tx,
            organisationId,
            user.id,
            'eway_bill.provider_generated',
            'eway_bills',
            id,
            {
              taxInvoiceId: row.tax_invoice_id,
              ewbNumber: evidence.ewbNumber,
              provider: prepared.provider.name,
              operationId: prepared.operationId,
            },
          );
        } else {
          const result = failure ?? {
            status: 'unknown' as const,
            providerCode: null,
            httpStatus: null,
          };
          await tx`
              update eway_bills
              set provider = 'whitebooks',
                  provider_state = ${
                    result.status === 'failed'
                      ? 'generation_failed'
                      : 'generation_unknown'
                  }
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: result.status,
            providerCode: result.providerCode,
            httpStatus: result.httpStatus,
          });
          await audit(
            tx,
            organisationId,
            user.id,
            'eway_bill.provider_generation_unresolved',
            'eway_bills',
            id,
            {
              taxInvoiceId: row.tax_invoice_id,
              outcome: result.status,
              providerCode: result.providerCode,
              provider: prepared.provider.name,
              operationId: prepared.operationId,
            },
          );
        }
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });

      if (evidence !== null) return reply.status(200).send(detail);
      const result = failure ?? {
        status: 'unknown' as const,
        publicCode: 'STATUTORY_PROVIDER_UNKNOWN',
      };
      if (result.status === 'failed') {
        throw httpError(
          502,
          result.publicCode,
          'Whitebooks rejected e-way bill generation. The draft remains editable and no EWB number was invented.',
        );
      }
      return reply.status(202).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/eway-bills/:id/nic-payload',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const payloadJson = await tenant(async (tx) => {
        const row = await readEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        throw httpError(
          409,
          'EWAY_BILL_NOT_APPLICABLE_TO_SERVICE_INVOICE',
          'This cumulative tax invoice contains a SAC service line. No E-way Bill payload is exposed until goods/HSN delivery facts exist.',
        );
      });
      void reply.type('application/json; charset=utf-8');
      return reply.send(payloadJson);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/eway-bills/:id/nic-response',
      schema: {
        params: IdParamsSchema,
        body: RecordEwayNicResponseRequestSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // Compatibility import only. Manually typed evidence is explicitly
        // unverified and requires issue authority.
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (provider !== undefined) {
          throw httpError(
            409,
            'MANUAL_PROVIDER_EVIDENCE_DISABLED',
            'Manual NIC evidence entry is disabled while Whitebooks transport is configured.',
          );
        }
        requireStatus(row, 'draft');
        if (row.provider !== null || row.provider_state !== 'not_requested') {
          throw httpError(
            409,
            'MANUAL_PROVIDER_EVIDENCE_CONFLICT',
            'Manual NIC evidence cannot replace or complete an existing provider attempt.',
          );
        }
        // Friendly form of the 0035 carriage CHECK; the catch below is
        // its backstop for any shape this misses.
        assertCarriageComplete(row);
        await tx`
          update eway_bills
          set status = 'generated', ewb_number = ${body.ewbNumber},
              ewb_date = ${body.ewbDate}, valid_until = ${body.validUntil},
              ewb_date_text = ${body.ewbDateText.trim()},
              valid_until_text = ${body.validUntilText.trim()},
              provider = 'manual', provider_state = 'generated',
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
        await audit(
          tx,
          organisationId,
          user.id,
          'eway_bill.generated',
          'eway_bills',
          id,
          {
            taxInvoiceId: row.tax_invoice_id,
            invoiceNumber: row.invoice_number,
            ewbNumber: body.ewbNumber,
            ewbDate: body.ewbDate,
            validUntil: body.validUntil,
            evidence: 'manual_unverified',
          },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/eway-bills/:id/manual-cancel-response',
      schema: {
        params: IdParamsSchema,
        body: RecordManualStatutoryCancellationRequestSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const remark = body.remark.trim();
      return tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.status !== 'generated' && row.status !== 'cancelled') {
          throw httpError(
            409,
            'EWAY_BILL_STATUS_CONFLICT',
            'Only an issued E-way Bill can receive external cancellation evidence.',
          );
        }
        const manualActive =
          row.provider === 'manual' &&
          (row.provider_state === 'generated' ||
            row.provider_state === 'cancellation_unknown');
        const whitebooksUnknown =
          row.provider === 'whitebooks' &&
          row.provider_state === 'cancellation_unknown';
        if (!manualActive && !whitebooksUnknown) {
          throw httpError(
            409,
            'EWAY_PROVIDER_STATE_CONFLICT',
            'External cancellation evidence is accepted only for manual records or an unresolved Whitebooks cancellation.',
          );
        }
        await tx`
          update eway_bills
          set provider_state = 'cancelled',
              provider_cancelled_at = ${body.cancelledAt},
              provider_cancelled_at_text = ${body.cancelledAtText.trim()},
              provider_cancel_reason_code = ${body.reasonCode},
              provider_cancel_remark = ${remark}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'eway_bill.external_cancellation_recorded',
          'eway_bills',
          id,
          {
            ewbNumber: row.ewb_number,
            cancelledAt: body.cancelledAt,
            evidence: 'manual_unverified',
            reconciledProviderUnknown: whitebooksUnknown,
          },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/eway-bills/:id/cancel-provider',
      schema: {
        params: IdParamsSchema,
        body: CancelStatutoryDocumentRequestSchema,
        response: {
          200: EwayBillDetailResponseSchema,
          202: EwayBillDetailResponseSchema,
          ...errorResponses,
        },
      },
      authority: 'cancel',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const remark = body.remark.trim();
      const prepared = await tenant(async (tx) => {
        const recoveredOperations = await recoverStaleStatutoryOperation(tx, {
          ewayBillId: id,
        });
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (provider === undefined) {
          throw httpError(
            409,
            'STATUTORY_PROVIDER_NOT_CONFIGURED',
            'Whitebooks transport is not configured.',
          );
        }
        requireStatus(row, 'generated');
        if (
          row.provider_state === 'cancellation_unknown' &&
          recoveredOperations.includes('cancel_eway_bill')
        ) {
          return {
            recovered: true as const,
            detail: { ewayBill: toEwayBill(await readEwayBill(tx, id)) },
          };
        }
        if (
          row.provider !== 'whitebooks' ||
          row.provider_state !== 'generated' ||
          row.ewb_number === null
        ) {
          throw httpError(
            409,
            'EWAY_PROVIDER_STATE_CONFLICT',
            row.provider_state === 'cancellation_unknown'
              ? 'The earlier cancellation result is unknown and cannot be sent again blindly. Reconcile with Whitebooks/NIC support.'
              : 'Only a Whitebooks-generated active e-way bill can use provider cancellation.',
          );
        }
        const [invoice] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from tax_invoices
            where id = ${row.tax_invoice_id}
          `;
        if (!invoice) throw new Error(`e-way bill ${id} lost its invoice`);
        const gstin = parseTaxInvoiceIssuedSnapshot(
          parseJsonbColumn(invoice.issued_snapshot),
        ).supplier.gstin;
        const requestJson = stringifyStatutoryJson({
          ewbNo: exactJsonInteger(row.ewb_number),
          cancelRsnCode: exactJsonInteger(body.reasonCode),
          cancelRmrk: remark,
        });
        const operationId = await startStatutoryOperation(tx, {
          organisationId,
          userId: user.id,
          provider,
          operation: 'cancel_eway_bill',
          requestSha256: sha256Hex(requestJson),
          ewayBillId: id,
        });
        await tx`
            update eway_bills set provider_state = 'cancelling'
            where id = ${id}
          `;
        return {
          recovered: false as const,
          operationId,
          ewbNumber: row.ewb_number,
          gstin,
          provider,
        };
      });

      if (prepared.recovered) {
        return reply.status(202).send(prepared.detail);
      }

      let cancelled: {
        readonly cancelledAtText: string;
        readonly cancelledAt: string;
      } | null = null;
      let failure: ReturnType<typeof providerFailure> | null = null;
      try {
        cancelled = await prepared.provider.cancelEwayBill({
          gstin: prepared.gstin,
          ewbNumber: prepared.ewbNumber,
          reasonCode: body.reasonCode,
          remark,
        });
      } catch (error) {
        failure = providerFailure(error);
      }

      const detail = await tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.provider_state !== 'cancelling') {
          throw new Error(`e-way bill ${id} left the cancelling state`);
        }
        if (cancelled !== null) {
          await tx`
              update eway_bills
              set provider_state = 'cancelled',
                  provider_cancelled_at = ${cancelled.cancelledAt},
                  provider_cancelled_at_text = ${cancelled.cancelledAtText},
                  provider_cancel_reason_code = ${body.reasonCode},
                  provider_cancel_remark = ${remark}
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: 'succeeded',
          });
        } else {
          const result = failure ?? {
            status: 'unknown' as const,
            providerCode: null,
            httpStatus: null,
          };
          await tx`
              update eway_bills
              set provider_state = ${
                result.status === 'failed' ? 'generated' : 'cancellation_unknown'
              }
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: result.status,
            providerCode: result.providerCode,
            httpStatus: result.httpStatus,
          });
        }
        await audit(
          tx,
          organisationId,
          user.id,
          cancelled === null
            ? 'eway_bill.provider_cancellation_unresolved'
            : 'eway_bill.provider_cancelled',
          'eway_bills',
          id,
          {
            ewbNumber: prepared.ewbNumber,
            outcome: cancelled === null ? (failure?.status ?? 'unknown') : 'succeeded',
            provider: prepared.provider.name,
            operationId: prepared.operationId,
          },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
      if (cancelled !== null) return reply.status(200).send(detail);
      if (failure?.status === 'failed') {
        throw httpError(
          502,
          failure.publicCode,
          'Whitebooks rejected e-way bill cancellation. The provider document remains active.',
        );
      }
      return reply.status(202).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/eway-bills/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelEwayBillRequestSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const note = cancellationNote(body.note);
      return tenant(async (tx) => {
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
        if (row.provider !== null && row.provider_state !== 'cancelled') {
          throw httpError(
            409,
            'EWAY_PROVIDER_CANCELLATION_REQUIRED',
            'Record confirmed external cancellation before cancelling this local E-way Bill record.',
          );
        }
        // Cancellation never erases an official EWB number, date, validity,
        // generation actor, or evidence. Manual cancellation remains
        // explicitly unresolved at the provider boundary.
        await tx`
          update eway_bills
          set status = 'cancelled',
              cancelled_by_user_id = ${user.id}, cancelled_at = now(),
              cancellation_note = ${note}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'eway_bill.cancelled',
          'eway_bills',
          id,
          {
            ewbNumber: row.ewb_number,
            taxInvoiceId: row.tax_invoice_id,
            note,
          },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );
}
