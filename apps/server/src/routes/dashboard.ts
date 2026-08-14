import {
  ApiErrorSchema,
  DashboardResponseSchema,
  type DashboardAlert,
  type DashboardResponse,
  type GstBasis,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { executedPercent, portfolioExecutedPercent } from '../executed-value.js';
import type { Auth } from '../auth.js';
import { hasFullWorkScope } from '../authz.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
} as const;

/** Instruments within this window of their expiry date raise a warning;
 * past it they escalate to danger. Bank guarantees need lead time to
 * extend, so the window is generous. */
const EXPIRY_WARNING_DAYS = 60;

/** Works whose current completion date is this close (or past) surface on
 * the dashboard: a DOC extension request takes time to draft, finalise,
 * and post before the date lapses. */
const COMPLETION_WARNING_DAYS = 30;

interface ProgressRow extends Record<string, unknown> {
  work_id: string;
  work_code: string;
  title: string;
  status: 'active' | 'completed' | 'cancelled';
  contract_value: string;
  delivered_value: string;
  billed_value: string;
  gst_basis: GstBasis;
  gst_rate: string;
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

interface CompletionRow extends Record<string, unknown> {
  work_id: string;
  work_code: string;
  due_on: string;
  due_in_days: string;
}

/** One Work whose LOA letter demands a PBG (works.pbg_required_amount is
 * set), joined against its ACTIVE kind='pbg' instruments. Due dates are
 * derived in SQL date arithmetic: normal due = letter date + submission
 * days, extended due = normal due + extension days. */
interface PbgRequirementRow extends Record<string, unknown> {
  work_id: string;
  work_code: string;
  required_amount: string;
  normal_due: string;
  extended_due: string;
  days_to_normal: string;
  days_to_extended: string;
  active_count: string;
  active_amount: string;
  under_required: boolean;
}

/**
 * The Works a member may see: everything for full scope, the assigned
 * set otherwise. `$1` is the full-scope flag, `$2` the user. Shared
 * verbatim by the progress and PBG statements below so both answer for
 * exactly the same Works.
 */
const VISIBLE_WORKS_CTE = `
  visible as (
    select w.id, w.work_code, w.title, w.status, w.contract_value,
           w.gst_basis, w.gst_rate, w.created_at, w.letter_date,
           w.pbg_required_amount, w.pbg_submission_days, w.pbg_extension_days
    from works w
    where w.deleted_at is null
      and ($1::boolean or exists (
        select 1 from work_assignments wa
        where wa.work_id = w.id and wa.user_id = $2
      ))
  )
`;

/**
 * Per-Work delivered and billed money, PRE-AGGREGATED: each evidence
 * table is grouped by `work_id` once and joined to the visible Works.
 * The predecessor hung a correlated lateral off every Work, so the
 * delivered sum re-scanned the challan lines per Work — 881 ms at the
 * review's measured 412k items, on the screen every session opens with.
 * The sums, casts and ordering are unchanged, so every figure the
 * dashboard reports is character-for-character what the laterals
 * produced (proved on a seeded fixture by the equivalence test, which
 * runs the retired lateral text beside this one).
 *
 * Exported so `test/query-aggregates.integration.test.ts` can EXPLAIN
 * exactly what production runs.
 */
export const DASHBOARD_PROGRESS_SQL = `
  with ${VISIBLE_WORKS_CTE},
  delivered as (
    select c.work_id,
           sum(i.line_amount) as total,
           count(distinct c.id) as challans
    from delivery_challans c
    join delivery_challan_items i on i.delivery_challan_id = c.id
    join visible v on v.id = c.work_id
    where c.status = 'issued'
    group by c.work_id
  ),
  billed as (
    select b.work_id, sum(b.total_amount) as total
    from bills b
    join visible v on v.id = b.work_id
    group by b.work_id
  )
  select
    v.id as work_id,
    v.work_code,
    v.title,
    v.status,
    v.contract_value::text as contract_value,
    coalesce(delivered.total, 0)::numeric(18,2)::text as delivered_value,
    coalesce(billed.total, 0)::numeric(18,2)::text as billed_value,
    -- The basis all three of those figures are stated on: the
    -- delivered and billed sums are built from the Work's own item
    -- rates, which came off the LOA schedule, so they carry the
    -- letter's basis exactly as contract_value does (0062).
    v.gst_basis,
    v.gst_rate::text as gst_rate,
    coalesce(delivered.challans, 0)::text as issued_challans
  from visible v
  left join delivered on delivered.work_id = v.id
  left join billed on billed.work_id = v.id
  order by v.created_at desc
`;

/**
 * PBG requirement vs submission, with the active instruments grouped
 * once rather than re-aggregated per Work. Comparison and date
 * arithmetic both stay in SQL.
 */
export const DASHBOARD_PBG_SQL = `
  with ${VISIBLE_WORKS_CTE},
  active as (
    select wi.work_id, count(*) as count, sum(wi.amount) as total
    from work_instruments wi
    join visible v on v.id = wi.work_id
    where wi.kind = 'pbg' and wi.status = 'active'
    group by wi.work_id
  )
  select
    w.id as work_id,
    w.work_code,
    w.pbg_required_amount::text as required_amount,
    (w.letter_date + w.pbg_submission_days)::text as normal_due,
    (w.letter_date + w.pbg_submission_days
      + coalesce(w.pbg_extension_days, 0))::text as extended_due,
    ((w.letter_date + w.pbg_submission_days) - current_date)::text
      as days_to_normal,
    ((w.letter_date + w.pbg_submission_days
      + coalesce(w.pbg_extension_days, 0)) - current_date)::text
      as days_to_extended,
    coalesce(active.count, 0)::text as active_count,
    coalesce(active.total, 0)::numeric(18,2)::text as active_amount,
    (coalesce(active.total, 0) < w.pbg_required_amount) as under_required
  from visible w
  left join active on active.work_id = w.id
  where w.pbg_required_amount is not null
  order by w.created_at desc
`;

/**
 * The signed-in landing view: everything across the organisation that
 * needs attention (expiring instruments, review queues, open drafts,
 * unpaid bills) plus per-work delivery progress. All sums are exact SQL
 * numeric arithmetic; RLS scopes every query to the bound tenant.
 */
export function registerDashboardRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/dashboard',
      schema: {
        response: { 200: DashboardResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }): Promise<DashboardResponse> => {
      return tenant(async (tx) => {
        // 'assigned'-scoped members see a dashboard of their Works only.
        const full = await hasFullWorkScope(tx, user.id);
        const works = (await tx.unsafe(DASHBOARD_PROGRESS_SQL, [
          full,
          user.id,
        ])) as unknown as ProgressRow[];

        // The IRP reporting window (migration 0049): submitted invoices
        // whose frozen deadline exists and which are still unregistered,
        // split by whether the window is open or closed in the
        // organisation's own timezone. Counts, like the draft count —
        // the invoice screens carry the per-document signal.
        const [counts] = await tx<
          {
            open_drafts: string;
            loa_review: string;
            irp_due: string;
            irp_overdue: string;
          }[]
        >`
          select
            -- Work challans only. This tile sits beside the per-Work
            -- progress table above and has always meant "drafts open on
            -- the Works below"; a standalone challan (migration 0056)
            -- belongs to no Work and has its own register, so counting it
            -- here would change what the number says.
            (select count(*) from delivery_challans
              where status = 'draft' and work_id is not null)::text
              as open_drafts,
            (select count(*) from loa_documents where extraction_status = 'review')::text
              as loa_review,
            (select count(*) from tax_invoices ti
              where ti.status = 'submitted'
                and ti.irp_provider_state not in ('registered', 'registered_unverified')
                and ti.irp_reporting_deadline is not null
                and ti.irp_reporting_deadline >=
                  (select (now() at time zone o.timezone)::date
                   from organisations o
                   where o.id = ti.organisation_id))::text as irp_due,
            (select count(*) from tax_invoices ti
              where ti.status = 'submitted'
                and ti.irp_provider_state not in ('registered', 'registered_unverified')
                and ti.irp_reporting_deadline is not null
                and ti.irp_reporting_deadline <
                  (select (now() at time zone o.timezone)::date
                   from organisations o
                   where o.id = ti.organisation_id))::text as irp_overdue
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
          join works w on w.id = wi.work_id and w.deleted_at is null
          where wi.status = 'active'
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = w.id and wa.user_id = ${user.id}
            ))
            and wi.expires_on is not null
            and wi.expires_on <= current_date + ${EXPIRY_WARNING_DAYS}::int
          order by wi.expires_on asc
        `;

        const completions = await tx<CompletionRow[]>`
          select
            w.id as work_id,
            w.work_code,
            w.current_completion_date::text as due_on,
            (w.current_completion_date - current_date)::text as due_in_days
          from works w
          where w.deleted_at is null
            and w.status = 'active'
            and w.current_completion_date is not null
            and w.current_completion_date <= current_date + ${COMPLETION_WARNING_DAYS}::int
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = w.id and wa.user_id = ${user.id}
            ))
          order by w.current_completion_date asc
        `;

        // PBG requirement vs submission: every Work whose letter demands
        // a PBG, with the exact-numeric total of its active 'pbg'
        // instruments.
        const pbgRequirements = (await tx.unsafe(DASHBOARD_PBG_SQL, [
          full,
          user.id,
        ])) as unknown as PbgRequirementRow[];

        const unpaidBills = await tx<
          { work_id: string; work_code: string; bill_number: number; status: string }[]
        >`
          select b.work_id, w.work_code, b.bill_number, b.status
          from bills b
          join works w on w.id = b.work_id and w.deleted_at is null
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
        for (const completion of completions) {
          const dueInDays = Number(completion.due_in_days);
          const overdue = dueInDays < 0;
          alerts.push({
            kind: overdue ? 'completion_overdue' : 'completion_due',
            severity: overdue || dueInDays <= 7 ? 'danger' : 'warning',
            message: overdue
              ? `${completion.work_code} passed its completion date on ${completion.due_on}; request a DOC extension.`
              : `${completion.work_code} reaches its completion date on ${completion.due_on} (${String(dueInDays)} days left).`,
            workId: completion.work_id,
            workCode: completion.work_code,
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
        // The reporting-window signals. Overdue is danger — the window
        // has lawfully closed and only a local cancel-and-reissue can
        // move the document — while an open window is a caution with
        // time still on the clock. Neither blocks anything locally.
        const irpReportingDue = Number(counts?.irp_due ?? '0');
        const irpReportingOverdue = Number(counts?.irp_overdue ?? '0');
        if (irpReportingOverdue > 0) {
          alerts.push({
            kind: 'irp_reporting_overdue',
            severity: 'danger',
            message:
              irpReportingOverdue === 1
                ? '1 submitted tax invoice passed its IRP reporting deadline unregistered.'
                : `${String(irpReportingOverdue)} submitted tax invoices passed their IRP reporting deadlines unregistered.`,
            workId: null,
            workCode: null,
            dueInDays: null,
          });
        }
        if (irpReportingDue > 0) {
          alerts.push({
            kind: 'irp_reporting_due',
            severity: 'warning',
            message:
              irpReportingDue === 1
                ? '1 submitted tax invoice awaits IRP registration inside its reporting window.'
                : `${String(irpReportingDue)} submitted tax invoices await IRP registration inside their reporting windows.`,
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
        // PBG requirement panels: (a) required but no active instrument,
        // with days to/past the normal due date; (b) active instruments
        // exist but their exact-numeric total sits below the required
        // amount; (c) the extended window has passed with still no active
        // instrument — the window is missed outright.
        for (const requirement of pbgRequirements) {
          const activeCount = Number(requirement.active_count);
          const daysToNormal = Number(requirement.days_to_normal);
          const daysToExtended = Number(requirement.days_to_extended);
          if (activeCount === 0) {
            if (daysToExtended < 0) {
              alerts.push({
                kind: 'pbg_window_missed',
                severity: 'danger',
                message: `PBG of ₹${requirement.required_amount} for ${requirement.work_code} was not submitted within the extended window (final due ${requirement.extended_due}).`,
                workId: requirement.work_id,
                workCode: requirement.work_code,
                dueInDays: daysToExtended,
              });
            } else {
              const overdue = daysToNormal < 0;
              alerts.push({
                kind: 'pbg_missing',
                severity: overdue || daysToNormal <= 15 ? 'danger' : 'warning',
                message: overdue
                  ? `PBG of ₹${requirement.required_amount} for ${requirement.work_code} is overdue (normal due ${requirement.normal_due}; extended window ends ${requirement.extended_due}).`
                  : `PBG of ₹${requirement.required_amount} for ${requirement.work_code} is due by ${requirement.normal_due}.`,
                workId: requirement.work_id,
                workCode: requirement.work_code,
                dueInDays: daysToNormal,
              });
            }
          } else if (requirement.under_required) {
            alerts.push({
              kind: 'pbg_undervalue',
              severity: 'warning',
              message: `Active PBG for ${requirement.work_code} totals ₹${requirement.active_amount} against the required ₹${requirement.required_amount}.`,
              workId: requirement.work_id,
              workCode: requirement.work_code,
              dueInDays: null,
            });
          }
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

        const gstOf = (row: ProgressRow) => ({
          basis: row.gst_basis,
          ratePercent: row.gst_rate,
        });

        return {
          totals: {
            works: works.length,
            // The three money sums stay what they have always been: the
            // Works' own printed figures added up, so the Contract value
            // tile still shows the rupees the letters state.
            //
            // On a portfolio that MIXES bases that sum is on no single
            // basis, and the honest fix is to state every term as taxable
            // value first. Not done here, deliberately: it would drop the
            // tile by a sixth for today's all-inclusive portfolio, which
            // is a visible change to a number the owner reads off the
            // LOA, and that is the owner's call rather than this change's.
            // The RATIO below does not have that problem — it normalises
            // internally — so the number that drives completion talk is
            // already correct while the tiles are unchanged.
            contractValue: sumDecimal(works.map((row) => row.contract_value)),
            deliveredValue: sumDecimal(works.map((row) => row.delivered_value)),
            billedValue: sumDecimal(works.map((row) => row.billed_value)),
            // Billed against contract across every Work, each term
            // restated as taxable value before it joins either sum, so a
            // portfolio holding both kinds of letter aggregates coherently.
            executedPercent: portfolioExecutedPercent(
              works.map((row) => ({
                contractValue: row.contract_value,
                numerator: row.billed_value,
                numeratorBasis: row.gst_basis,
                gst: gstOf(row),
              })),
            ),
            openDrafts,
            loaAwaitingReview,
            irpReportingDue,
            irpReportingOverdue,
          },
          alerts,
          works: works.map((row) => ({
            workId: row.work_id,
            workCode: row.work_code,
            title: row.title,
            status: row.status,
            // Per-Work figures stay on the Work's OWN basis — that is what
            // its letter says and what its operator recognises — and the
            // basis travels with them so the screen can label it.
            contractValue: row.contract_value,
            deliveredValue: row.delivered_value,
            billedValue: row.billed_value,
            gstBasis: row.gst_basis,
            gstRate: row.gst_rate,
            executedPercent: executedPercent(
              row.billed_value,
              row.gst_basis,
              row.contract_value,
              gstOf(row),
            ),
            issuedChallans: Number(row.issued_challans),
          })),
        };
      });
    },
  );
}
