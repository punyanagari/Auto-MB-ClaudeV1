import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ORG = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sharma Constructions',
  slug: 'sharma',
};

const ME = {
  user: { id: 'user-a', email: 'owner@example.test' },
  memberships: [
    {
      organisationId: ORG.id,
      userId: 'user-a',
      role: 'owner',
      workScope: 'all',
      canIssueDocuments: true,
      canCancelDocuments: true,
      status: 'active',
    },
  ],
};

const DOC_ID = '22222222-2222-4222-8222-222222222222';

const REVIEW_DOCUMENT = {
  id: DOC_ID,
  originalFilename: 'loa-letter.pdf',
  sha256: 'a'.repeat(64),
  sizeBytes: 1234,
  extractionStatus: 'review',
  confirmedWorkId: null,
  createdAt: '2026-08-08T00:00:00.000Z',
  extractionPayload: {
    sourceText: 'RAW LETTER TEXT',
    review: {
      header: {
        letterNumber: {
          value: 'L-42/2025',
          raw: 'Letter No: L-42/2025',
          needsReview: false,
        },
        letterDate: {
          value: '2025-06-01',
          raw: 'Dated: 01/06/2025',
          needsReview: false,
        },
        workDescription: {
          value: 'Supply and installation of switchboards',
          raw: 'Name of work: Supply and installation of switchboards',
          needsReview: false,
        },
      },
      pricingShape: {
        advertised_value: 1000,
        contract_value: 900,
        pricing_shape: 'letter_percentage',
        letter_percentage: 10,
        letter_percentage_direction: 'below',
        needsReview: false,
      },
      items: [
        {
          schedule: { id: 'A' },
          itemSno: '1',
          itemCode: 'S01',
          description: 'Main switchboard, floor mounted',
          qty: '2.000',
          qtyUnit: 'Numbers',
          unitRate: '450.00',
          bidAmount: '900.00',
          needsReview: true,
          raw: { anchorLine: '1  S01  Main switchboard ...' },
        },
      ],
      flags: [
        {
          code: 'unresolved_units',
          scope: 'item',
          targetId: 'A#1',
          message: 'The printed unit could not be resolved.',
          rawBlock: 'Route Kilo Meter (RKM)',
        },
      ],
      needsReview: { total: 1, anyLetterLevel: false },
    },
  },
};

async function expectNoSeriousViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    serious,
    `${context}: ${serious.map((violation) => violation.id).join(', ')}`,
  ).toEqual([]);
}

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

const DASHBOARD = {
  totals: {
    works: 1,
    contractValue: '4520000.00',
    deliveredValue: '1450000.00',
    billedValue: '300.00',
    openDrafts: 1,
    loaAwaitingReview: 1,
  },
  alerts: [
    {
      kind: 'instrument_expiring',
      severity: 'warning',
      message: 'PBG BG/22 for PL270-CRB expires on 2026-09-15.',
      workId: '33333333-3333-4333-8333-333333333333',
      workCode: 'PL270-CRB',
      dueInDays: 38,
    },
    {
      kind: 'loa_review_pending',
      severity: 'notice',
      message: '1 LOA letter is waiting for review and confirmation.',
      workId: null,
      workCode: null,
      dueInDays: null,
    },
  ],
  works: [
    {
      workId: '33333333-3333-4333-8333-333333333333',
      workCode: 'PL270-CRB',
      title: 'Signalling gear, CR Bhusawal',
      status: 'active',
      contractValue: '4520000.00',
      deliveredValue: '1450000.00',
      billedValue: '300.00',
      issuedChallans: 3,
    },
  ],
};

const PROFILE = {
  id: ORG.id,
  name: ORG.name,
  slug: ORG.slug,
  address: 'Plot 4, MIDC, Nashik 422010',
  gstin: '27ABCDE1234F1Z5',
  contactPhone: '+91 98220 00000',
  contactEmail: 'office@sharma.example',
  hasLogo: false,
};

async function mockWorkspace(page: Page) {
  await page.route('**/api/me', (route) => route.fulfill(json(ME)));
  await page.route('**/api/organisations', (route) =>
    route.fulfill(json({ organisations: [ORG] })),
  );
  await page.route('**/api/organisations/current/members', (route) =>
    route.fulfill(json({ members: ME.memberships })),
  );
  await page.route('**/api/dashboard', (route) => route.fulfill(json(DASHBOARD)));
  await page.route('**/api/organisation/profile', (route) =>
    route.fulfill(json(PROFILE)),
  );
  await page.route('**/api/organisation/logo', (route) =>
    route.fulfill(json({ code: 'NO_LOGO', message: 'No logo.', requestId: 'r' }, 404)),
  );
  await page.route('**/api/works', (route) => route.fulfill(json({ works: [] })));
  await page.route('**/api/loa-documents', (route) =>
    route.fulfill(
      json({ documents: [{ ...REVIEW_DOCUMENT, extractionPayload: undefined }] }),
    ),
  );
  await page.route(`**/api/loa-documents/${DOC_ID}`, (route) =>
    route.fulfill(json(REVIEW_DOCUMENT)),
  );
}

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
  await expectNoSeriousViolations(page, 'sign-in');
});

test('organisation picker and members workspace pass the axe scan', async ({
  page,
}) => {
  await mockWorkspace(page);

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Select an organisation' }),
  ).toBeVisible();
  await expectNoSeriousViolations(page, 'organisation picker');

  await page.getByRole('button', { name: /Sharma Constructions/ }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(/PBG BG\/22 for PL270-CRB expires/)).toBeVisible();
  await expectNoSeriousViolations(page, 'dashboard');

  await page.getByRole('button', { name: 'Works', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Works' })).toBeVisible();
  await expectNoSeriousViolations(page, 'works list');

  await page.getByRole('button', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expectNoSeriousViolations(page, 'members workspace');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByLabel('Company name')).toHaveValue('Sharma Constructions');
  await expectNoSeriousViolations(page, 'settings');
});

test('LOA upload and review screens pass the axe scan', async ({ page }) => {
  await mockWorkspace(page);

  await page.goto('/');
  await page.getByRole('button', { name: /Sharma Constructions/ }).click();
  await page.getByRole('button', { name: 'Works', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Works' })).toBeVisible();

  await page.getByRole('button', { name: 'Upload LOA' }).click();
  await expect(
    page.getByRole('heading', { name: 'Upload Letter of Acceptance' }),
  ).toBeVisible();
  await expectNoSeriousViolations(page, 'upload');

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(
    page.getByRole('heading', { name: /Review loa-letter\.pdf/ }),
  ).toBeVisible();
  await expect(page.getByLabel('Letter number')).toHaveValue('L-42/2025');
  await expect(page.getByText('The printed unit could not be resolved.')).toBeVisible();
  await expectNoSeriousViolations(page, 'review');
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
              },
            ],
          },
        ],
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

  await page.goto('/');
  await page.getByRole('button', { name: /Sharma Constructions/ }).click();
  await page.getByRole('button', { name: 'Works', exact: true }).click();
  await page.getByRole('button', { name: 'DCW-1' }).click();
  await expect(
    page.getByRole('heading', { name: /DCW-1 — Supply of switchboards/ }),
  ).toBeVisible();
  // The retention sections load with the Work.
  await expect(
    page.getByRole('heading', { name: 'Contract instruments' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Measurement Book' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Bill #1/ })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Installations', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Record installation' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Serial trace' })).toBeVisible();
  // Milestone 8: the payment matrix editor with its R10 note.
  await expect(page.getByRole('heading', { name: 'Payment matrix' })).toBeVisible();
  await expect(page.getByLabel('Supply % for Supply')).toHaveValue('80.00');
  await expect(page.getByLabel('Payment category for A/1')).toBeVisible();
  // Milestone 8 phase 3: the Measurement Book workspace with its list.
  await expect(page.getByRole('heading', { name: 'Measurement Books' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'DCW-1-MB-01' })).toBeVisible();
  await expect(page.getByText('FINAL BILL')).toBeVisible();
  await expectNoSeriousViolations(page, 'work detail');

  await page.getByRole('button', { name: 'DC/1' }).click();
  await expect(
    page.getByRole('heading', { name: 'Delivery Challan DC/1' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery receipt' })).toBeVisible();
  await expect(page.getByLabel('Serial numbers (one per line)')).toBeVisible();
  await expect(page.getByLabel('Installed on')).toBeVisible();
  // The correction flow states the lawful path for an evidence-carrying
  // challan and offers the notice form.
  await expect(page.getByRole('heading', { name: 'Request correction' })).toBeVisible();
  await expect(page.getByLabel('Correction statement')).toBeVisible();
  await expectNoSeriousViolations(page, 'challan detail with evidence');

  await page.getByRole('button', { name: 'Back to Work' }).click();
  await page.getByRole('button', { name: 'New Delivery Challan' }).click();
  await expect(
    page.getByRole('heading', { name: 'New Delivery Challan' }),
  ).toBeVisible();
  await expect(page.getByLabel('Quantity of A/1 on this challan')).toBeVisible();
  await expectNoSeriousViolations(page, 'challan editor');
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

  await page.goto('/');
  await page.getByRole('button', { name: /Sharma Constructions/ }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Works', exact: true }).click();
  await expect(page.getByText(/No Works yet/)).toBeVisible();

  expect(scopedHeaders).toEqual([ORG.id, ORG.id, ORG.id]);
});
