import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations, withTenant } from '@auto-mb/db';
import {
  ADDRESS_NOT_RECORDED,
  IMPORT_ACTOR,
  runV1Import,
} from '../src/import/importer.js';
import { parseMappingConfig } from '../src/import/mapping.js';
import { readV1Backup } from '../src/import/v1-backup.js';
import { quantize } from '../src/import/decimal.js';
import { parseChallanNumber, parseSerials } from '../src/import/parse.js';
import type { RunReport } from '../src/import/report.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';

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

const runId = randomBytes(4).toString('hex');
const alphaSlug = `imp-alpha-${runId}`;
const betaSlug = `imp-beta-${runId}`;

const mapping = parseMappingConfig({
  organisations: [
    { slug: alphaSlug, name: 'Alpha Corp Ltd.' },
    { slug: betaSlug, name: 'Beta Ltd.' },
  ],
  companyToOrganisation: {
    'Alpha Corp': alphaSlug,
    'ALPHA CORP LTD': alphaSlug,
    'Beta Ltd': betaSlug,
  },
  excludeCompanies: ['Gamma Traders'],
});

let admin: Sql;
let app: Sql;
let fixtureDir: string;
let fixturePath: string;

/** Builds the synthetic v1 backup. Shapes covered: lowercase work code,
 * variations with their own rate, zero-padded + gapped challan series,
 * pending above and inside the series, serial noise + duplicate, a
 * pre-LOA challan, and a challan disagreeing with its Work's company. */
function buildFixture(filePath: string, options: { w2TotalCost: number }): void {
  const db = new DatabaseSync(filePath);
  db.exec(`
    create table works (id text primary key, fileNo text, name text, zone text,
      division text, loaNo text, loaDate text, tenderIssuingAuthority text default '',
      caNo text default '', caDate text default '', totalCost real, pbgLoa real default 0,
      pbgActual real default 0, actualCompletionPeriod text default '',
      workExtensionPeriod text default '', pbgCompletionPeriod text default '',
      excelFilename text default '', contractorName text);
    create table work_items (id text primary key, workId text, schedule text,
      srNo integer, description text, unit text, qty real, variation real default 0,
      rate real, agtRate real, total real);
    create table item_variations (id text primary key, workItemId text,
      variationNo integer, qty real, rate real, remark text default '',
      date text default '', createdAt text default '', source text default '');
    create table delivery_challans (id text primary key, typeId integer,
      challanNo text, date text, "to" text, company text, remark text default '',
      workId text, createdAt text, siteEngineer text default '',
      status text default 'confirmed', createdBy text);
    create table delivery_challan_items (id text primary key, challanId text,
      itemId text, scheduleNo text default '', description text, unit text,
      qty real, variation real default 0, rate real, remark text default '',
      warrantyQty real, serialNo text default '');
    create table consignees (id integer primary key, name text);
    create table companies (id integer primary key, name text);
    create table users (id text primary key, username text);
  `);
  const insert = (sql: string, rows: unknown[][]): void => {
    const statement = db.prepare(sql);
    for (const row of rows) statement.run(...(row as never[]));
  };
  insert(`insert into users values (?, ?)`, [['u-1', 'tester']]);
  insert(`insert into consignees values (?, ?)`, [[1, 'Store A']]);
  insert(`insert into companies values (?, ?)`, [
    [1, 'Alpha Corp'],
    [2, 'Beta Ltd'],
    [3, 'Gamma Traders'],
  ]);
  insert(
    `insert into works (id, fileNo, name, zone, division, loaNo, loaDate, totalCost,
       actualCompletionPeriod, contractorName)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      [
        'w-1690000000000-w1aaa',
        'Pl-x1', // lowercase quirk -> normalised to PL-X1 per R1
        'Alpha work one for import testing',
        'Zone Z',
        'Division D',
        `LOA/ALPHA/1/${runId}`,
        '2023-01-10',
        10000.505,
        'nine months from LOA', // free text -> provenance, never a date
        'Alpha Corp',
      ],
      [
        'w-1690000100000-w2aaa',
        'PL-X2',
        'Alpha work two for import testing',
        'Zone Z',
        'Division D',
        `LOA/ALPHA/2/${runId}`,
        '2023-01-15',
        options.w2TotalCost,
        '',
        'ALPHA CORP LTD',
      ],
      [
        'w-1690000200000-w3aaa',
        'PL-X3',
        'Beta work three for import testing',
        'Zone Y',
        'Division E',
        `LOA/BETA/3/${runId}`,
        '2023-05-01',
        7000,
        '',
        'Beta Ltd',
      ],
    ],
  );
  insert(
    `insert into work_items (id, workId, schedule, srNo, description, unit, qty,
       variation, rate, agtRate, total) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      [
        'item-w1-A-1',
        'w-1690000000000-w1aaa',
        'A',
        1,
        'Alpha item A1 desc',
        'Nos',
        10,
        0,
        100,
        90,
        900,
      ],
      // 5.5555 quantizes to 5.556 (counted); variation row priced at 150.
      [
        'item-w1-A-2',
        'w-1690000000000-w1aaa',
        'A',
        2,
        'Alpha item A2 desc',
        'Nos',
        5.5555,
        2,
        200,
        180,
        1300,
      ],
      [
        'item-w1-B-1',
        'w-1690000000000-w1aaa',
        'B',
        1,
        'Serial-tracked item',
        'Nos',
        3,
        0,
        60,
        50,
        150,
      ],
      [
        'item-w2-A-1',
        'w-1690000100000-w2aaa',
        '1',
        1,
        'Alpha W2 item',
        'Mtr',
        100,
        0,
        10,
        8,
        800,
      ],
      [
        'item-w3-A-1',
        'w-1690000200000-w3aaa',
        'A',
        1,
        'Beta item one',
        'Nos',
        50,
        0,
        20,
        20,
        1000,
      ],
      [
        'item-w3-A-2',
        'w-1690000200000-w3aaa',
        'A',
        2,
        'Beta item two',
        'Nos',
        30,
        0,
        20,
        20,
        600,
      ],
    ],
  );
  insert(
    `insert into item_variations (id, workItemId, variationNo, qty, rate, remark, createdAt, source)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      [
        'var-w1-A-2-1',
        'item-w1-A-2',
        1,
        2,
        150,
        'extra sanctioned qty',
        '2023-06-01',
        'excel',
      ],
    ],
  );
  insert(
    `insert into delivery_challans (id, typeId, challanNo, date, "to", company, workId,
       createdAt, status, createdBy) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      // W1: zero-padded 08, then 9 — gap 1..7 reported, never filled.
      [
        'dc-1691000000000-c18aa',
        1,
        'AX-DC-08',
        '2023-02-01',
        ' Store A ',
        'Alpha Corp',
        'w-1690000000000-w1aaa',
        '2023-02-01T10:00:00.000Z',
        'confirmed',
        'u-1',
      ],
      [
        'dc-1691000001000-c19aa',
        1,
        'AX-DC-9',
        '2023-03-05',
        'Store A',
        'Alpha Corp',
        'w-1690000000000-w1aaa',
        '2023-03-05T09:30:00.000Z',
        'confirmed',
        'u-1',
      ],
      // pending ABOVE the confirmed head -> clean draft, no exception.
      [
        'dc-1691000002000-c1paa',
        1,
        'AX-DC-10',
        '2023-04-01',
        'Store A',
        'Alpha Corp',
        'w-1690000000000-w1aaa',
        '2023-04-01T08:00:00.000Z',
        'pending',
        'u-1',
      ],
      // W2: 1, 2, 4 confirmed (gap 3); pending 3 mid-series; pending 5 second draft.
      [
        'dc-1691000100000-c21aa',
        1,
        'W2-DC-1',
        '2023-02-01',
        'Store A',
        'ALPHA CORP LTD',
        'w-1690000100000-w2aaa',
        '2023-02-01T11:00:00.000Z',
        'confirmed',
        'u-1',
      ],
      [
        'dc-1691000101000-c22aa',
        1,
        'W2-DC-2',
        '2023-02-10',
        'Store A',
        'ALPHA CORP LTD',
        'w-1690000100000-w2aaa',
        '2023-02-10T11:00:00.000Z',
        'confirmed',
        'u-1',
      ],
      [
        'dc-1691000102000-c24aa',
        1,
        'W2-DC-4',
        '2023-03-01',
        'Store A',
        'ALPHA CORP LTD',
        'w-1690000100000-w2aaa',
        '2023-03-01T11:00:00.000Z',
        'confirmed',
        'u-1',
      ],
      [
        'dc-1691000103000-p23aa',
        1,
        'W2-DC-3',
        '2023-02-20',
        'Store A',
        'ALPHA CORP LTD',
        'w-1690000100000-w2aaa',
        '2023-02-20T11:00:00.000Z',
        'pending',
        'u-1',
      ],
      [
        'dc-1691000104000-p25aa',
        1,
        'W2-DC-5',
        '2023-03-10',
        'Store A',
        'ALPHA CORP LTD',
        'w-1690000100000-w2aaa',
        '2023-03-10T11:00:00.000Z',
        'pending',
        'u-1',
      ],
      // W3 (Beta): pre-LOA challan, duplicate serial, company disagreement.
      [
        'dc-1691000200000-b1aaa',
        1,
        'B3-DC-1',
        '2023-04-01',
        'Store B',
        'Beta Ltd',
        'w-1690000200000-w3aaa',
        '2023-04-01T12:00:00.000Z',
        'confirmed',
        'u-1',
      ],
      [
        'dc-1691000201000-b2aaa',
        1,
        'B3-DC-2',
        '2023-06-01',
        'Store B',
        'Beta Ltd',
        'w-1690000200000-w3aaa',
        '2023-06-01T12:00:00.000Z',
        'confirmed',
        'u-1',
      ],
      [
        'dc-1691000202000-b3aaa',
        1,
        'B3-DC-3',
        '2023-06-10',
        'Store B',
        'Alpha Corp',
        'w-1690000200000-w3aaa',
        '2023-06-10T12:00:00.000Z',
        'confirmed',
        'u-1',
      ],
    ],
  );
  insert(
    `insert into delivery_challan_items (id, challanId, itemId, description, unit, qty,
       rate, warrantyQty, serialNo) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      [
        'ci-1691000000001-l181a',
        'dc-1691000000000-c18aa',
        'item-w1-A-1',
        'Alpha item A1 desc',
        'Nos',
        4,
        90,
        1,
        '',
      ],
      [
        'ci-1691000001001-l191a',
        'dc-1691000001000-c19aa',
        'item-w1-A-1',
        'Alpha item A1 desc',
        'Nos',
        2,
        90,
        null,
        '',
      ],
      // Serial list with noise prefix, newline and comma separators,
      // trailing punctuation.
      [
        'ci-1691000001002-l192a',
        'dc-1691000001000-c19aa',
        'item-w1-B-1',
        'Serial-tracked item',
        'Nos',
        3,
        50,
        null,
        'Sr.No.SN-001 \nSN-002,SN-003.',
      ],
      [
        'ci-1691000002001-l1p1a',
        'dc-1691000002000-c1paa',
        'item-w1-A-1',
        'Alpha item A1 desc',
        'Nos',
        1,
        90,
        null,
        '',
      ],
      [
        'ci-1691000100001-l211a',
        'dc-1691000100000-c21aa',
        'item-w2-A-1',
        'Alpha W2 item',
        'Mtr',
        10,
        8,
        null,
        '',
      ],
      [
        'ci-1691000101001-l221a',
        'dc-1691000101000-c22aa',
        'item-w2-A-1',
        'Alpha W2 item',
        'Mtr',
        10,
        8,
        null,
        '',
      ],
      [
        'ci-1691000102001-l241a',
        'dc-1691000102000-c24aa',
        'item-w2-A-1',
        'Alpha W2 item',
        'Mtr',
        5,
        8,
        null,
        '',
      ],
      [
        'ci-1691000103001-lp231',
        'dc-1691000103000-p23aa',
        'item-w2-A-1',
        'Alpha W2 item',
        'Mtr',
        2,
        8,
        null,
        '',
      ],
      [
        'ci-1691000104001-lp251',
        'dc-1691000104000-p25aa',
        'item-w2-A-1',
        'Alpha W2 item',
        'Mtr',
        2,
        8,
        null,
        '',
      ],
      [
        'ci-1691000200001-lb11a',
        'dc-1691000200000-b1aaa',
        'item-w3-A-1',
        'Beta item one',
        'Nos',
        5,
        20,
        null,
        '',
      ],
      // Duplicate serial DUP-1 across two lines of the same Work; SN-001
      // also exists in W1 but that is a DIFFERENT Work — allowed.
      [
        'ci-1691000201001-lb21a',
        'dc-1691000201000-b2aaa',
        'item-w3-A-1',
        'Beta item one',
        'Nos',
        2,
        20,
        null,
        'DUP-1\nSN-001',
      ],
      [
        'ci-1691000201002-lb22a',
        'dc-1691000201000-b2aaa',
        'item-w3-A-2',
        'Beta item two',
        'Nos',
        2,
        20,
        null,
        'DUP-1',
      ],
    ],
  );
  db.close();
}

function fingerprintTotals(report: RunReport, slug: string) {
  const org = report.organisations.find((entry) => entry.slug === slug);
  if (!org) throw new Error(`missing org ${slug} in report`);
  return org;
}

async function countRows(table: string, organisationIds: string[]): Promise<number> {
  const column = table === 'organisations' ? 'id' : 'organisation_id';
  const rows = (await admin.unsafe(
    `select count(*)::int as count from ${table} where ${column} = any($1::uuid[])`,
    [organisationIds],
  )) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

const CLEANUP_TABLES = [
  'import_records',
  'import_batches',
  'audit_events',
  'challan_item_serials',
  'delivery_challan_items',
  'delivery_challans',
  'delivery_challan_counters',
  'consignee_masters',
  'work_items',
  'work_schedules',
  'works',
  'organisation_memberships',
  'organisations',
];

async function organisationIds(): Promise<string[]> {
  const rows = await admin<{ id: string }[]>`
    select id from organisations where slug in (${alphaSlug}, ${betaSlug})
  `;
  return rows.map((row) => row.id);
}

async function cleanup(): Promise<void> {
  const ids = await organisationIds();
  if (ids.length === 0) return;
  // Test-fixture cleanup only: issued documents rightly refuse ordinary
  // deletes, so residue removal runs with triggers disabled (same pattern
  // as the tenancy suite). The importer itself never does this.
  await admin.unsafe(`set session_replication_role = 'replica'`);
  try {
    for (const table of CLEANUP_TABLES) {
      const column = table === 'organisations' ? 'id' : 'organisation_id';
      await admin.unsafe(`delete from ${table} where ${column} = any($1::uuid[])`, [
        ids,
      ]);
    }
  } finally {
    await admin.unsafe(`set session_replication_role = 'origin'`);
  }
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-import-test-admin',
  });
  await admin`select 1 as ready`;
  await runMigrations(admin, migrationsDirectory);
  app = createDatabasePool({
    url: appUrl,
    max: 2,
    applicationName: 'auto-mb-import-test-app',
  });
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-import-'));
  fixturePath = path.join(fixtureDir, 'v1-fixture.sqlite');
  buildFixture(fixturePath, { w2TotalCost: 5000 });
  await cleanup();
}, 60_000);

afterAll(async () => {
  try {
    await cleanup();
    await rm(fixtureDir, { recursive: true, force: true });
  } finally {
    await app?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  }
});

describe('v1 importer against a synthetic backup', () => {
  it('dry-run executes the whole pipeline and leaves the database fully clean', async () => {
    const backup = readV1Backup(fixturePath);
    const report = await runV1Import(admin, {
      backup,
      mapping,
      mode: 'dry-run',
      inputDigest: 'a'.repeat(64),
    });
    expect(report.mode).toBe('dry-run');
    const alpha = fingerprintTotals(report, alphaSlug);
    expect(alpha.counts.work?.imported).toBe(2);
    // Rolled back: no organisations, hence no rows of any kind.
    expect(await organisationIds()).toHaveLength(0);
    const [batches] = await admin<{ count: string }[]>`
      select count(*)::text as count from import_batches
      where id = ${alpha.batchId}
    `;
    expect(batches?.count).toBe('0');
  }, 60_000);

  let firstRun: RunReport;

  it('apply imports both organisations with the mapped company spellings', async () => {
    const backup = readV1Backup(fixturePath);
    firstRun = await runV1Import(admin, {
      backup,
      mapping,
      mode: 'apply',
      inputDigest: 'a'.repeat(64),
    });
    const alpha = fingerprintTotals(firstRun, alphaSlug);
    const beta = fingerprintTotals(firstRun, betaSlug);

    // Tenant mapping: two spellings converge on one organisation.
    expect(alpha.counts.work).toMatchObject({ source: 2, imported: 2, excepted: 0 });
    expect(beta.counts.work).toMatchObject({ source: 1, imported: 1 });
    expect(alpha.counts.work_schedule).toMatchObject({ source: 3, imported: 3 });
    expect(alpha.counts.work_item).toMatchObject({ source: 4, imported: 4 });
    expect(alpha.counts.item_variation).toMatchObject({ source: 1, imported: 1 });
    // W1: 2 issued + 1 draft; W2: 3 issued + 1 draft; 1 excepted (2nd draft).
    expect(alpha.counts.delivery_challan).toMatchObject({
      source: 8,
      imported: 7,
      excepted: 1,
    });
    expect(alpha.counts.delivery_challan_item).toMatchObject({
      source: 9,
      imported: 8,
    });

    // The excluded company is tallied, not imported.
    expect(firstRun.excludedCompanies).toEqual([]);
    expect(firstRun.unmappedCompanies).toEqual([]);
    expect(firstRun.organisations).toHaveLength(2);

    // Organisations are created idle: no memberships.
    const ids = await organisationIds();
    expect(ids).toHaveLength(2);
    expect(await countRows('organisation_memberships', ids)).toBe(0);
  }, 120_000);

  it('preserves work codes per R1 and keeps the original spelling in provenance', async () => {
    const [work] = await admin<
      { id: string; work_code: string; contract_value: string }[]
    >`
      select w.id, w.work_code, w.contract_value::text as contract_value
      from works w join organisations o on o.id = w.organisation_id
      where o.slug = ${alphaSlug} and w.letter_number = ${`LOA/ALPHA/1/${runId}`}
    `;
    expect(work?.work_code).toBe('PL-X1');
    expect(work?.contract_value).toBe('10000.51');
    const [record] = await admin<{ payload: unknown }[]>`
      select payload from import_records
      where entity_type = 'work' and source_id = 'w-1690000000000-w1aaa'
    `;
    const payload = record?.payload as { originalFileNo?: string };
    expect(payload.originalFileNo).toBe('Pl-x1');
  });

  it('maps the agreement rate into effective_rate and folds variations into effective_quantity', async () => {
    const [item] = await admin<
      {
        awarded_quantity: string;
        effective_rate: string;
        effective_quantity: string | null;
        effective_unit_rate: string | null;
      }[]
    >`
      select wi.awarded_quantity::text as awarded_quantity,
             wi.effective_rate::text as effective_rate,
             wi.effective_quantity::text as effective_quantity,
             wi.effective_unit_rate::text as effective_unit_rate
      from work_items wi
      join import_records ir on ir.target_id = wi.id and ir.entity_type = 'work_item'
      where ir.source_id = 'item-w1-A-2'
    `;
    // Quantization: 5.5555 -> 5.556 (half away from zero, 3dp).
    expect(item).toMatchObject({
      awarded_quantity: '5.556',
      effective_rate: '180.00', // agtRate, the v1 agreement rate
      effective_quantity: '7.556', // qty + variation deltas
      effective_unit_rate: null, // no fabricated amendment
    });
    const alpha = fingerprintTotals(firstRun, alphaSlug);
    expect(alpha.quantization.awarded_quantity?.changed).toBe(1);
    expect(alpha.quantization.effective_quantity?.changed).toBe(1);
    expect(alpha.quantization.contract_value?.changed).toBe(1);
    expect(
      alpha.quantizationWorst.some(
        (drift) =>
          drift.fieldClass === 'awarded_quantity' &&
          drift.sourceId === 'item-w1-A-2' &&
          drift.quantized === '5.556',
      ),
    ).toBe(true);
    // The variation priced off the agreement rate is surfaced.
    expect(alpha.variationRateDivergences.count).toBe(1);
  });

  it('preserves challan numbers exactly, parses zero-padded sequences and places counters at highest', async () => {
    const rows = await admin<
      {
        challan_number: string | null;
        sequence_number: number | null;
        status: string;
        prefix: string;
      }[]
    >`
      select dc.challan_number, dc.sequence_number, dc.status, dc.prefix
      from delivery_challans dc
      join import_records ir on ir.target_id = dc.id and ir.entity_type = 'delivery_challan'
      join organisations o on o.id = dc.organisation_id
      where o.slug = ${alphaSlug}
      order by dc.challan_date, dc.challan_number nulls last
    `;
    const issued = rows.filter((row) => row.status === 'issued');
    expect(issued.map((row) => [row.challan_number, row.sequence_number])).toEqual(
      expect.arrayContaining([
        ['AX-DC-08', 8], // zero padding preserved in the number, parsed numerically
        ['AX-DC-9', 9],
        ['W2-DC-1', 1],
        ['W2-DC-2', 2],
        ['W2-DC-4', 4],
      ]),
    );
    const drafts = rows.filter((row) => row.status === 'draft');
    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      expect(draft.challan_number).toBeNull();
      expect(draft.sequence_number).toBeNull();
    }

    // Counter placement: stored value = highest imported sequence, so the
    // live route's increment-then-read upsert mints highest + 1 next.
    const [w1] = await admin<{ id: string; organisation_id: string }[]>`
      select w.id, w.organisation_id from works w
      join organisations o on o.id = w.organisation_id
      where o.slug = ${alphaSlug} and w.work_code = 'PL-X1'
    `;
    if (!w1) throw new Error('W1 missing');
    const [counter] = await admin<{ next_value: number }[]>`
      select next_value from delivery_challan_counters
      where organisation_id = ${w1.organisation_id} and work_id = ${w1.id}
    `;
    expect(counter?.next_value).toBe(9);
    const [minted] = await admin<{ next_value: number }[]>`
      insert into delivery_challan_counters (organisation_id, work_id)
      values (${w1.organisation_id}, ${w1.id})
      on conflict (organisation_id, work_id)
      do update set next_value = delivery_challan_counters.next_value + 1
      returning next_value
    `;
    expect(minted?.next_value).toBe(10); // exactly highest + 1, per R2
    await admin`
      update delivery_challan_counters set next_value = ${9}
      where organisation_id = ${w1.organisation_id} and work_id = ${w1.id}
    `.catch(() => undefined); // decrease guard may refuse; irrelevant to later tests

    // Gap reporting: counted and listed, never filled.
    const alpha = fingerprintTotals(firstRun, alphaSlug);
    const w1Series = alpha.challanSeries.find((series) => series.workCode === 'PL-X1');
    expect(w1Series).toMatchObject({ highestSequence: 9, gapCount: 7 });
    expect(w1Series?.gaps).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const w2Series = alpha.challanSeries.find((series) => series.workCode === 'PL-X2');
    expect(w2Series).toMatchObject({ highestSequence: 4, gapCount: 1 });
    expect(w2Series?.gaps).toEqual([3]);
  });

  it('handles pending challans: draft without number, mid-series exception, one-draft rule', async () => {
    const alpha = fingerprintTotals(firstRun, alphaSlug);
    const rules = alpha.exceptions.map((exception) => exception.rule);
    expect(rules).toContain('pending-below-series-head');
    expect(rules).toContain('one-draft-per-work');
    // The pending challan ABOVE its series head produces no exception.
    expect(
      alpha.exceptions.filter(
        (exception) => exception.sourceId === 'dc-1691000002000-c1paa',
      ),
    ).toEqual([]);
    // The mid-series pending is imported as the (single) W2 draft.
    const [draft] = await admin<{ status: string }[]>`
      select status from delivery_challans dc
      join import_records ir on ir.target_id = dc.id
      where ir.source_id = 'dc-1691000103000-p23aa'
    `;
    expect(draft?.status).toBe('draft');
    const [second] = await admin<{ count: string }[]>`
      select count(*)::text as count from import_records
      where source_id = 'dc-1691000104000-p25aa'
    `;
    expect(second?.count).toBe('0');
  });

  it('parses serial noise, enforces per-work uniqueness loudly, flags requires_serials', async () => {
    expect(parseSerials('Sr.No.SN-001 \nSN-002,SN-003.')).toEqual([
      'SN-001',
      'SN-002',
      'SN-003',
    ]);
    const serials = await admin<{ serial_number: string }[]>`
      select s.serial_number from challan_item_serials s
      join organisations o on o.id = s.organisation_id
      where o.slug = ${alphaSlug} order by s.serial_number
    `;
    expect(serials.map((row) => row.serial_number)).toEqual([
      'SN-001',
      'SN-002',
      'SN-003',
    ]);
    const betaSerials = await admin<{ serial_number: string }[]>`
      select s.serial_number from challan_item_serials s
      join organisations o on o.id = s.organisation_id
      where o.slug = ${betaSlug} order by s.serial_number
    `;
    // DUP-1 imported once; SN-001 allowed here (different Work + org).
    expect(betaSerials.map((row) => row.serial_number)).toEqual(['DUP-1', 'SN-001']);
    const beta = fingerprintTotals(firstRun, betaSlug);
    const duplicate = beta.exceptions.find(
      (exception) => exception.rule === 'duplicate-serial-in-work',
    );
    expect(duplicate?.detail).toContain('ci-1691000201001-lb21a');
    expect(duplicate?.detail).toContain('ci-1691000201002-lb22a');
    expect(beta.serials).toMatchObject({ sourceTokens: 3, imported: 2, excepted: 1 });

    const flagged = await admin<{ source_id: string; requires_serials: boolean }[]>`
      select ir.source_id, wi.requires_serials
      from work_items wi
      join import_records ir on ir.target_id = wi.id and ir.entity_type = 'work_item'
      order by ir.source_id
    `;
    const bySource = new Map(
      flagged.map((row) => [row.source_id, row.requires_serials]),
    );
    expect(bySource.get('item-w1-B-1')).toBe(true);
    expect(bySource.get('item-w3-A-1')).toBe(true);
    expect(bySource.get('item-w3-A-2')).toBe(true);
    expect(bySource.get('item-w1-A-1')).toBe(false);
  });

  it('rejects guard-violating rows as named exceptions: pre-LOA challan, company disagreement', async () => {
    const beta = fingerprintTotals(firstRun, betaSlug);
    const preLoa = beta.exceptions.find(
      (exception) => exception.rule === 'challan-date-precedes-loa (0010)',
    );
    expect(preLoa?.sourceId).toBe('dc-1691000200000-b1aaa');
    const disagreement = beta.exceptions.find(
      (exception) => exception.rule === 'challan-work-company-disagreement',
    );
    expect(disagreement?.sourceId).toBe('dc-1691000202000-b3aaa');
    // Neither row exists in the database.
    const [absent] = await admin<{ count: string }[]>`
      select count(*)::text as count from import_records
      where source_id in ('dc-1691000200000-b1aaa', 'dc-1691000202000-b3aaa')
    `;
    expect(absent?.count).toBe('0');
    expect(beta.counts.delivery_challan).toMatchObject({
      source: 3,
      imported: 1,
      excepted: 2,
    });
  });

  it('preserves historical timestamps: created_at from v1, issued_at from the challan date', async () => {
    const [challan] = await admin<
      {
        created_at: Date;
        issued_at: Date;
        template_version: string | null;
        issued_by: string | null;
      }[]
    >`
      select dc.created_at, dc.issued_at, dc.template_version,
             dc.issued_by_user_id as issued_by
      from delivery_challans dc
      join import_records ir on ir.target_id = dc.id
      where ir.source_id = 'dc-1691000000000-c18aa'
    `;
    expect(challan?.created_at.toISOString()).toBe('2023-02-01T10:00:00.000Z');
    // 2023-02-01 midnight IST == 2023-01-31T18:30Z.
    expect(challan?.issued_at.toISOString()).toBe('2023-01-31T18:30:00.000Z');
    expect(challan?.issued_by).toBe(IMPORT_ACTOR);

    const [work] = await admin<{ created_at: Date }[]>`
      select w.created_at from works w
      join import_records ir on ir.target_id = w.id and ir.entity_type = 'work'
      where ir.source_id = 'w-1690000000000-w1aaa'
    `;
    // The v1 primary key embeds the creation instant.
    expect(work?.created_at.toISOString()).toBe(new Date(1690000000000).toISOString());
  });

  it('writes issued snapshots in the live route shape with exact numeric strings', async () => {
    const [row] = await admin<{ issued_snapshot: unknown }[]>`
      select issued_snapshot from delivery_challans dc
      join import_records ir on ir.target_id = dc.id
      where ir.source_id = 'dc-1691000001000-c19aa'
    `;
    const snapshot =
      typeof row?.issued_snapshot === 'string'
        ? (JSON.parse(row.issued_snapshot) as Record<string, unknown>)
        : (row?.issued_snapshot as Record<string, unknown>);
    expect(snapshot).toMatchObject({
      templateVersion: 'dc-v3',
      challanNumber: 'AX-DC-9',
      challanDate: '2023-03-05',
      totalAmount: '330.00', // 2×90 + 3×50, exact numeric
      consignee: { name: 'Store A', address: ADDRESS_NOT_RECORDED },
    });
    const items = snapshot.items as {
      quantity: string;
      rate: string;
      lineAmount: string;
    }[];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.lineAmount)).toEqual(['180.00', '150.00']);
  });

  it('reconciles value totals against hand-computed sums', () => {
    const alpha = fingerprintTotals(firstRun, alphaSlug);
    // Contract: 10000.505 + 5000 quantized.
    expect(alpha.valueTotals.contractValueSource).toBe('15000.51');
    expect(alpha.valueTotals.contractValueImported).toBe('15000.51');
    // Imported lines: 4×90 + 2×90 + 3×50 + 1×90 (draft) + (10+10+5+2)×8 = 996.
    // Source additionally counts the excepted second draft's line (2×8).
    expect(alpha.valueTotals.challanLineTotalImported).toBe('996.00');
    expect(Number(alpha.valueTotals.challanLineTotalSource)).toBeCloseTo(1012, 6);
    const beta = fingerprintTotals(firstRun, betaSlug);
    // Only B3-DC-2 imported: (2+2)×20 = 80; source counts all mapped lines.
    expect(beta.valueTotals.challanLineTotalImported).toBe('80.00');
    expect(Number(beta.valueTotals.challanLineTotalSource)).toBeCloseTo(180, 6);
  });

  it('records complete provenance and stores the reconciliation in the batch row', async () => {
    const alpha = fingerprintTotals(firstRun, alphaSlug);
    const rows = await admin<{ entity_type: string; count: string }[]>`
      select entity_type, count(*)::text as count from import_records ir
      join organisations o on o.id = ir.organisation_id
      where o.slug = ${alphaSlug}
      group by entity_type order by entity_type
    `;
    const byEntity = new Map(rows.map((row) => [row.entity_type, Number(row.count)]));
    for (const entity of [
      'consignee_master',
      'work',
      'work_schedule',
      'work_item',
      'item_variation',
      'delivery_challan',
      'delivery_challan_item',
      'challan_item_serial',
    ]) {
      expect(byEntity.get(entity) ?? 0, entity).toBe(
        alpha.counts[entity]?.imported ?? 0,
      );
    }
    const [batch] = await admin<
      { dry_run: boolean; finished_at: Date | null; reconciliation: unknown }[]
    >`
      select dry_run, finished_at, reconciliation from import_batches
      where id = ${alpha.batchId}
    `;
    expect(batch?.dry_run).toBe(false);
    expect(batch?.finished_at).not.toBeNull();
    const reconciliation =
      typeof batch?.reconciliation === 'string'
        ? (JSON.parse(batch.reconciliation) as { slug?: string })
        : (batch?.reconciliation as { slug?: string });
    expect(reconciliation?.slug).toBe(alphaSlug);
  });

  it('is idempotent: a re-run of the same input imports zero new rows', async () => {
    const ids = await organisationIds();
    // Every run intentionally appends its own batch row and completion
    // audit event; the business tables must not move at all.
    const invariantTables = CLEANUP_TABLES.filter(
      (table) => table !== 'import_batches' && table !== 'audit_events',
    );
    const before = new Map<string, number>();
    for (const table of invariantTables) {
      before.set(table, await countRows(table, ids));
    }
    const backup = readV1Backup(fixturePath);
    const second = await runV1Import(admin, {
      backup,
      mapping,
      mode: 'apply',
      inputDigest: 'a'.repeat(64),
    });
    const alpha = fingerprintTotals(second, alphaSlug);
    expect(alpha.counts.work).toMatchObject({ imported: 0, unchanged: 2, drifted: 0 });
    expect(alpha.counts.delivery_challan).toMatchObject({ imported: 0, unchanged: 7 });
    expect(alpha.counts.work_item).toMatchObject({ imported: 0, unchanged: 4 });
    expect(alpha.counts.challan_item_serial).toMatchObject({
      imported: 0,
      unchanged: 3,
    });
    expect(alpha.serials).toMatchObject({ imported: 0, unchanged: 3 });
    for (const table of invariantTables) {
      expect(await countRows(table, ids), table).toBe(before.get(table));
    }
  }, 120_000);

  it('reports drift on a changed source row and repairs nothing silently', async () => {
    const driftedPath = path.join(fixtureDir, 'v1-fixture-drift.sqlite');
    buildFixture(driftedPath, { w2TotalCost: 6000 });
    const backup = readV1Backup(driftedPath);
    const third = await runV1Import(admin, {
      backup,
      mapping,
      mode: 'apply',
      inputDigest: 'b'.repeat(64),
    });
    const alpha = fingerprintTotals(third, alphaSlug);
    expect(alpha.counts.work).toMatchObject({ imported: 0, unchanged: 1, drifted: 1 });
    const drift = alpha.exceptions.find(
      (exception) => exception.rule === 'source-drift',
    );
    expect(drift?.sourceId).toBe('w-1690000100000-w2aaa');
    // The imported row keeps its original value: nothing silently repaired.
    const [work] = await admin<{ contract_value: string }[]>`
      select contract_value::text as contract_value from works w
      join import_records ir on ir.target_id = w.id and ir.entity_type = 'work'
      where ir.source_id = 'w-1690000100000-w2aaa'
    `;
    expect(work?.contract_value).toBe('5000.00');
  }, 120_000);

  it('keeps imported rows tenant-isolated under the application role', async () => {
    const [alphaOrg] = await admin<{ id: string }[]>`
      select id from organisations where slug = ${alphaSlug}
    `;
    const [betaOrg] = await admin<{ id: string }[]>`
      select id from organisations where slug = ${betaSlug}
    `;
    if (!alphaOrg || !betaOrg) throw new Error('imported organisations missing');
    const alphaUser = `import-test-user-a-${runId}`;
    await admin`
      insert into organisation_memberships (organisation_id, user_id, role, status)
      values (${alphaOrg.id}, ${alphaUser}, 'owner', 'active')
    `;
    await withTenant(
      app,
      { organisationId: alphaOrg.id, userId: alphaUser },
      async (tx) => {
        const works = await tx<{ organisation_id: string }[]>`
        select organisation_id from works
      `;
        expect(works.length).toBe(2);
        for (const work of works) expect(work.organisation_id).toBe(alphaOrg.id);
        const foreign = await tx<{ count: string }[]>`
        select count(*)::text as count from import_records
        where organisation_id = ${betaOrg.id}
      `;
        expect(foreign[0]?.count).toBe('0');
        const own = await tx<{ count: string }[]>`
        select count(*)::text as count from import_records
      `;
        expect(Number(own[0]?.count)).toBeGreaterThan(0);
      },
    );
    // Provenance is append-only for the application role (own transaction:
    // the 42501 rightly poisons it).
    await expect(
      withTenant(
        app,
        { organisationId: alphaOrg.id, userId: alphaUser },
        (tx) => tx`update import_records set payload_fingerprint = ${'c'.repeat(64)}`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('parses challan numbers with padding, double prefixes and rejects non-numeric tails', () => {
    expect(parseChallanNumber('PL-221-BSL-DC-1')).toMatchObject({
      prefix: 'PL-221-BSL-DC',
      sequence: 1,
    });
    expect(parseChallanNumber('Pl-244-SUR-DC-03')).toMatchObject({
      prefix: 'PL-244-SUR-DC',
      sequence: 3,
    });
    expect(parseChallanNumber('PL-PL-243-SUR-DC-9')).toMatchObject({
      prefix: 'PL-PL-243-SUR-DC',
      sequence: 9,
    });
    expect(parseChallanNumber('PEBPL/23-24/PL-232/01')).toMatchObject({
      prefix: 'PEBPL/23-24/PL-232',
      sequence: 1,
    });
    expect(parseChallanNumber('PL-236-BB-DC-15A')).toBeNull();
    expect(parseChallanNumber('PL-242-BB-DC-36-T')).toBeNull();
  });

  it('quantizes REAL floats deterministically, half away from zero', () => {
    expect(quantize(50735921.28543999, 2).text).toBe('50735921.29');
    expect(quantize(5.5555, 3).text).toBe('5.556');
    expect(quantize(-2.005, 2).text).toBe('-2.01');
    expect(quantize(10, 3)).toMatchObject({ text: '10.000', changed: false });
    expect(quantize(0.1 + 0.2, 2).text).toBe('0.30');
  });
});
