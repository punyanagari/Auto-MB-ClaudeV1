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
  /** `null` omits the tag entirely — a master Tally exported with no edit
   * counter, which is unknown rather than zero. */
  readonly alterId?: number | null;
  readonly gstin?: string;
  readonly openingBalance?: string;
}

function ledger(spec: LedgerSpec): string {
  return master([
    `     <LEDGER NAME="${spec.name}" RESERVEDNAME="">`,
    '      <LANGUAGENAME.LIST TYPE="String"/>',
    `      <GUID>${spec.guid}</GUID>`,
    `      <PARENT>${spec.parent}</PARENT>`,
    ...(spec.alterId === null
      ? []
      : [`      <ALTERID> ${String(spec.alterId ?? 100)}</ALTERID>`]),
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
  options: { readonly force?: boolean } = {},
) {
  const force = options.force === true ? '&force=true' : '';
  return authed(jar, {
    method: 'POST',
    url: `/api/tally-masters/import?filename=Master.xml&mode=${mode}${force}`,
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

/* THE REVIEW FINDINGS, on the wire. */

describe('an export whose edit counters have gone backwards', () => {
  /* FINDING 2. A lower ALTERID normally means an older export is being
     imported over a newer one, which would quietly replace the current
     census with a stale one. But a restored TallyPrime backup genuinely
     lowers every counter, and then the FILE is current and the census is
     the stale one — so there has to be a sanctioned way through, and it
     has to be recorded. */
  it('reports the stale masters on the preview rather than surprising the commit', async () => {
    const response = await importExport(exportBytes({ depositAlterId: 5 }), 'preview');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyMasterImportResult>();
    // The census holds ALTERID 250 for this master from the run above.
    expect(result.staleCount).toBe(1);
    expect(result.forced).toBe(false);
  });

  it('refuses the commit by name, and writes nothing', async () => {
    const before = await admin<{ tally_alterid: string }[]>`
      select tally_alterid from tally_ledgers
      where organisation_id = ${organisationId} and tally_guid = 'guid-instrument'
    `;
    const response = await importExport(exportBytes({ depositAlterId: 5 }), 'commit');
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('TALLY_EXPORT_STALE');
    const after = await admin<{ tally_alterid: string }[]>`
      select tally_alterid from tally_ledgers
      where organisation_id = ${organisationId} and tally_guid = 'guid-instrument'
    `;
    expect(after[0]?.tally_alterid).toBe(before[0]?.tally_alterid);
  });

  it('accepts it with the override, and records that the override was used', async () => {
    const response = await importExport(
      exportBytes({ depositAlterId: 5 }),
      'commit',
      owner,
      organisationId,
      { force: true },
    );
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<TallyMasterImportResult>();
    expect(result.forced).toBe(true);
    expect(result.staleCount).toBe(1);

    // The census now holds the restored file's own counter.
    const [row] = await admin<{ tally_alterid: string }[]>`
      select tally_alterid from tally_ledgers
      where organisation_id = ${organisationId} and tally_guid = 'guid-instrument'
    `;
    expect(Number(row?.tally_alterid)).toBe(5);

    // AND IT IS ON THE RECORD. An override nobody can find afterwards is
    // not an override, it is a silent overwrite.
    const [event] = await admin<{ details: Record<string, unknown> }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'tally_ledger.imported'
      order by occurred_at desc limit 1
    `;
    expect(event?.details).toMatchObject({ forced: true, staleCount: 1 });
  });

  it('leaves the override off by default on the next import', async () => {
    // The GUC is transaction-local, so the run above cannot have leaked
    // it into this one. Restore the census to the higher counter first,
    // which is itself an ordinary forward import.
    const restored = await importExport(exportBytes({ depositAlterId: 250 }), 'commit');
    expect(restored.statusCode, restored.body).toBe(200);
    const response = await importExport(exportBytes({ depositAlterId: 5 }), 'commit');
    expect(response.statusCode).toBe(409);
  });
});

describe('a master with no edit counter at all', () => {
  /* FINDING 2a, on the wire: unknown is not zero, and an unknown counter
     is never read as a regression. */
  it('imports as null and re-imports without being called stale', async () => {
    const bytes = envelope(
      ...TREE,
      ledger({
        name: 'Fixture No Counter',
        parent: 'Fixture Divisions',
        guid: 'guid-no-counter',
        alterId: null,
      }),
    );
    const first = await importExport(bytes, 'commit');
    expect(first.statusCode, first.body).toBe(200);
    const [row] = await admin<{ tally_alterid: string | null }[]>`
      select tally_alterid from tally_ledgers
      where organisation_id = ${organisationId} and tally_guid = 'guid-no-counter'
    `;
    expect(row?.tally_alterid).toBeNull();

    const again = await importExport(bytes, 'commit');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<TallyMasterImportResult>().staleCount).toBe(0);
  });
});

describe('the superseded count', () => {
  /* FINDING 7. Counted against the CURRENT latest census only. The first
     reading subtracted the matched GUIDs from EVERY row in the table,
     which counted rows already superseded by an earlier import a second
     time — so after two shrinking imports the same missing master was
     reported twice and nobody could tell that from two going missing. */
  it('counts each missing master once, not once per import that missed it', async () => {
    // A census of three.
    const three = envelope(
      ...TREE,
      ledger({ name: 'Seq One', parent: 'Fixture Divisions', guid: 'seq-1' }),
      ledger({ name: 'Seq Two', parent: 'Fixture Divisions', guid: 'seq-2' }),
      ledger({ name: 'Seq Three', parent: 'Fixture Divisions', guid: 'seq-3' }),
    );
    expect((await importExport(three, 'commit')).statusCode).toBe(200);

    // Drop one: exactly one master is no longer named.
    const two = envelope(
      ...TREE,
      ledger({ name: 'Seq One', parent: 'Fixture Divisions', guid: 'seq-1' }),
      ledger({ name: 'Seq Two', parent: 'Fixture Divisions', guid: 'seq-2' }),
    );
    const second = await importExport(two, 'commit');
    expect(second.json<TallyMasterImportResult>().supersededCount).toBe(1);

    // Drop another. The latest census is now the TWO rows the second
    // import wrote, and this export names one of them — so the answer is
    // one, not two. Under the old reading it was two.
    const one = envelope(
      ...TREE,
      ledger({ name: 'Seq One', parent: 'Fixture Divisions', guid: 'seq-1' }),
    );
    const third = await importExport(one, 'commit');
    expect(third.json<TallyMasterImportResult>().supersededCount).toBe(1);
  });
});
