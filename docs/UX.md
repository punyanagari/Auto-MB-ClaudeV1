# Auto-MB product experience contract

## Purpose

This document records the approved interaction architecture for the full Auto-MB overhaul. It complements `docs/PRODUCT.md`: Product defines the domain and invariants; this document defines how operators move through them.

The interface is operational, calm and document-oriented. Tables remain first-class because the product is a quantity, evidence and legal-record system, but the interface must not expose every table and action at once.

## Experience principles

1. **The Work is the centre of gravity.** Most contract execution begins from a Work workspace, not from unrelated global modules.
2. **Show what is true before showing forms.** Creation and correction controls open deliberately through named actions.
3. **Progressive disclosure.** Summary, exception and next-action information appears before detailed registers.
4. **Legal states are explicit.** Draft, locally issued, externally registered, cancelled, corrected and replaced are never collapsed into one ambiguous status.
5. **Failure is not an empty state.** Loading, no data, permission denial and service failure are represented separately.
6. **Actions explain their consequence.** A blocked or destructive action states what prevents it and which workflow resolves the block.
7. **Mobile is task-oriented.** Site staff receive focused receipt, serial, installation and evidence flows rather than a compressed office dashboard.
8. **Accessibility is part of the workflow.** Every action is keyboard reachable, headings and regions are ordered, focus follows navigation, and status is not conveyed by colour alone.
9. **The server remains authoritative.** Browser calculations are explanatory only; money, quantities, numbering, permissions and lifecycle transitions remain server/database concerns.

## Visual system

Owner decision, 2026-08-12: the shipped quiet light system is the blessed
design contract, and the earlier "Signal Cabin" amber/dark-default language is
retired.

- **Light system (default identity).** Cool white surfaces, one dependable
  blue action colour (`#155eef`), restrained status tones, tabular numerals.
- **Dark palette (added).** A complete dark theme is defined purely by the
  semantic tokens in `apps/web/src/globals.css` — surfaces, text, borders,
  sidebar, status tints, focus ring and selection all have light/dark pairs
  via `light-dark()`. No component carries theme-specific colours.
- **Three-state theming.** The default follows the operating system
  (`prefers-color-scheme`); the Appearance card under Settings persists an
  explicit choice in `localStorage` and applies `data-theme` on `<html>`,
  which pins `color-scheme` and wins over the media query. Native controls
  follow the same `color-scheme`. Print always renders light.
- **Type.** IBM Plex is the only family — Sans for UI, Mono for figures; no
  second display face. The scale is 26px/650 display (h1), 16px/600 section
  (h2), 13px/600 subsection (h3), 14px body, with a 12px floor for
  persistent UI text (labels, meta lines, table headings, keyboard chips).
- **Contrast.** Text/tint pairings, including 12px status chips, must hold
  WCAG AA 4.5:1 in both themes; the live axe/contrast gate is the proof.

## Organisation entry

```text
Sign in
  └─ 0 active organisations → onboarding / create first organisation
  └─ 1 active organisation  → enter automatically
  └─ 2+ active organisations → choose tenant
```

Only active memberships appear. A refresh may reopen the current active organisation during the same browser session; a fresh sign-in with two or more memberships requires deliberate tenant choice. The switch action appears only when another active organisation exists.

Creating another organisation is an account-level action under Settings. One organisation remains one legal entity and tenant.

## Global navigation

The desktop navigation is intentionally small:

- **Home** — attention queue, deadlines, progress and financial follow-up;
- **Works** — contract registry and LOA intake;
- **Documents** — cross-Work legal-document register and quotations;
- **Operations** — search, serial traceability, the installation register, and bounded operational registers;
- **Administration** — masters, members, organisation profile, numbering and security.

Capabilities that belong to one contract—Delivery Challans, Issue Challans, installations, Measurement Books, bills, guarantees and amendments—normally live inside the Work workspace rather than competing as permanent global destinations.

The exception is earned, not assumed: a capability also gets a global register when the operator's real question crosses Works. Delivery Challans did, because two of their three movements have no Work to live under. Installations did, because site supervision asks what went in this week and where, and a gang works several Works in a day. Tax invoices did, because a direct invoice — raised against a private customer, outside any works contract — has no Work to live under either, and because "what have we billed, and what is still unreported" is an office question about the organisation rather than about one contract.

Recording still happens on the Work where a Work is what caps or measures the record: an installation is recorded on its Work, and an invoice that bills a finalized Measurement Book is drafted on the Work that holds it. The register reads across. The exception to the exception is a document with no Work at all — a standalone Delivery Challan, a direct invoice — which is created on the register, because there is nowhere else for it to be created. Such a document takes organisation-wide reach: work scope binds through a Work, and one with none is reachable by every member or by none.

A global register carries the filter its question needs and no more. The installation register's is an inclusive date window, because "what went in this week" is a date range; the invoice register's is the same window over the invoice date. Both read a page at a time with an explicit action to fetch the next, rather than serialising a division's whole history into one response. Work and status filters stay out: a Work's own records are read on the Work, and a status filter would offer to hide exactly what the register exists to keep visible — a cancelled challan, a cancelled invoice, a record that was made and withdrawn.

## Work workspace

Every Work is organised into seven operator-facing areas:

1. **Overview** — contract identity, progress, upcoming obligations, exceptions and next actions;
2. **Items & rates** — schedules, effective quantities, rates, payment categories and specifications;
3. **Documents** — Delivery Challans, Issue Challans, extension letters and other issued Work documents;
4. **Material & site** — procurement position, receipts, custody, and PAC evidence, with the installation records and the serial trace on a section of their own (they were the tail of the delivery section, below the challans and their correction notices, and the serial pool a recording draws from is the same list the trace prints);
5. **Measurement & billing** — measurement evidence, formal Measurement Books, contractual bills and GST invoices;
6. **Guarantees** — PBG, security deposit, warranty/maintenance obligations, completion and acceptance dates;
7. **Activity** — audit timeline, amendments, correction chains and approval decisions.

The Work header remains visible context: Work code, title, status, LOA/tender reference, contract value and current completion position.

## Contract-source intake

The LOA is required. NIT, Contract Agreement and tender/specification PDFs are optional.

The intake flow is:

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
beside a category per item, with one Save and a Later that writes nothing.
Items the reviewer left uncategorised arrive with a category proposed from
their description and marked as a proposal until saved; Save commits the
proposals still standing and says how many. It is offered by the navigation
that follows confirmation and never again — a revisit or a refresh opens the
Work page plainly — and both editors stay permanently on the Work's Schedules
tab.

The unanswered question outlives the dialog, quietly. While any item on a Work
would bill through a category with no matrix row, the Work's overview carries
one muted line saying so and one inline control that opens the same dialog. It
is derived from the Work's data rather than from the visit, so it appears on a
Work configured badly months ago and disappears the moment the gap closes —
which is why the modal never has to reappear. Save refuses to leave that state
in the first place, naming the categories inline.

Extracted payment terms, warranty/maintenance periods, PBG/security-deposit release clauses and item specifications are proposal evidence. They never bypass human review.

## Document creation

Major legal documents use a guided pattern:

1. **Context** — Work, party, date and movement/document purpose;
2. **Lines or sources** — eligible items, quantities, PO/source links and remaining balance;
3. **Evidence and logistics** — transport, serial, attachment or certificate facts where applicable;
4. **Review** — human-readable document preview, warnings and authority requirements;
5. **Issue/finalise** — the server revalidates, allocates the number and freezes the immutable snapshot.

Draft editing and legal issue/finalisation are visually and semantically separate.

## Measurement and financial narrative

The product must consistently explain this sequence:

```text
site evidence
  → formal Measurement Book
  → finalisation
      ├→ contractual bill/payment claim
      └→ GST tax invoice
           → IRP registration where applicable
  → payment receipt/reconciliation
```

The branch is the point, and this document used to draw it as one straight
line — bill, then invoice from the bill (resolved finding 31 in
`docs/AUDIT-DISPOSITION-2026-08-10.md`). The code does not work that way and
never did. Finalising a Measurement Book raises the contractual bill from
that book's lines in the same transaction
(`routes/measurement-books/finalize.ts`), and the GST tax invoice is raised
from the **finalised Measurement Book** as well — a draft invoice is created
against a `measurementBookId` (`routes/tax-invoices/drafting.ts`), never
against a bill id. The bill is not an input to the invoice.

They are siblings from one parent because they answer to different
authorities: the bill is the contractual claim the Railways department
measures and pays against, the tax invoice is the GST document the statutory
regime requires. One finalised measurement is the single source of truth
under both, which is what keeps them from disagreeing. An invoice may also
be raised directly, with no Work and no Measurement Book behind it, for
service billing outside a measured contract.

Cancellation releases the Measurement Book so a corrected document can be
raised against the same measurement; after the IRP's 24-hour cancellation
window a Section 34 credit note is the lawful instrument instead.

The older site `mb_entries` surface is labelled **Measurement evidence** rather than presented as the formal Measurement Book itself: the register heads itself with measurement-evidence language, states that billing runs through the formal Measurement Books below, and no longer shows the retired billed/unbilled chips. (Resolved finding 30 in `docs/AUDIT-DISPOSITION-2026-08-10.md`.)

External statutory registration status is shown separately from local invoice status. A locally issued invoice is never represented as IRP-registered without verified provider evidence.

## Mobile/site shell

The mobile bottom navigation is:

- **Home** — assigned Work alerts and today’s tasks;
- **Works** — assigned Work list and concise Work position;
- **Record** — receipt, serial, installation and evidence actions;
- **More** — permitted secondary registers and account actions.

Large financial, numbering and organisation-administration surfaces remain office-first. Mobile forms use one decision per section, large touch targets, persistent save state and explicit offline/service-error messaging; offline synchronisation is not implied until it is implemented.

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
re-implements: `ui/state.tsx` carries the wait (`LoadingState`, skeleton
blocks announced as busy), the legitimate empty state (`EmptyState`, one
plain operational sentence and at most one action), and the service
failure (`ErrorState`, a persistent alert). `ErrorState` takes its retry
handler as a **required** prop — a failure with no way back is a dead end,
and the type checker is what refuses one. A screen with more than one
independent read carries one failure state per read, each naming what it
retries, so a failed picker stays distinguishable from a failed register.

The permission-limited state is deliberately NOT an `ErrorState`: a 403
does not become a success on the second attempt, so it reads as an inline
refusal rather than offering an action that would refuse identically.

`apps/web/test/views/state-coverage*` holds these to the screen. It derives
the views with a mount load path from the source and fails if one is
neither covered by a case that renders all three states nor exempt with a
stated reason.

The server side of a failure is the shared error envelope
(`packages/contracts/src/errors.ts`):
`message` states the fact that was refused, and the optional `remedy`
states the action that clears it. A remedy belongs to the error code
rather than to the call site, so the reviewed text lives in one catalog
(`apps/server/src/remedies.ts`) instead of drifting across the routes that
throw it.

## Screen inventory

The approved design pack covers:

1. Sign in
2. Create account
3. Organisation chooser
4. Home dashboard
5. Works register
6. LOA upload
7. LOA and contract-source review
8. Work overview
9. Work items and rates
10. Work documents
11. Material and site position
12. Measurement and billing
13. Guarantees and acceptance
14. Work activity
15. Delivery Challan editor
16. Issued Delivery Challan detail
17. Issue Challan editor/detail
18. Measurement Book builder
19. Billing and GST register/detail
20. Purchase Orders
21. Budgetary quotations
22. Approval queue and decision detail
23. Organisation-wide document register
24. Serial lookup and traceability
25. Installation register (tenant-wide)
26. Tax-invoice register (organisation-wide), with the direct-invoice
    editor and the shared invoice detail it opens
27. Contacts
28. Locations, units and signatories
29. Members and permissions
30. Organisation profile
31. Numbering, tax and compliance settings
32. Mobile home
33. Mobile record hub
34. Mobile installation/serial evidence

Small confirmation dialogs, validation summaries, skeletons and error panels use shared patterns rather than becoming separate product architectures.

## Current implementation status

The task-first shell, organisation entry, Home/Works/Documents/Operations/
Administration navigation, Work workspace, LOA and contract-source review,
delivery/issue documents, installation, Measurement Book, billing, tax invoice,
and e-way-bill surfaces are implemented. Shared loading, empty, retry,
read-only, permission, and blocked-action states cover the primary paths, with
component and Playwright/axe regression coverage. Every view that reads on
mount renders the three shared states from `ui/state.tsx`, enforced per view
by `apps/web/test/views/state-coverage*`.

Workspace navigation is serialized into `location.hash` (hand-rolled, no
router library): a refresh restores the exact view including the Work
workspace section, browser Back/Forward walk the view history, register rows
render real links so middle-click works, and unknown or stale fragments fall
back to the Dashboard — except a Work fragment naming a section this build
does not know, which keeps the Work and opens its Overview, because the id is
the durable half of that address. Blocked actions whose remedy lives on another screen
(payment matrix rows, organisation GST profile, buyer contact facts) link
directly to that screen, and each Work's Bills section opens with a billing
readiness checklist deriving the same prerequisites from existing reads.

When Whitebooks is configured, the billing UI performs explicit IRP register,
reconcile, and cancel actions directly through the server adapter. Local and
provider states remain separate. A 202 unknown result is displayed as unknown,
stale in-progress operations expose a recovery action, and registration or
generation is never repeated blindly. Manual compatibility evidence is labelled
unverified and cannot overwrite a provider attempt.

Invoice drafting requires an explicit forward-charge or reverse-charge choice;
submit explains that reverse charge is not yet supported instead of inventing
the printed answer. Submitted tax invoices can be rendered from frozen invoice
facts, regenerated after IRP evidence arrives to embed the signed QR, and
downloaded through an authenticated tenant-bound request. Every render retains
its own PDF, source digest, and frozen logo; the current version remains readable
after local cancellation and all versions are included in the owner export.
The invoice form offers both line shapes: one cumulative SAC service line, or
itemised HSN/SAC lines with their own quantity, unit, rate and GST rate. The
switch starts on the organisation's default and is a choice about the document
in hand, never about the buyer. An itemised invoice's detail and PDF print a
line table instead of a single description.

Invoices are also a module of their own under Documents. Its register reads
every invoice the caller may see — work-backed and direct — with the local
status and the IRP state as separate columns and the source named as a Work
link or as Direct. A row opens the same detail surface the Work's Bills tab
opens, which is what puts Generate PDF, Open PDF, the IRP transport and the
credit note within reach of a direct invoice for the first time. The
direct-invoice editor lives on the register because there is no Work to put it
on; it is the Work form's fields with the Measurement Book replaced by a stated
taxable value, and an itemised direct invoice states no value at all.

An e-way bill is raised where the goods are: from a submitted tax invoice that
carries goods lines, and from an issued standalone Delivery Challan that does.
One panel serves both, because the operator's question is the same either way —
what is moving, under what number, and is it still valid. Applicability is the
server's answer and never the screen's: where a document cannot raise a bill
the panel says why in a sentence that names the fix, rather than offering an
action that would be refused. A service-only document is refused, which is the
2026-08-10 ruling surviving intact and what NIC itself enforces.

The standalone Delivery Challan editor carries the statutory facts that make
this possible: per line an HSN/SAC code beside a goods-or-service marker, and
per challan the movement reason and transport block. They are optional on the
document and required before a bill can be raised, and the editor says so —
they freeze at issue, so they belong on the draft.

A generated e-way bill renders a printable summary. It is a convenience print
and labelled as one on its face and in the panel: the statutory e-way bill is
the document held on the NIC portal. Historical records remain visible,
reconcilable, and cancellable.

## Definition of UX completion

The overhaul is complete only when:

- the approved information architecture is implemented rather than merely recoloured;
- all accepted workflows retain their server-side invariants and permission gates;
- the existing browser and component suites are updated to traverse the new navigation;
- every major page has loading, empty, failure and read-only coverage;
- desktop, tablet and mobile layouts pass keyboard and serious axe checks;
- the final branch passes `pnpm verify`, production Compose smoke and fresh-cluster restore;
- the merge candidate receives product-owner visual approval.
