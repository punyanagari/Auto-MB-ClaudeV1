import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import { PdfSignatureReportSchema } from './pdf-signature.js';
import { UuidSchema, nonBlankString } from './primitives.js';

// --- The signing queue (migration 0091) -------------------------------------
//
// ADR-0012's workflow: an issued document, a request to put the
// organisation's own Class 3 certificate on it, and the kiosk that does
// so. Two lanes were ruled; the kiosk-DSC lane is built and the Aadhaar
// eSign lane is gated on ESP onboarding, which is why `channel` exists on
// the wire from the first row and only one of its values is reachable.
//
// THE MOCK DRAWS NO SIGNING SCREEN. The queue below is
// application-first under AGENTS.md § Design contract 2 and 4, built in
// the mock's existing grammar — its page header, its data table, its
// status chip, its confirm dialog — with no new visual language.
// `docs/UX.md` § 16 records the stance and the reasoning rather than
// inventing a mock citation for a screen that does not exist there.
//
// TWO AUDIENCES, ONE MODEL. Everything up to `SigningRequest` is what a
// member sees in a browser. Everything from `SigningJob` down is what the
// kiosk agent sees over its bearer-token channel, and it is deliberately
// the smaller half: the agent is told which document, what its hash is
// and which digest to sign, and nothing else. It never receives document
// bytes, member identities beyond the requester's name, or any other
// request in the queue.

/* --- Vocabulary ----------------------------------------------------------- */

// Three outward registers, and the third is migration 0110's. The Issue
// Challan is material leaving the agency's custody under the agency's own
// name; it renders a PDF like its siblings, and it is signed by exactly
// the machinery they are, because an operator should not have to learn a
// second story for the sibling document.
const SIGNING_DOCUMENT_TYPES = [
  'delivery_challan',
  'issue_challan',
  'tax_invoice',
] as const;
const SigningDocumentTypeSchema = Type.Union(
  SIGNING_DOCUMENT_TYPES.map((value) => Type.Literal(value)),
  { description: 'Which issued register the document being signed belongs to.' },
);
export type SigningDocumentType = Static<typeof SigningDocumentTypeSchema>;

/** ADR-0012's two lanes. `esign` is modelled and not reachable: no route
 * writes it, because the ESP onboarding it depends on has not landed. */
const SIGNING_CHANNELS = ['kiosk_dsc', 'esign'] as const;
const SigningChannelSchema = Type.Union(
  SIGNING_CHANNELS.map((value) => Type.Literal(value)),
  { description: 'How the signature is fulfilled (ADR-0012).' },
);

const SIGNING_REQUEST_STATUSES = [
  'pending',
  'claimed',
  'signed',
  'failed',
  'cancelled',
] as const;
const SigningRequestStatusSchema = Type.Union(
  SIGNING_REQUEST_STATUSES.map((value) => Type.Literal(value)),
  { description: 'Where a signing request has got to.' },
);
export type SigningRequestStatus = Static<typeof SigningRequestStatusSchema>;

/** The Windows thumbprint: SHA-1 of the certificate DER, uppercase hex.
 * The one identifier the agent selects a key by, and the one an operator
 * can compare against their own certificate store. */
const CertificateThumbprintSchema = Type.String({
  pattern: '^[0-9A-F]{40}$',
  description:
    'SHA-1 of the certificate DER, uppercase hex — the Windows certificate thumbprint.',
});

const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' });
const NullableSha256Schema = Type.Union([Sha256Schema, Type.Null()]);
const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const TimestampSchema = Type.String({ format: 'date-time' });
const NullableTimestampSchema = Type.Union([TimestampSchema, Type.Null()]);
const NullableThumbprintSchema = Type.Union([CertificateThumbprintSchema, Type.Null()]);

/* --- The register a member sees ------------------------------------------- */

const SigningRequestSchema = Type.Object(
  {
    id: UuidSchema,
    documentType: SigningDocumentTypeSchema,
    documentId: UuidSchema,
    /** `DC/2026/0042`, the number on the document itself. What an
     * operator recognises; the uuid is what the API addresses. */
    documentNumber: NullableStringSchema,
    workCode: NullableStringSchema,
    channel: SigningChannelSchema,
    status: SigningRequestStatusSchema,
    /** The SHA-256 of the exact bytes this request authorises. Shown, not
     * hidden: ADR-0012 requires the person approving a signature to see
     * the hash of what they are approving, and a hash nobody is shown is
     * a hash nobody can compare. */
    sourceSha256: Sha256Schema,
    signedSha256: NullableSha256Schema,
    certificateThumbprint: NullableThumbprintSchema,
    signerName: Type.String(),
    signingReason: Type.String(),
    signingLocation: Type.String(),
    requestedByUserId: Type.String(),
    requestedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    claimedAt: NullableTimestampSchema,
    completedAt: NullableTimestampSchema,
    /** The 0060 verifier's own words about the finished document. The
     * server refuses to store bytes whose verdict is anything but
     * `signed_and_intact`, so on a signed row this is a receipt rather
     * than a warning — and it is carried anyway, in the same shape every
     * other verdict in the product uses. */
    signatureVerdict: Type.Union([PdfSignatureReportSchema, Type.Null()]),
    failureReason: NullableStringSchema,
  },
  { additionalProperties: false },
);
export type SigningRequest = Static<typeof SigningRequestSchema>;

const SigningAgentSchema = Type.Object(
  {
    id: UuidSchema,
    label: Type.String(),
    certificateThumbprint: CertificateThumbprintSchema,
    certificateSubject: Type.String(),
    certificateNotAfter: TimestampSchema,
    operatorUserId: Type.String(),
    createdAt: TimestampSchema,
    lastSeenAt: NullableTimestampSchema,
    revokedAt: NullableTimestampSchema,
  },
  { additionalProperties: false },
);
export type SigningAgent = Static<typeof SigningAgentSchema>;

export const SigningQueueResponseSchema = Type.Object(
  {
    requests: Type.Array(SigningRequestSchema),
    nextCursor: NextCursorSchema,
    /** The kiosks registered for this organisation, so the screen can
     * say "no kiosk is registered" instead of leaving a queue that will
     * never move looking healthy. Not paginated and not a separate
     * endpoint: an organisation has as many of these as it has token
     * machines, which is one. */
    agents: Type.Array(SigningAgentSchema),
  },
  { additionalProperties: false },
);
export type SigningQueueResponse = Static<typeof SigningQueueResponseSchema>;

export const SigningQueueQuerySchema = Type.Object(
  { status: Type.Optional(SigningRequestStatusSchema) },
  { additionalProperties: false },
);

export const CreateSigningRequestSchema = Type.Object(
  {
    documentType: SigningDocumentTypeSchema,
    documentId: UuidSchema,
    /** Optional overrides for the signature dictionary's own entries.
     * Defaulted from the organisation profile when omitted, because the
     * common case is that every document is signed the same way and a
     * required field there is a field somebody types wrong. */
    // The bounds are migration 0091's, which are in turn the bounds of
    // the columns these default from. Narrower ones here would turn a
    // long-but-legitimate company name into a 500 at insert; truncating
    // was refused because these strings go inside the signed bytes.
    signerName: Type.Optional(nonBlankString({ minLength: 2, maxLength: 200 })),
    signingReason: Type.Optional(nonBlankString({ minLength: 2, maxLength: 200 })),
    signingLocation: Type.Optional(nonBlankString({ minLength: 2, maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export type CreateSigningRequest = Static<typeof CreateSigningRequestSchema>;

export const SigningRequestResponseSchema = Type.Object(
  { request: SigningRequestSchema },
  { additionalProperties: false },
);
export type SigningRequestResponse = Static<typeof SigningRequestResponseSchema>;

export const CancelSigningRequestSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type CancelSigningRequest = Static<typeof CancelSigningRequestSchema>;

/* --- Registering a kiosk -------------------------------------------------- */

export const RegisterSigningAgentSchema = Type.Object(
  {
    label: nonBlankString({ minLength: 2, maxLength: 120 }),
    /** The signer certificate first, then every issuer up to the root,
     * PEM concatenated. Produced by the kiosk tool's `--export-chain`
     * step from the Windows certificate store, so the owner pastes what
     * their own machine says rather than retyping a thumbprint. */
    certificateChainPem: Type.String({ minLength: 64, maxLength: 65_536 }),
    /** The thumbprint the owner expects. Checked against the leaf of the
     * pasted chain and refused on mismatch: pasting the wrong file is
     * the mistake this catches, and it is the one mistake that would
     * otherwise pin the kiosk to a certificate nobody chose. */
    certificateThumbprint: CertificateThumbprintSchema,
  },
  { additionalProperties: false },
);
export type RegisterSigningAgent = Static<typeof RegisterSigningAgentSchema>;

export const RegisterSigningAgentResponseSchema = Type.Object(
  {
    agent: SigningAgentSchema,
    /** Returned exactly once. Only its SHA-256 is stored, so this value
     * is unrecoverable the moment the response is closed — losing it
     * means registering a new agent. */
    token: Type.String(),
  },
  { additionalProperties: false },
);
export type RegisterSigningAgentResponse = Static<
  typeof RegisterSigningAgentResponseSchema
>;

export const SigningAgentResponseSchema = Type.Object(
  { agent: SigningAgentSchema },
  { additionalProperties: false },
);
export type SigningAgentResponse = Static<typeof SigningAgentResponseSchema>;

/* --- What the kiosk agent sees -------------------------------------------- */

/**
 * One unit of work for the kiosk, and the whole of what crosses to it.
 *
 * ADR-0012 § "The approval is the authority" requires the person
 * approving to see the document name, its class, who asked, and the
 * document's SHA-256 before the signature happens. In this lane the
 * approver is the person at the kiosk typing the PIN, so those four facts
 * are exactly what the agent prints to its console before it calls the
 * token.
 *
 * `digest` is the only thing the token receives. The agent cannot
 * reconstruct the document from it, and the server cannot be made to
 * accept a signature over anything else, because it re-derives this value
 * from the stored bytes before it will assemble anything.
 */
const SigningJobSchema = Type.Object(
  {
    requestId: UuidSchema,
    documentType: SigningDocumentTypeSchema,
    documentNumber: NullableStringSchema,
    sourceSha256: Sha256Schema,
    requestedByUserId: Type.String(),
    requestedAt: TimestampSchema,
    /** Base64 of the 32 bytes to sign: `sha256(CMS signedAttrs)`. */
    digest: Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' }),
    /** Echoed so the agent can refuse before it opens a PIN dialog if the
     * server is pointing it at a certificate it does not hold. */
    certificateThumbprint: CertificateThumbprintSchema,
  },
  { additionalProperties: false },
);
export const ClaimSigningJobResponseSchema = Type.Object(
  { job: Type.Union([SigningJobSchema, Type.Null()]) },
  { additionalProperties: false },
);
export type ClaimSigningJobResponse = Static<typeof ClaimSigningJobResponseSchema>;

/**
 * The agent's answer: a signature, or the reason there is not one.
 *
 * One endpoint for both because they are one state transition. A kiosk
 * whose operator cancelled the PIN dialog, or whose token was unplugged,
 * has to be able to say so — otherwise the request sits `claimed` until
 * it expires and the queue lies about why nothing is happening.
 */
export const SubmitSignatureSchema = Type.Union([
  Type.Object(
    {
      /** Base64 of the raw RSA PKCS#1 v1.5 signature. 256 octets for the
       * RSA 2048 keys Class 3 tokens carry; the bound is generous rather
       * than exact so a 3072-bit token is a future decision and not a
       * schema change. */
      signature: Type.String({ minLength: 88, maxLength: 1400 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { failureReason: nonBlankString({ minLength: 3, maxLength: 500 }) },
    { additionalProperties: false },
  ),
]);

export const SubmitSignatureResponseSchema = Type.Object(
  {
    status: SigningRequestStatusSchema,
    signedSha256: NullableSha256Schema,
  },
  { additionalProperties: false },
);
export type SubmitSignatureResponse = Static<typeof SubmitSignatureResponseSchema>;
