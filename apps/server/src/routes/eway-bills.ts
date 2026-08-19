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
import { createHash } from 'node:crypto';
import type { ObjectStorage } from '@auto-mb/documents';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import {
  assertWorkAccess as assertScopedWorkAccess,
  requireAuthorities,
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
  assertCarriesGoods,
  assertChallanStatutoryFactsComplete,
  readChallanSourceFacts,
  readInvoiceSourceFacts,
  type EwayBillSourceFacts,
} from '../gsp/eway-source.js';
import {
  buildDirectEwayBillPayload,
  buildEwayBillByIrnPayload,
} from '../gsp/eway-payload.js';
import {
  exactJsonInteger,
  statutoryJsonDisplay,
  stringifyStatutoryJson,
} from '../gsp/statutory-json.js';
import {
  EWAY_BILL_PDF_TEMPLATE_VERSION,
  renderEwayBillHtml,
  type EwayBillRenderEvidence,
} from '../eway-bill-html.js';
import { requireEntitlement } from '../entitlements.js';
import { httpError } from '../http.js';
import { renderPdfViaGotenberg } from '../pdf-render.js';
import { assertStandaloneChallanAccess, cancellationNote } from './challans.js';
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
  tax_invoice_id: string | null;
  delivery_challan_id: string | null;
  invoice_number: string | null;
  challan_number: string | null;
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
  rendered_object_key: string | null;
  rendered_sha256: string | null;
  rendered_version: number | null;
  created_at: Date;
  generated_at: Date | null;
  cancelled_at: Date | null;
}

const EB_COLUMNS = `
  eb.id, eb.tax_invoice_id, eb.delivery_challan_id,
  ti.invoice_number, dc.challan_number, ti.work_id, eb.status,
  eb.transport_mode, eb.transporter_id, eb.transporter_name,
  eb.vehicle_number, eb.transport_doc_number,
  eb.transport_doc_date::text as transport_doc_date, eb.distance_km,
  eb.from_pincode, eb.to_pincode, eb.ewb_number, eb.provider, eb.provider_state,
  eb.ewb_date, eb.valid_until, eb.ewb_date_text, eb.valid_until_text,
  eb.legacy_evidence_missing,
  eb.provider_cancelled_at, eb.provider_cancelled_at_text,
  eb.provider_cancel_reason_code, eb.provider_cancel_remark,
  eb.cancellation_note, eb.rendered_object_key, eb.rendered_sha256,
  eb.rendered_version,
  eb.created_at, eb.generated_at, eb.cancelled_at
`;

/** Both joins are LEFT: exactly one of the two sources is set on any row
 * (the 0076 CHECK), so an inner join on either would hide every bill that
 * names the other. `work_id` therefore comes from the invoice when there
 * is one and is NULL on the challan path, which is exactly right — a
 * standalone challan belongs to no Work, and `assertWorkAccess` treats a
 * null Work as organisation-wide reach. */
const EB_FROM = `
  from eway_bills eb
  left join tax_invoices ti on ti.id = eb.tax_invoice_id
  left join delivery_challans dc on dc.id = eb.delivery_challan_id
`;

function toEwayBill(row: EwayBillRow): EwayBill {
  return {
    id: row.id,
    taxInvoiceId: row.tax_invoice_id,
    deliveryChallanId: row.delivery_challan_id,
    source: row.tax_invoice_id === null ? 'delivery_challan' : 'tax_invoice',
    invoiceNumber: row.invoice_number,
    challanNumber: row.challan_number,
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
    renderedAvailable: row.rendered_object_key !== null,
    renderedVersion: row.rendered_version,
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

/** A standalone challan belongs to no Work, so work scope has nothing to
 * bind through: it is reachable by every member with organisation-wide
 * reach, and by nobody else (the rule 0056's module established, restated
 * here through the same helper the challan routes use). Access is checked
 * before the kind, so a challan a scoped user may not see gets the same
 * 404 whether it is a work challan or a guessed id that names nothing. */
async function assertChallanReadable(
  tx: TransactionSql,
  userId: string,
  challanId: string,
): Promise<void> {
  const [challan] = await tx<{ challan_kind: string }[]>`
    select challan_kind from delivery_challans where id = ${challanId}
  `;
  if (!challan) {
    throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such delivery challan.');
  }
  // Access BEFORE kind, matching the sibling POST at this file. A scoped
  // membership does not reach standalone challans at all, so it 404s here;
  // if the kind check ran first, a scoped user asking about a WORK challan
  // in their org would get 409 CHALLAN_NOT_STANDALONE while a random UUID
  // got 404 — a difference that confirms the work challan exists. With the
  // access check first the unreachable id is always 404, whatever it names.
  await assertStandaloneChallanAccess(tx, userId);
  if (challan.challan_kind !== 'standalone') {
    throw httpError(
      409,
      'CHALLAN_NOT_STANDALONE',
      'An e-way bill is raised from a standalone delivery challan. A work challan moves under the Work it belongs to.',
    );
  }
}

/** Who may see a bill, decided by the source it names.
 *
 * An invoice-sourced bill inherits the invoice's Work scope, which is
 * null for a direct invoice and therefore organisation-wide. A
 * challan-sourced bill has no Work at all: 0056's rule for a document
 * with none is that it is reachable by every member with
 * organisation-wide reach and by nobody else, so a work-scoped user is
 * answered 404 rather than shown a movement they have no scope for. */
async function assertBillAccess(
  tx: TransactionSql,
  userId: string,
  row: EwayBillRow,
): Promise<void> {
  if (row.delivery_challan_id !== null) {
    await assertStandaloneChallanAccess(tx, userId);
    return;
  }
  await assertWorkAccess(tx, userId, row.work_id);
}

/** The evidence and carriage a printable summary states, taken from the
 * bill row. Used twice — once to render, once to prove nothing moved
 * while the renderer ran — so it exists as one function rather than two
 * hand-kept object literals. */
function renderInputs(
  row: EwayBillRow,
  ewbNumber: string,
): {
  evidence: EwayBillRenderEvidence;
  carriage: {
    transportMode: string;
    transporterId: string | null;
    transporterName: string | null;
    vehicleNumber: string | null;
    transportDocNumber: string | null;
    transportDocDate: string | null;
    distanceKm: number;
    fromPincode: string;
    toPincode: string;
  };
} {
  return {
    evidence: {
      ewbNumber,
      ewbDateText: row.ewb_date_text,
      validUntilText: row.valid_until_text,
      provider: row.provider,
      status: row.status,
      providerCancelledAtText: row.provider_cancelled_at_text,
      cancellationNote: row.cancellation_note,
      legacyEvidenceMissing: row.legacy_evidence_missing,
    },
    carriage: {
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
  };
}

/** The NIC payload for a bill, keyed on which door its source opens.
 *
 * The e-way bill ROW is authoritative for the carriage that goes on the
 * wire — it is what the 0035 CHECK measures and what an operator edits
 * while the bill is a draft — so the carriage block is read from here
 * rather than from the source document, whose own transport facts are the
 * record of what was printed on the paper. */
function buildPayload(source: EwayBillSourceFacts, row: EwayBillRow): unknown {
  const carriage = {
    transportMode: row.transport_mode,
    transporterId: row.transporter_id,
    transporterName: row.transporter_name,
    vehicleNumber: row.vehicle_number,
    transportDocNumber: row.transport_doc_number,
    transportDocDate: row.transport_doc_date,
    distanceKm: row.distance_km,
    fromPincode: row.from_pincode,
    toPincode: row.to_pincode,
  };
  return source.kind === 'tax_invoice'
    ? buildEwayBillByIrnPayload(source, carriage)
    : buildDirectEwayBillPayload(source, carriage);
}

/** The source document a bill names, whichever of the two it is. */
async function readSourceFacts(
  tx: TransactionSql,
  row: EwayBillRow,
): Promise<EwayBillSourceFacts> {
  return row.tax_invoice_id === null
    ? readChallanSourceFacts(tx, row.delivery_challan_id ?? '')
    : readInvoiceSourceFacts(tx, row.tax_invoice_id);
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

/**
 * WHERE THE `eway_bill` ENTITLEMENT BITES, and where it deliberately does
 * not (migration 0096).
 *
 * The flag exists because an organisation's NIC re-certification has not
 * landed, so the rule is: **it gates STARTING portal work, never finishing
 * or undoing work already started.**
 *
 *   GATED — creating a bill against an invoice or a challan, `/generate`
 *   (the call that registers with NIC), and `/recover-provider-operation`
 *   (which re-asks NIC what became of a generation this organisation
 *   started). All four begin or resume an outbound conversation.
 *
 *   OPEN — `/cancel-provider`, and the two manual-evidence routes
 *   `/nic-response` and `/manual-cancel-response`. Cancellation is the
 *   only way an organisation retracts a bill it has already generated, and
 *   a live e-way bill that cannot be cancelled because an owner switched
 *   the module off is a statutory liability the flag would have created
 *   rather than prevented. The two manual routes record what already
 *   happened somewhere else and speak to nobody.
 *
 * The same shape as the CREATE gates: switching a module off stops new
 * work and never erases or strands what exists.
 */
export function registerEwayBillRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
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
        // The organisation must be entitled to the module at all (0096).
        // Gated on CREATE only, and deliberately: switching the module off
        // stops an organisation whose NIC re-certification has not landed
        // from generating anything new, and does NOT hide the bills it has
        // already generated. A control that erased history would be a
        // different control.
        await requireEntitlement(tx, 'eway_bill');
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
        // ADR-0013: applicability is a property of the LINES. A cumulative
        // SAC invoice, and an itemised one whose every line is a service,
        // are refused here rather than at generation — there is no reason
        // to let an operator fill in carriage facts for a movement NIC
        // will never issue a bill for.
        assertCarriesGoods(await readInvoiceSourceFacts(tx, invoiceId));
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
      url: '/api/challans/:id/eway-bills',
      schema: {
        params: IdParamsSchema,
        response: { 200: EwayBillListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: challanId } = request.params;
      const rows = await tenant(async (tx) => {
        await assertChallanReadable(tx, user.id, challanId);
        return (await tx.unsafe(
          `select ${EB_COLUMNS} ${EB_FROM}
             where eb.delivery_challan_id = $1
             order by eb.created_at desc, eb.id`,
          [challanId],
        )) as unknown as EwayBillRow[];
      });
      return { ewayBills: rows.map(toEwayBill) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/eway-bills',
      schema: {
        params: IdParamsSchema,
        body: SaveEwayBillRequestSchema,
        response: { 201: EwayBillDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: challanId } = request.params;
      const body = normalisedSave(request.body);
      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        // The module entitlement (0096), for the reason the invoice create
        // above gives.
        await requireEntitlement(tx, 'eway_bill');
        // The challan row lock serialises this create against the
        // challan's own cancel and against a concurrent create on the
        // same challan, exactly as the invoice lock does above.
        const [challan] = await tx<
          {
            id: string;
            challan_kind: string;
            status: string;
            challan_number: string | null;
          }[]
        >`
            select id, challan_kind, status, challan_number
            from delivery_challans where id = ${challanId}
            for update
          `;
        if (!challan) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such delivery challan.');
        }
        await assertStandaloneChallanAccess(tx, user.id);
        if (challan.challan_kind !== 'standalone') {
          throw httpError(
            409,
            'CHALLAN_NOT_STANDALONE',
            'An e-way bill is raised from a standalone delivery challan. A work challan moves under the Work it belongs to.',
          );
        }
        if (challan.status !== 'issued') {
          throw httpError(
            409,
            'CHALLAN_STATUS_CONFLICT',
            `An e-way bill moves an issued challan (current status: ${challan.status}) — a draft has no number to move, and a cancelled challan moves nothing.`,
          );
        }
        // The two rules, in the order that produces the more useful
        // refusal: an unclassified challan is told what to record, and a
        // fully classified service-only one is told NIC will not issue a
        // bill for it at all.
        await assertChallanStatutoryFactsComplete(tx, challanId);
        assertCarriesGoods(await readChallanSourceFacts(tx, challanId));
        const [live] = await tx<{ id: string; ewb_number: string | null }[]>`
            select id, ewb_number from eway_bills
            where delivery_challan_id = ${challanId} and status <> 'cancelled'
          `;
        if (live) {
          throw draftConflictError(
            'EWAY_BILL_EXISTS',
            `This challan already has a live e-way bill${live.ewb_number === null ? '' : ` (${live.ewb_number})`}; cancel or delete it before raising another.`,
            live.id,
          );
        }
        const [created] = await tx<{ id: string }[]>`
            insert into eway_bills (
              organisation_id, delivery_challan_id, transport_mode,
              transporter_id, transporter_name, vehicle_number,
              transport_doc_number, transport_doc_date, distance_km,
              from_pincode, to_pincode, created_by_user_id
            )
            values (
              ${organisationId}, ${challanId}, ${body.transportMode},
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
              'This challan already has a live e-way bill; cancel or delete it before raising another.',
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
            deliveryChallanId: challanId,
            challanNumber: challan.challan_number,
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
              where delivery_challan_id = ${challanId} and status <> 'cancelled'
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
        await assertBillAccess(tx, user.id, row);
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
        await assertBillAccess(tx, user.id, row);
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
        await assertBillAccess(tx, user.id, row);
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
            deliveryChallanId: row.delivery_challan_id,
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
        // Recovery RESUMES a generation, re-asking NIC what became of an
        // operation this organisation started, so it is on the gated side
        // of the line drawn below.
        await requireEntitlement(tx, 'eway_bill');
        const row = await lockEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
        // Branched per state, so this route declares nothing and checks
        // inline. Recovery closes out a statutory operation and moves
        // the bill's provider state, so it needs the compliance
        // authority alongside the document one.
        if (row.provider_state === 'generating') {
          await requireAuthorities(tx, user.id, ['issue', 'statutory']);
        } else if (row.provider_state === 'cancelling') {
          await requireAuthorities(tx, user.id, ['cancel', 'statutory']);
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
      // Fresh generation and reconcile-by-lookup share this route: both
      // open a ledger operation and write the NIC portal's answer onto the
      // bill, which is one authority question and not two. Compliance
      // authority required either way.
      authority: ['issue', 'statutory'],
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;

      const prepared = await tenant(async (tx) => {
        // THE ENTITLEMENT GATES STARTING PORTAL WORK (0096). This is the
        // route that actually speaks to NIC in the organisation's name,
        // which is the flag's whole stated purpose, so gating only the
        // two create routes would have left the door it exists to close
        // standing open.
        await requireEntitlement(tx, 'eway_bill');
        await recoverStaleStatutoryOperation(tx, { ewayBillId: id });
        const row = await lockEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
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
        // Reconcile-by-lookup is the invoice path's alone: the lookup NIC
        // offers is by IRN, and a challan-sourced bill has no IRN to look
        // itself up with. An unknown challan generation stays unknown
        // until somebody reconciles it against the portal by hand, which
        // is the honest answer rather than a second blind send.
        const reconcileOnly = row.provider_state === 'generation_unknown';
        if (reconcileOnly && row.tax_invoice_id === null) {
          throw httpError(
            409,
            'EWAY_PROVIDER_STATE_CONFLICT',
            'The earlier generation result is unknown and this bill has no IRN to look itself up by. Reconcile it on the NIC portal, then record the result there.',
          );
        }
        if (provider === undefined) {
          throw httpError(
            409,
            'STATUTORY_PROVIDER_NOT_CONFIGURED',
            'Whitebooks transport is not configured.',
          );
        }
        if (reconcileOnly) {
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
        }
        // The applicability rule, at the moment it decides something: a
        // service-only document is refused here with the code it has
        // always carried (ADR-0013).
        const source = await readSourceFacts(tx, row);
        assertCarriesGoods(source);
        // The carriage must be complete before a payload is assembled, or
        // the 0035 CHECK surfaces as an opaque 500 later.
        assertCarriageComplete(row);

        let gstin: string;
        if (row.tax_invoice_id !== null) {
          const [invoice] = await tx<
            {
              status: string;
              irn: string | null;
              irp_provider: string | null;
              irp_provider_state: string;
            }[]
          >`
              select status, irn, irp_provider, irp_provider_state
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
          gstin = source.supplier.gstin ?? '';
        } else {
          // Re-read the challan's live status the way the invoice branch
          // re-reads the invoice's: the source must still be an ISSUED
          // standalone challan at the moment of generation. The challan
          // cancel route refuses while a non-cancelled bill references it,
          // so this is a race/raw-SQL backstop — NIC evidence must never
          // attach to a cancelled consignment.
          const [challan] = await tx<{ status: string; challan_kind: string }[]>`
              select status, challan_kind from delivery_challans
              where id = ${row.delivery_challan_id} for update
            `;
          if (!challan) throw new Error(`e-way bill ${id} lost its challan`);
          if (challan.challan_kind !== 'standalone' || challan.status !== 'issued') {
            throw httpError(
              409,
              'CHALLAN_STATUS_CONFLICT',
              `An e-way bill moves an issued standalone challan (current status: ${challan.status}) — a cancelled challan moves nothing.`,
            );
          }
          await assertChallanStatutoryFactsComplete(tx, row.delivery_challan_id ?? '');
          if (source.supplier.gstin === null) {
            throw httpError(
              409,
              'EWAY_SOURCE_FACTS_INCOMPLETE',
              'This organisation has no GSTIN on its profile, so it cannot declare a consignor to NIC. Record it under Administration, then try again.',
            );
          }
          gstin = source.supplier.gstin;
        }

        const requestJson = reconcileOnly
          ? stringifyStatutoryJson({ Irn: source.irn })
          : stringifyStatutoryJson(buildPayload(source, row));
        const operationId = await startStatutoryOperation(tx, {
          organisationId,
          userId: user.id,
          provider,
          operation: reconcileOnly ? 'reconcile_eway_bill' : 'generate_eway_bill',
          requestSha256: sha256Hex(requestJson),
          requestBody: requestJson,
          ewayBillId: id,
        });
        await tx`
            update eway_bills
            set provider = 'whitebooks', provider_state = 'generating'
            where id = ${id}
          `;
        return {
          operationId,
          reconcileOnly,
          gstin,
          irn: source.irn,
          payloadJson: requestJson,
          sourceKind: source.kind,
          provider,
        };
      });

      let evidence: EwayBillProviderEvidence | null = null;
      let failure: ReturnType<typeof providerFailure> | null = null;
      try {
        if (prepared.reconcileOnly) {
          evidence = await prepared.provider.findEwayBillByIrn({
            gstin: prepared.gstin,
            irn: prepared.irn ?? '',
          });
          if (evidence === null) {
            failure = {
              status: 'unknown',
              providerCode: null,
              httpStatus: null,
              publicCode: 'WHITEBOOKS_EWB_NOT_FOUND',
              rawResponse: null,
            };
          }
        } else if (prepared.sourceKind === 'tax_invoice') {
          evidence = await prepared.provider.generateEwayBillByIrn({
            gstin: prepared.gstin,
            irn: prepared.irn ?? '',
            payloadJson: prepared.payloadJson,
          });
        } else {
          evidence = await prepared.provider.generateEwayBill({
            gstin: prepared.gstin,
            payloadJson: prepared.payloadJson,
          });
        }
      } catch (error) {
        const callFailure = providerFailure(error);
        // A LOOKUP that fails leaves nothing behind at NIC, so its outcome
        // is recorded as unknown rather than failed — there was no attempt
        // to have failed. A GENERATION keeps the provider's own verdict: a
        // refusal is a refusal, and only an ambiguous result is unknown.
        failure = prepared.reconcileOnly
          ? { ...callFailure, status: 'unknown' }
          : callFailure;
      }

      const detail = await tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
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
            responseBody: evidence.rawResponse,
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
              deliveryChallanId: row.delivery_challan_id,
              ewbNumber: evidence.ewbNumber,
              reconciled: prepared.reconcileOnly,
              provider: prepared.provider.name,
              operationId: prepared.operationId,
            },
          );
        } else {
          const result = failure ?? {
            status: 'unknown' as const,
            providerCode: null,
            httpStatus: null,
            rawResponse: null,
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
            responseBody: result.rawResponse,
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
              deliveryChallanId: row.delivery_challan_id,
              outcome: result.status,
              providerCode: result.providerCode,
              reconciled: prepared.reconcileOnly,
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
      // The payload this bill would send, for an operator reconciling
      // against the NIC portal by hand. It is built by the same function
      // the generation call uses, so what is shown is what would go — a
      // second, "display" builder would be a second thing to keep true.
      //
      // Exact numeric lexemes are rendered as STRINGS here
      // (`statutoryJsonDisplay`), so a browser cannot parse and
      // re-stringify a rupee figure through binary floating point on its
      // way to somebody's eyes.
      const payload = await tenant(async (tx) => {
        const row = await readEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
        const source = await readSourceFacts(tx, row);
        assertCarriesGoods(source);
        assertCarriageComplete(row);
        return statutoryJsonDisplay(buildPayload(source, row));
      });
      void reply.type('application/json; charset=utf-8');
      return reply.send(payload);
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
      authority: ['issue', 'statutory'],
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // Compatibility import only. Manually typed evidence is explicitly
        // unverified and requires issue authority.
        const row = await lockEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
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
            deliveryChallanId: row.delivery_challan_id,
            invoiceNumber: row.invoice_number,
            challanNumber: row.challan_number,
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
      authority: ['cancel', 'statutory'],
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const remark = body.remark.trim();
      return tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
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
      authority: ['cancel', 'statutory'],
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
        await assertBillAccess(tx, user.id, row);
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
        // NIC cancels against the CONSIGNOR's GSTIN, which both sources
        // can state: the invoice from its frozen supplier snapshot, the
        // challan from the organisation's own profile.
        const gstin = (await readSourceFacts(tx, row)).supplier.gstin;
        if (gstin === null) {
          throw httpError(
            409,
            'EWAY_SOURCE_FACTS_INCOMPLETE',
            'This organisation has no GSTIN on its profile, so NIC has nothing to authenticate the cancellation against. Record it under Administration, then try again.',
          );
        }
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
          requestBody: requestJson,
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
        readonly rawResponse: string;
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
        await assertBillAccess(tx, user.id, row);
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
            responseBody: cancelled.rawResponse,
          });
        } else {
          const result = failure ?? {
            status: 'unknown' as const,
            providerCode: null,
            httpStatus: null,
            rawResponse: null,
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
            responseBody: result.rawResponse,
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
        await assertBillAccess(tx, user.id, row);
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
            deliveryChallanId: row.delivery_challan_id,
            note,
          },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );
  tenantRoute(
    {
      method: 'POST',
      url: '/api/eway-bills/:id/render',
      schema: {
        params: IdParamsSchema,
        response: { 200: EwayBillDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;

      // The tax invoice's render posture (0044), at this document's
      // smaller scale: immutable inputs read in one short transaction,
      // Gotenberg and object storage run under no database lock, and a
      // second transaction re-verifies that the facts did not move before
      // the render is recorded. A print of facts that changed underneath
      // it is a print of nothing.
      const prepared = await tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
        if (row.status === 'draft') {
          throw httpError(
            409,
            'EWAY_BILL_STATUS_CONFLICT',
            'A draft e-way bill has no NIC facts to print. Generate it first.',
          );
        }
        if (row.ewb_number === null) {
          throw httpError(
            409,
            'RENDER_INPUT_INVALID',
            'This e-way bill carries no NIC number, so there is nothing to print.',
          );
        }
        const source = await readSourceFacts(tx, row);
        return { source, ...renderInputs(row, row.ewb_number) };
      });

      const sourceSha256 = sha256Hex(
        stringifyStatutoryJson({
          source: prepared.source,
          evidence: prepared.evidence,
          carriage: prepared.carriage,
          template: EWAY_BILL_PDF_TEMPLATE_VERSION,
        }),
      );

      let html: string;
      try {
        html = renderEwayBillHtml(
          prepared.source,
          prepared.evidence,
          prepared.carriage,
        );
      } catch (error) {
        request.log.error({ err: error }, 'e-way bill render input failed');
        throw httpError(
          409,
          'RENDER_INPUT_INVALID',
          'The recorded e-way bill facts cannot be rendered safely.',
        );
      }

      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        failureMessage:
          'The PDF service is unavailable; the e-way bill is unaffected — retry later.',
        logError: (error) => {
          request.log.error({ err: error }, 'e-way bill render failed');
        },
      });

      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/ewb/${id}-${sha256.slice(0, 16)}.pdf`;
      try {
        await storage.put(objectKey, pdf);
      } catch (error) {
        request.log.error({ err: error }, 'e-way bill render storage failed');
        throw httpError(
          502,
          'RENDER_STORAGE_FAILED',
          'The rendered PDF could not be stored. The e-way bill and any previous PDF remain unaffected.',
        );
      }

      return tenant(async (tx) => {
        const row = await lockEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
        if (row.ewb_number === null) {
          throw new Error(`e-way bill ${id} lost its NIC number`);
        }
        const current = await readSourceFacts(tx, row);
        const currentHash = sha256Hex(
          stringifyStatutoryJson({
            source: current,
            ...renderInputs(row, row.ewb_number),
            template: EWAY_BILL_PDF_TEMPLATE_VERSION,
          }),
        );
        if (currentHash !== sourceSha256) {
          throw httpError(
            409,
            'RENDER_SOURCE_CHANGED',
            'The e-way bill facts changed while it was rendering; the previous PDF remains current — render again.',
          );
        }
        const [nextRender] = await tx<{ version: number }[]>`
          select coalesce(max(version), 0)::int + 1 as version
          from eway_bill_renders where eway_bill_id = ${id}
        `;
        if (!nextRender) throw new Error('e-way bill render version query failed');
        await tx`
          insert into eway_bill_renders (
            organisation_id, eway_bill_id, version, template_version,
            source_sha256, object_key, pdf_sha256, created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${nextRender.version},
            ${EWAY_BILL_PDF_TEMPLATE_VERSION}, ${sourceSha256},
            ${objectKey}, ${sha256}, ${user.id}
          )
        `;
        await tx`
          update eway_bills
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256},
              rendered_version = ${nextRender.version}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'eway_bill.rendered',
          'eway_bills',
          id,
          {
            sha256,
            renderVersion: nextRender.version,
            sourceSha256,
            templateVersion: EWAY_BILL_PDF_TEMPLATE_VERSION,
          },
        );
        return { ewayBill: toEwayBill(await readEwayBill(tx, id)) };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/eway-bills/:id/pdf',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const rendered = await tenant(async (tx) => {
        const row = await readEwayBill(tx, id);
        await assertBillAccess(tx, user.id, row);
        // The pointer's key and digest are read from ONE row snapshot (the
        // render_pointer_shape CHECK keeps them both-null-or-both-set), so a
        // concurrent re-render advancing the pointer between two reads can
        // no longer pair a new key with an old digest and fail integrity by
        // version skew.
        if (row.rendered_object_key === null || row.rendered_sha256 === null) {
          throw httpError(
            404,
            'PDF_NOT_AVAILABLE',
            'This e-way bill summary has not been rendered yet.',
          );
        }
        return { key: row.rendered_object_key, sha256: row.rendered_sha256 };
      });
      const bytes = await storage.get(rendered.key);
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== rendered.sha256) {
        throw httpError(
          409,
          'RENDERED_PDF_INTEGRITY_FAILED',
          'The retained e-way bill PDF no longer matches its recorded digest.',
        );
      }
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="eway-bill-${id}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
