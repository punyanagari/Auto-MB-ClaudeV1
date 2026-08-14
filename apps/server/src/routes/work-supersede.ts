/**
 * Proposing that a confirmed Work be superseded (migration 0071).
 *
 * The correction deadlock, stated once: a Work confirmed from a letter
 * that was read wrongly cannot be corrected — the awarded baseline is
 * immutable and an amendment needs a railway variation order the railway
 * never issued, because nothing about the contract changed — and it cannot
 * be withdrawn, because migration 0055 makes its letter undiscardable.
 * Migration 0063's own header prescribes "discard the LOA document and
 * confirm it again" as the remedy for exactly this, and until now that
 * remedy stopped being available the moment the Work existed.
 *
 * This module carries only the two READ/PROPOSE routes. The decision runs
 * through the shared approval engine (`POST /api/approvals/:id/approve`),
 * and the destructive half lives in `src/work-supersede.ts`, applied in
 * the deciding transaction like every other approved change.
 *
 * Authority. Proposing takes the writer role — whoever may confirm a Work
 * may ask for one to be withdrawn. Deciding takes the approval authority
 * plus the explicit CANCEL authority (`applyApproval`), because taking an
 * authoritative record out of service is a separate grant from judging
 * whether a change is warranted. There is deliberately NO direct-apply for
 * an approver's own proposal — the amendment routes have one, but this
 * action withdraws a contract record, and the two steps are worth keeping
 * apart even when one person takes both.
 */

import {
  ProposeWorkSupersedeRequestSchema,
  ApprovalRequestSchema,
  SupersedeEligibilityResponseSchema,
  WorkSupersessionResponseSchema,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { assertWorkOperable } from '../work-status.js';
import {
  assertSupersedable,
  readSupersedeEligibility,
  readWorkSupersession,
  type WorkSupersedeProposal,
} from '../work-supersede.js';
import { readApproval } from './amendments.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

export function registerWorkSupersedeRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  // --- What stands in the way, before anyone proposes anything ------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/supersede-eligibility',
      schema: {
        params: IdParamsSchema,
        response: { 200: SupersedeEligibilityResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const eligibility = await readSupersedeEligibility(tx, workId);
        return {
          workId: eligibility.workId,
          eligible:
            eligibility.blockers.length === 0 && eligibility.loaDocumentId !== null,
          blockers: [...eligibility.blockers],
          loaDocumentId: eligibility.loaDocumentId,
          pendingRequestId: eligibility.pendingRequestId,
        };
      });
    },
  );

  // --- Where this Work came from ------------------------------------------
  //
  // The withdrawn Work is unreachable through the Works routes — every one
  // filters `deleted_at is null` — so without this its identity, the
  // reason it was withdrawn and the date would be write-only: recorded in
  // the database and readable nowhere, which is not what
  // `docs/PRODUCT.md` §5.6 promises. The successor's own page answers
  // "what did this replace, and why".
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/supersession',
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkSupersessionResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // `assertWorkAccess` answers "may this member reach this Work",
        // not "does it exist here" — so the Work itself is read, under
        // RLS, before an absent provenance can be reported as a null. A
        // guessed id from another organisation must 404 like every other
        // Work-addressed read, not answer "this Work replaced nothing".
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        return { supersession: await readWorkSupersession(tx, workId) };
      });
    },
  );

  // --- Ask for the Work to be withdrawn -----------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/supersede-requests',
      schema: {
        params: IdParamsSchema,
        body: ProposeWorkSupersedeRequestSchema,
        response: { 201: ApprovalRequestSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const { reason } = request.body;
      const approval = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock, taken here as it is at apply time, so the
        // census and the refusal see one state. It also serialises against
        // every writer that could give this Work its first document.
        const eligibility = await readSupersedeEligibility(tx, workId, true);
        // A completed Work is not superseded: completion means 100%
        // executed value, which is unreachable without documents, so the
        // census refuses it anyway — but the operator deserves the
        // completed-Work instruction rather than a list of challans.
        assertWorkOperable(eligibility.status, 'superseding it');
        const loaDocumentId = assertSupersedable(eligibility);
        if (eligibility.pendingRequestId !== null) {
          throw httpError(
            409,
            'PENDING_EXISTS',
            'This Work already has a pending supersede request; decide or withdraw it first.',
            { existingRecordId: eligibility.pendingRequestId },
          );
        }

        const proposed: WorkSupersedeProposal = {
          kind: 'work_supersede',
          workId,
          workCode: eligibility.workCode,
          loaDocumentId,
          reason,
        };
        // The diff the queue renders: what the organisation holds now, and
        // what it would hold after. The engine's diff shape is
        // [{ field, before, after }] and every consumer reads it that way.
        const diff = [
          {
            field: 'work',
            before: eligibility.workCode,
            after: 'withdrawn; letter returned to review',
          },
        ];
        const [created] = await tx<
          { id: string; entity_id: string | null; work_id: string }[]
        >`
          insert into approval_requests (
            organisation_id, entity_type, entity_id, work_id, proposed, diff,
            reason, requested_by_user_id
          )
          values (
            ${organisationId}, 'work_supersede', ${workId}, ${workId},
            ${jsonb(tx, proposed)}, ${jsonb(tx, diff)}, ${reason}, ${user.id}
          )
          returning id, entity_id, work_id
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'PENDING_EXISTS',
              'This Work already has a pending supersede request; decide or withdraw it first.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('approval insert returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'work.supersede_proposed',
          'approval_requests',
          created.id,
          {
            workId,
            workCode: eligibility.workCode,
            loaDocumentId,
            reason,
          },
        );
        return readApproval(tx, created.id);
      });
      return reply.status(201).send(approval);
    },
  );
}
