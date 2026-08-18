import { existsSync } from 'node:fs';
import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

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

const errors = [];
for (const file of requiredFiles) {
  if (!existsSync(path.join(root, file))) {
    errors.push(`missing required file: ${file}`);
  }
}
for (const directory of forbiddenRoots) {
  if (existsSync(path.join(root, directory))) {
    errors.push(`legacy factory surface must not return: ${directory}`);
  }
}

/**
 * Directory names never walked, matched on the entry name at any depth —
 * which is what `exclude` is handed. Build output and dependencies are the
 * obvious ones; `.claude` is here because it holds agent worktrees (whole
 * stale checkouts of this repository) and the fetched third-party design
 * skills, and scanning either means auditing a copy of the tree instead of
 * the tree.
 */
const NEVER_WALKED = ['node_modules', 'dist', 'coverage', '.git', '.claude'];

async function collectFiles() {
  const output = [];
  for await (const match of glob('**/*.{ts,tsx}', {
    cwd: root,
    exclude: (name) => NEVER_WALKED.includes(name),
  })) {
    output.push(match);
  }
  return output;
}

/**
 * Lines carrying a `setView(` call that is NOT reachable through the
 * departure gate.
 *
 * Departure protection is only as good as its narrowest bypass: a view
 * change that skips `requestDeparture` discards an editor's unsaved work
 * with no warning, which is exactly how `ReviewLoa` came to be
 * unprotected while the two short editors were not. The rule is therefore
 * structural rather than advisory — `setView` may be called from the body
 * of `navigate`, or from a callback handed to `requestDeparture`, and
 * from nowhere else.
 *
 * The structure is read off TypeScript's own parse rather than a
 * hand-rolled scan: a sanctioned call has the `navigate` function
 * declaration or a `requestDeparture(...)` call among its ancestors. That
 * also disposes of the comment- and string-skipping the scan needed, since
 * `setView(` written inside either is not a call expression at all.
 */
function unguardedSetViewLines(source, fileName) {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // `setView(...)` and `something.setView(...)` alike — the scan this
  // replaces matched the bare name, so a call through a property reads the
  // same way here.
  const calleeName = (expression) => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return null;
  };
  const sanctioned = (node) => {
    for (let at = node.parent; at !== undefined; at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name?.text === 'navigate') return true;
      if (ts.isCallExpression(at) && calleeName(at.expression) === 'requestDeparture') {
        return true;
      }
    }
    return false;
  };

  const lines = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      calleeName(node.expression) === 'setView' &&
      !sanctioned(node)
    ) {
      lines.push(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return lines;
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

for (const relative of await collectFiles()) {
  const source = await readFile(path.join(root, relative), 'utf8');
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
    source.includes('setView')
  ) {
    for (const line of unguardedSetViewLines(source, relative)) {
      errors.push(
        `view state must move through navigate()/requestDeparture(), so an ` +
          `unsaved editor is never left without confirmation: ` +
          `${relative}:${String(line)}`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('architecture checks passed');
