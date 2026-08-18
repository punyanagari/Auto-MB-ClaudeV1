# Third-party agent skills — provenance

Two design skills back UI work in `apps/web`, both fetched on setup into
git-ignored paths in this directory. A third,
Anthropic's `frontend-design`, is
used but deliberately not committed — see below. A fourth skill, `caveman`, is
unrelated to design and governs agent prose style rather than the product.
Nothing here is authored by this project except this file.

| Skill | Source | Pinned at | Licence | How it arrives |
| --- | --- | --- | --- | --- |
| `impeccable` | `pbakaus/impeccable`, `.claude/skills/impeccable` | `1cbee026c319` | Apache-2.0 | fetched on setup |
| `ux-designer` | `szilu/ux-designer-skill` | `28b24d5a9511` | MIT | fetched on setup |
| `caveman` | `JuliusBrussee/caveman`, `skills/caveman` | `309834233183` | MIT | vendored |

## Fetched on setup, not vendored

`impeccable` (~70k lines) and `ux-designer` (~12k lines) used to be
vendored here; together they dwarfed the product source in every clone,
diff and review. They are now git-ignored and arrive by

```
node scripts/fetch-skills.mjs
```

(also run by `scripts/bootstrap.sh`), which clones each upstream at the
exact commit pinned in the table above and installs the same file set the
vendored copies carried, byte for byte — `impeccable` from the upstream
`.claude/skills/impeccable` tree plus its repo-root LICENSE, `ux-designer`
from the upstream root minus its README. The pin lives in this file and in
the script together; change them in the same commit or not at all. The
small `caveman` skill stays vendored (it is wired into a SessionStart
hook and must exist before any network is available).

A third skill, `ux-ui-agent-skills`, was consumed from npm and driven by
five `design:*` package scripts. It is gone: those scripts measured a
single rendered HTML file that had to be built and named by hand, which
made them a tool nobody reached for rather than a gate, and every claim
they could settle is already settled on real renders by the standing
Playwright axe suite (`pnpm --filter @auto-mb/web test:e2e`). Two of them
were also known to misread `oklab()` alpha tints on this palette. The
dependency, its `axe-core` and `playwright` companions, the runner and the
knip exemptions that existed only to justify them went with it.

## `frontend-design` is deliberately not vendored

Anthropic's `frontend-design` skill governed the aesthetic direction of this
rehaul, and its guidance is baked into the result. It is **not** committed here.
Its licence reads "© Anthropic PBC. All rights reserved. Use is subject to
Anthropic's Commercial Terms of Service" — using it while building is ordinary,
but redistributing a copy inside a commercial product repository is a different
act, and not one to perform by default.

Load it from the plugin marketplace when doing visual-direction work:
`anthropics/claude-code`, `plugins/frontend-design`. The skills below carry
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
a root `CLAUDE.md` would collide with `AGENTS.md`, which is the instruction
authority in this repository.

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

## Skills that were evaluated and rejected

- **`nextlevelbuilder/ui-ux-pro-max-skill`** — 18 MB, ~25k lines. A searchable
  CSV database of styles, palettes and font pairings rather than a set of checks.
  Queried for this product it returned "Analytics Dashboard / Financial
  Dashboard", recommending dark-mode OLED and `#333333` body text. Picking a
  theme by product category is precisely what the craft floor forbids — the use
  scene here is site engineers in Indian daylight — and hard-coded hex is what
  the token layer exists to prevent. No runnable checks against our code.

## Maintenance

Everything is pinned — the fetched skills to upstream commits, `caveman`
as a vendored copy; nothing updates itself. Bump a pin deliberately (in
this file and `scripts/fetch-skills.mjs` together for the fetched pair),
and re-read the craft floor and detector rules after doing so, since a
bump can change what the gates enforce.
