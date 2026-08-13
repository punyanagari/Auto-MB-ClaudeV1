/**
 * Trust anchors for PDF signature chain validation, and the path building
 * that uses them.
 *
 * Why no roots are compiled in. Indian digitally signed documents chain to
 * the Controller of Certifying Authorities hierarchy: a signer certificate
 * issued by a licensed CA (eMudhra, (n)Code, Sify/SafeScrypt, Capricorn,
 * IDRBT, NIC CA and others), under that CA's own root, under the CCA's
 * "CCA India" root. Those roots are re-issued on their own schedule — the
 * corpus in front of this product already spans `CCA India 2014` and
 * `CCA India 2022` — so a snapshot pasted into source becomes wrong
 * silently, and "silently wrong" is exactly the failure this feature
 * exists to prevent. Anchors are therefore supplied by the OPERATOR as PEM
 * files and refreshed by the documented procedure in
 * docs/OPERATIONS.md, so the trust decision is auditable and its age is
 * knowable.
 *
 * Why the embedded chain is never enough on its own. Every signature in
 * the corpus ships its whole path INCLUDING the self-signed CCA root
 * inside the CMS blob. Accepting that root because it is self-signed and
 * present would make every forged document self-certifying. A path is only
 * trusted when it terminates at a certificate whose exact DER matches one
 * the operator installed.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

/** Anchors were configured but could not be loaded. An operator fault, and
 * loud: silently continuing with an empty anchor set would report every
 * genuinely-signed railway document as untrusted, and a reviewer told
 * "untrusted" about a good document learns to ignore the field. */
export class TrustAnchorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustAnchorConfigurationError';
  }
}

/** Directory of PEM files (`*.pem`, `*.crt`, `*.cer`), or a single PEM
 * bundle file. Unset means no anchors: chains are then reported as
 * `not_checked`, never as trusted. */
export const TRUST_ANCHOR_PATH_ENV = 'AUTO_MB_PDF_TRUST_ANCHORS';

export interface TrustAnchor {
  readonly certificate: X509Certificate;
  /** The file the anchor came from, for operational diagnosis. */
  readonly source: string;
}

export interface TrustAnchorStore {
  readonly anchors: readonly TrustAnchor[];
  /**
   * Certificates that may COMPLETE a path but can never end one.
   *
   * A real need, not a nicety: in the sample corpus a contractor's
   * signature from ProDigiSign embedded only its leaf, so the path had
   * nowhere to go and the signature — perfectly genuine — could only be
   * reported as reaching no anchor. Fetching the missing intermediate from
   * the certificate's own AIA URL at verification time would fix that by
   * turning an attacker-supplied URL into a server-side fetch, so the
   * intermediates are installed by the operator instead.
   *
   * They are kept in a SEPARATE list from the anchors on purpose. Loading
   * licensed-CA certificates as anchors is the classic fatal mistake here:
   * it would make one CA's compromise indistinguishable from a compromise
   * of the CCA root, and would silently accept paths that never actually
   * reach the root at all.
   */
  readonly intermediates: readonly TrustAnchor[];
  /** What was configured, for reporting alongside a verdict. */
  readonly configuredPath: string | null;
}

export const EMPTY_TRUST_ANCHOR_STORE: TrustAnchorStore = {
  anchors: [],
  intermediates: [],
  configuredPath: null,
};

/** Sub-directory of the configured path holding chain-completion
 * certificates that carry no trust of their own. */
export const INTERMEDIATES_DIRECTORY = 'intermediates';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const ANCHOR_EXTENSIONS = new Set(['.pem', '.crt', '.cer']);

function readPemBlocks(text: string, source: string): TrustAnchor[] {
  const anchors: TrustAnchor[] = [];
  for (const block of text.match(PEM_BLOCK) ?? []) {
    try {
      anchors.push({ certificate: new X509Certificate(block), source });
    } catch (error) {
      throw new TrustAnchorConfigurationError(
        `${source}: contains a PEM certificate block that could not be parsed (${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
  }
  return anchors;
}

async function readCertificateDirectory(directory: string): Promise<TrustAnchor[]> {
  let entries: string[];
  try {
    entries = (await readdir(directory)).sort();
  } catch {
    return [];
  }
  const found: TrustAnchor[] = [];
  for (const entry of entries) {
    if (!ANCHOR_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
    const file = path.join(directory, entry);
    found.push(...readPemBlocks(await readFile(file, 'utf8'), file));
  }
  return found;
}

/**
 * Loads the configured anchors. A configured-but-unusable path throws; an
 * unconfigured one returns an empty store, which downstream reports as
 * "chain not checked" rather than as a trusted or untrusted verdict.
 */
export async function loadTrustAnchors(
  configuredPath: string | undefined,
): Promise<TrustAnchorStore> {
  if (configuredPath === undefined || configuredPath.length === 0) {
    return EMPTY_TRUST_ANCHOR_STORE;
  }
  const resolved = path.resolve(configuredPath);
  try {
    await readdir(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      const text = await readFile(resolved, 'utf8');
      const anchors = readPemBlocks(text, resolved);
      if (anchors.length === 0) {
        throw new TrustAnchorConfigurationError(
          `${TRUST_ANCHOR_PATH_ENV} points at ${resolved}, which contains no PEM certificate blocks.`,
        );
      }
      return { anchors, intermediates: [], configuredPath: resolved };
    }
    throw new TrustAnchorConfigurationError(
      `${TRUST_ANCHOR_PATH_ENV} points at ${resolved}, which could not be read (${code ?? 'unknown error'}).`,
    );
  }

  const anchors = await readCertificateDirectory(resolved);
  if (anchors.length === 0) {
    throw new TrustAnchorConfigurationError(
      `${TRUST_ANCHOR_PATH_ENV} points at ${resolved}, which holds no .pem/.crt/.cer certificate files.`,
    );
  }
  const intermediates = await readCertificateDirectory(
    path.join(resolved, INTERMEDIATES_DIRECTORY),
  );
  return { anchors, intermediates, configuredPath: resolved };
}

export interface CertificateSummary {
  readonly subject: string;
  readonly issuer: string;
  readonly serialNumber: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly isCertificateAuthority: boolean;
}

export function summariseCertificate(
  certificate: X509Certificate,
): CertificateSummary {
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    isCertificateAuthority: certificate.ca,
  };
}

export type ChainStatus = 'trusted' | 'untrusted' | 'not_checked';

export interface ChainResult {
  readonly status: ChainStatus;
  /** A stable machine token; the UI turns it into a sentence. Never
   * collapsed into the status, so "we did not look" and "we looked and it
   * failed" stay different facts in the data. */
  readonly reason:
    | 'trusted'
    | 'no_trust_anchors_configured'
    | 'signing_certificate_not_in_signature'
    | 'no_path_to_configured_anchor'
    | 'path_signature_invalid'
    | 'certificate_expired'
    | 'certificate_not_yet_valid';
  /** True when a complete, cryptographically-valid issuer chain reaches a
   * configured anchor, regardless of validity dates. Reported separately
   * so an expired-but-genuine railway signature can be described exactly
   * as that, rather than as an unknown issuer. */
  readonly reachesConfiguredAnchor: boolean;
  readonly anchorSubject: string | null;
  readonly path: readonly CertificateSummary[];
  /** Whether every certificate in the path is inside its validity window
   * at the moment of verification. */
  readonly validAtVerificationTime: boolean;
  /** Whether every certificate in the path was inside its validity window
   * at the signer's CLAIMED signing time. Null when no claimed time was
   * available. A claimed time is not evidence — only a verified timestamp
   * would be — so this never promotes a chain to trusted; it exists so a
   * reviewer can see whether an expired certificate was expired when the
   * document was signed. */
  readonly validAtClaimedSigningTime: boolean | null;
}

/** How many issuer hops a path may take before the search gives up. */
const MAX_PATH_LENGTH = 10;

function withinValidity(certificate: X509Certificate, at: Date): boolean {
  return (
    at.getTime() >= Date.parse(certificate.validFrom) &&
    at.getTime() <= Date.parse(certificate.validTo)
  );
}

function sameCertificate(a: X509Certificate, b: X509Certificate): boolean {
  return a.raw.equals(b.raw);
}

/**
 * Builds an issuer path from `leaf` to a configured anchor.
 *
 * Anchors are preferred over the CMS's own certificates at every hop, so a
 * self-signed root that merely travelled with the document cannot end the
 * search: the path terminates only on a certificate whose exact DER an
 * operator installed. Each hop is verified twice — `checkIssued` for the
 * name/extension link and `verify` for the actual signature — because the
 * first is a naming check and only the second is evidence.
 */
export function validateChain(
  leaf: X509Certificate | null,
  intermediates: readonly X509Certificate[],
  store: TrustAnchorStore,
  verificationTime: Date,
  claimedSigningTime: Date | null,
): ChainResult {
  const empty = {
    reachesConfiguredAnchor: false,
    anchorSubject: null,
    path: [] as readonly CertificateSummary[],
    validAtVerificationTime: false,
    validAtClaimedSigningTime: null,
  };
  if (leaf === null) {
    return {
      status: 'untrusted',
      reason: 'signing_certificate_not_in_signature',
      ...empty,
    };
  }
  if (store.anchors.length === 0) {
    return {
      status: 'not_checked',
      reason: 'no_trust_anchors_configured',
      ...empty,
      path: [summariseCertificate(leaf)],
    };
  }

  const walked: X509Certificate[] = [leaf];
  let anchor: X509Certificate | null = null;
  let pathSignatureValid = true;

  for (let hop = 0; hop < MAX_PATH_LENGTH; hop += 1) {
    const current = walked[walked.length - 1];
    if (current === undefined) break;

    const anchorMatch = store.anchors.find((candidate) =>
      sameCertificate(candidate.certificate, current),
    );
    if (anchorMatch !== undefined) {
      anchor = anchorMatch.certificate;
      break;
    }

    const candidates = [
      ...store.anchors.map((entry) => entry.certificate),
      ...store.intermediates.map((entry) => entry.certificate),
      ...intermediates,
    ];
    const issuer = candidates.find(
      (candidate) =>
        candidate.ca &&
        !walked.some((seen) => sameCertificate(seen, candidate)) &&
        current.checkIssued(candidate),
    );
    if (issuer === undefined) break;
    if (!current.verify(issuer.publicKey)) {
      pathSignatureValid = false;
      walked.push(issuer);
      break;
    }
    walked.push(issuer);
  }

  const summary = walked.map((certificate) => summariseCertificate(certificate));
  const validNow = walked.every((certificate) =>
    withinValidity(certificate, verificationTime),
  );
  const validThen =
    claimedSigningTime === null
      ? null
      : walked.every((certificate) => withinValidity(certificate, claimedSigningTime));

  if (!pathSignatureValid) {
    return {
      status: 'untrusted',
      reason: 'path_signature_invalid',
      reachesConfiguredAnchor: false,
      anchorSubject: null,
      path: summary,
      validAtVerificationTime: validNow,
      validAtClaimedSigningTime: validThen,
    };
  }
  if (anchor === null) {
    return {
      status: 'untrusted',
      reason: 'no_path_to_configured_anchor',
      reachesConfiguredAnchor: false,
      anchorSubject: null,
      path: summary,
      validAtVerificationTime: validNow,
      validAtClaimedSigningTime: validThen,
    };
  }

  const shared = {
    reachesConfiguredAnchor: true,
    anchorSubject: anchor.subject,
    path: summary,
    validAtVerificationTime: validNow,
    validAtClaimedSigningTime: validThen,
  };
  if (!validNow) {
    // The path is genuine but a certificate in it is outside its validity
    // window right now. Without a verified timestamp there is nothing to
    // prove the signature was made while the certificate was live, so this
    // is not promoted to trusted — the signer's own claimed time is not
    // evidence, and `validAtClaimedSigningTime` says so explicitly.
    const expired = walked.some(
      (certificate) => verificationTime.getTime() > Date.parse(certificate.validTo),
    );
    return {
      status: 'untrusted',
      reason: expired ? 'certificate_expired' : 'certificate_not_yet_valid',
      ...shared,
    };
  }
  return { status: 'trusted', reason: 'trusted', ...shared };
}
