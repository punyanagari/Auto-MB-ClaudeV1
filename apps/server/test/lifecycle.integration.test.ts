import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  Contact,
  EwayBillDetailResponse,
  MeasurementBookDetailResponse,
  PurchaseOrderDetailResponse,
  TaxInvoiceDetailResponse,
  WorkCompletionReadiness,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * The complete post-award lifecycle, end to end through the real API —
 * one Work walked from LOA confirmation to completion, with every money
 * figure asserted as the exact decimal string the API answers:
 *
 *  1. LOA PDF uploaded and confirmed into a Work carrying two supply
 *     items and a pure-installation item; organisation tax facts and the
 *     consignee/vendor/client contacts set first; item categories and the
 *     payment matrix written through their APIs.
 *  2. A purchase order to the vendor for the supply items, issued with a
 *     gapless number and a frozen vendor snapshot.
 *  3. A delivery challan whose items map onto the purchase-order lines;
 *     issuing it moves the derived received balance, and the order closes
 *     only once every line is fully received.
 *  4. The pure-installation item recorded installed on site.
 *  5. TWO consignees fill TWO record MBs in parallel over disjoint
 *     sources; the one-live-claim rule is proven while they run; the main
 *     consignee merges them into the on-account MB that finalizes as
 *     <work>-MB-01.
 *  6. The cumulative tax invoice (one service line at a SAC) submitted
 *     against MB-01 — FY number, intra-state split and totals exact —
 *     then the IRP response, the closure rule (an invoiced MB can no
 *     longer be cancelled), and the e-way bill through its NIC payload
 *     and response.
 *  7. The remainder delivered and installed, swept by a Measurement Book
 *     of kind FINAL (never an on-account) that finalizes as MB-02, is
 *     invoiced and submitted; no MB of any kind may follow it.
 *  8. The readiness endpoint answers ready, the Work completes, and a
 *     completed Work refuses new operational documents.
 *
 * Refusals are proven inline exactly where the lifecycle makes them
 * meaningful: closing a part-received order, a second claim on a claimed
 * source, cancelling a claimed challan, an incomplete final sweep,
 * cancelling the invoiced MB, raising an MB after the final one, and
 * drafting a challan against the completed Work.
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
const ownerEmail = `lc-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const workCode = `LCW${runId.slice(0, 4).toUpperCase()}`;
const LETTER_DATE = '2025-06-01';

const ORG_NAME = 'Lifecycle Constructions';
const ORG_GSTIN = '07ABCDE1234F1Z5';
const ORG_ADDRESS = 'Plot 12, Industrial Area, New Delhi, 110002';
const BUYER_GSTIN = '07AAAGM0289C1ZL';
const BUYER_ADDRESS = 'DRM Office, State Entry Road, New Delhi, 110055';
const VENDOR_GSTIN = '27AABCB1234C1ZP';
const SERVICE_DESCRIPTION = 'Works contract services for signalling installation';
const SAC = '995421';
const TRANSPORTER_ID = '07ABCDE1234F1Z5';

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;

// The lifecycle's running state, in the order the story builds it.
let consignee1Id: string; // fills record MB 1, then merges (the main consignee)
let consignee2Id: string; // fills record MB 2 in parallel
let vendorContactId: string;
let buyerContactId: string;
let workId: string;
let cableItemId: string; // item 1: SUPPLY, 100 Mtr @ 250.00
let relayItemId: string; // item 2: SUPPLY, 10 Nos @ 1200.00
let installItemId: string; // item 3: PURE_INSTALLATION, 5 Nos @ 400.00
let purchaseOrderId: string;
let poLineCableId: string;
let poLineRelayId: string;
let challan1Id: string;
let challan2Id: string;
let installation1Id: string;
let installation2Id: string;
let record1Id: string;
let record2Id: string;
let mb1Id: string;
let mb2Id: string;
let invoice1Id: string;
let ewayBillId: string;

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

/** A minimal but structurally valid single-page PDF whose text layer is
 * exactly `text`, with a correct xref table — enough for pdftotext to
 * extract it without repair heuristics. ASCII input only. */
function buildTestPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    4: `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 1; index <= 5; index += 1) {
    offsets[index] = pdf.length;
    pdf += `${String(index)} 0 obj\n${objects[index] ?? ''}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let index = 1; index <= 5; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function createContact(body: Record<string, unknown>): Promise<Contact> {
  const response = await authed(owner, {
    method: 'POST',
    url: '/api/masters/contacts',
    organisationId,
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Contact>();
}

async function getPurchaseOrder(): Promise<PurchaseOrderDetailResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/purchase-orders/${purchaseOrderId}`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PurchaseOrderDetailResponse>();
}

async function setSources(
  mbId: string,
  sources: { sourceType: string; sourceId: string }[],
) {
  return authed(owner, {
    method: 'PUT',
    url: `/api/measurement-books/${mbId}/sources`,
    organisationId,
    payload: { sources },
  });
}

async function finalize(mbId: string) {
  return authed(owner, {
    method: 'POST',
    url: `/api/measurement-books/${mbId}/finalize`,
    organisationId,
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-lc-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the lifecycle integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-lc-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'LC Owner');
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: ORG_NAME, slug: `lc-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing');
  ownerUserId = ownerUser.id;
  // Issue and cancel are explicit authorities on top of the writer role.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
}, 120_000);

afterAll(async () => {
  if (admin) {
    if (organisationId) {
      // The immutability triggers (rightly) block deleting issued rows;
      // fixture cleanup is exactly what session_replication_role is for.
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
          'mb_entries',
          'installation_serials',
          'installations',
          'location_masters',
          'challan_item_serials',
          'challan_receipts',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'purchase_order_lines',
          'purchase_order_counters',
          'purchase_orders',
          'contacts',
          'loa_documents',
          'work_items',
          'work_schedules',
          'works',
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
  await admin?.end();
  if (storageDir !== undefined) {
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe('1 — LOA to Work', () => {
  it('sets the organisation tax facts and the consignee, vendor, and client contacts', async () => {
    const profile = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { stateCode: '07', gstin: ORG_GSTIN, address: ORG_ADDRESS },
    });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json<{ stateCode: string; gstin: string }>()).toMatchObject({
      stateCode: '07',
      gstin: ORG_GSTIN,
    });

    // Two consignees for the parallel record MBs.
    consignee1Id = (
      await createContact({
        designation: `Sr. DEE (TRD) CR ${runId}`,
        address: 'Divisional office, Delhi Division',
        stateCode: '07',
      })
    ).id;
    consignee2Id = (
      await createContact({
        designation: `Dy. CSTE (Con) CR ${runId}`,
        address: 'Construction office, Kashmere Gate',
        stateCode: '07',
      })
    ).id;

    // The vendor and the client (invoice buyer). The contacts API creates
    // every contact in the consignee role — the vendor/client role flags
    // are 0028 columns no route sets yet — so the roles are flipped with
    // admin SQL, exactly as the purchase-order suite seeds its vendors.
    vendorContactId = (
      await createContact({
        designation: `Bharat Cables Pvt Ltd ${runId}`,
        contactPerson: 'R. Nair',
        address: 'Plot 12, MIDC, Pune',
        gstin: VENDOR_GSTIN,
        pincode: '411019',
        stateCode: '27',
      })
    ).id;
    await admin`
      update contacts set is_vendor = true, is_consignee = false
      where id = ${vendorContactId}
    `;
    buyerContactId = (
      await createContact({
        designation: 'Sr. DEE (G) NR',
        contactPerson: 'S K Verma',
        address: BUYER_ADDRESS,
        gstin: BUYER_GSTIN,
        pincode: '110055',
        stateCode: '07',
      })
    ).id;
    await admin`
      update contacts set is_client = true where id = ${buyerContactId}
    `;
  }, 30_000);

  it('uploads the LOA PDF and confirms it into the Work', async () => {
    const uploaded = await authed(owner, {
      method: 'POST',
      url: '/api/loa-documents?filename=lifecycle-loa.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: buildTestPdf('Auto-MB lifecycle LOA letter'),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const document = uploaded.json<{ id: string; extractionStatus: string }>();
    expect(document.extractionStatus).toBe('review');

    // The reviewer types the three awarded items in; the parsed test
    // letter names none, so every row carries the manual-entry marker.
    const confirmed = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${document.id}/confirm`,
      organisationId,
      payload: {
        workCode,
        letterNumber: `L-${workCode}`,
        letterDate: LETTER_DATE,
        title: 'Signalling supply and installation lifecycle work',
        advertisedValue: '40000.00',
        contractValue: '39000.00',
        pricingShape: 'per_schedule',
        schedules: [
          {
            scheduleCode: 'A',
            title: 'Schedule A',
            items: [
              {
                itemNumber: '1',
                description: 'Signalling cable',
                unitCode: 'Mtr',
                awardedQuantity: '100',
                effectiveRate: '250.00',
                manualEntry: true,
              },
              {
                itemNumber: '2',
                description: 'Relay unit',
                unitCode: 'Nos',
                awardedQuantity: '10',
                effectiveRate: '1200.00',
                manualEntry: true,
              },
              {
                itemNumber: '3',
                description: 'Installation of signalling gear',
                unitCode: 'Nos',
                awardedQuantity: '5',
                effectiveRate: '400.00',
                manualEntry: true,
              },
            ],
          },
        ],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const detail = confirmed.json<WorkDetailResponse>();
    workId = detail.work.id;
    expect(detail.work.workCode).toBe(workCode);
    expect(detail.work.contractValue).toBe('39000.00');
    expect(detail.work.status).toBe('active');
    const items = detail.schedules[0]?.items ?? [];
    expect(items).toHaveLength(3);
    cableItemId = items.find((item) => item.itemNumber === '1')?.id ?? '';
    relayItemId = items.find((item) => item.itemNumber === '2')?.id ?? '';
    installItemId = items.find((item) => item.itemNumber === '3')?.id ?? '';
    expect(cableItemId && relayItemId && installItemId).toBeTruthy();
  }, 30_000);

  it('categorises the items and writes the payment matrix through the API', async () => {
    for (const [itemId, category] of [
      [cableItemId, 'SUPPLY'],
      [relayItemId, 'SUPPLY'],
      [installItemId, 'PURE_INSTALLATION'],
    ] as const) {
      const response = await authed(owner, {
        method: 'PATCH',
        url: `/api/work-items/${itemId}/payment-category`,
        organisationId,
        payload: { paymentCategory: category },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ paymentCategory: string }>().paymentCategory).toBe(
        category,
      );
    }

    // SUPPLY pays 90% on delivery and holds 10% for the final bill;
    // PURE_INSTALLATION pays 80% on erection and holds 20%.
    const supplyRow = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/payment-matrix/SUPPLY`,
      organisationId,
      payload: {
        pctSupply: '90',
        pctInstallation: '0',
        pctPac: '0',
        pctFinalBill: '10',
      },
    });
    expect(supplyRow.statusCode, supplyRow.body).toBe(200);
    expect(supplyRow.json<{ pctSupply: string; pctFinalBill: string }>()).toMatchObject(
      { pctSupply: '90.00', pctFinalBill: '10.00' },
    );
    const installRow = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/payment-matrix/PURE_INSTALLATION`,
      organisationId,
      payload: {
        pctSupply: '0',
        pctInstallation: '80',
        pctPac: '0',
        pctFinalBill: '20',
      },
    });
    expect(installRow.statusCode, installRow.body).toBe(200);
    expect(
      installRow.json<{ pctInstallation: string; pctFinalBill: string }>(),
    ).toMatchObject({ pctInstallation: '80.00', pctFinalBill: '20.00' });
  });
});

describe('2 — purchase order to the vendor for the supply items', () => {
  it('drafts the order, saves its lines, and issues it with an exact frozen total', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/purchase-orders`,
      organisationId,
      payload: {
        vendorContactId,
        poDate: '2026-07-01',
        terms: '30 days credit; delivery at site.',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    purchaseOrderId = created.json<PurchaseOrderDetailResponse>().purchaseOrder.id;

    const lines = await authed(owner, {
      method: 'PUT',
      url: `/api/purchase-orders/${purchaseOrderId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            workItemId: cableItemId,
            description: 'Signalling cable, ISI marked',
            unitCode: 'Mtr',
            quantity: '60',
            rate: '250',
          },
          {
            workItemId: relayItemId,
            description: 'Relay unit',
            unitCode: 'Nos',
            quantity: '10',
            rate: '1200',
          },
        ],
      },
    });
    expect(lines.statusCode, lines.body).toBe(200);
    const drafted = lines.json<PurchaseOrderDetailResponse>();
    poLineCableId = drafted.lines[0]?.id ?? '';
    poLineRelayId = drafted.lines[1]?.id ?? '';
    expect(drafted.lines[0]).toMatchObject({
      lineNumber: 1,
      workItemId: cableItemId,
      quantity: '60.000',
      rate: '250.00',
      lineAmount: '15000.00',
      receivedQuantity: '0.000',
      pendingQuantity: '60.000',
    });
    expect(drafted.lines[1]).toMatchObject({
      lineNumber: 2,
      workItemId: relayItemId,
      quantity: '10.000',
      rate: '1200.00',
      lineAmount: '12000.00',
      pendingQuantity: '10.000',
    });
    // Money summed server-side as exact decimals; the record's own total
    // is issue-written.
    expect(drafted.previewTotal).toBe('27000.00');
    expect(drafted.purchaseOrder.totalAmount).toBeNull();

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const detail = issued.json<PurchaseOrderDetailResponse>();
    expect(detail.purchaseOrder).toMatchObject({
      status: 'issued',
      poNumber: `${workCode}-PO-01`,
      sequenceNumber: 1,
      totalAmount: '27000.00',
    });
    expect(detail.vendorSnapshot).toMatchObject({
      contactId: vendorContactId,
      designation: `Bharat Cables Pvt Ltd ${runId}`,
      gstin: VENDOR_GSTIN,
      stateCode: '27',
      address: 'Plot 12, MIDC, Pune',
    });
  });

  it('refuses to close while both lines are still owed material', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/close`,
      organisationId,
    });
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{
      code: string;
      details: { outstandingLines: { purchaseOrderLineId: string }[] };
    }>();
    expect(body.code).toBe('PO_NOT_FULLY_RECEIVED');
    expect(body.details.outstandingLines).toHaveLength(2);
    expect(body.details.outstandingLines[0]).toMatchObject({
      purchaseOrderLineId: poLineCableId,
      orderedQuantity: '60.000',
      receivedQuantity: '0.000',
      pendingQuantity: '60.000',
    });
  });
});

describe('3 — delivery challan against the purchase order', () => {
  it('drafts the challan, maps its items onto the order lines, and issues it', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-07-05',
        prefix: 'LCDC',
        consignee: {
          name: `Sr. DEE (TRD) CR ${runId}`,
          address: 'Divisional office, Delhi Division',
        },
        items: [
          { workItemId: cableItemId, quantity: '60' },
          { workItemId: relayItemId, quantity: '10' },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    challan1Id = created.json<ChallanDetailResponse>().challan.id;

    // The receipt link (delivery_challan_items.purchase_order_line_id) is
    // written with admin SQL: the challan editor that offers open orders
    // belongs to the web slice, and what this test proves is the balance
    // the purchase-order route derives from that column — the same
    // posture as the purchase-order suite.
    for (const [workItemId, lineId] of [
      [cableItemId, poLineCableId],
      [relayItemId, poLineRelayId],
    ] as const) {
      await admin`
        update delivery_challan_items
        set purchase_order_line_id = ${lineId}
        where delivery_challan_id = ${challan1Id} and work_item_id = ${workItemId}
      `;
    }

    // A draft challan has delivered nothing yet.
    const beforeIssue = await getPurchaseOrder();
    expect(beforeIssue.lines[0]).toMatchObject({
      receivedQuantity: '0.000',
      pendingQuantity: '60.000',
    });

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const challan = issued.json<ChallanDetailResponse>().challan;
    expect(challan.status).toBe('issued');
    expect(challan.challanNumber).toBe('LCDC/1');
  });

  it('shows both lines fully received and closes the order — the derived close', async () => {
    const received = await getPurchaseOrder();
    expect(received.lines[0]).toMatchObject({
      receivedQuantity: '60.000',
      pendingQuantity: '0.000',
    });
    expect(received.lines[1]).toMatchObject({
      receivedQuantity: '10.000',
      pendingQuantity: '0.000',
    });

    const closed = await authed(owner, {
      method: 'POST',
      url: `/api/purchase-orders/${purchaseOrderId}/close`,
      organisationId,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const detail = closed.json<PurchaseOrderDetailResponse>();
    expect(detail.purchaseOrder.status).toBe('closed');
    expect(detail.purchaseOrder.closedAt).not.toBeNull();
    // The number and the frozen total survive the transition untouched.
    expect(detail.purchaseOrder.poNumber).toBe(`${workCode}-PO-01`);
    expect(detail.purchaseOrder.totalAmount).toBe('27000.00');
    expect(detail.lines.map((line) => line.pendingQuantity)).toEqual([
      '0.000',
      '0.000',
    ]);
  });
});

describe('4 — the pure-installation item goes up on site', () => {
  it('records 3 of the 5 units installed', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/installations`,
      organisationId,
      payload: {
        workItemId: installItemId,
        quantity: '3',
        installedOn: '2026-07-15',
        newLocation: { name: `Alpha Cabin ${runId}`, kind: 'station' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    installation1Id = response.json<{ id: string }>().id;
  });
});

describe('5 — two record MBs in parallel, merged into the on-account MB', () => {
  it('two consignees open record sheets side by side', async () => {
    const first = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: {
        mbDate: '2026-08-01',
        kind: 'record',
        consigneeContactId: consignee1Id,
      },
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstBook = first.json<MeasurementBookDetailResponse>().book;
    record1Id = firstBook.id;
    expect(firstBook.kind).toBe('record');
    expect(firstBook.consigneeContactId).toBe(consignee1Id);

    const second = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: {
        mbDate: '2026-08-01',
        kind: 'record',
        consigneeContactId: consignee2Id,
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    record2Id = second.json<MeasurementBookDetailResponse>().book.id;
  });

  it('each claims its own source, and the one-live-claim rule holds between them', async () => {
    // Record 1 claims the delivery challan.
    const claimed1 = await setSources(record1Id, [
      { sourceType: 'delivery_challan', sourceId: challan1Id },
    ]);
    expect(claimed1.statusCode, claimed1.body).toBe(200);

    // Record 2 reaching for the SAME challan is refused, naming the holder.
    const conflict = await setSources(record2Id, [
      { sourceType: 'delivery_challan', sourceId: challan1Id },
    ]);
    expect(conflict.statusCode).toBe(409);
    const conflictBody = conflict.json<{
      code: string;
      details: { holdingMeasurementBookId: string };
    }>();
    expect(conflictBody.code).toBe('MB_SOURCE_ALREADY_BILLED');
    expect(conflictBody.details.holdingMeasurementBookId).toBe(record1Id);

    // A record's claim protects its source like any live claim.
    const challanCancel = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan1Id}/cancel`,
      organisationId,
      payload: { note: 'Attempt against a record-claimed challan.' },
    });
    expect(challanCancel.statusCode).toBe(409);
    expect(challanCancel.json<{ code: string }>().code).toBe('SOURCE_BILLED_IN_MB');

    // Record 2 claims the installation instead — disjoint sources.
    const claimed2 = await setSources(record2Id, [
      { sourceType: 'installation', sourceId: installation1Id },
    ]);
    expect(claimed2.statusCode, claimed2.body).toBe(200);

    // A record sheet never bills on its own.
    const refused = await finalize(record1Id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('MB_RECORD_NOT_BILLABLE');
  });

  it('the main consignee merges both records into one on-account draft', async () => {
    const merged = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books/merge`,
      organisationId,
      payload: { recordMbIds: [record1Id, record2Id], mbDate: '2026-08-05' },
    });
    expect(merged.statusCode, merged.body).toBe(201);
    const detail = merged.json<MeasurementBookDetailResponse>();
    mb1Id = detail.book.id;
    expect(detail.book.kind).toBe('on_account');
    expect(detail.book.status).toBe('draft');
    const keys = detail.sources.map((s) => `${s.sourceType}:${s.sourceId}`).sort();
    expect(keys).toEqual(
      [`delivery_challan:${challan1Id}`, `installation:${installation1Id}`].sort(),
    );
    // 60 x 250.00 x 90% + 10 x 1200.00 x 90% + 3 x 400.00 x 80%.
    expect(detail.previewTotal).toBe('25260.00');

    // The records are merged, pointing at the absorber, holding nothing.
    for (const recordId of [record1Id, record2Id]) {
      const record = await authed(owner, {
        method: 'GET',
        url: `/api/measurement-books/${recordId}`,
        organisationId,
      });
      const recordDetail = record.json<MeasurementBookDetailResponse>();
      expect(recordDetail.book.status).toBe('merged');
      expect(recordDetail.book.mergedIntoId).toBe(mb1Id);
      expect(recordDetail.sources).toEqual([]);
    }

    // The one-live-claim rule held through the merge: each source has
    // EXACTLY one live claim, and every one sits on the merged draft.
    const [claims] = await admin<{ target: string; elsewhere: string }[]>`
      select
        (select count(*) from mb_sources
          where measurement_book_id = ${mb1Id}
            and released_at is null)::text as target,
        (select count(*) from mb_sources
          where measurement_book_id <> ${mb1Id}
            and work_id = ${workId} and released_at is null)::text as elsewhere
    `;
    expect(claims).toEqual({ target: '2', elsewhere: '0' });
  });

  it('finalizes as MB-01 with the exact stage amounts', async () => {
    const finalized = await finalize(mb1Id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book).toMatchObject({
      status: 'finalized',
      kind: 'on_account',
      isFinal: false,
      mbNumber: `${workCode}-MB-01`,
      sequenceNumber: 1,
      totalAmount: '25260.00',
    });
    expect(detail.lines).toHaveLength(3);
    expect(detail.lines[0]).toMatchObject({
      itemNumber: '1',
      resolvedCategory: 'SUPPLY',
      pctSupply: '90.00',
      pctFinalBill: '10.00',
      deltaSupplied: '60.000',
      amountSupply: '13500.00',
      amountInstallation: '0.00',
      amountFinalBill: '0.00',
      lineTotal: '13500.00',
    });
    expect(detail.lines[1]).toMatchObject({
      itemNumber: '2',
      resolvedCategory: 'SUPPLY',
      deltaSupplied: '10.000',
      amountSupply: '10800.00',
      amountFinalBill: '0.00',
      lineTotal: '10800.00',
    });
    expect(detail.lines[2]).toMatchObject({
      itemNumber: '3',
      resolvedCategory: 'PURE_INSTALLATION',
      pctInstallation: '80.00',
      deltaInstalled: '3.000',
      amountInstallation: '960.00',
      amountFinalBill: '0.00',
      lineTotal: '960.00',
    });
  });
});

describe('6 — the cumulative tax invoice, the IRP, and the e-way bill', () => {
  it('drafts and submits the invoice: FY number, intra-state split, exact totals', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/tax-invoices`,
      organisationId,
      payload: {
        measurementBookId: mb1Id,
        invoiceDate: '2026-09-01',
        sacCode: SAC,
        serviceDescription: SERVICE_DESCRIPTION,
        gstRate: '18',
        placeOfSupply: '07',
        buyerContactId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    invoice1Id = created.json<TaxInvoiceDetailResponse>().invoice.id;
    expect(created.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      status: 'draft',
      invoiceNumber: null,
      mbNumber: `${workCode}-MB-01`,
      taxableValue: null,
    });

    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice1Id}/submit`,
      organisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const detail = submitted.json<TaxInvoiceDetailResponse>();
    expect(detail.invoice).toMatchObject({
      status: 'submitted',
      invoiceNumber: 'TI/2026-27/001',
      sequenceNumber: 1,
      fyLabel: '2026-27',
      // The MB total VERBATIM; round(25260 x 18 / 200, 2) each side.
      taxableValue: '25260.00',
      cgstAmount: '2273.40',
      sgstAmount: '2273.40',
      igstAmount: '0.00',
      totalAmount: '29806.80',
      buyerContactId,
    });
    expect(detail.buyerSnapshot).toMatchObject({
      contactId: buyerContactId,
      designation: 'Sr. DEE (G) NR',
      gstin: BUYER_GSTIN,
      address: BUYER_ADDRESS,
      stateCode: '07',
      pincode: '110055',
    });

    // The stored row says the same, in exact numeric text.
    const [row] = await admin<
      {
        taxable_value: string;
        cgst_amount: string;
        sgst_amount: string;
        igst_amount: string;
        total_amount: string;
        fy_label: string;
      }[]
    >`
      select taxable_value::text as taxable_value, cgst_amount::text as cgst_amount,
             sgst_amount::text as sgst_amount, igst_amount::text as igst_amount,
             total_amount::text as total_amount, fy_label
      from tax_invoices where id = ${invoice1Id}
    `;
    expect(row).toMatchObject({
      taxable_value: '25260.00',
      cgst_amount: '2273.40',
      sgst_amount: '2273.40',
      igst_amount: '0.00',
      total_amount: '29806.80',
      fy_label: '2026-27',
    });
  });

  it('the submitted invoice CLOSES MB-01: the 0035 trigger refuses its cancel against any writer', async () => {
    await expect(
      admin`
        update measurement_books
        set status = 'cancelled', cancellation_note = 'closure rule probe',
            cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
        where id = ${mb1Id}
      `,
    ).rejects.toThrowError(/closed by a tax invoice/);
    const [book] = await admin<{ status: string }[]>`
      select status from measurement_books where id = ${mb1Id}
    `;
    expect(book?.status).toBe('finalized');
  });

  it('serves the canonical NIC 1.1 IRP payload and records the IRP response', async () => {
    const payload = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${invoice1Id}/irp-payload`,
      organisationId,
    });
    expect(payload.statusCode, payload.body).toBe(200);
    expect(payload.json()).toStrictEqual({
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
      DocDtls: { Typ: 'INV', No: 'TI/2026-27/001', Dt: '01/09/2026' },
      SellerDtls: {
        Gstin: ORG_GSTIN,
        LglNm: ORG_NAME,
        Addr1: ORG_ADDRESS,
        Loc: 'New Delhi',
        Pin: 110002,
        Stcd: '07',
      },
      BuyerDtls: {
        Gstin: BUYER_GSTIN,
        LglNm: 'Sr. DEE (G) NR',
        Pos: '07',
        Addr1: BUYER_ADDRESS,
        Loc: 'New Delhi',
        Pin: 110055,
        Stcd: '07',
      },
      ItemList: [
        {
          SlNo: '1',
          PrdDesc: SERVICE_DESCRIPTION,
          IsServc: 'Y',
          HsnCd: SAC,
          Qty: 1,
          Unit: 'OTH',
          UnitPrice: 25260,
          TotAmt: 25260,
          AssAmt: 25260,
          GstRt: 18,
          CgstAmt: 2273.4,
          SgstAmt: 2273.4,
          IgstAmt: 0,
          TotItemVal: 29806.8,
        },
      ],
      ValDtls: {
        AssVal: 25260,
        CgstVal: 2273.4,
        SgstVal: 2273.4,
        IgstVal: 0,
        TotInvVal: 29806.8,
      },
    });

    const irn = '0123456789abcdef'.repeat(4);
    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice1Id}/irp-response`,
      organisationId,
      payload: {
        irn,
        ackNumber: '112010036563',
        ackDate: '2026-09-01T10:30:00.000Z',
        signedQr: 'signed-qr-jws-payload',
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const detail = recorded.json<TaxInvoiceDetailResponse>();
    expect(detail.invoice.irn).toBe(irn);
    expect(detail.invoice.ackNumber).toBe('112010036563');
    expect(detail.signedQr).toBe('signed-qr-jws-payload');
  });

  it('moves the invoice on an e-way bill: draft, NIC payload, NIC response', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice1Id}/eway-bills`,
      organisationId,
      payload: {
        transportMode: 'road',
        distanceKm: 25,
        fromPincode: '110002',
        toPincode: '110055',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    ewayBillId = created.json<EwayBillDetailResponse>().ewayBill.id;
    expect(created.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      taxInvoiceId: invoice1Id,
      invoiceNumber: 'TI/2026-27/001',
      status: 'draft',
      vehicleNumber: null,
    });

    // A road movement without a vehicle has nothing for NIC to answer.
    const incomplete = await authed(owner, {
      method: 'GET',
      url: `/api/eway-bills/${ewayBillId}/nic-payload`,
      organisationId,
    });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json<{ code: string }>().code).toBe('VEHICLE_REQUIRED');

    const edited = await authed(owner, {
      method: 'PUT',
      url: `/api/eway-bills/${ewayBillId}`,
      organisationId,
      payload: {
        transportMode: 'road',
        distanceKm: 25,
        fromPincode: '110002',
        toPincode: '110055',
        transporterId: TRANSPORTER_ID,
        transporterName: 'Sharma Roadways',
        vehicleNumber: 'DL01AB1234',
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    const payload = await authed(owner, {
      method: 'GET',
      url: `/api/eway-bills/${ewayBillId}/nic-payload`,
      organisationId,
    });
    expect(payload.statusCode, payload.body).toBe(200);
    expect(payload.json()).toStrictEqual({
      supplyType: 'O',
      subSupplyType: '1',
      docType: 'INV',
      docNo: 'TI/2026-27/001',
      docDate: '01/09/2026',
      fromGstin: ORG_GSTIN,
      fromTrdName: ORG_NAME,
      fromAddr1: ORG_ADDRESS,
      fromPlace: 'New Delhi',
      fromPincode: 110002,
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
          taxableAmount: 25260,
          cgstRate: 9,
          sgstRate: 9,
          igstRate: 0,
          cessRate: 0,
        },
      ],
      totalValue: 25260,
      cgstValue: 2273.4,
      sgstValue: 2273.4,
      igstValue: 0,
      cessValue: 0,
      totInvValue: 29806.8,
      transMode: '1',
      transDistance: '25',
      transporterId: TRANSPORTER_ID,
      transporterName: 'Sharma Roadways',
      vehicleNo: 'DL01AB1234',
    });

    const generated = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${ewayBillId}/nic-response`,
      organisationId,
      payload: {
        ewbNumber: '123456789012',
        ewbDate: '2026-09-01T12:00:00.000Z',
        validUntil: '2026-09-02T23:59:59.000Z',
      },
    });
    expect(generated.statusCode, generated.body).toBe(200);
    expect(generated.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      status: 'generated',
      ewbNumber: '123456789012',
      ewbDate: '2026-09-01T12:00:00.000Z',
      validUntil: '2026-09-02T23:59:59.000Z',
    });
  });
});

describe('7 — the remainder, and the FINAL Measurement Book', () => {
  it('the readiness endpoint names exactly what is still owed', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/completion-readiness`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const readiness = response.json<WorkCompletionReadiness>();
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.unfinished).toHaveLength(2);
    expect(readiness.unfinished[0]).toMatchObject({
      workItemId: cableItemId,
      itemNumber: '1',
      requirement: 'delivery',
      direction: 'short',
      requiredQuantity: '100.000',
      deliveredQuantity: '60.000',
    });
    expect(readiness.unfinished[1]).toMatchObject({
      workItemId: installItemId,
      itemNumber: '3',
      requirement: 'installation',
      direction: 'short',
      requiredQuantity: '5.000',
      installedQuantity: '3.000',
    });
  });

  it('delivers and installs the remainder', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-06',
        prefix: 'LCDC',
        consignee: {
          name: `Sr. DEE (TRD) CR ${runId}`,
          address: 'Divisional office, Delhi Division',
        },
        items: [{ workItemId: cableItemId, quantity: '40' }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    challan2Id = created.json<ChallanDetailResponse>().challan.id;
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challan2Id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json<ChallanDetailResponse>().challan.challanNumber).toBe('LCDC/2');

    const installed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/installations`,
      organisationId,
      payload: {
        workItemId: installItemId,
        quantity: '2',
        installedOn: '2026-08-06',
        newLocation: { name: `Beta Cabin ${runId}`, kind: 'station' },
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    installation2Id = installed.json<{ id: string }>().id;
  });

  it('raises the last MB as kind FINAL and must sweep every open source', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-07', kind: 'final' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const book = created.json<MeasurementBookDetailResponse>().book;
    mb2Id = book.id;
    expect(book.kind).toBe('final');
    expect(book.isFinal).toBe(true);

    // Claiming only the challan leaves the installation stranded: the
    // final sweep refuses, naming exactly what it missed.
    const partial = await setSources(mb2Id, [
      { sourceType: 'delivery_challan', sourceId: challan2Id },
    ]);
    expect(partial.statusCode, partial.body).toBe(200);
    const refused = await finalize(mb2Id);
    expect(refused.statusCode).toBe(409);
    const body = refused.json<{
      code: string;
      details: { missedSources: { sourceType: string; sourceId: string }[] };
    }>();
    expect(body.code).toBe('MB_FINAL_SWEEP_INCOMPLETE');
    expect(body.details.missedSources).toHaveLength(1);
    expect(body.details.missedSources[0]).toMatchObject({
      sourceType: 'installation',
      sourceId: installation2Id,
    });

    const swept = await setSources(mb2Id, [
      { sourceType: 'delivery_challan', sourceId: challan2Id },
      { sourceType: 'installation', sourceId: installation2Id },
    ]);
    expect(swept.statusCode, swept.body).toBe(200);
  });

  it('finalizes MB-02 with the exact final-bill stage amounts', async () => {
    const finalized = await finalize(mb2Id);
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    expect(detail.book).toMatchObject({
      status: 'finalized',
      kind: 'final',
      isFinal: true,
      mbNumber: `${workCode}-MB-02`,
      sequenceNumber: 2,
      totalAmount: '13740.00',
    });
    expect(detail.lines).toHaveLength(3);
    // SUPPLY branch: the final 10% falls on 100% of the DELIVERED
    // quantity — 40 more supplied now, 100 released for the final bill.
    expect(detail.lines[0]).toMatchObject({
      itemNumber: '1',
      deltaSupplied: '40.000',
      deltaFinalBill: '100.000',
      priorSupplied: '60.000',
      amountSupply: '9000.00',
      amountFinalBill: '2500.00',
      lineTotal: '11500.00',
    });
    // Fully delivered on MB-01: nothing but its final-bill retention.
    expect(detail.lines[1]).toMatchObject({
      itemNumber: '2',
      deltaFinalBill: '10.000',
      priorSupplied: '10.000',
      amountSupply: '0.00',
      amountFinalBill: '1200.00',
      lineTotal: '1200.00',
    });
    // PURE_INSTALLATION branch: the final 20% falls on the INSTALLED
    // quantity only.
    expect(detail.lines[2]).toMatchObject({
      itemNumber: '3',
      deltaInstalled: '2.000',
      deltaFinalBill: '5.000',
      priorInstalled: '3.000',
      amountInstallation: '640.00',
      amountFinalBill: '400.00',
      lineTotal: '1040.00',
    });
  });

  it('permits no further MB of ANY kind after the final one', async () => {
    const onAccount = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-08' },
    });
    expect(onAccount.statusCode).toBe(409);
    expect(onAccount.json<{ code: string }>().code).toBe('FINAL_MB_EXISTS');

    const record = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: {
        mbDate: '2026-08-08',
        kind: 'record',
        consigneeContactId: consignee1Id,
      },
    });
    expect(record.statusCode).toBe(409);
    expect(record.json<{ code: string }>().code).toBe('FINAL_MB_EXISTS');
  });

  it('invoices the final MB and submits it on the same FY counter', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/tax-invoices`,
      organisationId,
      payload: {
        measurementBookId: mb2Id,
        invoiceDate: '2026-09-02',
        sacCode: SAC,
        serviceDescription: SERVICE_DESCRIPTION,
        gstRate: '18',
        placeOfSupply: '07',
        buyerContactId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const invoice2Id = created.json<TaxInvoiceDetailResponse>().invoice.id;

    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice2Id}/submit`,
      organisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(submitted.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      status: 'submitted',
      // Gapless within the financial year: 002 follows 001.
      invoiceNumber: 'TI/2026-27/002',
      sequenceNumber: 2,
      fyLabel: '2026-27',
      taxableValue: '13740.00',
      cgstAmount: '1236.60',
      sgstAmount: '1236.60',
      igstAmount: '0.00',
      totalAmount: '16213.20',
    });

    // The FY counter agrees with the numbers handed out.
    const counters = await admin<{ fy_label: string; next_value: number }[]>`
      select fy_label, next_value from tax_invoice_counters
      where organisation_id = ${organisationId}
      order by fy_label
    `;
    expect(counters).toEqual([{ fy_label: '2026-27', next_value: 2 }]);
  });
});

describe('8 — completing the Work', () => {
  it('the readiness endpoint says ready, and completion succeeds', async () => {
    const readiness = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/completion-readiness`,
      organisationId,
    });
    expect(readiness.statusCode, readiness.body).toBe(200);
    expect(readiness.json<WorkCompletionReadiness>()).toEqual({
      ready: true,
      unfinished: [],
      blockers: [],
    });

    const completed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/complete`,
      organisationId,
      payload: { note: 'All items delivered, installed, measured, and billed.' },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const work = completed.json<{
      work: {
        status: string;
        completedAt: string | null;
        completionNote: string | null;
      };
    }>().work;
    expect(work.status).toBe('completed');
    expect(work.completedAt).not.toBeNull();
    expect(work.completionNote).toBe(
      'All items delivered, installed, measured, and billed.',
    );
  });

  it('a completed Work refuses a new delivery challan', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'LCDC',
        consignee: {
          name: `Sr. DEE (TRD) CR ${runId}`,
          address: 'Divisional office, Delhi Division',
        },
        items: [{ workItemId: cableItemId, quantity: '1' }],
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('WORK_COMPLETED');
  });
});
