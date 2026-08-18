import { createHash, timingSafeEqual } from 'node:crypto';
import { financialYearLabel } from '../financial-year.js';
import { formatNicDate } from './irp-payload.js';
import type { IrpDocumentIdentity } from './statutory-provider.js';

/**
 * Local verification of IRP evidence (audit finding 2 residue).
 *
 * The audit's objection was that a provider response was adopted as
 * statutory fact on the provider's word alone: whatever came back was
 * written onto the invoice as the government's answer. Migration 0053
 * narrowed that by retaining the raw bodies and by giving manually typed
 * evidence its own `registered_unverified` state, but nothing in the
 * evidence was ever CHECKED. This module checks the parts the IRP contract
 * makes checkable without a secret.
 *
 * ## What is verifiable, and what is not
 *
 * **The IRN derivation is verifiable, exactly.** Per the NIC e-invoice
 * specification the Invoice Reference Number is not an opaque identifier
 * the portal invents: it is the SHA-256 of the supplier GSTIN, the document
 * type, the document number and the financial year, concatenated with no
 * separator, rendered as 64 lowercase hex characters. Every input is
 * already frozen on our own issued snapshot. So an IRN that does not
 * reproduce from OUR document's own identity is not an IRN for OUR
 * document, whatever the response claims — and that is a refusal, not a
 * warning.
 *
 * That single check is worth more than it looks. It catches a response
 * about a different invoice (a correlation bug, or a provider mixing up
 * concurrent requests), a transcription error on the manual path, and the
 * simplest fabrications — because forging a passing IRN requires computing
 * the correct hash of the real document identity, at which point the
 * "fabricated" IRN is the one the IRP would itself have issued.
 *
 * **The signed QR's CLAIMS are verifiable; its SIGNATURE is not, here.**
 * The signed QR is a JWS in compact serialization whose payload carries the
 * portal's own statement of the document — seller GSTIN, document number,
 * type and date, and the IRN. The payload is base64url, not encrypted, so
 * those claims can be read and compared against the document we submitted
 * and against the IRN in the same response. A response whose top-level IRN
 * and whose signed QR disagree is incoherent and refused.
 *
 * Verifying the JWS SIGNATURE would prove the government actually signed
 * it, which is the stronger claim. That needs the NIC IRP's public
 * certificate for the answering portal, with a trust path and a rotation
 * procedure. No certificate is provisioned, pinned or rotated anywhere in
 * this deployment, and a signature check against a certificate fetched at
 * verification time from the same party that supplied the evidence proves
 * nothing at all. So it is deliberately NOT implemented rather than
 * implemented insincerely; the disposition records it as the named
 * remainder. What IS recorded, so that a later certificate check has
 * something to verify against, is which portal answered
 * (`StatutoryProvider.portal`, persisted on every operation ledger row).
 */

/**
 * The evidence refusals this module raises. They are error CODES that
 * reach a client on the manual-record path (the route rethrows
 * `error.code` verbatim), and the Whitebooks adapter re-raises them under
 * a `WHITEBOOKS_` prefix, so both spellings are declared in the
 * contracts' `ERROR_CODES`. Naming the union here is what lets the type
 * checker prove the prefixed forms are declared too.
 */
export type IrnEvidenceCode =
  | 'IRP_IRN_DERIVATION_MISMATCH'
  | 'IRP_IRN_MALFORMED'
  | 'IRP_SIGNED_QR_IDENTITY_MISMATCH'
  | 'IRP_SIGNED_QR_IRN_MISMATCH'
  | 'IRP_SIGNED_QR_UNREADABLE';

/** 64 lowercase hex characters. */
const IRN_PATTERN = /^[0-9a-f]{64}$/;

export class IrnDerivationError extends Error {
  constructor(
    readonly code: IrnEvidenceCode,
    message: string,
    /** The IRN that was offered, for the audit trail. Never the expected
     * value: publishing that would hand a forger the answer. */
    readonly offeredIrn: string,
  ) {
    super(message);
    this.name = 'IrnDerivationError';
  }
}

/**
 * The NIC IRN for a document identity: SHA-256 over supplier GSTIN,
 * document type, document number and financial year, concatenated in that
 * order with no separator, lowercase hex.
 */
export function deriveIrn(identity: IrpDocumentIdentity): string {
  const documentType = identity.documentType ?? 'INV';
  const financialYear = financialYearLabel(identity.documentDate);
  return createHash('sha256')
    .update(
      `${identity.gstin}${documentType}${identity.documentNumber}${financialYear}`,
      'utf8',
    )
    .digest('hex');
}

/** Constant-time comparison of two hex IRNs of equal length. Not a secret,
 * but the comparison sits on an evidence-acceptance path and there is no
 * reason to leak a prefix-match timing signal. */
function irnEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Refuses an IRN that does not reproduce from the document's own frozen
 * identity. Throws `IrnDerivationError`; the caller decides how that
 * surfaces (a provider-boundary refusal in the adapter, a 409 on the
 * manual path).
 */
export function assertIrnDerivesFrom(irn: string, identity: IrpDocumentIdentity): void {
  const offered = irn.trim().toLowerCase();
  if (!IRN_PATTERN.test(offered)) {
    throw new IrnDerivationError(
      'IRP_IRN_MALFORMED',
      'The IRN is not 64 hexadecimal characters, so it cannot be an NIC Invoice Reference Number.',
      irn,
    );
  }
  if (!irnEquals(offered, deriveIrn(identity))) {
    throw new IrnDerivationError(
      'IRP_IRN_DERIVATION_MISMATCH',
      `The IRN does not derive from this document's own supplier GSTIN, type, number and financial year, so it is not this document's IRN.`,
      irn,
    );
  }
}

/** The document facts an IRP signed QR states about itself. Only the
 * fields we can hold the response to are named; the payload carries more
 * (totals, item count, main HSN) and unknown fields are ignored rather
 * than refused, because NIC extends this structure over time. */
interface SignedQrClaims {
  readonly irn: string;
  readonly sellerGstin: string | null;
  readonly documentNumber: string | null;
  readonly documentType: string | null;
  /** As printed by the portal, DD/MM/YYYY. */
  readonly documentDateText: string | null;
}

function claimText(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Reads the claims out of a signed QR without verifying its signature.
 *
 * The QR is a JWS compact serialization: `header.payload.signature`. The
 * payload is base64url JSON, and NIC nests the document facts inside it as
 * a `data` member that is itself a JSON *string*, so it is parsed twice.
 * Returns null when the value is not a decodable JWS carrying an IRN — the
 * caller decides whether that is a refusal.
 */
export function readSignedQrClaims(signedQr: string): SignedQrClaims | null {
  const segments = signedQr.trim().split('.');
  if (segments.length !== 3) return null;
  const [, payloadSegment] = segments;
  if (payloadSegment === undefined || payloadSegment === '') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const outer = payload as Record<string, unknown>;
  // NIC puts the facts in a `data` member that is a JSON string; some
  // sandbox builds inline it as an object. Accept both, and fall back to
  // the outer object so a flatter shape still verifies.
  let data: Record<string, unknown> = outer;
  const nested = outer.data;
  if (typeof nested === 'string') {
    try {
      const reparsed: unknown = JSON.parse(nested);
      if (typeof reparsed === 'object' && reparsed !== null) {
        data = reparsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  } else if (typeof nested === 'object' && nested !== null) {
    data = nested as Record<string, unknown>;
  }
  const irn = claimText(data, ['Irn', 'irn', 'IRN']);
  if (irn === null) return null;
  return {
    irn: irn.toLowerCase(),
    sellerGstin: claimText(data, ['SellerGstin', 'sellerGstin', 'SellerGSTIN']),
    documentNumber: claimText(data, ['DocNo', 'docNo', 'DocNum']),
    documentType: claimText(data, ['DocTyp', 'docTyp', 'DocType']),
    documentDateText: claimText(data, ['DocDt', 'docDt', 'DocDate']),
  };
}

export class SignedQrClaimError extends Error {
  constructor(
    readonly code: IrnEvidenceCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignedQrClaimError';
  }
}

/**
 * Holds the signed QR to the same identity as the rest of the response.
 *
 * The signature is not checked (see the module note). What IS proved is
 * internal coherence: the portal's own signed statement must be about the
 * document we submitted and must name the same IRN the response reported.
 * A response that fails this is not evidence of anything, whoever signed
 * it.
 *
 * A signed QR that is not a decodable JWS is refused too. The IRP always
 * returns one, and silently accepting an undecodable value would reopen
 * exactly the hole this closes.
 */
export function assertSignedQrAgrees(
  signedQr: string,
  reportedIrn: string,
  identity: IrpDocumentIdentity,
): void {
  const claims = readSignedQrClaims(signedQr);
  if (claims === null) {
    throw new SignedQrClaimError(
      'IRP_SIGNED_QR_UNREADABLE',
      'The signed QR is not a readable JWS carrying an IRN, so its claims cannot be checked against the document.',
    );
  }
  if (!irnEquals(claims.irn, reportedIrn.trim().toLowerCase())) {
    throw new SignedQrClaimError(
      'IRP_SIGNED_QR_IRN_MISMATCH',
      'The signed QR names a different IRN from the one the response reported.',
    );
  }
  const expectedType = identity.documentType ?? 'INV';
  const expectedDate = formatNicDate(identity.documentDate);
  // Each claim is checked only when the payload states it: NIC's payload
  // has grown members over time and an absent field is an older shape, not
  // a contradiction. A field that IS stated must agree.
  if (claims.sellerGstin !== null && claims.sellerGstin !== identity.gstin) {
    throw new SignedQrClaimError(
      'IRP_SIGNED_QR_IDENTITY_MISMATCH',
      'The signed QR names a different supplier GSTIN from the document submitted.',
    );
  }
  if (
    claims.documentNumber !== null &&
    claims.documentNumber !== identity.documentNumber
  ) {
    throw new SignedQrClaimError(
      'IRP_SIGNED_QR_IDENTITY_MISMATCH',
      'The signed QR names a different document number from the document submitted.',
    );
  }
  if (claims.documentType !== null && claims.documentType !== expectedType) {
    throw new SignedQrClaimError(
      'IRP_SIGNED_QR_IDENTITY_MISMATCH',
      'The signed QR names a different document type from the document submitted.',
    );
  }
  if (claims.documentDateText !== null && claims.documentDateText !== expectedDate) {
    throw new SignedQrClaimError(
      'IRP_SIGNED_QR_IDENTITY_MISMATCH',
      'The signed QR names a different document date from the document submitted.',
    );
  }
}
