import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Object storage boundary for uploaded documents. The filesystem
 * implementation below serves development and single-node deployments; an
 * S3-compatible implementation slots in behind the same interface when the
 * deployment story (Milestone 4) needs it. Keys are server-generated and
 * tenant-prefixed — migration 0003 enforces the same prefix rule on
 * loa_documents.object_key, so the storage layout and the database agree.
 */
export interface ObjectStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

// <organisation uuid>/<area>/<server-generated name>[.<extension>].
// Validated segment-by-segment with anchored single-class regexes (no
// optional groups, so nothing for a pathological input to backtrack over):
// no dots beyond the extension separator, no path metacharacters, so a key
// can never traverse outside the root.
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AREA_SEGMENT = /^[a-z]+$/;
const NAME_SEGMENT = /^[A-Za-z0-9-]+$/;
const EXTENSION_SEGMENT = /^[a-z0-9]+$/;

export function assertSafeObjectKey(key: string): void {
  const segments = key.split('/');
  const [organisation, area, name] = segments;
  const nameParts = (name ?? '').split('.');
  const [base, extension] = nameParts;
  const valid =
    segments.length === 3 &&
    organisation !== undefined &&
    UUID_SEGMENT.test(organisation) &&
    area !== undefined &&
    AREA_SEGMENT.test(area) &&
    nameParts.length <= 2 &&
    base !== undefined &&
    NAME_SEGMENT.test(base) &&
    (extension === undefined || EXTENSION_SEGMENT.test(extension));
  if (!valid) {
    throw new Error(`unsafe object key: ${JSON.stringify(key)}`);
  }
}

export function createFileSystemStorage(rootDir: string): ObjectStorage {
  const root = path.resolve(rootDir);

  function resolveKey(key: string): string {
    assertSafeObjectKey(key);
    const resolved = path.resolve(root, key);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(`object key escapes storage root: ${JSON.stringify(key)}`);
    }
    return resolved;
  }

  return {
    async put(key, bytes) {
      const file = resolveKey(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    },
    async get(key) {
      return readFile(resolveKey(key));
    },
  };
}
