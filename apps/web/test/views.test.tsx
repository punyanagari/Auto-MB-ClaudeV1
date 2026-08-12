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
  ChallanDetailResponse,
  ConfirmWorkRequest,
  EwayBill,
  LoaDocumentDetail,
  Membership,
  PurchaseOrder,
  PurchaseOrderDetailResponse,
  SaveChallanRequest,
  SaveIssueChallanRequest,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../src/api.js';
import { Approvals } from '../src/views/Approvals.js';
import { ChallanDetail } from '../src/views/ChallanDetail.js';
import { ChallanEditor } from '../src/views/ChallanEditor.js';
import { IssueChallanDetail } from '../src/views/IssueChallanDetail.js';
import { IssueChallanEditor } from '../src/views/IssueChallanEditor.js';
import { CompletionExtensions } from '../src/views/CompletionExtensions.js';
import { Installations } from '../src/views/Installations.js';
import { MeasurementBooks } from '../src/views/MeasurementBooks.js';
import { Members } from '../src/views/Members.js';
import { OperationsDashboard } from '../src/views/OperationsDashboard.js';
import { OperationsWorkspace } from '../src/views/OperationsWorkspace.js';
import { OrganisationOnboarding } from '../src/views/OrganisationOnboarding.js';
import { OrgPicker } from '../src/views/OrgPicker.js';
import { PaymentMatrix } from '../src/views/PaymentMatrix.js';
import { PacCertificates } from '../src/views/PacCertificates.js';
import { Quotations } from '../src/views/Quotations.js';
import { ReviewLoa } from '../src/views/ReviewLoa.js';
import { SerialLookup } from '../src/views/SerialLookup.js';
import { SignIn } from '../src/views/SignIn.js';
import { Timeline } from '../src/views/Timeline.js';
import { UploadLoa } from '../src/views/UploadLoa.js';
import { WorkDetail } from '../src/views/WorkDetail.js';
import { Works } from '../src/views/Works.js';

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
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const WORK_ID = '33333333-3333-4333-8333-333333333333';

const REVIEW_PAYLOAD = {
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

const REVIEW_DOCUMENT = {
  id: DOC_ID,
  originalFilename: 'loa-letter.pdf',
  sha256: 'a'.repeat(64),
  sizeBytes: 1234,
  extractionStatus: 'review' as const,
  confirmedWorkId: null,
  createdAt: '2026-08-08T00:00:00.000Z',
  extractionPayload: REVIEW_PAYLOAD,
};

function membership(overrides: Partial<Membership>): Membership {
  return {
    organisationId: ORG_ID,
    userId: 'user-a',
    role: 'owner',
    workScope: 'all',
    canIssueDocuments: true,
    canCancelDocuments: true,
    canApproveAmendments: false,
    status: 'active',
    ...overrides,
  };
}

describe('SignIn', () => {
  it('submits credentials and reports success', async () => {
    const api = stubApi();
    const onSignedIn = vi.fn();
    render(<SignIn api={api} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledOnce();
    });
    expect(api.signIn).toHaveBeenCalledWith('owner@example.test', 'password-123');
  });

  it('announces failures in an alert region and stays on the form', async () => {
    const api = stubApi({
      signIn: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(401, 'INVALID_CREDENTIALS', 'Wrong password.'),
        ),
    });
    const onSignedIn = vi.fn();
    render(<SignIn api={api} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert.teó:öÚ$z{-®éÜj×D5rÓÔÔ"Ór’’çFô&UG'WF‡’‚“°¢W‡V7B‡67&VVâævWD'•FW‡B‚~(+“C’ÃƒrÃƒS"ã“2r’’çFô&UG'WF‡’‚“°¢Ò“° ¢—B‚vFöW2æ÷B&W6VçBf–ÆVBF‚Ö–çfö–6R&Vv—7FW"2V×G’÷"7&VF&ÆRrÂ7–æ2‚’Óâ°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&V¦V7FVEfÇVR†æWrW'&÷"‚uVæf–Æ&ÆRâr’’À¢Æ—7D6öçF7G3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…´4Ä”TåEô4ôåD5EÒ’À¢Æ—7Ev÷&´ÖV7W&VÖVçD&öö·3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡²&öö·3¢¶&–ÆÆ&ÆT&öö²‚•ÒÒ’À¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢W‡V7B†v—B67&VVâæf–æD'•FW‡B‚õF‚–çfö–6W26÷VÆBæ÷B&RÆöFVBò’’çFô&UG'WF‡’‚“°¢W‡V7B‡67&VVâçVW'”'•FW‡B‚ôæòF‚–çfö–6R†2&VVâ&—6VBò’’çFô&TçVÆÂ‚“°¢W‡V7B‡67&VVâçVW'”'•&öÆR‚v'WGFöârÂ²æÖS¢tG&gBF‚–çfö–6RrÒ’’çFô&TçVÆÂ‚“°¢Ò“° ¢—B‚vöffW'2öæÇ’f–æÆ—¦VBÂVæ&–ÆÆVBÂæöâ×&V6÷&BÖV7W&VÖVçB&öö·2Fò&–ÆÂrÂ7–æ2‚’Óâ°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7D6öçF7G3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…´4Ä”TåEô4ôåD5EÒ’À¢Æ—7Ev÷&´ÖV7W&VÖVçD&öö·3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢&öö·3¢°¢&–ÆÆ&ÆT&öö²‚’À¢òò&V6÷&BÔ"—2ÖW&vVB&Vf÷&R&–ÆÆ–ærÂG&gB—2æ÷@¢òòf–æÆ—¦VBÂæBF†Rf–æÂÔ"&VÆ÷r•2&–ÆÆ&ÆRà¢&–ÆÆ&ÆT&öö²‡²–C¢vVVVSCCCBÓCCCBÓCCCBÓƒCCBÖVVVVVVVVVSCBrÂ¶–æC¢w&V6÷&BrÒ’À¢&–ÆÆ&ÆT&öö²‡°¢–C¢vVVVSSSSRÓSSSRÓCSSRÓƒSSRÖVVVVVVVVVSSRrÀ¢7FGW3¢vG&gBrÀ¢Ö$çVÖ&W#¢çVÆÂÀ¢Ò’À¢&–ÆÆ&ÆT&öö²‡°¢–C¢vVVVScccbÓcccbÓCccbÓƒccbÖVVVVVVVVVScbrÀ¢¶–æC¢vf–æÂrÀ¢—4f–æÃ¢G'VRÀ¢Ö$çVÖ&W#¢tD5rÓÔÔ"Ó"rÀ¢Ò’À¢ÒÀ¢Ò’À¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢6öç7B–6¶W"Òv—B67&VVâæf–æD'”Æ&VÅFW‡B‚tÖV7W&VÖVçB&öö²Fò&–ÆÂr“°¢6öç7BöffW&VBÒv—F†–â‡–6¶W"¢ævWDÆÄ'•&öÆR‚v÷F–öâr¢æÖ‚†÷F–öâ’Óâ÷F–öâçFW‡D6öçFVçBóòrr“°¢òòF†RÆ6V†öÆFW"ÇW2W†7FÇ’F†RGvò&–ÆÆ&ÆR&öö·2à¢W‡V7B†öffW&VBæÆVæwF‚’çFô&Rƒ2“°¢W‡V7B†öffW&VBç6öÖR‚†Æ&VÂ’ÓâÆ&VÂæ–æ6ÇVFW2‚tD5rÓÔÔ"Ór’’’çFô&R‡G'VR“°¢W‡V7B†öffW&VBç6öÖR‚†Æ&VÂ’ÓâÆ&VÂæ–æ6ÇVFW2‚tD5rÓÔÔ"Ó"r’’’çFô&R‡G'VR“°¢Ò“° ¢—B‚vFöW2æ÷BöffW"ÖV7W&VÖVçB&öö²F†BÆ—fR–çfö–6RÇ&VG’&–ÆÇ2rÂ7–æ2‚’Óâ°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7D6öçF7G3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…´4Ä”TåEô4ôåD5EÒ’À¢Æ—7Ev÷&´ÖV7W&VÖVçD&öö·3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡²&öö·3¢¶&–ÆÆ&ÆT&öö²‚•ÒÒ’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µ5T$Ô•EDTEô”ådô”4UÒ’À¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢v—B67&VVâæf–æD'•FW‡B‚uD’ó##bÓ#rór“°¢òò—G2öæÇ’&–ÆÆ&ÆRÔ"—2F¶VâÂ6òF†W&R—2æ÷F†–ærFòG&gBv–ç7Bà¢W‡V7B‡67&VVâçVW'”'”Æ&VÅFW‡B‚tÖV7W&VÖVçB&öö²Fò&–ÆÂr’’çFô&TçVÆÂ‚“°¢Ò“° ¢—B‚vG&gG2â–çfö–6Rg&öÒF†R–6¶VBÖV7W&VÖVçB&öö²rÂ7–æ2‚’Óâ°¢6öç7B7&VFUv÷&µF„–çfö–6RÒf’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢F„–çfö–6R‚’À¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò“°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7D6öçF7G3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…´4Ä”TåEô4ôåD5EÒ’À¢Æ—7Ev÷&´ÖV7W&VÖVçD&öö·3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡²&öö·3¢¶&–ÆÆ&ÆT&öö²‚•ÒÒ’À¢7&VFUv÷&µF„–çfö–6RÀ¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢F„–çfö–6R‚’À¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢f—&TWfVçBæ6†ævR†v—B67&VVâæf–æD'”Æ&VÅFW‡B‚tÖV7W&VÖVçB&öö²Fò&–ÆÂr’Â°¢F&vWC¢²fÇVS¢$”ÄÄ$ÄUôÔ%ô”BÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚t–çfö–6RFFRr’Â°¢F&vWC¢²fÇVS¢s##bÓrÓ3rÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚u426öFRr’Â°¢F&vWC¢²fÇVS¢s““ƒs3BrÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚u6W'f–6RFW67&—F–öâr’Â°¢F&vWC¢²fÇVS¢u&÷f—6–öâöb76VævW"ÖVæ—G’6W'f–6W2ârÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚tu5B&FR‚R’r’Â°¢F&vWC¢²fÇVS¢s‚rÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚uÆ6Röb7WÇ’r’Â°¢F&vWC¢²fÇVS¢s#rrÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚uF‚–&ÆRöâ&WfW'6R6†&vRr’Â°¢F&vWC¢²fÇVS¢vfÇ6RrÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚t'W–W"r’Â°¢F&vWC¢²fÇVS¢4Ä”TåEô4ôåD5Eô”BÒÀ¢Ò“°¢f—&TWfVçBæ6Æ–6²‡7V&Ö—D'WGFöâ‚t7&VFRG&gBr’“° ¢v—Bv—Df÷"‚‚’Óâ°¢W‡V7B†7&VFUv÷&µF„–çfö–6R’çFô†fT&VVä6ÆÆVEv—F‚„õ$uô”BÂtõ$µô”BÂ°¢ÖV7W&VÖVçD&öö´–C¢$”ÄÄ$ÄUôÔ%ô”BÀ¢–çfö–6TFFS¢s##bÓrÓ3rÀ¢646öFS¢s““ƒs3BrÀ¢6W'f–6TFW67&—F–öã¢u&÷f—6–öâöb76VævW"ÖVæ—G’6W'f–6W2ârÀ¢w7E&FS¢s‚rÀ¢Æ6Töe7WÇ“¢s#rrÀ¢&WfW'6T6†&vTÆ–6&ÆS¢fÇ6RÀ¢'W–W$6öçF7D–C¢4Ä”TåEô4ôåD5Eô”BÀ¢Ò“°¢Ò“°¢Ò“° ¢—B‚w6†÷w2F†Rg&÷¦Vâ4u5Bõ4u5B7Æ—BæB†–FW2F†R”u5B&÷rv—F†–âF†R7FFRrÂ7–æ2‚’Óâ°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µ5T$Ô•EDTEô”ådô”4UÒ’À¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢5T$Ô•EDTEô”ådô”4RÀ¢'W–W%6æ6†÷C¢²FW6–væF–öã¢t6VçG&Â&–Çv’×VÖ&’F—f—6–öârÒÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Æ—7D–çfö–6TWv”&–ÆÇ3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µÒ’À¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢uD’ó##bÓ#rórÒ’“° ¢W‡V7B†v—B67&VVâæf–æD'•FW‡B‚uF†&ÆRfÇVRr’’çFô&UG'WF‡’‚“°¢W‡V7B‡67&VVâævWD'•FW‡B‚t4u5Br’’çFô&UG'WF‡’‚“°¢W‡V7B‡67&VVâævWD'•FW‡B‚u4u5Br’’çFô&UG'WF‡’‚“°¢òòâ–çG&×7FFR–çfö–6R6'&–W2æò”u5BÂæB¦W&ò&÷rv÷VÆBöæÇ¢òò–çf—FRF†R&VFW"FòvöæFW"v†B—BÖVç2à¢W‡V7B‡67&VVâçVW'”'•FW‡B‚t”u5Br’’çFô&TçVÆÂ‚“°¢W‡V7B‡67&VVâævWDÆÄ'•FW‡B‚~(+“2ÃƒÃC#’ãCbr’æÆVæwF‚’çFô&Rƒ"“°¢Ò“° ¢—B‚vvVæW&FW2æBW‡÷6W2F†R7F÷&VBF‚Ö–çfö–6RDb6öçG&öÇ2rÂ7–æ2‚’Óâ°¢6öç7B&VæFW%F„–çfö–6RÒf’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢F„–çfö–6R‡²ââå5T$Ô•EDTEô”ådô”4RÂ&VæFW&VDf–Æ&ÆS¢G'VRÒ’À¢'W–W%6æ6†÷C¢çVÆÂÀ¢6†—Fõ6æ6†÷C¢çVÆÂÀ¢—77VVE6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò“°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µ5T$Ô•EDTEô”ådô”4UÒ’À¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢5T$Ô•EDTEô”ådô”4RÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6†—Fõ6æ6†÷C¢çVÆÂÀ¢—77VVE6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Æ—7D–çfö–6TWv”&–ÆÇ3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µÒ’À¢&VæFW%F„–çfö–6RÀ¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“°¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢uD’ó##bÓ#rórÒ’“° ¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢tvVæW&FRDbrÒ’“°¢v—Bv—Df÷"‚‚’Óâ°¢W‡V7B‡&VæFW%F„–çfö–6R’çFô†fT&VVä6ÆÆVEv—F‚„õ$uô”BÂD…ô”ådô”4Uô”B“°¢Ò“° ¢6ÆVçW‚“°¢6öç7B&VæFW&VD–çfö–6RÒF„–çfö–6R‡°¢ââå5T$Ô•EDTEô”ådô”4RÀ¢&VæFW&VDf–Æ&ÆS¢G'VRÀ¢Ò“°¢6öç7B&VæFW&VD’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…·&VæFW&VD–çfö–6UÒ’À¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢&VæFW&VD–çfö–6RÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6†—Fõ6æ6†÷C¢çVÆÂÀ¢—77VVE6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Æ—7D–çfö–6TWv”&–ÆÇ3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µÒ’À¢Ò“°¢&VæFW$–çfö–6Uv÷&²‡&VæFW&VD’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“°¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢uD’ó##bÓ#rórÒ’“°¢W‡V7B†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢u&VvVæW&FRDbrÒ’’çFô&UG'WF‡’‚“°¢W‡V7B‡67&VVâævWD'•&öÆR‚v'WGFöârÂ²æÖS¢t÷VâDbrÒ’’çFô&UG'WF‡’‚“°¢Ò“° ¢—B‚w6†÷w2”u5BÆöæR7&÷727FFW2rÂ7–æ2‚’Óâ°¢6öç7B–çFW%7FFRÒF„–çfö–6R‡°¢ââå5T$Ô•EDTEô”ådô”4RÀ¢Æ6Töe7WÇ“¢srrÀ¢6w7DÖ÷VçC¢sãrÀ¢6w7DÖ÷VçC¢sãrÀ¢–w7DÖ÷VçC¢sscƒS‚ã“"rÀ¢Ò“°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…¶–çFW%7FFUÒ’À¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢–çFW%7FFRÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Æ—7D–çfö–6TWv”&–ÆÇ3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µÒ’À¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢uD’ó##bÓ#rórÒ’“° ¢W‡V7B†v—B67&VVâæf–æD'•FW‡B‚t”u5Br’’çFô&UG'WF‡’‚“°¢W‡V7B‡67&VVâçVW'”'•FW‡B‚t4u5Br’’çFô&TçVÆÂ‚“°¢W‡V7B‡67&VVâçVW'”'•FW‡B‚u4u5Br’’çFô&TçVÆÂ‚“°¢Ò“° ¢—B‚w&V6÷&G2v†BF†R•%ç7vW&VB&F†W"F†âÖ–çF–ærâ•$ârÂ7–æ2‚’Óâ°¢6öç7B&V6÷&EF„–çfö–6T—'&W7öç6RÒf’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢5T$Ô•EDTEô”ådô”4RÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢w6–væVBrÀ¢Ò“°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µ5T$Ô•EDTEô”ådô”4UÒ’À¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢5T$Ô•EDTEô”ådô”4RÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Æ—7D–çfö–6TWv”&–ÆÇ3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µÒ’À¢&V6÷&EF„–çfö–6T—'&W7öç6RÀ¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢uD’ó##bÓ#rórÒ’“°¢f—&TWfVçBæ6Æ–6²€¢v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ°¢æÖS¢tÖçVÂ6ö×F–&–Æ—G’–×÷'B‡VçfW&–f–VB’rÀ¢Ò’À¢“° ¢6öç7B—&âÒvfFc3–C3C#S&#SS“C–3C3#f“CSƒs3sF3c“6VC#ccVC#vC“&F&#33rs°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚t•$âr’Â²F&vWC¢²fÇVS¢—&âÒÒ“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚t6¶æ÷vÆVFvVÖVçBçVÖ&W"r’Â°¢F&vWC¢²fÇVS¢s##c33ƒCCcCS‚rÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚t6¶æ÷vÆVFvVÖVçBFFRr’Â°¢F&vWC¢²fÇVS¢s##bÓrÓ3C#£’rÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚u÷'FÂ6¶æ÷vÆVFvVÖVçBFW‡B†W†7B’r’Â°¢F&vWC¢²fÇVS¢s3óró##b#£“£rÒÀ¢Ò“°¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚u6–væVB"r’Â°¢F&vWC¢²fÇVS¢vW”¦†$v6”ö’rÒÀ¢Ò“°¢f—&TWfVçBæ6Æ–6²‡7V&Ö—D'WGFöâ‚u&V6÷&B&W7öç6Rr’“° ¢v—Bv—Df÷"‚‚’Óâ°¢W‡V7B‡&V6÷&EF„–çfö–6T—'&W7öç6R’çFô†fT&VVä6ÆÆVEv—F‚€¢õ$uô”BÀ¢D…ô”ådô”4Uô”BÀ¢W‡V7Bæö&¦V7D6öçF–æ–ær‡°¢—&âÀ¢6´çVÖ&W#¢s##c33ƒCCcCS‚rÀ¢6–væVE#¢vW”¦†$v6”ö’rÀ¢Ò’À¢“°¢Ò“°¢Ò“° ¢—B‚vW‡Æ–ç2426öçF–æÖVçBæBW‡÷6W2öæÇ’Æöö·W&V6÷fW'’f÷"†—7F÷&–6ÂVæ¶æ÷vâUt"Wf–FVæ6RrÂ7–æ2‚’Óâ°¢6öç7BVæ¶æ÷vä&–ÆÂÒWv”&–ÆÂ‚“°¢6öç7BvVæW&FTWv”&–ÆÂÒf’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡²Wv”&–ÆÃ¢Væ¶æ÷vä&–ÆÂÒ“°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µ5T$Ô•EDTEô”ådô”4UÒ’À¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢5T$Ô•EDTEô”ådô”4RÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Æ—7D–çfö–6TWv”&–ÆÇ3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…·Væ¶æ÷vä&–ÆÅÒ’À¢vVæW&FTWv”&–ÆÂÀ¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢uD’ó##bÓ#rórÒ’“°¢W‡V7B€¢v—B67&VVâæf–æD'•FW‡B‚ôg&W6‚R×v’&–ÆÂvVæW&F–öâ—2Væf–Æ&ÆRò’À¢’çFô&UG'WF‡’‚“°¢W‡V7B‡67&VVâçVW'”'•&öÆR‚v'WGFöârÂ²æÖS¢tG&gBâR×v’&–ÆÂrÒ’’çFô&TçVÆÂ‚“°¢W‡V7B‡67&VVâçVW'”'•&öÆR‚v'WGFöârÂ²æÖS¢tvVæW&FRBv†—FV&öö·2rÒ’’çFô&TçVÆÂ‚“° ¢f—&TWfVçBæ6Æ–6²‡67&VVâævWD'•&öÆR‚v'WGFöârÂ²æÖS¢u&V6öæ6–ÆRrÒ’“°¢v—Bv—Df÷"‚‚’Óâ°¢W‡V7B†vVæW&FTWv”&–ÆÂ’çFô†fT&VVä6ÆÆVEv—F‚€¢õ$uô”BÀ¢vVVVSsssrÓsssrÓCssrÓƒssrÖVVVVVVVVVSsrrÀ¢“°¢Ò“°¢Ò“° ¢—B‚wW6W2F†RUt"6æ6VÆÆF–öâ&V6öâÖ6öFRÖVæ–æw2Âæ÷BF†R•%Ö–ærrÂ7–æ2‚’Óâ°¢6öç7BvVæW&FVD&–ÆÂÒWv”&–ÆÂ‡°¢7FGW3¢vvVæW&FVBrÀ¢&÷f–FW%7FFS¢vvVæW&FVBrÀ¢Wv$çVÖ&W#¢s#3CScsƒ“"rÀ¢Wv$FFS¢s##bÓrÓ3Cs££ã¢rÀ¢fÆ–EVçF–Ã¢s##bÓrÓ3C#3£S“£S’ã¢rÀ¢Wv$FFUFW‡C¢s3óró##b#£3£rÀ¢fÆ–EVçF–ÅFW‡C¢s3óró##b#3£S“£S’rÀ¢vVæW&FVDC¢s##bÓrÓ3Cs££ã¢rÀ¢Ò“°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µ5T$Ô•EDTEô”ådô”4UÒ’À¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢5T$Ô•EDTEô”ådô”4RÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Æ—7D–çfö–6TWv”&–ÆÇ3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…¶vVæW&FVD&–ÆÅÒ’À¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢uD’ó##bÓ#rórÒ’“°¢f—&TWfVçBæ6Æ–6²€¢v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ°¢æÖS¢t6æ6VÂUt"#3CScsƒ“"Bv†—FV&öö·2rÀ¢Ò’À¢“°¢6öç7B&V6öâÒ67&VVâævWD'”Æ&VÅFW‡CÄ…DÔÅ6VÆV7DVÆVÖVçCâ‚u&V6öâr“°¢W‡V7B€¢v—F†–â‡&V6öâ¢ævWD'•&öÆR‚v÷F–öârÂ²æÖS¢t÷&FW"6æ6VÆÆVBrÒ¢ævWDGG&–'WFR‚wfÇVRr’À¢’çFô&R‚s"r“°¢W‡V7B€¢v—F†–â‡&V6öâ¢ævWD'•&öÆR‚v÷F–öârÂ²æÖS¢tFFVçG'’Ö—7F¶RrÒ¢ævWDGG&–'WFR‚wfÇVRr’À¢’çFô&R‚s2r“°¢Ò“° ¢—B‚w&WV—&W2æ÷FRFò6æ6VÂÂæB6—2F†RÖV7W&VÖVçB&öö²—2&VÆV6VBrÂ7–æ2‚’Óâ°¢6öç7B6æ6VÅF„–çfö–6RÒf’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢5T$Ô•EDTEô”ådô”4RÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò“°¢6öç7B’Ò7GV$’‡°¢vWEv÷&³¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR†6†ÆÆåv÷&²‚’’À¢Æ—7Ev÷&µF„–çfö–6W3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µ5T$Ô•EDTEô”ådô”4UÒ’À¢vWEF„–çfö–6S¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR‡°¢–çfö–6S¢5T$Ô•EDTEô”ådô”4RÀ¢'W–W%6æ6†÷C¢çVÆÂÀ¢6–væVE#¢çVÆÂÀ¢Ò’À¢Æ—7D–çfö–6TWv”&–ÆÇ3¢f’æfâ‚’æÖö6µ&W6öÇfVEfÇVR…µÒ’À¢6æ6VÅF„–çfö–6RÀ¢Ò“°¢&VæFW$–çfö–6Uv÷&²†’“°¢v—B÷Våv÷&µF"‚t&–ÆÇ2r“° ¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢uD’ó##bÓ#rórÒ’“°¢f—&TWfVçBæ6Æ–6²†v—B67&VVâæf–æD'•&öÆR‚v'WGFöârÂ²æÖS¢t6æ6VÂF†—2–çfö–6RrÒ’“° ¢f—&TWfVçBæ6†ævR‡67&VVâævWD'”Æ&VÅFW‡B‚uv‡’—B—2&V–ær6æ6VÆÆVBr’Â°¢F&vWC¢²fÇVS¢uw&öærÆ6Röb7WÇ’ârÒÀ¢Ò“°¢f—&TWfVçBæ6Æ–6²‡7V&Ö—D'WGFöâ‚t6æ6VÂ–çfö–6Rr’“° ¢v—Bv—Df÷"‚‚’Óâ°¢W‡V7B†6æ6VÅF„–çfö–6R’çFô†fT&VVä6ÆÆVEv—F‚„õ$uô”BÂD…ô”ådô”4Uô”BÂ°¢æ÷FS¢uw&öærÆ6Röb7WÇ’ârÀ¢Ò“°¢Ò“°¢Ò“°§Ò“° 