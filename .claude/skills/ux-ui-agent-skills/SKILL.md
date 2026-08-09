---
name: ux-ui-agent-skills
description: Runnable UI verification gates for apps/web — real-render WCAG 2.2 AA contrast, interactive-state contrast (default/hover/focus), axe-core violations, RTL mirroring, and heuristic taste review. Use when reviewing, auditing, or changing any screen in apps/web, and before claiming a UI change is done.
---

# UX/UI verification gates

This project consumes [`ux-ui-agent-skills`](https://github.com/plugin87/ux-ui-agent-skills)
(MIT) as a **devDependency**, not as vendored files. The package ships runnable
gates that measure a rendered page rather than reasoning about the source, which
is the only reliable way to make a contrast or focus claim.

Its full reference library — WCAG checklist, ARIA patterns, component specs,
token architecture, 138 design systems — lives under
`node_modules/ux-ui-agent-skills/`. Read from there on demand; do not copy it
into the tree. The kit's own `init` installer is deliberately **not** used: it
writes a root `CLAUDE.md` and a `scripts/` directory that would collide with
this repository's own.

## Running the gates

```bash
pnpm design:contrast apps/web/dist/index.html   # every text element vs its real background
pnpm design:states   <file.html>                # default / hover / focus on every control
pnpm design:a11y     <file.html>                # axe-core, WCAG 2.2 A/AA
pnpm design:rtl      <file.html>                # RTL-only horizontal overflow
pnpm design:taste    <file.html>                # heuristic visual review
```

Each takes a rendered HTML file or URL. For a Vite app, build first
(`pnpm --filter @auto-mb/web build`) or point the gate at the dev server URL.

A headless Chromium must be resolvable by Playwright. In environments where the
bundled revision differs from the one Playwright expects, set
`PLAYWRIGHT_BROWSERS_PATH` to a directory containing the expected revision.

## Rules for using them

1. **Never state a contrast ratio you did not measure.** Run the gate and quote
   its output. `opacity` on a text element changes the effective ratio and is
   invisible to source-level review — `design:a11y` catches it, a CSS read does not.
2. **`design:a11y` is the gate that finds real defects.** In the first run against
   this project's screens it found a scrollable table region unreachable by
   keyboard and four numerals dimmed below AA by `opacity`. Treat a clean
   impeccable-detector run as necessary, not sufficient.
3. **`design:taste` is heuristic and marketing-weighted.** Its "display type must
   be ≥2.5× body" finding does not apply to this product: `apps/web` is an
   operations console, where a tight type scale is correct. Record a rejection
   with a reason rather than silently ignoring it.
4. **`design:rtl` matters here.** Indian Railways signage is bilingual, and the
   UI carries Devanagari station names, so layout mirroring is a real
   requirement rather than a hypothetical one.

## Relationship to the other skills

- `impeccable` holds the craft floor and decides how the UI should look.
  Anthropic's `frontend-design` covers aesthetic direction but is not vendored
  here for licence reasons — load it from the plugin marketplace.
- `ux-designer` supplies usability and compliance reference material.
- This skill proves the result on the rendered page. It settles disputes; the
  others do not.
