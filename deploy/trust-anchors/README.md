# CCA India root certificates (PDF signature trust anchors)

This directory is the **default** value of `AUTO_MB_PDF_TRUST_ANCHORS`. The
production image copies it to `/etc/auto-mb/pdf-trust` and points the
variable at it (`deploy/Dockerfile.server`), so a stock deployment can
decide _who_ signed an inbound railway PDF instead of showing every
reviewer "no certifying authorities are installed" — a warning no operator
of a fresh install could act on.

`scripts/check-config.mjs` (run by `pnpm verify`) re-parses every file here
on every build and fails if a certificate stops matching the fingerprint
recorded below, stops being a self-signed CA, or if the Dockerfile stops
copying the directory or setting the variable. The bundle is data with a
frozen manifest, not a code path, so it cannot drift silently.

## What is here

Only **CCA India roots** sit at the top level. Certificates under
`intermediates/` complete a path when a signer embedded no chain and can
never end one; installing a licensed CA as an anchor would make that one
CA's compromise indistinguishable from a compromise of the CCA root. The
loader keeps the two lists apart deliberately
(`apps/server/src/pdf-signature/trust-anchors.ts`).

| File                     | Subject              | Valid from | Valid to   | SHA-256 of the DER                                                 |
| ------------------------ | -------------------- | ---------- | ---------- | ------------------------------------------------------------------ |
| `cca-india-2022.pem`     | `CCA India 2022`     | 2022-02-02 | 2042-02-02 | `9a3fd3176798e842ddcb12c262f11cfacca70a8b84c6ea6fda30842a95a94cd8` |
| `cca-india-2022-spl.pem` | `CCA India 2022 SPL` | 2022-09-20 | 2042-09-20 | `b724689b79b2ef9421ef8f5cc733eb093851b170ee715177005a09f226d8c91a` |
| `cca-india-2014.pem`     | `CCA India 2014`     | 2014-03-05 | 2024-03-05 | `60109bc6c38328598a112c7a25e38b0f23e5a7511cb815fb64e0c4ff05db7df7` |

`cca-india-2014.pem` is **expired and kept on purpose**: a letter signed in
2020 still needs the root that was current in 2020 for its chain to be
readable at all. An expired anchor never promotes a signature to trusted —
the verifier reports `certificate_expired` with the path it walked — but
without it the same document reads as "issuer unknown", which is a
different and less useful fact. Roots are added here, never removed.

## Provenance

Fetched 2026-08-13 over TLS from the Controller of Certifying Authorities'
own site, <https://www.cca.gov.in/root_certificate.html>, "Existing Root
Certificates":

| Source URL                                                                 | SHA-256 of the file as served                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `https://www.cca.gov.in/cca/sites/default/files/files/CCAIndia2022.cer`    | `2427c86a7f7e7bbe1684b75cfe96537ab080d00b7d6acf0c4453b438f246e0ee` |
| `https://www.cca.gov.in/cca/sites/default/files/files/CCAIndia2022SPL.cer` | `6e92017ece0e2e752a59b37c0ebf0fb958311cc585deda1fdf12790eb99b3caf` |
| `https://www.cca.gov.in/cca/sites/default/files/files/CCAIndia2014.cer`    | `5a653f9f98c5ea49bc5a6dfd52de1ba7668de653ef8a6fb09cdf9638764d1a94` |

The served files differ byte-for-byte from the `.pem` files here (two are
PEM with CRLF and a stray blank line, `CCAIndia2014.cer` is bare base64
with no armour); they were re-emitted as canonical LF PEM from the decoded
DER. **The certificates themselves are unchanged** — the DER SHA-256 in the
first table is what identifies them, and it is what
`scripts/check-config.mjs` asserts.

Every certificate here was checked to be self-signed with a valid signature
over itself (`openssl verify -check_ss_sig`, and again by
`node:crypto`'s `X509Certificate.verify`) and to carry
`basicConstraints: CA:TRUE`.

### How much this provenance is worth

One channel. The files were downloaded over TLS from `cca.gov.in` and
nothing else. The CCA publishes no fingerprints beside the download and no
signed trust list; its documented out-of-band channel is an automated
reply from `verifyroot@cca.gov.in`, which a build cannot use.

One corroboration exists and is worth recording: the SHA-256 of
`CCA India 2022` matches, digit for digit, the fingerprint that was already
written into `docs/OPERATIONS.md` §8 before this bundle existed, from a
separate download on a different date. That is two observations of the same
root, not two independent channels.

**The out-of-band confirmation therefore remains an operator step**, exactly
as `docs/OPERATIONS.md` §8 describes. Treat this bundle as a good default
that removes a dead-end warning, not as a substitute for the quarterly
human refresh.

### What is deliberately NOT bundled

`CCA India 2015 SPL`
(`https://www.cca.gov.in/cca/sites/default/files/files/CCAIndia2015.cer`,
file SHA-256 `b42111e11d42608e3a6fbf17c6946454636a9a558c2f74c2fc1546e7b04cf503`,
DER SHA-256 `c34c5df53080078ffe45b21a7f600469917204f4f0293f1d7209393e5265c04f`).

The published file **fails its own self-signature check**. Its subject and
issuer are both `CN=CCA India 2015 SPL`, but the signature on it does not
verify against the public key it carries:

```
$ openssl verify -check_ss_sig -CAfile cca-india-2015-spl.pem -no_check_time cca-india-2015-spl.pem
C=IN, O=India PKI, CN=CCA India 2015 SPL
error 7 at 0 depth lookup: certificate signature failure
error:02000068:rsa routines:ossl_rsa_verify:bad signature
```

Downloaded three times, from both `www.cca.gov.in` and `cca.gov.in`, always
the same bytes — so this is what the CCA publishes, not a transfer fault.
The cause is not known from here. Whatever it is, a certificate whose
authenticity cannot be demonstrated must not be installed as a trust
anchor, and it is left out rather than bundled unverified. It expired on
2025-01-29 in any case. An operator who needs it for 2015–2024 documents can
add it by hand after the out-of-band check above, and record why.

## Refresh

The procedure — quarterly, by a human, two-person for any addition — is
`docs/OPERATIONS.md` §8. After changing anything here, update the
fingerprint tables above **and** `scripts/check-config.mjs`'s
`CCA_INDIA_ROOTS` manifest in the same commit; the check is what stops a
silent swap.
