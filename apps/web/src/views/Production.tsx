import { useEffect, useState } from 'react';
import { Boxes, Factory, PackageCheck, Plus, X } from 'lucide-react';
import type { JobCardSummary, ProductionItem, Work } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatDate, todayIso } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { statusKeyOf, statusLabelOf } from '../lib/production-status.js';
import { useReload } from '../lib/view-state.js';
import {
  navigateOnClick,
  productionHash,
  productionJobCardHash,
} from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { Combobox } from '../ui/combobox.js';
import { StatusChip } from '../ui/chip.js';
import { Actions, Field, FieldRow, FormError } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { ProgressBar } from '../ui/progress.js';
import { Stat } from '../ui/stat.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell } from '../ui/table.js';
import { NumericInput } from '../ui/numeric-input.js';

/**
 * The production register.
 *
 * Replicates `app/production/page.tsx` of the frozen mock at fdfe5ef:
 * three metric tiles over a six-column table — Plan / source, OEM item,
 * Material, Manufacturing, Dispatch, Due — with the plan number in mono
 * primary, the source line beneath it, and a progress bar in the
 * Manufacturing cell.
 *
 * Three departures, each recorded in `docs/UX.md` § 11 and each because
 * replicating the pixel would make the screen say something untrue:
 *
 *   * **The Material badge counts PARTS short, not units.** The mock
 *     badges "2277 units short" by adding cabinets in Nos to cable in Mtr
 *     to solder in Kg and printing the total, which `docs/UX.md` § 13a
 *     refuses for the stock register's tiles and this refuses for the
 *     same reason. The shortage itself is real now — it comes off the
 *     stock ledger of migration 0087 — and the badge is in the WARNING
 *     family rather than the mock's destructive, because
 *     `docs/DESIGN.md` § Status badge semantics keeps destructive for
 *     cancelled and rejected: material to buy is a thing to do.
 *   * **The middle tile counts job cards in production**, not material
 *     shortages: the tile is a count of the register's workload and the
 *     shortage lives on the row that has it.
 *   * **The status chip is here and the mock has none.** The mock encodes
 *     state in the Material badge, which is why its own fixture shows
 *     "Material blocked" on a plan it also calls `dispatch-ready`.
 *     `docs/DESIGN.md` § Status badge semantics makes the dot-plus-label
 *     chip the product's single vocabulary for record state.
 *
 * The mock's "New plan" button is absent until a Work is chosen, because
 * a job card is raised against a Work's schedule line or a private order
 * and the register has neither in hand. Its "Item master" button is the
 * mock's own and stays.
 */

/** One page of the register. The tiles count the whole of it, so a
 * page boundary never changes a figure. */
const PAGE_SIZE = 50;

interface ProductionProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The mock's `?work=` deep link. Present, the register reads one Work
   * and says so with a dismissible chip. */
  readonly workId: string | null;
  /** Recording production is shop-floor work, exactly as the server
   * gates it: owner, office and site may, a viewer reads. */
  readonly canRecord: boolean;
  readonly onOpenJobCard: (jobCardId: string) => void;
  readonly onOpenItemMaster: () => void;
}

export function Production({
  api,
  organisationId,
  workId,
  canRecord,
  onOpenJobCard,
  onOpenItemMaster,
}: ProductionProps) {
  const [cards, setCards] = useState<readonly JobCardSummary[] | null>(null);
  const [counts, setCounts] = useState({ open: 0, inProduction: 0, ready: 0 });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();
  const [creating, setCreating] = useState(false);
  /* The register is keyset-paginated server-side, and asking for a page
     is what makes that real: without a `limit` the route answers the
     whole table, which is the compatibility default `packages/contracts`
     § pagination describes and not something a register should rely on
     as it grows. */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCards(null);
    setLoadError(null);
    api
      .listJobCards(organisationId, {
        ...(workId === null ? {} : { workId }),
        limit: PAGE_SIZE,
      })
      .then((loaded) => {
        if (cancelled) return;
        setCards(loaded.jobCards);
        setNextCursor(loaded.nextCursor);
        setCounts({
          open: loaded.openCount,
          inProduction: loaded.inProductionCount,
          ready: loaded.dispatchReadyCount,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The job cards could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const header = (
    <PageHeader
      eyebrow="Operations"
      title="Production"
      titleId="production-title"
      description="Plan OEM manufacturing from Railway LOAs and private purchase orders, with material and serial traceability."
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onOpenItemMaster}>
            <Boxes data-icon="inline-start" aria-hidden="true" />
            Item master
          </Button>
          {canRecord && (
            <Button
              onClick={() => {
                setCreating((open) => !open);
              }}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              New job card
            </Button>
          )}
        </div>
      }
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState onRetry={retry} retryLabel="Retry job cards">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (cards === null) {
    return (
      <>
        {header}
        <LoadingState label="the job cards" rows={4} columns={6} />
      </>
    );
  }

  const workFilter = cards.find((card) => card.workId === workId);

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        {creating && (
          <JobCardForm
            api={api}
            organisationId={organisationId}
            workId={workId}
            onCreated={(created) => {
              setCreating(false);
              onOpenJobCard(created.id);
            }}
            onCancel={() => {
              setCreating(false);
            }}
          />
        )}

        {/* The mock's three tiles, in its order and with its icons. The
            figure is the shared `ui/stat`, so a row of tiles here keeps
            its digits in the same columns as every other screen's. */}
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              [
                <Factory
                  key="open"
                  className="size-5 text-primary"
                  aria-hidden="true"
                />,
                'Open job cards',
                counts.open,
              ],
              [
                <Boxes
                  key="running"
                  className="size-5 text-warning-foreground"
                  aria-hidden="true"
                />,
                'In production',
                counts.inProduction,
              ],
              [
                <PackageCheck
                  key="ready"
                  className="size-5 text-success"
                  aria-hidden="true"
                />,
                'Dispatch ready',
                counts.ready,
              ],
            ] as const
          ).map(([icon, label, value]) => (
            <Card key={label}>
              {icon}
              <Stat className="mt-3" label={label} value={String(value)} />
            </Card>
          ))}
        </div>

        {/* The mock's `?work=` chip. Its clear control is a real link
            back to the unfiltered register, not a state reset, so Back
            works and the address always says what is shown. */}
        {workId !== null && (
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              Work {workFilter?.workCode ?? workId.slice(0, 8)}
            </Badge>
            <a
              href={productionHash(null)}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
              Clear filter
            </a>
          </div>
        )}

        {cards.length === 0 ? (
          <EmptyState>
            {workId === null
              ? 'No job card has been raised yet. Define what the agency manufactures in the item master, then raise a job card against a Work or a private purchase order.'
              : 'No job card has been raised for this Work.'}
          </EmptyState>
        ) : (
          <DataTable>
            <caption className="sr-only">
              Production job cards with source, OEM item, material shortage,
              manufacturing progress, despatch count, status and due date
            </caption>
            <thead>
              <tr>
                <th scope="col">Plan / source</th>
                <th scope="col">OEM item</th>
                <th scope="col">Material</th>
                <th scope="col">Manufacturing</th>
                <th scope="col" className={numericCell}>
                  Dispatch
                </th>
                <th scope="col">Status</th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.id}>
                  <th scope="row">
                    {/* A real anchor, not a div with a handler:
                        middle-click and open-in-new-tab have to work on a
                        register row. */}
                    <a
                      href={productionJobCardHash(card.id)}
                      onClick={navigateOnClick(() => {
                        onOpenJobCard(card.id);
                      })}
                      className="font-mono text-sm font-semibold tabular-nums text-primary no-underline hover:underline"
                    >
                      {card.number}
                    </a>
                    <p className="m-0 mt-1 max-w-52 truncate text-xs font-normal text-muted-foreground">
                      {card.sourceType === 'work' ? 'Railway LOA' : 'Private PO'} ·{' '}
                      {card.sourceReference}
                    </p>
                  </th>
                  <td>
                    <p className="m-0 font-medium">{card.itemName}</p>
                    <p className="m-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {card.itemCode} · {card.quantity} Nos
                    </p>
                  </td>
                  <td>
                    <MaterialBadge card={card} />
                  </td>
                  <td>
                    <div className="min-w-32">
                      <div className="mb-1 flex justify-between font-mono text-xs tabular-nums">
                        <span>
                          {card.manufactured}/{card.quantity}
                        </span>
                        <span>{percentOf(card.manufactured, card.quantity)}%</span>
                      </div>
                      <ProgressBar
                        value={percentOf(card.manufactured, card.quantity)}
                        label={`Units built on job card ${card.number}`}
                      />
                    </div>
                  </td>
                  <td className={numericCell}>
                    {card.dispatched}/{card.quantity}
                  </td>
                  <td>
                    <StatusChip status={statusKeyOf(card)}>
                      {statusLabelOf(card)}
                    </StatusChip>
                  </td>
                  <td>{formatDate(card.dueDate)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}

        {nextCursor !== null && (
          <div>
            <Button
              variant="outline"
              disabled={paging}
              onClick={() => {
                setPaging(true);
                api
                  .listJobCards(organisationId, {
                    ...(workId === null ? {} : { workId }),
                    limit: PAGE_SIZE,
                    cursor: nextCursor,
                  })
                  .then((page) => {
                    setCards((current) => [...(current ?? []), ...page.jobCards]);
                    setNextCursor(page.nextCursor);
                  })
                  .catch((cause: unknown) => {
                    setLoadError(
                      errorMessage(cause, 'The next page could not be loaded.'),
                    );
                  })
                  .finally(() => {
                    setPaging(false);
                  });
              }}
            >
              Load more job cards
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The Material cell: the mock's badge, in this product's colour rules.
 *
 * Three readings, and only one of them is the mock's. A product with no
 * bill of material cannot be built at all and says so — the mock has no
 * such case because its fixture always has one. A card short of material
 * badges the count of PARTS, not the mock's sum of quantities across
 * units that do not add. Everything else is the mock's own "Ready".
 *
 * The figure is mono and tabular so it lines up down the column, and the
 * word beside it always carries the meaning: the tint is never the only
 * thing that says a card is short.
 */
function MaterialBadge({ card }: { readonly card: JobCardSummary }) {
  if (card.materialLines === 0) {
    return <Badge variant="destructive">No bill of material</Badge>;
  }
  if (card.materialShortParts === 0) return <Badge variant="neutral">Ready</Badge>;
  return (
    <Badge variant="warning">
      <span className="font-mono tabular-nums">{String(card.materialShortParts)}</span>
      {card.materialShortParts === 1 ? ' part short' : ' parts short'}
    </Badge>
  );
}

/**
 * Raising a job card.
 *
 * Inline on the register rather than behind a route or a modal: the
 * mock's "New plan" button opens nothing, so there is no dialog to
 * replicate, and five fields do not earn a focus trap or an address of
 * their own.
 *
 * The source is a Work OR a private customer and never both — the same
 * rule the route states and the schema shapes — so the form makes it a
 * choice rather than two fields an operator can fill in together.
 */
function JobCardForm({
  api,
  organisationId,
  workId,
  onCreated,
  onCancel,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The register's `?work=` filter, used as the form's default so
   * raising a card from a filtered register does not ask again. */
  readonly workId: string | null;
  readonly onCreated: (card: JobCardSummary) => void;
  readonly onCancel: () => void;
}) {
  const [items, setItems] = useState<readonly ProductionItem[]>([]);
  const [works, setWorks] = useState<readonly Work[]>([]);
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [source, setSource] = useState<'work' | 'private'>(
    workId === null ? 'work' : 'work',
  );
  const [chosenWorkId, setChosenWorkId] = useState(workId ?? '');
  const [customerName, setCustomerName] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [dueDate, setDueDate] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.listProductionItems(organisationId),
      api.listWorks(organisationId),
    ])
      .then(([catalogue, loadedWorks]) => {
        if (cancelled) return;
        // Only a manufactured item may carry a job card, which is what
        // the route refuses and what this select spares the operator.
        setItems(catalogue.items.filter((item) => item.manufactured));
        setWorks(loadedWorks);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessage(cause, 'The item master could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">New job card</h2>
        <p className="m-0 text-sm text-muted-foreground">
          Build a manufactured item for a Railway LOA or a private purchase order.
        </p>
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setPending(true);
          api
            .createJobCard(organisationId, {
              itemId,
              quantity: Number(quantity),
              sourceReference,
              dueDate,
              ...(source === 'work' ? { workId: chosenWorkId } : { customerName }),
            })
            .then(onCreated)
            .catch((cause: unknown) => {
              setError(errorMessage(cause, 'The job card could not be raised.'));
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        <FieldRow>
          <Field>
            <label htmlFor="job-card-item">OEM item</label>
            <select
              id="job-card-item"
              required
              value={itemId}
              onChange={(event) => {
                setItemId(event.currentTarget.value);
              }}
            >
              <option value="">Choose a manufactured item</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.itemCode} · {item.name}
                </option>
              ))}
            </select>
            {items.length === 0 && (
              <p className="m-0 text-xs text-muted-foreground">
                Nothing is marked as manufactured yet. Add a product in the item master
                first.
              </p>
            )}
          </Field>
          <Field>
            <label htmlFor="job-card-quantity">Quantity</label>
            <NumericInput
              integer
              id="job-card-quantity"
              required
              value={quantity}
              onChange={(event) => {
                setQuantity(event.currentTarget.value);
              }}
            />
            <p className="m-0 text-xs text-muted-foreground">
              Whole units. Every one becomes a serial.
            </p>
          </Field>
        </FieldRow>

        <Field>
          <span className="text-sm leading-snug font-medium">Source</span>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ['work', 'A Work'],
                ['private', 'A private purchase order'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm font-normal">
                <input
                  type="radio"
                  name="job-card-source"
                  value={key}
                  checked={source === key}
                  onChange={() => {
                    setSource(key);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </Field>

        {source === 'work' ? (
          <Field>
            <label htmlFor="job-card-work">Work</label>
            {/* `required` still refuses an empty submit: the combobox's
                visible text is the CHOSEN row's, and reverts to empty
                whenever nothing is chosen, so half-typed text can never
                stand in for a Work. */}
            <Combobox
              id="job-card-work"
              required
              value={chosenWorkId}
              onChange={setChosenWorkId}
              placeholder="Choose a Work"
              options={works.map((work) => ({
                value: work.id,
                code: work.workCode,
                label: work.title,
              }))}
              noMatchLabel="No Work matches that code or title."
            />
          </Field>
        ) : (
          <Field>
            <label htmlFor="job-card-customer">Customer</label>
            <input
              id="job-card-customer"
              required
              minLength={2}
              maxLength={200}
              value={customerName}
              onChange={(event) => {
                setCustomerName(event.currentTarget.value);
              }}
            />
          </Field>
        )}

        <FieldRow>
          <Field>
            <label htmlFor="job-card-reference">Source reference</label>
            <input
              id="job-card-reference"
              required
              maxLength={200}
              placeholder={
                source === 'work' ? 'Schedule line, e.g. A2/1' : 'PO/KE/2026/177'
              }
              value={sourceReference}
              onChange={(event) => {
                setSourceReference(event.currentTarget.value);
              }}
            />
          </Field>
          <Field>
            <label htmlFor="job-card-due">Due</label>
            <input
              id="job-card-due"
              required
              type="date"
              value={dueDate}
              onChange={(event) => {
                setDueDate(event.currentTarget.value);
              }}
            />
          </Field>
        </FieldRow>

        {error !== null && <FormError>{error}</FormError>}
        <Actions>
          <Button type="submit" disabled={pending || items.length === 0}>
            Raise job card
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </Actions>
      </form>
    </Card>
  );
}

/** Whole percent, and never a division by zero — the schema forbids a
 * zero-quantity job card, but the register must not render NaN if one
 * ever reached it. */
function percentOf(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}
