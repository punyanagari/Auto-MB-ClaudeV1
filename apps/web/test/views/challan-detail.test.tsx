// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ApiClient } from '../../src/api.js';
import { Approvals } from '../../src/views/Approvals.js';
import { ChallanDetail } from '../../src/views/ChallanDetail.js';
import {
  openForm,
  submitButton,
  stubApi,
  ORG_ID,
  WORK_ID,
  CHALLAN_ID,
  ITEM_A,
  challanDetail,
  challanWork,
} from './helpers.js';

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
      getWork: vi.fn().mockResolvedValue(challanWork()),
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

    fireEvent.click(screen.getByRole('button', { name: 'Cancel challan' }));
    // The dialog says what cancelling costs before it asks for a reason,
    // and holds its own confirm until one is given.
    expect(
      screen.getByText(/its number will never be reused/i),
    ).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirm cancellation' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Wrong consignee.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
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

    // Nothing is recorded yet, so the serials section already leads with
    // its form; the installation form opens on request.
    fireEvent.change(await screen.findByLabelText('Serial numbers (one per line)'), {
      target: { value: 'SN-001\n\n' },
    });
    fireEvent.click(submitButton('Record serials'));

    await waitFor(() => {
      expect(recordSerials).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        challanItemId: '66666666-6666-4666-8666-666666666666',
        serialNumbers: ['SN-001'],
      });
    });
    // The serial shows in the table and in the installation picker.
    expect((await screen.findAllByText('SN-001')).length).toBeGreaterThan(0);

    await openForm('New installation');
    fireEvent.change(screen.getByLabelText('Installed on'), {
      target: { value: '2026-08-06' },
    });
    fireEvent.click(submitButton('Record installation'));
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
      getWork: vi.fn().mockResolvedValue(challanWork()),
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

/** The Work page splits its areas across tabs, so a test that asserts on one
 * area opens it first — exactly as an operator does. The tab's accessible
 * name carries its count, so match on the label prefix. */

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
    await openForm('Request cancel & replace…');
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
    fireEvent.click(submitButton('Request cancel & replace'));

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
    await openForm('Request correction notice…');
    expect(screen.getByText(/can no\s+longer be cancelled/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Correction statement'), {
      target: { value: 'The consignee designation reads Sr. DEE (G), not (W).' },
    });
    fireEvent.change(screen.getByLabelText('Reason for correction'), {
      target: { value: 'Typo carried from the LOA.' },
    });
    fireEvent.click(submitButton('Request correction notice'));

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
        variationOrder: null,
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

describe('ChallanDetail cancel surface', () => {
  const issued = () =>
    challanDetail({
      status: 'issued',
      challanNumber: 'DC/1',
      sequenceNumber: 1,
      issuedAt: '2026-08-08T10:00:00.000Z',
    });

  function renderIssued(api: ApiClient, workActive = true) {
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify={false}
        canIssue={false}
        canCancel
        canRecordEvidence={false}
        workActive={workActive}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );
  }

  it('closes the cancel form when the loaded evidence already blocks it, naming what is recorded', async () => {
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(issued()),
      challanCorrectionEligibility: vi.fn().mockResolvedValue({
        challanId: CHALLAN_ID,
        status: 'issued',
        evidence: { receipts: 1, serials: 2, measurements: 0 },
        path: 'correction_notice',
        pendingRequestId: null,
      }),
    });
    renderIssued(api);

    // The section stays — a cancel-authority holder who knows the form
    // exists is told why it is closed rather than left thinking the page
    // is broken — but nothing can be submitted from it.
    expect(
      await screen.findByRole('heading', { name: 'Cancel this challan' }),
    ).toBeTruthy();
    expect(
      screen.getByText(/1 receipt\(s\), 2 serial\(s\), and 0 measurement\(s\)/),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Cancellation note')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel challan' })).toBeNull();
    expect(api.cancelChallan).not.toHaveBeenCalled();
  });

  it('closes the cancel form while a correction request is awaiting a decision', async () => {
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
    renderIssued(api);

    expect(
      await screen.findByRole('heading', { name: 'Cancel this challan' }),
    ).toBeTruthy();
    expect(screen.getByText(/cancelling here would go around it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel challan' })).toBeNull();
  });

  it('still cancels an evidence-free issued challan', async () => {
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
      getChallan: vi.fn().mockResolvedValue(issued()),
      cancelChallan,
    });
    renderIssued(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel challan' }));
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Wrong consignee.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => {
      expect(cancelChallan).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        note: 'Wrong consignee.',
      });
    });
  });

  it('closes cancel and correction on a completed Work, keeping the record downloadable', async () => {
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue({
        ...issued(),
        challan: { ...issued().challan, renderedAvailable: true },
      }),
    });
    render(
      <ChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId={CHALLAN_ID}
        canModify
        canIssue={false}
        canCancel
        canRecordEvidence={false}
        workActive={false}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    await screen.findByRole('heading', { name: 'Delivery Challan DC/1' });
    // Audit surface: the challan, its lines, and its PDF stay.
    expect(screen.getByText('Main switchboard')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open PDF' })).toBeTruthy();
    // Both mutating forms close, each with its own explanation.
    expect(screen.queryByRole('button', { name: 'Cancel challan' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Request cancel & replace' }),
    ).toBeNull();
    expect(screen.getAllByText(/Reopen the Work from its page/).length).toBe(2);
  });
});

describe('Draft challan serial recording', () => {
  const DRAFT_LINE_ID = '66666666-6666-4666-8666-666666666666';
  const draftSerial = (serialNumber: string, id: string) => ({
    id,
    deliveryChallanId: CHALLAN_ID,
    challanItemId: DRAFT_LINE_ID,
    challanNumber: null,
    itemDescription: 'Main switchboard',
    serialNumber,
    installedOn: null,
    installationRemarks: null,
  });

  it('records serials against the DRAFT and says what still holds the issue', async () => {
    const recorded = [
      draftSerial('SN-001', '88888888-8888-4888-8888-888888888888'),
      draftSerial('SN-002', '88888888-8888-4888-8888-888888888889'),
    ];
    const recordSerials = vi.fn().mockResolvedValue(recorded);
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(challanDetail()),
      getWork: vi.fn().mockResolvedValue(challanWork(true)),
      recordSerials,
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

    // The dead end the flag used to walk into: Issue is offered, and the
    // page now names the line the server would refuse the issue for.
    expect(
      await screen.findByText(/Main switchboard \(0 of 2 recorded\)/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Issue challan' })).toBeTruthy();

    // The draft has no serial recorded, so its form leads the section.
    fireEvent.change(screen.getByLabelText('Serial numbers (one per line)'), {
      target: { value: 'SN-001\nSN-002\n' },
    });
    fireEvent.click(submitButton('Record serials'));

    await waitFor(() => {
      expect(recordSerials).toHaveBeenCalledWith(ORG_ID, CHALLAN_ID, {
        challanItemId: DRAFT_LINE_ID,
        serialNumbers: ['SN-001', 'SN-002'],
      });
    });
    // The line is complete, so the outstanding warning goes.
    await waitFor(() => {
      expect(screen.queryByText(/Main switchboard \(0 of 2 recorded\)/)).toBeNull();
    });
    expect(screen.getByText('SN-001, SN-002')).toBeTruthy();
  });

  it('leaves a draft with no serial-tracked line alone', async () => {
    const api = stubApi({
      getChallan: vi.fn().mockResolvedValue(challanDetail()),
      getWork: vi.fn().mockResolvedValue(challanWork(false)),
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

    expect(
      await screen.findByRole('heading', { name: 'Draft Delivery Challan' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Issue challan' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Serial numbers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record serials' })).toBeNull();
    expect(screen.queryByText(/Serials outstanding/)).toBeNull();
  });
});
