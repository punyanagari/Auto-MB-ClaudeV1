import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  Contact,
  PurchaseOrderDetailResponse,
  SaveChallanRequest,
  WorkBalanceResponse,
} from '@auto-mb/contracts';
import { existingRecordIdOf, RequestFailedError, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
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
import { formatRate } from '../format.js';

interface ChallanEditorProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workCode: string;
  /** Null drafts a new challan; an id edits the existing draft. */
  readonly challanId: string | null;
  readonly onSaved: (challanId: string) => void;
  readonly onCancel: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

/** A manual (non-LOA) line already on the draft, exactly as the server
 * stored it. This editor draws its rows from the Work's BALANCE, so a
 * line with no work item has no row here — and a save replaces the whole
 * line set, which would quietly drop it. It is carried through untouched
 * instead, and shown so the operator knows it is on the document. */
interface CarriedManualLine {
  readonly description: string;
  readonly unit: string;
  readonly quantity: string;
  readonly rate: string;
}

interface EditorState {
  challanDate: string;
  prefix: string;
  name: string;
  address: string;
  phone: string;
  quantities: Record<string, string>;
  /** Work item id -> the purchase-order line this delivery receives
   * against; '' when the material arrives without an order. */
  poLines: Record<string, string>;
}

/** One open purchase-order line a challan row can receive against,
 * labelled the way the operator knows it: the PO number and how much of
 * the line is still owed. */
interface PoLineChoice {
  readonly id: string;
  readonly poNumber: string;
  readonly pendingQuantity: string;
}

/** The open PO lines grouped per Work item. Only lines that name a Work
 * item are offered — a consumable line has no challan row to sit on. */
function poLineChoicesOf(
  openOrders: readonly PurchaseOrderDetailResponse[],
): ReadonlyMap<string, readonly PoLineChoice[]> {
  const choices = new Map<string, PoLineChoice[]>();
  for (const detail of openOrders) {
    const poNumber = detail.purchaseOrder.poNumber;
    if (poNumber === null) continue;
    for (const line of detail.lines) {
      if (line.workItemId === null) continue;
      const group = choices.get(line.workItemId) ?? [];
      group.push({
        id: line.id,
        poNumber,
        pendingQuantity: line.pendingQuantity ?? line.quantity,
      });
      choices.set(line.workItemId, group);
    }
  }
  return choices;
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
    poLines: Object.entries(state.poLines)
      .filter(([, lineId]) => lineId.length > 0)
      .sort((left, right) => left[0].localeCompare(right[0])),
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
  onDirtyChange,
}: ChallanEditorProps) {
  const [balance, setBalance] = useState<WorkBalanceResponse | null>(null);
  const [state, setState] = useState<EditorState | null>(null);
  /** The draft exactly as it loaded; Cancel compares against it. */
  const [loadedState, setLoadedState] = useState<EditorState | null>(null);
  const [consignees, setConsignees] = useState<readonly Contact[]>([]);
  const [workConsignees, setWorkConsignees] = useState<readonly Contact[]>([]);
  const [poLineChoices, setPoLineChoices] = useState<
    ReadonlyMap<string, readonly PoLineChoice[]>
  >(new Map());
  const [carriedManualLines, setCarriedManualLines] = useState<
    readonly CarriedManualLine[]
  >([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Work item ids whose entered quantity exceeded the remaining balance
   * at the last blur. Guidance, never enforcement — see the input below. */
  const [overRemaining, setOverRemaining] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [pending, setPending] = useState(false);
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const cancelRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
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
      // The receipt link is a convenience too: a Work without open
      // purchase orders — or whose orders cannot be read — simply offers
      // no select, and the challan saves exactly as before.
      api
        .listWorkPurchaseOrders(organisationId, workId, 'open')
        .then((orders) =>
          Promise.all(
            orders.map((order) => api.getPurchaseOrder(organisationId, order.id)),
          ),
        )
        .catch(() => [] as PurchaseOrderDetailResponse[]),
    ])
      .then(
        ([
          loadedBalance,
          existing,
          loadedConsignees,
          loadedWorkConsignees,
          openOrders,
        ]) => {
          if (cancelled) return;
          setBalance(loadedBalance);
          setConsignees(loadedConsignees);
          setWorkConsignees(loadedWorkConsignees);
          setPoLineChoices(poLineChoicesOf(openOrders));
          setCarriedManualLines(
            (existing?.items ?? [])
              .filter((item) => item.workItemId === null)
              .map((item) => ({
                description: item.description,
                unit: item.unit,
                quantity: item.quantity,
                rate: item.rate,
              })),
          );
          const quantities: Record<string, string> = {};
          const poLines: Record<string, string> = {};
          for (const item of existing?.items ?? []) {
            // A manual (non-LOA) line has no work item to key on; it is
            // collected separately and carried through the save.
            if (item.workItemId === null) continue;
            quantities[item.workItemId] = item.quantity;
            if (typeof item.purchaseOrderLineId === 'string') {
              poLines[item.workItemId] = item.purchaseOrderLineId;
            }
          }
          const loaded: EditorState = {
            challanDate: existing?.challan.challanDate ?? loadedBalance.today,
            prefix: existing?.challan.prefix ?? workCode,
            name: existing?.challan.consignee.name ?? '',
            address: existing?.challan.consignee.address ?? '',
            phone: existing?.challan.consignee.phone ?? '',
            quantities,
            poLines,
          };
          setState(loaded);
          setLoadedState(loaded);
        },
      )
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
    if (!confirmingDiscard) {
      // Declining unmounts the button that held focus, so hand it back to
      // Cancel rather than dropping the operator at the top of the document.
      cancelRef.current?.focus();
      return;
    }
    discardRef.current?.focus();
  }, [confirmingDiscard]);

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
    const items = [
      ...entries.map(([workItemId, quantity]) => {
        const purchaseOrderLineId = state.poLines[workItemId] ?? '';
        return {
          workItemId,
          quantity: quantity.trim(),
          ...(purchaseOrderLineId.length > 0 ? { purchaseOrderLineId } : {}),
        };
      }),
      ...carriedManualLines,
    ];
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
      <Card aria-labelledby="challan-editor-title">
        <h1 id="challan-editor-title" tabIndex={-1}>
          Delivery Challan
        </h1>
        <FormError>{loadError}</FormError>
      </Card>
    );
  }

  if (balance === null || state === null) {
    return (
      <Card aria-labelledby="challan-editor-title">
        <h1 id="challan-editor-title" tabIndex={-1}>
          Delivery Challan
        </h1>
        <p className="text-muted-foreground" role="status">
          Loading balances…
        </p>
      </Card>
    );
  }

  // A retired contact stops being OFFERED, on this Work as everywhere
  // else. The Work list returns every linked row, retired or not — the
  // link is a preference and is never destroyed, so reactivating the
  // contact brings it straight back — but a post that has been abolished
  // must not keep appearing at the top of the challan picker. The general
  // "All consignees" group is already active-only, and linking a retired
  // contact is refused with 409 CONTACT_RETIRED.
  const linkedConsignees = workConsignees.filter((candidate) => candidate.active);

  // The column exists only while the Work has open purchase orders with
  // lines to receive against; without them the table reads exactly as it
  // always did.
  const offersPoLines = poLineChoices.size > 0;

  return (
    <Card className="w-full" aria-labelledby="challan-editor-title">
      <h1 id="challan-editor-title" tabIndex={-1}>
        {challanId === null ? 'New Delivery Challan' : 'Edit draft challan'}
      </h1>
      <p className="text-muted-foreground">
        Quantities are checked against each item's remaining balance when the challan is
        issued; drafts can be edited freely until then.
      </p>
      {/* noValidate: save() owns every rule, so each failure can name its
          field, bind a message, and move focus. */}
      <form noValidate onSubmit={(event) => void save(event)}>
        <FieldRow>
          <Field>
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
              <FieldError id="challan-date-error">
                {fieldErrors['challan-date']}
              </FieldError>
            )}
          </Field>
          <Field>
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
            <Hint id="challan-prefix-hint">
              {PREFIX_RULE} Letters are capitalised as you type.
            </Hint>
            {fieldErrors['challan-prefix'] !== undefined && (
              <FieldError id="challan-prefix-error">
                {fieldErrors['challan-prefix']}
              </FieldError>
            )}
          </Field>
        </FieldRow>
        {consignees.length > 0 && (
          <Field>
            <label htmlFor="consignee-picker">Prefill consignee from contacts</label>
            <select
              id="consignee-picker"
              defaultValue=""
              onChange={(event) => {
                // The picker only PREFILLS the snapshot fields below —
                // the challan keeps its own free-text copy, and every
                // field stays editable after picking.
                const chosen = [...linkedConsignees, ...consignees].find(
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
              {linkedConsignees.length > 0 && (
                <optgroup label="Linked to this Work">
                  {linkedConsignees.map((candidate) => (
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
            <Hint>
              Consignees linked to this Work are listed first; any active consignee can
              be picked. Picking copies the details into this challan; edits here never
              change the contact.
            </Hint>
          </Field>
        )}
        <FieldRow>
          <Field>
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
              <FieldError id="consignee-name-error">
                {fieldErrors['consignee-name']}
              </FieldError>
            )}
          </Field>
          <Field>
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
              <FieldError id="consignee-phone-error">
                {fieldErrors['consignee-phone']}
              </FieldError>
            )}
          </Field>
        </FieldRow>
        <Field>
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
            <FieldError id="consignee-address-error">
              {fieldErrors['consignee-address']}
            </FieldError>
          )}
        </Field>

        <h2>Items</h2>
        <DataTable scroll className="[&_input]:w-28">
          <caption className="sr-only">
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
              {offersPoLines && <th scope="col">Against PO</th>}
            </tr>
          </thead>
          <tbody>
            {balance.items.map((item) => {
              const quantityField = `challan-quantity-${item.workItemId}`;
              const over = overRemaining.has(item.workItemId);
              return (
                <tr key={item.workItemId}>
                  <th scope="row">{item.itemNumber}</th>
                  <td className={wrapCell}>{item.description}</td>
                  <td>{item.unitCode}</td>
                  <td className={numericCell}>
                    {item.effectiveQuantity !== null &&
                    item.effectiveQuantity !== undefined &&
                    item.effectiveQuantity !== item.awardedQuantity ? (
                      // An approved amendment moved the ceiling: show both.
                      <>
                        <s className="text-muted-foreground">{item.awardedQuantity}</s>{' '}
                        → {item.effectiveQuantity}
                      </>
                    ) : (
                      item.awardedQuantity
                    )}
                  </td>
                  <td className={numericCell}>{item.deliveredQuantity}</td>
                  <td className={numericCell}>{item.remainingQuantity}</td>
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
                      <FieldError id={`${quantityField}-error`}>
                        {fieldErrors[quantityField]}
                      </FieldError>
                    )}
                    {over && (
                      <StatusChip status="review" id={`${quantityField}-over`}>
                        over the {item.remainingQuantity} remaining
                      </StatusChip>
                    )}
                  </td>
                  {offersPoLines && (
                    <td>
                      {(poLineChoices.get(item.workItemId) ?? []).length > 0 ? (
                        <select
                          aria-label={`Purchase order line for ${item.itemNumber}`}
                          value={state.poLines[item.workItemId] ?? ''}
                          onChange={(event) => {
                            setState({
                              ...state,
                              poLines: {
                                ...state.poLines,
                                [item.workItemId]: event.target.value,
                              },
                            });
                          }}
                        >
                          <option value="">No purchase order</option>
                          {(poLineChoices.get(item.workItemId) ?? []).map((choice) => (
                            <option key={choice.id} value={choice.id}>
                              {choice.poNumber} · {choice.pendingQuantity} pending
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </DataTable>

        {carriedManualLines.length > 0 && (
          <>
            <h2>Installation material</h2>
            <Hint>
              Lines that are not on the Work&rsquo;s schedule. They travel on this
              challan and count towards nothing in the quantity ledger. Saving keeps
              them exactly as they are; edit them from the Delivery Challans register.
            </Hint>
            <DataTable scroll>
              <caption className="sr-only">
                Non-schedule lines already on this challan
              </caption>
              <thead>
                <tr>
                  <th scope="col">Description</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className={numericCell}>
                    Quantity
                  </th>
                  <th scope="col" className={numericCell}>
                    Rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {carriedManualLines.map((line, index) => (
                  // These lines are read-only here and never reordered, so
                  // their position is a stable identity.
                  <tr key={index}>
                    <td className={wrapCell}>{line.description}</td>
                    <td>{line.unit}</td>
                    <td className={numericCell}>{line.quantity}</td>
                    <td className={numericCell}>{formatRate(line.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </>
        )}

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
              consignee details and every quantity you typed.
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
