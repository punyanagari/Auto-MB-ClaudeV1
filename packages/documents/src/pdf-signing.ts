/**
 * Signing an issued PDF with a key this process does not hold.
 *
 * The counterpart of `pdf-signature.ts`, which verifies. Everything here
 * exists to serve ADR-0012's kiosk lane: the organisation's Class 3 DSC
 * lives on a USB token in a Windows machine in a private room, and the
 * server — which holds the documents, the tenancy and the audit trail —
 * holds no key at all and never will.
 *
 * ## The seam, and why it is where it is
 *
 * Signing is split into two calls with a digest in between:
 *
 *   prepareDetachedPdfSignature(source, …) -> { digest, … }
 *                     |
 *                     |  32 bytes cross the wire to the kiosk, and
 *                     |  256 bytes come back. Nothing else moves.
 *                     v
 *   finishDetachedPdfSignature(preparation, signature) -> signed PDF
 *
 * That is ADR-0012's ruling taken literally — the kiosk "signs via Windows
 * CNG … and returns the raw signature", while "CMS assembly, SignedAttrs
 * construction, timestamping and embedding remain server-side". It also
 * happens to be the smallest thing the kiosk can be: an agent that returns
 * a raw RSA signature needs no ASN.1, no PDF writer and no understanding
 * of what it signed, which is the difference between a script an owner can
 * read and a second implementation of this file in PowerShell.
 *
 * ## Determinism is the integrity binding
 *
 * `prepareDetachedPdfSignature` is a pure function of its arguments. Given
 * the same source bytes, the same certificate and the same options it
 * produces the same draft, the same ByteRange and the same digest, every
 * time. The signing queue leans on this: a request stores the digest it
 * asked the token to sign, and the completion path rebuilds the
 * preparation from the stored source and REFUSES if the digest it derives
 * is not the digest that was authorised.
 *
 * That check is what ADR-0012 § "The approval is the authority, and it
 * must be bound to the bytes" asks for. A token that signs whatever it is
 * handed is a signing oracle; a queue whose completion re-derives the
 * authorised digest from the document itself cannot be pointed at another
 * document without the mismatch showing.
 *
 * ## What is deliberately not here
 *
 * No RFC 3161 timestamp. ADR-0012 makes the TSA contract a procurement
 * dependency of BOTH lanes, and it has not landed. The signature is
 * therefore PAdES B-B: the `/M` entry carries the signer's claimed time,
 * labelled a claim by the verifier, and the unsigned-attribute slot a
 * timestamp token occupies is left empty rather than filled with a
 * self-asserted time dressed up as attestation.
 *
 * No eSign. ADR-0012's lane 1 is gated on ESP onboarding. It lands as a
 * second fulfilment of the digest-to-signature step and touches nothing
 * else in this file — an ESP returns a whole PKCS#7 rather than a raw
 * signature, so it substitutes for `assembleSignedData`, not for the
 * preparation or the embedding.
 */

import type { X509Certificate } from 'node:crypto';
import {
  assembleSignedData,
  buildSignedAttributes,
  type SignedAttributes,
} from './pdf-signing/cms-build.js';
import { CONTENTS_HEX_RESERVATION } from './pdf-signing/pdf-revision.js';
import {
  embedSignature,
  prepareSignedRevision,
  sha256Hex,
  type PrepareRevisionOptions,
  type PreparedRevision,
} from './pdf-signing/pdf-revision.js';

export {
  CONTENTS_HEX_RESERVATION,
  PdfRevisionError,
  sha256Hex,
} from './pdf-signing/pdf-revision.js';
/** The DER encoder, published because the signed-PDF FIXTURE BUILDER in
 * `apps/server/test/helpers/signed-pdf.ts` needs the same one — it mints
 * whole certificates, which this package has no production reason to do,
 * and two encoders emitting almost-identical bytes is how a fixture ends
 * up proving something the product does not do. */
export { algorithmIdentifier, der, tlv } from './pdf-signing/der.js';

export interface PreparePdfSignatureOptions extends PrepareRevisionOptions {
  /** The signer's certificate first, then every issuer up to the root the
   * deployment trusts. The whole chain travels inside the CMS: this
   * product's verifier builds paths offline, with no AIA chasing and no
   * egress, so a chain that is not in the blob is a chain nothing can
   * check. */
  readonly certificateChain: readonly X509Certificate[];
}

export interface PreparedPdfSignature {
  /** SHA-256 of the SOURCE document, before the revision was appended.
   * The request's identity, and what an operator is shown. */
  readonly sourceSha256: string;
  /** What the token signs: `sha256(signedAttrs)`, 32 bytes. The only
   * thing that leaves the server. */
  readonly digest: Buffer;
  readonly revision: PreparedRevision;
  readonly signedAttributes: SignedAttributes;
  readonly certificateChain: readonly X509Certificate[];
}

/** Everything up to the point where a private key is needed. */
export function prepareDetachedPdfSignature(
  source: Buffer,
  options: PreparePdfSignatureOptions,
): PreparedPdfSignature {
  const [signerCertificate] = options.certificateChain;
  if (signerCertificate === undefined) {
    throw new Error('a signing preparation needs the signing certificate');
  }
  const revision = prepareSignedRevision(source, options);
  const signedAttributes = buildSignedAttributes(
    revision.signedContent,
    signerCertificate,
  );
  return {
    sourceSha256: sha256Hex(source),
    digest: signedAttributes.digest,
    revision,
    signedAttributes,
    certificateChain: options.certificateChain,
  };
}

/** The token's answer, assembled and embedded. */
export function finishDetachedPdfSignature(
  preparation: PreparedPdfSignature,
  signature: Buffer,
): Buffer {
  return embedSignature(
    preparation.revision,
    assembleSignedData({
      certificateChain: preparation.certificateChain,
      signedAttributes: preparation.signedAttributes,
      signature,
    }),
  );
}

/**
 * The one operation the kiosk performs, as an interface.
 *
 * Narrow on purpose. In production the implementation is a Windows CNG
 * call against a certificate selected by thumbprint; in CI it is a
 * deterministic RSA key, because CI has no token and never will. Both sit
 * behind these two members, so the pipeline that matters — prepare, sign,
 * assemble, embed, verify — is exercised end to end by the tests rather
 * than mocked around.
 */
export interface DetachedDigestSigner {
  /** Signer certificate first, issuers after. */
  readonly certificateChain: readonly X509Certificate[];
  /** RSA PKCS#1 v1.5 over the SHA-256 DigestInfo of `digest`. This is
   * exactly `RSACng.SignHash(digest, HashAlgorithmName.SHA256,
   * RSASignaturePadding.Pkcs1)` on Windows, and exactly
   * `crypto.sign('sha256', signedAttrs, key)` given the attributes the
   * digest came from. */
  signDigest(digest: Buffer): Promise<Buffer>;
}

/** Prepare, sign and embed in one call, for a signer this process can
 * reach synchronously. The kiosk lane cannot use it — its two halves are
 * separated by a poll — but the real-token tool and every test can. */
export async function signPdfDetached(
  source: Buffer,
  signer: DetachedDigestSigner,
  options: PrepareRevisionOptions,
): Promise<Buffer> {
  const preparation = prepareDetachedPdfSignature(source, {
    ...options,
    certificateChain: signer.certificateChain,
  });
  return finishDetachedPdfSignature(
    preparation,
    await signer.signDigest(preparation.digest),
  );
}

/**
 * Whether a signature made with this chain will fit the `/Contents`
 * reservation, answered without a private key.
 *
 * The reservation is fixed (`CONTENTS_HEX_RESERVATION`) and so is
 * everything that fills it: the certificates, three signed attributes of
 * known shape, and an RSA signature exactly as long as the key's modulus.
 * So this is a rehearsal, not an estimate — it assembles the real blob
 * with a zero-filled signature of the right length and measures it.
 *
 * It exists because the alternative is finding out at the worst possible
 * moment. `finishDetachedPdfSignature` throws on an oversized blob, and by
 * then the token has already signed: the operator has typed their PIN, the
 * signature is real, and there is nowhere to put it. Asking the question
 * when the kiosk registers turns that into a refused registration.
 */
export function detachedSignatureFits(
  certificateChain: readonly X509Certificate[],
): boolean {
  const [signerCertificate] = certificateChain;
  if (signerCertificate === undefined) return false;
  const modulusBits =
    signerCertificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 2048;
  try {
    const rehearsal = assembleSignedData({
      certificateChain,
      // The content is irrelevant to the size: `messageDigest` is 32
      // bytes whatever it digests.
      signedAttributes: buildSignedAttributes(Buffer.alloc(0), signerCertificate),
      signature: Buffer.alloc(Math.ceil(modulusBits / 8)),
    });
    return rehearsal.length * 2 <= CONTENTS_HEX_RESERVATION;
  } catch {
    return false;
  }
}

/**
 * A certificate's Windows thumbprint: the SHA-1 of its DER encoding,
 * uppercase hex, no separators.
 *
 * SHA-1 not because it is a good hash — it is not — but because this is an
 * IDENTIFIER, not a security decision, and it is the identifier the
 * Windows certificate store, `certutil`, the MMC snap-in and every piece
 * of operator documentation in this deployment already use. Computing a
 * different one would mean an operator could not compare what the screen
 * says with what their certificate store says, which is the only thing the
 * value is for. The security decision that rests on the certificate is
 * made against the whole chain by `verifyPdfSignatures`.
 */
export function certificateThumbprint(certificate: X509Certificate): string {
  return certificate.fingerprint.replaceAll(':', '').toUpperCase();
}
