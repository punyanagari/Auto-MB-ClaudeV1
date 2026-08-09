# Third-party agent skills — provenance

Four design skills back UI work in `apps/web`. Three are vendored into this
directory; one is consumed from npm. Nothing here is authored by this project
except `ux-ui-agent-skills/SKILL.md`, which is a thin wrapper, and this file.

| Skill | Source | Pinned at | Licence | How it arrives |
| --- | --- | --- | --- | --- |
| `frontend-design` | `anthropics/claude-code`, `plugins/frontend-design/skills/frontend-design` | `2bb60696142b` | Anthropic Commercial ToS — **see warning below** | vendored |
| `impeccable` | `pbakaus/impeccable`, `.claude/skills/impeccable` | `1cbee026c319` | Apache-2.0 | vendored |
| `ux-designer` | `szilu/ux-designer-skill` | `28b24d5a9511` | MIT | vendored |
| `ux-ui-agent-skills` | `plugin87/ux-ui-agent-skills` | npm `^2.4.0` | MIT | devDependency |

## Licence warning — `frontend-design`

Unlike the other three, this one is **not open source**. Its licence reads
"© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial
Terms of Service." Using it while building with Claude Code is ordinary;
*redistributing* a copy inside this repository is a different act, and this
repository is a commercial product. Before this tree is ever made public, sold,
or handed to a third party, either confirm redistribution is permitted or drop
`frontend-design/` and load it from the plugin marketplace instead. The other
three carry permissive licences and are safe to vendor.

## What each is for

- **`frontend-design`** — aesthetic direction. Stops the UI reading as a
  template. Consulted when choosing a visual language, not when fixing a bug.
- **`impeccable`** — the craft floor plus a deterministic detector of 59 rules
  (`node .claude/skills/impeccable/scripts/detect.mjs <files>`). Catches
  overused typefaces, coloured side borders, flat type scales, eyebrow-above-
  heading, stat-card heroes.
- **`ux-designer`** — usability and compliance reference: WCAG 2.2, forms, data
  tables, i18n/RTL, dark patterns. Advice only, no enforcement. Its "Key Numbers"
  table is tuned for consumer and marketing surfaces; on this product its
  300–500ms animation and 16px-minimum-body figures are **wrong** and the
  project's own values win.
- **`ux-ui-agent-skills`** — runnable gates that measure the rendered page. The
  only one of the four that can settle a contrast or keyboard-access dispute.

## Why `ux-ui-agent-skills` is not vendored

Its `init` installer writes a root `CLAUDE.md` and a root `scripts/` directory,
both of which collide with this repository (`AGENTS.md` is the authority here,
and `scripts/` already holds bootstrap, backup, restore, and import tooling).
Consuming it from `node_modules` avoids the collision and keeps 3.4 MB out of
the tree. Its reference library is read on demand from
`node_modules/ux-ui-agent-skills/`.

## Skills that were evaluated and rejected

- **`nextlevelbuilder/ui-ux-pro-max-skill`** — 18 MB, ~25k lines. A searchable
  CSV database of styles, palettes and font pairings rather than a set of checks.
  Queried for this product it returned "Analytics Dashboard / Financial
  Dashboard", recommending dark-mode OLED and `#333333` body text. Picking a
  theme by product category is precisely what the craft floor forbids — the use
  scene here is site engineers in Indian daylight — and hard-coded hex is what
  the token layer exists to prevent. No runnable checks against our code.

## Maintenance

These are pinned copies, not submodules; they do not update themselves. Re-vendor
deliberately, and re-read the craft floor and detector rules after doing so,
since a bump can change what the gates enforce.
