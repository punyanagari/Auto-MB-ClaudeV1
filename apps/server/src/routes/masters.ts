import {
  ApiErrorSchema,
  ContactListResponseSchema,
  ContactSchema,
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
  type LinkWorkConsigneeRequest,
  type LocationMaster,
  type SaveContactRequest,
  type SaveLocationMasterRequest,
  type SaveSignatoryRequest,
  type SaveUnitMasterRequest,
  type Signatory,
  type UnitMaster,
} from '@auto-mb/contracts';
import { CANONICAL_UNIT_NAMES } from '@auto-mb/loa-parser';
import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import { normaliseEmail, normaliseGstin } from '../contact-fields.js';
import { httpError } from '../http.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

/**
 * Contract-domain master data: the unified Contacts master (consignee,
 * vendor and client role flags â€” legacy Â§9, woken fully by the
 * procurement wave Â§5.8), the Workâ†”consignee association, locations,
 * units, and organisation signatories. Masters are PICKERS ONLY â€”
 * documents snapshot whatever the
 * user confirms into their own columns (the Delivery Challan consignee
 * stays a free-text snapshot; the PAC certificate snapshots the
 * designation), so master edits and retirements never rewrite history.
 *
 * Lifecycle: create â†’ update â†’ retire â†’ reactivate. Retiring only clears
 * the active flag (always allowed, always reversible); a hard delete does
 * not exist â€” the application role holds no DELETE privilege on any
 * masters table (migrations 0013/0028). The Workâ†”consignee association is
 * the one deletable row here: it is a preference list, not a document.
 *
 * Roles: every member may read (pickers serve viewers too); mutations are
 * owner/office. Every mutation is audited.
 */

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

/** Retired masters stay out of pickers unless explicitly requested. */
const ListQuerySchema = Type.Object(
  { includeRetired: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, ${entityType}, ${entityId},
      ${jsonb(tx, details)}
    )
  `;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23505';
}

// --- Contacts (unified master, legacy Â§9) -----------------------------------

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
 * exactly the spec's: DFM, ADFM (any prefix) and the SR-prefixed DSTE â€”
 * a plain DSTE post can legitimately receive material. */
const CONSIGNEE_AUTHORITY_PATTERNS: readonly RegExp[] = [
  /(^|[^A-Z])A?DFM([^A-Z]|$)/, // Sr.DFM, DFM, ADFM â€” bill-paying
  /(^|[^A-Z])SR ?DSTE([^A-Z]|$)/, // Sr.DSTE â€” awarding
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
 * canonical unit list (CANONICAL_UNIT_NAMES â€” the twelve display
 * spellings the parser recognises). Tenant tables must not be globally
 * seeded, so the defaults land per organisation on the FIRST unit list
 * read, idempotently: ON CONFLICT against the per-organisation
 * case-insensitive name index skips every row that already exists, which
 * makes re-seeding a no-op AND keeps a retired default retired (its row
 * still exists, so the conflict skips it â€” retirement survives). Under
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
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
): void {
  /** Shared retire/reactivate wiring: both are plain active-flag updates,
   * ALWAYS allowed (referenced documents keep their own snapshots, so
   * nothing blocks a retirement), audited, answering with the updated
   * master. `update` runs the entity's own tagged-template UPDATE so no
   * dynamic SQL is assembled here. */
  function registerActiveToggle<Row, Out>(options: {
    path: string;
    entity: string;
    entityType: string;
    notFoundCode: string;
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
      app.post(
        `${options.path}/:id/${active ? 'reactivate' : 'retire'}`,
        {
          schema: {
            params: IdParamsSchema,
            response: { 200: options.responseSchema, ...errorResponses },
          },
        },
        async (request) => {
          const user = await requireUser(auth, request);
          const organisationId = requireOrganisationHeader(
            request.headers['x-organisation-id'],
          );
          const { id } = request.params as { id: string };
          return withBoundTenant(database, organisationId, user.id, async (tx) => {
            await requireWriterRole(tx, user.id);
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
       * document flows stay railway-only, Â§9), the purchase-order picker
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

  app.get(
    '/api/masters/contacts',
    {
      schema: {
        querystring: ContactListQuerySchema,
        response: { 200: ContactListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { includeRetired = false, role } = request.query as {
        includeRetired?: boolean;
        role?: 'consignee' | 'vendor' | 'client';
      };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
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

  app.post(
    '/api/masters/contacts',
    {
      schema: {
        body: SaveContactRequestSchema,
        response: { 201: ContactSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const body = request.body as SaveContactRequest;
      // Role resolution: a create that names neither vendor nor client is
      // a consignee, exactly as every create was before the procurement
      // wave; naming a role makes a vendor/client that is NOT a consignee
      // (the roles feed disjoint pickers â€” railway document flows stay
      // railway-only, Â§9). The R16 authority refusal therefore applies
      // exactly when the contact will be a consignee â€” a vendor may carry
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
      const contact = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
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
          ßÍ=¶‰žËkºwµç}É­}¥€ô€‘íÝ½É­%‘ô…¹½¹Ñ…Ñ}¥€ô€‘í½¹Ñ…Ñ%‘ô(€€€€€€€€ì(€€€€€€€¥˜€¡É•µ½Ù•¹½Õ¹Ð€ôôô€À¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ÐÀÐ°(€€€€€€€€€€€€]=I-}=9M%9}9=Q}=U9œ°(€€€€€€€€€€€€Q¡¥Ì½¹Í¥¹•”¥Ì¹½Ð±¥¹­•Ñ¼Ñ¡”]½É¬¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€Ý½É¬¹½¹Í¥¹••}Õ¹±¥¹­•œ°(€€€€€€€€€€Ý½É­Ìœ°(€€€€€€€€€Ý½É­%°(€€€€€€€€€ì½¹Ñ…Ñ%ô°(€€€€€€€€¤ì(€€€€€ô¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÐ¤¹Í•¹ ¤ì(€€€ô°(€€¤ì((€€¼¼€´´´1½…Ñ¥½¸µ…ÍÑ•ÉÌ€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((€…ÁÀ¹•Ð (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½±½…Ñ¥½¹Ìœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€ÅÕ•ÉåÍÑÉ¥¹œè1¥ÍÑEÕ•ÉåM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀè1½…Ñ¥½¹5…ÍÑ•É1¥ÍÑI•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥¹±Õ‘•I•Ñ¥É•€ô™…±Í”ô€ôÉ•ÅÕ•ÍÐ¹ÅÕ•Éä…Ìì(€€€€€€€¥¹±Õ‘•I•Ñ¥É•üè‰½½±•…¸ì(€€€€€ôì(€€€€€½¹ÍÐÉ½ÝÌ€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøÑàñ1½…Ñ¥½¹I½Ýmtù€(€€€€€€€€€Í•±•Ð¥°¹…µ”°­¥¹°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€€™É½´±½…Ñ¥½¹}µ…ÍÑ•ÉÌ(€€€€€€€€€Ý¡•É”…Ñ¥Ù”½È€‘í¥¹±Õ‘•I•Ñ¥É•‘ô(€€€€€€€€€½É‘•È‰ä±½Ý•È¡¹…µ”¤°­¥¹(€€€€€€€€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸ì±½…Ñ¥½¹ÌèÉ½ÝÌ¹µ…À¡Ñ½1½…Ñ¥½¸¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½±½…Ñ¥½¹Ìœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€‰½‘äèM…Ù•1½…Ñ¥½¹5…ÍÑ•ÉI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÄè1½…Ñ¥½¹5…ÍÑ•ÉM¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ°É•Á±ä¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…ÌM…Ù•1½…Ñ¥½¹5…ÍÑ•ÉI•ÅÕ•ÍÐì(€€€€€½¹ÍÐ±½…Ñ¥½¸€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñ1½…Ñ¥½¹I½Ýmtù€(€€€€€€€€€€€¥¹Í•ÉÐ¥¹Ñ¼±½…Ñ¥½¹}µ…ÍÑ•ÉÌ€ (€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°¹…µ”°­¥¹°É•…Ñ•‘}‰å}ÕÍ•É}¥(€€€€€€€€€€€€¤(€€€€€€€€€€€Ù…±Õ•Ì€ ‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘í‰½‘ä¹¹…µ•ô°€‘í‰½‘ä¹­¥¹‘ô°€‘íÕÍ•È¹¥‘ô¤(€€€€€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°­¥¹°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½Ý¸¤€ôøì(€€€€€€€€€€€¥˜€¡¥ÍU¹¥ÅÕ•Y¥½±…Ñ¥½¸¡•ÉÉ½È¤¤ì(€€€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€€€1=Q%=9}5MQI}a%MQLœ°(€€€€€€€€€€€€€€€€±½…Ñ¥½¸Ý¥Ñ Ñ¡¥Ì¹…µ”…¹­¥¹…±É•…‘ä•á¥ÍÑÌ€¡¥Ðµ…ä‰”É•Ñ¥É•ƒŠPÉ•…Ñ¥Ù…Ñ”¥Ð¥¹ÍÑ•…¤¸œ°(€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€ô(€€€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€€€ô¤ì(€€€€€€€€€¥˜€ …É½Ü¤Ñ¡É½Ü¹•ÜÉÉ½È ±½…Ñ¥½¸µ…ÍÑ•È¥¹Í•ÉÐÉ•ÑÕÉ¹•¹¼É½Üœ¤ì(€€€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€€€Ñà°(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€€€±½…Ñ¥½¹}µ…ÍÑ•È¹É•…Ñ•œ°(€€€€€€€€€€€€±½…Ñ¥½¹}µ…ÍÑ•ÉÌœ°(€€€€€€€€€€€É½Ü¹¥°(€€€€€€€€€€€ì¹…µ”è‰½‘ä¹¹…µ”°­¥¹è‰½‘ä¹­¥¹ô°(€€€€€€€€€€¤ì(€€€€€€€€€É•ÑÕÉ¸Ñ½1½…Ñ¥½¸¡É½Ü¤ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÄ¤¹Í•¹¡±½…Ñ¥½¸¤ì(€€€ô°(€€¤ì((€…ÁÀ¹ÁÕÐ (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½±½…Ñ¥½¹Ì¼é¥œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äèM…Ù•1½…Ñ¥½¹5…ÍÑ•ÉI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀè1½…Ñ¥½¹5…ÍÑ•ÉM¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…ÌM…Ù•1½…Ñ¥½¹5…ÍÑ•ÉI•ÅÕ•ÍÐì(€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñ1½…Ñ¥½¹I½Ýmtù€(€€€€€€€€€ÕÁ‘…Ñ”±½…Ñ¥½¹}µ…ÍÑ•ÉÌ(€€€€€€€€€Í•Ð¹…µ”€ô€‘í‰½‘ä¹¹…µ•ô°­¥¹€ô€‘í‰½‘ä¹­¥¹‘ô(€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°­¥¹°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½Ý¸¤€ôøì(€€€€€€€€€¥˜€¡¥ÍU¹¥ÅÕ•Y¥½±…Ñ¥½¸¡•ÉÉ½È¤¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€1=Q%=9}5MQI}a%MQLœ°(€€€€€€€€€€€€€€¹½Ñ¡•È±½…Ñ¥½¸…±É•…‘ä…ÉÉ¥•ÌÑ¡¥Ì¹…µ”…¹­¥¹¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€ô¤ì(€€€€€€€¥˜€ …É½Ü¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È ÐÀÐ°€1=Q%=9}5MQI}9=Q}=U9œ°€9¼ÍÕ ±½…Ñ¥½¸¸œ¤ì(€€€€€€€ô(€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€±½…Ñ¥½¹}µ…ÍÑ•È¹ÕÁ‘…Ñ•œ°(€€€€€€€€€€±½…Ñ¥½¹}µ…ÍÑ•ÉÌœ°(€€€€€€€€€¥°(€€€€€€€€€ì¹…µ”è‰½‘ä¹¹…µ”°­¥¹è‰½‘ä¹­¥¹ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸Ñ½1½…Ñ¥½¸¡É½Ü¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì((€É•¥ÍÑ•ÉÑ¥Ù•Q½±”ñ1½…Ñ¥½¹I½Ü°1½…Ñ¥½¹5…ÍÑ•Èø¡ì(€€€Á…Ñ è€œ½…Á¤½µ…ÍÑ•ÉÌ½±½…Ñ¥½¹Ìœ°(€€€•¹Ñ¥Ñäè€±½…Ñ¥½¹}µ…ÍÑ•Èœ°(€€€•¹Ñ¥ÑåQåÁ”è€±½…Ñ¥½¹}µ…ÍÑ•ÉÌœ°(€€€¹½Ñ½Õ¹‘½‘”è€1=Q%=9}5MQI}9=Q}=U9œ°(€€€¹½Ñ½Õ¹‘5•ÍÍ…”è€9¼ÍÕ ±½…Ñ¥½¸¸œ°(€€€ÕÁ‘…Ñ”è…Íå¹Œ€¡Ñà°¥°…Ñ¥Ù”¤€ôøì(€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñ1½…Ñ¥½¹I½Ýmtù€(€€€€€€€ÕÁ‘…Ñ”±½…Ñ¥½¹}µ…ÍÑ•ÉÌÍ•Ð…Ñ¥Ù”€ô€‘í…Ñ¥Ù•ô(€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°­¥¹°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€ì(€€€€€É•ÑÕÉ¸É½Üì(€€€ô°(€€€µ…ÀèÑ½1½…Ñ¥½¸°(€€€É•ÍÁ½¹Í•M¡•µ„è1½…Ñ¥½¹5…ÍÑ•ÉM¡•µ„°(€ô¤ì((€€¼¼€´´´U¹¥Ðµ…ÍÑ•ÉÌ€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((€…ÁÀ¹•Ð (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½Õ¹¥ÑÌœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€ÅÕ•ÉåÍÑÉ¥¹œè1¥ÍÑEÕ•ÉåM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèU¹¥Ñ5…ÍÑ•É1¥ÍÑI•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥¹±Õ‘•I•Ñ¥É•€ô™…±Í”ô€ôÉ•ÅÕ•ÍÐ¹ÅÕ•Éä…Ìì(€€€€€€€¥¹±Õ‘•I•Ñ¥É•üè‰½½±•…¸ì(€€€€€ôì(€€€€€½¹ÍÐÉ½ÝÌ€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€€¼¼•™…Õ±ÑÌ…ÁÁ•…È½¸™¥ÉÍÐÉ•…°™½È…¹äµ•µ‰•ÈèÍ••‘¥¹œ¥Ì(€€€€€€€€€€¼¼¥‘•µÁ½Ñ•¹ÐÍåÍÑ•´ÁÉ½Ù¥Í¥½¹¥¹œ°¹½ÐÕÍ•È½¹Ñ•¹ÐƒŠPÍ•”(€€€€€€€€€€¼¼•¹ÍÕÉ••™…Õ±ÑU¹¥ÑÌ¸(€€€€€€€€€…Ý…¥Ð•¹ÍÕÉ••™…Õ±ÑU¹¥ÑÌ¡Ñà°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥¤ì(€€€€€€€€€É•ÑÕÉ¸ÑàñU¹¥ÑI½Ýmtù€(€€€€€€€€€€€Í•±•Ð¥°¹…µ”°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€€€€™É½´Õ¹¥Ñ}µ…ÍÑ•ÉÌ(€€€€€€€€€€€Ý¡•É”…Ñ¥Ù”½È€‘í¥¹±Õ‘•I•Ñ¥É•‘ô(€€€€€€€€€€€½É‘•È‰ä±½Ý•È¡¹…µ”¤(€€€€€€€€€€ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸ìÕ¹¥ÑÌèÉ½ÝÌ¹µ…À¡Ñ½U¹¥Ð¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½Õ¹¥ÑÌœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€‰½‘äèM…Ù•U¹¥Ñ5…ÍÑ•ÉI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÄèU¹¥Ñ5…ÍÑ•ÉM¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ°É•Á±ä¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…ÌM…Ù•U¹¥Ñ5…ÍÑ•ÉI•ÅÕ•ÍÐì(€€€€€½¹ÍÐÕ¹¥Ð€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñU¹¥ÑI½Ýmtù€(€€€€€€€€€€€¥¹Í•ÉÐ¥¹Ñ¼Õ¹¥Ñ}µ…ÍÑ•ÉÌ€¡½É…¹¥Í…Ñ¥½¹}¥°¹…µ”°É•…Ñ•‘}‰å}ÕÍ•É}¥¤(€€€€€€€€€€€Ù…±Õ•Ì€ ‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘í‰½‘ä¹¹…µ•ô°€‘íÕÍ•È¹¥‘ô¤(€€€€€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½Ý¸¤€ôøì(€€€€€€€€€€€¥˜€¡¥ÍU¹¥ÅÕ•Y¥½±…Ñ¥½¸¡•ÉÉ½È¤¤ì(€€€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€€€U9%Q}5MQI}a%MQLœ°(€€€€€€€€€€€€€€€€Õ¹¥ÐÝ¥Ñ Ñ¡¥Ì¹…µ”…±É•…‘ä•á¥ÍÑÌ€¡¥Ðµ…ä‰”É•Ñ¥É•ƒŠPÉ•…Ñ¥Ù…Ñ”¥Ð¥¹ÍÑ•…¤¸œ°(€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€ô(€€€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€€€ô¤ì(€€€€€€€€€¥˜€ …É½Ü¤Ñ¡É½Ü¹•ÜÉÉ½È Õ¹¥Ðµ…ÍÑ•È¥¹Í•ÉÐÉ•ÑÕÉ¹•¹¼É½Üœ¤ì(€€€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€€€Ñà°(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€€€Õ¹¥Ñ}µ…ÍÑ•È¹É•…Ñ•œ°(€€€€€€€€€€€€Õ¹¥Ñ}µ…ÍÑ•ÉÌœ°(€€€€€€€€€€€É½Ü¹¥°(€€€€€€€€€€€ì¹…µ”è‰½‘ä¹¹…µ”ô°(€€€€€€€€€€¤ì(€€€€€€€€€É•ÑÕÉ¸Ñ½U¹¥Ð¡É½Ü¤ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÄ¤¹Í•¹¡Õ¹¥Ð¤ì(€€€ô°(€€¤ì((€…ÁÀ¹ÁÕÐ (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½Õ¹¥ÑÌ¼é¥œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äèM…Ù•U¹¥Ñ5…ÍÑ•ÉI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèU¹¥Ñ5…ÍÑ•ÉM¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…ÌM…Ù•U¹¥Ñ5…ÍÑ•ÉI•ÅÕ•ÍÐì(€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñU¹¥ÑI½Ýmtù€(€€€€€€€€€ÕÁ‘…Ñ”Õ¹¥Ñ}µ…ÍÑ•ÉÌÍ•Ð¹…µ”€ô€‘í‰½‘ä¹¹…µ•ô(€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½Ý¸¤€ôøì(€€€€€€€€€¥˜€¡¥ÍU¹¥ÅÕ•Y¥½±…Ñ¥½¸¡•ÉÉ½È¤¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€U9%Q}5MQI}a%MQLœ°(€€€€€€€€€€€€€€¹½Ñ¡•ÈÕ¹¥Ð…±É•…‘ä…ÉÉ¥•ÌÑ¡¥Ì¹…µ”¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€ô¤ì(€€€€€€€¥˜€ …É½Ü¤Ñ¡É½Ü¡ÑÑÁÉÉ½È ÐÀÐ°€U9%Q}5MQI}9=Q}=U9œ°€9¼ÍÕ Õ¹¥Ð¸œ¤ì(€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€Õ¹¥Ñ}µ…ÍÑ•È¹ÕÁ‘…Ñ•œ°(€€€€€€€€€€Õ¹¥Ñ}µ…ÍÑ•ÉÌœ°(€€€€€€€€€¥°(€€€€€€€€€ì¹…µ”è‰½‘ä¹¹…µ”ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸Ñ½U¹¥Ð¡É½Ü¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì((€É•¥ÍÑ•ÉÑ¥Ù•Q½±”ñU¹¥ÑI½Ü°U¹¥Ñ5…ÍÑ•Èø¡ì(€€€Á…Ñ è€œ½…Á¤½µ…ÍÑ•ÉÌ½Õ¹¥ÑÌœ°(€€€•¹Ñ¥Ñäè€Õ¹¥Ñ}µ…ÍÑ•Èœ°(€€€•¹Ñ¥ÑåQåÁ”è€Õ¹¥Ñ}µ…ÍÑ•ÉÌœ°(€€€¹½Ñ½Õ¹‘½‘”è€U9%Q}5MQI}9=Q}=U9œ°(€€€¹½Ñ½Õ¹‘5•ÍÍ…”è€9¼ÍÕ Õ¹¥Ð¸œ°(€€€ÕÁ‘…Ñ”è…Íå¹Œ€¡Ñà°¥°…Ñ¥Ù”¤€ôøì(€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñU¹¥ÑI½Ýmtù€(€€€€€€€ÕÁ‘…Ñ”Õ¹¥Ñ}µ…ÍÑ•ÉÌÍ•Ð…Ñ¥Ù”€ô€‘í…Ñ¥Ù•ô(€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€ì(€€€€€É•ÑÕÉ¸É½Üì(€€€ô°(€€€µ…ÀèÑ½U¹¥Ð°(€€€É•ÍÁ½¹Í•M¡•µ„èU¹¥Ñ5…ÍÑ•ÉM¡•µ„°(€ô¤ì((€€¼¼€´´´=É…¹¥Í…Ñ¥½¸Í¥¹…Ñ½É¥•Ì€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((€…ÁÀ¹•Ð (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½Í¥¹…Ñ½É¥•Ìœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€ÅÕ•ÉåÍÑÉ¥¹œè1¥ÍÑEÕ•ÉåM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèM¥¹…Ñ½Éå1¥ÍÑI•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥¹±Õ‘•I•Ñ¥É•€ô™…±Í”ô€ôÉ•ÅÕ•ÍÐ¹ÅÕ•Éä…Ìì(€€€€€€€¥¹±Õ‘•I•Ñ¥É•üè‰½½±•…¸ì(€€€€€ôì(€€€€€½¹ÍÐÉ½ÝÌ€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøÑàñM¥¹…Ñ½ÉåI½Ýmtù€(€€€€€€€€€Í•±•Ð¥°¹…µ”°‘•Í¥¹…Ñ¥½¸°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€€™É½´½É…¹¥Í…Ñ¥½¹}Í¥¹…Ñ½É¥•Ì(€€€€€€€€€Ý¡•É”…Ñ¥Ù”½È€‘í¥¹±Õ‘•I•Ñ¥É•‘ô(€€€€€€€€€½É‘•È‰ä±½Ý•È¡¹…µ”¤°±½Ý•È¡‘•Í¥¹…Ñ¥½¸¤(€€€€€€€€°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸ìÍ¥¹…Ñ½É¥•ÌèÉ½ÝÌ¹µ…À¡Ñ½M¥¹…Ñ½Éä¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹Á½ÍÐ (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½Í¥¹…Ñ½É¥•Ìœ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€‰½‘äèM…Ù•M¥¹…Ñ½ÉåI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÄèM¥¹…Ñ½ÉåM¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ°É•Á±ä¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…ÌM…Ù•M¥¹…Ñ½ÉåI•ÅÕ•ÍÐì(€€€€€½¹ÍÐÍ¥¹…Ñ½Éä€ô…Ý…¥ÐÝ¥Ñ¡	½Õ¹‘Q•¹…¹Ð (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñM¥¹…Ñ½ÉåI½Ýmtù€(€€€€€€€€€€€¥¹Í•ÉÐ¥¹Ñ¼½É…¹¥Í…Ñ¥½¹}Í¥¹…Ñ½É¥•Ì€ (€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°¹…µ”°‘•Í¥¹…Ñ¥½¸°É•…Ñ•‘}‰å}ÕÍ•É}¥(€€€€€€€€€€€€¤(€€€€€€€€€€€Ù…±Õ•Ì€ ‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘í‰½‘ä¹¹…µ•ô°€‘í‰½‘ä¹‘•Í¥¹…Ñ¥½¹ô°€‘íÕÍ•È¹¥‘ô¤(€€€€€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°‘•Í¥¹…Ñ¥½¸°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½Ý¸¤€ôøì(€€€€€€€€€€€¥˜€¡¥ÍU¹¥ÅÕ•Y¥½±…Ñ¥½¸¡•ÉÉ½È¤¤ì(€€€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€€€M%9Q=Ie}a%MQLœ°(€€€€€€€€€€€€€€€€Í¥¹…Ñ½ÉäÝ¥Ñ Ñ¡¥Ì¹…µ”…¹‘•Í¥¹…Ñ¥½¸…±É•…‘ä•á¥ÍÑÌ€¡Ñ¡•äµ…ä‰”É•Ñ¥É•ƒŠPÉ•…Ñ¥Ù…Ñ”Ñ¡•´¥¹ÍÑ•…¤¸œ°(€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€ô(€€€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€€€ô¤ì(€€€€€€€€€¥˜€ …É½Ü¤Ñ¡É½Ü¹•ÜÉÉ½È Í¥¹…Ñ½Éä¥¹Í•ÉÐÉ•ÑÕÉ¹•¹¼É½Üœ¤ì(€€€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€€€Ñà°(€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€€€Í¥¹…Ñ½Éä¹É•…Ñ•œ°(€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}Í¥¹…Ñ½É¥•Ìœ°(€€€€€€€€€€€É½Ü¹¥°(€€€€€€€€€€€ì¹…µ”è‰½‘ä¹¹…µ”°‘•Í¥¹…Ñ¥½¸è‰½‘ä¹‘•Í¥¹…Ñ¥½¸ô°(€€€€€€€€€€¤ì(€€€€€€€€€É•ÑÕÉ¸Ñ½M¥¹…Ñ½Éä¡É½Ü¤ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÄ¤¹Í•¹¡Í¥¹…Ñ½Éä¤ì(€€€ô°(€€¤ì((€…ÁÀ¹ÁÕÐ (€€€€œ½…Á¤½µ…ÍÑ•ÉÌ½Í¥¹…Ñ½É¥•Ì¼é¥œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè%‘A…É…µÍM¡•µ„°(€€€€€€€‰½‘äèM…Ù•M¥¹…Ñ½ÉåI•ÅÕ•ÍÑM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀèM¥¹…Ñ½ÉåM¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍÐ¤€ôøì(€€€€€½¹ÍÐÕÍ•È€ô…Ý…¥ÐÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍÐ¤ì(€€€€€½¹ÍÐ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍÐ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍÐì¥ô€ôÉ•ÅÕ•ÍÐ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€½¹ÍÐ‰½‘ä€ôÉ•ÅÕ•ÍÐ¹‰½‘ä…ÌM…Ù•M¥¹…Ñ½ÉåI•ÅÕ•ÍÐì(€€€€€É•ÑÕÉ¸Ý¥Ñ¡	½Õ¹‘Q•¹…¹Ð¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…Ý…¥ÐÉ•ÅÕ¥É•]É¥Ñ•ÉI½±”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñM¥¹…Ñ½ÉåI½Ýmtù€(€€€€€€€€€ÕÁ‘…Ñ”½É…¹¥Í…Ñ¥½¹}Í¥¹…Ñ½É¥•Ì(€€€€€€€€€Í•Ð¹…µ”€ô€‘í‰½‘ä¹¹…µ•ô°‘•Í¥¹…Ñ¥½¸€ô€‘í‰½‘ä¹‘•Í¥¹…Ñ¥½¹ô(€€€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°‘•Í¥¹…Ñ¥½¸°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€€€¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½Ý¸¤€ôøì(€€€€€€€€€¥˜€¡¥ÍU¹¥ÅÕ•Y¥½±…Ñ¥½¸¡•ÉÉ½È¤¤ì(€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€ÐÀä°(€€€€€€€€€€€€€€M%9Q=Ie}a%MQLœ°(€€€€€€€€€€€€€€¹½Ñ¡•ÈÍ¥¹…Ñ½Éä…±É•…‘ä…ÉÉ¥•ÌÑ¡¥Ì¹…µ”…¹‘•Í¥¹…Ñ¥½¸¸œ°(€€€€€€€€€€€€¤ì(€€€€€€€€€ô(€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€ô¤ì(€€€€€€€¥˜€ …É½Ü¤Ñ¡É½Ü¡ÑÑÁÉÉ½È ÐÀÐ°€M%9Q=Ie}9=Q}=U9œ°€9¼ÍÕ Í¥¹…Ñ½Éä¸œ¤ì(€€€€€€€…Ý…¥Ð…Õ‘¥Ð (€€€€€€€€€Ñà°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€€ÕÍ•È¹¥°(€€€€€€€€€€Í¥¹…Ñ½Éä¹ÕÁ‘…Ñ•œ°(€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}Í¥¹…Ñ½É¥•Ìœ°(€€€€€€€€€¥°(€€€€€€€€€ì¹…µ”è‰½‘ä¹¹…µ”°‘•Í¥¹…Ñ¥½¸è‰½‘ä¹‘•Í¥¹…Ñ¥½¸ô°(€€€€€€€€¤ì(€€€€€€€É•ÑÕÉ¸Ñ½M¥¹…Ñ½Éä¡É½Ü¤ì(€€€€€ô¤ì(€€€ô°(€€¤ì((€É•¥ÍÑ•ÉÑ¥Ù•Q½±”ñM¥¹…Ñ½ÉåI½Ü°M¥¹…Ñ½Éäø¡ì(€€€Á…Ñ è€œ½…Á¤½µ…ÍÑ•ÉÌ½Í¥¹…Ñ½É¥•Ìœ°(€€€•¹Ñ¥Ñäè€Í¥¹…Ñ½Éäœ°(€€€•¹Ñ¥ÑåQåÁ”è€½É…¹¥Í…Ñ¥½¹}Í¥¹…Ñ½É¥•Ìœ°(€€€¹½Ñ½Õ¹‘½‘”è€M%9Q=Ie}9=Q}=U9œ°(€€€¹½Ñ½Õ¹‘5•ÍÍ…”è€9¼ÍÕ Í¥¹…Ñ½Éä¸œ°(€€€ÕÁ‘…Ñ”è…Íå¹Œ€¡Ñà°¥°…Ñ¥Ù”¤€ôøì(€€€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥ÐÑàñM¥¹…Ñ½ÉåI½Ýmtù€(€€€€€€€ÕÁ‘…Ñ”½É…¹¥Í…Ñ¥½¹}Í¥¹…Ñ½É¥•ÌÍ•Ð…Ñ¥Ù”€ô€‘í…Ñ¥Ù•ô(€€€€€€€Ý¡•É”¥€ô€‘í¥‘ô(€€€€€€€É•ÑÕÉ¹¥¹œ¥°¹…µ”°‘•Í¥¹…Ñ¥½¸°…Ñ¥Ù”°É•…Ñ•‘}…Ð(€€€€€€ì(€€€€€É•ÑÕÉ¸É½Üì(€€€ô°(€€€µ…ÀèÑ½M¥¹…Ñ½Éä°(€€€É•ÍÁ½¹Í•M¡•µ„èM¥¹…Ñ½ÉåM¡•µ„°(€ô¤ì)ô(