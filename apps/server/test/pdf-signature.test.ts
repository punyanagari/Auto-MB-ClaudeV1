import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PdfSignatureReportSchema } from '@auto-mb/contracts';
import { Value } from '@sinclair/typebox/value';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadTrustAnchors,
  verifyPdfSignatures,
  TrustAnchorConfigurationError,
  type TrustAnchorStore,
} from '../src/pdf-signature.js';
import {
  appendSignature,
  createTestPki,
  unsignedPdf,
  type TestPki,
} from './helpers/signed-pdf.js';

/** Pinned so a verdict cannot change meaning as the clock moves past a
 * fixture certificate's validity window. */
const AT = new Date('2026-06-01T00:00:00Z');

let workspace: string;
let pki: TestPki;
let otherPki: TestPki;
let anchors: TrustAnchorStore;
let noAnchors: TrustAnchorStore;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-sig-'));
  pki = createTestPki({ signerCommonName: 'A K SHARMA', signerOrganisation: 'WESTERN RAILWAY' });
  otherPki = createTestPki({ rootCommonName: 'Unrecognised Root' });
  const anchorDir = path.join(workspace, 'anchors');
  await mkdir(anchorDir, { recursive: true });
  await writeFile(path.join(anchorDir, 'test-root.pem'), pki.root.pem);
  anchors = await loadTrustAnchors(anchorDir);
  noAnchors = await loadTrustAnchors(undefined);
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('unsigned documents', () => {
  it('reports a PDF with no signature dictionary as unsigned', () => {
    const report = verifyPdfSignatures(unsignedPdf(), { trustAnchors: anchors, now: AT });
    expect(report.status).toBe('unsigned');
    expect(report.signatureCount).toBe(0);
    expect(report.signatures).toEqual([]);
    expect(report.unsignedTrailingBytes).toBe(0);
  });

  it('reports a scanned or printed copy of a signed document as unsigned', () => {
    // The real motivation for this case. Two documents in the owner's own
    // sample set render a green "Signature valid" tick on every page and
    // carry no cryptographic signature at all, because they were printed
    // to PDF from a viewer: the ticks are pixels in a page image. A
    // verifier that looked for reassuring artwork would call these
    // verified; this one calls them unsigned, which is what they are.
    const printed = unsignedPdf('Signature valid - digitally signed by A K SHARMA');
    const report = verifyPdfSignatures(printed, { trustAnchors: anchors, now: AT });
    expect(report.status).toBe('unsigned');
  });
});

describe('a signature that verifies against a configured anchor', () => {
  it('reports signed_and_intact with the signer read from the certificate', () => {
    const signed = appendSignature(unsignedPdf(), {
      pki,
      reason: 'Variation Signing By SSE/Tele',
      location: 'Mumbai Central',
    });
    const report = verifyPdfSignatures(signed, { trustAnchors: anchors, now: AT });

    expect(report.status).toBe('signed_and_intact');
    expect(report.signatures).toHaveLength(1);
    const [signature] = report.signatures;
    expect(signature?.integrity).toBe('intact');
    expect(signature?.signer.commonName).toBe('A K SHARMA');
    expect(signature?.signer.organisation).toBe('WESTERN RAILWAY');
    expect(signature?.reason).toBe('Variation Signing By SSE/Tele');
    expect(signature?.location).toBe('Mumbai Central');
    expect(signature?.chain.status).toBe('trusted');
    expect(signature?.chain.reachesConfiguredAnchor).toBe(true);
    expect(signature?.chain.anchorSubject).toContain('Test Root of India');
    // Root, licensed CA, signer.
    expect(signature?.chain.path).toHaveLength(3);
    expect(signature?.coverage.coversWholeDocument).toBe(true);
    expect(signature?.coverage.unsignedBytesAfter).toBe(0);
  });

  it('verifies the deprecated adbe.pkcs7.sha1 shape the railway corpus uses', () => {
    // No signed attributes at all, and the signature covers an
    // ENCAPSULATED SHA-1 digest rather than the document bytes. Both links
    // have to be checked: that the encapsulated digest is this document's,
    // and that the signature covers that digest.
    const signed = appendSignature(unsignedPdf(), { pki, shape: 'adbe.pkcs7.sha1' });
    const report = verifyPdfSignatures(signed, { trustAnchors: anchors, now: AT });

    expect(report.status).toBe('signed_and_intact');
    const [signature] = report.signatures;
    expect(signature?.subFilter).toBe('adbe.pkcs7.sha1');
    expect(signature?.integrity).toBe('intact');
    // SHA-1 is accepted because the whole corpus needs it, and disclosed
    // because its collision resistance is gone.
    expect(signature?.digestAlgorithm).toBe('sha1');
    expect(signature?.weakDigest).toBe(true);
  });

  it('reads every signature of a countersigned document', () => {
    const first = appendSignature(unsignedPdf(), { pki, signerName: 'FIRST' });
    const second = appendSignature(first, { pki, signerName: 'SECOND' });
    const third = appendSignature(second, { pki, signerName: 'THIRD' });
    const report = verifyPdfSignatures(third, { trustAnchors: anchors, now: AT });

    expect(report.status).toBe('signed_and_intact');
    expect(report.signatures).toHaveLength(3);
    expect(report.signatures.map((entry) => entry.integrity)).toEqual([
      'intact',
      'intact',
      'intact',
    ]);
    // The decisive property of a countersigned document: the earlier
    // signatures do NOT cover the whole file, and that is normal rather
    // than tampering, because the bytes that follow each of them are
    // covered by a later signature that verified.
    expect(report.signatures[0]?.coverage.coversWholeDocument).toBe(false);
    expect(report.signatures[0]?.coverage.revisionsAfter).toBe(2);
    expect(report.signatures[0]?.coverage.trailingBytesCoveredByLaterSignature).toBe(
      true,
    );
    expect(report.signatures[2]?.coverage.coversWholeDocument).toBe(true);
    expect(report.unsignedTrailingBytes).toBe(0);
  });
});

describe('a document modified after it was signed', () => {
  it('detects bytes appended after the last signature', () => {
    const signed = appendSignature(unsignedPdf(), { pki });
    const tampered = Buffer.concat([
      signed,
      Buffer.from('\n% appended after signing\n', 'latin1'),
    ]);
    const report = verifyPdfSignatures(tampered, { trustAnchors: anchors, now: AT });

    expect(report.status).toBe('signed_but_modified_after_signing');
    expect(report.unsignedTrailingBytes).toBe(26);
    const [signature] = report.signatures;
    // The signature ITSELF is still perfectly good — the bytes it covers
    // are unchanged. Reporting it as invalid would be wrong and would
    // teach a reviewer to distrust the wrong thing. What changed is the
    // document, and coverage is where that shows.
    expect(signature?.integrity).toBe('intact');
    expect(signature?.coverage.coversWholeDocument).toBe(false);
    expect(signature?.coverage.trailingBytesCoveredByLaterSignature).toBe(false);
  });

  it('detects an edit INSIDE the bytes a signature covers', () => {
    const signed = appendSignature(unsignedPdf('Variation statement'), { pki });
    const edited = Buffer.from(signed);
    const target = edited.indexOf(Buffer.from('Variation statement', 'latin1'));
    expect(target).toBeGreaterThan(0);
    edited.write('Variation statemenX', target, 'latin1');

    const report = verifyPdfSignatures(edited, { trustAnchors: anchors, now: AT });
    expect(report.status).toBe('signed_but_modified_after_signing');
    expect(report.signatures[0]?.integrity).toBe('digest_mismatch');
  });

  it('reports a signature that does not verify under its own certificate', () => {
    const signed = appendSignature(unsignedPdf(), { pki, corruptSignature: true });
    const report = verifyPdfSignatures(signed, { trustAnchors: anchors, now: AT });

    // Distinct from a modified document: the bytes are exactly what the
    // ByteRange says, but the mathematics fails.
    expect(report.status).toBe('signature_invalid');
    expect(report.signatures[0]?.integrity).toBe('signature_invalid');
    expect(report.signatures[0]?.integrityDetail).toContain('does not verify');
  });
});

describe('chains that cannot be trusted', () => {
  it('refuses a chain whose root the operator has not installed', () => {
    const signed = appendSignature(unsignedPdf(), { pki: otherPki });
    const report = verifyPdfSignatures(signed, { trustAnchors: anchors, now: AT });

    expect(report.status).toBe('signed_but_untrusted_chain');
    const [signature] = report.signatures;
    expect(signature?.integrity).toBe('intact');
    expect(signature?.chain.status).toBe('untrusted');
    expect(signature?.chain.reason).toBe('no_path_to_configured_anchor');
    expect(signature?.chain.reachesConfiguredAnchor).toBe(false);
  });

  it('never terminates a path on a root the document brought with it', () => {
    // Every signature in the corpus ships its own self-signed root inside
    // the CMS. Accepting it because it is present and self-signed would
    // make every forgery self-certifying, so the ONLY difference between
    // this case and the trusted one is which anchors the operator has.
    const signed = appendSignature(unsignedPdf(), { pki: otherPki });
    expect(
      verifyPdfSignatures(signed, { trustAnchors: anchors, now: AT }).signatures[0]?.chain
        .status,
    ).toBe('untrusted');

    const trusting = { anchors: [{ certificate: null }] };
    void trusting;
  });

  it('separates "no anchors installed" from "chain is bad"', () => {
    const signed = appendSignature(unsignedPdf(), { pki });
    const report = verifyPdfSignatures(signed, { trustAnchors: noAnchors, now: AT });

    // An operator who has installed nothing must not be told the
    // document's chain is untrustworthy, and must not be shown green.
    expect(report.status).toBe('signed_chain_not_checked');
    expect(report.signatures[0]?.chain.status).toBe('not_checked');
    expect(report.signatures[0]?.chain.reason).toBe('no_trust_anchors_configured');
    expect(report.trustAnchors.configured).toBe(false);
  });

  it('separates an expired certificate from an unknown issuer', () => {
    const expiredPki = createTestPki({
      notBefore: new Date('2020-01-01T00:00:00Z'),
      notAfter: new Date('2022-01-01T00:00:00Z'),
    });
    const anchorDirPromise = (async () => {
      const directory = path.join(workspace, 'expired-anchors');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'root.pem'), expiredPki.root.pem);
      return loadTrustAnchors(directory);
    })();

    return anchorDirPromise.then((expiredAnchors) => {
      const signed = appendSignature(unsignedPdf(), {
        pki: expiredPki,
        signingTime: "D:20210601120000+05'30'",
      });
      const report = verifyPdfSignatures(signed, {
        trustAnchors: expiredAnchors,
        now: AT,
      });

      expect(report.status).toBe('signed_chain_expired');
      const [signature] = report.signatures;
      expect(signature?.integrity).toBe('intact');
      expect(signature?.chain.reachesConfiguredAnchor).toBe(true);
      expect(signature?.chain.reason).toBe('certificate_expired');
      expect(signature?.chain.validAtVerificationTime).toBe(false);
      // The claimed time is reported as a claim, and cannot promote the
      // chain to trusted on its own.
      expect(signature?.chain.validAtClaimedSigningTime).toBe(true);
      expect(signature?.chain.status).toBe('untrusted');
    });
  });
});

describe('signatures that cannot be read', () => {
  it('reports an unreadable signature blob distinctly from an invalid one', () => {
    const signed = appendSignature(unsignedPdf(), { pki });
    const broken = Buffer.from(signed);
    // Corrupt the DER header of the CMS blob rather than the signature
    // value, so the structure cannot be parsed at all.
    const contentsAt = broken.indexOf(Buffer.from('/Contents <', 'latin1'));
    broken.write('ffffffff', contentsAt + 11, 'latin1');

    const report = verifyPdfSignatures(broken, { trustAnchors: anchors, now: AT });
    expect(report.status).toBe('signature_unverifiable');
    const [signature] = report.signatures;
    expect(signature?.integrity).toBe('unverifiable');
    expect(signature?.integrityDetail).toContain('could not be read');
    // Crucially still counted as a signature: a document holding one is
    // never reported as unsigned.
    expect(report.signatureCount).toBe(1);
  });

  it('rejects a ByteRange that does not describe its own /Contents string', () => {
    // The signature-wrapping check. Widening the range so it no longer
    // matches the /Contents string is how an attacker gets a verifier to
    // digest bytes the signer never saw.
    const signed = appendSignature(unsignedPdf(), { pki });
    const text = signed.toString('latin1');
    const match = /\/ByteRange \[0 (\d+) (\d+) (\d+)/.exec(text);
    expect(match).not.toBeNull();
    const widened = text.replace(
      `/ByteRange [0 ${match?.[1] ?? ''}`,
      `/ByteRange [0 ${String(Number(match?.[1] ?? 0) - 4)}`,
    );
    const report = verifyPdfSignatures(Buffer.from(widened, 'latin1'), {
      trustAnchors: anchors,
      now: AT,
    });

    expect(report.status).toBe('signature_unverifiable');
    expect(report.signatures).toHaveLength(0);
    expect(report.unreadableSignatures).toHaveLength(1);
    expect(report.unreadableSignatures[0]?.reason).toContain(
      'does not describe this signature',
    );
  });

  it('ignores a decoy /ByteRange in page content', () => {
    const decoy = unsignedPdf('/ByteRange [0 10 20 30] /Contents <deadbeef>');
    const report = verifyPdfSignatures(decoy, { trustAnchors: anchors, now: AT });
    // Present but unreadable, never silently dropped and never verified.
    expect(report.status).toBe('signature_unverifiable');
    expect(report.signatures).toHaveLength(0);
    expect(report.unreadableSignatures).toHaveLength(1);
  });
});

describe('what the verdict says about itself', () => {
  it('reports revocation as not checked, with the reason', () => {
    const signed = appendSignature(unsignedPdf(), { pki });
    const [signature] = verifyPdfSignatures(signed, {
      trustAnchors: anchors,
      now: AT,
    }).signatures;
    // Never "good". Revocation needs egress this deployment does not
    // assume, and a verifier that reported an unchecked thing as fine
    // would be manufacturing confidence.
    expect(signature?.revocation.status).toBe('not_checked');
    expect(signature?.revocation.reason).toBe('network_egress_not_available');
    expect(signature?.revocation.embeddedRevocationData).toBe(false);
  });

  it('reports an untimestamped signing time as a claim', () => {
    const signed = appendSignature(unsignedPdf(), {
      pki,
      signingTime: "D:20250211093015+05'30'",
    });
    const [signature] = verifyPdfSignatures(signed, {
      trustAnchors: anchors,
      now: AT,
    }).signatures;
    expect(signature?.claimedSigningTime).toBe('2025-02-11T04:00:15.000Z');
    expect(signature?.claimedSigningTimeSource).toBe('signature_dictionary');
    expect(signature?.timestamp.present).toBe(false);
    expect(signature?.timestamp.status).toBe('absent');
  });

  it('records which rule set produced it', () => {
    const report = verifyPdfSignatures(appendSignature(unsignedPdf(), { pki }), {
      trustAnchors: anchors,
      now: AT,
    });
    expect(report.verifierVersion).toBe('1');
    expect(report.verifiedAt).toBe(AT.toISOString());
  });
});

describe('the verdict shape', () => {
  it('matches the transported contract for every outcome', () => {
    const signed = appendSignature(unsignedPdf(), { pki });
    const cases = [
      verifyPdfSignatures(unsignedPdf(), { trustAnchors: anchors, now: AT }),
      verifyPdfSignatures(signed, { trustAnchors: anchors, now: AT }),
      verifyPdfSignatures(signed, { trustAnchors: noAnchors, now: AT }),
      verifyPdfSignatures(appendSignature(unsignedPdf(), { pki: otherPki }), {
        trustAnchors: anchors,
        now: AT,
      }),
      verifyPdfSignatures(Buffer.concat([signed, Buffer.from('x')]), {
        trustAnchors: anchors,
        now: AT,
      }),
      verifyPdfSignatures(
        appendSignature(unsignedPdf(), { pki, corruptSignature: true }),
        { trustAnchors: anchors, now: AT },
      ),
    ];
    for (const report of cases) {
      const errors = [...Value.Errors(PdfSignatureReportSchema, report)];
      expect(
        errors.map((error) => `${error.path}: ${error.message}`),
        `report ${report.status} does not match the contract`,
      ).toEqual([]);
      // The whole verdict has to survive a round trip through jsonb: it is
      // stored, exported, and read back as evidence.
      expect(
        Value.Check(PdfSignatureReportSchema, JSON.parse(JSON.stringify(report))),
      ).toBe(true);
    }
  });

  it('never reports a green status without a trusted chain', () => {
    const green = verifyPdfSignatures(appendSignature(unsignedPdf(), { pki }), {
      trustAnchors: anchors,
      now: AT,
    });
    expect(green.status).toBe('signed_and_intact');
    expect(green.signatures.every((entry) => entry.chain.status === 'trusted')).toBe(true);
    expect(green.signatures.every((entry) => entry.integrity === 'intact')).toBe(true);
    expect(green.unsignedTrailingBytes).toBe(0);
  });
});

describe('trust anchor configuration', () => {
  it('refuses a configured path that holds no certificates', async () => {
    const empty = path.join(workspace, 'empty-anchors');
    await mkdir(empty, { recursive: true });
    await expect(loadTrustAnchors(empty)).rejects.toBeInstanceOf(
      TrustAnchorConfigurationError,
    );
  });

  it('refuses a configured path that does not exist', async () => {
    await expect(
      loadTrustAnchors(path.join(workspace, 'nothing-here')),
    ).rejects.toBeInstanceOf(TrustAnchorConfigurationError);
  });

  it('loads intermediates without letting them end a path', async () => {
    // A signer whose CMS embeds no chain: the operator's intermediate has
    // to complete the path, and installing it must not make it an anchor.
    const directory = path.join(workspace, 'intermediates-only');
    await mkdir(path.join(directory, 'intermediates'), { recursive: true });
    await writeFile(
      path.join(directory, 'intermediates', 'ca.pem'),
      pki.intermediate.pem,
    );
    await writeFile(path.join(directory, 'other-root.pem'), otherPki.root.pem);
    const store = await loadTrustAnchors(directory);
    expect(store.anchors).toHaveLength(1);
    expect(store.intermediates).toHaveLength(1);

    const signed = appendSignature(unsignedPdf(), { pki });
    const report = verifyPdfSignatures(signed, { trustAnchors: store, now: AT });
    // The intermediate completed nothing that reaches an installed root,
    // so the chain stays untrusted rather than being accepted because a
    // CA certificate happened to be on disk.
    expect(report.status).toBe('signed_but_untrusted_chain');
    expect(report.signatures[0]?.chain.reachesConfiguredAnchor).toBe(false);
  });
});
