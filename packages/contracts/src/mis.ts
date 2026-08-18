import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, DecimalStringSchema } from './primitives.js';

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
    /** CGST + SGST + IGST, summed by PostgreSQL.
     *
     * It exists because the screen may not add the three arms up itself.
     * A month holding both intra-state and inter-state invoices has a
     * non-zero figure in all three columns, so no single one of them is
     * "the GST" and picking one is wrong for the mixed month — which is
     * exactly the month a management summary is read for. */
    gstTotal: DecimalStringSchema,
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
    /* Read the bands as DAYS SINCE SUBMISSION, inclusive on both ends:
       '0-30' is up to and including the thirtieth day, and '90+' is the
       ninety-FIRST day onwards. The screen prints them as "Over 90 days",
       which is the same statement in words. */
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
    /** How many months of history the monthly series carry.
     *
     * Months WITH DATA, not calendar months: a quiet quarter does not
     * consume three of them. Asking for twelve on a young organisation
     * returns every month it has ever invoiced in, not the last year. */
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
 *
 * The audit trail is NOT here. It is exported by its own route, which
 * carries its own authority, its retention clamp and its filters; naming
 * it here would have put a value in the shared route's parameter that the
 * shared route refuses by design.
 *
 * ## What an export contains
 *
 * THE WHOLE REGISTER, not the screen's current filter state. The screen's
 * filters do not travel: the button says so wherever a filter is active,
 * and `docs/UX.md` § 19 records the decision. The audit register is the
 * one export whose filters DO travel, because a trail without its
 * retention clamp and its date window is not a smaller version of the
 * same document — it is a different one.
 */
export const EXPORTABLE_REGISTERS = [
  'works',
  'delivery-challans',
  'tax-invoices',
  'stock-movements',
  'payments',
  'employees',
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
    // `DateOnlySchema`, not a shape-only pattern. `primitives.ts` states
    // the reason at length: a `\d{4}-\d{2}-\d{2}` pattern admits
    // 2026-02-31, which reaches PostgreSQL as a cast and raises 22008 —
    // a 500 for what is a caller's typo. The shared schema knows the
    // month lengths and the leap years.
    from: DateOnlySchema,
    to: DateOnlySchema,
  },
  { additionalProperties: false },
);
export type TallyExportQuery = Static<typeof TallyExportQuerySchema>;
