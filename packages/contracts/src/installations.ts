import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema, withKeysetQuery } from './pagination.js';
import { LocationKindSchema } from './masters.js';
import { DateOnlySchema, DecimalStringSchema, UuidSchema } from './primitives.js';

// --- Quantity-level installation records (Milestone 7, legacy §5.4) --------
//
// An installation says "N units of item X went in at location L on date D".
// The location is snapshot-on-use: locationName is copied from the picked
// master at record time. Serial-flagged items attach exactly one delivered,
// uninstalled serial per unit; cancellation releases them back to the pool.

const InstallationStatusSchema = Type.Union([
  Type.Literal('recorded'),
  Type.Literal('cancelled'),
]);

/** Inline location creation (legacy §5.4: pick from the master or create
 * inline while recording). */
const NewInstallationLocationSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 200 }),
    kind: LocationKindSchema,
  },
  { additionalProperties: false },
);

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

const InstallationSerialSchema = Type.Object(
  {
    serialId: UuidSchema,
    serialNumber: Type.String(),
    challanNumber: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

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
    /** The ITEM's state, not this record's: true while the item holds
     * more installed than the contract sanctions and so owes a railway
     * variation order (migration 0077). Carried on the record because
     * the recording screen is where an operator finds out they have just
     * gone past the sanction — and because a cancellation that clears
     * the variation should say so on the record that cleared it. */
    pendingVariation: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Installation = Static<typeof InstallationSchema>;

/** Per-item aggregate of non-cancelled installation quantities. This is
 * THE authoritative installed quantity — Milestone 8 stage-wise billing
 * consumes exactly this SUM. */
const InstallationItemSummarySchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    installedQuantity: DecimalStringSchema,
  },
  { additionalProperties: false },
);

/** How many installation records a Work carries, by lifecycle state.
 *
 * Two integers, so the Work page can label and count its Installations
 * area without reading the records themselves. The list is serial-expanded
 * — one nested aggregate per record — and a page that only needs a number
 * should not pay for the numbers' provenance; the Work read already
 * aggregates installations per item, so this rides along with it. The
 * records themselves stay on the Installations tab, which loads them when
 * it is opened. */
export const InstallationCountsSchema = Type.Object(
  {
    recorded: Type.Integer({ minimum: 0 }),
    cancelled: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type InstallationCounts = Static<typeof InstallationCountsSchema>;

/** One row of the tenant-wide installation register.
 *
 * Deliberately NOT the full `Installation`: the register answers "what
 * went in, where, and under which Work", so it carries the Work's
 * identity and a serial COUNT rather than the serial list. The record's
 * own screen — its Work's Installations tab — remains the place the
 * serial numbers, the remarks and the cancellation note are read. */
const InstallationRegisterEntrySchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    workCode: Type.String(),
    workTitle: Type.String(),
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    quantity: DecimalStringSchema,
    installedOn: DateOnlySchema,
    /** Snapshot of the master's name at record time, exactly as on the
     * record itself. */
    locationName: Type.String(),
    /** How many serials this record was made against. A cancelled record
     * keeps its attachment history, so the count stays what it was
     * recorded with rather than dropping to zero when release returns the
     * units to the pool. */
    serialCount: Type.Integer({ minimum: 0 }),
    status: InstallationStatusSchema,
  },
  { additionalProperties: false },
);
export type InstallationRegisterEntry = Static<typeof InstallationRegisterEntrySchema>;

/** The register's query: a date window over `installedOn`, plus the two
 * keyset parameters.
 *
 * The window is the only filter, because it is the only one the surface's
 * stated question needs — "what went in this week, and where" is a date
 * range and nothing else. Work and status filters are deliberately absent:
 * a Work's own records are read on the Work, and a register that hid
 * cancelled records would report what still stands rather than what was
 * recorded. Both bounds are inclusive; either may be sent alone. */
export const InstallationRegisterQuerySchema = withKeysetQuery(
  Type.Object(
    {
      installedFrom: Type.Optional(DateOnlySchema),
      installedTo: Type.Optional(DateOnlySchema),
    },
    { additionalProperties: false },
  ),
);

/** Every installation record in the organisation the caller may see,
 * newest first. Cancelled records stay listed with their status: a
 * register that hid them would be a register of what is still true, not
 * of what was recorded. `nextCursor` pages the list; see `pagination.ts`. */
export const InstallationRegisterResponseSchema = Type.Object(
  {
    installations: Type.Array(InstallationRegisterEntrySchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type InstallationRegisterResponse = Static<
  typeof InstallationRegisterResponseSchema
>;

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
