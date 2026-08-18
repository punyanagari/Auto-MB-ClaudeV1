import { Type, type Static } from '@sinclair/typebox';
import { KeysetQuerySchema, NextCursorSchema } from './pagination.js';
import { DateOnlySchema, UuidSchema, nonBlankString } from './primitives.js';

// --- The correspondence register (migration 0086) ---------------------------
//
// The inward/outward letters a works contract is actually executed on:
// submission of approved makes, a clarification the railway asked for, the
// reply to it, an invitation to re-quote.
//
// THREE SOURCES, ONE ROW SHAPE. The register's four tabs read three
// different tables, and this is the whole integration decision of the
// module:
//
//   outward, inward  ->  correspondence_letters (0086), this module's own
//   extensions       ->  extension_requests (0011, 0029), READ ONLY here
//   inspection       ->  inspection_calls (0082), READ ONLY here
//
// The extension-of-time letter and the inspection call letter already have
// registers that number them, render them, store the replies and move the
// Work when the reply lands. Copying them into a letters table would give
// each letter two homes that can disagree. So the correspondence screen
// projects them into the shape below and links back; it never writes them.
// `CorrespondenceEntry.source` is what says which table a row came from,
// and it is what the screen uses to decide where a row leads.

export const CORRESPONDENCE_TABS = [
  'outward',
  'inward',
  'extensions',
  'inspection',
] as const;
export const CorrespondenceTabSchema = Type.Union(
  CORRESPONDENCE_TABS.map((tab) => Type.Literal(tab)),
);
export type CorrespondenceTab = Static<typeof CorrespondenceTabSchema>;

/** Which register a row was read from. Not a synonym for the tab: the
 * `outward` and `inward` tabs both read `letter`, and `extension` and
 * `inspection` each produce up to TWO entries from one record — the
 * request or call that went out, and the answer that came back — which
 * is why a row is keyed on `(id, direction)` rather than on `id`.
 *
 * It is also what decides whether the register's number cell is a link:
 * only a `letter` has a document this module's own route can serve. The
 * other two are reached through the module that owns them. */
export const CORRESPONDENCE_SOURCES = ['letter', 'extension', 'inspection'] as const;
export const CorrespondenceSourceSchema = Type.Union(
  CORRESPONDENCE_SOURCES.map((source) => Type.Literal(source)),
);
export type CorrespondenceSource = Static<typeof CorrespondenceSourceSchema>;

export const CorrespondenceDirectionSchema = Type.Union([
  Type.Literal('outward'),
  Type.Literal('inward'),
]);
export type CorrespondenceDirection = Static<typeof CorrespondenceDirectionSchema>;

/**
 * How a row reads on the register, in the design contract's own status
 * vocabulary.
 *
 * DERIVED on every read and never stored — the same posture the company
 * document library takes with expiry (0079), and for the same reason: a
 * stored answer to a question about the present is wrong the moment
 * something else changes. `replied` in particular is a fact about whether
 * a LATER letter cites this one, which no column on this row can know.
 *
 *   sent      an outward letter that went out, awaiting nothing recorded
 *   received  an inward letter on file, not yet answered
 *   replied   a letter, either direction, that a later letter answers
 *   approved  an extension request the railway accepted or modified
 *   rejected  an extension request the railway refused
 *   draft     an extension request not yet finalised (the only draft the
 *             register can show; letters here have no draft state)
 *   cancelled a cancelled letter, or a withdrawn inspection call
 */
export const CORRESPONDENCE_STATUSES = [
  'draft',
  'sent',
  'received',
  'replied',
  'approved',
  'rejected',
  'cancelled',
] as const;
export const CorrespondenceStatusSchema = Type.Union(
  CORRESPONDENCE_STATUSES.map((status) => Type.Literal(status)),
);
export type CorrespondenceStatus = Static<typeof CorrespondenceStatusSchema>;

export const CorrespondenceEntrySchema = Type.Object(
  {
    id: UuidSchema,
    source: CorrespondenceSourceSchema,
    direction: CorrespondenceDirectionSchema,
    /** `OUT/26-27/047`, `IN/26-27/022`, `PL-281-Extension-01`,
     * `INS/PL-281/1`, or the agency's own number on an inward call
     * letter. Each series belongs to whichever register minted it. */
    number: Type.String(),
    date: DateOnlySchema,
    counterparty: Type.String(),
    subject: Type.String(),
    workId: Type.Union([UuidSchema, Type.Null()]),
    workCode: Type.Union([Type.String(), Type.Null()]),
    /** The counterparty's own reference where there is one, or the number
     * of the letter this one answers. Null renders as "No reference". */
    reference: Type.Union([Type.String(), Type.Null()]),
    status: CorrespondenceStatusSchema,
    /** Extensions tab: the completion date asked for, or granted once the
     * railway has answered. */
    extensionUntil: Type.Union([DateOnlySchema, Type.Null()]),
    /** Inward tab: when a reply is owed, as the register captured it.
     * Rendered as the Inward tab's own conditional column, the way the
     * Extensions tab renders `extensionUntil` — the banner above the tabs
     * promises due-date tracking, and a due date the register stores and
     * never shows is a promise it does not keep. */
    replyDueOn: Type.Union([DateOnlySchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type CorrespondenceEntry = Static<typeof CorrespondenceEntrySchema>;

/** The four tab counts, always all four: the register draws every count
 * on every tab, so one request answers the whole header. */
export const CorrespondenceCountsSchema = Type.Object(
  {
    outward: Type.Integer({ minimum: 0 }),
    inward: Type.Integer({ minimum: 0 }),
    extensions: Type.Integer({ minimum: 0 }),
    inspection: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CorrespondenceCounts = Static<typeof CorrespondenceCountsSchema>;

export const CorrespondenceListQuerySchema = Type.Composite(
  [Type.Object({ tab: Type.Optional(CorrespondenceTabSchema) }), KeysetQuerySchema],
  { additionalProperties: false },
);
export type CorrespondenceListQuery = Static<typeof CorrespondenceListQuerySchema>;

export const CorrespondenceListResponseSchema = Type.Object(
  {
    entries: Type.Array(CorrespondenceEntrySchema),
    nextCursor: NextCursorSchema,
    counts: CorrespondenceCountsSchema,
    /**
     * Extension requests this product sent and the railway has not
     * answered: `status = 'finalised'` AND `source <> 'manual'`.
     *
     * The manual exclusion is the definition worth stating. A manual
     * back-fill (migration 0029) is a paper letter transcribed into the
     * register long after it was posted, often years of correspondence
     * entered in one sitting; it is finalised on arrival because it
     * already went out. Counting those would light an amber banner
     * saying "chase these" over letters nobody can chase and whose
     * answers, where they came, were never going to be recorded here.
     * The banner is a prompt, so it counts only what the product itself
     * sent and can still be told the answer to.
     */
    awaitingExtensionResponses: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CorrespondenceListResponse = Static<
  typeof CorrespondenceListResponseSchema
>;

const SubjectSchema = nonBlankString({ minLength: 2, maxLength: 200 });

/** Writing and dispatching an outward letter is one act. There is no
 * draft: 0086 records why. */
export const WriteOutwardLetterRequestSchema = Type.Object(
  {
    letterDate: DateOnlySchema,
    /** The contact the letter is addressed to. The server snapshots its
     * designation; the id itself is not stored. */
    contactId: UuidSchema,
    workId: Type.Optional(UuidSchema),
    replyToLetterId: Type.Optional(UuidSchema),
    subject: SubjectSchema,
    body: nonBlankString({ minLength: 2, maxLength: 20000 }),
  },
  { additionalProperties: false },
);
export type WriteOutwardLetterRequest = Static<typeof WriteOutwardLetterRequestSchema>;

/** The metadata of an inward registration, carried in the querystring
 * because the body is the scan itself — the same shape
 * `POST /api/company-documents` and the contract-source upload use. */
export const RegisterInwardLetterQuerySchema = Type.Object(
  {
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    receivedOn: DateOnlySchema,
    contactId: UuidSchema,
    workId: Type.Optional(UuidSchema),
    senderReference: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    senderLetterDate: Type.Optional(DateOnlySchema),
    subject: SubjectSchema,
    replyToLetterId: Type.Optional(UuidSchema),
    responseDueOn: Type.Optional(DateOnlySchema),
  },
  { additionalProperties: false },
);
export type RegisterInwardLetterQuery = Static<typeof RegisterInwardLetterQuerySchema>;

export const CancelCorrespondenceLetterRequestSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type CancelCorrespondenceLetterRequest = Static<
  typeof CancelCorrespondenceLetterRequestSchema
>;

/** One letter, as the composer's "reply to" picker lists them: enough to
 * recognise a letter, nothing more. */
export const CorrespondenceThreadOptionSchema = Type.Object(
  {
    id: UuidSchema,
    number: Type.String(),
    subject: Type.String(),
  },
  { additionalProperties: false },
);
export type CorrespondenceThreadOption = Static<
  typeof CorrespondenceThreadOptionSchema
>;

export const CorrespondenceThreadOptionsResponseSchema = Type.Object(
  { letters: Type.Array(CorrespondenceThreadOptionSchema) },
  { additionalProperties: false },
);
export type CorrespondenceThreadOptionsResponse = Static<
  typeof CorrespondenceThreadOptionsResponseSchema
>;
