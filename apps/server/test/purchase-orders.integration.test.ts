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
      sequenß^õ¶‰Ëkºwµç@É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œÀ¸ÀÀÀœ°(€€€€€Á•¹‘¥¹EÕ…¹Ñ¥Ñäè€œØ¸ÀÀÀœ°(€€€ô¤ì(€ô¤ì((€€¼¨¨I•½É‘Ì„‘•±¥Ù•Éä¡…±±…¸™½ÈÑ¡”™¥áÑÕÉ”]½É¬…¹Á½¥¹ÑÌ¥ÑÌ±¥¹•Ì(€€€¨…ĞÑ¡”ÁÕÉ¡…Í”½É‘•È±¥¹•ÌÑ¡•ä™Õ±™¥°¸Q¡”±¥¹¬½±Õµ¸¥ÌİÉ¥ÑÑ•¸(€€€¨İ¥Ñ …‘µ¥¸ME0ƒŠPÍ•”Ñ¡”™¥±”¡•…‘•È¸€¨¼(€…Íå¹Œ™Õ¹Ñ¥½¸É••¥Ù” (€€€¥Ñ•µÌèìİ½É­%Ñ•µ%èÍÑÉ¥¹œìÅÕ…¹Ñ¥ÑäèÍÑÉ¥¹œìÁÕÉ¡…Í•=É‘•É1¥¹•%èÍÑÉ¥¹œõmt°(€€€½ÁÑ¥½¹Ìèì¥ÍÍÕ”è‰½½±•…¸ô€ôì¥ÍÍÕ”èÑÉÕ”ô°(€€¤èAÉ½µ¥Í”ñÍÑÉ¥¹œøì(€€€½¹ÍĞÉ•…Ñ•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½İ½É­Ì¼‘íİ½É­%‘ô½¡…±±…¹Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€¡…±±…¹…Ñ”è€œÈÀÈØ´Àà´Àäœ°(€€€€€€€ÁÉ•™¥àèA=H‘íÉÕ¹%¹Í±¥” À°€Ì¤¹Ñ½UÁÁ•É…Í” ¥õ€°(€€€€€€€½¹Í¥¹•”èì¹…µ”è€M¥Ñ”ÍÑ½É”œ°…‘‘É•ÍÌè€M¥Ñ”ÍÑ½É•Ì°AÕ¹”œô°(€€€€€€€¥Ñ•µÌè¥Ñ•µÌ¹µ…À ¡¥Ñ•´¤€ôø€¡ì(€€€€€€€€€İ½É­%Ñ•µ%è¥Ñ•´¹İ½É­%Ñ•µ%°(€€€€€€€€€ÅÕ…¹Ñ¥Ñäè¥Ñ•´¹ÅÕ…¹Ñ¥Ñä°(€€€€€€€ô¤¤°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ğ¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍĞ¡…±±…¸€ôÉ•…Ñ•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€™½È€¡½¹ÍĞ¥Ñ•´½˜¥Ñ•µÌ¤ì(€€€€€…İ…¥Ğ…‘µ¥¹€(€€€€€€€ÕÁ‘…Ñ”‘•±¥Ù•Éå}¡…±±…¹}¥Ñ•µÌ(€€€€€€€Í•ĞÁÕÉ¡…Í•}½É‘•É}±¥¹•}¥€ô€‘í¥Ñ•´¹ÁÕÉ¡…Í•=É‘•É1¥¹•%‘ô(€€€€€€€İ¡•É”‘•±¥Ù•Éå}¡…±±…¹}¥€ô€‘í¡…±±…¸¹¡…±±…¸¹¥‘ô(€€€€€€€€€…¹İ½É­}¥Ñ•µ}¥€ô€‘í¥Ñ•´¹İ½É­%Ñ•µ%‘ô(€€€€€€ì(€€€ô(€€€¥˜€¡½ÁÑ¥½¹Ì¹¥ÍÍÕ”¤ì(€€€€€½¹ÍĞ¥ÍÍÕ•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í¡…±±…¸¹¡…±±…¸¹¥‘ô½¥ÍÍÕ•€°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€ô¤ì(€€€€€•áÁ•Ğ¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€ô(€€€É•ÑÕÉ¸¡…±±…¸¹¡…±±…¸¹¥ì(€ô((€±•ĞÍ•½¹‘¡…±±…¹%èÍÑÉ¥¹œì((€¥Ğ ½Õ¹ÑÌ½¹±ä¥ÍÍÕ•¡…±±…¹ÌÑ½İ…É‘ÌÑ¡”É••¥Ù•‰…±…¹”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞ‘É…™Ñ¡…±±…¹%€ô…İ…¥ĞÉ••¥Ù” (€€€€€mìİ½É­%Ñ•µ%è¥Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œØœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%è±¥¹•=¹•%õt°(€€€€€ì¥ÍÍÕ”è™…±Í”ô°(€€€€¤ì(€€€½¹ÍĞİ¡¥±•É…™Ğ€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÁÕÉ¡…Í•=É‘•É%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€€¼¼‘É…™Ğ¡…±±…¸¡…Ì‘•±¥Ù•É•¹½Ñ¡¥¹œ¸(€€€•áÁ•Ğ¡İ¡¥±•É…™Ğ¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹±¥¹•ÍlÁt¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì(€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œÀ¸ÀÀÀœ°(€€€€€Á•¹‘¥¹EÕ…¹Ñ¥Ñäè€œØ¸ÀÀÀœ°(€€€ô¤ì((€€€½¹ÍĞ¥ÍÍÕ•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í‘É…™Ñ¡…±±…¹%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì((€€€½¹ÍĞ…™Ñ•É%ÍÍÕ”€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÁÕÉ¡…Í•=É‘•É%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€½¹ÍĞ‘•Ñ…¥°€ô…™Ñ•É%ÍÍÕ”¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥°¹±¥¹•ÍlÁt¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì(€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œØ¸ÀÀÀœ°(€€€€€Á•¹‘¥¹EÕ…¹Ñ¥Ñäè€œÀ¸ÀÀÀœ°(€€€ô¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥°¹±¥¹•ÍlÅt¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì(€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œÀ¸ÀÀÀœ°(€€€€€Á•¹‘¥¹EÕ…¹Ñ¥Ñäè€œÈ¸ÔÀÀœ°(€€€ô¤ì(€ô¤ì((€¥Ğ ÍÕµÌÉ••¥ÁÑÌ…É½ÍÌ¡…±±…¹Ì…¹¹…µ•Ì½¹±äÑ¡”±¥¹”ÍÑ¥±°½Á•¸œ°…Íå¹Œ€ ¤€ôøì(€€€…İ…¥ĞÉ••¥Ù”¡l(€€€€€ìİ½É­%Ñ•µ%è¥Ñ•µ	%°ÅÕ…¹Ñ¥Ñäè€œÄœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%è±¥¹•Qİ½%ô°(€€€t¤ì(€€€½¹ÍĞÁ…ÉÑ¥…°€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÁÕÉ¡…Í•=É‘•É%‘ô½±½Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡Á…ÉÑ¥…°¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ĞÀä¤ì(€€€½¹ÍĞ‘•Ñ…¥±Ì€ôÁ…ÉÑ¥…°¹©Í½¸ñì(€€€€€‘•Ñ…¥±Ìèì½ÕÑÍÑ…¹‘¥¹1¥¹•ÌèìÁÕÉ¡…Í•=É‘•É1¥¹•%èÍÑÉ¥¹œõmtôì(€€€ôø ¤¹‘•Ñ…¥±Ìì(€€€•áÁ•Ğ¡‘•Ñ…¥±Ì¹½ÕÑÍÑ…¹‘¥¹1¥¹•Ì¤¹Ñ½!…Ù•1•¹Ñ  Ä¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥±Ì¹½ÕÑÍÑ…¹‘¥¹1¥¹•ÍlÁt¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì(€€€€€ÁÕÉ¡…Í•=É‘•É1¥¹•%è±¥¹•Qİ½%°(€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œÄ¸ÀÀÀœ°(€€€€€Á•¹‘¥¹EÕ…¹Ñ¥Ñäè€œÄ¸ÔÀÀœ°(€€€ô¤ì((€€€Í•½¹‘¡…±±…¹%€ô…İ…¥ĞÉ••¥Ù”¡l(€€€€€ìİ½É­%Ñ•µ%è¥Ñ•µ	%°ÅÕ…¹Ñ¥Ñäè€œÄ¸Ôœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%è±¥¹•Qİ½%ô°(€€€t¤ì(€ô¤ì((€¥Ğ ±½Í•Ì½¹”•Ù•Éä±¥¹”¡…Ì‰••¸™Õ±±äÉ••¥Ù•œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞ±½Í•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÁÕÉ¡…Í•=É‘•É%‘ô½±½Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡±½Í•¹ÍÑ…ÑÕÍ½‘”°±½Í•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍĞ‘•Ñ…¥°€ô±½Í•¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥°¹ÁÕÉ¡…Í•=É‘•È¹ÍÑ…ÑÕÌ¤¹Ñ½	” ±½Í•œ¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥°¹ÁÕÉ¡…Í•=É‘•È¹±½Í•‘Ğ¤¹¹½Ğ¹Ñ½	•9Õ±° ¤ì(€€€€¼¼Q¡”¹Õµ‰•È…¹Ñ¡”Ñ½Ñ…°ÍÕÉÙ¥Ù”Ñ¡”ÑÉ…¹Í¥Ñ¥½¸Õ¹Ñ½Õ¡•¸(€€€•áÁ•Ğ¡‘•Ñ…¥°¹ÁÕÉ¡…Í•=É‘•È¹Á½9Õµ‰•È¤¹Ñ½	”¡€‘íİ½É­½‘•ôµA<´ÀÅ€¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥°¹ÁÕÉ¡…Í•=É‘•È¹Ñ½Ñ…±µ½Õ¹Ğ¤¹Ñ½	” œÜÀÀ¸ÀÀœ¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥°¹±¥¹•Ì¹µ…À ¡±¥¹”¤€ôø±¥¹”¹Á•¹‘¥¹EÕ…¹Ñ¥Ñä¤¤¹Ñ½ÅÕ…°¡l(€€€€€€œÀ¸ÀÀÀœ°(€€€€€€œÀ¸ÀÀÀœ°(€€€t¤ì((€€€€¼¼±½Í•½É‘•È¥Ì¹¼±½¹•È½™™•É•Ñ¼Ñ¡”¡…±±…¸•‘¥Ñ½È°…¹„(€€€€¼¼Í•½¹±½Í”¥ÌÉ•™ÕÍ•¸(€€€½¹ÍĞ½Á•¸€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½İ½É­Ì¼‘íİ½É­%‘ô½ÁÕÉ¡…Í”µ½É‘•ÉÌıÍÑ…ÑÕÌõ½Á•¹€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡½Á•¸¹©Í½¸ñAÕÉ¡…Í•=É‘•É1¥ÍÑI•ÍÁ½¹Í”ø ¤¹ÁÕÉ¡…Í•=É‘•ÉÌ¤¹Ñ½ÅÕ…°¡mt¤ì(€€€½¹ÍĞ……¥¸€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÁÕÉ¡…Í•=É‘•É%‘ô½±½Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡……¥¸¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ĞÀä¤ì(€€€•áÁ•Ğ¡……¥¸¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€A=}MQQUM}=91%Pœô¤ì(€ô¤ì((€¥Ğ É•½Á•¹Ì„±½Í•½É‘•Èİ¡•¸…¹•±±…Ñ¥½¸É•±•…Í•Ì„É••¥ÁĞœ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼…¹•±±¥¹œÑ¡”¡…±±…¸Ñ¡…Ğ™•±¥¹”€È¥Ù•ÌÑ¡”µ…Ñ•É¥…°‰…¬ìÑ¡”(€€€€¼¼½É‘•ÈÉ•ÑÕÉ¹ÌÑ¼¥ÍÍÕ•Í¼„½ÉÉ•Ñ•É••¥ÁĞ…¸‰”±¥¹­•¸(€€€½¹ÍĞ…¹•±±•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘íÍ•½¹‘¡…±±…¹%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€5…Ñ•É¥…°É•ÑÕÉ¹•Ñ¼Ñ¡”Ù•¹‘½È…Ì‘•™•Ñ¥Ù”¸œô°(€€€ô¤ì(€€€•áÁ•Ğ¡…¹•±±•¹ÍÑ…ÑÕÍ½‘”°…¹•±±•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì((€€€½¹ÍĞ‘•Ñ…¥°€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÁÕÉ¡…Í•=É‘•É%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€½¹ÍĞ‰½‘ä€ô‘•Ñ…¥°¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ğ¡‰½‘ä¹ÁÕÉ¡…Í•=É‘•È¹ÍÑ…ÑÕÌ¤¹Ñ½	” ¥ÍÍÕ•œ¤ì(€€€•áÁ•Ğ¡‰½‘ä¹ÁÕÉ¡…Í•=É‘•È¹±½Í•‘Ğ¤¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ğ¡‰½‘ä¹±¥¹•ÍlÅt¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì(€€€€€É••¥Ù•‘EÕ…¹Ñ¥Ñäè€œÄ¸ÀÀÀœ°(€€€€€Á•¹‘¥¹EÕ…¹Ñ¥Ñäè€œÄ¸ÔÀÀœ°(€€€ô¤ì((€€€½¹ÍĞ½Á•¸€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½İ½É­Ì¼‘íİ½É­%‘ô½ÁÕÉ¡…Í”µ½É‘•ÉÌıÍÑ…ÑÕÌõ½Á•¹€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ (€€€€€½Á•¸¹©Í½¸ñAÕÉ¡…Í•=É‘•É1¥ÍÑI•ÍÁ½¹Í”ø ¤¹ÁÕÉ¡…Í•=É‘•ÉÌ¹µ…À ¡½É‘•È¤€ôø½É‘•È¹¥¤°(€€€€¤¹Ñ½½¹Ñ…¥¸¡ÁÕÉ¡…Í•=É‘•É%¤ì((€€€…İ…¥ĞÉ••¥Ù”¡l(€€€€€ìİ½É­%Ñ•µ%è¥Ñ•µ	%°ÅÕ…¹Ñ¥Ñäè€œÄ¸Ôœ°ÁÕÉ¡…Í•=É‘•É1¥¹•%è±¥¹•Qİ½%ô°(€€€t¤ì(€€€½¹ÍĞ½ÉÉ•Ñ•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÁÕÉ¡…Í•=É‘•É%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ (€€€€€½ÉÉ•Ñ•¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹±¥¹•ÍlÅtü¹Á•¹‘¥¹EÕ…¹Ñ¥Ñä°(€€€€¤¹Ñ½	” œÀ¸ÀÀÀœ¤ì(€ô¤ì((€¥Ğ İÉ¥Ñ•ÌÑ¡”™Õ±°…Õ‘¥ĞÑ¥µ•±¥¹”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞ•Ù•¹ÑÌ€ô…İ…¥Ğ…‘µ¥¸ñì…Ñ¥½¸èÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ğ…Ñ¥½¸™É½´…Õ‘¥Ñ}•Ù•¹ÑÌ(€€€€€İ¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô…¹•¹Ñ¥Ñå}¥€ô€‘íÁÕÉ¡…Í•=É‘•É%‘ô(€€€€€½É‘•È‰ä½ÕÉÉ•‘}…Ğ°…Ñ¥½¸(€€€€ì(€€€•áÁ•Ğ¡•Ù•¹ÑÌ¹µ…À ¡•Ù•¹Ğ¤€ôø•Ù•¹Ğ¹…Ñ¥½¸¤¤¹Ñ½ÅÕ…°¡l(€€€€€€ÁÕÉ¡…Í•}½É‘•È¹É•…Ñ•œ°(€€€€€€ÁÕÉ¡…Í•}½É‘•È¹±¥¹•Í}Í…Ù•œ°(€€€€€€ÁÕÉ¡…Í•}½É‘•È¹¥ÍÍÕ•œ°(€€€€€€ÁÕÉ¡…Í•}½É‘•È¹±½Í•œ°(€€€€€€ÁÕÉ¡…Í•}½É‘•È¹É•½Á•¹•‘}…™Ñ•É}¡…±±…¹}…¹•±±…Ñ¥½¸œ°(€€€t¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” ¹Õµ‰•É¥¹œ¥Ì…Á±•ÍÌÕ¹‘•ÈÑ¡”½Õ¹Ñ•ÈÉ½Ü±½¬œ°€ ¤€ôøì(€±•Ğ¹Õµ‰•É¥¹]½É­%èÍÑÉ¥¹œì(€±•Ğ¹Õµ‰•É¥¹]½É­½‘”èÍÑÉ¥¹œì((€‰•™½É•±°¡…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞÉ•…Ñ•€ô…İ…¥Ğ™É•Í¡]½É¬ 8œ¤ì(€€€¹Õµ‰•É¥¹]½É­%€ôÉ•…Ñ•¹İ½É­%ì(€€€¹Õµ‰•É¥¹]½É­½‘”€ôÉ•…Ñ•¹İ½É­½‘”ì(€ô°€ÌÁ|ÀÀÀ¤ì((€…Íå¹Œ™Õ¹Ñ¥½¸¥ÍÍÕ”¡¥èÍÑÉ¥¹œ¤èAÉ½µ¥Í”ñÍÑÉ¥¹œøì(€€€½¹ÍĞÉ•ÍÁ½¹Í”€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í¥‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€É•ÑÕÉ¸É•ÍÁ½¹Í”¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹ÁÕÉ¡…Í•=É‘•È¹Á½9Õµ‰•È€üü€œœì(€ô((€¥Ğ É•™ÕÍ•ÌÑ¼¥ÍÍÕ”…¸½É‘•Èİ¥Ñ ¹¼±¥¹•Ì…Ğ…±°œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞÉ•…Ñ•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½İ½É­Ì¼‘í¹Õµ‰•É¥¹]½É­%‘ô½ÁÕÉ¡…Í”µ½É‘•ÉÍ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èìÙ•¹‘½É½¹Ñ…Ñ%èÙ•¹‘½É%°Á½…Ñ”è€œÈÀÈØ´Àà´Ààœô°(€€€ô¤ì(€€€•áÁ•Ğ¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍĞ•µÁÑå%€ôÉ•…Ñ•¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹ÁÕÉ¡…Í•=É‘•È¹¥ì(€€€½¹ÍĞÉ•™ÕÍ•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í•µÁÑå%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡É•™ÕÍ•¹ÍÑ…ÑÕÍ½‘”°É•™ÕÍ•¹‰½‘ä¤¹Ñ½	” ĞÀä¤ì(€€€•áÁ•Ğ¡É•™ÕÍ•¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€A=}5AQdœô¤ì((€€€€¼¼‘É…™Ğ¥Ì‘•±•Ñ•°¹½Ğ…¹•±±•°…¹½¹ÍÕµ•Ì¹¼¹Õµ‰•È¸(€€€½¹ÍĞÉ•µ½Ù•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€1Qœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í•µÁÑå%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡É•µ½Ù•¹ÍÑ…ÑÕÍ½‘”°É•µ½Ù•¹‰½‘ä¤¹Ñ½	” ÈÀĞ¤ì(€€€½¹ÍĞm½Õ¹Ñ•Ét€ô…İ…¥Ğ…‘µ¥¸ñì¹•áÑ}Ù…±Õ”è¹Õµ‰•Èõmtù€(€€€€€Í•±•Ğ¹•áÑ}Ù…±Õ”™É½´ÁÕÉ¡…Í•}½É‘•É}½Õ¹Ñ•ÉÌ(€€€€€İ¡•É”İ½É­}¥€ô€‘í¹Õµ‰•É¥¹]½É­%‘ô(€€€€ì(€€€•áÁ•Ğ¡½Õ¹Ñ•È¤¹Ñ½	•U¹‘•™¥¹• ¤ì(€ô¤ì((€¥Ğ ¹Õµ‰•ÉÌ½¹Í•ÕÑ¥Ù•±ä°…¹„…¹•±±•½É‘•È­••ÁÌ¥ÑÌ¹Õµ‰•È™½É•Ù•Èœ°…Íå¹Œ€ ¤€ôøì(€€€•áÁ•Ğ¡…İ…¥Ğ¥ÍÍÕ”¡…İ…¥Ğ‘É…™ÑI•…‘åQ½%ÍÍÕ”¡¹Õµ‰•É¥¹]½É­%¤¤¤¹Ñ½	” (€€€€€€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÅ€°(€€€€¤ì(€€€•áÁ•Ğ¡…İ…¥Ğ¥ÍÍÕ”¡…İ…¥Ğ‘É…™ÑI•…‘åQ½%ÍÍÕ”¡¹Õµ‰•É¥¹]½É­%¤¤¤¹Ñ½	” (€€€€€€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÉ€°(€€€€¤ì((€€€½¹ÍĞ…¹•±±•‘%€ô…İ…¥Ğ‘É…™ÑI•…‘åQ½%ÍÍÕ”¡¹Õµ‰•É¥¹]½É­%¤ì(€€€•áÁ•Ğ¡…İ…¥Ğ¥ÍÍÕ”¡…¹•±±•‘%¤¤¹Ñ½	”¡€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÍ€¤ì(€€€½¹ÍĞ‘•¹¥•‘…¹•°€ô…İ…¥Ğ…ÕÑ¡•¡±•É¬°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í…¹•±±•‘%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€±•É¬…¹¹½Ğ…¹•°œô°(€€€ô¤ì(€€€•áÁ•Ğ¡‘•¹¥•‘…¹•°¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ĞÀÌ¤ì(€€€•áÁ•Ğ¡‘•¹¥•‘…¹•°¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€UQ!=I%Qe}IEU%Iœô¤ì((€€€½¹ÍĞ…¹•±±•€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í…¹•±±•‘%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€œ€Y•¹‘½Èİ¥Ñ¡‘É•ÜÑ¡”ÅÕ½Ñ…Ñ¥½¸¸€€œô°(€€€ô¤ì(€€€•áÁ•Ğ¡…¹•±±•¹ÍÑ…ÑÕÍ½‘”°…¹•±±•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍĞ‘•Ñ…¥°€ô…¹•±±•¹©Í½¸ñAÕÉ¡…Í•=É‘•É•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥°¹ÁÕÉ¡…Í•=É‘•È¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì(€€€€€ÍÑ…ÑÕÌè€…¹•±±•œ°(€€€€€Á½9Õµ‰•Èè€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÍ€°(€€€€€€¼¼MÑ½É•ÑÉ¥µµ•°•á…Ñ±ä…ÌÑ¡”½±Õµ¸Ì!,µ•…ÍÕÉ•Ì¥Ğ¸(€€€€€…¹•±±…Ñ¥½¹9½Ñ”è€Y•¹‘½Èİ¥Ñ¡‘É•ÜÑ¡”ÅÕ½Ñ…Ñ¥½¸¸œ°(€€€ô¤ì(€€€•áÁ•Ğ¡‘•Ñ…¥°¹ÁÕÉ¡…Í•=É‘•È¹…¹•±±•‘Ğ¤¹¹½Ğ¹Ñ½	•9Õ±° ¤ì((€€€€¼¼¹½Ñ”Ñ¡…ĞÍ…åÌ¹½Ñ¡¥¹œ¥ÌÉ•™ÕÍ•…Ì„€ĞÀÀ…Ğİ¡¥¡•Ù•È±…å•ÈÍ••Ì(€€€€¼¼¥Ğ™¥ÉÍĞƒŠP¹•Ù•È…Ì„!,Ù¥½±…Ñ¥½¸ÍÕÉ™…¥¹œ…Ì„€ÔÀÀ¸Q¡”(€€€€¼¼½¹ÑÉ…ĞÌ½İ¸Í¡…Á”…Ñ¡•ÌÍÁ…•ÌìÑ¡”É½ÕÑ”ÌÕ…É…Ñ¡•ÌÑ¡”(€€€€¼¼İ¡¥Ñ•ÍÁ…”‰ÑÉ¥µ€İ½Õ±¡…Ù”­•ÁĞ¸(€€€½¹ÍĞ¹•áÑ%€ô…İ…¥Ğ‘É…™ÑI•…‘åQ½%ÍÍÕ”¡¹Õµ‰•É¥¹]½É­%¤ì(€€€½¹ÍĞ‰±…¹­9½Ñ•ÌèmÍÑÉ¥¹œ°ÍÑÉ¥¹umt€ôl(€€€€€lœ€€€œ°€MQ}II}Y1%Q%=8t°(€€€€€lq¹q¹q¸œ°€911Q%=9}9=Q}IEU%It°(€€€tì(€€€™½È€¡½¹ÍĞm¹½Ñ”°½‘•t½˜‰±…¹­9½Ñ•Ì¤ì(€€€€€½¹ÍĞ‰±…¹¬€ô…İ…¥Ğ…ÕÑ¡•¡½İ¹•È°ì(€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í¹•áÑ%‘ô½…¹•±€°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€Á…å±½…èì¹½Ñ”ô°(€€€€€ô¤ì(€€€€€•áÁ•Ğ¡‰±…¹¬¹ÍÑ…ÑÕÍ½‘”°€‘í)M=8¹ÍÑÉ¥¹¥™ä¡¹½Ñ”¥ôè€‘í‰±…¹¬¹‰½‘åõ€¤¹Ñ½	” ĞÀÀ¤ì(€€€€€•áÁ•Ğ¡‰±…¹¬¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”ô¤ì(€€€ô((€€€€¼¼Q¡”…¹•±±•¹Õµ‰•È¥Ì¹•Ù•ÈÉ•¥ÍÍÕ•èÑ¡”¹•áĞ½É‘•ÈÑ…­•Ì€ÀĞ¸(€€€•áÁ•Ğ¡…İ…¥Ğ¥ÍÍÕ”¡¹•áÑ%¤¤¹Ñ½	”¡€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÑ€¤ì((€€€½¹ÍĞ¹Õµ‰•ÉÌ€ô…İ…¥Ğ…‘µ¥¸ñìÁ½}¹Õµ‰•ÈèÍÑÉ¥¹œõmtù€(€€€€€Í•±•ĞÁ½}¹Õµ‰•È™É½´ÁÕÉ¡…Í•}½É‘•ÉÌ(€€€€€İ¡•É”İ½É­}¥€ô€‘í¹Õµ‰•É¥¹]½É­%‘ô…¹Á½}¹Õµ‰•È¥Ì¹½Ğ¹Õ±°(€€€€€½É‘•È‰äÍ•ÅÕ•¹•}¹Õµ‰•È(€€€€ì(€€€•áÁ•Ğ¡¹Õµ‰•ÉÌ¹µ…À ¡É½Ü¤€ôøÉ½Ü¹Á½}¹Õµ‰•È¤¤¹Ñ½ÅÕ…°¡l(€€€€€€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÅ€°(€€€€€€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÉ€°(€€€€€€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÍ€°(€€€€€€‘í¹Õµ‰•É¥¹]½É­½‘•ôµA<´ÀÑ€°(€€€t¤ì(€ô¤ì((€¥Ğ ±•ÑÌÍ¥µÕ±Ñ…¹•½ÕÌ¥ÍÍÕ”…ÑÑ•µÁÑÌÁÉ½‘Õ”•á…Ñ±ä½¹”¥ÍÍÕ•½É‘•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞÉ…”€ô…İ…¥Ğ™É•Í¡]½É¬ Hœ¤ì(€€€½¹ÍĞÉ…•%€ô…İ…¥Ğ‘É…™ÑI•…‘åQ½%ÍÍÕ”¡É…”¹İ½É­%¤ì((€€€½¹ÍĞm™¥ÉÍĞ°Í•½¹‘t€ô…İ…¥ĞAÉ½µ¥Í”¹…±°¡l(€€€€€…ÕÑ¡•¡½İ¹•È°ì(€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÉ…•%‘ô½¥ÍÍÕ•€°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€ô¤°(€€€€€…ÕÑ¡•¡½İ¹•È°ì(€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘íÉ…•%‘ô½¥ÍÍÕ•€°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€ô¤°(€€€t¤ì(€€€•áÁ•Ğ¡m™¥ÉÍĞ¹ÍÑ…ÑÕÍ½‘”°Í•½¹¹ÍÑ…ÑÕÍ½‘•t¹Í½ÉĞ ¤¤¹Ñ½ÅÕ…°¡lÈÀÄ°€ĞÀåt¤ì((€€€€¼¼=¹”¥ÍÍÕ•É½Ü°½¹”¹Õµ‰•È°…¹Ñ¡”½Õ¹Ñ•È…‘Ù…¹••á…Ñ±ä½¹”ƒŠP(€€€€¼¼Ñ¡”±½Í•ÈÌÑÉ…¹Í…Ñ¥½¸É½±±•¥ÑÌ¥¹É•µ•¹Ğ‰…¬İ¥Ñ ¥Ğ¸(€€€½¹ÍĞmÉ½İt€ô…İ…¥Ğ…‘µ¥¸ñì½Õ¹ĞèÍÑÉ¥¹œìµ…á}Í•Äè¹Õµ‰•Èõmtù€(€€€€€Í•±•Ğ½Õ¹Ğ ¨¤èéÑ•áĞ…Ì½Õ¹Ğ°µ…à¡Í•ÅÕ•¹•}¹Õµ‰•È¤…Ìµ…á}Í•Ä(€€€€€™É½´ÁÕÉ¡…Í•}½É‘•ÉÌİ¡•É”¥€ô€‘íÉ…•%‘ô…¹ÍÑ…ÑÕÌ€ô€¥ÍÍÕ•œ(€€€€ì(€€€•áÁ•Ğ¡É½Üü¹½Õ¹Ğ¤¹Ñ½	” œÄœ¤ì(€€€•áÁ•Ğ¡É½Üü¹µ…á}Í•Ä¤¹Ñ½	” Ä¤ì(€€€½¹ÍĞm½Õ¹Ñ•Ét€ô…İ…¥Ğ…‘µ¥¸ñì¹•áÑ}Ù…±Õ”è¹Õµ‰•Èõmtù€(€€€€€Í•±•Ğ¹•áÑ}Ù…±Õ”™É½´ÁÕÉ¡…Í•}½É‘•É}½Õ¹Ñ•ÉÌİ¡•É”İ½É­}¥€ô€‘íÉ…”¹İ½É­%‘ô(€€€€ì(€€€•áÁ•Ğ¡½Õ¹Ñ•Èü¹¹•áÑ}Ù…±Õ”¤¹Ñ½	” Ä¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” Ñ•¹…¹Ğ¥Í½±…Ñ¥½¸œ°€ ¤€ôøì(€¥Ğ …¹Íİ•ÉÌ€ĞÀĞ™½È…¹½Ñ¡•ÈÑ•¹…¹Ğ…¹€ĞÀÌ™½È„™½É•¥¸½É…¹¥Í…Ñ¥½¸¡•…‘•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞm½É‘•Ét€ô…İ…¥Ğ…‘µ¥¸ñì¥èÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ğ¥™É½´ÁÕÉ¡…Í•}½É‘•ÉÌİ¡•É”İ½É­}¥€ô€‘íİ½É­%‘ô±¥µ¥Ğ€Ä(€€€€ì(€€€•áÁ•Ğ¡½É‘•È¤¹Ñ½	••™¥¹• ¤ì((€€€€¼¼…±±•È¥¸…¹½Ñ¡•È½É…¹¥Í…Ñ¥½¸°ÕÍ¥¹œÑ¡•¥È=]8¡•…‘•ÈèÑ¡”É½Ü¥Ì(€€€€¼¼¥¹Ù¥Í¥‰±”Õ¹‘•ÈI1L…¹…¹Íİ•ÉÌ•á…Ñ±ä±¥­”…¸Õ¹­¹½İ¸¥¸(€€€½¹ÍĞ¡¥‘‘•¸€ô…İ…¥Ğ…ÕÑ¡•¡½ÕÑÍ¥‘•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í½É‘•Èü¹¥€üü€œõ€°(€€€€€½É…¹¥Í…Ñ¥½¹%è½ÕÑÍ¥‘•É=É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡¡¥‘‘•¸¹ÍÑ…ÑÕÍ½‘”°¡¥‘‘•¸¹‰½‘ä¤¹Ñ½	” ĞÀĞ¤ì(€€€•áÁ•Ğ¡¡¥‘‘•¸¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€AUI!M}=II}9=Q}=U9œô¤ì((€€€€¼¼Q¡”Í…µ”…±±•È‰½ÉÉ½İ¥¹œ=UH¡•…‘•È¹•Ù•È‰¥¹‘ÌÑ¡”Ñ•¹…¹Ğ…Ğ…±°¸(€€€½¹ÍĞ‰½ÉÉ½İ•€ô…İ…¥Ğ…ÕÑ¡•¡½ÕÑÍ¥‘•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½ÁÕÉ¡…Í”µ½É‘•ÉÌ¼‘í½É‘•Èü¹¥€üü€œõ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡‰½ÉÉ½İ•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ĞÀÌ¤ì(€€€•áÁ•Ğ¡‰½ÉÉ½İ•¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€9=Q}}55	Hœô¤ì((€€€€¼¼¹Ñ¡”]½É¬µÍ½Á•±¥ÍĞÍ¡½İÌ„™½É•¥¸Ñ•¹…¹Ğ¹½Ñ¡¥¹œ¸(€€€½¹ÍĞ±¥ÍĞ€ô…İ…¥Ğ…ÕÑ¡•¡½ÕÑÍ¥‘•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½İ½É­Ì¼‘íİ½É­%‘ô½ÁÕÉ¡…Í”µ½É‘•ÉÍ€°(€€€€€½É…¹¥Í…Ñ¥½¹%è½ÕÑÍ¥‘•É=É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ğ¡±¥ÍĞ¹ÍÑ…ÑÕÍ½‘”°±¥ÍĞ¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ğ¡±¥ÍĞ¹©Í½¸ñAÕÉ¡…Í•=É‘•É1¥ÍÑI•ÍÁ½¹Í”ø ¤¹ÁÕÉ¡…Í•=É‘•ÉÌ¤¹Ñ½ÅÕ…°¡mt¤ì(€ô¤ì((€¥Ğ É•™ÕÍ•Ì•Ù•ÉäİÉ¥Ñ”Ñ¼…¸Õ¹…ÕÑ¡•¹Ñ¥…Ñ•…±±•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍĞÉ•ÍÁ½¹Í”€ô…İ…¥Ğ…ÁÀ¹¥¹©•Ğ¡ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½İ½É­Ì¼‘íİ½É­%‘ô½ÁÕÉ¡…Í”µ½É‘•ÉÍ€°(€€€€€¡•…‘•ÉÌèì€àµ½É…¹¥Í…Ñ¥½¸µ¥œè½É…¹¥Í…Ñ¥½¹%ô°(€€€€€Á…å±½…èìÙ•¹‘½É½¹Ñ…Ñ%èÙ•¹‘½É%°Á½…Ñ”è€œÈÀÈØ´Àà´Ààœô°(€€€ô¤ì(€€€•áÁ•Ğ¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ĞÀÄ¤ì(€€€•áÁ•Ğ¡É•ÍÁ½¹Í”¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ğ¡ì½‘”è€U9UQ!9Q%Qœô¤ì(€ô¤ì)ô¤ì(