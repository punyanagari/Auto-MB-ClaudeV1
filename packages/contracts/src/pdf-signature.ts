import { Type, type Static } from '@sinclair/typebox';

/**
 * The digital-signature verdict for an inbound railway PDF.
 *
 * Shared vocabulary, not a per-document-type one: variation orders,
 * Railway-generated Measurement Book copies, tax invoices, bill copies and
 * agreements all arrive as signed PDFs and are all described with these
 * words. The verifier lives in `packages/documents/src/pdf-signature.ts`; this is
 * the shape it is transported and stored in.
 *
 * Every field here exists so that "we could not check this" never reads
 * the same as "we checked this and it is good". A boolean would have
 * collapsed integrity, trust, revocation, time, and coverage into one
 * answer, and every real-world PDF signature exploit on record succeeded
 * because some layer did exactly that.
 */

/** Whose statuses are safe to render green: exactly one. */
export const PDF_SIGNATURE_DOCUMENT_STATUSES = [
  /** No signature dictionary at all. Note that a scanned or
   * printed-to-PDF copy of a signed document lands HERE, however many
   * green ticks are drawn on the page — the ticks are pixels. */
  'unsigned',
  /** The only green state: every signature verified, every chain reached a
   * configured trust anchor with certificates valid at verification time,
   * and no bytes follow the last signature. */
  'signed_and_intact',
  /** At least one chain does not reach any configured anchor. */
  'signed_but_untrusted_chain',
  /** Chains reach a configured anchor, but a certificate in one is outside
   * its validity window and there is no verified timestamp to prove the
   * signature predates the expiry. */
  'signed_chain_expired',
  /** No trust anchors are installed on this server, so no trust decision
   * was made. An operator fact, not a document fact. */
  'signed_chain_not_checked',
  /** Bytes follow the last signature, or a signature's covered bytes no
   * longer digest to what it signed. */
  'signed_but_modified_after_signing',
  /** A signature does not verify under the public key of its own
   * certificate. */
  'signature_invalid',
  /** A signature is present but this verifier could not read it. */
  'signature_unverifiable',
] as const;
const PdfDocumentSignatureStatusSchema = Type.Union(
  PDF_SIGNATURE_DOCUMENT_STATUSES.map((status) => Type.Literal(status)),
  { description: 'Document-level digital-signature verdict.' },
);
export type PdfDocumentSignatureStatus = Static<
  typeof PdfDocumentSignatureStatusSchema
>;

/**
 * What a STORED verdict column can say, which is the document statuses
 * plus one more.
 *
 * `not_checked` exists only in storage and means exactly what it says: no
 * verification was ever performed on this row — it predates migration
 * 0060. It is deliberately not a synonym for `unsigned`, which is a
 * finding about the document. The distinction is the same one migration
 * 0053 drew between `registered_unverified` and `registered`, and it must
 * survive all the way to the screen: a reviewer told "unsigned" about a
 * document nobody examined has been misled.
 */
export const StoredPdfSignatureStatusSchema = Type.Union([
  Type.Literal('not_checked'),
  ...PDF_SIGNATURE_DOCUMENT_STATUSES.map((status) => Type.Literal(status)),
]);
export type StoredPdfSignatureStatus = Static<typeof StoredPdfSignatureStatusSchema>;

const SignatureIntegritySchema = Type.Union([
  Type.Literal('intact'),
  Type.Literal('digest_mismatch'),
  Type.Literal('signature_invalid'),
  Type.Literal('unverifiable'),
]);
export type SignatureIntegrity = Static<typeof SignatureIntegritySchema>;

const nullableString = Type.Union([Type.String(), Type.Null()]);

const CertificateSummarySchema = Type.Object(
  {
    subject: Type.String(),
    issuer: Type.String(),
    serialNumber: Type.String(),
    validFrom: Type.String(),
    validTo: Type.String(),
    isCertificateAuthority: Type.Boolean(),
  },
  { additionalProperties: false },
);

const SignatureChainSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('trusted'),
      Type.Literal('untrusted'),
      Type.Literal('not_checked'),
    ]),
    reason: Type.String(),
    /** True when a complete, cryptographically valid issuer chain reaches
     * an installed anchor — regardless of validity dates. Separated from
     * `status` so an expired-but-genuine railway certificate is never
     * described in the same words as one from an unknown issuer. */
    reachesConfiguredAnchor: Type.Boolean(),
    anchorSubject: nullableString,
    path: Type.Array(CertificateSummarySchema),
    validAtVerificationTime: Type.Boolean(),
    /** Whether the path was valid at the signer's CLAIMED time. A claim,
     * never evidence: it can never promote a chain to trusted, and exists
     * so a reviewer can see that an expired certificate was live when the
     * document says it was used. */
    validAtClaimedSigningTime: Type.Union([Type.Boolean(), Type.Null()]),
  },
  { additionalProperties: false },
);

const SignatureTimestampSchema = Type.Object(
  {
    present: Type.Boolean(),
    time: nullableString,
    status: Type.Union([
      Type.Literal('absent'),
      Type.Literal('verified'),
      Type.Literal('unverified'),
    ]),
    reason: Type.String(),
    authoritySubject: nullableString,
  },
  { additionalProperties: false },
);

const SignatureCoverageSchema = Type.Object(
  {
    coversWholeDocument: Type.Boolean(),
    signedByteCount: Type.Integer(),
    unsignedBytesAfter: Type.Integer(),
    revisionsAfter: Type.Integer(),
    /** Not covering the whole file is NORMAL for every signature but the
     * last one in a countersigned document. This says whether the bytes
     * that follow are attributable to a later signer who verified, or
     * anonymous. */
    trailingBytesCoveredByLaterSignature: Type.Boolean(),
  },
  { additionalProperties: false },
);

const SignatureRevocationSchema = Type.Object(
  {
    status: Type.Literal('not_checked'),
    reason: Type.Literal('network_egress_not_available'),
    embeddedRevocationData: Type.Boolean(),
  },
  { additionalProperties: false },
);

const PdfSignatureVerdictSchema = Type.Object(
  {
    index: Type.Integer({ minimum: 1 }),
    subFilter: nullableString,
    filter: nullableString,
    signer: Type.Object(
      {
        commonName: nullableString,
        organisation: nullableString,
        organisationalUnit: nullableString,
        subject: nullableString,
        issuerCommonName: nullableString,
        certificateSerialNumber: nullableString,
        /** The PDF `/Name` entry: what the signing application claimed,
         * kept beside the certificate subject rather than merged with it. */
        declaredName: nullableString,
      },
      { additionalProperties: false },
    ),
    claimedSigningTime: nullableString,
    claimedSigningTimeSource: Type.Union([
      Type.Literal('signature_dictionary'),
      Type.Literal('signed_attribute'),
      Type.Literal('none'),
    ]),
    timestamp: SignatureTimestampSchema,
    reason: nullableString,
    location: nullableString,
    contactInfo: nullableString,
    integrity: SignatureIntegritySchema,
    integrityDetail: nullableString,
    digestAlgorithm: nullableString,
    weakDigest: Type.Boolean(),
    signingCertificateBinding: Type.Union([
      Type.Literal('absent'),
      Type.Literal('matches'),
      Type.Literal('mismatch'),
    ]),
    chain: SignatureChainSchema,
    revocation: SignatureRevocationSchema,
    coverage: SignatureCoverageSchema,
    certification: Type.Object(
      {
        docMdp: Type.Boolean(),
        permissions: Type.Union([Type.Integer(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type PdfSignatureVerdict = Static<typeof PdfSignatureVerdictSchema>;

export const PdfSignatureReportSchema = Type.Object(
  {
    status: PdfDocumentSignatureStatusSchema,
    signatureCount: Type.Integer({ minimum: 0 }),
    signatures: Type.Array(PdfSignatureVerdictSchema),
    unreadableSignatures: Type.Array(
      Type.Object(
        { offset: Type.Integer(), reason: Type.String() },
        { additionalProperties: false },
      ),
    ),
    fileLength: Type.Integer({ minimum: 0 }),
    unsignedTrailingBytes: Type.Integer({ minimum: 0 }),
    trustAnchors: Type.Object(
      {
        configured: Type.Boolean(),
        count: Type.Integer({ minimum: 0 }),
        source: nullableString,
      },
      { additionalProperties: false },
    ),
    verifiedAt: Type.String({ format: 'date-time' }),
    /** Which rule set produced this verdict. Stored verdicts are evidence,
     * and evidence is only interpretable if you know what produced it. */
    verifierVersion: Type.String(),
  },
  { additionalProperties: false },
);
export type PdfSignatureReport = Static<typeof PdfSignatureReportSchema>;
