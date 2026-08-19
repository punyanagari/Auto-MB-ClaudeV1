import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
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
  // The buyer every seeded tax invoice names: the column is NOT NULL, and
  // the register reads its designation as the row's buyer.
  const buyerContactId = randomUUID();
  await admin`
    insert into contacts (
      id, organisation_id, designation, address, pincode, state_code,
      locality, is_client, is_vendor, active, created_by_user_id
    )
    values (
      ${buyerContactId}, ${organisationId}, ${`Paginated buyer ${runId}`},
      'New Delhi 110001', '110001', '07', 'New Delhi', true, true, true,
      ${ownerUserId}
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
        ${admin.json({ name: 'Sr. DEE (G) NR', address: 'New Delhi' })},
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
          issued_snapshot = ${admin.json({ lines: [] })},
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
    // Issue challans share one challan_date for the same reason the
    // delivery ones do: the register's leading sort key is that date, so
    // a keyset leaning on it alone would stall or repeat here. Issued in
    // place rather than through the route — this fixture is about the
    // keyset, not the numbering.
    await admin`
      insert into issue_challans (
        organisation_id, work_id, challan_date, prefix, movement_type,
        issued_to_name, status, challan_number, sequence_number,
        issued_snapshot, created_by_user_id, issued_by_user_id, issued_at
      )
      values (
        ${organisationId}, ${workId}, '2026-08-05', ${`PGIC${String(index)}`},
        'issue', 'Site team', 'issued',
        ${`PGIC-${codeSuffix}-${String(index)}`}, ${index + 1},
        ${admin.json({ lines: [] })}, ${ownerUserId}, ${ownerUserId}, now()
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
    // DIRECT invoices — no Work, no Measurement Book, a stated taxable
    // value — because that is the row the organisation-wide register was
    // built to reach, and the one whose NULL work_id the keyset and the
    // work-scope predicate both have to survive. They share one
    // invoice_date for the same reason the challans share one date.
    await admin`
      insert into tax_invoices (
        organisation_id, invoice_date, sac_code, service_description,
        gst_rate, place_of_supply, stated_taxable_value, buyer_contact_id,
        created_by_user_id
      )
      values (
        ${organisationId}, '2026-08-04', '998734', 'Paginated supply',
        '18.00', '27', '1000.00', ${buyerContactId}, ${ownerUserId}
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
        ${admin.json({
          kind: 'change_item',
          workItemId: amendmentItemIds[index] as string,
          itemNumber: `A/${String(index + 1)}`,
          changes: { quantity: `${String(index + 1)}.000` },
        })},
        ${admin.json([
          { field: 'quantity', before: '1.000', after: `${String(index + 1)}.000` },
        ] as never)},
        ${`Pagination proof ${String(index)}`}, ${ownerUserId}
      )
    `;
    // The purchase-order register (0109). Raised outside any LOA, which
    // is the shape whose rows have no Work behind them — the register's
    // scope predicate and its cursor predicate both carry a NULL arm the
    // other registers here do not, and this is what pages through it.
    // ISSUED rather than draft: the 0109 partial unique index holds one
    // open draft per vendor in this series, so five drafts on one vendor
    // is the one shape the register cannot be seeded with.
    await admin`
      insert into purchase_orders (
        organisation_id, work_id, vendor_contact_id, status, po_number,
        sequence_number, po_date, vendor_snapshot, total_amount,
        issued_at, issued_by_user_id, created_by_user_id
      )
      values (
        ${organisationId}, null, ${buyerContactId}, 'issued',
        ${`PO-${String(index + 1).padStart(2, '0')}`}, ${index + 1},
        '2026-08-05', ${admin.json({ designation: 'Paginated vendor' })},
        '100.00', now(), ${ownerUserId}, ${ownerUserId}
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

/** Every keyset-paginated register, each named by its route, its array
 * property, and whether the route already carries a query string. */
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
  {
    name: 'the tenant-wide installation register',
    url: () => '/api/installations',
    key: 'installations',
  },
  {
    name: 'the organisation-wide issue-challan register',
    url: () => '/api/issue-challans',
    key: 'issueChallans',
  },
  {
    name: 'the organisation-wide tax-invoice register',
    url: () => '/api/tax-invoices',
    key: 'invoices',
  },
  { name: 'the approvals queue', url: () => '/api/approvals', key: 'approvals' },
  {
    name: 'the per-Work amendment history',
    url: () => `/api/works/${workId}/amendments`,
    key: 'approvals',
  },
  {
    name: 'the organisation-wide purchase-order register',
    url: () => '/api/purchase-orders?basis=organisation',
    key: 'purchaseOrders',
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

describe('a cursor from another Work', () => {
  /*
   * The oracle these tests hold shut: every cursor used to be validated
   * organisation-wide, so a per-Work register answered 200 for another
   * Work's row id and 400 for a nonexistent one — existence disclosed —
   * and the keyset predicate then compared against the foreign row's sort
   * key, so its date and creation instant could be binary-searched without
   * a row of it ever being returned. A cursor is now proven against the
   * SAME predicate the register's rows are: the path Work's work_id on a
   * per-Work list, the caller's work-scope on the approvals queue. The
   * refusal is byte-identical to the nonexistent-id one, which is what
   * makes the two indistinguishable.
   */
  let workBId: string;
  let foreignChallanId: string;
  let foreignSerialId: string;
  let foreignMbEntryId: string;
  let foreignInstallationId: string;
  let foreignApprovalId: string;
  let homeApprovalId: string;
  let scoped: { cookie: string };

  beforeAll(async () => {
    // --- A second Work carrying one row in each register -------------------
    workBId = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${workBId}, ${organisationId}, ${`PGB-${codeSuffix}`}, ${`LB-${runId}`},
        '2026-01-10', 'Foreign-cursor probe work', '100000.00', '90000.00',
        'per_schedule', ${ownerUserId}
      )
    `;
    const scheduleBId = randomUUID();
    await admin`
      insert into work_schedules (
        id, organisation_id, work_id, schedule_code, title, position
      )
      values (${scheduleBId}, ${organisationId}, ${workBId}, 'B', 'Schedule B', 1)
    `;
    const itemBId = randomUUID();
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number,
        description, unit_code, awarded_quantity, effective_rate
      )
      values (
        ${itemBId}, ${organisationId}, ${workBId}, ${scheduleBId}, 'B/1',
        'Foreign item', 'Nos', '1000.000', '100.00'
      )
    `;
    const locationBId = randomUUID();
    await admin`
      insert into location_masters (id, organisation_id, name, kind, created_by_user_id)
      values (
        ${locationBId}, ${organisationId}, ${`Site B ${runId}`}, 'station',
        ${ownerUserId}
      )
    `;
    foreignChallanId = randomUUID();
    await admin`
      insert into delivery_challans (
        id, organisation_id, work_id, challan_date, prefix,
        consignee_snapshot, created_by_user_id
      )
      values (
        ${foreignChallanId}, ${organisationId}, ${workBId}, '2026-08-01', 'PGB',
        ${admin.json({ name: 'Sr. DEE (G) NR', address: 'New Delhi' })},
        ${ownerUserId}
      )
    `;
    const challanItemBId = randomUUID();
    await admin`
      insert into delivery_challan_items (
        id, organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position
      )
      values (
        ${challanItemBId}, ${organisationId}, ${foreignChallanId}, ${workBId},
        ${itemBId}, 'Foreign item', 'Nos', '1.000', '100.00', '100.00', 1
      )
    `;
    await admin`
      update delivery_challans
      set status = 'issued', challan_number = ${`PGB-${codeSuffix}-0`},
          sequence_number = 1, issued_snapshot = ${admin.json({ lines: [] })},
          issued_by_user_id = ${ownerUserId}, issued_at = now()
      where id = ${foreignChallanId}
    `;
    foreignSerialId = randomUUID();
    await admin`
      insert into challan_item_serials (
        id, organisation_id, work_id, delivery_challan_id,
        delivery_challan_item_id, serial_number
      )
      values (
        ${foreignSerialId}, ${organisationId}, ${workBId}, ${foreignChallanId},
        ${challanItemBId}, 'SER-B-000'
      )
    `;
    foreignMbEntryId = randomUUID();
    await admin`
      insert into mb_entries (
        id, organisation_id, work_id, work_item_id, measured_quantity,
        measured_on, recorded_by_user_id
      )
      values (
        ${foreignMbEntryId}, ${organisationId}, ${workBId}, ${itemBId}, '1.000',
        '2026-08-02', ${ownerUserId}
      )
    `;
    foreignInstallationId = randomUUID();
    await admin`
      insert into installations (
        id, organisation_id, work_id, work_item_id, quantity, installed_on,
        location_id, location_name, recorded_by_user_id
      )
      values (
        ${foreignInstallationId}, ${organisationId}, ${workBId}, ${itemBId},
        '1.000', '2026-08-03', ${locationBId}, ${`Site B ${runId}`},
        ${ownerUserId}
      )
    `;
    foreignApprovalId = randomUUID();
    await admin`
      insert into approval_requests (
        id, organisation_id, entity_type, entity_id, work_id, proposed, diff,
        reason, requested_by_user_id
      )
      values (
        ${foreignApprovalId}, ${organisationId}, 'work_item_amendment',
        ${itemBId}, ${workBId},
        ${admin.json({
          kind: 'change_item',
          workItemId: itemBId,
          itemNumber: 'B/1',
          changes: { quantity: '2.000' },
        })},
        ${admin.json([{ field: 'quantity', before: '1.000', after: '2.000' }] as never)},
        'Foreign-cursor probe', ${ownerUserId}
      )
    `;
    const [homeApproval] = await admin<{ id: string }[]>`
      select id from approval_requests where work_id = ${workId} limit 1
    `;
    homeApprovalId = homeApproval?.id ?? '';
    expect(homeApprovalId).toBeTruthy();

    // --- A member narrowed to the first Work only --------------------------
    const scopedEmail = `page-scoped-${runId}@integration.test`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: scopedEmail, password, name: 'Pagination Scoped' },
    });
    expect(signUp.statusCode, signUp.body).toBe(200);
    scoped = { cookie: extractCookies(signUp.headers['set-cookie']) };
    const [scopedRow] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${scopedEmail}
    `;
    const scopedUserId = scopedRow?.id ?? '';
    expect(scopedUserId).toBeTruthy();
    await admin`
      insert into organisation_memberships (
        id, organisation_id, user_id, role, work_scope,
        can_issue_documents, can_cancel_documents, can_approve_amendments, status
      )
      values (
        ${randomUUID()}, ${organisationId}, ${scopedUserId}, 'office', 'assigned',
        false, false, false, 'active'
      )
    `;
    await admin`
      insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
      values (${organisationId}, ${workId}, ${scopedUserId}, ${ownerUserId})
    `;
  });

  /** The per-Work registers, each with the other Work's row in the same
   * table. The prober is the OWNER, whose scope covers both Works — what
   * is being proven is that the cursor is bound to the Work in the path,
   * not merely to what the caller may reach. */
  const PER_WORK_CASES = [
    {
      name: 'the Work challan register',
      url: () => `/api/works/${workId}/challans`,
      key: 'challans',
      foreignId: () => foreignChallanId,
    },
    {
      name: 'the serial register',
      url: () => `/api/works/${workId}/serials`,
      key: 'serials',
      foreignId: () => foreignSerialId,
    },
    {
      name: 'the site-measurement register',
      url: () => `/api/works/${workId}/mb-entries`,
      key: 'entries',
      foreignId: () => foreignMbEntryId,
    },
    {
      name: 'the installation register',
      url: () => `/api/works/${workId}/installations`,
      key: 'installations',
      foreignId: () => foreignInstallationId,
    },
    {
      name: 'the per-Work amendment history',
      url: () => `/api/works/${workId}/amendments`,
      key: 'approvals',
      foreignId: () => foreignApprovalId,
    },
  ] as const;

  describe.each(PER_WORK_CASES)('$name', ({ url, key, foreignId }) => {
    it('accepts a cursor naming a row of this Work', async () => {
      const first = await readPage(`${url()}?limit=1`, key);
      expect(first.nextCursor).not.toBeNull();
      const second = await readPage(
        `${url()}?limit=1&cursor=${first.nextCursor ?? ''}`,
        key,
      );
      expect(second.ids).toHaveLength(1);
    });

    it("refuses another Work's row id exactly like a nonexistent one", async () => {
      const foreign = await authed(owner, {
        method: 'GET',
        url: `${url()}?limit=1&cursor=${foreignId()}`,
      });
      const nonexistent = await authed(owner, {
        method: 'GET',
        url: `${url()}?limit=1&cursor=${randomUUID()}`,
      });

      expect(foreign.statusCode, foreign.body).toBe(400);
      // Indistinguishable: same status, same code, same sentence (the
      // requestId differs per request, so the envelope is compared
      // without it).
      const strip = ({ requestId: _, ...rest }: Record<string, unknown>) => rest;
      expect(strip(foreign.json())).toEqual(strip(nonexistent.json()));
      expect(foreign.json<{ code: string }>().code).toBe('CURSOR_INVALID');
    });
  });

  describe('the approvals queue', () => {
    it("refuses an assigned-scoped member's forbidden cursor exactly like a nonexistent one", async () => {
      const forbidden = await authed(scoped, {
        method: 'GET',
        url: `/api/approvals?limit=1&cursor=${foreignApprovalId}`,
      });
      const nonexistent = await authed(scoped, {
        method: 'GET',
        url: `/api/approvals?limit=1&cursor=${randomUUID()}`,
      });

      expect(forbidden.statusCode, forbidden.body).toBe(400);
      const strip = ({ requestId: _, ...rest }: Record<string, unknown>) => rest;
      expect(strip(forbidden.json())).toEqual(strip(nonexistent.json()));
      expect(forbidden.json<{ code: string }>().code).toBe('CURSOR_INVALID');
    });

    it('accepts the same member paging within their own scope', async () => {
      const response = await authed(scoped, {
        method: 'GET',
        url: `/api/approvals?limit=1&cursor=${homeApprovalId}`,
      });
      expect(response.statusCode, response.body).toBe(200);
    });

    it('accepts a full-scope caller paging across Works', async () => {
      // The queue reads across Works, so for a full-scope member the
      // other Work's request IS a row of this register — the work-bound
      // rule of the per-Work lists must not leak into it.
      const response = await authed(owner, {
        method: 'GET',
        url: `/api/approvals?limit=1&cursor=${foreignApprovalId}`,
      });
      expect(response.statusCode, response.body).toBe(200);
    });
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
          ${admin.json({ probe: occurredAt })}, ${occurredAt}::timestamptz
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
