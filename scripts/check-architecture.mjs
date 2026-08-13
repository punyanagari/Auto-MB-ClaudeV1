import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const forbiddenRoots = ['.claude/agents', 'memory', 'tickets'];
const requiredFiles = [
  'AGENTS.md',
  'docs/PRODUCT.md',
  'docs/ARCHITECTURE.md',
  'docs/SECURITY.md',
  'docs/OPERATIONS.md',
  'docs/ROADMAP.md',
];

async function exists(relativePath) {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

const errors = [];
for (const file of requiredFiles) {
  if (!(await exists(file))) errors.push(`missing required file: ${file}`);
}
for (const directory of forbiddenRoots) {
  if (await exists(directory)) {
    errors.push(`legacy factory surface must not return: ${directory}`);
  }
}

async function collectFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue;
      output.push(...(await collectFiles(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      output.push(full);
    }
  }
  return output;
}

/**
 * Spans of `source` in which a `setView(` call is legitimate.
 *
 * Departure protection is only as good as its narrowest bypass: a view
 * change that skips `requestDeparture` discards an editor's unsaved work
 * with no warning, which is exactly how `ReviewLoa` came to be
 * unprotected while the two short editors were not. The rule is therefore
 * structural rather than advisory — `setView` may be called from the body
 * of `navigate`, or from a callback handed to `requestDeparture`, and
 * from nowhere else.
 *
 * The scanner is deliberately simple: it walks the source once, skipping
 * comments and string/template literals so that a brace inside either
 * cannot move the region boundaries, and pairs delimiters by depth.
 */
function departureSafeSpans(source) {
  const spans = [];
  const prose = [];
  const openers = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end + 1;
      prose.push([index, stop]);
      index = stop;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      prose.push([index, stop]);
      index = stop;
      continue;
    }
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === '`') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      prose.push([start, index]);
      continue;
    }
    // A sanctioned region starts at the delimiter that follows the name:
    // `function navigate(` opens with the body brace, `requestDeparture(`
    // with its own argument list.
    const navigate = /^function\s+navigate\s*\([^)]*\)[^{]*\{/.exec(rest);
    if (navigate !== null) {
      openers.push({ close: '}', start: index + navigate[0].length - 1, depth: 0 });
      index += navigate[0].length;
      continue;
    }
    const departure = /^requestDeparture\s*\(/.exec(rest);
    if (departure !== null) {
      openers.push({ close: ')', start: index + departure[0].length - 1, depth: 0 });
      index += departure[0].length;
      continue;
    }
    const character = source[index];
    const top = openers.at(-1);
    if (top !== undefined) {
      const open = top.close === '}' ? '{' : '(';
      if (character === open) top.depth += 1;
      else if (character === top.close) {
        if (top.depth === 0) {
          spans.push([top.start, index]);
          openers.pop();
        } else top.depth -= 1;
      }
    }
    index += 1;
  }
  return { spans, prose };
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Files the departure rule does not apply to. Empty, and meant to stay that
 * way: the one entry it ever held was the retired workspace shell that
 * `OperationsWorkspace.tsx` superseded, exempted by Pack P5 with the note
 * that the exemption travels with the file. Pack P1 deleted the file, so the
 * exemption went with it — an exempt list naming something that no longer
 * exists is a hole nobody can see.
 */
const DEPARTURE_RULE_EXEMPT = new Set([]);

for (const file of await collectFiles(root)) {
  const source = await readFile(file, 'utf8');
  const relative = path.relative(root, file);
  if (relative.startsWith('apps/web/') && /from ['"]@auto-mb\/db/.test(source)) {
    errors.push(`web must not import database package: ${relative}`);
  }
  if (
    relative.startsWith('packages/loa-parser/') &&
    /from ['"]@auto-mb\//.test(source)
  ) {
    errors.push(`LOA parser must remain independent: ${relative}`);
  }
  if (
    relative.startsWith(path.join('apps', 'web', 'src')) &&
    !DEPARTURE_RULE_EXEMPT.has(relative) &&
    source.includes('setView(')
  ) {
    const { spans, prose } = departureSafeSpans(source);
    for (const match of source.matchAll(/\bsetView\s*\(/g)) {
      const at = match.index;
      const covered =
        spans.some(([start, end]) => at > start && at < end) ||
        prose.some(([start, end]) => at >= start && at < end);
      if (!covered) {
        errors.push(
          `view state must move through navigate()/requestDeparture(), so an ` +
            `unsaved editor is never left without confirmation: ` +
            `${relative}:${String(lineOf(source, at))}`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('architecture checks passed');
