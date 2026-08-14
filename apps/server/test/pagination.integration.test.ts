import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  ensureClusterRoles,
  jsonb,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Pack P12: keyset pagination on the six largest registers.
 *
 * Each register is proved the same way, because they answer one contract
 * (`packages/contracts/src/pagination.ts`):
 *
 *  1. a request with NO `limit` answers with every row and a null cursor —
 *     the compatibility rule, and the reason six screens could be
 *     paginated without touching a view;
 *  2. walking the register one row at a time with `limit` and `cursor`
 *     visits every row exactly once, in the same order the unpaginated
 *     read used, and ends with a null cursor;
 *  3. a cursor naming no row is refused 400 CURSOR_INVALID rather than
 *     silently answering an empty page.
 *
 * (2) is the assertion that matters. A keyset predicate that disagrees
 * with its ORDER BY — the easy mistake, and the reason three of these
 * routes had their trailing tie-break turned around — loses or repeats
 * rows at exactly the page boundary, which a "does it return a page" test
 * never sees. Walking with `limit=1` makes every row a boundary.
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
/** Work codes are capitals, digits and `/-_` only (0001_core). */
const codeSuffix = runId.toUpperCase();
const ownerEmail = `page-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** Rows seeded per register. Enough that a one-row walk crosses several
 * boundaries, and that ties exist on the leading sort key. */
const ROWS = 5;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let workId: string;
let itemId: string;
let amendmentItemIds: string[] = [];
let owner: { cookie: string };

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

async function authed(jar: { cookie: string }, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: {
      ...(options.headers ?? {}),
      cookie: jar.cookie,
      'x-organisation-id': organisationId,
    },
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-pagination-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-pagination-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: ownerEmail, password, name: 'Pagination Owner' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  owner = { cookie: extractCookies(signUp.headers['set-cookie']) };

  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie: owner.cookie },
    payload: { name: 'Pagination Constructions', slug: `pagination-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const [ownerRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  ownerUserId = ownerRow?.id ?? '';
  expect(ownerUserId).toBeTruthy();

  // --- One Work, one item, and five rows in each register ------------------
  workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`PG-${codeSuffix}`}, ${`L-${runId}`},
      '2026-01-10', 'Pagination proof work', '100000.00', '90000.00',
      'per_schedule', ${ownerUserId}
    )
  `;
  const scheduleId = randomUUID();
  await admin`
    insert into work_schedules (
      id, organisation_id, work_id, schedule_code, title, position
    )
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  // One item per seeded approval: only ONE amendment may be pending
  // against an item at a time (`approval_requests_one_pending_per_entity`),
  // so a queue of five proposals is five items. The first also carries the
  // serials, measurements and installations.
  amendmentItemIds = Array.from({ length: ROWS }, () => randomUUID());
  itemId = amendmentItemIds[0] as string;
  for (const [position, id] of amendmentItemIds.entries()) {
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number,
        description, unit_code, awarded_quantity, effective_rate
      )
      values (
        ${id}, ${organisationId}, ${workId}, ${scheduleId},
        ${`A/${String(position + 1)}`},
        'Paginated item', 'Nos', '1000.000', '100.00'
      )
    `;
  }
  const locationId = randomUUID();
  await admin`
    insert into location_masters (id, organisation_id, name, kind, created_by_user_id)
    values (
      ${locationId}, ${organisationId}, ${`Site ${runId}`}, 'station', ${ownerUserId}
    )
  `;

  for (let index = 0; index < ROWS; index += 1) {
    const challanId = randomUUID();
    // Every challan shares one challan_date on purpose: the register's
    // leading sort key is that date, so a keyset that leans on it alone
    // would stall or repeat here.
    // Drafted, lined, then issued — in that order, because lines are
    // mutable only while a challan is draft (0001_core) and a Work may
    // hold only one open draft at a time, which is the rule the register
    // exists to make visible.
    await admin`
      insert into delivery_challans (
        id, organisation_id, work_id, challan_date, prefix,
        consignee_snapshot, created_by_user_id
      )
      values (
        ${challanId}, ${organisationId}, ${workId}, '2026-08-01',
        ${`PG${String(index)}`},
        ${jsonb(admin, { name: 'Sr. DEE (G) NR', address: 'New Delhi' })},
        ${ownerUserId}
      )
    `;
    const challanItemId = randomUUID();
    await admin`
      insert into delivery_challan_items (
        id, organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position
      )
      values (
        ${challanItemId}, ${organisationId}, ${challanId}, ${workId}, ${itemId},
        'Paginated item', 'Nos', '1.000', '100.00', '100.00', 1
      )
    `;
    await admin`
      update delivery_challans
      set status = 'issued',
          challan_number = ${`PG-${codeSuffix}-${String(index)}`},
          sequence_number = ${index + 1},
          issued_snapshot = ${jsonb(admin, { lines: [] })},
          issued_by_user_id = ${ownerUserId}, issued_at = now()
      where id = ${challanId}
    `;
    await admin`
      insert into challan_item_serials (
        organisation_id, work_id, delivery_challan_id,
        delivery_challan_item_id, serial_number
      )
      values (
        ${organisationId}, ${workId}, ${challanId}, ${challanItemId},
        ${`SER-${String(index).padStart(3, '0')}`}
      )
    `;
    await admin`
      insert into mb_entries (
        organisation_id, work_id, work_item_id, measured_quantity,
        measured_on, recorded_by_user_id
      )
      values (
        ${organisationId}, ${workId}, ${itemId}, '1.000', '2026-08-02',
        ${ownerUserId}
      )
    `;
    await admin`
      insert into installations (
        organisation_id, work_id, work_item_id, quantity, installed_on,
        location_id, location_name, recorded_by_user_id
      )
      values (
        ${organisationId}, ${workId}, ${itemId}, '1.000', '2026-08-03',
        ${locationId}, ${`Site ${runId}`}, ${ownerUserId}
      )
    `;
    await admin`
      insert into approval_requests (
        organisation_id, entity_type, entity_id, work_id, proposed, diff,
        reason, requested_by_user_id
      )
      values (
        ${organisationId}, 'work_item_amendment',
        ${amendmentItemIds[index] as string}, ${workId},
        ${jsonb(admin, {
          kind: 'change_item',
          workItemId: amendmentItemIds[index] as string,
          itemNumber: `A/${String(index + 1)}`,
          changes: { quantity: `${String(index + 1)}.000` },
        })},
        ${jsonb(admin, [
          { field: 'quantity', before: '1.000', after: `${String(index + 1)}.000` },
        ])},
        ${`Pagination proof ${String(index)}`}, ${ownerUserId}
      )
    `;
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (organisationId) await removeOrganisationResidue(admin, [organisationId]);
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

interface Page {
  readonly ids: readonly string[];
  readonly nextCursor: string | null;
}

/** Reads one page and normalises it to ids plus the cursor. */
async function readPage(url: string, arrayKey: string): Promise<Page> {
  const response = await authed(owner, { method: 'GET', url });
  expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
  const body = response.json<Record<string, unknown>>();
  const rows = body[arrayKey] as readonly { id: string }[];
  expect(Array.isArray(rows), `${url} has no ${arrayKey} array`).toBe(true);
  return {
    ids: rows.map((row) => row.id),
    nextCursor: body['nextCursor'] as string | null,
  };
}

/** The six registers, each named by its route, its array property, and
 * whether the route already carries a query string. */
const REGISTERS = [
  {
    name: 'the Work challan register',
    url: () => `/api/works/${workId}/challans`,
    key: 'challans',
  },
  {
    name: 'the delivery-challan register',
    url: () => '/api/delivery-challans',
    key: 'challans',
  },
  {
    name: 'the serial register',
    url: () => `/api/works/${workId}/serials`,
    key: 'serials',
  },
  {
    name: 'the site-measurement register',
    url: () => `/api/works/${workId}/mb-entries`,
    key: 'entries',
  },
  {
    name: 'the installation register',
    url: () => `/api/works/${workId}/installations`,
    key: 'installations',
  },
  { name: 'the approvals queue', url: () => '/api/approvals', key: 'approvals' },
  {
    name: 'the per-Work amendment history',
    url: () => `/api/works/${workId}/amendments`,
    key: 'approvals',
  },
] as const;

describe.each(REGISTERS)('$name', ({ url, key }) => {
  it('answers an unpaginated request with the whole register', async () => {
    const page = await readPage(url(), key);

    expect(page.ids).toHaveLength(ROWS);
    expect(page.nextCursor).toBeNull();
  });

  it('walks every row exactly once, in the unpaginated order', async () => {
    const whole = await readPage(url(), key);
    const separator = url().includes('?') ? '&' : '?';

    const walked: string[] = [];
    let cursor: string | null = null;
    // Bounded so a cursor that fails to advance fails the assertion below
    // rather than looping forever.
    for (let step = 0; step <= ROWS; step += 1) {
      const query = cursor === null ? 'limit=1' : `limit=1&cursor=${cursor}`;
      const page: Page = await readPage(`${url()}${separator}${query}`, key);
      if (page.ids.length === 0) break;
      expect(page.ids).toHaveLength(1);
      walked.push(page.ids[0] as string);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(walked).toEqual(whole.ids);
    expect(cursor).toBeNull();
  });

  it('answers a page larger than the register with a null cursor', async () => {
    const separator = url().includes('?') ? '&' : '?';
    const page = await readPage(`${url()}${separator}limit=${String(ROWS + 1)}`, key);

    expect(page.ids).toHaveLength(ROWS);
    expect(page.nextCursor).toBeNull();
  });

  it('refuses a cursor that names no row', async () => {
    const separator = url().includes('?') ? '&' : '?';
    const response = await authed(owner, {
      method: 'GET',
      url: `${url()}${separator}limit=1&cursor=${randomUUID()}`,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('CURSOR_INVALID');
  });

  it('refuses a page size beyond the declared maximum', async () => {
    const separator = url().includes('?') ? '&' : '?';
    const response = await authed(owner, {
      method: 'GET',
      url: `${url()}${separator}limit=201`,
    });

    expect(response.statusCode, response.body).toBe(400);
  });
});

describe('the approvals queue', () => {
  it('pages within a filter rather than across it', async () => {
    // The queue's own `status` filter and the pagination query compose:
    // a page of pending requests must be a page OF THE PENDING ONES, not
    // a page of everything that happens to be pending.
    const first = await readPage('/api/approvals?status=pending&limit=2', 'approvals');
    expect(first.ids).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await readPage(
      `/api/approvals?status=pending&limit=2&cursor=${first.nextCursor ?? ''}`,
      'approvals',
    );
    expect(second.ids).toHaveLength(2);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(4);

    const decided = await readPage('/api/approvals?status=approved', 'approvals');
    expect(decided.ids).toHaveLength(0);
  });
});

describe('a cursor within one millisecond', () => {
  /*
   * The standing guard for what this pack measured while building the six
   * registers: a cursor's timestamp does not reliably survive being sent
   * back as a parameter. Read out as `.527771`, it reached the server as
   * `.527` — the driver re-encodes a parameter it types as `timestamptz`
   * through a JavaScript Date. On an ascending register that repeats a
   * row forever, which is how it was found. On a DESCENDING one it skips:
   * rows sharing the cursor's millisecond and preceding it vanish from
   * the next page, and the answer looks perfectly ordinary.
   *
   * The audit trail is the descending one, and it did NOT lose them in
   * the shape it shipped in — this test passes against that shape too.
   * That is why it is here rather than in a fix commit: every cursor in
   * the tree now reads its position inside the comparing statement, and
   * this is what keeps a future one from going back to sending the value.
   * The events are written four microseconds apart inside ONE
   * millisecond, which is the spacing a burst of writes in a single
   * request produces.
   */
  const stamps = [
    '2026-08-05 09:00:00.123001+00',
    '2026-08-05 09:00:00.123002+00',
    '2026-08-05 09:00:00.123003+00',
    '2026-08-05 09:00:00.123004+00',
  ];

  beforeAll(async () => {
    for (const occurredAt of stamps) {
      await admin`
        insert into audit_events (
          organisation_id, actor_user_id, action, entity_type, entity_id,
          details, occurred_at
        )
        values (
          ${organisationId}, ${ownerUserId}, 'work.updated', 'works', ${workId},
          ${jsonb(admin, { probe: occurredAt })}, ${occurredAt}::timestamptz
        )
      `;
    }
  });

  it('walks a descending trail without skipping rows inside the millisecond', async () => {
    const whole = await readPage(`/api/works/${workId}/timeline`, 'events');
    expect(whole.ids.length).toBeGreaterThanOrEqual(stamps.length);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let step = 0; step <= whole.ids.length; step += 1) {
      const query = cursor === null ? 'limit=1' : `limit=1&cursor=${cursor}`;
      const page: Page = await readPage(
        `/api/works/${workId}/timeline?${query}`,
        'events',
      );
      if (page.ids.length === 0) break;
      walked.push(page.ids[0] as string);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(walked).toEqual(whole.ids);
  });
});
