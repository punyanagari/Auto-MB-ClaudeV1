import { useEffect, useState, type FormEvent } from 'react';
import type {
  IssueChallanLineInput,
  IssueChallanMovementType,
  SaveIssueChallanRequest,
  WorkBalanceResponse,
} from '@auto-mb/contracts';
import { existingRecordIdOf, RequestFailedError, type ApiClient } from '../api.js';

interface IssueChallanEditorProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** Null drafts a new Issue Challan; an id edits the existing draft. */
  readonly challanId: string | null;
  readonly onSaved: (challanId: string) => void;
  readonly onCancel: () => void;
}

interface ManualLine {
  description: string;
  unit: string;
  quantity: string;
}

interface EditorState {
  challanDate: string;
  movementType: IssueChallanMovementType;
  issuedToName: string;
  issuedToRole: string;
  location: string;
  remarks: string;
  quantities: Record<string, string>;
  manualLines: ManualLine[];
}

const EMPTY_MANUAL_LINE: ManualLine = { description: '', unit: '', quantity: '' };

export function IssueChallanEditor({
  api,
  organisationId,
  workId,
  challanId,
  onSaved,
  onCancel,
}: IssueChallanEditorProps) {
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
        : api.getIssueChallan(organisationId, challanId),
    ])
      .then(([loadedBalance, existing]) => {
        if (cancelled) return;
        setBalance(loadedBalance);
        const quantities: Record<string, string> = {};
        const manualLines: ManualLine[] = [];
        for (const line of existing?.lines ?? []) {
          if (line.workItemId !== null) {
            quantities[line.workItemId] = line.quantity;
          } else {
            manualLines.push({
              description: line.description,
              unit: line.unit,
              quantity: line.quantity,
            });
          }
        }
        setState({
          challanDate:
            existing?.issueChallan.challanDate ?? new Date().toISOString().slice(0, 10),
          movementType: existing?.issueChallan.movementType ?? 'issue',
          issuedToName: existing?.issueChallan.issuedToName ?? '',
          issuedToRole: existing?.issueChallan.issuedToRole ?? '',
          location: existing?.issueChallan.location ?? '',
          remarks: existing?.issueChallan.remarks ?? '',
          quantities,
          manualLines,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The Issue Challan editor could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, challanId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === null) return;
    const itemLines: IssueChallanLineInput[] = Object.entries(state.quantities)
      .filter(([, quantity]) => quantity.trim().length > 0)
      .map(([workItemId, quantity]) => ({ workItemId, quantity: quantity.trim() }));
    const manualLines: IssueChallanLineInput[] = state.manualLines
      .filter(
        (line) =>
          line.description.trim().length > 0 ||
          line.unit.trim().length > 0 ||
          line.quantity.trim().length > 0,
      )
      .map((line) => ({
        description: line.description.trim(),
        unit: line.unit.trim(),
        quantity: line.quantity.trim(),
      }));
    const lines = [...itemLines, ...manualLines];
    if (lines.length === 0) {
      setSaveError('Enter a quantity for at least one item or add a manual line.');
      return;
    }
    const body: SaveIssueChallanRequest = {
      challanDate: state.challanDate,
      movementType: state.movementType,
      issuedToName: state.issuedToName,
      ...(state.issuedToRole.trim().length > 0
        ? { issuedToRole: state.issuedToRole.trim() }
        : {}),
      ...(state.location.trim().length > 0 ? { location: state.location.trim() } : {}),
      ...(state.remarks.trim().length > 0 ? { remarks: state.remarks.trim() } : {}),
      lines,
    };
    setPending(true);
    setSaveError(null);
    try {
      const detail =
        challanId === null
          ? await api.createIssueChallan(organisationId, workId, body)
          : await api.updateIssueChallan(organisationId, challanId, body);
      onSaved(detail.issueChallan.id);
    } catch (cause) {
      // DRAFT_EXISTS conflicts answer with the open draft's id so the
      // editor routes straight to it instead of dead-ending on an error.
      const existingId = existingRecordIdOf(cause);
      if (existingId !== null) {
        onSaved(existingId);
        return;
      }
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
      <section className="card" aria-labelledby="issue-challan-editor-title">
        <h1 id="issue-challan-editor-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  if (balance === null || state === null) {
    return (
      <section className="card" aria-labelledby="issue-challan-editor-title">
        <h1 id="issue-challan-editor-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <p className="muted" role="status">
          Loading items…
        </p>
      </section>
    );
  }

  return (
    <section className="card card--wide" aria-labelledby="issue-challan-editor-title">
      <h1 id="issue-challan-editor-title" tabIndex={-1}>
        {challanId === null ? 'New Issue Challan' : 'Edit draft Issue Challan'}
      </h1>
      <p className="muted">
        Issue Challans record material issued out (to site, job work, loan, or return).
        Lines may reference awarded items or be entered manually, and quantities are not
        capped by the awarded quantity.
      </p>
      <form onSubmit={(event) => void save(event)}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="issue-challan-date">Challan date</label>
            <input
              id="issue-challan-date"
              type="date"
              value={state.challanDate}
              onChange={(event) => {
                setState({ ...state, challanDate: event.target.value });
              }}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="issue-challan-movement">Movement</label>
            <select
              id="issue-challan-movement"
              value={state.movementType}
              onChange={(event) => {
                setState({
                  ...state,
                  movementType: event.target.value as IssueChallanMovementType,
                });
              }}
            >
              <option value="issue">Issue</option>
              <option value="loan">Loan (returnable)</option>
              <option value="return">Return</option>
            </select>
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="issued-to-name">Issued to (name)</label>
            <input
              id="issued-to-name"
              value={state.issuedToName}
              onChange={(event) => {
                setState({ ...state, issuedToName: event.target.value });
              }}
              required
              minLength={2}
            />
          </div>
          <div className="field">
            <label htmlFor="issued-to-role">Role (optional)</label>
            <input
              id="issued-to-role"
              value={state.issuedToRole}
              onChange={(event) => {
                setState({ ...state, issuedToRole: event.target.value });
              }}
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="issue-challan-location">Location (optional)</label>
            <input
              id="issue-challan-location"
              value={state.location}
              onChange={(event) => {
                setState({ ...state, location: event.target.value });
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="issue-challan-remarks">Remarks (optional)</label>
            <input
              id="issue-challan-remarks"
              value={state.remarks}
              onChange={(event) => {
                setState({ ...state, remarks: event.target.value });
              }}
            />
          </div>
        </div>

        <h2>Awarded items</h2>
        <table className="data-table data-table--editable">
          <caption className="visually-hidden">
            Work items with awarded, delivered, and remaining quantities; enter a
            quantity to include an item on this Issue Challan
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Description</th>
              <th scope="col">Unit</th>
              <th scope="col">Awarded</th>
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
                <td>
                  <input
                    aria-label={`Quantity of ${item.itemNumber} on this Issue Challan`}
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

        <h2>Manual lines</h2>
        <p className="muted">
          Manual lines cover material outside the LOA (consumables, tools, loaned
          equipment).
        </p>
        {state.manualLines.map((line, index) => (
          <div className="field-row" key={index}>
            <div className="field">
              <label htmlFor={`manual-description-${String(index)}`}>
                Description for manual line {index + 1}
              </label>
              <input
                id={`manual-description-${String(index)}`}
                value={line.description}
                minLength={3}
                onChange={(event) => {
                  const manualLines = [...state.manualLines];
                  manualLines[index] = { ...line, description: event.target.value };
                  setState({ ...state, manualLines });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`manual-unit-${String(index)}`}>
                Unit for manual line {index + 1}
              </label>
              <input
                id={`manual-unit-${String(index)}`}
                value={line.unit}
                onChange={(event) => {
                  const manualLines = [...state.manualLines];
                  manualLines[index] = { ...line, unit: event.target.value };
                  setState({ ...state, manualLines });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`manual-quantity-${String(index)}`}>
                Quantity for manual line {index + 1}
              </label>
              <input
                id={`manual-quantity-${String(index)}`}
                inputMode="decimal"
                value={line.quantity}
                onChange={(event) => {
                  const manualLines = [...state.manualLines];
                  manualLines[index] = { ...line, quantity: event.target.value };
                  setState({ ...state, manualLines });
                }}
              />
            </div>
            <div className="field">
              <button
                type="button"
                className="button--ghost"
                onClick={() => {
                  setState({
                    ...state,
                    manualLines: state.manualLines.filter(
                      (_, candidate) => candidate !== index,
                    ),
                  });
                }}
              >
                Remove manual line {index + 1}
              </button>
            </div>
          </div>
        ))}
        <div className="actions">
          <button
            type="button"
            className="button--ghost"
            onClick={() => {
              setState({
                ...state,
                manualLines: [...state.manualLines, { ...EMPTY_MANUAL_LINE }],
              });
            }}
          >
            Add manual line
          </button>
        </div>

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
