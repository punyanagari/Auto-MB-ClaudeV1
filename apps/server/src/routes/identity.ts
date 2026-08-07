import {
  AddMemberRequestSchema,
  ApiErrorSchema,
  CreateOrganisationRequestSchema,
  MemberListResponseSchema,
  OrganisationListResponseSchema,
  OrganisationSchema,
  type AddMemberRequest,
  type CreateOrganisationRequest,
  type Membership,
} from '@auto-mb/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { withUserContext } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { httpError, toWebHeaders } from './../http.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

interface SessionUser {
  readonly id: string;
  readonly email: string;
}

async function requireUser(auth: Auth, request: FastifyRequest): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: toWebHeaders(request) });
  if (!session) {
    throw httpError(401, 'UNAUTHENTICATED', 'Sign in to use this endpoint.');
  }
  return { id: session.user.id, email: session.user.email };
}

interface MembershipRow {
  organisation_id: string;
  user_id: string;
  role: Membership['role'];
  work_scope: Membership['workScope'];
  can_issue_documents: boolean;
  can_cancel_documents: boolean;
  status: Membership['status'];
}

function toMembership(row: MembershipRow): Membership {
  return {
    organisationId: row.organisation_id,
    userId: row.user_id,
    role: row.role,
    workScope: row.work_scope,
    canIssueDocuments: row.can_issue_documents,
    canCancelDocuments: row.can_cancel_documents,
    status: row.status,
  };
}

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

export function registerIdentityRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
): void {
  app.get(
    '/api/me',
    { schema: { response: { ...errorResponses } } },
    async (request) => {
      const user = await requireUser(auth, request);
      const memberships = await withUserContext(
        database,
        user.id,
        (tx) =>
          tx<MembershipRow[]>`
          select organisation_id, user_id, role, work_scope,
                 can_issue_documents, can_cancel_documents, status
          from organisation_memberships
          order by organisation_id
        `,
      );
      return {
        user,
        memberships: memberships.map(toMembership),
      };
    },
  );

  app.get(
    '/api/organisations',
    {
      schema: {
        response: { 200: OrganisationListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisations = await withUserContext(
        database,
        user.id,
        (tx) =>
          tx<{ id: string; name: string; slug: string }[]>`
          select id, name, slug from organisations order by name, id
        `,
      );
      return { organisations };
    },
  );

  app.post(
    '/api/organisations',
    {
      schema: {
        body: CreateOrganisationRequestSchema,
        response: { 201: OrganisationSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const body = request.body as CreateOrganisationRequest;
      const created = await withUserContext(database, user.id, async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          select app_private.create_organisation_with_owner(${body.name}, ${body.slug}) as id
        `;
        if (!row) throw new Error('organisation bootstrap returned no row');
        return row.id;
      }).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === '23505') {
          throw httpError(
            409,
            'SLUG_TAKEN',
            'An organisation with this slug already exists.',
          );
        }
        throw error;
      });
      return reply.status(201).send({ id: created, name: body.name, slug: body.slug });
    },
  );

  app.get(
    '/api/organisations/current/members',
    {
      schema: {
        response: { 200: MemberListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const members = await withBoundTenant(
        database,
        organisationId,
        user.id,
        (tx) =>
          tx<MembershipRow[]>`
            select organisation_id, user_id, role, work_scope,
                   can_issue_documents, can_cancel_documents, status
            from organisation_memberships
            order by created_at, user_id
          `,
      );
      return { members: members.map(toMembership) };
    },
  );

  app.post(
    '/api/organisations/current/members',
    {
      schema: {
        body: AddMemberRequestSchema,
        response: { 201: MemberListResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const body = request.body as AddMemberRequest;

      const members = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [requester] = await tx<{ role: string }[]>`
            select role from organisation_memberships
            where user_id = ${user.id}
          `;
          if (requester?.role !== 'owner') {
            throw httpError(
              403,
              'OWNER_REQUIRED',
              'Only an organisation owner may manage members.',
            );
          }

          const [target] = await tx<{ id: string }[]>`
            select "id" from auth_users where "email" = ${body.email}
          `;
          if (!target) {
            throw httpError(
              404,
              'USER_NOT_FOUND',
              'No account exists for this email; ask them to sign up first.',
            );
          }

          await tx`
            insert into organisation_memberships (
              organisation_id, user_id, role, work_scope,
              can_issue_documents, can_cancel_documents, status
            )
            values (
              ${organisationId}, ${target.id}, ${body.role},
              ${body.workScope ?? 'all'},
              ${body.canIssueDocuments ?? false},
              ${body.canCancelDocuments ?? false},
              'active'
            )
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'ALREADY_A_MEMBER',
                'This user already has a membership in the organisation.',
              );
            }
            throw error;
          });

          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, details
            )
            values (
              ${organisationId}, ${user.id}, 'membership.added',
              'organisation_memberships',
              ${JSON.stringify({ memberUserId: target.id, role: body.role })}::jsonb
            )
          `;

          return tx<MembershipRow[]>`
            select organisation_id, user_id, role, work_scope,
                   can_issue_documents, can_cancel_documents, status
            from organisation_memberships
            order by created_at, user_id
          `;
        },
      );
      return reply.status(201).send({ members: members.map(toMembership) });
    },
  );
}
