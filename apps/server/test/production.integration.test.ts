import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  BomResponse,
  JobCardDetail,
  JobCardListResponse,
  ProductionItem,
  ProductionItemListResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * OEM production (migration 0084).
 *
 * What is proved here, in the order the module's own risks run:
 *
 *   1. the item master — a part number is unique and case-folded, a
 *      manufactured item cannot exist without a serial series, and
 *      neither the series nor the manufactured flag moves once units or
 *      job cards exist;
 *   2. THE RECURSIVE BILL OF MATERIAL and its cycle refusal, which is
 *      the reason the pack exists: a direct loop, a loop three levels
 *      deep, and a self-edge, each refused at the DATABASE and not by
 *      the route that happened to be called;
 *   3. the job card's four-state machine, its quantity ceiling, and the
 *      completion gate that counts units rather than trusting a flag;
 *   4. SERIAL TRACEABILITY — organisation-wide uniqueness of a finished
 *      serial, per-part uniqueness of a component serial, the per-unit
 *      genealogy the mock cannot express, and the immutability of both
 *      once a unit has left the factory;
 *   5. the despatch boundary — only this card's units, only complete
 *      ones, only once;
 *   6. under concurrency — the serial ceiling, the despatch of one unit
 *      by two operators, and two sessions closing a bill-of-material
 *      cycle from opposite ends at the same moment;
 *   7. the database guards, attacked directly with the owner role;
 *   8. the walls — role, work scope, and RLS for the other organisation.
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
const suffix = runId.toUpperCase().slice(0, 6);
const ownerEmail = `prod-owner-${runId}@integration.test`;
const officeEmail = `prod-office-${runId}@integration.test`;
const siteEmail = `prod-site-${runId}@integration.test`;
const viewerEmail = `prod-viewer-${runId}@integration.test`;
const scopedEmail = `prod-scoped-${runId}@integration.test`;
const outsiderEmail = `prod-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let workId: string;
let outsiderJobCardId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let site: CookieJar;
let viewer: CookieJar;
/** An `assigned`-scope membership with no assignment to `workId`. */
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

/** How many of a pair answered with each status, so a race reads as a
 * count rather than as an argument about which request "won". */
function statuses(responses: readonly { statusCode: number }[]): number[] {
  return responses.map((response) => response.statusCode).sort((a, b) => a - b);
}

let itemCounter = 0;
async function createItem(
  overrides: Record<string, unknown> = {},
  jar: CookieJar = office,
): Promise<ProductionItem> {
  itemCounter += 1;
  const response = await authed(jar, {
    method: 'POST',
    url: '/api/production/items',
    organisationId,
    payload: {
      itemCode: `PRD-${suffix}-${String(itemCounter).padStart(3, '0')}`,
      name: `Production fixture item ${String(itemCounter)}`,
      category: 'Display boards',
      unit: 'Nos',
      manufactured: false,
      ...overrides,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ProductionItem>();
}

let prefixCounter = 0;
async function createProduct(
  overrides: Record<string, unknown> = {},
): Promise<ProductionItem> {
  prefixCounter += 1;
  return createItem({
    manufactured: true,
    serialPrefix: `P${suffix}${String(prefixCounter).padStart(2, '0')}`,
    ...overrides,
  });
}

async function addBomLine(
  parentId: string,
  componentItemId: string,
  quantity = '1.000',
  jar: CookieJar = office,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/production/items/${parentId}/bom`,
    organisationId,
    payload: { componentItemId, quantity },
  });
}

async function createJobCard(
  itemId: string,
  overrides: Record<string, unknown> = {},
  jar: CookieJar = site,
) {
  return authed(jar, {
    method: 'POST',
    url: '/api/production/job-cards',
    organisationId,
    payload: {
      itemId,
      quantity: 2,
      workId,
      sourceReference: `${suffix} · A2/1`,
      dueDate: '2026-12-31',
      ...overrides,
    },
  });
}

async function mintSerial(jobCardId: string, jar: CookieJar = site) {
  return authed(jar, {
    method: 'POST',
    url: `/api/production/job-cards/${jobCardId}/serials`,
    organisationId,
  });
}

/** A Work, seeded as admin SQL the way the other integration fixtures do
 * it: the subject under test is production, not LOA intake. */
async function seedWork(code: string, organisation: string, userId: string) {
  const id = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id,
      pbg_required_amount, pbg_submission_days, pbg_requirement_source
    )
    values (
      ${id}, ${organisation}, ${code}, ${`L-${code}`}, '2026-01-05',
      ${`Production fixture ${code}`}, '10000000.00', '9000000.00',
      'per_schedule', ${userId}, '450000.00', 30, '{"provenance": "fixture"}'::jsonb
    )
  `;
  return id;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-production-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-prod-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Production Owner');
  office = await signUp(officeEmail, 'Production Office');
  site = await signUp(siteEmail, 'Production Site');
  viewer = await signUp(viewerEmail, 'Production Viewer');
  scoped = await signUp(scopedEmail, 'Production Scoped');
  outsider = await signUp(outsiderEmail, 'Production Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Production Constructions', slug: `prod-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Production Outsiders', slug: `prod-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [siteEmail, 'site'],
    [viewerEmail, 'viewer'],
    [scopedEmail, 'office'],
  ] as const) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role },
    });
    expect(added.statusCode, added.body).toBe(201);
  }
  // Cancelling a job card and withdrawing a despatch both carry the
  // `cancel` authority, which is granted per member rather than by role.
  await admin`
    update organisation_memberships set can_cancel_documents = true
    where organisation_id = ${organisationId}
      and user_id in (
        select "id" from auth_users where "email" in (${siteEmail}, ${officeEmail})
      )
  `;
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${scopedEmail})
  `;

  const [ownerRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  const [outsiderRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${outsiderEmail}
  `;
  if (!ownerRow || !outsiderRow) throw new Error('seeded users missing');

  workId = await seedWork(`PROD-${suffix}`, organisationId, ownerRow.id);
  const otherWorkId = await seedWork(
    `OTHR-${suffix}`,
    outsiderOrganisationId,
    outsiderRow.id,
  );

  // A job card belonging to the OTHER organisation, so the RLS
  // assertions have a real row to fail to reach rather than a made-up
  // uuid.
  const outsiderItemId = randomUUID();
  outsiderJobCardId = randomUUID();
  await admin`
    insert into production_items (
      id, organisation_id, item_code, name, category, unit, manufactured,
      serial_prefix, serial_controlled, created_by_user_id
    )
    values (
      ${outsiderItemId}, ${outsiderOrganisationId}, ${`OUT-${suffix}`},
      'Outsider board', 'Display boards', 'Nos', true, ${`OUT${suffix}`}, true,
      ${outsiderRow.id}
    )
  `;
  await admin`
    insert into production_job_cards (
      id, organisation_id, fy_label, sequence_number, item_id, quantity,
      work_id, source_reference, due_date, created_by_user_id
    )
    values (
      ${outsiderJobCardId}, ${outsiderOrganisationId}, '2026-27', 1,
      ${outsiderItemId}, 5, ${otherWorkId}, 'OUT/1', '2026-12-31',
      ${outsiderRow.id}
    )
  `;
}, 180_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
    await assertNoForeignKeyOrphans(admin);
  }
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('the OEM item master', () => {
  it('creates a part, folds its code, and refuses a duplicate either way', async () => {
    const item = await createItem({ itemCode: `DUP-${suffix}`, name: 'Cabinet' });
    // Stored uppercased: a part number is read off a label, and 'dup-1'
    // and 'DUP-1' are the same label.
    expect(item.itemCode).toBe(`DUP-${suffix}`);
    expect(item.manufactured).toBe(false);
    expect(item.serialPrefix).toBeNull();

    const clash = await authed(office, {
      method: 'POST',
      url: '/api/production/items',
      organisationId,
      payload: {
        itemCode: `dup-${suffix.toLowerCase()}`,
        name: 'Cabinet, again',
        category: 'Enclosures',
        unit: 'Nos',
        manufactured: false,
      },
    });
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json<{ code: string }>().code).toBe('PRODUCTION_ITEM_EXISTS');
  });

  it('refuses a manufactured item with no serial series', async () => {
    const response = await authed(office, {
      method: 'POST',
      url: '/api/production/items',
      organisationId,
      payload: {
        itemCode: `NOPFX-${suffix}`,
        name: 'Unnameable board',
        category: 'Display boards',
        unit: 'Nos',
        manufactured: true,
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('PRODUCTION_ITEM_INVALID');
  });

  it('keeps the serial series frozen once the first unit is minted', async () => {
    const product = await createProduct({ name: 'Frozen series board' });
    const card = await createJobCard(product.id, { quantity: 1 });
    expect(card.statusCode, card.body).toBe(201);
    const minted = await mintSerial(card.json<JobCardDetail>().id);
    expect(minted.statusCode, minted.body).toBe(201);

    const renamed = await authed(office, {
      method: 'PUT',
      url: `/api/production/items/${product.id}`,
      organisationId,
      payload: {
        itemCode: product.itemCode,
        name: product.name,
        category: product.category,
        unit: product.unit,
        manufactured: true,
        serialPrefix: `Z${suffix}99`,
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(409);
    expect(renamed.json<{ code: string }>().code).toBe('PRODUCTION_ITEM_INVALID');
  });

  it('refuses to retire an item with an open job card, and allows it once cancelled', async () => {
    const product = await createProduct({ name: 'Retirable board' });
    const created = await createJobCard(product.id, { quantity: 1 });
    expect(created.statusCode, created.body).toBe(201);
    const card = created.json<JobCardDetail>();

    const blocked = await authed(office, {
      method: 'PATCH',
      url: `/api/production/items/${product.id}/active`,
      organisationId,
      payload: { active: false },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    // Its own code, not the generic one: the remedy has to name the way
    // out, and "cancel the open job cards" is a different instruction
    // from "the item changed underneath this edit".
    expect(blocked.json<{ code: string }>().code).toBe('PRODUCTION_ITEM_IN_USE');

    const cancelled = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${card.id}/cancel`,
      organisationId,
      payload: { reason: 'Order withdrawn by the customer' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const retired = await authed(office, {
      method: 'PATCH',
      url: `/api/production/items/${product.id}/active`,
      organisationId,
      payload: { active: false },
    });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json<ProductionItem>().active).toBe(false);

    // A retired item leaves the default list and is still reachable with
    // the flag, which is how it is reactivated.
    const live = await authed(office, {
      method: 'GET',
      url: '/api/production/items',
      organisationId,
    });
    expect(
      live.json<ProductionItemListResponse>().items.some((i) => i.id === product.id),
    ).toBe(false);
    const all = await authed(office, {
      method: 'GET',
      url: '/api/production/items?includeRetired=true',
      organisationId,
    });
    expect(
      all.json<ProductionItemListResponse>().items.some((i) => i.id === product.id),
    ).toBe(true);
  });

  it('stores specifications and drops the blank rows the form leaves behind', async () => {
    const item = await createItem({
      name: 'Specified board',
      specifications: [
        { attribute: '  Display size  ', value: ' 1200 × 600 mm ' },
        { attribute: '   ', value: 'orphan' },
      ],
    });
    expect(item.specifications).toEqual([
      { attribute: 'Display size', value: '1200 × 600 mm' },
    ]);
  });
});

describe('the recursive bill of material', () => {
  it('explodes nested quantities down the tree', async () => {
    const board = await createProduct({ name: 'Nested board' });
    const subAssembly = await createProduct({ name: 'Nested sub-assembly' });
    const screw = await createItem({ name: 'Nested screw' });

    expect((await addBomLine(board.id, subAssembly.id, '2.000')).statusCode).toBe(201);
    const added = await addBomLine(subAssembly.id, screw.id, '4.000');
    expect(added.statusCode, added.body).toBe(201);

    const response = await authed(office, {
      method: 'GET',
      url: `/api/production/items/${board.id}/bom`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const nodes = response.json<BomResponse>().nodes;
    const sub = nodes.find((node) => node.itemId === subAssembly.id);
    const leaf = nodes.find((node) => node.itemId === screw.id);
    expect(sub?.depth).toBe(0);
    expect(sub?.hasChildren).toBe(true);
    expect(leaf?.depth).toBe(1);
    // Two sub-assemblies of four screws each is eight screws per board:
    // the explosion multiplies down, which is the arithmetic the mock's
    // `explodeBom` does and its serial capture does not.
    expect(Number(leaf?.effectiveQuantity)).toBe(8);
    expect(leaf?.hasChildren).toBe(false);
  });

  it('refuses the direct cycle', async () => {
    const first = await createProduct({ name: 'Cycle A' });
    const second = await createProduct({ name: 'Cycle B' });
    expect((await addBomLine(first.id, second.id)).statusCode).toBe(201);

    const loop = await addBomLine(second.id, first.id);
    expect(loop.statusCode, loop.body).toBe(409);
    expect(loop.json<{ code: string }>().code).toBe('PRODUCTION_BOM_CYCLE');
  });

  it('refuses a cycle three levels deep', async () => {
    const top = await createProduct({ name: 'Deep A' });
    const middle = await createProduct({ name: 'Deep B' });
    const bottom = await createProduct({ name: 'Deep C' });
    expect((await addBomLine(top.id, middle.id)).statusCode).toBe(201);
    expect((await addBomLine(middle.id, bottom.id)).statusCode).toBe(201);

    const loop = await addBomLine(bottom.id, top.id);
    expect(loop.statusCode, loop.body).toBe(409);
    expect(loop.json<{ code: string }>().code).toBe('PRODUCTION_BOM_CYCLE');
  });

  it('refuses a self-edge and a bill hung off an item nobody manufactures', async () => {
    const product = await createProduct({ name: 'Self edge board' });
    const bought = await createItem({ name: 'Bought-in part' });

    const self = await addBomLine(product.id, product.id);
    expect(self.statusCode, self.body).toBe(409);

    const orphan = await addBomLine(bought.id, product.id);
    expect(orphan.statusCode, orphan.body).toBe(409);
    expect(orphan.json<{ code: string }>().code).toBe('PRODUCTION_BOM_LINE_INVALID');
  });

  it('refuses a second line for one component, and edits the first instead', async () => {
    const product = await createProduct({ name: 'Duplicate line board' });
    const part = await createItem({ name: 'Duplicate line part' });
    const first = await addBomLine(product.id, part.id, '1.000');
    expect(first.statusCode, first.body).toBe(201);

    const second = await addBomLine(product.id, part.id, '2.000');
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('PRODUCTION_BOM_LINE_EXISTS');

    const lineId = first.json<BomResponse>().nodes[0]?.lineId ?? '';
    const edited = await authed(office, {
      method: 'PUT',
      url: `/api/production/bom-lines/${lineId}`,
      organisationId,
      payload: { quantity: '3.000' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(Number(edited.json<BomResponse>().nodes[0]?.quantity)).toBe(3);

    const removed = await authed(office, {
      method: 'DELETE',
      url: `/api/production/bom-lines/${lineId}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json<BomResponse>().nodes).toHaveLength(0);
  });
});

describe('the job card', () => {
  it('numbers per financial year, derives its counts, and lists its materials', async () => {
    const product = await createProduct({ name: 'Counted board' });
    const part = await createItem({ name: 'Counted part' });
    expect((await addBomLine(product.id, part.id, '3.000')).statusCode).toBe(201);

    const created = await createJobCard(product.id, { quantity: 4 });
    expect(created.statusCode, created.body).toBe(201);
    const card = created.json<JobCardDetail>();
    expect(card.number).toMatch(/^PP-\d{2}-\d{3}$/);
    expect(card.status).toBe('planned');
    expect(card.sourceType).toBe('work');
    expect(card.manufactured).toBe(0);
    expect(card.dispatched).toBe(0);
    expect(card.dispatchReady).toBe(false);
    // Three parts per board, four boards.
    expect(Number(card.materials.find((m) => m.itemId === part.id)?.required)).toBe(12);
  });

  it('refuses a job card that names both a Work and a customer, or neither', async () => {
    const product = await createProduct({ name: 'Ambiguous source board' });
    for (const overrides of [
      { workId, customerName: 'Kerala Electricals' },
      { workId: undefined, customerName: undefined },
    ]) {
      const response = await createJobCard(product.id, overrides);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ code: string }>().code).toBe(
        'PRODUCTION_JOB_CARD_STATE_INVALID',
      );
    }
  });

  it('takes a private purchase order with no Work at all', async () => {
    const product = await createProduct({ name: 'Private order board' });
    const response = await createJobCard(product.id, {
      workId: undefined,
      customerName: 'Kerala Electricals',
      sourceReference: 'PO/KE/2026/177',
    });
    expect(response.statusCode, response.body).toBe(201);
    const card = response.json<JobCardDetail>();
    expect(card.sourceType).toBe('private');
    expect(card.workId).toBeNull();
    expect(card.customer).toBe('Kerala Electricals');
  });

  it('moves to in production on the first unit and refuses more than the plan', async () => {
    const product = await createProduct({ name: 'Ceiling board' });
    const created = await createJobCard(product.id, { quantity: 2 });
    const card = created.json<JobCardDetail>();

    const first = await mintSerial(card.id);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json<JobCardDetail>().status).toBe('in_production');
    expect(first.json<JobCardDetail>().manufactured).toBe(1);

    expect((await mintSerial(card.id)).statusCode).toBe(201);

    const third = await mintSerial(card.id);
    expect(third.statusCode, third.body).toBe(409);
    expect(third.json<{ code: string }>().code).toBe('PRODUCTION_QUANTITY_EXCEEDED');
  });

  it('completes only when every planned unit exists, and never reopens', async () => {
    const product = await createProduct({ name: 'Completion board' });
    const card = (
      await createJobCard(product.id, { quantity: 2 })
    ).json<JobCardDetail>();
    expect((await mintSerial(card.id)).statusCode).toBe(201);

    const early = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${card.id}/complete`,
      organisationId,
    });
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json<{ code: string }>().code).toBe('PRODUCTION_JOB_CARD_INCOMPLETE');

    expect((await mintSerial(card.id)).statusCode).toBe(201);
    const completed = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${card.id}/complete`,
      organisationId,
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json<JobCardDetail>().status).toBe('completed');
    expect(completed.json<JobCardDetail>().completedOn).not.toBeNull();

    // Nothing reopens: the units have serials and may already have left.
    const again = await mintSerial(card.id);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe(
      'PRODUCTION_JOB_CARD_STATE_INVALID',
    );
  });

  it('refuses to reduce the quantity below the units already built', async () => {
    const product = await createProduct({ name: 'Reduction board' });
    const card = (
      await createJobCard(product.id, { quantity: 3 })
    ).json<JobCardDetail>();
    expect((await mintSerial(card.id)).statusCode).toBe(201);
    expect((await mintSerial(card.id)).statusCode).toBe(201);

    const reduced = await authed(site, {
      method: 'PUT',
      url: `/api/production/job-cards/${card.id}`,
      organisationId,
      payload: { quantity: 1, sourceReference: 'revised', dueDate: '2026-12-31' },
    });
    expect(reduced.statusCode, reduced.body).toBe(409);
    expect(reduced.json<{ code: string }>().code).toBe(
      'PRODUCTION_JOB_CARD_INCOMPLETE',
    );

    // Down to exactly what was built is legitimate: it is how a short
    // run is closed honestly rather than by inventing units.
    const trimmed = await authed(site, {
      method: 'PUT',
      url: `/api/production/job-cards/${card.id}`,
      organisationId,
      payload: { quantity: 2, sourceReference: 'revised', dueDate: '2026-12-31' },
    });
    expect(trimmed.statusCode, trimmed.body).toBe(200);
    expect(trimmed.json<JobCardDetail>().quantity).toBe(2);
  });
});

describe('serial traceability', () => {
  it('mints from the item series and keeps the number unique organisation-wide', async () => {
    const product = await createProduct({ name: 'Series board' });
    const card = (
      await createJobCard(product.id, { quantity: 2 })
    ).json<JobCardDetail>();
    const first = (await mintSerial(card.id)).json<JobCardDetail>();
    const second = (await mintSerial(card.id)).json<JobCardDetail>();

    expect(first.serials[0]?.serialNumber).toBe(`${product.serialPrefix ?? ''}-00001`);
    expect(second.serials[1]?.serialNumber).toBe(`${product.serialPrefix ?? ''}-00002`);

    // Organisation-wide, not per Work: a second job card for the same
    // product continues the series rather than restarting it.
    const nextCard = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    const third = (await mintSerial(nextCard.id)).json<JobCardDetail>();
    expect(third.serials[0]?.serialNumber).toBe(`${product.serialPrefix ?? ''}-00003`);
  });

  it('records the genealogy per UNIT, not per batch', async () => {
    const product = await createProduct({ name: 'Genealogy board' });
    const smps = await createItem({ name: 'Genealogy SMPS', serialControlled: true });
    expect((await addBomLine(product.id, smps.id, '1.000')).statusCode).toBe(201);

    const card = (
      await createJobCard(product.id, { quantity: 2 })
    ).json<JobCardDetail>();
    const afterFirst = (await mintSerial(card.id)).json<JobCardDetail>();
    const afterSecond = (await mintSerial(card.id)).json<JobCardDetail>();
    const unitOne = afterSecond.serials[0]?.id ?? '';
    const unitTwo = afterSecond.serials[1]?.id ?? '';
    expect(afterFirst.componentSlots).toHaveLength(1);
    expect(afterFirst.componentSlots[0]?.required).toBe(1);

    const scanned = await authed(site, {
      method: 'POST',
      url: `/api/production/serials/${unitOne}/components`,
      organisationId,
      payload: { componentItemId: smps.id, serialNumber: `SMPS-${suffix}-A` },
    });
    expect(scanned.statusCode, scanned.body).toBe(201);
    const detail = scanned.json<JobCardDetail>();
    // The mock's shape cannot answer this: its componentSerials are a bag
    // of strings per PLAN, so it can say a batch consumed one supply and
    // not which board it is inside.
    expect(detail.serials[0]?.components).toHaveLength(1);
    expect(detail.serials[1]?.components).toHaveLength(0);

    // One physical part is inside exactly one unit.
    const twice = await authed(site, {
      method: 'POST',
      url: `/api/production/serials/${unitTwo}/components`,
      organisationId,
      payload: { componentItemId: smps.id, serialNumber: `SMPS-${suffix}-A` },
    });
    expect(twice.statusCode, twice.body).toBe(409);
    expect(twice.json<{ code: string }>().code).toBe(
      'PRODUCTION_COMPONENT_SERIAL_EXISTS',
    );

    // More of a part than the bill of material calls for is a mis-scan,
    // and the moment to say so is now.
    const surplus = await authed(site, {
      method: 'POST',
      url: `/api/production/serials/${unitOne}/components`,
      organisationId,
      payload: { componentItemId: smps.id, serialNumber: `SMPS-${suffix}-B` },
    });
    expect(surplus.statusCode, surplus.body).toBe(409);
    expect(surplus.json<{ code: string }>().code).toBe(
      'PRODUCTION_COMPONENT_SERIAL_INVALID',
    );
  });

  it('refuses a component the unit is not built from', async () => {
    const product = await createProduct({ name: 'Wrong part board' });
    const stranger = await createItem({
      name: 'Stranger part',
      serialControlled: true,
    });
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    const unitId =
      (await mintSerial(card.id)).json<JobCardDetail>().serials[0]?.id ?? '';

    const response = await authed(site, {
      method: 'POST',
      url: `/api/production/serials/${unitId}/components`,
      organisationId,
      payload: { componentItemId: stranger.id, serialNumber: `STR-${suffix}` },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'PRODUCTION_COMPONENT_SERIAL_INVALID',
    );
  });

  it('lets a mis-scan be removed while the unit is in the factory', async () => {
    const product = await createProduct({ name: 'Mis-scan board' });
    const part = await createItem({ name: 'Mis-scan part', serialControlled: true });
    expect((await addBomLine(product.id, part.id, '1.000')).statusCode).toBe(201);
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    const unitId =
      (await mintSerial(card.id)).json<JobCardDetail>().serials[0]?.id ?? '';

    const scanned = await authed(site, {
      method: 'POST',
      url: `/api/production/serials/${unitId}/components`,
      organisationId,
      payload: { componentItemId: part.id, serialNumber: `MIS-${suffix}` },
    });
    const componentId =
      scanned.json<JobCardDetail>().serials[0]?.components[0]?.id ?? '';

    const removed = await authed(site, {
      method: 'DELETE',
      url: `/api/production/component-serials/${componentId}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json<JobCardDetail>().serials[0]?.components).toHaveLength(0);
  });
});

describe('the despatch boundary', () => {
  /** A one-unit job card whose unit is complete and ready to leave. */
  async function readyUnit(name: string) {
    const product = await createProduct({ name });
    const part = await createItem({ name: `${name} part`, serialControlled: true });
    expect((await addBomLine(product.id, part.id, '1.000')).statusCode).toBe(201);
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    const unitId =
      (await mintSerial(card.id)).json<JobCardDetail>().serials[0]?.id ?? '';
    const scanned = await authed(site, {
      method: 'POST',
      url: `/api/production/serials/${unitId}/components`,
      organisationId,
      payload: { componentItemId: part.id, serialNumber: `${name}-${suffix}` },
    });
    expect(scanned.statusCode, scanned.body).toBe(201);
    return { cardId: card.id, unitId };
  }

  it('releases a complete unit once, numbers the release, and closes the record', async () => {
    const { cardId, unitId } = await readyUnit('Release');
    const released = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${cardId}/dispatches`,
      organisationId,
      payload: { serialIds: [unitId], dispatchedOn: '2026-08-18' },
    });
    expect(released.statusCode, released.body).toBe(201);
    const detail = released.json<JobCardDetail>();
    expect(detail.dispatches).toHaveLength(1);
    expect(detail.dispatches[0]?.number).toBe(`${detail.number}/D1`);
    expect(detail.dispatched).toBe(1);
    expect(detail.serials[0]?.dispatchedOn).toBe('2026-08-18');

    // A unit leaves the factory once.
    const again = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${cardId}/dispatches`,
      organisationId,
      payload: { serialIds: [unitId], dispatchedOn: '2026-08-18' },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('PRODUCTION_DISPATCH_INVALID');

    // …and its component record is closed: the unit is somewhere else
    // and this is the only account of what is inside it.
    const componentId =
      detail.serials[0]?.components[0]?.id ?? 'missing-component-record';
    const removal = await authed(site, {
      method: 'DELETE',
      url: `/api/production/component-serials/${componentId}`,
      organisationId,
    });
    expect(removal.statusCode, removal.body).toBe(409);
    expect(removal.json<{ code: string }>().code).toBe(
      'PRODUCTION_COMPONENT_SERIAL_INVALID',
    );
  });

  it('refuses a unit still missing the components its bill calls for', async () => {
    const product = await createProduct({ name: 'Incomplete unit board' });
    const part = await createItem({ name: 'Incomplete part', serialControlled: true });
    expect((await addBomLine(product.id, part.id, '1.000')).statusCode).toBe(201);
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    const unitId =
      (await mintSerial(card.id)).json<JobCardDetail>().serials[0]?.id ?? '';

    const response = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${card.id}/dispatches`,
      organisationId,
      payload: { serialIds: [unitId], dispatchedOn: '2026-08-18' },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('PRODUCTION_DISPATCH_INVALID');
  });

  it("refuses another job card's unit", async () => {
    const mine = await readyUnit('Mine');
    const theirs = await readyUnit('Theirs');
    const response = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${mine.cardId}/dispatches`,
      organisationId,
      payload: { serialIds: [theirs.unitId], dispatchedOn: '2026-08-18' },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('PRODUCTION_DISPATCH_INVALID');
  });

  it('refuses a despatch dated in the future, against the ORGANISATION today', async () => {
    const { cardId, unitId } = await readyUnit('Future');
    const response = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${cardId}/dispatches`,
      organisationId,
      payload: { serialIds: [unitId], dispatchedOn: '2099-01-01' },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('PRODUCTION_DISPATCH_INVALID');
  });

  it('withdraws a release raised in error and puts its unit back', async () => {
    const { cardId, unitId } = await readyUnit('Withdrawn');
    const released = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${cardId}/dispatches`,
      organisationId,
      payload: { serialIds: [unitId], dispatchedOn: '2026-08-18' },
    });
    const dispatchId = released.json<JobCardDetail>().dispatches[0]?.id ?? '';

    const withdrawn = await authed(site, {
      method: 'DELETE',
      url: `/api/production/dispatches/${dispatchId}`,
      organisationId,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json<JobCardDetail>().dispatched).toBe(0);
    expect(withdrawn.json<JobCardDetail>().serials[0]?.dispatchedOn).toBeNull();
  });

  it('refuses to remove a unit once anything hangs off it', async () => {
    const { unitId } = await readyUnit('Anchored');
    // The component record is enough on its own: the foreign key is what
    // refuses this, not a guard that has to remember to look.
    const response = await authed(site, {
      method: 'DELETE',
      url: `/api/production/serials/${unitId}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('PRODUCTION_SERIAL_LOCKED');
  });
});

describe('under concurrency', () => {
  it('mints the last planned unit once when two operators press together', async () => {
    const product = await createProduct({ name: 'Race ceiling board' });
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();

    const [first, second] = await Promise.all([
      mintSerial(card.id),
      mintSerial(card.id),
    ]);
    expect(statuses([first, second])).toEqual([201, 409]);

    const [count] = await admin<{ n: string }[]>`
      select count(*)::text as n from production_serials where job_card_id = ${card.id}
    `;
    expect(count?.n).toBe('1');
  });

  it('releases one unit once when two despatches name it together', async () => {
    const product = await createProduct({ name: 'Race despatch board' });
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    const unitId =
      (await mintSerial(card.id)).json<JobCardDetail>().serials[0]?.id ?? '';

    const release = async () =>
      authed(site, {
        method: 'POST',
        url: `/api/production/job-cards/${card.id}/dispatches`,
        organisationId,
        payload: { serialIds: [unitId], dispatchedOn: '2026-08-18' },
      });
    const [first, second] = await Promise.all([release(), release()]);
    expect(statuses([first, second])).toEqual([201, 409]);

    const [count] = await admin<{ n: string }[]>`
      select count(*)::text as n from production_dispatch_serials
      where production_serial_id = ${unitId}
    `;
    expect(count?.n).toBe('1');
  });

  it('refuses a bill-of-material cycle closed from both ends at once', async () => {
    const first = await createProduct({ name: 'Race cycle A' });
    const second = await createProduct({ name: 'Race cycle B' });

    // The one failure a row lock cannot fix: neither session can see the
    // other's uncommitted edge, so both searches find no cycle. The
    // advisory lock in migration 0084 is what serialises them, and
    // without it BOTH of these commit and the graph has a loop in it.
    const [forward, backward] = await Promise.all([
      addBomLine(first.id, second.id),
      addBomLine(second.id, first.id),
    ]);
    expect(statuses([forward, backward])).toEqual([201, 409]);

    const [count] = await admin<{ n: string }[]>`
      select count(*)::text as n from production_bom_lines
      where (parent_item_id = ${first.id} and component_item_id = ${second.id})
         or (parent_item_id = ${second.id} and component_item_id = ${first.id})
    `;
    expect(count?.n).toBe('1');
  });

  it('numbers two job cards raised together without collision', async () => {
    const product = await createProduct({ name: 'Race numbering board' });
    const [first, second] = await Promise.all([
      createJobCard(product.id, { quantity: 1 }),
      createJobCard(product.id, { quantity: 1 }),
    ]);
    expect(statuses([first, second])).toEqual([201, 201]);
    expect(first.json<JobCardDetail>().number).not.toBe(
      second.json<JobCardDetail>().number,
    );
  });
});

describe('the database guards, attacked directly', () => {
  it('refuses a cycle written as raw SQL by the owner role', async () => {
    const first = await createProduct({ name: 'Raw cycle A' });
    const second = await createProduct({ name: 'Raw cycle B' });
    expect((await addBomLine(first.id, second.id)).statusCode).toBe(201);

    await expect(
      admin`
        insert into production_bom_lines (
          organisation_id, parent_item_id, component_item_id, quantity,
          created_by_user_id
        )
        values (
          ${organisationId}, ${second.id}, ${first.id}, 1, 'attacker'
        )
      `,
    ).rejects.toThrow(/would close a cycle/);
  });

  it('refuses a job card inserted straight into completed', async () => {
    const product = await createProduct({ name: 'Raw completed board' });
    await expect(
      admin`
        insert into production_job_cards (
          organisation_id, fy_label, sequence_number, item_id, quantity,
          work_id, source_reference, status, completed_on, due_date,
          created_by_user_id
        )
        values (
          ${organisationId}, '2026-27', 9001, ${product.id}, 3, ${workId},
          'attack', 'completed', '2026-08-18', '2026-12-31', 'attacker'
        )
      `,
    ).rejects.toThrow(/created as planned/);
  });

  it('refuses more units than the job card planned, written as raw SQL', async () => {
    const product = await createProduct({ name: 'Raw ceiling board' });
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    expect((await mintSerial(card.id)).statusCode).toBe(201);

    await expect(
      admin`
        insert into production_serials (
          organisation_id, job_card_id, item_id, serial_number, sequence_number,
          created_by_user_id
        )
        values (
          ${organisationId}, ${card.id}, ${product.id},
          ${`${product.serialPrefix ?? ''}-99999`}, 99999, 'attacker'
        )
      `,
    ).rejects.toThrow(/already produced its planned/);
  });

  it('refuses a serial from outside the item series, written as raw SQL', async () => {
    const product = await createProduct({ name: 'Raw series board' });
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();

    await expect(
      admin`
        insert into production_serials (
          organisation_id, job_card_id, item_id, serial_number, sequence_number,
          created_by_user_id
        )
        values (
          ${organisationId}, ${card.id}, ${product.id}, 'NOTMINE-00001', 1,
          'attacker'
        )
      `,
    ).rejects.toThrow(/is not from the series of item/);
  });

  it('refuses a component serial for a part the unit is not built from', async () => {
    const product = await createProduct({ name: 'Raw component board' });
    const stranger = await createItem({ name: 'Raw stranger', serialControlled: true });
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    const unitId =
      (await mintSerial(card.id)).json<JobCardDetail>().serials[0]?.id ?? '';

    await expect(
      admin`
        insert into production_component_serials (
          organisation_id, finished_serial_id, component_item_id, serial_number,
          created_by_user_id
        )
        values (
          ${organisationId}, ${unitId}, ${stranger.id}, 'RAW-1', 'attacker'
        )
      `,
    ).rejects.toThrow(/not in the bill of material/);
  });

  it('refuses a rewound counter and a moved tenant', async () => {
    const product = await createProduct({ name: 'Raw counter board' });
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    expect((await mintSerial(card.id)).statusCode).toBe(201);

    await expect(
      admin`
        update production_serial_counters set next_value = 1
        where organisation_id = ${organisationId}
          and production_item_id = ${product.id}
      `,
    ).rejects.toThrow();

    await expect(
      admin`
        update production_items set organisation_id = ${outsiderOrganisationId}
        where id = ${product.id}
      `,
    ).rejects.toThrow(/tenant and provenance are immutable/);
  });
});

describe('the walls', () => {
  it('refuses a viewer every write, and refuses site the item master', async () => {
    const denied = await authed(viewer, {
      method: 'POST',
      url: '/api/production/items',
      organisationId,
      payload: {
        itemCode: `VIEW-${suffix}`,
        name: 'Viewer board',
        category: 'Display boards',
        unit: 'Nos',
        manufactured: false,
      },
    });
    expect(denied.statusCode, denied.body).toBe(403);

    // The item master is product design and stays with office; the shop
    // floor records units against it.
    const siteMaster = await authed(site, {
      method: 'POST',
      url: '/api/production/items',
      organisationId,
      payload: {
        itemCode: `SITE-${suffix}`,
        name: 'Site board',
        category: 'Display boards',
        unit: 'Nos',
        manufactured: false,
      },
    });
    expect(siteMaster.statusCode, siteMaster.body).toBe(403);
  });

  it('refuses a cancel to a member without the cancel authority', async () => {
    const product = await createProduct({ name: 'Authority board' });
    const card = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();

    await admin`
      update organisation_memberships set can_cancel_documents = false
      where organisation_id = ${organisationId}
        and user_id in (select "id" from auth_users where "email" = ${siteEmail})
    `;
    const denied = await authed(site, {
      method: 'POST',
      url: `/api/production/job-cards/${card.id}/cancel`,
      organisationId,
      payload: { reason: 'No authority to do this' },
    });
    expect(denied.statusCode, denied.body).toBe(403);
    await admin`
      update organisation_memberships set can_cancel_documents = true
      where organisation_id = ${organisationId}
        and user_id in (select "id" from auth_users where "email" = ${siteEmail})
    `;
  });

  it('hides a Work-scoped member’s unassigned Works and shows the private orders', async () => {
    const product = await createProduct({ name: 'Scope board' });
    const workCard = (
      await createJobCard(product.id, { quantity: 1 })
    ).json<JobCardDetail>();
    const privateCard = (
      await createJobCard(product.id, {
        quantity: 1,
        workId: undefined,
        customerName: 'Scope Customer',
        sourceReference: 'PO/SCOPE/1',
      })
    ).json<JobCardDetail>();

    const listed = await authed(scoped, {
      method: 'GET',
      url: '/api/production/job-cards',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const ids = listed.json<JobCardListResponse>().jobCards.map((card) => card.id);
    expect(ids).not.toContain(workCard.id);
    // A card with no Work belongs to nobody in particular and has
    // organisation-wide reach (docs/UX.md § settled information
    // architecture), so the scoped member does see it.
    expect(ids).toContain(privateCard.id);

    // A guessed id answers 404, not 403: a denial must not confirm the
    // Work exists.
    const peeked = await authed(scoped, {
      method: 'GET',
      url: `/api/production/job-cards/${workCard.id}`,
      organisationId,
    });
    expect(peeked.statusCode, peeked.body).toBe(404);
  });

  it('hides one organisation’s production from another', async () => {
    const withOwnHeader = await authed(outsider, {
      method: 'GET',
      url: `/api/production/job-cards/${outsiderJobCardId}`,
      organisationId: outsiderOrganisationId,
    });
    expect(withOwnHeader.statusCode, withOwnHeader.body).toBe(200);

    // Our members cannot reach theirs with our header (RLS finds
    // nothing) nor with theirs (the membership binding refuses).
    const foreignRow = await authed(office, {
      method: 'GET',
      url: `/api/production/job-cards/${outsiderJobCardId}`,
      organisationId,
    });
    expect(foreignRow.statusCode).toBe(404);

    const foreignHeader = await authed(office, {
      method: 'GET',
      url: `/api/production/job-cards/${outsiderJobCardId}`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreignHeader.statusCode).toBe(403);

    const foreignList = await authed(outsider, {
      method: 'GET',
      url: '/api/production/items',
      organisationId: outsiderOrganisationId,
    });
    expect(foreignList.statusCode, foreignList.body).toBe(200);
    const codes = foreignList
      .json<ProductionItemListResponse>()
      .items.map((item) => item.itemCode);
    expect(codes).toEqual([`OUT-${suffix}`]);
  });

  it('refuses a pagination cursor naming a row outside the register', async () => {
    const response = await authed(office, {
      method: 'GET',
      url: `/api/production/job-cards?limit=1&cursor=${outsiderJobCardId}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('CURSOR_INVALID');
  });

  it('pages the register by keyset and counts the whole of it', async () => {
    const response = await authed(office, {
      method: 'GET',
      url: '/api/production/job-cards?limit=2',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<JobCardListResponse>();
    expect(page.jobCards.length).toBeLessThanOrEqual(2);
    expect(page.nextCursor).not.toBeNull();
    // The tiles count the register, not the page: a stat that changed as
    // an operator paged would be reporting the window.
    expect(page.openCount).toBeGreaterThan(page.jobCards.length);
  });
});
