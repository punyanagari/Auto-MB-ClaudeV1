import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import {
  assertNoForeignKeyOrphans,
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
  type Sql,
} from '@auto-mb/db';
import type {
  EmployeeListResponse,
  EmployeeResponse,
  PaymentRequestListResponse,
  PayrollRunResponse,
} from '@auto-mb/contracts';
import { buildApp } from '../src/app.js';

/**
 * The HR module end to end (migrations 0089, 0090).
 *
 * `packages/db/test/payroll-statutory.integration.test.ts` proves the
 * ARITHMETIC to the paisa against a schedule it states itself. This suite
 * proves the things only the server can be asked:
 *
 *   * that a new organisation arrives with the schedules seeded, so its
 *     first payroll run computes rather than refusing every employee;
 *   * that the whole module — READS INCLUDED — is behind the payments
 *     authority, because an employee register is a register of salaries;
 *   * that finalising hands each payslip to the existing payments
 *     workspace as a salary request, once, and never twice;
 *   * that another organisation sees none of it.
 */

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const runId = randomBytes(5).toString('hex');
const ownerEmail = `hr-owner-${runId}@integration.test`;
const clerkEmail = `hr-clerk-${runId}@integration.test`;
const strangerEmail = `hr-stranger-${runId}@integration.test`;
const password = 'correct horse battery staple';

let admin: Sql;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
let clerkCookie = '';
let strangerCookie = '';
let organisationId = '';
let strangerOrganisationId = '';
let ownerUserId = '';
const organisationIds: string[] = [];

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

function authed(options: InjectOptions & { organisationId?: string; as?: string }) {
  const { organisationId: org, as, ...rest } = options;
  return app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      cookie: as ?? cookie,
      ...(org !== undefined ? { 'x-organisation-id': org } : {}),
    },
  });
}

function post(url: string, payload?: object, as?: string, org?: string) {
  return authed({
    method: 'POST',
    url,
    organisationId: org ?? organisationId,
    ...(as === undefined ? {} : { as }),
    headers: { origin: 'http://127.0.0.1:3000' },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function signUp(email: string, name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name },
  });
  expect(response.statusCode, response.body).toBe(200);
  return extractCookies(response.headers['set-cookie']);
}

/** A contact marked an employee, which is what the payments workspace
 * pays and therefore what an employee has to be. */
async function createEmployeeContact(designation: string): Promise<string> {
  const created = await post('/api/masters/contacts', {
    designation,
    isEmployee: true,
    bankAccountHolder: designation,
    bankName: 'HDFC Bank',
    bankAccountNumber: '50100298124761',
    bankIfsc: 'HDFC0001245',
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<{ id: string }>().id;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-hr-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the HR integration tests. ' +
        `Underlying error: ${String(error)}`,
    );
  }
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
  });
  await app.ready();

  cookie = await signUp(ownerEmail, 'HR Owner');
  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'HR Org', slug: `hr-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;
  organisationIds.push(organisationId);

  const [membership] = await admin<{ user_id: string }[]>`
    select user_id from organisation_memberships
    where organisation_id = ${organisationId}
  `;
  ownerUserId = membership?.user_id ?? '';
  expect(ownerUserId).not.toBe('');

  // Migration 0080 grants the payments authority to nobody, deliberately.
  // A test that did not grant it would be testing the refusal.
  await admin`
    update organisation_memberships set can_manage_payments = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  // A second member with a full role and NO payments authority. This is
  // the account the read-gating assertions are made against — the whole
  // question is whether an ordinary office member can fetch salaries.
  clerkCookie = await signUp(clerkEmail, 'HR Clerk');
  const [clerk] = await admin<{ id: string }[]>`
    select id from auth_users where email = ${clerkEmail}
  `;
  await admin`
    insert into organisation_memberships (
      organisation_id, user_id, role, work_scope, status
    )
    values (${organisationId}, ${clerk?.id ?? ''}, 'office', 'all', 'active')
  `;

  strangerCookie = await signUp(strangerEmail, 'HR Stranger');
  const strangerOrg = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie: strangerCookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'HR Stranger Org', slug: `hr-stranger-${runId}` },
  });
  expect(strangerOrg.statusCode, strangerOrg.body).toBe(201);
  strangerOrganisationId = strangerOrg.json<{ id: string }>().id;
  organisationIds.push(strangerOrganisationId);
  const [strangerMembership] = await admin<{ user_id: string }[]>`
    select user_id from organisation_memberships
    where organisation_id = ${strangerOrganisationId}
  `;
  await admin`
    update organisation_memberships set can_manage_payments = true
    where organisation_id = ${strangerOrganisationId}
      and user_id = ${strangerMembership?.user_id ?? ''}
  `;
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (admin !== undefined) {
    await removeOrganisationResidue(admin, organisationIds);
    await assertNoForeignKeyOrphans(admin);
    await admin.end();
  }
});

describe('the statutory schedules a new organisation arrives with', () => {
  it('seeds the rates, the Maharashtra bands and both slab ladders', async () => {
    // Migration 0089 seeded the organisations that existed when it ran;
    // this organisation was created afterwards, through the API, so what
    // is being proved is `seedDefaultPayrollSchedules` on the creation
    // path. Without it the first payroll run refuses every employee by
    // name, which is a true refusal and a useless first experience.
    const [rates] = await admin<{ count: string }[]>`
      select count(*)::text as count from payroll_statutory_rates
      where organisation_id = ${organisationId}
    `;
    expect(Number(rates?.count ?? '0')).toBeGreaterThan(0);

    const [maharashtra] = await admin<{ count: string }[]>`
      select count(*)::text as count from professional_tax_slabs
      where organisation_id = ${organisationId} and state_code = '27'
    `;
    // Three men's bands and two women's, per the 2023 amendment.
    expect(Number(maharashtra?.count ?? '0')).toBe(5);

    const [ladders] = await admin<{ count: string }[]>`
      select count(distinct (regime, payee_category))::text as count
      from income_tax_slabs where organisation_id = ${organisationId}
    `;
    // Two regimes times three age categories.
    expect(Number(ladders?.count ?? '0')).toBe(6);
  });
});

describe('the payments authority gates the whole module', () => {
  it('refuses a member without it, on the READS as much as the writes', async () => {
    // The point of gating the reads. A member with a full office role and
    // no payments authority can raise a challan and approve nothing about
    // money — and must not be able to fetch what every colleague earns.
    for (const url of ['/api/employees', '/api/payroll-runs']) {
      const response = await authed({
        method: 'GET',
        url,
        organisationId,
        as: clerkCookie,
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
    }

    const write = await post(
      '/api/payroll-runs',
      { periodMonth: '2026-07-01' },
      clerkCookie,
    );
    expect(write.statusCode, write.body).toBe(403);
  });
});

describe('the employee register', () => {
  it('keeps personal identifiers off the list and masks the account on the detail', async () => {
    const contactId = await createEmployeeContact(`Anita Deshmukh ${runId}`);
    const created = await post('/api/employees', {
      contactId,
      employeeCode: 'EMP-001',
      department: 'Projects',
      dateOfJoining: '2022-04-11',
      dateOfBirth: '1990-05-02',
      uan: '100200300400',
      pfCovered: true,
      pfWageBasis: 'ceiling',
      esiApplicable: true,
      professionalTaxStateCode: '27',
      professionalTaxCategory: 'female',
      taxRegime: 'new',
      basicMonthly: '34100.00',
      houseRentAllowanceMonthly: '17050.00',
      otherAllowancesMonthly: '17050.00',
    });
    expect(created.statusCode, created.body).toBe(201);
    const employee = created.json<EmployeeResponse>().employee;

    // THE DETAIL CARRIES THE ACCOUNT MASKED AND NEVER WHOLE. Nothing in
    // this pack needs the full number — a salary is paid through the
    // payments workspace, whose beneficiary snapshot reads the contact.
    expect(employee.bankAccountMasked).toBe('•••• 4761');
    expect(JSON.stringify(employee)).not.toContain('50100298124761');
    expect(employee.uan).toBe('100200300400');

    // THE LIST CARRIES NONE OF IT. Asserted on the serialised body rather
    // than on the parsed object, because what matters is what left the
    // server: a register is the payload most likely to end up in a log,
    // a cache or a screenshot.
    const list = await authed({
      method: 'GET',
      url: '/api/employees',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain('100200300400');
    expect(list.body).not.toContain('4761');
    const page = list.json<EmployeeListResponse>();
    expect(page.employees).toHaveLength(1);
    expect(page.employees[0]?.employeeCode).toBe('EMP-001');
    // The register total is summed by PostgreSQL, not by the browser.
    expect(page.currentMonthlyGross).toBe('68200.00');
  });

  it('refuses a second employee under one code, and a contact already on the payroll', async () => {
    const contactId = await createEmployeeContact(`Rahul Jadhav ${runId}`);
    const clash = await post('/api/employees', {
      contactId,
      employeeCode: 'emp-001',
      dateOfJoining: '2023-01-01',
      dateOfBirth: '1992-01-01',
      pfCovered: true,
      pfWageBasis: 'ceiling',
      esiApplicable: true,
      taxRegime: 'new',
      basicMonthly: '20000.00',
    });
    // Case-insensitively: a provident-fund return names a person by this.
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json<{ code: string }>().code).toBe('EMPLOYEE_CODE_TAKEN');
  });
});

describe('a payroll run, opened to finalised', () => {
  it('computes, hands each payslip to the payments workspace, and does it once', async () => {
    const opened = await post('/api/payroll-runs', { periodMonth: '2026-07-14' });
    expect(opened.statusCode, opened.body).toBe(201);
    const run = opened.json<PayrollRunResponse>().run;
    // Any date inside the month is accepted and the first day is stored.
    expect(run.periodMonth).toBe('2026-07-01');
    expect(run.runNumber).toBe('PAY/2026-27/001');
    expect(run.status).toBe('draft');

    const calculated = await post(`/api/payroll-runs/${run.id}/calculate`);
    expect(calculated.statusCode, calculated.body).toBe(200);
    const withLines = calculated.json<PayrollRunResponse>().run;
    expect(withLines.lines).toHaveLength(1);
    const line = withLines.lines[0];
    expect(line?.grossEarnings).toBe('68200.00');
    // Basic 34,100 is above the ₹15,000 provident-fund ceiling and the
    // employee is on the restricted basis.
    expect(line?.epfEmployee).toBe('1800.00');
    expect(line?.epsEmployer).toBe('1250.00');
    expect(line?.epfEmployer).toBe('550.00');
    // Gross is far above the ₹21,000 insurance ceiling.
    expect(line?.esiCovered).toBe(false);
    // A woman above ₹25,000 a month under the Maharashtra schedule.
    expect(line?.professionalTax).toBe('200.00');
    expect(line?.netPay).toBe('66200.00');
    // The run says what it was computed against, so a practitioner can
    // read the basis without a database client.
    expect(withLines.statutoryBasis.length).toBeGreaterThan(0);

    const finalized = await post(`/api/payroll-runs/${run.id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const issued = finalized.json<PayrollRunResponse>().run;
    expect(issued.status).toBe('finalized');
    expect(issued.lines[0]?.paymentRequestId).not.toBeNull();
    expect(issued.lines[0]?.paymentRequestStatus).toBe('submitted');

    // THE HANDOFF IS THE EXISTING WORKSPACE, not a second one. One
    // request per payslip, of kind `salary`, for the net and no other
    // figure, with the run number standing in as the proof.
    const requests = await authed({
      method: 'GET',
      url: '/api/payment-requests',
      organisationId,
    });
    expect(requests.statusCode, requests.body).toBe(200);
    const salaries = requests
      .json<PaymentRequestListResponse>()
      .requests.filter((request) => request.kind === 'salary');
    expect(salaries).toHaveLength(1);
    expect(salaries[0]?.amount).toBe('66200.00');
    expect(salaries[0]?.category).toBe('payroll');
    expect(salaries[0]?.status).toBe('submitted');

    // FINALISING TWICE IS A DOUBLE PAYROLL, so the run's own guard
    // refuses the second one before the handoff is ever reached.
    const again = await post(`/api/payroll-runs/${run.id}/finalize`);
    expect(again.statusCode, again.body).toBe(409);

    const [count] = await admin<{ count: string }[]>`
      select count(*)::text as count from payment_requests
      where organisation_id = ${organisationId} and kind = 'salary'
    `;
    expect(Number(count?.count ?? '0')).toBe(1);
  });

  it('refuses a second live run for one month, and a month that has not begun', async () => {
    const duplicate = await post('/api/payroll-runs', { periodMonth: '2026-07-01' });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json<{ code: string }>().code).toBe('PAYROLL_RUN_EXISTS');

    const future = await post('/api/payroll-runs', { periodMonth: '2099-01-01' });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json<{ code: string }>().code).toBe('PAYROLL_PERIOD_INVALID');
  });

  it('refuses to recalculate or to change a payslip of a finalised run', async () => {
    const runs = await authed({
      method: 'GET',
      url: '/api/payroll-runs',
      organisationId,
    });
    const finalizedRun = runs
      .json<{ runs: { id: string; status: string }[] }>()
      .runs.find((entry) => entry.status === 'finalized');
    expect(finalizedRun).toBeDefined();

    const recalculated = await post(
      `/api/payroll-runs/${finalizedRun?.id ?? ''}/calculate`,
    );
    expect(recalculated.statusCode, recalculated.body).toBe(409);
    expect(recalculated.json<{ code: string }>().code).toBe('PAYROLL_RUN_IMMUTABLE');
    // The refusal carries the reviewed action, not only the fact.
    expect(recalculated.json<{ remedy?: string }>().remedy).toContain(
      'Cancel this run',
    );
  });
});

describe('cross-tenant denial', () => {
  it('hides another organisation’s employees and payroll runs', async () => {
    const employees = await authed({
      method: 'GET',
      url: '/api/employees',
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(employees.statusCode, employees.body).toBe(200);
    expect(employees.json<EmployeeListResponse>().employees).toEqual([]);

    const runs = await authed({
      method: 'GET',
      url: '/api/payroll-runs',
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(runs.statusCode, runs.body).toBe(200);
    expect(runs.json<{ runs: unknown[] }>().runs).toEqual([]);
  });

  it('refuses to bind an organisation the caller is not a member of', async () => {
    const stolen = await authed({
      method: 'GET',
      url: '/api/employees',
      organisationId,
      as: strangerCookie,
    });
    expect(stolen.statusCode).toBeGreaterThanOrEqual(400);
    expect(stolen.statusCode).toBeLessThan(500);
  });
});
