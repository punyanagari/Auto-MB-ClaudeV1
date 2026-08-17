import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import {
  DateOnlySchema,
  DecimalStringSchema,
  StorableDecimalStringSchema,
  UuidSchema,
} from './primitives.js';

/** Issue Challans move material out (to site, job work, loan/return).
 * Same lifecycle as Delivery Challans with looser content rules by
 * design: lines may be manual (outside the LOA) and quantities may
 * exceed work quantities. */
export const IssueChallanStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('issued'),
  Type.Literal('cancelled'),
]);
export type IssueChallanStatus = Static<typeof IssueChallanStatusSchema>;

export const IssueChallanMovementTypeSchema = Type.Union([
  Type.Literal('issue'),
  Type.Literal('loan'),
  Type.Literal('return'),
]);
export type IssueChallanMovementType = Static<typeof IssueChallanMovementTypeSchema>;

/** A line references a Work item (description/unit snapshotted from it at
 * save time) OR carries a manual description+unit outside the LOA.
 *
 * The line quantity has no CEILING by design — an Issue Challan may
 * exceed the work quantity — but it must still fit the numeric(18,3)
 * column it lands in. A mistyped sixteen-digit quantity used to pass both
 * application layers and raise a numeric field overflow the route does
 * not map, so the operator got a 500 and no idea which box to fix. The
 * FLOOR stays with the route (QUANTITY_INVALID names the line), which is
 * why these carry the storable variant and not the positive one. */
export const IssueChallanWorkItemLineInputSchema = Type.Object(
  {
    workItemId: UuidSchema,
    quantity: StorableDecimalStringSchema,
  },
  { additionalProperties: false },
);
export type IssueChallanWorkItemLineInput = Static<
  typeof IssueChallanWorkItemLineInputSchema
>;

export const IssueChallanManualLineInputSchema = Type.Object(
  {
    description: Type.String({ minLength: 3, maxLength: 1000 }),
    unit: Type.String({ minLength: 1, maxLength: 20 }),
    quantity: StorableDecimalStringSchema,
  },
  { additionalProperties: false },
);
export type IssueChallanManualLineInput = Static<
  typeof IssueChallanManualLineInputSchema
>;

export const IssueChallanLineInputSchema = Type.Union([
  IssueChallanWorkItemLineInputSchema,
  IssueChallanManualLineInputSchema,
]);
export type IssueChallanLineInput = Static<typeof IssueChallanLineInputSchema>;

export const SaveIssueChallanRequestSchema = Type.Object(
  {
    challanDate: DateOnlySchema,
    movementType: IssueChallanMovementTypeSchema,
    issuedToName: Type.String({ minLength: 2, maxLength: 200 }),
    issuedToRole: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
    location: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
    remarks: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    lines: Type.Array(IssueChallanLineInputSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type SaveIssueChallanRequest = Static<typeof SaveIssueChallanRequestSchema>;

export const CancelIssueChallanRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);
export type CancelIssueChallanRequest = Static<typeof CancelIssueChallanRequestSchema>;

export const IssueChallanLineSchema = Type.Object(
  {
    id: UuidSchema,
    /** Null for manual lines outside the LOA. */
    workItemId: Type.Union([UuidSchema, Type.Null()]),
    /** The Work item's number when the line references one; null for
     * manual lines. */
    itemNumber: Type.Union([Type.String(), Type.Null()]),
    description: Type.String(),
    unit: Type.String(),
    quantity: DecimalStringSchema,
    position: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type IssueChallanLine = Static<typeof IssueChallanLineSchema>;

export const IssueChallanSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    status: IssueChallanStatusSchema,
    movementType: IssueChallanMovementTypeSchema,
    challanDate: DateOnlySchema,
    challanNumber: Type.Union([Type.String(), Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    prefix: Type.String(),
    issuedToName: Type.String(),
    issuedToRole: Type.Union([Type.String(), Type.Null()]),
    location: Type.Union([Type.String(), Type.Null()]),
    remarks: Type.Union([Type.String(), Type.Null()]),
    templateVersion: Type.Union([Type.String(), Type.Null()]),
    renderedAvailable: Type.Boolean(),
    signedCopyAvailable: Type.Boolean(),
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    issuedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type IssueChallan = Static<typeof IssueChallanSchema>;

export const IssueChallanListResponseSchema = Type.Object(
  { issueChallans: Type.Array(IssueChallanSchema) },
  { additionalProperties: false },
);
export type IssueChallanListResponse = Static<typeof IssueChallanListResponseSchema>;

/** A register row: the challan exactly as its own Work lists it, plus the
 * Work code — the only thing a cross-Work reader needs that a per-Work
 * reader already knows. Composed from `IssueChallanSchema` rather than
 * restated, so the two lists can never drift apart. */
export const IssueChallanRegisterEntrySchema = Type.Composite(
  [IssueChallanSchema, Type.Object({ workCode: Type.String() })],
  { additionalProperties: false },
);
export type IssueChallanRegisterEntry = Static<typeof IssueChallanRegisterEntrySchema>;

/** Every issue challan in the organisation the caller may see, newest
 * challan date first — the same ordering and the same keyset contract the
 * delivery register answers on (`DeliveryChallanRegisterResponseSchema`),
 * because the two are one register with two contents.
 *
 * `nextCursor` pages the list; see `pagination.ts`. An unpaginated request
 * (no `limit`) gets the whole register and a null cursor. */
export const IssueChallanRegisterResponseSchema = Type.Object(
  {
    issueChallans: Type.Array(IssueChallanRegisterEntrySchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type IssueChallanRegisterResponse = Static<
  typeof IssueChallanRegisterResponseSchema
>;

export const IssueChallanDetailResponseSchema = Type.Object(
  {
    issueChallan: IssueChallanSchema,
    lines: Type.Array(IssueChallanLineSchema),
    /** The immutable issue-time snapshot, verbatim; null while draft. */
    issuedSnapshot: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type IssueChallanDetailResponse = Static<
  typeof IssueChallanDetailResponseSchema
>;
