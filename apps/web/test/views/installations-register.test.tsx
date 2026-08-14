// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationRegisterEntry } from '@auto-mb/contracts';
import { InstallationsRegister } from '../../src/views/InstallationsRegister.js';
import { ORG_ID, WORK_ID, stubApi } from './helpers.js';

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

function renderRegister(overrides: Parameters<typeof stubApi>[0] = {}) {
  const onOpenWork = vi.fn();
  const onOpenWorks = vi.fn();
  const api = stubApi({
    listInstallations: vi.fn().mockResolvedValue([RECORDED, CANCELLED]),
    ...overrides,
  });
  render(
    <InstallationsRegister
      api={api}
      organisationId={ORG_ID}
      onOpenWork={onOpenWork}
      onOpenWorks={onOpenWorks}
    />,
  );
  return { api, onOpenWork, onOpenWorks };
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
      listInstallations: vi.fn().mockResolvedValue([]),
    });

    expect(await screen.findByText(/No installations recorded yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Works' }));
    expect(onOpenWorks).toHaveBeenCalled();
  });
});
