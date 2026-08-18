import { expect, test } from '@playwright/test';
import {
  DASHBOARD,
  ME,
  ORG,
  PICKER_ME,
  SECOND_ORG,
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

  /* The receivables register. Scanned twice: the table, where three status
     chips and three right-aligned money columns are on screen at once, and
     the opened bill's sheet, where the deduction waterfall puts a success
     tint on one figure and the lifecycle strip carries dots that must not
     be the only thing distinguishing a done step from a pending one. */
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
  await page.keyboard.press('Escape');

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

test('work detail and challan editor pass the axe scan', async ({ page }) => {
  /* By far the heaviest spec in the suite: twelve `expectNoAxeViolations`
     calls, each a full axe run in both themes, across the Work workspace's
     seven sections, a challan, its editor, a confirmation and two registers
     — twenty-four scans behind one test. Measured at 30.5s on the tree
     before this pack and 30.6s after it, either side of Playwright's 30s
     default, so it is budgeted rather than left to flake on whichever
     machine is a second slower. Splitting it would mean re-mounting the
     same forty-route fixture three times over, which costs more than it
     saves. */
  test.slow();
  const WORK_ID = '33333333-3333-4333-8333-333333333333';
  const ITEM_ID = '55555555-5555-4555-8555-555555555555';
  const CHALLAN_ID = '44444444-4444-4444-8444-444444444444';
  const CHALLAN_ITEM_ID = '66666666-6666-4666-8666-666666666666';
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
              },
            ],
            createdAt: '2026-08-03T00:00:00.000Z',
            cancelledAt: null,
          },
        ],
        itemSummaries: [
          { workItemId: ITEM_ID, itemNumber: 'A/1', installedQuantity: '1.000' },
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
        ],
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
  await expect(page.getByRole('button', { name: 'New installation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Serial trace' })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — installations');

  await openTab('Measurement');
  await expect(
    page.getByRole('heading', { name: 'Measurement evidence', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Measurement Books' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'DCW-1-MB-01' })).toBeVisible();
  await expect(page.getByText('FINAL BILL', { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — measurement');

  await openTab('Bills');
  await expect(page.getByRole('heading', { name: /Bill #1/ })).toBeVisible();
  await expectNoAxeViolations(page, 'work detail — bills');

  await openTab('Instruments');
  await expect(
    page.getByRole('heading', { name: 'Contract instruments' }),
  ).toBeVisible();
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
    .getByRole('link', { name: 'Invoices' })
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
