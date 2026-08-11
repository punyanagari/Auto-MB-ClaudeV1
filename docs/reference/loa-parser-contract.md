# DC-32 — IREPS LOA parser contract

Derived from the six real award letters supplied by the CEO — five on
2026-07-27, and **PL281 on 2026-07-28, which is the first `%Above` letter and
settles §7 Q3**. Every claim below was checked against `pdftotext -layout`
output; line numbers refer to that extraction. **This document is the input
contract for DC-33.**

> Not in `docs/`. `docs/` is served by GitHub Pages, and a Pages site is
> publicly reachable even from a private repo unless access control is
> configured. Nothing derived from real award letters belongs there.

## 0. The corpus

| Letter | Zone | Division | Schedules | Items | Advertised (₹) | Net bid (₹) |
|---|---|---|---|---|---|---|
| PL273 JHS | North Central | Jhansi S&T | 1 | 4 | 30,46,426.56 | 30,46,426.56 |
| PL280 ADI | Western | Ahmedabad S&T | 1 | 12 | 41,65,603.32 | 41,44,775.30 |
| PL275 BKN | North Western | Bikaner S&T | 2 | 45 | 79,94,861.18 | 56,76,351.44 |
| PL276 GTL | South Central | Guntakal S&T | 4 | 37 | 6,36,32,540.00 | 4,67,27,651.87 |
| PL270 CRB | Central | Mumbai CST S&T | 5 | 129 | 19,55,74,112.38 | 16,92,28,497.35 |
| PL281 BB | Western | Mumbai Central S&T | 3 | 54 | 11,85,02,769.36 | **14,75,35,947.85** |

**281 items total** (227 + PL281's 54). Treat any future extraction that does
not total 281 on this corpus as a regression. The old bar of 227 refers to the
five-letter corpus and is superseded.

Note PL281's net bid value is **larger** than its advertised value. It is the
only `%Above` letter in the corpus and the only one where `contract_value`
exceeds `advertised_value` — see §1.

All six are the IREPS `publishLOAWorksLetter.do` page printed to PDF. **Every
one carries a real text layer; no OCR is required.** That is the single
largest risk removed — the parser is a text-structure problem, not a vision
problem.

## 1. The finding that governs correctness: two pricing shapes

**Shape A — letter-level percentage.** The totals block reads
`Total Value <advertised> <pct> %Below|%Above|%At Par <net>`, and *every*
`Schedule Totals` line is `0.00`.

    PL273  Total Value   3046426.56  0.00 %At Par   3046426.56
    PL280  Total Value   4165603.32  0.50 %Below    4144775.30
    PL275  Total Value   7994861.18 29.00 %Below    5676351.44
    PL281  Total Value 118502769.36 24.50 %Above  147535947.85

The percentage is **signed by its token**, and both signs are now evidenced:

    %Below / %At Par   net = advertised × (1 − pct/100)
    %Above             net = advertised × (1 + pct/100)

Verified to the paisa on all four. PL281 was supplied on 2026-07-28 precisely
to settle this: `118502769.36 × 1.245 = 147535947.85`, exactly the printed Net
Bid Value. **Applying the `%Below` sign to it instead yields 89469590.87 — an
error of ₹5.81 crore on a ₹14.75 crore contract**, so the sign is not a detail.

`%Above` also breaks an assumption that held across the first five letters:
**`contract_value` can EXCEED `advertised_value`.** On PL281 it does, by
₹2,90,33,178.49. Any schema check, parser clamp or validation that assumes the
contract is at or below the advertised figure is wrong, and would truncate
19.68 % of the contract value — with R4 then capping delivery against a ceiling
a fifth too low, rejecting legitimate challans.

**Shape B — per-schedule totals.** The totals block reads
`Total Value <advertised> <net>` with **no percentage token**, and the
populated `Schedule Totals` lines sum exactly to `Net Bid Value`.

    PL276  8100467.39 + 4016343.66 + 7120536.13 + 27490304.69 = 46727651.87 ✓
    PL270  88677087.41 + 16650896.17 + 45956497.18 + 8629251.20 + 9314765.39
           = 169228497.35 ✓

### Why this is the correctness hinge

In Shape A the per-item `Bid Amount` values printed in the table are at
**advertised** rates. Summing item rows yields the advertised figure, *not*
the contract value. On PL275 that is a **29% error**. Since R4 caps delivery
against contract quantities and values, every challan issued against such a
work would validate against the wrong ceiling.

**Rule:** the parser MUST classify the shape before computing any value, and
MUST record both `advertised_value` and `contract_value` separately. A single
`value` column on `works` is a schema bug.

### The decoy

`Rebate on Total Value (%)` reads `0.00` in all six letters and is **not**
where the discount lives. It is the field a reasonable developer would reach
for first. Do not use it.

## 2. Item-row geometry — the parse that naive regex gets wrong

The item serial number and *all* numeric columns sit on **one line**, and that
line falls in the **middle** of a multi-line wrapped description block.

From PL275 Schedule A, item 1 — the description spans ~24 lines and the data
line is the 14th:

    ...
    supplied in sealed bags of minimum 10 kg = 3 nos. M-BM-)
    Copper strip of 150x25x6 mm, to terminate earth rod
    = 1 no. (d) Copper strip of 300x25x6 mm (MEEB) = 1
    no. (e) Copper strip of 150x25x6mm (SEEB) = 1 no.
 1  (ii) Supply of 35 sq. mm multi strand ...  13010300  8 Lot  17530.73 At Par  140245.84
    insulated copper cable as per IS: 694 for connecting
    ...

**Algorithm:**

1. **Anchor on the par token.** Every item row contains exactly one of
   `At Par` / `Below Par` / `Above Par`. Counting that token gives exactly
   12/37/4/45/129/54 = 281. It is the only reliable per-item anchor.
2. Parse the anchor line right-to-left for `bid_amount`, `par_token`,
   `unit_rate`, `qty_unit`, `qty`, `item_code`; parse left-to-right for
   `item_sno`.
3. In the `-layout` view, **collect the description from lines both above and
   below the anchor**, bounded by the previous/next anchor and by schedule
   headers. This is the conservative no-loss fallback; lines between adjacent
   anchors cannot prove which neighbour owns them and therefore overlap.
4. Bound every item to its schedule using the nearest preceding
   `Schedule <id>-<name>` header.

**Exact description ownership (added 2026-08-11).** Production extraction
runs a second Poppler view, `pdftotext -raw`, from the same PDF. Raw reading
order emits each item serial cell, that row's description cell, and its
numeric tail. Parse it against the already-validated layout schedule/item
sequence, and replace descriptions only when the complete letter passes all
of these gates:

- schedule ids, item serial order, and row count match exactly;
- every raw numeric tuple (`item_code`, quantity, unit, rate, par token,
  amount) matches its layout row;
- every row has exactly one numeric tail and a non-empty description;
- form feeds are split before furniture removal, preserving next-page text
  such as `... 3/7\fthrough HDPE...`;
- a row closes only at the next confirmed serial, schedule total/header, or
  table end — never at its numeric tail, because description prose can
  continue on the next page.

The gate is all-or-nothing. On any ambiguity, retain the conservative layout
descriptions and raise `unresolved_item_description`; never guess or silently
drop prose. Exactness means printed characters in reading order with physical
layout whitespace normalised to single spaces, consistent with other prose
fields in this package.

Do **not** use a leading serial number as a layout-row anchor: it is
left-aligned in a column that also contains wrapped description text. In the
raw view it is accepted only when it equals the next layout-validated serial
for the active schedule and the previous row already has its numeric tail.

## 3. Fields the letters carry

Header/prose block: zone, division, office address, letter number, letter
date, tender number, tender closing date, work description, bid ID, bid date,
contractor name + address, contract value in figures **and** words, EMD amount
+ IREPS reference ID, security-deposit percentages and GCC clause, performance
guarantee amount + submission window + penal interest, completion period,
consignee(s), officer-in-charge, signatory name + designation, GCC version,
and (PL280) a `File No`.

**Letter-number wrap trap.** The letter number is split across lines *by the
date field*:

    Letter No: JHANSI DIVISION-S AND T / JHS-N-
                                                 Dated: 09/02/2026
    W-71-25 / 00341490150678

The true value is `JHANSI DIVISION-S AND T / JHS-N-W-71-25 / 00341490150678`.
A line-wise regex captures a truncated number. Rejoin across the interleaved
`Dated:` line before parsing.

**Print-furniture noise.** Every page carries a browser print header
(`2/9/26, 1:47 PM  ireps.gov.in/...`) and footer
(`https://www.ireps.gov.in/... 1/4`). Strip these before structural parsing or
they land inside description blocks.

## 4. Traps that must raise `needsReview` rather than parse silently

DC-33's charter is "never discards information, `needsReview` on uncertainty".
These are the concrete triggers this corpus proves are necessary.

1. **Prose corrigenda that contradict the table.** PL280 carries:
   *"Due to oversight at the time of floating the tender, the unit description
   for Item Nos. 1 to 6 and 12 in Schedule AB has been indicated as per year
   and it is now be read as per quarter as originally intended."*
   The printed unit is **wrong** for 7 items and corrected only in prose — a
   4× quantity-semantics error if trusted. Any letter containing `NOTE:`,
   `clarification`, `corrigendum`, `to be read as`, or `oversight` must flag.
2. **Quantity decomposed in prose, not columns.** PL273 items read
   `(Qty = 2 nos x 24 month = 48 month)`. The `Qty` column says `48`, the
   deliverable is `2`. Present in 4 of ~~227~~ **281** items (corrected
   2026-08-05 sweep — the denominator predated PL281, added 2026-07-28;
   PL281 adds no decomposition prose, all 4 are PL273's) — rare, so easy to
   miss, and it drives R4's delivery cap.
3. **Payment terms embedded in description prose.** PL275 item text ends
   `Inspection: RDSO Inspection Charges:Borne by Railways Payment Terms: 100%`.
   R10 requires the payment matrix to sum to 100; its source is prose, not a
   column.
4. **Unit vocabulary is dirty — and lives in two places.**
   ~~Observed: `Metre`, `Mtr`, `Nos`, `Month`, `Set`, `Year`, `Lot`, `Km`,
   `Kg`, `Job`.~~ **CORRECTED 2026-08-04.** The prior list mixed unit-COLUMN
   observations with spellings that occur only in description prose; a
   cross-model review of DC-45 caught it after it had propagated into that
   ticket's seed list. Measured via `loadCorpus()` extraction over all six
   fixtures — anchor on the per-item `At Par` token (§2; exactly 281 anchors,
   the Shape-A totals lines carry no `At Par` literal), take the token
   preceding `unit_rate` on each anchor line:

   **Unit-column vocabulary (281 items):**

       Numbers 184   Metre 66   RMT 8   Year 5   Month 4   Pair 4
       Kilometre 3   Set 2   Lumpsum 2   Lot 1   Job 1
       Route Kilo Meter (RKM) 1

   The RKM item (PL276, fixture lines 497–501) has an **empty unit column on
   its anchor line**: the unit wraps across four adjacent unit-column lines
   (`Route` / `Kilo` / `Meter` / `(RKM)`) around the anchor. A parser that
   reads the unit only from the anchor line silently loses it — the wrapped
   unit is itself a `needsReview`-grade trap.

   **Description-prose spellings — alias evidence only, never observed in a
   unit column** (verified: no `Mtr|Nos|Km|Kg` token ever precedes a rate +
   `At Par`): `Mtr` (1 line, PL276:101 "Cable (Roll is 305 Mtr)"); `Nos`/
   `nos` (22 lines across all six letters, e.g. PL275:144 "= 3 nos.", and
   PL270:432 which says outright "quantity 'Nos' is used for" — though
   PL280:132 "Item Nos. 1 to 6" is item-number prose, not a unit); `Km`
   (1 line, PL276:208 "up to 10 Km"); `Kg`/`kg` (2 lines, PL275:144 "10 kg",
   PL275:165 "(Approx.30 Kg)"). `Metre`/`Mtr` are the same unit, but `Mtr`
   is a prose alias, not column vocabulary.

   Normalisation belongs in the `units` master (`DC-8` in the old, lost
   numbering; `DC-45` in the re-derived DAG), not in the parser.
5. **Item-code namespaces differ.** SOR schedules carry 8-digit codes
   (`13010300`); non-SOR carry `S01`. The schedule header names the directory
   (`Item Directory - SOR SNT NWR-Ver-2020` vs `Not Applicable`). Codes are
   only unique within a directory.
6. **Layout junk inside descriptions.** e.g. a stray `M-BM-)` mid-sentence in
   PL275. Descriptions must be preserved verbatim, never "cleaned".

## 5. Unexercised template branches

**CORRECTED 2026-08-05** (enumeration sweep — every count in this section
predated PL281, added 2026-07-28; re-measured against all six fixtures).

Present in the template, empty in every letter — implement defensively and
mark untested:

- `Item Breakup` → "No break up item added" in **6/6**.
- `Rebate on Total Value (%)` → `0.00` in **6/6**.
- `Above Par` → never observed **as an item-row token**; only `At Par` occurs
  (**281/281**). Below/Above are inferred from the totals block, not the item
  rows. The letter-level `%Above` totals token itself IS observed (PL281,
  §7 Q3) and is an implemented, tested branch, not a defensive one.

No longer unexercised:

- ~~`Banned : Rates of the following items are banned for future reference` →
  `NIL` in PL280; absent elsewhere.~~ PL281 **populates** this branch
  (fixture lines 100–101): *"Banned item: Rates of item no 2,6,8,16,17,18 of
  schedule A1 & rates of item no 8,15 of schedule A2 are baneed for future
  reference."* (sic — "baneed" is the letter's own typo; preserve verbatim).
  The label also varies: `Banned :` followed by `NIL` (PL280:140–141) versus
  `Banned item:` prose (PL281:100) — a parser keyed to one spelling misses
  the other. DC-26's "test against the real corpus where the corpus contains
  the case" rule now applies to this branch.

## 6. Schema consequences

- `works` needs **both** `advertised_value` and `contract_value`, plus
  `pricing_shape` and a nullable `letter_percentage` + direction.
- `schedules` needs `directory` (SOR name or null) and a nullable
  `schedule_total`, since Shape A leaves it `0.00` and Shape B populates it.
- The Supply/Labour × SOR/Non-SOR 2×2 in PL276 means schedule identity is not
  a simple ordinal — carry the printed schedule id (`A1`, `B2`) verbatim.
- `work_items` must keep the full description verbatim plus a derived
  `qty_decomposition` that is nullable and flagged when parsed from prose.

## 7. Open questions for the CEO

1. **Redaction before fixtures are committed.** The letters name individual
   railway officers (signatory, consignees, officer-in-charge) and carry
   office addresses. The repo is private, but these are identifiable
   individuals. Commit verbatim, or redact names to role designations?
2. **Contractor identity.** Four letters name one entity; PL270 names a
   different one. Confirm whether these are one tenant or two before the
   fixtures anchor tenancy tests.
3. ~~`Above Par` never appears in this corpus.~~ **ANSWERED 2026-07-28.** The
   CEO supplied `PL281` (Western, Mumbai Central S&T, 3 schedules, 54 items),
   a `24.50 %Above` letter. `%Above` is real, the sign convention is
   `× (1 + pct/100)` verified to the paisa, and its 54 item rows sum exactly to
   the advertised figure — so printed item rates are at advertised rates under
   `%Above` just as they are under `%Below`. DC-33 must implement the branch,
   not flag it. See §1.
