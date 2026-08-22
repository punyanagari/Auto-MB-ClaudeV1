import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { TallyLedgerList, TallyMasterImportResult } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * The Tally ledger census, end to end (migration 0118).
 *
 * EVERY MASTER IN THIS FILE IS INVENTED. The export this wave was built
 * against is a real company's chart of accounts and no ledger name, GSTIN
 * or group of it may enter the repository; what is reproduced here is its
 * SHAPE, with values that belong to nobody.
 *
 * What is proved, in the order the module's risks run:
 *
 *   1. PREVIEW WRITES NOTHING. Every other guarantee rests on it, so the
 *      census is counted before and after;
 *   2. the classification and the contact proposals — and the half that
 *      matters, the party ledgers nothing could be proposed for;
 *   3. the commit, and the census read back;
 *   4. THE MIRROR: the same file twice changes nothing, a fresher export
 *      refreshes the masters Tally altered, and a master the newest
 *      export no longer names falls out of the census without being
 *      destroyed;
 *   5. the walls: the import authority, the other organisation, and the
 *      database's own guard attacked with raw SQL.
 *
 * The reader's own cases live in `tally-masters.test.ts`: it is a pure
 * function of some bytes and needs no database. What stays here is what
 * it becomes on the wire.
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
const ownerEmail = `tally-owner-${runId}@integration.test`;
const clerkEmail = `tally-clerk-${runId}@integration.test`;
const outsiderEmail = `tally-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
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

function utf16(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

function master(lines: readonly string[]): string {
  return [
    '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    ...lines,
    '    </TALLYMESSAGE>',
  ].join('\r\n');
}

function group(name: string, parent: string): string {
  return master([
    `     <GROUP NAME="${name}" RESERVEDNAME="">`,
    `      <GUID>grp-${name}</GUID>`,
    `      <PARENT>${parent}</PARENT>`,
    '     </GROUP>',
  ]);
}

interface LedgerSpec {
  readonly name: string;
  readonly parent: string;
  readonly guid: string;
  readonly alterId?: number;
  readonly gstin?: string;
  readonly openingBalance?: string;
}

function ledger(spec: LedgerSpec): string {
  return master([
    `     <LEDGER NAME="${spec.name}" RESERVEDNAME="">`,
    '      <LANGUAGENAME.LIST TYPE="String"/>',
    `      <GUID>${spec.guid}</GUID>`,
    `      <PARENT>${spec.parent}</PARENT>`,
    `      <ALTERID> ${String(spec.alterId ?? 100)}</ALTERID>`,
    '      <ISBILLWISEON>Yes</ISBILLWISEON>',
    '      <ISDELETED>No</ISDELETED>',
    ...(spec.gstin === undefined
      ? []
      : [`      <PARTYGSTIN>${spec.gstin}</PARTYGSTIN>`]),
    ...(spec.openingBalance === undefined
      ? []
      : [`      <OPENINGBALANCE>${spec.openingBalance}</OPENINGBALANCE>`]),
    '     </LEDGER>',
  ]);
}

function envelope(...masters: string[]): Buffer {
  return utf16(
    [
      '<ENVELOPE>',
      ' <HEADER>',
      '  <TALLYREQUEST>Import Data</TALLYREQUEST>',
      ' </HEADER>',
      ' <BODY>',
      '  <IMPORTDATA>',
      '   <REQUESTDATA>',
      ...masters,
      '   </REQUESTDATA>',
      '  </IMPORTDATA>',
      ' </BODY>',
      '</ENVELOPE>',
    ].join('\r\n'),
  );
}

const TREE = [
  group('Sundry Debtors', 'Current Assets'),
  group('Fixture Divisions', 'Sundry Debtors'),
  group('Sundry Creditors', 'Current Liabilities'),
  group('Deposits (Asset)', 'Current Assets'),
  group('Fixture Security Deposits', 'Deposits (Asset)'),
];

const MATCHED_GSTIN = '27AAACR1234A1ZP';

/**
 * Five ledgers across the four classes:
 *
 *   customer    one matching the contacts master by GSTIN under a name
 *               that does not match, and one matching nothing at all
 *   vendor      one matching nothing
 *   instrument  a security deposit keyed to a work
 *   other       a tax head
 */
function exportBytes(
  options: { readonly depositAlterId?: number; readonly withVendor?: boolean } = {},
): Buffer {
  return envelope(
    ...TREE,
    ledger({
      name: 'Fixture Division West',
      parent: 'Fixture Divisions',
      guid: 'guid-customer-matched',
      gstin: MATCHED_GSTIN,
    }),
    ledger({
      name: 'Fixture Division East',
      parent: 'Fixture Divisions',
      guid: 'guid-customer-unmatched',
    }),
    ...(options.withVendor === false
      ? []
      : [
          ledger({
            name: 'Fixture Supplies Co',
            parent: 'Sundry Creditors',
            guid: 'guid-vendor',
          }),
        ]),
    ledger({
      name: 'SD Fixture West PL-4242',
      parent: 'Fixture Security Deposits',
      guid: 'guid-instrument',
      alterId: options.depositAlterId ?? 100,
      openingBalance: '-125000.50',
    }),
    ledger({
      name: 'CGST Fixture 9%',
      parent: 'Current Liabilities',
      guid: 'guid-other',
    }),
  );
}

async function importExport(
  bytes: Buffer,
  mode: 'preview' | 'commit',
  jar: CookieJar = owner,
  org: string = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/tally-masters/import?filename=Master.xml&mode=${mode}`,
    organisationId: org,
    headers: { 'content-type': 'application/xml' },
    payload: bytes,
  });
}

async function countCensus(): Promise<number> {
  const [row] = await admin<{ count: number }[]>`
    select count(*)::int as count from tally_ledgers
    where organisation_id = ${organisationId}
  `;
  return row?.count ?? 0;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-tally-masters-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-tally-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Tally Owner');
  clerk = await signUp(clerkEmail, 'Tally Clerk');
  outsider = await signUp(outsiderEmail, 'Tally Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Tally Fixture Works', slug: `tally-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Outsider Works', slug: `tally-out-${runId}` },
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

  // A contact whose NAME is nothing like the Tally ledger's and whose
  // GSTIN is identical — which is the whole reason owner ruling 8 puts
  // the GSTIN first. Written directly because the contacts flow is not
  // what is under test here.
  const [contact] = await admin<{ id: string }[]>`
    insert into contacts (
      organisation_id, designation, gstin, is_client, created_by_user_id
    )
    values (
      ${organisationId}, 'Western Railway Fixture Division', ${MATCHED_GSTIN}, true,
      (select user_id from organisation_memberships
        where organisation_id = ${organisationId} and role = 'owner')
    )
    returning id
  `;
  contactId = contact?.id ?? '';
  expect(contactId).not.toBe('');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
  await admin?.end({ timeout: 5 });
});

describe('previewing the export', () => {
  it('classifies, proposes, names the unmatched, and writes nothing', async () => {
    const before = await countCensus();
    const response = await importExport(exportBytes(), 'preview');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyMasterImportResult>();

    expect(result.mode).toBe('preview');
    expect(result.ledgerCount).toBe(5);
    expect(result.groupCount).toBe(TREE.length);
    expect(result.refusals).toEqual([]);

    // The classification, from Tally's own reserved group ancestry.
    expect(result.customerCount).toBe(2);
    expect(result.vendorCount).toBe(1);
    expect(result.instrumentCount).toBe(1);
    expect(result.otherCount).toBe(1);

    // The proposal, and the half an operator has to work through.
    expect(result.proposedContactCount).toBe(1);
    expect(result.unmatchedPartyCount).toBe(2);
    expect(result.codedCount).toBe(1);
    expect(result.distinctCodeCount).toBe(1);

    // Nothing is held yet, so everything is new and nothing is superseded.
    expect(result.newCount).toBe(5);
    expect(result.updatedCount).toBe(0);
    expect(result.unchangedCount).toBe(0);
    expect(result.supersededCount).toBe(0);
    expect(result.importedCount).toBe(0);

    expect(result.byRootGroup).toContainEqual({
      rootGroup: 'Current Assets',
      ledgerCount: 3,
    });

    expect(await countCensus()).toBe(before);
  });

  it('refuses a file that is not a Tally export, before reading it', async () => {
    const response = await importExport(
      Buffer.from('<html><body>not tally</body></html>', 'utf8'),
      'preview',
    );
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('TALLY_EXPORT_UNREADABLE');
    expect(await countCensus()).toBe(0);
  });
});

describe('committing', () => {
  it('writes the census and reads it back', async () => {
    const response = await importExport(exportBytes(), 'commit');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyMasterImportResult>();
    expect(result.mode).toBe('commit');
    expect(result.importedCount).toBe(5);
    expect(await countCensus()).toBe(5);

    const listed = await authed(owner, {
      method: 'GET',
      url: '/api/tally-masters/ledgers',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const census = listed.json<TallyLedgerList>();
    expect(census.totals?.ledgerCount).toBe(5);
    expect(census.totals?.customerCount).toBe(2);
    expect(census.totals?.proposedContactCount).toBe(1);
    expect(census.totals?.unmatchedPartyCount).toBe(2);
    expect(census.totals?.supersededCount).toBe(0);
    expect(census.totals?.lastFilename).toBe('Master.xml');
    // Alphabetical, which is how somebody looks for a party.
    expect(census.ledgers.map((entry) => entry.ledgerName)).toEqual([
      'CGST Fixture 9%',
      'Fixture Division East',
      'Fixture Division West',
      'Fixture Supplies Co',
      'SD Fixture West PL-4242',
    ]);

    const matched = census.ledgers.find(
      (entry) => entry.ledgerName === 'Fixture Division West',
    );
    expect(matched?.classification).toBe('customer');
    // MATCHED ON GSTIN THROUGH A NAME THAT DOES NOT MATCH — ruling 8.
    expect(matched?.proposedContactId).toBe(contactId);
    expect(matched?.proposedContactMethod).toBe('gstin');
    expect(matched?.proposedContactName).toBe('Western Railway Fixture Division');

    const deposit = census.ledgers.find(
      (entry) => entry.ledgerName === 'SD Fixture West PL-4242',
    );
    expect(deposit?.classification).toBe('instrument');
    expect(deposit?.plCode).toBe('PL-4242');
    expect(deposit?.openingBalance).toBe('-125000.50');
    expect(deposit?.groupPath).toEqual([
      'Current Assets',
      'Deposits (Asset)',
      'Fixture Security Deposits',
    ]);
    // NO WORK LINK EXISTS TO SET — rulings 4 and 5. The code is text.
    expect(deposit).not.toHaveProperty('workId');
    // AND AN INSTRUMENT IS NEVER PROPOSED A CONTACT, however much its
    // name resembles the division's.
    expect(deposit?.proposedContactId).toBeNull();
  });

  it('filters the census by class, by code and by the unmatched half', async () => {
    const byClass = await authed(owner, {
      method: 'GET',
      url: '/api/tally-masters/ledgers?classification=instrument',
      organisationId,
    });
    expect(byClass.json<TallyLedgerList>().ledgers).toHaveLength(1);

    const coded = await authed(owner, {
      method: 'GET',
      url: '/api/tally-masters/ledgers?coded=true',
      organisationId,
    });
    expect(coded.json<TallyLedgerList>().ledgers).toHaveLength(1);

    const unmatched = await authed(owner, {
      method: 'GET',
      url: '/api/tally-masters/ledgers?matched=unmatched',
      organisationId,
    });
    expect(
      unmatched.json<TallyLedgerList>().ledgers.map((entry) => entry.ledgerName),
    ).toEqual(['Fixture Division East', 'Fixture Supplies Co']);

    const search = await authed(owner, {
      method: 'GET',
      url: '/api/tally-masters/ledgers?search=division%20west',
      organisationId,
    });
    expect(search.json<TallyLedgerList>().ledgers).toHaveLength(1);
  });

  it('records the import as ONE audit event, not one per ledger', async () => {
    const [event] = await admin<{ action: string; details: Record<string, unknown> }[]>`
      select action, details from audit_events
      where organisation_id = ${organisationId}
        and action = 'tally_ledger.imported'
      order by occurred_at desc limit 1
    `;
    expect(event?.action).toBe('tally_ledger.imported');
    expect(event?.details).toMatchObject({ filename: 'Master.xml', ledgerCount: 5 });
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where organisation_id = ${organisationId}
        and action = 'tally_ledger.imported'
    `;
    expect(count?.count).toBe(1);
  });
});

/* THE PROPERTY THAT MAKES A CUTOVER SURVIVABLE. Owner ruling 3 has the
   owner take a FRESH export on import day, so the second import is the
   normal case rather than the accident. */
describe('re-importing', () => {
  it('changes nothing when the same file is imported twice', async () => {
    const [before] = await admin<{ updated_at: string }[]>`
      select updated_at from tally_ledgers
      where organisation_id = ${organisationId} and tally_guid = 'guid-other'
    `;
    const response = await importExport(exportBytes(), 'commit');
    const result = response.json<TallyMasterImportResult>();
    expect(result.newCount).toBe(0);
    expect(result.unchangedCount).toBe(5);
    expect(result.updatedCount).toBe(0);
    expect(await countCensus()).toBe(5);

    // The row's contents are identical, so nothing about it moved except
    // the stamp saying this import saw it.
    const [after] = await admin<{ updated_at: string; ledger_name: string }[]>`
      select updated_at, ledger_name from tally_ledgers
      where organisation_id = ${organisationId} and tally_guid = 'guid-other'
    `;
    expect(after?.ledger_name).toBe('CGST Fixture 9%');
    expect(before).toBeDefined();
    expect(after).toBeDefined();
  });

  it('refreshes a master whose ALTERID moved, because the mirror must not lie', async () => {
    const response = await importExport(exportBytes({ depositAlterId: 250 }), 'commit');
    const result = response.json<TallyMasterImportResult>();
    expect(result.updatedCount).toBe(1);
    expect(result.unchangedCount).toBe(4);
    expect(await countCensus()).toBe(5);

    const [row] = await admin<{ tally_alterid: string }[]>`
      select tally_alterid from tally_ledgers
      where organisation_id = ${organisationId} and tally_guid = 'guid-instrument'
    `;
    expect(Number(row?.tally_alterid)).toBe(250);
  });

  /* A ledger deleted in Tally, and — the case that actually matters — a
     whole import of the wrong file. Neither row is destroyed; both fall
     out of the census the moment the right export is read. */
  it('supersedes a master the newest export no longer names, without destroying it', async () => {
    const response = await importExport(
      exportBytes({ depositAlterId: 250, withVendor: false }),
      'commit',
    );
    const result = response.json<TallyMasterImportResult>();
    expect(result.ledgerCount).toBe(4);
    expect(result.supersededCount).toBe(1);

    // Still on the record.
    expect(await countCensus()).toBe(5);

    // Absent from the census.
    const census = await authed(owner, {
      method: 'GET',
      url: '/api/tally-masters/ledgers',
      organisationId,
    });
    const listed = census.json<TallyLedgerList>();
    expect(listed.totals?.ledgerCount).toBe(4);
    expect(listed.totals?.supersededCount).toBe(1);
    expect(listed.ledgers.map((entry) => entry.ledgerName)).not.toContain(
      'Fixture Supplies Co',
    );

    // And readable on request, which is what makes it evidence rather
    // than a deletion.
    const withSuperseded = await authed(owner, {
      method: 'GET',
      url: '/api/tally-masters/ledgers?includeSuperseded=true',
      organisationId,
    });
    expect(
      withSuperseded.json<TallyLedgerList>().ledgers.map((entry) => entry.ledgerName),
    ).toContain('Fixture Supplies Co');
  });
});

describe('the walls', () => {
  it('refuses a writer without the import authority', async () => {
    const response = await importExport(exportBytes(), 'preview', clerk);
    expect(response.statusCode).toBe(403);
    expect(await countCensus()).toBe(5);
  });

  it('refuses a reader from another organisation', async () => {
    const response = await authed(outsider, {
      method: 'GET',
      url: '/api/tally-masters/ledgers',
      organisationId,
    });
    expect(response.statusCode).toBe(403);
  });

  it('shows another organisation an empty census, not this one', async () => {
    const response = await authed(outsider, {
      method: 'GET',
      url: '/api/tally-masters/ledgers',
      organisationId: outsiderOrganisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<TallyLedgerList>().ledgers).toEqual([]);
  });

  /* THE DATABASE'S OWN ARM. The import upserts on the GUID and cannot
     reach either case; these are what holds when a writer gets to the
     table another way. */
  it('refuses to repoint a census row at a different Tally master', async () => {
    await expect(
      admin`
        update tally_ledgers set tally_guid = 'guid-something-else'
        where organisation_id = ${organisationId} and tally_guid = 'guid-other'
      `,
    ).rejects.toMatchObject({ code: '23T01' });
  });

  it('refuses an export older than the one already imported', async () => {
    await expect(
      admin`
        update tally_ledgers set tally_alterid = 1
        where organisation_id = ${organisationId} and tally_guid = 'guid-instrument'
      `,
    ).rejects.toMatchObject({ code: '23T01' });
  });

  it('refuses a contact proposal on a ledger that is not a party', async () => {
    await expect(
      admin`
        update tally_ledgers
        set proposed_contact_id = ${contactId}, proposed_contact_method = 'name'
        where organisation_id = ${organisationId} and tally_guid = 'guid-instrument'
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('grants the application no way to delete a census row', async () => {
    const [grant] = await admin<{ count: number }[]>`
      select count(*)::int as count from information_schema.role_table_grants
      where table_name = 'tally_ledgers'
        and grantee = 'auto_mb_app'
        and privilege_type = 'DELETE'
    `;
    expect(grant?.count).toBe(0);
  });
});
