import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  PendingProductionReceiptListResponse,
  PurchaseOrderDetailResponse,
  StockMovementListResponse,
  StockMovementResponse,
  StockRegisterResponse,
  StockShortageResponse,
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
 * The stock ledger, end to end (migration 0087).
 *
 * What is proved here, in the order the module's risks run:
 *
 *   1. the register's three derived numbers — on hand from the ledger,
 *      committed from the open job cards' bill of material, available
 *      from the difference — and the stat strip over the whole register;
 *   2. the movement, its source shapes, and the refusals each one earns;
 *   3. THE RACES, which are the reason the guard exists rather than a
 *      route check: parallel issues against one balance, parallel
 *      receipts of one despatch, and parallel conversions of one
 *      shortage into one vendor's draft;
 *   4. the shortage, its explosion, and its conversion into a purchase
 *      order that is 0033's and not a second one;
 *   5. THE CLOSURE EXTENSION: a shortage order receives onto a shelf
 *      rather than onto a challan, and can therefore be closed at all;
 *   6. the walls — role, work scope, and the other organisation.
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
const ownerEmail = `inv-owner-${runId}@integration.test`;
const readerEmail = `inv-reader-${runId}@integration.test`;
const scopedEmail = `inv-scoped-${runId}@integration.test`;
const outsiderEmail = `inv-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** Every date in this suite is in the past relative to any plausible run:
 * the ledger refuses a movement dated after the organisation's today. */
const MOVEMENT_DATE = '2026-08-01';

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let workId: string;
let ownerUserId: string;
let vendorContactId: string;
/** The bought-in part every stock test moves. */
let smpsItemId: string;
/** A second bought-in part, so the register has more than one row. */
let cabinetItemId: string;
/** The manufactured board, its job card, and the despatch fixtures. */
let boardItemId: string;
let boardSerialPrefix: string;
let jobCardId: string;
let privateJobCardId: string;
let outsiderItemId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let reader: CookieJar;
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

async function seedItem(
  organisation: string,
  userId: string,
  code: string,
  options: { readonly manufactured?: boolean; readonly category?: string } = {},
): Promise<{ id: string; serialPrefix: string | null }> {
  const id = randomUUID();
  // The item code is uppercased because the serial prefix is cut from it,
  // and 0084 holds a prefix to `^[A-Z0-9][A-Z0-9-]{1,15}$`.
  const upper = code.toUpperCase();
  const serialPrefix = options.manufactured === true ? upper.slice(0, 8) : null;
  await admin`
    insert into production_items (
      id, organisation_id, item_code, name, category, unit, manufactured,
      serial_prefix, serial_controlled, created_by_user_id
    )
    values (
      ${id}, ${organisation}, ${upper}, ${`Fixture ${upper}`},
      ${options.category ?? 'Electronics'}, 'Nos',
      ${options.manufactured ?? false}, ${serialPrefix},
      ${options.manufactured ?? false}, ${userId}
    )
  `;
  return { id, serialPrefix };
}

async function register(jar: CookieJar = owner): Promise<StockRegisterResponse> {
  const response = await authed(jar, {
    method: 'GET',
    url: '/api/stock/items',
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<StockRegisterResponse>();
}

async function itemRow(itemId: string) {
  const body = await register();
  const row = body.items.find((item) => item.id === itemId);
  if (!row) throw new Error(`item ${itemId} missing from the register`);
  return row;
}

async function postMovement(payload: Record<string, unknown>, jar: CookieJar = owner) {
  return authed(jar, {
    method: 'POST',
    url: '/api/stock/movements',
    organisationId,
    payload,
  });
}

async function receiveInto(itemId: string, quantity: string): Promise<void> {
  const response = await postMovement({
    productionItemId: itemId,
    movementType: 'adjustment_in',
    quantity,
    movementDate: MOVEMENT_DATE,
    reason: 'Opening stock count',
  });
  expect(response.statusCode, response.body).toBe(201);
}

/** A job card for the manufactured board with `quantity` units planned,
 * so the bill of material asks for material and the shortage screen has
 * something to say. */
async function seedJobCard(
  quantity: number,
  options: { readonly work?: string | null; readonly sequence: number },
): Promise<string> {
  const id = randomUUID();
  const work = options.work === undefined ? workId : options.work;
  await admin`
    insert into production_job_cards (
      id, organisation_id, fy_label, sequence_number, item_id, quantity,
      work_id, customer_name, source_reference, due_date, created_by_user_id
    )
    values (
      ${id}, ${organisationId}, '2026-27', ${options.sequence}, ${boardItemId},
      ${quantity}, ${work}, ${work === null ? 'Krishna Electricals, Pune' : null},
      'Schedule A2/1', '2026-12-01', ${ownerUserId}
    )
  `;
  return id;
}

/** Serialises `count` units of a job card and releases them on one
 * despatch. Returns the despatch id. */
async function seedDespatch(card: string, count: number): Promise<string> {
  const dispatchId = randomUUID();
  const [position] = await admin<{ next: string }[]>`
    select coalesce(max(sequence_number), 0)::int + 1 as next
    from production_serials
    where organisation_id = ${organisationId} and item_id = ${boardItemId}
  `;
  const first = Number(position?.next ?? 1);
  const serialIds: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const serialId = randomUUID();
    await admin`
      insert into production_serials (
        id, organisation_id, job_card_id, item_id, serial_number,
        sequence_number, created_by_user_id
      )
      values (
        ${serialId}, ${organisationId}, ${card}, ${boardItemId},
        ${`${boardSerialPrefix}-${String(first + offset).padStart(5, '0')}`},
        ${first + offset}, ${ownerUserId}
      )
    `;
    serialIds.push(serialId);
  }
  const [existing] = await admin<{ next: string }[]>`
    select coalesce(max(sequence_number), 0)::int + 1 as next
    from production_dispatches
    where organisation_id = ${organisationId} and job_card_id = ${card}
  `;
  await admin`
    insert into production_dispatches (
      id, organisation_id, job_card_id, sequence_number, dispatched_on,
      created_by_user_id
    )
    values (
      ${dispatchId}, ${organisationId}, ${card},
      ${Number(existing?.next ?? 1)}, ${MOVEMENT_DATE}, ${ownerUserId}
    )
  `;
  for (const serialId of serialIds) {
    await admin`
      insert into production_dispatch_serials (
        organisation_id, production_dispatch_id, production_serial_id, job_card_id
      )
      values (${organisationId}, ${dispatchId}, ${serialId}, ${card})
    `;
  }
  return dispatchId;
}

async function shortages(jar: CookieJar = owner): Promise<StockShortageResponse> {
  const response = await authed(jar, {
    method: 'GET',
    url: '/api/stock/shortages',
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<StockShortageResponse>();
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-inventory-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-inv-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Inventory Owner');
  reader = await signUp(readerEmail, 'Inventory Reader');
  scoped = await signUp(scopedEmail, 'Inventory Scoped');
  outsider = await signUp(outsiderEmail, 'Inventory Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Inventory Constructions', slug: `inv-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Inventory Outsiders', slug: `inv-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [readerEmail, 'viewer'],
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
  ownerUserId = ownerRow.id;

  workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`INV-${runId.toUpperCase()}`},
      ${`L-INV-${runId}`}, '2026-01-05', 'Inventory fixture work',
      '10000000.00', '9000000.00', 'per_schedule', ${ownerUserId}
    )
  `;

  const [vendor] = await admin<{ id: string }[]>`
    insert into contacts (
      organisation_id, designation, address, gstin, pincode, state_code,
      is_vendor, created_by_user_id
    )
    values (
      ${organisationId}, 'Bright LED Components', 'Industrial Estate',
      '27AAAGM0289C1ZL', '400001', '27', true, ${ownerUserId}
    )
    returning id
  `;
  if (!vendor) throw new Error('vendor seed failed');
  vendorContactId = vendor.id;

  const smps = await seedItem(organisationId, ownerUserId, `SMPS${runId.slice(0, 4)}`, {
    category: 'Power supplies',
  });
  smpsItemId = smps.id;
  const cabinet = await seedItem(
    organisationId,
    ownerUserId,
    `CAB${runId.slice(0, 4)}`,
    { category: 'Fabrication' },
  );
  cabinetItemId = cabinet.id;
  const board = await seedItem(
    organisationId,
    ownerUserId,
    `IPDB${runId.slice(0, 4)}`,
    { manufactured: true, category: 'Display boards' },
  );
  boardItemId = board.id;
  boardSerialPrefix = board.serialPrefix ?? '';

  // The board takes two SMPS and one cabinet per unit.
  await admin`
    insert into production_bom_lines (
      organisation_id, parent_item_id, component_item_id, quantity,
      created_by_user_id
    )
    values
      (${organisationId}, ${boardItemId}, ${smpsItemId}, 2, ${ownerUserId}),
      (${organisationId}, ${boardItemId}, ${cabinetItemId}, 1, ${ownerUserId})
  `;

  jobCardId = await seedJobCard(10, { sequence: 81 });
  privateJobCardId = await seedJobCard(4, { work: null, sequence: 82 });

  const outsiderItem = await seedItem(
    outsiderOrganisationId,
    outsiderRow.id,
    `OUT${runId.slice(0, 4)}`,
  );
  outsiderItemId = outsiderItem.id;
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

describe('the stock register', () => {
  it('derives on hand, committed and available, and never stores any of them', async () => {
    // Nothing received yet, and two open job cards wanting SMPS: ten
    // boards at two each, plus four private ones at two each.
    const before = await itemRow(smpsItemId);
    expect(before.onHand).toBe('0.000');
    expect(before.committed).toBe('28.000');
    expect(before.available).toBe('-28.000');

    await receiveInto(smpsItemId, '30');

    const after = await itemRow(smpsItemId);
    expect(after.onHand).toBe('30.000');
    expect(after.committed).toBe('28.000');
    expect(after.available).toBe('2.000');

    // No column anywhere holds any of the three.
    const [columns] = await admin<{ names: string[] }[]>`
      select array_agg(column_name::text) as names
      from information_schema.columns
      where table_name = 'production_items'
        and column_name in ('on_hand', 'reserved', 'available', 'balance')
    `;
    expect(columns?.names ?? null).toBeNull();
  });

  it('badges a part low against its reorder level, and counts the register', async () => {
    const set = await authed(owner, {
      method: 'PUT',
      url: `/api/stock/items/${smpsItemId}/reorder-level`,
      organisationId,
      payload: { reorderLevel: '5' },
    });
    expect(set.statusCode, set.body).toBe(200);

    const row = await itemRow(smpsItemId);
    // Available is 2 against a level of 5.
    expect(row.reorderLevel).toBe('5.000');
    expect(row.belowReorderLevel).toBe(true);

    const body = await register();
    expect(body.summary.partsTracked).toBeGreaterThanOrEqual(3);
    expect(body.summary.partsBelowReorderLevel).toBeGreaterThanOrEqual(1);
    // The cabinet is wanted fourteen times and none is on the shelf.
    expect(body.summary.partsShort).toBeGreaterThanOrEqual(1);

    // Clearing is not the same as setting zero.
    const cleared = await authed(owner, {
      method: 'PUT',
      url: `/api/stock/items/${smpsItemId}/reorder-level`,
      organisationId,
      payload: { reorderLevel: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(
      cleared.json<{ item: { reorderLevel: string | null } }>().item.reorderLevel,
    ).toBeNull();
    expect((await itemRow(smpsItemId)).belowReorderLevel).toBe(false);
  });
});

describe('posting a movement', () => {
  it('records an issue against a Work and reads it back with its source', async () => {
    const posted = await postMovement({
      productionItemId: smpsItemId,
      movementType: 'issue',
      quantity: '4',
      movementDate: MOVEMENT_DATE,
      workId,
      counterparty: 'SSE/Signal, Mumbai Central',
    });
    expect(posted.statusCode, posted.body).toBe(201);
    const { movement } = posted.json<StockMovementResponse>();

    // The magnitude went up as a positive number and came back signed:
    // the direction belongs to the type, not to the request.
    expect(movement.quantity).toBe('-4.000');
    expect(movement.balanceAfter).toBe('26.000');
    expect(movement.source).toBe('work');
    expect(movement.sourceLabel).toBe(`INV-${runId.toUpperCase()}`);
    expect(movement.reference).toMatch(/^SM\/SMPS/);

    const listed = await authed(owner, {
      method: 'GET',
      url: `/api/stock/movements?itemId=${smpsItemId}`,
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json<StockMovementListResponse>();
    expect(body.movements[0]?.id).toBe(movement.id);
  });

  it('refuses every source shape that names nothing, or names two things', async () => {
    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['an issue naming no destination', { movementType: 'issue', quantity: '1' }],
      [
        'an issue naming both',
        {
          movementType: 'issue',
          quantity: '1',
          workId,
          productionJobCardId: jobCardId,
        },
      ],
      [
        'an adjustment with no reason',
        { movementType: 'adjustment_in', quantity: '1' },
      ],
      [
        'a receipt with no purchase order line',
        { movementType: 'purchase_receipt', quantity: '1' },
      ],
      [
        'a reason on something that is not an adjustment',
        { movementType: 'issue', quantity: '1', workId, reason: 'Because' },
      ],
    ];
    for (const [label, extra] of cases) {
      const response = await postMovement({
        productionItemId: smpsItemId,
        movementDate: MOVEMENT_DATE,
        ...extra,
      });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('STOCK_MOVEMENT_INVALID');
    }
  });

  it('refuses an issue larger than the shelf, and a movement dated tomorrow', async () => {
    const tooMuch = await postMovement({
      productionItemId: smpsItemId,
      movementType: 'issue',
      quantity: '9999',
      movementDate: MOVEMENT_DATE,
      workId,
    });
    expect(tooMuch.statusCode, tooMuch.body).toBe(409);
    expect(tooMuch.json<{ code: string }>().code).toBe('STOCK_INSUFFICIENT');

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const dated = await postMovement({
      productionItemId: smpsItemId,
      movementType: 'adjustment_in',
      quantity: '1',
      movementDate: tomorrow,
      reason: 'Arriving tomorrow',
    });
    expect(dated.statusCode, dated.body).toBe(400);
    expect(dated.json<{ code: string }>().code).toBe('STOCK_MOVEMENT_INVALID');
  });

  /**
   * THE GATE, at the altitude an operator meets it.
   *
   * Eight simultaneous issues of three against a shelf of twenty: seven
   * would fit if they were serialised badly, six actually do. The route's
   * own pre-check reads the same balance for all eight, so this passes
   * only because the guard claims the item's counter row before it
   * computes anything.
   */
  it('does not oversell one shelf to eight simultaneous requests', async () => {
    const item = (
      await seedItem(organisationId, ownerUserId, `RACE${runId.slice(0, 4)}`)
    ).id;
    await receiveInto(item, '20');

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        postMovement({
          productionItemId: item,
          movementType: 'issue',
          quantity: '3',
          movementDate: MOVEMENT_DATE,
          workId,
        }),
      ),
    );
    const created = responses.filter((response) => response.statusCode === 201);
    const refused = responses.filter((response) => response.statusCode === 409);

    expect(created.length, 'six issues of 3 fit inside a shelf of 20').toBe(6);
    expect(refused.length).toBe(2);
    for (const response of refused) {
      expect(response.json<{ code: string }>().code).toBe('STOCK_INSUFFICIENT');
    }

    const [balance] = await admin<{ on_hand: string }[]>`
      select app_private.stock_on_hand(${organisationId}, ${item})::text as on_hand
    `;
    expect(balance?.on_hand).toBe('2.000');
  });
});

describe('taking a despatch into stock', () => {
  it('lists an unreceived despatch, receives its own unit count, and receives it once', async () => {
    const dispatchId = await seedDespatch(jobCardId, 3);

    const pending = await authed(owner, {
      method: 'GET',
      url: '/api/stock/production-receipts',
      organisationId,
    });
    expect(pending.statusCode, pending.body).toBe(200);
    const listed = pending
      .json<PendingProductionReceiptListResponse>()
      .dispatches.find((row) => row.productionDispatchId === dispatchId);
    expect(listed?.quantity).toBe('3');
    expect(listed?.reference).toBe('PP-26-081/D1');

    // Eight racing receipts, one shelf entry: the unique index on the
    // despatch is what settles it, and the loser gets a named refusal
    // rather than a 500.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        authed(owner, {
          method: 'POST',
          url: '/api/stock/production-receipts',
          organisationId,
          payload: { productionDispatchId: dispatchId, movementDate: MOVEMENT_DATE },
        }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201).length).toBe(1);
    for (const response of responses.filter((r) => r.statusCode !== 201)) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('STOCK_DISPATCH_RECEIVED');
    }

    expect((await itemRow(boardItemId)).onHand).toBe('3.000');

    // 0084 § 7's self-closing delete path.
    const removal = await admin`
      delete from production_dispatches where id = ${dispatchId}
    `.then(
      () => 'deleted',
      () => 'refused',
    );
    expect(removal).toBe('refused');
  });
});

describe('shortage procurement', () => {
  it('explodes the bill of material, nets the shelf, and names the job cards', async () => {
    const body = await shortages();
    const cabinet = body.shortages.find((row) => row.itemId === cabinetItemId);
    if (!cabinet) throw new Error('the cabinet should be short');

    // Ten boards outstanding minus the three already built, plus four
    // private ones: eleven cabinets at one each. Nothing on the shelf.
    expect(cabinet.required).toBe('11.000');
    expect(cabinet.onHand).toBe('0.000');
    expect(cabinet.shortage).toBe('11.000');

    // One row for the PART, with both job cards named — never one row
    // per (plan, part) with a checkbox on each, which is how the mock
    // orders the same cabinet twice.
    expect(cabinet.jobCards.map((card) => card.number).sort()).toEqual([
      'PP-26-081',
      'PP-26-082',
    ]);
    expect(body.shortages.filter((row) => row.itemId === cabinetItemId).length).toBe(1);
  });

  it('refuses a job card that serves a private order, because a purchase order needs a Work', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/stock/shortages/purchase-order',
      organisationId,
      payload: {
        jobCardId: privateJobCardId,
        vendorContactId,
        poDate: MOVEMENT_DATE,
        productionItemIds: [cabinetItemId],
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('STOCK_JOB_CARD_HAS_NO_WORK');
  });

  it('refuses a part the register is no longer short of', async () => {
    const stocked = (
      await seedItem(organisationId, ownerUserId, `SPARE${runId.slice(0, 4)}`)
    ).id;
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/stock/shortages/purchase-order',
      organisationId,
      payload: {
        jobCardId,
        vendorContactId,
        poDate: MOVEMENT_DATE,
        productionItemIds: [stocked],
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('STOCK_NOT_SHORT');
  });

  /**
   * The conversion, and the race it introduces: two operators turning the
   * same shortage into the same vendor's draft. 0033 holds one draft per
   * Work and vendor with a partial unique index, so exactly one wins and
   * the other gets that module's own named refusal rather than a 500.
   */
  it('creates one draft purchase order, however many conversions race', async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        authed(owner, {
          method: 'POST',
          url: '/api/stock/shortages/purchase-order',
          organisationId,
          payload: {
            jobCardId,
            vendorContactId,
            poDate: MOVEMENT_DATE,
            expectedOn: '2026-08-24',
            productionItemIds: [cabinetItemId],
          },
        }),
      ),
    );
    const created = responses.filter((response) => response.statusCode === 201);
    expect(created.length).toBe(1);
    for (const response of responses.filter((r) => r.statusCode !== 201)) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('PO_DRAFT_EXISTS');
    }

    const detail = created[0]?.json<PurchaseOrderDetailResponse>();
    // It is 0033's purchase order: a draft, on the job card's Work, with
    // no number yet and the quantity the SERVER computed.
    expect(detail?.purchaseOrder.status).toBe('draft');
    expect(detail?.purchaseOrder.workId).toBe(workId);
    expect(detail?.purchaseOrder.poNumber).toBeNull();
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0]?.quantity).toBe('11.000');
    // Nil rate: the shortage screen knows what to buy and not what it
    // costs, so pricing stays in the purchase-order editor.
    expect(Number(detail?.lines[0]?.rate)).toBe(0);

    const [line] = await admin<
      { production_item_id: string; production_job_card_id: string }[]
    >`
      select production_item_id, production_job_card_id
      from purchase_order_lines
      where purchase_order_id = ${detail?.purchaseOrder.id ?? ''}
    `;
    expect(line?.production_item_id).toBe(cabinetItemId);
    expect(line?.production_job_card_id).toBe(jobCardId);

    // …and the shortage screen lists it back.
    const body = await shortages();
    const listedOrder = body.purchaseOrders.find(
      (order) => order.id === detail?.purchaseOrder.id,
    );
    expect(listedOrder?.jobCardNumbers).toEqual(['PP-26-081']);
    expect(listedOrder?.lines[0]?.itemCode).toContain('CAB');
  });

  /**
   * THE CLOSURE EXTENSION, which is the reason `readLines` changed.
   *
   * A shortage order's material never appears on a delivery challan — it
   * is consumed in the factory — so before Inventory such an order could
   * never reach "fully received" and could never be closed. Here it is
   * received onto the shelf and closes.
   */
  it('closes a shortage order that was received onto a shelf rather than a challan', async () => {
    const [draft] = await admin<{ id: string }[]>`
      select id from purchase_orders
      where organisation_id = ${organisationId} and status = 'draft'
      order by created_at desc limit 1
    `;
    if (!draft) throw new Error('the conversion above should have left a draft');

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${draft.id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const order = issued.json<PurchaseOrderDetailResponse>();
    const lineId = order.lines[0]?.id ?? '';
    expect(order.lines[0]?.receivedQuantity).toBe('0.000');
    expect(order.lines[0]?.pendingQuantity).toBe('11.000');

    // Not fully received yet, so it will not close.
    const tooEarly = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${draft.id}/close`,
      organisationId,
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(409);
    expect(tooEarly.json<{ code: string }>().code).toBe('PO_NOT_FULLY_RECEIVED');

    const received = await postMovement({
      productionItemId: cabinetItemId,
      movementType: 'purchase_receipt',
      quantity: '11',
      movementDate: MOVEMENT_DATE,
      purchaseOrderLineId: lineId,
    });
    expect(received.statusCode, received.body).toBe(201);

    const reread = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${draft.id}`,
      organisationId,
    });
    const balanced = reread.json<PurchaseOrderDetailResponse>();
    expect(balanced.lines[0]?.receivedQuantity).toBe('11.000');
    expect(balanced.lines[0]?.pendingQuantity).toBe('0.000');

    const closed = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${draft.id}/close`,
      organisationId,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json<PurchaseOrderDetailResponse>().purchaseOrder.status).toBe(
      'closed',
    );

    // The shelf has the material, and the shortage is gone.
    expect((await itemRow(cabinetItemId)).onHand).toBe('11.000');
    const body = await shortages();
    expect(body.shortages.find((row) => row.itemId === cabinetItemId)).toBeUndefined();
  });

  it('refuses a receipt against a line that does not buy the part', async () => {
    const [line] = await admin<{ id: string }[]>`
      select pol.id from purchase_order_lines pol
      join purchase_orders po on po.id = pol.purchase_order_id
      where po.organisation_id = ${organisationId}
        and pol.production_item_id = ${cabinetItemId}
      limit 1
    `;
    const response = await postMovement({
      productionItemId: smpsItemId,
      movementType: 'purchase_receipt',
      quantity: '1',
      movementDate: MOVEMENT_DATE,
      purchaseOrderLineId: line?.id ?? randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('STOCK_SOURCE_INVALID');
  });
});

describe('the walls', () => {
  it('refuses a movement from a member with no write role', async () => {
    const response = await postMovement(
      {
        productionItemId: smpsItemId,
        movementType: 'adjustment_in',
        quantity: '1',
        movementDate: MOVEMENT_DATE,
        reason: 'Viewer should not manage this',
      },
      reader,
    );
    expect(response.statusCode, response.body).toBe(403);
  });

  it('shows a work-scoped member the movement but not the Work it served', async () => {
    const listed = await authed(scoped, {
      method: 'GET',
      url: `/api/stock/movements?itemId=${smpsItemId}`,
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json<StockMovementListResponse>();
    const workMovement = body.movements.find((movement) => movement.source === 'work');
    expect(
      workMovement,
      'the shelf is organisation-level, so the row is visible',
    ).toBeDefined();
    expect(
      workMovement?.sourceLabel,
      'the Work it served is not: that is work-scoped',
    ).toBeNull();

    // And the shortage screen hides the Work behind the job card too.
    const scopedShortages = await shortages(scoped);
    for (const shortage of scopedShortages.shortages) {
      for (const card of shortage.jobCards) {
        expect(card.workCode).toBeNull();
      }
    }
    expect(
      scopedShortages.purchaseOrders,
      'a purchase order is a Work document',
    ).toEqual([]);
  });

  it('cannot reach another organisation, header or item', async () => {
    const foreignHeader = await authed(owner, {
      method: 'GET',
      url: '/api/stock/items',
      organisationId: outsiderOrganisationId,
    });
    expect(foreignHeader.statusCode).toBe(403);

    const foreignItem = await postMovement({
      productionItemId: outsiderItemId,
      movementType: 'adjustment_in',
      quantity: '1',
      movementDate: MOVEMENT_DATE,
      reason: 'Reaching across the wall',
    });
    expect(foreignItem.statusCode, foreignItem.body).toBe(404);
    expect(foreignItem.json<{ code: string }>().code).toBe('STOCK_ITEM_NOT_FOUND');

    // The other organisation's register never carries this tenant's rows.
    const theirs = await authed(outsider, {
      method: 'GET',
      url: '/api/stock/items',
      organisationId: outsiderOrganisationId,
    });
    expect(theirs.statusCode, theirs.body).toBe(200);
    const ids = theirs.json<StockRegisterResponse>().items.map((item) => item.id);
    expect(ids).not.toContain(smpsItemId);
    expect(ids).toContain(outsiderItemId);
  });
});
