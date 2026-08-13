import {
  BillPaymentSchema,
  BillSettlementResponseSchema,
  RecordBillPaymentRequestSchema,
  VoidBillPaymentRequestSchema,
  type BillDeductionCategory,
  type BillPayment,
  type BillPaymentDeduction,
  type BillSettlementPosition,
  type BillStatus,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * The payment register, and the outstanding position it produces.
 *
 * Before this module `bills.status = 'paid'` was the entire record of
 * money: a word with no amount, no date and no breakup, which is why the
 * spreadsheet beside this product was the payment register. What makes
 * the register work is that a railway payment is never the bill amount —
 * it arrives net of GST TDS, income-tax TDS, retention and whatever was
 * recovered — and that the withheld part is SETTLED money, not missing
 * money. Reporting one net figure conflates the two and turns a closed
 * matter into a phantom debt.
 *
 * Every rule here is also a database trigger (migration 0067), because
 * the improvement programme's recurring finding 2 is that this repository
 * enforces security twice and money once. The split is the same one
 * `docs/PRODUCT.md` §5.5 states for the railway bill and §5.6 restates
 * for this one: the database owns the arithmetic and the structure, this
 * module owns authority, work scope, the audit trail, and saying it in a
 * sentence rather than a SQLSTATE.
 */

/** The reference every position is measured against: the railway's own
 * On-Account Bill amount, reached through the Measurement Book that bill
 * closed. Null until the measurement is closed, and while it is null
 * nothing may be recorded — there is no agreed figure to measure against.
 * `docs/PRODUCT.md` §5.6 explains why this and not `bills.total_amount`. */
interface BillPositionRow {
  readonly bill_id: string;
  readonly work_id: string;
  readonly bill_number: number;
  readonly status: BillStatus;
  readonly prepared_amount: string;
  readonly measurement_book_id: string | null;
  readonly measurement_book_number: string | null;
  readonly measurement_closed_at: Date | null;
  readonly received_railway_bill_id: string | null;
  readonly railway_bill_number: string | null;
  readonly railway_bill_date: string | null;
  readonly railway_bill_amount: string | null;
  readonly received_total: string;
  readonly deduction_total: string;
  readonly outstanding_amount: string | null;
}

interface PaymentRow {
  readonly id: string;
  readonly bill_id: string;
  readonly received_on: string;
  readonly received_amount: string;
  readonly reference: string | null;
  readonly remarks: string | null;
  readonly deduction_total: string;
  readonly gross_amount: string;
  readonly voided_at: Date | null;
  readonly void_reason: string | null;
  readonly created_at: Date;
}

interface DeductionRow {
  readonly id: string;
  readonly bill_payment_id: string;
  readonly category: BillDeductionCategory;
  readonly amount: string;
  readonly description: string | null;
}

/** The columns every read of the position view selects, in one place so a
 * new field is added once rather than in queries that drift apart. */
const POSITION_COLUMNS = `
  p.bill_id, p.work_id, p.bill_number, p.status,
  p.prepared_amount::text as prepared_amount,
  p.measurement_book_id, p.measurement_book_number, p.measurement_closed_at,
  p.received_railway_bill_id, p.railway_bill_number,
  p.railway_bill_date::text as railway_bill_date,
  p.railway_bill_amount::text as railway_bill_amount,
  p.received_total::text as received_total,
  p.deduction_total::text as deduction_total,
  p.outstanding_amount::text as outstanding_amount
`;

/** The payment columns, with both derived money figures summed in SQL.
 * Neither is stored: a stored total is a second thing that can disagree
 * with its parts, and exact numeric arithmetic belongs in the database
 * (engineering rule 5). */
const PAYMENT_COLUMNS = `
  bp.id, bp.bill_id, bp.received_on::text as received_on,
  bp.received_amount::text as received_amount, bp.reference, bp.remarks,
  coalesce(d.total, 0)::text as deduction_total,
  (bp.received_amount + coalesce(d.total, 0))::text as gross_amount,
  bp.voided_at, bp.void_reason, bp.created_at
`;

const PAYMENT_DEDUCTION_SUM = `
  left join lateral (
    select sum(x.amount) as total from bill_payment_deductions x
    where x.organisation_id = bp.organisation_id and x.bill_payment_id = bp.id
  ) d on true
`;

function toDeduction(row: DeductionRow): BillPaymentDeduction {
  return {
    id: row.id,
    category: row.category,
    amount: row.amount,
    description: row.description,
  };
}

function toPayment(
  row: PaymentRow,
  deductions: readonly BillPaymentDeduction[],
): BillPayment {
  return {
    id: row.id,
    billId: row.bill_id,
    receivedOn: row.received_on,
    receivedAmount: row.received_amount,
    reference: row.reference,
    remarks: row.remarks,
    deductions: [...deductions],
    deductionTotal: row.deduction_total,
    grossAmount: row.gross_amount,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidReason: row.void_reason,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Reads payments and their deductions for a set of bills in two
 * statements rather than one per payment.
 *
 * Two, deliberately, and not a lateral aggregation into JSON: the
 * deduction rows are typed and this keeps them typed all the way to the
 * contract. What matters is that the count of statements does not grow
 * with the number of payments — `query-write-loop-census` is about
 * writes, but a read loop over a register is the same defect.
 */
async function paymentsForBills(
  tx: TransactionSql,
  billIds: readonly string[],
): Promise<Map<string, BillPayment[]>> {
  const byBill = new Map<string, BillPayment[]>();
  if (billIds.length === 0) return byBill;

  const payments = await tx<PaymentRow[]>`
    select ${tx.unsafe(PAYMENT_COLUMNS)}
    from bill_payments bp
    ${tx.unsafe(PAYMENT_DEDUCTION_SUM)}
    where bp.bill_id = any(${[...billIds]}::uuid[])
    order by bp.received_on desc, bp.created_at desc, bp.id
  `;
  const paymentIds = payments.map((payment) => payment.id);
  const deductions =
    paymentIds.length === 0
      ? []
      : await tx<DeductionRow[]>`
          select id, bill_payment_id, category, amount::text as amount, description
          from bill_payment_deductions
          where bill_payment_id = any(${paymentIds}::uuid[])
          order by category, id
        `;

  const byPayment = new Map<string, BillPaymentDeduction[]>();
  for (const row of deductions) {
    const existing = byPayment.get(row.bill_payment_id);
    if (existing === undefined) byPayment.set(row.bill_payment_id, [toDeduction(row)]);
    else existing.push(toDeduction(row));
  }
  for (const row of payments) {
    const payment = toPayment(row, byPayment.get(row.id) ?? []);
    const existing = byBill.get(row.bill_id);
    if (existing === undefined) byBill.set(row.bill_id, [payment]);
    else existing.push(payment);
  }
  return byBill;
}

function toPosition(
  row: BillPositionRow,
  payments: readonly BillPayment[],
): BillSettlementPosition {
  return {
    billId: row.bill_id,
    workId: row.work_id,
    billNumber: row.bill_number,
    status: row.status,
    preparedAmount: row.prepared_amount,
    measurementBookId: row.measurement_book_id,
    measurementBookNumber: row.measurement_book_number,
    measurementClosedAt: row.measurement_closed_at?.toISOString() ?? null,
    receivedRailwayBillId: row.received_railway_bill_id,
    railwayBillNumber: row.railway_bill_number,
    railwayBillDate: row.railway_bill_date,
    railwayBillAmount: row.railway_bill_amount,
    receivedTotal: row.received_total,
    deductionTotal: row.deduction_total,
    outstandingAmount: row.outstanding_amount,
    payments: [...payments],
  };
}

/** One payment with its deductions, re-read through the same shape every
 * other surface uses, so a mutation answers exactly what a list would. */
async function readPayment(tx: TransactionSql, id: string): Promise<BillPayment> {
  const [row] = await tx<PaymentRow[]>`
    select ${tx.unsafe(PAYMENT_COLUMNS)}
    from bill_payments bp
    ${tx.unsafe(PAYMENT_DEDUCTION_SUM)}
    where bp.id = ${id}
  `;
  if (row === undefined) throw new Error('bill payment read returned no row');
  const deductions = await tx<DeductionRow[]>`
    select id, bill_payment_id, category, amount::text as amount, description
    from bill_payment_deductions
    where bill_payment_id = ${id}
    order by category, id
  `;
  return toPayment(row, deductions.map(toDeduction));
}

export function registerBillPaymentRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/bill-settlement',
      schema: {
        params: IdParamsSchema,
        response: { 200: BillSettlementResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // Its own statement against `bill_settlement_positions` — the
        // aggregate is deliberately never folded into a loader that
        // something else already runs. The Measurement Book loader's
        // buffer ratchet is the standing reason.
        const rows = await tx<BillPositionRow[]>`
          select ${tx.unsafe(POSITION_COLUMNS)}
          from bill_settlement_positions p
          where p.work_id = ${workId}
          order by p.bill_number desc
        `;
        const payments = await paymentsForBills(
          tx,
          rows.map((row) => row.bill_id),
        );
        return {
          positions: rows.map((row) =>
            toPosition(row, payments.get(row.bill_id) ?? []),
          ),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/bills/:id/payments',
      schema: {
        params: IdParamsSchema,
        body: RecordBillPaymentRequestSchema,
        response: { 201: BillPaymentSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: billId } = request.params;
      const body = request.body;

      // Two shape rules the request schema cannot express, checked before
      // anything is locked. A flat array cannot say "description is
      // required on exactly one member of the union" without producing a
      // validation message no operator can act on.
      const undescribed = body.deductions.find(
        (deduction) =>
          deduction.category === 'OTHER' && deduction.description === undefined,
      );
      if (undescribed !== undefined) {
        throw httpError(
          400,
          'BILL_PAYMENT_DEDUCTION_UNDESCRIBED',
          'A deduction recorded as Other has to say what it is.',
          { field: 'deductions' },
        );
      }
      const named = body.deductions
        .filter((deduction) => deduction.category !== 'OTHER')
        .map((deduction) => deduction.category);
      const duplicate = named.find(
        (category, index) => named.indexOf(category) !== index,
      );
      if (duplicate !== undefined) {
        throw httpError(
          409,
          'BILL_PAYMENT_DUPLICATE_DEDUCTION',
          `This advice already deducts ${duplicate} once; a named head is stated once per payment.`,
          { field: 'deductions' },
        );
      }

      return tenant(async (tx) => {
        // Lock the bill first, in the same order the database guard takes
        // it, so two advices recorded at once cannot jointly pass the
        // railway's figure.
        const [bill] = await tx<
          { work_id: string; status: BillStatus; bill_number: number }[]
        >`
          select work_id, status, bill_number from bills
          where id = ${billId} for update
        `;
        if (bill === undefined) {
          throw httpError(404, 'BILL_NOT_FOUND', 'No such bill.');
        }
        await assertWorkAccess(tx, user.id, bill.work_id);
        if (bill.status === 'paid') {
          throw httpError(
            409,
            'BILL_ALREADY_PAID',
            'This bill is fully paid; its payment register is closed.',
          );
        }

        // The ceiling, computed in SQL. Every term is an exact numeric and
        // stays one: summing a request's deductions in JavaScript to
        // compare them against a money column is the floating-point
        // arithmetic engineering rule 5 forbids, and it would be wrong at
        // the boundary that matters most — the one where a payment exactly
        // closes a bill.
        const [ceiling] = await tx<
          { reference: string | null; remaining: string | null; gross: string }[]
        >`
          with request as (
            select ${body.receivedAmount}::numeric
                   + coalesce((
                       select sum(amount::numeric)
                       from unnest(
                         ${body.deductions.map((deduction) => deduction.amount)}::text[]
                       ) as amount
                     ), 0) as gross
          )
          select app_private.bill_settlement_reference(${billId})::text as reference,
                 (app_private.bill_settlement_reference(${billId})
                   - app_private.bill_settled_total(${billId})
                   - request.gross)::text as remaining,
                 request.gross::text as gross
          from request
        `;
        if (ceiling?.reference == null) {
          throw httpError(
            409,
            'BILL_MEASUREMENT_BOOK_NOT_CLOSED',
            "This bill's Measurement Book is not closed by a verified railway bill, so there is no settled amount to record against.",
          );
        }
        if (ceiling.remaining !== null && Number(ceiling.remaining) < 0) {
          // The comparison is `< 0` on a value PostgreSQL already
          // computed exactly; JavaScript only reads its sign, which no
          // rounding can change.
          throw httpError(
            409,
            'BILL_PAYMENT_EXCEEDS_SETTLEMENT',
            `This receipt of ${ceiling.gross} would settle more than the railway's bill of ${ceiling.reference}.`,
            { field: 'receivedAmount' },
          );
        }

        const [row] = await tx<{ id: string }[]>`
          insert into bill_payments (
            organisation_id, bill_id, received_on, received_amount, reference,
            remarks, recorded_by_user_id
          )
          values (
            ${organisationId}, ${billId}, ${body.receivedOn},
            ${body.receivedAmount}, ${body.reference ?? null},
            ${body.remarks ?? null}, ${user.id}
          )
          returning id
        `.catch(rethrowSettlementBreach);
        if (row === undefined) throw new Error('bill payment insert returned no row');

        if (body.deductions.length > 0) {
          // One statement for the whole breakup, never a write per row —
          // `apps/server/test/query-write-loop-census.test.ts` is the
          // standing rule and this is the shape it asks for. Amounts
          // travel as text and are cast, because postgres.js types a
          // parameter array from its FIRST element.
          await tx`
            insert into bill_payment_deductions (
              organisation_id, bill_payment_id, category, amount, description
            )
            select ${organisationId}, ${row.id}, d.category, d.amount::numeric,
                   d.description
            from unnest(
              ${body.deductions.map((deduction) => deduction.category)}::text[],
              ${body.deductions.map((deduction) => deduction.amount)}::text[],
              ${body.deductions.map(
                (deduction) => deduction.description ?? null,
              )}::text[]
            ) as d(category, amount, description)
          `.catch(rethrowSettlementBreach);
        }

        const payment = await readPayment(tx, row.id);
        await audit(
          tx,
          organisationId,
          user.id,
          'bill_payment.recorded',
          'bill_payments',
          row.id,
          {
            billId,
            billNumber: bill.bill_number,
            receivedOn: payment.receivedOn,
            receivedAmount: payment.receivedAmount,
            deductionTotal: payment.deductionTotal,
            grossAmount: payment.grossAmount,
            reference: payment.reference,
          },
        );
        return reply.status(201).send(payment);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/bill-payments/:id/void',
      schema: {
        params: IdParamsSchema,
        body: VoidBillPaymentRequestSchema,
        response: { 200: BillPaymentSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { reason } = request.body;
      return tenant(async (tx) => {
        // Locate the bill without a lock, then take the locks bill-first —
        // the same order the recording route takes them, so the two cannot
        // interleave into a deadlock.
        const [located] = await tx<{ bill_id: string }[]>`
          select bill_id from bill_payments where id = ${id}
        `;
        if (located === undefined) {
          throw httpError(404, 'BILL_PAYMENT_NOT_FOUND', 'No such payment.');
        }
        const [bill] = await tx<{ work_id: string; status: BillStatus }[]>`
          select work_id, status from bills where id = ${located.bill_id} for update
        `;
        const [current] = await tx<{ voided_at: Date | null }[]>`
          select voided_at from bill_payments where id = ${id} for update
        `;
        if (bill === undefined || current === undefined) {
          throw httpError(404, 'BILL_PAYMENT_NOT_FOUND', 'No such payment.');
        }
        await assertWorkAccess(tx, user.id, bill.work_id);
        if (current.voided_at !== null) {
          throw httpError(
            409,
            'BILL_PAYMENT_ALREADY_VOIDED',
            'This payment is already voided.',
          );
        }
        // A paid bill's register is closed in both directions. Removing a
        // receipt would leave `paid` resting on arithmetic that no longer
        // reaches the railway's figure, and `bills` moves forward only, so
        // there is no honest way back — the correction is a compensating
        // entry on a later bill.
        if (bill.status === 'paid') {
          throw httpError(
            409,
            'BILL_ALREADY_PAID',
            'This bill is paid; a receipt behind a paid bill cannot be withdrawn. Record the correction against a later bill.',
          );
        }
        await tx`
          update bill_payments
          set voided_at = now(), voided_by_user_id = ${user.id},
              void_reason = ${reason}
          where id = ${id}
        `;
        const payment = await readPayment(tx, id);
        await audit(
          tx,
          organisationId,
          user.id,
          'bill_payment.voided',
          'bill_payments',
          id,
          { billId: located.bill_id, grossAmount: payment.grossAmount, reason },
        );
        return payment;
      });
    },
  );
}

/**
 * The database's ceiling refusal, restated as this module's own.
 *
 * The route checks the ceiling before it writes, so this only fires when
 * a concurrent advice took the remaining balance between the check and
 * the insert — which is exactly the case the trigger exists for. Turning
 * it into a 409 rather than letting a `check_violation` reach the error
 * handler as a 500 is the difference between "somebody else recorded a
 * payment first" and "the server broke".
 */
function rethrowSettlementBreach(error: unknown): never {
  const message =
    error instanceof Error && typeof error.message === 'string' ? error.message : '';
  if (message.includes('would be settled to')) {
    throw httpError(
      409,
      'BILL_PAYMENT_EXCEEDS_SETTLEMENT',
      'This payment would settle more than the railway billed. Re-read the register: another receipt may have been recorded first.',
    );
  }
  if (message.includes('is paid; its payment register is closed')) {
    throw httpError(
      409,
      'BILL_ALREADY_PAID',
      'This bill is fully paid; its payment register is closed.',
    );
  }
  throw error;
}
