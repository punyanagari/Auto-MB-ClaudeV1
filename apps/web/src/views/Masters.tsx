import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  Contact,
  LocationKind,
  LocationMaster,
  Signatory,
  UnitMaster,
} from '@auto-mb/contracts';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';

interface MastersProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Owner/office may add, edit, retire, and reactivate; others read. */
  readonly canModify: boolean;
}

type MastersTab = 'contacts' | 'locations' | 'units' | 'signatories';

const TABS: readonly { key: MastersTab; label: string }[] = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'locations', label: 'Locations' },
  { key: 'units', label: 'Units' },
  { key: 'signatories', label: 'Signatories' },
];

const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  station: 'Station',
  installation_point: 'Installation point',
  store: 'Store',
  other: 'Other',
};

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof RequestFailedError ? cause.message : fallback;
}

function StatusChip({ active }: { readonly active: boolean }) {
  return (
    <span className={`chip chip--${active ? 'active' : 'failed'}`}>
      {active ? 'active' : 'retired'}
    </span>
  );
}

/** Shared list plumbing: loads on mount and whenever the retired filter
 * flips; exposes a reload for the mutation handlers. */
function useMasterList<T>(
  load: (includeRetired: boolean) => Promise<readonly T[]>,
  includeRetired: boolean,
  onError: (message: string | null) => void,
) {
  const [rows, setRows] = useState<readonly T[] | null>(null);
  const reload = useCallback(() => {
    load(includeRetired)
      .then((loaded) => {
        setRows(loaded);
      })
      .catch((cause: unknown) => {
        onError(errorMessage(cause, 'The master list could not be loaded.'));
      });
  }, [load, includeRetired, onError]);
  useEffect(() => {
    setRows(null);
    reload();
  }, [reload]);
  return { rows, reload };
}

function RetiredFilter({
  id,
  includeRetired,
  onChange,
}: {
  readonly id: string;
  readonly includeRetired: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <label className="muted" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={includeRetired}
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
      />{' '}
      Show retired
    </label>
  );
}

function ContactsTab({ api, organisationId, canModify }: MastersProps) {
  const [includeRetired, setIncludeRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);

  const load = useCallback(
    (retired: boolean) => api.listContacts(organisationId, { includeRetired: retired }),
    [api, organisationId],
  );
  const { rows, reload } = useMasterList(load, includeRetired, setError);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const optional = (name: string): string | undefined => {
      const value = formValue(data, name).trim();
      return value.length === 0 ? undefined : value;
    };
    const address = optional('address');
    const contactPerson = optional('contactPerson');
    const phone = optional('phone');
    const email = optional('email');
    const gstin = optional('gstin');
    const pincode = optional('pincode');
    const stateCode = optional('stateCode');
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveContact(organisationId, editing?.id ?? null, {
        designation: formValue(data, 'designation').trim(),
        ...(address !== undefined ? { address } : {}),
        ...(contactPerson !== undefined ? { contactPerson } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(gstin !== undefined ? { gstin } : {}),
        ...(pincode !== undefined ? { pincode } : {}),
        ...(stateCode !== undefined ? { stateCode } : {}),
      });
      setNotice(editing === null ? 'Contact added.' : 'Contact updated.');
      setEditing(null);
      form.reset();
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The contact could not be saved.'));
    } finally {
      setPending(false);
    }
  }

  async function setActive(row: Contact, active: boolean) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.setContactActive(organisationId, row.id, active);
      setNotice(
        active
          ? `${row.designation} reactivated.`
          : `${row.designation} retired — existing documents keep their snapshot.`,
      );
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The change could not be saved.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p className="muted">
        One master for consignees, vendors, and clients (role flags on each record).
        Contacts prefill documents; the document always keeps its own copy, so editing
        or retiring a contact never changes issued records.
      </p>
      <RetiredFilter
        id="contacts-retired"
        includeRetired={includeRetired}
        onChange={setIncludeRetired}
      />
      {rows === null ? (
        <p className="muted" role="status">
          Loading contacts…
        </p>
      ) : rows.length === 0 ? (
        <p className="muted">No contacts yet.</p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">
            Contacts with designation, address, GSTIN, roles, and contact details
          </caption>
          <thead>
            <tr>
              <th scope="col">Designation</th>
              <th scope="col">Address</th>
              <th scope="col">GSTIN</th>
              <th scope="col">Contact</th>
              <th scope="col">Roles</th>
              <th scope="col">Status</th>
              {canModify && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.designation}</th>
                <td className="cell--wrap">
                  {[
                    row.address,
                    row.pincode,
                    row.stateCode ? `State ${row.stateCode}` : null,
                  ]
                    .filter((part) => part !== null && part !== undefined)
                    .join(' · ') || '—'}
                </td>
                <td>{row.gstin ?? '—'}</td>
                <td className="cell--wrap">
                  {[row.contactPerson, row.phone, row.email]
                    .filter((part) => part !== null)
                    .join(' · ') || '—'}
                </td>
                <td>
                  {[
                    row.isConsignee ? 'consignee' : null,
                    row.isVendor ? 'vendor' : null,
                    row.isClient ? 'client' : null,
                  ]
                    .filter((role) => role !== null)
                    .join(', ') || '—'}
                </td>
                <td>
                  <StatusChip active={row.active} />
                </td>
                {canModify && (
                  <td>
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => {
                        setEditing(row);
                      }}
                    >
                      Edit
                    </button>{' '}
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => void setActive(row, !row.active)}
                    >
                      {row.active ? 'Retire' : 'Reactivate'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canModify && (
        <>
          <h2>{editing === null ? 'Add a contact' : `Edit ${editing.designation}`}</h2>
          <form key={editing?.id ?? 'new'} onSubmit={(event) => void save(event)}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="contact-designation">Designation / name</label>
                <input
                  id="contact-designation"
                  name="designation"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={editing?.designation ?? ''}
                />
              </div>
              <div className="field">
                <label htmlFor="contact-person">Contact person (optional)</label>
                <input
                  id="contact-person"
                  name="contactPerson"
                  maxLength={200}
                  defaultValue={editing?.contactPerson ?? ''}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="contact-address">Address (optional)</label>
              <textarea
                id="contact-address"
                name="address"
                rows={2}
                maxLength={1000}
                defaultValue={editing?.address ?? ''}
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="contact-gstin">GSTIN (optional)</label>
                <input
                  id="contact-gstin"
                  name="gstin"
                  minLength={15}
                  maxLength={15}
                  defaultValue={editing?.gstin ?? ''}
                  aria-describedby="contact-gstin-hint"
                />
                <p className="muted" id="contact-gstin-hint">
                  Railway units are TDS deductors — GSTINs ending in D are accepted.
                </p>
              </div>
              <div className="field">
                <label htmlFor="contact-pincode">Pincode (optional)</label>
                <input
                  id="contact-pincode"
                  name="pincode"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  defaultValue={editing?.pincode ?? ''}
                />
              </div>
              <div className="field">
                <label htmlFor="contact-state-code">State code (optional)</label>
                <input
                  id="contact-state-code"
                  name="stateCode"
                  pattern="[0-9]{2}"
                  maxLength={2}
                  defaultValue={editing?.stateCode ?? ''}
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="contact-phone">Phone (optional)</label>
                <input
                  id="contact-phone"
                  name="phone"
                  maxLength={30}
                  defaultValue={editing?.phone ?? ''}
                />
              </div>
              <div className="field">
                <label htmlFor="contact-email">Email (optional)</label>
                <input
                  id="contact-email"
                  name="email"
                  type="email"
                  maxLength={200}
                  defaultValue={editing?.email ?? ''}
                />
              </div>
            </div>
            <fieldset className="field">
              <legend>Roles</legend>
              <label htmlFor="contact-role-consignee">
                <input
                  id="contact-role-consignee"
                  type="checkbox"
                  checked
                  disabled
                  readOnly
                />{' '}
                Consignee
              </label>{' '}
              <label htmlFor="contact-role-vendor">
                <input id="contact-role-vendor" type="checkbox" disabled /> Vendor
              </label>{' '}
              <label htmlFor="contact-role-client">
                <input id="contact-role-client" type="checkbox" disabled /> Client
              </label>
              <p className="muted">
                Every contact is a consignee for now; vendor and client roles unlock
                with the procurement wave (PO/BQ).
              </p>
            </fieldset>
            <div className="actions">
              <button type="submit" disabled={pending}>
                {editing === null ? 'Add contact' : 'Save changes'}
              </button>
              {editing !== null && (
                <button
                  type="button"
                  className="button--ghost"
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
          </form>
        </>
      )}

      {notice !== null && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function LocationsTab({ api, organisationId, canModify }: MastersProps) {
  const [includeRetired, setIncludeRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<LocationMaster | null>(null);

  const load = useCallback(
    (retired: boolean) => api.listLocationMasters(organisationId, retired),
    [api, organisationId],
  );
  const { rows, reload } = useMasterList(load, includeRetired, setError);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveLocationMaster(organisationId, editing?.id ?? null, {
        name: formValue(data, 'name').trim(),
        kind: (formValue(data, 'kind') || 'other') as LocationKind,
      });
      setNotice(editing === null ? 'Location added.' : 'Location updated.');
      setEditing(null);
      form.reset();
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The location could not be saved.'));
    } finally {
      setPending(false);
    }
  }

  async function setActive(row: LocationMaster, active: boolean) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.setLocationMasterActive(organisationId, row.id, active);
      setNotice(active ? `${row.name} reactivated.` : `${row.name} retired.`);
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The change could not be saved.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p className="muted">
        Stations, installation points, and stores referenced during delivery and
        installation work.
      </p>
      <RetiredFilter
        id="locations-retired"
        includeRetired={includeRetired}
        onChange={setIncludeRetired}
      />
      {rows === null ? (
        <p className="muted" role="status">
          Loading locations…
        </p>
      ) : rows.length === 0 ? (
        <p className="muted">No locations yet.</p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">Location masters</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              {canModify && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.name}</th>
                <td>{LOCATION_KIND_LABELS[row.kind]}</td>
                <td>
                  <StatusChip active={row.active} />
                </td>
                {canModify && (
                  <td>
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => {
                        setEditing(row);
                      }}
                    >
                      Edit
                    </button>{' '}
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => void setActive(row, !row.active)}
                    >
                      {row.active ? 'Retire' : 'Reactivate'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canModify && (
        <>
          <h2>{editing === null ? 'Add a location' : `Edit ${editing.name}`}</h2>
          <form key={editing?.id ?? 'new'} onSubmit={(event) => void save(event)}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="location-name">Name</label>
                <input
                  id="location-name"
                  name="name"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={editing?.name ?? ''}
                />
              </div>
              <div className="field">
                <label htmlFor="location-kind">Kind</label>
                <select
                  id="location-kind"
                  name="kind"
                  defaultValue={editing?.kind ?? 'station'}
                >
                  <option value="station">Station</option>
                  <option value="installation_point">Installation point</option>
                  <option value="store">Store</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
            <div className="actions">
              <button type="submit" disabled={pending}>
                {editing === null ? 'Add location' : 'Save changes'}
              </button>
              {editing !== null && (
                <button
                  type="button"
                  className="button--ghost"
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
          </form>
        </>
      )}

      {notice !== null && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function UnitsTab({ api, organisationId, canModify }: MastersProps) {
  const [includeRetired, setIncludeRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<UnitMaster | null>(null);

  const load = useCallback(
    (retired: boolean) => api.listUnitMasters(organisationId, retired),
    [api, organisationId],
  );
  const { rows, reload } = useMasterList(load, includeRetired, setError);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveUnitMaster(organisationId, editing?.id ?? null, {
        name: formValue(data, 'name').trim(),
      });
      setNotice(editing === null ? 'Unit added.' : 'Unit updated.');
      setEditing(null);
      form.reset();
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The unit could not be saved.'));
    } finally {
      setPending(false);
    }
  }

  async function setActive(row: UnitMaster, active: boolean) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.setUnitMasterActive(organisationId, row.id, active);
      setNotice(active ? `${row.name} reactivated.` : `${row.name} retired.`);
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The change could not be saved.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p className="muted">
        The standard units are added automatically on first use; retire the ones this
        organisation never uses and add any missing ones.
      </p>
      <RetiredFilter
        id="units-retired"
        includeRetired={includeRetired}
        onChange={setIncludeRetired}
      />
      {rows === null ? (
        <p className="muted" role="status">
          Loading units…
        </p>
      ) : rows.length === 0 ? (
        <p className="muted">No units yet.</p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">Unit masters</caption>
          <thead>
            <tr>
              <th scope="col">Unit</th>
              <th scope="col">Status</th>
              {canModify && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.name}</th>
                <td>
                  <StatusChip active={row.active} />
                </td>
                {canModify && (
                  <td>
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => {
                        setEditing(row);
                      }}
                    >
                      Edit
                    </button>{' '}
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => void setActive(row, !row.active)}
                    >
                      {row.active ? 'Retire' : 'Reactivate'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canModify && (
        <>
          <h2>{editing === null ? 'Add a unit' : `Edit ${editing.name}`}</h2>
          <form key={editing?.id ?? 'new'} onSubmit={(event) => void save(event)}>
            <div className="field">
              <label htmlFor="unit-name">Unit name</label>
              <input
                id="unit-name"
                name="name"
                required
                minLength={1}
                maxLength={100}
                defaultValue={editing?.name ?? ''}
              />
            </div>
            <div className="actions">
              <button type="submit" disabled={pending}>
                {editing === null ? 'Add unit' : 'Save changes'}
              </button>
              {editing !== null && (
                <button
                  type="button"
                  className="button--ghost"
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
          </form>
        </>
      )}

      {notice !== null && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function SignatoriesTab({ api, organisationId, canModify }: MastersProps) {
  const [includeRetired, setIncludeRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<Signatory | null>(null);

  const load = useCallback(
    (retired: boolean) => api.listSignatories(organisationId, retired),
    [api, organisationId],
  );
  const { rows, reload } = useMasterList(load, includeRetired, setError);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveSignatory(organisationId, editing?.id ?? null, {
        name: formValue(data, 'name').trim(),
        designation: formValue(data, 'designation').trim(),
      });
      setNotice(editing === null ? 'Signatory added.' : 'Signatory updated.');
      setEditing(null);
      form.reset();
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The signatory could not be saved.'));
    } finally {
      setPending(false);
    }
  }

  async function setActive(row: Signatory, active: boolean) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.setSignatoryActive(organisationId, row.id, active);
      setNotice(active ? `${row.name} reactivated.` : `${row.name} retired.`);
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The change could not be saved.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p className="muted">
        The people who sign generated documents for this organisation. Documents
        snapshot the chosen signatory, so retiring one never alters past records.
      </p>
      <RetiredFilter
        id="signatories-retired"
        includeRetired={includeRetired}
        onChange={setIncludeRetired}
      />
      {rows === null ? (
        <p className="muted" role="status">
          Loading signatories…
        </p>
      ) : rows.length === 0 ? (
        <p className="muted">No signatories yet.</p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">Organisation signatories</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Designation</th>
              <th scope="col">Status</th>
              {canModify && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.name}</th>
                <td>{row.designation}</td>
                <td>
                  <StatusChip active={row.active} />
                </td>
                {canModify && (
                  <td>
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => {
                        setEditing(row);
                      }}
                    >
                      Edit
                    </button>{' '}
                    <button
                      type="button"
                      className="button--ghost"
                      disabled={pending}
                      onClick={() => void setActive(row, !row.active)}
                    >
                      {row.active ? 'Retire' : 'Reactivate'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canModify && (
        <>
          <h2>{editing === null ? 'Add a signatory' : `Edit ${editing.name}`}</h2>
          <form key={editing?.id ?? 'new'} onSubmit={(event) => void save(event)}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="signatory-name">Name</label>
                <input
                  id="signatory-name"
                  name="name"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={editing?.name ?? ''}
                />
              </div>
              <div className="field">
                <label htmlFor="signatory-designation">Designation</label>
                <input
                  id="signatory-designation"
                  name="designation"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={editing?.designation ?? ''}
                />
              </div>
            </div>
            <div className="actions">
              <button type="submit" disabled={pending}>
                {editing === null ? 'Add signatory' : 'Save changes'}
              </button>
              {editing !== null && (
                <button
                  type="button"
                  className="button--ghost"
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
          </form>
        </>
      )}

      {notice !== null && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Master data: the reusable pick-lists behind document forms. Everything
 * here is a picker only — documents snapshot what was chosen, so master
 * edits never rewrite history; rows retire instead of being deleted. */
export function Masters({ api, organisationId, canModify }: MastersProps) {
  const [tab, setTab] = useState<MastersTab>('contacts');

  return (
    <section className="card card--wide" aria-labelledby="masters-title">
      <h1 id="masters-title" tabIndex={-1}>
        Masters
      </h1>
      <div className="tab-strip" role="tablist" aria-label="Master data categories">
        {TABS.map((candidate) => (
          <button
            key={candidate.key}
            type="button"
            role="tab"
            aria-selected={tab === candidate.key}
            className="tab-strip__tab"
            onClick={() => {
              setTab(candidate.key);
            }}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      {tab === 'contacts' && (
        <ContactsTab api={api} organisationId={organisationId} canModify={canModify} />
      )}
      {tab === 'locations' && (
        <LocationsTab api={api} organisationId={organisationId} canModify={canModify} />
      )}
      {tab === 'units' && (
        <UnitsTab api={api} organisationId={organisationId} canModify={canModify} />
      )}
      {tab === 'signatories' && (
        <SignatoriesTab
          api={api}
          organisationId={organisationId}
          canModify={canModify}
        />
      )}
    </section>
  );
}
