/**
 * R8 work completion and reopen (Milestone 6/7 retrofit, migration 0031).
 *
 * "A work can be marked `completed` only at 100% executed value — every
 * item fully installed and every supply item fully delivered. Short
 * closure = first amend quantities down (which itself requires approval),
 * then complete. Completion/reopen takes an audit note." (legacy §6 R8)
 *
 * Authority. Both transitions require the owner/office writer role and a
 * mandatory note — deliberately NOT the can_issue_documents authority.
 * That authority governs assigning a number to a legal document (R2's
 * gap-free series); completion assigns no number and issues nothing. It
 * is a contract-administration state change, and it sits with the same
 * authority as the other contract-administration acts on a Work: setting
 * the completion date, proposing an amendment, raising an extension
 * request. Site members record evidence; they do not close contracts.
 *
 * Concurrency. Completion takes the works row lock and then the
 * work_items locks (the works -> work_items order every other writer
 * uses), so it serialises against every writer that can move a
 * delivered/installed/effective quantity: delivery-challan issue,
 * installation recording, PAC recording and MB finalisation all take the
 * works lock, and amendment apply takes the work_items lock. Whichever
 * commits second sees the other. The 0031 guard functions are the
 * database backstop for the losing side.
 */

import {
  CompleteWorkRequestSchema,
  ReopenWorkRequestSchema,
  WorkCompletionReadinessSchema,
  WorkStatusResponseSchema,
  type UnfinishedWorkItem,
  type WorkCompletionBlocker,
  type WorkNotCleanDetails,
  type WorkCompletionReadiness,
  type WorkNotFullyExecutedDetails,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

interface WorkStatusRow {
  id: string;
  work_code: string;
  letter_number: string;
  letter_date: string;
  title: string;
  advertised_value: string;
  contract_value: string;
  pricing_shape: 'letter_percentage' | 'per_schedule';
  letter_percentage: string | null;
  letter_percentage_direction: 'below' | 'at_par' | 'above' | null;
  gst_basis: 'inclusive' | 'exclusive';
  gst_rate: string;
  pbg_required_amount: string | null;
  pbg_submission_days: number | null;
  pbg_extension_days: number | null;
  pbg_penal_interest_percent: string | null;
  status: 'active' | 'completed' | 'cancelled';
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_note: string | null;
  created_at: Date;
  allow_excess_delivery: boolean;
}

const WORK_COLUMNS = `
  id, work_code, letter_number, letter_date::text as letter_date, title,
  advertised_value, contract_value, pricing_shape, letter_percentage,
  letter_percentage_direction,
  gst_basis, gst_rate::text as gst_rate,
  pbg_required_amount::text as pbg_required_amount,
  pbg_submission_days, pbg_extension_days,
  pbg_penal_interest_percent::text as pbg_penal_interest_percent,
  status, completed_at, completed_by_user_id, completion_note,
  created_at, allow_excess_delivery
`;

function toWorkStatusResponse(row: WorkStatusRow) {
  return {
    work: {
      id: row.id,
      workCode: row.work_code,
      letterNumber: row.letter_number,
      letterDate: row.letter_date,
      title: row.title,
      advertisedValue: row.advertised_value,
      contractValue: row.contract_value,
      pricingShape: row.pricing_shape,
      letterPercentage: row.letter_percentage,
      letterPercentageDirection: row.letter_percentage_direction,
      gstBasis: row.gst_basis,
      gstRate: row.gst_rate,
      pbgRequiredAmount: row.pbg_required_amount,
      pbgSubmissionDays: row.pbg_submission_days,
      pbgExtensionDays: row.pbg_extension_days,
      pbgPenalInterestPercent: row.pbg_penal_interest_percent,
      status: row.status,
      completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
      completedByUserId: row.completed_by_user_id,
      completionNote: row.completion_note,
      createdAt: row.created_at.toISOString(),
      allowExcessDelivery: row.allow_excess_delivery,
    },
  };
}

/** Locks the Work row for the rest of the transaction. Both transitions
 * start here, so a complete and a reopen — and every source writer that
 * takes the same lock — serialise. */
async function lockWork(tx: TransactionSql, workId: string): Promise<WorkStatusRow> {
  const [row] = await tx<WorkStatusRow[]>`
    select ${tx.unsafe(WORK_COLUMNS)}
    from works where id = ${workId} and deleted_at is null
    for update
  `;
  if (!row) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return row;
}

async function readWork(tx: TransactionSql, workId: string): Promise<WorkStatusRow> {
  const [row] = await tx<WorkStatusRow[]>`
    select ${tx.unsafe(WORK_COLUMNS)}
    from works where id = ${workId} and deleted_at is null
  `;
  if (!row) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return row;
}

interface UnfinishedRow {
  id: string;
  item_number: string;
  payment_category: UnfinishedWorkItem['category'];
  requirement: UnfinishedWorkItem['requirement'];
  direction: UnfinishedWorkItem['direction'];
  required_quantity: string;
  delivered_quantity: string;
  installed_quantity: string;
  certified_quantity: string;
}

/**
 * The R8 predicate, in exact SQL over EFFECTIVE quantities. "Fully" is
 * numeric EQUALITY against coalesce(effective_quantity, awarded_quantity)
 * — no tolerance, no >=; an item that measures ABOVE its baseline is as
 * unfinished as a short one, and short closure means amending the
 * baseline down first. Over-delivery reaches this only with the Work's
 * excess toggle; over-INSTALLATION reaches it whenever site ran ahead of
 * the variation order (migration 0077), and this predicate is exactly why
 * a Work still cannot be closed on the strength of unsanctioned work. Soft-deleted items are excluded (a
 * removed item owes nothing). An item amended to quantity 0 — the
 * omission case — is satisfied by delivering and installing nothing.
 *
 * ONE DIMENSION IS MEASURED ON EVERY ITEM WHATEVER ITS REQUIREMENT: the
 * installed quantity, when it stands ABOVE the baseline. Migration 0077
 * lets site install past the sanctioned quantity on any item, and a
 * requirement says which dimension an item must finish on — it does not
 * license the others to run over. Without this arm a SUPPLY item that
 * was over-installed would close a Work while its variation order was
 * still outstanding, because its requirement only looks at delivery.
 *
 * The requirement per payment category (spec §8 / the settled matrix):
 *   SUPPLY, SPARE_SUPPLY        -> fully delivered
 *   PURE_INSTALLATION           -> fully installed
 *   SUPPLY_AND_INSTALLATION     -> fully delivered AND fully installed
 *   AMC                         -> fully certified
 *   uncategorised               -> effective description mentioning
 *                                  'installation' (case-insensitive)
 *                                  -> fully installed, else fully
 *                                  delivered.
 *
 * AMC IS WHY THIS PREDICATE USED TO BE UNSATISFIABLE (migration 0068).
 * A railway LOA's annual-maintenance schedule is quoted in `Year`: the
 * flagship corpus letter PL270-CRB carries two of them, together about
 * 16% of its net bid value. Nothing moves against such an item and
 * nothing is installed against it — a year of maintenance is served, and
 * the railway certifies that it was. With four categories the item
 * resolved to "fully delivered", so the only route to 100% was a
 * Delivery Challan claiming five years of maintenance had been
 * despatched. AMC resolves instead to the CERTIFIED total, summed over
 * the item's non-cancelled acceptance certificates, and migration 0068
 * makes the delivery and installation dimensions structurally
 * unreachable for it so the requirement cannot be satisfied the old way
 * by accident.
 *
 * Each row also carries the DIRECTION of its own remedy, because the two
 * are opposite. An item is 'excess' when a measured dimension the
 * requirement covers stands ABOVE the baseline — the delivery dimension,
 * the installation dimension where the requirement includes it, and the
 * certified dimension for AMC. While any covered dimension is over, the
 * R7 floor refuses every reduction, so the only legal move is to amend
 * the sanctioned quantity UP to match; everything else is 'short' and
 * amends down. (Certification cannot in fact exceed the sanctioned
 * quantity — `routes/pac.ts` caps an AMC item there — so the 'excess'
 * arm is unreachable for a service item through the API. It is written
 * anyway: the direction is derived from the measurement, not asserted
 * from the route that produced it.)
 */
async function unfinishedItems(
  tx: TransactionSql,
  workId: string,
): Promise<readonly UnfinishedWorkItem[]> {
  // Lock every item first, in id order: amendment apply takes the same
  // row lock before lowering a ceiling, so no effective quantity can move
  // under the predicate. Lock order works -> work_items matches every
  // other writer taking both.
  await tx`
    select id from work_items
    where work_id = ${workId} and deleted_at is null
    order by id
    for update
  `;
  const rows = await tx<UnfinishedRow[]>`
    select measured.id, measured.item_number, measured.payment_category,
           measured.requirement,
           case
             when (
               measured.requirement in ('delivery', 'delivery_and_installation')
               and measured.delivered_quantity > measured.required_quantity
             ) or (
               -- NOT gated on the requirement, unlike its neighbours.
               -- Since migration 0077 an item can hold more installed
               -- than the contract sanctions whatever its payment
               -- category, and a SUPPLY item that site over-installed is
               -- over-executed even though its requirement measures
               -- delivery. Gating this arm the way the others are gated
               -- would let such a Work close with an unsanctioned
               -- variation outstanding.
               measured.installed_quantity > measured.required_quantity
             ) or (
               measured.requirement = 'service'
               and measured.certified_quantity > measured.required_quantity
             ) then 'excess'
             else 'short'
           end as direction,
           measured.required_quantity::text as required_quantity,
           measured.delivered_quantity::text as delivered_quantity,
           measured.installed_quantity::text as installed_quantity,
           measured.certified_quantity::text as certified_quantity
    from (
      select wi.id, wi.item_number, wi.payment_category,
             coalesce(wi.effective_quantity, wi.awarded_quantity)
               as required_quantity,
             case
               when wi.payment_category in ('SUPPLY', 'SPARE_SUPPLY')
                 then 'delivery'
               when wi.payment_category = 'PURE_INSTALLATION'
                 then 'installation'
               when wi.payment_category = 'SUPPLY_AND_INSTALLATION'
                 then 'delivery_and_installation'
               when wi.payment_category = 'AMC'
                 then 'service'
               when coalesce(wi.effective_description, wi.description)
                    ilike '%installation%'
                 then 'installation'
               else 'delivery'
             end as requirement,
             coalesce((
               select sum(dci.quantity)
               from delivery_challan_items dci
               join delivery_challans dc on dc.id = dci.delivery_challan_id
               where dci.work_item_id = wi.id and dc.status = 'issued'
             ), 0)::numeric(18,3) as delivered_quantity,
             coalesce((
               select sum(i.quantity)
               from installations i
               where i.work_item_id = wi.id and i.status = 'recorded'
             ), 0)::numeric(18,3) as installed_quantity,
             -- Restricted to AMC items, which are the only ones the
             -- 'service' requirement measures. Two reasons, and both
             -- matter: the contract documents this field as 0 on every
             -- other requirement, so computing it everywhere would make
             -- that sentence false; and the completion path would
             -- otherwise pay for one certificate-table descent per item
             -- on every Work, for a number nothing reads.
             case when wi.payment_category = 'AMC' then coalesce((
               select sum(pci.certified_quantity)
               from pac_certificate_items pci
               join pac_certificates pc on pc.id = pci.pac_certificate_id
               where pci.work_item_id = wi.id and pc.status = 'recorded'
             ), 0) else 0 end::numeric(18,3) as certified_quantity
      from work_items wi
      where wi.work_id = ${workId} and wi.deleted_at is null
    ) measured
    where (
      measured.requirement in ('delivery', 'delivery_and_installation')
      and measured.delivered_quantity <> measured.required_quantity
    ) or (
      measured.requirement in ('installation', 'delivery_and_installation')
      and measured.installed_quantity <> measured.required_quantity
    ) or (
      measured.requirement = 'service'
      and measured.certified_quantity <> measured.required_quantity
    ) or (
      -- The over-installed arm, on EVERY requirement (migration 0077).
      -- A requirement decides which dimension an item must FINISH on; it
      -- does not license the other dimensions to run over the sanction.
      -- Strictly greater-than, not <>: a supply item with nothing
      -- installed is not unfinished for that reason, and one that is
      -- part-installed on the way to full delivery is not either.
      measured.installed_quantity > measured.required_quantity
    )
    order by measured.item_number
  `;
  return rows.map((row) => ({
    workItemId: row.id,
    itemNumber: row.item_number,
    category: row.payment_category,
    requirement: row.requirement,
    direction: row.direction,
    requiredQuantity: row.required_quantity,
    deliveredQuantity: row.delivered_quantity,
    installedQuantity: row.installed_quantity,
    certifiedQuantity: row.certified_quantity,
  }));
}

/** The 409's prose, split on the direction of the remedy. Telling the
 * operator to "amend those quantities down" for an item that measures
 * ABOVE its sanctioned quantity sends them at an instruction the R7
 * floor refuses; the sanctioned quantity has to go UP to meet the
 * measurement instead.
 *
 * The excess arm names no dimension, because since migration 0077 it has
 * two. An over-DELIVERED item needs the Work's excess-delivery toggle;
 * an over-INSTALLED one needs nothing at all — site installs what the
 * railway asked for and the item waits for the variation order. Both
 * resolve the same way, by amending the sanctioned quantity up.
 *
 * Short AMC items are split out again, because their remedy is not the
 * same sentence. An unfinished supply item is waiting for material that
 * either moved or did not; an unfinished AMC item is waiting for a
 * period of maintenance to be served and certified, and telling its
 * operator to amend the quantity down would read as "close the
 * maintenance contract early" when the ordinary answer is "record this
 * year's certificate". Both routes stay open — an AMC schedule really
 * can be short-closed by amendment — but the certificate is named first
 * because it is the one that finishes the contract as written. */
function notFullyExecutedMessage(unfinished: readonly UnfinishedWorkItem[]): string {
  const numbers = (
    predicate: (item: UnfinishedWorkItem) => boolean,
  ): readonly string[] => unfinished.filter(predicate).map((item) => item.itemNumber);
  const short = numbers(
    (item) => item.direction === 'short' && item.requirement !== 'service',
  );
  const service = numbers(
    (item) => item.direction === 'short' && item.requirement === 'service',
  );
  const excess = numbers((item) => item.direction === 'excess');
  const parts = [
    `A Work completes only at 100% executed value; ${String(unfinished.length)} item(s) are not fully executed.`,
  ];
  if (short.length > 0) {
    parts.push(
      `${String(short.length)} item(s) are short: ${short.join(', ')}. For a short closure, amend those quantities down through the approval path first, then complete.`,
    );
  }
  if (service.length > 0) {
    parts.push(
      `${String(service.length)} maintenance item(s) are not fully certified: ${service.join(', ')}. Record the acceptance certificate for each period served — or, to close the maintenance short, amend those quantities down through the approval path first.`,
    );
  }
  if (excess.length > 0) {
    parts.push(
      `${String(excess.length)} item(s) measure above the sanctioned quantity: ${excess.join(', ')}. For those, amend the sanctioned quantity up to match the measurement through the approval path, then complete.`,
    );
  }
  return parts.join(' ');
}

interface BlockerRow {
  kind: WorkCompletionBlocker['kind'];
  record_id: string;
  label: string;
}

/**
 * The adopted CLEAN-STATE rule. Completing a Work while something live
 * still holds a claim on it would strand that record behind the
 * completed-work refusals: a draft challan could never be issued, a draft
 * Measurement Book could never be finalised, and a pending approval could
 * never be applied. The draft-MB and pending-approval cases matter most —
 * both hold claims on quantities the R8 predicate has just been measured
 * against. So completion refuses while any of them exists, and the 409
 * names every one.
 */
async function completionBlockers(
  tx: TransactionSql,
  workId: string,
): Promise<readonly WorkCompletionBlocker[]> {
  const rows = await tx<BlockerRow[]>`
    select 'draft_delivery_challan' as kind, dc.id as record_id,
           'Draft delivery challan dated ' || dc.challan_date::text as label
    from delivery_challans dc
    where dc.work_id = ${workId} and dc.status = 'draft'
    union all
    select 'draft_issue_challan', ic.id,
           'Draft issue challan dated ' || ic.challan_date::text
    from issue_challans ic
    where ic.work_id = ${workId} and ic.status = 'draft'
    union all
    select 'draft_extension_request', er.id,
           'Draft extension request proposing '
             || er.proposed_completion_date::text
    from extension_requests er
    where er.work_id = ${workId} and er.status = 'draft'
    union all
    select 'draft_measurement_book', mb.id,
           'Draft Measurement Book dated ' || mb.mb_date::text
    from measurement_books mb
    where mb.work_id = ${workId} and mb.status = 'draft'
    union all
    select 'pending_approval_request', ar.id,
           'Pending change proposal (' || ar.entity_type || ')'
    from approval_requests ar
    where ar.work_id = ${workId} and ar.status = 'pending'
    order by 1, 3
  `;
  return rows.map((row) => ({
    kind: row.kind,
    recordId: row.record_id,
    label: row.label,
  }));
}

export function registerWorkCompletionRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  /** The same two refusals POST /complete raises, asked as a question.
   * The Work page calls this so it can show the operator what is left
   * instead of offering a completion form that cannot succeed — the
   * shortfall is the answer to "why not", so it is worth more on the page
   * than behind a rejected submission.
   *
   * Read-only, and deliberately reuses the writers' own functions: a
   * second implementation of "is this Work finished" would drift, and the
   * one that drifted would be the one the operator reads. */
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/completion-readiness',
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkCompletionReadinessSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const work = await readWork(tx, workId);
        // The row locks unfinishedItems takes are the writers' concern;
        // this answer is a snapshot either way, and the POST re-proves
        // everything under its own locks before it transitions.
        const [blockers, unfinished] = await Promise.all([
          completionBlockers(tx, workId),
          unfinishedItems(tx, workId),
        ]);
        const readiness: WorkCompletionReadiness = {
          ready:
            work.status === 'active' &&
            blockers.length === 0 &&
            unfinished.length === 0,
          unfinished: [...unfinished],
          blockers: [...blockers],
        };
        return readiness;
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/complete',
      schema: {
        params: IdParamsSchema,
        body: CompleteWorkRequestSchema,
        response: { 200: WorkStatusResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);
        if (work.status === 'completed') {
          throw httpError(
            409,
            'WORK_ALREADY_COMPLETED',
            'This Work is already completed.',
          );
        }
        if (work.status !== 'active') {
          throw httpError(409, 'WORK_NOT_ACTIVE', `This Work is ${work.status}.`);
        }

        const blockers = await completionBlockers(tx, workId);
        if (blockers.length > 0) {
          const details: WorkNotCleanDetails = { blockers: [...blockers] };
          throw httpError(
            409,
            'WORK_NOT_CLEAN',
            `Finish or discard these before completing the Work: ${blockers
              .map((blocker) => blocker.label)
              .join('; ')}.`,
            details,
          );
        }

        const unfinished = await unfinishedItems(tx, workId);
        if (unfinished.length > 0) {
          const details: WorkNotFullyExecutedDetails = {
            unfinishedItems: [...unfinished],
          };
          throw httpError(
            409,
            'WORK_NOT_FULLY_EXECUTED',
            notFullyExecutedMessage(unfinished),
            details,
          );
        }

        await tx`
          update works
          set status = 'completed',
              completed_at = now(),
              completed_by_user_id = ${user.id},
              completion_note = ${body.note},
              reopened_at = null,
              reopened_by_user_id = null,
              reopen_note = null
          where id = ${workId}
        `;
        await audit(tx, organisationId, user.id, 'work.completed', 'works', workId, {
          before: { status: work.status },
          after: { status: 'completed' },
          note: body.note,
        });
        return toWorkStatusResponse(await readWork(tx, workId));
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/reopen',
      schema: {
        params: IdParamsSchema,
        body: ReopenWorkRequestSchema,
        response: { 200: WorkStatusResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);
        if (work.status !== 'completed') {
          throw httpError(
            409,
            'WORK_NOT_COMPLETED',
            `Only a completed Work can be reopened (current status: ${work.status}).`,
          );
        }
        // Reopening carries no predicate by design: a Work is reopened
        // precisely because reality contradicted the closure, and the
        // note records why.
        await tx`
          update works
          set status = 'active',
              completed_at = null,
              completed_by_user_id = null,
              completion_note = null,
              reopened_at = now(),
              reopened_by_user_id = ${user.id},
              reopen_note = ${body.note}
          where id = ${workId}
        `;
        await audit(tx, organisationId, user.id, 'work.reopened', 'works', workId, {
          before: { status: 'completed', completionNote: work.completion_note },
          after: { status: 'active' },
          note: body.note,
        });
        return toWorkStatusResponse(await readWork(tx, workId));
      });
    },
  );
}
