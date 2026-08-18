import {
  AddMemberRequestSchema,
  CreateOrganisationRequestSchema,
  MemberListResponseSchema,
  OrganisationListResponseSchema,
  OrganisationSchema,
  type Membership,
  MemberAssignmentsResponseSchema,
  SetAssignmentsRequestSchema,
  UpdateMemberRequestSchema,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { jsonb, withUserContext } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { seedDefaultGstRates } from '../gst-rates.js';
import { seedDefaultPayrollSchedules } from '../payroll-rates.js';
import { httpError } from '../http.js';
import { mfaEnforcementEnabled, mfaGate } from '../mfa-policy.js';
import { requireUser } from '../session.js';
import { errorResponses } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

interface MembershipRow {
  organisation_id: string;
  user_id: string;
  role: Membership['role'];
  work_scope: Membership['workScope'];
  can_issue_documents: boolean;
  can_cancel_documents: boolean;
  can_approve_amendments: boolean;
  can_manage_statutory_reporting: boolean;
  can_manage_payments: boolean;
  can_manage_payroll: boolean;
  /** From auth_users."twoFactorEnabled" (nullable there; coalesced in SQL).
   * Surfaced so owners can see enrolment BEFORE granting authority —
   * granting to an unenrolled account walls them off on their next
   * tenant request once enforcement is on (finding 36). */
  two_factor_enabled: boolean;
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
    canApproveAmendments: row.can_approve_amendments,
    canManageStatutoryReporting: row.can_manage_statutory_reporting,
    canManagePayments: row.can_manage_payments,
    canManagePayroll: row.can_manage_payroll,
    twoFactorEnabled: row.two_factor_enabled,
    status: row.status,
  };
}

export function registerIdentityRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  // No 200 schema is declared, so the reply stays plain JSON; the explicit
  // Reply generic stands in for the success type the provider cannot infer.
  app.get<{ Reply: Record<string, unknown> }>(
    '/api/me',
    { schema: { response: { ...errorResponses } } },
    async (request) => {
      const user = await requireUser(auth, request);
      const { memberships, gate } = await withUserContext(
        database,
        user.id,
        async (tx) => ({
          memberships: await tx<MembershipRow[]>`
            select m.organisation_id, m.user_id, m.role, m.work_scope,
                   m.can_issue_documents, m.can_cancel_documents,
                   m.can_approve_amendments, m.can_manage_statutory_reporting,
                   m.can_manage_payments, m.can_manage_payroll,
                   coalesce(u."twoFactorEnabled", false) as two_factor_enabled,
                   m.status
            from organisation_memberships m
            join auth_users u on u."id" = m.user_id
            order by m.organisation_id
          `,
          gate: await mfaGate(tx),
        }),
      );
      return {
        user,
        memberships: memberships.map(toMembership),
        // Finding 36: the client renders the enrolment wall and the
        // account-security section from these three facts. The gate is
        // computed even while enforcement is dark, so the flags tell the
        // truth the moment MFA_ENFORCE flips.
        twoFactorEnabled: gate.enabled,
        mfaRequired: gate.required,
        mfaEnforced: mfaEnforcementEnabled(),
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
      const body = request.body;
      const created = await withUserContext(database, user.id, async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          select app_private.create_organisation_with_owner(${body.name}, ${body.slug}) as id
        `;
        if (!row) throw new Error('organisation bootstrap returned no row');
        // Seed the notified GST rate history (migration 0048 seeded
        // organisations that already existed; this seeds the new one) in
        // the SAME transaction, so no organisation ever exists whose
        // invoices every rate check would refuse. Binding the tenant here
        // is legitimate: the owner membership the definer function just
        // created is visible to this transaction, so
        // current_organisation_id() proves it like any other request.
        await tx`select set_config('app.organisation_id', ${row.id}, true)`;
        const seeded = await seedDefaultGstRates(tx, row.id);
        await tx`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, details
          )
          values (
            ${row.id}, ${user.id}, 'gst_rate.defaults_seeded', 'gst_rates',
            ${jsonb(tx, { count: seeded, source: 'notified GST rate history (0048)' })}
          )
        `;
        // The payroll schedules, for the same reason and in the same
        // transaction (migration 0089 seeded the organisations that
        // already existed). Without them the first payroll run refuses
        // every employee by name, which is a true refusal and a useless
        // first experience.
        const payrollSeeded = await seedDefaultPayrollSchedules(tx, row.id);
        await tx`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, details
          )
          values (
            ${row.id}, ${user.id}, 'payroll_schedule.defaults_seeded',
            'payroll_statutory_rates',
            ${jsonb(tx, {
              count: payrollSeeded,
              source: 'payroll statutory schedules (0089)',
            })}
          )
        `;
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

  tenantRoute(
    {
      method: 'GET',
      url: '/api/organisations/current/members',
      schema: {
        response: { 200: MemberListResponseSchema, ...errorResponses },
      },
    },
    async ({ tenant }) => {
      const members = await tenant(
        (tx) =>
          tx<MembershipRow[]>`
            select m.organisation_id, m.user_id, m.role, m.work_scope,
                   m.can_issue_documents, m.can_cancel_documents,
                   m.can_approve_amendments, m.can_manage_statutory_reporting,
                   m.can_manage_payments, m.can_manage_payroll,
                   coalesce(u."twoFactorEnabled", false) as two_factor_enabled,
                   m.status
            from organisation_memberships m
            join auth_users u on u."id" = m.user_id
            where m.organisation_id = app_private.current_organisation_id()
            order by m.created_at, m.user_id
          `,
      );
      return { members: members.map(toMembership) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/organisations/current/members',
      schema: {
        body: AddMemberRequestSchema,
        response: { 201: MemberListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;

      const members = await tenant(async (tx) => {
        const [requester] = await tx<{ role: string }[]>`
            select role from organisation_memberships
            where user_id = ${user.id}
              and organisation_id = app_private.current_organisation_id()
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
              can_issue_documents, can_cancel_documents,
              can_approve_amendments, can_manage_statutory_reporting,
              can_manage_payments, can_manage_payroll, status
            )
            values (
              ${organisationId}, ${target.id}, ${body.role},
              ${body.workScope ?? 'all'},
              ${body.canIssueDocuments ?? false},
              ${body.canCancelDocuments ?? false},
              ${body.canApproveAmendments ?? false},
              ${body.canManageStatutoryReporting ?? false},
              ${body.canManagePayments ?? false},
              ${body.canManagePayroll ?? false},
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
            select m.organisation_id, m.user_id, m.role, m.work_scope,
                   m.can_issue_documents, m.can_cancel_documents,
                   m.can_approve_amendments, m.can_manage_statutory_reporting,
                   m.can_manage_payments, m.can_manage_payroll,
                   coalesce(u."twoFactorEnabled", false) as two_factor_enabled,
                   m.status
            from organisation_memberships m
            join auth_users u on u."id" = m.user_id
            where m.organisation_id = app_private.current_organisation_id()
            order by m.created_at, m.user_id
          `;
      });
      return reply.status(201).send({ members: members.map(toMembership) });
    },
  );

  tenantRoute(
    {
      method: 'PATCH',
      url: '/api/organisations/current/members/:userId',
      schema: {
        body: UpdateMemberRequestSchema,
        response: { 200: MemberListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      // No params schema is declared for :userId (an unknown id answers 404
      // from SQL, not 400), so the provider has nothing to type it from.
      const { userId: memberUserId } = request.params as { userId: string };
      const body = request.body;
      const members = await tenant(async (tx) => {
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
            select role from organisation_memberships
            where user_id = ${user.id}
              and organisation_id = app_private.current_organisation_id()
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
            can_approve_amendments: boolean;
            can_manage_statutory_reporting: boolean;
            can_manage_payments: boolean;
            can_manage_payroll: boolean;
          }[]
        >`
            select role, status, work_scope, can_issue_documents,
                   can_cancel_documents, can_approve_amendments,
                   can_manage_statutory_reporting, can_manage_payments,
                   can_manage_payroll
            from organisation_memberships
            where user_id = ${memberUserId}
              and organisation_id = app_private.current_organisation_id()
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
                and organisation_id = app_private.current_organisation_id()
            `;
          if (Number(owners?.count ?? '0') <= 1) {
            throw httpError(
              409,
              'LAST_OWNER',
              'The organisation must keep at least one active owner.',
            );
          }
        }

        // The organisation predicate is not redundant with row-level
        // security: every membership READ in this file already carries it,
        // and this write and the assignment replace below were the two
        // that did not. Tenancy is enforced twice everywhere else in the
        // codebase — the policy and the predicate — and a privilege write
        // keyed on user_id alone is the one place where relying on a
        // single layer is least defensible.
        await tx`
            update organisation_memberships set
              role = coalesce(${body.role ?? null}, role),
              work_scope = coalesce(${body.workScope ?? null}, work_scope),
              can_issue_documents =
                coalesce(${body.canIssueDocuments ?? null}, can_issue_documents),
              can_cancel_documents =
                coalesce(${body.canCancelDocuments ?? null}, can_cancel_documents),
              can_approve_amendments =
                coalesce(${body.canApproveAmendments ?? null}, can_approve_amendments),
              can_manage_statutory_reporting =
                coalesce(
                  ${body.canManageStatutoryReporting ?? null},
                  can_manage_statutory_reporting
                ),
              can_manage_payments =
                coalesce(${body.canManagePayments ?? null}, can_manage_payments),
              can_manage_payroll =
                coalesce(${body.canManagePayroll ?? null}, can_manage_payroll),
              status = coalesce(${body.status ?? null}, status),
              updated_at = now()
            where user_id = ${memberUserId}
              and organisation_id = app_private.current_organisation_id()
          `;
        // Milestone 6: the trail records what each changed field was
        // and became, not just which keys were touched. Every authority
        // the coalesce above can move is compared here — the amendment
        // approval authority was updatable but silently absent from the
        // trail, and the statutory reporting authority (migration 0061)
        // is the last one a compliance reviewer must be able to see
        // change hands.
        const changes = auditDiff(
          {
            role: current.role,
            workScope: current.work_scope,
            canIssueDocuments: current.can_issue_documents,
            canCancelDocuments: current.can_cancel_documents,
            canApproveAmendments: current.can_approve_amendments,
            canManageStatutoryReporting: current.can_manage_statutory_reporting,
            canManagePayments: current.can_manage_payments,
            canManagePayroll: current.can_manage_payroll,
            status: current.status,
          },
          {
            role: body.role ?? current.role,
            workScope: body.workScope ?? current.work_scope,
            canIssueDocuments: body.canIssueDocuments ?? current.can_issue_documents,
            canCancelDocuments: body.canCancelDocuments ?? current.can_cancel_documents,
            canApproveAmendments:
              body.canApproveAmendments ?? current.can_approve_amendments,
            canManageStatutoryReporting:
              body.canManageStatutoryReporting ??
              current.can_manage_statutory_reporting,
            canManagePayments: body.canManagePayments ?? current.can_manage_payments,
            canManagePayroll: body.canManagePayroll ?? current.can_manage_payroll,
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
            select m.organisation_id, m.user_id, m.role, m.work_scope,
                   m.can_issue_documents, m.can_cancel_documents,
                   m.can_approve_amendments, m.can_manage_statutory_reporting,
                   m.can_manage_payments, m.can_manage_payroll,
                   coalesce(u."twoFactorEnabled", false) as two_factor_enabled,
                   m.status
            from organisation_memberships m
            join auth_users u on u."id" = m.user_id
            where m.organisation_id = app_private.current_organisation_id()
            order by m.created_at, m.user_id
          `;
      });
      return { members: members.map(toMembership) };
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/organisations/current/members/:userId/assignments',
      schema: {
        response: { 200: MemberAssignmentsResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      // No params schema is declared for :userId (an unknown id answers 404
      // from SQL, not 400), so the provider has nothing to type it from.
      const { userId: memberUserId } = request.params as { userId: string };
      const workIds = await tenant(async (tx) => {
        const [requester] = await tx<{ role: string }[]>`
            select role from organisation_memberships
            where user_id = ${user.id}
              and organisation_id = app_private.current_organisation_id()
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
      });
      return { userId: memberUserId, workIds };
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/organisations/current/members/:userId/assignments',
      schema: {
        body: SetAssignmentsRequestSchema,
        response: { 200: MemberAssignmentsResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      // No params schema is declared for :userId (an unknown id answers 404
      // from SQL, not 400), so the provider has nothing to type it from.
      const { userId: memberUserId } = request.params as { userId: string };
      const body = request.body;
      const workIds = await tenant(async (tx) => {
        const [requester] = await tx<{ role: string }[]>`
            select role from organisation_memberships
            where user_id = ${user.id}
              and organisation_id = app_private.current_organisation_id()
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
              and organisation_id = app_private.current_organisation_id()
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
            delete from work_assignments
            where user_id = ${memberUserId}
              and organisation_id = app_private.current_organisation_id()
          `;
        if (body.workIds.length > 0) {
          // One statement for the whole set; the composite foreign key
          // still refuses a Work of another organisation, and its 23503
          // still becomes the same named 404.
          await tx`
              insert into work_assignments (
                organisation_id, work_id, user_id, created_by_user_id
              )
              select ${organisationId}, assigned.work_id, ${memberUserId},
                     ${user.id}
              from unnest(${body.workIds}::uuid[])
                as assigned(work_id)
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
      });
      return { userId: memberUserId, workIds };
    },
  );
}
