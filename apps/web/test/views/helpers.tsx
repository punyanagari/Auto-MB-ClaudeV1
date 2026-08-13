// @vitest-environment jsdom
/** Shared fixtures and the stub API client for the per-view test files.
 * Importing this module also registers the shared afterEach cleanup
 * (React tree + location.hash) for the importing file. */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type {
  ChallanDetailResponse,
  EwayBill,
  Membership,
  PurchaseOrder,
  PurchaseOrderDetailResponse,
} from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';

afterEach(() => {
  cleanup();
  // The workspace serializes its view into location.hash (finding 28);
  // clear it so one test's navigation cannot become the next test's
  // restored deep link.
  window.history.replaceState(null, '', window.location.pathname);
});

/** A create-and-record form sits behind a Disclosure labelled with the
 * verb on its own submit button, so a detail page reads as records first
 * and asks a question only when the operator asks. Open the panel before
 * touching the fields — they are unmounted until then. */
export async function openForm(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: label, expanded: false }));
}

/** With the panel open, two buttons carry the same name: the disclosure,
 * which has aria-expanded, and the form's submit button, which does not. */
export function submitButton(label: string): HTMLElement {
  const [button] = screen
    .getAllByRole('button', { name: label })
    .filter((candidate) => !candidate.hasAttribute('aria-expanded'));
  if (button === undefined) throw new Error(`No submit button named "${label}".`);
  return button;
}

export function stubApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    me: vi.fn().mockResolvedValue(null),
    signUp: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue({ twoFactorRequired: false }),
    signOut: vi.fn().mockResolvedValue(undefined),
    verifyTotp: vi.fn().mockResolvedValue(undefined),
    verifyBackupCode: vi.fn().mockResolvedValue(undefined),
    enableTwoFactor: vi.fn(),
    disableTwoFactor: vi.fn().mockResolvedValue(undefined),
    regenerateBackupCodes: vi.fn(),
    listOrganisations: vi.fn().mockResolvedValue([]),
    createOrganisation: vi.fn(),
    listMembers: vi.fn().mockResolvedValue([]),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    memberAssignments: vi.fn().mockResolvedValue({ userId: 'u', workIds: [] }),
    setMemberAssignments: vi.fn(),
    listLoaDocuments: vi.fn().mockResolvedValue([]),
    getLoaDocument: vi.fn(),
    uploadLoa: vi.fn(),
    uploadContractSource: vi.fn(),
    getLoaContractSourceContext: vi.fn().mockResolvedValue({
      documents: [],
      paymentMatrix: [],
      periods: [],
      releaseClauses: [],
      itemSpecifications: [],
    }),
    getWorkContractSourceContext: vi.fn().mockResolvedValue({
      documents: [],
      paymentMatrix: [],
      periods: [],
      releaseClauses: [],
      itemSpecifications: [],
    }),
    downloadContractSourceFile: vi.fn().mockResolvedValue(new Blob()),
    confirmLoa: vi.fn(),
    listWorks: vi.fn().mockResolvedValue([]),
    getWork: vi.fn(),
    workBalance: vi.fn(),
    listChallans: vi.fn().mockResolvedValue([]),
    getChallan: vi.fn(),
    createChallan: vi.fn(),
    updateChallan: vi.fn(),
    deleteChallan: vi.fn(),
    issueChallan: vi.fn(),
    cancelChallan: vi.fn(),
    renderChallan: vi.fn(),
    uploadSignedCopy: vi.fn(),
    downloadChallanPdf: vi.fn(),
    listIssueChallans: vi.fn().mockResolvedValue([]),
    getIssueChallan: vi.fn(),
    createIssueChallan: vi.fn(),
    updateIssueChallan: vi.fn(),
    deleteIssueChallan: vi.fn(),
    issueIssueChallan: vi.fn(),
    cancelIssueChallan: vi.fn(),
    renderIssueChallan: vi.fn(),
    uploadIssueChallanSignedCopy: vi.fn(),
    downloadIssueChallanPdf: vi.fn(),
    dashboard: vi.fn(),
    // Complete GST facts by default, so the billing-readiness panel
    // reads "ready" unless a test arranges otherwise.
    organisationProfile: vi.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Sharma Constructions',
      slug: 'sharma',
      address: '1 Depot Road, Jhansi',
      gstin: '09AAACS1111A1Z5',
      contactPhone: null,
      contactEmail: null,
      hasLogo: false,
      stateCode: '09',
      pincode: '284001',
      locality: 'Jhansi',
      tradeName: null,
      msmeNumber: null,
      invoiceNumberPrefix: null,
      invoiceNotes: null,
      warrantyTemplateText: null,
    }),
    updateOrganisationProfile: vi.fn(),
    uploadLogo: vi.fn(),
    removeLogo: vi.fn().mockResolvedValue(undefined),
    logoBlob: vi.fn().mockResolvedValue(null),
    getReceipt: vi.fn().mockResolvedValue(null),
    recordReceipt: vi.fn(),
    recordSerials: vi.fn(),
    recordInstallation: vi.fn(),
    listWorkSerials: vi.fn().mockResolvedValue([]),
    deleteSerial: vi.fn().mockResolvedValue(undefined),
    searchSerials: vi.fn().mockResolvedValue({ matches: [], truncated: false }),
    updateWorkItemSerials: vi.fn(),
    listInstruments: vi.fn().mockResolvedValue([]),
    createInstrument: vi.fn(),
    updateInstrument: vi.fn(),
    listMbEntries: vi.fn().mockResolvedValue([]),
    recordMbEntry: vi.fn(),
    listBills: vi.fn().mockResolvedValue([]),
    setBillStatus: vi.fn(),
    workTimeline: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
    entityTimeline: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
    listContacts: vi.fn().mockResolvedValue([]),
    saveContact: vi.fn(),
    setContactActive: vi.fn(),
    listWorkConsignees: vi.fn().mockResolvedValue([]),
    linkWorkConsignee: vi.fn(),
    unlinkWorkConsignee: vi.fn(),
    listLocationMasters: vi.fn().mockResolvedValue([]),
    saveLocationMaster: vi.fn(),
    setLocationMasterActive: vi.fn(),
    listUnitMasters: vi.fn().mockResolvedValue([]),
    saveUnitMaster: vi.fn(),
    setUnitMasterActive: vi.fn(),
    listSignatories: vi.fn().mockResolvedValue([]),
    saveSignatory: vi.fn(),
    setSignatoryActive: vi.fn(),
    listGstRates: vi.fn().mockResolvedValue([]),
    createGstRate: vi.fn(),
    endDateGstRate: vi.fn(),
    getWorkCompletion: vi.fn().mockResolvedValue({
      completion: { originalCompletionDate: null, currentCompletionDate: null },
      extensionRequests: [],
    }),
    setCompletionDate: vi.fn(),
    createExtensionRequest: vi.fn(),
    updateExtensionRequest: vi.fn(),
    deleteExtensionRequest: vi.fn().mockResolvedValue(undefined),
    finaliseExtensionRequest: vi.fn(),
    renderExtensionRequest: vi.fn(),
    uploadExtensionResponse: vi.fn(),
    respondExtensionRequest: vi.fn(),
    downloadExtensionPdf: vi.fn(),
    downloadExtensionDraftPreview: vi.fn(),
    backfillExtensionRequest: vi.fn(),
    listApprovals: vi.fn().mockResolvedValue([]),
    listWorkAmendments: vi.fn().mockResolvedValue([]),
    proposeAmendment: vi.fn(),
    proposeAddItem: vi.fn(),
    proposeItemRemoval: vi.fn(),
    approveAmendment: vi.fn(),
    rejectAmendment: vi.fn(),
    withdrawAmendment: vi.fn(),
    setWorkSettings: vi.fn(),
    listWorkInstallations: vi
      .fn()
      .mockResolvedValue({ installations: [], itemSummaries: [] }),
    recordWorkInstallation: vi.fn(),
    cancelWorkInstallation: vi.fn(),
    challanCorrectionEligibility: vi.fn().mockResolvedValue({
      challanId: '44444444-4444-4444-8444-444444444444',
      status: 'issued',
      evidence: { receipts: 0, serials: 0, measurements: 0 },
      path: 'cancel_replace',
      pendingRequestId: null,
    }),
    proposeChallanCancelReplace: vi.fn(),
    proposeIssueChallanCancelReplace: vi.fn(),
    proposeChallanCorrectionNotice: vi.fn(),
    listWorkCorrectionNotices: vi.fn().mockResolvedValue([]),
    listChallanCorrectionNotices: vi.fn().mockResolvedValue([]),
    getCorrectionNotice: vi.fn(),
    renderCorrectionNotice: vi.fn(),
    cancelCorrectionNotice: vi.fn(),
    downloadCorrectionNoticePdf: vi.fn(),
    getPaymentMatrix: vi.fn().mockResolvedValue([]),
    upsertPaymentMatrixRow: vi.fn(),
    deletePaymentMatrixRow: vi.fn().mockResolvedValue(undefined),
    setWorkItemPaymentCategory: vi.fn(),
    listWorkPacCertificates: vi
      .fn()
      .mockResolvedValue({ certificates: [], itemSummaries: [] }),
    recordWorkPacCertificate: vi.fn(),
    cancelPacCertificate: vi.fn(),
    uploadPacCertificateDocument: vi.fn(),
    downloadPacCertificateDocument: vi.fn(),
    listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [] }),
    createWorkMeasurementBook: vi.fn(),
    getMeasurementBook: vi.fn(),
    setMeasurementBookSources: vi.fn(),
    finalizeMeasurementBook: vi.fn(),
    cancelMeasurementBook: vi.fn(),
    deleteMeasurementBook: vi.fn().mockResolvedValue(undefined),
    prepareBillFromMeasurementBook: vi.fn(),
    renderMeasurementBook: vi.fn(),
    downloadMeasurementBookPdf: vi.fn(),
    downloadMeasurementBookDraftPreview: vi.fn(),
    mergeWorkMeasurementBooks: vi.fn(),
    unmergeMeasurementBook: vi.fn().mockResolvedValue(undefined),
    completeWork: vi.fn(),
    reopenWork: vi.fn(),
    // Ready by default, so a test that does not care about completion sees
    // the form it always saw.
    workCompletionReadiness: vi
      .fn()
      .mockResolvedValue({ ready: true, unfinished: [], blockers: [] }),
    listWorkPurchaseOrders: vi.fn().mockResolvedValue([]),
    createWorkPurchaseOrder: vi.fn(),
    getPurchaseOrder: vi.fn(),
    updatePurchaseOrder: vi.fn(),
    savePurchaseOrderLines: vi.fn(),
    issuePurchaseOrder: vi.fn(),
    cancelPurchaseOrder: vi.fn(),
    closePurchaseOrder: vi.fn(),
    deletePurchaseOrder: vi.fn().mockResolvedValue(undefined),
    listBudgetaryQuotations: vi.fn().mockResolvedValue([]),
    createBudgetaryQuotation: vi.fn(),
    getBudgetaryQuotation: vi.fn(),
    updateBudgetaryQuotation: vi.fn(),
    saveBudgetaryQuotationLines: vi.fn(),
    issueBudgetaryQuotation: vi.fn(),
    setBudgetaryQuotationOutcome: vi.fn(),
    deleteBudgetaryQuotation: vi.fn().mockResolvedValue(undefined),
    listWorkTaxInvoices: vi.fn().mockResolvedValue([]),
    createWorkTaxInvoice: vi.fn(),
    getTaxInvoice: vi.fn(),
    updateTaxInvoice: vi.fn(),
    submitTaxInvoice: vi.fn(),
    renderTaxInvoice: vi.fn(),
    downloadTaxInvoicePdf: vi.fn(),
    cancelTaxInvoice: vi.fn(),
    deleteTaxInvoice: vi.fn().mockResolvedValue(undefined),
    taxInvoiceIrpPayload: vi.fn(),
    recordTaxInvoiceIrpResponse: vi.fn(),
    listCreditNotes: vi.fn().mockResolvedValue([]),
    listInvoiceCreditNotes: vi.fn().mockResolvedValue([]),
    createCreditNote: vi.fn(),
    getCreditNote: vi.fn(),
    updateCreditNote: vi.fn(),
    deleteCreditNote: vi.fn(),
    issueCreditNote: vi.fn(),
    cancelCreditNote: vi.fn(),
    updateCreditNoteRecipientItc: vi.fn(),
    registerCreditNoteIrp: vi.fn(),
    recoverCreditNoteProviderOperation: vi.fn(),
    cancelCreditNoteIrp: vi.fn(),
    creditNoteIrpPayload: vi.fn(),
    renderCreditNote: vi.fn(),
    downloadCreditNotePdf: vi.fn(),
    registerTaxInvoiceIrp: vi.fn(),
    recoverTaxInvoiceProviderOperation: vi.fn(),
    cancelTaxInvoiceIrp: vi.fn(),
    recordTaxInvoiceIrpCancellation: vi.fn(),
    listInvoiceEwayBills: vi.fn().mockResolvedValue([]),
    createInvoiceEwayBill: vi.fn(),
    getEwayBill: vi.fn(),
    updateEwayBill: vi.fn(),
    ewayBillNicPayload: vi.fn(),
    generateEwayBill: vi.fn(),
    cancelEwayBillAtProvider: vi.fn(),
    recoverEwayBillProviderOperation: vi.fn(),
    recordEwayBillCancellation: vi.fn(),
    recordEwayBillNicResponse: vi.fn(),
    cancelEwayBill: vi.fn(),
    deleteEwayBill: vi.fn().mockResolvedValue(undefined),
    listNumberSeries: vi.fn().mockResolvedValue([]),
    setNumberSeries: vi.fn(),
    clearNumberSeries: vi.fn(),
    createDirectTaxInvoice: vi.fn(),
    setWorkItemTaxFacts: vi.fn(),
    ...overrides,
  };
}

export const ORG_ID = '11111111-1111-4111-8111-111111111111';
export const DOC_ID = '22222222-2222-4222-8222-222222222222';
export const WORK_ID = '33333333-3333-4333-8333-333333333333';

export const REVIEW_PAYLOAD = {
  sourceText: 'RAW LETTER TEXT',
  review: {
    header: {
      letterNumber: {
        value: 'L-42/2025',
        raw: 'Letter No: L-42/2025',
        needsReview: false,
      },
      letterDate: { value: '2025-06-01', raw: 'Dated: 01/06/2025', needsReview: false },
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
        needsReview: false,
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
};

export const REVIEW_DOCUMENT = {
  id: DOC_ID,
  originalFilename: 'loa-letter.pdf',
  sha256: 'a'.repeat(64),
  sizeBytes: 1234,
  extractionStatus: 'review' as const,
  confirmedWorkId: null,
  createdAt: '2026-08-08T00:00:00.000Z',
  extractionPayload: REVIEW_PAYLOAD,
};

export function membership(overrides: Partial<Membership>): Membership {
  return {
    organisationId: ORG_ID,
    userId: 'user-a',
    role: 'owner',
    workScope: 'all',
    canIssueDocuments: true,
    canCancelDocuments: true,
    canApproveAmendments: false,
    twoFactorEnabled: false,
    status: 'active',
    ...overrides,
  };
}

export const CHALLAN_ID = '44444444-4444-4444-8444-444444444444';
export const ITEM_A = '55555555-5555-4555-8555-555555555555';

export const BALANCE = {
  allowExcessDelivery: false,
  today: '2026-08-11',
  items: [
    {
      workItemId: ITEM_A,
      itemNumber: 'A/1',
      description: 'Main switchboard',
      unitCode: 'Nos',
      awardedQuantity: '5.000',
      deliveredQuantity: '3.000',
      remainingQuantity: '2.000',
      effectiveRate: '100.00',
    },
  ],
};

export function challanDetail(
  overrides: Partial<ChallanDetailResponse['challan']> = {},
): ChallanDetailResponse {
  return {
    challan: {
      id: CHALLAN_ID,
      workId: WORK_ID,
      status: 'draft',
      challanDate: '2026-08-08',
      challanNumber: null,
      sequenceNumber: null,
      prefix: 'DC',
      consignee: { name: 'Sr. DEE (G)', address: 'Delhi Division' },
      templateVersion: null,
      warrantyTemplateVersion: null,
      warrantyTextSha256: null,
      renderedAvailable: false,
      signedCopyAvailable: false,
      cancellationNote: null,
      createdAt: '2026-08-08T00:00:00.000Z',
      issuedAt: null,
      cancelledAt: null,
      ...overrides,
    },
    items: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        workItemId: ITEM_A,
        description: 'Main switchboard',
        unit: 'Nos',
        quantity: '2.000',
        rate: '100.00',
        lineAmount: '200.00',
        position: 1,
      },
    ],
    issuedSnapshot: null,
  };
}

/** The Work behind the challan fixture. ChallanDetail reads it on a DRAFT
 * to learn which lines are flagged for serial traceability — the challan
 * line itself does not carry the flag. */
export function challanWork(requiresSerials = false) {
  const scheduleId = '77777777-7777-4777-8777-777777777777';
  return {
    work: {
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
    },
    schedules: [
      {
        id: scheduleId,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [
          {
            id: ITEM_A,
            scheduleId,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
            requiresSerials,
          },
        ],
      },
    ],
  };
}

/** The two consignee fields the server requires beside the items; a save
 * test has to satisfy them before it can reach the rule under test. */
export function fillConsignee() {
  fireEvent.change(screen.getByLabelText('Consignee name'), {
    target: { value: 'Sr. DEE (G)' },
  });
  fireEvent.change(screen.getByLabelText('Consignee address'), {
    target: { value: 'Delhi Division' },
  });
}

export async function openWorkTab(label: string) {
  // Scoped to the tab strip: the Overview summary offers a button per area
  // too, and both carry the same label.
  const tabs = await screen.findByRole('navigation', { name: 'Work sections' });
  fireEvent.click(
    within(tabs).getByRole('button', {
      name: (accessibleName: string) => accessibleName.startsWith(label),
    }),
  );
}

export const VENDOR_CONTACT_ID = 'dddd1111-1111-4111-8111-dddddddddd11';
export const PO_ID = 'dddd2222-2222-4222-8222-dddddddddd22';
export const PO_LINE_ID = 'dddd3333-3333-4333-8333-dddddddddd33';

export const VENDOR_CONTACT = {
  id: VENDOR_CONTACT_ID,
  designation: 'Sharma Electricals',
  contactPerson: null,
  address: 'Karol Bagh, Delhi',
  phone: null,
  email: null,
  gstin: null,
  pincode: null,
  stateCode: null,
  isConsignee: false,
  isVendor: true,
  isClient: false,
  active: true,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export function purchaseOrder(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: PO_ID,
    workId: WORK_ID,
    vendorContactId: VENDOR_CONTACT_ID,
    vendorDesignation: 'Sharma Electricals',
    status: 'issued',
    poNumber: 'DCW-1-PO-01',
    sequenceNumber: 1,
    poDate: '2026-08-01',
    expectedOn: null,
    terms: null,
    totalAmount: '400.00',
    cancellationNote: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    issuedAt: '2026-08-01T10:00:00.000Z',
    closedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

/** The issued order's detail: one line against A/1, nothing received yet. */
export function purchaseOrderDetail(): PurchaseOrderDetailResponse {
  return {
    purchaseOrder: purchaseOrder(),
    lines: [
      {
        id: PO_LINE_ID,
        workItemId: ITEM_A,
        lineNumber: 1,
        description: 'Main switchboard',
        hsnCode: null,
        unitCode: 'Nos',
        quantity: '4.000',
        rate: '100.00',
        gstRate: null,
        lineAmount: '400.00',
        receivedQuantity: '0.000',
        pendingQuantity: '4.000',
      },
    ],
    vendorSnapshot: null,
    previewTotal: '400.00',
  };
}

export const CLIENT_CONTACT_ID = 'eeee1111-1111-4111-8111-eeeeeeeeee11';
export const TAX_INVOICE_ID = 'eeee2222-2222-4222-8222-eeeeeeeeee22';
export const BILLABLE_MB_ID = 'eeee3333-3333-4333-8333-eeeeeeeeee33';

export const CLIENT_CONTACT = {
  id: CLIENT_CONTACT_ID,
  designation: 'Central Railway Mumbai Division',
  contactPerson: null,
  address: 'Mumbai 400001',
  phone: null,
  email: null,
  gstin: '27AAAGM0289C2ZI',
  pincode: '400001',
  stateCode: '27',
  isConsignee: false,
  isVendor: false,
  isClient: true,
  active: true,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export function billableBook(overrides: Record<string, unknown> = {}) {
  return {
    id: BILLABLE_MB_ID,
    workId: WORK_ID,
    status: 'finalized',
    kind: 'on_account',
    isFinal: false,
    consigneeContactId: null,
    mbDate: '2026-07-30',
    mbNumber: 'DCW-1-MB-01',
    sequenceNumber: 1,
    totalAmount: '4226994.01',
    ...overrides,
  };
}

export function taxInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: TAX_INVOICE_ID,
    workId: WORK_ID,
    measurementBookId: BILLABLE_MB_ID,
    statedTaxableValue: null,
    mbNumber: 'DCW-1-MB-01',
    status: 'draft',
    invoiceNumber: null,
    sequenceNumber: null,
    fyLabel: null,
    invoiceDate: '2026-07-30',
    sacCode: '998734',
    serviceDescription: 'Provision of passenger amenity services.',
    gstRate: '18',
    placeOfSupply: '27',
    reverseChargeApplicable: null,
    buyerContactId: CLIENT_CONTACT_ID,
    taxableValue: null,
    cgstAmount: null,
    sgstAmount: null,
    igstAmount: null,
    totalAmount: null,
    roundOff: null,
    customerPoReference: null,
    unitLabel: null,
    notes: null,
    shipToContactId: null,
    numberPrefix: null,
    irn: null,
    irpProvider: null,
    irpProviderState: 'not_requested',
    ackNumber: null,
    ackDate: null,
    ackDateText: null,
    signedInvoiceAvailable: false,
    renderedAvailable: false,
    irpLegacyEvidenceMissing: false,
    irpCancelledAt: null,
    irpCancelledAtText: null,
    irpCancelReasonCode: null,
    irpCancelRemark: null,
    irpReportingDeadline: null,
    irpReportingOverdue: false,
    cancellationNote: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    submittedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

export const SUBMITTED_INVOICE = taxInvoice({
  status: 'submitted',
  invoiceNumber: 'TI/2026-27/001',
  sequenceNumber: 1,
  fyLabel: '2026-27',
  reverseChargeApplicable: false,
  taxableValue: '4226994.01',
  cgstAmount: '380429.46',
  sgstAmount: '380429.46',
  igstAmount: '0.00',
  totalAmount: '4987852.93',
  submittedAt: '2026-07-30T06:39:00.000Z',
});

export function ewayBill(overrides: Partial<EwayBill> = {}): EwayBill {
  return {
    id: 'eeee7777-7777-4777-8777-eeeeeeeeee77',
    taxInvoiceId: TAX_INVOICE_ID,
    invoiceNumber: 'TI/2026-27/001',
    status: 'draft',
    transportMode: 'road',
    transporterId: null,
    transporterName: null,
    vehicleNumber: 'MH01AB1234',
    transportDocNumber: null,
    transportDocDate: null,
    distanceKm: 120,
    fromPincode: '411023',
    toPincode: '400001',
    ewbNumber: null,
    provider: 'whitebooks',
    providerState: 'generation_unknown',
    ewbDate: null,
    validUntil: null,
    ewbDateText: null,
    validUntilText: null,
    legacyEvidenceMissing: false,
    providerCancelledAt: null,
    providerCancelledAtText: null,
    providerCancelReasonCode: null,
    providerCancelRemark: null,
    cancellationNote: null,
    createdAt: '2026-07-30T07:00:00.000Z',
    generatedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}
