import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// fileURLToPath, not URL.pathname: on Windows the latter yields a
// leading-slash path that readdirSync cannot open.
const VIEWS_DIR = fileURLToPath(new URL('../src/views/', import.meta.url));

function viewFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return viewFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** `<Disclosure … label="…">` — the opener's words. Template labels
 * (`label={\`…\`}`) name a specific record and can never collide with a
 * fixed submit label, so they are out of scope. */
const DISCLOSURE_LABEL = /<Disclosure[^>]*?\blabel="([^"]+)"/gs;

/** `<Button type="submit" …>Words</Button>` — the committing verb. */
const SUBMIT_LABEL = /<Button[^>]*type="submit"[^>]*>\s*([^<{][^<]*?)\s*<\/Button>/gs;

/**
 * The opener of a form and the button that submits it must never read
 * the same. When they did, an already-open panel (every register's empty
 * state opens its form) made the header look inert: the operator pressed
 * the words they read as the action, and the form only collapsed.
 * The convention is recorded on the Disclosure component itself.
 */
describe('Disclosure labelling', () => {
  it('never gives an opener the same words as its own submit button', () => {
    const collisions: string[] = [];
    for (const file of viewFiles(VIEWS_DIR)) {
      const source = readFileSync(file, 'utf8');
      const submits = new Set(
        [...source.matchAll(SUBMIT_LABEL)].map((match) => (match[1] ?? '').trim()),
      );
      for (const match of source.matchAll(DISCLOSURE_LABEL)) {
        const label = match[1] ?? '';
        if (submits.has(label)) {
          collisions.push(`${basename(file)}: "${label}"`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});
