import { useEffect, useState } from 'react';
import type {
  ProductionItem,
  PurchaseOrderDetailResponse,
  PurchaseOrderLineInput,
  WorkItem,
} from '@auto-mb/contracts';
import type { ApiClient } from '../api.js';
import { formatInr, formatRate } from '../format.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, Actions, Hint } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';

/**
 * One purchase order, opened: its facts, its lines, and the transitions
 * its state admits.
 *
 * EXTRACTED WHEN THERE WERE TWO CALLERS AND NOT BEFORE. This was the
 * second half of `WorkPurchaseOrders.tsx` until migration 0109 gave the
 * organisation register orders of its own to open — orders with no Work,
 * and therefore no Work page to open them on. The two callers differ in
 * exactly one thing, which is the list this panel offers a line: a Work's
 * order may buy the Work's awarded items, an order outside any LOA may
 * not, and either may buy a stock part.
 *
 * THE ITEM SELECT IS THE RECEIPT CHANNEL. A line that names a Work item
 * arrives on a delivery challan; a line that names a stock part arrives
 * as a movement onto the shelf; a line that names neither is free text on
 * whichever channel its order has. One control, because a line takes
 * exactly one of them and two controls would let an operator ask for
 * both — which the server refuses, correctly and too late to be useful.
 */

/** A line under edit. `itemRef` is the single select's value: `w:<id>` for
 * an awarded item, `p:<id>` for a stock part, empty for free text. */
interface LineDraft {
  readonly itemRef: string;
  readonly description: string;
  readonly unitCode: string;
  readonly quantity: string;
  readonly rate: string;
}

const EMPTY_LINE: LineDraft = {
  itemRef: '',
  description: '',
  unitCode: '',
  quantity: '',
  rate: '',
};

function itemRefOf(line: {
  readonly workItemId: string | null;
  readonly productionItemId: string | null;
}): string {
  if (line.workItemId !== null) return `w:${line.workItemId}`;
  if (line.productionItemId !== null) return `p:${line.productionItemId}`;
  return '';
}

function lineInputOf(line: LineDraft): PurchaseOrderLineInput {
  const link = line.itemRef.startsWith('w:')
    ? { workItemId: line.itemRef.slice(2) }
    : line.itemRef.startsWith('p:')
      ? { productionItemId: line.itemRef.slice(2) }
      : {};
  return {
    ...link,
    description: line.description,
    unitCode: line.unitCode,
    quantity: line.quantity,
    rate: line.rate,
  };
}

export interface PurchaseOrderPanelProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly detail: PurchaseOrderDetailResponse;
  readonly setDetail: (detail: PurchaseOrderDetailResponse | null) => void;
  /** The Work's schedule, or empty on an order with no Work. */
  readonly workItems: readonly WorkItem[];
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
  /** The caller's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
  /** Re-reads whichever list the caller is showing. */
  readonly onChanged: () => Promise<void>;
}

export function PurchaseOrderPanel({
  api,
  organisationId,
  detail,
  setDetail,
  workItems,
  canModify,
  canIssue,
  canCancel,
  pending,
  act,
  onChanged,
}: PurchaseOrderPanelProps) {
  const order = detail.purchaseOrder;
  const [lines, setLines] = useState<readonly LineDraft[]>(() => editableLines(detail));
  const [parts, setParts] = useState<readonly ProductionItem[]>([]);
  const [cancelNote, setCancelNote] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /* The editor is re-seeded when a different order is opened into the
     same panel, in render rather than in an effect so the table never
     paints one order's lines under another order's heading. */
  const [seededId, setSeededId] = useState(order.id);
  if (seededId !== order.id) {
    setSeededId(order.id);
    setLines(editableLines(detail));
    setCancelNote('');
    setConfirmingDelete(false);
  }

  useEffect(() => {
    let cancelled = false;
    // The parts picker is a convenience, exactly as the vendor picker is:
    // an unavailable item master must not block reading the order.
    api
      .listProductionItems(organisationId)
      .then((response) => {
        if (!cancelled) setParts(response.items.filter((item) => item.active));
      })
      .catch(() => {
        // The stock channel is simply not offered.
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  function editableLines(loaded: PurchaseOrderDetailResponse): readonly LineDraft[] {
    if (loaded.purchaseOrder.status !== 'draft') return [];
    if (loaded.lines.length === 0) return [EMPTY_LINE];
    return loaded.lines.map((line) => ({
      itemRef: itemRefOf(line),
      description: line.description,
      unitCode: line.unitCode,
      quantity: line.quantity,
      rate: line.rate,
    }));
  }

  const itemNumberById = new Map(workItems.map((item) => [item.id, item.itemNumber]));
  const partCodeById = new Map(parts.map((item) => [item.id, item.itemCode]));

  return (
    <div className="my-3">
      <h3>
        Purchase order {order.poNumber ?? 'draft'} · {order.poDate}{' '}
        <StatusChip status={order.status} />
      </h3>
      <p className="text-muted-foreground">
        Vendor: {order.vendorDesignation}
        {order.workCode !== null && ` · against ${order.workCode}`}
        {order.workId === null && ' · outside any LOA'}
        {order.expectedOn !== null && ` · expected by ${order.expectedOn}`}
      </p>
      {order.terms !== null && (
        <p className="text-muted-foreground">Terms: {order.terms}</p>
      )}
      {order.status === 'cancelled' && order.cancellationNote !== null && (
        <p className="text-muted-foreground">Cancelled: {order.cancellationNote}</p>
      )}

      {/* Deliberately not behind a Disclosure: this is the draft's
          editor, reached by asking for the draft by name, and it
          disappears the moment the order is issued into a record. */}
      {order.status === 'draft' && canModify ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const body = { lines: lines.map(lineInputOf) };
            void act(async () => {
              const updated = await api.savePurchaseOrderLines(
                organisationId,
                order.id,
                body,
              );
              setDetail(updated);
              setLines(editableLines(updated));
            }, 'Lines saved; the draft total recomputed below.');
          }}
        >
          <DataTable scroll className="[&_input]:w-28 [&_select]:max-w-56">
            <caption className="sr-only">
              Draft purchase order lines: pick a Work item or a stock part, or leave the
              line as free text
            </caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Description</th>
                <th scope="col">Unit</th>
                <th scope="col">Quantity</th>
                <th scope="col">Rate (₹)</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const lineLabel = `Line ${String(index + 1)}`;
                return (
                  // Index keys are safe here: rows reorder only by
                  // removal, and every cell is a controlled input.
                  <tr key={index}>
                    <td>
                      <select
                        aria-label={`${lineLabel} item`}
                        value={line.itemRef}
                        onChange={(event) => {
                          const itemRef = event.target.value;
                          const workItem = workItems.find(
                            (candidate) => `w:${candidate.id}` === itemRef,
                          );
                          const part = parts.find(
                            (candidate) => `p:${candidate.id}` === itemRef,
                          );
                          setLines((current) =>
                            current.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? {
                                    ...candidate,
                                    itemRef,
                                    // Picking an item prefills the text
                                    // it describes; both stay editable.
                                    ...(workItem !== undefined
                                      ? {
                                          description: workItem.description,
                                          unitCode: workItem.unitCode,
                                        }
                                      : {}),
                                    ...(part !== undefined
                                      ? {
                                          description: part.name,
                                          unitCode: part.unit,
                                        }
                                      : {}),
                                  }
                                : candidate,
                            ),
                          );
                        }}
                      >
                        <option value="">Free text</option>
                        {workItems.length > 0 && (
                          <optgroup label="Work items — arrive on a delivery challan">
                            {workItems.map((item) => (
                              <option key={item.id} value={`w:${item.id}`}>
                                {item.itemNumber} — {item.description}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {parts.length > 0 && (
                          <optgroup label="Stock parts — arrive on the shelf">
                            {parts.map((item) => (
                              <option key={item.id} value={`p:${item.id}`}>
                                {item.itemCode} — {item.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={`${lineLabel} description`}
                        className="w-56!"
                        value={line.description}
                        required
                        minLength={3}
                        maxLength={1000}
                        onChange={(event) => {
                          const description = event.target.value;
                          setLines((current) =>
                            current.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, description }
                                : candidate,
                            ),
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${lineLabel} unit`}
                        className="w-20!"
                        value={line.unitCode}
                        required
                        maxLength={20}
                        onChange={(event) => {
                          const unitCode = event.target.value;
                          setLines((current) =>
                            current.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, unitCode }
                                : candidate,
                            ),
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${lineLabel} quantity`}
                        inputMode="decimal"
                        value={line.quantity}
                        required
                        onChange={(event) => {
                          const quantity = event.target.value;
                          setLines((current) =>
                            current.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, quantity }
                                : candidate,
                            ),
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${lineLabel} rate`}
                        inputMode="decimal"
                        value={line.rate}
                        required
                        onChange={(event) => {
                          const rate = event.target.value;
                          setLines((current) =>
                            current.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, rate }
                                : candidate,
                            ),
                          );
                        }}
                      />
                    </td>
                    <td>
                      {lines.length > 1 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setLines((current) =>
                              current.filter(
                                (_candidate, candidateIndex) =>
                                  candidateIndex !== index,
                              ),
                            );
                          }}
                        >
                          Remove {lineLabel.toLowerCase()}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <p>
            Draft total so far: <strong>{formatInr(detail.previewTotal)}</strong>{' '}
            <span className="text-muted-foreground">
              (computed server-side from the saved lines)
            </span>
          </p>
          <Actions>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setLines((current) => [...current, EMPTY_LINE]);
              }}
            >
              Add line
            </Button>
            <Button type="submit" disabled={pending}>
              Save lines
            </Button>
          </Actions>
        </form>
      ) : (
        detail.lines.length > 0 && (
          <DataTable scroll>
            <caption className="sr-only">
              Purchase order lines with their received and pending balances
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Description</th>
                <th scope="col">Item</th>
                <th scope="col">Unit</th>
                <th scope="col" className={numericCell}>
                  Ordered
                </th>
                <th scope="col" className={numericCell}>
                  Received
                </th>
                <th scope="col" className={numericCell}>
                  Pending
                </th>
                <th scope="col" className={numericCell}>
                  Rate
                </th>
                <th scope="col" className={numericCell}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.id}>
                  <th scope="row">{line.lineNumber}</th>
                  <td className={wrapCell}>{line.description}</td>
                  <td>
                    {line.workItemId !== null
                      ? (itemNumberById.get(line.workItemId) ?? '—')
                      : line.productionItemId !== null
                        ? (partCodeById.get(line.productionItemId) ?? 'stock part')
                        : 'free text'}
                  </td>
                  <td>{line.unitCode}</td>
                  <td className={numericCell}>{line.quantity}</td>
                  <td className={numericCell}>{line.receivedQuantity ?? '—'}</td>
                  <td className={numericCell}>{line.pendingQuantity ?? '—'}</td>
                  <td className={numericCell}>{formatRate(line.rate)}</td>
                  <td className={numericCell}>{formatInr(line.lineAmount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={8}>
                  Order total
                </th>
                <td className={numericCell}>
                  <strong>{formatInr(order.totalAmount ?? detail.previewTotal)}</strong>
                </td>
              </tr>
            </tfoot>
          </DataTable>
        )
      )}

      <Actions>
        {order.status === 'draft' && canIssue && (
          <Button
            disabled={pending}
            onClick={() => {
              void act(async () => {
                const issued = await api.issuePurchaseOrder(organisationId, order.id);
                setDetail(issued);
                setLines([]);
                await onChanged();
              }, 'Purchase order issued — its number and total are now frozen.');
            }}
          >
            Issue purchase order
          </Button>
        )}
        {order.status === 'draft' && canModify && (
          <Button
            variant="outline"
            disabled={pending}
            aria-haspopup="dialog"
            onClick={() => {
              setConfirmingDelete(true);
            }}
          >
            Delete draft…
          </Button>
        )}
        {order.status === 'issued' && canModify && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              void act(async () => {
                const closed = await api.closePurchaseOrder(organisationId, order.id);
                setDetail(closed);
                await onChanged();
              }, 'Purchase order closed — every line is received and the vendor’s tax invoice is on file.');
            }}
          >
            Close purchase order
          </Button>
        )}
      </Actions>
      {order.status === 'issued' && canModify && (
        <Hint>
          Closing needs both: every line received, and at least one of this
          vendor&rsquo;s tax invoices recorded against this order with its PDF uploaded,
          on the Payments screen&rsquo;s Vendors tab.
        </Hint>
      )}

      {order.status === 'draft' && canModify && confirmingDelete && (
        <ConfirmDialog
          title="Confirm delete"
          description="Deleting discards this draft and its lines for good. A draft carries no number, so nothing is retained. Continue?"
          cancelLabel="Keep drafting"
          confirmLabel="Delete draft now"
          pending={pending}
          onCancel={() => {
            setConfirmingDelete(false);
          }}
          onConfirm={() => {
            void act(async () => {
              await api.deletePurchaseOrder(organisationId, order.id);
              setDetail(null);
              setConfirmingDelete(false);
              await onChanged();
            }, 'Draft purchase order deleted.');
          }}
        />
      )}

      {order.status === 'issued' && canCancel && (
        <Disclosure label="Cancel purchase order…">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const cancelled = await api.cancelPurchaseOrder(
                  organisationId,
                  order.id,
                  { note: cancelNote.trim() },
                );
                setDetail(cancelled);
                setCancelNote('');
                await onChanged();
              }, 'Purchase order cancelled; its number is retained forever.');
            }}
          >
            <Field>
              <label htmlFor="po-cancel-note">Cancellation note</label>
              <input
                id="po-cancel-note"
                value={cancelNote}
                onChange={(event) => {
                  setCancelNote(event.target.value);
                }}
                required
                minLength={3}
                maxLength={2000}
              />
              <Hint>
                Receipts already recorded against the order stay untouched; cancelling
                says only that the rest of it is never coming.
              </Hint>
            </Field>
            <Actions>
              <Button type="submit" variant="outline" disabled={pending}>
                Cancel purchase order
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
    </div>
  );
}
