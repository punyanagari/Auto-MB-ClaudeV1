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
      // The payroll authority (0089), distinct from payments: without it
      // the rail carries no Employees door and both payroll screens
      // refuse. The owner of a new organisation holds it implicitly.
      canManagePayroll: true,
      canManageEntitlements: true,
      canExportOrg: true,
      // The audit authority (0095). Granted so the audit register renders
      // its rows and its filters under the scan; without it the screen is
      // one refusal paragraph, which is a different set of nodes.
      canViewAuditTrail: true,
      // The notifications authority (0092). Without it the Notifications
      // screen mounts its refusal panel instead of its four registers,
      // and the axe scan would be scanning two paragraphs in a card.
      canManageNotifications: true,
      // The import authority (0094). Granted so the Imports screen draws
      // its upload panel and its write button under the scan — without
      // it the screen is a read-only history and the controls whose
      // contrast matters are never rendered.
      canImportData: true,
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
/* The correspondence register (migration 0086). One row in each of the
   four statuses that carry a tint — sent, received, replied and cancelled
   — because those chips are the only place this screen puts colour on a
   word, and the dot beside the label is what keeps them off the
   colour-only path in both themes. */
function letter(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111101',
    source: 'letter',
    direction: 'outward',
    number: 'OUT/26-27/047',
    date: '2026-07-22',
    counterparty: 'Sr. DSTE/MMCT',
    subject: 'Submission of approved makes and technical datasheets',
    workId: null,
    workCode: 'PL-281',
    reference: null,
    status: 'sent',
    extensionUntil: null,
    replyDueOn: null,
    ...overrides,
  };
}

const CORRESPONDENCE_REGISTER = {
  entries: [
    letter({}),
    letter({
      id: '11111111-1111-4111-8111-111111111102',
      number: 'OUT/26-27/046',
      status: 'replied',
      reference: 'IN/26-27/018',
      subject: 'Reply to clarification on UPS battery autonomy',
    }),
    letter({
      id: '11111111-1111-4111-8111-111111111103',
      number: 'IN/26-27/018',
      direction: 'inward',
      status: 'received',
      workCode: null,
      reference: 'S&T/PA/Approval/118 · 2026-07-18',
      subject: 'Approval of IP speaker make and model',
      replyDueOn: '2026-08-18',
    }),
    letter({
      id: '11111111-1111-4111-8111-111111111104',
      number: 'OUT/26-27/045',
      status: 'cancelled',
      subject: 'Letter filed against the wrong Work',
    }),
  ],
  nextCursor: null,
  counts: { outward: 3, inward: 1, extensions: 2, inspection: 2 },
  awaitingExtensionResponses: 2,
};

/* OEM production (migration 0084), with the material position the stock
 * ledger of 0087 makes real.
 *
 * The job card carries every tint this module puts on a word, because
 * the axe scan is the only place they are checked together in both
 * themes: the `in-production` chip, the WARNING "1 part short" Material
 * badge, the progress bar, the success "Dispatch ready" badge, and — on
 * the Serials tab — the destructive/success component count.
 *
 * `materialShortParts` is 1 on purpose. A fixture with nothing short
 * would render the neutral "Ready" badge and the warning tint — the one
 * this pack adds — would never be scanned in either theme. The two
 * material rows below carry the two readings the tab has to hold: one
 * part short, and one covered by the shelf.
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
  materialShortParts: 1,
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
      available: '4.000',
      shortage: '8.000',
      serialControlled: true,
    },
    {
      itemId: '7e3a1c85-92d6-4b07-8f41-6c2b5d9e30a7',
      itemCode: 'CAB-PC-6L',
      name: 'Powder-coated cabinet',
      unit: 'Nos',
      required: '12.000',
      available: '12.000',
      shortage: '0.000',
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
      materialShortParts: PRODUCTION_JOB_CARD.materialShortParts,
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
      /* Item 31 (0117): one item of each kind, because the rail lists one
         kind at a time and the scan opens on the OEM side. The product's
         locks are BOTH set — its job card above has minted units — so the
         edit form's named refusals are the disabled controls the scan
         checks the contrast of, not hypothetical ones. */
      role: 'oem',
      serialSeriesLocked: true,
      flagsLocked: true,
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
      role: 'sub',
      serialSeriesLocked: false,
      // Consumed into IPDB6-00130 above, so its flags are settled too.
      flagsLocked: true,
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

/* The stock ledger (migration 0087). Shaped so one paint carries every
   tint the two screens can put on a word: a part reading `Available`, one
   reading `Low stock` against its reorder level, and one whose available
   quantity is NEGATIVE — which is the same chip for a different reason
   and the number the shortage screen orders against. The shortage row
   carries both a Work-backed job card and a private one, because the
   second renders a badge with no Work code beside it. */
/* The signing queue (0091). Populated with all four terminal shapes at
   once — pending, claimed, signed, failed — because the status chip is
   the only colour this screen puts on a word, and a scan of an empty
   register proves nothing about chips it never drew. */
/* Notifications (0092). Every tint the screen can draw, at once.
   The channel block carries an ENABLED channel whose deployment has no
   transport, because that two-lamp state is the one thing on this screen
   with no precedent in the mock and the only place a success chip and a
   warning chip sit side by side. The template list carries the four
   statuses that tint differently — approved, pending, rejected, paused —
   and one draft, which is the deliberate neutral. The delivery log
   carries queued, sent, delivered, read and failed, so the scan sees the
   whole ledger vocabulary rather than whichever end of it the fixture
   happened to reach. */
const NOTIFICATION_CHANNELS = {
  channels: [
    {
      id: '11111111-0092-4000-8000-000000000001',
      channel: 'whatsapp',
      enabled: true,
      wabaPhoneNumberId: '109876543210987',
      wabaBusinessAccountId: '209876543210987',
      displayPhoneNumber: '+919000000001',
      apiBaseUrl: null,
      fromAddress: null,
      replyToAddress: null,
      // The lie a single lamp would have to tell: set up here, and the
      // server it runs on cannot send.
      transportConfigured: false,
      updatedAt: '2026-08-18T09:00:00.000Z',
    },
    {
      id: '11111111-0092-4000-8000-000000000002',
      channel: 'email',
      enabled: true,
      wabaPhoneNumberId: null,
      wabaBusinessAccountId: null,
      displayPhoneNumber: null,
      apiBaseUrl: null,
      fromAddress: 'no-reply@punyanagari.example',
      replyToAddress: 'accounts@punyanagari.example',
      transportConfigured: true,
      updatedAt: '2026-08-18T09:00:00.000Z',
    },
  ],
};

const NOTIFICATION_TEMPLATES = {
  templates: [
    ['challan_issued', 'approved', null, 'Challan issued'],
    ['bill_submitted', 'pending', null, 'Bill submitted'],
    ['payment_due', 'rejected', 'Template content violates policy', 'Payment due'],
    ['inspection_call', 'paused', 'Quality rating dropped to medium', null],
    ['warranty_note', 'draft', null, null],
  ].map(([name, status, statusReason, emailSubject], index) => ({
    id: `22222222-0092-4000-8000-00000000000${String(index)}`,
    name,
    language: 'en',
    category: 'utility',
    status,
    statusReason,
    bodyText: 'Document {{1}} for work {{2}} has been recorded.',
    parameterCount: 2,
    emailSubject,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  })),
  nextCursor: null,
};

const NOTIFICATION_CONSENTS = {
  consents: [
    ['Sr. DEE (G) CR Nagpur', 'whatsapp', '+919812345678', 'opted_in'],
    ['Dy. CME Ajni', 'email', 'dycme.ajni@railways.example', 'opted_in'],
    ['Sr. DME Bhusaval', 'whatsapp', '+919812345679', 'opted_out'],
  ].map(([contactDesignation, channel, address, state], index) => ({
    id: `33333333-0092-4000-8000-00000000000${String(index)}`,
    contactId: `44444444-0092-4000-8000-00000000000${String(index)}`,
    contactDesignation,
    channel,
    address,
    state,
    evidence:
      state === 'opted_in'
        ? 'Signed the delivery acknowledgement on 12 Aug 2026'
        : 'Asked to stop on the site call of 14 Aug 2026',
    recordedByUserId: 'user-1',
    recordedAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  })),
  nextCursor: null,
};

const NOTIFICATION_MESSAGES = {
  messages: [
    ['queued', null, null],
    ['sent', null, null],
    ['delivered', null, null],
    ['read', null, null],
    ['failed', '131047', 'Re-engagement message'],
  ].map(([status, failureCode, failureDetail], index) => ({
    id: `55555555-0092-4000-8000-00000000000${String(index)}`,
    channel: index % 2 === 0 ? 'whatsapp' : 'email',
    templateId: '22222222-0092-4000-8000-000000000000',
    templateName: 'challan_issued',
    templateLanguage: 'en',
    contactId: '44444444-0092-4000-8000-000000000000',
    contactDesignation: 'Sr. DEE (G) CR Nagpur',
    toAddress: index % 2 === 0 ? '+919812345678' : 'dycme.ajni@railways.example',
    parameters: ['DC/2026/0042', 'RE-2026-11'],
    status,
    provider: index % 2 === 0 ? 'meta_cloud' : 'smtp',
    providerMessageId: status === 'queued' ? null : `wamid.00${String(index)}`,
    failureCode,
    failureDetail,
    requestedByUserId: 'user-1',
    queuedAt: '2026-08-18T09:00:00.000Z',
    sentAt: status === 'queued' ? null : '2026-08-18T09:00:01.000Z',
    deliveredAt:
      status === 'delivered' || status === 'read' ? '2026-08-18T09:00:05.000Z' : null,
    readAt: status === 'read' ? '2026-08-18T09:00:09.000Z' : null,
    failedAt: status === 'failed' ? '2026-08-18T09:00:03.000Z' : null,
  })),
  nextCursor: null,
};

const SIGNING_THUMBPRINT = 'CFD1D2EF23018CEC652D1F380FC57FDCF5C0C4E4';
/* Spreadsheet imports (0094). Both batch chips and both row chips are on
   screen at once, because the chip is the only colour this screen puts on
   a word — and the row errors below them are 11px prose in the muted ink,
   which is the pairing most likely to miss AA. */
const IMPORT_COLUMNS = [
  {
    key: 'designation',
    header: 'Designation',
    required: true,
    note: 'Required. The office or firm as it is written on the paperwork.',
  },
  { key: 'address', header: 'Address', required: false, note: 'Optional.' },
  { key: 'gstin', header: 'GSTIN', required: false, note: 'Optional. 15 characters.' },
];

const IMPORT_BATCHES = {
  batches: [
    {
      id: '00000000-0000-4000-8000-000000000941',
      target: 'contacts',
      status: 'validated',
      originalFilename: 'vendors-2026.xlsx',
      sourceSha256: 'b'.repeat(64),
      rowCount: 3,
      validRowCount: 2,
      errorRowCount: 1,
      importedRowCount: 0,
      createdByUserId: 'user-1',
      createdAt: '2026-08-18T09:15:00.000Z',
      completedAt: null,
      cancelledAt: null,
      cancelledReason: null,
    },
    {
      id: '00000000-0000-4000-8000-000000000942',
      target: 'canonical_items',
      status: 'completed',
      originalFilename: 'catalogue.xlsx',
      sourceSha256: 'c'.repeat(64),
      rowCount: 12,
      validRowCount: 12,
      errorRowCount: 0,
      importedRowCount: 12,
      createdByUserId: 'user-1',
      createdAt: '2026-08-17T11:00:00.000Z',
      completedAt: '2026-08-17T11:02:00.000Z',
      cancelledAt: null,
      cancelledReason: null,
    },
    {
      id: '00000000-0000-4000-8000-000000000943',
      target: 'contacts',
      status: 'cancelled',
      originalFilename: 'wrong-sheet.xlsx',
      sourceSha256: 'd'.repeat(64),
      rowCount: 4,
      validRowCount: 4,
      errorRowCount: 0,
      importedRowCount: 0,
      createdByUserId: 'user-1',
      createdAt: '2026-08-16T08:00:00.000Z',
      completedAt: null,
      cancelledAt: '2026-08-16T08:05:00.000Z',
      cancelledReason: 'Uploaded the wrong sheet',
    },
  ],
  nextCursor: null,
  targets: [
    { key: 'contacts', label: 'Contacts', columns: IMPORT_COLUMNS },
    {
      key: 'canonical_items',
      label: 'Catalogue items',
      columns: [
        {
          key: 'name',
          header: 'Item name',
          required: true,
          note: 'Required. Unique in the catalogue.',
        },
      ],
    },
  ],
};

const IMPORT_BATCH_DETAIL = {
  batch: IMPORT_BATCHES.batches[0],
  columns: IMPORT_COLUMNS,
  // One page, exhausted — so the scan sees the "Show the rows that
  // passed" control rather than "Load more". Both are the same button
  // variant; this is the one an operator reaches first.
  nextRowCursor: null,
  rows: [
    {
      id: '00000000-0000-4000-8000-000000000951',
      rowNumber: 2,
      status: 'error',
      cells: { designation: 'Sr.DFM Bhusawal', address: 'DRM Office', gstin: '27BAD' },
      errors: [
        {
          column: 'designation',
          message:
            'Bill-paying authorities (Sr.DFM/DFM/ADFM) and awarding authorities (Sr.DSTE) are never consignees (rule R16); record the consignee named on the document instead.',
        },
        {
          column: 'gstin',
          message:
            'The GSTIN must be 15 characters: 2-digit state code + PAN + entity code + Z + check character, or a TDS-deductor GSTIN ending in D (railway units).',
        },
      ],
      importedRecordId: null,
    },
    {
      id: '00000000-0000-4000-8000-000000000952',
      rowNumber: 3,
      status: 'valid',
      cells: {
        designation: 'Nagpur Signalling Works',
        address: 'Nagpur',
        gstin: '27AAAPZ1234C1ZV',
      },
      errors: [],
      importedRecordId: null,
    },
    {
      id: '00000000-0000-4000-8000-000000000953',
      rowNumber: 4,
      status: 'valid',
      cells: { designation: 'Akola Traction Supplies', address: 'Akola', gstin: '' },
      errors: [],
      importedRecordId: null,
    },
  ],
};

/** The organisation-wide audit register (0095). One row of each shape the
 * screen draws differently: an update carrying a before/after diff, a
 * creation carrying context facts, and an organisation-level event with no
 * record id at all — which is the row that renders a dash where every
 * other row renders a monospace identifier. */
const AUDIT_REGISTER = {
  events: [
    {
      id: 'a1111111-1111-4111-8111-111111111111',
      occurredAt: '2026-08-11T09:15:00.000Z',
      actorUserId: 'user-a',
      actorName: 'Anand Sharma',
      action: 'challan.issued',
      entityType: 'delivery_challans',
      entityId: 'a2222222-2222-4222-8222-222222222222',
      details: {
        before: { status: 'draft' },
        after: { status: 'issued' },
      },
    },
    {
      id: 'a3333333-3333-4333-8333-333333333333',
      occurredAt: '2026-08-10T11:40:00.000Z',
      actorUserId: 'user-a',
      actorName: 'Anand Sharma',
      action: 'membership.updated',
      entityType: 'organisation_memberships',
      entityId: null,
      details: {
        before: { canManagePayments: false },
        after: { canManagePayments: true },
      },
    },
    {
      id: 'a4444444-4444-4444-8444-444444444444',
      occurredAt: '2026-08-09T05:05:00.000Z',
      actorUserId: 'user-a',
      actorName: 'Anand Sharma',
      action: 'work.created',
      entityType: 'works',
      entityId: 'a5555555-5555-4555-8555-555555555555',
      details: { number: 'NWR-114' },
    },
  ],
  nextCursor: null,
  windowFrom: '2018-08-01',
  retentionMonths: 96,
};

const AUDIT_FACETS = {
  actions: ['challan.issued', 'membership.updated', 'work.created'],
  entityTypes: ['delivery_challans', 'organisation_memberships', 'works'],
  actors: [{ userId: 'user-a', name: 'Anand Sharma' }],
};

/** The management summary (0095). Two months so the table has more than
 * one row, all five ageing bands because the screen always draws all five,
 * and a payroll month so the third table is not its empty state. */
const MIS_SUMMARY = {
  outputTax: [
    {
      month: '2026-08',
      invoiceCount: 4,
      taxableValue: '4820000.00',
      cgst: '433800.00',
      sgst: '433800.00',
      igst: '0.00',
      gstTotal: '867600.00',
      total: '5687600.00',
      creditNoteCount: 1,
      creditTaxableValue: '120000.00',
      creditTotal: '141600.00',
    },
    {
      month: '2026-07',
      invoiceCount: 2,
      taxableValue: '1960000.00',
      cgst: '0.00',
      sgst: '0.00',
      igst: '352800.00',
      gstTotal: '352800.00',
      total: '2312800.00',
      creditNoteCount: 0,
      creditTaxableValue: '0.00',
      creditTotal: '0.00',
    },
  ],
  receivablesAgeing: [
    { bucket: 'unsubmitted', billCount: 1, outstanding: '0.00' },
    { bucket: '0-30', billCount: 3, outstanding: '1840000.00' },
    { bucket: '31-60', billCount: 1, outstanding: '620000.00' },
    { bucket: '61-90', billCount: 0, outstanding: '0.00' },
    { bucket: '90+', billCount: 2, outstanding: '2410000.00' },
  ],
  indeterminateBills: 1,
  payrollCost: [
    {
      month: '2026-07',
      runCount: 1,
      headcount: 14,
      grossPay: '842000.00',
      deductions: '96400.00',
      netPay: '745600.00',
    },
  ],
};

/* The platform controls (0096). One configured flag and one untouched,
   because the row says something different in each case; one schedule and
   one completed run, so the history table is drawn rather than its empty
   state; and one READY export, so the digest, the size and the download
   action are all on screen for the contrast scan. */
const PLATFORM_ENTITLEMENTS = {
  entitlements: [
    {
      key: 'eway_bill',
      label: 'E-way bill',
      description:
        'Generating, cancelling and reconciling NIC E-way Bills. Switch this off for an organisation whose NIC re-certification has not landed.',
      enabled: false,
      defaultEnabled: true,
      configured: true,
      note: 'waiting on NIC re-certification',
      setBy: 'user-a',
      updatedAt: '2026-08-18T10:00:00.000Z',
    },
    {
      key: 'outbound_signing',
      label: 'Outbound signing',
      description:
        'Sending an issued document for the organisation’s own digital signature.',
      enabled: true,
      defaultEnabled: true,
      configured: false,
      note: null,
      setBy: null,
      updatedAt: null,
    },
  ],
};

const PLATFORM_SCHEDULES = {
  schedules: [
    {
      id: '3f1c8a52-6d4b-4e77-9c1a-8b2d5e6f7a90',
      kind: 'instrument_expiry_review',
      label: 'Guarantee and certificate expiry',
      description:
        'Reports the performance guarantees and PAC certificates whose expiry falls inside the horizon.',
      enabled: true,
      cadence: 'weekly',
      horizonDays: 45,
      nextRunAt: '2026-08-25T04:00:00.000Z',
      lastEnqueuedAt: '2026-08-18T04:00:00.000Z',
      authorityUserId: 'user-a',
      disabledReason: null,
    },
  ],
  runs: [
    {
      id: '4a2d9b63-7e5c-4f88-8d2b-9c3e6f7a8b01',
      kind: 'instrument_expiry_review',
      state: 'done',
      attempts: 1,
      createdAt: '2026-08-18T04:00:00.000Z',
      finishedAt: '2026-08-18T04:00:02.000Z',
      outcome: { reviewed: 3, lapsed: 0 },
      lastError: null,
    },
    {
      id: '5b3e0c74-8f6d-4099-9e3c-0d4f7a8b9c12',
      kind: 'instrument_expiry_review',
      state: 'refused_bind',
      attempts: 1,
      createdAt: '2026-08-11T04:00:00.000Z',
      finishedAt: '2026-08-11T04:00:01.000Z',
      outcome: null,
      lastError: null,
    },
  ],
};

const PLATFORM_EXPORTS = {
  exports: [
    {
      id: '6c4f1d85-9a7e-41aa-8f4d-1e5a8b9c0d23',
      state: 'ready',
      requestedBy: 'user-a',
      requestedAt: '2026-08-18T10:00:00.000Z',
      completedAt: '2026-08-18T10:04:00.000Z',
      formatVersion: 'export-v28',
      byteSize: '4194304',
      sha256: 'f'.repeat(64),
      expiresAt: '2026-09-17T10:04:00.000Z',
      failureReason: null,
      downloadCount: 0,
    },
  ],
  retentionHours: 720,
};

const SIGNING_QUEUE = {
  requests: [
    ['pending', null, null],
    ['claimed', null, null],
    ['signed', 'b'.repeat(64), null],
    ['failed', null, 'The token PIN dialog was cancelled'],
  ].map(([status, signedSha256, failureReason], index) => ({
    id: `0000000${String(index)}-0000-4000-8000-000000000000`,
    documentType: 'delivery_challan',
    documentId: '99999999-9999-4999-8999-999999999999',
    documentNumber: `DC/2026/00${String(41 + index)}`,
    workCode: 'RE-2026-11',
    channel: 'kiosk_dsc',
    status,
    sourceSha256: 'a'.repeat(64),
    signedSha256,
    certificateThumbprint: SIGNING_THUMBPRINT,
    signerName: 'A K SHARMA',
    signingReason: 'Issued by the contractor',
    signingLocation: 'Nagpur',
    requestedByUserId: 'user-1',
    requestedAt: '2026-08-18T09:30:00.000Z',
    expiresAt: '2026-08-25T09:30:00.000Z',
    claimedAt: status === 'pending' ? null : '2026-08-18T09:31:00.000Z',
    completedAt:
      signedSha256 === null && failureReason === null
        ? null
        : '2026-08-18T09:32:00.000Z',
    signatureVerdict: null,
    failureReason,
  })),
  nextCursor: null,
  agents: [
    {
      id: '88888888-8888-4888-8888-888888888888',
      label: 'Cabin kiosk',
      certificateThumbprint: SIGNING_THUMBPRINT,
      certificateSubject: 'CN=A K SHARMA, O=PUNYA NAGARI ENTERPRISES, C=IN',
      certificateNotAfter: '2027-05-23T00:00:00.000Z',
      operatorUserId: 'user-1',
      createdAt: '2026-08-17T05:00:00.000Z',
      lastSeenAt: '2026-08-18T09:31:00.000Z',
      revokedAt: null,
    },
  ],
};

/* The warranty register (0099). Populated with all five readings the
   standing chip can carry at once — running, expiring, elapsed,
   discharged, voided — because the chip is the only colour this screen
   puts on a word and a scan of an empty register proves nothing about
   chips it never drew. Two Works, so the Work column is scanned with more
   than one value in it. */
const WARRANTY_REGISTER = {
  warranties: (
    [
      ['elapsed', 'active', '2026-06-01', -78],
      ['expiring', 'active', '2026-10-02', 45],
      ['active', 'active', '2028-02-02', 533],
      ['closed', 'closed', '2026-03-31', null],
      ['voided', 'voided', '2027-01-31', null],
    ] as const
  ).map(([standing, status, dlpExpiresOn, daysToExpiry], index) => ({
    id: `1111111${String(index)}-1111-4111-8111-111111111111`,
    workId: '33333333-3333-4333-8333-333333333333',
    workCode: index % 2 === 0 ? 'PL270-CRB' : 'RE-2026-11',
    workTitle: index % 2 === 0 ? 'Signalling gear, CR Bhusawal' : 'Point machines',
    installationId: `2222222${String(index)}-2222-4222-8222-222222222222`,
    itemNumber: `A/${String(index + 1)}`,
    quantity: '2.500',
    installedOn: '2026-02-03',
    locationName: 'Nashik Road station',
    dlpMonths: 24,
    startBasis: 'installation',
    pacReference: null,
    dlpStartOn: '2026-02-03',
    originalExpiresOn: dlpExpiresOn,
    dlpExpiresOn,
    status,
    standing,
    daysToExpiry,
    closedOn: status === 'closed' ? '2026-04-01' : null,
    closureNote: status === 'closed' ? 'No defect reported in the period' : null,
    voidNote: status === 'voided' ? 'Started against the wrong installation' : null,
    createdAt: '2026-02-03T05:00:00.000Z',
  })),
  nextCursor: null,
};

/* The historical Zoho Books register (migration 0115). Drawn with both
   shapes the Work cell can take — an invoice filed against a contract,
   which renders a link, and one filed against nothing, which renders a
   word — and with both readings of the e-invoice chip, because that chip
   is the only colour this screen puts on a word and it is DERIVED from
   the IRN rather than copied from the export's status column. */
const IMPORTED_INVOICE_REGISTER = {
  invoices: (
    [
      ['ZB-2023-0041', '2023-07-14', true, '33333333-3333-4333-8333-333333333333'],
      ['ZB-2024-0106', '2024-11-02', false, null],
      // Voided, and still carrying the IRN it was registered under — which
      // is why the chip cannot be derived from the IRN alone.
      ['ZB-2025-0233', '2025-02-27', true, null],
      // Read from TallyPrime rather than Zoho (0119): billing Zoho never
      // held, so it carries no Zoho id and no sub-total.
      ['TP-2021-0007', '2021-06-18', false, null],
    ] as const
  ).map(([invoiceNumber, invoiceDate, issued, workId], index) => ({
    id: `6666666${String(index)}-6666-4666-8666-666666666666`,
    // The fourth row came from TallyPrime, which states neither a Zoho
    // identifier nor a sub-total — see migration 0119.
    source: index === 3 ? 'tally' : 'zoho',
    zohoInvoiceId: index === 3 ? null : `zoho-${String(index + 1)}`,
    invoiceNumber,
    invoiceDate,
    customerName:
      workId === null ? 'Deccan Switchgear Pvt Ltd' : 'Central Railway, Bhusawal',
    customerGstin: workId === null ? '27AABCD1234E1ZZ' : '27AAACR1234E1Z1',
    placeOfSupply: 'Maharashtra',
    contactId: workId === null ? null : '55555555-5555-4555-8555-555555555555',
    contactName: workId === null ? null : 'Central Railway, Bhusawal',
    contactMatchMethod: workId === null ? null : 'gstin',
    // The export's own column, kept as evidence and NOT as the chip's
    // source — except for 'Void', which is the one reading of it this
    // register trusts. The last row carries it, so the scan draws all
    // three tones the chip can take.
    zohoStatus: index === 2 ? 'Void' : 'Draft',
    issued,
    irn: issued ? `irn-${String(index + 1)}` : null,
    ackNumber: issued ? `11220${String(index)}` : null,
    ackDate: issued ? invoiceDate : null,
    referenceText: workId === null ? 'PO/2024/88' : 'LOA 27/2023',
    subTotal: index === 3 ? null : '184000.00',
    total: '217120.00',
    balance: '0.00',
    roundOff: null,
    workId,
    workCode: workId === null ? null : 'PL270-CRB',
    workWithdrawn: false,
    linkMethod: workId === null ? null : 'loa_match',
    lineCount: index === 3 ? 0 : 2,
    // The cross-reference (0119). The first row is one both systems hold
    // and agree about, the fourth is Tally's own and disputed, and the
    // second names two vouchers — which is why the cell says how many
    // instead of naming one of them.
    tallyVoucherCount: index === 0 ? 1 : index === 1 ? 2 : index === 3 ? 1 : 0,
    // The FOURTH row's single voucher is its own origin and TallyPrime
    // numbered it; the FIRST row's is a match. The second names two, which
    // is why that cell says how many instead of naming one of them.
    tallyVoucherNumber:
      index === 0 ? 'PL270/0041' : index === 3 ? 'TP-2021-0007' : null,
    // DISPUTED SITS ON THE ZOHO-SOURCED ROW, and it has to: a
    // Tally-sourced row's only correspondence is its `origin` link, and
    // 0119's own CHECK refuses a disputed origin — there is no second
    // figure for it to disagree with. Putting the lamp on the Tally row
    // drew a state the database cannot hold, which is a fixture teaching
    // the scan about a screen that can never exist.
    disputed: index === 0,
    disputeResolved: false,
    discardedAt: null,
    discardReason: null,
    importedAt: '2026-08-21T05:00:00.000Z',
  })),
  nextCursor: null,
  totals: {
    invoiceCount: 4,
    linkedCount: 1,
    // The third row is a Zoho void and the first carries an unresolved
    // disagreement, and the server leaves both out of this figure: two
    // invoices' worth, not four.
    totalValue: '434240.00',
    tallySourcedCount: 1,
    disputedCount: 1,
    disputedUnresolvedCount: 1,
    earliestDate: '2021-06-18',
    latestDate: '2025-02-27',
  },
};

/* The Tally ledger census (migration 0118), drawn with all four classes on
   screen at once — the scan needs every tone the class chip can take, and
   `other` is the only one that renders neutral. One party carries a
   proposed contact and one does not, because the unmatched half is what
   the screen exists to work through, and the instrument carries the work
   code that is TEXT rather than a link. */
const TALLY_LEDGER_CENSUS = {
  ledgers: (
    [
      ['Central Railway, Bhusawal', 'Railway Authority', 'customer', true],
      ['Deccan Switchgear Pvt Ltd', 'Private Parties', 'customer', false],
      ['Konkan Cables & Conductors', 'Sundry Creditors', 'vendor', false],
      ['SD Bhusawal PL-270', 'Railway Security Deposits', 'instrument', false],
      ['CGST Input 9%', 'Duties & Taxes', 'other', false],
    ] as const
  ).map(([ledgerName, parentGroup, classification, matched], index) => ({
    id: `7777777${String(index)}-7777-4777-8777-777777777777`,
    tallyGuid: `tally-guid-${String(index + 1)}`,
    tallyAlterId: 15_700 + index,
    ledgerName,
    parentGroup,
    groupPath:
      classification === 'customer'
        ? ['Current Assets', 'Sundry Debtors', parentGroup]
        : classification === 'vendor'
          ? ['Current Liabilities', 'Sundry Creditors']
          : classification === 'instrument'
            ? ['Current Assets', 'Deposits (Asset)', parentGroup]
            : ['Current Liabilities', parentGroup],
    classification,
    gstin: matched ? '27AAACR1234E1Z1' : null,
    openingBalance: classification === 'instrument' ? '-1250000.00' : null,
    plCode: classification === 'instrument' ? 'PL-270' : null,
    tallyIsDeleted: false,
    nameAmbiguous: false,
    proposedContactId: matched ? '55555555-5555-4555-8555-555555555555' : null,
    proposedContactName: matched ? 'Central Railway, Bhusawal' : null,
    proposedContactMethod: matched ? 'gstin' : null,
    sourceFilename: 'Master.xml',
    lastSeenAt: '2026-08-22T04:30:00.000Z',
    importedAt: '2026-08-22T04:30:00.000Z',
  })),
  nextCursor: null,
  totals: {
    ledgerCount: 5,
    customerCount: 2,
    vendorCount: 1,
    instrumentCount: 1,
    otherCount: 1,
    proposedContactCount: 1,
    unmatchedPartyCount: 2,
    codedCount: 1,
    distinctCodeCount: 1,
    lastImportedAt: '2026-08-22T04:30:00.000Z',
    lastFilename: 'Master.xml',
    supersededCount: 0,
  },
};

/* The purchase-order register (migration 0109), drawn with both series on
   screen at once: the tab counts are the only place the register puts a
   number in a control, and the Against column is the only cell whose two
   shapes differ — a linked Work code, and the plain word for an order
   raised outside any LOA. Four statuses, so every chip tone the register
   can show is scanned in both themes. */
export const PURCHASE_ORDER_REGISTER = {
  purchaseOrders: (
    [
      ['issued', 'PL270-CRB-PO-01', '33333333-3333-4333-8333-333333333333'],
      ['closed', 'PL270-CRB-PO-02', '33333333-3333-4333-8333-333333333333'],
      ['draft', null, null],
      ['cancelled', 'PO-01', null],
    ] as const
  ).map(([status, poNumber, workId], index) => ({
    id: `4444444${String(index)}-4444-4444-8444-444444444444`,
    workId,
    workCode: workId === null ? null : 'PL270-CRB',
    vendorContactId: '55555555-5555-4555-8555-555555555555',
    vendorDesignation: 'Bharat Cables Pvt Ltd',
    status,
    poNumber,
    sequenceNumber: poNumber === null ? null : index + 1,
    poDate: '2026-08-01',
    expectedOn: '2026-08-20',
    terms: null,
    totalAmount: poNumber === null ? null : '184000.00',
    cancellationNote:
      status === 'cancelled' ? 'Vendor withdrew the quoted rate.' : null,
    lineCount: 3,
    createdAt: '2026-08-01T05:00:00.000Z',
    issuedAt: poNumber === null ? null : '2026-08-01T06:00:00.000Z',
    closedAt: status === 'closed' ? '2026-08-14T06:00:00.000Z' : null,
    cancelledAt: status === 'cancelled' ? '2026-08-15T06:00:00.000Z' : null,
  })),
  nextCursor: null,
};

/* The Work's own defect liability card, scanned inside the Instruments
   tab. Drawn with a guarantee that lapses BEFORE the warranty does, so
   the shortfall chip — the one warning tint this card carries — is on
   screen, and with one candidate so the start table and its action are
   scanned too. */
export const WORK_WARRANTY = {
  terms: {
    dlpMonths: 24,
    startBasis: 'installation',
    notes: 'Clause 12.2 of the special conditions',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  pbgCover: {
    requiredByLetter: true,
    dlpCoverUntil: '2028-02-02',
    instrumentReference: 'BG/22',
    instrumentExpiresOn: '2027-12-19',
    shortfallDays: 45,
  },
  finalBillDate: null,
  candidates: [
    {
      installationId: '44444444-4444-4444-8444-444444444446',
      itemNumber: 'A/9',
      quantity: '1.000',
      installedOn: '2026-08-01',
      locationName: 'Bhusawal yard',
      pacOptions: [],
    },
  ],
  candidatesTruncated: false,
  warranties: WARRANTY_REGISTER.warranties.slice(0, 3),
  nextCursor: null,
};

const STOCK_REGISTER = {
  items: [
    {
      id: '9f2c1d84-6b3a-4e57-8c10-2a5d7e9f4b31',
      itemCode: 'EL-SMPS-2410',
      name: '24 V 10 A SMPS',
      category: 'Power supplies',
      unit: 'Nos',
      manufactured: false,
      serialControlled: true,
      active: true,
      reorderLevel: '20.000',
      onHand: '30.000',
      committed: '4.000',
      available: '26.000',
      belowReorderLevel: false,
    },
    {
      id: '3b7e5a91-2c48-4d6f-9a03-8e1b6c2f7d54',
      itemCode: 'EL-CTRL-ETH',
      name: 'Ethernet controller card',
      category: 'Electronics',
      unit: 'Nos',
      manufactured: false,
      serialControlled: true,
      active: true,
      reorderLevel: '10.000',
      onHand: '9.000',
      committed: '3.000',
      available: '6.000',
      belowReorderLevel: true,
    },
    {
      id: '6d4f8c02-7a15-4b93-8e26-5c9a3f1b7e48',
      itemCode: 'RM-CAB-IPDB6',
      name: 'Powder-coated cabinet',
      category: 'Fabrication',
      unit: 'Nos',
      manufactured: false,
      serialControlled: false,
      active: true,
      reorderLevel: null,
      onHand: '0.000',
      committed: '11.000',
      available: '-11.000',
      belowReorderLevel: false,
    },
  ],
  nextCursor: null,
  summary: { partsTracked: 3, partsBelowReorderLevel: 1, partsShort: 1 },
};

/* Maintenance (migration 0088). Three requests, one in each of the
   stages that carries a tint — awaiting approval (warning), dispatching
   (warning) and closed (neutral) — plus an approved one, so the axe scan
   sees every chip this module can render at once. The detail fixture is
   the dispatching request, with one line part-dispatched and owing a
   defective unit back and one line written off, which is every state the
   Materials table draws. */
const MAINTENANCE_REQUEST_ID = 'b41c7d29-5e83-4f16-9a27-3d5c8b1e6f40';
const MAINTENANCE_LINE_ID = 'c52d8e3a-6f94-4027-8b38-4e6d9c2f7a51';
const MAINTENANCE_LINE_TWO_ID = 'd63e9f4b-7a05-4138-9c49-5f7e0d3a8b62';

const MAINTENANCE_LIST = {
  requests: [
    {
      id: MAINTENANCE_REQUEST_ID,
      requestNumber: 'MR/26-27/00142',
      workId: WORK_ID,
      workCode: 'PL-281',
      station: 'Churchgate',
      requesterName: 'Amit Patil',
      priority: 'critical',
      requiredBy: '2026-08-20',
      faultSummary: 'Replace failed platform display power supplies',
      status: 'partially_dispatched',
      createdAt: '2026-08-15T08:30:00.000Z',
    },
    {
      id: 'e74f0a5c-8b16-4249-8d5a-6a8f1e4b9c73',
      requestNumber: 'MR/26-27/00141',
      workId: WORK_ID,
      workCode: 'PL-281',
      station: 'Marine Lines',
      requesterName: 'Sunita Rao',
      priority: 'urgent',
      requiredBy: null,
      faultSummary: 'Announcement amplifier tripping on load',
      status: 'awaiting_approval',
      createdAt: '2026-08-14T06:10:00.000Z',
    },
    {
      id: 'f85a1b6d-9c27-435a-9e6b-7b9a2f5c0d84',
      requestNumber: 'MR/26-27/00140',
      workId: WORK_ID,
      workCode: 'PL-281',
      station: 'Grant Road',
      requesterName: 'Imran Shaikh',
      priority: 'routine',
      requiredBy: null,
      faultSummary: 'Spare Ethernet controller for display cabinet',
      status: 'approved',
      createdAt: '2026-08-12T09:45:00.000Z',
    },
    {
      id: '096b2c7e-0d38-446b-8f7c-8c0b3a6d1e95',
      requestNumber: 'MR/26-27/00139',
      workId: WORK_ID,
      workCode: 'PL-281',
      station: 'Charni Road',
      requesterName: 'Amit Patil',
      priority: 'routine',
      requiredBy: null,
      faultSummary: 'Replaced cabinet lock set',
      status: 'closed',
      createdAt: '2026-08-05T11:20:00.000Z',
    },
  ],
  nextCursor: null,
  counts: {
    awaitingApproval: 1,
    approved: 1,
    partiallyDispatched: 1,
    closed: 1,
  },
};

export const MAINTENANCE_AWAITING_APPROVAL = {
  request: {
    id: 'e74f0a5c-8b16-4249-8d5a-6a8f1e4b9c73',
    requestNumber: 'MR/26-27/00141',
    workId: WORK_ID,
    workCode: 'PL-281',
    station: 'Marine Lines',
    requesterName: 'Sunita Rao',
    requesterPhone: null,
    priority: 'urgent',
    requiredBy: null,
    faultSummary: 'Announcement amplifier tripping on load',
    operationalImpact: null,
    deliveryInstructions: null,
    status: 'awaiting_approval',
    approvalComment: null,
    createdAt: '2026-08-14T06:10:00.000Z',
  },
  lines: [
    {
      id: 'a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70',
      position: 1,
      itemId: '3b7e5a91-2c48-4d6f-9a03-8e1b6c2f7d54',
      itemCode: 'EL-CTRL-ETH',
      description: 'Ethernet controller card',
      unit: 'Nos',
      purpose: null,
      quantity: '1.000',
      outstandingQuantity: '1.000',
      dispatchedQuantity: '0.000',
      cancelledQuantity: '0.000',
      cancellationReason: null,
      expectedReturnQuantity: '1.000',
      receivedReturnQuantity: '0.000',
      returnDueQuantity: '0.000',
      onHand: '9.000',
      assetSerials: [],
      resolved: false,
    },
  ],
  dispatches: [],
  returns: [],
  canClose: false,
};

const MAINTENANCE_DETAIL = {
  request: {
    id: MAINTENANCE_REQUEST_ID,
    requestNumber: 'MR/26-27/00142',
    workId: WORK_ID,
    workCode: 'PL-281',
    station: 'Churchgate',
    requesterName: 'Amit Patil',
    requesterPhone: '+91 98765 41021',
    priority: 'critical',
    requiredBy: '2026-08-20',
    faultSummary: 'Replace failed platform display power supplies',
    operationalImpact: 'Two display boards unavailable',
    deliveryInstructions: 'Hand over to site supervisor',
    status: 'partially_dispatched',
    approvalComment: 'Approved for issue against available maintenance stock',
    createdAt: '2026-08-15T08:30:00.000Z',
  },
  lines: [
    {
      id: MAINTENANCE_LINE_ID,
      position: 1,
      itemId: '9f2c1d84-6b3a-4e57-8c10-2a5d7e9f4b31',
      itemCode: 'EL-SMPS-2410',
      description: '24 V 10 A SMPS',
      unit: 'Nos',
      purpose: 'Replacement',
      quantity: '4.000',
      outstandingQuantity: '2.000',
      dispatchedQuantity: '2.000',
      cancelledQuantity: '0.000',
      cancellationReason: null,
      expectedReturnQuantity: '4.000',
      receivedReturnQuantity: '1.000',
      returnDueQuantity: '3.000',
      onHand: '30.000',
      assetSerials: ['SMPS-2019-4471'],
      resolved: false,
    },
    {
      id: MAINTENANCE_LINE_TWO_ID,
      position: 2,
      itemId: null,
      itemCode: null,
      description: 'Weatherproof gland kit',
      unit: 'Set',
      purpose: null,
      quantity: '2.000',
      outstandingQuantity: '0.000',
      dispatchedQuantity: '0.000',
      cancelledQuantity: '2.000',
      cancellationReason: 'Site sourced locally',
      expectedReturnQuantity: '0.000',
      receivedReturnQuantity: '0.000',
      returnDueQuantity: '0.000',
      onHand: null,
      assetSerials: [],
      resolved: true,
    },
  ],
  dispatches: [
    {
      id: '1a7c3d8e-2b49-4c5a-9d6b-3e8f0a1b2c4d',
      challanNumber: 'PL-281/MNT/001',
      dispatchDate: '2026-08-16',
      stockLocation: 'Central store',
      receiverName: 'Site supervisor',
      transporter: 'MH-01-AB-4412',
      notes: null,
      lines: [
        {
          lineId: MAINTENANCE_LINE_ID,
          description: '24 V 10 A SMPS',
          unit: 'Nos',
          quantity: '2.000',
        },
      ],
    },
  ],
  returns: [
    {
      id: '2b8d4e9f-3c50-4d6b-8e7c-4f9a1b2c3d5e',
      lineId: MAINTENANCE_LINE_ID,
      lineDescription: '24 V 10 A SMPS',
      quantity: '1.000',
      receivedOn: '2026-08-17',
      serials: ['SMPS-2019-4471'],
      conditionNote: 'Burnt output stage',
      repairDisposition: 'Bench repair',
      receivedBy: 'Store clerk',
      notes: null,
    },
  ],
  canClose: false,
};

const STOCK_MOVEMENTS = {
  movements: [
    {
      id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      reference: 'SM/EL-SMPS-2410/2',
      itemId: '9f2c1d84-6b3a-4e57-8c10-2a5d7e9f4b31',
      itemCode: 'EL-SMPS-2410',
      itemName: '24 V 10 A SMPS',
      unit: 'Nos',
      movementType: 'issue',
      quantity: '-4.000',
      balanceAfter: '26.000',
      movementDate: '2026-08-14',
      source: 'work',
      sourceLabel: 'PL-281',
      reason: null,
      counterparty: null,
      createdAt: '2026-08-14T09:00:00.000Z',
    },
    {
      id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
      reference: 'SM/EL-SMPS-2410/1',
      itemId: '9f2c1d84-6b3a-4e57-8c10-2a5d7e9f4b31',
      itemCode: 'EL-SMPS-2410',
      itemName: '24 V 10 A SMPS',
      unit: 'Nos',
      movementType: 'adjustment_in',
      quantity: '30.000',
      balanceAfter: '30.000',
      movementDate: '2026-08-12',
      source: 'none',
      sourceLabel: null,
      reason: 'Opening stock count',
      counterparty: null,
      createdAt: '2026-08-12T09:00:00.000Z',
    },
  ],
  nextCursor: null,
};

const STOCK_PENDING_RECEIPTS = {
  dispatches: [
    {
      productionDispatchId: '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b',
      reference: 'PP-26-081/D1',
      dispatchedOn: '2026-08-15',
      itemId: '4c5d6e7f-8a9b-4c0d-8e1f-2a3b4c5d6e7f',
      itemCode: 'PEB-IPDB-6L',
      itemName: 'IP Display Board 6 line',
      unit: 'Nos',
      quantity: '6',
    },
  ],
};

const STOCK_SHORTAGES = {
  shortages: [
    {
      itemId: '6d4f8c02-7a15-4b93-8e26-5c9a3f1b7e48',
      itemCode: 'RM-CAB-IPDB6',
      name: 'Powder-coated cabinet',
      unit: 'Nos',
      required: '11.000',
      onHand: '0.000',
      shortage: '11.000',
      jobCards: [
        {
          id: '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d',
          number: 'PP-26-081',
          workId: 'd6a1c9b4-5e73-4f28-9a0c-1b2d3e4f5a67',
          workCode: 'PL-281',
          required: '7.000',
        },
        {
          id: '9b0c1d2e-3f4a-4b5c-8d6e-8f9a0b1c2d3e',
          number: 'PP-26-082',
          workId: null,
          workCode: null,
          required: '4.000',
        },
      ],
    },
  ],
  purchaseOrders: [
    {
      id: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      workId: 'd6a1c9b4-5e73-4f28-9a0c-1b2d3e4f5a67',
      poNumber: 'PL-281-PO-03',
      status: 'issued',
      vendorDesignation: 'Bright LED Components',
      poDate: '2026-08-10',
      expectedOn: '2026-08-24',
      jobCardNumbers: ['PP-26-081'],
      lines: [
        {
          productionItemId: '3b7e5a91-2c48-4d6f-9a03-8e1b6c2f7d54',
          itemCode: 'EL-CTRL-ETH',
          name: 'Ethernet controller card',
          unit: 'Nos',
          ordered: '18.000',
          received: '6.000',
        },
      ],
    },
  ],
};

/* People and payroll (migrations 0089, 0090). Populated on purpose: an
   empty register scans the EmptyState and proves nothing about the row,
   the status chip or the numeric columns, which is where a contrast or
   target-size failure would actually be.

   The three employees are chosen to put every tinted word and every
   awkward figure on the screen at once — one employed and one who has
   left, one covered by insurance and one above the ceiling, and a
   profession tax of zero beside one of ₹200. */
const EMPLOYEE_REGISTER = {
  employees: [
    {
      id: 'ee000001-1111-4111-8111-aaaaaaaaaaaa',
      employeeCode: 'EMP-001',
      name: 'Anita Deshmukh',
      designation: 'Project coordinator',
      department: 'Projects',
      dateOfJoining: '2022-04-11',
      dateOfExit: null,
      employed: true,
      monthlyGross: '68200.00',
      pfCovered: true,
      esiApplicable: true,
    },
    {
      id: 'ee000002-1111-4111-8111-aaaaaaaaaaaa',
      employeeCode: 'EMP-005',
      name: 'Kavita More',
      designation: 'Office assistant',
      department: 'Administration',
      dateOfJoining: '2024-01-08',
      dateOfExit: null,
      employed: true,
      monthlyGross: '19800.00',
      pfCovered: true,
      esiApplicable: true,
    },
    {
      id: 'ee000003-1111-4111-8111-aaaaaaaaaaaa',
      employeeCode: 'EMP-011',
      name: 'Suresh Patil',
      designation: 'Senior technician',
      department: 'Installation',
      dateOfJoining: '2021-06-01',
      dateOfExit: '2026-05-31',
      employed: false,
      monthlyGross: '32600.00',
      pfCovered: false,
      esiApplicable: false,
    },
  ],
  nextCursor: null,
  currentCount: 2,
  currentMonthlyGross: '88000.00',
};

const PAYROLL_LINES = [
  {
    id: 'll000001-1111-4111-8111-aaaaaaaaaaaa',
    employeeId: 'ee000001-1111-4111-8111-aaaaaaaaaaaa',
    employeeCode: 'EMP-001',
    employeeName: 'Anita Deshmukh',
    calendarDays: 31,
    lopDays: '0.00',
    paidDays: '31.00',
    basic: '34100.00',
    dearnessAllowance: '0.00',
    houseRentAllowance: '17050.00',
    otherAllowances: '17050.00',
    grossEarnings: '68200.00',
    pfWages: '15000.00',
    epfEmployee: '1800.00',
    epfEmployer: '550.00',
    epsEmployer: '1250.00',
    esiCovered: false,
    esiEmployee: '0.00',
    esiEmployer: '0.00',
    professionalTax: '200.00',
    taxRegime: 'new' as const,
    projectedAnnualIncome: '818400.00',
    projectedAnnualTax: '18408.00',
    tds: '1534.00',
    netPay: '64666.00',
    paymentRequestId: 'pr000001-1111-4111-8111-aaaaaaaaaaaa',
    paymentRequestNumber: 'PR/2026-27/007',
    paymentRequestStatus: 'submitted',
  },
  {
    id: 'll000002-1111-4111-8111-aaaaaaaaaaaa',
    employeeId: 'ee000002-1111-4111-8111-aaaaaaaaaaaa',
    employeeCode: 'EMP-005',
    employeeName: 'Kavita More',
    calendarDays: 31,
    /* A loss of pay, so the warning-toned attendance line is on screen
       rather than only its neutral sibling. */
    lopDays: '2.00',
    paidDays: '29.00',
    basic: '9261.29',
    dearnessAllowance: '0.00',
    houseRentAllowance: '4630.65',
    otherAllowances: '4630.65',
    grossEarnings: '18522.59',
    pfWages: '9261.29',
    epfEmployee: '1111.00',
    epfEmployer: '340.00',
    epsEmployer: '771.00',
    esiCovered: true,
    esiEmployee: '139.00',
    esiEmployer: '603.00',
    professionalTax: '0.00',
    taxRegime: 'new' as const,
    projectedAnnualIncome: '222271.08',
    projectedAnnualTax: '0.00',
    tds: '0.00',
    netPay: '17272.59',
    paymentRequestId: 'pr000002-1111-4111-8111-aaaaaaaaaaaa',
    paymentRequestNumber: 'PR/2026-27/008',
    paymentRequestStatus: 'submitted',
  },
];

const PAYROLL_RUN = {
  run: {
    id: 'rr000001-1111-4111-8111-aaaaaaaaaaaa',
    runNumber: 'PAY/2026-27/001',
    periodMonth: '2026-07-01',
    status: 'finalized' as const,
    calculatedAt: '2026-08-01T06:30:00.000Z',
    finalizedAt: '2026-08-01T07:00:00.000Z',
    cancelledAt: null,
    cancelReason: null,
    employeeCount: 2,
    totalGross: '86722.59',
    totalNet: '81938.59',
    lines: PAYROLL_LINES,
    totalEpfEmployee: '2911.00',
    totalEpfEmployer: '890.00',
    totalEpsEmployer: '2021.00',
    totalEsiEmployee: '139.00',
    totalEsiEmployer: '603.00',
    totalProfessionalTax: '200.00',
    totalTds: '1534.00',
    statutoryBasis: [
      {
        parameter: 'epf_employee_percent',
        value: '12.0000',
        effectiveFrom: '2014-09-01',
        notification: "Paragraph 29, Employees' Provident Funds Scheme, 1952",
      },
      {
        parameter: 'esi_employee_percent',
        value: '0.7500',
        effectiveFrom: '2019-07-01',
        notification: 'G.S.R. 423(E) dated 13 June 2019, effective 1 July 2019',
      },
    ],
  },
};

const PAYROLL_RUN_LIST = {
  runs: [
    {
      id: PAYROLL_RUN.run.id,
      runNumber: PAYROLL_RUN.run.runNumber,
      periodMonth: PAYROLL_RUN.run.periodMonth,
      status: PAYROLL_RUN.run.status,
      calculatedAt: PAYROLL_RUN.run.calculatedAt,
      finalizedAt: PAYROLL_RUN.run.finalizedAt,
      cancelledAt: null,
      cancelReason: null,
      employeeCount: PAYROLL_RUN.run.employeeCount,
      totalGross: PAYROLL_RUN.run.totalGross,
      totalNet: PAYROLL_RUN.run.totalNet,
    },
  ],
  nextCursor: null,
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
  // The correspondence register (migration 0086). The thread-options
  // route is registered first for the reason the tender pair below
  // states: Playwright matches the LAST registered handler, so the
  // register's own pattern would otherwise swallow it.
  await page.route('**/api/correspondence/thread-options', (route) =>
    route.fulfill(json({ letters: [] })),
  );
  await page.route('**/api/correspondence?*', (route) =>
    route.fulfill(json(CORRESPONDENCE_REGISTER)),
  );
  await page.route('**/api/correspondence', (route) =>
    route.fulfill(json(CORRESPONDENCE_REGISTER)),
  );
  // The tender pipeline (migration 0083). The detail route is registered
  // first because Playwright matches the LAST registered handler, so the
  // bare-register pattern would otherwise swallow the one with an id.
  await page.route('**/api/tenders/*', (route) => route.fulfill(json(TENDER_DETAIL)));
  await page.route('**/api/tenders', (route) => route.fulfill(json(TENDER_LIST)));
  // People and payroll (0089, 0090). The run detail is registered BEFORE
  // the bare register, for the reason the production routes above give.
  await page.route('**/api/payroll-runs/*', (route) =>
    route.fulfill(json(PAYROLL_RUN)),
  );
  await page.route('**/api/payroll-runs*', (route) =>
    route.fulfill(json(PAYROLL_RUN_LIST)),
  );
  // Honours the `status` query the register sends: the default view
  // (`current`) hides the one employee who has left, and ticking "Include
  // people who have left" (`all`) shows them — so the "Left" chip and the
  // toggle actually exercise the path rather than always rendering.
  await page.route('**/api/employees*', async (route) => {
    const status = new URL(route.request().url()).searchParams.get('status');
    const current = EMPLOYEE_REGISTER.employees.filter((employee) => employee.employed);
    const employees = status === 'all' ? EMPLOYEE_REGISTER.employees : current;
    await route.fulfill(
      json({
        ...EMPLOYEE_REGISTER,
        employees,
      }),
    );
  });
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
  /* The stock ledger (0087). The shortage screen also reads the contacts
     master for its vendor picker, and the handler below answers that with
     an empty list — so the picker renders its "Select a vendor" option and
     the primary action stays correctly disabled, which is the state the
     scan has to check the contrast of. */
  await page.route('**/api/signing-requests*', (route) =>
    route.fulfill(json(SIGNING_QUEUE)),
  );
  /* The platform controls (0096). The entitlements list is DRIVEN by the
     product declaration rather than by rows, so the fixture answers with
     both flags — one configured and off, one untouched — because the two
     render different sentences and the scan should see both. */
  await page.route('**/api/platform/entitlements*', (route) =>
    route.fulfill(json(PLATFORM_ENTITLEMENTS)),
  );
  await page.route('**/api/platform/job-schedules*', (route) =>
    route.fulfill(json(PLATFORM_SCHEDULES)),
  );
  await page.route('**/api/platform/exports*', (route) =>
    route.fulfill(json(PLATFORM_EXPORTS)),
  );
  // Notifications (0092). Four registers, four handlers. Playwright
  // matches the LAST registered pattern, so a broader one added after
  // these would swallow them; the three hyphenated paths are registered
  // ahead of the bare `notifications` one, and the order is kept explicit
  // rather than relied on, because the paths only happen not to overlap.
  await page.route('**/api/notification-channels*', (route) =>
    route.fulfill(json(NOTIFICATION_CHANNELS)),
  );
  await page.route('**/api/notification-templates*', (route) =>
    route.fulfill(json(NOTIFICATION_TEMPLATES)),
  );
  await page.route('**/api/notification-consents*', (route) =>
    route.fulfill(json(NOTIFICATION_CONSENTS)),
  );
  await page.route('**/api/notifications*', (route) =>
    route.fulfill(json(NOTIFICATION_MESSAGES)),
  );
  /* Spreadsheet imports (0094). The LIST is registered first and the
     per-batch read second, because Playwright matches the LAST handler
     that matches — the same ordering trap the correspondence routes
     above carry a note about. */
  await page.route('**/api/imports*', (route) => route.fulfill(json(IMPORT_BATCHES)));
  await page.route('**/api/imports/00000000-0000-4000-8000-*', (route) =>
    route.fulfill(json(IMPORT_BATCH_DETAIL)),
  );
  // The audit register and the management summary (0095). The two audit
  // patterns do not overlap: a Playwright glob's star does not cross a
  // slash, so the bare audit-events pattern answers the register and the
  // workbook and never the facets route beneath it.
  await page.route('**/api/audit-events/facets*', (route) =>
    route.fulfill(json(AUDIT_FACETS)),
  );
  await page.route('**/api/audit-events*', (route) =>
    route.fulfill(json(AUDIT_REGISTER)),
  );
  await page.route('**/api/mis/summary*', (route) => route.fulfill(json(MIS_SUMMARY)));
  /* The defect liability period (0099): the cross-Work register, and the
     Work-scoped read the Instruments tab makes.

     The second is a RegExp rather than a glob, and deliberately. The
     obvious glob — works, a wildcard segment, then `warranty` with a
     trailing wildcard — also swallows the `warranty-terms` PUT beside
     it and answers a term save with a card payload, which is a fixture
     that makes a broken save look like a working one. The pattern below
     ends at the path, or at its query string, and nowhere else. */
  await page.route('**/api/warranties*', (route) =>
    route.fulfill(json(WARRANTY_REGISTER)),
  );
  await page.route(/\/api\/works\/[^/]+\/warranty(\?|$)/, (route) =>
    route.fulfill(json(WORK_WARRANTY)),
  );
  await page.route('**/api/purchase-orders*', (route) =>
    route.fulfill(json(PURCHASE_ORDER_REGISTER)),
  );
  // The historical Zoho Books register (0115). The trailing star also
  // covers the `?work=` deep link the Work's Bills tab follows; the
  // import lane below it is a POST that no scan makes.
  await page.route('**/api/imported-invoices*', (route) =>
    route.fulfill(json(IMPORTED_INVOICE_REGISTER)),
  );
  // The Tally ledger census (0118). The import lane beside it is a POST
  // that no scan makes.
  await page.route('**/api/tally-masters/ledgers*', (route) =>
    route.fulfill(json(TALLY_LEDGER_CENSUS)),
  );
  await page.route('**/api/stock/items*', (route) =>
    route.fulfill(json(STOCK_REGISTER)),
  );
  await page.route('**/api/stock/movements*', (route) =>
    route.fulfill(json(STOCK_MOVEMENTS)),
  );
  await page.route('**/api/stock/production-receipts*', (route) =>
    route.fulfill(json(STOCK_PENDING_RECEIPTS)),
  );
  await page.route('**/api/stock/shortages*', (route) =>
    route.fulfill(json(STOCK_SHORTAGES)),
  );
  /* Maintenance (0088). The detail route is registered BEFORE the bare
     register for the reason the production handlers above give:
     Playwright matches the last registered handler, so a bare pattern
     would swallow the one carrying an id. */
  await page.route('**/api/maintenance/*', (route) =>
    route.fulfill(json(MAINTENANCE_DETAIL)),
  );
  await page.route('**/api/maintenance*', (route) =>
    route.fulfill(json(MAINTENANCE_LIST)),
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
