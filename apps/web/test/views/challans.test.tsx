// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryChallanRegisterEntry, IssueChallan } from '@auto-mb/contracts';
import { formatDate } from '../../src/format.js';
import { Challans } from '../../src/views/Challans.js';
import { ORG_ID, WORK_ID, stubApi } from './helpers.js';

/* The two registers merged into one module with two tabs, and the tab
 * and the Work filter are both part of the address. What is worth
 * holding here is the wiring the merge introduced: which register a tab
 * shows, that the tab and the chip are real links, and that a Work with
 * an open draft cannot be given a second one. */

const WORK_CHALLAN_ID = '5a1c9a52-0000-4000-8000-00000000c001';
const ISSUE_CHALLAN_ID = '5a1c9a52-0000-4000-8000-00000000c002';

const DRAFT_FOR_WORK: DeliveryChallanRegisterEntry = {
  id: WORK_CHALLAN_ID,
  kind: 'work',
  movement: 'loa_supply',
  status: 'draft',
  challanDate: '2026-08-08',
  challanNumber: null,
  prefix: 'DC',
  workId: WORK_ID,
  workCode: 'RE-2026-01',
  consigneeName: 'Sr. DEE (G) NR',
  lineCount: 2,
  manualLineCount: 0,
  totalAmount: '1200.00',
  createdAt: '2026-08-08T04:00:00.000Z',
  issuedAt: null,
};

const ISSUED_ISSUE_CHALLAN: IssueChallan = {
  id: ISSUE_CHALLAN_ID,
  workId: WORK_ID,
  status: 'issued',
  movementType: 'issue',
  challanDate: '2026-08-10',
  challanNumber: 'IC/1',
  sequenceNumber: 1,
  prefix: 'IC',
  issuedToName: 'Site team B',
  issuedToRole: null,
  location: null,
  remarks: null,
  templateVersion: null,
  renderedAvailable: false,
  signedCopyAvailable: false,
  cancellationNote: null,
  createdAt: '2026-08-10T04:00:00.000Z',
  issuedAt: '2026-08-10T05:00:00.000Z',
  cancelledAt: null,
};

function renderChallans(props: Partial<Parameters<typeof Challans>[0]> = {}) {
  const onOpenRegister = vi.fn();
  const onNewWorkChallan = vi.fn();
  const api = stubApi({
    listDeliveryChallans: vi.fn().mockResolvedValue([DRAFT_FOR_WORK]),
    listContacts: vi.fn().mockResolvedValue([]),
    listIssueChallans: vi.fn().mockResolvedValue([ISSUED_ISSUE_CHALLAN]),
    listIssueChallanRegister: vi
      .fn()
      .mockResolvedValue([{ ...ISSUED_ISSUE_CHALLAN, workCode: 'RE-2026-01' }]),
  });
  render(
    <Challans
      api={api}
      organisationId={ORG_ID}
      canModify
      canIssue
      canCancel
      canManageStatutory
      tab="delivery"
      workId={null}
      workCode=""
      openChallanId={null}
      onOpenRegister={onOpenRegister}
      onOpenChallan={vi.fn()}
      onOpenWorkChallan={vi.fn()}
      onOpenIssueChallan={vi.fn()}
      onNewWorkChallan={onNewWorkChallan}
      onNewIssueChallan={vi.fn()}
      {...props}
    />,
  );
  return { api, onOpenRegister, onNewWorkChallan };
}

describe('the Challans module', () => {
  it('addresses each register as a real link and marks the open one', () => {
    const { onOpenRegister } = renderChallans();
    const delivery = screen.getByRole('link', { name: 'Delivery challans' });
    const issue = screen.getByRole('link', { name: 'Issue challans' });
    expect(delivery.getAttribute('href')).toBe('#/challans');
    expect(issue.getAttribute('href')).toBe('#/challans/installation');
    expect(delivery.getAttribute('aria-current')).toBe('page');
    expect(issue.getAttribute('aria-current')).toBeNull();

    fireEvent.click(issue);
    expect(onOpenRegister).toHaveBeenCalledWith('installation', null);
  });

  it('names the Work it is filtered to and clears back to the whole register', () => {
    const { onOpenRegister } = renderChallans({
      workId: WORK_ID,
      workCode: 'RE-2026-01',
    });
    expect(screen.getByText('RE-2026-01')).toBeDefined();
    // The tab rail keeps the filter when it switches registers…
    expect(
      screen.getByRole('link', { name: 'Issue challans' }).getAttribute('href'),
    ).toBe(`#/challans/installation/${WORK_ID}`);
    // …and the chip's own control is the only thing that drops it.
    const clear = screen.getByRole('link', { name: 'Clear the Work filter' });
    expect(clear.getAttribute('href')).toBe('#/challans');
    fireEvent.click(clear);
    expect(onOpenRegister).toHaveBeenCalledWith('delivery', null);
  });

  it('holds the New delivery challan action while the Work has an open draft', async () => {
    renderChallans({ workId: WORK_ID, workCode: 'RE-2026-01' });
    await waitFor(() => {
      expect(
        screen
          .getByRole('button', { name: 'New delivery challan' })
          .hasAttribute('disabled'),
      ).toBe(true);
    });
    // And says why, rather than leaving a dead control unexplained.
    expect(
      screen.getByText(/Only one delivery-challan draft is allowed per Work/),
    ).toBeDefined();
  });

  it('reads the issue tab across Works when none is named, and says which', async () => {
    const { api } = renderChallans({ tab: 'installation' });
    const row = await screen.findByRole('link', { name: 'IC/1' });
    expect(row.getAttribute('href')).toBe(
      `#/works/${WORK_ID}/issue-challans/${ISSUE_CHALLAN_ID}`,
    );
    // The organisation-wide register, not the per-Work list — and the
    // row names the Work it belongs to, which the narrowed mode leaves
    // to the module's chip.
    expect(api.listIssueChallanRegister).toHaveBeenCalledWith(ORG_ID);
    expect(api.listIssueChallans).not.toHaveBeenCalled();
    expect(screen.getByText('RE-2026-01')).toBeDefined();
  });

  it('lists the named Work’s issue challans', async () => {
    const { api } = renderChallans({
      tab: 'installation',
      workId: WORK_ID,
      workCode: 'RE-2026-01',
    });
    expect(api.listIssueChallanRegister).not.toHaveBeenCalled();
    const row = await screen.findByRole('link', { name: 'IC/1' });
    expect(row.getAttribute('href')).toBe(
      `#/works/${WORK_ID}/issue-challans/${ISSUE_CHALLAN_ID}`,
    );
    // Through the shared date helper, never a raw ISO string.
    expect(screen.getByText(formatDate('2026-08-10'))).toBeDefined();
  });
});
