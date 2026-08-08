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

async function mockWorkspace(page: Page) {
  await page.route('**/api/me', (route) => route.fulfill(json(ME)));
  await page.route('**/api/organisations', (route) =>
    route.fulfill(json({ organisations: [ORG] })),
  );
  await page.route('**/api/organisations/current/members', (route) =>
    route.fulfill(json({ members: ME.memberships })),
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
  await expect(page.getByRole('heading', { name: 'Works' })).toBeVisible();
  await expectNoSeriousViolations(page, 'works list');

  await page.getByRole('button', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expectNoSeriousViolations(page, 'members workspace');
});

test('LOA upload and review screens pass the axe scan', async ({ page }) => {
  await mockWorkspace(page);

  await page.goto('/');
  await page.getByRole('button', { name: /Sharma Constructions/ }).click();
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

test('the workspace keeps the tenant header on every scoped request', async ({
  page,
}) => {
  const scopedHeaders: (string | undefined)[] = [];
  await page.route('**/api/me', (route) => route.fulfill(json(ME)));
  await page.route('**/api/organisations', (route) =>
    route.fulfill(json({ organisations: [ORG] })),
  );
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
  await expect(page.getByText(/No Works yet/)).toBeVisible();

  expect(scopedHeaders).toEqual([ORG.id, ORG.id]);
});
