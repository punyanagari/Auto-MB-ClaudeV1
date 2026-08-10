import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  EwayBillDetailResponse,
  EwayBillListResponse,
  MeasurementBookDetailResponse,
  TaxInvoiceDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * The e-way bill (migration 0035): the movement document for a
 * SUBMITTED tax invoice. What has to hold:
 *
 * - only a submitted invoice takes an e-way bill — refused by the route
 *   and by the 0035 insert trigger against raw SQL;
 * - one live e-way bill per invoice, the conflict naming the live one;
 * - the NIC payload is the canonical EWB JSON, pinned by golden
 *   deep-equals for BOTH carriage shapes: road (vehicleNo) and rail
 *   (transDocNo/transDocDate) — with the incomplete-carriage refusals
 *   surfacing as the same named 400s the 0035 CHECK backstops;
 * - nic-response moves draft -> generated exactly once, recording NIC's
 *   number and validity verbatim;
 * - an invoice cannot cancel under a live e-way bill; the e-way bill
 *   cancels first, behind the cancel authority;
 * - cross-tenant reads answer 404, anonymous requests 401.
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
const ownerEmail = `ewb-owner-${runId}@integration.test`;
const clerkEmail = `ewb-clerk-${runId}@integration.test`;
const viewerEmail = `ewb-viewer-${runId}@integration.test`;
const outsiderEmail = `ewb-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const workCode = `EWBW${runId.slice(0, 4).toUpperCase()}`;

const ORG_GSTIN = '07ABCDE1234F1Z5';
const ORG_ADDRESS = 'Plot 5, Okhla Phase II, New Delhi, 110020';
const BUYER_GSTIN = '07AAAGM0289C1ZL';
const BUYER_ADDRESS = 'DRM Office, State Entry Road, New Delhi, 110055';
const SERVICE_DESCRIPTION = 'Works contract services for signalling installation';
const SAC = '995421';
const TRANSPORTER_ID = '07ABCDE1234F1Z5';

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let workId: string;
let itemId: string;
let buyerContactId: string;
let submittedInvoiceId: string;
let draftInvoiceId: string;
let roadEwbId: string;
let railEwbId: string;

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

/** Challan -> on-account MB -> finalize -> tax invoice, all through the
 * real API; returns the invoice id still in DRAFT. */
async function draftInvoiceOn(
  mbDate: string,
  quantity: string,
  invoiceDate: string,
): Promise<string> {
  const challan = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-07-01',
      prefix: `${workCode}DC`,
      consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
      items: [{ workItemId: itemId, quantity }],
    },
  });
  expect(challan.statusCode, challan.body).toBe(201);
  const challanId = challan.json<ChallanDetailResponse>().challan.id;
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);

  const mb = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/measurement-books`,
    organisationId,
    payload: { mbDate, kind: 'on_account' },
  });
  expect(mb.statusCode, mb.body).toBe(201);
  const mbId = mb.json<MeasurementBookDetailResponse>().book.id;
  const sources = await authed(owner, {
    method: 'PUT',
    url: `/api/measurement-books/${mbId}/sources`,
    organisationId,
    payload: { sources: [{ sourceType: 'delivery_challan', sourceId: challanId }] },
  });
  expect(sources.statusCode, sources.body).toBe(200);
  const finalized = await authed(owner, {
    method: 'POST',
    url: `/api/measurement-books/${mbId}/finalize`,
    organisationId,
  });
  expect(finalized.statusCode, finalized.body).toBe(200);

  const invoice = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/tax-invoices`,
    organisationId,
    payload: {
      measurementBookId: mbId,
      invoiceDate,
      sacCode: SAC,
      serviceDescription: SERVICE_DESCRIPTION,
      gstRate: '18',
      placeOfSupply: '07',
      buyerContactId,
    },
  });
  expect(invoice.statusCode, invoice.body).toBe(201);
  return invoice.json<TaxInvoiceDetailResponse>().invoice.id;
}

function roadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transportMode: 'road',
    distanceKm: 25,
    fromPincode: '110020',
    toPincode: '110055',
    ...overrides,
  };
}

async function createEwayBill(
  invoiceId: string,
  body: Record<string, unknown>,
  jar: CookieJar = owner,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/tax-invoices/${invoiceId}/eway-bills`,
    organisationId,
    payload: body,
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-ewb-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the e-way bill integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ewb-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'EWB Owner');
  clerk = await signUp(clerkEmail, 'EWB Clerk');
  viewer = await signUp(viewerEmail, 'EWB Viewer');
  outsider = await signUp(outsiderEmail, 'EWB Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'EWB Constructions', slug: `ewb-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'EWB Outsiders', slug: `ewb-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

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
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  const profile = await authed(owner, {
    method: 'PATCH',
    url: '/api/organisation/profile',
    organisationId,
    payload: { stateCode: '07', gstin: ORG_GSTIN, address: ORG_ADDRESS },
  });
  expect(profile.statusCode, profile.body).toBe(200);

  workId = randomUUID();
  const scheduleId = randomUUID();
  itemId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${workCode}, ${`L-${workCode}`},
      '2025-06-01', 'E-way bill fixture work', '1000000.00', '900000.00',
      'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate
    )
    values (
      ${itemId}, ${organisationId}, ${workId}, ${scheduleId}, '1',
      'Signalling cable', 'mtr', 10000.000, 100.00
    )
  `;
  await admin`
    insert into payment_matrices (
      organisation_id, work_id, category, pct_supply, pct_installation,
      pct_pac, pct_final_bill, created_by_user_id
    )
    values (${organisationId}, ${workId}, 'UNCATEGORISED', '100.00', '0.00',
            '0.00', '0.00', ${ownerUserId})
  `;

  buyerContactId = randomUUID();
  await admin`
    insert into contacts (
      id, organisation_id, designation, contact_person, address, gstin,
      pincode, state_code, is_consignee, active, created_by_user_id
    )
    values (${buyerContactId}, ${organisationId}, 'Sr. DEE (G) NR', 'S K Verma',
            ${BUYER_ADDRESS}, ${BUYER_GSTIN}, '110055', '07', true, true,
            ${ownerUserId})
  `;

  // Invoice 1: submitted — 1000.00 taxable at 18% intra: 90 + 90, 1180.
  submittedInvoiceId = await draftInvoiceOn('2026-08-01', '10', '2026-08-05');
  const submitted = await authed(owner, {
    method: 'POST',
    url: `/api/tax-invoices/${submittedInvoiceId}/submit`,
    organisationId,
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  const invoice = submitted.json<TaxInvoiceDetailResponse>().invoice;
  expect(invoice.invoiceNumber).toBe('TI/2026-27/001');
  expect(invoice.taxableValue).toBe('1000.00');
  expect(invoice.totalAmount).toBe('1180.00');

  // Invoice 2: left in draft — the "no legal number to move" case.
  draftInvoiceId = await draftInvoiceOn('2026-08-02', '20', '2026-08-06');
}, 120_000);

afterAll(async () => {
  if (admin) {
    for (const org of [organisationId, outsiderOrganisationId]) {
      if (!org) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'work_assignments',
          'eway_bills',
          'tax_invoices',
          'tax_invoice_counters',
          'mb_sources',
          'measurement_book_lines',
          'measurement_book_counters',
          'bills',
          'measurement_books',
          'bill_counters',
          'payment_matrices',
          'contacts',
          'mb_entries',
          'challan_item_serials',
          'challan_receipts',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'work_items',
          'work_schedules',
          'works',
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
  if (storageDir !== undefined) {
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe('drafting the movement', () => {
  it('refuses a draft invoice, at the API and at the database', async () => {
    const refused = await createEwayBill(draftInvoiceId, roadBody());
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('TAX_INVOICE_STATUS_CONFLICT');

    // The 0035 insert trigger holds the same rule against every writer.
    await expect(
      admin`
        insert into eway_bills (
          organisation_id, tax_invoice_id, transport_mode, distance_km,
          from_pincode, to_pincode, created_by_user_id
        )
        values (${organisationId}, ${draftInvoiceId}, 'road', 10,
                '110020', '110055', ${ownerUserId})
      `,
    ).rejects.toThrowError(/needs a submitted invoice/);
  });

  it('drafts against the submitted invoice; one live per invoice; viewer refused', async () => {
    const denied = await createEwayBill(submittedInvoiceId, roadBody(), viewer);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');

    const first = await createEwayBill(submittedInvoiceId, roadBody());
    expect(first.statusCode, first.body).toBe(201);
    const throwawayId = first.json<EwayBillDetailResponse>().ewayBill.id;
    expect(first.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      taxInvoiceId: submittedInvoiceId,
      invoiceNumber: 'TI/2026-27/001',
      status: 'draft',
      transportMode: 'road',
      vehicleNumber: null,
      ewbNumber: null,
    });

    const conflict = await createEwayBill(submittedInvoiceId, roadBody());
    expect(conflict.statusCode).toBe(409);
    const conflictBody = conflict.json<{
      code: string;
      details?: { existingRecordId: string };
    }>();
    expect(conflictBody.code).toBe('EWAY_BILL_EXISTS');
    expect(conflictBody.details?.existingRecordId).toBe(throwawayId);

    // A draft deletes (rule 8), freeing the slot.
    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/eway-bills/${throwawayId}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);

    const second = await createEwayBill(submittedInvoiceId, roadBody());
    expect(second.statusCode, second.body).toBe(201);
    roadEwbId = second.json<EwayBillDetailResponse>().ewayBill.id;

    const read = await authed(owner, {
      method: 'GET',
      url: `/api/eway-bills/${roadEwbId}`,
      organisationId,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<EwayBillDetailResponse>().ewayBill.status).toBe('draft');
  });
});

describe('the NIC payload and response, road carriage', () => {
  it('refuses the incomplete carriage as the named 400s', async () => {
    const payload = await authed(owner, {
      method: 'GET',
      url: `/api/eway-bills/${roadEwbId}/nic-payload`,
      organisationId,
    });
    expect(payload.statusCode).toBe(400);
    expect(payload.json<{ code: string }>().code).toBe('VEHICLE_REQUIRED');

    const generated = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/nic-response`,
      organisationId,
      payload: {
        ewbNumber: '123456789012',
        ewbDate: '2026-08-06T10:00:00.000Z',
        validUntil: '2026-08-07T23:59:59.000Z',
      },
    });
    expect(generated.statusCode).toBe(400);
    expect(generated.json<{ code: string }>().code).toBe('VEHICLE_REQUIRED');
  });

  it('serves the canonical NIC EWB JSON once the vehicle is named — golden', async () => {
    const edited = await authed(owner, {
      method: 'PUT',
      url: `/api/eway-bills/${roadEwbId}`,
      organisationId,
      payload: roadBody({
        transporterId: TRANSPORTER_ID,
        transporterName: '  Sharma Roadways  ',
        vehicleNumber: 'DL01AB1234',
      }),
    });
    expect(edited.statusCode, edited.body).toBe(200);
    // Stored trimmed, exactly as the column measures it.
    expect(edited.json<EwayBillDetailResponse>().ewayBill.transporterName).toBe(
      'Sharma Roadways',
    );

    const response = await authed(owner, {
      method: 'GET',
      url: `/api/eway-bills/${roadEwbId}/nic-payload`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toStrictEqual({
      supplyType: 'O',
      subSupplyType: '1',
      docType: 'INV',
      docNo: 'TI/2026-27/001',
      docDate: '05/08/2026',
      fromGstin: ORG_GSTIN,
      fromTrdName: 'EWB Constructions',
      fromAddr1: ORG_ADDRESS,
      fromPlace: 'New Delhi',
      fromPincode: 110020,
      fromStateCode: 7,
      actFromStateCode: 7,
      toGstin: BUYER_GSTIN,
      toTrdName: 'Sr. DEE (G) NR',
      toAddr1: BUYER_ADDRESS,
      toPlace: 'New Delhi',
      toPincode: 110055,
      toStateCode: 7,
      actToStateCode: 7,
      transactionType: 1,
      itemList: [
        {
          itemNo: 1,
          productDesc: SERVICE_DESCRIPTION,
          hsnCode: 995421,
          quantity: 1,
          qtyUnit: 'OTH',
          taxableAmount: 1000,
          cgstRate: 9,
          sgstRate: 9,
          igstRate: 0,
          cessRate: 0,
        },
      ],
      totalValue: 1000,
      cgstValue: 90,
      sgstValue: 90,
      igstValue: 0,
      cessValue: 0,
      totInvValue: 1180,
      transMode: '1',
      transDistance: '25',
      transporterId: TRANSPORTER_ID,
      transporterName: 'Sharma Roadways',
      vehicleNo: 'DL01AB1234',
    });
  });

  it('records the NIC response verbatim, moving draft -> generated once', async () => {
    // Recording what NIC decided is clerical: an office writer without
    // issue/cancel authority does it.
    const generated = await authed(clerk, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/nic-response`,
      organisationId,
      payload: {
        ewbNumber: '123456789012',
        ewbDate: '2026-08-06T10:00:00.000Z',
        validUntil: '2026-08-07T23:59:59.000Z',
      },
    });
    expect(generated.statusCode, generated.body).toBe(200);
    const bill = generated.json<EwayBillDetailResponse>().ewayBill;
    expect(bill).toMatchObject({
      status: 'generated',
      ewbNumber: '123456789012',
      ewbDate: '2026-08-06T10:00:00.000Z',
      validUntil: '2026-08-07T23:59:59.000Z',
    });
    expect(bill.generatedAt).not.toBeNull();

    // Generated is frozen: no second response, no edits, no delete.
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/nic-response`,
      organisationId,
      payload: {
        ewbNumber: '999999999999',
        ewbDate: '2026-08-06T11:00:00.000Z',
        validUntil: '2026-08-08T23:59:59.000Z',
      },
    });
    expect(again.statusCode).toBe(409);
    const edit = await authed(owner, {
      method: 'PUT',
      url: `/api/eway-bills/${roadEwbId}`,
      organisationId,
      payload: roadBody({ vehicleNumber: 'DL01AB1234' }),
    });
    expect(edit.statusCode).toBe(409);
    const del = await authed(owner, {
      method: 'DELETE',
      url: `/api/eway-bills/${roadEwbId}`,
      organisationId,
    });
    expect(del.statusCode).toBe(409);

    // The carriage CHECK is the database's own: raw SQL cannot strip the
    // vehicle off a generated road movement either.
    await expect(
      admin`update eway_bills set vehicle_number = null where id = ${roadEwbId}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('holds the cancel order: invoice refuses under a live e-way bill', async () => {
    const invoiceCancel = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${submittedInvoiceId}/cancel`,
      organisationId,
      payload: { note: 'trying to cancel under a live movement' },
    });
    expect(invoiceCancel.statusCode).toBe(409);
    expect(invoiceCancel.json<{ code: string }>().code).toBe('EWAY_BILL_LIVE');

    const unauthorised = await authed(clerk, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/cancel`,
      organisationId,
      payload: { note: 'clerk cannot cancel' },
    });
    expect(unauthorised.statusCode).toBe(403);
    expect(unauthorised.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/cancel`,
      organisationId,
      payload: { note: 'vehicle broke down before dispatch' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const bill = cancelled.json<EwayBillDetailResponse>().ewayBill;
    expect(bill.status).toBe('cancelled');
    // The 0035 generated-shape CHECK clears the NIC fields off a
    // cancelled row — the voided number survives in the audit trail.
    expect(bill.ewbNumber).toBeNull();
    expect(bill.cancellationNote).toBe('vehicle broke down before dispatch');
    const [event] = await admin<{ details: { ewbNumber?: string } }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and entity_type = 'eway_bills' and entity_id = ${roadEwbId}
        and action = 'eway_bill.cancelled'
      order by occurred_at desc, id desc
      limit 1
    `;
    expect(event?.details.ewbNumber).toBe('123456789012');
  });
});

describe('rail carriage', () => {
  it('drafts on the freed slot and serves the rail payload shape — golden', async () => {
    const created = await createEwayBill(submittedInvoiceId, {
      transportMode: 'rail',
      transportDocNumber: 'RR-123456',
      transportDocDate: '2026-08-06',
      distanceKm: 900,
      fromPincode: '110020',
      toPincode: '110055',
    });
    expect(created.statusCode, created.body).toBe(201);
    railEwbId = created.json<EwayBillDetailResponse>().ewayBill.id;

    const response = await authed(owner, {
      method: 'GET',
      url: `/api/eway-bills/${railEwbId}/nic-payload`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    // Rail carriage: transDocNo/transDocDate carry the movement, no
    // vehicleNo key at all; the omitted transporter stays omitted.
    expect(response.json()).toStrictEqual({
      supplyType: 'O',
      subSupplyType: '1',
      docType: 'INV',
      docNo: 'TI/2026-27/001',
      docDate: '05/08/2026',
      fromGstin: ORG_GSTIN,
      fromTrdName: 'EWB Constructions',
      fromAddr1: ORG_ADDRESS,
      fromPlace: 'New Delhi',
      fromPincode: 110020,
      fromStateCode: 7,
      actFromStateCode: 7,
      toGstin: BUYER_GSTIN,
      toTrdName: 'Sr. DEE (G) NR',
      toAddr1: BUYER_ADDRESS,
      toPlace: 'New Delhi',
      toPincode: 110055,
      toStateCode: 7,
      actToStateCode: 7,
      transactionType: 1,
      itemList: [
        {
          itemNo: 1,
          productDesc: SERVICE_DESCRIPTION,
          hsnCode: 995421,
          quantity: 1,
          qtyUnit: 'OTH',
          taxableAmount: 1000,
          cgstRate: 9,
          sgstRate: 9,
          igstRate: 0,
          cessRate: 0,
        },
      ],
      totalValue: 1000,
      cgstValue: 90,
      sgstValue: 90,
      igstValue: 0,
      cessValue: 0,
      totInvValue: 1180,
      transMode: '2',
      transDistance: '900',
      transDocNo: 'RR-123456',
      transDocDate: '06/08/2026',
    });
  });

  it('demands the transport document before NIC can answer', async () => {
    // Drop the doc date: the carriage is incomplete again.
    const stripped = await authed(owner, {
      method: 'PUT',
      url: `/api/eway-bills/${railEwbId}`,
      organisationId,
      payload: {
        transportMode: 'rail',
        transportDocNumber: 'RR-123456',
        distanceKm: 900,
        fromPincode: '110020',
        toPincode: '110055',
      },
    });
    expect(stripped.statusCode, stripped.body).toBe(200);

    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${railEwbId}/nic-response`,
      organisationId,
      payload: {
        ewbNumber: '210987654321',
        ewbDate: '2026-08-07T09:00:00.000Z',
        validUntil: '2026-08-10T23:59:59.000Z',
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe('TRANSPORT_DOC_REQUIRED');

    const restored = await authed(owner, {
      method: 'PUT',
      url: `/api/eway-bills/${railEwbId}`,
      organisationId,
      payload: {
        transportMode: 'rail',
        transportDocNumber: 'RR-123456',
        transportDocDate: '2026-08-06',
        distanceKm: 900,
        fromPincode: '110020',
        toPincode: '110055',
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);

    const generated = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${railEwbId}/nic-response`,
      organisationId,
      payload: {
        ewbNumber: '210987654321',
        ewbDate: '2026-08-07T09:00:00.000Z',
        validUntil: '2026-08-10T23:59:59.000Z',
      },
    });
    expect(generated.statusCode, generated.body).toBe(200);
    expect(generated.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      status: 'generated',
      ewbNumber: '210987654321',
      transportMode: 'rail',
      transportDocNumber: 'RR-123456',
      transportDocDate: '2026-08-06',
    });
  });

  it('closes the whole chain: e-way bill cancelled, then the invoice', async () => {
    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${submittedInvoiceId}/cancel`,
      organisationId,
      payload: { note: 'still moving under the rail e-way bill' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe('EWAY_BILL_LIVE');

    const ewbCancelled = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${railEwbId}/cancel`,
      organisationId,
      payload: { note: 'consignment did not move' },
    });
    expect(ewbCancelled.statusCode, ewbCancelled.body).toBe(200);

    const invoiceCancelled = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${submittedInvoiceId}/cancel`,
      organisationId,
      payload: { note: 'billing period re-cast' },
    });
    expect(invoiceCancelled.statusCode, invoiceCancelled.body).toBe(200);
    expect(invoiceCancelled.json<TaxInvoiceDetailResponse>().invoice.status).toBe(
      'cancelled',
    );
  });
});

describe('listing, tenancy, and scope', () => {
  it('lists the invoice movements, newest first, with the invoice number', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${submittedInvoiceId}/eway-bills`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { ewayBills } = response.json<EwayBillListResponse>();
    expect(ewayBills.length).toBe(2);
    expect(ewayBills.every((bill) => bill.status === 'cancelled')).toBe(true);
    expect(ewayBills.every((bill) => bill.invoiceNumber === 'TI/2026-27/001')).toBe(
      true,
    );
  });

  it('answers 404 across tenants and 401 without a session', async () => {
    const read = await authed(outsider, {
      method: 'GET',
      url: `/api/eway-bills/${railEwbId}`,
      organisationId: outsiderOrganisationId,
    });
    expect(read.statusCode).toBe(404);

    const list = await authed(outsider, {
      method: 'GET',
      url: `/api/tax-invoices/${submittedInvoiceId}/eway-bills`,
      organisationId: outsiderOrganisationId,
    });
    expect(list.statusCode).toBe(404);

    const payload = await authed(outsider, {
      method: 'GET',
      url: `/api/eway-bills/${railEwbId}/nic-payload`,
      organisationId: outsiderOrganisationId,
    });
    expect(payload.statusCode).toBe(404);

    const edit = await authed(outsider, {
      method: 'PUT',
      url: `/api/eway-bills/${railEwbId}`,
      organisationId: outsiderOrganisationId,
      payload: roadBody(),
    });
    expect(edit.statusCode).toBe(404);

    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/eway-bills/${railEwbId}`,
      headers: { 'x-organisation-id': organisationId },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
