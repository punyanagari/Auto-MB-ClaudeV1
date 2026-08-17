import {
  CancelVendorInvoiceSchema,
  CreatePaymentRequestSchema,
  DecidePaymentRequestSchema,
  PayPaymentRequestSchema,
  PaymentRequestListResponseSchema,
  PaymentRequestSchema,
  RecordAdvanceBillsSchema,
  RecordVendorInvoiceSchema,
  RecordVendorPaymentSchema,
  TdsPreviewResponseSchema,
  TdsReturnQuerySchema,
  VendorInvoiceSchema,
  VendorLedgerResponseSchema,
  VendorPaymentSchema,
  VoidVendorPaymentSchema,
  compareDecimalStrings,
  resolveTdsRate,
  tdsSectionRule,
  type PaymentRequest,
  type TdsQuarter,
  type VendorInvoice,
  type VendorPayment,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * The payments workspace: employee advances and reimbursements, and the
 * vendor liability ledger with tax deducted at source.
 *
 * WHERE THE MONEY ARITHMETIC LIVES. Nowhere in this file. Every rupee
 * figure that is stored or compared is computed by PostgreSQL numeric in
 * the statement that writes it — `${gross}::numeric * ${rate} / 100`
 * rounded once by the `money_amount` domain — and every total returned
 * is a SQL `sum`. TypeScript here decides WHICH rate applies and WHETHER
 * a threshold is crossed; it never multiplies rupees. The one arithmetic
 * helper it does use, `resolveTdsRate`, works on exact decimal strings
 * and does its own comparison digit by digit for the same reason.
 *
 * WHAT IS NOT HERE, AND WHY. Bank-statement import and Tally
 * reconciliation are drawn in the mock's Vendors tab and are deliberately
 * absent: both are file-ingestion problems that belong with the importer
 * infrastructure rather than with the money model, and building a second
 * ad-hoc CSV parser here would be the thing that has to be deleted when
 * that infrastructure lands.
 */

// ── Row shapes ───────────────────────────────────────────────────────

interface PaymentRequestRow {
  id: string;
  request_number: string;
  kind: 'advance' | 'reimbursement';
  status: PaymentRequest['status'];
  work_id: string | null;
  work_code: string | null;
  beneficiary_contact_id: string;
  beneficiary_name: string;
  purpose: string;
  category: PaymentRequest['category'];
  amount: string;
  proof_filename: string | null;
  bills_due: boolean;
  bills_recorded_at: Date | null;
  requested_by_user_id: string;
  decided_at: Date | null;
  decision_note: string | null;
  paid_at: Date | null;
  paid_reference: string | null;
  created_at: Date;
}

function toPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  return {
    id: row.id,
    requestNumber: row.request_number,
    kind: row.kind,
    status: row.status,
    workId: row.work_id,
    workCode: row.work_code,
    beneficiaryContactId: row.beneficiary_contact_id,
    beneficiaryName: row.beneficiary_name,
    purpose: row.purpose,
    category: row.category,
    amount: row.amount,
    proofFilename: row.proof_filename,
    billsDue: row.bills_due,
    billsRecordedAt: row.bills_recorded_at?.toISOString() ?? null,
    requestedByUserId: row.requested_by_user_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionNote: row.decision_note,
    paidAt: row.paid_at?.toISOString() ?? null,
    paidReference: row.paid_reference,
    createdAt: row.created_at.toISOString(),
  };
}

const PAYMENT_REQUEST_COLUMNS = `
  r.id, r.request_number, r.kind, r.status, r.work_id, w.work_code,
  r.beneficiary_contact_id, c.designation as beneficiary_name,
  r.purpose, r.category, r.amount::text as amount, r.proof_filename,
  (r.kind = 'advance' and r.status = 'paid' and r.bills_recorded_at is null)
    as bills_due,
  r.bills_recorded_at, r.requested_by_user_id, r.decided_at,
  r.decision_note, r.paid_at, r.paid_reference, r.created_at
`;

interface VendorInvoiceRow {
  id: string;
  vendor_contact_id: string;
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  credit_days: number;
  due_on: string;
  amount: string;
  work_id: string | null;
  tds_section: VendorInvoice['tdsSection'];
  tds_payee_class: VendorInvoice['tdsPayeeClass'];
  paid_total: string;
  outstanding_amount: string;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
}

/**
 * `due_on` and the two totals are computed here rather than in the
 * client: a due date derived in the browser from a credit-day count is a
 * timezone bug waiting to be filed, and a paid total added up in
 * JavaScript is float arithmetic on money.
 */
const VENDOR_INVOICE_COLUMNS = `
  i.id, i.vendor_contact_id, c.designation as vendor_name,
  i.invoice_number, i.invoice_date::text as invoice_date, i.credit_days,
  (i.invoice_date + i.credit_days)::text as due_on,
  i.amount::text as amount, i.work_id, i.tds_section, i.tds_payee_class,
  coalesce(p.paid_total, 0)::text as paid_total,
  (i.amount - coalesce(p.paid_total, 0))::text as outstanding_amount,
  i.cancelled_at, i.cancel_reason, i.created_at
`;

const VENDOR_INVOICE_PAID_JOIN = `
  left join lateral (
    select sum(gross_amount) as paid_total
    from vendor_payments vp
    where vp.vendor_invoice_id = i.id and vp.voided_at is null
  ) p on true
`;

interface VendorPaymentRow {
  id: string;
  vendor_invoice_id: string;
  paid_on: string;
  gross_amount: string;
  tds_amount: string;
  net_amount: string;
  tds_section: VendorPayment['tdsSection'];
  tds_rate: string | null;
  pan_absent: boolean;
  vendor_pan: string | null;
  reference: string | null;
  remarks: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
}

function toVendorPayment(row: VendorPaymentRow): VendorPayment {
  return {
    id: row.id,
    paidOn: row.paid_on,
    grossAmount: row.gross_amount,
    tdsAmount: row.tds_amount,
    netAmount: row.net_amount,
    tdsSection: row.tds_section,
    tdsRate: row.tds_rate,
    panAbsent: row.pan_absent,
    vendorPan: row.vendor_pan,
    reference: row.reference,
    remarks: row.remarks,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidReason: row.void_reason,
    createdAt: row.created_at.toISOString(),
  };
}

const VENDOR_PAYMENT_COLUMNS = `
  id, vendor_invoice_id, paid_on::text as paid_on,
  gross_amount::text as gross_amount, tds_amount::text as tds_amount,
  net_amount::text as net_amount, tds_section, tds_rate::text as tds_rate,
  pan_absent, vendor_pan, reference, remarks, voided_at, void_reason,
  created_at
`;

function toVendorInvoice(
  row: VendorInvoiceRow,
  payments: readonly VendorPayment[],
): VendorInvoice {
  return {
    id: row.id,
    vendorContactId: row.vendor_contact_id,
    vendorName: row.vendor_name,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    creditDays: row.credit_days,
    dueOn: row.due_on,
    amount: row.amount,
    workId: row.work_id,
    tdsSection: row.tds_section,
    tdsPayeeClass: row.tds_payee_class,
    paidTotal: row.paid_total,
    outstandingAmount: row.outstanding_amount,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    payments: [...payments],
    createdAt: row.created_at.toISOString(),
  };
}

// ── Financial year ───────────────────────────────────────────────────

/**
 * The Indian financial year a date falls in, as `2026-27`.
 *
 * April to March, so January to March belong to the year that started in
 * the previous April. Derived from the date-only string by slicing
 * rather than by constructing a `Date`: these are legal date-only values
 * and AGENTS.md rule 6 forbids round-tripping them through a timezone.
 */
export function financialYearOf(dateOnly: string): string {
  const year = Number(dateOnly.slice(0, 4));
  const month = Number(dateOnly.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${String(start)}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The first and last date of a financial-year quarter, inclusive. Q1 is
 * April to June, because the income-tax year starts in April. */
export function quarterRange(
  financialYear: string,
  quarter: TdsQuarter,
): { from: string; to: string } {
  const start = Number(financialYear.slice(0, 4));
  const spans: Record<TdsQuarter, { from: string; to: string }> = {
    Q1: { from: `${String(start)}-04-01`, to: `${String(start)}-06-30` },
    Q2: { from: `${String(start)}-07-01`, to: `${String(start)}-09-30` },
    Q3: { from: `${String(start)}-10-01`, to: `${String(start)}-12-31` },
    Q4: { from: `${String(start + 1)}-01-01`, to: `${String(start + 1)}-03-31` },
  };
  return spans[quarter];
}

// ── CSV ──────────────────────────────────────────────────────────────

/**
 * One CSV cell, quoted only when it has to be.
 *
 * The leading-punctuation guard is not cosmetic: a cell beginning `=`,
 * `+`, `-` or `@` is executed as a formula when the file is opened in
 * Excel, and this export is built to be opened in Excel. Prefixing a
 * single quote is the standard neutralisation and keeps the value
 * readable.
 */
function csvCell(value: string | null): string {
  if (value === null) return '';
  const neutralised = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(neutralised)
    ? `"${neutralised.replaceAll('"', '""')}"`
    : neutralised;
}

function csvRow(cells: readonly (string | null)[]): string {
  return cells.map(csvCell).join(',');
}

// ── Helpers ──────────────────────────────────────────────────────────

async function loadPaymentRequest(
  tx: TransactionSql,
  id: string,
): Promise<PaymentRequestRow> {
  const [row] = await tx<PaymentRequestRow[]>`
    select ${tx.unsafe(PAYMENT_REQUEST_COLUMNS)}
    from payment_requests r
    join contacts c on c.id = r.beneficiary_contact_id
    left join works w on w.id = r.work_id
    where r.id = ${id}
  `;
  if (row === undefined) {
    throw httpError(404, 'PAYMENT_REQUEST_NOT_FOUND', 'No such payment request.');
  }
  return row;
}

/** A Work-linked request is reachable only by someone the Work is
 * reachable by. Requests with no Work are organisation-wide by nature
 * and carry no extra scope. */
async function assertRequestScope(
  tx: TransactionSql,
  userId: string,
  workId: string | null,
): Promise<void> {
  if (workId !== null) await assertWorkAccess(tx, userId, workId);
}

export function registerPaymentsWorkspaceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  // ── Employee payment requests ──────────────────────────────────────

  tenantRoute(
    {
      method: 'GET',
      url: '/api/payment-requests',
      schema: {
        response: { 200: PaymentRequestListResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }) =>
      tenant(async (tx) => {
        // Work-scoped members see requests for their own Works plus
        // every request that belongs to no Work. The predicate is
        // written in SQL rather than filtered afterwards so a scoped
        // member's page size means what it says.
        const scoped = await tx<{ full: boolean }[]>`
          select work_scope <> 'assigned' as full
          from organisation_memberships
          where user_id = ${user.id}
            and organisation_id = app_private.current_organisation_id()
        `;
        const fullScope = scoped[0]?.full ?? false;

        const rows = await tx<PaymentRequestRow[]>`
          select ${tx.unsafe(PAYMENT_REQUEST_COLUMNS)}
          from payment_requests r
          join contacts c on c.id = r.beneficiary_contact_id
          left join works w on w.id = r.work_id
          where ${fullScope}
             or r.work_id is null
             or exists (
                  select 1 from work_assignments a
                  where a.work_id = r.work_id and a.user_id = ${user.id}
                )
          order by r.created_at desc, r.id
        `;
        const blocked = await tx<{ beneficiary_contact_id: string }[]>`
          select distinct beneficiary_contact_id
          from payment_requests
          where kind = 'advance' and status = 'paid'
            and bills_recorded_at is null
        `;
        return {
          requests: rows.map(toPaymentRequest),
          beneficiariesWithBillsDue: blocked.map((row) => row.beneficiary_contact_id),
        };
      }),
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/payment-requests',
      schema: {
        body: CreatePaymentRequestSchema,
        response: { 201: PaymentRequestSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const created = await tenant(async (tx) => {
        if (body.workId !== undefined) {
          await assertWorkAccess(tx, user.id, body.workId);
        }

        const [beneficiary] = await tx<
          { id: string; is_employee: boolean; is_vendor: boolean; active: boolean }[]
        >`
          select id, is_employee, is_vendor, active from contacts
          where id = ${body.beneficiaryContactId}
        `;
        if (beneficiary === undefined || !beneficiary.active) {
          throw httpError(
            404,
            'BENEFICIARY_NOT_FOUND',
            'No such beneficiary in the contacts master.',
            { field: 'beneficiaryContactId' },
          );
        }
        if (!beneficiary.is_employee && !beneficiary.is_vendor) {
          throw httpError(
            400,
            'BENEFICIARY_NOT_PAYABLE',
            'That contact is marked neither an employee nor a vendor, so it cannot be paid. Mark the role in Masters first.',
            { field: 'beneficiaryContactId' },
          );
        }

        // The advance gate, refused by name. The partial unique index
        // makes it impossible regardless; this is what turns a unique
        // violation into a sentence naming the request to close.
        if (body.kind === 'advance') {
          const [open] = await tx<{ request_number: string }[]>`
            select request_number from payment_requests
            where id = app_private.open_advance_for_beneficiary(
              ${body.beneficiaryContactId}
            )
          `;
          if (open !== undefined) {
            throw httpError(
              409,
              'ADVANCE_BILLS_DUE',
              `Record the final bills for ${open.request_number} before drawing another advance for this beneficiary.`,
              { field: 'kind' },
            );
          }
        }

        // The counter is upserted and incremented in one statement, so
        // two concurrent requests serialise on the counter row rather
        // than both reading the same next value.
        const today = new Date().toISOString().slice(0, 10);
        const financialYear = financialYearOf(today);
        const [counter] = await tx<{ next_value: number }[]>`
          insert into payment_request_counters (
            organisation_id, fy_label, next_value
          )
          values (${organisationId}, ${financialYear}, 2)
          on conflict (organisation_id, fy_label) do update
            set next_value = payment_request_counters.next_value + 1,
                updated_at = now()
          returning
            case when xmax = 0 then 1
                 else payment_request_counters.next_value - 1
            end as next_value
        `;
        if (counter === undefined) {
          throw httpError(
            500,
            'PAYMENT_REQUEST_NUMBER_FAILED',
            'The payment-request counter did not yield a number.',
          );
        }
        const sequence = counter.next_value;
        const requestNumber = `PR/${financialYear}/${String(sequence).padStart(3, '0')}`;

        const [row] = await tx<{ id: string }[]>`
          insert into payment_requests (
            organisation_id, fy_label, sequence_number, request_number,
            kind, work_id, beneficiary_contact_id, beneficiary_snapshot,
            purpose, category, amount, proof_object_key, proof_filename,
            status, requested_by_user_id
          )
          select ${organisationId}, ${financialYear}, ${sequence},
                 ${requestNumber}, ${body.kind}, ${body.workId ?? null},
                 ${body.beneficiaryContactId},
                 jsonb_build_object(
                   'designation', c.designation,
                   'contactPerson', c.contact_person,
                   'address', c.address
                 ),
                 ${body.purpose}, ${body.category}, ${body.amount}::money_amount,
                 ${body.proofObjectKey}, ${body.proofFilename},
                 'submitted', ${user.id}
          from contacts c where c.id = ${body.beneficiaryContactId}
          returning id
        `;
        if (row === undefined) {
          throw httpError(
            500,
            'PAYMENT_REQUEST_CREATE_FAILED',
            'The payment request was not written.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'payment_request.submitted',
          'payment_request',
          row.id,
          {
            summary: `${requestNumber} — ${body.kind} of ${body.amount}`,
          },
        );
        return loadPaymentRequest(tx, row.id);
      });
      reply.code(201);
      return toPaymentRequest(created);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/payment-requests/:id/decision',
      schema: {
        params: IdParamsSchema,
        body: DecidePaymentRequestSchema,
        response: { 200: PaymentRequestSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      if (body.decision === 'reject' && body.note === undefined) {
        throw httpError(
          400,
          'DECISION_NOTE_REQUIRED',
          'A rejection has to say what must be corrected.',
          { field: 'note' },
        );
      }
      return tenant(async (tx) => {
        const existing = await loadPaymentRequest(tx, id);
        await assertRequestScope(tx, user.id, existing.work_id);
        if (existing.status !== 'submitted') {
          throw httpError(
            409,
            'PAYMENT_REQUEST_NOT_PENDING',
            `${existing.request_number} is ${existing.status}, so there is no decision left to make on it.`,
          );
        }
        // Deciding on one's own request is the control this whole flow
        // exists to provide, so it is refused here rather than left to
        // an operator's discretion.
        if (existing.requested_by_user_id === user.id) {
          throw httpError(
            409,
            'PAYMENT_REQUEST_SELF_DECISION',
            'A payment request is decided by someone other than the person who raised it.',
          );
        }
        const status = body.decision === 'approve' ? 'approved' : 'rejected';
        await tx`
          update payment_requests
          set status = ${status}, decided_by_user_id = ${user.id},
              decided_at = now(), decision_note = ${body.note ?? null},
              updated_at = now()
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          `payment_request.${status}`,
          'payment_request',
          id,
          {
            summary: `${existing.request_number} ${status}`,
          },
        );
        return toPaymentRequest(await loadPaymentRequest(tx, id));
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/payment-requests/:id/payment',
      schema: {
        params: IdParamsSchema,
        body: PayPaymentRequestSchema,
        response: { 200: PaymentRequestSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const existing = await loadPaymentRequest(tx, id);
        await assertRequestScope(tx, user.id, existing.work_id);
        if (existing.status !== 'approved') {
          throw httpError(
            409,
            'PAYMENT_REQUEST_NOT_APPROVED',
            `${existing.request_number} is ${existing.status}; only an approved request can be paid.`,
          );
        }
        // A reimbursement arrived WITH its bills, so paying it closes
        // it. An advance was paid against an estimate and stays open
        // until the final bills are recorded — which is exactly what
        // blocks the next advance.
        const settlesImmediately = existing.kind === 'reimbursement';
        await tx`
          update payment_requests
          set status = ${settlesImmediately ? 'settled' : 'paid'},
              paid_at = ${body.paidOn}::date,
              paid_reference = ${body.reference},
              bills_recorded_at = ${settlesImmediately ? tx`now()` : null},
              updated_at = now()
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'payment_request.paid',
          'payment_request',
          id,
          {
            summary: `${existing.request_number} paid, reference ${body.reference}`,
          },
        );
        return toPaymentRequest(await loadPaymentRequest(tx, id));
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/payment-requests/:id/bills',
      schema: {
        params: IdParamsSchema,
        body: RecordAdvanceBillsSchema,
        response: { 200: PaymentRequestSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const existing = await loadPaymentRequest(tx, id);
        await assertRequestScope(tx, user.id, existing.work_id);
        if (existing.kind !== 'advance' || existing.status !== 'paid') {
          throw httpError(
            409,
            'ADVANCE_NOT_OPEN',
            `${existing.request_number} is not a paid advance awaiting its final bills.`,
          );
        }
        await tx`
          update payment_requests
          set bills_recorded_at = now(), status = 'settled',
              decision_note = coalesce(${request.body.note ?? null}, decision_note),
              updated_at = now()
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'payment_request.bills_recorded',
          'payment_request',
          id,
          {
            summary: `${existing.request_number} closed by final bills`,
          },
        );
        return toPaymentRequest(await loadPaymentRequest(tx, id));
      });
    },
  );

  // ── Vendor ledger ──────────────────────────────────────────────────

  tenantRoute(
    {
      method: 'GET',
      url: '/api/vendor-invoices',
      schema: {
        response: { 200: VendorLedgerResponseSchema, ...errorResponses },
      },
    },
    async ({ tenant }) =>
      tenant(async (tx) => {
        const rows = await tx<VendorInvoiceRow[]>`
          select ${tx.unsafe(VENDOR_INVOICE_COLUMNS)}
          from vendor_invoices i
          join contacts c on c.id = i.vendor_contact_id
          ${tx.unsafe(VENDOR_INVOICE_PAID_JOIN)}
          order by i.invoice_date desc, i.id
        `;
        const payments = await tx<VendorPaymentRow[]>`
          select ${tx.unsafe(VENDOR_PAYMENT_COLUMNS)}
          from vendor_payments
          order by paid_on desc, id
        `;
        const byInvoice = new Map<string, VendorPayment[]>();
        for (const row of payments) {
          const list = byInvoice.get(row.vendor_invoice_id) ?? [];
          list.push(toVendorPayment(row));
          byInvoice.set(row.vendor_invoice_id, list);
        }
        // Both header figures are SQL aggregates over the same
        // predicate the rows use, not a reduce over the page.
        const [totals] = await tx<
          { total_outstanding: string; overdue_count: string }[]
        >`
          select
            coalesce(sum(i.amount - coalesce(p.paid_total, 0)), 0)::text
              as total_outstanding,
            count(*) filter (
              where i.invoice_date + i.credit_days < current_date
                and i.amount > coalesce(p.paid_total, 0)
            )::text as overdue_count
          from vendor_invoices i
          ${tx.unsafe(VENDOR_INVOICE_PAID_JOIN)}
          where i.cancelled_at is null
        `;
        return {
          invoices: rows.map((row) =>
            toVendorInvoice(row, byInvoice.get(row.id) ?? []),
          ),
          totalOutstanding: totals?.total_outstanding ?? '0',
          overdueCount: Number(totals?.overdue_count ?? '0'),
        };
      }),
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/vendor-invoices',
      schema: {
        body: RecordVendorInvoiceSchema,
        response: { 201: VendorInvoiceSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      if ((body.tdsSection === undefined) !== (body.tdsPayeeClass === undefined)) {
        throw httpError(
          400,
          'TDS_SECTION_INCOMPLETE',
          'A TDS section needs a payee class to produce a rate; give both or neither.',
          { field: 'tdsSection' },
        );
      }
      const created = await tenant(async (tx) => {
        if (body.workId !== undefined) {
          await assertWorkAccess(tx, user.id, body.workId);
        }
        const [vendor] = await tx<{ is_vendor: boolean; active: boolean }[]>`
          select is_vendor, active from contacts where id = ${body.vendorContactId}
        `;
        if (vendor === undefined || !vendor.active || !vendor.is_vendor) {
          throw httpError(
            404,
            'VENDOR_NOT_FOUND',
            'No such active vendor in the contacts master.',
            { field: 'vendorContactId' },
          );
        }
        const [row] = await tx<{ id: string }[]>`
          insert into vendor_invoices (
            organisation_id, vendor_contact_id, vendor_snapshot,
            invoice_number, invoice_date, credit_days, amount, work_id,
            tds_section, tds_payee_class, recorded_by_user_id
          )
          select ${organisationId}, ${body.vendorContactId},
                 jsonb_build_object(
                   'designation', c.designation, 'gstin', c.gstin,
                   'address', c.address
                 ),
                 ${body.invoiceNumber}, ${body.invoiceDate}::date,
                 ${body.creditDays}, ${body.amount}::money_amount,
                 ${body.workId ?? null}, ${body.tdsSection ?? null},
                 ${body.tdsPayeeClass ?? null}, ${user.id}
          from contacts c where c.id = ${body.vendorContactId}
          returning id
        `;
        if (row === undefined) {
          throw httpError(
            500,
            'VENDOR_INVOICE_CREATE_FAILED',
            'The vendor invoice was not written.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'vendor_invoice.recorded',
          'vendor_invoice',
          row.id,
          {
            summary: `${body.invoiceNumber} for ${body.amount}`,
          },
        );
        return loadVendorInvoice(tx, row.id);
      });
      reply.code(201);
      return created;
    },
  );

  async function loadVendorInvoice(
    tx: TransactionSql,
    id: string,
  ): Promise<VendorInvoice> {
    const [row] = await tx<VendorInvoiceRow[]>`
      select ${tx.unsafe(VENDOR_INVOICE_COLUMNS)}
      from vendor_invoices i
      join contacts c on c.id = i.vendor_contact_id
      ${tx.unsafe(VENDOR_INVOICE_PAID_JOIN)}
      where i.id = ${id}
    `;
    if (row === undefined) {
      throw httpError(404, 'VENDOR_INVOICE_NOT_FOUND', 'No such vendor invoice.');
    }
    const payments = await tx<VendorPaymentRow[]>`
      select ${tx.unsafe(VENDOR_PAYMENT_COLUMNS)}
      from vendor_payments where vendor_invoice_id = ${id}
      order by paid_on desc, id
    `;
    return toVendorInvoice(row, payments.map(toVendorPayment));
  }

  /**
   * What the server would deduct, and why.
   *
   * Shared by the preview endpoint and the payment endpoint so the
   * figure an operator is shown and the figure that is written are
   * produced by one code path. Two paths would eventually disagree, and
   * the disagreement would be a tax error.
   */
  async function tdsVerdictFor(
    tx: TransactionSql,
    invoice: VendorInvoiceRow,
    grossAmount: string,
    paidOn: string,
  ): Promise<{
    section: VendorInvoice['tdsSection'];
    rate: string;
    ordinaryRate: string;
    deductible: boolean;
    panAbsentUplift: boolean;
    thresholdBasis: 'single_payment' | 'annual_aggregate' | 'none';
    financialYearPaidBefore: string;
    pan: string | null;
    citation: string | null;
  }> {
    if (invoice.tds_section === null || invoice.tds_payee_class === null) {
      return {
        section: null,
        rate: '0.00',
        ordinaryRate: '0.00',
        deductible: false,
        panAbsentUplift: false,
        thresholdBasis: 'none',
        financialYearPaidBefore: '0',
        pan: null,
        citation: null,
      };
    }

    // The vendor's PAN comes from the contact master. There is no PAN
    // column on `contacts` yet, so this reads the one place a PAN is
    // recorded today: characters 3-12 of a GSTIN are the holder's PAN.
    // ponytail: GSTIN-derived PAN, add a real contacts.pan column when a
    // vendor without a GSTIN has to be paid.
    const [vendor] = await tx<{ pan: string | null }[]>`
      select case
               when c.gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'
               then substring(c.gstin from 3 for 10)
               else null
             end as pan
      from contacts c where c.id = ${invoice.vendor_contact_id}
    `;
    const pan = vendor?.pan ?? null;

    // Everything already paid to THIS VENDOR in the same financial
    // year, across all its invoices — the threshold is per payee, not
    // per invoice. Summed by PostgreSQL.
    const financialYear = financialYearOf(paidOn);
    const yearStart = `${financialYear.slice(0, 4)}-04-01`;
    const yearEnd = `${String(Number(financialYear.slice(0, 4)) + 1)}-03-31`;
    const [prior] = await tx<{ paid_before: string }[]>`
      select coalesce(sum(p.gross_amount), 0)::text as paid_before
      from vendor_payments p
      join vendor_invoices i on i.id = p.vendor_invoice_id
      where i.vendor_contact_id = ${invoice.vendor_contact_id}
        and p.voided_at is null
        and p.paid_on between ${yearStart}::date and ${yearEnd}::date
    `;
    const paidBefore = prior?.paid_before ?? '0';

    const verdict = resolveTdsRate({
      section: invoice.tds_section,
      payeeClass: invoice.tds_payee_class,
      panOnRecord: pan !== null,
      paymentAmount: grossAmount,
      financialYearPaidBefore: paidBefore,
    });

    return {
      section: invoice.tds_section,
      rate: verdict.rate,
      ordinaryRate: verdict.ordinaryRate,
      deductible: verdict.deductible,
      panAbsentUplift: verdict.panAbsentUplift,
      thresholdBasis: verdict.thresholdBasis,
      financialYearPaidBefore: paidBefore,
      pan,
      citation: tdsSectionRule(invoice.tds_section).provision.citation,
    };
  }

  tenantRoute(
    {
      method: 'GET',
      url: '/api/vendor-invoices/:id/tds-preview',
      schema: {
        params: IdParamsSchema,
        querystring: Type.Object(
          {
            grossAmount: Type.String(),
            paidOn: Type.String({ format: 'date' }),
          },
          { additionalProperties: false },
        ),
        response: { 200: TdsPreviewResponseSchema, ...errorResponses },
      },
    },
    async ({ request, tenant }) => {
      const { id } = request.params;
      const { grossAmount, paidOn } = request.query;
      return tenant(async (tx) => {
        const [invoice] = await tx<VendorInvoiceRow[]>`
          select ${tx.unsafe(VENDOR_INVOICE_COLUMNS)}
          from vendor_invoices i
          join contacts c on c.id = i.vendor_contact_id
          ${tx.unsafe(VENDOR_INVOICE_PAID_JOIN)}
          where i.id = ${id}
        `;
        if (invoice === undefined) {
          throw httpError(404, 'VENDOR_INVOICE_NOT_FOUND', 'No such vendor invoice.');
        }
        const verdict = await tdsVerdictFor(tx, invoice, grossAmount, paidOn);
        // The rupee split is PostgreSQL's, not JavaScript's, and it is
        // rounded once by the money_amount domain.
        const [split] = await tx<{ tds: string; net: string }[]>`
          select
            (${grossAmount}::numeric * ${verdict.rate}::numeric / 100)::money_amount::text
              as tds,
            (${grossAmount}::numeric
              - (${grossAmount}::numeric * ${verdict.rate}::numeric / 100)::money_amount
            )::money_amount::text as net
        `;
        return {
          section: verdict.section,
          rate: verdict.rate,
          ordinaryRate: verdict.ordinaryRate,
          tdsAmount: verdict.deductible ? (split?.tds ?? '0.00') : '0.00',
          netAmount: verdict.deductible ? (split?.net ?? grossAmount) : grossAmount,
          deductible: verdict.deductible,
          panAbsentUplift: verdict.panAbsentUplift,
          thresholdBasis: verdict.thresholdBasis,
          financialYearPaidBefore: verdict.financialYearPaidBefore,
          provisionCitation: verdict.citation,
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/vendor-invoices/:id/payments',
      schema: {
        params: IdParamsSchema,
        body: RecordVendorPaymentSchema,
        response: { 201: VendorPaymentSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const created = await tenant(async (tx) => {
        const [invoice] = await tx<VendorInvoiceRow[]>`
          select ${tx.unsafe(VENDOR_INVOICE_COLUMNS)}
          from vendor_invoices i
          join contacts c on c.id = i.vendor_contact_id
          ${tx.unsafe(VENDOR_INVOICE_PAID_JOIN)}
          where i.id = ${id}
        `;
        if (invoice === undefined) {
          throw httpError(404, 'VENDOR_INVOICE_NOT_FOUND', 'No such vendor invoice.');
        }
        if (invoice.cancelled_at !== null) {
          throw httpError(
            409,
            'VENDOR_INVOICE_CANCELLED',
            'A cancelled vendor invoice cannot be paid.',
          );
        }
        if (invoice.work_id !== null) {
          await assertWorkAccess(tx, user.id, invoice.work_id);
        }

        const verdict = await tdsVerdictFor(tx, invoice, body.grossAmount, body.paidOn);
        const rate = verdict.deductible ? verdict.rate : '0.00';

        // The three figures, split by PostgreSQL and rounded once by the
        // money_amount domain. The net is derived by SUBTRACTION rather
        // than by a second multiplication, so gross = tds + net holds
        // exactly and the row can never fail its own CHECK by a paisa.
        const [split] = await tx<{ tds: string; net: string }[]>`
          select t.tds::text as tds,
                 (${body.grossAmount}::money_amount - t.tds)::money_amount::text as net
          from (
            select (${body.grossAmount}::numeric * ${rate}::numeric / 100)::money_amount
              as tds
          ) t
        `;
        if (split === undefined) {
          throw httpError(
            500,
            'VENDOR_PAYMENT_SPLIT_FAILED',
            'The payment split did not compute.',
          );
        }
        // Whether anything was actually withheld, read off the SQL
        // result rather than off `verdict.deductible`: a deductible
        // verdict on a tiny gross can still round to zero, and the
        // section/rate columns must move with the AMOUNT, which is what
        // the table's CHECK constraint requires. Compared as an exact
        // decimal — `Number(tds) > 0` would put a rupee figure through a
        // float to answer a question digits already answer.
        const withheld = compareDecimalStrings(split.tds, '0') > 0;

        const [row] = await tx<{ id: string }[]>`
          insert into vendor_payments (
            organisation_id, vendor_invoice_id, paid_on, gross_amount,
            tds_amount, net_amount, tds_section, tds_rate, pan_absent,
            vendor_pan, reference, remarks, recorded_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${body.paidOn}::date,
            ${body.grossAmount}::money_amount, ${split.tds}::money_amount,
            ${split.net}::money_amount,
            ${withheld ? invoice.tds_section : null},
            ${withheld ? rate : null}::numeric(5,2),
            ${verdict.panAbsentUplift}, ${verdict.pan},
            ${body.reference ?? null}, ${body.remarks ?? null},
            ${user.id}
          )
          returning id
        `;
        if (row === undefined) {
          throw httpError(
            500,
            'VENDOR_PAYMENT_CREATE_FAILED',
            'The vendor payment was not written.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'vendor_payment.recorded',
          'vendor_payment',
          row.id,
          {
            summary: `${invoice.invoice_number}: gross ${body.grossAmount}, TDS ${split.tds}`,
          },
        );
        const [written] = await tx<VendorPaymentRow[]>`
          select ${tx.unsafe(VENDOR_PAYMENT_COLUMNS)}
          from vendor_payments where id = ${row.id}
        `;
        if (written === undefined) {
          throw httpError(
            500,
            'VENDOR_PAYMENT_CREATE_FAILED',
            'The vendor payment was not written.',
          );
        }
        return toVendorPayment(written);
      });
      reply.code(201);
      return created;
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/vendor-payments/:id/void',
      schema: {
        params: IdParamsSchema,
        body: VoidVendorPaymentSchema,
        response: { 200: VendorPaymentSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [existing] = await tx<VendorPaymentRow[]>`
          select ${tx.unsafe(VENDOR_PAYMENT_COLUMNS)}
          from vendor_payments where id = ${id}
        `;
        if (existing === undefined) {
          throw httpError(404, 'VENDOR_PAYMENT_NOT_FOUND', 'No such vendor payment.');
        }
        if (existing.voided_at !== null) {
          throw httpError(
            409,
            'VENDOR_PAYMENT_ALREADY_VOID',
            'That vendor payment is already voided.',
          );
        }
        await tx`
          update vendor_payments
          set voided_at = now(), voided_by_user_id = ${user.id},
              void_reason = ${request.body.reason}, updated_at = now()
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'vendor_payment.voided',
          'vendor_payment',
          id,
          {
            summary: `Voided: ${request.body.reason}`,
          },
        );
        const [voided] = await tx<VendorPaymentRow[]>`
          select ${tx.unsafe(VENDOR_PAYMENT_COLUMNS)}
          from vendor_payments where id = ${id}
        `;
        if (voided === undefined) {
          throw httpError(
            500,
            'VENDOR_PAYMENT_VOID_FAILED',
            'The void was not written.',
          );
        }
        return toVendorPayment(voided);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/vendor-invoices/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelVendorInvoiceSchema,
        response: { 200: VendorInvoiceSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const invoice = await loadVendorInvoice(tx, id);
        if (invoice.cancelledAt !== null) {
          throw httpError(
            409,
            'VENDOR_INVOICE_ALREADY_CANCELLED',
            'That vendor invoice is already cancelled.',
          );
        }
        // Cancelling an invoice that has been paid would leave the
        // payments pointing at a liability the ledger says never
        // existed. Void the payments first, deliberately in that order.
        if (invoice.payments.some((payment) => payment.voidedAt === null)) {
          throw httpError(
            409,
            'VENDOR_INVOICE_HAS_PAYMENTS',
            'Void this invoice’s payments before cancelling it.',
          );
        }
        await tx`
          update vendor_invoices
          set cancelled_at = now(), cancelled_by_user_id = ${user.id},
              cancel_reason = ${request.body.reason}, updated_at = now()
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'vendor_invoice.cancelled',
          'vendor_invoice',
          id,
          {
            summary: `${invoice.invoiceNumber} cancelled: ${request.body.reason}`,
          },
        );
        return loadVendorInvoice(tx, id);
      });
    },
  );

  // ── Quarterly TDS return ───────────────────────────────────────────

  tenantRoute(
    {
      method: 'GET',
      url: '/api/vendor-payments/tds-return.csv',
      schema: {
        querystring: TdsReturnQuerySchema,
        response: { 200: Type.String(), ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, reply, tenant }) => {
      const { financialYear, quarter } = request.query;
      const { from, to } = quarterRange(financialYear, quarter);
      const rows = await tenant(
        async (tx) => tx<
          {
            paid_on: string;
            vendor_name: string;
            vendor_pan: string | null;
            invoice_number: string;
            gross_amount: string;
            tds_section: string | null;
            tds_rate: string | null;
            tds_amount: string;
            net_amount: string;
            pan_absent: boolean;
            reference: string | null;
          }[]
        >`
          select p.paid_on::text as paid_on, c.designation as vendor_name,
                 p.vendor_pan, i.invoice_number,
                 p.gross_amount::text as gross_amount, p.tds_section,
                 p.tds_rate::text as tds_rate, p.tds_amount::text as tds_amount,
                 p.net_amount::text as net_amount, p.pan_absent, p.reference
          from vendor_payments p
          join vendor_invoices i on i.id = p.vendor_invoice_id
          join contacts c on c.id = i.vendor_contact_id
          where p.voided_at is null
            and p.tds_amount > 0
            and p.paid_on between ${from}::date and ${to}::date
          order by p.paid_on, i.invoice_number, p.id
        `,
      );

      const csv = [
        csvRow([
          'Payment date',
          'Deductee',
          'PAN',
          'Invoice',
          'Gross amount',
          'Section',
          'Rate %',
          'TDS deducted',
          'Net paid',
          'PAN absent (206AA)',
          'Bank reference',
        ]),
        ...rows.map((row) =>
          csvRow([
            row.paid_on,
            row.vendor_name,
            row.vendor_pan,
            row.invoice_number,
            row.gross_amount,
            row.tds_section,
            row.tds_rate,
            row.tds_amount,
            row.net_amount,
            row.pan_absent ? 'Yes' : 'No',
            row.reference,
          ]),
        ),
      ].join('\r\n');

      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="tds-${financialYear}-${quarter}.csv"`,
      );
      return csv;
    },
  );
}
