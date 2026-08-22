import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
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
const DashboardBillSettlementSchema = Type.Object(
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
const DashboardAlertSchema = Type.Object(
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

const DashboardWorkProgressSchema = Type.Object(
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

/**
 * The four figures the landing screen leads with, and the counts behind
 * its attention strip.
 *
 * ACTIVE Works only, on purpose. A portfolio's completed and cancelled
 * contracts belong in the register's history; what an operator opens this
 * screen to decide is about the contracts still running, and adding a
 * finished Work's value to the headline makes the headline drift upward
 * forever. `totals` above keeps the whole-portfolio reading for anything
 * that wants it.
 *
 * Every figure here is computed by the server. The browser divides no
 * money and adds no rupees: `activeExecutedPercent` in particular is a
 * cross-Work ratio and each Work's GST basis decides what its contract
 * value is comparable with (migration 0062), which the browser does not
 * know.
 */
const DashboardSignalsSchema = Type.Object(
  {
    /** Works whose status is `active`, the denominator of everything else
     * on this object. */
    activeWorks: Type.Integer({ minimum: 0 }),
    /** The sum of the ACTIVE Works' contract values — the effective value,
     * because `works.contract_value` is the column an amendment moves
     * (migration 0104). Stated on each Work's own basis and added up, the
     * same reading `totals.contractValue` has and for the same recorded
     * reason. */
    activeContractValue: DecimalStringSchema,
    /** Billed value across those same Works, each on its own basis. The
     * companion of `activeContractValue` and on the same mixed footing;
     * NOT the numerator of the percentage below. */
    activeBilledValue: DecimalStringSchema,
    /**
     * THE PAIR THAT SHARES A BASIS WITH THE PERCENTAGE.
     *
     * `activeContractValue` and `activeBilledValue` above are the Works'
     * own printed rupees added up, and on a portfolio mixing GST bases
     * that sum is on no single basis at all — `apps/server/src/routes/
     * dashboard.ts` keeps them that way deliberately, because they are
     * the figures an owner reads off the letters.
     *
     * These two are the same money restated as TAXABLE VALUE first, which
     * `apps/server/src/executed-value.ts` names as the canonical basis for
     * anything aggregating across Works. `activeExecutedPercent` is
     * exactly `activeBilledTaxableValue / activeContractTaxableValue`, so
     * a screen printing all three states one arithmetic a reader can
     * check rather than a ratio that agrees with neither rupee figure
     * beside it.
     */
    activeContractTaxableValue: DecimalStringSchema,
    activeBilledTaxableValue: DecimalStringSchema,
    /** Billed against contract across the active portfolio, every term
     * restated as taxable value first. Null when no active Work carries a
     * contract value. */
    activeExecutedPercent: Type.Union([PercentStringSchema, Type.Null()]),
    /** What the railway still owes across every prepared or submitted
     * bill, summed from `bill_settlement_positions` (migration 0067). */
    receivableOutstanding: DecimalStringSchema,
    /** Bills whose measurement is not closed, so no figure is outstanding
     * against them YET. Counted rather than folded into the sum at zero,
     * because a table that showed them as nil would state an amount
     * nobody knows. */
    receivableIndeterminate: Type.Integer({ minimum: 0 }),
    /** Active Works whose completion date has ARRIVED or PASSED. Counted
     * apart from the ones still ahead of it, because "reaching its
     * completion date in nine days" and "eleven days past it" are not the
     * same sentence and a lamp that merged them said the milder one. */
    completionsOverdue: Type.Integer({ minimum: 0 }),
    /** Active Works reaching their completion date within thirty days and
     * not yet at it — the window a DOC extension needs. */
    completionsDue: Type.Integer({ minimum: 0 }),
    /** Active instruments — PBG, PAC, DOC — whose expiry date has already
     * passed while the instrument is still recorded active. A terminal
     * state, not a countdown: the ninety-day strip is forward-only and
     * cannot show these, so the landing screen states them in words. */
    instrumentsExpired: Type.Integer({ minimum: 0 }),
    /** Active instruments expiring within the sixty-day warning window and
     * not yet past it. */
    instrumentsExpiring: Type.Integer({ minimum: 0 }),
    /** Issued documents queued for the signing kiosk and still waiting on
     * it: `pending` or `claimed`, which is what migration 0091 calls open.
     * `failed` is deliberately NOT counted — a failed attempt is a
     * terminal row that the signing queue itself surfaces, and folding it
     * into "waiting to be signed" would report a document as queued when
     * nothing is going to pick it up. */
    unsignedDocuments: Type.Integer({ minimum: 0 }),
    /** True when the caller's membership is limited to assigned Works, so
     * every figure above describes their slice rather than the
     * organisation. The screen says so rather than letting a scoped member
     * read a portfolio total that is not the portfolio. */
    assignedScopeOnly: Type.Boolean(),
    /**
     * The earliest month this application holds any billing evidence for
     * — the earlier of the first submitted invoice's month and the first
     * recorded receipt's month — as `YYYY-MM`, or null when it holds
     * none.
     *
     * The billing chart needs it to tell a quiet quarter from a cutover.
     * An organisation that started using this product in 2026-08 has ten
     * empty months at the head of a trailing year, and without this the
     * screen states a collapse that never happened; the earlier history
     * is in the Historical invoices register (migration 0115).
     */
    billingSince: Type.Union([
      Type.String({ pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type DashboardSignals = Static<typeof DashboardSignalsSchema>;

/** One active Work approaching its completion date, with the figure an
 * extension conversation is argued from. Soonest first. */
const DashboardCompletionSchema = Type.Object(
  {
    workId: UuidSchema,
    workCode: Type.String(),
    title: Type.String(),
    dueOn: DateOnlySchema,
    /** Days until the completion date; negative when it has passed. */
    dueInDays: Type.Integer(),
    /** Billed against contract on this Work's own basis. Null when the
     * contract value is zero. */
    executedPercent: Type.Union([PercentStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardCompletion = Static<typeof DashboardCompletionSchema>;

/**
 * One month of the billed-against-received pair, oldest first, twelve
 * entries ending with the current month. Calendar months, including the
 * quiet ones: a gap in a time series is a hole in the reader's mental
 * picture, not an economy.
 *
 * BOTH FIGURES ARE GST-INCLUSIVE, which is what makes them comparable on
 * one axis. `billed` is the tax invoices this organisation submitted, net
 * of the credit notes that reverse them; `received` is what reached the
 * bank, and a bank credit is always GST-inclusive (migration 0067).
 * Measurement-Book bill totals are deliberately NOT added in: a bill and
 * the invoice raised against its measurement state the same measured
 * value on two different bases, so adding them would both double-count
 * and mix bases — the mistake `docs/PRODUCT.md` §5.2 names.
 *
 * EVERY invoice, including the DIRECT ones that belong to no Work
 * (migration 0039). "The tax invoices this organisation submitted" has to
 * mean all of them or the sentence is false, and an agency invoicing
 * private customers beside its railway contracts would watch a third of
 * its billing vanish from its own landing screen.
 *
 * The two series are therefore NOT symmetrical, and the screen says so
 * rather than leaving it to be discovered. A receipt in this product is
 * recorded against a prepared BILL (`bill_payments.bill_id`, migration
 * 0067), and a direct invoice has no bill — so money received against one
 * is not held anywhere and cannot join `received`. The gap between the
 * series is an upper bound on what is outstanding, never a measurement of
 * it; `signals.receivableOutstanding` is the measured figure and reads
 * the settlement register.
 */
const DashboardBillingMonthSchema = Type.Object(
  {
    /** `YYYY-MM`, the document's own month rather than a timezone reading
     * of a timestamp: both dates behind it are date-only legal values. */
    month: Type.String({ pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' }),
    /** Submitted and superseded invoices less issued credit notes. May be
     * negative in a month whose credit notes exceed its invoices. */
    billed: DecimalStringSchema,
    received: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type DashboardBillingMonth = Static<typeof DashboardBillingMonthSchema>;

/** One active Work's execution against its contract value, ordered by
 * nearest completion date. Both percentages are computed on the Work's
 * own GST basis by the server. */
const DashboardWorkExecutionSchema = Type.Object(
  {
    workId: UuidSchema,
    workCode: Type.String(),
    title: Type.String(),
    /** Value on issued delivery challans against contract value. */
    suppliedPercent: Type.Union([PercentStringSchema, Type.Null()]),
    /** Value of recorded installations — quantity at the accepted rate
     * (migration 0063) — against contract value. */
    installedPercent: Type.Union([PercentStringSchema, Type.Null()]),
    /** The Work's current completion date, null where none is recorded. */
    dueOn: Type.Union([DateOnlySchema, Type.Null()]),
    dueInDays: Type.Union([Type.Integer(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type DashboardWorkExecution = Static<typeof DashboardWorkExecutionSchema>;

/** One dated obligation inside the next ninety days. The three kinds are
 * the three clocks a works contract runs on at once. */
const DashboardDeadlineSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('completion'),
      Type.Literal('instrument'),
      Type.Literal('defect_liability'),
    ]),
    workId: UuidSchema,
    workCode: Type.String(),
    /** What expires: "Completion", "PBG BG/22", "Defect liability". */
    label: Type.String({ minLength: 1, maxLength: 220 }),
    dueOn: DateOnlySchema,
    dueInDays: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type DashboardDeadline = Static<typeof DashboardDeadlineSchema>;

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
    signals: DashboardSignalsSchema,
    alerts: Type.Array(DashboardAlertSchema),
    /** Every Work the caller may see, whatever its status. The landing
     * screen no longer LISTS them (`docs/UX.md` § 38 — the Works register
     * is one click away in the rail and does the job better), but the
     * totals above are summed from these rows and the first-run checklist
     * keys off the array being empty, so it stays in the payload. */
    works: Type.Array(DashboardWorkProgressSchema),
    /** Active Works inside the sixty-day completion window, soonest
     * first. Thirty days or less is the danger reading; the next thirty
     * are the caution. */
    completions: Type.Array(DashboardCompletionSchema),
    /** Trailing twelve calendar months of billed against received. */
    monthlyBilling: Type.Array(DashboardBillingMonthSchema),
    /** Active Works by nearest completion date, with supply and
     * installation against contract value. */
    execution: Type.Array(DashboardWorkExecutionSchema),
    /** Dated obligations inside the next ninety days, soonest first. */
    deadlines: Type.Array(DashboardDeadlineSchema),
  },
  { additionalProperties: false },
);
export type DashboardResponse = Static<typeof DashboardResponseSchema>;
