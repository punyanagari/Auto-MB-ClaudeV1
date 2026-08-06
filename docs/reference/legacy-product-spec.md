# Auto-MB — Architecture-Independent Product Specification

> **Purpose of this document.** A complete, stack-agnostic description of the
> product: its domain, features, business rules, workflows, and quality
> expectations. It contains no technology choices — no languages, frameworks,
> databases, or cloud services. It can be handed to any engineering team (or
> passed verbatim as a prompt to an AI agent) to rebuild, port, or extend the
> system on any architecture, and the result should behave identically.
>
> _Generated from the working v1.5.1 codebase on 13/07/2026. The existing
> automated test suites are the executable acceptance criteria for everything
> below._

---

## 1. What the product is

**Auto-MB** is a works-contract manager for **executing agencies of Indian
Railways** — companies that win railway tenders and must then track, document,
and bill everything they supply and install against the contract.

The core problem it solves: a railway **Letter of Acceptance (LOA)** awards a
contract with dozens-to-hundreds of line items, quantities, and rates. The
agency must maintain an **honest, auditable quantity ledger** — what was
awarded, delivered, installed, certified, and what is payable at each stage —
plus generate the legally significant paper trail (delivery challans, issue
challans, tax invoices, e-way bills, e-invoices) that the railway and GST
authorities require.

**Primary users:** the agency owner/admin, office staff (documentation,
billing), and site staff (recording installations, often on mobile).
Single-company deployment (one agency per instance) in the current version.

> **Tenancy, reconciled (`decisions/APPROVED-026`, Option A).** "One agency
> per instance" is a **v1 deployment scoping decision, not a permanent
> product decision**. The data model is multi-tenant-capable from day one —
> every tenant-owned record carries its owning organisation, and tenant
> scoping is enforced at the data layer, bound per transaction, never left
> to application convention — and v1 simply deploys with one tenant per
> instance. A second legal entity (e.g. a joint venture with its own
> PAN/GST — a real case in the LOA corpus, `PL270`) is a **separate
> instance today** and becomes a separate *tenant* only when multi-tenancy
> ships. The multi-tenant horizon (thousands of agencies on shared
> infrastructure) is what the data model must carry, not a description of
> v1. The isolation suites are present-tense: code that ignores tenant
> scoping is a live bug with one tenant — it just has nothing to leak yet.
> (Mechanism specifics live in the architecture doc, which this spec
> deliberately does not bind.)

**Product voice:** operational and calm. "Issue challan", "Record
installation", "PBG expires in 41 days". Numbers do the talking; no marketing
language anywhere.

---

## 2. Domain glossary

| Term | Meaning |
|---|---|
| **LOA** | Letter of Acceptance — the railway's award letter (usually an IREPS PDF) defining the work: header details, schedules, line items with quantities and rates |
| **IREPS** | Indian Railways E-Procurement System — source of LOA PDFs |
| **Work** | One contract, created from one LOA. Identified by a short work code (e.g. `PL-270`) that prefixes all its document numbers |
| **Schedule** | A grouping of line items within an LOA (e.g. "Schedule A — Supply") |
| **Work item** | One awarded line: description, unit, quantity, quoted/effective rate, payment category |
| **DC — Delivery Challan** | Document accompanying material delivered to the railway/site. Legally significant once issued |
| **IC — Issue Challan** | Document for material issued out (to site, job work, loan/return), may include items outside the LOA |
| **Installation** | A dated record that a quantity of an item was installed at a location |
| **Serial number** | Per-unit traceable identity for items that require it; created at delivery, linked at installation |
| **PBG** | Performance Bank Guarantee — security the agency must submit after award (21-day rule), with an expiry date to track |
| **PAC** | Provisional Acceptance Certificate — railway certification of installed quantities; a payment stage |
| **DOC** | Date of Completion of the contract; extendable via tracked extension request letters |
| **MB** | Measurement Book — the stage-wise partial bill of a work: bills the delivered/installed/PAC deltas since the previous MB per the payment matrix; a tax invoice is raised against it |
| **BQ** | **Budgetary Quotation** — a quotation the agency gives a vendor/client against their enquiry or suo moto. (NOT "bill of quantities") |
| **PO** | Purchase Order the agency places on its vendors |
| **Contacts** | Unified master of consignees, vendors, and clients (role flags on one record) |
| **Consignee** | The railway party receiving material (named on challans). Bill-paying authorities (Sr.DFM/DFM/ADFM) and awarding authorities (e.g. Sr.DSTE) are *not* consignees |
| **GSTIN** | GST identification number. Railway units are often TDS **deductors** — their GSTINs end in `D` and must be accepted |
| **IRN** | Invoice Reference Number — the government e-invoice registration of a tax invoice (with signed QR) |
| **EWB** | E-Way Bill — mandatory transport document when consignment value exceeds ₹50,000 |
| **FY** | Indian financial year (April–March), written `2026-27` in document numbers |

---

## 3. Actors, permissions, and access control

### 3.1 Permission model — feature matrix, not roles

There are **no fixed roles**. There is exactly one special account, the
**Master Admin**, who implicitly holds every permission and cannot be
disabled or demoted by anyone else. Every other user is assigned any
combination of ~40 individual feature permissions on a **Responsibility
Matrix** screen.

Permissions form a **dependency graph** (e.g. creating a delivery challan
requires viewing challans, which requires viewing works). The system must
enforce the transitive closure in *both* directions, both in the matrix UI
and again on save at the server: enabling a feature auto-enables its
prerequisites; disabling one auto-disables everything depending on it. A
broken combination must be impossible to store.

### 3.2 The permission catalog

- **User management:** add user · edit user/reset password · disable/enable
  user · assign permissions.
- **Work / LOA:** view works · create work (PDF upload / Excel import /
  manual) · review & confirm auto-extracted LOA data · edit work header ·
  edit/add/remove items & quantities (amendments, audit note required) · set
  payment categories & payment matrix · set custom challan series · set
  per-work excess-delivery toggle · soft-delete work.
- **Delivery challans:** view/print (incl. warranty certificates) · create ·
  edit draft / request edits to issued · cancel · attach scanned signed copy.
- **Issue challans:** view/print · create (manual items and excess allowed) ·
  cancel (audit note).
- **Installation:** view · record (item, qty, location, serials) · cancel ·
  installation report with selectable columns.
- **Reports:** seven ledger reports (see §10) each individually grantable ·
  export to Excel.
- **Procurement:** manage vendors & clients · PO view/create/cancel · BQ
  view/create/cancel (cancels take an audit note).
- **Master data:** consignees · locations · company profile (letterhead, GST,
  signatories) · units of measurement.
- **Measurement books:** view · create/finalize (bills DC + installation +
  PAC deltas per the payment matrix) · cancel (audit note).
- **Invoicing:** view · create/edit/issue · cancel (audit note).
- **GST compliance:** view IRNs & e-way bills · manage (generate/cancel IRN
  and EWB, update Part-B, extend validity).
- **Approvals:** approve edit requests (holders also apply such edits
  directly — see §5.6).
- **Dashboard:** deadlines dashboard · audit-trail viewer.

Notable pairing: *create work* alone lets a user extract **and confirm their
own** extraction (one-person flow); the separate *extraction review*
permission additionally lets a reviewer confirm extractions done by others.

### 3.3 Work-scoped access

Independently of feature permissions (*what* a user can do), each user either
sees **all works** (default) or only **assigned works**. Scope restriction
covers work lists and details, challans, installations, reports (including
consolidated ones), the dashboard, and serial lookup. A scoped user who
creates a work is auto-assigned to it. The master admin always sees
everything. Scope must be evaluated per request (changes apply on the user's
next action, without re-login).

### 3.4 Sessions and account rules

- Authenticated sessions of ~12 hours; **permissions and the active flag
  live in the database, not the session token** — the client re-validates on
  app load / tab focus, picking up permission changes and cutting off
  disabled users without re-login.
- Password policy: minimum 8 characters, **any character composition** (no
  letter/digit/symbol mandates), known-common and default passwords
  rejected (`ChangeMe@123`, `password`, `Password1`, `12345678`). New
  hashes use a strong adaptive hash (current: bcrypt cost 12); old hashes
  stay valid (cost embedded per hash).
- Login throttling: per-IP limit (20 attempts / 15 min) plus a per-username
  lock (5 failures / 15 min).
- The seed/first-run flow warns loudly when the master-admin password is
  left at its default.
- **Account guards:** the master-admin account can be edited only by
  itself and can never be disabled; no user can disable their own account.
  Usernames are 3–30 chars of letters/digits/`. _ -`, lowercased, unique.
  An admin can generate a **temporary password** for a user (random,
  shown exactly once, never stored or logged in plain text, forces a
  password change at next login) — but not for the master admin.
- **One person, multiple legal entities** (`decisions/APPROVED-026`, second
  question): in v1 there is **no cross-entity identity** — a person who is,
  say, proprietor of one firm and partner in a JV holds **separate
  credentials per instance** (shape 1: hard boundary matching the legal
  separation; each entity is its own deployment under the v1 tenancy note
  in §1). No user record belongs to more than one company, and nothing in
  v1 links accounts across instances. The "one identity, membership in
  both, explicit switch" shape is deferred to multi-tenancy and would land
  here in §3.4 when it does.

---

## 4. Conceptual data model

Entities and their key relationships (no storage technology implied):

- **User** — credentials, active flag, master-admin flag; ↔ *Permission
  grants* (per feature); ↔ *Work assignments* (for scoped users).
- **Work** — work code (unique, uppercase, 1–20 chars of `A–Z 0–9 - _ /`),
  letter number (unique), name, LOA date, date of completion, advertised
  value, contract value, pricing shape `letter_percentage | per_schedule`,
  letter percentage + direction `below | at_par | above` (both nullable,
  populated only under `letter_percentage`) — a single "contract value"
  field cannot hold both figures: IREPS award letters carry two pricing
  shapes, and under `letter_percentage` the per-item amounts print at the
  ADVERTISED rate, so summing them yields advertised value, not contract
  value (tickets/DC-14.md; research/DC-32-loa-parser-contract.md §1) — EMD,
  PBG details (amount, submitted amount, expiry, document), excess-delivery
  toggle, status `active | completed | cancelled`, soft-delete flag; → many
  *Schedules* → many *Work items*; ↔ many *Consignees*; → *Challan
  sequences* (per series).
- **Work item** — serial number within schedule, item code, description,
  unit, LOA qty, quoted rate, effective rate/amount, payment category, four
  stage percentages, requires-serial-numbers flag, soft-delete flag.
- **Contact** (unified master; UI name "Contacts") — designation/name,
  contact person, address, phone, email, GSTIN, pincode, state code, bank
  details, role flags `is_consignee | is_vendor | is_client`, active flag.
- **Location** — station / installation point master.
- **Delivery challan** — work (nullable for standalone challans), challan
  number (assigned at issue), challan type (NIC sub-supply type: supply,
  job work, for own use, job work returns, sales return, SKD/CKD, line
  sales, recipient not known, exhibition, others), date, consignee,
  dispatch-from/to parties, status `draft | issued | cancelled`, remarks,
  signed-copy attachment; → challan items (work item ref *or* manual
  description/unit/rate, plus HSN) → serial numbers.
- **Issue challan** — same lifecycle, plus loan/return type; items may be
  manual (outside LOA) and may exceed work quantities.
- **Serial number** — value unique **per work item**; created at delivery
  (linked to DC item), linked to an installation when installed.
- **Installation** — work item, qty, date, location, remarks, serials,
  status `recorded | cancelled`.
- **PAC certificate** — per work, date, reference, status; → certified
  items (work item + qty).
- **Extension letter** — per work, tracked request for DOC extension:
  draft → finalized with number `<workcode>-Extension-NN`, PDF.
- **Approval request** — record type + record id, requested change payload,
  reason, requester, status `pending | approved | rejected`, decider, note;
  one pending request per record.
- **Purchase order / Quotation (BQ)** — FY-wise numbered, vendor/client
  (from Contacts), optional work link, items (work item ref or manual),
  status `draft | issued | cancelled`; PO dispatch documents attachable.
- **Measurement book** — per work: number (`<work_code>-MB-NN` at
  finalize), date, final flag, status `draft | finalized | invoiced |
  cancelled`, invoice link; → MB items (per work item: delta quantities
  per stage, cumulative-prior snapshot, stage %/rate snapshot, stage
  amounts, generated remark); → MB sources (the DCs / installations /
  PACs it bills — globally unique per source).
- **Tax invoice** — buyer from Contacts, line items (description, HSN,
  qty, rate, per-line GST %, amounts), totals, status
  `draft | issued | cancelled`, number `INV/<FY>/NNN` at issue.
- **E-invoice (IRN)** — per tax invoice: IRN, acknowledgement number/date,
  signed QR payload, status; at most one **active** IRN per invoice.
- **E-way bill** — against an issued DC (challan flow) or an IRN (invoice
  flow): EWB number, transporter, mode, distance, vehicle (Part-B),
  valid-until, status + event history; at most one **active** EWB per
  document.
- **Company profile** — the agency's letterhead identity: name, legal name,
  address, GSTIN, state code, logo, signatories, warranty text, default
  challan prefix.
- **Units** — unit-of-measure master (Numbers, Metre, Set, Lot, …).
- **Audit log** — every create/update/cancel/delete/permission change:
  user, timestamp, action, entity, detail payload.
- **Document sequences** — gap-free counters: per work & series for
  challans; per document type & FY for PO/BQ/INV.

**The item ledger** is a derived, always-consistent view per work item:
LOA qty → delivered qty (issued DCs only) → balance to supply → installed
qty (non-cancelled) → pending to install → delivered/balance values at
effective rate → PAC-certified qty → payable-to-date per the railway
percentage split (see §8).

---

## 5. Core workflows

### 5.1 LOA intake → Work creation

1. User uploads an LOA PDF (or falls back to Excel import / manual entry).
2. **Extraction pipeline:** extract the text layer; if the PDF is scanned
   (no text layer), fall back to a configured OCR service; otherwise run
   the deterministic local parser. If local confidence is low and OCR is
   configured, try both and keep whichever result reconciles better.
   **Never auto-commit** — extraction always lands on a review screen.
3. **Parser contract** (the highest-risk component; port with a regression
   fixture set): IREPS LOAs share a rigid skeleton but damaged text layers
   (glued words, split numbers). The parser anchors each item on its money
   line ("… At Par ‹amount›"), back-tracks tokens to recover
   code/qty/unit/rate, validates `qty × rate ≈ amount` with arithmetic
   recovery for merged digits, and **never discards information**: anything
   uncertain keeps its raw text block and a `needsReview` flag for the
   human reviewer. Output: header (letter no, dates, values), schedules
   with items, totals, warnings. Validated today against 6 real IREPS
   letters / 281 line items with all values reconciling — that fixture set
   is the acceptance bar. _(Corrected 2026-08-05: the original count
   predated PL281, the %Above letter added 2026-07-28; the corpus and its
   281-item bar are measured in `packages/loa/fixtures/corpus.json` and
   research §0.)_
4. **Review screen:** user corrects flagged rows, assigns each item a
   payment category, sets consignees, then **confirms** → the Work and its
   schedules/items are created atomically. Empty numeric header fields and
   empty payment categories must be stored as nulls, not zeros or empty
   strings. Work code is validated (§6 R1) and becomes the number prefix.

### 5.2 Delivery challan (DC)

- **Draft:** pick consignee and challan type; add lines from the work's
  items — the picker shows live balance context (delivered/LOA, "N left",
  amber at ≤10 % remaining, red on excess) — or manual lines (description,
  unit, rate, HSN) on standalone/other-type challans. Enter serials for
  items that require them (multi-value paste splits on newline/comma/
  semicolon). **Only one open draft per work** — attempting a second
  returns a conflict that carries the existing draft's id so the UI can
  deep-link "Open existing draft".
- **Issue:** assigns the next **gap-free** number in the work's series
  (§7), snapshots the data, and makes the challan legally significant.
  Quantity validation at issue: total delivered per item across issued DCs
  must not exceed LOA qty unless the work's excess-delivery toggle is on.
- **Line types:** a line either references a work item (may carry serials;
  count must equal qty; mandatory one-per-unit when the item requires
  serials) or is a **manual line** (free description ≥ 3 chars, optional
  unit/rate/HSN 6–8 digits) — manual lines can never carry serials.
  **Standalone challans** (not linked to any work — e.g. fabrication
  dispatches) may contain manual lines only and are exempt from the
  one-draft rule; they number from the company FY series (§7).
- **Inward traceability (PO linkage):** a work line may name the issued PO
  line its material came from (blank = own manufacture/stock). The PO line
  must be for the same LOA item, and the linked quantity may not exceed the
  PO line's ordered qty minus what is already linked across all
  non-cancelled DCs (multiple lines in one challan drawing on the same PO
  line are summed). This closes the PO → vendor dispatch → our DC cycle.
- **After issue:** print PDF (letterhead, signature blocks, optional
  warranty/guarantee certificate page, serial column only when serials
  exist; an e-way-bill annexure can be appended, basic or with event
  history); attach scanned signed copy (issued challans only; content
  type-checked); generate an EWB (§5.7); request an edit (§5.6); or cancel.
- **Cancel semantics:** a **draft** is deleted outright (it never had a
  number). Cancelling an **issued** challan requires an audit note, retains
  the record and its number forever, and releases its serials so a corrected
  replacement can re-enter them — but is **blocked while any of its serials
  is installed**. The cancelled number is never reused.

### 5.3 Issue challan (IC)

Same draft → issue → cancel lifecycle and numbering discipline as DCs, with
looser content rules by design: items may be manual (outside the LOA) and
quantities **may exceed** work quantities; supports loan/return semantics.
One open IC draft per work.

### 5.4 Installation

Mobile-friendly entry: work item, quantity, date, location (pick from master
or create inline), remarks, and tap-to-select serials from the
**delivered-but-uninstalled pool** of that item. Rules: installation total
per item can never exceed **LOA qty** (the excess toggle does not apply);
for **supply-type items** (serial-flagged, or category Supply /
Supply+Installation / Spare Supply, or uncategorized with supply % > 0) the
installed total is additionally capped at the **delivered** quantity
("create/issue the delivery challan first"); serial-flagged items need
exactly one selected serial per unit; serials cannot be installed before
their delivery date or twice (attachment is atomic — a serial must exist,
belong to the item, and be uninstalled); installation date must be ≥ LOA
date and not in the future. Cancel requires a note and releases the serials
back to the pool. Quantity edits of a recorded installation go through
approvals (§5.6) and are blocked while serials are attached (cancel and
re-record instead).

### 5.5 PBG, PAC, DOC & extension letters

- **PBG:** the PBG due date derives from LOA date + submission days
  (1–180, default 21). Recording a submission requires amount (> 0),
  reference, bank, validity date (after the LOA date), and form — bank
  guarantee or FDR (FDR carries an auto-renewal flag) — with an optional
  type-checked document. Editing a work's completion date warns when
  completion + 60 days would exceed the PBG validity.
- **PAC:** certificates are issued in parts — issue date (≥ LOA date, not
  future) + **issuing consignee** required, optional scanned document,
  items = certified quantities. Per item, PAC qty is capped at
  **installed minus already-PAC'd** (the error states installed / covered /
  available). Certified qty feeds the PAC payment stage in the ledger (§8);
  each PAC shows its released value. Cancel requires an audit note.
- **DOC extensions:** tracked request letters per work — one draft at a
  time (conflict returns the existing draft id); the new completion date
  must be after the current one; addressee (engineer in charge) and content
  required. Draft PDF watermarked DRAFT; finalize assigns
  `<work_code>-Extension-NN` sequentially. **Manual back-fill** records
  (paper letters issued outside the system) take reference + letter date
  (not future), occupy the next sequence slot immediately as final, and
  warn (without blocking) when dated after the first software-generated
  letter. Finalized letters are permanent records: edits gated on the
  approvals permission (audit-logged), software-generated finals can never
  be deleted, and manual records are deletable only by an approver and only
  from the top of the sequence (no numbering gaps). The dashboard shows
  works whose DOC falls due within a 30-day window.

### 5.6 Edit approvals (four-eyes on legally significant records)

Changing records that already carry legal weight requires approval:
**editing an issued DC or IC** (e.g. more material reached site and the
consignee wants an updated challan — the number stays the same), **editing
an installation record**, and **amending a ledger item**.

- Approvable entities: delivery challan · issue challan · installation ·
  work item. The requester must hold the entity's base edit permission and
  have access to the target work, and files the proposed change payload
  with a mandatory reason. One pending request per record at a time
  (conflict otherwise); a requester may withdraw their own pending request.
- Every approvals-permission holder sees the queue (page + badge; requesters
  see their own). Approving **claims the pending request atomically — first
  decision wins** (a second decider gets a conflict) — then applies the
  change against **live state with full re-validation** (challan must still
  be issued; DC edit blocked if its serials are installed; excess re-checked
  without counting the challan's own existing quantity; installation totals
  re-capped; amendments re-floored). If application fails, the claim is
  released back to pending so the queue stays truthful. Rejection takes a
  note.
- A requester who *holds* the approvals permission applies directly; the
  system auto-records an approved request so the audit trail is identical
  (and records a cancelled request with the failure reason if the direct
  apply fails).

### 5.7 GST compliance (e-invoice & e-way bill)

- **Tax invoices:** draft (buyer from Contacts, lines with per-line GST %
  defaulting to 18, HSN per line) → issue assigns `INV/<FY>/NNN` → PDF with
  GST columns; once an IRN exists the PDF carries the IRN/acknowledgement
  strip and the **signed QR code**. Issued invoices cannot be edited
  (cancel and re-raise). Cancel takes an audit note and is **blocked while
  an active IRN or an active EWB exists** (cancel those first); delete only
  while draft. Per-line taxable value is rounded then summed (R13).
- **IRN:** generate against an issued invoice via a GST Suvidha Provider
  gateway (provider-agnostic core with a mock transport for tests; sandbox/
  production switchable). Before any network call, an **arithmetic gate**
  revalidates the payload exactly as the government portal would (per NIC
  INV-01): per line `TotAmt = Qty × UnitPrice`, `AssAmt = TotAmt −
  Discount`, `TotItemVal = AssAmt + GST + Cess`; totals = round each line
  to 2 decimals then sum (never round a sum independently); every mismatch
  is listed in one error so the operator fixes data once. Duplicate active
  IRN rejected. Cancel only within **24 h** of generation (after that:
  credit note; buttons disable with the explanation).
- **EWB:** generated against an **issued** DC (challan flow, document type
  CHL) or from an IRN (invoice flow; the IRN record keeps the EWB link).
  Required strictly **above ₹50,000** consignment value (exactly 50,000 is
  exempt; below-threshold generation allowed and flagged voluntary).
  Transporter/mode/distance now, vehicle later via **Part-B** update.
  Validity: 1 day per **200 km or part thereof**, minimum 1 day
  (⚠ re-verify the current statutory km/day figure before production
  go-live). Extend validity supported. Cancel only within 24 h. One
  active EWB per document; duplicates rejected. Status lamps: green =
  active; amber = expiring within 24 h or Part-B pending; red =
  expired/cancelled/failed. Provider error codes are surfaced verbatim
  (`[NIC nnnn]`) for support tickets.
- **GSTIN handling:** buyer/ship-to GSTIN falls back to `URP` (unregistered)
  when blank; GSTIN format validated but **deductor GSTINs ending in D
  accepted** (railway units); a master-data **preflight** checks company and
  buyer particulars (GSTIN, state codes, pincodes, HSN ≥ 6 digits) before
  the first generation attempt.
- A **compliance dashboard** summarizes IRNs and EWBs with lifecycle
  status counts.

### 5.8 Procurement

- **Contacts** double as vendors/clients (role flags). Manage from Masters.
- **Shared lifecycle:** PO and BQ follow draft (no number) → issue (FY-wise
  gap-free number) → cancel. Drafts are deleted on cancel; cancelling an
  issued document requires an audit note. **Editing an issued PO/BQ is
  reserved for approvals-permission holders** and audit-logged as an
  issued-document edit. Document date defaults to today and cannot be in
  the future. List views show vendor, item count, total value (Σ qty ×
  rate), and PO fulfilment (ordered vs linked quantities).
- **PO:** items from a linked work or manual (description, positive qty,
  non-negative rate); PDF renders bill-to (always the company) and ship-to
  (company or a consignee address). **Vendor dispatch documents** — the
  vendor's own challan or tax invoice (type, number, date, optional
  type-checked file) — attach to an issued PO, closing the loop that DC
  lines link back to (§5.2). An "open items" view lists issued-PO lines
  with how much of each is already linked by non-cancelled DCs.
- **BQ:** quotation to a vendor/client against their enquiry reference or
  suo moto; carries validity days; PDF.

### 5.9 Measurement books (the partial-bill cycle)

The MB is the billing heartbeat of a work. The cycle: deliver/install →
raise an MB for the newly executed quantities → verify it against the
payment matrix → raise a tax invoice from the MB → repeat until the
**final MB** (which bills the final-bill stage) closes the work's payment
cycle. A work can have many MBs; each bills only the **deltas** since the
last one.

**Sources.** An MB is built from the work's not-yet-billed records — its
"open sources": issued delivery challans, recorded installations, and
recorded PAC certificates. Each source record is billed by **at most one
MB** (hard uniqueness); cancelling an MB releases its sources for a
corrected MB. The per-item deltas are the sums over the selected sources:
supplied Δ from DC lines, installed Δ from installations, PAC Δ from PAC
certificate items.

**Lifecycle.** Draft (editable, recomputed on every edit; one open draft
per work, conflict returns the existing draft id; only raisable on an
active work; MB date ≥ LOA date, not future) → **finalize** (recomputes
from live state, assigns `<work_code>-MB-NN` gap-free under a per-work
lock) → **invoice** (a draft tax invoice is generated from the MB — see
below) → the invoice's own lifecycle. Cancelling: a draft deletes; a
finalized MB requires an audit note, is blocked while its invoice lives,
and **only the newest live MB may be cancelled** (deltas must stay
coherent); cancelling releases the sources. Once a final MB exists (any
non-cancelled status), **no further MBs can be raised** on the work; the
final MB must sweep **every** remaining open source.

**Coherence guards** (enforced across modules): a DC, installation, or PAC
billed in a live MB cannot be cancelled, and approval-applied edits to a
billed DC's lines or a billed installation's quantity are blocked — the MB
must be cancelled first. Cancelling the tax invoice raised from an MB
releases the MB back to finalized so a corrected invoice can be raised.

**Invoice generation.** From a finalized MB, one draft tax invoice: one
line per item **stage** with a nonzero amount — description
`<item> — <stage> <pct>% on <qty> <unit> (<MB no>)`, quantity 1, unit LS,
rate = the exact MB stage amount (so invoice and MB match to the paisa),
HSN from the item, GST % chosen at generation (default 18). The MB is
marked invoiced and linked to the invoice.

#### The MB remark algorithm (contractual wording)

Every MB line carries a remark built EXACTLY as follows (derived from the
agency's example workbook; the wording is a contract — the unit test
replicates the full example table character-for-character):

1. Stage order is always: **supply, installation, PAC, final bill**.
2. **Prepaid clause** — cumulative memory of all prior MBs. For each stage
   whose stage-% is nonzero AND whose cumulative previously billed
   quantity is nonzero: `<pct>% for <qty> <unit>`; join the clauses with
   ` and `; prefix `Prepaid `; end with `. `. Omit the whole clause on an
   item's first-ever billing. Cumulative means **true cumulative** — the
   sum over all prior non-cancelled MBs (the workbook's MB4 row was a
   confirmed copy-paste error; the corrected wording is authoritative).
3. **Now-to-pay clause** — this MB's deltas. Same format per stage with a
   nonzero delta, prefixed `Now to pay `; the final-bill stage (final MB
   only) comes last. If no stage has a delta: `Now to pay nill.`
   ("nill", double-l, exactly).
4. Punctuation is normalised to a full stop after each clause (the
   workbook was inconsistent; normalisation confirmed 13/07/2026).
5. Quantities and percentages render without trailing zeros (5000, 12.5);
   the unit is the item's unit string verbatim.

Example (matrix 80/10/–/10, unit mtr): first MB supplying 5000 →
`Now to pay 80% for 5000 mtr.`; a later MB installing 2000 after 6000
supplied/3000 installed were billed →
`Prepaid 80% for 6000 mtr and 10% for 3000 mtr. Now to pay 10% for 2000 mtr.`

**Final-bill stage base** (billed only on the final MB, per the workbook's
special notes): for supply items — category SUPPLY or SPARE_SUPPLY, or
uncategorised items whose description does not mention installation — the
final % applies to **100 % of the delivered quantity**, irrespective of
installation. For SUPPLY_AND_INSTALLATION and PURE_INSTALLATION items (or
uncategorised items that do mention installation), it applies to the
**installed quantity** only — supplied-but-never-installed material earns
its supply stage and nothing more.

**Stage amounts:** `round2(Δqty × effective_rate × stage% / 100)` per
stage, line-rounded then summed (R13). The MB snapshots the percentages
and rate it billed with — later matrix changes never mutate a raised MB.

**MB document (PDF):** letterhead, MB number/date, work identity, item
table (schedule/serial, description, unit, supplied Δ, installed Δ,
PAC Δ, amount, remark), total payable this MB, amount in words; DRAFT
watermark until finalized; FINAL BILL banner on the final MB.

### 5.10 Serial traceability

A dedicated lookup: enter any serial number → trace to its work, delivery
challan, installation record, and location. Serial rules throughout: unique
per work item; max 60 chars; duplicates within one submission rejected;
created at delivery; installable once, only after delivery; released by DC
cancel (if not installed) and by installation cancel.

---

## 6. Business rules & invariants (the law)

These must hold under all concurrency and in every future re-implementation:

- **R1 — Work code:** 1–20 chars, uppercase letters/digits/`- _ /`, starts
  alphanumeric. Unique forever: soft-deleted works retain their code and
  letter number, and codes are **not reusable** after deletion (so a challan
  series can never be duplicated). Undelete rather than recreate.
- **R2 — Gap-free numbering:** challan numbers within a work's series are
  strictly sequential with no gaps; **cancelled numbers are never reused**.
  Concurrent issue operations must neither duplicate nor skip numbers
  (serialize per work). Same discipline for FY-wise PO/BQ/INV counters and
  extension-letter numbers.
- **R3 — One open draft:** at most one draft DC per work, one draft IC per
  work, one draft extension letter per work. The "already exists" error
  carries the existing draft's id.
- **R4 — Delivery cap:** per item, total delivered across issued DCs ≤ LOA
  qty — unless the work's excess-delivery toggle is on, which lifts the
  **delivery** cap only.
- **R5 — Installation cap:** per item, total installed ≤ **LOA qty**,
  always. The excess toggle never applies (payment is per LOA qty). If the
  railway sanctions more, amend the item quantity first. Additionally, for
  supply-type items (§5.4), total installed ≤ total **delivered**.
- **R6 — Serial integrity:** serial values unique per work item; cannot be
  installed before delivery; cannot be installed twice; DC cancel blocked
  while any of its serials is installed; cancel releases serials.
- **R7 — Amendment floor:** an item amendment reducing quantity cannot go
  below what is already delivered or installed. Items can be added (rate
  auto-inherits the schedule percentage; serial number within the schedule
  counts soft-deleted rows so it stays unique forever) and removed **only
  while nothing is delivered/installed** (soft-delete with audit note).
  Serial tracking cannot be switched off on an item once serials exist.
- **R8 — Work completion:** a work can be marked `completed` only at 100 %
  executed value — every item fully installed and every supply item fully
  delivered. Short-closure = first amend quantities down (which itself
  requires approval), then complete. Completion/reopen takes an audit note.
- **R9 — Approvals:** edits to issued DCs/ICs, installation records, and
  item amendments go through the approval workflow (§5.6); approval
  re-validates everything at apply time; self-approval by an approvals
  holder is auto-recorded.
- **R10 — Payment stages:** four stages per item — supply / installation /
  PAC / final bill — must sum to exactly 100 (percentages validated 0–100).
  Percentages live **only** in the per-work payment matrix by item category;
  there is deliberately no per-item percentage entry (built once, reverted
  on user request — do not re-add).
- **R11 — Document dates:** challan/installation dates must not be in the
  future and not earlier than the work's LOA date. Completion date ≥ LOA
  date.
- **R12 — Quantities & rates:** quantities strictly positive; rates
  non-negative; the same work item may not appear twice in one challan
  (merge quantities).
- **R13 — Monetary rounding:** round each line to 2 decimals, then sum.
  Never round a sum independently of its lines. (This is also what the
  government e-invoice portal enforces.)
- **R14 — GST windows & thresholds:** IRN/EWB cancellable only within 24 h;
  EWB required strictly above ₹50,000; EWB only against an *issued* DC; one
  active IRN per invoice, one active EWB per document; invoice cancel
  blocked while an active IRN exists.
- **R15 — Status lifecycles:** works `active|completed|cancelled`; DCs/ICs
  `draft|issued|cancelled`; installations `recorded|cancelled`; invoices
  `draft|issued|cancelled`. Deletes only ever for drafts; everything else
  cancels with a note. Cancelling a work is blocked while draft challans
  exist; soft-deleting a work is blocked while it has **any** challans or
  installations (cancel/delete those first, or mark the work completed).
- **R16 — Consignee semantics:** a work may have many consignees; the
  challan picks one. Bill-paying and awarding authorities are never
  consignees.
- **R17 — Audit everything:** every create/update/cancel/delete/permission
  change writes an audit entry (who, when, what, detail). Cancels and
  destructive edits require a human-entered note.
- **R18 — PAC cap:** per item, total PAC-certified quantity ≤ installed
  quantity; each new certificate is capped at installed minus already
  certified.
- **R19 — MB coherence:** a source record (issued DC, installation, PAC)
  is billed by at most one measurement book, ever; billed sources cannot
  be cancelled or quantity-edited while their MB lives; only the newest
  live MB of a work may be cancelled; one open MB draft per work; no MBs
  after the final MB; the final MB sweeps every open source; the MB remark
  wording follows §5.9's algorithm exactly.

---

## 7. Numbering schemes

| Document | Format | Series rules |
|---|---|---|
| Delivery challan (work-linked) | `<PREFIX>-NNN` (NNN zero-padded to 3), e.g. `PL-270-DC-001` | Per work & type; default prefix `<work_code>-DC`; custom prefix allowed but validated against every other work's custom **and default** prefixes (challan numbers are globally unique — collision → conflict error); gap-free; assigned only at issue inside the same transaction; cancelled numbers never reused |
| Delivery challan (standalone, no work) | `DC/<FY>/NNN` | Company-level FY-wise series |
| Issue challan | `<PREFIX>-NNN`, default prefix `<work_code>-IC` | Same discipline as work-linked DC |
| Tax invoice | `INV/<FY>/NNN` | FY-wise, gap-free, assigned at issue |
| Purchase order | `PO/<FY>/NNN` | FY-wise, gap-free, assigned at issue |
| Budgetary quotation | `BQ/<FY>/NNN` | FY-wise, gap-free, assigned at issue |
| Extension letter | `<work_code>-Extension-NN` (NN zero-padded to 2) | Per work, sequential, assigned at finalization; manual back-fill records occupy the next slot; only the top-of-sequence manual record may ever be deleted (no gaps) |
| Measurement book | `<work_code>-MB-NN` (NN zero-padded to 2) | Per work, gap-free, assigned at finalization under a per-work lock; cancelled numbers never reused |

FY = Indian financial year, labeled from the document's own date with an
April–March boundary (`2026-05-12` → `2026-27`). Series prefixes: letters,
digits, `- _ /`, max 25 chars. Drafts never consume a number; numbering is
serialized per scope (per work, or per type+FY) so concurrent issues can
neither duplicate nor skip.

---

## 8. Ledger & payment mathematics

Per work item, the ledger derives (only **issued** DCs and non-cancelled
installations/PACs count):

```
delivered_qty        = Σ qty over items of ISSUED delivery challans
balance_to_supply    = max(loa_qty − delivered_qty, 0)
installed_qty        = Σ qty over non-cancelled installations
pending_to_install   = max(loa_qty − installed_qty, 0)
delivered_value      = round2(delivered_qty × effective_rate)
balance_value        = round2(balance_to_supply × effective_rate)
pac_qty              = Σ qty certified by recorded PAC certificates

payable_to_date      = round2(
      delivered_qty × effective_rate × pct_supply/100
    + installed_qty × effective_rate × pct_installation/100
    + pac_qty       × effective_rate × pct_pac/100 )
    -- the final-bill stage accrues at final measurement, not here
```

Item **payment categories** (assigned at LOA review, editable later): Supply
/ Supply + Installation / Purely Installation / Spare Supply. Each category
maps to a four-stage percentage split in the per-work **payment matrix**
(§6 R10). A work's executed value (for the completion rule R8) is the value
fully delivered and installed as applicable per category.

---

## 9. Master data

- **Company profile:** name, legal name, address, GSTIN, state code,
  pincode, logo, signatories, warranty/guarantee text, default challan
  prefix — drives all PDF letterheads.
- **Contacts:** one master for consignees / vendors / clients with role
  flags; GSTIN format-validated and uppercased (deductor `…D` accepted);
  duplicates rejected on designation + station. Contacts are **retired**
  (deactivated), never deleted — history keeps its references while pickers
  hide inactive entries; pickers default to consignee-role contacts so
  railway document flows stay railway-only. Import from external contact
  exports supported (an initial 126-contact import from a Zoho export was
  performed).
- **Locations:** stations / installation points; creatable inline from the
  installation form.
- **Units:** seeded list (Numbers, Metre, Kilometre, RMT, RKM, Set, Lot,
  Pair, Month, Year, Lumpsum, Job, Litre, Kg), extendable.

---

## 10. Reports, dashboard, and lookup

**Seven ledger reports**, each per-work **or consolidated across all works**
(work-scope filtered), every column toggleable, exportable to a spreadsheet:

1. Items already supplied
2. Balance to supply
3. Items installed
4. Pending to install
5. Value of items delivered
6. Value of balance items
7. Value delivered as per railway payment percentage

Requested columns are validated against the ledger's column whitelist; value
reports return a rounded grand total.

Plus two special reports:

- **Installation report** (for the railway engineer): fixed layout — Sr No ·
  Schedule No · Item · Schedule Qty · Previously installed · Installed now ·
  Locations · Remark — every column individually selectable. Two modes: a
  **date range** ("now" = installs within the range, "previously" = before
  it) or **selected entries** ("now" = the chosen installation entries,
  "previously" = all other non-cancelled entries). Only items with a
  nonzero "installed now" appear.
- **Measurement / bill summary**: stage-wise per-item amounts — supply
  (delivered × rate × supply %), installation (installed × rate ×
  installation %), PAC (PAC qty × rate × PAC %), payable-to-date — plus LOA
  value and column totals; spreadsheet export merges the user's per-item
  remarks.

**Dashboard** (computed in the business timezone, work-scope filtered, each
panel capped at the top 20):

- Summary: count and total contract value of active works.
- **PBG submission deadlines** — works whose PBG is due but not submitted,
  with days-left; when overdue with a positive PBG amount, an **estimated
  penal interest** is shown (amount × 12 % p.a. / 365 × days overdue).
- **PBG validity alerts** — active works whose PBG validity is within 90
  days of expiry *or* short of completion date + 60 days (shows the
  required validity date, the shortfall flag, form, and FDR auto-renewal).
- **Completion deadlines** and **DOC alerts** — active works within 30 days
  of (or past) their date of completion, with the extension letter as the
  corrective action.
- **Work progress** — per-work delivered value vs total LOA value and
  payable value.
- Pending-approvals badge.

**Compliance dashboard:** counts of active EWBs, EWBs expiring within 24 h,
overdue EWBs, and issued invoices missing an active IRN.

**Serial lookup:** substring search (min 2 chars, results capped with a
truncation flag) → each match traces to its item, work, delivery challan
(number/date/status/consignee), installation, and location.

**Audit log viewer:** filterable trail of every mutation.

---

## 11. Generated documents (PDFs)

All on the company letterhead (logo, GSTIN, addresses, signatories):

- **Delivery challan** — items, quantities, consignee, dispatch parties,
  signature blocks; serial-number column renders **only when serials
  exist**; optional **warranty/guarantee certificate page** (text from
  company profile). Draft prints watermarked DRAFT.
- **Issue challan** — same conventions, loan/return annotations.
- **Tax invoice** — GST columns (per-line HSN, GST %, CGST/SGST/IGST
  breakup), totals in words; IRN/acknowledgement strip + **signed QR** once
  an IRN exists.
- **E-way bill summary** — printable EWB details for the driver.
- **PO / BQ** — item tables with rates, terms, validity.
- **Extension letter** — formal DOC-extension request; DRAFT watermark
  until finalized.

PDF preview happens in-app (modal with "open in tab"), not via popups.

---

## 12. Security expectations (architecture-independent)

- **Secrets:** the system must refuse to start in production with missing,
  placeholder, or short (< 32 chars) signing secrets.
- **Uploads:** validate file content by **magic bytes** (PDF/PNG/JPEG),
  never by client-declared type; store under server-generated opaque keys —
  original filenames never become storage paths; reject `..` and absolute
  paths on any local fallback and assert resolved paths stay inside the
  designated directory (both write and read).
- **Document access:** uploaded documents (LOA PDFs, PBG docs, signed
  copies, logo) are streamed through authenticated endpoints; the store
  itself stays private.
- **CSRF:** all mutating API requests pass an origin check (or equivalent
  proven mechanism); the choice and its rationale must be documented.
- **SQL/queries:** all data access parameterized/bound. Never interpolate
  user input into query text. (An automated static audit of every query is
  part of the test suite today — keep an equivalent.)
- **Rate limiting:** login and expensive endpoints (LOA extraction)
  throttled; the limiter must be shared across instances before scaling
  beyond one (or enforced at the edge).
- **Logging:** every API request logged with a request id (echoed to the
  client), method, path, status, duration, user id — **never** bodies,
  secrets, or passwords. Users can quote the request id for support.
- **Headers:** standard security headers; scripts restricted to
  same-origin.
- **Master-admin protection:** the master admin cannot be disabled,
  demoted, or stripped by anyone; permission expansion always runs
  server-side.
- **Concurrency:** numbering and one-draft rules hold under simultaneous
  requests (serialize per work, e.g. via advisory locking or equivalent).

---

## 13. Data-handling conventions

- **Calendar dates carry no time or timezone.** Store as date-only; compare
  and normalize as `YYYY-MM-DD` strings in the business timezone (IST by
  default, configurable). Never round-trip a date-only value through a
  timezone-aware datetime (classic off-by-one-day bug). Display as
  `DD/MM/YYYY` everywhere.
- **Money:** two-decimal line rounding then summation (R13); display in
  Indian formatting (₹, lakh/crore grouping where shown).
- **Soft delete:** works and work items are soft-deleted (audit trail
  preserved, uniqueness retained — R1). Only drafts are ever hard-deleted.
- **Snapshots:** issued documents snapshot what they printed (consignee
  details, rates) so master-data edits never mutate history.
- **Empty vs zero:** blank numeric inputs are stored as null, never 0;
  blank payment category is null, not `''`.

---

## 14. UX & design language ("Signal Cabin") — condensed

The full design system lives in docs/design-system.md; the portable essence:

- **Light "ledger paper" (default) with dark instrument panel as an explicit,
  persisted per-user toggle** (light is faster and more accurate for reading
  on budget Android devices outdoors, where sustained brightness ~400 nits
  falls short of 1000–1500 nits outdoor legibility; positive polarity [dark
  text on light] improves performance). Primary accent **amber**, used only
  for primary actions, focus, and live signals.
- **Status = signal lamps** (glowing dot + label): green = proceed/issued,
  amber = caution/pending/draft, red = stop/overdue/cancelled, blue = info.
  Never color alone.
- **Tables are the product:** ~13 px body, ~40–44 px rows (default; compliant
  with WCAG 2.2 §2.5.8 24×24 px target minimum), sticky headers, sticky first
  column on wide ledgers, right-aligned monospaced tabular numerals for every
  number/date/amount, priority column hiding at ≤1200 px and ≤900 px
  breakpoints. ~37 px available as an opt-in ultra-dense mode.
- Dense two-column forms (desktop) with sticky action bars on create flows;
  live balance chips in item pickers; serial chips with multi-paste.
- Skeletons for loading; empty states = one operational sentence + one
  action; errors persist inline until fixed (toasts only for success).
- Motion minimal and once-only; must fully respect reduced-motion
  preferences.
- Icons from a single consistent set; **no emoji** anywhere in the product.
- Keyboard: `/` focuses works search; `Esc` closes overlays. Deep-linkable
  tabs on Work Detail (`?tab=`), actionable errors deep-link (e.g. "Open
  existing draft").

---

## 15. Quality expectations & acceptance criteria

- **The automated test suites are the spec.** Today: parser regression
  against 5 real IREPS LOAs / 227 items (all values reconciling); static
  audit of every query for parameterization; unit tests for business rules,
  GST rules, and payload arithmetic; integration flows for
  ledger math, work scope, approvals lifecycle, concurrency hardening
  (parallel issue → no duplicate/skipped numbers; parallel draft → exactly
  one), invoices, extension letters, and upload security. Any rebuild must
  port these assertions **first** and treat them as acceptance criteria,
  not reference.
- CI must run all suites against a real database and **fail — not skip —**
  when the database is unavailable. Deploys are gated on green tests.
- Schema/data-model changes are tracked, ordered migrations; fresh-install
  and upgrade paths both maintained and both tested.
- Legally significant flows (challans, invoices, GST) must be verified
  end-to-end before release, not only unit-tested.

---

## 16. Roadmap & settled decisions (do not re-litigate)

**Pending (Group B/C, as of 13/07/2026):**

- HSN data entry on work items / invoice lines before first production IRN.
- Real GSP sandbox credentials + verification of the statutory EWB km/day
  figure before GST go-live.
- IRWCMS MB auto-fill: recommended path is copy-ready export matching the
  railway portal's measurement-book screens (not browser automation);
  awaiting user decision and portal screenshots.
- Group C (office/HR ERP, after B): store ledger of office inventory, staff
  attendance (manual vs biometric undecided), leave requests (reuse the
  approvals workflow), salary slips (blocked on salary structure +
  attendance).

**Settled domain decisions:**

- BQ = Budgetary Quotation, not bill of quantities.
- Sr.DFM/DFM/ADFM = bill-paying authority; Sr.DSTE-type signatory =
  awarding authority; neither is ever a consignee.
- Payment percentages live only in the per-work payment matrix by category;
  per-item % entry was built and deliberately removed.
- Serial tracking is opt-in per item and never pre-ticked.
- The contacts master is named **Contacts** in the UI.
- Excess toggle affects delivery only, never installation.
- Tax-invoice numbering defaults to `INV/<FY>/NNN` (agency's preferred
  series still to be confirmed).

---

*This specification describes externally observable behavior only. Where an
implementation detail appears (e.g. bcrypt cost, advisory locks), read it as
"an equivalent mechanism with these guarantees". Keep this document in sync
with CLAUDE.md / DESIGN.md when rules intentionally change.*
