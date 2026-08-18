import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, mockWorkspace } from './fixtures.js';

/*
 * The offline shell, proved on the real bundle (`docs/UX.md` § 23).
 *
 * Everything here is measured rather than argued, because every claim
 * this pack makes is about a browser doing something the source cannot
 * show: a service worker holding the document, a register answering from
 * a copy, and a write refused before it is sent.
 *
 * The suite drives two different kinds of "offline" on purpose, and the
 * distinction matters:
 *
 *   - `context.setOffline(true)` is what the PAGE sees. It sets
 *     `navigator.onLine` to false and fires the event, which is what the
 *     banner and the write refusal key on. It does NOT stop Playwright's
 *     own route handlers from answering, so the mocked API keeps working
 *     — which is exactly the moment a connection drops with a screen
 *     already loaded.
 *   - aborting the API routes is what the SERVER becoming unreachable
 *     looks like. Added on top when the test needs a read to fail.
 */

/** Waits until the registered worker is actually controlling this page.
 * `activate` calls `clients.claim()`, so this resolves on the first load
 * rather than needing a reload to take effect. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 20_000,
  });
}

/** Everything the application would send to the server, refused at the
 * wire. Registered after `mockWorkspace`, so it wins: Playwright matches
 * the last handler registered. */
async function cutTheServer(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
}

/* Each test registers a worker against the same origin, and a worker
 * outlives the page that installed it. Serial, so one test's worker
 * cannot be mid-install while the next is asserting what a fresh load
 * does. */
test.describe.configure({ mode: 'serial' });

test('the shell opens with no connection, serves the register it last read, and refuses writes', async ({
  page,
  context,
}) => {
  /* Four axe scans in two themes each, on top of a service-worker
     install and two reloads. */
  test.slow();

  await mockWorkspace(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await waitForServiceWorker(page);

  /* The Dashboard's register is now in the read cache: the operator has
     seen it, which is the only thing that puts anything there. */
  await expect(page.getByText('PL270-CRB').first()).toBeVisible();

  /* Settings is opened while there is still a connection, which is what
     puts its code-split chunk in the worker's cache. Nothing about this
     is a test convenience: a screen the operator has never opened cannot
     be opened offline, and the pack does not pretend otherwise
     (`docs/UX.md` § 23). */
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // ---------------------------------------------------------------- 1.
  // The connection drops with the screen already open. The API is still
  // answering, because that is what a dropped signal looks like from the
  // inside for the first few seconds.
  await context.setOffline(true);

  const banner = page.getByRole('status').filter({ hasText: 'This device is offline' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Nothing can be created, changed or issued');
  await expectNoAxeViolations(page, 'offline banner over an open screen');

  // ---------------------------------------------------------------- 2.
  // A write, refused before it is sent, with the refusal left on screen.
  await page.getByRole('button', { name: 'Save company details' }).click();
  const refusal = page
    .getByRole('alert')
    .filter({ hasText: 'This device is offline, so nothing was sent' });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('Reconnect and try again');
  // It is state, not news: still there after the success-notice lifetime
  // would have expired.
  await page.waitForTimeout(1_000);
  await expect(refusal).toBeVisible();
  await expectNoAxeViolations(page, 'offline write refusal');

  // ---------------------------------------------------------------- 3.
  // Now the server is unreachable too. The Dashboard is re-read, fails,
  // and is answered from the copy — under a banner that says when the
  // copy was taken.
  await cutTheServer(page);
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('PL270-CRB').first()).toBeVisible();
  await expect(banner).toContainText('Records on this screen were read at');
  await expectNoAxeViolations(page, 'offline dashboard served from the cache');

  // ---------------------------------------------------------------- 4.
  // A cold start with nothing reachable at all. The service worker
  // serves the document and the bundle, so what appears is Auto-MB
  // saying it is offline — not the browser's error page.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
  await expect(page.getByText('Auto-MB opened from the copy saved')).toBeVisible();
  // The shell really came from the worker: a page the browser failed to
  // load carries none of the product's own furniture, and this one has
  // the product mark, the typography and a working button.
  await expect(page.getByText('Auto-MB', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
  await expectNoAxeViolations(page, 'cold start with no connection');

  // ---------------------------------------------------------------- 5.
  // And the way back: the connection returns and the session is checked
  // again without the operator pressing anything.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockWorkspace(page);
  await context.setOffline(false);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test('the worker never holds an API response', async ({ page, context }) => {
  await mockWorkspace(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await waitForServiceWorker(page);

  /* The one assertion that matters for a shared site machine: Cache
   * Storage is keyed by origin and survives sign-out, so anything the
   * worker put there is readable by whoever signs in next. Tenant
   * records live in memory instead (`src/lib/offline.ts`), and this
   * proves the worker did not quietly cache them anyway. */
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys())
        urls.push(new URL(request.url).pathname);
    }
    return urls;
  });

  expect(cached.length).toBeGreaterThan(0);
  expect(cached.filter((path) => path.startsWith('/api'))).toEqual([]);
  expect(cached).toContain('/index.html');

  await context.setOffline(false);
});
