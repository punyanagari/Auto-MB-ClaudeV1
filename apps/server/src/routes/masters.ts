import {
  ContactListResponseSchema,
  ContactSchema,
  CreateGstRateRequestSchema,
  EndDateGstRateRequestSchema,
  GstRateListResponseSchema,
  GstRateMasterSchema,
  LinkWorkConsigneeRequestSchema,
  LocationMasterListResponseSchema,
  LocationMasterSchema,
  SaveContactRequestSchema,
  SaveLocationMasterRequestSchema,
  SaveSignatoryRequestSchema,
  SaveUnitMasterRequestSchema,
  SignatoryListResponseSchema,
  SignatorySchema,
  UnitMasterListResponseSchema,
  UnitMasterSchema,
  WorkConsigneeListResponseSchema,
  type Contact,
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
import { normaliseEmail, normaliseGstin } from '../contact-fields.js';
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
  active: boolean;
  created_at: Date;
}

function toContact(row: ContactRow): Contact {
  return {
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
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

const CONTACT_COLUMNS = `
  id, designation, contact_person, address, phone, email, gstin, pincode,
  state_code, locality, division_code, is_consignee, is_vendor, is_client, active,
  created_at
`;

// GSTIN and email shape live in ../contact-fields.js: the organisation
// profile writes the same two fields for the contractor itself and must
// prove them identically (its values are printed on every generated
// document), so the pair is shared rather than duplicated.

/** Legacy rule R16: bill-paying authorities (Sr.DFM / DFM / ADFM) and
 * awarding authorities (Sr.DSTE) are NEVER consignees. The designation is
 * normalised (uppercase, dots and extra spaces removed) and matched
 * against those documented tokens as whole words; "Sr. DEE (G)" and the
 * other legitimate consignee designations pass. The pattern list is
 * exactly the spec's: DFM, ADFM (any prefix) and the SR-prefixed DSTE —
 * a plain DSTE post can legitimately receive material. */
const CONSIGNEE_AUTHORITY_PATTERNS: readonly RegExp[] = [
  /(^|[^A-Z])A?DFM([^A-Z]|$)/, // Sr.DFM, DFM, ADFM — bill-paying
  /(^|[^A-Z])SR ?DSTE([^A-Z]|$)/, // Sr.DSTE — awarding
];

function assertNotAuthorityDesignation(designation: string): void {
  const normalised = designation
    .toUpperCase()
    .replaceAll('.', ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (CONSIGNEE_AUTHORITY_PATTERNS.some((pattern) => pattern.test(normalised))) {
    throw httpError(
      400,
      'CONSIGNEE_AUTHORITY_FORBIDDEN',
      'Bill-paying authorities (Sr.DFM/DFM/ADFM) and awarding authorities (Sr.DSTE) are never consignees (rule R16); record the consignee named on the document instead.',
    );
  }
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
      const rows = await tenant(
        async (tx) => tx<ContactRow[]>`
          select ${tx.unsafe(CONTACT_COLUMNS)}
          from contacts
          where (active or ${includeRetired})
            and (is_consignee or ${role !== 'consignee'})
            and (is_vendor or ${role !== 'vendor'})
            and (is_client or ${role !== 'client'})
          order by lower(designation), lower(coalesce(address, ''))
        `,
      );
      return { contacts: rows.map(toContact) };
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
      const email = normaliseEmail(body.email);
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
              is_vendor, is_client, created_by_user_id
            )
            values (
              ${organisationId}, ${body.designation},
              ${body.contactPerson ?? null}, ${body.address ?? null},
              ${body.phone ?? null}, ${email}, ${gstin},
              ${body.pincode ?? null}, ${body.stateCode ?? null}, ${locality},
              ${body.divisionCode ?? null},
              ${isConsignee}, ${isVendor}, ${isClient},
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
        return toContact(row);
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
      const email = normaliseEmail(body.email);
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
              is_client = coalesce(${body.isClient ?? null}, is_client)
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
        return toContact(row);
      });
    },
  );

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
      const rows = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        await requireWork(tx, workId);
        return tx<ContactRow[]>`
            select c.id, c.designation, c.contact_person, c.address, c.phone,
                   c.email, c.gstin, c.pincode, c.state_code, c.locality,
                   c.division_code,
                   c.is_consignee, c.is_vendor, c.is_client, c.active,
                   c.created_at
            from work_consignees wc
            join contacts c on c.organisation_id = wc.organisation_id
              and c.id = wc.contact_id
            where wc.work_id = ${workId}
            order by lower(c.designation), lower(coalesce(c.address, ''))
          `;
      });
      return { consignees: rows.map(toContact) };
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
