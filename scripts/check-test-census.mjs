#!/usr/bin/env node
/**
 * Test census with a ratchet.
 *
 * Two properties are enforced, both cheaply and without a database, so the
 * check can run on every pull request beside lint and typecheck:
 *
 *  1. **Counts may only rise.** `scripts/test-census.json` records, per
 *     tracked test file, how many tests that file declares. A file that
 *     loses a test, or disappears entirely, fails the check. Files may gain
 *     tests freely and new files may appear freely — the baseline is a
 *     floor, not an equality. Per-FILE granularity is deliberate: a
 *     per-package floor lets a pull request delete a suite and hide it
 *     behind unrelated additions made in the same package.
 *
 *  2. **Skipped tests need a stated reason.** Any `it.skip`, `test.skip`,
 *     `describe.skip`, `.todo` or `.fails` declaration must carry a
 *     `skip-reason:` comment on its own line or in the comment block
 *     immediately above it. A suite silently switched off is a suite nobody
 *     is accountable for turning back on.
 *
 * The census counts DECLARATION SITES, not executed cases: `it.each([...])`
 * counts once however many rows it expands to. That keeps the number a
 * property of the source, computable without running anything, and immune
 * to a database being absent. The executed count is what `pnpm test` prints.
 *
 * Usage:
 *   node scripts/check-test-census.mjs            # verify against baseline
 *   node scripts/check-test-census.mjs --update   # rewrite the baseline
 *   node scripts/check-test-census.mjs --json     # machine-readable census
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const baselinePath = path.join(here, 'test-census.json');

/** Marker a skipped declaration must carry, in a comment. */
const SKIP_REASON_MARKER = 'skip-reason:';

/** How many lines above a declaration are searched for the reason. */
const REASON_LOOKBEHIND = 6;

/**
 * Files that declare tests, as git sees them: everything tracked plus
 * anything untracked that is not ignored. Asking git rather than walking
 * the tree keeps build output and local scratch directories out of the
 * count, while still seeing a brand-new test file before it is committed.
 */
function testFiles() {
  const stdout = execFileSync(
    'git',
    [
      '-C',
      repoRoot,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      '*.test.ts',
      '*.test.tsx',
      '*.test.js',
      '*.test.mjs',
      '*.spec.ts',
      '*.spec.tsx',
      '*.spec.js',
      '*.spec.mjs',
    ],
    { encoding: 'utf8' },
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('docs/reference/'))
    .sort();
}

/**
 * Replaces every comment and string literal with spaces, preserving line and
 * column positions. Counting `it(` on raw source would count commented-out
 * suites and test names that quote the word; counting on the stripped source
 * counts only real declarations.
 *
 * Returns `{ code, comments }` — `comments` keeps the original text of each
 * comment against its line number, so the skip-reason search can read them.
 *
 * Hand-rolled ON PURPOSE, unlike scripts/check-comment-refs.mjs, which reads
 * its comments off `typescript`'s parser. This script is the whole of
 * .github/workflows/census.yml, and that job deliberately runs with NOTHING
 * installed — checkout, Node, one script — which is what lets it run on every
 * pull request including the documentation-only ones ci.yml skips. Importing
 * a parser out of node_modules would put a workspace install into the one job
 * built to avoid it. Reach for a scanner fix here, never a dependency.
 */
function stripSourceText(source) {
  const out = new Array(source.length);
  const comments = new Map();
  let i = 0;
  // Template-literal nesting: each entry is the brace depth at which the
  // enclosing `${` interpolation started.
  const templateStack = [];
  let braceDepth = 0;
  // The last non-whitespace character of real code, which is how a leading
  // `/` is told apart from a division. Comments deliberately do not move it:
  // `const re = // why\n /'x'/` is still a regular expression.
  let previousSignificant = '';

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      out[k] = source[k] === '\n' ? '\n' : ' ';
    }
  };
  const lineOf = (index) => {
    let line = 1;
    for (let k = 0; k < index; k += 1) if (source[k] === '\n') line += 1;
    return line;
  };
  const recordComment = (from, to) => {
    const text = source.slice(from, to);
    const startLine = lineOf(from);
    text.split('\n').forEach((chunk, offset) => {
      const line = startLine + offset;
      comments.set(line, `${comments.get(line) ?? ''} ${chunk}`);
    });
  };

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      recordComment(i, end);
      blank(i, end);
      i = end;
      continue;
    }
    if (two === '/*') {
      let end = source.indexOf('*/', i + 2);
      end = end === -1 ? source.length : end + 2;
      recordComment(i, end);
      blank(i, end);
      i = end;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      let k = i + 1;
      while (k < source.length && source[k] !== ch) {
        if (source[k] === '\\') k += 1;
        if (source[k] === '\n') break;
        k += 1;
      }
      blank(i, Math.min(k + 1, source.length));
      i = k + 1;
      previousSignificant = ch;
      continue;
    }
    // A regular-expression literal, which must be blanked like any other
    // literal and for a sharper reason: an unblanked `/'[a-z_]+'/` hands its
    // quote to the string branch above, which then blanks every line of live
    // code after it and takes that file's whole test count to zero. Two files
    // were being lost that way. Comment openers are matched before this, so
    // `//` and `/*` never reach it — neither is a legal regular expression.
    if (ch === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]/.test(previousSignificant)) {
      const start = i;
      i += 1;
      // Character classes are tracked so that `[/]` does not close it early.
      let inClass = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          i += 1;
          break;
        }
        i += 1;
      }
      blank(start, Math.min(i, source.length));
      previousSignificant = '/';
      continue;
    }
    if (ch === '`') {
      templateStack.push(braceDepth);
      out[i] = ' ';
      i += 1;
      // Blank the literal chunks; `${ ... }` interpolations stay live code.
      while (i < source.length && templateStack.length > 0) {
        if (source[i] === '\\') {
          blank(i, i + 2);
          i += 2;
          continue;
        }
        if (source[i] === '`') {
          templateStack.pop();
          out[i] = ' ';
          i += 1;
          break;
        }
        if (source.slice(i, i + 2) === '${') {
          blank(i, i + 2);
          i += 2;
          braceDepth += 1;
          // Hand control back to the main loop until the brace closes.
          const target = braceDepth;
          while (i < source.length && braceDepth >= target) {
            const c = source[i];
            if (c === '{') braceDepth += 1;
            else if (c === '}') braceDepth -= 1;
            if (braceDepth < target) {
              out[i] = ' ';
              i += 1;
              break;
            }
            out[i] = c;
            i += 1;
          }
          continue;
        }
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      previousSignificant = '`';
      continue;
    }
    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth -= 1;
    if (!/\s/.test(ch)) previousSignificant = ch;
    out[i] = ch;
    i += 1;
  }
  return { code: out.join(''), comments };
}

/**
 * The bare declaration keywords. The modifier chain after them is walked
 * character by character rather than matched with a nested quantifier: a
 * pattern of the shape `(?:\.\w+)*` is a backtracking hazard on arbitrary
 * source, and the loop is both safer and easier to read.
 */
const KEYWORD_RE = /(?<![$\w.])(it|test|describe|suite)(?![$\w])/g;

/** Modifier chains that take a table before the name, `it.each([...])`. */
const TABLE_MODIFIERS = new Set(['each', 'for']);

/**
 * Reads the `.modifier` chain that follows a keyword and confirms the
 * result is actually being CALLED. Returns the modifiers, or null when the
 * keyword was a bare identifier (an import, a property name, a variable).
 */
function readModifierChain(code, afterKeyword) {
  const isSpace = (char) =>
    char === ' ' || char === '\n' || char === '\r' || char === '\t';
  let index = afterKeyword;
  const modifiers = [];
  for (;;) {
    while (index < code.length && isSpace(code[index])) index += 1;
    if (code[index] !== '.') break;
    index += 1;
    while (index < code.length && isSpace(code[index])) index += 1;
    let end = index;
    while (end < code.length && /[A-Za-z]/.test(code[end])) end += 1;
    if (end === index) return null;
    modifiers.push(code.slice(index, end));
    index = end;
  }
  while (index < code.length && isSpace(code[index])) index += 1;
  const next = code[index];
  if (next === '(' || next === '[') return modifiers;
  // `it.each` may be tagged with a template literal, whose backticks this
  // script has already blanked; the chain itself is proof enough.
  const last = modifiers[modifiers.length - 1];
  if (last !== undefined && TABLE_MODIFIERS.has(last)) return modifiers;
  return null;
}

/** Modifiers that switch a declaration off rather than run it. */
const SKIPPING_MODIFIERS = new Set(['skip', 'todo', 'skipIf', 'runIf', 'fails']);

function censusOfFile(relativePath) {
  const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const { code, comments } = stripSourceText(source);
  const lineStarts = [0];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const sourceLines = source.split('\n');

  let tests = 0;
  const skipped = [];
  for (const match of code.matchAll(KEYWORD_RE)) {
    const keyword = match[1] ?? '';
    const modifiers = readModifierChain(code, match.index + keyword.length);
    if (modifiers === null) continue;
    const chain = modifiers.map((modifier) => `.${modifier}`).join('');
    const isSuite = keyword === 'describe' || keyword === 'suite';
    const skips = modifiers.some((modifier) => SKIPPING_MODIFIERS.has(modifier));
    if (!isSuite && !skips) tests += 1;
    if (!skips) continue;
    const line = lineOf(match.index);
    skipped.push({
      location: `${relativePath}:${line}`,
      declaration: `${keyword}${chain}`,
      reason: reasonFor(sourceLines, comments, line),
    });
  }
  return { tests, skipped };
}

/**
 * Reads the `skip-reason:` note attached to a declaration, if any. The note
 * may sit on the declaration's own line or in the comment block immediately
 * above it; the search stops at the first line of unrelated code, so a
 * reason cannot be borrowed from somewhere else in the file.
 */
function reasonFor(sourceLines, comments, line) {
  for (
    let candidate = line;
    candidate >= 1 && candidate > line - REASON_LOOKBEHIND;
    candidate -= 1
  ) {
    const text = comments.get(candidate) ?? '';
    const marker = text.toLowerCase().indexOf(SKIP_REASON_MARKER);
    if (marker !== -1) {
      // The note may wrap over the rest of the comment block; everything
      // between the marker and the declaration is part of the reason,
      // because the walk above already proved those lines carry no code.
      let full = text.slice(marker + SKIP_REASON_MARKER.length);
      for (let rest = candidate + 1; rest < line; rest += 1) {
        full += ` ${comments.get(rest) ?? ''}`;
      }
      return full.replace(/[*/]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (candidate === line) continue;
    const raw = (sourceLines[candidate - 1] ?? '').trim();
    if (raw.length > 0 && text.trim().length === 0) break;
  }
  return null;
}

function buildCensus() {
  const files = {};
  const skipped = [];
  let total = 0;
  for (const file of testFiles()) {
    const result = censusOfFile(file);
    files[file] = result.tests;
    total += result.tests;
    skipped.push(...result.skipped);
  }
  return { files, skipped, total };
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeBaseline(census) {
  const payload = {
    $comment:
      'Ratchet floor for scripts/check-test-census.mjs. Counts are DECLARATION ' +
      'SITES per tracked test file and may only rise; regenerate with ' +
      '`node scripts/check-test-census.mjs --update` when a file is renamed or ' +
      'a suite is deliberately retired, and say why in the pull request.',
    totalDeclarations: census.total,
    fileCount: Object.keys(census.files).length,
    files: census.files,
  };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const census = buildCensus();

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
    return;
  }

  if (args.includes('--update')) {
    writeBaseline(census);
    process.stdout.write(
      `test census baseline updated: ${String(census.total)} declarations across ` +
        `${String(Object.keys(census.files).length)} files\n`,
    );
    return;
  }

  const failures = [];
  const baseline = readBaseline();
  if (baseline === null) {
    failures.push(
      `no baseline at ${path.relative(repoRoot, baselinePath)} — create it with ` +
        '`node scripts/check-test-census.mjs --update`',
    );
  } else {
    for (const [file, floor] of Object.entries(baseline.files)) {
      const current = census.files[file];
      if (current === undefined) {
        failures.push(
          `${file}: test file removed (baseline declared ${String(floor)} tests). ` +
            'If the removal is intentional, say so in the pull request and rerun ' +
            'with --update.',
        );
        continue;
      }
      if (current < floor) {
        failures.push(
          `${file}: ${String(current)} test declarations, baseline floor is ` +
            `${String(floor)} (${String(floor - current)} removed). Test counts may ` +
            'only rise.',
        );
      }
    }
  }

  const unexplained = census.skipped.filter((entry) => entry.reason === null);
  for (const entry of unexplained) {
    failures.push(
      `${entry.location}: ${entry.declaration} is switched off with no stated ` +
        `reason. Add a comment containing "${SKIP_REASON_MARKER} <why, and what ` +
        'turns it back on>" on the declaration or immediately above it.',
    );
  }

  const explained = census.skipped.filter((entry) => entry.reason !== null);
  process.stdout.write(
    `test census: ${String(census.total)} declarations across ` +
      `${String(Object.keys(census.files).length)} files; ` +
      `${String(census.skipped.length)} switched off ` +
      `(${String(explained.length)} with a stated reason)\n`,
  );
  for (const entry of explained) {
    process.stdout.write(`  off: ${entry.location} — ${entry.reason}\n`);
  }

  if (baseline !== null) {
    const gained = Object.entries(census.files).filter(
      ([file, count]) => (baseline.files[file] ?? 0) < count,
    ).length;
    if (gained > 0) {
      process.stdout.write(
        `${String(gained)} file(s) above the baseline floor; run ` +
          '`node scripts/check-test-census.mjs --update` to tighten the ratchet.\n',
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write('\ntest census check FAILED:\n');
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exitCode = 1;
  }
}

main();
