import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ImportedInvoiceList, TallyInvoiceImportResult } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * The Tally ↔ Zoho invoice cross-reference, end to end (migration 0119).
 *
 * EVERY VOUCHER AND EVERY INVOICE IN THIS FILE IS INVENTED. The exports
 * this wave was built against are a real company's ledger and a real
 * company's billing history; no party name, document number or figure of
 * either may enter the repository. What is reproduced here is their
 * SHAPE, with values that belong to nobody.
 *
 * What is proved, in the order the module's risks run:
 *
 *   1. PREVIEW WRITES NOTHING. Every other guarantee rests on it, so both
 *      tables are counted before and after;
 *   2. THE MATCH AND ITS GUARD: an exact number, a renumbered serial
 *      confirmed by the amount, and the false collision the census found —
 *      which must be refused, because a serial alone is not a key;
 *   3. THE TWO OUTCOMES: an invoice both systems hold gains a
 *      cross-reference and NO second register row (ruling 23), and one
 *      only Tally holds becomes a register row behind the `tally` source;
 *   4. RULING 21: a disagreeing component imports both figures, flags
 *      them, and the flagged invoice leaves the register's billed total;
 *   5. RULING 22: cancelled and optional vouchers are skipped and NAMED;
 *   6. IDEMPOTENCY: the same file twice writes nothing the second time;
 *   7. the walls: the import authority, the other organisation, and the
 *      database's own guards attacked with raw SQL.
 *
 * The reader's and the matcher's own cases live in
 * `tally-vouchers.test.ts`: both are pure functions and need no
 * database. What stays here is what they become on the wire.
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
const ownerEmail = `tallyinv-owner-${runId}@integration.test`;
const clerkEmail = `tallyinv-clerk-${runId}@integration.test`;
const outsiderEmail = `tallyinv-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;

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

/* --- the synthetic voucher export -------------------------------------------- */

function utf16(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

interface VoucherSpec {
  readonly guid: string;
  readonly type?: string;
  readonly date?: string;
  readonly number?: string;
  readonly reference?: string;
  readonly party?: string;
  readonly gstin?: string;
  readonly narration?: string;
  readonly amount: string;
  readonly cancelled?: boolean;
  readonly optional?: boolean;
  /** `LEDGERENTRIES.LIST` rather than `ALLLEDGERENTRIES.LIST` — what an
   * inventory-mode sales voucher writes, which is two thirds of the real
   * ones. */
  readonly inventoryMode?: boolean;
}

function voucher(spec: VoucherSpec): string {
  const party = spec.party ?? 'Fixture Division West';
  const tag =
    spec.inventoryMode === true ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
  return [
    '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `     <VOUCHER VCHTYPE="${spec.type ?? 'Sales'}" ACTION="Create">`,
    '      <LANGUAGENAME.LIST TYPE="String"/>',
    `      <DATE>${spec.date ?? '20210715'}</DATE>`,
    `      <GUID>${spec.guid}</GUID>`,
    `      <VOUCHERTYPENAME>${spec.type ?? 'Sales'}</VOUCHERTYPENAME>`,
    '      <ALTERID> 4242</ALTERID>',
    ...(spec.number === undefined
      ? []
      : [`      <VOUCHERNUMBER>${spec.number}</VOUCHERNUMBER>`]),
    ...(spec.reference === undefined
      ? []
      : [`      <REFERENCE>${spec.reference}</REFERENCE>`]),
    `      <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>`,
    ...(spec.gstin === undefined
      ? []
      : [`      <PARTYGSTIN>${spec.gstin}</PARTYGSTIN>`]),
    ...(spec.narration === undefined
      ? []
      : [`      <NARRATION>${spec.narration}</NARRATION>`]),
    `      <ISCANCELLED>${spec.cancelled === true ? 'Yes' : 'No'}</ISCANCELLED>`,
    `      <ISOPTIONAL>${spec.optional === true ? 'Yes' : 'No'}</ISOPTIONAL>`,
    `      <${tag}>`,
    `       <LEDGERNAME>${party}</LEDGERNAME>`,
    `       <AMOUNT>-${spec.amount}</AMOUNT>`,
    `      </${tag}>`,
    `      <${tag}>`,
    '       <LEDGERNAME>Sales Account</LEDGERNAME>',
    `       <AMOUNT>${spec.amount}</AMOUNT>`,
    `      </${tag}>`,
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
 *   guid-exact       matches the Zoho invoice P0100001 outright
 *   guid-serial      the renumbered document: P0700002 against Zoho's
 *                    P0100002, confirmed by the amount
 *   guid-collision   the census's false collision: the same serial as
 *                    P0100003, a different customer and a different
 *                    amount, so the guard must refuse it
 *   guid-pre-zoho    2021 billing Zoho never held — becomes a register row
 *   guid-disputed    matches P0100004 by number and disagrees in value
 *   guid-cancelled   cancelled in Tally (ruling 22)
 *   guid-optional    marked optional (ruling 22)
 *   guid-credit      a credit note, read and not imported
 *   guid-payment     a Payment voucher, skipped without being counted
 */
function exportBytes(): Buffer {
  return envelope(
    voucher({ guid: 'guid-exact', number: 'P01/00001', amount: '11800.00' }),
    voucher({
      guid: 'guid-serial',
      number: 'P0700002',
      amount: '25000.00',
      inventoryMode: true,
    }),
    voucher({
      guid: 'guid-collision',
      number: 'P0900003',
      amount: '777000.00',
      party: 'Fixture Division East',
    }),
    voucher({
      guid: 'guid-pre-zoho',
      number: 'P0100900',
      date: '20210401',
      amount: '4500.00',
      narration: 'Supply against PL-4242 for the fixture division',
    }),
    voucher({ guid: 'guid-disputed', number: 'P0100004', amount: '90000.00' }),
    voucher({
      guid: 'guid-cancelled',
      number: 'P0100005',
      amount: '100.00',
      cancelled: true,
    }),
    voucher({
      guid: 'guid-optional',
      number: 'P0100006',
      amount: '100.00',
      optional: true,
    }),
    voucher({
      guid: 'guid-credit',
      type: 'Credit Note',
      number: 'P0100001',
      amount: '500.00',
    }),
    voucher({
      guid: 'guid-payment',
      type: 'Payment',
      number: 'PAY-1',
      amount: '99.00',
    }),
  );
}

async function importVouchers(
  bytes: Buffer,
  mode: 'preview' | 'commit',
  jar: CookieJar = owner,
  org: string = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/tally-invoices/import?filename=Vouchers.xml&mode=${mode}`,
    organisationId: org,
    headers: { 'content-type': 'application/xml' },
    payload: bytes,
  });
}

async function counts(): Promise<{ invoices: number; links: number }> {
  const [invoices] = await admin<{ count: number }[]>`
    select count(*)::int as count from imported_invoices
    where organisation_id = ${organisationId}
  `;
  const [links] = await admin<{ count: number }[]>`
    select count(*)::int as count from tally_invoice_links
    where organisation_id = ${organisationId}
  `;
  return { invoices: invoices?.count ?? 0, links: links?.count ?? 0 };
}

/** A Zoho-sourced register row, written directly: the Zoho import flow is
 * proved next door in `imported-invoices.integration.test.ts` and what is
 * under test here is what Tally does about rows that already exist. */
async function seedZohoInvoice(spec: {
  readonly zohoId: string;
  readonly number: string;
  readonly total: string;
  readonly customer?: string;
  readonly gstin?: string;
}): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into imported_invoices (
      organisation_id, source, zoho_invoice_id, invoice_number, invoice_date,
      customer_name, customer_gstin, sub_total, total, raw_row,
      imported_by_user_id
    )
    values (
      ${organisationId}, 'zoho', ${spec.zohoId}, ${spec.number}, '2023-06-01',
      ${spec.customer ?? 'Fixture Division West'}, ${spec.gstin ?? null},
      ${spec.total}, ${spec.total}, '{}'::jsonb, ${ownerUserId}
    )
    returning id
  `;
  return row?.id ?? '';
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-tally-invoices-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-tallyinv-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Tally Invoice Owner');
  clerk = await signUp(clerkEmail, 'Tally Invoice Clerk');
  outsider = await signUp(outsiderEmail, 'Tally Invoice Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Tally Invoice Works', slug: `tallyinv-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Outsider Works', slug: `tallyinv-out-${runId}` },
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

  const [membership] = await admin<{ user_id: string }[]>`
    select user_id from organisation_memberships
    where organisation_id = ${organisationId} and role = 'owner'
  `;
  ownerUserId = membership?.user_id ?? '';
  expect(ownerUserId).not.toBe('');

  // The Zoho half of the register, as it stands before Tally is read.
  await seedZohoInvoice({ zohoId: 'z-1', number: 'P0100001', total: '11800.00' });
  // The renumbered one: Zoho spells the customer-code segment
  // differently and agrees on the amount, which is what confirms it.
  await seedZohoInvoice({ zohoId: 'z-2', number: 'P0100002', total: '25000.00' });
  // The false collision: same trailing serial as `guid-collision`, and
  // nothing else in common.
  await seedZohoInvoice({
    zohoId: 'z-3',
    number: 'P0100003',
    total: '15000.00',
    customer: 'An Entirely Different Customer',
  });
  // The disagreement (ruling 21).
  await seedZohoInvoice({ zohoId: 'z-4', number: 'P0100004', total: '95000.00' });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
  await admin?.end({ timeout: 5 });
});

describe('previewing the voucher export', () => {
  it('reconciles both registers, applies the collision guard, and writes nothing', async () => {
    const before = await counts();
    const response = await importVouchers(exportBytes(), 'preview');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyInvoiceImportResult>();

    expect(result.mode).toBe('preview');
    expect(result.voucherCount).toBe(9);
    expect(result.salesCount).toBe(7);
    expect(result.creditNoteCount).toBe(1);
    expect(result.debitNoteCount).toBe(0);
    expect(result.refusals).toEqual([]);

    // RULING 22: skipped, and NAMED.
    expect(result.cancelledCount).toBe(1);
    expect(result.optionalCount).toBe(1);
    expect(result.skippedVoucherNumbers.sort()).toEqual(['P0100005', 'P0100006']);

    // The match, and the guard the census's § 4.3 demands.
    expect(result.exactMatchCount).toBe(2);
    expect(result.serialMatchCount).toBe(1);
    expect(result.serialCollisionCount).toBe(1);

    // RULING 21.
    expect(result.disputedComponentCount).toBe(1);
    expect(result.disputedLinkCount).toBe(1);

    // The pre-Zoho half, plus the voucher the collision guard refused:
    // both become register rows rather than links.
    expect(result.unmatchedCount).toBe(2);
    expect(result.invoicesWithNoVoucherCount).toBe(1);
    expect(result.importedInvoiceCount).toBe(0);
    expect(result.importedLinkCount).toBe(0);

    // The credit note is read, reported and not imported.
    const credit = result.vouchers.find((row) => row.voucherType === 'Credit Note');
    expect(credit?.outcome).toBe('skipped');
    expect(credit?.skipReason).toMatch(/reverses an invoice/);

    // The disputed voucher carries BOTH figures, neither overwritten.
    const disputed = result.vouchers.find((row) => row.disputed);
    expect(disputed?.componentTallyTotal).toBe('90000.00');
    expect(disputed?.componentInvoiceTotal).toBe('95000.00');

    expect(await counts()).toEqual(before);
  });

  it('refuses a file that is not a Tally export, before reading it', async () => {
    const response = await importVouchers(
      Buffer.from('<html><body>not tally</body></html>', 'utf8'),
      'preview',
    );
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('TALLY_VOUCHERS_UNREADABLE');
  });
});

describe('committing', () => {
  it('writes the cross-reference and the pre-Zoho register rows', async () => {
    const response = await importVouchers(exportBytes(), 'commit');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyInvoiceImportResult>();
    expect(result.mode).toBe('commit');
    // Two register rows: the pre-Zoho voucher and the one the collision
    // guard refused to tie to anything.
    expect(result.importedInvoiceCount).toBe(2);
    // Four links: two origins and the three matches, less nothing.
    expect(result.importedLinkCount).toBe(5);

    const after = await counts();
    expect(after.invoices).toBe(6);
    expect(after.links).toBe(5);

    // RULING 23: an invoice BOTH systems hold gains a cross-reference and
    // no second register row. `P0100001` is still one row, and it is
    // still the Zoho one.
    const [zoho] = await admin<{ source: string; count: number }[]>`
      select source, count(*)::int as count from imported_invoices
      where organisation_id = ${organisationId} and invoice_number = 'P0100001'
      group by source
    `;
    expect(zoho).toEqual({ source: 'zoho', count: 1 });

    // The pre-Zoho row, behind the source discriminator, with no Zoho id
    // and no sub-total — neither is a thing a Tally voucher states.
    const [tallyRow] = await admin<
      {
        source: string;
        zoho_invoice_id: string | null;
        sub_total: string | null;
        total: string;
      }[]
    >`
      select source, zoho_invoice_id, sub_total, total from imported_invoices
      where organisation_id = ${organisationId} and invoice_number = 'P0100900'
    `;
    expect(tallyRow?.source).toBe('tally');
    expect(tallyRow?.zoho_invoice_id).toBeNull();
    expect(tallyRow?.sub_total).toBeNull();
    expect(tallyRow?.total).toBe('4500.00');

    // The origin link is what carries the voucher GUID, because the
    // register gained no provenance column (ruling 12).
    const [origin] = await admin<{ tally_guid: string; tally_alterid: string }[]>`
      select tally_guid, tally_alterid from tally_invoice_links
      where organisation_id = ${organisationId} and match_method = 'origin'
        and tally_guid = 'guid-pre-zoho'
    `;
    expect(origin?.tally_guid).toBe('guid-pre-zoho');
    expect(Number(origin?.tally_alterid)).toBe(4242);

    // The serial-tolerant link records HOW it was found, so nobody has to
    // guess later whether the numbers actually matched.
    const [serial] = await admin<{ match_method: string; match_evidence: string }[]>`
      select match_method, match_evidence from tally_invoice_links
      where organisation_id = ${organisationId} and tally_guid = 'guid-serial'
    `;
    expect(serial?.match_method).toBe('serial_tolerant');
    expect(serial?.match_evidence).toBe('P0700002');
  });

  it('takes a disputed figure out of the register’s billed total (ruling 21)', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/imported-invoices?limit=50',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<ImportedInvoiceList>();
    expect(page.totals?.invoiceCount).toBe(6);
    expect(page.totals?.tallySourcedCount).toBe(2);
    expect(page.totals?.disputedCount).toBe(1);

    const disputed = page.invoices.find((row) => row.invoiceNumber === 'P0100004');
    expect(disputed?.disputed).toBe(true);
    expect(disputed?.tallyVoucherCount).toBe(1);
    expect(disputed?.tallyVoucherNumber).toBe('P0100004');

    // 11800 + 25000 + 15000 + 4500 + 777000 = 833300; the disputed
    // 95000 is out of it and the register still lists the invoice.
    expect(page.totals?.totalValue).toBe('833300.00');

    // A Tally-sourced row travels with a null sub-total rather than an
    // invented one.
    const tallyRow = page.invoices.find((row) => row.invoiceNumber === 'P0100900');
    expect(tallyRow?.source).toBe('tally');
    expect(tallyRow?.subTotal).toBeNull();
    expect(tallyRow?.zohoInvoiceId).toBeNull();
  });

  it('filters the register by source', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/imported-invoices?source=tally&limit=50',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<ImportedInvoiceList>();
    expect(page.totals?.invoiceCount).toBe(2);
    expect(page.invoices.every((row) => row.source === 'tally')).toBe(true);
  });

  it('is idempotent: the same export again writes nothing', async () => {
    const before = await counts();
    const response = await importVouchers(exportBytes(), 'commit');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyInvoiceImportResult>();
    expect(result.importedInvoiceCount).toBe(0);
    expect(result.importedLinkCount).toBe(0);
    expect(result.alreadyReadCount).toBeGreaterThan(0);
    expect(await counts()).toEqual(before);
  });
});

describe('the walls', () => {
  it('refuses a writer without the import authority', async () => {
    const response = await importVouchers(exportBytes(), 'preview', clerk);
    expect(response.statusCode).toBe(403);
  });

  it('refuses another organisation, indistinguishably from the format guard', async () => {
    const response = await importVouchers(
      exportBytes(),
      'preview',
      outsider,
      organisationId,
    );
    expect(response.statusCode).toBe(403);
    // AUTHORISED BEFORE THE FORMAT IS CHECKED. A wrong body would answer
    // 400 here, and a 400 where every other tenant route answers 403
    // tells an unauthorised caller that the route exists.
    const wrongBody = await importVouchers(
      Buffer.from('not xml at all', 'utf8'),
      'preview',
      outsider,
      organisationId,
    );
    expect(wrongBody.statusCode).toBe(403);
  });

  it('keeps the cross-reference inside its own tenant', async () => {
    const [row] = await admin<{ count: number }[]>`
      select count(*)::int as count from tally_invoice_links
      where organisation_id = ${outsiderOrganisationId}
    `;
    expect(row?.count).toBe(0);
  });

  it('refuses a second live origin link for one voucher (23T03)', async () => {
    // The route checks this first, under the advisory lock. This is the
    // arm that holds if two imports ever run without it, so it is
    // attacked with raw SQL that bypasses the route entirely — the
    // trigger fires for every writer, including the table's owner.
    //
    // A SECOND register row, so the unique index over the PAIR does not
    // answer first: what is being proved is that one voucher cannot
    // source two LIVE rows, which is a different rule from "the same pair
    // appears once".
    const [second] = await admin<{ id: string }[]>`
      insert into imported_invoices (
        organisation_id, source, invoice_number, invoice_date, customer_name,
        total, raw_row, imported_by_user_id
      )
      values (
        ${organisationId}, 'tally', 'P0100901', '2021-04-02',
        'Fixture Division West', '4500.00', '{}'::jsonb, ${ownerUserId}
      )
      returning id
    `;
    const failure = await admin`
      insert into tally_invoice_links (
        organisation_id, tally_guid, tally_voucher_type, tally_voucher_date,
        tally_party_ledger, tally_amount, imported_invoice_id, match_method,
        source_filename, imported_by_user_id
      )
      values (
        ${organisationId}, 'guid-pre-zoho', 'Sales', '2021-04-01',
        'Fixture Division West', '4500.00', ${second?.id ?? ''}, 'origin',
        'Vouchers.xml', ${ownerUserId}
      )
    `.catch((cause: unknown) => cause);
    expect((failure as { code?: string }).code).toBe('23T03');

    // Discarding the row that holds the origin link reopens the path,
    // which is the correction path 0119 § D promises: a Tally-sourced
    // invoice imported from the wrong file is discarded, and the
    // corrected export brings the voucher in again.
    await admin`
      update imported_invoices
      set discarded_at = now(), discarded_by_user_id = ${ownerUserId},
          discard_reason = 'imported from the wrong export'
      where organisation_id = ${organisationId} and invoice_number = 'P0100900'
    `;
    const allowed = await admin`
      insert into tally_invoice_links (
        organisation_id, tally_guid, tally_voucher_type, tally_voucher_date,
        tally_party_ledger, tally_amount, imported_invoice_id, match_method,
        source_filename, imported_by_user_id
      )
      values (
        ${organisationId}, 'guid-pre-zoho', 'Sales', '2021-04-01',
        'Fixture Division West', '4500.00', ${second?.id ?? ''}, 'origin',
        'Vouchers.xml', ${ownerUserId}
      )
    `.catch((cause: unknown) => cause);
    expect((allowed as { code?: string }).code).toBeUndefined();
  });

  it('refuses an UPDATE of a link (23T02)', async () => {
    const failure = await admin`
      update tally_invoice_links set match_evidence = 'rewritten'
      where organisation_id = ${organisationId} and tally_guid = 'guid-serial'
    `.catch((cause: unknown) => cause);
    expect((failure as { code?: string }).code).toBe('23T02');
  });

  it('refuses a Zoho-sourced row carrying an origin link, and vice versa (23T02)', async () => {
    const failure = await admin`
      insert into tally_invoice_links (
        organisation_id, tally_guid, tally_voucher_type, tally_voucher_date,
        tally_party_ledger, tally_amount, imported_invoice_id, match_method,
        source_filename, imported_by_user_id
      )
      select ${organisationId}, 'guid-invented', 'Sales', '2023-06-01',
             'Fixture Division West', '11800.00', i.id, 'origin',
             'Vouchers.xml', ${ownerUserId}
      from imported_invoices i
      where i.organisation_id = ${organisationId} and i.zoho_invoice_id = 'z-1'
    `.catch((cause: unknown) => cause);
    expect((failure as { code?: string }).code).toBe('23T02');
  });

  it('refuses a register row whose source and identity disagree (23514)', async () => {
    // 0119's shape check: a 'zoho' row has a Zoho id and a sub-total, a
    // 'tally' row has neither.
    const failure = await admin`
      insert into imported_invoices (
        organisation_id, source, zoho_invoice_id, invoice_number, invoice_date,
        customer_name, sub_total, total, raw_row, imported_by_user_id
      )
      values (
        ${organisationId}, 'tally', 'z-99', 'P0100999', '2021-04-01',
        'Fixture Division West', '100.00', '100.00', '{}'::jsonb, ${ownerUserId}
      )
    `.catch((cause: unknown) => cause);
    expect((failure as { code?: string }).code).toBe('23514');
  });

  it('freezes the source column on the register (23X01)', async () => {
    const failure = await admin`
      update imported_invoices set source = 'zoho'
      where organisation_id = ${organisationId} and invoice_number = 'P0100900'
    `.catch((cause: unknown) => cause);
    expect((failure as { code?: string }).code).toBe('23X01');
  });
});
