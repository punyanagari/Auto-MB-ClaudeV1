// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChallanCarryForward,
  SaveChallanRequest,
  WorkBalanceResponse,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { ChallanEditor } from '../../src/views/ChallanEditor.js';
import { PacCertificates } from '../../src/views/PacCertificates.js';
import {
  stubApi,
  ORG_ID,
  WORK_ID,
  CHALLAN_ID,
  ITEM_A,
  BALANCE,
  challanDetail,
  challanWork,
  fillConsignee,
  PO_LINE_ID,
  purchaseOrder,
  purchaseOrderDetail,
} from './helpers.js';

describe('ChallanEditor', () => {
  it('reaches its own checks for fields the browser used to gate, and focuses the first in reading order', async () => {
    const createChallan = vi.fn().mockResolvedValue(challanDetail());
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createChallan,
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    expect(screen.getByLabelText<HTMLInputElement>('Challan date').value).toBe(
      BALANCE.today,
    );
    // Consignee name and address carry `required`, so before the form took
    // validation over the browser aborted the submit and save() never ran —
    // these two branches were unreachable in every browser and in jsdom.
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(createChallan).not.toHaveBeenCalled();
    const name = screen.getByLabelText('Consignee name');
    const address = screen.getByLabelText('Consignee address');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(address.getAttribute('aria-invalid')).toBe('true');
    const nameMessage = screen.getByText(/Enter the consignee/);
    expect(name.getAttribute('aria-describedby')).toBe(nameMessage.id);
    // Name precedes address on screen, so focus lands on name.
    expect(document.activeElement).toBe(name);
  });

  it('shows remaining balances and saves a draft with the entered quantities', async () => {
    const createChallan = vi.fn().mockResolvedValue(challanDetail());
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createChallan,
    });
    const onSaved = vi.fn();
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    expect(await screen.findByText('2.000')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G)' },
    });
    fireEvent.change(screen.getByLabelText('Consignee address'), {
      target: { value: 'Delhi Division' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(CHALLAN_ID);
    });
    const [, , body] = createChallan.mock.calls[0] as [
      string,
      string,
      SaveChallanRequest,
    ];
    expect(body.prefix).toBe('DCW-1');
    expect(body.items).toEqual([{ workItemId: ITEM_A, quantity: '2' }]);
  });

  it('refuses to save an empty challan', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G)' },
    });
    fireEvent.change(screen.getByLabelText('Consignee address'), {
      target: { value: 'Delhi Division' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('at least one item');
    expect(api.createChallan).not.toHaveBeenCalled();
  });

  it('routes to the existing draft on a DRAFT_EXISTS conflict', async () => {
    const existingId = 'cccc5555-5555-4555-8555-555555555555';
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createChallan: vi.fn().mockRejectedValue(
        new RequestFailedError(409, 'DRAFT_EXISTS', 'A draft already exists.', {
          existingRecordId: existingId,
        }),
      ),
    });
    const onSaved = vi.fn();
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G)' },
    });
    fireEvent.change(screen.getByLabelText('Consignee address'), {
      target: { value: 'Delhi Division' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(existingId);
    });
  });

  it('binds each rejected field to its own message and focuses the first', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createChallan: vi.fn().mockResolvedValue(challanDetail()),
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    fillConsignee();
    // Both are shapes the server rejects: a two-character phone and a
    // quantity that is not a decimal at all.
    fireEvent.change(screen.getByLabelText('Consignee phone (optional)'), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: 'two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(api.createChallan).not.toHaveBeenCalled();
    const phone = screen.getByLabelText('Consignee phone (optional)');
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    const phoneMessage = screen.getByText(/A phone number needs 3 to 30 characters/);
    expect(phone.getAttribute('aria-describedby')).toBe(phoneMessage.id);
    // Per-field messages stay silent; the summary carries the announcement.
    expect(phoneMessage.getAttribute('role')).toBeNull();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Correct the highlighted fields',
    );
    // The phone box is flagged first, so that is where a keyboard user lands.
    expect(document.activeElement).toBe(phone);

    fireEvent.change(phone, { target: { value: '011-23385678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const quantity = screen.getByLabelText('Quantity of A/1 on this challan');
    expect(quantity.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(quantity);

    fireEvent.change(quantity, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(api.createChallan).toHaveBeenCalled();
    });
    expect(screen.queryByText(/A phone number needs 3 to 30 characters/)).toBeNull();
  });

  it('flags an over-delivery on blur only, and still saves the draft', async () => {
    const createChallan = vi.fn().mockResolvedValue(challanDetail());
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      createChallan,
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    fillConsignee();
    const quantity = screen.getByLabelText('Quantity of A/1 on this challan');

    // Exactly the remaining balance is not an over-delivery: the comparison
    // is exact integer thousandths, so 2.000 against 2.000 is equal.
    fireEvent.change(quantity, { target: { value: '2.000' } });
    fireEvent.blur(quantity);
    expect(screen.queryByText(/over the/)).toBeNull();

    // A thousandth more is, but not while it is still being typed.
    fireEvent.change(quantity, { target: { value: '2.001' } });
    expect(screen.queryByText(/over the/)).toBeNull();
    fireEvent.blur(quantity);
    // This Work does not allow excess delivery, so going over is what
    // issue will refuse, and the mock says it in the refusing ink.
    const warning = screen.getByText(
      /Quantity exceeds the remaining deliverable quantity of 2\.000 Nos\./,
    );
    expect(quantity.getAttribute('aria-describedby')).toBe(warning.id);
    // Guidance, not a rejection: the row is not marked invalid, and the
    // draft below still saves.
    expect(quantity.getAttribute('aria-invalid')).toBe('false');

    // And the draft still saves — the server checks the balance at issue.
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(createChallan).toHaveBeenCalled();
    });
    const [, , body] = createChallan.mock.calls[0] as [
      string,
      string,
      SaveChallanRequest,
    ];
    expect(body.items).toEqual([{ workItemId: ITEM_A, quantity: '2.001' }]);
  });

  it('calls an over-delivery an excess, not a refusal, when the Work allows one', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue({ ...BALANCE, allowExcessDelivery: true }),
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    const quantity = screen.getByLabelText('Quantity of A/1 on this challan');
    fireEvent.change(quantity, { target: { value: '9' } });
    fireEvent.blur(quantity);
    // The excess toggle lifts the DELIVERY cap, so this is a caution and
    // never the refusal sentence its counterpart above carries.
    const badge = screen.getByText(/Excess over the 2\.000 remaining/);
    expect(quantity.getAttribute('aria-describedby')).toBe(badge.id);
    expect(screen.queryByText(/exceeds the remaining deliverable quantity/)).toBeNull();
    expect(quantity.getAttribute('aria-invalid')).toBe('false');
  });

  it('confirms before discarding an edited challan and leaves a pristine one alone', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    const onCancel = vi.fn();
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await screen.findByText('2.000');

    // Nothing typed yet: Cancel leaves without asking.
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '2' },
    });
    // Focused first, because that is the state a real click or Enter leaves
    // the trigger in and it is where the dialog must hand focus back.
    cancel.focus();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: 'Discard your changes?' });
    // The safe choice is the one focus lands on: Enter on an unread
    // confirmation must not be the destructive answer.
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Keep editing' }),
    );
    // And it is a real modal — Escape declines.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('button', { name: 'Discard and leave' })).toBeNull();
    expect(document.activeElement).toBe(cancel);
    expect(
      screen.getByLabelText<HTMLInputElement>('Quantity of A/1 on this challan').value,
    ).toBe('2');

    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('offers autofill hints and a dialling keypad on the consignee fields', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    expect(screen.getByLabelText('Consignee name').getAttribute('autocomplete')).toBe(
      'organization',
    );
    expect(
      screen.getByLabelText('Consignee address').getAttribute('autocomplete'),
    ).toBe('street-address');
    const phone = screen.getByLabelText('Consignee phone (optional)');
    expect(phone.getAttribute('autocomplete')).toBe('tel');
    // A site engineer on a tablet gets digits, not letters.
    expect(phone.getAttribute('type')).toBe('tel');
    expect(phone.getAttribute('inputmode')).toBe('tel');
  });

  it('states the prefix rule beside the field and in the browser message', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    const prefix = screen.getByLabelText<HTMLInputElement>('Number prefix');
    const hint = screen.getByText(/Start with a letter or digit/);
    expect(prefix.getAttribute('aria-describedby')).toContain(hint.id);
    expect(prefix.validationMessage).toBe('');

    // A leading separator is the common rejection; the browser's own words
    // for it would be "Please match the requested format".
    fireEvent.change(prefix, { target: { value: '-dc' } });
    expect(prefix.value).toBe('-DC');
    expect(prefix.validationMessage).toContain('Start with a letter or digit');

    fireEvent.change(prefix, { target: { value: 'dc/2026' } });
    expect(prefix.value).toBe('DC/2026');
    expect(prefix.validationMessage).toBe('');
  });
});

describe('ChallanEditor carries the previous challan forward', () => {
  /** The Work balance as the server serves it once the Work has an issued
   * challan. The carried values ride along with the balance the editor
   * already asks for, so opening a draft costs no second request — and
   * the policy deciding WHICH challan they came from lives in one place,
   * on the server, rather than being re-derived here. */
  const DELIVERY: ChallanCarryForward = {
    prefix: 'DCW-1/SUP',
    consigneeName: 'Sr. DEE (G) NR',
    consigneeAddress: 'Delhi Division, New Delhi',
    consigneePhone: '011-23385678',
    sourceChallanNumber: 'DCW-1/SUP/1',
  };
  const CARRIED: WorkBalanceResponse = {
    ...BALANCE,
    deliveryCarryForward: DELIVERY,
  };

  function renderNewDraft(api: ApiClient) {
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  }

  it('opens a second challan on the carried prefix and consignee, and on nothing else', async () => {
    const createChallan = vi.fn().mockResolvedValue(challanDetail());
    const listChallans = vi.fn();
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(CARRIED),
      listChallans,
      createChallan,
    });
    renderNewDraft(api);

    await screen.findByText('2.000');
    // The history is never read: the server answered the only question
    // the editor had about it, in the response it was already waiting on.
    expect(listChallans).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('Number prefix').value).toBe(
      'DCW-1/SUP',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G) NR',
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Consignee address').value).toBe(
      'Delhi Division, New Delhi',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Consignee phone (optional)').value,
    ).toBe('011-23385678');
    // The date is this organisation's today, never the previous movement's,
    // and last time's quantities are no proposal for this time's.
    expect(screen.getByLabelText<HTMLInputElement>('Challan date').value).toBe(
      BALANCE.today,
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Quantity of A/1 on this challan').value,
    ).toBe('');

    // And the carried values are what a save sends, beside this challan's
    // own quantity.
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(createChallan).toHaveBeenCalled();
    });
    const [, , body] = createChallan.mock.calls[0] as [
      string,
      string,
      SaveChallanRequest,
    ];
    expect(body.prefix).toBe('DCW-1/SUP');
    expect(body.consignee).toEqual({
      name: 'Sr. DEE (G) NR',
      address: 'Delhi Division, New Delhi',
      phone: '011-23385678',
    });
    expect(body.challanDate).toBe(BALANCE.today);
    expect(body.items).toEqual([{ workItemId: ITEM_A, quantity: '1' }]);
  });

  it('names the challan the consignee was carried from', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(CARRIED) });
    renderNewDraft(api);

    // A prefilled form that never says so reads as one the operator
    // already filled in — and the picker above still says "Manual entry".
    await screen.findByText('2.000');
    expect(
      screen.getByText(/Carried from DCW-1\/SUP\/1 — edit if this delivery differs\./),
    ).toBeTruthy();
  });

  it('leaves a box the source challan left empty empty', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue({
        ...CARRIED,
        deliveryCarryForward: { ...DELIVERY, consigneePhone: null },
      }),
    });
    renderNewDraft(api);

    await screen.findByText('2.000');
    expect(
      screen.getByLabelText<HTMLInputElement>('Consignee phone (optional)').value,
    ).toBe('');
  });

  it('opens the Work’s first challan on the plain defaults, and claims nothing', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue({
        ...BALANCE,
        deliveryCarryForward: null,
      }),
    });
    renderNewDraft(api);

    await screen.findByText('2.000');
    expect(screen.getByLabelText<HTMLInputElement>('Number prefix').value).toBe(
      'DCW-1',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe('');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Consignee address').value).toBe(
      '',
    );
    expect(screen.queryByText(/Carried from/)).toBeNull();
  });

  it('never reseeds an existing draft, whatever the balance carries', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(CARRIED),
      getChallan: vi.fn().mockResolvedValue(challanDetail()),
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={CHALLAN_ID}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText('2.000');
    // The draft is already whatever the operator saved, down to the empty
    // phone box, and it claims nothing about carrying.
    expect(screen.getByLabelText<HTMLInputElement>('Number prefix').value).toBe('DC');
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G)',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Consignee phone (optional)').value,
    ).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Challan date').value).toBe(
      '2026-08-08',
    );
    expect(screen.queryByText(/Carried from/)).toBeNull();
  });
});

describe('ChallanEditor keeps typed input across a late Work code', () => {
  /** On reload or deep-link the workspace mounts the editor with
   * workCode '' and substitutes the real code only after its own Work
   * request resolves. That substitution used to re-run the entire load
   * and overwrite the form with freshly loaded state, discarding
   * whatever the operator had typed in between. */
  function renderWithLateWorkCode(api: ApiClient, onCancel = vi.fn()) {
    return render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode=""
        challanId={null}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />,
    );
  }

  function rerenderWithWorkCode(
    rerender: ReturnType<typeof render>['rerender'],
    api: ApiClient,
    onCancel = vi.fn(),
  ) {
    rerender(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />,
    );
  }

  it('keeps what the operator typed and fills only the empty prefix', async () => {
    const workBalance = vi.fn().mockResolvedValue(BALANCE);
    const api = stubApi({ workBalance });
    const { rerender } = renderWithLateWorkCode(api);
    await screen.findByText('2.000');
    expect(screen.getByLabelText<HTMLInputElement>('Number prefix').value).toBe('');

    // The operator starts filling the form before the Work resolves.
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G)' },
    });
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '1.500' },
    });

    rerenderWithWorkCode(rerender, api);

    // The typed values survive, the prefix fills in, and the load ran once.
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G)',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Quantity of A/1 on this challan').value,
    ).toBe('1.500');
    expect(screen.getByLabelText<HTMLInputElement>('Number prefix').value).toBe(
      'DCW-1',
    );
    expect(workBalance).toHaveBeenCalledTimes(1);
  });

  it('leaves a prefix the operator already typed alone', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    const { rerender } = renderWithLateWorkCode(api);
    await screen.findByText('2.000');
    fireEvent.change(screen.getByLabelText('Number prefix'), {
      target: { value: 'DC/2026' },
    });

    rerenderWithWorkCode(rerender, api);

    expect(screen.getByLabelText<HTMLInputElement>('Number prefix').value).toBe(
      'DC/2026',
    );
  });

  it('does not count the filled-in prefix as an edit worth a discard prompt', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    const onCancel = vi.fn();
    const { rerender } = renderWithLateWorkCode(api, onCancel);
    await screen.findByText('2.000');

    rerenderWithWorkCode(rerender, api, onCancel);
    expect(screen.getByLabelText<HTMLInputElement>('Number prefix').value).toBe(
      'DCW-1',
    );

    // Nothing was typed, so Cancel leaves without asking.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ChallanEditor consignee picker', () => {
  it('prefills the snapshot fields from a chosen master and keeps them editable', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      listContacts: vi.fn().mockResolvedValue([
        {
          id: '44444444-4444-4444-8444-444444444444',
          designation: 'Sr. DEE (G) NR',
          address: 'Delhi Division, New Delhi',
          contactPerson: null,
          phone: '011-23385678',
          email: null,
          gstin: null,
          pincode: null,
          stateCode: null,
          isConsignee: true,
          isVendor: false,
          isClient: false,
          active: true,
          createdAt: '2026-08-08T00:00:00.000Z',
        },
      ]),
      listWorkConsignees: vi.fn().mockResolvedValue([]),
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText('2.000');
    fireEvent.change(screen.getByLabelText('Prefill consignee from contacts'), {
      target: { value: '44444444-4444-4444-8444-444444444444' },
    });

    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G) NR',
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Consignee address').value).toBe(
      'Delhi Division, New Delhi',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Consignee phone (optional)').value,
    ).toBe('011-23385678');

    // Manual entry stays possible after picking — the fields are the
    // challan's own snapshot, not a bound reference.
    fireEvent.change(screen.getByLabelText('Consignee name'), {
      target: { value: 'Sr. DEE (G) NR, Attn: TI' },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G) NR, Attn: TI',
    );
  });

  it("offers the Work's linked consignees first while keeping every consignee pickable", async () => {
    const linked = {
      id: '55555555-5555-4555-8555-555555555555',
      designation: 'SSE (Signal) GZB',
      address: 'Signal Workshop, Ghaziabad',
      contactPerson: null,
      phone: null,
      email: null,
      gstin: null,
      pincode: null,
      stateCode: null,
      isConsignee: true,
      isVendor: false,
      isClient: false,
      active: true,
      createdAt: '2026-08-08T00:00:00.000Z',
    };
    const other = {
      ...linked,
      id: '44444444-4444-4444-8444-444444444444',
      designation: 'Sr. DEE (G) NR',
      address: 'Delhi Division, New Delhi',
    };
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      listContacts: vi.fn().mockResolvedValue([other, linked]),
      listWorkConsignees: vi.fn().mockResolvedValue([linked]),
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText('2.000');
    const picker = screen.getByLabelText<HTMLSelectElement>(
      'Prefill consignee from contacts',
    );
    const groups = Array.from(picker.querySelectorAll('optgroup')).map(
      (group) => group.label,
    );
    // R16 preference: the linked group leads; the full list follows so
    // any active consignee stays selectable.
    expect(groups).toEqual(['Linked to this Work', 'All consignees']);
    const linkedGroup = picker.querySelector('optgroup');
    expect(linkedGroup?.querySelectorAll('option')).toHaveLength(1);
    expect(linkedGroup?.textContent).toContain('SSE (Signal) GZB');

    fireEvent.change(picker, { target: { value: other.id } });
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'Sr. DEE (G) NR',
    );
  });
});

describe('Retired consignees stop being offered', () => {
  const ACTIVE_LINK = {
    id: '55555555-5555-4555-8555-555555555555',
    designation: 'SSE (Signal) GZB',
    address: 'Signal Workshop, Ghaziabad',
    contactPerson: null,
    phone: null,
    email: null,
    gstin: null,
    pincode: null,
    stateCode: null,
    isConsignee: true,
    isVendor: false,
    isClient: false,
    active: true,
    createdAt: '2026-08-08T00:00:00.000Z',
  };
  const RETIRED_LINK = {
    ...ACTIVE_LINK,
    id: '44444444-4444-4444-8444-444444444443',
    designation: 'DEN (Abolished) NDLS',
    address: 'Old Divisional Office',
    active: false,
  };

  it('keeps a retired linked consignee out of the challan picker and the active one in it', async () => {
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      // The general list is already active-only server-side.
      listContacts: vi.fn().mockResolvedValue([ACTIVE_LINK]),
      listWorkConsignees: vi.fn().mockResolvedValue([RETIRED_LINK, ACTIVE_LINK]),
    });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByText('2.000');
    const picker = screen.getByLabelText<HTMLSelectElement>(
      'Prefill consignee from contacts',
    );
    expect(picker.textContent).not.toContain('DEN (Abolished) NDLS');
    expect(Array.from(picker.options).map((option) => option.value)).not.toContain(
      RETIRED_LINK.id,
    );

    // The linked group still leads with the consignee that is still valid,
    // and picking it still prefills the snapshot.
    const linkedGroup = picker.querySelector('optgroup');
    expect(linkedGroup?.label).toBe('Linked to this Work');
    expect(linkedGroup?.querySelectorAll('option')).toHaveLength(1);
    fireEvent.change(picker, { target: { value: ACTIVE_LINK.id } });
    expect(screen.getByLabelText<HTMLInputElement>('Consignee name').value).toBe(
      'SSE (Signal) GZB',
    );
  });

  it('keeps a retired linked consignee out of the PAC picker', async () => {
    const api = stubApi({
      listWorkPacCertificates: vi
        .fn()
        .mockResolvedValue({ certificates: [], itemSummaries: [] }),
      listContacts: vi.fn().mockResolvedValue([ACTIVE_LINK]),
      listWorkConsignees: vi.fn().mockResolvedValue([RETIRED_LINK, ACTIVE_LINK]),
    });
    render(
      <PacCertificates
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        schedules={challanWork().schedules}
      />,
    );

    const picker = await screen.findByLabelText<HTMLSelectElement>('Issuing consignee');
    expect(picker.textContent).not.toContain('DEN (Abolished) NDLS');
    expect(picker.textContent).toContain('SSE (Signal) GZB');
  });

  it('still shows the retired linkage on the Work, marked as no longer offered', async () => {
    const api = stubApi({
      listWorkConsignees: vi.fn().mockResolvedValue([RETIRED_LINK, ACTIVE_LINK]),
      listContacts: vi.fn().mockResolvedValue([ACTIVE_LINK]),
    });
    const { WorkConsignees } = await import('../../src/views/WorkConsignees.js');
    render(
      <WorkConsignees api={api} organisationId={ORG_ID} workId={WORK_ID} canModify />,
    );

    // The link row is a preference, not history: it stays, and stays
    // unlinkable, so reactivating the contact restores the offer.
    expect(await screen.findByText('DEN (Abolished) NDLS')).toBeTruthy();
    expect(screen.getByText('retired — not offered')).toBeTruthy();
    expect(
      screen.getByText(/no longer offered in the challan and PAC pickers/),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Unlink' })).toHaveLength(2);
  });
});

describe('ChallanEditor purchase-order receipt link', () => {
  it('offers the open PO lines for an item and sends purchaseOrderLineId', async () => {
    const createChallan = vi.fn().mockResolvedValue(challanDetail());
    const listWorkPurchaseOrders = vi.fn().mockResolvedValue([purchaseOrder()]);
    const api = stubApi({
      workBalance: vi.fn().mockResolvedValue(BALANCE),
      listWorkPurchaseOrders,
      getPurchaseOrder: vi.fn().mockResolvedValue(purchaseOrderDetail()),
      createChallan,
    });
    const onSaved = vi.fn();
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    // Only OPEN orders are asked for: issued, and still owed material.
    expect(listWorkPurchaseOrders).toHaveBeenCalledWith(ORG_ID, WORK_ID, 'open');

    fillConsignee();
    fireEvent.change(screen.getByLabelText('Quantity of A/1 on this challan'), {
      target: { value: '2' },
    });
    const select = await screen.findByLabelText<HTMLSelectElement>(
      'Purchase order line for A/1',
    );
    // The option names the order and what it is still owed.
    expect(select.textContent).toContain('DCW-1-PO-01 · 4.000 pending');
    fireEvent.change(select, { target: { value: PO_LINE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(CHALLAN_ID);
    });
    const [, , body] = createChallan.mock.calls[0] as [
      string,
      string,
      SaveChallanRequest,
    ];
    expect(body.items).toEqual([
      { workItemId: ITEM_A, quantity: '2', purchaseOrderLineId: PO_LINE_ID },
    ]);
  });

  it('changes nothing visually when the Work has no open purchase orders', async () => {
    const api = stubApi({ workBalance: vi.fn().mockResolvedValue(BALANCE) });
    render(
      <ChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workCode="DCW-1"
        challanId={null}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByText('2.000');
    expect(screen.queryByText('Against PO')).toBeNull();
    expect(screen.queryByLabelText('Purchase order line for A/1')).toBeNull();
  });
});
