import {
  ApiErrorSchema,
  DashboardResponseSchema,
  type DashboardAlert,
  type DashboardDeadline,
  type DashboardResponse,
  type GstBasis,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  executedPercent,
  portfolioExecutedPercent,
  toTaxableBasis,
} from '../executed-value.js';
import { paiseText, toPaise } from '../money.js';
import type { Auth } from '../auth.js';
import { hasFullWorkScope } from '../authz.js';
import type { AppInstance } from '../app-instance.js';
import { EXPIRY_WARNING_DAYS } from './shared.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
} as const;

/* Instruments within `EXPIRY_WARNING_DAYS` of their expiry date raise a
 * warning; past it they escalate to danger. The window lives in
 * `./shared.js` because the company document library reads the same one:
 * "expiring soon" is one product-wide meaning, not a per-screen guess. */

/** Works whose current completion date is this close (or past) raise an
 * ALERT: a DOC extension request takes time to draft, finalise, and post
 * before the date lapses. */
const COMPLETION_WARNING_DAYS = 30;

/** How far ahead the completion PANEL looks. Twice the alert window, so
 * the screen can show the thirty days that are urgent in red and the
 * thirty behind them in amber — an extension conversation started at
 * sixty days is a letter, and one started at fifteen is a phone call. The
 * alert list is unchanged: it still fires at thirty. */
const COMPLETION_PANEL_DAYS = 60;

/** The horizon of the deadline strip. A quarter is the planning unit an
 * operator actually holds in their head, and it is long enough that a
 * bank guarantee renewal (sixty days) appears with time to act. */
const DEADLINE_HORIZON_DAYS = 90;

/** The strip draws one lamp per row and stops being readable long before
 * this; the cap is a payload guard, not a design one. */
const DEADLINE_ROW_CAP = 60;

/** The trailing window of the billed-against-received series, counting
 * the current month. A full year is what makes a seasonal railway
 * billing cycle visible at all. */
const BILLING_MONTHS = 12;

/** Urgency order for the alert list. A client shows the head of it and
 * drops the tail, so this decides what an operator never sees. */
const SEVERITY_RANK: Record<DashboardAlert['severity'], number> = {
  danger: 0,
  warning: 1,
  notice: 2,
};

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
  /** The Work's furthest ACTIVE defect liability expiry, on a 'pbg' row
   * and where the Work has one. Null everywhere else. See the alert
   * below for why the two dates travel together. */
  dlp_cover_until: string | null;
}

interface CompletionRow extends Record<string, unknown> {
  work_id: string;
  work_code: string;
  title: string;
  due_on: string;
  due_in_days: string;
}

/** One active Work's installation value and completion clock. */
interface ActiveExecutionRow extends Record<string, unknown> {
  work_id: string;
  installed_value: string;
  /** Null where the Work has no completion date recorded yet. */
  due_on: string | null;
  due_in_days: string | null;
}

interface DeadlineRow extends Record<string, unknown> {
  kind: DashboardDeadline['kind'];
  work_id: string;
  work_code: string;
  label: string;
  due_on: string;
  due_in_days: string;
}

interface BillingMonthRow extends Record<string, unknown> {
  month: string;
  billed: string;
  received: string;
  /** The organisation-wide earliest billing month, repeated on every
   * row because it is a property of the organisation and not of the
   * month. Null when nothing has been billed or received at all. */
  billing_since: string | null;
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
 * The organisation's own calendar day, as `routes/mis.ts` reads it.
 *
 * NOT `current_date`, which is the DATABASE SESSION's day and is UTC on
 * every deployment this product has. An agency in IST crosses midnight
 * five and a half hours before the session does, so between 18:30 and
 * 00:00 IST every countdown on this screen was a day long: a guarantee
 * expiring tomorrow read as expiring in two days, and a completion date
 * that had arrived read as one day away. A legal date is decided by the
 * calendar the contract is performed under (AGENTS.md rule 6), and the
 * organisation carries its own (`organisations.timezone`, migration
 * 0001, default `Asia/Kolkata`).
 *
 * Joined rather than inlined so one statement cannot read a different
 * "today" in two of its own branches — the deadline spine unions three
 * sources and every one of them has to answer to the same day.
 */
const TODAY_CTE = `
  today as (
    select (now() at time zone o.timezone)::date as day
    from organisations o
    where o.id = app_private.current_organisation_id()
  )
`;

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
           w.current_completion_date,
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
 * The ACTIVE portfolio's installation value and completion clock, one row
 * per active Work, ordered by the date that matters.
 *
 * A statement of its own rather than three more columns on
 * `DASHBOARD_PROGRESS_SQL`, for the reason pack P16 states and this file
 * already follows twice: new reads do not go on a loader something else
 * runs. That statement answers "every Work, whatever its status, with the
 * money on its documents" and is measured against a committed buffer
 * ceiling; this one answers "the running contracts, by deadline" and
 * touches a table — `installations` — the other never opens.
 *
 * INSTALLED VALUE IS QUANTITY AT THE ACCEPTED RATE, and the rate is
 * `work_items.effective_rate`, never `advertised_rate`: migration 0063
 * records that the accepted rate is what every downstream money figure is
 * built from, and the advertised one is kept only so the derivation can be
 * shown. Delivered value needs no such multiplication because a challan
 * line stores its own `line_amount`.
 *
 * `installations` carries no line amount of its own, so this is the one
 * place the figure is derived — in SQL, over exact numerics, cast to the
 * money scale before it leaves the database.
 *
 * Exported so `test/query-aggregates.integration.test.ts` can EXPLAIN
 * exactly what production runs.
 */
export const DASHBOARD_ACTIVE_EXECUTION_SQL = `
  with ${TODAY_CTE},
  ${VISIBLE_WORKS_CTE},
  installed as (
    select i.work_id, sum(i.quantity * wi.effective_rate) as total
    from installations i
    join work_items wi
      on wi.organisation_id = i.organisation_id
     and wi.id = i.work_item_id
    join visible v on v.id = i.work_id
    where i.status = 'recorded'
      and wi.deleted_at is null
    group by i.work_id
  )
  select
    v.id as work_id,
    coalesce(installed.total, 0)::numeric(18,2)::text as installed_value,
    v.current_completion_date::text as due_on,
    (v.current_completion_date - today.day)::text as due_in_days
  from visible v
  cross join today
  left join installed on installed.work_id = v.id
  where v.status = 'active'
  -- The order the screen draws in: nearest deadline first, and a Work
  -- with no completion date recorded after every Work that has one.
  -- Work code breaks the tie, because two Works due the same day would
  -- otherwise swap places between reads.
  order by v.current_completion_date asc nulls last, v.work_code asc
`;

/**
 * Dated obligations inside the next ninety days: the three clocks a works
 * contract runs on at once, on one spine.
 *
 * ONE LAMP PER WORK for defect liability, not one per installation. A
 * Work's warranties are recorded per installed unit and a large Work has
 * hundreds; the question the strip answers is "when does this Work's
 * defect liability next lapse", so the earliest live expiry INSIDE the
 * window is taken and the rest are the warranty register's business.
 * Instruments stay individual — a Work has a handful, each is a different
 * document with a different bank, and collapsing them would hide which
 * guarantee expires.
 *
 * Overdue obligations are deliberately absent: this is a strip of what is
 * COMING, and something already lapsed is not a deadline but a fact, which
 * the alert list and the completion panel both state in words.
 */
export const DASHBOARD_DEADLINES_SQL = `
  with ${TODAY_CTE},
  ${VISIBLE_WORKS_CTE},
  spine as (
    select
      'completion' as kind, v.id as work_id, v.work_code,
      'Completion' as label, v.current_completion_date as due_on
    from visible v
    cross join today
    where v.status = 'active'
      and v.current_completion_date is not null
      and v.current_completion_date
            between today.day and today.day + $3::int
    union all
    select
      'instrument', wi.work_id, v.work_code,
      upper(wi.kind) || ' ' || wi.reference, wi.expires_on
    from work_instruments wi
    join visible v on v.id = wi.work_id
    cross join today
    where wi.status = 'active'
      and wi.expires_on between today.day and today.day + $3::int
    union all
    select
      'defect_liability', iw.work_id, v.work_code,
      'Defect liability', min(iw.dlp_expires_on)
    from installation_warranties iw
    join visible v on v.id = iw.work_id
    cross join today
    where iw.status = 'active'
      and iw.dlp_expires_on between today.day and today.day + $3::int
    group by iw.work_id, v.work_code
  )
  select
    spine.kind,
    spine.work_id,
    spine.work_code,
    spine.label,
    spine.due_on::text as due_on,
    (spine.due_on - today.day)::text as due_in_days
  from spine
  cross join today
  order by spine.due_on asc, spine.work_code asc, spine.label asc
  limit $4::int
`;

/**
 * Active Works reaching their completion date inside the panel's window,
 * soonest first, measured against the organisation's own calendar day.
 *
 * Read to the PANEL's sixty-day horizon and alerted on at the thirty-day
 * one, in ONE statement rather than two: the wider set contains the
 * narrower one exactly, and two reads of the same table could disagree
 * across a midnight. `$3` is the horizon in days.
 *
 * A plain statement rather than a tagged template because it needs the
 * shared `today` CTE, and postgres.js parameterises everything
 * interpolated into a template — a CTE is text, not a value.
 */
export const DASHBOARD_COMPLETIONS_SQL = `
  with ${TODAY_CTE}
  select
    w.id as work_id,
    w.work_code,
    w.title,
    w.current_completion_date::text as due_on,
    (w.current_completion_date - today.day)::text as due_in_days
  from works w
  cross join today
  where w.deleted_at is null
    and w.status = 'active'
    and w.current_completion_date is not null
    and w.current_completion_date <= today.day + $3::int
    and ($1::boolean or exists (
      select 1 from work_assignments wa
      where wa.work_id = w.id and wa.user_id = $2
    ))
  order by w.current_completion_date asc
`;

/**
 * Billed against received, by calendar month, over a trailing year.
 *
 * THE TWO SERIES ARE BOTH GST-INCLUSIVE, which is the whole reason they
 * may share an axis. A submitted tax invoice's `total_amount` is the
 * grand total the buyer owes; a `bill_payments` receipt is a bank credit,
 * and a bank credit is inclusive of tax always (migration 0067 says so at
 * length). `bills.total_amount` — the prepared Measurement Book bill — is
 * stated on the WORK'S basis, GST-exclusive on a GST-exclusive Work, and
 * is deliberately not added to either side: it measures the same value
 * the invoice already carries, so adding it would double-count, and it
 * would mix bases while doing so.
 *
 * `superseded` invoices count, and only `cancelled` ones do not. That is
 * the same rule `routes/mis.ts` states for output tax and it is stated
 * once there: a superseded invoice DID declare its liability and is
 * reversed by a full-value credit note, so dropping it while keeping the
 * note would draw a month the organisation appeared to give money away in.
 *
 * The month spine is generated rather than unioned from the data, so a
 * quiet quarter renders as three empty months instead of vanishing —
 * which is the difference between a reader seeing a lull and a reader
 * seeing a shorter year.
 */
export const DASHBOARD_MONTHLY_BILLING_SQL = `
  with ${TODAY_CTE},
  ${VISIBLE_WORKS_CTE},
  window_start as (
    select (date_trunc('month', today.day)
            - make_interval(months => $3::int - 1))::date as first_day
    from today
  ),
  months as (
    -- Aliased month_day rather than day: the today CTE already owns that
    -- name here, and an unqualified one is ambiguous.
    select to_char(month_day, 'YYYY-MM') as month
    from today, window_start,
      generate_series(
        window_start.first_day,
        date_trunc('month', today.day)::date,
        interval '1 month'
      ) as month_day
  ),
  -- Every invoice the caller may see, WORK-BACKED OR DIRECT. A direct
  -- invoice (migration 0039) belongs to no Work, so there is no
  -- assignment to check and only a full-scope member may be shown one:
  -- a member limited to their Works has no claim on the organisation's
  -- private-customer billing, and silently adding it to their chart
  -- would leak a total they are not scoped to.
  visible_invoices as (
    select ti.invoice_date, ti.total_amount
    from tax_invoices ti
    left join visible v on v.id = ti.work_id
    where ti.status in ('submitted', 'superseded')
      and (v.id is not null or (ti.work_id is null and $1::boolean))
  ),
  visible_notes as (
    select cn.note_date, cn.total_amount
    from credit_notes cn
    left join visible v on v.id = cn.work_id
    where cn.status = 'issued'
      and (v.id is not null or (cn.work_id is null and $1::boolean))
  ),
  visible_receipts as (
    select p.received_on, p.received_amount
    from bill_payments p
    join bills b
      on b.organisation_id = p.organisation_id and b.id = p.bill_id
    join visible v on v.id = b.work_id
    where p.voided_at is null
  ),
  invoiced as (
    select to_char(invoice_date, 'YYYY-MM') as month,
           sum(total_amount) as total
    from visible_invoices, window_start
    where invoice_date >= window_start.first_day
    group by 1
  ),
  credited as (
    select to_char(note_date, 'YYYY-MM') as month,
           sum(total_amount) as total
    from visible_notes, window_start
    where note_date >= window_start.first_day
    group by 1
  ),
  received as (
    select to_char(received_on, 'YYYY-MM') as month,
           sum(received_amount) as total
    from visible_receipts, window_start
    where received_on >= window_start.first_day
    group by 1
  ),
  -- The first month this application holds ANY billing evidence for,
  -- unbounded by the window above. Ten empty months at the head of a
  -- trailing year are a cutover, not a collapse, and the screen cannot
  -- tell them apart without a figure that predates its own chart.
  earliest as (
    select least(
      (select min(invoice_date) from visible_invoices),
      (select min(received_on) from visible_receipts)
    ) as day
  )
  select
    months.month,
    (coalesce(invoiced.total, 0) - coalesce(credited.total, 0))
      ::numeric(18,2)::text as billed,
    coalesce(received.total, 0)::numeric(18,2)::text as received,
    to_char(earliest.day, 'YYYY-MM') as billing_since
  from months
  cross join earliest
  left join invoiced on invoiced.month = months.month
  left join credited on credited.month = months.month
  left join received on received.month = months.month
  order by months.month asc
`;

/**
 * The signed-in landing view: everything across the organisation that
 * needs attention (expiring instruments, review queues, open drafts,
 * bills not yet paid and the settlement position of each) plus per-work
 * delivery progress. All sums are exact SQL numeric arithmetic; RLS
 * scopes every query to the bound tenant.
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
            unsigned_documents: string;
          }[]
        >`
          select
            -- Documents the signing kiosk still has to pick up: 'pending'
            -- and 'claimed', which is the OPEN set migration 0091 defines.
            --
            -- 'failed' is deliberately excluded. It is a terminal row —
            -- nothing is going to pick it up — and the lamp this count
            -- lights says "waiting to be signed", which a failed attempt
            -- is not. Counting it there reported a document as queued
            -- when it had stopped, and an operator reading the lamp would
            -- have waited for a kiosk that was never coming back to it.
            -- The signing queue is where a failure is surfaced and
            -- retried; if it deserves a lamp of its own, that is a lamp
            -- with its own sentence, not this one widened.
            --
            -- Work-scoped, unlike the three counts below it. 0091 put
            -- work_id on the request precisely so a member limited to
            -- their assignments does not learn that a Work they cannot
            -- reach has documents in the queue.
            (select count(*) from signing_requests sr
              join works w on w.id = sr.work_id and w.deleted_at is null
              where sr.status in ('pending', 'claimed')
                and (${full} or exists (
                  select 1 from work_assignments wa
                  where wa.work_id = w.id and wa.user_id = ${user.id}
                )))::text as unsigned_documents,
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
            (wi.expires_on - current_date)::text as due_in_days,
            case when wi.kind = 'pbg' then (
              select max(iw.dlp_expires_on)::text
              from installation_warranties iw
              where iw.work_id = wi.work_id and iw.status = 'active'
            ) end as dlp_cover_until
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

        /* The completion panel's feed. Its horizon is twice the alert
         * window; the alert loop below still fires at thirty, so nothing
         * between 31 and 60 days out becomes an alert. */
        const completions = (await tx.unsafe(DASHBOARD_COMPLETIONS_SQL, [
          full,
          user.id,
          COMPLETION_PANEL_DAYS,
        ])) as unknown as CompletionRow[];

        // The active portfolio's installation value and completion clock,
        // the deadline strip, and the trailing billing year. Each answers
        // a question none of the statements above asks.
        const activeExecution = (await tx.unsafe(DASHBOARD_ACTIVE_EXECUTION_SQL, [
          full,
          user.id,
        ])) as unknown as ActiveExecutionRow[];
        const deadlineRows = (await tx.unsafe(DASHBOARD_DEADLINES_SQL, [
          full,
          user.id,
          DEADLINE_HORIZON_DAYS,
          DEADLINE_ROW_CAP,
        ])) as unknown as DeadlineRow[];
        const billingMonths = (await tx.unsafe(DASHBOARD_MONTHLY_BILLING_SQL, [
          full,
          user.id,
          BILLING_MONTHS,
        ])) as unknown as BillingMonthRow[];

        // PBG requirement vs submission: every Work whose letter demands
        // a PBG, with the exact-numeric total of its active 'pbg'
        // instruments.
        const pbgRequirements = (await tx.unsafe(DASHBOARD_PBG_SQL, [
          full,
          user.id,
        ])) as unknown as PbgRequirementRow[];

        // Bills not yet moved to `paid`, each with the position its
        // settlement register puts it in.
        //
        // Read from `bill_settlement_positions` (migration 0067) rather
        // than summed here: that view IS the definition of the three
        // figures, including which reference they are measured against,
        // and a second derivation of money that had to agree with it
        // would eventually not. This replaces the statement that stood
        // here rather than joining onto one — the dashboard still issues
        // exactly the reads it did, and pack P16's rule against putting
        // new work on a loader something else already runs is why no
        // part of this was folded into the progress aggregate.
        const unpaidBills = await tx<
          {
            work_id: string;
            work_code: string;
            bill_number: number;
            status: string;
            railway_bill_amount: string | null;
            received_total: string;
            deduction_total: string;
            outstanding_amount: string | null;
            // Which of the two unclosed cases this is. A bill with a
            // Measurement Book is waiting for the railway's On-Account
            // Bill against that book; a bill with none is waiting for a
            // measurement to exist at all, and telling its operator to
            // record a railway bill names a step they cannot take.
            measurement_book_id: string | null;
            // The two comparisons that decide which sentence is printed,
            // made in SQL against the exact numerics rather than on the
            // decimal text after it reaches this process. Both are null
            // exactly when there is no railway figure, which the first
            // branch below has already answered by then.
            nothing_outstanding: boolean | null;
            something_settled: boolean;
          }[]
        >`
          select
            p.work_id,
            w.work_code,
            p.bill_number,
            p.status,
            p.railway_bill_amount::text as railway_bill_amount,
            p.received_total::text as received_total,
            p.deduction_total::text as deduction_total,
            p.outstanding_amount::text as outstanding_amount,
            p.measurement_book_id,
            (p.outstanding_amount = 0) as nothing_outstanding,
            -- Asked of the MONEY rather than of the receipt count: a
            -- receipt of zero carrying no deductions is a legitimate row
            -- (migration 0067 allows it) and it settles nothing, so
            -- counting rows would report a bill as part settled on the
            -- strength of one that moved nothing.
            (p.received_total > 0 or p.deduction_total > 0) as something_settled
          from bill_settlement_positions p
          join works w on w.id = p.work_id and w.deleted_at is null
          where p.status in ('prepared', 'submitted')
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = w.id and wa.user_id = ${user.id}
            ))
          -- The predecessor ordered by the bill's created_at, which the
          -- position view does not carry. Work code then bill number is
          -- the order the operator's own register is in, and it is
          -- stable where a timestamp on two bills prepared in the same
          -- second is not.
          order by w.work_code asc, p.bill_number asc
        `;

        const alerts: DashboardAlert[] = [];
        for (const instrument of instruments) {
          const dueInDays = Number(instrument.due_in_days);
          const label = instrument.kind.toUpperCase();
          const overdue = dueInDays < 0;
          /* TWO READINGS OF ONE GUARANTEE, said in one sentence.
           *
           * This alert counts a PBG down to its own expiry. The Work's
           * defect liability card measures the SAME instrument against
           * the warranty it secures and reports a shortfall. Nothing
           * joined them, so the two could contradict in both directions
           * on the same day: a mild "expires in 40 days" here beside a
           * 911-day shortfall there, or — worse — this alert nagging an
           * operator to renew a guarantee whose every period has been
           * discharged and which is therefore releasable.
           *
           * The cover date is what makes the countdown answerable, so it
           * travels with it. Null where the Work has no live period,
           * which is the honest reading of "no warranty is measuring
           * this guarantee" rather than a zero. Kept as one scalar
           * subquery on the row this alert already reads; the shortfall
           * itself stays where it is computed, because the dashboard is
           * a list of things to look at, not a second calculator. */
          const cover =
            instrument.dlp_cover_until === null
              ? ''
              : ` Defect liability cover on this Work runs to ${instrument.dlp_cover_until}.`;
          alerts.push({
            kind: overdue ? 'instrument_expired' : 'instrument_expiring',
            severity: overdue || dueInDays <= 15 ? 'danger' : 'warning',
            message: overdue
              ? `${label} ${instrument.reference} for ${instrument.work_code} expired on ${instrument.expires_on}.${cover}`
              : `${label} ${instrument.reference} for ${instrument.work_code} expires on ${instrument.expires_on}.${cover}`,
            workId: instrument.work_id,
            workCode: instrument.work_code,
            dueInDays,
            settlement: null,
          });
        }
        for (const completion of completions) {
          const dueInDays = Number(completion.due_in_days);
          // The panel reads sixty days ahead; an ALERT is still only the
          // thirty-day window it has always been.
          if (dueInDays > COMPLETION_WARNING_DAYS) continue;
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
            settlement: null,
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
            settlement: null,
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
            settlement: null,
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
            settlement: null,
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
            settlement: null,
          });
        }
        // A bill that is not `paid` is in one of four positions, and until
        // the settlement register existed the dashboard reported all four
        // with one sentence: "submitted and awaiting payment". That read
        // the same for a bill nobody has paid a rupee of, a bill 95%
        // settled with only a retention argument left, and a bill whose
        // measurement is not closed — where, by §5.7's rule, the
        // outstanding figure is not zero but UNKNOWN. The register can
        // tell them apart, so the landing screen does.
        for (const bill of unpaidBills) {
          const settlement = {
            reference: bill.railway_bill_amount,
            received: bill.received_total,
            deducted: bill.deduction_total,
            outstanding: bill.outstanding_amount,
          };
          const subject = `Bill ${String(bill.bill_number)} for ${bill.work_code}`;
          const stage =
            bill.status === 'prepared' ? 'prepared but not submitted' : 'submitted';
          const common = {
            workId: bill.work_id,
            workCode: bill.work_code,
            dueInDays: null,
            settlement,
          };
          if (bill.outstanding_amount === null) {
            // No railway figure yet, so the position has no arithmetic at
            // all. Not a debt and not a settled matter — a document that
            // has not arrived, which is a different thing to do.
            //
            // Two different things to do, in fact, and the alert names
            // whichever one this bill is actually waiting on. A bill with
            // a Measurement Book needs the railway's On-Account Bill
            // recorded against that book. A bill with NO book — only
            // reachable in data predating migration 0024, since ADR-0006
            // left exactly one statement inserting a bill and it always
            // sets `mb_id` — has nothing for the railway to have
            // certified, so pointing its reader at an On-Account Bill
            // would name a step that cannot be taken.
            alerts.push({
              kind: 'bill_awaiting_closure',
              severity: 'notice',
              message:
                bill.measurement_book_id === null
                  ? `${subject} is ${stage}. It is not backed by a Measurement Book, so there is nothing for the railway to certify and no amount can be outstanding yet — measure the work into a Measurement Book and finalize it first.`
                  : `${subject} is ${stage}. Its measurement is not closed, so nothing is outstanding against it yet — record the railway's On-Account Bill first.`,
              ...common,
            });
          } else if (bill.nothing_outstanding === true) {
            alerts.push({
              kind: 'bill_fully_settled',
              severity: 'notice',
              message: `${subject} is settled in full — receipts and deductions reach the railway's figure — but is still ${stage}. ${
                bill.status === 'prepared'
                  ? 'Submit it, then mark it paid.'
                  : 'Mark it paid.'
              }`,
              ...common,
            });
          } else if (bill.something_settled) {
            alerts.push({
              kind: 'bill_part_settled',
              severity: 'warning',
              message: `${subject} is ${stage} and part settled against the railway's bill.`,
              ...common,
            });
          } else {
            alerts.push({
              kind: 'bill_unpaid',
              severity: 'warning',
              message: `${subject} is ${stage}. Nothing has been received or deducted against the railway's bill.`,
              ...common,
            });
          }
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
                settlement: null,
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
                settlement: null,
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
              settlement: null,
            });
          }
        }

        // Most urgent first, which is what the contract has always
        // promised and what the client's seven-row cap assumes.
        //
        // Until now the list was merely SECTION-ordered — instruments,
        // then completions, then the counted signals, then bills, then
        // PBG — so its urgency ordering was an accident of which loop ran
        // first. A PBG danger is pushed last of all, and eight notices
        // ahead of it were enough to push it past the cap and off the
        // screen entirely. That was already reachable before this change
        // (`challan_draft_open` is a notice), and this change widened it
        // by making two of the four bill signals notices, so it is fixed
        // here rather than left for the next reader to discover.
        //
        // One sort, at the route boundary, on severity alone.
        // `Array.prototype.sort` is stable, so every within-severity
        // order the loops above established survives it — including the
        // bill alerts' work-code-then-number order.
        alerts.sort(
          (left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity],
        );

        // Paise-exact summation without floating point. Every figure below
        // arrives as `numeric(18,2)::text` and is already handed to
        // `portfolioExecutedPercent`'s strict parser in this same handler,
        // so the shared money parser accepts exactly what this loop used to
        // accept — and now says so out loud if a figure ever stops being a
        // money column.
        const sumDecimal = (values: readonly string[]): string =>
          paiseText(values.reduce((total, value) => total + toPaise(value), 0n));

        const gstOf = (row: ProgressRow) => ({
          basis: row.gst_basis,
          ratePercent: row.gst_rate,
        });

        /* THE ACTIVE PORTFOLIO, which is what the landing tiles state.
         *
         * `totals` above keeps its whole-register reading — every Work,
         * whatever its status — because that is what it has always meant
         * and something may still be reading it. The tiles moved to the
         * running contracts on the owner's decision of 2026-08-22
         * (`docs/UX.md` § 39): a completed Work's value never leaves the
         * portfolio total, so the headline drifts upward forever and
         * stops describing anything an operator can act on.
         *
         * `works.contract_value` is the EFFECTIVE value. An amendment
         * moves that column (migration 0104 says so in as many words), so
         * there is nothing to add here for variations — and deriving a
         * second amended total beside it would be a second answer that
         * eventually disagrees with the Work's own screen. */
        const activeWorks = works.filter((row) => row.status === 'active');

        /* The railway's outstanding position, summed from the rows the
         * bill alerts above already read. A bill whose measurement is
         * open has NO outstanding figure — not zero — so it is counted
         * separately rather than added in at nil, exactly as the ageing
         * report does (`routes/mis.ts`). */
        const settledPositions = unpaidBills.filter(
          (bill) => bill.outstanding_amount !== null,
        );
        const receivableOutstanding = sumDecimal(
          settledPositions.map((bill) => bill.outstanding_amount ?? '0'),
        );

        /* Per-Work supply and installation, joined to the money the
         * progress statement already loaded. Both percentages go through
         * `executedPercent`, so each is measured on its own Work's
         * recorded GST basis rather than on whichever basis was nearest. */
        const worksById = new Map(works.map((row) => [row.work_id, row]));

        /* THE PAIR THE PERCENTAGE IS ACTUALLY OF.
         *
         * `activeContractValue` and `activeBilledValue` are the letters'
         * own rupees added up, and on a portfolio mixing GST bases that
         * sum is on no single basis — which made the tile's sentence
         * state a ratio that was true of neither figure printed beside
         * it. `executed-value.ts` names taxable value as the canonical
         * basis for anything aggregating across Works, and
         * `portfolioExecutedPercent` already restates every term onto it
         * internally; these are that same restatement, kept so the screen
         * can print the two rupee figures the percentage is genuinely
         * the ratio of.
         *
         * Summed through the same paise-exact BigInt path as everything
         * else here — `toTaxableBasis` returns an exact decimal string. */
        const activeTaxable = (pick: (row: ProgressRow) => string): string =>
          sumDecimal(
            activeWorks.map((row) =>
              toTaxableBasis(pick(row), row.gst_basis, gstOf(row)),
            ),
          );

        // A cutover is not a collapse. Every row of the billing statement
        // carries the same organisation-wide figure, so the head of it is
        // as good as any; null when this application holds no billing
        // evidence at all.
        const billingSince = billingMonths[0]?.billing_since ?? null;

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
          signals: {
            activeWorks: activeWorks.length,
            activeContractValue: sumDecimal(
              activeWorks.map((row) => row.contract_value),
            ),
            activeBilledValue: sumDecimal(activeWorks.map((row) => row.billed_value)),
            activeContractTaxableValue: activeTaxable((row) => row.contract_value),
            activeBilledTaxableValue: activeTaxable((row) => row.billed_value),
            activeExecutedPercent: portfolioExecutedPercent(
              activeWorks.map((row) => ({
                contractValue: row.contract_value,
                numerator: row.billed_value,
                numeratorBasis: row.gst_basis,
                gst: gstOf(row),
              })),
            ),
            receivableOutstanding,
            receivableIndeterminate: unpaidBills.length - settledPositions.length,
            /* SPLIT, because the two states need different sentences.
             * A Work eleven days past its completion date and one
             * reaching it in nine were counted together and reported with
             * the milder of the two readings — "reaches its completion
             * date within 30 days" — which is false of the first and is
             * the one an operator most needs to see. The panel below
             * already tells them apart row by row; the lamp now does
             * too. */
            completionsOverdue: completions.filter((row) => Number(row.due_in_days) < 0)
              .length,
            completionsDue: completions.filter((row) => {
              const days = Number(row.due_in_days);
              return days >= 0 && days <= COMPLETION_WARNING_DAYS;
            }).length,
            /* Same split, same reason, and here it also closes a hole the
             * ninety-day strip cannot: the strip is forward-only by
             * design, so an instrument that has ALREADY lapsed appears
             * nowhere on it. Folded into "expiring within 60 days" it was
             * a countdown that had run out and did not say so. It is now
             * its own red lamp with its own sentence. */
            instrumentsExpired: instruments.filter((row) => Number(row.due_in_days) < 0)
              .length,
            instrumentsExpiring: instruments.filter(
              (row) => Number(row.due_in_days) >= 0,
            ).length,
            unsignedDocuments: Number(counts?.unsigned_documents ?? '0'),
            // Stated rather than inferred: a scoped member's tiles are
            // their slice of the portfolio, and a total that is not the
            // portfolio has to say which portfolio it is.
            assignedScopeOnly: !full,
            billingSince,
          },
          alerts,
          completions: completions.map((row) => {
            const work = worksById.get(row.work_id);
            return {
              workId: row.work_id,
              workCode: row.work_code,
              title: row.title,
              dueOn: row.due_on,
              dueInDays: Number(row.due_in_days),
              // Undefined only if a Work appeared between the two reads
              // in this same transaction, which the snapshot rules out;
              // the null is the honest answer for "no ratio available"
              // either way, and it is the same null a zero contract value
              // produces.
              executedPercent:
                work === undefined
                  ? null
                  : executedPercent(
                      work.billed_value,
                      work.gst_basis,
                      work.contract_value,
                      gstOf(work),
                    ),
            };
          }),
          monthlyBilling: billingMonths.map((row) => ({
            month: row.month,
            billed: row.billed,
            received: row.received,
          })),
          execution: activeExecution.flatMap((row) => {
            const work = worksById.get(row.work_id);
            if (work === undefined) return [];
            return [
              {
                workId: row.work_id,
                workCode: work.work_code,
                title: work.title,
                suppliedPercent: executedPercent(
                  work.delivered_value,
                  work.gst_basis,
                  work.contract_value,
                  gstOf(work),
                ),
                installedPercent: executedPercent(
                  row.installed_value,
                  // Installed value is quantity at the LOA's own accepted
                  // rate, so it carries the Work's basis exactly as the
                  // delivered and billed sums do (migration 0062).
                  work.gst_basis,
                  work.contract_value,
                  gstOf(work),
                ),
                dueOn: row.due_on,
                dueInDays: row.due_in_days === null ? null : Number(row.due_in_days),
              },
            ];
          }),
          deadlines: deadlineRows.map((row) => ({
            kind: row.kind,
            workId: row.work_id,
            workCode: row.work_code,
            label: row.label,
            dueOn: row.due_on,
            dueInDays: Number(row.due_in_days),
          })),
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
