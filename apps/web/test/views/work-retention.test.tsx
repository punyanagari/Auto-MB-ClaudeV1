// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LdAssessment, WorkRetentionResponse } from '@auto-mb/contracts';
import { WorkRetention } from '../../src/views/WorkRetention.js';
import { ORG_ID, WORK_ID, openForm, stubApi, submitButton } from './helpers.js';

/**
 * The panel that keeps money the railway is HOLDING apart from money it
 * has KEPT.
 *
 * Two claims are worth a test here and the rest is scaffolding. The first
 * is that the two liquidated-damages figures — what this organisation
 * assessed, and what the railway actually deducted — are both on screen
 * and are never combined into a third. The second is that no arithmetic
 * happens in the browser at all: every figure rendered is a string the
 * server sent, and the assertions below are written against the fixture's
 * own strings so that a helpful "improvement" that started summing
 * anything here would fail them.
 *
 * Every await resolves against something that exists only once the
 * position has arrived, never against the static heading — the discipline
 * `work-bill-settlement.test.tsx` states at length.
 */

const RELEASE_ID = '7d6e5f04-5162-4fce-9071-92031425364a';
const ASSESSMENT_ID = '8e7f6015-6273-4a0d-8182-031425364a5b';
const INSTRUMENT_ID = '9f807126-7384-4b1e-9293-1425364a5b6c';

function assessment(overrides: Partial<LdAssessment> = {}): LdAssessment {
  return {
    id: ASSESSMENT_ID,
    workId: WORK_ID,
    assessedOn: '2026-05-01',
    status: 'draft',
    basisAmount: '10000000.00',
    basisLabel: 'Contract value',
    scheduledCompletionDate: '2026-01-01',
    assessedToDate: '2026-04-15',
    ldRatePercent: '0.500',
    ldPeriodDays: 7,
    ldCapPercent: '10.000',
    delayDays: 104,
    chargeablePeriods: 15,
    uncappedAmount: '750000.00',
    capAmount: '1000000.00',
    assessedAmount: '750000.00',
    leviedAmount: null,
    levyReference: null,
    outcomeReason: null,
    notes: null,
    decidedAt: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function retention(
  overrides: Partial<WorkRetentionResponse> = {},
): WorkRetentionResponse {
  return {
    position: {
      workId: WORK_ID,
      contractValue: '10000000.00',
      retentionCeilingAmount: '500000.00',
      retentionHeldTotal: '150000.00',
      retentionReleasedTotal: '50000.00',
      retentionBalance: '100000.00',
      ldLeviedTotal: '750000.00',
      ldDeductedTotal: '400000.00',
      ldOpenAssessments: 1,
    },
    terms: {
      retentionPercent: '10.000',
      retentionLimitPercent: '5.000',
      defectLiabilityMonths: 24,
      ldRatePercent: '0.500',
      ldPeriodDays: 7,
      ldCapPercent: '10.000',
      sourceClause: 'GCC 17B',
      notes: null,
      updatedAt: '2026-05-01T10:00:00.000Z',
    },
    releases: [
      {
        id: RELEASE_ID,
        workId: WORK_ID,
        releasedOn: '2026-06-10',
        amount: '50000.00',
        basis: 'pac',
        workInstrumentId: null,
        workInstrumentReference: null,
        reference: 'REL/2026/1',
        description: null,
        remarks: null,
        voidedAt: null,
        voidReason: null,
        createdAt: '2026-06-10T10:00:00.000Z',
      },
    ],
    assessments: [assessment()],
    currentCompletionDate: '2026-01-01',
    instruments: [
      {
        id: INSTRUMENT_ID,
        kind: 'pbg',
        reference: 'BG/2026/9',
        amount: '100000.00',
      },
    ],
    ...overrides,
  };
}

function renderPanel(
  overrides: Partial<WorkRetentionResponse> = {},
  extra: Parameters<typeof stubApi>[0] = {},
) {
  const api = stubApi({
    getWorkRetention: vi.fn().mockResolvedValue(retention(overrides)),
    ...extra,
  });
  render(
    <WorkRetention
      api={api}
      organisationId={ORG_ID}
      workId={WORK_ID}
      canManageRetention
    />,
  );
  return api;
}

describe('the retention and damages panel', () => {
  it('states the ledger in the figures the server sent, and never a fourth', async () => {
    renderPanel();
    // Held, released and still held are three separate answers. A panel
    // that showed only the balance would say nothing about whether ₹1
    // lakh is what was never withheld or what has already come back.
    expect(await screen.findByText('₹1,50,000.00')).toBeTruthy();
    // Released appears twice — as the total and on the row it came from —
    // which is the point of the register sitting under the tiles.
    expect(screen.getAllByText('₹50,000.00').length).toBeGreaterThan(0);
    expect(screen.getByText('₹1,00,000.00')).toBeTruthy();
    expect(screen.getByText('₹5,00,000.00')).toBeTruthy();
  });

  it('shows what was levied beside what the railway deducted, without netting them', async () => {
    renderPanel();
    expect((await screen.findAllByText('₹7,50,000.00')).length).toBeGreaterThan(0);
    expect(screen.getByText('₹4,00,000.00')).toBeTruthy();
    // The difference between the two is a conversation with the railway,
    // not a balance. Nothing on this screen may state it as one.
    expect(screen.queryByText('₹3,50,000.00')).toBeNull();
  });

  it('says that the cap bit, and what it bit from', async () => {
    renderPanel({
      assessments: [
        assessment({ uncappedAmount: '3800000.00', assessedAmount: '1000000.00' }),
      ],
      position: {
        ...retention().position,
        ldLeviedTotal: '0.00',
      },
    });
    // Two numbers that do not multiply out are a screen an operator
    // cannot check. The cap is stated, with the figure it reduced — and
    // with what it is a percentage OF, which the owner ruling of
    // 2026-08-19 made the whole contract value rather than the basis the
    // line above it names.
    expect(
      await screen.findByText(
        /capped at 10.000% of contract value, from ₹38,00,000.00/,
      ),
    ).toBeTruthy();
  });

  it('needs a reason before a release can be withdrawn', async () => {
    const api = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const confirm = screen.getByRole('button', { name: 'Withdraw release' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(api.voidRetentionRelease).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Why it is being withdrawn'), {
      target: { value: 'Keyed against the wrong Work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw release' }));
    await waitFor(() => {
      expect(api.voidRetentionRelease).toHaveBeenCalledWith(
        ORG_ID,
        RELEASE_ID,
        'Keyed against the wrong Work',
      );
    });
  });

  it('sends the levy as the string it was typed as, and defaults it to the assessment', async () => {
    const api = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Levy' }));
    const amount = screen.getByLabelText('What the railway levied');
    // Defaulted to the assessment: what the railway takes when it does
    // not negotiate, and the ceiling either way.
    expect((amount as HTMLInputElement).value).toBe('750000.00');
    fireEvent.change(amount, { target: { value: '500000.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record levy' }));
    await waitFor(() => {
      expect(api.decideLdAssessment).toHaveBeenCalledWith(ORG_ID, ASSESSMENT_ID, {
        decision: 'levy',
        leviedAmount: '500000.00',
      });
    });
  });

  it('refuses to send a levy that is not a rupee figure', async () => {
    const api = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Levy' }));
    // A third decimal place, not a lakh separator: the field is a
    // `NumericInput` now, so the separator can no longer be typed at all
    // and the shape left for the client check to refuse is a rupee figure
    // with too fine a scale.
    fireEvent.change(screen.getByLabelText('What the railway levied'), {
      target: { value: '500000.005' },
    });
    const confirm = screen.getByRole('button', { name: 'Record levy' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(api.decideLdAssessment).not.toHaveBeenCalled();
    expect(screen.getByText(/at most two decimal places/)).toBeTruthy();
  });

  it('sends only the terms that were typed, so one recorded in error can be cleared', async () => {
    const api = renderPanel({ terms: null });
    // The panel opens its terms form for a Work that has none, so there
    // is no disclosure to click first — a Work with no terms is a Work
    // that cannot be assessed, and burying that behind a click would hide
    // the one thing the operator has to do.
    fireEvent.change(await screen.findByLabelText('Retention per bill (%)'), {
      target: { value: '10' },
    });
    fireEvent.click(submitButton('Save terms'));
    await waitFor(() => {
      // A patch shape would have carried the untouched fields forward and
      // made an over-read letter uncorrectable.
      expect(api.saveWorkRetentionTerms).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        retentionPercent: '10',
      });
    });
  });

  it('asks for the guarantee only when the release is a substitution', async () => {
    const api = renderPanel();
    await openForm('Record a release');
    expect(screen.queryByLabelText('Guarantee')).toBeNull();
    fireEvent.change(screen.getByLabelText('Basis'), {
      target: { value: 'bank_guarantee_substitution' },
    });
    const guarantee = screen.getByLabelText('Guarantee');
    fireEvent.change(guarantee, { target: { value: INSTRUMENT_ID } });
    fireEvent.change(screen.getByLabelText('Released on'), {
      target: { value: '2026-06-20' },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '25000.00' },
    });
    fireEvent.click(submitButton('Record release'));
    await waitFor(() => {
      expect(api.recordRetentionRelease).toHaveBeenCalledWith(ORG_ID, WORK_ID, {
        releasedOn: '2026-06-20',
        amount: '25000.00',
        basis: 'bank_guarantee_substitution',
        workInstrumentId: INSTRUMENT_ID,
      });
    });
  });

  it('explains why an assessment cannot be made instead of offering a form that would fail', async () => {
    renderPanel({ terms: null, assessments: [] });
    expect(
      await screen.findByText(
        /Record the contract’s damages terms above before assessing/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Assess liquidated damages' }),
    ).toBeNull();
  });

  it('offers nothing to a member without the retention authority', async () => {
    const api = stubApi({
      getWorkRetention: vi.fn().mockResolvedValue(retention()),
    });
    render(
      <WorkRetention
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canManageRetention={false}
      />,
    );
    // The position is still readable: what the railway is holding is part
    // of the Work's own financial picture.
    expect(await screen.findByText('₹1,50,000.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record a release' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Levy' })).toBeNull();
  });
});
