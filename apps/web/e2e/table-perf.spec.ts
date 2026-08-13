import { expect, test, type Page } from '@playwright/test';
import { json, mockWorkspace, workBalance, WORK_ID } from './fixtures.js';

/* Dense-table performance guards.
 *
 * The flagship corpus Work carries 129 schedule items, so the delivery
 * challan editor puts 129 controlled inputs on one screen. Three things
 * are measured on the real production bundle, because none of them can be
 * argued from the source:
 *
 * 1. How many table rows React re-renders for a single keystroke. Before
 *    the fix this suite ships with, the answer was all 129 — the row
 *    markup was inline in the editor and the change handler cloned the
 *    whole quantity record — for an edit confined to one box.
 * 2. How many commits a keystroke costs, which catches the other shape of
 *    the same failure: an effect that re-renders the tree a second and
 *    third time after every character.
 * 3. Whether anything the screen does blocks the main thread long enough
 *    to be felt. The browser's own `longtask` threshold is 50ms; 200ms is
 *    where typing visibly stops keeping up.
 *
 * The measurements come from React's own devtools hook, installed as a
 * counting stub before the bundle loads. React calls it in production
 * builds — that is how the devtools extension works on a deployed site —
 * and it hands over the committed fiber tree, which is the only place the
 * answer to (1) exists. A component React re-rendered gets a different
 * fiber object; a component it skipped (a `memo` that bailed out) keeps
 * the one it had. Counting `<tr>` fibers whose identity changed across one
 * keystroke is therefore an exact count of rows re-rendered.
 */

/** The corpus Work's item count, and the reason this file exists. */
const ITEM_COUNT = 129;

/** What one keystroke may cost. Not one commit and one row, because React
 * legitimately commits again for state a controlled input schedules
 * alongside its value, and the row being typed into must of course
 * re-render. */
const MAX_COMMITS_PER_KEYSTROKE = 3;
const MAX_ROWS_RERENDERED_PER_KEYSTROKE = 3;

/** Long enough that a person notices the keyboard falling behind. */
const MAX_LONG_TASK_MS = 200;

/** A row being typed into, chosen from the middle of the table so a
 * fix that only shortcuts the first or last row would not pass. */
const TARGET_ROW_LABEL = 'Quantity of A-064 on this challan';

interface PerfState {
  commits: number;
  root: { current?: unknown } | null;
  longTasks: number[];
}

declare global {
  interface Window {
    __perf?: PerfState;
    /** Every `<tr>` fiber in the committed tree, by object identity. */
    __collectRows?: () => unknown[];
  }
}

/** Installs the counting devtools hook, the fiber walker and the
 * long-task observer, all before any application code runs. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const perf: PerfState = { commits: 0, root: null, longTasks: [] };
    window.__perf = perf;

    const renderers = new Map<number, unknown>();
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        renderers,
        supportsFiber: true,
        inject(renderer: unknown) {
          const id = renderers.size + 1;
          renderers.set(id, renderer);
          return id;
        },
        onCommitFiberRoot(_id: number, root: { current?: unknown }) {
          perf.commits += 1;
          perf.root = root;
        },
        onPostCommitFiberRoot() {},
        onCommitFiberUnmount() {},
        checkDCE() {},
      },
    });

    window.__collectRows = () => {
      const start = perf.root?.current;
      if (start === undefined || start === null) return [];
      const rows: unknown[] = [];
      const stack: unknown[] = [start];
      while (stack.length > 0) {
        const fiber = stack.pop() as {
          stateNode?: unknown;
          child?: unknown;
          sibling?: unknown;
        } | null;
        if (fiber === null || fiber === undefined) continue;
        if (fiber.stateNode instanceof HTMLTableRowElement) rows.push(fiber);
        if (fiber.child !== null && fiber.child !== undefined) stack.push(fiber.child);
        if (fiber.sibling !== null && fiber.sibling !== undefined) {
          stack.push(fiber.sibling);
        }
      }
      return rows;
    };

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longTasks.push(entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
}

/** The Work behind the editor, and the three convenience reads it makes
 * alongside the balance. */
async function mockChallanEditor(page: Page, itemCount: number) {
  await mockWorkspace(page);
  await page.route(`**/api/works/${WORK_ID}`, (route) =>
    route.fulfill(
      json({
        work: {
          id: WORK_ID,
          workCode: 'PL270-CRB',
          title: 'Signalling gear, CR Bhusawal',
          status: 'active',
        },
        schedules: [],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/balance`, (route) =>
    route.fulfill(json(workBalance(itemCount))),
  );
  await page.route(`**/api/works/${WORK_ID}/consignees`, (route) =>
    route.fulfill(json({ consignees: [] })),
  );
  await page.route(`**/api/works/${WORK_ID}/purchase-orders*`, (route) =>
    route.fulfill(json({ purchaseOrders: [] })),
  );
}

/** Two animation frames, which is when a commit's work has landed. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
}

async function awaitEditor(page: Page) {
  const table = page.getByRole('table', { name: /Work items with awarded/ });
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(ITEM_COUNT);
  await settle(page);
  return table;
}

async function openEditor(page: Page) {
  await page.goto(`/#/works/${WORK_ID}/challans/new`);
  return awaitEditor(page);
}

/** Drops whatever has been recorded so far, so a measurement starts from
 * a known-idle page. */
async function resetMeasurements(page: Page) {
  await page.evaluate(() => {
    if (window.__perf === undefined) return;
    window.__perf.commits = 0;
    window.__perf.longTasks = [];
  });
}

function longTaskReport(durations: readonly number[]) {
  return durations.map((duration) => String(Math.round(duration))).join(', ') || 'none';
}

test('typing in a 129-item challan editor re-renders only the row typed into', async ({
  page,
}) => {
  await instrument(page);
  await mockChallanEditor(page, ITEM_COUNT);
  await openEditor(page);

  // The editor is open and idle. Everything measured from here is the
  // cost of typing into it.
  await resetMeasurements(page);

  const target = page.getByLabel(TARGET_ROW_LABEL);
  await target.click();
  await settle(page);

  // Twelve characters rather than one: a single sample is noise, and the
  // failure this guards is per-keystroke work that accumulates.
  const commitsPerKeystroke: number[] = [];
  const rowsPerKeystroke: number[] = [];
  for (const character of '123456789012') {
    const before = await page.evaluateHandle(() => window.__collectRows?.() ?? []);
    const commitsBefore = await page.evaluate(() => window.__perf?.commits ?? 0);

    await target.press(character);
    await settle(page);

    const measured = await page.evaluate((previous: unknown[]) => {
      const seen = new Set(previous);
      const rows = window.__collectRows?.() ?? [];
      let changed = 0;
      for (const row of rows) if (!seen.has(row)) changed += 1;
      return { rows: changed, commits: window.__perf?.commits ?? 0 };
    }, before);
    await before.dispose();

    commitsPerKeystroke.push(measured.commits - commitsBefore);
    rowsPerKeystroke.push(measured.rows);
  }

  const worstRows = Math.max(...rowsPerKeystroke);
  expect(
    worstRows,
    `one character re-rendered ${String(worstRows)} table rows of the ` +
      `${String(ITEM_COUNT + 1)} on screen (${String(ITEM_COUNT)} items and the ` +
      'column heading); only the row being typed into should re-render ' +
      `(per keystroke: ${rowsPerKeystroke.join(', ')})`,
  ).toBeLessThanOrEqual(MAX_ROWS_RERENDERED_PER_KEYSTROKE);

  const worstCommits = Math.max(...commitsPerKeystroke);
  expect(
    worstCommits,
    `one character cost ${String(worstCommits)} React commits (per keystroke: ` +
      `${commitsPerKeystroke.join(', ')})`,
  ).toBeLessThanOrEqual(MAX_COMMITS_PER_KEYSTROKE);

  const longTasks = await page.evaluate(() => window.__perf?.longTasks ?? []);
  const worstTask = longTasks.length === 0 ? 0 : Math.max(...longTasks);
  expect(
    Math.round(worstTask),
    `the longest main-thread task while typing was ${String(Math.round(worstTask))}ms ` +
      `(all: ${longTaskReport(longTasks)})`,
  ).toBeLessThan(MAX_LONG_TASK_MS);
});

test('opening a 129-item challan editor blocks the main thread only briefly', async ({
  page,
}) => {
  await instrument(page);
  await mockChallanEditor(page, ITEM_COUNT);

  // Opened from the Dashboard rather than by loading the URL directly, and
  // measured only from that point: a cold load also parses the entry
  // chunk and boots the shell, which is a different cost with a different
  // owner and on a loaded CI runner is easily the longest task on the
  // page. What is measured here is what building the dense table costs.
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await settle(page);
  await resetMeasurements(page);

  await page.evaluate((workId) => {
    window.location.hash = `#/works/${workId}/challans/new`;
  }, WORK_ID);
  await awaitEditor(page);

  const longTasks = await page.evaluate(() => window.__perf?.longTasks ?? []);
  const worstTask = longTasks.length === 0 ? 0 : Math.max(...longTasks);
  expect(
    Math.round(worstTask),
    'the longest main-thread task while opening the editor was ' +
      `${String(Math.round(worstTask))}ms (all: ${longTaskReport(longTasks)})`,
  ).toBeLessThan(MAX_LONG_TASK_MS);
});
