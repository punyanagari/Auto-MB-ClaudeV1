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
  JobCardDetail,
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
export async function openForm(label: string | RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: label, expanded: false }));
}

/**
 * Open one of the Masters categories from its rail.
 *
 * The rail is navigation rather than a tablist (see `views/Masters.tsx`),
 * so each category is a plain button and only the open one is mounted.
 * Masters opens on Items — the first category on the rail, matching the
 * mock — so a test about any other category clicks its way there first,
 * exercising the same control an operator uses.
 */
export function openMastersCategory(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: label }));
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

/** A Work that has measured and billed nothing — the summary the bills
 * read serves beside an empty list. */
export const NO_BILLING = {
  measured: '0.00',
  billed: '0.00',
  unbilled: '0.00',
} as const;

/** One inert job card, so every production mutation stub can answer
 * the shape the view re-renders from. */
const FIXTURE_JOB_CARD: JobCardDetail = {
  id: 'job-card-1',
  number: 'PP-26-001',
  sourceType: 'work',
  sourceReference: 'A2/1',
  workId: null,
  workCode: null,
  customer: 'Fixture customer',
  itemId: 'item-1',
  itemCode: 'FIX-1',
  itemName: 'Fixture board',
  quantity: 1,
  manufactured: 0,
  dispatched: 0,
  materialLines: 0,
  materialShortParts: 0,
  status: 'planned',
  dueDate: '2026-12-31',
  completedOn: null,
  cancellationReason: null,
  materials: [],
  serials: [],
  componentSlots: [],
  dispatches: [],
  dispatchReady: false,
};

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
    /* Resolved rather than bare: the Installations panel reads this for
       the delivered-balance line beside its quantity field, so an
       unresolved stub is an unhandled rejection in every test that
       renders a Work tab rather than a challan editor. Empty items — the
       line simply does not render — which is the same thing a Work with
       no issued challan sees. */
    workBalance: vi.fn<ApiClient['workBalance']>().mockResolvedValue({
      allowExcessDelivery: false,
      today: '2026-08-09',
      items: [],
    }),
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
    listIssueChallanRegister: vi
      .fn<ApiClient['listIssueChallanRegister']>()
      .mockResolvedValue([]),
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
    listBills: vi
      .fn<ApiClient['listBills']>()
      .mockResolvedValue({ bills: [], summary: NO_BILLING }),
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
    saveContactAddress: vi.fn<ApiClient['saveContactAddress']>(),
    setContactAddressActive: vi.fn<ApiClient['setContactAddressActive']>(),
    makeContactAddressPrimary: vi.fn<ApiClient['makeContactAddressPrimary']>(),
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
    listCanonicalItems: vi
      .fn<ApiClient['listCanonicalItems']>()
      .mockResolvedValue({ items: [], unmappedLineCount: 0 }),
    saveCanonicalItem: vi.fn<ApiClient['saveCanonicalItem']>(),
    setCanonicalItemActive: vi.fn<ApiClient['setCanonicalItemActive']>(),
    listOrganisationBankAccounts: vi
      .fn<ApiClient['listOrganisationBankAccounts']>()
      .mockResolvedValue([]),
    createOrganisationBankAccount: vi.fn<ApiClient['createOrganisationBankAccount']>(),
    setOrganisationBankAccountActive:
      vi.fn<ApiClient['setOrganisationBankAccountActive']>(),
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
    listPaymentRequests: vi
      .fn<ApiClient['listPaymentRequests']>()
      .mockResolvedValue({ requests: [] }),
    createPaymentRequest: vi.fn<ApiClient['createPaymentRequest']>(),
    decidePaymentRequest: vi.fn<ApiClient['decidePaymentRequest']>(),
    payPaymentRequest: vi.fn<ApiClient['payPaymentRequest']>(),
    recordAdvanceBills: vi.fn<ApiClient['recordAdvanceBills']>(),
    listVendorInvoices: vi
      .fn<ApiClient['listVendorInvoices']>()
      .mockResolvedValue({ invoices: [], totalOutstanding: '0', overdueCount: 0 }),
    recordVendorInvoice: vi.fn<ApiClient['recordVendorInvoice']>(),
    uploadVendorInvoiceDocument: vi.fn<ApiClient['uploadVendorInvoiceDocument']>(),
    downloadVendorInvoiceDocument: vi.fn<ApiClient['downloadVendorInvoiceDocument']>(),
    previewVendorTds: vi.fn<ApiClient['previewVendorTds']>(),
    recordVendorPayment: vi.fn<ApiClient['recordVendorPayment']>(),
    voidVendorPayment: vi.fn<ApiClient['voidVendorPayment']>(),
    cancelVendorInvoice: vi.fn<ApiClient['cancelVendorInvoice']>(),
    listWorkAmendments: vi.fn<ApiClient['listWorkAmendments']>().mockResolvedValue([]),
    proposeAmendment: vi.fn<ApiClient['proposeAmendment']>(),
    proposeAddItem: vi.fn<ApiClient['proposeAddItem']>(),
    proposeItemRemoval: vi.fn<ApiClient['proposeItemRemoval']>(),
    // Not superseding by default: a Work with a document behind it is the
    // ordinary case, so a test that does not care about the supersede panel
    // never sees it.
    getSupersedeEligibility: vi
      .fn<ApiClient['getSupersedeEligibility']>()
      .mockResolvedValue({
        workId: WORK_ID,
        eligible: false,
        blockers: [{ register: 'delivery_challans', label: 'delivery challans' }],
        loaDocumentId: DOC_ID,
        pendingRequestId: null,
      }),
    proposeWorkSupersede: vi.fn<ApiClient['proposeWorkSupersede']>(),
    getWorkSupersession: vi
      .fn<ApiClient['getWorkSupersession']>()
      .mockResolvedValue(null),
    attachVariationOrder: vi.fn<ApiClient['attachVariationOrder']>(),
    downloadVariationOrderFile: vi.fn<ApiClient['downloadVariationOrderFile']>(),
    approveAmendment: vi.fn<ApiClient['approveAmendment']>(),
    rejectAmendment: vi.fn<ApiClient['rejectAmendment']>(),
    withdrawAmendment: vi.fn<ApiClient['withdrawAmendment']>(),
    setWorkSettings: vi.fn<ApiClient['setWorkSettings']>(),
    listWorkInstallations: vi
      .fn<ApiClient['listWorkInstallations']>()
      .mockResolvedValue({ installations: [], itemSummaries: [], nextCursor: null }),
    listInstallations: vi
      .fn<ApiClient['listInstallations']>()
      .mockResolvedValue({ installations: [], nextCursor: null }),
    recordWorkInstallation: vi.fn<ApiClient['recordWorkInstallation']>(),
    recordWorkInstallations: vi.fn<ApiClient['recordWorkInstallations']>(),
    cancelWorkInstallation: vi.fn<ApiClient['cancelWorkInstallation']>(),
    getWorkWarranty: vi.fn<ApiClient['getWorkWarranty']>().mockResolvedValue({
      terms: null,
      pbgCover: {
        requiredByLetter: false,
        dlpCoverUntil: null,
        instrumentReference: null,
        instrumentExpiresOn: null,
        shortfallDays: null,
      },
      finalBillDate: null,
      candidates: [],
      candidatesTruncated: false,
      warranties: [],
      nextCursor: null,
    }),
    saveWarrantyTerms: vi.fn<ApiClient['saveWarrantyTerms']>(),
    startInstallationWarranty: vi.fn<ApiClient['startInstallationWarranty']>(),
    extendWarranty: vi.fn<ApiClient['extendWarranty']>(),
    closeWarranty: vi.fn<ApiClient['closeWarranty']>(),
    voidWarranty: vi.fn<ApiClient['voidWarranty']>(),
    listWarranties: vi
      .fn<ApiClient['listWarranties']>()
      .mockResolvedValue({ warranties: [], nextCursor: null }),
    listImportedInvoices: vi.fn<ApiClient['listImportedInvoices']>().mockResolvedValue({
      invoices: [],
      nextCursor: null,
      totals: {
        invoiceCount: 0,
        linkedCount: 0,
        totalValue: '0.00',
        tallySourcedCount: 0,
        disputedCount: 0,
        earliestDate: null,
        latestDate: null,
      },
    }),
    readImportedInvoice: vi.fn<ApiClient['readImportedInvoice']>(),
    importZohoInvoices: vi.fn<ApiClient['importZohoInvoices']>(),
    relinkImportedInvoice: vi.fn<ApiClient['relinkImportedInvoice']>(),
    discardImportedInvoice: vi.fn<ApiClient['discardImportedInvoice']>(),
    listTallyLedgers: vi.fn<ApiClient['listTallyLedgers']>().mockResolvedValue({
      ledgers: [],
      nextCursor: null,
      totals: {
        ledgerCount: 0,
        customerCount: 0,
        vendorCount: 0,
        instrumentCount: 0,
        otherCount: 0,
        proposedContactCount: 0,
        unmatchedPartyCount: 0,
        codedCount: 0,
        distinctCodeCount: 0,
        lastImportedAt: null,
        lastFilename: null,
        supersededCount: 0,
      },
    }),
    importTallyMasters: vi.fn<ApiClient['importTallyMasters']>(),
    importTallyInvoices: vi.fn<ApiClient['importTallyInvoices']>(),
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
    saveWorkPaymentSetup: vi
      .fn<ApiClient['saveWorkPaymentSetup']>()
      .mockResolvedValue({ items: [] }),
    listWorkPacCertificates: vi
      .fn<ApiClient['listWorkPacCertificates']>()
      .mockResolvedValue({ certificates: [], itemSummaries: [] }),
    recordWorkPacCertificate: vi.fn<ApiClient['recordWorkPacCertificate']>(),
    cancelPacCertificate: vi.fn<ApiClient['cancelPacCertificate']>(),
    uploadPacCertificateDocument: vi.fn<ApiClient['uploadPacCertificateDocument']>(),
    downloadPacCertificateDocument:
      vi.fn<ApiClient['downloadPacCertificateDocument']>(),
    getAmcCycleProposal: vi
      .fn<ApiClient['getAmcCycleProposal']>()
      .mockResolvedValue({ schedules: [] }),
    setScheduleAmcCycle: vi.fn<ApiClient['setScheduleAmcCycle']>(),
    setMeasurementBookMeasuredQuantities:
      vi.fn<ApiClient['setMeasurementBookMeasuredQuantities']>(),
    listWorkMeasurementBooks: vi
      .fn<ApiClient['listWorkMeasurementBooks']>()
      .mockResolvedValue({ books: [] }),
    createWorkMeasurementBook: vi.fn<ApiClient['createWorkMeasurementBook']>(),
    getMeasurementBook: vi.fn<ApiClient['getMeasurementBook']>(),
    setMeasurementBookSources: vi.fn<ApiClient['setMeasurementBookSources']>(),
    // Resolved rather than bare: the billing-baseline panel loads on
    // every Measurement tab, so a stub that answered `undefined` would
    // fail every Work-page test with a `.then` of undefined rather than
    // with anything about the test's own subject.
    getWorkBillingBaseline: vi
      .fn<ApiClient['getWorkBillingBaseline']>()
      .mockResolvedValue({
        baseline: null,
        openable: true,
        lines: [],
        deductions: [],
        grossBilledToDate: '0.00',
        deductionsTotal: '0.00',
        netReceivable: '0.00',
      }),
    uploadBillingBaselineBill: vi.fn<ApiClient['uploadBillingBaselineBill']>(),
    uploadBillingBaselineMeasurement:
      vi.fn<ApiClient['uploadBillingBaselineMeasurement']>(),
    setBillingBaselineLines: vi.fn<ApiClient['setBillingBaselineLines']>(),
    confirmBillingBaselineLine: vi.fn<ApiClient['confirmBillingBaselineLine']>(),
    lockBillingBaseline: vi.fn<ApiClient['lockBillingBaseline']>(),
    deleteBillingBaseline: vi.fn<ApiClient['deleteBillingBaseline']>(),
    setWorkDeductions: vi.fn<ApiClient['setWorkDeductions']>(),
    setMeasurementBookWay: vi.fn<ApiClient['setMeasurementBookWay']>(),
    finalizeMeasurementBook: vi.fn<ApiClient['finalizeMeasurementBook']>(),
    cancelMeasurementBook: vi.fn<ApiClient['cancelMeasurementBook']>(),
    deleteMeasurementBook: vi
      .fn<ApiClient['deleteMeasurementBook']>()
      .mockResolvedValue(undefined),
    prepareBillFromMeasurementBook:
      vi.fn<ApiClient['prepareBillFromMeasurementBook']>(),
    uploadReceivedRailwayBill: vi.fn<ApiClient['uploadReceivedRailwayBill']>(),
    listReceivedRailwayBills: vi
      .fn<ApiClient['listReceivedRailwayBills']>()
      .mockResolvedValue([]),
    discardReceivedRailwayBill: vi.fn<ApiClient['discardReceivedRailwayBill']>(),
    uploadRailwayMeasurement: vi.fn<ApiClient['uploadRailwayMeasurement']>(),
    getRailwayMeasurement: vi
      .fn<ApiClient['getRailwayMeasurement']>()
      .mockResolvedValue({ measurement: null, discarded: [] }),
    confirmRailwayMeasurementLine: vi.fn<ApiClient['confirmRailwayMeasurementLine']>(),
    discardRailwayMeasurement: vi.fn<ApiClient['discardRailwayMeasurement']>(),
    listBillSettlement: vi.fn<ApiClient['listBillSettlement']>().mockResolvedValue([]),
    listReceivables: vi.fn<ApiClient['listReceivables']>().mockResolvedValue({
      entries: [],
      summary: {
        claimedTotal: '0.00',
        passedTotal: '0.00',
        receivedTotal: '0.00',
        outstandingTotal: '0.00',
      },
    }),
    recordBillPayment: vi.fn<ApiClient['recordBillPayment']>(),
    voidBillPayment: vi.fn<ApiClient['voidBillPayment']>(),
    // Retention and liquidated damages (0098). The read resolves to an
    // empty position rather than being left unresolved: it is fetched by
    // the instruments tab on mount, and a stub that never settles would
    // leave every test of that tab asserting against a skeleton.
    getWorkRetention: vi.fn<ApiClient['getWorkRetention']>().mockResolvedValue({
      position: {
        workId: WORK_ID,
        contractValue: '0.00',
        retentionCeilingAmount: null,
        retentionHeldTotal: '0.00',
        retentionReleasedTotal: '0.00',
        retentionBalance: '0.00',
        ldLeviedTotal: '0.00',
        ldDeductedTotal: '0.00',
        ldOpenAssessments: 0,
      },
      terms: null,
      releases: [],
      assessments: [],
      currentCompletionDate: null,
      instruments: [],
    }),
    saveWorkRetentionTerms: vi.fn<ApiClient['saveWorkRetentionTerms']>(),
    clearWorkRetentionTerms: vi.fn<ApiClient['clearWorkRetentionTerms']>(),
    recordRetentionRelease: vi.fn<ApiClient['recordRetentionRelease']>(),
    voidRetentionRelease: vi.fn<ApiClient['voidRetentionRelease']>(),
    assessLd: vi.fn<ApiClient['assessLd']>(),
    decideLdAssessment: vi.fn<ApiClient['decideLdAssessment']>(),
    closeMeasurementBook: vi.fn<ApiClient['closeMeasurementBook']>(),
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
    listPurchaseOrders: vi
      .fn<ApiClient['listPurchaseOrders']>()
      .mockResolvedValue({ purchaseOrders: [], nextCursor: null }),
    createPurchaseOrder: vi.fn<ApiClient['createPurchaseOrder']>(),
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
    listCorrespondence: vi.fn<ApiClient['listCorrespondence']>().mockResolvedValue({
      entries: [],
      nextCursor: null,
      counts: { outward: 0, inward: 0, extensions: 0, inspection: 0 },
      awaitingExtensionResponses: 0,
    }),
    listCorrespondenceThreadOptions: vi
      .fn<ApiClient['listCorrespondenceThreadOptions']>()
      .mockResolvedValue({ letters: [] }),
    writeOutwardLetter: vi.fn<ApiClient['writeOutwardLetter']>(),
    registerInwardLetter: vi.fn<ApiClient['registerInwardLetter']>(),
    cancelCorrespondenceLetter: vi.fn<ApiClient['cancelCorrespondenceLetter']>(),
    downloadCorrespondenceLetter: vi.fn<ApiClient['downloadCorrespondenceLetter']>(),
    listCompanyDocuments: vi
      .fn<ApiClient['listCompanyDocuments']>()
      .mockResolvedValue({ documents: [], expiryWarningDays: 60 }),
    createCompanyDocument: vi.fn<ApiClient['createCompanyDocument']>(),
    uploadCompanyDocumentVersion: vi.fn<ApiClient['uploadCompanyDocumentVersion']>(),
    archiveCompanyDocument: vi.fn<ApiClient['archiveCompanyDocument']>(),
    downloadCompanyDocumentVersion:
      vi.fn<ApiClient['downloadCompanyDocumentVersion']>(),
    getWorkInspectionConfig: vi
      .fn<ApiClient['getWorkInspectionConfig']>()
      .mockResolvedValue({
        items: [],
        checklists: {
          RDSO: { inherited: true, fields: [] },
          RITES: { inherited: true, fields: [] },
        },
      }),
    saveInspectionClauses: vi.fn<ApiClient['saveInspectionClauses']>(),
    saveInspectionChecklist: vi.fn<ApiClient['saveInspectionChecklist']>(),
    listInspectionCalls: vi
      .fn<ApiClient['listInspectionCalls']>()
      .mockResolvedValue({ calls: [], awaitingCertificate: 0, nextCursor: null }),
    createInspectionCall: vi.fn<ApiClient['createInspectionCall']>(),
    receiveInspectionCallLetter: vi.fn<ApiClient['receiveInspectionCallLetter']>(),
    uploadInspectionEvidence: vi.fn<ApiClient['uploadInspectionEvidence']>(),
    uploadInspectionCertificate: vi.fn<ApiClient['uploadInspectionCertificate']>(),
    closeInspectionCall: vi.fn<ApiClient['closeInspectionCall']>(),
    cancelInspectionCall: vi.fn<ApiClient['cancelInspectionCall']>(),
    downloadInspectionDocument: vi.fn<ApiClient['downloadInspectionDocument']>(),
    uploadTenderNotice: vi.fn<ApiClient['uploadTenderNotice']>(),
    downloadTenderNotice: vi.fn<ApiClient['downloadTenderNotice']>(),
    confirmTenderNotice: vi.fn<ApiClient['confirmTenderNotice']>(),
    // OEM production (migration 0084). The register resolves empty and
    // every mutation answers the same inert card, so a view under test
    // renders its own states rather than the fixture's data.
    listProductionItems: vi
      .fn<ApiClient['listProductionItems']>()
      .mockResolvedValue({ items: [] }),
    saveProductionItem: vi
      .fn<ApiClient['saveProductionItem']>()
      .mockRejectedValue(new Error('not stubbed')),
    setProductionItemActive: vi
      .fn<ApiClient['setProductionItemActive']>()
      .mockRejectedValue(new Error('not stubbed')),
    getProductionBom: vi
      .fn<ApiClient['getProductionBom']>()
      .mockResolvedValue({ nodes: [], truncated: false }),
    addProductionBomLine: vi
      .fn<ApiClient['addProductionBomLine']>()
      .mockResolvedValue({ nodes: [], truncated: false }),
    updateProductionBomLine: vi
      .fn<ApiClient['updateProductionBomLine']>()
      .mockResolvedValue({ nodes: [], truncated: false }),
    removeProductionBomLine: vi
      .fn<ApiClient['removeProductionBomLine']>()
      .mockResolvedValue({ nodes: [], truncated: false }),
    listJobCards: vi.fn<ApiClient['listJobCards']>().mockResolvedValue({
      jobCards: [],
      nextCursor: null,
      openCount: 0,
      inProductionCount: 0,
      dispatchReadyCount: 0,
    }),
    getJobCard: vi.fn<ApiClient['getJobCard']>().mockResolvedValue(FIXTURE_JOB_CARD),
    createJobCard: vi
      .fn<ApiClient['createJobCard']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    updateJobCard: vi
      .fn<ApiClient['updateJobCard']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    completeJobCard: vi
      .fn<ApiClient['completeJobCard']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    cancelJobCard: vi
      .fn<ApiClient['cancelJobCard']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    recordProductionSerial: vi
      .fn<ApiClient['recordProductionSerial']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    removeProductionSerial: vi
      .fn<ApiClient['removeProductionSerial']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    recordComponentSerial: vi
      .fn<ApiClient['recordComponentSerial']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    removeComponentSerial: vi
      .fn<ApiClient['removeComponentSerial']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    createProductionDispatch: vi
      .fn<ApiClient['createProductionDispatch']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    withdrawProductionDispatch: vi
      .fn<ApiClient['withdrawProductionDispatch']>()
      .mockResolvedValue(FIXTURE_JOB_CARD),
    listTenders: vi.fn<ApiClient['listTenders']>().mockResolvedValue({ tenders: [] }),
    getTender: vi.fn<ApiClient['getTender']>(),
    updateTenderStatus: vi.fn<ApiClient['updateTenderStatus']>(),
    addTenderChecklistItem: vi.fn<ApiClient['addTenderChecklistItem']>(),
    attachTenderChecklistDocument: vi.fn<ApiClient['attachTenderChecklistDocument']>(),
    removeTenderChecklistItem: vi.fn<ApiClient['removeTenderChecklistItem']>(),
    linkTenderAwardLetter: vi.fn<ApiClient['linkTenderAwardLetter']>(),
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
    listTaxInvoices: vi
      .fn<ApiClient['listTaxInvoices']>()
      .mockResolvedValue({ invoices: [], nextCursor: null }),
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
    listChallanEwayBills: vi
      .fn<ApiClient['listChallanEwayBills']>()
      .mockResolvedValue([]),
    createChallanEwayBill: vi.fn<ApiClient['createChallanEwayBill']>(),
    renderEwayBill: vi.fn<ApiClient['renderEwayBill']>(),
    downloadEwayBillPdf: vi.fn<ApiClient['downloadEwayBillPdf']>(),
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
    // The stock ledger (0087). The three reads answer empty by default so
    // a view that opens them renders its own empty state rather than
    // hanging on an unresolved mock.
    listStockItems: vi.fn<ApiClient['listStockItems']>().mockResolvedValue({
      items: [],
      nextCursor: null,
      summary: { partsTracked: 0, partsBelowReorderLevel: 0, partsShort: 0 },
    }),
    setStockReorderLevel: vi.fn<ApiClient['setStockReorderLevel']>(),
    listStockMovements: vi
      .fn<ApiClient['listStockMovements']>()
      .mockResolvedValue({ movements: [], nextCursor: null }),
    postStockMovement: vi.fn<ApiClient['postStockMovement']>(),
    listPendingProductionReceipts: vi
      .fn<ApiClient['listPendingProductionReceipts']>()
      .mockResolvedValue({ dispatches: [] }),
    recordProductionReceipt: vi.fn<ApiClient['recordProductionReceipt']>(),
    listStockShortages: vi.fn<ApiClient['listStockShortages']>().mockResolvedValue({
      shortages: [],
      purchaseOrders: [],
      purchaseOrdersTruncated: false,
    }),
    createShortagePurchaseOrder: vi.fn<ApiClient['createShortagePurchaseOrder']>(),
    // The signing queue (0091). The one read answers empty by default,
    // for the same reason the stock reads do.
    listSigningRequests: vi.fn<ApiClient['listSigningRequests']>().mockResolvedValue({
      requests: [],
      nextCursor: null,
      agents: [],
    }),
    createSigningRequest: vi.fn<ApiClient['createSigningRequest']>(),
    downloadSignedPdf: vi.fn<ApiClient['downloadSignedPdf']>(),
    cancelSigningRequest: vi.fn<ApiClient['cancelSigningRequest']>(),
    registerSigningAgent: vi.fn<ApiClient['registerSigningAgent']>(),
    revokeSigningAgent: vi.fn<ApiClient['revokeSigningAgent']>(),
    listEmployees: vi.fn<ApiClient['listEmployees']>().mockResolvedValue({
      employees: [],
      nextCursor: null,
      currentCount: 0,
      currentMonthlyGross: '0',
    }),
    getEmployee: vi.fn<ApiClient['getEmployee']>(),
    createEmployee: vi.fn<ApiClient['createEmployee']>(),
    updateEmployee: vi.fn<ApiClient['updateEmployee']>(),
    listPayrollRuns: vi
      .fn<ApiClient['listPayrollRuns']>()
      .mockResolvedValue({ runs: [], nextCursor: null }),
    getPayrollRun: vi.fn<ApiClient['getPayrollRun']>(),
    openPayrollRun: vi.fn<ApiClient['openPayrollRun']>(),
    calculatePayrollRun: vi.fn<ApiClient['calculatePayrollRun']>(),
    setPayrollLineLossOfPay: vi.fn<ApiClient['setPayrollLineLossOfPay']>(),
    finalizePayrollRun: vi.fn<ApiClient['finalizePayrollRun']>(),
    cancelPayrollRun: vi.fn<ApiClient['cancelPayrollRun']>(),
    listNotificationChannels: vi
      .fn<ApiClient['listNotificationChannels']>()
      .mockResolvedValue({ channels: [] }),
    saveNotificationChannel: vi.fn<ApiClient['saveNotificationChannel']>(),
    listNotificationTemplates: vi
      .fn<ApiClient['listNotificationTemplates']>()
      .mockResolvedValue({ templates: [], nextCursor: null }),
    createNotificationTemplate: vi.fn<ApiClient['createNotificationTemplate']>(),
    setNotificationTemplateStatus: vi.fn<ApiClient['setNotificationTemplateStatus']>(),
    listNotificationConsents: vi
      .fn<ApiClient['listNotificationConsents']>()
      .mockResolvedValue({ consents: [], nextCursor: null }),
    recordNotificationConsent: vi.fn<ApiClient['recordNotificationConsent']>(),
    recordStaffNotificationConsents:
      vi.fn<ApiClient['recordStaffNotificationConsents']>(),
    listNotifications: vi
      .fn<ApiClient['listNotifications']>()
      .mockResolvedValue({ messages: [], nextCursor: null }),
    sendNotification: vi.fn<ApiClient['sendNotification']>(),
    // Spreadsheet imports (0094). Empty batches by default, for the same
    // reason the signing read above answers empty — but the TARGETS are
    // never empty, because they are a property of the build rather than
    // of the organisation, and a screen that offered no register to
    // import into would be untestable in exactly the state a new
    // organisation is in.
    listImportBatches: vi.fn<ApiClient['listImportBatches']>().mockResolvedValue({
      batches: [],
      nextCursor: null,
      targets: [
        {
          key: 'contacts',
          label: 'Contacts',
          columns: [
            {
              key: 'designation',
              header: 'Designation',
              required: true,
              note: 'Required. The office or firm as it is written on the paperwork.',
            },
          ],
        },
      ],
    }),
    readImportBatch: vi.fn<ApiClient['readImportBatch']>(),
    uploadImportWorkbook: vi.fn<ApiClient['uploadImportWorkbook']>(),
    commitImportBatch: vi.fn<ApiClient['commitImportBatch']>(),
    cancelImportBatch: vi.fn<ApiClient['cancelImportBatch']>(),
    downloadImportTemplate: vi.fn<ApiClient['downloadImportTemplate']>(),
    auditRegister: vi.fn<ApiClient['auditRegister']>().mockResolvedValue({
      events: [],
      nextCursor: null,
      windowFrom: '2018-08-19',
      retentionMonths: 96,
    }),
    auditFacets: vi
      .fn<ApiClient['auditFacets']>()
      .mockResolvedValue({ actions: [], entityTypes: [], actors: [] }),
    misSummary: vi.fn<ApiClient['misSummary']>().mockResolvedValue({
      outputTax: [],
      receivablesAgeing: [],
      indeterminateBills: 0,
      payrollCost: null,
    }),
    downloadRegisterWorkbook: vi.fn<ApiClient['downloadRegisterWorkbook']>(),
    downloadAuditWorkbook: vi.fn<ApiClient['downloadAuditWorkbook']>(),
    downloadTallyExport: vi.fn<ApiClient['downloadTallyExport']>(),
    // The platform controls (0096). Both lists answer empty by default,
    // for the reason the stock reads below do: a view that opens one
    // renders its own empty state rather than hanging on an unresolved
    // mock.
    listEntitlements: vi
      .fn<ApiClient['listEntitlements']>()
      .mockResolvedValue({ entitlements: [] }),
    setEntitlement: vi.fn<ApiClient['setEntitlement']>(),
    listJobSchedules: vi
      .fn<ApiClient['listJobSchedules']>()
      .mockResolvedValue({ schedules: [], runs: [] }),
    setJobSchedule: vi.fn<ApiClient['setJobSchedule']>(),
    listOrganisationExports: vi
      .fn<ApiClient['listOrganisationExports']>()
      .mockResolvedValue({ exports: [], retentionHours: 720 }),
    requestOrganisationExport: vi.fn<ApiClient['requestOrganisationExport']>(),
    downloadOrganisationExport: vi.fn<ApiClient['downloadOrganisationExport']>(),
    // Maintenance (0088). The register answers empty by default, for the
    // reason the stock reads above do: a view that opens it renders its
    // own empty state rather than hanging on an unresolved mock.
    listMaintenanceRequests: vi
      .fn<ApiClient['listMaintenanceRequests']>()
      .mockResolvedValue({
        requests: [],
        nextCursor: null,
        counts: {
          awaitingApproval: 0,
          approved: 0,
          partiallyDispatched: 0,
          closed: 0,
        },
      }),
    getMaintenanceRequest: vi.fn<ApiClient['getMaintenanceRequest']>(),
    createMaintenanceRequest: vi.fn<ApiClient['createMaintenanceRequest']>(),
    approveMaintenanceRequest: vi.fn<ApiClient['approveMaintenanceRequest']>(),
    recordMaintenanceDispatch: vi.fn<ApiClient['recordMaintenanceDispatch']>(),
    receiveMaintenanceReturn: vi.fn<ApiClient['receiveMaintenanceReturn']>(),
    cancelMaintenanceLine: vi.fn<ApiClient['cancelMaintenanceLine']>(),
    closeMaintenanceRequest: vi.fn<ApiClient['closeMaintenanceRequest']>(),
    ...overrides,
  };
}

export const ORG_ID = '11111111-1111-4111-8111-111111111111';
export const DOC_ID = '22222222-2222-4222-8222-222222222222';
export const WORK_ID = '33333333-3333-4333-8333-333333333333';
export const TENDER_ID = '44444444-4444-4444-8444-444444444444';

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
    canManagePayments: false,
    canSignDocuments: false,
    canManagePayroll: true,
    canManageNotifications: true,
    canImportData: true,
    canViewAuditTrail: true,
    canManageEntitlements: true,
    canExportOrg: true,
    canManageRetention: true,
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
    measurementBookCount: 0,
    taxInvoiceCount: 0,
    historicalInvoiceCount: 0,
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
        amcBillingPeriods: null,
        amcCycleNoun: null,
        items: [
          {
            id: ITEM_A,
            scheduleId,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
            // The residual category, matching the UNCATEGORISED matrix
            // row the readiness tests configure. Since migration 0105 an
            // absent category means NOT SELECTED, which is its own
            // unmet prerequisite.
            paymentCategory: 'UNCATEGORISED',
            requiresSerials,
          },
        ],
      },
    ],
    // The Work read carries the Installations tab's tally, so the Work
    // page never asks the serial-expanded list for a badge.
    installationCounts: { recorded: 0, cancelled: 0 },
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
  isEmployee: false,
  pan: null,
  active: true,
  createdAt: '2026-07-01T00:00:00.000Z',
};

export function purchaseOrder(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: PO_ID,
    workId: WORK_ID,
    workCode: 'DCW-1',
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
    lineCount: 1,
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
        productionItemId: null,
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
  isEmployee: false,
  pan: null,
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
    way: 'coefficient',
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
    closedAt: null,
    closedByReceivedBillId: null,
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
