import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Rule G2 (legacy spec §8, rule R10; ADR-0006 decisions 3 and 5): a Work
 * item's payment category is frozen once a non-cancelled finalised
 * Measurement Book has BILLED that item.
 *
 * The Measurement Book engine reads the item's CURRENT category and the
 * CURRENT matrix percentages at preview and finalize and remembers only
 * prior stage QUANTITY, so re-categorising a billed item re-opens stages
 * the earlier bill already paid and doubles them on the next MB. These
 * tests pin the refusal AND — the part that matters more — the ordinary
 * corrections the rule must leave alone: an item with site evidence but
 * no bill, an item whose only Measurement Book line is the all-zero line
 * an MB writes for items it did not bill, and an item billed only on a
 * Measurement Book that was later cancelled.
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
const ownerEmail = `payg-owner-${runId}@integration.test`;
const officeEmail = `payg-office-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let workId: string;
let scheduleId: string;

/** Billed in MB-01 as SUPPLY (deltaSupplied 10 of 10 at rate 1000). */
let billedItemId: string;
/** Present on MB-01 only as the all-zero line — not billed. */
let zeroLineItemId: string;
/** Billed on MB-02, which was afterwards cancelled. */
let cancelledMbItemId: string;
/** Installed on site, never billed; still uncategorised. */
let evidenceOnlyItemId: string;
/** Billed in MB-01 while still uncategorised. */
let uncategorisedBilledItemId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;

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

async function setCategory(workItemId: string, paymentCategory: string | null) {
  return authed(office, {
    method: 'PATCH',
    url: `/api/work-items/${workItemId}/payment-category`,
    organisationId,
    payload: { paymentCategory },
  });
}

async function storedCategory(workItemId: string): Promise<string | null> {
  const [row] = await admin<{ payment_category: string | null }[]>`
    select payment_category from work_items where id = ${workItemId}
  `;
  return row?.payment_category ?? null;
}

async function insertItem(
  itemNumber: string,
  category: string | null,
): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category
    )
    values (
      ${id}, ${organisationId}, ${workId}, ${scheduleId}, ${itemNumber},
      ${`Item ${itemNumber}`}, 'Nos', 10.000, 1000.00, ${category}
    )
  `;
  return id;
}

interface LineSpec {
  workItemId: string;
  itemNumber: string;
  resolvedCategory: string;
  paymentCategory: string | null;
  deltaSupplied: string;
}

/**
 * Writes a finalised Measurement Book the way the finalize transaction
 * does: lines land while the parent is still draft (the 0024 line
 * mutation guard requires it), then the book is stamped finalized.
 */
async function insertFinalisedMb(
  mbNumber: string,
  sequence: number,
  lines: readonly LineSpec[],
): Promise<string> {
  const bookId = randomUUID();
  await admin`
    insert into measurement_books (
      id, organisation_id, work_id, status, mb_date, created_by_user_id
    )
    values (
      ${bookId}, ${organisationId}, ${workId}, 'draft', '2025-06-10',
      ${ownerUserId}
    )
  `;
  for (const line of lines) {
    const amount = (Number(line.deltaSupplied) * 1000).toFixed(2);
    await admin`
      insert into measurement_book_lines (
        organisation_id, measurement_book_id, work_id, work_item_id,
        item_number, description, unit_code, payment_category,
        resolved_category, pct_supply, pct_installation, pct_pac,
        pct_final_bill, effective_rate, delta_supplied, amount_supply,
        amount_installation, amount_pac, amount_final_bill, line_total, remark
      )
      values (
        ${organisationId}, ${bookId}, ${workId}, ${line.workItemId},
        ${line.itemNumber}, ${`Item ${line.itemNumber}`}, 'Nos',
        ${line.paymentCategory}, ${line.resolvedCategory}, 100.00, 0.00, 0.00,
        0.00, 1000.00, ${line.deltaSupplied}, ${amount}, 0.00, 0.00, 0.00,
        ${amount}, 'Supply stage billed at 100%.'
      )
    `;
  }
  await admin`
    update measurement_books set
      status = 'finalized', mb_number = ${mbNumber},
      sequence_number = ${sequence}, total_amount = 0.00,
      remark_template_version = 'test', finalized_at = now(),
      finalized_by_user_id = ${ownerUserId}
    where id = ${bookId}
  `;
  return bookId;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-payg-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the payment-category billing tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-payg-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'PAYG Owner');
  office = await signUp(officeEmail, 'PAYG Office');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'PAYG Constructions', slug: `payg-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: officeEmail, role: 'office' },
  });
  expect(added.statusCode, added.body).toBe(201);

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing');
  ownerUserId = ownerUser.id;

  workId = randomUUID();
  scheduleId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`PAYGW-${runId.toUpperCase()}`},
      ${`payg-letter-${runId}`}, '2025-06-01', 'Category freeze fixture work',
      100000.00, 90000.00, 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'B', 'Schedule B', 1)
  `;

  billedItemId = await insertItem('B/1', 'SUPPLY');
  zeroLineItemId = await insertItem('B/2', 'SUPPLY');
  cancelledMbItemId = await insertItem('B/3', 'SUPPLY');
  evidenceOnlyItemId = await insertItem('B/4', null);
  uncategorisedBilledItemId = await insertItem('B/5', null);

  // MB-01: bills B/1 in full and B/5 while uncategorised; B/2 gets the
  // all-zero line a finalised MB writes for every item it did not bill.
  await insertFinalisedMb(`PAYGW-${runId.toUpperCase()}-MB-01`, 1, [
    {
      workItemId: billedItemId,
      itemNumber: 'B/1',
      resolvedCategory: 'SUPPLY',
      paymentCategory: 'SUPPLY',
      deltaSupplied: '10.000',
    },
    {
      workItemId: zeroLineItemId,
      itemNumber: 'B/2',
      resolvedCategory: 'SUPPLY',
      paymentCategory: 'SUPPLY',
      deltaSupplied: '0.000',
    },
    {
      workItemId: uncategorisedBilledItemId,
      itemNumber: 'B/5',
      resolvedCategory: 'UNCATEGORISED',
      paymentCategory: null,
      deltaSupplied: '4.000',
    },
  ]);

  // MB-02 bills B/3 and is then cancelled — a cancelled book releases its
  // billing exactly like every other aggregate in the product.
  const cancelledBookId = await insertFinalisedMb(
    `PAYGW-${runId.toUpperCase()}-MB-02`,
    2,
    [
      {
        workItemId: cancelledMbItemId,
        itemNumber: 'B/3',
        resolvedCategory: 'SUPPLY',
        paymentCategory: 'SUPPLY',
        deltaSupplied: '5.000',
      },
    ],
  );
  await admin`
    update measurement_books set
      status = 'cancelled', cancelled_at = now(),
      cancelled_by_user_id = ${ownerUserId},
      cancellation_note = 'raised against the wrong schedule'
    where id = ${cancelledBookId}
  `;

  // B/4 carries real site evidence — a recorded installation — but has
  // never reached a Measurement Book.
  const locationId = randomUUID();
  await admin`
    insert into location_masters (id, organisation_id, name, kind, created_by_user_id)
    values (${locationId}, ${organisationId}, ${`PAYG Site ${runId}`},
            'installation_point', ${ownerUserId})
  `;
  await admin`
    insert into installations (
      id, organisation_id, work_id, work_item_id, quantity, installed_on,
      location_id, location_name, recorded_by_user_id
    )
    values (
      ${randomUUID()}, ${organisationId}, ${workId}, ${evidenceOnlyItemId},
      6.000, '2025-06-15', ${locationId}, ${`PAYG Site ${runId}`},
      ${ownerUserId}
    )
  `;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  if (storageDir !== undefined) {
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe('G2 — the payment category is frozen once a Measurement Book has billed the item', () => {
  it('refuses the change with a 409 naming the item and the billing Measurement Book', async () => {
    const response = await setCategory(billedItemId, 'SUPPLY_AND_INSTALLATION');
    expect(response.statusCode, response.body).toBe(409);
    const body = response.json<{
      code: string;
      message: string;
      details: {
        workItemId: string;
        itemNumber: string;
        billedMeasurementBooks: { id: string; mbNumber: string | null }[];
      };
    }>();
    expect(body.code).toBe('ITEM_BILLED_IN_MB');
    expect(body.message).toContain('B/1');
    expect(body.message).toContain(`PAYGW-${runId.toUpperCase()}-MB-01`);
    // The operator is told the remedy the product already uses for a
    // wrong finalised bill (ADR-0006 decision 3).
    expect(body.message).toContain('compensating entry');
    expect(body.details.itemNumber).toBe('B/1');
    expect(body.details.billedMeasurementBooks.map((mb) => mb.mbNumber)).toEqual([
      `PAYGW-${runId.toUpperCase()}-MB-01`,
    ]);

    // The refusal left the stored category exactly as billed.
    expect(await storedCategory(billedItemId)).toBe('SUPPLY');
  });

  it('refuses the same change through the payment-setup save', async () => {
    // The bulk route evaluates this guard once over the whole set rather
    // than once per item, which is a different piece of SQL from the one
    // the PATCH above exercises. The refusal has to be the same refusal:
    // the same code, naming the same item and the same Measurement Book,
    // and it has to survive being submitted alongside an item that is
    // perfectly legal to change.
    const refused = await authed(office, {
      method: 'POST',
      url: `/api/works/${workId}/payment-setup`,
      organisationId,
      payload: {
        matrixRows: [],
        itemCategories: [
          { workItemId: evidenceOnlyItemId, paymentCategory: 'SUPPLY' },
          { workItemId: billedItemId, paymentCategory: 'SUPPLY_AND_INSTALLATION' },
        ],
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    const body = refused.json<{
      code: string;
      message: string;
      details: { itemNumber: string };
    }>();
    expect(body.code).toBe('ITEM_BILLED_IN_MB');
    expect(body.message).toContain('B/1');
    expect(body.message).toContain(`PAYGW-${runId.toUpperCase()}-MB-01`);
    expect(body.details.itemNumber).toBe('B/1');

    // The legal half of the request went down with the refused half:
    // one transaction, all of it or none.
    expect(await storedCategory(billedItemId)).toBe('SUPPLY');
    expect(await storedCategory(evidenceOnlyItemId)).toBeNull();
  });

  it('refuses clearing a billed item back to uncategorised', async () => {
    const response = await setCategory(billedItemId, null);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('ITEM_BILLED_IN_MB');
    expect(await storedCategory(billedItemId)).toBe('SUPPLY');
  });

  it('refuses categorising an item that was billed while uncategorised', async () => {
    const response = await setCategory(uncategorisedBilledItemId, 'SUPPLY');
    expect(response.statusCode, response.body).toBe(409);
    const body = response.json<{ code: string; message: string }>();
    expect(body.code).toBe('ITEM_BILLED_IN_MB');
    expect(body.message).toContain('B/5');
    expect(await storedCategory(uncategorisedBilledItemId)).toBeNull();
  });

  it('writes no category-change audit event for a refused edit', async () => {
    const [count] = await admin<{ total: string }[]>`
      select count(*)::text as total from audit_events
      where organisation_id = ${organisationId}
        and entity_type = 'work_items'
        and entity_id = ${billedItemId}
        and action = 'work_item.payment_category_changed'
    `;
    expect(count?.total).toBe('0');
  });

  it('accepts re-submitting the category the billed item already carries', async () => {
    // Not a change, so nothing is re-billed; refusing it would break an
    // idempotent client retry for no gain.
    const response = await setCategory(billedItemId, 'SUPPLY');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ paymentCategory: string | null }>().paymentCategory).toBe(
      'SUPPLY',
    );
  });
});

describe('G2 — corrections the rule must leave alone', () => {
  it('still corrects an item that is installed on site but never billed', async () => {
    // The whole point of the CARE line: evidence is not billing. A
    // mis-categorised item stays freely correctable right up to the
    // Measurement Book that bills it.
    const response = await setCategory(evidenceOnlyItemId, 'SUPPLY_AND_INSTALLATION');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ paymentCategory: string | null }>().paymentCategory).toBe(
      'SUPPLY_AND_INSTALLATION',
    );

    const cleared = await setCategory(evidenceOnlyItemId, null);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(await storedCategory(evidenceOnlyItemId)).toBeNull();
  });

  it('still corrects an item whose only Measurement Book line is the all-zero line', async () => {
    const response = await setCategory(zeroLineItemId, 'PURE_INSTALLATION');
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedCategory(zeroLineItemId)).toBe('PURE_INSTALLATION');
  });

  it('still corrects an item billed only on a cancelled Measurement Book', async () => {
    const response = await setCategory(cancelledMbItemId, 'SPARE_SUPPLY');
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedCategory(cancelledMbItemId)).toBe('SPARE_SUPPLY');
  });

  it('keeps the audit trail on the edits it allows', async () => {
    const events = await admin<
      {
        details: { before?: Record<string, unknown>; after?: Record<string, unknown> };
      }[]
    >`
      select details from audit_events
      where organisation_id = ${organisationId}
        and entity_type = 'work_items'
        and entity_id = ${zeroLineItemId}
        and action = 'work_item.payment_category_changed'
      order by occurred_at, id
    `;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]?.details.after).toMatchObject({
      paymentCategory: 'PURE_INSTALLATION',
    });
  });
});
