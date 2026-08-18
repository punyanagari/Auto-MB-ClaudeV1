import { Type, type Static } from '@sinclair/typebox';
import {
  DateOnlySchema,
  DecimalStringSchema,
  RoundOffStringSchema,
  UuidSchema,
  nonBlankString,
} from './primitives.js';
import { InvoiceNumberPrefixSchema } from './organisations.js';
import { IrnSchema, IrpProviderStateSchema } from './tax-documents.js';

/**
 * The CGST Section 34 credit note (migration 0051): the lawful
 * instrument for a wrong invoice whose IRN can no longer be cancelled —
 * NIC's cancellation window is 24 hours from acknowledgement.
 *
 * The shape settled with the owner: FULL VALUE against exactly one
 * submitted tax invoice (the money columns are copies of the invoice's
 * frozen ones, database-enforced), and ISSUING it supersedes the
 * invoice — a terminal state alongside cancelled that releases the
 * invoice's Measurement Book for a corrected invoice. The credit note
 * is an IRN document of its own (DocTyp CRN, same INV-01 schema,
 * POSITIVE values by NIC convention), numbered gapless per organisation
 * per financial year under its own counter, with the invoice's exact
 * provider-evidence posture, its own 24-hour cancellation window and
 * the same frozen 30-day reporting deadline (finding 20 / migration
 * 0049).
 *
 * Draft -> issued (numbered, money copied, snapshot frozen, the invoice
 * superseded in the same transaction) -> cancelled (only while its IRP
 * state is not_requested/cancelled AND the invoice's MB has not been
 * re-invoiced; the invoice reverts to submitted in the same
 * transaction).
 */

const CREDIT_NOTE_STATUSES = ['draft', 'issued', 'cancelled'] as const;
const CreditNoteStatusSchema = Type.Union(
  CREDIT_NOTE_STATUSES.map((status) => Type.Literal(status)),
);
export type CreditNoteStatus = Static<typeof CreditNoteStatusSchema>;

/** Section 34(2) as amended (effective October 2025): the supplier's
 * tax reduction is conditional on the recipient reversing ITC.
 * Recordable evidence, never enforced. */
const RECIPIENT_ITC_STATUSES = [
  'not_applicable',
  'reversal_confirmed',
  'pending',
] as const;
const RecipientItcStatusSchema = Type.Union(
  RECIPIENT_ITC_STATUSES.map((status) => Type.Literal(status)),
);
export type RecipientItcStatus = Static<typeof RecipientItcStatusSchema>;

/** POST /api/tax-invoices/:id/credit-notes — drafts the note against a
 * SUBMITTED invoice. Any submitted invoice qualifies; past the IRN
 * cancellation window the credit note is the ONLY remedy. */
export const CreateCreditNoteRequestSchema = Type.Object(
  {
    noteDate: DateOnlySchema,
    /** Why the note is issued — Section 34 requires the reason on the
     * face of the document. */
    reason: nonBlankString({ minLength: 3, maxLength: 2000 }),
    /** Overrides the invoice's own number prefix for the note's number;
     * omitted means the note follows the invoice's prefix. */
    numberPrefix: Type.Optional(InvoiceNumberPrefixSchema),
  },
  { additionalProperties: false },
);
export type CreateCreditNoteRequest = Static<typeof CreateCreditNoteRequestSchema>;

/** PUT /api/credit-notes/:id — edits the draft. The invoice is the
 * note's SUBJECT, not a field: re-pointing is delete-and-redraft. */
export type UpdateCreditNoteRequest = CreateCreditNoteRequest;

/** POST /api/credit-notes/:id/cancel. */
export const CancelCreditNoteRequestSchema = Type.Object(
  { note: nonBlankString({ minLength: 3, maxLength: 2000 }) },
  { additionalProperties: false },
);
export type CancelCreditNoteRequest = Static<typeof CancelCreditNoteRequestSchema>;

/** PUT /api/credit-notes/:id/recipient-itc — records (never enforces)
 * the Section 34(2) recipient-ITC fact on an issued note. */
export const UpdateRecipientItcRequestSchema = Type.Object(
  { recipientItcStatus: RecipientItcStatusSchema },
  { additionalProperties: false },
);
export type UpdateRecipientItcRequest = Static<typeof UpdateRecipientItcRequestSchema>;

// --- Read model ---------------------------------------------------------------

const CreditNoteSchema = Type.Object(
  {
    id: UuidSchema,
    taxInvoiceId: UuidSchema,
    /** The superseded invoice's number/date, for the register and the
     * face of the document. */
    invoiceNumber: Type.Union([Type.String(), Type.Null()]),
    invoiceDate: Type.Union([DateOnlySchema, Type.Null()]),
    /** Null for a note against a direct (MB-less) invoice. */
    workId: Type.Union([UuidSchema, Type.Null()]),
    status: CreditNoteStatusSchema,
    noteNumber: Type.Union([Type.String(), Type.Null()]),
    sequenceNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    fyLabel: Type.Union([Type.String(), Type.Null()]),
    noteDate: DateOnlySchema,
    reason: Type.String(),
    numberPrefix: Type.Union([Type.String(), Type.Null()]),
    /** Copies of the superseded invoice's frozen money, written at
     * issue and database-proven equal; all null while draft. */
    taxableValue: Type.Union([DecimalStringSchema, Type.Null()]),
    cgstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    sgstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    igstAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    roundOff: Type.Union([RoundOffStringSchema, Type.Null()]),
    totalAmount: Type.Union([DecimalStringSchema, Type.Null()]),
    recipientItcStatus: RecipientItcStatusSchema,
    irn: Type.Union([IrnSchema, Type.Null()]),
    irpProvider: Type.Union([
      Type.Literal('manual'),
      Type.Literal('whitebooks'),
      Type.Null(),
    ]),
    irpProviderState: IrpProviderStateSchema,
    ackNumber: Type.Union([Type.String(), Type.Null()]),
    ackDate: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    ackDateText: Type.Union([Type.String(), Type.Null()]),
    signedInvoiceAvailable: Type.Boolean(),
    renderedAvailable: Type.Boolean(),
    irpLegacyEvidenceMissing: Type.Boolean(),
    irpCancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    irpCancelledAtText: Type.Union([Type.String(), Type.Null()]),
    irpCancelReasonCode: Type.Union([Type.String(), Type.Null()]),
    irpCancelRemark: Type.Union([Type.String(), Type.Null()]),
    /** Frozen at issue from the organisation's e-invoicing declaration
     * then in force (0049): note_date + window days, or null when no
     * window applied. */
    irpReportingDeadline: Type.Union([DateOnlySchema, Type.Null()]),
    /** Derived: the frozen deadline has passed and the note is still
     * not registered at the IRP. */
    irpReportingOverdue: Type.Boolean(),
    /** The note's own 24-hour IRN cancellation window: ack_date + 24
     * hours, null until registered. */
    irpCancelWindowClosesAt: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),
    irpCancelWindowOpen: Type.Boolean(),
    cancellationNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    issuedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type CreditNote = Static<typeof CreditNoteSchema>;

export const CreditNoteDetailResponseSchema = Type.Object(
  {
    creditNote: CreditNoteSchema,
    /** The whole document as issued — parties and money copied from the
     * invoice's frozen snapshot, the reason, and the reference to the
     * superseded invoice. Null while draft. */
    issuedSnapshot: Type.Unknown(),
    signedQr: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type CreditNoteDetailResponse = Static<typeof CreditNoteDetailResponseSchema>;

export const CreditNoteListResponseSchema = Type.Object(
  { creditNotes: Type.Array(CreditNoteSchema) },
  { additionalProperties: false },
);
export type CreditNoteListResponse = Static<typeof CreditNoteListResponseSchema>;
