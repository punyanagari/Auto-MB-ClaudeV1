/**
 * Digital-signature verification for inbound railway PDFs.
 *
 * A shared capability, not a feature of one route. Indian Railways issues
 * variation statements, Measurement Book copies, tax invoices, bill copies
 * and agreements as digitally signed PDFs; every one of those is a document
 * whose authenticity matters, and they all reach this product the same way
 * — as bytes on an upload endpoint. `verifyPdfSignatures` is therefore the
 * single answer for all of them, and its result is a STRUCTURED VERDICT
 * rather than a boolean, because "is this signed?" has no honest yes/no
 * answer: a document can be signed and intact, signed by an unknown
 * issuer, signed and then appended to, or carry a signature this verifier
 * could not read at all, and those are four different things a reviewer
 * must be able to act on differently.
 *
 * The posture this file holds to, which is the same posture
 * `loa-extract.ts` holds for text extraction and the statutory evidence
 * work holds for `registered_unverified`:
 *
 *   VERIFICATION NEVER SILENTLY PASSES SOMETHING IT COULD NOT CHECK.
 *
 * "Not checked" and "checked and good" are different values in the data,
 * they stay different all the way to the screen, and only one of them is
 * allowed to render green. A verifier that reports a chain as trusted
 * because no trust anchors were configured, or reports a document as
 * signed because a green tick was drawn on page 1, is worse than no
 * verifier: it manufactures confidence.
 *
 * What this proves and what it does not:
 *
 * - PROVEN OFFLINE, with no network egress: that the bytes now present are
 *   the bytes covered by each signature (the ByteRange digest); that each
 *   signature verifies under the public key of the certificate the CMS
 *   names; that a certificate path links that certificate to a trust
 *   anchor an operator installed; that no bytes were appended after the
 *   last signature; the signer's identity as stated in the certificate;
 *   and, when a timestamp token is embedded, the time a TSA attested to.
 * - NOT PROVEN, and reported as not proven: revocation. CRL download,
 *   live OCSP, and AIA chasing all need egress this deployment does not
 *   assume, so revocation is reported as `not_checked` with its reason,
 *   never as "good". A revoked-but-otherwise-valid signature therefore
 *   reads as verified here; that limitation is stated in the verdict and
 *   on the screen rather than left to be discovered.
 * - NOT PROVEN, and reported: whether an incremental update after an
 *   earlier signature altered what the document SAYS. Detecting that in
 *   full needs revision-by-revision rendering comparison (the "shadow
 *   attack" class). What is proven is narrower and still decisive for the
 *   common case: whether the final bytes are entirely covered by a
 *   signature at all.
 */

import { X509Certificate } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Asn1Error } from './pdf-signature/asn1.js';
import {
  OID_ATTR_TIMESTAMP_TOKEN,
  OID_CT_TST_INFO,
  WEAK_DIGESTS,
  checkContentBinding,
  checkSigningCertificateAttribute,
  findAttribute,
  findSigningCertificate,
  parseSignedData,
  parseTstInfo,
  readSigningTimeAttribute,
  verifySignerSignature,
  type CmsSignedData,
  type CmsSignerInfo,
  type SigningCertificateBinding,
} from './pdf-signature/cms.js';
import {
  PdfSignatureStructureError,
  parsePdfDate,
  scanPdfSignatures,
  type PdfSignatureField,
} from './pdf-signature/pdf-document.js';
import {
  EMPTY_TRUST_ANCHOR_STORE,
  validateChain,
  type ChainResult,
  type TrustAnchorStore,
} from './pdf-signature/trust-anchors.js';
import type {
  PdfDocumentSignatureStatus,
  PdfSignatureReport,
  PdfSignatureVerdict,
} from '@auto-mb/contracts';

export {
  TRUST_ANCHOR_PATH_ENV,
  TrustAnchorConfigurationError,
  EMPTY_TRUST_ANCHOR_STORE,
  loadTrustAnchors,
  type TrustAnchorStore,
} from './pdf-signature/trust-anchors.js';

/**
 * The version of the verification RULES, stored beside every verdict.
 *
 * A verdict is evidence, and evidence is only interpretable if you know
 * what produced it. When the rules change — a new algorithm accepted, a
 * coverage check tightened — this moves, and a stored verdict from an
 * older version is recognisable as such instead of being silently compared
 * against today's meaning.
 */
export const PDF_SIGNATURE_VERIFIER_VERSION = '1';

/**
 * The verdict shapes live in `@auto-mb/contracts` and are re-exported
 * here, so the type this module produces, the type the API transports, the
 * type the browser renders, and the JSON Schema that validates the
 * `loa_documents.signature_verdict` column are one definition rather than
 * four that drift.
 *
 * `packages/contracts/src/pdf-signature.ts` carries the meaning of every
 * status — in particular why there are eight document statuses rather than
 * the four the brief named, and why exactly one of them may render green.
 */
export type {
  PdfDocumentSignatureStatus,
  PdfSignatureReport,
  PdfSignatureVerdict,
  SignatureIntegrity,
  StoredPdfSignatureStatus,
} from '@auto-mb/contracts';

type SignatureTimestamp = PdfSignatureVerdict['timestamp'];
type SignatureIntegrity = PdfSignatureVerdict['integrity'];

export interface VerifyPdfSignaturesOptions {
  readonly trustAnchors?: TrustAnchorStore;
  /** Reference instant for certificate validity. Defaults to now; tests
   * pin it so a verdict does not change meaning as certificates age. */
  readonly now?: Date;
}

/** Reads one RDN attribute out of Node's rendered subject/issuer string. */
function rdn(distinguishedName: string | null, key: string): string | null {
  if (distinguishedName === null) return null;
  for (const line of distinguishedName.split('\n')) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim() !== key) continue;
    const value = line.slice(separator + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The chain result as the transport shape: same facts, mutable arrays,
 * and `reason` widened to the string the contract carries so a new reason
 * never needs a contract change to be reportable. */
function toTransportChain(chain: ChainResult): PdfSignatureVerdict['chain'] {
  return { ...chain, path: chain.path.map((entry) => ({ ...entry })) };
}

/**
 * Verifies an embedded RFC 3161 timestamp token.
 *
 * The token is itself a CMS SignedData whose encapsulated TSTInfo carries
 * a message imprint. Three things must hold before a time is believable:
 * the imprint must be the digest of THIS signature's signature octets (so
 * the token belongs to this signature and not another document's), the
 * token's own CMS signature must verify, and the timestamping authority's
 * certificate must chain to a configured anchor. Any of them failing
 * leaves the time reported as a claim, with the reason stated — the time
 * is never simply dropped, because "there is a timestamp we could not
 * verify" is itself something a reviewer should see.
 */
function verifyTimestamp(
  signer: CmsSignerInfo,
  anchors: TrustAnchorStore,
  now: Date,
): SignatureTimestamp {
  const attribute = findAttribute(signer.unsignedAttributes, OID_ATTR_TIMESTAMP_TOKEN);
  const token = attribute?.values[0];
  if (token === undefined) {
    return {
      present: false,
      time: null,
      status: 'absent',
      reason: 'no_timestamp_token',
      authoritySubject: null,
    };
  }

  const unverified = (reason: string, time: string | null, subject: string | null) =>
    ({
      present: true,
      time,
      status: 'unverified',
      reason,
      authoritySubject: subject,
    }) as const;

  let tokenData: CmsSignedData;
  let tstSigner: CmsSignerInfo;
  let info: ReturnType<typeof parseTstInfo>;
  try {
    tokenData = parseSignedData(Buffer.from(token.bytes));
    const first = tokenData.signers[0];
    if (first === undefined) return unverified('timestamp_token_has_no_signer', null, null);
    tstSigner = first;
    if (tokenData.eContentType !== OID_CT_TST_INFO || tokenData.eContent === null) {
      return unverified('timestamp_token_carries_no_tstinfo', null, null);
    }
    info = parseTstInfo(tokenData.eContent);
  } catch (error) {
    return unverified(
      error instanceof Asn1Error ? 'timestamp_token_unreadable' : 'timestamp_token_failed',
      null,
      null,
    );
  }

  const time = info.genTime.toISOString();
  const imprint = createHash(info.digestAlgorithm).update(signer.signature).digest();
  if (!imprint.equals(info.messageImprint)) {
    return unverified('timestamp_imprint_does_not_match_this_signature', time, null);
  }

  const authority = findSigningCertificate(tokenData, tstSigner);
  if (authority === null) {
    return unverified('timestamp_authority_certificate_missing', time, null);
  }
  const binding = checkContentBinding(tokenData, tstSigner, tokenData.eContent, null);
  if (binding.kind !== 'intact') {
    return unverified('timestamp_token_content_mismatch', time, authority.subject);
  }
  if (!verifySignerSignature(tokenData, tstSigner, authority, tokenData.eContent)) {
    return unverified('timestamp_token_signature_invalid', time, authority.subject);
  }
  const chain = validateChain(authority, tokenData.certificates, anchors, now, info.genTime);
  if (chain.status !== 'trusted') {
    return unverified(`timestamp_authority_${chain.reason}`, time, authority.subject);
  }
  return {
    present: true,
    time,
    status: 'verified',
    reason: 'verified',
    authoritySubject: authority.subject,
  };
}

interface FieldOutcome {
  readonly verdict: Omit<PdfSignatureVerdict, 'coverage'>;
  readonly signedTo: number;
  readonly signedByteCount: number;
}

function unverifiableVerdict(
  index: number,
  field: PdfSignatureField,
  detail: string,
): FieldOutcome {
  return {
    signedTo: field.signedTo,
    signedByteCount: field.signedBytes.length,
    verdict: {
      index,
      subFilter: field.subFilter,
      filter: field.filter,
      signer: {
        commonName: null,
        organisation: null,
        organisationalUnit: null,
        subject: null,
        issuerCommonName: null,
        certificateSerialNumber: null,
        declaredName: field.name,
      },
      claimedSigningTime: toIso(parsePdfDate(field.claimedSigningTime)),
      claimedSigningTimeSource:
        field.claimedSigningTime === null ? 'none' : 'signature_dictionary',
      timestamp: {
        present: false,
        time: null,
        status: 'absent',
        reason: 'signature_not_readable',
        authoritySubject: null,
      },
      reason: field.reason,
      location: field.location,
      contactInfo: field.contactInfo,
      integrity: 'unverifiable',
      integrityDetail: detail,
      digestAlgorithm: null,
      weakDigest: false,
      signingCertificateBinding: 'absent',
      chain: {
        status: 'not_checked',
        reason: 'signature_not_readable',
        reachesConfiguredAnchor: false,
        anchorSubject: null,
        path: [],
        validAtVerificationTime: false,
        validAtClaimedSigningTime: null,
      },
      revocation: {
        status: 'not_checked',
        reason: 'network_egress_not_available',
        embeddedRevocationData: false,
      },
      certification: field.certification,
    },
  };
}

function verifyField(
  index: number,
  field: PdfSignatureField,
  anchors: TrustAnchorStore,
  now: Date,
): FieldOutcome {
  let signedData: CmsSignedData;
  let signer: CmsSignerInfo;
  try {
    signedData = parseSignedData(field.contents);
    const first = signedData.signers[0];
    if (first === undefined) throw new Asn1Error('SignedData carries no SignerInfo');
    // A PDF signature dictionary represents ONE signature. A blob carrying
    // several SignerInfos is ambiguous about which one the field means, and
    // resolving that ambiguity by picking the first is how a verifier ends
    // up displaying one signer while having verified another. Refused as
    // unverifiable rather than guessed.
    if (signedData.signers.length !== 1) {
      throw new Asn1Error(
        `the signature carries ${String(signedData.signers.length)} SignerInfos; exactly one is expected`,
      );
    }
    signer = first;
  } catch (error) {
    if (error instanceof Asn1Error || error instanceof PdfSignatureStructureError) {
      return unverifiableVerdict(
        index,
        field,
        `the signature blob could not be read: ${error.message}`,
      );
    }
    throw error;
  }

  const certificate: X509Certificate | null = findSigningCertificate(signedData, signer);
  const attributeTime = readSigningTimeAttribute(signer);
  const dictionaryTime = parsePdfDate(field.claimedSigningTime);
  const claimed = dictionaryTime ?? attributeTime;
  const claimedSource: PdfSignatureVerdict['claimedSigningTimeSource'] =
    dictionaryTime !== null
      ? 'signature_dictionary'
      : attributeTime !== null
        ? 'signed_attribute'
        : 'none';

  let integrity: SignatureIntegrity;
  let integrityDetail: string | null = null;
  let signingCertificateBinding: SigningCertificateBinding = 'absent';
  if (certificate === null) {
    integrity = 'unverifiable';
    integrityDetail =
      'the signature does not carry the certificate it names, so the signing key is unknown';
  } else {
    signingCertificateBinding = checkSigningCertificateAttribute(signer, certificate);
    const binding = checkContentBinding(
      signedData,
      signer,
      field.signedBytes,
      field.subFilter,
    );
    if (binding.kind === 'digest_mismatch') {
      integrity = 'digest_mismatch';
      integrityDetail = binding.detail;
    } else if (signingCertificateBinding === 'mismatch') {
      // The signer committed to a specific certificate and this is not it:
      // a certificate-substitution attempt, reported as an invalid
      // signature because the identity on display would otherwise be a
      // different person from the one who signed.
      integrity = 'signature_invalid';
      integrityDetail =
        'the signed signing-certificate attribute names a different certificate from the one the signature was verified against';
    } else if (
      signingCertificateBinding === 'absent' &&
      field.subFilter === 'ETSI.CAdES.detached'
    ) {
      // PAdES requires the binding. Its absence in a document that claims
      // to be PAdES means the signer identity is not committed to, which
      // this verifier will not paper over.
      integrity = 'unverifiable';
      integrityDetail =
        'this PAdES (ETSI.CAdES.detached) signature omits the required signing-certificate attribute, so the certificate it names is not covered by the signature';
    } else if (
      !verifySignerSignature(signedData, signer, certificate, field.signedBytes)
    ) {
      integrity = 'signature_invalid';
      integrityDetail =
        "the signature does not verify under the public key of the signer's certificate";
    } else {
      integrity = 'intact';
    }
  }

  // The timestamp is evidence about WHEN, so it is read whatever the
  // integrity outcome: "the bytes changed, and a TSA attested to the
  // original at 14:48" is more useful than dropping the time.
  const timestamp = verifyTimestamp(signer, anchors, now);
  // A verified timestamp is the only third-party statement about time
  // available offline; without one, certificate validity is judged at the
  // verification instant and the signer's claimed time is reported as the
  // claim it is.
  const chainReferenceTime =
    timestamp.status === 'verified' && timestamp.time !== null
      ? new Date(timestamp.time)
      : now;

  return {
    signedTo: field.signedTo,
    signedByteCount: field.signedBytes.length,
    verdict: {
      index,
      subFilter: field.subFilter,
      filter: field.filter,
      signer: {
        commonName: rdn(certificate?.subject ?? null, 'CN'),
        organisation: rdn(certificate?.subject ?? null, 'O'),
        organisationalUnit: rdn(certificate?.subject ?? null, 'OU'),
        subject: certificate?.subject ?? null,
        issuerCommonName: rdn(certificate?.issuer ?? null, 'CN'),
        certificateSerialNumber: certificate?.serialNumber ?? null,
        declaredName: field.name,
      },
      claimedSigningTime: toIso(claimed),
      claimedSigningTimeSource: claimedSource,
      timestamp,
      reason: field.reason,
      location: field.location,
      contactInfo: field.contactInfo,
      integrity,
      integrityDetail,
      digestAlgorithm: signer.digestAlgorithm,
      weakDigest: WEAK_DIGESTS.has(signer.digestAlgorithm),
      signingCertificateBinding,
      chain: toTransportChain(
        validateChain(
          certificate,
          signedData.certificates,
          anchors,
          chainReferenceTime,
          claimed,
        ),
      ),
      revocation: {
        status: 'not_checked',
        reason: 'network_egress_not_available',
        embeddedRevocationData: signedData.hasCrls,
      },
      certification: field.certification,
    },
  };
}

function documentStatus(
  signatures: readonly PdfSignatureVerdict[],
  unreadable: number,
  unsignedTrailingBytes: number,
): PdfDocumentSignatureStatus {
  if (signatures.length === 0 && unreadable === 0) return 'unsigned';
  if (signatures.some((signature) => signature.integrity === 'signature_invalid')) {
    return 'signature_invalid';
  }
  if (
    unsignedTrailingBytes > 0 ||
    signatures.some((signature) => signature.integrity === 'digest_mismatch')
  ) {
    return 'signed_but_modified_after_signing';
  }
  if (unreadable > 0 || signatures.some((s) => s.integrity === 'unverifiable')) {
    return 'signature_unverifiable';
  }
  // An unknown issuer outranks an expired-but-known one: it is the more
  // serious fact, and a document with both should read as the worse of the
  // two rather than as the more forgiving one.
  if (
    signatures.some(
      (signature) =>
        signature.chain.status === 'untrusted' && !signature.chain.reachesConfiguredAnchor,
    )
  ) {
    return 'signed_but_untrusted_chain';
  }
  if (signatures.some((signature) => signature.chain.status === 'untrusted')) {
    return 'signed_chain_expired';
  }
  if (signatures.some((signature) => signature.chain.status === 'not_checked')) {
    return 'signed_chain_not_checked';
  }
  return 'signed_and_intact';
}

/**
 * Verifies every digital signature in `pdf` and returns the whole picture.
 *
 * Never throws for a bad document: an unreadable signature, a broken CMS
 * blob, or a truncated file are all VERDICTS, because they are facts about
 * the upload rather than faults in the server. The only exceptions that
 * escape are genuine programming or platform errors.
 */
export function verifyPdfSignatures(
  pdf: Buffer,
  options: VerifyPdfSignaturesOptions = {},
): PdfSignatureReport {
  const anchors = options.trustAnchors ?? EMPTY_TRUST_ANCHOR_STORE;
  const now = options.now ?? new Date();
  const scan = scanPdfSignatures(pdf);

  const outcomes = scan.fields.map((field, position) =>
    verifyField(position + 1, field, anchors, now),
  );

  const furthestIntactCoverage = outcomes.reduce(
    (furthest, outcome) =>
      outcome.verdict.integrity === 'intact' && outcome.signedTo > furthest
        ? outcome.signedTo
        : furthest,
    0,
  );
  const furthestCoverage = outcomes.reduce(
    (furthest, outcome) => Math.max(furthest, outcome.signedTo),
    0,
  );
  const unsignedTrailingBytes =
    outcomes.length === 0 ? 0 : Math.max(0, scan.fileLength - furthestCoverage);

  const signatures: PdfSignatureVerdict[] = outcomes.map((outcome) => ({
    ...outcome.verdict,
    coverage: {
      coversWholeDocument: outcome.signedTo === scan.fileLength,
      signedByteCount: outcome.signedByteCount,
      unsignedBytesAfter: scan.fileLength - outcome.signedTo,
      revisionsAfter: scan.revisionEnds.filter((end) => end > outcome.signedTo).length,
      trailingBytesCoveredByLaterSignature:
        outcome.signedTo < scan.fileLength &&
        furthestIntactCoverage >= scan.fileLength,
    },
  }));

  return {
    status: documentStatus(
      signatures,
      scan.malformed.length,
      unsignedTrailingBytes,
    ),
    signatureCount: signatures.length + scan.malformed.length,
    signatures,
    unreadableSignatures: scan.malformed.map((entry) => ({ ...entry })),
    fileLength: scan.fileLength,
    unsignedTrailingBytes,
    trustAnchors: {
      configured: anchors.anchors.length > 0,
      count: anchors.anchors.length,
      source: anchors.configuredPath,
    },
    verifiedAt: now.toISOString(),
    verifierVersion: PDF_SIGNATURE_VERIFIER_VERSION,
  };
}
