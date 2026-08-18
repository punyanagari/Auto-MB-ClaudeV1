import { useEffect, useState } from 'react';
import { ArrowLeft, PackagePlus, Plus } from 'lucide-react';
import type { Contact, StockShortage, StockShortageResponse } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { navigateOnClick, stockRegisterHash } from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Field } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * Shortage procurement (migration 0087).
 *
 * Replicates `app/inventory/purchase-orders/page.tsx` of the frozen mock
 * at fdfe5ef: an "Open shortages" card of checkbox rows on the left, a
 * "Create draft supplier PO" button under them, and a column of supplier
 * purchase-order cards on the right with their lines and a receipt
 * action.
 *
 * TWO DIVERGENCES, both recorded in `docs/UX.md` § Approved divergences.
 *
 *   * **One row per PART, not per (plan, part).** The mock lists a row for
 *     every plan-and-part pair and puts a checkbox on each, so ticking
 *     the two rows for one cabinet from two plans orders it twice. The
 *     requirement is summed and the job cards asking for it are named on
 *     the row instead.
 *   * **The order is 0033's purchase order, not a second `SupplierPO`.**
 *     So the card shows that module's four statuses and its number, and
 *     its own lifecycle — issue, cancel, close — stays where the
 *     procurement module keeps it.
 *
 * The mock's per-order **"Record receipt"** IS here, on each line. The
 * first cut left it off both screens, each assuming the other owned it,
 * so an operator could raise an order from a shortage and then have
 * nowhere to say the material had arrived — which is the one thing that
 * clears the shortage. It posts a `purchase_receipt` for what the line is
 * still owed; the ledger refuses anything the order does not admit.
 *
 * The order is raised FOR a job card, which is what decides the Work it
 * belongs to. A job card serving a private purchase order has no Work and
 * the server refuses it in those words; the picker below therefore offers
 * only the cards that have one.
 */

interface StockShortagesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canModify: boolean;
  readonly onOpenRegister: () => void;
}

/** A job card that can carry an order: it has a Work, and this caller can
 * see it. The shortage rows name the same cards, so the picker is built
 * from them rather than from a second read. */
interface OrderableCard {
  readonly id: string;
  readonly number: string;
}

function orderableCards(shortages: readonly StockShortage[]): OrderableCard[] {
  const cards = new Map<string, string>();
  for (const shortage of shortages) {
    for (const card of shortage.jobCards) {
      if (card.workId !== null) cards.set(card.id, card.number);
    }
  }
  return [...cards]
    .map(([id, number]) => ({ id, number }))
    .sort((a, b) => a.number.localeCompare(b.number));
}

export function StockShortages({
  api,
  organisationId,
  canModify,
  onOpenRegister,
}: StockShortagesProps) {
  const [data, setData] = useState<StockShortageResponse | null>(null);
  const [vendors, setVendors] = useState<readonly Contact[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [jobCardId, setJobCardId] = useState('');
  const [vendorContactId, setVendorContactId] = useState('');
  const [expectedOn, setExpectedOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    Promise.all([
      api.listStockShortages(organisationId),
      api.listContacts(organisationId),
    ])
      .then(([shortages, contacts]) => {
        if (cancelled) return;
        setData(shortages);
        setVendors(contacts.filter((contact) => contact.isVendor && contact.active));
        // Everything short is ticked, exactly as the mock opens: the
        // screen exists to buy what is missing, and unticking is the
        // exception.
        setSelected(shortages.shortages.map((row) => row.itemId));
        setJobCardId(orderableCards(shortages.shortages)[0]?.id ?? '');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The shortage list could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const header = (
    <PageHeader
      eyebrow="Inventory"
      title="Shortage procurement"
      titleId="shortages-title"
      description="What the open job cards need and the shelf does not hold. Selecting parts drafts a purchase order on the job card's Work; the quantities are the shortages the server computes, and the rates are filled in on the order itself."
      action={
        <a
          href={stockRegisterHash()}
          onClick={navigateOnClick(onOpenRegister)}
          className={buttonVariants({ variant: 'outline' })}
        >
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
          Stock register
        </a>
      }
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState
          onRetry={() => {
            setLoadVersion((current) => current + 1);
          }}
          retryLabel="Retry the shortage list"
        >
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        {header}
        <LoadingState label="the shortage list" rows={4} columns={3} />
      </>
    );
  }

  const cards = orderableCards(data.shortages);

  function receive(line: {
    readonly id: string;
    readonly productionItemId: string;
    readonly outstanding: string;
  }): void {
    setReceiving(line.id);
    setActionError(null);
    api
      .postStockMovement(organisationId, {
        productionItemId: line.productionItemId,
        movementType: 'purchase_receipt',
        quantity: line.outstanding,
        purchaseOrderLineId: line.id,
      })
      .then(() => {
        // The shortage this order was raised for is now covered, so the
        // whole screen is re-read rather than patched: the left column
        // changes too.
        setLoadVersion((current) => current + 1);
      })
      .catch((cause: unknown) => {
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The receipt could not be recorded.',
        );
      })
      .finally(() => {
        setReceiving(null);
      });
  }

  function submit(): void {
    setBusy(true);
    setActionError(null);
    api
      .createShortagePurchaseOrder(organisationId, {
        jobCardId,
        vendorContactId,
        poDate: new Date().toISOString().slice(0, 10),
        ...(expectedOn === '' ? {} : { expectedOn }),
        productionItemIds: [...selected],
      })
      .then(() => {
        setLoadVersion((current) => current + 1);
      })
      .catch((cause: unknown) => {
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The purchase order could not be drafted.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <>
      {header}
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">Open shortages</h2>
            <span className="text-sm text-muted-foreground">
              {data.shortages.length} parts
            </span>
          </CardHeader>

          {data.shortages.length === 0 ? (
            <EmptyState>
              Nothing is short. Every open job card&rsquo;s bill of material is covered
              by what is on the shelf.
            </EmptyState>
          ) : (
            <>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {data.shortages.map((row) => {
                  const checked = selected.includes(row.itemId);
                  return (
                    <li key={row.itemId}>
                      <label className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-border p-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!canModify}
                          onChange={(event) => {
                            const on = event.currentTarget.checked;
                            setSelected((current) =>
                              on
                                ? [...current, row.itemId]
                                : current.filter((id) => id !== row.itemId),
                            );
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{row.name}</span>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {row.itemCode} · required{' '}
                            <span className="tabular-nums">{row.required}</span> · on
                            hand <span className="tabular-nums">{row.onHand}</span>
                          </span>
                          <span className="mt-1 flex flex-wrap gap-1">
                            {row.jobCards.map((card) => (
                              <Badge key={card.id} variant="outline">
                                {card.number}
                                {card.workCode === null ? '' : ` · ${card.workCode}`}
                              </Badge>
                            ))}
                          </span>
                        </span>
                        <span className="font-mono font-semibold tabular-nums text-destructive">
                          {row.shortage} {row.unit}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {canModify && (
                <div className="mt-4 border-t border-border pt-4">
                  {actionError !== null && (
                    <div
                      role="alert"
                      className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                    >
                      {actionError}
                    </div>
                  )}
                  {cards.length === 0 ? (
                    <p className="m-0 text-sm text-muted-foreground">
                      Every job card asking for this material serves a private purchase
                      order. A purchase order is raised against a Work, so there is
                      nothing here to draft one on.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-end gap-3">
                      <Field className="my-0 w-56">
                        <label htmlFor="shortage-card">Raise for job card</label>
                        <select
                          id="shortage-card"
                          value={jobCardId}
                          onChange={(event) => {
                            setJobCardId(event.currentTarget.value);
                          }}
                        >
                          {cards.map((card) => (
                            <option key={card.id} value={card.id}>
                              {card.number}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field className="my-0 w-64">
                        <label htmlFor="shortage-vendor">Vendor</label>
                        <select
                          id="shortage-vendor"
                          value={vendorContactId}
                          onChange={(event) => {
                            setVendorContactId(event.currentTarget.value);
                          }}
                        >
                          <option value="">Select a vendor</option>
                          {vendors.map((vendor) => (
                            <option key={vendor.id} value={vendor.id}>
                              {vendor.designation}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field className="my-0 w-44">
                        <label htmlFor="shortage-expected">Expected on</label>
                        <input
                          id="shortage-expected"
                          type="date"
                          value={expectedOn}
                          onChange={(event) => {
                            setExpectedOn(event.currentTarget.value);
                          }}
                        />
                      </Field>
                      <Button
                        disabled={
                          busy || selected.length === 0 || vendorContactId === ''
                        }
                        onClick={submit}
                      >
                        <Plus data-icon="inline-start" aria-hidden="true" />
                        {busy ? 'Drafting…' : 'Create draft supplier PO'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          {data.purchaseOrders.length === 0 ? (
            <Card>
              <EmptyState>
                No purchase order has been raised from a shortage yet.
              </EmptyState>
            </Card>
          ) : (
            <>
              {data.purchaseOrdersTruncated && (
                <Card>
                  <p className="m-0 text-sm text-muted-foreground">
                    Showing the {data.purchaseOrders.length} most recent orders raised
                    from a shortage. Older ones are on the Work&rsquo;s procurement
                    section.
                  </p>
                </Card>
              )}
              {data.purchaseOrders.map((order) => (
                <Card key={order.id}>
                  <CardHeader>
                    <div className="min-w-0">
                      <p className="m-0 font-mono text-sm font-semibold">
                        {order.poNumber ?? 'Draft'}
                      </p>
                      <h3 className="mt-1 text-base font-medium">
                        {order.vendorDesignation}
                      </h3>
                    </div>
                    <StatusChip status={order.status}>{order.status}</StatusChip>
                  </CardHeader>
                  <p className="m-0 mb-3 text-xs text-muted-foreground">
                    {order.expectedOn === null
                      ? 'No expected date'
                      : `Expected ${formatDate(order.expectedOn)}`}
                    {order.jobCardNumbers.length === 0
                      ? ''
                      : ` · ${order.jobCardNumbers.join(', ')}`}
                  </p>
                  <ul className="m-0 flex list-none flex-col p-0">
                    {order.lines.map((line) => (
                      <li
                        key={line.id}
                        className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 text-sm"
                      >
                        <span className="min-w-0">{line.name}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="font-mono tabular-nums">
                            {line.received} / {line.ordered} {line.unit}
                          </span>
                          {canModify && Number(line.outstanding) > 0 && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={receiving !== null}
                              aria-label={`Record receipt of ${line.outstanding} ${line.unit} ${line.name}`}
                              onClick={() => {
                                receive(line);
                              }}
                            >
                              <PackagePlus
                                data-icon="inline-start"
                                aria-hidden="true"
                              />
                              {receiving === line.id ? 'Recording…' : 'Receive'}
                            </Button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}
