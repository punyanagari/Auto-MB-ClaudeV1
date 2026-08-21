import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ImportedInvoiceDetail,
  ImportedInvoiceImportResult,
  ImportedInvoiceList,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * The historical Zoho Books invoice register, end to end (migration 0115).
 *
 * EVERY ROW IN THIS FILE IS INVENTED. The export this feature was built
 * against is a real customer's billing history and no part of it may enter
 * the repository; what is reproduced here is its SHAPE — one CSV row per
 * line, invoice-level columns repeated across the lines of one invoice, a
 * `Draft` status on an e-invoiced row, a private order with no reference
 * text — with values that belong to nobody.
 *
 * What is proved, in the order the module's risks run:
 *
 *   1. PREVIEW WRITES NOTHING. Every other guarantee rests on it, so the
 *      register is counted before and after;
 *   2. the proposal an operator confirms: which Work, from what evidence,
 *      and — the half that matters — which invoices were NOT linked;
 *   3. the commit, its lines, and its derived issued-ness;
 *   4. IDEMPOTENCE: the same file twice adds nothing and rewrites nothing,
 *      which is what makes a re-export safe;
 *   5. the two annotations and the discard;
 *   6. the walls: the import authority, the other organisation, and the
 *      database's own arm attacked with raw SQL.
 *
 * The reader's own cases live in `zoho-invoices.test.ts` and the CSV
 * parser's in `csv.test.ts`: both are pure functions of some text and
 * neither needs a database, an organisation or a session. What stays here
 * is what each of them becomes on the wire.
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
const ownerEmail = `zoho-owner-${runId}@integration.test`;
const clerkEmail = `zoho-clerk-${runId}@integration.test`;
const outsiderEmail = `zoho-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let workId: string;
let contactId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
/** A writer WITHOUT the import authority. */
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

/* --- the synthetic export ---------------------------------------------------- */

const HEADER = [
  'Invoice Date',
  'Invoice ID',
  'Invoice Number',
  'Invoice Status',
  'Customer ID',
  'Customer Name',
  'Place of Supply',
  'PurchaseOrder',
  'SubTotal',
  'Total',
  'Balance',
  'e-Invoice Reference Number',
  'e-Invoice Ack Number',
  'e-Invoice Ack Date',
  'Item Name',
  'Item Desc',
  'Quantity',
  'Usage unit',
  'Item Price',
  'Item Total',
  'GST Identification Number (GSTIN)',
  'HSN/SAC',
  'Round Off',
  'Supply Type',
  'CGST Rate %',
  'SGST Rate %',
  'CGST',
  'SGST',
];

function csv(rows: readonly Readonly<Record<string, string>>[]): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return [
    HEADER.join(','),
    ...rows.map((row) => HEADER.map((column) => quote(row[column] ?? '')).join(',')),
  ].join('\r\n');
}

const BASE: Readonly<Record<string, string>> = {
  'Invoice Date': '2023-04-07',
  'Invoice Status': 'Draft',
  'Customer ID': 'C-1',
  'Customer Name': 'Zoho Fixture Railway',
  'Place of Supply': 'Maharashtra',
  SubTotal: '10000.00',
  Total: '11800.00',
  Balance: '11800.00',
  Quantity: '10.00',
  'Usage unit': 'Nos',
  'Item Price': '1000.000',
  'Item Total': '10000.00',
  'GST Identification Number (GSTIN)': '27AAACR1234A1ZP',
  'HSN/SAC': '85308000',
  'Round Off': '0.00',
  'Supply Type': 'Taxable',
  'CGST Rate %': '9',
  'SGST Rate %': '9',
  CGST: '900.00',
  SGST: '900.00',
};

/**
 * Four invoices across five rows:
 *
 *   1001  linkable by v1 work code, e-invoiced, TWO lines
 *   1002  linkable by LOA letter number, e-invoiced
 *   1003  a private order — no reference, no Work, no IRN
 *   1004  names two Works, so nothing may be proposed for it
 */
function exportRows(workCode: string, letterNumber: string) {
  return [
    {
      ...BASE,
      'Invoice ID': '1001',
      'Invoice Number': 'FIX/23-24/001',
      PurchaseOrder: `Supply against ${workCode}`,
      'e-Invoice Reference Number': 'a'.repeat(64),
      'e-Invoice Ack Number': '112300001',
      'e-Invoice Ack Date': '2023-04-07 15:22:00',
      'Item Name': 'Signal lamp',
      'Item Desc': 'LED signal lamp, 110V',
    },
    {
      ...BASE,
      'Invoice ID': '1001',
      'Invoice Number': 'FIX/23-24/001',
      PurchaseOrder: `Supply against ${workCode}`,
      'e-Invoice Reference Number': 'a'.repeat(64),
      'e-Invoice Ack Number': '112300001',
      'e-Invoice Ack Date': '2023-04-07 15:22:00',
      'Item Name': 'Mounting bracket',
      'Item Desc': 'Galvanised bracket\nwith fasteners',
      Quantity: '4.00',
      'Item Price': '125.500',
      'Item Total': '502.00',
    },
    {
      ...BASE,
      'Invoice Date': '2024-05-11',
      'Invoice ID': '1002',
      'Invoice Number': 'FIX/24-25/014',
      PurchaseOrder: `Ref ${letterNumber.toLowerCase()}`,
      'e-Invoice Reference Number': 'b'.repeat(64),
      'Item Name': 'Point machine spares',
    },
    {
      ...BASE,
      'Invoice Date': '2024-06-02',
      'Invoice ID': '1003',
      'Invoice Number': 'FIX/24-25/020',
      'Customer Name': 'Zoho Fixture Electricals',
      'GST Identification Number (GSTIN)': '27AAACZ9876Z1ZQ',
      PurchaseOrder: '',
      'Invoice Status': 'Overdue',
      'Item Name': 'Control panel',
      'Item Desc': 'Custom build',
    },
    {
      ...BASE,
      'Invoice Date': '2024-07-19',
      'Invoice ID': '1004',
      'Invoice Number': 'FIX/24-25/031',
      PurchaseOrder: `Both ${workCode} and PL-9002`,
      'Item Name': 'Assorted',
    },
  ];
}

async function importCsv(
  text: string,
  options: {
    readonly mode?: 'preview' | 'commit';
    readonly jar?: CookieJar;
    readonly org?: string;
    readonly filename?: string;
  } = {},
) {
  return authed(options.jar ?? owner, {
    method: 'POST',
    url: `/api/imported-invoices/import?mode=${options.mode ?? 'preview'}&filename=${encodeURIComponent(options.filename ?? 'Invoice.csv')}`,
    organisationId: options.org ?? organisationId,
    headers: { 'content-type': 'text/csv' },
    payload: Buffer.from(text, 'utf8'),
  });
}

async function countRegister(): Promise<number> {
  const [row] = await admin<{ count: string }[]>`
    select count(*)::text as count from imported_invoices
    where organisation_id = ${organisationId}
  `;
  return Number(row?.count ?? '0');
}

let exportCsv = '';
let workCode = '';
let letterNumber = '';

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-imported-invoices-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-zoho-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Zoho Owner');
  clerk = await signUp(clerkEmail, 'Zoho Clerk');
  outsider = await signUp(outsiderEmail, 'Zoho Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Zoho Fixture Works', slug: `zoho-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Outsider Works', slug: `zoho-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: {
      email: clerkEmail,
      role: 'office',
      canIssueDocuments: true,
      canCancelDocuments: true,
    },
  });
  expect(added.statusCode, added.body).toBe(201);

  // A Work whose v1 code is the one the fixture's reference text names,
  // and whose LOA letter number the second invoice cites. Written
  // directly because the LOA intake flow is not what is under test here.
  workCode = `PL-9001`;
  letterNumber = `LOA/FIX/${runId.slice(0, 4)}/0099`;
  const [work] = await admin<{ id: string }[]>`
    insert into works (
      organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${organisationId}, ${workCode}, ${letterNumber}, '2023-01-15',
      'Zoho fixture work', '100000.00', '95000.00', 'per_schedule',
      (select user_id from organisation_memberships
        where organisation_id = ${organisationId} and role = 'owner')
    )
    returning id
  `;
  workId = work?.id ?? '';
  expect(workId).not.toBe('');

  // A SECOND Work, so the ambiguous invoice is genuinely ambiguous. With
  // only one of the two codes belonging to a real Work the reference
  // "Both PL-9001 and PL-9002" resolves cleanly — which is correct
  // behaviour and the wrong fixture: the branch under test is two codes
  // naming two DIFFERENT Works, and it needs both of them to exist.
  await admin`
    insert into works (
      organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${organisationId}, 'PL-9002', ${`${letterNumber}/B`}, '2023-01-16',
      'Zoho fixture second work', '100000.00', '95000.00', 'per_schedule',
      (select user_id from organisation_memberships
        where organisation_id = ${organisationId} and role = 'owner')
    )
  `;

  const [contact] = await admin<{ id: string }[]>`
    insert into contacts (
      organisation_id, designation, gstin, is_client, created_by_user_id
    )
    values (
      ${organisationId}, 'Zoho Fixture Railway', '27AAACR1234A1ZP', true,
      (select user_id from organisation_memberships
        where organisation_id = ${organisationId} and role = 'owner')
    )
    returning id
  `;
  contactId = contact?.id ?? '';
  expect(contactId).not.toBe('');

  exportCsv = csv(exportRows(workCode, letterNumber));
}, 180_000);

afterAll(async () => {
  await app?.close();
  await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
  await admin?.end({ timeout: 5 });
});

describe('previewing the export', () => {
  it('proposes, names every unlinked invoice, and writes nothing', async () => {
    const before = await countRegister();
    const response = await importCsv(exportCsv);
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<ImportedInvoiceImportResult>();

    expect(result.mode).toBe('preview');
    expect(result.invoiceCount).toBe(4);
    // Five CSV rows, four invoices: the difference is the multi-line one.
    expect(result.lineCount).toBe(5);
    expect(result.importedCount).toBe(0);

    const byId = new Map(result.invoices.map((row) => [row.zohoInvoiceId, row]));
    expect(byId.get('1001')?.linkMethod).toBe('pl_code');
    expect(byId.get('1001')?.workCode).toBe(workCode);
    expect(byId.get('1001')?.linkEvidence).toContain('PL-9001');
    expect(byId.get('1002')?.linkMethod).toBe('loa_match');
    // The private order and the ambiguous one are both reported by name
    // rather than being silently absent, which is the whole point of the
    // confirmation step.
    expect(byId.get('1003')?.workId).toBeNull();
    expect(byId.get('1004')?.workId).toBeNull();
    expect(result.unlinkedCount).toBe(2);
    expect(result.proposedLinkCount).toBe(2);

    // The customer with a master row is matched; the one without is
    // named so somebody can add it.
    expect(byId.get('1001')?.contactId).toBe(contactId);
    expect(result.unmatchedCustomers).toEqual(['Zoho Fixture Electricals']);

    expect(await countRegister()).toBe(before);
  }, 60_000);

  it('refuses a file that is not the invoice export', async () => {
    const response = await importCsv('name,address\r\nA,B');
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('ZOHO_EXPORT_UNREADABLE');
  }, 30_000);

  it('refuses a binary body before the reader ever sees it', async () => {
    const response = await importCsv('');
    expect(response.statusCode).toBe(400);
    const zipped = await authed(owner, {
      method: 'POST',
      url: '/api/imported-invoices/import?mode=preview&filename=Invoice.csv',
      organisationId,
      headers: { 'content-type': 'text/csv' },
      payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
    });
    expect(zipped.statusCode).toBe(400);
    expect(zipped.json<{ code: string }>().code).toBe('ZOHO_EXPORT_UNREADABLE');
  }, 30_000);
});

describe('committing the export', () => {
  let importedId = '';

  it('writes the invoices, their lines and their proposed links', async () => {
    const response = await importCsv(exportCsv, { mode: 'commit' });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<ImportedInvoiceImportResult>();
    expect(result.importedCount).toBe(4);

    const list = await authed(owner, {
      method: 'GET',
      url: '/api/imported-invoices',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    const register = list.json<ImportedInvoiceList>();
    expect(register.totals.invoiceCount).toBe(4);
    expect(register.totals.linkedCount).toBe(2);
    // Four invoices of 11800.00 each, summed by the database rather than
    // in JavaScript.
    expect(register.totals.totalValue).toBe('47200.00');
    // Newest first.
    expect(register.invoices[0]?.invoiceDate).toBe('2024-07-19');

    const first = register.invoices.find((row) => row.zohoInvoiceId === '1001');
    expect(first).toBeDefined();
    importedId = first?.id ?? '';
    // The export said Draft; it carries an IRN, so it was issued.
    expect(first?.zohoStatus).toBe('Draft');
    expect(first?.issued).toBe(true);
    expect(first?.workCode).toBe(workCode);
    expect(first?.linkMethod).toBe('pl_code');
    expect(first?.lineCount).toBe(2);

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/imported-invoices/${importedId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const { lines } = detail.json<ImportedInvoiceDetail>();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.position).toBe(1);
    // The rate keeps its third digit; the line total is money.
    expect(lines[1]?.itemPrice).toBe('125.500000');
    expect(lines[1]?.itemTotal).toBe('502.00');
    expect(lines[1]?.itemDescription).toContain('with fasteners');

    // The raw row is the truth source and the whole of it is kept.
    const [raw] = await admin<{ raw_row: Record<string, string> }[]>`
      select raw_row from imported_invoices where id = ${importedId}
    `;
    expect(raw?.raw_row['Invoice Number']).toBe('FIX/23-24/001');
    expect(raw?.raw_row['CGST Rate %']).toBe('9');

    // One audit event per imported invoice, naming the file.
    const [events] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId}
        and action = 'imported_invoice.imported'
    `;
    expect(Number(events?.count ?? '0')).toBe(4);
  }, 60_000);

  it('adds nothing and rewrites nothing when the same file is uploaded again', async () => {
    // The property that makes a re-export safe, and the reason the
    // register needs no staging table.
    const before = await countRegister();
    const again = await importCsv(exportCsv, { mode: 'commit' });
    expect(again.statusCode, again.body).toBe(200);
    const result = again.json<ImportedInvoiceImportResult>();
    expect(result.importedCount).toBe(0);
    expect(result.alreadyImportedCount).toBe(4);
    expect(result.invoices.every((row) => row.alreadyImported)).toBe(true);
    expect(await countRegister()).toBe(before);

    const [lines] = await admin<{ count: string }[]>`
      select count(*)::text as count from imported_invoice_lines
      where organisation_id = ${organisationId}
    `;
    expect(Number(lines?.count ?? '0')).toBe(5);
  }, 60_000);

  it('does not rewrite an invoice whose amount changed in a second export', async () => {
    const edited = csv(
      exportRows(workCode, letterNumber).map((row) =>
        row['Invoice ID'] === '1001' ? { ...row, Total: '99999.00' } : row,
      ),
    );
    const response = await importCsv(edited, { mode: 'commit' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ImportedInvoiceImportResult>().importedCount).toBe(0);
    const [row] = await admin<{ total: string }[]>`
      select total from imported_invoices where id = ${importedId}
    `;
    expect(row?.total).toBe('11800.00');
  }, 60_000);

  it('filters by Work, by linked state and by financial year', async () => {
    const byWork = await authed(owner, {
      method: 'GET',
      url: `/api/imported-invoices?work=${workId}`,
      organisationId,
    });
    expect(byWork.statusCode, byWork.body).toBe(200);
    expect(byWork.json<ImportedInvoiceList>().totals.invoiceCount).toBe(2);

    const unlinked = await authed(owner, {
      method: 'GET',
      url: '/api/imported-invoices?linked=unlinked',
      organisationId,
    });
    expect(unlinked.json<ImportedInvoiceList>().totals.invoiceCount).toBe(2);

    // 2023-24 is 1 April 2023 to 31 March 2024: one of the four.
    const fy = await authed(owner, {
      method: 'GET',
      url: '/api/imported-invoices?financialYear=2023',
      organisationId,
    });
    expect(fy.json<ImportedInvoiceList>().totals.invoiceCount).toBe(1);
  }, 60_000);
});

describe('the two annotations and the exit', () => {
  async function idOf(zohoInvoiceId: string): Promise<string> {
    const [row] = await admin<{ id: string }[]>`
      select id from imported_invoices
      where organisation_id = ${organisationId}
        and zoho_invoice_id = ${zohoInvoiceId}
    `;
    return row?.id ?? '';
  }

  it('files an unlinked invoice against a Work by hand, as a manual link', async () => {
    const id = await idOf('1004');
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/imported-invoices/${id}/link`,
      organisationId,
      payload: { workId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { invoice } = response.json<ImportedInvoiceDetail>();
    expect(invoice.workId).toBe(workId);
    // A link a person made is `manual` whatever the machine thought:
    // the proposal happens once, at import.
    expect(invoice.linkMethod).toBe('manual');
  }, 30_000);

  it('clears a link with an explicit null', async () => {
    const id = await idOf('1004');
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/imported-invoices/${id}/link`,
      organisationId,
      payload: { workId: null },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { invoice } = response.json<ImportedInvoiceDetail>();
    expect(invoice.workId).toBeNull();
    expect(invoice.linkMethod).toBeNull();
  }, 30_000);

  it('refuses a link request that names neither a Work nor a customer', async () => {
    const id = await idOf('1004');
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/imported-invoices/${id}/link`,
      organisationId,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('IMPORTED_INVOICE_LINK_EMPTY');
  }, 30_000);

  it('discards an invoice and refuses everything afterwards', async () => {
    const id = await idOf('1003');
    const discarded = await authed(owner, {
      method: 'POST',
      url: `/api/imported-invoices/${id}/discard`,
      organisationId,
      payload: { reason: 'Imported from the wrong export' },
    });
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(discarded.json<ImportedInvoiceDetail>().invoice.discardedAt).not.toBeNull();

    const again = await authed(owner, {
      method: 'POST',
      url: `/api/imported-invoices/${id}/link`,
      organisationId,
      payload: { workId },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('IMPORTED_INVOICE_DISCARDED');

    // Discarded rows leave the register unless they are asked for.
    const list = await authed(owner, {
      method: 'GET',
      url: '/api/imported-invoices',
      organisationId,
    });
    expect(list.json<ImportedInvoiceList>().totals.invoiceCount).toBe(3);
    const withDiscarded = await authed(owner, {
      method: 'GET',
      url: '/api/imported-invoices?includeDiscarded=true',
      organisationId,
    });
    expect(withDiscarded.json<ImportedInvoiceList>().totals.invoiceCount).toBe(4);
  }, 60_000);
});

describe('the walls', () => {
  it('refuses an import from a writer without the import authority', async () => {
    const response = await importCsv(exportCsv, { jar: clerk });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
  }, 30_000);

  it('lets that writer READ the register', async () => {
    // Which invoices this organisation raised in 2023 is ordinary
    // register history; the authority governs pointing a file at it.
    const response = await authed(clerk, {
      method: 'GET',
      url: '/api/imported-invoices',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
  }, 30_000);

  it('shows another organisation nothing of this one', async () => {
    const response = await authed(outsider, {
      method: 'GET',
      url: '/api/imported-invoices',
      organisationId: outsiderOrganisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ImportedInvoiceList>().invoices).toEqual([]);

    const [row] = await admin<{ id: string }[]>`
      select id from imported_invoices where organisation_id = ${organisationId} limit 1
    `;
    const byId = await authed(outsider, {
      method: 'GET',
      url: `/api/imported-invoices/${row?.id ?? ''}`,
      organisationId: outsiderOrganisationId,
    });
    expect(byId.statusCode).toBe(404);
  }, 30_000);

  it('refuses a rewrite of the export’s own facts, at the database', async () => {
    // The arm that holds against a writer reaching the table another
    // way. Attacked as the ADMIN role, which RLS does not narrow, so
    // what refuses this is the guard rather than the policy.
    const [row] = await admin<{ id: string }[]>`
      select id from imported_invoices where organisation_id = ${organisationId} limit 1
    `;
    const id = row?.id ?? '';
    await expect(
      admin`update imported_invoices set total = '1.00' where id = ${id}`,
    ).rejects.toMatchObject({ code: '23X01' });
    await expect(
      admin`update imported_invoices set raw_row = '{}'::jsonb where id = ${id}`,
    ).rejects.toMatchObject({ code: '23X01' });
    // …and a line is never edited at all.
    await expect(
      admin`
        update imported_invoice_lines set item_total = '1.00'
        where organisation_id = ${organisationId}
      `,
    ).rejects.toMatchObject({ code: '23X02' });
  }, 30_000);

  it('refuses a line added to a discarded invoice', async () => {
    const [row] = await admin<{ id: string }[]>`
      select id from imported_invoices
      where organisation_id = ${organisationId} and discarded_at is not null
      limit 1
    `;
    await expect(
      admin`
        insert into imported_invoice_lines (
          organisation_id, imported_invoice_id, position, raw_row
        )
        values (${organisationId}, ${row?.id ?? ''}, 99, '{}'::jsonb)
      `,
    ).rejects.toMatchObject({ code: '23X02' });
  }, 30_000);
});
