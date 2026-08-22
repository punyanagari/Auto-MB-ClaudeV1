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
 *
 * RAISED TO 118,000 when wave D's notifications (0092) and spreadsheet
 * imports (0094) merged, which measured 115,010 together — eleven bytes
 * over the old line. Not a regression and not a dependency: both screens
 * are code-split and neither ships a byte of view code here (every lazy
 * view has a chunk of its own). What lands in the entry chunk is the
 * WIRING each screen needs to exist at all — its api-client methods, its
 * rail entry, its route arm, its status words — and four packs wiring
 * four screens into one shell is what that wave was.
 *
 * The number was set with room for the packs still to land, so they do
 * not each edit this line, and THE OFFLINE PACK IS SPENDING THAT ROOM
 * RATHER THAN RAISING THE LINE. Its connectivity hooks, read cache and
 * offline banner are shell furniture and have to be in the initial
 * payload, because the screen they explain is the one shown when nothing
 * else can load; they cost 1,461 bytes gzip, measured at 117,783 here
 * against 116,322 on `main` at 243e558. That is 217 bytes under the
 * ratchet — tight, and deliberately not answered by moving the line. The
 * service worker itself is a separate file the browser never blocks on.
 * The 36 kB the first cut of this pack cost — the shell reaching into
 * `src/format.ts` and dragging the contracts runtime with it — was
 * removed rather than absorbed (`src/format-instant.ts`).
 *
 * RAISED TO 119,000 when the purchase-order register (0109) took the rail
 * to twenty-eight modules. Measured at 118.19 kB gzip here, against the
 * 117,783 the offline pack recorded above: about four hundred bytes for a
 * rail entry, its `ShoppingCart` lamp, one arm each in the route
 * serialiser, the parser, the module map and the title map, and one
 * `React.lazy` import. The room the previous raise left was spent by the
 * offline pack, which said so; this is the same kind of cost with no room
 * left to spend, so the line moves rather than the rule bending. The view
 * itself is NOT in the initial payload — the second assertion in this
 * file proves it has a chunk of its own, as all fifty do — and no
 * dependency was added.
 *
 * RAISED TO 119,200 when the Tally ledger census (0118) took the rail to
 * twenty-nine modules. THE CENSUS IS THE SMALLER HALF OF THIS RISE and
 * the number should say which half is whose:
 *
 *   119.00  the line the purchase-order register left
 *   119.04  measured on this branch alone, before merging — so the
 *           census itself costs about FORTY BYTES: a rail entry, its
 *           `BookText` lamp, one arm each in the route serialiser, the
 *           parser, the module map and the title map, two api-client
 *           methods, and one `React.lazy` import. That is the smallest
 *           shape a new module has.
 *   119.15  measured after merging #164 and #166, which landed while
 *           this wave was in flight and account for the other ~110
 *           bytes. Neither moved this line, so it had to move once for
 *           all three rather than three times.
 *
 * The view itself is NOT in the initial payload: the second assertion in
 * this file proves it has a chunk of its own, as all fifty-two do, and no
 * dependency was added.
 *
 * RAISED TO 119,250 by the works-analysis reports, and this is the
 * smallest raise in the file's history for the smallest reason: the pack
 * adds NO rail entry, NO route variant and NO lazy import, because its
 * three reports live on the Reports screen the management summary already
 * has. What crossed the line is five api-client methods — the four reads
 * and the one document download. Which half is whose, as the raise above
 * this one records for its own wave:
 *
 *   119,200  the line the Tally ledger census left
 *   119,230  measured on this branch before merging, so the pack itself
 *            costs about THIRTY BYTES — five api-client methods and
 *            nothing else, which is smaller than the forty a new module
 *            costs precisely because this one is not a new module
 *   119,232  measured after merging #173, which landed while this wave
 *            was in flight and did not move this line
 *
 * The reports themselves are NOT in the initial payload: they are a
 * component of `views/Mis.tsx`, which has a chunk of its own, and the
 * second assertion in this file proves all fifty-two views still do. No
 * dependency was added.
 *
 * Lower it when a pack takes the number down; the rule against raising it
 * to accommodate a REGRESSION is untouched.
 */
const INITIAL_JS_GZIP_RATCHET_BYTES = 119_250;

/**
 * The views `views/OperationsWorkspace.tsx` loads through `React.lazy`.
 * Each must appear as its own chunk, and none may be part of the initial
 * payload. Rolldown names a chunk after the module that heads it, so
 * `ChallanDetail.tsx` becomes `assets/ChallanDetail-<hash>.js`.
 *
 * READ OFF THAT FILE rather than restated here. A hand-kept copy of this
 * list only ever guards the views someone remembered to add to it, and
 * the last one drifted twenty-two views behind the source before anybody
 * noticed — which is the failure mode of a list whose whole job is to be
 * complete. Two `lazy` calls may name the same module (the two
 * correspondence composers do), so the specifiers are deduplicated.
 */
const workspaceSource = readFileSync(
  join(webRoot, 'src', 'views', 'OperationsWorkspace.tsx'),
  'utf8',
);
const LAZY_VIEWS = [
  ...new Set(
    [...workspaceSource.matchAll(/\bimport\('\.\/([A-Za-z0-9_]+)\.js'\)/g)].map(
      (match) => match[1],
    ),
  ),
].sort();
if (LAZY_VIEWS.length === 0) {
  fail(
    'no lazy(...) imports found in views/OperationsWorkspace.tsx — the view ' +
      'guard below would pass vacuously.',
  );
}

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
