# Tally mapping census

**Status: analysis only.** Nothing in this document is implemented, and
nothing in it is authority. It is the survey that the Tally import waves
will be designed from — what the export actually contains, which shapes
are real, and which mapping choices still need an owner ruling.

Read it beside `docs/reference/README.md`: like the rest of this
directory it is evidence, not a contract. When an import lands, the
behaviour it implements belongs in `docs/PRODUCT.md`, a migration
comment, and an ADR — not here.

## Sources and method

| Source | Size | What it is |
| --- | --- | --- |
| `Master.xml` | 133 MB | TallyPrime `All Masters` export, one company |
| `Transactions.xml` | 3.18 GB | All vouchers, 1 Apr 2020 → 19 Aug 2026 |
| Zoho Books `Invoice.csv` | 809 line rows | The 638-invoice historical register PR #167 imports |

Both Tally files are **UTF-16LE with a BOM and no XML declaration**, and
both contain `&#4;` character references, which are illegal in XML 1.0 —
`xml.etree`/expat refuses the file outright. They are also pretty-printed
one tag per line with stable indentation (5 spaces = `<VOUCHER>`, 6 =
voucher field, 7 = ledger-entry field, 8 = sub-allocation field), so the
census was taken with a line-oriented streaming scanner rather than a
parser: one pass over the 3.18 GB, a few minutes, no DOM.

Sign convention in this export: **`AMOUNT` negative = debit, positive =
credit.** A voucher's value is taken as `max(total debits, total
credits)` over its ledger entries; for inventory-mode vouchers the
counter-ledger sits inside the inventory allocations, but the party line
still carries the document total, so the party-line figure is used
wherever a document total is quoted.

**No identifying data appears below.** Counts, per-year sums and
structural group names only; every example of a record shape uses
synthetic values.

---

## 1. Masters census

`Master.xml` carries 22 master kinds. The ones that matter:

| Master kind | Count |
| --- | --- |
| `LEDGER` | 4,327 |
| `GROUP` | 159 |
| `VOUCHERTYPE` | 24 (Tally's default set; none user-defined) |
| `STOCKITEM` | 1,610 |
| `STOCKGROUP` | 52 |
| `GODOWN` | 1 (default) |
| `COSTCATEGORY` | 1 (default) |
| `COSTCENTRE` | **0** |
| `TAXUNIT` | 2 |
| `UNIT` | 6 |
| `CURRENCY` | 2 (INR only, in practice) |

Every master element carries `GUID` and `ALTERID` (verified on a 300-ledger
sample: 300/300 both).

**No cost centres and one godown.** There is no cost-centre dimension and
no multi-location stock to migrate. Whatever per-work analysis the
organisation does today, it does *not* do it with Tally cost centres — it
does it by opening a separate ledger per work (see §4).

### Ledgers by root group

| Root group | Ledgers |
| --- | --- |
| Current Liabilities | 2,372 |
| Current Assets | 1,464 |
| Indirect Expenses | 193 |
| Direct Expenses | 131 |
| Sales Accounts | 56 |
| Purchase Accounts | 39 |
| Fixed Assets | 32 |
| Loans (Liability) | 24 |
| Indirect Incomes | 5 |
| Investments / Capital Account | 8 |
| Misc. Expenses / Suspense / unfiled | 3 |

### The groups that carry meaning for this product

| Group (immediate parent) | Ledgers | What it holds |
| --- | --- | --- |
| `Railway Authority` | 57 | **Railway customers** — one ledger per railway division/office |
| `Amc` | 7 | Railway AMC customers, split out |
| `Sundry Debtors` | 9 | Non-railway customers (PSU/contractor) |
| `Private Parties` | 105 | Private customers |
| `Unbilled Revenue Receivable` | 21 | One per division; work-in-progress receivable |
| `Sundry Creditors` + `Creditors for A–K …` | ~1,850 | **Vendors**, split by purchase category |
| `Sub Contract Advance` | 210 | Subcontractor advances |
| `Railway Security Deposits` | 189 | **SD/retention instruments held by the railway** |
| `IREPS EMD` | 327 | Tender EMDs |
| `Pebpl Bg_<acct>` | 75 | **Bank guarantees (PBG)** issued against a bank account |
| `Fix Deposit with Bank` | 83 | **FDRs** (plus 6 sub-groups per railway account) |
| `Sr.Dfm-<acct>`, `FA AND CAO _<acct>`, … | ~250 | FDR/BG sub-groups keyed by the railway finance office |
| `Bank Accounts` / `Bank OD A/c` / `Cash-in-hand` | 5 / 2 / 1 | **Banks** |
| `GST- TDS` | 3 | CGST TDS 1%, SGST TDS 1%, IGST TDS 2% |
| `Tds on Railway Bills` | 6 | Income-tax TDS suffered, one per division |
| `TDS & SAT AY <year>` (15 groups) | 56 | Income-tax TDS suffered, one group per assessment year |
| `TDS` | 15 | Income-tax TDS *deducted by us* (194C, 194H, salary…) |
| `Contractual Deductions` | 8 | Bill copy, cess, labour cess, conservation, "contractual deduction" |
| `Duties & Taxes` + `GST Input`/`GST Output`/`GST` | 38 | Output/input GST heads |

**344 ledgers carry a v1 work code in their own name** (`PL-<n>`,
`PL <n>`, `PL.<n>`; 196 distinct codes, range 1–282). By group:

| Group | Ledgers with a PL code | of |
| --- | --- | --- |
| `Railway Security Deposits` | 135 | 189 |
| `Sr.Dfm-<acct>` (FDR/BG) | 124 | 201 |
| `Pebpl Bg_<acct>` (PBG) | 52 | 75 |
| `FA AND CAO _<acct>` | 12 | 26 |
| `Fix Deposit with Bank` | 7 | 83 |
| others | 14 | — |

Synthetic examples of the naming shapes actually used:

```
SD <Division> PL-<code>                     security deposit held per work
SD <Division> PL-<code> <Division> AMC      the AMC variant
<fd-account-no>_BG_<Division>_PL<code>      bank guarantee
<fd-account-no>.Sr.Dfm.<Division>.P.B.G. Pl.<code>
FDR No.<fd-account-no> PL-<code>
```

This is the single most valuable fact in the masters: **the security-
deposit, FDR and PBG instruments are already keyed to the v1 work code**,
which is the same `PL-<n>` code `works.work_code` carries and the same one
PR #167's `proposeWorkLink` matches on.

### Voucher types

All 24 are Tally defaults; 11 are actually used (§2). Numbering is
`Automatic` on every type except **`Sales` and `Purchase`, which are
`Manual`** — which is why 341 Sales and 3,401 Purchase vouchers carry no
`VOUCHERNUMBER` at all and the document number lives in `REFERENCE` and in
the bill-allocation name instead.

---

## 2. Voucher census

**83,061 vouchers**, FY 2020-21 → FY 2026-27 (to 19 Aug 2026).

Counts:

| Voucher type | 20-21 | 21-22 | 22-23 | 23-24 | 24-25 | 25-26 | 26-27 | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Payment | 3,767 | 5,466 | 6,975 | 6,063 | 5,266 | 4,705 | 1,586 | 33,828 |
| Journal | 2,144 | 2,389 | 3,646 | 7,189 | 7,194 | 6,765 | 1,849 | 31,176 |
| Purchase | 1,322 | 1,383 | 1,449 | 2,784 | 2,455 | 2,633 | 843 | 12,869 |
| Receipt | 198 | 277 | 421 | 325 | 341 | 336 | 127 | 2,025 |
| Contra | 156 | 213 | 411 | 465 | 303 | 320 | 106 | 1,974 |
| Sales | 124 | 146 | 156 | 224 | 174 | 174 | 54 | 1,052 |
| Credit Note | 3 | 18 | 31 | 8 | 1 | 3 | 5 | 69 |
| Debit Note | 14 | 16 | 4 | 5 | 9 | 11 | 5 | 64 |
| Memorandum / Purchase Order / Delivery Note | — | 3 | — | — | 1 | — | — | 4 |

Value (₹ crore, voucher totals as defined above):

| Voucher type | 20-21 | 21-22 | 22-23 | 23-24 | 24-25 | 25-26 | 26-27 | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Receipt | 16.57 | 20.69 | 22.55 | 71.49 | 62.02 | 61.46 | 29.06 | 283.85 |
| Payment | 14.87 | 19.85 | 21.98 | 65.94 | 53.57 | 63.28 | 28.92 | 268.42 |
| Sales | 16.30 | 18.31 | 21.22 | 69.92 | 51.53 | 54.03 | 22.24 | 253.55 |
| Journal | 15.38 | 19.52 | 27.32 | 70.85 | 53.45 | 38.31 | 6.15 | 230.98 |
| Contra | 5.82 | 11.11 | 17.00 | 53.99 | 41.77 | 40.66 | 17.93 | 188.29 |
| Purchase | 8.62 | 8.22 | 10.58 | 42.57 | 36.12 | 36.79 | 13.78 | 156.68 |
| Credit Note | 0.34 | 1.82 | 2.24 | 0.86 | 0.08 | 0.14 | 0.24 | 5.71 |
| Debit Note | 0.16 | 0.12 | 0.00 | 0.06 | 0.13 | 0.04 | 0.00 | 0.52 |

Hygiene across the whole corpus:

- `GUID` present on **83,061/83,061**; `MASTERID` present on **83,061/83,061**.
- Cancelled: 16 (Sales 6, Credit Note 4, Journal 5, Payment 1). Optional: 3.
- `VOUCHERNUMBER` blank: Sales 341, Purchase 3,401; zero elsewhere.
- `REFERENCE` present: Purchase 12,834, Sales 646, Journal 817, Payment 58, **Receipt 5**.
- `NARRATION` present: Payment 22,310, Journal 18,564, Purchase 11,873, Receipt 1,581, Sales 1,023.
- Inventory (item) mode: Sales 694, Credit Note 21, everything else ≈ 0 —
  i.e. two thirds of sales invoices carry stock lines, the rest are
  accounting-only.

### Shape of each used type

Every type shares the same voucher envelope (`DATE`, `GUID`, `ALTERID`,
`MASTERID`, `VOUCHERKEY`, `VOUCHERTYPENAME`, `EFFECTIVEDATE`,
`PERSISTEDVIEW`, ~150 boolean flags, and a long tail of empty `.LIST`
elements). What differs:

| Type | Distinguishing populated fields |
| --- | --- |
| Sales | `REFERENCE` (the invoice number), `PARTYLEDGERNAME`, `PARTYGSTIN`, `PLACEOFSUPPLY`, `CMPGSTIN`, GST rate details per line, `BILLALLOCATIONS` (`New Ref`), inventory entries on 694 |
| Purchase | `REFERENCE` (vendor's bill no.), `PARTYNAME`/`PARTYLEDGERNAME`, `BILLALLOCATIONS` (`New Ref` 8,463) |
| Receipt | `PARTYLEDGERNAME`, `VOUCHERNUMBER`, bank sub-allocation (`BANKALLOCATIONS`: instrument type, date), `BILLALLOCATIONS` (`Agst Ref` 416) on 407 of 2,025 |
| Payment | `PARTYLEDGERNAME`, `VOUCHERNUMBER`, `BANKALLOCATIONS`, `BILLALLOCATIONS` (`Agst Ref` 13,067) |
| Journal | narration + ledger entries only; `BILLALLOCATIONS` (`Agst Ref` 2,041) on 1,947 |
| Contra | bank-to-bank, `BANKALLOCATIONS` |
| Credit/Debit Note | as Sales/Purchase, plus `ORIGINVOICEDETAILS` |

---

## 3. The railway-receipt pattern

This is the pattern the whole payments import rests on.

### The shape

A railway receipt books the **gross** bill amount to the customer ledger
(credit), the **net** amount actually received to a bank ledger (debit),
and every railway deduction to its own head (debit). Synthetic example:

```
Receipt  date 2024-05-12  party <Railway Division>  vch no 118
  <Railway Division>                     credit  1,000,000.00   gross
  <Bank A/c>                              debit    880,000.00   net received
  SD <Division> PL-<code>                 debit     50,000.00   security deposit
  TDS on Railway Bills AY <nn-nn>          debit     20,000.00   income-tax TDS
  CGST TDS 1%                             debit     10,000.00
  SGST TDS 1%                             debit     10,000.00
  Cess on Labour Portion 1%               debit     10,000.00
  Bill Copy                               debit      1,000.00
  Conservation Railway Bills              debit     19,000.00
```

Gross = net + Σ deductions, always: **0 of 2,025 receipts fail to
balance** (Tally guarantees it, so this is a sanity check on the reader,
not a finding about the data).

### How many follow it

| Population | Count |
| --- | ---: |
| Receipt vouchers, all | 2,025 |
| …with at least one deduction line | **768** |
| …of those, conforming to the proven shape (one credited party line + a bank line + ≥1 deduction, balanced) | **755 (98.3 %)** |
| …deviating | **13** |
| Receipts with no deduction at all (plain collection, refunds, advances) | 1,257 |
| Receipts whose party is a railway customer (`Railway Authority`) | 766 — of which 756 carry deductions |
| Gross booked through receipts, all years | ₹283.85 crore |
| Gross booked through railway-party receipts | ₹227.26 crore |
| Total deductions booked through receipts | ₹20.99 crore |

Receipts per FY, gross / net to bank / deductions (₹ crore):

| FY | Receipts | Gross | Net to bank | Deductions |
| --- | ---: | ---: | ---: | ---: |
| 2020-21 | 198 | 16.57 | 15.51 | 1.06 |
| 2021-22 | 277 | 20.69 | 19.32 | 1.36 |
| 2022-23 | 421 | 22.55 | 20.77 | 1.78 |
| 2023-24 | 325 | 71.49 | 65.32 | 6.17 |
| 2024-25 | 341 | 62.02 | 57.36 | 4.66 |
| 2025-26 | 336 | 61.46 | 57.23 | 4.23 |
| 2026-27 | 127 | 29.06 | 27.33 | 1.73 |

Deduction lines per receipt: 3 → 92, 4 → 166, 5 → 234, 6 → 184, 7 → 51,
8 → 3; 1–2 heads on 38; 0 on 1,257.

### Deviation shapes

All 13 deviations are the same shape: **two credited party lines on one
receipt** (one payment advice covering two customer ledgers, e.g. a
division and its AMC ledger), with the deductions pooled across both.
Nothing else deviates — no receipt is missing a bank line, none is
unbalanced, none has three or more party lines *and* deductions.

One further wrinkle that is not a deviation but will bite an importer:
**77 receipts contain a ledger line with no `AMOUNT` element at all** — a
head named on the voucher with a nil value. A reader that assumes
`AMOUNT` exists will crash or silently drop the line; a reader that
treats it as 0.00 reproduces Tally's own behaviour.

### Bank-party receipts are a different voucher class, not a bad party field

`PARTYLEDGERNAME` names a **bank** ledger on 845 of the 2,025 receipts.
That looks at first like the field being unreliable. It is not: those 845
receipts were re-scanned line by line and **none of them credits a
customer ledger.** What they credit:

| Credited ledger group | Receipts |
| --- | ---: |
| `Unsecured Loan` | 326 |
| `Railway Security Deposits` (deposit released back) | 139 |
| `IREPS EMD` (tender EMD refunded) | 114 |
| Railway-office FDR/BG groups (`Sr.Dfm-<acct>`, `Pebpl Bg_<acct>`, `FA AND CAO _<acct>`) | 134 |
| `Fix Deposit with Bank` (FDR matured) | 14 |
| `Indirect Incomes` (interest) | 31 |
| Bank-to-bank | 34 |
| Staff/travel advances and sundries | ~50 |

So these are **not collections at all** — they are loan drawdowns,
deposit and EMD refunds, and FDR maturities, and `PARTYLEDGERNAME` names
the bank because the bank is the side the operator entered from. On every
receipt that credits a customer, the field names the customer.

Two consequences, both good:

1. `PARTYLEDGERNAME` **is** safe as the customer key on customer
   receipts. The importer still reads amounts from the credited and
   debited lines, but it does not need a fallback to identify the
   counterparty.
2. Bank-party receipts are a separate voucher class with their own
   meaning: 401 of them are **the release side of the SD / EMD / FDR /
   PBG instruments catalogued in §4.5** — the event that closes an
   instrument this product would otherwise only ever see opened. Wave T4
   should treat them as that, not as leftovers.

### Per-bill attribution — the important gap

The sample this pack was briefed with showed head-wise booking with
**empty** `BILLALLOCATIONS`, and the corpus agrees: only **407 of 2,025**
receipts carry a bill reference at all (443 refs, 416 of them `Agst Ref`).
So for most receipts, Tally does not say which invoice was paid.

Where a reference does exist it is good: **365 of the 443 refs are
Zoho invoice numbers**, and 349 receipts reference at least one, settling
**321 distinct Zoho invoices** (₹128.77 crore of receipt gross). The
remaining 58 receipts reference bill names in older shapes (a bare serial,
`A-<n>-<n>-<n>`, `TS/SC/<fy>/<n>`).

Deduction attribution to a *work* is better than attribution to a *bill*,
because the SD head names the work:

| Route to a work, deduction-bearing receipts (768) | Count |
| --- | ---: |
| A bill allocation naming an invoice | 331 |
| A security-deposit head carrying `PL-<code>` | 420 |
| A `PL-<code>` in the narration | 259 |
| **At least one of the three** | **592 (77 %)** |
| None of the three | 176 |

419 of the 536 SD deduction lines carry a `PL-<code>`, and every
deduction receipt that has any SD code has **exactly one** — no receipt
splits security deposit across two works. Across all 2,025 receipts, 690
have at least one attribution route.

---

## 4. Mapping proposal to Auto-MB concepts

### 4.1 Works

Tally has no work entity. Three carriers of the v1 work code exist, in
descending reliability:

1. **Instrument ledger names** — 344 ledgers carry `PL-<code>` (§1).
   Security deposits, FDRs and PBGs are therefore already per-work.
2. **Sales narration/reference** — 716 of 1,052 Sales vouchers (763 of
   1,185 including credit/debit notes) contain a `PL-<code>`; 134
   distinct codes. Many also contain the LOA letter number (64 Sales
   narrations contain the literal `LOA`).
3. **Receipt narration** — 285 of 2,025.

196 distinct PL codes appear in the masters against **38 works imported
at the v1 cutover**, so most codes name a work this system does not have.
The census cannot tell whether the surplus is pre-cutover history, works
deliberately left out, or codes reused for non-work purposes — owner
question 4.

**Proposal:** reuse PR #167's `proposeWorkLink` verbatim — same regex,
same "ambiguity is not a match" rule, same propose-never-commit
discipline — extended to read the *ledger name* as a third haystack. Do
not invent a second matcher.

### 4.2 Contacts

178 customer-ish ledgers (`Railway Authority` 57, `Private Parties` 105,
`Sundry Debtors` 9, `Amc` 7) against 82 Zoho customers; **30 match on a
punctuation-and-case-insensitive name compare**. The rest differ because
Tally names are operational abbreviations of a division and Zoho names are
the legal names. ~1,850 vendor ledgers exist under `Sundry Creditors` and
`Creditors for A–K`; the letter categories are a purchase taxonomy, not a
contact attribute.

**Proposal:** match Tally customer ledgers to existing contacts with
PR #167's `matchContact` (exact after squeeze), leave the rest unlinked
and reportable, and do **not** auto-create contacts from ledger names.
GSTIN is a better key than the name and is present on the ledger master —
owner question 8.

### 4.3 Invoices — the Zoho cross-check

Matching Tally `Sales` vouchers to the 638 Zoho invoices on
`REFERENCE` / `VOUCHERNUMBER` / bill-allocation name (normalised, case-
and punctuation-insensitive), many-to-many, then reconciling by connected
component:

| Measure | Result |
| --- | ---: |
| Tally `Sales` vouchers, all years | 1,052 |
| …linked to at least one Zoho invoice | 621 |
| **Zoho invoices linked to at least one Tally voucher** | **619 of 638 (97.0 %)** |
| Vouchers linked to >1 invoice (one entry, several invoices) | 97 |
| Invoices linked to >1 voucher (one invoice, several entries) | 46 |
| Linked components | 522 |
| …whose Tally total equals the Zoho total within ₹1 | **518** |
| …that differ | 4 (median gap ≈ ₹1.5 lakh, max ≈ ₹36 lakh) |
| Zoho invoices with no Tally voucher | 19 (11 `Void`, 7 carry an IRN, ₹3.06 crore) |
| Tally `Sales` dated ≥ 2023-01-01 with no Zoho invoice | 61 (₹8.37 crore) — 51 pre-date Zoho's coverage, 5 are renumbered duplicates, 1 is a serial collision, 4 unaccounted (below) |

The two systems agree: the Zoho register PR #167 imports is the same
billing history Tally holds, and 97 % of it can be tied together by
number with the value reconciling.

The 61 unlinked Tally vouchers were then read one by one, and they are
**not** evidence of an incomplete export, which is what the first pass of
this census suspected:

- The Zoho register **effectively begins in FY 2023-24** — only 3 of its
  638 invoices are dated before 1 Apr 2023. **51 of the 61 (₹7.88 crore)
  are dated Jan–Mar 2023**, i.e. Tally history from before Zoho was in
  use. They belong to question 23, not question 11.
- **5 are the same document renumbered.** Tally and Zoho agree on the
  5-digit serial and disagree on the two-digit customer-code segment in
  the middle of the number (`P<aa>NNNNN` vs `P<bb>NNNNN`); 4 of the 5
  also agree on amount to the rupee, 3 on date exactly.
- **1 is a false serial collision** — same 5 digits, different customer,
  different amount, five months apart. A serial-tolerant matcher must
  therefore **confirm on amount or customer as well as serial**, or it
  will link two unrelated invoices; serial alone is not a key.
- That leaves **4 genuinely unaccounted for** (≈₹32.7 lakh) — owner
  question 11.

So a serial-tolerant matcher with that guard would raise the linked
population from 619 to ~624 of 638.

**Proposal:** import no invoices from Tally. Instead, write the Tally
voucher's GUID onto the matching `imported_invoices` row as a second
provenance key, so a payment found in Tally can reach the invoice PR #167
already holds. That is a schema change to an immutable register and needs
its own ADR — owner question 12.

### 4.4 Railway receipts → payments with per-bill deduction attribution

Mapping the deduction heads onto migration 0114's five closed heads:

| 0114 head | Tally source | Deduction lines |
| --- | --- | ---: |
| `gst_tds` | `GST- TDS` group (CGST/SGST/IGST TDS) | 1,173 |
| `income_tax_tds` | `Tds on Railway Bills` + `TDS & SAT AY <year>` groups + the IT surcharge head | 793 |
| `security_deposit` | `Railway Security Deposits` group (`SD <Division> PL-<code>`) | 536 |
| `retention` | **nothing** — no ledger in the file contains "retention" | 0 |
| `liquidated_damages` | **nothing** — no ledger contains "LD" or "liquidated" | 0 |
| *unmapped* | 22 ledgers, below | **1,149** |

The unmapped third is the problem. By line count: bill copy 391,
"contractual deduction" 211, labour-portion cess 135, round-off 118,
labour cess 97, conservation 46, postage 45, cess 40, legal 23, water cess
20, and 12 more with ≤7 lines each (including five lines where a
railway customer ledger itself appears on the debit side, and one
`Withheld with <Division> PL-<code>` under `Deposits (Asset)` — the
closest thing in the file to a retention or LD head).

So: **two of 0114's five heads have no Tally counterpart at all, and about
a third of real deduction lines have no 0114 head.** The heads are a
closed union by deliberate design (0114's own comment: a free-text head
makes the receivables arithmetic a sum over whatever anybody typed), so
this is a ruling, not a coding decision — owner questions 13–16.

**Proposal (subject to that ruling):** a Tally receipt becomes one
payment against a work, with per-head deduction lines; the work comes
from the SD head's `PL-<code>` first, the bill allocation second, the
narration third, and an unattributable receipt is imported unlinked and
reported rather than guessed at. `retention` and `liquidated_damages`
stay empty. `Contracual Deduction` (sic) is the one head that plausibly
*is* retention and must not be mapped on a guess.

### 4.5 PBG / FDR / security-deposit instruments

Present and per-work: 189 `Railway Security Deposits` ledgers (135 with a
PL code), 75 PBG ledgers under `Pebpl Bg_<acct>` (52 with a code), 83
FDRs plus ~240 more in per-railway-office sub-groups, and 327 IREPS EMD
ledgers. The ledger name carries the instrument number (FD account, DD
number) and often the division and the work code; the ledger *balance*
carries the amount outstanding.

This is a genuine second source for the PBG/PAC side of the product, but
it is a name-parsing exercise on 900-odd ledger names in at least five
naming conventions, and it has no dates, no expiry and no issuing-bank
field except inside the name. It should be a **later wave, or a report,
not an import** — owner question 18.

The ledgers are only half of it. **401 bank-party receipts are the
release events for these same instruments** (§3): the deposit refunded,
the EMD returned, the FDR matured. The ledger says an instrument exists
and what it is worth; those receipts say when it came back and for how
much. Any instruments wave that reads the names and not the releases
records instruments that never close.

---

## 5. Import-wave proposal

Idempotency keys available, all present on 100 % of rows:

| Object | Key | Notes |
| --- | --- | --- |
| Voucher | `GUID` | Also `MASTERID`, `VOUCHERKEY`, `REMOTEID` attr |
| Voucher edit detection | `ALTERID` | Increments on alteration; the natural incremental cursor |
| Master | `GUID` + name | Ledger names are unique in Tally and are the join key used *inside* the file |
| Deduction line | `(voucher GUID, ledger name)` | No line-level id exists; the pair is unique per voucher in practice |

Proposed order — each wave is independently reversible and reports rather
than guesses:

| Wave | Scope | Volume | Depends on |
| --- | --- | ---: | --- |
| **T1 — masters census (read-only)** | Import nothing. Land a report: ledgers by class, the 344 PL-coded instruments, customer↔contact match, deduction-head inventory | 4,327 ledgers | this document + rulings 1–8 |
| **T2 — invoice cross-reference** | Attach Tally voucher GUIDs to matching `imported_invoices` rows; report the 19 + 61 non-matches | 1,052 vouchers → 619 links | PR #167 merged; ruling 12 |
| **T3 — railway receipts as payments** | The 768 deduction-bearing receipts, head-wise, work-linked where a route exists | 768 receipts, ~3,650 deduction lines, ₹20.99 cr | T2; rulings 13–17 |
| **T4 — plain and bank-party receipts** | The remaining 1,257 receipts. All but four of the 845 bank-party receipts (§3) sit here: loans, interest, and the 401 SD/EMD/FDR/PBG **release** events T5 needs | 1,257 | T3 |
| **T5 — instruments (SD/FDR/PBG/EMD)** | If ruled in at all: name-parse the ~900 instrument ledgers into PBG/PAC records | ~900 ledgers | ruling 18 |
| **not proposed** | Payments (33,828), Journals (31,176), Purchases (12,869), Contra (1,974) | 79,847 | — |

The last row is the point of the ordering: **96 % of the voucher corpus
is bookkeeping this product does not model** and should stay in Tally.
The import is 2,025 receipts and a cross-reference, not 83,061 vouchers.

---

## 6. Open questions for the owner

**Ruling status, 22 Aug 2026.** The owner has ruled on questions 1–8, 10,
12–13 and 15–23. **Those rulings are not transcribed below yet** — their
text has not reached this document, and a ruling paraphrased from a
summary is not a ruling. Each lands here as one line under its question,
and until it does, treat an unannotated question as *answered elsewhere,
not settled here* — do not read the bare question as still open, and do
not start the wave it gates from this file alone.

Recorded so far:

- **9 — superseded, pending spot-check.** The re-scan in §3 answers it:
  the 845 bank-party receipts credit no customer, so `PARTYLEDGERNAME` is
  safe as the customer key. Three vouchers (one each from 2020, 2023,
  2026) are with the owner to confirm the reading in TallyPrime.
- **14 — open.** The owner is reading the underlying vouchers to decide
  whether `Contracual Deduction` is retention or a catch-all. Nothing in
  the deduction mapping (§4.4) can be built until it lands, because it
  decides whether 0114's `retention` head is reachable at all.

1. Is Tally, or is Auto-MB, the system of record for money once this import lands — and if both, which one wins on a disagreement?
2. Does the import run once (a cutover) or repeatedly (a sync)? `ALTERID` supports incremental re-reads, but a re-read that revises an already-imported payment needs a rule.
3. The export is dated 19 Aug 2026 and runs to FY 2026-27; is a fresh export taken at import time, and who takes it?
4. 196 distinct `PL-` codes appear in ledger names against 38 works in the system — are the other ~158 pre-cutover history, deliberately excluded works, or codes reused for something else?
5. Should a Tally-sourced `PL-` code be allowed to *create* a work, or only to link to one that already exists?
6. Ledger names encode division, work code and instrument number in at least five conventions; may we parse them, or is a name a name and the link must be typed by a person?
7. Are the `Creditors for A–K` letter categories meaningful to this product, or purely an accounting taxonomy to drop?
8. May we match contacts on GSTIN from the ledger master rather than on name (30 of 82 Zoho customers match by name alone)?
9. ~~`PARTYLEDGERNAME` names the bank rather than the customer on 838 receipts — confirm we read the counterparty from the credited line instead.~~ **Superseded** by the §3 re-scan: the 845 bank-party receipts credit *no* customer, so the field is safe as the customer key and those receipts are a separate class. Open only for the owner's spot-check of three named vouchers.
10. 77 receipt lines name a deduction head with no amount; import as 0.00, or refuse the voucher?
11. Four Tally sales vouchers inside Zoho's own coverage have no Zoho counterpart at all (≈₹32.7 lakh) — were they raised outside Zoho, or deleted from it? (Re-framed; see §4.3.)
12. May `imported_invoices` (immutable, migration 0115) gain a Tally-GUID provenance column, or should the cross-reference live in a separate table?
13. 0114's `retention` and `liquidated_damages` heads have **no** Tally counterpart — leave them permanently empty for imported payments, or is one of the unmapped heads actually retention?
14. Is `Contracual Deduction` (211 lines) retention, or a catch-all? It is the single largest unmapped head by name.
15. Bill copy, conservation, labour cess, water cess, postage and legal (≈800 lines) are real railway deductions with no 0114 head — add heads, book them as one `other` bucket, or drop them and let gross ≠ net + heads?
16. Round-off (118 lines, ₹111 total) — a head, or arithmetic noise to fold into the net?
17. 176 of 768 deduction receipts have no route to a work at all — import unlinked, hold for manual linking, or skip?
18. Do the ~900 SD/FDR/PBG/EMD ledgers become PBG/PAC records, a report, or nothing?
19. Five deduction lines across four receipts debit a railway *customer* ledger as if it were a deduction head — a correction entry, or a genuine inter-division adjustment?
20. 13 receipts credit two customer ledgers on one voucher with deductions pooled across both — split into two payments by a rule, or refuse and let a person split them?
21. 4 of 522 invoice components disagree in value between Tally and Zoho (up to ≈₹36 lakh) — which system is right, and does the disagreement need to be recorded rather than resolved?
22. Cancelled (16) and optional (3) vouchers exist — skip silently, or import as evidence that they existed?
23. Tally holds sales from FY 2020-21 while Zoho begins Jan 2023; do the 370 pre-Zoho Tally invoices (₹47.49 crore) belong in the historical register too, or does billing history start at Zoho?
