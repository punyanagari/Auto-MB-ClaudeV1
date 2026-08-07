// Deterministic parse checks for configuration files that no other gate
// exercises: a syntax error in any of these breaks environment boot or
// tooling silently rather than failing a build.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { glob } from 'node:fs/promises';

const root = process.cwd();
const errors = [];

const jsonFiles = [
  '.cursor/environment.json',
  '.secretlintrc.json',
  'renovate.json',
  'package.json',
];
for await (const match of glob(['apps/*/package.json', 'packages/*/package.json'])) {
  jsonFiles.push(match);
}

for (const file of jsonFiles) {
  try {
    JSON.parse(await readFile(new URL(file, `file://${root}/`), 'utf8'));
  } catch (error) {
    errors.push(`${file}: ${String(error)}`);
  }
}

const shellScripts = [
  'scripts/bootstrap.sh',
  'scripts/cloud-install.sh',
  'scripts/cloud-start.sh',
  'docker/postgres/init-app-role.sh',
];
for (const script of shellScripts) {
  const result = spawnSync('bash', ['-n', script], { cwd: root });
  if (result.status !== 0) {
    errors.push(`${script}: bash -n failed\n${result.stderr.toString()}`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('config checks passed');
