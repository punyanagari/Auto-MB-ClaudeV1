import { readFileSync } from 'node:fs';

/**
 * The version the OpenAPI document publishes for this API.
 *
 * Audit finding 44: it used to be the scaffold's literal `0.1.0`, hard-coded
 * beside the title, which told a consumer nothing about an API of roughly two
 * hundred routes over fifty-five migrations — and, being a second copy of a
 * number, was going to stay wrong.
 *
 * So it is not a second copy. The single source is `@auto-mb/server`'s own
 * package version, read here. The server always runs from source (`tsx
 * src/main.ts`; the package declares no build step), so the relative path is
 * stable in development, in the production image and under vitest alike.
 *
 * Bumping the API version therefore means editing `apps/server/package.json`
 * and nothing else. The scheme is the delivery roadmap: minor is the highest
 * milestone in `docs/ROADMAP.md` whose surface the API serves, and the major
 * stays 0 deliberately — `README.md` and `docs/ROADMAP.md` both record that
 * paid-production gates remain open, and 1.0.0 would contradict them.
 */
function readPackageVersion(): string {
  const packageUrl = new URL('../package.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(packageUrl, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error('apps/server/package.json declares no string version');
  }
  return parsed.version;
}

export const API_VERSION = readPackageVersion();
