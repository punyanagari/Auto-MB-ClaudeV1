import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import {
  SETUP_TIMEOUT_MS,
  adminUrl,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
  dropTemporaryDatabase,
  migrateToHead,
  refused,
  seedTenant,
  type TemporaryDatabase,
  type Tenant,
} from './support/invariant-db.js';

/**
 * The statutory arithmetic, proved to the paisa (migrations 0089, 0090).
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE FIGURES ASSERTED HERE ARE UNVERIFIED AND AWAIT A PRACTITIONER'S
 * SIGN-OFF, on the same footing as the vendor-side TDS table
 * (`docs/PRODUCT.md` § 5.9). What this suite proves is that the product
 * computes what the schedules SAY. Whether the schedules say what the
 * statute says is the chartered accountant's question, and it is a
 * pre-production gate rather than a merge gate.
 * ─────────────────────────────────────────────────────────────────────
 *
 * These are the assertions no route can make. The arithmetic is a
 * plpgsql function running in exact numeric, and every one of the
 * boundaries below is a place where an implementation that looked right
 * is wrong by real money:
 *
 *   * the EPS split, where "employer 3.67% + 8.33%" is only true at or
 *     below the pension ceiling and under-funds every wage above it;
 *   * ESI at the ceiling, where the rule is "not exceeding" and a `>=`
 *     drops a covered employee out of the scheme;
 *   * ESI rounding, which is UP by regulation and where a plain `round`
 *     short-remits by a rupee on half the payroll;
 *   * the Maharashtra profession-tax bands, where the women's exemption
 *     is ₹25,000 and a schedule that ignored it takes ₹200 a month off
 *     somebody who owes nothing;
 *   * February, where Maharashtra collects ₹300 and an annual return
 *     that got ₹200 is ₹100 short.
 *
 * Each is table-driven, so a boundary added later is a row rather than a
 * new test somebody has to remember to write.
 */

const PREFIX = 'auto_mb_payroll_test_';

let admin: Sql;
let database: TemporaryDatabase;
let tenant: Tenant;

/**
 * The schedules, seeded by hand.
 *
 * A tenant created AFTER the migrations ran carries no seed — the same
 * situation `gst-rates.integration.test.ts` sets up and for the same
 * reason. That is right for this suite anyway: what is under test is the
 * arithmetic GIVEN a schedule, so the schedule is an input stated here
 * rather than a fixture inherited from somewhere else.
 */
async function seedSchedules(pool: Sql, organisationId: string): Promise<void> {
  const rates: readonly (readonly [string, string, string, string | null])[] = [
    ['epf_employee_percent', '12', '2014-09-01', null],
    ['epf_employer_total_percent', '12', '2014-09-01', null],
    ['eps_employer_percent', '8.33', '2014-09-01', null],
    ['eps_monthly_wage_ceiling_rupees', '15000', '2014-09-01', null],
    ['epf_monthly_wage_ceiling_rupees', '15000', '2014-09-01', null],
    // BOTH ESI rate periods, because the dated table is the point: a run
    // for June 2019 has to read 1.75% and one for July 0.75%.
    ['esi_employee_percent', '1.75', '2017-01-01', '2019-06-30'],
    ['esi_employee_percent', '0.75', '2019-07-01', null],
    ['esi_employer_percent', '4.75', '2017-01-01', '2019-06-30'],
    ['esi_employer_percent', '3.25', '2019-07-01', null],
    ['esi_monthly_gross_ceiling_rupees', '21000', '2017-01-01', null],
    ['income_tax_cess_percent', '4', '2018-04-01', null],
    ['income_tax_surcharge_floor_rupees', '5000000', '2025-04-01', null],
    ['standard_deduction_old_rupees', '50000', '2025-04-01', null],
    ['standard_deduction_new_rupees', '75000', '2025-04-01', null],
    ['rebate_87a_old_income_limit_rupees', '500000', '2025-04-01', null],
    ['rebate_87a_old_cap_rupees', '12500', '2025-04-01', null],
    ['rebate_87a_new_income_limit_rupees', '1200000', '2025-04-01', null],
    ['rebate_87a_new_cap_rupees', '60000', '2025-04-01', null],
    // A SECOND, EARLIER WINDOW for the income-tax parameters, so a run
    // for a month before the current Finance Act resolves at all. It is
    // what lets the ESI rate-history test below exercise a 2019 month
    // end to end, which is the whole justification for the schedules
    // being dated rows rather than constants.
    ['income_tax_surcharge_floor_rupees', '5000000', '2018-04-01', '2025-03-31'],
    ['standard_deduction_old_rupees', '40000', '2018-04-01', '2025-03-31'],
    ['rebate_87a_old_income_limit_rupees', '350000', '2018-04-01', '2025-03-31'],
    ['rebate_87a_old_cap_rupees', '2500', '2018-04-01', '2025-03-31'],
  ];
  for (const [parameter, value, from, to] of rates) {
    await pool`
      insert into payroll_statutory_rates (
        organisation_id, parameter, value, effective_from, effective_to,
        notification
      )
      values (
        ${organisationId}, ${parameter}, ${value}::numeric(14,4), ${from}::date,
        ${to}::date, 'test fixture'
      )
    `;
  }

  // Maharashtra, as amended in 2023. Bands are [from, to).
  const slabs: readonly (readonly [
    string,
    string,
    string | null,
    string,
    string | null,
  ])[] = [
    ['male', '0', '7500.01', '0', null],
    ['male', '7500.01', '10000.01', '175', null],
    ['male', '10000.01', null, '200', '300'],
    ['female', '0', '25000.01', '0', null],
    ['female', '25000.01', null, '200', '300'],
  ];
  for (const [category, from, to, amount, february] of slabs) {
    await pool`
      insert into professional_tax_slabs (
        organisation_id, state_code, payee_category, effective_from,
        monthly_wage_from, monthly_wage_to, monthly_amount, february_amount,
        notification
      )
      values (
        ${organisationId}, '27', ${category}, '2023-04-01'::date,
        ${from}::numeric(18,2), ${to}::numeric(18,2), ${amount}::numeric(18,2),
        ${february}::numeric(18,2), 'test fixture'
      )
    `;
  }

  const newBands: readonly (readonly [string, string | null, string])[] = [
    ['0', '400000', '0'],
    ['400000', '800000', '5'],
    ['800000', '1200000', '10'],
    ['1200000', '1600000', '15'],
    ['1600000', '2000000', '20'],
    ['2000000', '2400000', '25'],
    ['2400000', null, '30'],
  ];
  for (const category of ['general', 'senior', 'super_senior'] as const) {
    for (const [from, to, rate] of newBands) {
      await pool`
        insert into income_tax_slabs (
          organisation_id, regime, payee_category, effective_from,
          annual_income_from, annual_income_to, rate, notification
        )
        values (
          ${organisationId}, 'new', ${category}, '2025-04-01'::date,
          ${from}::numeric(18,2), ${to}::numeric(18,2), ${rate}::numeric(5,2),
          'test fixture'
        )
      `;
    }
  }
  const oldBands: readonly (readonly [string, string, string | null, string])[] = [
    ['general', '0', '250000', '0'],
    ['general', '250000', '500000', '5'],
    ['general', '500000', '1000000', '20'],
    ['general', '1000000', null, '30'],
    ['senior', '0', '300000', '0'],
    ['senior', '300000', '500000', '5'],
    ['senior', '500000', '1000000', '20'],
    ['senior', '1000000', null, '30'],
    ['super_senior', '0', '500000', '0'],
    ['super_senior', '500000', '1000000', '20'],
    ['super_senior', '1000000', null, '30'],
  ];
  for (const [category, from, to, rate] of oldBands) {
    await pool`
      insert into income_tax_slabs (
        organisation_id, regime, payee_category, effective_from,
        annual_income_from, annual_income_to, rate, notification
      )
      values (
        ${organisationId}, 'old', ${category}, '2025-04-01'::date,
        ${from}::numeric(18,2), ${to}::numeric(18,2), ${rate}::numeric(5,2),
        'test fixture'
      )
    `;
    // The same ladder end-dated into the earlier window. A fixture, not
    // a claim about 2018 law: what it exists to prove is that the
    // resolver picks the window the RUN falls in.
    await pool`
      insert into income_tax_slabs (
        organisation_id, regime, payee_category, effective_from, effective_to,
        annual_income_from, annual_income_to, rate, notification
      )
      values (
        ${organisationId}, 'old', ${category}, '2018-04-01'::date,
        '2025-03-31'::date,
        ${from}::numeric(18,2), ${to}::numeric(18,2), ${rate}::numeric(5,2),
        'test fixture'
      )
    `;
  }
}

/**
 * A calendar year nothing else in the suite touches.
 *
 * EVERY TEST NEEDS ONE, and the reason is structural rather than tidy: a
 * payroll run enumerates every employee employed during its month, so an
 * employee left behind by one test lands on every later test's run and
 * takes its refusals with them. Each test gets a year, its employees are
 * employed for exactly that year, and its runs are months inside it — so
 * the runs are disjoint in both directions without anything being torn
 * down between tests.
 *
 * Starting well past the current date is deliberate too: the route
 * refuses a run for a month that has not begun, the DATABASE does not,
 * and a suite anchored to today would start failing the day the clock
 * passed it.
 */
let yearCounter = 2030;
function nextYear(): number {
  yearCounter += 1;
  return yearCounter;
}

interface EmployeeSpec {
  readonly code: string;
  /** The isolation year from `nextYear()`. The employee is employed for
   * exactly this calendar year, so only runs inside it see them. */
  readonly year: number;
  readonly basic: string;
  readonly da?: string;
  readonly hra?: string;
  readonly other?: string;
  readonly pfCovered?: boolean;
  readonly pfWageBasis?: 'actual' | 'ceiling';
  readonly esiApplicable?: boolean;
  readonly ptCategory?: 'male' | 'female' | null;
  readonly ptStateCode?: string;
  readonly taxRegime?: 'old' | 'new';
  readonly dateOfBirth?: string;
}

let employeeCounter = 0;

/** `PF-2031`. The code is unique per organisation and every fixture
 * outlives its own test, so the isolation year rides in the identifier
 * as well as in the employment window. Tests read a line back by the
 * same function, so neither side hard-codes the joined string. */
function employeeCode(spec: Pick<EmployeeSpec, 'code' | 'year'>): string {
  return `${spec.code}-${String(spec.year)}`;
}

async function createEmployee(spec: EmployeeSpec): Promise<string> {
  employeeCounter += 1;
  const [contact] = await database.pool<{ id: string }[]>`
    insert into contacts (
      organisation_id, designation, pan, is_employee, created_by_user_id
    )
    values (
      ${tenant.organisationId}, ${`Payroll fixture ${String(employeeCounter)}`},
      'ABCPD1234E', true, ${tenant.userId}
    )
    returning id
  `;
  if (!contact) throw new Error('contact seed failed');
  const [row] = await database.pool<{ id: string }[]>`
    insert into employees (
      organisation_id, contact_id, employee_code, date_of_joining,
      date_of_birth, pf_covered, pf_wage_basis, esi_applicable,
      professional_tax_state_code, professional_tax_category, tax_regime,
      basic_monthly, dearness_allowance_monthly, house_rent_allowance_monthly,
      other_allowances_monthly, created_by_user_id
    )
    values (
      ${tenant.organisationId}, ${contact.id}, ${employeeCode(spec)},
      ${`${String(spec.year)}-01-01`}::date,
      ${spec.dateOfBirth ?? '1990-01-01'}::date,
      ${spec.pfCovered ?? true}, ${spec.pfWageBasis ?? 'ceiling'},
      ${spec.esiApplicable ?? true},
      ${spec.ptCategory === null ? null : (spec.ptStateCode ?? '27')},
      ${spec.ptCategory === undefined ? 'male' : spec.ptCategory},
      ${spec.taxRegime ?? 'new'},
      ${spec.basic}::numeric(18,2), ${spec.da ?? '0'}::numeric(18,2),
      ${spec.hra ?? '0'}::numeric(18,2), ${spec.other ?? '0'}::numeric(18,2),
      ${tenant.userId}
    )
    returning id
  `;
  if (!row) throw new Error('employee seed failed');
  // Employed for exactly the isolation year. Set after the insert
  // because the CHECK wants the exit on or after the joining date and
  // this keeps the two literals beside each other.
  await database.pool`
    update employees set date_of_exit = ${`${String(spec.year)}-12-31`}::date
    where id = ${row.id}
  `;
  return row.id;
}

let runCounter = 0;

/** Opens a draft run for a month and answers its id.
 *
 * The number is claimed straight from a counter here rather than through
 * the route's upsert: what this suite is about is the arithmetic and the
 * guards, and `numbering-invariants.integration.test.ts` is what proves
 * the counter itself. */
async function openRun(periodMonth: string): Promise<string> {
  runCounter += 1;
  const fyStartYear =
    Number(periodMonth.slice(5, 7)) >= 4
      ? Number(periodMonth.slice(0, 4))
      : Number(periodMonth.slice(0, 4)) - 1;
  const fyLabel = `${String(fyStartYear)}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`;
  const [run] = await database.pool<{ id: string }[]>`
    insert into payroll_runs (
      organisation_id, fy_label, sequence_number, run_number, period_month,
      created_by_user_id
    )
    values (
      ${tenant.organisationId}, ${fyLabel}, ${runCounter},
      ${`PAY/${fyLabel}/${String(runCounter).padStart(4, '0')}`},
      ${periodMonth}::date, ${tenant.userId}
    )
    returning id
  `;
  if (!run) throw new Error('run seed failed');
  return run.id;
}

/** Opens a run for a month and calculates it, for the tests that expect
 * the calculation to be REFUSED. */
async function calculateFor(periodMonth: string): Promise<unknown> {
  const runId = await openRun(periodMonth);
  return database.pool`select app_private.calculate_payroll_run(${runId})`;
}

/** Opens a run for a month, calculates it, and hands back the lines
 * keyed by employee code. */
async function runMonth(
  periodMonth: string,
): Promise<Record<string, Record<string, string>>> {
  const runId = await openRun(periodMonth);
  await database.pool`select app_private.calculate_payroll_run(${runId})`;
  const lines = await database.pool<Record<string, string>[]>`
    select employee_code,
           gross_earnings::text as gross_earnings,
           pf_wages::text as pf_wages,
           epf_employee::text as epf_employee,
           epf_employer::text as epf_employer,
           eps_employer::text as eps_employer,
           esi_covered::text as esi_covered,
           esi_employee::text as esi_employee,
           esi_employer::text as esi_employer,
           professional_tax::text as professional_tax,
           projected_annual_income::text as projected_annual_income,
           projected_annual_tax::text as projected_annual_tax,
           tds::text as tds,
           net_pay::text as net_pay
    from payroll_run_lines where payroll_run_id = ${runId}
  `;
  return Object.fromEntries(
    lines.map((line) => [line.employee_code ?? '', line]),
  ) as Record<string, Record<string, string>>;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-payroll-admin',
  });
  await admin`select 1 as ready`;
  await dropStaleTemporaryDatabases(admin, PREFIX);
  database = await createTemporaryDatabase(admin, PREFIX);
  await migrateToHead(database);
  tenant = await seedTenant(database.pool);
  await seedSchedules(database.pool, tenant.organisationId);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (database !== undefined) await dropTemporaryDatabase(admin, database);
  await admin?.end();
}, SETUP_TIMEOUT_MS);

describe('provident fund (0090 § 6)', () => {
  /**
   * THE EPS SPLIT, which is the arithmetic most implementations get
   * wrong.
   *
   * The employer contributes 12% of the provident-fund wage. Of that,
   * 8.33% of the wage CAPPED AT THE PENSION CEILING goes to the Pension
   * Scheme and the REMAINDER goes to the fund. Below the ceiling that
   * remainder happens to be 3.67%; above it, it is larger — and an
   * implementation that hard-coded 3.67% would under-fund the provident
   * account of every employee earning more than ₹15,000 of basic.
   */
  const cases: readonly {
    readonly name: string;
    readonly basic: string;
    readonly basis: 'actual' | 'ceiling';
    readonly pfWages: string;
    readonly employee: string;
    readonly eps: string;
    readonly employer: string;
  }[] = [
    {
      name: 'below the ceiling: the remainder IS 3.67%',
      basic: '10000.00',
      basis: 'actual',
      pfWages: '10000.00',
      employee: '1200.00',
      // 8.33% of 10,000 = 833. 12% of 10,000 = 1,200. 1,200 − 833 = 367,
      // which is 3.67% exactly. This is the case the shorthand describes.
      eps: '833.00',
      employer: '367.00',
    },
    {
      name: 'exactly at the ceiling: EPS is its ₹1,250 maximum',
      basic: '15000.00',
      basis: 'actual',
      pfWages: '15000.00',
      employee: '1800.00',
      // 8.33% of 15,000 = 1,249.5, rounded to 1,250 — the figure every
      // Indian payslip carries.
      eps: '1250.00',
      employer: '550.00',
    },
    {
      name: 'above the ceiling on the whole wage: the fund share GROWS',
      basic: '25000.00',
      basis: 'actual',
      pfWages: '25000.00',
      employee: '3000.00',
      // The pension share stays capped at 1,250 while the employer's 12%
      // rises to 3,000, so the fund gets 1,750 — 7% of the wage, not
      // 3.67% of it. A hard-coded 3.67% would have paid 918 and short-
      // funded the account by 832 rupees a month.
      eps: '1250.00',
      employer: '1750.00',
    },
    {
      name: 'above the ceiling, restricted: everything is computed on ₹15,000',
      basic: '25000.00',
      basis: 'ceiling',
      pfWages: '15000.00',
      employee: '1800.00',
      eps: '1250.00',
      employer: '550.00',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const year = nextYear();
      await createEmployee({
        code: 'PF',
        year,
        basic: testCase.basic,
        pfWageBasis: testCase.basis,
        // Out of ESI's reach and out of profession tax's, so the
        // assertion is about the provident fund alone.
        esiApplicable: false,
        ptCategory: null,
      });
      const line = (await runMonth(`${String(year)}-08-01`))[employeeCode({ code: 'PF', year })];
      expect(line).toBeDefined();
      expect(line?.pf_wages).toBe(testCase.pfWages);
      expect(line?.epf_employee).toBe(testCase.employee);
      expect(line?.eps_employer).toBe(testCase.eps);
      expect(line?.epf_employer).toBe(testCase.employer);
      // The identity that has to hold at every wage: the two employer
      // shares are the whole employer contribution and nothing is lost
      // between them. Asserted separately from the three figures above
      // because it is the property, and they are one instance of it.
      expect(
        Number(line?.eps_employer ?? '0') + Number(line?.epf_employer ?? '0'),
      ).toBe(Number(line?.epf_employee ?? '0'));
    });
  }

  it('contributes nothing for an excluded employee', async () => {
    const year = nextYear();
    await createEmployee({
      code: 'PF-EXCLUDED',
      year,
      basic: '40000.00',
      pfCovered: false,
      esiApplicable: false,
      ptCategory: null,
    });
    const line = (await runMonth(`${String(year)}-08-01`))[
      employeeCode({ code: 'PF-EXCLUDED', year })
    ];
    expect(line?.pf_wages).toBe('0.00');
    expect(line?.epf_employee).toBe('0.00');
    expect(line?.eps_employer).toBe('0.00');
  });
});

describe("employees' state insurance (0090 § 6)", () => {
  /**
   * THE CEILING IS "NOT EXCEEDING", so ₹21,000 exactly is covered and
   * ₹21,000.01 is not. The boundary is one rupee wide and it decides
   * whether somebody has medical cover.
   *
   * AND BOTH SHARES ROUND UP. Regulation 40 says so, and it matters: at
   * ₹19,800 the employee's 0.75% is 148.50, which a plain `round` makes
   * 149 by luck and a `floor` would make 148 — a short remittance on
   * every payslip that lands on a half.
   */
  const cases: readonly {
    readonly name: string;
    readonly gross: string;
    readonly covered: boolean;
    readonly employee: string;
    readonly employer: string;
  }[] = [
    {
      name: 'below the ceiling, rounding up from a half rupee',
      gross: '19800.00',
      covered: true,
      // 0.75% of 19,800 = 148.50 → 149. 3.25% = 643.50 → 644.
      employee: '149.00',
      employer: '644.00',
    },
    {
      name: 'exactly at the ceiling: still covered',
      gross: '21000.00',
      covered: true,
      // 157.50 → 158, and 682.50 → 683.
      employee: '158.00',
      employer: '683.00',
    },
    {
      name: 'one paisa above the ceiling: out of the scheme',
      gross: '21000.01',
      covered: false,
      employee: '0.00',
      employer: '0.00',
    },
    {
      name: 'rounding up from a fraction of a paisa',
      gross: '10001.00',
      covered: true,
      // 0.75% of 10,001 = 75.0075 → 76, not 75. Rounding an insurance
      // share down is a short remittance however small the fraction.
      employee: '76.00',
      employer: '326.00',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const year = nextYear();
      await createEmployee({
        code: 'ESI',
        year,
        basic: testCase.gross,
        pfCovered: false,
        ptCategory: null,
      });
      const line = (await runMonth(`${String(year)}-08-01`))[employeeCode({ code: 'ESI', year })];
      expect(line?.esi_covered).toBe(testCase.covered ? 'true' : 'false');
      expect(line?.esi_employee).toBe(testCase.employee);
      expect(line?.esi_employer).toBe(testCase.employer);
    });
  }

  it('reads the rate in force in the run’s own month, not today’s', async () => {
    // THE WHOLE REASON THE SCHEDULES ARE DATED ROWS, and the one test
    // that fails if they ever become constants again.
    //
    // G.S.R. 423(E) moved the employee's share from 1.75% to 0.75% and
    // the employer's from 4.75% to 3.25% on 1 July 2019. June and July
    // of that year are different arithmetic on the same salary, and a
    // constant in a deployed build cannot answer both.
    await createEmployee({
      code: 'ESI-HISTORY',
      year: 2019,
      basic: '20000.00',
      pfCovered: false,
      ptCategory: null,
      // Old regime: the fixture's pre-2025 income-tax window covers the
      // old ladder only, which is what makes a 2019 run resolvable here.
      taxRegime: 'old',
    });

    const june = (await runMonth('2019-06-01'))['ESI-HISTORY-2019'];
    // 1.75% of 20,000 = 350; 4.75% = 950.
    expect(june?.esi_employee).toBe('350.00');
    expect(june?.esi_employer).toBe('950.00');

    const july = (await runMonth('2019-07-01'))['ESI-HISTORY-2019'];
    // 0.75% of 20,000 = 150; 3.25% = 650. One month later, on an
    // unchanged salary, and the deduction more than halves.
    expect(july?.esi_employee).toBe('150.00');
    expect(july?.esi_employer).toBe('650.00');
  });
});

describe('profession tax, Maharashtra (0089 § 4)', () => {
  /**
   * THE BAND EDGES, and the women's exemption that is the reason
   * `employees.professional_tax_category` exists at all.
   *
   * The 2023 amendment put the women's threshold at ₹25,000 a month
   * against the men's ₹7,500. A payroll that read one schedule for
   * everybody would take ₹200 a month off every woman earning between
   * those two figures who owes nothing — which is most of the register at
   * a works contractor.
   */
  const cases: readonly {
    readonly name: string;
    readonly gross: string;
    readonly category: 'male' | 'female';
    readonly august: string;
    readonly february: string;
  }[] = [
    {
      name: 'men, at the exemption edge: ₹7,500 exactly is exempt',
      gross: '7500.00',
      category: 'male',
      august: '0.00',
      february: '0.00',
    },
    {
      name: 'men, one paisa over: the ₹175 band opens',
      gross: '7500.01',
      category: 'male',
      august: '175.00',
      february: '175.00',
    },
    {
      name: 'men, at ₹10,000 exactly: still the ₹175 band',
      gross: '10000.00',
      category: 'male',
      august: '175.00',
      february: '175.00',
    },
    {
      name: 'men, one paisa over ₹10,000: ₹200, and ₹300 in February',
      gross: '10000.01',
      category: 'male',
      august: '200.00',
      february: '300.00',
    },
    {
      name: 'women, at ₹25,000 exactly: exempt where a man would pay ₹200',
      gross: '25000.00',
      category: 'female',
      august: '0.00',
      february: '0.00',
    },
    {
      name: 'women, one paisa over ₹25,000: the schedules converge',
      gross: '25000.01',
      category: 'female',
      august: '200.00',
      february: '300.00',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const year = nextYear();
      await createEmployee({
        code: 'PT',
        year,
        basic: testCase.gross,
        pfCovered: false,
        esiApplicable: false,
        ptCategory: testCase.category,
      });
      const code = employeeCode({ code: 'PT', year });
      const august = await runMonth(`${String(year)}-08-01`);
      expect(august[code]?.professional_tax).toBe(testCase.august);
      // FEBRUARY IS THE ANNUAL TRUE-UP. Maharashtra collects ₹2,500 a
      // year as eleven months of ₹200 and one of ₹300; putting the extra
      // hundred anywhere else leaves the annual return short.
      const february = await runMonth(`${String(year)}-02-01`);
      expect(february[code]?.professional_tax).toBe(testCase.february);
    });
  }

  it('refuses by name when no band of the employee’s State covers the wage', async () => {
    // Not "deduct nothing" — an organisation in a State whose schedule
    // nobody has recorded must be TOLD, not silently under-deducted. The
    // seed carries Maharashtra only, and every other State reaches this.
    const year = nextYear();
    await createEmployee({
      code: 'PT-UNCOVERED',
      year,
      basic: '30000.00',
      pfCovered: false,
      esiApplicable: false,
      ptCategory: 'male',
      ptStateCode: '29',
    });
    const failure = await refused(calculateFor(`${String(year)}-08-01`));
    expect(failure.code).toBe('23H01');
    expect(failure.message).toContain('29');
  });
});

describe('the golden run, to the paisa (0090 § 6)', () => {
  /**
   * One month, one employee, every head at once, every figure asserted.
   *
   * The boundary tests above each hold one variable still. This is the
   * one that would catch an error in how they COMBINE — a provident-fund
   * wage built from the wrong heads, a net that subtracted an employer
   * contribution, a profession tax left out of the old regime's section
   * 16(iii) deduction.
   */
  it('computes every figure of an ordinary August payslip', async () => {
    const year = nextYear();
    await createEmployee({
      code: 'GOLDEN',
      // 20,000 basic + 2,000 DA = 22,000 provident-fund wage, restricted
      // to the ₹15,000 ceiling. Gross 40,000, which is above the ESI
      // ceiling and into Maharashtra's ₹200 band.
      basic: '20000.00',
      da: '2000.00',
      hra: '10000.00',
      other: '8000.00',
      pfWageBasis: 'ceiling',
      ptCategory: 'male',
      taxRegime: 'new',
      year,
    });
    const line = (await runMonth(`${String(year)}-08-01`))[employeeCode({ code: 'GOLDEN', year })];
    expect(line).toBeDefined();

    expect(line?.gross_earnings).toBe('40000.00');
    // Basic plus dearness allowance is the provident-fund wage — house
    // rent and other allowances are NOT in it — capped at ₹15,000.
    expect(line?.pf_wages).toBe('15000.00');
    expect(line?.epf_employee).toBe('1800.00');
    expect(line?.eps_employer).toBe('1250.00');
    expect(line?.epf_employer).toBe('550.00');
    // 40,000 is above the ₹21,000 ceiling.
    expect(line?.esi_covered).toBe('false');
    expect(line?.esi_employee).toBe('0.00');
    expect(line?.professional_tax).toBe('200.00');

    // August is the fifth month of the financial year, so eight months
    // remain including it: 40,000 × 8 = 3,20,000 projected.
    expect(line?.projected_annual_income).toBe('320000.00');
    // New regime: 3,20,000 − 75,000 standard deduction = 2,45,000 total
    // income, entirely inside the nil band, so nothing is due and the
    // section 87A rebate is not even reached.
    expect(line?.projected_annual_tax).toBe('0.00');
    expect(line?.tds).toBe('0.00');

    // THE NET IS THE GROSS LESS THE FOUR EMPLOYEE-SIDE HEADS AND NOTHING
    // ELSE. The employer's ₹1,800 of provident fund is a cost to the
    // organisation, and a payslip that took it off the employee is the
    // mistake the CHECK constraint exists to make impossible.
    expect(line?.net_pay).toBe('38000.00');
  });

  it('deducts income tax once the projection reaches the slabs', async () => {
    const year = nextYear();
    await createEmployee({
      code: 'GOLDEN-TAX',
      year,
      basic: '100000.00',
      hra: '50000.00',
      pfWageBasis: 'ceiling',
      ptCategory: null,
      esiApplicable: false,
      taxRegime: 'new',
    });
    const line = (await runMonth(`${String(year)}-08-01`))[employeeCode({ code: 'GOLDEN-TAX', year })];
    // 1,50,000 × 8 = 12,00,000 projected, less the ₹75,000 standard
    // deduction = 11,25,000 total income.
    expect(line?.projected_annual_income).toBe('1200000.00');
    // Slabs: nil to 4,00,000; 5% of the next 4,00,000 = 20,000; 10% of
    // 3,25,000 = 32,500. Tax before rebate 52,500. Total income is under
    // the ₹12,00,000 rebate limit, so section 87A wipes all of it out —
    // the rebate cap is ₹60,000 and the tax is less than that.
    expect(line?.projected_annual_tax).toBe('0.00');
    expect(line?.tds).toBe('0.00');
  });

  it('applies the slabs, the cess and section 288B above the rebate limit', async () => {
    const year = nextYear();
    await createEmployee({
      code: 'GOLDEN-CESS',
      year,
      basic: '200000.00',
      hra: '100000.00',
      pfWageBasis: 'ceiling',
      ptCategory: null,
      esiApplicable: false,
      taxRegime: 'new',
    });
    const line = (await runMonth(`${String(year)}-08-01`))[employeeCode({ code: 'GOLDEN-CESS', year })];
    // 3,00,000 × 8 = 24,00,000 projected, less 75,000 = 23,25,000.
    expect(line?.projected_annual_income).toBe('2400000.00');
    // 4-8L @5% = 20,000; 8-12L @10% = 40,000; 12-16L @15% = 60,000;
    // 16-20L @20% = 80,000; 20-23.25L @25% = 81,250. Total 2,81,250.
    // Above the rebate limit, so no rebate and no marginal relief bites
    // (the income is far past the crossing band). Cess at 4% takes it to
    // 2,92,500, which is already a multiple of ten.
    expect(line?.projected_annual_tax).toBe('292500.00');
    // Eight months remain, nothing deducted yet: 2,92,500 / 8 = 36,562.5,
    // rounded to the nearest rupee.
    expect(line?.tds).toBe('36563.00');
  });

  it('refuses an employee the surcharge reaches rather than under-deducting', async () => {
    const year = nextYear();
    await createEmployee({
      code: 'SURCHARGE',
      year,
      basic: '900000.00',
      pfCovered: false,
      esiApplicable: false,
      ptCategory: null,
      taxRegime: 'new',
    });
    const failure = await refused(calculateFor(`${String(year)}-08-01`));
    expect(failure.code).toBe('23H05');
    expect(failure.message).toContain(employeeCode({ code: 'SURCHARGE', year }));
  });
});

describe('the run as an issued document (0090 § 7)', () => {
  it('refuses to change a payslip once the run is finalised', async () => {
    const year = nextYear();
    const employeeId = await createEmployee({
      code: 'IMMUTABLE',
      year,
      basic: '30000.00',
      pfCovered: false,
      esiApplicable: false,
      ptCategory: null,
    });
    const runId = await openRun(`${String(year)}-09-01`);
    await database.pool`select app_private.calculate_payroll_run(${runId})`;
    await database.pool`
      update payroll_runs
      set status = 'finalized', finalized_at = now(),
          finalized_by_user_id = ${tenant.userId}
      where id = ${runId}
    `;

    const edited = await refused(database.pool`
      update payroll_run_lines set net_pay = 1.00
      where payroll_run_id = ${runId} and employee_id = ${employeeId}
    `);
    expect(edited.code).toBe('23H02');

    const deleted = await refused(database.pool`
      delete from payroll_run_lines where payroll_run_id = ${runId}
    `);
    expect(deleted.code).toBe('23H02');

    const recalculated = await refused(
      database.pool`select app_private.calculate_payroll_run(${runId})`,
    );
    expect(recalculated.code).toBe('23H02');

    const reopened = await refused(database.pool`
      update payroll_runs set status = 'draft' where id = ${runId}
    `);
    expect(reopened.code).toBe('23H03');
  });

  it('keeps a cancelled run’s number and lets the month run again', async () => {
    const year = nextYear();
    const month = `${String(year)}-10-01`;
    const first = await openRun(month);
    const [numbered] = await database.pool<{ run_number: string }[]>`
      select run_number from payroll_runs where id = ${first}
    `;
    await database.pool`
      update payroll_runs
      set status = 'cancelled', cancelled_at = now(),
          cancelled_by_user_id = ${tenant.userId},
          cancel_reason = 'opened against the wrong month'
      where id = ${first}
    `;

    // The month is free again — cancelling is what makes re-running it
    // possible...
    const second = await openRun(month);
    expect(second).not.toBe(first);

    // ...the cancelled run keeps its own number forever...
    const [kept] = await database.pool<{ run_number: string }[]>`
      select run_number from payroll_runs where id = ${first}
    `;
    expect(kept?.run_number).toBe(numbered?.run_number);

    // ...and a second LIVE run for one month is impossible rather than
    // merely refused: the partial unique index, not a check somebody
    // remembered to write.
    const third = await refused(openRun(month));
    expect(third.code).toBe('23505');
  });
});
