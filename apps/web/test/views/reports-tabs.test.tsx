// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkAnalysisResponse } from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';
import type { MisTab } from '../../src/lib/workspace-routes.js';
import { Mis } from '../../src/views/Mis.js';
import { ORG_ID, stubApi, WORK_ID } from './helpers.js';

/*
 * The Reports screen after the restructure.
 *
 * Three things the old stacked page could not do, and one it did that it
 * must stop doing:
 *
 *   1. the four registers are TABS, and the tab is the address;
 *   2. the works-analysis reads happen on Run and not on arrival;
 *   3. a column the operator drops leaves the table AND the exported
 *      document, because a file carrying columns the screen never showed
 *      is a different document from the one being read;
 *   4. the month-end summary read is made only where it is shown.
 *
 * The moved registers keep their own coverage in `state-coverage-cases`:
 * loading, failure and empty for the summary behind Accounts and Payroll,
 * and one case per works-analysis load.
 */

const OTHER_WORK = '11111111-1111-4111-8111-111111111111';

function workAnalysis(): WorkAnalysisResponse {
  return {
    work: {
      id: WORK_ID,
      workCode: 'SIG-2026-11',
      title: 'Signalling at Alpha yard',
      status: 'active',
      contractValue: '1000000.00',
      allowExcessDelivery: false,
    },
    divisionCode: '100',
    divisionSource: 'consignee',
    divisionCandidates: [],
    baselineLocked: false,
    items: [
      {
        workItemId: OTHER_WORK,
        itemNumber: 'A/3',
        description: 'Point machine',
        unitCode: 'nos',
        rate: '1000.000000',
        sanctionedQuantity: '10.000',
        sanctionedValue: '10000.00',
        deliveredQuantity: '4.000',
        deliveredValue: '4000.00',
        installedQuantity: '2.000',
        installedValue: '2000.00',
        pendingSupplyQuantity: '6.000',
        pendingSupplyValue: '6000.00',
        pendingInstallQuantity: '8.000',
        pendingInstallValue: '8000.00',
        suppliedNotInstalledQuantity: '2.000',
        suppliedNotInstalledValue: '2000.00',
        installedAboveSanctionedQuantity: '0.000',
        baselineSuppliedQuantity: '0.000',
        baselineInstalledQuantity: '0.000',
        inspectionAgency: null,
        inspectionLotSize: null,
        gatesDispatch: false,
        inspectionCalledQuantity: '0.000',
        inspectionCertifiedQuantity: '0.000',
        pendingInspectionQuantity: null,
        pendingInspectionValue: null,
        billedValue: '0.00',
        unbilledExecutedValue: '2000.00',
        executedValue: '2000.00',
      },
    ],
    totals: {
      itemCount: 1,
      sanctionedValue: '10000.00',
      deliveredValue: '4000.00',
      installedValue: '2000.00',
      pendingSupplyValue: '6000.00',
      pendingInstallValue: '8000.00',
      suppliedNotInstalledValue: '2000.00',
      pendingInspectionValue: '0.00',
      billedValue: '0.00',
      unbilledExecutedValue: '2000.00',
      itemsWithoutMatrixRow: 0,
    },
    inspection: [],
    bills: [],
    payment: {
      billCount: 0,
      railwayTotal: '0.00',
      receivedTotal: '0.00',
      deductionTotal: '0.00',
      settledTotal: '0.00',
      outstandingTotal: '0.00',
      indeterminateBills: 0,
    },
  };
}

/** The screen at one tab, with the run its address carries. `onOpenTab`
 * and `onRunReport` are the workspace's navigations; the tests read what
 * they were asked to navigate to rather than driving a real router. */
function renderReports(
  api: ApiClient,
  {
    tab = 'analysis',
    report = null,
    selection = null,
  }: {
    tab?: MisTab;
    report?: 'work' | 'division' | 'mapped-item' | null;
    selection?: string | null;
  } = {},
) {
  const onOpenTab = vi.fn();
  const onRunReport = vi.fn();
  render(
    <Mis
      api={api}
      organisationId={ORG_ID}
      isOwner
      tab={tab}
      report={report}
      selection={selection}
      onOpenTab={onOpenTab}
      onRunReport={onRunReport}
      onOpenTallyCensus={vi.fn()}
      onOpenHistoricalInvoices={vi.fn()}
    />,
  );
  return { onOpenTab, onRunReport };
}

describe('Reports — the tabs', () => {
  it('opens on the report picker and reads no register for it', async () => {
    const api = stubApi({
      listWorks: vi
        .fn()
        .mockResolvedValue([
          { id: WORK_ID, workCode: 'SIG-2026-11', title: 'Signalling at Alpha yard' },
        ]),
    });
    renderReports(api);

    // The picker's own list is the only read: the report itself waits for
    // Run, and the month-end summary belongs to another tab entirely.
    await screen.findByRole('combobox', { name: 'Report type' });
    expect(api.misSummary).not.toHaveBeenCalled();
    expect(api.workAnalysis).not.toHaveBeenCalled();
    expect(api.divisionAnalysis).not.toHaveBeenCalled();
    expect(api.mappedItemAnalysis).not.toHaveBeenCalled();
    expect(api.itemGroupProposals).not.toHaveBeenCalled();
  });

  it('names each tab as its own address', async () => {
    const { onOpenTab } = renderReports(stubApi({}));

    const rail = await screen.findByRole('navigation', { name: 'Report sections' });
    const accounts = within(rail).getByRole('link', { name: 'Accounts' });
    expect(accounts.getAttribute('href')).toBe('#/reports/accounts');
    expect(
      within(rail).getByRole('link', { name: 'Work analysis' }).getAttribute('href'),
    ).toBe('#/reports');
    expect(within(rail).getByRole('link', { name: 'Tally' }).getAttribute('href')).toBe(
      '#/reports/tally',
    );

    fireEvent.click(accounts);
    expect(onOpenTab).toHaveBeenCalledWith('accounts');
  });

  it('reads the month-end summary on Accounts and Payroll only', async () => {
    const api = stubApi({});
    renderReports(api, { tab: 'accounts' });
    await waitFor(() => {
      expect(api.misSummary).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByRole('heading', { name: 'Output tax by month' }),
    ).toBeTruthy();
    // The register that moved to the other tab is not on this one.
    expect(screen.queryByRole('heading', { name: 'Payroll cost' })).toBeNull();
  });

  it('keeps the payroll absence rule on its own tab', async () => {
    // `payrollCost: null` is the server saying the membership lacks the
    // authority. ABSENT, never a table of zeroes.
    const api = stubApi({});
    renderReports(api, { tab: 'payroll' });

    expect(await screen.findByRole('heading', { name: 'Payroll cost' })).toBeTruthy();
    expect(screen.getByText(/does not carry the payroll authority/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Receivables ageing' })).toBeNull();
  });

  it('hosts the existing Tally surfaces rather than rebuilding them', async () => {
    renderReports(stubApi({}), { tab: 'tally' });

    const census = await screen.findByRole('link', { name: /Tally ledger census/ });
    expect(census.getAttribute('href')).toBe('#/tally-masters');
    expect(
      screen.getByRole('link', { name: /Tally voucher import/ }).getAttribute('href'),
    ).toBe('#/historical-invoices');
    // The owner's export stays where it was, on the tab that is about Tally.
    expect(screen.getByRole('button', { name: /Export Tally XML/ })).toBeTruthy();
  });
});

describe('Reports — running one report', () => {
  it('runs the chosen report by making it the address', async () => {
    const api = stubApi({
      listWorks: vi
        .fn()
        .mockResolvedValue([
          { id: WORK_ID, workCode: 'SIG-2026-11', title: 'Signalling at Alpha yard' },
        ]),
    });
    const { onRunReport } = renderReports(api);

    await screen.findByRole('option', { name: /SIG-2026-11/ });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));

    expect(onRunReport).toHaveBeenCalledWith('work', WORK_ID);
    // Still nothing read: the address is what runs a report, and this
    // component was never re-rendered with one.
    expect(api.workAnalysis).not.toHaveBeenCalled();
  });

  it('runs the portfolio reports with no selection', async () => {
    const { onRunReport } = renderReports(stubApi({}));

    fireEvent.change(await screen.findByRole('combobox', { name: 'Report type' }), {
      target: { value: 'mapped-item' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));

    expect(onRunReport).toHaveBeenCalledWith('mapped-item', null);
  });

  it('draws the report the address names, and the proposals under it', async () => {
    const api = stubApi({
      workAnalysis: vi.fn().mockResolvedValue(workAnalysis()),
    });
    renderReports(api, { report: 'work', selection: WORK_ID });

    // The description heads a row in both the quantity and the value
    // table, which is the point of the two tables.
    expect(await screen.findAllByText('Point machine')).toHaveLength(2);
    expect(api.workAnalysis).toHaveBeenCalledWith(ORG_ID, WORK_ID);
    // The grouping proposals belong to the item analysis, not to every
    // arrival at Reports.
    expect(screen.queryByRole('heading', { name: 'Proposed item groups' })).toBeNull();
    expect(api.itemGroupProposals).not.toHaveBeenCalled();
  });
});

describe('Reports — the column chips', () => {
  it('drops a column from the table and from the exported document', async () => {
    const downloadWorksAnalysis = vi.fn().mockResolvedValue(new Blob(['x']));
    const api = stubApi({
      workAnalysis: vi.fn().mockResolvedValue(workAnalysis()),
      downloadWorksAnalysis,
    });
    renderReports(api, { report: 'work', selection: WORK_ID });

    const quantity = await screen.findByRole('table', { name: /Quantity position/ });
    expect(within(quantity).getByRole('columnheader', { name: 'Rate' })).toBeTruthy();

    // Rate is on by default; one tap takes it off both surfaces.
    fireEvent.click(screen.getByRole('button', { name: 'Rate', pressed: true }));
    await waitFor(() => {
      expect(within(quantity).queryByRole('columnheader', { name: 'Rate' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Export \.xlsx/ }));
    await waitFor(() => {
      expect(downloadWorksAnalysis).toHaveBeenCalled();
    });
    const options = downloadWorksAnalysis.mock.calls.at(-1)?.[3] as {
      columns: readonly string[];
    };
    expect(options.columns).not.toContain('Rate');
    // The columns that were not touched still travel.
    expect(options.columns).toContain('Pending to supply');
  });

  it('adds a column that starts off, on both surfaces', async () => {
    const downloadWorksAnalysis = vi.fn().mockResolvedValue(new Blob(['x']));
    const api = stubApi({
      workAnalysis: vi.fn().mockResolvedValue(workAnalysis()),
      downloadWorksAnalysis,
    });
    renderReports(api, { report: 'work', selection: WORK_ID });

    const value = await screen.findByRole('table', { name: /Value position/ });
    expect(within(value).queryByRole('columnheader', { name: 'Billed' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Billed', pressed: false }));
    await waitFor(() => {
      expect(within(value).getByRole('columnheader', { name: 'Billed' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /Export \.xlsx/ }));
    await waitFor(() => {
      expect(downloadWorksAnalysis).toHaveBeenCalled();
    });
    const options = downloadWorksAnalysis.mock.calls.at(-1)?.[3] as {
      columns: readonly string[];
    };
    expect(options.columns).toContain('Billed');
  });
});
