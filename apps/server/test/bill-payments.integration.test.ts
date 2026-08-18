import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  BillPayment,
  BillSettlementResponse,
  ReceivablesRegisterResponse,
  RecordBillPaymentRequest,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  removeOrganisationResidue,
} from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * The payment register, and the outstanding position it produces.
 *
 * What this suite is really about is one distinction, stated three
 * different ways: money the railway KEPT is settled money, and money that
 * never arrived is outstanding money. A register that cannot tell them
 * apart reports a bill short-paid by its own statutory deductions
 * forever, which is the spreadsheet defect pack P15 exists to remove.
 *
 * The closure fixture is written with admin SQL rather than by uploading
 * a signed PDF: the verdict rules are the owner's ruling and are proved
 * end to end in `received-railway-bills.integration.test.ts`. What this
 * suite needs from them is only their RESULT — a closed measurement with
 * a railway figure behind it — and re-proving them here would be a second
 * copy of a test that already exists.
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
const ownerEmail = `bp-owner-${runId}@integration.test`;
const strangerEmail = `bp-stranger-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** The railway's own figure on every seeded bill. Round, so that a
 * reader of a failure message can do the arithmetic in their head. */
const RAILWAY_BILL_AMOUNT = '1000000.00';

let admin: Sql;
let app: FastifyInstance;
let organisationId: string;
let strangerOrganisationId: string;
let cookie: string;
let strangerCookie: string;
let ownerUserId: string;

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

interface Fixture {
  readonly workId: string;
  readonly bookId: string;
  readonly billId: string;
}

/**
 * A Work with a finalized Measurement Book and the bill prepared from it.
 * `closed` decides whether the railway has settled the measurement, which
 * is the precondition the whole register hangs off.
 */
async function seedBill(
  label: string,
  options: { readonly closed?: boolean } = {},
): Promise<Fixture> {
  const org = organisationId;
  const workId = randomUUID();
  const bookId = randomUUID();
  const billId = randomUUID();
  const letterNumber = `LOA-${label}-${runId}`;
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${org}, ${`${label}-${runId.toUpperCase()}`}, ${letterNumber},
      '2026-01-01',
      'Train information display boards', '195574112.38', '169228497.35',
      'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into measurement_books (
      id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
    )
    values (${bookId}, ${org}, ${workId}, 'draft', '2026-05-09', ${ownerUserId},
            'on_account')
  `;
  await admin`
    update measurement_books
    set status = 'finalized', mb_number = ${`${label}-MB-01`},
        sequence_number = 1, total_amount = ${RAILWAY_BILL_AMOUNT},
        remark_template_version = 'mb-remark-v1', finalized_at = now(),
        finalized_by_user_id = ${ownerUserId}
    where id = ${bookId}
  `;
  await admin`
    insert into bills (
      id, organisation_id, work_id, bill_number, lines_snapshot, total_amount,
      prepared_by_user_id, mb_id
    )
    values (
      ${billId}, ${org}, ${workId}, 1, '[]'::jsonb, ${RAILWAY_BILL_AMOUNT},
      ${ownerUserId}, ${bookId}
    )
  `;
  if (options.closed !== false) await closeBook(org, workId, bookId, label);
  return { workId, bookId, billId };
}

/** The railway's signed On-Account Bill, and the closure it permits. */
async function closeBook(
  org: string,
  workId: string,
  bookId: string,
  label: string,
): Promise<void> {
  const [recorded] = await admin<{ id: string }[]>`
    insert into received_railway_bills (
      organisation_id, work_id, measurement_book_id, object_key,
      original_filename, sha256, media_type, size_bytes, bill_number,
      bill_date, bill_amount, rate_inclusive_of_gst, measurement_number,
      measurement_sequence, letter_number, extraction_payload,
      uploaded_by_user_id, signature_status, signature_verdict,
      signature_verified_at
    )
    values (
      ${org}, ${workId}, ${bookId}, ${`${org}/railwaybill/${bookId}.pdf`},
      'bill.pdf', ${'c'.repeat(64)}, 'application/pdf', 4096,
      ${`${label}/B1`}, '2026-05-11', ${RAILWAY_BILL_AMOUNT}, true,
      ${`${label}/OAM/FL2/01`}, 1, ${`LOA-${label}-${runId}`},
      '{"billNumber": "fixture"}'::jsonb, ${ownerUserId}, 'signed_and_intact',
      '{"signatures": [{"index": 1}, {"index": 2}, {"index": 3}]}'::jsonb,
      now()
    )
    returning id
  `;
  await admin`
    update measurement_books
    set closed_at = now(), closed_by_user_id = ${ownerUserId},
        closed_by_received_bill_id = ${recorded?.id ?? ''}
    where id = ${bookId}
  `;
}

function record(billId: string, body: RecordBillPaymentRequest, as?: string) {
  return authed({
    method: 'POST',
    url: `/api/bills/${billId}/payments`,
    organisationId: as === undefined ? organisationId : strangerOrganisationId,
    ...(as === undefined ? {} : { as }),
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: body,
  });
}

/** The Work a bill belongs to, for a test that starts from the bill. */
async function billWork(billId: string): Promise<{ work_id: string }> {
  const [row] = await admin<{ work_id: string }[]>`
    select work_id from bills where id = ${billId}
  `;
  if (row === undefined) throw new Error('bill missing');
  return row;
}

function settlement(workId: string) {
  return authed({
    method: 'GET',
    url: `/api/works/${workId}/bill-settlement`,
    organisationId,
  });
}

/** The organisation-wide register, across every Work in reach. */
function register(as?: string) {
  return authed({
    method: 'GET',
    url: '/api/bill-settlement',
    organisationId: as === undefined ? organisationId : strangerOrganisationId,
    ...(as === undefined ? {} : { as }),
  });
}

function setStatus(billId: string, status: 'submitted' | 'paid') {
  return authed({
    method: 'POST',
    url: `/api/bills/${billId}/status`,
    organisationId,
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { status },
  });
}

/** Half the bill: ₹4,70,000 credited, ₹30,000 kept across the three
 * statutory heads. Exactly ₹5,00,000 of the railway's ₹10,00,000. */
const HALF: RecordBillPaymentRequest = {
  receivedOn: '2026-06-01',
  receivedAmount: '470000.00',
  reference: 'UTR-HALF-0001',
  deductions: [
    { category: 'GST_TDS', amount: '10000.00' },
    { category: 'INCOME_TAX_TDS', amount: '5000.00' },
    { category: 'SECURITY_DEPOSIT', amount: '15000.00' },
  ],
};

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-bill-payment-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the bill-payment integration tests. ' +
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
    payload: { email: ownerEmail, password, name: 'Payment Owner' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  cookie = extractCookies(signUp.headers['set-cookie']);

  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'Payment Org', slug: `bp-org-${runId}` },
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
    payload: { name: 'Stranger Org', slug: `bp-stranger-${runId}` },
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

describe('recording what the railway paid', () => {
  it('records the receipt and its breakup as one act', async () => {
    const { billId } = await seedBill('BPA');
    const response = await record(billId, HALF);
    expect(response.statusCode, response.body).toBe(201);
    const payment = response.json<BillPayment>();

    expect(payment.receivedAmount).toBe('470000.00');
    // Both derived figures are summed in SQL, never in the browser and
    // never here: the register's whole claim is that gross = received +
    // deducted, and a total computed twice is a total that can disagree.
    expect(payment.deductionTotal).toBe('30000.00');
    expect(payment.grossAmount).toBe('500000.00');
    expect(payment.deductions.map((deduction) => deduction.category)).toEqual([
      'GST_TDS',
      'INCOME_TAX_TDS',
      'SECURITY_DEPOSIT',
    ]);
  });

  it('refuses money against a measurement the railway has not settled', async () => {
    const { billId } = await seedBill('BPB', { closed: false });
    const response = await record(billId, HALF);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'BILL_MEASUREMENT_BOOK_NOT_CLOSED',
    );
  });

  it('refuses a receipt that would settle more than the railway billed', async () => {
    const { billId } = await seedBill('BPC');
    const response = await record(billId, {
      receivedOn: '2026-06-01',
      receivedAmount: '999999.00',
      deductions: [{ category: 'PENALTY', amount: '2.00' }],
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'BILL_PAYMENT_EXCEEDS_SETTLEMENT',
    );
  });

  it('refuses an unnamed Other head and a head stated twice', async () => {
    const { billId } = await seedBill('BPD');
    const undescribed = await record(billId, {
      receivedOn: '2026-06-01',
      receivedAmount: '1.00',
      deductions: [{ category: 'OTHER', amount: '1.00' }],
    });
    expect(undescribed.statusCode, undescribed.body).toBe(400);
    expect(undescribed.json<{ code: string }>().code).toBe(
      'BILL_PAYMENT_DEDUCTION_UNDESCRIBED',
    );

    const twice = await record(billId, {
      receivedOn: '2026-06-01',
      receivedAmount: '1.00',
      deductions: [
        { category: 'GST_TDS', amount: '1.00' },
        { category: 'GST_TDS', amount: '2.00' },
      ],
    });
    expect(twice.statusCode, twice.body).toBe(409);
    expect(twice.json<{ code: string }>().code).toBe(
      'BILL_PAYMENT_DUPLICATE_DEDUCTION',
    );

    // Two OTHER heads on one advice are two different facts and both stay
    // recordable — the rule is about a NAMED head being stated once.
    const twoOthers = await record(billId, {
      receivedOn: '2026-06-01',
      receivedAmount: '1.00',
      deductions: [
        { category: 'OTHER', amount: '1.00', description: 'Cement recovery' },
        { category: 'OTHER', amount: '2.00', description: 'Electricity recovery' },
      ],
    });
    expect(twoOthers.statusCode, twoOthers.body).toBe(201);
  });
});

describe('outstanding with the railway', () => {
  it('separates money kept from money missing, and sums partial receipts', async () => {
    const { workId, billId } = await seedBill('BPE');

    const empty = await settlement(workId);
    expect(empty.statusCode, empty.body).toBe(200);
    const [before] = empty.json<BillSettlementResponse>().positions;
    expect(before?.railwayBillAmount).toBe(RAILWAY_BILL_AMOUNT);
    expect(before?.outstandingAmount).toBe(RAILWAY_BILL_AMOUNT);
    expect(before?.receivedTotal).toBe('0.00');

    expect((await record(billId, HALF)).statusCode).toBe(201);
    const half = await settlement(workId);
    const [middle] = half.json<BillSettlementResponse>().positions;
    // The load-bearing assertion of the whole pack: ₹4,70,000 arrived and
    // ₹5,30,000 is outstanding — NOT ₹5,30,000 minus nothing. The
    // ₹30,000 the railway kept is settled money and has left the
    // outstanding column, which is the figure an operator chases.
    expect(middle?.receivedTotal).toBe('470000.00');
    expect(middle?.deductionTotal).toBe('30000.00');
    expect(middle?.outstandingAmount).toBe('500000.00');
    expect(middle?.payments).toHaveLength(1);

    expect(
      (await record(billId, { ...HALF, reference: 'UTR-HALF-0002' })).statusCode,
    ).toBe(201);
    const full = await settlement(workId);
    const [after] = full.json<BillSettlementResponse>().positions;
    expect(after?.receivedTotal).toBe('940000.00');
    expect(after?.deductionTotal).toBe('60000.00');
    expect(after?.outstandingAmount).toBe('0.00');
    expect(after?.payments).toHaveLength(2);
  });

  it('reports no outstanding figure at all while the measurement is open', async () => {
    // Not zero, and not the prepared amount: until the railway has issued
    // its own bill there is no agreed figure to be outstanding against,
    // and reporting one would state a debt nobody has acknowledged.
    const { workId } = await seedBill('BPF', { closed: false });
    const response = await settlement(workId);
    const [position] = response.json<BillSettlementResponse>().positions;
    expect(position?.railwayBillAmount).toBeNull();
    expect(position?.outstandingAmount).toBeNull();
    expect(position?.measurementClosedAt).toBeNull();
    expect(position?.preparedAmount).toBe(RAILWAY_BILL_AMOUNT);
  });
});

describe('the organisation-wide receivables register', () => {
  it('reports the register facts and sums its totals in SQL', async () => {
    const { billId } = await seedBill('BPX');
    expect((await record(billId, HALF)).statusCode).toBe(201);

    const response = await register();
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<ReceivablesRegisterResponse>();
    const entry = body.entries.find((row) => row.billId === billId);
    if (entry === undefined) throw new Error('seeded bill missing from register');

    // The four things the register adds to a per-Work position.
    expect(entry.workCode).toBe(`BPX-${runId.toUpperCase()}`);
    expect(entry.workTitle).toBe('Train information display boards');
    // The railway bill is dated 2026-05-11, which is Indian FY 2026-27 —
    // derived from the RAILWAY's date, not the agency's.
    expect(entry.financialYear).toBe('2026-27');
    // ₹10,00,000 billed less the ₹30,000 kept.
    expect(entry.netPayableAmount).toBe('970000.00');

    // The waterfall's heads, aggregated per head across live receipts and
    // ordered by category, never summed in the browser.
    expect(entry.deductionsByHead).toEqual([
      { category: 'GST_TDS', amount: '10000.00' },
      { category: 'INCOME_TAX_TDS', amount: '5000.00' },
      { category: 'SECURITY_DEPOSIT', amount: '15000.00' },
    ]);

    // Totals are over the whole scoped register, so they can only be
    // asserted as "at least this bill's contribution" while other tests
    // seed their own Works into the same organisation. The invariant that
    // matters is that they are exact decimal strings at the money scale.
    for (const total of Object.values(body.summary)) {
      expect(total).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it('reports a bill the railway has not passed without inventing a year', async () => {
    const { billId } = await seedBill('BPY', { closed: false });
    const body = (await register()).json<ReceivablesRegisterResponse>();
    const entry = body.entries.find((row) => row.billId === billId);
    // Null throughout rather than zero: an unacknowledged bill is not a
    // receivable in any financial year, and it owes nothing net.
    expect(entry?.railwayBillAmount).toBeNull();
    expect(entry?.financialYear).toBeNull();
    expect(entry?.netPayableAmount).toBeNull();
    expect(entry?.outstandingAmount).toBeNull();
    expect(entry?.deductionsByHead).toEqual([]);
  });

  it('drops a withdrawn receipt out of the waterfall heads', async () => {
    const { billId } = await seedBill('BPZ');
    const created = await record(billId, HALF);
    expect(created.statusCode).toBe(201);
    const paymentId = created.json<{ id: string }>().id;

    const voided = await authed({
      method: 'POST',
      url: `/api/bill-payments/${paymentId}/void`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'Advice withdrawn by the railway' },
    });
    expect(voided.statusCode, voided.body).toBe(200);

    const body = (await register()).json<ReceivablesRegisterResponse>();
    const entry = body.entries.find((row) => row.billId === billId);
    // The heads have to follow the same `voided_at is null` filter the
    // position view uses, or they would sum past a deductionTotal that
    // has already dropped them.
    expect(entry?.deductionsByHead).toEqual([]);
    expect(entry?.deductionTotal).toBe('0.00');
    expect(entry?.netPayableAmount).toBe(RAILWAY_BILL_AMOUNT);
  });

  it('shows another organisation nothing of this one, and an assigned member nothing unassigned', async () => {
    const { billId } = await seedBill('BP1');

    const stranger = (
      await register(strangerCookie)
    ).json<ReceivablesRegisterResponse>();
    expect(stranger.entries).toEqual([]);
    expect(stranger.summary.claimedTotal).toBe('0.00');

    await admin`
      update organisation_memberships set work_scope = 'assigned'
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
    try {
      const scoped = (await register()).json<ReceivablesRegisterResponse>();
      // The register is a list rather than one Work, so an out-of-scope
      // row is absent rather than a 404 — and absent from the TOTALS too,
      // which is the half a duplicated scope predicate would get wrong.
      expect(scoped.entries.some((row) => row.billId === billId)).toBe(false);
      expect(scoped.entries).toEqual([]);
      expect(scoped.summary.claimedTotal).toBe('0.00');
      expect(scoped.summary.outstandingTotal).toBe('0.00');
    } finally {
      await admin`
        update organisation_memberships set work_scope = 'all'
        where organisation_id = ${organisationId} and user_id = ${ownerUserId}
      `;
    }
  });
});

describe('paid stops being a word', () => {
  it('refuses paid while anything is outstanding, and allows it at nil', async () => {
    const { billId } = await seedBill('BPG');
    expect((await setStatus(billId, 'submitted')).statusCode).toBe(200);

    // THE GUARD. On the pre-fix tree this call answers 200 with an empty
    // payment register behind it, which is the defect the pack is named
    // for: `paid` was a word with no amount.
    const empty = await setStatus(billId, 'paid');
    expect(empty.statusCode, empty.body).toBe(409);
    expect(empty.json<{ code: string }>().code).toBe('BILL_NOT_FULLY_SETTLED');

    expect((await record(billId, HALF)).statusCode).toBe(201);
    const partial = await setStatus(billId, 'paid');
    expect(partial.statusCode, partial.body).toBe(409);
    expect(partial.json<{ code: string }>().code).toBe('BILL_NOT_FULLY_SETTLED');

    expect(
      (await record(billId, { ...HALF, reference: 'UTR-HALF-0002' })).statusCode,
    ).toBe(201);
    const paid = await setStatus(billId, 'paid');
    expect(paid.statusCode, paid.body).toBe(200);
  });

  it('closes the register once the bill is paid, in both directions', async () => {
    const { billId } = await seedBill('BPH');
    expect((await setStatus(billId, 'submitted')).statusCode).toBe(200);
    const first = await record(billId, HALF);
    expect(first.statusCode).toBe(201);
    const paymentId = first.json<BillPayment>().id;
    expect(
      (await record(billId, { ...HALF, reference: 'UTR-HALF-0002' })).statusCode,
    ).toBe(201);
    expect((await setStatus(billId, 'paid')).statusCode).toBe(200);

    const late = await record(billId, {
      receivedOn: '2026-07-01',
      receivedAmount: '0.00',
      deductions: [],
    });
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json<{ code: string }>().code).toBe('BILL_ALREADY_PAID');

    const withdraw = await authed({
      method: 'POST',
      url: `/api/bill-payments/${paymentId}/void`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'Wrong bill' },
    });
    expect(withdraw.statusCode, withdraw.body).toBe(409);
    expect(withdraw.json<{ code: string }>().code).toBe('BILL_ALREADY_PAID');
  });
});

describe('voiding a receipt', () => {
  it('takes the money back out of every sum and refuses a second void', async () => {
    const { workId, billId } = await seedBill('BPI');
    const first = await record(billId, HALF);
    expect(first.statusCode).toBe(201);
    const paymentId = first.json<BillPayment>().id;

    const voided = await authed({
      method: 'POST',
      url: `/api/bill-payments/${paymentId}/void`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'Credited against the wrong bill' },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json<BillPayment>().voidReason).toBe(
      'Credited against the wrong bill',
    );

    const response = await settlement(workId);
    const [position] = response.json<BillSettlementResponse>().positions;
    expect(position?.receivedTotal).toBe('0.00');
    expect(position?.deductionTotal).toBe('0.00');
    expect(position?.outstandingAmount).toBe(RAILWAY_BILL_AMOUNT);
    // The row itself stays, with its reason — evidence does not leave.
    expect(position?.payments).toHaveLength(1);
    expect(position?.payments[0]?.voidedAt).not.toBeNull();

    const again = await authed({
      method: 'POST',
      url: `/api/bill-payments/${paymentId}/void`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'Again' },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('BILL_PAYMENT_ALREADY_VOIDED');
  });
});

describe('the database refuses what the route refuses', () => {
  /* Asserted on SQLSTATE rather than on the text of each RAISE.
   * `apps/server/src/routes/bill-payments.ts` maps these codes to named
   * 409s, so the code is the contract between the two layers and the
   * message is prose that may be improved; a test that pinned the prose
   * would make rewording a refusal a test failure and would not notice a
   * code that changed. Migration 0067 lists what each code means. */
  it('refuses a payment written straight to the table against an open book', async () => {
    // Recurring finding 2: money enforced twice. The route is not in this
    // path at all — this is the trigger answering a writer that never
    // asked it.
    const { billId } = await seedBill('BPJ', { closed: false });
    await expect(
      admin`
        insert into bill_payments (
          organisation_id, bill_id, received_on, received_amount,
          recorded_by_user_id
        )
        values (${organisationId}, ${billId}, '2026-06-01', '1.00', ${ownerUserId})
      `,
    ).rejects.toMatchObject({ code: '23A03' });
  });

  it('refuses a bill BORN paid with an empty register', async () => {
    // The shape migration 0066 was caught by: the status CHECK admits
    // `paid` on a fresh row, so an UPDATE-only guard would watch the door
    // while the window stood open. Both 0067 triggers are BEFORE INSERT
    // OR UPDATE for exactly this.
    const { workId, bookId } = await seedBill('BPK');
    await expect(
      admin`
        insert into bills (
          organisation_id, work_id, bill_number, status, lines_snapshot,
          total_amount, prepared_by_user_id, mb_id, submitted_at, paid_at
        )
        values (
          ${organisationId}, ${workId}, 2, 'paid', '[]'::jsonb,
          ${RAILWAY_BILL_AMOUNT}, ${ownerUserId}, ${bookId}, now(), now()
        )
      `,
    ).rejects.toMatchObject({ code: '23A05' });
  });

  it('refuses a deduction that would push the register past the railway figure', async () => {
    const { billId } = await seedBill('BPL');
    const response = await record(billId, {
      receivedOn: '2026-06-01',
      receivedAmount: '1000000.00',
      deductions: [],
    });
    expect(response.statusCode, response.body).toBe(201);
    const paymentId = response.json<BillPayment>().id;
    await expect(
      admin`
        insert into bill_payment_deductions (
          organisation_id, bill_payment_id, category, amount
        )
        values (${organisationId}, ${paymentId}, 'PENALTY', '0.01')
      `,
    ).rejects.toMatchObject({ code: '23A01' });
  });

  it('refuses to edit a recorded receipt or a recorded deduction', async () => {
    const { billId } = await seedBill('BPM');
    const response = await record(billId, HALF);
    expect(response.statusCode).toBe(201);
    const paymentId = response.json<BillPayment>().id;
    await expect(
      admin`
        update bill_payments set received_amount = '1.00' where id = ${paymentId}
      `,
    ).rejects.toMatchObject({ code: '23A04' });
    await expect(
      admin`
        update bill_payment_deductions set amount = '1.00'
        where bill_payment_id = ${paymentId}
      `,
    ).rejects.toMatchObject({ code: '23A04' });
  });
});

describe('two receipts at once', () => {
  it('lets exactly one of two simultaneous receipts take the last of the bill', async () => {
    // AGENTS.md's definition of done asks concurrency-sensitive work for a
    // simultaneous-request test, and this is the one path where the route's
    // pre-flight check cannot be the whole answer: both requests read the
    // register before either writes. What makes it correct is the `FOR
    // UPDATE` on the bill row, taken in the same order by the route and by
    // the trigger — and the loser's refusal is the `rethrowWriteRefusal`
    // branch, which nothing else in this suite executes.
    const { billId } = await seedBill('BPR');
    const each: RecordBillPaymentRequest = {
      receivedOn: '2026-06-01',
      receivedAmount: '600000.00',
      deductions: [],
    };

    const [first, second] = await Promise.all([
      record(billId, { ...each, reference: 'UTR-RACE-A' }),
      record(billId, { ...each, reference: 'UTR-RACE-B' }),
    ]);
    const codes = [first, second].map((response) => response.statusCode).sort();
    // Two receipts of six lakh against a ten-lakh bill: one fits, and the
    // two together do not.
    expect(codes, `${first.body} | ${second.body}`).toEqual([201, 409]);

    const loser = [first, second].find((response) => response.statusCode === 409);
    expect(loser?.json<{ code: string }>().code).toBe(
      'BILL_PAYMENT_EXCEEDS_SETTLEMENT',
    );

    // And the register holds exactly one of them, so the refusal was a
    // refusal rather than a rollback of both.
    const [position] = (
      await settlement((await billWork(billId)).work_id)
    ).json<BillSettlementResponse>().positions;
    expect(position?.receivedTotal).toBe('600000.00');
    expect(position?.payments).toHaveLength(1);
  });
});

describe('the deduction breakup is checked as a whole', () => {
  it('refuses a multi-row breakup that fits row by row but not as a statement', async () => {
    // THE VOLATILITY PIN (migration 0067 section 6).
    //
    // The route inserts a whole breakup as ONE multi-row INSERT, so the
    // BEFORE trigger fires once per deduction inside a single statement.
    // Each firing sees the siblings the same statement already inserted
    // only because the trigger function is VOLATILE — a VOLATILE PL/pgSQL
    // function runs its statements read-write, which increments the command
    // counter and makes those rows visible. Marked STABLE, which the body
    // would not obviously contradict, the siblings vanish and three rows
    // that individually fit would jointly pass the ceiling.
    //
    // The route is deliberately bypassed: it sums the request itself and
    // would refuse this before the database ever saw it, so going through
    // it would prove nothing about the second layer. Four deductions of
    // ₹3,00,000 against a ₹10,00,000 bill with nothing else recorded —
    // each fits alone, the statement does not.
    const { billId } = await seedBill('BPS');
    const [payment] = await admin<{ id: string }[]>`
      insert into bill_payments (
        organisation_id, bill_id, received_on, received_amount,
        recorded_by_user_id
      )
      values (${organisationId}, ${billId}, '2026-06-01', '0.00', ${ownerUserId})
      returning id
    `;
    await expect(
      admin`
        insert into bill_payment_deductions (
          organisation_id, bill_payment_id, category, amount
        )
        select ${organisationId}, ${payment?.id ?? ''}, category, '300000.00'
        from unnest(array['GST_TDS', 'INCOME_TAX_TDS', 'SECURITY_DEPOSIT', 'PENALTY'])
          as category
      `,
    ).rejects.toMatchObject({ code: '23A01' });
  });
});

describe('the same advice twice', () => {
  it('refuses a second live receipt quoting the same reference', async () => {
    const { billId } = await seedBill('BPT');
    const first = await record(billId, {
      receivedOn: '2026-06-01',
      receivedAmount: '100000.00',
      reference: 'UTR-DUP-9001',
      deductions: [],
    });
    expect(first.statusCode, first.body).toBe(201);

    const again = await record(billId, {
      receivedOn: '2026-06-02',
      receivedAmount: '100000.00',
      // Padded on purpose: the column stores trimmed text and the index
      // is on `btrim(reference)`, so a duplicate cannot be smuggled past
      // either of them with a leading space.
      reference: '  UTR-DUP-9001  ',
      deductions: [],
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe(
      'BILL_PAYMENT_DUPLICATE_REFERENCE',
    );

    // The index is the half that survives a route forgetting to ask, so it
    // is attacked directly as well.
    await expect(
      admin`
        insert into bill_payments (
          organisation_id, bill_id, received_on, received_amount, reference,
          recorded_by_user_id
        )
        values (${organisationId}, ${billId}, '2026-06-03', '1.00',
                'UTR-DUP-9001', ${ownerUserId})
      `,
    ).rejects.toMatchObject({ code: '23505' });

    // Withdrawing the first frees the reference: the index is partial on
    // the live rows, because a corrected receipt legitimately re-quotes
    // the advice it replaces.
    const withdrawn = await authed({
      method: 'POST',
      url: `/api/bill-payments/${first.json<BillPayment>().id}/void`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'Keyed against the wrong bill' },
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const replacement = await record(billId, {
      receivedOn: '2026-06-04',
      receivedAmount: '100000.00',
      reference: 'UTR-DUP-9001',
      deductions: [],
    });
    expect(replacement.statusCode, replacement.body).toBe(201);
  });

  it('stores the reference as btrim would judge it', async () => {
    const { billId } = await seedBill('BPU');
    const response = await record(billId, {
      receivedOn: '2026-06-01',
      receivedAmount: '1000.00',
      reference: '  UTR-PADDED-1  ',
      remarks: '  Against the May advice  ',
      deductions: [],
    });
    // Untrimmed, this reached the btrim CHECK as a 23514 and the operator
    // read a bare 500.
    expect(response.statusCode, response.body).toBe(201);
    const payment = response.json<BillPayment>();
    expect(payment.reference).toBe('UTR-PADDED-1');
    expect(payment.remarks).toBe('Against the May advice');
    // And every money figure is two-place, including the derived ones on
    // a receipt with no deductions at all — where the coalesce falls back
    // to an integer and used to answer "0" beside a column of "0.00".
    expect(payment.deductionTotal).toBe('0.00');
    expect(payment.grossAmount).toBe('1000.00');
  });
});

describe('when a receipt may be dated', () => {
  it('refuses a future date and a date before the railway bill', async () => {
    const { billId } = await seedBill('BPV');
    const future = await record(billId, {
      receivedOn: '2099-01-01',
      receivedAmount: '1000.00',
      deductions: [],
    });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json<{ code: string }>().code).toBe('BILL_PAYMENT_DATE_INVALID');

    // The seeded railway bill is dated 2026-05-11; money cannot have
    // arrived against a bill the railway had not raised.
    const early = await record(billId, {
      receivedOn: '2026-05-10',
      receivedAmount: '1000.00',
      deductions: [],
    });
    expect(early.statusCode, early.body).toBe(400);
    expect(early.json<{ code: string }>().code).toBe('BILL_PAYMENT_DATE_INVALID');

    // The bill's own date is the boundary and is inclusive: same-day
    // settlement happens.
    const sameDay = await record(billId, {
      receivedOn: '2026-05-11',
      receivedAmount: '1000.00',
      deductions: [],
    });
    expect(sameDay.statusCode, sameDay.body).toBe(201);
  });
});

describe('the column CHECKs refuse what no route would send', () => {
  it('refuses a void with no reason, a nil deduction, and an unnamed Other', async () => {
    const { billId } = await seedBill('BPW');
    const [payment] = await admin<{ id: string }[]>`
      insert into bill_payments (
        organisation_id, bill_id, received_on, received_amount,
        recorded_by_user_id
      )
      values (${organisationId}, ${billId}, '2026-06-01', '100.00', ${ownerUserId})
      returning id
    `;
    const paymentId = payment?.id ?? '';

    // The void columns travel together, and the reason is required —
    // unlike a discarded railway bill's, because retracting a recorded
    // receipt of money is never self-evident from the record.
    await expect(
      admin`
        update bill_payments set voided_at = now(), voided_by_user_id = ${ownerUserId}
        where id = ${paymentId}
      `,
    ).rejects.toMatchObject({ constraint_name: 'bill_payments_void_shape_check' });

    // A deduction of nothing is not a deduction.
    await expect(
      admin`
        insert into bill_payment_deductions (
          organisation_id, bill_payment_id, category, amount
        )
        values (${organisationId}, ${paymentId}, 'PENALTY', '0.00')
      `,
    ).rejects.toMatchObject({ code: '23514' });

    // OTHER without a description is the one category that cannot be
    // written without saying what it is.
    await expect(
      admin`
        insert into bill_payment_deductions (
          organisation_id, bill_payment_id, category, amount
        )
        values (${organisationId}, ${paymentId}, 'OTHER', '1.00')
      `,
    ).rejects.toMatchObject({
      constraint_name: 'bill_payment_deductions_other_needs_description_check',
    });

    // And a named head twice on one advice, which the partial unique index
    // refuses even though the route checks it first.
    await admin`
      insert into bill_payment_deductions (
        organisation_id, bill_payment_id, category, amount
      )
      values (${organisationId}, ${paymentId}, 'GST_TDS', '1.00')
    `;
    await expect(
      admin`
        insert into bill_payment_deductions (
          organisation_id, bill_payment_id, category, amount
        )
        values (${organisationId}, ${paymentId}, 'GST_TDS', '2.00')
      `,
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('tenancy and scope', () => {
  it('hides the settlement of another organisation and refuses money against it', async () => {
    const { workId, billId } = await seedBill('BPN');
    // The stranger is a full-scope member of their OWN organisation, so
    // the work-scope check has no complaint to make and row-level
    // security is what decides. Under it the Work does not exist, and the
    // read now says so: 404 rather than the `200 {positions: []}` it
    // answered before the liveness read, which was indistinguishable from
    // a Work of their own that nobody had billed yet. 404 and not 403 —
    // a guessed id must not confirm the Work exists somewhere.
    const read = await authed({
      method: 'GET',
      url: `/api/works/${workId}/bill-settlement`,
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(read.statusCode, read.body).toBe(404);
    expect(read.json<{ code: string }>().code).toBe('WORK_NOT_FOUND');

    const write = await record(billId, HALF, strangerCookie);
    expect([403, 404]).toContain(write.statusCode);
  });

  it('answers no such Work rather than an empty register for an unknown id', async () => {
    // The register used to answer `200 {positions: []}` for a Work that
    // does not exist, because `assertWorkAccess` only checks membership
    // and the view simply matched nothing. An empty register and a Work
    // that is not there are different facts, and every other
    // Work-addressed read in the tree tells them apart.
    //
    // The same read carries `deleted_at is null` for consistency with the
    // merged tree, though that state is unreachable from the product:
    // migration 0071 refuses a withdrawal written by hand, and superseding
    // refuses while any bill exists — so a Work with a settlement position
    // can never be withdrawn. Stated rather than tested, because a test
    // would have to fabricate a row the database is right to refuse.
    const response = await settlement('00000000-0000-4000-8000-000000000000');
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('WORK_NOT_FOUND');
  });

  it('hides the register from an assigned-scope member with no assignment', async () => {
    const { workId } = await seedBill('BPO');
    await admin`
      update organisation_memberships set work_scope = 'assigned'
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
    try {
      const response = await settlement(workId);
      // 404 rather than 403: a guessed id must not confirm the Work exists.
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json<{ code: string }>().code).toBe('WORK_NOT_FOUND');
    } finally {
      await admin`
        update organisation_memberships set work_scope = 'all'
        where organisation_id = ${organisationId} and user_id = ${ownerUserId}
      `;
    }
  });
});
