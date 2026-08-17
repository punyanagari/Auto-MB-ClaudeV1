import { useCallback, useEffect, useState } from 'react';
import type {
  Installation,
  InstallationCounts,
  InstallationListResponse,
  LocationKind,
  LocationMaster,
  RecordInstallationRequest,
  Serial,
  WorkBalanceItem,
  WorkItem,
} from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, subtractDecimalStrings, todayIso } from '../format.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { Field, Actions, FormError } from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';
import { Disclosure } from '../ui/disclosure.js';

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

/**
 * The mock's delivered-balance line, under the quantity field
 * (`components/installation-capture-flow.tsx:50` at fdfe5ef): what the
 * contract sanctions, what has actually arrived, what is already in, and
 * the balance still standing on site to install.
 *
 * Three of the four figures are the server's own decimal strings,
 * rendered verbatim. The fourth — what is delivered but not yet in — has
 * no server field of its own, so it is `subtractDecimalStrings`, which is
 * exact BigInt arithmetic rather than `Number`: a balance rendering as
 * 6.999999999999999 beside a quantity field is worse than none.
 *
 * Note this is NOT the server's `remainingQuantity`, which is the
 * DELIVERY balance (sanctioned less delivered). The question here is what
 * is standing on site to install, which is a different subtraction and a
 * different number.
 *
 * Explanatory only. The record route revalidates every quantity and
 * refuses what does not add up, so a failed balance read hides the line
 * rather than blocking recording.
 */
function DeliveredBalance({
  balance,
  installed,
}: {
  readonly balance: WorkBalanceItem;
  readonly installed: string;
}) {
  const sanctioned = balance.effectiveQuantity ?? balance.awardedQuantity;
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      <span className="font-mono tabular-nums">LOA {sanctioned}</span> ·{' '}
      <span className="font-mono tabular-nums">
        Delivered {balance.deliveredQuantity}
      </span>{' '}
      · <span className="font-mono tabular-nums">Installed {installed}</span> ·{' '}
      <strong className="font-mono text-foreground tabular-nums">
        Delivered balance {subtractDecimalStrings(balance.deliveredQuantity, installed)}
      </strong>
    </p>
  );
}

const LOCATION_KINDS: readonly { value: LocationKind; label: string }[] = [
  { value: 'station', label: 'Station' },
  { value: 'installation_point', label: 'Installation point' },
  { value: 'store', label: 'Store' },
  { value: 'other', label: 'Other' },
];

const NEW_LOCATION = '__new__';

/**
 * Quantity-level installation records (Milestone 7, legacy §5.4): the
 * mobile-friendly site entry — item, quantity, date, location picked from
 * the master or created inline, remarks, and tap-selected serials from
 * the delivered-but-uninstalled pool. Recorded entries cancel with a
 * note, which releases their serials back to the pool.
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Per work item, the variation answer the server gave on the last
   * record or cancel this panel performed. See `variationPending`. */
  const [recentVariations, setRecentVariations] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [pending, setPending] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [locationChoice, setLocationChoice] = useState<string>(NEW_LOCATION);
  /** Per-item delivered quantities, for the mock's balance line. A
   * courtesy read: it explains the field, it does not gate it, so a
   * failure hides the line and leaves recording alone. */
  const [balances, setBalances] = useState<readonly WorkBalanceItem[]>([]);
  /** Bumped by the failure state's retry, to re-run the load below. */
  const [loadVersion, setLoadVersion] = useState(0);

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
          cause instanceof RequestFailedError
            ? cause.message
            : 'The installation records could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
    // onCountsChanged is the parent's state setter, stable across renders
    // and deliberately not a dependency: the load is keyed on the Work, not
    // on who is listening to its tally.
  }, [api, organisationId, workId, loadVersion]);

  function retry(): void {
    setLoadVersion((current) => current + 1);
  }

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
    api
      .workBalance(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setBalances(loaded.items);
      })
      .catch(() => {
        // Deliberately silent: the balance line is explanatory, and the
        // panel already carries a failure state for the records and one
        // for the locations. A third alert for a courtesy figure would
        // report a problem the operator cannot act on and does not have.
        if (!cancelled) setBalances([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, canRecordEvidence, loadVersion]);

  const act = useCallback(async (work: () => Promise<void>, done: string) => {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The action failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const [freshData, freshSerials] = await Promise.all([
      api.listWorkInstallations(organisationId, workId),
      api.listWorkSerials(organisationId, workId),
    ]);
    setData(freshData);
    onCountsChanged?.(countsOf(freshData));
    onSerialsChanged(freshSerials);
  }, [api, organisationId, workId, onSerialsChanged, onCountsChanged]);

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

  // AMC items are not installable (migration 0068): annual maintenance
  // is served over a period and certified by the railway, and both the
  // record route and a database trigger refuse an installation naming
  // one. Offering them in the picker would be offering a form that
  // cannot succeed.
  const selectableItems = workItems.filter((item) => item.paymentCategory !== 'AMC');
  const activeItemId =
    selectedItemId !== '' ? selectedItemId : (selectableItems[0]?.id ?? '');
  const activeItem = selectableItems.find((item) => item.id === activeItemId);
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
  const activeBalance = balances.find((item) => item.workItemId === activeItemId);
  // The delivered-but-uninstalled pool of the picked item: serials whose
  // challan is issued and whose unit is not currently installed anywhere.
  const serialPool = serials.filter(
    (serial) =>
      serial.workItemId === activeItemId &&
      serial.challanStatus === 'issued' &&
      serial.installedOn === null,
  );

  return (
    <>
      <h2>Installations</h2>
      <p className="text-muted-foreground">
        Quantity actually installed at site, by item and location. Site progress is
        recorded as it happened: anything above the sanctioned LOA quantity is recorded
        too and routed to variation, and it stays out of measurement and billing until
        the variation order is approved. Serial-tracked items need one delivered serial
        per installed unit.
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
                    ? installation.serials
                        .map((serial) => serial.serialNumber)
                        .join(', ')
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

      {canRecordEvidence &&
        locationsState === 'ready' &&
        selectableItems.length > 0 && (
          <Disclosure
            label="New installation"
            startOpen={data.installations.length === 0}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const formData = new FormData(form);
                const quantity = formValue(formData, 'inst-quantity');
                const installedOn = formValue(formData, 'inst-date');
                const remarks = formValue(formData, 'inst-remarks').trim();
                const serialIds = formData
                  .getAll('inst-serials')
                  .filter((value): value is string => typeof value === 'string');
                const body: RecordInstallationRequest = {
                  workItemId: activeItemId,
                  quantity,
                  installedOn,
                  ...(locationChoice === NEW_LOCATION
                    ? {
                        newLocation: {
                          name: formValue(formData, 'inst-location-name'),
                          kind: formValue(
                            formData,
                            'inst-location-kind',
                          ) as LocationKind,
                        },
                      }
                    : { locationId: locationChoice }),
                  ...(remarks.length > 0 ? { remarks } : {}),
                  ...(serialIds.length > 0 ? { serialIds } : {}),
                };
                void act(async () => {
                  const recorded: Installation = await api.recordWorkInstallation(
                    organisationId,
                    workId,
                    body,
                  );
                  setRecentVariations((current) => ({
                    ...current,
                    [recorded.workItemId]: recorded.pendingVariation,
                  }));
                  const [evidenceRefresh, locationsRefresh] = await Promise.allSettled([
                    refresh(),
                    api.listLocationMasters(organisationId),
                  ]);
                  if (evidenceRefresh.status === 'rejected') {
                    setActionError(
                      'Installation recorded, but the updated evidence could not be reloaded. Reopen this Work to refresh it.',
                    );
                  }
                  if (locationsRefresh.status === 'fulfilled') {
                    setLocations(locationsRefresh.value);
                    setLocationsState('ready');
                    setLocationChoice(recorded.locationId);
                  } else {
                    setLocationsState('unavailable');
                  }
                  form.reset();
                }, 'Installation recorded.');
              }}
            >
              {/* The mock's numbered capture flow
                  (`components/installation-capture-flow.tsx` at fdfe5ef):
                  a dense two-column grid on desktop and one column on a
                  phone, which is where this is used, with the
                  delivered-balance line under the quantity field and the
                  variation chip beside the item.

                  Five steps rather than the mock's six: the mock's step 1
                  picks the Work, and this flow already runs inside one.
                  Renumbering is the honest port — copying the mock's
                  digits onto a different step set would number the
                  quantity field 2 with no 1 above it. The app's real
                  location master, inline location creation and delivered
                  serial pool stand where the mock's fake station list
                  and serial literals did. */}
              <div className="grid gap-x-6 sm:grid-cols-2">
                <Field>
                  <label htmlFor="inst-item">1. Work item</label>
                  <select
                    id="inst-item"
                    name="inst-item"
                    required
                    value={activeItemId}
                    onChange={(event) => {
                      setSelectedItemId(event.currentTarget.value);
                    }}
                  >
                    {selectableItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.itemNumber} —{' '}
                        {item.effectiveDescription ?? item.description}
                      </option>
                    ))}
                  </select>
                  {activeItem?.pendingVariation === true && <VariationChip />}
                </Field>
                <Field>
                  <label htmlFor="inst-quantity">2. Quantity installed</label>
                  <input
                    id="inst-quantity"
                    name="inst-quantity"
                    inputMode="decimal"
                    required
                  />
                  {activeBalance !== undefined && (
                    <DeliveredBalance
                      balance={activeBalance}
                      installed={activeItem?.installedQuantity ?? '0.000'}
                    />
                  )}
                </Field>
                <Field>
                  <label htmlFor="inst-date">3. Installed on</label>
                  <input
                    id="inst-date"
                    name="inst-date"
                    type="date"
                    required
                    defaultValue={todayIso()}
                  />
                </Field>
                <Field>
                  <label htmlFor="inst-location">4. Location</label>
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
              </div>
              {activeItem?.requiresSerials === true && (
                <fieldset>
                  <legend>
                    5. Serials to install — one per unit, from the delivered pool of{' '}
                    {activeItem.itemNumber}
                  </legend>
                  {serialPool.length > 0 ? (
                    <div className="grid max-h-52 gap-2 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-2">
                      {serialPool.map((serial) => (
                        <label
                          key={serial.id}
                          className="flex cursor-pointer items-center gap-3 rounded-md p-2 text-sm hover:bg-accent"
                        >
                          <input
                            type="checkbox"
                            name="inst-serials"
                            value={serial.id}
                          />
                          <span className="font-mono">{serial.serialNumber}</span>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {serial.challanNumber ?? 'challan'}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                      No delivered, uninstalled serials for this item — issue a Delivery
                      Challan with serials first.
                    </p>
                  )}
                </fieldset>
              )}
              <Actions>
                <Button type="submit" disabled={pending}>
                  Record installation
                </Button>
              </Actions>
            </form>
          </Disclosure>
        )}
    </>
  );
}
