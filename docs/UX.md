# Auto-MB product experience contract

## Purpose and status

This document is the binding UI/UX contract for Auto-MB. It records what the
interface must be, what it is allowed not to be, and how that is proved.

Owner decision, 2026-08-16 (refined 2026-08-17): the Vercel/v0 mock repository
`punyanagari/Auto-MB-Vercel-du` is the design contract, replacing the "quiet
light" visual language blessed on 2026-08-12. The rationale, the
design-port-not-code boundary and the iteration pipeline are in
`adr/0014-v0-mock-as-design-contract.md`. The rule itself is in `AGENTS.md`
§ Design contract (PR #96). `docs/DESIGN.md` is this document's component- and
token-level companion.

What changed on 2026-08-16 is the visual language and the information
architecture. What did not change is everything below the paint: the shared-state
model, focus and keyboard behaviour, the accessibility gate, and the rule that
the server remains authoritative. Those sections are carried forward from the
previous contract, updated where the mock moved them.

`docs/PRODUCT.md` defines the domain and its invariants; this document defines
how operators move through them.

## The frozen mock

|                            |                                                                               |
| -------------------------- | ----------------------------------------------------------------------------- |
| Repository                 | `github.com/punyanagari/Auto-MB-Vercel-du`                                    |
| Freeze commit              | `fdfd610` (`Merge pull request #10 from punyanagari/v0/43saps-3469-f4d692dc`) |
| Local clone at that commit | `C:\Users\agast\Downloads\Auto-MB-Vercel-du`                                  |
| Live render                | `https://satyakosh.vercel.app`                                                |

Advancing the freeze commit is an owner action recorded in `docs/DESIGN.md`
§ Freeze pointer, taken only after the delta has been diffed and ported.

## Fidelity contract

1. **The mock is replicated exactly.** Screens the mock covers are built to look
   like the mock, not like an interpretation of it.
2. **Tokens are ported verbatim.** The oklch values, the radius scale, the type
   families and weights are copied, not re-derived. Their _delivery mechanism_
   stays the application's (`data-theme` on `<html>` plus `light-dark()` pairs);
   only the values are the contract. See `docs/DESIGN.md` § Token architecture.
3. **Shared screens are visually indistinguishable.** Open the mock and the
   application side by side at the same width and theme; a reviewer must not be
   able to tell which is which from the layout, spacing, type or colour.
4. **Pixel drift is a bug, not a liberty.** "Slightly tidier", "more consistent
   with our other screen" and "the designer probably meant" are all defects. The
   remedy for a mock the team disagrees with is to change the mock in v0.
5. **Every visible change cites a mock screen by path** in the frozen clone —
   for example `app/challans/page.tsx` plus `components/document-register.tsx`.
   A visible change with no citation is unapproved visual invention.
6. **Behaviour the mock cannot express is built in the mock's grammar.**
   Validation, real data, permission refusals, concurrency and lifecycle states
   reuse the mock's existing components and tokens. No new visual language is
   invented to express them.

## Approved divergences

This list is exhaustive. A divergence not on it is a defect. Adding to it is an
owner decision, not an implementation decision.

### 1. Type: IBM Plex Sans (Devanagari) and IBM Plex Mono

The mock loads IBM Plex Sans and IBM Plex Mono from `next/font/google` with the
`latin` subset only. The application ships the same two families, self-hosted
through `@fontsource-variable/ibm-plex-sans`, `@fontsource/ibm-plex-mono` and
`@fontsource/ibm-plex-sans-devanagari`, with the Devanagari companion in the
`--font-sans` stack.

The divergence is delivery and script coverage, not the typeface: Indian Railways
correspondence, party names and place names carry Devanagari, and a latin-only
subset renders them in a fallback face that breaks the mock's own metrics. The
mock's weights (400/500/600/700 sans, 400/500/600 mono) and its
`font-feature-settings` remain the contract.

### 2. Full mobile shell

The mock is desktop-first. It ships a mobile shell — a fixed bottom bar below the
`lg` breakpoint with four cells (Home, Works, Record, More) and two bottom sheets
(`components/mobile-navigation.tsx`) — but that shell is _navigation only_: the
Record sheet links to desktop screens and the More sheet is a flat module list.

The application keeps the mock's bar and sheets exactly as drawn, and builds the
site-facing task flows behind them — receipt capture, serial capture,
installation recording, evidence attachment, offline and service-error messaging,
persistent save state — in the mock's visual grammar, using its `Sheet`, `Field`,
`Card` and `StatusBadge` components. Cells keep the mock's `min-h-14` touch
target and its `env(safe-area-inset-bottom)` padding.

Large financial, numbering and organisation-administration surfaces stay
office-first. Offline synchronisation is not implied in copy until it is
implemented.

### 3. Members: per-feature permission matrix, not roles

The application's Members screen keeps the per-feature permission matrix and the
per-member work assignment. Any Owner/Editor/Viewer role collapse is **rejected**
under the `AGENTS.md` rule against replacing the per-feature permission matrix,
and would be rejected even if a future mock proposed it.

At `a8e1fde` the mock agrees: `app/members/page.tsx` renders a feature-column
matrix with an "All works access" checkbox and assigned-work chips, and its own
copy says the matrix "renders from feature definitions and can expand". The
application renders the real feature set rather than the mock's six
representative columns, and the real permission and work-scope semantics behind
it. The divergence is recorded anyway, because it is the one place where a mock
change would not be followed.

### 4. Screens the mock does not cover

The mock covers the shell and the main registers. The application covers more
product than the mock draws. Each of the following is built inside the mock's
visual grammar — its components, tokens, density and page-header pattern — with
no new visual language:

- **PAC certificates.** The mock shows a read-only "PAC / BG certificates" list
  inside the Work's Instruments section (`components/work-registers.tsx`). The
  application's issuance, validity tracking and evidence surfaces are additive.
- **Timeline.** Present in the mock as the Work workspace's first section
  (`components/work-section-nav.tsx`); the application's audit timeline, amendment
  chains and approval decisions render into it.
- **Completion extensions.** Extension-of-time letters and revised completion
  dates. No mock screen.
- **Tender-terms review.** Extracted tender clause and item-mapping review from
  LOA intake. The mock's Tenders module is a bidding workspace, not this.
- **Authentication depth.** The mock's `app/sign-in/page.tsx` is a single card
  stepping credentials → two-factor → organisation chooser, and
  `app/onboarding/page.tsx` is a one-form organisation create. The application's
  two-factor enrolment, recovery codes, password recovery, account security,
  organisation access settings and multi-organisation entry are additive; they
  reuse that card, its `Field`/`FieldGroup` anatomy and its centred layout.
- **Billing depth.** Measurement-book finalisation, billing-readiness checklists,
  bill settlement, railway bill rendering, tax-invoice IRP transport and credit
  notes go well past the mock's registers.
- **Lifecycle-locking surfaces.** The mock's outward-document lifecycle machine
  (see § Document lifecycle) is drawn for one document type; the application
  applies it to challans, invoices and measurement books, which needs per-type
  guard copy the mock does not carry.
- **Wayfinding refusal→remedy errors.** The mock ships `RemedyError`
  (`components/remedy-error.tsx`) as a component. The application's remedy
  catalogue (`apps/server/src/remedies.ts`) supplies many more refusals than the
  mock demonstrates, each rendered through that component.

### 5. Token-level accessibility fixes

Where the real-render axe gate fails a text/background pair on a mock token, the
token value is adjusted until it passes, and the adjustment is flagged to the
owner as a divergence with the measured ratio, the screen, and the theme it
failed in.

The mock is the design contract; it is not an exemption from WCAG AA. The
adjustment is the minimum that clears the gate, applied at token level so it
propagates everywhere rather than being patched per screen. Ideally the owner
then feeds the corrected value back into v0, which retires the divergence.

### 6. Mobile bar: the More cell keeps `MoreHorizontal` — RESOLVED UPSTREAM

**Status: resolved by the mock at `fdfd610` (2026-08-18). No longer a
divergence.** Kept on the list rather than deleted, because the list is the
record of what was decided and why; an entry that disappears takes its
reasoning with it.

The mock's bottom bar drew its fourth cell with `Menu`
(`components/mobile-navigation.tsx`), the same icon its topbar uses to open the
navigation drawer. The application drew it with `MoreHorizontal` instead.

Two identical hamburgers on one screen is an ambiguity, not a style: below `lg`
both are visible at once, and a pointer landing on either has no way to tell the
drawer from the overflow sheet. Everything else about the cell — its label, its
`min-h-14` target, its sheet — was already the mock's.

The convergence path was upstream, and it has now been taken: `fdfd610` changes
that cell to `MoreHorizontal` in v0. The application's icon is unchanged and is
now a replication rather than a divergence.

### 7. Serial traceability renders as a data table, not the mock's Sheet

The mock answers a serial hit with `components/serial-trace-panel.tsx`, a Sheet.
The application answers it with `views/SerialTrace.tsx`, its ordinary data table,
rendered inline under the Global Search scopes (§ `#/serials` merges into Global
Search).

The table carries more facts than the panel has room for — the Delivery Challan
and its state, whether receipt was recorded at the far end, the installation date
and the station the unit went in at — and those columns are the answer an
operator came for, sortable and scannable across many serials rather than one at
a time. The Sheet remains an option for a future polish pass: nothing in the
chain depends on the container, so moving the same columns into the mock's Sheet
is a presentation change whenever it is worth making.

### 8. The status chip is the product's, where a mock screen reaches past it

Owner decision, 2026-08-18.

`docs/DESIGN.md` § Status badge semantics makes one shape the whole product's
vocabulary for record state: a 24px `rounded-md` outline chip, 11px semibold,
preceded by a dot that inherits the ink. The mock's own `components/shared`
`StatusBadge` is that shape, and every register it draws uses it — except that
`components/company-document-library.tsx` reaches past it for a raw
`Badge variant="destructive"` reading "Expired".

The application renders the shared chip there instead. The reason is not
tidiness: the dot-plus-label is what keeps record state off the colour-only
path (WCAG 1.4.1), and it is what the dual-theme axe gate checks. A single
screen opting out of the product's status grammar is the mock being
inconsistent with itself, so the divergence follows the mock's rule rather
than the mock's pixel.

Two status keys are added to the chip's tone map for it — `valid` (success)
and `archived` (neutral, by being deliberately unmapped) — alongside
`expiring`, which the mock's own `statusStyles` already carries.

**Convergence path.** This is the divergence that should not survive: the fix
belongs in v0, where that one screen adopts `StatusBadge` like every other
register. When it does, the port drops to a byte-for-byte replication and this
entry retires.

### 9. Inspection screen

**Status: APPROVED — owner decision, 2026-08-18.** Every entry below is a visual
departure this pack shipped because the behaviour behind the mock's
control does not exist, or because the control would have to lie. None of
them is an implementation liberty: the owner ruled on each, and the convergence
path for all of them is the same — change the mock in v0, then the divergence
retires.

Category: this is § 4 territory (screens and behaviour the mock does not
cover) applied to a screen the mock DOES draw, which is why each entry
names what the mock shows and what stands in its place.

| #   | The mock draws                                                                    | The application ships                                                              | Why                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7a  | A "Source" column on the checklist config: Generate / Upload / Generate-or-Upload | No column; every paper is an upload                                                | Nothing in this product generates a datasheet or an undertaking. The mock's Generate button fakes a filename. A control offering an action with no implementation behind it is worse than its absence. |
| 7b  | `DscSigningGate` around the call letter and the routine test report               | No signing gate                                                                    | Outbound signing is ADR-0012's hybrid model and is not procured.                                                                                                                                       |
| 7c  | An "Inspection result" select (Pending / Successful)                              | No control; uploading the certificate records the pass                             | The certificate is the agency's own statement that it accepted the material. A second field saying so can disagree with the document.                                                                  |
| 7d  | An items card listing candidate items across works, with the call raised inline   | The card is absent; calls are raised from the Work's Inspection clause tab         | The mock's list is module-scope seed data. Here the items, their agency mapping and their lot sizes live on the Work, which is where the mock's own "Open Inspection" button already links from.       |
| 7e  | Stat cards labelled from the mock's seed vocabulary                               | Relabelled: "Request issued", "Awaiting inspection", "Items blocked from despatch" | The third counts a fact the mock has no model for — items the dispatch gate would refuse today.                                                                                                        |
| 7f  | An agency `TabsList`                                                              | The same pills as a `role="group"` of `aria-pressed` toggles                       | It filters the list in place rather than swapping panels, and `test/a11y-invariants` refuses a `role="tablist"` without the roving-tabindex pattern to match.                                          |

Two additions on the Work's Inspection clause tab belong to the same
ruling: a **"Gates despatch" column**, which the mock has no despatch to
gate and which is the point of the pack; and a **"Save as organisation
default"** action beside "Save for this Work", which is how a new Work
inherits a checklist instead of starting with an empty one.

### 10. Tender screens

**Status: APPROVED — owner decision, 2026-08-18.** Same footing as § 9 above,
and the same convergence path: change the mock in v0 and each entry retires.

The screens themselves are ported (`app/tenders/page.tsx`,
`app/tenders/new`, `app/tenders/[id]` at `fdfe5ef`). What is listed here is
behaviour inside them that the mock implements as a `useState` fiction. The
test applied throughout: would replicating the pixel make the product claim
something untrue? A disabled control that says why is a port; a control that
appears to file a document with a government portal and does not is not.

| #   | The mock draws                                                   | The application ships                                                      | Why                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10a | A "Railway documents" tab in the tender workspace's section rail | Three sections, not four; the tab is absent                                | It is a per-tender file store. The product has the Work's documents and the company document library, and a third place to keep files is a third place to look for one. Nothing behind the mock's tab stores anything.                     |
| 10b | Checklist source modes: Generate / Reusable / Upload             | A line attaches a company document library credential, or stays unanswered | Generate has nothing to generate — no declaration or undertaking template exists — and Upload is the per-tender store of 10a. Reusable is the mode with a server behind it, and it is the one the pack is for.                             |
| 10c | A "Run upload simulation" button on the iREPS panel              | A recorded iREPS step, and copy saying the portal cannot be driven         | iREPS has no interface a program may use: it is worked by a human with a CAPTCHA, an OTP and a local DSC. A button that appears to submit a bid has told an operator something false about a legal deadline. This is the entry with teeth. |

All three are built from the mock's own components — its cards, its rows,
its status badge, its readiness panel — so the grammar is unchanged even
where the behaviour is.

### 11. Production screens — APPROVED

**Status: APPROVED, owner ruling of 2026-08-18** (all eight rows, reviewed
section by section). Same convergence path as § 9 and § 10: change the
mock in v0 and each entry retires. One ruling came with work attached:
11a was argued from a stock ledger that did not exist, and the same
ruling that approved it commissioned the follow-up now that 0087 exists —
wire Available and Shortage into the production register's Material
column and the job card's Materials tab from the real ledger. The 11a row
below stands until that lands, then retires.

The screens themselves are ported (`app/production/page.tsx`,
`app/production/items/page.tsx`, `components/production-job-card-page.tsx`
at `fdfe5ef`). What is listed here is behaviour inside them the mock
implements as a `useState` fiction over `lib/data.ts`, plus one whole
column family that depends on a table this wave has not built yet.

The test applied throughout is the same one § 10 states: would
replicating the pixel make the product claim something untrue?

| #   | The mock draws                                                                                        | The application ships                                                                                                | Why                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11a | A Material column badging "2277 units short", and a Materials tab with Available and Shortage columns | A Material column counting the bill of material, and a Materials tab with Required only, captioned as such           | Shortage is required minus on-hand, and on-hand is the Inventory pack's stock ledger, which does not exist yet. Computed against no stock it reads zero for everything — "nothing is short" — and would flip to alarming the day stock arrived. The requirement half is real and is shipped.              |
| 11b | Six job-card statuses, three of them derived (`material-short`, `material-ready`, `dispatch-ready`)   | Four stored states — planned, in production, completed, cancelled — with readiness derived on read                   | The mock's own fixture disagrees with itself: two of its three plans carry a `status` its `planMaterial` contradicts, so its "Ready" branch is dead and every card renders "Material blocked". A stored copy of a computed fact is a field that can disagree with the fact.                               |
| 11c | Component serials as a bag of strings per PLAN, keyed by bill-of-material node                        | Component serials captured per FINISHED UNIT, with the unit chosen on the Serials tab                                | The mock can say a batch of twelve boards consumed twelve power supplies and cannot say which board holds which. That is the question a field failure asks — this board is dead, whose supply is in it, what else has one from that batch — and it is the whole point of traceability.                    |
| 11d | A "Create delivery challan" button on the Dispatch tab                                                | A "Release to stock" action, and copy saying the Delivery Challan is raised separately                               | A Delivery Challan is a statutory document with a consignee, a number series, an e-way bill and an inspection interlock behind it. A button on the factory floor that appeared to issue one would claim an act it does not perform. Production releases units; the challan is a later act against a Work. |
| 11e | "Complete one unit" and "Generate next serial" as two independent controls                            | One act: recording a unit mints its serial from the item's counter                                                   | In the mock the counter and the serial list can disagree, and its own `canComplete` has to compare them. A unit that exists and is unnameable is not a unit this product can trace, deliver or install.                                                                                                   |
| 11f | `BomNode.type` ('raw' / 'sub-assembly'), `unit` and `serialControlled` stored per NODE                | All three derived or moved to the item: type from whether the node has a bill, unit and serial control from the part | The same bolt would otherwise be Nos in one assembly and Kg in another, and serialised in one place and not in another. They are facts about the PART, and `type` is precisely "has children or does not".                                                                                                |
| 11g | A `nextSerial` figure printed in the item's serial-series well                                        | The series SHAPE (`IPDB6-00000`) and the words "Claimed per unit, gap-free"                                          | The next number is claimed from a counter at the moment a unit is built. Any figure rendered here is stale the instant a second operator builds one, and a wrong next-serial on a screen an operator plans labels from is worse than no figure.                                                           |
| 11h | A status-free register, with state encoded in the Material badge                                      | The product's status chip, plus the Material badge                                                                   | `docs/DESIGN.md` § Status badge semantics makes the dot-plus-label chip the single vocabulary for record state, and the mock's own fixture shows why one badge cannot carry both readings at once.                                                                                                        |

Two more the review of this pack settled, recorded so the reasoning is
not re-litigated:

- **The Material column counts parts, and the Materials tab is captioned
  as a requirement rather than a shortage.** Both say what they are
  instead of showing an empty Available column that reads as "nothing is
  short".
- **The serial trace gains an Origin column** (§ Approved divergences 7's
  table, extended): a production unit and a delivered one are different
  kinds of answer, and a unit still on the factory floor has no Work,
  no challan and no receipt to show. The row says "Private order" or
  "in the factory" rather than linking nowhere.

Two additions of the application's own, on the same ruling:

- **A withdraw control on a release.** A despatch raised in error would
  otherwise lock its units out of production for good. It is deliberately
  self-closing: the moment Inventory's stock ledger references a
  despatch, the foreign key refuses the delete (migration 0084 § 7).
- **A remove control on a captured component serial**, live only while
  the unit is still in the factory. A scanner typo on a unit on the bench
  is a data-entry error; after despatch the record is the only account of
  what is inside a unit somewhere else, and nothing removes it.

**The Production rail entry is not a divergence.** It is the first item
of the mock's own Operations group (`docs/UX.md` § Settled information
architecture), and it left the omitted list this wave. Inventory,
Purchase orders and Maintenance stay omitted rather than drawn as dead
entries.

### 12. Correspondence screens — APPROVED

**Status: APPROVED, owner ruling of 2026-08-18** (all eleven rows,
reviewed section by section). Same convergence path as § 9–§ 11: change
the mock in v0 and each entry retires.

The three screens are ported (`app/correspondence/page.tsx`,
`app/correspondence/new`, `app/correspondence/new/inward` at `fdfe5ef`).
What is listed here is behaviour inside them that the mock implements as
module-scope seed data or `useState`, plus the two places the real product
has modules the mock's single `correspondence` array does not.

| #   | The mock draws                                                                | The application ships                                                                          | Why                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12a | Extension requests and inspection letters as rows of the correspondence array | Two tabs that READ `extension_requests` (0011) and `inspection_calls` (0082) and write neither | Both letters already have registers that number them, render them and hold the replies. A second home for one letter is two records that can disagree about its number, its date and its state. The tabs link back to the module that owns each. Each record is up to TWO rows — the letter out and the answer back — which one flat seed array cannot model. |
| 12b | A read-only "Letter number" field showing the next number before it is filed  | The same field, stating the series (`OUT / financial year / serial`)                           | The number is allocated inside the writing transaction and a letter filed a second later takes a different one. A number shown before the counter has handed it out is a promise nothing made — and on a legal identifier that is the worst kind of placeholder.                                                                                              |
| 12c | A "Letter type" toggle: Outward / Inward / Extension request                  | No toggle; the composer writes outward letters only                                            | An inward letter is registered on the upload screen beside this one, because the register refuses an inward row with no scan. An extension request is raised on the Work, which is where its completion dates and its own series live. A toggle leading elsewhere lies.                                                                                       |
| 12d | "Save draft" on the inward screen, and a `draft` status in the register       | No draft state at all                                                                          | The contract draws no correspondence detail screen, so a saved draft has nowhere to be reopened. A row nobody can finish is worse than a form somebody has to complete. (`draft` survives in the vocabulary: an unfinalised extension request still renders it.)                                                                                              |
| 12e | An inert mono letter number in the register's first column                    | The number is a control that opens the letter                                                  | The mock's rows have no files behind them. Here an outward letter renders on demand and an inward one is the stored scan, and a register with no way to reach either is a register nobody can work from. Rows the register only projects stay inert, for the same reason.                                                                                     |
| 12f | A dropzone accepting PDF, JPG or PNG up to 20 MB                              | PDF, up to 25 MB                                                                               | Every stored document in this product is a PDF through one hardened path — magic bytes, malware scan, tenant-prefixed key. A second media model for one screen buys nothing an operator's scanner cannot already produce.                                                                                                                                     |
| 12g | Two hard-coded rows on the Inspection letters tab                             | The mock's own two-row card markup, mapped over every call the member may see                  | The mock's pair is seed data. The anatomy is unchanged — the primary clipboard icon for our request, the muted upload icon for the agency's letter, the same detail line — it simply repeats per call.                                                                                                                                                        |
| 12h | A `correspondence` scope in Global search                                     | Still omitted                                                                                  | Every search scope answers with a row that OPENS something, and a letter has no record page to open. A correspondence hit could only land on the unfiltered register, which the rail already does in one click. When the mock grows a letter detail screen, the scope earns its place.                                                                        |
| 12i | No cancel anywhere on the register                                            | A `Cancel…` action per letter row, for members holding the cancel authority                    | The table takes no DELETE, so a misrecorded letter is otherwise permanent. It opens the product's one confirmation shape with a required reason, and the retained number needs that reason beside it to explain what it now stands for. Projected rows carry no control: they cancel in the module that owns them.                                            |
| 12j | No Reply-due column                                                           | One on the Inward tab, the way Extension until sits on the Extensions tab                      | The mock's inward form captures a reply-due date and the banner above the tabs promises due-date tracking. A date the register stores and never shows is a promise it does not keep, and the conditional-column mechanism is the mock's own.                                                                                                                  |
| 12k | Fifteen literal rows and no paging control                                    | `Load more letters`, fifty rows a page                                                         | The mock's register is seed data. A real one is a financial year of correspondence, and the alternative to a page is a request that serialises the whole register on every tab change.                                                                                                                                                                        |

The mock's own copy is otherwise unchanged: the tab labels, the column
headings, the banner sentence and the two header actions are its own. The
only textual change is the banner's plural, which `AGENTS.md` § Design
contract 2 allows to land application-first — the mock's literal reads "1
extension request awaiting response" whatever the number is.

### 13. Inventory screens — APPROVED

**Status: APPROVED, owner ruling of 2026-08-18** (all eight rows, reviewed
section by section). Same convergence path as its siblings: change the
mock in v0 and each entry retires.

The two screens are ported (`app/inventory/page.tsx`,
`app/inventory/purchase-orders/page.tsx` at `fdfe5ef`) inside the mock's own
grammar: its stat strip, its item table, its movement table, its checkbox
rows, its supplier-order cards. What is listed here is data the mock DRAWS
that its own code cannot mean — in three of the eight cases its running
fixture contradicts itself — so replicating the pixel would have made the
product state a number that is not true.

| #   | The mock draws                                                   | The application ships                                                                 | Why                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13a | "On hand" and "Reserved" stat tiles summing a quantity           | Counts of PARTS: tracked, at reorder level, and short                                 | The sums add cabinets in Nos to cable in Mtr to solder in Kg and print one number. A count of parts is the same question asked in a unit that exists.                                                                                                                               |
| 13b | A `reserved` column stored on the item                           | A `Committed` column, derived from every open job card's outstanding bill of material | Nothing in the mock ever writes `reserved`, and its fixture values disagree with its own explosion — 720 driver ICs reserved against a plan needing 2 304. A stored reservation with no writer is a fake; the derived one has the job cards as its writer and cannot drift.         |
| 13c | A warehouse on the item and on every movement                    | No location dimension at all                                                          | Nothing the mock computes is per location — one pooled balance, no transfer — and its own data layer reads a `location` field its `StockItem` type does not have, so every warehouse in the running mock is `undefined`. A label that cannot move a balance can only ever be wrong. |
| 13d | A "Batch controlled" checkbox on the item dialog                 | Absent                                                                                | There is no batch anywhere else in the mock or in the product. A flag with no feature behind it is a promise the screen cannot keep.                                                                                                                                                |
| 13e | A "New item" dialog creating a stock item                        | No create here; the reorder level is the one stock fact this screen edits             | The item master is Production's (`production_items`, 0084) and its own screens own it. Two create forms pointed at one table is how two catalogues start.                                                                                                                           |
| 13f | A shortage row per (plan, part), with a checkbox on each         | One row per PART, with the job cards asking for it named on the row                   | Ticking the two rows for one cabinet from two plans orders it twice, because neither row knows about the other — and there is no honest per-card answer to "how much of the shelf is mine". The requirement is summed and netted once against one balance.                          |
| 13g | A separate `SupplierPO` with its own numbering and four statuses | The purchase order of migration 0033, drafted from the shortage                       | A second purchase-order concept would duplicate the vendor, the lines, the gapless per-Work number, the issue snapshot and the receipt balance, and split "what have we ordered from this vendor" across two registers.                                                             |
| 13h | A `destructive` "Low stock" badge                                | The shared status chip in the WARNING family                                          | `docs/DESIGN.md` § Status badge semantics keeps destructive for cancelled, rejected and declined. A part that needs reordering is a thing to do, not a thing that failed. Its two siblings, `available` and `retired`, stay unmapped and read neutral.                              |

One thing the application draws that the mock does not: a
**"Despatched, not yet on the shelf"** list, in the mock's own bordered-row
grammar. The mock has no production despatch to receive, and a released
despatch nobody takes in leaves the register quietly understating the shelf.
The quantity is the despatch's own unit count and there is no field for it.

### 14. Maintenance screens — PROPOSED

**Status: PROPOSED, owner ruling pending** (nineteen rows; the two notes
below the table are ANSWERED by the owner rulings of 2026-08-18). Same
convergence path as § 9–§ 13: change the mock in v0 and each entry
retires.

The three screens are ported (`app/maintenance/page.tsx`,
`app/maintenance/new`, `app/maintenance/[id]` at `fdfd610`) inside the
mock's own grammar: its eyebrowed header and single primary action, its
four-across stage strip, its metric cards over progress bars, its boxed
four-tab rail, its two-card details-then-materials form, and its closure
gate. What is listed here is data the mock DRAWS that its own code cannot
mean — in five of the nineteen cases `app/actions/maintenance.ts`
contradicts itself — plus the four places the real product has modules
the mock's flat arrays do not.

**Read row 14a first.** Four of the mock's six per-line quantities have no
writer, and every other quantity row below follows from fixing that one.

| #   | The mock draws                                                                      | The application ships                                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14a | Seven stored quantities per material line                                           | Three stored — asked, owed back, written off — and four DERIVED: available, reserved, dispatched, received back                   | Only `quantity` and `expectedReturnQuantity` are facts anybody states. The other four have writers that cannot keep them true: `availableQuantity` is `max(quantity, 2)` in the fixture; `reservedQuantity` is written once at approval and never reduced, so a fully dispatched line still reads as holding stock; `dispatchedQuantity` and `receivedReturnQuantity` are mutated alongside the challans and receipts that are their own evidence, which is two writers for one number. Derived, each IS the evidence. |
| 14b | An "Available" column computed from the fixture                                     | The real shelf, `app_private.stock_on_hand` (0087), read when the screen asks — and blank for a line that names no catalogue part | The stock ledger exists now. A line with no part has nothing on a shelf to read, and an em dash says so rather than printing a zero that would read as "out of stock".                                                                                                                                                                                                                                                                                                                                                 |
| 14c | Approval sets `reservedQuantity = min(quantity, available)`                         | Approval reserves nothing; reserved IS the line's outstanding approved quantity                                                   | Migration 0087 refused a stored `reserved` on the item for the same reason and in almost the same words (§ 13b). This is that rule one table further out.                                                                                                                                                                                                                                                                                                                                                              |
| 14d | A `cancelledQuantity` column that no action ever writes                             | A per-line write-off, with a reason, on the Materials tab                                                                         | The mock's own closure gate reads `dispatched + cancelled >= quantity`, so a request whose stock never arrives can never be closed and never leaves the list. The column needed a writer or the gate needed deleting; the writer is the smaller lie.                                                                                                                                                                                                                                                                   |
| 14e | Dispatch moves nothing but a counter                                                | A dispatch line naming a catalogue part posts a real `issue` movement against the stock ledger, naming this challan               | Material leaving the store IS a stock issue, and 0087 is the only place this product records one. Without it the Inventory register would overstate the shelf by everything maintenance has ever sent out.                                                                                                                                                                                                                                                                                                             |
| 14f | The defective return is a quantity going back                                       | The return posts NO stock movement                                                                                                | A broken unit on a repair bench is not available material; adding it to the balance would let somebody dispatch it again. The mock's own words are "receive defective items … repair disposition".                                                                                                                                                                                                                                                                                                                     |
| 14g | `status: 'high'` on the seed request, and `routine / urgent / critical` on the form | The form's three, and only those                                                                                                  | The mock's own fixture uses a fourth word its own form cannot produce. Two vocabularies for one field is one of them being wrong.                                                                                                                                                                                                                                                                                                                                                                                      |
| 14h | A challan number `PL-281/MNT/DC/1234` from `Date.now()`                             | `PL-281/MNT/001`, from a gap-free per-Work counter                                                                                | `DC` is the delivery challan's token in this product and a maintenance issue borrowing it would read as one in every register that shows both. The serial comes from a counter claimed by upsert, so a rolled-back dispatch rolls its number back.                                                                                                                                                                                                                                                                     |
| 14i | Bordered link cards with a numbered tile and a per-row progress bar                 | A dense sticky-header table                                                                                                       | The mock's `Progress` value is a literal per status — 15, 38, 66, 100 — and measures nothing; the stage chip already says which of four stages a request is in. Every other register here is a table, and an operator scanning twenty requests reads columns.                                                                                                                                                                                                                                                          |
| 14j | A `secondary` badge for the stage and a `destructive` one for critical priority     | The shared status chip for the stage; priority as plain capitalised text                                                          | `docs/DESIGN.md` § Status badge semantics reserves the dot-plus-label vocabulary for record state, and keeps destructive for cancelled/rejected/declined. A critical fault is urgent, not failed.                                                                                                                                                                                                                                                                                                                      |
| 14k | Two hard-coded Works in the form's picker                                           | The Works the caller may see                                                                                                      | Work-scope: a user without `all_works_access` gets only the Works assigned to them, here as everywhere.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 14l | A free-text item code beside a free-text description                                | A catalogue-part picker, with custom material still allowed                                                                       | A code that resolves to nothing cannot move stock or read a balance. Picking the part is what makes 14b and 14e true; a line with no part is the mock's custom item and still works.                                                                                                                                                                                                                                                                                                                                   |
| 14m | `ClipboardCheck` as the rail icon                                                   | `Hammer`                                                                                                                          | `ClipboardCheck` is already Inspection's lamp on this rail. Two identical icons in one nav group is worse than one substituted.                                                                                                                                                                                                                                                                                                                                                                                        |
| 14n | An approval with no refusal, and a dispatch with no cancellation                    | The same — neither is built                                                                                                       | Stated rather than half-built. A request that should not be fulfilled exits by writing every line off with a reason and closing, which is the evidence a rejection would carry. Cancelling a dispatch means reversing its stock movements, which the ledger deliberately makes somebody justify; it needs its own pack.                                                                                                                                                                                                |
| 14o | An "Approve request" button in the header, sending a hard-coded comment             | An approval CARD with the comment as an editable field                                                                            | The comment is written once and frozen on the record forever — it is the only account of why the store committed its material. A button that files a constant reads as an approval nobody made. The card is the mock’s own `Card` + `Field` + `Actions`, in the place its header button stood.                                                                                                                                                                                                                         |
| 14p | `operationalImpact` collected on the form and rendered nowhere                      | A card under the job card’s header                                                                                                | The mock’s form asks for "services affected, fallback arrangements, passenger impact" and its job card never shows the answer, so whoever approves the request cannot read why it is urgent. Rendered in the mock’s own single-sentence card, the shape `views/ProductionJobCard.tsx` uses for a cancellation reason.                                                                                                                                                                                                  |
| 14q | `deliveryInstructions` collected on the form and rendered nowhere                   | A line above the dispatch form                                                                                                    | The same fault as 14p, and worse placed: access windows and handover points are read by the person filling in the dispatch, so the line sits on that tab rather than in the header.                                                                                                                                                                                                                                                                                                                                    |
| 14r | No back control on the job card                                                     | A back button over the request number                                                                                             | The mock is a Next route with browser history behind it; this shell is one hash-routed workspace. Its sibling record screens (`views/ProductionJobCard.tsx`, `views/TenderWorkspace.tsx`) all carry the same control in the same place.                                                                                                                                                                                                                                                                                |
| 14s | The request form’s own hand-rolled heading block                                    | The shared `PageHeader`, with an eyebrow the mock’s form does not have                                                            | Every register in this build opens with one primitive, and the eyebrow ("Operations control") is what the mock’s own register page puts above this module’s name. A second heading implementation is how the two drift.                                                                                                                                                                                                                                                                                                |

Two things the application does that the mock has no place for, both
following from the same fact — that this build has a real Work register
behind the requests:

- **The dispatch is NOT an issue challan**, though it very nearly is.
  `issue_challans` (0014) is already "material issued out to site" with a
  gap-free per-Work number and a cancellation that retains it. Reusing it
  was the first design and was dropped because `issue_challans_one_draft_per_work`
  holds one draft per Work and 0031's insert guard admits a row only as a
  draft: a maintenance dispatch would be refused for any Work that already
  has an issue challan open on somebody else's screen. Relaxing that index
  is a uniqueness-and-numbering change to an issued-document surface and
  belongs in its own pack. **Owner question: should the two registers
  merge later?** Nothing here forecloses it.
- **The Inventory register's `Committed` column does not yet include
  approved maintenance reservations.** `app_private.stock_outstanding_requirement`
  (0087) explodes open job cards only, so a part reserved by an approved
  maintenance request still reads as available on the stock register. The
  dispatch itself is safe — the ledger refuses a balance below zero — so
  this is a display that is optimistic, not a number that can go wrong.
  The fix is one `UNION ALL` inside that function; it is left out here
  because it changes another module's screen. **Owner question: fold it
  in?**

## Settled information architecture

Owner decisions of 2026-08-16 and 2026-08-17, matched against the frozen mock.

### Shell

A collapsible icon sidebar plus a sticky topbar (`components/app-shell.tsx`,
`app-sidebar.tsx`, `app-topbar.tsx`). Content is centred at `max-w-[1440px]`.
Sidebar groups, in the mock's order:

| Group          | Modules                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| _(ungrouped)_  | Dashboard · Works · Tenders · Inspection · Payments                                    |
| Documents      | Challans · Invoices · E-Way Bills · Quotations · Correspondence                        |
| Operations     | Production · Inventory · Purchase orders · Installations · Maintenance · Global search |
| Administration | Employees · Approvals · Masters · Members · Settings                                   |

The sidebar footer carries the primary **Upload LOA** action and the signed-in
identity. Approvals carries a count badge. This retires the previous
Home/Works/Documents/Operations/Administration five-item rail.

### Challans, installations and issue challans reach top level

They were Work-workspace-only. They are now reachable without first choosing a
Work, because the operator's question crosses Works: what moved this week, what
is still an open draft, what went in and where.

The mock expresses this as one **Challans** module under Documents with two tabs
— delivery and issue — addressed by `?type=delivery` / `?type=installation`
(`components/challans-workspace.tsx`), with `/delivery-challans` and
`/issue-challans` redirecting into it. **Installations** is its own module under
Operations.

Every one of these registers takes a `?work=` deep link. When present it renders
as a dismissible filter chip naming the Work, whose clear control returns to the
unfiltered register (`components/document-register.tsx`). Recording still happens
where the Work caps or measures the record; the register reads across. A document
with no Work at all — a standalone delivery challan, a direct invoice — is created
on the register, because there is nowhere else to create it, and takes
organisation-wide reach.

### Timeline joins the Work workspace navigation

The Work workspace sections, in the mock's order
(`components/work-section-nav.tsx`, addressed by `?section=`, defaulting to
`timeline`):

Timeline · Quantity ledger · Variation · Measurement books · Bills · Instruments ·
Amendments · Documents · Inspection clause · Specifications · Settings ·
Contract details

Underline tabs on a horizontally scrollable rail, not a segmented control. A
`?section=` value this build does not know keeps the Work and opens Timeline —
the Work id is the durable half of that address.

### Bills is a Work section, not top-level nav

**Owner call 2026-08-17**, overriding the 2026-08-16 decision that put Bills in
the top-level rail. A bill is raised from a finalised measurement book on the
Work that holds it, and reading bills across Works is the Payments module's
question, not a register's.

The mock enforces it: `app/bills/page.tsx` is a redirect to
`/works/<code>?section=bills`, and the Bills register's clear-filter control
returns to the Work section rather than to an unfiltered bills list. Do not
reintroduce a top-level Bills entry.

### `#/serials` merges into Global Search

The standalone serial-lookup destination is retired. Serial numbers are one scope
among the Global Search scopes (`lib/search.ts`: everything, works and items,
challans, purchase orders, invoices, quotations, correspondence, installations
and serials, contacts).

**A serial hit must still open the full traceability chain** — receipt, custody,
issue, installation, the documents at each step. Merging the entry point does not
merge the answer. The mock keeps that chain in `components/serial-trace-panel.tsx`,
reachable from the search results and from the mobile Record sheet.

### Masters loses the bank-accounts tab

Masters tabs, per `app/masters/page.tsx`: items, contacts, locations, units,
signatories, GST. No bank accounts.

Bank fields move inline onto the records that own them — a contact's bank details
sit on the contact, an employee's on the employee. The organisation's _own_
accounts are company identity, not master data, and live under Settings →
Company (`components/company-bank-accounts.tsx`). A shared bank-accounts table
made every account look interchangeable when a payee account and the
organisation's collection account are different facts with different permissions.

### Document-lifecycle locking extends beyond its mock home

The mock's outward-document lifecycle machine
(`components/outward-document-lifecycle.tsx`) runs
`draft → pending → finalized`, with `amendment-pending → amendment-open` for a
sanctioned edit to an already-issued document, a finalize-and-issue action, an
explicit lock signal to the editor it wraps, and an approval route through the
signature inbox.

The application applies that same machine and the same visual states to
**delivery and issue challans, tax invoices, and measurement books**. Draft
editing and legal issue stay visually and semantically separate; an issued
document is read-only until an amendment is approved; a cancelled number is
retained forever and never reused.

### The company document library sits under Documents

Owner decision, 2026-08-18. Permanent — not a placeholder pending a Tenders
module.

The mock has the screen
(`app/tenders/company-documents/page.tsx`,
`components/company-document-library.tsx`) but no rail entry for it: it is
reached from a toolbar button on the Tenders dashboard. Tenders is one of the
modules `shell/navigation.ts` omits for having no route in this build, so
replicating that placement exactly would leave a screen the mock covers with
no way into it.

It therefore carries a rail entry of its own, in the **Documents** group after
Quotations, with the Lucide `FileBadge` icon — Documents being where the mock's
own rail groups document registers. If a Tenders module lands later the library
stays where it is; a bid checklist links into it rather than absorbing it,
because the library is organisation-level and tendering is one of four
consumers.

### ⌘K command palette: planned, Phase 4

The mock ships a command palette bound to ⌘K/Ctrl+K from the topbar search
control (`components/app-topbar.tsx`, `components/ui/command.tsx`). The
application ports the topbar control's appearance — including the `⌘K` hint chip
— from day one, and implements the palette itself in Phase 4. Until then the
control opens Global Search. Do not ship the chip without a working shortcut:
either the shortcut works or the chip is not rendered.

## Experience principles

Carried forward. They constrain how the mock's grammar is applied to behaviour
the mock does not draw.

1. **The Work is the centre of gravity.** Most contract execution begins from a
   Work workspace. Top-level registers answer cross-Work questions; they do not
   replace the Work as the place records are made.
2. **Show what is true before showing forms.** Creation and correction controls
   open deliberately through named actions.
3. **Progressive disclosure.** Summary, exception and next-action information
   appears before detailed registers.
4. **Legal states are explicit.** Draft, locally issued, externally registered,
   cancelled, corrected and replaced are never collapsed into one ambiguous
   status.
5. **Failure is not an empty state.** Loading, no data, permission denial and
   service failure are represented separately.
6. **Actions explain their consequence.** A blocked or destructive action states
   what prevents it and which workflow resolves the block.
7. **Mobile is task-oriented.** Site staff get focused capture flows, not a
   compressed office dashboard.
8. **Accessibility is part of the workflow.** Every action is keyboard reachable,
   headings and regions are ordered, focus follows navigation, and status is
   never conveyed by colour alone — which is why the mock's status badge carries
   a label beside its dot.
9. **The server remains authoritative.** Browser calculations are explanatory
   only; money, quantities, numbering, permissions and lifecycle transitions
   remain server and database concerns.

## Organisation entry

```text
Sign in
  └─ 0 active organisations → onboarding / create first organisation
  └─ 1 active organisation  → enter automatically
  └─ 2+ active organisations → choose tenant
```

Only active memberships appear. A refresh may reopen the current active
organisation during the same browser session; a fresh sign-in with two or more
memberships requires deliberate tenant choice. The switch action appears only
when another active organisation exists. Creating another organisation is an
account-level action under Settings; one organisation remains one legal entity
and tenant.

The mock draws this as one centred card that steps credentials → two-factor →
organisation chooser. The application uses that card and that layout for the
whole family of auth screens (§ Approved divergences 4).

## Contract-source intake

The LOA is required. NIT, Contract Agreement and tender/specification PDFs are
optional.

```text
Upload LOA
  → extract proposal
  → optionally attach contract-source documents
  → reject any source whose tender number or name of work does not match
  → review header, schedules and items
  → review extracted tender clauses and item mappings
  → manually confirm/edit the payment matrix
  → warn and preserve evidence when manual values differ from tender extraction
  → atomically confirm Work, source links and authoritative matrix
  → open the new Work with its payment setup offered once
```

The payment setup is a dialog, not a screen: stage percentages per category
beside a category per item, with one Save and a Later that writes nothing. Items
the reviewer left uncategorised arrive with a category proposed from their
description, marked as a proposal until saved; Save commits the proposals still
standing and says how many. It is offered by the navigation that follows
confirmation and never again — a revisit or a refresh opens the Work plainly —
and both editors stay permanently on the Work's Quantity ledger section.

The unanswered question outlives the dialog, quietly. While any item on a Work
would bill through a category with no matrix row, the Work's Timeline carries one
muted line saying so and one inline control that opens the same dialog. It is
derived from the Work's data rather than from the visit, so it appears on a Work
configured badly months ago and disappears the moment the gap closes. Save
refuses to leave that state in the first place, naming the categories inline.

Extracted payment terms, warranty and maintenance periods, PBG and
security-deposit release clauses, and item specifications are proposal evidence.
They never bypass human review.

## Document creation

Major legal documents use a guided pattern, rendered through the mock's card and
field anatomy:

1. **Context** — Work, party, date and movement/document purpose;
2. **Lines or sources** — eligible items, quantities, PO/source links, remaining
   balance;
3. **Evidence and logistics** — transport, serial, attachment or certificate
   facts where applicable;
4. **Review** — human-readable document preview, warnings, authority
   requirements;
5. **Issue/finalise** — the server revalidates, allocates the number and freezes
   the immutable snapshot.

The lifecycle strip above the editor is the mock's
`OutwardDocumentLifecycle`; the editor below it locks when the strip says locked.

## Measurement and financial narrative

```text
site evidence
  → formal Measurement Book
  → finalisation
      ├→ contractual bill/payment claim
      └→ GST tax invoice
           → IRP registration where applicable
  → payment receipt/reconciliation
```

The branch is the point. Finalising a Measurement Book raises the contractual
bill from that book's lines in the same transaction
(`routes/measurement-books/finalize.ts`), and the GST tax invoice is raised from
the **finalised Measurement Book** as well — a draft invoice is created against a
`measurementBookId` (`routes/tax-invoices/drafting.ts`), never against a bill id.
The bill is not an input to the invoice.

They are siblings from one parent because they answer to different authorities:
the bill is the contractual claim the Railways department measures and pays
against; the tax invoice is the GST document the statutory regime requires. One
finalised measurement is the single source of truth under both, which is what
keeps them from disagreeing. An invoice may also be raised directly, with no Work
and no Measurement Book behind it, for service billing outside a measured
contract.

Cancellation releases the Measurement Book so a corrected document can be raised
against the same measurement; after the IRP's 24-hour cancellation window a
Section 34 credit note is the lawful instrument instead.

The older site `mb_entries` surface is labelled **Measurement evidence** rather
than presented as the formal Measurement Book itself. External statutory
registration status is shown separately from local invoice status: a locally
issued invoice is never represented as IRP-registered without verified provider
evidence.

## Business-rule note: installation above sanctioned quantity

The rule changed with the redesign. **Installation quantity may now exceed the
LOA sanctioned quantity.** The excess does not block the recording; it raises a
_pending variation_ against the Work, surfaced on the Work's **Variation**
section as an unbillable exposure with the installed-versus-sanctioned figures
and the money at risk. **Measurement and billing still cap at the sanctioned
quantity** until the variation is approved and its sanction locked.

The mock draws the surface: the "Pending variation" card in
`components/work-variations.tsx`, above the variation ledger, whose copy is
"Installation recorded above sanctioned quantity. Excess remains unbillable until
approval."

Implementation lands in a parallel pull request on branch
`rules/installation-variation`, which owns `docs/PRODUCT.md` and
`docs/PRODUCT-SPEC.md` for this rule. This document records that the rule exists
because it changes what the Variation section is for; it deliberately does not
document the server semantics, the migration or the approval path.

## Shared states

Every register and detail page provides distinct patterns for:

- initial loading;
- loaded with records;
- legitimate empty state;
- filtered zero results;
- permission-limited/read-only state;
- transient network or service failure with retry;
- deleted/archived/cancelled historical record;
- blocked action with corrective workflow;
- unsaved draft with navigation warning where data loss is possible.

Three of these are shared components rather than a convention each screen
re-implements. `apps/web/src/ui/state.tsx` carries the wait (`LoadingState`,
skeleton blocks announced as busy), the legitimate empty state (`EmptyState`, one
plain operational sentence and at most one action), and the service failure
(`ErrorState`, a persistent alert). `ErrorState` takes its retry handler as a
**required** prop — a failure with no way back is a dead end, and the type checker
is what refuses one. A screen with more than one independent read carries one
failure state per read, each naming what it retries, so a failed picker stays
distinguishable from a failed register.

These three re-skin to the mock's `Skeleton`, `Empty` and destructive-alert
anatomy (`docs/DESIGN.md` § Primitive inventory). Their contract — three states,
required retry, one per read — does not change with the paint.

The permission-limited state is deliberately NOT an `ErrorState`: a 403 does not
become a success on the second attempt, so it reads as an inline refusal rather
than offering an action that would refuse identically.

`apps/web/test/views/state-coverage*` holds these to the screen. It derives the
views with a mount load path from the source and fails if one is neither covered
by a case that renders all three states nor exempt with a stated reason.

The server side of a failure is the shared error envelope
(`packages/contracts/src/errors.ts`): `message` states the fact that was refused,
and the optional `remedy` states the action that clears it. A remedy belongs to
the error code rather than to the call site, so the reviewed text lives in one
catalogue (`apps/server/src/remedies.ts`) instead of drifting across the routes
that throw it. It renders through the mock's `RemedyError`: a destructive-tinted
`role="alert"` panel, the fact on the first line, the remedy beneath it as a link
or button carrying a forward arrow.

## Focus, keyboard and navigation

- Workspace navigation is serialised into `location.hash` (hand-rolled, no router
  library). A refresh restores the exact view including the Work workspace
  section, Back and Forward walk the view history, register rows render real
  links so middle-click works, and unknown fragments fall back to the Dashboard —
  except a Work fragment naming an unknown section, which keeps the Work and
  opens Timeline.
- Porting the mock's Next.js `Link`/`usePathname` structure means porting its
  _appearance and affordances_, not its router. Every mock `Link` becomes a real
  anchor with a hash href.
- Focus moves to the heading of the newly opened view on navigation, and returns
  to the invoking control when a dialog or sheet closes.
- Dialogs and sheets trap focus and close on `Escape`. The mobile sheets are the
  same primitive and behave the same way.
- The topbar search control is reachable in tab order before the page content.
  Its `⌘K` chip is only rendered when the shortcut is wired (§ ⌘K command
  palette).
- Blocked actions whose remedy lives on another screen (payment matrix rows,
  organisation GST profile, buyer contact facts) link directly to that screen.

## Verification gates

Carried forward from the previous contract and still binding. Re-skinning does
not lower any of these bars; it is precisely the change most likely to breach
them.

### Dual-theme axe suite — the WCAG proof

`pnpm --filter @auto-mb/web test:e2e` is the standing accessibility gate. It runs
Playwright against the real production bundle with the API mocked at the network
layer, and it scans **both themes** on every screen it covers: the fixture applies
`data-theme` the way the product does, asserts that `color-scheme` was pinned,
asserts that the two passes resolved different `--background` values (so a dark
scan that silently ran light fails rather than passing vacuously), and waits out
the theme-transition frames before sampling. Text and tint pairings, including
the 11px status badges, must hold WCAG AA 4.5:1 in both themes.

It runs at the desk width for the accessibility suite (the sidebar is hidden below
`lg`), and the responsive suite runs at 320, 768 and desk widths.

**Known trap.** The `design:contrast` and `design:states` scripts
(`scripts/design-audit.mjs`) misparse `oklab()` alpha tints on this palette, and
the mock's status styles are built almost entirely from alpha tints
(`bg-success/10`, `bg-warning/15`, `border-primary/20`). Their numbers on those
pairs are wrong. **Real-render axe measurement is authoritative.** The `design:*`
scripts also require a rendered HTML file as an argument
(`pnpm design:a11y <file.html>`); a bare invocation refuses rather than passing.

The full set, for reference: `design:contrast`, `design:states`, `design:a11y`,
`design:rtl`, `design:taste`.

### State coverage

`apps/web/test/views/state-coverage*` enumerates every view with a mount load
path and fails if one neither renders all three shared states nor carries a
stated exemption. A new screen added during the port is covered by this
automatically — it will fail until its case exists.

### Bundle budget

`pnpm bundle:check` (`apps/web/scripts/check-bundle-size.mjs`) enforces the
initial JavaScript payload: a programme budget of 220,000 bytes gzip and a
tighter ratchet beneath it that is the current measured floor. The port adds
components; the ratchet is what stops it adding them invisibly. Raising the
ratchet is a deliberate, explained change, and the script refuses a ratchet above
the budget.

### Whole-branch verification

`pnpm verify` — format check, lint, typecheck, build, bundle check, tests,
migration check, architecture check, config check, comment-reference check, dead
code, secret scan — before handoff.

### Visual evidence

`CONTRIBUTING.md` § Evidence for a visible UI change applies to every porting
pull request: paste before/after images into the thread, or state explicitly that
capture was infeasible and name the CI text assertions standing in for them.
Silence is not the fallback.

## Screen coverage map

Screens the mock covers, which must be visually indistinguishable:

Dashboard · Works register · Work workspace (twelve sections) · Tenders ·
Inspection · Payments · Challans (delivery and issue tabs) · Delivery-challan
editor · Issue-challan editor · Invoices · E-Way Bills · Quotations ·
Correspondence · Production · Inventory · Purchase orders · Installations ·
Maintenance · Global search · Employees · Approvals · Masters · Members ·
Settings · Sign in · Onboarding · Company document library · Mobile bottom bar
and sheets

Screens the application adds, built in the mock's grammar (§ Approved divergences
4):

LOA upload · LOA and contract-source review · Tender-terms review · Payment
matrix dialog · PAC certificate issuance · Completion extensions · Measurement
Book builder · Billing readiness · Bill settlement · Railway bill · Tax-invoice
IRP transport and credit notes · Organisation chooser · Two-factor enrolment and
recovery · Password recovery · Account security · Organisation access settings ·
Appearance settings

Small confirmation dialogs, validation summaries, skeletons and error panels use
shared patterns rather than becoming separate product architectures.

## Definition of UX completion

The port is complete only when:

- every screen the mock covers is visually indistinguishable from the frozen
  mock at `a8e1fde`, at desk, tablet and mobile widths, in both themes;
- every additive screen reads as part of the same system, using only the mock's
  tokens and primitives;
- the settled information architecture above is implemented, including the Bills
  demotion and the serials merge, and no retired destination survives;
- divergences match the enumerated list exactly, each traceable to this document;
- all accepted workflows retain their server-side invariants and permission
  gates;
- the component and Playwright suites are updated to traverse the new navigation;
- every view with a mount load path renders loading, empty and failure states;
- the dual-theme axe suite passes, with any token-level fix flagged to the owner;
- the bundle ratchet holds or its rise is explained;
- the branch passes `pnpm verify`, the production Compose smoke and the
  fresh-cluster restore;
- the merge candidate receives product-owner visual approval.
