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
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  removeOrganisationResidue,
} from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import { billPurchaseOrder } from './helpers/vendor-bill.js';

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
let secondVendorContactId: string;
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

  const [secondVendor] = await admin<{ id: string }[]>`
    insert into contacts (
      organisation_id, designation, address, gstin, pincode, state_code,
      is_vendor, created_by_user_id
    )
    values (
      ${organisationId}, 'Second Source Components', 'Trade Centre',
      '27AAAGM0289C1ZL', '400002', '27', true, ${ownerUserId}
    )
    returning id
  `;
  if (!secondVendor) throw new Error('second vendor seed failed');
  secondVendorContactId = secondVendor.id;

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
    expect(movement.sourceLabel).toBe(`INV-${runId.toUpperCase()}`);
    expect(movement.reference).toMatch(/^SM\/SMPS/);
    // The running balance is NOT on the wire: it belongs to a per-item
    // ledger read in sequence order, and this list interleaves parts.
    expect(movement).not.toHaveProperty('balanceAfter');

    // …but it is still computed and still stored, which is the whole
    // point of the cache. Read straight from the column.
    const [stored] = await admin<{ balance_after: string }[]>`
      select balance_after::text as balance_after
      from stock_movements where id = ${movement.id}
    `;
    expect(stored?.balance_after).toBe('26.000');

    const listed = await authed(owner, {
      method: 'GET',
      url: '/api/stock/movements',
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

    // Tomorrow relative to the organisation's clock, not the runner's:
    // the route measures "in the future" against org-timezone today, and
    // between 18:30 and 24:00 UTC a UTC-derived tomorrow is already today
    // in Asia/Kolkata (the correspondence and company-documents suites
    // anchor the same way, after measuring exactly this failure).
    const [row] = await admin<{ today: string }[]>`
      select (now() at time zone o.timezone)::date::text as today
      from organisations o where o.id = ${organisationId}
    `;
    const tomorrow = new Date(Date.parse(`${row?.today}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
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

    // Closing also needs the vendor's tax invoice on file (migration
    // 0109); this test is about the stock receipt balance, so the bill
    // is a fixture.
    await billPurchaseOrder(admin, draft.id, ownerUserId);
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
      url: '/api/stock/movements',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json<StockMovementListResponse>();
    const workMovement = body.movements.find(
      (movement) => movement.movementType === 'issue',
    );
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

describe('the netting the first review found missing', () => {
  it('stops demanding material the job card has already been issued', async () => {
    // A fresh part on the board's bill, so this test owns its arithmetic.
    const part = (
      await seedItem(organisationId, ownerUserId, `NET${runId.slice(0, 4)}`)
    ).id;
    await admin`
      insert into production_bom_lines (
        organisation_id, parent_item_id, component_item_id, quantity,
        created_by_user_id
      )
      values (${organisationId}, ${boardItemId}, ${part}, 1, ${ownerUserId})
    `;

    const before = await itemRow(part);
    const committedBefore = Number(before.committed);
    expect(committedBefore, 'both open cards want one each per unit').toBeGreaterThan(
      0,
    );

    await receiveInto(part, '50');
    // Issue five to the Work-backed card. That material has LEFT the
    // shelf — the ledger decremented it — so it must not still be counted
    // as required, or the shortage screen buys it twice.
    const issued = await postMovement({
      productionItemId: part,
      movementType: 'issue',
      quantity: '5',
      productionJobCardId: jobCardId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const after = await itemRow(part);
    expect(Number(after.committed)).toBe(committedBefore - 5);
    expect(after.onHand).toBe('45.000');

    // A return puts the requirement back: the same signed sum, read the
    // other way.
    const returned = await postMovement({
      productionItemId: part,
      movementType: 'return',
      quantity: '2',
      productionJobCardId: jobCardId,
    });
    expect(returned.statusCode, returned.body).toBe(201);
    expect(Number((await itemRow(part)).committed)).toBe(committedBefore - 3);
  });

  it('stops asking for a part that is already on order', async () => {
    const shortageOf = async (itemId: string) =>
      (await shortages()).shortages.find((row) => row.itemId === itemId);

    const part = (
      await seedItem(organisationId, ownerUserId, `ORD${runId.slice(0, 4)}`)
    ).id;
    await admin`
      insert into production_bom_lines (
        organisation_id, parent_item_id, component_item_id, quantity,
        created_by_user_id
      )
      values (${organisationId}, ${boardItemId}, ${part}, 1, ${ownerUserId})
    `;
    const short = await shortageOf(part);
    if (!short) throw new Error('the part should be short');
    expect(short.onOrder).toBe('0.000');
    const wanted = short.shortage;

    // Draft an order for the whole shortage through the real conversion.
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/stock/shortages/purchase-order',
      organisationId,
      payload: {
        jobCardId,
        vendorContactId: secondVendorContactId,
        poDate: MOVEMENT_DATE,
        productionItemIds: [part],
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    // The material is on order, so the screen stops asking for it — even
    // though it is still a DRAFT, because a draft is a decision already
    // taken and re-asking would raise a second order for the same parts.
    expect(await shortageOf(part), 'covered by the order just raised').toBeUndefined();

    const line = created.json<PurchaseOrderDetailResponse>().lines[0];
    expect(line?.quantity).toBe(wanted);
  });
});

describe('one line, one receipt channel', () => {
  it('refuses a delivery challan item pointing at a stock-received line', async () => {
    const [line] = await admin<{ id: string }[]>`
      select pol.id from purchase_order_lines pol
      join purchase_orders po on po.id = pol.purchase_order_id
      where po.organisation_id = ${organisationId}
        and pol.production_item_id is not null
      limit 1
    `;
    if (!line) throw new Error('a stock-channel line should exist by now');

    const challanId = randomUUID();
    await admin`
      insert into delivery_challans (
        id, organisation_id, work_id, challan_date, prefix, status,
        consignee_snapshot, created_by_user_id
      )
      values (
        ${challanId}, ${organisationId}, ${workId}, ${MOVEMENT_DATE}, 'DC',
        'draft', '{"name": "SSE/Signal"}'::jsonb, ${ownerUserId}
      )
    `;
    const refused = await admin`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, description_snapshot,
        unit_snapshot, quantity, rate_snapshot, line_amount, position,
        purchase_order_line_id
      )
      values (
        ${organisationId}, ${challanId}, ${workId}, 'Cabinet', 'Nos', '1.000',
        '0.000000', '0.00', 1, ${line.id}
      )
    `.then(
      () => 'accepted',
      (error: unknown) => (error as { code?: string }).code,
    );
    // Counted by neither channel would be WORSE than double-counted: the
    // quantity would vanish from the balance that decides whether the
    // order may close.
    expect(refused).toBe('23F05');
    await admin`delete from delivery_challans where id = ${challanId}`;
  });
});

describe('scope reaches through every arm', () => {
  it('hides the job card and the purchase order, not only the Work', async () => {
    const listed = await authed(scoped, {
      method: 'GET',
      url: '/api/stock/movements',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json<StockMovementListResponse>();

    // Every movement this suite posted names a Work, a job card, or a
    // purchase order line — and all three reach the one Work this member
    // is not assigned to. An adjustment names none and shows its reason.
    for (const movement of body.movements) {
      if (movement.movementType === 'adjustment_in') continue;
      expect(
        movement.sourceLabel,
        `${movement.reference} leaked its source to an unassigned member`,
      ).toBeNull();
    }

    // The pending-receipt queue is scoped the same way.
    const pending = await authed(scoped, {
      method: 'GET',
      url: '/api/stock/production-receipts',
      organisationId,
    });
    expect(pending.statusCode, pending.body).toBe(200);
    expect(
      pending.json<PendingProductionReceiptListResponse>().dispatches,
      'a despatch on an unreachable Work is not a job this member is given',
    ).toEqual([]);
  });

  it('refuses a receipt against a purchase order whose Work is completed', async () => {
    // Its own order, issued through the real routes: the suite's earlier
    // one has already been closed, and a closed order refuses a receipt
    // for a different reason than the one under test here.
    const part = (await seedItem(organisationId, ownerUserId, `R8${runId.slice(0, 4)}`))
      .id;
    await admin`
      insert into production_bom_lines (
        organisation_id, parent_item_id, component_item_id, quantity,
        created_by_user_id
      )
      values (${organisationId}, ${boardItemId}, ${part}, 1, ${ownerUserId})
    `;
    await admin`
      delete from purchase_order_lines pol using purchase_orders po
      where po.id = pol.purchase_order_id
        and po.organisation_id = ${organisationId} and po.status = 'draft'
    `;
    await admin`
      delete from purchase_orders
      where organisation_id = ${organisationId} and status = 'draft'
    `;
    const drafted = await authed(owner, {
      method: 'POST',
      url: '/api/stock/shortages/purchase-order',
      organisationId,
      payload: {
        jobCardId,
        vendorContactId,
        poDate: MOVEMENT_DATE,
        productionItemIds: [part],
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const orderId = drafted.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${orderId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const lineId = issued.json<PurchaseOrderDetailResponse>().lines[0]?.id ?? '';

    // The full completed shape (0031), because the shape CHECK holds it
    // whole: a status without its stamp is not a completed Work.
    await admin`
      update works set status = 'completed',
        completed_at = now(), completed_by_user_id = ${ownerUserId},
        completion_note = 'Completed for the R8 receipt check'
      where id = ${workId}
    `;
    try {
      const response = await postMovement({
        productionItemId: part,
        movementType: 'purchase_receipt',
        quantity: '1',
        purchaseOrderLineId: lineId,
      });
      // R8 reaches THROUGH the order. The direct `workId` arm already
      // refuses a completed Work; the indirect one must not be the way
      // around it.
      expect(response.statusCode, response.body).toBe(409);
    } finally {
      await admin`
        update works set status = 'active',
          completed_at = null, completed_by_user_id = null,
          completion_note = null,
          reopened_at = now(), reopened_by_user_id = ${ownerUserId},
          reopen_note = 'Reopened after the R8 receipt check'
        where id = ${workId}
      `;
    }
  });
});

describe('time only runs forward, per part', () => {
  it("refuses a movement dated behind the part's last, and defaults to today", async () => {
    const part = (
      await seedItem(organisationId, ownerUserId, `TIME${runId.slice(0, 4)}`)
    ).id;

    // No date sent: the server uses the organisation's today.
    const first = await postMovement({
      productionItemId: part,
      movementType: 'adjustment_in',
      quantity: '3',
      reason: 'Opening count',
    });
    expect(first.statusCode, first.body).toBe(201);
    const [today] = await admin<{ today: string }[]>`
      select app_private.organisation_today(${organisationId})::text as today
    `;
    expect(first.json<StockMovementResponse>().movement.movementDate).toBe(
      today?.today,
    );

    const backdated = await postMovement({
      productionItemId: part,
      movementType: 'adjustment_in',
      quantity: '1',
      movementDate: '2026-08-01',
      reason: 'Yesterday docket',
    });
    expect(backdated.statusCode, backdated.body).toBe(409);
    expect(backdated.json<{ code: string }>().code).toBe('STOCK_BACKDATED');
  });
});

describe('the shortage conversion, raced by two vendors', () => {
  it('lets two vendors each take a draft, and refuses a second for one vendor', async () => {
    const part = (
      await seedItem(organisationId, ownerUserId, `TWOV${runId.slice(0, 4)}`)
    ).id;
    await admin`
      insert into production_bom_lines (
        organisation_id, parent_item_id, component_item_id, quantity,
        created_by_user_id
      )
      values (${organisationId}, ${boardItemId}, ${part}, 1, ${ownerUserId})
    `;
    // Clear the drafts this suite already left, so the one-draft-per-
    // vendor index is being tested rather than tripped over.
    await admin`
      delete from purchase_order_lines pol
      using purchase_orders po
      where po.id = pol.purchase_order_id
        and po.organisation_id = ${organisationId} and po.status = 'draft'
    `;
    await admin`
      delete from purchase_orders
      where organisation_id = ${organisationId} and status = 'draft'
    `;

    const convert = (vendor: string) =>
      authed(owner, {
        method: 'POST',
        url: '/api/stock/shortages/purchase-order',
        organisationId,
        payload: {
          jobCardId,
          vendorContactId: vendor,
          poDate: MOVEMENT_DATE,
          productionItemIds: [part],
        },
      });

    // DIFFERENT vendors are independent: 0045's index is per Work AND
    // vendor, so both must succeed. Only the first one's quantity is the
    // shortage — the second sees it already on order and finds nothing
    // left to buy, which is the on-order netting doing its job.
    const [first, second] = await Promise.all([
      convert(vendorContactId),
      convert(secondVendorContactId),
    ]);
    const outcomes = [first.statusCode, second.statusCode].sort();
    expect(
      outcomes[0],
      `one vendor drafts the shortage: ${first.body} / ${second.body}`,
    ).toBe(201);
    // The loser is refused for having nothing to order, never for a draft
    // conflict — the two vendors do not contend on the index.
    if (outcomes[1] !== 201) {
      const loser = first.statusCode === 201 ? second : first;
      expect(loser.json<{ code: string }>().code).toBe('STOCK_NOT_SHORT');
    }
  });
});

/**
 * The production screens, reading the same ledger.
 *
 * The job card's Materials tab and the register's Material badge are the
 * last two consumers of this pack's arithmetic (`docs/UX.md` § 11 row
 * 11a, which this work retires). They are proved HERE rather than in
 * `production.integration.test.ts` because everything the numbers are
 * made of lives in this file: a shelf to receive onto, a bill of material
 * to explode, and a purchase order that puts material in transit.
 *
 * Each case owns its part, its product and its card. A shelf is an
 * organisation-wide thing and this suite moves it about, so a case
 * sharing a part with another would be proving whichever ran last.
 */
describe("a job card's own view of the shelf", () => {
  let materialVendorId: string;
  /** A vendor of its own, because 0033 holds one draft per Work and
   * vendor and two cases here each draft an order on this suite's Work. */
  let competingVendorId: string;
  let sequence = 90;

  /** A job card for `product`, `units` planned, on this suite's Work. */
  async function seedCardFor(product: string, units: number): Promise<string> {
    sequence += 1;
    const card = randomUUID();
    await admin`
      insert into production_job_cards (
        id, organisation_id, fy_label, sequence_number, item_id, quantity,
        work_id, source_reference, due_date, created_by_user_id
      )
      values (
        ${card}, ${organisationId}, '2026-27', ${sequence}, ${product},
        ${units}, ${workId}, 'Schedule A2/1', '2026-12-01', ${ownerUserId}
      )
    `;
    return card;
  }

  async function seedProductAndCard(
    label: string,
    options: { readonly perUnit: number; readonly units: number },
  ): Promise<{ partId: string; productId: string; jobCardId: string }> {
    const part = await seedItem(
      organisationId,
      ownerUserId,
      `${label}P${runId.slice(0, 3)}`,
    );
    const product = await seedItem(
      organisationId,
      ownerUserId,
      `${label}M${runId.slice(0, 3)}`,
      { manufactured: true },
    );
    await admin`
      insert into production_bom_lines (
        organisation_id, parent_item_id, component_item_id, quantity,
        created_by_user_id
      )
      values (
        ${organisationId}, ${product.id}, ${part.id}, ${options.perUnit},
        ${ownerUserId}
      )
    `;
    return {
      partId: part.id,
      productId: product.id,
      jobCardId: await seedCardFor(product.id, options.units),
    };
  }

  /** Material off the shelf and onto the bench, against this card. */
  async function issueToCard(part: string, card: string, quantity: string) {
    const response = await postMovement({
      productionItemId: part,
      movementType: 'issue',
      quantity,
      movementDate: MOVEMENT_DATE,
      productionJobCardId: card,
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  /** One finished unit, through the route, so the card moves to
   * `in_production` the way it does in the factory. */
  async function mintUnit(card: string) {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/production/job-cards/${card}/serials`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  async function registerRow(card: string) {
    const listed = await authed(owner, {
      method: 'GET',
      url: '/api/production/job-cards',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    return listed
      .json<{ jobCards: readonly { id: string; materialShortParts: number }[] }>()
      .jobCards.find((entry) => entry.id === card);
  }

  async function materialPosition(card: string) {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/production/job-cards/${card}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      materialShortParts: number;
      materials: readonly {
        itemId: string;
        required: string;
        available: string;
        shortage: string;
      }[];
    }>();
  }

  beforeAll(async () => {
    const [vendor] = await admin<{ id: string }[]>`
      insert into contacts (
        organisation_id, designation, address, gstin, pincode, state_code,
        is_vendor, created_by_user_id
      )
      values (
        ${organisationId}, 'Material Position Supplies', 'Foundry Road',
        '27AAAGM0289C1ZL', '400003', '27', true, ${ownerUserId}
      )
      returning id
    `;
    if (!vendor) throw new Error('material-position vendor seed failed');
    materialVendorId = vendor.id;

    const [competing] = await admin<{ id: string }[]>`
      insert into contacts (
        organisation_id, designation, address, gstin, pincode, state_code,
        is_vendor, created_by_user_id
      )
      values (
        ${organisationId}, 'Competing Claim Traders', 'Dock Road',
        '27AAAGM0289C1ZL', '400004', '27', true, ${ownerUserId}
      )
      returning id
    `;
    if (!competing) throw new Error('competing-claim vendor seed failed');
    competingVendorId = competing.id;
  });

  it('reports the whole requirement short when the shelf is empty', async () => {
    const { partId, jobCardId: card } = await seedProductAndCard('SHRT', {
      perUnit: 2,
      units: 3,
    });

    const detail = await materialPosition(card);
    const row = detail.materials.find((material) => material.itemId === partId);
    if (!row) throw new Error('the part should be on the Materials tab');
    expect(row.required).toBe('6.000');
    expect(row.available).toBe('0.000');
    expect(row.shortage).toBe('6.000');
    expect(detail.materialShortParts).toBe(1);

    // The register's badge is the same count off the same expression: an
    // operator who reads "1 part short" on the row and opens the card
    // must not find a different answer inside it.
    expect((await registerRow(card))?.materialShortParts).toBe(1);
  });

  it('reports nothing short once the shelf holds the whole requirement', async () => {
    const { partId, jobCardId: card } = await seedProductAndCard('FULL', {
      perUnit: 2,
      units: 3,
    });
    await receiveInto(partId, '6.000');

    const detail = await materialPosition(card);
    const row = detail.materials.find((material) => material.itemId === partId);
    if (!row) throw new Error('the part should be on the Materials tab');
    expect(row.required).toBe('6.000');
    // The card's OWN claim is added back. The requirement function has
    // already committed these six to this card, and a card told it cannot
    // have the material it itself reserved would be short of nothing.
    expect(row.available).toBe('6.000');
    expect(row.shortage).toBe('0.000');
    expect(detail.materialShortParts).toBe(0);
  });

  it('closes the shortage against material on order, without it reaching the shelf', async () => {
    const { partId, jobCardId: card } = await seedProductAndCard('ORDR', {
      perUnit: 2,
      units: 3,
    });

    const before = await materialPosition(card);
    expect(before.materials.find((row) => row.itemId === partId)?.shortage).toBe(
      '6.000',
    );

    const drafted = await authed(owner, {
      method: 'POST',
      url: '/api/stock/shortages/purchase-order',
      organisationId,
      payload: {
        jobCardId: card,
        vendorContactId: materialVendorId,
        poDate: MOVEMENT_DATE,
        productionItemIds: [partId],
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);

    const after = await materialPosition(card);
    const row = after.materials.find((material) => material.itemId === partId);
    if (!row) throw new Error('the part should still be on the Materials tab');
    // Nothing has been received, so the shelf is untouched and Required
    // less Available is still six. The shortage is nothing, because the
    // six are bought — which is exactly why those two figures do not
    // subtract to the third.
    expect(row.required).toBe('6.000');
    expect(row.available).toBe('0.000');
    expect(row.shortage).toBe('0.000');
    expect(after.materialShortParts).toBe(0);
  });

  /**
   * THE TWO BASES. `required` is the card's gross bill; the shortage is
   * measured against its OUTSTANDING requirement — the bill times the
   * units not yet serialised, less what has been issued to the card.
   *
   * Subtracting a shelf from a gross requirement is the defect these two
   * cases exist for. Both of them read Ready with the netting, and both
   * of them report the card short of material it is holding without it.
   */
  it('reads Ready once the material has been issued to the bench', async () => {
    const { partId, jobCardId: card } = await seedProductAndCard('ISSD', {
      perUnit: 2,
      units: 3,
    });
    await receiveInto(partId, '6.000');
    await issueToCard(partId, card, '6.000');

    // The shelf is back to nothing, because the six are on the bench.
    expect((await itemRow(partId)).onHand).toBe('0.000');

    const detail = await materialPosition(card);
    const row = detail.materials.find((material) => material.itemId === partId);
    if (!row) throw new Error('the part should be on the Materials tab');
    // The gross bill is unchanged — the tab still states what the card
    // takes — but nothing more has to be bought.
    expect(row.required).toBe('6.000');
    expect(row.shortage).toBe('0.000');
    expect(detail.materialShortParts).toBe(0);
    expect((await registerRow(card))?.materialShortParts).toBe(0);
  });

  it('reads Ready when the units left to build are covered by the shelf', async () => {
    const { partId, jobCardId: card } = await seedProductAndCard('PART', {
      perUnit: 2,
      units: 3,
    });
    // Two of the six went into the unit already built and are gone; the
    // remaining two units need four, and four are on the shelf.
    await receiveInto(partId, '6.000');
    await issueToCard(partId, card, '2.000');
    await mintUnit(card);

    const detail = await materialPosition(card);
    const row = detail.materials.find((material) => material.itemId === partId);
    if (!row) throw new Error('the part should be on the Materials tab');
    expect(row.required).toBe('6.000');
    expect(row.available).toBe('4.000');
    expect(row.shortage).toBe('0.000');
    expect(detail.materialShortParts).toBe(0);
  });

  /**
   * ONE ORDER, TWO CLAIMANTS. On-hand and on-order are facts about the
   * PART and are netted once against the summed requirement (0087 § 7).
   * Netted per card instead, both cards subtract the whole lorry and both
   * read Ready while the organisation is genuinely ten short.
   *
   * Both cards reading short is the deliberate answer: neither may assume
   * the order is theirs, and the shortage screen stays the authority on
   * how much to buy.
   */
  it('does not let two cards each claim the same purchase order', async () => {
    const {
      partId,
      productId,
      jobCardId: firstCard,
    } = await seedProductAndCard('COMP', { perUnit: 1, units: 10 });

    // Ordered while ONE card wants the part, so the order is for ten and
    // not for twenty.
    const drafted = await authed(owner, {
      method: 'POST',
      url: '/api/stock/shortages/purchase-order',
      organisationId,
      payload: {
        jobCardId: firstCard,
        vendorContactId: competingVendorId,
        poDate: MOVEMENT_DATE,
        productionItemIds: [partId],
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);

    const secondCard = await seedCardFor(productId, 10);

    // Twenty wanted, nothing on the shelf, ten coming. The organisation
    // is ten short and the screen that buys material says so.
    const organisationWide = (await shortages()).shortages.find(
      (row) => row.itemId === partId,
    );
    expect(organisationWide?.required).toBe('20.000');
    expect(organisationWide?.onHand).toBe('0.000');
    expect(organisationWide?.onOrder).toBe('10.000');
    expect(organisationWide?.shortage).toBe('10.000');

    // Neither card may treat the one order as its own. Both read short,
    // and neither reads Ready while the organisation is short — which is
    // what netting the order once per card would have produced.
    for (const card of [firstCard, secondCard]) {
      const detail = await materialPosition(card);
      const row = detail.materials.find((material) => material.itemId === partId);
      if (!row) throw new Error('the part should be on the Materials tab');
      expect(row.shortage, `card ${card}`).toBe('10.000');
      expect(detail.materialShortParts, `card ${card}`).toBe(1);
      expect((await registerRow(card))?.materialShortParts).toBe(1);
    }
  });

  it('answers a completed card with its bill and no shortage', async () => {
    const { partId, jobCardId: card } = await seedProductAndCard('DONE', {
      perUnit: 2,
      units: 1,
    });
    await mintUnit(card);
    const completed = await authed(owner, {
      method: 'POST',
      url: `/api/production/job-cards/${card}/complete`,
      organisationId,
    });
    expect(completed.statusCode, completed.body).toBe(200);

    // The shelf is empty and the card's gross bill is two, but a
    // completed card needs nothing more — it is outside the outstanding
    // requirement entirely, so it is short of nothing and the register
    // does not explode its bill of material to find that out.
    const detail = await materialPosition(card);
    const row = detail.materials.find((material) => material.itemId === partId);
    if (!row) throw new Error('a completed card still states its bill');
    expect(row.required).toBe('2.000');
    expect(row.shortage).toBe('0.000');
    expect(detail.materialShortParts).toBe(0);
    expect((await registerRow(card))?.materialShortParts).toBe(0);
  });
});
