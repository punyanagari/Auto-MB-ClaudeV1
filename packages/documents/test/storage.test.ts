import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Partial mock: everything real, with rename interceptable per test so a
// crash between the temp write and the atomic rename can be injected.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const { rename } = await import('node:fs/promises');
const { assertSafeObjectKey, createFileSystemStorage } =
  await import('@auto-mb/documents');

const ORGANISATION = '0f0e0d0c-0b0a-0908-0706-050403020100';
const KEY = `${ORGANISATION}/loa/document-1.pdf`;

describe('filesystem object storage', () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-storage-'));
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.mocked(rename).mockClear();
  });

  it('round-trips bytes and leaves no temp file behind', async () => {
    const storage = createFileSystemStorage(rootDir);
    const bytes = Buffer.from('atomic object bytes');
    await storage.put(KEY, bytes);
    expect(await storage.get(KEY)).toEqual(bytes);
    const entries = await readdir(path.join(rootDir, ORGANISATION, 'loa'));
    expect(entries).toEqual(['document-1.pdf']);
  });

  it('writes through a same-directory temp file and an atomic rename', async () => {
    const storage = createFileSystemStorage(rootDir);
    await storage.put(KEY, Buffer.from('renamed into place'));
    const call = vi.mocked(rename).mock.calls.at(-1);
    expect(call).toBeDefined();
    const [from, to] = call as [string, string];
    // Same directory: rename is only atomic within one filesystem, so the
    // temp file must never live in a shared scratch location.
    expect(path.dirname(from)).toBe(path.dirname(to));
    expect(path.basename(from)).toMatch(/^\.put-[0-9a-f-]+\.tmp$/);
    expect(to).toBe(path.join(rootDir, ORGANISATION, 'loa', 'document-1.pdf'));
  });

  it('replaces an existing object atomically on overwrite', async () => {
    const storage = createFileSystemStorage(rootDir);
    await storage.put(KEY, Buffer.from('first version'));
    await storage.put(KEY, Buffer.from('second version'));
    expect((await storage.get(KEY)).toString()).toBe('second version');
    const entries = await readdir(path.join(rootDir, ORGANISATION, 'loa'));
    expect(entries).toEqual(['document-1.pdf']);
  });

  it('torn write: an injected crash before rename leaves the temp file and never the final object', async () => {
    const storage = createFileSystemStorage(rootDir);
    const tornKey = `${ORGANISATION}/loa/torn-write.pdf`;
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error('injected crash'), { code: 'EIO' }),
    );
    await expect(storage.put(tornKey, Buffer.from('never visible'))).rejects.toThrow(
      'injected crash',
    );
    // The final object must not exist in any state — complete or partial.
    await expect(storage.get(tornKey)).rejects.toThrow();
    await expect(
      stat(path.join(rootDir, ORGANISATION, 'loa', 'torn-write.pdf')),
    ).rejects.toThrow();
    // The torn write's residue is exactly one orphan temp file, whose
    // dotted name no object key can ever resolve to.
    const entries = await readdir(path.join(rootDir, ORGANISATION, 'loa'));
    const orphans = entries.filter((entry) => /^\.put-.+\.tmp$/.test(entry));
    expect(orphans).toHaveLength(1);
    expect(() => {
      assertSafeObjectKey(`${ORGANISATION}/loa/${orphans[0] ?? ''}`);
    }).toThrow(/unsafe object key/);
  });

  it('still refuses unsafe keys before any filesystem work', async () => {
    const storage = createFileSystemStorage(rootDir);
    for (const key of [
      '../escape/name',
      `${ORGANISATION}/loa/../../name`,
      `${ORGANISATION}/loa/.put-x.tmp`,
      `${ORGANISATION}/LOA/name`,
    ]) {
      await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(
        /unsafe object key/,
      );
    }
  });
});
