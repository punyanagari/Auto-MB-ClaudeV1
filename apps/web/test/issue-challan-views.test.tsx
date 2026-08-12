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
import { IssueChallanDetail } from '../src/views/IssueChallanDetail.js';
import { IssueChallanEditor } from '../src/views/IssueChallanEditor.js';
import { WorkDetail } from '../src/views/WorkDetail.js';

afterEach(cleanup);

/** A create-and-record form sits behind a Disclosure labelled with the
 * verb on its own submit button, so a detail page reads as records first
 * and asks a question only when the operator asks. Open the panel before
 * touching the fields â€” they are unmounted until then. */
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
    signIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
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
    listWorkAmendments: vi.fn().mockResolvedValue([]),
    proposeAmendment: vi.fn(),
    proposeAddItem: vi.fn(),
    proposeItemRemoval: vi.fn(),
    approveAmendment: vi.fn(),
    rejectAmendment: vi.fn(),
    withdrawAmendment: vi.fn(),
    setWorkSettings: vi.fn(),
    deleteSerial: vi.fn(),
    searchSerials: vi.fn().mockResolvedValue({ results: [], truncated: false }),
    updateWorkItemSerials: vi.fn(),
    listWorkInstallations: vi
      .fn()
      .mockResolvedValue({ installations: [], itemSummaries: [] }),
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
    // Quantities may exceed the awarded quantity â€” the editor accepts 50
    // against an award of 5.
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this Issue Challan'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add manual line' }));
    fireEvent.change(screen.getByLabelText('Description for manual line 1'), {
      target: { value: 'Cable ties (site consumables)' },
    });
    fireEvent.change(screen.getByLabelText('Unit for manua×Íµ¶‰žËkºwµçh€ô¤ì((€¥Ð ™½ÕÍ•ÌÑ¡”™¥ÉÍÐÅÕ…¹Ñ¥Ñä‰½àÝ¡•¸¹½Ñ¡¥¹œ¡…Ì‰••¸•¹Ñ•É•œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ìÝ½É­	…±…¹”èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡	19¤ô¤ì(€€€É•¹‘•È (€€€€€€ñ%ÍÍÕ•¡…±±…¹‘¥Ñ½È(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€Ý½É­%õí]=I-}%ô(€€€€€€€¡…±±…¹%õí¹Õ±±ô(€€€€€€€½¹M…Ù•õíÙ¤¹™¸ ¥ô(€€€€€€€½¹…¹•°õíÙ¤¹™¸ ¥ô(€€€€€€¼ø°(€€€€¤ì(€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åQ•áÐ 5…¥¸ÍÝ¥Ñ¡‰½…Éœ¤ì(€€€™¥É•Ù•¹Ð¹¡…¹”¡ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐ %ÍÍÕ•Ñ¼€¡¹…µ”¤œ¤°ì(€€€€€Ñ…É•ÐèìÙ…±Õ”è€MM½M¥¹…°½•±¡¤œô°(€€€ô¤ì(€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€M…Ù”‘É…™Ðœô¤¤ì((€€€•áÁ•Ð ¡…Ý…¥ÐÍÉ••¸¹™¥¹‘	åI½±” …±•ÉÐœ¤¤¹Ñ•áÑ½¹Ñ•¹Ð¤¹Ñ½½¹Ñ…¥¸ (€€€€€€…Ð±•…ÍÐ½¹”¥Ñ•´œ°(€€€€¤ì(€€€•áÁ•Ð¡‘½Õµ•¹Ð¹…Ñ¥Ù•±•µ•¹Ð¤¹Ñ½	” (€€€€€ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐ EÕ…¹Ñ¥Ñä½˜¼Ä½¸Ñ¡¥Ì%ÍÍÕ”¡…±±…¸œ¤°(€€€€¤ì(€ô¤ì((€¥Ð ½¹™¥ÉµÌ‰•™½É”‘¥Í…É‘¥¹œ…¸•‘¥Ñ•‘É…™Ð…¹±•…Ù•Ì„ÁÉ¥ÍÑ¥¹”½¹”…Ð½¹”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ìÝ½É­	…±…¹”èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡	19¤ô¤ì(€€€½¹ÍÐ½¹…¹•°€ôÙ¤¹™¸ ¤ì(€€€É•¹‘•È (€€€€€€ñ%ÍÍÕ•¡…±±…¹‘¥Ñ½È(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€Ý½É­%õí]=I-}%ô(€€€€€€€¡…±±…¹%õí¹Õ±±ô(€€€€€€€½¹M…Ù•õíÙ¤¹™¸ ¥ô(€€€€€€€½¹…¹•°õí½¹…¹•±ô(€€€€€€¼ø°(€€€€¤ì(€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åQ•áÐ 5…¥¸ÍÝ¥Ñ¡‰½…Éœ¤ì((€€€€¼¼9½Ñ¡¥¹œÑåÁ•å•Ðè…¹•°±•…Ù•ÌÝ¥Ñ¡½ÕÐ…Í­¥¹œ¸(€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€…¹•°œô¤¤ì(€€€•áÁ•Ð¡½¹…¹•°¤¹Ñ½!…Ù•	••¹…±±•‘Q¥µ•Ì Ä¤ì((€€€™¥É•Ù•¹Ð¹¡…¹”¡ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐ EÕ…¹Ñ¥Ñä½˜¼Ä½¸Ñ¡¥Ì%ÍÍÕ”¡…±±…¸œ¤°ì(€€€€€Ñ…É•ÐèìÙ…±Õ”è€œÈœô°(€€€ô¤ì(€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€…¹•°œô¤¤ì(€€€•áÁ•Ð¡½¹…¹•°¤¹Ñ½!…Ù•	••¹…±±•‘Q¥µ•Ì Ä¤ì(€€€½¹ÍÐ‘¥Í…É€ôÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€¥Í…É…¹±•…Ù”œô¤ì(€€€•áÁ•Ð¡‘½Õµ•¹Ð¹…Ñ¥Ù•±•µ•¹Ð¤¹Ñ½	”¡‘¥Í…É¤ì((€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€-••À•‘¥Ñ¥¹œœô¤¤ì(€€€•áÁ•Ð¡ÍÉ••¸¹ÅÕ•Éå	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€¥Í…É…¹±•…Ù”œô¤¤¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð (€€€€€ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐñ!Q51%¹ÁÕÑ±•µ•¹Ðø EÕ…¹Ñ¥Ñä½˜¼Ä½¸Ñ¡¥Ì%ÍÍÕ”¡…±±…¸œ¤(€€€€€€€€¹Ù…±Õ”°(€€€€¤¹Ñ½	” œÈœ¤ì((€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€…¹•°œô¤¤ì(€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€¥Í…É…¹±•…Ù”œô¤¤ì(€€€•áÁ•Ð¡½¹…¹•°¤¹Ñ½!…Ù•	••¹…±±•‘Q¥µ•Ì È¤ì(€ô¤ì((€¥Ð É½ÕÑ•ÌÑ¼Ñ¡”•á¥ÍÑ¥¹œ‘É…™Ð½¸„IQ}a%MQL½¹™±¥Ðœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ•á¥ÍÑ¥¹%€ô€‰‰‰ˆÐÐÐÐ´ÐÐÐÐ´ÐÐÐÐ´àÐÐÐ´ÐÐÐÐÐÐÐÐÐÐÐÐœì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ì(€€€€€Ý½É­	…±…¹”èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡	19¤°(€€€€€É•…Ñ•%ÍÍÕ•¡…±±…¸èÙ¤¹™¸ ¤¹µ½­I•©•Ñ•‘Y…±Õ” (€€€€€€€¹•ÜI•ÅÕ•ÍÑ…¥±•‘ÉÉ½È ÐÀä°€IQ}a%MQLœ°€‘É…™Ð…±É•…‘ä•á¥ÍÑÌ¸œ°ì(€€€€€€€€€•á¥ÍÑ¥¹I•½É‘%è•á¥ÍÑ¥¹%°(€€€€€€€ô¤°(€€€€€€¤°(€€€ô¤ì(€€€½¹ÍÐ½¹M…Ù•€ôÙ¤¹™¸ ¤ì(€€€É•¹‘•È (€€€€€€ñ%ÍÍÕ•¡…±±…¹‘¥Ñ½È(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€Ý½É­%õí]=I-}%ô(€€€€€€€¡…±±…¹%õí¹Õ±±ô(€€€€€€€½¹M…Ù•õí½¹M…Ù•‘ô(€€€€€€€½¹…¹•°õíÙ¤¹™¸ ¥ô(€€€€€€¼ø°(€€€€¤ì(€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åQ•áÐ 5…¥¸ÍÝ¥Ñ¡‰½…Éœ¤ì(€€€™¥É•Ù•¹Ð¹¡…¹”¡ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐ %ÍÍÕ•Ñ¼€¡¹…µ”¤œ¤°ì(€€€€€Ñ…É•ÐèìÙ…±Õ”è€MM½M¥¹…°½•±¡¤œô°(€€€ô¤ì(€€€™¥É•Ù•¹Ð¹¡…¹”¡ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐ EÕ…¹Ñ¥Ñä½˜¼Ä½¸Ñ¡¥Ì%ÍÍÕ”¡…±±…¸œ¤°ì(€€€€€Ñ…É•ÐèìÙ…±Õ”è€œÄœô°(€€€ô¤ì(€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€M…Ù”‘É…™Ðœô¤¤ì(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôøì(€€€€€•áÁ•Ð¡½¹M…Ù•¤¹Ñ½!…Ù•	••¹…±±•‘]¥Ñ ¡•á¥ÍÑ¥¹%¤ì(€€€ô¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” %ÍÍÕ•¡…±±…¹•Ñ…¥°œ°€ ¤€ôøì(€¥Ð ¥ÍÍÕ•Ì„‘É…™ÐÝ¡•¸Ñ¡”µ•µ‰•È¡½±‘ÌÑ¡”¥ÍÍÕ”…ÕÑ¡½É¥Ñäœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ¥ÍÍÕ•%ÍÍÕ•¡…±±…¸€ôÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ” (€€€€€¥ÍÍÕ•¡…±±…¹•Ñ…¥°¡ì(€€€€€€€ÍÑ…ÑÕÌè€¥ÍÍÕ•œ°(€€€€€€€¡…±±…¹9Õµ‰•Èè€\´Äµ%¼Äœ°(€€€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€Ä°(€€€€€€€¥ÍÍÕ•‘Ðè€œÈÀÈØ´ÀÄ´ÄÕPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€ô¤°(€€€€¤ì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ì(€€€€€•Ñ%ÍÍÕ•¡…±±…¸èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡¥ÍÍÕ•¡…±±…¹•Ñ…¥° ¤¤°(€€€€€¥ÍÍÕ•%ÍÍÕ•¡…±±…¸°(€€€ô¤ì(€€€É•¹‘•È (€€€€€€ñ%ÍÍÕ•¡…±±…¹•Ñ…¥°(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€¡…±±…¹%õí!119}%ô(€€€€€€€…¹5½‘¥™ä(€€€€€€€…¹%ÍÍÕ”(€€€€€€€…¹…¹•°õí™…±Í•ô(€€€€€€€½¹‘¥ÐõíÙ¤¹™¸ ¥ô(€€€€€€€½¹•±•Ñ•õíÙ¤¹™¸ ¥ô(€€€€€€€½¹	…¬õíÙ¤¹™¸ ¥ô(€€€€€€¼ø°(€€€€¤ì((€€€€¼¼5…¹Õ…°±¥¹•ÌÉ•¹‘•ÈÝ¥Ñ Ñ¡•¥ÈÁ±…•¡½±‘•È¥Ñ•´µ…É­•È¸(€€€•áÁ•Ð¡…Ý…¥ÐÍÉ••¸¹™¥¹‘	åQ•áÐ …‰±”Ñ¥•Ì€¡Í¥Ñ”½¹ÍÕµ…‰±•Ì¤œ¤¤¹Ñ½	•QÉÕÑ¡ä ¤ì(€€€•áÁ•Ð¡ÍÉ••¸¹•Ñ	åQ•áÐ 5…¹Õ…°œ¤¤¹Ñ½	•QÉÕÑ¡ä ¤ì((€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€%ÍÍÕ”¡…±±…¸œô¤¤ì(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôøì(€€€€€•áÁ•Ð¡¥ÍÍÕ•%ÍÍÕ•¡…±±…¸¤¹Ñ½!…Ù•	••¹…±±•‘]¥Ñ ¡=I}%°!119}%¤ì(€€€ô¤ì(€€€•áÁ•Ð (€€€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åI½±” ¡•…‘¥¹œœ°ì¹…µ”è€%ÍÍÕ”¡…±±…¸\´Äµ%¼Äœô¤°(€€€€¤¹Ñ½	•QÉÕÑ¡ä ¤ì(€ô¤ì((€¥Ð …¹¹½Ñ…Ñ•Ì±½…¸µ½Ù•µ•¹ÑÌ…¹…¹•±ÌÝ¥Ñ „¹½Ñ”Õ¹‘•ÈÑ¡”…¹•°…ÕÑ¡½É¥Ñäœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ…¹•±%ÍÍÕ•¡…±±…¸€ôÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ” (€€€€€¥ÍÍÕ•¡…±±…¹•Ñ…¥°¡ì(€€€€€€€ÍÑ…ÑÕÌè€…¹•±±•œ°(€€€€€€€µ½Ù•µ•¹ÑQåÁ”è€±½…¸œ°(€€€€€€€¡…±±…¹9Õµ‰•Èè€\´Äµ%¼Äœ°(€€€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€Ä°(€€€€€€€¥ÍÍÕ•‘Ðè€œÈÀÈØ´ÀÄ´ÄÕPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€…¹•±±•‘Ðè€œÈÀÈØ´ÀÄ´ÄÙPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€…¹•±±…Ñ¥½¹9½Ñ”è€]É½¹œÍ¥Ñ”¸œ°(€€€€€ô¤°(€€€€¤ì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ì(€€€€€•Ñ%ÍÍÕ•¡…±±…¸èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ” (€€€€€€€¥ÍÍÕ•¡…±±…¹•Ñ…¥°¡ì(€€€€€€€€€ÍÑ…ÑÕÌè€¥ÍÍÕ•œ°(€€€€€€€€€µ½Ù•µ•¹ÑQåÁ”è€±½…¸œ°(€€€€€€€€€¡…±±…¹9Õµ‰•Èè€\´Äµ%¼Äœ°(€€€€€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€Ä°(€€€€€€€€€¥ÍÍÕ•‘Ðè€œÈÀÈØ´ÀÄ´ÄÕPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€ô¤°(€€€€€€¤°(€€€€€…¹•±%ÍÍÕ•¡…±±…¸°(€€€ô¤ì(€€€É•¹‘•È (€€€€€€ñ%ÍÍÕ•¡…±±…¹•Ñ…¥°(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€¡…±±…¹%õí!119}%ô(€€€€€€€…¹5½‘¥™äõí™…±Í•ô(€€€€€€€…¹%ÍÍÕ”õí™…±Í•ô(€€€€€€€…¹…¹•°(€€€€€€€½¹‘¥ÐõíÙ¤¹™¸ ¥ô(€€€€€€€½¹•±•Ñ•õíÙ¤¹™¸ ¥ô(€€€€€€€½¹	…¬õíÙ¤¹™¸ ¥ô(€€€€€€¼ø°(€€€€¤ì((€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åI½±” ¡•…‘¥¹œœ°ì¹…µ”è€%ÍÍÕ”¡…±±…¸\´Äµ%¼Äœô¤ì(€€€•áÁ•Ð¡ÍÉ••¸¹•Ñ	åQ•áÐ 1½…¸µ½Ù•µ•¹ÐèÑ¡”µ…Ñ•É¥…°¥ÌÉ•ÑÕÉ¹…‰±”¸œ¤¤¹Ñ½	•QÉÕÑ¡ä ¤ì(€€€•áÁ•Ð¡ÍÉ••¸¹ÅÕ•Éå	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€%ÍÍÕ”¡…±±…¸œô¤¤¹Ñ½	•9Õ±° ¤ì(€€€€¼¼I•…µ½¹±äµ•µ‰•ÈÝ¥Ñ¡½ÕÐµ½‘¥™äÉ¥¡ÑÌÍ••Ì¹¼Í¥¹•µ½ÁäÕÁ±½…¸(€€€•áÁ•Ð¡ÍÉ••¸¹ÅÕ•Éå	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€UÁ±½…Í¥¹•½Áäœô¤¤¹Ñ½	•9Õ±° ¤ì((€€€…Ý…¥Ð½Á•¹½É´ …¹•°¡…±±…¸œ¤ì(€€€™¥É•Ù•¹Ð¹¡…¹”¡ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐ …¹•±±…Ñ¥½¸¹½Ñ”œ¤°ì(€€€€€Ñ…É•ÐèìÙ…±Õ”è€]É½¹œÍ¥Ñ”¸œô°(€€€ô¤ì(€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÕ‰µ¥Ñ	ÕÑÑ½¸ …¹•°¡…±±…¸œ¤¤ì(€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôøì(€€€€€•áÁ•Ð¡…¹•±%ÍÍÕ•¡…±±…¸¤¹Ñ½!…Ù•	••¹…±±•‘]¥Ñ ¡=I}%°!119}%°ì(€€€€€€€¹½Ñ”è€]É½¹œÍ¥Ñ”¸œ°(€€€€€ô¤ì(€€€ô¤ì(€€€•áÁ•Ð¡…Ý…¥ÐÍÉ••¸¹™¥¹‘	åQ•áÐ ½…¹•±±•è]É½¹œÍ¥Ñ•p¸¼¤¤¹Ñ½	•QÉÕÑ¡ä ¤ì(€ô¤ì)ô¤ì((¼¨¨Q¡”]½É¬Á…”ÍÁ±¥ÑÌ¥ÑÌ…É•…Ì…É½ÍÌÑ…‰Ì°Í¼„Ñ•ÍÐÑ¡…Ð…ÍÍ•ÉÑÌ½¸½¹”(€¨…É•„½Á•¹Ì¥Ð™¥ÉÍÐƒŠP•á…Ñ±ä…Ì…¸½Á•É…Ñ½È‘½•Ì¸Q¡”Ñ…ˆÌ…•ÍÍ¥‰±”(€¨¹…µ”…ÉÉ¥•Ì¥ÑÌ½Õ¹Ð°Í¼µ…Ñ ½¸Ñ¡”±…‰•°ÁÉ•™¥à¸€¨¼)…Íå¹Œ™Õ¹Ñ¥½¸½Á•¹]½É­Q…ˆ¡±…‰•°èÍÑÉ¥¹œ¤ì(€€¼¼M½Á•Ñ¼Ñ¡”Ñ…ˆÍÑÉ¥ÀèÑ¡”=Ù•ÉÙ¥•ÜÍÕµµ…Éä½™™•ÉÌ„‰ÕÑÑ½¸Á•È…É•„(€€¼¼Ñ½¼°…¹‰½Ñ …ÉÉäÑ¡”Í…µ”±…‰•°¸(€½¹ÍÐÑ…‰Ì€ô…Ý…¥ÐÍÉ••¸¹™¥¹‘	åI½±” ¹…Ù¥…Ñ¥½¸œ°ì¹…µ”è€]½É¬Í•Ñ¥½¹Ìœô¤ì(€™¥É•Ù•¹Ð¹±¥¬ (€€€Ý¥Ñ¡¥¸¡Ñ…‰Ì¤¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì(€€€€€¹…µ”è€¡…•ÍÍ¥‰±•9…µ”èÍÑÉ¥¹œ¤€ôø…•ÍÍ¥‰±•9…µ”¹ÍÑ…ÉÑÍ]¥Ñ ¡±…‰•°¤°(€€€ô¤°(€€¤ì)ô()‘•ÍÉ¥‰” ]½É­•Ñ…¥°%ÍÍÕ”¡…±±…¹ÌÍ•Ñ¥½¸œ°€ ¤€ôøì(€½¹ÍÐ]=I-}Q%0€ôì(€€€Ý½É¬èì(€€€€€¥è]=I-}%°(€€€€€Ý½É­½‘”è€\´Äœ°(€€€€€±•ÑÑ•É9Õµ‰•Èè€0´ÐÈ¼ÈÀÈÔœ°(€€€€€±•ÑÑ•É…Ñ”è€œÈÀÈÔ´ÀØ´ÀÄœ°(€€€€€Ñ¥Ñ±”è€MÕÁÁ±ä½˜ÍÝ¥Ñ¡‰½…É‘Ìœ°(€€€€€…‘Ù•ÉÑ¥Í•‘Y…±Õ”è€œÄÀÀÀ¸ÀÀœ°(€€€€€½¹ÑÉ…ÑY…±Õ”è€œäÀÀ¸ÀÀœ°(€€€€€ÁÉ¥¥¹M¡…Á”è€Á•É}Í¡•‘Õ±”œ°(€€€€€±•ÑÑ•ÉA•É•¹Ñ…”è¹Õ±°°(€€€€€±•ÑÑ•ÉA•É•¹Ñ…•¥É•Ñ¥½¸è¹Õ±°°(€€€€€ÍÑ…ÑÕÌè€…Ñ¥Ù”œ°(€€€€€É•…Ñ•‘Ðè€œÈÀÈØ´Àà´ÀáPÀÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€ô°(€€€Í¡•‘Õ±•Ìèl(€€€€€ì(€€€€€€€¥èM!U1}%°(€€€€€€€Í¡•‘Õ±•½‘”è€œ°(€€€€€€€Ñ¥Ñ±”è€M¡•‘Õ±”œ°(€€€€€€€Á½Í¥Ñ¥½¸è€Ä°(€€€€€€€¥Ñ•µÌèl(€€€€€€€€€ì(€€€€€€€€€€€¥è%Q5}°(€€€€€€€€€€€Í¡•‘Õ±•%èM!U1}%°(€€€€€€€€€€€¥Ñ•µ9Õµ‰•Èè€¼Äœ°(€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è€5…¥¸ÍÝ¥Ñ¡‰½…Éœ°(€€€€€€€€€€€Õ¹¥Ñ½‘”è€9½Ìœ°(€€€€€€€€€€€…Ý…É‘•‘EÕ…¹Ñ¥Ñäè€œÔ¸ÀÀÀœ°(€€€€€€€€€€€•™™•Ñ¥Ù•I…Ñ”è€œÄÀÀ¸ÀÀœ°(€€€€€€€€€ô°(€€€€€€€t°(€€€€€ô°(€€€t°(€ôì((€™Õ¹Ñ¥½¸É•¹‘•É]½É­•Ñ…¥° (€€€…Á¤èÁ¥±¥•¹Ð°(€€€¡…¹‘±•ÉÌèì(€€€€€½¹9•Ý%ÍÍÕ•¡…±±…¸üè€¡Ý½É­%èÍÑÉ¥¹œ¤€ôøÙ½¥ì(€€€€€½¹=Á•¹%ÍÍÕ•¡…±±…¸üè€¡¡…±±…¹%èÍÑÉ¥¹œ¤€ôøÙ½¥ì(€€€ô€ôíô°(€€¤ì(€€€É•ÑÕÉ¸É•¹‘•È (€€€€€€ñ]½É­•Ñ…¥°(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€Ý½É­%õí]=I-}%ô(€€€€€€€…¹5½‘¥™ä(€€€€€€€…¹I•½É‘Ù¥‘•¹”(€€€€€€€…¹%ÍÍÕ”(€€€€€€€…¹…¹•°(€€€€€€€…¹ÁÁÉ½Ù”õí™…±Í•ô(€€€€€€€¥Í=Ý¹•Èõí™…±Í•ô(€€€€€€€½¹9•Ý¡…±±…¸õíÙ¤¹™¸ ¥ô(€€€€€€€½¹=Á•¹¡…±±…¸õíÙ¤¹™¸ ¥ô(€€€€€€€½¹9•Ý%ÍÍÕ•¡…±±…¸õí¡…¹‘±•ÉÌ¹½¹9•Ý%ÍÍÕ•¡…±±…¸€üüÙ¤¹™¸ ¥ô(€€€€€€€½¹=Á•¹%ÍÍÕ•¡…±±…¸õí¡…¹‘±•ÉÌ¹½¹=Á•¹%ÍÍÕ•¡…±±…¸€üüÙ¤¹™¸ ¥ô(€€€€€€€½¹	…¬õíÙ¤¹™¸ ¥ô(€€€€€€¼ø°(€€€€¤ì(€ô((€¥Ð ±¥ÍÑÌ%ÍÍÕ”¡…±±…¹Ì…¹É½ÕÑ•Ì½Á•¹¥¹œ½¹”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ¥ÍÍÕ•€ô¥ÍÍÕ•¡…±±…¹•Ñ…¥°¡ì(€€€€€ÍÑ…ÑÕÌè€¥ÍÍÕ•œ°(€€€€€¡…±±…¹9Õµ‰•Èè€\´Äµ%¼Äœ°(€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€Ä°(€€€€€¥ÍÍÕ•‘Ðè€œÈÀÈØ´ÀÄ´ÄÕPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€ô¤¹¥ÍÍÕ•¡…±±…¸ì(€€€½¹ÍÐ½¹=Á•¹%ÍÍÕ•¡…±±…¸€ôÙ¤¹™¸ ¤ì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ì(€€€€€•Ñ]½É¬èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡]=I-}Q%0¤°(€€€€€±¥ÍÑ%ÍÍÕ•¡…±±…¹ÌèÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡m¥ÍÍÕ•‘t¤°(€€€ô¤ì(€€€É•¹‘•É]½É­•Ñ…¥°¡…Á¤°ì½¹=Á•¹%ÍÍÕ•¡…±±…¸ô¤ì(€€€…Ý…¥Ð½Á•¹]½É­Q…ˆ %ÍÍÕ•Ìœ¤ì((€€€™¥É•Ù•¹Ð¹±¥¬¡…Ý…¥ÐÍÉ••¸¹™¥¹‘	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€\´Äµ%¼Äœô¤¤ì(€€€•áÁ•Ð¡½¹=Á•¹%ÍÍÕ•¡…±±…¸¤¹Ñ½!…Ù•	••¹…±±•‘]¥Ñ ¡!119}%¤ì(€€€€¼¼9¼‘É…™Ð•á¥ÍÑÌ°Í¼Ñ¡”ÁÉ¥µ…Éä…Ñ¥½¸ÍÑ…ÉÑÌ„¹•Ü%ÍÍÕ”¡…±±…¸¸(€€€•áÁ•Ð¡ÍÉ••¸¹•Ñ	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€9•Ü%ÍÍÕ”¡…±±…¸œô¤¤¹Ñ½	•QÉÕÑ¡ä ¤ì(€ô¤ì((€¥Ð ½™™•ÉÌÑ¡”½Á•¸µ‘É…™Ð…Ñ¥½¸Ý¡•¸„‘É…™Ð%ÍÍÕ”¡…±±…¸•á¥ÍÑÌœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ‘É…™Ð€ô¥ÍÍÕ•¡…±±…¹•Ñ…¥° ¤¹¥ÍÍÕ•¡…±±…¸ì(€€€½¹ÍÐ½¹=Á•¹%ÍÍÕ•¡…±±…¸€ôÙ¤¹™¸ ¤ì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ì(€€€€€•Ñ]½É¬èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡]=I-}Q%0¤°(€€€€€±¥ÍÑ%ÍÍÕ•¡…±±…¹ÌèÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡m‘É…™Ñt¤°(€€€ô¤ì(€€€É•¹‘•É]½É­•Ñ…¥°¡…Á¤°ì½¹=Á•¹%ÍÍÕ•¡…±±…¸ô¤ì(€€€…Ý…¥Ð½Á•¹]½É­Q…ˆ %ÍÍÕ•Ìœ¤ì((€€€™¥É•Ù•¹Ð¹±¥¬ (€€€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€=Á•¸‘É…™Ð%ÍÍÕ”¡…±±…¸œô¤°(€€€€¤ì(€€€•áÁ•Ð¡½¹=Á•¹%ÍÍÕ•¡…±±…¸¤¹Ñ½!…Ù•	••¹…±±•‘]¥Ñ ¡!119}%¤ì(€€€•áÁ•Ð¡ÍÉ••¸¹ÅÕ•Éå	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€9•Ü%ÍÍÕ”¡…±±…¸œô¤¤¹Ñ½	•9Õ±° ¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” %ÍÍÕ”¡…±±…¸½ÉÉ•Ñ¥½¸™±½Üœ°€ ¤€ôøì(€¥Ð ™¥±•Ì„…¹•°µ…¹µÉ•Á±…”½ÉÉ•Ñ¥½¸™½È…¸¥ÍÍÕ•%ÍÍÕ”¡…±±…¸œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÁÉ½Á½Í•%ÍÍÕ•¡…±±…¹…¹•±I•Á±…”€ôÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡íô¤ì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ì(€€€€€•Ñ%ÍÍÕ•¡…±±…¸èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ” (€€€€€€€¥ÍÍÕ•¡…±±…¹•Ñ…¥°¡ì(€€€€€€€€€ÍÑ…ÑÕÌè€¥ÍÍÕ•œ°(€€€€€€€€€¡…±±…¹9Õµ‰•Èè€\´Äµ%¼Äœ°(€€€€€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€Ä°(€€€€€€€€€¥ÍÍÕ•‘Ðè€œÈÀÈØ´ÀÄ´ÄÕPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€ô¤°(€€€€€€¤°(€€€€€ÁÉ½Á½Í•%ÍÍÕ•¡…±±…¹…¹•±I•Á±…”°(€€€ô¤ì(€€€É•¹‘•È (€€€€€€ñ%ÍÍÕ•¡…±±…¹•Ñ…¥°(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€¡…±±…¹%õí!119}%ô(€€€€€€€…¹5½‘¥™ä(€€€€€€€…¹%ÍÍÕ”õí™…±Í•ô(€€€€€€€…¹…¹•°õí™…±Í•ô(€€€€€€€½¹‘¥ÐõíÙ¤¹™¸ ¥ô(€€€€€€€½¹•±•Ñ•õíÙ¤¹™¸ ¥ô(€€€€€€€½¹	…¬õíÙ¤¹™¸ ¥ô(€€€€€€¼ø°(€€€€¤ì((€€€•áÁ•Ð (€€€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åI½±” ¡•…‘¥¹œœ°ì¹…µ”è€I•ÅÕ•ÍÐ½ÉÉ•Ñ¥½¸œô¤°(€€€€¤¹Ñ½	•QÉÕÑ¡ä ¤ì(€€€…Ý…¥Ð½Á•¹½É´ I•ÅÕ•ÍÐ…¹•°€˜É•Á±…”œ¤ì(€€€™¥É•Ù•¹Ð¹¡…¹”¡ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐ %ÍÍÕ•Ñ¼œ¤°ì(€€€€€Ñ…É•ÐèìÙ…±Õ”è€MM½]½É­Ì½•±¡¤œô°(€€€ô¤ì(€€€™¥É•Ù•¹Ð¹¡…¹”¡ÍÉ••¸¹•Ñ	å1…‰•±Q•áÐ I•…Í½¸™½È½ÉÉ•Ñ¥½¸œ¤°ì(€€€€€Ñ…É•ÐèìÙ…±Õ”è€%ÍÍÕ•Ñ¼Ñ¡”ÝÉ½¹œÍ¥Ñ”•¹¥¹••È¸œô°(€€€ô¤ì(€€€™¥É•Ù•¹Ð¹±¥¬¡ÍÕ‰µ¥Ñ	ÕÑÑ½¸ I•ÅÕ•ÍÐ…¹•°€˜É•Á±…”œ¤¤ì((€€€…Ý…¥ÐÝ…¥Ñ½È  ¤€ôøì(€€€€€•áÁ•Ð¡ÁÉ½Á½Í•%ÍÍÕ•¡…±±…¹…¹•±I•Á±…”¤¹Ñ½!…Ù•	••¹…±±• ¤ì(€€€ô¤ì(€€€½¹ÍÐl°€°‰½‘åt€ôÁÉ½Á½Í•%ÍÍÕ•¡…±±…¹…¹•±I•Á±…”¹µ½¬¹…±±ÍlÁt…Ìl(€€€€€ÍÑÉ¥¹œ°(€€€€€ÍÑÉ¥¹œ°(€€€€€ì(€€€€€€€É•…Í½¸èÍÑÉ¥¹œì(€€€€€€€É•Á±…•µ•¹Ðèì(€€€€€€€€€¥ÍÍÕ•‘Q½9…µ”èÍÑÉ¥¹œì(€€€€€€€€€µ½Ù•µ•¹ÑQåÁ”èÍÑÉ¥¹œì(€€€€€€€€€±¥¹•ÌèÉ•…‘½¹±äI•½ÉñÍÑÉ¥¹œ°ÍÑÉ¥¹œùmtì(€€€€€€€ôì(€€€€€ô°(€€€tì(€€€•áÁ•Ð¡‰½‘ä¹É•…Í½¸¤¹Ñ½	” %ÍÍÕ•Ñ¼Ñ¡”ÝÉ½¹œÍ¥Ñ”•¹¥¹••È¸œ¤ì(€€€•áÁ•Ð¡‰½‘ä¹É•Á±…•µ•¹Ð¹¥ÍÍÕ•‘Q½9…µ”¤¹Ñ½	” MM½]½É­Ì½•±¡¤œ¤ì(€€€•áÁ•Ð¡‰½‘ä¹É•Á±…•µ•¹Ð¹µ½Ù•µ•¹ÑQåÁ”¤¹Ñ½	” ¥ÍÍÕ”œ¤ì(€€€•áÁ•Ð¡‰½‘ä¹É•Á±…•µ•¹Ð¹±¥¹•Ì¹±•¹Ñ ¤¹Ñ½	•É•…Ñ•ÉQ¡…¸ À¤ì(€ô¤ì((€¥Ð ÍÕÉ™…•Ì…¸…±É•…‘äµÁ•¹‘¥¹œ½ÉÉ•Ñ¥½¸É•ÅÕ•ÍÐ¥¹ÍÑ•…½˜Ñ¡”™½É´œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ±¥ÍÑ]½É­µ•¹‘µ•¹ÑÌ€ôÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ”¡l(€€€€€ì(€€€€€€€¥è€œääääääää´ääää´Ðäää´àäää´ääääääääääääœ°(€€€€€€€•¹Ñ¥ÑåQåÁ”è€¥ÍÍÕ•}¡…±±…¹}…¹•±}É•Á±…”œ…Ì½¹ÍÐ°(€€€€€€€•¹Ñ¥Ñå%è!119}%°(€€€€€€€Ý½É­%è]=I-}%°(€€€€€€€Ý½É­½‘”è€\´Äœ°(€€€€€€€¥Ñ•µ9Õµ‰•Èè¹Õ±°°(€€€€€€€‘½Õµ•¹Ñ9Õµ‰•Èè€\´Äµ%¼Äœ°(€€€€€€€ÁÉ½Á½Í•èì­¥¹è€…¹•±}É•Á±…•}¥ÍÍÕ•}¡…±±…¸œô°(€€€€€€€‘¥™˜èmì™¥•±è€¥ÍÍÕ•‘Q½9…µ”œ°‰•™½É”è€œ°…™Ñ•Èè€œõt°(€€€€€€€É•…Í½¸è€%ÍÍÕ•Ñ¼Ñ¡”ÝÉ½¹œ•¹¥¹••È¸œ°(€€€€€€€ÍÑ…ÑÕÌè€Á•¹‘¥¹œœ…Ì½¹ÍÐ°(€€€€€€€É•ÅÕ•ÍÑ•‘	åUÍ•É%è€ÕÍ•Èµˆœ°(€€€€€€€‘•¥‘•‘	åUÍ•É%è¹Õ±°°(€€€€€€€‘•¥‘•‘Ðè¹Õ±°°(€€€€€€€‘•¥Í¥½¹9½Ñ”è¹Õ±°°(€€€€€€€É•…Ñ•‘Ðè€œÈÀÈØ´Àà´ÀåPÀÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€ô°(€€€t¤ì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ì(€€€€€•Ñ%ÍÍÕ•¡…±±…¸èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ” (€€€€€€€¥ÍÍÕ•¡…±±…¹•Ñ…¥°¡ì(€€€€€€€€€ÍÑ…ÑÕÌè€¥ÍÍÕ•œ°(€€€€€€€€€¡…±±…¹9Õµ‰•Èè€\´Äµ%¼Äœ°(€€€€€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€Ä°(€€€€€€€€€¥ÍÍÕ•‘Ðè€œÈÀÈØ´ÀÄ´ÄÕPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€ô¤°(€€€€€€¤°(€€€€€±¥ÍÑ]½É­µ•¹‘µ•¹ÑÌ°(€€€ô¤ì(€€€É•¹‘•È (€€€€€€ñ%ÍÍÕ•¡…±±…¹•Ñ…¥°(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€¡…±±…¹%õí!119}%ô(€€€€€€€…¹5½‘¥™ä(€€€€€€€…¹%ÍÍÕ”õí™…±Í•ô(€€€€€€€…¹…¹•°õí™…±Í•ô(€€€€€€€½¹‘¥ÐõíÙ¤¹™¸ ¥ô(€€€€€€€½¹•±•Ñ•õíÙ¤¹™¸ ¥ô(€€€€€€€½¹	…¬õíÙ¤¹™¸ ¥ô(€€€€€€¼ø°(€€€€¤ì((€€€•áÁ•Ð (€€€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åQ•áÐ (€€€€€€€€½ÉÉ•Ñ¥½¸É•ÅÕ•ÍÐ™½ÈÑ¡¥Ì%ÍÍÕ”¡…±±…¸¥Ì…±É•…‘ä…Ý…¥Ñ¥¹œ„‘•¥Í¥½¸¥¸Ñ¡”…ÁÁÉ½Ù…±ÌÅÕ•Õ”¸œ°(€€€€€€¤°(€€€€¤¹Ñ½	•QÉÕÑ¡ä ¤ì(€€€•áÁ•Ð¡±¥ÍÑ]½É­µ•¹‘µ•¹ÑÌ¤¹Ñ½!…Ù•	••¹…±±•‘]¥Ñ ¡=I}%°]=I-}%¤ì(€€€€¼¼Q¡”™¥±¥¹œ™½É´ÍÑ…åÌ¡¥‘‘•¸Ý¡¥±”Ñ¡”É•ÅÕ•ÍÐ¥ÌÁ•¹‘¥¹œ¸(€€€•áÁ•Ð (€€€€€ÍÉ••¸¹ÅÕ•Éå	åI½±” ‰ÕÑÑ½¸œ°ì¹…µ”è€I•ÅÕ•ÍÐ…¹•°€˜É•Á±…”œô¤°(€€€€¤¹Ñ½	•9Õ±° ¤ì(€ô¤ì((€¥Ð ¡¥‘•ÌÑ¡”½ÉÉ•Ñ¥½¸™½É´Ý¥Ñ¡½ÕÐµ½‘¥™äÉ¥¡ÑÌœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ…Á¤€ôÍÑÕ‰Á¤¡ì(€€€€€•Ñ%ÍÍÕ•¡…±±…¸èÙ¤¹™¸ ¤¹µ½­I•Í½±Ù•‘Y…±Õ” (€€€€€€€¥ÍÍÕ•¡…±±…¹•Ñ…¥°¡ì(€€€€€€€€€ÍÑ…ÑÕÌè€¥ÍÍÕ•œ°(€€€€€€€€€¡…±±…¹9Õµ‰•Èè€\´Äµ%¼Äœ°(€€€€€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€Ä°(€€€€€€€€€¥ÍÍÕ•‘Ðè€œÈÀÈØ´ÀÄ´ÄÕPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€ô¤°(€€€€€€¤°(€€€ô¤ì(€€€É•¹‘•È (€€€€€€ñ%ÍÍÕ•¡…±±…¹•Ñ…¥°(€€€€€€€…Á¤õí…Á¥ô(€€€€€€€½É…¹¥Í…Ñ¥½¹%õí=I}%ô(€€€€€€€¡…±±…¹%õí!119}%ô(€€€€€€€…¹5½‘¥™äõí™…±Í•ô(€€€€€€€…¹%ÍÍÕ”õí™…±Í•ô(€€€€€€€…¹…¹•°õí™…±Í•ô(€€€€€€€½¹‘¥ÐõíÙ¤¹™¸ ¥ô(€€€€€€€½¹•±•Ñ•õíÙ¤¹™¸ ¥ô(€€€€€€€½¹	…¬õíÙ¤¹™¸ ¥ô(€€€€€€¼ø°(€€€€¤ì(€€€…Ý…¥ÐÍÉ••¸¹™¥¹‘	åI½±” ¡•…‘¥¹œœ°ì¹…µ”è€%ÍÍÕ”¡…±±…¸\´Äµ%¼Äœô¤ì(€€€•áÁ•Ð¡ÍÉ••¸¹ÅÕ•Éå	åI½±” ¡•…‘¥¹œœ°ì¹…µ”è€I•ÅÕ•ÍÐ½ÉÉ•Ñ¥½¸œô¤¤¹Ñ½	•9Õ±° ¤ì(€ô¤ì)ô¤ì