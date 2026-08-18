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
      // The payments authority (0080). Granted here so the Payments
      // workspace renders its write controls under the axe scan — a
      // read-only register would not exercise the buttons.
      canManagePayments: true,
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
      settlement: null,
    },
    {
      kind: 'loa_review_pending',
      severity: 'notice',
      message: '1 LOA letter is waiting for review and confirmation.',
      workId: null,
      workCode: null,
      dueInDays: null,
      settlement: null,
    },
    // A bill part settled with the railway, carried here so the
    // accessibility and responsive gates scan the settlement figures
    // rather than only the alerts that predate the payment register.
    {
      kind: 'bill_part_settled',
      severity: 'warning',
      message:
        "Bill 2 for PL270-CRB is submitted and part settled against the railway's bill.",
      workId: '33333333-3333-4333-8333-333333333333',
      workCode: 'PL270-CRB',
      dueInDays: null,
      settlement: {
        reference: '100000.00',
        received: '95000.00',
        deducted: '2000.00',
        outstanding: '3000.00',
      },
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

/** The Work the dashboard fixture already names, reused by the specs that
 * need to open one of its documents. */
export const WORK_ID = '33333333-3333-4333-8333-333333333333';
export const TENDER_ID = '77777777-7777-4777-8777-777777777700';

/** One row of a Work's delivery balance — the shape the challan editor
 * draws a table row and a controlled quantity input from. `count` is the
 * only lever a test needs on how dense that editor is. */
export function workBalance(count: number) {
  return {
    allowExcessDelivery: false,
    today: '2026-08-13',
    items: Array.from({ length: count }, (_unused, index) => {
      const sno = String(index + 1);
      return {
        workItemId: `44444444-4444-4444-8444-${sno.padStart(12, '0')}`,
        itemNumber: `A-${sno.padStart(3, '0')}`,
        description: 'Main switchboard, floor mounted, with all accessories',
        unitCode: 'Numbers',
        awardedQuantity: '20.000',
        effectiveQuantity: null,
        deliveredQuantity: '4.000',
        remainingQuantity: '16.000',
        effectiveRate: '450.000000',
      };
    }),
  };
}

/** The company document library, drawn so every state the register can
 * tint is on screen at once: a credential with no expiry, one comfortably
 * valid, one inside the sixty-day window, one lapsed, one archived, and a
 * two-version history behind the renewed one. */
/** The window the fixture's own `expiryStatus` values are derived from.
 * Named once and read by `expiryStatusOf` below, so the fixture cannot
 * claim a sixty-day window in the payload while colouring its rows
 * against some other number written inline. */
const FIXTURE_EXPIRY_WARNING_DAYS = 60;

const COMPANY_DOCUMENT_LIBRARY = {
  expiryWarningDays: FIXTURE_EXPIRY_WARNING_DAYS,
  documents: [
    companyDocument('Bank solvency letter', 'financial', {
      expiresOn: '2026-08-30',
      versions: 2,
    }),
    companyDocument('GST registration certificate', 'statutory', {
      expiresOn: null,
    }),
    companyDocument('ISO 9001 certificate', 'certification', {
      expiresOn: '2028-01-31',
    }),
    companyDocument('Labour licence', 'statutory', {
      expiresOn: '2026-07-01',
    }),
    companyDocument('Partnership deed', 'company', {
      expiresOn: null,
      archived: true,
    }),
  ],
};

function companyDocument(
  title: string,
  category: string,
  options: {
    readonly expiresOn: string | null;
    readonly versions?: number;
    readonly archived?: boolean;
  },
) {
  const count = options.versions ?? 1;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: `55555555-5555-4555-8555-${slug.slice(0, 12).padEnd(12, '0')}`,
    title,
    category,
    versions: Array.from({ length: count }, (_unused, index) => {
      const versionNumber = count - index;
      return {
        id: `66666666-6666-4666-8666-${slug.slice(0, 10).padEnd(10, '0')}${String(versionNumber).padStart(2, '0')}`,
        versionNumber,
        originalFilename: `${slug}-v${String(versionNumber)}.pdf`,
        sha256: 'a'.repeat(64),
        sizeBytes: 24_576,
        validFrom: null,
        expiresOn: versionNumber === count ? options.expiresOn : '2025-08-30',
        uploadedByUserId: 'user-owner',
        createdAt: '2026-08-01T09:00:00.000Z',
      };
    }),
    // The server derives these; the fixture states them the way a server
    // whose current date is 2026-08-13 would.
    expiryStatus: expiryStatusOf(options.expiresOn),
    expiresInDays: options.expiresOn === null ? null : daysUntil(options.expiresOn),
    archivedAt: options.archived === true ? '2026-08-05T09:00:00.000Z' : null,
    createdAt: '2026-08-01T09:00:00.000Z',
  };
}

/** The reading the server's SQL would produce, against the same fixed
 * date the rest of these fixtures use and the same window the payload
 * above declares. */
function expiryStatusOf(expiresOn: string | null): string {
  if (expiresOn === null) return 'none';
  const days = daysUntil(expiresOn);
  if (days < 0) return 'expired';
  return days <= FIXTURE_EXPIRY_WARNING_DAYS ? 'expiring' : 'valid';
}

function daysUntil(expiresOn: string): number {
  const today = Date.parse('2026-08-13T00:00:00.000Z');
  return Math.round((Date.parse(`${expiresOn}T00:00:00.000Z`) - today) / 86_400_000);
}

/** A closing moment `days` from now, as the pair the register reads: the
 * instant it splits Upcoming from Expired on, and the wall clock it
 * prints. Relative, because the register now compares the instant to the
 * real clock — a hard-coded 2026 date drifts into the wrong tab the week
 * it passes, and the scan would then be measuring the empty state. */
function closingIn(days: number): {
  bidClosesAt: string;
  bidClosesAtLocal: string;
  daysToClose: number;
} {
  const at = new Date(Date.now() + days * 86_400_000);
  return {
    bidClosesAt: at.toISOString(),
    bidClosesAtLocal: `${at.toISOString().slice(0, 10)}T15:00`,
    daysToClose: days,
  };
}

/**
 * The receivables register, with one bill in each state the screen draws
 * differently.
 *
 * The scan needs all three status chips on screen at once, and it needs
 * both halves of the sheet's branch: a bill the railway has passed, which
 * draws the deduction waterfall, and one it has not, which draws the
 * sentence instead. The paid row carries two heads so the waterfall has
 * more than one deduction line in it.
 */
const RECEIVABLES_REGISTER = {
  entries: [
    {
      billId: '88888888-8888-4888-8888-888888888801',
      workId: WORK_ID,
      billNumber: 8,
      status: 'paid',
      preparedAmount: '374056.20',
      measurementBookId: '88888888-8888-4888-8888-8888888888a1',
      measurementBookNumber: 'MB-08',
      measurementClosedAt: '2026-08-11T06:00:00.000Z',
      receivedRailwayBillId: '88888888-8888-4888-8888-8888888888b1',
      railwayBillNumber: 'WR/OAM/FL2/08',
      railwayBillDate: '2026-08-11',
      railwayBillAmount: '374056.20',
      receivedTotal: '354536.39',
      deductionTotal: '19519.81',
      outstandingAmount: '0.00',
      payments: [
        {
          id: '88888888-8888-4888-8888-8888888888c1',
          billId: '88888888-8888-4888-8888-888888888801',
          receivedOn: '2026-08-14',
          receivedAmount: '354536.39',
          reference: 'WR-PAY-809144',
          remarks: null,
          deductions: [
            {
              id: '88888888-8888-4888-8888-8888888888d1',
              category: 'SECURITY_DEPOSIT',
              amount: '16349.81',
              description: null,
            },
            {
              id: '88888888-8888-4888-8888-8888888888d2',
              category: 'BOCW_CESS',
              amount: '3170.00',
              description: null,
            },
          ],
          deductionTotal: '19519.81',
          grossAmount: '374056.20',
          voidedAt: null,
          voidReason: null,
          createdAt: '2026-08-14T09:00:00.000Z',
        },
      ],
      workCode: 'PL-281',
      workTitle: 'Passenger information systems, Mumbai division',
      submittedAt: '2026-08-05T05:30:00.000Z',
      financialYear: '2026-27',
      netPayableAmount: '354536.39',
      deductionsByHead: [
        { category: 'SECURITY_DEPOSIT', amount: '16349.81' },
        { category: 'BOCW_CESS', amount: '3170.00' },
      ],
    },
    {
      billId: '88888888-8888-4888-8888-888888888802',
      workId: WORK_ID,
      billNumber: 7,
      status: 'submitted',
      preparedAmount: '818400.00',
      measurementBookId: '88888888-8888-4888-8888-8888888888a2',
      measurementBookNumber: 'MB-07',
      measurementClosedAt: null,
      receivedRailwayBillId: null,
      railwayBillNumber: null,
      railwayBillDate: null,
      railwayBillAmount: null,
      receivedTotal: '0.00',
      deductionTotal: '0.00',
      outstandingAmount: null,
      payments: [],
      workCode: 'PL-281',
      workTitle: 'Passenger information systems, Mumbai division',
      submittedAt: '2026-08-12T05:30:00.000Z',
      financialYear: null,
      netPayableAmount: null,
      deductionsByHead: [],
    },
    {
      billId: '88888888-8888-4888-8888-888888888803',
      workId: WORK_ID,
      billNumber: 6,
      status: 'prepared',
      preparedAmount: '642800.00',
      measurementBookId: '88888888-8888-4888-8888-8888888888a3',
      measurementBookNumber: 'MB-06',
      measurementClosedAt: null,
      receivedRailwayBillId: null,
      railwayBillNumber: null,
      railwayBillDate: null,
      railwayBillAmount: null,
      receivedTotal: '0.00',
      deductionTotal: '0.00',
      outstandingAmount: null,
      payments: [],
      workCode: 'PL-281',
      workTitle: 'Passenger information systems, Mumbai division',
      submittedAt: null,
      financialYear: null,
      netPayableAmount: null,
      deductionsByHead: [],
    },
  ],
  summary: {
    claimedTotal: '1835256.20',
    passedTotal: '374056.20',
    receivedTotal: '354536.39',
    outstandingTotal: '0.00',
  },
};

/** One tender in each of the three states the register tints, so a scan
 * sees the whole status vocabulary at once: an open bid with blocking
 * lines, one already submitted, and one that was won. */
/* OEM production (migration 0084).
 *
 * The job card carries every tint this module puts on a word, because
 * the axe scan is the only place they are checked together in both
 * themes: the `in-production` chip, the neutral Material badge, the
 * progress bar, the success "Dispatch ready" badge, and — on the Serials
 * tab — the destructive/success component count, which is the one figure
 * here that is colour-coded at all.
 */
const PRODUCTION_JOB_CARD_ID = '9f2c1b7a-4e58-4d31-9b2a-7c1e5d8a3046';
const PRODUCTION_ITEM_ID = '2a7e9c14-6b83-4f52-9d07-1e4b8a6c2f35';
const PRODUCTION_COMPONENT_ID = 'b41d7f60-38a2-4c19-85e7-90f3c2d6a1b8';
const PRODUCTION_SERIAL_ID = 'c58e2a91-7d43-4b60-9f18-25a7e3c40b6d';

const PRODUCTION_JOB_CARD = {
  id: PRODUCTION_JOB_CARD_ID,
  number: 'PP-26-081',
  sourceType: 'work',
  sourceReference: 'WR-MMCT-SnT-STTD-34-2025 · A2/1',
  workId: null,
  workCode: 'PL270-CRB',
  customer: null,
  itemId: PRODUCTION_ITEM_ID,
  itemCode: 'PEB-IPDB-6L',
  itemName: 'IP Display Board · 6 line',
  quantity: 12,
  manufactured: 5,
  dispatched: 2,
  materialLines: 2,
  status: 'in_production',
  dueDate: '2026-11-30',
  completedOn: null,
  cancellationReason: null,
  materials: [
    {
      itemId: PRODUCTION_COMPONENT_ID,
      itemCode: 'SMPS-24-10',
      name: '24 V 10 A SMPS',
      unit: 'Nos',
      required: '12.000',
      serialControlled: true,
    },
    {
      itemId: '7e3a1c85-92d6-4b07-8f41-6c2b5d9e30a7',
      itemCode: 'CAB-PC-6L',
      name: 'Powder-coated cabinet',
      unit: 'Nos',
      required: '12.000',
      serialControlled: false,
    },
  ],
  serials: [
    {
      id: PRODUCTION_SERIAL_ID,
      serialNumber: 'IPDB6-00129',
      dispatchedOn: null,
      components: [],
      createdAt: '2026-08-14T06:20:00.000Z',
    },
    {
      id: 'd6b3f847-1a92-4e50-b7c8-34f9a2e615c0',
      serialNumber: 'IPDB6-00130',
      dispatchedOn: '2026-08-16',
      components: [
        {
          id: 'e17c4b93-5d28-4a61-9f30-8b6d2a4e70f1',
          componentItemId: PRODUCTION_COMPONENT_ID,
          componentItemCode: 'SMPS-24-10',
          componentName: '24 V 10 A SMPS',
          serialNumber: 'SMPS-2026-88214',
        },
      ],
      createdAt: '2026-08-13T06:20:00.000Z',
    },
  ],
  componentSlots: [
    {
      componentItemId: PRODUCTION_COMPONENT_ID,
      componentItemCode: 'SMPS-24-10',
      name: '24 V 10 A SMPS',
      required: 1,
      captured: 0,
    },
  ],
  dispatches: [
    {
      id: 'f92a6d15-8c37-4be0-a541-7d3e9b2c60f4',
      number: 'PP-26-081/D1',
      dispatchedOn: '2026-08-16',
      remarks: null,
      serialNumbers: ['IPDB6-00130'],
      createdAt: '2026-08-16T09:00:00.000Z',
    },
  ],
  dispatchReady: false,
};

const PRODUCTION_JOB_CARD_LIST = {
  jobCards: [
    {
      id: PRODUCTION_JOB_CARD.id,
      number: PRODUCTION_JOB_CARD.number,
      sourceType: PRODUCTION_JOB_CARD.sourceType,
      sourceReference: PRODUCTION_JOB_CARD.sourceReference,
      workId: PRODUCTION_JOB_CARD.workId,
      workCode: PRODUCTION_JOB_CARD.workCode,
      customer: PRODUCTION_JOB_CARD.customer,
      itemId: PRODUCTION_JOB_CARD.itemId,
      itemCode: PRODUCTION_JOB_CARD.itemCode,
      itemName: PRODUCTION_JOB_CARD.itemName,
      quantity: PRODUCTION_JOB_CARD.quantity,
      manufactured: PRODUCTION_JOB_CARD.manufactured,
      dispatched: PRODUCTION_JOB_CARD.dispatched,
      materialLines: PRODUCTION_JOB_CARD.materialLines,
      status: PRODUCTION_JOB_CARD.status,
      dueDate: PRODUCTION_JOB_CARD.dueDate,
      completedOn: null,
      cancellationReason: null,
    },
  ],
  nextCursor: null,
  openCount: 3,
  inProductionCount: 1,
  dispatchReadyCount: 1,
};

const PRODUCTION_ITEMS = {
  items: [
    {
      id: PRODUCTION_ITEM_ID,
      itemCode: 'PEB-IPDB-6L',
      name: 'IP Display Board · 6 line',
      category: 'Display boards',
      unit: 'Nos',
      manufactured: true,
      serialPrefix: 'IPDB6',
      serialControlled: true,
      specifications: [{ attribute: 'Display size', value: '1200 × 600 mm' }],
      active: true,
      createdAt: '2026-08-01T00:00:00.000Z',
    },
    {
      id: PRODUCTION_COMPONENT_ID,
      itemCode: 'SMPS-24-10',
      name: '24 V 10 A SMPS',
      category: 'Power supplies',
      unit: 'Nos',
      manufactured: false,
      serialPrefix: null,
      serialControlled: true,
      specifications: [],
      active: true,
      createdAt: '2026-08-01T00:00:00.000Z',
    },
  ],
};

const PRODUCTION_BOM = {
  nodes: [
    {
      lineId: 'a3f8c250-6d19-4b74-8e02-5c7a1f9b3d48',
      parentLineId: null,
      depth: 0,
      itemId: PRODUCTION_COMPONENT_ID,
      itemCode: 'SMPS-24-10',
      name: '24 V 10 A SMPS',
      unit: 'Nos',
      quantity: '1.000',
      effectiveQuantity: '1.000',
      serialControlled: true,
      hasChildren: false,
    },
  ],
};

const TENDER_LIST = {
  tenders: [
    {
      id: TENDER_ID,
      tenderNumber: 'WR-MMCT-S&T-34/2026',
      authority: 'Western Railway',
      title: 'Supply and commissioning of passenger information systems',
      ...closingIn(36),
      status: 'drafted',
      checklistTotal: 3,
      checklistBlocking: 1,
    },
    {
      id: '77777777-7777-4777-8777-777777777701',
      tenderNumber: 'CR/2026/EL/118',
      authority: 'Central Railway',
      title: 'Signalling cable renewal at four block sections',
      ...closingIn(2),
      status: 'submitted',
      checklistTotal: 2,
      checklistBlocking: 0,
    },
    {
      id: '77777777-7777-4777-8777-777777777702',
      tenderNumber: 'WCR/2026/TRD/7',
      authority: 'West Central Railway',
      title: 'Overhead equipment spares',
      ...closingIn(-72),
      status: 'awarded',
      checklistTotal: 2,
      checklistBlocking: 0,
    },
  ],
};

/** The opened tender, drawn so every validity reading the checklist can
 * tint is on screen at once — no expiry, valid at close, lapsing soon
 * after, expired by close — because those four are the only place this
 * screen puts colour on a word. */
const TENDER_DETAIL = {
  ...TENDER_LIST.tenders[0],
  checklistTotal: 4,
  checklistBlocking: 1,
  estimatedValue: '84000000.00',
  emdAmount: '1680000.00',
  eligibilitySummary: 'Similar railway S&T works of 35% value in three years.',
  irepsReference: null,
  noticeId: '88888888-8888-4888-8888-888888888801',
  noticeFilename: 'wr-mmct-st-34-2026-nit.pdf',
  award: null,
  checklist: [
    checklistLine('PAN card', 'PAN card', 'none', null, null),
    checklistLine(
      'ISO 9001 certificate',
      'ISO 9001 certificate',
      'valid',
      '2028-01-31',
      500,
    ),
    checklistLine(
      'Bank solvency letter',
      'Bank solvency letter',
      'expiring',
      '2026-10-30',
      42,
    ),
    checklistLine('Labour licence', 'Labour licence', 'expired', '2026-07-01', -79),
  ],
  statusEvents: [
    {
      id: '99999999-9999-4999-8999-999999999901',
      fromStatus: null,
      toStatus: 'drafted',
      note: 'Created from the tender notice.',
      actorUserId: 'user-owner',
      occurredAt: '2026-08-01T09:00:00.000Z',
    },
  ],
};

function checklistLine(
  title: string,
  documentTitle: string | null,
  validity: string | null,
  expiresOn: string | null,
  expiresInDaysAtClose: number | null,
) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${slug.slice(0, 12).padEnd(12, '0')}`,
    title,
    mandatory: true,
    companyDocumentId:
      documentTitle === null
        ? null
        : `bbbbbbbb-bbbb-4bbb-8bbb-${slug.slice(0, 12).padEnd(12, '0')}`,
    companyDocumentTitle: documentTitle,
    restricted: false,
    companyDocumentArchived: false,
    companyDocumentVersionNumber: documentTitle === null ? null : 2,
    expiresOn,
    validity,
    expiresInDaysAtClose,
    blocking: validity === 'expired',
    createdAt: '2026-08-01T09:00:00.000Z',
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
  /* The company document library, with one credential in each of the
     three validity readings that carry a tint — valid, expiring and
     expired — plus a two-version history. The axe scan needs all three
     chips on screen at once, in both themes, because they are the only
     place this screen puts colour on a word. */
  await page.route('**/api/company-documents', (route) =>
    route.fulfill(json(COMPANY_DOCUMENT_LIBRARY)),
  );
  /* The organisation-wide receivables register. The per-Work settlement
     read is a different path (`/api/works/<id>/bill-settlement`) and this
     pattern cannot swallow it: `**` has to end at `/api/bill-settlement`,
     which a Work-scoped URL does not. */
  await page.route('**/api/bill-settlement', (route) =>
    route.fulfill(json(RECEIVABLES_REGISTER)),
  );
  // The tender pipeline (migration 0083). The detail route is registered
  // first because Playwright matches the LAST registered handler, so the
  // bare-register pattern would otherwise swallow the one with an id.
  await page.route('**/api/tenders/*', (route) => route.fulfill(json(TENDER_DETAIL)));
  await page.route('**/api/tenders', (route) => route.fulfill(json(TENDER_LIST)));
  // OEM production (migration 0084). The detail routes are registered
  // BEFORE the bare registers, because Playwright matches the last
  // registered handler and a bare pattern would otherwise swallow the
  // one carrying an id.
  await page.route('**/api/production/items/*/bom', (route) =>
    route.fulfill(json(PRODUCTION_BOM)),
  );
  await page.route('**/api/production/items*', (route) =>
    route.fulfill(json(PRODUCTION_ITEMS)),
  );
  await page.route('**/api/production/job-cards/*', (route) =>
    route.fulfill(json(PRODUCTION_JOB_CARD)),
  );
  await page.route('**/api/production/job-cards*', (route) =>
    route.fulfill(json(PRODUCTION_JOB_CARD_LIST)),
  );
  await page.route('**/api/masters/contacts*', (route) =>
    route.fulfill(json({ contacts: [] })),
  );
  await page.route('**/api/masters/locations*', (route) =>
    route.fulfill(json({ locations })),
  );
  // Populated rather than empty (migration 0078): an empty Items tab
  // renders the EmptyMaster sentence and its open form, which is a
  // different set of nodes from the table the axe scan is there to check.
  await page.route('**/api/masters/canonical-items*', (route) =>
    route.fulfill(
      json({
        items: [
          {
            id: '5c0a4f2e-1d3b-4a6c-8e91-6f2b9c7d4e10',
            name: 'Outdoor horn speaker 30W',
            groupName: 'Audio',
            make: 'Ahuja',
            model: 'UHC-30 XT',
            defaultUnit: 'Nos',
            aliases: ['horn speaker', '30 watt speaker'],
            mappedLineCount: 7,
            active: true,
            createdAt: '2026-08-08T00:00:00.000Z',
          },
        ],
        unmappedLineCount: 4,
      }),
    ),
  );
  await page.route('**/api/organisation/bank-accounts*', (route) =>
    route.fulfill(
      json({
        accounts: [
          {
            id: '9b1e7c34-8a52-4d0f-b6c7-2e5a1f8d3049',
            accountHolder: 'Sharma Constructions',
            bankName: 'HDFC Bank',
            accountNumberLast4: '8842',
            ifsc: 'HDFC0000182',
            branch: 'Andheri East',
            active: true,
            createdAt: '2026-08-08T00:00:00.000Z',
          },
        ],
      }),
    ),
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

/** Findings the widened gate surfaced on its first run, in files the pack
 * that widened it did not own. Frozen: an id may only be listed here with
 * the node it was measured on and the file that owns the fix, and anything
 * not listed fails the build. Delete an entry when its owner lands the fix.
 *
 * It is empty, and the intent is that it stays empty. Its one entry was
 * `heading-order` at `#billing-readiness-heading`, an h3 whose nearest
 * preceding heading was the page h1; `views/WorkBillingReadiness.tsx` now
 * carries an h2, which is the level the section actually sits at beside
 * `WorkBills`'s own "Bills". Adding an entry back means shipping a known
 * WCAG failure, so the entry has to name an owner who will remove it. */
const KNOWN_VIOLATIONS: ReadonlyMap<string, string> = new Map<string, string>();

/* Both themes, on every screen the gate is pointed at.
 *
 * docs/UX.md § Visual system asks that text/tint pairings hold WCAG AA
 * 4.5:1 "in both themes", and names the live axe/contrast gate as the
 * proof. Until this, no browser test ever set a theme, so the dark half
 * of that promise was asserted by nobody. The gate now runs each scan
 * twice rather than each test twice: one call site, two passes, and the
 * spec files stay a list of screens.
 *
 * The theme is applied the way the product applies it — `data-theme` on
 * <html>, which is what `lib/theme.ts` writes and what pins
 * `color-scheme` over the `prefers-color-scheme` media query. Emulating
 * the media query instead would resolve the same token values, but only
 * the attribute is a path an operator can actually reach (the Appearance
 * card under Settings). */
const THEMES = ['light', 'dark'] as const;

/* Colour transitions are the reason this needs care rather than two
 * lines. The shared Button carries `transition-all` and the rail items
 * carry `transition-colors`, both 150ms, so for six frames after a theme
 * flip the page is showing interpolations between the two palettes:
 * ink on its way from oklch(0.99 0.004 190) to oklch(0.19 0.02 195) over
 * a fill on its way from oklch(0.42 0.09 190) to oklch(0.72 0.09 190),
 * the light and dark --primary pair. Those in-between pairs belong to
 * neither theme and are not what the contract is about, but axe will
 * happily measure them and report a serious violation with a colour pair
 * that appears nowhere in globals.css — which is exactly the disputed
 * finding this branch settled. Freezing transitions for the duration of
 * the scan makes the gate measure the resting palette, deterministically,
 * instead of racing a 150ms animation. */
const FREEZE_STYLE_ID = 'axe-gate-frozen-transitions';

async function freezeTransitions(page: Page) {
  await page.evaluate((id) => {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `*, *::before, *::after {
      transition: none !important;
      animation: none !important;
    }`;
    document.head.append(style);
  }, FREEZE_STYLE_ID);
}

async function thawTransitions(page: Page) {
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, FREEZE_STYLE_ID);
}

/** Applies a theme and reports the ground colour it resolved to, so the
 * caller can prove the two passes were actually two different palettes. */
async function applyTheme(page: Page, theme: (typeof THEMES)[number] | null) {
  return page.evaluate((value) => {
    const root = document.documentElement;
    if (value === null) {
      delete root.dataset['theme'];
    } else {
      root.dataset['theme'] = value;
    }
    const style = getComputedStyle(root);
    return {
      colorScheme: style.colorScheme,
      background: style.getPropertyValue('--background').trim(),
    };
  }, theme);
}

async function analyze(page: Page, context: string) {
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
        `${violation.id} (${violation.impact ?? 'no impact'}, ${String(violation.nodes.length)} nodes) at ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}${
          violation.id === 'color-contrast'
            ? ` [${violation.nodes
                .map((node) =>
                  node.any
                    .map((check) => {
                      const data = check.data as
                        | { fgColor?: string; bgColor?: string; contrastRatio?: number }
                        | undefined;
                      return `${data?.fgColor ?? '?'} on ${data?.bgColor ?? '?'} = ${String(data?.contrastRatio ?? '?')}`;
                    })
                    .join('; '),
                )
                .join(' | ')}]`
            : ''
        }`,
    ),
    `${context}: unexpected axe violations`,
  ).toEqual([]);
}

export async function expectNoAxeViolations(page: Page, context: string) {
  const original = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  await freezeTransitions(page);
  const grounds = new Set<string>();
  try {
    for (const theme of THEMES) {
      const resolved = await applyTheme(page, theme);
      expect(
        resolved.colorScheme,
        `${context}: the ${theme} pass did not pin color-scheme`,
      ).toBe(theme);
      grounds.add(resolved.background);
      await analyze(page, `${context} — ${theme} theme`);
    }
    /* A gate that flipped an attribute nothing reads would pass twice on
     * one palette and claim to have proved two. The ground colour has to
     * differ between the passes for the dark scan to mean anything. */
    expect(
      [...grounds],
      `${context}: both theme passes resolved the same --background; the dark scan proved nothing`,
    ).toHaveLength(THEMES.length);
  } finally {
    await applyTheme(
      page,
      original === 'light' || original === 'dark' ? original : null,
    );
    await thawTransitions(page);
  }
}
