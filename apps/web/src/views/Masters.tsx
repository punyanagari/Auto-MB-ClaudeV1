import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  Contact,
  GstRateMaster,
  LocationKind,
  LocationMaster,
  Signatory,
  UnitMaster,
} from '@auto-mb/contracts';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { StatusChip as Chip } from '../ui/chip.js';
import { DateField } from '../ui/date-field.js';
import { Disclosure } from '../ui/disclosure.js';
import { Actions, Field, FieldRow, FormError, FormNotice, Hint } from '../ui/form.js';
import { DataTable, wrapCell } from '../ui/table.js';

interface MastersProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Owner/office may add, edit, retire, and reactivate; others read. */
  readonly canModify: boolean;
  /** GST rate mutations are OWNER-only server-side — the master decides
   * what a legal document may say. Omitted means not an owner. */
  readonly isOwner?: boolean;
  /** Lifted so the sidebar can open a category directly. Omitted, the page
   * keeps its own tab — which is what the component tests rely on. */
  readonly tab?: MastersTab;
  readonly onTabChange?: (tab: MastersTab) => void;
}

export type { MastersTab };

type MastersTab = 'contacts' | 'locations' | 'units' | 'signatories' | 'gst-rates';

const TABS: readonly { key: MastersTab; label: string }[] = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'locations', label: 'Locations' },
  { key: 'units', label: 'Units' },
  { key: 'signatories', label: 'Signatories' },
  { key: 'gst-rates', label: 'GST rates' },
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
    <Chip status={active ? 'active' : 'failed'}>{active ? 'active' : 'retired'}</Chip>
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
    <label className="text-muted-foreground" htmlFor={id}>
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

/**
 * An empty master list, said in terms of what it is FOR.
 *
 * "No contacts yet." is true and useless: it names the absence, not what
 * the absence costs or what to do about it. Each tab passes the sentence
 * that says which document stalls without this list, and — when the
 * operator may write — points at the create form that this same emptiness
 * has already opened below (`MasterForm startOpen`). A read-only member is
 * told who fills it instead of being sent to a form they cannot submit.
 */
function EmptyMaster({
  purpose,
  action,
  canModify,
  readOnlyNote,
}: {
  /** One operational sentence: what this list is used by. */
  readonly purpose: string;
  /** The label on the create form below, so the eye has somewhere to go. */
  readonly action: string;
  readonly canModify: boolean;
  /** Who may fill it, when the reader may not. Overridden where the
   * permission is narrower than owner-or-office. */
  readonly readOnlyNote?: string;
}) {
  return (
    <p className="my-3 text-[13px] text-muted-foreground">
      {purpose}{' '}
      {canModify
        ? `The "${action}" form below is open and ready.`
        : (readOnlyNote ?? 'An owner or office member adds the first entry.')}
    </p>
  );
}

/** Where a tab's one form sits. Adding is secondary to the list that fills
 * the tab, so it waits behind the verb from its own submit button. Editing
 * is not: the row's Edit button has already asked for the form, and while a
 * row is being edited the form is the whole point of the tab, so it renders
 * open under the name of what is being changed. */
function MasterForm({
  label,
  editingTitle,
  startOpen,
  children,
}: {
  readonly label: string;
  readonly editingTitle: string | null;
  readonly startOpen: boolean;
  readonly children: ReactNode;
}) {
  if (editingTitle !== null) {
    return (
      <>
        <h2 className="mt-6 mb-2 text-sm font-semibold">{editingTitle}</h2>
        {children}
      </>
    );
  }
  return (
    <Disclosure label={label} startOpen={startOpen}>
      {children}
    </Disclosure>
  );
}

function ContactsTab({ api, organisationId, canModify }: MastersProps) {
  const [includeRetired, setIncludeRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  /** Controlled, so the derived consignee box can answer live: a NEW
   * contact is a consignee exactly when neither procurement role is
   * asked for (the create-time rule in masters.ts). */
  const [roleVendor, setRoleVendor] = useState(false);
  const [roleClient, setRoleClient] = useState(false);

  const startEditing = (row: Contact | null) => {
    setEditing(row);
    setRoleVendor(row?.isVendor ?? false);
    setRoleClient(row?.isClient ?? false);
  };

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
    const locality = optional('locality');
    const divisionCode = optional('divisionCode');
    // Role flags are membership, not profile text: an omitted flag leaves
    // the stored value unchanged, so only a CHANGED box travels — an
    // untouched form still sends exactly what it always sent.
    const wasVendor = editing?.isVendor ?? false;
    const wasClient = editing?.isClient ?? false;
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
        ...(locality !== undefined ? { locality } : {}),
        ...(divisionCode !== undefined ? { divisionCode } : {}),
        ...(roleVendor !== wasVendor ? { isVendor: roleVendor } : {}),
        ...(roleClient !== wasClient ? { isClient: roleClient } : {}),
      });
      setNotice(editing === null ? 'Contact added.' : 'Contact updated.');
      startEditing(null);
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
      <p className="text-muted-foreground">
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
        <p className="text-muted-foreground" role="status">
          Loading contacts…
        </p>
      ) : rows.length === 0 ? (
        <EmptyMaster
          purpose="No contacts yet. A delivery challan needs a consignee, a purchase order needs a vendor, and a tax invoice needs a client — all of them are records in this one list."
          action="New contact"
          canModify={canModify}
        />
      ) : (
        <DataTable>
          <caption className="sr-only">
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
                <td className={wrapCell}>
                  {[
                    row.address,
                    row.pincode,
                    row.locality,
                    row.stateCode ? `State ${row.stateCode}` : null,
                  ]
                    .filter((part) => part !== null && part !== undefined)
                    .join(' · ') || '—'}
                </td>
                <td>{row.gstin ?? '—'}</td>
                <td className={wrapCell}>
                  {[row.contactPerson, row.phone, row.email]
                    .filter((part) => part !== null)
                    .join(' · ') || '—'}
                </td>
                <td>
                  {row.isConsignee || row.isVendor || row.isClient ? (
                    <span className="flex flex-wrap gap-1">
                      {row.isConsignee && <Badge variant="neutral">consignee</Badge>}
                      {row.isVendor && <Badge variant="info">vendor</Badge>}
                      {row.isClient && <Badge variant="info">client</Badge>}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <StatusChip active={row.active} />
                </td>
                {canModify && (
                  <td>
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        startEditing(row);
                      }}
                    >
                      Edit
                    </Button>{' '}
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void setActive(row, !row.active)}
                    >
                      {row.active ? 'Retire' : 'Reactivate'}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {canModify && rows !== null && (
        <MasterForm
          label="New contact"
          editingTitle={editing === null ? null : `Edit ${editing.designation}`}
          startOpen={rows.length === 0}
        >
          <form key={editing?.id ?? 'new'} onSubmit={(event) => void save(event)}>
            <FieldRow>
              <Field>
                <label htmlFor="contact-designation">Designation / name</label>
                <input
                  id="contact-designation"
                  name="designation"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={editing?.designation ?? ''}
                />
              </Field>
              <Field>
                <label htmlFor="contact-person">Contact person (optional)</label>
                <input
                  id="contact-person"
                  name="contactPerson"
                  maxLength={200}
                  defaultValue={editing?.contactPerson ?? ''}
                />
              </Field>
            </FieldRow>
            <Field>
              <label htmlFor="contact-address">Address (optional)</label>
              <textarea
                id="contact-address"
                name="address"
                rows={2}
                maxLength={1000}
                defaultValue={editing?.address ?? ''}
              />
            </Field>
            <FieldRow>
              <Field>
                <label htmlFor="contact-gstin">GSTIN (optional)</label>
                <input
                  id="contact-gstin"
                  name="gstin"
                  minLength={15}
                  maxLength={15}
                  defaultValue={editing?.gstin ?? ''}
                  aria-describedby="contact-gstin-hint"
                />
                <p className="text-muted-foreground" id="contact-gstin-hint">
                  Railway units are TDS deductors — GSTINs ending in D are accepted.
                </p>
              </Field>
              <Field>
                <label htmlFor="contact-pincode">Pincode (optional)</label>
                <input
                  id="contact-pincode"
                  name="pincode"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  defaultValue={editing?.pincode ?? ''}
                />
              </Field>
              <Field>
                <label htmlFor="contact-locality">Locality / city (optional)</label>
                <input
                  id="contact-locality"
                  name="locality"
                  minLength={2}
                  maxLength={100}
                  defaultValue={editing?.locality ?? ''}
                />
                <Hint>Exact NIC locality; never inferred from the address.</Hint>
              </Field>
              <Field>
                <label htmlFor="contact-division-code">Division code</label>
                <input
                  id="contact-division-code"
                  name="divisionCode"
                  inputMode="numeric"
                  pattern="[0-9]{2,5}"
                  maxLength={5}
                  defaultValue={editing?.divisionCode ?? ''}
                />
                <Hint>
                  As the railnet directory writes it. A number series can draw on it.
                </Hint>
              </Field>
              <Field>
                <label htmlFor="contact-state-code">State code (optional)</label>
                <input
                  id="contact-state-code"
                  name="stateCode"
                  pattern="[0-9]{2}"
                  maxLength={2}
                  defaultValue={editing?.stateCode ?? ''}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field>
                <label htmlFor="contact-phone">Phone (optional)</label>
                <input
                  id="contact-phone"
                  name="phone"
                  maxLength={30}
                  defaultValue={editing?.phone ?? ''}
                />
              </Field>
              <Field>
                <label htmlFor="contact-email">Email (optional)</label>
                <input
                  id="contact-email"
                  name="email"
                  type="email"
                  maxLength={200}
                  defaultValue={editing?.email ?? ''}
                />
              </Field>
            </FieldRow>
            <fieldset className="my-3 flex max-w-[34rem] flex-col gap-1.5 [&>label]:text-[13px] [&>label]:font-medium">
              <legend>Roles</legend>
              {/* Consignee is a create-time fact, never a request field: a
               * new contact is one exactly when neither procurement role is
               * asked for, and an edit cannot change it — so the box only
               * reports, live against the two boxes that decide it. */}
              <label htmlFor="contact-role-consignee">
                <input
                  id="contact-role-consignee"
                  type="checkbox"
                  checked={
                    editing === null ? !roleVendor && !roleClient : editing.isConsignee
                  }
                  disabled
                  readOnly
                />{' '}
                Consignee
              </label>{' '}
              <label htmlFor="contact-role-vendor">
                <input
                  id="contact-role-vendor"
                  type="checkbox"
                  checked={roleVendor}
                  onChange={(event) => {
                    setRoleVendor(event.currentTarget.checked);
                  }}
                />{' '}
                Vendor
              </label>{' '}
              <label htmlFor="contact-role-client">
                <input
                  id="contact-role-client"
                  type="checkbox"
                  checked={roleClient}
                  onChange={(event) => {
                    setRoleClient(event.currentTarget.checked);
                  }}
                />{' '}
                Client
              </label>
              <p className="text-muted-foreground">
                Vendors take purchase orders; clients buy under tax invoices. A new
                contact with neither role is a consignee for railway document flows —
                fixed at creation.
              </p>
            </fieldset>
            <Actions>
              <Button type="submit" disabled={pending}>
                {editing === null ? 'Add contact' : 'Save changes'}
              </Button>
              {editing !== null && (
                <Button
                  variant="outline"
                  onClick={() => {
                    startEditing(null);
                  }}
                >
                  Cancel edit
                </Button>
              )}
            </Actions>
          </form>
        </MasterForm>
      )}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {error !== null && <FormError>{error}</FormError>}
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
      <p className="text-muted-foreground">
        Stations, installation points, and stores referenced during delivery and
        installation work.
      </p>
      <RetiredFilter
        id="locations-retired"
        includeRetired={includeRetired}
        onChange={setIncludeRetired}
      />
      {rows === null ? (
        <p className="text-muted-foreground" role="status">
          Loading locations…
        </p>
      ) : rows.length === 0 ? (
        <EmptyMaster
          purpose="No locations yet. Recording a delivery or an installation asks where it happened, and this list is what that question offers."
          action="New location"
          canModify={canModify}
        />
      ) : (
        <DataTable>
          <caption className="sr-only">Location masters</caption>
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
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        setEditing(row);
                      }}
                    >
                      Edit
                    </Button>{' '}
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void setActive(row, !row.active)}
                    >
                      {row.active ? 'Retire' : 'Reactivate'}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {canModify && rows !== null && (
        <MasterForm
          label="New location"
          editingTitle={editing === null ? null : `Edit ${editing.name}`}
          startOpen={rows.length === 0}
        >
          <form key={editing?.id ?? 'new'} onSubmit={(event) => void save(event)}>
            <FieldRow>
              <Field>
                <label htmlFor="location-name">Name</label>
                <input
                  id="location-name"
                  name="name"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={editing?.name ?? ''}
                />
              </Field>
              <Field>
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
              </Field>
            </FieldRow>
            <Actions>
              <Button type="submit" disabled={pending}>
                {editing === null ? 'Add location' : 'Save changes'}
              </Button>
              {editing !== null && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  Cancel edit
                </Button>
              )}
            </Actions>
          </form>
        </MasterForm>
      )}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {error !== null && <FormError>{error}</FormError>}
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
      <p className="text-muted-foreground">
        The standard units are added automatically on first use; retire the ones this
        organisation never uses and add any missing ones.
      </p>
      <RetiredFilter
        id="units-retired"
        includeRetired={includeRetired}
        onChange={setIncludeRetired}
      />
      {rows === null ? (
        <p className="text-muted-foreground" role="status">
          Loading units…
        </p>
      ) : rows.length === 0 ? (
        <EmptyMaster
          purpose="No units yet. The standard set (Nos, Metre, RKM and the rest) is created the first time a confirmed LOA uses one, so this list normally fills itself — add one here only when a letter prints a unit the standard set has no name for."
          action="New unit"
          canModify={canModify}
        />
      ) : (
        <DataTable>
          <caption className="sr-only">Unit masters</caption>
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
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        setEditing(row);
                      }}
                    >
                      Edit
                    </Button>{' '}
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void setActive(row, !row.active)}
                    >
                      {row.active ? 'Retire' : 'Reactivate'}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {canModify && rows !== null && (
        <MasterForm
          label="New unit"
          editingTitle={editing === null ? null : `Edit ${editing.name}`}
          startOpen={rows.length === 0}
        >
          <form key={editing?.id ?? 'new'} onSubmit={(event) => void save(event)}>
            <Field>
              <label htmlFor="unit-name">Unit name</label>
              <input
                id="unit-name"
                name="name"
                required
                minLength={1}
                maxLength={100}
                defaultValue={editing?.name ?? ''}
              />
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                {editing === null ? 'Add unit' : 'Save changes'}
              </Button>
              {editing !== null && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  Cancel edit
                </Button>
              )}
            </Actions>
          </form>
        </MasterForm>
      )}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {error !== null && <FormError>{error}</FormError>}
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
      <p className="text-muted-foreground">
        The people who sign generated documents for this organisation. Documents
        snapshot the chosen signatory, so retiring one never alters past records.
      </p>
      <RetiredFilter
        id="signatories-retired"
        includeRetired={includeRetired}
        onChange={setIncludeRetired}
      />
      {rows === null ? (
        <p className="text-muted-foreground" role="status">
          Loading signatories…
        </p>
      ) : rows.length === 0 ? (
        <EmptyMaster
          purpose="No signatories yet. Every generated document prints a name and designation under the signature block, and it is chosen from this list."
          action="New signatory"
          canModify={canModify}
        />
      ) : (
        <DataTable>
          <caption className="sr-only">Organisation signatories</caption>
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
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        setEditing(row);
                      }}
                    >
                      Edit
                    </Button>{' '}
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void setActive(row, !row.active)}
                    >
                      {row.active ? 'Retire' : 'Reactivate'}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {canModify && rows !== null && (
        <MasterForm
          label="New signatory"
          editingTitle={editing === null ? null : `Edit ${editing.name}`}
          startOpen={rows.length === 0}
        >
          <form key={editing?.id ?? 'new'} onSubmit={(event) => void save(event)}>
            <FieldRow>
              <Field>
                <label htmlFor="signatory-name">Name</label>
                <input
                  id="signatory-name"
                  name="name"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={editing?.name ?? ''}
                />
              </Field>
              <Field>
                <label htmlFor="signatory-designation">Designation</label>
                <input
                  id="signatory-designation"
                  name="designation"
                  required
                  minLength={2}
                  maxLength={200}
                  defaultValue={editing?.designation ?? ''}
                />
              </Field>
            </FieldRow>
            <Actions>
              <Button type="submit" disabled={pending}>
                {editing === null ? 'Add signatory' : 'Save changes'}
              </Button>
              {editing !== null && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  Cancel edit
                </Button>
              )}
            </Actions>
          </form>
        </MasterForm>
      )}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {error !== null && <FormError>{error}</FormError>}
    </>
  );
}

function GstRatesTab({ api, organisationId, isOwner = false }: MastersProps) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ending, setEnding] = useState<GstRateMaster | null>(null);

  const load = useCallback(
    () => api.listGstRates(organisationId),
    [api, organisationId],
  );
  const { rows, reload } = useMasterList(load, false, setError);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const effectiveTo = formValue(data, 'effectiveTo');
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.createGstRate(organisationId, {
        rate: formValue(data, 'rate').trim(),
        label: formValue(data, 'label').trim(),
        effectiveFrom: formValue(data, 'effectiveFrom'),
        ...(effectiveTo === '' ? {} : { effectiveTo }),
      });
      setNotice('GST rate recorded.');
      form.reset();
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The GST rate could not be recorded.'));
    } finally {
      setPending(false);
    }
  }

  async function endDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ending === null) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.endDateGstRate(organisationId, ending.id, {
        effectiveTo: formValue(data, 'endingEffectiveTo'),
      });
      setNotice(`${ending.rate}% end-dated. History stays covered for old invoices.`);
      setEnding(null);
      reload();
    } catch (cause) {
      setError(errorMessage(cause, 'The GST rate could not be end-dated.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p className="text-muted-foreground">
        The Government-notified GST rates, each with the dates it was in force. Invoices
        and quotations only accept a rate this list covers on the document date. A rate
        leaves force by end-dating — rows are never edited or deleted, so old invoices
        stay explainable. Changes are owner-only.
      </p>
      {rows === null ? (
        <p className="text-muted-foreground" role="status">
          Loading GST rates…
        </p>
      ) : rows.length === 0 ? (
        <EmptyMaster
          purpose="No notified rates recorded yet. An invoice or quotation refuses any rate this list does not cover on the document date, so the rates in force for the periods you bill have to be here first."
          action="New notified rate"
          canModify={isOwner}
          readOnlyNote="Only an owner records a notified rate — the master decides what a legal document may say."
        />
      ) : (
        <DataTable>
          <caption className="sr-only">Notified GST rates and their windows</caption>
          <thead>
            <tr>
              <th scope="col">Rate</th>
              <th scope="col">Label</th>
              <th scope="col">In force from</th>
              <th scope="col">In force until</th>
              {isOwner && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.rate}%</th>
                <td className={wrapCell}>{row.label}</td>
                <td>{formatDate(row.effectiveFrom)}</td>
                <td>
                  {row.effectiveTo === null ? 'open' : formatDate(row.effectiveTo)}
                </td>
                {isOwner && (
                  <td>
                    {row.effectiveTo === null ? (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() => {
                          setEnding(row);
                        }}
                      >
                        End-date
                      </Button>
                    ) : (
                      '—'
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {isOwner && ending !== null && (
        <form onSubmit={(event) => void endDate(event)}>
          <DateField
            id="gst-rate-ending"
            name="endingEffectiveTo"
            required
            label={`Last date ${ending.rate}% is in force`}
            hint={`Invoices dated on or before it keep accepting ${ending.rate}%; later ones refuse it.`}
          />
          <Actions>
            <Button type="submit" disabled={pending}>
              End-date {ending.rate}%
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setEnding(null);
              }}
            >
              Cancel
            </Button>
          </Actions>
        </form>
      )}

      {isOwner && rows !== null && ending === null && (
        <MasterForm
          label="New notified rate"
          editingTitle={null}
          startOpen={rows.length === 0}
        >
          <form onSubmit={(event) => void create(event)}>
            <FieldRow>
              <Field>
                <label htmlFor="gst-rate-rate">Rate (%)</label>
                <input
                  id="gst-rate-rate"
                  name="rate"
                  inputMode="decimal"
                  required
                  placeholder="18"
                />
              </Field>
              <Field>
                <label htmlFor="gst-rate-label">Label</label>
                <input
                  id="gst-rate-label"
                  name="label"
                  required
                  minLength={2}
                  maxLength={100}
                  placeholder="Standard 18%"
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <DateField
                id="gst-rate-from"
                name="effectiveFrom"
                required
                label="In force from"
              />
              <DateField
                id="gst-rate-to"
                name="effectiveTo"
                label="In force until (optional)"
                hint="Leave empty while the notification has no announced end."
              />
            </FieldRow>
            <Actions>
              <Button type="submit" disabled={pending}>
                Record rate
              </Button>
            </Actions>
          </form>
        </MasterForm>
      )}

      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {error !== null && <FormError>{error}</FormError>}
    </>
  );
}

/** Master data: the reusable pick-lists behind document forms. Everything
 * here is a picker only — documents snapshot what was chosen, so master
 * edits never rewrite history; rows retire instead of being deleted. */
export function Masters({
  api,
  organisationId,
  canModify,
  isOwner = false,
  tab: controlledTab,
  onTabChange,
}: MastersProps) {
  const [ownTab, setOwnTab] = useState<MastersTab>('contacts');
  const tab = controlledTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;

  return (
    <Card className="w-full" aria-labelledby="masters-title">
      <h1 id="masters-title" tabIndex={-1}>
        Masters
      </h1>
      <div
        className="mb-4 flex gap-2 border-b border-border"
        role="tablist"
        aria-label="Master data categories"
      >
        {TABS.map((candidate) => (
          <button
            key={candidate.key}
            type="button"
            role="tab"
            aria-selected={tab === candidate.key}
            className="-mb-px border-b-2 border-transparent px-3 py-2 font-medium text-muted-foreground hover:text-foreground aria-selected:border-primary aria-selected:text-primary"
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
      {tab === 'gst-rates' && (
        <GstRatesTab
          api={api}
          organisationId={organisationId}
          canModify={canModify}
          isOwner={isOwner}
        />
      )}
    </Card>
  );
}
