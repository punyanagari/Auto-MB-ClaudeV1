import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** The object storage boundary for uploaded documents, as the filesystem
 * implementation defines it. */
export type ObjectStorage = ReturnType<typeof createFileSystemStorage>;

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

/**
 * Object storage for uploaded documents. The filesystem implementation
 * serves development and single-node deployments; an S3-compatible one
 * slots in behind the same shape when the deployment story (Milestone 4)
 * needs it. Keys are server-generated and tenant-prefixed — migration 0003
 * enforces the same prefix rule on loa_documents.object_key, so the
 * storage layout and the database agree.
 */
export function createFileSystemStorage(rootDir: string) {
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
    async put(key: string, bytes: Buffer): Promise<void> {
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
    /**
     * The same crash-consistent write, for an object nobody wants resident
     * (migration 0096's organisation export).
     *
     * `put` takes a Buffer, which is right for every document this product
     * stored until now — a PDF is megabytes and arrives as bytes anyway.
     * A whole-organisation export is the first object built by streaming
     * around sixty tables through a cursor precisely so that no table is
     * ever fully in memory, and buffering the result to hand it to `put`
     * would undo that at the last step.
     *
     * Temp file, fsync, rename, directory sync — the same four steps and
     * the same reasons, so a reader still cannot observe a half-written
     * object. Returns the byte count, because the caller has to record the
     * size of what it wrote and counting a stream twice is a second read.
     */
    async putStream(key: string, source: Readable): Promise<number> {
      const file = resolveKey(key);
      const dir = path.dirname(file);
      await mkdir(dir, { recursive: true });
      const temp = path.join(dir, `.put-${randomUUID()}.tmp`);
      await pipeline(source, createWriteStream(temp, { flags: 'wx' }));
      // `r+`, not `r`. Windows refuses fsync on a read-only handle with
      // EPERM, so the durability step this method exists for would fail on
      // every development machine while passing in CI — the worst shape a
      // durability bug can have. `put` above never hits it because it
      // syncs the same handle it wrote through.
      const handle = await open(temp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const { size } = await stat(temp);
      await rename(temp, file);
      await syncDirectory(dir);
      return size;
    },
    async get(key: string): Promise<Buffer> {
      return readFile(resolveKey(key));
    },
    /**
     * The read half of `putStream`, for the one object nobody wants
     * resident: the whole-organisation export.
     *
     * `get` returns a Buffer, which is right for every document this
     * product serves — a PDF is megabytes and the response holds it once.
     * An export package is built by streaming sixty tables through a
     * cursor precisely so it is never fully in memory, and reading it back
     * with `get` would put the entire organisation on the server's heap at
     * the last step, once per concurrent download.
     *
     * It OPENS the file rather than returning a lazy stream, so a missing
     * or unreadable object fails here — before the caller has committed
     * anything or written a response header — instead of destroying a
     * response that has already claimed success.
     */
    async getStream(key: string): Promise<{ stream: Readable; size: number }> {
      const file = resolveKey(key);
      const handle = await open(file, 'r');
      try {
        const { size } = await handle.stat();
        return { stream: handle.createReadStream({ autoClose: true }), size };
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
    /**
     * Removes a stored object, and says nothing if it was already gone.
     *
     * The only caller is the export expiry sweep (migration 0096), and the
     * reason this method exists at all is that an expired whole-
     * organisation bundle left on disk is a copy of the entire business
     * with no expiry. Every other object in this product is a document the
     * organisation keeps.
     *
     * `force` — a missing file is the sweep's success case, not its error:
     * the row is marked expired before the bytes go, so a retried sweep and
     * a hand-cleaned directory both arrive here with nothing to delete.
     */
    async remove(key: string): Promise<void> {
      await rm(resolveKey(key), { force: true });
    },
  };
}
