import { Type, type Static } from '@sinclair/typebox';
import {
  NonNegativeDecimalStringSchema,
  NonNegativeMoneyStringSchema,
  NonNegativeRateStringSchema,
  UuidSchema,
} from './primitives.js';

/**
 * Works analysis: three reports that answer "what is still owed, and what
 * is still owed to us", per Work, per railway division, and per item across
 * the whole portfolio.
 *
 * `mis.ts` beside this file is the MONTHLY position — output tax,
 * receivables ageing, payroll. This is the QUANTITY position, which the
 * product could previously only answer one Work and one screen at a time:
 * the Work workspace shows a ledger per Work, and an operator ordering
 * material for four Works of one division had to open four screens and add
 * up by hand. The whole point of the division and cross-Work reports is
 * that the adding up happens in PostgreSQL.
 *
 * ## Every figure here is computed by the server
 *
 * Quantities are exact decimal strings at the scale their columns hold
 * (3dp), money at the scale `money_amount` holds (2dp), rates at
 * `numeric(18,6)`. Nothing in this payload is added up in a browser —
 * `AGENTS.md` rule 5 and the same rule `mis.ts` records.
 *
 * ## What the pending figures mean, stated once
 *
 *   * **Sanctioned quantity** is `coalesce(effective_quantity,
 *     awarded_quantity)` — the LOA quantity as amendments have left it.
 *   * **Pending to supply** is sanctioned minus delivered, floored at
 *     zero. The Work's excess-delivery toggle lifts the DELIVERY CAP and
 *     nothing else (migration 0056), so a Work delivered beyond sanction
 *     has nothing pending rather than a negative figure.
 *   * **Pending to install** is sanctioned minus installed, floored at
 *     zero. Installation carries no database ceiling since migration 0077
 *     — over-installation sets `pending_variation` instead — so
 *     `installedAboveSanctionedQuantity` reports the overrun explicitly
 *     rather than letting a floored subtraction hide it.
 *   * **Supplied but not installed** is delivered minus installed, floored
 *     at zero: the material that has left the store and is not yet in the
 *     ground.
 *   * **Pending to inspect** is the inspection clause's own quantity
 *     (migration 0082) minus what has been offered on calls. An item with
 *     no clause quantity reports null, not zero — "no clause" and "nothing
 *     left to inspect" are different answers.
 *
 * ## Two exclusions and one inclusion, all deliberate
 *
 * **Locked billing-baseline priors are INCLUDED** in delivered, installed
 * and billed positions. A Work imported at cutover carries its opening
 * position in `work_billing_baselines` (migration 0114); a report that
 * ignored it would show years of executed work as still pending. Only
 * LOCKED baselines count, which is what the lock means. Every row carries
 * the baseline component separately so a reader can see it.
 *
 * **Historical invoices are EXCLUDED** from every payment figure. The
 * imported register (migration 0115) is display-only history carrying
 * disputed flags; it is not the bill ledger, and folding it into an
 * outstanding position would mix an assertion about the past with a claim
 * about the present.
 *
 * **Payment is reported per BILL, never per item.** There is no per-item
 * payment anywhere in this product: a receipt settles a bill, and a bill
 * closes a Measurement Book covering many items. Apportioning a receipt
 * across the items of its Measurement Book would produce a per-item
 * "amount paid" that no document supports. So an item reports what it has
 * been BILLED (an exact figure, from finalized Measurement Book lines) and
 * what it has EXECUTED but not yet billed; the money actually received sits
 * in the bill section, where it is a fact.
 */

/* --- report A: one Work ---------------------------------------------- */

/** Which inspecting agency a clause names (migration 0082). */
export const InspectionAgencySchema = Type.Union([
  Type.Literal('RDSO'),
  Type.Literal('RITES'),
  Type.Literal('consignee'),
]);
export type WorksAnalysisInspectionAgency = Static<typeof InspectionAgencySchema>;

const WorkAnalysisItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    description: Type.String(),
    unitCode: Type.String(),
    /** `coalesce(effective_unit_rate, effective_rate)` — the accepted rate. */
    rate: NonNegativeRateStringSchema,

    sanctionedQuantity: NonNegativeDecimalStringSchema,
    sanctionedValue: NonNegativeMoneyStringSchema,
    deliveredQuantity: NonNegativeDecimalStringSchema,
    deliveredValue: NonNegativeMoneyStringSchema,
    installedQuantity: NonNegativeDecimalStringSchema,
    installedValue: NonNegativeMoneyStringSchema,

    pendingSupplyQuantity: NonNegativeDecimalStringSchema,
    pendingSupplyValue: NonNegativeMoneyStringSchema,
    pendingInstallQuantity: NonNegativeDecimalStringSchema,
    pendingInstallValue: NonNegativeMoneyStringSchema,
    suppliedNotInstalledQuantity: NonNegativeDecimalStringSchema,
    suppliedNotInstalledValue: NonNegativeMoneyStringSchema,
    /** Installed beyond sanction. Non-zero only where migration 0077's
     * `pending_variation` is set; reported rather than floored away. */
    installedAboveSanctionedQuantity: NonNegativeDecimalStringSchema,

    /** The locked baseline's share of the two figures above it, so a
     * reader can tell an opening position from this product's own record. */
    baselineSuppliedQuantity: NonNegativeDecimalStringSchema,
    baselineInstalledQuantity: NonNegativeDecimalStringSchema,

    inspectionAgency: Type.Union([InspectionAgencySchema, Type.Null()]),
    /**
     * The contract LOT SIZE, where the clause names one.
     *
     * Reported because an operator raising a call wants it, and named for
     * what it is. Migration 0082 is explicit that it is a hint the
     * raise-a-call form defaults to and that "the dispatch gate never reads
     * it", so nothing here treats it as a target: an item whose lot size is
     * 10 is not an item with 10 left to inspect.
     */
    inspectionLotSize: Type.Union([NonNegativeDecimalStringSchema, Type.Null()]),
    /** Whether this clause interlocks despatch. A clause that does not gate
     * still has an inspection position; nothing is blocked by it. */
    gatesDispatch: Type.Boolean(),
    /** Offered on calls of the clause's OWN agency that were not cancelled.
     * A RITES call answers nothing about an RDSO clause, which is the join
     * `inspection_dispatch_shortfall` makes and this read repeats. */
    inspectionCalledQuantity: NonNegativeDecimalStringSchema,
    /**
     * What a LIVE certificate of the clause's own agency covers — the
     * dispatch gate's own `certified` figure, through the shared
     * `app_private.inspection_certificate_live`, resolved against the
     * organisation's today rather than UTC's.
     *
     * The difference from `inspectionCalledQuantity` is the difference
     * between "an agency has seen it" and "a lorry may leave": a call whose
     * certificate has expired counts in the first and not the second.
     */
    inspectionCertifiedQuantity: NonNegativeDecimalStringSchema,
    /**
     * How much still needs a live certificate before the whole sanctioned
     * quantity could be despatched: sanctioned less certified, floored at
     * zero.
     *
     * Null where the item carries no clause, and null for a `consignee`
     * clause — that inspection happens after arrival, can never gate
     * despatch (0082's CHECK), and raises no calls to be covered by, so a
     * figure here would be the sanctioned quantity dressed up as a backlog.
     */
    pendingInspectionQuantity: Type.Union([
      NonNegativeDecimalStringSchema,
      Type.Null(),
    ]),
    pendingInspectionValue: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),

    /** Billed: finalized Measurement Book lines plus the locked baseline's
     * opening amount. An exact figure from stored snapshots. */
    billedValue: NonNegativeMoneyStringSchema,
    /**
     * What a next Measurement Book would bill: the payment-matrix
     * entitlement of the quantities the books have NOT yet taken, stage by
     * stage, each rounded the way `computeStageAmounts` rounds a book's own
     * delta.
     *
     * Computed from the leftover rather than by re-deriving the whole
     * entitlement from the cumulative quantity and subtracting. The two
     * differ by a rounding ghost: three books billing one metre each at
     * 0.334 round to 0.33 apiece and have billed 0.99, while
     * `round(3 x 0.334, 2)` is 1.00 — so the re-derivation leaves a penny
     * outstanding on a fully billed item that no Measurement Book could
     * ever raise. Sharing the books' own rounding basis makes a fully
     * billed item read exactly zero.
     *
     * Null where the item's payment category resolves through no matrix row
     * — there is then no percentage to bill at, and a zero would read as
     * "nothing owed" rather than "the matrix is incomplete".
     */
    unbilledExecutedValue: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
    /**
     * Billed plus unbilled: everything this item has earned so far.
     *
     * The SUPPLY, INSTALLATION and PAC stages only. The final-bill stage is
     * excluded because `computeStageAmounts` earns it only on the FINAL
     * Measurement Book — a manual act, not a quantity threshold — so
     * nothing here can honestly say it is owed yet. Both documents say so
     * in their notes.
     */
    executedValue: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkAnalysisItem = Static<typeof WorkAnalysisItemSchema>;

const WorkAnalysisTotalsSchema = Type.Object(
  {
    itemCount: Type.Integer(),
    sanctionedValue: NonNegativeMoneyStringSchema,
    deliveredValue: NonNegativeMoneyStringSchema,
    installedValue: NonNegativeMoneyStringSchema,
    pendingSupplyValue: NonNegativeMoneyStringSchema,
    pendingInstallValue: NonNegativeMoneyStringSchema,
    suppliedNotInstalledValue: NonNegativeMoneyStringSchema,
    pendingInspectionValue: NonNegativeMoneyStringSchema,
    billedValue: NonNegativeMoneyStringSchema,
    unbilledExecutedValue: NonNegativeMoneyStringSchema,
    /** Items whose payment category resolves through no matrix row, and
     * whose executed value is therefore unknown rather than zero. */
    itemsWithoutMatrixRow: Type.Integer(),
  },
  { additionalProperties: false },
);
export type WorkAnalysisTotals = Static<typeof WorkAnalysisTotalsSchema>;

const WorkAnalysisInspectionGroupSchema = Type.Object(
  {
    agency: Type.Union([InspectionAgencySchema, Type.Null()]),
    itemCount: Type.Integer(),
    /** The lot sizes summed. A hint's total is still only a hint; it is
     * here so the column has a footer, not as a target. */
    lotSizeTotal: NonNegativeDecimalStringSchema,
    calledQuantity: NonNegativeDecimalStringSchema,
    certifiedQuantity: NonNegativeDecimalStringSchema,
    pendingQuantity: NonNegativeDecimalStringSchema,
    pendingValue: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type WorkAnalysisInspectionGroup = Static<
  typeof WorkAnalysisInspectionGroupSchema
>;

const WorkAnalysisBillSchema = Type.Object(
  {
    billId: UuidSchema,
    billNumber: Type.String(),
    status: Type.String(),
    /** What the agency prepared, on the Work's recorded GST basis. */
    preparedAmount: NonNegativeMoneyStringSchema,
    /** The railway's own figure, GST-inclusive. Null while the
     * measurement is not closed, and while it is null the bill's
     * outstanding position is not yet knowable. */
    railwayBillAmount: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
    receivedTotal: NonNegativeMoneyStringSchema,
    deductionTotal: NonNegativeMoneyStringSchema,
    outstandingAmount: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkAnalysisBill = Static<typeof WorkAnalysisBillSchema>;

const WorkAnalysisPaymentSchema = Type.Object(
  {
    billCount: Type.Integer(),
    railwayTotal: NonNegativeMoneyStringSchema,
    /** Money that arrived, plus money the railway kept. Both are settled:
     * a statutory deduction is not an amount still owed (migration 0067). */
    receivedTotal: NonNegativeMoneyStringSchema,
    deductionTotal: NonNegativeMoneyStringSchema,
    settledTotal: NonNegativeMoneyStringSchema,
    outstandingTotal: NonNegativeMoneyStringSchema,
    /** Bills whose measurement is not closed, so nothing is outstanding
     * yet and their amounts are absent from the totals above. */
    indeterminateBills: Type.Integer(),
  },
  { additionalProperties: false },
);
export type WorkAnalysisPayment = Static<typeof WorkAnalysisPaymentSchema>;

/**
 * How a Work's railway division was arrived at.
 *
 * There is no `works.client_contact_id` in this schema, so the division is
 * DERIVED and the report says how. The evidence is `work_consignees`: the
 * railway offices the Work is executed for, chosen by the operator on the
 * Work's own Consignees screen, and the `division_code` recorded on each of
 * those contacts.
 *
 * Not the delivery challans, which would have been the obvious source and
 * is the wrong one: `delivery_challans_kind_shape` (migration 0056)
 * constrains a WORK challan's `consignee_contact_id` to NULL — only a
 * standalone challan carries one, and a standalone challan has no Work.
 *
 *   * `consignee` — exactly one distinct division code across that
 *     evidence, and it is the Work's division.
 *   * `ambiguous` — several distinct codes. The Work groups under "no
 *     division on record" rather than under a code chosen by tie-break,
 *     and `divisionCandidates` lists what was found so an operator can fix
 *     the contact master rather than guess which report is wrong.
 *   * `none` — no evidence carries a division code at all.
 */
export const DivisionSourceSchema = Type.Union([
  Type.Literal('consignee'),
  Type.Literal('ambiguous'),
  Type.Literal('none'),
]);
export type WorksAnalysisDivisionSource = Static<typeof DivisionSourceSchema>;

export const WorkAnalysisResponseSchema = Type.Object(
  {
    work: Type.Object(
      {
        id: UuidSchema,
        workCode: Type.String(),
        title: Type.String(),
        status: Type.String(),
        contractValue: NonNegativeMoneyStringSchema,
        /** Reported because it changes what "pending to supply" means for
         * a reader: with it on, delivery may exceed sanction. */
        allowExcessDelivery: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    divisionCode: Type.Union([Type.String(), Type.Null()]),
    divisionSource: DivisionSourceSchema,
    divisionCandidates: Type.Array(Type.String()),
    /** Whether a LOCKED billing baseline contributed to the positions
     * below. The screen and the PDF say so where it is true. */
    baselineLocked: Type.Boolean(),
    items: Type.Array(WorkAnalysisItemSchema),
    totals: WorkAnalysisTotalsSchema,
    inspection: Type.Array(WorkAnalysisInspectionGroupSchema),
    bills: Type.Array(WorkAnalysisBillSchema),
    payment: WorkAnalysisPaymentSchema,
  },
  { additionalProperties: false },
);
export type WorkAnalysisResponse = Static<typeof WorkAnalysisResponseSchema>;

/* --- reports B and C: combined pending across Works ------------------- */

/**
 * One combined pending line.
 *
 * ## What may combine, and what may not
 *
 * Lines combine EXACTLY where an item-master mapping exists — a live work
 * item whose normalised description equals an active `canonical_items`
 * name or one of its aliases (migration 0078; the mapping is derived, not
 * stored, and `routes/masters.ts` records why). Two lines that merely look
 * alike are never merged: they are offered as a PROPOSAL the operator
 * confirms, and confirming one writes the wording into the item master's
 * aliases, which is what makes the mapping exist.
 *
 * **The group key carries the UNIT.** A canonical item quantified in both
 * `nos` and `m` produces two rows, never one, because adding metres to
 * pieces produces a number that is wrong in a way no footnote repairs.
 *
 * **Rates are reported as a SPREAD, not averaged.** Two Works of the same
 * division rarely carry the same accepted rate for the same product, and
 * a single figure would invent one. `rateLow` and `rateHigh` are equal
 * where every line agrees, and the screen shows a range where they differ.
 * The VALUE columns are summed from each line's own rate, so a spread
 * never makes a total wrong.
 */
const CombinedPendingRowSchema = Type.Object(
  {
    /** The canonical item this row combines, or null where the row is one
     * unmapped work-item description standing alone. */
    canonicalItemId: Type.Union([UuidSchema, Type.Null()]),
    label: Type.String(),
    groupName: Type.Union([Type.String(), Type.Null()]),
    unitCode: Type.String(),
    rateLow: NonNegativeRateStringSchema,
    rateHigh: NonNegativeRateStringSchema,
    workCount: Type.Integer(),
    lineCount: Type.Integer(),
    sanctionedQuantity: NonNegativeDecimalStringSchema,
    deliveredQuantity: NonNegativeDecimalStringSchema,
    installedQuantity: NonNegativeDecimalStringSchema,
    pendingSupplyQuantity: NonNegativeDecimalStringSchema,
    pendingSupplyValue: NonNegativeMoneyStringSchema,
    pendingInstallQuantity: NonNegativeDecimalStringSchema,
    pendingInstallValue: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type CombinedPendingRow = Static<typeof CombinedPendingRowSchema>;

const CombinedPendingTotalsSchema = Type.Object(
  {
    rowCount: Type.Integer(),
    mappedRowCount: Type.Integer(),
    /**
     * The schedule LINES under these rows, which is what the Lines column
     * totals to.
     *
     * `rowCount` is a different number wearing the same heading: a row is a
     * master item and a line is a schedule entry, and one row of three
     * lines makes them disagree — which is precisely the row an item
     * catalogue exists to produce.
     */
    lineCount: Type.Integer(),
    pendingSupplyValue: NonNegativeMoneyStringSchema,
    pendingInstallValue: NonNegativeMoneyStringSchema,
  },
  { additionalProperties: false },
);
export type CombinedPendingTotals = Static<typeof CombinedPendingTotalsSchema>;

const DivisionGroupSchema = Type.Object(
  {
    divisionCode: Type.Union([Type.String(), Type.Null()]),
    divisionSource: DivisionSourceSchema,
    works: Type.Array(
      Type.Object(
        {
          id: UuidSchema,
          workCode: Type.String(),
          title: Type.String(),
          divisionSource: DivisionSourceSchema,
          divisionCandidates: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    rows: Type.Array(CombinedPendingRowSchema),
    totals: CombinedPendingTotalsSchema,
  },
  { additionalProperties: false },
);
export type DivisionGroup = Static<typeof DivisionGroupSchema>;

export const DivisionAnalysisResponseSchema = Type.Object(
  {
    divisions: Type.Array(DivisionGroupSchema),
    totals: CombinedPendingTotalsSchema,
  },
  { additionalProperties: false },
);
export type DivisionAnalysisResponse = Static<typeof DivisionAnalysisResponseSchema>;

export const MappedItemAnalysisResponseSchema = Type.Object(
  {
    rows: Type.Array(CombinedPendingRowSchema),
    /**
     * The mapped and unmapped rows total SEPARATELY, because the screen and
     * both documents draw them as two tables. A single total under the
     * mapped table that had swept the unmapped rows in would be a figure
     * the rows above it do not add up to — the one arithmetic error a
     * reader cannot catch by looking.
     */
    mappedTotals: CombinedPendingTotalsSchema,
    unmappedTotals: CombinedPendingTotalsSchema,
    /** Both together, for the report's own header. */
    totals: CombinedPendingTotalsSchema,
    /** Live schedule lines matching no active canonical item — the same
     * figure as `unmappedTotals.lineCount`, carried here because the screen
     * prints it above the proposals rather than in a table footer. */
    unmappedLineCount: Type.Integer(),
  },
  { additionalProperties: false },
);
export type MappedItemAnalysisResponse = Static<
  typeof MappedItemAnalysisResponseSchema
>;

/* --- the proposals -------------------------------------------------- */

/**
 * A proposed item group: several unmapped descriptions that differ only in
 * punctuation, spacing or case.
 *
 * **A proposal writes nothing.** It is a read, offered so an operator can
 * confirm it, and confirming it is `POST /api/masters/canonical-items`
 * with the proposed name and the other wordings as aliases — the mapping
 * this product already has, reached through the control it already has.
 * There is no third state and no table of half-agreed groups.
 *
 * The comparison is deliberately NOT fuzzy. `routes/masters.ts` records
 * that trigram and embedding matching is the upgrade path and belongs
 * behind a review step; this is that review step, and its key is the one
 * an operator can verify by eye — the description lowercased, its
 * punctuation dropped and its whitespace collapsed. A proposal that a
 * human cannot check is worse than none.
 */
const ItemGroupProposalSchema = Type.Object(
  {
    /** The normalised key the members share. Stable, so a screen can key
     * a list on it and a reviewer can see WHY the group was proposed. */
    key: Type.String(),
    /** The wording carried by the most lines; the one to name the item. */
    proposedName: Type.String(),
    /** The other wordings, which become the item's aliases. */
    aliases: Type.Array(Type.String()),
    /** Every unit the members carry. More than one is a warning, not a
     * blocker: the operator may be looking at a genuine data error. */
    unitCodes: Type.Array(Type.String()),
    rateLow: NonNegativeRateStringSchema,
    rateHigh: NonNegativeRateStringSchema,
    lineCount: Type.Integer(),
    workCount: Type.Integer(),
  },
  { additionalProperties: false },
);
export type ItemGroupProposal = Static<typeof ItemGroupProposalSchema>;

export const ItemGroupProposalsResponseSchema = Type.Object(
  { proposals: Type.Array(ItemGroupProposalSchema) },
  { additionalProperties: false },
);
export type ItemGroupProposalsResponse = Static<
  typeof ItemGroupProposalsResponseSchema
>;

/* --- the documents --------------------------------------------------- */

/**
 * The three reports, as a closed set.
 *
 * ONE list, and it is the contract, exactly as `EXPORTABLE_REGISTERS` is
 * for the register workbooks: the PDF route and the workbook route both
 * take this parameter, so a report is one entry here and one descriptor on
 * the server rather than six endpoints that drift apart.
 */
export const WORKS_ANALYSIS_REPORTS = ['work', 'division', 'mapped-item'] as const;
export type WorksAnalysisReport = (typeof WORKS_ANALYSIS_REPORTS)[number];

/**
 * The columns an operator may leave out of a report, named by their column
 * HEADER.
 *
 * The header is the one vocabulary the screen, the PDF and the workbook
 * already share — `works-analysis-document.ts` builds every table from
 * `{ header }` descriptors and the screen prints the same words in its
 * `<th>`s — so a chosen column set travels as a list of headings rather
 * than as a third set of machine names nobody can read in a URL.
 *
 * Only the columns listed here can be dropped. The identity columns —
 * Item, Description, Bill, Agency, Month — are deliberately absent: a
 * report without the thing each row IS is not a narrower report, it is an
 * unreadable one. The server enforces that by dropping only headers it
 * finds in this list.
 *
 * `byDefault` is the set an operator ORDERING MATERIAL wants: what is
 * sanctioned, what has been supplied, and what is still pending. The
 * execution and billing positions are context for that figure rather than
 * the figure, so they start off and are one tap away.
 */
export interface WorksAnalysisColumn {
  readonly header: string;
  readonly byDefault: boolean;
}

/**
 * The Work report chips the QUANTITY and VALUE tables only.
 *
 * Its inspection and payment tables answer different questions with their
 * own vocabulary, and a chip row long enough to cover all four would be a
 * wall of thirty toggles rather than a control. Nothing in those two
 * tables shares a heading with anything here, so they are never touched.
 */
const WORK_COLUMNS: readonly WorksAnalysisColumn[] = [
  { header: 'Unit', byDefault: true },
  { header: 'Rate', byDefault: true },
  { header: 'Sanctioned', byDefault: true },
  { header: 'Supplied', byDefault: true },
  { header: 'Installed', byDefault: false },
  { header: 'Pending to supply', byDefault: true },
  { header: 'Pending to install', byDefault: true },
  { header: 'Supplied, not installed', byDefault: false },
  { header: 'Installed above sanction', byDefault: false },
  { header: 'Billed', byDefault: false },
  { header: 'Unbilled executed', byDefault: false },
];

/** The combined pending table, which the division and item reports both
 * draw. One list, because they are the same table under two groupings. */
const PENDING_COLUMN_CHOICES: readonly WorksAnalysisColumn[] = [
  { header: 'Group', byDefault: true },
  { header: 'Unit', byDefault: true },
  { header: 'Rate', byDefault: true },
  { header: 'Works', byDefault: true },
  { header: 'Lines', byDefault: false },
  { header: 'Sanctioned', byDefault: true },
  { header: 'Supplied', byDefault: true },
  { header: 'Installed', byDefault: false },
  { header: 'Pending to supply', byDefault: true },
  { header: 'Pending supply value', byDefault: true },
  { header: 'Pending to install', byDefault: true },
  { header: 'Pending install value', byDefault: true },
];

export const WORKS_ANALYSIS_COLUMNS: Readonly<
  Record<WorksAnalysisReport, readonly WorksAnalysisColumn[]>
> = {
  work: WORK_COLUMNS,
  division: PENDING_COLUMN_CHOICES,
  'mapped-item': PENDING_COLUMN_CHOICES,
};

/** The headings a report opens with, for the screen's chips and for the
 * document when the caller names none. */
export function defaultWorksAnalysisColumns(
  report: WorksAnalysisReport,
): readonly string[] {
  return WORKS_ANALYSIS_COLUMNS[report]
    .filter((column) => column.byDefault)
    .map((column) => column.header);
}

/**
 * `workId` is required by the `work` report and refused by the other two,
 * which are portfolio-wide and have no Work to be about.
 *
 * `columns` is the operator's chosen headings, comma-separated, and
 * `division` narrows the division report to one heading. Both exist so the
 * exported file is the report the operator is looking at: § 19 records
 * that a REGISTER export deliberately ignores the screen's filters and
 * says so, and that the exception would be built when an operator asked
 * for it. This is a report rather than a register, the operator asked, and
 * a PDF carrying eleven columns of which the screen showed five is a
 * different document from the one on the screen.
 *
 * A heading the report does not carry is ignored rather than refused: the
 * chip vocabulary is shared, but a stale bookmark naming a retired column
 * should still produce the report.
 */
export const WorksAnalysisDocumentQuerySchema = Type.Object(
  {
    workId: Type.Optional(UuidSchema),
    columns: Type.Optional(Type.String({ maxLength: 1000 })),
    division: Type.Optional(Type.String({ maxLength: 50 })),
  },
  { additionalProperties: false },
);
export type WorksAnalysisDocumentQuery = Static<
  typeof WorksAnalysisDocumentQuerySchema
>;
