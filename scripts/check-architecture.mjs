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
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('architecture checks passed');
