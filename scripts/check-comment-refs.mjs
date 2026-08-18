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
import ts from 'typescript';

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
 *
 * Matched on the BASENAME, which is only safe for a basename that could
 * mean one thing. A framework-generic one — a Next route file, an index
 * module, a route handler — must not be listed here: exempting it would
 * exempt every future comment naming any file of that name anywhere,
 * including a real one that had been moved or deleted. The v0-mock rule
 * below covers those by the shape of their path instead.
 */
const ALLOWED_EXTERNAL = new Map([
  ['package.json', 'names the concept, not one file — every workspace has one'],
  ['tsconfig.json', 'names the concept, not one file'],
  ['node.js', 'the runtime, in prose'],
  ['index.js', 'ESM import specifiers rewritten from .ts are checked by the compiler'],
  ['postgres.js', 'the driver library, referred to by its published name'],
]);

/**
 * Roots that only the v0 MOCK repository (punyanagari/Auto-MB-Vercel-du)
 * has. AGENTS.md makes the mock the binding UI contract, so a replication
 * cites the screen or component it replicates, and the mock is
 * deliberately not in this tree — around forty such citations exist and
 * every new screen adds more.
 *
 * The mock is a Next App Router project: its screens are route files under
 * `app/` and its components live under `components/`. NO path in this
 * repository has an `app/` or `components/` segment (the web tree is
 * `apps/web/src/{ui,views,lib}`), so a `.ts`/`.tsx` reference rooted at
 * either that resolves nowhere here can only be a mock citation. It needs
 * no entry, and gets none — write the mock's own path and the rule covers
 * it, including every screen a later pack replicates.
 */
const V0_MOCK_ROOTS = ['app/', 'components/'];

/**
 * The mock files cited by BARE basename, plus its seed-data module, which
 * the rule above cannot reach.
 *
 * Shape alone cannot tell these from this repository's own files: `lib/`
 * does exist here, and so do kebab-case `.tsx` components
 * (`schedule-section.tsx`, `signature-panel.tsx`, `date-field.tsx`).
 * Exempting the shape would mean a comment could keep naming one of those
 * for ever after it was deleted, which is the whole failure this gate
 * exists to catch. So these stay written down, matched as a path suffix.
 *
 * Prefer the mock's real path in new comments — `components/nit-intake.tsx`
 * over `nit-intake.tsx` — and nothing needs adding here.
 */
const V0_MOCK_FILES = [
  'app-sidebar.tsx',
  'company-document-library.tsx',
  'inspection-checklist-config.tsx',
  'inspection-lifecycle-workspace.tsx',
  'installation-capture-flow.tsx',
  'lib/data.ts',
  'measurement-book.tsx',
  'nit-intake.tsx',
  'payment-requests-workspace.tsx',
  'production-job-card-page.tsx',
  'railway-receivables-workspace.tsx',
  'tender-dashboard.tsx',
  'tender-workspace.tsx',
  'work-controls.tsx',
  'work-inspection-mapping.tsx',
  'work-registers.tsx',
  'work-section-nav.tsx',
];

/** Whether a reference names something deliberately outside this tree. */
function isAllowedExternal(reference) {
  return ALLOWED_EXTERNAL.has(path.posix.basename(reference));
}

/**
 * Whether a reference that resolved NOWHERE is a citation of the v0 mock.
 *
 * Consulted only after resolution has already failed, so a mock-shaped
 * name that does name a file here is still checked as a repository path
 * — the exemption can never shadow a real one.
 */
function isV0MockCitation(reference) {
  if (!/\.tsx?$/.test(reference)) return false;
  if (V0_MOCK_ROOTS.some((root) => reference.startsWith(root))) return true;
  return V0_MOCK_FILES.some(
    (name) => reference === name || reference.endsWith(`/${name}`),
  );
}

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
 * Extracts comment text from JavaScript/TypeScript-family source, with the
 * `//` or `/* … *\/` delimiters removed and the 1-based line the comment
 * starts on.
 *
 * TypeScript's own parser does the lexing. Nothing else in reach reads
 * JavaScript correctly enough for this: an error message quoting a filename
 * must not read as a reference, which means strings and template literals
 * have to be skipped, and a regular-expression literal containing `//` must
 * not open a comment, which means the division-versus-regex ambiguity has to
 * be settled by a real parse rather than by the preceding character.
 *
 * Every comment is trivia of exactly one token — including the end-of-file
 * token — so walking to the leaves and reading each token's trivia yields
 * every comment. BOTH range kinds are needed: TypeScript calls a comment
 * that shares a line with the token before it a TRAILING range and one that
 * follows a newline a LEADING range, so reading only leading ranges silently
 * drops every `value, // note` in the tree. They are collected against their
 * source offset, which also de-duplicates the one position where the two
 * agree (a comment at the very start of a file).
 */
function extractJsComments(source, fileName) {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const byOffset = new Map();
  const visit = (node) => {
    const children = node.getChildren(parsed);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    const at = node.getFullStart();
    const ranges = [
      ...(ts.getLeadingCommentRanges(source, at) ?? []),
      ...(ts.getTrailingCommentRanges(source, at) ?? []),
    ];
    for (const range of ranges) {
      const block = range.kind === ts.SyntaxKind.MultiLineCommentTrivia;
      byOffset.set(range.pos, {
        // `range.end` for a block comment is past its `*/`; for a line
        // comment it is the newline, which is not part of the text.
        text: source.slice(range.pos + 2, block ? range.end - 2 : range.end),
        line: parsed.getLineAndCharacterOfPosition(range.pos).line + 1,
      });
    }
  };
  visit(parsed);
  return [...byOffset.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, comment]) => comment);
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
      extension === '.sql'
        ? extractSqlComments(source)
        : extractJsComments(source, file);

    for (const comment of comments) {
      for (const match of comment.text.matchAll(REFERENCE_PATTERN)) {
        const reference = match[1];
        const lineNumber = match[3] === undefined ? null : Number(match[3]);
        if (isAllowedExternal(reference)) continue;
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
          if (isV0MockCitation(reference)) continue;
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
