# Finding, 13 August 2026: an MB-backed tax invoice bills the wrong amount, twice over

**Status: RULED AND FIXED, 13 August 2026.** Ruling 1 (a) — the server derives
the accepted rate. Ruling 2 (a) — an MB-backed invoice bills the measured total
on the Work's recorded basis. Ruling 3 was moot: the owner confirmed no work
would be done on Auto-MB until both landed, so no interim block was needed.

The analysis below is kept as written, because it is the evidence the rulings
were made on. What changed is recorded at the end, under "Disposition".

This investigates a suspected GST-basis defect in the tax-invoice pipeline,
raised while implementing the per-Work GST basis (migration 0062, PR #40). The
suspicion is **confirmed** — and tracing it end to end surfaced a **second,
larger and independent defect** in the same money path, which was not what the
investigation set out to find.

Both errors push in the **same direction on the ordinary letter**: they
overstate what Auto-MB would invoice the railway. They compound
multiplicatively.

Nothing here is a code change to an amount. Each defect needs an owner ruling,
and the second one needs it more urgently than the first.

## Method

Verified against source and against the real PL-270 document corpus
(`apps/server/test/fixtures/railway-settlement/`, nine documents from one Work:
three Measurement Books, the three IWRCMS bills raised from them, the three tax
invoices raised against those bills). Rate behaviour was verified by **running
the parser** over all six real LOA letters in
`packages/loa-parser/fixtures/`, not by reading it.

The arithmetic below is reproduced as an executable test in
`apps/server/test/tax-invoice-money-basis.test.ts`, so these numbers cannot
rot silently.

## The money path, as built

```
LOA schedule rate
  -> work_items.effective_rate                (loa.ts confirm; pinned by the extracted-value lock)
  -> MB line = qty x coalesce(effective_unit_rate, effective_rate)
                                              (measurement-books/internal.ts:206, mb-compute.ts)
  -> measurement_books.total_amount           (finalize.ts:307)
  -> bills.total_amount                       (finalize.ts:569, MB total copied verbatim)
  -> tax invoice TAXABLE value                (tax-invoices/submit.ts, resolveTaxableValue)
  -> invoice total = taxable + GST            (submit.ts, computeInvoiceMoney)
```

**Nothing anywhere in that chain touches GST, and nothing applies the letter's
accepted-rate percentage.** `grep -n 'gst\|GST' mb-compute.ts mb-remark.ts
measurement-books/finalize.ts` returns nothing at all. `effective_unit_rate` is
set only by the amendment route (`amendments.ts:392`), so it is null until an
approved variation moves an individual item; it is not where a contract-wide
adjustment lives.

## Defect A (the one investigated): the MB total is treated as GST-exclusive

`resolveTaxableValue` (`submit.ts:200-216`) takes the MB total **verbatim** as
the invoice's **taxable** value, and `computeInvoiceMoney` then adds GST on top
of it. For itemised invoices `assertLinesMatchMeasuredTotal` (`submit.ts:231-246`)
enforces that the lines sum to exactly the MB total, so the same assumption is
enforced rather than merely made.

That is correct **only if the LOA rates are GST-exclusive**. Per the owner
ruling of 13 August 2026, they usually are not.

### Evidence from the railway's own bill

`BILL-1.raw.txt` is unambiguous. Its header declares:

```
Rate is inclusive of
GST                         Yes
```

and its footer adds no tax at all:

```
Total Amount(Rs.)                          24516112
Rebate(0.0%)                                    0.0
Bill Amount (Rs.) (Including Tax (GST))    24516112
```

The schedule total **is** the GST-inclusive bill amount. Working one line back,
item 01 carries an Agreement Rate of 2,132,685.00 against a billed quantity of
2.1, and the bill states 4,478,638.50 — `2,132,685.00 x 2.1` exactly. So the
railway computes `qty x agreement rate` and calls the result GST-inclusive.

The settlement closes the loop: `INV-1` states a taxable value of 20,776,366.10
and a total of 24,516,112.00 — the bill amount is the invoice **grand total**,
and the taxable value is that divided by 1.18. The corpus records this as a
named trap: _"the bill total equals the invoice GRAND total, never its taxable
value."_

### Consequence

On a GST-inclusive Work, Auto-MB computes a taxable value that already contains
GST and then charges GST on it again: **the invoice is 18% too high**, and the
customer is a government buyer who will reconcile it against their own bill.

## Defect B (found while tracing, not investigated): the stored rate is the ADVERTISED rate

The extracted-value lock pins `work_items.effective_rate` to the parser's
`unitRate` — the rate printed in the letter's item table. On every real letter
in the corpus, that column is the **advertised** rate. The tender's
accepted-rate percentage (`14.35% Below` on PL-270's Schedule A) is printed at
**schedule** level for a per-schedule letter, and at letter level for a
letter-percentage one. **It is never applied to any rate, anywhere in the
product.**

`letter_percentage` appears in schemas, row types, select lists and one
validation that `per_schedule` forbids it. It is never used in arithmetic.

### Evidence: the parser run over all six real letters

`SUM(qty x printed unitRate)` against each letter's own printed totals:

| Letter    | Shape             | Par         | SUM(qty x rate) | Advertised     | Contract (Net Bid) | sum == advertised | sum == contract |
| --------- | ----------------- | ----------- | --------------- | -------------- | ------------------ | ----------------- | --------------- |
| PL273-JHS | letter_percentage | at par      | 3,046,426.56    | 3,046,426.56   | 3,046,426.56       | yes               | yes (coincide)  |
| PL280-ADI | letter_percentage | 0.5% below  | 4,165,603.32    | 4,165,603.32   | 4,144,775.30       | yes               | no              |
| PL275-BKN | letter_percentage | 29% below   | 7,994,861.18    | 7,994,861.18   | 5,676,351.44       | yes               | no              |
| PL276-GTL | per_schedule      | per sched.  | 63,632,540.00   | 63,632,540.00  | 46,727,651.87      | yes               | no              |
| PL270-CRB | per_schedule      | per sched.  | 195,574,112.38  | 195,574,112.38 | 169,228,497.35     | yes               | no              |
| PL281-BB  | letter_percentage | 24.5% ABOVE | 118,502,769.36  | 118,502,769.36 | 147,535,947.85     | yes               | no              |

The item rates sum to the **advertised value in every single case**, and to the
contract value only on the at-par letter, where the two figures coincide.

This is not a per-schedule quirk: it holds for both pricing shapes.

### Consequence, and a case that runs the other way

Every Work therefore stores rates that disagree with its own
`works.contract_value` by the tender percentage. On PL-270, item 01 is stored at
2,490,000.00 while the agreement rate the railway pays is 2,132,685.00.

The direction follows the letter:

- **Below par (4 of 6 letters, up to 29%)** — Auto-MB **overstates**. Every
  challan value, MB total, bill and invoice is too high, and a Work reaches
  "100% executed value" before it has executed 100%.
- **Above par (PL281-BB, 24.5%)** — Auto-MB **understates**. The contractor
  would invoice 24.5% less than the agreement entitles them to.

It also means `sum(awarded_quantity x effective_rate)` does not equal
`contract_value` on five of six real letters — an internal inconsistency
independent of any invoice.

## The two together, on PL-270 Bill 1

What the railway actually settled, and what Auto-MB would produce for the same
measurement, on Schedule A (14.35% below):

| Quantity                     | Amount            | Source                                             |
| ---------------------------- | ----------------- | -------------------------------------------------- |
| Railway bill (GST-inclusive) | 24,516,112.00     | `BILL-1`, stated                                   |
| Correct invoice taxable      | 20,776,366.10     | `INV-1`, stated (= bill / 1.18)                    |
| Correct invoice total        | 24,516,112.00     | `INV-1`, stated (= the bill)                       |
| Auto-MB MB total             | 28,624,182.14     | bill / 0.8565 — rates stored advertised (Defect B) |
| Auto-MB invoice taxable      | 28,624,182.14     | MB total verbatim (Defect A)                       |
| **Auto-MB invoice total**    | **33,776,534.93** | taxable x 1.18                                     |

**33,776,534.93 against 24,516,112.00 — 37.8% too high**, being
`1.18 x (1 / 0.8565) = 1.3777`. The two factors are independent and multiply.

## Exposure (task 2)

**It cannot be measured from this environment, and I will not guess.** The only
database reachable here is the disposable local test cluster on port 55432,
whose contents are integration-test residue (14 works, 4 tax invoices, 1
MB-backed, 0 IRP-registered). That says nothing about any real deployment.

The owner should run this against production:

```sql
select ti.status,
       ti.irp_provider_state,
       count(*)                                as invoices,
       count(ti.measurement_book_id)           as mb_backed,
       sum(ti.total_amount)                    as total_value
from tax_invoices ti
group by ti.status, ti.irp_provider_state
order by ti.status, ti.irp_provider_state;
```

What each outcome implies:

- **Drafts only** — no legal document is wrong yet. Fix before the first
  submission and there is nothing to unwind.
- **Submitted, not IRP-registered** — the documents are local. Cancellation and
  re-issue is the ordinary path.
- **IRP-registered** — the invoices are lodged with the Government. Correction
  is a **credit note** (the module exists, migration 0051), not an edit; an IRN
  cannot be withdrawn after 24 hours. Each affected invoice needs a credit note
  for the excess and a corrected invoice.

Contextual note, not evidence: migration 0061's own commentary records that
"the product has effectively one user today", which suggests real exposure is
small or nil. **Confirm it; do not assume it.**

## What the owner must rule on

**Ruling 1 — Defect B, the rate basis.** Which rate should `work_items.effective_rate`
hold: the printed advertised rate, or the accepted rate after the letter's
below/above-par percentage? Every downstream money figure follows from this. If
it is the accepted rate, a decision is needed on existing Works (recompute vs
leave, and what happens to challans already issued at the advertised rate).

Note this collides with the extracted-value lock: the accepted rate is
**derived**, not printed per item, so the lock cannot pin it to a printed value.
The rule would need to say that the derived rate is computed by the server from
two locked inputs (printed rate and printed percentage) rather than supplied by
the reviewer.

**Ruling 2 — Defect A, the GST basis.** On a Work whose `gst_basis` is
`inclusive`, what should an MB-backed invoice bill? The corpus answer is that
the taxable value is the MB total divided by `1 + rate`, so the invoice grand
total equals the MB total and matches the railway's bill. Confirm that this is
the intended behaviour, on both cumulative and itemised invoices.

**Ruling 3 — the interim posture.** Until Ruling 2 lands, should MB-backed
invoice submission be **refused** on a Work whose `gst_basis` is `inclusive`?
Refusing issues no wrong document but blocks the billing flow; allowing it keeps
the flow and keeps producing invoices that are 18% high. This is a live choice
today, not a design question, and it is the only one of the three that can be
implemented without knowing the answer to the others.

## Implementation notes for whoever fixes this

- The conversion primitives already exist and are tested against this corpus:
  `convertAmountToBasis`, `toContractBasis` and `toTaxableBasis` in
  `apps/server/src/executed-value.ts` (PR #40). Reuse them; do not write new
  conversion arithmetic, and do not introduce a literal `1.18` anywhere.
- The basis is per Work: `works.gst_basis` and `works.gst_rate` (migration 0062).
- Money is exact integer paise throughout. `convertAmountToBasis` rounds half
  away from zero and is lossy at paise granularity by construction — the corpus
  shows the same one-paisa drift on the real documents, so comparisons take a
  one-paisa tolerance rather than demanding equality.
- Per `CONTRIBUTING.md`, any change here touches **money** and **issued
  documents** and requires fresh human review.

## Disposition

Both defects are fixed. Migrations 0063 (accepted rate) and the existing 0062
(GST basis) carry the schema; `docs/PRODUCT.md` §5.3 carries the rule.

**Ruling 1 — the accepted rate.** `work_items.effective_rate` now holds the
accepted rate, derived by the server from the printed rate and the letter's own
percentage; `work_items.advertised_rate` retains the printed figure so the
derivation can be shown rather than recomputed. The percentage lands on
`work_schedules`, because that is the granularity the letter prints it at — a
per-schedule letter legitimately mixes both percentage and direction across its
own schedules.

The parser was extended to read each schedule's percentage, and the reading
checks itself: the header's bid figure must equal that schedule's own
`Schedule Totals` line, and the percentage must actually carry the advertised
value to it. A reading that fails either check is dropped, and a per-schedule
letter whose percentage cannot be read is now REFUSED at confirmation
(`ACCEPTED_PERCENTAGE_UNREADABLE`) rather than confirmed at advertised rates.

The percentage is read rather than derived by dividing bid by advertised on
purpose: that quotient is 0.85649999… on PL-270 Schedule A, which would put
item 01 at 2,132,684.9997 instead of the 2,132,685.00 the railway's own bill
prints. The derived rates reproduce that Agreement Rate column exactly, to five
decimal places, across every item checked.

End to end: `sum(qty × effective_rate)` now lands on each letter's Net Bid
Value on all six corpus letters, within a rupee. It used to land on the
advertised value.

**Ruling 2 — the GST basis.** `resolveTaxableValue` converts the MB total onto
the taxable basis using the Work's recorded `gst_basis`/`gst_rate`, and
`assertLinesMatchMeasuredTotal` holds itemised lines to the converted figure
(its refusal now names both). A GST-exclusive Work is untouched — the
conversion is identity there. The invoice's grand total now returns to the
measured total, which is the property the railway's settlement has.

**Exposure.** Still not measured from the development environment, and now
moot for the owner's own data: they confirmed on 13 August 2026 that no work
would be done until this landed. Anyone with existing data should still run the
query above before upgrading, and note that Works confirmed before 0063 keep
their advertised rates — the migration deliberately moves no money, and the
remedy is to discard the LOA document and confirm it again.
