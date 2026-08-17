import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  PaymentRequest,
  PaymentRequestListResponse,
  TdsPreviewResponse,
  VendorInvoice,
  VendorLedgerResponse,
  VendorPayment,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * The payments workspace: money going out.
 *
 * Three properties this suite exists to hold, because each of them is a
 * way the register could be quietly wrong about money:
 *
 *   1. Exactness. Every amount travels as a decimal string and is split
 *      by PostgreSQL. A TDS figure that comes back `1199.9999999999998`
 *      has been through a JavaScript float somewhere, and the assertions
 *      below are written to fail loudly if it ever does.
 *   2. The invoice is consumed by the GROSS, not the net. Tax withheld is
 *      money the vendor has been credited with, and treating it as unpaid
 *      would leave every invoice permanently short by its own TDS.
 *   3. The advance gate. A beneficiary with a paid advance whose bills
 *      are not recorded cannot be given another one — enforced by index,
 *      and refused by name in the route.
 *
 * Cross-tenant denial is proved on every surface the pack adds, because
 * a payments module is exactly the thing worth reaching across a tenant
 * boundary for.
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
const ownerEmail = `pay-owner-${runId}@integration.test`;
const clerkEmail = `pay-clerk-${runId}@integration.test`;
const strangerEmail = `pay-stranger-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let organisationId: string;
let strangerOrganisationId: string;
let cookie: string;
let clerkCookie: string;
let strangerCookie: string;
let ownerUserId: string;
let clerkUserId: string;

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

/** The TDS preview is a POST: the amount is a rupee figure about a
 * named vendor and a query string is the one place logs keep it. */
function previewTds(invoiceId: string, grossAmount: string, paidOn: string) {
  return post(`/api/vendor-invoices/${invoiceId}/tds-preview`, {
    grossAmount,
    paidOn,
  });
}

function post(url: string, payload: object, as?: string, org?: string) {
  return authed({
    method: 'POST',
    url,
    organisationId: org ?? organisationId,
    ...(as === undefined ? {} : { as }),
    headers: { origin: 'http://127.0.0.1:3000' },
    payload,
  });
}

/** A payable party in the shared contacts master. */
async function seedContact(
  label: string,
  roles: { vendor?: boolean; employee?: boolean },
  options: { gstin?: string | null; pan?: string | null; org?: string } = {},
): Promise<string> {
  const id = randomUUID();
  // `pan` defaults to the GSTIN-derived value, which is exactly what
  // migration 0080's backfill writes — so a fixture that names only a
  // GSTIN behaves like a contact that predates the column.
  const derived =
    options.gstin != null &&
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(options.gstin)
      ? options.gstin.slice(2, 12)
      : null;
  await admin`
    insert into contacts (
      id, organisation_id, designation, gstin, pan, is_vendor, is_employee,
      created_by_user_id
    )
    values (
      ${id}, ${options.org ?? organisationId}, ${`${label} ${runId}`},
      ${options.gstin ?? null}, ${options.pan === undefined ? derived : options.pan},
      ${roles.vendor ?? false},
      ${roles.employee ?? false}, ${ownerUserId}
    )
  `;
  return id;
}

/**
 * A vendor whose GSTIN carries a PAN, so section 206AA does NOT apply.
 * Characters 3-12 of a GSTIN are the holder's PAN, which is what
 * migration 0080 backfills `contacts.pan` from.
 */
const PAN_BEARING_GSTIN = '27AAECN2222D1Z7';

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-payments-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the payments integration tests. ' +
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

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: ownerEmail, password, name: 'Payments Owner' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  cookie = extractCookies(signUp.headers['set-cookie']);

  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'Payments Org', slug: `pay-org-${runId}` },
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

  // The owner needs the payments authority: migration 0080 grants it to
  // nobody, deliberately, so a test that did not grant it would be
  // testing the refusal rather than the feature.
  await admin`
    update organisation_memberships set can_manage_payments = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  // A second member WITHOUT the payments authority, who raises requests
  // but may not decide them. Also the proof that a request is decided by
  // someone other than the person who raised it.
  const clerkSignUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: clerkEmail, password, name: 'Site Clerk' },
  });
  expect(clerkSignUp.statusCode, clerkSignUp.body).toBe(200);
  clerkCookie = extractCookies(clerkSignUp.headers['set-cookie']);
  const [clerkAccount] = await admin<{ id: string }[]>`
    select id from auth_users where email = ${clerkEmail}
  `;
  clerkUserId = clerkAccount?.id ?? '';
  expect(clerkUserId).not.toBe('');
  await admin`
    insert into organisation_memberships (
      organisation_id, user_id, role, work_scope, status
    )
    values (${organisationId}, ${clerkUserId}, 'office', 'all', 'active')
  `;

  const strangerSignUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: strangerEmail, password, name: 'Stranger' },
  });
  expect(strangerSignUp.statusCode, strangerSignUp.body).toBe(200);
  strangerCookie = extractCookies(strangerSignUp.headers['set-cookie']);
  const strangerOrg = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie: strangerCookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'Stranger Org', slug: `pay-stranger-${runId}` },
  });
  expect(strangerOrg.statusCode, strangerOrg.body).toBe(201);
  strangerOrganisationId = strangerOrg.json<{ id: string }>().id;
  organisationIds.push(strangerOrganisationId);
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (admin !== undefined) {
    await removeOrganisationResidue(admin, organisationIds);
    await assertNoForeignKeyOrphans(admin);
    await admin.end();
  }
});

// ── Employee requests ─────────────────────────────────────────────────

describe('employee advances and reimbursements', () => {
  it('carries a request from submission through approval to payment', async () => {
    const employee = await seedContact('Kulkarni', { employee: true });
    const created = await post(
      '/api/payment-requests',
      {
        kind: 'reimbursement',
        beneficiaryContactId: employee,
        purpose: 'Inspection travel expenses',
        category: 'travel',
        amount: '18760.00',
        proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
        proofFilename: 'Expense-bills.pdf',
      },
      clerkCookie,
    );
    expect(created.statusCode, created.body).toBe(201);
    const request = created.json<PaymentRequest>();
    expect(request.status).toBe('submitted');
    expect(request.amount).toBe('18760.00');
    expect(request.requestNumber).toMatch(/^PR\/\d{4}-\d{2}\/\d{3}$/);

    const approved = await post(`/api/payment-requests/${request.id}/decision`, {
      decision: 'approve',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<PaymentRequest>().status).toBe('approved');

    const paid = await post(`/api/payment-requests/${request.id}/payment`, {
      reference: 'UTR882104',
      paidOn: '2026-08-14',
    });
    expect(paid.statusCode, paid.body).toBe(200);
    // A reimbursement arrives WITH its bills, so paying it settles it in
    // the same act — it never sits in the open-advance state.
    expect(paid.json<PaymentRequest>().status).toBe('settled');
    expect(paid.json<PaymentRequest>().billsDue).toBe(false);
  });

  it('refuses to let the person who raised a request decide it', async () => {
    const employee = await seedContact('SelfDecider', { employee: true });
    const created = await post(
      '/api/payment-requests',
      {
        kind: 'reimbursement',
        beneficiaryContactId: employee,
        purpose: 'Own claim',
        category: 'general',
        amount: '100.00',
        proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
        proofFilename: 'own.pdf',
      },
      // Raised by the OWNER, who also holds the payments authority.
      undefined,
    );
    expect(created.statusCode, created.body).toBe(201);
    const decision = await post(
      `/api/payment-requests/${created.json<PaymentRequest>().id}/decision`,
      { decision: 'approve' },
    );
    expect(decision.statusCode).toBe(409);
    expect(decision.json<{ code: string }>().code).toBe(
      'PAYMENT_REQUEST_SELF_DECISION',
    );
  });

  it('requires a note to reject, and keeps it on the record', async () => {
    const employee = await seedContact('Rejected', { employee: true });
    const created = await post(
      '/api/payment-requests',
      {
        kind: 'reimbursement',
        beneficiaryContactId: employee,
        purpose: 'Unsupported claim',
        category: 'general',
        amount: '500.00',
        proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
        proofFilename: 'claim.pdf',
      },
      clerkCookie,
    );
    const id = created.json<PaymentRequest>().id;

    const bare = await post(`/api/payment-requests/${id}/decision`, {
      decision: 'reject',
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json<{ code: string }>().code).toBe('DECISION_NOTE_REQUIRED');

    const rejected = await post(`/api/payment-requests/${id}/decision`, {
      decision: 'reject',
      note: 'The bill is for a personal expense.',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json<PaymentRequest>().decisionNote).toBe(
      'The bill is for a personal expense.',
    );
  });

  it('blocks a second advance until the first one’s bills are recorded', async () => {
    const employee = await seedContact('Advance', { employee: true });
    const draw = async () =>
      post(
        '/api/payment-requests',
        {
          kind: 'advance',
          beneficiaryContactId: employee,
          purpose: 'Site travel and lodging',
          category: 'travel',
          amount: '42500.00',
          proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
          proofFilename: 'Travel-estimate.pdf',
        },
        clerkCookie,
      );

    const first = await draw();
    expect(first.statusCode, first.body).toBe(201);
    const firstId = first.json<PaymentRequest>().id;
    await post(`/api/payment-requests/${firstId}/decision`, { decision: 'approve' });
    const paid = await post(`/api/payment-requests/${firstId}/payment`, {
      reference: 'UTR900001',
      paidOn: '2026-08-12',
    });
    // An advance is paid but NOT settled: the bills are still to come.
    expect(paid.json<PaymentRequest>().status).toBe('paid');
    expect(paid.json<PaymentRequest>().billsDue).toBe(true);

    const blocked = await draw();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe('ADVANCE_BILLS_DUE');
    // The refusal names the request to close rather than stating a rule.
    expect(blocked.json<{ message: string }>().message).toContain(
      first.json<PaymentRequest>().requestNumber,
    );

    const closed = await post(`/api/payment-requests/${firstId}/bills`, {});
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json<PaymentRequest>().status).toBe('settled');

    const second = await draw();
    expect(second.statusCode, second.body).toBe(201);
  });

  it('pays once however many times the request is retried', async () => {
    const employee = await seedContact('DoublePay', { employee: true });
    const created = await post(
      '/api/payment-requests',
      {
        kind: 'reimbursement',
        beneficiaryContactId: employee,
        purpose: 'Retried by an impatient browser',
        category: 'travel',
        amount: '5000.00',
        proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
        proofFilename: 'retry.pdf',
      },
      clerkCookie,
    );
    const id = created.json<PaymentRequest>().id;
    await post(`/api/payment-requests/${id}/decision`, { decision: 'approve' });

    const first = await post(`/api/payment-requests/${id}/payment`, {
      reference: 'UTR-ONCE',
      paidOn: '2026-08-14',
    });
    expect(first.statusCode, first.body).toBe(200);

    // The retry must not move the money again, and must not overwrite
    // the reference of the payment that did.
    const retry = await post(`/api/payment-requests/${id}/payment`, {
      reference: 'UTR-TWICE',
      paidOn: '2026-08-15',
    });
    expect(retry.statusCode).toBe(409);
    const [row] = await admin<{ paid_reference: string }[]>`
      select paid_reference from payment_requests where id = ${id}
    `;
    expect(row?.paid_reference).toBe('UTR-ONCE');
  });

  it('lets only the first of two approvers decide', async () => {
    const employee = await seedContact('TwoApprovers', { employee: true });
    const created = await post(
      '/api/payment-requests',
      {
        kind: 'reimbursement',
        beneficiaryContactId: employee,
        purpose: 'Decided twice',
        category: 'general',
        amount: '900.00',
        proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
        proofFilename: 'twice.pdf',
      },
      clerkCookie,
    );
    const id = created.json<PaymentRequest>().id;

    const approve = await post(`/api/payment-requests/${id}/decision`, {
      decision: 'approve',
    });
    expect(approve.statusCode, approve.body).toBe(200);

    const reject = await post(`/api/payment-requests/${id}/decision`, {
      decision: 'reject',
      note: 'Changed my mind after approving.',
    });
    expect(reject.statusCode).toBe(409);
    expect(reject.json<{ code: string }>().code).toBe('PAYMENT_REQUEST_NOT_PENDING');
  });

  it('refuses the payments authority to a member who was not granted it', async () => {
    const employee = await seedContact('Ungranted', { employee: true });
    const created = await post(
      '/api/payment-requests',
      {
        kind: 'reimbursement',
        beneficiaryContactId: employee,
        purpose: 'Anything',
        category: 'general',
        amount: '100.00',
        proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
        proofFilename: 'x.pdf',
      },
      clerkCookie,
    );
    const decision = await post(
      `/api/payment-requests/${created.json<PaymentRequest>().id}/decision`,
      { decision: 'approve' },
      clerkCookie,
    );
    expect(decision.statusCode).toBe(403);
    expect(decision.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
  });

  it('refuses a beneficiary that is neither an employee nor a vendor', async () => {
    const consignee = await seedContact('Consignee', {});
    const created = await post('/api/payment-requests', {
      kind: 'reimbursement',
      beneficiaryContactId: consignee,
      purpose: 'Not payable',
      category: 'general',
      amount: '100.00',
      proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
      proofFilename: 'x.pdf',
    });
    expect(created.statusCode).toBe(400);
    expect(created.json<{ code: string }>().code).toBe('BENEFICIARY_NOT_PAYABLE');
  });
});

// ── Vendor ledger and TDS ─────────────────────────────────────────────

describe('vendor payments and tax deducted at source', () => {
  async function seedInvoice(
    label: string,
    amount: string,
    options: {
      tdsSection?: '194C' | '194J';
      payeeClass?: 'individual_huf' | 'other';
      gstin?: string | null;
      pan?: string | null;
    } = {},
  ): Promise<{ invoiceId: string; vendorId: string }> {
    const vendorId = await seedContact(
      label,
      { vendor: true },
      {
        gstin: options.gstin === undefined ? PAN_BEARING_GSTIN : options.gstin,
        ...(options.pan === undefined ? {} : { pan: options.pan }),
      },
    );
    const created = await post('/api/vendor-invoices', {
      vendorContactId: vendorId,
      invoiceNumber: `${label}/${runId}`,
      invoiceDate: '2026-07-02',
      creditDays: 30,
      amount,
      ...(options.tdsSection === undefined
        ? {}
        : {
            tdsSection: options.tdsSection,
            tdsPayeeClass: options.payeeClass ?? 'other',
          }),
    });
    expect(created.statusCode, created.body).toBe(201);
    return { invoiceId: created.json<VendorInvoice>().id, vendorId };
  }

  it('derives the due date from the credit terms in SQL', async () => {
    const { invoiceId } = await seedInvoice('DUE', '186400.00');
    const ledger = await authed({
      method: 'GET',
      url: '/api/vendor-invoices',
      organisationId,
    });
    expect(ledger.statusCode, ledger.body).toBe(200);
    const invoice = ledger
      .json<VendorLedgerResponse>()
      .invoices.find((row) => row.id === invoiceId);
    // 2 July + 30 days. Computed by PostgreSQL date arithmetic, never by
    // a browser adding milliseconds to a date-only value.
    expect(invoice?.dueOn).toBe('2026-08-01');
    expect(invoice?.outstandingAmount).toBe('186400.00');
  });

  it('splits gross into TDS and net in exact decimals, and consumes the invoice by the gross', async () => {
    const { invoiceId } = await seedInvoice('TDS', '500000.00', {
      tdsSection: '194C',
      payeeClass: 'other',
    });

    const preview = await previewTds(invoiceId, '100000.00', '2026-08-01');
    expect(preview.statusCode, preview.body).toBe(200);
    const quoted = preview.json<TdsPreviewResponse>();
    expect(quoted.deductible).toBe(true);
    expect(quoted.rate).toBe('2.00');
    expect(quoted.section).toBe('194C');
    // 2% of 1,00,000 is exactly 2,000. Not 1999.9999999999998.
    expect(quoted.tdsAmount).toBe('2000.00');
    expect(quoted.netAmount).toBe('98000.00');
    expect(quoted.provisionCitation).toBe('Section 194C');

    const paid = await post(`/api/vendor-invoices/${invoiceId}/payments`, {
      paidOn: '2026-08-01',
      grossAmount: '100000.00',
      reference: 'UTR700001',
    });
    expect(paid.statusCode, paid.body).toBe(201);
    const payment = paid.json<VendorPayment>();
    expect(payment.grossAmount).toBe('100000.00');
    expect(payment.tdsAmount).toBe('2000.00');
    expect(payment.netAmount).toBe('98000.00');
    expect(payment.tdsRate).toBe('2.00');

    const ledger = await authed({
      method: 'GET',
      url: '/api/vendor-invoices',
      organisationId,
    });
    const invoice = ledger
      .json<VendorLedgerResponse>()
      .invoices.find((row) => row.id === invoiceId);
    // The INVOICE moved by the gross, not the net. Had it moved by
    // 98,000 the vendor would appear owed 2,000 it was never owed.
    expect(invoice?.paidTotal).toBe('100000.00');
    expect(invoice?.outstandingAmount).toBe('400000.00');
  });

  it('deducts nothing until a threshold is crossed', async () => {
    // 194C: no deduction below ₹30,000 single and ₹1,00,000 aggregate.
    const { invoiceId } = await seedInvoice('BELOW', '50000.00', {
      tdsSection: '194C',
      payeeClass: 'other',
    });
    const preview = await previewTds(invoiceId, '5000.00', '2026-08-01');
    const quoted = preview.json<TdsPreviewResponse>();
    expect(quoted.deductible).toBe(false);
    expect(quoted.thresholdBasis).toBe('none');
    expect(quoted.tdsAmount).toBe('0.00');
    expect(quoted.netAmount).toBe('5000.00');

    const paid = await post(`/api/vendor-invoices/${invoiceId}/payments`, {
      paidOn: '2026-08-01',
      grossAmount: '5000.00',
    });
    expect(paid.statusCode, paid.body).toBe(201);
    const payment = paid.json<VendorPayment>();
    expect(payment.tdsAmount).toBe('0.00');
    expect(payment.netAmount).toBe('5000.00');
    // No section is recorded when nothing was withheld: a return line
    // with a section and a zero is a line that should not be filed.
    expect(payment.tdsSection).toBeNull();
  });

  it('crosses the single-payment threshold strictly above it, not at it', async () => {
    const { invoiceId } = await seedInvoice('SINGLE', '100000.00', {
      tdsSection: '194C',
      payeeClass: 'individual_huf',
    });
    // s.194C(5) says "does not exceed": ₹30,000 exactly is still exempt.
    const at = await previewTds(invoiceId, '30000.00', '2026-08-01');
    expect(at.json<TdsPreviewResponse>().deductible).toBe(false);
    expect(at.json<TdsPreviewResponse>().tdsAmount).toBe('0.00');

    const above = await previewTds(invoiceId, '30000.01', '2026-08-01');
    const quoted = above.json<TdsPreviewResponse>();
    expect(quoted.deductible).toBe(true);
    expect(quoted.thresholdBasis).toBe('single_payment');
    // 1% for an individual/HUF payee, not the 2% a company pays.
    expect(quoted.rate).toBe('1.00');
    expect(quoted.tdsAmount).toBe('300.00');
    expect(quoted.taxableBasis).toBe('payment');
  });

  it('applies the section 206AA floor when the vendor has furnished no PAN', async () => {
    const { invoiceId } = await seedInvoice('NOPAN', '500000.00', {
      tdsSection: '194C',
      payeeClass: 'other',
      gstin: null,
    });
    const preview = await previewTds(invoiceId, '100000.00', '2026-08-01');
    const quoted = preview.json<TdsPreviewResponse>();
    expect(quoted.panAbsentUplift).toBe(true);
    // The higher of the rate in force and 20% — a floor, not a swap.
    expect(quoted.rate).toBe('20.00');
    expect(quoted.ordinaryRate).toBe('2.00');
    expect(quoted.tdsAmount).toBe('20000.00');

    const paid = await post(`/api/vendor-invoices/${invoiceId}/payments`, {
      paidOn: '2026-08-01',
      grossAmount: '100000.00',
    });
    expect(paid.statusCode, paid.body).toBe(201);
    const payment = paid.json<VendorPayment>();
    expect(payment.panAbsent).toBe(true);
    expect(payment.vendorPan).toBeNull();
    expect(payment.tdsAmount).toBe('20000.00');
  });

  it('deducts at the ordinary rate for a vendor with a PAN but no GSTIN', async () => {
    /* The over-deduction migration 0080 exists to fix. An unregistered
       vendor — a small labour contractor, typically — has no GSTIN, so
       the first cut of this pack found no PAN to derive and floored the
       rate at 20%. It has furnished a PAN; it must be deducted at 1%. */
    const { invoiceId } = await seedInvoice('NOGSTIN', '500000.00', {
      tdsSection: '194C',
      payeeClass: 'individual_huf',
      gstin: null,
      pan: 'ABCDE1234F',
    });
    const preview = await previewTds(invoiceId, '100000.00', '2026-08-01');
    const quoted = preview.json<TdsPreviewResponse>();
    expect(quoted.panAbsentUplift).toBe(false);
    expect(quoted.rate).toBe('1.00');
    expect(quoted.tdsAmount).toBe('1000.00');

    const paid = await post(`/api/vendor-invoices/${invoiceId}/payments`, {
      paidOn: '2026-08-01',
      grossAmount: '100000.00',
    });
    expect(paid.statusCode, paid.body).toBe(201);
    expect(paid.json<VendorPayment>().vendorPan).toBe('ABCDE1234F');
    expect(paid.json<VendorPayment>().panAbsent).toBe(false);
  });

  it('deducts identically for a vendor whose PAN was backfilled from its GSTIN', async () => {
    /* The migration's backfill writes exactly what the route used to
       derive, so a contact that predates the column must produce the
       same rate it always did. `seedInvoice` defaults `pan` to the
       GSTIN-derived value for precisely this reason. */
    const { invoiceId, vendorId } = await seedInvoice('BACKFILL', '500000.00', {
      tdsSection: '194C',
      payeeClass: 'other',
    });
    const [row] = await admin<{ pan: string | null }[]>`
      select pan from contacts where id = ${vendorId}
    `;
    // Characters 3-12 of 27AAECN2222D1Z7.
    expect(row?.pan).toBe('AAECN2222D');

    const preview = await previewTds(invoiceId, '100000.00', '2026-08-01');
    const quoted = preview.json<TdsPreviewResponse>();
    expect(quoted.panAbsentUplift).toBe(false);
    expect(quoted.rate).toBe('2.00');
    expect(quoted.tdsAmount).toBe('2000.00');
  });

  it('refuses a payment that would exceed the invoice, by name', async () => {
    const { invoiceId } = await seedInvoice('CEILING', '10000.00');
    const first = await post(`/api/vendor-invoices/${invoiceId}/payments`, {
      paidOn: '2026-08-01',
      grossAmount: '6000.00',
    });
    expect(first.statusCode, first.body).toBe(201);
    const over = await post(`/api/vendor-invoices/${invoiceId}/payments`, {
      paidOn: '2026-08-02',
      grossAmount: '5000.00',
    });
    // The route's own check, so the operator gets a sentence naming the
    // outstanding figure rather than a SQLSTATE. The trigger holds the
    // same rule and is the authority under concurrency.
    expect(over.statusCode).toBe(409);
    expect(over.json<{ code: string }>().code).toBe('VENDOR_PAYMENT_EXCEEDS_INVOICE');
    expect(over.json<{ message: string }>().message).toContain('4000.00');
  });

  it('serialises the financial-year aggregate across simultaneous payments', async () => {
    /* AGENTS.md rule 9, and the test is built so that it FAILS without
       the per-vendor lock rather than merely passing with it.
     *
     * The year is walked to ₹90,000 first. Then two payments of ₹20,000
     * are issued together. Each is under the ₹30,000 single-payment
     * threshold, so neither triggers on its own; together they carry the
     * year to ₹1,30,000, past the ₹1,00,000 annual line.
     *
     * With the lock, exactly ONE of them is the crossing payment and
     * carries the catch-up on the whole aggregate; the other sees the
     * year already over and carries only itself. Without the lock both
     * read `paid_before = 90,000`, both believe they are the crossing
     * payment, and the vendor is taxed twice on the same ₹1,10,000. */
    const vendorId = await seedContact(
      'RACE',
      { vendor: true },
      { gstin: PAN_BEARING_GSTIN },
    );
    const invoiceFor = async (label: string, amount: string): Promise<string> => {
      const created = await post('/api/vendor-invoices', {
        vendorContactId: vendorId,
        invoiceNumber: `RACE-${label}/${runId}`,
        invoiceDate: '2026-07-02',
        creditDays: 30,
        amount,
        tdsSection: '194C',
        tdsPayeeClass: 'other',
      });
      expect(created.statusCode, created.body).toBe(201);
      return created.json<VendorInvoice>().id;
    };

    // ₹90,000 in three untaxed instalments, each under the single
    // threshold and the year still under the annual one.
    const warmup = await invoiceFor('WARM', '90000.00');
    for (const instalment of ['30000.00', '30000.00', '30000.00']) {
      const paid = await post(`/api/vendor-invoices/${warmup}/payments`, {
        paidOn: '2026-08-01',
        grossAmount: instalment,
      });
      expect(paid.statusCode, paid.body).toBe(201);
      expect(paid.json<VendorPayment>().tdsAmount).toBe('0.00');
    }

    const raceA = await invoiceFor('A', '20000.00');
    const raceB = await invoiceFor('B', '20000.00');
    const results = await Promise.all(
      [raceA, raceB].map((invoiceId) =>
        post(`/api/vendor-invoices/${invoiceId}/payments`, {
          paidOn: '2026-08-02',
          grossAmount: '20000.00',
        }),
      ),
    );
    for (const result of results) {
      expect(result.statusCode, result.body).toBe(201);
    }
    const payments = results.map((result) => result.json<VendorPayment>());

    // Exactly one catch-up. Two would mean both read the same stale
    // total, which is the bug the lock exists to prevent.
    const catchUps = payments.filter(
      (payment) => payment.tdsTaxableBasis === 'aggregate_catch_up',
    );
    expect(catchUps).toHaveLength(1);
    // It caught up the whole untaxed year: 90,000 + its own 20,000.
    expect(catchUps[0]?.tdsTaxableAmount).toBe('110000.00');

    const followers = payments.filter(
      (payment) => payment.tdsTaxableBasis === 'payment',
    );
    expect(followers).toHaveLength(1);
    expect(followers[0]?.tdsTaxableAmount).toBe('20000.00');
  });

  it('refuses a catch-up that would withhold more than the payment', async () => {
    /* 194J has no single-payment trigger and a ₹30,000 annual one, so a
       small payment can cross the year and owe 10% of the whole
       aggregate — more than itself. There is no honest way to withhold
       money that is not moving, so it is refused rather than capped. */
    const vendorId = await seedContact(
      'TINY',
      { vendor: true },
      { gstin: PAN_BEARING_GSTIN },
    );
    const invoiceFor = async (label: string, amount: string): Promise<string> => {
      const created = await post('/api/vendor-invoices', {
        vendorContactId: vendorId,
        invoiceNumber: `TINY-${label}/${runId}`,
        invoiceDate: '2026-07-02',
        creditDays: 30,
        amount,
        tdsSection: '194J',
        tdsPayeeClass: 'other',
      });
      expect(created.statusCode, created.body).toBe(201);
      return created.json<VendorInvoice>().id;
    };

    const warmup = await invoiceFor('WARM', '30000.00');
    const under = await post(`/api/vendor-invoices/${warmup}/payments`, {
      paidOn: '2026-08-01',
      grossAmount: '30000.00',
    });
    expect(under.statusCode, under.body).toBe(201);
    expect(under.json<VendorPayment>().tdsAmount).toBe('0.00');

    const crossing = await invoiceFor('CROSS', '100.00');
    const refused = await post(`/api/vendor-invoices/${crossing}/payments`, {
      paidOn: '2026-08-02',
      grossAmount: '100.00',
    });
    // 10% of 30,100 is 3,010, and only 100 is being paid.
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'VENDOR_PAYMENT_TDS_EXCEEDS_GROSS',
    );
  });

  it('releases the invoice when a payment is voided', async () => {
    const { invoiceId } = await seedInvoice('VOID', '10000.00');
    const paid = await post(`/api/vendor-invoices/${invoiceId}/payments`, {
      paidOn: '2026-08-01',
      grossAmount: '10000.00',
    });
    const paymentId = paid.json<VendorPayment>().id;

    const voided = await post(`/api/vendor-payments/${paymentId}/void`, {
      reason: 'Paid against the wrong invoice',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json<VendorPayment>().voidedAt).not.toBeNull();

    const ledger = await authed({
      method: 'GET',
      url: '/api/vendor-invoices',
      organisationId,
    });
    const invoice = ledger
      .json<VendorLedgerResponse>()
      .invoices.find((row) => row.id === invoiceId);
    expect(invoice?.paidTotal).toBe('0');
    expect(invoice?.outstandingAmount).toBe('10000.00');
  });

  it('refuses a TDS section without a payee class', async () => {
    const vendorId = await seedContact('Incomplete', { vendor: true });
    const created = await post('/api/vendor-invoices', {
      vendorContactId: vendorId,
      invoiceNumber: `INC/${runId}`,
      invoiceDate: '2026-07-02',
      creditDays: 30,
      amount: '1000.00',
      tdsSection: '194C',
    });
    expect(created.statusCode).toBe(400);
    expect(created.json<{ code: string }>().code).toBe('TDS_SECTION_INCOMPLETE');
  });

  it('exports the quarter’s deductions as CSV', async () => {
    const { invoiceId } = await seedInvoice('RETURN', '500000.00', {
      tdsSection: '194J',
      payeeClass: 'other',
    });
    await post(`/api/vendor-invoices/${invoiceId}/payments`, {
      paidOn: '2026-08-05',
      grossAmount: '200000.00',
      reference: 'UTR-Q2',
    });

    const csv = await authed({
      method: 'GET',
      // August 2026 is Q2 of financial year 2026-27.
      url: '/api/vendor-payments/tds-return.csv?financialYear=2026-27&quarter=Q2',
      organisationId,
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toContain('Section');
    const row = lines.find((line) => line.includes('UTR-Q2'));
    expect(row).toBeDefined();
    // 10% professional fee on 2,00,000 is exactly 20,000.
    expect(row).toContain('194J');
    expect(row).toContain('20000.00');
    expect(row).toContain('180000.00');

    // A payment outside the quarter is not in the quarter's return.
    const q3 = await authed({
      method: 'GET',
      url: '/api/vendor-payments/tds-return.csv?financialYear=2026-27&quarter=Q3',
      organisationId,
    });
    expect(q3.body).not.toContain('UTR-Q2');
  });
});

// ── Tenancy ───────────────────────────────────────────────────────────

describe('cross-tenant denial', () => {
  it('hides another organisation’s payment requests and vendor ledger', async () => {
    const employee = await seedContact('Hidden', { employee: true });
    await post('/api/payment-requests', {
      kind: 'reimbursement',
      beneficiaryContactId: employee,
      purpose: 'Private to this organisation',
      category: 'general',
      amount: '1234.00',
      proofReference: `${organisationId}/proof/${randomUUID()}.pdf`,
      proofFilename: 'private.pdf',
    });
    const vendorId = await seedContact('HiddenVendor', { vendor: true });
    await post('/api/vendor-invoices', {
      vendorContactId: vendorId,
      invoiceNumber: `HID/${runId}`,
      invoiceDate: '2026-07-02',
      creditDays: 30,
      amount: '9999.00',
    });

    const requests = await authed({
      method: 'GET',
      url: '/api/payment-requests',
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(requests.statusCode, requests.body).toBe(200);
    expect(requests.json<PaymentRequestListResponse>().requests).toEqual([]);

    const ledger = await authed({
      method: 'GET',
      url: '/api/vendor-invoices',
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(ledger.statusCode, ledger.body).toBe(200);
    expect(ledger.json<VendorLedgerResponse>().invoices).toEqual([]);
    expect(ledger.json<VendorLedgerResponse>().totalOutstanding).toBe('0');
  });

  it('refuses to bind an organisation the caller is not a member of', async () => {
    const stolen = await authed({
      method: 'GET',
      url: '/api/vendor-invoices',
      organisationId,
      as: strangerCookie,
    });
    expect(stolen.statusCode).toBeGreaterThanOrEqual(400);
    expect(stolen.statusCode).toBeLessThan(500);
  });
});
