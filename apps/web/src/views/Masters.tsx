import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  Contact,
  LocationKind,
  LocationMaster,
  Signatory,
  UnitMaster,
} from '@auto-mb/contracts';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { StatusChip as Chip } from '../ui/chip.js';
import { Disclosure } from '../ui/disclosure.js';
import { Actions, Field, FieldRow, FormError, FormNotice, Hint } from '../ui/form.js';
import { DataTable, wrapCell } from '../ui/table.js';

interface MastersProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Owner/office may add, edit, retire, and reactivate; others read. */
  readonly canModify: boolean;
  /** Lifted so the sidebar can open a category directly. Omitted, the page
   * keeps its own tab â€” which is what the component tests rely on. */
  readonly tab?: MastersTab;
  readonly onTabChange?: (tab: MastersTab) => void;
}

export type { MastersTab };

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
    // the stored value unchanged, so only a CHANGED box travels â€” an
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
          : `${row.designation} retired â€” existing documents keep their snapshot.`,
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
          Loading contactsâ€¦
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">No contacts yet.</p>
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
                    .join(' Â· ') || 'â€”'}
                </td>
                <td>{row.gstin ?? 'â€”'}</td>
                <td className={wrapCell}>
                  {[row.contactPerson, row.phone, row.email]
                    .filter((part) => part !== null)
                    .join(' Â· ') || 'â€”'}
                </td>
                <td>
                  {row.isConsignee || row.isVendor || row.isClient ? (
                    <span className="flex flex-wrap gap-1">
                      {row.isConsignee && <Badge variant="neutral">consignee</Badge>}
                      {row.isVendor && <Badge variant="info">vendor</Badge>}
                      {row.isClient && <Badge variant="info">client</Badge>}
                    </span>
                  ) : (
                    'â€”'
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
          label="Add contact"
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
                  Railway units are TDS deductors â€” GSTINs ending in D are accepted.
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
                <ÛNü¶‰žËkºwµçE¹5½‘¥™ä€˜˜€ (€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ‘¥Ñ¥¹œ¡É½Ü¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€‘¥Ð(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ùìœ€ô(€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøÙ½¥Í•ÑÑ¥Ù”¡É½Ü°€…É½Ü¹…Ñ¥Ù”¥ô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€íÉ½Ü¹…Ñ¥Ù”€ü€I•Ñ¥É”œ€è€I•…Ñ¥Ù…Ñ”ô(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€¤¥ô(€€€€€€€€€€ð½Ñ‰½‘äø(€€€€€€€€ð½…Ñ…Q…‰±”ø(€€€€€€¥ô((€€€€€í…¹5½‘¥™ä€˜˜É½ÝÌ€„ôô¹Õ±°€˜˜€ (€€€€€€€€ñ5…ÍÑ•É½É´(€€€€€€€€€±…‰•°ô‰‘±½…Ñ¥½¸ˆ(€€€€€€€€€•‘¥Ñ¥¹Q¥Ñ±”õí•‘¥Ñ¥¹œ€ôôô¹Õ±°€ü¹Õ±°€è‘¥Ð€‘í•‘¥Ñ¥¹œ¹¹…µ•õô(€€€€€€€€€ÍÑ…ÉÑ=Á•¸õíÉ½ÝÌ¹±•¹Ñ €ôôô€Áô(€€€€€€€€ø(€€€€€€€€€€ñ™½É´­•äõí•‘¥Ñ¥¹œü¹¥€üü€¹•Üô½¹MÕ‰µ¥Ðõì¡•Ù•¹Ð¤€ôøÙ½¥Í…Ù”¡•Ù•¹Ð¥ôø(€€€€€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰±½…Ñ¥½¸µ¹…µ”ˆù9…µ”ð½±…‰•°ø(€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€¥ô‰±½…Ñ¥½¸µ¹…µ”ˆ(€€€€€€€€€€€€€€€€€¹…µ”ô‰¹…µ”ˆ(€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€µ¥¹1•¹Ñ õìÉô(€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÈÀÁô(€€€€€€€€€€€€€€€€€‘•™…Õ±ÑY…±Õ”õí•‘¥Ñ¥¹œü¹¹…µ”€üü€œô(€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰±½…Ñ¥½¸µ­¥¹ˆù-¥¹ð½±…‰•°ø(€€€€€€€€€€€€€€€€ñÍ•±•Ð(€€€€€€€€€€€€€€€€€¥ô‰±½…Ñ¥½¸µ­¥¹ˆ(€€€€€€€€€€€€€€€€€¹…µ”ô‰­¥¹ˆ(€€€€€€€€€€€€€€€€€‘•™…Õ±ÑY…±Õ”õí•‘¥Ñ¥¹œü¹­¥¹€üü€ÍÑ…Ñ¥½¸ô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰ÍÑ…Ñ¥½¸ˆùMÑ…Ñ¥½¸ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰¥¹ÍÑ…±±…Ñ¥½¹}Á½¥¹Ðˆù%¹ÍÑ…±±…Ñ¥½¸Á½¥¹Ðð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰ÍÑ½É”ˆùMÑ½É”ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰½Ñ¡•Èˆù=Ñ¡•Èð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€ð½Í•±•Ðø(€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥Ðˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€€€€€í•‘¥Ñ¥¹œ€ôôô¹Õ±°€ü€‘±½…Ñ¥½¸œ€è€M…Ù”¡…¹•Ìô(€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€í•‘¥Ñ¥¹œ€„ôô¹Õ±°€˜˜€ (€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ‘¥Ñ¥¹œ¡¹Õ±°¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€…¹•°•‘¥Ð(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€ð½™½É´ø(€€€€€€€€ð½5…ÍÑ•É½É´ø(€€€€€€¥ô((€€€€€í¹½Ñ¥”€„ôô¹Õ±°€˜˜€ñ½Éµ9½Ñ¥”ùí¹½Ñ¥•ôð½½Éµ9½Ñ¥”ùô(€€€€€í•ÉÉ½È€„ôô¹Õ±°€˜˜€ñ½ÉµÉÉ½Èùí•ÉÉ½Éôð½½ÉµÉÉ½Èùô(€€€€ð¼ø(€€¤ì)ô()™Õ¹Ñ¥½¸U¹¥ÑÍQ…ˆ¡ì…Á¤°½É…¹¥Í…Ñ¥½¹%°…¹5½‘¥™äôè5…ÍÑ•ÉÍAÉ½ÁÌ¤ì(€½¹ÍÐm¥¹±Õ‘•I•Ñ¥É•°Í•Ñ%¹±Õ‘•I•Ñ¥É•‘t€ôÕÍ•MÑ…Ñ”¡™…±Í”¤ì(€½¹ÍÐm•ÉÉ½È°Í•ÑÉÉ½Ét€ôÕÍ•MÑ…Ñ”ñÍÑÉ¥¹œð¹Õ±°ø¡¹Õ±°¤ì(€½¹ÍÐm¹½Ñ¥”°Í•Ñ9½Ñ¥•t€ôÕÍ•MÑ…Ñ”ñÍÑÉ¥¹œð¹Õ±°ø¡¹Õ±°¤ì(€½¹ÍÐmÁ•¹‘¥¹œ°Í•ÑA•¹‘¥¹t€ôÕÍ•MÑ…Ñ”¡™…±Í”¤ì(€½¹ÍÐm•‘¥Ñ¥¹œ°Í•Ñ‘¥Ñ¥¹t€ôÕÍ•MÑ…Ñ”ñU¹¥Ñ5…ÍÑ•Èð¹Õ±°ø¡¹Õ±°¤ì((€½¹ÍÐ±½…€ôÕÍ•…±±‰…¬ (€€€€¡É•Ñ¥É•è‰½½±•…¸¤€ôø…Á¤¹±¥ÍÑU¹¥Ñ5…ÍÑ•ÉÌ¡½É…¹¥Í…Ñ¥½¹%°É•Ñ¥É•¤°(€€€m…Á¤°½É…¹¥Í…Ñ¥½¹%‘t°(€€¤ì(€½¹ÍÐìÉ½ÝÌ°É•±½…ô€ôÕÍ•5…ÍÑ•É1¥ÍÐ¡±½…°¥¹±Õ‘•I•Ñ¥É•°Í•ÑÉÉ½È¤ì((€…Íå¹Œ™Õ¹Ñ¥½¸Í…Ù”¡•Ù•¹Ðè½ÉµÙ•¹Ðñ!Q51½Éµ±•µ•¹Ðø¤ì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€½¹ÍÐ™½É´€ô•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ðì(€€€½¹ÍÐ‘…Ñ„€ô¹•Ü½Éµ…Ñ„¡™½É´¤ì(€€€Í•ÑA•¹‘¥¹œ¡ÑÉÕ”¤ì(€€€Í•ÑÉÉ½È¡¹Õ±°¤ì(€€€Í•Ñ9½Ñ¥”¡¹Õ±°¤ì(€€€ÑÉäì(€€€€€…Ý…¥Ð…Á¤¹Í…Ù•U¹¥Ñ5…ÍÑ•È¡½É…¹¥Í…Ñ¥½¹%°•‘¥Ñ¥¹œü¹¥€üü¹Õ±°°ì(€€€€€€€¹…µ”è™½ÉµY…±Õ”¡‘…Ñ„°€¹…µ”œ¤¹ÑÉ¥´ ¤°(€€€€€ô¤ì(€€€€€Í•Ñ9½Ñ¥”¡•‘¥Ñ¥¹œ€ôôô¹Õ±°€ü€U¹¥Ð…‘‘•¸œ€è€U¹¥ÐÕÁ‘…Ñ•¸œ¤ì(€€€€€Í•Ñ‘¥Ñ¥¹œ¡¹Õ±°¤ì(€€€€€™½É´¹É•Í•Ð ¤ì(€€€€€É•±½… ¤ì(€€€ô…Ñ €¡…ÕÍ”¤ì(€€€€€Í•ÑÉÉ½È¡•ÉÉ½É5•ÍÍ…”¡…ÕÍ”°€Q¡”Õ¹¥Ð½Õ±¹½Ð‰”Í…Ù•¸œ¤¤ì(€€€ô™¥¹…±±äì(€€€€€Í•ÑA•¹‘¥¹œ¡™…±Í”¤ì(€€€ô(€ô((€…Íå¹Œ™Õ¹Ñ¥½¸Í•ÑÑ¥Ù”¡É½ÜèU¹¥Ñ5…ÍÑ•È°…Ñ¥Ù”è‰½½±•…¸¤ì(€€€Í•ÑA•¹‘¥¹œ¡ÑÉÕ”¤ì(€€€Í•ÑÉÉ½È¡¹Õ±°¤ì(€€€Í•Ñ9½Ñ¥”¡¹Õ±°¤ì(€€€ÑÉäì(€€€€€…Ý…¥Ð…Á¤¹Í•ÑU¹¥Ñ5…ÍÑ•ÉÑ¥Ù”¡½É…¹¥Í…Ñ¥½¹%°É½Ü¹¥°…Ñ¥Ù”¤ì(€€€€€Í•Ñ9½Ñ¥”¡…Ñ¥Ù”€ü€‘íÉ½Ü¹¹…µ•ôÉ•…Ñ¥Ù…Ñ•¹€€è€‘íÉ½Ü¹¹…µ•ôÉ•Ñ¥É•¹€¤ì(€€€€€É•±½… ¤ì(€€€ô…Ñ €¡…ÕÍ”¤ì(€€€€€Í•ÑÉÉ½È¡•ÉÉ½É5•ÍÍ…”¡…ÕÍ”°€Q¡”¡…¹”½Õ±¹½Ð‰”Í…Ù•¸œ¤¤ì(€€€ô™¥¹…±±äì(€€€€€Í•ÑA•¹‘¥¹œ¡™…±Í”¤ì(€€€ô(€ô((€É•ÑÕÉ¸€ (€€€€ðø(€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€Q¡”ÍÑ…¹‘…ÉÕ¹¥ÑÌ…É”…‘‘•…ÕÑ½µ…Ñ¥…±±ä½¸™¥ÉÍÐÕÍ”ìÉ•Ñ¥É”Ñ¡”½¹•ÌÑ¡¥Ì(€€€€€€€½É…¹¥Í…Ñ¥½¸¹•Ù•ÈÕÍ•Ì…¹…‘…¹äµ¥ÍÍ¥¹œ½¹•Ì¸(€€€€€€ð½Àø(€€€€€€ñI•Ñ¥É•‘¥±Ñ•È(€€€€€€€¥ô‰Õ¹¥ÑÌµÉ•Ñ¥É•ˆ(€€€€€€€¥¹±Õ‘•I•Ñ¥É•õí¥¹±Õ‘•I•Ñ¥É•‘ô(€€€€€€€½¹¡…¹”õíÍ•Ñ%¹±Õ‘•I•Ñ¥É•‘ô(€€€€€€¼ø(€€€€€íÉ½ÝÌ€ôôô¹Õ±°€ü€ (€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆÉ½±”ô‰ÍÑ…ÑÕÌˆø(€€€€€€€€€1½…‘¥¹œÕ¹¥ÑÏŠ˜(€€€€€€€€ð½Àø(€€€€€€¤€èÉ½ÝÌ¹±•¹Ñ €ôôô€À€ü€ (€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆù9¼Õ¹¥ÑÌå•Ð¸ð½Àø(€€€€€€¤€è€ (€€€€€€€€ñ…Ñ…Q…‰±”ø(€€€€€€€€€€ñ…ÁÑ¥½¸±…ÍÍ9…µ”ô‰ÍÈµ½¹±äˆùU¹¥Ðµ…ÍÑ•ÉÌð½…ÁÑ¥½¸ø(€€€€€€€€€€ñÑ¡•…ø(€€€€€€€€€€€€ñÑÈø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùU¹¥Ðð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùMÑ…ÑÕÌð½Ñ ø(€€€€€€€€€€€€€í…¹5½‘¥™ä€˜˜€ñÑ Í½Á”ô‰½°ˆùÑ¥½¹Ìð½Ñ ùô(€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€ð½Ñ¡•…ø(€€€€€€€€€€ñÑ‰½‘äø(€€€€€€€€€€€íÉ½ÝÌ¹µ…À ¡É½Ü¤€ôø€ (€€€€€€€€€€€€€€ñÑÈ­•äõíÉ½Ü¹¥‘ôø(€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰É½ÜˆùíÉ½Ü¹¹…µ•ôð½Ñ ø(€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€ñMÑ…ÑÕÍ¡¥À…Ñ¥Ù”õíÉ½Ü¹…Ñ¥Ù•ô€¼ø(€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€í…¹5½‘¥™ä€˜˜€ (€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ‘¥Ñ¥¹œ¡É½Ü¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€‘¥Ð(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ùìœ€ô(€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøÙ½¥Í•ÑÑ¥Ù”¡É½Ü°€…É½Ü¹…Ñ¥Ù”¥ô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€íÉ½Ü¹…Ñ¥Ù”€ü€I•Ñ¥É”œ€è€I•…Ñ¥Ù…Ñ”ô(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€¤¥ô(€€€€€€€€€€ð½Ñ‰½‘äø(€€€€€€€€ð½…Ñ…Q…‰±”ø(€€€€€€¥ô((€€€€€í…¹5½‘¥™ä€˜˜É½ÝÌ€„ôô¹Õ±°€˜˜€ (€€€€€€€€ñ5…ÍÑ•É½É´(€€€€€€€€€±…‰•°ô‰‘Õ¹¥Ðˆ(€€€€€€€€€•‘¥Ñ¥¹Q¥Ñ±”õí•‘¥Ñ¥¹œ€ôôô¹Õ±°€ü¹Õ±°€è‘¥Ð€‘í•‘¥Ñ¥¹œ¹¹…µ•õô(€€€€€€€€€ÍÑ…ÉÑ=Á•¸õíÉ½ÝÌ¹±•¹Ñ €ôôô€Áô(€€€€€€€€ø(€€€€€€€€€€ñ™½É´­•äõí•‘¥Ñ¥¹œü¹¥€üü€¹•Üô½¹MÕ‰µ¥Ðõì¡•Ù•¹Ð¤€ôøÙ½¥Í…Ù”¡•Ù•¹Ð¥ôø(€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰Õ¹¥Ðµ¹…µ”ˆùU¹¥Ð¹…µ”ð½±…‰•°ø(€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€¥ô‰Õ¹¥Ðµ¹…µ”ˆ(€€€€€€€€€€€€€€€¹…µ”ô‰¹…µ”ˆ(€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€µ¥¹1•¹Ñ õìÅô(€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÄÀÁô(€€€€€€€€€€€€€€€‘•™…Õ±ÑY…±Õ”õí•‘¥Ñ¥¹œü¹¹…µ”€üü€œô(€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥Ðˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€€€€€í•‘¥Ñ¥¹œ€ôôô¹Õ±°€ü€‘Õ¹¥Ðœ€è€M…Ù”¡…¹•Ìô(€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€í•‘¥Ñ¥¹œ€„ôô¹Õ±°€˜˜€ (€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ‘¥Ñ¥¹œ¡¹Õ±°¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€…¹•°•‘¥Ð(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€ð½™½É´ø(€€€€€€€€ð½5…ÍÑ•É½É´ø(€€€€€€¥ô((€€€€€í¹½Ñ¥”€„ôô¹Õ±°€˜˜€ñ½Éµ9½Ñ¥”ùí¹½Ñ¥•ôð½½Éµ9½Ñ¥”ùô(€€€€€í•ÉÉ½È€„ôô¹Õ±°€˜˜€ñ½ÉµÉÉ½Èùí•ÉÉ½Éôð½½ÉµÉÉ½Èùô(€€€€ð¼ø(€€¤ì)ô()™Õ¹Ñ¥½¸M¥¹…Ñ½É¥•ÍQ…ˆ¡ì…Á¤°½É…¹¥Í…Ñ¥½¹%°…¹5½‘¥™äôè5…ÍÑ•ÉÍAÉ½ÁÌ¤ì(€½¹ÍÐm¥¹±Õ‘•I•Ñ¥É•°Í•Ñ%¹±Õ‘•I•Ñ¥É•‘t€ôÕÍ•MÑ…Ñ”¡™…±Í”¤ì(€½¹ÍÐm•ÉÉ½È°Í•ÑÉÉ½Ét€ôÕÍ•MÑ…Ñ”ñÍÑÉ¥¹œð¹Õ±°ø¡¹Õ±°¤ì(€½¹ÍÐm¹½Ñ¥”°Í•Ñ9½Ñ¥•t€ôÕÍ•MÑ…Ñ”ñÍÑÉ¥¹œð¹Õ±°ø¡¹Õ±°¤ì(€½¹ÍÐmÁ•¹‘¥¹œ°Í•ÑA•¹‘¥¹t€ôÕÍ•MÑ…Ñ”¡™…±Í”¤ì(€½¹ÍÐm•‘¥Ñ¥¹œ°Í•Ñ‘¥Ñ¥¹t€ôÕÍ•MÑ…Ñ”ñM¥¹…Ñ½Éäð¹Õ±°ø¡¹Õ±°¤ì((€½¹ÍÐ±½…€ôÕÍ•…±±‰…¬ (€€€€¡É•Ñ¥É•è‰½½±•…¸¤€ôø…Á¤¹±¥ÍÑM¥¹…Ñ½É¥•Ì¡½É…¹¥Í…Ñ¥½¹%°É•Ñ¥É•¤°(€€€m…Á¤°½É…¹¥Í…Ñ¥½¹%‘t°(€€¤ì(€½¹ÍÐìÉ½ÝÌ°É•±½…ô€ôÕÍ•5…ÍÑ•É1¥ÍÐ¡±½…°¥¹±Õ‘•I•Ñ¥É•°Í•ÑÉÉ½È¤ì((€…Íå¹Œ™Õ¹Ñ¥½¸Í…Ù”¡•Ù•¹Ðè½ÉµÙ•¹Ðñ!Q51½Éµ±•µ•¹Ðø¤ì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€½¹ÍÐ™½É´€ô•Ù•¹Ð¹ÕÉÉ•¹ÑQ…É•Ðì(€€€½¹ÍÐ‘…Ñ„€ô¹•Ü½Éµ…Ñ„¡™½É´¤ì(€€€Í•ÑA•¹‘¥¹œ¡ÑÉÕ”¤ì(€€€Í•ÑÉÉ½È¡¹Õ±°¤ì(€€€Í•Ñ9½Ñ¥”¡¹Õ±°¤ì(€€€ÑÉäì(€€€€€…Ý…¥Ð…Á¤¹Í…Ù•M¥¹…Ñ½Éä¡½É…¹¥Í…Ñ¥½¹%°•‘¥Ñ¥¹œü¹¥€üü¹Õ±°°ì(€€€€€€€¹…µ”è™½ÉµY…±Õ”¡‘…Ñ„°€¹…µ”œ¤¹ÑÉ¥´ ¤°(€€€€€€€‘•Í¥¹…Ñ¥½¸è™½ÉµY…±Õ”¡‘…Ñ„°€‘•Í¥¹…Ñ¥½¸œ¤¹ÑÉ¥´ ¤°(€€€€€ô¤ì(€€€€€Í•Ñ9½Ñ¥”¡•‘¥Ñ¥¹œ€ôôô¹Õ±°€ü€M¥¹…Ñ½Éä…‘‘•¸œ€è€M¥¹…Ñ½ÉäÕÁ‘…Ñ•¸œ¤ì(€€€€€Í•Ñ‘¥Ñ¥¹œ¡¹Õ±°¤ì(€€€€€™½É´¹É•Í•Ð ¤ì(€€€€€É•±½… ¤ì(€€€ô…Ñ €¡…ÕÍ”¤ì(€€€€€Í•ÑÉÉ½È¡•ÉÉ½É5•ÍÍ…”¡…ÕÍ”°€Q¡”Í¥¹…Ñ½Éä½Õ±¹½Ð‰”Í…Ù•¸œ¤¤ì(€€€ô™¥¹…±±äì(€€€€€Í•ÑA•¹‘¥¹œ¡™…±Í”¤ì(€€€ô(€ô((€…Íå¹Œ™Õ¹Ñ¥½¸Í•ÑÑ¥Ù”¡É½ÜèM¥¹…Ñ½Éä°…Ñ¥Ù”è‰½½±•…¸¤ì(€€€Í•ÑA•¹‘¥¹œ¡ÑÉÕ”¤ì(€€€Í•ÑÉÉ½È¡¹Õ±°¤ì(€€€Í•Ñ9½Ñ¥”¡¹Õ±°¤ì(€€€ÑÉäì(€€€€€…Ý…¥Ð…Á¤¹Í•ÑM¥¹…Ñ½ÉåÑ¥Ù”¡½É…¹¥Í…Ñ¥½¹%°É½Ü¹¥°…Ñ¥Ù”¤ì(€€€€€Í•Ñ9½Ñ¥”¡…Ñ¥Ù”€ü€‘íÉ½Ü¹¹…µ•ôÉ•…Ñ¥Ù…Ñ•¹€€è€‘íÉ½Ü¹¹…µ•ôÉ•Ñ¥É•¹€¤ì(€€€€€É•±½… ¤ì(€€€ô…Ñ €¡…ÕÍ”¤ì(€€€€€Í•ÑÉÉ½È¡•ÉÉ½É5•ÍÍ…”¡…ÕÍ”°€Q¡”¡…¹”½Õ±¹½Ð‰”Í…Ù•¸œ¤¤ì(€€€ô™¥¹…±±äì(€€€€€Í•ÑA•¹‘¥¹œ¡™…±Í”¤ì(€€€ô(€ô((€É•ÑÕÉ¸€ (€€€€ðø(€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€Q¡”Á•½Á±”Ý¡¼Í¥¸•¹•É…Ñ•‘½Õµ•¹ÑÌ™½ÈÑ¡¥Ì½É…¹¥Í…Ñ¥½¸¸½Õµ•¹ÑÌ(€€€€€€€Í¹…ÁÍ¡½ÐÑ¡”¡½Í•¸Í¥¹…Ñ½Éä°Í¼É•Ñ¥É¥¹œ½¹”¹•Ù•È…±Ñ•ÉÌÁ…ÍÐÉ•½É‘Ì¸(€€€€€€ð½Àø(€€€€€€ñI•Ñ¥É•‘¥±Ñ•È(€€€€€€€¥ô‰Í¥¹…Ñ½É¥•ÌµÉ•Ñ¥É•ˆ(€€€€€€€¥¹±Õ‘•I•Ñ¥É•õí¥¹±Õ‘•I•Ñ¥É•‘ô(€€€€€€€½¹¡…¹”õíÍ•Ñ%¹±Õ‘•I•Ñ¥É•‘ô(€€€€€€¼ø(€€€€€íÉ½ÝÌ€ôôô¹Õ±°€ü€ (€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆÉ½±”ô‰ÍÑ…ÑÕÌˆø(€€€€€€€€€1½…‘¥¹œÍ¥¹…Ñ½É¥•ÏŠ˜(€€€€€€€€ð½Àø(€€€€€€¤€èÉ½ÝÌ¹±•¹Ñ €ôôô€À€ü€ (€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆù9¼Í¥¹…Ñ½É¥•Ìå•Ð¸ð½Àø(€€€€€€¤€è€ (€€€€€€€€ñ…Ñ…Q…‰±”ø(€€€€€€€€€€ñ…ÁÑ¥½¸±…ÍÍ9…µ”ô‰ÍÈµ½¹±äˆù=É…¹¥Í…Ñ¥½¸Í¥¹…Ñ½É¥•Ìð½…ÁÑ¥½¸ø(€€€€€€€€€€ñÑ¡•…ø(€€€€€€€€€€€€ñÑÈø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù9…µ”ð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù•Í¥¹…Ñ¥½¸ð½Ñ ø(€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùMÑ…ÑÕÌð½Ñ ø(€€€€€€€€€€€€€í…¹5½‘¥™ä€˜˜€ñÑ Í½Á”ô‰½°ˆùÑ¥½¹Ìð½Ñ ùô(€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€ð½Ñ¡•…ø(€€€€€€€€€€ñÑ‰½‘äø(€€€€€€€€€€€íÉ½ÝÌ¹µ…À ¡É½Ü¤€ôø€ (€€€€€€€€€€€€€€ñÑÈ­•äõíÉ½Ü¹¥‘ôø(€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰É½ÜˆùíÉ½Ü¹¹…µ•ôð½Ñ ø(€€€€€€€€€€€€€€€€ñÑùíÉ½Ü¹‘•Í¥¹…Ñ¥½¹ôð½Ñø(€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€ñMÑ…ÑÕÍ¡¥À…Ñ¥Ù”õíÉ½Ü¹…Ñ¥Ù•ô€¼ø(€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€í…¹5½‘¥™ä€˜˜€ (€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€Í•Ñ‘¥Ñ¥¹œ¡É½Ü¤ì(€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€‘¥Ð(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ùìœ€ô(€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€‘¥Í…‰±•õíÁ•¹‘¥¹ô(€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøÙ½¥Í•ÑÑ¥Ù”¡É½Ü°€…É½Ü¹…Ñ¥Ù”¥ô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€íÉ½Ü¹…Ñ¥Ù”€ü€I•Ñ¥É”œ€è€I•…Ñ¥Ù…Ñ”ô(€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€¤¥ô(€€€€€€€€€€ð½Ñ‰½‘äø(€€€€€€€€ð½…Ñ…Q…‰±”ø(€€€€€€¥ô((€€€€€í…¹5½‘¥™ä€˜˜É½ÝÌ€„ôô¹Õ±°€˜˜€ (€€€€€€€€ñ5…ÍÑ•É½É´(€€€€€€€€€±…‰•°ô‰‘Í¥¹…Ñ½Éäˆ(€€€€€€€€€•‘¥Ñ¥¹Q¥Ñ±”õí•‘¥Ñ¥¹œ€ôôô¹Õ±°€ü¹Õ±°€è‘¥Ð€‘í•‘¥Ñ¥¹œ¹¹…µ•õô(€€€€€€€€€ÍÑ…ÉÑ=Á•¸õíÉ½ÝÌ¹±•¹Ñ €ôôô€Áô(€€€€€€€€ø(€€€€€€€€€€ñ™½É´­•äõí•‘¥Ñ¥¹œü¹¥€üü€¹•Üô½¹MÕ‰µ¥Ðõì¡•Ù•¹Ð¤€ôøÙ½¥Í…Ù”¡•Ù•¹Ð¥ôø(€€€€€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰Í¥¹…Ñ½Éäµ¹…µ”ˆù9…µ”ð½±…‰•°ø(€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€¥ô‰Í¥¹…Ñ½Éäµ¹…µ”ˆ(€€€€€€€€€€€€€€€€€¹…µ”ô‰¹…µ”ˆ(€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€µ¥¹1•¹Ñ õìÉô(€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÈÀÁô(€€€€€€€€€€€€€€€€€‘•™…Õ±ÑY…±Õ”õí•‘¥Ñ¥¹œü¹¹…µ”€üü€œô(€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰Í¥¹…Ñ½Éäµ‘•Í¥¹…Ñ¥½¸ˆù•Í¥¹…Ñ¥½¸ð½±…‰•°ø(€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€¥ô‰Í¥¹…Ñ½Éäµ‘•Í¥¹…Ñ¥½¸ˆ(€€€€€€€€€€€€€€€€€¹…µ”ô‰‘•Í¥¹…Ñ¥½¸ˆ(€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€µ¥¹1•¹Ñ õìÉô(€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÈÀÁô(€€€€€€€€€€€€€€€€€‘•™…Õ±ÑY…±Õ”õí•‘¥Ñ¥¹œü¹‘•Í¥¹…Ñ¥½¸€üü€œô(€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥Ðˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€€€€€í•‘¥Ñ¥¹œ€ôôô¹Õ±°€ü€‘Í¥¹…Ñ½Éäœ€è€M…Ù”¡…¹•Ìô(€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€í•‘¥Ñ¥¹œ€„ôô¹Õ±°€˜˜€ (€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€Í•Ñ‘¥Ñ¥¹œ¡¹Õ±°¤ì(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€…¹•°•‘¥Ð(€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€€€ð½™½É´ø(€€€€€€€€ð½5…ÍÑ•É½É´ø(€€€€€€¥ô((€€€€€í¹½Ñ¥”€„ôô¹Õ±°€˜˜€ñ½Éµ9½Ñ¥”ùí¹½Ñ¥•ôð½½Éµ9½Ñ¥”ùô(€€€€€í•ÉÉ½È€„ôô¹Õ±°€˜˜€ñ½ÉµÉÉ½Èùí•ÉÉ½Éôð½½ÉµÉÉ½Èùô(€€€€ð¼ø(€€¤ì)ô((¼¨¨5…ÍÑ•È‘…Ñ„èÑ¡”É•ÕÍ…‰±”Á¥¬µ±¥ÍÑÌ‰•¡¥¹‘½Õµ•¹Ð™½ÉµÌ¸Ù•ÉåÑ¡¥¹œ(€¨¡•É”¥Ì„Á¥­•È½¹±äƒŠP‘½Õµ•¹ÑÌÍ¹…ÁÍ¡½ÐÝ¡…ÐÝ…Ì¡½Í•¸°Í¼µ…ÍÑ•È(€¨•‘¥ÑÌ¹•Ù•ÈÉ•ÝÉ¥Ñ”¡¥ÍÑ½ÉäìÉ½ÝÌÉ•Ñ¥É”¥¹ÍÑ•…½˜‰•¥¹œ‘•±•Ñ•¸€¨¼)•áÁ½ÉÐ™Õ¹Ñ¥½¸5…ÍÑ•ÉÌ¡ì(€…Á¤°(€½É…¹¥Í…Ñ¥½¹%°(€…¹5½‘¥™ä°(€Ñ…ˆè½¹ÑÉ½±±•‘Q…ˆ°(€½¹Q…‰¡…¹”°)ôè5…ÍÑ•ÉÍAÉ½ÁÌ¤ì(€½¹ÍÐm½Ý¹Q…ˆ°Í•Ñ=Ý¹Q…‰t€ôÕÍ•MÑ…Ñ”ñ5…ÍÑ•ÉÍQ…ˆø ½¹Ñ…ÑÌœ¤ì(€½¹ÍÐÑ…ˆ€ô½¹ÑÉ½±±•‘Q…ˆ€üü½Ý¹Q…ˆì(€½¹ÍÐÍ•ÑQ…ˆ€ô½¹Q…‰¡…¹”€üüÍ•Ñ=Ý¹Q…ˆì((€É•ÑÕÉ¸€ (€€€€ñ…É±…ÍÍ9…µ”ô‰Üµ™Õ±°ˆ…É¥„µ±…‰•±±•‘‰äô‰µ…ÍÑ•ÉÌµÑ¥Ñ±”ˆø(€€€€€€ñ Ä(€€€€€€€¥ô‰µ…ÍÑ•ÉÌµÑ¥Ñ±”ˆ(€€€€€€€Ñ…‰%¹‘•àõì´Åô(€€€€€€€±…ÍÍ9…µ”ô‰µˆ´ÈÑ•áÐ´Éá°±•…‘¥¹œ´à™½¹ÐµÍ•µ¥‰½±ÑÉ…­¥¹œµÑ¥¡ÐÑ•áÐµ‰…±…¹”ˆ(€€€€€€ø(€€€€€€€5…ÍÑ•ÉÌ(€€€€€€ð½ Äø(€€€€€€ñ‘¥Ø(€€€€€€€±…ÍÍ9…µ”ô‰µˆ´Ð™±•à…À´È‰½É‘•Èµˆ‰½É‘•Èµ‰½É‘•Èˆ(€€€€€€€É½±”ô‰Ñ…‰±¥ÍÐˆ(€€€€€€€…É¥„µ±…‰•°ô‰5…ÍÑ•È‘…Ñ„…Ñ•½É¥•Ìˆ(€€€€€€ø(€€€€€€€íQ	L¹µ…À ¡…¹‘¥‘…Ñ”¤€ôø€ (€€€€€€€€€€ñ‰ÕÑÑ½¸(€€€€€€€€€€€­•äõí…¹‘¥‘…Ñ”¹­•åô(€€€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ(€€€€€€€€€€€É½±”ô‰Ñ…ˆˆ(€€€€€€€€€€€…É¥„µÍ•±•Ñ•õíÑ…ˆ€ôôô…¹‘¥‘…Ñ”¹­•åô(€€€€€€€€€€€±…ÍÍ9…µ”ôˆµµˆµÁà‰½É‘•Èµˆ´È‰½É‘•ÈµÑÉ…¹ÍÁ…É•¹ÐÁà´ÌÁä´È™½¹Ðµµ•‘¥Õ´Ñ•áÐµµÕÑ•µ™½É•É½Õ¹¡½Ù•ÈéÑ•áÐµ™½É•É½Õ¹…É¥„µÍ•±•Ñ•é‰½É‘•ÈµÁÉ¥µ…Éä…É¥„µÍ•±•Ñ•éÑ•áÐµÁÉ¥µ…Éäˆ(€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€Í•ÑQ…ˆ¡…¹‘¥‘…Ñ”¹­•ä¤ì(€€€€€€€€€€€õô(€€€€€€€€€€ø(€€€€€€€€€€€í…¹‘¥‘…Ñ”¹±…‰•±ô(€€€€€€€€€€ð½‰ÕÑÑ½¸ø(€€€€€€€€¤¥ô(€€€€€€ð½‘¥Øø(€€€€€íÑ…ˆ€ôôô€½¹Ñ…ÑÌœ€˜˜€ (€€€€€€€€ñ½¹Ñ…ÑÍQ…ˆ…Á¤õí…Á¥ô½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¹%‘ô…¹5½‘¥™äõí…¹5½‘¥™åô€¼ø(€€€€€€¥ô(€€€€€íÑ…ˆ€ôôô€±½…Ñ¥½¹Ìœ€˜˜€ (€€€€€€€€ñ1½…Ñ¥½¹ÍQ…ˆ…Á¤õí…Á¥ô½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¹%‘ô…¹5½‘¥™äõí…¹5½‘¥™åô€¼ø(€€€€€€¥ô(€€€€€íÑ…ˆ€ôôô€Õ¹¥ÑÌœ€˜˜€ (€€€€€€€€ñU¹¥ÑÍQ…ˆ…Á¤õí…Á¥ô½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¹%‘ô…¹5½‘¥™äõí…¹5½‘¥™åô€¼ø(€€€€€€¥ô(€€€€€íÑ…ˆ€ôôô€Í¥¹…Ñ½É¥•Ìœ€˜˜€ (€€€€€€€€ñM¥¹…Ñ½É¥•ÍQ…ˆ(€€€€€€€€€…Á¤õí…Á¥ô(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%õí½É…¹¥Í…Ñ¥½¹%‘ô(€€€€€€€€€…¹5½‘¥™äõí…¹5½‘¥™åô(€€€€€€€€¼ø(€€€€€€¥ô(€€€€ð½…Éø(€€¤ì)ô