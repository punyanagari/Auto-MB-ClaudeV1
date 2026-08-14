// Runner for the vendored ux-ui-agent-skills audit scripts.
//
// Each audit needs a rendered HTML file to measure; the upstream scripts
// print their usage line and exit 0 when called bare, which made every
// `pnpm design:*` entry a gate that could never fail. This wrapper turns
// a bare call into a refusal instead, so nothing can mistake a no-op for
// a pass. The standing, always-on accessibility gate for the product is
// the Playwright axe suite (`pnpm --filter @auto-mb/web test:e2e`), which
// scans real renders of the shipped bundle in both themes.
//
// Usage: node scripts/design-audit.mjs, passing the audit script basename,
// then the rendered HTML file to measure, then any flags.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [script, target, ...flags] = process.argv.slice(2);

if (script === undefined || target === undefined) {
  console.error(
    'design audit: a rendered HTML target is required — these scripts measure a file, they are not a standing gate.\n' +
      'usage: pnpm design:<name> <file.html> [flags]\n' +
      'The always-on gate is the Playwright axe suite: pnpm --filter @auto-mb/web test:e2e',
  );
  process.exit(1);
}

if (!existsSync(target)) {
  console.error(`design audit: target not found: ${target}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [`node_modules/ux-ui-agent-skills/scripts/${script}.mjs`, target, ...flags],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
