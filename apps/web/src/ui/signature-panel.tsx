import type {
  PdfSignatureReport,
  PdfSignatureVerdict,
  StoredPdfSignatureStatus,
} from '@auto-mb/contracts';
import { Badge } from './badge.js';
import { formatTimestamp } from '../format.js';

/**
 * The digital-signature panel for an inbound railway PDF.
 *
 * The whole design rule for this component: EXACTLY ONE state renders
 * green, and it is the one where every signature verified, every chain
 * reached a trust anchor the operator installed, and no byte follows the
 * last signature. Everything else — an unknown issuer, an expired
 * certificate, no anchors installed, a signature this server could not
 * read — is amber or red and says which. A reader who sees green here has
 * to be able to rely on it completely; the moment green also means
 * "probably fine" it means nothing.
 *
 * The second rule: a claim is never printed as a fact. The signing time in
 * a railway PDF is written by the signer's own software and no clock
 * attests to it, so it is labelled "claimed" every time it appears. The
 * name in the `/Name` entry is likewise a claim and the certificate
 * subject is the evidence, so the certificate's name is what is shown.
 */

type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral';

interface StatusPresentation {
  readonly tone: Tone;
  readonly headline: string;
  /** One plain operational sentence. No hedging, no marketing. */
  readonly detail: string;
}

const STATUS_WORDS: Record<StoredPdfSignatureStatus, StatusPresentation> = {
  not_checked: {
    tone: 'neutral',
    headline: 'Signatures not checked',
    detail:
      'This document was accepted before signature verification existed, so nothing is known about its signatures. Upload it again to have them checked.',
  },
  unsigned: {
    tone: 'warning',
    headline: 'No digital signature',
    detail:
      'This PDF carries no digital signature. A printed or scanned copy of a signed document lands here even when a green tick appears on the page — that tick is part of the picture, not a signature.',
  },
  signed_and_intact: {
    tone: 'success',
    headline: 'Signed and intact',
    detail:
      'Every signature verifies, every signing certificate chains to a trusted authority, and nothing has been added since the last signature.',
  },
  signed_but_untrusted_chain: {
    tone: 'destructive',
    headline: 'Signed by an unrecognised authority',
    detail:
      'The signature verifies, but the signing certificate does not chain to any certifying authority this server trusts. Nothing confirms who signed it.',
  },
  signed_chain_expired: {
    tone: 'warning',
    headline: 'Signed; certificate has since expired',
    detail:
      'The signature verifies and the certificate chains to a trusted authority, but that certificate has expired and the document carries no timestamp, so nothing independent proves the signature was made while it was valid.',
  },
  signed_chain_not_checked: {
    tone: 'warning',
    headline: 'Signed; issuer not checked',
    detail:
      'The signature verifies mathematically, but this server has no trusted certifying authorities installed, so who signed it was not established. Ask your administrator to install the CCA India root certificates.',
  },
  signed_but_modified_after_signing: {
    tone: 'destructive',
    headline: 'Changed after it was signed',
    detail:
      'The document does not match what was signed: either bytes were added after the last signature, or content inside a signed range was edited. Treat the signatures as covering a different document from this one.',
  },
  signature_invalid: {
    tone: 'destructive',
    headline: 'Signature does not verify',
    detail:
      'A signature does not verify against the public key of its own certificate. The document is not authenticated by the signer it names.',
  },
  signature_unverifiable: {
    tone: 'warning',
    headline: 'Signature could not be read',
    detail:
      'A signature is present but this server could not read it, so it was neither accepted nor rejected. This is not a finding about the document.',
  },
};

const INTEGRITY_WORDS: Record<PdfSignatureVerdict['integrity'], StatusPresentation> = {
  intact: {
    tone: 'success',
    headline: 'Verified',
    detail: 'The bytes this signature covers are exactly the bytes that were signed.',
  },
  digest_mismatch: {
    tone: 'destructive',
    headline: 'Content changed',
    detail: 'The bytes this signature covers are not the bytes that were signed.',
  },
  signature_invalid: {
    tone: 'destructive',
    headline: 'Does not verify',
    detail:
      "The signature does not verify under the public key of the signer's certificate.",
  },
  unverifiable: {
    tone: 'warning',
    headline: 'Not readable',
    detail: 'This signature could not be read, so it was neither accepted nor rejected.',
  },
};

const CHAIN_WORDS: Record<PdfSignatureVerdict['chain']['status'], StatusPresentation> = {
  trusted: {
    tone: 'success',
    headline: 'Issuer trusted',
    detail: '',
  },
  untrusted: { tone: 'destructive', headline: 'Issuer not trusted', detail: '' },
  not_checked: { tone: 'warning', headline: 'Issuer not checked', detail: '' },
};

/** A one-line explanation of a chain reason, in operational words. */
function chainSentence(chain: PdfSignatureVerdict['chain']): string {
  switch (chain.reason) {
    case 'trusted':
      return `Chains to ${chain.anchorSubject ?? 'a trusted authority'}.`;
    case 'no_trust_anchors_configured':
      return 'No trusted certifying authorities are installed on this server.';
    case 'no_path_to_configured_anchor':
      return 'No path from this certificate reaches a trusted certifying authority.';
    case 'signing_certificate_not_in_signature':
      return 'The signature does not carry the certificate it names.';
    case 'path_signature_invalid':
      return 'A certificate in the chain was not actually issued by the one above it.';
    case 'certificate_expired':
      return chain.validAtClaimedSigningTime === true
        ? 'The certificate chains to a trusted authority and had not expired at the claimed signing time, but it has expired since and the document carries no timestamp to prove when it was signed.'
        : 'The certificate has expired.';
    case 'certificate_not_yet_valid':
      return 'A certificate in the chain is not valid yet.';
    default:
      return chain.reason;
  }
}

/** The product's existing status chip, reused rather than reinvented: a
 * new visual element for this one panel would be a second status
 * vocabulary for a reader to learn. */
function Lamp({ tone, children }: { readonly tone: Tone; readonly children: string }) {
  return <Badge variant={tone}>{children}</Badge>;
}

function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-sm">
      <dt className="min-w-36 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function SignatureEntry({ signature }: { readonly signature: PdfSignatureVerdict }) {
  const integrity = INTEGRITY_WORDS[signature.integrity];
  const chain = CHAIN_WORDS[signature.chain.status];
  return (
    <li className="border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="tnum font-mono text-xs text-muted-foreground">
          #{signature.index}
        </span>
        <strong className="break-words">
          {signature.signer.commonName ?? 'Signer not named by a certificate'}
        </strong>
        <Lamp tone={integrity.tone}>{integrity.headline}</Lamp>
        <Lamp tone={chain.tone}>{chain.headline}</Lamp>
      </div>
      <dl className="mt-2 flex flex-col gap-1">
        {signature.signer.organisation !== null && (
          <Row label="Organisation">
            {signature.signer.organisation}
            {signature.signer.organisationalUnit !== null &&
              ` · ${signature.signer.organisationalUnit}`}
          </Row>
        )}
        {signature.signer.issuerCommonName !== null && (
          <Row label="Issued by">{signature.signer.issuerCommonName}</Row>
        )}
        {/* Always "claimed": /M and the CMS signingTime attribute are both
            written by the signing client, and no railway document in the
            corpus carries a timestamp token that would make it evidence. */}
        <Row label="Claimed signing time">
          {signature.claimedSigningTime === null ? (
            <span className="text-muted-foreground">not stated</span>
          ) : (
            <>
              <span className="tnum font-mono">
                {formatTimestamp(signature.claimedSigningTime)}
              </span>
              {signature.timestamp.status === 'verified' ? null : (
                <span className="text-muted-foreground">
                  {' '}
                  — stated by the signer, not attested by a timestamp
                </span>
              )}
            </>
          )}
        </Row>
        {signature.timestamp.status === 'verified' && signature.timestamp.time !== null && (
          <Row label="Timestamped">
            <span className="tnum font-mono">
              {formatTimestamp(signature.timestamp.time)}
            </span>{' '}
            by {signature.timestamp.authoritySubject ?? 'a trusted authority'}
          </Row>
        )}
        {signature.reason !== null && <Row label="Reason">{signature.reason}</Row>}
        {signature.location !== null && <Row label="Location">{signature.location}</Row>}
        <Row label="Issuer chain">{chainSentence(signature.chain)}</Row>
        <Row label="Covers">
          {signature.coverage.coversWholeDocument ? (
            'the whole document'
          ) : signature.coverage.trailingBytesCoveredByLaterSignature ? (
            <>
              an earlier version of this document. The{' '}
              <span className="tnum font-mono">
                {signature.coverage.unsignedBytesAfter.toLocaleString('en-IN')}
              </span>{' '}
              bytes added afterwards are covered by a later signature, which is normal
              for a countersigned document.
            </>
          ) : (
            <>
              an earlier version of this document, and the{' '}
              <span className="tnum font-mono">
                {signature.coverage.unsignedBytesAfter.toLocaleString('en-IN')}
              </span>{' '}
              bytes added afterwards are covered by no signature at all.
            </>
          )}
        </Row>
        {signature.integrityDetail !== null && (
          <Row label="Detail">{signature.integrityDetail}</Row>
        )}
        {signature.weakDigest && (
          <Row label="Digest">
            <span className="font-mono">{signature.digestAlgorithm}</span> — an older
            algorithm. The signature proves the signer&apos;s key was used; it no longer
            proves the signed content is unique.
          </Row>
        )}
        {/* Stated on every signature, because a reader who is not told
            this will assume it was checked. */}
        <Row label="Revocation">
          not checked — this server does not contact certificate authorities, so a
          certificate withdrawn after it was issued would still read as valid here
        </Row>
      </dl>
    </li>
  );
}

export function SignaturePanel({
  status,
  verdict,
  className,
}: {
  readonly status: StoredPdfSignatureStatus;
  readonly verdict: PdfSignatureReport | null;
  readonly className?: string;
}) {
  const presentation = STATUS_WORDS[status];
  return (
    <section
      className={className ?? 'my-3 rounded-lg border border-border bg-muted/40 px-4 py-3'}
      aria-labelledby="signature-panel-title"
      data-testid="signature-panel"
      data-signature-status={status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="signature-panel-title" className="m-0">
          Digital signature
        </h2>
        <Lamp tone={presentation.tone}>{presentation.headline}</Lamp>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{presentation.detail}</p>

      {verdict !== null && verdict.signatures.length > 0 && (
        <ul className="mt-2 flex list-none flex-col p-0">
          {verdict.signatures.map((signature) => (
            <SignatureEntry key={signature.index} signature={signature} />
          ))}
        </ul>
      )}

      {verdict !== null && verdict.unreadableSignatures.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <h3 className="text-sm">
            {verdict.unreadableSignatures.length} signature
            {verdict.unreadableSignatures.length === 1 ? '' : 's'} could not be read
          </h3>
          <ul className="mt-1 flex flex-col gap-1 pl-[1.125rem] text-sm text-muted-foreground">
            {verdict.unreadableSignatures.map((entry) => (
              <li key={entry.offset}>{entry.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {verdict !== null && (
        <p className="mt-2 text-xs text-muted-foreground">
          Checked <span className="tnum font-mono">{formatTimestamp(verdict.verifiedAt)}</span>{' '}
          against{' '}
          {verdict.trustAnchors.configured ? (
            <>
              <span className="tnum font-mono">{verdict.trustAnchors.count}</span> installed
              certifying{' '}
              {verdict.trustAnchors.count === 1 ? 'authority' : 'authorities'}
            </>
          ) : (
            'no installed certifying authorities'
          )}
          .
        </p>
      )}
    </section>
  );
}
