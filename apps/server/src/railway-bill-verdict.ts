import type {
  PdfSignatureReport,
  PdfSignatureVerdict,
  StoredPdfSignatureStatus,
} from '@auto-mb/contracts';

/**
 * Whether a received railway bill's signatures are good enough to settle
 * money against.
 *
 * The owner's gating rulings of 2026-08-13, in full:
 *
 *  1. The signature must be INTACT — the bytes the signer signed still
 *     digest to what they signed.
 *  2. It must CHAIN TO CCA INDIA — a complete issuer chain reaching an
 *     installed trust anchor.
 *  3. CERTIFICATE EXPIRY IS IGNORED.
 *
 * Rule 3 is the one that needs explaining, because it reads like a
 * weakening and is not. Indian DSC signing certificates run two or three
 * years, railway bills are settled and re-examined for far longer than
 * that, and none of these signatures carries an RFC 3161 timestamp
 * (`sub_filter: adbe.pkcs7.sha1`, `timestamp: absent` on every signature
 * in the settlement corpus). So a bill signed perfectly well in May 2026
 * necessarily becomes "expired" at some later date, through no change in
 * the document and no act of anyone. Refusing settlement on that would
 * refuse every bill the agency holds, eventually. What expiry cannot do
 * is make a modified document look intact or an unknown issuer look like
 * the CCA — those are rules 1 and 2, and they are not relaxed.
 *
 * ## "Chains to CCA India"
 *
 * There is no test here for the string "CCA India", and there deliberately
 * is not one. Trust in this product is the set of anchors an operator
 * installed (`AUTO_MB_PDF_TRUST_ANCHORS`, shipped with the CCA India roots
 * in `deploy/trust-anchors/`), and a chain is trusted when it terminates
 * on a certificate whose exact DER matches one of them
 * (`pdf-signature/trust-anchors.ts`). Matching an anchor's SUBJECT text
 * instead would be theatre: a subject is a string any issuer may print.
 * So "chains to CCA India" is read as "reaches a configured anchor", and
 * WHICH anchors are configured is the deployment's statement about who
 * the CCA is.
 *
 * The consequence worth stating: on a server with no anchors installed,
 * every verdict is `signed_chain_not_checked` and this predicate refuses.
 * That is the correct direction — an unconfigured server knows nothing
 * and must not settle money on that basis.
 */

/**
 * How many signatures an IWRCMS On-Account Bill carries: the contractor,
 * the railway's engineer representative, and the Sr. DSTE who accepts it.
 *
 * All three appear on every bill in the settlement corpus. Fewer than
 * three means the bill is still moving through the railway's own approval
 * chain and is not yet an accepted bill, whatever its arithmetic says.
 */
export const RAILWAY_BILL_SIGNATURE_COUNT = 3;

/**
 * The two document statuses that satisfy the ruling.
 *
 * `signed_and_intact` is the verifier's only green state. `signed_chain_expired`
 * is its exact meaning minus the expiry clause: the contract's own words
 * for it are "chains reach a configured anchor, but a certificate in one
 * is outside its validity window". Rule 3 is what admits the second.
 *
 * Everything else is refused, and each for its own reason:
 * `unsigned` (a print of a signed bill is pixels), `signed_but_untrusted_chain`
 * (unknown issuer), `signed_chain_not_checked` (this server made no trust
 * decision), `signed_but_modified_after_signing` (bytes moved),
 * `signature_invalid`, `signature_unverifiable`.
 */
const SETTLEABLE_DOCUMENT_STATUSES: readonly StoredPdfSignatureStatus[] = [
  'signed_and_intact',
  'signed_chain_expired',
];

/** Why a bill's signatures do not permit settlement, as a code the route
 * turns into a refusal and the screen turns into a sentence. */
export type RailwayBillVerdictRefusal =
  | 'not_verified'
  | 'document_status'
  | 'signature_count'
  | 'signature_integrity'
  | 'signature_chain'
  | 'signature_signers'
  | 'signature_coverage';

export interface RailwayBillVerdictAssessment {
  readonly acceptable: boolean;
  readonly refusal: RailwayBillVerdictRefusal | null;
  /** One sentence naming what is wrong with THIS bill, for the refusal
   * message. Never a remedy — the remedy catalog owns those. */
  readonly detail: string | null;
}

const ACCEPTABLE: RailwayBillVerdictAssessment = {
  acceptable: true,
  refusal: null,
  detail: null,
};

function refuse(
  refusal: RailwayBillVerdictRefusal,
  detail: string,
): RailwayBillVerdictAssessment {
  return { acceptable: false, refusal, detail };
}

/**
 * Whether one signature within the bill reaches a configured anchor with
 * its integrity intact.
 *
 * `chain.reachesConfiguredAnchor` rather than `chain.status === 'trusted'`
 * is what implements "expiry ignored" at the per-signature level: the
 * verifier sets `status` to `untrusted` with `reason: 'certificate_expired'`
 * while leaving `reachesConfiguredAnchor` true, precisely so a consumer
 * can tell an expired-but-genuine certificate from an unknown one. This
 * is that consumer.
 */
function signatureFault(
  signature: PdfSignatureVerdict,
): RailwayBillVerdictAssessment | null {
  if (signature.integrity !== 'intact') {
    return refuse(
      'signature_integrity',
      `Signature ${String(signature.index)} (${signature.signer.commonName ?? 'unnamed signer'}) is ${signature.integrity}.`,
    );
  }
  if (!signature.chain.reachesConfiguredAnchor) {
    return refuse(
      'signature_chain',
      `Signature ${String(signature.index)} (${signature.signer.commonName ?? 'unnamed signer'}) does not chain to an installed trust anchor.`,
    );
  }
  return null;
}

/**
 * Which CERTIFICATE signed this signature, as a value two signatures can
 * be compared on.
 *
 * RFC 5280's own answer: a certificate is identified by its issuer's
 * distinguished name together with the serial number that issuer assigned
 * it. Deliberately NOT the printed common name — `signer.commonName` is
 * the subject text, and a subject is a string any issuer may put in any
 * certificate, so comparing names would let three certificates naming
 * three different people count as three signers when one person holds all
 * three, and would equally let one certificate look like three if the
 * name were rendered differently.
 *
 * `chain.path[0]` is the signing certificate itself
 * (`pdf-signature/trust-anchors.ts` walks upward from the leaf), so it
 * carries the full issuer DN. The signer summary is the fallback for a
 * verdict recorded before a chain could be built; when neither yields
 * both halves the certificate is not identifiable and the caller refuses,
 * because "I cannot tell these apart" must not read as "these are
 * different".
 */
function certificateIdentity(signature: PdfSignatureVerdict): string | null {
  const leaf = signature.chain.path[0];
  if (leaf !== undefined && leaf.issuer !== '' && leaf.serialNumber !== '') {
    return `${leaf.issuer}::${leaf.serialNumber}`;
  }
  const { issuerCommonName, certificateSerialNumber } = signature.signer;
  if (
    issuerCommonName === null ||
    issuerCommonName === '' ||
    certificateSerialNumber === null ||
    certificateSerialNumber === ''
  ) {
    return null;
  }
  return `${issuerCommonName}::${certificateSerialNumber}`;
}

/**
 * The three signatures must come from three different CERTIFICATES.
 *
 * Owner ruling, 2026-08-14, extending the gating rulings of 2026-08-13.
 *
 * Those rulings — "intact, chains to CCA India, expiry ignored" — were
 * satisfied by one certificate signing the same bill three times. Every
 * clause held: three intact signatures, three chains to a configured
 * anchor, no expiry complaint. And any DSC that chains to an installed
 * anchor qualifies, which includes the agency's own staff certificates,
 * because a trust anchor says who issued a certificate and nothing
 * whatever about who the holder is.
 *
 * That is not what the three signatures on an On-Account Bill mean. The
 * contractor claims the measurement, the engineer's representative
 * accepts it, and the Sr. DSTE authorises payment against it; three
 * impressions of one key is one person doing all three, and cardinality
 * alone cannot tell that from the real thing.
 *
 * It stays one named check with its own refusal code and its own tests,
 * which is how a rule that may be revisited should be written — but it is
 * the rule now, not a proposal. `docs/PRODUCT.md` §5.5 states it, and any
 * future change moves both together.
 *
 * Note what it does NOT do: it does not check WHO signed, or in what
 * order, or that one of them is a railway officer. Those are claims about
 * identity that the trust anchor cannot support and this product has no
 * register to check against. Distinctness is the strongest statement the
 * evidence actually carries.
 */
function distinctSignerFault(
  signatures: readonly PdfSignatureVerdict[],
): RailwayBillVerdictAssessment | null {
  const identities = new Set<string>();
  for (const signature of signatures) {
    const identity = certificateIdentity(signature);
    if (identity === null) {
      return refuse(
        'signature_signers',
        `Signature ${String(signature.index)} does not name the certificate that made it, so it cannot be told apart from the others.`,
      );
    }
    identities.add(identity);
  }
  if (identities.size < RAILWAY_BILL_SIGNATURE_COUNT) {
    return refuse(
      'signature_signers',
      `The bill's ${String(signatures.length)} signatures were made by ${String(identities.size)} certificate(s); an accepted On-Account Bill is signed by three different holders.`,
    );
  }
  return null;
}

/**
 * Assesses a stored verdict against the settlement rules.
 *
 * Takes the stored status alongside the report because the two are
 * separate facts in storage (migration 0060) and a row may carry
 * `not_checked` with no report at all — a document uploaded before the
 * verifier existed. Told nothing, this answers "not settleable", which
 * is the only safe reading of silence.
 */
export function assessRailwayBillVerdict(
  status: StoredPdfSignatureStatus,
  report: PdfSignatureReport | null,
): RailwayBillVerdictAssessment {
  if (report === null || status === 'not_checked') {
    return refuse(
      'not_verified',
      'This bill carries no signature verdict, so nothing is known about its signatures.',
    );
  }
  if (!SETTLEABLE_DOCUMENT_STATUSES.includes(status)) {
    return refuse('document_status', `The bill's signature verdict is ${status}.`);
  }
  if (report.signatures.length < RAILWAY_BILL_SIGNATURE_COUNT) {
    return refuse(
      'signature_count',
      `The bill carries ${String(report.signatures.length)} of the ${String(RAILWAY_BILL_SIGNATURE_COUNT)} signatures an accepted On-Account Bill has.`,
    );
  }
  for (const signature of report.signatures) {
    const fault = signatureFault(signature);
    if (fault !== null) return fault;
  }

  const distinctFault = distinctSignerFault(report.signatures);
  if (distinctFault !== null) return distinctFault;

  /*
   * Coverage, checked once at the end and only on the LAST signature.
   *
   * A countersigned PDF is signed incrementally: each signer appends a
   * revision, so every signature but the last one legitimately has bytes
   * after it. Requiring `coversWholeDocument` of all three would refuse
   * every real bill — in the settlement corpus, BILL-1's contractor and
   * engineer signatures both report `covers_whole_document: false` with
   * `trailing_bytes_covered_by_later_signature: true`, and only the Sr.
   * DSTE's covers the file. What must hold is that NOTHING follows the
   * final signature, which is exactly what the last one covering the
   * whole document means.
   */
  const last = report.signatures.at(-1);
  if (last === undefined || !last.coverage.coversWholeDocument) {
    return refuse(
      'signature_coverage',
      'Bytes were appended after the bill was last signed.',
    );
  }
  return ACCEPTABLE;
}
