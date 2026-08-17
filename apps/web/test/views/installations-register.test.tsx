// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationRegisterEntry } from '@auto-mb/contracts';
import { InstallationsRegister } from '../../src/views/InstallationsRegister.js';
import { ORG_ID, WORK_ID, challanWork, stubApi } from './helpers.js';

/* The register answers the question the per-Work list cannot: what went
 * in, where, and when — across Works. So the row has to carry its Work's
 * identity, and it has to open that Work at the tab the record lives on
 * rather than at the Work's Overview. */

const OTHER_WORK_ID = '5f1c9a52-0000-4000-8000-00000000c001';

const RECORDED: InstallationRegisterEntry = {
  id: '5f1c9a52-0000-4000-8000-00000000a001',
  workId: WORK_ID,
  workCode: 'DCW-1',
  workTitle: 'Supply of switchboards',
  workItemId: '5f1c9a52-0000-4000-8000-00000000b001',
  itemNumber: 'A/1',
  quantity: '2.500',
  installedOn: '2026-08-09',
  locationName: 'Nashik Road station',
  serialCount: 2,
  status: 'recorded',
};

const CANCELLED: InstallationRegisterEntry = {
  id: '5f1c9a52-0000-4000-8000-00000000a002',
  workId: OTHER_WORK_ID,
  workCode: 'DCW-2',
  workTitle: 'Point machine renewal',
  workItemId: '5f1c9a52-0000-4000-8000-00000000b002',
  itemNumber: 'B/3',
  quantity: '1.000',
  installedOn: '2026-08-07',
  locationName: 'Bhusawal yard',
  serialCount: 0,
  status: 'cancelled',
};

function page(
  installations: readonly InstallationRegisterEntry[],
  nextCursor: string | null = null,
) {
  return { installations, nextCursor };
}

function renderRegister(
  overrides: Parameters<typeof stubApi>[0] = {},
  workId: string | null = null,
) {
  const onOpenWork = vi.fn();
  const onOpenWorks = vi.fn();
  const onClearWorkFilter = vi.fn();
  const api = stubApi({
    listInstallations: vi.fn().mockResolvedValue(page([RECORDED, CANCELLED])),
    ...overrides,
  });
  render(
    <InstallationsRegister
      api={api}
      organisationId={ORG_ID}
      workId={workId}
      onOpenWork={onOpenWork}
      onOpenWorks={onOpenWorks}
      onClearWorkFilter={onClearWorkFilter}
    />,
  );
  return { api, onOpenWork, onOpenWorks, onClearWorkFilter };
}

describe('the installation register', () => {
  it('lists every record with its Work, quantity, location and serial count', async () => {
    renderRegister();

    const workLink = await screen.findByRole('link', { name: 'DCW-1' });
    expect(workLink.getAttribute('href')).toBe(`#/works/${WORK_ID}/installations`);
    expect(screen.getByText('Supply of switchboards')).toBeTruthy();
    expect(screen.getByText('A/1')).toBeTruthy();
    expect(screen.getByText('2.500')).toBeTruthy();
    expect(screen.getByText('09 Aug 2026')).toBeTruthy();
    expect(screen.getByText('Nashik Road station')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('keeps a cancelled record listed, with its status said out loud', async () => {
    renderRegister();

    expect(await screen.findByRole('link', { name: 'DCW-2' })).toBeTruthy();
    expect(screen.getByText('cancelled')).toBeTruthy();
    expect(screen.getByText('recorded')).toBeTruthy();
    // No serials attached: an em dash rather than a zero, which would read
    // as a count that was measured.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('opens the Work at its Installations tab', async () => {
    const { onOpenWork } = renderRegister();

    fireEvent.click(await screen.findByRole('link', { name: 'DCW-1' }));
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
  });

  it('offers the Works register when nothing has been installed yet', async () => {
    const { onOpenWorks } = renderRegister({
      listInstallations: vi.fn().mockResolvedValue(page([])),
    });

    expect(await screen.findByText(/No installations recorded yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Works' }));
    expect(onOpenWorks).toHaveBeenCalled();
  });

  it('asks for a page, and pages on with the cursor the server returned', async () => {
    const listInstallations = vi
      .fn()
      .mockResolvedValueOnce(page([RECORDED], CANCELLED.id))
      .mockResolvedValueOnce(page([CANCELLED]));
    renderRegister({ listInstallations });

    await screen.findByRole('link', { name: 'DCW-1' });
    // A bounded first read: the register is not a table dump.
    expect(listInstallations).toHaveBeenCalledWith(ORG_ID, { limit: 100 });

    fireEvent.click(screen.getByRole('button', { name: 'Load more installations' }));
    expect(await screen.findByRole('link', { name: 'DCW-2' })).toBeTruthy();
    expect(listInstallations).toHaveBeenLastCalledWith(ORG_ID, {
      limit: 100,
      cursor: CANCELLED.id,
    });
    // The page that exhausted the register retires the button.
    expect(
      screen.queryByRole('button', { name: 'Load more installations' }),
    ).toBeNull();
    // …and the first page is still on screen beneath the second.
    expect(screen.getByRole('link', { name: 'DCW-1' })).toBeTruthy();
  });

  it('narrows to a date window, and says so when the window is empty', async () => {
    const listInstallations = vi
      .fn()
      .mockResolvedValueOnce(page([RECORDED, CANCELLED]))
      .mockResolvedValueOnce(page([]));
    renderRegister({ listInstallations });

    await screen.findByRole('link', { name: 'DCW-1' });
    fireEvent.change(screen.getByLabelText('Installed on or after'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('Installed on or before'), {
      target: { value: '2026-08-02' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));

    // A filtered zero is not the same state as an empty register: it
    // offers the window back, not the Works list.
    expect(
      await screen.findByText(/No installations were recorded in these dates/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Works' })).toBeNull();
    expect(listInstallations).toHaveBeenLastCalledWith(ORG_ID, {
      limit: 100,
      installedFrom: '2026-08-01',
      installedTo: '2026-08-02',
    });
  });

  /* The mock's `?work=` deep link. The narrowed reading is a different
     read, not a filter over the paged register — see the note on the
     component. */
  describe('narrowed to one Work', () => {
    const RECORD = {
      id: '5f1c9a52-0000-4000-8000-00000000a003',
      workId: WORK_ID,
      workItemId: '5f1c9a52-0000-4000-8000-00000000b001',
      itemNumber: 'A/1',
      quantity: '2.500',
      installedOn: '2026-08-09',
      locationId: '5f1c9a52-0000-4000-8000-00000000d001',
      locationName: 'Nashik Road station',
      remarks: null,
      status: 'recorded' as const,
      cancellationNote: null,
      serials: [
        {
          serialId: '5f1c9a52-0000-4000-8000-00000000e001',
          serialNumber: 'SN-1',
          challanNumber: 'DC/1',
        },
      ],
      createdAt: '2026-08-09T00:00:00.000Z',
      cancelledAt: null,
      pendingVariation: false,
    };

    function renderNarrowed() {
      const listInstallations = vi.fn();
      const listWorkInstallations = vi.fn().mockResolvedValue({
        installations: [RECORD],
        itemSummaries: [],
        nextCursor: null,
      });
      return {
        listInstallations,
        listWorkInstallations,
        ...renderRegister(
          {
            listWorkInstallations,
            listInstallations,
            // The chip's label: a cold deep link has nothing else to
            // read the Work's code and title off.
            getWork: vi.fn().mockResolvedValue(challanWork()),
          },
          WORK_ID,
        ),
      };
    }

    it('reads the Work’s own records and names it in a dismissible chip', async () => {
      const { listInstallations, listWorkInstallations, onClearWorkFilter } =
        renderNarrowed();

      const clear = await screen.findByRole('button', {
        name: /Clear the DCW-1 filter/,
      });
      expect(listWorkInstallations).toHaveBeenCalledWith(ORG_ID, WORK_ID);
      // The cross-Work register is deliberately not read, and its date
      // window is not offered: both belong to the unnarrowed question.
      expect(listInstallations).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Installed on or after')).toBeNull();

      expect(screen.getByText('Nashik Road station')).toBeTruthy();
      // The serial COUNT, derived from the record's own serial list.
      expect(screen.getByText('1')).toBeTruthy();
      // The Work's title reads twice on purpose — once naming the filter,
      // once on the row's own link into the Work.
      expect(screen.getAllByText('Supply of switchboards')).toHaveLength(2);

      fireEvent.click(clear);
      expect(onClearWorkFilter).toHaveBeenCalled();
    });

    it('offers the whole register when the Work has no records', async () => {
      const { onClearWorkFilter } = renderRegister(
        {
          getWork: vi.fn().mockResolvedValue(challanWork()),
          listWorkInstallations: vi.fn().mockResolvedValue({
            installations: [],
            itemSummaries: [],
            nextCursor: null,
          }),
        },
        WORK_ID,
      );

      const out = await screen.findByRole('button', {
        name: 'Read the whole register',
      });
      expect(
        screen.getByText(/No installations have been recorded against this Work/),
      ).toBeTruthy();
      fireEvent.click(out);
      expect(onClearWorkFilter).toHaveBeenCalled();
    });
  });
});
