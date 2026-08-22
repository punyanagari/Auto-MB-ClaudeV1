#!/usr/bin/env node
/**
 * The export-format version sentinel.
 *
 * `EXPORT_FORMAT_VERSION` in `apps/server/src/routes/export.ts` and
 * `EXPECTED_EXPORT_VERSION` in `apps/server/test/helpers/export-format.ts`
 * are a shared, hand-allocated value. Two waves in flight at the same time
 * both write `export-v40`, and git merges the two identical lines without a
 * conflict: the collision is SILENT, and it has happened — v37 in one wave,
 * v40 in the next, each caught only because somebody remembered to look.
 *
 * The convention that removes the class of bug rather than the instance:
 *
 *   A feature branch writes `export-vNEXT` in BOTH files. It claims no
 *   number, so it cannot collide with a sibling branch, and the export
 *   pinning assertions treat the sentinel as "not pinned yet" (see
 *   `expectPinnedExportVersion` in the test helper). The coordinator
 *   replaces it with the concrete next version when the branch merges.
 *
 * This check is what makes forgetting that replacement visible. It fails
 * when the sentinel is still present on `main` — the branch the concrete
 * number is owed to — and passes on every feature branch, which is exactly
 * where the sentinel is supposed to live.
 *
 * Where it bites: `pnpm preflight` and the CI cheap-gates lane both run it,
 * so a coordinator who runs either on `main` after a merge sees the miss.
 * ci.yml's weekly scheduled run checks out the default branch, so a
 * sentinel that survives onto `main` also fails within seven days without
 * anybody doing anything.
 *
 * Usage: node scripts/check-export-sentinel.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** The placeholder a feature branch writes instead of claiming a number. */
const EXPORT_VERSION_SENTINEL = 'export-vNEXT';

/**
 * The two files that hold the value, and how the value is read out of each.
 * Literal patterns rather than one built from the constant name: a regular
 * expression assembled from a string is both a lint finding and a way to
 * match something nobody wrote down.
 */
const SITES = [
  {
    file: 'apps/server/src/routes/export.ts',
    constant: 'EXPORT_FORMAT_VERSION',
    pattern: /^export const EXPORT_FORMAT_VERSION = '([^']+)';$/m,
  },
  {
    file: 'apps/server/test/helpers/export-format.ts',
    constant: 'EXPECTED_EXPORT_VERSION',
    pattern: /^export const EXPECTED_EXPORT_VERSION = '([^']+)';$/m,
  },
];

function declaredVersion({ file, constant, pattern }) {
  const source = readFileSync(path.join(repoRoot, file), 'utf8');
  const match = pattern.exec(source);
  if (match === null) {
    console.error(`- ${constant} not found in ${file}`);
    process.exit(1);
  }
  return match[1];
}

/**
 * The branch this check is judging.
 *
 * On a GitHub pull request the checked-out ref is a merge commit, so
 * `git rev-parse` answers something like `HEAD` or the merge ref rather
 * than the branch under review; `GITHUB_HEAD_REF` is the feature branch
 * name and is what the rule means. On a push, dispatch or schedule run
 * `GITHUB_REF_NAME` is the branch itself. Locally, git answers.
 */
function currentBranch() {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

const versions = SITES.map((site) => ({ ...site, version: declaredVersion(site) }));
const sentinels = versions.filter((site) => site.version === EXPORT_VERSION_SENTINEL);
const branch = currentBranch();
const errors = [];

if (sentinels.length === 1) {
  // Half-applied is worse than either whole state: the route answers one
  // string and the suite pins another, and the failure surfaces as an
  // unexplained assertion rather than as the merge bookkeeping it is.
  const [held] = sentinels;
  const other = versions.find((site) => site !== held);
  errors.push(
    `${held.constant} is the sentinel but ${other.constant} is ` +
      `'${other.version}': both files carry the sentinel together, or ` +
      `neither does (${held.file}, ${other.file})`,
  );
} else if (sentinels.length === 2 && branch === 'main') {
  errors.push(
    `'${EXPORT_VERSION_SENTINEL}' is still on main. The coordinator assigns ` +
      `the concrete next export version at merge; replace it in ` +
      `${SITES.map((site) => site.file).join(' and ')}, taking the number ` +
      `after the highest one main already holds.`,
  );
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(
  sentinels.length === 2
    ? `export format version: sentinel held on branch ${branch} (assigned at merge)`
    : `export format version: ${versions[0].version}`,
);
