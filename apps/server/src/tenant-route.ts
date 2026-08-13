import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type {
  FastifyReply,
  FastifyRequest,
  FastifySchema,
  HTTPMethods,
  RawRequestDefaultExpression,
  RawServerDefault,
  RouteGenericInterface,
  preValidationHookHandler,
} from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from './app-instance.js';
import type { Auth } from './auth.js';
import {
  requireAuthority,
  requireEvidenceRole,
  requireOwnerRole,
  requireWriterRole,
} from './authz.js';
import { requireUser, type SessionUser } from './session.js';
import {
  requireOrganisationHeader,
  withBoundTenant,
  withBoundTenantSnapshot,
} from './tenant-context.js';

/**
 * Every tenant-scoped route shares one preamble: prove the session
 * (requireUser), validate the x-organisation-id header shape
 * (requireOrganisationHeader), and reach tenant data only through the
 * membership-bound transaction (withBoundTenant / withBoundTenantSnapshot).
 * This module owns that preamble as a MECHANISM instead of a convention
 * repeated at the top of ~200 handlers: a route registered through
 * `createTenantRouteRegistrar` cannot forget it, and the route-inventory
 * test walks the registry below to prove that every /api/* route outside
 * the documented unbound set went through here.
 *
 * Deliberately a plain function, not a Fastify plugin or decorator: the
 * codebase registers routes with explicit calls and explicit dependencies,
 * and a plugin would put the same facts behind fastify-plugin encapsulation
 * where they are harder to grep and to type. The handler receives the
 * resolved identity plus `tenant`/`tenantSnapshot` closures rather than a
 * pre-opened transaction, because several routes legitimately run more than
 * one bound transaction with external work (Gotenberg, object storage, the
 * statutory provider) in between — the closure keeps the binding mechanism
 * mandatory without dictating transaction shape.
 */

/** Role requirements a route may declare instead of calling the authz
 * helper as the first statement of its transaction. The check runs inside
 * EVERY bound transaction the handler opens, in exactly the position the
 * inline call occupied. Routes whose checks differ per transaction or are
 * branched (e.g. quotation outcomes) keep their inline calls and declare
 * nothing. */
export type TenantRouteRole = 'writer' | 'owner' | 'evidence';

export interface TenantRouteOptions<Schema extends FastifySchema> {
  readonly method: HTTPMethods;
  readonly url: string;
  readonly schema: Schema;
  /** Raw-body upload routes cap their payload here, same as the native
   * route option. */
  readonly bodyLimit?: number;
  /** Passed through verbatim (the organisation profile route folds GSTIN
   * case ahead of validation). */
  readonly preValidation?: preValidationHookHandler;
  readonly role?: TenantRouteRole;
  readonly authority?: 'issue' | 'cancel';
}

/** The request as the TypeBox provider types it from the route's schema. */
export type TenantRouteRequest<Schema extends FastifySchema> = FastifyRequest<
  RouteGenericInterface,
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  Schema,
  TypeBoxTypeProvider
>;

export interface TenantRouteContext<Schema extends FastifySchema> {
  readonly request: TenantRouteRequest<Schema>;
  readonly reply: FastifyReply;
  /** The authenticated session user — requireUser already ran. */
  readonly user: SessionUser;
  /** The validated x-organisation-id header — membership is NOT yet
   * proven; only `tenant`/`tenantSnapshot` prove it. */
  readonly organisationId: string;
  /** One membership-bound transaction (withBoundTenant), with the route's
   * declared role/authority checked first. */
  readonly tenant: <T>(work: (tx: TransactionSql) => Promise<T>) => Promise<T>;
  /** The REPEATABLE READ variant (withBoundTenantSnapshot), same checks. */
  readonly tenantSnapshot: <T>(work: (tx: TransactionSql) => Promise<T>) => Promise<T>;
}

export type TenantRouteHandler<Schema extends FastifySchema> = (
  context: TenantRouteContext<Schema>,
) => unknown;

/** What the route-inventory test needs to exercise a wrapper route:
 * its schema (to synthesise a validation-passing request) and the raw
 * upload body limit where one applies. */
export interface TenantRouteRecord {
  readonly method: HTTPMethods;
  readonly url: string;
  readonly schema: FastifySchema;
  readonly bodyLimit?: number;
}

/** Which routes were registered through the wrapper, per app instance —
 * keyed `"METHOD url"`. The route-inventory test reads this to assert the
 * wrapper is the only way tenant routes come into being. */
const registries = new WeakMap<object, Map<string, TenantRouteRecord>>();

export function tenantRoutesOf(
  app: AppInstance,
): ReadonlyMap<string, TenantRouteRecord> {
  return registries.get(app) ?? new Map();
}

/** The full Fastify route table, captured with an onRoute hook installed
 * by buildApp before any route registers — `"METHOD url"` strings. The
 * route-inventory test diffs this against the wrapper registry and the
 * documented unbound set, so a route registered around the wrapper is a
 * test failure, not a convention slip. */
const routeTables = new WeakMap<object, Set<string>>();

export function recordRegisteredRoutes(app: AppInstance): void {
  const table = new Set<string>();
  routeTables.set(app, table);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) table.add(`${method} ${route.url}`);
  });
}

export function registeredRoutesOf(app: AppInstance): ReadonlySet<string> {
  return routeTables.get(app) ?? new Set();
}

export function createTenantRouteRegistrar(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): <Schema extends FastifySchema>(
  options: TenantRouteOptions<Schema>,
  handler: TenantRouteHandler<Schema>,
) => void {
  let registry = registries.get(app);
  if (registry === undefined) {
    registry = new Map();
    registries.set(app, registry);
  }
  const routes = registry;

  return function tenantRoute<Schema extends FastifySchema>(
    options: TenantRouteOptions<Schema>,
    handler: TenantRouteHandler<Schema>,
  ): void {
    const { method, url, schema, bodyLimit, preValidation, role, authority } = options;
    routes.set(`${method} ${url}`, {
      method,
      url,
      schema,
      ...(bodyLimit !== undefined ? { bodyLimit } : {}),
    });

    /** Runs first inside every bound transaction, where the inline call
     * used to sit. */
    const guard = async (tx: TransactionSql, userId: string): Promise<void> => {
      if (role === 'writer') await requireWriterRole(tx, userId);
      else if (role === 'owner') await requireOwnerRole(tx, userId);
      else if (role === 'evidence') await requireEvidenceRole(tx, userId);
      if (authority !== undefined) await requireAuthority(tx, userId, authority);
    };

    // Widened to the base FastifySchema for registration so the reply
    // return type resolves to unknown here — the handler's payload passes
    // through exactly as it did when the routes were registered directly.
    // The context below still types the request from the route's own Schema.
    const registrationSchema: FastifySchema = schema;

    app.route({
      method,
      url,
      schema: registrationSchema,
      ...(bodyLimit !== undefined ? { bodyLimit } : {}),
      ...(preValidation !== undefined ? { preValidation } : {}),
      handler: async (request, reply) => {
        // Same order and same lifecycle position as the handlers always
        // had: schema validation has already run; the session check comes
        // before the header check, and membership is proven only inside
        // the tenant transaction.
        const user = await requireUser(auth, request);
        const organisationId = requireOrganisationHeader(
          request.headers['x-organisation-id'],
        );
        return handler({
          request: request as TenantRouteRequest<Schema>,
          reply,
          user,
          organisationId,
          tenant: (work) =>
            withBoundTenant(database, organisationId, user.id, async (tx) => {
              await guard(tx, user.id);
              return work(tx);
            }),
          tenantSnapshot: (work) =>
            withBoundTenantSnapshot(database, organisationId, user.id, async (tx) => {
              await guard(tx, user.id);
              return work(tx);
            }),
        });
      },
    });
  };
}
