import { Type, type Static } from '@sinclair/typebox';
import {
  NextCursorSchema,
  SortedNextCursorSchema,
  withSortedKeysetQuery,
} from './pagination.js';
import { LocationKindSchema } from './masters.js';
import { SerialOriginSchema } from './serials.js';
import {
  DateOnlySchema,
  DecimalStringSchema,
  PositiveDecimalStringSchema,
  UuidSchema,
} from './primitives.js';

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

/** A serial number as it is typed at site, on the tabular recording flow.
 *
 * A NUMBER, not an id, because the point of the flow is that the number
 * may not be in the record yet: a nameplate missed on the Delivery Challan
 * is discovered by the person standing in front of the equipment. A number
 * already in the delivered pool links exactly as the id form does; one
 * that is not is accepted and recorded as entering at the installation
 * (migration 0108). The 100-character bound is the column's. */
const SerialNumberSchema = Type.String({ minLength: 1, maxLength: 100 });

/** One line of the tabular flow: an item, how much of it went in, and the
 * serials covering it. */
const RecordInstallationRowSchema = Type.Object(
  {
    workItemId: UuidSchema,
    /** STRICTLY POSITIVE, not the unbounded `DecimalString` the
     * single-record route still takes. `installations.quantity` carries
     * `CHECK (quantity > 0)`, so a typed `0` or `-5` used to travel the
     * whole way to the database and come back as a 500 that rolled the
     * entire visit back without naming the cell that did it. Refused at
     * the door instead, where the validator names the row and its index. */
    quantity: PositiveDecimalStringSchema,
    /** Required (one per unit) for serial-flagged items; forbidden
     * otherwise — the same rule the single-record route holds, said about
     * numbers instead of ids.
     *
     * 200 is the cap because a row is one item at one location on one day,
     * and this whole batch runs inside a single transaction holding the
     * Work row lock that MB finalize contends for; see the envelope note
     * on `rows` below. */
    serialNumbers: Type.Optional(
      Type.Array(SerialNumberSchema, { minItems: 1, maxItems: 200 }),
    ),
  },
  { additionalProperties: false },
);

/**
 * One site visit: a date, a location, and every item that went in.
 *
 * Recording items one at a time was the shape of the form, not of the
 * work: a crew installs six items at one station on one day and typed the
 * date and the station six times, with six chances to disagree with
 * itself. The date and the location are therefore stated ONCE, above the
 * rows, and each filled row becomes its own installation record — the same
 * records the single route writes, so measurement, PAC coverage and the
 * variation flag all read them unchanged.
 *
 * All-or-nothing: the whole batch is one transaction, because half a site
 * visit recorded is worse than none, and the operator would have no way to
 * tell which half. Rows naming the same item twice are refused rather than
 * summed — two quantities for one item on one day is a typo far more often
 * than it is two deliveries.
 */
export const RecordInstallationBatchRequestSchema = Type.Object(
  {
    installedOn: DateOnlySchema,
    /** Exactly one of locationId / newLocation, as on the single route. */
    locationId: Type.Optional(UuidSchema),
    newLocation: Type.Optional(NewInstallationLocationSchema),
    /** Carried onto every record the batch writes: one visit, one note. */
    remarks: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    /**
     * THE ENVELOPE IS A LOCK BUDGET, not a guess at how much a crew can
     * install. The whole batch is one transaction and it holds the Work row
     * lock from its first row to its last — the same lock a Measurement
     * Book finalize takes, and the reason recording and finalizing cannot
     * interleave. 100 rows of up to 200 serials each is 20,000 attachment
     * rows, which is already far past any real site visit and is where the
     * wait a concurrent finalize would sit through stops being reasonable.
     *
     * A visit larger than this is two visits, and the operator records it
     * as two. Raising the cap means measuring what the lock hold does to a
     * finalize first.
     */
    rows: Type.Array(RecordInstallationRowSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type RecordInstallationBatchRequest = Static<
  typeof RecordInstallationBatchRequestSchema
>;

export const CancelInstallationRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);

const InstallationSerialSchema = Type.Object(
  {
    serialId: UuidSchema,
    serialNumber: Type.String(),
    /** Null for a serial that entered at this installation — there is no
     * challan to name, and inventing one would be the lie the origin
     * exists to prevent. */
    challanNumber: Type.Union([Type.String(), Type.Null()]),
    /** Where the number entered the record: `delivery` off a Delivery
     * Challan line, `installation` typed at site against a unit whose
     * nameplate the challan missed (migration 0108). Optional so records
     * serialised before the origin existed stay valid; the server always
     * serves it. */
    origin: Type.Optional(SerialOriginSchema),
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

/** Every record one site visit wrote, in the row order it was sent.
 *
 * A list rather than the single record the one-at-a-time route answers
 * with: the caller filled several rows and each is now its own record,
 * with its own id, its own serials and its own reading of the item's
 * variation flag. */
export const RecordInstallationBatchResponseSchema = Type.Object(
  { installations: Type.Array(InstallationSchema) },
  { additionalProperties: false },
);
export type RecordInstallationBatchResponse = Static<
  typeof RecordInstallationBatchResponseSchema
>;

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
export const InstallationRegisterQuerySchema = withSortedKeysetQuery(
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
    /* Sort-tagged: this register sorts, so its cursor carries the order
     * it was minted under and cannot be replayed under the other one. */
    nextCursor: SortedNextCursorSchema,
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
