import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The census that keeps `ui/combobox` the ONLY way to choose a Work.
 *
 * Live testing on 2026-08-22 reported the Reports picker as "a huge plain
 * dropdown — every work's full title, giant text", and the owner's ruling
 * was that the fix applies to every Work picker in the product rather than
 * to the screen that was being tested. Four `<select>`s carried the defect
 * and were converted together; the fifth is the one a later change adds by
 * copying the two lines above it.
 *
 * So the source is counted here rather than reviewed by eye, for the
 * reason `numeric-input-census.test.ts` and `a11y-invariants.test.ts` give
 * about their own scans: the browser gate only reaches the screens it
 * opens, and this claim is about every screen including the ones no spec
 * has ever opened.
 *
 * THE RULE: no `<select>` in the tree may be filled from the Works
 * register. That is the shape all four converted pickers had, and it is
 * what makes a control a Work picker — not the field names it prints.
 *
 * What this deliberately does NOT forbid: `<select>` itself. Most of them
 * are short fixed vocabularies — a status, a priority, a financial year —
 * and a text box in front of five words is worse than the platform
 * control, not better. The claim is about the Works register, whose length
 * is the organisation's portfolio.
 */

const WEB_SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

/** Repository-relative and slash-separated, so a failure names the same
 * path on Windows and on the runner. */
function label(path: string): string {
  return `src/${relative(WEB_SRC, path).split(sep).join('/')}`;
}

/** Every `<select …>…</select>` element in a source file, as text. */
function selectElements(text: string): readonly string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/<select\b/g)) {
    const close = text.indexOf('</select>', match.index);
    found.push(text.slice(match.index, close === -1 ? text.length : close));
  }
  return found;
}

/**
 * The register this select is over.
 *
 * `works.map(` — however it is reached, `works`, `pickers.works`,
 * `loaded.works` — is what a Work picker is, and it is the shape all four
 * of the converted ones had. A select over purchase ORDERS that prints a
 * Work code beside each order is not a Work picker and is not caught,
 * which is why the test keys on the array rather than on the field name.
 */
const OVER_THE_WORKS = /\bworks\s*\.map\(/;

describe('the Work picker census', () => {
  it('opens no <select> over the Works register — the combobox is the picker', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(WEB_SRC)) {
      const source = readFileSync(path, 'utf8');
      for (const element of selectElements(source)) {
        if (OVER_THE_WORKS.test(element)) {
          offenders.push(label(path));
        }
      }
    }
    expect(
      offenders,
      'a <select> over the Works register — use `ui/combobox`, which filters as ' +
        'you type and shows the code beside a clipped title (docs/UX.md § 38)',
    ).toEqual([]);
  });

  it('has the primitive in use, so the rule above is not vacuously true', () => {
    const users = sourceFiles(WEB_SRC).filter((path) =>
      readFileSync(path, 'utf8').includes("from '../ui/combobox.js'"),
    );
    expect(users.map(label).sort()).toEqual([
      'src/views/CorrespondenceComposer.tsx',
      'src/views/MaintenanceRequestForm.tsx',
      'src/views/Production.tsx',
      'src/views/Receivables.tsx',
      'src/views/WorksAnalysis.tsx',
    ]);
  });
});
