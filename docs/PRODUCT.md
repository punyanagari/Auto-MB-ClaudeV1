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
- **Statutory movement facts** (ADR-0013) are optional on every Delivery
  Challan and mandatory only on the path that raises an e-way bill. Per line:
  an HSN/SAC code and a goods-or-service marker, recorded together or not at
  all, in the same shape an itemised tax invoice uses. Per challan: the reason
  for the movement in NIC's vocabulary (supply, job work, for own use,
  others), the consignee's GSTIN where the party has one, and the transport
  block — transporter, vehicle, transport document and distance. All of it is
  entered on the draft and frozen at issue with everything else the consignee
  is handed, which is what lets the e-way bill path trust it; a challan issued
  without the facts cannot raise a bill, and the remedy is a corrected
  challan rather than an edit to an issued one.

### Installation records

An installation record says "N units of item X went in at location L on
date D". It is the evidence behind the installed half of the executed
value, and the authoritative installed quantity is the sum of quantity
over non-cancelled records for the item — computed nowhere else.

- Recording is a site action, not an office one: the location is picked
  from the master or created inline while standing at it, and serial-
  flagged items attach exactly one delivered, uninstalled serial per unit.
- **Installation is measured as it happened, even past the sanction**
  (owner decision, 2026-08-17). Work goes in before the paperwork catches
  up: the railway asks for more at the site meeting, the gang installs it,
  and the variation order arrives weeks later. Refusing the record would
  not stop the units going in — it would only stop the product knowing
  about them — so the cumulative installed quantity may exceed the
  sanctioned LOA quantity, and the item is flagged **pending variation**
  when it does. The excess-delivery permission is not involved in either
  direction: it lifts the delivery ceiling only, and it never reached this
  rule when this rule was a ceiling.
- **The delivered floor binds serial-tracked items only** (owner
  confirmation, 2026-08-18): a non-serial item may be installed beyond
  what its issued Delivery Challans delivered — pre-existing behaviour,
  deliberate because a `PURE_INSTALLATION` item is never delivered at all
  and a blanket delivered cap would make the whole category
  un-installable, and pinned by `apps/server/test/installations.integration.test.ts`
  so it reads as a decision rather than a gap.
- **Pending variation is a derived fact, not a status somebody sets.** It
  is true exactly while the item's installed total stands above
  `effective_quantity ?? awarded_quantity`, recomputed by the database on
  every write that can move either side, and it clears by exactly two
  moves: an approved amendment raising the sanctioned quantity to cover
  the work (the variation order arriving, §5.1), or cancelling the
  installation record that measured the excess. It cannot be cleared by
  amending the quantity DOWN — the amendment floor refuses any reduction
  below what is already installed, which is what keeps a measured excess
  from being paperwork'd away.
- **What the lifted cap does not lift.** Measuring more than the contract
  sanctions is honest; invoicing it is not. Billing therefore **clamps**
  rather than refuses: every Measurement Book stage measured on work
  physically done — installation, certification, and the final-bill base
  that reads them — bills `min(measured, sanctioned)` over the item's
  lifetime, and the remainder is simply never billed. Everything up to the
  sanctioned quantity bills normally, so the contractor is not held out of
  what the contract already owes; the excess waits, unbilled, until a
  variation raises the sanction, at which point the room reopens and the
  next book bills it with no correction entry. Nothing is refused, which
  is deliberate — see the final-book rule below. Completion is unmoved
  too: a Work closes only at exact equality, so an over-installed item is
  as unfinished as a short one, on **any** payment category, and no Work
  closes on the strength of unsanctioned work.
- **The final book closes over an unprocessed variation** (owner ruling,
  2026-08-17: "Final MB can be done even if excess installation variation
  is not processed — sometimes we have to work free for the Railways").
  Refusing to bill the excess must never become refusing to close the
  contract, so the final Measurement Book finalizes with the excess
  clamped out — and finalizes even when the clamp leaves it with nothing
  to bill at all, which is the one case where an empty book is accepted.
  The unbilled quantity does not disappear from the record: the
  installation records still say what was built, and the Work's
  **unbillable variation exposure** — the money value of everything
  installed above sanction — is reported on the Measurement Book screen
  until the variation order clears it.
- Records are never edited. A record cancels with a note, keeps its
  history, and releases its serials back to the delivered-but-uninstalled
  pool.
- **Two homes, one record.** Recording and the full record — its serials,
  its remarks, its cancellation — live on the Work, because a record is
  measured against that Work's sanctioned quantity and drawn from that
  Work's delivered serials. Alongside them, a tenant-wide register lists every
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

| Term         | Meaning                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| Organisation | A tenant/legal entity using Auto-MB                                                                    |
| LOA          | Railway Letter of Acceptance defining the awarded contract                                             |
| Work         | One awarded contract created from one confirmed LOA                                                    |
| Schedule     | A grouping of awarded lines inside a Work                                                              |
| Work item    | One awarded description, unit, quantity, and effective rate                                            |
| DC           | Delivery Challan accompanying moving material (Work-bound or standalone)                               |
| Manual line  | A DC line that names no Work item: non-LOA material, inert to the ledger                               |
| Consignee    | Railway/site party receiving material                                                                  |
| MB           | Record, on-account, or final Measurement Book used for staged billing                                  |
| PBG/PAC/DOC  | Guarantee, acceptance, and completion lifecycle records                                                |
| GST invoice  | Direct or MB-backed tax invoice; locally issued before IRP registration                                |
| E-way bill   | Statutory movement record raised from a submitted tax invoice or an issued standalone Delivery Challan |

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
14. **Work completion:** a Work is marked completed only at 100% executed value — every item's delivered, installed and/or certified quantity, per its payment category, equals its effective quantity exactly — and only with nothing live still holding a claim on it. Equality is the whole rule: an item measuring ABOVE its sanctioned quantity is as unfinished as a short one, and its remedy runs the other way (amend the sanctioned quantity up, which is what the railway's variation order authorises). Completion and reopen each take a note; a completed Work accepts no new operational document until it is reopened. Which quantity an item is measured on is decided by its payment category; see §5.4.
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

**Completion binds the issue, not the follow-through.** Submitting a tax
invoice assigns a legal number and freezes its money, so a completed Work
refuses it exactly as it refuses a challan issue or a Measurement Book
finalize (§4, rule 14) — enforced on the server, so the refusal holds
whether the invoice was opened from its Work or from the organisation-wide
register. What legitimately outlives completion is the statutory
follow-through on a document already frozen: registering it at the IRP,
cancelling that registration, rendering its PDF. A direct invoice has no
Work, so completion never binds it.

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
  quantity instead. Every other item keeps the installed ceiling, and
  since migration 0077 that ceiling is no longer bounded by the sanction:
  a certificate attests work that physically exists, so the railway may
  certify an over-installed item in full. Only the AMC arm is bounded by
  the sanctioned quantity, because a maintenance year cannot be
  over-served the way a span can be over-built. Certifying above the
  sanction costs nothing, because the billing clamp above prices the
  certification stage at the sanctioned quantity too.
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
- **liquidated damages**, the pre-agreed contractual recovery for delay
  under a named GCC clause;
- **BOCW cess**, 1% under section 3 of the Building and Other Construction
  Workers' Welfare Cess Act 1996, reconciled against a cess return to the
  State welfare board;
- **penalties and recoveries**, argued individually — kept distinct from
  liquidated damages, which are the specific pre-agreed sum for delay. The
  distinction became load-bearing with the owner ruling of 2026-08-19:
  liquidated damages are capped at a percentage of the contract value and
  the product enforces that cap, while a penalty under a tender's own
  clause — a defective item not repaired within the stipulated time, an
  AMC penalty — is **uncapped** and is computed per that clause. An
  uncapped recovery belongs on this head, and pushing one through a
  liquidated-damages assessment would meet a ceiling the contract never
  imposed;
- **other**, which is the head that always turns up and is the only one that
  cannot be recorded without saying what it is.

Liquidated damages and BOCW cess were added by migration 0080. Before it,
the first fell into `penalty` alongside unrelated recoveries and the second
into `other`, and neither belonged there: a head reconciled through its own
form needs its own row, which is the same reasoning that separated GST TDS
from income-tax TDS when the register was built.

Every rate, threshold and legal citation named in this section lives in one
module, `packages/contracts/src/statutory.ts`, which both the server and the
web client read. It is in `contracts` rather than in the server because the
web half needs the citations to label a field honestly, and that package is
the only one both halves already depend on. **The values in it are an
engineer's reading and are marked as requiring owner verification**;
`statutoryVerificationChecklist()` enumerates them so a review can check
them off rather than hunt them through a diff.

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

**The receivables register asks the question across every Work.** The
settlement position above is a Work's own screen, and it answers "where is
this bill". Whoever chases payment is asking something else — "what is the
railway holding of ours, anywhere" — and answering that a Work at a time was
what kept the spreadsheet alive. The Receivables module is that register: one
row per prepared bill across every Work the member may see, carrying the
Work, the measurement, the bill's status, and the three figures of its
position, over four totals for the whole register — claimed, passed,
received and outstanding.

Four things about it are deliberate:

- **The totals are the organisation's, not the page's, and not the
  filters'.** They are summed in SQL over every row the member's work scope
  admits, in the same statement that reads the rows, so the authorization
  predicate is written once and the tiles cannot report money from Works the
  table is hiding. The status, Work and financial-year filters narrow the
  table and leave the tiles alone: a tile that moved with a filter would be
  answering a different question than its label.
- **A bill the railway has not passed carries no financial year.** The year
  a receivable falls in is the year the railway acknowledged it, derived
  from the On-Account Bill's date. Before that there is no year to file it
  under, and stamping it with the year it was prepared in would put it in
  the wrong one every March. Such rows are reachable through the filter's
  own "not yet passed" option.
- **The deduction waterfall is server arithmetic.** Opening a bill shows the
  reconciliation from the passed amount, through one line per deduction head,
  to the net payable and what is still outstanding. Each head is summed in
  SQL across that bill's live receipts — a withdrawn receipt drops out of the
  heads exactly as it drops out of the totals — and the net payable is
  computed there too. Nothing on the screen subtracts money.
- **Money is recorded where it always was.** The register reads; the receipt
  form, with its heads and its withdrawal path, stays on the Work's Bills
  tab, and the register links to it. One money form, one place to review it.

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

### 5.9 Money going out: employee requests and the vendor ledger

§5.7 is money coming in. This is the other half of the cash position, added
by migration 0080: what the agency pays its own people and its vendors.

**An employee request is an approval, not a payment.** An advance or a
reimbursement is raised naming the proof it rests on — the product refuses
to accept one without it — and moves `submitted → approved → paid`. There
is no draft: a request nobody has been asked to decide is not a record
worth keeping, and a status the product cannot reach is a branch every
reader has to rule out.

**Maker-checker, held twice.** A request is decided by somebody other than
the person who raised it. The route refuses a self-decision with a
sentence and the trigger refuses it as a rule, so a second endpoint or a
hand-run UPDATE cannot quietly approve its own claim. Deciding and paying
each happen once: the UPDATE names the status it expects and checks that
it matched, so a retried request that finds the row already paid is told
so rather than moving the money twice or overwriting the reference of the
payment that did.

**An advance is not finished when it is paid.** A reimbursement arrives with
its bills, so paying it settles it in the same act. An advance is paid
against an estimate, and stays open until the final bills are recorded.
While it is open, **that beneficiary cannot be given another advance** — a
rule the mock draws as a blocking banner, held here by a partial unique
index so a second open advance is impossible rather than merely refused, and
refused by name in the route so an operator is told which request to close.

**A vendor invoice is a liability, not a document this product issues.** It
records what a vendor billed, the credit terms it falls due on, and how much
is still open. The due date is derived from `invoice_date + credit_days` in
SQL and never stored: two copies of one fact eventually disagree.

**A vendor payment is three figures.** `gross = tds + net`. The gross is what
the payment discharges of the invoice; the TDS is what was withheld and paid
to the Government on the vendor's behalf; the net is what reached the
vendor's bank. **The invoice is consumed by the gross**, because tax withheld
is money the vendor has been credited with — recording only the net would
leave every invoice permanently short by its own TDS, which is exactly the
mistake the deduction rows of §5.7 exist to prevent on the receivable side.

**TDS is computed by the server, from one table.** The client sends a gross
and never a tax amount: a browser-computed deduction is a float-rounded
deduction, and it would also let a caller choose its own rate. The rate
decision reads `packages/contracts/src/statutory.ts` and honours three
behaviours an operator should not meet for the first time in the ledger:

- **thresholds, crossed strictly ABOVE and never AT.** Sections 194C(5) and
  194J are written as "does not exceed", so a payment of exactly ₹30,000 is
  not deductible and ₹30,000.01 is. 194C triggers on either a single payment
  exceeding its threshold or the year's aggregate exceeding the annual one;
  194J has no single-payment trigger. The aggregate is tested _including_
  the payment being made, because the payment that crosses the line is
  itself deductible.
- **the crossing payment carries the whole year.** Below the annual
  threshold nothing is withheld; the moment the aggregate exceeds it, tax
  falls due on the aggregate — including the earlier payments that went out
  untaxed — and the deductor recovers it from the payment in hand. Five
  payments of ₹25,000 under 194C withhold nothing on the first four and tax
  ₹1,25,000 on the fifth. What was already taxed on its own single-payment
  trigger is subtracted out, so nothing is taxed twice, and the taxable
  amount and its basis are **snapshotted on the payment** — a 26Q line whose
  tax exceeds its own rate × gross has to be able to explain itself. Where
  the catch-up would exceed the payment in hand it is refused rather than
  capped: there is no honest way to withhold money that is not moving.
- **serialised per payee.** The financial-year aggregate is read under a
  lock on the vendor's contact row, in the same transaction as the insert.
  Without it two simultaneous payments to one vendor both read the same
  stale total, both believe the year is under the threshold, and the
  shortfall is the deductor's to pay.
- **section 206AA**, applied as a **floor** and not a substitution: where no
  PAN has been furnished, the rate is the higher of the rate in force and
  20%. Modelling it as "20% when PAN is missing" would under-deduct for any
  section whose own rate exceeds 20%. PAN presence is read from
  `contacts.pan`, one authoritative column, and is **not** derived from the
  GSTIN: an unregistered vendor has no GSTIN, so a derivation would find no
  PAN and deduct at 20% from exactly the small labour contractor least able
  to carry it. Migration 0080 backfills the column from the GSTIN — whose
  characters 3–12 are the holder's PAN — so no deduction recorded before it
  changes.
- **the rate is snapshotted on the payment**, not looked up when the return
  is drawn. Finance Acts move rates, and a return re-derived from today's
  table would restate last quarter's deductions.
- **the table awaits a practitioner's sign-off, as a pre-production gate.**
  The owner approved the exclusive-threshold reading as implemented on
  2026-08-18; the statutory values themselves are still to be verified by a
  chartered accountant before the product is used for production TDS filings,
  on the same footing as the external certifications §9 lists.

A quarterly CSV export lists the deductions of one financial-year quarter —
Q1 is April to June — for a practitioner's return-preparation utility.

**Reused rather than rebuilt.** The vendor and the employee are both rows in
`contacts`, the party master `purchase_orders.vendor_contact_id` already
references; migration 0080 adds an `is_employee` flag beside `is_vendor`. A
consequence worth stating: a paid site worker does **not** need a login,
because the beneficiary is a contact and not a membership.

**Not reused, deliberately.** `approval_requests` was not generalised to
carry payment approvals. It is amendment-shaped — `work_id` is NOT NULL and a
reimbursement need not belong to a Work, its `proposed`/`diff` pair describes
an edit rather than a new record, and its one-pending-per-entity index
assumes the entity exists independently of the request. A payment request's
approval state is a status column on the request itself.

**Authority.** `can_manage_payments` is a new explicit per-member grant,
defaulting to false and not backfilled, following the precedent of the
statutory authority in migration 0061. Being allowed to issue a document the
agency is owed for is not being allowed to send the agency's money out. It
requires MFA, like every other authority.

**Not built yet.** Bank-statement import and Tally reconciliation are drawn
in the mock's Vendors tab and are deliberately absent: both are file-ingestion
problems that belong with the importer infrastructure, and a second ad-hoc
CSV parser here would be the thing that has to be deleted when it lands. The
mock's cumulative bank batch — selecting several approved requests and vendor
payables into one summary — is also not built; the register is a plain
two-tab table until the owner's v0 round for this screen settles how the
batch surface should look.

### 5.9a People and payroll

§5.9 is money going out to vendors and on employee claims. This is the
other recurring payment an executing agency makes, and the one with the
most law attached to it: the monthly salary, and the five statutory heads
that come off it or sit beside it.

**An employee is a contact with employment facts recorded against them.**
Name, phone, PAN and the salary bank account are the `contacts` row
§5.9 already pays; what payroll adds is the employment: a code, the
dates, the provident-fund and insurance elections, the profession-tax
State, the income-tax regime, and the monthly salary structure. This is
not tidiness — the payments workspace pays a CONTACT, so an employee who
was not one could not be paid at all.

**No Aadhaar, anywhere.** Not a column, not a payload, not a log line.
The UAN is the identifier a provident-fund return needs, and the Aadhaar
Act restricts who may hold the number and for what.

**Statutory rates live in dated tables, never in constants.** This is the
one place the product departs from `packages/contracts/src/statutory.ts`,
and the reason is about payroll rather than taste. A vendor payment is
deducted once, on one day, and the rate is frozen on the row. A payroll
run is RE-COMPUTED: a draft is calculated, corrected and calculated
again, and a run for a past month has to produce the figures that month
produced. Rates move mid-year by notification — the employee's ESI share
went from 1.75% to 0.75% on 1 July 2019 — and a constant in a deployed
build cannot answer for June and July at once. The precedent taken is the
GST rate master: org-editable rows with the range of dates each was in
force, seeded for every organisation, retired by end-dating and never
deleted.

**The arithmetic, head by head.** All of it runs in SQL numeric; nothing
about a payroll passes through JavaScript floating point.

- **Earnings** are pro-rated to the paisa over the days actually paid.
  Loss-of-pay days are stated per payslip by the payroll clerk: the
  product has no attendance subsystem, deliberately, and a monthly
  payroll consumes a number of unpaid days rather than a punch record.
- **Provident fund.** The wage is basic plus dearness allowance and
  nothing else, capped at the statutory ceiling where the organisation
  has elected to restrict it. The employee contributes 12%. The employer
  contributes 12%, of which 8.33% of the wage **capped at the pension
  ceiling** goes to the Pension Scheme and **the remainder** goes to the
  fund. The widely quoted "3.67%" is that remainder and is only exactly
  3.67% at or below the ceiling; above it the fund share is larger, and a
  product that asserted 3.67% as a rate would under-fund every employee
  earning more than the ceiling in basic. Contributions round to the
  nearest rupee.
- **Employees' State Insurance.** 0.75% employee and 3.25% employer of
  the gross, while the gross does **not exceed** the wage ceiling — so
  the ceiling itself is covered and a paisa over it is not. An employee
  who crosses the ceiling in the middle of a contribution period goes on
  contributing to the end of it, read off the finalised runs behind.
  Both shares round **up** to the next rupee: rounding an insurance
  contribution down is a short remittance. One divergence is recorded
  rather than hidden: monthly eligibility is re-tested on the
  loss-of-pay-prorated gross, not the un-prorated full-month entitlement,
  so an employee whose entitlement sits just above the ₹21,000 ceiling
  can be pulled INTO ESI for a month in which unpaid leave drops their
  prorated gross to or below it — and the mid-period continuation rule
  then keeps them in for the rest of the contribution period. See
  `docs/UX.md` § 15.
- **Profession tax** is a State levy under Article 276, so there is no
  national rate. Maharashtra's schedule is seeded and no other is; an
  organisation elsewhere is refused by name rather than deducted
  Maharashtra's figures. Building an editor for other States' schedules
  is a deferred decision — whether it belongs to this product or to its
  support desk is not yet answered, and until it is the composer's State
  select stays Maharashtra-only. The schedule distinguishes men from women — the
  2023 amendment put the women's exemption at ₹25,000 a month against
  ₹7,500 — and February collects ₹300 rather than ₹200, because the
  annual figure is ₹2,500 and does not divide by twelve.
- **Income tax under section 192** is the year's estimated tax on the
  employee's elected regime, less what has already been deducted, spread
  over the months still to be paid. The projection is the finalised runs
  behind plus this month at its own rate for every month remaining. The
  old regime deducts the standard deduction, the year's profession tax
  under section 16(iii), and the two totals the employee declared on
  their Form 12BB; the new regime deducts the standard deduction and
  almost nothing else. Section 87A is applied as a capped rebate, with
  the new regime's marginal relief. Cess follows, and the year's tax
  rounds to the nearest ten rupees under section 288B. Known limitation:
  the old-regime computation does not subtract the employee's own EPF
  contribution under section 80C, nor any other 80C investment — so an
  old-regime employee is mildly OVER-deducted, and recovers the
  difference as a refund on filing.
- **Surcharge is not computed, and the answer is a refusal.** An employee
  whose projected total income exceeds the first surcharge threshold is
  refused by name and sent to a practitioner. Computing the slab tax
  alone for them would UNDER-deduct, and an under-deduction under section
  192 is the employer's own liability with interest.

**A finalised run is an issued document.** It is numbered gap-free per
organisation per financial year off a counter claimed by upsert, keyed by
the month being PAID rather than by today — so March's payroll, run in
April, belongs to the year it pays for. It is immutable once finalised;
it is cancelled with a reason rather than deleted; a cancelled run keeps
its number forever and the month may then be run again. One live run per
month is impossible rather than merely refused. Every figure a payslip
rests on is snapshotted onto it, **including the rates**, because the
schedules are org-editable and a run that re-derived them on read would
restate a finalised month the day an owner corrected a notification.

**Disbursement is the payments workspace's, not a second one.**
Finalising raises one payment request per payslip, of a new kind
`salary`, for the net and no other figure, with the run number standing
in as its proof. Each then moves through the approval, the maker-checker
rule and the paid-once guard §5.9 already holds, and settles on payment
because a salary has no later bills to record. The handoff is idempotent:
a retried finalise is refused by the run's own guard, and the unique
index on the link would refuse a second request per payslip even if it
were not. A run whose salary requests have already been decided cannot be
cancelled — the paperwork is unwound on the payments register, where the
money is.

**Authority.** Payroll has its own grant, `can_manage_payroll` (0089),
distinct from `can_manage_payments` — an owner ruling of 2026-08-18. The
register carries every colleague's salary, PAN, UAN and bank account, and
a member who may approve a vendor payment must not see that by default:
seeing what everyone earns is a different secret from moving the
organisation's money out. The salary DISBURSEMENT still flows through the
payments workspace; only the register's visibility and the payroll run —
reads included — are gated on the new authority. The owner of a new
organisation holds it implicitly, and it requires MFA, like every other
authority.

**The arithmetic awaits a practitioner's sign-off**, as a pre-production
gate on the same footing as §5.9's vendor-side TDS table. Every seeded
rate, ceiling, slab and threshold was written from an engineer's reading
of the provision cited beside it. Building did not wait for the gate;
using the product to file a provident-fund, insurance, profession-tax or
24Q return does.

**Not built yet.** Attendance capture, a leave ledger, ID cards, and the
generation of the Government return files themselves. The figures every
one of those returns carries are on the payslip; writing the file formats
is a pack with its own certification, and the mock's own "Generate"
buttons produce nothing today.

### 5.10 Inspection gates despatch

Nothing manufactured for Indian Railways moves until somebody the railway
trusts has looked at it. RDSO and RITES inspect at the vendor's premises
against the specification the LOA cites, the agency issues a certificate,
and the material despatches under that certificate. An item despatched
without one is rejected at the consignee's gate and comes back at the
contractor's cost.

The product models this in three parts.

**The clause** is what the contract requires of one schedule item: which
agency inspects it (RDSO, RITES, or the consignee), at whose premises, in
what quantity — and whether a live certificate is required before the item
may go on a Delivery Challan. It is configured per Work, on the Work's
Inspection clause tab.

**The checklist** is what the agency demands: a named list of papers per
agency, each compulsory or not. It exists at two scopes — the
organisation's default, and a Work's own override — and a Work with no
list of its own is held to the default. That fallback is not a
convenience: without it every newly created Work would start with an empty
checklist, and a close gate that demands nothing is a close gate that is
not enforced. Either way the list is **snapshot** onto every call at the
moment the call is raised, so editing it afterwards never changes what a
call already in progress is being held to.

**The call** is one inspection, and it is also the job card. It moves
through four states and no others:

- `requested` — the placing request has gone to the agency;
- `scheduled` — the agency's inward call letter has come back, carrying
  the agency's own number (typed, because the series is theirs);
- `closed` — inspected, passed, every compulsory paper on file and the
  certificate uploaded;
- `cancelled` — withdrawn, with a reason.

A call that did not pass is cancelled with a reason and the rectified
material is offered again under a fresh call; there is no "failed" result,
because a numbered record that terminated badly cancels here exactly as
every other one does. Nor is there a separate "successful" field: the
certificate IS the result, and a second field saying the same thing is a
field that can disagree with the document. Calls are numbered per Work (`INS/<work code>/<n>`),
gap-free, and a cancelled number is never reused.

**The interlock.** An item whose clause says so cannot be despatched
BEYOND THE QUANTITY a live certificate covers. The comparison is
cumulative and per item:

- **despatched** is this challan's line plus every issued challan's lines
  for the item;
- **certified** is the sum of the coverage quantities on every live call
  for that item **from the clause's own agency** — a RITES certificate
  does not answer an RDSO clause;
- **live** is a call that is `closed` (which the schema makes mean
  inspected and certified) whose validity window has not passed, measured
  against the **organisation's** today rather than UTC's.

This quantity-aware reading — cumulative despatched never exceeding
cumulative certified, per item — is the owner-ratified rule (2026-08-18).

Existence is not enough, and that is the point: a single call for 10 units
must not release the despatch of 500. It is the same arithmetic shape as
the delivery ceiling, over a different allowance, and it lives in one SQL
function that both enforcement points call — the issue route, at the same
altitude as the ceiling and under the same row locks, and a database
trigger on the challan's transition to `issued`.

The refusal is `INSPECTION_CERTIFICATE_MISSING`. It names each item, its
agency, and both figures, and its remedy names both ways out — certify the
outstanding quantity, or clear the item's dispatch gate.

Two other paths ask the same question before they act. The **v1 importer**
pre-flights it per challan and reports a named skip rather than abandoning
the batch, because a legacy challan inspected under paperwork this product
does not hold is a fact about the old system. And a **cancel-and-replace
correction** asks it before it cancels the original: if the replacement
could not be issued, cancelling first would leave the Work with no live
challan for material that has already moved.

Four properties of the interlock are load-bearing:

- **It is off by default and it is off retroactively.** The gate is the
  presence of a clause row carrying the flag, and the migration that
  introduced the model creates no clause rows. Every Work that existed
  before it can issue exactly the challans it could issue before it.
- **Only an owner may move it**, on the same footing as the Work's
  excess-delivery permission: both decide what despatch is allowed to
  ignore. Mapping an agency to an item is ordinary clerical work and is
  open to office members.
- **A consignee-inspected item can never gate despatch.** The consignee
  inspects after the material arrives, so its certificate could not exist
  beforehand; the combination is refused when it is configured rather than
  left to block every challan raised under it.
- **Withdrawal and lapse both re-close the gate.** Cancelling a closed
  call — which is how a withdrawn certificate is recorded — and a
  certificate whose validity window has passed both stop authorising
  despatch immediately, with nothing else having to change. Challans
  already issued keep their numbers and their snapshots: an issued
  document records what was despatched and is not a claim that is still
  true. The withdrawal screen enumerates the despatches that went out
  while the certificate was live, matched by item and date and labelled
  advisory, because revoking a certificate is only actionable if somebody
  can be told which lorries to chase.
- **Only the agency named by the clause counts**, and remapping a gated
  item to another agency is therefore an owner's act too: it discards
  every certificate the gate was counting.

Call letters, routine test reports, job-card evidence and certificates are
stored as documents of the call they belong to, through the same hardened
upload path as every other document in the product — magic-byte check,
malware scan, tenant-prefixed object key, recorded digest. They are **not**
company document library entries: the library is organisation-level by
definition and exists so that one PAN copy serves every Work, whereas an
inspection certificate is evidence about specific items of one contract.
A call's evidence is replaceable while the call is open and frozen the
moment it closes.

### 5.11 The factory before the challan

Everything else in this contract models work the agency EXECUTES: a
letter arrives, material is delivered, quantities are measured, money is
billed. This section models the half before it. The agency is an OEM. It
builds what it delivers, and between the LOA and the Delivery Challan
there is a factory whose output has to be accounted for unit by unit.

**The item master** is what the factory names: the products the
organisation manufactures and the parts it buys to build them, in one
list because a bill of material joins one to the other and a sub-assembly
is both. A part carries a part number — unique per organisation, case
insensitively, and never reissued even after retirement, because it is
printed on physical labels. An item marked `manufactured` may carry a job
card, and always carries a serial series; one not manufactured may still
be serial controlled, meaning its supplier's serials are captured when it
is consumed.

This is deliberately NOT the canonical item catalogue of §8. A canonical
item's identity is a WORDING — it exists to say that three differently
worded schedule lines mean one thing — and its mapping to schedule lines
is derived from its aliases. A production item's identity is a part
number, and it is the anchor of a bill-of-material edge and a serial
series. The relation between the two is a mapping, not an identity, and
the product does not yet draw it.

**The bill of material** is one row per parent-component edge, with the
quantity per single unit of the parent. It is recursive: a component may
be a manufactured item with a bill of its own, and the explosion
multiplies quantities down every level. A bill that reached itself would
have no bottom, so a cycle is refused at the database — under a
per-organisation lock, because two sessions adding opposite edges at the
same moment cannot see each other's uncommitted row and no row lock can
be taken on a row that does not exist yet. Depth is bounded as well.

**The job card** is one production order: build this many of this item,
for this Work's schedule line or this private purchase order, by this
date. It serves exactly one of the two — never both, never neither — and
it moves through four states and no others:

- `planned` — raised, nothing built;
- `in_production` — the first unit has been serialised, which is what
  moves it here; there is no separate "start" act, because a button
  saying "I am about to start" beside the act of starting is a button
  that can lie;
- `completed` — every planned unit exists as a serial;
- `cancelled` — abandoned, with a reason.

Job cards are numbered per organisation per financial year (`PP-26-081`),
gap-free, and a cancelled number is never reused. The planned quantity is
a ceiling on units built, held under the card's own row lock, for the
same reason the LOA quantity is a ceiling on delivery: building more than
was ordered is not a bonus, it is stock nobody asked for charged to a
contract. It may be revised down, but never below what has already been
built — which is how a short run is closed honestly rather than by
inventing units.

Material READINESS is not a stored state, but the position behind it is
now real. What one job card requires of each part is computed from the
exploded bill; what is AVAILABLE to it and what is still SHORT come off
the stock ledger, and all three are derived on read.

Available is the card's share of the shelf: what is on hand, less every
other open job card's outstanding claim on the same part, with the card's
own claim left in so it is never told it cannot have the material it
itself reserved. Two cards therefore cannot each be promised the same
reel of cable.

Shortage is measured against the card's OUTSTANDING requirement, not its
gross bill: the bill times the units not yet serialised, less the
material already issued to the card and not returned. That distinction is
the difference between a true figure and a false alarm — material issued
to the bench has left the shelf, so a gross requirement measured against
the shelf reports a card short of the parts the operator is holding. From
the outstanding figure the shelf and the outstanding balance of every
open purchase order come off, both after the other cards' claim and both
through the netting the shortage screen and the order it drafts use, so a
part covered by material in transit is not bought twice.

`Required − Available` is therefore deliberately not the shortage. And
two cards competing for one part with a single order covering one of them
both read short: neither may assume the order is theirs, and the
organisation-wide shortage screen remains the authority on how much to
buy.

The job card's Materials tab shows the three side by side. The production
register shows one figure per card: how many distinct PARTS it is short
of. A count of parts, never a sum of quantities, because adding cabinets
in Nos to cable in Mtr to solder in Kg prints a number in no unit at all.

**Serial traceability** is the part with teeth, and it is two records.

A _finished serial_ is one physical unit the factory made, named from its
item's own series and claimed from a counter, so two operators
serialising at the same moment cannot mint one number twice. Its
uniqueness scope is the ORGANISATION, which is a deliberate departure
from the per-Work scope of delivery-challan serials: a challan serial is
a claim about what was delivered under one contract, and two contracts
may legitimately carry unrelated equipment whose supplier numbering
collides, whereas a production serial is minted here, from a series this
organisation owns, before any contract has been chosen for it — a job
card may have no Work at all. Two units of one factory bearing one number
is the failure a nameplate exists to prevent.

A _component serial_ records which supplier-numbered part was consumed
into which finished unit. Per UNIT, not per batch: "this board is dead,
whose power supply is in it, and which other boards carry one from the
same batch" is the question a field failure asks, and a batch-level
record cannot answer it. One physical component is consumed into exactly
one unit, and no more of a part may be scanned into a unit than its bill
of material calls for.

A serial typed into the global search finds a unit whether or not it has
reached a Delivery Challan. Before production existed every serial in
the product came from a challan line and therefore had a Work; a unit
the factory has built and not yet despatched has neither, and the trace
says so — its origin, its job card, how much of its genealogy is
recorded, and whether it has been released — rather than matching
nothing, which reads exactly like "no such unit".

Neither record is ever UPDATEd — a serial number is stamped on hardware,
not corrected. A unit recorded in error, and a mis-scanned component, are
removed while the unit is still in the factory; once it has been
despatched, nothing is removed, because the unit is somewhere else and
the record is the only account of what is inside it. The refusal comes
from the reference itself rather than from a guard that has to remember
to look.

**Dispatch readiness** is derived, never stored, and it is one
expression: a job card has units ready to leave when it is not
cancelled, every planned unit has been built, at least one of them is
still in the factory, and none of those is missing a component serial
its bill of material calls for. A `completed` card still counts —
completing means every planned unit was BUILT, which says nothing about
whether it has shipped, and a completed card holding twelve unreleased
boards is exactly what the register should surface. A card with nothing
left to release does not count, because there is nothing to be ready
for. The register's tile and the job card's own badge read that one
expression, so the count and the badge it links to cannot disagree.

**Despatch** is the boundary. Named finished units leave the factory on a
date, and that is all it is: not a Delivery Challan, no consignee, no
money, no statutory claim. It is the moment production stops being
responsible for a unit and finished goods become despatchable stock. A
unit leaves once, only on its own job card's release, and only when every
serial-controlled component its bill calls for has been captured. A
release raised in error can be withdrawn today; when a stock ledger
references it, the reference is what refuses the withdrawal, because
stock will have moved on the strength of it.

Releasing is not issuing. The Delivery Challan that eventually carries
these units is a statutory document raised against a Work, with its own
number series, its consignee snapshot, its e-way bill and the inspection
interlock of §5.10 — and it is raised from the Challans register, not
from the factory floor.

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
  matrices, stage-wise billing, immutable snapshots, and generated documents.
  Billing clamps at the sanctioned quantity: every stage measured on physical
  work bills `min(measured, effective_quantity ?? awarded_quantity)` over the
  item's lifetime, so an unsanctioned excess stays measured but unpaid until
  its variation order is applied, and no book — the final one included — is
  ever blocked by one (see "Installation records"). The clamp lives in the
  computation core, so the draft preview, the draft PDF and the finalized
  snapshot are the same numbers;
- the railway's own received On-Account Bill, linked to the Measurement Book
  it settles by measurement sequence, with every fact extracted from the PDF
  and a three-signature verdict that gates measurement closure and payment
  (§5.4);
- OEM production — the manufactured-item master, its recursive bill of
  material with cycle refusal at the database, job cards numbered per
  financial year, per-unit serial genealogy of finished goods and the
  components consumed into them, and the despatch that hands finished
  units to stock (§5.11);
- vendor contacts, purchase orders, and budgetary quotations;
- the RDSO/RITES inspection lifecycle — per-item inspection clauses, the
  per-Work document checklist, and calls carrying their inward call letter,
  routine tests, job-card evidence and certificate — with the dispatch
  interlock that refuses a Delivery Challan for an item the Work has
  configured as inspection-gated and no live certificate covers (§5.10);
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
- e-way bills raised from whichever document moves the goods — a submitted tax
  invoice carrying goods lines, or an issued standalone Delivery Challan that
  does — generated by IRN on the invoice path and directly on the challan path,
  with exact external evidence, cancellation handling, manual evidence clearly
  labelled unverified, and a printable summary that states on its face that the
  NIC portal document is the statutory original;
- optional contract-source PDFs accepted only after tender-number and
  name-of-work identity checks match their parent LOA;
- a canonical item catalogue: the organisation's own statement that
  differently worded schedule lines across different Works name one product,
  so those lines can be searched and compared. It is the one master that is
  not a picker — nothing selects a canonical item into a document. Its link
  to schedule lines is DERIVED rather than stored: a live line counts against
  an item when its description equals that item's name or one of its aliases,
  compared lowercased and trimmed, so the counts move on their own as Works
  arrive and nothing has to be assigned. Matching is exact on the normalised
  string, so a line that differs by a comma stays unmapped until somebody adds
  its wording; the count of still-unmapped lines is shown above the list and
  is the operator's queue. Retiring an item returns the lines it covered to
  that queue. Items retire by flag like every master and are never deleted;
- bank details in the two places money is named. A contact carries ONE
  payment beneficiary inline on its own record — account holder, bank,
  account number, IFSC, and optionally branch and account type — and the
  first four are stored together or not at all, because a partial set is not
  something anyone can be paid as. The organisation separately keeps a LIST
  of the accounts it owns, for printing on invoices and receiving payment;
  those are owner-only to change, retire by flag, and cannot be added twice
  while live. Account numbers and IFSCs are shape-checked at the route and
  again by database CHECK on both tables, and are never written to an audit
  event or a log. The organisation's own account numbers are stored but never
  returned by the API — every read answers the last four characters only —
  while a contact's are returned in full because that record is edited
  through a form that must round-trip them. Both travel in the organisation
  data export, which is the contractor's own portability snapshot;
- a versioned company document library: the organisation-level credentials
  every tender and inspection asks for, uploaded once, carrying the validity
  window printed on them, with expiry derived on read (see "The company
  document library");
- the tender pipeline: NIT intake with field extraction a human confirms, a
  bid checklist that attaches library credentials and reads their validity
  against the tender's closing date, an iREPS status trail, and an award
  conversion that deep-links into the ordinary LOA intake (see "The tender
  pipeline, before there is a Work").

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

E-way bill applicability follows the document's LINES (ADR-0013). An invoice
carrying at least one goods (HSN) line can raise one; a service-only document
— every cumulative SAC invoice, and any itemised invoice whose lines are all
services — is refused, with the code the refusal has always had. NIC states
the same rule and enforces it: its error 4009 reads "E Way Bill can be
generated provided at least HSN of one item belongs to goods", observed live
during the 12 August sandbox certification. The rule is identical for railway
and private documents; there is no per-customer-type switch, and it lives in
one place server-side. Historical records remain readable and cancellable, and
compatibility imports remain explicitly unverified.

Reverse-charge liability is an explicit invoice fact rather than printed from
a default. The current calculator supports forward charge only: submit requires
the operator to confirm forward charge, refuses reverse charge, and preserves a
missing historical value as unknown.

### The company document library

Every document this product had modelled belonged to a Work. The documents
an agency is asked for most often belong to none: GST registration, PAN, the
partnership deed, an ISO certificate, a bank solvency letter, last year's
balance sheet, a completion certificate from a contract three years ago.
Every tender demands them, every inspection asks after them, and half the
correspondence encloses them. They lived in somebody's laptop folder and
were re-scanned whenever nobody could find it.

The library is where they live now. It is organisation-level by definition —
the point of it is that one PAN copy serves every Work — so nothing in it is
work-scoped and no work-scope predicate applies to it.

**Who may see what.** Adding, renewing and archiving are owner/office work,
the same gate the rest of the organisation's master data carries. Reading is
open to any member with one exception: **financial** documents — balance
sheets, turnover certificates, bank solvency letters — are readable by
owner/office only. Every other bucket holds something the agency hands to
strangers on request; its GST registration number is printed on its own
invoices. What the company is worth and who it banks with is not that, and
site staff and viewers have no work that needs it. A non-writer's library
simply does not contain those rows — the category is filtered in SQL rather
than removed from a result — and a non-writer who reaches a financial
version's bytes by id is refused with a 403 rather than a 404: they belong to
the organisation that owns the file, so its existence is not the secret, only
its contents are.

The gate is the writer role rather than a new membership authority. Issue,
cancel and statutory are authorities over documents the organisation puts its
name to, and filing a copy of one's own PAN card is not that act; the people
who file the financials are the people who may read them.

**A credential and its versions.** A library row is the NAME — a title and
one of five categories (statutory, financial, eligibility, certification,
company) — and behind it stands the succession of files that have proved it.
Uploading a renewal adds a version; it never edits the one before. A stored
version is immutable, which is what keeps a bid that attached v1 explicable
after v3 exists. Each version carries the validity window printed on the
paper: an effective date, an expiry date, both optional and independently so
(a PAN card has neither, a GST registration certificate has an effective
date and no expiry, a bank solvency letter has both). Both are date-only
legal dates and are never timezone-round-tripped. One live credential may
carry a given name at a time, case-folded, so a renewal lands on the row it
renews rather than beside it.

**Expiry is derived, never stored.** The register reports the newest
version's validity as it reads today: no expiry at all, valid, expiring
within sixty days, or expired — computed on every read against the
database's current date. A stored status would be wrong the morning after it
was written, and the whole reason for recording an expiry date is that
somebody is told before it passes. Sixty days is the same window the
Dashboard uses for a bank guarantee, because "expiring soon" has to mean one
thing across the product. An older version having lapsed is not reported:
that is what superseding it was for.

**Archive, not delete.** A credential the agency no longer offers is
archived. The row and every version survive and stay downloadable, because a
bid that already cited the credential must remain explicable; the name it
held is released, so the credential can be re-added if it comes back. An
archived credential accepts no new versions, and archiving is one-way —
un-archiving would resurrect a row while the name it freed may already
belong to a credential added since, so the way back is to add it again.

The stored PDFs go through the same gate as every other upload in the
product — magic bytes rather than the declared content type, a fail-closed
malware scan, a 25 MB ceiling, and a server-generated tenant-prefixed object
key — and they travel in the organisation export, so a data-portability
request hands back the certificates themselves rather than only the fact
that they existed.

Not here, and deliberately: no approval or signature state, because these
are copies of documents an authority already issued rather than documents
this organisation issues; and no notification when a credential is about to
lapse. The register colours what is expiring and the operator has to look.

### The tax-invoice register, and where a direct invoice lives

A tax invoice has two parents and only ever had one home. An MB-backed
invoice bills a finalized Measurement Book of a Work and is read on that
Work; a DIRECT invoice descends from no LOA, names no Work and no
Measurement Book, and states its own taxable value — so there was no Work
to read it on, and no screen listed one.

- **Two homes, one document.** An organisation-wide register lists every
  tax invoice, work-backed and direct together, newest first, with its
  number, buyer, date, taxable value, GST, local status, IRP state, and
  its source: a link to its Work, or the word Direct. Opening a row opens
  the same detail surface the Work's Bills tab opens, so the frozen facts,
  the draft editor, the PDF, the IRP transport, the Section 34 credit note
  and the cancellation are the same controls wherever the invoice was
  reached from.
- **Drafting follows the parent.** A Work's invoice is still drafted on
  the Work, because it bills that Work's finalized Measurement Book and
  the picker for that is the Work's own. A direct invoice is drafted on
  the register, because there is no Work for it to be drafted on. Both
  forms collect the same document facts; the only difference is that one
  names a Measurement Book and the other states the value that Book would
  have measured. An itemised direct invoice states no value at all — its
  lines already say what the supply is worth, and the server sums them.
- **Reach.** The register is bounded by Work scope exactly as the Work
  page is: a member without organisation-wide work scope sees only the
  invoices of the Works they are assigned to. A DIRECT invoice belongs to
  no Work, so no assignment can reach it, and such a member sees none of
  them and may not raise one — the same posture, for the same reason, as a
  standalone Delivery Challan. The scope binds the pagination cursor as
  well as the rows: a cursor naming an invoice outside the caller's reach
  is refused exactly as a nonexistent one is, so paging cannot be used to
  learn that such an invoice exists or when it was raised.

  The same boundary holds on EVERY per-document route, not only in the
  list: reading, editing, deleting, submitting, cancelling, rendering and
  the whole IRP transport of a direct invoice each answer a member without
  organisation-wide scope with the module's ordinary not-found refusal, so
  an id learned elsewhere opens nothing the register would have denied.
  Credit notes follow their invoice — a note against a direct invoice is
  neither listed to nor reachable by such a member — because a note that
  outlived its invoice's boundary would disclose the invoice through it.

- **Window.** The register's one filter is an inclusive `invoiceDate`
  range, read a page at a time. Cancelled and superseded invoices stay
  listed with their status: a numbered document that was cancelled is
  precisely the fact a register must keep reporting.
- **Two status languages, never merged.** The local lifecycle (draft,
  submitted, cancelled, superseded) and the statutory one (registered at
  the IRP, manual and unverified, reporting window due or overdue) are
  separate columns. A locally issued invoice is never shown as
  IRP-registered without provider evidence.

### The tender pipeline, before there is a Work

Everything else in this product describes a contract the agency already
holds. The work that decides whether it holds one is a Notice Inviting
Tender, a bid package, an upload to iREPS, and weeks of waiting — and the
two things that lose bids are a deadline nobody watched and a certificate
that had lapsed by the day the bid was opened. The pipeline is
organisation-level by definition: a tender belongs to no Work, because the
Work is what winning it produces.

**NIT intake proposes; a human confirms.** The notice PDF is uploaded,
scanned for malware and read with the same Poppler `pdftotext` the LOA and
contract-source paths use. A field reader takes the six things an NIT's
first page states — tender number, inviting authority, name of work,
closing date and time, estimated cost, EMD — plus the eligibility
paragraph, each with the source text it was read from and its own
"needs review" mark. **Nothing authoritative is written by the reading**
(engineering rule 10): the notice is a proposal, the tender record exists
only when a reviewer sends back the values they accepted, and it carries
theirs rather than the machine's. A notice with no text layer is stored
anyway, flagged, and typed in by hand — a photocopied notice is still the
notice, and refusing it would leave the commonest real document nowhere to
go. Unlike the LOA the reading is synchronous, because six labelled fields
off a short notice is one extraction rather than a job.

**The closing moment is an instant, not a legal date.** This is the one
place the product departs from "legal dates are date-only": a railway
tender closes at a stated time of day and a bid one minute late is
rejected, so the time is the half of it that decides the outcome. The
wall clock the notice prints is bound to the organisation's own timezone
by the database when the tender is created, and rendered back through the
same timezone on every read, so no browser and no server process can shift
a deadline onto a different day.

**The bid checklist points at the company document library.** Each line
names a document the tender asks for and is either unanswered or answered
by a credential in the library. Whether that credential is any good is a
question about the tender's closing date, not about today: a certificate
lapsing in three weeks is green in the library and useless for a bid that
opens in four. So validity is derived on every read by comparing the
attached credential's newest version's expiry to the tender's closing day —
`expired by close` when it lapses first, `lapses soon after` inside the
same sixty-day window the library uses, `valid at close` otherwise, and
`no expiry` for a credential that never lapses. A mandatory line that is
unanswered, or answered with something that will have expired, **blocks**
the bid, and the register prints that count.

**iREPS is tracked, never driven.** The portal has no interface a program
may use; it is operated by a human with a CAPTCHA, an OTP and a local
digital signature. The product therefore records what that human did:
drafted → submitted → opened → awarded or lost, one way only, with awarded
and lost final, each step carrying its actor, its moment, an optional note
and the acknowledgement the portal printed. None of it is verified against
iREPS and the screen says so. The one refusal the product can make
honestly is a submission recorded while a mandatory checklist line is
blocking — a package that would be rejected at the other end.

**The award converts through the ordinary intake.** An awarded tender does
not create a Work. It deep-links into the existing LOA intake carrying its
own facts, so the operator can check the letter against the tender it
answers; the letter is recorded against the tender, and the Work is read
through that letter once it is confirmed the way every other Work is. One
letter awards one tender. There is no second path to a Work and no Work id
stored on the tender that could disagree with the letter's.

### The correspondence register

A works contract is executed on paper as much as on site. Approval of the
makes offered, a datasheet the railway asked for, the clarification it
sent back, the reply to it, an invitation to re-quote: each is a numbered
letter that went out or came in, and the trade keeps an inward/outward
register because a letter nobody can produce is a letter that was never
sent. Until migration 0086 this product modelled the Work, the goods, the
money and the certificates, and none of the letters.

**Two series, organisation-wide, restarting each financial year.**
Outward letters take `OUT/26-27/047` and inward letters `IN/26-27/022`,
each from its own counter. The series are organisation-scoped rather than
per Work because the register is read across Works and a letter need not
belong to one at all — an invitation to quote arrives before there is a
Work to file it under. Numbers are gap-free under concurrent filing, and
a cancelled letter keeps its number forever; nothing deletes.

The inward number is OURS even though the letter is theirs. What the
sender printed on their own paper is kept verbatim as the sender's
reference, together with the date they put on it; the inward number is the
register's own handle, the way an inward register in a railway office
stamps a serial on arrival.

**An outward letter is written and dispatched in one act.** There is no
draft: everything on the paper is frozen the moment the row exists, which
is what lets the dispatched PDF be rendered on demand from the letter's
own columns instead of stored. An inward letter is registered with its
scan, and the scan is required — a received-letter register whose rows may
lack the paper is the laptop folder the register replaces.

**A misrecorded letter is cancelled with a reason.** It keeps its number,
so the series stays provably gap-free, and a reprint carries a CANCELLED
watermark. A letter that a later letter answers cannot be cancelled until
that reply is: a thread unwinds from its newest end. Cancelling is the
cancel authority's act, the same authority that cancels a challan or an
invoice, and once recorded the reason, the actor and the moment are as
frozen as the letter — they are the record that explains what a retained
number now stands for.

**Status is derived, never stored.** An outward letter reads `sent` and an
inward one `received`; either reads `replied` once a later letter cites
it, and `cancelled` overrides both. Nothing is written to a letter when it
is answered — the answer is a fact about the register, and a stored one
would be wrong the moment a reply arrived.

**The register does not duplicate the two letter kinds that already have
homes.** This is the whole integration decision of the module:

- **Extension-of-time letters** stay in the completion-extensions module
  (§8, migration 0011). It already numbers the letter
  (`PL-281-Extension-01`), holds its grounds and addressee, renders its
  PDF, stores the railway's reply and moves the Work's completion date
  when the reply lands. The correspondence screen's Extension requests tab
  READS that register and links back to the Work; nothing is copied. One
  request is up to two rows there — the request that went out, and the
  railway's answer once it lands — and the request itself then reads
  `replied` while the ANSWER carries the outcome, because it is the answer
  that was accepted or refused, not the letter that asked.
- **Inspection call letters** stay in the inspection module (§5.10,
  migration 0082). One call is two letters — our outward request,
  `INS/PL-281/1`, and the agency's inward call letter under their own
  number — and the Inspection letters tab reads both from the call.
  Withdrawing the call withdraws the letter that answered it: both rows
  read cancelled together.

The banner above the tabs counts extension requests that have been sent
and not yet answered, which is the one place the two modules meet on
screen. It counts what THIS product sent: a manual back-fill of a paper
letter (§5.5) is finalised on arrival because it was posted years ago, and
an amber prompt to chase letters nobody can chase is a prompt an operator
learns to ignore.

Two registers for one letter is how the two come to disagree about its
number, its date or its state, so the correspondence register writes
neither.

**Work-scope applies, including to what a letter says about other
letters.** A letter filed against a Work is visible only to members who
reach that Work; a letter filed as general correspondence belongs to no
Work and is visible to every member. The tab counts obey the same rule,
because a count is otherwise a statement about the size of a register the
reader cannot open — and so does the `replied` reading and the reference
cell, because a reply filed on a hidden Work must not change how a visible
letter reads. A letter whose Work is later superseded stays in the
register and loses its link: it is a record of what was sent, not a
pointer to a Work nobody can open.

**Letters filed against a Work join its timeline.** The approval that
unblocked an item and the clarification that changed a make are part of
that Work's paper trail, and a trail that omitted the letters would leave
those decisions unexplained.

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

### The stock ledger, and the shortage it feeds

Migration 0087. An agency that MANUFACTURES what it delivers holds material,
and until now the product could not say how much. This is the record of it:
an append-only ledger of every movement of every part, with the balance
derived from it and the shortage that balance finally lets a bill of material
compute.

**The item is the production item.** There is no stock item master of its
own. A bill-of-material component and a thing on a shelf are the same object,
so stock is a fact about `production_items` (0084) and the one column
Inventory adds to that master is a reorder level. A separate stock catalogue
would need a mapping to the bill of material with nothing to write it.

**A balance is never stored as a balance.** The ledger is the only
authority. Each movement carries the running total after it, computed by the
database under the item's own lock and never supplied by a writer, and the
table takes no UPDATE and no DELETE — so the sum of the movements and the
last row's running total are the same number forever. A movement posted in
error is REVERSED by an adjustment carrying its reason, which leaves both the
mistake and the correction on the record.

**Time only runs forward, per part.** A movement may not be dated before
that part's last movement, and may not be dated in the future. This is what
makes the running total readable: `balance_after` is the balance in POSTING
order, so a row posted after another and dated before it would leave every
earlier total skipping a movement earlier than itself. The consequence is
deliberate — late paperwork is posted at today's date, with the docket's own
date in the reason — and the alternative is a balance column nobody can read.
The rule is per part, because two parts have unrelated histories and one
shelf's late paperwork must not block another's. A movement sent without a
date is dated the organisation's today, resolved on the server: a browser
clock is the wrong authority for a legal date.

**Stock never goes negative.** An issue that would take a part below zero is
refused, and the refusal is a constraint on the column rather than a check
somebody has to remember. Every inbound movement names a document that
already exists — a production despatch, a purchase order line — or carries a
typed reason, so a negative balance could never mean "the paperwork is late";
it would mean material was issued that is not there. An adjustment out cannot
go below zero either: you cannot lose more than you had.

**Six movements, each bound to what caused it.** A production receipt names
the despatch that released the units and takes ITS unit count, never a typed
one. A purchase receipt names the purchase order line it arrived against. An
issue and a return name exactly one of a job card or a Work. An adjustment in
or out names neither and carries a reason instead. The shape is a database
constraint, so a movement that explains nothing cannot be written.

**Committed is derived, and three things come off it.** Every open job
card's outstanding bill of material — the recursive explosion times the units
not yet serialised — is what the organisation has already spoken for. From
that gross requirement:

1. **units already built** come off, because their material is inside them;
2. **material already issued to that card** comes off, because it has LEFT
   the shelf — the ledger decremented it — so counting it as still required
   would demand it a second time and buy a second set of parts already
   sitting on the bench. Issues net, returns un-net, and it floors at zero
   per part: over-issuing to a card means that part is no longer wanted, not
   that the card is owed material back;
3. **material already on order** comes off at the shortage, not per card —
   draft and issued purchase-order lines, ordered less received. Without it
   the screen asks an operator to buy the same part every time they open it
   until the lorry arrives.

The first two are facts about the CARD and are netted inside the shared
requirement function; the third is a fact about the PART and is netted once
against the summed requirement, because netting it per card would let two
cards each subtract the same lorry. Available is on hand minus committed and
may go negative; a negative available is the shortage.

**A shortage is a fact about a part, not about a job card.** The requirement
is summed across every open job card and netted once against one balance, and
the contributing job cards are named on the row. Attributing one shelf to
several job cards separately is how the same part gets ordered twice.

**Shortage buying extends the existing purchase order; it does not add a
second one.** Selected shortages draft a purchase order (§5.8's, migration 0033) on the job card's Work, with the quantities the server computes at the
moment of ordering and nil rates — the screen knows what to buy and not what
it costs. Rates, terms and issue stay in the procurement module, and its
`issue` authority still gates the moment the draft becomes a document. Two
nullable columns on a purchase order line carry the part it buys and the job
card whose shortage asked for it.

**A purchase order line is received on exactly one channel, declared when
the line is written.** A line that names a part is STOCK-received; a line
that does not is CHALLAN-received. The received quantity reads one channel,
never the sum of both, and a delivery challan item that points at a
stock-received line is refused at the database — otherwise its quantity would
be counted by neither channel and silently vanish from the balance that
decides whether the order may close. `production_item_id` is that
declaration: it is set when the line is created and never afterwards, so a
line cannot change channel under a balance that has already counted it.

Before this, a shortage order could never be closed at all: its material is
consumed in the factory and never appears on a challan. One shared SQL
expression computes the figure for the procurement register, the open-order
filter and the challan editor's over-receipt warning, so three readers cannot
disagree about what has arrived.

**A job card serving a private purchase order cannot raise one.** A purchase
order belongs to a Work — its number is per Work, its authorization is per
Work — and a private job card has none. The refusal says so; relaxing it is a
numbering-and-authorization change to an issued-document surface and belongs
in its own change.

**Stock is organisation-level, and a Work is not.** One shelf serves every
contract, so the register and the ledger are visible to every member. Every
reference OUT of them to a Work is work-scoped, and that means all three
routes to one — the movement's own Work, the Work behind its job card, and
the Work behind its purchase order. A member who cannot reach a Work may see
that material left the shelf; they may not learn which Work it left for by
any of the three. The pending-despatch queue and the shortage screen's
purchase orders are filtered outright, because a despatch and an order each
belong to a Work.

**A completed Work accepts no movement, by any route.** R8 reaches through
the job card and through the purchase order as well as through a directly
named Work, at the route and again at the database — or the indirect arms
would be the way around the direct one.

### Signing an issued document with the organisation's own certificate

The counterparty wants the agency's registered Class 3 DSC on the document,
not a scan of a rubber stamp. The token that holds it is a USB device in one
machine in a private room, and it will never be in the server.

So the product moves the 32 bytes that need signing to the token instead of
moving the key to the server. ADR-0012 calls this lane 2; lane 1 (Aadhaar
eSign) is designed, gated on ESP onboarding, and not built.

**The lifecycle**, one row in the signing queue from end to end:

1. **Raise.** A member holding the **signing authority** opens an issued
   delivery challan or a submitted tax invoice and sends it for signing.
   The server prepares the entire signature there and then — it appends the
   PDF revision, computes the ByteRange, builds the CMS signed attributes —
   and stores the one value the token will be asked for: the SHA-256 of
   those attributes. The request names the exact bytes it authorises, the
   certificate it was prepared for, and an expiry.
2. **Claim.** The kiosk agent, a script the signer starts in their own
   logged-in Windows session, polls over outbound HTTPS. It takes one
   request, prints the document, who asked for it and its SHA-256, and asks
   the token to sign the digest. The token's PIN dialog appears on that
   desktop — which is why the agent cannot be a Windows service.
3. **Sign.** 256 bytes of RSA signature come back. Nothing else crosses: no
   document, no key, no PIN.
4. **Verify.** The server rebuilds the preparation from the stored bytes and
   **refuses unless the digest it derives is the digest it authorised**.
   Then it assembles the CMS, embeds it, and runs its own signature verifier
   over the result. Anything other than `signed_and_intact` is refused and
   the request is failed with the reason.
5. **Store.** The signed PDF goes to a new object key. The unsigned render
   keeps its own — a signature is a new version, never an overwrite, because
   the signature can only be checked against the bytes it covered.

**The rules that make it safe, and what each one is actually for:**

- **The digest is re-derived, not trusted.** This is the whole security
  argument. Re-rendering a challan rewrites the same object key, so a
  document can change underneath a pending request; the re-derivation
  catches it and the request fails instead of the certificate landing on
  something nobody reviewed. It also catches a cancelled document, which is
  checked separately because cancelling does not change any bytes.
- **The signing authority is separate from the issue authority.** The digest
  binding answers _which document_ may be signed. It says nothing about _who
  may put a request in front of a signer_ who is about to type their PIN
  because the queue said to. Both are needed.
- **One open request per document.** Two live authorisations over one
  document would produce two "the" signed copies and no answer to which is
  the record.
- **Seven days, and it is a lease.** A pending authorisation nobody acted on
  lapses and must be raised again. A _claimed_ one lapses too, which is what
  stops a kiosk that crashed mid-signature from wedging the document
  forever: once the lease is up the request can be re-offered or withdrawn,
  but a signature against it is refused — the digest is stale and the
  request has to be raised afresh.
- **The kiosk's credential is a scoped, revocable token**, not a password,
  and only its digest is stored. Revoking it kills every request it was
  raised for, with a stated reason, so the queue explains why it stopped.
- **The certificate is pinned by thumbprint.** A Windows certificate store
  routinely holds several certificates with identical subjects — an expiry,
  a renewal, a test issue — so selecting by name picks whichever came back
  first.
- **The server must hold the trust anchor** that the organisation's own
  certificate chains to, or it will refuse its own output _after_ the PIN
  has been entered. See `docs/OPERATIONS.md`.

**Not yet:** an RFC 3161 timestamp. The TSA contract is a procurement
dependency, so the signature carries the signer's claimed time labelled as a
claim, and no attestation is manufactured in its place.

### Maintenance: the site material request

A platform display fails. The site engineer raises a **maintenance request**
against the Work and the station: the fault, what it is doing to services,
the parts needed, and how many of the failed units the site will send back.
The request takes a gap-free number in an organisation-wide series that
restarts each financial year — `MR/26-27/00142` — because a store clerk's
queue is read across every contract at once and the number is quoted on the
phone before anybody looks up which Work the station belongs to.

**This is not the LOA's annual maintenance schedule.** An AMC item (§ 5.4) is
a contract line, served over a period and certified; nothing here is billable
and no quantity here counts against an LOA ceiling. The two share a word.

**Approval is whole-request and it is the owner's.** Raising a request is
site work; committing the store's material to it is not. The approval
comment is written once and stays on the record. There is no reject: a
request that should not be fulfilled is approved, written off line by line
with a reason, and closed — the same evidence a rejection would carry, filed
against the lines rather than the header.

**A dispatch is a numbered challan and a real stock issue.** Material leaves
the store on a `PL-281/MNT/001` challan, gap-free per Work like every other
challan series, and every line naming a catalogue part posts an `issue`
against the stock ledger naming that challan. A line with no catalogue part
is a custom material bought for this fault alone and moves no stock. The
ledger refuses a balance below zero, so "is there any" is decided by the
shelf and not by the screen.

**The defective return posts nothing.** A failed unit received back at the
office is on a repair bench, not on a shelf; adding it to the available
balance would let somebody dispatch it again. What the office records is the
quantity, the serials, the condition and the repair disposition — and it may
not record more than actually went out.

**Three of the line's quantities are stored and the rest are derived.** What
was asked for, how many failed units are promised back, and how much of the
balance has been written off are facts somebody states. What is reserved, what
has gone out, what has come back and what is on the shelf are all computed
from the challans, the receipts and the ledger, so none of them can drift
from its own evidence.

**The closure gate.** A request closes only when every line has been
dispatched or written off, and every failed unit that actually went out has
come back. The write-off is what makes the gate reachable: a request whose
stock never arrives, or whose Work is superseded mid-flight, cancels its
balance with a reason and closes. A closed request is terminal.

### Platform controls: modules, recurring checks, and the organisation's own copy

Three operator surfaces that have nothing to do with contract execution and
everything to do with running the product for an organisation (migration
0096). They live together on Settings → Platform because they answer one
question in three parts: what may this organisation use, what does it check
on a clock, and can it take its own record away.

**A module entitlement is not a permission, and the distinction is the
whole rule.** A membership says what a PERSON may do; an entitlement says
whether a MODULE is available to the ORGANISATION at all. They compose, and
neither substitutes for the other: a member holding the statutory
reporting authority in an organisation whose e-way bill module is switched
off is refused, and so is the owner. Two flags ship, and both name a real
external dependency rather than a hypothetical one — the e-way bill module
waits on NIC re-certification, and outbound signing waits on the ESP/TSA
procurement ADR-0012 settled.

**Both ship ENABLED**, which is the opposite of what those dependencies
suggest and is deliberate: landing the mechanism must not change what any
organisation can do on the day it applies. Switching one off is an operator
act with a note attached, and it stops NEW work only — an organisation that
turns the e-way bill module off keeps every bill it has already generated,
because a control that erased history would be a different control.
Managing the flags needs the owner role AND the entitlements authority.

**A recurring check borrows a real membership.** ADR-0011 refuses the queue
a service identity, so a schedule records the member who last saved it and
its jobs run under exactly that authority, re-proved in the database at
execution. A check enabled by somebody who has since left parks its next
run rather than running on their behalf, and the remedy — a current member
saves the check again — is stated on the run history rather than left to be
inferred from a red chip. One check ships: the performance guarantees and
PAC certificates whose expiry falls inside a horizon the organisation sets,
which is the check an agency loses real money by missing.

**The organisation's own copy of itself** is the same complete package the
owner-only synchronous export has always produced, built once into storage
and downloaded as a file that survives a closed tab. It needs the export
authority and full Work access — the package is not Work-scoped, so a
member who sees only their own Works cannot take one, and it is refused by
name rather than silently exporting less. The artefact EXPIRES on a clock
the requester does not choose, and its bytes are deleted when it does,
because a complete copy of the business is not a thing to leave lying
around. Every export is recorded permanently even after its file is gone:
the row states that on a date a named member took the whole organisation
away, which is a fact worth keeping whether or not the file still exists.

## 9. Current non-goals and release boundaries

- security-deposit deductions, price variation, and other bill maths not
  defined by current design-partner evidence;
- unattended or scheduled statutory filing, and blind replay of an uncertain
  provider mutation;
- live NIC certification of the new e-way bill payloads: the 12 August sandbox
  run covered IRN registration and EWB authentication only, and ADR-0013's
  payloads must be certified against the sandbox before production use;
- e-way bill vehicle updates, validity extension, and consolidated e-way bills,
  which are their own NIC transactions;
- reconcile-by-lookup for a challan-sourced bill: NIC's lookup is by IRN and a
  challan has none, so an unknown generation is resolved on the portal by hand
  rather than sent again blindly;
- tenant-specific multi-GSTIN provider credential routing; the current adapter
  is bound to one configured GSTIN and refuses a mismatch;
- automated iREPS bidding: the portal has no public interface, so tender
  submission is recorded after the fact and never performed by the product;
- tender-document generation and per-tender file storage: a bid attaches
  credentials the company document library already holds, and the product
  does not become a third place to keep documents;
- cancelling a maintenance dispatch challan: reversing one means reversing
  its stock movements, which the ledger deliberately makes somebody justify
  with a typed adjustment, and the correction belongs with that adjustment
  rather than beside the challan;
- broad reporting;
- mobile-native apps;
- offline sync;
- custom permission-builder UI;
- microservices, Kafka, Kubernetes, or distributed databases;
- a custom AI Software Factory.
