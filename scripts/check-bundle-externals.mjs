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
 * done by walking `node_modules` upwards from the bundle exactly as Node
 * does, rather than through `import.meta.resolve`, which would resolve
 * relative to THIS file and so answer for the wrong directory.
 */
import { readFile, stat } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
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
 * So a statement begins on a line matching `^import` and continues until a
 * line ending in the closing quote of its specifier.
 */
function importedSpecifiers(source) {
  const specifiers = new Set();
  const lines = source.split('\n');
  let statement = null;
  for (const line of lines) {
    if (statement === null) {
      if (!STATEMENT_START.test(line)) continue;
      statement = line;
    } else {
      statement += ` ${line.trim()}`;
    }
    const closed = SPECIFIER.exec(statement);
    if (closed !== null) {
      specifiers.add(closed[1]);
      statement = null;
    } else if (statement.length > 4000) {
      // Not an import after all (a stray top-level `import` inside a
      // template literal, say). Stop accumulating rather than swallowing
      // the rest of the bundle.
      statement = null;
    }
  }
  return specifiers;
}

const STATEMENT_START = /^import[\s"'{*]/;
// The specifier is the LAST quoted string in the statement, which for both
// `import x from "spec"` and `import "spec"` is the one that closes it.
const SPECIFIER = /["']([^"'\n]+)["'];?\s*$/;

/** Node's own lookup: the nearest `node_modules/<name>` walking upwards. */
async function installed(specifier, fromDirectory) {
  const parts = specifier.split('/');
  const packageName = specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0];
  let directory = fromDirectory;
  for (;;) {
    try {
      const candidate = path.join(directory, 'node_modules', packageName);
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Not here; keep walking.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
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
    if ((await installed(specifier, directory)) === undefined) {
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
