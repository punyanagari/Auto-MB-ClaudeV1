# Auto-MB product contract

## 1. Product definition

Auto-MB is the post-award works-contract execution system for Indian government contractors, beginning with executing agencies and vendors working with Indian Railways.

It helps a contractor move from an awarded Letter of Acceptance (LOA) to defensible delivery, installation, measurement, billing, and payment records.

### First product promise

> Upload the LOA, confirm awarded quantities and rates, issue every Delivery Challan, and always know what was awarded, delivered, and left to supply.

### Primary users

- organisation owner;
- office/documentation staff;
- site staff;
- read-only auditor or accountant.

### Initial market boundary

- Indian Railways works and supply contracts;
- shared multi-tenant SaaS;
- assisted onboarding is expected;
- UI language is operational and calm, not AI-centric.

## 2. First sellable workflow

### LOA intake

1. An authorised user uploads an LOA PDF.
2. The system stores the original privately under an opaque object key.
3. Text extraction and the deterministic LOA parser produce a proposed header, schedules, items, totals, warnings, source spans, and confidence.
4. Uncertain fields retain raw source evidence and a review flag.
5. A human reviews the proposal and **supplies only what the parser could not
   read**. Every value the parser produced and did not flag is read-only — see
   "Extracted values are read-only", below.
6. The reviewer also states the **GST basis** of the letter's rates —
   inclusive or exclusive — and the rate it refers to. This is asked, never
   parsed: LOA letters are silent on GST (the declaration appears on the
   railway's own bill), so there is no extracted value to protect and it is a
   hole the reviewer fills like any other. It defaults to inclusive at 18%,
   which is what an Indian works contract almost always means, and the rate is
   validated against the organisation's notified GST rate master as of the
   letter date. See "Executed value is measured on a recorded basis", below.
7. Confirmation atomically creates the Work, schedules, and items.
8. The new Work then opens with its **payment setup** offered once — the
   stage percentages per category and a payment category per item, in one
   dialog with one Save. Items the reviewer left uncategorised arrive with a
   category **proposed** from their own description (see "The payment
   category decides how an item is executed", below); nothing is written
   until the operator saves, "Later" writes nothing at all, and both editors
   live permanently on the Work's Schedules tab. The prompt belongs to the
   act of creating the Work, not to its address: a revisit, a refresh or a
   shared link opens the Work page plainly. The Work page keeps its own,
   quieter version of the question in place of a returning dialog — while
   any item on the Work would bill through a category that has no matrix
   row, the overview says so in one line and offers the same dialog, and it
   stops as soon as that is no longer true.
   The save itself refuses to leave that state: a payment setup that would
   end with an item resolving to a matrix row which does not exist is
   refused naming the categories, on the server as well as in the dialog,
   because that is precisely the state a Measurement Book would refuse to
   finalize in days later.
9. Empty numeric and category fields are stored as null, never as zero or empty strings.
10. A byte-identical re-upload within the organisation is refused, naming the
    document already held — its filename, upload date, status, and whether it
    became a Work.
11. A letter number matching an earlier document or Work is **not** refused;
    revised and re-issued letters legitimately repeat one. The review screen
    names the earlier intake so the reviewer decides.
12. An intake package that has not become a Work can be **discarded**: it leaves
    the working list with its supporting contract documents, keeps its stored
    object for the retention path, and records who discarded it, when, and why.
    A single supporting document can be discarded on its own. Discard is
    terminal — the repair is to upload the file again.

**No extraction output may directly create authoritative contract records without explicit confirmation.**

**A letter that has become a Work is that Work's source of truth and can never be discarded.**

#### Extracted values are read-only

The letter is the truth source for the Work it creates. Every quantity, rate,
percentage and date recorded against that Work afterwards is measured from what
the letter says, so the review screen presents the extraction rather than
inviting a rewrite of it.

**The rule.** A field is **locked** if and only if the stored parse produced a
usable value for it **and** the parser did not declare that value unverifiable.
Every other field is **fillable**, and the reviewer supplies it.

- The locked set is derived from each letter's own stored parse, never from a
  fixed list of field names: the same field is locked on one letter and open on
  the next, exactly as the parser found it.
- "Usable" excludes a value the wire cannot carry — a quantity read as zero, a
  decimal finer than its column, a date that did not reduce to `YYYY-MM-DD`.
  Locking a value nobody could submit would make the letter unconfirmable, so
  those are treated as holes.
- "Unverifiable" is the parser's own signal at the granularity it publishes:
  a header field's review flag, the totals block's, the performance-guarantee
  clause's, an item row whose printed `qty × rate` does not reconcile to its
  printed amount, a description boundary the PDF's reading order could not
  confirm, and the item flags `unresolved_unit`, `unresolved_item_description`,
  `prose_unit_correction`, `prose_qty_decomposition` and `layout_junk`.
- Filling a hole is answering a question the parser itself asked; it is not
  overriding a truth.

**Not locked**, because the parser never produced them: the work code (the
contractor's own filing reference), the per-Work item number and schedule
labels, the payment category and the initial payment matrix, and any row the
reviewer adds — which stays marked as a manual entry. The rule for the payment
category is precisely **extraction never proposes; the post-creation payment
setup proposes, and the reviewer confirms** — the letter's item table carries no
category, so there is no extracted truth to defend either way.

**Enforcement.** The confirm endpoint compares every locked field in the
submitted payload against the stored parse and refuses a mismatch with
`LOA_EXTRACTED_VALUE_MODIFIED` (400), naming the field, the extracted value and
the submitted one, before anything is written. Dropping a performance-guarantee
requirement the letter demands is refused the same way. The review screen shows
locked values as read-only text for the same reason, but the server is the
control.

**If an extracted value is wrong**, the path is to **discard** the letter and
upload a corrected one — never a silent edit. Removing a parsed row from the
confirmation stays allowed (a re-upload cannot repair a row the parser read out
of layout noise) and is recorded in the audit trail.

**Audit.** The `work.created` event records the lock's verdict: how many locked
values were verified, which letter-level holes the reviewer filled, how many
item-level holes, how many manual rows, and how many parsed rows were omitted.

### Delivery Challan

1. A user creates a draft for a Work and consignee.
2. Lines reference awarded Work items and show awarded, issued, and remaining quantities.
3. At most one open draft Delivery Challan exists per Work.
4. Issue revalidates authorisation and quantities inside the same database transaction.
5. Issue assigns the next per-Work number without duplication or gaps under concurrency.
6. The system stores an immutable issued snapshot and generates a PDF from that snapshot.
7. Cancelling an issued challan requires a note, retains the number forever, reverses its ledger contribution, and never deletes history.
8. A signed-copy attachment may be added after issue.

### Standing choices carry forward to the next Delivery Challan

A Work delivers to the same consignee, under the same number prefix, challan
after challan. Retyping both on every draft is transcription, and transcription
is where a consignee snapshot drifts.

A NEW Delivery Challan draft for a Work therefore opens pre-filled with the
**number prefix, consignee name, address, and phone** of that Work's most
recent ISSUED Delivery Challan. Which challan that is, is decided by the
server, not by the screen, and always this way:

- **Ordered by sequence number, not by date and not by row age.** The sequence
  is assigned when a challan is issued, so it is the Work's true series order.
  A challan back-entered for an earlier despatch, or written to the database
  out of order, cannot displace a later one.
- **Issued only.** A draft is nobody's precedent: it holds no sequence and is
  not a document anyone was handed. A cancelled challan is not a precedent
  either — whatever was wrong with it may be exactly these fields.
- **This Work only.** A standalone challan carries no Work and is never a
  source for one.

The rest follows from that:

- The first challan of a Work is unchanged: the prefix still defaults to the
  Work code, and every other box opens empty. So does a Work whose only
  challans are drafts or cancelled.
- Nothing about the last movement carries: the date is always the
  organisation's today, and quantities and purchase-order receipt links start
  empty. No serial is proposed.
- Editing an existing draft never seeds it from anywhere. The draft is
  whatever the operator saved, down to the boxes they deliberately left empty.
- A seeded draft says where the values came from: one line under the consignee
  block naming the source challan.
- Every carried value is an editable default, not a binding. The consignee
  remains a per-challan snapshot; it is copied, never referenced.

The Issue Challan has its own, deliberately narrower version of this rule
(§8, "Standing choices on a new Issue Challan").

### Delivery Challan module (three movements)

The Delivery Challan is the MOVEMENT document. The Issue Challan is stock
issuance out of a consignee's store and is a different instrument entirely.
Delivery Challans therefore cover three cases, and the register lists all of
them side by side:

| Movement        | Work | Lines                                  | Quantity ledger |
| --------------- | ---- | -------------------------------------- | --------------- |
| `loa_supply`    | yes  | Work items only                        | counted         |
| `work_material` | yes  | Work items plus manual (non-LOA) lines | Work items only |
| `standalone`    | no   | manual lines only                      | never           |

- A **manual line** carries its own description, unit, rate and quantity. It is
  the installation material — poles, bolts, consumables — that rides on the
  same document as sanctioned supply but is on no LOA schedule.
- A **standalone challan** is a despatch to a private customer, a vendor, or a
  job worker. Its consignee comes from the contacts master and is snapshotted
  onto the document at draft time; at most one open draft exists per consignee.
  Its number is gap-free per (organisation, financial year), default
  `DC/{FY}/{SEQ:3}`.
- **Ledger inertness** is the governing rule: only a line that names a Work
  item, on a challan that names a Work, may move the quantity ledger. Manual
  and standalone lines take no purchase-order receipt link, take no serials,
  are invisible to Measurement Book sourcing and to the work-completion maths,
  and never enter the delivery-ceiling check.
- **Reach:** work-scope binds through a Work. A member without organisation-wide
  work scope reaches no standalone challan at all, because no assignment could
  ever grant one.
- Statutory movement facts (HSN, movement reason, party GSTIN) and e-way bills
  for these documents are a later stage and are not part of this module.

### Installation records

An installation record says "N units of item X went in at location L on
date D". It is the evidence behind the installed half of the executed
value, and the authoritative installed quantity is the sum of quantity
over non-cancelled records for the item — computed nowhere else.

- Recording is a site action, not an office one: the location is picked
  from the master or created inline while standing at it, and serial-
  flagged items attach exactly one delivered, uninstalled serial per unit.
- Per item, the cumulative installed quantity never exceeds the sanctioned
  LOA quantity. The excess-delivery permission lifts the delivery ceiling
  only and deliberately does not apply here.
- Records are never edited. A record cancels with a note, keeps its
  history, and releases its serials back to the delivered-but-uninstalled
  pool.
- **Two homes, one record.** Recording and the full record — its serials,
  its remarks, its cancellation — live on the Work, because a record is
  capped by that Work's sanctioned quantity and drawn from that Work's
  delivered serials. Alongside them, a tenant-wide register lists every
  record across Works, newest first, with its Work, item, quantity, date,
  location, serial count and status. Site supervision asks "what went in
  this week, and where" far more often than it asks about one contract,
  and a gang works several Works in a day.
- **Reach.** The register is bounded by Work scope exactly as the Work
  page is: a member without organisation-wide work scope sees only the
  installations of the Works they are assigned to. Cancelled records stay
  listed with their status — the register reports what was recorded, not
  only what still stands. The scope binds the pagination cursor as well as
  the rows: a cursor naming a record outside the caller's Works is refused
  exactly as a nonexistent one is, so the register's paging cannot be used
  to learn that such a record exists or when it was made.
- **Window.** The register's one filter is an inclusive `installedOn` date
  range, because the question it exists for is a date range. It is read a
  page at a time, newest first. Work and status filters are deliberately
  absent: a Work's own records are read on the Work, and a status filter
  would offer to hide exactly what the register keeps visible.
- **Counting.** A Work's page shows how many installation records it
  carries, recorded and cancelled, from the Work read itself. The records
  are loaded only when their section is opened — the list expands every
  record's serials, and a badge does not need them. The same rule holds
  for the two other sections whose registers load on open: the Work read
  carries the formal Measurement Book count and the tax invoice count, and
  each section's badge counts everything the section shows — a book with
  no loose evidence entries, or an invoice with no railway bill, is still
  a non-zero badge. The sections report their own lists back as they load
  or change, so the badges track them without a page reload.

### Quantity ledger

For each Work item:

```text
issued_quantity    = sum(quantity on issued, non-cancelled DC lines
                         that name this Work item)
remaining_quantity = max(awarded_quantity - issued_quantity, 0)
```

The system must prevent issue above the awarded quantity unless the Work explicitly permits excess delivery.

## 3. Domain glossary

| Term         | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| Organisation | A tenant/legal entity using Auto-MB                                      |
| LOA          | Railway Letter of Acceptance defining the awarded contract               |
| Work         | One awarded contract created from one confirmed LOA                      |
| Schedule     | A grouping of awarded lines inside a Work                                |
| Work item    | One awarded description, unit, quantity, and effective rate              |
| DC           | Delivery Challan accompanying moving material (Work-bound or standalone) |
| Manual line  | A DC line that names no Work item: non-LOA material, inert to the ledger |
| Consignee    | Railway/site party receiving material                                    |
| MB           | Record, on-account, or final Measurement Book used for staged billing    |
| PBG/PAC/DOC  | Guarantee, acceptance, and completion lifecycle records                  |
| GST invoice  | Direct or MB-backed tax invoice; locally issued before IRP registration  |
| E-way bill   | Statutory movement record associated with a submitted tax invoice        |

## 4. Initial roles

| Role   | Default authority                                        |
| ------ | -------------------------------------------------------- |
| Owner  | Organisation, users, all Works, sensitive actions        |
| Office | LOA, Works, Delivery Challans, documents                 |
| Site   | Assigned Works, receipts, delivery/installation evidence |
| Viewer | Read-only                                                |

Role is combined with Work scope (`all` or `assigned`) and explicit sensitive-action flags. Four authorities exist, each granted per member by an owner and each defaulting off:

| Authority                        | What it permits                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `can_issue_documents`            | Issue a numbered document                                                                                       |
| `can_cancel_documents`           | Take an authoritative record out of service: cancel an issued document, or withdraw a confirmed Work (§5.6)     |
| `can_approve_amendments`         | Decide an approval request                                                                                      |
| `can_manage_statutory_reporting` | Register, reconcile or cancel a document at the IRP or NIC E-way Bill portal, and record manual portal evidence |

The statutory authority is checked **in addition to** issue or cancel, never instead of either: issuing an invoice and reporting it to the government are separate permissions. Any of the four, or an owner role, obliges the account to enrol in two-factor authentication.

## 5. Business invariants

1. **Work identity:** `work_code` is 1–20 uppercase letters, digits, `-`, `_`, or `/`, begins alphanumeric, and is unique among an organisation's live Works. A **superseded** Work keeps the code it was confirmed under but stops claiming it, so the successor confirmed from the same letter carries the same identity — it is the same contract. Nothing else releases a work code.
2. **Letter identity:** LOA letter number is unique among an organisation's live Works, released by supersession on the same terms as the work code.
3. **One draft:** at most one draft DC per Work, and at most one open standalone draft per consignee contact.
4. **Gap-free issue sequence:** numbers are assigned only at issue, serialised per Work — or per financial year for a standalone challan — and never reused after cancellation.
5. **Quantity ceiling:** issued quantity cannot exceed awarded quantity unless excess delivery is explicitly enabled. Only Work item lines count towards it; manual and standalone lines are inert.
6. **Positive quantities:** quantities are strictly positive; authoritative rates are non-negative decimal values.
7. **No duplicate item line:** one Work item appears at most once in a DC. A challan may carry any number of manual lines, which name no Work item.
8. **Date rules:** document dates are not in the future and not before the LOA date.
9. **Lifecycle:** drafts may be deleted; issued records cancel and remain immutable. Where a table is denied DELETE for retention, its pre-issue exit is a terminal soft state instead — an LOA intake package discards while it is still nobody's Work, and never afterwards.
10. **Snapshot integrity:** issued PDF content is generated from the stored issued snapshot, not current master data.
11. **Rounding:** round each line to two decimals, then sum lines.
12. **Audit:** every create, confirm, issue, cancel, permission change, and destructive action records actor, time, entity, action, and relevant detail.
13. **Tenant boundary:** cross-organisation access always fails, regardless of guessed identifiers.
14. **Work completion:** a Work is marked completed only at 100% executed value — every item's delivered, installed and/or certified quantity, per its payment category, equals its effective quantity exactly — and only with nothing live still holding a claim on it. Completion and reopen each take a note; a completed Work accepts no new operational document until it is reopened. Which quantity an item is measured on is decided by its payment category; see §5.4.
15. **Executed value is measured on a recorded basis:** every Work records whether its LOA rates are quoted inclusive or exclusive of GST, and at what rate. Money is compared against a contract value only after both sides are stated on the same basis. See §5.2.
16. **Settlement rests on the railway's own signed bill:** a finalized Measurement Book is closed, and the bill prepared from it recorded as paid, only against an On-Account Bill received from the railway whose three signatures are intact, chain to an installed trust anchor, and are made by three different certificates. See §5.5.
17. **A confirmed Work with wrong extracted data is superseded, not edited:** a Work whose letter was read wrongly cannot be amended into shape — an amendment records that the contract changed, and nothing changed. It is instead withdrawn by an approved **supersede** request and its letter returned to review, so the letter can be read again. This is available only while the Work carries no downstream document at all, and only through the approval engine; the decider needs the cancel authority as well as the approval authority. See §5.6.
18. **Omission is authorised, not asserted:** omitting an item from a Work after the LOA has been accepted is a contractual variation, not a correction. An omission amendment may be FILED at any time, but it can only be APPROVED once the railway variation order authorising it has been uploaded and VERIFIED against the document itself. The order is never applied on filing, whatever authority the filer holds.

### 5.1 Verifying a variation order

The operator uploads the order and types nothing. The server extracts its
text through the same Poppler-only path the LOA uses and checks a set of
named claims; the omission is authorised only when every required claim is
verified, and a claim that cannot be checked counts as failed.

Required claims:

- the PDF carries a readable text layer (a scan or photograph does not);
- the document is a railway Variation Statement;
- the LOA number it prints matches the Work's LOA letter number, and the LOA date matches the Work's letter date;
- it states a variation number;
- the omitted item appears in its Variation Details table, its proposed quantity there is zero — which is how these orders express an omission, there being no "delete" instruction — and the unit and original agreement quantity it states match what the Work holds.

Advisory, recorded and shown to the approver but not gating: the printed
LOA amount against the Work's contract value. IREPS renders that figure in
seven-significant-figure scientific notation on some orders, and it moves
legitimately with each sanctioned variation.

The variation number is recorded and displayed but NOT required to be
sequential: a Work adopted mid-contract never saw the earlier variations,
and enforcing an order would refuse lawful paperwork.

Refusals are named, at the route and again in the database: an approval
without a verified order is refused, and so is any direct-SQL attempt to
mark such a request approved or to soft-delete the item. A stored order is
immutable evidence — never edited, never deleted.

The same reasoning applies to quantity and rate amendments, which are also
variation orders and which the same document also authorises (it states a
proposed quantity for every item, not only the omitted ones). The owner
scoped this ruling to omissions; extending it is a change of expectation,
not of machinery.

### 5.2 Executed value is measured on a recorded basis

LOA rates are **usually** quoted inclusive of GST — works contracts in India
sit in the 18% slab — but **some** LOAs quote GST-exclusive rates. It is rare,
and it is real. So the basis is a per-Work attribute recorded from its letter,
never a constant in code.

**Why it matters.** Executed value drives work completion, and a Work may be
marked completed only at 100% executed value. The failure is not symmetric:

- Reading a GST-**exclusive** letter as inclusive compares GST-inclusive money
  against a contract value that excludes GST and **overstates** execution by
  the GST factor. Such a Work reads 100% executed at about 85% of its real
  value, so it can be closed with roughly a sixth of the contract still
  unbilled — silently.
- The opposite mistake merely holds a finished Work open, which is visible and
  annoying rather than silent and expensive.

**The rule is "compare like with like", not "divide by 1.18".** Once the basis
is known, executed value is the same percentage whether computed GST-inclusive
(bill totals against the Net Bid Value) or GST-exclusive (invoice taxable
values against Net Bid Value ÷ 1.18) — both sides scale by the same factor.
What must never happen is **mixing** the two, which is the natural mistake:
bills state a GST-inclusive figure while tax invoices state a taxable one, so
reaching for whichever number is nearest moves the answer by the whole GST
wedge. On the PL-270 corpus that is 29.4874% consistent against 24.9893%
mixed, and the ratio between them is exactly 1.18 — which is what makes the
mistake recognisable in a report rather than merely suspected.

**Where the basis comes from.** It is captured at LOA review time and defaults
to inclusive at 18%. It is not parsed, because the letter does not say: the
declaration ("Rate is inclusive of GST: Yes") appears on the railway's own
bill, not on the award. Under the extracted-value rule a value the parser
never produced is a hole the reviewer fills, so this is asked outright, and
the `work.created` audit records the answer and whether a human stated it or
took the default.

**Where it is applied.** Any comparison of money against a Work's contract
value goes through one module, which takes the basis of the numerator as an
argument — a figure whose basis the caller cannot name is a figure it cannot
compare. Cross-Work aggregates restate every term as taxable value first, so a
portfolio holding both kinds of letter aggregates coherently.

**The tax invoice.** An MB-backed tax invoice bills the measured total on the
Work's recorded basis. On a GST-inclusive Work the taxable value is the
measured total less the tax already inside it, so the invoice's **grand total**
comes back to the measured total — which is the property the railway's own
settlement has: their bill amount is the invoice's grand total, never its
taxable value. On a GST-exclusive Work no conversion happens. Itemised lines
are held to the converted figure, not the raw measured total.

**Known gap.** The per-Work money figures on the dashboard (contract,
delivered, billed) are still added as printed rupees across Works. On a
portfolio mixing bases that sum is not on any single basis. It is left that way
deliberately — stating it correctly would drop a visible tile by a sixth for
today's all-inclusive portfolio — and is an open question for the owner rather
than a settled expectation.

### 5.3 Rates are the ACCEPTED rates, derived from the letter

An LOA's item table prints **advertised** rates. The tender result — `14.35%
Below`, `24.5% Above` — is printed once per schedule on a per-schedule letter
and once for the whole letter otherwise, and it is what turns an advertised
rate into the rate the railway actually pays.

**The rule.** A Work item stores both: `advertised_rate` as printed, and
`effective_rate` as the **accepted** rate the server derives from it. Every
money figure — challan values, Measurement Book totals, bills, invoices,
executed value — is computed at the accepted rate.

- The percentage is **read from the letter**, never derived by dividing the
  schedule's bid total by its advertised total. That quotient does not
  reproduce the railway's own Agreement Rate exactly, and matching it exactly
  is the point.
- It is recorded per **schedule**, because that is the granularity the letter
  prints it at: one letter legitimately mixes percentages _and_ directions
  across its own schedules. A letter-percentage letter's single figure is
  recorded on every schedule, so no reader has to branch on pricing shape.
- The reading **checks itself**: the schedule header's bid figure must equal
  that schedule's own totals line, and the percentage must actually carry the
  advertised value to it.
- A per-schedule letter whose percentage cannot be read is **refused** at
  confirmation. Confirming it at advertised rates would make every future
  money figure wrong by the tender percentage, silently.
- A row the reviewer **adds by hand** is not adjusted. It carries no printed
  rate to move, and applying a tender rebate to a hand-entered figure would
  change a number a human chose deliberately.

**Why it matters.** Before this rule the product stored the printed rate, so
`sum(awarded_quantity × rate)` came to the letter's advertised value rather
than its Net Bid Value. The error followed the letter: below par (four of six
real letters, up to 29%) it overstated every figure, and above par it
understated them — the contractor invoicing a quarter less than the agreement
entitled them to.

### 5.4 The payment category decides how an item is executed

An item's payment category is the product's single answer to "how is this
item executed, and how is it paid". It selects three things at once: which
quantity the completion predicate measures, which base the final-bill stage
earns on, and which per-Work payment-matrix row supplies the four stage
percentages. There is deliberately no second classification axis — no
per-item completion basis and no per-item percentage entry — because two
axes can contradict each other and the contradiction has no meaning.

| Category                  | Executed when                                                    | Recorded by              |
| ------------------------- | ---------------------------------------------------------------- | ------------------------ |
| `SUPPLY`, `SPARE_SUPPLY`  | fully delivered                                                  | issued Delivery Challans |
| `PURE_INSTALLATION`       | fully installed                                                  | installation records     |
| `SUPPLY_AND_INSTALLATION` | fully delivered **and** installed                                | both                     |
| `AMC`                     | fully certified                                                  | acceptance certificates  |
| uncategorised             | installed if the description says "installation", else delivered | as above                 |

**AMC is the annual-maintenance category.** A railway LOA routinely prices
maintenance as its own schedule quoted in `Year` — the flagship corpus
letter PL270-CRB carries two, together about 16% of its net bid value.
Nothing is ever delivered against such an item and nothing is ever
installed against it: a period of maintenance is served, and the railway
certifies that it was. So an AMC item is executed by certified quantity,
and three rules follow.

- **No movement record may name an AMC item.** A Delivery Challan line or
  an installation record naming one is refused at the API and again by a
  database trigger. Moving an item that already carries movement into the
  category is refused for the same reason, and names the holding
  documents.
- **Certification caps at the sanctioned quantity, not the installed
  total.** Every other item is capped at what was installed, because a
  certificate accepts work that exists. An AMC item has no installation
  at all, so that ceiling would be zero; its ceiling is the sanctioned
  quantity, which is the ceiling installation itself already carries.
- **An AMC matrix row bills only on the certification and final-bill
  stages.** Its supply and installation stage deltas are permanently
  zero, so contract value parked on either could never be billed.

**How an item gets its category.** Three moments, in order, and none of
them guesses silently.

- **LOA review.** The reviewer may set a category per row while confirming
  the letter. Extraction proposes nothing here: the letter's item table
  does not carry a category, so there is no extracted value to protect.
- **The payment setup offered once after the Work is created.** Every item
  still uncategorised is offered a category read from its own description,
  shown as a **proposal** beside the item and saved only if the operator
  saves. The reading is by keyword, in a fixed order: maintenance wording
  proposes nothing; supply and installation wording together propose
  `SUPPLY_AND_INSTALLATION`; installation wording alone — including the
  trade verbs a railway schedule uses instead, such as laying, erection,
  commissioning, blowing, jointing, termination, splicing and trenching —
  proposes `PURE_INSTALLATION`; supply wording alone proposes `SUPPLY`;
  anything else proposes nothing and the item stays uncategorised. So
  "Supply and laying of armoured cable" is supply-and-installation, and
  "Laying of PVC cable" is pure installation. Two trade words, **cutting**
  and **fixing**, count only on a line that says nothing about supply: they
  are also how a schedule names goods — a "rock cutting machine", "GI
  fixing clamps" — so on a supply line they describe the merchandise, and
  reading them as work would split the item's value across a stage no
  quantity ever moves through. `SPARE_SUPPLY` and `AMC` are never proposed:
  a spare is a supply line by its words and only the contract distinguishes
  it, and a maintenance schedule is recognised by its heading and its
  `Year` unit rather than by a word in the row — where a wrong guess is
  expensive in both directions.
  Save commits the proposals still standing when it is pressed, including
  the ones below the fold, and says how many it is about to commit. Each
  is recorded on its audit event as an accepted proposal rather than as a
  typed choice, so a category that later turns out wrong can be traced to
  the act that set it.
- **The Schedules tab, at any time afterwards**, until a Measurement Book
  bills the item.

A proposal is not a default and not extraction: it is a suggestion a human
accepts, changes, or ignores, and it is written only by the save that
follows. An item left uncategorised keeps behaving exactly as the table
above says — installed if its description mentions installation, else
delivered — which is the fallback the proposer exists to make unnecessary
rather than to replace.

**Why it matters.** Before the category existed, an AMC item fell through
to the uncategorised rule; a maintenance description does not contain the
word "installation", so it resolved to _delivery_. The completion
predicate then demanded that five years of maintenance be delivered, which
no honest document can record. Completion was unsatisfiable on any Work
carrying a maintenance schedule unless somebody issued a Delivery Challan
claiming the years had moved as goods. The rule "100% executed value" is
unchanged; what changed is that an AMC schedule can now reach it.

### 5.5 The received railway bill

Every other document in the chain is one the agency **writes**. The railway's
On-Account Bill is the one it only ever **receives**: IWRCMS raises it from a
finalized Measurement Book, the contractor signs it, the engineer's
representative signs it, the Sr. DSTE signs it, and it comes back as a PDF.
It is the document that says the railway agreed, and until it exists the
measurement is outstanding with the railway however complete the agency's own
paperwork looks.

**Nothing about it is typed.** The bill number, its date, its GST-inclusive
amount, the agreement and letter it is raised under, and the measurement it
settles are all extracted from the uploaded PDF's own text layer, through the
same Poppler-only path the LOA and the variation order use. There is no field
for an operator to assert any of them. A bill number somebody typed is a
claim; one found in the bill is a fact.

**The link is by measurement sequence, never by string.** The Measurement Book
prints `…/OAM/L2/02` and the bill raised from it prints `…/OAM/FL2/02`. The
`L2` → `FL2` change marks the ledger as finalised: it is not an error and not a
different measurement. Matching the raw strings would silently fail to link
every pair, and a link that never happens reports nothing. The bill is
additionally refused if the letter number it prints is not the Work's.

Two further properties of the paper, both of which a naive check gets wrong:
the number **wraps across lines** in the extracted layout, arriving as two
fragments on either side of its own label; and an invoice may legitimately be
dated **before** the bill that settles it, so no ordering is enforced between
them.

**The verdict, and what it gates.** The signature verdict is taken once, at
upload, and stored beside the bytes as evidence. Per the owner's rulings of
13 August 2026 a bill may settle money when its signatures are intact and its
chains reach an installed trust anchor — and **certificate expiry is ignored**.
Indian signing certificates run two to three years, these bills carry no
trusted timestamp, and treating expiry as fatal would eventually refuse every
bill the agency holds, for no change in any document. What expiry cannot excuse
is a modified document or an unknown issuer.

**The three signatures must come from three different certificates.** Owner
ruling, 14 August 2026, extending the gating rulings above. The earlier wording
was satisfied by one certificate signing the same bill three times — three
intact signatures, three chains to a configured anchor, no expiry complaint —
and any DSC reaching an installed anchor qualifies, including the agency's own,
because a trust anchor says who issued a certificate and nothing about who
holds it. That is not what the three signatures on an On-Account Bill mean: the
contractor claims the measurement, the engineer's representative accepts it,
and the Sr. DSTE authorises payment against it, and three impressions of one
key is one person doing all three. Certificates are compared by issuer and
serial — RFC 5280's own identity for a certificate — and never by printed name,
because a subject is a string any issuer may put in any certificate.

What the rule deliberately does **not** claim: it says nothing about who
signed, in what order, or whether any of them is a railway officer. Those are
identity claims a trust anchor cannot support and this product keeps no
register to check against. Distinctness is the strongest statement the evidence
carries.

A bill is always **recorded**, whatever its verdict says: refusing to file a
document because its verdict is inconvenient loses the very record that proves
it. Two later acts are gated instead:

1. **Closing the measurement.** A finalized Measurement Book closes only
   against a recorded bill whose verdict passes. Closure is append-once, and a
   closed book can no longer be cancelled or take further bills.
2. **Recording payment.** A prepared bill moves to `paid` only once its
   Measurement Book is closed — on insert as well as on update, because a bill
   row may legitimately be created in any of its three states.

**Both are enforced in the route and in the database, and the two layers do
different halves.** The database enforces the _structural_ facts: the closing
bill exists, belongs to this organisation and to this Measurement Book, is not
discarded, carries a settleable stored verdict, and holds at least three
signatures; and no bill becomes `paid` while its book is open. The
_per-signature_ rule — integrity, reaching a configured anchor, three distinct
certificates, the last signature covering the file — lives in one place in the
server, because it is the owner's judgement rather than a fact about the schema
and is expected to be revisited. Stating the split this way is deliberate: "it
is enforced twice" would suggest two copies of one rule, and two copies of a
subtle rule drift apart.

**Every act on the bill shows on the Work's timeline.** Recording a bill,
discarding one, and closing a measurement against one are audit events, and
`received_railway_bills` is a timeline entity type: the events appear in the
Work's activity trail, can be filtered like any other record type, and each
bill answers its own per-record history. A standing census test
(`audit-timeline-census`) holds every audited entity type against the timeline
whitelist, so the next document kind cannot repeat the gap this closed —
its events either join the timeline or are documented as off it.

Note that "closed" here is a railway fact and is deliberately separate from the
older sense in which a submitted tax invoice closes the Measurement Book it
bills. The two are independent, and a measurement can be invoiced before its
railway bill arrives.

### 5.6 Superseding a confirmed Work

The awarded LOA baseline is immutable and an omission needs a railway
variation order. Neither helps when the extraction itself was wrong — the
rates read at advertised figures, a mistyped letter number, a quantity off
by a decimal place. §5.3 records exactly this case: Works confirmed before
the accepted-rate rule still carry advertised rates, and the remedy is to
read the letter again. Until a Work can be withdrawn, there is no way to
read it again, because a confirmed letter cannot be discarded.

**The exit.** An owner or office member files a supersede request against
the Work, with a reason. It never applies on filing, however much authority
the filer holds. An approver who also holds the **cancel** authority decides
it; approving withdraws the Work and returns its LOA document to review, in
one transaction. The letter is then an ordinary unconfirmed intake package
again: it can be reviewed and confirmed into a successor, or — when the
scan is the problem — discarded and uploaded again.

**Eligibility.** Only a Work with **no downstream document at all**. The
seventeen registers that block it, in full: delivery challans, issue
challans, installation records, Measurement Books, Measurement Book merge
records, Measurement Book entries, tax invoices, credit notes, PAC
certificates, correction notices, submitted instruments, bills, extension
requests, purchase orders, received railway bills, cited variation orders,
and live change requests (a pending or approved approval request; a
rejected or withdrawn one moved nothing and does not block). Anything
issued or received means the Work is corrected through the paths that
already exist. Per-Work numbering counters, the lines and evidence hanging
off those registers, and the Work's own body — schedules, items, payment
matrix, consignee preferences, assignments — are not documents in their
own right and do not block.

**The successor's identity is not the confirmer's to choose.** The Work
confirmed in the released letter's place carries the withdrawn Work's work
code and letter number, unchanged; anything else is refused. An approver
reads a reason for withdrawing a contract and approves _that_ — if whoever
confirms the letter afterwards could file it under any code, superseding
would be a work-code rename with no approval behind it. While the
supersession is open, that identity is also **reserved**: no other letter
may take the freed code or letter number. A genuinely wrong work code is
corrected the way every other wrong extracted value is — discard the
released letter and upload the correct one.

**Assignments travel.** A member whose `work_scope` is `assigned` sees a
contract only through its assignments, so the successor inherits the
withdrawn Work's, audited. A correction must not silently revoke site
access to the work being executed.

**The letter's package is held together.** While a released letter is
waiting to be confirmed again, its supporting tender documents cannot be
discarded one at a time — the letter itself still can, which withdraws the
whole package together.

**What survives.** The withdrawn Work is soft-deleted, never removed: its
items, its rates and its reason for withdrawal stay answerable. A
supersession record carries the withdrawal, the approval that authorised
it, the released letter, and — once the letter is confirmed again — the
successor. The successor's own page shows what it replaced, the reason
given, and the date; the withdrawn Work itself is not openable, which is
why that line is the only place its identity survives. Numbering is
untouched: the successor is a new Work with its own counters, and no
number a superseded Work's series reached is ever minted twice.

**One case has provenance in one direction only, by design.** If the
released letter is discarded and a corrected copy uploaded instead, the
Work confirmed from that new upload is a fresh record with no link back:
the link is kept on the document, and that document was thrown away. The
supersession still records the withdrawal, its reason, its approval and
the letter that was released — it simply names no successor. The screen
says so before the operator commits to the discard. Linking a re-uploaded
letter to the Work it replaces would need a step the product does not have
and has not been asked for.

### 5.7 The payment, and what the railway kept

Until the payment register existed, `bills.status = 'paid'` was the whole of
this product's knowledge of money received: a word, with no amount, no date,
no reference and no breakup. Both reviews of 13 August 2026 said the same
thing about it — the spreadsheet an operator still keeps beside this product
is the payment register, because a railway payment is never the bill amount.

**A payment is three figures, never one.** What reached the bank, what the
railway withheld, and what is still owed. The distinction is the point:

- **GST TDS**, 2% under section 51 of the CGST Act, which the deductor
  deposits and the agency reclaims in GSTR-7A;
- **income-tax TDS** under section 194C, which surfaces on Form 26AS;
- **security deposit / retention**, held by the railway against the contract.
  This product records that it was withheld and nothing more: there is no
  release path, no schedule of what is due back and no reconciliation
  against what was eventually returned, so a retention figure here answers
  "how much has been held" and never "how much is still held";
- **penalties and recoveries**, argued individually;
- **other**, which is the head that always turns up and is the only one that
  cannot be recorded without saying what it is.

Each is a typed row rather than free text or a nullable column, because each
is a different conversation with a different authority on a different form.
A named head may appear once per payment; two `other` rows on one advice are
two different facts and both stay recordable.

**A deduction is an operator's assertion, not evidence.** Everything about
the railway's own On-Account Bill is extracted from the document and nothing
about it can be typed (§5.5). A deduction is the opposite: somebody reads a
payment advice and enters what it says, and this product holds no copy of
that advice and no certificate behind any head. The register is therefore as
good as the person keeping it — which is a large improvement on a
spreadsheet nobody audits, and is not the same claim the railway bill makes.
Two consequences follow and are stated rather than left to be discovered.
The register cannot be used as proof of a TDS credit; GSTR-7A and Form 26AS
remain the proof, and this is the working note beside them. And because
receipts and deductions are the same arithmetic to the settlement rule, an
operator who can record payments can reach `paid` by asserting a deduction
for the whole shortfall — see the open question at the end of this
section.

**Deducted money is settled money.** A bill of ₹10,00,000 credited as
₹9,52,000 is fully settled if ₹48,000 went to the heads above, and 4.8%
outstanding if it did not. One of those is a closed matter and the other is a
phone call, and a register that reports a single net figure cannot tell them
apart — it reports every bill as short by its own statutory deductions,
forever. So:

    outstanding  =  what the railway settled  −  received  −  deducted

**What "the railway settled" means, and why it is not the prepared amount.**
The reference is the amount on the railway's own On-Account Bill (§5.5),
reached through the Measurement Book that bill closed — never the total the
agency prepared. Two reasons, and the second is load-bearing. The railway pays
its own bill, so where its certified figure differs from the prepared one the
difference is a conversation about the measurement rather than an unpaid
balance. And a bank credit is GST-inclusive, always, as is the railway's bill
amount; the prepared total is on the Work's recorded basis and is
GST-exclusive on a GST-exclusive Work. Subtracting one from the other is
exactly the mixing §5.2 names as the natural mistake. Both figures are
reported so a difference between them is visible; only the railway's is
subtracted from.

It follows that **a payment cannot be recorded before the measurement is
closed**: until then there is no agreed figure to be outstanding against, and
the position reports no outstanding amount at all rather than reporting the
prepared amount as a debt nobody has acknowledged.

**The landing screen says which position a bill is in.** A bill that has not
reached `paid` raises one of four signals on the dashboard, because a single
sentence for all four was the register's own conflation restated on the one
screen every session opens with. Nothing received or deducted; part settled,
against a railway figure that is partly covered; settled in full, waiting
only for the status to be moved by hand; or awaiting closure, where the
measurement is still open and the outstanding amount is unknown rather than
zero. The first three carry the railway's figure and the three figures of
the position beside them; the fourth carries none, because there are none to
carry. All of them are read from the settlement position itself — the
dashboard states the position, it does not compute a second one.

**`paid` stops being a word.** A prepared bill moves to `paid` only when the
receipts and their deductions between them reach the railway's figure exactly.
The status stays a MANUAL act — every state change in this product is an
explicit, audited transition, and a status that flipped itself the moment a
sum crossed a threshold would be the only one nobody performed. What changed
is not who performs it but what it is allowed to assert: `paid` may now only
be claimed where the register supports it, as an issued document may only be
claimed where its evidence does.

**Settlement and submission are independent.** Nothing requires a bill to
have been submitted before money is recorded against it. The status machine
still runs forward only, so a bill cannot reach `paid` without passing
through `submitted`, and the position tells the truth at every point in
between; a bill fully settled while still `prepared` is an unusual record
rather than an impossible one, and refusing it would police an ordering the
paper does not have.

**A receipt is never edited and never deleted.** A mis-keyed one is
**withdrawn** with a required reason: the row and the reason stay, and the
amount becomes outstanding again. Once a bill is paid its register is closed
in both directions — nothing may be added and nothing withdrawn — because the
arithmetic that made it paid would stop holding and `bills` moves forward
only. The correction is a compensating entry against a later bill, which is
the remedy ADR-0006 already prescribes for a billed Measurement Book.

**Open question: settlement by asserted deduction.** The two rules above
compose into a gap the owner should close deliberately rather than by
accident. Because a deduction settles a bill exactly as a receipt does, and
because a receipt of zero is legitimate, a member holding the issue
authority can mark a bill paid by recording nothing received and one
deduction for the entire outstanding amount. Every step is audited and the
row names its author, so this is visible after the fact rather than silent —
but nothing refuses it at the time. Three mitigations are available and none
is applied yet: cap the deductions of a receipt relative to what it credits;
require a separate authority for a settlement that credits nothing; or
accept it as an operator judgement and rely on the audit trail. Recorded
here so the next reader does not mistake it for an oversight.

**Both layers, doing different halves**, on the same terms §5.5 states for the
railway bill. The database owns the arithmetic and the structure: that a
reference figure exists, that the running total never passes it, that a
recorded fact never changes, and that `paid` is unreachable while anything is
outstanding — on insert as well as on update, because a bill row may be
created in any of its three states. The server owns authority, work scope, the
audit trail, and saying all of it in a sentence rather than a SQLSTATE.

### 5.8 A letter is read after it is accepted, not before

Uploading an award letter used to wait for the whole of its reading:
Poppler extracting the text, the parser reviewing it, and the digital
signatures being verified, all before the upload answered. On a large
scanned letter that was tens of seconds during which the uploader saw
nothing and a request thread, a database connection and a browser tab were
all held open.

Since pack P18 the upload answers as soon as the letter is **accepted**,
and the reading happens behind it:

1. the bytes are proven to be a PDF by their signature, not their declared
   type;
2. they are scanned for malware, and a letter that fails is refused —
   nothing is stored;
3. they are written to object storage and the document row is created in
   the **`Pending`** state;
4. a job is enqueued, and the worker extracts the text, runs the parser
   review and verifies the signatures, moving the document to
   **`Review`** (or `Failed`, if the letter has no readable text).

**Pending is a state the product states, not a spinner.** The document
appears in the register immediately, its own screen says the letter is
being read rather than showing an empty review, and nothing offers to
confirm a Work from a letter that has not been read yet. That is the
honest shape: the letter genuinely is in the product, and its contents
genuinely are not known yet.

**Two things arrive later than they used to**, and both are stated rather
than hidden. The warning that another document already carries the same
letter number now appears with the extraction instead of with the upload,
because the parse that finds the number has not run at upload time. And
the signature verdict — who signed, and whether the file was modified
after signing — arrives with it, for the same reason.

**The malware scan deliberately did not move.** It is the one operation of
the four that is an admission gate rather than post-processing. Today
nothing unscanned is ever written to object storage, because the scan
happens before the write; an asynchronous scan would have to store the
bytes first and then hold the much wider promise that nothing unscanned is
ever _served_ — across every download, render and export path in the
product. That is a weaker property guarded in more places, and the reason
it was not taken.

**A job runs as the person who caused it.** The worker holds no authority
of its own: it re-proves, in the database, that the uploader still belongs
to the organisation before it touches anything. A user removed from the
organisation between uploading a letter and the letter being read leaves
the job parked and visible rather than silently run on their behalf; an
administrator re-requests the reading under a live user. This is ADR-0011,
and it is why there is no service account anywhere in the product.

## 6. Data conventions

- Calendar dates are stored as PostgreSQL `date` and represented as `YYYY-MM-DD` in APIs.
- Money is PostgreSQL `numeric`, represented as decimal strings at API boundaries.
- Original filenames never become storage paths.
- Issued records are never hard-deleted.
- A superseded Work keeps its identity on the record and releases the organisation's live claim on it (§5.6); nothing else releases a work code or letter number.
- All tenant-owned tables include `organisation_id`.

## 7. First-release acceptance

A design partner can:

- create an organisation and users;
- upload one of the real LOA fixtures;
- review and confirm extraction;
- create a Work;
- draft and issue a DC;
- print/download the issued PDF;
- upload a signed copy;
- see awarded, issued, and remaining quantities;
- inspect an audit timeline;
- remain isolated from every other organisation.

## 8. Implemented expansion beyond the first release

The current product also includes:

- completion extensions, approval-gated baseline amendments, item omission
  gated on a verified railway variation order, correction notices, Work
  completion/reopen, and per-Work activity history;
- Issue Challans, receipts, serial traceability, quantity installations
  (recorded on the Work, and listed tenant-wide in their own register),
  warranty certificates, instruments, and PAC certificates;
- record, on-account, and final Measurement Books with category payment
  matrices, stage-wise billing, immutable snapshots, and generated documents;
- the railway's own received On-Account Bill, linked to the Measurement Book
  it settles by measurement sequence, with every fact extracted from the PDF
  and a three-signature verdict that gates measurement closure and payment
  (§5.4);
- vendor contacts, purchase orders, and budgetary quotations;
- MB-backed and direct GST invoices with configurable numbering, exact GST
  split and whole-rupee rounding, immutable supplier/buyer/ship-to snapshots,
  explicit NIC locality and forward-charge confirmation, deterministic IRP
  payloads, and append-only downloadable PDF versions rendered from frozen
  invoice facts, frozen branding, and append-only IRP evidence;
- an org-editable GST rate master of Government-notified rates with
  effective-date windows: invoices, quotation lines, and stated purchase-order
  line rates must carry a rate the master notifies on the document date
  (re-checked when the invoice is submitted, and enforced again by a database
  trigger); rates retire by end-dating only, and changes are owner-only and
  audited;
- optional, operator-triggered Whitebooks B2B IRP registration, document-detail
  lookup, and cancellation, with a durable provider-operation ledger and
  explicit failed, unknown, and recovery states;
- historical and compatibility e-way-bill records with exact external evidence,
  cancellation handling, and manual evidence clearly labelled unverified;
- optional contract-source PDFs accepted only after tender-number and
  name-of-work identity checks match their parent LOA.

When Whitebooks is configured, IRP transport is direct but never unattended.
Unknown registration results become lookup-only and are never blindly
submitted again. Stale in-progress operations become unknown after their
two-minute lease and require reconciliation. Manual registration evidence
cannot overwrite a Whitebooks attempt.

The IRP transport is additionally gated by the owner's e-invoicing
declaration on the organisation profile: whether e-invoicing applies
(mandatory permanently once aggregate turnover has ever crossed ₹5 crore),
from what date, and — where the 30-day rule binds the organisation — the
reporting window in days. Registration (provider and manual evidence alike)
is refused while the declaration is missing, refused outright where
e-invoicing is declared not applicable (voluntary registration below the
mandate is not provided for), and refused for a fresh registration after
the invoice's reporting deadline. That deadline is frozen onto each invoice
at submit from the declaration then in force and never moves afterwards;
invoices issued before the model existed carry no deadline. Reconciling an
earlier attempt with an unknown outcome stays allowed, and local submit and
local cancellation are never blocked by any of this — the invoice screens
and the dashboard signal due and overdue reporting windows instead.

NIC accepts an IRN cancellation only within 24 hours of acknowledgement, and
the product is honest about that wall: each registered document exposes the
closing instant of its cancellation window, a provider cancellation past the
window is refused before any provider operation opens (rows migrated with
manual evidence and no provable acknowledgement instant are treated as
window-closed, never unknown-open), and the refusal names the lawful remedy —
the Section 34 credit note.

The credit note is that remedy, modelled as a first-class document:

- it is drafted against exactly one SUBMITTED tax invoice (any submitted
  invoice — the closed window is only when it is the ONLY remedy), carries the
  Section 34 reason on its face, and at issue takes the next gap-free number
  per organisation per financial year from its own counter under the same
  template rules as invoice numbering (default `CN/{FY}/{SEQ:3}`; a saved
  template must carry `{FY}` or `{FY2}`);
- it is FULL VALUE: its money columns are copies of the superseded invoice's
  frozen ones, proven equal by a database trigger, and its issued snapshot
  embeds the invoice's issued snapshot verbatim — nothing is recomputed;
- issuing it SUPERSEDES the invoice in the same transaction: superseded is a
  terminal invoice state alongside cancelled that releases the invoice's
  Measurement Book for a corrected invoice while every issued fact and every
  byte of IRN evidence stays frozen and is never cleared;
- it is an IRN document of its own (DocTyp CRN on the same INV-01 schema,
  positive values — the document type, not a sign, marks the credit) with the
  invoice's exact provider posture: the 0049 applicability and frozen
  reporting-deadline gates apply identically at issue and registration, the
  provider ledger is single-flight per note, and the note has its own 24-hour
  IRN cancellation window;
- local cancellation of an issued note is allowed only while its IRP state is
  not_requested or cancelled AND the invoice's Measurement Book has not been
  re-invoiced; it reverts the invoice superseded → submitted in the same
  transaction (a direct, MB-less invoice supersedes and reverts with no MB
  logic). One live credit note exists per invoice, ever; cancelled notes keep
  their numbers forever;
- Section 34(2) as amended (effective October 2025) conditions the supplier's
  tax reduction on the recipient reversing ITC: the note records that fact
  (not applicable / pending / reversal confirmed) without enforcing it.

An invoice's line shape is a PER-DOCUMENT choice, with an organisation-level
default that seeds the create form and nothing else. It is never derived from
the buyer or the Work: practice varies by company — some vendors put HSN goods
items on Railway invoices too, and private customers commonly take HSN goods
supply — so a Railway invoice may be itemised and a private one cumulative.

- `service_cumulative`: one SAC service line for the whole finalized
  Measurement Book total (or the stated value of a direct invoice), carried by
  the invoice's own SAC, description and GST rate. This is what every invoice
  raised before the choice existed is, and it is unchanged;
- `itemised`: no header line at all; the document is its lines, each with its
  own HSN (goods, six to eight digits) or SAC (services, exactly six),
  description, quantity, unit, unit rate and GST rate — each rate checked
  against the GST rate master for the invoice date. Line money is frozen at
  submit as quantity x rate with the tax split at the line's own rate, and the
  invoice's taxable value and tax heads are the exact sum of the lines. An
  MB-backed itemised invoice must add up to the measured total; submit refuses
  it otherwise rather than billing something the measurement never said.

Editing the shape is a draft-only act. Once submitted it is frozen with every
other business fact, and the lines become immutable with the invoice.

The UI does not offer fresh e-way-bill generation, and the provider-generation
and NIC-payload endpoints reject it. That refusal is being re-based on whether
the document itself carries goods lines rather than on the invoice model as a
whole; until then it applies to every invoice. Historical records remain
readable and cancellable, and compatibility imports remain explicitly
unverified.

Reverse-charge liability is an explicit invoice fact rather than printed from
a default. The current calculator supports forward charge only: submit requires
the operator to confirm forward charge, refuses reverse charge, and preserves a
missing historical value as unknown.

### Standing choices on a new Issue Challan

Material leaves to the same storekeeper, at the same location, movement after
movement, so a NEW Issue Challan draft opens pre-filled with the **issued-to
name, role, and location** of that Work's most recent ISSUED Issue Challan.
The source is chosen exactly as the Delivery Challan's is — highest sequence
number, issued only, this Work only — and every consequence listed under §2,
"Standing choices carry forward to the next Delivery Challan", holds here
unchanged: an existing draft is never seeded, the date is the organisation's
today, quantities start empty, and a seeded draft names the challan it was
carried from.

The **movement type is never carried**. It is the one standing choice that
changes what the document does rather than who receives it: a `return` reverses
the direction stock moves, and an issued Issue Challan is immutable. Carrying
it would mean that after a single return every later Issue Challan opened as a
return, and an operator filling in familiar-looking boxes would issue documents
that moved stock the wrong way. The Movement select therefore always opens on
`issue`, whatever the Work did last.

Remarks are never carried either: they are the individual movement's note.

## 9. Current non-goals and release boundaries

- security-deposit deductions, price variation, and other bill maths not
  defined by current design-partner evidence;
- unattended or scheduled statutory filing, and blind replay of an uncertain
  provider mutation;
- fresh e-way-bill generation, for either line shape, until the applicability
  decision follows from the document's own goods lines and a dispatch model
  exists to carry it;
- tenant-specific multi-GSTIN provider credential routing; the current adapter
  is bound to one configured GSTIN and refuses a mismatch;
- broad reporting;
- mobile-native apps;
- offline sync;
- custom permission-builder UI;
- microservices, Kafka, Kubernetes, or distributed databases;
- a custom AI Software Factory.
