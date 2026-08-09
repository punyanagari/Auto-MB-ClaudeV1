import { useCallback, useEffect, useState } from 'react';
import type {
  Installation,
  InstallationListResponse,
  LocationKind,
  LocationMaster,
  RecordInstallationRequest,
  Serial,
  WorkItem,
} from '@auto-mb/contracts';
import { formValue, RequestFailedError, type ApiClient } from '../api.js';

interface InstallationsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly canRecordEvidence: boolean;
  readonly workItems: readonly WorkItem[];
  readonly serials: readonly Serial[];
  readonly onSerialsChanged: (serials: readonly Serial[]) => void;
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
}: InstallationsProps) {
  const [data, setData] = useState<InstallationListResponse | null>(null);
  const [locations, setLocations] = useState<readonly LocationMaster[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [locationChoice, setLocationChoice] = useState<string>(NEW_LOCATION);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    Promise.all([
      api.listWorkInstallations(organisationId, workId),
      api.listLocationMasters(organisationId),
    ])
      .then(([loaded, loadedLocations]) => {
        if (cancelled) return;
        setData(loaded);
        setLocations(loadedLocations);
        if (loadedLocations.length > 0 && loadedLocations[0] !== undefined) {
          setLocationChoice(loadedLocations[0].id);
        }
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
  }, [api, organisationId, workId]);

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
    onSerialsChanged(freshSerials);
  }, [api, organisationId, workId, onSerialsChanged]);

  if (loadError !== null) {
    return (
      <>
        <h2>Installations</h2>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <h2>Installations</h2>
        <p className="muted" role="status">
          Loading installation records…
        </p>
      </>
    );
  }

  const selectableItems = workItems;
  const activeItemId =
    selectedItemId !== '' ? selectedItemId : (selectableItems[0]?.id ?? '');
  const activeItem = selectableItems.find((item) => item.id === activeItemId);
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
      <p className="muted">
        Quantity actually installed at site, by item and location. Per item the total
        can never exceed the sanctioned LOA quantity; serial-tracked items also need one
        delivered serial per installed unit.
      </p>
      {actionError !== null && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {notice !== null && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}

      <table className="data-table">
        <caption className="visually-hidden">
          Installed quantity per item for this Work
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="cell--numeric">
              Installed quantity
            </th>
          </tr>
        </thead>
        <tbody>
          {data.itemSummaries.map((summary) => (
            <tr key={summary.workItemId}>
              <th scope="row">{summary.itemNumber}</th>
              <td className="cell--numeric">{summary.installedQuantity}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.installations.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">
            Installation records for this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="cell--numeric">
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
                <td className="cell--numeric">{installation.quantity}</td>
                <td>{installation.installedOn}</td>
                <td className="cell--wrap">{installation.locationName}</td>
                <td className="cell--wrap">
                  {installation.serials.length > 0
                    ? installation.serials
                        .map((serial) => serial.serialNumber)
                        .join(', ')
                    : '—'}
                </td>
                <td>
                  {installation.status === 'cancelled' ? (
                    <span className="chip chip--cancelled">cancelled</span>
                  ) : (
                    <span className="chip chip--installed">recorded</span>
                  )}
                  {installation.cancellationNote !== null && (
                    <span className="muted"> {installation.cancellationNote}</span>
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
                            await api.cancelWorkInstallation(
                              organisationId,
                              installation.id,
                              note,
                            );
                            await refresh();
                          }, 'Installation record cancelled; its serials are back in the pool.');
                        }}
                      >
                        <div className="field">
                          <label htmlFor={`cancel-note-${installation.id}`}>
                            Cancellation note for {installation.itemNumber} on{' '}
                            {installation.installedOn}
                          </label>
                          <input
                            id={`cancel-note-${installation.id}`}
                            name={`cancel-note-${installation.id}`}
                            required
                            minLength={3}
                            maxLength={1000}
                          />
                        </div>
                        <button
                          type="submit"
                          className="button--ghost"
                          disabled={pending}
                        >
                          Cancel record
                        </button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No installations recorded yet.</p>
      )}

      {canRecordEvidence && selectableItems.length > 0 && (
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
                      kind: formValue(formData, 'inst-location-kind') as LocationKind,
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
              await refresh();
              const freshLocations = await api.listLocationMasters(organisationId);
              setLocations(freshLocations);
              setLocationChoice(recorded.locationId);
              form.reset();
            }, 'Installation recorded.');
          }}
        >
          <h3>Record installation</h3>
          <div className="field">
            <label htmlFor="inst-item">Work item</label>
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
                  {item.itemNumber} — {item.effectiveDescription ?? item.description}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="inst-quantity">Quantity installed</label>
            <input
              id="inst-quantity"
              name="inst-quantity"
              inputMode="decimal"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="inst-date">Installed on</label>
            <input id="inst-date" name="inst-date" type="date" required />
          </div>
          <div className="field">
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
          </div>
          {locationChoice === NEW_LOCATION && (
            <>
              <div className="field">
                <label htmlFor="inst-location-name">New location name</label>
                <input
                  id="inst-location-name"
                  name="inst-location-name"
                  required
                  minLength={2}
                  maxLength={200}
                />
              </div>
              <div className="field">
                <label htmlFor="inst-location-kind">New location kind</label>
                <select id="inst-location-kind" name="inst-location-kind">
                  {LOCATION_KINDS.map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="inst-remarks">Remarks (optional)</label>
            <input id="inst-remarks" name="inst-remarks" maxLength={1000} />
          </div>
          {activeItem?.requiresSerials === true && (
            <fieldset>
              <legend>
                Serials to install — one per unit, from the delivered pool of{' '}
                {activeItem.itemNumber}
              </legend>
              {serialPool.length > 0 ? (
                serialPool.map((serial) => (
                  <label key={serial.id} className="field">
                    <input type="checkbox" name="inst-serials" value={serial.id} />{' '}
                    {serial.serialNumber}
                    <span className="muted">
                      {' '}
                      · {serial.challanNumber ?? 'challan'}
                    </span>
                  </label>
                ))
              ) : (
                <p className="muted">
                  No delivered, uninstalled serials for this item — issue a Delivery
                  Challan with serials first.
                </p>
              )}
            </fieldset>
          )}
          <div className="actions">
            <button type="submit" disabled={pending}>
              Record installation
            </button>
          </div>
        </form>
      )}
    </>
  );
}
