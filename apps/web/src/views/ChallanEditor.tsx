import { useEffect, useState, type FormEvent } from 'react';
import type { SaveChallanRequest, WorkBalanceResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';

interface ChallanEditorProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workCode: string;
  /** Null drafts a new challan; an id edits the existing draft. */
  readonly challanId: string | null;
  readonly onSaved: (challanId: string) => void;
  readonly onCancel: () => void;
}

interface EditorState {
  challanDate: string;
  prefix: string;
  name: string;
  address: string;
  phone: string;
  quantities: Record<string, string>;
}

export function ChallanEditor({
  api,
  organisationId,
  workId,
  workCode,
  challanId,
  onSaved,
  onCancel,
}: ChallanEditorProps) {
  const [balance, setBalance] = useState<WorkBalanceResponse | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    setState(null);
    setLoadError(null);
    Promise.all([
      api.workBalance(organisationId, workId),
      challanId === null
        ? Promise.resolve(null)
        : api.getChallan(organisationId, challanId),
    ])
      .then(([loadedBalance, existing]) => {
        if (cancelled) return;
        setBalance(loadedBalance);
        const quantities: Record<string, string> = {};
        for (const item of existing?.items ?? []) {
          quantities[item.workItemId] = item.quantity;
        }
        setState({
          challanDate:
            existing?.challan.challanDate ?? new Date().toISOString().slice(0, 10),
          prefix: existing?.challan.prefix ?? workCode,
          name: existing?.challan.consignee.name ?? '',
          address: existing?.challan.consignee.address ?? '',
          phone: existing?.challan.consignee.phone ?? '',
          quantities,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The challan editor could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, challanId, workCode]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === null) return;
    const items = Object.entries(state.quantities)
      .filter(([, quantity]) => quantity.trim().length > 0)
      .map(([workItemId, quantity]) => ({ workItemId, quantity: quantity.trim() }));
    if (items.length === 0) {
      setSaveError('Enter a quantity for at least one item.');
      return;
    }
    const body: SaveChallanRequest = {
      challanDate: state.challanDate,
      prefix: state.prefix,
      consignee: {
        name: state.name,
        address: state.address,
        ...(state.phone.trim().length > 0 ? { phone: state.phone.trim() } : {}),
      },
      items,
    };
    setPending(true);
    setSaveError(null);
    try {
      const detail =
        challanId === null
          ? await api.createChallan(organisationId, workId, body)
          : await api.updateChallan(organisationId, challanId, body);
      onSaved(detail.challan.id);
    } catch (cause) {
      setSaveError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The draft could not be saved.',
      );
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <section className="card" aria-labelledby="challan-editor-title">
        <h1 id="challan-editor-title" tabIndex={-1}>
          Delivery Challan
        </h1>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  if (balance === null || state === null) {
    return (
      <section className="card" aria-labelledby="challan-editor-title">
        <h1 id="challan-editor-title" tabIndex={-1}>
          Delivery Challan
        </h1>
        <p className="muted" role="status">
          Loading balances…
        </p>
      </section>
    );
  }

  return (
    <section className="card card--wide" aria-labelledby="challan-editor-title">
      <h1 id="challan-editor-title" tabIndex={-1}>
        {challanId === null ? 'New Delivery Challan' : 'Edit draft challan'}
      </h1>
      <p className="muted">
        Quantities are checked against each item's remaining balance when the challan is
        issued; drafts can be edited freely until then.
      </p>
      <form onSubmit={(event) => void save(event)}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="challan-date">Challan date</label>
            <input
              id="challan-date"
              type="date"
              value={state.challanDate}
              onChange={(event) => {
                setState({ ...state, challanDate: event.target.value });
              }}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="challan-prefix">Number prefix</label>
            <input
              id="challan-prefix"
              value={state.prefix}
              onChange={(event) => {
                setState({ ...state, prefix: event.target.value.toUpperCase() });
              }}
              required
              pattern="[A-Z0-9][A-Z0-9_/-]{0,24}"
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="consignee-name">Consignee name</label>
            <input
              id="consignee-name"
              value={state.name}
              onChange={(event) => {
                setState({ ...state, name: event.target.value });
              }}
              required
              minLength={2}
            />
          </div>
          <div className="field">
            <label htmlFor="consignee-phone">Consignee phone (optional)</label>
            <input
              id="consignee-phone"
              value={state.phone}
              onChange={(event) => {
                setState({ ...state, phone: event.target.value });
              }}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="consignee-address">Consignee address</label>
          <textarea
            id="consignee-address"
            value={state.address}
            onChange={(event) => {
              setState({ ...state, address: event.target.value });
            }}
            required
            minLength={3}
            rows={2}
          />
        </div>

        <h2>Items</h2>
        <table className="data-table data-table--editable">
          <caption className="visually-hidden">
            Work items with awarded, delivered, and remaining quantities; enter a
            quantity to include an item on this challan
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Description</th>
              <th scope="col">Unit</th>
              <th scope="col">Awarded</th>
              <th scope="col">Delivered</th>
              <th scope="col">Remaining</th>
              <th scope="col">This challan</th>
            </tr>
          </thead>
          <tbody>
            {balance.items.map((item) => (
              <tr key={item.workItemId}>
                <th scope="row">{item.itemNumber}</th>
                <td className="cell--wrap">{item.description}</td>
                <td>{item.unitCode}</td>
                <td className="cell--numeric">{item.awardedQuantity}</td>
                <td className="cell--numeric">{item.deliveredQuantity}</td>
                <td className="cell--numeric">{item.remainingQuantity}</td>
                <td>
                  <input
                    aria-label={`Quantity of ${item.itemNumber} on this challan`}
                    inputMode="decimal"
                    value={state.quantities[item.workItemId] ?? ''}
                    onChange={(event) => {
                      setState({
                        ...state,
                        quantities: {
                          ...state.quantities,
                          [item.workItemId]: event.target.value,
                        },
                      });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {saveError !== null && (
          <p className="form-error" role="alert">
            {saveError}
          </p>
        )}

        <div className="actions action-bar">
          <button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save draft'}
          </button>
          <button type="button" className="button--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
