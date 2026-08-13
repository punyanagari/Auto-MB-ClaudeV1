// Deterministic parse checks for configuration files that no other gate
// exercises: a syntax error in any of these breaks environment boot or
// tooling silently rather than failing a build.
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
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

// The CCA India root bundle shipped as the default value of
// AUTO_MB_PDF_TRUST_ANCHORS. It decides WHO signed an inbound railway PDF,
// which makes it the one directory in this repository where a silently
// swapped file would be a security event rather than a build failure — so
// every certificate is pinned here by the SHA-256 of its DER, and adding
// one means editing this manifest with the provenance recorded in
// deploy/trust-anchors/README.md.
//
// Fingerprints are the DER's, not the file's: the same certificate is
// published by the CCA as bare base64, as CRLF PEM and as LF PEM, and only
// the DER identifies the certificate rather than its packaging.
const CCA_INDIA_ROOTS = {
  'cca-india-2022.pem': {
    subject: 'CCA India 2022',
    sha256: '9a3fd3176798e842ddcb12c262f11cfacca70a8b84c6ea6fda30842a95a94cd8',
  },
  'cca-india-2022-spl.pem': {
    subject: 'CCA India 2022 SPL',
    sha256: 'b724689b79b2ef9421ef8f5cc733eb093851b170ee715177005a09f226d8c91a',
  },
  // Expired 2024-03-05 and kept deliberately: a 2020 letter still needs the
  // root that was current in 2020 for its chain to be readable at all. An
  // expired anchor never promotes a signature to trusted — the verifier
  // reports certificate_expired with the path it walked — but without it
  // the same document reads as "issuer unknown", a worse answer. Roots are
  // added to this directory, never removed (docs/OPERATIONS.md §8).
  'cca-india-2014.pem': {
    subject: 'CCA India 2014',
    sha256: '60109bc6c38328598a112c7a25e38b0f23e5a7511cb815fb64e0c4ff05db7df7',
  },
};

// Extensions the loader in apps/server/src/pdf-signature/trust-anchors.ts
// actually reads. A README.md alongside the certificates is invisible to
// it and must stay invisible here too.
const ANCHOR_EXTENSIONS = ['.pem', '.crt', '.cer'];
const isAnchorFile = (name) =>
  ANCHOR_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));

{
  const directory = new URL('../deploy/trust-anchors/', import.meta.url);
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    errors.push(
      `deploy/trust-anchors: the default AUTO_MB_PDF_TRUST_ANCHORS bundle ` +
        `could not be read (${String(error)}). deploy/Dockerfile.server copies ` +
        'it into the image and the server refuses to start when the ' +
        'configured path is unreadable.',
    );
  }

  const present = entries.filter(isAnchorFile).sort();
  const expected = Object.keys(CCA_INDIA_ROOTS).sort();
  if (entries.length > 0 && present.join(',') !== expected.join(',')) {
    errors.push(
      `deploy/trust-anchors: certificate files are [${present.join(', ')}], ` +
        `the pinned manifest in this script is [${expected.join(', ')}]. ` +
        'A trust anchor may only be added or removed together with its ' +
        'SHA-256 and its provenance in deploy/trust-anchors/README.md.',
    );
  }

  for (const file of present) {
    const pinned = CCA_INDIA_ROOTS[file];
    if (pinned === undefined) continue;
    let certificate;
    let der;
    try {
      const pem = await readFile(new URL(file, directory), 'utf8');
      certificate = new X509Certificate(pem);
      der = certificate.raw;
    } catch (error) {
      errors.push(
        `deploy/trust-anchors/${file}: not a readable certificate (${String(error)})`,
      );
      continue;
    }
    const digest = createHash('sha256').update(der).digest('hex');
    if (digest !== pinned.sha256) {
      errors.push(
        `deploy/trust-anchors/${file}: SHA-256 of the certificate is ${digest}, ` +
          `the manifest pins ${pinned.sha256}. This file is a trust decision; ` +
          'a change to it is never incidental.',
      );
    }
    if (!certificate.subject.includes(`CN=${pinned.subject}`)) {
      errors.push(
        `deploy/trust-anchors/${file}: subject is ${certificate.subject.replace(/\n/g, ', ')}, ` +
          `expected CN=${pinned.subject}.`,
      );
    }
    if (!certificate.ca) {
      errors.push(
        `deploy/trust-anchors/${file}: not a CA certificate (basicConstraints).`,
      );
    }
    // A trust anchor at the top level must be a CCA ROOT, and a root is
    // self-signed. Verifying it against its own key is what separates an
    // anchor from a licensed CA's sub-CA — installing one of those here
    // would make that CA's compromise indistinguishable from a compromise
    // of the root, which is precisely the mistake the loader's
    // anchors/intermediates split exists to prevent.
    if (!certificate.verify(certificate.publicKey)) {
      errors.push(
        `deploy/trust-anchors/${file}: its signature does not verify against ` +
          'its own public key, so it is not a self-signed root and must not ' +
          'be a trust anchor.',
      );
    }
  }

  // The bundle is only a default if the image actually carries it and
  // points the variable at it. Both halves are one line each and both have
  // been silently droppable until now.
  const dockerfile = await readFile(
    new URL('../deploy/Dockerfile.server', import.meta.url),
    'utf8',
  );
  if (!dockerfile.includes('COPY deploy/trust-anchors /etc/auto-mb/pdf-trust')) {
    errors.push(
      'deploy/Dockerfile.server no longer copies deploy/trust-anchors into ' +
        'the image; the default deployment would show "no certifying ' +
        'authorities are installed" on every signed railway document.',
    );
  }
  if (!/^ENV AUTO_MB_PDF_TRUST_ANCHORS=\/etc\/auto-mb\/pdf-trust$/m.test(dockerfile)) {
    errors.push(
      'deploy/Dockerfile.server no longer sets AUTO_MB_PDF_TRUST_ANCHORS; the ' +
        'copied bundle would be inert.',
    );
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log('config checks passed');
