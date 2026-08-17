import { Type, type Static } from '@sinclair/typebox';
import { CompanyDocumentExpiryStatusSchema } from './company-documents.js';
import {
  DATE_ONLY_PATTERN,
  DateOnlySchema,
  NonNegativeMoneyStringSchema,
  UuidSchema,
} from './primitives.js';

// --- The tender pipeline (migration 0083) ----------------------------------
//
// The pre-award half of the ledger: the Notice Inviting Tender, the bid
// package assembled against the company document library, the trail of
// what a human did on iREPS, and — when it is won — the deep link into
// the ordinary LOA intake that turns the tender into a Work.
//
// A tender belongs to no Work. That is the definition, not an omission:
// the Work is what winning it produces.

/** Where a bid stands. Forward-only; `awarded` and `lost` are terminal,
 * enforced by the transition trigger in 0083 rather than by whichever
 * route happened to be called. */
export const TENDER_STATUSES = [
  'drafted',
  'submitted',
  'opened',
  'awarded',
  'lost',
] as const;

export const TenderStatusSchema = Type.Union(
  TENDER_STATUSES.map((status) => Type.Literal(status)),
);
export type TenderStatus = Static<typeof TenderStatusSchema>;

/** A closing moment as a wall clock in the organisation's own timezone:
 * `YYYY-MM-DDTHH:MM`, the shape `<input type="datetime-local">` uses.
 *
 * Not an instant and not a date. A railway tender closes at a stated
 * time of day, so the time is load-bearing (a bid at 15:01 is rejected)
 * and the date alone would throw it away. Binding the wall clock to an
 * offset is the server's job, done once against `organisations.timezone`,
 * so a browser in another timezone cannot shift a deadline. */
export const LocalDateTimeSchema = Type.String({
  /* The date half is `DateOnlySchema`'s own pattern, unanchored and
   * reused rather than re-derived, so a wall clock cannot admit a day the
   * calendar does not have. A shape-only `3[01]` accepted
   * `2026-02-31T15:00`, which passed every application check and failed
   * only when PostgreSQL cast it — reaching the caller as a bare 500.
   * That is exactly the defect the comment on `DateOnlySchema` describes,
   * and there is no reason for this schema to repeat it. */
  pattern: `^${DATE_ONLY_PATTERN}T(?:[01]\\d|2[0-3]):[0-5]\\d$`,
  description:
    'Wall-clock moment in the organisation timezone, YYYY-MM-DDTHH:MM. Never an instant.',
});
export type LocalDateTime = Static<typeof LocalDateTimeSchema>;

/* --- The NIT proposal --------------------------------------------------- */

/** One extracted field: what the machine read, the source text it read it
 * from, and whether a human has to look. The `field.ts` contract
 * `@auto-mb/loa-parser` has followed since DC-23, carried to the wire. */
export const TenderNoticeFieldSchema = Type.Object(
  {
    value: Type.Union([Type.String(), Type.Null()]),
    raw: Type.Union([Type.String(), Type.Null()]),
    needsReview: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TenderNoticeField = Static<typeof TenderNoticeFieldSchema>;

export const TenderNoticeProposalSchema = Type.Object(
  {
    tenderNumber: TenderNoticeFieldSchema,
    authority: TenderNoticeFieldSchema,
    title: TenderNoticeFieldSchema,
    bidClosesAtLocal: TenderNoticeFieldSchema,
    estimatedValue: TenderNoticeFieldSchema,
    emdAmount: TenderNoticeFieldSchema,
    eligibility: TenderNoticeFieldSchema,
    needsReviewTotal: Type.Integer({ minimum: 0 }),
    identityUnresolved: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TenderNoticeProposal = Static<typeof TenderNoticeProposalSchema>;

/** Why a notice could not be read, as a closed set.
 *
 * Deliberately NOT the thrown message. `pdftotext`'s diagnostics name the
 * temporary file the bytes were written to and echo whatever the binary
 * said about the document; the row that holds them is permanent, and the
 * organisation export hands it back. Two values are all a screen needs:
 * the PDF had nothing to read, or the run failed for some other reason.
 * The detail goes to the server log. */
export const TENDER_NOTICE_EXTRACTION_ERRORS = [
  'pdf_unreadable',
  'extraction_failed',
] as const;

export const TenderNoticeExtractionErrorSchema = Type.Union(
  TENDER_NOTICE_EXTRACTION_ERRORS.map((code) => Type.Literal(code)),
);
export type TenderNoticeExtractionError = Static<
  typeof TenderNoticeExtractionErrorSchema
>;

export function isExtractionError(value: string): value is TenderNoticeExtractionError {
  return (TENDER_NOTICE_EXTRACTION_ERRORS as readonly string[]).includes(value);
}

export const TenderNoticeSchema = Type.Object(
  {
    id: UuidSchema,
    originalFilename: Type.String(),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    sizeBytes: Type.Integer({ minimum: 1 }),
    /** `review` when the notice was read and there is a proposal to
     * confirm; `failed` when it has no text layer. There is no `pending`:
     * the reading is synchronous, because six labelled fields off a short
     * notice is a `pdftotext` run rather than a job. */
    extractionStatus: Type.Union([Type.Literal('review'), Type.Literal('failed')]),
    proposal: Type.Union([TenderNoticeProposalSchema, Type.Null()]),
    /** Why the reading failed, when it did — one of a closed set, never
     * the extractor's own diagnostic. */
    extractionError: Type.Union([TenderNoticeExtractionErrorSchema, Type.Null()]),
    confirmedTenderId: Type.Union([UuidSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type TenderNotice = Static<typeof TenderNoticeSchema>;

export const TenderNoticeUploadQuerySchema = Type.Object(
  { filename: Type.String({ minLength: 1, maxLength: 255 }) },
  { additionalProperties: false },
);
export type TenderNoticeUploadQuery = Static<typeof TenderNoticeUploadQuerySchema>;

/** What the reviewer accepted. Every field is sent explicitly, because
 * the proposal is evidence and this is the record: a value the human did
 * not look at is not a value the tender should carry.
 *
 * `PATCH /api/tenders/:id` takes the same shape, deliberately and without
 * an alias of its own: a correction restates the whole record rather than
 * patching a field, because the seven facts are read together off one
 * notice and a partial update invites the half-corrected row where the
 * number was fixed and the closing date was not. The correction is
 * permitted only while the tender is `drafted`; from submission onwards
 * these are the facts a bid went out under, and the 0083 guard refuses
 * the write whatever the route does. */
export const ConfirmTenderRequestSchema = Type.Object(
  {
    tenderNumber: Type.String({ minLength: 1, maxLength: 120 }),
    authority: Type.String({ minLength: 1, maxLength: 200 }),
    title: Type.String({ minLength: 3, maxLength: 1000 }),
    bidClosesAtLocal: LocalDateTimeSchema,
    estimatedValue: Type.Optional(NonNegativeMoneyStringSchema),
    emdAmount: Type.Optional(NonNegativeMoneyStringSchema),
    eligibilitySummary: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type ConfirmTenderRequest = Static<typeof ConfirmTenderRequestSchema>;

/* --- The bid checklist -------------------------------------------------- */

/** How an attached credential reads AGAINST THIS TENDER'S closing date —
 * not against today, which is the whole point.
 *
 * A GST certificate that lapses next week is `valid` today and useless
 * for a bid that opens next month. The four values are the company
 * document library's own (`CompanyDocumentExpiryStatus`), reused verbatim
 * so the chip tones and the operator's learned vocabulary carry across
 * unchanged:
 *
 *   none      the credential has no expiry
 *   valid     valid at the closing date, with room to spare
 *   expiring  valid at the closing date but lapsing soon after it
 *   expired   NOT valid at the closing date — this line blocks the bid
 *
 * A credential that has been ARCHIVED reports its expiry reading here
 * unchanged and says so in `companyDocumentArchived`. The two are not
 * collapsed: "this certificate lapses before the bid opens" and "this
 * certificate was retired from the library" are different facts with
 * different remedies, and a screen that showed both as "Expired" would
 * send an operator to renew a document that does not need renewing.
 */
export const TenderChecklistValiditySchema = CompanyDocumentExpiryStatusSchema;
export type TenderChecklistValidity = Static<typeof TenderChecklistValiditySchema>;

export const TenderChecklistItemSchema = Type.Object(
  {
    id: UuidSchema,
    title: Type.String(),
    mandatory: Type.Boolean(),
    /** The library credential answering this line, or null when nobody
     * has answered it yet — or when the caller may not see which one it
     * is (see `restricted`). */
    companyDocumentId: Type.Union([UuidSchema, Type.Null()]),
    companyDocumentTitle: Type.Union([Type.String(), Type.Null()]),
    /** True when a credential IS attached but its identity is withheld
     * from this caller, because it is in the restricted category and they
     * do not hold the writer role.
     *
     * The line still reports its `validity` and its `blocking` state, so
     * the counts a viewer sees are the same counts a writer sees. That is
     * the point of redacting rather than excluding: a bid package with
     * three blocking lines has three for everyone, and a viewer chasing a
     * missing document is not sent looking for a line that is already
     * answered by a document they may not read. */
    restricted: Type.Boolean(),
    /** True when the attached credential has since been ARCHIVED in the
     * library. Its own fact rather than a validity reading, because it is
     * a different problem with a different remedy: an expired credential
     * needs a renewal uploaded, an archived one needs putting back in the
     * library or replacing on this line. Both block. */
    companyDocumentArchived: Type.Boolean(),
    /** The version that would be attached: the credential's newest. */
    companyDocumentVersionNumber: Type.Union([
      Type.Integer({ minimum: 1 }),
      Type.Null(),
    ]),
    /** That version's expiry, as the certificate prints it. */
    expiresOn: Type.Union([DateOnlySchema, Type.Null()]),
    /** Null when no credential is attached — an unanswered line has no
     * validity to read. */
    validity: Type.Union([TenderChecklistValiditySchema, Type.Null()]),
    /** Whole days from the tender's closing date to the attached
     * version's expiry; negative when it has already lapsed by then. */
    expiresInDaysAtClose: Type.Union([Type.Integer(), Type.Null()]),
    /** True when this line stops the package going out: mandatory and
     * either unanswered or answered with something that will have
     * expired. The one derived flag the screen does not have to
     * re-derive, because the same rule decides the tender's own
     * submit-readiness. */
    blocking: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type TenderChecklistItem = Static<typeof TenderChecklistItemSchema>;

export const AddTenderChecklistItemRequestSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    mandatory: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type AddTenderChecklistItemRequest = Static<
  typeof AddTenderChecklistItemRequestSchema
>;

/** Attach a library credential to a checklist line, or `null` to detach.
 * One route, because attaching a different credential is the same act as
 * replacing the one that is there. */
export const AttachTenderChecklistDocumentRequestSchema = Type.Object(
  { companyDocumentId: Type.Union([UuidSchema, Type.Null()]) },
  { additionalProperties: false },
);
export type AttachTenderChecklistDocumentRequest = Static<
  typeof AttachTenderChecklistDocumentRequestSchema
>;

/* --- The status trail --------------------------------------------------- */

export const TenderStatusEventSchema = Type.Object(
  {
    id: UuidSchema,
    fromStatus: Type.Union([TenderStatusSchema, Type.Null()]),
    toStatus: TenderStatusSchema,
    note: Type.Union([Type.String(), Type.Null()]),
    actorUserId: Type.String(),
    occurredAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type TenderStatusEvent = Static<typeof TenderStatusEventSchema>;

export const UpdateTenderStatusRequestSchema = Type.Object(
  {
    status: TenderStatusSchema,
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    /** The acknowledgement iREPS printed, typed in by whoever uploaded.
     * Recorded, never verified — the portal has no API. */
    irepsReference: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);
export type UpdateTenderStatusRequest = Static<typeof UpdateTenderStatusRequestSchema>;

/** Records the LOA that awarded this tender. The award conversion is a
 * deep link into the ordinary LOA intake, so this is called by the upload
 * screen once the letter is stored — not a second way to create a Work. */
export const LinkTenderAwardLetterRequestSchema = Type.Object(
  { loaDocumentId: UuidSchema },
  { additionalProperties: false },
);
export type LinkTenderAwardLetterRequest = Static<
  typeof LinkTenderAwardLetterRequestSchema
>;

/* --- The tender itself -------------------------------------------------- */

export const TenderSummarySchema = Type.Object(
  {
    id: UuidSchema,
    tenderNumber: Type.String(),
    authority: Type.String(),
    title: Type.String(),
    /** The closing moment as the notice prints it, for display and for
     * the edit field. */
    bidClosesAtLocal: LocalDateTimeSchema,
    /** The same moment as an instant.
     *
     * Both are sent because they answer different questions and only one
     * of them can answer "has it closed". A tender closing at 15:00 is
     * open at 14:59 and shut at 15:01 on the SAME calendar day, so a
     * register that splits on the date alone calls it upcoming for nine
     * more hours after the bid could no longer be filed. The wall clock
     * is what a human reads; the instant is what a comparison uses. */
    bidClosesAt: Type.String({ format: 'date-time' }),
    /** Whole days from today to the closing date, in the organisation's
     * timezone; negative once it has passed. Computed in SQL against the
     * database's clock, so every reader of the organisation gets the same
     * number regardless of what their laptop thinks the date is.
     *
     * A COUNT for display, never the open/closed test — `0` means "closes
     * today", which is true either side of 15:00. */
    daysToClose: Type.Integer(),
    status: TenderStatusSchema,
    checklistTotal: Type.Integer({ minimum: 0 }),
    checklistBlocking: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type TenderSummary = Static<typeof TenderSummarySchema>;

export const TenderAwardSchema = Type.Object(
  {
    loaDocumentId: UuidSchema,
    loaFilename: Type.String(),
    /** The Work the letter became, once it has been confirmed. Null while
     * the letter is still in review — which is honest: the tender is
     * awarded, the Work is not yet created. */
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type TenderAward = Static<typeof TenderAwardSchema>;

export const TenderDetailSchema = Type.Composite(
  [
    TenderSummarySchema,
    Type.Object(
      {
        estimatedValue: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
        emdAmount: Type.Union([NonNegativeMoneyStringSchema, Type.Null()]),
        eligibilitySummary: Type.Union([Type.String(), Type.Null()]),
        irepsReference: Type.Union([Type.String(), Type.Null()]),
        /** The NIT this tender was confirmed from, when it came from one.
         * A tender recorded by hand has none. */
        noticeId: Type.Union([UuidSchema, Type.Null()]),
        noticeFilename: Type.Union([Type.String(), Type.Null()]),
        award: Type.Union([TenderAwardSchema, Type.Null()]),
        checklist: Type.Array(TenderChecklistItemSchema),
        statusEvents: Type.Array(TenderStatusEventSchema),
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type TenderDetail = Static<typeof TenderDetailSchema>;

export const TenderListResponseSchema = Type.Object(
  {
    tenders: Type.Array(TenderSummarySchema),
  },
  { additionalProperties: false },
);
export type TenderListResponse = Static<typeof TenderListResponseSchema>;
