import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema } from './primitives.js';

/** Entity types whose audit events belong to a Work's timeline. The
 * capture side writes these exact strings into audit_events.entity_type;
 * the read API refuses anything else so the endpoint stays a per-Work
 * trail, not an organisation-wide search (that is Milestone 9). */
export const TIMELINE_ENTITY_TYPES = [
  'works',
  'delivery_challans',
  'issue_challans',
  'challan_receipts',
  'challan_item_serials',
  'work_instruments',
  'mb_entries',
  'bills',
  // The payment register (0067). Money received is the one part of the
  // chain the timeline could not see, which made a Work's history stop
  // at the bill it prepared.
  'bill_payments',
  'installations',
  'approval_requests',
  'correction_notices',
  'work_items',
  'payment_matrices',
  'pac_certificates',
  'measurement_books',
  // The railway's own On-Account Bill (0066). Recording and discarding
  // it are acts on the Work's paper trail, and closure of a Measurement
  // Book rests on it — a trail that omitted the bill would show a
  // measurement closing with no sign of what closed it.
  'received_railway_bills',
  // The RDSO/RITES inspection call (0082). Raising it, receiving the
  // agency's letter, certifying and withdrawing are acts on the Work's
  // paper trail — and a despatch this Work could not make without the
  // certificate is unexplainable from a trail that never mentions it.
  'inspection_calls',
  // The production job card (0084). Raising, revising, completing and
  // cancelling an order to BUILD what the Work will be delivered are
  // acts on the Work's paper trail, and a delivery whose units were
  // manufactured is unexplainable from a trail that starts at despatch.
  //
  // Only the card. The units it produces, their component genealogy and
  // their releases stay off the timeline deliberately: a job card for
  // five hundred boards would otherwise put five hundred rows on the
  // Work's history, and the place to read a unit is the job card. The
  // census in `apps/server/test/audit-timeline-census.test.ts` records
  // the same reasoning against each of them.
  'production_job_cards',
] as const;
export type TimelineEntityType = (typeof TIMELINE_ENTITY_TYPES)[number];

// Params are validated with a pattern rather than the uuid format so the
// check does not depend on the ajv instance's format registry.
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export const TimelineQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    /** Keyset cursor: the id of the last event on the previous page. */
    cursor: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
    /** Comma-separated subset of TIMELINE_ENTITY_TYPES to include. */
    entityTypes: Type.Optional(
      Type.String({ pattern: '^[a-z_]+(,[a-z_]+)*$', maxLength: 200 }),
    ),
  },
  { additionalProperties: false },
);
export type TimelineQuery = Static<typeof TimelineQuerySchema>;

export const EntityTimelineQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  },
  { additionalProperties: false },
);
export type EntityTimelineQuery = Static<typeof EntityTimelineQuerySchema>;

export const TimelineEventSchema = Type.Object(
  {
    id: UuidSchema,
    occurredAt: Type.String({ format: 'date-time' }),
    actorUserId: Type.Union([Type.String(), Type.Null()]),
    /** Display name resolved from the actor's account; null for system
     * events or deleted accounts. */
    actorName: Type.Union([Type.String(), Type.Null()]),
    action: Type.String(),
    entityType: Type.String(),
    entityId: Type.Union([UuidSchema, Type.Null()]),
    /** The event's recorded detail payload, verbatim. UPDATE-shaped
     * events carry { before: {field: old}, after: {field: new} } for the
     * changed business fields only. */
    details: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type TimelineEvent = Static<typeof TimelineEventSchema>;

export const TimelineResponseSchema = Type.Object(
  {
    events: Type.Array(TimelineEventSchema),
    /** Pass as `cursor` to fetch the next (older) page; null when the
     * trail is exhausted. */
    nextCursor: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type TimelineResponse = Static<typeof TimelineResponseSchema>;
