import { Type, type Static } from '@sinclair/typebox';
import {
  DecimalStringSchema,
  GstRateSchema,
  NonNegativeMoneyStringSchema,
  PercentStringSchema,
  PositiveMoneyStringSchema,
  UuidSchema,
} from './primitives.js';
import { GstBasisSchema } from './works.js';

/**
 * The settlement position behind a bill alert, read from
 * `bill_settlement_positions` (migration 0067) and never re-derived.
 *
 * Carried as figures rather than written into the alert's sentence for two
 * reasons. A client can render money in the tabular mono the rest of this
 * product uses for it, which prose cannot be styled into; and nothing has
 * to parse rupees back out of an English sentence to compare or total
 * them. `docs/PRODUCT.md` §5.7 states what the three mean and why money
 * the railway KEPT is settled money rather than missing money.
 */
export const DashboardBillSettlementSchema = Type.Object(
  {
    /** The railway's own On-Account Bill amount — the reference the
     * position is measured against, GST-inclusive, never the prepared
     * total. Null while the measurement is still open, which is exactly
     * when `outstanding` is null. */
    reference: Type.Union([PositiveMoneyStringSchema, Type.Null()]),
    /** What reached the bank across the bill's live receipts. */
    received: NonNegativeMoneyStringSchema,
    /** What the railway kept: GST TDS, income-tax TDS, retention,
     * penalties and described others. Settled money. */
    deducted: NonNegativeMoneyStringSchema,
    /** reference − received − deducted, or null when there is no agreed
     * figure to be outstanding against yet. */
    outstanding: Type.Union([DecimalStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardBillSettlement = Static<typeof DashboardBillSettlementSchema>;

/** One actionable item on the dashboard.
 *
 * The array is ordered most urgent first: `danger`, then `warning`, then
 * `notice`, and within a severity in the order the server built it —
 * soonest expiry, then work code and bill number. A client that shows only
 * the head of the list can rely on that, which is the point of ranking it
 * on the server rather than leaving each client to sort or not. */
export const DashboardAlertSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('instrument_expired'),
      Type.Literal('instrument_expiring'),
      Type.Literal('completion_overdue'),
      Type.Literal('completion_due'),
      Type.Literal('loa_review_pending'),
      Type.Literal('challan_draft_open'),
      /** A bill with a railway figure against it and nothing at all
       * recorded — the whole amount is still to come. */
      Type.Literal('bill_unpaid'),
      /** Some of the railway's figure has arrived or been withheld and
       * some has not — the case `bill_unpaid` used to absorb. */
      Type.Literal('bill_part_settled'),
      /** Receipts and deductions reach the railway's figure exactly, but
       * the bill has not been moved to `paid`. Nothing to chase. */
      Type.Literal('bill_fully_settled'),
      /** The measurement is not closed, so there is no agreed figure to
       * be outstanding against and no payment can be recorded. */
      Type.Literal('bill_awaiting_closure'),
      Type.Literal('pbg_missing'),
      Type.Literal('pbg_undervalue'),
      Type.Literal('pbg_window_missed'),
      Type.Literal('irp_reporting_due'),
      Type.Literal('irp_reporting_overdue'),
    ]),
    severity: Type.Union([
      Type.Literal('danger'),
      Type.Literal('warning'),
      Type.Literal('notice'),
    ]),
    message: Type.String({ minLength: 1, maxLength: 500 }),
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
    /** Days until the referenced due date; negative when overdue. */
    dueInDays: Type.Union([Type.Integer(), Type.Null()]),
    /** The three figures behind a bill alert, null on every alert that is
     * not about one. Nullable rather than optional, like `workId` and
     * `dueInDays` above: an alert states every field it has, and a new
     * kind is then made to decide what it says here. */
    settlement: Type.Union([DashboardBillSettlementSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardAlert = Static<typeof DashboardAlertSchema>;

export const DashboardWorkProgressSchema = Type.Object(
  {
    workId: UuidSchema,
    workCode: Type.String(),
    title: Type.String(),
    status: Type.Union([
      Type.Literal('active'),
      Type.Literal('completed'),
      Type.Literal('cancelled'),
    ]),
    contractValue: DecimalStringSchema,
    /** Value of goods on issued (non-cancelled) challans, exact SQL sum. */
    deliveredValue: DecimalStringSchema,
    /** Value measured into the MB and swept into bills. */
    billedValue: DecimalStringSchema,
    /** The GST basis every money figure on this row is stated on —
     * `contractValue`, `deliveredValue` and `billedValue` alike, since all
     * three derive from the LOA's own rates (migration 0062). Carried so
     * the screen can LABEL the figures rather than leave the reader to
     * assume, and so no client is tempted to compare them with a figure
     * from elsewhere without converting. */
    gstBasis: GstBasisSchema,
    gstRate: GstRateSchema,
    /** Billed value as a percentage of the contract value, to four
     * decimal places, computed on this Work's recorded basis by
     * apps/server/src/executed-value.ts. Null when the contract value is
     * zero — a percentage of nothing is not 0%.
     *
     * Computed on the SERVER, deliberately. This is the number work
     * completion is discussed against, and dividing two money strings in
     * the browser was both a float division and a place where the basis
     * was invisible. */
    executedPercent: Type.Union([PercentStringSchema, Type.Null()]),
    issuedChallans: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type DashboardWorkProgress = Static<typeof DashboardWorkProgressSchema>;

export const DashboardResponseSchema = Type.Object(
  {
    totals: Type.Object(
      {
        works: Type.Integer({ minimum: 0 }),
        /** The Works' own printed figures, added up — each Work states
         * these on its OWN GST basis, so on a portfolio mixing bases the
         * sum is not on any single one. Left that way on purpose: see the
         * note in apps/server/src/routes/dashboard.ts. Use
         * `executedPercent` for the ratio, which does normalise. */
        contractValue: DecimalStringSchema,
        deliveredValue: DecimalStringSchema,
        billedValue: DecimalStringSchema,
        /** Billed against contract across every Work, to four decimal
         * places, with every term restated as taxable value first so that
         * Works quoting inclusive rates and Works quoting exclusive ones
         * aggregate coherently. Null when no Work carries a contract
         * value. */
        executedPercent: Type.Union([PercentStringSchema, Type.Null()]),
        openDrafts: Type.Integer({ minimum: 0 }),
        loaAwaitingReview: Type.Integer({ minimum: 0 }),
        /** Submitted invoices carrying a frozen IRP reporting deadline
         * (migration 0049) that are not yet registered: `Due` counts
         * those whose window is still open in the organisation's own
         * timezone, `Overdue` those whose window has closed. Local
         * validity is untouched either way. */
        irpReportingDue: Type.Integer({ minimum: 0 }),
        irpReportingOverdue: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    alerts: Type.Array(DashboardAlertSchema),
    works: Type.Array(DashboardWorkProgressSchema),
  },
  { additionalProperties: false },
);
export type DashboardResponse = Static<typeof DashboardResponseSchema>;
