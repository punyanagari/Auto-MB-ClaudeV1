import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
  Contact,
  PurchaseOrder,
  PurchaseOrderDetailResponse,
  PurchaseOrderLineInput,
  WorkItem,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatInr, formatRate } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, FieldRow, Actions, Hint } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';

interface WorkPurchaseOrdersProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workItems: readonly WorkItem[];
  /** Null while the list is still loading — distinct from "none yet". */
  readonly purchaseOrders: readonly PurchaseOrder[] | null;
  readonly setPurchaseOrders: Dispatch<SetStateAction<readonly PurchaseOrder[] | null>>;
  /** Writer-role actions the server accepts on any operable order: the
   * draft's lines, deleting the draft, closing a fully received order. */
  readonly canModify: boolean;
  /** Creating a draft additionally requires the Work to be active. */
  readonly canCreateDocuments: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly pending: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
}

/** A line under edit. An empty item id buys a consumable the LOA never
 * named — the description then stands entirely on its own. */
interface LineDraft {
  readonly workItemId: string;
  readonly description: string;
  readonly unitCode: string;
  readonly quantity: string;
  readonly rate: string;
}

const EMPTY_LINE: LineDraft = {
  workItemId: '',
  description: '',
  unitCode: '',
  quantity: '',
  rate: '',
};

/** What the contractor buys IN to supply this Work: purchase orders on
 * vendor contacts, draft -> issued (numbered, total frozen) -> closed
 * once every line is received against issued delivery challans, or
 * cancelled with a note. The received/pending balance per line is
 * recomputed by the server from live challan rows on every read. */
export function WorkPurchaseOrders({
  api,
  organisationId,
  workId,
  workItems,
  purchaseOrders,
  setPurchaseOrders,
  canModify,
  canCreateDocuments,
  canIssue,
  canCancel,
  pending,
  act,
}: WorkPurchaseOrdersProps) {
  const [vendors, setVendors] = useState<readonly Contact[]>([]);
  const [detail, setDetail] = useState<PurchaseOrderDetailResponse | null>(null);
  const [lines, setLines] = useState<readonly LineDraft[]>([]);
  const [cancelNote, setCancelNote] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The picker is a convenience: an unavailable contact master must not
    // block reading the orders that already exist.
    api
      .listContacts(organisationId)
      .then((contacts) => {
        if (!cancelled) {
          setVendors(contacts.filter((contact) => contact.isVendor));
        }
      })
      .catch(() => {
        // The create form simply is not offered without vendors.
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  async function refreshList() {
    setPurchaseOrders(await api.listWorkPurchaseOrders(organisationId, workId));
  }

  /** Draft lines in edit shape, or one empty row so a fresh draft has a
   * line to type into. */
  function editableLines(loaded: PurchaseOrderDetailResponse): readonly LineDraft[] {
    if (loaded.purchaseOrder.status !== 'draft') return [];
    if (loaded.lines.length === 0) return [EMPTY_LINE];
    return loaded.lines.map((line) => ({
      workItemId: line.workItemId ?? '',
      description: line.description,
      unitCode: line.unitCode,
      quantity: line.quantity,
      rate: line.rate,
    }));
  }

  function openOrder(purchaseOrderId: string, label: string) {
    void act(async () => {
      const loaded = await api.getPurchaseOrder(organisationId, purchaseOrderId);
      setDetail(loaded);
      setLines(editableLines(loaded));
      setCancelNote('');
      setConfirmingDelete(false);
    }, `Purchase order ${label} opened below.`);
  }

  if (purchaseOrders === null) {
    return (
      <>
        <h2>Purchase Orders</h2>
        <p className="text-muted-foreground" role="status">
          Loading purchase orders…
        </p>
      </>
    );
  }

  const order = detail?.purchaseOrder ?? null;
  const hasDraft = purchaseOrders.some((candidate) => candidate.status === 'draft');
  const itemNumberById = new Map(workItems.map((item) => [item.id, item.itemNumber]));

  return (
    <>
      <h2>Purchase Orders</h2>
      <p className="text-muted-foreground">
        What is bought in to supply this Work. A draft takes lines against the
        Work&apos;s items or free-text consumables; issuing assigns the next gap-free PO
        number and freezes the vendor and total; the order closes once every line has
        been received against issued Delivery Challans.
      </p>

      {purchaseOrders.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Purchase orders placed for this Work</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Vendor</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col" className={numericCell}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {purchaseOrders.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <Button
                    variant="link"
                    size="inline"
                    className="font-medium"
                    onClick={() => {
                      openOrder(row.id, row.poNumber ?? 'draft');
                    }}
                  >
                    {row.poNumber ?? 'Draft'}
                  </Button>
                </th>
                <td className={wrapCell}>{row.vendorDesignation}</td>
                <td>{row.poDate}</td>
                <td>
                  <StatusChip status={row.status} />
                </td>
                <td className={numericCell}>
                  {row.totalAmount !== null ? formatInr(row.totalAmount) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">No purchase orders yet.</p>
      )}

      {canCreateDocuments &&
        !hasDraft &&
        (vendors.length > 0 ? (
          <Disclosure
            label="Create purchase order"
            startOpen={purchaseOrders.length === 0}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const vendorContactId = formValue(data, 'po-vendor');
                const poDate = formValue(data, 'po-date');
                const expectedOn = formValue(data, 'po-expected');
                const terms = formValue(data, 'po-terms').trim();
                void act(async () => {
                  const created = await api.createWorkPurchaseOrder(
                    organisationId,
                    workId,
                    {
                      vendorContactId,
                      poDate,
                      ...(expectedOn.length > 0 ? { expectedOn } : {}),
                      ...(terms.length > 0 ? { terms } : {}),
                    },
                  );
                  setDetail(created);
                  setLines(editableLines(created));
                  setCancelNote('');
                  setConfirmingDelete(false);
                  await refreshList();
                  form.reset();
                }, 'Draft purchase order created — add its lines below.');
              }}
            >
              <Field>
                <label htmlFor="po-vendor">Vendor</label>
                <select id="po-vendor" name="po-vendor" required defaultValue="">
                  <option value="" disabled>
                    Pick a vendor contact
                  </option>
                  {vendors.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>
                      {vendor.designation}
                      {vendor.address !== null ? ` — ${vendor.address}` : ''}
                    </option>
                  ))}
                </select>
                <Hint>
                  The vendor is snapshotted onto the order at issue; later contact edits
                  never rewrite the document.
                </Hint>
              </Field>
              <FieldRow>
                <Field>
                  <label htmlFor="po-date">PO date</label>
                  <input id="po-date" name="po-date" type="date" required />
                </Field>
                <Field>
                  <label htmlFor="po-expected">Expected by (optional)</label>
                  <input id="po-expected" name="po-expected" type="date" />
                </Field>
              </FieldRow>
              <Field>
                <label htmlFor="po-terms">Terms (optional)</label>
                <textarea
                  id="po-terms"
                  name="po-terms"
                  minLength={3}
                  maxLength={4000}
                  rows={2}
                />
              </Field>
              <Actions>
                <Button type="submit" disabled={pending}>
                  Create purchase order
                </Button>
              </Actions>
            </form>
          </Disclosure>
        ) : (
          <p className="text-muted-foreground">
            Purchase orders are placed on vendor contacts. Add a contact carrying the
            vendor role under Masters first.
          </p>
        ))}

      {detail !== null && order !== null && (
        <div className="my-3">
          <h3>
            Purchase order {order.poNumber ?? 'draft'} · {order.poDate}{' '}
            <StatusChip status={order.status} />
          </h3>
          <p className="text-muted-foreground">
            Vendor: {order.vendorDesignation}
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
                const body = {
                  lines: lines.map((line): PurchaseOrderLineInput => ({
                    ...(line.workItemId.length > 0
                      ? { workItemId: line.workItemId }
                      : {}),
                    description: line.description,
                    unitCode: line.unitCode,
                    quantity: line.quantity,
                    rate: line.rate,
                  })),
                };
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
                  Draft purchase order lines: pick a Work item or leave the line as a
                  free-text consumable
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
                            value={line.workItemId}
                            onChange={(event) => {
                              const chosenId = event.target.value;
                              const item = workItems.find(
                                (candidate) => candidate.id === chosenId,
                              );
                              setLines((current) =>
                                current.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? {
                                        ...candidate,
                                        workItemId: chosenId,
                                        // Picking an item prefills the text
                                        // it describes; both stay editable.
                                        ...(item !== undefined
                                          ? {
                                              description: item.description,
                                              unitCode: item.unitCode,
                                            }
                                          : {}),
                                      }
                                    : candidate,
                                ),
                              );
                            }}
                          >
                            <option value="">Consumable (free text)</option>
                            {workItems.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.itemNumber} — {item.description}
                              </option>
                            ))}
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
                        {line.workItemId === null
                          ? 'consumable'
                          : (itemNumberById.get(line.workItemId) ?? '—')}
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
                      <strong>
                        {formatInr(order.totalAmount ?? detail.previewTotal)}
                      </strong>
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
                    const issued = await api.issuePurchaseOrder(
                      organisationId,
                      order.id,
                    );
                    setDetail(issued);
                    setLines([]);
                    await refreshList();
                  }, 'Purchase order issued — its number and total are now frozen.');
                }}
              >
                Issue purchase order
              </Button>
            )}
            {order.status === 'draft' && canModify && !confirmingDelete && (
              <Button
                variant="outline"
                disabled={pending}
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
                    const closed = await api.closePurchaseOrder(
                      organisationId,
                      order.id,
                    );
                    setDetail(closed);
                    await refreshList();
                  }, 'Purchase order closed — every line is fully received.');
                }}
              >
                Close purchase order
              </Button>
            )}
          </Actions>

          {order.status === 'draft' && canModify && confirmingDelete && (
            <div className="my-3">
              <h4>Confirm delete</h4>
              <p>
                Deleting discards this draft and its lines for good. A draft carries no
                number, so nothing is retained. Continue?
              </p>
              <Actions>
                <Button
                  disabled={pending}
                  onClick={() => {
                    void act(async () => {
                      await api.deletePurchaseOrder(organisationId, order.id);
                      setDetail(null);
                      setConfirmingDelete(false);
                      await refreshList();
                    }, 'Draft purchase order deleted.');
                  }}
                >
                  Delete draft now
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setConfirmingDelete(false);
                  }}
                >
                  Keep drafting
                </Button>
              </Actions>
            </div>
          )}

          {order.status === 'issued' && canCancel && (
            <Disclosure label="Cancel purchase order">
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
                    await refreshList();
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
                    Receipts already recorded against the order stay untouched;
                    cancelling says only that the rest of it is never coming.
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
      )}
    </>
  );
}
