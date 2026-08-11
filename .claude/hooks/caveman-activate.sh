#!/usr/bin/env bash
# SessionStart hook: turn the vendored `caveman` skill on by default.
#
# The skill in .claude/skills/caveman/ is discoverable but, like every
# skill, dormant until something invokes it. Claude Code on the web
# rebuilds the container and reclones the repository for every session,
# so a one-time `/caveman` never survives — and `~/.claude/` is wiped
# with the container. The only state that outlives a session is what is
# committed here, and the only committed thing that reliably reaches the
# model's context on every session is SessionStart hook stdout. That is
# what this file is: the persistence mechanism, not a second copy of the
# rules.
#
# The rules themselves stay in .claude/skills/caveman/SKILL.md (upstream,
# unmodified). This prints the short activation directive and points at
# that file for the full ruleset, so the two cannot drift.
#
# Deliberately NOT a root CLAUDE.md: .claude/skills/PROVENANCE.md records
# that AGENTS.md is this repository's instruction authority and that a
# vendored skill writing a root CLAUDE.md is treated as a collision.
#
# Off switches, in precedence order:
#   1. CAVEMAN=off in the environment
#   2. an untracked .claude/hooks/.caveman-off file in the working tree
# Either one makes this hook print nothing, and prose returns to normal.
# Mid-session, "stop caveman" or "normal mode" still works as usual; this
# only controls the default each session starts in.

set -euo pipefail

project_dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

if [[ "${CAVEMAN:-}" == "off" ]] || [[ -f "${project_dir}/.claude/hooks/.caveman-off" ]]; then
  exit 0
fi

skill_file="${project_dir}/.claude/skills/caveman/SKILL.md"

# No skill on disk means nothing to activate. Stay silent rather than
# asking the model to follow a ruleset it cannot read.
if [[ ! -f "${skill_file}" ]]; then
  exit 0
fi

cat <<'DIRECTIVE'
[caveman] Caveman mode is ON for this session, at intensity `full`.

Respond terse like smart caveman. All technical substance stay. Only
fluff die. Drop articles, filler, pleasantries, hedging. Fragments OK.
Technical terms, numbers, units, error strings, code blocks exact and
unchanged. Never drop not/never/no/only/except.

Write NORMAL prose, not caveman, in anything that outlives the chat:
code, comments, commit messages, documentation, PR and issue text. Also
drop caveman for security warnings, irreversible-action confirmations,
and any point where compression would make an instruction ambiguous —
resume after.

Full ruleset, intensity levels and examples: .claude/skills/caveman/SKILL.md
Read it now if not already loaded; it is the authority, this is a summary.

Change level mid-session: `/caveman lite|full|ultra`. Turn off for one
session: "stop caveman" or "normal mode". Turn off permanently: set
CAVEMAN=off, or `touch .claude/hooks/.caveman-off`.
DIRECTIVE
