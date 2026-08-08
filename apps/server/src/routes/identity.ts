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
  type SetAssignmentsRequest,
  type UpdateMemberRequest,
  MemberAssignmentsResponseSchema,
  SetAssignmentsRequestSchema,
  UpdateMemberRequestSchema,
} from '@auto-mb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { jsonb, withUserContext } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { httpError } from './../http.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

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
              ${jsonb(tx, { memberUserId: target.id, role: body.role })}
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

  app.patch<{ Body: UpdateMemberRequest }>(
    '/api/organisations/current/members/:userId',
    {
      schema: {
        body: UpdateMemberRequestSchema,
        response: { 200: MemberListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { userId: memberUserId } = request.params as { userId: string };
      const body = request.body;
      const members = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          // Serialise membership edits per organisation: the last-owner
          // check below counts rows it has NOT locked, so two concurrent
          // demotions of two different owners could each observe the other
          // and both proceed, leaving no active owner (external re-audit).
          // The organisation row lock makes the count race-free, and taking
          // it before the requester check means a concurrently-demoted
          // owner cannot act on a stale reading of their own role.
          await tx`
            select id from organisations where id = ${organisationId} for update
          `;
          const [requester] = await tx<{ role: string }[]>`
            select role from organisation_memberships where user_id = ${user.id}
          `;
          if (requester?.role !== 'owner') {
            throw httpError(
              403,
              'OWNER_REQUIRED',
              'Only an organisation owner may manage members.',
            );
          }
          const [current] = await tx<
            {
              role: string;
              status: string;
              work_scope: string;
              can_issue_documents: boolean;
              can_cancel_documents: boolean;
            }[]
          >`
            select role, status, work_scope, can_issue_documents,
                   can_cancel_documents
            from organisation_memberships
            where user_id = ${memberUserId}
            for update
          `;
          if (!current) {
            throw httpError(404, 'MEMBER_NOT_FOUND', 'No such member.');
          }

          // The organisation must always keep one active owner: the last
          // one can be neither demoted nor disabled.
          const demotesOwner =
            current.role === 'owner' &&
            ((body.role !== undefined && body.role !== 'owner') ||
              body.status === 'disabled');
          if (demotesOwner) {
            const [owners] = await tx<{ count: string }[]>`
              select count(*)::text as count from organisation_memberships
              where role = 'owner' and status = 'active'
            `;
            if (Number(owners?.count ?? '0') <= 1) {
              throw httpError(
                409,
                'LAST_OWNER',
                'The organisation must keep at least one active owner.',
              );
            }
          }

          await tx`
            update organisation_memberships set
              role = coalesce(${body.role ?? null}, role),
              work_scope = coalesce(${body.workScope ?? null}, work_scope),
              can_issue_documents =
                coalesce(${body.canIssueDocuments ?? null}, can_issue_documents),
              can_cancel_documents =
                coalesce(${body.canCancelDocuments ?? null}, can_cancel_documents),
              status = coalesce(${body.status ?? null}, status),
              updated_at = now()
            where user_id = ${memberUserId}
          `;
          // Milestone 6: the trail records what each changed field was
          // and became, not just which keys were touched.
          const changes = auditDiff(
            {
              role: current.role,
              workScope: current.work_scope,
              canIssueDocuments: current.can_issue_documents,
              canCancelDocuments: current.can_cancel_documents,
              status: current.status,
            },
            {
              role: body.role ?? current.role,
              workScope: body.workScope ?? current.work_scope,
              canIssueDocuments: body.canIssueDocuments ?? current.can_issue_documents,
              canCancelDocuments:
                body.canCancelDocuments ?? current.can_cancel_documents,
              status: body.status ?? current.status,
            },
          );
          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, details
            )
            values (
              ${organisationId}, ${user.id}, 'membership.updated',
              'organisation_memberships',
              ${jsonb(tx, { memberUserId, before: changes.before, after: changes.after })}
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
      return { members: members.map(toMembership) };
    },
  );

  app.get(
    '/api/organisations/current/members/:userId/assignments',
    {
      schema: {
        response: { 200: MemberAssignmentsResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { userId: memberUserId } = request.params as { userId: string };
      const workIds = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [requester] = await tx<{ role: string }[]>`
            select role from organisation_memberships where user_id = ${user.id}
          `;
          if (requester?.role !== 'owner' && user.id !== memberUserId) {
            throw httpError(
              403,
              'OWNER_REQUIRED',
              "Only an organisation owner may view other members' assignments.",
            );
          }
          const rows = await tx<{ work_id: string }[]>`
            select work_id from work_assignments
            where user_id = ${memberUserId}
            order by created_at
          `;
          return rows.map((row) => row.work_id);
        },
      );
      return { userId: memberUserId, workIds };
    },
  );

  app.put<{ Body: SetAssignmentsRequest }>(
    '/api/organisations/current/members/:userId/assignments',
    {
      schema: {
        body: SetAssignmentsRequestSchema,
        response: { 200: MemberAssignmentsResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { userId: memberUserId } = request.params as { userId: string };
      const body = request.body;
      const workIds = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [requester] = await tx<{ role: string }[]>`
            select role from organisation_memberships where user_id = ${user.id}
          `;
          if (requester?.role !== 'owner') {
            throw httpError(
              403,
              'OWNER_REQUIRED',
              'Only an organisation owner may manage assignments.',
            );
          }
          const [member] = await tx<{ user_id: string }[]>`
            select user_id from organisation_memberships
            where user_id = ${memberUserId}
          `;
          if (!member) {
            throw httpError(404, 'MEMBER_NOT_FOUND', 'No such member.');
          }
          // The audit event carries the assignment set as it was and as
          // it becomes; read the old set before the replace wipes it.
          const previous = await tx<{ work_id: string }[]>`
            select work_id from work_assignments
            where user_id = ${memberUserId}
            order by created_at
          `;
          // Replace-set semantics: assignments are access control, not
          // history — the new list is the whole truth.
          await tx`
            delete from work_assignments where user_id = ${memberUserId}
          `;
          for (const workId of body.workIds) {
            await tx`
              insert into work_assignments (
                organisation_id, work_id, user_id, created_by_user_id
              )
              values (${organisationId}, ${workId}, ${memberUserId}, ${user.id})
            `.catch((error: unknown) => {
              if (error instanceof Error && 'code' in error && error.code === '23503') {
                throw httpError(
                  404,
                  'WORK_NOT_FOUND',
                  'An assigned Work does not exist in this organisation.',
                );
              }
              throw error;
            });
          }
          // Assignments are a set; both sides sort so a reordered PUT of
          // the same Works records no spurious change.
          const changes = auditDiff(
            { workIds: previous.map((row) => row.work_id).sort() },
            { workIds: [...body.workIds].sort() },
          );
          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, details
            )
            values (
              ${organisationId}, ${user.id}, 'membership.assignments_set',
              'work_assignments',
              ${jsonb(tx, { memberUserId, before: changes.before, after: changes.after })}
            )
          `;
          const rows = await tx<{ work_id: string }[]>`
            select work_id from work_assignments
            where user_id = ${memberUserId}
            order by created_at
          `;
          return rows.map((row) => row.work_id);
        },
      );
      return { userId: memberUserId, workIds };
    },
  );
}
