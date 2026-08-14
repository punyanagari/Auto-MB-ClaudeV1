// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@auto-mb/contracts';
import { OperationsDashboard } from '../../src/views/OperationsDashboard.js';
import { formatInr } from '../../src/format.js';
import { stubApi, ORG_ID, WORK_ID } from './helpers.js';

/*
 * The dashboard's bill signals, once the settlement register exists.
 *
 * The defect this file holds shut: a bill 97% settled and a bill nobody
 * has paid a rupee of used to reach the reader as the same line of text.
 * Both were "submitted and awaiting payment", both carried no figures,
 * and the one an operator had to phone about was indistinguishable from
 * the one already argued down to a retention balance.
 *
 * Anchored on the alert text rather than on the "Dashboard" heading: the
 * view's loading branch renders that heading too, so awaiting it resolves
 * against the skeleton and everything after it races the mocked promise
 * (the loading-anchor census in this directory states the rule).
 */

const PART_SETTLED_WORK = '33333333-3333-4333-8333-333333333333';

function dashboardPayload(): DashboardResponse {
  return {
    totals: {
      works: 2,
      contractValue: '300000.00',
      deliveredValue: '0.00',
      billedValue: '200000.00',
      executedPercent: '66.6666',
      openDrafts: 0,
      loaAwaitingReview: 0,
      irpReportingDue: 0,
      irpReportingOverdue: 0,
    },
    alerts: [
      {
        kind: 'bill_unpaid',
        severity: 'warning',
        message:
          "Bill 1 for DASH-PAY is submitted. Nothing has been received or deducted against the railway's bill.",
        workId: WORK_ID,
        workCode: 'DASH-PAY',
        dueInDays: null,
        settlement: {
          reference: '100000.00',
          received: '0.00',
          deducted: '0.00',
          outstanding: '100000.00',
        },
      },
      {
        kind: 'bill_part_settled',
        severity: 'warning',
        message:
          "Bill 2 for DASH-PAY is submitted and part settled against the railway's bill.",
        workId: PART_SETTLED_WORK,
        workCode: 'DASH-PAY',
        dueInDays: null,
        settlement: {
          reference: '100000.00',
          received: '95000.00',
          deducted: '2000.00',
          outstanding: '3000.00',
        },
      },
      {
        kind: 'bill_awaiting_closure',
        severity: 'notice',
        message:
          "Bill 1 for DASH-1 is prepared but not submitted. Its measurement is not closed, so nothing is outstanding against it yet — record the railway's On-Account Bill first.",
        workId: WORK_ID,
        workCode: 'DASH-1',
        dueInDays: null,
        settlement: {
          reference: null,
          received: '0.00',
          deducted: '0.00',
          outstanding: null,
        },
      },
    ],
    works: [],
  };
}

function renderDashboard() {
  const dashboard = vi.fn().mockResolvedValue(dashboardPayload());
  render(
    <OperationsDashboard
      api={stubApi({ dashboard })}
      organisationId={ORG_ID}
      canModify
      onOpenWork={vi.fn()}
      onOpenWorks={vi.fn()}
      onUploadLoa={vi.fn()}
      onOpenApprovals={vi.fn()}
    />,
  );
}

/** The alert list item carrying this text. */
function alertRow(text: string): HTMLElement {
  const paragraph = screen.getByText(text);
  const item = paragraph.closest('li');
  if (item === null) throw new Error(`No alert row for "${text}".`);
  return item;
}

describe('bill settlement on the dashboard', () => {
  it('states a part-settled bill differently from an untouched one', async () => {
    renderDashboard();
    const partSettled = await screen.findByText(/Bill 2 for DASH-PAY is submitted and/);
    const untouched = screen.getByText(/Bill 1 for DASH-PAY is submitted\./);

    // THE regression assertion: two bills against the same railway
    // figure, one 97% settled and one untouched, must not read alike.
    expect(partSettled.textContent).not.toBe(untouched.textContent);

    const partRow = alertRow(partSettled.textContent ?? '');
    const untouchedRow = alertRow(untouched.textContent ?? '');
    expect(
      within(partRow).getByText('Outstanding').nextElementSibling?.textContent,
    ).toBe(formatInr('3000.00'));
    expect(
      within(untouchedRow).getByText('Outstanding').nextElementSibling?.textContent,
    ).toBe(formatInr('100000.00'));
    // What the railway kept is reported beside what it paid, because the
    // two together are what "settled" means.
    expect(within(partRow).getByText('Deducted').nextElementSibling?.textContent).toBe(
      formatInr('2000.00'),
    );
  });

  it('renders every settlement figure in tabular mono', async () => {
    renderDashboard();
    const partSettled = await screen.findByText(/Bill 2 for DASH-PAY is submitted and/);
    const partRow = alertRow(partSettled.textContent ?? '');
    for (const label of ['Railway bill', 'Received', 'Deducted', 'Outstanding']) {
      const figure = within(partRow).getByText(label).nextElementSibling;
      // Money is mono and tabular everywhere in this product, so four
      // alerts stacked in the list read down their columns.
      expect(figure?.className).toContain('font-mono');
      expect(figure?.className).toContain('tabular-nums');
    }
  });

  it('shows no figures while the measurement is still open', async () => {
    renderDashboard();
    const awaiting = await screen.findByText(/Its measurement is not closed/);
    const row = alertRow(awaiting.textContent ?? '');
    // No reference figure exists, so there is no arithmetic to print. A
    // row of dashes beside two zeroes would say less than the sentence
    // already does — and would read as "nothing outstanding", which is
    // the opposite of what an unclosed measurement means.
    expect(within(row).queryByText('Outstanding')).toBeNull();
    expect(within(row).queryByText('Railway bill')).toBeNull();
  });
});
