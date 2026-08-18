import {
  EXPORTABLE_REGISTERS,
  MisSummaryQuerySchema,
  MisSummaryResponseSchema,
  TallyExportQuerySchema,
  type ExportableRegister,
  type MisAgeingBucket,
  type MisSummaryResponse,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { hasAuthority, hasFullWorkScope, requireAuthority } from '../authz.js';
import { httpError } from '../http.js';
import {
  TALLY_CONTENT_TYPE,
  buildTallyXml,
  type TallyCreditNote,
  type TallyInvoice,
  type TallyReceipt,
} from '../tally-xml.js';
import { XLSX_CONTENT_TYPE, buildXlsx, type XlsxColumn } from '../xlsx.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { EXPORT_ROW_CAP } from './audit.js';
import { audit, errorResponses } from './shared.js';

/**
 * Management information: the aggregates the landing dashboard does not
 * carry, every register as a workbook, and the accountant's Tally file.
 *
 * `packages/contracts/src/mis.ts` argues which three aggregates and why
 * only three. This module is the SQL for them plus the two export
 * families, and all three surfaces share one rule that is worth stating
 * once here rather than three times below:
 *
 * **NOTHING IN THIS FILE DOES ARITHMETIC ON MONEY.** Every sum, every
 * difference and every bucket boundary is computed by PostgreSQL over its
 * own exact numerics and arrives as a decimal string. The Tally export goes
 * further and does not even sum: each voucher's legs are the invoice's own
 * frozen snapshot columns, which is the rule `tally-xml.ts` is built
 * around.
 *
 * ## Why the whole module requires full work scope
 *
 * A management summary of a slice of the portfolio is a management summary
 * that is wrong, silently, in the direction of "things look smaller than
 * they are" — and none of its three aggregates has a Work dimension to
 * narrow honestly anyway: output tax includes the direct invoices that
 * belong to no Work, ageing is over the whole receivables position, and
 * payroll has no Work at all. The register EXPORTS are different and do
 * narrow, register by register; see `REGISTERS` below.
 */

/** The month series' default depth. Two financial years is what a
 * comparison against "the same month last year" needs. */
const DEFAULT_MONTHS = 24;

/** Refuses a caller whose scope does not cover every Work. Shared with
 * `routes/audit.ts`'s rule and worded the same way, because it is the same
 * rule: an organisation-wide read needs an organisation-wide member. */
async function requireFullScope(tx: TransactionSql, userId: string): Promise<void> {
  if (await hasFullWorkScope(tx, userId)) return;
  throw httpError(
    403,
    'WORK_SCOPE_FORBIDDEN',
    'This is an organisation-wide summary, and your membership is limited to the Works you are assigned to. The Works register and each Work’s own screens carry the same figures for the Works you can see.',
  );
}

/* --- the three aggregates ------------------------------------------------- */

/**
 * Output tax by month, from the FROZEN columns of invoices that DECLARED a
 * liability and of the credit notes that reverse them.
 *
 * `submitted` AND `superseded`, which is the distinction the first cut of
 * this got wrong. Only `cancelled` is excluded: a cancelled invoice
 * declares nothing, and 0035's `tax_invoices_cancel_shape` makes the status
 * the whole answer. A SUPERSEDED invoice is the opposite case — it was
 * submitted, it declared its liability, it was reported to the IRP, and it
 * is now reversed by a full-value credit note (0051). Dropping it while
 * keeping its credit note would have shown every superseded pair as a
 * credit against nothing, which reads as a month the organisation gave
 * money away in.
 *
 * The month key is derived from `invoice_date` / `note_date`, which are
 * date-only legal values — so the month is the document's own month, not a
 * timezone interpretation of a timestamp. The two sides are unioned into a
 * month spine and joined back, so a month with credit notes and no invoices
 * still appears rather than dropping out of the series.
 *
 * Exported so `test/query-aggregates.integration.test.ts` can EXPLAIN what
 * production runs.
 */
export const MIS_OUTPUT_TAX_SQL = `
  with spine as (
    select to_char(invoice_date, 'YYYY-MM') as month
    from tax_invoices where status in ('submitted', 'superseded')
    union
    select to_char(note_date, 'YYYY-MM') as month
    from credit_notes where status = 'issued'
  ),
  invoiced as (
    select to_char(invoice_date, 'YYYY-MM') as month,
           count(*) as invoice_count,
           sum(taxable_value) as taxable_value,
           sum(cgst_amount) as cgst,
           sum(sgst_amount) as sgst,
           sum(igst_amount) as igst,
           -- The three arms added HERE, in exact numerics, because the
           -- screen may not add them: a month carrying both intra-state
           -- and inter-state invoices has all three non-zero, so no one
           -- column is "the GST".
           sum(cgst_amount + sgst_amount + igst_amount) as gst_total,
           sum(total_amount) as total
    from tax_invoices where status in ('submitted', 'superseded')
    group by 1
  ),
  credited as (
    select to_char(note_date, 'YYYY-MM') as month,
           count(*) as credit_note_count,
           sum(taxable_value) as taxable_value,
           sum(total_amount) as total
    from credit_notes where status = 'issued'
    group by 1
  )
  select
    spine.month,
    coalesce(invoiced.invoice_count, 0)::text as invoice_count,
    coalesce(invoiced.taxable_value, 0)::numeric(18,2)::text as taxable_value,
    coalesce(invoiced.cgst, 0)::numeric(18,2)::text as cgst,
    coalesce(invoiced.sgst, 0)::numeric(18,2)::text as sgst,
    coalesce(invoiced.igst, 0)::numeric(18,2)::text as igst,
    coalesce(invoiced.gst_total, 0)::numeric(18,2)::text as gst_total,
    coalesce(invoiced.total, 0)::numeric(18,2)::text as total,
    coalesce(credited.credit_note_count, 0)::text as credit_note_count,
    coalesce(credited.taxable_value, 0)::numeric(18,2)::text as credit_taxable_value,
    coalesce(credited.total, 0)::numeric(18,2)::text as credit_total
  from spine
  left join invoiced on invoiced.month = spine.month
  left join credited on credited.month = spine.month
  order by spine.month desc
  -- Months WITH DATA, not calendar months: a quiet quarter does not
  -- consume three of the caller's rows. The screen's own hint says so.
  limit $1
`;

/**
 * Receivables ageing.
 *
 * Age is days since SUBMISSION, taken from `bills.submitted_at` against the
 * organisation's own today (`organisations.timezone`, the same reading the
 * dashboard's IRP window uses) rather than the server's. A bill that has
 * not been submitted has no age the railway is responsible for, so it gets
 * its own bucket instead of being folded into the youngest one — a prepared
 * bill sitting unsent for four months is a management fact of its own.
 *
 * The outstanding figure comes from `bill_settlement_positions` (0067),
 * which IS the definition of one in this product. A bill whose measurement
 * is not closed has `outstanding_amount IS NULL` — the railway has
 * certified no figure, so nothing is outstanding YET rather than zero — and
 * those are counted separately rather than bucketed at zero, because a
 * table that showed them as nil would state an amount nobody knows.
 */
export const MIS_AGEING_SQL = `
  with today as (
    select (now() at time zone o.timezone)::date as day
    from organisations o
    where o.id = app_private.current_organisation_id()
  ),
  positions as (
    select
      p.outstanding_amount,
      case
        when b.submitted_at is null then 'unsubmitted'
        -- BOTH sides of the subtraction in the organisation's own
        -- timezone. A bare submitted_at::date casts in the SESSION
        -- timezone, which is UTC here, so a bill submitted at 09:00 IST
        -- read against an IST today was a day out for five and a half
        -- hours of every day -- and a day out is a bucket out at every
        -- boundary.
        when (today.day - submitted.day) <= 30 then '0-30'
        when (today.day - submitted.day) <= 60 then '31-60'
        when (today.day - submitted.day) <= 90 then '61-90'
        else '90+'
      end as bucket
    from bill_settlement_positions p
    join bills b
      on b.organisation_id = p.organisation_id and b.id = p.bill_id
    cross join today
    left join lateral (
      select (b.submitted_at at time zone o.timezone)::date as day
      from organisations o where o.id = b.organisation_id
    ) submitted on true
    where p.status in ('prepared', 'submitted')
  )
  select
    bucket,
    count(*) filter (where outstanding_amount is not null)::text as bill_count,
    coalesce(sum(outstanding_amount), 0)::numeric(18,2)::text as outstanding,
    count(*) filter (where outstanding_amount is null)::text as indeterminate
  from positions
  group by bucket
`;

/** Finalised payroll runs, rolled up by the month they pay for. Deductions
 * are `gross - net` computed by PostgreSQL over exact numerics — the two
 * columns 0090 stores — rather than by summing the eight statutory heads,
 * which would be a second derivation of a figure the line already states. */
export const MIS_PAYROLL_SQL = `
  select
    to_char(r.period_month, 'YYYY-MM') as month,
    count(distinct r.id)::text as run_count,
    -- DISTINCT: two finalised runs paying the same month (a supplementary
    -- run beside the regular one) would otherwise count every employee
    -- twice.
    count(distinct l.employee_id)::text as headcount,
    coalesce(sum(l.gross_earnings), 0)::numeric(18,2)::text as gross_pay,
    coalesce(sum(l.gross_earnings) - sum(l.net_pay), 0)::numeric(18,2)::text
      as deductions,
    coalesce(sum(l.net_pay), 0)::numeric(18,2)::text as net_pay
  from payroll_runs r
  join payroll_run_lines l
    on l.organisation_id = r.organisation_id and l.payroll_run_id = r.id
  where r.status = 'finalized'
  group by 1
  order by 1 desc
  limit $1
`;

const AGEING_ORDER: readonly MisAgeingBucket['bucket'][] = [
  'unsubmitted',
  '0-30',
  '31-60',
  '61-90',
  '90+',
];

/* --- the register workbooks ----------------------------------------------- */

/**
 * One exportable register: its sheet name, its columns, and the statement
 * that produces its rows.
 *
 * `$1` is the caller's full-scope flag and `$2` their user id, exactly as
 * `routes/dashboard.ts` passes them, so a WORK-scoped register narrows to
 * the caller's assignments with the same predicate the register's own
 * screen uses. An ORGANISATION-scoped register has no Work dimension to
 * narrow by — a vendor payment and an employee belong to the company, not
 * to a Work — so those require full scope outright rather than answering an
 * empty file.
 *
 * Adding a register is one entry here and one name in
 * `EXPORTABLE_REGISTERS`. That is the whole of "Excel everywhere": one
 * route, one writer, one descriptor per register — not six endpoints, six
 * schemas and six client methods that would drift apart the first time a
 * column was renamed.
 *
 * ## WHAT A WORKBOOK CONTAINS, stated once and true of all six
 *
 * THE WHOLE REGISTER, under the caller's own scope — never the screen's
 * current filter state. None of the six statements below takes a filter,
 * and the button that offers them says so whenever a filter is active
 * (`ui/download-button.tsx`, `docs/UX.md` § 19).
 *
 * The first cut of this file claimed the opposite — "the export shows
 * exactly what the screen showed" — while taking no filters at all, which
 * is the worst of the three options: an operator who has narrowed a
 * register to one Work and exports it gets every Work, and nothing on the
 * screen or in the file says so.
 *
 * The audit register is the ONE export whose filters travel, and it is not
 * an inconsistency: its window is clamped by the organisation's retention
 * policy, so a trail exported without its window is not a bigger version of
 * the same document — it is one that claims to reach further back than the
 * register may look. Filters there are part of what the document IS.
 *
 * ponytail: no per-register filter schemas. Add them when an operator
 * actually asks for a filtered workbook — it is one querystring schema and
 * one WHERE fragment per descriptor, and the button's hint retires with it.
 */
interface RegisterDescriptor {
  readonly sheet: string;
  readonly filename: string;
  readonly columns: readonly XlsxColumn[];
  readonly sql: string;
  /** Whether an assigned-scope member may export a narrowed version. */
  readonly scope: 'work' | 'organisation';
  /** An authority required on top, where the register carries one. */
  readonly authority?: 'payments' | 'payroll';
}

/** The assignment predicate, shared by every work-scoped register. */
const VISIBLE_WORK = `($1::boolean or exists (
  select 1 from work_assignments wa
  where wa.work_id = w.id and wa.user_id = $2))`;

/**
 * Every register this route can produce — TOTAL over `ExportableRegister`,
 * so a name added to the contract without a descriptor fails to compile
 * rather than 404ing at runtime. That totality is why the route needs no
 * "unknown register" refusal at all: the parameter is the same union, so
 * schema validation refuses anything else before the handler runs.
 */
const REGISTERS: Readonly<Record<ExportableRegister, RegisterDescriptor>> = {
  works: {
    sheet: 'Works',
    filename: 'works',
    columns: [
      { header: 'Work code' },
      { header: 'Title' },
      { header: 'Status' },
      { header: 'Letter date' },
      { header: 'Completion date' },
      { header: 'Contract value', numeric: true },
      { header: 'GST basis' },
    ],
    scope: 'work',
    sql: `
      select w.work_code, w.title, w.status,
             w.letter_date::text as letter_date,
             w.current_completion_date::text as completion_date,
             w.contract_value::text as contract_value,
             w.gst_basis
      from works w
      where w.deleted_at is null and ${VISIBLE_WORK}
      order by w.work_code asc
    `,
  },
  'delivery-challans': {
    sheet: 'Delivery challans',
    filename: 'delivery-challans',
    columns: [
      { header: 'Challan number' },
      { header: 'Challan date' },
      { header: 'Work code' },
      { header: 'Status' },
      { header: 'Line count', numeric: true },
      { header: 'Total amount', numeric: true },
    ],
    scope: 'work',
    sql: `
      select c.challan_number, c.challan_date::text as challan_date,
             w.work_code, c.status,
             (select count(*) from delivery_challan_items i
               where i.delivery_challan_id = c.id)::text as line_count,
             (select coalesce(sum(i.line_amount), 0)
               from delivery_challan_items i
               where i.delivery_challan_id = c.id)::numeric(18,2)::text as total_amount
      from delivery_challans c
      join works w on w.id = c.work_id and w.deleted_at is null
      where ${VISIBLE_WORK}
      order by c.challan_date desc, c.created_at desc
    `,
  },
  'tax-invoices': {
    sheet: 'Tax invoices',
    filename: 'tax-invoices',
    columns: [
      { header: 'Invoice number' },
      { header: 'Invoice date' },
      { header: 'Work code' },
      { header: 'Status' },
      { header: 'Taxable value', numeric: true },
      { header: 'CGST', numeric: true },
      { header: 'SGST', numeric: true },
      { header: 'IGST', numeric: true },
      { header: 'Total', numeric: true },
      { header: 'IRN' },
    ],
    scope: 'work',
    sql: `
      select ti.invoice_number, ti.invoice_date::text as invoice_date,
             w.work_code, ti.status,
             ti.taxable_value::text as taxable_value,
             ti.cgst_amount::text as cgst_amount,
             ti.sgst_amount::text as sgst_amount,
             ti.igst_amount::text as igst_amount,
             ti.total_amount::text as total_amount,
             ti.irn
      from tax_invoices ti
      -- LEFT, for the same reason the stock ledger's join is: an invoice
      -- need not belong to a Work. A DIRECT invoice (0039) is raised
      -- against a private customer with no Work and no Measurement Book,
      -- the register's own screen lists it, and an inner join dropped
      -- every one of them from the workbook without saying so.
      left join works w on w.id = ti.work_id and w.deleted_at is null
      where (ti.work_id is null or ${VISIBLE_WORK})
        -- A direct invoice belongs to the organisation rather than to a
        -- Work, so it travels for a full-scope member and is withheld
        -- from an assigned-scope one.
        and (ti.work_id is not null or $1::boolean)
      order by ti.invoice_date desc, ti.created_at desc
    `,
  },
  'stock-movements': {
    sheet: 'Stock movements',
    filename: 'stock-movements',
    columns: [
      { header: 'Date' },
      { header: 'Item code' },
      { header: 'Movement' },
      { header: 'Quantity', numeric: true },
      { header: 'Balance after', numeric: true },
      { header: 'Work code' },
      { header: 'Reason' },
    ],
    scope: 'work',
    sql: `
      select sm.movement_date::text as movement_date, pi.item_code,
             sm.movement_type, sm.quantity::text as quantity,
             sm.balance_after::text as balance_after,
             w.work_code, sm.reason
      from stock_movements sm
      join production_items pi
        on pi.organisation_id = sm.organisation_id and pi.id = sm.production_item_id
      -- LEFT, because a movement need not belong to a Work at all: 0087's
      -- shape CHECK explicitly allows a production receipt or a job-card
      -- issue that names no Work, and an inner join silently dropped every
      -- one of them from the workbook. The scope predicate below therefore
      -- has to say what happens to a work-less row rather than relying on
      -- the join to have removed it.
      left join works w on w.id = sm.work_id and w.deleted_at is null
      where (sm.work_id is null or ${VISIBLE_WORK})
        -- A work-less movement is an organisation-level fact, so it is
        -- visible to a full-scope member and withheld from an
        -- assigned-scope one — the same posture the organisation-wide
        -- registers take, applied per row.
        and (sm.work_id is not null or $1::boolean)
      order by sm.movement_date desc, sm.created_at desc
    `,
  },
  payments: {
    sheet: 'Vendor payments',
    filename: 'vendor-payments',
    columns: [
      { header: 'Paid on' },
      { header: 'Vendor invoice' },
      { header: 'Gross', numeric: true },
      { header: 'TDS', numeric: true },
      { header: 'Net', numeric: true },
      { header: 'TDS section' },
      { header: 'Vendor PAN' },
    ],
    scope: 'organisation',
    // NO authority, and that is an alignment rather than an omission.
    // `GET /api/vendor-invoices` — the read behind the screen this button
    // sits on — declares none either: any member may READ the vendor
    // ledger, and `payments` gates recording and paying, which are writes.
    // Declaring it here made the export refuse the founder of a new
    // organisation, who is not granted `can_manage_payments` at bootstrap
    // (0080 withholds it deliberately) and who can nonetheless see every
    // row on the screen. An export must not be harder to obtain than the
    // screen it exports.
    sql: `
      select vp.paid_on::text as paid_on, vi.invoice_number,
             vp.gross_amount::text as gross_amount,
             vp.tds_amount::text as tds_amount,
             vp.net_amount::text as net_amount,
             vp.tds_section, vp.vendor_pan
      from vendor_payments vp
      join vendor_invoices vi
        on vi.organisation_id = vp.organisation_id and vi.id = vp.vendor_invoice_id
      order by vp.paid_on desc, vp.created_at desc
    `,
  },
  employees: {
    sheet: 'Employees',
    filename: 'employees',
    columns: [
      { header: 'Employee code' },
      { header: 'Name' },
      { header: 'Department' },
      { header: 'Joined' },
      { header: 'Exited' },
      { header: 'PF covered' },
      { header: 'ESI applicable' },
    ],
    scope: 'organisation',
    authority: 'payroll',
    sql: `
      select e.employee_code, c.designation as name, e.department,
             e.date_of_joining::text as date_of_joining,
             e.date_of_exit::text as date_of_exit,
             e.pf_covered::text as pf_covered,
             e.esi_applicable::text as esi_applicable
      from employees e
      join contacts c on c.organisation_id = e.organisation_id and c.id = e.contact_id
      order by e.employee_code asc
    `,
  },
};

/* --- routes --------------------------------------------------------------- */

/**
 * The register name, as a closed set rather than a pattern.
 *
 * Two things follow from the enum that a free string did not give. An
 * unknown name is refused by schema validation before the handler runs, so
 * a probe never reaches the tenant transaction; and the OpenAPI document
 * lists the registers a client may ask for, which is the same list the
 * client's export buttons are rendered from.
 */
const RegisterParamsSchema = Type.Object(
  {
    register: Type.Union(EXPORTABLE_REGISTERS.map((name) => Type.Literal(name))),
  },
  { additionalProperties: false },
);

/**
 * A row's cells, in the descriptor's declared column ORDER.
 *
 * `Object.values(row)` alone would have coupled the sheet to the order
 * PostgreSQL happened to return columns in, and to the descriptor's column
 * list agreeing with it by eye. It does today; the assertion below is what
 * keeps it true after somebody adds a column to a SELECT and not to the
 * header list, which produces a workbook whose data is one column to the
 * left of its headings and reads as plausible.
 */
function cellsOf(
  register: RegisterDescriptor,
): (row: Record<string, string | null>) => (string | null)[] {
  return (row) => {
    const cells = Object.values(row);
    if (cells.length !== register.columns.length) {
      throw new Error(
        `${register.sheet}: the statement returns ${String(cells.length)} columns and the descriptor declares ${String(register.columns.length)}`,
      );
    }
    return cells;
  };
}

/** The last row of a truncated workbook, saying so in the sheet itself.
 * The response headers carry the same fact for a machine; this is for the
 * person who opens the file, scrolls to the bottom and would otherwise
 * believe they had the whole register. */
function truncationRow(
  register: RegisterDescriptor,
  capped: boolean,
): (string | null)[][] {
  if (!capped) return [];
  const row: (string | null)[] = Array.from(
    { length: register.columns.length },
    () => null,
  );
  row[0] = `… truncated at ${String(EXPORT_ROW_CAP)} rows. Narrow the register and export again.`;
  return [row];
}

/**
 * How wide a Tally window may be.
 *
 * One financial year plus a month of slack, which is the period an
 * accountant imports. The bound is not politeness: the three statements
 * below have no keyset and no page, so an unbounded window is an unbounded
 * result set held in one string in memory. The header comment used to
 * claim the export was "bounded by a financial-year window" while nothing
 * enforced one.
 */
const TALLY_MAX_WINDOW_DAYS = 400;

export function registerMisRoutes(app: AppInstance, auth: Auth, database: Sql): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/mis/summary',
      schema: {
        querystring: MisSummaryQuerySchema,
        response: { 200: MisSummaryResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }): Promise<MisSummaryResponse> => {
      const months = request.query.months ?? DEFAULT_MONTHS;
      return tenant(async (tx) => {
        await requireFullScope(tx, user.id);
        const outputTax = (await tx.unsafe(MIS_OUTPUT_TAX_SQL, [
          months,
        ])) as unknown as {
          month: string;
          invoice_count: string;
          taxable_value: string;
          cgst: string;
          sgst: string;
          igst: string;
          gst_total: string;
          total: string;
          credit_note_count: string;
          credit_taxable_value: string;
          credit_total: string;
        }[];
        const ageingRows = (await tx.unsafe(MIS_AGEING_SQL, [])) as unknown as {
          bucket: MisAgeingBucket['bucket'];
          bill_count: string;
          outstanding: string;
          indeterminate: string;
        }[];
        const byBucket = new Map(ageingRows.map((row) => [row.bucket, row]));
        // Every bucket every time, in a fixed order: a table whose rows
        // appear and disappear with the data is one an operator has to
        // re-read each visit, and "nothing is 61-90 days old" is itself
        // the answer they came for.
        const receivablesAgeing = AGEING_ORDER.map((bucket) => ({
          bucket,
          billCount: Number(byBucket.get(bucket)?.bill_count ?? '0'),
          outstanding: byBucket.get(bucket)?.outstanding ?? '0.00',
        }));
        const indeterminateBills = ageingRows.reduce(
          (total, row) => total + Number(row.indeterminate),
          0,
        );
        // The payroll panel is answered only for a member who may read
        // payroll at all. Absent, not refused: a management summary that
        // 403s as a whole because one of four panels is out of reach is
        // useless to everyone who is not an owner.
        const payrollCost = (await hasAuthority(tx, user.id, 'payroll'))
          ? ((await tx.unsafe(MIS_PAYROLL_SQL, [months])) as unknown as {
              month: string;
              run_count: string;
              headcount: string;
              gross_pay: string;
              deductions: string;
              net_pay: string;
            }[])
          : null;
        return {
          outputTax: outputTax.map((row) => ({
            month: row.month,
            invoiceCount: Number(row.invoice_count),
            taxableValue: row.taxable_value,
            cgst: row.cgst,
            sgst: row.sgst,
            igst: row.igst,
            gstTotal: row.gst_total,
            total: row.total,
            creditNoteCount: Number(row.credit_note_count),
            creditTaxableValue: row.credit_taxable_value,
            creditTotal: row.credit_total,
          })),
          receivablesAgeing,
          indeterminateBills,
          payrollCost:
            payrollCost === null
              ? null
              : payrollCost.map((row) => ({
                  month: row.month,
                  runCount: Number(row.run_count),
                  headcount: Number(row.headcount),
                  grossPay: row.gross_pay,
                  deductions: row.deductions,
                  netPay: row.net_pay,
                })),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      // The extension is its OWN segment, not a suffix on the parameter.
      // `/api/registers/:register.xlsx` reads to a router as one segment
      // whose name is `register.xlsx`, which no params schema can name
      // and no caller can address — `test/route-inventory` found it by
      // synthesising a request the route could not answer.
      url: '/api/registers/:register/workbook.xlsx',
      // No 200 in the response map: the payload is bytes, not JSON, the
      // same shape every PDF route in this tree declares. The refusals
      // still are declared, so a client knows what it can be told.
      schema: { params: RegisterParamsSchema, response: { ...errorResponses } },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const register = REGISTERS[request.params.register];
      const result = await tenant(async (tx) => {
        if (register.authority !== undefined) {
          await requireAuthority(tx, user.id, register.authority);
        }
        const full = await hasFullWorkScope(tx, user.id);
        // An organisation-wide register has no Work to narrow by, so a
        // member who cannot see every Work cannot export one. A
        // work-scoped register narrows instead, with the same predicate
        // its own screen uses — the export shows exactly what the screen
        // showed, which is the property the scope test pins.
        if (register.scope === 'organisation' && !full) {
          await requireFullScope(tx, user.id);
        }
        // Only a work-scoped statement names $1 and $2; an
        // organisation-wide one has no Work to narrow by and would be
        // handed two parameters it never declared, which PostgreSQL
        // refuses outright rather than ignoring.
        const parameters: (boolean | string)[] =
          register.scope === 'work' ? [full, user.id] : [];
        // One row over the cap, so the file can SAY it was truncated
        // instead of quietly ending. `capped` below is the difference
        // between "this is the register" and "this is the start of it".
        const fetched = (await tx.unsafe(
          `${register.sql} limit ${EXPORT_ROW_CAP + 1}`,
          parameters,
        )) as unknown as Record<string, string | null>[];
        const capped = fetched.length > EXPORT_ROW_CAP;
        const rows = fetched.slice(0, EXPORT_ROW_CAP);
        await audit(
          tx,
          organisationId,
          user.id,
          'register.exported',
          'organisations',
          organisationId,
          { register: request.params.register, rows: rows.length, capped },
        );
        return {
          capped,
          bytes: buildXlsx(register.sheet, register.columns, [
            ...rows.map(cellsOf(register)),
            ...truncationRow(register, capped),
          ]),
        };
      });
      void reply.type(XLSX_CONTENT_TYPE);
      void reply.header(
        'content-disposition',
        `attachment; filename="${register.filename}.xlsx"`,
      );
      void reply.header('x-auto-mb-export-rows-cap', String(EXPORT_ROW_CAP));
      void reply.header('x-auto-mb-export-truncated', String(result.capped));
      return reply.send(result.bytes);
    },
  );

  /**
   * The accountant's Tally import file.
   *
   * Owner-only and organisation-wide: it carries every sale, every credit
   * note and every receipt in the window, which is the company's whole
   * revenue position in one download.
   */
  tenantRoute(
    {
      method: 'GET',
      url: '/api/exports/tally.xml',
      role: 'owner',
      schema: { querystring: TallyExportQuerySchema },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { from, to } = request.query;
      if (from > to) {
        throw httpError(
          400,
          'EXPORT_WINDOW_INVALID',
          'The export window starts after it ends.',
        );
      }
      // Compared as UTC midnights on two date-only values, which is a
      // span in days and never a wall-clock question — no timezone can
      // change how many days lie between two dates.
      const spanDays =
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      if (spanDays > TALLY_MAX_WINDOW_DAYS) {
        throw httpError(
          400,
          'EXPORT_WINDOW_INVALID',
          `A Tally export covers at most ${String(TALLY_MAX_WINDOW_DAYS)} days. Export one financial year at a time.`,
        );
      }
      const xml = await tenant(async (tx) => {
        const invoices = await tx<TallyInvoiceRow[]>`
          select ti.invoice_number, ti.invoice_date::text as invoice_date,
                 ti.buyer_snapshot, ti.taxable_value::text as taxable_value,
                 ti.cgst_amount::text as cgst_amount,
                 ti.sgst_amount::text as sgst_amount,
                 ti.igst_amount::text as igst_amount,
                 ti.total_amount::text as total_amount,
                 ti.service_description
          from tax_invoices ti
          -- Superseded as well as submitted, for the reason
          -- MIS_OUTPUT_TAX_SQL states: a superseded invoice declared its
          -- liability and was reported, and its full-value credit note —
          -- which this export already emits — reverses it. Emitting the
          -- reversal without the sale would post a credit against a
          -- voucher the accountant's company does not hold.
          where ti.status in ('submitted', 'superseded')
            and ti.invoice_date between ${from}::date and ${to}::date
          order by ti.invoice_date asc, ti.invoice_number asc
          limit ${EXPORT_ROW_CAP}
        `;
        const creditNotes = await tx<TallyCreditNoteRow[]>`
          select cn.note_number, cn.note_date::text as note_date,
                 ti.buyer_snapshot, cn.taxable_value::text as taxable_value,
                 cn.cgst_amount::text as cgst_amount,
                 cn.sgst_amount::text as sgst_amount,
                 cn.igst_amount::text as igst_amount,
                 cn.total_amount::text as total_amount,
                 cn.reason
          from credit_notes cn
          join tax_invoices ti
            on ti.organisation_id = cn.organisation_id and ti.id = cn.tax_invoice_id
          where cn.status = 'issued'
            and cn.note_date between ${from}::date and ${to}::date
          order by cn.note_date asc, cn.note_number asc
          limit ${EXPORT_ROW_CAP}
        `;
        /**
         * A receipt credits the party its Work was INVOICED to.
         *
         * The first cut hardcoded 'Railway', which made every receipt
         * credit a ledger no sales voucher ever debits — the party's
         * account never cleared, and the whole point of handing an
         * accountant vouchers is that they reconcile. The party is
         * resolved the only way the data allows: a bill belongs to a
         * Work, and a Work's invoices name the buyer, so the receipt
         * takes the buyer of that Work's most recent invoice that
         * declared anything. The fallback is the Work code rather than a
         * placeholder, so an unreconciled receipt at least names
         * something an accountant can map by hand.
         */
        const receipts = await tx<TallyReceiptRow[]>`
          select p.reference, p.received_on::text as received_on,
                 p.received_amount::text as received_amount,
                 w.work_code, b.bill_number,
                 party.designation as party_name
          from bill_payments p
          join bills b
            on b.organisation_id = p.organisation_id and b.id = p.bill_id
          join works w on w.id = b.work_id
          left join lateral (
            select ti.buyer_snapshot->>'designation' as designation
            from tax_invoices ti
            where ti.organisation_id = b.organisation_id
              and ti.work_id = b.work_id
              and ti.status in ('submitted', 'superseded')
            order by ti.invoice_date desc, ti.created_at desc
            limit 1
          ) party on true
          where p.voided_at is null
            and p.received_on between ${from}::date and ${to}::date
          order by p.received_on asc, p.created_at asc
          limit ${EXPORT_ROW_CAP}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'tally_export.produced',
          'organisations',
          organisationId,
          {
            from,
            to,
            invoices: invoices.length,
            creditNotes: creditNotes.length,
            receipts: receipts.length,
          },
        );
        return buildTallyXml({
          invoices: invoices.map(toTallyInvoice),
          creditNotes: creditNotes.map(toTallyCreditNote),
          receipts: receipts.map(toTallyReceipt),
        });
      });
      void reply.type(TALLY_CONTENT_TYPE);
      void reply.header(
        'content-disposition',
        `attachment; filename="tally-${from}-to-${to}.xml"`,
      );
      return reply.send(xml);
    },
  );
}

/* --- snapshot rows to voucher inputs -------------------------------------- */

/**
 * The buyer as INVOICED. `buyer_snapshot` is written once at submit (0035)
 * and never again, so the voucher names the party the invoice named even
 * after the contact master was renamed.
 *
 * THE PARTY'S NAME IS `designation`, not `name`, and the first cut of this
 * file read a key the snapshot has never carried — so every voucher posted
 * to the fallback ledger. `routes/tax-invoices/submit.ts` writes the
 * snapshot; `routes/search.ts` and `routes/tax-invoices/register.ts` both
 * read `->>'designation'`, and this now agrees with them. The `contacts`
 * table calls the party's name `designation` and its person `contact_person`
 * (0028), which is the naming this inherits.
 */
interface BuyerSnapshot {
  readonly designation?: unknown;
  readonly gstin?: unknown;
}

interface TallyInvoiceRow {
  invoice_number: string;
  invoice_date: string;
  buyer_snapshot: unknown;
  taxable_value: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  total_amount: string;
  service_description: string;
}

interface TallyCreditNoteRow {
  note_number: string;
  note_date: string;
  buyer_snapshot: unknown;
  taxable_value: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  total_amount: string;
  reason: string;
}

interface TallyReceiptRow {
  reference: string | null;
  received_on: string;
  received_amount: string;
  work_code: string;
  bill_number: number;
  /** The buyer of the Work's most recent declaring invoice, or null when
   * the Work has never been invoiced. */
  party_name: string | null;
}

/** The snapshot's own party name, or the placeholder Tally uses for a sale
 * to an unidentified party. Never the contact master's current name: the
 * voucher must say what the invoice said. */
function buyerName(snapshot: unknown): string {
  const name = (snapshot as BuyerSnapshot | null)?.designation;
  return typeof name === 'string' && name.trim().length > 0 ? name : 'Unregistered';
}

function buyerGstin(snapshot: unknown): string | null {
  const gstin = (snapshot as BuyerSnapshot | null)?.gstin;
  return typeof gstin === 'string' && gstin.length > 0 ? gstin : null;
}

function toTallyInvoice(row: TallyInvoiceRow): TallyInvoice {
  return {
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    buyerName: buyerName(row.buyer_snapshot),
    buyerGstin: buyerGstin(row.buyer_snapshot),
    taxableValue: row.taxable_value,
    cgst: row.cgst_amount,
    sgst: row.sgst_amount,
    igst: row.igst_amount,
    total: row.total_amount,
    serviceDescription: row.service_description,
  };
}

function toTallyCreditNote(row: TallyCreditNoteRow): TallyCreditNote {
  return {
    noteNumber: row.note_number,
    noteDate: row.note_date,
    buyerName: buyerName(row.buyer_snapshot),
    taxableValue: row.taxable_value,
    cgst: row.cgst_amount,
    sgst: row.sgst_amount,
    igst: row.igst_amount,
    total: row.total_amount,
    reason: row.reason,
  };
}

function toTallyReceipt(row: TallyReceiptRow): TallyReceipt {
  const subject = `${row.work_code} bill ${String(row.bill_number)}`;
  return {
    // A receipt with no bank reference still needs a voucher number Tally
    // can key on, and the bill it settles is the only identifier the
    // record carries that an accountant would recognise.
    reference: row.reference ?? subject,
    receivedOn: row.received_on,
    // The same ledger the Work's sales voucher debits, so the party's
    // account clears. The Work code is the fallback for a Work that has
    // never been invoiced — a real case while a bill is prepared ahead of
    // its invoice — and it names something rather than inventing a party.
    payerName: row.party_name ?? row.work_code,
    amount: row.received_amount,
    narration: `Receipt against ${subject}`,
  };
}
