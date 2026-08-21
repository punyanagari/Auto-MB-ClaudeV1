import {
  CanonicalItemListResponseSchema,
  CanonicalItemSchema,
  ContactAddressSchema,
  ContactListResponseSchema,
  ContactSchema,
  CreateGstRateRequestSchema,
  EndDateGstRateRequestSchema,
  GstRateListResponseSchema,
  GstRateMasterSchema,
  LinkWorkConsigneeRequestSchema,
  LocationMasterListResponseSchema,
  LocationMasterSchema,
  SaveCanonicalItemRequestSchema,
  SaveContactAddressRequestSchema,
  SaveContactRequestSchema,
  SaveLocationMasterRequestSchema,
  SaveSignatoryRequestSchema,
  SaveUnitMasterRequestSchema,
  SignatoryListResponseSchema,
  SignatorySchema,
  UnitMasterListResponseSchema,
  UnitMasterSchema,
  WorkConsigneeListResponseSchema,
  type CanonicalItem,
  type Contact,
  type ContactAddress,
  type GstRateMaster,
  type LocationMaster,
  type Signatory,
  type UnitMaster,
  type ErrorCode,
} from '@auto-mb/contracts';
import { CANONICAL_UNIT_NAMES } from '@auto-mb/loa-parser';
import { Type, type TSchema } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import {
  assertNotAuthorityDesignation,
  normaliseContactBankDetails,
  normaliseEmail,
  normaliseGstin,
} from '../contact-fields.js';
import { httpError } from '../http.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * Contract-domain master data: the unified Contacts master (consignee,
 * vendor and client role flags — legacy §9, woken fully by the
 * procurement wave §5.8), the Work↔consignee association, locations,
 * units, and organisation signatories. Masters are PICKERS ONLY —
 * documents snapshot whatever the
 * user confirms into their own columns (the Delivery Challan consignee
 * stays a free-text snapshot; the PAC certificate snapshots the
 * designation), so master edits and retirements never rewrite history.
 *
 * Lifecycle: create → update → retire → reactivate. Retiring only clears
 * the active flag (always allowed, always reversible); a hard delete does
 * not exist — the application role holds no DELETE privilege on any
 * masters table (migrations 0013/0028). The Work↔consignee association is
 * the one deletable row here: it is a preference list, not a document.
 *
 * Roles: every member may read (pickers serve viewers too); mutations are
 * owner/office. Every mutation is audited.
 */

/** Retired masters stay out of pickers unless explicitly requested. */
const ListQuerySchema = Type.Object(
  { includeRetired: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23505';
}

// --- Contacts (unified master, legacy §9) -----------------------------------

interface ContactRow {
  id: string;
  designation: string;
  contact_person: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  pincode: string | null;
  state_code: string | null;
  locality: string | null;
  division_code: string | null;
  is_consignee: boolean;
  is_vendor: boolean;
  is_client: boolean;
  bank_account_holder: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_branch: string | null;
  bank_account_type: string | null;
  is_employee: boolean;
  pan: string | null;
  active: boolean;
  created_at: Date;
}

/** One row of the address list (migration 0116). */
interface ContactAddressRow {
  id: string;
  contact_id: string;
  label: string | null;
  address: string;
  pincode: string | null;
  locality: string | null;
  state_code: string | null;
  is_primary: boolean;
  sort_order: number;
  active: boolean;
}

const CONTACT_ADDRESS_COLUMNS = `
  id, contact_id, label, address, pincode, locality, state_code, is_primary,
  sort_order, active
`;

/** Primary first, then live addresses in the operator's order, then the
 * retired ones — the order every picker renders and the order the
 * register reads. Written once here rather than in each query's ORDER BY
 * so the two cannot disagree about which address is offered first. */
const CONTACT_ADDRESS_ORDER = `
  is_primary desc, active desc, sort_order, lower(coalesce(label, '')), id
`;

function toContactAddress(row: ContactAddressRow): ContactAddress {
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    pincode: row.pincode,
    locality: row.locality,
    stateCode: row.state_code,
    isPrimary: row.is_primary,
    sortOrder: Number(row.sort_order),
    active: row.active,
  };
}

function toContact(
  row: ContactRow,
  addresses: readonly ContactAddressRow[] = [],
): Contact {
  return {
    addresses: addresses
      .filter((address) => address.contact_id === row.id)
      .map(toContactAddress),
    id: row.id,
    designation: row.designation,
    contactPerson: row.contact_person,
    address: row.address,
    phone: row.phone,
    email: row.email,
    gstin: row.gstin,
    pincode: row.pincode,
    stateCode: row.state_code,
    locality: row.locality,
    divisionCode: row.division_code,
    isConsignee: row.is_consignee,
    isVendor: row.is_vendor,
    isClient: row.is_client,
    bankAccountHolder: row.bank_account_holder,
    bankName: row.bank_name,
    bankAccountNumber: row.bank_account_number,
    bankIfsc: row.bank_ifsc,
    bankBranch: row.bank_branch,
    bankAccountType: row.bank_account_type,
    isEmployee: row.is_employee,
    pan: row.pan,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

const CONTACT_COLUMNS = `
  id, designation, contact_person, address, phone, email, gstin, pincode,
  state_code, locality, division_code, is_consignee, is_vendor, is_client,
  bank_account_holder, bank_name, bank_account_number, bank_ifsc, bank_branch,
  bank_account_type, is_employee, pan, active, created_at
`;

// GSTIN, email, IFSC and account-number shape all live in
// ../contact-fields.js: the organisation profile writes the same fields
// for the contractor itself and must prove them identically (its values
// are printed on every generated document, and its bank accounts are the
// ones money arrives in), so the set is shared rather than duplicated.

/** The address list of a set of contacts, in picker order. */
async function loadContactAddresses(
  tx: TransactionSql,
  contactIds: readonly string[],
): Promise<ContactAddressRow[]> {
  if (contactIds.length === 0) return [];
  return tx<ContactAddressRow[]>`
    select ${tx.unsafe(CONTACT_ADDRESS_COLUMNS)}
    from contact_addresses
    where contact_id = any(${contactIds}::uuid[])
    order by contact_id, ${tx.unsafe(CONTACT_ADDRESS_ORDER)}
  `;
}

/**
 * Keeps the contact's PRIMARY address row equal to the four address
 * fields the contact form just wrote (migration 0116).
 *
 * The database mirrors in the other direction — primary row onto
 * `contacts` — so this is the same fact written from the other end, and
 * the trigger sees the two already agreeing and does nothing. Both
 * directions exist because both surfaces write: the contact form has
 * carried an address since 0013 and the v1 importer writes through the
 * 0028 compatibility view, while the address list below is where a
 * second address can only come from.
 *
 * A contact whose address is cleared keeps its address ROWS — they may
 * be cited by an inspection clause — but stops having a primary one, so
 * nothing offers an address the contact no longer claims.
 */
async function syncPrimaryAddress(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  contactId: string,
  fields: {
    address: string | null;
    pincode: string | null;
    locality: string | null;
    stateCode: string | null;
  },
): Promise<void> {
  if (fields.address === null) {
    await tx`
      update contact_addresses set is_primary = false
      where organisation_id = ${organisationId}
        and contact_id = ${contactId}
        and is_primary
    `;
    return;
  }
  const updated = await tx`
    update contact_addresses
    set address = ${fields.address}, pincode = ${fields.pincode},
        locality = ${fields.locality}, state_code = ${fields.stateCode}
    where organisation_id = ${organisationId}
      and contact_id = ${contactId}
      and is_primary
  `;
  if (updated.count > 0) return;
  await tx`
    insert into contact_addresses (
      organisation_id, contact_id, address, pincode, locality, state_code,
      is_primary, created_by_user_id
    )
    values (
      ${organisationId}, ${contactId}, ${fields.address}, ${fields.pincode},
      ${fields.locality}, ${fields.stateCode}, true, ${userId}
    )
  `;
}

// --- Canonical items (migration 0078) ---------------------------------------

interface CanonicalItemRow {
  id: string;
  name: string;
  group_name: string;
  make: string | null;
  model: string | null;
  default_unit: string;
  aliases: string[];
  mapped_line_count: number;
  active: boolean;
  created_at: Date;
}

const CANONICAL_ITEM_COLUMNS = `
  id, name, group_name, make, model, default_unit, aliases, active, created_at
`;

function toCanonicalItem(row: CanonicalItemRow): CanonicalItem {
  return {
    id: row.id,
    name: row.name,
    groupName: row.group_name,
    make: row.make,
    model: row.model,
    defaultUnit: row.default_unit,
    aliases: row.aliases,
    mappedLineCount: row.mapped_line_count,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Aliases are MATCH KEYS, not display text, so they are stored the way
 * they are compared: trimmed, lowercased, de-duplicated, blanks dropped.
 * Storing "42U Rack" and "42u rack" as two aliases would be two rows of
 * the same key, and the count query lowercases both sides anyway — so
 * normalising on write keeps the stored array honest about how many
 * distinct wordings this item actually claims.
 *
 * Migration 0078's CHECKs refuse a NULL or empty element independently.
 */
function normaliseAliases(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  return [
    ...new Set(
      raw
        .map((alias) => alias.trim().toLowerCase())
        .filter((alias) => alias.length > 0),
    ),
  ];
}

/**
 * One canonical item with its derived mapped-line count.
 *
 * Every write path re-reads through here instead of using RETURNING,
 * because the count is not a stored column and RETURNING cannot produce
 * one. Writing it once also means the mapping rule — a live schedule
 * line whose normalised description equals this item's name or one of
 * its aliases — is stated in exactly two places in this file (here and
 * the list query), not once per endpoint.
 */
async function loadCanonicalItem(
  tx: TransactionSql,
  id: string,
): Promise<CanonicalItemRow | undefined> {
  const [row] = await tx<CanonicalItemRow[]>`
    with line_keys as (
      select lower(btrim(coalesce(effective_description, description))) as key,
             count(*)::int as lines
      from work_items_live
      group by 1
    )
    select ${tx.unsafe(CANONICAL_ITEM_COLUMNS)},
           coalesce((
             select sum(k.lines)
             from line_keys k
             where k.key = lower(btrim(item.name))
                or exists (
                  select 1 from unnest(item.aliases) alias
                  where lower(btrim(alias)) = k.key
                )
           ), 0)::int as mapped_line_count
    from canonical_items item
    where item.id = ${id}
  `;
  return row;
}

// --- Location masters -------------------------------------------------------

interface LocationRow {
  id: string;
  name: string;
  kind: LocationMaster['kind'];
  active: boolean;
  created_at: Date;
}

function toLocation(row: LocationRow): LocationMaster {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

// --- Unit masters -----------------------------------------------------------

interface UnitRow {
  id: string;
  name: string;
  active: boolean;
  created_at: Date;
}

function toUnit(row: UnitRow): UnitMaster {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Lazily seeds this organisation's default units from the LOA parser's
 * canonical unit list (CANONICAL_UNIT_NAMES — the twelve display
 * spellings the parser recognises). Tenant tables must not be globally
 * seeded, so the defaults land per organisation on the FIRST unit list
 * read, idempotently: ON CONFLICT against the per-organisation
 * case-insensitive name index skips every row that already exists, which
 * makes re-seeding a no-op AND keeps a retired default retired (its row
 * still exists, so the conflict skips it — retirement survives). Under
 * concurrent first calls both transactions insert the same ordered list;
 * the index serialises them and each name converges to exactly one row.
 */
async function ensureDefaultUnits(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
): Promise<void> {
  const inserted = await tx`
    insert into unit_masters (organisation_id, name, created_by_user_id)
    select ${organisationId}, canon.name, ${userId}
    from unnest(${[...CANONICAL_UNIT_NAMES]}::text[]) as canon(name)
    on conflict (organisation_id, lower(name)) do nothing
  `;
  if (inserted.count > 0) {
    await audit(
      tx,
      organisationId,
      userId,
      'unit_master.defaults_seeded',
      'unit_masters',
      null,
      { count: inserted.count, source: 'loa-parser canonical unit list' },
    );
  }
}

// --- GST rate master (0048) -------------------------------------------------

interface GstRateRow {
  id: string;
  rate: string;
  label: string;
  effective_from: string;
  effective_to: string | null;
  created_at: Date;
}

function toGstRate(row: GstRateRow): GstRateMaster {
  return {
    id: row.id,
    rate: row.rate,
    label: row.label,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at.toISOString(),
  };
}

// --- Signatories ------------------------------------------------------------

interface SignatoryRow {
  id: string;
  name: string;
  designation: string;
  active: boolean;
  created_at: Date;
}

function toSignatory(row: SignatoryRow): Signatory {
  return {
    id: row.id,
    name: row.name,
    designation: row.designation,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

export function registerMasterRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  /** Shared retire/reactivate wiring: both are plain active-flag updates,
   * ALWAYS allowed (referenced documents keep their own snapshots, so
   * nothing blocks a retirement), audited, answering with the updated
   * master. `update` runs the entity's own tagged-template UPDATE so no
   * dynamic SQL is assembled here. */
  function registerActiveToggle<Row, Out>(options: {
    path: string;
    entity: string;
    entityType: string;
    notFoundCode: ErrorCode;
    notFoundMessage: string;
    update: (
      tx: TransactionSql,
      id: string,
      active: boolean,
    ) => Promise<Row | undefined>;
    map: (row: Row) => Out;
    responseSchema: TSchema;
  }): void {
    for (const active of [false, true]) {
      tenantRoute(
        {
          method: 'POST',
          url: `${options.path}/:id/${active ? 'reactivate' : 'retire'}`,
          schema: {
            params: IdParamsSchema,
            response: { 200: options.responseSchema, ...errorResponses },
          },
          role: 'writer',
        },
        async ({ request, user, organisationId, tenant }) => {
          const { id } = request.params;
          return tenant(async (tx) => {
            const row = await options.update(tx, id, active);
            if (!row) {
              throw httpError(404, options.notFoundCode, options.notFoundMessage);
            }
            await audit(
              tx,
              organisationId,
              user.id,
              `${options.entity}.${active ? 'reactivated' : 'retired'}`,
              options.entityType,
              id,
              {},
            );
            return options.map(row);
          });
        },
      );
    }
  }

  // --- Contacts (unified master; consignee/vendor/client role flags) --------

  const ContactListQuerySchema = Type.Object(
    {
      includeRetired: Type.Optional(Type.Boolean()),
      /** Pickers filter by role so each document flow sees only its own
       * contacts: challan/PAC pickers pass role=consignee (railway
       * document flows stay railway-only, §9), the purchase-order picker
       * passes role=vendor, the tax-invoice buyer picker role=client. */
      role: Type.Optional(
        Type.Union([
          Type.Literal('consignee'),
          Type.Literal('vendor'),
          Type.Literal('client'),
        ]),
      ),
    },
    { additionalProperties: false },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/masters/contacts',
      schema: {
        querystring: ContactListQuerySchema,
        response: { 200: ContactListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, tenant }) => {
      const { includeRetired = false, role } = request.query;
      const { rows, addresses } = await tenant(async (tx) => {
        const listed = await tx<ContactRow[]>`
          select ${tx.unsafe(CONTACT_COLUMNS)}
          from contacts
          where (active or ${includeRetired})
            and (is_consignee or ${role !== 'consignee'})
            and (is_vendor or ${role !== 'vendor'})
            and (is_client or ${role !== 'client'})
          order by lower(designation), lower(coalesce(address, ''))
        `;
        return {
          rows: listed,
          addresses: await loadContactAddresses(
            tx,
            listed.map((contact) => contact.id),
          ),
        };
      });
      return { contacts: rows.map((row) => toContact(row, addresses)) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/masters/contacts',
      schema: {
        body: SaveContactRequestSchema,
        response: { 201: ContactSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      // Role resolution: a create that names neither vendor nor client is
      // a consignee, exactly as every create was before the procurement
      // wave; naming a role makes a vendor/client that is NOT a consignee
      // (the roles feed disjoint pickers — railway document flows stay
      // railway-only, §9). The R16 authority refusal therefore applies
      // exactly when the contact will be a consignee — a vendor may carry
      // whatever name its letterhead does. GSTIN and email are normalised
      // before either can reach the database.
      const isVendor = body.isVendor ?? false;
      const isClient = body.isClient ?? false;
      const isConsignee = !isVendor && !isClient;
      if (isConsignee) assertNotAuthorityDesignation(body.designation);
      const roles = [
        ...(isConsignee ? ['consignee'] : []),
        ...(isVendor ? ['vendor'] : []),
        ...(isClient ? ['client'] : []),
      ];
      const gstin = normaliseGstin(body.gstin);
      // Uppercased like the GSTIN: an operator types a PAN either way
      // and the CHECK constraint only accepts upper case, so the
      // normalisation is real rather than decorative.
      //
      // `undefined` and `null` are kept apart on purpose: omitting the
      // field preserves what is stored, sending null clears it. Folding
      // both to null would make every partial edit blank the PAN.
      const pan =
        body.pan === undefined ? undefined : (body.pan?.trim().toUpperCase() ?? null);
      const email = normaliseEmail(body.email);
      const bank = normaliseContactBankDetails(body);
      const locality = body.locality?.trim() ?? null;
      if (body.locality !== undefined && body.locality.trim().length < 2) {
        throw httpError(
          400,
          'LOCALITY_INVALID',
          'Locality must contain at least two non-space characters.',
        );
      }
      const contact = await tenant(async (tx) => {
        const [row] = await tx<ContactRow[]>`
            insert into contacts (
              organisation_id, designation, contact_person, address, phone,
              email, gstin, pincode, state_code, locality, division_code, is_consignee,
              is_vendor, is_client, bank_account_holder, bank_name,
              bank_account_number, bank_ifsc, bank_branch, bank_account_type,
              is_employee, pan, created_by_user_id
            )
            values (
              ${organisationId}, ${body.designation},
              ${body.contactPerson ?? null}, ${body.address ?? null},
              ${body.phone ?? null}, ${email}, ${gstin},
              ${body.pincode ?? null}, ${body.stateCode ?? null}, ${locality},
              ${body.divisionCode ?? null},
              ${isConsignee}, ${isVendor}, ${isClient},
              ${bank.holder}, ${bank.bankName}, ${bank.accountNumber},
              ${bank.ifsc}, ${bank.branch}, ${bank.accountType},
              ${body.isEmployee ?? false}, ${pan ?? null},
              ${user.id}
            )
            returning ${tx.unsafe(CONTACT_COLUMNS)}
          `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'CONTACT_EXISTS',
              'An active contact with this designation and address already exists.',
            );
          }
          throw error;
        });
        if (!row) throw new Error('contact insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'contact.created',
          'contacts',
          row.id,
          { designation: body.designation, roles },
        );
        // The address list's first row, written from the same four fields
        // the contact just stored, so a contact created with an address
        // starts with a primary one to offer.
        await syncPrimaryAddress(tx, organisationId, user.id, row.id, {
          address: body.address ?? null,
          pincode: body.pincode ?? null,
          locality,
          stateCode: body.stateCode ?? null,
        });
        return toContact(row, await loadContactAddresses(tx, [row.id]));
      });
      return reply.status(201).send(contact);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/masters/contacts/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveContactRequestSchema,
        response: { 200: ContactSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const gstin = normaliseGstin(body.gstin);
      // Uppercased like the GSTIN: an operator types a PAN either way
      // and the CHECK constraint only accepts upper case, so the
      // normalisation is real rather than decorative.
      //
      // `undefined` and `null` are kept apart on purpose: omitting the
      // field preserves what is stored, sending null clears it. Folding
      // both to null would make every partial edit blank the PAN.
      const pan =
        body.pan === undefined ? undefined : (body.pan?.trim().toUpperCase() ?? null);
      const email = normaliseEmail(body.email);
      const bank = normaliseContactBankDetails(body);
      const locality = body.locality?.trim() ?? null;
      if (body.locality !== undefined && body.locality.trim().length < 2) {
        throw httpError(
          400,
          'LOCALITY_INVALID',
          'Locality must contain at least two non-space characters.',
        );
      }
      return tenant(async (tx) => {
        // The consignee role is a create-time fact an update never
        // changes, and the R16 refusal follows it: a rename must not
        // smuggle an authority designation onto a consignee-role contact,
        // while a vendor/client keeps whatever name its letterhead
        // carries. The stored flag decides, so it is read first.
        const [existing] = await tx<{ is_consignee: boolean }[]>`
          select is_consignee from contacts where id = ${id}
        `;
        if (!existing) {
          throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
        }
        if (existing.is_consignee) assertNotAuthorityDesignation(body.designation);
        // Vendor/client are membership, not profile text: an omitted flag
        // keeps its stored value (the web profile form need not know
        // about roles to be safe), an explicit false clears it.
        const [row] = await tx<ContactRow[]>`
          update contacts
          set designation = ${body.designation},
              contact_person = ${body.contactPerson ?? null},
              address = ${body.address ?? null}, phone = ${body.phone ?? null},
              email = ${email}, gstin = ${gstin},
              pincode = ${body.pincode ?? null},
              state_code = ${body.stateCode ?? null},
              locality = ${locality},
              division_code = ${body.divisionCode ?? null},
              is_vendor = coalesce(${body.isVendor ?? null}, is_vendor),
              is_client = coalesce(${body.isClient ?? null}, is_client),
              -- Profile text, so an omitted field CLEARS, exactly as the
              -- address and phone above do. That is what lets an operator
              -- remove a beneficiary that changed banks, and it is why the
              -- web form round-trips the stored values rather than being
              -- handed a masked number it could only blank.
              bank_account_holder = ${bank.holder},
              bank_name = ${bank.bankName},
              bank_account_number = ${bank.accountNumber},
              bank_ifsc = ${bank.ifsc},
              bank_branch = ${bank.branch},
              bank_account_type = ${bank.accountType},
              is_employee = coalesce(${body.isEmployee ?? null}, is_employee),
              pan = case when ${pan === undefined} then pan else ${pan ?? null} end
          where id = ${id}
          returning ${tx.unsafe(CONTACT_COLUMNS)}
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'CONTACT_EXISTS',
              'Another active contact already carries this designation and address.',
            );
          }
          throw error;
        });
        if (!row) {
          throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
        }
        await audit(tx, organisationId, user.id, 'contact.updated', 'contacts', id, {
          designation: body.designation,
          ...(body.isVendor !== undefined ? { isVendor: body.isVendor } : {}),
          ...(body.isClient !== undefined ? { isClient: body.isClient } : {}),
        });
        await syncPrimaryAddress(tx, organisationId, user.id, id, {
          address: body.address ?? null,
          pincode: body.pincode ?? null,
          locality,
          stateCode: body.stateCode ?? null,
        });
        return toContact(row, await loadContactAddresses(tx, [id]));
      });
    },
  );

  // --- The address list (migration 0116) ------------------------------------
  //
  // A contact keeps more than one address, and one of them is primary.
  // Everything else in this product prefills from the primary — the
  // database mirrors it onto `contacts` — so these routes exist for the
  // second address onward and for moving which one is first.
  //
  // Retire, never delete, exactly like the parent: a challan may have
  // copied this address, and the register has to keep being able to say
  // where that text came from. Retiring rewrites no document.

  const ContactAddressParamsSchema = Type.Object(
    {
      id: Type.String({
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      }),
      addressId: Type.String({
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      }),
    },
    { additionalProperties: false },
  );

  async function requireContact(tx: TransactionSql, contactId: string): Promise<void> {
    const [row] = await tx<{ id: string }[]>`
      select id from contacts where id = ${contactId}
    `;
    if (!row) throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
  }

  /** Making an address primary is a MOVE: whatever held the flag gives it
   * up first, because the partial unique index admits one per contact and
   * setting before clearing would collide with the row being replaced. */
  async function claimPrimary(
    tx: TransactionSql,
    organisationId: string,
    contactId: string,
    addressId: string,
  ): Promise<void> {
    await tx`
      update contact_addresses set is_primary = false
      where organisation_id = ${organisationId}
        and contact_id = ${contactId}
        and is_primary
        and id <> ${addressId}
    `;
    await tx`
      update contact_addresses set is_primary = true
      where organisation_id = ${organisationId} and id = ${addressId}
    `;
  }

  tenantRoute(
    {
      method: 'POST',
      url: '/api/masters/contacts/:id/addresses',
      schema: {
        params: IdParamsSchema,
        body: SaveContactAddressRequestSchema,
        response: { 201: ContactAddressSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: contactId } = request.params;
      const body = request.body;
      const saved = await tenant(async (tx) => {
        await requireContact(tx, contactId);
        // The FIRST address of a contact is primary whether or not the
        // form said so: a contact with addresses and no primary one would
        // advertise no address at all, and every picker defaults to the
        // primary.
        const [existing] = await tx<{ live: string }[]>`
          select count(*)::text as live from contact_addresses
          where organisation_id = ${organisationId}
            and contact_id = ${contactId} and is_primary
        `;
        const primary = (body.isPrimary ?? false) || existing?.live === '0';
        const [row] = await tx<ContactAddressRow[]>`
          insert into contact_addresses (
            organisation_id, contact_id, label, address, pincode, locality,
            state_code, sort_order, created_by_user_id
          )
          values (
            ${organisationId}, ${contactId}, ${body.label ?? null},
            ${body.address.trim()}, ${body.pincode ?? null},
            ${body.locality?.trim() ?? null}, ${body.stateCode ?? null},
            ${body.sortOrder ?? 0}, ${user.id}
          )
          returning ${tx.unsafe(CONTACT_ADDRESS_COLUMNS)}
        `;
        if (!row) throw new Error('contact address insert returned no row');
        if (primary) await claimPrimary(tx, organisationId, contactId, row.id);
        await audit(
          tx,
          organisationId,
          user.id,
          'contact_address.created',
          'contact_addresses',
          row.id,
          { contactId, primary },
        );
        const [reread] = await tx<ContactAddressRow[]>`
          select ${tx.unsafe(CONTACT_ADDRESS_COLUMNS)} from contact_addresses
          where id = ${row.id}
        `;
        return toContactAddress(reread ?? row);
      });
      return reply.status(201).send(saved);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/masters/contacts/:id/addresses/:addressId',
      schema: {
        params: ContactAddressParamsSchema,
        body: SaveContactAddressRequestSchema,
        response: { 200: ContactAddressSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: contactId, addressId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [row] = await tx<ContactAddressRow[]>`
          update contact_addresses
          set label = ${body.label ?? null}, address = ${body.address.trim()},
              pincode = ${body.pincode ?? null},
              locality = ${body.locality?.trim() ?? null},
              state_code = ${body.stateCode ?? null},
              sort_order = ${body.sortOrder ?? 0}
          where organisation_id = ${organisationId}
            and id = ${addressId} and contact_id = ${contactId}
          returning ${tx.unsafe(CONTACT_ADDRESS_COLUMNS)}
        `;
        if (!row) {
          throw httpError(
            404,
            'CONTACT_ADDRESS_NOT_FOUND',
            'No such address on this contact.',
          );
        }
        if (body.isPrimary === true && !row.is_primary) {
          if (!row.active) {
            throw httpError(
              409,
              'CONTACT_ADDRESS_RETIRED',
              'A retired address cannot be the primary one — reactivate it first.',
            );
          }
          await claimPrimary(tx, organisationId, contactId, addressId);
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'contact_address.updated',
          'contact_addresses',
          addressId,
          { contactId },
        );
        const [reread] = await tx<ContactAddressRow[]>`
          select ${tx.unsafe(CONTACT_ADDRESS_COLUMNS)} from contact_addresses
          where id = ${addressId}
        `;
        return toContactAddress(reread ?? row);
      });
    },
  );

  /**
   * Retire or reactivate one address.
   *
   * Written once, outside the two-route loop below, for the reason
   * `registerActiveToggle` keeps its own UPDATE in a callback: the
   * per-row write census reads the SOURCE, and a tagged-template write
   * sitting inside a `for` is indistinguishable to it from a real
   * round-trip-per-row loop. The loop here iterates over two ROUTE
   * REGISTRATIONS, which happens once at boot.
   */
  async function setAddressActive(
    tx: TransactionSql,
    organisationId: string,
    userId: string,
    contactId: string,
    addressId: string,
    active: boolean,
  ): Promise<ContactAddress> {
    // Retiring the primary address gives up the flag in the same
    // statement — the 0116 CHECK refuses a retired primary — and the next
    // live address inherits it below, so the contact does not silently
    // stop advertising an address it still keeps.
    const [row] = await tx<ContactAddressRow[]>`
      update contact_addresses
      set active = ${active}, is_primary = is_primary and ${active}
      where organisation_id = ${organisationId}
        and id = ${addressId} and contact_id = ${contactId}
      returning ${tx.unsafe(CONTACT_ADDRESS_COLUMNS)}
    `;
    if (!row) {
      throw httpError(
        404,
        'CONTACT_ADDRESS_NOT_FOUND',
        'No such address on this contact.',
      );
    }
    if (!active) {
      const [heir] = await tx<{ id: string }[]>`
        select id from contact_addresses
        where organisation_id = ${organisationId}
          and contact_id = ${contactId}
          and active
          and not exists (
            select 1 from contact_addresses p
            where p.organisation_id = ${organisationId}
              and p.contact_id = ${contactId} and p.is_primary
          )
        order by sort_order, lower(coalesce(label, '')), id
        limit 1
      `;
      if (heir) await claimPrimary(tx, organisationId, contactId, heir.id);
    }
    await audit(
      tx,
      organisationId,
      userId,
      `contact_address.${active ? 'reactivated' : 'retired'}`,
      'contact_addresses',
      addressId,
      { contactId },
    );
    const [reread] = await tx<ContactAddressRow[]>`
      select ${tx.unsafe(CONTACT_ADDRESS_COLUMNS)} from contact_addresses
      where id = ${addressId}
    `;
    return toContactAddress(reread ?? row);
  }

  for (const active of [false, true]) {
    tenantRoute(
      {
        method: 'POST',
        url: `/api/masters/contacts/:id/addresses/:addressId/${
          active ? 'reactivate' : 'retire'
        }`,
        schema: {
          params: ContactAddressParamsSchema,
          response: { 200: ContactAddressSchema, ...errorResponses },
        },
        role: 'writer',
      },
      async ({ request, user, organisationId, tenant }) => {
        const { id: contactId, addressId } = request.params;
        return tenant(async (tx) =>
          setAddressActive(tx, organisationId, user.id, contactId, addressId, active),
        );
      },
    );
  }

  registerActiveToggle<ContactRow, Contact>({
    path: '/api/masters/contacts',
    entity: 'contact',
    entityType: 'contacts',
    notFoundCode: 'CONTACT_NOT_FOUND',
    notFoundMessage: 'No such contact.',
    update: async (tx, id, active) => {
      // Uniqueness is scoped to ACTIVE rows (0028), so reactivating can
      // collide with a live twin created meanwhile — answer 409 rather
      // than resurrecting a duplicate.
      const [row] = await tx<ContactRow[]>`
        update contacts set active = ${active}
        where id = ${id}
        returning ${tx.unsafe(CONTACT_COLUMNS)}
      `.catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw httpError(
            409,
            'CONTACT_EXISTS',
            'An active contact with this designation and address already exists; retire it first or edit this one.',
          );
        }
        throw error;
      });
      return row;
    },
    map: toContact,
    responseSchema: ContactSchema,
  });

  // --- Work <-> consignee association (R16) ---------------------------------
  //
  // "A work may have many consignees; the challan picks one." The linked
  // set is offered FIRST in the challan and PAC pickers; any active
  // consignee contact remains selectable — the association is
  // organisational convenience, never a restriction (legacy allowed any
  // consignee on any challan). Removing a link deletes nothing but the
  // preference: every issued document keeps its own snapshot.

  const WorkConsigneeParamsSchema = Type.Object(
    {
      id: Type.String({
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      }),
      contactId: Type.String({
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      }),
    },
    { additionalProperties: false },
  );

  async function requireWork(tx: TransactionSql, workId: string): Promise<void> {
    const [work] = await tx<{ id: string }[]>`
      select id from works where id = ${workId} and deleted_at is null
    `;
    if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  }

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/consignees',
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkConsigneeListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const { rows, addresses } = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        await requireWork(tx, workId);
        const listed = await tx<ContactRow[]>`
            select c.id, c.designation, c.contact_person, c.address, c.phone,
                   c.email, c.gstin, c.pincode, c.state_code, c.locality,
                   c.division_code,
                   c.is_consignee, c.is_vendor, c.is_client, c.is_employee,
                   c.pan, c.active, c.created_at
            from work_consignees wc
            join contacts c on c.organisation_id = wc.organisation_id
              and c.id = wc.contact_id
            where wc.work_id = ${workId}
            order by lower(c.designation), lower(coalesce(c.address, ''))
          `;
        return {
          rows: listed,
          addresses: await loadContactAddresses(
            tx,
            listed.map((contact) => contact.id),
          ),
        };
      });
      return { consignees: rows.map((row) => toContact(row, addresses)) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/consignees',
      schema: {
        params: IdParamsSchema,
        body: LinkWorkConsigneeRequestSchema,
        response: { 201: ContactSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const contact = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        await requireWork(tx, workId);
        const [row] = await tx<ContactRow[]>`
            select ${tx.unsafe(CONTACT_COLUMNS)} from contacts
            where id = ${body.contactId}
          `;
        if (!row) throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
        if (!row.is_consignee) {
          // Vendor/client-role contacts exist now (procurement wave) and
          // must not join a Work's consignee list; the 0028 trigger
          // backstops the same rule (R16) in the database.
          throw httpError(
            409,
            'CONTACT_NOT_CONSIGNEE',
            'Only consignee-role contacts can be linked to a Work (R16).',
          );
        }
        if (!row.active) {
          throw httpError(
            409,
            'CONTACT_RETIRED',
            'This contact is retired — reactivate it or pick another.',
          );
        }
        await tx`
            insert into work_consignees (
              organisation_id, work_id, contact_id, created_by_user_id
            )
            values (${organisationId}, ${workId}, ${body.contactId}, ${user.id})
          `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'WORK_CONSIGNEE_EXISTS',
              'This consignee is already linked to the Work.',
            );
          }
          throw error;
        });
        // Audited against the Work so the link shows up in the Work's
        // timeline alongside the documents that used it.
        await audit(
          tx,
          organisationId,
          user.id,
          'work.consignee_linked',
          'works',
          workId,
          { contactId: body.contactId, designation: row.designation },
        );
        return toContact(row);
      });
      return reply.status(201).send(contact);
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/works/:id/consignees/:contactId',
      schema: {
        params: WorkConsigneeParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId, contactId } = request.params;
      await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const removed = await tx`
          delete from work_consignees
          where work_id = ${workId} and contact_id = ${contactId}
        `;
        if (removed.count === 0) {
          throw httpError(
            404,
            'WORK_CONSIGNEE_NOT_FOUND',
            'This consignee is not linked to the Work.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'work.consignee_unlinked',
          'works',
          workId,
          { contactId },
        );
      });
      return reply.status(204).send(null);
    },
  );

  // --- Location masters -----------------------------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/masters/locations',
      schema: {
        querystring: ListQuerySchema,
        response: { 200: LocationMasterListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, tenant }) => {
      const { includeRetired = false } = request.query;
      const rows = await tenant(
        async (tx) => tx<LocationRow[]>`
          select id, name, kind, active, created_at
          from location_masters
          where active or ${includeRetired}
          order by lower(name), kind
        `,
      );
      return { locations: rows.map(toLocation) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/masters/locations',
      schema: {
        body: SaveLocationMasterRequestSchema,
        response: { 201: LocationMasterSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const location = await tenant(async (tx) => {
        const [row] = await tx<LocationRow[]>`
            insert into location_masters (
              organisation_id, name, kind, created_by_user_id
            )
            values (${organisationId}, ${body.name}, ${body.kind}, ${user.id})
            returning id, name, kind, active, created_at
          `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'LOCATION_MASTER_EXISTS',
              'A location with this name and kind already exists (it may be retired — reactivate it instead).',
            );
          }
          throw error;
        });
        if (!row) throw new Error('location master insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'location_master.created',
          'location_masters',
          row.id,
          { name: body.name, kind: body.kind },
        );
        return toLocation(row);
      });
      return reply.status(201).send(location);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/masters/locations/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveLocationMasterRequestSchema,
        response: { 200: LocationMasterSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [row] = await tx<LocationRow[]>`
          update location_masters
          set name = ${body.name}, kind = ${body.kind}
          where id = ${id}
          returning id, name, kind, active, created_at
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'LOCATION_MASTER_EXISTS',
              'Another location already carries this name and kind.',
            );
          }
          throw error;
        });
        if (!row) {
          throw httpError(404, 'LOCATION_MASTER_NOT_FOUND', 'No such location.');
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'location_master.updated',
          'location_masters',
          id,
          { name: body.name, kind: body.kind },
        );
        return toLocation(row);
      });
    },
  );

  registerActiveToggle<LocationRow, LocationMaster>({
    path: '/api/masters/locations',
    entity: 'location_master',
    entityType: 'location_masters',
    notFoundCode: 'LOCATION_MASTER_NOT_FOUND',
    notFoundMessage: 'No such location.',
    update: async (tx, id, active) => {
      const [row] = await tx<LocationRow[]>`
        update location_masters set active = ${active}
        where id = ${id}
        returning id, name, kind, active, created_at
      `;
      return row;
    },
    map: toLocation,
    responseSchema: LocationMasterSchema,
  });

  // --- Unit masters ---------------------------------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/masters/units',
      schema: {
        querystring: ListQuerySchema,
        response: { 200: UnitMasterListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { includeRetired = false } = request.query;
      const rows = await tenant(async (tx) => {
        // Defaults appear on first read, for any member: seeding is
        // idempotent system provisioning, not user content — see
        // ensureDefaultUnits.
        await ensureDefaultUnits(tx, organisationId, user.id);
        return tx<UnitRow[]>`
            select id, name, active, created_at
            from unit_masters
            where active or ${includeRetired}
            order by lower(name)
          `;
      });
      return { units: rows.map(toUnit) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/masters/units',
      schema: {
        body: SaveUnitMasterRequestSchema,
        response: { 201: UnitMasterSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const unit = await tenant(async (tx) => {
        const [row] = await tx<UnitRow[]>`
            insert into unit_masters (organisation_id, name, created_by_user_id)
            values (${organisationId}, ${body.name}, ${user.id})
            returning id, name, active, created_at
          `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'UNIT_MASTER_EXISTS',
              'A unit with this name already exists (it may be retired — reactivate it instead).',
            );
          }
          throw error;
        });
        if (!row) throw new Error('unit master insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'unit_master.created',
          'unit_masters',
          row.id,
          { name: body.name },
        );
        return toUnit(row);
      });
      return reply.status(201).send(unit);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/masters/units/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveUnitMasterRequestSchema,
        response: { 200: UnitMasterSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [row] = await tx<UnitRow[]>`
          update unit_masters set name = ${body.name}
          where id = ${id}
          returning id, name, active, created_at
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'UNIT_MASTER_EXISTS',
              'Another unit already carries this name.',
            );
          }
          throw error;
        });
        if (!row) throw httpError(404, 'UNIT_MASTER_NOT_FOUND', 'No such unit.');
        await audit(
          tx,
          organisationId,
          user.id,
          'unit_master.updated',
          'unit_masters',
          id,
          { name: body.name },
        );
        return toUnit(row);
      });
    },
  );

  registerActiveToggle<UnitRow, UnitMaster>({
    path: '/api/masters/units',
    entity: 'unit_master',
    entityType: 'unit_masters',
    notFoundCode: 'UNIT_MASTER_NOT_FOUND',
    notFoundMessage: 'No such unit.',
    update: async (tx, id, active) => {
      const [row] = await tx<UnitRow[]>`
        update unit_masters set active = ${active}
        where id = ${id}
        returning id, name, active, created_at
      `;
      return row;
    },
    map: toUnit,
    responseSchema: UnitMasterSchema,
  });

  // --- Canonical items (migration 0078) -------------------------------------
  //
  // Not a picker, unlike every other master in this file: nothing selects
  // a canonical item into a document. It is the organisation's statement
  // that three differently worded schedule lines across three Works name
  // one product, so those lines can be searched and compared.
  //
  // THE MAPPING IS DERIVED, NOT STORED. A live schedule line counts
  // against a canonical item when its description equals that item's name
  // or one of its aliases, compared lowercased and trimmed. Migration
  // 0078 records why there is no `work_items.canonical_item_id`: there is
  // no mapping control in the design to write one, so the column would
  // have no writer and every count it fed would read zero.
  //
  // The ceiling of that choice, stated so nobody mistakes it for
  // cleverness: matching is EXACT on the normalised string. A line that
  // differs by a comma stays unmapped until somebody adds its wording as
  // an alias, and the unmapped count above the table is what tells them
  // to. Fuzzy matching (trigram, then embeddings) is the upgrade path and
  // belongs behind a review step — an item catalogue that silently
  // claims lines it guessed at is worse than one that admits the gap.
  //
  // Cost, also deliberate: the two queries below group every live work
  // item of the tenant and test each distinct description against each
  // canonical item. That is O(distinct descriptions x items) per read of
  // one administration screen, inside one organisation, and it needs no
  // maintenance anywhere. If a tenant ever makes it slow, the answer is a
  // materialised key table keyed on the same normalised string, not a
  // stored foreign key.

  tenantRoute(
    {
      method: 'GET',
      url: '/api/masters/canonical-items',
      schema: {
        querystring: ListQuerySchema,
        response: { 200: CanonicalItemListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, tenant }) => {
      const { includeRetired = false } = request.query;
      return tenant(async (tx) => {
        const rows = await tx<CanonicalItemRow[]>`
          with line_keys as (
            select lower(btrim(coalesce(effective_description, description))) as key,
                   count(*)::int as lines
            from work_items_live
            group by 1
          )
          select item.id, item.name, item.group_name, item.make, item.model,
                 item.default_unit, item.aliases, item.active, item.created_at,
                 coalesce((
                   select sum(k.lines)
                   from line_keys k
                   where k.key = lower(btrim(item.name))
                      or exists (
                        select 1 from unnest(item.aliases) alias
                        where lower(btrim(alias)) = k.key
                      )
                 ), 0)::int as mapped_line_count
          from canonical_items item
          where item.active or ${includeRetired}
          order by lower(btrim(item.group_name)), lower(btrim(item.name))
        `;
        // Counted against ACTIVE items only: a retired canonical item is
        // no longer the organisation's answer for those lines, so the
        // lines it used to cover are unmapped again and the warning
        // should say so.
        const [totals] = await tx<{ unmapped: number }[]>`
          with line_keys as (
            select lower(btrim(coalesce(effective_description, description))) as key,
                   count(*)::int as lines
            from work_items_live
            group by 1
          )
          select coalesce(sum(k.lines), 0)::int as unmapped
          from line_keys k
          where not exists (
            select 1 from canonical_items item
            where item.active
              and (
                lower(btrim(item.name)) = k.key
                or exists (
                  select 1 from unnest(item.aliases) alias
                  where lower(btrim(alias)) = k.key
                )
              )
          )
        `;
        return {
          items: rows.map(toCanonicalItem),
          unmappedLineCount: totals?.unmapped ?? 0,
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/masters/canonical-items',
      schema: {
        body: SaveCanonicalItemRequestSchema,
        response: { 201: CanonicalItemSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const aliases = normaliseAliases(body.aliases);
      const item = await tenant(async (tx) => {
        const [inserted] = await tx<{ id: string }[]>`
            insert into canonical_items (
              organisation_id, name, group_name, make, model, default_unit,
              aliases, created_by_user_id
            )
            values (
              ${organisationId}, ${body.name}, ${body.groupName},
              ${body.make ?? null}, ${body.model ?? null}, ${body.defaultUnit},
              ${aliases}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'CANONICAL_ITEM_EXISTS',
              'A canonical item with this name already exists (it may be retired — reactivate it instead). Two items claiming one wording would both count the same schedule lines.',
            );
          }
          throw error;
        });
        if (!inserted) throw new Error('canonical item insert returned no row');
        const row = await loadCanonicalItem(tx, inserted.id);
        if (!row) throw new Error('canonical item vanished after insert');
        await audit(
          tx,
          organisationId,
          user.id,
          'canonical_item.created',
          'canonical_items',
          row.id,
          { name: body.name, groupName: body.groupName, aliases: aliases.length },
        );
        return toCanonicalItem(row);
      });
      return reply.status(201).send(item);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/masters/canonical-items/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveCanonicalItemRequestSchema,
        response: { 200: CanonicalItemSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const aliases = normaliseAliases(body.aliases);
      return tenant(async (tx) => {
        const [updated] = await tx<{ id: string }[]>`
          update canonical_items
          set name = ${body.name}, group_name = ${body.groupName},
              make = ${body.make ?? null}, model = ${body.model ?? null},
              default_unit = ${body.defaultUnit}, aliases = ${aliases}
          where id = ${id}
          returning id
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'CANONICAL_ITEM_EXISTS',
              'Another canonical item already carries this name.',
            );
          }
          throw error;
        });
        if (!updated) {
          throw httpError(404, 'CANONICAL_ITEM_NOT_FOUND', 'No such canonical item.');
        }
        // Re-read rather than RETURNING: the edit that just landed was
        // probably an alias, and an alias IS the mapping, so the count
        // the operator sees next has to be the one the new wordings
        // produce.
        const row = await loadCanonicalItem(tx, updated.id);
        if (!row) throw new Error('canonical item vanished after update');
        await audit(
          tx,
          organisationId,
          user.id,
          'canonical_item.updated',
          'canonical_items',
          id,
          { name: body.name, groupName: body.groupName, aliases: aliases.length },
        );
        return toCanonicalItem(row);
      });
    },
  );

  registerActiveToggle<CanonicalItemRow, CanonicalItem>({
    path: '/api/masters/canonical-items',
    entity: 'canonical_item',
    entityType: 'canonical_items',
    notFoundCode: 'CANONICAL_ITEM_NOT_FOUND',
    notFoundMessage: 'No such canonical item.',
    update: async (tx, id, active) => {
      const [updated] = await tx<{ id: string }[]>`
        update canonical_items set active = ${active}
        where id = ${id}
        returning id
      `;
      return updated === undefined
        ? undefined
        : await loadCanonicalItem(tx, updated.id);
    },
    map: toCanonicalItem,
    responseSchema: CanonicalItemSchema,
  });

  // --- Organisation signatories ---------------------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/masters/signatories',
      schema: {
        querystring: ListQuerySchema,
        response: { 200: SignatoryListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, tenant }) => {
      const { includeRetired = false } = request.query;
      const rows = await tenant(
        async (tx) => tx<SignatoryRow[]>`
          select id, name, designation, active, created_at
          from organisation_signatories
          where active or ${includeRetired}
          order by lower(name), lower(designation)
        `,
      );
      return { signatories: rows.map(toSignatory) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/masters/signatories',
      schema: {
        body: SaveSignatoryRequestSchema,
        response: { 201: SignatorySchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const signatory = await tenant(async (tx) => {
        const [row] = await tx<SignatoryRow[]>`
            insert into organisation_signatories (
              organisation_id, name, designation, created_by_user_id
            )
            values (${organisationId}, ${body.name}, ${body.designation}, ${user.id})
            returning id, name, designation, active, created_at
          `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'SIGNATORY_EXISTS',
              'A signatory with this name and designation already exists (they may be retired — reactivate them instead).',
            );
          }
          throw error;
        });
        if (!row) throw new Error('signatory insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'signatory.created',
          'organisation_signatories',
          row.id,
          { name: body.name, designation: body.designation },
        );
        return toSignatory(row);
      });
      return reply.status(201).send(signatory);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/masters/signatories/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveSignatoryRequestSchema,
        response: { 200: SignatorySchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [row] = await tx<SignatoryRow[]>`
          update organisation_signatories
          set name = ${body.name}, designation = ${body.designation}
          where id = ${id}
          returning id, name, designation, active, created_at
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'SIGNATORY_EXISTS',
              'Another signatory already carries this name and designation.',
            );
          }
          throw error;
        });
        if (!row) throw httpError(404, 'SIGNATORY_NOT_FOUND', 'No such signatory.');
        await audit(
          tx,
          organisationId,
          user.id,
          'signatory.updated',
          'organisation_signatories',
          id,
          { name: body.name, designation: body.designation },
        );
        return toSignatory(row);
      });
    },
  );

  registerActiveToggle<SignatoryRow, Signatory>({
    path: '/api/masters/signatories',
    entity: 'signatory',
    entityType: 'organisation_signatories',
    notFoundCode: 'SIGNATORY_NOT_FOUND',
    notFoundMessage: 'No such signatory.',
    update: async (tx, id, active) => {
      const [row] = await tx<SignatoryRow[]>`
        update organisation_signatories set active = ${active}
        where id = ${id}
        returning id, name, designation, active, created_at
      `;
      return row;
    },
    map: toSignatory,
    responseSchema: SignatorySchema,
  });

  // --- GST rate master (migration 0048, audit finding 19) -------------------
  //
  // Unlike the flag-retired masters above, a GST rate leaves force by
  // END-DATING: a destructive edit or delete would change what a stored
  // invoice's (rate, date) pair meant, so neither exists. Every member
  // may read (the invoice and quotation forms are pickers over this
  // list); mutations are OWNER-only — the master decides what a legal
  // document may say, which is statutory configuration rather than
  // drafting.

  tenantRoute(
    {
      method: 'GET',
      url: '/api/masters/gst-rates',
      schema: {
        response: { 200: GstRateListResponseSchema, ...errorResponses },
      },
    },
    async ({ tenant }) => {
      const rows = await tenant(
        async (tx) => tx<GstRateRow[]>`
          select id, rate::text as rate, label,
                 effective_from::text as effective_from,
                 effective_to::text as effective_to, created_at
          from gst_rates
          order by rate, effective_from
        `,
      );
      return { gstRates: rows.map(toGstRate) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/masters/gst-rates',
      schema: {
        body: CreateGstRateRequestSchema,
        response: { 201: GstRateMasterSchema, ...errorResponses },
      },
      role: 'owner',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const label = body.label.trim();
      if (label.length < 2 || label.length > 100) {
        throw httpError(
          400,
          'GST_RATE_LABEL_INVALID',
          'The label must be between 2 and 100 characters that are not blank.',
        );
      }
      // ISO dates compare correctly as strings.
      if (body.effectiveTo !== undefined && body.effectiveTo < body.effectiveFrom) {
        throw httpError(
          400,
          'GST_RATE_WINDOW_INVALID',
          `The end date ${body.effectiveTo} precedes the start date ${body.effectiveFrom}, so the window would cover nothing.`,
        );
      }
      const created = await tenant(async (tx) => {
        const [row] = await tx<GstRateRow[]>`
            insert into gst_rates (
              organisation_id, rate, label, effective_from, effective_to,
              created_by_user_id
            )
            values (
              ${organisationId}, ${body.rate}, ${label}, ${body.effectiveFrom},
              ${body.effectiveTo ?? null}, ${user.id}
            )
            returning id, rate::text as rate, label,
                      effective_from::text as effective_from,
                      effective_to::text as effective_to, created_at
          `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'GST_RATE_EXISTS',
              'This rate already has a row starting on this date.',
            );
          }
          throw error;
        });
        if (!row) throw new Error('gst rate insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'gst_rate.created',
          'gst_rates',
          row.id,
          {
            rate: row.rate,
            label,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
          },
        );
        return toGstRate(row);
      });
      return reply.status(201).send(created);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/masters/gst-rates/:id/end-date',
      schema: {
        params: IdParamsSchema,
        body: EndDateGstRateRequestSchema,
        response: { 200: GstRateMasterSchema, ...errorResponses },
      },
      role: 'owner',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [current] = await tx<GstRateRow[]>`
          select id, rate::text as rate, label,
                 effective_from::text as effective_from,
                 effective_to::text as effective_to, created_at
          from gst_rates where id = ${id}
          for update
        `;
        if (!current) {
          throw httpError(404, 'GST_RATE_NOT_FOUND', 'No such GST rate.');
        }
        if (current.effective_to !== null) {
          throw httpError(
            409,
            'GST_RATE_ALREADY_ENDED',
            `This rate already ended on ${current.effective_to}. History is never rewritten — add a new row if the rate was notified again.`,
          );
        }
        if (body.effectiveTo < current.effective_from) {
          throw httpError(
            400,
            'GST_RATE_WINDOW_INVALID',
            `The end date ${body.effectiveTo} precedes the start date ${current.effective_from}, so the window would cover nothing.`,
          );
        }
        const [row] = await tx<GstRateRow[]>`
          update gst_rates set effective_to = ${body.effectiveTo}
          where id = ${id}
          returning id, rate::text as rate, label,
                    effective_from::text as effective_from,
                    effective_to::text as effective_to, created_at
        `;
        if (!row) throw new Error('gst rate end-date returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'gst_rate.end_dated',
          'gst_rates',
          id,
          {
            rate: row.rate,
            before: { effectiveTo: null },
            after: { effectiveTo: row.effective_to },
          },
        );
        return toGstRate(row);
      });
    },
  );
}
