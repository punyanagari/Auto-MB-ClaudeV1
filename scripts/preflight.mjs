#!/usr/bin/env node
/**
 * Changed-surface preflight.
 *
 * `pnpm verify` is the honest gate and takes twenty minutes. Nobody runs it
 * before a first push, so the cheap gates — the ones that need no database,
 * no build and no browser — get discovered by CI ONE ROUND AT A TIME. Pull
 * request #164 spent five CI rounds learning, in sequence, that its
 * migration also had to satisfy the bootstrap privilege matrix, the
 * foreign-key index coverage, the migration contract, the audit-timeline
 * census, the error-remedies census and the write-loop census. Every one of
 * those answers was available on the developer's own machine in under two
 * minutes.
 *
 * This runs exactly the gates the CHANGED FILES can break:
 *
 *  - always: formatting, and the pure source-scan censuses. They read the
 *    tree and nothing else, so they are cheap regardless of what changed
 *    and one of them is always the thing that was forgotten;
 *  - when the schema moved: the standing database-shape censuses too. That
 *    set is #164's list, and it is triggered by migrations rather than run
 *    always because those suites want a live PostgreSQL.
 *
 * It is NOT a replacement for `pnpm verify` and does not try to be one:
 * lint, typecheck, build and the integration suites still belong to the
 * push. This is the "did I forget something structural" pass.
 *
 * Usage:
 *   pnpm preflight            # gates for the current diff vs origin/main
 *   pnpm preflight --all      # every gate, whatever changed
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const forceAll = process.argv.includes('--all');

/**
 * Files this branch changed, working tree included.
 *
 * The comparison point is the MERGE BASE with origin/main, not origin/main
 * itself: a branch that is simply behind main must not be told it changed
 * every file main moved since it forked. Diffing a commit (rather than
 * `--cached` or nothing) against the working tree is what makes committed
 * and uncommitted edits answer the same way, which matters because the
 * whole point is to run before the first push.
 *
 * Untracked-but-not-ignored files are added to that list. A brand-new
 * migration is untracked until it is staged, and it is precisely the file
 * whose arrival should turn the database gates on.
 */
function changedFiles() {
  const git = (args) =>
    execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
  let base;
  try {
    base = git(['merge-base', 'HEAD', 'origin/main']);
  } catch {
    console.error(
      'preflight: no origin/main to compare against. Run `git fetch origin`, ' +
        'or pass --all to run every gate.',
    );
    process.exit(1);
  }
  const lines = [
    ...git(['diff', '--name-only', base]).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard']).split('\n'),
  ];
  return [...new Set(lines.map((line) => line.trim()).filter((line) => line))];
}

/**
 * Whether the change touches database shape.
 *
 * Deliberately broad: a migration is the obvious case, but the privilege
 * matrix in `packages/db/src/bootstrap.ts` and the migration runner decide
 * the same shape by other means, and a `.sql` file anywhere is a schema
 * statement wherever it lives.
 */
function touchesSchema(files) {
  return files.some((file) => file.startsWith('packages/db/') || file.endsWith('.sql'));
}

const node = (script, ...args) => ({
  command: process.execPath,
  args: [path.join(repoRoot, 'scripts', script), ...args],
});

// pnpm is a .cmd on Windows, which spawn cannot execute without a shell.
// Only these gates get one: routing `process.execPath` through cmd breaks on
// the space in `C:\Program Files\nodejs`.
const pnpm = (...args) => ({
  command: 'pnpm',
  args,
  shell: process.platform === 'win32',
});

/** Gates whose input is the source tree and nothing else. */
const ALWAYS = [
  { label: 'format:check', ...pnpm('format:check') },
  { label: 'architecture census', ...node('check-architecture.mjs') },
  { label: 'config census', ...node('check-config.mjs') },
  { label: 'comment-reference census', ...node('check-comment-refs.mjs') },
  { label: 'test census (ratchet)', ...node('check-test-census.mjs') },
  { label: 'export-version sentinel', ...node('check-export-sentinel.mjs') },
];

/**
 * The gates a schema change keeps failing on, as one batch instead of one
 * CI round each. `migration-contract.test.ts` carries the SQLSTATE
 * uniqueness rule; `bootstrap.integration.test.ts` the privilege matrix;
 * `fk-index-coverage.integration.test.ts` the index coverage. The three
 * server censuses are here rather than in ALWAYS because a new table is
 * what makes them fail — a new entity with no timeline coverage, a new
 * SQLSTATE with no remedy, a new route writing inside a loop.
 *
 * The two integration files want a live PostgreSQL reachable through
 * DATABASE_ADMIN_URL. Somebody editing migrations has one.
 */
const ON_SCHEMA_CHANGE = [
  { label: 'migration file validation', ...pnpm('db:check') },
  {
    label: 'db shape censuses (contract, privilege matrix, FK indexes)',
    ...pnpm(
      '--filter',
      '@auto-mb/db',
      'exec',
      'vitest',
      'run',
      'test/migration-contract.test.ts',
      'test/bootstrap.integration.test.ts',
      'test/fk-index-coverage.integration.test.ts',
    ),
  },
  {
    label: 'server censuses (audit timeline, error remedies, write loops)',
    ...pnpm(
      '--filter',
      '@auto-mb/server',
      'exec',
      'vitest',
      'run',
      'test/audit-timeline-census.test.ts',
      'test/error-remedies.test.ts',
      'test/query-write-loop-census.test.ts',
    ),
  },
];

const files = forceAll ? [] : changedFiles();
const schema = forceAll || touchesSchema(files);
const gates = [...ALWAYS, ...(schema ? ON_SCHEMA_CHANGE : [])];

console.log(
  forceAll
    ? 'preflight: every gate (--all)'
    : `preflight: ${String(files.length)} changed file(s), ` +
        `${schema ? 'schema touched' : 'no schema change'}`,
);

const failures = [];
const startedAll = Date.now();
for (const gate of gates) {
  const started = Date.now();
  console.log(`\n--- ${gate.label}`);
  const spawnOptions = { cwd: repoRoot, stdio: 'inherit' };
  // Under a shell the command goes across as ONE string. Handing spawnSync a
  // separate argument array as well is what raises DEP0190, and every
  // argument here is a literal written above, so there is nothing to escape.
  const result = gate.shell
    ? spawnSync([gate.command, ...gate.args].join(' '), {
        ...spawnOptions,
        shell: true,
      })
    : spawnSync(gate.command, gate.args, spawnOptions);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`    ok (${seconds}s)`);
  } else {
    console.log(`    FAILED (${seconds}s)`);
    failures.push(gate.label);
  }
}

const total = ((Date.now() - startedAll) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`\npreflight failed in ${total}s: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\npreflight passed in ${total}s (${String(gates.length)} gates)`);
