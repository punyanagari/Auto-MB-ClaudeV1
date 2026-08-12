# Whitebooks sandbox certification — 12 August 2026

The live Whitebooks sandbox transport was exercised end to end through the
product's own routes — not a standalone script — against a local server
with `WHITEBOOKS_ENVIRONMENT=sandbox`. This is the sandbox-run half of
finding 46's external contract proof and the certification the handoff's
item 5 recorded as owed. No credentials appear in this document or
anywhere in the repository; the deployment secrets live only in a
git-ignored local `.env`.

## What was proven

The full statutory lifecycle ran against the NIC sandbox via Whitebooks,
using the shared BVM sandbox supplier GSTIN `29AAGCB1286Q000` (Karnataka
GSP row of the provider's published test sheet) and NIC's canonical test
buyer `29AWGPV7107B1Z1`:

| Step                     | Route                                     | Result                                                                                            |
| ------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Draft direct invoice     | `POST /api/tax-invoices`                  | 201, ₹1000.00 at 18%                                                                              |
| Submit                   | `POST /api/tax-invoices/:id/submit`       | 201 — numbered `WBCFA26/02`, FY 2026-27, intra-state split CGST 90.00 + SGST 90.00, total 1180.00 |
| Register IRN             | `POST /api/tax-invoices/:id/register-irp` | 200 — `irp_provider_state = registered`                                                           |
| Cancel IRN (inside 24 h) | `POST /api/tax-invoices/:id/cancel-irp`   | 200 — `irp_provider_state = cancelled`                                                            |
| Local cancel             | `POST /api/tax-invoices/:id/cancel`       | 200 — permitted exactly because the IRP side was already cancelled                                |

Sandbox artefacts returned and stored as evidence on the invoice row:

- IRN `cf55cac3c1def6343d8471c29288a0d1a5283dae1bab9e6255f83453a9d423ae`
- Acknowledgement `112610258992974`, portal text `2026-08-12 20:18:00`
  retained verbatim beside the derived instant (finding 23 behaviour,
  observed live)
- Signed invoice payload stored (`signed_invoice` present)
- Cancellation evidence appended — reason code `1`, remark, verbatim
  cancelled-at text — with the IRN retained, never cleared

Behaviour confirmed live, matching the provider's own API documents
(received 12 August 2026): authentication (token TTL 1 h in sandbox,
6 h in production — exactly what `gsp/whitebooks.ts` encodes), the
SAC-only service payload accepted by the IRP (`SupTyp B2B`, no HSN
lines), and the 24-hour cancellation window stated on the provider's
CANCEL endpoint. The adapter's endpoint paths and header/query parameter
placement were separately diffed against the provider's OpenAPI specs:
no discrepancies.

## Deliberate friction observed (production posture, not defects)

- The organisation-profile route refused the sandbox supplier GSTIN with
  the named 400 `GSTIN_INVALID`: NIC sandbox GSTINs are deliberately
  non-standard (no `Z` check digit). For certification only, the
  organisation's statutory facts were set with direct SQL on the
  disposable local database. Production organisations carry real GSTINs
  and never hit this.
- The adapter's local guard refused to call out for an organisation
  whose GSTIN differed from `WHITEBOOKS_GSTIN`
  (`WHITEBOOKS_GSTIN_NOT_AUTHORISED`) — thrown before any network call,
  as designed.

## E-way bill leg (added later on 12 August)

A second registered invoice (`WBCFA26/03`, IRN `73a45c13…0400fe`) was
used to attempt e-way bill generation by IRN with a direct provider
call (outside the product, which refuses generation by design). **NIC
refused it with error `4009`: "E Way Bill can be generated provided at
least HSN of one item belongs to goods."** The government portal itself
confirms, live, what the owner's finding-1 decision asserted: this
product's SAC-only service invoices can never carry an e-way bill, so
the generation surface being dead code is correct, and the live
cancellation path is unreachable for any document this product can
produce. Separately, `/ewaybillapi/v1.03/authenticate` succeeded with
the dedicated e-way client pair (`status_cd 1`), proving those
credentials and the adapter's parameter placement. The IRN was then
cancelled at the IRP and locally, leaving the sandbox tidy.

## Honest scope — what this run did not prove

- **E-way bill cancellation (`canewb`)**: not exercised live — see
  above; there is no lawful way to mint an e-way bill from this
  product's documents, and NIC's own 4009 refusal is the evidence. The
  cancel path stays proven by the integration suite (16 tests including
  the single-flight cancellation race), and its endpoint/headers were
  diffed against the provider's OpenAPI spec.
- **Unknown-outcome reconciliation** (`registration_unknown` →
  lookup-only recovery): not reachable through a healthy sandbox
  exchange. It remains proven by the integration suite against a fake
  provider. Note the provider spec's limit: IRN lookup reaches back only
  48 hours after generation, so real-world reconciliation is time-boxed.
- **Production certification**: still gated. The credentials exposed in
  the earlier document set must be confirmed rotated with the provider
  before any `WHITEBOOKS_ENVIRONMENT=production` deployment; the fresh
  bundle received 12 August contains no account secrets, but the gate is
  about the earlier exposure.

## Reproducing

Fill the git-ignored `.env` from the Whitebooks dashboard (sandbox
credentials page; supplier GSTIN must match the organisation's), start
the server with it, and drive the five routes above in order. The
sandbox supplier GSTIN is shared across every Whitebooks developer, so
configure a distinctive tax-invoice number series first — duplicate
document numbers at NIC are refused per GSTIN, not per account.
