import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
  Contact,
  PurchaseOrder,
  PurchaseOrderDetailResponse,
  WorkItem,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
// `formatRate` left with the read-only lines table when that half of this
// view became the shared `PurchaseOrderPanel`; `todayIso` stays, because
// the create form is still here.
import { formatInr, todayIso } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, FieldRow, Actions, Hint } from '../ui/form.js';
import { LoadingState } from '../ui/state.js';
import { Disclosure } from '../ui/disclosure.js';
import { PurchaseOrderPanel } from './purchase-order-panel.js';

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

  function openOrder(purchaseOrderId: string, label: string) {
    void act(async () => {
      setDetail(await api.getPurchaseOrder(organisationId, purchaseOrderId));
    }, `Purchase order ${label} opened below.`);
  }

  if (purchaseOrders === null) {
    return (
      <>
        <h2>Purchase Orders</h2>
        {/* The list is loaded by WorkDetail, which owns its failure state
            and its retry; this branch only covers the wait. */}
        <LoadingState label="the purchase orders" rows={3} columns={4} />
      </>
    );
  }

  const draftVendorIds = new Set(
    purchaseOrders
      .filter((candidate) => candidate.status === 'draft')
      .map((candidate) => candidate.vendorContactId),
  );
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
        (vendors.length > 0 ? (
          <Disclosure
            label="New purchase order"
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
                    <option
                      key={vendor.id}
                      value={vendor.id}
                      disabled={draftVendorIds.has(vendor.id)}
                    >
                      {vendor.designation}
                      {vendor.address !== null ? ` — ${vendor.address}` : ''}
                      {draftVendorIds.has(vendor.id) ? ' — draft already open' : ''}
                    </option>
                  ))}
                </select>
                <Hint>
                  One draft may remain open per vendor on this Work. The vendor is
                  snapshotted at issue; later contact edits never rewrite the document.
                </Hint>
              </Field>
              <FieldRow>
                <Field>
                  <label htmlFor="po-date">PO date</label>
                  <input
                    id="po-date"
                    name="po-date"
                    type="date"
                    required
                    defaultValue={todayIso()}
                  />
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

      {detail !== null && (
        <PurchaseOrderPanel
          api={api}
          organisationId={organisationId}
          detail={detail}
          setDetail={setDetail}
          workItems={workItems}
          canModify={canModify}
          canIssue={canIssue}
          canCancel={canCancel}
          pending={pending}
          act={act}
          onChanged={refreshList}
        />
      )}
    </>
  );
}
