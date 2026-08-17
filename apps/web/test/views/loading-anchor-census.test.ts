import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The loading-anchor census.
 *
 * The failure class, recorded in §2.7 of the improvement programme after
 * it bit twice: a test awaits an element that the view's LOADING branch
 * also renders — typically `findByRole('heading', { name: 'Settings' })`
 * — and then reads content that only exists once the fetch has resolved.
 * The await resolves against the loading state, so everything after it
 * races the mocked promise and passes by scheduling luck. Locally it
 * always won; on the CI runner, an unrelated pack's extra test file
 * changed the scheduling twice (`masters-settings.test.tsx`, then
 * `search.test.tsx` on P14) and the race was lost.
 *
 * The mechanical signature this file holds: in this codebase a view's
 * loading branch renders its static heading beside the wait indicator
 * ("Settings" above a LoadingState, "Dashboard" above the skeleton row),
 * while loaded headings carry fetched data ("Delivery Challan DC/1",
 * "Review loa-letter.pdf"). So a heading whose accessible name is a
 * static string from the source is present while the view loads, and a
 * test must not use it as an anchor. The convention enforced here is the
 * one commit e318caa established by hand: anchor on content that is
 * provably absent during LOADING — data-bearing text, a result region,
 * a labelled field of the loaded form — and read the static heading
 * afterwards with a synchronous query if it matters.
 *
 * Two halves, in the style of the state-coverage guard:
 * - the source half derives, from every return block that contains a
 *   loading marker, the static heading names that render while that
 *   view loads;
 * - the census half finds every `findByRole('heading', …)` in the test
 *   tree and fails if its name matcher can resolve against one of those
 *   loading-visible names, unless the site is exempt below with a
 *   stated reason and a pinned count.
 *
 * The pinned count is the ratchet: a new await on an exempted name in
 * an exempted file still fails the census, so it gets adjudicated
 * rather than inherited.
 */

/* Resolved from the runner's root, matching state-coverage-inventory:
 * vitest's root for this package is apps/web. */
const SRC_DIR = join(process.cwd(), 'src');
const TEST_DIR = join(process.cwd(), 'test');
const SELF = 'loading-anchor-census.test.ts';

/**
 * What marks a return block as rendering a wait. Three shapes exist in
 * the client: the shared `<LoadingState>`, the dashboard's bespoke
 * skeleton under `aria-busy`, and the inline "Loading Works…" status
 * paragraphs. The ellipsis is load-bearing — every loading copy in the
 * client ends in one, and it keeps prose like "loaded" out.
 */
const LOADING_MARKER = /<LoadingState|aria-busy|Loading[^<{…]*…/g;

function* filesUnder(dir: string, extensions: readonly string[]): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* filesUnder(path, extensions);
    else if (extensions.some((extension) => path.endsWith(extension))) yield path;
  }
}

/** The balanced-parenthesis span of the `return (` enclosing `at`, or
 * null when the marker sits outside one. Crude next to a parser and
 * exact enough here: the only thing asked of it is which headings share
 * a return with a wait indicator. */
function enclosingReturnBlock(source: string, at: number): string | null {
  const start = source.lastIndexOf('return (', at);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start + 'return '.length; i < source.length; i++) {
    const character = source[i];
    if (character === '(') depth++;
    else if (character === ')') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** Static heading texts in a JSX span. A capture containing `{` is
 * interpolated — its rendered name carries data, which is exactly what
 * makes a heading a safe anchor — so it is dropped rather than listed.
 *
 * Two shapes count as a heading. The literal `<h1>` a view writes itself,
 * and `ui/page-header.tsx`, which renders the `<h1>` for it from a `title`
 * prop. The second has to be read here or a view loses its census entry
 * the moment it adopts the shared header — the heading would still be on
 * screen, still be the thing a test awaits, and simply stop being counted,
 * which is the failure this census exists to catch. Only the
 * double-quoted form is static; `title={...}` is interpolated and drops
 * out under the same rule as an interpolated `<h1>`. */
function staticHeadingTexts(span: string): readonly string[] {
  const texts: string[] = [];
  const heading = /<h[1-6][^>]*>\s*([^<]*?)\s*<\//g;
  let match = heading.exec(span);
  while (match !== null) {
    const text = (match[1] as string).replace(/\s+/g, ' ').trim();
    if (text.length > 0 && !text.includes('{')) texts.push(text);
    match = heading.exec(span);
  }
  const pageHeader = /<PageHeader\b[^>]*?\stitle="([^"]*)"/g;
  let header = pageHeader.exec(span);
  while (header !== null) {
    const text = (header[1] as string).replace(/\s+/g, ' ').trim();
    if (text.length > 0) texts.push(text);
    header = pageHeader.exec(span);
  }
  return texts;
}

/** name → the source files whose loading branch renders a heading with
 * that name. */
function loadingVisibleHeadings(): ReadonlyMap<string, readonly string[]> {
  const names = new Map<string, string[]>();
  for (const file of filesUnder(SRC_DIR, ['.tsx'])) {
    const source = readFileSync(file, 'utf8');
    const seen = new Set<string>();
    let marker = LOADING_MARKER.exec(source);
    while (marker !== null) {
      const block = enclosingReturnBlock(source, marker.index);
      if (block !== null) {
        for (const text of staticHeadingTexts(block)) seen.add(text);
      }
      marker = LOADING_MARKER.exec(source);
    }
    LOADING_MARKER.lastIndex = 0;
    for (const text of seen) {
      const holders = names.get(text) ?? [];
      holders.push(relative(SRC_DIR, file).replaceAll('\\', '/'));
      names.set(text, holders);
    }
  }
  return names;
}

interface HeadingQuery {
  readonly file: string;
  readonly line: number;
  /** The `name:` matcher, decoded. */
  readonly matcher:
    | { readonly kind: 'string'; readonly value: string }
    | { readonly kind: 'regex'; readonly value: RegExp }
    | { readonly kind: 'data' } // template literal with an interpolation
    | { readonly kind: 'unresolvable'; readonly raw: string };
}

/** Comments blanked to spaces, so a comment that QUOTES the raced shape
 * (review-loa-departure documents one) is not censused as an occurrence
 * — and every offset and line number survives unmoved. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/[^\n]*$/gm, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** Every `findByRole('heading', …)` / `findAllByRole('heading', …)` in
 * the test tree. `getBy`/`queryBy` are synchronous and cannot anchor a
 * wait, so they are not the hazard and are not collected. */
function headingQueries(): readonly HeadingQuery[] {
  const queries: HeadingQuery[] = [];
  for (const path of filesUnder(TEST_DIR, ['.ts', '.tsx'])) {
    if (path.endsWith(SELF)) continue;
    const source = withoutComments(readFileSync(path, 'utf8'));
    const file = relative(TEST_DIR, path).replaceAll('\\', '/');
    const query = /find(?:All)?ByRole\(\s*['"]heading['"]/g;
    let match = query.exec(source);
    while (match !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      const options = enclosingCallArguments(source, match.index);
      queries.push({ file, line, matcher: nameMatcherIn(options) });
      match = query.exec(source);
    }
  }
  return queries;
}

/** The balanced argument span of the call starting at `at`. */
function enclosingCallArguments(source: string, at: number): string {
  const open = source.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const character = source[i];
    if (character === '(') depth++;
    else if (character === ')') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function nameMatcherIn(options: string): HeadingQuery['matcher'] {
  const name =
    /name:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`|\/((?:[^/\\]|\\.)+)\/([a-z]*)|([^,}]+))/.exec(
      options,
    );
  if (name === null) {
    // No name narrows the query to nothing: it resolves against the
    // first heading in the tree, loading branch included.
    return { kind: 'unresolvable', raw: '(no name option)' };
  }
  const literal = name[1] ?? name[2];
  if (literal !== undefined)
    return { kind: 'string', value: literal.replace(/\\(.)/g, '$1') };
  if (name[3] !== undefined) {
    return name[3].includes('${')
      ? { kind: 'data' }
      : { kind: 'string', value: name[3] };
  }
  if (name[4] !== undefined)
    // eslint-disable-next-line security/detect-non-literal-regexp -- rebuilding a regex literal read out of test source, to ask it the same question the runtime would
    return { kind: 'regex', value: new RegExp(name[4], name[5] ?? '') };
  return { kind: 'unresolvable', raw: (name[6] ?? '').trim() };
}

function resolvesAgainstLoading(
  matcher: HeadingQuery['matcher'],
  loadingNames: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  switch (matcher.kind) {
    case 'string': {
      const holders = loadingNames.get(matcher.value);
      return holders === undefined ? [] : holders;
    }
    case 'regex':
      return [...loadingNames.entries()]
        .filter(([name]) => matcher.value.test(name))
        .flatMap(([, holders]) => holders);
    case 'data':
      return [];
    case 'unresolvable':
      // A matcher the census cannot read — a variable, a function, a
      // missing name — must not silently pass; it is treated as if it
      // matched, and either rewritten to a literal or exempted.
      return ['(unresolvable matcher)'];
  }
}

/**
 * Sites allowed to await a loading-visible heading, each with the reason
 * it is not a race and a pinned count. The recurring legitimate shape is
 * the navigation-arrival await: the test waits for a screen's heading to
 * prove ROUTING happened, and everything it reads afterwards is
 * workspace chrome (rail, header controls, document.title, the hash) or
 * another awaited element — never that screen's fetched content.
 */
const EXEMPT: Readonly<
  Record<
    string,
    Readonly<Record<string, { readonly count: number; readonly reason: string }>>
  >
> = {
  'views/workspace-shell.test.tsx': {
    Dashboard: {
      count: 7,
      reason:
        'Navigation-arrival awaits: each proves the shell routed to the dashboard, then reads only chrome (header buttons, drawer, skip link, document.title, the hash) or ends the test. None read dashboard data.',
    },
    Works: {
      count: 4,
      reason:
        'Navigation-arrival awaits after rail clicks and departure confirms; the reads that follow are document.title, the hash, and closed-menu absence checks — chrome, not the Works register.',
    },
    Settings: {
      count: 1,
      reason:
        'Terminal assertion of the hashchange test: arriving at Settings is the fact under test, and nothing is read after it.',
    },
  },
  'views/search.test.tsx': {
    Dashboard: {
      count: 4,
      reason:
        'The `/`-shortcut and header-search tests wait for the workspace to mount, then touch only the header searchbox and the keyboard — chrome that renders regardless of the dashboard fetch.',
    },
  },
  'views/work-detail.test.tsx': {
    'Measurement evidence': {
      count: 1,
      reason:
        'Section-arrival await: clicking the summary card switches the tab synchronously, and the read that follows is the tab rail’s aria-current — chrome, not the measurement register.',
    },
  },
  'views/review-loa-departure.test.tsx': {
    Dashboard: {
      count: 2,
      reason:
        'Departure-arrival awaits: reaching the dashboard proves the review screen let go. The only read after is the absence of the departure dialog, which concerns the screen that was left, not dashboard data.',
    },
    Works: {
      count: 1,
      reason:
        'Departure-arrival await after a discard: reaching Works is the assertion, followed only by the dialog-absence check.',
    },
  },
};

describe('loading-anchor census', () => {
  const loadingNames = loadingVisibleHeadings();
  const queries = headingQueries();

  it('reads the trees it claims to', () => {
    expect(existsSync(SRC_DIR)).toBe(true);
    expect(existsSync(TEST_DIR)).toBe(true);
  });

  it('still derives the loading headings the class was discovered on', () => {
    // The canary: the two bites and the sweep of e318caa. A detector
    // that stops seeing these has broken, whatever else it finds.
    for (const name of [
      'Settings', // masters-settings, the first bite
      'Search', // search.test on P14, the second
      'Dashboard', // workspace-shell, fixed in the sweep
      'Works',
      'Installations', // site-evidence, fixed in the sweep
      'PAC certificates',
      'Review LOA', // review-loa-departure, fixed in the sweep
    ]) {
      expect(loadingNames.has(name), `expected ${name} to be loading-visible`).toBe(
        true,
      );
    }
  });

  it('finds the heading queries it audits', () => {
    // Well below the ~70 in the tree today, and high enough that a
    // pattern that quietly stops matching cannot pass by finding none.
    expect(queries.length).toBeGreaterThanOrEqual(30);
  });

  it('never awaits a heading the loading state also renders', () => {
    const allowance = new Map<string, number>();
    const raced: string[] = [];
    for (const query of queries) {
      const holders = resolvesAgainstLoading(query.matcher, loadingNames);
      if (holders.length === 0) continue;
      const name =
        query.matcher.kind === 'string'
          ? query.matcher.value
          : query.matcher.kind === 'regex'
            ? String(query.matcher.value)
            : query.matcher.kind === 'unresolvable'
              ? query.matcher.raw
              : '(data matcher)';
      const exemption = EXEMPT[query.file]?.[name];
      if (exemption !== undefined) {
        allowance.set(
          `${query.file} :: ${name}`,
          (allowance.get(`${query.file} :: ${name}`) ?? 0) + 1,
        );
        continue;
      }
      raced.push(
        `${query.file}:${String(query.line)} awaits heading ${JSON.stringify(name)}, which renders during loading in ${holders.join(', ')} — anchor on loaded-only content first (see §2.7 of docs/IMPROVEMENT-PROGRAMME-2026-08-13.md)`,
      );
    }
    expect(raced).toEqual([]);

    // The pinned counts, both directions: a new await on an exempted
    // name is adjudicated, and an exemption whose sites are gone is
    // deleted rather than left as standing permission.
    const drift: string[] = [];
    for (const [file, names] of Object.entries(EXEMPT)) {
      for (const [name, { count }] of Object.entries(names)) {
        const found = allowance.get(`${file} :: ${name}`) ?? 0;
        if (found !== count) {
          drift.push(
            `${file} :: ${name} — exempted ${String(count)}, found ${String(found)}`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('exempts only names that are still loading-visible', () => {
    const stale = Object.values(EXEMPT)
      .flatMap((names) => Object.keys(names))
      .filter((name) => !loadingNames.has(name));
    expect(stale).toEqual([]);
  });
});
