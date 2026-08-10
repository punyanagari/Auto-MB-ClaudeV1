import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  PurchaseOrderDetailResponse,
  PurchaseOrderListResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Purchase-order lifecycle against real PostgreSQL (migration 0033):
 * draft -> issued (gapless `<work_code>-PO-NN` under the counter row
 * lock, vendor snapshotted) -> closed once every line has been received
 * against ISSUED delivery challans, or cancelled with a note.
 *
 * The receipt link (`delivery_challan_items.purchase_order_line_id`) is
 * written here with admin SQL: the challan editor that will offer open
 * orders belongs to the web slice, and this test proves the balance the
 * route derives from that column, not the editor.
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
const ownerEmail = `po-owner-${runId}@integration.test`;
const clerkEmail = `po-clerk-${runId}@integration.test`;
const viewerEmail = `po-viewer-${runId}@integration.test`;
const outsiderEmail = `po-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let workId: string;
let workCode: string;
let itemAId: string;
let itemBId: string;
let vendorId: string;
let notVendorId: string;
let retiredVendorId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;
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

/** A throwaway Work with one item, so numbering and concurrency can be
 * proven without disturbing the fixture Work's single draft slot. */
async function freshWork(
  label: string,
): Promise<{ workId: string; workCode: string; itemId: string }> {
  const id = randomUUID();
  const scheduleId = randomUUID();
  const itemId = randomUUID();
  const code = `PO${label}-${runId.toUpperCase()}`;
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${id}, ${organisationId}, ${code}, ${`po-${label}-letter-${runId}`},
      '2025-06-01', ${`Purchase order ${label} work`},
      1000.00, 900.00, 'per_schedule', null, null, ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${id}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate
    )
    values (${itemId}, ${organisationId}, ${id}, ${scheduleId}, 'A/1',
            ${`Item for ${label}`}, 'Nos', 50.000, 100.00)
  `;
  return { workId: id, workCode: code, itemId };
}

const CONSUMABLE_LINE = {
  description: 'Consumable pack',
  unitCode: 'Nos',
  quantity: '1',
  rate: '10',
};

/** Creates a draft order carrying one consumable line, ready to issue. */
async function draftReadyToIssue(targetWorkId: string): Promise<string> {
  const created = await authed(owner, {
    method: 'POST',
    url: `/api/works/${targetWorkId}/purchase-orders`,
    organisationId,
    payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
  const lines = await authed(owner, {
    method: 'PUT',
    url: `/api/purchase-orders/${id}/lines`,
    organisationId,
    payload: { lines: [CONSUMABLE_LINE] },
  });
  expect(lines.statusCode, lines.body).toBe(200);
  return id;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-po-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the purchase-order integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  const escapedPassword = appPassword.replaceAll("'", "''");
  await admin.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
        CREATE ROLE auto_mb_app LOGIN PASSWORD '${escapedPassword}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END
    $$;
  `);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-po-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'PO Owner');
  clerk = await signUp(clerkEmail, 'PO Clerk');
  viewer = await signUp(viewerEmail, 'PO Viewer');
  outsider = await signUp(outsiderEmail, 'PO Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'PO Constructions', slug: `po-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  // A second tenant, so cross-tenant reads can be proven with a caller
  // who legitimately holds a membership somewhere.
  const otherOrg = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Rival Constructions', slug: `po-rival-${runId}` },
  });
  expect(otherOrg.statusCode, otherOrg.body).toBe(201);
  outsiderOrganisationId = otherOrg.json<{ id: string }>().id;

  for (const [email, role] of [
    [clerkEmail, 'office'],
    [viewerEmail, 'viewer'],
  ] as const) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role },
    });
    expect(added.statusCode, added.body).toBe(201);
  }

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing');
  ownerUserId = ownerUser.id;

  // Issue/cancel are explicit authorities, granted to the owner only: the
  // clerk keeps drafting rights without either authority.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  // Vendor contacts. `is_vendor` has been a dormant column since 0028 and
  // no route sets it yet, so the fixtures are written directly.
  vendorId = randomUUID();
  notVendorId = randomUUID();
  retiredVendorId = randomUUID();
  await admin`
    insert into contacts (
      id, organisation_id, designation, contact_person, address, phone, email,
      gstin, pincode, state_code, is_consignee, is_vendor, active,
      created_by_user_id
    )
    values
      (${vendorId}, ${organisationId}, ${`Bharat Cables Pvt Ltd ${runId}`},
       'R. Nair', 'Plot 12, MIDC, Pune', '02012345678', 'sales@bharat.example',
       '27AABCB1234C1ZP', '411019', '27', false, true, true, ${ownerUserId}),
      (${notVendorId}, ${organisationId}, ${`Sr. DEE (G) NR ${runId}`},
       null, 'Delhi Division, New Delhi', null, null, null, null, '07',
       true, false, true, ${ownerUserId}),
      (${retiredVendorId}, ${organisationId}, ${`Closed Traders ${runId}`},
       null, 'Old Market, Nagpur', null, null, null, null, '27',
       false, true, false, ${ownerUserId})
  `;

  // Fixture Work: item A carries the 0033 tax facts, item B carries none.
  workId = randomUUID();
  workCode = `POW-${runId.toUpperCase()}`;
  const scheduleId = randomUUID();
  itemAId = randomUUID();
  itemBId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${workCode}, ${`po-letter-${runId}`},
      '2025-06-01', 'Purchase order fixture work',
      1000.00, 900.00, 'per_schedule', null, null, ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, hsn_code, gst_rate
    )
    values
      (${itemAId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Copper cable 240 sq mm', 'Mtr', 10.000, 100.00, '854449', 18.00),
      (${itemBId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Junction box', 'Nos', 4.000, 250.50, null, null)
  `;
}, 60_000);

afterAll(async () => {
  if (admin) {
    for (const org of [organisationId, outsiderOrganisationId]) {
      if (!org) continue;
      // The immutability triggers (rightly) block deleting issued rows;
      // fixture cleanup is exactly what session_replication_role exists
      // for.
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'purchase_order_lines',
          'purchase_orders',
          'purchase_order_counters',
          'work_items',
          'work_schedules',
          'works',
          'contacts',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [org],
          );
        }
      } finally {
        await admin.unsafe(`set session_replication_role = 'origin'`);
      }
    }
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
  }
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('Purchase order lifecycle', () => {
  let purchaseOrderId: string;
  let lineOneId: string;
  let lineTwoId: string;

  it('refuses a vendor that is not a vendor, is retired, or does not exist', async () => {
    const cases: [string, number, string][] = [
      [notVendorId, 409, 'CONTACT_NOT_VENDOR'],
      [retiredVendorId, 409, 'CONTACT_RETIRED'],
      [randomUUID(), 404, 'VENDOR_NOT_FOUND'],
    ];
    for (const [contactId, status, code] of cases) {
      const response = await authed(owner, {
        method: 'POST',
        url: `/api/works/${workId}/purchase-orders`,
        organisationId,
        payload: { vendorContactId: contactId, poDate: '2026-08-08' },
      });
      expect(response.statusCode, `${code}: ${response.body}`).toBe(status);
      expect(response.json()).toMatchObject({ code });
    }
    // Nothing was written on the way to any of those refusals.
    const [drafts] = await admin<{ total: string }[]>`
      select count(*)::text as total from purchase_orders where work_id = ${workId}
    `;
    expect(drafts?.total).toBe('0');
  });

  it('rejects order dates outside the product-contract window', async () => {
    for (const poDate of ['2031-01-01', '2025-05-31']) {
      const response = await authed(owner, {
        method: 'POST',
        url: `/api/works/${workId}/purchase-orders`,
        organisationId,
        payload: { vendorContactId: vendorId, poDate },
      });
      expect(response.statusCode, `${poDate}: ${response.body}`).toBe(400);
      expect(response.json()).toMatchObject({ code: 'PO_DATE_INVALID' });
    }
  });

  it('drafts an order on the vendor, carrying no number and no snapshot', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/purchase-orders`,
      organisationId,
      payload: {
        vendorContactId: vendorId,
        poDate: '2026-08-08',
        expectedOn: '2026-09-15',
        terms: '  30 days credit; delivery at site.  ',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<PurchaseOrderDetailResponse>();
    purchaseOrderId = detail.purchaseOrder.id;
    expect(detail.purchaseOrder).toMatchObject({
      workId,
      status: 'draft',
      poNumber: null,
      sequenceNumber: null,
      totalAmount: null,
      poDate: '2026-08-08',
      expectedOn: '2026-09-15',
      // Stored trimmed, exactly as the column's CHECK measures it.
      terms: '30 days credit; delivery at site.',
      vendorDesignation: `Bharat Cables Pvt Ltd ${runId}`,
    });
    expect(detail.lines).toEqual([]);
    expect(detail.vendorSnapshot).toBeNull();
    expect(detail.previewTotal).toBe('0.00');
  });

  it('enforces one draft per Work, naming the existing draft in the 409', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/purchase-orders`,
      organisationId,
      payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'PO_DRAFT_EXISTS',
      details: { existingRecordId: purchaseOrderId },
    });
  });

  it('refuses line edits to read-only roles and accepts them from office', async () => {
    const denied = await authed(viewer, {
      method: 'PUT',
      url: `/api/purchase-orders/${purchaseOrderId}/lines`,
      organisationId,
      payload: { lines: [CONSUMABLE_LINE] },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });

    const saved = await authed(clerk, {
      method: 'PUT',
      url: `/api/purchase-orders/${purchaseOrderId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            workItemId: itemAId,
            description: 'Copper cable 240 sq mm, ISI marked',
            unitCode: 'Mtr',
            quantity: '6',
            rate: '100',
          },
          {
            description: 'Cable lugs and glands',
            hsnCode: '732690',
            unitCode: 'Set',
            quantity: '2.5',
            rate: '40',
            gstRate: '12',
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const detail = saved.json<PurchaseOrderDetailResponse>();
    expect(detail.lines).toHaveLength(2);
    lineOneId = detail.lines[0]?.id ?? '';
    lineTwoId = detail.lines[1]?.id ?? '';
    // Line 1 inherits the Work item's tax facts (migration 0033), which is
    // what the invoice slice will read.
    expect(detail.lines[0]).toMatchObject({
      lineNumber: 1,
      workItemId: itemAId,
      hsnCode: '854449',
      gstRate: '18.00',
      quantity: '6.000',
      rate: '100.00',
      lineAmount: '600.00',
      receivedQuantity: '0.000',
      pendingQuantity: '6.000',
    });
    // Line 2 is a consumable the LOA never named: no item link, and its
    // own tax facts.
    expect(detail.lines[1]).toMatchObject({
      lineNumber: 2,
      workItemId: null,
      hsnCode: '732690',
      gstRate: '12.00',
      quantity: '2.500',
      lineAmount: '100.00',
      pendingQuantity: '2.500',
    });
    // Money summed server-side as exact decimals; still no total on the
    // record itself, which is issue-written.
    expect(detail.previewTotal).toBe('700.00');
    expect(detail.purchaseOrder.totalAmount).toBeNull();
  });

  it('refuses a line naming an item of another Work, writing nothing', async () => {
    const other = await freshWork('X');
    const response = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${purchaseOrderId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            workItemId: other.itemId,
            description: 'Item from a different Work',
            unitCode: 'Nos',
            quantity: '1',
            rate: '5',
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
    // The replacement rolled back whole: the saved lines are untouched.
    const reread = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
    });
    expect(reread.json<PurchaseOrderDetailResponse>().lines).toHaveLength(2);
  });

  it('requires explicit issue authority', async () => {
    const response = await authed(clerk, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/issue`,
      organisationId,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });
  });

  it('issues with a gapless number, a vendor snapshot, and a frozen total', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/issue`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<PurchaseOrderDetailResponse>();
    expect(detail.purchaseOrder).toMatchObject({
      status: 'issued',
      poNumber: `${workCode}-PO-01`,
      sequenceNumber: 1,
      totalAmount: '700.00',
    });
    expect(detail.purchaseOrder.issuedAt).not.toBeNull();
    expect(detail.previewTotal).toBe('700.00');
    expect(detail.vendorSnapshot).toMatchObject({
      contactId: vendorId,
      designation: `Bharat Cables Pvt Ltd ${runId}`,
      gstin: '27AABCB1234C1ZP',
      stateCode: '27',
      address: 'Plot 12, MIDC, Pune',
    });
  });

  it('keeps the issued order immutable through the API and in the database', async () => {
    const header = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
      payload: { vendorContactId: vendorId, poDate: '2026-08-09' },
    });
    expect(header.statusCode).toBe(409);
    expect(header.json()).toMatchObject({ code: 'PO_STATUS_CONFLICT' });

    const lines = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${purchaseOrderId}/lines`,
      organisationId,
      payload: { lines: [CONSUMABLE_LINE] },
    });
    expect(lines.statusCode).toBe(409);
    expect(lines.json()).toMatchObject({ code: 'PO_STATUS_CONFLICT' });

    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(409);

    // …and the 0033 trigger holds the same rule against raw SQL.
    await expect(
      admin`
        insert into purchase_order_lines (
          organisation_id, purchase_order_id, line_number, description,
          unit_code, quantity, rate, line_amount
        )
        values (
          ${organisationId}, ${purchaseOrderId}, 99, 'Sneaked in after issue',
          'Nos', 1, 1, 1
        )
      `,
    ).rejects.toThrowError(/lines are fixed once it is issued/);

    // The vendor master may still be edited; the issued document does not
    // change, because it reads its own snapshot (rule 7).
    await admin`
      update contacts set designation = ${`Bharat Cables (renamed) ${runId}`}
      where id = ${vendorId}
    `;
    const reread = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
    });
    expect(
      reread.json<PurchaseOrderDetailResponse>().purchaseOrder.vendorDesignation,
    ).toBe(`Bharat Cables Pvt Ltd ${runId}`);
    await admin`
      update contacts set designation = ${`Bharat Cables Pvt Ltd ${runId}`}
      where id = ${vendorId}
    `;
  });

  it('offers the issued order to a challan editor as an open order', async () => {
    const response = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/purchase-orders?status=open`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const list = response.json<PurchaseOrderListResponse>();
    expect(list.purchaseOrders.map((order) => order.id)).toEqual([purchaseOrderId]);
    expect(list.purchaseOrders[0]?.poNumber).toBe(`${workCode}-PO-01`);
  });

  it('refuses to close an order whose lines are still owed material', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/close`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(409);
    const body = response.json<{
      code: string;
      details: {
        outstandingLines: {
          purchaseOrderLineId: string;
          pendingQuantity: string;
          receivedQuantity: string;
        }[];
      };
    }>();
    expect(body.code).toBe('PO_NOT_FULLY_RECEIVED');
    expect(body.details.outstandingLines).toHaveLength(2);
    expect(body.details.outstandingLines[0]).toMatchObject({
      purchaseOrderLineId: lineOneId,
      orderedQuantity: '6.000',
      receivedQuantity: '0.000',
      pendingQuantity: '6.000',
    });
  });

  /** Records a delivery challan for the fixture Work and points its lines
   * at the purchase order lines they fulfil. The link column is written
   * with admin SQL — see the file header. */
  async function receive(
    items: { workItemId: string; quantity: string; purchaseOrderLineId: string }[],
    options: { issue: boolean } = { issue: true },
  ): Promise<string> {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-09',
        prefix: `POR${runId.slice(0, 3).toUpperCase()}`,
        consignee: { name: 'Site store', address: 'Site stores, Pune' },
        items: items.map((item) => ({
          workItemId: item.workItemId,
          quantity: item.quantity,
        })),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const challan = created.json<ChallanDetailResponse>();
    for (const item of items) {
      await admin`
        update delivery_challan_items
        set purchase_order_line_id = ${item.purchaseOrderLineId}
        where delivery_challan_id = ${challan.challan.id}
          and work_item_id = ${item.workItemId}
      `;
    }
    if (options.issue) {
      const issued = await authed(owner, {
        method: 'POST',
        url: `/api/challans/${challan.challan.id}/issue`,
        organisationId,
      });
      expect(issued.statusCode, issued.body).toBe(201);
    }
    return challan.challan.id;
  }

  let secondChallanId: string;

  it('counts only issued challans towards the received balance', async () => {
    const draftChallanId = await receive(
      [{ workItemId: itemAId, quantity: '6', purchaseOrderLineId: lineOneId }],
      { issue: false },
    );
    const whileDraft = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
    });
    // A draft challan has delivered nothing.
    expect(whileDraft.json<PurchaseOrderDetailResponse>().lines[0]).toMatchObject({
      receivedQuantity: '0.000',
      pendingQuantity: '6.000',
    });

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftChallanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const afterIssue = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
    });
    const detail = afterIssue.json<PurchaseOrderDetailResponse>();
    expect(detail.lines[0]).toMatchObject({
      receivedQuantity: '6.000',
      pendingQuantity: '0.000',
    });
    expect(detail.lines[1]).toMatchObject({
      receivedQuantity: '0.000',
      pendingQuantity: '2.500',
    });
  });

  it('sums receipts across challans and names only the line still open', async () => {
    await receive([
      { workItemId: itemBId, quantity: '1', purchaseOrderLineId: lineTwoId },
    ]);
    const partial = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/close`,
      organisationId,
    });
    expect(partial.statusCode).toBe(409);
    const details = partial.json<{
      details: { outstandingLines: { purchaseOrderLineId: string }[] };
    }>().details;
    expect(details.outstandingLines).toHaveLength(1);
    expect(details.outstandingLines[0]).toMatchObject({
      purchaseOrderLineId: lineTwoId,
      receivedQuantity: '1.000',
      pendingQuantity: '1.500',
    });

    secondChallanId = await receive([
      { workItemId: itemBId, quantity: '1.5', purchaseOrderLineId: lineTwoId },
    ]);
  });

  it('closes once every line has been fully received', async () => {
    const closed = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/close`,
      organisationId,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const detail = closed.json<PurchaseOrderDetailResponse>();
    expect(detail.purchaseOrder.status).toBe('closed');
    expect(detail.purchaseOrder.closedAt).not.toBeNull();
    // The number and the total survive the transition untouched.
    expect(detail.purchaseOrder.poNumber).toBe(`${workCode}-PO-01`);
    expect(detail.purchaseOrder.totalAmount).toBe('700.00');
    expect(detail.lines.map((line) => line.pendingQuantity)).toEqual([
      '0.000',
      '0.000',
    ]);

    // A closed order is no longer offered to the challan editor, and a
    // second close is refused.
    const open = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/purchase-orders?status=open`,
      organisationId,
    });
    expect(open.json<PurchaseOrderListResponse>().purchaseOrders).toEqual([]);
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/close`,
      organisationId,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'PO_STATUS_CONFLICT' });
  });

  it('shows the balance live, so a released receipt reappears as pending', async () => {
    // Cancelling the challan that fed line 2 gives the material back; the
    // closed order keeps its recorded transition, and the derived balance
    // tells the truth of now rather than of the day it was closed.
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${secondChallanId}/cancel`,
      organisationId,
      payload: { note: 'Material returned to the vendor as defective.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
    });
    const body = detail.json<PurchaseOrderDetailResponse>();
    expect(body.purchaseOrder.status).toBe('closed');
    expect(body.lines[1]).toMatchObject({
      receivedQuantity: '1.000',
      pendingQuantity: '1.500',
    });
  });

  it('writes the full audit timeline', async () => {
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${purchaseOrderId}
      order by occurred_at, action
    `;
    expect(events.map((event) => event.action)).toEqual([
      'purchase_order.created',
      'purchase_order.lines_saved',
      'purchase_order.issued',
      'purchase_order.closed',
    ]);
  });
});

describe('numbering is gapless under the counter row lock', () => {
  let numberingWorkId: string;
  let numberingWorkCode: string;

  beforeAll(async () => {
    const created = await freshWork('N');
    numberingWorkId = created.workId;
    numberingWorkCode = created.workCode;
  }, 30_000);

  async function issue(id: string): Promise<string> {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${id}/issue`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<PurchaseOrderDetailResponse>().purchaseOrder.poNumber ?? '';
  }

  it('refuses to issue an order with no lines at all', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${numberingWorkId}/purchase-orders`,
      organisationId,
      payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const emptyId = created.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${emptyId}/issue`,
      organisationId,
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'PO_EMPTY' });

    // A draft is deleted, not cancelled, and consumes no number.
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/purchase-orders/${emptyId}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const [counter] = await admin<{ next_value: number }[]>`
      select next_value from purchase_order_counters
      where work_id = ${numberingWorkId}
    `;
    expect(counter).toBeUndefined();
  });

  it('numbers consecutively, and a cancelled order keeps its number forever', async () => {
    expect(await issue(await draftReadyToIssue(numberingWorkId))).toBe(
      `${numberingWorkCode}-PO-01`,
    );
    expect(await issue(await draftReadyToIssue(numberingWorkId))).toBe(
      `${numberingWorkCode}-PO-02`,
    );

    const cancelledId = await draftReadyToIssue(numberingWorkId);
    expect(await issue(cancelledId)).toBe(`${numberingWorkCode}-PO-03`);
    const deniedCancel = await authed(clerk, {
      method: 'POST',
      url: `/api/purchase-orders/${cancelledId}/cancel`,
      organisationId,
      payload: { note: 'clerk cannot cancel' },
    });
    expect(deniedCancel.statusCode).toBe(403);
    expect(deniedCancel.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${cancelledId}/cancel`,
      organisationId,
      payload: { note: '  Vendor withdrew the quotation.  ' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const detail = cancelled.json<PurchaseOrderDetailResponse>();
    expect(detail.purchaseOrder).toMatchObject({
      status: 'cancelled',
      poNumber: `${numberingWorkCode}-PO-03`,
      // Stored trimmed, exactly as the column's CHECK measures it.
      cancellationNote: 'Vendor withdrew the quotation.',
    });
    expect(detail.purchaseOrder.cancelledAt).not.toBeNull();

    // A note that says nothing is refused as a 400 at whichever layer sees
    // it first — never as a CHECK violation surfacing as a 500. The
    // contract's own shape catches spaces; the route's guard catches the
    // whitespace `btrim` would have kept.
    const nextId = await draftReadyToIssue(numberingWorkId);
    const blankNotes: [string, string][] = [
      ['   ', 'FST_ERR_VALIDATION'],
      ['\n\n\n', 'CANCELLATION_NOTE_REQUIRED'],
    ];
    for (const [note, code] of blankNotes) {
      const blank = await authed(owner, {
        method: 'POST',
        url: `/api/purchase-orders/${nextId}/cancel`,
        organisationId,
        payload: { note },
      });
      expect(blank.statusCode, `${JSON.stringify(note)}: ${blank.body}`).toBe(400);
      expect(blank.json()).toMatchObject({ code });
    }

    // The cancelled number is never reissued: the next order takes 04.
    expect(await issue(nextId)).toBe(`${numberingWorkCode}-PO-04`);

    const numbers = await admin<{ po_number: string }[]>`
      select po_number from purchase_orders
      where work_id = ${numberingWorkId} and po_number is not null
      order by sequence_number
    `;
    expect(numbers.map((row) => row.po_number)).toEqual([
      `${numberingWorkCode}-PO-01`,
      `${numberingWorkCode}-PO-02`,
      `${numberingWorkCode}-PO-03`,
      `${numberingWorkCode}-PO-04`,
    ]);
  });

  it('lets simultaneous issue attempts produce exactly one issued order', async () => {
    const race = await freshWork('R');
    const raceId = await draftReadyToIssue(race.workId);

    const [first, second] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/purchase-orders/${raceId}/issue`,
        organisationId,
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/purchase-orders/${raceId}/issue`,
        organisationId,
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);

    // One issued row, one number, and the counter advanced exactly once —
    // the loser's transaction rolled its increment back with it.
    const [row] = await admin<{ count: string; max_seq: number }[]>`
      select count(*)::text as count, max(sequence_number) as max_seq
      from purchase_orders where id = ${raceId} and status = 'issued'
    `;
    expect(row?.count).toBe('1');
    expect(row?.max_seq).toBe(1);
    const [counter] = await admin<{ next_value: number }[]>`
      select next_value from purchase_order_counters where work_id = ${race.workId}
    `;
    expect(counter?.next_value).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('answers 404 for another tenant and 403 for a foreign organisation header', async () => {
    const [order] = await admin<{ id: string }[]>`
      select id from purchase_orders where work_id = ${workId} limit 1
    `;
    expect(order).toBeDefined();

    // A caller in another organisation, using their OWN header: the row is
    // invisible under RLS and answers exactly like an unknown id.
    const hidden = await authed(outsider, {
      method: 'GET',
      url: `/api/purchase-orders/${order?.id ?? ''}`,
      organisationId: outsiderOrganisationId,
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'PURCHASE_ORDER_NOT_FOUND' });

    // The same caller borrowing OUR header never binds the tenant at all.
    const borrowed = await authed(outsider, {
      method: 'GET',
      url: `/api/purchase-orders/${order?.id ?? ''}`,
      organisationId,
    });
    expect(borrowed.statusCode).toBe(403);
    expect(borrowed.json()).toMatchObject({ code: 'NOT_A_MEMBER' });

    // And the Work-scoped list shows a foreign tenant nothing.
    const list = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workId}/purchase-orders`,
      organisationId: outsiderOrganisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<PurchaseOrderListResponse>().purchaseOrders).toEqual([]);
  });

  it('refuses every write to an unauthenticated caller', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/works/${workId}/purchase-orders`,
      headers: { 'x-organisation-id': organisationId },
      payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
