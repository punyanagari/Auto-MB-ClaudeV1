// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Warranty, WorkWarrantyResponse } from '@auto-mb/contracts';
import { Warranties } from '../../src/views/Warranties.js';
import { WorkWarranty } from '../../src/views/WorkWarranty.js';
import { ORG_ID, WORK_ID, challanWork, stubApi } from './helpers.js';

/*
 * The two warranty surfaces.
 *
 * What is worth asserting here is the split of responsibility the pack
 * rests on: every date and every reading on screen is the SERVER's, and
 * the browser neither computes an expiry nor decides whether a period has
 * elapsed. So the tests feed a standing and a countdown that could not be
 * derived from the dates beside them, and check that what renders is what
 * was sent.
 */

const OTHER_WORK_ID = '7a1c9a52-0000-4000-8000-00000000c001';

function warranty(overrides: Partial<Warranty> = {}): Warranty {
  return {
    id: '7a1c9a52-0000-4000-8000-00000000a001',
    workId: WORK_ID,
    workCode: 'DCW-1',
    workTitle: 'Supply of switchboards',
    installationId: '7a1c9a52-0000-4000-8000-00000000b001',
    itemNumber: 'A/1',
    quantity: '2.500',
    installedOn: '2026-02-03',
    locationName: 'Nashik Road station',
    dlpMonths: 24,
    startBasis: 'installation',
    pacReference: null,
    dlpStartOn: '2026-02-03',
    originalExpiresOn: '2028-02-02',
    dlpExpiresOn: '2028-02-02',
    status: 'active',
    standing: 'active',
    daysToExpiry: 533,
    closedOn: null,
    closureNote: null,
    voidNote: null,
    createdAt: '2026-02-03T05:00:00.000Z',
    ...overrides,
  };
}

const ELAPSED = warranty({
  id: '7a1c9a52-0000-4000-8000-00000000a002',
  workId: OTHER_WORK_ID,
  workCode: 'DCW-2',
  workTitle: 'Point machine renewal',
  itemNumber: 'B/3',
  dlpExpiresOn: '2026-06-01',
  originalExpiresOn: '2026-06-01',
  standing: 'elapsed',
  daysToExpiry: -78,
});

function renderRegister(overrides: Parameters<typeof stubApi>[0] = {}) {
  const onOpenWork = vi.fn();
  const onOpenWorks = vi.fn();
  const onClearWorkFilter = vi.fn();
  const api = stubApi({
    listWarranties: vi
      .fn()
      .mockResolvedValue({ warranties: [ELAPSED, warranty()], nextCursor: null }),
    ...overrides,
  });
  render(
    <Warranties
      api={api}
      organisationId={ORG_ID}
      workId={null}
      onOpenWork={onOpenWork}
      onOpenWorks={onOpenWorks}
      onClearWorkFilter={onClearWorkFilter}
    />,
  );
  return { api, onOpenWork, onOpenWorks, onClearWorkFilter };
}

describe('the warranty register', () => {
  it('renders the standing and the countdown the server sent, not one it worked out', async () => {
    renderRegister();

    expect(await screen.findByRole('link', { name: 'DCW-2' })).toBeTruthy();
    // `elapsed` is a fact about the organisation's today, and nothing on
    // this screen recomputes it from the date in the next column.
    expect(screen.getByText('elapsed')).toBeTruthy();
    expect(screen.getByText('78 days over')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('533 days left')).toBeTruthy();
    // Legal dates print through formatDate, never through a locale call
    // on a fresh Date.
    expect(screen.getByText('02 Feb 2028')).toBeTruthy();
  });

  it("opens a row's Work at the tab the period is acted on", async () => {
    const { onOpenWork } = renderRegister();

    const link = await screen.findByRole('link', { name: 'DCW-1' });
    expect(link.getAttribute('href')).toBe(`#/works/${WORK_ID}/instruments`);
    fireEvent.click(link);
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
  });

  it('applies the standing and the horizon only when the operator submits', async () => {
    const listWarranties = vi
      .fn()
      .mockResolvedValue({ warranties: [warranty()], nextCursor: null });
    renderRegister({ listWarranties });

    await screen.findByRole('link', { name: 'DCW-1' });
    expect(listWarranties).toHaveBeenCalledWith(ORG_ID, { limit: 100 });

    fireEvent.change(screen.getByLabelText('Standing'), {
      target: { value: 'elapsed' },
    });
    fireEvent.change(screen.getByLabelText(/Runs out on or before/), {
      target: { value: '2026-12-31' },
    });
    // Still one read: a half-typed filter never fires a request.
    expect(listWarranties).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => {
      expect(listWarranties).toHaveBeenLastCalledWith(ORG_ID, {
        limit: 100,
        standing: 'elapsed',
        expiresBefore: '2026-12-31',
      });
    });
  });

  it('offers the Works register when nothing has been started yet', async () => {
    const { onOpenWorks } = renderRegister({
      listWarranties: vi.fn().mockResolvedValue({ warranties: [], nextCursor: null }),
    });

    expect(
      await screen.findByText(/No defect liability period has been started yet/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Works' }));
    expect(onOpenWorks).toHaveBeenCalled();
  });

  it('pages the narrowed reading through the Work endpoint rather than truncating it', async () => {
    const getWorkWarranty = vi
      .fn()
      .mockResolvedValueOnce(card({ warranties: [ELAPSED], nextCursor: ELAPSED.id }))
      .mockResolvedValueOnce(card({ warranties: [warranty()], nextCursor: null }));
    const api = stubApi({
      getWorkWarranty,
      getWork: vi.fn().mockResolvedValue(challanWork()),
    });
    render(
      <Warranties
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        onOpenWork={vi.fn()}
        onOpenWorks={vi.fn()}
        onClearWorkFilter={vi.fn()}
      />,
    );

    expect(await screen.findByRole('link', { name: 'DCW-2' })).toBeTruthy();
    expect(getWorkWarranty).toHaveBeenCalledWith(ORG_ID, WORK_ID, { limit: 100 });

    fireEvent.click(screen.getByRole('button', { name: 'Load more periods' }));
    expect(await screen.findByRole('link', { name: 'DCW-1' })).toBeTruthy();
    expect(getWorkWarranty).toHaveBeenLastCalledWith(ORG_ID, WORK_ID, {
      limit: 100,
      cursor: ELAPSED.id,
    });
    // The page that exhausted the Work retires the button, and the first
    // page is still on screen beneath the second.
    expect(screen.queryByRole('button', { name: 'Load more periods' })).toBeNull();
    expect(screen.getByRole('link', { name: 'DCW-2' })).toBeTruthy();
  });

  it('reads one Work through the Work endpoint, and names it with a clearable chip', async () => {
    const getWorkWarranty = vi.fn().mockResolvedValue(card());
    const onClearWorkFilter = vi.fn();
    const api = stubApi({
      getWorkWarranty,
      getWork: vi.fn().mockResolvedValue(challanWork()),
    });
    render(
      <Warranties
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        onOpenWork={vi.fn()}
        onOpenWorks={vi.fn()}
        onClearWorkFilter={onClearWorkFilter}
      />,
    );

    expect(await screen.findByText('Filtered to')).toBeTruthy();
    // The narrowed reading offers no filters: they exist to bound a
    // cross-Work list.
    expect(screen.queryByLabelText('Standing')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: /Clear the .* filter and read the whole register/,
      }),
    );
    expect(onClearWorkFilter).toHaveBeenCalled();
  });
});

function card(overrides: Partial<WorkWarrantyResponse> = {}): WorkWarrantyResponse {
  return {
    terms: {
      dlpMonths: 24,
      startBasis: 'installation',
      notes: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    pbgCover: {
      requiredByLetter: true,
      dlpCoverUntil: '2028-02-02',
      instrumentReference: 'BG/22',
      instrumentExpiresOn: '2027-12-19',
      shortfallDays: 45,
    },
    candidates: [],
    candidatesTruncated: false,
    warranties: [warranty()],
    nextCursor: null,
    ...overrides,
  };
}

function renderCard(overrides: Partial<WorkWarrantyResponse> = {}, canModify = true) {
  const getWorkWarranty = vi.fn().mockResolvedValue(card(overrides));
  const startInstallationWarranty = vi.fn().mockResolvedValue(warranty());
  const saveWarrantyTerms = vi.fn().mockResolvedValue({
    dlpMonths: 36,
    startBasis: 'installation',
    notes: null,
    updatedAt: '2026-08-18T00:00:00.000Z',
  });
  const api = stubApi({
    getWorkWarranty,
    startInstallationWarranty,
    saveWarrantyTerms,
  });
  render(
    <WorkWarranty
      api={api}
      organisationId={ORG_ID}
      workId={WORK_ID}
      canModify={canModify}
    />,
  );
  return { api, getWorkWarranty, startInstallationWarranty, saveWarrantyTerms };
}

describe("the Work's defect liability card", () => {
  it('states the term and the guarantee shortfall as facts, not as arithmetic', async () => {
    renderCard();

    expect(
      await screen.findByText(/24 months from the installation date/),
    ).toBeTruthy();
    // Twice on purpose: the cover panel says how far the WORK is covered,
    // and the table says how far this one period runs.
    expect(screen.getAllByText('02 Feb 2028')).toHaveLength(2);
    expect(screen.getByText(/BG\/22 expires 19 Dec 2027/)).toBeTruthy();
    // The shortfall is a warning — a thing to do — never the destructive
    // family, which is reserved for cancelled, rejected and declined.
    expect(screen.getByText(/Short by 45 days/)).toBeTruthy();
  });

  it('says so plainly when the Work has no term, and offers no period to start', async () => {
    renderCard({ terms: null, candidates: [], warranties: [] });

    expect(
      await screen.findByText(/No defect liability term is recorded for this Work/),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Start a defect liability period/ }),
    ).toBeNull();
  });

  it('starts a period from a candidate, sending no certificate on the installation basis', async () => {
    const { startInstallationWarranty } = renderCard({
      warranties: [],
      candidates: [
        {
          installationId: '7a1c9a52-0000-4000-8000-00000000b009',
          itemNumber: 'A/9',
          quantity: '1.000',
          installedOn: '2026-08-01',
          locationName: 'Bhusawal yard',
          pacOptions: [],
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Start period' }));
    await waitFor(() => {
      expect(startInstallationWarranty).toHaveBeenCalledWith(
        ORG_ID,
        '7a1c9a52-0000-4000-8000-00000000b009',
        {},
      );
    });
  });

  it('will not start a PAC-based period with no certificate to start it from', async () => {
    renderCard({
      terms: {
        dlpMonths: 12,
        startBasis: 'pac',
        notes: null,
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      warranties: [],
      candidates: [
        {
          installationId: '7a1c9a52-0000-4000-8000-00000000b010',
          itemNumber: 'A/10',
          quantity: '1.000',
          installedOn: '2026-08-01',
          locationName: 'Bhusawal yard',
          pacOptions: [],
        },
      ],
    });

    expect(
      await screen.findByText(/No PAC certificate certifies this item yet/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start period' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('shows what an extended period began with beside what it now runs to', async () => {
    renderCard({
      warranties: [warranty({ dlpExpiresOn: '2028-05-02' })],
    });

    expect(await screen.findByText(/extended from 02 Feb 2028/)).toBeTruthy();
  });

  it('offers no acts at all to a member who may only read', async () => {
    renderCard({}, false);

    expect(await screen.findByText(/24 months from/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Extend after a defect/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Void the period/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revise the term/ })).toBeNull();
  });
});
