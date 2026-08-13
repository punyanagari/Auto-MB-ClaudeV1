// @vitest-environment jsdom
/** Shared fixtures and the stub API client for the per-view test files.
 * Importing this module also registers the shared afterEach cleanup
 * (React tree + location.hash) for the importing file. */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type {
  ChallanDetailResponse,
  Contact,
  EwayBill,
  LoaDocumentDetail,
  MeasurementBook,
  Membership,
  PurchaseOrder,
  PurchaseOrderDetailResponse,
  TaxInvoice,
  WorkBalanceResponse,
  WorkDetailResponse,
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
    me: vi.fn<ApiClient['me']>().mockResolvedValue(null),
    signUp: vi.fn<ApiClient['signUp']>().mockResolvedValue(undefined),
    signIn: vi
      .fn<ApiClient['signIn']>()
      .mockResolvedValue({ twoFactorRequired: false }),
    signOut: vi.fn<ApiClient['signOut']>().mockResolvedValue(undefined),
    requestPasswordReset: vi
      .fn<ApiClient['requestPasswordReset']>()
      .mockResolvedValue(undefined),
    resetPassword: vi.fn<ApiClient['resetPassword']>().mockResolvedValue(undefined),
    verifyTotp: vi.fn<ApiClient['verifyTotp']>().mockResolvedValue(undefined),
    verifyBackupCode: vi
      .fn<ApiClient['verifyBackupCode']>()
      .mockResolvedValue(undefined),
    enableTwoFactor: vi.fn<ApiClient['enableTwoFactor']>(),
    disableTwoFactor: vi
      .fn<ApiClient['disableTwoFactor']>()
      .mockResolvedValue(undefined),
    regenerateBackupCodes: vi.fn<ApiClient['regenerateBackupCodes']>(),
    listOrganisations: vi.fn<ApiClient['listOrganisations']>().mockResolvedValue([]),
    createOrganisation: vi.fn<ApiClient['createOrganisation']>(),
    listMembers: vi.fn<ApiClient['listMembers']>().mockResolvedValue([]),
    addMember: vi.fn<ApiClient['addMember']>(),
    updateMember: vi.fn<ApiClient['updateMember']>(),
    memberAssignments: vi
      .fn<ApiClient['memberAssignments']>()
      .mockResolvedValue({ userId: 'u', workIds: [] }),
    setMemberAssignments: vi.fn<ApiClient['setMemberAssignments']>(),
    listLoaDocuments: vi.fn<ApiClient['listLoaDocuments']>().mockResolvedValue([]),
    discardLoaDocument: vi.fn<ApiClient['discardLoaDocument']>(),
    discardContractSourceDocument: vi.fn<ApiClient['discardContractSourceDocument']>(),
    getLoaDocument: vi.fn<ApiClient['getLoaDocument']>(),
    uploadLoa: vi.fn<ApiClient['uploadLoa']>(),
    uploadContractSource: vi.fn<ApiClient['uploadContractSource']>(),
    getLoaContractSourceContext: vi
      .fn<ApiClient['getLoaContractSourceContext']>()
      .mockResolvedValue({
        documents: [],
        paymentMatrix: [],
        periods: [],
        releaseClauses: [],
        itemSpecifications: [],
      }),
    getWorkContractSourceContext: vi
      .fn<ApiClient['getWorkContractSourceContext']>()
      .mockResolvedValue({
        documents: [],
        paymentMatrix: [],
        periods: [],
        releaseClauses: [],
        itemSpecifications: [],
      }),
    downloadContractSourceFile: vi
      .fn<ApiClient['downloadContractSourceFile']>()
      .mockResolvedValue(new Blob()),
    confirmLoa: vi.fn<ApiClient['confirmLoa']>(),
    listWorks: vi.fn<ApiClient['listWorks']>().mockResolvedValue([]),
    getWork: vi.fn<ApiClient['getWork']>(),
    workBalance: vi.fn<ApiClient['workBalance']>(),
    listChallans: vi.fn<ApiClient['listChallans']>().mockResolvedValue([]),
    listDeliveryChallans: vi
      .fn<ApiClient['listDeliveryChallans']>()
      .mockResolvedValue([]),
    createStandaloneChallan: vi.fn<ApiClient['createStandaloneChallan']>(),
    updateStandaloneChallan: vi.fn<ApiClient['updateStandaloneChallan']>(),
    getChallan: vi.fn<ApiClient['getChallan']>(),
    createChallan: vi.fn<ApiClient['createChallan']>(),
    updateChallan: vi.fn<ApiClient['updateChallan']>(),
    deleteChallan: vi.fn<ApiClient['deleteChallan']>(),
    issueChallan: vi.fn<ApiClient['issueChallan']>(),
    cancelChallan: vi.fn<ApiClient['cancelChallan']>(),
    renderChallan: vi.fn<ApiClient['renderChallan']>(),
    uploadSignedCopy: vi.fn<ApiClient['uploadSignedCopy']>(),
    downloadChallanPdf: vi.fn<ApiClient['downloadChallanPdf']>(),
    listIssueChallans: vi.fn<ApiClient['listIssueChallans']>().mockResolvedValue([]),
    getIssueChallan: vi.fn<ApiClient['getIssueChallan']>(),
    createIssueChallan: vi.fn<ApiClient['createIssueChallan']>(),
    updateIssueChallan: vi.fn<ApiClient['updateIssueChallan']>(),
    deleteIssueChallan: vi.fn<ApiClient['deleteIssueChallan']>(),
    issueIssueChallan: vi.fn<ApiClient['issueIssueChallan']>(),
    cancelIssueChallan: vi.fn<ApiClient['cancelIssueChallan']>(),
    renderIssueChallan: vi.fn<ApiClient['renderIssueChallan']>(),
    uploadIssueChallanSignedCopy: vi.fn<ApiClient['uploadIssueChallanSignedCopy']>(),
    downloadIssueChallanPdf: vi.fn<ApiClient['downloadIssueChallanPdf']>(),
    dashboard: vi.fn<ApiClient['dashboard']>(),
    // Complete GST facts by default, so the billing-readiness panel
    // reads "ready" unless a test arranges otherwise.
    organisationProfile: vi.fn<ApiClient['organisationProfile']>().mockResolvedValue({
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
    updateOrganisationProfile: vi.fn<ApiClient['updateOrganisationProfile']>(),
    uploadLogo: vi.fn<ApiClient['uploadLogo']>(),
    removeLogo: vi.fn<ApiClient['removeLogo']>().mockResolvedValue(undefined),
    logoBlob: vi.fn<ApiClient['logoBlob']>().mockResolvedValue(null),
    getReceipt: vi.fn<ApiClient['getReceipt']>().mockResolvedValue(null),
    recordReceipt: vi.fn<ApiClient['recordReceipt']>(),
    recordSerials: vi.fn<ApiClient['recordSerials']>(),
    recordInstallation: vi.fn<ApiClient['recordInstallation']>(),
    listWorkSerials: vi.fn<ApiClient['listWorkSerials']>().mockResolvedValue([]),
    deleteSerial: vi.fn<ApiClient['deleteSerial']>().mockResolvedValue(undefined),
    searchSerials: vi
      .fn<ApiClient['searchSerials']>()
      .mockResolvedValue({ matches: [], truncated: false }),
    search: vi
      .fn<ApiClient['search']>()
      .mockResolvedValue({ query: '', groups: [], returned: 0 }),
    updateWorkItemSerials: vi.fn<ApiClient['updateWorkItemSerials']>(),
    listInstruments: vi.fn<ApiClient['listInstruments']>().mockResolvedValue([]),
    createInstrument: vi.fn<ApiClient['createInstrument']>(),
    updateInstrument: vi.fn<ApiClient['updateInstrument']>(),
    listMbEntries: vi.fn<ApiClient['listMbEntries']>().mockResolvedValue([]),
    recordMbEntry: vi.fn<ApiClient['recordMbEntry']>(),
    listBills: vi.fn<ApiClient['listBills']>().mockResolvedValue([]),
    setBillStatus: vi.fn<ApiClient['setBillStatus']>(),
    workTimeline: vi
      .fn<ApiClient['workTimeline']>()
      .mockResolvedValue({ events: [], nextCursor: null }),
    entityTimeline: vi
      .fn<ApiClient['entityTimeline']>()
      .mockResolvedValue({ events: [], nextCursor: null }),
    listContacts: vi.fn<ApiClient['listContacts']>().mockResolvedValue([]),
    saveContact: vi.fn<ApiClient['saveContact']>(),
    setContactActive: vi.fn<ApiClient['setContactActive']>(),
    listWorkConsignees: vi.fn<ApiClient['listWorkConsignees']>().mockResolvedValue([]),
    linkWorkConsignee: vi.fn<ApiClient['linkWorkConsignee']>(),
    unlinkWorkConsignee: vi.fn<ApiClient['unlinkWorkConsignee']>(),
    listLocationMasters: vi
      .fn<ApiClient['listLocationMasters']>()
      .mockResolvedValue([]),
    saveLocationMaster: vi.fn<ApiClient['saveLocationMaster']>(),
    setLocationMasterActive: vi.fn<ApiClient['setLocationMasterActive']>(),
    listUnitMasters: vi.fn<ApiClient['listUnitMasters']>().mockResolvedValue([]),
    saveUnitMaster: vi.fn<ApiClient['saveUnitMaster']>(),
    setUnitMasterActive: vi.fn<ApiClient['setUnitMasterActive']>(),
    listSignatories: vi.fn<ApiClient['listSignatories']>().mockResolvedValue([]),
    saveSignatory: vi.fn<ApiClient['saveSignatory']>(),
    setSignatoryActive: vi.fn<ApiClient['setSignatoryActive']>(),
    listGstRates: vi.fn<ApiClient['listGstRates']>().mockResolvedValue([]),
    createGstRate: vi.fn<ApiClient['createGstRate']>(),
    endDateGstRate: vi.fn<ApiClient['endDateGstRate']>(),
    getWorkCompletion: vi.fn<ApiClient['getWorkCompletion']>().mockResolvedValue({
      completion: { originalCompletionDate: null, currentCompletionDate: null },
      extensionRequests: [],
    }),
    setCompletionDate: vi.fn<ApiClient['setCompletionDate']>(),
    createExtensionRequest: vi.fn<ApiClient['createExtensionRequest']>(),
    updateExtensionRequest: vi.fn<ApiClient['updateExtensionRequest']>(),
    deleteExtensionRequest: vi
      .fn<ApiClient['deleteExtensionRequest']>()
      .mockResolvedValue(undefined),
    finaliseExtensionRequest: vi.fn<ApiClient['finaliseExtensionRequest']>(),
    renderExtensionRequest: vi.fn<ApiClient['renderExtensionRequest']>(),
    uploadExtensionResponse: vi.fn<ApiClient['uploadExtensionResponse']>(),
    respondExtensionRequest: vi.fn<ApiClient['respondExtensionRequest']>(),
    downloadExtensionPdf: vi.fn<ApiClient['downloadExtensionPdf']>(),
    downloadExtensionDraftPreview: vi.fn<ApiClient['downloadExtensionDraftPreview']>(),
    backfillExtensionRequest: vi.fn<ApiClient['backfillExtensionRequest']>(),
    listApprovals: vi.fn<ApiClient['listApprovals']>().mockResolvedValue([]),
    listWorkAmendments: vi.fn<ApiClient['listWorkAmendments']>().mockResolvedValue([]),
    proposeAmendment: vi.fn<ApiClient['proposeAmendment']>(),
    proposeAddItem: vi.fn<ApiClient['proposeAddItem']>(),
    proposeItemRemoval: vi.fn<ApiClient['proposeItemRemoval']>(),
    attachVariationOrder: vi.fn<ApiClient['attachVariationOrder']>(),
    downloadVariationOrderFile: vi.fn<ApiClient['downloadVariationOrderFile']>(),
    approveAmendment: vi.fn<ApiClient['approveAmendment']>(),
    rejectAmendment: vi.fn<ApiClient['rejectAmendment']>(),
    withdrawAmendment: vi.fn<ApiClient['withdrawAmendment']>(),
    setWorkSettings: vi.fn<ApiClient['setWorkSettings']>(),
    listWorkInstallations: vi
      .fn<ApiClient['listWorkInstallations']>()
      .mockResolvedValue({ installations: [], itemSummaries: [], nextCursor: null }),
    recordWorkInstallation: vi.fn<ApiClient['recordWorkInstallation']>(),
    cancelWorkInstallation: vi.fn<ApiClient['cancelWorkInstallation']>(),
    challanCorrectionEligibility: vi
      .fn<ApiClient['challanCorrectionEligibility']>()
      .mockResolvedValue({
        challanId: '44444444-4444-4444-8444-444444444444',
        status: 'issued',
        evidence: { receipts: 0, serials: 0, measurements: 0 },
        path: 'cancel_replace',
        pendingRequestId: null,
      }),
    proposeChallanCancelReplace: vi.fn<ApiClient['proposeChallanCancelReplace']>(),
    proposeIssueChallanCancelReplace:
      vi.fn<ApiClient['proposeIssueChallanCancelReplace']>(),
    proposeChallanCorrectionNotice:
      vi.fn<ApiClient['proposeChallanCorrectionNotice']>(),
    listWorkCorrectionNotices: vi
      .fn<ApiClient['listWorkCorrectionNotices']>()
      .mockResolvedValue([]),
    listChallanCorrectionNotices: vi
      .fn<ApiClient['listChallanCorrectionNotices']>()
      .mockResolvedValue([]),
    getCorrectionNotice: vi.fn<ApiClient['getCorrectionNotice']>(),
    renderCorrectionNotice: vi.fn<ApiClient['renderCorrectionNotice']>(),
    cancelCorrectionNotice: vi.fn<ApiClient['cancelCorrectionNotice']>(),
    downloadCorrectionNoticePdf: vi.fn<ApiClient['downloadCorrectionNoticePdf']>(),
    getPaymentMatrix: vi.fn<ApiClient['getPaymentMatrix']>().mockResolvedValue([]),
    upsertPaymentMatrixRow: vi.fn<ApiClient['upsertPaymentMatrixRow']>(),
    deletePaymentMatrixRow: vi
      .fn<ApiClient['deletePaymentMatrixRow']>()
      .mockResolvedValue(undefined),
    setWorkItemPaymentCategory: vi.fn<ApiClient['setWorkItemPaymentCategory']>(),
    listWorkPacCertificates: vi
      .fn<ApiClient['listWorkPacCertificates']>()
      .mockResolvedValue({ certificates: [], itemSummaries: [] }),
    recordWorkPacCertificate: vi.fn<ApiClient['recordWorkPacCertificate']>(),
    cancelPacCertificate: vi.fn<ApiClient['cancelPacCertificate']>(),
    uploadPacCertificateDocument: vi.fn<ApiClient['uploadPacCertificateDocument']>(),
    downloadPacCertificateDocument:
      vi.fn<ApiClient['downloadPacCertificateDocument']>(),
    listWorkMeasurementBooks: vi
      .fn<ApiClient['listWorkMeasurementBooks']>()
      .mockResolvedValue({ books: [] }),
    createWorkMeasurementBook: vi.fn<ApiClient['createWorkMeasurementBook']>(),
    getMeasurementBook: vi.fn<ApiClient['getMeasurementBook']>(),
    setMeasurementBookSources: vi.fn<ApiClient['setMeasurementBookSources']>(),
    finalizeMeasurementBook: vi.fn<ApiClient['finalizeMeasurementBook']>(),
    cancelMeasurementBook: vi.fn<ApiClient['cancelMeasurementBook']>(),
    deleteMeasurementBook: vi
      .fn<ApiClient['deleteMeasurementBook']>()
      .mockResolvedValue(undefined),
    prepareBillFromMeasurementBook:
      vi.fn<ApiClient['prepareBillFromMeasurementBook']>(),
    renderMeasurementBook: vi.fn<ApiClient['renderMeasurementBook']>(),
    downloadMeasurementBookPdf: vi.fn<ApiClient['downloadMeasurementBookPdf']>(),
    downloadMeasurementBookDraftPreview:
      vi.fn<ApiClient['downloadMeasurementBookDraftPreview']>(),
    mergeWorkMeasurementBooks: vi.fn<ApiClient['mergeWorkMeasurementBooks']>(),
    unmergeMeasurementBook: vi
      .fn<ApiClient['unmergeMeasurementBook']>()
      .mockResolvedValue(undefined),
    completeWork: vi.fn<ApiClient['completeWork']>(),
    reopenWork: vi.fn<ApiClient['reopenWork']>(),
    // Ready by default, so a test that does not care about completion sees
    // the form it always saw.
    workCompletionReadiness: vi
      .fn<ApiClient['workCompletionReadiness']>()
      .mockResolvedValue({ ready: true, unfinished: [], blockers: [] }),
    listWorkPurchaseOrders: vi
      .fn<ApiClient['listWorkPurchaseOrders']>()
      .mockResolvedValue([]),
    createWorkPurchaseOrder: vi.fn<ApiClient['createWorkPurchaseOrder']>(),
    getPurchaseOrder: vi.fn<ApiClient['getPurchaseOrder']>(),
    updatePurchaseOrder: vi.fn<ApiClient['updatePurchaseOrder']>(),
    savePurchaseOrderLines: vi.fn<ApiClient['savePurchaseOrderLines']>(),
    issuePurchaseOrder: vi.fn<ApiClient['issuePurchaseOrder']>(),
    cancelPurchaseOrder: vi.fn<ApiClient['cancelPurchaseOrder']>(),
    closePurchaseOrder: vi.fn<ApiClient['closePurchaseOrder']>(),
    deletePurchaseOrder: vi
      .fn<ApiClient['deletePurchaseOrder']>()
      .mockResolvedValue(undefined),
    listBudgetaryQuotations: vi
      .fn<ApiClient['listBudgetaryQuotations']>()
      .mockResolvedValue([]),
    createBudgetaryQuotation: vi.fn<ApiClient['createBudgetaryQuotation']>(),
    getBudgetaryQuotation: vi.fn<ApiClient['getBudgetaryQuotation']>(),
    updateBudgetaryQuotation: vi.fn<ApiClient['updateBudgetaryQuotation']>(),
    saveBudgetaryQuotationLines: vi.fn<ApiClient['saveBudgetaryQuotationLines']>(),
    issueBudgetaryQuotation: vi.fn<ApiClient['issueBudgetaryQuotation']>(),
    setBudgetaryQuotationOutcome: vi.fn<ApiClient['setBudgetaryQuotationOutcome']>(),
    deleteBudgetaryQuotation: vi
      .fn<ApiClient['deleteBudgetaryQuotation']>()
      .mockResolvedValue(undefined),
    listWorkTaxInvoices: vi
      .fn<ApiClient['listWorkTaxInvoices']>()
      .mockResolvedValue([]),
    createWorkTaxInvoice: vi.fn<ApiClient['createWorkTaxInvoice']>(),
    getTaxInvoice: vi.fn<ApiClient['getTaxInvoice']>(),
    updateTaxInvoice: vi.fn<ApiClient['updateTaxInvoice']>(),
    submitTaxInvoice: vi.fn<ApiClient['submitTaxInvoice']>(),
    renderTaxInvoice: vi.fn<ApiClient['renderTaxInvoice']>(),
    downloadTaxInvoicePdf: vi.fn<ApiClient['downloadTaxInvoicePdf']>(),
    cancelTaxInvoice: vi.fn<ApiClient['cancelTaxInvoice']>(),
    deleteTaxInvoice: vi
      .fn<ApiClient['deleteTaxInvoice']>()
      .mockResolvedValue(undefined),
    taxInvoiceIrpPayload: vi.fn<ApiClient['taxInvoiceIrpPayload']>(),
    recordTaxInvoiceIrpResponse: vi.fn<ApiClient['recordTaxInvoiceIrpResponse']>(),
    listCreditNotes: vi.fn<ApiClient['listCreditNotes']>().mockResolvedValue([]),
    listInvoiceCreditNotes: vi
      .fn<ApiClient['listInvoiceCreditNotes']>()
      .mockResolvedValue([]),
    createCreditNote: vi.fn<ApiClient['createCreditNote']>(),
    getCreditNote: vi.fn<ApiClient['getCreditNote']>(),
    updateCreditNote: vi.fn<ApiClient['updateCreditNote']>(),
    deleteCreditNote: vi.fn<ApiClient['deleteCreditNote']>(),
    issueCreditNote: vi.fn<ApiClient['issueCreditNote']>(),
    cancelCreditNote: vi.fn<ApiClient['cancelCreditNote']>(),
    updateCreditNoteRecipientItc: vi.fn<ApiClient['updateCreditNoteRecipientItc']>(),
    registerCreditNoteIrp: vi.fn<ApiClient['registerCreditNoteIrp']>(),
    recoverCreditNoteProviderOperation:
      vi.fn<ApiClient['recoverCreditNoteProviderOperation']>(),
    cancelCreditNoteIrp: vi.fn<ApiClient['cancelCreditNoteIrp']>(),
    creditNoteIrpPayload: vi.fn<ApiClient['creditNoteIrpPayload']>(),
    renderCreditNote: vi.fn<ApiClient['renderCreditNote']>(),
    downloadCreditNotePdf: vi.fn<ApiClient['downloadCreditNotePdf']>(),
    registerTaxInvoiceIrp: vi.fn<ApiClient['registerTaxInvoiceIrp']>(),
    recoverTaxInvoiceProviderOperation:
      vi.fn<ApiClient['recoverTaxInvoiceProviderOperation']>(),
    cancelTaxInvoiceIrp: vi.fn<ApiClient['cancelTaxInvoiceIrp']>(),
    recordTaxInvoiceIrpCancellation:
      vi.fn<ApiClient['recordTaxInvoiceIrpCancellation']>(),
    listInvoiceEwayBills: vi
      .fn<ApiClient['listInvoiceEwayBills']>()
      .mockResolvedValue([]),
    createInvoiceEwayBill: vi.fn<ApiClient['createInvoiceEwayBill']>(),
    getEwayBill: vi.fn<ApiClient['getEwayBill']>(),
    updateEwayBill: vi.fn<ApiClient['updateEwayBill']>(),
    ewayBillNicPayload: vi.fn<ApiClient['ewayBillNicPayload']>(),
    generateEwayBill: vi.fn<ApiClient['generateEwayBill']>(),
    cancelEwayBillAtProvider: vi.fn<ApiClient['cancelEwayBillAtProvider']>(),
    recoverEwayBillProviderOperation:
      vi.fn<ApiClient['recoverEwayBillProviderOperation']>(),
    recordEwayBillCancellation: vi.fn<ApiClient['recordEwayBillCancellation']>(),
    recordEwayBillNicResponse: vi.fn<ApiClient['recordEwayBillNicResponse']>(),
    cancelEwayBill: vi.fn<ApiClient['cancelEwayBill']>(),
    deleteEwayBill: vi.fn<ApiClient['deleteEwayBill']>().mockResolvedValue(undefined),
    listNumberSeries: vi.fn<ApiClient['listNumberSeries']>().mockResolvedValue([]),
    setNumberSeries: vi.fn<ApiClient['setNumberSeries']>(),
    clearNumberSeries: vi.fn<ApiClient['clearNumberSeries']>(),
    createDirectTaxInvoice: vi.fn<ApiClient['createDirectTaxInvoice']>(),
    setWorkItemTaxFacts: vi.fn<ApiClient['setWorkItemTaxFacts']>(),
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
    /** One row carrying both halves of the extracted-value lock: its
     * description, quantity and rate are clean extracted truth (read-only
     * on the review screen), while its printed unit resolved to no
     * canonical unit — the one hole the parser itself declares, which the
     * reviewer may fill. */
    items: [
      {
        schedule: { id: 'A' },
        itemSno: '1',
        itemCode: 'S01',
        description: 'Main switchboard, floor mounted',
        descriptionSource: 'raw-exact',
        qty: '2.000',
        qtyUnit: 'Route Kilo Meter (RKM)',
        unitRate: '450.00',
        bidAmount: '900.00',
        reconciliation: { ok: true },
        needsReview: true,
        raw: { anchorLine: '1  S01  Main switchboard ...' },
      },
    ],
    flags: [
      {
        code: 'unresolved_unit',
        scope: 'item',
        targetId: 'A#1',
        message: 'The printed unit could not be resolved.',
        rawBlock: 'Route Kilo Meter (RKM)',
      },
    ],
    needsReview: { total: 1, anyLetterLevel: false },
  },
};

export const REVIEW_DOCUMENT: LoaDocumentDetail = {
  id: DOC_ID,
  originalFilename: 'loa-letter.pdf',
  sha256: 'a'.repeat(64),
  sizeBytes: 1234,
  extractionStatus: 'review' as const,
  confirmedWorkId: null,
  createdAt: '2026-08-08T00:00:00.000Z',
  extractionPayload: REVIEW_PAYLOAD,
  letterNumberMatches: [],
  // The default fixture is a letter that predates verification, so the
  // panel's neutral "not checked" state is what most view tests render;
  // the signature-panel tests supply real verdicts of their own.
  signatureStatus: 'not_checked' as const,
  signatureVerdict: null,
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
    canManageStatutoryReporting: false,
    twoFactorEnabled: false,
    status: 'active',
    ...overrides,
  };
}

export const CHALLAN_ID = '44444444-4444-4444-8444-444444444444';
export const ITEM_A = '55555555-5555-4555-8555-555555555555';

export const BALANCE: WorkBalanceResponse = {
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
      kind: 'work',
      consigneeContactId: null,
      fyLabel: null,
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
export function challanWork(requiresSerials = false): WorkDetailResponse {
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
      // Migration 0062 gives every Work a basis and a rate; the server
      // never sends these absent, so the fixture must not either.
      gstBasis: 'inclusive',
      gstRate: '18.00',
      pbgRequiredAmount: null,
      pbgSubmissionDays: null,
      pbgExtensionDays: null,
      pbgPenalInterestPercent: null,
      status: 'active',
      completedAt: null,
      completedByUserId: null,
      completionNote: null,
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

export const VENDOR_CONTACT: Contact = {
  id: VENDOR_CONTACT_ID,
  designation: 'Sharma Electricals',
  contactPerson: null,
  address: 'Karol Bagh, Delhi',
  phone: null,
  email: null,
  gstin: null,
  pincode: null,
  stateCode: null,
  locality: null,
  divisionCode: null,
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

export const CLIENT_CONTACT: Contact = {
  id: CLIENT_CONTACT_ID,
  designation: 'Central Railway Mumbai Division',
  contactPerson: null,
  address: 'Mumbai 400001',
  phone: null,
  email: null,
  gstin: '27AAAGM0289C2ZI',
  pincode: '400001',
  stateCode: '27',
  locality: 'Mumbai',
  divisionCode: null,
  isConsignee: false,
  isVendor: false,
  isClient: true,
  active: true,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export function billableBook(
  overrides: Partial<MeasurementBook> = {},
): MeasurementBook {
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
    mergedIntoId: null,
    remarkTemplateVersion: null,
    templateVersion: null,
    renderedAvailable: false,
    cancellationNote: null,
    billId: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    finalizedAt: '2026-07-30T06:00:00.000Z',
    cancelledAt: null,
    ...overrides,
  };
}

export function taxInvoice(overrides: Partial<TaxInvoice> = {}): TaxInvoice {
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
    lineShape: 'service_cumulative',
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
    irpCancelWindowClosesAt: null,
    irpCancelWindowOpen: false,
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
