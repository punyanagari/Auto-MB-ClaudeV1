// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from '@auto-mb/contracts';
import { OperationsDashboard } from '../../src/views/OperationsDashboard.js';
import { formatDate, formatInr } from '../../src/format.js';
import { stubApi, ORG_ID, WORK_ID } from './helpers.js';

/*
 * The redesigned landing screen (owner decision 2026-08-22, `docs/UX.md`
 * § 38): four tiles about the ACTIVE portfolio, one line of lamps, and
 * four panels — completion dates, billed against received, supply and
 * installation, and the ninety-day strip.
 *
 * WHAT THIS FILE HOLDS SHUT. Three things, and each one is a way the
 * screen could go quietly wrong rather than visibly break:
 *
 *   1. The tiles are the ACTIVE portfolio, not the register. A completed
 *      Work's contract value must not reach them — that is the drift the
 *      redesign exists to stop, and it is invisible unless asserted.
 *   2. Nothing on the screen divides money. Every figure asserted here is
 *      the exact string the payload carried; a browser-side ratio would
 *      show up as a different number.
 *   3. Status is never colour alone. Every lamp is asserted through its
 *      accessible text, which is what a screen reader gets.
 *
 * The settlement-figure assertions this file replaces moved with the
 * alert list they belonged to: the presentation of received, deducted and
 * outstanding is guarded by `work-bill-settlement.test.tsx` on the Work's
 * own Bills tab, and the arithmetic behind them by
 * `apps/server/test/bill-payments.integration.test.ts`.
 *
 * Anchored on a panel heading rather than on "Dashboard": the view's
 * loading branch renders that heading too, so awaiting it resolves
 * against the skeleton and everything after it races the mocked promise
 * (the loading-anchor census in this directory states the rule).
 */

const SECOND_WORK = '22222222-2222-4222-8222-222222222222';

function dashboardPayload(): DashboardResponse {
  return {
    totals: {
      // The REGISTER's reading: two active Works and one completed one.
      works: 3,
      contractValue: '5000000.00',
      deliveredValue: '1000000.00',
      billedValue: '900000.00',
      executedPercent: '18.0000',
      openDrafts: 1,
      loaAwaitingReview: 0,
      irpReportingDue: 0,
      irpReportingOverdue: 0,
    },
    signals: {
      activeWorks: 2,
      // Deliberately NOT the register total above: the completed Work's
      // ₹20,00,000 is excluded, and this assertion is the whole point.
      activeContractValue: '3000000.00',
      activeBilledValue: '600000.00',
      /* The TAXABLE restatement, and deliberately a different pair from
       * the printed rupees above: this portfolio is GST-inclusive, so
       * every figure divides by 1.18. `activeExecutedPercent` is the
       * quotient of THESE two and of no other pair, which is what the
       * tile has to print beside it. */
      activeContractTaxableValue: '2542372.88',
      activeBilledTaxableValue: '508474.58',
      activeExecutedPercent: '20.0000',
      receivableOutstanding: '103000.00',
      receivableIndeterminate: 1,
      completionsOverdue: 2,
      completionsDue: 1,
      instrumentsExpired: 3,
      instrumentsExpiring: 2,
      unsignedDocuments: 3,
      assignedScopeOnly: false,
      // LATER than the first month drawn below, so the twelve-month view
      // has a leading run this application holds no evidence for.
      billingSince: '2026-08',
    },
    alerts: [
      {
        kind: 'instrument_expired',
        severity: 'danger',
        message: 'PBG BG/22 for DASH-1 expired on 2026-07-15.',
        workId: WORK_ID,
        workCode: 'DASH-1',
        dueInDays: -38,
        settlement: null,
      },
    ],
    works: [
      {
        workId: WORK_ID,
        workCode: 'DASH-1',
        title: 'Signalling gear, CR Bhusawal',
        status: 'active',
        contractValue: '2000000.00',
        deliveredValue: '1000000.00',
        billedValue: '600000.00',
        gstBasis: 'inclusive',
        gstRate: '18.00',
        executedPercent: '30.0000',
        issuedChallans: 3,
      },
    ],
    completions: [
      {
        workId: WORK_ID,
        workCode: 'DASH-1',
        title: 'Signalling gear, CR Bhusawal',
        dueOn: '2026-09-05',
        dueInDays: 14,
        executedPercent: '30.0000',
      },
      {
        workId: SECOND_WORK,
        workCode: 'DASH-2',
        title: 'Point machines, SCR Guntakal',
        dueOn: '2026-10-12',
        dueInDays: 51,
        executedPercent: '4.5000',
      },
    ],
    monthlyBilling: [
      { month: '2026-07', billed: '250000.00', received: '90000.00' },
      { month: '2026-08', billed: '350000.00', received: '120000.00' },
    ],
    execution: [
      {
        workId: WORK_ID,
        workCode: 'DASH-1',
        title: 'Signalling gear, CR Bhusawal',
        suppliedPercent: '50.0000',
        installedPercent: '12.5000',
        dueOn: '2026-09-05',
        dueInDays: 14,
      },
      {
        workId: SECOND_WORK,
        workCode: 'DASH-2',
        title: 'Point machines, SCR Guntakal',
        suppliedPercent: '10.0000',
        installedPercent: null,
        dueOn: '2026-10-12',
        dueInDays: 51,
      },
    ],
    deadlines: [
      {
        kind: 'instrument',
        workId: WORK_ID,
        workCode: 'DASH-1',
        label: 'PBG BG/22',
        dueOn: '2026-09-01',
        dueInDays: 10,
      },
      {
        kind: 'defect_liability',
        workId: SECOND_WORK,
        workCode: 'DASH-2',
        label: 'Defect liability',
        dueOn: '2026-11-01',
        dueInDays: 71,
      },
    ],
  };
}

function renderDashboard(payload: DashboardResponse = dashboardPayload()) {
  const onOpenWork = vi.fn();
  const onRequestExtension = vi.fn();
  const dashboard = vi.fn().mockResolvedValue(payload);
  render(
    <OperationsDashboard
      api={stubApi({ dashboard })}
      organisationId={ORG_ID}
      canModify
      onOpenWork={onOpenWork}
      onRequestExtension={onRequestExtension}
      onOpenHistoricalInvoices={vi.fn()}
      onOpenWorks={vi.fn()}
      onUploadLoa={vi.fn()}
    />,
  );
  return { onOpenWork, onRequestExtension };
}

describe('the dashboard leads with the active portfolio', () => {
  it('states the active contract value, not the register total', async () => {
    renderDashboard();
    const tiles = await screen.findByRole('region', { name: 'Active portfolio' });

    // ₹30,00,000 active — the completed Work's value is absent, which is
    // the reading the redesign exists to give.
    expect(within(tiles).getByText('₹30 L')).toBeTruthy();
    expect(within(tiles).queryByText('₹50 L')).toBeNull();
    expect(within(tiles).getByText('2')).toBeTruthy();
    expect(within(tiles).getByText('3 in the register')).toBeTruthy();

    // The percentage is the server's, printed as it arrived.
    expect(within(tiles).getByText('20.0%')).toBeTruthy();
  });

  /* THE THREE NUMBERS IN A SENTENCE SHARE A BASIS.
   *
   * The executed tile used to read "of which executed ₹6 L (20.0%)"
   * beside a headline of ₹30 L — printed rupees on each Work's own GST
   * basis, and a percentage computed on taxable value. 6 / 30 is 20% only
   * by coincidence of a single-basis fixture; on a mixed portfolio the
   * sentence stated a ratio true of neither figure in it. The rupees
   * printed with the ratio are now the taxable pair the ratio is actually
   * of, and the tile says which basis that is. */
  it('prints the executed ratio against the rupees it is the quotient of', async () => {
    renderDashboard();
    const tiles = await screen.findByRole('region', { name: 'Active portfolio' });

    expect(within(tiles).getByText('₹5.08 L of ₹25.42 L taxable')).toBeTruthy();
    // The printed-rupee pair is NOT in that sentence any more, and the
    // headline that still carries it names its own basis.
    expect(within(tiles).queryByText(/of which executed/)).toBeNull();
    expect(within(tiles).getByText('The letters’ own figures')).toBeTruthy();
  });

  /* A total that is not the organisation's says whose it is. */
  it('tells a scoped member that the tiles are their slice', async () => {
    const payload = dashboardPayload();
    expect(screen.queryByText(/Works you are assigned to/)).toBeNull();
    renderDashboard({
      ...payload,
      signals: { ...payload.signals, assignedScopeOnly: true },
    });
    expect(
      await screen.findByText(
        'Across the Works you are assigned to, not the whole organisation.',
      ),
    ).toBeTruthy();
  });

  it('reports outstanding money and the bills that have no figure yet', async () => {
    renderDashboard();
    const tiles = await screen.findByRole('region', { name: 'Active portfolio' });
    expect(within(tiles).getByText('₹1.03 L')).toBeTruthy();
    // Not folded into the sum at zero: an unclosed measurement has no
    // outstanding amount, and saying "nil" would state a figure nobody
    // knows.
    expect(within(tiles).getByText('1 bill awaits a railway figure')).toBeTruthy();
  });

  it('says what needs attention in words, never in colour alone', async () => {
    renderDashboard();
    const strip = await screen.findByRole('list', { name: 'Needs attention' });
    const texts = within(strip)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    /* PAST AND FUTURE ARE DIFFERENT SENTENCES. A Work already past its
     * date and one still approaching it were counted together and
     * reported with the milder reading; a guarantee that lapsed last
     * month was reported as "expires within 60 days", a countdown that
     * had already run out. Four lamps, and the order is worst first. */
    expect(texts).toEqual([
      '2 Works are at or past their completion dates',
      '1 Work reaches its completion date within 30 days',
      '3 guarantees or certificates have already expired',
      '2 guarantees or certificates expire within 60 days',
      '3 issued documents are waiting to be signed',
    ]);
    // The signing queue is a register of its own; the other two lamps
    // move the viewport to panels already on this screen.
    expect(
      within(strip)
        .getByRole('link', { name: /waiting to be signed/ })
        .getAttribute('href'),
    ).toBe('#/signing');
  });

  it('is calm when nothing is due', async () => {
    const payload = dashboardPayload();
    renderDashboard({
      ...payload,
      signals: {
        ...payload.signals,
        completionsOverdue: 0,
        completionsDue: 0,
        instrumentsExpired: 0,
        instrumentsExpiring: 0,
        unsignedDocuments: 0,
      },
    });
    expect(
      await screen.findByText(
        /Nothing needs attention: no completion date, guarantee or signature falls due soon\./,
      ),
    ).toBeTruthy();
  });
});

describe('the completion panel', () => {
  it('separates the thirty-day works from the sixty-day ones and offers the letter', async () => {
    const { onOpenWork, onRequestExtension } = renderDashboard();
    const heading = await screen.findByRole('heading', { name: 'Completion dates' });
    const panel = heading.closest('section');
    expect(panel).not.toBeNull();

    const rows = within(panel as HTMLElement).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Days remaining are the SERVER's count against the organisation's
    // own calendar day; the browser never subtracts two dates here.
    expect(within(rows[0] as HTMLElement).getByText('14 days left')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('51 days left')).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByText(
        `${formatDate('2026-09-05')} · 30.0% executed`,
      ),
    ).toBeTruthy();

    /* "Request extension" goes to the COMPOSER, not to the top of a long
     * Overview. It is a different destination from the work code beside
     * it, and it has to stay one: landing an operator above the fold of
     * the page holding the form is a suggestion, not an action. */
    fireEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', { name: 'Request extension' }),
    );
    expect(onRequestExtension).toHaveBeenCalledWith(WORK_ID);
    expect(onOpenWork).not.toHaveBeenCalled();
  });

  it('says so plainly when no completion date is near', async () => {
    const payload = dashboardPayload();
    renderDashboard({ ...payload, completions: [] });
    expect(
      await screen.findByText(
        'No active Work reaches its completion date in the next 60 days.',
      ),
    ).toBeTruthy();
  });
});

describe('the billed-against-received chart', () => {
  it('carries every figure in a table, not only in a fill', async () => {
    renderDashboard();
    const table = await screen.findByRole('table', {
      name: 'Value billed and payments received, by month',
    });
    const cells = within(table)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    // Exactly the strings the payload carried, rupee-formatted. The
    // lightest step of the chart ramp sits below 3:1 against the light
    // card, so the figures have to be readable somewhere that is not a
    // fill — this table is that relief and the screen-reader view at once.
    expect(cells).toEqual([
      formatInr('250000.00'),
      formatInr('90000.00'),
      formatInr('350000.00'),
      formatInr('120000.00'),
    ]);
  });

  /* A CUTOVER LOOKS EXACTLY LIKE A COLLAPSE.
   *
   * An organisation that adopted this product in July has ten empty bars
   * at the head of a trailing year, and an empty bar says "we billed
   * nothing" whether that is true or whether the evidence is in the
   * Historical invoices register. The month is the SERVER's, so the
   * sentence is data-driven rather than pinned to one organisation's
   * cutover date. */
  it('explains a leading run of empty months as a cutover, in the server`s own month', async () => {
    renderDashboard();
    const notice = await screen.findByText(/Billing in this application starts in/);
    expect(notice.textContent).toContain('Aug 2026');
    expect(notice.textContent).toContain('not because nothing was billed');
    expect(
      within(notice).getByRole('link', { name: 'Historical invoices register' }),
    ).toBeTruthy();
  });

  it('stays silent when the whole year is in the application', async () => {
    const payload = dashboardPayload();
    renderDashboard({
      ...payload,
      // At or before the first month drawn, so there is nothing to
      // explain and a qualifier would be noise.
      signals: { ...payload.signals, billingSince: '2026-07' },
      monthlyBilling: [
        { month: '2026-07', billed: '250000.00', received: '90000.00' },
        { month: '2026-08', billed: '350000.00', received: '120000.00' },
      ],
    });
    await screen.findByRole('heading', { name: 'Billed against received' });
    expect(screen.queryByText(/Billing in this application starts in/)).toBeNull();
  });
});

/* THE FORWARD-ONLY RAIL CANNOT DRAW A LAPSED GUARANTEE, so the panel that
 * holds it names them underneath instead. Without this the expired lamp
 * counted a thing the screen never showed. */
describe('instruments that have already expired', () => {
  it('names them under the ninety-day rail and links each to its Work', async () => {
    const { onOpenWork } = renderDashboard();
    const heading = await screen.findByRole('heading', { name: 'Next 90 days' });
    const panel = heading.closest('section') as HTMLElement;
    const lapsed = within(panel).getByRole('link', {
      name: 'PBG BG/22 for DASH-1 expired on 2026-07-15.',
    });
    // The Work's Instruments tab, which is where a lapsed guarantee is
    // renewed or released.
    expect(lapsed.getAttribute('href')).toBe(`#/works/${WORK_ID}/instruments`);
    fireEvent.click(lapsed);
    expect(onOpenWork).toHaveBeenCalledWith(WORK_ID);
  });

  it('says nothing at all when none has lapsed', async () => {
    const payload = dashboardPayload();
    renderDashboard({ ...payload, alerts: [] });
    await screen.findByRole('heading', { name: 'Next 90 days' });
    expect(screen.queryByText(/Already expired/)).toBeNull();
  });
});

describe('supply and installation', () => {
  it('prints both percentages as the server stated them and marks the urgent Work', async () => {
    renderDashboard();
    const heading = await screen.findByRole('heading', {
      name: 'Supply and installation',
    });
    const panel = heading.closest('section') as HTMLElement;
    expect(within(panel).getByText('50.0%')).toBeTruthy();
    expect(within(panel).getByText('12.5%')).toBeTruthy();
    // No installation measurable against a zero contract value is an
    // em-dash, never 0% — a percentage of nothing is not zero.
    expect(within(panel).getByText('10.0%')).toBeTruthy();
    expect(within(panel).getByText('—')).toBeTruthy();
    // Urgency is a word beside the lamp, so it survives without colour.
    expect(within(panel).getByText('14 days left')).toBeTruthy();
    expect(
      within(panel).getByLabelText(
        'DASH-1: supplied 50.0%, installed 12.5% of contract value',
      ),
    ).toBeTruthy();
  });
});

describe('the ninety-day strip', () => {
  it('names each lamp in text and links it to its Work', async () => {
    renderDashboard();
    const heading = await screen.findByRole('heading', { name: 'Next 90 days' });
    const panel = heading.closest('section') as HTMLElement;
    const lamps = within(panel).getAllByRole('link');
    expect(lamps[0]?.textContent).toContain('PBG BG/22 on DASH-1');
    expect(lamps[0]?.textContent).toContain(formatDate('2026-09-01'));
    expect(lamps[0]?.getAttribute('href')).toBe(`#/works/${WORK_ID}`);
    expect(lamps[1]?.textContent).toContain('Defect liability ends');
  });

  it('says so plainly when the quarter is clear', async () => {
    const payload = dashboardPayload();
    renderDashboard({ ...payload, deadlines: [] });
    expect(
      await screen.findByText('Nothing falls due in the next 90 days.'),
    ).toBeTruthy();
  });
});
