#!/usr/bin/env node
/**
 * Fetches the two heavy third-party design skills into git-ignored paths
 * under `.claude/skills/`, at the exact upstream commits pinned in
 * `.claude/skills/PROVENANCE.md`. They used to be vendored (~82k lines of
 * third-party tree in every diff, clone and review); now they arrive on
 * setup with identical bytes and the same pin.
 *
 *   node scripts/fetch-skills.mjs           # fetch whatever is missing
 *   node scripts/fetch-skills.mjs --force   # refetch even if present
 *
 * The small `caveman` skill stays committed.
 * Provenance, licences and the reasoning live in PROVENANCE.md — update
 * the pins there and here together, never separately.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(repoRoot, '.claude', 'skills');
const force = process.argv.includes('--force');

/** Pins must match `.claude/skills/PROVENANCE.md`. */
const SKILLS = [
  {
    name: 'impeccable',
    repository: 'https://github.com/pbakaus/impeccable',
    commit: '1cbee026c319',
    licence: 'Apache-2.0',
    // Upstream ships the installed skill at this path; the repo-root
    // LICENSE is copied alongside, exactly as the vendored copy carried it.
    copy(checkout, target) {
      cpSync(path.join(checkout, '.claude', 'skills', 'impeccable'), target, {
        recursive: true,
      });
      cpSync(path.join(checkout, 'LICENSE'), path.join(target, 'LICENSE'));
    },
  },
  {
    name: 'ux-designer',
    repository: 'https://github.com/szilu/ux-designer-skill',
    commit: '28b24d5a9511',
    licence: 'MIT',
    // The skill is the repository root; the upstream README (install
    // instructions for other harnesses) is deliberately not installed.
    copy(checkout, target) {
      cpSync(checkout, target, {
        recursive: true,
        filter: (source) => {
          const relative = path.relative(checkout, source);
          const [head] = relative.split(path.sep);
          return head !== '.git' && relative !== 'README.md';
        },
      });
    },
  },
];

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
}

function gitOutput(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let failures = 0;

for (const skill of SKILLS) {
  const target = path.join(skillsDir, skill.name);
  if (existsSync(target)) {
    if (!force) {
      console.log(`${skill.name}: already present, skipping (use --force to refetch)`);
      continue;
    }
    rmSync(target, { recursive: true, force: true });
  }

  const staging = mkdtempSync(path.join(os.tmpdir(), `auto-mb-skill-${skill.name}-`));
  const checkout = path.join(staging, 'checkout');
  try {
    console.log(`${skill.name}: cloning ${skill.repository} @ ${skill.commit} …`);
    // A full clone, not a shallow one: a pinned historical commit is not
    // guaranteed to be fetchable by SHA on every host. autocrlf is forced
    // off — persisted into the staging repo's own config so the later
    // checkout obeys it too — so the fetched bytes match the pin on every
    // platform, including a Windows host with global autocrlf=true.
    git(
      [
        'clone',
        '--quiet',
        '--no-checkout',
        '--config',
        'core.autocrlf=false',
        '--config',
        'core.eol=lf',
        skill.repository,
        checkout,
      ],
      repoRoot,
    );
    git(['checkout', '--quiet', skill.commit], checkout);
    const head = gitOutput(['rev-parse', 'HEAD'], checkout);
    if (!head.startsWith(skill.commit)) {
      throw new Error(
        `${skill.name}: checked out ${head}, expected the pin ${skill.commit}`,
      );
    }
    skill.copy(checkout, target);
    console.log(
      `${skill.name}: installed at .claude/skills/${skill.name} (${skill.licence})`,
    );
  } catch (error) {
    failures += 1;
    rmSync(target, { recursive: true, force: true });
    console.error(
      `${skill.name}: FAILED — ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

process.exit(failures === 0 ? 0 : 1);
