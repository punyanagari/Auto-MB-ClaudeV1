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

  await page.getByRole('button', { name: 'Works', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Works' })).toBeVisible();
  // The rail names a module's parts only while that module is open, so
  // Works shows its own and nothing else shows theirs.
  const rail = page.getByRole('navigation', { name: 'Modules' });
  await expect(rail.getByRole('button', { name: 'All Works' })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Contacts' })).toHaveCount(0);
  await expectNoAxeViolations(page, 'works list');

  // A Masters category opens from the rail, without a stop on Contacts first.
  await page.getByRole('button', { name: 'Masters' }).click();
  await rail.getByRole('button', { name: 'Locations' }).click();
  // The category strip is a navigation, not a tablist: each category is its
  // own address and Back walks between them, so the open one says
  // aria-current="page" the way the Work workspace's sections do.
  await expect(
    page
      .getByRole('navigation', { name: 'Master data categories' })
      .getByRole('button', { name: 'Locations' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(rail.getByRole('button', { name: 'All Works' })).toHaveCount(0);
  await expectNoAxeViolations(page, 'masters locations from the rail');

  await page.getByRole('button', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expectNoAxeViolations(page, 'members workspace');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByLabel('Company name')).toHaveValue('Sharma Constructions');
  await expectNoAxeViolations(page, 'settings');
});

test('LOA upload and review screens pass the axe scan', async ({ page }) => {
  await mockWorkspace(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Works', exact: true }).click();
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
  const WORK_ID = '33333333-3333-4333-8333-333333333333';
  const ITEM_ID = '55555555-5555-4555-8555-555555555555';
  const CHALLAN_ID = '44444444-4444-4444-8444-444444444444';
  const CHALLAN_ITEM_ID = '66666666-6666-4666-8666-666666666666';
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
  // other.
  await page.route('**/api/installations', (route) =>
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
  await page.getByRole('button', { name: 'Works', exact: true }).click();
  await page.getByRole('link', { name: 'DCW-1' }).click();
  await expect(
    page.getByRole('heading', { name: /DCW-1 — Supply of switchboards/ }),
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
    .getByRole('button', { name: 'Installations' })
    .click();
  // The editor is still dirty from the line above, so the shell asks
  // before it lets go.
  await page.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page.getByRole('link', { name: 'DCW-1' })).toBeVisible();
  await expect(page.getByText('Nashik Road station')).toBeVisible();
  await expectNoAxeViolations(page, 'installation register');
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
  await page.getByRole('button', { name: 'Works', exact: true }).click();
  await expect(page.getByText(/No Works yet/)).toBeVisible();

  expect(scopedHeaders.length).toBeGreaterThanOrEqual(4);
  expect(scopedHeaders.every((header) => header === ORG.id)).toBe(true);
});
