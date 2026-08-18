import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  IssueChallanLineInput,
  IssueChallanMovementType,
  SaveIssueChallanRequest,
  WorkBalanceResponse,
} from '@auto-mb/contracts';
import { existingRecordIdOf, type ApiClient } from '../api.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { Card } from '../ui/card.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import {
  Field,
  FieldRow,
  Actions,
  ActionBar,
  FormError,
  FieldError,
  Hint,
} from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';

interface IssueChallanEditorProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** Null drafts a new Issue Challan; an id edits the existing draft. */
  readonly challanId: string | null;
  readonly onSaved: (challanId: string) => void;
  readonly onCancel: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
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
  onDirtyChange,
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
  const [loadVersion, retry] = useReload();
  const manualSequence = useRef(0);
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const edited =
    state !== null &&
    loadedState !== null &&
    comparableContent(state) !== comparableContent(loadedState);

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
        // The standing choices the server read off this Work's last
        // ISSUED Issue Challan, and only those. It is null on the Work's
        // first Issue Challan, and null again whenever a draft is being
        // EDITED: the draft is already whatever the operator saved, down
        // to the boxes they deliberately left empty. The MOVEMENT is
        // never among them: it decides what the document does, and one
        // 'return' must not open every later Issue Challan as a return.
        // The date stays the organisation's today, the remarks are this
        // movement's own note, and what moved last time is no default
        // for what moves this time.
        const carried =
          existing === null ? (loadedBalance.issueCarryForward ?? null) : null;
        const loaded: EditorState = {
          challanDate: existing?.issueChallan.challanDate ?? loadedBalance.today,
          movementType: existing?.issueChallan.movementType ?? 'issue',
          issuedToName:
            existing?.issueChallan.issuedToName ?? carried?.issuedToName ?? '',
          issuedToRole:
            existing?.issueChallan.issuedToRole ?? carried?.issuedToRole ?? '',
          location: existing?.issueChallan.location ?? carried?.location ?? '',
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
          errorMessage(cause, 'The Issue Challan editor could not be loaded.'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, challanId, loadVersion]);

  useEffect(() => {
    onDirtyChange?.(edited);
  }, [edited, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

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
    const MANUAL_LINE_SUMMARY =
      'Every manual line needs a description of at least 3 characters, a unit, ' +
      'and a quantity greater than zero.';
    const nextFieldErrors: Record<string, string> = {};
    const invalidFields: string[] = [];
    /** The announced summaries, in the same order as invalidFields: the
     * first offender in reading order is the one focus lands on, so its
     * summary is the one the form announces. */
    const summaries: string[] = [];
    function flag(field: string, message: string, summary = MANUAL_LINE_SUMMARY) {
      nextFieldErrors[field] = message;
      invalidFields.push(field);
      summaries.push(summary);
    }
    // The date and the recipient were gated by native validation until this
    // form took the checks over; without them noValidate would let an empty
    // form reach the server.
    if (!DATE_ONLY_PATTERN.test(state.challanDate)) {
      flag(
        'issue-challan-date',
        'Enter the challan date.',
        'Enter a challan date before saving.',
      );
    }
    if (state.issuedToName.trim().length < 2) {
      flag(
        'issued-to-name',
        'Enter who the material goes to, in at least 2 characters.',
        'Enter who the material goes to before saving.',
      );
    }
    // A quantity typed against an awarded item answers to the same rule as
    // a manual line's: the server rejects "0", "-5" and "abc" either way,
    // and its whole-form 400 QUANTITY_INVALID never says which of thirty
    // boxes to correct. Only boxes the operator actually typed into are
    // checked — an empty box is a legitimate "this item is not on this
    // challan", not an error. The awarded quantity is deliberately NOT a
    // ceiling here: an Issue Challan may exceed it.
    for (const item of balance.items) {
      const quantity = (state.quantities[item.workItemId] ?? '').trim();
      if (quantity.length === 0) continue;
      if (!QUANTITY_PATTERN.test(quantity) || !NONZERO_DIGIT.test(quantity)) {
        flag(
          `quantity-${item.workItemId}`,
          'Enter a quantity greater than zero, with up to three decimals, or ' +
            'clear the box to leave this item off the challan.',
          `Item ${item.itemNumber} needs a quantity greater than zero, with up ` +
            'to three decimals — or an empty box to leave it off this challan.',
        );
      }
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
      setSaveError(summaries[0] ?? MANUAL_LINE_SUMMARY);
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
      setSaveError(errorMessage(cause, 'The draft could not be saved.'));
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <Card aria-labelledby="issue-challan-editor-title">
        <h1 id="issue-challan-editor-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <ErrorState onRetry={retry} retryLabel="Retry items">
          {loadError}
        </ErrorState>
      </Card>
    );
  }

  if (balance === null || state === null) {
    return (
      <Card aria-labelledby="issue-challan-editor-title">
        <h1 id="issue-challan-editor-title" tabIndex={-1}>
          Issue Challan
        </h1>
        <LoadingState label="the Work items" rows={5} columns={3} />
      </Card>
    );
  }

  // Where the recipient in these boxes came from, when it was not typed
  // here. A prefilled form that never says so reads as one the operator
  // already filled in, so the document that supplied the values is named.
  // Only a new draft is ever seeded; an existing draft loaded its own.
  const carriedFrom = challanId === null ? (balance.issueCarryForward ?? null) : null;

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
              ref={(node) => {
                registerField('issue-challan-date', node);
              }}
              value={state.challanDate}
              onChange={(event) => {
                setState({ ...state, challanDate: event.target.value });
              }}
              required
              aria-invalid={fieldErrors['issue-challan-date'] !== undefined}
              aria-describedby={
                fieldErrors['issue-challan-date'] !== undefined
                  ? 'issue-challan-date-error'
                  : undefined
              }
            />
            {fieldErrors['issue-challan-date'] !== undefined && (
              <FieldError id="issue-challan-date-error">
                {fieldErrors['issue-challan-date']}
              </FieldError>
            )}
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
              ref={(node) => {
                registerField('issued-to-name', node);
              }}
              value={state.issuedToName}
              onChange={(event) => {
                setState({ ...state, issuedToName: event.target.value });
              }}
              required
              minLength={2}
              aria-invalid={fieldErrors['issued-to-name'] !== undefined}
              aria-describedby={
                fieldErrors['issued-to-name'] !== undefined
                  ? 'issued-to-name-error'
                  : undefined
              }
            />
            {fieldErrors['issued-to-name'] !== undefined && (
              <FieldError id="issued-to-name-error">
                {fieldErrors['issued-to-name']}
              </FieldError>
            )}
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
        {carriedFrom !== null && (
          <Hint>
            Carried from {carriedFrom.sourceChallanNumber} — edit if this movement
            differs.
          </Hint>
        )}

        <h2>Awarded items</h2>
        <DataTable scroll className="[&_input]:w-28">
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
            {balance.items.map((item) => {
              const quantityField = `quantity-${item.workItemId}`;
              return (
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
                        registerField(quantityField, node);
                      }}
                      aria-invalid={fieldErrors[quantityField] !== undefined}
                      aria-describedby={
                        fieldErrors[quantityField] !== undefined
                          ? `${quantityField}-error`
                          : undefined
                      }
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
                    {fieldErrors[quantityField] !== undefined && (
                      <FieldError id={`${quantityField}-error`}>
                        {fieldErrors[quantityField]}
                      </FieldError>
                    )}
                  </td>
                </tr>
              );
            })}
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
            aria-haspopup="dialog"
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
          <ConfirmDialog
            title="Discard your changes?"
            description="Nothing entered here has been saved yet. Leaving now throws away the quantities and manual lines you typed."
            cancelLabel="Keep editing"
            confirmLabel="Discard and leave"
            onCancel={() => {
              setConfirmingDiscard(false);
            }}
            onConfirm={onCancel}
          />
        )}
      </form>
    </Card>
  );
}
