import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PDF_SIGNATURE_DOCUMENT_STATUSES,
  type PdfSignatureReport,
  type PdfSignatureVerdict,
  type StoredPdfSignatureStatus,
} from '@auto-mb/contracts';
import { assessRailwayBillVerdict } from '../src/railway-bill-verdict.js';

/**
 * The owner's 2026-08-13 gating rulings, as a table.
 *
 * The end-to-end proof is `received-railway-bills.integration.test.ts`,
 * which signs real PDFs with real certificates and pushes them through the
 * route. What this file adds is exhaustiveness: every document status the
 * verifier can produce is named here with the answer it gets, so a new
 * status added to the vocabulary cannot quietly default to "settleable".
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'railway-settlement');

function signature(overrides: Partial<PdfSignatureVerdict> = {}): PdfSignatureVerdict {
  return {
    index: 1,
    subFilter: 'adbe.pkcs7.sha1',
    filter: 'Adobe.PPKLite',
    signer: {
      commonName: 'RAILWAY SR DSTE',
      organisation: 'CENTRAL RAILWAY',
      organisationalUnit: null,
      subject: null,
      issuerCommonName: 'SafeScrypt sub-CA for Class 3 Organization 2022',
      certificateSerialNumber: null,
      declaredName: null,
    },
    claimedSigningTime: '2026-05-14T08:23:36.000Z',
    claimedSigningTimeSource: 'signature_dictionary',
    timestamp: {
      present: false,
      time: null,
      status: 'absent',
      reason: 'no timestamp token',
      authoritySubject: null,
    },
    reason: 'Bill Signing by SRDSTECO/BB',
    location: null,
    contactInfo: null,
    integrity: 'intact',
    integrityDetail: null,
    digestAlgorithm: 'sha1',
    weakDigest: true,
    signingCertificateBinding: 'absent',
    chain: {
      status: 'trusted',
      reason: 'reached configured anchor',
      reachesConfiguredAnchor: true,
      anchorSubject: 'CN=CCA India 2022',
      // path[0] is the SIGNING certificate, and its issuer + serial is
      // the identity the distinct-signer rule compares on. The default
      // here is signature 1's; `signature({ index })` re-derives it so
      // three synthetic signatures are three certificates unless a test
      // deliberately makes them one.
      path: [
        {
          subject: 'CN=RAILWAY SR DSTE',
          issuer: 'CN=SafeScrypt sub-CA for Class 3 Organization 2022',
          serialNumber: '01',
          validFrom: '2024-01-01T00:00:00Z',
          validTo: '2034-01-01T00:00:00Z',
          isCertificateAuthority: false,
        },
      ],
      validAtVerificationTime: true,
      validAtClaimedSigningTime: true,
    },
    revocation: {
      status: 'not_checked',
      reason: 'network_egress_not_available',
      embeddedRevocationData: false,
    },
    coverage: {
      coversWholeDocument: true,
      signedByteCount: 100,
      unsignedBytesAfter: 0,
      revisionsAfter: 0,
      trailingBytesCoveredByLaterSignature: false,
    },
    certification: { docMdp: false, permissions: null },
    ...overrides,
  };
}

/** One signature per index, each from its own certificate. */
function distinctSignature(index: number): PdfSignatureVerdict {
  const base = signature({ index });
  return {
    ...base,
    chain: {
      ...base.chain,
      path: [
        {
          subject: `CN=SIGNATORY ${String(index)}`,
          issuer: `CN=Licensed CA ${String(index)}`,
          serialNumber: `0${String(index)}`,
          validFrom: '2024-01-01T00:00:00Z',
          validTo: '2034-01-01T00:00:00Z',
          isCertificateAuthority: false,
        },
      ],
    },
  };
}

function report(
  signatures: readonly PdfSignatureVerdict[],
  status: StoredPdfSignatureStatus,
): PdfSignatureReport {
  return {
    status: status === 'not_checked' ? 'unsigned' : status,
    signatureCount: signatures.length,
    signatures: [...signatures],
    unreadableSignatures: [],
    fileLength: 1000,
    unsignedTrailingBytes: 0,
    trustAnchors: { configured: true, count: 3, source: '/anchors' },
    verifiedAt: '2026-08-14T00:00:00.000Z',
    verifierVersion: '1',
  };
}

/** Three signatures in the shape a countersigned bill actually has. */
function threeSignatures(): PdfSignatureVerdict[] {
  return [
    {
      ...distinctSignature(1),
      coverage: {
        coversWholeDocument: false,
        signedByteCount: 60,
        unsignedBytesAfter: 40,
        revisionsAfter: 2,
        trailingBytesCoveredByLaterSignature: true,
      },
    },
    {
      ...distinctSignature(2),
      coverage: {
        coversWholeDocument: false,
        signedByteCount: 80,
        unsignedBytesAfter: 20,
        revisionsAfter: 1,
        trailingBytesCoveredByLaterSignature: true,
      },
    },
    distinctSignature(3),
  ];
}

describe('whether a railway bill may settle money', () => {
  it('accepts three intact signatures that chain to an anchor', () => {
    const assessment = assessRailwayBillVerdict(
      'signed_and_intact',
      report(threeSignatures(), 'signed_and_intact'),
    );
    expect(assessment.acceptable).toBe(true);
    expect(assessment.refusal).toBeNull();
  });

  it('IGNORES certificate expiry, per the ruling', () => {
    // The verifier says the chain reached a configured anchor and that a
    // certificate in it is outside its validity window. Indian DSC signing
    // certificates run two to three years and none of these bills carries
    // a timestamp, so treating expiry as fatal would eventually refuse
    // every bill the agency holds — for no change in any document.
    const expired = threeSignatures().map((entry) => ({
      ...entry,
      chain: {
        ...entry.chain,
        status: 'untrusted' as const,
        reason: 'certificate_expired',
        reachesConfiguredAnchor: true,
        validAtVerificationTime: false,
        validAtClaimedSigningTime: true,
      },
    }));
    const assessment = assessRailwayBillVerdict(
      'signed_chain_expired',
      report(expired, 'signed_chain_expired'),
    );
    expect(assessment.acceptable).toBe(true);
  });

  it('names an answer for EVERY status the verifier can produce', () => {
    // Exhaustive over the contract's own vocabulary, so a status added
    // later has to be classified here rather than falling through.
    const settleable = new Set(['signed_and_intact', 'signed_chain_expired']);
    const statuses: readonly StoredPdfSignatureStatus[] = [
      'not_checked',
      ...PDF_SIGNATURE_DOCUMENT_STATUSES,
    ];
    for (const status of statuses) {
      const assessment = assessRailwayBillVerdict(
        status,
        report(threeSignatures(), status),
      );
      expect(assessment.acceptable, status).toBe(settleable.has(status));
      if (!settleable.has(status)) expect(assessment.refusal, status).not.toBeNull();
    }
  });

  it('refuses when nothing was ever checked, and says so', () => {
    expect(assessRailwayBillVerdict('not_checked', null).refusal).toBe('not_verified');
    // A verdict-shaped row with no report is the same silence.
    expect(assessRailwayBillVerdict('signed_and_intact', null).refusal).toBe(
      'not_verified',
    );
  });

  it('refuses fewer than the three signatures an accepted bill carries', () => {
    const two = threeSignatures().slice(0, 2);
    const assessment = assessRailwayBillVerdict(
      'signed_and_intact',
      report(two, 'signed_and_intact'),
    );
    expect(assessment.refusal).toBe('signature_count');
  });

  it('refuses one signature whose chain reaches no anchor, among three', () => {
    const mixed = threeSignatures();
    const second = distinctSignature(2);
    mixed[1] = {
      ...second,
      chain: {
        ...second.chain,
        status: 'untrusted',
        reason: 'unknown issuer',
        reachesConfiguredAnchor: false,
        anchorSubject: null,
      },
    };
    expect(
      assessRailwayBillVerdict('signed_and_intact', report(mixed, 'signed_and_intact'))
        .refusal,
    ).toBe('signature_chain');
  });

  it('refuses one signature whose bytes moved, among three', () => {
    const mixed = threeSignatures();
    mixed[0] = { ...distinctSignature(1), integrity: 'digest_mismatch' };
    expect(
      assessRailwayBillVerdict('signed_and_intact', report(mixed, 'signed_and_intact'))
        .refusal,
    ).toBe('signature_integrity');
  });

  it('refuses three signatures made by ONE certificate', () => {
    // Owner ruling of 2026-08-14. Every clause of the 2026-08-13 rulings
    // holds here — three intact signatures, three chains to a configured
    // anchor, no expiry complaint — and it is still one person signing
    // their own approval three times, which is what the newer ruling
    // refuses.
    const one = distinctSignature(1);
    const same = [
      { ...one, index: 1 },
      { ...one, index: 2 },
      {
        ...one,
        index: 3,
        coverage: { ...one.coverage, coversWholeDocument: true },
      },
    ];
    const assessment = assessRailwayBillVerdict(
      'signed_and_intact',
      report(same, 'signed_and_intact'),
    );
    expect(assessment.acceptable).toBe(false);
    expect(assessment.refusal).toBe('signature_signers');
    expect(assessment.detail).toContain('1 certificate');
  });

  it('compares certificates, not printed names', () => {
    // Three different names on one certificate is the same fraud with a
    // cosmetic difference, so the names must not rescue it...
    const one = distinctSignature(1);
    const renamed = [1, 2, 3].map((index) => ({
      ...one,
      index,
      signer: { ...one.signer, commonName: `SIGNATORY ${String(index)}` },
      coverage: { ...one.coverage, coversWholeDocument: index === 3 },
    }));
    expect(
      assessRailwayBillVerdict(
        'signed_and_intact',
        report(renamed, 'signed_and_intact'),
      ).refusal,
    ).toBe('signature_signers');

    // ...and three certificates sharing one printed name must not be
    // refused by it, which is what comparing names would have done.
    const shared = [1, 2, 3].map((index) => {
      const entry = distinctSignature(index);
      return {
        ...entry,
        signer: { ...entry.signer, commonName: 'FOR CENTRAL RAILWAY' },
        coverage: { ...entry.coverage, coversWholeDocument: index === 3 },
      };
    });
    expect(
      assessRailwayBillVerdict('signed_and_intact', report(shared, 'signed_and_intact'))
        .acceptable,
    ).toBe(true);
  });

  it('refuses a signature whose certificate it cannot identify', () => {
    // "I cannot tell these apart" must not read as "these are different".
    const unidentified = threeSignatures().map((entry, position) => ({
      ...entry,
      chain: { ...entry.chain, path: [] },
      signer: {
        ...entry.signer,
        issuerCommonName: null,
        certificateSerialNumber: position === 0 ? null : String(position),
      },
    }));
    expect(
      assessRailwayBillVerdict(
        'signed_and_intact',
        report(unidentified, 'signed_and_intact'),
      ).refusal,
    ).toBe('signature_signers');
  });

  it('falls back to the signer summary when no chain path was built', () => {
    const summarised = threeSignatures().map((entry, position) => ({
      ...entry,
      chain: { ...entry.chain, path: [] },
      signer: {
        ...entry.signer,
        issuerCommonName: `Licensed CA ${String(position)}`,
        certificateSerialNumber: `0${String(position)}`,
      },
    }));
    expect(
      assessRailwayBillVerdict(
        'signed_and_intact',
        report(summarised, 'signed_and_intact'),
      ).acceptable,
    ).toBe(true);
  });

  it('requires the LAST signature to cover the file, and only the last', async () => {
    // This is the rule that would refuse every real bill if it were
    // stated as "every signature covers the whole document". The corpus
    // records BILL-1's actual coverage: two of its three signatures do
    // not, because each signer appended a revision after the one before.
    const manifest = JSON.parse(
      await readFile(path.join(FIXTURES, 'corpus.json'), 'utf8'),
    ) as {
      readonly documents: readonly {
        readonly id: string;
        readonly signature_expectation: {
          readonly signatures?: readonly {
            readonly covers_whole_document: boolean;
            readonly trailing_bytes_covered_by_later_signature?: boolean;
          }[];
        };
      }[];
    };
    const real = manifest.documents.find((document) => document.id === 'BILL-1');
    const coverage = (real?.signature_expectation.signatures ?? []).map(
      (entry) => entry.covers_whole_document,
    );
    expect(coverage).toEqual([false, false, true]);

    // Modelled here, and accepted.
    expect(
      assessRailwayBillVerdict(
        'signed_and_intact',
        report(threeSignatures(), 'signed_and_intact'),
      ).acceptable,
    ).toBe(true);

    // Bytes after the LAST signature are a different matter.
    const appended = threeSignatures();
    appended[2] = {
      ...distinctSignature(3),
      coverage: {
        coversWholeDocument: false,
        signedByteCount: 90,
        unsignedBytesAfter: 10,
        revisionsAfter: 1,
        trailingBytesCoveredByLaterSignature: false,
      },
    };
    expect(
      assessRailwayBillVerdict(
        'signed_and_intact',
        report(appended, 'signed_and_intact'),
      ).refusal,
    ).toBe('signature_coverage');
  });
});
