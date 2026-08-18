import {
  CancelPayrollRunSchema,
  CreateEmployeeSchema,
  EmployeeListQuerySchema,
  EmployeeListResponseSchema,
  EmployeeResponseSchema,
  OpenPayrollRunSchema,
  PayrollRunListResponseSchema,
  PayrollRunResponseSchema,
  SetPayrollLineLopSchema,
  UpdateEmployeeSchema,
  withKeysetQuery,
  KeysetQuerySchema,
  type Employee,
  type EmployeeSummary,
  type ErrorCode,
  type PayrollRun,
  type PayrollRunLine,
  type PayrollRunSummary,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { financialYearLabel } from '../financial-year.js';
import { httpError } from '../http.js';
import { cursorRowId, keysetPage, sqlLimit } from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { audit, errorResponses, IdParamsSchema, optionalTrimmed } from './shared.js';

/**
 * The employee master and the monthly payroll run (migrations 0089 and
 * 0090).
 *
 * The mock draws both screens: `app/employees/page.tsx` through
 * `components/hr/employee-workspace.tsx`, and `app/hr/payroll/page.tsx`
 * through `components/payroll-run-workspace.tsx`, at fdfd610.
 * `docs/UX.md` § 15 records every divergence, and there are more than
 * usual because the mock's employee workspace is a browser-local
 * prototype that says so on its own banner.
 *
 * ## Where the arithmetic is, and why it is not here
 *
 * Not one rupee is computed in this file. `app_private.calculate_payroll_run`
 * does the whole of it in SQL numeric, because rule 5 forbids a JavaScript
 * float anywhere near an authoritative total and because a payroll is the
 * surface where that would show first: a paise of drift per head per month
 * is a contribution that does not reconcile with what was remitted.
 *
 * What this file does is decide WHICH run to compute, prove the caller may,
 * and turn the database's refusals into sentences.
 *
 * ## Where the rules live
 *
 * Twice, as everywhere else. The route checks first, under no lock, so an
 * operator gets a named 409 with a remedy. The triggers of 0090 check
 * again inside the write, under the run's row lock — the arm that holds
 * when a writer reaches the table another way, and the arm that holds
 * under concurrency, which the route cannot.
 *
 * ## Authority, and why there is no new one
 *
 * Every route here declares `authority: 'payments'`, reads included.
 *
 * A new `can_manage_payroll` grant was considered and deliberately not
 * added. Payroll IS money going out, and it goes out through the very
 * `payment_requests` machinery `can_manage_payments` was created to gate
 * (migration 0080) — a second grant for one act is a second thing an
 * owner has to remember. The argument the other way is real and is
 * recorded rather than dismissed: this authority now also reveals what
 * every colleague is paid, which is a different kind of secret from a
 * travel advance. `docs/UX.md` § 15 puts it to the owner. If the answer
 * is to split them, it is one migration and one line here.
 *
 * The READS are gated too, and that is the point of gating them: a
 * register of salaries is not something a member without the authority
 * should be able to fetch, and a route that guarded only the writes
 * would have published it.
 *
 * ## Work-scope
 *
 * There is none, and its absence is a decision. A salary is paid by the
 * agency and not by a contract — the same site engineer works on three
 * Works in a month — so nothing here carries a `work_id` and there is
 * nothing for `assertWorkAccess` to gate. The payments workspace's own
 * work-scope still applies to the salary requests this raises, and they
 * are raised with no Work, which puts them in the branch every scoped
 * member can already see.
 *
 * ## Personal data
 *
 * The employee row carries PAN, UAN, ESIC number and a bank account.
 * `contacts.pan` set the precedent in 0080 and it is followed here: the
 * facts are stored, they are exported in the owner's own portability
 * snapshot, and the LIST projection carries none of them. The detail
 * masks the bank account to its last four digits, as the mock's own
 * directory does, because nothing in this pack needs the whole number.
 * No Aadhaar is stored, transported or logged anywhere.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migrations 0089 and 0090 raise with SQLSTATEs from the 23H block, one
 * per rule, so a guard that fires because the route's own check lost a
 * race surfaces as the same 409 an operator would have got from the
 * route — not as an unexplained 500.
 *
 * Matched on SQLSTATE and never on the text of the RAISE: a reworded
 * message must not be able to turn a 409 back into a 500.
 */
const DATABASE_REFUSALS: Readonly<Record<string, readonly [ErrorCode, string]>> = {
  '23H01': [
    'PAYROLL_SCHEDULE_MISSING',
    'The statutory schedule this run needs does not cover its month, or covers it twice.',
  ],
  '23H02': [
    'PAYROLL_RUN_IMMUTABLE',
    'This payroll run was finalised or cancelled while the change was being made.',
  ],
  '23H03': [
    'PAYROLL_RUN_STATE_CONFLICT',
    'Somebody else moved this payroll run while you were looking at it.',
  ],
  '23H04': [
    'PAYROLL_LINE_INVALID',
    'The payroll line could not be written as stated; re-read the run and try again.',
  ],
  '23H05': [
    'PAYROLL_TAX_OUT_OF_SCOPE',
    'An employee on this run projects an income above the surcharge threshold, which this product does not compute.',
  ],
  // A second live run for one month loses the race to the partial unique
  // index rather than to a guard, so it arrives as 23505.
  '23505': [
    'PAYROLL_RUN_EXISTS',
    'A payroll run for this month was opened while this one was being opened.',
  ],
};

/** The codes this module maps, exported for its own census test. */
export const HR_DATABASE_REFUSAL_CODES: readonly string[] =
  Object.keys(DATABASE_REFUSALS);

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  throw error;
}

/**
 * The organisation's own calendar date.
 *
 * Module-local, as it is in `inspections.ts`, `production.ts` and
 * `payments.ts`: three lines of SQL repeated is cheaper to read than an
 * import that hides which date a route is asking about. An unresolvable
 * date is refused rather than defaulted, for the reason `production.ts`
 * records at length.
 */
async function todayOf(tx: TransactionSql, organisationId: string): Promise<string> {
  const [row] = await tx<{ today: string | null }[]>`
    select app_private.organisation_today(${organisationId})::text as today
  `;
  if (!row?.today) {
    throw httpError(
      409,
      'PAYROLL_PERIOD_INVALID',
      'The organisation has no resolvable calendar date, so a payroll month cannot be decided. Set the organisation timezone in Settings.',
    );
  }
  return row.today;
}

/** `PAY/2026-27/003` — built from the financial year and the sequence,
 * both of which are columns, so nothing stores the assembled string a
 * second time. */
function payrollRunNumber(fyLabel: string, sequenceNumber: number): string {
  return `PAY/${fyLabel}/${String(sequenceNumber).padStart(3, '0')}`;
}

/** The first day of the month a date falls in, as a date-only string.
 * String work only: a legal date never round-trips through a timezone
 * (rule 6). */
function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The mock's own masking, and the only form of an account number this
 * product's screens are given. */
function maskAccount(value: string | null): string | null {
  if (value === null) return null;
  return `•••• ${value.slice(-4)}`;
}

// --- Row shapes -------------------------------------------------------------

interface EmployeeSummaryRow {
  id: string;
  employee_code: string;
  name: string;
  designation: string | null;
  department: string | null;
  date_of_joining: string;
  date_of_exit: string | null;
  employed: boolean;
  monthly_gross: string;
  pf_covered: boolean;
  esi_applicable: boolean;
}

interface EmployeeRow extends EmployeeSummaryRow {
  contact_id: string;
  phone: string | null;
  email: string | null;
  date_of_birth: string;
  pan: string | null;
  uan: string | null;
  esic_number: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  pf_wage_basis: 'actual' | 'ceiling';
  professional_tax_state_code: string | null;
  professional_tax_category: 'male' | 'female' | null;
  tax_regime: 'old' | 'new';
  declared_exempt_allowances_annual: string;
  declared_chapter_via_annual: string;
  basic_monthly: string;
  dearness_allowance_monthly: string;
  house_rent_allowance_monthly: string;
  other_allowances_monthly: string;
}

/**
 * The columns the LIST selects, written out rather than `select *`.
 *
 * This is the personal-data boundary and it is a list of names for that
 * reason: `select *` on this join would carry the PAN, the UAN, the ESIC
 * number and the bank account into every register response the moment
 * somebody added a column, and nothing would have said so.
 */
const EMPLOYEE_SUMMARY_COLUMNS = `
  e.id,
  e.employee_code,
  c.designation as name,
  c.contact_person as designation,
  e.department,
  e.date_of_joining::text as date_of_joining,
  e.date_of_exit::text as date_of_exit,
  (e.date_of_exit is null) as employed,
  (e.basic_monthly + e.dearness_allowance_monthly
    + e.house_rent_allowance_monthly + e.other_allowances_monthly)::text
    as monthly_gross,
  e.pf_covered,
  e.esi_applicable
`;

const EMPLOYEE_DETAIL_COLUMNS = `
  ${EMPLOYEE_SUMMARY_COLUMNS},
  e.contact_id,
  c.phone,
  c.email,
  e.date_of_birth::text as date_of_birth,
  c.pan,
  e.uan,
  e.esic_number,
  c.bank_name,
  c.bank_account_number,
  c.bank_ifsc,
  e.pf_wage_basis,
  e.professional_tax_state_code,
  e.professional_tax_category,
  e.tax_regime,
  e.declared_exempt_allowances_annual::text
    as declared_exempt_allowances_annual,
  e.declared_chapter_via_annual::text as declared_chapter_via_annual,
  e.basic_monthly::text as basic_monthly,
  e.dearness_allowance_monthly::text as dearness_allowance_monthly,
  e.house_rent_allowance_monthly::text as house_rent_allowance_monthly,
  e.other_allowances_monthly::text as other_allowances_monthly
`;

function toEmployeeSummary(row: EmployeeSummaryRow): EmployeeSummary {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    name: row.name,
    designation: row.designation,
    department: row.department,
    dateOfJoining: row.date_of_joining,
    dateOfExit: row.date_of_exit,
    employed: row.employed,
    monthlyGross: row.monthly_gross,
    pfCovered: row.pf_covered,
    esiApplicable: row.esi_applicable,
  };
}

function toEmployee(row: EmployeeRow): Employee {
  return {
    ...toEmployeeSummary(row),
    contactId: row.contact_id,
    phone: row.phone,
    email: row.email,
    dateOfBirth: row.date_of_birth,
    pan: row.pan,
    uan: row.uan,
    esicNumber: row.esic_number,
    bankName: row.bank_name,
    bankAccountMasked: maskAccount(row.bank_account_number),
    bankIfsc: row.bank_ifsc,
    pfWageBasis: row.pf_wage_basis,
    professionalTaxStateCode: row.professional_tax_state_code,
    professionalTaxCategory: row.professional_tax_category,
    taxRegime: row.tax_regime,
    declaredExemptAllowancesAnnual: row.declared_exempt_allowances_annual,
    declaredChapterViaAnnual: row.declared_chapter_via_annual,
    basicMonthly: row.basic_monthly,
    dearnessAllowanceMonthly: row.dearness_allowance_monthly,
    houseRentAllowanceMonthly: row.house_rent_allowance_monthly,
    otherAllowancesMonthly: row.other_allowances_monthly,
  };
}

interface PayrollRunRow {
  id: string;
  run_number: string;
  period_month: string;
  status: 'draft' | 'finalized' | 'cancelled';
  calculated_at: Date | null;
  finalized_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  employee_count: string;
  total_gross: string;
  total_net: string;
}

/** Every register read of a run, with its line totals summed in SQL —
 * never by adding up a page in the browser. */
const RUN_SELECT = `
  select r.id, r.run_number, r.period_month::text as period_month, r.status,
         r.calculated_at, r.finalized_at, r.cancelled_at, r.cancel_reason,
         coalesce(t.employee_count, 0)::text as employee_count,
         coalesce(t.total_gross, 0)::text as total_gross,
         coalesce(t.total_net, 0)::text as total_net
  from payroll_runs r
  left join lateral (
    select count(*) as employee_count,
           sum(l.gross_earnings) as total_gross,
           sum(l.net_pay) as total_net
    from payroll_run_lines l
    where l.payroll_run_id = r.id
  ) t on true
`;

function toRunSummary(row: PayrollRunRow): PayrollRunSummary {
  return {
    id: row.id,
    runNumber: row.run_number,
    periodMonth: row.period_month,
    status: row.status,
    calculatedAt: row.calculated_at?.toISOString() ?? null,
    finalizedAt: row.finalized_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    employeeCount: Number(row.employee_count),
    totalGross: row.total_gross,
    totalNet: row.total_net,
  };
}

interface PayrollLineRow {
  id: string;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  calendar_days: number;
  lop_days: string;
  paid_days: string;
  basic: string;
  dearness_allowance: string;
  house_rent_allowance: string;
  other_allowances: string;
  gross_earnings: string;
  pf_wages: string;
  epf_employee: string;
  epf_employer: string;
  eps_employer: string;
  esi_covered: boolean;
  esi_employee: string;
  esi_employer: string;
  professional_tax: string;
  tax_regime: 'old' | 'new';
  projected_annual_income: string;
  projected_annual_tax: string;
  tds: string;
  net_pay: string;
  payment_request_id: string | null;
  payment_request_number: string | null;
  payment_request_status: string | null;
}

function toRunLine(row: PayrollLineRow): PayrollRunLine {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    employeeName: row.employee_name,
    calendarDays: row.calendar_days,
    lopDays: row.lop_days,
    paidDays: row.paid_days,
    basic: row.basic,
    dearnessAllowance: row.dearness_allowance,
    houseRentAllowance: row.house_rent_allowance,
    otherAllowances: row.other_allowances,
    grossEarnings: row.gross_earnings,
    pfWages: row.pf_wages,
    epfEmployee: row.epf_employee,
    epfEmployer: row.epf_employer,
    epsEmployer: row.eps_employer,
    esiCovered: row.esi_covered,
    esiEmployee: row.esi_employee,
    esiEmployer: row.esi_employer,
    professionalTax: row.professional_tax,
    taxRegime: row.tax_regime,
    projectedAnnualIncome: row.projected_annual_income,
    projectedAnnualTax: row.projected_annual_tax,
    tds: row.tds,
    netPay: row.net_pay,
    paymentRequestId: row.payment_request_id,
    paymentRequestNumber: row.payment_request_number,
    paymentRequestStatus: row.payment_request_status,
  };
}

async function loadRun(
  tx: TransactionSql,
  organisationId: string,
  runId: string,
  options: { readonly lock?: boolean } = {},
): Promise<PayrollRun> {
  if (options.lock === true) {
    // The run row, locked before anything reads its state. Everything
    // that changes a run — calculate, finalise, cancel — takes it, so two
    // operators acting at once serialise here rather than both deciding
    // from the same stale status.
    const [held] = await tx<{ id: string }[]>`
      select id from payroll_runs where id = ${runId} for update
    `;
    if (!held) throw payrollRunNotFound();
  }

  const [row] = await tx<PayrollRunRow[]>`
    ${tx.unsafe(RUN_SELECT)} where r.id = ${runId}
  `;
  if (!row) throw payrollRunNotFound();

  const lines = await tx<PayrollLineRow[]>`
    select l.id, l.employee_id, l.employee_code, l.employee_name,
           l.calendar_days, l.lop_days::text as lop_days,
           (l.calendar_days - l.lop_days)::text as paid_days,
           l.basic::text as basic,
           l.dearness_allowance::text as dearness_allowance,
           l.house_rent_allowance::text as house_rent_allowance,
           l.other_allowances::text as other_allowances,
           l.gross_earnings::text as gross_earnings,
           l.pf_wages::text as pf_wages,
           l.epf_employee::text as epf_employee,
           l.epf_employer::text as epf_employer,
           l.eps_employer::text as eps_employer,
           l.esi_covered,
           l.esi_employee::text as esi_employee,
           l.esi_employer::text as esi_employer,
           l.professional_tax::text as professional_tax,
           l.tax_regime,
           l.projected_annual_income::text as projected_annual_income,
           l.projected_annual_tax::text as projected_annual_tax,
           l.tds::text as tds,
           l.net_pay::text as net_pay,
           l.payment_request_id,
           p.request_number as payment_request_number,
           p.status as payment_request_status
    from payroll_run_lines l
    left join payment_requests p on p.id = l.payment_request_id
    where l.payroll_run_id = ${runId}
    order by lower(l.employee_code)
  `;

  // Employer-side totals, summed by PostgreSQL. The browser renders
  // them; nothing adds a column of money up in JavaScript.
  const [totals] = await tx<
    {
      epf_employee: string;
      epf_employer: string;
      eps_employer: string;
      esi_employee: string;
      esi_employer: string;
      professional_tax: string;
      tds: string;
    }[]
  >`
    select coalesce(sum(epf_employee), 0)::text as epf_employee,
           coalesce(sum(epf_employer), 0)::text as epf_employer,
           coalesce(sum(eps_employer), 0)::text as eps_employer,
           coalesce(sum(esi_employee), 0)::text as esi_employee,
           coalesce(sum(esi_employer), 0)::text as esi_employer,
           coalesce(sum(professional_tax), 0)::text as professional_tax,
           coalesce(sum(tds), 0)::text as tds
    from payroll_run_lines where payroll_run_id = ${runId}
  `;

  // What the run was computed against, as it stood on its own month.
  // A projection of the run's inputs so a reader — and the practitioner
  // signing the arithmetic off — can see them without a database client.
  const basis = await tx<
    {
      parameter: string;
      value: string;
      effective_from: string;
      notification: string;
    }[]
  >`
    select s.parameter, s.value::text as value,
           s.effective_from::text as effective_from, s.notification
    from payroll_statutory_rates s
    where s.effective_from <= ${row.period_month}::date
      and (s.effective_to is null or s.effective_to >= ${row.period_month}::date)
    order by s.parameter
  `;

  return {
    ...toRunSummary(row),
    lines: lines.map(toRunLine),
    totalEpfEmployee: totals?.epf_employee ?? '0',
    totalEpfEmployer: totals?.epf_employer ?? '0',
    totalEpsEmployer: totals?.eps_employer ?? '0',
    totalEsiEmployee: totals?.esi_employee ?? '0',
    totalEsiEmployer: totals?.esi_employer ?? '0',
    totalProfessionalTax: totals?.professional_tax ?? '0',
    totalTds: totals?.tds ?? '0',
    statutoryBasis: basis.map((entry) => ({
      parameter: entry.parameter,
      value: entry.value,
      effectiveFrom: entry.effective_from,
      notification: entry.notification,
    })),
  };
}

function payrollRunNotFound(): ReturnType<typeof httpError> {
  return httpError(
    404,
    'PAYROLL_RUN_NOT_FOUND',
    'No such payroll run in this organisation.',
  );
}

export function registerHrRoutes(app: AppInstance, auth: Auth, database: Sql): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  // ── The employee register ──────────────────────────────────────────

  tenantRoute(
    {
      method: 'GET',
      url: '/api/employees',
      schema: {
        querystring: withKeysetQuery(EmployeeListQuerySchema),
        response: { 200: EmployeeListResponseSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, organisationId, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        const cursor = await cursorRowId(tx, 'employees', query.cursor);
        const currentOnly = (query.status ?? 'current') === 'current';
        const search = optionalTrimmed(query.search);
        const rows = await tx<EmployeeSummaryRow[]>`
          select ${tx.unsafe(EMPLOYEE_SUMMARY_COLUMNS)}
          from employees e
          join contacts c
            on c.organisation_id = e.organisation_id and c.id = e.contact_id
          where (${!currentOnly} or e.date_of_exit is null)
            and (${search ?? null}::text is null
                 or e.employee_code ilike '%' || ${search ?? null} || '%'
                 or c.designation ilike '%' || ${search ?? null} || '%'
                 or coalesce(e.department, '') ilike '%' || ${search ?? null} || '%')
            and (${cursor}::uuid is null or (e.date_of_joining, e.id) < (
              select k.date_of_joining, k.id from employees k where k.id = ${cursor}))
          order by e.date_of_joining desc, e.id desc
          limit ${sqlLimit(query.limit)}
        `;
        const page = keysetPage(rows, query.limit, (row) => row.id);
        // Register-wide, not the page's: the stat strip counts the whole
        // payroll, and a count taken off a page would fall as the
        // operator paged through it.
        const [counted] = await tx<{ current_count: string }[]>`
          select count(*)::text as current_count
          from employees where date_of_exit is null
        `;
        return {
          employees: page.rows.map(toEmployeeSummary),
          nextCursor: page.nextCursor,
          currentCount: Number(counted?.current_count ?? '0'),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/employees',
      schema: {
        body: CreateEmployeeSchema,
        response: { 201: EmployeeResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'payments',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const created = await tenant(async (tx) => {
        // The party row has to exist, be active, and be marked a person
        // this organisation pays — the same three questions the payments
        // workspace asks of a beneficiary, because the salary requests
        // this employee's payroll raises will be refused otherwise.
        const [contact] = await tx<
          { id: string; active: boolean; is_employee: boolean }[]
        >`
          select id, active, is_employee from contacts where id = ${body.contactId}
        `;
        if (contact === undefined) {
          throw httpError(
            404,
            'CONTACT_NOT_FOUND',
            'No such contact in the master.',
            { field: 'contactId' },
          );
        }
        if (!contact.active) {
          throw httpError(
            409,
            'CONTACT_RETIRED',
            'That contact is retired and cannot be put on the payroll.',
            { field: 'contactId' },
          );
        }
        if (!contact.is_employee) {
          throw httpError(
            400,
            'EMPLOYEE_INVALID',
            'That contact is not marked an employee, so a salary paid to them could never be raised.',
            { field: 'contactId' },
          );
        }

        await assertEmployeeShape(tx, body, null);

        const [row] = await tx<{ id: string }[]>`
          insert into employees (
            organisation_id, contact_id, employee_code, department,
            date_of_joining, date_of_exit, date_of_birth, uan, esic_number,
            pf_covered, pf_wage_basis, esi_applicable,
            professional_tax_state_code, professional_tax_category,
            tax_regime, declared_exempt_allowances_annual,
            declared_chapter_via_annual, basic_monthly,
            dearness_allowance_monthly, house_rent_allowance_monthly,
            other_allowances_monthly, created_by_user_id
          )
          values (
            ${organisationId}, ${body.contactId}, ${body.employeeCode},
            ${body.department ?? null}, ${body.dateOfJoining},
            ${body.dateOfExit ?? null}, ${body.dateOfBirth}, ${body.uan ?? null},
            ${body.esicNumber ?? null}, ${body.pfCovered}, ${body.pfWageBasis},
            ${body.esiApplicable}, ${body.professionalTaxStateCode ?? null},
            ${body.professionalTaxCategory ?? null}, ${body.taxRegime},
            ${body.declaredExemptAllowancesAnnual ?? '0'}::money_amount,
            ${body.declaredChapterViaAnnual ?? '0'}::money_amount,
            ${body.basicMonthly}::money_amount,
            ${body.dearnessAllowanceMonthly ?? '0'}::money_amount,
            ${body.houseRentAllowanceMonthly ?? '0'}::money_amount,
            ${body.otherAllowancesMonthly ?? '0'}::money_amount,
            ${user.id}
          )
          returning id
        `.catch(rethrowEmployeeWriteRefusal);
        if (!row) throw new Error('employee insert returned no row');

        // The audit detail names the person and NOT their pay. An audit
        // trail is read by more people than the payroll screen is, and
        // copying a salary into it would publish it to all of them.
        await audit(tx, organisationId, user.id, 'employee.added', 'employees', row.id, {
          employeeCode: body.employeeCode,
        });
        return loadEmployee(tx, row.id);
      });
      reply.code(201);
      return { employee: created };
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/employees/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: EmployeeResponseSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => ({ employee: await loadEmployee(tx, id) }));
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/employees/:id',
      schema: {
        params: IdParamsSchema,
        body: UpdateEmployeeSchema,
        response: { 200: EmployeeResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // Proves the row exists before the shape check names it, so a
        // guessed id answers 404 rather than a validation message that
        // would confirm the employee is real.
        await loadEmployee(tx, id);
        await assertEmployeeShape(tx, body, id);

        // A salary revision OVERWRITES. The history lives in the
        // finalised runs, which snapshot what they were computed from and
        // are immutable, so nothing already paid moves (migration 0089
        // § 2 records why there is no effective-dated salary table).
        const updated = await tx`
          update employees set
            employee_code = ${body.employeeCode},
            department = ${body.department ?? null},
            date_of_joining = ${body.dateOfJoining},
            date_of_exit = ${body.dateOfExit ?? null},
            date_of_birth = ${body.dateOfBirth},
            uan = ${body.uan ?? null},
            esic_number = ${body.esicNumber ?? null},
            pf_covered = ${body.pfCovered},
            pf_wage_basis = ${body.pfWageBasis},
            esi_applicable = ${body.esiApplicable},
            professional_tax_state_code = ${body.professionalTaxStateCode ?? null},
            professional_tax_category = ${body.professionalTaxCategory ?? null},
            tax_regime = ${body.taxRegime},
            declared_exempt_allowances_annual =
              ${body.declaredExemptAllowancesAnnual ?? '0'}::money_amount,
            declared_chapter_via_annual =
              ${body.declaredChapterViaAnnual ?? '0'}::money_amount,
            basic_monthly = ${body.basicMonthly}::money_amount,
            dearness_allowance_monthly =
              ${body.dearnessAllowanceMonthly ?? '0'}::money_amount,
            house_rent_allowance_monthly =
              ${body.houseRentAllowanceMonthly ?? '0'}::money_amount,
            other_allowances_monthly =
              ${body.otherAllowancesMonthly ?? '0'}::money_amount
          where id = ${id}
          returning id
        `.catch(rethrowEmployeeWriteRefusal);
        if (updated.count === 0) throw employeeNotFound();

        await audit(tx, organisationId, user.id, 'employee.updated', 'employees', id, {
          employeeCode: body.employeeCode,
        });
        return { employee: await loadEmployee(tx, id) };
      });
    },
  );

  // ── The payroll run ────────────────────────────────────────────────

  tenantRoute(
    {
      method: 'GET',
      url: '/api/payroll-runs',
      schema: {
        querystring: KeysetQuerySchema,
        response: { 200: PayrollRunListResponseSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        const cursor = await cursorRowId(tx, 'payroll_runs', query.cursor);
        const rows = await tx<PayrollRunRow[]>`
          ${tx.unsafe(RUN_SELECT)}
          where (${cursor}::uuid is null or (r.period_month, r.id) < (
            select k.period_month, k.id from payroll_runs k where k.id = ${cursor}))
          order by r.period_month desc, r.id desc
          limit ${sqlLimit(query.limit)}
        `;
        const page = keysetPage(rows, query.limit, (row) => row.id);
        return { runs: page.rows.map(toRunSummary), nextCursor: page.nextCursor };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/payroll-runs',
      schema: {
        body: OpenPayrollRunSchema,
        response: { 201: PayrollRunResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'payments',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const created = await tenant(async (tx) => {
        const today = await todayOf(tx, organisationId);
        const periodMonth = firstOfMonth(body.periodMonth);

        // A month is paid after it has begun. Opening next month's run
        // would compute a projection against a salary structure nobody
        // has agreed to yet, and — the sharper problem — it would take
        // the number that this month's run has not claimed.
        if (periodMonth > firstOfMonth(today)) {
          throw httpError(
            400,
            'PAYROLL_PERIOD_INVALID',
            `Payroll for ${periodMonth.slice(0, 7)} cannot be run before the month has begun.`,
            { field: 'periodMonth' },
          );
        }

        const [existing] = await tx<{ run_number: string; status: string }[]>`
          select run_number, status from payroll_runs
          where period_month = ${periodMonth}::date and status <> 'cancelled'
        `;
        if (existing !== undefined) {
          throw httpError(
            409,
            'PAYROLL_RUN_EXISTS',
            `${existing.run_number} already covers ${periodMonth.slice(0, 7)} and is ${existing.status}.`,
          );
        }

        // The financial year comes from the MONTH BEING PAID, not from
        // today: March's payroll run, opened in April, belongs to the
        // year it pays for. The counter is upserted and incremented in
        // one statement, so two operators opening a run at once
        // serialise on the counter row.
        const fyLabel = financialYearLabel(periodMonth);
        const [counter] = await tx<{ sequence_number: number }[]>`
          insert into payroll_run_counters (organisation_id, fy_label, next_value)
          values (${organisationId}, ${fyLabel}, 2)
          on conflict (organisation_id, fy_label) do update
            set next_value = payroll_run_counters.next_value + 1,
                updated_at = now()
          returning (next_value - 1) as sequence_number
        `;
        if (!counter) {
          throw httpError(
            500,
            'PAYROLL_RUN_NUMBER_FAILED',
            'The payroll-run counter did not yield a number.',
          );
        }
        const sequence = Number(counter.sequence_number);
        const runNumber = payrollRunNumber(fyLabel, sequence);

        const [row] = await tx<{ id: string }[]>`
          insert into payroll_runs (
            organisation_id, fy_label, sequence_number, run_number,
            period_month, created_by_user_id
          )
          values (
            ${organisationId}, ${fyLabel}, ${sequence}, ${runNumber},
            ${periodMonth}::date, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('payroll run insert returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'payroll_run.opened',
          'payroll_runs',
          row.id,
          { runNumber, periodMonth },
        );
        return loadRun(tx, organisationId, row.id);
      });
      reply.code(201);
      return { run: created };
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/payroll-runs/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: PayrollRunResponseSchema, ...errorResponses },
      },
      authority: 'payments',
    },
    async ({ request, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => ({ run: await loadRun(tx, organisationId, id) }));
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/payroll-runs/:id/calculate',
      schema: {
        params: IdParamsSchema,
        response: { 200: PayrollRunResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const run = await loadRun(tx, organisationId, id, { lock: true });
        if (run.status !== 'draft') {
          throw httpError(
            409,
            'PAYROLL_RUN_IMMUTABLE',
            `${run.runNumber} is ${run.status} and its figures are settled.`,
          );
        }
        // The whole of the arithmetic, in SQL. Loss-of-pay days already
        // on the run are carried across the rebuild.
        const [result] = await tx<{ written: number }[]>`
          select app_private.calculate_payroll_run(${id}) as written
        `.catch(rethrowWriteRefusal);

        await audit(
          tx,
          organisationId,
          user.id,
          'payroll_run.calculated',
          'payroll_runs',
          id,
          { runNumber: run.runNumber, lines: Number(result?.written ?? 0) },
        );
        return { run: await loadRun(tx, organisationId, id) };
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/payroll-runs/:id/lines/:lineId/loss-of-pay',
      schema: {
        params: Type.Object(
          { id: IdParamsSchema.properties.id, lineId: IdParamsSchema.properties.id },
          { additionalProperties: false },
        ),
        body: SetPayrollLineLopSchema,
        response: { 200: PayrollRunResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id, lineId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const run = await loadRun(tx, organisationId, id, { lock: true });
        if (run.status !== 'draft') {
          throw httpError(
            409,
            'PAYROLL_RUN_IMMUTABLE',
            `${run.runNumber} is ${run.status}; its payslips are a record of what was paid.`,
          );
        }
        const updated = await tx`
          update payroll_run_lines
          set lop_days = ${body.lopDays}::numeric(5,2)
          where id = ${lineId} and payroll_run_id = ${id}
        `.catch(rethrowWriteRefusal);
        if (updated.count === 0) {
          throw httpError(
            404,
            'PAYROLL_LINE_NOT_FOUND',
            'No such payslip on this payroll run.',
          );
        }
        // Recomputed immediately rather than left for the operator to
        // remember: a stated loss of pay that has not been applied is a
        // register showing a net somebody is not going to be paid.
        await tx`select app_private.calculate_payroll_run(${id})`.catch(
          rethrowWriteRefusal,
        );

        await audit(
          tx,
          organisationId,
          user.id,
          'payroll_run.loss_of_pay_recorded',
          'payroll_run_lines',
          lineId,
          { runNumber: run.runNumber, lopDays: body.lopDays },
        );
        return { run: await loadRun(tx, organisationId, id) };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/payroll-runs/:id/finalize',
      schema: {
        params: IdParamsSchema,
        response: { 200: PayrollRunResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const run = await loadRun(tx, organisationId, id, { lock: true });
        if (run.status !== 'draft') {
          throw httpError(
            409,
            'PAYROLL_RUN_STATE_CONFLICT',
            `${run.runNumber} is already ${run.status}.`,
          );
        }
        if (run.calculatedAt === null) {
          throw httpError(
            409,
            'PAYROLL_RUN_NOT_CALCULATED',
            `${run.runNumber} has not been calculated, so there is nothing to finalise.`,
          );
        }
        if (run.lines.length === 0) {
          throw httpError(
            409,
            'PAYROLL_RUN_EMPTY',
            `${run.runNumber} has no employees on it.`,
          );
        }

        // Finalise FIRST, then hand off. The order matters under a retry:
        // the run's own guard refuses a second finalise, so a request
        // that crashed after the update and before the requests cannot
        // reach the handoff twice — and the unique index on
        // payment_request_id refuses a second request per line even if it
        // did.
        const finalized = await tx`
          update payroll_runs
          set status = 'finalized', finalized_at = now(),
              finalized_by_user_id = ${user.id}
          where id = ${id} and status = 'draft'
        `.catch(rethrowWriteRefusal);
        if (finalized.count === 0) {
          throw httpError(
            409,
            'PAYROLL_RUN_STATE_CONFLICT',
            `${run.runNumber} was finalised by somebody else while you were looking at it.`,
          );
        }

        await raiseSalaryPaymentRequests(tx, organisationId, user.id, id);

        await audit(
          tx,
          organisationId,
          user.id,
          'payroll_run.finalized',
          'payroll_runs',
          id,
          {
            runNumber: run.runNumber,
            employees: run.lines.length,
            totalNet: run.totalNet,
          },
        );
        return { run: await loadRun(tx, organisationId, id) };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/payroll-runs/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelPayrollRunSchema,
        response: { 200: PayrollRunResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const run = await loadRun(tx, organisationId, id, { lock: true });
        if (run.status === 'cancelled') {
          throw httpError(
            409,
            'PAYROLL_RUN_STATE_CONFLICT',
            `${run.runNumber} is already cancelled.`,
          );
        }

        // A finalised run has already raised its salary requests, and
        // some of them may have been paid. Cancelling the run cannot
        // unpay them, so it is refused while any request it raised has
        // moved past the decision — the paperwork is chased on the
        // payments register, where the money actually is.
        const [moved] = await tx<{ request_number: string }[]>`
          select p.request_number
          from payroll_run_lines l
          join payment_requests p on p.id = l.payment_request_id
          where l.payroll_run_id = ${id} and p.status <> 'submitted'
          limit 1
        `;
        if (moved !== undefined) {
          throw httpError(
            409,
            'PAYROLL_RUN_STATE_CONFLICT',
            `${moved.request_number} has already been decided on the Payments register, so this run cannot be cancelled. Reject the outstanding salary requests there first.`,
          );
        }

        const cancelled = await tx`
          update payroll_runs
          set status = 'cancelled', cancelled_at = now(),
              cancelled_by_user_id = ${user.id}, cancel_reason = ${body.reason}
          where id = ${id} and status <> 'cancelled'
        `.catch(rethrowWriteRefusal);
        if (cancelled.count === 0) {
          throw httpError(
            409,
            'PAYROLL_RUN_STATE_CONFLICT',
            `${run.runNumber} was cancelled by somebody else while you were looking at it.`,
          );
        }

        await audit(
          tx,
          organisationId,
          user.id,
          'payroll_run.cancelled',
          'payroll_runs',
          id,
          { runNumber: run.runNumber, reason: body.reason },
        );
        return { run: await loadRun(tx, organisationId, id) };
      });
    },
  );
}

/**
 * The handoff: one salary payment request per payslip.
 *
 * The payments workspace already holds the approval, the maker-checker
 * rule, the paid-once guard, the bank reference and the register an
 * accountant reads. This adds none of that; it writes the rows and stops.
 *
 * ONE REQUEST PER EMPLOYEE, not one for the run. Each employee's net goes
 * to their own bank account and is approved and marked paid with its own
 * reference, which is what a salary credit actually is. A single request
 * for the month's total would be one row an accountant could not
 * reconcile against a bank statement of forty credits.
 *
 * A LINE WHOSE NET IS ZERO RAISES NOTHING. An employee on unpaid leave
 * for a whole month is owed nothing, and a payment request for ₹0 would
 * be refused by `payment_requests.amount > 0` anyway — as a bare 23514,
 * from inside a finalise that had already committed the run.
 *
 * IDEMPOTENT: it writes only lines that carry no request yet, so a retried
 * finalise is a no-op rather than a second month's salary.
 */
async function raiseSalaryPaymentRequests(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  runId: string,
): Promise<void> {
  const [run] = await tx<{ run_number: string; period_month: string }[]>`
    select run_number, period_month::text as period_month
    from payroll_runs where id = ${runId}
  `;
  if (!run) throw payrollRunNotFound();

  const lines = await tx<
    { id: string; contact_id: string; employee_name: string; net_pay: string }[]
  >`
    select l.id, e.contact_id, l.employee_name, l.net_pay::text as net_pay
    from payroll_run_lines l
    join employees e
      on e.organisation_id = l.organisation_id and e.id = l.employee_id
    where l.payroll_run_id = ${runId}
      and l.payment_request_id is null
      and l.net_pay > 0
    order by lower(l.employee_code)
  `;

  const fyLabel = financialYearLabel(run.period_month);
  const month = run.period_month.slice(0, 7);

  for (const line of lines) {
    // The same counter and the same number format the payments workspace
    // uses for a hand-raised request, claimed the same way: this module
    // is a caller of that series, not a second one.
    const [counter] = await tx<{ next_value: number }[]>`
      insert into payment_request_counters (organisation_id, fy_label, next_value)
      values (${organisationId}, ${fyLabel}, 2)
      on conflict (organisation_id, fy_label) do update
        set next_value = payment_request_counters.next_value + 1,
            updated_at = now()
      returning
        case when xmax = 0 then 1
             else payment_request_counters.next_value - 1
        end as next_value
    `;
    if (counter === undefined) {
      throw httpError(
        500,
        'PAYMENT_REQUEST_NUMBER_FAILED',
        'The payment-request counter did not yield a number.',
      );
    }
    const sequence = Number(counter.next_value);
    const requestNumber = `PR/${fyLabel}/${String(sequence).padStart(3, '0')}`;

    const [created] = await tx<{ id: string }[]>`
      insert into payment_requests (
        organisation_id, fy_label, sequence_number, request_number,
        kind, work_id, beneficiary_contact_id, beneficiary_snapshot,
        purpose, category, amount, proof_reference, proof_filename,
        status, requested_by_user_id
      )
      select ${organisationId}, ${fyLabel}, ${sequence}, ${requestNumber},
             'salary', null, ${line.contact_id},
             jsonb_build_object(
               'designation', c.designation,
               'contactPerson', c.contact_person,
               'address', c.address
             ),
             ${`Salary for ${month} — ${line.employee_name}`},
             'payroll', ${line.net_pay}::money_amount,
             -- The proof is the payslip, named. There is no file, and
             -- migration 0090 § 4 widened the shape constraint rather
             -- than let this invent one.
             ${run.run_number}, null,
             'submitted', ${userId}
      from contacts c where c.id = ${line.contact_id}
      returning id
    `;
    if (created === undefined) {
      throw httpError(
        500,
        'PAYMENT_REQUEST_CREATE_FAILED',
        'The salary payment request was not written.',
      );
    }

    await tx`
      update payroll_run_lines set payment_request_id = ${created.id}
      where id = ${line.id}
    `;
  }
}

function employeeNotFound(): ReturnType<typeof httpError> {
  return httpError(
    404,
    'EMPLOYEE_NOT_FOUND',
    'No such employee in this organisation.',
  );
}

async function loadEmployee(tx: TransactionSql, id: string): Promise<Employee> {
  const [row] = await tx<EmployeeRow[]>`
    select ${tx.unsafe(EMPLOYEE_DETAIL_COLUMNS)}
    from employees e
    join contacts c
      on c.organisation_id = e.organisation_id and c.id = e.contact_id
    where e.id = ${id}
  `;
  if (!row) throw employeeNotFound();
  return toEmployee(row);
}

/**
 * The shape rules the schema cannot state, refused with a sentence.
 *
 * All three are CHECK constraints as well (migration 0089 § 2), which is
 * where the guarantee lives; this is where the message does. Without it
 * they arrive as a bare 23514, which is a 500.
 */
async function assertEmployeeShape(
  tx: TransactionSql,
  body: {
    readonly employeeCode: string;
    readonly dateOfBirth: string;
    readonly dateOfJoining: string;
    readonly dateOfExit?: string | null;
    readonly professionalTaxStateCode?: string | null;
    readonly professionalTaxCategory?: string | null;
  },
  excludeId: string | null,
): Promise<void> {
  if (
    (body.professionalTaxStateCode ?? null) === null !==
    ((body.professionalTaxCategory ?? null) === null)
  ) {
    throw httpError(
      400,
      'EMPLOYEE_INVALID',
      'A profession-tax State and the arm of its schedule that applies travel together: a schedule cannot be resolved without both.',
      { field: 'professionalTaxStateCode' },
    );
  }
  if (body.dateOfExit != null && body.dateOfExit < body.dateOfJoining) {
    throw httpError(
      400,
      'EMPLOYEE_INVALID',
      'An exit date falls on or after the date of joining.',
      { field: 'dateOfExit' },
    );
  }
  const [tooYoung] = await tx<{ ok: boolean }[]>`
    select (${body.dateOfJoining}::date
            < ${body.dateOfBirth}::date + interval '14 years') as ok
  `;
  if (tooYoung?.ok === true) {
    throw httpError(
      400,
      'EMPLOYEE_INVALID',
      'The date of joining is less than fourteen years after the date of birth.',
      { field: 'dateOfBirth' },
    );
  }

  const [clash] = await tx<{ employee_code: string }[]>`
    select employee_code from employees
    where lower(employee_code) = lower(${body.employeeCode})
      and (${excludeId}::uuid is null or id <> ${excludeId})
    limit 1
  `;
  if (clash !== undefined) {
    throw httpError(
      409,
      'EMPLOYEE_CODE_TAKEN',
      `Another employee already carries the code ${clash.employee_code}.`,
      { field: 'employeeCode' },
    );
  }
}

/** A duplicate employee code or a second employee against one contact
 * both arrive as unique violations when the route's own check lost a
 * race. Which index it was decides which sentence. */
function rethrowEmployeeWriteRefusal(error: unknown): never {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    String(error.code) === '23505'
  ) {
    const constraint =
      'constraint_name' in error ? String(error.constraint_name) : '';
    if (constraint === 'employees_organisation_id_contact_id_key') {
      throw httpError(
        409,
        'EMPLOYEE_CONTACT_TAKEN',
        'That contact is already on the payroll as an employee.',
      );
    }
    throw httpError(
      409,
      'EMPLOYEE_CODE_TAKEN',
      'Another employee claimed that code while this one was being saved.',
    );
  }
  throw error;
}
