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
column and the job card's Materials tab from the real ledger. **That work
has landed and 11a is retired**; what replaced it is recorded under the
table below, and the rows are numbered from 11b so nothing that cited
them has to be renumbered.

The screens themselves are ported (`app/production/page.tsx`,
`app/production/items/page.tsx`, `components/production-job-card-page.tsx`
at `fdfe5ef`). What is listed here is behaviour inside them the mock
implements as a `useState` fiction over `lib/data.ts`.

The test applied throughout is the same one § 10 states: would
replicating the pixel make the product claim something untrue?

| #   | The mock draws                                                                                      | The application ships                                                                                                | Why                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11b | Six job-card statuses, three of them derived (`material-short`, `material-ready`, `dispatch-ready`) | Four stored states — planned, in production, completed, cancelled — with readiness derived on read                   | The mock's own fixture disagrees with itself: two of its three plans carry a `status` its `planMaterial` contradicts, so its "Ready" branch is dead and every card renders "Material blocked". A stored copy of a computed fact is a field that can disagree with the fact.                               |
| 11c | Component serials as a bag of strings per PLAN, keyed by bill-of-material node                      | Component serials captured per FINISHED UNIT, with the unit chosen on the Serials tab                                | The mock can say a batch of twelve boards consumed twelve power supplies and cannot say which board holds which. That is the question a field failure asks — this board is dead, whose supply is in it, what else has one from that batch — and it is the whole point of traceability.                    |
| 11d | A "Create delivery challan" button on the Dispatch tab                                              | A "Release to stock" action, and copy saying the Delivery Challan is raised separately                               | A Delivery Challan is a statutory document with a consignee, a number series, an e-way bill and an inspection interlock behind it. A button on the factory floor that appeared to issue one would claim an act it does not perform. Production releases units; the challan is a later act against a Work. |
| 11e | "Complete one unit" and "Generate next serial" as two independent controls                          | One act: recording a unit mints its serial from the item's counter                                                   | In the mock the counter and the serial list can disagree, and its own `canComplete` has to compare them. A unit that exists and is unnameable is not a unit this product can trace, deliver or install.                                                                                                   |
| 11f | `BomNode.type` ('raw' / 'sub-assembly'), `unit` and `serialControlled` stored per NODE              | All three derived or moved to the item: type from whether the node has a bill, unit and serial control from the part | The same bolt would otherwise be Nos in one assembly and Kg in another, and serialised in one place and not in another. They are facts about the PART, and `type` is precisely "has children or does not".                                                                                                |
| 11g | A `nextSerial` figure printed in the item's serial-series well                                      | The series SHAPE (`IPDB6-00000`) and the words "Claimed per unit, gap-free"                                          | The next number is claimed from a counter at the moment a unit is built. Any figure rendered here is stale the instant a second operator builds one, and a wrong next-serial on a screen an operator plans labels from is worse than no figure.                                                           |
| 11h | A status-free register, with state encoded in the Material badge                                    | The product's status chip, plus the Material badge                                                                   | `docs/DESIGN.md` § Status badge semantics makes the dot-plus-label chip the single vocabulary for record state, and the mock's own fixture shows why one badge cannot carry both readings at once.                                                                                                        |

**What replaced 11a.** The Material column and the Materials tab say
_shortage_ now, because shortage is real: the stock ledger of migration
0087 holds the shelf, and both figures are derived on read from it and
from `app_private.stock_outstanding_requirement`. Nothing is stored. The
mock is followed with two deliberate differences, neither of them new
visual language:

- **The badge counts PARTS short, not units.** The mock's "2277 units
  short" is a sum of quantities across parts measured in Nos, Mtr and Kg,
  which is the arithmetic § 13a already refuses for the stock register's
  tiles. A count of parts is the same question asked in a unit that
  exists. The mock's grammar is otherwise kept: `N parts short`, or
  `Ready`, or `No bill of material` where the product has none.
- **The badge is in the WARNING family, not the mock's destructive.**
  `docs/DESIGN.md` § Status badge semantics keeps destructive for
  cancelled, rejected and declined. Material still to buy is a thing to
  do, exactly as § 13h settled for the register's low-stock badge.

The Materials tab gains Available and Shortage beside Required, untinted
in the numeric columns the way the stock register leaves its own negative
Available untinted.

**Required** is the card's gross bill. **Available** is this card's share
of the shelf — what is on hand, less every OTHER open job card's
outstanding claim on the same part, so two cards cannot each be promised
the same reel of cable, while the card's own claim is left in so it is
never told it cannot have what it itself reserved.

**Shortage** is what still has to be bought, and it is measured on a
different basis on purpose: not the gross bill, but the card's
_outstanding_ requirement — the bill times the units not yet serialised,
less what has already been issued to the card. Material issued to the
bench has left the shelf, so a gross requirement measured against that
shelf would report a card short of the parts lying in front of the
operator. From that, the shelf and the outstanding balance of every open
purchase order come off, both after the other cards' claim, through the
same fragment the shortage screen reads.

So `Required − Available` is deliberately not the shortage — two bases
and one term the pair does not carry — and the caption under the table
says so. Two cards competing for one part with a single order covering
one of them BOTH read short: neither may assume the order is theirs, and
the organisation-wide shortage screen stays the authority on how much to
buy. Allocating one order across competing cards is the planning pass
migration 0087 § 7 refuses to hide inside a list.

One more the review of this pack settled, recorded so the reasoning is
not re-litigated:

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

### 15. Employee and payroll screens — PROPOSED

**Status: PROPOSED, owner ruling pending.** Every other numbered entry in
this list is APPROVED; this one is the first written before its ruling,
because the pack it belongs to landed inside one wave rather than after
one. The convergence path is the same as § 9–§ 13's: change the mock in
v0 and each entry retires.

**The section number is allocated, not sequential.** § 14 belongs to the
maintenance pack of this wave and lands with it, exactly as the export
format versions are allocated by the coordinator rather than claimed on
merge. A gap here is not a defect; two sections sharing a number would
be.

The two screens are ported (`app/employees/page.tsx` and
`app/hr/payroll/page.tsx` at **`fdfd610`**, through
`components/hr/employee-workspace.tsx` and
`components/payroll-run-workspace.tsx`) inside the mock's own grammar:
its page header, its stat tiles, its dense tables, its expandable
computation row, its status badge.

There are more entries here than in any previous section, and the reason
is on the mock's own screen rather than in this build's reading of it.
The employee workspace carries a banner saying what it is — "**Functional
prototype:** sensitive HR data, photos and attendance are stored only on
this browser. Do not use real employee or banking data until secure
authentication, database and private storage are connected" — and four of
its six tabs are behind features the product does not have and this pack
was not scoped to build.

The test applied throughout is the one § 10 states: would replicating the
pixel make the product claim something untrue?

| #   | The mock draws                                                                                    | The application ships                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15a | A six-tab employee workspace: Directory, Attendance, Leave, Payroll, Payslips, ID cards           | Two screens — the Directory as the Employees register, and Payroll as a workspace of its own                                                                                                                                                                                          | The remaining four are whole features, not tabs. Each is listed below rather than swept into one row, because each is refused for its own reason and each would retire on its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 15b | Attendance clocked against a geofence, with a distance and an accuracy per punch                  | Loss-of-pay DAYS, typed per payslip on the draft run                                                                                                                                                                                                                                  | Attendance is a product: a device policy, a punch record, an exception queue, a correction trail. What a monthly payroll actually consumes is a number of unpaid days, and that is what is collected. The mock's own store keeps every punch in the browser, which is what its banner is warning about.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15c | A leave request form, a balance, and an admin approval queue                                      | Absent                                                                                                                                                                                                                                                                                | Same reason as 15b, plus one the mock's own arithmetic supplies: its loss-of-pay figure subtracts a leave BALANCE from an approved leave's length, which double-counts every leave already inside the balance. A leave ledger that fed payroll would have to be right about this, and it is a pack of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 15d | An ID-photo upload with an approval state, and printable ID cards                                 | Absent                                                                                                                                                                                                                                                                                | A photograph of an employee is the most sensitive object the product would hold, and the mock stores it as a data URI in the browser. Storing one properly means a private bucket, an access rule per viewer, and a retention answer. None of that is payroll, and half of it would be worse than not having it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 15e | A "Reset sample" button and an admin/employee role switch in the page header                      | Neither                                                                                                                                                                                                                                                                               | Both are the prototype driving itself. The role switch is the product's own membership and authority; the reset button empties a browser store this build does not have.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 15f | A new-employee dialog collecting name, email, phone, bank name, account number and IFSC           | A dialog collecting the EMPLOYMENT facts, against a contact chosen from Masters                                                                                                                                                                                                       | The name, phone, email, PAN and bank details live on the `contacts` row (0028, 0078, 0080), edited in Masters, and a second form writing those columns is how two masters start disagreeing. Not everything the mock collects is a contact field, though: department is an employment fact on the `employees` table and IS collected in the composer, and the mock's `designation` is not stored as an employee column at all — it is the contact's. It is also load-bearing: `payment_requests` pays a CONTACT, so an employee who is not one could not be paid at all.                                                                                                                                                                                                                                                                      |
| 15g | Bank account and salary shown in the directory table, for the admin view                          | The monthly gross ships — a column and a register-wide stat tile; the account, PAN, UAN and ESIC number do not, and the detail shows the account masked to its last four digits                                                                                                       | The projection rule is deliberate on both sides. The list payload carries NO PAN, UAN, ESIC number or bank account — those are on the detail, the account masked (the mock masks it too, `maskAccount`) — because a register is the payload most likely to reach a log, a cache or a screenshot. But it DOES carry the monthly gross, because a payroll register that hid the pay could not answer the question a payroll clerk opens it to ask. The real divergence is who sees it: the mock gates the salary cell behind an in-page admin/employee role toggle (`isAdmin`); the port has no such toggle — that toggle was the prototype driving itself (15e) — and shows the gross to every holder of the new `can_manage_payroll` authority instead. So the salary is visible to a narrower, authority-gated audience, not hidden per-row. |
| 15h | Four stat tiles: active employees, present today, leave queue, month payroll                      | Two — people on the payroll, and the monthly gross                                                                                                                                                                                                                                    | The middle two are 15b and 15c. The payroll figure moves to the run, where it is a computed total rather than an estimate of one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 15i | A payroll page its own sidebar cannot reach                                                       | The same page, reached from a "Monthly payroll" action on the Employees register                                                                                                                                                                                                      | `components/app-sidebar.tsx` at fdfd610 lists Employees under Administration and nothing under it. The screen exists and has no door. The Inventory pack's register-to-shortage link is the precedent, and it keeps one rail lamp for one module the mock lists once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 15j | An "Income-tax regime" card comparing the old and new regimes, one badged **Recommended**         | The regime the employee ELECTED, with the year this run estimated under it                                                                                                                                                                                                            | Telling a named person which tax regime to choose is advice. The counterfactual also depends on declarations that employee may not have made — the old regime's figure is only meaningful once a Form 12BB exists — so the product would be badging a recommendation it has no basis for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 15k | A "Statutory filings" card: Generate a PF ECR, an ESI file, a PT return and a 24Q, and Mark filed | A "What is remitted" table and a "Statutory basis" table                                                                                                                                                                                                                              | The mock's Generate produces nothing. A button that appears to have written a Government return is the § 10c entry with teeth, on a document whose deadline carries interest. What ships instead is the two things a filing actually needs: the figures, both halves, and the notification each rate came from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 15l | Six employees' worth of hard-coded rows, and a month picker over three literal months             | The register, and a month opened deliberately                                                                                                                                                                                                                                         | The mock's payroll is seed data. Opening a month here CLAIMS A NUMBER off a counter, which is not something a select should do as a side effect of being changed — so the picker chooses among runs that exist and a separate control opens a new one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 15m | `esi: null` on every row, rendered as an em dash                                                  | A covered/not-covered fact per month, and where not covered the breakdown names the true reason for the case — below the ceiling but the establishment is not covered, the establishment not covered, or the gross above the ceiling — rather than always reading "above the ceiling" | The mock's own fixture has nobody under the ESI ceiling, so its ESI column is dead. Here coverage is a real per-month answer — the gross against the ceiling, plus the rule that keeps a mid-period riser contributing to the end of the contribution period — and a dash could not say which of the two it meant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Four things the application draws that the mock does not, each because
the mock had no server to need it:

- **The employer's own contributions**, beside the employee's. A payroll
  screen that showed only what is deducted cannot tell an operator what
  the organisation owes the EPFO and the ESIC this month, which is the
  figure the remittance is actually made for.
- **A statutory-basis table** on every run: each rate and ceiling in
  force in that month, with the notification it comes from. It is also
  what the pre-production CA sign-off reads.
- **A cancel action with a required reason.** A payroll run is an issued
  document and the table takes no DELETE, so a run opened against the
  wrong month would otherwise be permanent.
- **A refusal where the surcharge starts.** An employee whose projected
  income passes ₹50,00,000 is refused by name rather than computed
  without surcharge, because an under-deduction under section 192 is the
  employer's liability with interest.

**Two decisions the owner has since ruled on (2026-08-18).**

- **Payroll gets its own authority `can_manage_payroll`, not a reuse of
  `can_manage_payments`.** Owner ruling of 2026-08-18, settled. The
  argument that carried it: this authority also reveals what every
  colleague is paid, which is a different kind of secret from a travel
  advance, so a vendor-payment manager must not hold it by default. The
  salary DISBURSEMENT still flows through the `payment_requests`
  machinery that grant was created for (0080) — only VISIBILITY and RUN
  authority are separated. The employee register and the payroll run,
  reads included, are gated on `can_manage_payroll` (0089); a
  `can_manage_payments` holder without it is refused every payroll route
  and sees no Employees door. The owner of a new organisation holds it
  implicitly, and it requires MFA.
- **The editor for other States' profession-tax schedules is deferred,
  not open.** Owner ruling of 2026-08-18: only Maharashtra's schedule is
  seeded, an organisation in another State meets a named
  `PAYROLL_SCHEDULE_MISSING` refusal rather than Maharashtra's figures,
  and whether such an editor belongs to this product or to its support
  desk is a DEFERRED decision — not an open question. The composer's
  State select stays "Maharashtra + none" for now; that is the known
  bound.

**One divergence recorded for the owner to rule on.** ESI monthly
eligibility is re-tested each month on the loss-of-pay-PRORATED gross,
not on the un-prorated full-month entitlement. The consequence, stated
plainly: an employee whose full entitlement sits just above the ₹21,000
ceiling can be pulled INTO ESI for a month in which unpaid leave drops
their prorated gross to or below the ceiling — and the mid-period
continuation rule then keeps them contributing to the end of the
contribution period. This is recorded as a divergence to be ruled on
rather than hidden.

**The Employees rail entry is not a divergence.** It is the first item of
the mock's own Administration group, and it left the omitted list this
wave. E-Way Bills, Purchase orders and Maintenance stay omitted rather
than drawn as dead entries. Its icon is `Users`, which is also Members'
two rows down — that is the mock's own choice, and a different icon here
would be pixel drift rather than a fix.

### 16. Signing queue — a screen the mock does not draw at all

**Status: application-first, owner ruling not yet taken.** Numbered 16 by
coordinator allocation; 14 and 15 belong to the two packs of this wave that
land ahead of it.

**There is no mock citation for this screen, and this entry exists so that
absence is a recorded decision rather than an omission a reviewer has to
guess at.** `AGENTS.md` § Design contract says a pull request touching a
visible surface must cite the mock screen it replicates, and that reviewers
"who cannot find the citation should treat the change as unapproved visual
invention". So: there is nothing at `punyanagari/Auto-MB-Vercel-du@fdfd610`
to cite. The mock has no signing module, no signature status, and no kiosk
— outbound signing was settled by ADR-0012 as an architectural question
months after the mock was designed, and the mock has never been asked to
express it.

That puts the screen under § Design contract 4 — "behaviour the mock cannot
express is built inside the mock's visual grammar using its existing
components, without inventing new visual language" — and § Approved
divergences 4, "screens the mock does not cover", whose list this extends.
Concretely, every element on it is one the mock already ships:

| Element                 | Taken from                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Page header             | `PageHeader`, eyebrow + title + description, as every register uses it              |
| Kiosk panel             | `Card` + `CardHeader`, the mock's `data-surface` panel                              |
| The queue               | `DataTable`, with the sr-only caption `test/a11y-invariants` requires               |
| Status                  | The shared dot-plus-label `StatusChip`, in the product's own tone families          |
| Withdrawal              | `ConfirmDialog`, destructive tone, the same anatomy the cancel flows use            |
| Empty / loading / error | `EmptyState`, `LoadingState`, `ErrorState` — the same three every register declares |

Two chip words are added to the shared vocabulary rather than styled
locally: `signed` joins the success family beside `paid` and `approved`, and
`claimed` joins the warning family beside `in-production` — work in hand.
`pending` was already mapped and keeps its reading as a queue rather than a
caution.

**One thing on this screen has no precedent anywhere in the mock, and it is
deliberate: the full SHA-256 of the bytes each signature will cover, printed
complete and monospaced on every row.** ADR-0012 § "The approval is the
authority, and it must be bound to the bytes" requires the person
authorising a signature to see the hash of what they are authorising, and
the kiosk prints the same string to its own console before the token's PIN
dialog opens. The two are meant to be compared by eye. A truncated hash — the
usual register treatment, and what a designer would reach for — compares
nothing, so it is not truncated.

**Three things the queue screen does not do**, each because the alternative
would be a second place to do something:

- **Raise a request.** That belongs on the document being signed. A picker
  here would be a second way to choose a challan.
- **Register a kiosk.** That belongs in Settings: it hands out a credential
  and is owner-only. The panel here reports whether one exists and when it
  last polled, which is the fact that explains a queue that has stopped.
- **Show the signed PDF inline.** The row links to it and it opens the way
  every other PDF in the product opens.

#### The other three surfaces this feature touches

The queue is where signing is _read_. The acts live where their documents
live, and all three are the mock's existing components with no new grammar:

| Surface                                                                         | What it is                                                                                          | Why there                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Send for signing** on the Delivery Challan, the Issue Challan and the invoice | One more `Button` in the `Actions` row those screens already have, beside Generate PDF and Open PDF | Signing is a thing you do TO a document. It appears only on an issued/submitted document that has a render, for a member holding the signing authority. The Issue Challan joined on the owner's ruling of 2026-08-19 (item 16, migration 0110): it is material leaving the agency's custody under the agency's own name, it renders a PDF already, and an operator should not have to learn a second story for the sibling document. |
| **Signing kiosk** in Settings                                                   | A `Card` with the registered kiosks, a register form, and a destructive `ConfirmDialog` for revoke  | It hands out a credential, so it is owner-only and sits with the other owner-only settings. The one-time token is shown in a bordered panel that must be dismissed, never auto-hidden.                                                                                                                                                                                                                                               |
| **Open signed PDF** on a completed queue row                                    | A `Button` that fetches and opens, exactly as the challan's own Open PDF does                       | A signed document nobody can open is a record of an act with the act missing. Same work-scope authority as the unsigned document's download — it is the same document plus a signature.                                                                                                                                                                                                                                              |

**Two chips joined the shared vocabulary** rather than being styled
locally: `signed` in the success family beside `paid` and `approved`, and
`claimed` in the warning family beside `in-production` — work in hand.
`pending` was already mapped and keeps its reading as a queue rather than a
caution.

**One divergence from the product's own habit, stated so it is not
mistaken for an oversight:** the queue prints the full 64-character
SHA-256 on every row, monospaced and wrapped, where every other register
in the product would truncate a long identifier. ADR-0012 requires the
person authorising a signature to see the hash of what they are
authorising, and the kiosk prints the same string to its console before
the PIN dialog opens. The two are meant to be compared by eye. Half a hash
compares nothing.

**When the mock grows a signing screen, the mock wins.** This entry retires
the moment there is something to cite, on the § 4 iteration pipeline: change
it in v0, merge it, diff, port the delta.

### 17. Notifications — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19.** Application-first, and
ratified as recorded except where the consent split below says otherwise.
Numbered 17 by coordinator allocation; 14, 15 and 16 belong to the packs
that landed ahead of it.

**There is no mock citation for this screen, and this entry exists so
that absence is a recorded decision rather than an omission a reviewer
has to guess at.** `app/settings/page.tsx` at
`punyanagari/Auto-MB-Vercel-du@fdfd610` has five tabs — Company,
Documents, Digital signatures, Appearance, Account & organisations — and
none of them is this. `components/app-topbar.tsx` draws a bell with a
"2 notifications" tooltip, but that is an in-app alert badge and not the
outbound messaging this pack is about; nothing in the mock models a
channel, a template, a consent or a delivery.

That puts the screen under § Design contract 4 — "behaviour the mock
cannot express is built inside the mock's visual grammar using its
existing components, without inventing new visual language" — and
§ Approved divergences 4, "screens the mock does not cover", whose list
this extends. Concretely, every element on it is one the mock already
ships:

| Element                 | Taken from                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Page header             | `PageHeader`, eyebrow + title + description, as every register uses it              |
| Section panels          | `Card` + `CardHeader`, one per section, as `app/settings/page.tsx` stacks its own   |
| Templates, consent, log | `DataTable`, with the sr-only caption `test/a11y-invariants` requires               |
| Status                  | The shared dot-plus-label `StatusChip`, in the product's own tone families          |
| Collapsed forms         | `Disclosure`, the same anatomy the Settings number-series editor uses               |
| Empty / loading / error | `EmptyState`, `LoadingState`, `ErrorState` — the same three every register declares |

**Four chip words join the shared vocabulary** rather than being styled
locally, because each means the same thing wherever it appears:
`delivered` and `read` join the success family beside `paid` and
`signed` — a message that reached the handset and one the recipient
opened are both the proceed state of a delivery; `queued` joins the
notice family beside `pending` and `sent`, because a message waiting on
a provider is a queue and not a caution; and `paused` joins the warning
family beside `in-production`, because a template Meta throttled for
quality is work to do rather than something that failed. Unmapped, all
four rendered neutral — identical to a draft, which is the one reading
they must not have.

**Three pairs are toned LOCALLY instead**, per `ui/chip.tsx`'s own rule
that a word whose meaning is screen-specific must not enter the shared
map: `enabled`/`disabled` for a channel, and `opted in`/`opted out` for a
consent. "Enabled" is not a lifecycle stage anywhere else in the product,
and an opted-out contact is a deliberate, correct state rather than a
cancellation — so it is neutral, not destructive.

**One thing on this screen has no precedent in the mock, and it is
deliberate: a channel can show two lamps at once.** A channel that the
organisation has switched on, on a deployment that has no access token or
no mail relay, draws its green `enabled` chip AND an amber `no transport`
chip beside it, with a sentence naming who to ask. The two facts belong
to two different people — Meta's onboarding is the agency's, the server's
environment is the administrator's — and they genuinely come true months
apart. A single lamp would have to lie about one of them, and a green one
over a server that cannot send is the worse lie.

**Every control the feature needs is on this screen, and the first draft
of it shipped without three of them.** That is recorded here rather than
quietly fixed, because the shape of the mistake is one this document
exists to catch: four read-only registers whose empty states instructed
an operator to record a Meta status, record a consent and send a
message — none of which the screen could do. Nothing could leave `draft`,
so WhatsApp refused everything; no consent row could be created, so both
channels refused everything. The feature was unreachable from the product
it was in while every one of its API routes worked perfectly.

The three controls are:

| Control               | Where                          | Why there                                                                                 |
| --------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| Record what Meta said | A cell on each template row    | The status belongs to one template, and a separate form would need to name which          |
| Record a consent      | A `Disclosure` in the register | Consent is per channel AND per address; a checkbox on a contact row could express neither |
| Send a message        | A `Disclosure` in the log      | It is the only send in the product today, so without it the log can never hold a row      |

The status control offers exactly the moves migration 0092's guard
admits, so anything it draws is something the server accepts, and the
reason box appears only for the three statuses Meta actually explains.
The send form has no address field, and that absence is the consent rule
made visible: the address comes from the consent record, and a caller who
could pass one could send somewhere nobody agreed to.

**What the screen still deliberately does not do:**

- **Send from a document.** Sending a _document_ belongs on the document
  being sent, and that is the next pack's outcome. The send form here is
  the operator's own — proving a channel works, and messaging a
  counterparty about something with no document behind it. When document
  delivery lands, it adds a button to the challan, not a second picker
  here.
- **Poll Meta for template status.** The status is recorded by a member
  reading the Meta console. There is no WABA to poll yet, and a screen
  that pretended to poll one would be drawing a mechanism that does not
  exist.
- **Page any of the four registers.** Each reads the first fifty rows and
  says so when there are more. A paging control on a register nobody has
  filled is furniture; the honest upgrade when an organisation reaches
  fifty templates is a cursor button, not a redesign.
- **Read inbound replies, except the one that means "stop".** The
  webhook now reads a STOP and nothing else — see the consent split
  below. Everything else in the `messages` array is still dropped,
  because this product has no inbox and a reply nobody can read is not a
  reply it should pretend to have received.

#### The consent split — APPROVED, owner ruling of 2026-08-19

**"Employees: consent auto-recorded at onboarding (mandatory by policy,
still a visible register row). External contacts: explicit opt-in
required, inbound STOP auto-revokes and audits."** Migration 0092
recorded the STOP question and deliberately left it unanswered; migration
0104 answers it, and this is what the screen now says.

**An inbound STOP revokes, and it revokes for everybody.** The ruling's
own split is between how consent is OBTAINED; the revocation is not
split, and the widening is deliberate. Meta requires an opt-out to be
honoured whoever sends it, and a product that ignored STOP from a number
because the number belonged to a member of staff would be risking the
organisation's whole WhatsApp Business account to preserve a policy the
organisation can re-record in one click. So anybody who replies STOP or
UNSUBSCRIBE — typed, or tapped on a template's own opt-out button — is
opted out, the consent row's evidence says so in the words the register
prints, and an audit event records it with a NULL actor, because no
member did it. The organisation records consent again at its own
discretion, on the register, with evidence.

The keyword list is two words and stays two words. A message is matched
whole, trimmed and case-folded, never as a substring: "please don't stop
sending these" is a reply, and substring matching on a legal act is how a
product opts somebody out for using a common English verb.

**An address nobody opted in is a no-op and a 200.** There is nothing to
revoke, and a non-200 would make Meta redeliver a message it delivered
correctly, forever. The only case that still earns a retry is the one
0092 named: a receipt for a send that has not committed yet.

**The employee half is a bulk act on the register, not a hook on the
employee form**, and the choice is recorded here because the other one
looks obvious and is wrong. `employees` (0089) carries no address at all
— the phone and the email live on `contacts` — so an employee write never
sees the moment an address is "gained"; `contacts.phone` is free text of
three to thirty characters while a WhatsApp consent address must be
E.164, so a hook would fail the address CHECK on ordinary data and take
the employee write down with it; and `POST /api/employees` carries the
PAYROLL authority, so writing a consent from there would let payroll
create the rows the notifications authority exists to protect.

So the register grows one control — "Record consent for staff", a
`Disclosure` beside the existing one, taking only a channel — which
records an opt-in for every active staff contact carrying a usable
address, names the source in the evidence, and audits each row. It
answers with three counts rather than one, because the three outcomes
need different things from the operator: recorded, already on the
register, and no usable address. Staff whose number is not in
international form are in the third count and are REPORTED rather than
skipped silently.

It never overwrites an existing consent. Somebody who replied STOP stays
opted out until a member records consent for them deliberately, on the
form above — which is the whole point of an automatic act that cannot
override a revocation.

**Where it sits.** Administration, between Members and Settings, with the
`MessageSquare` lamp — the one icon on that rail not already spoken for.
Administration rather than Documents because it configures how the
organisation speaks, in the same family as who belongs to it and how it
is set up. It is NOT a sixth tab inside Settings: the delivery log and
the consent register are registers people go looking for, and a register
behind a tab behind a settings page is a register nobody finds.

**Gated at the screen, not at a control.** Every read this view makes
needs the notifications authority — the consent register is a list of
counterparties' personal telephone numbers and the delivery log says who
was messaged — so a member without it gets a refusal panel rather than
four failed loads. The rail door stays visible, unlike Employees': that
door leaks that a salary register exists, and this one leaks nothing an
ordinary member should not know the product has.

**When the mock grows a notifications screen, the mock wins.** This entry
retires the moment there is something to cite, on the § 4 iteration
pipeline: change it in v0, merge it, diff, port the delta.

### 18. Import screens — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19** (every row as recorded).
Application-first. Numbered 18 by
coordinator allocation; 17 belongs to the notifications pack of this wave.

**There is no mock citation for this screen, and this entry exists so that
absence is a recorded decision rather than an omission a reviewer has to
guess at.** `AGENTS.md` § Design contract says a pull request touching a
visible surface must cite the mock screen it replicates. So: there is
nothing at `punyanagari/Auto-MB-Vercel-du@fdfd610` to cite. The mock has no
importer, no upload panel and no staging concept — it draws the registers
an import fills, and nothing about filling them from a file.

That puts the screen under § Design contract 4 and § Approved divergences
4, "screens the mock does not cover", whose list this extends. Every
element on it is one the mock already ships:

| Element                 | Taken from                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Page header             | `PageHeader`, eyebrow + title + description, as every register uses it              |
| Upload panel            | `Card` + `CardHeader`, the mock's `data-surface` panel                              |
| Register picker         | The `field`/`select` pair every form on the product uses                            |
| Both tables             | `DataTable`, with the sr-only caption `test/a11y-invariants` requires               |
| Status                  | The shared dot-plus-label `StatusChip`, in the product's own tone families          |
| Withdrawal              | `ConfirmDialog`, destructive tone, the same anatomy every cancel flow uses          |
| Empty / loading / error | `EmptyState`, `LoadingState`, `ErrorState` — the same three every register declares |

**Two chip words join the shared vocabulary** rather than being styled
locally. `validated` takes the warning family beside `claimed` and
`awaiting-approval`: a batch whose rows have all been judged is waiting on
a person, which is exactly what that family means. `error` takes the
destructive family beside `cancelled` and `rejected` — and the distinction
from `low-stock`, which is deliberately warning, is the one worth stating:
a part that needs reordering is a thing to do, and a row that cannot be
written is a thing that failed. `pending`, `completed`, `cancelled` and
`superseded` were already mapped and keep their readings — `superseded`
arrived with the tax-invoice replacement (0051) and reads the same way
here: not a failure, and no longer the live document either.

**One icon is new to the rail: `Upload`**, for the Imports entry, checked
against every icon already on it. The screen sits directly beneath Masters
in Administration, because the two registers it fills are the two Masters
owns and an operator who has just found the Contacts screen should be one
row from the way to fill it eight hundred at a time.

**The screen is a conversation rather than a button, and the layout says
so.** An import is never "did it work"; it is "which eleven rows are wrong
and why". The batch list is the history, the open batch beneath it is the
argument, and the register is untouched until one button is pressed — which
is why that button counts the rows it will write ("Import 2 rows") and the
paragraph above it says, in words, that nothing has been written yet.
Errors sort to the top of the row table whatever their line number, because
burying eleven refusals under four hundred passes is how an operator
concludes an import simply failed.

**Three things the Imports screen does not do**, each because the
alternative would be a second place to do something, or a worse answer:

- **Edit a cell.** A staged row is what the sheet contained, and migration
  0094 refuses to rewrite it. An operator who could patch row 412 here
  would produce a register nobody can reconcile against the file it came
  from — and the file is what their colleague sends again next quarter.
  They fix the workbook, which is the only fix that survives.
- **Poll for progress.** Parsing is synchronous, so a batch is judged by
  the time the upload answers. There is nothing to wait for, and inventing
  a spinner for it would be inventing the wait as well.
- **Undo a committed import.** The rows are ordinary register records once
  they are written, and they are retired the way every other record of that
  register is. A bulk undo would be a second, weaker delete path around
  rules the registers already have.
- **Update an existing record.** An importer CREATES; a row whose natural
  key already exists is reported as a duplicate, in the register's own
  words, and never overwrites what is there. Match-and-update is a
  different feature with a different failure mode — a mistyped key
  silently rewriting the wrong party's bank details — and it needs a
  column to match on that the operator chooses deliberately.
- **Accept a sheet of unlimited size.** Five thousand rows, eight
  megabytes, and a ceiling on the text the cells expand to. Past any of
  them the refusal says to split the file, because a synchronous parse is
  what buys the immediate verdict this screen is built around; the job
  queue is there when a register arrives that genuinely cannot be split.

**One divergence from the product's own habit, stated so it is not
mistaken for an oversight:** the row table renders the sheet's raw cells
beside the errors, unformatted and untruncated. Every other register in
this product formats what it shows. These are not the product's values —
they are what somebody typed into Excel, shown so it can be compared with
the workbook still open on the other monitor.

**Those cells do not outlive the decision.** The moment a batch is
committed or withdrawn its staged cells are emptied, and they are not in
the organisation export at all. A contacts sheet is a column of bank
account numbers and IFSCs, and the single-record path is deliberately
discreet about both — `contact-fields.ts` says of them that they are
"never audited and never logged". Keeping a second unredacted copy in a
staging table, echoed on every read and published in a recovery package,
would be the one place that discretion did not reach. What survives is
what happened: the row number, the verdict, the error in the register's
own words, and the record the row became.

That is also why the two reads are gated differently. The batch LIST is
ordinary register history and every writer sees it — which files were
imported, when, and how many rows each refused. Opening a batch shows the
cells, so the batch DETAIL carries the import authority, and the screen
draws the "Open" control only for a member who holds it. Nobody is
offered a door that answers 403.

**Uploading a sheet for a register retires the open ones aimed at it**,
and the batch says `superseded`. The alternative was leaving a validated
batch committable indefinitely, which turns the ordinary correction loop
into a trap: upload, read the eleven errors, fix the workbook, upload
again — and now two batches are committable, the corrected one and the
one with the typo still in it. Committing the wrong one writes a
known-bad row and reports success.

**An imported record gets the register's own creation event**, the same
one the form writes, with the batch id in its payload. A contact brought
in by a sheet therefore has the history panel a contact typed into the
form has, and "who added this vendor" is answerable from the vendor
rather than only from this screen. The batch keeps an event of its own
beside them, as the provenance those records point back at.

**The row table pages, and the paging is real.** The screen asks for the
error rows first and the valid ones on request, and both are requests
against the server's own cursor — not a slice of a response that already
carried five thousand rows. A batch's rows are never sent in full.

**When the mock grows an import screen, the mock wins.** This entry retires
the moment there is something to cite, on the § 4 iteration pipeline:
change it in v0, merge it, diff, port the delta.

### 19. Audit trail, Reports, and an export on every register — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19** (every row as recorded).
Application-first. Numbered 19 by
coordinator allocation; 17 and 18 belong to the two packs of this wave that
land beside it.

**There is no mock citation for either screen.** `punyanagari/Auto-MB-Vercel-du@fdfd610`
draws no audit register and no reports page: `components/app-sidebar.tsx` at
that commit ends its Administration group at Settings. Both screens are
therefore § Design contract 4 — behaviour the mock cannot express, built
inside the mock's visual grammar with its existing components — and they
extend § Approved divergences 4's list of screens the mock does not cover.
This entry exists so the absence is a recorded decision rather than an
omission a reviewer has to guess at, exactly as § 16 does for the signing
queue.

#### What is on them, and what each element is taken from

| Element                 | Taken from                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Page header             | `PageHeader`, eyebrow + title + description, as every register uses it                  |
| Filter row              | The `Receivables` filter bar: `sr-only` labels over bare selects, and `DateField` pairs |
| The register            | `DataTable`, with the `sr-only` caption `test/a11y-invariants` requires                 |
| Event detail            | `Sheet`, side `right` — the same anatomy the receivables bill sheet uses                |
| Before / after          | The Timeline's own diff list, shared verbatim through `lib/audit-text.ts`               |
| Tiles                   | The dashboard's `data-surface` hairline grid of `Stat`s                                 |
| Empty / loading / error | `EmptyState`, `LoadingState`, `ErrorState` — the same three every register declares     |

**No chip words are added.** Neither screen has a status vocabulary: an
audit event is a fact that already happened, and a month's output tax is a
number. Nothing on either page carries a lamp.

**Two rail lamps are added**, both under Administration and both new to
this rail: `History` for Audit trail and `ChartColumn` for Reports. Neither
collides with an icon already on it. The mock's own rail gives `Users` to
both Employees and Members (§ 15 records that), so a collision here would
have been tolerable; there is none.

#### Three decisions a reviewer should be able to disagree with

**Reports is a separate screen, not more panels on the Dashboard.** The
landing dashboard is the screen every session opens with, it already
pre-aggregates four evidence tables, and `routes/dashboard.ts` records the
881 ms it once cost to get that wrong. Month-by-month roll-ups over the
whole invoice and payroll history are read at month end by one or two
people. They do not belong on the loader every sign-in waits for.

**Both doors stay on the rail, and the refusal is at the screen.**
Employees is the only module in this build whose rail entry is hidden by
authority (§ 15), and the reason there is specific: a register of salaries
is not something to advertise a way into. It does not transfer. That an
audit trail EXISTS is not a secret — every member should know their actions
are recorded — so the door stays and the screen says which authority opens
it. The management summary is the same: the figures are private, the
existence of a reports page is not.

**The audit register refuses an assigned-scope member rather than
narrowing.** Every other cross-Work register in the product narrows to the
member's assignments. This one cannot do so honestly: `audit_events` carries
no `work_id`, the entity-to-Work mapping `routes/timeline.ts` maintains
covers only the entity types a Work has, and the organisation-level events —
a member added, a rate changed, the profile edited — are much of what the
register exists to show. A narrowed register would look complete and be a
slice, with nothing on it saying so. The refusal names the Work's own
Timeline tab, which serves that member completely.

#### The retention window is worded as a window, everywhere it appears — RATIFIED 2026-08-19

**Owner ruling of 2026-08-19: approved as recorded.** The window narrows
what the register SHOWS and purges nothing, and that stays the posture.

The Settings card is headed "Audit register", its field is "Window
(months)", and both its hint and its read-only line say that nothing older
is deleted. The register itself repeats the sentence under its filters, with
the date it actually reached back to.

That wording is load-bearing rather than cautious. "Retention policy"
normally implies a purge, and this one has none — migration 0095 argues why
at length, and the short version is that Rule 3(1) of the Companies
(Accounts) Rules requires the trail to be KEPT for the section 128 period.
A screen that let an owner believe they had configured a deletion would be
worse than no setting at all.

#### Export on a register is one control with one meaning

`ui/download-button.tsx` is on Works, Challans (the delivery tab only — the
issue-challan register has no workbook, and one button serving two
registers handed an operator the wrong file), Invoices, Inventory, Payments
and Employees, and on the audit register itself. It is always the same
control in the same place: the page header's action slot.

**A register export is the WHOLE register under the caller's own scope, not
the screen's current filter state.** The filters do not travel, and the
control says so — a register with an active search, status or date filter
renders a line under its button naming what the file will actually contain.
That is a recorded decision rather than a limitation nobody noticed: wiring
six different filter shapes into the export is one querystring schema and
one WHERE fragment per register, and it will be done when an operator asks
for a filtered workbook rather than pre-emptively.

**The audit register is the one export whose filters travel**, and it is not
an inconsistency. Its window is clamped by the organisation's retention
policy, so a trail exported without its window would claim to reach further
back than the register may look. There, the filters are part of what the
document IS.

Both kinds say what they are in the filename: an audit workbook carries its
applied window, a Tally file carries its period. A workbook cut short by the
row cap says so in its own last row, not only in a response header.

The control prints its own refusal beside itself rather than staying silent,
and that is the case worth reviewing: a work-scoped register narrows for an
assigned-scope member, but an organisation-wide one (vendor payments,
employees) refuses them outright, and a button that quietly did nothing
would read as broken rather than as a wall.

The Tally card states, on the screen, that the integration is ONE WAY:
nothing is read back, and re-exporting a period offers the same vouchers
again. An export that looked like a sync would invite somebody to expect
their Tally edits to return.

**When the mock grows either screen, the mock wins.** This entry retires the
moment there is something to cite, on the § 4 iteration pipeline: change it
in v0, merge it, diff, port the delta.

### 20. Platform controls — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19** (every row as recorded,
with one figure changed — see the export window below). Application-first.
Numbered 20 by coordinator allocation; 17, 18 and 19 belong to the three
sibling packs of this wave.

**THE EXPORT ARTEFACT LIVES FOR THIRTY DAYS, changed from seven by the
same ruling.** The screen has never printed the number as prose — it
renders whatever the server says the window is, and the server is the
single definition of it — so this is a one-line change with no visual
consequence beyond the sentence the card composes.

The reasoning is worth recording because the first figure had its own.
Seven days was chosen on the argument that an export is taken for an
accountant, a lender or a due-diligence request and those move at the
pace of a working week. The ruling is that they do not: the counterparty
who asked for the copy is working to a month-end, an audit cycle or a
bank's own queue, and an artefact that lapsed before they opened it meant
the whole export was made a second time. It stays a fixed window the
requester does not choose, and the bytes are still deleted when it
passes; an artefact already built keeps the expiry it was given, because
the guard freezes it and a window that moved under a row already handed
to somebody would be this product rewriting a promise it had made.

**There is no mock citation for these panels, and this entry exists so that
absence is a recorded decision rather than an omission a reviewer has to
guess at.** There is nothing at `punyanagari/Auto-MB-Vercel-du@fdfd610` to
cite: the mock has no module switch, no job scheduler and no export
request. It could not — an entitlement exists because a government
certification has not landed, a schedule exists because a bank guarantee
lapses whether or not anybody is looking, and an export exists because a
contractor is entitled to their own data. None of those is a screen a
designer would draw unprompted.

That puts all three under § Design contract 4 — "behaviour the mock cannot
express is built inside the mock's visual grammar using its existing
components, without inventing new visual language" — and § Approved
divergences 4, "screens the mock does not cover", whose list this extends.
Every element is one the mock already ships:

| Element                 | Taken from                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------- |
| The two panels          | `Card` + `CardHeader`, the mock's `data-surface` panel, sitting in Settings           |
| Module and check rows   | The bordered list rows `components/company-document-library.tsx` uses for credentials |
| On / off                | The shared dot-plus-label `StatusChip`, in the product's own tone families            |
| Run history             | `DataTable`, with the sr-only caption `test/a11y-invariants` requires                 |
| Export register         | `DataTable`, right-aligned mono numerics, one action column                           |
| Empty / loading / error | `EmptyState`, `LoadingState`, `ErrorState` — the same three every register declares   |

**No chip word is added.** Every state here is spelled with a word the
vocabulary already carries, and each is chosen for the tone `ui/chip.tsx`
already gives it: a module reads `active` or `disabled`, an export walks
`pending` → `processing` → `active` / `failed` / `expired`, and a run reads
`pending` / `claimed` / `completed` / `failed`.

**A switched-off check has two readings and they must not look the same.**
One the SCHEDULER stopped — because the member it ran as has left — is work
to do, and reads `paused`, which is the warning tone § 17 gave a throttled
template for exactly that reason. One an OPERATOR stopped is inert, and
reads `disabled`: unmapped and therefore neutral, which `ui/chip.tsx`
records as a decision beside `paused` rather than leaving it to accident.

**A refused run reads `review`, in the WARNING family and not the
destructive one.** It is not a run that broke: it is a run the database
declined to start because the member behind it has gone, and it has a
one-click remedy on the row above. `docs/DESIGN.md` § Status badge
semantics gives the destructive family to cancelled/rejected/declined; a
to-do with a remedy belongs to warning.

**Timestamps on these two tables are mono and tabular but LEFT-aligned**,
where every other register right-aligns its numerics. The rule the
registers follow is about quantities and money, where the decimal point
carrying down a column is what makes two figures comparable at a glance.
Nothing on these screens is compared that way — an operator reads one run's
instant, not a column of them — and a right-aligned instant beside a
left-aligned check name reads as a mis-set column rather than a number.
Amounts on this screen (the export's size) keep the right-aligned numeric
treatment.

#### Where they live, and why not in the rail

**Settings, beside the signing kiosk, and deliberately not a top-level
module.** The rail is the operator's working day — Works, challans, bills,
payments. These three are the organisation's posture: what it may use, what
it checks on a clock, and whether it has taken a copy of itself. An
operator visits them when something changes, not when something is due, and
a rail entry for a screen visited twice a year costs every other screen a
row of attention. `docs/UX.md` § Settled information architecture already
puts organisation administration here.

#### The one thing an operator has to be able to read

**A recurring check runs under the authority of the member who last saved
it, and the screen says so on the row.** ADR-0011 gives the queue no
service identity, so a schedule borrows a real membership; when that member
leaves, the queue parks the run in `refused_bind` rather than running on a
departed person's authority.

That state is not a failure and must not read as one. The run-history row
carries a sentence rather than an error — "the member this check runs as is
no longer in the organisation; save the check again to run it as yourself"
— because the remedy is a different act from every other failure's, and a
red chip alone would send an operator looking for a bug.

#### The remedy is a control, never a sentence pointing at one

The row for a paused check carries **Run as me** beside its on/off switch.
An earlier draft said "save the check again" in prose while the only button
on the row switched it off — which would have made an operator disable a
statutory check in order to fix its custody. A remedy the screen names is a
remedy the screen has to offer.

The scheduler pauses the check on the FIRST refusal rather than after a
count. A monthly check that re-refused every cadence would otherwise turn
into an unbounded stream of terminal rows nobody reads, and the queue's own
`refused_bind` count would stop meaning anything.

#### What a cadence promises, and what it does not

Stated here because it is a choice rather than an accident, and because the
screen shows both numbers:

- **The next run is `now + one cadence`, measured from when the run was
  enqueued.** So a run drifts by however long the tick took to notice it,
  and a monthly check saved on the 31st lands on the 28th in February and
  stays there. Neither matters for a check that answers "what lapses in the
  next N days" — N is the horizon, which the operator sets, not the
  cadence. Anchoring to a calendar day would need a day-of-month column and
  a catch-up rule, which is a schedule engine and not this.
- **A missed window is not recorded.** A worker that was down for a week
  produces one run on its return, not seven, and the run history shows one
  row rather than a gap. The alternative — a marker row per skipped
  occurrence — would put rows on the operator's screen describing work that
  never happened, to answer a question the queue's own health already
  answers (`docs/RUNBOOK.md` § 7b).
- **A check switched back on runs once straight away**, then on its
  cadence. The screen's copy says so, because a schedule resuming after a
  long pause would otherwise look like it had fired for no reason.

#### Two divergences from the product's own habits, stated so they are not mistaken for oversights

**The export digest is printed in full, 64 characters, monospaced and
wrapped**, where every other register truncates a long identifier. It is
the only way a recipient can check that the file they were handed is the
file this organisation built, and half a digest checks nothing. § 16 prints
its SHA-256 the same way and for the same reason.

**A module nobody has configured says so in words** — "never configured —
using the shipped default (on)" — rather than rendering as though somebody
chose. The distinction between "we decided this" and "nobody has ever
touched it" is the whole value of the panel to the person auditing it six
months later. The same reasoning puts the operator's NOTE on the row: "off"
without "waiting on NIC re-certification" is a fact nobody can act on, and
the note survives a plain on/off toggle because the screen sends only the
new state and the contract treats an absent note as "leave what is there".

#### What these screens deliberately do not do

- **Grant an authority.** That is the Members screen, and a second place to
  change a permission is a second place for the two to disagree.
- **Show the queue.** The run history is this organisation's own scheduled
  checks and nothing else. A queue browser would be a cross-tenant surface
  the product does not have and should not grow.
- **Offer a shareable download link.** The export is fetched with the
  session, like every other file here. A link that works without one is a
  copy of the whole business with a longer half-life than the decision to
  make it.

**When the mock grows these screens, the mock wins.** This entry retires
the moment there is something to cite, on the § 4 iteration pipeline:
change it in v0, merge it, diff, port the delta.

### 21. Retention, security deposit and liquidated damages — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19.** The four divergences
below are approved as recorded; the open ruling that used to sit at the
end of this entry is answered, and the arithmetic changed with it —
migration 0104. Numbered 21 by coordinator allocation; 17 to 20 belong to
the packs of this wave and the one before it that land ahead of it.

Unlike § 16, this entry DOES have a mock citation, and the divergence is
about what the mock's drawing turns out to mean rather than about it being
absent.

#### Where it lives, and the citation

`components/work-registers.tsx` at `fdfd610` describes the Work's
Instruments section as the place to "track bank guarantees, EMD and
**security deposits** held against this work", and the mock's own seed data
(`lib/data.ts`, instrument `in-3`) carries a security-deposit instrument
whose **bank reads "Deducted from bills"**, valid till a date two years
out, for ₹14,75,359.

So the mock already says where retention money is read. The application
puts it exactly there — a `data-surface` panel on the Instruments tab,
under the guarantees and the PAC certificates — and adds no tab, no rail
lamp and no address of its own. Every element is one the mock already
ships: `Stat` tiles for the position, `DataTable` for the two registers,
`Disclosure` for each form, `ConfirmDialog` for the two irreversible acts,
and the shared dot-plus-label `StatusChip`.

#### The four divergences, each because the mock's fiction cannot be true

**1. The security deposit is not an instrument row, and cannot be.** The
mock models it as one more card beside the PBG and the EMD, typed in with
an amount and a validity date. In the real product that figure is not
typed by anybody: it is the sum of the `SECURITY_DEPOSIT` deductions the
railway actually made across the Work's bills (migration 0067), less what
it has released. An operator who typed it would be asserting a number the
payment register already knows and can contradict.

So the panel shows the LEDGER — held, released, still held, and the
contractual ceiling — instead of a card. The mock's card grammar is kept
for the instruments that genuinely are documents; retention gets the
register grammar because it genuinely is a running total. A guarantee
lodged in substitution for cash retention is still an instrument, still
drawn as the mock's card, and is named by the release that returned the
cash.

**2. There are two liquidated-damages figures on screen and never a
third.** "Assessed" is this organisation's own reading of its contract;
"deducted" is what the railway took under that head on a payment advice.
They are two claims about the same event and their difference is a
conversation to have with the railway, not a balance. Every instinct of a
dashboard is to subtract them and print the remainder; the panel
deliberately does not, and `work-retention.test.tsx` asserts the
difference never appears. The mock has no drawing of either figure, so
there is nothing to diverge FROM here — the entry records the decision so
a later "tidy-up" does not quietly make it one number.

**3. The chargeable period is a number of DAYS, not a calendar unit.**
Railway conditions of contract read "0.5% per week or part thereof" and
"2% per month". A calendar month is not a fixed quantity, so "per month"
over a delay measured in days has two defensible readings that give
different money. The form offers "Per week (7 days)" and "Per month (30
days)" and stores the number, so the record says exactly what was charged
and the product never asserts a contract term nobody told it. Migration
0098 § 1 argues it in full. A contract that really does say "calendar
month" is a case for the operator to type the figure their clause states,
not for this product to guess.

**4. Two chip words join the shared vocabulary** rather than being styled
locally: `levied` in the primary family beside `issued` and `sent` — an
act that happened and is on the record — and `waived` in the success
family beside `paid` and `approved`, because damages the railway did not
take are money the agency keeps. `levied` is deliberately NOT destructive:
that family is cancelled / rejected / declined, and a levy the contract
provides for is a fact rather than a failure. `draft` and `cancelled` were
already mapped and keep their readings.

#### The cap is a percent of the CONTRACT VALUE — APPROVED, owner ruling of 2026-08-19

**Status: APPROVED. The arithmetic changed with the ruling — migration 0104.**

The ruling, in the owner's own terms: **"LD is always calculated on total
contract value and maximum LD is capped at 5%; penalty clauses for
defective items not repaired within stipulated time or AMC penalties have
NO capping and are calculated separately per tender clauses."**

A railway clause reads "liquidated damages at 0.5% per week, subject to a
maximum of 10%". Of WHAT was the open question, and the two readings gave
different money whenever an assessment was made against less than the
whole contract:

- **Percent of the assessment basis** — what migration 0098 computed.
- **Percent of the contract value** — a fixed ceiling regardless of what
  any one assessment is charged on. **This is the ruling.**

**What moved, and what did not.** Only the CEILING moved. The rate arm
still charges `basis × rate × periods`, because the basis with its label
beside it is the record of what an assessment was charged ON, and an
assessment charged on the late portion of a contract is a real thing an
agency records. What changed is the ceiling that arm is held under: the
cap percentage of the whole contract, whatever the arm was computed on.

The consequence the old arithmetic had is the reason this was a ruling
rather than a preference, and it is now gone: **a railway that levied the
full contractual maximum against a partial basis can be recorded.** Under
0098 that levy exceeded the assessment it was levied against and the
database refused it — the product declining to record what actually
happened.

**Two new things an operator meets.** The contract value is SNAPSHOTTED
onto each assessment as it is written, because a generated column cannot
reach another table and because a variation order that moves the contract
value must not move a levy already claimed; it is frozen with the rest of
the snapshot, and editing it is the same refusal as editing the rate. And
a Work carrying no contract value can no longer be assessed at all: the
cap is a percentage of it, a cap of nothing is zero, and `least(rate arm,
0)` would make every assessment on that Work zero rupees without raising
anything. Stating a basis no longer rescues it — the refusal names the
contract value instead.

**Assessments already made are untouched.** 0104 back-fills each existing
row's snapshot from its own basis, so every cap and every assessment
already put in front of a railway keeps the figure it had. A ruling
governs what is assessed from here on, which is what a ruling can honestly
govern.

**Five per cent is the figure the form steers to**, as a schema default
and a hint rather than a ceiling the product enforces. Tenders vary, and a
cap this product refused to record would send the operator back to a
spreadsheet on the one occasion the difference mattered — the same posture
the whole module takes towards recording what the railway did rather than
what the contract said it would.

#### Uncapped penalties are the PENALTY head, and nothing was added for them

The ruling's third clause — penalties for defective items not repaired in
time, and AMC penalties, have no cap and are computed per the tender's own
clauses — is honoured by what already exists, and the absence of a new
mechanism is the recorded decision.

`bill_payment_deductions.category` has carried `PENALTY` since migration
0067 and kept it when 0080 added `LIQUIDATED_DAMAGES` beside it. A penalty
is recorded on the payment advice where the railway imposed it, touches no
cap, no percentage and no assessment, and is not summed into the LD
position — `work_retention_positions.ld_deducted_total` filters
liquidated damages alone. The refusal that a levy may not exceed its
assessment is raised only on the LD assessment table and has never applied
to a penalty.

What changed is the WORDING, so an operator can find the right head: the
deduction is labelled "Penalty (uncapped)" and its hint reads "Tender
clause — defective items or AMC. Not capped, and separate from liquidated
damages." A second uncapped category would have been a second place to
record one fact, which is the defect this module exists to avoid.

#### Two things this panel does not do

- **Record a deduction.** That belongs on the Bills tab, where the payment
  advice is entered, and a second place to type a security-deposit figure
  would be a second figure that can be wrong.
- **Compute anything in the browser.** The whole liquidated-damages
  arithmetic — the delay, the chargeable periods, the uncapped figure, the
  cap and the assessment — is a set of generated columns on the table
  itself, so there is one computation of it in the product and this screen
  renders decimal strings.

**When the mock draws a retention ledger, the mock wins.** This entry
retires on the § 4 iteration pipeline: change it in v0, merge it, diff,
port the delta.

### 22. Defect liability periods — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19** (all twelve rows as
recorded, and the open question at the end of this entry approved as
recorded too). Numbered 22 by coordinator allocation; 17 to 21 belong to
the packs of this wave and the one before it that landed ahead of it.

**Row 22m was added by a later ruling of the same day**, item 19 of the
owner's live-testing corrections ledger: a third start basis, the Work's
final bill. It is recorded as a row of this entry rather than as an entry
of its own because it changes one select on a surface this entry already
governs, and a reviewer looking for what the warranty screens ship should
find all of it in one place.

**There is no mock citation for either surface, and this entry exists so
that absence is a recorded decision rather than an omission a reviewer has
to guess at.** `AGENTS.md` § Design contract says a pull request touching
a visible surface must cite the mock screen it replicates, and that
reviewers who cannot find the citation should treat the change as
unapproved visual invention. So: there is nothing at
`punyanagari/Auto-MB-Vercel-du@fdfd610` to cite. The mock draws
installations, and it draws a read-only "PAC / BG certificates" list
inside the Work's Instruments section (`components/work-registers.tsx`);
it has never been asked to express the period between the two — the
warranty that runs on an installed quantity and keeps the Performance Bank
Guarantee with the railway.

That puts both surfaces under § Design contract 4 — "behaviour the mock
cannot express is built inside the mock's visual grammar using its
existing components" — and § Approved divergences 4, "screens the mock
does not cover", whose list this extends. Concretely, every element is one
the mock already ships:

| Element                 | Taken from                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Page header             | `PageHeader`, eyebrow + title + description, as every register uses it                                     |
| The term and the cover  | `data-surface` panels with the mock's labelled `dl` pairs, exactly as the PBG-requirement tile beside them |
| The register            | `DataTable`, with the sr-only caption `test/a11y-invariants` requires                                      |
| Standing                | The shared dot-plus-label `StatusChip`                                                                     |
| Each act                | `Disclosure` over `Field` + `Actions`, the shape the PAC card's own cancel flow uses                       |
| Empty / loading / error | `EmptyState`, `LoadingState`, `ErrorState` — the same three every register declares                        |

**Two chip words join the shared vocabulary** rather than being styled
locally, and both are tone decisions rather than colour choices:

- `elapsed` — a period whose last covered day has passed and which nobody
  has discharged yet — joins the WARNING family beside `expiring`. The
  period ending is the good news; what is outstanding is the paperwork
  that releases the bank guarantee, which is a thing to do.
- `voided` — a period struck out because it should never have been started
  — joins the DESTRUCTIVE family beside `cancelled`. It is a record
  withdrawn, not a record finished. Its sibling `closed` is already
  neutral, because a period that ran its course IS finished.

**The word `expired` is deliberately NOT used for a warranty**, and the
avoidance is the point rather than an accident of naming. `expired` is
already mapped destructive for a lapsed company credential (§ 8), and a
credential lapsing is a problem while a defect liability period ending is
the outcome the whole contract is aimed at. Reusing the word would have
put a red lamp on every warranty that completed successfully.

| #   | The application ships                                                                       | Why, with nothing in the mock to weigh it against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 22a | The Work's card lives INSIDE the Instruments tab, not on a tab of its own                   | The period is the reason the Performance Bank Guarantee above it is still with the railway. The two facts an office compares — when cover ends and when the guarantee lapses — are useless a tab apart, and a `WORK_TABS` entry for one card would put them there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 22b | A rail entry under Operations, beside Installations, with `ShieldCheck`                     | The register answers a question that crosses contracts — what comes out of warranty this quarter — which is a rail question. `ShieldCheck` is not on the rail anywhere else; every other Operations lamp is taken.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 22c | The register READS; every act stays on the Work                                             | Starting a period is decided against that Work's contract term and its installations, so an act with no Work in front of it would be a form that has to ask which Work first — which is the Work page. The installation register took the same shape for the same reason (§ Approved divergences 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 22d | A countdown column in words — "45 days left", "78 days over" — not a progress bar           | A warranty is not progress towards anything; it is time an obligation still has to run. The figure is the SERVER's, measured against the organisation's own calendar day, and the screen prints it rather than computing it — the browser's midnight is not the one that decides a legal date.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22e | No warranty CERTIFICATE, no number, no counter                                              | Migration 0018 already freezes the guarantee text on the Delivery Challan as an issued page. A second warranty document would be a second place to look for one statement, and a numbered series nobody asked for. This pack tracks a PERIOD; it issues nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 22f | The guarantee shortfall is REPORTED, never enforced                                         | The railway holds the guarantee, and the agency cannot refuse reality by refusing a write. The card names the gap in days and says what clears it; nothing here blocks an act because a bank guarantee is short.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 22g | The start picker is capped at fifty with a flag, not paged                                  | It is a picker, and a picker cannot page. The same posture the correspondence composer's thread options already record. Start a period on the ones offered and the next ones appear.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 22h | An installation carrying a period that is not voided cannot be cancelled                    | Cancelling it would remove the ground the period stands on while the railway still holds a guarantee measured against its expiry. The refusal points at voiding the period first — the shape the PAC-coverage refusal on the same button already has.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 22i | An installation whose period was DISCHARGED can never be cancelled, and the message says so | This is a deliberate terminal, not a dead end: a discharged period is a completed legal cycle, and the record it rests on is permanent from that point exactly as an issued document is. Stated here because a refusal that pointed at a void the guard would itself refuse would be worse than the terminal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 22j | Voiding is the only way out of a live period                                                | It is what makes a mistyped extension recoverable — void and start again, the cancel-and-re-record path an installation already has — and it is the one thing standing between a fat-fingered ten-year expiry and a record nobody can correct.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22k | Discharge is confirmed in a dialog that restates the item and the day the period runs to    | Closure is terminal (22i) and it freezes the installation record for good, and its button is one of three identically shaped disclosures repeated once per live period — the only thing telling one stack from the next is a heading that has scrolled away by the time the submit button is reached. The identity belongs inside the submit path, not only above it. Closure stays terminal by design; this adds a sentence, not a state.                                                                                                                                                                                                                                                                                                                                                                                                 |
| 22l | The dashboard's PBG countdown carries the DLP cover date it is measured against             | Two surfaces read the same guarantee: this alert counts it down to its own expiry, the Work's card measures it against the warranty it secures. Unjoined they contradict in both directions — a mild "expires in 40 days" beside a 911-day shortfall, or a renewal nag on a guarantee whose every period is discharged and which is therefore releasable. One date makes the countdown answerable. Null where no live period measures it, which is not a zero.                                                                                                                                                                                                                                                                                                                                                                             |
| 22m | A third start basis, "The final bill date", in the same select — no date field beside it    | Owner ruling of 2026-08-19. Railway letters commonly run the warranty from the raising of the final bill rather than from the units going in, and there was nowhere to record that. It is an OPTION, not a field: the date is the contract's, so the product reads it and pins the period to it exactly, the way the other two bases are pinned (migration 0112, SQLSTATE 23Q11, enforced in the route and again in the guard). A Work with no final bill yet is refused with the sentence that says what to raise, rather than offered a date box to type a guess into. The date itself is the `mb_date` of the finalized final Measurement Book the bill was prepared from, because `bills` carries no date column — the hint under the select says the period starts on the final bill's date and that none can start before it exists. |

**Two additions on surfaces this pack did not create**, both recorded so
they are not mistaken for drive-by edits: the installation cancel button
gains a refusal it did not have (22h/22i), and the Work's Timeline gains
two entity types — the period and the term. The Timeline is where the
REASON for an extension lives, and it lives nowhere else: the pack keeps
no extension table precisely because the trail already answers "why does
this run to 2029".

**One question was open, and the owner ruling of 2026-08-19 approved it
as recorded: the behaviour ships unchanged.** An elapsed period — one
whose last covered day has passed and which nobody has discharged — can
still be extended, and the extension may be dated across the gap,
retroactively resurrecting cover for days on which every screen in the
product said the Work was out of warranty. The reasoning below is what
was approved, including the decision to say nothing extra on the form and
to keep the fact in the trail instead.

That may be exactly right. An office that agrees a rectification in March
for a period that lapsed in January is usually describing ONE continuous
liability rather than two, and the railway holding the guarantee reads it
that way. But nothing in the product, the migration or this document
states it, and an operator extending an elapsed period is not told that
this is what they are doing. The pack ships the behaviour unchanged and
records the fact instead: every extension's audit payload now carries
`elapsedAtExtension`, so an extension that crossed a lapsed gap is
distinguishable in the trail from one that did not, whichever way the
ruling goes.

**Owner ruling of 2026-08-19, settled**: a retroactive extension across a
lapsed gap is legitimate, and the screen says nothing extra before the
operator commits it. An office that agrees a rectification in March for a
period that lapsed in January is describing one continuous liability, and
the railway holding the guarantee reads it that way. The
`elapsedAtExtension` flag on every extension's audit payload stays, so an
extension that crossed a lapsed gap remains distinguishable in the trail
from one that did not.

**When the mock grows a warranty screen, the mock wins.** This entry
retires the moment there is something to cite, on the § 4 iteration
pipeline: change it in v0, merge it, diff, port the delta.

### 23. Offline behaviour — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19** (every row as recorded).
Numbered 23 by coordinator
allocation, ahead of the packs holding § 17 to § 22, all of which have
since landed above it. The allocation is what kept two sections from
sharing a number across a parallel wave, which is the defect § 15 names.

**There is no mock citation for anything in this section, and that is the
first fact about it.** `punyanagari/Auto-MB-Vercel-du@fdfd610` has no
offline state anywhere: no connectivity indicator, no staleness label, no
refusal copy, no cached-data treatment. Grep it for the word and there is
nothing. So this sits under § Fidelity contract 6 and § Approved
divergences 4 — behaviour the mock cannot express, built from components
the mock already ships — and every element is named below so that the
absence of a citation is a recorded decision rather than an omission a
reviewer has to guess at.

§ 2 (Full mobile shell) already carried the sentence this section
discharges: "Offline synchronisation is not implied in copy until it is
implemented." It is implemented now, in the narrow sense set out here,
and § 2's sentence stands for everything this section does not do.

#### What "offline" means in this product

Auto-MB's outward documents are issued by the server: numbered from
gap-free per-Work counters, guarded by lifecycle locks and approvals,
frozen as immutable snapshots. That is what decides the shape of this
feature, and it decides it in one direction.

**A read can be stale. A write cannot be deferred.** A challan queued on a
phone in a yard and replayed forty minutes later would be asking for a
number in an order nobody chose, against a Work whose quantities,
approvals and locks have moved in the meantime — and it would be doing it
under a UI that had already told the operator it was saved. So there is no
mutation queue, no replay, no background sync, and no optimistic write.
This section will not grow one without a much larger argument than
convenience.

#### The four things that happen

| #   | Offline surface                                                                                         | Built from                                                                                                                       | Why it is this and not more                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 23a | **The application opens.** A service worker holds the document and the initial bundle                   | Nothing visual — the shell that was already there                                                                                | Without it a lost connection produces the browser's own error page, and an operator cannot tell a dead network from a dead product. The worker caches the shell and the hashed assets ONLY; `/api/**` never touches it (see 23e).                                                                                                                                                                                        |
| 23b | **A persistent banner** at the top of the workspace, above the open view                                | The warning-tinted panel the mock's own alerts use — `rounded-lg border border-warning/30 bg-warning/15`, 14px ink, leading icon | Warning and not destructive: `docs/DESIGN.md` § Status badge semantics keeps the destructive family for cancelled/rejected/declined, and a lost signal is a thing to do something about rather than a record that failed. `role="status"`, not `alert` — it is a condition lived with, announced once, not an interruption.                                                                                              |
| 23c | **A staleness sentence** inside that banner once a screen has been answered from the copy               | The same panel, with the instant in IBM Plex Mono and `tabular-nums` like every other figure                                     | The OLDEST copy on the screen, deliberately: the sentence is a promise about everything the operator can see, and a reader told "read at 14:32" must not be looking at a column read at 09:10. It is forgotten when the screen changes, and again when the connection returns — the first so it cannot go on naming a screen the operator has left, the second because by then it describes data that has been replaced. |
| 23d | **Every write refused**, before anything leaves the browser, with the refusal left inline on the screen | The persistent inline action error every screen already renders for a server refusal                                             | Refused at the API client, which is the one choke point, so no screen has to remember the rule and none of them drift. The refusal carries a fact and a remedy in the envelope's own shape, so `errorMessage()` renders it exactly as it renders a 409 from the server. Reads are NOT refused — see 23f.                                                                                                                 |

#### 23e. What is cached, and where — the tenancy argument

Two caches, deliberately different in kind, because they hold different
things.

**The service worker's cache holds no tenant data at all.** Cache Storage
is keyed by ORIGIN: it survives sign-out, it survives the tab, and it is
readable by whoever signs in next on a shared site machine. So the worker
caches the document and the content-hashed build assets and nothing else.
`/api/**` and `/documentation` are passed straight through, uncached,
every time; a browser test asserts that no path beginning `/api` is in any
cache after a session. No session cookie, no two-factor state, no record
ever reaches it.

**The read cache holds tenant records in memory, and nowhere else.** It is
a `Map` in the page, keyed by `<user id> <organisation id> <method>
<arguments>`, and it dies with the tab. `localStorage`, IndexedDB and
Cache Storage were all rejected for the same reason: each survives
sign-out on a machine several people use, and none of them buys anything
here, because a cold start offline does not restore a workspace anyway
(23g).

The key is the whole tenancy story and it is enforced three ways:

- a read is written under the account and organisation it was read FOR,
  and can only be served back under the identical key;
- changing either half throws the entire cache away rather than carrying
  it across — which covers signing out, switching organisation, being
  returned to the chooser, and the session lapsing, because every one of
  those leaves the workspace phase and the one effect in `App.tsx` binds
  null;
- a read that was started before a switch and answers after it is
  discarded rather than written, so an in-flight request cannot deposit
  one tenant's records under another's key.

Bounded at forty entries, oldest first, so a long shift cannot grow it
without limit.

#### 23f. What a cached read is, and is not

A copy is served only when BOTH the live read failed AND the browser
reports no network. Serving it on any failure would answer a 403 with
records the caller may no longer be allowed to see, and a 500 with a
register that looks live; the operator would have no way to tell a stale
screen from a current one, which is worse than the honest failure state
every register already renders (§ Shared states).

**Four reads are cached and no others:** the Dashboard, the Works
register, the Delivery Challan register and the Installations register.
The bar is that each is a whole screen's worth of data on its own — a
screen that renders four of its nine panels and errors on the rest is one
nobody can trust. The Work workspace, the editors, Masters and Search each
read several endpoints or write, and are left to fail honestly. A register
the operator has never opened is not available offline, and the product
does not pretend otherwise.

#### 23g. What deliberately does NOT happen, and why

- **A cold start offline does not restore a workspace.** It opens the
  shell and says so, in the mock's own centred auth card with the
  warning-tinted icon `app/sign-in/page.tsx` gives that layout. Restoring
  a workspace would mean caching `/api/me` — the memberships, the
  work-scope, the per-feature permission flags — and a client-side copy of
  an authority decision is exactly the thing this product refuses. It
  would also mean an expired or revoked session still opening a readable
  workspace from disk. The screen instead states two facts and makes no
  promise: the application opened from the copy on the device, and it
  cannot check who is signed in.
- **No mutation queue, no replay, no background sync.** Argued above.
- **No offline drafts.** A draft is a server record with an id, and a
  local one would be a second kind of draft with its own reconciliation
  rules. Refusing is smaller and it is honest.
- **No new route, no new rail lamp, no new module.** Offline is a
  condition of the workspace, not a place in it; `lib/workspace-routes.ts`
  and the navigation lamp switch are untouched.
- **The banner is not on the sign-in, chooser or onboarding screens.**
  Those already answer their own failures, and none of them has records to
  be stale.

#### 23h. When the mock grows an offline state, the mock wins

Every entry here retires on the § 4 iteration pipeline: change it in v0,
merge it, diff, port the delta. The two elements most likely to be drawn
differently are the banner's placement — above the view here, where the
mock might put it in the topbar — and the staleness sentence, which the
mock might make a chip. Neither is load-bearing; the caching rules and the
write refusal are.

### 24. Live-testing corrections, 2026-08-19 — APPROVED

Six owner-ruled corrections from live testing. Every one of them is
app-side: the mock draws no Work that can be configured, no payment
matrix with data behind it, and no LOA review screen, so none of these
has a mock counterpart to replicate and none is a departure from one.
They are recorded here rather than round-tripped through v0, on the
precedent of §§ 3 and 5.

**Excess-delivery toggle moves to the Deliveries tab.** It sat in the
Work header as the only control amid a strip of read-only figures, which
made a per-Work setting look like a Work-wide one. The cap it lifts is
the delivery cap and nothing else (migration 0046; installation has been
outside it since 0077), so it now sits above the deliveries it governs.
Same route, same owner-only gate, same toast copy, same quiet
label-and-control row. Non-owners still read Allowed / Not allowed in
the same place.

**Item numbers sort naturally.** `item_number` is text, so
`ORDER BY item_number` reads A1/1, A1/10, A1/11, A1/2 — an order no
schedule is written in, and one an operator reconciling a printed letter
has to hunt through past the ninth row. One comparator
(`compareItemNumbers`, `@auto-mb/contracts`) now decides the reading for
both sides of the wire. The LOA review screen's item editor is
deliberately NOT re-sorted: its item numbers are editable text, and a
table that re-ordered itself between keystrokes would be worse than the
order it fixed. Its rows arrive in the letter's printed order already.

**Bounded control columns.** A `wrapCell` description beside a `<select>`
starved the select to nothing: auto table layout ignores a cell's
`max-width` when it distributes columns, and `globals.css` gives every
control `min-width: 0`, so the prose took the whole budget and ran on
underneath. `controlCell` (`ui/table.tsx`) puts a MIN-width on the
control's cell, which auto layout does honour. Applied everywhere a
control shares a table row with free text: the payment matrix, the
payment-setup dialog, the LOA review item editor, the challan editor,
the inspection-clause table (whose description cell was not even
`wrapCell` — it is now), and both selects on the Members matrix.

**Completion date proposed from the letter.** The parser has always read
the completion period and nothing consumed it. The review screen now
proposes letter date + N months, states the derivation under the field,
and leaves it overwritable or blank. It follows a CORRECTED letter date
— the field is the derivation until the reviewer types a date of their
own, and from that moment it is theirs and stops moving. Calendar months with month-end
clamping — 31 January plus one month is 28 February — because liquidated
damages are counted from this date.

**Payment matrix stages autofill to zero.** A row saves only at an exact
sum of 100, so once the typed stages reach 100 every remaining stage can
only be 0. The form fills them rather than holding the row refused while
the operator types three zeros to agree with it. Ordinary editable
values: typing over one takes the sum off 100 and stops any further
filling.

**Not selected, and a residual category with a name.** The item-category
select's blank option was called "Uncategorised" and resolved, silently,
through the Work's UNCATEGORISED matrix row — so an item nobody had
looked at and an item deliberately parked in the residual bucket were
the same choice, and the setup dialog's "still uncategorised" count
never reached zero on a Work that was fully configured. The blank option
is now **Not selected**: it saves, it demands no matrix row, and it
bills nothing until it is answered — the Measurement Book names the item
at finalisation, which is the refusal that was always the net.
UNCATEGORISED is a choice of its own, and its matrix row carries a
per-Work editable name, because railway schedules call their residual
bucket "Other items", "Miscellaneous" or "Balance work" and the operator
should read the schedule's own word. That name is what every surface
shows — the matrix row header, the item-category select, the stage
inputs' accessible labels, the setup dialog, the billing-readiness
checklist and the Work's own configuration banner — because one screen
calling it two things is worse than not renaming it at all. Display
only; the key never moves.

The Work's configuration banner and the billing-readiness checklist each
grew a SECOND line for the same reason: "no matrix row for X" and "no
category chosen" are different failures with different remedies, and
readiness reported green on the second because it was reading it as the
first.

**The Remedy column leaves the unfinished-items worklist.** The
quantities stay and say the same thing in less space.

### 25. Editable measured quantity on Measurement Book drafts — APPROVED

Owner ruling of 2026-08-19 (live-testing ledger item 2(a), verbatim): "MB
books drafts: per-line measured quantity becomes EDITABLE DOWNWARD ONLY,
capped at the claimed source's quantity — partial measurement of a claimed
challan/installation."

**The operator's situation.** A delivery challan says ten were delivered.
Eight were accepted at site this month and two are still lying uninspected
at the station. The challan is the evidence and does not change; what
changes is what this Measurement Book measures.

**What the screen offers.** On a DRAFT book's preview table, the Supplied Δ
and Installed Δ cells become fields. Each shows what the operator may
enter and, beside it, what the claimed sources actually deliver — "8 of
10". The claimed figure is also the field's accessible description, so the
pair reads as a pair to a screen reader rather than as a loose number. A
stage the draft claims nothing for shows no field: there is nothing there
to reduce. One **Save measured quantities** action replaces the draft's
whole set, and the answer is the server's recomputed preview — the
amounts, the total and the remarks move together, never against a figure
still being typed.

**Downward only, floored at zero.** A figure above what the sources
deliver is refused, naming every offending line with both numbers
(`MB_MEASURED_ABOVE_SOURCE`); a negative one is refused before the request
opens a transaction. Zero is legal and means "measure none of it from
these sources".

**Only a field a keystroke landed in becomes an adjustment.** Every other
field carries back the adjustment already stored. This matters because a
field is seeded with the figure that will be BILLED, and on a line the
sanction clamp has already reduced that is lower than what the sources
claim — so a screen that inferred "the operator changed this" from the
number would write an adjustment on every clamped line, and that
adjustment would cap the item there for good once an amendment reopened
the sanction. Emptying a field clears the adjustment.

**A line adjusted to nothing STAYS on the preview, and out of the book.**
Without the first half it would vanish the moment an operator typed 0,
taking the field that would undo it with it. Without the second, a zero
line would print on a Measurement Book and ride into a bill. So finalize
asks the QUANTITIES rather than the line count: it refuses a book whose
every line measures nothing with the `MB_EMPTY` sentence it always used,
and leaves the zero lines out of the snapshot, the document and the bill.

**An item this book claims nothing of cannot be adjusted at all**
(`MB_MEASURED_ITEM_NOT_CLAIMED`). Its cap is zero, and an adjustment is
what would put its line on the book — blocking finalize on an item nobody
selected a source for.

**Adjustments travel through a merge.** A consignee who measured eight of
a claimed ten on their own record sheet has stated a fact about the site,
so the merged book's adjustment for that item is the sum of what the
records EFFECTIVELY measure — each sheet's own figure where it made one,
its full claim where it did not. The records' own adjustment rows go in
the same transaction. Un-merge restores the records and their claims but
not their individual figures: the merge folded several into one sum, and
the operator re-enters what they measured.

**Where the unmeasured quantity goes.** Nowhere, this book. It stays
outside it exactly as an over-installed quantity stays outside every book
under the sanction clamp (see _Business-rule note: installation above
sanctioned quantity_), and the FINAL Measurement Book's final-bill stage —
whose base is the item's lifetime delivered or installed quantity, not a
delta over selected sources — sweeps it up wherever the payment matrix
gives that stage a share. On a matrix that gives the final-bill stage
nothing, an unmeasured quantity is not billed at all; that is the same
arithmetic the clamp has always had, and the screen states the two figures
so the choice is a deliberate one.

**And it is stated in rupees.** Above the register, on the same warning
surface the unbillable variation exposure uses and for the same reason:
without it the reduction appears in no number on the screen at all — the
lines show what will be billed, the total sums them, and what the operator
declined to measure is nowhere. It counts the adjustment only, never the
sanction clamp's own remainder, which the exposure beside it already
states.

**Lifetime.** The adjustments belong to the draft. Deleting the draft
deletes them; finalizing freezes them and the finalized line carries the
reduced quantity as the snapshot it always carried. A finalized book shows
one figure and no field.

**App-side divergence.** The mock has no counterpart: its Measurement Book
is a static table with no draft lifecycle to edit. Built inside the mock's
grammar with its own table, field and action components; no new visual
language.

### 26. AMC billing cycles — APPROVED

Owner ruling of 2026-08-19 (live-testing ledger item 6, LOCKED), derived
from six real annual-maintenance letters.

**The unit is the SCHEDULE, not the Work and not the item.** PL-218
(Nagpur) prices a quarterly maintenance schedule beside a visit schedule
billed per trip — twelve periods and eighteen over the same three years.
One Work-level cadence could not describe the letter, and a per-item one
would ask the operator to type the same number against every item and let
them disagree.

**What the schedules screen offers.** Each schedule carries two fields:
how many billing periods its maintenance is measured in, and the word the
agency calls one of them ("quarter", "month", "year", "half-year",
"visit"). Both move together — two values set the cycle, two blanks remove
it, and a half-stated pair is refused (`AMC_CYCLE_INCOMPLETE`). The word
is the word alone: "quarter", never "quarterly bill" or "1 quarter".

**No default is guessed.** A schedule with no cycle stated proposes
nothing and bills exactly as it bills today. The owner's rulings default a
no-cycle letter to one period (final bill for the total) and a
monthly-priced letter to quarterly — and both are defaults the IMPORT
PROPOSES and the operator confirms, never values the product writes on its
own.

**What the cycle proposes.** On the acceptance-certificate screen, each
schedule that states a cycle shows what the NEXT period should certify per
AMC item: the period number, what is certified so far, and the proposed
quantity

    proposed = round3(Q x n / M) - what is certified so far

which is a REMAINDER, not the period's own width. The difference matters
because certificates are the railway's: one taken by hand at a different
figure would otherwise put every period after it out by the same amount
and leave the contract short of Q, or over the sanction cap. Reconciling
against the certified total instead makes the last period exactly
Q - certified, whatever happened before it — so the cadence always closes
on Q, a cycle changed mid-contract self-corrects, and no period ever
proposes a quantity the cap would refuse. Where Q does not divide evenly
the periods differ in the third decimal, and the row says so rather than
presenting an uneven split as an even one.

**How many periods are closed** is asked of the split itself — how many of
its boundaries the certified total has reached — never of a ratio.
Rounding a ratio is wrong at both ends: it puts a whole period at 0.9999
of one, and it calls 99 of 100 over four periods "all four certified"
while a unit is still outstanding.

**It is a proposal and only a proposal.** Nothing about it writes
anything, the certification cap is unchanged, and an operator certifying a
different quantity is certifying what the railway actually accepted. A
Measurement Book always certifies the FULL period quantity: downtime is a
bill-time PENALTY deduction, never a short certificate.

**What the Measurement Book says.** On a Work whose schedule states a
cycle, an AMC line's ACCEPTANCE-CERTIFICATE stage counts PERIODS instead
of quantity, inside the existing remark grammar and with the existing
spellings — "Prepaid 95% for 2 quarters. Now to pay 95% for 1 quarter."
The prepaid clause is still omitted on a first book.

Only that stage. A cycle divides the certified quantity and nothing else,
so a delivery challan against the same item keeps the item's own unit
rather than being counted against a Q it has no relationship to.

**A part-period is never rounded up to a whole one.** The remark is frozen
into a finalised document and read as a contractual statement, so half a
quarter reads "0.5 quarters", not "1 quarter". Only a figure integral
within the split's own third-decimal wobble reads as a whole period.

The clause can only appear on a Work carrying a cycle, which no
already-finalised Measurement Book does, so the remark template version
does not move.

**A cycle is not changed on a Work that is closed.** A completed Work
refuses it under R8, like every other operational change; the cadence
decides what every later certificate is proposed at.

**What does not change.** No payment-matrix change, no per-item axis, and
the rate is still the ACCEPTED rate the server derives.

**Letters that print a negotiated per-item bid rate** — PL-257's shape —
accept that rate less the rebate on the total value, never the advertised
one. The rule is written and proved against the letter's own printed
totals, but nothing computes with it yet: that letter's item table does
not parse, so the figures it needs are not extracted. The caller lands
with the importer work that makes those rows readable. Until then a
letter of the shape reaches a human anyway — its non-zero rebate is a
letter-level review flag.

**App-side divergence.** The mock draws neither surface: its Work carries
no maintenance schedule and no acceptance certificates. Both are built
from the mock's existing table, field and action components.

### 27. Installation recording, and number-only fields — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19**, items 10, 11 and 12 of the
live-testing corrections ledger. Two unrelated surfaces in one section
because they landed in one pack and the second one touches the first: the
installation table's quantity cells are the shared numeric control.

#### 27a. The installation capture flow becomes a table

The mock draws `components/installation-capture-flow.tsx` (at `a8e1fde`) as a
numbered, one-item-at-a-time form: pick the Work, pick the item, type a
quantity, a date, a station, tick serials. The port replicated it, and
live testing found what the fiction could not show — a crew installs six
items at one station on one day. Recording that meant walking the form six
times and picking the same date and the same station on each pass, with
six chances for it to disagree with itself, from a phone, at night, in a
traffic block.

So the flow is now one table, and the divergence is recorded here rather
than iterated in v0 first because it is not a visual preference: it is the
shape of the transaction. The mock's Work is a fiction with one item and no
delivery, and a mock cannot express "the same visit wrote six records".

| #   | What the application does                                                                                                                                                                                                                                                                                                | What the mock draws                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 27a | Date, location and remark stated ONCE above a table of items; each filled row becomes its own installation record, all in one transaction                                                                                                                                                                                | Five numbered fields, one item, one record                   | They are facts about the VISIT, not about the item. Stating them once removes the only way six records of one visit could carry five different dates. All-or-nothing because half a visit recorded is worse than none: the operator cannot tell which half from a screen that has already reset.                                                                                                                                                                                                                                         |
| 27b | The table LEADS with the items that have an installable balance, with a search box over them; the items already installed to their sanctioned quantity are folded away under "Installed to sanction — recording more flags a variation", and the ones whose DELIVERED quantity is fully installed are not offered at all | A `Select` over every item                                   | Ledger item 10. The picker offered the whole schedule, including items with nothing standing on site, so the operator had to remember which had material and which did not. The three outcomes are three different rules, not one: R5 caps a serial-tracked item at what issued challans delivered and refuses more, so a row for it could not succeed; an item with no supply leg has no such floor and the 2026-08-17 ruling says more MAY be recorded, so it keeps a surface rather than losing one; AMC is never installable (0068). |
| 27c | Serials are TYPED as numbers, per row, with the delivered pool as one button per serial beneath the field                                                                                                                                                                                                                | A tap-select checklist of literal serials                    | Ledger item 12. The field has to accept a number that is in no pool — see 27d — so the pool is an assist and never a whitelist. It was a `<datalist>` for one revision and that was wrong: the browser matches a datalist against the WHOLE field value, so it helped with the first of six nameplates and went dead the moment the field held "SN-001, ". Buttons append to the field instead and disable once their serial is in it, which is the tap-select the mock drew, per unit rather than per row.                              |
| 27d | A serial the Delivery Challan missed is ACCEPTED, recorded against the installation, and marked `added here` on the record                                                                                                                                                                                               | Nothing — the mock's serials are literals with no provenance | The owner's rule, verbatim: "if missing serial in DC is added in IC then accept it and record it." A challan is typed from a despatch note; the nameplate is read by the person in front of the equipment. Migration 0108 carries the origin, and the tenant-wide serial trace renders it as a third origin beside Delivered and Production.                                                                                                                                                                                             |
| 27e | The item balances get a failure state of their own, with its own Retry, and it says recording is paused                                                                                                                                                                                                                  | No loading or failure states at all                          | The balances used to be a courtesy line under the quantity field, and a failed read hid one sentence. They now decide the table's CONTENTS, and a silent failure would read as "nothing left to install" — a different fact entirely. Recording is gated on the read rather than degraded, because without balances the only honest table is the whole schedule, which is what 27b removed; the panel says so rather than leaving an empty table to be read as an answer. § Shared states: one failure state per independent read.       |

The record list, the per-item installed summary, the variation chip and
the cancel-with-note form are untouched, and so is every server rule the
old form met: R5's delivery floor, R6's one-serial-per-unit, R11's date
window, the AMC refusal, and the sanctioned-quantity variation flag (§
Business-rule note: installation above sanctioned quantity).

**A typed row is never taken off the screen.** The table recomputes as
balances reload and narrows as the operator searches, and either could
have removed a row the operator had already typed a quantity into —
dropping it from the request as well as from the view, silently, from a
screen that no longer showed what was lost. A row with a quantity in it is
part of the visit and stays rendered and submittable whatever the
arithmetic and the search box say next; the server remains the referee.

**One thing this surface deliberately cannot do**, recorded so its absence
is a decision. A serial that entered at an installation keeps that origin.
When the office later tidies the Delivery Challan and records the same
number against its line, that recording is refused — the number is already
traced under this Work — and the lawful move is to record the line without
it. Adoption, moving a serial from `installation` origin to `delivery` so
the challan can claim it, would rewrite what an issued document was proven
complete against, and is a future decision rather than a gap. The refusal's
remedy says all of this in one sentence
(`apps/server/src/remedies.ts`, `DUPLICATE_SERIAL`).

#### 27b. Every number-only field filters on the way in

Ledger item 11. Numeric fields were one of two hand-rolled shapes:
`<input type="number">`, which brings spinner arrows and a scroll wheel
that edits a quantity when the page scrolls under the cursor; or
`<input type="text" inputMode="decimal">`, which asks a phone for the
right keypad and then accepts anything from a desk keyboard. Both let a
pasted `1,250` reach a form that submitted it, and the refusal came back
from the server after the operator had moved on.

`apps/web/src/ui/numeric-input.tsx` is now the only number-only input, and
all 72 of them use it. It checks on the browser's `input` event — the one
place every keystroke, paste, drag-drop and autofill passes through — so a
non-numeric character never appears rather than appearing and vanishing.

**It refuses; it does not repair.** Anything that is not already a number
is rejected whole and the field keeps the value it had. The first revision
deleted the offending characters and kept the rest, which on exactly the
inputs this control exists for produced a plausible WRONG number instead
of a refused one: `1.2.3` became `1.23`, `12e5` became `125`, `12.345,678`
became `12.345678`, and `1,250` became `1250`. A refusal is visible —
nothing happens, and the operator looks at what they pasted.

The one exception is the integer variant, which **truncates at the decimal
point**: `2.5` becomes `2`, never `25`. Deleting the point on a
months-or-days field multiplies the value by ten and reads as a successful
edit, which is the worst outcome a filter can produce. `2.5.3` is not a
number at all and is refused rather than truncated, so the two rules cannot
be played against each other.

Two more behaviours worth stating. An `input` event raised mid-IME
composition is **left alone** — rewriting the field while an operator is
still composing rearranges what they are typing — and the event that ends
the composition is checked like any other. Non-ASCII digits (Devanagari
`१२`, full-width `１２`) are **refused rather than transliterated**: mapping
them to ASCII is a decision about every numeric string in the product,
including whether a serial or a GSTIN typed the same way should follow, and
not one a shared control may take on its own.

**This is not a mock divergence.** The mock draws bordered text inputs and
so does this: the element, the classes and the rendered appearance are
unchanged everywhere except the fourteen fields that were `type="number"`,
which lose their spinner arrows. That is a visual change, it is stated
here, and it is the point — the arrows were a control nobody used on a
quantity that is a decimal string.

Two things the control deliberately does NOT do, both because a shared
control that guessed would be worse than the refusal it replaced:

- **It does not enforce scale.** `DecimalString` allows three decimal
  places, `RateString` six, money two, percentages four. Silently
  truncating a legal six-decimal rate to three would be a wrong number
  rather than a refused one. The contract schemas judge precision, on the
  server, exactly as before.
- **It does not enforce sign.** A leading `-` is a numeric character;
  whether a negative value is legal belongs to the field's own schema, and
  a control that refused the minus would make the signed money fields
  untypable.

Digit-STRING fields keep their plain inputs and their `inputMode="numeric"`:
HSN and SAC codes, GST state codes, pincodes, IFSC, phone numbers, and
two-factor codes are not numbers — a leading zero and a fixed length carry
meaning there. `apps/web/test/numeric-input-census.test.ts` counts the
source so the distinction cannot rot: a new `type="number"`, or a new bare
input carrying `inputMode="decimal"`, fails the suite.

### 28. Purchase orders — APPROVED

**Status: APPROVED, owner ruling of 2026-08-19** (locked corrections
ledger item 14 and its amendment). Numbered 28 by coordinator allocation:
§§ 24 to 26 are the live-testing, measurement and AMC packs' and § 27 is
#155's, all four merged ahead of this one. Allocated rather than claimed
on merge, which is how two packs came to want the same number in the
first place.

**Mock citations:** `app/purchase-orders/page.tsx` and
`components/app-sidebar.tsx`, both at `fdfd610`. This is the module the
rail comment in `apps/web/src/shell/navigation.ts` used to list as drawn
by the mock and unbuilt here; it is built now, and the omission list is
down to E-Way Bills.

#### 28a. What is ported verbatim

The mock's page is a `PageHeader` with one primary action, a two-tab
`Tabs` list whose labels carry counts, and one dense table inside a
`data-surface` card. All three land as drawn: the header with its
`Operations` eyebrow, the tab tray, and the table with the mock's own
column order — PO number over its date, Against over its kind, Vendor,
the line summary, a right-aligned Value, Expected, Status.

The rail entry takes the mock's own place — Operations, directly after
Inventory — and the mock's own `ShoppingCart` lamp, which is new to this
rail and collides with nothing already on it.

#### 28b. Three divergences, each because the mock's data model is not this one

1. **The second tab is "Outside any LOA", not "Private customers".** The
   mock's `PurchaseOrder.basis` is `work | private-customer` and its
   fixture rows carry a `customer` name. This application has no
   private-customer purchase order and no plan for one: what it has, from
   migration 0109, is an order raised against no LOA at all — office
   stores, plant, anything bought beside a contract. The tab keeps the
   mock's position, its count and its grammar, and names the axis this
   application actually has. Textual only, which § Fidelity contract 2
   allows app-first.

2. **The Item column is a line COUNT.** The mock's fixture gives an order
   one `item`, one `qty` and one `unit`, and renders them as a truncated
   string. This application's order carries up to five hundred lines, and
   a cell showing the first of them would be a cell that is wrong on
   every order with two. The column keeps its place and its width and
   shows how many lines the order carries; the lines themselves are in
   the opened order below the table.

3. **The tab tray is a `role="group"` of `aria-pressed` toggles, not a
   `role="tablist"`.** The shared `TabRail` primitive, for the reason § 9
   gives for the inspection agency pills: `test/a11y-invariants` refuses a
   tablist without the roving-tabindex pattern to match, and these
   controls filter one panel in place.

#### 28c. Behaviour the mock cannot express

- **The `?work=` deep link**, as `#/purchase-orders/<workId>`. The mock's
  own document register carries a `?work=` filter and this application's
  hash router spells the same thing as a path segment, exactly as
  Installations and Warranties already do. Narrowed, the register shows
  the dismissible Work chip those two use and hides the tabs, because one
  Work is already one basis.
- **Where an order is created.** The mock's action is a link to
  `/purchase-orders/new`; this application has no such route and does not
  invent one. An order against a Work is drafted on that Work's
  Procurement tab, beside the schedule it buys for, and the register's
  rows link there. An order with no Work has no such tab, so the
  register carries its create form in the mock's `Disclosure` grammar and
  opens the draft into the shared order panel underneath.
- **The two-part close refusal.** Closing takes two independent facts
  (owner amendment of 2026-08-19): every line received, and at least one
  live vendor tax invoice linked to the order carrying its uploaded
  document. They are separate refusals with separate remedies —
  `PO_NOT_FULLY_RECEIVED` names the lines still owed material,
  `PO_NO_TAX_INVOICE` sends the operator to the vendor ledger — and the
  close button carries a standing `Hint` saying both, so the second one
  is not a surprise at the end of a receipt run.
- **The vendor invoice's document.** One cell on the Payments screen's
  Vendors tab: an upload control while there is none, and the file's own
  name as a `DownloadButton` once there is. Written once, so the control
  is simply absent afterwards rather than offered and refused.

#### 28d. What is deliberately NOT here

- **No purchase-order detail route.** An order opens as a panel under the
  register it was opened from, which is what the Work's Procurement tab
  has always done. A second address for the same record would need its
  own breadcrumb, its own not-found state and its own back behaviour, and
  nothing in the mock asks for one.
- **No private-customer order.** See 28b.1. The mock's `customer` field
  has no writer anywhere in this application, and a column that can only
  ever be empty is worse than a column that is not drawn.
- **No paging control.** The route pages (`limit`/`cursor`), the screen
  reads the register whole, which is what every other register here does
  and what makes the mock's tab counts counts of the register rather than
  of a page. § 19's register-export posture is unchanged.

### 29. Railway measurement — the panel before the bill panel

**Status: application-first, owner ruling of 2026-08-19 (live-testing
corrections item 17; migration 0111).**

**There is no mock citation for this panel and none is possible.** The mock
draws no settlement chain at all — no Measurement Book detail, no railway
bill, and therefore nothing this could replicate. `RailwayBillPanel`
established the precedent when it landed, and this sits directly above it
on the same screen, in the same grammar: the `.data-surface` wrapper, the
`DataTable`, the dot-plus-label `StatusChip`, the file `Field` with its
`Hint`, and the shared `EmptyState` / `LoadingState` / `ErrorState`. No new
visual language, so § Design contract 4 covers it exactly as it covers § 16.

**Why it sits ABOVE the bill panel.** The order on screen is the order the
railway produces the documents in. IWRCMS raises an On-Account Bill FROM a
measurement its own system holds, and until that measurement is on record
and agrees with the finalized Measurement Book there is nothing for a bill
to settle. A panel below the bill would put the precondition after the
thing it conditions.

**Three shapes, and the difference between them is the whole point.**

| Reading               | What the panel draws                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| **Matched**           | A success chip and one sentence. A document that agrees needs no reading.                     |
| **Does not match**    | The per-line table with the differing lines named, and NO control of any kind on those lines. |
| **Could not be read** | The Measurement Book's own lines with a `Confirm item …` button on each, and a running count. |

**The mismatch shape offers no way past itself, and that is a design rule
rather than an omission.** A disagreement about quantities is a
conversation with the railway; a button that let an operator confirm past
it would make the whole comparison theatre, and the server refusing the
click afterwards would only make that a worse experience rather than a
safer one. The refusal is enforced twice on the server as well
(`routes/railway-measurements.ts`, and migration 0111's `23V05`), so the
screen and the database agree about it.

**The unreadable shape is deliberately more work than reading a verdict.**
Each line is confirmed on its own, by name, and the confirmation is
recorded against the member who made it. There is no "confirm all": the
fallback is an act per line, and a single control would be the single
click the model refuses.

**What was walked away from is listed under what stands.** Discarding a
mismatch and uploading a document the parser cannot read re-enters the
gate through the manual confirmation path — a route that is fully audited
and, without this, invisible on the one screen where the next decision
gets taken. So the panel lists every measurement previously discarded
against the book, each with the verdict it carried and the date it was
discarded. Refusing the second upload instead was considered and refused:
the bypass uses a DIFFERENT document, so a digest check would catch only
the honest re-upload of the same file. Visibility is the honest fix, and
the place for it is here rather than in the audit register.

**The bill panel below names the precondition in its own words** rather
than leaving an operator to discover it by being refused. Its upload hint
says the measurement must be matched or confirmed first and points at this
panel; the server's refusal carries the same remedy from the shared
catalog, so the two cannot drift into saying different things.

**When the mock grows a settlement screen, the mock wins.** This entry
retires on the § 4 iteration pipeline, like § 16.

### 30. Register sorting — APPROVED

A register is kept in the order the office keeps it in — newest first
almost everywhere — and that stays the order it opens in. What it gains
is the ability to answer the two other questions the same rows can
answer: which contract is the largest, and which document is the oldest.

**The affordance is the column heading.** A sortable heading is a button
inside its own `th`, carrying the column's name, a direction arrow, and
`aria-sort` on the cell. Clicking a new column sorts it DESCENDING —
largest value, latest date, which is the answer usually wanted — and
clicking the sorted column again flips it to ascending. There is no third
"unsorted" click: the register's own default order is what is on screen
before anything is clicked, and until something is, no heading claims a
sort. Adding a sortable heading therefore changes no screen until it is
used.

**Where the sort happens depends on whether the screen pages.** A screen
holding the whole list sorts it in the view (`sortRows` in
`apps/web/src/ui/table.tsx`). A screen that pages asks the SERVER, with
an optional `?sort=date_asc` on the register's own route: sorting the
pages fetched so far and calling that the register is wrong in the exact
case the sort was asked for, because the oldest row is on the last page.
The parameter is additive and optional — omitting it is the register
byte-for-byte as it was — and its ORDER BY and its keyset predicate turn
round together, because a predicate left seeking the other way does not
fail, it quietly loses or repeats rows at each page boundary.

**Sorted surfaces.** Works (LOA letter date, contract value) · Delivery
challans (challan date, server) · Issue challans (challan date) · Tax
invoices (invoice date, server) · Installations (installed on, server) ·
Purchase orders (PO date, value, expected date) · Payments — advances
(amount) and payables (due date, amount, outstanding) · Quotations (date,
valid until, total).

**Deliberately not sorted.** Document-detail line tables and micro-tables:
a document's line order IS the document, and reordering an issued
challan's lines on screen would misrepresent the paper. Money columns on
the three paged registers: the Delivery Challan register's value is a
per-page lateral sum of its lines rather than a column a cursor could
seek on, and a tax invoice's taxable value is NULL while it is a draft,
which as a leading keyset key makes the whole row comparison NULL and
drops every draft after the first page. Installed quantity: quantities in
different units do not compare. Tenders, which is a card list rather than
a column table and has no heading to click — giving it a sort control
would be new furniture the frozen mock does not carry.

### 31. Unavailable choices stay visible — APPROVED

A choice the product could offer, but cannot offer YET because of a DATA
condition, stays on the screen: visible, disabled, and saying what would
have to be true. It is not removed.

**Why.** Removing it teaches the operator that the feature does not
exist, which is the one thing that is definitely false. They go looking
for it in another module, or ask whether it was ever built. The condition
is nearly always something they can fix in a minute somewhere else, and
naming it is the whole difference between a dead end and a next step. The
worked case: the Measurement Book kind dropdown dropped "Record" until
the Work had a consignee, so record Measurement Books read as a thing
this product does not do. It is now offered as `Record — assign a
consignee to this Work first`.

**The mechanics.** The reason is VISIBLE text, not only a `title`. A
tooltip is a pointer affordance: a touch screen has no hover, a disabled
control is not in the tab order so keyboard focus never reaches it, and a
name that exists only in a tooltip is a name the axe gate counts as
absent. On an `<option>` the reason rides in the option's own text, which
is its entire accessible name. On a control with a hint slot the reason
replaces the hint. On a button it is `ui/unavailable.tsx`'s
`UnavailableAction` — a disabled button with the reason beneath it, bound
by `aria-describedby` and repeated as a `title` for a mouse already
hovering.

**PERMISSION is the exception, and it is not a small one.** A choice
withheld because the caller's membership does not carry the right stays
HIDDEN. A disabled control naming the permission it wants publishes the
permission matrix to every member who cannot use it, which is a worse
failure than a missing button. Where a gate is a conjunction of both — a
draft-status test AND a `can*` test — only the data half converts, and the
permission half keeps hiding the control outright.

**Also not converted, and why.** An action whose absence is already
explained by state shown beside it: a per-row Withdraw on a row whose
status chip already reads "cancelled" is not a hidden choice, and a
disabled duplicate of that sentence is noise. A per-row Remove hidden
while a form holds one line: the last line cannot be removed and a
disabled control on every single-line form is clutter. Loading, empty,
retry and "Load more" branches, which are states rather than choices.
Mutually exclusive relabellings of the same values, which omit nothing.
Fields locked because the LOA parse produced their value, which are
settled under their own ruling.

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
than presented as the formal Measurement Book itself, and since 2026-08-19 it is
**read-only**: its manual quantity form is gone and its write route was removed
outright (owner-sanctioned). ADR-0006 decision 2 had already replaced its billing
role with bills raised from a finalised Measurement Book, so leaving a writer
open meant a Work could be measured two ways that never met, only one of which
reaches a bill. The rows recorded before then stay — they still gate Delivery
Challan cancellation, still export, and still appear on the Work timeline — and
the tab points the operator at the Measurement Books below it for anything new. External statutory
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

### Reveal the result — APPROVED, owner ruling of 2026-08-19

A create form sits above the register it adds to. On any list longer than a
screen the new row therefore lands below the fold, and the operator's report was
exactly that: the toast said the save worked and the page looked identical, so
there was no way to tell whether it had.

So a successful create or update does two things, not one. The toast stays and
says WHAT happened; the record itself is scrolled into view and flashed once, and
says WHERE. `useReveal` (`apps/web/src/lib/view-state.ts`) is the one
implementation — `reveal(id)` at the moment the mutation resolves, `revealProps(id)`
spread on the element that IS that record. It is safe to call before the reload
that renders the row: the target is reached through a ref, so a row that arrives
late is still reached and a row that never arrives costs nothing.

The highlight is `@keyframes reveal-flash` in `globals.css`, a background that
fades to nothing in 1.6s, and it is disabled by the global
`prefers-reduced-motion: reduce` block like every other animation in the product.
The scroll reads that query itself, because an explicit `behavior: 'smooth'`
argument outranks the CSS property that block sets.

Where the result does NOT live on the page that made it — a created purchase
order, a confirmed letter, an opened challan — the screen navigates to it instead,
which it already did. The reveal is for the same-page case only.

Two surfaces deliberately do not reveal. Editing an awarded item on the Schedules
tab writes the row the operator is looking at, and the payment matrix's six
category rows are a fixed short list that is never off screen; in both, a scroll
would move the page away from where the operator already is.

### Every event date starts at today — APPROVED, owner ruling of 2026-08-19

A date input that records something that HAPPENED opens on today, through the
shared `todayIso()` helper. Challan receipt, installation, movement, Measurement
Book, payment, retention release, LD assessment, warranty discharge, PO date,
quotation date, credit-note date, invoice date: the operator is recording it now,
so today is right far more often than blank is, and the field is still editable.

Three classes of date deliberately do NOT default, and each refusal is a rule
rather than an omission:

- **Contractual, derived or parsed dates** — the completion date, a granted
  extension, a GST rate's effective-from, a DLP expiry, the letter date the parser
  read. These come from a document or from arithmetic. A plausible wrong value is
  worse than a blank, because nothing downstream can tell the two apart.
- **Dates transcribed off somebody else's paper** — an inspection certificate, a
  bank guarantee, a carrier's transport document, a PAC. The date is printed on a
  document the operator is holding; defaulting it invites a value that was never
  read off the page. The PAC's issue date matters twice over, because a defect
  liability period can start from it.
- **Dates the SERVER already fills in its own timezone** — the maintenance
  despatch and return challans, and the stock movement date, whose fields say
  "blank means today" and whose blank is answered by the organisation's clock. A
  browser default here would make the viewer's laptop authoritative over a date
  printed on paper, which is the defect that arrangement was built to avoid. The
  challan and issue-challan editors take the same organisation `today` from their
  own server read, which is better still.

Filter and export ranges default to whatever bounds the report, never to today as
a rule.

### Long lists open as sections, not as a wall — APPROVED, owner ruling of 2026-08-19

The awarded-items editor's arrangement — Expand all / Collapse all beside a plain
count, and one collapsible section per schedule with a sticky summary row — is the
product's answer to any list long enough that its shape cannot be seen. It is a
shared primitive (`apps/web/src/ui/schedule-section.tsx`), not a per-screen habit,
and it now carries the payment matrix's item-category table and the PAC
certificate's certified-quantity form as well as the awarded-items editor and the
LOA review screen.

Short lists stay flat. A section around six fixed rows is a control that answers a
question nobody asked.

One thing a converting screen has to check first: a closed section is UNMOUNTED,
which is what keeps its fields out of the tab order. A form that reads its values
back off the DOM at submit would silently lose everything typed into a section the
operator then collapsed, so its inputs have to be React state first. The PAC form
was converted that way.

The surfaces that stayed flat, and why, so the list is not read as an oversight:
the challan and issue-challan item tables, the Measurement Book's lines and the
inspection-clause table all render rows whose API shape carries no schedule, so
grouping them needs a contract change rather than a screen change; the
post-creation payment-setup dialog is a dialog, and the summary row sticks against
a shell header that a dialog does not have.

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

**Real-render axe measurement is authoritative**, and it is now the only
measurement there is. A set of five `design:*` scripts used to sit beside it,
each auditing one rendered HTML file named by hand; they were removed because
nothing ran them and two of them misparsed the `oklab()` alpha tints this
palette's status styles are built from (`bg-success/10`, `bg-warning/15`,
`border-primary/20`), so their numbers on exactly the pairs most worth checking
were wrong. Do not reintroduce a contrast claim that was not measured on a real
render.

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
Appearance settings · Monthly payroll · Spreadsheet imports · Signing queue ·
Warranties register and the Work's defect liability card

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
