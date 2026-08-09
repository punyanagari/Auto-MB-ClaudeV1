import { Type, type Static } from '@sinclair/typebox';
import { ChallanStatusSchema } from './challans.js';
import { DateOnlySchema, UuidSchema } from './primitives.js';

// --- requires_serials flag management --------------------------------------

export const UpdateWorkItemSerialsRequestSchema = Type.Object(
  { requiresSerials: Type.Boolean() },
  { additionalProperties: false },
);
export type UpdateWorkItemSerialsRequest = Static<
  typeof UpdateWorkItemSerialsRequestSchema
>;

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
export type SerialSearchQuery = Static<typeof SerialSearchQuerySchema>;

export const SerialSearchMatchSchema = Type.Object(
  {
    id: UuidSchema,
    serialNumber: Type.String(),
    workId: UuidSchema,
    workCode: Type.String(),
    workTitle: Type.String(),
    itemDescription: Type.String(),
    challanId: UuidSchema,
    challanNumber: Type.Union([Type.String(), Type.Null()]),
    challanDate: DateOnlySchema,
    challanStatus: ChallanStatusSchema,
    receiptRecorded: Type.Boolean(),
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
