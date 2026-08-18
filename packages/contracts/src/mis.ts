import { Type, type Static } from '@sinclair/typebox';
import { DecimalStringSchema } from './primitives.js';

/**
 * The management summary: three aggregates the landing dashboard does not
 * carry, and deliberately only three.
 *
 * `dashboard.ts` beside this file already answers the operational question
 * — what needs attention today, and how far has each Work been executed. It
 * is the screen every session opens with, it already pre-aggregates four
 * evidence tables, and its own comments record the 881 ms it cost to get
 * there. Hanging monthly roll-ups off it would put that work on every
 * sign-in for the benefit of the one person a month who asks.
 *
 * So this is a separate read, and what it adds is what the product could
 * not answer at all:
 *
 *   * **Output tax by month.** The GST liability the organisation has
 *     declared, invoice by invoice, net of credit notes. Every figure is a
 *     frozen snapshot column (0035, 0051) — the same columns the IRP was
 *     told — summed in SQL. Nothing here is recomputed from a rate.
 *   * **Receivables ageing.** The receivables register (0067) lists bills
 *     and their outstanding amounts but has no notion of AGE, so a bill
 *     eleven months unpaid reads exactly like one submitted last week.
 *     This buckets the outstanding money by days since submission.
 *   * **Payroll cost by month.** Finalised runs (0090), rolled up. Gated
 *     on the payroll authority and answered as null without it, rather
 *     than refusing the whole summary — see `hasAuthority` in
 *     `apps/server/src/authz.ts`.
 *
 * Deliberately NOT here: work progress (the dashboard's, unchanged) and
 * stock position (the stock register's, which already reports per-item
 * on-hand quantity and value). A second place to read either would be a
 * second number to reconcile.
 *
 * Every figure is a decimal string summed by PostgreSQL. Nothing in this
 * payload is added up in a browser.
 */

/** `YYYY-MM`. The organisation's own months, resolved in its timezone. */
export const MonthSchema = Type.String({ pattern: '^[0-9]{4}-(?:0[1-9]|1[0-2])$' });

const TaxMonthSchema = Type.Object(
  {
    month: MonthSchema,
    /** Submitted invoices in the month. Cancelled ones are excluded: a
     * cancelled invoice declares no liability. */
    invoiceCount: Type.Integer(),
    taxableValue: DecimalStringSchema,
    cgst: DecimalStringSchema,
    sgst: DecimalStringSchema,
    igst: DecimalStringSchema,
    total: DecimalStringSchema,
    /** Issued credit notes in the same month, as POSITIVE figures. The
     * screen prints them as a deduction; the payload does not pre-net
     * them, because "invoiced 40 lakh, credited 3 lakh" is the sentence an
     * accountant checks and "37 lakh" is not. */
    creditNoteCount: Type.Integer(),
    creditTaxableValue: DecimalStringSchema,
    creditTotal: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type MisTaxMonth = Static<typeof TaxMonthSchema>;

/**
 * One ageing bucket.
 *
 * Age is measured from the bill's SUBMISSION, not from its preparation: a
 * bill the agency has not submitted is not money the railway is late with.
 * Bills with no submission date fall in `unsubmitted`, which is a bucket
 * rather than a hidden row — a prepared bill sitting unsent for four months
 * is the agency's own problem and is exactly the thing a management
 * summary should surface.
 */
const AgeingBucketSchema = Type.Object(
  {
    bucket: Type.Union([
      Type.Literal('unsubmitted'),
      Type.Literal('0-30'),
      Type.Literal('31-60'),
      Type.Literal('61-90'),
      Type.Literal('90+'),
    ]),
    billCount: Type.Integer(),
    /** Summed from `bill_settlement_positions` (0067), which IS the
     * definition of an outstanding figure in this product. A bill whose
     * measurement is not closed has no arithmetic at all and contributes
     * nothing here; it is counted in `indeterminateBills` instead. */
    outstanding: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type MisAgeingBucket = Static<typeof AgeingBucketSchema>;

const PayrollMonthSchema = Type.Object(
  {
    month: MonthSchema,
    runCount: Type.Integer(),
    headcount: Type.Integer(),
    grossPay: DecimalStringSchema,
    deductions: DecimalStringSchema,
    netPay: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type MisPayrollMonth = Static<typeof PayrollMonthSchema>;

export const MisSummaryResponseSchema = Type.Object(
  {
    /** Newest month first, capped at the requested number of months. */
    outputTax: Type.Array(TaxMonthSchema),
    receivablesAgeing: Type.Array(AgeingBucketSchema),
    /** Bills whose Measurement Book is not closed, so the railway has
     * certified no figure and nothing can be outstanding YET. Counted
     * rather than bucketed, because putting an unknown in an ageing table
     * would state an amount the product does not know. */
    indeterminateBills: Type.Integer(),
    /** Null when the caller does not hold the payroll authority. */
    payrollCost: Type.Union([Type.Array(PayrollMonthSchema), Type.Null()]),
  },
  { additionalProperties: false },
);
export type MisSummaryResponse = Static<typeof MisSummaryResponseSchema>;

export const MisSummaryQuerySchema = Type.Object(
  {
    /** How many months of history the monthly series carry. */
    months: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  },
  { additionalProperties: false },
);
export type MisSummaryQuery = Static<typeof MisSummaryQuerySchema>;

/**
 * The registers that can be handed over as a workbook.
 *
 * ONE list, and it is the contract: the server maps each name to the
 * register's own query, and the client renders an export button wherever
 * the name appears. Adding a register is one entry here and one entry in
 * the server's map — not a new route, a new schema and a new API method
 * each time, which is what six separate export endpoints would have been.
 */
export const EXPORTABLE_REGISTERS = [
  'works',
  'delivery-challans',
  'tax-invoices',
  'stock-movements',
  'payments',
  'employees',
  'audit-events',
] as const;
export type ExportableRegister = (typeof EXPORTABLE_REGISTERS)[number];

/**
 * The Tally export's window.
 *
 * Date-only and inclusive, resolved against the organisation's timezone
 * like every other window in the product. Mandatory rather than optional:
 * an accountant imports a PERIOD into Tally, and an export with no window
 * would re-import every voucher the company already holds.
 */
export const TallyExportQuerySchema = Type.Object(
  {
    from: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }),
    to: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }),
  },
  { additionalProperties: false },
);
export type TallyExportQuery = Static<typeof TallyExportQuerySchema>;
