import { expect, test, type Page } from '@playwright/test';
import {
  DASHBOARD,
  MAINTENANCE_AWAITING_APPROVAL,
  ME,
  ORG,
  PICKER_ME,
  SECOND_ORG,
  WORK_WARRANTY,
  expectNoAxeViolations,
  json,
  mockWorkspace,
} from './fixtures.js';

test('sign-in screen is keyboard-labelled and passes the axe scan', async ({
  page,
}) => {
  await page.route('**/api/me', (route) =>
    route.fulfill(
      json({ code: 'UNAUTHENTICATED', message: 'Sign in.', requestId: 'r' }, 401),
    ),
  );
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expectNoAxeViolations(page, 'sign-in');
});

test('organisation picker and members workspace pass the axe scan', async ({
  page,
}) => {
  /* The second-heaviest journey in the suite, and now over Playwright's
     30s default: ten `expectNoAxeViolations` calls in both themes across
     the picker, dashboard, four registers, Masters, Members and Settings,
     plus the two transient shell surfaces at the end. It sat just under
     the line and the receivables module's rail entry — one more node in
     every one of those scans — is enough to put it over on a loaded
     machine. Budgeted with `test.slow()`, the same way the Work workspace
     leg below was when it crossed; the receivables scans themselves are a
     separate test rather than an eleventh leg here. */
  test.slow();
  await mockWorkspace(page, { me: PICKER_ME, organisations: [ORG, SECOND_ORG] });

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Select an organisation' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'organisation picker');

  await page
    .getByRole('article')
    .filter({ hasText: 'Sharma Constructions' })
    .getByRole('button', { name: 'Open workspace' })
    .click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(/PBG BG\/22 for PL270-CRB expires/)).toBeVisible();
  await expectNoAxeViolations(page, 'dashboard');

  await page.getByRole('link', { name: 'Works', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Works' })).toBeVisible();
  // The rail names a module's parts only while that module is open, so
  // Works shows its own and nothing else shows theirs.
  const rail = page.getByRole('navigation', { name: 'Modules' });
  await expect(rail.getByRole('link', { name: 'All Works' })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Contacts' })).toHaveCount(0);
  await expectNoAxeViolations(page, 'works list');

  // A Masters category opens from the rail, without a stop on Contacts first.
  await page.getByRole('link', { name: 'Masters' }).click();
  // Masters opens on Items, the first category on the rail (the mock's
  // order). Scanned where it lands: the canonical-item table is the one
  // register here with a right-aligned numeric column and a badge in
  // every row, and it would otherwise never be scanned at all.
  await expect(page.getByText('Outdoor horn speaker 30W')).toBeVisible();
  await expectNoAxeViolations(page, 'masters canonical items');
  await rail.getByRole('link', { name: 'Locations' }).click();
  // The category strip is a navigation, not a tablist: each category is its
  // own address and Back walks between them, so the open one says
  // aria-current="page" the way the Work workspace's sections do.
  await expect(
    page
      .getByRole('navigation', { name: 'Master data categories' })
      .getByRole('button', { name: 'Locations' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(rail.getByRole('link', { name: 'All Works' })).toHaveCount(0);
  await expectNoAxeViolations(page, 'masters locations from the rail');

  /* The company document library. Scanned with all four validity chips on
     screen at once — no expiry, valid, expiring, expired — plus the
     archived one, because those five tints are the only place this screen
     puts colour on a word, and a dot beside a label is what keeps them off
     the colour-only path in both themes. */
  await page.getByRole('link', { name: 'Company documents' }).click();
  await expect(page.getByRole('heading', { name: 'Company documents' })).toBeVisible();
  for (const label of ['No expiry', 'Valid', 'Expiring', 'Expired', 'Archived']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expectNoAxeViolations(page, 'company document library');
  // The renewal form, which the row hides behind a disclosure: an upload
  // control whose native input is visually hidden still has to be labelled.
  await page
    .getByRole('button', { name: /Versions and renewals/ })
    .first()
    .click();
  await expect(page.getByLabel(/Effective from/).first()).toBeVisible();
  await expectNoAxeViolations(page, 'company document renewal form');

  /* The tender pipeline. Scanned twice: the register, where the status
     chip and the days-left badge are the only colour on a word, and the
     opened tender's bid checklist, where all four validity readings are on
     screen at once — no expiry, valid at close, lapsing soon after,
     expired by close. Those four are read against the tender's own closing
     date rather than against today, and each is a dot beside a label,
     which is what keeps them off the colour-only path in both themes. */
  await page.getByRole('link', { name: 'Tenders' }).click();
  await expect(page.getByRole('heading', { name: 'Tenders' })).toBeVisible();
  await expect(page.getByText('1 blocking')).toBeVisible();
  await expectNoAxeViolations(page, 'tender register');

  await page.getByRole('link', { name: /WR-MMCT-S&T-34\/2026/ }).click();
  await expect(page.getByRole('heading', { name: 'Tender workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Bid checklist' }).click();
  for (const label of [
    'No expiry',
    'Valid at close',
    'Lapses soon after',
    'Expired by close',
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expectNoAxeViolations(page, 'tender bid checklist');

  // The iREPS panel: a warning-tinted badge and a disabled primary action
  // beside the reason it is disabled, both of which have to hold contrast.
  await page.getByRole('button', { name: 'iREPS submission' }).click();
  await expect(page.getByText('Tracking only')).toBeVisible();
  await expectNoAxeViolations(page, 'tender iREPS submission panel');

  /* The stock ledger (migration 0087). Scanned twice, because the two
     screens put colour on a word in two different places.

     The REGISTER carries its status words and, more to the point, a
     NEGATIVE available quantity in a numeric column. A minus sign in mono
     tabular figures is the whole difference between "26" and "-11" on a
     screen somebody buys material from, so it has to hold contrast in
     both themes rather than leaning on the tint beside it.

     The SHORTAGE screen carries the one destructive-tinted figure in the
     pack, a checkbox row whose label is three stacked lines, and a
     disabled primary action beside the picker that disables it. */
  await page.getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory control' })).toBeVisible();
  await expect(page.getByText('Low stock').first()).toBeVisible();
  await expect(page.getByText('Available').first()).toBeVisible();
  await expect(page.getByText('-11.000')).toBeVisible();
  await expect(page.getByText('PP-26-081/D1')).toBeVisible();
  await expectNoAxeViolations(page, 'stock register');

  await page.getByRole('link', { name: 'Shortage procurement' }).click();
  await expect(
    page.getByRole('heading', { name: 'Shortage procurement' }),
  ).toBeVisible();
  await expect(page.getByText('11.000 Nos')).toBeVisible();
  await expect(page.getByRole('checkbox')).toBeChecked();
  await expect(
    page.getByRole('button', { name: /Create draft supplier PO/ }),
  ).toBeDisabled();
  await expectNoAxeViolations(page, 'shortage procurement');

  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expectNoAxeViolations(page, 'members workspace');

  /* The Payments workspace (0080), both registers. Populated rather than
     empty: an empty register scans the EmptyState and proves nothing
     about the row, the status lamp or the action buttons, which is where
     a contrast or target-size failure would actually be. */
  await page.route('**/api/payment-requests', (route) =>
    route.fulfill(
      json({
        requests: [
          {
            id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
            requestNumber: 'PR/2026-27/018',
            kind: 'advance',
            status: 'paid',
            workId: null,
            workCode: 'PL-281',
            beneficiaryContactId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
            beneficiaryName: 'S. Kulkarni',
            purpose: 'Site travel and lodging for commissioning',
            category: 'travel',
            amount: '42500.00',
            proofFilename: 'Travel-estimate.pdf',
            billsDue: true,
            billsRecordedAt: null,
            requestedByUserId: 'user-b',
            decidedAt: '2026-08-12T10:00:00.000Z',
            decisionNote: null,
            paidAt: '2026-08-12T11:00:00.000Z',
            paidReference: 'UTR882104',
            createdAt: '2026-08-12T09:00:00.000Z',
          },
        ],
      }),
    ),
  );
  await page.route('**/api/vendor-invoices', (route) =>
    route.fulfill(
      json({
        invoices: [
          {
            id: 'cccccccc-1111-4111-8111-cccccccccccc',
            vendorContactId: 'dddddddd-1111-4111-8111-dddddddddddd',
            vendorName: 'Metro Industrial Supplies',
            invoiceNumber: 'MIS/442/26',
            invoiceDate: '2026-07-02',
            creditDays: 30,
            dueOn: '2026-08-01',
            amount: '186400.00',
            workId: null,
            // The two fields migration 0109 added to the read model. Both
            // are required by the contract, so a fixture that omits them
            // is a fixture the real server can never produce.
            purchaseOrderId: null,
            document: null,
            tdsSection: '194C',
            tdsPayeeClass: 'other',
            paidTotal: '0',
            outstandingAmount: '186400.00',
            cancelledAt: null,
            cancelReason: null,
            payments: [],
            createdAt: '2026-07-02T00:00:00.000Z',
          },
        ],
        totalOutstanding: '186400.00',
        overdueCount: 1,
      }),
    ),
  );
  await page.getByRole('link', { name: 'Payments' }).click();
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
  await expect(page.getByText('New advances are blocked')).toBeVisible();
  await expectNoAxeViolations(page, 'payments employee register');

  /* The register strip is a navigation, not a tablist — each register is
     its own address — so the open one carries aria-current="page", the
     same shape the Masters category strip above is checked for. */
  const registers = page.getByRole('navigation', { name: 'Payments registers' });
  await registers.getByRole('link', { name: 'Vendors' }).click();
  await expect(registers.getByRole('link', { name: 'Vendors' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('Metro Industrial Supplies')).toBeVisible();
  await expectNoAxeViolations(page, 'payments vendor ledger');
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByLabel('Company name')).toHaveValue('Sharma Constructions');
  await expectNoAxeViolations(page, 'settings');

  /* The shell's own two transient surfaces, scanned in both themes because
     nothing else opens them: the account menu, and the icon-only rail the
     mock's sidebar trigger collapses to. A rail whose labels are visually
     gone still has to name every destination. */
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('group', { name: 'Account' })).toBeVisible();
  await expectNoAxeViolations(page, 'account menu');
  await page.keyboard.press('Escape');

  const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rail.getByRole('link', { name: 'Works', exact: true })).toBeVisible();
  await expectNoAxeViolations(page, 'collapsed rail');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

/* People and payroll (0089, 0090) — its OWN test, not another leg of the
   picker journey above, which was already close to the 30s budget and
   tipped over it when these two scans were appended (the receivables
   precedent below).

   The two screens put colour on a word in different places. The REGISTER
   carries the employed/left status chips; the "Include people who have
   left" toggle is exercised, because the default view hides the leaver
   and the "Left" chip has to be brought on screen honestly rather than
   by a fixture that ignores the status filter. The PAYROLL run is
   finalised, so its SUCCESS-toned status chip, the salary-requests link,
   the WARNING-toned loss-of-pay line, the grouped two-row deduction
   header and the CA-facing basis table are all on screen at once. The
   computation is expanded before the scan — a collapsed row proves
   nothing about the panel inside it. */
test('the employee register and the finalised payroll run pass the axe scan', async ({
  page,
}) => {
  await mockWorkspace(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('link', { name: 'Employees' }).click();
  await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible();
  await expect(page.getByText('Anita Deshmukh')).toBeVisible();
  await expect(page.getByText('Employed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Provident fund · ESI').first()).toBeVisible();
  // Bring the leaver on screen through the real toggle, so the neutral
  // "Left" chip is scanned in the state it actually renders in.
  await page.getByRole('checkbox', { name: 'Include people who have left' }).check();
  await expect(page.getByText('Left', { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, 'employee register');

  await page.getByRole('link', { name: 'Monthly payroll' }).click();
  await expect(page.getByRole('heading', { name: 'Monthly payroll' })).toBeVisible();
  // The run number is on screen twice — the header's own mono span (its
  // whole text) and the picker option (embedded in a longer label). An
  // exact match takes the header span, not the option, which is inside a
  // closed select and never visible anyway.
  await expect(page.getByText('PAY/2026-27/001', { exact: true })).toBeVisible();
  // The success-toned finalised chip and the door to its salary requests.
  await expect(page.getByText('Finalised', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /salary requests are on the Payments register/ }),
  ).toBeVisible();
  await expect(page.getByText('Not covered')).toBeVisible();
  // The warning-toned loss-of-pay line.
  await expect(page.getByText('Loss of pay 2.00')).toBeVisible();
  await page.getByRole('button', { name: /Anita Deshmukh/ }).click();
  await expect(page.getByText('Monthly computation')).toBeVisible();
  await expect(page.getByText('Statutory basis')).toBeVisible();
  await expectNoAxeViolations(page, 'finalised monthly payroll run');
});

/* Its own test rather than another leg of the picker journey above, which
   was already close to the 30s budget and tipped over it when these two
   scans were appended. A module gets its own test here for the same reason
   the LOA and Work workspace legs do: the journey test grows with every
   wave, and a shared budget nobody can attribute is a timeout the next
   pack inherits. */
test('the receivables register passes the axe scan', async ({ page }) => {
  await mockWorkspace(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  /* Scanned twice: the table, where three status chips and three
     right-aligned money columns are on screen at once, and the opened
     bill's sheet, where the deduction waterfall puts a success tint on one
     figure and the lifecycle strip carries dots that must not be the only
     thing distinguishing a done step from a pending one. */
  await page.getByRole('link', { name: 'Receivables' }).click();
  await expect(page.getByRole('heading', { name: 'Receivables' })).toBeVisible();
  await expect(page.getByText('FY 2026-27')).toBeVisible();
  await expectNoAxeViolations(page, 'receivables register');

  await page
    .getByRole('button', { name: /Open bill 8/ })
    .first()
    .click();
  await expect(page.getByText('Deduction waterfall')).toBeVisible();
  await expect(page.getByText('Net payable')).toBeVisible();
  await expectNoAxeViolations(page, 'receivables bill sheet');
});

test('the correspondence register and both composers pass the axe scan', async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto('/#/correspondence');

  /* The correspondence register (0086). Scanned with all four letter
     statuses on screen at once — sent, received, replied, cancelled —
     plus the amber extension banner above them, because those chips and
     that banner are the only colour this screen puts on a word. */
  await expect(page.getByRole('heading', { name: 'Correspondence' })).toBeVisible();
  await expect(page.getByText('2 extension requests awaiting response')).toBeVisible();
  for (const label of ['sent', 'received', 'replied', 'cancelled']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expectNoAxeViolations(page, 'correspondence register');

  // The inward upload screen: a file input whose native control is
  // visually hidden behind a dashed dropzone still has to be labelled and
  // reachable, which is exactly the failure this scan is here for.
  await page.getByRole('button', { name: 'Upload inward' }).click();
  await expect(
    page.getByRole('heading', { name: 'Upload inward letter' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'inward letter upload');

  await page.getByRole('button', { name: 'Correspondence' }).first().click();
  await page.getByRole('button', { name: 'New letter' }).click();
  await expect(
    page.getByRole('heading', { name: 'Write outward letter' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'outward letter composer');
});

test('LOA upload and review screens pass the axe scan', async ({ page }) => {
  await mockWorkspace(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('link', { name: 'Works', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Works' })).toBeVisible();

  await page.getByRole('main').getByRole('button', { name: 'Upload LOA' }).click();
  await expect(
    page.getByRole('heading', { name: 'Upload contract documents' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'upload');

  await page.getByRole('button', { name: 'Cancel' }).click();
  // The register's row actions are real anchors carrying the workspace
  // hash, so a middle-click opens the record in its own tab. They answer
  // to the link role; the spec asked for buttons and had been failing
  // since hash routing landed.
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(
    page.getByRole('heading', { name: /Review loa-letter\.pdf/ }),
  ).toBeVisible();
  // A letter number the parser located is the letter's own value, so the
  // screen states it rather than offering a control to edit it.
  await expect(page.getByTestId('fact-letter-number')).toHaveText('L-42/2025');
  await expect(page.getByText('The printed unit could not be resolved.')).toBeVisible();
  await expectNoAxeViolations(page, 'review');
});

/** The two finalized Measurement Books the work-detail mock carries, one
 * per railway-measurement shape the axe scan needs. */
const MEASUREMENT_BOOKS = {
  'DCW-1-MB-01': 'eeeeeeee-8888-4888-8888-eeeeeeeeeeee',
  'DCW-1-MB-02': 'eeeeeeee-9999-4999-8999-eeeeeeeeeeee',
} as const;

/**
 * Opens one of those books with a chosen railway-measurement reading
 * (0111).
 *
 * A book PER SHAPE rather than one book re-routed twice: the panel's read
 * is keyed on the book it is given, so re-opening the same book with a
 * different mocked reading leaves the effect unfired and the previous
 * reading on screen — and the scan then passes against a state nobody set
 * up, which is worse than failing.
 */
async function openMeasurementBook(
  page: Page,
  workId: string,
  mbNumber: keyof typeof MEASUREMENT_BOOKS,
  measurement: {
    readonly matchStatus: 'matched' | 'mismatched' | 'unreadable';
    readonly settles: boolean;
    readonly lines: readonly Record<string, unknown>[];
  },
): Promise<void> {
  const bookId = MEASUREMENT_BOOKS[mbNumber];
  await page.route(`**/api/measurement-books/${bookId}`, (route) =>
    route.fulfill(
      json({
        book: {
          id: bookId,
          workId,
          status: 'finalized',
          isFinal: mbNumber === 'DCW-1-MB-01',
          mbDate: '2026-08-05',
          mbNumber,
          sequenceNumber: mbNumber === 'DCW-1-MB-01' ? 1 : 2,
          totalAmount: '200.00',
          remarkTemplateVersion: 'mb-remark-v1',
          templateVersion: 'mb-v1',
          renderedAvailable: true,
          cancellationNote: null,
          billId: null,
          createdAt: '2026-08-05T00:00:00.000Z',
          finalizedAt: '2026-08-05T10:00:00.000Z',
          cancelledAt: null,
          closedAt: null,
        },
        sources: [],
        lines: [],
        warnings: [],
        previewTotal: null,
        unbillableVariationExposure: '0.00',
        // 0106's rupee value of what the measured-quantity adjustments
        // left out. Required by the response schema, and the screen
        // formats it unconditionally — a mock that omits it blanks the
        // whole workspace rather than failing near the missing field.
        measurementAdjustedAway: '0.00',
      }),
    ),
  );
  await page.route(`**/api/measurement-books/${bookId}/railway-measurement`, (route) =>
    route.fulfill(
      json({
        measurement: {
          id: `ffffffff-8888-4888-8888-fffffffffff${mbNumber.slice(-1)}`,
          workId,
          measurementBookId: bookId,
          originalFilename: 'CMB-01.pdf',
          sha256: 'a'.repeat(64),
          sizeBytes: 2048,
          discardedAt: null,
          createdAt: '2026-08-06T00:00:00.000Z',
          ...measurement,
        },
        // The MB-02 leg carries a discarded mismatch as well, so the
        // "previously recorded and discarded" list is on screen for the
        // scan: it is the one place this panel puts a destructive chip
        // inside body text rather than at the top of a section.
        discarded:
          mbNumber === 'DCW-1-MB-02'
            ? [
                {
                  id: 'ffffffff-0000-4000-8000-ffffffffffff',
                  workId,
                  measurementBookId: bookId,
                  originalFilename: 'CMB-01-first-try.pdf',
                  sha256: 'b'.repeat(64),
                  sizeBytes: 2048,
                  matchStatus: 'mismatched',
                  lines: [],
                  settles: false,
                  discardedAt: '2026-08-06T09:00:00.000Z',
                  createdAt: '2026-08-05T00:00:00.000Z',
                },
              ]
            : [],
      }),
    ),
  );
  // Awaited before it is clicked: the register's own list is in flight
  // when the tab opens, and a click that lands on nothing leaves the
  // failure pointing at the panel rather than at the row.
  const row = page.getByRole('button', { name: mbNumber });
  await expect(row).toBeVisible();
  await row.click();
  // The panel's own heading is the wait, and the only one. An
  // intermediate assertion on the book's heading was scaffolding while
  // the two-books-per-shape bug was being found; it outlived its use and
  // was itself brittle — the heading interleaves chips with its text, so
  // its accessible name is not the string it reads as.
  await expect(
    page.getByRole('heading', { name: 'Railway measurement' }),
  ).toBeVisible();
}

test('work detail and challan editor pass the axe scan', async ({ page }) => {
  /* By far the heaviest spec in the suite: eighteen `expectNoAxeViolations`
     calls, each a full axe run in both themes, across the Work workspace's
     seven sections, two railway-measurement panels, a challan, its editor, a
     confirmation and two registers — thirty-six scans behind one test.
     Splitting it would mean re-mounting the same forty-route fixture several
     times over, which costs more than it saves; the fixture is nine hundred
     lines of test-local mock and every leg needs all of it.

     Budgeted explicitly rather than with `test.slow()`, which the rest of
     this file uses, because a 3x multiplier is not enough headroom here.
     The axe runs are CPU-bound and this file is one worker's serial queue
     while the other workers run theirs, so the elapsed time tracks how
     busy the machine is rather than anything about the markup. Measured on
     one mid-range dev box: 31.5s for the file alone, 43.4s and 51.4s for
     the same test in two full-suite runs three workers wide, and a timeout
     at `test.slow()`'s 90s when that box was also building something else.
     The spread is the point — the ceiling has to clear the bad day, not
     the median. 180s is 6x the default and roughly 2x the worst run seen.
     Nothing here asserts on elapsed time; the budget only decides when
     Playwright gives up. */
  test.setTimeout(180_000);
  const WORK_ID = '33333333-3333-4333-8333-333333333333';
  const ITEM_ID = '55555555-5555-4555-8555-555555555555';
  const SERIAL_ITEM_ID = '55555555-4444-4444-8444-555555555555';
  const CHALLAN_ID = '44444444-4444-4444-8444-444444444444';
  const CHALLAN_ITEM_ID = '66666666-6666-4666-8666-666666666666';
  // The open DRAFT Measurement Book, whose preview carries the editable
  // measured-quantity fields (docs/UX.md § 25).
  const MB_DRAFT_ID = 'eeeeeeee-9999-4999-8999-eeeeeeeeeeee';
  // The register row the scan opens, and the document behind it.
  const INVOICE_ID = '88888888-8888-4888-8888-888888888888';
  const OPENED_INVOICE = {
    invoice: {
      id: INVOICE_ID,
      workId: WORK_ID,
      measurementBookId: null,
      statedTaxableValue: null,
      mbNumber: 'DCW-1-MB-01',
      status: 'submitted',
      invoiceNumber: 'TI/2026-27/001',
      sequenceNumber: 1,
      fyLabel: '2026-27',
      invoiceDate: '2026-08-04',
      lineShape: 'service_cumulative',
      sacCode: '998734',
      serviceDescription: 'Works contract services for signalling installation',
      gstRate: '18.00',
      placeOfSupply: '27',
      reverseChargeApplicable: false,
      buyerContactId: '77777777-7777-4777-8777-777777777777',
      taxableValue: '125000.00',
      cgstAmount: '11250.00',
      sgstAmount: '11250.00',
      igstAmount: '0.00',
      roundOff: '0.00',
      totalAmount: '147500.00',
      customerPoReference: null,
      unitLabel: null,
      notes: null,
      shipToContactId: null,
      numberPrefix: null,
      // Registered at the IRP, so the opened surface renders its fullest
      // state: the frozen facts, the PDF control, the whole IRP panel with
      // its acknowledgement, and the credit-note section.
      irn: 'a'.repeat(64),
      irpProvider: 'whitebooks',
      irpProviderState: 'registered',
      ackNumber: '900719925474099312345',
      ackDate: '2026-08-04T06:39:00.000Z',
      ackDateText: '04/08/2026 12:09:00',
      signedInvoiceAvailable: true,
      renderedAvailable: true,
      irpLegacyEvidenceMissing: false,
      irpCancelledAt: null,
      irpCancelledAtText: null,
      irpCancelReasonCode: null,
      irpCancelRemark: null,
      irpCancelWindowClosesAt: '2026-08-05T06:39:00.000Z',
      irpCancelWindowOpen: false,
      irpReportingDeadline: null,
      irpReportingOverdue: false,
      cancellationNote: null,
      createdAt: '2026-08-04T00:00:00.000Z',
      submittedAt: '2026-08-04T06:00:00.000Z',
      cancelledAt: null,
    },
    buyerSnapshot: { designation: 'Sr. DEE/TRD/Bhusawal' },
    shipToSnapshot: null,
    issuedSnapshot: null,
    signedQr: 'signed-qr-payload',
    lines: [],
  };
  const CHALLAN = {
    id: CHALLAN_ID,
    workId: WORK_ID,
    status: 'issued',
    challanDate: '2026-08-01',
    challanNumber: 'DC/1',
    sequenceNumber: 1,
    prefix: 'DC',
    consignee: { name: 'Sr. DEE (G)', address: 'Delhi Division' },
    templateVersion: 'dc-v3',
    warrantyTemplateVersion: 'wc-v1',
    warrantyTextSha256: 'a'.repeat(64),
    renderedAvailable: false,
    signedCopyAvailable: false,
    cancellationNote: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    issuedAt: '2026-08-01T10:00:00.000Z',
    cancelledAt: null,
  };
  const WORK = {
    id: WORK_ID,
    workCode: 'DCW-1',
    letterNumber: 'L-42/2025',
    letterDate: '2025-06-01',
    title: 'Supply of switchboards',
    advertisedValue: '1000.00',
    contractValue: '900.00',
    pricingShape: 'per_schedule',
    letterPercentage: null,
    letterPercentageDirection: null,
    status: 'active',
    completedAt: null,
    completedByUserId: null,
    completionNote: null,
    createdAt: '2026-08-08T00:00:00.000Z',
  };
  await page.route('**/api/me', (route) => route.fulfill(json(ME)));
  await page.route('**/api/organisations', (route) =>
    route.fulfill(json({ organisations: [ORG] })),
  );
  await page.route('**/api/dashboard', (route) => route.fulfill(json(DASHBOARD)));
  await page.route('**/api/loa-documents', (route) =>
    route.fulfill(json({ documents: [] })),
  );
  await page.route('**/api/works', (route) => route.fulfill(json({ works: [WORK] })));
  await page.route(`**/api/works/${WORK_ID}`, (route) =>
    route.fulfill(
      json({
        work: WORK,
        schedules: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            scheduleCode: 'A',
            title: 'Schedule A',
            position: 1,
            items: [
              {
                id: ITEM_ID,
                scheduleId: '77777777-7777-4777-8777-777777777777',
                itemNumber: 'A/1',
                description: 'Main switchboard',
                unitCode: 'Nos',
                awardedQuantity: '5.000',
                effectiveRate: '100.00',
                requiresSerials: false,
              },
              {
                // Serial-tracked, so the recording table draws its serials
                // field and the delivered pool beneath it — the two
                // controls the axe scan would otherwise never reach.
                id: SERIAL_ITEM_ID,
                scheduleId: '77777777-7777-4777-8777-777777777777',
                itemNumber: 'A/2',
                description: 'Point machine',
                unitCode: 'Nos',
                awardedQuantity: '4.000',
                effectiveRate: '300.00',
                requiresSerials: true,
              },
            ],
          },
        ],
        // The Work read carries the Installations tab's tally; the tab
        // loads the records themselves only when it is opened.
        installationCounts: { recorded: 1, cancelled: 0 },
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/completion-readiness`, (route) =>
    route.fulfill(json({ ready: true, unfinished: [], blockers: [] })),
  );
  await page.route(`**/api/works/${WORK_ID}/contract-source-context`, (route) =>
    route.fulfill(
      json({
        documents: [],
        paymentMatrix: [],
        periods: [],
        releaseClauses: [],
        itemSpecifications: [],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/challans`, (route) =>
    route.fulfill(json({ challans: [CHALLAN] })),
  );
  /* The defect liability card reads its own endpoint on the Instruments
     tab (0099). This journey builds its route table from scratch rather
     than through `mockWorkspace`, so the handler is registered here as
     well as there. */
  await page.route(`**/api/works/${WORK_ID}/warranty*`, (route) =>
    route.fulfill(json(WORK_WARRANTY)),
  );
  await page.route(`**/api/works/${WORK_ID}/instruments`, (route) =>
    route.fulfill(
      json({
        instruments: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workId: WORK_ID,
            kind: 'pbg',
            reference: 'BG/22',
            amount: '45000.00',
            issuedOn: '2026-01-10',
            expiresOn: '2026-09-15',
            status: 'active',
            notes: null,
            createdAt: '2026-01-10T00:00:00.000Z',
          },
        ],
      }),
    ),
  );
  /* Retention and liquidated damages (0098), populated on purpose: the
     scan has to see the tinted words, and this panel carries three of
     them at once — a `draft` assessment reading neutral, a `levied` one
     in the primary family and a `waived` one in the success family. An
     empty position would scan a heading and prove nothing about the
     contrast of the chips it is here to check. */
  await page.route(`**/api/works/${WORK_ID}/retention`, (route) =>
    route.fulfill(
      json({
        position: {
          workId: WORK_ID,
          contractValue: '10000000.00',
          retentionCeilingAmount: '500000.00',
          retentionHeldTotal: '150000.00',
          retentionReleasedTotal: '50000.00',
          retentionBalance: '100000.00',
          ldLeviedTotal: '500000.00',
          ldDeductedTotal: '400000.00',
          ldOpenAssessments: 1,
        },
        terms: {
          retentionPercent: '10.000',
          retentionLimitPercent: '5.000',
          defectLiabilityMonths: 24,
          ldRatePercent: '0.500',
          ldPeriodDays: 7,
          ldCapPercent: '10.000',
          sourceClause: 'GCC 17B',
          notes: null,
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        releases: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
            workId: WORK_ID,
            releasedOn: '2026-06-10',
            amount: '50000.00',
            basis: 'pac',
            workInstrumentId: null,
            workInstrumentReference: null,
            reference: 'REL/2026/1',
            description: null,
            remarks: null,
            voidedAt: null,
            voidReason: null,
            createdAt: '2026-06-10T00:00:00.000Z',
          },
        ],
        assessments: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
            workId: WORK_ID,
            assessedOn: '2026-05-01',
            status: 'levied',
            basisAmount: '10000000.00',
            basisLabel: 'Contract value',
            scheduledCompletionDate: '2026-01-01',
            assessedToDate: '2026-04-15',
            ldRatePercent: '0.500',
            ldPeriodDays: 7,
            ldCapPercent: '10.000',
            delayDays: 104,
            chargeablePeriods: 15,
            uncappedAmount: '750000.00',
            capAmount: '1000000.00',
            assessedAmount: '750000.00',
            leviedAmount: '500000.00',
            levyReference: 'LD/2026/07',
            outcomeReason: null,
            notes: null,
            decidedAt: '2026-05-02T00:00:00.000Z',
            createdAt: '2026-05-01T00:00:00.000Z',
          },
          {
            id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
            workId: WORK_ID,
            assessedOn: '2026-03-01',
            status: 'waived',
            basisAmount: '10000000.00',
            basisLabel: 'Contract value',
            scheduledCompletionDate: '2026-01-01',
            assessedToDate: '2026-02-01',
            ldRatePercent: '0.500',
            ldPeriodDays: 7,
            ldCapPercent: '10.000',
            delayDays: 31,
            chargeablePeriods: 5,
            uncappedAmount: '250000.00',
            capAmount: '1000000.00',
            assessedAmount: '250000.00',
            leviedAmount: null,
            levyReference: null,
            outcomeReason: 'Delay attributable to the railway’s own site handover',
            notes: null,
            decidedAt: '2026-03-02T00:00:00.000Z',
            createdAt: '2026-03-01T00:00:00.000Z',
          },
        ],
        currentCompletionDate: '2026-01-01',
        instruments: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            kind: 'pbg',
            reference: 'BG/22',
            amount: '45000.00',
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/mb-entries`, (route) =>
    route.fulfill(
      json({
        entries: [
          {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            workItemId: ITEM_ID,
            itemNumber: 'A/1',
            deliveryChallanId: CHALLAN_ID,
            measuredQuantity: '2.000',
            measuredOn: '2026-08-01',
            mbBookRef: 'MB-12/34',
            remarks: null,
            billId: null,
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/bills`, (route) =>
    route.fulfill(
      json({
        bills: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            workId: WORK_ID,
            billNumber: 1,
            status: 'prepared',
            totalAmount: '200.00',
            linesSnapshot: [
              {
                workItemId: ITEM_ID,
                itemNumber: 'A/1',
                unitCode: 'Nos',
                quantity: '2.000',
                rate: '100.00',
                amount: '200.00',
              },
            ],
            createdAt: '2026-08-02T00:00:00.000Z',
            submittedAt: null,
            paidAt: null,
          },
        ],
        // The Work's billing position, summed by the server — the three
        // tiles above the list read it, and never add the list up.
        summary: {
          measured: '4200.00',
          billed: '200.00',
          unbilled: '4000.00',
        },
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/serials`, (route) =>
    route.fulfill(
      json({
        serials: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            deliveryChallanId: CHALLAN_ID,
            challanItemId: CHALLAN_ITEM_ID,
            challanNumber: 'DC/1',
            itemDescription: 'Main switchboard',
            serialNumber: 'SN-001',
            installedOn: null,
            installationRemarks: null,
            origin: 'delivery',
          },
          {
            // Delivered and uninstalled: this is what the recording
            // table's pool assist draws one button for.
            id: '88888888-7777-4777-8777-888888888888',
            deliveryChallanId: CHALLAN_ID,
            challanItemId: CHALLAN_ITEM_ID,
            challanNumber: 'DC/1',
            itemDescription: 'Point machine',
            serialNumber: 'SN-101',
            installedOn: null,
            installationRemarks: null,
            workItemId: SERIAL_ITEM_ID,
            challanStatus: 'issued',
            origin: 'delivery',
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/installations`, (route) =>
    route.fulfill(
      json({
        installations: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            workId: WORK_ID,
            workItemId: ITEM_ID,
            itemNumber: 'A/1',
            quantity: '1.000',
            installedOn: '2026-08-03',
            locationId: '66666666-6666-4666-8666-666666666666',
            locationName: 'Nashik Road station',
            remarks: null,
            status: 'recorded',
            cancellationNote: null,
            serials: [
              {
                serialId: '88888888-8888-4888-8888-888888888888',
                serialNumber: 'SN-001',
                challanNumber: 'DC/1',
                origin: 'delivery',
              },
              {
                // Migration 0108: a nameplate the challan missed, typed at
                // site. It carries the one warning tint this record row can
                // draw, so both theme passes measure it.
                serialId: '88888888-8888-4888-8888-888888888889',
                serialNumber: 'SN-009',
                challanNumber: null,
                origin: 'installation',
              },
            ],
            createdAt: '2026-08-03T00:00:00.000Z',
            cancelledAt: null,
          },
        ],
        itemSummaries: [
          { workItemId: ITEM_ID, itemNumber: 'A/1', installedQuantity: '1.000' },
          { workItemId: SERIAL_ITEM_ID, itemNumber: 'A/2', installedQuantity: '0.000' },
        ],
      }),
    ),
  );
  // The tenant-wide register, which reads the same records across Works.
  // Registered before the Work-scoped route above would ever be consulted
  // for it: the two paths are distinct, so neither pattern shadows the
  // other. The trailing `?*` is load-bearing — the register asks for a
  // page, so every request it makes carries a query string, and a pattern
  // without one would match none of them.
  await page.route('**/api/installations?*', (route) =>
    route.fulfill(
      json({
        installations: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            workId: WORK_ID,
            workCode: 'DCW-1',
            workTitle: 'Supply of switchboards',
            workItemId: ITEM_ID,
            itemNumber: 'A/1',
            quantity: '1.000',
            installedOn: '2026-08-03',
            locationName: 'Nashik Road station',
            serialCount: 1,
            status: 'recorded',
          },
        ],
        nextCursor: null,
      }),
    ),
  );
  // The organisation-wide invoice register. Same `?*` reasoning as the
  // installation register above: it always asks for a page.
  await page.route('**/api/tax-invoices?*', (route) =>
    route.fulfill(
      json({
        invoices: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            workId: WORK_ID,
            workCode: 'DCW-1',
            workTitle: 'Supply of switchboards',
            invoiceNumber: 'TI/2026-27/001',
            invoiceDate: '2026-08-04',
            status: 'submitted',
            buyerName: 'Sr. DEE/TRD/Bhusawal',
            taxableValue: '125000.00',
            gstAmount: '22500.00',
            irn: null,
            irpProvider: null,
            irpProviderState: 'not_requested',
            irpReportingDeadline: '2026-09-03',
            irpReportingOverdue: false,
          },
          {
            id: '88888888-8888-4888-8888-888888888889',
            workId: null,
            workCode: null,
            workTitle: null,
            invoiceNumber: null,
            invoiceDate: '2026-08-02',
            status: 'draft',
            buyerName: 'Deccan Switchgear Pvt Ltd',
            taxableValue: null,
            gstAmount: null,
            irn: null,
            irpProvider: null,
            irpProviderState: 'not_requested',
            irpReportingDeadline: null,
            irpReportingOverdue: false,
          },
        ],
        nextCursor: null,
      }),
    ),
  );
  // The invoice the register OPENS. Registered after the register's own
  // `?*` pattern and distinct from it: this path carries an id and no
  // query string, so neither shadows the other. A submitted, IRP-
  // registered invoice, because that is the state where the opened
  // surface renders the most — the frozen facts, the PDF control, the
  // whole IRP transport panel and the credit-note section.
  await page.route(`**/api/tax-invoices/${INVOICE_ID}`, (route) =>
    route.fulfill(json(OPENED_INVOICE)),
  );
  await page.route(`**/api/tax-invoices/${INVOICE_ID}/eway-bills`, (route) =>
    route.fulfill(json({ ewayBills: [] })),
  );
  await page.route(`**/api/tax-invoices/${INVOICE_ID}/credit-notes`, (route) =>
    route.fulfill(json({ creditNotes: [] })),
  );
  await page.route('**/api/masters/locations', (route) =>
    route.fulfill(
      json({
        locations: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            name: 'Nashik Road station',
            kind: 'station',
            active: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/pac-certificates`, (route) =>
    route.fulfill(
      json({
        certificates: [
          {
            id: 'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa',
            workId: WORK_ID,
            reference: 'PAC/2026/01',
            issueDate: '2026-08-04',
            consigneeMasterId: 'bbbbbbbb-6666-4666-8666-bbbbbbbbbbbb',
            consigneeDesignation: 'Sr. DEE (G) CR',
            status: 'recorded',
            cancellationNote: null,
            documentAvailable: false,
            items: [
              {
                workItemId: ITEM_ID,
                itemNumber: 'A/1',
                certifiedQuantity: '1.000',
                releasedValue: null,
              },
            ],
            releasedValue: null,
            createdAt: '2026-08-04T00:00:00.000Z',
            cancelledAt: null,
          },
        ],
        itemSummaries: [
          {
            workItemId: ITEM_ID,
            itemNumber: 'A/1',
            installedQuantity: '1.000',
            pacCertifiedQuantity: '1.000',
            availableQuantity: '0.000',
          },
        ],
      }),
    ),
  );
  await page.route('**/api/masters/contacts*', (route) =>
    route.fulfill(
      json({
        contacts: [
          {
            id: 'bbbbbbbb-6666-4666-8666-bbbbbbbbbbbb',
            designation: 'Sr. DEE (G) CR',
            address: 'Bhusawal Division',
            contactPerson: null,
            phone: null,
            email: null,
            gstin: null,
            pincode: null,
            stateCode: null,
            isConsignee: true,
            isVendor: false,
            isClient: false,
            active: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          // A client contact, so the invoice register's direct-invoice
          // form is offered rather than blocked on a missing buyer — the
          // form is what this spec scans.
          {
            id: 'bbbbbbbb-6666-4666-8666-bbbbbbbbbbbc',
            designation: 'Deccan Switchgear Pvt Ltd',
            address: 'Nashik 422101',
            contactPerson: null,
            phone: null,
            email: null,
            gstin: null,
            pincode: '422101',
            stateCode: '27',
            isConsignee: false,
            isVendor: false,
            isClient: true,
            active: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/consignees`, (route) =>
    route.fulfill(json({ consignees: [] })),
  );
  await page.route(`**/api/challans/${CHALLAN_ID}`, (route) =>
    route.fulfill(
      json({
        challan: CHALLAN,
        items: [
          {
            id: CHALLAN_ITEM_ID,
            workItemId: ITEM_ID,
            description: 'Main switchboard',
            unit: 'Nos',
            quantity: '2.000',
            rate: '100.00',
            lineAmount: '200.00',
            position: 1,
          },
        ],
        issuedSnapshot: null,
      }),
    ),
  );
  await page.route(`**/api/challans/${CHALLAN_ID}/receipt`, (route) =>
    route.fulfill(
      json({ code: 'RECEIPT_NOT_FOUND', message: 'No receipt.', requestId: 'r' }, 404),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/balance`, (route) =>
    route.fulfill(
      json({
        allowExcessDelivery: false,
        today: '2026-08-11',
        items: [
          {
            workItemId: ITEM_ID,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            deliveredQuantity: '3.000',
            remainingQuantity: '2.000',
            effectiveRate: '100.00',
          },
          {
            workItemId: SERIAL_ITEM_ID,
            itemNumber: 'A/2',
            description: 'Point machine',
            unitCode: 'Nos',
            awardedQuantity: '4.000',
            deliveredQuantity: '2.000',
            remainingQuantity: '2.000',
            effectiveRate: '300.00',
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/correction-notices`, (route) =>
    route.fulfill(json({ notices: [] })),
  );
  await page.route(`**/api/works/${WORK_ID}/amendments`, (route) =>
    route.fulfill(json({ approvals: [] })),
  );
  // The Work page loads its purchase orders with everything else, so an
  // unmocked procurement route blanks the whole page behind a 502 rather
  // than emptying one tab.
  await page.route(`**/api/works/${WORK_ID}/purchase-orders*`, (route) =>
    route.fulfill(json({ purchaseOrders: [] })),
  );
  await page.route(`**/api/works/${WORK_ID}/tax-invoices`, (route) =>
    route.fulfill(json({ invoices: [] })),
  );
  await page.route(`**/api/works/${WORK_ID}/issue-challans`, (route) =>
    route.fulfill(json({ issueChallans: [] })),
  );
  await page.route(`**/api/works/${WORK_ID}/completion`, (route) =>
    route.fulfill(
      json({
        completion: { originalCompletionDate: null, currentCompletionDate: null },
        extensionRequests: [],
      }),
    ),
  );
  await page.route('**/api/approvals*', (route) =>
    route.fulfill(json({ approvals: [] })),
  );
  await page.route(`**/api/works/${WORK_ID}/payment-matrix`, (route) =>
    route.fulfill(
      json({
        rows: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            workId: WORK_ID,
            category: 'SUPPLY',
            pctSupply: '80.00',
            pctInstallation: '10.00',
            pctPac: '0.00',
            pctFinalBill: '10.00',
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/works/${WORK_ID}/measurement-books`, (route) =>
    route.fulfill(
      json({
        books: [
          {
            id: 'eeeeeeee-8888-4888-8888-eeeeeeeeeeee',
            workId: WORK_ID,
            status: 'finalized',
            isFinal: true,
            mbDate: '2026-08-05',
            mbNumber: 'DCW-1-MB-01',
            sequenceNumber: 1,
            totalAmount: '200.00',
            remarkTemplateVersion: 'mb-remark-v1',
            templateVersion: 'mb-v1',
            renderedAvailable: true,
            cancellationNote: null,
            billId: null,
            createdAt: '2026-08-05T00:00:00.000Z',
            finalizedAt: '2026-08-05T10:00:00.000Z',
            cancelledAt: null,
          },
          // A SECOND finalized book, and it exists for the railway
          // measurement scans below rather than for the register.
          //
          // The panel's read is keyed on the book it is given, so opening
          // the SAME book twice with a different mocked reading leaves the
          // effect unfired and the first reading on screen — the scan then
          // passes against a state nobody set up. Two books, one shape
          // each, is the honest way to reach both.
          {
            id: 'eeeeeeee-9999-4999-8999-eeeeeeeeeeee',
            workId: WORK_ID,
            status: 'finalized',
            isFinal: false,
            mbDate: '2026-08-06',
            mbNumber: 'DCW-1-MB-02',
            sequenceNumber: 2,
            totalAmount: '150.00',
            remarkTemplateVersion: 'mb-remark-v1',
            templateVersion: 'mb-v1',
            renderedAvailable: true,
            cancellationNote: null,
            billId: null,
            createdAt: '2026-08-06T00:00:00.000Z',
            finalizedAt: '2026-08-06T10:00:00.000Z',
            cancelledAt: null,
          },
          {
            id: MB_DRAFT_ID,
            workId: WORK_ID,
            status: 'draft',
            isFinal: false,
            mbDate: '2026-08-09',
            mbNumber: null,
            sequenceNumber: null,
            totalAmount: null,
            remarkTemplateVersion: null,
            templateVersion: null,
            renderedAvailable: false,
            cancellationNote: null,
            billId: null,
            createdAt: '2026-08-09T00:00:00.000Z',
            finalizedAt: null,
            cancelledAt: null,
          },
        ],
      }),
    ),
  );
  // The draft's preview, so the measurement leg can scan the editable
  // measured-quantity fields (docs/UX.md § 25) where colour actually
  // lands on them: a field, its claimed-quantity description beside it,
  // and the amount the pair prices.
  await page.route(`**/api/measurement-books/${MB_DRAFT_ID}`, (route) =>
    route.fulfill(
      json({
        book: {
          id: MB_DRAFT_ID,
          workId: WORK_ID,
          status: 'draft',
          kind: 'on_account',
          isFinal: false,
          consigneeContactId: null,
          mergedIntoId: null,
          mbDate: '2026-08-09',
          mbNumber: null,
          sequenceNumber: null,
          totalAmount: null,
          remarkTemplateVersion: null,
          templateVersion: null,
          renderedAvailable: false,
          cancellationNote: null,
          billId: null,
          createdAt: '2026-08-09T00:00:00.000Z',
          finalizedAt: null,
          cancelledAt: null,
          closedAt: null,
          closedByReceivedBillId: null,
        },
        sources: [],
        lines: [
          {
            workItemId: ITEM_ID,
            itemNumber: 'A/1',
            description: 'Signalling cable',
            unitCode: 'mtr',
            paymentCategory: 'SUPPLY',
            resolvedCategory: 'SUPPLY',
            pctSupply: '80.00',
            pctInstallation: '0.00',
            pctPac: '0.00',
            pctFinalBill: '20.00',
            effectiveRate: '100.000000',
            deltaSupplied: '8.000',
            deltaInstalled: '0.000',
            sourceSupplied: '10.000',
            sourceInstalled: '0.000',
            overrideSupplied: '8.000',
            overrideInstalled: null,
            deltaPac: '0.000',
            deltaFinalBill: '0',
            priorSupplied: '0.000',
            priorInstalled: '0.000',
            priorPac: '0.000',
            priorFinalBill: '0.000',
            amountSupply: '640.00',
            amountInstallation: '0.00',
            amountPac: '0.00',
            amountFinalBill: '0.00',
            lineTotal: '640.00',
            remark: 'Now to pay 80% for 8 mtr.',
          },
        ],
        warnings: [],
        previewTotal: '640.00',
        unbillableVariationExposure: '0',
        measurementAdjustedAway: '160.00',
      }),
    ),
  );
  await page.route(`**/api/challans/${CHALLAN_ID}/correction-eligibility`, (route) =>
    route.fulfill(
      json({
        challanId: CHALLAN_ID,
        status: 'issued',
        evidence: { receipts: 0, serials: 1, measurements: 0 },
        path: 'correction_notice',
        pendingRequestId: null,
      }),
    ),
  );
  await page.route(`**/api/challans/${CHALLAN_ID}/correction-notices`, (route) =>
    route.fulfill(json({ notices: [] })),
  );
  await page.route(`**/api/audit/entity/delivery_challans/${CHALLAN_ID}*`, (route) =>
    route.fulfill(json({ events: [], nextCursor: null })),
  );

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('link', { name: 'Works', exact: true }).click();
  await page.getByRole('link', { name: 'DCW-1' }).click();
  // Code and name are two lines of the heading now, per the mock's Work
  // header, so what joins them is a space rather than the old em dash.
  await expect(
    page.getByRole('heading', { name: /DCW-1\s+Supply of switchboards/ }),
  ).toBeVisible();
  // The Work page splits its areas across tabs, so each one is opened and
  // scanned in turn rather than asserted on a single scroll.
  const workTabs = () => page.getByRole('navigation', { name: 'Work sections' });
  const openTab = async (label: string) => {
    // Scoped to the tab strip: the Overview summary offers a button per area
    // too, and both carry the same label. The name carries the count, so the
    // match is loose rather than a RegExp built from a variable.
    await workTabs().getByRole('button', { name: label, exact: false }).first().click();
  };

  await openTab('Overview');
  await expect(page.getByRole('heading', { name: 'Completion status' })).toBeVisible();
  await expect(page.getByLabel('Why this Work is being completed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete Work' })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — overview');

  await openTab('Schedules');
  await expect(page.getByRole('heading', { name: 'Payment matrix' })).toBeVisible();
  await expect(page.getByLabel('Supply % for Supply', { exact: true })).toHaveValue(
    '80.00',
  );
  await expect(page.getByLabel('Payment category for A/1')).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — schedules');

  await openTab('Deliveries');
  await expect(
    page.getByRole('heading', { name: 'Delivery Challans', exact: true }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — deliveries');

  await openTab('Installations');
  await expect(
    page.getByRole('heading', { name: 'Installations', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Record installations' }),
  ).toBeVisible();
  // The site-added serial's chip (migration 0108) is on the record row, so
  // its warning tint is measured in both themes rather than only asserted.
  await expect(page.getByText('added here')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Serial trace' })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — installations');

  /* The tabular recording flow (corrections ledger items 10 and 12). It
     is behind the verb that names it, and everything new about this
     screen is inside — the item table with its per-row number and serial
     fields, the shared date and location above it, and the search box
     over the items. Scanned open, in both themes, because a closed
     disclosure proves nothing about the controls it hides. */
  await page
    .getByRole('button', { name: 'Record installations', expanded: false })
    .click();
  await expect(page.getByLabel('Find an item')).toBeVisible();
  await expect(page.getByLabel('Quantity of A/1 installed now')).toBeVisible();
  // The serials field and the delivered pool's tap-in buttons, which only a
  // serial-tracked row draws.
  await expect(page.getByLabel('Serials of A/2 installed now')).toBeVisible();
  await expect(page.getByRole('button', { name: 'SN-101' })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — installation recording table');

  await openTab('Measurement');
  await expect(
    page.getByRole('heading', { name: 'Measurement evidence', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Measurement Books' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'DCW-1-MB-01' })).toBeVisible();
  await expect(page.getByText('FINAL BILL', { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — measurement');

  // The DRAFT's preview, scanned separately because that is where the
  // editable measured quantity lives (docs/UX.md § 25): a field,
  // the claimed figure beside it as its own description, and the amount
  // the pair prices. The register above carries none of them.
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect(page.getByLabel('Supplied quantity measured for item A/1')).toHaveValue(
    '8.000',
  );
  await expect(page.getByText('of 10.000')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save measured quantities' }),
  ).toBeVisible();
  // The rupee value of what the adjustment left out, on the warning
  // surface the unbillable exposure already uses — scanned because it is
  // colour on colour and the one place the reduction is stated as money.
  await expect(page.getByText('Measured down on this Measurement Book')).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — measurement book draft');

  /* The railway measurement panel (0111), scanned in the two shapes that
     put colour on a word. The MATCHED shape reuses the success chip every
     register already draws and needs no separate pass; the two below are
     the ones with new tone usage on this screen — a destructive chip
     beside a sentence naming a quantity difference, and a warning chip
     above a column of per-line buttons.

     Opened rather than asserted from the register, because the panel only
     exists inside a finalized book's detail. */
  await openMeasurementBook(page, WORK_ID, 'DCW-1-MB-01', {
    matchStatus: 'mismatched',
    settles: false,
    lines: [
      {
        itemNumber: 'A/1',
        matched: false,
        refusal: 'quantity',
        detail:
          "Item A/1: this Measurement Book measures 2.8, the railway's measurement records 2.1.",
        confirmedByUserId: null,
        confirmedAt: null,
      },
    ],
  });
  await expect(page.getByText('Does not match')).toBeVisible();
  // The rule the panel must not soften, asserted here as well as in the
  // unit test: a mismatch offers no way past itself.
  await expect(page.getByRole('button', { name: /^Confirm item/ })).toHaveCount(0);
  await expectNoAxeViolations(page, 'railway measurement — mismatched');

  await openMeasurementBook(page, WORK_ID, 'DCW-1-MB-02', {
    matchStatus: 'unreadable',
    settles: false,
    lines: [
      {
        itemNumber: 'A/1',
        matched: false,
        refusal: null,
        detail: null,
        confirmedByUserId: null,
        confirmedAt: null,
      },
      {
        itemNumber: 'A/6',
        matched: false,
        refusal: null,
        detail: null,
        confirmedByUserId: 'user-1',
        confirmedAt: '2026-08-06T09:00:00.000Z',
      },
    ],
  });
  // Exact: the chip's word and the sentence explaining it both carry the
  // phrase, and the chip is what this scan is about.
  await expect(page.getByText('Could not be read', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm item A/1' })).toBeVisible();
  // The discarded-history list, scanned with the rest: a destructive chip
  // inside body text is a contrast pairing the section headings above it
  // never produce.
  await expect(
    page.getByRole('heading', { name: 'Previously recorded and discarded' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'railway measurement — awaiting confirmation');

  await openTab('Bills');
  await expect(page.getByRole('heading', { name: /Bill #1/ })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — bills');

  await openTab('Instruments');
  await expect(
    page.getByRole('heading', { name: 'Contract instruments' }),
  ).toBeVisible();
  // The retention ledger (0098) shares this tab, and the scan below is
  // the one that covers it. Waiting on a rupee figure rather than on the
  // heading is what makes the scan run against the LOADED panel — the
  // heading is rendered beside a skeleton while the position is in
  // flight, and a scan of a skeleton proves nothing about the chips.
  await expect(
    page.getByRole('heading', { name: 'Retention and liquidated damages' }),
  ).toBeVisible();
  await expect(page.getByText('₹1,00,000.00')).toBeVisible();
  await expect(page.getByText('levied', { exact: true })).toBeVisible();
  await expect(page.getByText('waived', { exact: true })).toBeVisible();
  /* The defect liability card (0099) sits on this tab, beside the
     Performance Bank Guarantee it explains, so it is scanned here rather
     than in a test of its own — re-mounting this forty-route fixture for
     one card costs more than it proves. What the scan needs on screen is
     the shortfall chip, which is the one warning tint the card carries,
     and the start table's own controls, which the register behind it
     never draws. */
  await expect(page.getByRole('heading', { name: 'Defect liability' })).toBeVisible();
  await expect(page.getByText(/24 months from the installation date/)).toBeVisible();
  await expect(page.getByText(/Short by 45 days/)).toBeVisible();
  await page
    .getByRole('button', { name: /Start a defect liability period/, expanded: false })
    .click();
  await expect(page.getByRole('button', { name: 'Start period' })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail');

  // The challan list lives under Deliveries.
  await openTab('Deliveries');
  await page.getByRole('link', { name: 'DC/1' }).click();
  await expect(
    page.getByRole('heading', { name: 'Delivery Challan DC/1' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery receipt' })).toBeVisible();
  // The record-and-create forms sit behind the verb that names them, so the
  // page opens as what is true and asks only when asked. Each one still
  // holds exactly the fields it always did.
  await page
    .getByRole('button', { name: 'New serial numbers', expanded: false })
    .click();
  await expect(page.getByLabel('Serial numbers (one per line)')).toBeVisible();
  await page.getByRole('button', { name: 'New installation', expanded: false }).click();
  await expect(page.getByLabel('Installed on')).toBeVisible();
  // The correction flow states the lawful path for an evidence-carrying
  // challan and offers the notice form.
  await expect(page.getByRole('heading', { name: 'Request correction' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Request correction notice…', expanded: false })
    .click();
  await expect(page.getByLabel('Correction statement')).toBeVisible();
  await expectNoAxeViolations(page, 'challan detail with evidence');

  await page.getByRole('button', { name: 'Back to Work' }).click();
  // The active tab survives the trip into a challan and back: the operator
  // came from Deliveries, so the delivery surface is the one still on screen.
  await expect(workTabs().locator('button[aria-current="page"]')).toHaveText(
    /^Deliveries/,
  );
  await page.getByRole('button', { name: 'New Delivery Challan' }).click();
  await expect(
    page.getByRole('heading', { name: 'New Delivery Challan' }),
  ).toBeVisible();
  await expect(page.getByLabel('Quantity of A/1 on this challan')).toBeVisible();
  await expectNoAxeViolations(page, 'challan editor');

  /* An open confirmation, scanned. Every destructive confirmation in the
     product now renders one shared primitive (`ui/confirm.tsx` over
     `ui/dialog.tsx`), so scanning one scans the shape of all twelve — the
     dialog role, the name it borrows from its own heading, the description,
     and the backdrop that must stay out of the accessibility tree. */
  await page.getByLabel('Quantity of A/1 on this challan').fill('1');
  await page.getByRole('button', { name: 'Cancel' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Discard your changes?' });
  await expect(confirmation).toBeVisible();
  // Focus lands on the safe choice, so Enter on an unread dialog is never
  // the destructive answer.
  await expect(
    confirmation.getByRole('button', { name: 'Keep editing' }),
  ).toBeFocused();
  await expectNoAxeViolations(page, 'challan editor — discard confirmation');
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);

  /* The tenant-wide installation register, reached from the Operations
     group of the rail. Scanned here rather than in a suite of its own
     because the fixture that makes a Work's installations readable is
     already mounted on this page. */
  await page
    .getByRole('navigation', { name: 'Modules' })
    .getByRole('link', { name: 'Installations' })
    .click();
  // The editor is still dirty from the line above, so the shell asks
  // before it lets go.
  await page.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page.getByRole('link', { name: 'DCW-1' })).toBeVisible();
  await expect(page.getByText('Nashik Road station')).toBeVisible();
  await expectNoAxeViolations(page, 'installation register');

  /* The organisation-wide invoice register, reached from the Documents
     group. Scanned with both kinds of row on screen — a work-backed one
     linking to its Work and a direct one that has none — because the
     source cell is the only place in the product where a table cell is
     sometimes a link and sometimes a word, and with the direct-invoice
     editor's disclosure present. */
  await page
    .getByRole('navigation', { name: 'Modules' })
    // Exact: the rail names "Historical invoices" directly beneath this
    // one (0115), and a substring match resolves to both.
    .getByRole('link', { name: 'Invoices', exact: true })
    .click();
  await expect(page.getByRole('link', { name: 'TI/2026-27/001' })).toBeVisible();
  await expect(page.getByText('Deccan Switchgear Pvt Ltd')).toBeVisible();
  await expectNoAxeViolations(page, 'invoice register');

  // The direct-invoice form open: a long two-column form is where label
  // association and focus order are most likely to go wrong.
  await page
    .getByRole('button', { name: 'Raise an invoice for a private customer' })
    .click();
  // By role, not by label alone: the register's own table caption names
  // its Taxable value column, so a bare label lookup matches two things.
  await expect(page.getByRole('textbox', { name: 'Taxable value' })).toBeVisible();
  await expectNoAxeViolations(page, 'invoice register — direct invoice form');

  /* One invoice OPENED from the register. This is the only axe coverage
     the opened-invoice surface has anywhere: it is reached from two
     screens and scanned from neither, and it is the densest surface in
     the module — frozen document facts, the PDF control, the IRP
     transport with its disclosures and forms, credit notes and e-way
     bills. Opened on a submitted, IRP-registered invoice, because that
     state renders all of it. */
  await page.getByRole('link', { name: 'TI/2026-27/001' }).click();
  // By level: the document's own heading is the h3, and the register adds
  // a visually hidden h2 above it so the tree does not jump h1 to h3 —
  // both carry the invoice number, so the level is what tells them apart.
  await expect(
    page.getByRole('heading', { level: 3, name: 'TI/2026-27/001 submitted' }),
  ).toBeVisible();
  await expect(page.getByText('Government e-invoicing')).toBeVisible();
  await expectNoAxeViolations(page, 'invoice register — opened invoice');
});

test('the workspace keeps the tenant header on every scoped request', async ({
  page,
}) => {
  const scopedHeaders: (string | undefined)[] = [];
  await page.route('**/api/me', (route) => route.fulfill(json(ME)));
  await page.route('**/api/organisations', (route) =>
    route.fulfill(json({ organisations: [ORG] })),
  );
  await page.route('**/api/dashboard', (route) => {
    scopedHeaders.push(route.request().headers()['x-organisation-id']);
    return route.fulfill(json(DASHBOARD));
  });
  await page.route('**/api/works', (route) => {
    scopedHeaders.push(route.request().headers()['x-organisation-id']);
    return route.fulfill(json({ works: [] }));
  });
  await page.route('**/api/loa-documents', (route) => {
    scopedHeaders.push(route.request().headers()['x-organisation-id']);
    return route.fulfill(json({ documents: [] }));
  });
  await page.route('**/api/approvals*', (route) => {
    scopedHeaders.push(route.request().headers()['x-organisation-id']);
    return route.fulfill(json({ approvals: [] }));
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('link', { name: 'Works', exact: true }).click();
  await expect(page.getByText(/No Works yet/)).toBeVisible();

  expect(scopedHeaders.length).toBeGreaterThanOrEqual(4);
  expect(scopedHeaders.every((header) => header === ORG.id)).toBe(true);
});

/* The bottom bar and its two sheets exist only below `lg`, so the suite's
   desk width had never seen them and the two mobile projects only run the
   responsive spec. This block is the axe coverage they were missing: the
   sheets are scanned OPEN, in both themes, at the narrowest viewport the
   product claims to support. */
test.describe('mobile shell', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('the bottom bar and both sheets pass the axe scan and keep the keyboard', async ({
    page,
  }) => {
    await mockWorkspace(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    const bar = page.getByRole('navigation', { name: 'Mobile navigation' });
    const record = bar.getByRole('button', { name: 'Record', exact: true });
    const more = bar.getByRole('button', { name: 'More', exact: true });
    await expect(bar.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Works', exact: true })).toBeVisible();
    await expect(record).toBeVisible();
    await expect(more).toBeVisible();
    // The mock's `min-h-14` touch target, on the cell that used to be a
    // raised button floating out of the bar.
    const cell = await record.boundingBox();
    expect(cell?.height ?? 0).toBeGreaterThanOrEqual(56);
    await expectNoAxeViolations(page, 'mobile bottom bar');

    await record.click();
    const recordSheet = page.getByRole('dialog', { name: 'Record field activity' });
    await expect(recordSheet).toBeVisible();
    // No Work is open, so the sheet says why it offers no record buttons
    // and still leaves the way to one.
    await expect(
      recordSheet.getByText('Choose a Work before recording site evidence.'),
    ).toBeVisible();
    await expect(recordSheet.getByRole('button', { name: 'Open Works' })).toBeVisible();
    // Focus moved into the sheet rather than staying on a covered control.
    await expect(recordSheet.getByRole('button', { name: 'Close' })).toBeFocused();
    await expectNoAxeViolations(page, 'mobile record sheet');
    await page.keyboard.press('Escape');
    await expect(recordSheet).toBeHidden();
    await expect(record).toBeFocused();

    await more.click();
    const moreSheet = page.getByRole('dialog', { name: 'More modules' });
    await expect(moreSheet).toBeVisible();
    await expect(moreSheet.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expectNoAxeViolations(page, 'mobile more sheet');
    await page.keyboard.press('Escape');
    await expect(moreSheet).toBeHidden();
    await expect(more).toBeFocused();

    // And the destinations behind it still open, from the keyboard.
    await more.press('Enter');
    await expect(moreSheet).toBeVisible();
    await moreSheet.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(moreSheet).toBeHidden();
  });
});

/* Maintenance (migration 0088). Its own test rather than a leg of the
   organisation-picker journey: that one is already over Playwright's 30s
   default and carries `test.slow()` saying so, and five more scans is
   ten more serial axe runs on it. The receivables register set the
   precedent and the comment on that leg names it.

   Six scans, because the module puts colour on a word in six places, and
   two of them are surfaces the mock does not draw at all (`docs/UX.md`
   § 14 rows 14o and 14d) and would otherwise be the only unscanned
   markup in the pack. */
test('maintenance register, job card and request form pass the axe scan', async ({
  page,
}) => {
  test.slow();
  await mockWorkspace(page);
  await page.goto('/');

  /* The REGISTER carries every stage chip this module can render — the
     two warning-tinted ones and the neutral closed — beside the
     success-tinted `approved` the vocabulary already had, all four on one
     screen at once. Locators are qualified by role because a bare string
     would also match the stage strip above the table. */
  await page.getByRole('link', { name: 'Maintenance' }).click();
  await expect(
    page.getByRole('heading', { name: 'Maintenance', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Awaiting approval' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Dispatching' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Approved' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Closed' })).toBeVisible();
  await expectNoAxeViolations(page, 'maintenance register');

  /* The JOB CARD carries three progress bars, the boxed tab rail, and a
     numeric table whose Available column is an em dash for the custom
     line and a written-off line beneath it. */
  await page.getByRole('link', { name: 'MR/26-27/00142' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Replace failed platform display power supplies',
    }),
  ).toBeVisible();
  await expect(page.getByText('Written off 2.000')).toBeVisible();
  // The operational-impact card, which the mock collects and never shows
  // (§ 14 row 14p).
  await expect(page.getByText('Two display boards unavailable')).toBeVisible();
  await expectNoAxeViolations(page, 'maintenance job card');

  /* THE WRITE-OFF PANEL — invented here, because the mock's own closure
     gate reads a column nothing in the mock ever writes (§ 14 row 14d).
     It is a labelled text field and two buttons that appear under the
     table, and nothing else in the suite renders it. */
  await page
    .getByRole('row', { name: /24 V 10 A SMPS/ })
    .getByRole('button', { name: 'Write off' })
    .click();
  await expect(page.getByLabel(/not being sent/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Write off the balance' }),
  ).toBeDisabled();
  await expectNoAxeViolations(page, 'maintenance write-off panel');

  await page.getByRole('button', { name: 'Dispatch', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Record partial or full dispatch' }),
  ).toBeVisible();
  // The delivery-instructions line, which the mock also collects and
  // never shows (§ 14 row 14q), and the disabled primary action.
  await expect(page.getByText('Hand over to site supervisor')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Create dispatch & challan/ }),
  ).toBeDisabled();
  await expectNoAxeViolations(page, 'maintenance dispatch tab');

  await page.getByRole('button', { name: 'Defective returns' }).click();
  await expect(
    page.getByRole('heading', { name: 'Receive defective items' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'maintenance defective returns tab');

  /* THE APPROVAL CARD — the other invented surface (§ 14 row 14o). It
     renders only for an owner on a request still awaiting approval, so it
     needs its own fixture: the register's second row. */
  await page.route('**/api/maintenance/*', (route) =>
    route.fulfill(json(MAINTENANCE_AWAITING_APPROVAL)),
  );
  await page.getByRole('button', { name: 'Maintenance', exact: true }).first().click();
  await page.getByRole('link', { name: 'MR/26-27/00141' }).click();
  await expect(page.getByRole('heading', { name: 'Admin approval' })).toBeVisible();
  await expect(page.getByLabel('Approval comment')).toBeVisible();
  await expect(page.getByRole('button', { name: /Approve request/ })).toBeEnabled();
  await expectNoAxeViolations(page, 'maintenance approval card');

  await page.getByRole('button', { name: 'Maintenance', exact: true }).first().click();
  await page.getByRole('button', { name: 'New material request' }).click();
  await expect(
    page.getByRole('heading', { name: 'Site material request' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Send for admin approval/ }),
  ).toBeDisabled();
  await expectNoAxeViolations(page, 'maintenance request form');
});

test('production register, job card and item master pass the axe scan', async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto('/');

  await page.getByRole('link', { name: 'Production', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Production' })).toBeVisible();
  // Scanned with a row on screen: the register's tints — the status chip,
  // the Material badge and the progress bar — live in the row and would
  // never be scanned against an empty table. The badge is the pack's one
  // warning-tinted word, and it is the shortage the stock ledger makes
  // real, so it is asserted rather than left to chance.
  await expect(page.getByText('PP-26-081')).toBeVisible();
  await expect(page.getByText('part short')).toBeVisible();
  await expectNoAxeViolations(page, 'production register');

  await page.getByRole('link', { name: 'PP-26-081' }).click();
  await expect(
    page.getByRole('heading', { name: 'IP Display Board · 6 line' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'production job card overview');

  // The Materials tab: Required, Available and Shortage in three numeric
  // columns, none of them tinted, so the figures have to hold contrast on
  // the plain table surface in both themes.
  await page.getByRole('button', { name: 'Materials' }).click();
  await expect(page.getByRole('columnheader', { name: 'Shortage' })).toBeVisible();
  await expect(page.getByText('8.000')).toBeVisible();
  await expectNoAxeViolations(page, 'production job card materials');

  // The Serials tab is the one place this module colour-codes a figure —
  // the captured/required count goes destructive short and success
  // complete — so it is scanned in its own right.
  await page.getByRole('button', { name: 'Serials' }).click();
  await expect(page.getByText('Serialized components')).toBeVisible();
  await expectNoAxeViolations(page, 'production job card serials');

  await page.getByRole('button', { name: 'Dispatch' }).click();
  await expect(page.getByRole('heading', { name: 'Releases' })).toBeVisible();
  await expectNoAxeViolations(page, 'production job card dispatch');

  await page.goto('/#/production/items');
  await expect(page.getByRole('heading', { name: 'Manufactured items' })).toBeVisible();
  // By role, not text: while the BOM is still loading, the sr-only
  // "Loading the bill of material…" line also matches the bare text and
  // strict mode refuses the ambiguity — which only reproduces on a
  // runner slow enough for the loading state to still be on screen.
  await expect(page.getByRole('heading', { name: 'Bill of material' })).toBeVisible();
  await expectNoAxeViolations(page, 'production item master');
});

test('the signing queue passes the axe scan', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/#/signing');

  /* The signing queue (0091, ADR-0012). Its own top-level test rather
     than a leg of an existing journey, for the reason Receivables and
     Correspondence took theirs: the big picker journey is already
     budgeted with test.slow() and does not need another leg.

     Scanned with all four statuses on screen at once, because the chip is
     the only colour this screen puts on a word — and with the kiosk panel
     above them, whose success lamp and warning border are the only other
     two. The full SHA-256 in every row is the reason the target-size and
     the contrast rules matter here more than on a normal register: it is
     11px monospace, wrapped, and it is what an operator compares against
     the kiosk's console. */
  await expect(page.getByRole('heading', { name: 'Signing queue' })).toBeVisible();
  await expect(page.getByText('Cabin kiosk')).toBeVisible();
  for (const label of ['pending', 'claimed', 'signed', 'failed']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText('a'.repeat(64)).first()).toBeVisible();
  await expectNoAxeViolations(page, 'signing queue');

  // The withdrawal dialog: a destructive confirm whose primary action is
  // disabled until a reason is typed, which is a contrast state a scan of
  // the register behind it never reaches.
  await page.getByRole('button', { name: 'Withdraw' }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Withdraw this signing request' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'signing withdrawal dialog');

  // The signed document opens from the row, so the action is drawn on a
  // completed request and scanned with the rest.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open signed PDF' })).toBeVisible();
});

test('the notifications screen passes the axe scan', async ({ page }) => {
  await mockWorkspace(page);
  // The shared contact master answers empty, which is the state the stock
  // shortage scan needs. Both write forms here pick a contact from it, so
  // a later, more specific handler gives this screen one to pick — a
  // disabled submit is a different contrast state from an enabled one,
  // and the enabled one is what an operator actually meets.
  await page.route('**/api/masters/contacts*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contacts: [
          {
            id: '44444444-0092-4000-8000-000000000000',
            designation: 'Sr. DEE (G) CR Nagpur',
            contactPerson: null,
            address: null,
            phone: null,
            email: null,
            gstin: null,
            pincode: null,
            stateCode: null,
            isConsignee: true,
            isVendor: false,
            isClient: false,
            isEmployee: false,
            active: true,
          },
        ],
      }),
    }),
  );
  await page.goto('/#/notifications');

  /* Notifications (0092). Its own top-level test rather than a leg of an
     existing journey, for the reason the signing queue took its own: the
     big picker journey is already budgeted with test.slow().

     Scanned with every tint on screen at once. Four sections, and the
     colour is entirely in their chips: an ENABLED channel whose
     deployment has no transport draws a success lamp and a warning lamp
     side by side — the one state on this screen with no precedent in the
     mock — and the template list and the delivery log carry every status
     word that tints, including the two that deliberately read neutral. */
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText('+919000000001')).toBeVisible();
  await expect(page.getByText('no transport')).toBeVisible();
  for (const label of ['approved', 'pending', 'rejected', 'paused', 'draft']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  for (const label of ['queued', 'sent', 'delivered', 'read', 'failed']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText('opted in').first()).toBeVisible();
  await expect(page.getByText('opted out').first()).toBeVisible();
  await expectNoAxeViolations(page, 'notifications registers');

  /* Every form on the screen, opened together. A form is where label
     association and focus order actually fail, and these four are
     different shapes: a field row plus a checkbox, a select with a
     textarea, a three-select row, and a two-select row. The per-row
     status control is drawn already — its select and its conditional
     reason box are the only controls on this screen that appear INSIDE a
     table cell, which is where a label that is only visually adjacent
     stops being a label at all. */
  await page.getByRole('button', { name: 'Change WhatsApp settings' }).click();
  await page.getByRole('button', { name: 'Write a template' }).click();
  await page.getByRole('button', { name: 'Record a consent' }).click();
  await page.getByRole('button', { name: 'Send a message' }).click();
  await expect(page.getByLabel('Phone number id')).toBeVisible();
  await expect(page.getByLabel('Body')).toBeVisible();
  await expect(page.getByLabel('How it was obtained')).toBeVisible();
  await expect(page.getByLabel('Parameters')).toBeVisible();
  // The reason box only exists for the three statuses Meta explains, so
  // it is opened deliberately rather than left to chance.
  await page.getByLabel('New status for payment_due').selectOption('disabled');
  await expect(page.getByLabel('What Meta said about payment_due')).toBeVisible();
  await expectNoAxeViolations(page, 'notifications forms');
});

test('the imports register passes the axe scan', async ({ page }) => {
  // Four scans, so eight axe runs — the heaviest single test in this
  // file. The same budget the picker journey takes, for the same reason:
  // a lazily-loaded view whose chunk is fetched while the preview server
  // is still serving the previous test's scans has to be waited for, not
  // raced.
  test.slow();
  await mockWorkspace(page);
  await page.goto('/#/imports');

  /* Spreadsheet imports (0094). Its own top-level test rather than a leg
     of an existing journey, for the reason the signing queue took one:
     the big picker journey is already budgeted with test.slow().

     Scanned with all three batch statuses on screen at once, because the
     chip is the only colour this screen puts on a word. The row errors
     are the other pairing worth measuring — 11px prose in the muted ink,
     inside a wrapping cell, which is the combination most likely to miss
     AA in one theme and pass in the other. */
  await expect(
    page.getByRole('heading', { name: 'Imports', exact: true }),
  ).toBeVisible();
  for (const label of ['validated', 'completed', 'cancelled']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expectNoAxeViolations(page, 'imports register');

  // The open batch: the row-level error table, its `error` and `valid`
  // chips, and the button that says how many rows it will write. None of
  // those states is reachable from the register scan above.
  await page.getByRole('button', { name: 'Open' }).first().click();
  await expect(page.getByRole('button', { name: /Import 2 rows/ })).toBeVisible();
  await expect(page.getByText('rule R16', { exact: false })).toBeVisible();
  for (const label of ['error', 'valid']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expectNoAxeViolations(page, 'imports batch detail');

  // The column guide, which is a disclosure the register scan leaves
  // closed — and the only place a `required` marker is drawn.
  await page.getByRole('combobox', { name: 'Register' }).selectOption('contacts');
  await page.getByText(/Columns this register reads/).click();
  await expect(page.getByText('required').first()).toBeVisible();
  await expectNoAxeViolations(page, 'imports column guide');

  // The withdrawal dialog: a destructive confirm whose primary action is
  // disabled until a reason is typed.
  await page.getByRole('button', { name: 'Withdraw' }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Withdraw this import' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'imports withdrawal dialog');
});

test('the audit register and the management summary pass the axe scan', async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto('/#/audit');

  /* The two screens migration 0095 adds, scanned together because they
     are one pack's grammar and neither is on an existing journey.

     The audit register is the harder of the two and the reason this is
     its own test: it is five filter controls with `sr-only` labels over a
     dense table, and every one of those labels is a place label
     association fails silently. The DIFF is the other reason — the
     before/after in the detail sheet renders the old value with a
     line-through and the new one in bold, which is the one place on
     either screen where meaning could rest on presentation alone. It does
     not: an `sr-only` "changed to" carries the relationship, and the scan
     is what keeps that true. */
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
  // Matched inside the table rather than by text alone: the same sentence
  // is also an <option> in the action picker, and an option in a closed
  // select is hidden.
  await expect(
    page.getByRole('cell', { name: 'Challan issued', exact: true }),
  ).toBeVisible();
  // The retention sentence: the register says how far back it reached,
  // because a window that showed less than the dates asked for would
  // otherwise read as a quiet organisation.
  await expect(page.getByText(/This register looks back to/)).toBeVisible();
  await expectNoAxeViolations(page, 'audit register');

  // The detail sheet, with the before/after list on screen.
  await page.getByRole('button', { name: 'Detail' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoAxeViolations(page, 'audit event detail');
  await page.keyboard.press('Escape');

  /* The management summary: three dense numeric tables and a tile row.
     Every figure is monospace and right-aligned, and the ageing table
     always draws all five bands — including the zero ones, which is the
     contrast state a table of only populated rows would never reach. */
  await page.goto('/#/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Output tax by month' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Receivables ageing' })).toBeVisible();
  await expect(
    page.getByRole('rowheader', { name: 'Over 90 days', exact: true }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'management summary');
});

test('the signing kiosk settings pass the axe scan', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/#/settings');

  /* The owner-only panel that hands out a kiosk credential (0091). Its
     own scan rather than a leg of the queue journey: it is a FORM — a
     textarea for a PEM chain, two inputs, a destructive revoke — and a
     form is where label association and focus order actually fail. */
  await expect(page.getByRole('heading', { name: 'Signing kiosk' })).toBeVisible();
  await expect(page.getByText('Cabin kiosk')).toBeVisible();
  await expect(page.getByLabel('Certificate chain (PEM, signer first)')).toBeVisible();
  await expectNoAxeViolations(page, 'signing kiosk settings');

  // The revoke confirmation: a destructive dialog whose copy warns that
  // queued work will be failed.
  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Revoke this signing kiosk' }),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'signing kiosk revoke dialog');
});

test('the platform settings pass the axe scan', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/#/settings');

  /* The owner-only operator controls (0096). Their own scan rather than a
     leg of another journey, because between them they draw four things a
     register never does: a chip whose meaning is "off" rather than
     "cancelled", a dense run-history table with an outcome column, a
     64-character digest printed in full and wrapped, and a primary action
     that is DISABLED while a build is in flight — which is a contrast
     state nothing else on the page reaches. */
  await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible();
  await expect(page.getByText('E-way bill', { exact: true })).toBeVisible();
  await expect(page.getByText(/never configured/)).toBeVisible();
  await expect(page.getByText('Guarantee and certificate expiry')).toBeVisible();
  // The note that says WHY a module is off — the fact the column exists
  // to carry, and one a panel could store and never show.
  await expect(page.getByText(/waiting on NIC re-certification/)).toBeVisible();
  // The refused-bind run's remedy, which is the one sentence on this
  // screen an operator has to act on, and the CONTROL it names. A remedy
  // whose only button switches the check off would make the operator
  // disable a statutory check to fix its custody.
  await expect(page.getByText(/no longer in the organisation/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run as me' })).toBeVisible();
  // The two settings the screen displays and used to have no way to
  // change: a select and a bounded number input, both of which are
  // label-association and focus-order surfaces a table never reaches.
  await expect(page.getByLabel('How often')).toBeVisible();
  await expect(page.getByLabel('Days ahead')).toBeVisible();
  await expectNoAxeViolations(page, 'platform settings');

  await expect(
    page.getByRole('heading', { name: 'Organisation export' }),
  ).toBeVisible();
  await expect(page.getByText('f'.repeat(64))).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
  await expectNoAxeViolations(page, 'organisation export panel');
});

test('the purchase order register passes the axe scan', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/#/purchase-orders');

  /* The top-level register migration 0109 adds, ported from the mock's own
     `app/purchase-orders/page.tsx` at fdfd610. Its own test rather than a
     leg of the big picker journey, for the reason Warranties and the
     signing queue took theirs.

     Scanned with the tab tray, the table and the create disclosure on
     screen together: the tray is a `role="group"` of `aria-pressed`
     toggles (the pattern `docs/UX.md` § 9 settles for filter pills), the
     Against column carries the only in-table link the register has, and
     the disclosure's form is where label association and focus order
     actually fail. Both tabs are scanned, because the second one is the
     one whose rows have no Work behind them and therefore a different
     cell shape. */
  await expect(page.getByRole('heading', { name: 'Purchase orders' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Purchase order basis' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'PO number' })).toBeVisible();
  await expect(page.getByText('PL270-CRB-PO-01')).toBeVisible();
  await expectNoAxeViolations(page, 'purchase order register, work basis');

  await page.getByRole('button', { name: /Outside any LOA \(/ }).click();
  await expect(page.getByText('PO-01', { exact: true })).toBeVisible();
  await expect(page.getByText('Outside any LOA').first()).toBeVisible();
  await expectNoAxeViolations(page, 'purchase order register, organisation basis');
});

test('the historical invoice register passes the axe scan', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/#/historical-invoices');

  /* The Zoho Books history (0115). Its own top-level test rather than a
     leg of the invoice journey, for the reason the warranty register
     below took one: that journey is already budgeted with test.slow().

     Scanned with the filter row, the import panel and the register on
     screen together — three labelled controls beside a submit, a file
     input whose label is the only thing naming it, and a table whose
     Work cell is sometimes a link and sometimes a word. All three
     readings of the e-invoice chip are drawn — issued, draft and the
     Zoho void that renders cancelled — because it is the only colour this
     screen puts on a word and each tone has to hold against its ground in
     both themes. */
  await expect(
    page.getByRole('heading', { name: 'Historical invoices' }),
  ).toBeVisible();
  await expect(page.getByLabel('Zoho Books export (.csv)')).toBeVisible();
  await expect(page.getByLabel('Customer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Financial year')).toBeVisible();
  await expect(page.getByRole('link', { name: /PL270-CRB/ })).toBeVisible();
  // By cell: the filter's own "Not filed against a Work" option carries
  // the same words inside a closed select, where nothing is visible.
  await expect(
    page.getByRole('cell', { name: 'Not filed', exact: true }).first(),
  ).toBeVisible();
  for (const label of ['issued', 'draft', 'cancelled']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expectNoAxeViolations(page, 'historical invoice register');
});

test('the Tally ledger census passes the axe scan', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/#/tally-masters');

  /* The Tally masters mirror (0118). Its own top-level test for the same
     reason the register above took one.

     Scanned with the filter row, the import panel and the census on
     screen together — three labelled controls beside a submit, a file
     input whose label is the only thing naming it, and a table whose
     class cell is the only colour this screen puts on a word. All four
     tones are drawn, because each has to hold against its ground in both
     themes, and `other` is the one that renders neutral. */
  await expect(page.getByRole('heading', { name: 'Tally census' })).toBeVisible();
  await expect(page.getByLabel('TallyPrime All Masters export (.xml)')).toBeVisible();
  await expect(page.getByLabel('Ledger name')).toBeVisible();
  // `exact` on both: the table's own caption region is named by the whole
  // caption sentence, which contains the words "kind" and "master".
  await expect(page.getByLabel('Kind', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Contacts master', { exact: true })).toBeVisible();
  for (const label of ['Customer', 'Vendor', 'Instrument', 'Other']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // TEXT, not a link — owner rulings 4 and 5. Asserted by cell so the
  // filter's own option text cannot satisfy it.
  await expect(page.getByRole('cell', { name: 'PL-270', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'PL-270' })).toHaveCount(0);
  // The half an operator works through.
  await expect(
    page.getByRole('cell', { name: 'None proposed', exact: true }).first(),
  ).toBeVisible();
  await expectNoAxeViolations(page, 'tally ledger census');
});

test('the warranty register passes the axe scan', async ({ page }) => {
  await mockWorkspace(page);
  await page.goto('/#/warranties');

  /* Defect liability periods (0099). Its own top-level test rather than a
     leg of an existing journey, for the reason Receivables and the
     signing queue took theirs: the big picker journey is already budgeted
     with test.slow() and does not need another leg.

     Scanned with all five standings on screen at once, because the chip
     is the only colour this screen puts on a word — and two of the five
     are new to the shared tone map (`elapsed` in the warning family,
     `voided` in the destructive one), so this is the scan that proves
     both read against their ground in each theme. The filter row is on
     screen with them: a select and a date input beside a submit, which is
     where label association and focus order actually fail. */
  await expect(page.getByRole('heading', { name: 'Warranties' })).toBeVisible();
  for (const label of ['active', 'expiring', 'elapsed', 'closed', 'voided']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByLabel('Standing', { exact: true })).toBeVisible();
  await expect(page.getByLabel(/Runs out on or before/)).toBeVisible();
  await expectNoAxeViolations(page, 'warranty register');
});
