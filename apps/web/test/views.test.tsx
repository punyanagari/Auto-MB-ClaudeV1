// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChallanDetailResponse,
  ConfirmWorkRequest,
  Membership,
  SaveChallanRequest,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../src/api.js';
import { Approvals } from '../src/views/Approvals.js';
import { ChallanDetail } from '../src/views/ChallanDetail.js';
import { ChallanEditor } from '../src/views/ChallanEditor.js';
import { CompletionExtensions } from '../src/views/CompletionExtensions.js';
import { Installations } from '../src/views/Installations.js';
import { MeasurementBooks } from '../src/views/MeasurementBooks.js';
import { Members } from '../src/views/Members.js';
import { OrgPicker } from '../src/views/OrgPicker.js';
import { PaymentMatrix } from '../src/views/PaymentMatrix.js';
import { PacCertificates } from '../src/views/PacCertificates.js';
import { ReviewLoa } from '../src/views/ReviewLoa.js';
import { SerialLookup } from '../src/views/SerialLookup.js';
import { SignIn } from '../src/views/SignIn.js';
import { Timeline } from '../src/views/Timeline.js';
import { UploadLoa } from '../src/views/UploadLoa.js';
import { WorkDetail } from '../src/views/WorkDetail.js';
import { Works } from '../src/views/Works.js';

afterEach(cleanup);

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
    completeWork: vi.fn(),
    reopenWork: vi.fn(),
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
    expect(alert.textContent).toBe('Wrong password.');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('collects a name when switched to account creation', async () => {
    const api = stubApi();
    render(<SignIn api={api} onSignedIn={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'New here? Create an account' }),
    );
    fireEvent.change(screen.getByLabelText('Full name'), {
      target: { value: 'Owner Person' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(api.signUp).toHaveBeenCalledWith(
        'owner@example.test',
        'Owner Person',
        'password-123',
      );
    });
  });
});

describe('OrgPicker', () => {
  it('lists organisations and reports the selection', async () => {
    const api = stubApi({
      listOrganisations: vi
        .fn()
        .mockResolvedValue([
          { id: ORG_ID, name: 'Sharma Constructions', slug: 'sharma' },
        ]),
    });
    const onSelect = vi.fn();
    render(<OrgPicker api={api} onSelect={onSelect} onCreated={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Sharma Constructions/ }),
    );
    expect(onSelect).toHaveBeenCalledWith({
      id: ORG_ID,
      name: 'Sharma Constructions',
      slug: 'sharma',
    });
  });

  it('creates an organisation and surfaces slug collisions', async () => {
    const api = stubApi({
      createOrganisation: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(409, 'SLUG_TAKEN', 'Slug already exists.'),
        ),
    });
    render(<OrgPicker api={api} onSelect={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Organisation name'), {
      target: { value: 'Sharma Constructions' },
    });
    fireEvent.change(screen.getByLabelText('Short identifier'), {
      target: { value: 'sharma' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organisation' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Slug already exists.');
  });
});

describe('Members', () => {
  it('shows the member table and the add form to owners', async () => {
    const api = stubApi({
      listMembers: vi
        .fn()
        .mockResolvedValue([
          membership({ userId: 'user-a', role: 'owner' }),
          membership({ userId: 'user-b', role: 'viewer', canIssueDocuments: false }),
        ]),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-a" />);

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByLabelText('Account email')).toBeTruthy();
  });

  it('hides member management from non-owners', async () => {
    const api = stubApi({
      listMembers: vi
        .fn()
        .mockResolvedValue([
          membership({ userId: 'user-a', role: 'owner' }),
          membership({ userId: 'user-b', role: 'viewer' }),
        ]),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-b" />);

    await screen.findByRole('table');
    expect(screen.queryByLabelText('Account email')).toBeNull();
  });

  it('adds a member and announces the outcome', async () => {
    const grown = [
      membership({ userId: 'user-a', role: 'owner' }),
      membership({ userId: 'user-c', role: 'viewer' }),
    ];
    const api = stubApi({
      listMembers: vi.fn().mockResolvedValue([membership({ userId: 'user-a' })]),
      addMember: vi.fn().mockResolvedValue(grown),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-a" />);

    fireEvent.change(await screen.findByLabelText('Account email'), {
      target: { value: 'viewer@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('viewer@example.test');
    });
    expect(api.addMember).toHaveBeenCalledWith(ORG_ID, {
      email: 'viewer@example.test',
      role: 'viewer',
    });
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('Works', () => {
  it('lists Works and review-ready documents, and routes the actions', async () => {
    const api = stubApi({
      listWorks: vi.fn().mockResolvedValue([
        {
          id: WORK_ID,
          workCode: 'PL270-CRB',
          letterNumber: 'L-42/2025',
          letterDate: '2025-06-01',
          title: 'Supply of switchboards',
          advertisedValue: '1000.00',
          contractValue: '900.00',
          pricingShape: 'letter_percentage',
          letterPercentage: '10.000',
          letterPercentageDirection: 'below',
          status: 'active',
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      ]),
      listLoaDocuments: vi
        .fn()
        .mockResolvedValue([{ ...REVIEW_DOCUMENT, extractionPayload: undefined }]),
    });
    const onReview = vi.fn();
    const onOpenWork = vi.fn();
    render(
      <Works
        api={api}
        organisationId={ORG_ID}
        canModify
        onUpload={vi.fn()}
        onReview={onReview}
        onOpenWork={onOpenWork}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledWith(DOC_ID);

    fireEvent.click(screen.getByRole('button', { name: 'PL270-CRB' }));
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
  });

  it('hides the upload action from read-only roles', async () => {
    const api = stubApi();
    render(
      <Works
        api={api}
        organisationId={ORG_ID}
        canModify={false}
        onUpload={vi.fn()}
        onReview={vi.fn()}
        onOpenWork={vi.fn()}
      />,
    );
    await screen.findByText(/No Works yet/);
    expect(screen.queryByRole('button', { name: 'Upload LOA' })).toBeNull();
  });
});

describe('UploadLoa', () => {
  it('requires a chosen file before uploading', async () => {
    const api = stubApi();
    render(
      <UploadLoa
        api={api}
        organisationId={ORG_ID}
        onUploaded={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.submit(
      screen.getByRole('button', { name: 'Upload and extract' }).closest('form') ??
        (() => {
          throw new Error('form missing');
        })(),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Choose the Letter of Acceptance PDF');
    expect(api.uploadLoa).not.toHaveBeenCalled();
  });
});

describe('ReviewLoa', () => {
  it('prefills parsed values, shows flags with printed source, and confirms', async () => {
    const confirmLoa = vi.fn().mockResolvedValue({
      work: { id: WORK_ID },
      schedules: [],
    });
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      confirmLoa,
    });
    const onConfirmed = vi.fn();
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={onConfirmed}
        onBack={vi.fn()}
      />,
    );

    // Parsed values arrive as editable prefills with their provenance.
    const letterNumber = await screen.findByLabelText('Letter number');
    expect((letterNumber as HTMLInputElement).value).toBe('L-42/2025');
    expect(screen.getByText('The printed unit could not be resolved.')).toBeTruthy();
    expect(screen.getByText('Route Kilo Meter (RKM)')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL270-CRB' },
    });
    fireEvent.change(screen.getByLabelText('Rate for row 1 in schedule A'), {
      target: { value: '451.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledOnce();
    });
    const [orgArg, docArg, requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(orgArg).toBe(ORG_ID);
    expect(docArg).toBe(DOC_ID);
    expect(requestArg.workCode).toBe('PL270-CRB');
    expect(requestArg.letterPercentage).toBe('10.000');
    expect(requestArg.letterPercentageDirection).toBe('below');
    expect(requestArg.schedules).toHaveLength(1);
    expect(requestArg.schedules[0]?.items[0]).toMatchObject({
      itemNumber: 'A/1',
      effectiveRate: '451.00',
      sourceRef: { scheduleId: 'A', itemSno: '1' },
    });
  });

  it('lets read-only roles review but not confirm', async () => {
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify={false}
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    await screen.findByLabelText('Letter number');
    expect(
      screen.queryByRole('button', { name: 'Confirm and create Work' }),
    ).toBeNull();
    expect(screen.getByText(/ask an owner or office member/)).toBeTruthy();
  });
});

const CHALLAN_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_A = '55555555-5555-4555-8555-555555555555';

const BALANCE = {
  allowExcessDelivery: false,
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

function challanDetail(
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

describe('ChallanEditor', () => {
  it('shows remaining balances and saves a draft with the entered quantities', async () => {
    const createChallan = vi.fn().mockResolvedValue(challanDetail());
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createChallan,
    });
    const onSaved = vi.fn();
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByText('2.000')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G)' },
    });
    fireEvent.change(screen.getByLabelText('Consignee address'), {
      target: { value: 'Delhi Division' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(CHALLAN_ID);
    });
    const [, , body] = createChallan.mock.calls[0] as [
      string,
      string,
      SaveChallanRequest,
    ];
    expect(body.prefix).toBe('DCW-1');
    expect(body.items).toEqual([{ workItemId: ITEM_A, quantity: '2' }]);
  });

  it('refuses to save an empty challan', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G)' },
    });
    fireEvent.change(screen.getByLabelText('Consignee address'), {
      target: { value: 'Delhi Division' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('at least one item');
    expect(api.createChallan).not.toHaveBeenCalled();
  });

  it('routes to the existing draft on a DRAFT_EXISTS conflict', async () => {
    const existingId = 'cccc5555-5555-4555-8555-555555555555';
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createChallan: vi.fn().mockRejectedValue(
        new RequestFailedError(409, 'DRAFT_EXISTS', 'A draft already exists.', {
          existingRecordId: existingId,
        }),
      ),
    });
    const onSaved = vi.fn();
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G)' },
    });
    fireEvent.change(screen.getByLabelText('Consignee address'), {
      target: { value: 'Delhi Division' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(existingId);
    });
  });
});

describe('ChallanDetail', () => {
  it('issues a draft when the member holds the issue authority', async () => {
    const issueChallan = vi.fn().mockResolvedValue(
      challanDetail({
        status: 'issued',
        challanNumber: 'DC/1',
        sequenceNumber: 1,
        issuedAt: '2026-08-08T10:00:00.000Z',
      }),
    );
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(challanDetail()),
      issueChallan,
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify
        canIssue
        canCancel={false}
        canRecordEvidence
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Issue challan' }));
    await waitFor(() => {
      expect(issueChallan).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID);
    });
    expect(
      await screen.findByRole('heading', { name: 'Delivery Challan DC/1' }),
    ).toBeTruthy();
  });

  it('hides issue from members without the authority and cancels with a note', async () => {
    const cancelChallan = vi.fn().mockResolvedValue(
      challanDetail({
        status: 'cancelled',
        challanNumber: 'DC/1',
        sequenceNumber: 1,
        issuedAt: '2026-08-08T10:00:00.000Z',
        cancelledAt: '2026-08-09T10:00:00.000Z',
        cancellationNote: 'Wrong consignee.',
      }),
    );
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(
        challanDetail({
          status: 'issued',
          challanNumber: 'DC/1',
          sequenceNumber: 1,
          issuedAt: '2026-08-08T10:00:00.000Z',
        }),
      ),
      cancelChallan,
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel
        canRecordEvidence={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    await screen.findByRole('heading', { name: 'Delivery Challan DC/1' });
    expect(screen.queryByRole('button', { name: 'Issue challan' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Cancellation note'), {
      target: { value: 'Wrong consignee.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel challan' }));
    await waitFor(() => {
      expect(cancelChallan).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        note: 'Wrong consignee.',
      });
    });
    expect(await screen.findByText(/Cancelled: Wrong consignee\./)).toBeTruthy();
  });

  const ISSUED = () =>
    challanDetail({
      status: 'issued',
      challanNumber: 'DC/1',
      sequenceNumber: 1,
      issuedAt: '2026-08-08T10:00:00.000Z',
    });

  const SERIAL = {
    id: '88888888-8888-4888-8888-888888888888',
    deliveryChallanId: CHALLAN_ID,
    challanItemId: '66666666-6666-4666-8666-666666666666',
    challanNumber: 'DC/1',
    itemDescription: 'Main switchboard',
    serialNumber: 'SN-001',
    installedOn: null,
    installationRemarks: null,
  };

  it('records a delivery receipt on an issued challan', async () => {
    const recordReceipt = vi.fn().mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      deliveryChallanId: CHALLAN_ID,
      receivedOn: '2026-08-05',
      receivedBy: 'SSE/Signal/Delhi',
      remarks: null,
      createdAt: '2026-08-05T00:00:00.000Z',
    });
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(ISSUED()),
      recordReceipt,
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel={false}
        canRecordEvidence
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Received on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('Received by'), {
      target: { value: 'SSE/Signal/Delhi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));

    await waitFor(() => {
      expect(recordReceipt).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        receivedOn: '2026-08-05',
        receivedBy: 'SSE/Signal/Delhi',
      });
    });
    // The recorded receipt replaces the form with the acknowledgement facts.
    expect(await screen.findByText('SSE/Signal/Delhi')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record receipt' })).toBeNull();
  });

  it('records serials for a line and then an installation', async () => {
    const recordSerials = vi.fn().mockResolvedValue([SERIAL]);
    const recordInstallation = vi
      .fn()
      .mockResolvedValue([{ ...SERIAL, installedOn: '2026-08-06' }]);
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(ISSUED()),
      recordSerials,
      recordInstallation,
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel={false}
        canRecordEvidence
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Serial numbers (one per line)'), {
      target: { value: 'SN-001\n\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record serials' }));

    await waitFor(() => {
      expect(recordSerials).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        challanItemId: '66666666-6666-4666-8666-666666666666',
        serialNumbers: ['SN-001'],
      });
    });
    // The serial shows in the table and in the installation picker.
    expect((await screen.findAllByText('SN-001')).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Installed on'), {
      target: { value: '2026-08-06' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record installation' }));
    await waitFor(() => {
      expect(recordInstallation).toHaveBeenCalledWith(ORG_ID, SERIAL.id, {
        installedOn: '2026-08-06',
      });
    });
    expect(await screen.findByText('installed 2026-08-06')).toBeTruthy();
  });

  it('shows evidence read-only to members without the evidence roles', async () => {
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(ISSUED()),
      getReceipt: vi.fn().mockResolvedValue(null),
      listWorkSerials: vi.fn().mockResolvedValue([SERIAL]),
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel={false}
        canRecordEvidence={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(await screen.findByText('No receipt recorded yet.')).toBeTruthy();
    expect(screen.getByText('SN-001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record receipt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record serials' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record installation' })).toBeNull();
  });

  it('marks an issued challan that carries a warranty certificate', async () => {
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(
        challanDetail({
          status: 'issued',
          challanNumber: 'DC/1',
          sequenceNumber: 1,
          issuedAt: '2026-08-08T10:00:00.000Z',
          warrantyTemplateVersion: 'wc-v1',
          warrantyTextSha256: 'ab'.repeat(32),
        }),
      ),
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel={false}
        canRecordEvidence={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(await screen.findByText('Warranty certificate')).toBeTruthy();
    expect(screen.getByText('Included (template wc-v1)')).toBeTruthy();
  });

  it('marks an issued challan without a certificate, and drafts not at all', async () => {
    const api = stubApi({ getChallan: vi.fn().mockResolvedValue(ISSUED()) });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel={false}
        canRecordEvidence={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(await screen.findByText('Warranty certificate')).toBeTruthy();
    expect(screen.getByText('Not included')).toBeTruthy();
    cleanup();

    const draftApi = stubApi({
      getChallan: vi.fn().mockResolvedValue(challanDetail()),
    });
    render(
      <ChallanDetail
        api={draftApi}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel={false}
        canRecordEvidence={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { name: 'Draft Delivery Challan' });
    expect(screen.queryByText('Warranty certificate')).toBeNull();
  });
});

describe('WorkDetail retention', () => {
  const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
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
            requiresSerials: false,
          },
        ],
      },
    ],
  };

  const ISSUED_CHALLAN = {
    ...challanDetail({
      status: 'issued',
      challanNumber: 'DC/1',
      sequenceNumber: 1,
      issuedAt: '2026-08-08T10:00:00.000Z',
    }).challan,
  };

  const INSTRUMENT = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workId: WORK_ID,
    kind: 'pbg' as const,
    reference: 'BG/22',
    amount: '45000.00',
    issuedOn: '2026-01-10',
    expiresOn: '2026-09-15',
    status: 'active' as const,
    notes: null,
    createdAt: '2026-01-10T00:00:00.000Z',
  };

  const MB_ENTRY = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workItemId: ITEM_A,
    itemNumber: 'A/1',
    deliveryChallanId: CHALLAN_ID,
    measuredQuantity: '2.000',
    measuredOn: '2026-08-01',
    mbBookRef: 'MB-12/34',
    remarks: null,
    billId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  };

  const BILL = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workId: WORK_ID,
    billNumber: 1,
    status: 'prepared' as const,
    totalAmount: '200.00',
    linesSnapshot: [
      {
        workItemId: ITEM_A,
        itemNumber: 'A/1',
        unitCode: 'Nos',
        quantity: '2.000',
        rate: '100.00',
        amount: '200.00',
      },
    ],
    createdAt: '2026-08-02T00:00:00.000Z',
    submittedAt: null,
    paidAt: null,
  };

  function renderWorkDetail(
    api: ApiClient,
    flags: Partial<{
      canModify: boolean;
      canRecordEvidence: boolean;
      canIssue: boolean;
      canCancel: boolean;
      canApprove: boolean;
      isOwner: boolean;
    }> = {},
  ) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={flags.canModify ?? true}
        canRecordEvidence={flags.canRecordEvidence ?? true}
        canIssue={flags.canIssue ?? true}
        canCancel={flags.canCancel ?? true}
        canApprove={flags.canApprove ?? false}
        isOwner={flags.isOwner ?? false}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  function retentionApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      getWork: vi.fn().mockResolvedValue(WORK_DETAIL),
      listChallans: vi.fn().mockResolvedValue([ISSUED_CHALLAN]),
      listInstruments: vi.fn().mockResolvedValue([INSTRUMENT]),
      listMbEntries: vi.fn().mockResolvedValue([MB_ENTRY]),
      listBills: vi.fn().mockResolvedValue([BILL]),
      listWorkSerials: vi.fn().mockResolvedValue([]),
      ...overrides,
    });
  }

  it('offers Generate PDF for an unrendered correction notice on the Work page', async () => {
    const NOTICE_ID = 'bbbb4444-4444-4444-8444-444444444444';
    const notice = {
      id: NOTICE_ID,
      workId: WORK_ID,
      deliveryChallanId: CHALLAN_ID,
      approvalRequestId: '99999999-9999-4999-8999-999999999999',
      noticeNumber: 'DCW-1-CN-01',
      sequenceNumber: 1,
      status: 'issued' as const,
      templateVersion: 'correction-notice-v1',
      renderedAvailable: false,
      cancellationNote: null,
      createdAt: '2026-08-09T00:00:00.000Z',
      cancelledAt: null,
    };
    const renderCorrectionNotice = vi.fn().mockResolvedValue({});
    const listWorkCorrectionNotices = vi
      .fn()
      .mockResolvedValueOnce([notice])
      .mockResolvedValue([{ ...notice, renderedAvailable: true }]);
    const api = retentionApi({ renderCorrectionNotice, listWorkCorrectionNotices });
    renderWorkDetail(api);

    // A fresh notice is born unrendered: the Work page offers the render
    // action rather than a dead-end "not rendered".
    fireEvent.click(await screen.findByRole('button', { name: 'Generate PDF' }));
    await waitFor(() => {
      expect(renderCorrectionNotice).toHaveBeenCalledWith(ORG_ID, NOTICE_ID);
    });
    expect(await screen.findByRole('button', { name: 'Open PDF' })).toBeTruthy();
  });

  it('shows no render action for correction notices without modify rights', async () => {
    const api = retentionApi({
      listWorkCorrectionNotices: vi.fn().mockResolvedValue([
        {
          id: 'bbbb4444-4444-4444-8444-444444444444',
          workId: WORK_ID,
          deliveryChallanId: CHALLAN_ID,
          approvalRequestId: '99999999-9999-4999-8999-999999999999',
          noticeNumber: 'DCW-1-CN-01',
          sequenceNumber: 1,
          status: 'issued' as const,
          templateVersion: 'correction-notice-v1',
          renderedAvailable: false,
          cancellationNote: null,
          createdAt: '2026-08-09T00:00:00.000Z',
          cancelledAt: null,
        },
      ]),
    });
    renderWorkDetail(api, { canModify: false });
    expect(await screen.findByText('DCW-1-CN-01')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate PDF' })).toBeNull();
    expect(screen.getByText('not rendered')).toBeTruthy();
  });

  it('records a measurement with challan provenance', async () => {
    const recordMbEntry = vi.fn().mockResolvedValue({
      ...MB_ENTRY,
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      measuredQuantity: '1.000',
      measuredOn: '2026-08-07',
      mbBookRef: null,
    });
    const api = retentionApi({ recordMbEntry });
    renderWorkDetail(api);

    fireEvent.change(await screen.findByLabelText('Measured quantity'), {
      target: { value: '1.000' },
    });
    fireEvent.change(screen.getByLabelText('Measured on'), {
      target: { value: '2026-08-07' },
    });
    fireEvent.change(screen.getByLabelText('Source challan (optional)'), {
      target: { value: CHALLAN_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record measurement' }));

    await waitFor(() => {
      expect(recordMbEntry).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        workItemId: ITEM_A,
        measuredQuantity: '1.000',
        measuredOn: '2026-08-07',
        deliveryChallanId: CHALLAN_ID,
      });
    });
    // Both the pre-existing and the new entry are listed.
    expect(screen.getAllByText('A/1').length).toBeGreaterThan(1);
  });

  it('lists bills and moves them forward; the Milestone 5 sweep button is gone', async () => {
    const setBillStatus = vi.fn().mockResolvedValue({
      ...BILL,
      status: 'submitted',
      submittedAt: '2026-08-08T11:00:00.000Z',
    });
    const listBills = vi.fn().mockResolvedValue([BILL]);
    const api = retentionApi({ setBillStatus, listBills });
    renderWorkDetail(api);

    expect(await screen.findByRole('heading', { name: /Bill #1/ })).toBeTruthy();
    // Bill preparation now runs from a finalized Measurement Book
    // (ADR-0006 decision 4); the sweep button no longer exists.
    expect(screen.queryByRole('button', { name: 'Prepare bill' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mark submitted' }));
    await waitFor(() => {
      expect(setBillStatus).toHaveBeenCalledWith(ORG_ID, BILL.id, {
        status: 'submitted',
      });
    });
    expect(await screen.findByText('submitted')).toBeTruthy();
  });

  it('updates an instrument status through the forward-only transition', async () => {
    const updateInstrument = vi
      .fn()
      .mockResolvedValue({ ...INSTRUMENT, status: 'released' });
    const api = retentionApi({ updateInstrument });
    renderWorkDetail(api);

    fireEvent.change(await screen.findByLabelText('New status for BG/22'), {
      target: { value: 'released' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(updateInstrument).toHaveBeenCalledWith(ORG_ID, INSTRUMENT.id, {
        status: 'released',
      });
    });
    expect(await screen.findByText('released')).toBeTruthy();
  });

  it('hides retention forms and billing actions from read-only members', async () => {
    const api = retentionApi();
    renderWorkDetail(api, {
      canModify: false,
      canRecordEvidence: false,
      canIssue: false,
    });

    await screen.findByRole('heading', { name: 'Contract instruments' });
    expect(screen.getByText('BG/22')).toBeTruthy();
    expect(screen.getByText('MB-12/34')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add instrument' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record measurement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare bill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark submitted' })).toBeNull();
  });
});

describe('WorkDetail R8 completion panel', () => {
  const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
  const ACTIVE_WORK = {
    id: WORK_ID,
    workCode: 'DCW-1',
    letterNumber: 'L-42/2025',
    letterDate: '2025-06-01',
    title: 'Supply of switchboards',
    advertisedValue: '1000.00',
    contractValue: '900.00',
    pricingShape: 'per_schedule' as const,
    letterPercentage: null,
    letterPercentageDirection: null,
    pbgRequiredAmount: null,
    pbgSubmissionDays: null,
    pbgExtensionDays: null,
    pbgPenalInterestPercent: null,
    status: 'active' as const,
    completedAt: null,
    completedByUserId: null,
    completionNote: null,
    createdAt: '2026-08-08T00:00:00.000Z',
  };
  const COMPLETED_WORK = {
    ...ACTIVE_WORK,
    status: 'completed' as const,
    completedAt: '2026-08-09T09:00:00.000Z',
    completedByUserId: 'user-a',
    completionNote: 'Everything executed and accepted at site.',
  };
  const DETAIL = {
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
            requiresSerials: false,
          },
        ],
      },
    ],
  };

  function renderDetail(api: ApiClient, canModify = true) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={canModify}
        canRecordEvidence
        canIssue
        canCancel
        canApprove={false}
        isOwner={false}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('renders the unfinished-item worklist from the 409 details', async () => {
    const completeWork = vi.fn().mockRejectedValue(
      new RequestFailedError(
        409,
        'WORK_NOT_FULLY_EXECUTED',
        'A Work completes only at 100% executed value; 2 item(s) are short: A/1, A/2.',
        {
          unfinishedItems: [
            {
              workItemId: ITEM_A,
              itemNumber: 'A/1',
              category: 'SUPPLY_AND_INSTALLATION',
              requirement: 'delivery_and_installation',
              requiredQuantity: '5.000',
              deliveredQuantity: '5.000',
              installedQuantity: '2.000',
            },
            {
              workItemId: '55555555-5555-4555-8555-555555555556',
              itemNumber: 'A/2',
              category: null,
              requirement: 'installation',
              requiredQuantity: '3.000',
              deliveredQuantity: '0.000',
              installedQuantity: '0.000',
            },
          ],
        },
      ),
    );
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: ACTIVE_WORK, ...DETAIL }),
      completeWork,
    });
    renderDetail(api);

    await screen.findByRole('heading', { name: 'Completion status' });
    fireEvent.change(screen.getByLabelText('Why this Work is being completed'), {
      target: { value: 'Closing the contract.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Complete Work' }));

    await waitFor(() => {
      expect(completeWork).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        note: 'Closing the contract.',
      });
    });
    // The worklist is the point of the refusal: every short item, with
    // what it owes and what it has.
    expect(
      await screen.findByText('Items still short of 100% executed value'),
    ).toBeTruthy();
    expect(screen.getByText('full delivery and installation')).toBeTruthy();
    expect(screen.getByText('uncategorised')).toBeTruthy();
    expect(screen.getAllByText('2.000').length).toBeGreaterThan(0);
  });

  it('names every clean-state blocker from the 409 details', async () => {
    const completeWork = vi.fn().mockRejectedValue(
      new RequestFailedError(409, 'WORK_NOT_CLEAN', 'Finish or discard these first.', {
        blockers: [
          {
            kind: 'draft_measurement_book',
            recordId: '99999999-9999-4999-8999-999999999999',
            label: 'Draft Measurement Book dated 2026-08-06',
          },
          {
            kind: 'pending_approval_request',
            recordId: '99999999-9999-4999-8999-999999999998',
            label: 'Pending change proposal (work_item_amendment)',
          },
        ],
      }),
    );
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: ACTIVE_WORK, ...DETAIL }),
      completeWork,
    });
    renderDetail(api);

    await screen.findByRole('heading', { name: 'Completion status' });
    fireEvent.change(screen.getByLabelText('Why this Work is being completed'), {
      target: { value: 'Closing the contract.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Complete Work' }));

    expect(
      await screen.findByText('Draft Measurement Book dated 2026-08-06'),
    ).toBeTruthy();
    expect(
      screen.getByText('Pending change proposal (work_item_amendment)'),
    ).toBeTruthy();
  });

  it('closes the create surfaces on a completed Work and offers the reopen', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: COMPLETED_WORK, ...DETAIL }),
    });
    renderDetail(api);

    await screen.findByRole('heading', { name: 'Completion status' });
    expect(
      screen.getByText('Completion note: Everything executed and accepted at site.'),
    ).toBeTruthy();
    // Every document-creating surface is closed until the reopen.
    expect(screen.queryByRole('button', { name: 'New Delivery Challan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New Issue Challan' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Record installation' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Propose an amendment' })).toBeNull();
    expect(screen.queryByLabelText('Why this Work is being completed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reopen Work' })).toBeTruthy();
  });

  it('reopens with a note and reopens the create surfaces', async () => {
    const reopenWork = vi.fn().mockResolvedValue({ work: ACTIVE_WORK });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: COMPLETED_WORK, ...DETAIL }),
      reopenWork,
    });
    renderDetail(api);

    await screen.findByRole('heading', { name: 'Completion status' });
    fireEvent.change(screen.getByLabelText('Why this Work is being reopened'), {
      target: { value: 'Variation order 7 sanctioned more quantity.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen Work' }));

    await waitFor(() => {
      expect(reopenWork).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        note: 'Variation order 7 sanctioned more quantity.',
      });
    });
    expect(
      await screen.findByRole('button', { name: 'New Delivery Challan' }),
    ).toBeTruthy();
  });

  it('shows the status without either form to read-only members', async () => {
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue({ work: COMPLETED_WORK, ...DETAIL }),
    });
    renderDetail(api, false);

    await screen.findByRole('heading', { name: 'Completion status' });
    expect(screen.queryByRole('button', { name: 'Complete Work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen Work' })).toBeNull();
  });
});

describe('CompletionExtensions', () => {
  const EXTENSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const COMPLETION_SET = {
    completion: {
      originalCompletionDate: '2026-12-31',
      currentCompletionDate: '2026-12-31',
    },
    extensionRequests: [],
  };
  const DRAFT_EXTENSION = {
    id: EXTENSION_ID,
    workId: WORK_ID,
    status: 'draft' as const,
    source: 'software' as const,
    manualReference: null,
    proposedCompletionDate: '2027-03-31',
    reason: 'Site not handed over in time.',
    addressee: 'Sr. DEE (G) NR',
    letterDate: '2026-08-01',
    sequenceNumber: null,
    requestNumber: null,
    templateVersion: null,
    renderedAvailable: false,
    responseDocumentAvailable: false,
    responseOutcome: null,
    grantedCompletionDate: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    finalisedAt: null,
    respondedAt: null,
  };
  const FINALISED_EXTENSION = {
    ...DRAFT_EXTENSION,
    status: 'finalised' as const,
    sequenceNumber: 1,
    requestNumber: 'DCW-1-Extension-01',
    templateVersion: 'extension-v1',
    responseDocumentAvailable: true,
    finalisedAt: '2026-08-02T00:00:00.000Z',
  };

  function renderCompletion(
    api: ApiClient,
    flags: Partial<{
      canModify: boolean;
      canIssue: boolean;
      canApprove: boolean;
    }> = {},
  ) {
    return render(
      <CompletionExtensions
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={flags.canModify ?? true}
        canIssue={flags.canIssue ?? true}
        canApprove={flags.canApprove ?? false}
      />,
    );
  }

  it('sets the completion date once through the one-time form', async () => {
    const setCompletionDate = vi.fn().mockResolvedValue(COMPLETION_SET);
    const api = stubApi({ setCompletionDate });
    renderCompletion(api);

    fireEvent.change(
      await screen.findByLabelText('Completion date (per the contract)'),
      { target: { value: '2026-12-31' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set completion date' }));

    await waitFor(() => {
      expect(setCompletionDate).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        completionDate: '2026-12-31',
      });
    });
    // Once set, the form disappears and the dates show as facts.
    expect(await screen.findByText('Original completion date')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set completion date' })).toBeNull();
  });

  it('drafts an extension request against the current completion date', async () => {
    const createExtensionRequest = vi.fn().mockResolvedValue({
      extensionRequest: DRAFT_EXTENSION,
      finalisedSnapshot: null,
    });
    const getWorkCompletion = vi
      .fn()
      .mockResolvedValueOnce(COMPLETION_SET)
      .mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [DRAFT_EXTENSION],
      });
    const api = stubApi({ createExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    fireEvent.change(await screen.findByLabelText('Proposed completion date'), {
      target: { value: '2027-03-31' },
    });
    fireEvent.change(screen.getByLabelText('Addressee'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.change(screen.getByLabelText('Letter date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('Grounds for the extension'), {
      target: { value: 'Site not handed over in time.' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save draft extension request' }),
    );

    await waitFor(() => {
      expect(createExtensionRequest).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        proposedCompletionDate: '2027-03-31',
        reason: 'Site not handed over in time.',
        addressee: 'Sr. DEE (G) NR',
        letterDate: '2026-08-01',
      });
    });
    expect(
      await screen.findByRole('button', { name: 'Finalise extension request' }),
    ).toBeTruthy();
  });

  it('switches to the existing draft on an EXTENSION_DRAFT_EXISTS conflict', async () => {
    const createExtensionRequest = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'EXTENSION_DRAFT_EXISTS',
          'This Work already has a draft extension request; finalise or delete it first.',
          { existingRecordId: EXTENSION_ID },
        ),
      );
    // The first load is stale (no draft); the conflict-triggered reload
    // finds the draft another session already opened.
    const getWorkCompletion = vi
      .fn()
      .mockResolvedValueOnce(COMPLETION_SET)
      .mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [DRAFT_EXTENSION],
      });
    const api = stubApi({ createExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    fireEvent.change(await screen.findByLabelText('Proposed completion date'), {
      target: { value: '2027-03-31' },
    });
    fireEvent.change(screen.getByLabelText('Addressee'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.change(screen.getByLabelText('Letter date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('Grounds for the extension'), {
      target: { value: 'Site not handed over in time.' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save draft extension request' }),
    );

    // The conflict message shows AND the view lands on the existing draft.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already has a draft extension request');
    expect(
      await screen.findByRole('button', { name: 'Finalise extension request' }),
    ).toBeTruthy();
  });

  it('finalises the draft under the issue authority', async () => {
    const finaliseExtensionRequest = vi.fn().mockResolvedValue({
      extensionRequest: FINALISED_EXTENSION,
      finalisedSnapshot: {},
    });
    const getWorkCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        ...COMPLETION_SET,
        extensionRequests: [DRAFT_EXTENSION],
      })
      .mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [FINALISED_EXTENSION],
      });
    const api = stubApi({ finaliseExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Finalise extension request' }),
    );
    await waitFor(() => {
      expect(finaliseExtensionRequest).toHaveBeenCalledWith(ORG_ID, EXTENSION_ID);
    });
    expect(await screen.findByText('DCW-1-Extension-01')).toBeTruthy();
  });

  it('records a modified response with the granted date', async () => {
    const respondExtensionRequest = vi.fn().mockResolvedValue({
      extensionRequest: {
        ...FINALISED_EXTENSION,
        status: 'responded',
        responseOutcome: 'modified',
        grantedCompletionDate: '2027-02-28',
        respondedAt: '2026-08-08T00:00:00.000Z',
      },
      finalisedSnapshot: {},
    });
    const getWorkCompletion = vi.fn().mockResolvedValue({
      ...COMPLETION_SET,
      extensionRequests: [FINALISED_EXTENSION],
    });
    const api = stubApi({ respondExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    fireEvent.change(await screen.findByLabelText('Outcome'), {
      target: { value: 'modified' },
    });
    fireEvent.change(screen.getByLabelText('Granted completion date'), {
      target: { value: '2027-02-28' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record response' }));

    await waitFor(() => {
      expect(respondExtensionRequest).toHaveBeenCalledWith(ORG_ID, EXTENSION_ID, {
        outcome: 'modified',
        grantedCompletionDate: '2027-02-28',
      });
    });
  });

  it('hides every completion and extension form from read-only members', async () => {
    const getWorkCompletion = vi.fn().mockResolvedValue({
      ...COMPLETION_SET,
      extensionRequests: [FINALISED_EXTENSION],
    });
    const api = stubApi({ getWorkCompletion });
    renderCompletion(api, { canModify: false, canIssue: false });

    expect(await screen.findByText('DCW-1-Extension-01')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set completion date' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Save draft extension request' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Finalise extension request' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record response' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Record paper letter as final' }),
    ).toBeNull();
  });

  it('opens the DRAFT-watermarked preview for a draft letter', async () => {
    const downloadExtensionDraftPreview = vi
      .fn()
      .mockResolvedValue(new Blob(['%PDF-1.4 preview']));
    const getWorkCompletion = vi.fn().mockResolvedValue({
      ...COMPLETION_SET,
      extensionRequests: [DRAFT_EXTENSION],
    });
    const api = stubApi({ getWorkCompletion, downloadExtensionDraftPreview });
    vi.stubGlobal('open', vi.fn());
    try {
      renderCompletion(api);

      fireEvent.click(
        await screen.findByRole('button', { name: 'Preview draft (DRAFT watermark)' }),
      );
      await waitFor(() => {
        expect(downloadExtensionDraftPreview).toHaveBeenCalledWith(
          ORG_ID,
          EXTENSION_ID,
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('back-fills a paper letter and surfaces the non-blocking warning', async () => {
    const MANUAL_EXTENSION = {
      ...FINALISED_EXTENSION,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: 'manual' as const,
      manualReference: 'REF/EXT/7',
      requestNumber: 'DCW-1-Extension-02',
      sequenceNumber: 2,
      templateVersion: 'extension-manual-v1',
      responseDocumentAvailable: false,
    };
    const backfillExtensionRequest = vi.fn().mockResolvedValue({
      extensionRequest: MANUAL_EXTENSION,
      finalisedSnapshot: {},
      warnings: ['This letter is dated after the first software-generated letter.'],
    });
    const getWorkCompletion = vi
      .fn()
      .mockResolvedValueOnce(COMPLETION_SET)
      .mockResolvedValue({
        ...COMPLETION_SET,
        extensionRequests: [MANUAL_EXTENSION],
      });
    const api = stubApi({ backfillExtensionRequest, getWorkCompletion });
    renderCompletion(api);

    fireEvent.change(await screen.findByLabelText('Paper letter reference'), {
      target: { value: 'REF/EXT/7' },
    });
    fireEvent.change(screen.getByLabelText('Paper letter date'), {
      target: { value: '2026-01-15' },
    });
    fireEvent.change(screen.getByLabelText('Completion date the letter asked for'), {
      target: { value: '2027-03-31' },
    });
    fireEvent.change(screen.getByLabelText('Addressee of the letter'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.change(screen.getByLabelText('Grounds stated in the letter'), {
      target: { value: 'Monsoon damage to the access road.' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Record paper letter as final' }),
    );

    await waitFor(() => {
      expect(backfillExtensionRequest).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        reference: 'REF/EXT/7',
        letterDate: '2026-01-15',
        proposedCompletionDate: '2027-03-31',
        reason: 'Monsoon damage to the access road.',
        addressee: 'Sr. DEE (G) NR',
      });
    });
    // The paper record shows with its source and reference, and the
    // warning is surfaced without having blocked the creation.
    expect(await screen.findByText('paper — REF/EXT/7')).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('first software-generated letter');
  });

  it('offers manual back-fill deletion only to amendment approvers', async () => {
    const MANUAL_EXTENSION = {
      ...FINALISED_EXTENSION,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: 'manual' as const,
      manualReference: 'REF/EXT/7',
      responseDocumentAvailable: false,
    };
    const getWorkCompletion = vi.fn().mockResolvedValue({
      ...COMPLETION_SET,
      extensionRequests: [MANUAL_EXTENSION],
    });

    const withoutAuthority = renderCompletion(stubApi({ getWorkCompletion }), {
      canApprove: false,
    });
    expect(await screen.findByText('paper — REF/EXT/7')).toBeTruthy();
    expect(
      screen.queryByRole('button', {
        name: 'Delete manual back-fill (top of sequence only)',
      }),
    ).toBeNull();
    withoutAuthority.unmount();

    const deleteExtensionRequest = vi.fn().mockResolvedValue(undefined);
    renderCompletion(stubApi({ getWorkCompletion, deleteExtensionRequest }), {
      canApprove: true,
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Delete manual back-fill (top of sequence only)',
      }),
    );
    await waitFor(() => {
      expect(deleteExtensionRequest).toHaveBeenCalledWith(ORG_ID, MANUAL_EXTENSION.id);
    });
  });
});

describe('Dashboard', () => {
  it('shows totals, alerts with severity, and routes work opens', async () => {
    const dashboard = vi.fn().mockResolvedValue({
      totals: {
        works: 2,
        contractValue: '5807500.00',
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
          workId: WORK_ID,
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
          workId: WORK_ID,
          workCode: 'PL270-CRB',
          title: 'Signalling gear, CR Bhusawal',
          status: 'active',
          contractValue: '4520000.00',
          deliveredValue: '1450000.00',
          billedValue: '300.00',
          issuedChallans: 3,
        },
      ],
    });
    const onOpenWork = vi.fn();
    const { Dashboard } = await import('../src/views/Dashboard.js');
    render(
      <Dashboard
        api={stubApi({ dashboard })}
        organisationId={ORG_ID}
        onOpenWork={onOpenWork}
      />,
    );

    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.getByText(/PBG BG\/22 for PL270-CRB expires/)).toBeTruthy();
    expect(screen.getByText('38 days left')).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'PL270-CRB delivery progress' }),
    ).toBeTruthy();
    // 1450000 / 4520000 = 32%
    expect(screen.getByText('32%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open PL270-CRB' }));
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
  });
});

describe('Settings', () => {
  const PROFILE = {
    id: ORG_ID,
    name: 'Sharma Constructions',
    slug: 'sharma',
    address: null,
    gstin: null,
    contactPhone: null,
    contactEmail: null,
    hasLogo: false,
  };

  it('lets an owner edit company details', async () => {
    const updateOrganisationProfile = vi.fn().mockResolvedValue({
      ...PROFILE,
      address: 'Plot 4, MIDC, Nashik',
      gstin: '27ABCDE1234F1Z5',
    });
    const { Settings } = await import('../src/views/Settings.js');
    render(
      <Settings
        api={stubApi({
          organisationProfile: vi.fn().mockResolvedValue(PROFILE),
          updateOrganisationProfile,
        })}
        organisationId={ORG_ID}
        isOwner
      />,
    );

    await screen.findByRole('heading', { name: 'Settings' });
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'Plot 4, MIDC, Nashik' },
    });
    fireEvent.change(screen.getByLabelText('GSTIN'), {
      target: { value: '27ABCDE1234F1Z5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save company details' }));

    await waitFor(() => {
      expect(updateOrganisationProfile).toHaveBeenCalledWith(ORG_ID, {
        name: 'Sharma Constructions',
        address: 'Plot 4, MIDC, Nashik',
        gstin: '27ABCDE1234F1Z5',
        contactPhone: null,
        contactEmail: null,
        warrantyTemplateText: null,
      });
    });
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('shows read-only details to non-owners', async () => {
    const { Settings } = await import('../src/views/Settings.js');
    render(
      <Settings
        api={stubApi({
          organisationProfile: vi.fn().mockResolvedValue({
            ...PROFILE,
            address: 'Plot 4, MIDC, Nashik',
          }),
        })}
        organisationId={ORG_ID}
        isOwner={false}
      />,
    );

    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.getByText('Plot 4, MIDC, Nashik')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save company details' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload logo' })).toBeNull();
  });

  it('saves the warranty template through the profile update', async () => {
    const updateOrganisationProfile = vi.fn().mockResolvedValue({
      ...PROFILE,
      warrantyTemplateText: 'Goods carry a 24-month warranty.',
    });
    const { Settings } = await import('../src/views/Settings.js');
    render(
      <Settings
        api={stubApi({
          organisationProfile: vi.fn().mockResolvedValue(PROFILE),
          updateOrganisationProfile,
        })}
        organisationId={ORG_ID}
        isOwner
      />,
    );

    await screen.findByRole('heading', { name: 'Settings' });
    fireEvent.change(screen.getByLabelText('Warranty agreement template'), {
      target: { value: 'Goods carry a 24-month warranty.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save company details' }));

    await waitFor(() => {
      expect(updateOrganisationProfile).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({
          warrantyTemplateText: 'Goods carry a 24-month warranty.',
        }),
      );
    });
  });
});

describe('Masters', () => {
  const CONSIGNEE = {
    id: '44444444-4444-4444-8444-444444444444',
    designation: 'Sr. DEE (G) NR',
    address: 'Delhi Division, New Delhi',
    contactPerson: null,
    phone: '011-23385678',
    email: null,
    gstin: null,
    pincode: null,
    stateCode: null,
    isConsignee: true,
    isVendor: false,
    isClient: false,
    active: true,
    createdAt: '2026-08-08T00:00:00.000Z',
  };

  it('lists contacts and adds one through the form', async () => {
    const saveContact = vi.fn().mockResolvedValue(CONSIGNEE);
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
      saveContact,
    });
    const { Masters } = await import('../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    expect(await screen.findByText('Sr. DEE (G) NR')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Designation / name'), {
      target: { value: 'SSE (Signal) GZB' },
    });
    fireEvent.change(screen.getByLabelText('Address (optional)'), {
      target: { value: 'Signal Workshop, Ghaziabad' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));

    await waitFor(() => {
      expect(saveContact).toHaveBeenCalledWith(ORG_ID, null, {
        designation: 'SSE (Signal) GZB',
        address: 'Signal Workshop, Ghaziabad',
      });
    });
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('shows the dormant vendor/client role flags disabled with the procurement note', async () => {
    const api = stubApi({ listContacts: vi.fn().mockResolvedValue([CONSIGNEE]) });
    const { Masters } = await import('../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    expect(await screen.findByText('Sr. DEE (G) NR')).toBeTruthy();
    const consigneeRole = screen.getByLabelText<HTMLInputElement>('Consignee');
    expect(consigneeRole.checked).toBe(true);
    expect(consigneeRole.disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Vendor').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Client').disabled).toBe(true);
    expect(screen.getByText(/procurement wave/)).toBeTruthy();
  });

  it('retires a contact and surfaces duplicate conflicts as alerts', async () => {
    const setContactActive = vi.fn().mockResolvedValue({ ...CONSIGNEE, active: false });
    const saveContact = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'CONTACT_EXISTS',
          'An active contact with this designation and address already exists.',
        ),
      );
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
      setContactActive,
      saveContact,
    });
    const { Masters } = await import('../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(setContactActive).toHaveBeenCalledWith(ORG_ID, CONSIGNEE.id, false);
    });

    fireEvent.change(screen.getByLabelText('Designation / name'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already exists');
  });

  it('hides mutations from read-only members', async () => {
    const api = stubApi({
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
    });
    const { Masters } = await import('../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify={false} />);

    expect(await screen.findByText('Sr. DEE (G) NR')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull();
  });

  it('switches to the units tab and shows the seeded canon', async () => {
    const listUnitMasters = vi.fn().mockResolvedValue([
      {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Numbers',
        active: true,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    ]);
    const api = stubApi({ listUnitMasters });
    const { Masters } = await import('../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Units' }));
    expect(await screen.findByText('Numbers')).toBeTruthy();
    expect(listUnitMasters).toHaveBeenCalledWith(ORG_ID, false);
  });
});

describe('ChallanEditor consignee picker', () => {
  it('prefills the snapshot fields from a chosen master and keeps them editable', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      listContacts: vi.fn().mockResolvedValue([
        {
          id: '44444444-4444-4444-8444-444444444444',
          designation: 'Sr. DEE (G) NR',
          address: 'Delhi Division, New Delhi',
          contactPerson: null,
          phone: '011-23385678',
          email: null,
          gstin: null,
          pincode: null,
          stateCode: null,
          isConsignee: true,
          isVendor: false,
          isClient: false,
          active: true,
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      ]),
      listWorkConsignees: vi.fn().mockResolvedValue([]),
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText('2.000');
    fireEvent.change(screen.getByLabelText('Prefill consignee from contacts'), {
      target: { value: '44444444-4444-4444-8444-444444444444' },
    });

    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G) NR',
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Consignee address').value).toBe(
      'Delhi Division, New Delhi',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Consignee phone (optional)').value,
    ).toBe('011-23385678');

    // Manual entry stays possible after picking — the fields are the
    // challan's own snapshot, not a bound reference.
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G) NR, Attn: TI' },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G) NR, Attn: TI',
    );
  });

  it("offers the Work's linked consignees first while keeping every consignee pickable", async () => {
    const linked = {
      id: '55555555-5555-4555-8555-555555555555',
      designation: 'SSE (Signal) GZB',
      address: 'Signal Workshop, Ghaziabad',
      contactPerson: null,
      phone: null,
      email: null,
      gstin: null,
      pincode: null,
      stateCode: null,
      isConsignee: true,
      isVendor: false,
      isClient: false,
      active: true,
      createdAt: '2026-08-08T00:00:00.000Z',
    };
    const other = {
      ...linked,
      id: '44444444-4444-4444-8444-444444444444',
      designation: 'Sr. DEE (G) NR',
      address: 'Delhi Division, New Delhi',
    };
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      listContacts: vi.fn().mockResolvedValue([other, linked]),
      listWorkConsignees: vi.fn().mockResolvedValue([linked]),
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText('2.000');
    const picker = screen.getByLabelText<HTMLSelectElement>(
      'Prefill consignee from contacts',
    );
    const groups = Array.from(picker.querySelectorAll('optgroup')).map(
      (group) => group.label,
    );
    // R16 preference: the linked group leads; the full list follows so
    // any active consignee stays selectable.
    expect(groups).toEqual(['Linked to this Work', 'All consignees']);
    const linkedGroup = picker.querySelector('optgroup');
    expect(linkedGroup?.querySelectorAll('option')).toHaveLength(1);
    expect(linkedGroup?.textContent).toContain('SSE (Signal) GZB');

    fireEvent.change(picker, { target: { value: other.id } });
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G) NR',
    );
  });
});

describe('WorkConsignees panel', () => {
  const LINKED = {
    id: '55555555-5555-4555-8555-555555555555',
    designation: 'SSE (Signal) GZB',
    address: 'Signal Workshop, Ghaziabad',
    contactPerson: null,
    phone: null,
    email: null,
    gstin: null,
    pincode: null,
    stateCode: null,
    isConsignee: true,
    isVendor: false,
    isClient: false,
    active: true,
    createdAt: '2026-08-08T00:00:00.000Z',
  };
  const UNLINKED = {
    ...LINKED,
    id: '44444444-4444-4444-8444-444444444444',
    designation: 'Sr. DEE (G) NR',
    address: 'Delhi Division, New Delhi',
  };

  it('links a consignee contact to the Work', async () => {
    const linkWorkConsignee = vi.fn().mockResolvedValue(UNLINKED);
    const listWorkConsignees = vi
      .fn()
      .mockResolvedValueOnce([LINKED])
      .mockResolvedValue([LINKED, UNLINKED]);
    const api = stubApi({
      listWorkConsignees,
      linkWorkConsignee,
      listContacts: vi.fn().mockResolvedValue([LINKED, UNLINKED]),
    });
    const { WorkConsignees } = await import('../src/views/WorkConsignees.js');
    render(
      <WorkConsignees api={api} organisationId={ORG_ID} workId={WORK_ID} canModify />,
    );

    expect(await screen.findByText('SSE (Signal) GZB')).toBeTruthy();
    // Only contacts not yet linked are offered.
    const picker = screen.getByLabelText<HTMLSelectElement>('Link a consignee contact');
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      UNLINKED.id,
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Link consignee' }));
    await waitFor(() => {
      expect(linkWorkConsignee).toHaveBeenCalledWith(ORG_ID, WORK_ID, UNLINKED.id);
    });
  });

  it('unlinks without deleting the contact and hides mutations from viewers', async () => {
    const unlinkWorkConsignee = vi.fn().mockResolvedValue(undefined);
    const api = stubApi({
      listWorkConsignees: vi.fn().mockResolvedValue([LINKED]),
      listContacts: vi.fn().mockResolvedValue([LINKED]),
      unlinkWorkConsignee,
    });
    const { WorkConsignees } = await import('../src/views/WorkConsignees.js');
    const view = render(
      <WorkConsignees api={api} organisationId={ORG_ID} workId={WORK_ID} canModify />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => {
      expect(unlinkWorkConsignee).toHaveBeenCalledWith(ORG_ID, WORK_ID, LINKED.id);
    });
    view.unmount();

    render(
      <WorkConsignees
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={false}
      />,
    );
    expect(await screen.findAllByText('SSE (Signal) GZB')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unlink' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link consignee' })).toBeNull();
  });
});

describe('Timeline', () => {
  const EVENT_ISSUED = {
    id: 'e1111111-1111-4111-8111-111111111111',
    occurredAt: '2026-08-08T10:00:00.000Z',
    actorUserId: 'user-a',
    actorName: 'Owner Person',
    action: 'challan.issued',
    entityType: 'delivery_challans',
    entityId: CHALLAN_ID,
    details: { challanNumber: 'DC/1', sequence: 1, totalAmount: '675.75' },
  };
  const EVENT_UPDATED = {
    id: 'e2222222-2222-4222-8222-222222222222',
    occurredAt: '2026-08-08T09:00:00.000Z',
    actorUserId: 'user-a',
    actorName: 'Owner Person',
    action: 'instrument.updated',
    entityType: 'work_instruments',
    entityId: '77777777-7777-4777-8777-777777777777',
    details: { before: { status: 'active' }, after: { status: 'released' } },
  };

  it('renders humanised actions with a structured before → after diff', async () => {
    const workTimeline = vi
      .fn()
      .mockResolvedValue({ events: [EVENT_ISSUED, EVENT_UPDATED], nextCursor: null });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );

    // Humanised action labels, never raw action codes.
    expect(await screen.findByText('Challan issued')).toBeTruthy();
    expect(screen.getByText('Instrument updated')).toBeTruthy();
    expect(screen.queryByText('challan.issued')).toBeNull();
    // Context facts for plain events…
    expect(screen.getByText(/Challan number: DC\/1/)).toBeTruthy();
    // …and a field-by-field old → new diff for update events, not JSON.
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('released')).toBeTruthy();
    expect(screen.queryByText(/[{}"]/)).toBeNull();
    expect(screen.getAllByText(/Owner Person/).length).toBeGreaterThan(0);
  });

  it('pages older events through the keyset cursor', async () => {
    const workTimeline = vi
      .fn()
      .mockResolvedValueOnce({ events: [EVENT_ISSUED], nextCursor: EVENT_ISSUED.id })
      .mockResolvedValueOnce({ events: [EVENT_UPDATED], nextCursor: null });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Show earlier events' }));
    await waitFor(() => {
      expect(workTimeline).toHaveBeenLastCalledWith(ORG_ID, WORK_ID, {
        cursor: EVENT_ISSUED.id,
      });
    });
    expect(await screen.findByText('Instrument updated')).toBeTruthy();
    // Both pages stay on screen; the cursor is exhausted.
    expect(screen.getByText('Challan issued')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show earlier events' })).toBeNull();
  });

  it('filters the Work stream by record type via the query parameter', async () => {
    const workTimeline = vi
      .fn()
      .mockResolvedValue({ events: [EVENT_ISSUED], nextCursor: null });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );

    await screen.findByText('Challan issued');
    fireEvent.change(screen.getByLabelText('Filter timeline by record type'), {
      target: { value: 'delivery_challans' },
    });
    await waitFor(() => {
      expect(workTimeline).toHaveBeenLastCalledWith(ORG_ID, WORK_ID, {
        entityTypes: ['delivery_challans'],
      });
    });
  });

  it('offers filters for every wave-added record type: items, payment matrix, PACs', async () => {
    const workTimeline = vi
      .fn()
      .mockResolvedValue({ events: [EVENT_ISSUED], nextCursor: null });
    render(
      <Timeline
        api={stubApi({ workTimeline })}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />,
    );
    await screen.findByText('Challan issued');
    const filter = screen.getByLabelText<HTMLSelectElement>(
      'Filter timeline by record type',
    );
    const values = [...filter.options].map((option) => option.value);
    expect(values).toContain('work_items');
    expect(values).toContain('payment_matrices');
    expect(values).toContain('pac_certificates');
    fireEvent.change(filter, { target: { value: 'pac_certificates' } });
    await waitFor(() => {
      expect(workTimeline).toHaveBeenLastCalledWith(ORG_ID, WORK_ID, {
        entityTypes: ['pac_certificates'],
      });
    });
  });

  it('shows the same component on the challan detail via the entity history', async () => {
    const entityTimeline = vi
      .fn()
      .mockResolvedValue({ events: [EVENT_ISSUED], nextCursor: null });
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(
        challanDetail({
          status: 'issued',
          challanNumber: 'DC/1',
          sequenceNumber: 1,
          issuedAt: '2026-08-08T10:00:00.000Z',
        }),
      ),
      entityTimeline,
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel={false}
        canRecordEvidence={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(await screen.findByText('Challan issued')).toBeTruthy();
    expect(entityTimeline).toHaveBeenCalledWith(
      ORG_ID,
      'delivery_challans',
      CHALLAN_ID,
      {},
    );
  });
});

describe('Approvals queue', () => {
  const APPROVAL_ID = '99999999-9999-4999-8999-999999999999';
  const APPROVAL = {
    id: APPROVAL_ID,
    entityType: 'work_item_amendment' as const,
    entityId: ITEM_A,
    workId: WORK_ID,
    workCode: 'DCW-1',
    itemNumber: 'A/1',
    documentNumber: null,
    proposed: {
      kind: 'change_item',
      workItemId: ITEM_A,
      itemNumber: 'A/1',
      changes: { quantity: '8.000' },
    },
    diff: [{ field: 'quantity', before: '5.000', after: '8.000' }],
    reason: 'Railway variation order 12.',
    status: 'pending' as const,
    requestedByUserId: 'user-b',
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: '2026-08-08T00:00:00.000Z',
  };

  it('renders the diff and approves with a note', async () => {
    const approveAmendment = vi
      .fn()
      .mockResolvedValue({ ...APPROVAL, status: 'approved' });
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce([APPROVAL])
      .mockResolvedValue([]);
    const api = stubApi({ listApprovals, approveAmendment });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText('Railway variation order 12.')).toBeTruthy();
    expect(screen.getByText('5.000')).toBeTruthy();
    expect(screen.getByText('8.000')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Decision note (required to reject)'), {
      target: { value: 'Sanctioned by letter.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and apply' }));
    await waitFor(() => {
      expect(approveAmendment).toHaveBeenCalledWith(
        ORG_ID,
        APPROVAL_ID,
        'Sanctioned by letter.',
      );
    });
  });

  it('keeps Reject disabled until a note is supplied', async () => {
    const rejectAmendment = vi
      .fn()
      .mockResolvedValue({ ...APPROVAL, status: 'rejected' });
    const api = stubApi({
      listApprovals: vi.fn().mockResolvedValue([APPROVAL]),
      rejectAmendment,
    });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );

    const reject = await screen.findByRole('button', { name: 'Reject' });
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Decision note (required to reject)'), {
      target: { value: 'Duplicate of variation 9.' },
    });
    expect((reject as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reject);
    await waitFor(() => {
      expect(rejectAmendment).toHaveBeenCalledWith(
        ORG_ID,
        APPROVAL_ID,
        'Duplicate of variation 9.',
      );
    });
  });

  it('offers withdraw to the requester and hides decisions without authority', async () => {
    const withdrawAmendment = vi
      .fn()
      .mockResolvedValue({ ...APPROVAL, status: 'withdrawn' });
    const api = stubApi({
      listApprovals: vi.fn().mockResolvedValue([APPROVAL]),
      withdrawAmendment,
    });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-b"
        canApprove={false}
        onChanged={vi.fn()}
      />,
    );

    await screen.findByText('Railway variation order 12.');
    expect(screen.queryByRole('button', { name: 'Approve and apply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => {
      expect(withdrawAmendment).toHaveBeenCalledWith(ORG_ID, APPROVAL_ID);
    });
  });

  it('shows a calm empty state', async () => {
    render(
      <Approvals
        api={stubApi()}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove={true}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText('Nothing is waiting for a decision.')).toBeTruthy();
  });
});

describe('WorkDetail amendments', () => {
  const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
  const ADDED_ITEM = '88888888-8888-4888-8888-888888888888';
  const AMENDED_WORK_DETAIL = {
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
      allowExcessDelivery: false,
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
            effectiveQuantity: '8.000',
            effectiveUnitRate: '110.00',
            effectiveDescription: null,
            effectiveUnit: null,
            amendmentAdded: false,
          },
          {
            id: ADDED_ITEM,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/3',
            description: 'Lightning arrester',
            unitCode: 'Nos',
            awardedQuantity: '4.000',
            effectiveRate: '50.00',
            effectiveQuantity: '0.000',
            effectiveUnitRate: null,
            effectiveDescription: null,
            effectiveUnit: null,
            amendmentAdded: true,
          },
        ],
      },
    ],
  };

  function amendedApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      getWork: vi.fn().mockResolvedValue(AMENDED_WORK_DETAIL),
      ...overrides,
    });
  }

  function renderAmended(api: ApiClient, flags: { isOwner?: boolean } = {}) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={true}
        canRecordEvidence={true}
        canIssue={true}
        canCancel={true}
        canApprove={false}
        isOwner={flags.isOwner ?? false}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('shows original and effective values side by side when they differ', async () => {
    renderAmended(amendedApi());

    await screen.findByRole('heading', { name: 'Amendments' });
    // Quantity 5.000 → 8.000: the original stays visible, struck through.
    // Other sections (serials, balances) may repeat the bare numbers, so
    // assert the struck-through original exists among the matches.
    expect(screen.getAllByText('5.000').some((node) => node.tagName === 'S')).toBe(
      true,
    );
    expect(screen.getAllByText('8.000').length).toBeGreaterThan(0);
    // Rate 100.00 → 110.00.
    expect(screen.getAllByText('100.00').some((node) => node.tagName === 'S')).toBe(
      true,
    );
    expect(screen.getAllByText('110.00').length).toBeGreaterThan(0);
    // Amendment-added and omitted items are flagged.
    expect(screen.getByText('added')).toBeTruthy();
    expect(screen.getByText('omitted')).toBeTruthy();
  });

  it('proposes a quantity change with a reason', async () => {
    const proposeAmendment = vi.fn().mockResolvedValue({
      id: '11111111-2222-4333-8444-555555555555',
      status: 'pending',
    });
    renderAmended(amendedApi({ proposeAmendment }));

    await screen.findByRole('heading', { name: 'Amendments' });
    fireEvent.change(screen.getByLabelText('Item to amend'), {
      target: { value: ITEM_A },
    });
    fireEvent.change(screen.getByLabelText('New quantity (optional)'), {
      target: { value: '9' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Variation order 15.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit amendment' }));

    await waitFor(() => {
      expect(proposeAmendment).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        workItemId: ITEM_A,
        reason: 'Variation order 15.',
        changes: { quantity: '9' },
      });
    });
  });

  it('lets an owner flip the excess-delivery escape hatch, and hides it otherwise', async () => {
    const setWorkSettings = vi
      .fn()
      .mockResolvedValue({ id: WORK_ID, allowExcessDelivery: true });
    renderAmended(amendedApi({ setWorkSettings }), { isOwner: true });

    const toggle = await screen.findByLabelText(
      'Allow issuing beyond sanctioned quantities',
    );
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(setWorkSettings).toHaveBeenCalledWith(ORG_ID, WORK_ID, true);
    });

    cleanup();
    renderAmended(amendedApi());
    await screen.findByRole('heading', { name: 'Amendments' });
    expect(
      screen.queryByLabelText('Allow issuing beyond sanctioned quantities'),
    ).toBeNull();
    expect(screen.getByText('Not allowed')).toBeTruthy();
  });
});

describe('Members amendment authority', () => {
  it('lets an owner grant the approval authority', async () => {
    const updateMember = vi
      .fn()
      .mockResolvedValue([
        membership({ userId: 'user-a' }),
        membership({ userId: 'user-b', role: 'office', canApproveAmendments: true }),
      ]);
    const api = stubApi({
      listMembers: vi
        .fn()
        .mockResolvedValue([
          membership({ userId: 'user-a' }),
          membership({ userId: 'user-b', role: 'office' }),
        ]),
      updateMember,
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-a" />);

    const toggle = await screen.findByLabelText(
      'Amendment approval authority of user-b',
    );
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(updateMember).toHaveBeenCalledWith(ORG_ID, 'user-b', {
        canApproveAmendments: true,
      });
    });
  });
});

describe('WorkDetail serial tracking toggle', () => {
  const SCHEDULE_ID = '88888888-8888-4888-8888-888888888888';
  const detailWith = (requiresSerials: boolean) => ({
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
            requiresSerials,
          },
        ],
      },
    ],
  });

  function renderDetail(api: ApiClient, canModify: boolean) {
    return render(
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={canModify}
        canRecordEvidence={canModify}
        canIssue={canModify}
        canCancel={canModify}
        canApprove={false}
        isOwner={false}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('turns serial tracking on for an item', async () => {
    const updateWorkItemSerials = vi.fn().mockResolvedValue({
      workItemId: ITEM_A,
      itemNumber: 'A/1',
      requiresSerials: true,
    });
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(detailWith(false)),
      updateWorkItemSerials,
    });
    renderDetail(api, true);

    const toggle = await screen.findByRole('switch', {
      name: 'Serial tracking for A/1',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(updateWorkItemSerials).toHaveBeenCalledWith(ORG_ID, ITEM_A, true);
    });
    expect(
      (
        await screen.findByRole('switch', { name: 'Serial tracking for A/1' })
      ).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('surfaces the completeness conflict when turning on is refused', async () => {
    const updateWorkItemSerials = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'SERIALS_INCOMPLETE_FOR_FLAG',
          'Serial tracking cannot be required for A/1: DC/1 has 1 of 3.000 serials. Record the missing serials first.',
        ),
      );
    const api = stubApi({
      getWork: vi.fn().mockResolvedValue(detailWith(false)),
      updateWorkItemSerials,
    });
    renderDetail(api, true);

    fireEvent.click(
      await screen.findByRole('switch', { name: 'Serial tracking for A/1' }),
    );
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Serial tracking cannot be required for A/1: DC/1 has 1 of 3.000 serials. Record the missing serials first.',
    );
  });

  it('shows read-only members the flag without a control', async () => {
    const api = stubApi({ getWork: vi.fn().mockResolvedValue(detailWith(true)) });
    renderDetail(api, false);

    await screen.findByRole('heading', { name: /DCW-1/ });
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Required')).toBeTruthy();
  });
});

describe('SerialLookup', () => {
  const MATCH = {
    id: '99999999-9999-4999-8999-999999999999',
    serialNumber: 'SB-2026-014',
    workId: WORK_ID,
    workCode: 'DCW-1',
    workTitle: 'Supply of switchboards',
    itemDescription: 'Main switchboard',
    challanId: CHALLAN_ID,
    challanNumber: 'DC/1',
    challanDate: '2026-08-08',
    challanStatus: 'issued' as const,
    receiptRecorded: true,
    installedOn: null,
  };

  function renderLookup(
    api: ApiClient,
    handlers: Partial<{
      onOpenWork: (workId: string) => void;
      onOpenChallan: (workId: string, challanId: string) => void;
    }> = {},
  ) {
    return render(
      <SerialLookup
        api={api}
        organisationId={ORG_ID}
        onOpenWork={handlers.onOpenWork ?? vi.fn()}
        onOpenChallan={handlers.onOpenChallan ?? vi.fn()}
      />,
    );
  }

  it('searches and links each match to its work and challan', async () => {
    const searchSerials = vi
      .fn()
      .mockResolvedValue({ matches: [MATCH], truncated: false });
    const onOpenWork = vi.fn();
    const onOpenChallan = vi.fn();
    renderLookup(stubApi({ searchSerials }), { onOpenWork, onOpenChallan });

    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'sb-2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(searchSerials).toHaveBeenCalledWith(ORG_ID, 'sb-2026');
    });
    expect(await screen.findByText('SB-2026-014')).toBeTruthy();
    expect(screen.getByText('received')).toBeTruthy();
    expect(screen.getByText('not installed')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'DCW-1' }));
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
    fireEvent.click(screen.getByRole('button', { name: 'DC/1' }));
    expect(onOpenChallan).toHaveBeenCalledWith(WORK_ID, CHALLAN_ID);
  });

  it('rejects queries shorter than 2 characters without calling the API', async () => {
    const searchSerials = vi.fn();
    renderLookup(stubApi({ searchSerials }));

    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Enter at least 2 characters of the serial number.',
    );
    expect(searchSerials).not.toHaveBeenCalled();
  });

  it('reports truncation and the empty state', async () => {
    const searchSerials = vi
      .fn()
      .mockResolvedValueOnce({
        matches: Array.from({ length: 50 }, (_, index) => ({
          ...MATCH,
          id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
          serialNumber: `SB-${String(index)}`,
        })),
        truncated: true,
      })
      .mockResolvedValueOnce({ matches: [], truncated: false });
    renderLookup(stubApi({ searchSerials }));

    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'SB' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Showing the first 50 matches/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'ZZ-NONE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/No serial matches/)).toBeTruthy();
  });
});

describe('ReviewLoa PBG requirement and row editing', () => {
  // The base REVIEW_PAYLOAD (untouched above) has no performance-guarantee
  // field; this variant carries the parsed clause plus a second item row
  // so removal leaves a confirmable Work.
  const PBG_PAYLOAD = {
    ...REVIEW_PAYLOAD,
    review: {
      ...REVIEW_PAYLOAD.review,
      header: {
        ...REVIEW_PAYLOAD.review.header,
        performanceGuarantee: {
          amountFigures: 152321.33,
          amountWords:
            'Rupees One Lakh Fifty-Two Thousand Three Hundred And Twenty-One Rupees And Thirty-Three Paise Only',
          submissionDays: 21,
          extensionDays: 60,
          penalInterestPercent: 12,
          raw: 'amounting to Rs. 152321.33 (…) within 21 days from the date of issue of Letter of Acceptance',
          needsReview: false,
        },
      },
      items: [
        ...REVIEW_PAYLOAD.review.items,
        {
          schedule: { id: 'A' },
          itemSno: '2',
          itemCode: 'S02',
          description: 'Distribution board, wall mounted',
          qty: '1.000',
          qtyUnit: 'Numbers',
          unitRate: '100.00',
          bidAmount: '100.00',
          needsReview: false,
          raw: { anchorLine: '2  S02  Distribution board ...' },
        },
      ],
    },
  };
  const PBG_DOCUMENT = { ...REVIEW_DOCUMENT, extractionPayload: PBG_PAYLOAD };

  function renderReview(confirmLoa = vi.fn()) {
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(PBG_DOCUMENT),
      confirmLoa: confirmLoa.mockResolvedValue({
        work: { id: WORK_ID },
        schedules: [],
      }),
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    return confirmLoa;
  }

  it('prefills the parsed PBG requirement and submits it with the confirmation', async () => {
    const confirmLoa = renderReview();

    const amount = await screen.findByLabelText('Required amount (₹)');
    expect((amount as HTMLInputElement).value).toBe('152321.33');
    expect(screen.getByLabelText<HTMLInputElement>('Submit within (days)').value).toBe(
      '21',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Extension window (days)').value,
    ).toBe('60');
    expect(
      screen.getByLabelText<HTMLInputElement>('Penal interest (% p.a.)').value,
    ).toBe('12');
    expect(screen.getByText(/amounting to Rs\. 152321\.33/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(requestArg.pbgRequirement).toEqual({
      requiredAmount: '152321.33',
      submissionDays: 21,
      extensionDays: 60,
      penalInterestPercent: '12',
    });
  });

  it('confirms without a PBG requirement when the reviewer unchecks it', async () => {
    const confirmLoa = renderReview();

    fireEvent.click(
      await screen.findByLabelText('The letter demands a Performance Bank Guarantee'),
    );
    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(requestArg.pbgRequirement).toBeUndefined();
  });

  it('adds a manual row flagged for review and confirms it with the manual marker', async () => {
    const confirmLoa = renderReview();

    await screen.findByLabelText('Rate for row 1 in schedule A');
    expect(screen.getByTestId('reconciliation-totals').textContent).toContain(
      'Entered rows total ₹1000.00 across 2 rows',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const description = screen.getByLabelText('Description for row M1 in schedule A');
    fireEvent.change(description, {
      target: { value: 'Extra switch panels supplied loose' },
    });
    fireEvent.change(screen.getByLabelText('Unit for row M1 in schedule A'), {
      target: { value: 'Nos' },
    });
    fireEvent.change(screen.getByLabelText('Quantity for row M1 in schedule A'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Rate for row M1 in schedule A'), {
      target: { value: '50.00' },
    });
    expect(
      screen.getByLabelText<HTMLInputElement>('Item number for row M1 in schedule A')
        .value,
    ).toBe('A/M1');
    expect(screen.getByText('manual row')).toBeTruthy();
    // 900 + 100 + 2×50 against a contract value of 900.00.
    expect(screen.getByTestId('reconciliation-totals').textContent).toContain(
      'Entered rows total ₹1100.00 across 3 rows — contract value ₹900.00 (difference ₹200.00)',
    );

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    const manualItem = requestArg.schedules[0]?.items.find(
      (item) => item.itemNumber === 'A/M1',
    );
    expect(manualItem).toMatchObject({
      manualEntry: true,
      description: 'Extra switch panels supplied loose',
      awardedQuantity: '2',
      effectiveRate: '50.00',
    });
    expect(manualItem?.sourceRef).toBeUndefined();
    // Parsed rows keep their sourceRef untouched.
    expect(requestArg.schedules[0]?.items[0]?.sourceRef).toEqual({
      scheduleId: 'A',
      itemSno: '1',
    });
  });

  it('removes a parsed row behind an inline confirmation and recomputes the totals', async () => {
    const confirmLoa = renderReview();

    await screen.findByLabelText('Rate for row 2 in schedule A');
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 2 in schedule A' }));
    // Nothing is removed until the inline prompt is confirmed.
    expect(screen.getByLabelText('Rate for row 2 in schedule A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));

    expect(screen.queryByLabelText('Rate for row 2 in schedule A')).toBeNull();
    expect(screen.getByTestId('reconciliation-totals').textContent).toContain(
      'Entered rows total ₹900.00 across 1 row — contract value ₹900.00 (difference ₹0.00)',
    );

    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL273-JHS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));
    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(requestArg.schedules).toHaveLength(1);
    expect(requestArg.schedules[0]?.items).toHaveLength(1);
    expect(requestArg.schedules[0]?.items[0]?.itemNumber).toBe('A/1');
  });

  it('keeps a removal candidate when the reviewer chooses Keep', async () => {
    renderReview();
    await screen.findByLabelText('Rate for row 2 in schedule A');
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 2 in schedule A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByLabelText('Rate for row 2 in schedule A')).toBeTruthy();
  });
});

describe('WorkDetail PBG requirement', () => {
  const PBG_SCHEDULE_ID = '88888888-8888-4888-8888-888888888888';
  const workDetailWith = (pbg: {
    pbgRequiredAmount: string | null;
    pbgSubmissionDays: number | null;
    pbgExtensionDays: number | null;
    pbgPenalInterestPercent: string | null;
  }) => ({
    work: {
      id: WORK_ID,
      workCode: 'PBG-W-1',
      letterNumber: 'L-99/2026',
      letterDate: '2026-02-09',
      title: 'Supply of signalling gear',
      advertisedValue: '1000.00',
      contractValue: '900.00',
      pricingShape: 'per_schedule',
      letterPercentage: null,
      letterPercentageDirection: null,
      status: 'active',
      createdAt: '2026-08-08T00:00:00.000Z',
      ...pbg,
    },
    schedules: [
      {
        id: PBG_SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [],
      },
    ],
  });

  function renderDetail(detail: unknown) {
    render(
      <WorkDetail
        api={stubApi({ getWork: vi.fn().mockResolvedValue(detail) })}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={false}
        canRecordEvidence={false}
        canIssue={false}
        canCancel={false}
        canApprove={false}
        isOwner={false}
        onNewIssueChallan={vi.fn()}
        onOpenIssueChallan={vi.fn()}
        onNewChallan={vi.fn()}
        onOpenChallan={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('shows the letter’s PBG requirement beside the instruments', async () => {
    renderDetail(
      workDetailWith({
        pbgRequiredAmount: '45000.00',
        pbgSubmissionDays: 21,
        pbgExtensionDays: 60,
        pbgPenalInterestPercent: '12.000',
      }),
    );

    await screen.findByText('PBG required by the letter');
    expect(screen.getByText(/45,000/)).toBeTruthy();
    expect(
      screen.getByText(/21 days from the letter date \(\+60 days extension\)/),
    ).toBeTruthy();
    expect(screen.getByText('12.000% p.a.')).toBeTruthy();
    expect(
      screen.queryByText(
        'The letter records no Performance Bank Guarantee requirement.',
      ),
    ).toBeNull();
  });

  it('says so when the letter records no PBG requirement', async () => {
    renderDetail(
      workDetailWith({
        pbgRequiredAmount: null,
        pbgSubmissionDays: null,
        pbgExtensionDays: null,
        pbgPenalInterestPercent: null,
      }),
    );

    await screen.findByText(
      'The letter records no Performance Bank Guarantee requirement.',
    );
    expect(screen.queryByText('PBG required by the letter')).toBeNull();
  });
});

describe('Installations', () => {
  const ITEM_PLAIN = '44444444-4444-4444-8444-444444444444';
  const ITEM_SERIAL = '55555555-5555-4555-8555-555555555555';
  const LOCATION_ID = '66666666-6666-4666-8666-666666666666';
  const INSTALLATION_ID = '99999999-9999-4999-8999-999999999999';
  const SERIAL_ONE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const SERIAL_TWO = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
  const CHALLAN = '77777777-1111-4111-8111-777777777777';
  const CHALLAN_ITEM = '77777777-2222-4222-8222-777777777777';

  const WORK_ITEMS = [
    {
      id: ITEM_PLAIN,
      scheduleId: '77777777-7777-4777-8777-777777777777',
      itemNumber: 'A/1',
      description: 'Cable set',
      unitCode: 'Set',
      awardedQuantity: '10.000',
      effectiveRate: '250.00',
      requiresSerials: false,
    },
    {
      id: ITEM_SERIAL,
      scheduleId: '77777777-7777-4777-8777-777777777777',
      itemNumber: 'A/2',
      description: 'Main switchboard',
      unitCode: 'Nos',
      awardedQuantity: '5.000',
      effectiveRate: '100.00',
      requiresSerials: true,
    },
  ];

  const SERIALS = [
    {
      id: SERIAL_ONE,
      deliveryChallanId: CHALLAN,
      challanItemId: CHALLAN_ITEM,
      challanNumber: 'DC/1',
      itemDescription: 'Main switchboard',
      serialNumber: 'SN-001',
      installedOn: null,
      installationRemarks: null,
      workItemId: ITEM_SERIAL,
      challanStatus: 'issued' as const,
      installationId: null,
      installationLocation: null,
    },
    {
      id: SERIAL_TWO,
      deliveryChallanId: CHALLAN,
      challanItemId: CHALLAN_ITEM,
      challanNumber: 'DC/1',
      itemDescription: 'Main switchboard',
      serialNumber: 'SN-002',
      installedOn: null,
      installationRemarks: null,
      workItemId: ITEM_SERIAL,
      challanStatus: 'issued' as const,
      installationId: null,
      installationLocation: null,
    },
    {
      id: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa',
      deliveryChallanId: CHALLAN,
      challanItemId: CHALLAN_ITEM,
      challanNumber: 'DC/1',
      itemDescription: 'Main switchboard',
      serialNumber: 'SN-003',
      installedOn: '2026-08-01',
      installationRemarks: null,
      workItemId: ITEM_SERIAL,
      challanStatus: 'issued' as const,
      installationId: INSTALLATION_ID,
      installationLocation: 'Nashik Road station',
    },
  ];

  const LOCATION = {
    id: LOCATION_ID,
    name: 'Nashik Road station',
    kind: 'station' as const,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const RECORDED = {
    id: INSTALLATION_ID,
    workId: WORK_ID,
    workItemId: ITEM_SERIAL,
    itemNumber: 'A/2',
    quantity: '1.000',
    installedOn: '2026-08-01',
    locationId: LOCATION_ID,
    locationName: 'Nashik Road station',
    remarks: null,
    status: 'recorded' as const,
    cancellationNote: null,
    serials: [
      {
        serialId: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa',
        serialNumber: 'SN-003',
        challanNumber: 'DC/1',
      },
    ],
    createdAt: '2026-08-01T00:00:00.000Z',
    cancelledAt: null,
  };

  const LIST = {
    installations: [RECORDED],
    itemSummaries: [
      { workItemId: ITEM_PLAIN, itemNumber: 'A/1', installedQuantity: '0.000' },
      { workItemId: ITEM_SERIAL, itemNumber: 'A/2', installedQuantity: '1.000' },
    ],
  };

  function installationsApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      listWorkInstallations: vi.fn().mockResolvedValue(LIST),
      listLocationMasters: vi.fn().mockResolvedValue([LOCATION]),
      listWorkSerials: vi.fn().mockResolvedValue(SERIALS),
      ...overrides,
    });
  }

  function renderInstallations(
    api: ApiClient,
    options: Partial<{ canRecordEvidence: boolean }> = {},
  ) {
    return render(
      <Installations
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canRecordEvidence={options.canRecordEvidence ?? true}
        workItems={WORK_ITEMS}
        serials={SERIALS}
        onSerialsChanged={vi.fn()}
      />,
    );
  }

  it('shows the per-item installed summary and the records', async () => {
    renderInstallations(installationsApi());

    await screen.findByRole('heading', { name: 'Record installation' });
    // Summary rows: the authoritative installed quantity per item.
    expect(screen.getAllByText('1.000').length).toBeGreaterThan(0);
    expect(screen.getByText('0.000')).toBeTruthy();
    // The record row with its snapshot location and serials.
    expect(screen.getAllByText('Nashik Road station').length).toBeGreaterThan(0);
    expect(screen.getByText('SN-003')).toBeTruthy();
    expect(screen.getByText('recorded')).toBeTruthy();
  });

  it('records a plain quantity installation against an existing location', async () => {
    const recordWorkInstallation = vi.fn().mockResolvedValue({
      ...RECORDED,
      id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
      workItemId: ITEM_PLAIN,
      itemNumber: 'A/1',
      quantity: '2.500',
      serials: [],
      locationId: LOCATION_ID,
    });
    const api = installationsApi({ recordWorkInstallation });
    renderInstallations(api);

    fireEvent.change(await screen.findByLabelText('Work item'), {
      target: { value: ITEM_PLAIN },
    });
    fireEvent.change(screen.getByLabelText('Quantity installed'), {
      target: { value: '2.500' },
    });
    fireEvent.change(screen.getByLabelText('Installed on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('Location'), {
      target: { value: LOCATION_ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record installation' }));

    await waitFor(() => {
      expect(recordWorkInstallation).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        workItemId: ITEM_PLAIN,
        quantity: '2.500',
        installedOn: '2026-08-05',
        locationId: LOCATION_ID,
      });
    });
  });

  it('records a serialised installation with tap-selected serials and an inline location', async () => {
    const recordWorkInstallation = vi.fn().mockResolvedValue(RECORDED);
    const api = installationsApi({ recordWorkInstallation });
    renderInstallations(api);

    fireEvent.change(await screen.findByLabelText('Work item'), {
      target: { value: ITEM_SERIAL },
    });
    // The pool offers only delivered-but-uninstalled serials of the item.
    expect(screen.getByLabelText(/SN-001/)).toBeTruthy();
    expect(screen.getByLabelText(/SN-002/)).toBeTruthy();
    expect(screen.queryByLabelText(/SN-003/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Quantity installed'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Installed on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('Location'), {
      target: { value: '__new__' },
    });
    fireEvent.change(screen.getByLabelText('New location name'), {
      target: { value: 'Bhusawal yard' },
    });
    fireEvent.change(screen.getByLabelText('New location kind'), {
      target: { value: 'installation_point' },
    });
    fireEvent.click(screen.getByLabelText(/SN-001/));
    fireEvent.click(screen.getByLabelText(/SN-002/));
    fireEvent.click(screen.getByRole('button', { name: 'Record installation' }));

    await waitFor(() => {
      expect(recordWorkInstallation).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        workItemId: ITEM_SERIAL,
        quantity: '2',
        installedOn: '2026-08-05',
        newLocation: { name: 'Bhusawal yard', kind: 'installation_point' },
        serialIds: [SERIAL_ONE, SERIAL_TWO],
      });
    });
  });

  it('cancels a record with a mandatory note', async () => {
    const cancelWorkInstallation = vi.fn().mockResolvedValue({
      ...RECORDED,
      status: 'cancelled',
      cancellationNote: 'Wrong item picked',
      cancelledAt: '2026-08-06T00:00:00.000Z',
    });
    const api = installationsApi({ cancelWorkInstallation });
    renderInstallations(api);

    fireEvent.change(
      await screen.findByLabelText(/Cancellation note for A\/2 on 2026-08-01/),
      { target: { value: 'Wrong item picked' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel record' }));

    await waitFor(() => {
      expect(cancelWorkInstallation).toHaveBeenCalledWith(
        ORG_ID,
        INSTALLATION_ID,
        'Wrong item picked',
      );
    });
  });

  it('announces a cap conflict in an alert region', async () => {
    const recordWorkInstallation = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'INSTALLATION_EXCEEDS_LOA',
          'Cumulative installation for A/1 would exceed the sanctioned LOA quantity.',
        ),
      );
    const api = installationsApi({ recordWorkInstallation });
    renderInstallations(api);

    fireEvent.change(await screen.findByLabelText('Quantity installed'), {
      target: { value: '99' },
    });
    fireEvent.change(screen.getByLabelText('Installed on'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record installation' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('exceed the sanctioned LOA quantity');
  });

  it('hides recording and cancellation from read-only members', async () => {
    renderInstallations(installationsApi(), { canRecordEvidence: false });

    await screen.findByRole('heading', { name: 'Installations' });
    expect(screen.getByText('SN-003')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record installation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel record' })).toBeNull();
  });
});

describe('Correction flow (issued Delivery Challan)', () => {
  const issued = () =>
    challanDetail({
      status: 'issued',
      challanNumber: 'DC/1',
      sequenceNumber: 1,
      issuedAt: '2026-08-08T10:00:00.000Z',
    });

  function renderDetail(api: ApiClient, canModify = true) {
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={canModify}
        canIssue={false}
        canCancel={false}
        canRecordEvidence={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('offers cancel-and-replace for an evidence-free challan and files the proposal', async () => {
    const proposeChallanCancelReplace = vi.fn().mockResolvedValue({});
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(issued()),
      proposeChallanCancelReplace,
    });
    renderDetail(api);

    expect(
      await screen.findByRole('heading', { name: 'Request correction' }),
    ).toBeTruthy();
    // The lawful path and why it applies are stated.
    expect(
      screen.getByText(/no recorded receipt, serials, or measurements/),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Quantity — Main switchboard'), {
      target: { value: '3.000' },
    });
    fireEvent.change(screen.getByLabelText('Reason for correction'), {
      target: { value: 'Wrong quantity on the issued copy.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request cancel & replace' }));

    await waitFor(() => {
      expect(proposeChallanCancelReplace).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        reason: 'Wrong quantity on the issued copy.',
        replacement: {
          challanDate: '2026-08-08',
          prefix: 'DC',
          consignee: { name: 'Sr. DEE (G)', address: 'Delhi Division' },
          items: [{ workItemId: ITEM_A, quantity: '3.000' }],
        },
      });
    });
  });

  it('offers a correction notice when evidence blocks cancellation, stating why', async () => {
    const proposeChallanCorrectionNotice = vi.fn().mockResolvedValue({});
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(issued()),
      challanCorrectionEligibility: vi.fn().mockResolvedValue({
        challanId: CHALLAN_ID,
        status: 'issued',
        evidence: { receipts: 1, serials: 2, measurements: 0 },
        path: 'correction_notice',
        pendingRequestId: null,
      }),
      proposeChallanCorrectionNotice,
    });
    renderDetail(api);

    expect(
      await screen.findByRole('heading', { name: 'Request correction' }),
    ).toBeTruthy();
    expect(screen.getByText(/can no\s+longer be cancelled/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Correction statement'), {
      target: { value: 'The consignee designation reads Sr. DEE (G), not (W).' },
    });
    fireEvent.change(screen.getByLabelText('Reason for correction'), {
      target: { value: 'Typo carried from the LOA.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request correction notice' }));

    await waitFor(() => {
      expect(proposeChallanCorrectionNotice).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        reason: 'Typo carried from the LOA.',
        statement: 'The consignee designation reads Sr. DEE (G), not (W).',
      });
    });
  });

  it('shows the already-pending note instead of a second form', async () => {
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(issued()),
      challanCorrectionEligibility: vi.fn().mockResolvedValue({
        challanId: CHALLAN_ID,
        status: 'issued',
        evidence: { receipts: 0, serials: 0, measurements: 0 },
        path: 'cancel_replace',
        pendingRequestId: '99999999-9999-4999-8999-999999999999',
      }),
    });
    renderDetail(api);

    expect(await screen.findByText(/already awaiting a decision/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Request cancel & replace' }),
    ).toBeNull();
  });

  it('hides the correction section without modify rights', async () => {
    const api = stubApi({ getChallan: vi.fn().mockResolvedValue(issued()) });
    renderDetail(api, false);

    await screen.findByRole('heading', { name: 'Delivery Challan DC/1' });
    await waitFor(() => {
      expect(api.challanCorrectionEligibility).toHaveBeenCalled();
    });
    expect(screen.queryByRole('heading', { name: 'Request correction' })).toBeNull();
  });

  it('lists correction notices against the challan with their PDF action', async () => {
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(issued()),
      listChallanCorrectionNotices: vi.fn().mockResolvedValue([
        {
          id: 'bbbb4444-4444-4444-8444-444444444444',
          workId: WORK_ID,
          deliveryChallanId: CHALLAN_ID,
          approvalRequestId: '99999999-9999-4999-8999-999999999999',
          noticeNumber: 'DCW-1-CN-01',
          sequenceNumber: 1,
          status: 'issued',
          templateVersion: 'correction-notice-v1',
          renderedAvailable: true,
          cancellationNote: null,
          createdAt: '2026-08-09T00:00:00.000Z',
          cancelledAt: null,
        },
      ]),
    });
    renderDetail(api);

    expect(await screen.findByText('DCW-1-CN-01')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open PDF' })).toBeTruthy();
  });

  it('renders a correction request in the approvals queue with its type and document', async () => {
    const listApprovals = vi.fn().mockResolvedValue([
      {
        id: '99999999-9999-4999-8999-999999999999',
        entityType: 'challan_cancel_replace' as const,
        entityId: CHALLAN_ID,
        workId: WORK_ID,
        workCode: 'DCW-1',
        itemNumber: null,
        documentNumber: 'DC/1',
        proposed: { kind: 'cancel_replace_challan' },
        diff: [{ field: 'items', before: 'A/1 ×2.000', after: 'A/1 ×3.000' }],
        reason: 'Wrong quantity on the issued copy.',
        status: 'pending' as const,
        requestedByUserId: 'user-b',
        decidedByUserId: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: '2026-08-09T00:00:00.000Z',
      },
    ]);
    const api = stubApi({ listApprovals });
    render(
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-a"
        canApprove
        onChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText('Challan cancel & replace')).toBeTruthy();
    expect(screen.getByText('· DC/1')).toBeTruthy();
    expect(screen.getByText('A/1 ×3.000')).toBeTruthy();
  });
});

describe('PaymentMatrix', () => {
  const MATRIX_ITEM = {
    id: ITEM_A,
    scheduleId: '77777777-7777-4777-8777-777777777777',
    itemNumber: 'A/1',
    description: 'Main switchboard',
    unitCode: 'Nos',
    awardedQuantity: '5.000',
    effectiveRate: '100.00',
    requiresSerials: false,
    paymentCategory: null,
  };
  const SUPPLY_ROW = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    workId: WORK_ID,
    category: 'SUPPLY' as const,
    pctSupply: '80.00',
    pctInstallation: '10.00',
    pctPac: '0.00',
    pctFinalBill: '10.00',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };

  it('shows saved rows, states the R10 rule, and saves an edited row', async () => {
    const upsertPaymentMatrixRow = vi.fn().mockResolvedValue({
      ...SUPPLY_ROW,
      pctSupply: '70.00',
      pctFinalBill: '20.00',
    });
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]),
      upsertPaymentMatrixRow,
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[MATRIX_ITEM]}
        canModify
        onItemCategoryChanged={vi.fn()}
      />,
    );

    const supplyInput =
      await screen.findByLabelText<HTMLInputElement>('Supply % for Supply');
    expect(supplyInput.value).toBe('80.00');
    // Percentages are per category, never per item — the settled R10 note.
    expect(screen.getByText(/never per item/)).toBeTruthy();
    expect(screen.getByText(/settled decision R10/)).toBeTruthy();

    fireEvent.change(supplyInput, { target: { value: '70.00' } });
    fireEvent.change(screen.getByLabelText('Final bill % for Supply'), {
      target: { value: '20.00' },
    });
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    fireEvent.click(saveButtons[0] as HTMLElement);
    await waitFor(() => {
      expect(upsertPaymentMatrixRow).toHaveBeenCalledWith(ORG_ID, WORK_ID, 'SUPPLY', {
        pctSupply: '70.00',
        pctInstallation: '10.00',
        pctPac: '0.00',
        pctFinalBill: '20.00',
      });
    });
    expect((await screen.findByRole('status')).textContent).toContain(
      'Percentages saved',
    );
  });

  it('flags a sum that is not exactly 100 inline and disables the save', async () => {
    const upsertPaymentMatrixRow = vi.fn();
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]),
      upsertPaymentMatrixRow,
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[]}
        canModify
        onItemCategoryChanged={vi.fn()}
      />,
    );
    const supplyInput = await screen.findByLabelText('Supply % for Supply');
    fireEvent.change(supplyInput, { target: { value: '75.00' } });
    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((alert) =>
        (alert.textContent ?? '').includes('must sum to exactly 100'),
      ),
    ).toBe(true);
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    expect((saveButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect(upsertPaymentMatrixRow).not.toHaveBeenCalled();
  });

  it('removes a configured row', async () => {
    const deletePaymentMatrixRow = vi.fn().mockResolvedValue(undefined);
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]),
      deletePaymentMatrixRow,
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[]}
        canModify
        onItemCategoryChanged={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(deletePaymentMatrixRow).toHaveBeenCalledWith(ORG_ID, WORK_ID, 'SUPPLY');
    });
    expect((await screen.findByRole('status')).textContent).toContain('row removed');
  });

  it('sets an item payment category and reports it to the parent', async () => {
    const setWorkItemPaymentCategory = vi.fn().mockResolvedValue({
      id: ITEM_A,
      itemNumber: 'A/1',
      paymentCategory: 'SUPPLY',
    });
    const onItemCategoryChanged = vi.fn();
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([]),
      setWorkItemPaymentCategory,
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[MATRIX_ITEM]}
        canModify
        onItemCategoryChanged={onItemCategoryChanged}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Payment category for A/1'), {
      target: { value: 'SUPPLY' },
    });
    await waitFor(() => {
      expect(setWorkItemPaymentCategory).toHaveBeenCalledWith(ORG_ID, ITEM_A, 'SUPPLY');
    });
    expect(onItemCategoryChanged).toHaveBeenCalledWith(ITEM_A, 'SUPPLY');
  });

  it('renders read-only percentages and categories for viewers', async () => {
    const api = stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([SUPPLY_ROW]),
    });
    render(
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[{ ...MATRIX_ITEM, paymentCategory: 'SUPPLY' as const }]}
        canModify={false}
        onItemCategoryChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText('80.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByLabelText('Payment category for A/1')).toBeNull();
    expect(screen.getAllByText('Supply').length).toBeGreaterThan(0);
  });
});

describe('ReviewLoa payment categories', () => {
  it('sends the reviewer-selected category and omits it when uncategorised', async () => {
    const confirmLoa = vi
      .fn()
      .mockResolvedValue({ work: { id: WORK_ID }, schedules: [] });
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      confirmLoa,
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    const categorySelect = await screen.findByLabelText<HTMLSelectElement>(
      'Payment category for row 1 in schedule A',
    );
    expect(categorySelect.value).toBe('');
    fireEvent.change(categorySelect, { target: { value: 'SUPPLY_AND_INSTALLATION' } });
    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL270-CAT' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));

    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect(requestArg.schedules[0]?.items[0]?.paymentCategory).toBe(
      'SUPPLY_AND_INSTALLATION',
    );
  });

  it('omits the field entirely when the reviewer leaves an item uncategorised', async () => {
    const confirmLoa = vi
      .fn()
      .mockResolvedValue({ work: { id: WORK_ID }, schedules: [] });
    const api = stubApi({
      getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
      confirmLoa,
    });
    render(
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    const categorySelect = await screen.findByLabelText<HTMLSelectElement>(
      'Payment category for row 1 in schedule A',
    );
    expect(categorySelect.value).toBe('');
    fireEvent.change(screen.getByLabelText('Work code (your reference)'), {
      target: { value: 'PL270-UNC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));
    await waitFor(() => {
      expect(confirmLoa).toHaveBeenCalledOnce();
    });
    const [, , requestArg] = confirmLoa.mock.calls[0] as [
      string,
      string,
      ConfirmWorkRequest,
    ];
    expect('paymentCategory' in (requestArg.schedules[0]?.items[0] ?? {})).toBe(false);
  });
});

describe('PAC certificates', () => {
  const ITEM_ONE = '44444444-4444-4444-8444-444444444444';
  const ITEM_TWO = '55555555-5555-4555-8555-555555555555';
  const CONSIGNEE_ID = '66666666-6666-4666-8666-666666666666';
  const CERTIFICATE_ID = '99999999-9999-4999-8999-999999999999';

  const PAC_WORK_ITEMS = [
    {
      id: ITEM_ONE,
      scheduleId: '77777777-7777-4777-8777-777777777777',
      itemNumber: 'A/1',
      description: 'Cable set',
      unitCode: 'Set',
      awardedQuantity: '10.000',
      effectiveRate: '250.00',
      requiresSerials: false,
    },
    {
      id: ITEM_TWO,
      scheduleId: '77777777-7777-4777-8777-777777777777',
      itemNumber: 'A/2',
      description: 'Main switchboard',
      unitCode: 'Nos',
      awardedQuantity: '5.000',
      effectiveRate: '100.00',
      requiresSerials: true,
    },
  ];

  const CONSIGNEE = {
    id: CONSIGNEE_ID,
    designation: 'Sr. DEE (G) CR',
    address: 'Bhusawal Division',
    contactPerson: null,
    phone: null,
    email: null,
    gstin: null,
    pincode: null,
    stateCode: null,
    isConsignee: true,
    isVendor: false,
    isClient: false,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const RECORDED_PAC = {
    id: CERTIFICATE_ID,
    workId: WORK_ID,
    reference: 'PAC/2026/01',
    issueDate: '2026-08-01',
    consigneeMasterId: CONSIGNEE_ID,
    consigneeDesignation: 'Sr. DEE (G) CR',
    status: 'recorded' as const,
    cancellationNote: null,
    documentAvailable: false,
    items: [
      {
        workItemId: ITEM_TWO,
        itemNumber: 'A/2',
        certifiedQuantity: '2.000',
        releasedValue: null,
      },
    ],
    releasedValue: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    cancelledAt: null,
  };

  const PAC_LIST = {
    certificates: [RECORDED_PAC],
    itemSummaries: [
      {
        workItemId: ITEM_ONE,
        itemNumber: 'A/1',
        installedQuantity: '0.000',
        pacCertifiedQuantity: '0.000',
        availableQuantity: '0.000',
      },
      {
        workItemId: ITEM_TWO,
        itemNumber: 'A/2',
        installedQuantity: '3.000',
        pacCertifiedQuantity: '2.000',
        availableQuantity: '1.000',
      },
    ],
  };

  function pacApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      listWorkPacCertificates: vi.fn().mockResolvedValue(PAC_LIST),
      listContacts: vi.fn().mockResolvedValue([CONSIGNEE]),
      listWorkConsignees: vi.fn().mockResolvedValue([]),
      ...overrides,
    });
  }

  function renderPac(api: ApiClient, options: Partial<{ canModify: boolean }> = {}) {
    return render(
      <PacCertificates
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={options.canModify ?? true}
        workItems={PAC_WORK_ITEMS}
      />,
    );
  }

  it('shows the per-item certified summary and a null released value as a dash', async () => {
    renderPac(pacApi());

    await screen.findByRole('heading', { name: 'Record PAC certificate' });
    // Summary: installed / certified / available per item.
    expect(screen.getByText('3.000')).toBeTruthy();
    expect(screen.getAllByText('2.000').length).toBeGreaterThan(0);
    expect(screen.getByText('1.000')).toBeTruthy();
    // The certificate block with its consignee snapshot and status.
    expect(
      screen.getByRole('heading', { name: 'PAC PAC/2026/01 · 2026-08-01' }),
    ).toBeTruthy();
    expect(screen.getByText(/Issued by Sr\. DEE \(G\) CR/)).toBeTruthy();
    expect(screen.getByText('recorded')).toBeTruthy();
    // Released value is display-only and unresolved in phase 1: an em
    // dash, never a fabricated number.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('records a certificate with reference, date, consignee and per-item quantities', async () => {
    const recordWorkPacCertificate = vi.fn().mockResolvedValue({
      ...RECORDED_PAC,
      id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
      reference: 'PAC/2026/02',
    });
    const api = pacApi({ recordWorkPacCertificate });
    renderPac(api);

    fireEvent.change(await screen.findByLabelText('Certificate reference'), {
      target: { value: 'PAC/2026/02' },
    });
    fireEvent.change(screen.getByLabelText('Issue date'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText('Issuing consignee'), {
      target: { value: CONSIGNEE_ID },
    });
    // The per-item rows announce installed / certified / available.
    fireEvent.change(
      screen.getByLabelText(
        /A\/2 — Main switchboard \(installed 3\.000, certified 2\.000, available 1\.000\)/,
      ),
      { target: { value: '1.000' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Record PAC certificate' }));

    await waitFor(() => {
      expect(recordWorkPacCertificate).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        reference: 'PAC/2026/02',
        issueDate: '2026-08-05',
        consigneeMasterId: CONSIGNEE_ID,
        items: [{ workItemId: ITEM_TWO, certifiedQuantity: '1.000' }],
      });
    });
  });

  it('announces the R18 cap conflict in an alert region', async () => {
    const recordWorkPacCertificate = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'PAC_EXCEEDS_INSTALLED',
          'The certified quantity exceeds what installation records support — A/2: installed 3.000, already certified 2.000, available 1.000.',
        ),
      );
    const api = pacApi({ recordWorkPacCertificate });
    renderPac(api);

    fireEvent.change(await screen.findByLabelText('Certificate reference'), {
      target: { value: 'PAC/2026/03' },
    });
    fireEvent.change(screen.getByLabelText('Issue date'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.change(screen.getByLabelText(/A\/2 — Main switchboard/), {
      target: { value: '5.000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record PAC certificate' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'installed 3.000, already certified 2.000, available 1.000',
    );
  });

  it('cancels a certificate with a mandatory note', async () => {
    const cancelPacCertificate = vi.fn().mockResolvedValue({
      ...RECORDED_PAC,
      status: 'cancelled',
      cancellationNote: 'Superseded by the railway',
      cancelledAt: '2026-08-06T00:00:00.000Z',
    });
    const api = pacApi({ cancelPacCertificate });
    renderPac(api);

    fireEvent.change(
      await screen.findByLabelText('Cancellation note for PAC PAC/2026/01'),
      { target: { value: 'Superseded by the railway' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel certificate' }));

    await waitFor(() => {
      expect(cancelPacCertificate).toHaveBeenCalledWith(
        ORG_ID,
        CERTIFICATE_ID,
        'Superseded by the railway',
      );
    });
  });

  it('offers the scanned-certificate download when a document exists', async () => {
    const downloadPacCertificateDocument = vi.fn().mockResolvedValue(new Blob());
    const api = pacApi({
      listWorkPacCertificates: vi.fn().mockResolvedValue({
        ...PAC_LIST,
        certificates: [{ ...RECORDED_PAC, documentAvailable: true }],
      }),
      downloadPacCertificateDocument,
    });
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const createObjectURL = vi.fn().mockReturnValue('blob:pac');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    try {
      renderPac(api);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Open scanned certificate' }),
      );
      await waitFor(() => {
        expect(downloadPacCertificateDocument).toHaveBeenCalledWith(
          ORG_ID,
          CERTIFICATE_ID,
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hides recording, cancellation and upload from read-only members', async () => {
    renderPac(pacApi(), { canModify: false });

    await screen.findByRole('heading', { name: 'PAC certificates' });
    expect(
      screen.getByRole('heading', { name: 'PAC PAC/2026/01 · 2026-08-01' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record PAC certificate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel certificate' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Upload scanned certificate' }),
    ).toBeNull();
  });
});

describe('MeasurementBooks workspace', () => {
  const MB_DRAFT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const MB_FINAL_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const DC_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
  const INST_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
  const PAC_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  const ITEM_ID = 'ffffffff-6666-4666-8666-ffffffffffff';

  const MB_DRAFT = {
    id: MB_DRAFT_ID,
    workId: WORK_ID,
    status: 'draft' as const,
    isFinal: false,
    mbDate: '2026-08-05',
    mbNumber: null,
    sequenceNumber: null,
    totalAmount: null,
    remarkTemplateVersion: null,
    templateVersion: null,
    renderedAvailable: false,
    cancellationNote: null,
    billId: null,
    createdAt: '2026-08-05T00:00:00.000Z',
    finalizedAt: null,
    cancelledAt: null,
  };

  const MB_FINAL = {
    ...MB_DRAFT,
    id: MB_FINAL_ID,
    status: 'finalized' as const,
    isFinal: true,
    mbNumber: 'DCW-1-MB-02',
    sequenceNumber: 2,
    totalAmount: '4000.00',
    remarkTemplateVersion: 'mb-remark-v1',
    finalizedAt: '2026-08-05T10:00:00.000Z',
  };

  const LINE = {
    workItemId: ITEM_ID,
    itemNumber: 'A/1',
    description: 'Power cable',
    unitCode: 'mtr',
    paymentCategory: null,
    resolvedCategory: 'UNCATEGORISED',
    pctSupply: '80.00',
    pctInstallation: '10.00',
    pctPac: '0.00',
    pctFinalBill: '10.00',
    effectiveRate: '1.00',
    deltaSupplied: '5000.000',
    deltaInstalled: '0.000',
    deltaPac: '0.000',
    deltaFinalBill: '0.000',
    priorSupplied: '0.000',
    priorInstalled: '0.000',
    priorPac: '0.000',
    priorFinalBill: '0.000',
    amountSupply: '4000.00',
    amountInstallation: '0.00',
    amountPac: '0.00',
    amountFinalBill: '0.00',
    lineTotal: '4000.00',
    remark: 'Now to pay 80% for 5000 mtr.',
  };

  const DRAFT_DETAIL = {
    book: MB_DRAFT,
    sources: [],
    lines: [LINE],
    warnings: [],
    previewTotal: '4000.00',
  };

  const FINAL_DETAIL = {
    book: MB_FINAL,
    sources: [],
    lines: [LINE],
    warnings: [],
    previewTotal: '4000.00',
  };

  const CANDIDATES: Partial<ApiClient> = {
    listChallans: vi.fn().mockResolvedValue([
      {
        id: DC_ID,
        workId: WORK_ID,
        status: 'issued',
        challanNumber: 'DC/1',
        challanDate: '2026-08-01',
      },
    ]),
    listWorkInstallations: vi.fn().mockResolvedValue({
      installations: [
        {
          id: INST_ID,
          workId: WORK_ID,
          workItemId: ITEM_ID,
          itemNumber: 'A/1',
          quantity: '1000.000',
          installedOn: '2026-08-02',
          locationName: 'Nashik Road station',
          status: 'recorded',
        },
      ],
      itemSummaries: [],
    }),
    listWorkPacCertificates: vi.fn().mockResolvedValue({
      certificates: [
        {
          id: PAC_ID,
          workId: WORK_ID,
          reference: 'PAC/2026/01',
          issueDate: '2026-08-03',
          status: 'recorded',
          items: [],
        },
      ],
      itemSummaries: [],
    }),
  };

  function mbApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      listWorkMeasurementBooks: vi
        .fn()
        .mockResolvedValue({ books: [MB_FINAL, MB_DRAFT] }),
      getMeasurementBook: vi.fn().mockResolvedValue(DRAFT_DETAIL),
      ...CANDIDATES,
      ...overrides,
    });
  }

  function renderMb(
    api: ApiClient,
    options: Partial<{
      canModify: boolean;
      canIssue: boolean;
      canCancel: boolean;
      onBillPrepared: () => void;
    }> = {},
  ) {
    return render(
      <MeasurementBooks
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={options.canModify ?? true}
        canIssue={options.canIssue ?? true}
        canCancel={options.canCancel ?? true}
        onBillPrepared={options.onBillPrepared ?? vi.fn()}
      />,
    );
  }

  it('lists MBs with status chips, totals, and the FINAL BILL badge', async () => {
    renderMb(mbApi());

    await screen.findByRole('button', { name: 'DCW-1-MB-02' });
    expect(screen.getByRole('button', { name: 'Draft' })).toBeTruthy();
    expect(screen.getByText('finalized')).toBeTruthy();
    expect(screen.getAllByText('FINAL BILL').length).toBeGreaterThan(0);
    expect(screen.getByText('₹4,000.00')).toBeTruthy();
    // A draft and a live final MB exist: no create form is offered.
    expect(screen.queryByLabelText('MB date')).toBeNull();
  });

  it('creates a draft with the final-MB sweep explanation', async () => {
    const createWorkMeasurementBook = vi.fn().mockResolvedValue(DRAFT_DETAIL);
    const api = mbApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [] }),
      createWorkMeasurementBook,
    });
    renderMb(api);

    fireEvent.change(await screen.findByLabelText('MB date'), {
      target: { value: '2026-08-05' },
    });
    expect(screen.getByText(/must sweep every remaining open source/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Final Measurement Book/));
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    await waitFor(() => {
      expect(createWorkMeasurementBook).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        mbDate: '2026-08-05',
        isFinal: true,
      });
    });
  });

  it('offers to open the existing draft on the one-draft 409', async () => {
    const getMeasurementBook = vi.fn().mockResolvedValue(DRAFT_DETAIL);
    const api = mbApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [] }),
      createWorkMeasurementBook: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(
            409,
            'MB_DRAFT_EXISTS',
            'This Work already has a draft Measurement Book; finalize or delete it first.',
            { existingRecordId: MB_DRAFT_ID },
          ),
        ),
      getMeasurementBook,
    });
    renderMb(api);

    fireEvent.change(await screen.findByLabelText('MB date'), {
      target: { value: '2026-08-05' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    const open = await screen.findByRole('button', { name: 'Open existing draft' });
    fireEvent.click(open);
    await waitFor(() => {
      expect(getMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_DRAFT_ID);
    });
  });

  it('opens a draft with grouped source candidates, saves the selection, and shows the preview', async () => {
    const setMeasurementBookSources = vi.fn().mockResolvedValue(DRAFT_DETAIL);
    const api = mbApi({ setMeasurementBookSources });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));

    // Candidates grouped by type with human labels.
    await screen.findByText('Delivery challans (issued)');
    expect(screen.getByText('Installations (recorded)')).toBeTruthy();
    expect(screen.getByText('PAC certificates (recorded)')).toBeTruthy();
    expect(screen.getByText(/DC\/1 · 2026-08-01/)).toBeTruthy();
    expect(
      screen.getByText(/A\/1 × 1000\.000 · 2026-08-02 · Nashik Road station/),
    ).toBeTruthy();
    expect(screen.getByText(/PAC\/2026\/01 · 2026-08-03/)).toBeTruthy();

    // The live preview mirrors the PDF columns including the remark.
    expect(screen.getByText('Supplied Δ')).toBeTruthy();
    expect(screen.getByText('Now to pay 80% for 5000 mtr.')).toBeTruthy();
    expect(screen.getByText('Total payable this MB')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/DC\/1 · 2026-08-01/));
    fireEvent.click(screen.getByRole('button', { name: 'Save source selection' }));
    await waitFor(() => {
      expect(setMeasurementBookSources).toHaveBeenCalledWith(ORG_ID, MB_DRAFT_ID, {
        sources: [{ sourceType: 'delivery_challan', sourceId: DC_ID }],
      });
    });
  });

  it('marks a source claimed by another live MB from the structured 409', async () => {
    const api = mbApi({
      setMeasurementBookSources: vi.fn().mockRejectedValue(
        new RequestFailedError(
          409,
          'MB_SOURCE_ALREADY_BILLED',
          'A source can be billed by at most one live Measurement Book.',
          {
            sourceType: 'delivery_challan',
            sourceId: DC_ID,
            holdingMeasurementBookId: MB_FINAL_ID,
            holdingMbNumber: 'DCW-1-MB-02',
          },
        ),
      ),
    });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByLabelText(/DC\/1 · 2026-08-01/));
    fireEvent.click(screen.getByRole('button', { name: 'Save source selection' }));

    await screen.findByText('claimed by DCW-1-MB-02');
    expect(screen.getByRole('alert').textContent).toContain(
      'at most one live Measurement Book',
    );
  });

  it('links unresolved-category warnings to the payment matrix', async () => {
    const api = mbApi({
      getMeasurementBook: vi.fn().mockResolvedValue({
        ...DRAFT_DETAIL,
        lines: [],
        warnings: [
          { workItemId: ITEM_ID, itemNumber: 'A/1', missingCategory: 'SUPPLY' },
        ],
        previewTotal: '0.00',
      }),
    });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    await screen.findByText(/cannot price every selected item/);
    const link = screen.getByRole('link', { name: 'payment matrix' });
    expect(link.getAttribute('href')).toBe('#payment-matrix');
    expect(screen.getByText(/A\/1:/)).toBeTruthy();
  });

  it('finalizes through a confirm step naming the next number', async () => {
    const finalizeMeasurementBook = vi.fn().mockResolvedValue(FINAL_DETAIL);
    const api = mbApi({ finalizeMeasurementBook });
    renderMb(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize…' }));
    // The number is assigned at finalize; the confirm names the next slot
    // after the highest existing sequence (02 -> 03).
    await screen.findByText(/next number 03/);
    fireEvent.click(screen.getByRole('button', { name: 'Finalize now' }));

    await waitFor(() => {
      expect(finalizeMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_DRAFT_ID);
    });
  });

  it('streams the draft preview PDF from the preview endpoint', async () => {
    const downloadMeasurementBookDraftPreview = vi.fn().mockResolvedValue(new Blob());
    const api = mbApi({ downloadMeasurementBookDraftPreview });
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const createObjectURL = vi.fn().mockReturnValue('blob:mb');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    try {
      renderMb(api);
      fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Preview PDF (draft)' }),
      );
      await waitFor(() => {
        expect(downloadMeasurementBookDraftPreview).toHaveBeenCalledWith(
          ORG_ID,
          MB_DRAFT_ID,
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prepares the bill from a finalized MB and refreshes the Bills section', async () => {
    const prepareBillFromMeasurementBook = vi.fn().mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      billNumber: 1,
      mbId: MB_FINAL_ID,
    });
    const onBillPrepared = vi.fn();
    const api = mbApi({
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
      prepareBillFromMeasurementBook,
    });
    renderMb(api, { onBillPrepared });

    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare bill' }));

    await waitFor(() => {
      expect(prepareBillFromMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_FINAL_ID);
      expect(onBillPrepared).toHaveBeenCalled();
    });
  });

  it('renders and opens the finalized MB PDF, and cancels with a note', async () => {
    const renderMeasurementBook = vi.fn().mockResolvedValue({
      ...FINAL_DETAIL,
      book: { ...MB_FINAL, renderedAvailable: true, templateVersion: 'mb-v1' },
    });
    const downloadMeasurementBookPdf = vi.fn().mockResolvedValue(new Blob());
    const cancelMeasurementBook = vi.fn().mockResolvedValue({
      ...FINAL_DETAIL,
      book: {
        ...MB_FINAL,
        status: 'cancelled',
        cancellationNote: 'Wrong measurement basis.',
        cancelledAt: '2026-08-06T00:00:00.000Z',
      },
    });
    const api = mbApi({
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
      renderMeasurementBook,
      downloadMeasurementBookPdf,
      cancelMeasurementBook,
    });
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const createObjectURL = vi.fn().mockReturnValue('blob:mb');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    try {
      renderMb(api);

      fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Render PDF' }));
      await waitFor(() => {
        expect(renderMeasurementBook).toHaveBeenCalledWith(ORG_ID, MB_FINAL_ID);
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Open PDF' }));
      await waitFor(() => {
        expect(downloadMeasurementBookPdf).toHaveBeenCalledWith(ORG_ID, MB_FINAL_ID);
      });

      fireEvent.change(screen.getByLabelText(/Cancellation note/), {
        target: { value: 'Wrong measurement basis.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel Measurement Book' }));
      await waitFor(() => {
        expect(cancelMeasurementBook).toHaveBeenCalledWith(
          ORG_ID,
          MB_FINAL_ID,
          'Wrong measurement basis.',
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hides drafting and financial actions from members without the rights', async () => {
    const api = mbApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [MB_FINAL] }),
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
    });
    renderMb(api, { canModify: false, canIssue: false, canCancel: false });

    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    await screen.findByText('Now to pay 80% for 5000 mtr.');
    expect(screen.queryByLabelText('MB date')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare bill' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Render PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Finalize/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Cancel Measurement Book' }),
    ).toBeNull();
  });

  it('gates the cancel form on the CANCEL authority, not the issue authority', async () => {
    const api = mbApi({
      listWorkMeasurementBooks: vi.fn().mockResolvedValue({ books: [MB_FINAL] }),
      getMeasurementBook: vi.fn().mockResolvedValue(FINAL_DETAIL),
    });
    // Issue authority without cancel authority: financial actions offered,
    // the cancel form withheld (the server route requires can_cancel_documents).
    renderMb(api, { canIssue: true, canCancel: false });
    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    await screen.findByRole('button', { name: 'Prepare bill' });
    expect(
      screen.queryByRole('button', { name: 'Cancel Measurement Book' }),
    ).toBeNull();
    cleanup();

    // Cancel authority without issue authority: the cancel form is
    // offered, the financial actions are not.
    renderMb(api, { canIssue: false, canCancel: true });
    fireEvent.click(await screen.findByRole('button', { name: 'DCW-1-MB-02' }));
    await screen.findByRole('button', { name: 'Cancel Measurement Book' });
    expect(screen.queryByRole('button', { name: 'Prepare bill' })).toBeNull();
  });
});
