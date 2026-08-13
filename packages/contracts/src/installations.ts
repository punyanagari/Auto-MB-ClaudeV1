import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import { LocationKindSchema } from './masters.js';
import { DateOnlySchema, DecimalStringSchema, UuidSchema } from './primitives.js';

// --- Quantity-level installation records (Milestone 7, legacy §5.4) --------
//
// An installation says "N units of item X went in at location L on date D".
// The location is snapshot-on-use: locationName is copied from the picked
// master at record time. Serial-flagged items attach exactly one delivered,
// uninstalled serial per unit; cancellation releases them back to the pool.

export const InstallationStatusSchema = Type.Union([
  Type.Literal('recorded'),
  Type.Literal('cancelled'),
]);
export type InstallationStatus = Static<typeof InstallationStatusSchema>;

/** Inline location creation (legacy §5.4: pick from the master or create
 * inline while recording). */
export const NewInstallationLocationSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 200 }),
    kind: LocationKindSchema,
  },
  { additionalProperties: false },
);
export type NewInstallationLocation = Static<typeof NewInstallationLocationSchema>;

export const RecordInstallationRequestSchema = Type.Object(
  {
    workItemId: UuidSchema,
    quantity: DecimalStringSchema,
    installedOn: DateOnlySchema,
    /** Exactly one of locationId / newLocation. */
    locationId: Type.Optional(UuidSchema),
    newLocation: Type.Optional(NewInstallationLocationSchema),
    remarks: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    /** Required (one per unit) for serial-flagged items; forbidden
     * otherwise. */
    serialIds: Type.Optional(Type.Array(UuidSchema, { minItems: 1, maxItems: 500 })),
  },
  { additionalProperties: false },
);
export type RecordInstallationRequest = Static<typeof RecordInstallationRequestSchema>;

export const CancelInstallationRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);
export type CancelInstallationRequest = Static<typeof CancelInstallationRequestSchema>;

export const InstallationSerialSchema = Type.Object(
  {
    serialId: UuidSchema,
    serialNumber: Type.String(),
    challanNumber: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type InstallationSerial = Static<typeof InstallationSerialSchema>;

export const InstallationSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    quantity: DecimalStringSchema,
    installedOn: DateOnlySchema,
    locationId: UuidSchema,
    /** Snapshot of the master's name at record time; later master edits
     * never rewrite it. */
    locationName: Type.String(),
    remarks: Type.Union([Type.String(), Type.Null()]),
    status: InstallationStatusSchema,
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    /** Serials covered by this record (still listed after cancellation —
     * the attachment history stays; released serials return to the pool). */
    serials: Type.Array(InstallationSerialSchema),
    createdAt: Type.String({ format: 'date-time' }),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type Installation = Static<typeof InstallationSchema>;

/** Per-item aggregate of non-cancelled installation quantities. This is
 * THE authoritative installed quantity — Milestone 8 stage-wise billing
 * consumes exactly this SUM. */
export const InstallationItemSummarySchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    installedQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);
export type InstallationItemSummary = Static<typeof InstallationItemSummarySchema>;

/** The Work's installation records, with the per-item totals.
 *
 * `itemSummaries` is deliberately NOT paged with `installations`: it is
 * one row per Work item (bounded by the LOA schedule) and it aggregates
 * EVERY live installation, not the page. A page of records beside a
 * summary of the page would be a quieter kind of wrong than an unpaged
 * list — the totals on screen have to be the Work's totals.
 *
 * `nextCursor` pages `installations` only; see `pagination.ts`. */
export const InstallationListResponseSchema = Type.Object(
  {
    installations: Type.Array(InstallationSchema),
    itemSummaries: Type.Array(InstallationItemSummarySchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type InstallationListResponse = Static<typeof InstallationListResponseSchema>;
