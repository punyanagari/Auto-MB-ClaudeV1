import {
  BillPaymentSchema,
  BillSettlementResponseSchema,
  ReceivablesRegisterResponseSchema,
  RecordBillPaymentRequestSchema,
  VoidBillPaymentRequestSchema,
  type BillDeductionCategory,
  type BillDeductionHeadTotal,
  type BillPayment,
  type BillPaymentDeduction,
  type BillSettlementPosition,
  type BillStatus,
  type ErrorCode,
  type ReceivablesRegisterEntry,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { financialYearLabel } from '../financial-year.js';
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
 * `docs/PRODUCT.md` §5.5 states for the railway bill and §5.7 restates
 * for this one: the database owns the arithmetic and the structure, this
 * module owns authority, work scope, the audit trail, and saying it in a
 * sentence rather than a SQLSTATE.
 */

/**
 * The two refusals an operator can meet from either layer.
 *
 * Written once because they ARE one refusal each: the route catches the
 * common case under a row lock and the trigger catches the concurrent
 * one, and an operator who met two different sentences for the same
 * situation would reasonably conclude they were two different problems.
 */
const SETTLEMENT_BREACH =
  'This receipt would settle more than the railway billed. Re-read the register: another receipt may have been recorded first.';
const REGISTER_CLOSED =
  'This bill is fully paid; its payment register is closed in both directions.';

/** The reference every position is measured against: the railway's own
 * On-Account Bill amount, reached through the Measurement Book that bill
 * closed. Null until the measurement is closed, and while it is null
 * nothing may be recorded — there is no agreed figure to measure against.
 * `docs/PRODUCT.md` §5.7 explains why this and not `bills.total_amount`. */
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

/**
 * A position as the organisation-wide register reads it: the per-Work row
 * plus its Work's identity, the bill's own submission, the net figure, and
 * the four register totals riding along on every row (see the route).
 */
interface RegisterRow extends BillPositionRow {
  readonly work_code: string;
  readonly work_title: string;
  readonly submitted_at: Date | null;
  readonly net_payable_amount: string | null;
  readonly claimed_total: string;
  readonly passed_total: string;
  readonly register_received_total: string;
  readonly outstanding_total: string;
}

interface HeadTotalRow {
  readonly bill_id: string;
  readonly category: BillDeductionCategory;
  readonly amount: string;
}

/** An empty register still has four figures, and they are zeroes rather
 * than blanks. Written at the money domain's own scale so a register with
 * no rows and a register whose rows sum to nothing print identically. */
const EMPTY_REGISTER_TOTALS = {
  claimedTotal: '0.00',
  passedTotal: '0.00',
  receivedTotal: '0.00',
  outstandingTotal: '0.00',
} as const;

/**
 * What the railway kept against each bill, by head, over live receipts
 * only.
 *
 * `voided_at is null` mirrors the position view's own filter: a withdrawn
 * receipt stops counting towards the bill, so its deductions must stop
 * counting towards the waterfall too, or the heads would sum past a
 * `deductionTotal` that had already dropped them.
 */
async function deductionHeadsForBills(
  tx: TransactionSql,
  billIds: readonly string[],
): Promise<Map<string, BillDeductionHeadTotal[]>> {
  const byBill = new Map<string, BillDeductionHeadTotal[]>();
  if (billIds.length === 0) return byBill;
  const rows = await tx<HeadTotalRow[]>`
    select bp.bill_id, d.category, sum(d.amount)::money_amount::text as amount
    from bill_payments bp
    join bill_payment_deductions d
      on d.organisation_id = bp.organisation_id and d.bill_payment_id = bp.id
    where bp.bill_id = any(${[...billIds]}::uuid[]) and bp.voided_at is null
    group by bp.bill_id, d.category
    order by bp.bill_id, d.category
  `;
  for (const row of rows) {
    const head = { category: row.category, amount: row.amount };
    const existing = byBill.get(row.bill_id);
    if (existing === undefined) byBill.set(row.bill_id, [head]);
    else existing.push(head);
  }
  return byBill;
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
  -- Cast to the money domain before the text, or a payment with no
  -- deductions answers "0" where every other figure answers "0.00": the
  -- coalesce falls back to an integer literal, and only the column's own
  -- scale makes the rest two-place.
  coalesce(d.total, 0)::money_amount::text as deduction_total,
  (bp.received_amount + coalesce(d.total, 0))::money_amount::text as gross_amount,
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

/**
 * Text as the DATABASE will judge it.
 *
 * The `reference` and `remarks` CHECKs on `bill_payments` measure
 * `btrim(x)`, and `btrim` removes SPACES only while JavaScript's `trim()`
 * removes every whitespace character. A reference of `" UTR-1 "` satisfies
 * the contract schema, reaches the column with its spaces, and fails
 * `btrim(reference) = reference` as a 23514 the operator reads as a bare
 * 500. The same shape `routes/quotations.ts` established for the 0033 text
 * columns, applied here: trim at the boundary, so the trimmed text is also
 * what gets STORED and the record says what the operator meant.
 *
 * The contract stays permissive on purpose. A schema that refused padded
 * text would refuse a paste out of a bank statement, which is where these
 * references come from.
 */
function trimmedOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * When a receipt may be dated.
 *
 * Both bounds are the discipline the sibling document routes already
 * apply to a legal date, and both catch a real mis-key rather than a
 * hypothetical one. A receipt dated in the future is a typed year; a
 * receipt dated before the railway raised the bill it settles is a
 * transposed day, and it would sort above the bill in every register that
 * reads the two together.
 *
 * "Today" is the organisation's own day, not the server's: an operator in
 * Kolkata recording an evening receipt would otherwise be refused for
 * five and a half hours a day by a UTC clock.
 */
function assertReceiptDate(
  receivedOn: string,
  railwayBillDate: string,
  today: string,
): void {
  if (receivedOn > today) {
    throw httpError(
      400,
      'BILL_PAYMENT_DATE_INVALID',
      `A receipt cannot be dated ${receivedOn}, which is in the future; today is ${today}.`,
      { field: 'receivedOn' },
    );
  }
  if (receivedOn < railwayBillDate) {
    throw httpError(
      400,
      'BILL_PAYMENT_DATE_INVALID',
      `A receipt cannot be dated ${receivedOn}, before the railway bill it settles (${railwayBillDate}).`,
      { field: 'receivedOn' },
    );
  }
}

export function registerBillPaymentRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  /**
   * The organisation's receivables register: every bill's position with
   * the railway, across every Work the caller may see.
   *
   * A sibling of the per-Work read below rather than a replacement for it.
   * The question is genuinely different — "what is the railway holding of
   * ours, everywhere" is asked by whoever chases payment, and answering it
   * by fetching one Work at a time would be a request per Work and a
   * browser adding money up at the end of it.
   *
   * Three things are worth knowing about the shape:
   *
   *   * **The scope predicate is written once.** It is an authorization
   *     rule, and a rule duplicated across a rows query and a totals query
   *     is a rule that can drift into reporting totals over Works the
   *     caller cannot see. So the totals are window aggregates over the
   *     same scoped set, computed in the same statement, and they ride
   *     along on every row.
   *   * **The totals are over the whole register, never a page of it.**
   *     `sum(...) over ()` has no frame clause, so it partitions over
   *     everything the WHERE admitted. Tiles that summed a page would
   *     quietly answer a different question than the table beneath them.
   *   * **`sum` ignores nulls, which is the wanted behaviour.** A bill the
   *     railway has not passed contributes nothing to `passedTotal` rather
   *     than contributing what the agency prepared.
   */
  tenantRoute(
    {
      method: 'GET',
      url: '/api/bill-settlement',
      schema: {
        response: { 200: ReceivablesRegisterResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }) => {
      return tenant(async (tx) => {
        const full = await hasFullWorkScope(tx, user.id);
        const rows = await tx<RegisterRow[]>`
          select ${tx.unsafe(POSITION_COLUMNS)},
            w.work_code, w.title as work_title,
            b.submitted_at,
            case
              when p.railway_bill_amount is null then null
              else (p.railway_bill_amount - p.deduction_total)::money_amount::text
            end as net_payable_amount,
            coalesce(sum(p.prepared_amount) over (), 0)::numeric(18,2)::text
              as claimed_total,
            coalesce(sum(p.railway_bill_amount) over (), 0)::numeric(18,2)::text
              as passed_total,
            coalesce(sum(p.received_total) over (), 0)::numeric(18,2)::text
              as register_received_total,
            coalesce(sum(p.outstanding_amount) over (), 0)::numeric(18,2)::text
              as outstanding_total
          from bill_settlement_positions p
          join works w on w.id = p.work_id and w.deleted_at is null
          join bills b on b.id = p.bill_id
          where (${full} or exists (
            select 1 from work_assignments wa
            where wa.work_id = p.work_id and wa.user_id = ${user.id}
          ))
          -- The same order the per-Work read and the dashboard use: the
          -- view carries no created_at, and Work code then bill number is
          -- both the operator's own register order and stable where a
          -- timestamp on two bills prepared in one second is not. Newest
          -- bill first within a Work, because that is the one being chased.
          order by w.work_code asc, p.bill_number desc
        `;
        const billIds = rows.map((row) => row.bill_id);
        const [payments, heads] = await Promise.all([
          paymentsForBills(tx, billIds),
          deductionHeadsForBills(tx, billIds),
        ]);
        const entries: ReceivablesRegisterEntry[] = rows.map((row) => ({
          ...toPosition(row, payments.get(row.bill_id) ?? []),
          workCode: row.work_code,
          workTitle: row.work_title,
          submittedAt: row.submitted_at?.toISOString() ?? null,
          // Null with `railwayBillAmount`, by construction: the year a
          // receivable falls in is the year the railway acknowledged it.
          financialYear:
            row.railway_bill_date === null
              ? null
              : financialYearLabel(row.railway_bill_date),
          netPayableAmount: row.net_payable_amount,
          deductionsByHead: heads.get(row.bill_id) ?? [],
        }));
        const [first] = rows;
        return {
          entries,
          summary:
            first === undefined
              ? EMPTY_REGISTER_TOTALS
              : {
                  claimedTotal: first.claimed_total,
                  passedTotal: first.passed_total,
                  receivedTotal: first.register_received_total,
                  outstandingTotal: first.outstanding_total,
                },
        };
      });
    },
  );

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
        // The Work has to exist, and be live, before its money is
        // reported. Without this the register answered `{positions: []}`
        // for an unknown id and for another organisation's Work alike —
        // indistinguishable from a Work of one's own that nobody has
        // billed yet, which is the empty-register lie about a register.
        //
        // `deleted_at is null` is the merged tree's liveness predicate
        // (migration 0071). It is defence in depth here rather than a
        // reachable case: superseding refuses while any bill exists, so a
        // Work carrying a settlement position cannot be withdrawn. It is
        // written anyway, because relying on that would be relying on a
        // rule that lives in another module and could be relaxed there.
        const [live] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (live === undefined) {
          throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        }
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

      // The transaction is awaited to COMPLETION before the response is
      // sent, and that ordering is load-bearing rather than tidy.
      // `reply.send()` dispatches immediately, so calling it inside the
      // callback lets a 201 reach the client while the COMMIT is still in
      // flight — and a screen that refetches the register on success then
      // renders without the receipt it just recorded. It surfaced as an
      // intermittently failing assertion on the partial-payments test,
      // which is the polite version of the bug: the impolite version is an
      // operator recording a payment twice because the first one did not
      // appear. Every sibling route in the tree sends after the await.
      const recorded = await tenant(async (tx) => {
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
          throw httpError(409, 'BILL_ALREADY_PAID', REGISTER_CLOSED);
        }

        // The ceiling, computed in SQL. Every term is an exact numeric and
        // stays one: summing a request's deductions in JavaScript to
        // compare them against a money column is the floating-point
        // arithmetic engineering rule 5 forbids, and it would be wrong at
        // the boundary that matters most — the one where a payment exactly
        // closes a bill. The railway bill's date and the organisation's own
        // today ride along in the same statement, because both are bounds
        // on the receipt and neither is worth a second round trip.
        const [ceiling] = await tx<
          {
            reference: string | null;
            railway_bill_date: string | null;
            today: string;
            remaining: string | null;
            gross: string;
          }[]
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
                 request.gross::text as gross,
                 (
                   select rb.bill_date::text
                   from bills b
                   join measurement_books mb
                     on mb.organisation_id = b.organisation_id and mb.id = b.mb_id
                   join received_railway_bills rb
                     on rb.organisation_id = mb.organisation_id
                    and rb.id = mb.closed_by_received_bill_id
                   where b.id = ${billId}
                 ) as railway_bill_date,
                 (
                   select (now() at time zone o.timezone)::date::text
                   from organisations o
                   where o.id = app_private.current_organisation_id()
                 ) as today
          from request
        `;
        if (ceiling?.reference == null) {
          throw httpError(
            409,
            'BILL_MEASUREMENT_BOOK_NOT_CLOSED',
            "This bill's Measurement Book is not closed by a verified railway bill, so there is no settled amount to record against.",
          );
        }
        // Refused before the ceiling: a mis-keyed date is the likelier of
        // the two mistakes, and hearing about the money first would send
        // the operator to change the wrong field.
        assertReceiptDate(
          body.receivedOn,
          ceiling.railway_bill_date ?? body.receivedOn,
          ceiling.today,
        );
        if (ceiling.remaining !== null && Number(ceiling.remaining) < 0) {
          // The comparison is `< 0` on a value PostgreSQL already
          // computed exactly; JavaScript only reads its sign, which no
          // rounding can change.
          throw httpError(409, 'BILL_PAYMENT_EXCEEDS_SETTLEMENT', SETTLEMENT_BREACH, {
            field: 'receivedAmount',
          });
        }

        // Trimmed as `btrim` would trim it, so the CHECK cannot refuse
        // what the schema accepted, and so the stored text is the text.
        const reference = trimmedOrNull(body.reference);
        if (reference !== null) {
          const [duplicate] = await tx<{ id: string }[]>`
            select id from bill_payments
            where bill_id = ${billId} and voided_at is null
              and btrim(reference) = ${reference}
          `;
          if (duplicate !== undefined) {
            throw httpError(
              409,
              'BILL_PAYMENT_DUPLICATE_REFERENCE',
              `A live receipt quoting ${reference} is already recorded against this bill.`,
              { field: 'reference' },
            );
          }
        }

        const [row] = await tx<{ id: string }[]>`
          insert into bill_payments (
            organisation_id, bill_id, received_on, received_amount, reference,
            remarks, recorded_by_user_id
          )
          values (
            ${organisationId}, ${billId}, ${body.receivedOn},
            ${body.receivedAmount}, ${reference},
            ${trimmedOrNull(body.remarks)}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
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
          `.catch(rethrowWriteRefusal);
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
        return payment;
      });
      return reply.status(201).send(recorded);
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
          throw httpError(409, 'BILL_ALREADY_PAID', REGISTER_CLOSED);
        }
        // Retention held is DERIVED from this receipt's SECURITY_DEPOSIT
        // deduction (migration 0098), so withdrawing the receipt reduces
        // what was ever withheld on the Work — and it may not reduce it
        // below what has already been released. The whole comparison is
        // done in SQL: three decimal strings through `Number()` is the
        // float arithmetic engineering rule 5 forbids, on the figures that
        // decide whether the ledger stays honest.
        //
        // `app_private.guard_retention_survives_payment_void` refuses the
        // same thing, which is what holds when a release is recorded
        // between this read and the update. This is the arm that says it
        // in a sentence.
        const [retention] = await tx<{ stranded: boolean; shortfall: string }[]>`
          with withdrawn as (
            select coalesce(sum(d.amount::numeric), 0) as total
            from bill_payment_deductions d
            where d.bill_payment_id = ${id} and d.category = 'SECURITY_DEPOSIT'
          )
          select app_private.work_retention_released(${bill.work_id})
                   > app_private.work_retention_held(${bill.work_id})
                     - withdrawn.total as stranded,
                 (app_private.work_retention_released(${bill.work_id})
                   - (app_private.work_retention_held(${bill.work_id})
                      - withdrawn.total))::text as shortfall
          from withdrawn
        `;
        if (retention?.stranded === true) {
          throw httpError(
            409,
            'RETENTION_RELEASE_STRANDED',
            `This receipt is what withheld the retention already released on this Work; withdrawing it would leave ${retention.shortfall} released against nothing withheld. Withdraw the release first.`,
          );
        }
        await tx`
          update bill_payments
          set voided_at = now(), voided_by_user_id = ${user.id},
              void_reason = ${reason}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
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
 * The database's refusals, restated as this module's own.
 *
 * The route checks each of these before it writes, so a trigger only wins
 * the race when a concurrent advice took the remaining balance, or paid
 * the bill, between the check and the insert — which is exactly the case
 * the triggers exist for. Turning that into a named 409 rather than
 * letting an integrity violation reach the error handler as a 500 is the
 * difference between "somebody else recorded a payment first" and "the
 * server broke".
 *
 * Matched on SQLSTATE, never on the text of the RAISE. Migration 0067
 * gives each rule its own code in class 23 for this one reason: a reworded
 * message must not be able to silently turn a 409 back into a 500, and a
 * substring match is a coupling nothing checks. `constraint_name` rides
 * along so a log line names the rule without anybody decoding the number.
 */
const DATABASE_REFUSALS: Readonly<Record<string, readonly [ErrorCode, string]>> = {
  '23A01': ['BILL_PAYMENT_EXCEEDS_SETTLEMENT', SETTLEMENT_BREACH],
  '23A02': ['BILL_ALREADY_PAID', REGISTER_CLOSED],
  '23A03': [
    'BILL_MEASUREMENT_BOOK_NOT_CLOSED',
    "This bill's Measurement Book is not closed by a verified railway bill, so there is no settled amount to record against.",
  ],
  '23A04': [
    'BILL_PAYMENT_ALREADY_VOIDED',
    'This payment was withdrawn while the receipt was being recorded.',
  ],
  // Migration 0098's other end of the retention invariant. Withdrawing a
  // receipt reduces what was ever withheld on the Work, and it may not
  // reduce it below what has already been released. The void route checks
  // it first under the bill's lock; this is the arm that holds when a
  // release is recorded between that check and the update.
  '23P08': [
    'RETENTION_RELEASE_STRANDED',
    'A retention release on this Work was recorded against what this receipt withheld. Withdraw the release first, then withdraw this receipt.',
  ],
};

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  // The duplicate-reference index (0067). The route checks it first under
  // the bill lock, so this is the concurrent-insert arm of the same rule.
  if (code === '23505') {
    throw httpError(
      409,
      'BILL_PAYMENT_DUPLICATE_REFERENCE',
      'A live receipt quoting this reference was recorded against this bill first.',
    );
  }
  throw error;
}
