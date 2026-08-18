import { Type, type Static } from '@sinclair/typebox';
import { KeysetQuerySchema, NextCursorSchema } from './pagination.js';
import {
  DateOnlySchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';

// --- Maintenance: the site material request (migration 0088) -----------------

/**
 * NOT the LOA's annual maintenance schedule. That one is a payment
 * category on a contract line (migration 0068) and is certified rather
 * than despatched; this is the internal logistics of getting a
 * replacement part out of the store and onto a platform. Migration
 * 0088's header sets out why the two share a word and nothing else.
 */

const MAINTENANCE_PRIORITIES = ['routine', 'urgent', 'critical'] as const;
const MaintenancePrioritySchema = Type.Union(
  MAINTENANCE_PRIORITIES.map((priority) => Type.Literal(priority)),
);
export type MaintenancePriority = Static<typeof MaintenancePrioritySchema>;

/** The mock's four stages, in the stored underscore form. The chip map
 * renders them hyphenated, exactly as production's `in_production` does. */
const MAINTENANCE_STATUSES = [
  'awaiting_approval',
  'approved',
  'partially_dispatched',
  'closed',
] as const;
const MaintenanceStatusSchema = Type.Union(
  MAINTENANCE_STATUSES.map((status) => Type.Literal(status)),
);
export type MaintenanceStatus = Static<typeof MaintenanceStatusSchema>;

const StationSchema = nonBlankString({ minLength: 2, maxLength: 200 });
const PersonSchema = nonBlankString({ minLength: 2, maxLength: 200 });

/** Trimmed text that may be a single character — a unit is 'm' as often
 * as it is 'Nos', and a serial can be one digit. `nonBlankString` cannot
 * express a minimum of one: its pattern subtracts two from the minimum
 * for the two anchor characters, and 1 would ask for `{-1,}`. */
function trimmedShortString(maxLength: number) {
  return Type.String({
    minLength: 1,
    maxLength,
    pattern: '^[^\\s](?:[\\s\\S]*[^\\s])?$',
    description: 'Text with no leading or trailing whitespace.',
  });
}

const UnitSchema = trimmedShortString(20);
const SerialsSchema = Type.Array(trimmedShortString(100), { maxItems: 100 });

/**
 * One material line, with the four quantities the mock stores and this
 * build DERIVES beside the three it keeps.
 *
 * `onHand` is the shelf, read from `app_private.stock_on_hand` at the
 * moment the screen asks, and null for a custom line that names no part —
 * there is nothing on a shelf for it to come off.
 */
const MaintenanceLineSchema = Type.Object(
  {
    id: UuidSchema,
    position: Type.Integer({ minimum: 1 }),
    itemId: Type.Union([UuidSchema, Type.Null()]),
    itemCode: Type.Union([Type.String(), Type.Null()]),
    description: Type.String(),
    unit: Type.String(),
    purpose: Type.Union([Type.String(), Type.Null()]),
    quantity: Type.String(),
    /** Ordered less cancelled less dispatched: the mock's `reserved`. */
    outstandingQuantity: Type.String(),
    dispatchedQuantity: Type.String(),
    cancelledQuantity: Type.String(),
    cancellationReason: Type.Union([Type.String(), Type.Null()]),
    expectedReturnQuantity: Type.String(),
    receivedReturnQuantity: Type.String(),
    returnDueQuantity: Type.String(),
    onHand: Type.Union([Type.String(), Type.Null()]),
    assetSerials: Type.Array(Type.String()),
    /** Nothing left to send and nothing left to come back. */
    resolved: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MaintenanceLine = Static<typeof MaintenanceLineSchema>;

const MaintenanceDispatchLineSchema = Type.Object(
  {
    lineId: UuidSchema,
    description: Type.String(),
    unit: Type.String(),
    quantity: Type.String(),
  },
  { additionalProperties: false },
);

const MaintenanceDispatchSchema = Type.Object(
  {
    id: UuidSchema,
    challanNumber: Type.String(),
    dispatchDate: DateOnlySchema,
    stockLocation: Type.String(),
    receiverName: Type.String(),
    transporter: Type.Union([Type.String(), Type.Null()]),
    notes: Type.Union([Type.String(), Type.Null()]),
    lines: Type.Array(MaintenanceDispatchLineSchema),
  },
  { additionalProperties: false },
);
export type MaintenanceDispatch = Static<typeof MaintenanceDispatchSchema>;

const MaintenanceReturnSchema = Type.Object(
  {
    id: UuidSchema,
    lineId: UuidSchema,
    lineDescription: Type.String(),
    quantity: Type.String(),
    receivedOn: DateOnlySchema,
    serials: Type.Array(Type.String()),
    conditionNote: Type.String(),
    repairDisposition: Type.String(),
    receivedBy: Type.String(),
    notes: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type MaintenanceReturn = Static<typeof MaintenanceReturnSchema>;

/** One row of the register. */
const MaintenanceRequestSummarySchema = Type.Object(
  {
    id: UuidSchema,
    requestNumber: Type.String(),
    workId: UuidSchema,
    workCode: Type.String(),
    station: Type.String(),
    requesterName: Type.String(),
    priority: MaintenancePrioritySchema,
    requiredBy: Type.Union([DateOnlySchema, Type.Null()]),
    faultSummary: Type.String(),
    status: MaintenanceStatusSchema,
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);
export type MaintenanceRequestSummary = Static<typeof MaintenanceRequestSummarySchema>;

const MaintenanceRequestSchema = Type.Composite(
  [
    MaintenanceRequestSummarySchema,
    Type.Object({
      requesterPhone: Type.Union([Type.String(), Type.Null()]),
      operationalImpact: Type.Union([Type.String(), Type.Null()]),
      deliveryInstructions: Type.Union([Type.String(), Type.Null()]),
      approvalComment: Type.Union([Type.String(), Type.Null()]),
    }),
  ],
  { additionalProperties: false },
);

/** The stage strip above the register: one count per stage, over the
 * whole visible register rather than the page. */
const MaintenanceStageCountsSchema = Type.Object(
  {
    awaitingApproval: Type.Integer({ minimum: 0 }),
    approved: Type.Integer({ minimum: 0 }),
    partiallyDispatched: Type.Integer({ minimum: 0 }),
    closed: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type MaintenanceStageCounts = Static<typeof MaintenanceStageCountsSchema>;

export const MaintenanceListQuerySchema = Type.Composite(
  [Type.Object({}), KeysetQuerySchema],
  { additionalProperties: false },
);

export const MaintenanceListResponseSchema = Type.Object(
  {
    requests: Type.Array(MaintenanceRequestSummarySchema),
    nextCursor: NextCursorSchema,
    /** Null on a cursor page. The strip sits above the FIRST page and
     * describes the whole register, so it does not change as the reader
     * pages — recomputing an aggregate over every request to throw it
     * away is the kind of cost a register pays on every scroll. */
    counts: Type.Union([MaintenanceStageCountsSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type MaintenanceListResponse = Static<typeof MaintenanceListResponseSchema>;

export const MaintenanceDetailResponseSchema = Type.Object(
  {
    request: MaintenanceRequestSchema,
    lines: Type.Array(MaintenanceLineSchema),
    dispatches: Type.Array(MaintenanceDispatchSchema),
    returns: Type.Array(MaintenanceReturnSchema),
    /** Every line settled and every promised defect received. The screen
     * disables its button on this; migration 0088's closure gate is what
     * actually refuses. */
    canClose: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MaintenanceDetailResponse = Static<typeof MaintenanceDetailResponseSchema>;

const CreateMaintenanceLineSchema = Type.Object(
  {
    /** A part from the item master, or omitted for a custom material. */
    itemId: Type.Optional(UuidSchema),
    description: nonBlankString({ minLength: 3, maxLength: 300 }),
    unit: UnitSchema,
    quantity: PositiveDecimalStringSchema,
    purpose: Type.Optional(nonBlankString({ minLength: 2, maxLength: 300 })),
    expectedReturnQuantity: NonNegativeDecimalStringSchema,
    assetSerials: Type.Optional(SerialsSchema),
  },
  { additionalProperties: false },
);
export type CreateMaintenanceLine = Static<typeof CreateMaintenanceLineSchema>;

export const CreateMaintenanceRequestSchema = Type.Object(
  {
    workId: UuidSchema,
    station: StationSchema,
    requesterName: PersonSchema,
    requesterPhone: Type.Optional(nonBlankString({ minLength: 4, maxLength: 30 })),
    priority: MaintenancePrioritySchema,
    requiredBy: Type.Optional(DateOnlySchema),
    faultSummary: nonBlankString({ minLength: 3, maxLength: 1000 }),
    operationalImpact: Type.Optional(nonBlankString({ minLength: 3, maxLength: 2000 })),
    deliveryInstructions: Type.Optional(
      nonBlankString({ minLength: 3, maxLength: 2000 }),
    ),
    lines: Type.Array(CreateMaintenanceLineSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type CreateMaintenanceRequest = Static<typeof CreateMaintenanceRequestSchema>;

export const ApproveMaintenanceRequestSchema = Type.Object(
  { comment: nonBlankString({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);
export type ApproveMaintenanceRequest = Static<typeof ApproveMaintenanceRequestSchema>;

export const RecordMaintenanceDispatchSchema = Type.Object(
  {
    /** Omitted means the organisation's today. A browser clock is the
     * wrong authority for a date on a challan. */
    dispatchDate: Type.Optional(DateOnlySchema),
    stockLocation: nonBlankString({ minLength: 2, maxLength: 200 }),
    receiverName: PersonSchema,
    transporter: Type.Optional(nonBlankString({ minLength: 2, maxLength: 200 })),
    notes: Type.Optional(nonBlankString({ minLength: 2, maxLength: 2000 })),
    lines: Type.Array(
      Type.Object(
        { lineId: UuidSchema, quantity: PositiveDecimalStringSchema },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
export type RecordMaintenanceDispatch = Static<typeof RecordMaintenanceDispatchSchema>;

export const ReceiveMaintenanceReturnSchema = Type.Object(
  {
    lineId: UuidSchema,
    quantity: PositiveDecimalStringSchema,
    receivedOn: Type.Optional(DateOnlySchema),
    serials: Type.Optional(SerialsSchema),
    conditionNote: nonBlankString({ minLength: 2, maxLength: 500 }),
    repairDisposition: nonBlankString({ minLength: 2, maxLength: 200 }),
    receivedBy: PersonSchema,
    notes: Type.Optional(nonBlankString({ minLength: 2, maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type ReceiveMaintenanceReturn = Static<typeof ReceiveMaintenanceReturnSchema>;

/** Writing off the remainder of a line nobody is going to send. The mock
 * carries the column and never writes it, which leaves its own closure
 * gate unreachable; this is the writer.
 *
 * NO QUANTITY. A write-off says "the rest of this line is not coming",
 * and the rest is a number the server already holds. A caller-supplied
 * quantity allowed a PARTIAL write-off, and partial plus write-once —
 * the guard refuses a second one — is a line that can never reach zero
 * outstanding and a request that can therefore never close. Taking the
 * whole balance makes write-once terminal by construction rather than by
 * hoping nobody sends a smaller number. */
export const CancelMaintenanceLineSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type CancelMaintenanceLine = Static<typeof CancelMaintenanceLineSchema>;
