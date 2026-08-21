import { expect, test, type Locator, type Page } from '@playwright/test';
import { DOC_ID, location, mockWorkspace, reviewDocument } from './fixtures.js';

/* Field-usability guards.
 *
 * Two failures this suite exists to catch, both measured on the shipped
 * bundle rather than argued from the source:
 *
 * 1. A register wider than the phone takes the whole page's width with it,
 *    so the operator drags the shell — rail, header and all — sideways to
 *    read a quantity. The page must never scroll horizontally; a table too
 *    wide for the screen scrolls inside its own container.
 *
 * 2. A heading that sticks to the top of the viewport lands underneath the
 *    shell header, which is itself sticky and 4.5rem tall. The heading is
 *    then invisible for exactly the rows it exists to label.
 *
 * Both run at every configured viewport, because 1280 is the one width at
 * which neither failure is visible. */

/** The shell header's height, as `globals.css` declares it. Read from the
 * page rather than assumed, so the guard follows the token. */
async function headerHeight(page: Page) {
  const box = await boxOf(page.getByRole('banner'));
  return box.y + box.height;
}

/** Every element whose box escapes the viewport, deepest first, each
 * annotated with the scrolling ancestor that excuses it (or `page` when
 * nothing does). Named in the failure message so a fix has an address. */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const limit = window.innerWidth;
    const describe = (element: Element) => {
      const classes = (element.getAttribute('class') ?? '').split(/\s+/);
      return `${element.tagName.toLowerCase()}${classes[0] === '' ? '' : `.${classes.slice(0, 3).join('.')}`}`;
    };
    const escaping: string[] = [];
    for (const element of document.body.querySelectorAll('*')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.right <= limit + 1) continue;
      let ancestor = element.parentElement;
      let scroller = 'page';
      while (ancestor !== null) {
        if (window.getComputedStyle(ancestor).overflowX !== 'visible') {
          scroller = describe(ancestor);
          break;
        }
        ancestor = ancestor.parentElement;
      }
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
      escaping.push(
        `${describe(element)} → right ${String(Math.round(box.right))}px, contained by ${scroller}${text === '' ? '' : ` ("${text}")`}`,
      );
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      escaping: escaping.slice(0, 8),
    };
  });
}

const NO_OVERFLOW = 'the page does not scroll sideways';

/* Polled rather than sampled once: a view that mounts in pieces can be
 * momentarily wider than the screen before its data arrives, and that is
 * not the failure being guarded. What is guarded is a page that stays
 * wider than the screen once it has settled. */
async function expectNoHorizontalOverflow(page: Page, context: string) {
  await expect
    .poll(
      async () => {
        const measured = await horizontalOverflow(page);
        return measured.scrollWidth <= measured.innerWidth
          ? NO_OVERFLOW
          : `${context}: scrollWidth ${String(measured.scrollWidth)} > innerWidth ${String(measured.innerWidth)}. Escaping boxes: ${measured.escaping.join(' | ') || 'none'}`;
      },
      { timeout: 5_000, message: `${context} must not scroll sideways` },
    )
    .toBe(NO_OVERFLOW);
}

async function boxOf(locator: Locator) {
  const box = await locator.first().boundingBox();
  if (box === null) throw new Error('element has no box');
  return box;
}

/* The three lengths `globals.css` reserves above a ledger's own
 * scrollport, restated here so the guard can say what it expects rather
 * than recompute the rule it is checking. */
const HEADER_PX = 64;
const SCHEDULE_SUMMARY_PX = 44;
const PAGE_INSET_PX = 32;

/** Two animation frames — layout has settled by the second, and it costs
 * nothing when the page was already still. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
}

/** Scrolls a ledger's own scrollport to the far end of its rows, which is
 * the state its heading exists for. */
async function scrollLedgerToEnd(wrapper: Locator) {
  await wrapper.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await settle(wrapper.page());
}

/** The wrapper a DataTable puts around itself: the ledger's scrollport. */
function scrollportOf(table: Locator) {
  return table.locator('xpath=..');
}

/** The registers an operator reaches in a working day, each opened by its
 * own hash so the assertion does not depend on a navigation rail that only
 * exists above 1024px.
 *
 * Masters and Settings were held out of this list when it was written,
 * each carrying a measured 320px overflow with nothing to do with a table:
 * the Masters category strip was a row of unwrapped buttons reaching 445px,
 * and Settings settled at 432px on the organisation cards inside
 * `views/OrganisationAccessSettings.tsx`. Both are fixed and both are in
 * the list; nothing is held out now. */
const SCREENS = [
  { hash: '#/', name: 'dashboard', ready: 'Dashboard' },
  { hash: '#/works', name: 'works register', ready: 'Works' },
  { hash: '#/members', name: 'members', ready: 'Members' },
  { hash: '#/masters/locations', name: 'masters', ready: 'Masters' },
  { hash: '#/settings', name: 'settings', ready: 'Settings' },
  { hash: `#/loa/${DOC_ID}`, name: 'LOA review', ready: /Review loa-letter\.pdf/ },
] as const;

test('no register makes the page scroll sideways', async ({ page }) => {
  await mockWorkspace(page, {
    locations: Array.from({ length: 60 }, (_unused, index) => location(index)),
    document: reviewDocument(30),
  });

  for (const screen of SCREENS) {
    await page.goto(`/${screen.hash}`);
    await expect(page.getByRole('heading', { name: screen.ready })).toBeVisible();
    await expectNoHorizontalOverflow(page, screen.name);
  }
});

/** Parks an element's top just below the shell header — where an operator
 * who has just scrolled to a register leaves the page. */
async function parkUnderHeader(page: Page, element: Locator, headerBottom: number) {
  await element.evaluate((node, offset) => {
    window.scrollTo({
      top: node.getBoundingClientRect().top + window.scrollY - offset,
      // globals.css asks for smooth scrolling, and a measurement taken
      // mid-animation reports where the page was, not where it was sent.
      behavior: 'instant',
    });
  }, headerBottom);
  await settle(page);
}

test('a long register shows its column headings beside its last row', async ({
  page,
}) => {
  await mockWorkspace(page, {
    locations: Array.from({ length: 60 }, (_unused, index) => location(index)),
  });

  await page.goto('/#/masters/locations');
  const register = page.getByRole('table', { name: 'Location masters' });
  await expect(register).toBeVisible();

  const headerBottom = await headerHeight(page);
  const viewportHeight = page.viewportSize()?.height ?? 0;
  const scrollport = scrollportOf(register);

  // The reading position, then the far end of the rows. Sixty locations do
  // not fit on any of the three screens, so reaching the last one is a
  // scroll in every case; the question is what the scroll costs.
  await parkUnderHeader(page, scrollport, headerBottom);
  await scrollLedgerToEnd(scrollport);

  const heading = await boxOf(register.locator('thead th').first());
  const lastRow = await boxOf(register.locator('tbody tr').last());

  expect(
    Math.round(heading.y),
    `the column heading sits at ${String(Math.round(heading.y))}px, behind the shell header whose bottom edge is ${String(Math.round(headerBottom))}px`,
  ).toBeGreaterThanOrEqual(Math.round(headerBottom) - 1);
  expect(
    Math.round(heading.y + heading.height),
    'the column heading is off the bottom of the screen',
  ).toBeLessThanOrEqual(viewportHeight);
  // The point of a heading that survives the scroll: the sixtieth row and
  // the words naming its columns are on screen together. Without a
  // scrollport of its own the register runs thousands of pixels down the
  // page, and reaching row 60 means the headings left long ago.
  expect(
    Math.round(lastRow.y + lastRow.height),
    `the last row sits at ${String(Math.round(lastRow.y))}px, off a ${String(viewportHeight)}px screen whose headings are at ${String(Math.round(heading.y))}px — the two are never visible together`,
  ).toBeLessThanOrEqual(viewportHeight);
});

test('a schedule summary and the ledger inside it stack under the shell header', async ({
  page,
}) => {
  await mockWorkspace(page, { document: reviewDocument(30) });

  await page.goto(`/#/loa/${DOC_ID}`);
  await expect(
    page.getByRole('heading', { name: /Review loa-letter\.pdf/ }),
  ).toBeVisible();

  const summary = page.getByRole('heading', { name: /Schedule A/ });
  const ledger = page.getByRole('table', { name: /Awarded items in schedule A/ });
  await expect(ledger).toBeVisible();

  // Park the schedule's own top well above the shell header, so its sticky
  // summary is doing its job rather than merely sitting where it was laid
  // out. `behavior: 'instant'` because globals.css asks for smooth
  // scrolling, and a measurement taken mid-animation reports where the
  // page was, not where it was sent.
  const headerBottom = await headerHeight(page);
  await parkUnderHeader(page, summary, headerBottom - 300);
  const summaryBox = await boxOf(summary);
  expect(
    Math.round(summaryBox.y),
    `the schedule summary sits at ${String(Math.round(summaryBox.y))}px, behind the shell header ending at ${String(Math.round(headerBottom))}px`,
  ).toBeGreaterThanOrEqual(Math.round(headerBottom) - 1);

  /* The ledger heading inside the schedule cannot be measured at the same
   * scroll position: it is pinned to the top of the ledger's own
   * scrollport, and at this scroll offset that scrollport has been carried
   * up the page with the rest of the section. What is asserted instead is
   * the reservation that makes the stacking true wherever the schedule is
   * read — the scrollport is capped to the screen minus the shell header,
   * minus the summary row that sits under it, minus the page's own bottom
   * inset. On the pre-fix tree there is no scrollport at all and the
   * measurement is `none`. */
  const cap = await scrollportOf(ledger).evaluate(
    (node) => window.getComputedStyle(node).maxHeight,
  );
  const viewportHeight = page.viewportSize()?.height ?? 0;
  const reserved = HEADER_PX + SCHEDULE_SUMMARY_PX + PAGE_INSET_PX;
  expect(
    cap,
    `the ledger inside a schedule reserves no room for the shell header and the summary above it (max-height ${cap})`,
  ).toBe(`${String(viewportHeight - reserved)}px`);
});

test('prose cells wrap instead of painting over their neighbours', async ({
  page,
}) => {
  await mockWorkspace(page, { document: reviewDocument(30) });

  await page.goto(`/#/loa/${DOC_ID}`);
  await expect(
    page.getByRole('heading', { name: /Review loa-letter\.pdf/ }),
  ).toBeVisible();

  /* Regression guard for the overlap defect found in live testing
   * (2026-08-21). `wrapCell`'s `whitespace-normal` sat at specificity
   * 0-1-0 under the DataTable default `[&_td]:whitespace-nowrap` (a
   * descendant selector at 0-1-1), so every "wrapping" cell computed to
   * nowrap — while its `overflow-wrap:anywhere` still let the table-layout
   * algorithm shrink the column, and the unwrappable text painted across
   * the neighbouring cells. Both halves are asserted on a rendered cell:
   * the computed style, and that the glyphs stay inside the cell's box. */
  const prose = page.locator('td.whitespace-normal').first();
  await expect(prose).toBeVisible();
  expect(
    await prose.evaluate((node) => window.getComputedStyle(node).whiteSpace),
    'a wrapCell td must compute white-space: normal, not inherit the register default',
  ).toBe('normal');
  const overflow = await prose.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(
    overflow,
    `the prose cell's text escapes its box by ${String(overflow)}px and paints over the next column`,
  ).toBeLessThanOrEqual(1);
});

test('a register too wide for the screen scrolls inside its own container', async ({
  page,
}) => {
  await mockWorkspace(page, {
    locations: Array.from({ length: 12 }, (_unused, index) => location(index)),
  });

  await page.goto('/#/masters/locations');
  const register = page.getByRole('table', { name: 'Location masters' });
  await expect(register).toBeVisible();

  // The scrollport is the operator's only way to reach a column that does
  // not fit, so it has to be reachable from the keyboard and announced as
  // the region it is — not a silent div that only a trackpad can move.
  const scrollport = scrollportOf(register);
  await expect(scrollport).toHaveAttribute('role', 'region');
  await expect(scrollport).toHaveAttribute('aria-labelledby', /.+/);
  expect(
    await scrollport.evaluate((node) => window.getComputedStyle(node).overflowX),
  ).toBe('auto');
  // Named by the caption the register already carries, rather than by a
  // second string that would drift from it.
  await expect(scrollport).toHaveAccessibleName('Location masters');

  /* The tab stop is conditional, and this is the condition.
   *
   * A box that scrolls must be focusable; a box whose content fits must
   * not be, because an operator on a desk screen would otherwise tab
   * through one dead stop per register — up to a dozen on a Work
   * workspace — before reaching a control. The same register is measured
   * at every viewport this suite runs, so the assertion reads the box
   * rather than assuming which way it went at this width. */
  const overflows = await scrollport.evaluate(
    (node) =>
      node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight,
  );
  if (overflows) {
    await expect(scrollport).toHaveAttribute('tabindex', '0');
  } else {
    await expect(scrollport).not.toHaveAttribute('tabindex', '0');
  }
});
