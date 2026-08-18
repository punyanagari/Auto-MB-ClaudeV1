import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema, nonBlankString } from './primitives.js';

// --- The platform controls (migration 0096) ---------------------------------
//
// Three operator surfaces that have nothing to do with contract execution
// and everything to do with running the product for an organisation:
// which modules it may use, which recurring statutory checks run, and a
// self-service copy of its whole record.
//
// THE MOCK DRAWS NO PLATFORM SCREEN, and there is nothing at
// `punyanagari/Auto-MB-Vercel-du@fdfd610` to cite for one. These panels
// are application-first under AGENTS.md § Design contract 2 and 4, built
// from the mock's existing Card, field, switch, table and confirm-dialog
// anatomy with no new visual language. `docs/UX.md` § 20 records the
// stance and the reasoning rather than inventing a citation.
//
// ENTITLEMENTS ARE NOT PERMISSIONS, and the wire shape keeps the two
// apart on purpose: a membership carries `can*` booleans about a PERSON,
// and an entitlement carries `enabled` about a MODULE. Nothing here names
// a user except the operator who last set a flag.

/* --- Entitlements --------------------------------------------------------- */

const ENTITLEMENT_FLAG_KEYS = ['eway_bill', 'outbound_signing'] as const;
const EntitlementFlagKeySchema = Type.Union(
  ENTITLEMENT_FLAG_KEYS.map((value) => Type.Literal(value)),
  {
    description:
      'Which module the flag governs. The database CHECK is the authority; a key it does not admit is refused at write time.',
  },
);
export type EntitlementFlagKey = Static<typeof EntitlementFlagKeySchema>;

export const EntitlementSchema = Type.Object(
  {
    key: EntitlementFlagKeySchema,
    label: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    /** What the module actually does for this organisation right now. */
    enabled: Type.Boolean(),
    /** What it would do with no row at all. Shown beside the effective
     * value so an operator can tell "we chose this" from "nobody has ever
     * touched it". */
    defaultEnabled: Type.Boolean(),
    /** True when this organisation has an explicit row. */
    configured: Type.Boolean(),
    note: Type.Union([Type.String(), Type.Null()]),
    setBy: Type.Union([Type.String(), Type.Null()]),
    updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type Entitlement = Static<typeof EntitlementSchema>;

export const EntitlementListResponseSchema = Type.Object(
  { entitlements: Type.Array(EntitlementSchema) },
  { additionalProperties: false },
);
export type EntitlementListResponse = Static<typeof EntitlementListResponseSchema>;

export const SetEntitlementRequestSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    note: Type.Optional(
      Type.Union([nonBlankString({ minLength: 2, maxLength: 500 }), Type.Null()], {
        description:
          'Why it was set this way. "Off" without "waiting on NIC re-certification" is a fact nobody can act on six months later.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type SetEntitlementRequest = Static<typeof SetEntitlementRequestSchema>;

export const EntitlementResponseSchema = Type.Object(
  { entitlement: EntitlementSchema },
  { additionalProperties: false },
);
export type EntitlementResponse = Static<typeof EntitlementResponseSchema>;

/* --- Recurring statutory checks ------------------------------------------- */

const SCHEDULED_JOB_KINDS = ['instrument_expiry_review'] as const;
const ScheduledJobKindSchema = Type.Union(
  SCHEDULED_JOB_KINDS.map((value) => Type.Literal(value)),
  { description: 'Which recurring check the schedule runs.' },
);
export type ScheduledJobKind = Static<typeof ScheduledJobKindSchema>;

const CADENCES = ['daily', 'weekly', 'monthly'] as const;
const CadenceSchema = Type.Union(
  CADENCES.map((value) => Type.Literal(value)),
  {
    description: 'How often the check runs.',
  },
);
export type ScheduleCadence = Static<typeof CadenceSchema>;

export const JobScheduleSchema = Type.Object(
  {
    id: UuidSchema,
    kind: ScheduledJobKindSchema,
    label: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    enabled: Type.Boolean(),
    cadence: CadenceSchema,
    horizonDays: Type.Integer({ minimum: 1, maximum: 365 }),
    nextRunAt: Type.String({ format: 'date-time' }),
    lastRunAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /** The member whose authority the enqueued job runs under. ADR-0011:
     * there is no service identity, so a schedule borrows a real
     * membership and stops working when that membership does. */
    authorityUserId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type JobSchedule = Static<typeof JobScheduleSchema>;

/** One run of a scheduled check, as the queue recorded it.
 *
 * `refusedBind` is not a failure mode of the check: it is the queue saying
 * the member whose authority the schedule borrows no longer holds one, and
 * the remedy — a current member re-enables the schedule — is different
 * from every other failure's. */
export const JobRunSchema = Type.Object(
  {
    id: UuidSchema,
    kind: ScheduledJobKindSchema,
    state: Type.Union(
      [
        Type.Literal('queued'),
        Type.Literal('claimed'),
        Type.Literal('done'),
        Type.Literal('failed'),
        Type.Literal('refused_bind'),
      ],
      { description: 'Where the run got to (migration 0072).' },
    ),
    attempts: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: 'date-time' }),
    finishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /** What the check found, as the handler recorded it. */
    outcome: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    lastError: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type JobRun = Static<typeof JobRunSchema>;

export const JobScheduleListResponseSchema = Type.Object(
  {
    schedules: Type.Array(JobScheduleSchema),
    runs: Type.Array(JobRunSchema),
  },
  { additionalProperties: false },
);
export type JobScheduleListResponse = Static<typeof JobScheduleListResponseSchema>;

export const UpdateJobScheduleRequestSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    cadence: Type.Optional(CadenceSchema),
    horizonDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  },
  { additionalProperties: false },
);
export type UpdateJobScheduleRequest = Static<typeof UpdateJobScheduleRequestSchema>;

export const JobScheduleResponseSchema = Type.Object(
  { schedule: JobScheduleSchema },
  { additionalProperties: false },
);
export type JobScheduleResponse = Static<typeof JobScheduleResponseSchema>;

/* --- The organisation's own copy of itself -------------------------------- */

export const OrganisationExportSchema = Type.Object(
  {
    id: UuidSchema,
    state: Type.Union(
      [
        Type.Literal('queued'),
        Type.Literal('running'),
        Type.Literal('ready'),
        Type.Literal('failed'),
        Type.Literal('expired'),
      ],
      { description: 'Where the artefact got to.' },
    ),
    requestedBy: Type.String({ minLength: 1 }),
    requestedAt: Type.String({ format: 'date-time' }),
    completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /** The format the artefact WAS written in, not the one the product
     * now emits. A bundle restored years later has to say which shape it
     * is. */
    formatVersion: Type.Union([Type.String(), Type.Null()]),
    /** Decimal string, like every other authoritative number on the wire —
     * a byte count for a whole-organisation package outgrows the safe
     * integer range far more slowly than money does, but the product has
     * one rule about numbers and this is not the place to make a second. */
    byteSize: Type.Union([Type.String(), Type.Null()]),
    sha256: Type.Union([Type.String(), Type.Null()]),
    expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    failureReason: Type.Union([Type.String(), Type.Null()]),
    downloadCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type OrganisationExport = Static<typeof OrganisationExportSchema>;

export const OrganisationExportListResponseSchema = Type.Object(
  {
    exports: Type.Array(OrganisationExportSchema),
    /** How long a built artefact stays downloadable, so the screen can say
     * so before the operator commits to building one. */
    retentionHours: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type OrganisationExportListResponse = Static<
  typeof OrganisationExportListResponseSchema
>;

export const OrganisationExportResponseSchema = Type.Object(
  { export: OrganisationExportSchema },
  { additionalProperties: false },
);
export type OrganisationExportResponse = Static<
  typeof OrganisationExportResponseSchema
>;
