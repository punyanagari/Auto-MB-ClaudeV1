# ADR-0014: Adopt the v0 mock as the design contract; port the design, not the code

- Status: Accepted (owner decision 2026-08-16, refined 2026-08-17)
- Date: 2026-08-17
- Supersedes: the visual half of the 2026-08-12 "quiet light" ruling recorded in
  `docs/UX.md` § Visual system. The interaction architecture, state coverage and
  verification-gate rulings of that document survive and are carried forward.
- Implements: the "Design contract" section added to `AGENTS.md` by PR #96.
- Related: ADR-0005 (legacy UI audit disposition), ADR-0006 (measurement-book
  lifecycle), ADR-0012 (hybrid outbound signing), ADR-0013 (e-way bill goods
  model).

## Context

Auto-MB's shipped interface is the "quiet light" system: a blue action colour on
cool white surfaces, semantic `light-dark()` token pairs in
`apps/web/src/globals.css`, a hash-routed workspace shell, and per-view state
coverage enforced by `apps/web/test/views/state-coverage*`. It was blessed by the
owner on 2026-08-12 and it works, but it was assembled screen by screen by
engineering rather than designed as a whole.

Separately, the owner designed a complete interface for the same product in
Vercel's v0 and exported it to `github.com/punyanagari/Auto-MB-Vercel-du`. That
mock covers the shell, every major register, the Work workspace, the document
lifecycles, masters, members and settings, in one coherent visual language: an
oklch token set with a desaturated teal primary, a collapsible icon sidebar plus
a sticky topbar, `data-surface` card panels, a status badge that is a dot plus a
label, and IBM Plex Sans/Mono as the only families.

Two designs for one product is the problem. Either the mock is decoration that
rots, or it is the contract. The owner's decision on 2026-08-16 is that it is the
contract.

The mock is not, however, code we can adopt. It is a static Next 16 App Router
prototype with module-scope literals in `lib/data.ts` for data, `useState` for
every mutation, no server, no authentication, no organisation scoping, no
row-level security, no migrations and no tests. The application is a working
React 19 + Vite front end against an Express server and a PostgreSQL database
with RLS on every tenant-owned row, an issued-document immutability model,
gap-free numbering under concurrency, a per-feature permission matrix and a
substantial component and Playwright suite. Replacing the application with the
mock's code would delete the product and keep the pictures.

## Decision

### 1. The mock is the binding UI/UX contract

`punyanagari/Auto-MB-Vercel-du` is the design source of truth for the redesigned
application. Design flows one way: from the mock into the application, never back.

### 2. Design-port-not-code

The application ports the mock's **design** — tokens, layout, structure,
components, density, typography, interaction patterns — into its own React + Vite
codebase, primitives and routing. It does not port the mock's implementation:
not Next.js, not the App Router, not `lib/data.ts`, not the mock's state model,
and not any of its shadcn/Base-UI package wiring beyond what the application
already has.

Concretely, and in both directions:

- **Ported verbatim**: the oklch token values, the radius scale and its derived
  steps, the type families and weights, spacing and density decisions, component
  anatomy and class-level composition, copy where the mock's copy is right.
- **Not ported**: the framework, the routing mechanism (the application keeps its
  hash-serialised workspace navigation), the theming _mechanism_ (the application
  keeps `data-theme` on `<html>` and `light-dark()` token pairs rather than the
  mock's `.dark` class), data access, and every behaviour the mock fakes.

The distinction is load-bearing because both halves fail loudly if confused: a
ported implementation loses authentication and RLS, and a re-invented design
loses the contract.

### 3. Freeze commit

The contract is frozen at commit **`a8e1fde`** of `punyanagari/Auto-MB-Vercel-du`
("Merge pull request #6 from punyanagari/fix/freeze-blockers"). Every porting
pull request replicates that commit and cites the mock screen it replicates by
path. A local clone at exactly that commit is kept at
`C:\Users\agast\Downloads\Auto-MB-Vercel-du`; the live render is
`https://satyakosh.vercel.app`.

The freeze is what makes "visually indistinguishable" checkable. Without a pinned
commit, drift in the mock and drift in the application are indistinguishable from
each other.

**Pointer advance, 2026-08-17: `a8e1fde` → `fdfe5ef`.** The product's
real-render contrast gates measured five WCAG failures in the mock's own
palette (light `--success`, light and dark `--destructive`, dark
`--warning-foreground`, and `--input` sharing `--border`'s value against
WCAG 1.4.11). The fixes were made in the mock first (its pull requests #7
and #8) per the pipeline below, and the owner merged them. The delta
between the two commits is `app/globals.css` only — every component is
byte-identical — so porting the delta was the token re-sync already
shipped, and the pointer advance changes no component citation.

### 4. The v0 iteration pipeline

Design changes and behaviour changes travel different routes, and neither route
is optional.

**Design change** (anything visible: layout, navigation, screen structure,
components, tokens, colour, spacing, typography, interaction pattern):

1. The change is made in v0 against the mock.
2. The owner merges it into `punyanagari/Auto-MB-Vercel-du`.
3. The new mock commit is diffed against the previously frozen mock commit.
4. The delta — and only the delta — is ported into the application, in a pull
   request that cites both commits.
5. The freeze pointer advances to the new commit, recorded in `docs/DESIGN.md`.

**Behaviour change** (validation, server rules, real data, permissions,
lifecycle, numbering, money): made in the application, expressed inside the
mock's existing visual grammar, with no new visual language invented. The mock is
not updated for behaviour it cannot express.

The single exception, already stated in `AGENTS.md`, is purely textual change —
copy, labels, messages, error text — which may land application-first.

### 5. Approved divergences are enumerated, not improvised

The application diverges from the mock only on the list recorded in `docs/UX.md`
§ Approved divergences. That list is exhaustive: a divergence that is not on it
is a defect. Adding to it is an owner decision, not an implementation decision.
The categories are language and script support, the mobile shell, the permission
model, screens the mock does not cover, and accessibility fixes forced by the
real-render gate.

The permission divergence is the one with teeth: the mock's Members screen is
built on the per-feature permission matrix and per-member work assignment already
implemented, and any Owner/Editor/Viewer role collapse is rejected under
`AGENTS.md` rule "do not replace the per-feature permission matrix". Where a
future mock proposes roles, the mock is wrong and the application does not follow
it.

## Consequences

- `docs/UX.md` is rewritten as the design contract and `docs/DESIGN.md` is added
  as its component- and token-level companion. The 2026-08-12 quiet light § Visual
  system is retired; the interaction architecture, shared-state and
  verification-gate material is carried forward, not deleted.
- `apps/web/src/globals.css` will be re-tokenised to the mock's oklch values while
  keeping the application's three-state `data-theme` / `light-dark()` mechanism.
  Every screen inherits the change, which is why it lands as its own pull request
  with the dual-theme axe suite as the gate.
- The dual-theme Playwright axe suite
  (`pnpm --filter @auto-mb/web test:e2e`) becomes the arbiter of whether a ported
  token set is shippable. Where a mock pairing fails WCAG AA in a real render, the
  token is adjusted and the adjustment is flagged to the owner as a divergence —
  the mock is the contract, not an exemption from the accessibility gate.
- Pull requests that change any visible surface must cite a mock screen path.
  Reviewers who cannot find the citation should treat the change as unapproved
  visual invention.
- The port is not a licence to change server behaviour. RLS, authentication,
  permissions, uploads, money, numbering, issued documents and migrations retain
  the fresh-review requirement in `CONTRIBUTING.md` regardless of how the screen
  above them is drawn.
