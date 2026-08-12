import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  BudgetaryQuotationDetailResponse,
  PurchaseOrderDetailResponse,
  TaxInvoiceDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations, withTenant } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Finding 47, money-and-legal subset, item (c): raw-SQL parent
 * immutability for every issued legal document family the 0041/0045
 * guards freeze — tax invoices, e-way bills, purchase orders and
 * budgetary quotations.
 *
 * The line rows were frozen earlier; these are the PARENT rows, whose
 * numbers and totals are the money and the legal identity. Each negative
 * runs as the ordinary application writer (app role, bound tenant
 * transaction) so a buggy or compromised handler is exactly what is being
 * simulated, and each asserts the row afterwards so a guard that merely
 * warns cannot pass.
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
const ownerEmail = `f47pi-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const ORG_GSTIN = '07ABCDE1234F1Z5';
const BUYER_GSTIN = '07AAAGM0289C1ZL';

let admin: Sql;
let appDb: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let buyerContactId: string;
let vendorContactId: string;
let workId: string;

let invoiceId: string;
let invoiceNumber: string;
let ewbId: string;
let purchaseOrderId: string;
let poNumber: string;
let quotationId: string;
let bqNumber: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;

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

/** Runs one raw statement as the ordinary application writer and returns
 * the refusal text; accepting the write fails the test. */
async function rawWriteRefusal(
  statement: (tx: Sql) => Promise<unknown>,
): Promise<string> {
  try {
    await withTenant(appDb, { organisationId, userId: ownerUserId }, async (tx) => {
      await statement(tx as unknown as Sql);
    });
  } catch (error) {
    return String(error);
  }
  throw new Error('the raw write was accepted; the guard is gone');
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-f47pi-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the finding-47 parent-immutability tests. ' +
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

  appDb = createDatabasePool({
    url: appUrl,
    max: 1,
    applicationName: 'auto-mb-f47pi-raw-writer',
  });

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-f47pi-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'F47 PI Owner');
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'F47 Parent Immutability', slug: `f47pi-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

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
    payload: {
      stateCode: '07',
      gstin: ORG_GSTIN,
      address: 'Plot 12, Industrial Area, New Delhi, 110002',
      pincode: '110002',
      locality: 'New Delhi',
      einvoiceApplicability: 'applicable',
      einvoiceApplicableFrom: '2017-07-01',
    },
  });
  expect(profile.statusCode, profile.body).toBe(200);

  buyerContactId = randomUUID();
  vendorContactId = randomUUID();
  await admin`
    insert into contacts (
      id, organisation_id, designation, contact_person, address, gstin,
      pincode, state_code, locality, is_consignee, is_vendor, active,
      created_by_user_id
    )
    values
      (${buyerContactId}, ${organisationId}, 'Sr. DEE (G) NR', 'S K Verma',
       'DRM Office, State Entry Road, New Delhi, 110055', ${BUYER_GSTIN},
       '110055', '07', 'New Delhi', true, false, true, ${ownerUserId}),
      (${vendorContactId}, ${organisationId}, ${`Bharat Cables Pvt Ltd ${runId}`},
       'R. Nair', 'Plot 12, MIDC, Pune', '27AABCB1234C1ZP', '411019', '27',
       'Pune', false, true, true, ${ownerUserId})
  `;

  // The purchase order hangs off a Work; seed the Work directly.
  workId = randomUUID();
  const scheduleId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`F47PI${runId.slice(0, 4).toUpperCase()}`},
      ${`L-F47PI-${runId}`}, '2025-06-01', 'Parent immutability fixture work',
      '1000000.00', '900000.00', 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;

  // Submitted direct tax invoice.
  const invoiceCreated = await authed(owner, {
    method: 'POST',
    url: '/api/tax-invoices',
    organisationId,
    payload: {
      invoiceDate: '2026-02-15',
      sacCode: '998734',
      serviceDescription: 'Finding-47 parent immutability fixture invoice.',
      gstRate: '18',
      placeOfSupply: '07',
      reverseChargeApplicable: false,
      buyerContactId,
      taxableValue: '1000.00',
    },
  });
  expect(invoiceCreated.statusCode, invoiceCreated.body).toBe(201);
  invoiceId = invoiceCreated.json<TaxInvoiceDetailResponse>().invoice.id;
  const submitted = await authed(owner, {
    method: 'POST',
    url: `/api/tax-invoices/${invoiceId}/submit`,
    organisationId,
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  invoiceNumber =
    submitted.json<TaxInvoiceDetailResponse>().invoice.invoiceNumber ?? '';
  expect(invoiceNumber).not.toBe('');

  // Generated e-way bill with complete NIC evidence, seeded directly.
  ewbId = randomUUID();
  await admin`
    insert into eway_bills (
      id, organisation_id, tax_invoice_id, status, transport_mode,
      vehicle_number, distance_km, from_pincode, to_pincode,
      ewb_number, ewb_date, valid_until, ewb_date_text, valid_until_text,
      provider, provider_state, legacy_evidence_missing,
      generated_by_user_id, generated_at, created_by_user_id
    ) values (
      ${ewbId}, ${organisationId}, ${invoiceId}, 'generated', 'road',
      'DL01AB1234', 25, '110020', '110055', '123456789012',
      '2026-02-15T09:00:00.000Z', '2026-02-16T23:59:59.000Z',
      '15/02/2026 14:30:00', '16/02/2026 23:59:59',
      'manual', 'generated', false, ${ownerUserId}, now(), ${ownerUserId}
    )
  `;

  // Issued purchase order through the routes.
  const poCreated = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/purchase-orders`,
    organisationId,
    payload: { vendorContactId, poDate: '2026-02-10' },
  });
  expect(poCreated.statusCode, poCreated.body).toBe(201);
  purchaseOrderId = poCreated.json<PurchaseOrderDetailResponse>().purchaseOrder.id;
  const poLines = await authed(owner, {
    method: 'PUT',
    url: `/api/purchase-orders/${purchaseOrderId}/lines`,
    organisationId,
    payload: {
      lines: [
        { description: 'Consumable pack', unitCode: 'Nos', quantity: '2', rate: '150' },
      ],
    },
  });
  expect(poLines.statusCode, poLines.body).toBe(200);
  const poIssued = await authed(owner, {
    method: 'POST',
    url: `/api/purchase-orders/${purchaseOrderId}/issue`,
    organisationId,
  });
  expect(poIssued.statusCode, poIssued.body).toBe(201);
  poNumber = poIssued.json<PurchaseOrderDetailResponse>().purchaseOrder.poNumber ?? '';
  expect(poNumber).not.toBe('');

  // Issued budgetary quotation through the routes.
  const bqCreated = await authed(owner, {
    method: 'POST',
    url: '/api/budgetary-quotations',
    organisationId,
    payload: {
      addressedTo: 'M/s Northern Traction Works',
      subject: 'Finding-47 parent immutability fixture quotation',
      bqDate: '2026-02-10',
    },
  });
  expect(bqCreated.statusCode, bqCreated.body).toBe(201);
  quotationId =
    bqCreated.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation.id;
  const bqLines = await authed(owner, {
    method: 'PUT',
    url: `/api/budgetary-quotations/${quotationId}/lines`,
    organisationId,
    payload: {
      lines: [
        {
          description: 'Main switchboard, 25kV outdoor type',
          unitCode: 'Nos',
          quantity: '3',
          rate: '100.50',
          gstRate: '18',
        },
      ],
    },
  });
  expect(bqLines.statusCode, bqLines.body).toBe(200);
  const bqIssued = await authed(owner, {
    method: 'POST',
    url: `/api/budgetary-quotations/${quotationId}/issue`,
    organisationId,
  });
  expect(bqIssued.statusCode, bqIssued.body).toBe(201);
  bqNumber =
    bqIssued.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation.bqNumber ?? '';
  expect(bqNumber).not.toBe('');
}, 90_000);

afterAll(async () => {
  if (admin) {
    if (organisationId) {
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'statutory_provider_operations',
          'tax_invoice_renders',
          'eway_bills',
          'tax_invoices',
          'tax_invoice_counters',
          'purchase_order_lines',
          'purchase_orders',
          'purchase_order_counters',
          'budgetary_quotation_lines',
          'budgetary_quotations',
          'budgetary_quotation_counters',
          'document_number_series',
          'work_items',
          'work_schedules',
          'works',
          'contacts',
          'gst_rates',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [organisationId],
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
  await appDb?.end();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('finding 47(c) — issued tax invoice parent facts are immutable to raw SQL', () => {
  it('refuses to move the money', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices
        set taxable_value = '999.00', total_amount = '1178.82'
        where id = ${invoiceId}
      `,
    );
    expect(refusal).toMatch(/submitted tax invoice business facts are immutable/);
  });

  it('refuses to rename the legal number or replace the frozen snapshot', async () => {
    const renamed = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices set invoice_number = 'FORGED/2026/001'
        where id = ${invoiceId}
      `,
    );
    expect(renamed).toMatch(/submitted tax invoice business facts are immutable/);

    const replaced = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices set issued_snapshot = '{"forged":true}'::jsonb
        where id = ${invoiceId}
      `,
    );
    expect(replaced).toMatch(/submitted tax invoice business facts are immutable/);

    const [row] = await admin<{ invoice_number: string; taxable_value: string }[]>`
      select invoice_number, taxable_value::text as taxable_value
      from tax_invoices where id = ${invoiceId}
    `;
    expect(row?.invoice_number).toBe(invoiceNumber);
    expect(row?.taxable_value).toBe('1000.00');
  });
});

describe('finding 47(c) — generated e-way bill facts are immutable to raw SQL', () => {
  it('refuses to renumber the bill or repoint its carriage', async () => {
    const renumbered = await rawWriteRefusal(
      (tx) => tx`
        update eway_bills set ewb_number = '999999999999'
        where id = ${ewbId}
      `,
    );
    expect(renumbered).toMatch(
      /generated e-way bill facts and NIC evidence are immutable/,
    );

    const repointed = await rawWriteRefusal(
      (tx) => tx`
        update eway_bills set vehicle_number = 'DL99ZZ9999'
        where id = ${ewbId}
      `,
    );
    expect(repointed).toMatch(
      /generated e-way bill facts and NIC evidence are immutable/,
    );

    const [row] = await admin<{ ewb_number: string; vehicle_number: string }[]>`
      select ewb_number, vehicle_number from eway_bills where id = ${ewbId}
    `;
    expect(row?.ewb_number).toBe('123456789012');
    expect(row?.vehicle_number).toBe('DL01AB1234');
  });
});

describe('finding 47(c) — issued purchase order parent facts are immutable to raw SQL', () => {
  it('refuses to move the money, the number or the date', async () => {
    for (const [label, statement] of [
      [
        'total',
        (tx: Sql) => tx`
        update purchase_orders set total_amount = '1.00'
        where id = ${purchaseOrderId}
      `,
      ],
      [
        'number',
        (tx: Sql) => tx`
        update purchase_orders set po_number = 'FORGED-PO-1'
        where id = ${purchaseOrderId}
      `,
      ],
      // A date still inside the Work's legal window, so the immutability
      // guard is what refuses it, not the LOA date-window trigger.
      [
        'date',
        (tx: Sql) => tx`
        update purchase_orders set po_date = '2026-03-01'
        where id = ${purchaseOrderId}
      `,
      ],
    ] as const) {
      const refusal = await rawWriteRefusal(statement);
      expect(refusal, label).toMatch(
        /issued purchase order business data is immutable/,
      );
    }
  });

  it('refuses to slide an issued order back to draft', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update purchase_orders set status = 'draft'
        where id = ${purchaseOrderId}
      `,
    );
    expect(refusal).toMatch(/issued purchase order lifecycle transition is invalid/);

    const [row] = await admin<
      { status: string; po_number: string; total_amount: string }[]
    >`
      select status, po_number, total_amount::text as total_amount
      from purchase_orders where id = ${purchaseOrderId}
    `;
    expect(row?.status).toBe('issued');
    expect(row?.po_number).toBe(poNumber);
    expect(row?.total_amount).toBe('300.00');
  });
});

describe('finding 47(c) — issued budgetary quotation parent facts are immutable to raw SQL', () => {
  it('refuses to move the money or the number', async () => {
    const moved = await rawWriteRefusal(
      (tx) => tx`
        update budgetary_quotations set total_amount = '1.00'
        where id = ${quotationId}
      `,
    );
    expect(moved).toMatch(/issued budgetary quotation business data is immutable/);

    const renamed = await rawWriteRefusal(
      (tx) => tx`
        update budgetary_quotations set bq_number = 'FORGED-BQ-1'
        where id = ${quotationId}
      `,
    );
    expect(renamed).toMatch(/issued budgetary quotation business data is immutable/);
  });

  it('refuses to slide an issued quotation back to draft', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update budgetary_quotations set status = 'draft'
        where id = ${quotationId}
      `,
    );
    expect(refusal).toMatch(
      /issued budgetary quotation lifecycle transition is invalid/,
    );

    const [row] = await admin<{ status: string; bq_number: string }[]>`
      select status, bq_number from budgetary_quotations
      where id = ${quotationId}
    `;
    expect(row?.status).toBe('issued');
    expect(row?.bq_number).toBe(bqNumber);
  });
});
