import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  BillPayment,
  BillSettlementResponse,
  RecordBillPaymentRequest,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  createDatabasePool,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
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

function settlement(workId: string) {
  return authed({
    method: 'GET',
    url: `/api/works/${workId}/bill-settlement`,
    organisationId,
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
  const escapedPassword = appPassword.replaceAll("'", "''");
  await admin.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
        CREATE ROLE auto_mb_app LOGIN PASSWORD '${escapedPassword}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END
    $$;
  `);
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
    ).rejects.toThrow(/not closed by a verified railway bill/);
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
    ).rejects.toThrow(/cannot be marked paid/);
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
    ).rejects.toThrow(/would be settled to/);
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
    ).rejects.toThrow(/immutable/);
    await expect(
      admin`
        update bill_payment_deductions set amount = '1.00'
        where bill_payment_id = ${paymentId}
      `,
    ).rejects.toThrow(/immutable/);
  });
});

describe('tenancy and scope', () => {
  it('hides the settlement of another organisation and refuses money against it', async () => {
    const { workId, billId } = await seedBill('BPN');
    // The register answers, and answers with nothing: the stranger is a
    // full-scope member of their OWN organisation, so the work-scope
    // check has no complaint to make and row-level security is what
    // decides. An empty position list is the correct answer to "what do
    // you owe on somebody else's Work", and the same shape every other
    // Work-addressed register in the tree returns.
    const read = await authed({
      method: 'GET',
      url: `/api/works/${workId}/bill-settlement`,
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<BillSettlementResponse>().positions).toEqual([]);

    const write = await record(billId, HALF, strangerCookie);
    expect([403, 404]).toContain(write.statusCode);
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
