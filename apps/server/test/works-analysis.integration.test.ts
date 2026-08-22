import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import type {
  DivisionAnalysisResponse,
  ItemGroupProposalsResponse,
  MappedItemAnalysisResponse,
  WorkAnalysisResponse,
} from '@auto-mb/contracts';
import { buildApp } from '../src/app.js';
import { readXlsxRows } from '../src/xlsx.js';

/**
 * The three works-analysis reports, on a fixture whose every expected
 * figure is written out below by hand.
 *
 * The point of writing them by hand is that the reports are ARITHMETIC. A
 * test that recomputed the expectation with the same expression the route
 * uses would pass on a sign error, a missing clamp, or a baseline folded in
 * twice, and those are exactly the three defects this module can have. So
 * the fixture is small enough to add up on paper, and the paper is here:
 *
 * WORK-1 (division 100), rates and quantities chosen so no two products
 * collide:
 *
 *   A/1 "42U Rack", nos, sanctioned 10 @ 1000, SUPPLY_AND_INSTALLATION
 *       (70% supply / 30% installation)
 *       delivered 4, installed 3
 *       pending supply 6 (= 6000.00), pending install 7 (= 7000.00)
 *       supplied-not-installed 1 (= 1000.00)
 *       RITES clause for 10, one closed call for 4
 *         -> called 4, passed 4, pending to inspect 6 (= 6000.00)
 *       executed = round(4 x 1000 x 70%) + round(3 x 1000 x 30%)
 *                = 2800.00 + 900.00 = 3700.00, billed 0 -> unbilled 3700.00
 *   A/2 "42U Rack,", nos, sanctioned 5 @ 1200, SUPPLY (100% supply)
 *       delivered 5, installed 0
 *       pending supply 0, pending install 5 (= 6000.00)
 *       RDSO clause for 5, no call -> pending to inspect 5 (= 6000.00)
 *       executed = round(5 x 1200 x 100%) = 6000.00 -> unbilled 6000.00
 *   A/3 "Cable", m, sanctioned 100 @ 50, NO payment category
 *       nothing delivered or installed
 *       pending supply 100 (= 5000.00), pending install 100 (= 5000.00)
 *       executed = null, because no matrix row resolves — the case a zero
 *       would misreport as "nothing owed"
 *
 * WORK-2 (division 100): B/1 "42U RACK", nos, 8 @ 1100, nothing delivered
 *   -> pending supply 8 (= 8800.00); B/2 "Cable, 4 core", m, 3 @ 700
 * WORK-3 (division 140): C/1 "Cable", m, 50 @ 55 -> pending 50 (= 2750.00);
 *   C/2 "Cable 4 core", m, 2 @ 700
 * WORK-4 (no consignee, so no division) with a LOCKED opening baseline:
 *   D/1, nos, 10 @ 100, prior_supplied 4, prior amount 400.00
 *   -> delivered 4 with nothing on any challan, billed 400.00
 *
 * The canonical item "42U Rack" carries the alias "42U Rack,", so A/1, A/2
 * and B/1 combine into ONE row of three lines across two Works, with the
 * rate reported as the spread 1000–1200 and never averaged.
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
const ownerEmail = `wa-owner-${runId}@integration.test`;
const scopedEmail = `wa-scoped-${runId}@integration.test`;
const outsiderEmail = `wa-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let otherOrganisationId: string;
let ownerUserId: string;
let scopedUserId: string;

interface Ids {
  work1: string;
  work2: string;
  work3: string;
  work4: string;
  a1: string;
  a2: string;
  a3: string;
  b1: string;
  c1: string;
  d1: string;
}
const ids: Ids = {
  work1: randomUUID(),
  work2: randomUUID(),
  work3: randomUUID(),
  work4: randomUUID(),
  a1: randomUUID(),
  a2: randomUUID(),
  a3: randomUUID(),
  b1: randomUUID(),
  c1: randomUUID(),
  d1: randomUUID(),
};

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let scoped: CookieJar;
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

async function userIdOf(email: string): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${email}
  `;
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

async function insertWork(
  id: string,
  code: string,
  title: string,
  status = 'active',
): Promise<string> {
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id,
      status
    )
    values (
      ${id}, ${organisationId}, ${code}, ${`${code}-letter-${runId}`},
      '2025-04-01', ${title}, 500000.00, 450000.00, 'per_schedule',
      ${ownerUserId}, ${status}
    )
  `;
  const scheduleId = randomUUID();
  await admin`
    insert into work_schedules (
      id, organisation_id, work_id, schedule_code, title, position
    )
    values (${scheduleId}, ${organisationId}, ${id}, 'A', 'Schedule A', 1)
  `;
  return scheduleId;
}

async function insertItem(
  id: string,
  workId: string,
  scheduleId: string,
  itemNumber: string,
  description: string,
  unit: string,
  quantity: string,
  rate: string,
  category: string | null,
): Promise<void> {
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category
    )
    values (
      ${id}, ${organisationId}, ${workId}, ${scheduleId}, ${itemNumber},
      ${description}, ${unit}, ${quantity}, ${rate}, ${category}
    )
  `;
}

/** A contact that may be a Work consignee (R16 requires the role). */
async function insertConsignee(
  designation: string,
  divisionCode: string | null,
): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into contacts (
      id, organisation_id, designation, address, is_consignee, division_code,
      created_by_user_id
    )
    values (
      ${id}, ${organisationId}, ${designation}, ${`${designation} depot`}, true,
      ${divisionCode}, ${ownerUserId}
    )
  `;
  return id;
}

/** An ISSUED work challan. Lines land while the parent is still a DRAFT —
 * migration 0056's line-mutation guard refuses them otherwise — and the
 * challan is stamped issued afterwards, which is the order the issue
 * transaction itself uses. */
async function insertIssuedChallan(
  workId: string,
  number: string,
  sequence: number,
  lines: readonly {
    workItemId: string;
    quantity: string;
    rate: string;
    amount: string;
  }[],
): Promise<void> {
  const challanId = randomUUID();
  await admin`
    insert into delivery_challans (
      id, organisation_id, work_id, status, challan_date, prefix,
      created_by_user_id
    )
    values (
      ${challanId}, ${organisationId}, ${workId}, 'draft', '2025-05-10',
      'WA', ${ownerUserId}
    )
  `;
  let position = 1;
  for (const line of lines) {
    await admin`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        position, quantity, description_snapshot, unit_snapshot,
        rate_snapshot, line_amount
      )
      values (
        ${organisationId}, ${challanId}, ${workId}, ${line.workItemId},
        ${position}, ${line.quantity}, 'Snapshot line', 'nos',
        ${line.rate}, ${line.amount}
      )
    `;
    position += 1;
  }
  await admin`
    update delivery_challans set
      status = 'issued', challan_number = ${number},
      sequence_number = ${sequence}, issued_snapshot = '{}'::jsonb,
      issued_at = now(), issued_by_user_id = ${ownerUserId}
    where id = ${challanId}
  `;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-works-analysis-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the works-analysis tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-wa-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'WA Owner');
  scoped = await signUp(scopedEmail, 'WA Scoped');
  outsider = await signUp(outsiderEmail, 'WA Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'WA Railworks', slug: `wa-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const otherCreated = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'WA Rivals', slug: `wa-other-${runId}` },
  });
  expect(otherCreated.statusCode, otherCreated.body).toBe(201);
  otherOrganisationId = otherCreated.json<{ id: string }>().id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: scopedEmail, role: 'office' },
  });
  expect(added.statusCode, added.body).toBe(201);

  ownerUserId = await userIdOf(ownerEmail);
  scopedUserId = await userIdOf(scopedEmail);

  // The scoped member sees only what they are assigned. Set directly:
  // the report's scope predicate is the subject here, not the membership
  // editor that writes it.
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${scopedUserId}
  `;

  const schedule1 = await insertWork(ids.work1, 'WA-ONE', 'Signalling at Alpha');
  const schedule2 = await insertWork(ids.work2, 'WA-TWO', 'Signalling at Beta');
  const schedule3 = await insertWork(ids.work3, 'WA-THREE', 'Cabling at Gamma');
  const schedule4 = await insertWork(ids.work4, 'WA-FOUR', 'Imported legacy work');
  // A cancelled Work with a large pending position: it must appear in the
  // per-Work report if asked for by name, and in NEITHER portfolio report.
  const scheduleX = await insertWork(
    randomUUID(),
    'WA-DEAD',
    'Cancelled work',
    'cancelled',
  );

  await insertItem(
    ids.a1,
    ids.work1,
    schedule1,
    'A/1',
    '42U Rack',
    'nos',
    '10.000',
    '1000.00',
    'SUPPLY_AND_INSTALLATION',
  );
  await insertItem(
    ids.a2,
    ids.work1,
    schedule1,
    'A/2',
    '42U Rack,',
    'nos',
    '5.000',
    '1200.00',
    'SUPPLY',
  );
  await insertItem(
    ids.a3,
    ids.work1,
    schedule1,
    'A/3',
    'Cable',
    'm',
    '100.000',
    '50.00',
    null,
  );
  await insertItem(
    ids.b1,
    ids.work2,
    schedule2,
    'B/1',
    '42U RACK',
    'nos',
    '8.000',
    '1100.00',
    'SUPPLY',
  );
  await insertItem(
    randomUUID(),
    ids.work2,
    schedule2,
    'B/2',
    'Cable, 4 core',
    'm',
    '3.000',
    '700.00',
    'SUPPLY',
  );
  await insertItem(
    ids.c1,
    ids.work3,
    schedule3,
    'C/1',
    'Cable',
    'm',
    '50.000',
    '55.00',
    'SUPPLY',
  );
  await insertItem(
    randomUUID(),
    ids.work3,
    schedule3,
    'C/2',
    'Cable 4 core',
    'm',
    '2.000',
    '700.00',
    'SUPPLY',
  );
  await insertItem(
    ids.d1,
    ids.work4,
    schedule4,
    'D/1',
    'Relay unit',
    'nos',
    '10.000',
    '100.00',
    'SUPPLY',
  );
  await insertItem(
    randomUUID(),
    // The cancelled Work carries the same product as WORK-2, so a report
    // that forgot to filter by status would show a bigger pending figure
    // rather than an extra row somebody might not notice.
    (
      await admin<{ id: string }[]>`
        select id from works where organisation_id = ${organisationId}
          and work_code = 'WA-DEAD'
      `
    )[0]?.id ?? '',
    scheduleX,
    'X/1',
    '42U Rack',
    'nos',
    '99.000',
    '1000.00',
    'SUPPLY',
  );

  for (const [workId, category, supply, installation] of [
    [ids.work1, 'SUPPLY_AND_INSTALLATION', '70.00', '30.00'],
    [ids.work1, 'SUPPLY', '100.00', '0.00'],
    [ids.work2, 'SUPPLY', '100.00', '0.00'],
    [ids.work3, 'SUPPLY', '100.00', '0.00'],
    [ids.work4, 'SUPPLY', '100.00', '0.00'],
  ] as const) {
    await admin`
      insert into payment_matrices (
        organisation_id, work_id, category, pct_supply, pct_installation,
        pct_pac, pct_final_bill, created_by_user_id
      )
      values (
        ${organisationId}, ${workId}, ${category}, ${supply}, ${installation},
        0.00, 0.00, ${ownerUserId}
      )
    `;
  }

  const division100 = await insertConsignee('Sr DSTE Alpha', '100');
  const division100b = await insertConsignee('Sr DSTE Alpha Annexe', '100');
  const division140 = await insertConsignee('Sr DSTE Gamma', '140');
  for (const [workId, contactId] of [
    [ids.work1, division100],
    [ids.work2, division100b],
    [ids.work3, division140],
  ] as const) {
    await admin`
      insert into work_consignees (
        organisation_id, work_id, contact_id, created_by_user_id
      )
      values (${organisationId}, ${workId}, ${contactId}, ${ownerUserId})
    `;
  }

  await insertIssuedChallan(ids.work1, 'WA/ONE/001', 1, [
    { workItemId: ids.a1, quantity: '4.000', rate: '1000.00', amount: '4000.00' },
    { workItemId: ids.a2, quantity: '5.000', rate: '1200.00', amount: '6000.00' },
  ]);

  const locationId = randomUUID();
  await admin`
    insert into location_masters (
      id, organisation_id, name, kind, created_by_user_id
    )
    values (
      ${locationId}, ${organisationId}, 'Alpha yard', 'installation_point',
      ${ownerUserId}
    )
  `;
  await admin`
    insert into installations (
      organisation_id, work_id, work_item_id, quantity, installed_on,
      location_id, location_name, recorded_by_user_id
    )
    values (
      ${organisationId}, ${ids.work1}, ${ids.a1}, 3.000, '2025-05-20',
      ${locationId}, 'Alpha yard', ${ownerUserId}
    )
  `;

  await admin`
    insert into inspection_clauses (
      organisation_id, work_id, work_item_id, agency, inspection_quantity,
      created_by_user_id
    )
    values
      (${organisationId}, ${ids.work1}, ${ids.a1}, 'RITES', 10.000, ${ownerUserId}),
      (${organisationId}, ${ids.work1}, ${ids.a2}, 'RDSO', 5.000, ${ownerUserId})
  `;
  // A call is CREATED as requested and closed by a later update — the
  // lifecycle migration 0082 enforces, so the fixture walks it rather than
  // writing a closed row the product could never produce.
  const callId = randomUUID();
  await admin`
    insert into inspection_calls (
      id, organisation_id, work_id, sequence_number, agency,
      status, requested_on, created_by_user_id
    )
    values (
      ${callId}, ${organisationId}, ${ids.work1}, 1,
      'RITES', 'requested', '2025-05-12', ${ownerUserId}
    )
  `;
  await admin`
    insert into inspection_call_items (
      organisation_id, inspection_call_id, work_id, work_item_id, quantity
    )
    values (${organisationId}, ${callId}, ${ids.work1}, ${ids.a1}, 4.000)
  `;
  await admin`
    update inspection_calls set
      status = 'scheduled', agency_call_number = 'RITES-CALL-1',
      call_letter_received_on = '2025-05-13'
    where id = ${callId}
  `;
  // A call closes only with its certificate on file (0082's guard).
  await admin`
    insert into inspection_call_documents (
      organisation_id, inspection_call_id, kind, label, mandatory, position,
      object_key, original_filename, sha256, size_bytes,
      uploaded_by_user_id, uploaded_at
    )
    values (
      ${organisationId}, ${callId}, 'certificate', 'RITES certificate', true, 1,
      ${`${organisationId}/ic/${callId}.pdf`}, 'certificate.pdf',
      ${'b'.repeat(64)}, 2048, ${ownerUserId}, now()
    )
  `;
  await admin`
    update inspection_calls set
      status = 'closed', certificate_number = 'RITES-CERT-1',
      certificate_date = '2025-05-18', closed_at = now(),
      closed_by_user_id = ${ownerUserId}
    where id = ${callId}
  `;

  // WORK-4's locked opening baseline: four supplied and 400.00 billed
  // before this product ever saw the Work.
  const baselineId = randomUUID();
  await admin`
    insert into work_billing_baselines (
      id, organisation_id, work_id, bill_object_key, bill_filename,
      bill_sha256, bill_media_type, bill_size_bytes, bill_source,
      bill_number, bill_date, bill_amount, last_mb_sequence_number,
      created_by_user_id
    )
    values (
      ${baselineId}, ${organisationId}, ${ids.work4},
      ${`${organisationId}/baseline/${baselineId}.pdf`}, 'opening-bill.pdf',
      ${'a'.repeat(64)}, 'application/pdf', 1024, 'recorded',
      'LEGACY/1', '2025-01-31', 400.00, 7,
      ${ownerUserId}
    )
  `;
  await admin`
    insert into work_billing_baseline_lines (
      organisation_id, work_billing_baseline_id, work_id, work_item_id,
      prior_supplied, prior_installed, prior_pac, prior_final_bill, amount,
      confirmed_by_user_id, confirmed_at
    )
    values (
      ${organisationId}, ${baselineId}, ${ids.work4}, ${ids.d1},
      4.000, 0.000, 0.000, 0.000, 400.00, ${ownerUserId}, now()
    )
  `;
  // Locked LAST: the lines of a locked baseline are frozen, so the lock is
  // the final act on it — which is also what the lock MEANS.
  await admin`
    update work_billing_baselines
    set locked_at = now(), locked_by_user_id = ${ownerUserId}
    where id = ${baselineId}
  `;

  await admin`
    insert into canonical_items (
      organisation_id, name, group_name, default_unit, aliases,
      created_by_user_id
    )
    values (
      ${organisationId}, '42U Rack', 'Racks', 'nos',
      ${['42U Rack,']}, ${ownerUserId}
    )
  `;

  // The scoped member is assigned WORK-1 only.
  await admin`
    insert into work_assignments (
      organisation_id, work_id, user_id, created_by_user_id
    )
    values (${organisationId}, ${ids.work1}, ${scopedUserId}, ${ownerUserId})
  `;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  if (storageDir !== undefined) await rm(storageDir, { recursive: true, force: true });
});

async function workAnalysis(workId: string): Promise<WorkAnalysisResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/reports/work-analysis/${workId}`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<WorkAnalysisResponse>();
}

describe('the per-Work analysis', () => {
  it('reports the quantity position of every item, item by item', async () => {
    const analysis = await workAnalysis(ids.work1);
    const [a1, a2, a3] = analysis.items;

    expect(analysis.items).toHaveLength(3);
    expect(a1?.itemNumber).toBe('A/1');
    expect(a1?.sanctionedQuantity).toBe('10.000');
    expect(a1?.deliveredQuantity).toBe('4.000');
    expect(a1?.installedQuantity).toBe('3.000');
    expect(a1?.pendingSupplyQuantity).toBe('6.000');
    expect(a1?.pendingInstallQuantity).toBe('7.000');
    expect(a1?.suppliedNotInstalledQuantity).toBe('1.000');
    expect(a1?.installedAboveSanctionedQuantity).toBe('0.000');

    expect(a2?.pendingSupplyQuantity).toBe('0.000');
    expect(a2?.pendingInstallQuantity).toBe('5.000');
    // Delivered but not installed: the whole reason the column exists.
    expect(a2?.suppliedNotInstalledQuantity).toBe('5.000');

    expect(a3?.deliveredQuantity).toBe('0.000');
    expect(a3?.pendingSupplyQuantity).toBe('100.000');
  });

  it('values every row at its own rate and totals the sections', async () => {
    const analysis = await workAnalysis(ids.work1);
    const [a1, a2, a3] = analysis.items;

    expect(a1?.sanctionedValue).toBe('10000.00');
    expect(a1?.deliveredValue).toBe('4000.00');
    expect(a1?.installedValue).toBe('3000.00');
    expect(a1?.pendingSupplyValue).toBe('6000.00');
    expect(a1?.pendingInstallValue).toBe('7000.00');
    expect(a2?.pendingInstallValue).toBe('6000.00');
    expect(a3?.pendingSupplyValue).toBe('5000.00');

    // 6000 + 0 + 5000, summed by PostgreSQL over the same statement.
    expect(analysis.totals.pendingSupplyValue).toBe('11000.00');
    // 7000 + 6000 + 5000
    expect(analysis.totals.pendingInstallValue).toBe('18000.00');
    expect(analysis.totals.sanctionedValue).toBe('21000.00');
    expect(analysis.totals.itemCount).toBe(3);
  });

  it('bills the payment-matrix entitlement, and says so when there is no matrix row', async () => {
    const analysis = await workAnalysis(ids.work1);
    const [a1, a2, a3] = analysis.items;

    // round(4 x 1000 x 70%) + round(3 x 1000 x 30%) = 2800 + 900
    expect(a1?.executedValue).toBe('3700.00');
    expect(a1?.billedValue).toBe('0.00');
    expect(a1?.unbilledExecutedValue).toBe('3700.00');
    expect(a2?.executedValue).toBe('6000.00');

    // A/3 carries no payment category, so no matrix row resolves. Null,
    // never zero: "nothing owed" and "the matrix is incomplete" are
    // different answers, and only one of them is true here.
    expect(a3?.executedValue).toBeNull();
    expect(a3?.unbilledExecutedValue).toBeNull();
    expect(analysis.totals.itemsWithoutMatrixRow).toBe(1);
  });

  it('reports the inspection position per item and per agency', async () => {
    const analysis = await workAnalysis(ids.work1);
    const [a1, a2, a3] = analysis.items;

    expect(a1?.inspectionAgency).toBe('RITES');
    expect(a1?.inspectionQuantity).toBe('10.000');
    expect(a1?.inspectionCalledQuantity).toBe('4.000');
    expect(a1?.inspectionPassedQuantity).toBe('4.000');
    expect(a1?.pendingInspectionQuantity).toBe('6.000');
    expect(a1?.pendingInspectionValue).toBe('6000.00');

    expect(a2?.inspectionAgency).toBe('RDSO');
    expect(a2?.inspectionCalledQuantity).toBe('0.000');
    expect(a2?.pendingInspectionQuantity).toBe('5.000');

    // No clause at all is null, not a zero clause quantity.
    expect(a3?.inspectionAgency).toBeNull();
    expect(a3?.inspectionQuantity).toBeNull();
    expect(a3?.pendingInspectionQuantity).toBeNull();

    const rites = analysis.inspection.find((group) => group.agency === 'RITES');
    const rdso = analysis.inspection.find((group) => group.agency === 'RDSO');
    const none = analysis.inspection.find((group) => group.agency === null);
    expect(rites?.pendingQuantity).toBe('6.000');
    expect(rites?.pendingValue).toBe('6000.00');
    expect(rdso?.pendingQuantity).toBe('5.000');
    expect(none?.itemCount).toBe(1);
    expect(analysis.totals.pendingInspectionValue).toBe('12000.00');
  });

  it('derives the division from the Work’s own consignees', async () => {
    const analysis = await workAnalysis(ids.work1);
    expect(analysis.divisionCode).toBe('100');
    expect(analysis.divisionSource).toBe('consignee');
  });

  it('reports no division on record when the Work has no consignee', async () => {
    const analysis = await workAnalysis(ids.work4);
    expect(analysis.divisionCode).toBeNull();
    expect(analysis.divisionSource).toBe('none');
    expect(analysis.divisionCandidates).toEqual([]);
  });

  it('includes a LOCKED opening baseline in the supplied and billed positions', async () => {
    const analysis = await workAnalysis(ids.work4);
    const [d1] = analysis.items;

    expect(analysis.baselineLocked).toBe(true);
    // Nothing was ever delivered on a challan; all four came from the
    // baseline, and the row says which.
    expect(d1?.deliveredQuantity).toBe('4.000');
    expect(d1?.baselineSuppliedQuantity).toBe('4.000');
    expect(d1?.pendingSupplyQuantity).toBe('6.000');
    expect(d1?.billedValue).toBe('400.00');
    // Executed = round(4 x 100 x 100%) = 400.00, and 400 of it is already
    // billed by the baseline, so nothing is unbilled. A baseline folded in
    // twice, or not at all, both fail here.
    expect(d1?.executedValue).toBe('400.00');
    expect(d1?.unbilledExecutedValue).toBe('0.00');
  });

  it('reports the ambiguous case rather than choosing a division', async () => {
    const extra = await insertConsignee(`Sr DSTE Delta ${runId}`, '250');
    await admin`
      insert into work_consignees (
        organisation_id, work_id, contact_id, created_by_user_id
      )
      values (${organisationId}, ${ids.work3}, ${extra}, ${ownerUserId})
    `;
    try {
      const analysis = await workAnalysis(ids.work3);
      expect(analysis.divisionCode).toBeNull();
      expect(analysis.divisionSource).toBe('ambiguous');
      expect([...analysis.divisionCandidates].sort()).toEqual(['140', '250']);
    } finally {
      await admin`
        delete from work_consignees
        where work_id = ${ids.work3} and contact_id = ${extra}
      `;
    }
  });

  it('answers 404 for a Work the caller may not see, without confirming it exists', async () => {
    const refused = await authed(scoped, {
      method: 'GET',
      url: `/api/reports/work-analysis/${ids.work2}`,
      organisationId,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json<{ code: string }>().code).toBe('WORK_NOT_FOUND');

    // The Work it IS assigned is served.
    const allowed = await authed(scoped, {
      method: 'GET',
      url: `/api/reports/work-analysis/${ids.work1}`,
      organisationId,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('refuses another organisation’s Work', async () => {
    const refused = await authed(outsider, {
      method: 'GET',
      url: `/api/reports/work-analysis/${ids.work1}`,
      organisationId: otherOrganisationId,
    });
    expect(refused.statusCode).toBe(404);
  });
});

async function divisionAnalysis(jar: CookieJar): Promise<DivisionAnalysisResponse> {
  const response = await authed(jar, {
    method: 'GET',
    url: '/api/reports/division-analysis',
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DivisionAnalysisResponse>();
}

describe('the division analysis', () => {
  it('combines the pending position of a division’s Works into one row per item and unit', async () => {
    const analysis = await divisionAnalysis(owner);
    const hundred = analysis.divisions.find(
      (division) => division.divisionCode === '100',
    );
    expect(hundred?.works.map((work) => work.workCode).sort()).toEqual([
      'WA-ONE',
      'WA-TWO',
    ]);

    const racks = hundred?.rows.find((row) => row.label === '42U Rack');
    expect(racks).toBeDefined();
    // A/1 and A/2 on WORK-1, B/1 on WORK-2: three lines, two Works.
    expect(racks?.lineCount).toBe(3);
    expect(racks?.workCount).toBe(2);
    expect(racks?.unitCode).toBe('nos');
    // 6 (A/1) + 0 (A/2) + 8 (B/1)
    expect(racks?.pendingSupplyQuantity).toBe('14.000');
    // 6 x 1000 + 0 x 1200 + 8 x 1100 — each line at its OWN rate.
    expect(racks?.pendingSupplyValue).toBe('14800.00');
  });

  it('reports the rate as a spread rather than averaging it', async () => {
    const analysis = await divisionAnalysis(owner);
    const racks = analysis.divisions
      .find((division) => division.divisionCode === '100')
      ?.rows.find((row) => row.label === '42U Rack');
    expect(racks?.rateLow).toBe('1000.000000');
    expect(racks?.rateHigh).toBe('1200.000000');
  });

  it('keeps a different unit in its own row', async () => {
    const analysis = await divisionAnalysis(owner);
    const hundred = analysis.divisions.find(
      (division) => division.divisionCode === '100',
    );
    const units = hundred?.rows.map((row) => row.unitCode) ?? [];
    expect(new Set(units).size).toBeGreaterThan(1);
    // 'Cable' on WORK-1 is unmapped and metred; it never joins the rack row.
    const cable = hundred?.rows.find((row) => row.label === 'Cable');
    expect(cable?.unitCode).toBe('m');
    expect(cable?.canonicalItemId).toBeNull();
    expect(cable?.pendingSupplyValue).toBe('5000.00');
  });

  it('groups every division and totals the whole report', async () => {
    const analysis = await divisionAnalysis(owner);
    const codes = analysis.divisions.map((division) => division.divisionCode);
    expect(codes).toContain('100');
    expect(codes).toContain('140');
    // WORK-4 carries no consignee, so it groups under no division rather
    // than disappearing from a report about what is still to order.
    expect(codes).toContain(null);
    const none = analysis.divisions.find((division) => division.divisionCode === null);
    expect(none?.works.map((work) => work.workCode)).toContain('WA-FOUR');
    expect(none?.divisionSource).toBe('none');
  });

  it('leaves a cancelled Work out entirely', async () => {
    const analysis = await divisionAnalysis(owner);
    const works = analysis.divisions.flatMap((division) =>
      division.works.map((work) => work.workCode),
    );
    expect(works).not.toContain('WA-DEAD');
    // And its 99 racks are not in anybody's total: 14 is the whole
    // portfolio's rack position.
    const racks = analysis.divisions.flatMap((division) =>
      division.rows.filter((row) => row.label === '42U Rack'),
    );
    expect(racks.map((row) => row.pendingSupplyQuantity)).toEqual(['14.000']);
  });

  it('narrows to an assigned member’s own Works rather than refusing', async () => {
    const analysis = await divisionAnalysis(scoped);
    const works = analysis.divisions.flatMap((division) =>
      division.works.map((work) => work.workCode),
    );
    expect(works).toEqual(['WA-ONE']);
    const racks = analysis.divisions
      .find((division) => division.divisionCode === '100')
      ?.rows.find((row) => row.label === '42U Rack');
    // WORK-1's two lines only: 6 + 0.
    expect(racks?.lineCount).toBe(2);
    expect(racks?.pendingSupplyQuantity).toBe('6.000');
  });

  it('shows another organisation nothing', async () => {
    const response = await authed(outsider, {
      method: 'GET',
      url: '/api/reports/division-analysis',
      organisationId: otherOrganisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<DivisionAnalysisResponse>().divisions).toEqual([]);
  });
});

describe('the cross-Work item analysis', () => {
  it('combines one item master across every active Work', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/reports/mapped-item-analysis',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const analysis = response.json<MappedItemAnalysisResponse>();

    const racks = analysis.rows.find((row) => row.canonicalItemId !== null);
    expect(racks?.label).toBe('42U Rack');
    expect(racks?.groupName).toBe('Racks');
    expect(racks?.workCount).toBe(2);
    expect(racks?.lineCount).toBe(3);
    expect(racks?.pendingSupplyQuantity).toBe('14.000');
    expect(racks?.pendingSupplyValue).toBe('14800.00');

    // 'Cable' is unmapped, and combines across Works only as itself: two
    // lines, two Works, 100 + 50 metres at 50 and 55.
    const cable = analysis.rows.find(
      (row) => row.canonicalItemId === null && row.label === 'Cable',
    );
    expect(cable?.lineCount).toBe(2);
    expect(cable?.pendingSupplyQuantity).toBe('150.000');
    expect(cable?.pendingSupplyValue).toBe('7750.00');
    expect(analysis.unmappedLineCount).toBeGreaterThan(0);
  });
});

describe('the grouping proposals', () => {
  it('proposes descriptions that differ only in punctuation, and writes nothing', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/reports/item-group-proposals',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { proposals } = response.json<ItemGroupProposalsResponse>();

    const cable = proposals.find((proposal) => proposal.key === 'cable 4 core');
    expect(cable).toBeDefined();
    expect(cable?.lineCount).toBe(2);
    expect(cable?.workCount).toBe(2);
    expect([cable?.proposedName, ...(cable?.aliases ?? [])].sort()).toEqual([
      'Cable 4 core',
      'Cable, 4 core',
    ]);

    // A read: no canonical item appeared as a side effect of asking.
    const [{ count } = { count: '0' }] = await admin<{ count: string }[]>`
      select count(*)::text as count from canonical_items
      where organisation_id = ${organisationId}
    `;
    expect(count).toBe('1');
  });

  it('does not propose a single unmapped description', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/reports/item-group-proposals',
      organisationId,
    });
    const { proposals } = response.json<ItemGroupProposalsResponse>();
    // 'Cable' has two lines but ONE wording, so it needs no grouping
    // decision — it needs a master item, which is a different control.
    expect(proposals.map((proposal) => proposal.key)).not.toContain('cable');
  });

  it('combines the group once it is confirmed into the item master, and then stops proposing it', async () => {
    const confirmed = await authed(owner, {
      method: 'POST',
      url: '/api/masters/canonical-items',
      organisationId,
      payload: {
        name: 'Cable 4 core',
        groupName: 'Cables',
        defaultUnit: 'm',
        aliases: ['Cable, 4 core'],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);

    const analysis = await authed(owner, {
      method: 'GET',
      url: '/api/reports/mapped-item-analysis',
      organisationId,
    });
    const rows = analysis.json<MappedItemAnalysisResponse>().rows;
    const cable4 = rows.find((row) => row.label === 'Cable 4 core');
    expect(cable4?.canonicalItemId).not.toBeNull();
    // 3 metres on WORK-2 and 2 on WORK-3, both at 700.
    expect(cable4?.lineCount).toBe(2);
    expect(cable4?.workCount).toBe(2);
    expect(cable4?.pendingSupplyQuantity).toBe('5.000');
    expect(cable4?.pendingSupplyValue).toBe('3500.00');

    const proposals = await authed(owner, {
      method: 'GET',
      url: '/api/reports/item-group-proposals',
      organisationId,
    });
    expect(
      proposals.json<ItemGroupProposalsResponse>().proposals.map((one) => one.key),
    ).not.toContain('cable 4 core');
  });
});

describe('the documents', () => {
  it('answers a workbook carrying the report’s own figures', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/reports/analysis/work/report.xlsx?workId=${ids.work1}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml');
    expect(response.headers['content-disposition']).toContain('work-analysis-WA-ONE');

    const rows = readXlsxRows(response.rawPayload);
    const flat = rows.map((row) => row.cells.join('|'));
    expect(flat.some((line) => line.includes('WA-ONE'))).toBe(true);
    // The figure an operator opens the file for, and the section heading
    // that tells them what it is.
    expect(flat.some((line) => line.startsWith('Quantity position'))).toBe(true);
    expect(flat.some((line) => line.includes('11000.00'))).toBe(true);
    // The exclusions travel WITH the file: a printed page is the only
    // place a reader can learn them.
    expect(flat.some((line) => line.includes('Historical and imported invoices'))).toBe(
      true,
    );
  });

  it('refuses a Work-less request for the per-Work report and a Work for the portfolio ones', async () => {
    const missing = await authed(owner, {
      method: 'GET',
      url: '/api/reports/analysis/work/report.xlsx',
      organisationId,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ code: string }>().code).toBe('WORK_REQUIRED');

    const extra = await authed(owner, {
      method: 'GET',
      url: `/api/reports/analysis/division/report.xlsx?workId=${ids.work1}`,
      organisationId,
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.json<{ code: string }>().code).toBe('WORK_NOT_APPLICABLE');
  });

  it('refuses an unknown report name at the schema, before the tenant transaction', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/reports/analysis/everything/report.xlsx',
      organisationId,
    });
    expect(response.statusCode).toBe(400);
  });

  it('says the scope on a workbook an assigned member exports', async () => {
    const response = await authed(scoped, {
      method: 'GET',
      url: '/api/reports/analysis/division/report.xlsx',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const flat = readXlsxRows(response.rawPayload).map((row) => row.cells.join('|'));
    expect(
      flat.some((line) => line.includes('only the Works you are assigned to')),
    ).toBe(true);

    const full = await authed(owner, {
      method: 'GET',
      url: '/api/reports/analysis/division/report.xlsx',
      organisationId,
    });
    const fullFlat = readXlsxRows(full.rawPayload).map((row) => row.cells.join('|'));
    expect(fullFlat.some((line) => line.includes('every active Work'))).toBe(true);
  });

  it('records the export on the audit trail', async () => {
    await authed(owner, {
      method: 'GET',
      url: '/api/reports/analysis/mapped-item/report.xlsx',
      organisationId,
    });
    const [row] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId}
        and action = 'works_analysis.exported'
    `;
    expect(Number(row?.count ?? '0')).toBeGreaterThan(0);
  });

  it('answers the PDF route with a clean 502 when the renderer is unreachable', async () => {
    // Gotenberg does not run in this suite. The assertion is that the route
    // REACHES the shared renderer and surfaces its own 502 rather than a
    // 500 — the report writes nothing, so retrying is always safe.
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/reports/analysis/work/report.pdf?workId=${ids.work1}`,
      organisationId,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json<{ code: string }>().code).toBe('RENDER_FAILED');
  });
});
