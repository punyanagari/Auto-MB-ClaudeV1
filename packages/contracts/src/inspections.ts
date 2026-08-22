import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import {
  DateOnlySchema,
  PositiveDecimalStringSchema,
  UuidSchema,
} from './primitives.js';

// --- The railway inspection lifecycle (migration 0082) ---------------------
//
// RDSO and RITES inspect manufactured material at the vendor's premises
// before it is despatched, and the certificate they issue is what makes the
// despatch legitimate. This module carries three surfaces:
//
//   * the CLAUSE — what the contract requires of each work item, including
//     whether a live certificate gates despatch;
//   * the CHECKLIST — what papers the agency demands on this Work;
//   * the CALL — one inspection, from outward request to certificate, with
//     the checklist snapshot it is held to.
//
// The clause is the one with teeth: `gatesDispatch` is read by the delivery
// challan issue path, and an item carrying it cannot be issued without a
// closed, unlapsed call covering it.

/** The two agencies that raise calls. `consignee` is not here: it inspects
 * after arrival, so there is no call to place and no certificate to wait
 * for. */
export const INSPECTION_AGENCIES = ['RDSO', 'RITES'] as const;
const InspectionAgencySchema = Type.Union(
  INSPECTION_AGENCIES.map((agency) => Type.Literal(agency)),
);
export type InspectionAgency = Static<typeof InspectionAgencySchema>;

/** Who inspects an item, as the clause mapping records it. Wider than
 * `InspectionAgency` by exactly one value, and the extra value is the
 * reason the two types exist separately: a consignee-inspected item is
 * configured here and never appears in the inspection workspace. */
export const INSPECTION_CLAUSE_AGENCIES = ['RDSO', 'RITES', 'consignee'] as const;
const InspectionClauseAgencySchema = Type.Union(
  INSPECTION_CLAUSE_AGENCIES.map((agency) => Type.Literal(agency)),
);
export type InspectionClauseAgency = Static<typeof InspectionClauseAgencySchema>;

/**
 * Where a call has got to.
 *
 * `closed` is the only value the dispatch gate accepts, and the schema's
 * closed-shape CHECK is what makes it mean inspected, passed and certified
 * rather than merely marked done.
 */
const INSPECTION_CALL_STATUSES = [
  'requested',
  'scheduled',
  'closed',
  'cancelled',
] as const;
const InspectionCallStatusSchema = Type.Union(
  INSPECTION_CALL_STATUSES.map((status) => Type.Literal(status)),
);
export type InspectionCallStatus = Static<typeof InspectionCallStatusSchema>;

/** `call_letter` is the agency's inward letter and `certificate` is the
 * paper the dispatch gate exists for; both are singular per call. Every
 * other demanded paper is `evidence`. */
const INSPECTION_DOCUMENT_KINDS = ['call_letter', 'certificate', 'evidence'] as const;
const InspectionDocumentKindSchema = Type.Union(
  INSPECTION_DOCUMENT_KINDS.map((kind) => Type.Literal(kind)),
);
export type InspectionDocumentKind = Static<typeof InspectionDocumentKindSchema>;

// --- The clause mapping ----------------------------------------------------

/** One row of the Work's clause mapping table: the item as the schedule
 * has it, plus the inspection configuration if any has been made. Items
 * with no clause are still listed — the screen is a table of ITEMS, and an
 * unmapped one is the row an operator has come to fill in. */
const InspectionClauseRowSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    description: Type.String(),
    unitCode: Type.String(),
    /** The live schedule quantity — `effective_quantity` where an approved
     * amendment moved it, otherwise the awarded figure. */
    awardedQuantity: Type.String(),
    /** How much the OEM has actually manufactured, which is what the
     * operator offers for inspection. Delivered quantity is the closest
     * honest proxy the product holds. */
    manufacturedQuantity: Type.String(),
    agency: Type.Union([InspectionClauseAgencySchema, Type.Null()]),
    inspectionQuantity: Type.Union([Type.String(), Type.Null()]),
    /** The vendor whose premises this item is inspected at, when it is a
     * contact this organisation holds (migration 0116). Joined live, not
     * snapshotted: a clause is configuration, so an address corrected in
     * the master should reach the next call raised under it. */
    vendorContactId: Type.Union([UuidSchema, Type.Null()]),
    vendorName: Type.Union([Type.String(), Type.Null()]),
    vendorAddressId: Type.Union([UuidSchema, Type.Null()]),
    /** The chosen address as it currently reads. Present only alongside
     * `vendorAddressId`; the free-text `vendorPremises` is the other, and
     * they are mutually exclusive by CHECK. */
    vendorAddress: Type.Union([Type.String(), Type.Null()]),
    /** A premises with no master row — half of them are sub-vendors, which
     * is why 0082 made this free text and why it survives. */
    vendorPremises: Type.Union([Type.String(), Type.Null()]),
    gatesDispatch: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type InspectionClauseRow = Static<typeof InspectionClauseRowSchema>;

const InspectionChecklistFieldSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 200 }),
    mandatory: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type InspectionChecklistField = Static<typeof InspectionChecklistFieldSchema>;

/** Everything the Work's Inspection clause tab needs, in one read: the
 * mapping table and both agencies' checklists. */
/** One agency's effective checklist for a Work, and where it came from.
 *
 * `inherited` is true when the Work has no list of its own and is being
 * held to the organisation's default. It matters on screen: editing an
 * inherited list creates a Work-specific override, and an operator is
 * entitled to know which of those two they are about to do. */
const InspectionChecklistSchema = Type.Object(
  {
    inherited: Type.Boolean(),
    fields: Type.Array(InspectionChecklistFieldSchema),
  },
  { additionalProperties: false },
);

export const WorkInspectionConfigSchema = Type.Object(
  {
    items: Type.Array(InspectionClauseRowSchema),
    checklists: Type.Object(
      { RDSO: InspectionChecklistSchema, RITES: InspectionChecklistSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type WorkInspectionConfig = Static<typeof WorkInspectionConfigSchema>;

/** One item's configuration as the mapping screen submits it. A null
 * `agency` clears the clause outright: the row goes away and the item is
 * simply not inspected. */
const InspectionClauseInputSchema = Type.Object(
  {
    workItemId: UuidSchema,
    agency: Type.Union([InspectionClauseAgencySchema, Type.Null()]),
    inspectionQuantity: Type.Union([PositiveDecimalStringSchema, Type.Null()]),
    /** Optional, so a caller that predates the address list — the v1
     * importer, an older client — keeps submitting the free-text
     * premises alone and means exactly what it always meant. */
    vendorContactId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    vendorAddressId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    vendorPremises: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
    gatesDispatch: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** The whole mapping in one request, because that is how the screen edits
 * it: a table of rows saved together. Partial submission would leave the
 * gate configured half from the old state and half from the new. */
export const SaveInspectionClausesRequestSchema = Type.Object(
  { clauses: Type.Array(InspectionClauseInputSchema) },
  { additionalProperties: false },
);
export type SaveInspectionClausesRequest = Static<
  typeof SaveInspectionClausesRequestSchema
>;

export const SaveInspectionChecklistRequestSchema = Type.Object(
  {
    agency: InspectionAgencySchema,
    /** `work` overrides this Work only; `organisation` edits the default
     * every Work without an override inherits. The second is what stops a
     * newly created Work starting with an empty checklist and a close gate
     * that therefore asks for nothing. */
    scope: Type.Union([Type.Literal('work'), Type.Literal('organisation')]),
    fields: Type.Array(InspectionChecklistFieldSchema),
  },
  { additionalProperties: false },
);
export type SaveInspectionChecklistRequest = Static<
  typeof SaveInspectionChecklistRequestSchema
>;

// --- The call ---------------------------------------------------------------

const InspectionCallDocumentSchema = Type.Object(
  {
    id: UuidSchema,
    kind: InspectionDocumentKindSchema,
    label: Type.String(),
    mandatory: Type.Boolean(),
    /** Null until the paper is uploaded. An outstanding mandatory row is
     * what stops the call closing. */
    originalFilename: Type.Union([Type.String(), Type.Null()]),
    sha256: Type.Union([Type.String({ pattern: '^[0-9a-f]{64}$' }), Type.Null()]),
    sizeBytes: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    uploadedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type InspectionCallDocument = Static<typeof InspectionCallDocumentSchema>;

const InspectionCallItemSchema = Type.Object(
  {
    workItemId: UuidSchema,
    itemNumber: Type.String(),
    description: Type.String(),
    quantity: Type.String(),
  },
  { additionalProperties: false },
);
export type InspectionCallItem = Static<typeof InspectionCallItemSchema>;

export const InspectionCallSchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    workCode: Type.String(),
    /** `INS/<work code>/<sequence>` — the outward request's identity, built
     * from the per-Work sequence the server assigned. */
    callReference: Type.String(),
    agency: InspectionAgencySchema,
    status: InspectionCallStatusSchema,
    requestedOn: DateOnlySchema,
    /** The agency's own number on the inward call letter. Typed, never
     * generated: the series is theirs. */
    agencyCallNumber: Type.Union([Type.String(), Type.Null()]),
    callLetterReceivedOn: Type.Union([DateOnlySchema, Type.Null()]),
    certificateNumber: Type.Union([Type.String(), Type.Null()]),
    certificateDate: Type.Union([DateOnlySchema, Type.Null()]),
    certificateValidUntil: Type.Union([DateOnlySchema, Type.Null()]),
    /** True when this call would satisfy the dispatch gate today: closed,
     * and its certificate has not lapsed. Derived on read against the
     * server's date, never stored. */
    certificateLive: Type.Boolean(),
    /** The vendor as it stood when the call was raised: the id is
     * provenance, the NAME and the premises text are the snapshot the
     * placing request printed (migration 0116). Renaming or retiring the
     * master afterwards changes neither. */
    vendorContactId: Type.Union([UuidSchema, Type.Null()]),
    vendorAddressId: Type.Union([UuidSchema, Type.Null()]),
    vendorName: Type.Union([Type.String(), Type.Null()]),
    vendorPremises: Type.Union([Type.String(), Type.Null()]),
    cancellationReason: Type.Union([Type.String(), Type.Null()]),
    /** ADVISORY. Delivery challans issued for this call's items while its
     * certificate was live — matched by item and issue date, not by a
     * recorded link, because no such link existed when they were issued.
     * It is what a withdrawal has to be able to enumerate: revoking a
     * certificate is only actionable if somebody can be told which lorries
     * went out under it. Populated for closed and withdrawn calls only. */
    advisoryIssuedChallans: Type.Array(
      Type.Object(
        {
          challanId: UuidSchema,
          challanNumber: Type.String(),
          challanDate: DateOnlySchema,
          itemNumber: Type.String(),
          quantity: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    items: Type.Array(InspectionCallItemSchema),
    documents: Type.Array(InspectionCallDocumentSchema),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type InspectionCall = Static<typeof InspectionCallSchema>;

/** The Inspection register: every call the caller may see, newest first,
 * plus the standing count of items whose clause gates dispatch and which
 * have no live certificate — the number the workspace's stat cards lead
 * with, and the reason the screen exists. */
export const InspectionCallListResponseSchema = Type.Object(
  {
    calls: Type.Array(InspectionCallSchema),
    awaitingCertificate: Type.Integer({ minimum: 0 }),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type InspectionCallListResponse = Static<
  typeof InspectionCallListResponseSchema
>;

export const CreateInspectionCallRequestSchema = Type.Object(
  {
    agency: InspectionAgencySchema,
    requestedOn: DateOnlySchema,
    /** Where the agency is being sent. A saved vendor address is copied
     * onto the call — name and text both — and free text is recorded as
     * typed; the two are alternatives. Omitting all three raises a call
     * with no premises, which 0082 already allowed. */
    vendorContactId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    vendorAddressId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    vendorPremises: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
    items: Type.Array(
      Type.Object(
        {
          workItemId: UuidSchema,
          quantity: PositiveDecimalStringSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);
export type CreateInspectionCallRequest = Static<
  typeof CreateInspectionCallRequestSchema
>;

/** Receiving the inward call letter is one act: the PDF is the body, and
 * the agency's number and the date it carries are the querystring — the
 * shape every upload route here already uses. */
export const ReceiveCallLetterQuerySchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    agencyCallNumber: Type.String({ minLength: 1, maxLength: 100 }),
    receivedOn: DateOnlySchema,
  },
  { additionalProperties: false },
);

export const UploadInspectionCertificateQuerySchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    certificateNumber: Type.String({ minLength: 1, maxLength: 100 }),
    certificateDate: DateOnlySchema,
    /** Omitted when the certificate does not lapse, which is the usual
     * case. Present, it is the date after which the gate refuses again. */
    validUntil: Type.Optional(DateOnlySchema),
  },
  { additionalProperties: false },
);

export const UploadInspectionEvidenceQuerySchema = Type.Object(
  { filename: Type.String({ minLength: 1, maxLength: 255 }) },
  { additionalProperties: false },
);

export const CancelInspectionCallRequestSchema = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 500 }) },
  { additionalProperties: false },
);
export type CancelInspectionCallRequest = Static<
  typeof CancelInspectionCallRequestSchema
>;
