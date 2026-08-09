import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  /** Row identity, stable across edits and removals. Keying the rendered
   * rows by array index makes React reuse a removed row's DOM, so values,
   * focus, and labels slide into the wrong line — ReviewLoa keys its item
   * drafts the same way. Lines loaded from a draft reuse the stored line
   * id; lines added here take a per-editor sequence. */
  readonly key: string;
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

/** Quantities stay decimal strings the whole way to the server, which
 * stores numeric(18,3) and rejects anything not greater than zero. Both
 * tests read the string: once the shape is fixed, "greater than zero" is
 * exactly "carries a non-zero digit", so no quantity is ever parsed into a
 * float. The shape is spelled as two branches rather than an optional
 * fraction group to keep it free of nested quantifiers. */
const QUANTITY_PATTERN = /^(?:0|[1-9]\d*)$|^(?:0|[1-9]\d*)\.\d{1,3}$/;
const NONZERO_DIGIT = /[1-9]/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function emptyManualLine(key: string): ManualLine {
  return { key, description: '', unit: '', quantity: '' };
}

/** What a save would send, flattened, so Cancel can tell an edited form
 * from a pristine one. An emptied box and stray whitespace are not edits
 * worth interrupting anyone over. */
function comparableContent(state: EditorState): string {
  return JSON.stringify({
    challanDate: state.challanDate,
    movementType: state.movementType,
    issuedToName: state.issuedToName.trim(),
    issuedToRole: state.issuedToRole.trim(),
    location: state.location.trim(),
    remarks: state.remarks.trim(),
    quantities: Object.entries(state.quantities)
      .filter(([, quantity]) => quantity.trim().length > 0)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([workItemId, quantity]) => [workItemId, quantity.trim()]),
    manualLines: state.manualLines
      // save() discards a line the operator never typed into, so an empty
      // row added and left alone is not an edit either.
      .map((line) => [line.description.trim(), line.unit.trim(), line.quantity.trim()])
      .filter((line) => line.some((value) => value.length > 0)),
  });
}

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
  /** The draft exactly as it loaded; Cancel compares against it. */
  const [loadedState, setLoadedState] = useState<EditorState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [pending, setPending] = useState(false);
  const manualSequence = useRef(0);
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const discardRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    setState(null);
    setLoadedState(null);
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
              key: line.id,
              description: line.description,
              unit: line.unit,
              quantity: line.quantity,
            });
          }
        }
        const loaded: EditorState = {
          challanDate:
            existing?.issueChallan.challanDate ?? new Date().toISOString().slice(0, 10),
          movementType: existing?.issueChallan.movementType ?? 'issue',
          issuedToName: existing?.issueChallan.issuedToName ?? '',
          issuedToRole: existing?.issueChallan.issuedToRole ?? '',
          location: existing?.issueChallan.location ?? '',
          remarks: existing?.issueChallan.remarks ?? '',
          quantities,
          manualLines,
        };
        setState(loaded);
        setLoadedState(loaded);
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

  // The confirmation takes over the decision the Cancel button was about to
  // make, so focus moves into it rather than leaving a keyboard user parked
  // on a button whose meaning just changed.
  useEffect(() => {
    if (!confirmingDiscard) {
      // Declining unmounts the button that held focus, so hand it back to
      // Cancel rather than dropping the operator at the top of the document.
      cancelRef.current?.focus();
      return;
    }
    discardRef.current?.focus();
  }, [confirmingDiscard]);

  function registerField(field: string, node: HTMLElement | null) {
    if (node === null) {
      fieldRefs.current.delete(field);
      return;
    }
    fieldRefs.current.set(field, node);
  }

  /** Moves focus onto the control that has to change. The form-level
   * role="alert" announces what went wrong; it says nothing about where a
   * keyboard user has to go to fix it. */
  function focusField(field: string) {
    fieldRefs.current.get(field)?.focus();
  }

  function updateManualLine(key: string, patch: Partial<ManualLine>) {
    setState((current) =>
      current === null
        ? null
        : {
            ...current,
            manualLines: current.manualLines.map((line) =>
              line.key === key ? { ...line, ...patch } : line,
            ),
          },
    );
  }

  function removeManualLine(key: string) {
    setState((current) =>
      current === null
        ? null
        : {
            ...current,
            manualLines: current.manualLines.filter((line) => line.key !== key),
          },
    );
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === null || balance === null) return;
    const itemLines: IssueChallanLineInput[] = Object.entries(state.quantities)
      .filter(([, quantity]) => quantity.trim().length > 0)
      .map(([workItemId, quantity]) => ({ workItemId, quantity: quantity.trim() }));
    const startedLines = state.manualLines.filter(
      (line) =>
        line.description.trim().length > 0 ||
        line.unit.trim().length > 0 ||
        line.quantity.trim().length > 0,
    );
    // A manual line the user has started must be complete before it leaves:
    // the server rejects a short description, a missing unit, and a quantity
    // that is not greater than zero, and a whole-form rejection never says
    // which box to correct.
    const nextFieldErrors: Record<string, string> = {};
    const invalidFields: string[] = [];
    function flag(field: string, message: string) {
      nextFieldErrors[field] = message;
      invalidFields.push(field);
    }
    // The date and the recipient were gated by native validation until this
    // form took the checks over; without them noValidate would let an empty
    // form reach the server.
    if (!DATE_ONLY_PATTERN.test(state.challanDate)) {
      flag('issue-challan-date', 'Enter the challan date.');
    }
    if (state.issuedToName.trim().length < 2) {
      flag(
        'issued-to-name',
        'Enter who the material goes to, in at least 2 characters.',
      );
    }
    for (const line of startedLines) {
      if (line.description.trim().length < 3) {
        flag(
          `manual-description-${line.key}`,
          'Describe the material in at least 3 characters.',
        );
      }
      if (line.unit.trim().length === 0) {
        flag(`manual-unit-${line.key}`, 'Enter the unit, for example Nos or Pkt.');
      }
      const quantity = line.quantity.trim();
      if (!QUANTITY_PATTERN.test(quantity) || !NONZERO_DIGIT.test(quantity)) {
        flag(
          `manual-quantity-${line.key}`,
          'Enter a quantity greater than zero, with up to three decimals.',
        );
      }
    }
    setFieldErrors(nextFieldErrors);
    // Fields are flagged in reading order, so the first one is the first
    // offender on screen.
    const firstInvalidField = invalidFields[0];
    if (firstInvalidField !== undefined) {
      setSaveError(
        'Every manual line needs a description of at least 3 characters, a unit, ' +
          'and a quantity greater than zero.',
      );
      focusField(firstInvalidField);
      return;
    }
    const manualLines: IssueChallanLineInput[] = startedLines.map((line) => ({
      description: line.description.trim(),
      unit: line.unit.trim(),
      quantity: line.quantity.trim(),
    }));
    const lines = [...itemLines, ...manualLines];
    if (lines.length === 0) {
      setSaveError('Enter a quantity for at least one item or add a manual line.');
      // No single box is wrong here, so focus goes to the first one that can
      // satisfy the rule.
      const firstItem = balance.items[0];
      focusField(
        firstItem === undefined
          ? 'add-manual-line'
          : `quantity-${firstItem.workItemId}`,
      );
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

  // Nothing typed here is stored anywhere until the draft is saved, so
  // Cancel asks before throwing an edited form away and leaves a pristine
  // one alone.
  const edited =
    loadedState !== null && comparableContent(state) !== comparableContent(loadedState);

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
      {/* noValidate: save() owns every rule, so each failure can name its
          field, bind a message, and move focus. */}
      <form noValidate onSubmit={(event) => void save(event)}>
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
                    ref={(node) => {
                      registerField(`quantity-${item.workItemId}`, node);
                    }}
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
        {state.manualLines.map((line, index) => {
          const descriptionField = `manual-description-${line.key}`;
          const unitField = `manual-unit-${line.key}`;
          const quantityField = `manual-quantity-${line.key}`;
          // The visible ordinal stays positional — it is how a person counts
          // the rows on screen — while React keys on the line's own identity.
          const position = index + 1;
          return (
            <div className="field-row" key={line.key}>
              <div className="field">
                <label htmlFor={descriptionField}>
                  Description for manual line {position}
                </label>
                <input
                  id={descriptionField}
                  ref={(node) => {
                    registerField(descriptionField, node);
                  }}
                  value={line.description}
                  minLength={3}
                  aria-invalid={fieldErrors[descriptionField] !== undefined}
                  aria-describedby={
                    fieldErrors[descriptionField] !== undefined
                      ? `${descriptionField}-error`
                      : undefined
                  }
                  onChange={(event) => {
                    updateManualLine(line.key, { description: event.target.value });
                  }}
                />
                {fieldErrors[descriptionField] !== undefined && (
                  <p className="form-error" id={`${descriptionField}-error`}>
                    {fieldErrors[descriptionField]}
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor={unitField}>Unit for manual line {position}</label>
                <input
                  id={unitField}
                  ref={(node) => {
                    registerField(unitField, node);
                  }}
                  value={line.unit}
                  aria-invalid={fieldErrors[unitField] !== undefined}
                  aria-describedby={
                    fieldErrors[unitField] !== undefined
                      ? `${unitField}-error`
                      : undefined
                  }
                  onChange={(event) => {
                    updateManualLine(line.key, { unit: event.target.value });
                  }}
                />
                {fieldErrors[unitField] !== undefined && (
                  <p className="form-error" id={`${unitField}-error`}>
                    {fieldErrors[unitField]}
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor={quantityField}>
                  Quantity for manual line {position}
                </label>
                <input
                  id={quantityField}
                  ref={(node) => {
                    registerField(quantityField, node);
                  }}
                  inputMode="decimal"
                  value={line.quantity}
                  aria-invalid={fieldErrors[quantityField] !== undefined}
                  aria-describedby={
                    fieldErrors[quantityField] !== undefined
                      ? `${quantityField}-error`
                      : undefined
                  }
                  onChange={(event) => {
                    updateManualLine(line.key, { quantity: event.target.value });
                  }}
                />
                {fieldErrors[quantityField] !== undefined && (
                  <p className="form-error" id={`${quantityField}-error`}>
                    {fieldErrors[quantityField]}
                  </p>
                )}
              </div>
              <div className="field">
                <button
                  type="button"
                  className="button--ghost"
                  onClick={() => {
                    removeManualLine(line.key);
                  }}
                >
                  Remove manual line {position}
                </button>
              </div>
            </div>
          );
        })}
        <div className="actions">
          <button
            type="button"
            className="button--ghost"
            ref={(node) => {
              registerField('add-manual-line', node);
            }}
            onClick={() => {
              manualSequence.current += 1;
              setState({
                ...state,
                manualLines: [
                  ...state.manualLines,
                  emptyManualLine(`new-${String(manualSequence.current)}`),
                ],
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
          <button
            type="button"
            className="button--ghost"
            ref={cancelRef}
            onClick={() => {
              if (edited) {
                setConfirmingDiscard(true);
                return;
              }
              onCancel();
            }}
          >
            Cancel
          </button>
        </div>

        {confirmingDiscard && (
          <div className="flag-panel">
            <h2>Discard your changes?</h2>
            <p>
              Nothing entered here has been saved yet. Leaving now throws away the
              quantities and manual lines you typed.
            </p>
            <div className="actions">
              <button type="button" ref={discardRef} onClick={onCancel}>
                Discard and leave
              </button>
              <button
                type="button"
                className="button--ghost"
                onClick={() => {
                  setConfirmingDiscard(false);
                }}
              >
                Keep editing
              </button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}
