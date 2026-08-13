import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/* Shared browser-test scaffolding: the mocked workspace every spec signs
 * into, and the accessibility gate every spec asserts with. Kept out of
 * the spec files so the responsive suite and the accessibility suite scan
 * the same screens rather than two hand-maintained copies that drift. */

export const ORG = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sharma Constructions',
  slug: 'sharma',
};

export const SECOND_ORG = {
  id: '11111111-1111-4111-8111-222222222222',
  name: 'Patil Engineering',
  slug: 'patil',
};

export const ME = {
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

export const PICKER_ME = {
  ...ME,
  memberships: [
    ...ME.memberships,
    {
      ...ME.memberships[0]!,
      organisationId: SECOND_ORG.id,
      role: 'member',
    },
  ],
};

export const DOC_ID = '22222222-2222-4222-8222-222222222222';

/** One reviewable letter item. The review screen renders a row per item,
 * so a count is the only lever a test needs on how tall the ledger is. */
function reviewItem(schedule: string, index: number) {
  const sno = String(index + 1);
  return {
    schedule: { id: schedule },
    itemSno: sno,
    itemCode: `S${sno.padStart(2, '0')}`,
    description: 'Main switchboard, floor mounted',
    qty: '2.000',
    qtyUnit: 'Numbers',
    unitRate: '450.00',
    bidAmount: '900.00',
    needsReview: index === 0,
    raw: { anchorLine: `${sno}  S01  Main switchboard ...` },
  };
}

/** The document the review screen is opened on. `itemsPerSchedule` builds
 * a letter tall enough that its schedule heading and the ledger heading
 * beneath it are both stuck while rows scroll past — which is what the
 * sticky-occlusion guard measures. */
export function reviewDocument(itemsPerSchedule = 1, schedules = ['A']) {
  return {
    id: DOC_ID,
    originalFilename: 'loa-letter.pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 1234,
    extractionStatus: 'review',
    confirmedWorkId: null,
    createdAt: '2026-08-08T00:00:00.000Z',
    signatureStatus: 'not_checked',
    letterNumberMatches: [],
    signatureVerdict: null,
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
        items: schedules.flatMap((schedule) =>
          Array.from({ length: itemsPerSchedule }, (_unused, index) =>
            reviewItem(schedule, index),
          ),
        ),
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
}

export const REVIEW_DOCUMENT = reviewDocument();

export function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

export const DASHBOARD = {
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

export const PROFILE = {
  id: ORG.id,
  name: ORG.name,
  slug: ORG.slug,
  address: 'Plot 4, MIDC, Nashik 422010',
  gstin: '27ABCDE1234F1Z5',
  contactPhone: '+91 98220 00000',
  contactEmail: 'office@sharma.example',
  hasLogo: false,
};

/** A location master row, for the register a test wants many rows of. */
export function location(index: number) {
  const suffix = String(index + 1).padStart(3, '0');
  return {
    id: `66666666-6666-4666-8666-${suffix.padStart(12, '0')}`,
    name: `Nashik Road station platform ${suffix}`,
    kind: 'station',
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

export async function mockWorkspace(
  page: Page,
  options: {
    readonly me?: typeof ME;
    readonly organisations?: readonly (typeof ORG)[];
    readonly locations?: readonly ReturnType<typeof location>[];
    readonly document?: ReturnType<typeof reviewDocument>;
  } = {},
) {
  const me = options.me ?? ME;
  const organisations = options.organisations ?? [ORG];
  const locations = options.locations ?? [];
  const document = options.document ?? REVIEW_DOCUMENT;

  await page.route('**/api/me', (route) => route.fulfill(json(me)));
  await page.route('**/api/organisations', (route) =>
    route.fulfill(json({ organisations })),
  );
  await page.route('**/api/organisations/current/members', (route) =>
    route.fulfill(
      json({
        members: me.memberships.filter(
          (membership) => membership.organisationId === ORG.id,
        ),
      }),
    ),
  );
  await page.route('**/api/organisations/current/members/*/assignments', (route) =>
    route.fulfill(json({ userId: ME.user.id, workIds: [] })),
  );
  await page.route('**/api/approvals*', (route) =>
    route.fulfill(json({ approvals: [] })),
  );
  await page.route('**/api/masters/contacts*', (route) =>
    route.fulfill(json({ contacts: [] })),
  );
  await page.route('**/api/masters/locations*', (route) =>
    route.fulfill(json({ locations })),
  );
  await page.route('**/api/organisation/number-series', (route) =>
    route.fulfill(json({ series: [] })),
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
    route.fulfill(json({ documents: [{ ...document, extractionPayload: undefined }] })),
  );
  await page.route(`**/api/loa-documents/${DOC_ID}`, (route) =>
    route.fulfill(json(document)),
  );
  await page.route(`**/api/loa-documents/${DOC_ID}/contract-source-context`, (route) =>
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
}

/* The accessibility gate.
 *
 * It ran on axe's defaults with everything below "serious" discarded,
 * which threw away the moderate findings (heading order, landmark
 * structure, list semantics) and enabled none of the WCAG 2.2 rules —
 * axe ships its only 2.2 rule, `target-size`, disabled. The gate now
 * runs the WCAG 2.0/2.1/2.2 A and AA tag set with `target-size` turned
 * on, and asserts on every impact level.
 *
 * `runOnly` and `rules` are passed in one `options()` call because the
 * builder's `withTags` writes the same `runOnly` slot that `options`
 * replaces wholesale; two calls would silently drop one of them. */
const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
  // Kept so the tag list stays a superset of what the gate used to run:
  // axe's defaults run every enabled rule, and the best-practice set is
  // most of what carries a moderate impact.
  'best-practice',
];

/** Findings the widened gate surfaced on its first run, in files this pack
 * does not own. Frozen: an id may only be listed here with the node it was
 * measured on and the file that owns the fix, and anything not listed
 * fails the build. Delete an entry when its owner lands the fix. */
const KNOWN_VIOLATIONS: ReadonlyMap<string, string> = new Map([
  [
    'heading-order',
    'Work → Bills: `#billing-readiness-heading` in views/WorkBillingReadiness.tsx ' +
      'is an h3 whose nearest preceding heading is the page h1. Moderate, so the ' +
      'old severity filter discarded it. Owner: P13 (accessibility completion).',
  ],
]);

export async function expectNoAxeViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page })
    .options({
      runOnly: { type: 'tag', values: WCAG_TAGS },
      rules: { 'target-size': { enabled: true } },
    })
    .analyze();

  /* `target-size` ships disabled, and enabling it through the builder is
   * easy to break silently — a second `options()` call, or a `withTags()`
   * after one, overwrites the whole run configuration. So the gate proves
   * the rule ran before trusting that it found nothing: a rule that ran
   * appears in exactly one of the four result buckets. */
  const evaluated = [
    ...results.violations,
    ...results.passes,
    ...results.incomplete,
    ...results.inapplicable,
  ].map((result) => result.id);
  expect(
    evaluated,
    `${context}: the axe run did not include target-size; the gate is narrower than it claims`,
  ).toContain('target-size');

  const unexpected = results.violations.filter(
    (violation) => !KNOWN_VIOLATIONS.has(violation.id),
  );
  expect(
    unexpected.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'no impact'}, ${String(violation.nodes.length)} nodes) at ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    ),
    `${context}: unexpected axe violations`,
  ).toEqual([]);
}
