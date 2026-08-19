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
  // The completion-extension trail (0011). Applying, finalising, the
  // railway's approval letter arriving, and the outcome being recorded
  // are the four acts that move a Work's contractual deadline — and
  // only the move itself used to reach this timeline, audited against
  // the Work. A deadline that changes with no letter beside it is the
  // one fact on a Work's history nobody can check.
  'extension_requests',
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
  // The correspondence register (0086). A letter filed against a Work is
  // part of that Work's paper trail — the approval that unblocked an
  // item, the clarification that changed a make — and a trail that
  // omitted the letters would leave those decisions unexplained. Letters
  // filed as general correspondence carry no work_id and simply never
  // match a Work's scope.
  'correspondence_letters',
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
  // The signing queue (0091, ADR-0012). Putting the organisation's own
  // certificate on an issued document is an act on that document, and a
  // trail that shows a challan issued but never shows it signed cannot
  // answer the one question a counterparty asks about it. The request,
  // its cancellation and its outcome all land here; the kiosk credential
  // that fulfilled it does not, being organisation-level.
  'signing_requests',
  // The site material request (0088). Raising one, approving it,
  // dispatching against it and closing it are acts on the Work: a
  // platform on this contract failed and the store answered it. A trail
  // that omitted them would leave the Work's own spare-part history
  // nowhere.
  //
  // ONE entity type for the whole module, deliberately. Every act —
  // approval, each dispatch challan, each defective receipt, the
  // closure — is audited against the REQUEST, because the request is
  // what a reader opens and the challan is read on it. Nothing here
  // writes `maintenance_dispatches` or `maintenance_returns` as an
  // entity type, so neither needs a line in the census either way.
  'maintenance_requests',
  // Retention, security deposit and liquidated damages (0098). Three
  // entity types, and all three belong on the Work's own trail because
  // all three are acts on THIS contract rather than on the organisation.
  //
  // The terms are the Work's reading of its own letter, on exactly the
  // footing `payment_matrices` sits on above: recording them decides what
  // every later assessment computes from, so a trail that showed an
  // assessment appear with no sign of the rates behind it would be a
  // trail with the decision missing.
  'work_retention_terms',
  // Money coming back is the end of the story the bill and the payment
  // register began. A Work whose trail stops at "the railway withheld
  // ₹1,50,000" and never says it was released is the exact gap this
  // module exists to close.
  'retention_releases',
  // And the damages: assessed, levied, waived or cancelled. Each is a
  // decision about money on this contract, and the assessment is the one
  // record that explains a deduction the railway made.
  'ld_assessments',
  // The defect liability period and the Work's warranty term (0099).
  // Starting a period fixes the date the railway's Performance Bank
  // Guarantee is measured against, and extending one is the only place
  // the REASON for a moved expiry is recorded at all — the pack keeps no
  // extension table, precisely because this trail is where this product
  // answers "why does this run to 2029". A Work whose guarantee cannot
  // be released, with no trail saying why, is the gap.
  //
  // The term is audited against the WORK's own id rather than the term
  // row's: there is one term per Work, it has no screen of its own to
  // open, and a reader asking what happened to this Work wants it in the
  // same list.
  'installation_warranties',
  'work_warranty_terms',
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

export const EntityTimelineQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  },
  { additionalProperties: false },
);

const TimelineEventSchema = Type.Object(
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
