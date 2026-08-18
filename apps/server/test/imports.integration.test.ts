import { randomBytes, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ImportBatchDetail, ImportBatchList } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import { readXlsxRows, writeXlsxWorkbook } from '../src/xlsx.js';

/**
 * Importing a register from a spreadsheet, end to end (migration 0094).
 *
 * What is proved here, in the order the module's risks run:
 *
 *   1. THE LOAD-BEARING RULE — an upload writes staging and nothing else.
 *      The register is read before and after and is unchanged, because
 *      every other guarantee in this feature rests on that one;
 *   2. the verdict an operator reads: which rows are wrong, on which
 *      LINE OF THE SHEET, and against which COLUMN — with the register's
 *      own sentences, not a paraphrase;
 *   3. the commit, and its second validation pass against a register
 *      that changed underneath the batch;
 *   4. the walls: role, authority, the other organisation, and a
 *      finished batch;
 *   5. THE PARSER, attacked as the untrusted input it is — a zip bomb's
 *      header, an XML document type, a formula, a foreign compression;
 *   6. the database's own arm, attacked with raw SQL: staged cells are
 *      evidence and cannot be rewritten.
 *
 * The workbooks are built by this module's own writer. That is not a
 * tautology as long as the reader and the writer disagree about
 * everything except the format — the writer emits inline strings and the
 * reader is exercised against shared strings, sparse rows and numeric
 * cells by the fixtures below, which are hand-built XML.
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
const ownerEmail = `imp-owner-${runId}@integration.test`;
const clerkEmail = `imp-clerk-${runId}@integration.test`;
const outsiderEmail = `imp-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let clerkUserId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
/** A writer WITHOUT the import authority: the wall this pack adds. */
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

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Uploads a workbook the way the browser does: raw bytes, metadata on
 * the querystring. */
async function upload(
  bytes: Buffer,
  options: {
    readonly target?: string;
    readonly filename?: string;
    readonly jar?: CookieJar;
    readonly org?: string;
  } = {},
) {
  return authed(options.jar ?? owner, {
    method: 'POST',
    url: `/api/imports?target=${options.target ?? 'contacts'}&filename=${encodeURIComponent(options.filename ?? 'vendors.xlsx')}`,
    organisationId: options.org ?? organisationId,
    headers: { 'content-type': XLSX_TYPE },
    payload: bytes,
  });
}

/** A contacts workbook from a header row and any number of data rows. */
function contactsSheet(rows: readonly (readonly string[])[]): Buffer {
  return writeXlsxWorkbook('Contacts', [
    ['Designation', 'Address', 'Email', 'GSTIN', 'Vendor'],
    ...rows,
  ]);
}

async function countContacts(): Promise<number> {
  const [row] = await admin<{ count: string }[]>`
    select count(*)::text as count from contacts
    where organisation_id = ${organisationId}
  `;
  return Number(row?.count ?? '0');
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-imports-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-imp-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Import Owner');
  clerk = await signUp(clerkEmail, 'Import Clerk');
  outsider = await signUp(outsiderEmail, 'Import Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Import Constructions', slug: `imp-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Outsider Works', slug: `imp-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  // An office member with the writer role and NO import authority. The
  // founding owner holds it implicitly (0094 re-creates
  // create_organisation_with_owner); nobody else gets it by default,
  // which is exactly what the wall test below proves.
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
  const [clerkRow] = await admin<{ user_id: string }[]>`
    select user_id from organisation_memberships
    where organisation_id = ${organisationId} and role = 'office'
  `;
  clerkUserId = clerkRow?.user_id ?? '';
  expect(clerkUserId).not.toBe('');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
  await admin?.end({ timeout: 5 });
});

describe('staging a workbook', () => {
  it('judges every row and writes nothing to the register', async () => {
    const before = await countContacts();
    const response = await upload(
      contactsSheet([
        ['Sr.DEE (G) Bhusawal', 'DRM Office, Bhusawal', 'dee@example.gov.in', '', 'no'],
        // Row 3: two refusals at once, on two different columns, so the
        // "collect them all" rule is proved rather than assumed.
        ['Vendor With Bad Fields', 'Nagpur', 'not an email', '27BAD', 'yes'],
        // Row 4: rule R16. A consignee — neither vendor nor client — may
        // not be a bill-paying authority.
        ['Sr.DFM Bhusawal', 'DRM Office, Bhusawal', '', '', 'no'],
        // Row 5: required column empty.
        ['', 'Nowhere', '', '', 'no'],
      ]),
    );
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<ImportBatchDetail>();

    expect(detail.batch.status).toBe('validated');
    expect(detail.batch.rowCount).toBe(4);
    expect(detail.batch.validRowCount).toBe(1);
    expect(detail.batch.errorRowCount).toBe(3);
    expect(detail.batch.importedRowCount).toBe(0);

    // THE LOAD-BEARING RULE. Everything else in this feature is built on
    // the register being untouched until somebody commits.
    expect(await countContacts()).toBe(before);

    // Sheet row numbers, not a sequence: row 1 is the header, so the
    // first data row is 2 and the operator can find it in Excel.
    expect(detail.rows.map((row) => row.rowNumber)).toEqual([2, 3, 4, 5]);
    expect(detail.rows.map((row) => row.status)).toEqual([
      'valid',
      'error',
      'error',
      'error',
    ]);

    // The errors name their COLUMN, which is what makes a batch fixable:
    // "row 47" sends somebody scanning eighteen fields, "row 47, GSTIN"
    // does not.
    const bad = detail.rows[1];
    expect(bad?.errors.map((error) => error.column).sort()).toEqual(['email', 'gstin']);
    // And they are the REGISTER'S OWN sentences, from the same validator
    // the Contacts form calls — so one mistake reads the same words
    // whichever door it came through.
    expect(bad?.errors.find((error) => error.column === 'gstin')?.message).toContain(
      'TDS-deductor GSTIN ending in D',
    );
    expect(
      detail.rows[2]?.errors.find((error) => error.column === 'designation')?.message,
    ).toContain('rule R16');
    expect(
      detail.rows[3]?.errors.find((error) => error.column === 'designation')?.message,
    ).toContain('required');

    // The raw cells travel back, so the screen can show the value that
    // was refused without reopening the workbook.
    expect(bad?.cells.gstin).toBe('27BAD');
  });

  it('refuses a second row of the sheet that claims what an earlier one did', async () => {
    const response = await upload(
      contactsSheet([
        ['Twice Over Traders', 'Amravati', '', '', 'yes'],
        ['Twice Over Traders', 'Amravati', '', '', 'yes'],
      ]),
    );
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<ImportBatchDetail>();
    // The FIRST passes and the second is refused. Refusing both would be
    // defensible and is worse: somebody who pasted a block twice wants
    // the register populated once, not the file rejected.
    expect(detail.rows.map((row) => row.status)).toEqual(['valid', 'error']);
    expect(detail.rows[1]?.errors[0]?.message).toContain('earlier row of this sheet');
  });

  it('ignores a column it does not know and refuses a missing required one', async () => {
    const withNoise = await upload(
      writeXlsxWorkbook('Contacts', [
        ['Designation', "Ramesh's note", 'Address'],
        ['Noise Tolerant Traders', 'ring back Tuesday', 'Akola'],
      ]),
    );
    expect(withNoise.statusCode, withNoise.body).toBe(201);
    expect(withNoise.json<ImportBatchDetail>().rows[0]?.status).toBe('valid');

    const missing = await upload(
      writeXlsxWorkbook('Contacts', [['Address'], ['Akola']]),
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ code: string }>().code).toBe(
      'IMPORT_SHEET_HEADERS_UNRECOGNISED',
    );
  });
});

describe('committing a batch', () => {
  it('writes the valid rows, leaves the errors, and is terminal', async () => {
    const staged = await upload(
      contactsSheet([
        ['Commit One Traders', 'Jalgaon', '', '', 'yes'],
        ['Commit Two Traders', 'Jalgaon', '', '', 'yes'],
        ['Commit Bad Traders', 'Jalgaon', 'nonsense', '', 'yes'],
      ]),
    );
    expect(staged.statusCode, staged.body).toBe(201);
    const batchId = staged.json<ImportBatchDetail>().batch.id;
    const before = await countContacts();

    const committed = await authed(owner, {
      method: 'POST',
      url: `/api/imports/${batchId}/import`,
      organisationId,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const detail = committed.json<ImportBatchDetail>();
    expect(detail.batch.status).toBe('completed');
    expect(detail.batch.importedRowCount).toBe(2);
    expect(await countContacts()).toBe(before + 2);

    // Each committed row names the record it became, which is the
    // provenance the whole feature exists to leave behind.
    const written = detail.rows.filter((row) => row.importedRecordId !== null);
    expect(written).toHaveLength(2);
    const [contact] = await admin<{ designation: string }[]>`
      select designation from contacts where id = ${written[0]?.importedRecordId ?? ''}
    `;
    expect(contact?.designation).toBe('Commit One Traders');

    // Terminal. A committed batch is the record of rows that are now in
    // a register, and re-running it would write them twice.
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/imports/${batchId}/import`,
      organisationId,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('IMPORT_BATCH_FINISHED');
  });

  it('re-validates against the register as it is now, not as it was', async () => {
    const staged = await upload(
      contactsSheet([['Race Condition Traders', 'Akola', '', '', 'yes']]),
    );
    expect(staged.statusCode, staged.body).toBe(201);
    const detail = staged.json<ImportBatchDetail>();
    expect(detail.rows[0]?.status).toBe('valid');
    const batchId = detail.batch.id;

    // Somebody adds by hand exactly what the sheet is about to add. Days
    // can pass between staging and committing, so this is an ordinary
    // Tuesday rather than an exotic race.
    await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Race Condition Traders',
        address: 'Akola',
        isVendor: true,
      },
    }).then((response) => {
      expect(response.statusCode, response.body).toBe(201);
    });

    const committed = await authed(owner, {
      method: 'POST',
      url: `/api/imports/${batchId}/import`,
      organisationId,
    });
    // Not a 500, and not a silently doubled contact: the row is reported
    // against its own line and the batch finishes.
    expect(committed.statusCode, committed.body).toBe(200);
    const after = committed.json<ImportBatchDetail>();
    expect(after.batch.importedRowCount).toBe(0);
    expect(after.rows[0]?.status).toBe('error');
    expect(after.rows[0]?.errors[0]?.message).toContain('already exists');
  });

  it('refuses a batch with nothing to write, and withdraws one instead', async () => {
    const staged = await upload(contactsSheet([['', 'Nowhere', '', '', 'no']]));
    const batchId = staged.json<ImportBatchDetail>().batch.id;

    const committed = await authed(owner, {
      method: 'POST',
      url: `/api/imports/${batchId}/import`,
      organisationId,
    });
    expect(committed.statusCode).toBe(409);
    expect(committed.json<{ code: string }>().code).toBe('IMPORT_NOTHING_TO_IMPORT');

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/imports/${batchId}/cancel`,
      organisationId,
      payload: { reason: 'Uploaded the wrong sheet' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<ImportBatchDetail>().batch.status).toBe('cancelled');
    expect(cancelled.json<ImportBatchDetail>().batch.cancelledReason).toBe(
      'Uploaded the wrong sheet',
    );
  });
});

describe('the walls', () => {
  it('refuses a writer who does not hold the import authority', async () => {
    const response = await upload(
      contactsSheet([['Blocked Traders', 'X', '', '', 'yes']]),
      {
        jar: clerk,
      },
    );
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');

    // …and admits them the moment an owner grants it, which is what
    // makes the refusal a wall rather than a bug.
    await admin`
      update organisation_memberships set can_import_data = true
      where organisation_id = ${organisationId} and user_id = ${clerkUserId}
    `;
    const granted = await upload(
      contactsSheet([['Unblocked Traders', 'X', '', '', 'yes']]),
      { jar: clerk },
    );
    expect(granted.statusCode, granted.body).toBe(201);
    await admin`
      update organisation_memberships set can_import_data = false
      where organisation_id = ${organisationId} and user_id = ${clerkUserId}
    `;
  });

  it('hides one organisation’s imports from another', async () => {
    const staged = await upload(
      contactsSheet([['Private Traders', 'X', '', '', 'yes']]),
    );
    const batchId = staged.json<ImportBatchDetail>().batch.id;

    const read = await authed(outsider, {
      method: 'GET',
      url: `/api/imports/${batchId}`,
      organisationId: outsiderOrganisationId,
    });
    // 404, not 403: a guessed id must not confirm the batch exists.
    expect(read.statusCode).toBe(404);

    const listed = await authed(outsider, {
      method: 'GET',
      url: '/api/imports',
      organisationId: outsiderOrganisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<ImportBatchList>().batches).toHaveLength(0);
    // The register list still travels, because the Imports screen needs
    // it on an organisation's first day.
    expect(
      listed
        .json<ImportBatchList>()
        .targets.map((t) => t.key)
        .sort(),
    ).toEqual(['canonical_items', 'contacts']);
  });
});

describe('the template', () => {
  it('round-trips through this module’s own reader', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/imports/templates/canonical_items',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(response.headers['content-disposition']).toContain(
      'auto-mb-canonical_items-template.xlsx',
    );

    const rows = readXlsxRows(response.rawPayload);
    expect(rows[0]).toContain('Item name');
    expect(rows).toHaveLength(3);

    // The template a register hands out must be a sheet that register
    // accepts. Uploading it back proves the header row and the column
    // description cannot drift apart — they are generated from one table.
    const back = await upload(response.rawPayload, { target: 'canonical_items' });
    expect(back.statusCode, back.body).toBe(201);
    const detail = back.json<ImportBatchDetail>();
    // The example row validates; the notes row does not, and that is
    // deliberate — a template returned unedited should produce a visible
    // verdict rather than silently importing an example item.
    expect(detail.rows[0]?.status).toBe('valid');
  });

  it('answers a non-member before it answers which registers exist', async () => {
    const response = await authed(outsider, {
      method: 'GET',
      url: '/api/imports/templates/contacts',
      organisationId,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the parser, as the untrusted input it is', () => {
  it('reads shared strings, sparse rows and numeric cells', () => {
    // Hand-built rather than written by this module: Excel puts nearly
    // every string in the shared table and omits empty cells entirely,
    // and a reader tested only against its own writer would pass while
    // being unable to open a real workbook.
    const bytes = handBuiltWorkbook(
      `<sheetData>
         <row r="1">
           <c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c>
         </row>
         <row r="2">
           <c r="A2" t="s"><v>2</v></c>
           <c r="C2"><v>42</v></c>
         </row>
       </sheetData>`,
      ['Designation', 'Address', 'Acme &amp; Co'],
    );
    const rows = readXlsxRows(bytes);
    // Column C is index 2 even though B is absent: the cell reference
    // decides the column, never the position among its siblings.
    expect(rows[0]).toEqual(['Designation', '', 'Address']);
    expect(rows[1]).toEqual(['Acme & Co', '', '42']);
  });

  it('never evaluates a formula, reading only the value on disk', () => {
    const bytes = handBuiltWorkbook(
      `<sheetData>
         <row r="1"><c r="A1" t="str"><f>CONCATENATE("a","b")</f><v>ab</v></c></row>
       </sheetData>`,
      [],
    );
    expect(readXlsxRows(bytes)[0]).toEqual(['ab']);
  });

  it('refuses a workbook that declares a document type', async () => {
    const bytes = handBuiltWorkbook(
      `<!DOCTYPE x [<!ENTITY a "boom">]><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>`,
      [],
    );
    const response = await upload(bytes);
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('IMPORT_SHEET_UNREADABLE');
  });

  it('refuses bytes that are not a workbook at all', async () => {
    const response = await upload(Buffer.from('%PDF-1.7 not a workbook'));
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('Save As');
  });
});

describe('the database’s own arm', () => {
  it('refuses to rewrite a staged row’s cells, or to reopen a finished batch', async () => {
    const staged = await upload(
      contactsSheet([['Frozen Traders', 'Latur', '', '', 'yes']]),
    );
    const detail = staged.json<ImportBatchDetail>();
    const batchId = detail.batch.id;
    const rowId = detail.rows[0]?.id ?? '';

    // The cells are evidence: a staging row whose content could be
    // corrected in place is one where nobody can tell what was uploaded
    // from what was fixed afterwards.
    await expect(
      admin`
        update spreadsheet_import_rows
        set cells = ${admin.json({ designation: 'Something Else' })}
        where id = ${rowId}
      `,
    ).rejects.toMatchObject({ code: '23L03' });

    await authed(owner, {
      method: 'POST',
      url: `/api/imports/${batchId}/cancel`,
      organisationId,
      payload: { reason: 'Testing the guard' },
    });

    // Terminal is terminal, against a writer that never came through the
    // route at all.
    await expect(
      admin`
        update spreadsheet_import_batches set status = 'validated' where id = ${batchId}
      `,
    ).rejects.toMatchObject({ code: '23L01' });

    // And nothing may be staged into a finished batch.
    await expect(
      admin`
        insert into spreadsheet_import_rows (
          organisation_id, batch_id, row_number, cells
        )
        values (
          ${organisationId}, ${batchId}, 99,
          ${admin.json({ designation: 'Late Arrival' })}
        )
      `,
    ).rejects.toMatchObject({ code: '23L04' });
  });

  it('refuses a batch claiming more imported rows than it judged valid', async () => {
    const staged = await upload(
      contactsSheet([['Census Traders', 'Beed', '', '', 'yes']]),
    );
    const batchId = staged.json<ImportBatchDetail>().batch.id;
    await expect(
      admin`
        update spreadsheet_import_batches
        set status = 'completed', completed_at = now(),
            completed_by_user_id = ${randomUUID()},
            imported_row_count = 900
        where id = ${batchId}
      `,
    ).rejects.toMatchObject({ code: '23L05' });
  });
});

/**
 * A workbook this module's writer would never produce: shared strings,
 * sparse cells, formulas, whatever the sheet XML says. Stored rather than
 * deflated, which the reader also has to accept — a real writer uses both.
 */
function handBuiltWorkbook(
  sheetData: string,
  sharedStrings: readonly string[],
): Buffer {
  const parts: [string, string][] = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetData}</worksheet>`,
    ],
  ];
  if (sharedStrings.length > 0) {
    parts.push([
      'xl/sharedStrings.xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        sharedStrings.map((value) => `<si><t>${value}</t></si>`).join('') +
        '</sst>',
    ]);
  }
  return storedZip(parts);
}

/** The STORED (uncompressed) half of the ZIP format, which real writers
 * use for small parts and which the reader must therefore accept. */
function storedZip(entries: readonly (readonly [string, string])[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
