import {
  ApiErrorSchema,
  ConsigneeMasterListResponseSchema,
  ConsigneeMasterSchema,
  LocationMasterListResponseSchema,
  LocationMasterSchema,
  SaveConsigneeMasterRequestSchema,
  SaveLocationMasterRequestSchema,
  SaveSignatoryRequestSchema,
  SaveUnitMasterRequestSchema,
  SignatoryListResponseSchema,
  SignatorySchema,
  UnitMasterListResponseSchema,
  UnitMasterSchema,
  type ConsigneeMaster,
  type LocationMaster,
  type SaveConsigneeMasterRequest,
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
import { requireWriterRole } from '../authz.js';
import { httpError } from '../http.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

/**
 * Contract-domain master data: consignees, locations, units, and
 * organisation signatories. Masters are PICKERS ONLY — documents snapshot
 * whatever the user confirms into their own columns (the Delivery Challan
 * consignee stays a free-text snapshot; no document table references a
 * master), so master edits and retirements never rewrite history.
 *
 * Lifecycle: create → update → retire → reactivate. Retiring only clears
 * the active flag (always allowed, always reversible); a hard delete does
 * not exist — the application role holds no DELETE privilege on any
 * masters table (migration 0013).
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

// --- Consignee masters ------------------------------------------------------

interface ConsigneeRow {
  id: string;
  designation: string;
  address: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  active: boolean;
  created_at: Date;
}

function toConsignee(row: ConsigneeRow): ConsigneeMaster {
  return {
    id: row.id,
    designation: row.designation,
    address: row.address,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

const CONSIGNEE_COLUMNS = `
  id, designation, address, contact_person, phone, email, active, created_at
`;

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

  // --- Consignee masters ----------------------------------------------------

  app.get(
    '/api/masters/consignees',
    {
      schema: {
        querystring: ListQuerySchema,
        response: { 200: ConsigneeMasterListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { includeRetired = false } = request.query as {
        includeRetired?: boolean;
      };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => tx<ConsigneeRow[]>`
          select ${tx.unsafe(CONSIGNEE_COLUMNS)}
          from consignee_masters
          where active or ${includeRetired}
          order by lower(designation), lower(coalesce(address, ''))
        `,
      );
      return { consignees: rows.map(toConsignee) };
    },
  );

  app.post(
    '/api/masters/consignees',
    {
      schema: {
        body: SaveConsigneeMasterRequestSchema,
        response: { 201: ConsigneeMasterSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const body = request.body as SaveConsigneeMasterRequest;
      const consignee = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          const [row] = await tx<ConsigneeRow[]>`
            insert into consignee_masters (
              organisation_id, designation, address, contact_person, phone,
              email, created_by_user_id
            )
            values (
              ${organisationId}, ${body.designation}, ${body.address ?? null},
              ${body.contactPerson ?? null}, ${body.phone ?? null},
              ${body.email ?? null}, ${user.id}
            )
            returning ${tx.unsafe(CONSIGNEE_COLUMNS)}
          `.catch((error: unknown) => {
            if (isUniqueViolation(error)) {
              throw httpError(
                409,
                'CONSIGNEE_MASTER_EXISTS',
                'A consignee with this designation and address already exists (it may be retired — reactivate it instead).',
              );
            }
            throw error;
          });
          if (!row) throw new Error('consignee master insert returned no row');
          await audit(
            tx,
            organisationId,
            user.id,
            'consignee_master.created',
            'consignee_masters',
            row.id,
            { designation: body.designation },
          );
          return toConsignee(row);
        },
      );
      return reply.status(201).send(consignee);
    },
  );

  app.put(
    '/api/masters/consignees/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveConsigneeMasterRequestSchema,
        response: { 200: ConsigneeMasterSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as SaveConsigneeMasterRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const [row] = await tx<ConsigneeRow[]>`
          update consignee_masters
          set designation = ${body.designation}, address = ${body.address ?? null},
              contact_person = ${body.contactPerson ?? null},
              phone = ${body.phone ?? null}, email = ${body.email ?? null}
          where id = ${id}
          returning ${tx.unsafe(CONSIGNEE_COLUMNS)}
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'CONSIGNEE_MASTER_EXISTS',
              'Another consignee already carries this designation and address.',
            );
          }
          throw error;
        });
        if (!row) {
          throw httpError(404, 'CONSIGNEE_MASTER_NOT_FOUND', 'No such consignee.');
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'consignee_master.updated',
          'consignee_masters',
          id,
          { designation: body.designation },
        );
        return toConsignee(row);
      });
    },
  );

  registerActiveToggle<ConsigneeRow, ConsigneeMaster>({
    path: '/api/masters/consignees',
    entity: 'consignee_master',
    entityType: 'consignee_masters',
    notFoundCode: 'CONSIGNEE_MASTER_NOT_FOUND',
    notFoundMessage: 'No such consignee.',
    update: async (tx, id, active) => {
      const [row] = await tx<ConsigneeRow[]>`
        update consignee_masters set active = ${active}
        where id = ${id}
        returning ${tx.unsafe(CONSIGNEE_COLUMNS)}
      `;
      return row;
    },
    map: toConsignee,
    responseSchema: ConsigneeMasterSchema,
  });

  // --- Location masters -----------------------------------------------------

  app.get(
    '/api/masters/locations',
    {
      schema: {
        querystring: ListQuerySchema,
        response: { 200: LocationMasterListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { includeRetired = false } = request.query as {
        includeRetired?: boolean;
      };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
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

  app.post(
    '/api/masters/locations',
    {
      schema: {
        body: SaveLocationMasterRequestSchema,
        response: { 201: LocationMasterSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const body = request.body as SaveLocationMasterRequest;
      const location = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
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
        },
      );
      return reply.status(201).send(location);
    },
  );

  app.put(
    '/api/masters/locations/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveLocationMasterRequestSchema,
        response: { 200: LocationMasterSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as SaveLocationMasterRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
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

  app.get(
    '/api/masters/units',
    {
      schema: {
        querystring: ListQuerySchema,
        response: { 200: UnitMasterListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { includeRetired = false } = request.query as {
        includeRetired?: boolean;
      };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
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
        },
      );
      return { units: rows.map(toUnit) };
    },
  );

  app.post(
    '/api/masters/units',
    {
      schema: {
        body: SaveUnitMasterRequestSchema,
        response: { 201: UnitMasterSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const body = request.body as SaveUnitMasterRequest;
      const unit = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
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
        },
      );
      return reply.status(201).send(unit);
    },
  );

  app.put(
    '/api/masters/units/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveUnitMasterRequestSchema,
        response: { 200: UnitMasterSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as SaveUnitMasterRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
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

  app.get(
    '/api/masters/signatories',
    {
      schema: {
        querystring: ListQuerySchema,
        response: { 200: SignatoryListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { includeRetired = false } = request.query as {
        includeRetired?: boolean;
      };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
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

  app.post(
    '/api/masters/signatories',
    {
      schema: {
        body: SaveSignatoryRequestSchema,
        response: { 201: SignatorySchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const body = request.body as SaveSignatoryRequest;
      const signatory = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
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
        },
      );
      return reply.status(201).send(signatory);
    },
  );

  app.put(
    '/api/masters/signatories/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveSignatoryRequestSchema,
        response: { 200: SignatorySchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as SaveSignatoryRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
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
}
