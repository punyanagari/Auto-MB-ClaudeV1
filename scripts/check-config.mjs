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
  '.prettierrc.json',
  'renovate.json',
  'package.json',
  'docs/reference/IMPORT-MANIFEST.json',
];
const jsonGlobs = [
  'apps/*/package.json',
  'packages/*/package.json',
  'tsconfig.base.json',
  'apps/*/tsconfig.json',
  'packages/*/tsconfig.json',
];
for await (const match of glob(jsonGlobs)) {
  jsonFiles.push(match);
}

for (const file of jsonFiles) {
  try {
    JSON.parse(await readFile(new URL(file, `file://${root}/`), 'utf8'));
  } catch (error) {
    errors.push(`${file}: ${String(error)}`);
  }
}

// Globbed (not hand-listed) so a new script anywhere under scripts/ or
// docker/ cannot silently escape validation.
const shellScripts = [];
for await (const match of glob(['scripts/**/*.sh', 'docker/**/*.sh'])) {
  shellScripts.push(match);
}
if (shellScripts.length < 4) {
  errors.push(
    `expected at least 4 shell scripts, found ${shellScripts.length} — glob broken?`,
  );
}
for (const script of shellScripts) {
  const result = spawnSync('bash', ['-n', script], { cwd: root });
  if (result.status !== 0) {
    errors.push(`${script}: bash -n failed\n${result.stderr.toString()}`);
  }
}

// The Poppler pin has to be ONE number in three places, because LOA
// extraction reads `pdftotext -layout` geometry and a CI runner parsing at a
// different version than the production image means the corpus proves
// nothing about production. `poppler-version.txt` holds the value;
// .github/workflows/ci.yml installs and asserts it, and
// deploy/Dockerfile.server pins and asserts it. Both call sites already fail
// loudly when the INSTALLED binary disagrees with what they expect — this
// checks the cheaper failure the runtime assertions cannot see, which is the
// three declarations drifting apart from each other.
{
  const declared = (
    await readFile(new URL('../poppler-version.txt', import.meta.url), 'utf8')
  )
    .split('\n')[0]
    .trim();
  if (!/^\d+\.\d+\.\d+$/.test(declared)) {
    errors.push(`poppler-version.txt: first line is not a version: ${declared}`);
  }
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const inWorkflow = /^\s*POPPLER_VERSION:\s*'?([\d.]+)'?\s*$/m.exec(workflow)?.[1];
  if (inWorkflow === undefined) {
    errors.push('.github/workflows/ci.yml: no POPPLER_VERSION declaration found');
  } else if (inWorkflow !== declared) {
    errors.push(
      `Poppler pin drift: poppler-version.txt says ${declared}, ` +
        `.github/workflows/ci.yml says ${inWorkflow}. Move both together, ` +
        'along with the Alpine base in deploy/Dockerfile.server, and re-run ' +
        'apps/server/test/loa-extract-roundtrip.test.ts.',
    );
  }
  const dockerfile = await readFile(
    new URL('../deploy/Dockerfile.server', import.meta.url),
    'utf8',
  );
  if (!dockerfile.includes('poppler-version.txt')) {
    errors.push(
      'deploy/Dockerfile.server no longer reads poppler-version.txt; the ' +
        'production pin and the CI pin can now drift apart silently.',
    );
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('config checks passed');
