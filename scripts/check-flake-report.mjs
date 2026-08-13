#!/usr/bin/env node
/**
 * Flake detector.
 *
 * CI runs every Vitest suite with `--retry=1 --reporter=json`. A retry that
 * turns a failure into a pass is invisible in the summary line — the run is
 * green and nobody learns that a test disagreed with itself twenty seconds
 * apart. This script reads the JSON reports and fails the job when any test
 * PASSED but recorded a failure along the way.
 *
 * The signal: Vitest's JSON reporter keeps `failureMessages` from the
 * discarded attempt while reporting `status: "passed"`. A test that passes
 * first time has no failure messages at all, so a passing test that carries
 * one can only have got there by retry.
 *
 * A flake is a defect. It is either a real race in the code under test, an
 * order dependency between suites, or a fixture that leaks state — all three
 * are worth a red build, because the alternative is a suite whose green
 * gradually stops meaning anything.
 *
 * Usage:
 *   node scripts/check-flake-report.mjs reports/*.json
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const reportPaths = process.argv.slice(2);

if (reportPaths.length === 0) {
  process.stderr.write(
    'usage: node scripts/check-flake-report.mjs <vitest-json-report>...\n',
  );
  process.exit(2);
}

/** First line of a stack, which is the assertion the retry swallowed. */
function firstLine(message) {
  return (message ?? '').split('\n')[0]?.trim() ?? '';
}

const flaky = [];
let inspected = 0;

for (const reportPath of reportPaths) {
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `flake detector could not read ${reportPath}: ${String(error)}\n`,
    );
    process.exit(2);
  }
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      inspected += 1;
      const failures = assertion.failureMessages ?? [];
      // `failed` results are the ordinary red build the reporter already
      // makes loud; only a PASS that hides a failure is this script's
      // business.
      if (assertion.status === 'failed' || failures.length === 0) continue;
      flaky.push({
        file: path.relative(process.cwd(), file.name ?? reportPath),
        name: assertion.fullName ?? assertion.title ?? '(unnamed)',
        attempts: failures.length + 1,
        firstFailure: firstLine(failures[0]),
      });
    }
  }
}

process.stdout.write(
  `flake detector: inspected ${String(inspected)} test results across ` +
    `${String(reportPaths.length)} report(s)\n`,
);

if (flaky.length > 0) {
  process.stderr.write(
    `\nflake detector FAILED: ${String(flaky.length)} test(s) passed only after a ` +
      'retry.\n\n',
  );
  for (const entry of flaky) {
    process.stderr.write(`  - ${entry.name}\n`);
    process.stderr.write(`    file:     ${entry.file}\n`);
    process.stderr.write(`    attempts: ${String(entry.attempts)}\n`);
    process.stderr.write(`    swallowed: ${entry.firstFailure}\n\n`);
  }
  process.stderr.write(
    'A test that disagrees with itself between two attempts is not passing; ' +
      'it is reporting a race, an order dependency, or leaked fixture state. ' +
      'Fix the cause rather than raising the retry count.\n',
  );
  process.exit(1);
}
