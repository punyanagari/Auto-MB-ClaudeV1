import { Type, type Static } from '@sinclair/typebox';
import {
  DecimalStringSchema,
  GstRateSchema,
  PercentStringSchema,
  UuidSchema,
} from './primitives.js';
import { GstBasisSchema } from './works.js';

/** One actionable item on the dashboard, ordered most urgent first. */
export const DashboardAlertSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('instrument_expired'),
      Type.Literal('instrument_expiring'),
      Type.Literal('completion_overdue'),
      Type.Literal('completion_due'),
      Type.Literal('loa_review_pending'),
      Type.Literal('challan_draft_open'),
      Type.Literal('bill_unpaid'),
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
