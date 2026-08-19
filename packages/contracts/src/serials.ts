import { Type, type Static } from '@sinclair/typebox';
import { ChallanStatusSchema } from './challans.js';
import { DateOnlySchema, UuidSchema } from './primitives.js';

// --- requires_serials flag management --------------------------------------

export const UpdateWorkItemSerialsRequestSchema = Type.Object(
  { requiresSerials: Type.Boolean() },
  { additionalProperties: false },
);

export const WorkItemSerialsResponseSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    requiresSerials: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type WorkItemSerialsResponse = Static<typeof WorkItemSerialsResponseSchema>;

// --- Tenant-wide serial lookup ---------------------------------------------

export const SerialSearchQuerySchema = Type.Object(
  {
    q: Type.String({
      minLength: 2,
      maxLength: 100,
      description: 'Case-insensitive substring of the serial number.',
    }),
  },
  { additionalProperties: false },
);

/**
 * Where a serial number ENTERED the record, as the column of the same name
 * on `challan_item_serials` holds it (migration 0108).
 *
 * `delivery` is the original: the number was captured on a Delivery
 * Challan line. `installation` is the number the challan missed — typed at
 * site by the person in front of the equipment, recorded against the
 * installation instead of against a challan that has already been issued
 * and is not going to be edited.
 *
 * This is a fact about the unit's paperwork, and traceability is the
 * reason it is carried rather than smoothed over: a unit whose nameplate
 * reached the record late is exactly the unit whose provenance somebody
 * will one day ask about.
 */
export const SerialOriginSchema = Type.Union([
  Type.Literal('delivery'),
  Type.Literal('installation'),
]);
export type SerialOrigin = Static<typeof SerialOriginSchema>;

/** Where a matched serial came from.
 *
 * The two origins above, plus `production`: a unit the factory built
 * (migration 0084), which lives in its own table, may have no Work at all
 * — a job card raised against a private purchase order is the ordinary
 * case — and has not been despatched under any challan yet. */
const SerialSourceSchema = Type.Union([SerialOriginSchema, Type.Literal('production')]);

const SerialSearchMatchSchema = Type.Object(
  {
    id: UuidSchema,
    serialNumber: Type.String(),
    source: SerialSourceSchema,
    /* THE WORK AND CHALLAN BLOCK IS NULLABLE, and that is what the
       production union costs. A delivery serial always has both — it
       exists because a challan line captured it. A production serial has
       neither at the moment it is minted: it is named from the item's own
       series before any contract has been chosen for it, and a job card
       may serve a private order with no Work in the product at all.
       Widening these is the honest shape; the alternative was inventing
       a Work for a unit that has none. */
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
    workTitle: Type.Union([Type.String(), Type.Null()]),
    itemDescription: Type.String(),
    challanId: Type.Union([UuidSchema, Type.Null()]),
    challanNumber: Type.Union([Type.String(), Type.Null()]),
    challanDate: Type.Union([DateOnlySchema, Type.Null()]),
    challanStatus: Type.Union([ChallanStatusSchema, Type.Null()]),
    receiptRecorded: Type.Boolean(),
    /** Production only: the job card that built the unit, and how far
     * its genealogy has been recorded. Null on a delivery serial. */
    jobCardNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    jobCardId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    /** How many component serials are recorded inside this unit, and
     * whether its bill of material is satisfied. */
    componentsCaptured: Type.Optional(Type.Integer({ minimum: 0 })),
    genealogyComplete: Type.Optional(Type.Boolean()),
    /** The date the unit left production, or null while it is still on
     * the factory floor. */
    releasedOn: Type.Optional(Type.Union([DateOnlySchema, Type.Null()])),
    installedOn: Type.Union([DateOnlySchema, Type.Null()]),
    /** Live quantity-level installation record covering this serial
     * (Milestone 7): id and snapshot location name, null when the serial
     * is uninstalled or only carries a legacy per-serial date. */
    installationId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    installationLocation: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);
export type SerialSearchMatch = Static<typeof SerialSearchMatchSchema>;

export const SerialSearchResponseSchema = Type.Object(
  {
    matches: Type.Array(SerialSearchMatchSchema),
    /** True when more than the returned cap matched; refine the query. */
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SerialSearchResponse = Static<typeof SerialSearchResponseSchema>;
