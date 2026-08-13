# ADR-0009: Outbound DSC signing — PAdES B-T over native messaging

- Status: Accepted
- Date: 2026-08-13

## Context

The owner asked for outbound digital signing with the organisation's own
Class 3 DSC: a clerk raises a signature request on a document (delivery
challan, tax invoice, submitted letter, budgetary quotation); the
authorised signer, with the USB token plugged into their own machine,
approves; the signed PDF becomes available to authorised viewers.

The constraint that decides everything is that a PKCS#11 token's private
key is non-exportable and usable only on the machine holding the token.
The server can never sign directly. Some part of the signing operation
must run on the signer's computer, and the question is which part, over
what transport, producing what signature format.

An earlier working assumption in this project was "the server computes
the document digest, only the hash travels to the signer's machine, the
returned PKCS#7 is embedded server-side." That is the right shape and
the wrong detail in two ways, both of which produce signatures that no
validator accepts. This ADR records the corrected design.

## Decision

### The token signs the SignedAttrs, not the document digest

RFC 5652 §5.4 is explicit: when `signedAttrs` is present, the message
digest is computed over the complete DER encoding of the `SignedAttrs`
value, using the EXPLICIT `SET OF` tag (`0x31`) rather than the IMPLICIT
`[0]` tag (`0xA0`) that appears in the wire structure. The document
digest is not what gets signed; it is one attribute (`message-digest`)
inside the structure that gets signed.

ETSI EN 319 142-1 V1.2.1 additionally requires `SignedData.certificates`
to carry the signing certificate, and EN 319 122-1 requirement (i) makes
the ESS `signing-certificate-v2` attribute mandatory whenever the hash
algorithm is not SHA-1 — which for us is always. Both mean the signing
certificate must be in hand _before_ the CMS can be assembled.

So the helper exposes exactly two calls and the flow is two round-trips:

1. `listCertificates()` → thumbprint, subject, issuer, notAfter, DER chain
2. server builds `SignedAttrs` = { `content-type` = `id-data`,
   `message-digest` = SHA-256(ByteRange bytes), `signing-certificate-v2` }
   and DER-encodes it with the EXPLICIT `SET OF` tag
3. `signHash(sadBytes)` → raw RSA signature
4. server assembles `SignedData`, timestamps, embeds

`signing-time` is **forbidden** by EN 319 142-1 at every baseline level.
Trusted time comes from an RFC 3161 timestamp, not from a self-asserted
attribute. All CMS assembly stays server-side; the helper is a signing
oracle over a byte string and nothing more.

### Not `@signpdf/signer-p12`

`signer-p12` hardcodes three signed attributes: `contentType`,
`signingTime`, `messageDigest`. It emits the one attribute PAdES forbids
and omits the one it requires. This is not fixable by passing more
attributes, because node-forge's `_attributeToAsn1` understands only
those same three and the library has no ESS support anywhere. Setting
`subFilter: ETSI.CAdES.detached` on top of it produces a document that
claims PAdES and fails PAdES.

There is a second and more serious reason not to reach for node-forge,
found independently by the inbound verification work: it carries
March/April 2026 advisories for RSA signature forgery and certificate
chain bypass — the two operations a signature implementation exists to
get right. That work reports them as CVE-2026-33894 and CVE-2026-33896;
confirm the identifiers against the advisory database before citing
them, but the conclusion does not depend on the numbers. node-forge is
not currently in this repository's dependency tree (it appears nowhere
in `pnpm-lock.yaml`), and it should not be added by this work.

CMS assembly uses `@peculiar/asn1-cms` + `@peculiar/asn1-ess` +
`@peculiar/asn1-tsp`. If that proves heavier than it looks, the
fallback is a pyHanko sidecar (MIT), which is the only open-source
stack that does PAdES B-LTA, PKCS#11 and interrupted signing correctly
without re-deriving the above by trial and error.

### Browser extension + Native Messaging, not a localhost listener

Every Indian DSC bridge in production is a localhost HTTPS or WebSocket
service — emSigner on `127.0.0.1:1585`, emBridge on
`localhost.emudhra.com:26769`, TRACES on `127.0.0.1:1565`. That pattern
is being closed off underneath them: Chrome 142 (stable, 28 Oct 2025)
gates local network requests behind a permission prompt, and WebSocket
gating lands in Chrome 147. Indian troubleshooting guides from 2026
already document emSigner breaking for this reason.

It is also the pattern with the worse security record. A loopback TCP
socket has no security descriptor, so any process at any integrity level
on the machine can connect to it. `Origin` allowlisting is the single
load-bearing control (IP checks and `Host` checks are both defeated by
DNS rebinding; `Origin` is a forbidden header name that JavaScript
cannot set, so it survives), and the industry's record of implementing
that one check correctly is poor — `endsWith`, `startsWith`, `Contains`
and allowlisted `null` are all documented shipped bugs. WebSockets are
exempt from the same-origin policy by design and carry no preflight, so
a WebSocket signer that skips the check has no origin protection at all.

With Native Messaging the browser enforces `allowed_origins` itself.
There is no port to scan, no `Origin` parser of ours to get wrong, no
rebinding surface and no TLS certificate to ship — the last of which
matters because the standard workaround (a publicly-trusted cert for a
loopback hostname) means shipping its private key in the installer, and
CA/B Forum rules require revocation within 24 hours of that becoming
known.

The trade is that the extension becomes the trust boundary. Consent is
therefore rendered by the native host, not the page: a native,
always-on-top window showing document name, hash, requesting origin and
certificate subject. The token PIN is entered in the driver's own
dialog, never in a browser field, and is never cached — a cached PIN
turns the helper into an unattended signing oracle.

### Windows CNG via the certificate store, in .NET, not PKCS#11 in Node

Indian token drivers install a Microsoft CSP/minidriver, so the
certificate appears in the Windows certificate store and
`X509Store` + `RSACng.SignHash` reaches it with no PKCS#11 module path
discovery, no per-vendor DLL hunting and no 32/64-bit mismatch. The PIN
dialog is the driver's, which is exactly the property we want.

Node is rejected for the helper specifically: `pkcs11js` declares
`install: node-gyp rebuild` and publishes no prebuilt binaries, so every
install would need Visual Studio Build Tools and Python on a railway
site machine. A .NET self-contained single-file publish is one
Authenticode-signable `.exe` with no runtime prerequisite.
`Pkcs11Interop` (Apache-2.0) stays documented as the fallback for a
token whose driver ships only a PKCS#11 module.

### PAdES B-T at signing, B-LT asynchronously

B-B alone is not defensible for a record under ten-year statutory
retention: without a timestamp there is no proof of _when_ the document
was signed, and that proof is the only thing that makes an expired
certificate irrelevant later. CCA's own guidance is that a signature is
valid if the certificate was valid at signing time — which is
unprovable without trusted time.

The inbound verification work supplies the empirical case. Against the
real CCA India root, a genuine four-signature variation order from the
customer corpus verifies as `signed_chain_expired`: every signature is
intact and every chain reaches CCA India, but the Class 3 certificates
have since lapsed and IREPS applied no timestamp, so nothing in the
document proves they were valid when it was signed. That is precisely
the failure this decision avoids for our own outbound documents, and it
is already visible in documents Railways issues today.

So: RFC 3161 timestamp at signing (B-T), and an asynchronous job that
fetches OCSP/CRL and appends the DSS by incremental update (B-LT).
B-LTA is deliberately out of scope; archival re-timestamping is a
standing maintenance obligation, not a one-time feature, and we should
not take it on until something requires it.

Reserve **16384 bytes** for `/Contents`, not the 8192-byte default —
overflow at 8612 bytes is documented in the wild, and the size is fixed
once written. The DSS lives in later incremental updates and does not
consume this budget.

### Approval signatures only, never DocMDP certification

For multi-signatory documents every signature is a plain approval
signature added as an incremental update. A certification signature with
`P=1` blocks all later signatures outright, and Acrobat has a
long-standing bug rejecting DSS additions after any certification —
contrary to ISO 32000-2 — which would break LTV enrichment under `P=2`
and `P=3` as well.

A later signature does not invalidate an earlier one _provided_ it is
appended: signature 1's ByteRange covers bytes that signature 2 never
touches. The failure mode is rewriting instead of appending, which is
what `pdf-lib`'s `save()` does. Use `@cantoo/pdf-lib`'s
`saveIncremental`; upstream `pdf-lib` has no incremental save and is
effectively unmaintained.

Tamper-evidence on rendered content before anyone signs comes from the
existing `rendered_sha256` and `template_version` columns, not from
DocMDP.

### Interaction with the Gotenberg pipeline

Raw Chromium output is the easiest possible input to sign: `%PDF-1.4`,
a classic `xref` table, no object streams, no AcroForm. Two consequences
for the render route:

- Setting `pdfa=` routes the document through LibreOffice, so it is no
  longer a Chromium PDF and its xref shape must be re-tested. Do not set
  it unless archival PDF/A is a hard requirement.
- ExifTool metadata writes are themselves incremental updates, so
  metadata must be written **before** signing. Writing it after leaves
  the ByteRange cryptographically valid but makes Acrobat report the
  document as modified since signing. The same applies to `flatten` and
  `encrypt`: before signing or never.

Signatures are invisible. The human-readable signature block is rendered
as ordinary HTML content in the template, which suits the product's
density conventions better than a floating Acrobat widget and removes
the entire coordinate-mapping problem. `@signpdf/placeholder-plain` is
not usable — it documents itself as fragile and PDF ≤1.3 only, and it
breaks files that already contain annotations, which ours do whenever
the HTML contains a link.

## Consequences

- Two procurement items block B-T and must be resolved before the
  feature can ship at its target level: an RFC 3161 TSA endpoint (no
  Indian CA publishes one; they are contracted commercially), and a
  decision on the helper's distribution.
- The CCA/RCAI root is not pre-trusted by Adobe Reader, so signatures
  will show "Validity Unknown" to recipients until they import it. This
  is an ecosystem fact, not a defect in our implementation, and belongs
  in operator documentation rather than in code.
- The helper is Windows-only at first. This is acceptable because the
  token is Windows-only in practice, but it means the signing authority
  cannot be exercised from the web UI alone.
- C-DAC e-Hastakshar (Aadhaar eSign) remains a live product
  alternative that would delete this entire ADR's surface — no token, no
  helper, no driver matrix, no platform constraint — at the cost of
  per-signature fees and a one-time certificate rather than the signer's
  own DSC. It is not chosen here because the owner's stated requirement
  is signing with the organisation's own USB token.
- Signing authority joins the per-feature permission matrix and must be
  added to the MFA policy in `apps/server/src/mfa-policy.ts`, alongside
  the existing issue/cancel/approve authorities.
