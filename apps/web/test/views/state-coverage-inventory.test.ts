// @vitest-environment jsdom
/* The case table it reads pulls in the shared view fixtures, whose
 * cleanup hook touches `window`; this file itself only reads source. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXEMPT_VIEWS, STATE_CASES } from './state-coverage-cases.js';

/*
 * The inventory half of the state-coverage guard.
 *
 * `state-coverage.test.tsx` proves that the views it knows about render
 * three states. This file proves it knows about all of them: it derives
 * the list of views with a mount load path from the source, and fails if
 * one is neither covered by a case nor exempt with a stated reason.
 *
 * Without it, the way to make the coverage suite pass would be to delete
 * a case — and a new view could ship a fresh dead end with nothing
 * noticing.
 */

/* Resolved from the runner's root rather than from `import.meta.url`:
 * this file runs in jsdom (the case table it imports pulls in the shared
 * view fixtures), and there a module URL is an http: one that
 * `fileURLToPath` refuses. Vitest's root is this package. */
const VIEWS_DIR = join(process.cwd(), 'src', 'views');

/** The balanced-parenthesis span of every `head(` call in the file. Crude
 * next to a parser and exact enough for this: the only thing asked of it
 * is whether a hook's argument list mentions the API. */
function spansOf(text: string, head: string): readonly (readonly [number, string])[] {
  const spans: (readonly [number, string])[] = [];
  let i = text.indexOf(`${head}(`);
  while (i !== -1) {
    let depth = 0;
    let j = i + head.length;
    for (; j < text.length; j++) {
      const character = text[j];
      if (character === '(') depth++;
      else if (character === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    spans.push([i, text.slice(i, j)] as const);
    i = text.indexOf(`${head}(`, j);
  }
  return spans;
}

/**
 * Whether the view reads anything on mount.
 *
 * Two shapes count. The direct one is an effect that touches `api`. The
 * indirect one is an effect that calls a `useCallback` which does — the
 * `reload` / `refresh` / `fetchPage` idiom this codebase uses wherever a
 * mutation has to re-read the list it changed. Both end in a promise
 * that can reject while the operator is looking at the screen, which is
 * the only property this test cares about.
 */
/** Every identifier called as a function anywhere in the span. */
function calledNames(span: string): ReadonlySet<string> {
  const names = new Set<string>();
  const pattern = /([A-Za-z_$][\w$]*)\s*\(/g;
  let match = pattern.exec(span);
  while (match !== null) {
    names.add(match[1] as string);
    match = pattern.exec(span);
  }
  return names;
}

/** The name a `useCallback(` at this offset was assigned to, if any. Read
 * backwards from the call rather than forwards from a declaration, so a
 * type annotation or a line break between the two changes nothing. */
function assignedName(source: string, at: number): string | null {
  const head = source.slice(Math.max(0, at - 160), at);
  const start = head.lastIndexOf('const ');
  if (start === -1) return null;
  const declaration = /^const\s+([A-Za-z_$][\w$]*)/.exec(head.slice(start));
  return declaration === null ? null : (declaration[1] as string);
}

function hasLoadPath(source: string): boolean {
  const loaders = new Set<string>();
  for (const [at, span] of spansOf(source, 'useCallback')) {
    if (!/\bapi\b|\.then\(|\bawait\b/.test(span)) continue;
    const name = assignedName(source, at);
    if (name !== null) loaders.add(name);
  }
  return spansOf(source, 'useEffect').some(([, span]) => {
    if (/\bapi\b/.test(span)) return true;
    const called = calledNames(span);
    return [...loaders].some((name) => called.has(name));
  });
}

function viewsWithLoadPath(): readonly string[] {
  return readdirSync(VIEWS_DIR)
    .filter((entry) => entry.endsWith('.tsx'))
    .filter((entry) => hasLoadPath(readFileSync(join(VIEWS_DIR, entry), 'utf8')))
    .sort();
}

describe('per-view state coverage', () => {
  const loading = viewsWithLoadPath();

  it('reads the views it claims to', () => {
    // A mis-resolved directory would make every check below vacuous.
    expect(existsSync(VIEWS_DIR)).toBe(true);
  });
  const covered = new Set(STATE_CASES.map((kase) => kase.view));

  it('leaves no view with a load path uncovered and unexplained', () => {
    const unaccounted = loading.filter(
      (view) => !covered.has(view) && EXEMPT_VIEWS[view] === undefined,
    );

    expect(unaccounted).toEqual([]);
  });

  it('exempts only views that still have a load path', () => {
    // An exemption for a view that no longer reads anything is stale
    // advice about a problem that has gone.
    const stale = Object.keys(EXEMPT_VIEWS)
      .filter((view) => !loading.includes(view))
      .sort();

    expect(stale).toEqual([]);
  });

  it('covers a view in exactly one direction', () => {
    const both = [...covered].filter((view) => EXEMPT_VIEWS[view] !== undefined).sort();

    expect(both).toEqual([]);
  });

  it('names a load for every case', () => {
    const silent = STATE_CASES.filter((kase) => kase.loads.length === 0).map(
      (kase) => `${kase.view} — ${kase.name}`,
    );

    expect(silent).toEqual([]);
  });

  it('still finds the load paths the pack was measured against', () => {
    // The panel measured "~27 dead-end load failures" across the client.
    // Twenty-seven views carry a mount load path; the floor is here so a
    // detector that quietly stops matching cannot make the inventory
    // pass by finding nothing.
    expect(loading.length).toBeGreaterThanOrEqual(27);
  });
});
