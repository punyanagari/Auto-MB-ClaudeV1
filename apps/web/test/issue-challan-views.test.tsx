// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  IssueChallanDetailResponse,
  SaveIssueChallanRequest,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../src/api.js';
import { NO_BILLING } from './views/helpers.js';
import { IssueChallanDetail } from '../src/views/IssueChallanDetail.js';
import { IssueChallanEditor } from '../src/views/IssueChallanEditor.js';
import { WorkDetail } from '../src/views/WorkDetail.js';

afterEach(() => {
  cleanup();
  // The workspace serializes its view into location.hash (finding 28);
  // clear it so one test's navigation cannot leak into the next.
  window.history.replaceState(null, '', window.location.pathname);
});

/** A create-and-record form sits behind a Disclosure labelled with the
 * verb on its own submit button, so a detail page reads as records first
 * and asks a question only when the operator asks. Open the panel before
 * touching the fields — they are unmounted until then. */
async function openForm(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: label, expanded: false }));
}

/** With the panel open, two buttons carry the same name: the disclosure,
 * which has aria-expanded, and the form's submit button, which does not. */
function submitButton(label: string): HTMLElement {
  const [button] = screen
    .getAllByRole('button', { name: label })
    .filter((candidate) => !candidate.hasAttribute('aria-expanded'));
  if (button === undefined) throw new Error(`No submit button named "${label}".`);
  return button;
}

function stubApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    me: vi.fn().mockResolvedValue(null),
    signUp: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue({ twoFactorRequired: false }),
    signOut: vi.fn().mockResolvedValue(undefined),
    requestPasswordReset: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue(undefined),
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
    discardLoaDocument: vi.fn(),
    discardContractSourceDocument: vi.fn(),
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
    listDeliveryChallans: vi.fn().mockResolvedValue([]),
    createStandaloneChallan: vi.fn(),
    updateStandaloneChallan: vi.fn(),
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
    listIssueChallanRegister: vi.fn().mockResolvedValue([]),
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
    organisationProfile: vi.fn(),
    updateOrganisationProfile: vi.fn(),
    uploadLogo: vi.fn(),
    removeLogo: vi.fn().mockResolvedValue(undefined),
    logoBlob: vi.fn().mockResolvedValue(null),
    getReceipt: vi.fn().mockResolvedValue(null),
    recordReceipt: vi.fn(),
    recordSerials: vi.fn(),
    recordInstallation: vi.fn(),
    listWorkSerials: vi.fn().mockResolvedValue([]),
    listInstruments: vi.fn().mockResolvedValue([]),
    createInstrument: vi.fn(),
    updateInstrument: vi.fn(),
    listMbEntries: vi.fn().mockResolvedValue([]),
    recordMbEntry: vi.fn(),
    listBills: vi.fn().mockResolvedValue({ bills: [], summary: NO_BILLING }),
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
    listCanonicalItems: vi.fn().mockResolvedValue({ items: [], unmappedLineCount: 0 }),
    saveCanonicalItem: vi.fn(),
    setCanonicalItemActive: vi.fn(),
    listOrganisationBankAccounts: vi.fn().mockResolvedValue([]),
    createOrganisationBankAccount: vi.fn(),
    setOrganisationBankAccountActive: vi.fn(),
    listGstRates: vi.fn().mockResolvedValue([]),
    createGstRate: vi.fn(),
    endDateGstRate: vi.fn(),
    saveSignatory: vi.fn(),
    setSignatoryActive: vi.fn(),
    getWorkCompletion: vi.fn().mockResolvedValue({
      completion: { originalCompletionDate: null, currentCompletionDate: null },
      extensionRequests: [],
    }),
    setCompletionDate: vi.fn(),
    createExtensionRequest: vi.fn(),
    updateExtensionRequest: vi.fn(),
    deleteExtensionRequest: vi.fn(),
    finaliseExtensionRequest: vi.fn(),
    renderExtensionRequest: vi.fn(),
    uploadExtensionResponse: vi.fn(),
    respondExtensionRequest: vi.fn(),
    downloadExtensionPdf: vi.fn(),
    downloadExtensionDraftPreview: vi.fn(),
    backfillExtensionRequest: vi.fn(),
    listApprovals: vi.fn().mockResolvedValue([]),
    listPaymentRequests: vi.fn().mockResolvedValue({ requests: [] }),
    createPaymentRequest: vi.fn(),
    decidePaymentRequest: vi.fn(),
    payPaymentRequest: vi.fn(),
    recordAdvanceBills: vi.fn(),
    listVendorInvoices: vi
      .fn()
      .mockResolvedValue({ invoices: [], totalOutstanding: '0', overdueCount: 0 }),
    recordVendorInvoice: vi.fn(),
    previewVendorTds: vi.fn(),
    recordVendorPayment: vi.fn(),
    voidVendorPayment: vi.fn(),
    cancelVendorInvoice: vi.fn(),
    listWorkAmendments: vi.fn().mockResolvedValue([]),
    proposeAmendment: vi.fn(),
    proposeAddItem: vi.fn(),
    proposeItemRemoval: vi.fn(),
    getSupersedeEligibility: vi.fn().mockResolvedValue({
      workId: WORK_ID,
      eligible: false,
      blockers: [{ register: 'delivery_challans', label: 'delivery challans' }],
      loaDocumentId: null,
      pendingRequestId: null,
    }),
    proposeWorkSupersede: vi.fn(),
    getWorkSupersession: vi.fn().mockResolvedValue(null),
    attachVariationOrder: vi.fn(),
    downloadVariationOrderFile: vi.fn(),
    approveAmendment: vi.fn(),
    rejectAmendment: vi.fn(),
    withdrawAmendment: vi.fn(),
    setWorkSettings: vi.fn(),
    deleteSerial: vi.fn(),
    searchSerials: vi.fn().mockResolvedValue({ results: [], truncated: false }),
    search: vi.fn().mockResolvedValue({ query: '', groups: [], returned: 0 }),
    updateWorkItemSerials: vi.fn(),
    listWorkInstallations: vi
      .fn()
      .mockResolvedValue({ installations: [], itemSummaries: [] }),
    listInstallations: vi.fn().mockResolvedValue([]),
    recordWorkInstallation: vi.fn(),
    cancelWorkInstallation: vi.fn(),
    challanCorrectionEligibility: vi.fn().mockResolvedValue({
      challanId: 'aaaa4444-4444-4444-8444-444444444444',
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
    saveWorkPaymentSetup: vi.fn().mockResolvedValue({ items: [] }),
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
    uploadReceivedRailwayBill: vi.fn(),
    listReceivedRailwayBills: vi.fn(),
    discardReceivedRailwayBill: vi.fn(),
    listBillSettlement: vi.fn().mockResolvedValue([]),
    listReceivables: vi.fn().mockResolvedValue({
      entries: [],
      summary: {
        claimedTotal: '0.00',
        passedTotal: '0.00',
        receivedTotal: '0.00',
        outstandingTotal: '0.00',
      },
    }),
    recordBillPayment: vi.fn(),
    voidBillPayment: vi.fn(),
    closeMeasurementBook: vi.fn(),
    renderMeasurementBook: vi.fn(),
    downloadMeasurementBookPdf: vi.fn(),
    downloadMeasurementBookDraftPreview: vi.fn(),
    mergeWorkMeasurementBooks: vi.fn(),
    unmergeMeasurementBook: vi.fn().mockResolvedValue(undefined),
    completeWork: vi.fn(),
    reopenWork: vi.fn(),
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
    listCompanyDocuments: vi
      .fn()
      .mockResolvedValue({ documents: [], expiryWarningDays: 60 }),
    createCompanyDocument: vi.fn(),
    uploadCompanyDocumentVersion: vi.fn(),
    archiveCompanyDocument: vi.fn(),
    downloadCompanyDocumentVersion: vi.fn(),
    getWorkInspectionConfig: vi.fn().mockResolvedValue({
      items: [],
      checklists: {
        RDSO: { inherited: true, fields: [] },
        RITES: { inherited: true, fields: [] },
      },
    }),
    saveInspectionClauses: vi.fn(),
    saveInspectionChecklist: vi.fn(),
    listInspectionCalls: vi
      .fn()
      .mockResolvedValue({ calls: [], awaitingCertificate: 0, nextCursor: null }),
    createInspectionCall: vi.fn(),
    receiveInspectionCallLetter: vi.fn(),
    uploadInspectionEvidence: vi.fn(),
    uploadInspectionCertificate: vi.fn(),
    closeInspectionCall: vi.fn(),
    cancelInspectionCall: vi.fn(),
    downloadInspectionDocument: vi.fn(),
    uploadTenderNotice: vi.fn(),
    downloadTenderNotice: vi.fn(),
    confirmTenderNotice: vi.fn(),
    listProductionItems: vi.fn().mockResolvedValue({ items: [] }),
    saveProductionItem: vi.fn(),
    setProductionItemActive: vi.fn(),
    getProductionBom: vi.fn().mockResolvedValue({ nodes: [], truncated: false }),
    addProductionBomLine: vi.fn(),
    updateProductionBomLine: vi.fn(),
    removeProductionBomLine: vi.fn(),
    listJobCards: vi.fn().mockResolvedValue({
      jobCards: [],
      nextCursor: null,
      openCount: 0,
      inProductionCount: 0,
      dispatchReadyCount: 0,
    }),
    getJobCard: vi.fn(),
    createJobCard: vi.fn(),
    updateJobCard: vi.fn(),
    completeJobCard: vi.fn(),
    cancelJobCard: vi.fn(),
    recordProductionSerial: vi.fn(),
    removeProductionSerial: vi.fn(),
    recordComponentSerial: vi.fn(),
    removeComponentSerial: vi.fn(),
    createProductionDispatch: vi.fn(),
    withdrawProductionDispatch: vi.fn(),
    listTenders: vi.fn().mockResolvedValue({ tenders: [] }),
    listCorrespondence: vi.fn().mockResolvedValue({
      entries: [],
      nextCursor: null,
      counts: { outward: 0, inward: 0, extensions: 0, inspection: 0 },
      awaitingExtensionResponses: 0,
    }),
    listCorrespondenceThreadOptions: vi.fn().mockResolvedValue({ letters: [] }),
    writeOutwardLetter: vi.fn(),
    registerInwardLetter: vi.fn(),
    cancelCorrespondenceLetter: vi.fn(),
    downloadCorrespondenceLetter: vi.fn(),
    getTender: vi.fn(),
    updateTenderStatus: vi.fn(),
    addTenderChecklistItem: vi.fn(),
    attachTenderChecklistDocument: vi.fn(),
    removeTenderChecklistItem: vi.fn(),
    linkTenderAwardLetter: vi.fn(),
    listBudgetaryQuotations: vi.fn().mockResolvedValue([]),
    createBudgetaryQuotation: vi.fn(),
    getBudgetaryQuotation: vi.fn(),
    updateBudgetaryQuotation: vi.fn(),
    saveBudgetaryQuotationLines: vi.fn(),
    issueBudgetaryQuotation: vi.fn(),
    setBudgetaryQuotationOutcome: vi.fn(),
    deleteBudgetaryQuotation: vi.fn().mockResolvedValue(undefined),
    listWorkTaxInvoices: vi.fn().mockResolvedValue([]),
    listTaxInvoices: vi.fn().mockResolvedValue({ invoices: [], nextCursor: null }),
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
    listChallanEwayBills: vi.fn().mockResolvedValue([]),
    createChallanEwayBill: vi.fn(),
    renderEwayBill: vi.fn(),
    downloadEwayBillPdf: vi.fn(),
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
    listStockItems: vi.fn(),
    setStockReorderLevel: vi.fn(),
    listStockMovements: vi.fn(),
    postStockMovement: vi.fn(),
    listPendingProductionReceipts: vi.fn(),
    recordProductionReceipt: vi.fn(),
    listStockShortages: vi.fn(),
    createShortagePurchaseOrder: vi.fn(),
    listSigningRequests: vi.fn(),
    createSigningRequest: vi.fn(),
    downloadSignedPdf: vi.fn(),
    cancelSigningRequest: vi.fn(),
    registerSigningAgent: vi.fn(),
    revokeSigningAgent: vi.fn(),
    listEmployees: vi.fn().mockResolvedValue({
      employees: [],
      nextCursor: null,
      currentCount: 0,
      currentMonthlyGross: '0',
    }),
    getEmployee: vi.fn(),
    createEmployee: vi.fn(),
    updateEmployee: vi.fn(),
    listPayrollRuns: vi.fn().mockResolvedValue({ runs: [], nextCursor: null }),
    getPayrollRun: vi.fn(),
    openPayrollRun: vi.fn(),
    calculatePayrollRun: vi.fn(),
    setPayrollLineLossOfPay: vi.fn(),
    finalizePayrollRun: vi.fn(),
    cancelPayrollRun: vi.fn(),
    listNotificationChannels: vi.fn().mockResolvedValue({ channels: [] }),
    saveNotificationChannel: vi.fn(),
    listNotificationTemplates: vi
      .fn()
      .mockResolvedValue({ templates: [], nextCursor: null }),
    createNotificationTemplate: vi.fn(),
    setNotificationTemplateStatus: vi.fn(),
    listNotificationConsents: vi
      .fn()
      .mockResolvedValue({ consents: [], nextCursor: null }),
    recordNotificationConsent: vi.fn(),
    listNotifications: vi.fn().mockResolvedValue({ messages: [], nextCursor: null }),
    sendNotification: vi.fn(),
    listEntitlements: vi.fn(),
    setEntitlement: vi.fn(),
    listJobSchedules: vi.fn(),
    setJobSchedule: vi.fn(),
    listOrganisationExports: vi.fn(),
    requestOrganisationExport: vi.fn(),
    downloadOrganisationExport: vi.fn(),
    listMaintenanceRequests: vi.fn(),
    getMaintenanceRequest: vi.fn(),
    createMaintenanceRequest: vi.fn(),
    approveMaintenanceRequest: vi.fn(),
    recordMaintenanceDispatch: vi.fn(),
    receiveMaintenanceReturn: vi.fn(),
    cancelMaintenanceLine: vi.fn(),
    closeMaintenanceRequest: vi.fn(),
    ...overrides,
  };
}

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const WORK_ID = '33333333-3333-4333-8333-333333333333';
const CHALLAN_ID = 'aaaa4444-4444-4444-8444-444444444444';
const ITEM_A = '55555555-5555-4555-8555-555555555555';
const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';

const BALANCE = {
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

function issueChallanDetail(
  overrides: Partial<IssueChallanDetailResponse['issueChallan']> = {},
): IssueChallanDetailResponse {
  return {
    issueChallan: {
      id: CHALLAN_ID,
      workId: WORK_ID,
      status: 'draft',
      movementType: 'issue',
      challanDate: '2026-01-15',
      challanNumber: null,
      sequenceNumber: null,
      prefix: 'DCW-1-IC',
      issuedToName: 'SSE/Signal/Delhi',
      issuedToRole: 'Site engineer',
      location: 'Relay room, NDLS',
      remarks: null,
      templateVersion: null,
      renderedAvailable: false,
      signedCopyAvailable: false,
      cancellationNote: null,
      createdAt: '2026-01-15T00:00:00.000Z',
      issuedAt: null,
      cancelledAt: null,
      ...overrides,
    },
    lines: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        workItemId: ITEM_A,
        itemNumber: 'A/1',
        description: 'Main switchboard',
        unit: 'Nos',
        quantity: '50.000',
        position: 1,
      },
      {
        id: '66666666-6666-4666-8666-666666666667',
        workItemId: null,
        itemNumber: null,
        description: 'Cable ties (site consumables)',
        unit: 'Pkt',
        quantity: '12.000',
        position: 2,
      },
    ],
    issuedSnapshot: null,
  };
}

describe('IssueChallanEditor', () => {
  it('binds header validation messages and focuses fields in reading order', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText('Main switchboard');
    const date = screen.getByLabelText<HTMLInputElement>('Challan date');
    expect(date.value).toBe(BALANCE.today);
    fireEvent.change(date, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const dateMessage = screen.getByText('Enter the challan date.');
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(date.getAttribute('aria-describedby')).toBe(dateMessage.id);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Enter a challan date before saving.',
    );
    expect(document.activeElement).toBe(date);

    fireEvent.change(date, { target: { value: '2026-08-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const recipient = screen.getByLabelText('Issued to (name)');
    const recipientMessage = screen.getByText(
      'Enter who the material goes to, in at least 2 characters.',
    );
    expect(recipient.getAttribute('aria-invalid')).toBe('true');
    expect(recipient.getAttribute('aria-describedby')).toBe(recipientMessage.id);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Enter who the material goes to before saving.',
    );
    expect(document.activeElement).toBe(recipient);
    expect(api.createIssueChallan).not.toHaveBeenCalled();
  });

  it('saves a draft with an item quantity and a manual line', async () => {
    const createIssueChallan = vi.fn().mockResolvedValue(issueChallanDetail());
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createIssueChallan,
    });
    const onSaved = vi.fn();
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByText('Main switchboard')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Issued to (name)'), {
      target: { value: 'SSE/Signal/Delhi' },
    });
    fireEvent.change(screen.getByLabelText('Movement'), {
      target: { value: 'loan' },
    });
    // Quantities may exceed the awarded quantity — the editor accepts 50
    // against an award of 5.
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this Issue Challan'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add manual line' }));
    fireEvent.change(screen.getByLabelText('Description for manual line 1'), {
      target: { value: 'Cable ties (site consumables)' },
    });
    fireEvent.change(screen.getByLabelText('Unit for manual line 1'), {
      target: { value: 'Pkt' },
    });
    fireEvent.change(screen.getByLabelText('Quantity for manual line 1'), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(CHALLAN_ID);
    });
    const [, , body] = createIssueChallan.mock.calls[0] as [
      string,
      string,
      SaveIssueChallanRequest,
    ];
    expect(body.movementType).toBe('loan');
    expect(body.issuedToName).toBe('SSE/Signal/Delhi');
    expect(body.lines).toEqual([
      { workItemId: ITEM_A, quantity: '50' },
      { description: 'Cable ties (site consumables)', unit: 'Pkt', quantity: '12' },
    ]);
  });

  it('refuses to save an empty Issue Challan', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('Main switchboard');
    fireEvent.change(screen.getByLabelText('Issued to (name)'), {
      target: { value: 'SSE/Signal/Delhi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('at least one item');
    expect(api.createIssueChallan).not.toHaveBeenCalled();
  });

  it('keeps the surviving manual lines intact when an earlier line is removed', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('Main switchboard');
    const descriptions = ['Cable ties', 'Gland kits', 'Ferrules'];
    for (const [index, description] of descriptions.entries()) {
      fireEvent.click(screen.getByRole('button', { name: 'Add manual line' }));
      fireEvent.change(
        screen.getByLabelText(`Description for manual line ${String(index + 1)}`),
        { target: { value: description } },
      );
    }
    const third = screen.getByLabelText<HTMLInputElement>(
      'Description for manual line 3',
    );
    third.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Remove manual line 1' }));

    // Removing a line removes THAT line: the rows below keep their values
    // and, because they keep their DOM identity, the box being typed in
    // keeps focus even though its visible ordinal moved up.
    expect(screen.queryByLabelText('Description for manual line 3')).toBeNull();
    expect(
      screen.getByLabelText<HTMLInputElement>('Description for manual line 1').value,
    ).toBe('Gland kits');
    const survivor = screen.getByLabelText<HTMLInputElement>(
      'Description for manual line 2',
    );
    expect(survivor.value).toBe('Ferrules');
    expect(document.activeElement).toBe(survivor);
    expect(survivor).toBe(third);
  });

  it('binds an incomplete manual line to its own fields and focuses the first', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createIssueChallan: vi.fn().mockResolvedValue(issueChallanDetail()),
    });
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('Main switchboard');
    fireEvent.change(screen.getByLabelText('Issued to (name)'), {
      target: { value: 'SSE/Signal/Delhi' },
    });
    // A quantity with no description and no unit is what the server rejects.
    fireEvent.click(screen.getByRole('button', { name: 'Add manual line' }));
    fireEvent.change(screen.getByLabelText('Quantity for manual line 1'), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(api.createIssueChallan).not.toHaveBeenCalled();
    const description = screen.getByLabelText('Description for manual line 1');
    const unit = screen.getByLabelText('Unit for manual line 1');
    expect(description.getAttribute('aria-invalid')).toBe('true');
    expect(unit.getAttribute('aria-invalid')).toBe('true');
    const descriptionMessage = screen.getByText(
      'Describe the material in at least 3 characters.',
    );
    expect(description.getAttribute('aria-describedby')).toBe(descriptionMessage.id);
    // Per-field messages stay silent; the summary carries the announcement.
    expect(descriptionMessage.getAttribute('role')).toBeNull();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'at least 3 characters',
    );
    expect(document.activeElement).toBe(description);

    // Completing the line clears the block on the next attempt.
    fireEvent.change(description, { target: { value: 'Cable ties' } });
    fireEvent.change(unit, { target: { value: 'Pkt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(api.createIssueChallan).toHaveBeenCalled();
    });
    expect(
      screen.queryByText('Describe the material in at least 3 characters.'),
    ).toBeNull();
  });

  it('focuses the first quantity box when nothing has been entered', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('Main switchboard');
    fireEvent.change(screen.getByLabelText('Issued to (name)'), {
      target: { value: 'SSE/Signal/Delhi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'at least one item',
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText('Quantity of A/1 on this Issue Challan'),
    );
  });

  it('confirms before discarding an edited draft and leaves a pristine one at once', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    const onCancel = vi.fn();
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await screen.findByText('Main switchboard');

    // Nothing typed yet: Cancel leaves without asking.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this Issue Challan'), {
      target: { value: '2' },
    });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // Focused first, because that is the state a real click or Enter leaves
    // the trigger in and it is where the dialog must hand focus back.
    cancel.focus();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: 'Discard your changes?' });
    // The safe choice is the one focus lands on: Enter on an unread
    // confirmation must not be the destructive answer.
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Keep editing' }),
    );
    // And it is a real modal — Escape declines.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('button', { name: 'Discard and leave' })).toBeNull();
    expect(document.activeElement).toBe(cancel);
    expect(
      screen.getByLabelText<HTMLInputElement>('Quantity of A/1 on this Issue Challan')
        .value,
    ).toBe('2');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('routes to the existing draft on a DRAFT_EXISTS conflict', async () => {
    const existingId = 'bbbb4444-4444-4444-8444-444444444444';
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createIssueChallan: vi.fn().mockRejectedValue(
        new RequestFailedError(409, 'DRAFT_EXISTS', 'A draft already exists.', {
          existingRecordId: existingId,
        }),
      ),
    });
    const onSaved = vi.fn();
    render(
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('Main switchboard');
    fireEvent.change(screen.getByLabelText('Issued to (name)'), {
      target: { value: 'SSE/Signal/Delhi' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this Issue Challan'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(existingId);
    });
  });
});

describe('IssueChallanDetail', () => {
  it('issues a draft when the member holds the issue authority', async () => {
    const issueIssueChallan = vi.fn().mockResolvedValue(
      issueChallanDetail({
        status: 'issued',
        challanNumber: 'DCW-1-IC/1',
        sequenceNumber: 1,
        issuedAt: '2026-01-15T10:00:00.000Z',
      }),
    );
    const api = stubApi({
      getIssueChallan: vi.fn().mockResolvedValue(issueChallanDetail()),
      issueIssueChallan,
    });
    render(
      <IssueChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify
        canIssue
        canCancel={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    // Manual lines render with their placeholder item marker.
    expect(await screen.findByText('Cable ties (site consumables)')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Issue challan' }));
    await waitFor(() => {
      expect(issueIssueChallan).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID);
    });
    expect(
      await screen.findByRole('heading', { name: 'Issue Challan DCW-1-IC/1' }),
    ).toBeTruthy();
  });

  it('annotates loan movements and cancels with a note under the cancel authority', async () => {
    const cancelIssueChallan = vi.fn().mockResolvedValue(
      issueChallanDetail({
        status: 'cancelled',
        movementType: 'loan',
        challanNumber: 'DCW-1-IC/1',
        sequenceNumber: 1,
        issuedAt: '2026-01-15T10:00:00.000Z',
        cancelledAt: '2026-01-16T10:00:00.000Z',
        cancellationNote: 'Wrong site.',
      }),
    );
    const api = stubApi({
      getIssueChallan: vi.fn().mockResolvedValue(
        issueChallanDetail({
          status: 'issued',
          movementType: 'loan',
          challanNumber: 'DCW-1-IC/1',
          sequenceNumber: 1,
          issuedAt: '2026-01-15T10:00:00.000Z',
        }),
      ),
      cancelIssueChallan,
    });
    render(
      <IssueChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    await screen.findByRole('heading', { name: 'Issue Challan DCW-1-IC/1' });
    expect(screen.getByText('Loan movement: the material is returnable.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue challan' })).toBeNull();
    // Read-only member without modify rights sees no signed-copy upload.
    expect(screen.queryByRole('button', { name: 'Upload signed copy' })).toBeNull();

    await openForm('Cancel challan…');
    fireEvent.change(screen.getByLabelText('Cancellation note'), {
      target: { value: 'Wrong site.' },
    });
    fireEvent.click(submitButton('Cancel challan'));
    await waitFor(() => {
      expect(cancelIssueChallan).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        note: 'Wrong site.',
      });
    });
    expect(await screen.findByText(/Cancelled: Wrong site\./)).toBeTruthy();
  });
});

/** The Work page splits its areas across tabs, so a test that asserts on one
 * area opens it first — exactly as an operator does. The tab's accessible
 * name carries its count, so match on the label prefix. */
async function openWorkTab(label: string) {
  // Scoped to the tab strip: the Overview summary offers a button per area
  // too, and both carry the same label.
  const tabs = await screen.findByRole('navigation', { name: 'Work sections' });
  fireEvent.click(
    within(tabs).getByRole('button', {
      name: (accessibleName: string) => accessibleName.startsWith(label),
    }),
  );
}

describe('WorkDetail Issue Challans section', () => {
  const WORK_DETAIL = {
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
        id: SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [
          {
            id: ITEM_A,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/1',
            description: 'Main switchboard',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
          },
        ],
      },
    ],
    installationCounts: { recorded: 0, cancelled: 0 },
  };

  function renderWorkDetail(
    api: ApiClient,
    handlers: {
      onNewIssueChallan?: (workId: string) => void;
      onOpenIssueChallan?: (challanId: string) => void;
    } = {},
  ) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canSign={false}
        canModify
        canRecordEvidence
        canIssue
        canCancel
        canApprove={false}
        canManageStatutory={true}
        isOwner={false}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onNewIssueChallan={handlers.onNewIssueChallan ?? vi.fn()}
        onOpenIssueChallan={handlers.onOpenIssueChallan ?? vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('lists Issue Challans and routes opening one', async () => {
    const issued = issueChallanDetail({
      status: 'issued',
      challanNumber: 'DCW-1-IC/1',
      sequenceNumber: 1,
      issuedAt: '2026-01-15T10:00:00.000Z',
    }).issueChallan;
    const onOpenIssueChallan = vi.fn();
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(WORK_DETAIL),
      listIssueChallans: vi.fn().mockResolvedValue([issued]),
    });
    renderWorkDetail(api, { onOpenIssueChallan });
    await openWorkTab('Issues');

    fireEvent.click(await screen.findByRole('link', { name: 'DCW-1-IC/1' }));
    expect(onOpenIssueChallan).toHaveBeenCalledWith(CHALLAN_ID);
    // No draft exists, so the primary action starts a new Issue Challan.
    expect(screen.getByRole('button', { name: 'New Issue Challan' })).toBeTruthy();
  });

  it('offers the open-draft action when a draft Issue Challan exists', async () => {
    const draft = issueChallanDetail().issueChallan;
    const onOpenIssueChallan = vi.fn();
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(WORK_DETAIL),
      listIssueChallans: vi.fn().mockResolvedValue([draft]),
    });
    renderWorkDetail(api, { onOpenIssueChallan });
    await openWorkTab('Issues');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open draft Issue Challan' }),
    );
    expect(onOpenIssueChallan).toHaveBeenCalledWith(CHALLAN_ID);
    expect(screen.queryByRole('button', { name: 'New Issue Challan' })).toBeNull();
  });
});

describe('Issue Challan correction flow', () => {
  it('files a cancel-and-replace correction for an issued Issue Challan', async () => {
    const proposeIssueChallanCancelReplace = vi.fn().mockResolvedValue({});
    const api = stubApi({
      getIssueChallan: vi.fn().mockResolvedValue(
        issueChallanDetail({
          status: 'issued',
          challanNumber: 'DCW-1-IC/1',
          sequenceNumber: 1,
          issuedAt: '2026-01-15T10:00:00.000Z',
        }),
      ),
      proposeIssueChallanCancelReplace,
    });
    render(
      <IssueChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify
        canIssue={false}
        canCancel={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Request correction' }),
    ).toBeTruthy();
    await openForm('Request cancel & replace…');
    fireEvent.change(screen.getByLabelText('Issued to'), {
      target: { value: 'SSE/Works/Delhi' },
    });
    fireEvent.change(screen.getByLabelText('Reason for correction'), {
      target: { value: 'Issued to the wrong site engineer.' },
    });
    fireEvent.click(submitButton('Request cancel & replace'));

    await waitFor(() => {
      expect(proposeIssueChallanCancelReplace).toHaveBeenCalled();
    });
    const [, , body] = proposeIssueChallanCancelReplace.mock.calls[0] as [
      string,
      string,
      {
        reason: string;
        replacement: {
          issuedToName: string;
          movementType: string;
          lines: readonly Record<string, string>[];
        };
      },
    ];
    expect(body.reason).toBe('Issued to the wrong site engineer.');
    expect(body.replacement.issuedToName).toBe('SSE/Works/Delhi');
    expect(body.replacement.movementType).toBe('issue');
    expect(body.replacement.lines.length).toBeGreaterThan(0);
  });

  it('surfaces an already-pending correction request instead of the form', async () => {
    const listWorkAmendments = vi.fn().mockResolvedValue([
      {
        id: '99999999-9999-4999-8999-999999999999',
        entityType: 'issue_challan_cancel_replace' as const,
        entityId: CHALLAN_ID,
        workId: WORK_ID,
        workCode: 'DCW-1',
        itemNumber: null,
        documentNumber: 'DCW-1-IC/1',
        proposed: { kind: 'cancel_replace_issue_challan' },
        diff: [{ field: 'issuedToName', before: 'A', after: 'B' }],
        reason: 'Issued to the wrong engineer.',
        status: 'pending' as const,
        requestedByUserId: 'user-b',
        decidedByUserId: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: '2026-08-09T00:00:00.000Z',
      },
    ]);
    const api = stubApi({
      getIssueChallan: vi.fn().mockResolvedValue(
        issueChallanDetail({
          status: 'issued',
          challanNumber: 'DCW-1-IC/1',
          sequenceNumber: 1,
          issuedAt: '2026-01-15T10:00:00.000Z',
        }),
      ),
      listWorkAmendments,
    });
    render(
      <IssueChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify
        canIssue={false}
        canCancel={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(
        'A correction request for this Issue Challan is already awaiting a decision in the approvals queue.',
      ),
    ).toBeTruthy();
    expect(listWorkAmendments).toHaveBeenCalledWith(ORG_ID, WORK_ID);
    // The filing form stays hidden while the request is pending.
    expect(
      screen.queryByRole('button', { name: 'Request cancel & replace' }),
    ).toBeNull();
  });

  it('hides the correction form without modify rights', async () => {
    const api = stubApi({
      getIssueChallan: vi.fn().mockResolvedValue(
        issueChallanDetail({
          status: 'issued',
          challanNumber: 'DCW-1-IC/1',
          sequenceNumber: 1,
          issuedAt: '2026-01-15T10:00:00.000Z',
        }),
      ),
    });
    render(
      <IssueChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { name: 'Issue Challan DCW-1-IC/1' });
    expect(screen.queryByRole('heading', { name: 'Request correction' })).toBeNull();
  });
});
