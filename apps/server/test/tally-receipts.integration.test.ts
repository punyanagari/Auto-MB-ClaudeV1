import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ImportedPaymentList, TallyReceiptImportResult } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * Railway receipts as imported payments, end to end (migration 0120).
 *
 * EVERY VOUCHER, LEDGER AND FIGURE IN THIS FILE IS INVENTED. The export
 * this wave was built against is a real company's ledger and no row of it
 * may enter the repository; what is reproduced here is its SHAPE.
 *
 * What is proved, in the order the module's risks run:
 *
 *   1. THE PRECONDITION: without the ledger census nothing on a voucher
 *      line can be classified, and the route says so in one sentence
 *      rather than refusing every receipt in the file;
 *   2. PREVIEW WRITES NOTHING. Every other guarantee rests on it;
 *   3. THE ARITHMETIC, ON THE WIRE: gross, net and the per-head lines,
 *      with `gross = net + Σ heads` holding in the database;
 *   4. RULING 17's routes and its queue — a Work proposed from the
 *      security-deposit head, and a receipt with no route imported
 *      unlinked;
 *   5. WHAT IS SKIPPED (wave T4's two populations) and WHAT IS REFUSED
 *      (rulings 19 and 20), both named in the report;
 *   6. IDEMPOTENCY: the same file twice writes nothing the second time;
 *   7. THE WALLS: both authorities, the other organisation, and 0120's
 *      own guards attacked with raw SQL — including the deferred one that
 *      holds the heads against the total.
 *
 * The reader's own cases live in `tally-receipts.test.ts`: it is a pure
 * function and needs no database. What stays here is what it becomes on
 * the wire.
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
const ownerEmail = `tallyrec-owner-${runId}@integration.test`;
const clerkEmail = `tallyrec-clerk-${runId}@integration.test`;
const outsiderEmail = `tallyrec-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let workId: string;
let invoiceId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
/** A writer with NEITHER the import nor the payments authority. */
let clerk: CookieJar;
let outsider: CookieJar;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

async function signUp(email: string, name: string): Promise<CookieJar> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name },
  });
  expect(response.statusCode, `sign-up ${email}: ${response.body}`).toBe(200);
  return { cookie: extractCookies(response.headers['set-cookie']) };
}

async function authed(
  jar: CookieJar,
  options: InjectOptions & { organisationId?: string },
) {
  const { organisationId: org, ...rest } = options;
  return app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      cookie: jar.cookie,
      ...(org !== undefined ? { 'x-organisation-id': org } : {}),
    },
  });
}

/* --- the synthetic receipt export --------------------------------------- */

function utf16(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

interface Leg {
  readonly ledger: string;
  readonly amount?: string;
  readonly bill?: string;
}

interface VoucherSpec {
  readonly guid: string;
  readonly type?: string;
  readonly date?: string;
  readonly number?: string;
  readonly party?: string;
  readonly narration?: string;
  readonly legs: readonly Leg[];
}

function voucher(spec: VoucherSpec): string {
  return [
    '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `     <VOUCHER VCHTYPE="${spec.type ?? 'Receipt'}" ACTION="Create">`,
    '      <LANGUAGENAME.LIST TYPE="String"/>',
    `      <DATE>${spec.date ?? '20240512'}</DATE>`,
    `      <GUID>${spec.guid}</GUID>`,
    `      <VOUCHERTYPENAME>${spec.type ?? 'Receipt'}</VOUCHERTYPENAME>`,
    '      <ALTERID> 4242</ALTERID>',
    ...(spec.number === undefined
      ? []
      : [`      <VOUCHERNUMBER>${spec.number}</VOUCHERNUMBER>`]),
    `      <PARTYLEDGERNAME>${spec.party ?? 'Fixture Division West'}</PARTYLEDGERNAME>`,
    ...(spec.narration === undefined
      ? []
      : [`      <NARRATION>${spec.narration}</NARRATION>`]),
    '      <ISCANCELLED>No</ISCANCELLED>',
    '      <ISOPTIONAL>No</ISOPTIONAL>',
    ...spec.legs.flatMap((entry) => [
      '      <ALLLEDGERENTRIES.LIST>',
      `       <LEDGERNAME>${entry.ledger}</LEDGERNAME>`,
      ...(entry.amount === undefined
        ? []
        : [`       <AMOUNT>${entry.amount}</AMOUNT>`]),
      ...(entry.bill === undefined
        ? []
        : [
            '       <BILLALLOCATIONS.LIST>',
            `        <NAME>${entry.bill}</NAME>`,
            '        <BILLTYPE>Agst Ref</BILLTYPE>',
            '       </BILLALLOCATIONS.LIST>',
          ]),
      '      </ALLLEDGERENTRIES.LIST>',
    ]),
    '     </VOUCHER>',
    '    </TALLYMESSAGE>',
  ].join('\r\n');
}

function envelope(...vouchers: string[]): Buffer {
  return utf16(
    [
      '<ENVELOPE>',
      ' <HEADER>',
      '  <TALLYREQUEST>Export Data</TALLYREQUEST>',
      ' </HEADER>',
      ' <BODY>',
      '  <EXPORTDATA>',
      '   <REQUESTDATA>',
      ...vouchers,
      '   </REQUESTDATA>',
      '  </EXPORTDATA>',
      ' </BODY>',
      '</ENVELOPE>',
    ].join('\r\n'),
  );
}

/**
 * The fixture export, in one place so every test reads the same file.
 *
 *   guid-conforming  the census § 3 shape: five heads, a bill allocation
 *                    naming the seeded invoice, and a security-deposit
 *                    head carrying the seeded Work's code
 *   guid-unlinked    conforming, but nothing on it names a Work — ruling
 *                    17's manual-link queue
 *   guid-roundoff    a credited round-off, folded into the net (ruling 16)
 *   guid-nil-head    a head named with no AMOUNT at all (ruling 10)
 *   guid-two-party   credits two customers — refused (ruling 20)
 *   guid-cust-head   debits a customer as if it were a head (ruling 19)
 *   guid-bank-party  a loan drawdown: wave T4's
 *   guid-plain       a collection with no deduction: wave T4's
 *   guid-payment     a Payment voucher, skipped without being counted
 */
function exportBytes(): Buffer {
  return envelope(
    voucher({
      guid: 'guid-conforming',
      number: 'R-118',
      legs: [
        {
          ledger: 'Fixture Division West',
          amount: '1000000.00',
          bill: 'FIX/2024/0918',
        },
        { ledger: 'Fixture Bank Current A/c', amount: '-880000.00' },
        { ledger: 'SD Fixture West PL-4242', amount: '-50000.00' },
        { ledger: 'TDS on Railway Bills AY 24-25', amount: '-20000.00' },
        { ledger: 'CGST TDS 1%', amount: '-10000.00' },
        { ledger: 'SGST TDS 1%', amount: '-10000.00' },
        { ledger: 'Bill Copy', amount: '-1000.00' },
        { ledger: 'Contracual Deduction', amount: '-29000.00' },
      ],
    }),
    voucher({
      guid: 'guid-unlinked',
      number: 'R-119',
      legs: [
        { ledger: 'Fixture Division West', amount: '5000.00' },
        { ledger: 'Fixture Bank Current A/c', amount: '-4900.00' },
        { ledger: 'CGST TDS 1%', amount: '-100.00' },
      ],
    }),
    voucher({
      guid: 'guid-roundoff',
      number: 'R-120',
      legs: [
        { ledger: 'Fixture Division West', amount: '999.63' },
        { ledger: 'Fixture Round Off', amount: '0.37' },
        { ledger: 'Fixture Bank Current A/c', amount: '-900.00' },
        { ledger: 'CGST TDS 1%', amount: '-100.00' },
      ],
    }),
    voucher({
      guid: 'guid-nil-head',
      number: 'R-121',
      legs: [
        { ledger: 'Fixture Division West', amount: '1000.00' },
        { ledger: 'Fixture Bank Current A/c', amount: '-900.00' },
        { ledger: 'CGST TDS 1%', amount: '-100.00' },
        { ledger: 'Bill Copy' },
      ],
    }),
    voucher({
      guid: 'guid-two-party',
      number: 'R-122',
      legs: [
        { ledger: 'Fixture Division West', amount: '600.00' },
        { ledger: 'Fixture Division East', amount: '400.00' },
        { ledger: 'Fixture Bank Current A/c', amount: '-900.00' },
        { ledger: 'CGST TDS 1%', amount: '-100.00' },
      ],
    }),
    voucher({
      guid: 'guid-cust-head',
      number: 'R-123',
      legs: [
        { ledger: 'Fixture Division West', amount: '1000.00' },
        { ledger: 'Fixture Bank Current A/c', amount: '-900.00' },
        { ledger: 'Fixture Division East', amount: '-100.00' },
      ],
    }),
    voucher({
      guid: 'guid-bank-party',
      number: 'R-124',
      party: 'Fixture Bank Current A/c',
      legs: [
        { ledger: 'Fixture Unsecured Loan', amount: '500000.00' },
        { ledger: 'Fixture Bank Current A/c', amount: '-500000.00' },
      ],
    }),
    voucher({
      guid: 'guid-plain',
      number: 'R-125',
      legs: [
        { ledger: 'Fixture Division West', amount: '2000.00' },
        { ledger: 'Fixture Bank Current A/c', amount: '-2000.00' },
      ],
    }),
    voucher({
      guid: 'guid-payment',
      type: 'Payment',
      number: 'PAY-1',
      legs: [
        { ledger: 'Fixture Bank Current A/c', amount: '99.00' },
        { ledger: 'Some Vendor', amount: '-99.00' },
      ],
    }),
  );
}

async function importReceipts(
  bytes: Buffer,
  mode: 'preview' | 'commit',
  jar: CookieJar = owner,
  org: string = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/tally-receipts/import?filename=Receipts.xml&mode=${mode}`,
    organisationId: org,
    headers: { 'content-type': 'application/xml' },
    payload: bytes,
  });
}

async function counts(): Promise<{
  payments: number;
  deductions: number;
  links: number;
}> {
  const [payments] = await admin<{ count: number }[]>`
    select count(*)::int as count from imported_payments
    where organisation_id = ${organisationId}
  `;
  const [deductions] = await admin<{ count: number }[]>`
    select count(*)::int as count from imported_payment_deductions
    where organisation_id = ${organisationId}
  `;
  const [links] = await admin<{ count: number }[]>`
    select count(*)::int as count from imported_payment_invoice_links
    where organisation_id = ${organisationId}
  `;
  return {
    payments: payments?.count ?? 0,
    deductions: deductions?.count ?? 0,
    links: links?.count ?? 0,
  };
}

/** A census row, written directly: the masters import is proved next door
 * in `tally-masters.integration.test.ts`, and what is under test here is
 * what the receipts do with what it holds. */
async function seedLedger(spec: {
  readonly name: string;
  readonly groupPath: readonly string[];
  readonly classification?: string;
  readonly plCode?: string;
  readonly contactId?: string;
}): Promise<void> {
  await admin`
    insert into tally_ledgers (
      organisation_id, tally_guid, ledger_name, parent_group, group_path,
      classification, pl_code, proposed_contact_id, proposed_contact_method,
      source_filename, imported_by_user_id
    )
    values (
      ${organisationId}, ${`guid-${spec.name}`}, ${spec.name},
      ${spec.groupPath[0] ?? ''}, ${admin.array([...spec.groupPath])}::text[],
      ${spec.classification ?? 'other'}, ${spec.plCode ?? null},
      ${spec.contactId ?? null}, ${spec.contactId === undefined ? null : 'name'},
      'Masters.xml', ${ownerUserId}
    )
  `;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-tally-receipts-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-tallyrec-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Tally Receipt Owner');
  clerk = await signUp(clerkEmail, 'Tally Receipt Clerk');
  outsider = await signUp(outsiderEmail, 'Tally Receipt Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Tally Receipt Works', slug: `tallyrec-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Outsider Works', slug: `tallyrec-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: clerkEmail, role: 'office', canIssueDocuments: true },
  });
  expect(added.statusCode, added.body).toBe(201);

  const [membership] = await admin<{ user_id: string }[]>`
    select user_id from organisation_memberships
    where organisation_id = ${organisationId} and role = 'owner'
  `;
  ownerUserId = membership?.user_id ?? '';
  expect(ownerUserId).not.toBe('');

  // BOTH AUTHORITIES, granted rather than assumed. The import authority
  // alone is what `tally-invoices.ts` takes; this route also takes the
  // payments one, because every row it writes is money — so the test has
  // to grant both to walk the happy path, which is the gate proving
  // itself.
  await admin`
    update organisation_memberships set can_manage_payments = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  const [work] = await admin<{ id: string }[]>`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${randomUUID()}, ${organisationId}, 'PL-4242', 'L-PL-4242', '2024-01-05',
      'Receipt fixture work', '10000000.00', '9000000.00', 'per_schedule',
      ${ownerUserId}
    )
    returning id
  `;
  workId = work?.id ?? '';

  const [invoice] = await admin<{ id: string }[]>`
    insert into imported_invoices (
      organisation_id, source, zoho_invoice_id, invoice_number, invoice_date,
      customer_name, sub_total, total, raw_row, imported_by_user_id
    )
    values (
      ${organisationId}, 'zoho', 'z-1', 'FIX/2024/0918', '2024-04-01',
      'Fixture Division West', '1000000.00', '1000000.00', '{}'::jsonb,
      ${ownerUserId}
    )
    returning id
  `;
  invoiceId = invoice?.id ?? '';
}, 180_000);

afterAll(async () => {
  await app?.close();
  await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
  await admin?.end({ timeout: 5 });
});

describe('the ledger census is a precondition', () => {
  it('refuses the whole file in one sentence when the census is empty', async () => {
    const response = await importReceipts(exportBytes(), 'preview');
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('TALLY_LEDGER_CENSUS_REQUIRED');

    // Now the census exists, and every later test in this file reads it.
    await seedLedger({
      name: 'Fixture Division West',
      groupPath: ['Railway Authority', 'Sundry Debtors', 'Current Assets'],
      classification: 'customer',
    });
    await seedLedger({
      name: 'Fixture Division East',
      groupPath: ['Railway Authority', 'Sundry Debtors', 'Current Assets'],
      classification: 'customer',
    });
    await seedLedger({
      name: 'Fixture Bank Current A/c',
      groupPath: ['Bank Accounts', 'Current Assets'],
    });
    await seedLedger({
      name: 'SD Fixture West PL-4242',
      groupPath: ['Railway Security Deposits', 'Current Assets'],
      classification: 'instrument',
      plCode: 'PL-4242',
    });
    await seedLedger({
      name: 'TDS on Railway Bills AY 24-25',
      groupPath: ['Tds on Railway Bills', 'Current Assets'],
    });
    await seedLedger({
      name: 'CGST TDS 1%',
      groupPath: ['GST- TDS', 'Duties & Taxes', 'Current Liabilities'],
    });
    await seedLedger({
      name: 'SGST TDS 1%',
      groupPath: ['GST- TDS', 'Duties & Taxes', 'Current Liabilities'],
    });
    await seedLedger({
      name: 'Bill Copy',
      groupPath: ['Contractual Deductions', 'Indirect Expenses'],
    });
    await seedLedger({
      name: 'Contracual Deduction',
      groupPath: ['Contractual Deductions', 'Indirect Expenses'],
    });
    await seedLedger({ name: 'Fixture Round Off', groupPath: ['Indirect Expenses'] });
    await seedLedger({
      name: 'Fixture Unsecured Loan',
      groupPath: ['Unsecured Loan', 'Loans (Liability)'],
    });
  });
});

describe('previewing the receipt export', () => {
  it('reports every population and writes nothing', async () => {
    const before = await counts();
    const response = await importReceipts(exportBytes(), 'preview');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyReceiptImportResult>();

    expect(result.mode).toBe('preview');
    expect(result.voucherCount).toBe(9);
    expect(result.receiptCount).toBe(8);
    expect(result.importableCount).toBe(4);
    // Wave T4's two populations, counted rather than silent.
    expect(result.bankPartyCount).toBe(1);
    expect(result.noDeductionCount).toBe(1);
    // Rulings 19 and 20.
    expect(result.refusedCount).toBe(2);
    expect(
      result.receipts
        .filter((row) => row.outcome === 'refused')
        .map((row) => row.voucherNumber),
    ).toStrictEqual(['R-122', 'R-123']);
    // Ruling 10 and ruling 16, both reported.
    expect(result.missingAmountLineCount).toBe(1);
    expect(result.roundOffLineCount).toBe(1);
    expect(result.roundOffTotal).toBe('-0.37');
    // Ruling 17: one receipt reaches a Work, three do not.
    expect(result.workLinkedCount).toBe(1);
    expect(result.unlinkedCount).toBe(3);
    expect(result.invoiceLinkCount).toBe(1);

    expect(result.grossTotal).toBe('1006999.63');
    expect(result.netTotal).toBe('886699.63');
    expect(result.deductionTotal).toBe('120300.00');
    // The head breakdown, which is the point of the wave. Every head is
    // reported including the two that are empty.
    expect(
      Object.fromEntries(result.heads.map((row) => [row.head, row.amount])),
    ).toStrictEqual({
      gst_tds: '20300.00',
      income_tax_tds: '20000.00',
      security_deposit: '50000.00',
      retention: '0.00',
      liquidated_damages: '29000.00',
      other: '1000.00',
    });

    expect(result.importedPaymentCount).toBe(0);
    expect(await counts()).toStrictEqual(before);
  });
});

describe('committing the receipt export', () => {
  it('writes the payments, their heads and their allocations', async () => {
    const response = await importReceipts(exportBytes(), 'commit');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyReceiptImportResult>();
    expect(result.importedPaymentCount).toBe(4);
    // Six heads on the conforming receipt, one each on the unlinked and
    // the rounded one, two on the one carrying a head with no amount.
    expect(result.importedDeductionCount).toBe(10);
    expect(result.importedInvoiceLinkCount).toBe(1);

    const [row] = await admin<
      {
        gross_amount: string;
        net_amount: string;
        deduction_total: string;
        round_off_amount: string;
        work_id: string | null;
        work_link_method: string | null;
        counterparty_ledger: string;
        tally_alterid: string;
      }[]
    >`
      select gross_amount, net_amount, deduction_total, round_off_amount,
             work_id, work_link_method, counterparty_ledger, tally_alterid
      from imported_payments
      where organisation_id = ${organisationId} and tally_guid = 'guid-conforming'
    `;
    expect(row?.gross_amount).toBe('1000000.00');
    expect(row?.net_amount).toBe('880000.00');
    expect(row?.deduction_total).toBe('120000.00');
    expect(row?.counterparty_ledger).toBe('Fixture Division West');
    // RULING 17's FIRST ROUTE: the security-deposit head names the Work.
    expect(row?.work_id).toBe(workId);
    expect(row?.work_link_method).toBe('sd_ledger');
    // Ruling 2: the edit counter rides on every imported row.
    expect(row?.tally_alterid).toBe('4242');

    const heads = await admin<
      { head: string; amount: string; pl_code: string | null }[]
    >`
      select d.head, d.amount, d.pl_code
      from imported_payment_deductions d
      join imported_payments p on p.id = d.imported_payment_id
      where p.tally_guid = 'guid-conforming'
      order by d.tally_ledger_name
    `;
    expect(heads.map((head) => [head.head, head.amount])).toStrictEqual([
      ['other', '1000.00'],
      ['gst_tds', '10000.00'],
      // The owner's ruling of 23 Aug 2026 on question 14, in the database.
      ['liquidated_damages', '29000.00'],
      ['security_deposit', '50000.00'],
      ['gst_tds', '10000.00'],
      ['income_tax_tds', '20000.00'],
    ]);
    expect(heads.find((head) => head.head === 'security_deposit')?.pl_code).toBe(
      'PL-4242',
    );

    // Ruling 10, in the database rather than only in the report.
    const [nil] = await admin<{ amount: string; amount_missing: boolean }[]>`
      select d.amount, d.amount_missing
      from imported_payment_deductions d
      join imported_payments p on p.id = d.imported_payment_id
      where p.tally_guid = 'guid-nil-head' and d.tally_ledger_name = 'Bill Copy'
    `;
    expect(nil?.amount).toBe('0.00');
    expect(nil?.amount_missing).toBe(true);

    // Ruling 16: the credited round-off lowered the net and became no head.
    const [rounded] = await admin<
      { net_amount: string; round_off_amount: string; deduction_total: string }[]
    >`
      select net_amount, round_off_amount, deduction_total from imported_payments
      where tally_guid = 'guid-roundoff'
    `;
    expect(rounded?.net_amount).toBe('899.63');
    expect(rounded?.round_off_amount).toBe('-0.37');
    expect(rounded?.deduction_total).toBe('100.00');

    // The bill allocation reached the register row it names.
    const [link] = await admin<
      { imported_invoice_id: string; tally_bill_reference: string }[]
    >`
      select l.imported_invoice_id, l.tally_bill_reference
      from imported_payment_invoice_links l
      join imported_payments p on p.id = l.imported_payment_id
      where p.tally_guid = 'guid-conforming'
    `;
    expect(link?.imported_invoice_id).toBe(invoiceId);
    expect(link?.tally_bill_reference).toBe('FIX/2024/0918');

    // ONE AUDIT EVENT FOR THE IMPORT, not one per receipt.
    const [audited] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where organisation_id = ${organisationId}
        and action = 'imported_payment.imported'
    `;
    expect(audited?.count).toBe(1);
  });

  it('reads the register back with its head breakdown and its queue', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/imported-payments',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<ImportedPaymentList>();
    expect(page.payments).toHaveLength(4);
    expect(page.totals?.count).toBe(4);
    expect(page.totals?.gross).toBe('1006999.63');
    expect(page.totals?.deductionTotal).toBe('120300.00');
    // Ruling 17's queue, counted on the register the operator reads.
    expect(page.totals?.unlinkedCount).toBe(3);
    expect(
      page.totals?.heads.find((head) => head.head === 'liquidated_damages')?.amount,
    ).toBe('29000.00');
    expect(page.totals?.heads.find((head) => head.head === 'retention')?.amount).toBe(
      '0.00',
    );

    const linked = await authed(owner, {
      method: 'GET',
      url: '/api/imported-payments?linked=unlinked',
      organisationId,
    });
    expect(linked.json<ImportedPaymentList>().payments).toHaveLength(3);

    const conforming = page.payments.find((row) => row.tallyGuid === 'guid-conforming');
    expect(conforming?.workCode).toBe('PL-4242');
    expect(conforming?.deductions).toHaveLength(6);
    expect(conforming?.invoiceLinks[0]?.invoiceNumber).toBe('FIX/2024/0918');
  });

  it('writes nothing the second time the same file is read', async () => {
    const before = await counts();
    const response = await importReceipts(exportBytes(), 'commit');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyReceiptImportResult>();
    expect(result.importedPaymentCount).toBe(0);
    expect(result.alreadyReadCount).toBe(4);
    expect(await counts()).toStrictEqual(before);
  });
});

describe('the walls', () => {
  it('refuses a writer holding neither authority, before it reads the body', async () => {
    const response = await importReceipts(exportBytes(), 'preview', clerk);
    expect(response.statusCode, response.body).toBe(403);
  });

  it('refuses a member of another organisation', async () => {
    const response = await importReceipts(
      exportBytes(),
      'preview',
      outsider,
      organisationId,
    );
    expect(response.statusCode).toBe(403);
  });

  it('refuses an edit or a delete of an imported payment (23T04)', async () => {
    await expect(
      admin`
        update imported_payments set gross_amount = '1.00'
        where organisation_id = ${organisationId} and tally_guid = 'guid-conforming'
      `,
    ).rejects.toThrow(/never edited or deleted/);
    await expect(
      admin`
        delete from imported_payments
        where organisation_id = ${organisationId} and tally_guid = 'guid-conforming'
      `,
    ).rejects.toThrow(/never edited or deleted/);
  });

  it('refuses heads that do not sum to the stated total, at commit (23T05)', async () => {
    await expect(
      admin.begin(async (tx) => {
        const [payment] = await tx<{ id: string }[]>`
          insert into imported_payments (
            organisation_id, tally_guid, tally_voucher_date, tally_party_ledger,
            counterparty_ledger, gross_amount, net_amount, deduction_total,
            source_filename, imported_by_user_id
          )
          values (
            ${organisationId}, ${`guid-attack-${runId}`}, '2024-05-12',
            'Fixture Division West', 'Fixture Division West',
            1000.00, 900.00, 100.00, 'attack.xml', ${ownerUserId}
          )
          returning id
        `;
        await tx`
          insert into imported_payment_deductions (
            organisation_id, imported_payment_id, head, tally_ledger_name, amount
          )
          values (
            ${organisationId}, ${payment?.id ?? ''}, 'gst_tds', 'CGST TDS 1%', 60.00
          )
        `;
      }),
    ).rejects.toThrow(/gross = net \+ heads/);
  });

  it('refuses an allocation naming a discarded invoice (23T06)', async () => {
    const [discarded] = await admin<{ id: string }[]>`
      insert into imported_invoices (
        organisation_id, source, zoho_invoice_id, invoice_number, invoice_date,
        customer_name, sub_total, total, raw_row, imported_by_user_id,
        discarded_at, discarded_by_user_id, discard_reason
      )
      values (
        ${organisationId}, 'zoho', ${`z-gone-${runId}`}, 'FIX/2024/9999',
        '2024-04-01', 'Fixture Division West', '1.00', '1.00', '{}'::jsonb,
        ${ownerUserId}, now(), ${ownerUserId}, 'withdrawn by the fixture'
      )
      returning id
    `;
    const [payment] = await admin<{ id: string }[]>`
      select id from imported_payments
      where organisation_id = ${organisationId} and tally_guid = 'guid-conforming'
    `;
    await expect(
      admin`
        insert into imported_payment_invoice_links (
          organisation_id, imported_payment_id, imported_invoice_id,
          tally_bill_reference, match_method
        )
        values (
          ${organisationId}, ${payment?.id ?? ''}, ${discarded?.id ?? ''},
          'FIX/2024/9999', 'exact_number'
        )
      `,
    ).rejects.toThrow(/discarded/);
  });
});
