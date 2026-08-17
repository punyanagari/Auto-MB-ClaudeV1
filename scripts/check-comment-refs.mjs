#!/usr/bin/env node
// Comment-reference linter.
//
// The repository's comments carry an unusual amount of load: they name the
// migration a constant mirrors, the test that proves a claim, the route that
// enforces a rule. That only works while the names are true. Six of them had
// silently stopped being true by 2026-08-13 (a migration that never existed
// under that number, a module that was never created, tests that moved), and
// nothing noticed, because a comment cannot fail a build.
//
// This script makes it fail a build. It extracts the comments from every
// tracked source file, pulls out every repository-path-shaped reference, and
// requires each one to name a real file. A reference that carries a line
// number after a colon additionally has to point inside that file.
//
// Resolution is deliberately lenient about *where* a path is rooted: comments
// legitimately write `items.ts`, `routes/challans.ts` and
// `packages/db/migrations/0013_masters_profile.sql` for the same kind of
// thing. A reference resolves when it is the tail of at least one real path,
// so all three forms pass while a name that exists nowhere fails.
//
// Run: `node scripts/check-comment-refs.mjs` (part of `pnpm verify`).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files whose comments are scanned. */
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.sql',
]);

/**
 * Extensions a reference must end in to be treated as a repository path.
 * Anything else in a comment is prose, not a reference.
 */
const REFERENCE_EXTENSIONS = [
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'mjs',
  'cjs',
  'sql',
  'md',
  'css',
  'json',
  'yml',
  'yaml',
  'sh',
  'html',
  'toml',
];

// Longest first, so a JSON filename is not read as a JavaScript one with a
// stray `on` after it, and the extension must not run on into more word
// characters, so a digest name ending in `sha1` is not read as a shell script.
const EXTENSION_ALTERNATION = [...REFERENCE_EXTENSIONS]
  .sort((left, right) => right.length - left.length)
  .join('|');

// eslint-disable-next-line security/detect-non-literal-regexp -- the only interpolation is the constant extension list above, which holds no metacharacters
const REFERENCE_PATTERN = new RegExp(
  String.raw`(?:^|[\s(<'"\`\[|])(\.{0,2}\/?(?:[\w.@-]+\/)*[\w.@-]+\.(?:${EXTENSION_ALTERNATION}))(?![\w.-])(:(\d+))?`,
  'g',
);

/**
 * References that are real and intentional but name something outside the
 * repository, so path resolution cannot see them. Each entry states why.
 */
const ALLOWED_EXTERNAL = new Map([
  ['package.json', 'names the concept, not one file — every workspace has one'],
  ['tsconfig.json', 'names the concept, not one file'],
  ['node.js', 'the runtime, in prose'],
  ['index.js', 'ESM import specifiers rewritten from .ts are checked by the compiler'],
  ['postgres.js', 'the driver library, referred to by its published name'],
  [
    'installation-capture-flow.tsx',
    'a component of the v0 MOCK repository (punyanagari/Auto-MB-Vercel-du), which AGENTS.md makes the binding UI contract: a replication cites the file it replicates, and that file is deliberately not in this tree',
  ],
  [
    'measurement-book.tsx',
    'a component of the v0 MOCK repository (punyanagari/Auto-MB-Vercel-du) — same reason as installation-capture-flow.tsx above: the unbillable-variation-exposure panel cites the mock screen it replicates',
  ],
]);

/**
 * References that are stale and cannot be corrected, keyed `<file> <reference>`.
 *
 * Applied migrations are checksummed by `packages/db/src/migration-runner.ts`
 * and any edit — including to a comment — is rejected as drift by every
 * database that already ran them. Their comments are therefore sealed records
 * of the tree as it stood, and a name that has since moved stays written the
 * way it was. Migrations are still scanned, so a NEW migration cannot be
 * authored with a broken reference; only the specific already-applied ones
 * below are excused, each with the correction a reader needs.
 */
const FROZEN_STALE = new Map([
  [
    'packages/db/migrations/0052_tax_money_backstops.sql apps/server/src/routes/tax-invoices.ts',
    'that route file was split into the tax-invoices/ directory after 0052 was applied; the rules it names now live in apps/server/src/routes/tax-invoices/submit.ts',
  ],
]);

function listSourceFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Extracts comment text from JavaScript/TypeScript-family source. String and
 * template literals are skipped so that an error message quoting a filename
 * is not mistaken for a reference; regular-expression literals are recognised
 * by the token that precedes them, which is the standard heuristic and is
 * sufficient for this tree.
 */
function extractJsComments(source) {
  const comments = [];
  let index = 0;
  let line = 1;
  let previousSignificant = '';

  const push = (text, startLine) => comments.push({ text, line: startLine });

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '\n') {
      line += 1;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      push(source.slice(index + 2, stop), line);
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end;
      const text = source.slice(index + 2, stop);
      push(text, line);
      line += (text.match(/\n/g) ?? []).length;
      index = stop + 2;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      index += 1;
      while (index < source.length) {
        const stringChar = source[index];
        if (stringChar === '\\') {
          index += 2;
          continue;
        }
        if (stringChar === '\n') line += 1;
        if (stringChar === char) {
          index += 1;
          break;
        }
        index += 1;
      }
      previousSignificant = char;
      continue;
    }

    if (char === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]/.test(previousSignificant)) {
      // Regular-expression literal: consume to the unescaped closing slash,
      // honouring character classes so that `[/]` does not end it early.
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const regexChar = source[index];
        if (regexChar === '\\') {
          index += 2;
          continue;
        }
        if (regexChar === '\n') break;
        if (regexChar === '[') inClass = true;
        else if (regexChar === ']') inClass = false;
        else if (regexChar === '/' && !inClass) {
          index += 1;
          break;
        }
        index += 1;
      }
      previousSignificant = '/';
      continue;
    }

    if (!/\s/.test(char)) previousSignificant = char;
    index += 1;
  }

  return comments;
}

/** Extracts `-- …` and `/* … *\/` comments from SQL. */
function extractSqlComments(source) {
  const comments = [];
  const lines = source.split('\n');
  let inBlock = false;
  lines.forEach((text, offset) => {
    if (inBlock) {
      const end = text.indexOf('*/');
      comments.push({ text: end === -1 ? text : text.slice(0, end), line: offset + 1 });
      if (end !== -1) inBlock = false;
      return;
    }
    const lineComment = text.indexOf('--');
    const blockComment = text.indexOf('/*');
    if (blockComment !== -1 && (lineComment === -1 || blockComment < lineComment)) {
      const end = text.indexOf('*/', blockComment + 2);
      if (end === -1) {
        inBlock = true;
        comments.push({ text: text.slice(blockComment + 2), line: offset + 1 });
      } else {
        comments.push({ text: text.slice(blockComment + 2, end), line: offset + 1 });
      }
      return;
    }
    if (lineComment !== -1) {
      comments.push({ text: text.slice(lineComment + 2), line: offset + 1 });
    }
  });
  return comments;
}

function countLines(absolutePath) {
  const source = readFileSync(absolutePath, 'utf8');
  const total = source.split('\n').length;
  return source.endsWith('\n') ? total - 1 : total;
}

function main() {
  const trackedFiles = listSourceFiles();
  const trackedSet = new Set(trackedFiles);
  /** basename → every tracked path carrying it, for tail matching. */
  const byBasename = new Map();
  for (const file of trackedFiles) {
    const base = path.posix.basename(file);
    const bucket = byBasename.get(base);
    if (bucket) bucket.push(file);
    else byBasename.set(base, [file]);
  }

  const matchTail = (candidatePath) => {
    if (trackedSet.has(candidatePath)) return [candidatePath];
    const candidates = byBasename.get(path.posix.basename(candidatePath)) ?? [];
    return candidates.filter(
      (candidate) =>
        candidate === candidatePath || candidate.endsWith(`/${candidatePath}`),
    );
  };

  const resolveReference = (reference) => {
    const normalised = reference.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '');
    const direct = matchTail(normalised);
    if (direct.length > 0) return direct;
    // Node ESM import specifiers are written `.js` even where the source is
    // TypeScript, and comments quote the specifier. Accept the source file
    // the specifier compiles from.
    if (normalised.endsWith('.js')) {
      const stem = normalised.slice(0, -'.js'.length);
      for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
        const rewritten = matchTail(`${stem}${extension}`);
        if (rewritten.length > 0) return rewritten;
      }
    }
    return [];
  };

  const failures = [];
  const frozenHits = new Set();

  for (const file of trackedFiles) {
    const extension = path.extname(file);
    if (!SCANNED_EXTENSIONS.has(extension)) continue;
    const absolute = path.join(repoRoot, file);
    let source;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const comments =
      extension === '.sql' ? extractSqlComments(source) : extractJsComments(source);

    for (const comment of comments) {
      for (const match of comment.text.matchAll(REFERENCE_PATTERN)) {
        const reference = match[1];
        const lineNumber = match[3] === undefined ? null : Number(match[3]);
        if (ALLOWED_EXTERNAL.has(path.posix.basename(reference))) continue;
        // A bare `.` prefix like `.ts` or a version-ish token is not a path.
        if (!/[\w-]\.[a-z]+$/i.test(reference)) continue;
        // Absolute paths name the filesystem or a usage placeholder
        // (`/usr/bin/pdftotext`, `/path/to/dump.sql`), never a repository file.
        if (reference.startsWith('/')) continue;
        const frozenKey = `${file} ${reference}`;
        if (FROZEN_STALE.has(frozenKey)) {
          frozenHits.add(frozenKey);
          continue;
        }

        const matches = resolveReference(reference);
        if (matches.length === 0) {
          failures.push({
            file,
            line: comment.line,
            reference: match[0].trim(),
            reason: 'names no file in the repository',
          });
          continue;
        }
        if (lineNumber !== null) {
          const withinRange = matches.some(
            (candidate) => countLines(path.join(repoRoot, candidate)) >= lineNumber,
          );
          if (!withinRange) {
            failures.push({
              file,
              line: comment.line,
              reference: match[0].trim(),
              reason: `line ${lineNumber} is past the end of ${matches[0]}`,
            });
          }
        }
      }
    }
  }

  // A baseline nobody prunes stops being a baseline and becomes a blind spot,
  // so an entry that no longer matches anything is itself a failure.
  for (const key of FROZEN_STALE.keys()) {
    if (!frozenHits.has(key)) {
      const [file, ...rest] = key.split(' ');
      failures.push({
        file: 'scripts/check-comment-refs.mjs',
        line: 0,
        reference: rest.join(' '),
        reason: `FROZEN_STALE entry for ${file} matched nothing — delete it`,
      });
    }
  }

  if (failures.length > 0) {
    console.error(
      `check-comment-refs: ${failures.length} broken comment reference(s)\n`,
    );
    for (const failure of failures) {
      console.error(`  ${failure.file}:${failure.line}  ${failure.reference}`);
      console.error(`      ${failure.reason}`);
    }
    console.error(
      '\nA comment that names a file must name one that exists. Fix the reference,\n' +
        'or remove it if the thing it pointed at is gone.',
    );
    process.exit(1);
  }

  console.log('check-comment-refs: every comment file reference resolves');
}

main();
