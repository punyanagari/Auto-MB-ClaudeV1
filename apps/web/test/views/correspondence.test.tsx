// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CorrespondenceEntry } from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';
import { Correspondence } from '../../src/views/Correspondence.js';
import { WriteOutwardLetter } from '../../src/views/CorrespondenceComposer.js';
import { ORG_ID, WORK_ID, stubApi } from './helpers.js';

/*
 * The correspondence register and its composer.
 *
 * The shared loading / empty / failure patterns are covered once for
 * every view by `state-coverage.test.tsx`. What is here is what only
 * these screens have: the four tabs reading three different modules, the
 * derived status vocabulary, the Reference cell that carries two facts,
 * and the composer refusing to send an incomplete letter.
 */

function entry(overrides: Partial<CorrespondenceEntry> = {}): CorrespondenceEntry {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    source: 'letter',
    direction: 'outward',
    number: 'OUT/26-27/047',
    date: '2026-07-22',
    counterparty: 'Sr. DSTE/MMCT',
    subject: 'Submission of approved makes and technical datasheets',
    workId: WORK_ID,
    workCode: 'PL-281',
    reference: null,
    status: 'sent',
    extensionUntil: null,
    replyDueOn: null,
    documentAvailable: true,
    ...overrides,
  };
}

function answer(
  entries: CorrespondenceEntry[],
  overrides: Partial<{
    counts: { outward: number; inward: number; extensions: number; inspection: number };
    awaitingExtensionResponses: number;
  }> = {},
) {
  return {
    entries,
    nextCursor: null,
    counts: overrides.counts ?? {
      outward: entries.length,
      inward: 0,
      extensions: 0,
      inspection: 0,
    },
    awaitingExtensionResponses: overrides.awaitingExtensionResponses ?? 0,
  };
}

const noop = (): void => undefined;

function renderRegister(api: ReturnType<typeof stubApi>) {
  return render(
    <Correspondence
      api={api}
      organisationId={ORG_ID}
      canModify
      onWriteLetter={noop}
      onUploadInward={noop}
    />,
  );
}

describe('the correspondence register', () => {
  it('carries every tab count whichever tab is open', async () => {
    const api = stubApi({
      listCorrespondence: vi.fn().mockResolvedValue(
        answer([entry()], {
          counts: { outward: 3, inward: 5, extensions: 2, inspection: 4 },
        }),
      ),
    });
    renderRegister(api);

    await screen.findByRole('button', { name: 'Outward (3)' });
    expect(screen.getByRole('button', { name: 'Inward (5)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Extension requests (2)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inspection letters (4)' })).toBeTruthy();
  });

  it('asks the server for the tab that was picked, not a client filter', async () => {
    const listCorrespondence = vi.fn().mockResolvedValue(answer([entry()]));
    renderRegister(stubApi({ listCorrespondence }));

    await screen.findByRole('button', { name: /Outward/ });
    expect(listCorrespondence).toHaveBeenCalledWith(ORG_ID, { tab: 'outward' });

    fireEvent.click(screen.getByRole('button', { name: /Extension requests/ }));
    await waitFor(() => {
      expect(listCorrespondence).toHaveBeenCalledWith(ORG_ID, { tab: 'extensions' });
    });
  });

  it('shows the extension-until column on the extensions tab only', async () => {
    const listCorrespondence = vi
      .fn<ApiClient['listCorrespondence']>()
      .mockImplementation((_org, options) =>
        Promise.resolve(
          options?.tab === 'extensions'
            ? answer([
                entry({
                  source: 'extension',
                  number: 'PL-281-Extension-01',
                  status: 'approved',
                  extensionUntil: '2027-02-28',
                }),
              ])
            : answer([entry()]),
        ),
      );
    renderRegister(stubApi({ listCorrespondence }));

    await screen.findByText('OUT/26-27/047');
    expect(screen.queryByRole('columnheader', { name: 'Extension until' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Extension requests/ }));
    await screen.findByRole('columnheader', { name: 'Extension until' });
    expect(screen.getByText('28 Feb 2027')).toBeTruthy();
  });

  it('puts the Work code over the reference, and says so when there is none', async () => {
    renderRegister(
      stubApi({
        listCorrespondence: vi.fn().mockResolvedValue(
          answer([
            entry({ reference: 'S&T/PA/Approval/118 · 2026-07-28' }),
            entry({
              id: '88888888-8888-4888-8888-888888888888',
              number: 'OUT/26-27/048',
              workId: null,
              workCode: null,
              reference: null,
            }),
          ]),
        ),
      }),
    );
    await screen.findByText('S&T/PA/Approval/118 · 2026-07-28');
    expect(screen.getByText('PL-281')).toBeTruthy();
    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.getByText('No reference')).toBeTruthy();
  });

  it('opens a letter from its number, and only where a document exists', async () => {
    const downloadCorrespondenceLetter = vi
      .fn()
      .mockResolvedValue(new Blob(['%PDF-'], { type: 'application/pdf' }));
    // `openPdf` claims a tab synchronously; jsdom's window.open is a stub
    // that returns null, which is the popup-blocked path and needs no
    // navigation.
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderRegister(
      stubApi({
        listCorrespondence: vi.fn().mockResolvedValue(
          answer([
            entry(),
            entry({
              id: '99999999-9999-4999-8999-999999999999',
              source: 'inspection',
              number: 'INS/PL-281/1',
              documentAvailable: false,
            }),
          ]),
        ),
        downloadCorrespondenceLetter,
      }),
    );

    const link = await screen.findByRole('button', { name: 'OUT/26-27/047' });
    fireEvent.click(link);
    await waitFor(() => {
      expect(downloadCorrespondenceLetter).toHaveBeenCalledWith(
        ORG_ID,
        '77777777-7777-4777-8777-777777777777',
      );
    });
    // A projected row with no reachable document is text, not a control
    // pointing at an endpoint that does not own it.
    expect(screen.queryByRole('button', { name: 'INS/PL-281/1' })).toBeNull();
    expect(screen.getByText('INS/PL-281/1')).toBeTruthy();
  });

  it('counts awaiting extension responses in the plural the number needs', async () => {
    const { unmount } = renderRegister(
      stubApi({
        listCorrespondence: vi
          .fn()
          .mockResolvedValue(answer([entry()], { awaitingExtensionResponses: 1 })),
      }),
    );
    await screen.findByText('1 extension request awaiting response');
    unmount();

    renderRegister(
      stubApi({
        listCorrespondence: vi
          .fn()
          .mockResolvedValue(answer([entry()], { awaitingExtensionResponses: 3 })),
      }),
    );
    await screen.findByText('3 extension requests awaiting response');
  });

  it('does not offer the write actions to a member who may not write', async () => {
    render(
      <Correspondence
        api={stubApi({
          listCorrespondence: vi.fn().mockResolvedValue(answer([entry()])),
        })}
        organisationId={ORG_ID}
        canModify={false}
        onWriteLetter={noop}
        onUploadInward={noop}
      />,
    );
    await screen.findByText('OUT/26-27/047');
    expect(screen.queryByRole('button', { name: /New letter/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Upload inward/ })).toBeNull();
  });
});

describe('writing an outward letter', () => {
  it('holds the dispatch until the letter has an addressee, a subject and a body', async () => {
    const writeOutwardLetter = vi
      .fn()
      .mockResolvedValue({ id: 'x', number: 'OUT/26-27/048' });
    render(
      <WriteOutwardLetter
        api={stubApi({
          listContacts: vi.fn().mockResolvedValue([
            {
              id: '11111111-1111-4111-8111-111111111111',
              designation: 'Sr. DSTE/MMCT',
              contactPerson: null,
              address: null,
              phone: null,
              email: null,
              gstin: null,
              pincode: null,
              stateCode: null,
              locality: null,
              divisionCode: null,
              isConsignee: false,
              isVendor: false,
              isClient: true,
              bankAccountName: null,
              bankAccountNumber: null,
              bankIfsc: null,
              bankAccountType: null,
              isEmployee: false,
              pan: null,
              active: true,
              createdAt: '2026-08-01T09:00:00.000Z',
            },
          ]),
          writeOutwardLetter,
        })}
        organisationId={ORG_ID}
        onDone={noop}
        onCancel={noop}
      />,
    );

    const dispatch = await screen.findByRole('button', {
      name: /Finalize & dispatch letter/,
    });
    expect((dispatch as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('To'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Subject'), {
      target: { value: 'Submission of approved makes' },
    });
    expect((dispatch as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Letter body'), {
      target: { value: 'The approved makes are enclosed.' },
    });
    expect((dispatch as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(dispatch);
    await waitFor(() => {
      expect(writeOutwardLetter).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({
          contactId: '11111111-1111-4111-8111-111111111111',
          subject: 'Submission of approved makes',
          body: 'The approved makes are enclosed.',
        }),
      );
    });
  });

  it('states the series instead of a number the counter has not handed out', async () => {
    render(
      <WriteOutwardLetter
        api={stubApi()}
        organisationId={ORG_ID}
        onDone={noop}
        onCancel={noop}
      />,
    );
    const field = await screen.findByLabelText('Letter number');
    expect((field as HTMLInputElement).value).toBe('OUT / financial year / serial');
    expect((field as HTMLInputElement).readOnly).toBe(true);
  });
});
