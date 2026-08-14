// @vitest-environment jsdom
/**
 * The payment setup offered once, right after a letter becomes a Work.
 *
 * Two halves, and both matter. The WIRING half drives the real shell:
 * the dialog exists because confirming a letter navigates to the new
 * Work, and "once" is a property of that navigation rather than of the
 * dialog — a revisit, a pasted link or a refresh must open the Work page
 * plainly. The DIALOG half drives the component: what it proposes, what
 * it leaves alone, what Save sends, and that Later sends nothing.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SavePaymentSetupRequest, WorkDetailResponse } from '@auto-mb/contracts';
import type { ApiClient } from '../../src/api.js';
import { OperationsWorkspace } from '../../src/views/OperationsWorkspace.js';
import { WorkPaymentSetup } from '../../src/views/WorkPaymentSetup.js';
import {
  stubApi,
  membership,
  DOC_ID,
  ORG_ID,
  WORK_ID,
  REVIEW_DOCUMENT,
} from './helpers.js';

const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
const SUPPLY_ITEM = '55555555-5555-4555-8555-555555555555';
const LAYING_ITEM = '66666666-6666-4666-8666-666666666666';
const SET_ITEM = '88888888-8888-4888-8888-888888888888';
const OPAQUE_ITEM = '99999999-9999-4999-8999-999999999999';

/** A freshly created Work: one plainly supply item, one laying-only item,
 * one the reviewer already categorised on the review screen, and one no
 * keyword reaches. */
function freshWork(): WorkDetailResponse {
  return {
    work: {
      id: WORK_ID,
      workCode: 'PL270-CRB',
      letterNumber: 'L-42/2025',
      letterDate: '2025-06-01',
      title: 'Supply and installation of switchboards',
      advertisedValue: '1000.00',
      contractValue: '900.00',
      pricingShape: 'per_schedule',
      letterPercentage: null,
      letterPercentageDirection: null,
      gstBasis: 'inclusive',
      gstRate: '18.00',
      pbgRequiredAmount: null,
      pbgSubmissionDays: null,
      pbgExtensionDays: null,
      pbgPenalInterestPercent: null,
      status: 'active',
      completedAt: null,
      completedByUserId: null,
      completionNote: null,
      createdAt: '2026-08-08T00:00:00.000Z',
    },
    schedules: [
      {
        id: SCHEDULE_ID,
        scheduleCode: 'A',
        title: 'Schedule A',
        position: 1,
        items: [
          {
            id: SUPPLY_ITEM,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/1',
            description: 'Supply of True colour MLDB',
            unitCode: 'Nos',
            awardedQuantity: '5.000',
            effectiveRate: '100.00',
            requiresSerials: false,
            paymentCategory: null,
          },
          {
            id: LAYING_ITEM,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/2',
            description: 'Laying of PVC/Coaxial cable along the platform',
            unitCode: 'Metre',
            awardedQuantity: '2000.000',
            effectiveRate: '12.83',
            requiresSerials: false,
            paymentCategory: null,
          },
          {
            id: SET_ITEM,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/3',
            description: 'Supply and laying of armoured optical fibre cable',
            unitCode: 'Metre',
            awardedQuantity: '500.000',
            effectiveRate: '40.00',
            requiresSerials: false,
            // The reviewer already decided this one during LOA review.
            paymentCategory: 'SPARE_SUPPLY',
          },
          {
            id: OPAQUE_ITEM,
            scheduleId: SCHEDULE_ID,
            itemNumber: 'A/4',
            description: 'Third party inspection by RDSO',
            unitCode: 'Nos',
            awardedQuantity: '1.000',
            effectiveRate: '5000.00',
            requiresSerials: false,
            paymentCategory: null,
          },
        ],
      },
    ],
  };
}

const organisation = { id: ORG_ID, name: 'Sharma Constructions', slug: 'sharma' };

function workspaceApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return stubApi({
    getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT),
    confirmLoa: vi.fn().mockResolvedValue({ work: { id: WORK_ID }, schedules: [] }),
    getWork: vi.fn().mockResolvedValue(freshWork()),
    getPaymentMatrix: vi.fn().mockResolvedValue([]),
    dashboard: vi.fn().mockResolvedValue({
      totals: {
        works: 0,
        contractValue: '0.00',
        deliveredValue: '0.00',
        billedValue: '0.00',
        openDrafts: 0,
        loaAwaitingReview: 0,
      },
      alerts: [],
      works: [],
    }),
    ...overrides,
  });
}

function renderWorkspaceAtReview(api: ApiClient) {
  window.history.replaceState(null, '', `#/loa/${DOC_ID}`);
  return render(
    <OperationsWorkspace
      api={api}
      me={{
        user: { id: 'user-a', email: 'owner@example.test' },
        memberships: [membership({})],
        twoFactorEnabled: true,
        mfaRequired: true,
        mfaEnforced: false,
      }}
      organisation={organisation}
      organisations={[organisation]}
      onSwitchOrganisation={vi.fn()}
      onOrganisationCreated={vi.fn()}
      onSignOut={vi.fn()}
    />,
  );
}

/** Confirms the fixture letter through the real review screen. */
async function confirmTheLetter(): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Work code (your reference)'), {
    target: { value: 'PL270-CRB' },
  });
  fireEvent.change(screen.getByLabelText('Unit for row 1 in schedule A'), {
    target: { value: 'ROUTE_KILOMETRE' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and create Work' }));
}

describe('the payment setup prompt after a Work is created', () => {
  it('opens once on the Work the confirmation created', async () => {
    renderWorkspaceAtReview(workspaceApi());
    await confirmTheLetter();

    // Awaited on the proposals rather than on the dialog: the dialog
    // exists while its matrix is still loading, and the item table it
    // is under does not.
    // Generous timeout: the chain under test is four asynchronous steps
    // long — confirm, navigate, load the Work, load its matrix — and a
    // loaded CI runner can spend more than the default second on it.
    expect(
      (await screen.findAllByText('proposed', undefined, { timeout: 5000 })).length,
    ).toBe(2);
    expect(
      screen.getByRole('dialog', { name: 'Set up payment for this Work' }),
    ).toBeTruthy();
  });

  it('does not reopen when the operator comes back to the same Work', async () => {
    renderWorkspaceAtReview(workspaceApi());
    await confirmTheLetter();
    await screen.findAllByText('proposed', undefined, { timeout: 5000 });
    const dialog = screen.getByRole('dialog', {
      name: 'Set up payment for this Work',
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Later' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Away and back by the address bar — the same move a refresh, a
    // bookmark or Back/Forward makes.
    window.location.hash = '#/works';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // Awaited on the Work's own heading LEAVING rather than on the
    // register's static one arriving: "Works" renders while that view is
    // still loading, so anchoring on it would race the fixture.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /PL270-CRB/ })).toBeNull();
    });
    window.location.hash = `#/works/${WORK_ID}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(
      await screen.findByRole('heading', {
        name: /PL270-CRB.*Supply and installation of switchboards/,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('WorkPaymentSetup', () => {
  function renderDialog(api: ApiClient, onSaved = vi.fn(), onClose = vi.fn()) {
    const rendered = render(
      <WorkPaymentSetup
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={freshWork().schedules.flatMap((schedule) => schedule.items)}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    return { ...rendered, onSaved, onClose };
  }

  function dialogApi(overrides: Partial<ApiClient> = {}): ApiClient {
    return stubApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([]),
      ...overrides,
    });
  }

  it('keeps the operator’s choices when the Work page re-renders under it', async () => {
    // The Work page recomputes its item list on every render and
    // re-renders whenever one of its supporting registers resolves, so
    // the dialog is handed a NEW array of the SAME items repeatedly. A
    // seeded copy of the categories would be re-seeded here and quietly
    // undo the choice; the override map has nothing to re-seed.
    const api = dialogApi();
    const props = {
      api,
      organisationId: ORG_ID,
      workId: WORK_ID,
      onClose: vi.fn(),
      onSaved: vi.fn(),
    };
    const { rerender } = render(
      <WorkPaymentSetup
        {...props}
        workItems={freshWork().schedules.flatMap((schedule) => schedule.items)}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Payment category for A/1'), {
      target: { value: 'SUPPLY_AND_INSTALLATION' },
    });
    rerender(
      <WorkPaymentSetup
        {...props}
        workItems={freshWork().schedules.flatMap((schedule) => schedule.items)}
      />,
    );

    expect(
      screen.getByLabelText<HTMLSelectElement>('Payment category for A/1').value,
    ).toBe('SUPPLY_AND_INSTALLATION');
    // And it is no longer marked as a proposal — the operator answered.
    const changedRow = screen
      .getAllByRole('row')
      .find((row) => within(row).queryByText('A/1') !== null);
    expect(within(changedRow as HTMLElement).queryByText('proposed')).toBeNull();
  });

  it('proposes only for items with no category, and never AMC or spare supply', async () => {
    renderDialog(dialogApi());

    const supply = await screen.findByLabelText<HTMLSelectElement>(
      'Payment category for A/1',
    );
    expect(supply.value).toBe('SUPPLY');
    expect(
      screen.getByLabelText<HTMLSelectElement>('Payment category for A/2').value,
    ).toBe('PURE_INSTALLATION');
    // Already decided by the reviewer: kept as it stands, and NOT
    // re-proposed as supply-and-installation from its description.
    expect(
      screen.getByLabelText<HTMLSelectElement>('Payment category for A/3').value,
    ).toBe('SPARE_SUPPLY');
    // No keyword reaches it, so nothing is guessed.
    expect(
      screen.getByLabelText<HTMLSelectElement>('Payment category for A/4').value,
    ).toBe('');

    const rows = screen.getAllByRole('row');
    const proposedRow = rows.find((row) => within(row).queryByText('A/1') !== null);
    expect(within(proposedRow as HTMLElement).getByText('proposed')).toBeTruthy();
    const decidedRow = rows.find((row) => within(row).queryByText('A/3') !== null);
    expect(within(decidedRow as HTMLElement).queryByText('proposed')).toBeNull();
  });

  it('pre-fills the percentages already saved against the Work', async () => {
    const api = dialogApi({
      getPaymentMatrix: vi.fn().mockResolvedValue([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workId: WORK_ID,
          category: 'SUPPLY',
          pctSupply: '80.00',
          pctInstallation: '0.00',
          pctPac: '10.00',
          pctFinalBill: '10.00',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:00:00.000Z',
        },
      ]),
    });
    renderDialog(api);

    expect(
      (await screen.findByLabelText<HTMLInputElement>('Supply % for Supply')).value,
    ).toBe('80.00');
    expect(screen.getByLabelText<HTMLInputElement>('PAC % for Supply').value).toBe(
      '10.00',
    );
    // A category nobody has configured stays blank rather than zeroed.
    expect(
      screen.getByLabelText<HTMLInputElement>('Supply % for Spare supply').value,
    ).toBe('');
  });

  it('saves the typed rows and only the items whose category moved', async () => {
    const saveWorkPaymentSetup = vi
      .fn()
      .mockResolvedValue({ rows: [], items: [{ id: SUPPLY_ITEM }] });
    const api = dialogApi({ saveWorkPaymentSetup });
    const { onSaved } = renderDialog(api);

    fireEvent.change(await screen.findByLabelText('Supply % for Supply'), {
      target: { value: '80' },
    });
    fireEvent.change(screen.getByLabelText('Installation % for Supply'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText('PAC % for Supply'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('Final bill % for Supply'), {
      target: { value: '10' },
    });
    // The operator overrides one proposal and accepts the rest.
    fireEvent.change(screen.getByLabelText('Payment category for A/2'), {
      target: { value: 'SUPPLY_AND_INSTALLATION' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save payment setup' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledOnce();
    });

    const [, , body] = saveWorkPaymentSetup.mock.calls[0] as [
      string,
      string,
      SavePaymentSetupRequest,
    ];
    expect(body.matrixRows).toEqual([
      {
        category: 'SUPPLY',
        pctSupply: '80',
        pctInstallation: '0',
        pctPac: '10',
        pctFinalBill: '10',
      },
    ]);
    // A/3 was already SPARE_SUPPLY and nobody touched it, so it is not in
    // the request; A/4 stays uncategorised and is not in it either.
    expect(body.itemCategories).toEqual([
      { workItemId: SUPPLY_ITEM, paymentCategory: 'SUPPLY' },
      { workItemId: LAYING_ITEM, paymentCategory: 'SUPPLY_AND_INSTALLATION' },
    ]);
  });

  it('holds Save while a partly filled row cannot sum to 100', async () => {
    renderDialog(dialogApi());

    fireEvent.change(await screen.findByLabelText('Supply % for Supply'), {
      target: { value: '80' },
    });
    const save = screen.getByRole('button', { name: 'Save payment setup' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(
      'Installation % must be a number',
    );
  });

  it('writes nothing when the operator chooses Later', async () => {
    const saveWorkPaymentSetup = vi.fn();
    const api = dialogApi({ saveWorkPaymentSetup });
    const { onClose } = renderDialog(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(saveWorkPaymentSetup).not.toHaveBeenCalled();
  });

  it('keeps a refusal on screen with the entries intact', async () => {
    const { RequestFailedError } = await import('../../src/api.js');
    const api = dialogApi({
      saveWorkPaymentSetup: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(
            409,
            'ITEM_BILLED_IN_MB',
            'Item A/1 is already billed in Measurement Book MB/1.',
          ),
        ),
    });
    const { onSaved, onClose } = renderDialog(api);

    fireEvent.change(await screen.findByLabelText('Payment category for A/4'), {
      target: { value: 'SUPPLY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save payment setup' }));

    expect(
      await screen.findByText('Item A/1 is already billed in Measurement Book MB/1.'),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText<HTMLSelectElement>('Payment category for A/4').value,
    ).toBe('SUPPLY');
  });
});
