import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, DecimalStringSchema, UuidSchema } from './primitives.js';

// --- Delivery receipt -----------------------------------------------------

export const RecordReceiptRequestSchema = Type.Object(
  {
    receivedOn: DateOnlySchema,
    receivedBy: Type.String({ minLength: 2, maxLength: 200 }),
    remarks: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type RecordReceiptRequest = Static<typeof RecordReceiptRequestSchema>;

export const ReceiptSchema = Type.Object(
  {
    id: UuidSchema,
    deliveryChallanId: UuidSchema,
    receivedOn: DateOnlySchema,
    receivedBy: Type.String(),
    remarks: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type Receipt = Static<typeof ReceiptSchema>;

// --- Serial traceability --------------------------------------------------

export const RecordSerialsRequestSchema = Type.Object(
  {
    challanItemId: UuidSchema,
    serialNumbers: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      minItems: 1,
      maxItems: 500,
    }),
  },
  { additionalProperties: false },
);
export type RecordSerialsRequest = Static<typeof RecordSerialsRequestSchema>;

export const InstallSerialRequestSchema = Type.Object(
  {
    installedOn: DateOnlySchema,
    remarks: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type InstallSerialRequest = Static<typeof InstallSerialRequestSchema>;

export const SerialSchema = Type.Object(
  {
    id: UuidSchema,
    deliveryChallanId: UuidSchema,
    challanItemId: UuidSchema,
    challanNumber: Type.Union([Type.String(), Type.Null()]),
    itemDescription: Type.String(),
    serialNumber: Type.String(),
    installedOn: Type.Union([DateOnlySchema, Type.Null()]),
    installationRemarks: Type.Union([Type.String(), Type.Null()]),
    /** The delivered-but-uninstalled pool and quantity-level installation
     * links (Milestone 7). Optional so older fixtures stay valid. */
    workItemId: Type.Optional(UuidSchema),
    challanStatus: Type.Optional(
      Type.Union([
        Type.Literal('draft'),
        Type.Literal('issued'),
        Type.Literal('cancelled'),
      ]),
    ),
    /** Set when a live quantity-level installation record covers this
     * serial; cancellation clears it along with installedOn. */
    installationId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    installationLocation: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type Serial = Static<typeof SerialSchema>;

export const SerialListResponseSchema = Type.Object(
  { serials: Type.Array(SerialSchema) },
  { additionalProperties: false },
);
export type SerialListResponse = Static<typeof SerialListResponseSchema>;

// --- Contract instruments (PBG / PAC / DOC) -------------------------------

export const InstrumentKindSchema = Type.Union([
  Type.Literal('pbg'),
  Type.Literal('pac'),
  Type.Literal('doc'),
]);
export type InstrumentKind = Static<typeof InstrumentKindSchema>;

export const InstrumentStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('released'),
  Type.Literal('expired'),
  Type.Literal('closed'),
]);
export type InstrumentStatus = Static<typeof InstrumentStatusSchema>;

export const SaveInstrumentRequestSchema = Type.Object(
  {
    kind: InstrumentKindSchema,
    reference: Type.String({ minLength: 1, maxLength: 200 }),
    amount: Type.Optional(DecimalStringSchema),
    issuedOn: DateOnlySchema,
    expiresOn: Type.Optional(DateOnlySchema),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type SaveInstrumentRequest = Static<typeof SaveInstrumentRequestSchema>;

export const UpdateInstrumentRequestSchema = Type.Object(
  {
    status: Type.Optional(InstrumentStatusSchema),
    expiresOn: Type.Optional(DateOnlySchema),
    notes: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type UpdateInstrumentRequest = Static<typeof UpdateInstrumentRequestSchema>;

export const InstrumentSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    kind: InstrumentKindSchema,
    reference: Type.String(),
    amount: Type.Union([DecimalStringSchema, Type.Null()]),
    issuedOn: DateOnlySchema,
    expiresOn: Type.Union([DateOnlySchema, Type.Null()]),
    status: InstrumentStatusSchema,
    notes: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type Instrument = Static<typeof InstrumentSchema>;

export const InstrumentListResponseSchema = Type.Object(
  { instruments: Type.Array(InstrumentSchema) },
  { additionalProperties: false },
);
export type InstrumentListResponse = Static<typeof InstrumentListResponseSchema>;

// --- Measurement Book -----------------------------------------------------

export const RecordMbEntryRequestSchema = Type.Object(
  {
    workItemId: UuidSchema,
    deliveryChallanId: Type.Optional(UuidSchema),
    measuredQuantity: DecimalStringSchema,
    measuredOn: DateOnlySchema,
    mbBookRef: Type.Optional(Type.String({ maxLength: 100 })),
    remarks: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type RecordMbEntryRequest = Static<typeof RecordMbEntryRequestSchema>;

export const MbEntrySchema = Type.Object(
  {
    id: UuidSchema,
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    deliveryChallanId: Type.Union([UuidSchema, Type.Null()]),
    measuredQuantity: DecimalStringSchema,
    measuredOn: DateOnlySchema,
    mbBookRef: Type.Union([Type.String(), Type.Null()]),
    remarks: Type.Union([Type.String(), Type.Null()]),
    billId: Type.Union([UuidSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type MbEntry = Static<typeof MbEntrySchema>;

export const MbEntryListResponseSchema = Type.Object(
  { entries: Type.Array(MbEntrySchema) },
  { additionalProperties: false },
);
export type MbEntryListResponse = Static<typeof MbEntryListResponseSchema>;

// --- Bills ----------------------------------------------------------------

export const BillStatusSchema = Type.Union([
  Type.Literal('prepared'),
  Type.Literal('submitted'),
  Type.Literal('paid'),
]);
export type BillStatus = Static<typeof BillStatusSchema>;

export const UpdateBillStatusRequestSchema = Type.Object(
  { status: Type.Union([Type.Literal('submitted'), Type.Literal('paid')]) },
  { additionalProperties: false },
);
export type UpdateBillStatusRequest = Static<typeof UpdateBillStatusRequestSchema>;

export const BillSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    billNumber: Type.Integer({ minimum: 1 }),
    status: BillStatusSchema,
    totalAmount: DecimalStringSchema,
    /** Immutable line snapshot: per work item, measured quantity × rate. */
    linesSnapshot: Type.Unknown(),
    createdAt: Type.String({ format: 'date-time' }),
    submittedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    paidAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type Bill = Static<typeof BillSchema>;

export const BillListResponseSchema = Type.Object(
  { bills: Type.Array(BillSchema) },
  { additionalProperties: false },
);
export type BillListResponse = Static<typeof BillListResponseSchema>;
