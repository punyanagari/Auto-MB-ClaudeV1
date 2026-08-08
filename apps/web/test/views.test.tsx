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
import { ChallanDetail } from '../src/views/ChallanDetail.js';
import { ChallanEditor } from '../src/views/ChallanEditor.js';
import { CompletionExtensions } from '../src/views/CompletionExtensions.js';
import { Members } from '../src/views/Members.js';
import { OrgPicker } from '../src/views/OrgPicker.js';
import { ReviewLoa } from '../src/views/ReviewLoa.js';
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
    listInstruments: vi.fn().mockResolvedValue([]),
    createInstrument: vi.fn(),
    updateInstrument: vi.fn(),
    listMbEntries: vi.fn().mockResolvedValue([]),
    recordMbEntry: vi.fn(),
    listBills: vi.fn().mockResolvedValue([]),
    prepareBill: vi.fn(),
    setBillStatus: vi.fn(),
    workTimeline: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
    entityTimeline: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
    listConsigneeMasters: vi.fn().mockResolvedValue([]),
    saveConsigneeMaster: vi.fn(),
    setConsigneeMasterActive: vi.fn(),
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

  it('prepares a bill from unbilled measurements and moves it forward', async () => {
    const prepareBill = vi.fn().mockResolvedValue(BILL);
    const setBillStatus = vi.fn().mockResolvedValue({
      ...BILL,
      status: 'submitted',
      submittedAt: '2026-08-08T11:00:00.000Z',
    });
    const listBills = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([BILL]);
    const listMbEntries = vi
      .fn()
      .mockResolvedValueOnce([MB_ENTRY])
      .mockResolvedValue([{ ...MB_ENTRY, billId: BILL.id }]);
    const api = retentionApi({ prepareBill, setBillStatus, listBills, listMbEntries });
    renderWorkDetail(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Prepare bill' }));
    await waitFor(() => {
      expect(prepareBill).toHaveBeenCalledWith(ORG_ID, WORK_ID);
    });
    expect(await screen.findByRole('heading', { name: /Bill #1/ })).toBeTruthy();

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
    flags: Partial<{ canModify: boolean; canIssue: boolean }> = {},
  ) {
    return render(
      <CompletionExtensions
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify={flags.canModify ?? true}
        canIssue={flags.canIssue ?? true}
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
    active: true,
    createdAt: '2026-08-08T00:00:00.000Z',
  };

  it('lists consignees and adds one through the form', async () => {
    const saveConsigneeMaster = vi.fn().mockResolvedValue(CONSIGNEE);
    const api = stubApi({
      listConsigneeMasters: vi.fn().mockResolvedValue([CONSIGNEE]),
      saveConsigneeMaster,
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
    fireEvent.click(screen.getByRole('button', { name: 'Add consignee' }));

    await waitFor(() => {
      expect(saveConsigneeMaster).toHaveBeenCalledWith(ORG_ID, null, {
        designation: 'SSE (Signal) GZB',
        address: 'Signal Workshop, Ghaziabad',
      });
    });
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('retires a consignee and surfaces duplicate conflicts as alerts', async () => {
    const setConsigneeMasterActive = vi
      .fn()
      .mockResolvedValue({ ...CONSIGNEE, active: false });
    const saveConsigneeMaster = vi
      .fn()
      .mockRejectedValue(
        new RequestFailedError(
          409,
          'CONSIGNEE_MASTER_EXISTS',
          'A consignee with this designation and address already exists.',
        ),
      );
    const api = stubApi({
      listConsigneeMasters: vi.fn().mockResolvedValue([CONSIGNEE]),
      setConsigneeMasterActive,
      saveConsigneeMaster,
    });
    const { Masters } = await import('../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(setConsigneeMasterActive).toHaveBeenCalledWith(
        ORG_ID,
        CONSIGNEE.id,
        false,
      );
    });

    fireEvent.change(screen.getByLabelText('Designation / name'), {
      target: { value: 'Sr. DEE (G) NR' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add consignee' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already exists');
  });

  it('hides mutations from read-only members', async () => {
    const api = stubApi({
      listConsigneeMasters: vi.fn().mockResolvedValue([CONSIGNEE]),
    });
    const { Masters } = await import('../src/views/Masters.js');
    render(<Masters api={api} organisationId={ORG_ID} canModify={false} />);

    expect(await screen.findByText('Sr. DEE (G) NR')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add consignee' })).toBeNull();
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
      listConsigneeMasters: vi.fn().mockResolvedValue([
        {
          id: '44444444-4444-4444-8444-444444444444',
          designation: 'Sr. DEE (G) NR',
          address: 'Delhi Division, New Delhi',
          contactPerson: null,
          phone: '011-23385678',
          email: null,
          active: true,
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      ]),
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
    fireEvent.change(screen.getByLabelText('Prefill consignee from masters'), {
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
