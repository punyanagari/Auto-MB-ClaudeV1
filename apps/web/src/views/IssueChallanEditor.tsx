import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  IssueChallanLineInput,
  IssueChallanMovementType,
  SaveIssueChallanRequest,
  WorkBalanceResponse,
} from '@auto-mb/contracts';
import { existingRecordIdOf, RequestFailedError, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import {
  Field,
  FieldRow,
  Actions,
  ActionBar,
  FormError,
  FieldError,
} from '../ui/form.js';

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
      <Card aria-labelledby="issue-challan-editor-title">
        <h1 id="issue-challan-editor-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <FormError>{loadError}</FormError>
      </Card>
    );
  }

  if (balance === null || state === null) {
    return (
      <Card aria-labelledby="issue-challan-editor-title">
        <h1 id="issue-challan-editor-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <p className="text-muted-foreground" role="status">
          Loading items…
        </p>
      </Card>
    );
  }

  // Nothing typed here is stored anywhere until the draft is saved, so
  // Cancel asks before throwing an edited form away and leaves a pristine
  // one alone.
  const edited =
    loadedState !== null && comparableContent(state) !== comparableContent(loadedState);

  return (
    <Card className="w-full" aria-labelledby="issue-challan-editor-title">
      <h1 id="issue-challan-editor-title" tabIndex={-1}>
        {challanId === null ? 'New Issue Challan' : 'Edit draft Issue Challan'}
      </h1>
      <p className="text-muted-foreground">
        Issue Challans record material issued out (to site, job work, loan, or return).
        Lines may reference awarded items or be entered manually, and quantities are not
        capped by the awarded quantity.
      </p>
      {/* noValidate: save() owns every rule, so each failure can name its
          field, bind a message, and move focus. */}
      <form noValidate onSubmit={(event) => void save(event)}>
        <FieldRow>
          <Field>
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
          </Field>
          <Field>
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
          </Field>
        </FieldRow>
        <FieldRow>
          <Field>
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
          </Field>
          <Field>
            <label htmlFor="issued-to-role">Role (optional)</label>
            <input
              id="issued-to-role"
              value={state.issuedToRole}
              onChange={(event) => {
                setState({ ...state, issuedToRole: event.target.value });
              }}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field>
            <label htmlFor="issue-challan-location">Location (optional)</label>
            <input
              id="issue-challan-location"
              value={state.location}
              onChange={(event) => {
                setState({ ...state, location: event.target.value });
              }}
            />
          </Field>
          <Field>
            <label htmlFor="issue-challan-remarks">Remarks (optional)</label>
            <input
              id="issue-challan-remarks"
              value={state.remarks}
              onChange={(event) => {
                setState({ ...state, remarks: event.target.value });
              }}
            />
          </Field>
        </FieldRow>

        <h2>Awarded items</h2>
        <DataTable className="[&_input]:w-28">
          <caption className="sr-only">
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
                <td className={wrapCell}>{item.description}</td>
                <td>{item.unitCode}</td>
                <td className={numericCell}>{item.awardedQuantity}</td>
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
        </DataTable>

        <h2>Manual lines</h2>
        <p className="text-muted-foreground">
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
            <FieldRow key={line.key}>
              <Field>
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
                  <FieldError id={`${descriptionField}-error`}>
                    {fieldErrors[descriptionField]}
                  </FieldError>
                )}
              </Field>
              <Field>
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
                  <FieldError id={`${unitField}-error`}>
                    {fieldErrors[unitField]}
                  </FieldError>
                )}
              </Field>
              <Field>
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
                  <FieldError id={`${quantityField}-error`}>
                    {fieldErrors[quantityField]}
                  </FieldError>
                )}
              </Field>
              <Field>
                <Button
                  variant="outline"
                  onClick={() => {
                    removeManualLine(line.key);
                  }}
                >
                  Remove manual line {position}
                </Button>
              </Field>
            </FieldRow>
          );
        })}
        <Actions>
          <Button
            variant="outline"
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
          </Button>
        </Actions>

        {saveError !== null && <FormError>{saveError}</FormError>}

        <ActionBar className="flex-wrap">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save draft'}
          </Button>
          <Button
            variant="outline"
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
          </Button>
        </ActionBar>

        {confirmingDiscard && (
          <div className="my-3 rounded-lg border border-warning/40 bg-accent px-4 py-3">
            <h2>Discard your changes?</h2>
            <p>
              Nothing entered here has been saved yet. Leaving now throws away the
              quantities and manual lines you typed.
            </p>
            <Actions>
              <Button ref={discardRef} onClick={onCancel}>
                Discard and leave
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setConfirmingDiscard(false);
                }}
              >
                Keep editing
              </Button>
            </Actions>
          </div>
        )}
      </form>
    </Card>
  );
}
