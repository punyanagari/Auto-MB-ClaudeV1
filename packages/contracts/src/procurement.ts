import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  DecimalStringSchema,
  GstRateSchema,
  HsnCodeSchema,
  NonNegativeRateStringSchema,
  PositiveDecimalStringSchema,
  RateStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

/**
 * The procurement wave (migration 0033; legacy spec §5.8).
 *
 * A PURCHASE ORDER is what the contractor buys IN to supply a Work. It is
 * placed on a contact carrying `isVendor`, carries lines against the
 * Work's items or against consumables the LOA never named, and follows
 * the delivery challan's posture exactly: draft (no number) -> issued
 * (gapless `<work_code>-PO-NN`, vendor snapshotted, total frozen) ->
 * closed once its lines have been fully received against issued delivery
 * challans, or cancelled with a note it keeps forever.
 *
 * A BUDGETARY QUOTATION is a priced offer made OUTWARD — to a private
 * customer, or to a railway officer assembling a tender's item list. It
 * carries NO work: a BQ normally precedes any award, and forcing a Work
 * on it would invent one that does not exist. Draft -> issued (gapless
 * `BQ-NN` per organisation) -> expired / converted / withdrawn.
 *
 * Line MONEY is never sent by the client. The line amount and the
 * document total are computed server-side from quantity and rate as exact
 * decimals and written at issue; a client-supplied total would be a
 * second, disagreeing authority (and, in JavaScript, a floating-point
 * one).
 */

/* --- Shared line shape -------------------------------------------------
 * Both documents price the same way, and both line tables hold the same
 * CHECKs: a description with a trimmed floor of three, an optional
 * HSN/SAC code, a unit code, a strictly positive quantity, a
 * non-negative rate, and an optional GST rate. */

/** The column is `length(btrim(description)) >= 3` with no ceiling; the
 * ceiling here is the one issue-challan manual lines already hold, since
 * a thousand characters on an order line is a paste accident, not a
 * description. */
const LineDescriptionSchema = nonBlankString({ minLength: 3, maxLength: 1000 });

/** `length(btrim(unit_code)) BETWEEN 1 AND 20`. The floor is ONE, which
 * `nonBlankString` cannot express (it starts at two), so it is spelt out:
 * at least one character survives the removal of spaces. A unit code of a
 * single space would otherwise pass the schema and die at the CHECK. */
const UnitCodeSchema = Type.String({
  minLength: 1,
  maxLength: 20,
  pattern: '^[\\s\\S]*[^ ][\\s\\S]*$',
  description: 'Unit code with at least one character once spaces are removed.',
});

const ProcurementLineInputFields = {
  description: LineDescriptionSchema,
  hsnCode: Type.Optional(HsnCodeSchema),
  unitCode: UnitCodeSchema,
  /** Strictly positive, as the column's CHECK says. */
  quantity: PositiveDecimalStringSchema,
  /** Non-negative, not positive: a free-issue or nil-rate line is real. */
  rate: NonNegativeRateStringSchema,
  gstRate: Type.Optional(GstRateSchema),
} as const;

/** The read-back line facts both documents share. */
const ProcurementLineFields = {
  id: UuidSchema,
  lineNumber: Type.Integer({ minimum: 1 }),
  description: Type.String(),
  hsnCode: Type.Union([HsnCodeSchema, Type.Null()]),
  unitCode: Type.String(),
  quantity: DecimalStringSchema,
  rate: RateStringSchema,
  gstRate: Type.Union([GstRateSchema, Type.Null()]),
  /** Server-computed quantity x rate, exact; frozen once issued. */
  lineAmount: DecimalStringSchema,
} as const;

/* --- Purchase orders --------------------------------------------------- */

export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'issued',
  'closed',
  'cancelled',
] as const;
export const PurchaseOrderStatusSchema = Type.Union(
  PURCHASE_ORDER_STATUSES.map((status) => Type.Literal(status)),
);
export type PurchaseOrderStatus = Static<typeof PurchaseOrderStatusSchema>;

/** POST — creates the Work's one open draft. The same body serves the
 * draft PUT, exactly as the delivery challan's does; an issued order
 * takes no edits at all (the 0033 line trigger enforces it in the
 * database). `expectedOn` is advisory: nothing refuses a late receipt,
 * the date is there so an operator can chase it. */
export const CreatePurchaseOrderRequestSchema = Type.Object(
  {
    /** A contact carrying `isVendor`; snapshotted onto the order at issue
     * so retiring the contact never rewrites the document. */
    vendorContactId: UuidSchema,
    poDate: DateOnlySchema,
    expectedOn: Type.Optional(DateOnlySchema),
    terms: Type.Optional(nonBlankString({ minLength: 3, maxLength: 4000 })),
  },
  { additionalProperties: false },
);
export type CreatePurchaseOrderRequest = Static<
  typeof CreatePurchaseOrderRequestSchema
>;

/** A line buys an awarded item (`workItemId`) or a consumable the LOA
 * never named — the description always stands on its own, which is why
 * the link is optional and the text is not. */
export const PurchaseOrderLineInputSchema = Type.Object(
  {
    workItemId: Type.Optional(UuidSchema),
    ...ProcurementLineInputFields,
  },
  { additionalProperties: false },
);
export type PurchaseOrderLineInput = Static<typeof PurchaseOrderLineInputSchema>;

/** PUT .../lines — REPLACES the draft's lines wholesale; `lineNumber`
 * follows array order. */
export const SavePurchaseOrderLinesRequestSchema = Type.Object(
  {
    lines: Type.Array(PurchaseOrderLineInputSchema, { minItems: 1, maxItems: 500 }),
  },
  { additionalProperties: false },
);
export type SavePurchaseOrderLinesRequest = Static<
  typeof SavePurchaseOrderLinesRequestSchema
>;

/** The cancellation note is stored in a column whose CHECK measures it
 * TRIMMED — `BETWEEN 3 AND 2000` — so the schema holds the same floor. */
export const CancelPurchaseOrderRequestSchema = Type.Object(
  { note: nonBlankString({ minLength: 3, maxLength: 2000 }) },
  { additionalProperties: false },
);
export type CancelPurchaseOrderRequest = Static<
  typeof CancelPurchaseOrderRequestSchema
>;

/** Issue and close carry NO body: issue assigns the next number under the
 * per-Work counter lock, close only records that the receipts are
 * complete. Both answer with the detail response below. */

export const PurchaseOrderLineSchema = Type.Object(
  {
    ...ProcurementLineFields,
    /** Null on a consumable bought outside the LOA. */
    workItemId: Type.Union([UuidSchema, Type.Null()]),
    /** Present on the detail response: the sum of this line's quantities
     * on ISSUED delivery challans (a cancelled challan releases its
     * own). Together they are the close rule — an order closes when no
     * line is still pending. */
    receivedQuantity: Type.Optional(DecimalStringSchema),
    pendingQuantity: Type.Optional(DecimalStringSchema),
  },
  { additionalProperties: false },
);
export type PurchaseOrderLine = Static<typeof PurchaseOrderLineSchema>;

export const PurchaseOrderSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    /** Provenance only — the snapshot below is the record. */
    vendorContactId: UuidSchema,
    /** The vendor as the document names it: the issue-time snapshot's
     * designation once issued, the contact master's while draft. */
    vendorDesignation: Type.String(),
    status: PurchaseOrderStatusSchema,
    poNumber: Type.Union([Type.String(), Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    poDate: DateOnlySchema,
    expectedOn: Type.Union([DateOnlySchema, Type.Null()]),
    terms: Type.Union([Type.String(), Type.Null()]),
    /** Issue-written; null while draft. */
    totalAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    issuedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    closedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type PurchaseOrder = Static<typeof PurchaseOrderSchema>;

export const PurchaseOrderListResponseSchema = Type.Object(
  { purchaseOrders: Type.Array(PurchaseOrderSchema) },
  { additionalProperties: false },
);
export type PurchaseOrderListResponse = Static<typeof PurchaseOrderListResponseSchema>;

export const PurchaseOrderDetailResponseSchema = Type.Object(
  {
    purchaseOrder: PurchaseOrderSchema,
    lines: Type.Array(PurchaseOrderLineSchema),
    /** The immutable issue-time vendor snapshot, verbatim; null while
     * draft. */
    vendorSnapshot: Type.Unknown(),
    /** The line amounts summed as exact decimals SERVER-side, so a draft
     * screen can show its value without the client adding money in
     * floating point. '0.00' on a draft with no lines yet; equals
     * `purchaseOrder.totalAmount` from issue onwards. */
    previewTotal: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type PurchaseOrderDetailResponse = Static<
  typeof PurchaseOrderDetailResponseSchema
>;

/** `details` of the 409 raised when close is asked for an order whose
 * lines are not fully received: the operator's worklist, one row per
 * line still owing material. */
export const PurchaseOrderOutstandingLineSchema = Type.Object(
  {
    purchaseOrderLineId: UuidSchema,
    lineNumber: Type.Integer({ minimum: 1 }),
    description: Type.String(),
    orderedQuantity: DecimalStringSchema,
    receivedQuantity: DecimalStringSchema,
    pendingQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type PurchaseOrderOutstandingLine = Static<
  typeof PurchaseOrderOutstandingLineSchema
>;

export const PurchaseOrderNotFullyReceivedDetailsSchema = Type.Object(
  { outstandingLines: Type.Array(PurchaseOrderOutstandingLineSchema) },
  { additionalProperties: false },
);
export type PurchaseOrderNotFullyReceivedDetails = Static<
  typeof PurchaseOrderNotFullyReceivedDetailsSchema
>;

/* --- Budgetary quotations ---------------------------------------------- */

export const BUDGETARY_QUOTATION_STATUSES = [
  'draft',
  'issued',
  'expired',
  'converted',
  'withdrawn',
] as const;
export const BudgetaryQuotationStatusSchema = Type.Union(
  BUDGETARY_QUOTATION_STATUSES.map((status) => Type.Literal(status)),
);
export type BudgetaryQuotationStatus = Static<typeof BudgetaryQuotationStatusSchema>;

/** What an ISSUED quotation can still become. There is no cancellation:
 * an offer that lapsed is `expired`, one that won is `converted`, one the
 * contractor took back is `withdrawn` — and all three keep the number. */
export const BudgetaryQuotationOutcomeSchema = Type.Union([
  Type.Literal('expired'),
  Type.Literal('converted'),
  Type.Literal('withdrawn'),
]);
export type BudgetaryQuotationOutcome = Static<typeof BudgetaryQuotationOutcomeSchema>;

/** POST — creates a draft; the same body serves the draft PUT. The
 * addressee is free text BECAUSE the contact may not exist yet: a
 * quotation is often the first thing sent to a stranger, so
 * `customerContactId` is optional and `addressedTo` is not. */
export const CreateBudgetaryQuotationRequestSchema = Type.Object(
  {
    customerContactId: Type.Optional(UuidSchema),
    addressedTo: nonBlankString({ minLength: 2, maxLength: 200 }),
    subject: nonBlankString({ minLength: 3, maxLength: 500 }),
    bqDate: DateOnlySchema,
    /** Never before `bqDate` — the column's CHECK says so. */
    validUntil: Type.Optional(DateOnlySchema),
    notes: Type.Optional(nonBlankString({ minLength: 3, maxLength: 4000 })),
  },
  { additionalProperties: false },
);
export type CreateBudgetaryQuotationRequest = Static<
  typeof CreateBudgetaryQuotationRequestSchema
>;

/** No `workItemId`: a quotation precedes any award, so there is no Work
 * whose items it could point at. */
export const BudgetaryQuotationLineInputSchema = Type.Object(
  { ...ProcurementLineInputFields },
  { additionalProperties: false },
);
export type BudgetaryQuotationLineInput = Static<
  typeof BudgetaryQuotationLineInputSchema
>;

/** PUT .../lines — REPLACES the draft's lines wholesale; `lineNumber`
 * follows array order. */
export const SaveBudgetaryQuotationLinesRequestSchema = Type.Object(
  {
    lines: Type.Array(BudgetaryQuotationLineInputSchema, {
      minItems: 1,
      maxItems: 500,
    }),
  },
  { additionalProperties: false },
);
export type SaveBudgetaryQuotationLinesRequest = Static<
  typeof SaveBudgetaryQuotationLinesRequestSchema
>;

/** POST .../outcome — the one transition an issued quotation has. Modelled
 * as an outcome rather than three endpoints for the reason the extension
 * response is: the states are alternatives, not steps. */
export const SetBudgetaryQuotationOutcomeRequestSchema = Type.Object(
  { outcome: BudgetaryQuotationOutcomeSchema },
  { additionalProperties: false },
);
export type SetBudgetaryQuotationOutcomeRequest = Static<
  typeof SetBudgetaryQuotationOutcomeRequestSchema
>;

export const BudgetaryQuotationLineSchema = Type.Object(
  { ...ProcurementLineFields },
  { additionalProperties: false },
);
export type BudgetaryQuotationLine = Static<typeof BudgetaryQuotationLineSchema>;

export const BudgetaryQuotationSchema = Type.Object(
  {
    id: UuidSchema,
    /** Null when the quotation was addressed to someone who is not (yet)
     * a contact. */
    customerContactId: Type.Union([UuidSchema, Type.Null()]),
    addressedTo: Type.String(),
    subject: Type.String(),
    status: BudgetaryQuotationStatusSchema,
    bqNumber: Type.Union([Type.String(), Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    bqDate: DateOnlySchema,
    validUntil: Type.Union([DateOnlySchema, Type.Null()]),
    notes: Type.Union([Type.String(), Type.Null()]),
    /** Issue-written; null while draft. */
    totalAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    issuedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type BudgetaryQuotation = Static<typeof BudgetaryQuotationSchema>;

export const BudgetaryQuotationListResponseSchema = Type.Object(
  { budgetaryQuotations: Type.Array(BudgetaryQuotationSchema) },
  { additionalProperties: false },
);
export type BudgetaryQuotationListResponse = Static<
  typeof BudgetaryQuotationListResponseSchema
>;

export const BudgetaryQuotationDetailResponseSchema = Type.Object(
  {
    budgetaryQuotation: BudgetaryQuotationSchema,
    lines: Type.Array(BudgetaryQuotationLineSchema),
    /** The immutable issue-time customer snapshot, verbatim; null while
     * draft, and null on an issued quotation addressed to a stranger. */
    customerSnapshot: Type.Unknown(),
    /** The line amounts summed as exact decimals SERVER-side, as on the
     * purchase order above; equals `budgetaryQuotation.totalAmount` from
     * issue onwards. */
    previewTotal: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type BudgetaryQuotationDetailResponse = Static<
  typeof BudgetaryQuotationDetailResponseSchema
>;
