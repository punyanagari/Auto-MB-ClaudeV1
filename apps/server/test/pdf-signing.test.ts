import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, privateEncrypt, X509Certificate } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  certificateThumbprint,
  EMPTY_TRUST_ANCHOR_STORE,
  finishDetachedPdfSignature,
  loadTrustAnchors,
  PdfRevisionError,
  prepareDetachedPdfSignature,
  signPdfDetached,
  verifyPdfSignatures,
  type DetachedDigestSigner,
  type TrustAnchorStore,
} from '@auto-mb/documents';
import { createTestPki, unsignedPdf, type TestPki } from './helpers/signed-pdf.js';

/**
 * The kiosk signing pipeline, proved without a kiosk.
 *
 * CI has no USB token and never will, so the one operation the token
 * performs — RSA PKCS#1 v1.5 over a SHA-256 digest — sits behind
 * `DetachedDigestSigner` and is fulfilled here by a deterministic key from
 * the same three-level test PKI the verifier suite uses. Everything else
 * in the path is the production code: the PDF revision, the ByteRange, the
 * CMS assembly, the embedding, and the 0060 verifier reading the result.
 *
 * The real-token half is `tools/kiosk-signing-check.ps1`, which the owner
 * runs at the kiosk. It exercises this same pipeline with the CNG signer
 * in place of the double, and it cannot run here: the token's PIN dialog
 * only reaches an interactive desktop.
 *
 * WHY THE VERDICT ASSERTION IS THE TEST. `signed_and_intact` is the one
 * verdict that requires every part to be right at once — the ByteRange
 * must cover exactly the bytes the digest was taken over, the CMS must
 * parse, the signature must verify under the certificate's public key, the
 * `signing-certificate-v2` attribute must hash to that same certificate,
 * the chain must reach a configured anchor, and nothing may follow the
 * signature. A pipeline that got any one of them wrong reports one of the
 * other seven statuses and fails here.
 */

/** Pinned so a verdict cannot change meaning as the clock moves past the
 * fixture certificates' validity window. */
const AT = new Date('2026-06-01T00:00:00Z');
const SIGNING_TIME = "D:20260601120000+05'30'";

const OPTIONS = {
  signerName: 'A K SHARMA',
  reason: 'Issued by the contractor',
  location: 'Nagpur',
  claimedSigningTime: SIGNING_TIME,
} as const;

let workspace: string;
let pki: TestPki;
let anchors: TrustAnchorStore;
let noAnchors: TrustAnchorStore;

/**
 * The test double: the same mathematics Windows CNG performs, with a key
 * `node:crypto` generated instead of one a token holds.
 *
 * `RSACng.SignHash(hash, SHA256, Pkcs1)` takes a HASH, not a message: it
 * wraps the 32 bytes in a DigestInfo, pads to the modulus and raises to
 * the private exponent. The Node spelling of exactly that is
 * `privateEncrypt` with PKCS#1 padding over the DigestInfo — NOT
 * `sign('sha256', digest, key)`, which would hash the hash, and not
 * `sign(null, digestInfo, key)`, which is a different padding path
 * altogether (both were tried; both produce a signature the verifier
 * rejects, which is the pipeline's own proof that the double is honest).
 */
function doubleSigner(hierarchy: TestPki): DetachedDigestSigner {
  return {
    certificateChain: [
      new X509Certificate(hierarchy.signer.der),
      new X509Certificate(hierarchy.intermediate.der),
      new X509Certificate(hierarchy.root.der),
    ],
    signDigest(digest) {
      return Promise.resolve(
        privateEncrypt(
          { key: hierarchy.signer.privateKey, padding: constants.RSA_PKCS1_PADDING },
          digestInfo(digest),
        ),
      );
    },
  };
}

/**
 * `DigestInfo ::= SEQUENCE { AlgorithmIdentifier(id-sha256, NULL),
 *                            OCTET STRING digest }`
 *
 * The 19-byte SHA-256 prefix, written as the constant every PKCS#1 v1.5
 * implementation carries rather than re-derived from a DER encoder — this
 * is a test double standing in for a Windows API, and the value it must
 * reproduce is a fixed one.
 */
function digestInfo(digest: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from('3031300d060960864801650304020105000420', 'hex'),
    digest,
  ]);
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-signing-'));
  pki = createTestPki({
    signerCommonName: 'A K SHARMA',
    signerOrganisation: 'PUNYA NAGARI ENTERPRISES',
  });
  const anchorDirectory = path.join(workspace, 'anchors');
  await mkdir(anchorDirectory, { recursive: true });
  await writeFile(path.join(anchorDirectory, 'test-root.pem'), pki.root.pem);
  anchors = await loadTrustAnchors(anchorDirectory);
  // `loadTrustAnchors` refuses an empty directory rather than answering
  // "no anchors", so an unconfigured deployment is the shape this uses:
  // no path at all.
  noAnchors = EMPTY_TRUST_ANCHOR_STORE;
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('the kiosk signing pipeline', () => {
  it('produces a document its own verifier reads as signed_and_intact', async () => {
    const signer = doubleSigner(pki);
    const signed = await signPdfDetached(
      unsignedPdf('Delivery challan'),
      signer,
      OPTIONS,
    );

    const verdict = verifyPdfSignatures(signed, { trustAnchors: anchors, now: AT });
    expect(verdict.status).toBe('signed_and_intact');
    expect(verdict.signatureCount).toBe(1);
    const [signature] = verdict.signatures;
    expect(signature?.integrity).toBe('intact');
    expect(signature?.coverage.coversWholeDocument).toBe(true);
    expect(signature?.coverage.unsignedBytesAfter).toBe(0);
    // PAdES requires the signing-certificate attribute, and the verifier
    // treats its absence in an ETSI.CAdES.detached signature as a defect.
    expect(signature?.subFilter).toBe('ETSI.CAdES.detached');
    expect(signature?.signingCertificateBinding).toBe('matches');
    expect(signature?.chain.status).toBe('trusted');
    expect(signature?.signer.commonName).toBe('A K SHARMA');
    expect(signature?.signer.organisation).toBe('PUNYA NAGARI ENTERPRISES');
    // The `/Name` entry is what the producing application CLAIMED, kept
    // beside the certificate subject rather than merged into it.
    expect(signature?.signer.declaredName).toBe('A K SHARMA');
  });

  it('wires the signature into an AcroForm so a reader other than ours can find it', async () => {
    const signed = (
      await signPdfDetached(unsignedPdf(), doubleSigner(pki), OPTIONS)
    ).toString('latin1');
    // Without these three the signature is a blob only a ByteRange scan
    // finds: Adobe lists what the AcroForm names, and draws what the page
    // annotates.
    expect(signed).toContain('/AcroForm << /Fields [');
    expect(signed).toContain('/SigFlags 3');
    expect(signed).toContain('/Subtype /Widget /FT /Sig');
    expect(signed).toContain('/Annots [');
    // The original revision survives byte for byte, which is what makes
    // the signature checkable against the document it was computed over.
    expect(signed.startsWith(unsignedPdf().toString('latin1'))).toBe(true);
    // …and the update is a real incremental one, chained to what it
    // followed rather than replacing it.
    expect(signed).toMatch(/\/Prev \d+ >>\s*startxref/);
  });

  it('is deterministic, which is what lets the queue re-derive the digest', () => {
    const source = unsignedPdf('Tax invoice');
    const chain = [
      new X509Certificate(pki.signer.der),
      new X509Certificate(pki.intermediate.der),
    ];
    const first = prepareDetachedPdfSignature(source, {
      ...OPTIONS,
      certificateChain: chain,
    });
    const second = prepareDetachedPdfSignature(source, {
      ...OPTIONS,
      certificateChain: chain,
    });
    expect(second.digest.toString('hex')).toBe(first.digest.toString('hex'));
    expect(second.sourceSha256).toBe(first.sourceSha256);
    expect(second.revision.draft.equals(first.revision.draft)).toBe(true);
  });

  it('derives a different digest for a document that changed by one byte', () => {
    const chain = [new X509Certificate(pki.signer.der)];
    const before = prepareDetachedPdfSignature(unsignedPdf('Challan A'), {
      ...OPTIONS,
      certificateChain: chain,
    });
    const after = prepareDetachedPdfSignature(unsignedPdf('Challan B'), {
      ...OPTIONS,
      certificateChain: chain,
    });
    // Both halves of the route's binding check move together, which is
    // why it can tell "the document was re-rendered" from "something else
    // is wrong".
    expect(after.sourceSha256).not.toBe(before.sourceSha256);
    expect(after.digest.toString('hex')).not.toBe(before.digest.toString('hex'));
  });

  it('refuses a signature made over a different document', async () => {
    // The attack the digest binding exists to stop, from the kiosk's side:
    // a token that signs the digest of document A while the server is
    // assembling document B.
    const signer = doubleSigner(pki);
    const target = prepareDetachedPdfSignature(unsignedPdf('The real challan'), {
      ...OPTIONS,
      certificateChain: signer.certificateChain,
    });
    const other = prepareDetachedPdfSignature(unsignedPdf('A different challan'), {
      ...OPTIONS,
      certificateChain: signer.certificateChain,
    });
    const wrongSignature = await signer.signDigest(other.digest);

    const forged = finishDetachedPdfSignature(target, wrongSignature);
    const verdict = verifyPdfSignatures(forged, { trustAnchors: anchors, now: AT });
    expect(verdict.status).toBe('signature_invalid');
  });

  it('reports an untrusted chain rather than passing it, when the anchor is missing', async () => {
    // The deployment precondition, made visible: without the CCA India
    // root installed the server cannot confirm its own signature, and the
    // route refuses to store bytes whose verdict is not signed_and_intact.
    const signed = await signPdfDetached(unsignedPdf(), doubleSigner(pki), OPTIONS);
    const verdict = verifyPdfSignatures(signed, { trustAnchors: noAnchors, now: AT });
    expect(verdict.status).toBe('signed_chain_not_checked');
  });

  it('exposes the certificate by its Windows thumbprint', () => {
    const certificate = new X509Certificate(pki.signer.der);
    const thumbprint = certificateThumbprint(certificate);
    expect(thumbprint).toMatch(/^[0-9A-F]{40}$/);
    expect(thumbprint).toBe(certificate.fingerprint.replaceAll(':', '').toUpperCase());
  });

  it('refuses a PDF whose structure it cannot append to, rather than guessing', () => {
    const chain = [new X509Certificate(pki.signer.der)];
    const prepareOn =
      (pdf: Buffer): (() => unknown) =>
      () =>
        prepareDetachedPdfSignature(pdf, { ...OPTIONS, certificateChain: chain });

    // No classic trailer: a cross-reference stream, which this signer
    // does not write.
    expect(prepareOn(Buffer.from('%PDF-1.7\nstartxref\n9\n%%EOF\n', 'latin1'))).toThrow(
      PdfRevisionError,
    );
    // Encrypted: an update appended to it would be unreadable.
    const encrypted = Buffer.from(
      unsignedPdf()
        .toString('latin1')
        .replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'),
      'latin1',
    );
    expect(prepareOn(encrypted)).toThrow(/encrypted/);
    // Already a form: merging into an existing AcroForm is not something
    // this signer does, and silently adding a second one would produce a
    // file whose fields disagree.
    const withForm = Buffer.from(
      unsignedPdf()
        .toString('latin1')
        .replace('/Type /Catalog', '/Type /Catalog /AcroForm << /Fields [] >>'),
      'latin1',
    );
    expect(prepareOn(withForm)).toThrow(/interactive form/);
  });

  it('refuses a CMS blob larger than the /Contents reservation', () => {
    const preparation = prepareDetachedPdfSignature(unsignedPdf(), {
      ...OPTIONS,
      certificateChain: [new X509Certificate(pki.signer.der)],
    });
    // 8193 octets is one past what 16384 hex characters can hold. Refused
    // rather than truncated: a truncated signature is a corrupt document
    // that still looks signed.
    expect(() =>
      finishDetachedPdfSignature(
        { ...preparation, certificateChain: preparation.certificateChain },
        Buffer.alloc(8193),
      ),
    ).toThrow(/does not fit/);
  });
});
