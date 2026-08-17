// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  TenderChecklistItem,
  TenderDetail,
  TenderNotice,
  TenderSummary,
} from '@auto-mb/contracts';
import { NitIntake } from '../../src/views/NitIntake.js';
import { TenderWorkspace } from '../../src/views/TenderWorkspace.js';
import { Tenders } from '../../src/views/Tenders.js';
import { ORG_ID, TENDER_ID, stubApi } from './helpers.js';

/*
 * The three tender screens, on the states the server can put them in.
 *
 * The shared loading / empty / failure patterns are covered once, for
 * every view at once, by `state-coverage.test.tsx`. What is here is what
 * only these screens have: the pipeline split, the marked extraction
 * proposal, and the validity reading that is the whole point of pointing
 * a bid checklist at the company document library.
 */

function summary(overrides: Partial<TenderSummary> = {}): TenderSummary {
  return {
    id: TENDER_ID,
    tenderNumber: 'WR-MMCT-S&T-34/2026',
    authority: 'Western Railway',
    title: 'Supply and commissioning of passenger information systems',
    bidClosesAtLocal: '2026-09-18T15:00',
    bidClosesAt: '2026-09-18T09:30:00.000Z',
    daysToClose: 12,
    status: 'drafted',
    checklistTotal: 0,
    checklistBlocking: 0,
    ...overrides,
  };
}

function line(overrides: Partial<TenderChecklistItem> = {}): TenderChecklistItem {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    title: 'GST registration certificate',
    mandatory: true,
    companyDocumentId: null,
    companyDocumentTitle: null,
    restricted: false,
    companyDocumentArchived: false,
    companyDocumentVersionNumber: null,
    expiresOn: null,
    validity: null,
    expiresInDaysAtClose: null,
    blocking: true,
    createdAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<TenderDetail> = {}): TenderDetail {
  return {
    ...summary(),
    estimatedValue: '84000000.00',
    emdAmount: '1680000.00',
    eligibilitySummary: 'Similar railway S&T works in three years.',
    irepsReference: null,
    noticeId: '66666666-6666-4666-8666-666666666666',
    noticeFilename: 'nit.pdf',
    award: null,
    checklist: [],
    statusEvents: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        fromStatus: null,
        toStatus: 'drafted',
        note: 'Created from the tender notice.',
        actorUserId: 'user-1',
        occurredAt: '2026-08-01T09:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('Tenders register', () => {
  it('splits the pipeline at the closing date and counts what blocks a bid', async () => {
    const api = stubApi({
      listTenders: vi.fn().mockResolvedValue({
        tenders: [
          summary({ checklistTotal: 4, checklistBlocking: 2 }),
          summary({
            id: '88888888-8888-4888-8888-888888888888',
            tenderNumber: 'CR/2025/EL/9',
            title: 'Signalling cable renewal',
            bidClosesAt: '2026-08-12T08:30:00.000Z',
            daysToClose: -6,
            status: 'lost',
          }),
        ],
      }),
    });
    render(
      <Tenders
        api={api}
        organisationId={ORG_ID}
        canModify
        onOpenTender={vi.fn()}
        onUploadNotice={vi.fn()}
      />,
    );

    // Upcoming is the tab the register opens on, and only the open
    // tender is in it.
    expect(await screen.findByText('WR-MMCT-S&T-34/2026')).toBeTruthy();
    expect(screen.queryByText('CR/2025/EL/9')).toBeNull();
    expect(screen.getByText('2 blocking')).toBeTruthy();
    expect(screen.getByText('12 days left')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expired (1)' }));
    expect(await screen.findByText('CR/2025/EL/9')).toBeTruthy();
    expect(screen.getByText('closed 6 days ago')).toBeTruthy();
    expect(screen.queryByText('WR-MMCT-S&T-34/2026')).toBeNull();
  });

  it('opens a row through a real hash link', async () => {
    const onOpenTender = vi.fn();
    const api = stubApi({
      listTenders: vi.fn().mockResolvedValue({ tenders: [summary()] }),
    });
    render(
      <Tenders
        api={api}
        organisationId={ORG_ID}
        canModify={false}
        onOpenTender={onOpenTender}
        onUploadNotice={vi.fn()}
      />,
    );

    const row = await screen.findByRole('link', { name: /WR-MMCT-S&T-34\/2026/ });
    expect(row.getAttribute('href')).toBe(`#/tenders/${TENDER_ID}`);
    fireEvent.click(row);
    expect(onOpenTender).toHaveBeenCalledWith(TENDER_ID);
  });
});

describe('NIT intake', () => {
  const notice: TenderNotice = {
    id: '66666666-6666-4666-8666-666666666666',
    originalFilename: 'nit.pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 2048,
    extractionStatus: 'review',
    proposal: {
      tenderNumber: {
        value: 'WR-MMCT-S&T-34/2026',
        raw: 'Tender No.: WR-MMCT-S&T-34/2026',
        needsReview: false,
      },
      authority: { value: 'Western Railway', raw: null, needsReview: false },
      title: { value: 'Passenger information systems', raw: null, needsReview: false },
      bidClosesAtLocal: {
        value: '2026-09-18T15:00',
        raw: null,
        needsReview: false,
      },
      estimatedValue: { value: null, raw: null, needsReview: true },
      emdAmount: { value: '1680000.00', raw: null, needsReview: false },
      eligibility: { value: null, raw: null, needsReview: false },
      needsReviewTotal: 1,
      identityUnresolved: false,
    },
    extractionError: null,
    confirmedTenderId: null,
    createdAt: '2026-08-01T09:00:00.000Z',
  };

  function pick(): void {
    const input = document.querySelector<HTMLInputElement>('#nit-file');
    if (input === null) throw new Error('no file input');
    fireEvent.change(input, {
      target: {
        files: [new File(['%PDF-1.4'], 'nit.pdf', { type: 'application/pdf' })],
      },
    });
  }

  it('marks the fields it could not read, and sends what the reviewer accepted', async () => {
    const uploadTenderNotice = vi.fn().mockResolvedValue(notice);
    const confirmTenderNotice = vi.fn().mockResolvedValue(detail());
    const onConfirmed = vi.fn();
    render(
      <NitIntake
        api={stubApi({ uploadTenderNotice, confirmTenderNotice })}
        organisationId={ORG_ID}
        onConfirmed={onConfirmed}
        onCancel={vi.fn()}
      />,
    );

    // Nothing to review before a notice is uploaded.
    expect(
      screen.getByText('Upload an NIT to prefill the tender record.'),
    ).toBeTruthy();

    pick();
    fireEvent.click(screen.getByRole('button', { name: /Extract tender details/ }));

    const number = await screen.findByLabelText<HTMLInputElement>('Tender number');
    expect(number.value).toBe('WR-MMCT-S&T-34/2026');
    expect(screen.getByLabelText<HTMLInputElement>('Bid deadline').value).toBe(
      '2026-09-18T15:00',
    );
    // The one field the reader could not resolve says so in words, not
    // only in colour.
    expect(screen.getByText(/1 field could not be read confidently/)).toBeTruthy();
    expect(
      screen.getByText(/Not read confidently — check this against the notice/),
    ).toBeTruthy();

    // The reviewer corrects the reading; the record must carry theirs.
    fireEvent.change(screen.getByLabelText('Estimated value'), {
      target: { value: '84000000.00' },
    });
    fireEvent.change(screen.getByLabelText('Railway / authority'), {
      target: { value: 'Western Railway — Mumbai Central' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirm and create tender/ }));

    await waitFor(() => {
      expect(confirmTenderNotice).toHaveBeenCalled();
    });
    expect(confirmTenderNotice.mock.calls[0]?.[2]).toMatchObject({
      tenderNumber: 'WR-MMCT-S&T-34/2026',
      authority: 'Western Railway — Mumbai Central',
      bidClosesAtLocal: '2026-09-18T15:00',
      estimatedValue: '84000000.00',
    });
    expect(onConfirmed).toHaveBeenCalled();
  });

  it('says a scan could not be read and still offers the form', async () => {
    const uploadTenderNotice = vi.fn().mockResolvedValue({
      ...notice,
      extractionStatus: 'failed' as const,
      proposal: null,
      extractionError: 'no text layer',
    });
    render(
      <NitIntake
        api={stubApi({ uploadTenderNotice })}
        organisationId={ORG_ID}
        onConfirmed={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    pick();
    fireEvent.click(screen.getByRole('button', { name: /Extract tender details/ }));

    expect(await screen.findByText(/This PDF has no readable text layer/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Tender number').value).toBe('');
  });
});

describe('Tender workspace', () => {
  function renderWorkspace(tender: TenderDetail, overrides = {}) {
    const api = stubApi({
      getTender: vi.fn().mockResolvedValue(tender),
      listCompanyDocuments: vi.fn().mockResolvedValue({
        documents: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            title: 'GST registration certificate',
            category: 'statutory' as const,
            versions: [],
            expiryStatus: 'valid' as const,
            expiresInDays: 200,
            archivedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        expiryWarningDays: 60,
      }),
      ...overrides,
    });
    render(
      <TenderWorkspace
        api={api}
        organisationId={ORG_ID}
        tenderId={TENDER_ID}
        canModify
        onOpenWork={vi.fn()}
        onUploadAwardLetter={vi.fn()}
      />,
    );
    return api;
  }

  it('reads an attached credential against the closing date, not against today', async () => {
    renderWorkspace(
      detail({
        checklistTotal: 1,
        checklistBlocking: 1,
        checklist: [
          line({
            companyDocumentId: '99999999-9999-4999-8999-999999999999',
            companyDocumentTitle: 'GST registration certificate',
            companyDocumentVersionNumber: 3,
            expiresOn: '2026-08-30',
            validity: 'expired',
            expiresInDaysAtClose: -19,
            blocking: true,
          }),
        ],
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Bid checklist' }));
    // The chip says the tender's question, not the library's.
    expect(await screen.findByText('Expired by close')).toBeTruthy();
    expect(screen.getByText(/days before the bid/)).toBeTruthy();
    expect(screen.getByText('19')).toBeTruthy();
  });

  it('will not offer a submission while a mandatory line is unanswered', async () => {
    renderWorkspace(
      detail({ checklistTotal: 1, checklistBlocking: 1, checklist: [line()] }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'iREPS submission' }));
    const submit = await screen.findByRole('button', { name: /Record submission/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/1 mandatory line still/)).toBeTruthy();
  });

  it('says plainly that iREPS is tracked and never driven', async () => {
    renderWorkspace(detail());
    fireEvent.click(await screen.findByRole('button', { name: 'iREPS submission' }));
    expect(await screen.findByText('Tracking only')).toBeTruthy();
    expect(screen.getByText(/never files on your behalf/)).toBeTruthy();
  });

  it('offers the award conversion only once the tender was won', async () => {
    renderWorkspace(detail({ status: 'awarded' }));
    expect(
      await screen.findByRole('button', {
        name: /Upload the Letter of Acceptance/,
      }),
    ).toBeTruthy();
  });

  it('links the Work the award letter became', async () => {
    renderWorkspace(
      detail({
        status: 'awarded',
        award: {
          loaDocumentId: '12121212-1212-4212-8212-121212121212',
          loaFilename: 'loa.pdf',
          workId: '33333333-3333-4333-8333-333333333333',
          workCode: 'WR-2026-14',
        },
      }),
    );
    const link = await screen.findByRole('link', { name: /Open Work WR-2026-14/ });
    expect(link.getAttribute('href')).toBe(
      '#/works/33333333-3333-4333-8333-333333333333',
    );
  });

  it('attaches a library credential to a checklist line', async () => {
    const attachTenderChecklistDocument = vi
      .fn()
      .mockResolvedValue(
        detail({ checklistTotal: 1, checklistBlocking: 0, checklist: [line()] }),
      );
    renderWorkspace(
      detail({ checklistTotal: 1, checklistBlocking: 1, checklist: [line()] }),
      { attachTenderChecklistDocument },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Bid checklist' }));
    const select = await screen.findByLabelText(
      /Company credential for GST registration certificate/,
    );
    fireEvent.change(select, {
      target: { value: '99999999-9999-4999-8999-999999999999' },
    });

    await waitFor(() => {
      expect(attachTenderChecklistDocument).toHaveBeenCalledWith(
        ORG_ID,
        TENDER_ID,
        line().id,
        '99999999-9999-4999-8999-999999999999',
      );
    });
  });

  it('locks the checklist once the bid has gone out', async () => {
    renderWorkspace(
      detail({
        status: 'submitted',
        checklistTotal: 1,
        checklistBlocking: 0,
        checklist: [line({ blocking: false })],
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Bid checklist' }));
    expect(await screen.findByText(/no longer changes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });
});
