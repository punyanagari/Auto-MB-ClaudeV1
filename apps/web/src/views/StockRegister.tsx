import { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  Boxes,
  PackagePlus,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react';
import type {
  CreateStockMovementRequest,
  PendingProductionReceipt,
  StockItem,
  StockMovement,
  StockRegisterResponse,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { navigateOnClick, STOCK_SHORTAGES_HASH } from '../lib/workspace-routes.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Modal } from '../ui/dialog.js';
import { Field } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * The stock register (migration 0087).
 *
 * Replicates `app/inventory/page.tsx` and `components/inventory-manager.tsx`
 * of the frozen mock at fdfe5ef: a stat strip over an item table with a
 * search row and a status filter, then a "Recent movements" table, with
 * "New item" / "New movement" in the header and per-row receive/issue
 * actions.
 *
 * FOUR DIVERGENCES, each because the mock's own arithmetic cannot mean
 * what it draws. `docs/UX.md` § Approved divergences records all four.
 *
 *   * **No "New item".** The mock's dialog creates a stock item; the item
 *     master is Production's (`production_items`, migration 0084) and its
 *     own screens own it. Two create forms for one table is how two
 *     catalogues start. The one stock fact this screen edits is the
 *     reorder level, inline.
 *   * **The stat strip counts PARTS, not quantities.** The mock sums
 *     `onHand` across every item — cabinets in Nos plus cable in Mtr plus
 *     solder in Kg, printed as one number.
 *   * **No warehouse column.** The mock's `location` is read off a type
 *     that does not have it, and nothing it computes is per location.
 *   * **"Committed" replaces "Reserved".** Same column, real number: the
 *     open job cards' outstanding bill of material, derived. The mock's
 *     `reserved` has no writer.
 *
 * The mock's despatch-to-stock step does not exist in it at all, because
 * it has no production despatch to receive. It is drawn here in the
 * mock's own grammar — a bordered row list inside a Card, the same shape
 * its movement list uses — because a released despatch that nobody takes
 * in leaves the register quietly understating the shelf.
 */

/* Both lists page. The register is bounded by the item master and grows
   slowly; the LEDGER is the wave's forever-growing table — one row per
   movement per part, for the life of the organisation — so a screen that
   read it whole would get slower every week it was used. Load-more rather
   than numbered pages: the question these lists answer is "what happened
   recently", which is read from the top down. */
const REGISTER_PAGE = 100;
const LEDGER_PAGE = 50;

interface StockRegisterProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Posting a movement and setting a reorder level are writer work,
   * exactly as the server gates them. A viewer reads the shelf. */
  readonly canModify: boolean;
  readonly onOpenShortages: () => void;
}

/** The two movement types this screen posts. An issue, a return and a
 * purchase receipt all name a document, and the screen that already knows
 * WHICH document — the job card, the shortage list — is where they are
 * posted from; a picker here would have to list every open Work in the
 * organisation to fill in a field the operator has already answered
 * elsewhere. */
type AdjustmentType = Extract<
  CreateStockMovementRequest['movementType'],
  'adjustment_in' | 'adjustment_out'
>;

/** The register's status word for a part. Three values, and the two that
 * are not a caution are deliberately unmapped in `ui/chip` so they read
 * neutral — being in stock is not an achievement. */
function statusOf(item: StockItem): { status: string; label: string } {
  if (!item.active) return { status: 'retired', label: 'Retired' };
  if (item.belowReorderLevel || Number(item.available) < 0) {
    return { status: 'low-stock', label: 'Low stock' };
  }
  return { status: 'available', label: 'Available' };
}

/** The mock renders a movement quantity as a bare number and its type as
 * a word. The ledger stores the quantity SIGNED, so the sign is dropped
 * for display and the direction is the word — which is what the mock
 * shows and what an operator reads. */
function magnitude(quantity: string): string {
  return quantity.startsWith('-') ? quantity.slice(1) : quantity;
}

const MOVEMENT_LABELS: Readonly<Record<StockMovement['movementType'], string>> = {
  production_receipt: 'Production receipt',
  purchase_receipt: 'Purchase receipt',
  issue: 'Issue',
  return: 'Return',
  adjustment_in: 'Adjustment in',
  adjustment_out: 'Adjustment out',
};

export function StockRegister({
  api,
  organisationId,
  canModify,
  onOpenShortages,
}: StockRegisterProps) {
  const [register, setRegister] = useState<StockRegisterResponse | null>(null);
  const [items, setItems] = useState<readonly StockItem[]>([]);
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  const [movements, setMovements] = useState<readonly StockMovement[]>([]);
  const [movementCursor, setMovementCursor] = useState<string | null>(null);
  const [pending, setPending] = useState<readonly PendingProductionReceipt[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, reload] = useReload();
  const [paging, setPaging] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [movementFor, setMovementFor] = useState<StockItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRegister(null);
    setLoadError(null);
    Promise.all([
      // The status filter is SENT, not applied in the browser: a filtered
      // register that was really the first page of an unfiltered one
      // would hide every retired part past the page boundary.
      api.listStockItems(organisationId, {
        limit: REGISTER_PAGE,
        ...(onlyActive ? { status: 'active' as const } : {}),
      }),
      api.listStockMovements(organisationId, { limit: LEDGER_PAGE }),
      api.listPendingProductionReceipts(organisationId),
    ])
      .then(([page, ledger, dispatches]) => {
        if (cancelled) return;
        setRegister(page);
        setItems(page.items);
        setItemCursor(page.nextCursor);
        setMovements(ledger.movements);
        setMovementCursor(ledger.nextCursor);
        setPending(dispatches.dispatches);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The stock register could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion, onlyActive]);

  function loadMoreItems(): void {
    if (itemCursor === null) return;
    setPaging(true);
    api
      .listStockItems(organisationId, {
        limit: REGISTER_PAGE,
        cursor: itemCursor,
        ...(onlyActive ? { status: 'active' as const } : {}),
      })
      .then((page) => {
        setItems((current) => [...current, ...page.items]);
        setItemCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        setActionError(errorMessage(cause, 'The next page could not be loaded.'));
      })
      .finally(() => {
        setPaging(false);
      });
  }

  function loadMoreMovements(): void {
    if (movementCursor === null) return;
    setPaging(true);
    api
      .listStockMovements(organisationId, {
        limit: LEDGER_PAGE,
        cursor: movementCursor,
      })
      .then((page) => {
        setMovements((current) => [...current, ...page.movements]);
        setMovementCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        setActionError(errorMessage(cause, 'The next page could not be loaded.'));
      })
      .finally(() => {
        setPaging(false);
      });
  }

  async function run(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      setMovementFor(null);
      reload();
    } catch (cause: unknown) {
      setActionError(errorMessage(cause, 'The movement could not be posted.'));
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <PageHeader
      title="Inventory control"
      titleId="stock-title"
      description="What is on the shelf, how it got there, and what the open job cards are short of. Every balance is the ledger below — nothing here stores one."
      action={
        /* A real anchor with a hash href rather than a button with a
           handler: `docs/UX.md` § navigation asks that every mock `Link`
           become an address middle-click and open-in-new-tab can use. */
        <a
          href={STOCK_SHORTAGES_HASH}
          onClick={navigateOnClick(onOpenShortages)}
          className={buttonVariants({ variant: 'outline' })}
        >
          <ShoppingCart data-icon="inline-start" aria-hidden="true" />
          Shortage procurement
        </a>
      }
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState onRetry={reload} retryLabel="Retry the stock register">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (register === null) {
    return (
      <>
        {header}
        <LoadingState label="the stock register" rows={6} columns={5} />
      </>
    );
  }

  /* The SEARCH stays client-side and the status filter does not, which
     looks inconsistent and is not: the filter changes which rows the
     server may return, so applying it here would silently hide rows past
     the page boundary. Search narrows what is already on screen and says
     so by counting against the loaded rows. */
  const shown = items.filter((item) =>
    `${item.itemCode} ${item.name} ${item.category}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              [
                <Boxes
                  key="tracked"
                  className="size-5 text-primary"
                  aria-hidden="true"
                />,
                'Parts tracked',
                register.summary.partsTracked,
              ],
              [
                <TriangleAlert
                  key="reorder"
                  className="size-5 text-warning-foreground"
                  aria-hidden="true"
                />,
                'At reorder level',
                register.summary.partsBelowReorderLevel,
              ],
              [
                <ShoppingCart
                  key="short"
                  className="size-5 text-destructive"
                  aria-hidden="true"
                />,
                'Short for open job cards',
                register.summary.partsShort,
              ],
            ] as const
          ).map(([icon, label, value]) => (
            <Card key={label}>
              {icon}
              <Stat className="mt-3" label={label} value={String(value)} />
            </Card>
          ))}
        </div>

        {actionError !== null && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {actionError}
          </div>
        )}

        {pending.length > 0 && (
          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold">
                Despatched, not yet on the shelf
              </h2>
            </CardHeader>
            <p className="m-0 mb-3 text-sm text-muted-foreground">
              Production has released these units. The quantity is the despatch&rsquo;s
              own unit count — it is not typed here, and it cannot be changed.
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {pending.map((dispatch) => (
                <li
                  key={dispatch.productionDispatchId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-xs tabular-nums text-primary">
                      {dispatch.reference}
                    </span>
                    <p className="m-0 mt-1 text-sm">
                      {dispatch.itemName}{' '}
                      <span className="font-mono tabular-nums">
                        {dispatch.quantity} {dispatch.unit}
                      </span>
                      {' · '}
                      <span className="font-mono tabular-nums">
                        {formatDate(dispatch.dispatchedOn)}
                      </span>
                    </p>
                  </div>
                  {canModify && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api.recordProductionReceipt(organisationId, {
                            productionDispatchId: dispatch.productionDispatchId,
                          }),
                        )
                      }
                    >
                      <PackagePlus data-icon="inline-start" aria-hidden="true" />
                      Take into stock
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">Item master</h2>
            <span className="text-sm text-muted-foreground">
              {shown.length} of {items.length} loaded
            </span>
          </CardHeader>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative max-w-md flex-1">
              <Search
                className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <label className="sr-only" htmlFor="stock-search">
                Search parts
              </label>
              <input
                id="stock-search"
                className="pl-9"
                placeholder="Search part number, name, or category"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={onlyActive}
                onChange={(event) => {
                  setOnlyActive(event.currentTarget.checked);
                }}
              />
              Live parts only
            </label>
          </div>

          {shown.length === 0 ? (
            <EmptyState>
              {items.length === 0
                ? 'No part is in the item master yet. Parts are created on Production, Item master; this register records what moves in and out of them.'
                : 'No part here matches that search.'}
            </EmptyState>
          ) : (
            <DataTable>
              <caption className="sr-only">
                Every part, with what is on the shelf and what the open job cards have
                already spoken for
              </caption>
              <thead>
                <tr>
                  <th scope="col">Part</th>
                  <th scope="col">Category</th>
                  <th scope="col" className="text-right!">
                    On hand
                  </th>
                  <th scope="col" className="text-right!">
                    Committed
                  </th>
                  <th scope="col" className="text-right!">
                    Available
                  </th>
                  <th scope="col">Status</th>
                  {canModify && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const badge = statusOf(item);
                  return (
                    <tr key={item.id}>
                      <th scope="row" className={wrapCell}>
                        <span className="block font-medium">{item.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {item.itemCode}
                        </span>
                      </th>
                      <td>{item.category}</td>
                      <td className={numericCell}>
                        {item.onHand} {item.unit}
                      </td>
                      <td className={numericCell}>{item.committed}</td>
                      <td className={numericCell}>{item.available}</td>
                      <td>
                        <StatusChip status={badge.status}>{badge.label}</StatusChip>
                      </td>
                      {canModify && (
                        <td className="text-right!">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Post a movement for ${item.name}`}
                            onClick={() => {
                              setActionError(null);
                              setMovementFor(item);
                            }}
                          >
                            <SlidersHorizontal aria-hidden="true" />
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
          {itemCursor !== null && (
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              disabled={paging}
              onClick={loadMoreItems}
            >
              {paging ? 'Loading…' : 'Load more parts'}
            </Button>
          )}
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">Recent movements</h2>
          </CardHeader>
          {/* NO BALANCE COLUMN, deliberately. `balance_after` is the
              running total in one PART's posting order, and these rows
              interleave parts — two adjacent rows are two different
              shelves, so a balance down the side of them totals nothing.
              It belongs to a per-item ledger, which no screen draws yet.
              The contract records the same reasoning. */}
          {movements.length === 0 ? (
            <EmptyState>
              Nothing has moved yet. Take a despatch into stock, or post an opening
              count as an adjustment with its reason.
            </EmptyState>
          ) : (
            <DataTable>
              <caption className="sr-only">
                The append-only stock ledger, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Date</th>
                  <th scope="col">Part</th>
                  <th scope="col">Movement</th>
                  <th scope="col">Source</th>
                  <th scope="col" className="text-right!">
                    Quantity
                  </th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => (
                  <tr key={movement.id}>
                    <th scope="row" className="font-mono text-xs">
                      {movement.reference}
                    </th>
                    <td className="font-mono text-[13px] tabular-nums">
                      {formatDate(movement.movementDate)}
                    </td>
                    <td className="font-mono text-xs">{movement.itemCode}</td>
                    <td>{MOVEMENT_LABELS[movement.movementType]}</td>
                    <td className={wrapCell}>{movement.sourceLabel ?? '—'}</td>
                    <td className={numericCell}>
                      {magnitude(movement.quantity)} {movement.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {movementCursor !== null && (
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              disabled={paging}
              onClick={loadMoreMovements}
            >
              {paging ? 'Loading…' : 'Load more movements'}
            </Button>
          )}
        </Card>
      </div>

      {movementFor !== null && (
        <MovementDialog
          item={movementFor}
          busy={busy}
          error={actionError}
          onClose={() => {
            setMovementFor(null);
          }}
          onSubmit={(form) =>
            void run(() => api.postStockMovement(organisationId, form))
          }
          onSetReorderLevel={(level) =>
            void run(() =>
              api.setStockReorderLevel(organisationId, movementFor.id, {
                reorderLevel: level,
              }),
            )
          }
        />
      )}
    </>
  );
}

/**
 * The mock's movement dialog, narrowed to what the ledger can honour.
 *
 * The mock offers a warehouse, a free-text work reference and a
 * counterparty. The first two are gone for the reasons the module header
 * gives; what a movement names instead is decided by its TYPE, so the
 * dialog offers only the three types that need nothing but a reason. An
 * issue to a job card or a Work, and a receipt against a purchase order
 * line, are posted from the screens that already know which one — the
 * job card and the shortage screen — rather than from a picker here that
 * would have to list every open Work in the organisation.
 */
function MovementDialog({
  item,
  busy,
  error,
  onClose,
  onSubmit,
  onSetReorderLevel,
}: {
  readonly item: StockItem;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (form: CreateStockMovementRequest) => void;
  readonly onSetReorderLevel: (level: string | null) => void;
}) {
  const [movementType, setMovementType] = useState<AdjustmentType>('adjustment_in');
  const [quantity, setQuantity] = useState('');
  /* Empty means "today, as the ORGANISATION reckons it" — resolved on
     the server. A browser clock is the wrong authority for a legal date,
     and the ledger refuses a movement dated behind the part's last one,
     so a machine a day slow would produce a refusal an operator could do
     nothing about. Typing a date stays available for the ordinary case of
     recording yesterday's count. */
  const [movementDate, setMovementDate] = useState('');
  const [reason, setReason] = useState('');
  const [reorderLevel, setReorderLevel] = useState(item.reorderLevel ?? '');

  return (
    <Modal
      onClose={busy ? () => undefined : onClose}
      labelledBy="stock-movement-title"
      describedBy="stock-movement-balance"
      lockScroll
      className="max-h-[85vh] w-full max-w-xl overflow-y-auto"
    >
      <h2 id="stock-movement-title" className="mt-0 text-base font-semibold">
        {item.itemCode} — {item.name}
      </h2>
      <p id="stock-movement-balance" className="m-0 text-sm text-muted-foreground">
        On hand{' '}
        <span className="font-mono tabular-nums">
          {item.onHand} {item.unit}
        </span>
        , committed <span className="font-mono tabular-nums">{item.committed}</span>.
      </p>

      {error !== null && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // Both types this dialog offers are adjustments, and an
          // adjustment carries a reason and names no document — which is
          // why the request is built flat here rather than branched.
          onSubmit({
            productionItemId: item.id,
            movementType,
            quantity,
            ...(movementDate === '' ? {} : { movementDate }),
            reason,
          });
        }}
      >
        <Field>
          <label htmlFor="movement-type">Movement</label>
          <select
            id="movement-type"
            value={movementType}
            onChange={(event) => {
              setMovementType(event.currentTarget.value as AdjustmentType);
            }}
          >
            <option value="adjustment_in">Adjustment in — found on the shelf</option>
            <option value="adjustment_out">Adjustment out — missing</option>
          </select>
        </Field>
        <Field>
          <label htmlFor="movement-quantity">Quantity ({item.unit})</label>
          <input
            id="movement-quantity"
            inputMode="decimal"
            required
            value={quantity}
            onChange={(event) => {
              setQuantity(event.currentTarget.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="movement-date">Movement date (blank means today)</label>
          <input
            id="movement-date"
            type="date"
            value={movementDate}
            onChange={(event) => {
              setMovementDate(event.currentTarget.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="movement-reason">Reason</label>
          <input
            id="movement-reason"
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            <ArrowDownToLine data-icon="inline-start" aria-hidden="true" />
            {busy ? 'Posting…' : 'Post movement'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>

      <div className="mt-6 border-t border-border pt-4">
        <Field>
          <label htmlFor="reorder-level">
            Reorder level ({item.unit}) — blank means no level is set
          </label>
          <input
            id="reorder-level"
            inputMode="decimal"
            value={reorderLevel}
            onChange={(event) => {
              setReorderLevel(event.currentTarget.value);
            }}
          />
        </Field>
        <Button
          className="mt-2"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            onSetReorderLevel(reorderLevel.trim() === '' ? null : reorderLevel.trim());
          }}
        >
          Save reorder level
        </Button>
      </div>
    </Modal>
  );
}
