# Auto-MB design system

Component- and token-level companion to `docs/UX.md`. That document says what the
interface must be and why; this one says exactly which values and which
primitives express it.

The design contract is the frozen v0 mock (owner decision 2026-08-16, refined
2026-08-17; `adr/0014-v0-mock-as-design-contract.md`). Everything below is read
out of that mock, not invented here. Where this document and the mock disagree,
the mock wins and this document is wrong.

## Freeze pointer

|                            |                                              |
| -------------------------- | -------------------------------------------- |
| Repository                 | `github.com/punyanagari/Auto-MB-Vercel-du`   |
| Freeze commit              | `fdfd610`                                    |
| Local clone at that commit | `C:\Users\agast\Downloads\Auto-MB-Vercel-du` |
| Live render                | `https://satyakosh.vercel.app`               |
| Design source              | `app/globals.css`, `components/**`           |

All paths in this document are relative to that clone unless prefixed with
`apps/`.

**Advancing the pointer** is an owner action. The procedure is in ADR-0014
§ 4: change in v0 → owner merges to the mock repository → diff the new commit
against the frozen one → port the delta → update the table above in the same pull
request. Never advance the pointer and port in separate pull requests; the table
is the only record of what "current" means.

## The citation rule

**Every pull request that changes a visible surface names the mock screen it
replicates, by path in the frozen clone.** For example:

> Ports `app/challans/page.tsx` + `components/challans-workspace.tsx` +
> `components/document-register.tsx` at `fdfe5ef`.

Applies to new screens, altered screens, and new components. For an additive
screen the mock does not cover (`docs/UX.md` § Approved divergences 4), cite the
mock screens whose grammar it borrows instead, and say which components it reuses.

A visible change with no citation is unapproved visual invention. Reviewers
should send it back rather than judge it on taste.

## Token architecture

### Source and mechanism

The mock declares tokens in `app/globals.css` as two flat blocks — `:root` for
light, `.dark` for dark — with a `@theme inline` block mapping each to a Tailwind
v4 colour utility (`--color-primary: var(--primary)` and so on).

The application **ports the values verbatim and keeps its own mechanism**: every
token is a `light-dark()` pair in `apps/web/src/globals.css`, resolved by the
element's `color-scheme`. The default follows `prefers-color-scheme`; the
Appearance setting persists an explicit choice and writes `data-theme="light|dark"`
on `<html>`, which pins `color-scheme` and beats the media query. Native controls
follow the same `color-scheme`. Print renders light.

Two mechanisms, one palette. Do not introduce a `.dark` class, and do not give
any component a theme-specific colour — a component that needs to differ by theme
needs a token, not a conditional.

### Palette

Verbatim from `app/globals.css` at `fdfe5ef`. Light is the `:root` column, dark is
the `.dark` column.

| Token                          | Light                    | Dark                     |
| ------------------------------ | ------------------------ | ------------------------ |
| `--background`                 | `oklch(0.975 0.003 230)` | `oklch(0.17 0.014 245)`  |
| `--foreground`                 | `oklch(0.22 0.018 245)`  | `oklch(0.94 0.007 230)`  |
| `--card`                       | `oklch(0.995 0.001 230)` | `oklch(0.205 0.016 245)` |
| `--card-foreground`            | `oklch(0.24 0.015 250)`  | `oklch(0.93 0.006 250)`  |
| `--popover`                    | `oklch(1 0 0)`           | `oklch(0.23 0.014 250)`  |
| `--popover-foreground`         | `oklch(0.24 0.015 250)`  | `oklch(0.93 0.006 250)`  |
| `--primary`                    | `oklch(0.42 0.09 190)`   | `oklch(0.72 0.09 190)`   |
| `--primary-foreground`         | `oklch(0.99 0.004 190)`  | `oklch(0.19 0.02 195)`   |
| `--secondary`                  | `oklch(0.945 0.008 220)` | `oklch(0.28 0.015 250)`  |
| `--secondary-foreground`       | `oklch(0.3 0.025 235)`   | `oklch(0.9 0.01 195)`    |
| `--muted`                      | `oklch(0.95 0.006 230)`  | `oklch(0.26 0.012 250)`  |
| `--muted-foreground`           | `oklch(0.49 0.018 245)`  | `oklch(0.66 0.012 250)`  |
| `--accent`                     | `oklch(0.925 0.03 190)`  | `oklch(0.32 0.03 195)`   |
| `--accent-foreground`          | `oklch(0.3 0.07 190)`    | `oklch(0.9 0.02 195)`    |
| `--destructive`                | `oklch(0.52 0.19 27)`    | `oklch(0.69 0.19 27)`    |
| `--destructive-foreground`     | `oklch(0.99 0 0)`        | `oklch(0.98 0 0)`        |
| `--success`                    | `oklch(0.5 0.12 155)`    | `oklch(0.68 0.12 155)`   |
| `--success-foreground`         | `oklch(0.99 0 0)`        | `oklch(0.16 0.02 155)`   |
| `--warning`                    | `oklch(0.72 0.14 75)`    | `oklch(0.78 0.13 75)`    |
| `--warning-foreground`         | `oklch(0.3 0.06 75)`     | `oklch(0.78 0.13 75)`    |
| `--border`                     | `oklch(0.885 0.009 235)` | `oklch(0.31 0.012 250)`  |
| `--input`                      | `oklch(0.64 0.009 235)`  | `oklch(0.52 0.012 250)`  |
| `--ring`                       | `oklch(0.5 0.09 190)`    | `oklch(0.72 0.09 190)`   |
| `--chart-1`                    | `oklch(0.44 0.085 195)`  | `oklch(0.72 0.09 190)`   |
| `--chart-2`                    | `oklch(0.7 0.06 195)`    | `oklch(0.55 0.07 195)`   |
| `--chart-3`                    | `oklch(0.55 0.12 155)`   | `oklch(0.68 0.12 155)`   |
| `--chart-4`                    | `oklch(0.72 0.14 75)`    | `oklch(0.78 0.13 75)`    |
| `--chart-5`                    | `oklch(0.5 0.015 250)`   | `oklch(0.66 0.012 250)`  |
| `--sidebar`                    | `oklch(1 0 0)`           | `oklch(0.22 0.013 250)`  |
| `--sidebar-foreground`         | `oklch(0.24 0.015 250)`  | `oklch(0.93 0.006 250)`  |
| `--sidebar-primary`            | `oklch(0.44 0.085 195)`  | `oklch(0.72 0.09 190)`   |
| `--sidebar-primary-foreground` | `oklch(0.99 0.005 195)`  | `oklch(0.19 0.02 195)`   |
| `--sidebar-accent`             | `oklch(0.94 0.02 195)`   | `oklch(0.32 0.03 195)`   |
| `--sidebar-accent-foreground`  | `oklch(0.35 0.06 195)`   | `oklch(0.9 0.02 195)`    |
| `--sidebar-border`             | `oklch(0.915 0.005 250)` | `oklch(0.31 0.012 250)`  |
| `--sidebar-ring`               | `oklch(0.44 0.085 195)`  | `oklch(0.72 0.09 190)`   |

Notes that matter when porting:

- **Primary is a desaturated teal**, not the retired `#155eef` blue. It carries
  the action, the focus ring, the active nav state and the sidebar mark. Light
  primary is dark enough to take white text; dark primary is light enough to take
  dark text — the `--primary-foreground` pair flips, and porting one without the
  other is the most common way to break this palette.
- **`--success` / `--warning` are first-class tokens** with `@theme inline`
  mappings, so `bg-success/10` and `text-warning-foreground` are real utilities.
  They are not part of stock shadcn; the application must declare them too.
- **Warning's foreground is a dark amber, not white.** `--warning` is a fill
  colour for tints; `--warning-foreground` is the text on them. Using `--warning`
  as text on a `--warning/15` tint fails contrast.
- **The chart ramp exists** and is derived from primary, success and warning.
  Charts use it rather than picking colours per screen.

### Type

|                       |                                           |
| --------------------- | ----------------------------------------- |
| `--font-sans`         | IBM Plex Sans → `system-ui, sans-serif`   |
| `--font-mono`         | IBM Plex Mono → `ui-monospace, monospace` |
| Sans weights          | 400 · 500 · 600 · 700                     |
| Mono weights          | 400 · 500 · 600                           |
| Body feature settings | `"cv02", "cv03", "cv04", "cv11"`          |

The mock loads both from `next/font/google`, latin subset. The application
self-hosts them (`@fontsource-variable/ibm-plex-sans`, `@fontsource/ibm-plex-mono`)
and adds `@fontsource/ibm-plex-sans-devanagari` to the `--font-sans` stack for
Devanagari content — the one approved type divergence (`docs/UX.md` § Approved
divergences 1). Do not add a third family and do not add a display face.

Recurring sizes, read off the mock:

| Role                    | Spec                                                                                            | Source          |
| ----------------------- | ----------------------------------------------------------------------------------------------- | --------------- |
| Page title              | `text-2xl md:text-3xl`, `font-semibold`, `tracking-[-0.025em]`, `text-balance`                  | `PageHeader`    |
| Page description        | `text-sm leading-6 text-muted-foreground text-pretty`, `max-w-2xl`                              | `PageHeader`    |
| Section label / eyebrow | `.section-label`: `text-[11px] font-semibold tracking-[0.12em] uppercase text-muted-foreground` | `globals.css`   |
| Metric                  | `.metric-value`: `font-mono text-2xl font-semibold tracking-tight tabular-nums`                 | `globals.css`   |
| Card title              | `text-base leading-snug font-medium`                                                            | `ui/card.tsx`   |
| Body / table            | `text-sm`                                                                                       | `ui/table.tsx`  |
| Table heading           | `text-[11px] font-semibold tracking-wide uppercase text-muted-foreground`                       | `globals.css`   |
| Meta / hint             | `text-xs text-muted-foreground`                                                                 | `Stat`, sidebar |
| Dense identity line     | `text-[11px] text-muted-foreground`                                                             | sidebar, topbar |

**Every number is mono.** Money, quantities, rates, work codes, document numbers,
GSTIN, PAN, serials, counts and keyboard chips render in `font-mono` with
`tabular-nums` where they align in a column. Dates render through the shared date
helpers as `DD/MM/YYYY` and are never produced by `toLocaleDateString()` on a
date-only value.

### Radius

One root value with a derived ladder — port the formula, not seven literals.

```css
--radius: 0.5rem; /*  8px  */
--radius-sm: calc(var(--radius) * 0.6); /*  4.8px */
--radius-md: calc(var(--radius) * 0.8); /*  6.4px */
--radius-lg: var(--radius); /*  8px   */
--radius-xl: calc(var(--radius) * 1.4); /* 11.2px */
--radius-2xl: calc(var(--radius) * 1.8); /* 14.4px */
--radius-3xl: calc(var(--radius) * 2.2); /* 17.6px */
--radius-4xl: calc(var(--radius) * 2.6); /* 20.8px */
```

In practice: `rounded-lg` on buttons, inputs and nav items; `rounded-xl` on cards,
panels and the sidebar brand block; `rounded-md` on tab triggers and status
badges; `rounded-4xl` on stock pill badges; `rounded-t-2xl` on the mobile bottom
sheet; `rounded-full` on avatars and status dots.

### Spacing and density

The mock uses the Tailwind v4 default 4px spacing scale unmodified. There is no
custom spacing token set; do not invent one, and do not reintroduce the retired
"4 · 8 · 12 · 16 · 24 · 32 only" rule — the mock uses half-steps (`gap-1.5`,
`px-2.5`, `mb-7`, `py-0.5`) throughout, and rounding them is pixel drift.

Structural measurements, verbatim:

| Surface             | Spec                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Content column      | `mx-auto w-full max-w-[1440px]`                                                                                               |
| Content padding     | `px-4 py-6 pb-24` → `sm:px-6` → `md:px-8 md:py-8` → `lg:px-10 lg:pb-8`                                                        |
| Topbar              | `sticky top-0 z-20 h-16`, `border-b`, `bg-background/90 backdrop-blur-xl`, `px-4 md:px-6`                                     |
| Sidebar             | `collapsible="icon"`, `border-r-0`, `hidden lg:flex`; header/footer `p-3`, content `px-1`                                     |
| Sidebar nav item    | `h-9 rounded-lg font-medium`                                                                                                  |
| Sidebar brand block | `h-11 rounded-xl border bg-card px-2.5 shadow-sm`                                                                             |
| Mobile bar          | `fixed inset-x-0 bottom-0 z-40 lg:hidden`, `border-t`, `bg-background/95 backdrop-blur`, `pb-[env(safe-area-inset-bottom)]`   |
| Mobile cell         | `min-h-14 flex-1`, `text-[11px] font-medium`, icon `size-5`                                                                   |
| Mobile sheet        | `side="bottom"`, `max-h-[80dvh]`, `rounded-t-2xl`, `pb-[calc(env(safe-area-inset-bottom)+1rem)]`, rows `h-12`                 |
| Page header block   | `mb-7`, `gap-4`, title/description `gap-1.5`                                                                                  |
| Card                | `rounded-xl bg-card ring-1 ring-foreground/10`, `--card-spacing: 4` (`data-size=sm` → `3`), `gap-(--card-spacing)`, `text-sm` |
| Card footer         | `border-t bg-muted/50 p-(--card-spacing) rounded-b-xl`                                                                        |
| Button (default)    | `h-8 px-2.5 gap-1.5 rounded-lg text-sm font-medium`                                                                           |
| Button sizes        | `xs` `h-6` · `sm` `h-7 text-[0.8rem]` · `lg` `h-9`; icon `size-6 / 7 / 8 / 9`                                                 |
| Input               | `h-8 rounded-lg border-input px-2.5 py-1 text-base md:text-sm`                                                                |
| Badge (stock)       | `h-5 rounded-4xl px-2 py-0.5 text-xs font-medium gap-1`                                                                       |
| Table head cell     | `h-10 px-2 align-middle`                                                                                                      |
| Table body cell     | `p-2 align-middle whitespace-nowrap`                                                                                          |
| Work section tab    | `h-11 px-3 text-sm`, underline `border-b-2`, rail `overflow-x-auto border-b`                                                  |

Buttons are 32px, inputs are 32px, table rows are roughly 36px. This is denser
than stock shadcn and the density is the point: the product is a quantity and
evidence system, and airing it out is a defect.

### Component-layer conventions

`app/globals.css` defines three project classes and six slot overrides. Port all
nine; screens depend on them implicitly. All nine are ported, in the
`@layer components` block of `apps/web/src/globals.css`.

```css
.data-surface   /* overflow-hidden rounded-xl border bg-card + 1px shadow — the panel wrapper */
.section-label  /* the 11px uppercase eyebrow */
.metric-value   /* the mono metric */

[data-slot="card"]          /* border-border/90 + a fainter shadow */
[data-slot="table-header"]  /* bg-muted/55 */
[data-slot="table-head"]    /* h-10, 11px, semibold, uppercase, muted */
[data-slot="table-row"]     /* transition-colors hover:bg-accent/35 */
[data-slot="tabs-list"]     /* rounded-lg */
[data-slot="tabs-trigger"]  /* rounded-md px-3 font-medium */
```

Base layer: `* { border-color: var(--border); outline-color: var(--ring)/50 }`,
body on `--background`/`--foreground`, and `::selection` as `bg-primary/20` with
foreground text.

`.data-surface` is the mock's answer to "how do I wrap a table". Use it rather
than hand-rolling a bordered card around every register.

Two things to know about the six slot overrides as they stand. They are inert
until a primitive emits `data-slot` — `ui/card.tsx` and `ui/table.tsx` were
ported with these declarations written inline instead, so the rules and the
rendering agree today but the rules are not what produces it. And
`[data-slot="table-header"]` is the one rule that is deliberately not the mock's
literal: the mock tints with `bg-muted/55`, and a sticky heading cannot be
translucent without scrolled rows reading through it, so this build ships the
opaque `--table-header` mix instead. Whoever adopts the slot hooks keeps it
opaque.

## Status badge semantics

`components/shared.tsx`. The single vocabulary for record state across the whole
product.

```tsx
<Badge
  variant="outline"
  className="h-6 rounded-md px-2 text-[11px] font-semibold capitalize …"
>
  <span className="mr-1.5 size-1.5 rounded-full bg-current opacity-70" />
  {label}
</Badge>
```

Anatomy: a 24px outline badge, `rounded-md` (not the stock pill), 11px semibold
capitalised text, preceded by a 6px dot that inherits the text colour at 70%
opacity. **The dot never carries meaning alone** — the label always accompanies
it, which is what keeps status off the colour-only path in the axe gate.

Four tint families, and only four:

| Family      | Classes                                                    | Meaning                                                         |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Success     | `bg-success/10 text-success border-success/20`             | The state that closes the step                                  |
| Warning     | `bg-warning/15 text-warning-foreground border-warning/30`  | Attention, in progress, awaiting someone                        |
| Destructive | `bg-destructive/10 text-destructive border-destructive/20` | Cancelled, rejected, declined                                   |
| Primary     | `bg-primary/10 text-primary border-primary/20`             | Issued, sent, checked, replied — an outward legal act           |
| Neutral     | `bg-muted text-muted-foreground` (no border tint)          | Inert: draft, completed, ordered, returned, released, discarded |

Statuses mapped at `fdfe5ef`:

- **Success** — `active`, `paid`, `approved`, `accepted`, `confirmed`, `passed`,
  `received`, `valid`, `awarded`
- **Warning** — `on-hold`, `pending`, `needs-review`, `recording`, `partial`,
  `expiring`, `opened`, `in-production`, `low-stock`
- **Destructive** — `cancelled`, `rejected`, `declined`, `expired`, `lost`
- **Primary** — `issued`, `sent`, `checked`, `replied`, `submitted`
- **Neutral** — `draft`, `completed`, `ordered`, `returned`, `released`,
  `discarded`, `archived`, `drafted`

`submitted`, `opened`, `awarded`, `lost` and `drafted` are the tender pipeline's
(migration 0083). Four of the five follow the families above without argument: a
bid uploaded to iREPS is an outward act (primary), one whose technical bid has
been opened is waiting on somebody else (warning), won is success and not-won is
destructive.

`drafted` is **neutral, deliberately**, and it is recorded here so it is not
"fixed" later. It is the same reading `draft` already has one line above — a bid
being assembled is inert, not in progress and not good news — and mapping it to
warning would put an amber lamp on every tender the moment it is created, which
is the state most tenders are in most of the time. A chip that is always lit
says nothing.

`in-production` is the production job card's (migration 0084), and its
sibling `planned` is **deliberately unmapped**, for the same reason
`drafted` above is neutral: a job card that has been raised and not
started is inert, and amber on every card the day it is created is a lamp
that is always lit. `completed` and `cancelled` are the other two states
and both already carry the reading this module wants.

Checked against the vocabularies already here before it was added:
nothing else in the product says `in-production`, and the hyphen keeps it
out of the way of the bare words — `production` alone would be a module
name, not a state. The three states a job card does NOT get are the
mock's `material-short`, `material-ready` and `dispatch-ready`, which are
derived from stock and serial counts rather than decided by anybody
(`docs/UX.md` § 11).
`low-stock` is the stock register's (migration 0087), and its two siblings
are deliberately **unmapped**. The register badges a part `Available`,
`Low stock` or `Retired`; the mock badges the middle one `destructive`, and
that family is cancelled/rejected/declined — a part that needs reordering is
a thing to do, not a thing that failed, which is what warning means one line
above. `available` and `retired` are left out of both maps on purpose, so
they render neutral: being in stock is not an achievement, and a retired part
is finished rather than currently bad, exactly as `completed` and `archived`
are. Collision-checked against every status already listed here — all three
words are new to the vocabulary.

`awaiting-approval`, `partially-dispatched` and `closed` are the maintenance
module's (migration 0088). The first two are warning for the reasons already
listed one paragraph up: a request nobody has decided is waiting on somebody,
and one part-way through its dispatches is work in hand — which is what
`pending` and `partial` already read as. Their fourth sibling `approved` was
already mapped success and needs nothing.

`closed` is **neutral**, for the same reason `completed` is: a maintenance job
whose material has all gone out and whose defective units have all come back is
finished, not currently good news. It is a new word in this vocabulary —
collision-checked against every status listed here — and it is deliberately not
`completed`, because a Work being completed and a maintenance job being closed
are different acts and the register shows both.

Priority is NOT a status here. A maintenance request carries `routine`,
`urgent` or `critical` beside its stage chip, and none of the three enters this
map: the mock badges `critical` destructive, and destructive is
cancelled/rejected/declined. A critical fault is urgent, not failed. It renders
as plain capitalised text, which is what keeps the dot-plus-label vocabulary
meaning record state and nothing else (`docs/UX.md` § 14).

`valid` and `archived` are the application's, added for the company document
library (owner decision 2026-08-18, `docs/UX.md` § Approved divergences 8).
They are the derived-validity vocabulary of a credential: `valid` inside its
window, `expiring` inside the sixty-day warning, `expired` past it, and a
fourth reading — `none`, for a document that never expires — deliberately left
**unmapped** so it renders neutral. "Outside the question" is not "currently
good", and colouring a PAN card green would say the wrong thing.

`archived` is neutral for the same reason `completed` is: a retired credential
is finished, not currently bad.

`sent`, `received` and `replied` are the correspondence register's (migration
0086), and they were listed above as the mock's map before this build had a
screen that rendered them; `ui/chip.tsx` now carries all three. They follow the
families without argument: a dispatched letter is an outward legal act
(primary), a received one is the state that closes the arrival step (success),
and `replied` is primary because the reply — not the receipt — is the act. All
three are DERIVED on read, never stored, so `replied` can appear on a letter
written months ago the moment a later letter cites it.

`completed` being neutral rather than green is deliberate: a completed Work is
finished, not currently good. Do not "fix" it.

Multi-word statuses get a display label (`needs-review` → "Needs review",
`on-hold` → "On hold"); everything else is `capitalize`d from the key. Adding a
status means adding it to both maps — an unmapped status renders bare and
silently loses its tint.

Legal state is never collapsed. Local issue status and external registration
status (IRP, NIC) are separate badges reading separate facts; a locally issued
invoice is never shown as registered.

## Primitive inventory

Mock component → application primitive. The middle column is where the ported
code lives; **New** means the port creates it.

### Shell

| Mock                               | Application                     | Notes                                                                       |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `components/app-shell.tsx`         | `views/OperationsWorkspace.tsx` | Sidebar + topbar + `max-w-[1440px]` main + mobile bar                       |
| `components/app-sidebar.tsx`       | `shell/AppSidebar.tsx`          | Collapsible-icon rail, four groups, footer action + identity                |
| `components/app-topbar.tsx`        | `shell/AppTopbar.tsx`           | Sticky h-16, org/section label, search control, notifications, account menu |
| `components/mobile-navigation.tsx` | `views/OperationsWorkspace.tsx` | 4-cell bar + Record/More sheets; app adds the task flows behind them        |
| `components/work-section-nav.tsx`  | `views/WorkDetail.tsx`          | Underline tab rail; `?section=` becomes the hash section                    |
| `components/ui/sidebar.tsx`        | `shell/SidebarNav.tsx`          | Port the visual contract, not the Base UI provider stack                    |
| `components/appearance-toggle.tsx` | `views/AppearanceSettings.tsx`  | Retarget from `next-themes` to `data-theme`                                 |

The shell lives in `apps/web/src/shell/` rather than under `ui/`: `ui/` holds
primitives a screen composes, and these three are the frame those screens are
composed _into_. `shell/navigation.ts` is the single list of modules, groups
and icons — the rail, the mobile More sheet and the page title all read it, so
adding a module is one edit.

### Content primitives

| Mock                                                                                   | Application                                                  | Notes                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `shared.tsx` → `PageHeader`                                                            | `ui/page-header.tsx`                                         | eyebrow / title / description / action; `titleId` keeps the focus anchor             |
| `shared.tsx` → `Stat`                                                                  | `ui/stat.tsx`                                                | `.section-label` + `.metric-value` + hint; tones default/success/warning             |
| `shared.tsx` → `StatusBadge`                                                           | `ui/badge.tsx`                                               | Re-skin to dot + label; keep the app's status vocabulary                             |
| `ui/card.tsx`                                                                          | `ui/card.tsx`                                                | Adopt `--card-spacing` and `ring-1 ring-foreground/10`                               |
| `ui/table.tsx`                                                                         | `ui/table.tsx`                                               | Adopt `data-slot` hooks so the `globals.css` overrides apply                         |
| `ui/tabs.tsx`                                                                          | `ui/disclosure.tsx` / new `ui/tabs.tsx`                      | Two shapes: the boxed list and the underline rail                                    |
| `ui/button.tsx`                                                                        | `ui/button.tsx`                                              | Adopt the size ladder and `data-icon="inline-start\|inline-end"`                     |
| `ui/input.tsx`, `label.tsx`, `field.tsx`, `textarea.tsx`, `select.tsx`, `checkbox.tsx` | `ui/form.tsx`, `ui/date-field.tsx`                           | `Field`/`FieldGroup`/`FieldLabel`/`FieldDescription` is the form anatomy             |
| `ui/dialog.tsx`                                                                        | `ui/dialog.tsx`, `ui/confirm.tsx`                            | Header/description/footer anatomy                                                    |
| `ui/sheet.tsx`                                                                         | `ui/sheet.tsx`                                               | Bottom sheet for mobile; side sheet elsewhere; skins `ui/dialog.tsx`                 |
| `ui/skeleton.tsx`                                                                      | `ui/state.tsx` → `LoadingState`                              | Keep `aria-busy`; re-skin the blocks                                                 |
| `ui/empty.tsx`                                                                         | `ui/state.tsx` → `EmptyState`                                | One sentence, at most one action                                                     |
| `ui/spinner.tsx`                                                                       | `ui/state.tsx`                                               | Inline waits only; lists and tables use skeletons                                    |
| `ui/progress.tsx`                                                                      | `ui/progress.tsx`                                            | Direct re-skin                                                                       |
| `ui/badge.tsx`                                                                         | `ui/badge.tsx`, `ui/chip.tsx`                                | Stock pill badge; `outline` variant is the status base                               |
| `ui/tooltip.tsx`, `dropdown-menu.tsx`, `separator.tsx`                                 | `ui/tooltip.tsx`, `ui/dropdown-menu.tsx`, `ui/separator.tsx` | Ported for the shell. The dropdown is the mock's surface, not a `role="menu"` widget |
| `ui/avatar.tsx`, `breadcrumb.tsx`, `toggle*.tsx`, `input-group.tsx`                    | New, as each screen needs one                                | Do not port ahead of a consumer                                                      |
| `ui/command.tsx`                                                                       | Deferred to Phase 4                                          | Port the topbar control now, the palette later (`docs/UX.md` § ⌘K)                   |

### Composite patterns

| Mock                                        | Application                                                           | Notes                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `components/document-register.tsx`          | `views/DeliveryChallans.tsx`, `WorkBills.tsx`, `InvoicesRegister.tsx` | `?work=` filter chip, open-draft warning, register card                                 |
| `components/challans-workspace.tsx`         | `views/DeliveryChallans.tsx` + `WorkIssueChallans.tsx`                | Two-tab register with counts                                                            |
| `components/outward-document-lifecycle.tsx` | `ui/signature-panel.tsx`                                              | `draft → pending → finalized`, `amendment-pending → amendment-open`; drives editor lock |
| `components/cancel-document-dialog.tsx`     | `ui/confirm.tsx`                                                      | Reason is required; the number is retained                                              |
| `components/remedy-error.tsx`               | `ui/state.tsx`                                                        | Renders `packages/contracts` `message` + `remedy`                                       |
| `components/quantity-ledger.tsx`            | `views/WorkSchedules.tsx`, `ui/schedule-section.tsx`                  | Sticky first column, right-aligned mono numerics                                        |
| `components/measurement-book.tsx`           | `views/MeasurementBooks.tsx`                                          |                                                                                         |
| `components/work-variations.tsx`            | `views/WorkAmendments.tsx` + Variation section                        | Includes the pending-variation exposure card                                            |
| `components/work-registers.tsx`             | `views/WorkInstruments.tsx`, `PacCertificates.tsx`                    | Contains the mock's read-only PAC/BG list                                               |
| `components/serial-trace-panel.tsx`         | `views/SerialLookup.tsx` → Search                                     | Entry point merges; the chain stays                                                     |
| `components/installations-workspace.tsx`    | `views/InstallationsRegister.tsx`                                     |                                                                                         |
| `components/gst-invoice-composer.tsx`       | `views/work-tax-invoices/*`                                           |                                                                                         |
| `components/company-bank-accounts.tsx`      | `views/Settings.tsx` → Company                                        | Where the Masters bank tab goes                                                         |
| `components/company-document-library.tsx`   | `views/CompanyDocuments.tsx`                                          | Two-card `.75fr/1.25fr` grid; bordered credential rows; status chip is the shared one   |
| `components/signature-approval-inbox.tsx`   | `views/Approvals.tsx`                                                 |                                                                                         |

### Not ported

Next.js App Router and `next/font`; `next-themes`; `lib/data.ts` and every
module-scope literal; `sonner`; `@vercel/analytics`; the mock's HR, production,
inventory and maintenance modules where the application has no corresponding
server capability yet. Their **visual grammar** is available to reuse; their
code is not.

The tender-bidding module left that list with migration 0083, which gave it a
server. Its screens are ported (`app/tenders/page.tsx`, `app/tenders/new`,
`app/tenders/[id]`); the parts of them the mock fakes — a per-tender document
store, a declaration generator, an upload "simulation" — are not, and
`docs/UX.md` § Approved divergences 10 records each one, approved by the owner
on 2026-08-18.

Icons are Lucide, matching the mock's imports. No second icon set, no emoji.

## Motion

The mock is restrained and the port keeps it that way: `transition-colors` on
rows, nav items and buttons; a 1px press translate on buttons
(`active:not-aria-[haspopup]:translate-y-px`); `backdrop-blur` on the topbar and
mobile bar; sheet and dialog enter/exit from the primitive. No decorative
gradients, no entrance choreography.

Every new animation must be disabled under `prefers-reduced-motion: reduce`. The
axe fixture waits out theme-transition frames before sampling because
`transition-colors` on a themed surface samples mid-blend otherwise — a long or
staggered transition will make the accessibility gate flake.

## Verification

Component and token work is proved by the gates in `docs/UX.md` § Verification
gates. The two that bite hardest here:

- **`pnpm --filter @auto-mb/web test:e2e`** — the dual-theme real-render axe
  suite, and the sole authority on whether a ported token pair is shippable.
  This palette's status styles are almost entirely `oklab()` alpha tints, which
  a source-level reading of a token pair gets wrong. Trust the real render.
- **`pnpm bundle:check`** — the port adds primitives; the ratchet is what stops
  it adding them invisibly.

A token whose real-render pair fails WCAG AA is adjusted at token level and the
adjustment is flagged to the owner with the measured ratio, the screen and the
theme (`docs/UX.md` § Approved divergences 5).
