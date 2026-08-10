# Third-party agent skills — provenance

Three design skills back UI work in `apps/web`: two vendored into this
directory, one consumed from npm. A fourth, Anthropic's `frontend-design`, is
used but deliberately not committed — see below. A fifth skill, `caveman`, is
unrelated to design and governs agent prose style rather than the product.
Nothing here is authored by this project
except `ux-ui-agent-skills/SKILL.md`, which is a thin wrapper, and this file.

| Skill | Source | Pinned at | Licence | How it arrives |
| --- | --- | --- | --- | --- |
| `impeccable` | `pbakaus/impeccable`, `.claude/skills/impeccable` | `1cbee026c319` | Apache-2.0 | vendored |
| `ux-designer` | `szilu/ux-designer-skill` | `28b24d5a9511` | MIT | vendored |
| `ux-ui-agent-skills` | `plugin87/ux-ui-agent-skills` | npm `^2.4.0` | MIT | devDependency |
| `caveman` | `JuliusBrussee/caveman`, `skills/caveman` | `309834233183` | MIT | vendored |

## `frontend-design` is deliberately not vendored

Anthropic's `frontend-design` skill governed the aesthetic direction of this
rehaul, and its guidance is baked into the result. It is **not** committed here.
Its licence reads "© Anthropic PBC. All rights reserved. Use is subject to
Anthropic's Commercial Terms of Service" — using it while building is ordinary,
but redistributing a copy inside a commercial product repository is a different
act, and not one to perform by default.

Load it from the plugin marketplace when doing visual-direction work:
`anthropics/claude-code`, `plugins/frontend-design`. The three skills below carry
permissive licences and are safe to vendor.

## What each is for

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
- **`caveman`** — prose-style skill, not a design skill: it compresses the
  agent's conversational output to terse fragments and drops filler, hedging and
  pleasantries. It changes nothing about the product and nothing about
  persisted text — the skill's own boundaries exempt code, comments, commit
  messages, documentation and PR text, which stay normal prose. Only the chat
  register changes. Vendored upstream-unmodified so it can be re-pulled cleanly;
  the repository's own additions sit in `.claude/hooks/caveman-activate.sh`.

## `caveman` is on by default, and how that is wired

Upstream ships an installer that writes hooks into `~/.claude/` and per-agent
rule files (`.cursor/rules/`, a root `CLAUDE.md`, and friends). None of that was
run here. Claude Code on the web rebuilds the container and reclones the
repository every session, so anything written to `~/.claude/` is discarded, and
a root `CLAUDE.md` is the exact collision this file already rejects for
`ux-ui-agent-skills` — `AGENTS.md` is the instruction authority in this
repository.

What is committed instead is `.claude/hooks/caveman-activate.sh`, wired as a
second `SessionStart` hook in `.claude/settings.json` alongside the existing
environment bootstrap. Hook stdout reaches the model's context on every session,
which makes it the one persistence mechanism that survives a fresh clone without
adding a competing instruction file. The hook prints a short activation
directive and points at `caveman/SKILL.md` for the full ruleset, so the vendored
copy stays the single source of the rules.

Turning it off, in precedence order: `CAVEMAN=off` in the environment, or an
untracked `.claude/hooks/.caveman-off` file. Either silences the hook and
returns prose to normal. Within a running session, "stop caveman" or "normal
mode" still works; the hook only sets the default each session starts in.

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
