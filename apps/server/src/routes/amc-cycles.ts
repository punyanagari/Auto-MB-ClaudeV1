import {
  AmcCycleProposalResponseSchema,
  SetScheduleAmcCycleRequestSchema,
  type AmcCycleItemProposal,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { CERTIFICATION_BASIS_SQL } from './pac.js';

/**
 * AMC billing cycles (owner ruling of 2026-08-19, live-testing ledger
 * item 6; migration 0107).
 *
 * TWO ROUTES AND NEITHER MOVES MONEY. One READS a proposal — what the
 * next acceptance certificate should certify for each AMC item of each
 * schedule that states a cadence — and one WRITES the cadence itself,
 * which is two columns on `work_schedules` and nothing else.
 *
 * THE PROPOSAL IS A READ, deliberately. Everything a running-total split
 * needs is already assembled inside `POST /api/works/:id/pac-certificates`
 * — the AMC basis, what is already covered, what is available — and a
 * second WRITE path would be a second set of guards on the same cap. So
 * this endpoint reuses `CERTIFICATION_BASIS_SQL`, the very fragment the
 * cap check interpolates, and answers a number the operator carries to
 * the ordinary certificate route. If they certify something else, the
 * cadence has no vote: the railway accepted what it accepted.
 *
 * THE SPLIT, verbatim from the ruling:
 *
 *     q(n) = round3(Q*n/M) - round3(Q*(n-1)/M)
 *
 * A RUNNING TOTAL, not Q/M repeated, and the difference is the whole
 * reason it is written this way: the periods sum to exactly Q, so the
 * last certificate closes 0068's cap and R8's completion predicate
 * without a reconciliation step and without a rounding remainder nobody
 * can bill. Where Q does not divide evenly the split wobbles in the third
 * decimal between periods; the owner accepted the wobble and the response
 * says `divides: false` so a screen can say so rather than present an
 * uneven split as an even one.
 *
 * HOW MANY PERIODS ARE ALREADY DONE is read back out of the certified
 * total the same way — `round(certified * M / Q)` — which is exact
 * because the owner's Q4 ruling settles that a Measurement Book always
 * certifies the FULL period quantity. A part-period certified by hand
 * rounds to its nearest whole period, which is the honest reading of a
 * quantity this cadence did not produce.
 *
 * Every arithmetic step runs in PostgreSQL numeric. No quantity here ever
 * passes through a JavaScript number.
 */

const ScheduleParamsSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    scheduleId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

interface ProposalRow {
  schedule_id: string;
  schedule_code: string;
  title: string;
  billing_periods: number;
  cycle_noun: string;
  work_item_id: string;
  item_number: string;
  description: string;
  unit_code: string;
  total_quantity: string;
  certified_quantity: string;
  periods_certified: number;
  next_period: number | null;
  proposed_quantity: string | null;
  divides: boolean;
}

/**
 * `$1` is the Work. `CERTIFICATION_BASIS_SQL` is interpolated against the
 * `work_items` alias it expects (`wi`) and carries no values of its own;
 * everything else is parameterised.
 */
const AMC_CYCLE_PROPOSAL_SQL = `
  with base as (
    select ws.id as schedule_id, ws.schedule_code, ws.title, ws.position,
           ws.amc_billing_periods as m, ws.amc_cycle_noun,
           wi.id as work_item_id, wi.item_number, wi.description, wi.unit_code,
           (${CERTIFICATION_BASIS_SQL}) as total_quantity,
           coalesce((
             select sum(pci.certified_quantity)
             from pac_certificate_items pci
             join pac_certificates pc on pc.id = pci.pac_certificate_id
             where pci.work_item_id = wi.id and pc.status = 'recorded'
           ), 0)::numeric(18,3) as certified_quantity
    from work_schedules ws
    join work_items wi on wi.schedule_id = ws.id and wi.work_id = ws.work_id
    where ws.work_id = $1
      and ws.amc_billing_periods is not null
      and ws.amc_cycle_noun is not null
      and wi.deleted_at is null
      and wi.payment_category = 'AMC'
  ),
  counted as (
    select b.*,
           case
             when b.total_quantity > 0 then least(
               b.m,
               greatest(0, round(b.certified_quantity * b.m / b.total_quantity)::int)
             )
             else 0
           end as periods_certified
    from base b
  )
  select c.schedule_id, c.schedule_code, c.title,
         c.m as billing_periods, c.amc_cycle_noun as cycle_noun,
         c.work_item_id, c.item_number, c.description, c.unit_code,
         c.total_quantity::text as total_quantity,
         c.certified_quantity::text as certified_quantity,
         c.periods_certified,
         case when c.periods_certified >= c.m then null
              else c.periods_certified + 1 end as next_period,
         case when c.periods_certified >= c.m then null
              else (
                round(c.total_quantity * (c.periods_certified + 1) / c.m, 3)
                - round(c.total_quantity * c.periods_certified / c.m, 3)
              )::text
         end as proposed_quantity,
         (round(c.total_quantity / c.m, 3) * c.m = c.total_quantity) as divides
  from counted c
  order by c.position, c.item_number, c.work_item_id
`;

export function registerAmcCycleRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/amc-cycle-proposal',
      schema: {
        params: IdParamsSchema,
        response: { 200: AmcCycleProposalResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const rows = (await tx.unsafe(AMC_CYCLE_PROPOSAL_SQL, [
          workId,
        ])) as unknown as ProposalRow[];

        // Grouped in one pass over an already-ordered result; the SQL
        // orders by schedule position, so a schedule's rows are adjacent
        // and a Map preserves the order it first met them in.
        const bySchedule = new Map<
          string,
          {
            scheduleId: string;
            scheduleCode: string;
            title: string;
            billingPeriods: number;
            cycleNoun: string;
            items: AmcCycleItemProposal[];
          }
        >();
        for (const row of rows) {
          let schedule = bySchedule.get(row.schedule_id);
          if (schedule === undefined) {
            schedule = {
              scheduleId: row.schedule_id,
              scheduleCode: row.schedule_code,
              title: row.title,
              billingPeriods: row.billing_periods,
              cycleNoun: row.cycle_noun,
              items: [],
            };
            bySchedule.set(row.schedule_id, schedule);
          }
          schedule.items.push({
            workItemId: row.work_item_id,
            itemNumber: row.item_number,
            description: row.description,
            unitCode: row.unit_code,
            totalQuantity: row.total_quantity,
            certifiedQuantity: row.certified_quantity,
            periodsCertified: row.periods_certified,
            nextPeriod: row.next_period,
            proposedQuantity: row.proposed_quantity,
            divides: row.divides,
          });
        }
        return { schedules: [...bySchedule.values()] };
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/works/:id/schedules/:scheduleId/amc-cycle',
      schema: {
        params: ScheduleParamsSchema,
        body: SetScheduleAmcCycleRequestSchema,
        // 204, not the Work: the cadence is two columns, and the one
        // screen that sets it already holds the Work detail it would
        // otherwise be handed a second copy of.
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId, scheduleId } = request.params;
      const body = request.body;

      // Both together or neither: a period count with no word for a
      // period renders no sentence and a word with no count proposes no
      // quantity. Migration 0107's CHECK holds the same rule against
      // every writer; this is the sentence a person reads.
      if ((body.billingPeriods === null) !== (body.cycleNoun === null)) {
        throw httpError(
          400,
          'AMC_CYCLE_INCOMPLETE',
          'A billing cycle states both how many periods the maintenance is billed in and what the schedule calls one of them; clear both to remove it.',
        );
      }
      const noun = body.cycleNoun === null ? null : body.cycleNoun.trim();
      if (noun !== null && !/^[A-Za-z][A-Za-z -]*$/.test(noun)) {
        throw httpError(
          400,
          'AMC_CYCLE_INCOMPLETE',
          'The cycle name is the word alone — "quarter", not "quarterly bill" or "1 quarter".',
        );
      }

      await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [schedule] = await tx<
          {
            id: string;
            schedule_code: string;
            amc_billing_periods: number | null;
            amc_cycle_noun: string | null;
          }[]
        >`
          select id, schedule_code, amc_billing_periods, amc_cycle_noun
          from work_schedules
          where id = ${scheduleId} and work_id = ${workId}
          for update
        `;
        if (!schedule) {
          throw httpError(404, 'SCHEDULE_NOT_FOUND', 'No such schedule on this Work.');
        }
        await tx`
          update work_schedules
          set amc_billing_periods = ${body.billingPeriods},
              amc_cycle_noun = ${noun}
          where id = ${scheduleId}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'work_schedule.amc_cycle_set',
          'work_schedules',
          scheduleId,
          {
            workId,
            scheduleCode: schedule.schedule_code,
            before: {
              billingPeriods: schedule.amc_billing_periods,
              cycleNoun: schedule.amc_cycle_noun,
            },
            after: { billingPeriods: body.billingPeriods, cycleNoun: noun },
          },
        );
      });
      return reply.status(204).send(null);
    },
  );
}
