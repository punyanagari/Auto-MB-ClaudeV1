import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema, withKeysetQuery } from './pagination.js';
import { DateOnlySchema, DecimalStringSchema, UuidSchema } from './primitives.js';

// --- Defect liability periods (migration 0099) ------------------------------
//
// A DLP is the warranty that runs on a recorded installation: it starts on
// the installation date, on the issue date of the PAC certificate that
// provisionally accepted the item, or on the date of the Work's final bill
// (migration 0112), and it ends N months later — where
// `dlp_expires_on` is THE LAST DAY THE LIABILITY STANDS, not the first day
// after it. The Performance Bank Guarantee the letter demands has to
// outlive it, and reporting that is what the module is for.
//
// The three STORED states are things a person did: the period is `active`,
// it was `closed` when it ran out with nothing outstanding, or it was
// `voided` because it should never have been started. Whether a live
// period is expiring soon or has already elapsed is a fact about today,
// computed on every read against the ORGANISATION's own calendar date —
// never stored, because a stored answer to a question about today is wrong
// by the next morning.

/**
 * What starts the clock, as the contract states it.
 *
 * `final_bill` (migration 0112) is the third shape, and its date is the
 * one the Work's final bill carries: `bills` has no date column, so the
 * legal date behind a bill is the `mb_date` of the finalized final
 * Measurement Book it was prepared from. The period is pinned to that
 * date exactly — the server refuses any other, and refuses the basis
 * outright while the Work has no final bill.
 */
export const WarrantyStartBasisSchema = Type.Union([
  Type.Literal('installation'),
  Type.Literal('pac'),
  Type.Literal('final_bill'),
]);
export type WarrantyStartBasis = Static<typeof WarrantyStartBasisSchema>;

const WarrantyStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('closed'),
  Type.Literal('voided'),
]);

/**
 * The reading a screen renders, which is the stored status with the two
 * date-derived splits of `active` folded in.
 *
 * `expiring` is a live period inside the shared 60-day warning window;
 * `elapsed` is one whose last covered day has passed and which nobody has
 * closed yet. Both are things TO DO — chase the no-defect certificate, ask
 * for the guarantee back — which is why neither is in the destructive
 * family (`docs/DESIGN.md` § Status badge semantics).
 */
export const WarrantyStandingSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('expiring'),
  Type.Literal('elapsed'),
  Type.Literal('closed'),
  Type.Literal('voided'),
]);
export type WarrantyStanding = Static<typeof WarrantyStandingSchema>;

/** The Work's contract term. One row per Work; correcting it never
 * reaches a period that has already begun, because each period freezes
 * the months and the basis it was started under. */
export const WarrantyTermsSchema = Type.Object(
  {
    dlpMonths: Type.Integer({ minimum: 1, maximum: 120 }),
    startBasis: WarrantyStartBasisSchema,
    notes: Type.Union([Type.String(), Type.Null()]),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type WarrantyTerms = Static<typeof WarrantyTermsSchema>;

export const SaveWarrantyTermsRequestSchema = Type.Object(
  {
    dlpMonths: Type.Integer({ minimum: 1, maximum: 120 }),
    startBasis: WarrantyStartBasisSchema,
    notes: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type SaveWarrantyTermsRequest = Static<typeof SaveWarrantyTermsRequestSchema>;

/** Starting the clock on one installation.
 *
 * The basis is NOT a parameter: it is the Work's term, and a period
 * started on a basis the contract does not state would be a warranty the
 * agency invented. What the caller supplies is the certificate, and only
 * where the term says the clock starts at provisional acceptance. */
export const StartWarrantyRequestSchema = Type.Object(
  { pacCertificateId: Type.Optional(UuidSchema) },
  { additionalProperties: false },
);
export type StartWarrantyRequest = Static<typeof StartWarrantyRequestSchema>;

/** A defect rectified inside the period extends it for the units that
 * were repaired. Forward only, and never past ten years from the start —
 * the ceiling the database holds as well. */
export const ExtendWarrantyRequestSchema = Type.Object(
  {
    expiresOn: DateOnlySchema,
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type ExtendWarrantyRequest = Static<typeof ExtendWarrantyRequestSchema>;

/** The period ran out and nothing is outstanding. Refused before the
 * expiry and refused in the future: a closure that could precede the
 * expiry would be the product asserting a discharge that had not
 * happened. */
export const CloseWarrantyRequestSchema = Type.Object(
  {
    closedOn: DateOnlySchema,
    note: Type.String({ minLength: 3, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type CloseWarrantyRequest = Static<typeof CloseWarrantyRequestSchema>;

/** The period should never have been started — a wrong installation, a
 * wrong certificate, a mistyped extension. Voiding is the only way out of
 * a live period, and it is what releases the installation to be cancelled. */
export const VoidWarrantyRequestSchema = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false },
);
export type VoidWarrantyRequest = Static<typeof VoidWarrantyRequestSchema>;

/** One defect liability period, carrying enough of its installation that
 * neither surface has to fetch the record behind it. The same shape on
 * the Work's card and in the tenant-wide register, so a row that moves
 * between them cannot mean two things. */
export const WarrantySchema = Type.Object(
  {
    id: UuidSchema,
    workId: UuidSchema,
    workCode: Type.String(),
    workTitle: Type.String(),
    installationId: UuidSchema,
    itemNumber: Type.String(),
    quantity: DecimalStringSchema,
    installedOn: DateOnlySchema,
    locationName: Type.String(),
    dlpMonths: Type.Integer({ minimum: 1, maximum: 120 }),
    startBasis: WarrantyStartBasisSchema,
    /** The certificate the clock was started from, where the basis is
     * provisional acceptance. Provenance: cancelling the certificate
     * afterwards does not move an expiry the railway is holding a
     * guarantee against, so the reference stays what it was. */
    pacReference: Type.Union([Type.String(), Type.Null()]),
    dlpStartOn: DateOnlySchema,
    /** What the period began with, beside what it now runs to. Equal
     * unless the period has been extended. */
    originalExpiresOn: DateOnlySchema,
    dlpExpiresOn: DateOnlySchema,
    status: WarrantyStatusSchema,
    /** The stored status with the date-derived splits folded in; see
     * `WarrantyStandingSchema`. */
    standing: WarrantyStandingSchema,
    /** Days from the organisation's own today to the last covered day.
     * Negative once the period has elapsed. Null on a period that is no
     * longer running, where the countdown means nothing. */
    daysToExpiry: Type.Union([Type.Integer(), Type.Null()]),
    closedOn: Type.Union([DateOnlySchema, Type.Null()]),
    closureNote: Type.Union([Type.String(), Type.Null()]),
    voidNote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type Warranty = Static<typeof WarrantySchema>;

/** A PAC certificate a period may be started from: recorded, of this
 * Work, and certifying the installation's own item. */
const WarrantyPacOptionSchema = Type.Object(
  {
    id: UuidSchema,
    reference: Type.String(),
    issueDate: DateOnlySchema,
  },
  { additionalProperties: false },
);

/** A recorded installation with no live period on it — what the Work's
 * card offers to start the clock on. */
export const WarrantyCandidateSchema = Type.Object(
  {
    installationId: UuidSchema,
    itemNumber: Type.String(),
    quantity: DecimalStringSchema,
    installedOn: DateOnlySchema,
    locationName: Type.String(),
    /** Empty on the installation basis, where the clock starts from the
     * installation's own date and no certificate is involved. */
    pacOptions: Type.Array(WarrantyPacOptionSchema),
  },
  { additionalProperties: false },
);
export type WarrantyCandidate = Static<typeof WarrantyCandidateSchema>;

/**
 * Whether the Performance Bank Guarantee outlives the warranty it secures.
 *
 * Derived on every read and stored nowhere. `dlpCoverUntil` is the latest
 * last-covered-day over the Work's periods that were not voided;
 * `instrumentExpiresOn` is the expiry of the live `pbg` instrument the
 * Work holds. `shortfallDays` is how many days of DLP the guarantee does
 * NOT reach, and it is null wherever the question has no answer — no
 * periods, no guarantee, or a guarantee recorded with no expiry date.
 */
export const WarrantyPbgCoverSchema = Type.Object(
  {
    /** True when the LOA letter itself demands a guarantee (migration
     * 0016). A Work whose letter demands none and which holds none is not
     * short of anything. */
    requiredByLetter: Type.Boolean(),
    dlpCoverUntil: Type.Union([DateOnlySchema, Type.Null()]),
    /** The LIVE guarantee reaching furthest out — a released, expired or
     * closed instrument is not cover anybody holds, and one recorded with
     * no expiry date cannot be compared against a period at all. Null
     * where no instrument answers that description. */
    instrumentReference: Type.Union([Type.String(), Type.Null()]),
    instrumentExpiresOn: Type.Union([DateOnlySchema, Type.Null()]),
    shortfallDays: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type WarrantyPbgCover = Static<typeof WarrantyPbgCoverSchema>;

/** The Work's warranty card: its term, its guarantee cover, the
 * installations still waiting for a period, and the periods themselves.
 *
 * `warranties` is keyset-paged; `candidates` is capped and flagged rather
 * than paged, because it is a picker and a picker cannot page — the same
 * posture `GET /api/correspondence/thread-options` records. */
export const WorkWarrantyResponseSchema = Type.Object(
  {
    terms: Type.Union([WarrantyTermsSchema, Type.Null()]),
    pbgCover: WarrantyPbgCoverSchema,
    /** The date every period on the `final_bill` basis starts on, or null
     * where the Work has no final bill yet — which is what the card needs
     * to say "not until that bill exists" BEFORE the operator presses a
     * button the server would refuse. Read from the same
     * `app_private.work_final_bill_date` the route writes with and the
     * guard enforces with, so the screen cannot promise a different day
     * from the one the period will carry. Null on the other two bases
     * too: it is not the date they start from and showing it would
     * invite the reader to think it was. */
    finalBillDate: Type.Union([DateOnlySchema, Type.Null()]),
    candidates: Type.Array(WarrantyCandidateSchema),
    /** True when more installations are waiting than the cap returns.
     * Start a period on the ones offered and the next ones appear. */
    candidatesTruncated: Type.Boolean(),
    warranties: Type.Array(WarrantySchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type WorkWarrantyResponse = Static<typeof WorkWarrantyResponseSchema>;

/** The register's query.
 *
 * `standing` narrows to one reading, computed against the organisation's
 * own today rather than sent by the caller. `expiresBefore` is the other
 * question the office asks — "what is out of warranty by the end of the
 * quarter" — and both are optional. */
export const WarrantyRegisterQuerySchema = withKeysetQuery(
  Type.Object(
    {
      standing: Type.Optional(WarrantyStandingSchema),
      expiresBefore: Type.Optional(DateOnlySchema),
    },
    { additionalProperties: false },
  ),
);

/** Every defect liability period in the organisation the caller may see,
 * soonest expiry first — which is the order the question is asked in.
 * Voided periods stay listed under their own reading: the register
 * reports what was recorded, not only what still stands. */
export const WarrantyRegisterResponseSchema = Type.Object(
  {
    warranties: Type.Array(WarrantySchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type WarrantyRegisterResponse = Static<typeof WarrantyRegisterResponseSchema>;
