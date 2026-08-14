import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
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

/**
 * Directory-entry durability after the atomic rename below. On Linux — the
 * production posture, where the server runs in containers — this is a real
 * fsync on the directory: without it a power loss can forget the rename
 * even though the file's own bytes were synced. Windows (development only)
 * cannot open a directory through libuv (`open` fails EPERM/EISDIR), and
 * some filesystems reject fsync on a directory handle (EINVAL/ENOTSUP/
 * EBADF); both degrade gracefully — the write itself is still atomic via
 * rename, only the crash-durability of the directory entry is weaker.
 */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(dir, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF') throw error;
  } finally {
    await handle.close();
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
    /**
     * Crash-consistent write (audit finding 34, atomic-write slice): the
     * bytes land in a temp file IN THE SAME DIRECTORY as the final key
     * (rename is only atomic within one filesystem), are fsynced, and are
     * then renamed onto the key; finally the directory entry itself is
     * synced. A stored object therefore either exists complete or not at
     * all — a reader can never observe a half-written object, and a crash
     * mid-write leaves at most an orphan temp file. Deliberately no
     * compensating delete on failure: after an I/O error the directory's
     * state is unknown and a real crash could not have cleaned up anyway.
     * Orphan temp files are inert — their dotted names can never satisfy
     * assertSafeObjectKey, so no key resolves to them.
     */
    async put(key, bytes) {
      const file = resolveKey(key);
      const dir = path.dirname(file);
      await mkdir(dir, { recursive: true });
      const temp = path.join(dir, `.put-${randomUUID()}.tmp`);
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
      await syncDirectory(dir);
    },
    async get(key) {
      return readFile(resolveKey(key));
    },
  };
}
