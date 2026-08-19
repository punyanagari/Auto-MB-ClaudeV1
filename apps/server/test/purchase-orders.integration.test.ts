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
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
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
let secondVendorId: string;
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

  await ensureClusterRoles(admin, appPassword);
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
    set can_issue_documents = true, can_cancel_documents = true,
        can_manage_payments = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  // Vendor contacts. `is_vendor` has been a dormant column since 0028 and
  // no route sets it yet, so the fixtures are written directly.
  vendorId = randomUUID();
  secondVendorId = randomUUID();
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
      (${secondVendorId}, ${organisationId}, ${`Konkan Switchgear ${runId}`},
       null, 'TTC Industrial Area, Navi Mumbai', null, null,
       '27AABCK1234C1ZQ', '400705', '27', false, true, true, ${ownerUserId}),
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
    await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
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

/**
 * The other half of the close rule (owner ruling 2026-08-19, migration
 * 0109): a purchase order does not close until the vendor has billed
 * for it and the bill is on file. Records one vendor invoice against
 * the order and uploads its PDF, through the real routes.
 */
async function billVendor(
  orderId: string,
  vendorContactId: string = vendorId,
): Promise<string> {
  const recorded = await authed(owner, {
    method: 'POST',
    url: '/api/vendor-invoices',
    organisationId,
    payload: {
      vendorContactId,
      invoiceNumber: `VI-${randomBytes(4).toString('hex')}`,
      invoiceDate: '2026-08-05',
      creditDays: 30,
      amount: '700.00',
      purchaseOrderId: orderId,
    },
  });
  expect(recorded.statusCode, recorded.body).toBe(201);
  const invoiceId = recorded.json<{ id: string }>().id;
  const uploaded = await authed(owner, {
    method: 'POST',
    url: `/api/vendor-invoices/${invoiceId}/document?filename=bill.pdf`,
    organisationId,
    headers: { 'content-type': 'application/pdf' },
    payload: Buffer.from('%PDF-1.4\n<< /Type /Catalog >>\n%%EOF\n', 'utf8'),
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  return invoiceId;
}

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

  it('enforces one draft per Work and vendor, naming the duplicate in the 409', async () => {
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

    const independent = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/purchase-orders`,
      organisationId,
      payload: { vendorContactId: secondVendorId, poDate: '2026-08-08' },
    });
    expect(independent.statusCode, independent.body).toBe(201);
    const independentId =
      independent.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/purchase-orders/${independentId}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);
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
            // A rate the gst_rates master (0048) still notifies on the
            // order date — 12% ended with the 22 Sep 2025 reform.
            gstRate: '5',
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
      gstRate: '5.00',
      quantity: '2.500',
      lineAmount: '100.00',
      pendingQuantity: '2.500',
    });
    // Money summed server-side as exact decimals; still no total on the
    // record itself, which is issue-written.
    expect(detail.previewTotal).toBe('700.00');
    expect(detail.purchaseOrder.totalAmount).toBeNull();
  });

  it('refuses a stated line GST rate the master does not notify on the order date', async () => {
    // 12% ended 21 Sep 2025 (GST 2.0); this order is dated 2026-08-08.
    // Only a STATED rate is checked — an omitted one stays null or
    // inherits the Work item's tax facts (nullable-tolerant by design).
    const response = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${purchaseOrderId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            description: 'Line carrying an abolished rate',
            unitCode: 'Nos',
            quantity: '1',
            rate: '100',
            gstRate: '12',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; message: string }>();
    expect(body.code).toBe('GST_RATE_NOT_NOTIFIED');
    expect(body.message).toContain('Line 1');
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
    await expect(
      admin`
        update purchase_orders set po_date = '2026-08-10'
        where id = ${purchaseOrderId}
      `,
    ).rejects.toThrowError(/business data is immutable/);

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

  it('refuses to close a fully received order the vendor has not billed for', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/close`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PO_NO_TAX_INVOICE' });
  });

  it('refuses to close while the vendor invoice carries no uploaded document', async () => {
    const recorded = await authed(owner, {
      method: 'POST',
      url: '/api/vendor-invoices',
      organisationId,
      payload: {
        vendorContactId: vendorId,
        invoiceNumber: `VI-paperless-${runId}`,
        invoiceDate: '2026-08-05',
        creditDays: 30,
        amount: '700.00',
        purchaseOrderId,
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/close`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PO_NO_TAX_INVOICE' });
    // The refusal distinguishes the two: an invoice IS on record, it is
    // the paper that is missing, and the sentence says so.
    expect(response.json<{ message: string }>().message).toContain(
      'no uploaded invoice document',
    );
    // Cancelling it takes it out of the count, so the next test starts
    // from "nothing recorded" again rather than from this one.
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/vendor-invoices/${recorded.json<{ id: string }>().id}/cancel`,
      organisationId,
      payload: { reason: 'Recorded against the wrong order.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
  });

  it('closes once every line has been fully received', async () => {
    await billVendor(purchaseOrderId);
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

  it('reopens a closed order when cancellation releases a receipt', async () => {
    // Cancelling the challan that fed line 2 gives the material back; the
    // order returns to issued so a corrected receipt can be linked.
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
    expect(body.purchaseOrder.status).toBe('issued');
    expect(body.purchaseOrder.closedAt).toBeNull();
    expect(body.lines[1]).toMatchObject({
      receivedQuantity: '1.000',
      pendingQuantity: '1.500',
    });

    const open = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/purchase-orders?status=open`,
      organisationId,
    });
    expect(
      open.json<PurchaseOrderListResponse>().purchaseOrders.map((order) => order.id),
    ).toContain(purchaseOrderId);

    await receive([
      { workItemId: itemBId, quantity: '1.5', purchaseOrderLineId: lineTwoId },
    ]);
    const corrected = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${purchaseOrderId}`,
      organisationId,
    });
    expect(
      corrected.json<PurchaseOrderDetailResponse>().lines[1]?.pendingQuantity,
    ).toBe('0.000');
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
      'purchase_order.reopened_after_challan_cancellation',
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

describe('close versus cancel of a linked challan under concurrency', () => {
  it('lets cancellation reopen the closed order exactly once, with no lost update', async () => {
    // A closed order whose entire receipt came from one issued challan,
    // linked through the API's own purchaseOrderLineId field this time.
    const arena = await freshWork('CC');
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${arena.workId}/purchase-orders`,
      organisationId,
      payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const poId = created.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    const saved = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${poId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            workItemId: arena.itemId,
            description: 'Concurrency arena item',
            unitCode: 'Nos',
            quantity: '2',
            rate: '100',
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const poLineId = saved.json<PurchaseOrderDetailResponse>().lines[0]?.id ?? '';
    expect(poLineId).not.toBe('');
    const issuedPo = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${poId}/issue`,
      organisationId,
    });
    expect(issuedPo.statusCode, issuedPo.body).toBe(201);

    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${arena.workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-09',
        prefix: `PCC${runId.slice(0, 3).toUpperCase()}`,
        consignee: { name: 'Site store', address: 'Site stores, Pune' },
        items: [
          { workItemId: arena.itemId, quantity: '2', purchaseOrderLineId: poLineId },
        ],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const challanId = draft.json<ChallanDetailResponse>().challan.id;
    const issuedChallan = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
      organisationId,
    });
    expect(issuedChallan.statusCode, issuedChallan.body).toBe(201);
    await billVendor(poId);

    const closed = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${poId}/close`,
      organisationId,
    });
    expect(closed.statusCode, closed.body).toBe(200);

    // The race: a repeat close and the linked challan's cancellation
    // arrive together. Both paths lock the purchase-order row before the
    // challan row, so they serialise in one of two orders — and in both
    // the close must lose: against the still-closed order it is a status
    // conflict, and against the just-reopened order the released receipt
    // leaves a line pending.
    const [closeAgain, cancelled] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/purchase-orders/${poId}/close`,
        organisationId,
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/challans/${challanId}/cancel`,
        organisationId,
        payload: { note: 'Material returned to the vendor during the race.' },
      }),
    ]);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(closeAgain.statusCode, closeAgain.body).toBe(409);
    expect(['PO_STATUS_CONFLICT', 'PO_NOT_FULLY_RECEIVED']).toContain(
      closeAgain.json<{ code: string }>().code,
    );

    // No lost update: whichever interleaving won, the released receipt
    // leaves the order OPEN with its full quantity pending again.
    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders/${poId}`,
      organisationId,
    });
    const body = detail.json<PurchaseOrderDetailResponse>();
    expect(body.purchaseOrder.status).toBe('issued');
    expect(body.purchaseOrder.closedAt).toBeNull();
    expect(body.lines[0]).toMatchObject({
      receivedQuantity: '0.000',
      pendingQuantity: '2.000',
    });

    // Durable audit evidence: closed once, reopened exactly once — never
    // a second reopen, never a close that outlived the cancellation.
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${poId}
        and action in (
          'purchase_order.closed',
          'purchase_order.reopened_after_challan_cancellation'
        )
      order by occurred_at, action
    `;
    expect(events.map((event) => event.action)).toEqual([
      'purchase_order.closed',
      'purchase_order.reopened_after_challan_cancellation',
    ]);
  });
});

/**
 * Orders raised outside any LOA (migration 0109).
 *
 * The same document with one column absent, so what is proved here is
 * exactly the set of things that column decided: its own gap-free number
 * series, its own one-draft-per-vendor rule, the work-scope wall that no
 * longer has anything to stand on, the receipt channel it is left with,
 * and the register that shows both kinds at once.
 */
describe('purchase orders raised outside any LOA', () => {
  let orderId: string;
  let lineId: string;
  let partId: string;

  beforeAll(async () => {
    partId = randomUUID();
    await admin`
      insert into production_items (
        id, organisation_id, item_code, name, category, unit, manufactured,
        serial_controlled, created_by_user_id
      )
      values (
        ${partId}, ${organisationId}, ${`ORGPO-${runId.slice(0, 6).toUpperCase()}`},
        'Office cabinet', 'Furniture', 'Nos', false, false, ${ownerUserId}
      )
    `;
  });

  it('drafts, lines and issues an order with no Work, numbered PO-01', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/purchase-orders',
      organisationId,
      payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json<PurchaseOrderDetailResponse>();
    expect(draft.purchaseOrder.workId).toBeNull();
    expect(draft.purchaseOrder.workCode).toBeNull();
    orderId = draft.purchaseOrder.id;

    // A second draft for the same vendor in the same series is refused by
    // the 0109 partial unique index, exactly as the per-Work one is.
    const duplicate = await authed(owner, {
      method: 'POST',
      url: '/api/purchase-orders',
      organisationId,
      payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'PO_DRAFT_EXISTS' });

    // A line cannot name a Work item, because there is no Work whose
    // schedule it could belong to.
    const wrongLine = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${orderId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            workItemId: itemAId,
            description: 'Contract item on an order with no contract',
            unitCode: 'Nos',
            quantity: '1',
            rate: '10',
          },
        ],
      },
    });
    expect(wrongLine.statusCode, wrongLine.body).toBe(409);
    expect(wrongLine.json()).toMatchObject({
      code: 'PO_LINE_WORK_ITEM_WITHOUT_WORK',
    });

    const saved = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${orderId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            productionItemId: partId,
            description: 'Office cabinet',
            unitCode: 'Nos',
            quantity: '3',
            rate: '2500',
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    lineId = saved.json<PurchaseOrderDetailResponse>().lines[0]?.id ?? '';
    expect(lineId).not.toBe('');

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${orderId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const order = issued.json<PurchaseOrderDetailResponse>().purchaseOrder;
    // The organisation series, not the Work's: no work code in front.
    expect(order.poNumber).toBe('PO-01');
    expect(order.sequenceNumber).toBe(1);
    expect(order.totalAmount).toBe('7500.00');
  });

  it('numbers the next work-less order PO-02, leaving the Work series alone', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/purchase-orders',
      organisationId,
      payload: { vendorContactId: secondVendorId, poDate: '2026-08-08' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const second = created.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    const lined = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${second}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            description: 'Site office rent deposit',
            unitCode: 'Lot',
            quantity: '1',
            rate: '5000',
          },
        ],
      },
    });
    expect(lined.statusCode, lined.body).toBe(200);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${second}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json<PurchaseOrderDetailResponse>().purchaseOrder.poNumber).toBe(
      'PO-02',
    );

    // Gap-free: the counter and the issued sequences agree.
    const [counter] = await admin<{ next_value: number }[]>`
      select next_value from organisation_purchase_order_counters
      where organisation_id = ${organisationId}
    `;
    expect(counter?.next_value).toBe(2);
    const sequences = await admin<{ sequence_number: number }[]>`
      select sequence_number from purchase_orders
      where organisation_id = ${organisationId} and work_id is null
        and sequence_number is not null
      order by sequence_number
    `;
    expect(sequences.map((row) => row.sequence_number)).toEqual([1, 2]);
  });

  it('receives onto the shelf and closes only once the vendor has billed', async () => {
    const received = await authed(owner, {
      method: 'POST',
      url: '/api/stock/movements',
      organisationId,
      payload: {
        productionItemId: partId,
        movementType: 'purchase_receipt',
        quantity: '3',
        movementDate: '2026-08-09',
        purchaseOrderLineId: lineId,
      },
    });
    // The 0087 guard used to read the order's Work and refuse a NULL one
    // as "missing"; 0109 exempts it, so a work-less receipt is legal.
    expect(received.statusCode, received.body).toBe(201);

    const unbilled = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${orderId}/close`,
      organisationId,
    });
    expect(unbilled.statusCode, unbilled.body).toBe(409);
    expect(unbilled.json()).toMatchObject({ code: 'PO_NO_TAX_INVOICE' });

    await billVendor(orderId);
    const closed = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${orderId}/close`,
      organisationId,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json<PurchaseOrderDetailResponse>().purchaseOrder.status).toBe(
      'closed',
    );
  });

  it('refuses the close at the database when the route is bypassed', async () => {
    // PO-02 above was issued and never billed, which is exactly the arena:
    // reached with admin SQL, past every route check, the trigger is the
    // only thing left standing between it and a closed order with no
    // evidence behind it.
    const [row] = await admin<{ id: string }[]>`
      select id from purchase_orders
      where organisation_id = ${organisationId} and work_id is null
        and status = 'issued'
      order by sequence_number desc limit 1
    `;
    const target = row?.id ?? '';
    expect(target).not.toBe('');
    await expect(
      admin`update purchase_orders set status = 'closed', closed_at = now()
            where id = ${target}`,
    ).rejects.toMatchObject({ code: '23U01' });
  });

  it('shows both series in the register and narrows to one Work on demand', async () => {
    const all = await authed(owner, {
      method: 'GET',
      url: '/api/purchase-orders',
      organisationId,
    });
    expect(all.statusCode, all.body).toBe(200);
    const register = all.json<{
      purchaseOrders: { id: string; workId: string | null; workCode: string | null }[];
      nextCursor: string | null;
    }>();
    expect(register.nextCursor).toBeNull();
    expect(register.purchaseOrders.some((order) => order.workId === null)).toBe(true);
    expect(register.purchaseOrders.some((order) => order.workId === workId)).toBe(true);
    expect(
      register.purchaseOrders.find((order) => order.workId === workId)?.workCode,
    ).toBe(workCode);

    const narrowed = await authed(owner, {
      method: 'GET',
      url: `/api/purchase-orders?work=${workId}`,
      organisationId,
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(
      narrowed
        .json<{ purchaseOrders: { workId: string | null }[] }>()
        .purchaseOrders.every((order) => order.workId === workId),
    ).toBe(true);

    const orgOnly = await authed(owner, {
      method: 'GET',
      url: '/api/purchase-orders?basis=organisation',
      organisationId,
    });
    expect(
      orgOnly
        .json<{ purchaseOrders: { workId: string | null }[] }>()
        .purchaseOrders.every((order) => order.workId === null),
    ).toBe(true);
  });

  it('shows a work-less order to every member, and a foreign tenant none', async () => {
    // A work-less order is in everyone's scope because there is no Work
    // whose assignment could narrow it — the wall applies exactly where
    // there is a Work behind the order and nowhere else.
    const response = await authed(viewer, {
      method: 'GET',
      url: '/api/purchase-orders?basis=organisation',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json<{ purchaseOrders: { workId: string | null }[] }>().purchaseOrders
        .length,
    ).toBeGreaterThan(0);

    const outside = await authed(outsider, {
      method: 'GET',
      url: '/api/purchase-orders',
      organisationId: outsiderOrganisationId,
    });
    expect(outside.statusCode, outside.body).toBe(200);
    expect(outside.json<{ purchaseOrders: unknown[] }>().purchaseOrders).toEqual([]);
  });
});

/**
 * The vendor tax invoice a purchase order closes against (migration
 * 0109): what may be linked to what, and the one file it carries.
 *
 * Proved here rather than in `payments.integration.test.ts` because the
 * rules are about the ORDER — which orders admit a bill, and what the
 * bill has to carry before a close will accept it — and this suite is the
 * one that already has orders in every state.
 */
describe('the vendor tax invoice a purchase order closes against', () => {
  it('refuses a bill against a draft order or another vendor', async () => {
    const draftId = await draftReadyToIssue((await freshWork('VB')).workId);

    const againstDraft = await authed(owner, {
      method: 'POST',
      url: '/api/vendor-invoices',
      organisationId,
      payload: {
        vendorContactId: vendorId,
        invoiceNumber: `VI-draft-${runId}`,
        invoiceDate: '2026-08-08',
        creditDays: 30,
        amount: '10.00',
        purchaseOrderId: draftId,
      },
    });
    expect(againstDraft.statusCode, againstDraft.body).toBe(409);
    expect(againstDraft.json()).toMatchObject({
      code: 'VENDOR_INVOICE_ORDER_MISMATCH',
    });

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${draftId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const wrongVendor = await authed(owner, {
      method: 'POST',
      url: '/api/vendor-invoices',
      organisationId,
      payload: {
        vendorContactId: secondVendorId,
        invoiceNumber: `VI-vendor-${runId}`,
        invoiceDate: '2026-08-08',
        creditDays: 30,
        amount: '10.00',
        purchaseOrderId: draftId,
      },
    });
    expect(wrongVendor.statusCode, wrongVendor.body).toBe(409);
    expect(wrongVendor.json()).toMatchObject({
      code: 'VENDOR_INVOICE_ORDER_MISMATCH',
    });
    expect(wrongVendor.json<{ message: string }>().message).toContain(
      'different vendor',
    );
  });

  it('stores the document once, serves it back, and freezes the link', async () => {
    const orderWork = await freshWork('VD');
    const orderId = await draftReadyToIssue(orderWork.workId);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${orderId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const invoiceId = await billVendor(orderId);

    // The bytes come back, as a PDF, from the route the register links to.
    const download = await authed(owner, {
      method: 'GET',
      url: `/api/vendor-invoices/${invoiceId}/document`,
      organisationId,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // Written once: a second upload is refused rather than swapping the
    // evidence a close may already have rested on.
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/vendor-invoices/${invoiceId}/document?filename=other.pdf`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('%PDF-1.4\n<< /Type /Catalog >>\n%%EOF\n', 'utf8'),
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ code: 'VENDOR_INVOICE_DOCUMENT_EXISTS' });

    // And the database refuses the same two moves past the route.
    await expect(
      admin`update vendor_invoices set purchase_order_id = null where id = ${invoiceId}`,
    ).rejects.toMatchObject({ code: '23U02' });
    await expect(
      admin`update vendor_invoices set original_filename = 'swapped.pdf'
            where id = ${invoiceId}`,
    ).rejects.toMatchObject({ code: '23U02' });

    // Anything that is not a PDF never reaches storage at all.
    const secondOrder = await draftReadyToIssue((await freshWork('VE')).workId);
    const secondIssued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${secondOrder}/issue`,
      organisationId,
    });
    expect(secondIssued.statusCode, secondIssued.body).toBe(201);
    const recorded = await authed(owner, {
      method: 'POST',
      url: '/api/vendor-invoices',
      organisationId,
      payload: {
        vendorContactId: vendorId,
        invoiceNumber: `VI-notpdf-${runId}`,
        invoiceDate: '2026-08-08',
        creditDays: 30,
        amount: '10.00',
        purchaseOrderId: secondOrder,
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const notPdf = await authed(owner, {
      method: 'POST',
      url: `/api/vendor-invoices/${recorded.json<{ id: string }>().id}/document?filename=x.pdf`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('This is not a PDF at all.', 'utf8'),
    });
    expect(notPdf.statusCode, notPdf.body).toBe(400);
    expect(notPdf.json()).toMatchObject({ code: 'NOT_A_PDF' });
  });
});

/**
 * The three things the review pass found the evidence rule did not yet
 * hold. Each is proved at the layer that holds it.
 */
describe('the evidence rule under a writer that is not a route', () => {
  let orderId: string;
  let invoiceId: string;

  beforeAll(async () => {
    const arena = await freshWork('EV');
    orderId = await draftReadyToIssue(arena.workId);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${orderId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    invoiceId = await billVendor(orderId);
  });

  it('refuses an invoice attributed to a Work its order does not buy for', async () => {
    const other = await freshWork('EW');
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/vendor-invoices',
      organisationId,
      payload: {
        vendorContactId: vendorId,
        invoiceNumber: `VI-crosswork-${runId}`,
        invoiceDate: '2026-08-08',
        creditDays: 30,
        amount: '10.00',
        workId: other.workId,
        purchaseOrderId: orderId,
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'VENDOR_INVOICE_ORDER_MISMATCH',
    });

    // Omitting the Work is not a disagreement: the order's own is
    // inherited, so the vendor ledger and the order cannot drift apart
    // by omission.
    const inherited = await authed(owner, {
      method: 'POST',
      url: '/api/vendor-invoices',
      organisationId,
      payload: {
        vendorContactId: vendorId,
        invoiceNumber: `VI-inherit-${runId}`,
        invoiceDate: '2026-08-08',
        creditDays: 30,
        amount: '10.00',
        purchaseOrderId: orderId,
      },
    });
    expect(inherited.statusCode, inherited.body).toBe(201);
    const [row] = await admin<{ work_id: string | null }[]>`
      select work_id from vendor_invoices
      where id = ${inherited.json<{ id: string }>().id}
    `;
    const [order] = await admin<{ work_id: string | null }[]>`
      select work_id from purchase_orders where id = ${orderId}
    `;
    expect(row?.work_id).toBe(order?.work_id);
  });

  it('refuses to delete the only evidence a closed order rests on', async () => {
    // Closed with admin SQL rather than through the route: this order's
    // lines were never received, and the receipt half of the close rule
    // is the OTHER half — proved at length above. What matters here is
    // that the order is closed, and the close-evidence trigger passing
    // this write is itself the proof that the evidence is in place.
    await admin`
      update purchase_orders set status = 'closed', closed_at = now()
      where id = ${orderId}
    `;

    // No route deletes a vendor invoice; this is exactly the writer the
    // second layer exists for.
    await expect(
      admin`delete from vendor_invoices where id = ${invoiceId}`,
    ).rejects.toMatchObject({ code: '23U02' });

    // The uploader attribution is frozen with the rest of the group, so
    // a closed order's evidence cannot be re-attributed either.
    await expect(
      admin`update vendor_invoices set document_uploaded_by_user_id = 'someone-else'
            where id = ${invoiceId}`,
    ).rejects.toMatchObject({ code: '23U02' });
  });

  it('lets an invoice go when it is not the last evidence', async () => {
    // A second documented invoice against the same order makes the first
    // one deletable again: what the guard protects is the ORDER's
    // evidence, not any particular row.
    const second = await billVendor(orderId);
    const removed = await admin`
      delete from vendor_invoices where id = ${second} returning id
    `;
    expect(removed).toHaveLength(1);
  });

  it('re-checks the letter date when a draft is moved onto another Work', async () => {
    // `work_id` became writable when it became nullable, and a draft
    // moved onto another Work also moves between the two number series.
    // Neither 0033 trigger watched the column before 0109 widened their
    // event lists, so this write used to pass unchecked.
    //
    // A REAL move, to a different Work whose letter is dated after the
    // order it would be supposed to have authorised. The draft carries
    // only a free-text consumable line, so the line-provenance guard of
    // § 6a has nothing to say and the date guard is what refuses.
    const home = await freshWork('EX');
    const draftId = await draftReadyToIssue(home.workId);
    const elsewhere = await freshWork('EY');
    await admin`
      update works set letter_date = '2026-12-01' where id = ${elsewhere.workId}
    `;
    await expect(
      admin`update purchase_orders set work_id = ${elsewhere.workId}
            where id = ${draftId}`,
    ).rejects.toMatchObject({ code: 'P0001' });
  });
});

/**
 * The findings the independent review of #160 raised, each proved at the
 * layer that answers it.
 */
describe('the evidence a closed order rests on cannot be withdrawn', () => {
  let orderId: string;
  let invoiceId: string;

  beforeAll(async () => {
    const arena = await freshWork('CV');
    orderId = await draftReadyToIssue(arena.workId);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${orderId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    invoiceId = await billVendor(orderId);
    await admin`
      update purchase_orders set status = 'closed', closed_at = now()
      where id = ${orderId}
    `;
  });

  it('refuses the cancel route on the only invoice closing an order', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/vendor-invoices/${invoiceId}/cancel`,
      organisationId,
      payload: { reason: 'Filed against the wrong order.' },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'VENDOR_INVOICE_CLOSES_ORDER' });
  });

  it('refuses the same cancel at the database, and the delete behind it', async () => {
    // Cancel-then-delete was the two-statement way around the delete arm.
    await expect(
      admin`update vendor_invoices set cancelled_at = now(),
              cancelled_by_user_id = ${ownerUserId},
              cancel_reason = 'Withdrawn by direct SQL'
            where id = ${invoiceId}`,
    ).rejects.toMatchObject({ code: '23U02' });
    await expect(
      admin`delete from vendor_invoices where id = ${invoiceId}`,
    ).rejects.toMatchObject({ code: '23U02' });
  });

  it('lets the invoice go once a replacement stands in its place', async () => {
    const replacement = await billVendor(orderId);
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/vendor-invoices/${invoiceId}/cancel`,
      organisationId,
      payload: { reason: 'Superseded by the corrected bill.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(replacement).not.toBe(invoiceId);
  });
});

describe('the close guard reads the invoice as evidence, not as a foreign key', () => {
  it('refuses to close against another vendor’s bill or another Work’s ledger', async () => {
    const arena = await freshWork('EG');
    const orderId = await draftReadyToIssue(arena.workId);
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${orderId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    // An honest invoice, then bent two ways past the routes that refuse
    // each — the guard is what stands when they are gone.
    const invoiceId = await billVendor(orderId);
    await admin`
      update vendor_invoices set vendor_contact_id = ${secondVendorId}
      where id = ${invoiceId}
    `;
    await expect(
      admin`update purchase_orders set status = 'closed', closed_at = now()
            where id = ${orderId}`,
    ).rejects.toMatchObject({ code: '23U01' });

    await admin`
      update vendor_invoices set vendor_contact_id = ${vendorId}, work_id = null
      where id = ${invoiceId}
    `;
    await expect(
      admin`update purchase_orders set status = 'closed', closed_at = now()
            where id = ${orderId}`,
    ).rejects.toMatchObject({ code: '23U01' });

    // Put it back and the same close is accepted, so the refusals above
    // are the two rules and not something else about this fixture.
    await admin`
      update vendor_invoices set work_id = ${arena.workId} where id = ${invoiceId}
    `;
    const closed = await admin`
      update purchase_orders set status = 'closed', closed_at = now()
      where id = ${orderId} returning id
    `;
    expect(closed).toHaveLength(1);
  });
});

describe('a line’s item belongs to its order’s Work', () => {
  it('refuses to move a draft onto a Work its lines do not belong to', async () => {
    const home = await freshWork('PA');
    const elsewhere = await freshWork('PB');
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${home.workId}/purchase-orders`,
      organisationId,
      payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    // A line that names `home`'s OWN item, which is what gives the draft
    // provenance to lose. A free-text line would have none and the move
    // would be legal.
    const lined = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${draftId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            workItemId: home.itemId,
            description: 'Item from this Work’s own schedule',
            unitCode: 'Nos',
            quantity: '1',
            rate: '100',
          },
        ],
      },
    });
    expect(lined.statusCode, lined.body).toBe(200);

    // A real move, to a DIFFERENT Work: the draft's line cites `home`'s
    // schedule, and `elsewhere` has a schedule of its own.
    await expect(
      admin`update purchase_orders set work_id = ${elsewhere.workId}
            where id = ${draftId}`,
    ).rejects.toMatchObject({ code: '23U03' });

    // And to no Work at all, which would issue it in the organisation
    // series citing a schedule it has no Work to have.
    await expect(
      admin`update purchase_orders set work_id = null where id = ${draftId}`,
    ).rejects.toMatchObject({ code: '23U03' });
  });

  it('refuses a line naming an item from outside its order’s Work', async () => {
    const home = await freshWork('PC');
    const elsewhere = await freshWork('PD');
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${home.workId}/purchase-orders`,
      organisationId,
      payload: { vendorContactId: vendorId, poDate: '2026-08-08' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json<PurchaseOrderDetailResponse>().purchaseOrder.id;

    // The route inserts lines through a join on the order's Work, so
    // this shape has never been reachable through the API. The guard is
    // what holds for a writer that reaches the table directly.
    await expect(
      admin`
        insert into purchase_order_lines (
          organisation_id, purchase_order_id, work_item_id, line_number,
          description, unit_code, quantity, rate, line_amount
        )
        values (
          ${organisationId}, ${draftId}, ${elsewhere.itemId}, 1,
          'Another Work''s item', 'Nos', 1, 100, 100
        )
      `,
    ).rejects.toMatchObject({ code: '23U03' });
  });
});

describe('an issued order never changes series', () => {
  it('refuses work -> organisation and organisation -> work alike', async () => {
    // The central promise of the two-series design is that a number,
    // once handed out, cannot be renumbered into the other series. 0045
    // freezes `work_id` on an issued order; this is that promise as a
    // test rather than as a sentence.
    const arena = await freshWork('SR');
    const workOrder = await draftReadyToIssue(arena.workId);
    expect(
      (
        await authed(owner, {
          method: 'POST',
          url: `/api/purchase-orders/${workOrder}/issue`,
          organisationId,
        })
      ).statusCode,
    ).toBe(201);

    const orgCreated = await authed(owner, {
      method: 'POST',
      url: '/api/purchase-orders',
      organisationId,
      payload: { vendorContactId: secondVendorId, poDate: '2026-08-08' },
    });
    expect(orgCreated.statusCode, orgCreated.body).toBe(201);
    const orgOrder = orgCreated.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
    await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${orgOrder}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            description: 'Office consumable',
            unitCode: 'Nos',
            quantity: '1',
            rate: '5',
          },
        ],
      },
    });
    expect(
      (
        await authed(owner, {
          method: 'POST',
          url: `/api/purchase-orders/${orgOrder}/issue`,
          organisationId,
        })
      ).statusCode,
    ).toBe(201);

    // work -> organisation
    await expect(
      admin`update purchase_orders set work_id = null where id = ${workOrder}`,
    ).rejects.toMatchObject({ code: '23514' });
    // organisation -> work
    await expect(
      admin`update purchase_orders set work_id = ${arena.workId}
            where id = ${orgOrder}`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
