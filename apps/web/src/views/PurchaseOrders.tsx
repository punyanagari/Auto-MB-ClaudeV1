import { useCallback, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type {
  Contact,
  PurchaseOrder,
  PurchaseOrderDetailResponse,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { formatInr } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Disclosure } from '../ui/disclosure.js';
import { Field, FieldRow, Actions, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { TabRail } from '../ui/tab-rail.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { PurchaseOrderPanel } from './purchase-order-panel.js';

/**
 * The purchase-order register — every order this organisation has placed,
 * across Works and outside them.
 *
 * PORTED FROM THE MOCK'S OWN PAGE (`app/purchase-orders/page.tsx` at
 * fdfd610): a page header with a single primary action, a two-tab split by
 * what the order is AGAINST, and one dense table under it. The mock's tabs
 * are "Against LOA / Work" and "Private customers"; this application has
 * no private-customer order, and the second axis it does have is the one
 * migration 0109 created — an order raised outside any LOA. The tab keeps
 * the mock's place, its count and its grammar, and says what this
 * application's second kind actually is (`docs/UX.md` § 28).
 *
 * READING, PLUS THE ONE THING THAT HAS NOWHERE ELSE TO HAPPEN. A
 * work-linked order is drafted, lined, issued and closed on its Work's
 * Procurement tab, which is where the Work's schedule and its delivery
 * challans are; every such row here links there. An order with NO Work has
 * no such tab, so this register carries its create form. That is the same
 * division Warranties draws for the same reason: a register lists, and an
 * act happens where the record it needs already is.
 *
 * The `?work=` deep link narrows the register to one Work and says so with
 * a dismissible chip, exactly as the mock's own document register does.
 */

interface PurchaseOrdersProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The `?work=` deep link. Null reads across everything in reach. */
  readonly workId: string | null;
  /** Writer role: drafting, lining, deleting a draft and closing. */
  readonly canCreate: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly onOpenWork: (workId: string) => void;
  readonly onClearWorkFilter: () => void;
}

type Basis = 'work' | 'organisation';

interface WorkFilter {
  readonly workCode: string;
  readonly workTitle: string;
}

export function PurchaseOrders({
  api,
  organisationId,
  workId,
  canCreate,
  canIssue,
  canCancel,
  onOpenWork,
  onClearWorkFilter,
}: PurchaseOrdersProps) {
  const [orders, setOrders] = useState<readonly PurchaseOrder[] | null>(null);
  const [workFilter, setWorkFilter] = useState<WorkFilter | null>(null);
  const [vendors, setVendors] = useState<readonly Contact[]>([]);
  const [basis, setBasis] = useState<Basis>('work');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseOrderDetailResponse | null>(null);
  const [loadVersion, retry] = useReload();

  /* The same runner every editing screen here uses: one pending flag, one
     error, one success line, and the error persists until it is fixed
     (`docs/UX.md` § Shared states). */
  const act = useCallback(async (run: () => Promise<void>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await run();
      setNotice(done);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, []);

  const refreshList = useCallback(async () => {
    const result = await api.listPurchaseOrders(
      organisationId,
      workId === null ? {} : { work: workId },
    );
    setOrders(result.purchaseOrders);
  }, [api, organisationId, workId]);

  useEffect(() => {
    let cancelled = false;
    // The picker is a convenience: an unavailable contact master must not
    // block reading the orders that already exist.
    api
      .listContacts(organisationId)
      .then((contacts) => {
        if (!cancelled) setVendors(contacts.filter((contact) => contact.isVendor));
      })
      .catch(() => {
        // The create form simply is not offered without vendors.
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  useEffect(() => {
    let cancelled = false;
    setOrders(null);
    setWorkFilter(null);
    setLoadError(null);
    setDetail(null);

    /* The whole register in one read, with no `limit`, which is what the
       route answers when a caller does not opt into a page. Every other
       register in this application is rendered in full for the same
       reason `packages/contracts/src/pagination.ts` gives: there is no
       paging control on the screen, and the tab counts the mock draws are
       counts of the whole register rather than of a page. */
    const page = api.listPurchaseOrders(
      organisationId,
      workId === null ? {} : { work: workId },
    );
    if (workId === null) {
      page
        .then((result) => {
          if (cancelled) return;
          setOrders(result.purchaseOrders);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setLoadError(errorMessage(cause, 'The purchase orders could not be loaded.'));
        });
      return () => {
        cancelled = true;
      };
    }

    /* One failure state, because these are not independent reads: a chip
       with no Work to name and rows with no chip over them are each half
       of the narrowed reading, and neither is worth rendering alone. */
    Promise.all([api.getWork(organisationId, workId), page])
      .then(([detail, result]) => {
        if (cancelled) return;
        setWorkFilter({ workCode: detail.work.workCode, workTitle: detail.work.title });
        setOrders(result.purchaseOrders);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(cause, 'This Work’s purchase orders could not be loaded.'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const narrowed = workId !== null;
  const workOrders = (orders ?? []).filter((order) => order.workId !== null);
  const orgOrders = (orders ?? []).filter((order) => order.workId === null);
  const shown = narrowed ? (orders ?? []) : basis === 'work' ? workOrders : orgOrders;
  /* A vendor may hold one open work-less draft, so the picker says which
     vendors already do rather than letting the server refuse the submit. */
  const draftVendorIds = new Set(
    orgOrders
      .filter((order) => order.status === 'draft')
      .map((order) => order.vendorContactId),
  );

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        titleId="purchase-orders-title"
        title="Purchase orders"
        description="Everything this organisation has ordered in — against an awarded Work, or outside any LOA. An order against a Work is drafted and closed on that Work’s Procurement tab."
      />

      <section aria-labelledby="purchase-orders-title" className="flex flex-col gap-4">
        {narrowed && workFilter !== null && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Filtered to</span>
            <span className="inline-flex items-center gap-2 rounded-md border border-primary/20 bg-primary/10 py-0.5 pr-1 pl-2 text-[13px] text-primary">
              <span className="font-mono font-semibold">{workFilter.workCode}</span>
              <span className="max-w-64 truncate text-primary/80">
                {workFilter.workTitle}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onClearWorkFilter}
                aria-label={`Clear the ${workFilter.workCode} filter and read the whole register`}
              >
                <X aria-hidden="true" />
              </Button>
            </span>
          </div>
        )}

        {!narrowed && orders !== null && (
          <TabRail<Basis>
            label="Purchase order basis"
            active={basis}
            onSelect={setBasis}
            tabs={[
              ['work', `Against LOA / Work (${String(workOrders.length)})`],
              ['organisation', `Outside any LOA (${String(orgOrders.length)})`],
            ]}
          />
        )}

        {loadError !== null && (
          <ErrorState onRetry={retry} retryLabel="Retry purchase orders">
            {loadError}
          </ErrorState>
        )}
        {actionError !== null && (
          <p role="alert" className="text-destructive text-sm">
            {actionError}
          </p>
        )}
        {notice !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        {loadError === null && orders === null && (
          <LoadingState label="the purchase orders" rows={5} columns={6} />
        )}

        {orders !== null &&
          (shown.length > 0 ? (
            <DataTable>
              <caption className="sr-only">
                Purchase orders with their number, what they were raised against, the
                vendor, how many lines they carry, their value, the date expected and
                their status
              </caption>
              <thead>
                <tr>
                  <th scope="col">PO number</th>
                  <th scope="col">Against</th>
                  <th scope="col">Vendor</th>
                  <th scope="col" className={numericCell}>
                    Lines
                  </th>
                  <th scope="col" className={numericCell}>
                    Value
                  </th>
                  <th scope="col">Expected</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((order) => (
                  <tr key={order.id}>
                    <th scope="row">
                      {order.workId === null ? (
                        <Button
                          variant="link"
                          size="inline"
                          className="font-mono font-medium"
                          onClick={() => {
                            void act(
                              async () => {
                                setDetail(
                                  await api.getPurchaseOrder(organisationId, order.id),
                                );
                              },
                              `Purchase order ${order.poNumber ?? 'draft'} opened below.`,
                            );
                          }}
                        >
                          {order.poNumber ?? 'Draft'}
                        </Button>
                      ) : (
                        <span className="font-mono font-medium">
                          {order.poNumber ?? 'Draft'}
                        </span>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {formatDate(order.poDate)}
                      </span>
                    </th>
                    <td>
                      {order.workId === null || order.workCode === null ? (
                        <>
                          <span>Organisation</span>
                          <span className="block text-xs text-muted-foreground">
                            Outside any LOA
                          </span>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="link"
                            size="inline"
                            className="font-mono font-medium"
                            onClick={() => {
                              onOpenWork(order.workId ?? '');
                            }}
                          >
                            {order.workCode}
                          </Button>
                          <span className="block text-xs text-muted-foreground">
                            LOA / Work
                          </span>
                        </>
                      )}
                    </td>
                    <td className={wrapCell}>{order.vendorDesignation}</td>
                    <td className={numericCell}>{order.lineCount}</td>
                    <td className={numericCell}>
                      {order.totalAmount !== null ? formatInr(order.totalAmount) : '—'}
                    </td>
                    <td>
                      {order.expectedOn !== null ? formatDate(order.expectedOn) : '—'}
                    </td>
                    <td>
                      <StatusChip status={order.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : narrowed ? (
            <EmptyState
              action={{ label: 'Read the whole register', onClick: onClearWorkFilter }}
            >
              No purchase order has been raised against this Work. Orders against a Work
              are drafted on its Procurement tab.
            </EmptyState>
          ) : basis === 'work' ? (
            <EmptyState>
              No purchase order has been raised against a Work yet. An order against a
              Work is drafted on that Work’s Procurement tab, beside the schedule it
              buys for.
            </EmptyState>
          ) : (
            <EmptyState>
              Nothing has been ordered outside an LOA yet. Office stores, plant and
              anything bought beside a contract is raised here.
            </EmptyState>
          ))}

        {!narrowed &&
          canCreate &&
          (vendors.length > 0 ? (
            <Disclosure label="New purchase order" startOpen={orgOrders.length === 0}>
              <p className="text-muted-foreground">
                This raises an order outside any LOA, numbered PO-01 onwards in the
                organisation’s own series. An order that buys for an awarded Work is
                raised on that Work’s Procurement tab instead, so its lines can name the
                Work’s items.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  const vendorContactId = formValue(data, 'org-po-vendor');
                  const poDate = formValue(data, 'org-po-date');
                  const expectedOn = formValue(data, 'org-po-expected');
                  const terms = formValue(data, 'org-po-terms').trim();
                  setPending(true);
                  setActionError(null);
                  api
                    .createPurchaseOrder(organisationId, {
                      vendorContactId,
                      poDate,
                      ...(expectedOn.length > 0 ? { expectedOn } : {}),
                      ...(terms.length > 0 ? { terms } : {}),
                    })
                    .then(async (created) => {
                      form.reset();
                      setBasis('organisation');
                      setDetail(created);
                      await refreshList();
                    })
                    .catch((cause: unknown) => {
                      setActionError(
                        errorMessage(
                          cause,
                          'The purchase order draft could not be created.',
                        ),
                      );
                    })
                    .finally(() => {
                      setPending(false);
                    });
                }}
              >
                <Field>
                  <label htmlFor="org-po-vendor">Vendor</label>
                  <select
                    id="org-po-vendor"
                    name="org-po-vendor"
                    required
                    defaultValue=""
                  >
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
                        {draftVendorIds.has(vendor.id) ? ' — draft already open' : ''}
                      </option>
                    ))}
                  </select>
                  <Hint>
                    One draft may remain open per vendor outside any Work. The vendor is
                    snapshotted at issue; later contact edits never rewrite the
                    document.
                  </Hint>
                </Field>
                <FieldRow>
                  <Field>
                    <label htmlFor="org-po-date">PO date</label>
                    <input id="org-po-date" name="org-po-date" type="date" required />
                  </Field>
                  <Field>
                    <label htmlFor="org-po-expected">Expected by (optional)</label>
                    <input id="org-po-expected" name="org-po-expected" type="date" />
                  </Field>
                </FieldRow>
                <Field>
                  <label htmlFor="org-po-terms">Terms (optional)</label>
                  <textarea
                    id="org-po-terms"
                    name="org-po-terms"
                    minLength={3}
                    maxLength={4000}
                    rows={2}
                  />
                </Field>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    <Plus aria-hidden="true" />
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
            /* An order with no Work has no schedule to buy from: its lines
               are free text or stock parts, which the panel offers on its
               own. */
            workItems={[]}
            canModify={canCreate}
            canIssue={canIssue}
            canCancel={canCancel}
            pending={pending}
            act={act}
            onChanged={refreshList}
          />
        )}
      </section>
    </>
  );
}
