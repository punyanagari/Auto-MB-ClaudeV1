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
- **Operations** — serial traceability and bounded operational registers;
- **Administration** — masters, members, organisation profile, numbering and security.

Capabilities that belong to one contract—Delivery Challans, Issue Challans, installations, Measurement Books, bills, guarantees and amendments—normally live inside the Work workspace rather than competing as permanent global destinations.

## Work workspace

Every Work is organised into seven operator-facing areas:

1. **Overview** — contract identity, progress, upcoming obligations, exceptions and next actions;
2. **Items & rates** — schedules, effective quantities, rates, payment categories and specifications;
3. **Documents** — Delivery Challans, Issue Challans, extension letters and other issued Work documents;
4. **Material & site** — procurement position, receipts, custody, serials, installations and PAC evidence;
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
```

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
  → contractual bill/payment claim
  → GST tax invoice
  → IRP/EWB registration where applicable
  → payment receipt/reconciliation
```

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
25. Contacts
26. Locations, units and signatories
27. Members and permissions
28. Organisation profile
29. Numbering, tax and compliance settings
30. Mobile home
31. Mobile record hub
32. Mobile installation/serial evidence

Small confirmation dialogs, validation summaries, skeletons and error panels use shared patterns rather than becoming separate product architectures.

## Current implementation status

The task-first shell, organisation entry, Home/Works/Documents/Operations/
Administration navigation, Work workspace, LOA and contract-source review,
delivery/issue documents, installation, Measurement Book, billing, tax invoice,
and e-way-bill surfaces are implemented. Shared loading, empty, retry,
read-only, permission, and blocked-action states cover the primary paths, with
component and Playwright/axe regression coverage.

Workspace navigation is serialized into `location.hash` (hand-rolled, no
router library): a refresh restores the exact view including the Work
workspace section, browser Back/Forward walk the view history, register rows
render real links so middle-click works, and unknown or stale fragments fall
back to the Dashboard. Blocked actions whose remedy lives on another screen
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
Fresh e-way-bill generation is unavailable for the current cumulative SAC
service invoice. Historical records remain visible, reconcilable, and
cancellable.

## Definition of UX completion

The overhaul is complete only when:

- the approved information architecture is implemented rather than merely recoloured;
- all accepted workflows retain their server-side invariants and permission gates;
- the existing browser and component suites are updated to traverse the new navigation;
- every major page has loading, empty, failure and read-only coverage;
- desktop, tablet and mobile layouts pass keyboard and serious axe checks;
- the final branch passes `pnpm verify`, production Compose smoke and fresh-cluster restore;
- the merge candidate receives product-owner visual approval.
