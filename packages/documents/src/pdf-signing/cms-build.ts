/**
 * Assembles the CMS `SignedData` blob a PDF `/Contents` string carries,
 * in two halves separated by the one operation this process cannot do.
 *
 * The private key is on a USB token in another building. So the assembly
 * splits exactly where the key is needed and nowhere else:
 *
 *   1. `buildSignedAttributes` — everything up to and including the bytes
 *      RFC 5652 §5.4 says are signed, plus the SHA-256 of them. That digest
 *      is the ONLY thing that leaves this process, and the only thing the
 *      token ever sees.
 *   2. `assembleSignedData` — the raw signature comes back and is dropped
 *      into the SignerInfo. No key material, no PIN, nothing secret has
 *      been anywhere near this server.
 *
 * ADR-0012 puts the split here deliberately: "CMS assembly, SignedAttrs
 * construction, timestamping and embedding remain server-side and follow
 * ADR-0009 to the letter", and the kiosk "returns the raw signature". The
 * same seam is what lets Aadhaar eSign land beside the kiosk later without
 * rework — an ESP hands back a whole PKCS#7 rather than a raw signature,
 * which is a different fulfilment of step 2 and touches nothing else.
 *
 * PROFILE. PAdES-shaped, matching `ETSI.CAdES.detached`:
 *
 * - Detached: `eContentType` is `id-data` with no `eContent`. The signed
 *   content is the PDF's ByteRange bytes, supplied externally.
 * - Signed attributes: `contentType`, `messageDigest`, and
 *   `signing-certificate-v2`. The third is not optional here — the
 *   verifier (`pdf-signature.ts`) treats its absence in an
 *   `ETSI.CAdES.detached` signature as a defect, and rightly: without it
 *   the CMS names its signer only in the unprotected SignerIdentifier.
 * - NO `signingTime` attribute. ADR-0009's ruling, carried forward: a
 *   signer's own clock is not evidence, and putting it in signedAttrs
 *   dresses a claim up as one. The PDF's `/M` carries the claim, labelled
 *   as a claim, and an RFC 3161 timestamp carries the fact when the TSA
 *   contract lands.
 * - SHA-256 throughout. The token is RSA 2048 and the signature is
 *   PKCS#1 v1.5 over a SHA-256 DigestInfo, which is what Windows CNG's
 *   `RSACng.SignHash(hash, SHA256, Pkcs1)` produces.
 */

import { createHash, type X509Certificate } from 'node:crypto';
import { certificateIdentity } from '../pdf-signature/cms.js';
import { algorithmIdentifier, der } from './der.js';

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256: '2.16.840.1.101.3.4.2.1',
} as const;

/** The digest the token is asked to sign, and the bytes it is a digest
 * OF — kept together because storing one without the other makes the
 * signature unreconstructible later. */
export interface SignedAttributes {
  /** The signedAttrs as `[0] IMPLICIT`, for the SignerInfo. */
  readonly implicitDer: Buffer;
  /** The same attributes as a `SET OF` — the exact octets RFC 5652 §5.4
   * defines as signed, and what a verifier will re-derive and check. */
  readonly toBeSigned: Buffer;
  /** `sha256(toBeSigned)`. This, and only this, goes to the token. */
  readonly digest: Buffer;
}

/**
 * The signed attributes for one detached signature over `content`.
 *
 * `signerCertificate` is needed here, before any signing happens, because
 * `signing-certificate-v2` binds the certificate INTO the signed data. A
 * consequence worth stating: the certificate must be known when the
 * signing request is raised, not when it is fulfilled. That is why the
 * kiosk agent registers its certificate up front and is pinned to one
 * thumbprint — a request cannot be prepared for a certificate nobody has
 * seen yet, and a request prepared for one certificate cannot be fulfilled
 * by another.
 */
export function buildSignedAttributes(
  content: Buffer,
  signerCertificate: X509Certificate,
): SignedAttributes {
  const attributes = [
    der.sequence(
      der.objectIdentifier(OID.contentType),
      der.set(der.objectIdentifier(OID.data)),
    ),
    der.sequence(
      der.objectIdentifier(OID.messageDigest),
      der.set(der.octetString(createHash('sha256').update(content).digest())),
    ),
    der.sequence(
      der.objectIdentifier(OID.signingCertificateV2),
      der.set(
        // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }
        // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm DEFAULT id-sha256,
        //                            certHash OCTET STRING, ... }
        // The hash algorithm is SHA-256, which is the DEFAULT, and DER
        // requires a DEFAULT-valued field to be omitted rather than
        // written out.
        der.sequence(
          der.sequence(
            der.sequence(
              der.octetString(
                createHash('sha256').update(signerCertificate.raw).digest(),
              ),
            ),
          ),
        ),
      ),
    ),
  ];
  const toBeSigned = der.set(...attributes);
  return {
    implicitDer: der.context(0, ...attributes),
    toBeSigned,
    digest: createHash('sha256').update(toBeSigned).digest(),
  };
}

export interface AssembleSignedDataInput {
  /** The signer's certificate first, then every issuer up to and including
   * the root the deployment trusts. All of them travel in the CMS so a
   * verifier can build the path without network egress — which is the only
   * way this product's verifier can build one at all. */
  readonly certificateChain: readonly X509Certificate[];
  readonly signedAttributes: SignedAttributes;
  /** The token's answer: RSA PKCS#1 v1.5 over the SHA-256 DigestInfo of
   * `signedAttributes.digest`. 256 octets for the RSA 2048 keys Class 3
   * tokens carry. */
  readonly signature: Buffer;
}

/** The finished `ContentInfo`/`SignedData`, ready for `/Contents`. */
export function assembleSignedData(input: AssembleSignedDataInput): Buffer {
  const [signerCertificate] = input.certificateChain;
  if (signerCertificate === undefined) {
    throw new Error('a CMS SignedData needs at least the signing certificate');
  }
  const identity = certificateIdentity(signerCertificate);

  const signerInfo = der.sequence(
    // version 1: the signer is named by IssuerAndSerialNumber.
    der.integer(1),
    der.sequence(
      Buffer.from(identity.issuerDerHex, 'hex'),
      der.integer(Buffer.from(identity.serialHex, 'hex')),
    ),
    algorithmIdentifier(OID.sha256),
    input.signedAttributes.implicitDer,
    algorithmIdentifier(OID.rsaEncryption),
    der.octetString(input.signature),
  );

  return der.sequence(
    der.objectIdentifier(OID.signedData),
    der.context(
      0,
      der.sequence(
        der.integer(1),
        der.set(algorithmIdentifier(OID.sha256)),
        // Detached: the content type, and no content.
        der.sequence(der.objectIdentifier(OID.data)),
        der.context(0, ...input.certificateChain.map((certificate) => certificate.raw)),
        der.set(signerInfo),
      ),
    ),
  );
}
