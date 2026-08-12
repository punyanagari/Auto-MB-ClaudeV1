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
 * item are offered â€” a consumable line has no challan row to sit on. */
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
 * "Please match the requested format" â€” true, and useless. */
const PREFIX_PATTERN = /^[A-Z0-9][A-Z0-9_/-]{0,24}$/;
const PREFIX_RULE =
  'Start with a letter or digit, then use letters, digits, and _ / - only, ' +
  'up to 25 characters in total.';

/** Legal dates are date-only text and stay that way: this checks the shape
 * without ever building a Date, which would drag the value through a
 * timezone and can move it by a day. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A quantity as exact integer thousandths â€” the stored scale is
 * numeric(18,3) â€” or null when the text is not a plain decimal in the
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Work item ids whose entered quantity exceeded the remaining balance
   * at the last blur. Guidance, never enforcement â€” see the input below. */
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
      // purchase orders â€” or whose orders cannot be read â€” simply offers
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
          const quantities: Record<string, string> = {};
          const poLines: Record<string, string> = {};
          for (const item of existing?.items ?? []) {
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
  // value as loaded too, which never fires a change event â€” a Work code that
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
    // Walking balance.items keeps the flags â€” and so the focus target â€” in
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
    const items = entries.map(([workItemId, quantity]) => {
      const purchaseOrderLineId = state.poLines[workItemId] ?? '';
      return {
        workItemId,
        quantity: quantity.trim(),
        ...(purchaseOrderLineId.length > 0 ? { purchaseOrderLineId } : {}),
      };
    });
    if (items.length === 0) {
      setSaveError('Enter a×N=¶‰žËkºwµçl¼¨¹½Y…±¥‘…Ñ”èÍ…Ù” ¤½Ý¹Ì•Ù•ÉäÉÕ±”°Í¼•… ™…¥±ÕÉ”…¸¹…µ”¥ÑÌ(€€€€€€€€€™¥•±°‰¥¹„µ•ÍÍ…”°…¹µ½Ù”™½ÕÌ¸€¨½ô(€€€€€€ñ™½É´¹½Y…±¥‘…Ñ”½¹MÕ‰µ¥Ðõì¡•Ù•¹Ð¤€ôøÙ½¥Í…Ù”¡•Ù•¹Ð¥ôø(€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰¡…±±…¸µ‘…Ñ”ˆù¡…±±…¸‘…Ñ”ð½±…‰•°ø(€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€¥ô‰¡…±±…¸µ‘…Ñ”ˆ(€€€€€€€€€€€€€ÑåÁ”ô‰‘…Ñ”ˆ(€€€€€€€€€€€€€É•˜õì¡¹½‘”¤€ôøì(€€€€€€€€€€€€€€€É•¥ÍÑ•É¥•± ¡…±±…¸µ‘…Ñ”œ°¹½‘”¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€Ù…±Õ”õíÍÑ…Ñ”¹¡…±±…¹…Ñ•ô(€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€Í•ÑMÑ…Ñ”¡ì€¸¸¹ÍÑ…Ñ”°¡…±±…¹…Ñ”è•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€…É¥„µ¥¹Ù…±¥õí™¥•±‘ÉÉ½ÉÍl¡…±±…¸µ‘…Ñ”t€„ôôÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äõì(€€€€€€€€€€€€€€€™¥•±‘ÉÉ½ÉÍl¡…±±…¸µ‘…Ñ”t€„ôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€€€ü€¡…±±…¸µ‘…Ñ”µ•ÉÉ½Èœ(€€€€€€€€€€€€€€€€€€èÕ¹‘•™¥¹•(€€€€€€€€€€€€€ô(€€€€€€€€€€€€¼ø(€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl¡…±±…¸µ‘…Ñ”t€„ôôÕ¹‘•™¥¹•€˜˜€ (€€€€€€€€€€€€€€ñ¥•±‘ÉÉ½È¥ô‰¡…±±…¸µ‘…Ñ”µ•ÉÉ½Èˆø(€€€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl¡…±±…¸µ‘…Ñ”uô(€€€€€€€€€€€€€€ð½¥•±‘ÉÉ½Èø(€€€€€€€€€€€€¥ô(€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰¡…±±…¸µÁÉ•™¥àˆù9Õµ‰•ÈÁÉ•™¥àð½±…‰•°ø(€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€¥ô‰¡…±±…¸µÁÉ•™¥àˆ(€€€€€€€€€€€€€É•˜õì¡¹½‘”¤€ôøì(€€€€€€€€€€€€€€€É•¥ÍÑ•É¥•± ¡…±±…¸µÁÉ•™¥àœ°¹½‘”¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€Ù…±Õ”õíÍÑ…Ñ”¹ÁÉ•™¥áô(€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€Í•ÑMÑ…Ñ”¡ì€¸¸¹ÍÑ…Ñ”°ÁÉ•™¥àè•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¹Ñ½UÁÁ•É…Í” ¤ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€Á…ÑÑ•É¸ô‰mµhÀ´åumµhÀ´å|¼µuìÀ°ÈÑôˆ(€€€€€€€€€€€€€…É¥„µ¥¹Ù…±¥õí™¥•±‘ÉÉ½ÉÍl¡…±±…¸µÁÉ•™¥àt€„ôôÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äõí‘•ÍÉ¥‰•‘	ä (€€€€€€€€€€€€€€€€¡…±±…¸µÁÉ•™¥àµ¡¥¹Ðœ°(€€€€€€€€€€€€€€€™¥•±‘ÉÉ½ÉÍl¡…±±…¸µÁÉ•™¥àt€„ôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€€€ü€¡…±±…¸µÁÉ•™¥àµ•ÉÉ½Èœ(€€€€€€€€€€€€€€€€€€èÕ¹‘•™¥¹•°(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€¼ø(€€€€€€€€€€€€ñ!¥¹Ð¥ô‰¡…±±…¸µÁÉ•™¥àµ¡¥¹Ðˆø(€€€€€€€€€€€€€íAI%a}IU1ô1•ÑÑ•ÉÌ…É”…Á¥Ñ…±¥Í•…Ìå½ÔÑåÁ”¸(€€€€€€€€€€€€ð½!¥¹Ðø(€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl¡…±±…¸µÁÉ•™¥àt€„ôôÕ¹‘•™¥¹•€˜˜€ (€€€€€€€€€€€€€€ñ¥•±‘ÉÉ½È¥ô‰¡…±±…¸µÁÉ•™¥àµ•ÉÉ½Èˆø(€€€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl¡…±±…¸µÁÉ•™¥àuô(€€€€€€€€€€€€€€ð½¥•±‘ÉÉ½Èø(€€€€€€€€€€€€¥ô(€€€€€€€€€€ð½¥•±ø(€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€í½¹Í¥¹••Ì¹±•¹Ñ €ø€À€˜˜€ (€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰½¹Í¥¹•”µÁ¥­•ÈˆùAÉ•™¥±°½¹Í¥¹•”™É½´½¹Ñ…ÑÌð½±…‰•°ø(€€€€€€€€€€€€ñÍ•±•Ð(€€€€€€€€€€€€€¥ô‰½¹Í¥¹•”µÁ¥­•Èˆ(€€€€€€€€€€€€€‘•™…Õ±ÑY…±Õ”ôˆˆ(€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€¼¼Q¡”Á¥­•È½¹±äAI%11LÑ¡”Í¹…ÁÍ¡½Ð™¥•±‘Ì‰•±½ÜƒŠP(€€€€€€€€€€€€€€€€¼¼Ñ¡”¡…±±…¸­••ÁÌ¥ÑÌ½Ý¸™É•”µÑ•áÐ½Áä°…¹•Ù•Éä(€€€€€€€€€€€€€€€€¼¼™¥•±ÍÑ…åÌ•‘¥Ñ…‰±”…™Ñ•ÈÁ¥­¥¹œ¸(€€€€€€€€€€€€€€€½¹ÍÐ¡½Í•¸€ôl¸¸¹±¥¹­•‘½¹Í¥¹••Ì°€¸¸¹½¹Í¥¹••Ít¹™¥¹ (€€€€€€€€€€€€€€€€€€¡…¹‘¥‘…Ñ”¤€ôø…¹‘¥‘…Ñ”¹¥€ôôô•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”°(€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€¥˜€¡¡½Í•¸€ôôôÕ¹‘•™¥¹•¤É•ÑÕÉ¸ì(€€€€€€€€€€€€€€€Í•ÑMÑ…Ñ”¡ì(€€€€€€€€€€€€€€€€€€¸¸¹ÍÑ…Ñ”°(€€€€€€€€€€€€€€€€€¹…µ”è¡½Í•¸¹‘•Í¥¹…Ñ¥½¸°(€€€€€€€€€€€€€€€€€…‘‘É•ÍÌè¡½Í•¸¹…‘‘É•ÍÌ€üü€œœ°(€€€€€€€€€€€€€€€€€Á¡½¹”è¡½Í•¸¹Á¡½¹”€üü€œœ°(€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€ø(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ôˆˆù5…¹Õ…°•¹ÑÉäð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€í±¥¹­•‘½¹Í¥¹••Ì¹±•¹Ñ €ø€À€˜˜€ (€€€€€€€€€€€€€€€€ñ½ÁÑÉ½ÕÀ±…‰•°ô‰1¥¹­•Ñ¼Ñ¡¥Ì]½É¬ˆø(€€€€€€€€€€€€€€€€€í±¥¹­•‘½¹Í¥¹••Ì¹µ…À ¡…¹‘¥‘…Ñ”¤€ôø€ (€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸­•äõí…¹‘¥‘…Ñ”¹¥‘ôÙ…±Õ”õí…¹‘¥‘…Ñ”¹¥‘ôø(€€€€€€€€€€€€€€€€€€€€€í…¹‘¥‘…Ñ”¹‘•Í¥¹…Ñ¥½¹ô(€€€€€€€€€€€€€€€€€€€€€í…¹‘¥‘…Ñ”¹…‘‘É•ÍÌ€„ôô¹Õ±°€ü€ƒŠP€‘í…¹‘¥‘…Ñ”¹…‘‘É•ÍÍõ€€è€œô(€€€€€€€€€€€€€€€€€€€€ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€¤¥ô(€€€€€€€€€€€€€€€€ð½½ÁÑÉ½ÕÀø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€ñ½ÁÑÉ½ÕÀ±…‰•°ô‰±°½¹Í¥¹••Ìˆø(€€€€€€€€€€€€€€€í½¹Í¥¹••Ì¹µ…À ¡…¹‘¥‘…Ñ”¤€ôø€ (€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸­•äõí…±°´‘í…¹‘¥‘…Ñ”¹¥‘õôÙ…±Õ”õí…¹‘¥‘…Ñ”¹¥‘ôø(€€€€€€€€€€€€€€€€€€€í…¹‘¥‘…Ñ”¹‘•Í¥¹…Ñ¥½¹ô(€€€€€€€€€€€€€€€€€€€í…¹‘¥‘…Ñ”¹…‘‘É•ÍÌ€„ôô¹Õ±°€ü€ƒŠP€‘í…¹‘¥‘…Ñ”¹…‘‘É•ÍÍõ€€è€œô(€€€€€€€€€€€€€€€€€€ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€¤¥ô(€€€€€€€€€€€€€€ð½½ÁÑÉ½ÕÀø(€€€€€€€€€€€€ð½Í•±•Ðø(€€€€€€€€€€€€ñ!¥¹Ðø(€€€€€€€€€€€€€½¹Í¥¹••Ì±¥¹­•Ñ¼Ñ¡¥Ì]½É¬…É”±¥ÍÑ•™¥ÉÍÐì…¹ä…Ñ¥Ù”½¹Í¥¹•”…¸(€€€€€€€€€€€€€‰”Á¥­•¸A¥­¥¹œ½Á¥•ÌÑ¡”‘•Ñ…¥±Ì¥¹Ñ¼Ñ¡¥Ì¡…±±…¸ì•‘¥ÑÌ¡•É”¹•Ù•È(€€€€€€€€€€€€€¡…¹”Ñ¡”½¹Ñ…Ð¸(€€€€€€€€€€€€ð½!¥¹Ðø(€€€€€€€€€€ð½¥•±ø(€€€€€€€€¥ô(€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰½¹Í¥¹•”µ¹…µ”ˆù½¹Í¥¹•”¹…µ”ð½±…‰•°ø(€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€¥ô‰½¹Í¥¹•”µ¹…µ”ˆ(€€€€€€€€€€€€€É•˜õì¡¹½‘”¤€ôøì(€€€€€€€€€€€€€€€É•¥ÍÑ•É¥•± ½¹Í¥¹•”µ¹…µ”œ°¹½‘”¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€Ù…±Õ”õíÍÑ…Ñ”¹¹…µ•ô(€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€Í•ÑMÑ…Ñ”¡ì€¸¸¹ÍÑ…Ñ”°¹…µ”è•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€µ¥¹1•¹Ñ õìÉô(€€€€€€€€€€€€€…ÕÑ½½µÁ±•Ñ”ô‰½É…¹¥é…Ñ¥½¸ˆ(€€€€€€€€€€€€€…É¥„µ¥¹Ù…±¥õí™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µ¹…µ”t€„ôôÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äõì(€€€€€€€€€€€€€€€™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µ¹…µ”t€„ôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€€€ü€½¹Í¥¹•”µ¹…µ”µ•ÉÉ½Èœ(€€€€€€€€€€€€€€€€€€èÕ¹‘•™¥¹•(€€€€€€€€€€€€€ô(€€€€€€€€€€€€¼ø(€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µ¹…µ”t€„ôôÕ¹‘•™¥¹•€˜˜€ (€€€€€€€€€€€€€€ñ¥•±‘ÉÉ½È¥ô‰½¹Í¥¹•”µ¹…µ”µ•ÉÉ½Èˆø(€€€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µ¹…µ”uô(€€€€€€€€€€€€€€ð½¥•±‘ÉÉ½Èø(€€€€€€€€€€€€¥ô(€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰½¹Í¥¹•”µÁ¡½¹”ˆù½¹Í¥¹•”Á¡½¹”€¡½ÁÑ¥½¹…°¤ð½±…‰•°ø(€€€€€€€€€€€ì¼¨Í¥Ñ”•¹¥¹••È™¥±±ÌÑ¡¥Ì½¸„Ñ…‰±•ÐèÑ•±€…Í­Ì™½ÈÑ¡”(€€€€€€€€€€€€€€€‘¥…±±¥¹œ­•åÁ…É…Ñ¡•ÈÑ¡…¸…¸…±Á¡…‰•Ñ¥Œ­•å‰½…É°…¹Ñ¡”(€€€€€€€€€€€€€€€…ÕÑ½™¥±°¡¥¹Ð½™™•ÉÌÑ¡”¹Õµ‰•È…±É•…‘ä½¸Ñ¡”‘•Ù¥”¸€¨½ô(€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€¥ô‰½¹Í¥¹•”µÁ¡½¹”ˆ(€€€€€€€€€€€€€ÑåÁ”ô‰Ñ•°ˆ(€€€€€€€€€€€€€¥¹ÁÕÑ5½‘”ô‰Ñ•°ˆ(€€€€€€€€€€€€€…ÕÑ½½µÁ±•Ñ”ô‰Ñ•°ˆ(€€€€€€€€€€€€€É•˜õì¡¹½‘”¤€ôøì(€€€€€€€€€€€€€€€É•¥ÍÑ•É¥•± ½¹Í¥¹•”µÁ¡½¹”œ°¹½‘”¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€Ù…±Õ”õíÍÑ…Ñ”¹Á¡½¹•ô(€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€Í•ÑMÑ…Ñ”¡ì€¸¸¹ÍÑ…Ñ”°Á¡½¹”è•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”ô¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€…É¥„µ¥¹Ù…±¥õí™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µÁ¡½¹”t€„ôôÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äõì(€€€€€€€€€€€€€€€™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µÁ¡½¹”t€„ôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€€€ü€½¹Í¥¹•”µÁ¡½¹”µ•ÉÉ½Èœ(€€€€€€€€€€€€€€€€€€èÕ¹‘•™¥¹•(€€€€€€€€€€€€€ô(€€€€€€€€€€€€¼ø(€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µÁ¡½¹”t€„ôôÕ¹‘•™¥¹•€˜˜€ (€€€€€€€€€€€€€€ñ¥•±‘ÉÉ½È¥ô‰½¹Í¥¹•”µÁ¡½¹”µ•ÉÉ½Èˆø(€€€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µÁ¡½¹”uô(€€€€€€€€€€€€€€ð½¥•±‘ÉÉ½Èø(€€€€€€€€€€€€¥ô(€€€€€€€€€€ð½¥•±ø(€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€ñ¥•±ø(€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰½¹Í¥¹•”µ…‘‘É•ÍÌˆù½¹Í¥¹•”…‘‘É•ÍÌð½±…‰•°ø(€€€€€€€€€€ñÑ•áÑ…É•„(€€€€€€€€€€€¥ô‰½¹Í¥¹•”µ…‘‘É•ÍÌˆ(€€€€€€€€€€€É•˜õì¡¹½‘”¤€ôøì(€€€€€€€€€€€€€É•¥ÍÑ•É¥•± ½¹Í¥¹•”µ…‘‘É•ÍÌœ°¹½‘”¤ì(€€€€€€€€€€€õô(€€€€€€€€€€€Ù…±Õ”õíÍÑ…Ñ”¹…‘‘É•ÍÍô(€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€Í•ÑMÑ…Ñ”¡ì€¸¸¹ÍÑ…Ñ”°…‘‘É•ÍÌè•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”ô¤ì(€€€€€€€€€€€õô(€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€µ¥¹1•¹Ñ õìÍô(€€€€€€€€€€€É½ÝÌõìÉô(€€€€€€€€€€€…ÕÑ½½µÁ±•Ñ”ô‰ÍÑÉ••Ðµ…‘‘É•ÍÌˆ(€€€€€€€€€€€…É¥„µ¥¹Ù…±¥õí™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µ…‘‘É•ÍÌt€„ôôÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äõì(€€€€€€€€€€€€€™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µ…‘‘É•ÍÌt€„ôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€ü€½¹Í¥¹•”µ…‘‘É•ÍÌµ•ÉÉ½Èœ(€€€€€€€€€€€€€€€€èÕ¹‘•™¥¹•(€€€€€€€€€€€ô(€€€€€€€€€€¼ø(€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µ…‘‘É•ÍÌt€„ôôÕ¹‘•™¥¹•€˜˜€ (€€€€€€€€€€€€ñ¥•±‘ÉÉ½È¥ô‰½¹Í¥¹•”µ…‘‘É•ÍÌµ•ÉÉ½Èˆø(€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍl½¹Í¥¹•”µ…‘‘É•ÍÌuô(€€€€€€€€€€€€ð½¥•±‘ÉÉ½Èø(€€€€€€€€€€¥ô(€€€€€€€€ð½¥•±ø((€€€€€€€€ñ Èù%Ñ•µÌð½ Èø(€€€€€€€€ñ…Ñ…Q…‰±”ÍÉ½±°±…ÍÍ9…µ”ô‰l™}¥¹ÁÕÑtéÜ´Èàˆø(€€€€€€€€€€ñ…ÁÑ¥½¸±…ÍÍ9…µ”ô‰ÍÈµ½¹±äˆø(€€€€€€€€€€€]½É¬¥Ñ•µÌÝ¥Ñ …Ý…É‘•°‘•±¥Ù•É•°…¹É•µ…¥¹¥¹œÅÕ…¹Ñ¥Ñ¥•Ìì•¹Ñ•È„(€€€€€€€€€€€ÅÕ…¹Ñ¥ÑäÑ¼¥¹±Õ‘”…¸¥Ñ•´½¸Ñ¡¥Ì¡…±±…¸(€€€€€€€€€€ð½…ÁÑ¥½¸ø(€€€€€€€€€€ñÑ¡•…ø(€€€€€€€€€€€€ñÑÈø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù%Ñ•´ð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù•ÍÉ¥ÁÑ¥½¸ð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùU¹¥Ðð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùÝ…É‘•ð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù•±¥Ù•É•ð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùI•µ…¥¹¥¹œð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùQ¡¥Ì¡…±±…¸ð½Ñ ø(€€€€€€€€€€€€€í½™™•ÉÍA½1¥¹•Ì€˜˜€ñÑ Í½Á”ô‰½°ˆù…¥¹ÍÐA<ð½Ñ ùô(€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€ð½Ñ¡•…ø(€€€€€€€€€€ñÑ‰½‘äø(€€€€€€€€€€€í‰…±…¹”¹¥Ñ•µÌ¹µ…À ¡¥Ñ•´¤€ôøì(€€€€€€€€€€€€€½¹ÍÐÅÕ…¹Ñ¥Ñå¥•±€ô¡…±±…¸µÅÕ…¹Ñ¥Ñä´‘í¥Ñ•´¹Ý½É­%Ñ•µ%‘õ€ì(€€€€€€€€€€€€€½¹ÍÐ½Ù•È€ô½Ù•ÉI•µ…¥¹¥¹œ¹¡…Ì¡¥Ñ•´¹Ý½É­%Ñ•µ%¤ì(€€€€€€€€€€€€€É•ÑÕÉ¸€ (€€€€€€€€€€€€€€€€ñÑÈ­•äõí¥Ñ•´¹Ý½É­%Ñ•µ%‘ôø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰É½Üˆùí¥Ñ•´¹¥Ñ•µ9Õµ‰•Éôð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õíÝÉ…Á•±±ôùí¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¹ôð½Ñø(€€€€€€€€€€€€€€€€€€ñÑùí¥Ñ•´¹Õ¹¥Ñ½‘•ôð½Ñø(€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õí¹Õµ•É¥•±±ôø(€€€€€€€€€€€€€€€€€€€í¥Ñ•´¹•™™•Ñ¥Ù•EÕ…¹Ñ¥Ñä€„ôô¹Õ±°€˜˜(€€€€€€€€€€€€€€€€€€€¥Ñ•´¹•™™•Ñ¥Ù•EÕ…¹Ñ¥Ñä€„ôôÕ¹‘•™¥¹•€˜˜(€€€€€€€€€€€€€€€€€€€¥Ñ•´¹•™™•Ñ¥Ù•EÕ…¹Ñ¥Ñä€„ôô¥Ñ•´¹…Ý…É‘•‘EÕ…¹Ñ¥Ñä€ü€ (€€€€€€€€€€€€€€€€€€€€€€¼¼¸…ÁÁÉ½Ù•…µ•¹‘µ•¹Ðµ½Ù•Ñ¡”•¥±¥¹œèÍ¡½Ü‰½Ñ ¸(€€€€€€€€€€€€€€€€€€€€€€ðø(€€€€€€€€€€€€€€€€€€€€€€€€ñÌ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆùí¥Ñ•´¹…Ý…É‘•‘EÕ…¹Ñ¥Ñåôð½Ìùìœ€ô(€€€€€€€€€€€€€€€€€€€€€€€ƒŠHí¥Ñ•´¹•™™•Ñ¥Ù•EÕ…¹Ñ¥Ñåô(€€€€€€€€€€€€€€€€€€€€€€ð¼ø(€€€€€€€€€€€€€€€€€€€€¤€è€ (€€€€€€€€€€€€€€€€€€€€€¥Ñ•´¹…Ý…É‘•‘EÕ…¹Ñ¥Ñä(€€€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õí¹Õµ•É¥•±±ôùí¥Ñ•´¹‘•±¥Ù•É•‘EÕ…¹Ñ¥Ñåôð½Ñø(€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õí¹Õµ•É¥•±±ôùí¥Ñ•´¹É•µ…¥¹¥¹EÕ…¹Ñ¥Ñåôð½Ñø(€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õíEÕ…¹Ñ¥Ñä½˜€‘í¥Ñ•´¹¥Ñ•µ9Õµ‰•Éô½¸Ñ¡¥Ì¡…±±…¹ô(€€€€€€€€€€€€€€€€€€€€€¥¹ÁÕÑ5½‘”ô‰‘•¥µ…°ˆ(€€€€€€€€€€€€€€€€€€€€€É•˜õì¡¹½‘”¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€É•¥ÍÑ•É¥•±¡ÅÕ…¹Ñ¥Ñå¥•±°¹½‘”¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õíÍÑ…Ñ”¹ÅÕ…¹Ñ¥Ñ¥•Ím¥Ñ•´¹Ý½É­%Ñ•µ%‘t€üü€œô(€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€¼¼ÍÑ…±”½Ù•Èµ‘•±¥Ù•Éä™±…œµÕÍÐ¹½ÐÍÕÉÙ¥Ù”Ñ¡”(€€€€€€€€€€€€€€€€€€€€€€€€¼¼•‘¥ÐÑ¡…Ðµ…ä‰”±•…É¥¹œ¥ÐìÑ¡”¹•áÐ‰±ÕÈ‘•¥‘•Ì(€€€€€€€€€€€€€€€€€€€€€€€€¼¼……¥¸¸(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ=Ù•ÉI•µ…¥¹¥¹œ ¡ÁÉ•Ù¥½ÕÌ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€¥˜€ …ÁÉ•Ù¥½ÕÌ¹¡…Ì¡¥Ñ•´¹Ý½É­%Ñ•µ%¤¤É•ÑÕÉ¸ÁÉ•Ù¥½ÕÌì(€€€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ¹•áÐ€ô¹•ÜM•Ð¡ÁÉ•Ù¥½ÕÌ¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€¹•áÐ¹‘•±•Ñ”¡¥Ñ•´¹Ý½É­%Ñ•µ%¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÑÕÉ¸¹•áÐì(€€€€€€€€€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€Í•ÑMÑ…Ñ”¡ì(€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¹ÍÑ…Ñ”°(€€€€€€€€€€€€€€€€€€€€€€€€€ÅÕ…¹Ñ¥Ñ¥•Ìèì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¹ÍÑ…Ñ”¹ÅÕ…¹Ñ¥Ñ¥•Ì°(€€€€€€€€€€€€€€€€€€€€€€€€€€€m¥Ñ•´¹Ý½É­%Ñ•µ%‘tè•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”°(€€€€€€€€€€€€€€€€€€€€€€€€€ô°(€€€€€€€€€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€½¹	±ÕÈõì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€¼¼Õ¥‘…¹”½¹±ä°…¹½¹±äÝ¡•É”…¸•á•ÍÌÝ½Õ±(€€€€€€€€€€€€€€€€€€€€€€€€¼¼…ÑÕ…±±ä‰”É•™ÕÍ•èÑ¡”‘É…™ÐÍÑ…åÌÍ…Ù•…‰±”°…¹(€€€€€€€€€€€€€€€€€€€€€€€€¼¼Ñ¡”Í•ÉÙ•È‘½•ÌÑ¡”…ÕÑ¡½É¥Ñ…Ñ¥Ù”½µÁ…É¥Í½¸Ý¡•¸(€€€€€€€€€€€€€€€€€€€€€€€€¼¼Ñ¡”¡…±±…¸¥Ì¥ÍÍÕ•¸(€€€€€€€€€€€€€€€€€€€€€€€¥˜€¡‰…±…¹”¹…±±½Ýá•ÍÍ•±¥Ù•Éä¤É•ÑÕÉ¸ì(€€€€€€€€€€€€€€€€€€€€€€€¡•­I•µ…¥¹¥¹œ¡¥Ñ•´¹Ý½É­%Ñ•µ%°¥Ñ•´¹É•µ…¥¹¥¹EÕ…¹Ñ¥Ñä¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€…É¥„µ¥¹Ù…±¥õí™¥•±‘ÉÉ½ÉÍmÅÕ…¹Ñ¥Ñå¥•±‘t€„ôôÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äõí‘•ÍÉ¥‰•‘	ä (€€€€€€€€€€€€€€€€€€€€€€€™¥•±‘ÉÉ½ÉÍmÅÕ…¹Ñ¥Ñå¥•±‘t€„ôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€€€€€€€€€€€ü€‘íÅÕ…¹Ñ¥Ñå¥•±‘ôµ•ÉÉ½É€(€€€€€€€€€€€€€€€€€€€€€€€€€€èÕ¹‘•™¥¹•°(€€€€€€€€€€€€€€€€€€€€€€€½Ù•È€ü€‘íÅÕ…¹Ñ¥Ñå¥•±‘ôµ½Ù•É€€èÕ¹‘•™¥¹•°(€€€€€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍmÅÕ…¹Ñ¥Ñå¥•±‘t€„ôôÕ¹‘•™¥¹•€˜˜€ (€€€€€€€€€€€€€€€€€€€€€€ñ¥•±‘ÉÉ½È¥õí€‘íÅÕ…¹Ñ¥Ñå¥•±‘ôµ•ÉÉ½Éôø(€€€€€€€€€€€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍmÅÕ…¹Ñ¥Ñå¥•±‘uô(€€€€€€€€€€€€€€€€€€€€€€ð½¥•±‘ÉÉ½Èø(€€€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€€€€í½Ù•È€˜˜€ (€€€€€€€€€€€€€€€€€€€€€€ñMÑ…ÑÕÍ¡¥ÀÍÑ…ÑÕÌô‰É•Ù¥•Üˆ¥õí€‘íÅÕ…¹Ñ¥Ñå¥•±‘ôµ½Ù•Éôø(€€€€€€€€€€€€€€€€€€€€€€€½Ù•ÈÑ¡”í¥Ñ•´¹É•µ…¥¹¥¹EÕ…¹Ñ¥ÑåôÉ•µ…¥¹¥¹œ(€€€€€€€€€€€€€€€€€€€€€€ð½MÑ…ÑÕÍ¡¥Àø(€€€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€í½™™•ÉÍA½1¥¹•Ì€˜˜€ (€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€ì¡Á½1¥¹•¡½¥•Ì¹•Ð¡¥Ñ•´¹Ý½É­%Ñ•µ%¤€üümt¤¹±•¹Ñ €ø€À€ü€ (€€€€€€€€€€€€€€€€€€€€€€€€ñÍ•±•Ð(€€€€€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õíAÕÉ¡…Í”½É‘•È±¥¹”™½È€‘í¥Ñ•´¹¥Ñ•µ9Õµ‰•Éõô(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õíÍÑ…Ñ”¹Á½1¥¹•Ím¥Ñ•´¹Ý½É­%Ñ•µ%‘t€üü€œô(€€€€€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€Í•ÑMÑ…Ñ”¡ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¹ÍÑ…Ñ”°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Á½1¥¹•Ìèì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¹ÍÑ…Ñ”¹Á½1¥¹•Ì°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€m¥Ñ•´¹Ý½É­%Ñ•µ%‘tè•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”°(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ô°(€€€€€€€€€€€€€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ôˆˆù9¼ÁÕÉ¡…Í”½É‘•Èð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€ì¡Á½1¥¹•¡½¥•Ì¹•Ð¡¥Ñ•´¹Ý½É­%Ñ•µ%¤€üümt¤¹µ…À ¡¡½¥”¤€ôø€ (€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸­•äõí¡½¥”¹¥‘ôÙ…±Õ”õí¡½¥”¹¥‘ôø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€í¡½¥”¹Á½9Õµ‰•Éôƒ
Üí¡½¥”¹Á•¹‘¥¹EÕ…¹Ñ¥ÑåôÁ•¹‘¥¹œ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€€¤¥ô(€€€€€€€€€€€€€€€€€€€€€€€€ð½Í•±•Ðø(€€€€€€€€€€€€€€€€€€€€€€¤€è€ (€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆûŠPð½ÍÁ…¸ø(€€€€€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€ô¥ô(€€€€€€€€€€ð½Ñ‰½‘äø(€€€€€€€€ð½…Ñ…Q…‰±”ø((€€€€€€€íÍ…Ù•ÉÉ½È€„ôô¹Õ±°€˜˜€ñ½ÉµÉÉ½ÈùíÍ…Ù•ÉÉ½Éôð½½ÉµÉÉ½Èùô((€€€€€€€€ñÑ¥½¹	…È±…ÍÍ9…µ”ô‰™±•àµÝÉ…Àˆø(€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥Ðˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€íÁ•¹‘¥¹œ€ü€M…Ù¥¹ŸŠ˜œ€è€M…Ù”‘É…™Ðô(€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€É•˜õí…¹•±I•™ô(€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€¥˜€¡•‘¥Ñ•¤ì(€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹¥Í…É¡ÑÉÕ”¤ì(€€€€€€€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€€€€€ô(€€€€€€€€€€€€€½¹…¹•° ¤ì(€€€€€€€€€€€õô(€€€€€€€€€€ø(€€€€€€€€€€€…¹•°(€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€ð½Ñ¥½¹	…Èø((€€€€€€€í½¹™¥Éµ¥¹¥Í…É€˜˜€ (€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰µä´ÌÉ½Õ¹‘•µ±œ‰½É‘•È‰½É‘•ÈµÝ…É¹¥¹œ¼ÐÀ‰œµ…•¹ÐÁà´ÐÁä´Ìˆø(€€€€€€€€€€€€ñ Èù¥Í…Éå½ÕÈ¡…¹•Ìüð½ Èø(€€€€€€€€€€€€ñÀø(€€€€€€€€€€€€€9½Ñ¡¥¹œ•¹Ñ•É•¡•É”¡…Ì‰••¸Í…Ù•å•Ð¸1•…Ù¥¹œ¹½ÜÑ¡É½ÝÌ…Ý…äÑ¡”(€€€€€€€€€€€€€½¹Í¥¹•”‘•Ñ…¥±Ì…¹•Ù•ÉäÅÕ…¹Ñ¥Ñäå½ÔÑåÁ•¸(€€€€€€€€€€€€ð½Àø(€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸É•˜õí‘¥Í…É‘I•™ô½¹±¥¬õí½¹…¹•±ôø(€€€€€€€€€€€€€€€¥Í…É…¹±•…Ù”(€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€Í•Ñ½¹™¥Éµ¥¹¥Í…É¡™…±Í”¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€-••À•‘¥Ñ¥¹œ(€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€ð½‘¥Øø(€€€€€€€€¥ô(€€€€€€ð½™½É´ø(€€€€ð½…Éø(€€¤ì)ô(