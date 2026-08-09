import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  Contact,
  SaveChallanRequest,
  WorkBalanceResponse,
} from '@auto-mb/contracts';
import { existingRecordIdOf, RequestFailedError, type ApiClient } from '../api.js';

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

/** The prefix shape the server accepts (contracts: SaveChallanRequest). It
 * is stated beside the field and repeated as the input's custom validation
 * message, because the browser's own words for a failed `pattern` are
 * "Please match the requested format" — true, and useless. */
const PREFIX_PATTERN = /^[A-Z0-9][A-Z0-9_/-]{0,24}$/;
const PREFIX_RULE =
  'Start with a letter or digit, then use letters, digits, and _ / - only, ' +
  'up to 25 characters in total.';

/** Legal dates are date-only text and stay that way: this checks the shape
 * without ever building a Date, which would drag the value through a
 * timezone and can move it by a day. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A quantity as exact integer thousandths — the stored scale is
 * numeric(18,3) — or null when the text is not a plain decimal in the
 * shape the contract transports. Deliberately never parseFloat: every
 * comparison below is integer arithmetic on the decimal string, and the
 * server remains authoritative for the real check at issue time.
 *
 * The sign is handled because a Work with excess delivery allowed can
 * report a negative remaining balance.
 */
function quantityThousandths(raw: string): bigint | null {
  const text = raw.trim();
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot + 1);
  if (!/^(?:0|[1-9]\d*)$/.test(whole)) return null;
  if (dot !== -1 && !/^\d{1,3}$/.test(fraction)) return null;
  const value = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  return negative ? -value : value;
}

/** Joins the ids describing one control. A field can carry a hint and an
 * error, or an error and an over-delivery warning, at the same time;
 * aria-describedby takes a list, and an empty string would point a screen
 * reader at an element that does not exist. */
function describedBy(...ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length > 0 ? present.join(' ') : undefined;
}

/** What a save would send, flattened, so Cancel can tell an edited form
 * from a pristine one. Stray whitespace and emptied boxes are not edits
 * worth interrupting anyone over. */
function comparableContent(state: EditorState): string {
  return JSON.stringify({
    challanDate: state.challanDate,
    prefix: state.prefix,
    name: state.name.trim(),
    address: state.address.trim(),
    phone: state.phone.trim(),
    quantities: Object.entries(state.quantities)
      .filter(([, quantity]) => quantity.trim().length > 0)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([workItemId, quantity]) => [workItemId, quantity.trim()]),
  });
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
  /** The draft exactly as it loaded; Cancel compares against it. */
  const [loadedState, setLoadedState] = useState<EditorState | null>(null);
  const [consignees, setConsignees] = useState<readonly Contact[]>([]);
  const [workConsignees, setWorkConsignees] = useState<readonly Contact[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Work item ids whose entered quantity exceeded the remaining balance
   * at the last blur. Guidance, never enforcement — see the input below. */
  const [overRemaining, setOverRemaining] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [pending, setPending] = useState(false);
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const discardRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    setState(null);
    setLoadedState(null);
    setLoadError(null);
    setFieldErrors({});
    setOverRemaining(new Set());
    Promise.all([
      api.workBalance(organisationId, workId),
      challanId === null
        ? Promise.resolve(null)
        : api.getChallan(organisationId, challanId),
      // The picker is a convenience: an unavailable master list must not
      // block manual consignee entry.
      api.listContacts(organisationId, { role: 'consignee' }).catch(() => []),
      // R16: the Work's linked consignees are offered first; any active
      // consignee stays selectable below them.
      api.listWorkConsignees(organisationId, workId).catch(() => []),
    ])
      .then(([loadedBalance, existing, loadedConsignees, loadedWorkConsignees]) => {
        if (cancelled) return;
        setBalance(loadedBalance);
        setConsignees(loadedConsignees);
        setWorkConsignees(loadedWorkConsignees);
        const quantities: Record<string, string> = {};
        for (const item of existing?.items ?? []) {
          quantities[item.workItemId] = item.quantity;
        }
        const loaded: EditorState = {
          challanDate:
            existing?.challan.challanDate ?? new Date().toISOString().slice(0, 10),
          prefix: existing?.challan.prefix ?? workCode,
          name: existing?.challan.consignee.name ?? '',
          address: existing?.challan.consignee.address ?? '',
          phone: existing?.challan.consignee.phone ?? '',
          quantities,
        };
        setState(loaded);
        setLoadedState(loaded);
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

  const prefix = state?.prefix ?? null;
  // Carries the readable rule into the browser's own bubble. It runs on the
  // value as loaded too, which never fires a change event — a Work code that
  // is not a legal prefix has to explain itself the moment the form opens.
  useEffect(() => {
    const node = fieldRefs.current.get('challan-prefix');
    if (prefix === null || !(node instanceof HTMLInputElement)) return;
    node.setCustomValidity(PREFIX_PATTERN.test(prefix) ? '' : PREFIX_RULE);
  }, [prefix]);

  // The confirmation takes over the decision the Cancel button was about to
  // make, so focus moves into it rather than leaving a keyboard user parked
  // on a button whose meaning just changed.
  useEffect(() => {
    if (!confirmingDiscard) return;
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

  /** Re-checks one row against its remaining balance. Called on blur only:
   * flagging a half-typed "1" as over a remaining "12" while the operator is
   * still reaching for the second digit is noise, not help. */
  function checkRemaining(workItemId: string, remainingQuantity: string) {
    if (state === null) return;
    const entered = quantityThousandths(state.quantities[workItemId] ?? '');
    const remaining = quantityThousandths(remainingQuantity);
    const over = entered !== null && remaining !== null && entered > remaining;
    setOverRemaining((previous) => {
      if (previous.has(workItemId) === over) return previous;
      const next = new Set(previous);
      if (over) next.add(workItemId);
      else next.delete(workItemId);
      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === null || balance === null) return;
    // Every rule here mirrors one the server already enforces. Checking them
    // first is only so the answer names the box to fix: a rejected request
    // answers about the whole form.
    const nextFieldErrors: Record<string, string> = {};
    let firstInvalidField: string | null = null;
    function flag(field: string, message: string) {
      nextFieldErrors[field] = message;
      firstInvalidField ??= field;
    }
    if (!DATE_ONLY_PATTERN.test(state.challanDate)) {
      flag('challan-date', 'Enter the challan date.');
    }
    if (!PREFIX_PATTERN.test(state.prefix)) {
      flag('challan-prefix', PREFIX_RULE);
    }
    if (state.name.trim().length < 2) {
      flag('consignee-name', 'Enter the consignee, in at least 2 characters.');
    }
    const phone = state.phone.trim();
    if (phone.length > 0 && (phone.length < 3 || phone.length > 30)) {
      flag(
        'consignee-phone',
        'A phone number needs 3 to 30 characters, or leave the field empty.',
      );
    }
    if (state.address.trim().length < 3) {
      flag(
        'consignee-address',
        'Enter the delivery address, in at least 3 characters.',
      );
    }
    // Walking balance.items keeps the flags — and so the focus target — in
    // the order the rows appear on screen. Object.entries would follow the
    // order the operator first typed into each row instead.
    const entries = balance.items
      .map((item): [string, string] => [
        item.workItemId,
        state.quantities[item.workItemId] ?? '',
      ])
      .filter(([, quantity]) => quantity.trim().length > 0);
    for (const [workItemId, quantity] of entries) {
      const parsed = quantityThousandths(quantity);
      if (parsed === null || parsed <= 0n) {
        flag(
          `challan-quantity-${workItemId}`,
          'Enter a quantity greater than zero, with up to three decimals.',
        );
      }
    }
    setFieldErrors(nextFieldErrors);
    if (firstInvalidField !== null) {
      setSaveError('Correct the highlighted fields, then save the draft again.');
      focusField(firstInvalidField);
      return;
    }
    const items = entries.map(([workItemId, quantity]) => ({
      workItemId,
      quantity: quantity.trim(),
    }));
    if (items.length === 0) {
      setSaveError('Enter a quantity for at least one item.');
      // No single box is wrong here, so focus goes to the first one that can
      // satisfy the rule.
      const firstItem = balance.items[0];
      if (firstItem !== undefined) {
        focusField(`challan-quantity-${firstItem.workItemId}`);
      }
      return;
    }
    const body: SaveChallanRequest = {
      challanDate: state.challanDate,
      prefix: state.prefix,
      consignee: {
        name: state.name.trim(),
        address: state.address.trim(),
        ...(phone.length > 0 ? { phone } : {}),
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

  // Nothing typed here is stored anywhere until the draft is saved, and a
  // challan can carry a hundred typed quantities, so Cancel asks before
  // throwing an edited form away and leaves a pristine one alone.
  const edited =
    loadedState !== null && comparableContent(state) !== comparableContent(loadedState);

  return (
    <section className="card card--wide" aria-labelledby="challan-editor-title">
      <h1 id="challan-editor-title" tabIndex={-1}>
        {challanId === null ? 'New Delivery Challan' : 'Edit draft challan'}
      </h1>
      <p className="muted">
        Quantities are checked against each item's remaining balance when the challan is
        issued; drafts can be edited freely until then.
      </p>
      {/* noValidate: save() owns every rule, so each failure can name its
          field, bind a message, and move focus. */}
      <form noValidate onSubmit={(event) => void save(event)}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="challan-date">Challan date</label>
            <input
              id="challan-date"
              type="date"
              ref={(node) => {
                registerField('challan-date', node);
              }}
              value={state.challanDate}
              onChange={(event) => {
                setState({ ...state, challanDate: event.target.value });
              }}
              required
              aria-invalid={fieldErrors['challan-date'] !== undefined}
              aria-describedby={
                fieldErrors['challan-date'] !== undefined
                  ? 'challan-date-error'
                  : undefined
              }
            />
            {fieldErrors['challan-date'] !== undefined && (
              <p className="form-error" id="challan-date-error">
                {fieldErrors['challan-date']}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="challan-prefix">Number prefix</label>
            <input
              id="challan-prefix"
              ref={(node) => {
                registerField('challan-prefix', node);
              }}
              value={state.prefix}
              onChange={(event) => {
                setState({ ...state, prefix: event.target.value.toUpperCase() });
              }}
              required
              pattern="[A-Z0-9][A-Z0-9_/-]{0,24}"
              aria-invalid={fieldErrors['challan-prefix'] !== undefined}
              aria-describedby={describedBy(
                'challan-prefix-hint',
                fieldErrors['challan-prefix'] !== undefined
                  ? 'challan-prefix-error'
                  : undefined,
              )}
            />
            <p className="hint" id="challan-prefix-hint">
              {PREFIX_RULE} Letters are capitalised as you type.
            </p>
            {fieldErrors['challan-prefix'] !== undefined && (
              <p className="form-error" id="challan-prefix-error">
                {fieldErrors['challan-prefix']}
              </p>
            )}
          </div>
        </div>
        {consignees.length > 0 && (
          <div className="field">
            <label htmlFor="consignee-picker">Prefill consignee from contacts</label>
            <select
              id="consignee-picker"
              defaultValue=""
              onChange={(event) => {
                // The picker only PREFILLS the snapshot fields below —
                // the challan keeps its own free-text copy, and every
                // field stays editable after picking.
                const chosen = [...workConsignees, ...consignees].find(
                  (candidate) => candidate.id === event.target.value,
                );
                if (chosen === undefined) return;
                setState({
                  ...state,
                  name: chosen.designation,
                  address: chosen.address ?? '',
                  phone: chosen.phone ?? '',
                });
              }}
            >
              <option value="">Manual entry</option>
              {workConsignees.length > 0 && (
                <optgroup label="Linked to this Work">
                  {workConsignees.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.designation}
                      {candidate.address !== null ? ` — ${candidate.address}` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="All consignees">
                {consignees.map((candidate) => (
                  <option key={`all-${candidate.id}`} value={candidate.id}>
                    {candidate.designation}
                    {candidate.address !== null ? ` — ${candidate.address}` : ''}
                  </option>
                ))}
              </optgroup>
            </select>
            <p className="hint">
              Consignees linked to this Work are listed first; any active consignee can
              be picked. Picking copies the details into this challan; edits here never
              change the contact.
            </p>
          </div>
        )}
        <div className="field-row">
          <div className="field">
            <label htmlFor="consignee-name">Consignee name</label>
            <input
              id="consignee-name"
              ref={(node) => {
                registerField('consignee-name', node);
              }}
              value={state.name}
              onChange={(event) => {
                setState({ ...state, name: event.target.value });
              }}
              required
              minLength={2}
              autoComplete="organization"
              aria-invalid={fieldErrors['consignee-name'] !== undefined}
              aria-describedby={
                fieldErrors['consignee-name'] !== undefined
                  ? 'consignee-name-error'
                  : undefined
              }
            />
            {fieldErrors['consignee-name'] !== undefined && (
              <p className="form-error" id="consignee-name-error">
                {fieldErrors['consignee-name']}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="consignee-phone">Consignee phone (optional)</label>
            {/* A site engineer fills this on a tablet: `tel` asks for the
                dialling keypad rather than an alphabetic keyboard, and the
                autofill hint offers the number already on the device. */}
            <input
              id="consignee-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              ref={(node) => {
                registerField('consignee-phone', node);
              }}
              value={state.phone}
              onChange={(event) => {
                setState({ ...state, phone: event.target.value });
              }}
              aria-invalid={fieldErrors['consignee-phone'] !== undefined}
              aria-describedby={
                fieldErrors['consignee-phone'] !== undefined
                  ? 'consignee-phone-error'
                  : undefined
              }
            />
            {fieldErrors['consignee-phone'] !== undefined && (
              <p className="form-error" id="consignee-phone-error">
                {fieldErrors['consignee-phone']}
              </p>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor="consignee-address">Consignee address</label>
          <textarea
            id="consignee-address"
            ref={(node) => {
              registerField('consignee-address', node);
            }}
            value={state.address}
            onChange={(event) => {
              setState({ ...state, address: event.target.value });
            }}
            required
            minLength={3}
            rows={2}
            autoComplete="street-address"
            aria-invalid={fieldErrors['consignee-address'] !== undefined}
            aria-describedby={
              fieldErrors['consignee-address'] !== undefined
                ? 'consignee-address-error'
                : undefined
            }
          />
          {fieldErrors['consignee-address'] !== undefined && (
            <p className="form-error" id="consignee-address-error">
              {fieldErrors['consignee-address']}
            </p>
          )}
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
            {balance.items.map((item) => {
              const quantityField = `challan-quantity-${item.workItemId}`;
              const over = overRemaining.has(item.workItemId);
              return (
                <tr key={item.workItemId}>
                  <th scope="row">{item.itemNumber}</th>
                  <td className="cell--wrap">{item.description}</td>
                  <td>{item.unitCode}</td>
                  <td className="cell--numeric">
                    {item.effectiveQuantity !== null &&
                    item.effectiveQuantity !== undefined &&
                    item.effectiveQuantity !== item.awardedQuantity ? (
                      // An approved amendment moved the ceiling: show both.
                      <>
                        <s className="muted">{item.awardedQuantity}</s> →{' '}
                        {item.effectiveQuantity}
                      </>
                    ) : (
                      item.awardedQuantity
                    )}
                  </td>
                  <td className="cell--numeric">{item.deliveredQuantity}</td>
                  <td className="cell--numeric">{item.remainingQuantity}</td>
                  <td>
                    <input
                      aria-label={`Quantity of ${item.itemNumber} on this challan`}
                      inputMode="decimal"
                      ref={(node) => {
                        registerField(quantityField, node);
                      }}
                      value={state.quantities[item.workItemId] ?? ''}
                      onChange={(event) => {
                        // A stale over-delivery flag must not survive the
                        // edit that may be clearing it; the next blur decides
                        // again.
                        setOverRemaining((previous) => {
                          if (!previous.has(item.workItemId)) return previous;
                          const next = new Set(previous);
                          next.delete(item.workItemId);
                          return next;
                        });
                        setState({
                          ...state,
                          quantities: {
                            ...state.quantities,
                            [item.workItemId]: event.target.value,
                          },
                        });
                      }}
                      onBlur={() => {
                        // Guidance only, and only where an excess would
                        // actually be refused: the draft stays saveable, and
                        // the server does the authoritative comparison when
                        // the challan is issued.
                        if (balance.allowExcessDelivery) return;
                        checkRemaining(item.workItemId, item.remainingQuantity);
                      }}
                      aria-invalid={fieldErrors[quantityField] !== undefined}
                      aria-describedby={describedBy(
                        fieldErrors[quantityField] !== undefined
                          ? `${quantityField}-error`
                          : undefined,
                        over ? `${quantityField}-over` : undefined,
                      )}
                    />
                    {fieldErrors[quantityField] !== undefined && (
                      <p className="form-error" id={`${quantityField}-error`}>
                        {fieldErrors[quantityField]}
                      </p>
                    )}
                    {over && (
                      <span className="chip chip--review" id={`${quantityField}-over`}>
                        over the {item.remainingQuantity} remaining
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
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
          <button
            type="button"
            className="button--ghost"
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
              consignee details and every quantity you typed.
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
