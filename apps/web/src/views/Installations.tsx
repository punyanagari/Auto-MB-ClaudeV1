import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Installation,
  InstallationCounts,
  InstallationListResponse,
  LocationKind,
  LocationMaster,
  RecordInstallationBatchRequest,
  Serial,
  WorkBalanceItem,
  WorkItem,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatDate, subtractDecimalStrings, todayIso } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, Actions, FormError, Hint } from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { Disclosure } from '../ui/disclosure.js';
import { NumericInput } from '../ui/numeric-input.js';

interface InstallationsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canRecordEvidence: boolean;
  readonly workItems: readonly WorkItem[];
  readonly serials: readonly Serial[];
  readonly onSerialsChanged: (serials: readonly Serial[]) => void;
  /** Reports the tally back to the Work page, which carries it on its
   * tab badge and its summary tiles and reads it from the Work itself
   * rather than from this list. Called on every load and after every
   * record or cancel, so the badge tracks the panel without a reload. */
  readonly onCountsChanged?: (counts: InstallationCounts) => void;
}

/** The item owes a railway variation order: more is installed than the
 * contract sanctions. Replicates the mock's chip on the recording flow
 * (Auto-MB-Vercel-du, components/installation-capture-flow.tsx at
 * a8e1fde) — same words, same warning tone, and it reads the flag the
 * server derives rather than comparing quantities in the browser. */
function VariationChip() {
  return <Badge variant="warning">Above LOA — variation pending</Badge>;
}

function countsOf(data: InstallationListResponse): InstallationCounts {
  return {
    recorded: data.installations.filter((one) => one.status === 'recorded').length,
    cancelled: data.installations.filter((one) => one.status === 'cancelled').length,
  };
}

/** Whether an exact decimal string is greater than zero. `subtractDecimalStrings`
 * answers in text — "0.000", "-1.500" — and a `Number` round trip on a
 * quantity to ask one yes/no question is exactly the float arithmetic the
 * rest of this file goes out of its way to avoid. */
function isPositive(decimal: string): boolean {
  return !decimal.startsWith('-') && /[1-9]/.test(decimal);
}

const LOCATION_KINDS: readonly { value: LocationKind; label: string }[] = [
  { value: 'station', label: 'Station' },
  { value: 'installation_point', label: 'Installation point' },
  { value: 'store', label: 'Store' },
  { value: 'other', label: 'Other' },
];

const NEW_LOCATION = '__new__';

/** One item the crew could put in today, with the balance that says so. */
interface InstallableItem {
  readonly item: WorkItem;
  readonly description: string;
  /** What is still installable: for a serial-tracked (supply-type) item
   * the DELIVERED balance, because R5 caps installation at what issued
   * challans delivered; for every other item the LOA balance, which is
   * the only ceiling such an item has. */
  readonly remaining: string;
  /** Which of the two the figure is, so the column can say so rather than
   * leaving one number standing for two different rules. */
  readonly basis: 'delivered' | 'sanctioned';
}

/** What the operator has typed into one row of the recording table. */
interface RowEntry {
  readonly quantity: string;
  readonly serials: string;
}

const EMPTY_ROW: RowEntry = { quantity: '', serials: '' };

/** Serial numbers as typed: separated by commas, spaces or newlines, which
 * is how a list read off six nameplates actually arrives — pasted from a
 * note, or thumbed in one at a time. */
function parseSerials(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
}

/**
 * Quantity-level installation records (Milestone 7, legacy §5.4), recorded
 * the way a site visit happens.
 *
 * The picker this replaced offered every non-AMC item on the schedule and
 * recorded one of them at a time, so a crew that installed six items at one
 * station on one day picked the date and the station six times, and had to
 * know from memory which items had material standing on site at all.
 * Corrections ledger items 10 and 12 settled both: the table lists ONLY
 * items with an installable balance, with a search box over them, and the
 * date and location are stated once above it. One Record action writes one
 * installation record per filled row, in a single transaction.
 *
 * Serials are typed as NUMBERS here rather than tapped out of a pool. A
 * number already in the delivered-but-uninstalled pool links exactly as it
 * always did — the pool is offered as suggestions on the field — and a
 * number the Delivery Challan missed is accepted and recorded as entering
 * at the installation (migration 0108), because the person in front of the
 * equipment is the one who can read the nameplate.
 */
export function Installations({
  api,
  organisationId,
  workId,
  canRecordEvidence,
  workItems,
  serials,
  onSerialsChanged,
  onCountsChanged,
}: InstallationsProps) {
  const [data, setData] = useState<InstallationListResponse | null>(null);
  const [locations, setLocations] = useState<readonly LocationMaster[]>([]);
  const [locationsState, setLocationsState] = useState<
    'loading' | 'unavailable' | 'ready'
  >('loading');
  const [locationsLoadVersion, setLocationsLoadVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { pending, notice, actionError, act, setActionError } = useAction();
  /** Per work item, the variation answer the server gave on the last
   * record or cancel this panel performed. See `variationPending`. */
  const [recentVariations, setRecentVariations] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [locationChoice, setLocationChoice] = useState<string>(NEW_LOCATION);
  /** Per-item delivered quantities. This is no longer a courtesy read: the
   * delivered balance is what decides whether a supply-type item appears
   * in the recording table at all, so a failed read now shows a failure
   * state of its own rather than quietly emptying the table. */
  const [balances, setBalances] = useState<readonly WorkBalanceItem[]>([]);
  const [balancesState, setBalancesState] = useState<
    'loading' | 'unavailable' | 'ready'
  >('loading');
  const [balancesLoadVersion, setBalancesLoadVersion] = useState(0);
  /** What has been typed into the recording table, by work item id. */
  const [entries, setEntries] = useState<Readonly<Record<string, RowEntry>>>({});
  const [itemSearch, setItemSearch] = useState('');
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    api
      .listWorkInstallations(organisationId, workId)
      .then((loaded) => {
        if (cancelled) return;
        setData(loaded);
        onCountsChanged?.(countsOf(loaded));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(cause, 'The installation records could not be loaded.'),
        );
      });
    return () => {
      cancelled = true;
    };
    // onCountsChanged is the parent's state setter, stable across renders
    // and deliberately not a dependency: the load is keyed on the Work, not
    // on who is listening to its tally.
  }, [api, organisationId, workId, loadVersion]);

  useEffect(() => {
    let cancelled = false;
    setLocations([]);
    setLocationsState('loading');
    setLocationChoice(NEW_LOCATION);
    api
      .listLocationMasters(organisationId)
      .then((loadedLocations) => {
        if (cancelled) return;
        setLocations(loadedLocations);
        setLocationsState('ready');
        if (loadedLocations[0] !== undefined) {
          setLocationChoice(loadedLocations[0].id);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLocationsState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [api, locationsLoadVersion, organisationId]);

  useEffect(() => {
    let cancelled = false;
    setBalances([]);
    if (!canRecordEvidence) return;
    setBalancesState('loading');
    api
      .workBalance(organisationId, workId)
      .then((loaded) => {
        if (cancelled) return;
        setBalances(loaded.items);
        setBalancesState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setBalances([]);
        setBalancesState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [
    api,
    organisationId,
    workId,
    canRecordEvidence,
    loadVersion,
    balancesLoadVersion,
  ]);

  const refresh = useCallback(async () => {
    const [freshData, freshSerials] = await Promise.all([
      api.listWorkInstallations(organisationId, workId),
      api.listWorkSerials(organisationId, workId),
    ]);
    setData(freshData);
    onCountsChanged?.(countsOf(freshData));
    onSerialsChanged(freshSerials);
  }, [api, organisationId, workId, onSerialsChanged, onCountsChanged]);

  /**
   * The items with an installable balance — corrections ledger item 10.
   *
   * AMC items are excluded outright (migration 0068): annual maintenance is
   * served over a period and certified by the railway, and both the record
   * route and a database trigger refuse an installation naming one, so
   * offering them would be offering a form that cannot succeed.
   *
   * Everything else is judged on its balance, and WHICH balance depends on
   * the item. A serial-tracked item is supply-type: R5 caps its
   * installation at what issued Delivery Challans delivered, so its
   * remaining figure is delivered less installed. An item with no supply
   * leg has no delivery to be capped by — the pinned rule that lets it be
   * installed beyond the delivered quantity is deliberately untouched — so
   * its remaining figure is the sanctioned quantity less installed.
   *
   * Both figures are exact decimal subtraction of the server's own strings
   * (`subtractDecimalStrings` is BigInt arithmetic), and both are read from
   * THE authoritative installed aggregate the list response carries rather
   * than from the Work page's older copy. Explanatory either way: the
   * record route revalidates every quantity and refuses what does not add
   * up.
   */
  const installable: readonly InstallableItem[] = useMemo(() => {
    if (data === null) return [];
    const installedBy = new Map(
      data.itemSummaries.map((summary) => [
        summary.workItemId,
        summary.installedQuantity,
      ]),
    );
    const balanceBy = new Map(balances.map((one) => [one.workItemId, one]));
    return workItems.flatMap((item) => {
      if (item.paymentCategory === 'AMC') return [];
      const installed = installedBy.get(item.id) ?? item.installedQuantity ?? '0.000';
      const balance = balanceBy.get(item.id);
      const sanctioned =
        balance?.effectiveQuantity ??
        balance?.awardedQuantity ??
        item.effectiveQuantity ??
        item.awardedQuantity;
      const ceiling = item.requiresSerials ? balance?.deliveredQuantity : sanctioned;
      // No balance row means the Work read and the balance read disagree
      // about the schedule; the row is left out rather than guessed at,
      // and the balance failure state above says why the table may be short.
      if (ceiling === undefined) return [];
      const remaining = subtractDecimalStrings(ceiling, installed);
      if (!isPositive(remaining)) return [];
      return [
        {
          item,
          description: item.effectiveDescription ?? item.description,
          remaining,
          basis: item.requiresSerials
            ? ('delivered' as const)
            : ('sanctioned' as const),
        },
      ];
    });
  }, [data, balances, workItems]);

  const shown = useMemo(() => {
    const needle = itemSearch.trim().toLowerCase();
    if (needle === '') return installable;
    return installable.filter(
      (row) =>
        row.item.itemNumber.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle),
    );
  }, [installable, itemSearch]);

  if (loadError !== null) {
    return (
      <>
        <h2>Installations</h2>
        <ErrorState onRetry={retry} retryLabel="Retry installation records">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <h2>Installations</h2>
        <LoadingState label="the installation records" rows={4} columns={3} />
      </>
    );
  }

  /** Whether the item owes a variation order, straight from the flag the
   * database derives — the client never compares the quantities itself.
   *
   * A recording or a cancellation can move the flag, and the Work items
   * this panel is handed are the ones the Work page last loaded, so the
   * server's own answer on the record it just returned wins over them
   * until the page reloads. */
  const variationPending = (workItemId: string): boolean =>
    recentVariations[workItemId] ??
    workItems.find((item) => item.id === workItemId)?.pendingVariation === true;

  const entryOf = (workItemId: string): RowEntry => entries[workItemId] ?? EMPTY_ROW;
  const setEntry = (workItemId: string, patch: Partial<RowEntry>): void => {
    setEntries((current) => ({
      ...current,
      [workItemId]: { ...(current[workItemId] ?? EMPTY_ROW), ...patch },
    }));
  };

  /** The delivered-but-uninstalled pool of one item: serials whose challan
   * is issued and whose unit is not currently installed anywhere. Offered
   * as suggestions on the serials field rather than as a checklist — the
   * field has to accept a number that is NOT in the pool, which is the
   * whole point of the flow, and a control that only offered the pool
   * would say the opposite. */
  const poolFor = (workItemId: string): readonly Serial[] =>
    serials.filter(
      (serial) =>
        serial.workItemId === workItemId &&
        serial.challanStatus === 'issued' &&
        serial.installedOn === null,
    );

  /** The rows that will be recorded — read off EVERY installable item, not
   * off the filtered view. The search box narrows what is on screen; a
   * quantity typed against one item and then searched past is still part
   * of the visit, and dropping it silently would be the worst possible
   * reading of a filter. */
  const filled = installable.filter(
    (row) => entryOf(row.item.id).quantity.trim() !== '',
  );

  return (
    <>
      <h2>Installations</h2>
      <p className="text-muted-foreground">
        Quantity actually installed at site, by item and location. Site progress is
        recorded as it happened: anything above the sanctioned LOA quantity is recorded
        too and routed to variation, and it stays out of measurement and billing until
        the variation order is approved. Serial-tracked items need one serial per
        installed unit — from the delivered pool, or typed in if the Delivery Challan
        missed the nameplate.
      </p>
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && (
        <p className="text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {canRecordEvidence && locationsState === 'loading' && (
        <LoadingState label="the installation locations" rows={1} />
      )}
      {canRecordEvidence && locationsState === 'unavailable' && (
        <ErrorState
          retryLabel="Retry locations"
          onRetry={() => {
            setLocationsLoadVersion((version) => version + 1);
          }}
        >
          The location master could not be loaded. Existing installation records remain
          available, but new recording is paused.
        </ErrorState>
      )}
      {canRecordEvidence && balancesState === 'unavailable' && (
        <ErrorState
          retryLabel="Retry item balances"
          onRetry={() => {
            setBalancesLoadVersion((version) => version + 1);
          }}
        >
          The item balances could not be loaded, so the recording table cannot say what
          is still installable. Existing installation records remain available.
        </ErrorState>
      )}

      <DataTable>
        <caption className="sr-only">Installed quantity per item for this Work</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className={numericCell}>
              Installed quantity
            </th>
          </tr>
        </thead>
        <tbody>
          {data.itemSummaries.map((summary) => (
            <tr key={summary.workItemId}>
              <th scope="row">
                {summary.itemNumber}
                {variationPending(summary.workItemId) && (
                  <>
                    {' '}
                    <VariationChip />
                  </>
                )}
              </th>
              <td className={numericCell}>{summary.installedQuantity}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      {data.installations.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Installation records for this Work</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className={numericCell}>
                Quantity
              </th>
              <th scope="col">Installed on</th>
              <th scope="col">Location</th>
              <th scope="col">Serials</th>
              <th scope="col">Status</th>
              {canRecordEvidence && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {data.installations.map((installation) => (
              <tr key={installation.id}>
                <th scope="row">{installation.itemNumber}</th>
                <td className={numericCell}>{installation.quantity}</td>
                <td>{formatDate(installation.installedOn)}</td>
                <td className={wrapCell}>{installation.locationName}</td>
                <td className={wrapCell}>
                  {installation.serials.length > 0
                    ? installation.serials.map((serial, index) => (
                        <span key={serial.serialId}>
                          {index > 0 && ', '}
                          <span className="font-mono">{serial.serialNumber}</span>
                          {/* Migration 0108: a serial that entered here
                              rather than on a challan is the one a
                              traceability question gets asked about, so
                              the record that captured it says so. */}
                          {serial.origin === 'installation' && (
                            <>
                              {' '}
                              <StatusChip status="added-at-installation" tone="warning">
                                added here
                              </StatusChip>
                            </>
                          )}
                        </span>
                      ))
                    : '—'}
                </td>
                <td>
                  <StatusChip status={installation.status} />
                  {installation.cancellationNote !== null && (
                    <span className="text-muted-foreground">
                      {' '}
                      {installation.cancellationNote}
                    </span>
                  )}
                </td>
                {canRecordEvidence && (
                  <td>
                    {installation.status === 'recorded' && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const note = formValue(
                            new FormData(event.currentTarget),
                            `cancel-note-${installation.id}`,
                          ).trim();
                          void act(async () => {
                            const cancelled = await api.cancelWorkInstallation(
                              organisationId,
                              installation.id,
                              note,
                            );
                            setRecentVariations((current) => ({
                              ...current,
                              [cancelled.workItemId]: cancelled.pendingVariation,
                            }));
                            await refresh();
                          }, 'Installation record cancelled; its serials are back in the pool.');
                        }}
                      >
                        <Field>
                          <label htmlFor={`cancel-note-${installation.id}`}>
                            Cancellation note for {installation.itemNumber} on{' '}
                            {formatDate(installation.installedOn)}
                          </label>
                          <input
                            id={`cancel-note-${installation.id}`}
                            name={`cancel-note-${installation.id}`}
                            required
                            minLength={3}
                            maxLength={1000}
                          />
                        </Field>
                        <Button type="submit" variant="outline" disabled={pending}>
                          Cancel record
                        </Button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">No installations recorded yet.</p>
      )}

      {canRecordEvidence && locationsState === 'ready' && balancesState === 'ready' && (
        <Disclosure
          label="Record installations"
          startOpen={data.installations.length === 0}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const formData = new FormData(form);
              const rows = filled.map((row) => {
                const entry = entryOf(row.item.id);
                const serialNumbers = parseSerials(entry.serials);
                return {
                  workItemId: row.item.id,
                  quantity: entry.quantity.trim(),
                  ...(serialNumbers.length > 0 ? { serialNumbers } : {}),
                };
              });
              if (rows.length === 0) {
                setActionError(
                  'Enter an installed quantity against at least one item before recording.',
                );
                return;
              }
              const remarks = formValue(formData, 'inst-remarks').trim();
              const body: RecordInstallationBatchRequest = {
                installedOn: formValue(formData, 'inst-date'),
                ...(locationChoice === NEW_LOCATION
                  ? {
                      newLocation: {
                        name: formValue(formData, 'inst-location-name'),
                        kind: formValue(formData, 'inst-location-kind') as LocationKind,
                      },
                    }
                  : { locationId: locationChoice }),
                ...(remarks.length > 0 ? { remarks } : {}),
                rows,
              };
              void act(
                async () => {
                  const recorded = await api.recordWorkInstallations(
                    organisationId,
                    workId,
                    body,
                  );
                  setRecentVariations((current) => {
                    const next = { ...current };
                    for (const one of recorded.installations) {
                      next[one.workItemId] = one.pendingVariation;
                    }
                    return next;
                  });
                  const [evidenceRefresh, locationsRefresh] = await Promise.allSettled([
                    refresh(),
                    api.listLocationMasters(organisationId),
                  ]);
                  if (evidenceRefresh.status === 'rejected') {
                    setActionError(
                      'Installations recorded, but the updated evidence could not be reloaded. Reopen this Work to refresh it.',
                    );
                  }
                  const first: Installation | undefined = recorded.installations[0];
                  if (locationsRefresh.status === 'fulfilled') {
                    setLocations(locationsRefresh.value);
                    setLocationsState('ready');
                    if (first !== undefined) setLocationChoice(first.locationId);
                  } else {
                    setLocationsState('unavailable');
                  }
                  setEntries({});
                  setItemSearch('');
                  form.reset();
                },
                `${String(rows.length)} installation record${rows.length === 1 ? '' : 's'} written.`,
              );
            }}
          >
            {/* One site visit: the date, the place and the note are facts
                about the VISIT, so they are stated once above the items
                rather than re-typed per item. `docs/UX.md` § 24 records
                the divergence from the mock's one-item capture flow. */}
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Field>
                <label htmlFor="inst-date">Installed on</label>
                <input
                  id="inst-date"
                  name="inst-date"
                  type="date"
                  required
                  defaultValue={todayIso()}
                />
              </Field>
              <Field>
                <label htmlFor="inst-location">Location</label>
                <select
                  id="inst-location"
                  name="inst-location"
                  value={locationChoice}
                  onChange={(event) => {
                    setLocationChoice(event.currentTarget.value);
                  }}
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                  <option value={NEW_LOCATION}>+ Add a new location</option>
                </select>
              </Field>
              {locationChoice === NEW_LOCATION && (
                <>
                  <Field>
                    <label htmlFor="inst-location-name">New location name</label>
                    <input
                      id="inst-location-name"
                      name="inst-location-name"
                      required
                      minLength={2}
                      maxLength={200}
                    />
                  </Field>
                  <Field>
                    <label htmlFor="inst-location-kind">New location kind</label>
                    <select id="inst-location-kind" name="inst-location-kind">
                      {LOCATION_KINDS.map((kind) => (
                        <option key={kind.value} value={kind.value}>
                          {kind.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
              <Field>
                <label htmlFor="inst-remarks">Remarks (optional)</label>
                <input id="inst-remarks" name="inst-remarks" maxLength={1000} />
              </Field>
              <Field>
                <label htmlFor="inst-item-search">Find an item</label>
                <input
                  id="inst-item-search"
                  type="search"
                  value={itemSearch}
                  onChange={(event) => {
                    setItemSearch(event.currentTarget.value);
                  }}
                  placeholder="Item number or description"
                />
              </Field>
            </div>

            {installable.length === 0 ? (
              <EmptyState>
                Nothing is standing on site to install: every item is either fully
                installed or still waiting on its Delivery Challan.
              </EmptyState>
            ) : shown.length === 0 ? (
              <EmptyState>No item matches “{itemSearch}”.</EmptyState>
            ) : (
              <>
                <DataTable>
                  <caption className="sr-only">
                    Items with an installable balance, with the quantity and serials
                    going in on this visit
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Description</th>
                      <th scope="col" className={numericCell}>
                        Remaining
                      </th>
                      <th scope="col" className={numericCell}>
                        Installed now
                      </th>
                      <th scope="col">Serials</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => {
                      const pool = poolFor(row.item.id);
                      const listId = `inst-pool-${row.item.id}`;
                      return (
                        <tr key={row.item.id}>
                          <th scope="row">
                            {row.item.itemNumber}
                            {variationPending(row.item.id) && (
                              <>
                                {' '}
                                <VariationChip />
                              </>
                            )}
                          </th>
                          <td className={wrapCell}>{row.description}</td>
                          <td className={numericCell}>
                            {row.remaining}{' '}
                            <span className="text-xs text-muted-foreground">
                              {row.basis === 'delivered' ? 'delivered' : 'of LOA'}
                            </span>
                          </td>
                          <td className={numericCell}>
                            <NumericInput
                              aria-label={`Quantity of ${row.item.itemNumber} installed now`}
                              className="w-24 text-right font-mono tabular-nums"
                              value={entryOf(row.item.id).quantity}
                              onChange={(event) => {
                                setEntry(row.item.id, {
                                  quantity: event.currentTarget.value,
                                });
                              }}
                            />
                          </td>
                          <td>
                            {row.item.requiresSerials ? (
                              <>
                                <input
                                  aria-label={`Serials of ${row.item.itemNumber} installed now`}
                                  className="w-56 font-mono"
                                  list={pool.length > 0 ? listId : undefined}
                                  value={entryOf(row.item.id).serials}
                                  onChange={(event) => {
                                    setEntry(row.item.id, {
                                      serials: event.currentTarget.value,
                                    });
                                  }}
                                />
                                {pool.length > 0 && (
                                  <datalist id={listId}>
                                    {pool.map((serial) => (
                                      <option
                                        key={serial.id}
                                        value={serial.serialNumber}
                                      />
                                    ))}
                                  </datalist>
                                )}
                              </>
                            ) : (
                              <span className="text-muted-foreground">
                                not serial-tracked
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </DataTable>
                <Hint>
                  Remaining is the DELIVERED balance for a serial-tracked supply item —
                  installation never runs ahead of an issued Delivery Challan — and the
                  LOA balance for an item with no supply leg. Serials are separated by
                  commas or spaces, one per installed unit; a number the challan missed
                  is accepted and recorded as entering here.
                </Hint>
              </>
            )}
            <Actions>
              <Button type="submit" disabled={pending || filled.length === 0}>
                {filled.length <= 1
                  ? 'Record installation'
                  : `Record ${String(filled.length)} installations`}
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
    </>
  );
}
