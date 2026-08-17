import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Accessibility invariants checked against the SOURCE, not against a render.
 *
 * The browser gate (`e2e/accessibility.spec.ts` + axe) is the better check
 * wherever it reaches, and it does not reach far enough: it opens eight
 * screens out of forty-odd, with fixtures that carry one row, and axe has no
 * rule for "the keyboard contract this role promises was never implemented".
 * The three rules below are the ones a whole-tree regex can decide, so they
 * hold for every screen including the ones no spec has ever opened — a new
 * register added next month is covered the day it is written.
 *
 * Two of the three failed on the tree that preceded them, at
 * `views/Masters.tsx` and at four `aria-expanded` sites. The caption rule is
 * the exception and is stated as such: every DataTable in the tree already
 * carried a caption, and the rule was proved by removing one — it holds a
 * property that is currently true rather than repairing one that was false.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (path.endsWith('.tsx')) {
      found.push(path);
    }
  }
  return found.sort();
}

/** Repository-relative and slash-separated, so a failure names the same
 * path on Windows and on the runner. */
function label(path: string): string {
  return `src/${relative(SRC, path).split(sep).join('/')}`;
}

/**
 * The file with its comments blanked out, character positions and line
 * numbers preserved.
 *
 * Not optional: this repository explains itself at length, and a rule that
 * scanned raw text would fail on the paragraph explaining why the thing it
 * forbids is not there — every one of these three did, on the very commit
 * that fixed them. Each comment becomes spaces and its newlines are kept,
 * so a reported line number still points where a reader would look.
 *
 * Block comments go first, which leaves `//` only in real code; the one
 * place it survives there is a URL inside a string, so a `:` before the
 * slashes is not a comment.
 */
function withoutComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, lead: string) => lead + blank(match.slice(lead.length)),
    );
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** The opening tag containing `index`, from its `<` to the `>` that closes
 * it. Brace depth is tracked because a JSX attribute value can hold a `>`
 * inside an expression (`{a > b}`, an arrow function) that does not end the
 * tag. */
function openingTagAt(source: string, index: number): string {
  const start = source.lastIndexOf('<', index);
  if (start === -1) return '';
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === '>' && depth === 0) return source.slice(start, cursor + 1);
  }
  return source.slice(start);
}

const FILES = sourceFiles(SRC);

describe('accessibility invariants', () => {
  it('gives every DataTable a caption', () => {
    /* The caption is the register's name, and `ui/table.tsx` borrows it
     * twice over: as the table's accessible name, and as the name of the
     * scroll region it wraps the table in. Without one the operator gets
     * an unnamed region and an unnamed table — and the scrollport, which
     * only grants itself a tab stop when it is both named and scrollable,
     * silently becomes unreachable from the keyboard. */
    const uncaptioned: string[] = [];
    for (const path of FILES) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      for (const match of source.matchAll(/<DataTable\b/g)) {
        const start = match.index;
        const close = source.indexOf('</DataTable>', start);
        const body = source.slice(start, close === -1 ? source.length : close);
        if (!body.includes('<caption')) {
          uncaptioned.push(`${label(path)}:${String(lineOf(source, start))}`);
        }
      }
    }
    expect(uncaptioned, 'DataTable without a <caption> naming the register').toEqual(
      [],
    );
  });

  it('never declares a tablist without the keyboard pattern it promises', () => {
    /* `role="tablist"` is a contract with the keyboard: Left/Right move
     * between tabs, Home/End jump to the ends, and the strip is ONE tab
     * stop because exactly one tab carries tabIndex 0. The Masters
     * category strip declared the role and listened for no key at all, so
     * arrow keys did nothing and the five categories were five dead tab
     * stops on the way to the register.
     *
     * The strip is now a `nav` with `aria-current="page"`, which is what
     * it always was — each category is its own address, and opening one
     * pushes a history entry. So the tree holds no tablist, and this rule
     * exists to make the next one arrive complete: declare the role and
     * you must handle the keys, or use the honest navigation instead. */
    const bare: string[] = [];
    for (const path of FILES) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      for (const match of source.matchAll(/role=(["'])tablist\1/g)) {
        const start = match.index;
        const close = source.indexOf('</', start);
        const element = source.slice(start, close === -1 ? source.length : close);
        const handled =
          element.includes('onKeyDown') &&
          element.includes('ArrowRight') &&
          element.includes('ArrowLeft') &&
          element.includes('Home') &&
          element.includes('End');
        if (!handled) {
          bare.push(`${label(path)}:${String(lineOf(source, start))}`);
        }
      }
    }
    expect(
      bare,
      'role="tablist" without onKeyDown handling ArrowLeft/ArrowRight/Home/End — ' +
        'implement the pattern or use a nav with aria-current="page"',
    ).toEqual([]);
  });

  it('never says aria-expanded without saying what is expanded', () => {
    /* aria-expanded states that something is open; aria-controls is the
     * only way to say WHAT, and without it a screen-reader user is told a
     * thing has opened with no way to reach it. The mobile "More" sheet
     * shipped exactly that — its two sibling sheets carried an id, a role
     * and a name, and it carried none — and so did both "Show more" text
     * clamps and the rail's module submenus. */
    /* The lookahead excludes Tailwind's STYLING variant — the
     * `aria-expanded:bg-muted` in `ui/button.tsx`'s outline recipe, which
     * keeps a disclosure's opener looking pressed while its panel is
     * open. A variant is a class name, not an attribute: it styles the
     * state, it does not claim it, so there is nothing for it to control.
     * A real attribute is never followed by a colon — including the JSX
     * boolean shorthand `<div aria-expanded>`, which this still catches. */
    const unpaired: string[] = [];
    for (const path of FILES) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      for (const match of source.matchAll(/aria-expanded(?!:)/g)) {
        const tag = openingTagAt(source, match.index);
        if (!tag.includes('aria-controls')) {
          unpaired.push(`${label(path)}:${String(lineOf(source, match.index))}`);
        }
      }
    }
    expect(
      unpaired,
      'aria-expanded without aria-controls naming the element it expands',
    ).toEqual([]);
  });
});
