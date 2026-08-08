import {
  ApiErrorSchema,
  DashboardResponseSchema,
  type DashboardAlert,
  type DashboardResponse,
} from '@auto-mb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { hasFullWorkScope } from '../authz.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
} as const;

/** Instruments within this window of their expiry date raise a warning;
 * past it they escalate to danger. Bank guarantees need lead time to
 * extend, so the window is generous. */
const EXPIRY_WARNING_DAYS = 60;

interface ProgressRow extends Record<string, unknown> {
  work_id: string;
  work_code: string;
  title: string;
  status: 'active' | 'completed' | 'cancelled';
  contract_value: string;
  delivered_value: string;
  billed_value: string;
  issued_challans: string;
}

interface InstrumentRow extends Record<string, unknown> {
  work_id: string;
  work_code: string;
  kind: string;
  reference: string;
  expires_on: string;
  due_in_days: string;
}

/**
 * The signed-in landing view: everything across the organisation that
 * needs attention (expiring instruments, review queues, open drafts,
 * unpaid bills) plus per-work delivery progress. All sums are exact SQL
 * numeric arithmetic; RLS scopes every query to the bound tenant.
 */
export function registerDashboardRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
): void {
  app.get(
    '/api/dashboard',
    {
      schema: {
        response: { 200: DashboardResponseSchema, ...errorResponses },
      },
    },
    async (request): Promise<DashboardResponse> => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        // 'assigned'-scoped members see a dashboard of their Works only.
        const full = await hasFullWorkScope(tx, user.id);
        const works = await tx<ProgressRow[]>`
          select
            w.id as work_id,
            w.work_code,
            w.title,
            w.status,
            w.contract_value::text as contract_value,
            coalesce(delivered.total, 0)::numeric(18,2)::text as delivered_value,
            coalesce(billed.total, 0)::numeric(18,2)::text as billed_value,
            coalesce(delivered.challans, 0)::text as issued_challans
          from works w
          left join lateral (
            select
              sum(i.line_amount) as total,
              count(distinct c.id) as challans
            from delivery_challans c
            join delivery_challan_items i on i.delivery_challan_id = c.id
            where c.work_id = w.id and c.status = 'issued'
          ) delivered on true
          left join lateral (
            select sum(b.total_amount) as total
            from bills b
            where b.work_id = w.id
          ) billed on true
          where w.deleted_at is null
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = w.id and wa.user_id = ${user.id}
            ))
          order by w.created_at desc
        `;

        const [counts] = await tx<{ open_drafts: string; loa_review: string }[]>`
          select
            (select count(*) from delivery_challans where status = 'draft')::text
              as open_drafts,
            (select count(*) from loa_documents where extraction_status = 'review')::text
              as loa_review
        `;

        const instruments = await tx<InstrumentRow[]>`
          select
            wi.work_id,
            w.work_code,
            wi.kind,
            wi.reference,
            wi.expires_on::text as expires_on,
            (wi.expires_on - current_date)::text as due_in_days
          from work_instruments wi
          join works w on w.id = wi.work_id
          where wi.status = 'active'
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = w.id and wa.user_id = ${user.id}
            ))
            and wi.expires_on is not null
            and wi.expires_on <= current_date + ${EXPIRY_WARNING_DAYS}::int
          order by wi.expires_on asc
        `;

        const unpaidBills = await tx<
          { work_id: string; work_code: string; bill_number: number; status: string }[]
        >`
          select b.work_id, w.work_code, b.bill_number, b.status
          from bills b
          join works w on w.id = b.work_id
          where b.status in ('prepared', 'submitted')
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = w.id and wa.user_id = ${user.id}
            ))
          order by b.created_at asc
        `;

        const alerts: DashboardAlert[] = [];
        for (const instrument of instruments) {
          const dueInDays = Number(instrument.due_in_days);
          const label = instrument.kind.toUpperCase();
          const overdue = dueInDays < 0;
          alerts.push({
            kind: overdue ? 'instrument_expired' : 'instrument_expiring',
            severity: overdue || dueInDays <= 15 ? 'danger' : 'warning',
            message: overdue
              ? `${label} ${instrument.reference} for ${instrument.work_code} expired on ${instrument.expires_on}.`
              : `${label} ${instrument.reference} for ${instrument.work_code} expires on ${instrument.expires_on}.`,
            workId: instrument.work_id,
            workCode: instrument.work_code,
            dueInDays,
          });
        }
        const loaAwaitingReview = Number(counts?.loa_review ?? '0');
        if (loaAwaitingReview > 0) {
          alerts.push({
            kind: 'loa_review_pending',
            severity: 'notice',
            message:
              loaAwaitingReview === 1
                ? '1 LOA letter is waiting for review and confirmation.'
                : `${String(loaAwaitingReview)} LOA letters are waiting for review and confirmation.`,
            workId: null,
            workCode: null,
            dueInDays: null,
          });
        }
        const openDrafts = Number(counts?.open_drafts ?? '0');
        if (openDrafts > 0) {
          alerts.push({
            kind: 'challan_draft_open',
            severity: 'notice',
            message:
              openDrafts === 1
                ? '1 delivery challan draft is open.'
                : `${String(openDrafts)} delivery challan drafts are open.`,
            workId: null,
            workCode: null,
            dueInDays: null,
          });
        }
        for (const bill of unpaidBills) {
          alerts.push({
            kind: 'bill_unpaid',
            severity: 'warning',
            message: `Bill ${String(bill.bill_number)} for ${bill.work_code} is ${bill.status === 'prepared' ? 'prepared but not submitted' : 'submitted and awaiting payment'}.`,
            workId: bill.work_id,
            workCode: bill.work_code,
            dueInDays: null,
          });
        }

        const sumDecimal = (values: readonly string[]): string => {
          // Paise-exact summation without floating point: shift to
          // integer paise via string surgery, never via Number division.
          let paise = 0n;
          for (const value of values) {
            const [rupees = '0', fraction = ''] = value.split('.');
            const cents = (fraction + '00').slice(0, 2);
            const sign = rupees.startsWith('-') ? -1n : 1n;
            const whole = BigInt(rupees.replace('-', '') || '0');
            paise += sign * (whole * 100n + BigInt(cents));
          }
          const sign = paise < 0n ? '-' : '';
          const magnitude = paise < 0n ? -paise : paise;
          const rupees = magnitude / 100n;
          const cents = (magnitude % 100n).toString().padStart(2, '0');
          return `${sign}${rupees.toString()}.${cents}`;
        };

        return {
          totals: {
            works: works.length,
            contractValue: sumDecimal(works.map((row) => row.contract_value)),
            deliveredValue: sumDecimal(works.map((row) => row.delivered_value)),
            billedValue: sumDecimal(works.map((row) => row.billed_value)),
            openDrafts,
            loaAwaitingReview,
          },
          alerts,
          works: works.map((row) => ({
            workId: row.work_id,
            workCode: row.work_code,
            title: row.title,
            status: row.status,
            contractValue: row.contract_value,
            deliveredValue: row.delivered_value,
            billedValue: row.billed_value,
            issuedChallans: Number(row.issued_challans),
          })),
        };
      });
    },
  );
}
