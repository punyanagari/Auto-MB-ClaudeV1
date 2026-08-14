#!/usr/bin/env node
/**
 * Front-end bundle budget.
 *
 * Two things are asserted about a built `apps/web/dist`, both measured
 * rather than argued:
 *
 * 1. The INITIAL JavaScript payload — the entry module plus every chunk
 *    Vite tells the browser to preload alongside it — stays inside a gzip
 *    ratchet. That is what a clerk downloads and parses before the first
 *    screen can paint, and the number the improvement programme set a
 *    budget for (pack P10, dimension 35).
 *
 * 2. Each code-split view is still its own chunk and is still absent from
 *    that initial payload. A single static `import { Works } from
 *    './Works.js'` re-added to `views/OperationsWorkspace.tsx` collapses
 *    a view back into the entry chunk, and this names the view rather
 *    than leaving a byte count to be interpreted.
 *
 * Run after `pnpm --filter @auto-mb/web build`; `pnpm verify` does both in
 * order. Reads the built `index.html` rather than a Vite manifest so the
 * measurement is of exactly what is served.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(webRoot, 'dist');
const assetsDir = join(distDir, 'assets');

/**
 * The improvement programme's budget for the initial JavaScript payload
 * (pack P10): 220 kB gzip, in the decimal kB Vite's own build report
 * uses. On `main` @ a15449b, before the views were code-split, the whole
 * application was one chunk measuring 220,743 bytes gzip — 743 bytes over
 * this line, which is what makes it a budget the pre-fix tree fails
 * rather than one it happens to meet.
 */
const INITIAL_JS_GZIP_BUDGET_BYTES = 220_000;

/**
 * The ratchet actually asserted on, which is where the payload sits now
 * plus a little room for ordinary drift. Lower it when a pack takes the
 * number down; never raise it to accommodate a regression, and never
 * above the budget above.
 *
 * It exists because 220 kB is a ceiling with a hundred kilobytes of slack
 * beneath it: without a ratchet a new dependency could double the initial
 * payload and still pass. Measured at 103,192 bytes gzip when this was
 * written.
 */
const INITIAL_JS_GZIP_RATCHET_BYTES = 115_000;

/**
 * The views `views/OperationsWorkspace.tsx` loads through `React.lazy`.
 * Each must appear as its own chunk, and none may be part of the initial
 * payload. Rolldown names a chunk after the module that heads it, so
 * `ChallanDetail.tsx` becomes `assets/ChallanDetail-<hash>.js`.
 *
 * Keep this list in step with the `lazy(...)` block in that file: a view
 * added there and not here is simply unguarded, and a view removed from
 * there fails here by name.
 */
const LAZY_VIEWS = [
  'AccountSecurity',
  'AppearanceSettings',
  'Approvals',
  'ChallanDetail',
  'ChallanEditor',
  'DeliveryChallans',
  'InstallationsRegister',
  'IssueChallanDetail',
  'IssueChallanEditor',
  'Masters',
  'Members',
  'OperationsDashboard',
  'OrganisationAccessSettings',
  'Quotations',
  'ReviewLoa',
  'Search',
  'SerialLookup',
  'Settings',
  'UploadLoa',
  'WorkDetail',
  'Works',
];

function fail(message) {
  process.stderr.write(`bundle budget: ${message}\n`);
  process.exit(1);
}

/** Decimal kB, matching Vite's own build report so the two numbers can be
 * compared without conversion. */
function kb(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`;
}

let html;
try {
  html = readFileSync(join(distDir, 'index.html'), 'utf8');
} catch {
  fail(
    `no built bundle at ${distDir}. Run \`pnpm --filter @auto-mb/web build\` first.`,
  );
}

/* The entry script, then the chunks the browser is told to fetch with it.
 * Vite emits a `modulepreload` link for every chunk statically reachable
 * from the entry, which is precisely the initial payload; a lazily
 * imported chunk gets no link. */
const entry = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
if (entry === undefined) fail('the built index.html declares no module entry script.');

const preloaded = [
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
]
  .map((match) => match[1])
  .filter((href) => href.endsWith('.js'));

const initial = [entry, ...preloaded];

let total = 0;
const report = [];
for (const href of initial) {
  const file = join(distDir, href.replace(/^\//, ''));
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    fail(`index.html references ${href}, which is not in the build output.`);
  }
  const gzipped = gzipSync(bytes).byteLength;
  total += gzipped;
  report.push(`  ${href}  ${kb(bytes.byteLength)} raw, ${kb(gzipped)} gzip`);
}

/* The view chunks, checked by name. `readdirSync` once: the assertion is
 * "a chunk headed by this module exists", not "a file with this exact
 * hash exists", because the hash changes on every content edit. */
let assets;
try {
  assets = readdirSync(assetsDir);
} catch {
  fail(`no assets directory at ${assetsDir}.`);
}

const initialFiles = new Set(initial.map((href) => href.replace(/^\/assets\//, '')));
const missing = [];
const inlined = [];
for (const view of LAZY_VIEWS) {
  const chunk = assets.find(
    (name) => name.startsWith(`${view}-`) && name.endsWith('.js'),
  );
  if (chunk === undefined) {
    missing.push(view);
    continue;
  }
  if (initialFiles.has(chunk)) inlined.push(view);
}

process.stdout.write(
  `Initial JavaScript payload (${String(initial.length)} chunks):\n`,
);
process.stdout.write(`${report.join('\n')}\n`);
process.stdout.write(
  `  total ${kb(total)} gzip — ratchet ${kb(INITIAL_JS_GZIP_RATCHET_BYTES)}, ` +
    `programme budget ${kb(INITIAL_JS_GZIP_BUDGET_BYTES)}\n`,
);
process.stdout.write(
  `Code-split views: ${String(LAZY_VIEWS.length - missing.length)} of ` +
    `${String(LAZY_VIEWS.length)} have a chunk of their own.\n`,
);

if (missing.length > 0) {
  fail(
    `these views have no chunk of their own, so they were bundled into another ` +
      `chunk — check the lazy(...) block in views/OperationsWorkspace.tsx for a ` +
      `static import that crept back in: ${missing.join(', ')}`,
  );
}

if (inlined.length > 0) {
  fail(
    `these views are part of the initial payload and should be loaded on ` +
      `demand: ${inlined.join(', ')}`,
  );
}

if (INITIAL_JS_GZIP_RATCHET_BYTES > INITIAL_JS_GZIP_BUDGET_BYTES) {
  fail(
    `the ratchet (${kb(INITIAL_JS_GZIP_RATCHET_BYTES)}) has been raised above the ` +
      `programme's budget (${kb(INITIAL_JS_GZIP_BUDGET_BYTES)}). Take the payload ` +
      'down rather than the line.',
  );
}

if (total > INITIAL_JS_GZIP_RATCHET_BYTES) {
  fail(
    `the initial JavaScript payload is ${kb(total)} gzip, over the ` +
      `${kb(INITIAL_JS_GZIP_RATCHET_BYTES)} ratchet by ` +
      `${kb(total - INITIAL_JS_GZIP_RATCHET_BYTES)}.`,
  );
}
