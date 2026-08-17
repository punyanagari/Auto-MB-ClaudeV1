// @vitest-environment jsdom
import type { PdfSignatureReport, PdfSignatureVerdict } from '@auto-mb/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SignaturePanel } from '../../src/ui/signature-panel.js';

function verdict(overrides: Partial<PdfSignatureVerdict> = {}): PdfSignatureVerdict {
  return {
    index: 1,
    subFilter: 'adbe.pkcs7.sha1',
    filter: 'Adobe.PPKMS',
    signer: {
      commonName: 'A K SHARMA',
      organisation: 'WESTERN RAILWAY',
      organisationalUnit: 'SIGNAL AND TELECOM',
      subject: 'C=IN\nO=WESTERN RAILWAY\nCN=A K SHARMA',
      issuerCommonName: 'Test Licensed CA 2024',
      certificateSerialNumber: '0A1B2C',
      declaredName: 'A K SHARMA',
    },
    claimedSigningTime: '2025-02-11T04:00:15.000Z',
    claimedSigningTimeSource: 'signature_dictionary',
    timestamp: {
      present: false,
      time: null,
      status: 'absent',
      reason: 'no_timestamp_token',
      authoritySubject: null,
    },
    reason: 'Variation Signing By SSE/Tele',
    location: 'Mumbai Central',
    contactInfo: null,
    integrity: 'intact',
    integrityDetail: null,
    digestAlgorithm: 'sha1',
    weakDigest: true,
    signingCertificateBinding: 'absent',
    chain: {
      status: 'trusted',
      reason: 'trusted',
      reachesConfiguredAnchor: true,
      anchorSubject: 'C=IN\nO=India PKI\nCN=CCA India 2022',
      path: [],
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
      signedByteCount: 98_989,
      unsignedBytesAfter: 0,
      revisionsAfter: 0,
      trailingBytesCoveredByLaterSignature: false,
    },
    certification: { docMdp: false, permissions: null },
    ...overrides,
  };
}

function report(overrides: Partial<PdfSignatureReport> = {}): PdfSignatureReport {
  return {
    status: 'signed_and_intact',
    signatureCount: 1,
    signatures: [verdict()],
    unreadableSignatures: [],
    fileLength: 98_989,
    unsignedTrailingBytes: 0,
    trustAnchors: { configured: true, count: 2, source: '/etc/auto-mb/trust' },
    verifiedAt: '2026-08-13T09:00:00.000Z',
    verifierVersion: '1',
    ...overrides,
  };
}

// The package runs vitest without globals, so Testing Library's automatic
// cleanup hook is never registered and renders would accumulate across
// tests.
afterEach(cleanup);

describe('SignaturePanel', () => {
  it('names the signer from the certificate and labels the time as a claim', () => {
    render(<SignaturePanel status="signed_and_intact" verdict={report()} />);
    expect(screen.getByText('A K SHARMA')).toBeTruthy();
    expect(screen.getByText(/WESTERN RAILWAY/)).toBeTruthy();
    expect(screen.getByText('Signed and intact')).toBeTruthy();
    // The signing time is written by the signer's own software; the panel
    // must never present it as an attested fact.
    expect(
      screen.getByText(/stated by the signer, not attested by a timestamp/),
    ).toBeTruthy();
  });

  it('says on every signature that revocation was not checked', () => {
    render(<SignaturePanel status="signed_and_intact" verdict={report()} />);
    expect(screen.getByText(/not checked — this server does not contact/)).toBeTruthy();
  });

  it('discloses a weak digest without calling the signature invalid', () => {
    render(<SignaturePanel status="signed_and_intact" verdict={report()} />);
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(
      screen.getByText(/no longer\s+proves the signed content is unique/),
    ).toBeTruthy();
  });

  it('is the only status that renders the success tone', () => {
    // The rule the whole panel exists to hold: green means every
    // signature verified AND every chain reached an installed anchor AND
    // nothing followed the last signature. Any other state that rendered
    // green would make the green one worthless.
    const green = render(
      <SignaturePanel status="signed_and_intact" verdict={report()} />,
    );
    // The success tint is `ui/badge.tsx`'s success variant, whose surface
    // is the mock's `bg-success/10` (`components/shared` at a8e1fde).
    expect(green.container.querySelectorAll('.bg-success\\/10').length).toBeGreaterThan(
      0,
    );
    green.unmount();

    for (const status of [
      'not_checked',
      'unsigned',
      'signed_but_untrusted_chain',
      'signed_chain_expired',
      'signed_chain_not_checked',
      'signed_but_modified_after_signing',
      'signature_invalid',
      'signature_unverifiable',
    ] as const) {
      const view = render(<SignaturePanel status={status} verdict={null} />);
      const panel = view.getByTestId('signature-panel');
      expect(
        panel.querySelector(':scope > div .bg-success\\/10'),
        `${status} must not render the success tone`,
      ).toBeNull();
      view.unmount();
    }
  });

  it('separates "not checked" from "unsigned"', () => {
    const notChecked = render(<SignaturePanel status="not_checked" verdict={null} />);
    expect(screen.getByText('Signatures not checked')).toBeTruthy();
    expect(screen.getByText(/nothing is known about its signatures/)).toBeTruthy();
    notChecked.unmount();

    render(
      <SignaturePanel
        status="unsigned"
        verdict={report({ status: 'unsigned', signatures: [], signatureCount: 0 })}
      />,
    );
    expect(screen.getByText('No digital signature')).toBeTruthy();
    // The trap the owner's own sample set contains: a printed copy whose
    // page carries a green tick.
    expect(
      screen.getByText(/that tick is part of the picture, not a signature/),
    ).toBeTruthy();
  });

  it('explains a countersigned document rather than calling it modified', () => {
    render(
      <SignaturePanel
        status="signed_and_intact"
        verdict={report({
          signatures: [
            verdict({
              coverage: {
                coversWholeDocument: false,
                signedByteCount: 50_001,
                unsignedBytesAfter: 48_988,
                revisionsAfter: 3,
                trailingBytesCoveredByLaterSignature: true,
              },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText(/normal\s+for a countersigned document/)).toBeTruthy();
  });

  it('says plainly when bytes after a signature are covered by nothing', () => {
    render(
      <SignaturePanel
        status="signed_but_modified_after_signing"
        verdict={report({
          status: 'signed_but_modified_after_signing',
          unsignedTrailingBytes: 26,
          signatures: [
            verdict({
              coverage: {
                coversWholeDocument: false,
                signedByteCount: 98_989,
                unsignedBytesAfter: 26,
                revisionsAfter: 0,
                trailingBytesCoveredByLaterSignature: false,
              },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText('Changed after it was signed')).toBeTruthy();
    expect(screen.getByText(/covered by no signature at all/)).toBeTruthy();
  });

  it('blames the server, not the document, when no anchors are installed', () => {
    render(
      <SignaturePanel
        status="signed_chain_not_checked"
        verdict={report({
          status: 'signed_chain_not_checked',
          trustAnchors: { configured: false, count: 0, source: null },
          signatures: [
            verdict({
              chain: {
                status: 'not_checked',
                reason: 'no_trust_anchors_configured',
                reachesConfiguredAnchor: false,
                anchorSubject: null,
                path: [],
                validAtVerificationTime: false,
                validAtClaimedSigningTime: null,
              },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText('Signed; issuer not checked')).toBeTruthy();
    expect(screen.getByText(/Ask your administrator/)).toBeTruthy();
    expect(screen.getByText(/no installed certifying authorities/)).toBeTruthy();
  });

  it('distinguishes an expired certificate from an unknown issuer', () => {
    render(
      <SignaturePanel
        status="signed_chain_expired"
        verdict={report({
          status: 'signed_chain_expired',
          signatures: [
            verdict({
              chain: {
                status: 'untrusted',
                reason: 'certificate_expired',
                reachesConfiguredAnchor: true,
                anchorSubject: 'CN=CCA India 2022',
                path: [],
                validAtVerificationTime: false,
                validAtClaimedSigningTime: true,
              },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText('Signed; certificate has since expired')).toBeTruthy();
    expect(
      screen.getByText(/had not expired at the claimed signing time/),
    ).toBeTruthy();
  });

  it('lists signatures it could not read instead of dropping them', () => {
    render(
      <SignaturePanel
        status="signature_unverifiable"
        verdict={report({
          status: 'signature_unverifiable',
          signatureCount: 1,
          signatures: [],
          unreadableSignatures: [
            { offset: 46_362, reason: 'the signature blob could not be read' },
          ],
        })}
      />,
    );
    expect(screen.getByText('1 signature could not be read')).toBeTruthy();
    expect(screen.getByText('the signature blob could not be read')).toBeTruthy();
  });
});
