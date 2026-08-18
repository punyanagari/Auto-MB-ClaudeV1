/**
 * Build-time guard for deploy/Dockerfile.server.
 *
 * The production image ships esbuild bundles rather than the workspace
 * source, and the bundler is told which packages to leave as real
 * `import` statements (`--external:`). That list has to match two things
 * at once: the bundle's imports must all resolve from the pruned,
 * production-only `node_modules` the runtime stage inherits, and nothing
 * that was meant to be inlined may have leaked out as an import.
 *
 * A mismatch is invisible until the container boots on the production
 * host with `ERR_MODULE_NOT_FOUND`. This turns it into a build failure.
 *
 * Run it against the bundles in the directory they will occupy at
 * runtime — see the invocation in deploy/Dockerfile.server. Resolution is
 * done with a `require` rooted AT THE BUNDLE, rather than through
 * `import.meta.resolve`, which would resolve relative to THIS file and so
 * answer for the wrong directory.
 */
import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';

const bundles = process.argv.slice(2);
if (bundles.length === 0) {
  console.error('usage: check-bundle-externals.mjs <bundle.mjs> [...]');
  process.exit(1);
}

/**
 * Every specifier esbuild left as a real import.
 *
 * They are NOT all at the top of the file: esbuild emits its CommonJS
 * interop preamble first and then interleaves the retained imports with the
 * bundled module sections. What is reliable is the column: an ESM `import`
 * declaration is a top-level statement, and esbuild writes it starting at
 * column 0, while bundled program text is indented inside a function body.
 * So a statement begins at a line start and runs to the closing quote of
 * its specifier, which is the last quoted string on the statement's last
 * line — true of `import x from "spec"` and of a bare `import "spec"`.
 *
 * `[^;]` rather than `[\s\S]` bounds the span: an import declaration holds
 * no semicolon before its specifier, so a line that merely BEGINS with the
 * word `import` — one buried at column 0 inside a bundled template literal
 * — cannot swallow the rest of the file looking for a quote.
 */
const IMPORT_STATEMENT = /^import[^;]*?["']([^"'\n]+)["'];?$/gm;

const importedSpecifiers = (source) =>
  new Set([...source.matchAll(IMPORT_STATEMENT)].map((match) => match[1]));

/**
 * Node's own lookup, rooted at the bundle: `createRequire` walks
 * `node_modules` upwards from the file it is given, which is precisely the
 * search the runtime will perform.
 */
function installed(specifier, bundlePath) {
  try {
    createRequire(bundlePath).resolve(specifier);
    return true;
  } catch (error) {
    // Only MODULE_NOT_FOUND means absent. A package that is present but
    // publishes no CommonJS entry point refuses with a different code
    // (ERR_PACKAGE_PATH_NOT_EXPORTED and friends) — it is installed, and
    // the ESM import in the bundle will reach it.
    return error.code !== 'MODULE_NOT_FOUND';
  }
}

let failed = false;

for (const bundle of bundles) {
  const absolute = path.resolve(bundle);
  const directory = path.dirname(absolute);
  const source = await readFile(absolute, 'utf8');
  const specifiers = importedSpecifiers(source);

  const resolved = [];
  for (const specifier of specifiers) {
    // `isBuiltin` rather than a `node:` prefix test: bundled dependencies
    // still write the legacy bare forms (`postgres` imports `os` and `fs`),
    // and those are builtins, not missing packages.
    if (specifier === undefined || isBuiltin(specifier)) continue;
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      // A bundle is self-contained by definition; a relative import means
      // esbuild could not inline something and the image would ship a
      // dangling reference.
      console.error(`${bundle}: unexpected relative import ${specifier}`);
      failed = true;
      continue;
    }
    if (!installed(specifier, absolute)) {
      console.error(
        `${bundle}: external ${specifier} is not installed anywhere above ` +
          `${directory} — add it to apps/server/package.json dependencies, ` +
          'or drop it from the --external list in deploy/Dockerfile.server',
      );
      failed = true;
      continue;
    }
    resolved.push(specifier);
  }
  console.log(`${bundle}: ${String(resolved.length)} external(s) resolve`);
  for (const specifier of resolved.sort()) console.log(`  ${specifier}`);
}

process.exit(failed ? 1 : 0);
