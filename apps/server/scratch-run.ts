import { readFileSync } from 'node:fs';
import { verifyPdfSignatures, loadTrustAnchors } from './src/pdf-signature.js';

const anchorPath = process.env.ANCHORS;
const anchors = await loadTrustAnchors(anchorPath);
console.log('anchors:', anchors.anchors.length, anchors.configuredPath);
for (const file of process.argv.slice(2)) {
  const report = verifyPdfSignatures(readFileSync(file), { trustAnchors: anchors });
  console.log('==========', file);
  console.log('  status:', report.status, '| signatures:', report.signatureCount, '| unsignedTrailingBytes:', report.unsignedTrailingBytes);
  for (const s of report.unreadableSignatures) console.log('  UNREADABLE at', s.offset, s.reason);
  for (const s of report.signatures) {
    console.log(
      `  #${s.index} ${s.integrity} | CN=${s.signer.commonName} | O=${s.signer.organisation} | issuer=${s.signer.issuerCommonName}`,
    );
    console.log(
      `      subFilter=${s.subFilter} digest=${s.digestAlgorithm} weak=${s.weakDigest} essBinding=${s.signingCertificateBinding}`,
    );
    console.log(
      `      claimed=${s.claimedSigningTime} (${s.claimedSigningTimeSource}) ts=${s.timestamp.status}:${s.timestamp.reason}`,
    );
    console.log(
      `      chain=${s.chain.status}/${s.chain.reason} anchor=${s.chain.anchorSubject?.replace(/\n/g, ' ')} reaches=${s.chain.reachesConfiguredAnchor} pathLen=${s.chain.path.length} validNow=${s.chain.validAtVerificationTime} validThen=${s.chain.validAtClaimedSigningTime}`,
    );
    console.log(
      `      coverage whole=${s.coverage.coversWholeDocument} after=${s.coverage.unsignedBytesAfter} revsAfter=${s.coverage.revisionsAfter} laterCovered=${s.coverage.trailingBytesCoveredByLaterSignature}`,
    );
    if (s.integrityDetail !== null) console.log(`      detail: ${s.integrityDetail}`);
    console.log(`      reason=${JSON.stringify(s.reason)} location=${JSON.stringify(s.location)}`);
  }
}
