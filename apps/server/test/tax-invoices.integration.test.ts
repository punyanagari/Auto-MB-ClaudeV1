import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  MeasurementBookDetailResponse,
  OrganisationProfile,
  TaxInvoiceDetailResponse,
  TaxInvoiceListResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import { deriveIrn } from '../src/gsp/irn.js';
import {
  StatutoryProviderError,
  type StatutoryProvider,
} from '../src/gsp/statutory-provider.js';

/**
 * The GST tax invoice (migration 0035): the full chain from finalized
 * Measurement Book to submitted cumulative invoice. What has to hold:
 *
 * - submit computes the exact CGST+SGST split intra-state and the exact
 *   IGST inter-state, in SQL numeric arithmetic, from the MB total
 *   VERBATIM — asserted as 2dp strings, including the half-rounding
 *   asymmetry (295.60 intra vs 295.59 inter on the same 250.50);
 * - numbering is gapless per organisation PER FINANCIAL YEAR: 31 March
 *   and 1 April invoices take different counters, and concurrent submits
 *   in one FY serialise into distinct consecutive numbers;
 * - one live invoice per MB, with the conflict naming the live one;
 * - submitting closes the MB (the 0035 trigger refuses its cancel) and
 *   cancelling the invoice releases it;
 * - the IRP payload is the canonical NIC 1.1 JSON, pinned by a golden
 *   deep-equal, and the IRP response records exactly once;
 * - writer/authority gates and cross-tenant 404s hold like every other
 *   document's.
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
const ownerEmail = `ti-owner-${runId}@integration.test`;
const clerkEmail = `ti-clerk-${runId}@integration.test`;
const viewerEmail = `ti-viewer-${runId}@integration.test`;
const outsiderEmail = `ti-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const workCode = `TIW${runId.slice(0, 4).toUpperCase()}`;

const ORG_GSTIN = '07ABCDE1234F1Z5';
const ORG_ADDRESS = 'Plot 12, Industrial Area, New Delhi, 110002';
const BUYER_GSTIN = '07AAAGM0289C1ZL';
const BUYER_ADDRESS = 'DRM Office, State Entry Road, New Delhi, 110055';
const SERVICE_DESCRIPTION = 'Works contract services for signalling installation';
const SAC = '995421';

let admin: Sql;
let app: FastifyInstance;
let providerApp: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
/** Dedicated organisation for the finding-20 applicability describe —
 * its declaration changes must not disturb the shared fixture. */
let applicabilityOrganisationId: string;
let ownerUserId: string;
let workId: string;
let itemId: string;
let buyerContactId: string;
let barePincodeBuyerId: string;
/** A complete buyer profile with no GSTIN — an unregistered (B2C) buyer. */
let unregisteredBuyerId: string;
let retiredContactId: string;

// Finalized MBs and their invoices, built up in order.
let mb1: { id: string; number: string; total: string };
let mb2: { id: string; number: string; total: string };
let mb3: { id: string; number: string; total: string };
let mb4: { id: string; number: string; total: string };
let mb5: { id: string; number: string; total: string };
let mb6: { id: string; number: string; total: string };
let invoice1Id: string;
let invoice6Id: string;
let firstRenderedInvoiceKey: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;
let outsider: CookieJar;

const registerInvoiceProvider = vi.fn<StatutoryProvider['registerInvoice']>();
const findInvoiceProvider = vi.fn<StatutoryProvider['findInvoiceByDocument']>();
const cancelInvoiceProvider = vi.fn<StatutoryProvider['cancelInvoice']>();
const generateEwayBillProvider = vi.fn<StatutoryProvider['generateEwayBillByIrn']>();
const findEwayBillProvider = vi.fn<StatutoryProvider['findEwayBillByIrn']>();
const cancelEwayBillProvider = vi.fn<StatutoryProvider['cancelEwayBill']>();
const STUB_PORTAL = 'NIC1 via apisandbox.whitebooks.in';
const providerStub: StatutoryProvider = {
  name: 'whitebooks',
  portal: STUB_PORTAL,
  environment: 'sandbox',
  registerInvoice: registerInvoiceProvider,
  findInvoiceByDocument: findInvoiceProvider,
  cancelInvoice: cancelInvoiceProvider,
  generateEwayBillByIrn: generateEwayBillProvider,
  findEwayBillByIrn: findEwayBillProvider,
  cancelEwayBill: cancelEwayBillProvider,
};

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

async function authedOn(
  target: FastifyInstance,
  jar: CookieJar,
  options: InjectOptions & { organisationId?: string },
) {
  const { organisationId: org, ...rest } = options;
  return target.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      cookie: jar.cookie,
      ...(org !== undefined ? { 'x-organisation-id': org } : {}),
    },
  });
}

async function issueChallan(quantity: string): Promise<string> {
  const draft = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2025-07-01',
      prefix: `${workCode}DC`,
      consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
      items: [{ workItemId: itemId, quantity }],
    },
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const challanId = draft.json<ChallanDetailResponse>().challan.id;
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  return challanId;
}

/** One finalized on-account MB fed by one fresh issued challan — the
 * real API end to end, exactly as an operator reaches a billable MB. */
async function finalizedMb(
  mbDate: string,
  quantity: string,
): Promise<{ id: string; number: string; total: string }> {
  const challanId = await issueChallan(quantity);
  const draft = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/measurement-books`,
    organisationId,
    payload: { mbDate, kind: 'on_account' },
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const mbId = draft.json<MeasurementBookDetailResponse>().book.id;
  const sources = await authed(owner, {
    method: 'PUT',
    url: `/api/measurement-books/${mbId}/sources`,
    organisationId,
    payload: {
      sources: [{ sourceType: 'delivery_challan', sourceId: challanId }],
    },
  });
  expect(sources.statusCode, sources.body).toBe(200);
  const finalized = await authed(owner, {
    method: 'POST',
    url: `/api/measurement-books/${mbId}/finalize`,
    organisationId,
  });
  expect(finalized.statusCode, finalized.body).toBe(200);
  const book = finalized.json<MeasurementBookDetailResponse>().book;
  expect(book.mbNumber).not.toBeNull();
  expect(book.totalAmount).not.toBeNull();
  return { id: mbId, number: book.mbNumber ?? '', total: book.totalAmount ?? '' };
}

function invoiceBody(
  measurementBookId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    measurementBookId,
    invoiceDate: '2026-03-15',
    sacCode: SAC,
    serviceDescription: SERVICE_DESCRIPTION,
    gstRate: '18',
    placeOfSupply: '07',
    reverseChargeApplicable: false,
    buyerContactId,
    ...overrides,
  };
}

async function createInvoice(
  measurementBookId: string,
  overrides: Record<string, unknown> = {},
  jar: CookieJar = owner,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/works/${workId}/tax-invoices`,
    organisationId,
    payload: invoiceBody(measurementBookId, overrides),
  });
}

async function submitInvoice(invoiceId: string, jar: CookieJar = owner) {
  return authed(jar, {
    method: 'POST',
    url: `/api/tax-invoices/${invoiceId}/submit`,
    organisationId,
  });
}

async function submittedDirectInvoice(
  suffix: string,
): Promise<TaxInvoiceDetailResponse> {
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/tax-invoices',
    organisationId,
    payload: {
      invoiceDate: '2026-02-15',
      sacCode: '998734',
      serviceDescription: `Whitebooks provider route probe ${suffix}.`,
      gstRate: '18',
      placeOfSupply: '07',
      reverseChargeApplicable: false,
      buyerContactId,
      taxableValue: '1000.00',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const submitted = await submitInvoice(
    created.json<TaxInvoiceDetailResponse>().invoice.id,
  );
  expect(submitted.statusCode, submitted.body).toBe(201);
  return submitted.json<TaxInvoiceDetailResponse>();
}

function resetProviderMocks(): void {
  registerInvoiceProvider.mockReset();
  findInvoiceProvider.mockReset();
  cancelInvoiceProvider.mockReset();
  generateEwayBillProvider.mockReset();
  findEwayBillProvider.mockReset();
  cancelEwayBillProvider.mockReset();
}

function irpEvidence(seed: string) {
  return {
    irn: seed.repeat(64).slice(0, 64),
    ackNumber: '900719925474099312345',
    ackDateText: '12/08/2026 14:30:00',
    ackDate: '2026-08-12T09:00:00.000Z',
    signedQr: `signed-qr-${seed}`,
    signedInvoice: `signed-invoice-${seed}`,
    rawResponse: `{"status_cd":"1","seed":"${seed}"}`,
    // These stubs replace the adapter wholesale, so they never travel
    // through the local IRN/signed-QR verification the real one applies
    // (audit finding 2) — that is proved at the adapter, in
    // whitebooks.test.ts. What they must still carry is the portal the
    // answering adapter reports, because the operation ledger records it.
    portal: STUB_PORTAL,
  };
}

/**
 * The IRN the NIC portal would issue for this invoice, derived from the
 * invoice's own frozen issued snapshot (audit finding 2). Manual evidence
 * entry now refuses any other value, so the compatibility-path fixtures
 * below must offer the real one.
 */
function derivedIrnFor(detail: TaxInvoiceDetailResponse): string {
  const snapshot = detail.issuedSnapshot as {
    supplier: { gstin: string };
    invoiceNumber: string;
    invoiceDate: string;
  };
  return deriveIrn({
    gstin: snapshot.supplier.gstin,
    documentNumber: snapshot.invoiceNumber,
    documentDate: snapshot.invoiceDate,
  });
}

/** The same, for an invoice reached only by id. */
async function derivedIrnForInvoice(invoiceId: string): Promise<string> {
  const detail = await authed(owner, {
    method: 'GET',
    url: `/api/tax-invoices/${invoiceId}`,
    organisationId,
  });
  expect(detail.statusCode, detail.body).toBe(200);
  return derivedIrnFor(detail.json<TaxInvoiceDetailResponse>());
}

async function expirePendingProviderOperation(invoiceId: string): Promise<void> {
  await admin.unsafe(`set session_replication_role = 'replica'`);
  try {
    await admin`
      update statutory_provider_operations
      set started_at = now() - interval '3 minutes'
      where tax_invoice_id = ${invoiceId} and status = 'pending'
    `;
  } finally {
    await admin.unsafe(`set session_replication_role = 'origin'`);
  }
}

async function patchProfile(payload: Record<string, unknown>) {
  const response = await authed(owner, {
    method: 'PATCH',
    url: '/api/organisation/profile',
    organisationId,
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-ti-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the tax invoice integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ti-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });
  providerApp = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    statutoryProvider: providerStub,
  });

  owner = await signUp(ownerEmail, 'TI Owner');
  clerk = await signUp(clerkEmail, 'TI Clerk');
  viewer = await signUp(viewerEmail, 'TI Viewer');
  outsider = await signUp(outsiderEmail, 'TI Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'TI Constructions', slug: `ti-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'TI Outsiders', slug: `ti-out-${runId}` },
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

  // The owner's e-invoicing declaration (finding 20, migration 0049):
  // applicable with NO reporting window, so this organisation's
  // invoices stamp NULL deadlines and the IRP routes stay reachable.
  // The window itself is proved in its own describe, against a
  // dedicated organisation whose declaration it controls.
  await patchProfile({
    einvoiceApplicability: 'applicable',
    einvoiceApplicableFrom: '2017-07-01',
  });
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
      '2025-06-01', 'Tax invoice fixture work', '10000000.00', '9000000.00',
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
      'Signalling cable', 'mtr', 10000.000, 250.00
    )
  `;
  // Pure-supply matrix: an MB total is exactly quantity x rate, so every
  // taxable value below is a chosen number, not an accident.
  await admin`
    insert into payment_matrices (
      organisation_id, work_id, category, pct_supply, pct_installation,
      pct_pac, pct_final_bill, created_by_user_id
    )
    values (${organisationId}, ${workId}, 'UNCATEGORISED', '100.00', '0.00',
            '0.00', '0.00', ${ownerUserId})
  `;

  buyerContactId = randomUUID();
  barePincodeBuyerId = randomUUID();
  retiredContactId = randomUUID();
  unregisteredBuyerId = randomUUID();
  await admin`
    insert into contacts (
      id, organisation_id, designation, contact_person, address, gstin,
      pincode, state_code, locality, is_consignee, active, created_by_user_id
    )
    values
      (${buyerContactId}, ${organisationId}, 'Sr. DEE (G) NR', 'S K Verma',
       ${BUYER_ADDRESS}, ${BUYER_GSTIN}, '110055', '07', 'New Delhi', true, true,
       ${ownerUserId}),
      (${barePincodeBuyerId}, ${organisationId}, 'Dy. CE (Con) NR', null,
       'Kashmere Gate, Delhi', null, null, null, null, true, true, ${ownerUserId}),
      (${retiredContactId}, ${organisationId}, 'Retired DEE', null,
       ${BUYER_ADDRESS}, null, '110055', '07', 'New Delhi', true, false,
       ${ownerUserId}),
      -- A complete buyer profile that simply holds no GSTIN: an
      -- unregistered customer. Complete enough to submit an invoice, so
      -- the B2C refusal (finding 4) is reached at the IRP boundary rather
      -- than short-circuited earlier by a missing address field.
      (${unregisteredBuyerId}, ${organisationId}, 'Ram Prasad Traders', 'R Prasad',
       ${BUYER_ADDRESS}, null, '110055', '07', 'New Delhi', true, true,
       ${ownerUserId})
  `;
}, 90_000);

afterAll(async () => {
  if (admin) {
    for (const org of [
      organisationId,
      outsiderOrganisationId,
      applicabilityOrganisationId,
    ]) {
      if (!org) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'work_assignments',
          'statutory_provider_operations',
          'tax_invoice_renders',
          'eway_bills',
          'credit_notes',
          'credit_note_counters',
          'tax_invoices',
          'tax_invoice_counters',
          'document_number_series',
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
          'gst_rates',
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
  await providerApp?.close();
  await app?.close();
  await admin?.end();
  if (storageDir !== undefined) {
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe('drafting against a Measurement Book', () => {
  it('refuses a draft MB, a record MB, a foreign MB, and bad dates/buyers', async () => {
    const challanId = await issueChallan('100');
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2025-08-01', kind: 'on_account' },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftMbId = draft.json<MeasurementBookDetailResponse>().book.id;

    // Not finalized yet: nothing to bill.
    const onDraft = await createInvoice(draftMbId);
    expect(onDraft.statusCode).toBe(409);
    expect(onDraft.json<{ code: string }>().code).toBe('MB_NOT_FINALIZED');

    // A record MB never bills, finalized or not.
    const record = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: {
        mbDate: '2025-08-01',
        kind: 'record',
        consigneeContactId: buyerContactId,
      },
    });
    expect(record.statusCode, record.body).toBe(201);
    const recordMbId = record.json<MeasurementBookDetailResponse>().book.id;
    const onRecord = await createInvoice(recordMbId);
    expect(onRecord.statusCode).toBe(409);
    expect(onRecord.json<{ code: string }>().code).toBe('MB_RECORD_NOT_BILLABLE');
    const dropRecord = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${recordMbId}`,
      organisationId,
    });
    expect(dropRecord.statusCode, dropRecord.body).toBe(204);

    // An unknown MB answers 404 — as would another Work's or tenant's.
    const unknown = await createInvoice(randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ code: string }>().code).toBe('MEASUREMENT_BOOK_NOT_FOUND');

    // Finalize MB1 through the real chain.
    const sources = await authed(owner, {
      method: 'PUT',
      url: `/api/measurement-books/${draftMbId}/sources`,
      organisationId,
      payload: { sources: [{ sourceType: 'delivery_challan', sourceId: challanId }] },
    });
    expect(sources.statusCode, sources.body).toBe(200);
    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${draftMbId}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const book = finalized.json<MeasurementBookDetailResponse>().book;
    mb1 = { id: draftMbId, number: book.mbNumber ?? '', total: book.totalAmount ?? '' };
    expect(mb1.total).toBe('25000.00');

    // Billing cannot precede measurement.
    const early = await createInvoice(mb1.id, { invoiceDate: '2025-07-31' });
    expect(early.statusCode).toBe(400);
    expect(early.json<{ code: string }>().code).toBe('TAX_INVOICE_DATE_BEFORE_MB');

    // The buyer must exist and be active.
    const noBuyer = await createInvoice(mb1.id, { buyerContactId: randomUUID() });
    expect(noBuyer.statusCode).toBe(404);
    expect(noBuyer.json<{ code: string }>().code).toBe('CONTACT_NOT_FOUND');
    const retired = await createInvoice(mb1.id, { buyerContactId: retiredContactId });
    expect(retired.statusCode).toBe(409);
    expect(retired.json<{ code: string }>().code).toBe('CONTACT_RETIRED');

    // Viewers write nothing.
    const denied = await createInvoice(mb1.id, {}, viewer);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');
  });

  it('drafts the invoice, resolving the buyer and the MB number on the read model', async () => {
    const response = await createInvoice(mb1.id);
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<TaxInvoiceDetailResponse>();
    invoice1Id = detail.invoice.id;
    expect(detail.invoice).toMatchObject({
      workId,
      measurementBookId: mb1.id,
      mbNumber: mb1.number,
      status: 'draft',
      invoiceNumber: null,
      fyLabel: null,
      invoiceDate: '2026-03-15',
      sacCode: SAC,
      serviceDescription: SERVICE_DESCRIPTION,
      // numeric(5,2) normalised, never a float.
      gstRate: '18.00',
      placeOfSupply: '07',
      buyerContactId,
      taxableValue: null,
      totalAmount: null,
      irn: null,
    });
    expect(detail.buyerSnapshot).toBeNull();
    expect(detail.signedQr).toBeNull();
  });

  it('holds one live invoice per MB, naming the live one', async () => {
    const conflict = await createInvoice(mb1.id);
    expect(conflict.statusCode).toBe(409);
    const body = conflict.json<{
      code: string;
      details?: { existingRecordId: string };
    }>();
    expect(body.code).toBe('TAX_INVOICE_EXISTS');
    expect(body.details?.existingRecordId).toBe(invoice1Id);
  });

  it('edits the draft fields and refuses a blank description', async () => {
    const blank = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: {
        invoiceDate: '2026-03-15',
        sacCode: SAC,
        serviceDescription: '   ',
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
      },
    });
    expect(blank.statusCode).toBe(400);

    // 5% here, not 12%: the invoice is dated after the 22 Sep 2025 GST 2.0
    // reform, so 12% is no longer a notified rate on that date (the master
    // refusal has its own tests below).
    const edited = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: {
        invoiceDate: '2026-03-15',
        sacCode: '995422',
        serviceDescription: `  ${SERVICE_DESCRIPTION}  `,
        gstRate: '5',
        placeOfSupply: '09',
        reverseChargeApplicable: false,
        buyerContactId,
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const detail = edited.json<TaxInvoiceDetailResponse>();
    expect(detail.invoice.sacCode).toBe('995422');
    expect(detail.invoice.gstRate).toBe('5.00');
    expect(detail.invoice.placeOfSupply).toBe('09');
    // Stored trimmed, exactly as the column measures it.
    expect(detail.invoice.serviceDescription).toBe(SERVICE_DESCRIPTION);

    // Back to the canonical shape for the submit tests.
    const restored = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: invoiceBody(mb1.id),
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<TaxInvoiceDetailResponse>().invoice.gstRate).toBe('18.00');
  });

  it('deletes a draft, which releases the MB slot', async () => {
    mb2 = await finalizedMb('2025-08-02', '1.002');
    expect(mb2.total).toBe('250.50');
    const first = await createInvoice(mb2.id);
    expect(first.statusCode, first.body).toBe(201);
    const throwawayId = first.json<TaxInvoiceDetailResponse>().invoice.id;
    const deleted = await authed(owner, {
      method: 'DELETE',
      url: `/api/tax-invoices/${throwawayId}`,
      organisationId,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    // The slot is free again — the next block drafts against MB2.
    const [gone] = await admin<{ id: string }[]>`
      select id from tax_invoices where id = ${throwawayId}
    `;
    expect(gone).toBeUndefined();
  });
});

describe('submit: the money moment', () => {
  it('requires an explicit forward-charge fact and refuses unsupported reverse charge', async () => {
    const unconfirmed = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: {
        invoiceDate: '2026-03-15',
        sacCode: SAC,
        serviceDescription: SERVICE_DESCRIPTION,
        gstRate: '18',
        placeOfSupply: '07',
        buyerContactId,
      },
    });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(200);
    expect(
      unconfirmed.json<TaxInvoiceDetailResponse>().invoice.reverseChargeApplicable,
    ).toBeNull();
    const missing = await submitInvoice(invoice1Id);
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ code: string }>().code).toBe(
      'REVERSE_CHARGE_CONFIRMATION_REQUIRED',
    );

    const reverseCharge = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: invoiceBody(mb1.id, { reverseChargeApplicable: true }),
    });
    expect(reverseCharge.statusCode, reverseCharge.body).toBe(200);
    const unsupported = await submitInvoice(invoice1Id);
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json<{ code: string }>().code).toBe(
      'REVERSE_CHARGE_UNSUPPORTED',
    );

    const restored = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: invoiceBody(mb1.id),
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('refuses without issue authority, and without the organisation tax facts', async () => {
    const unauthorised = await submitInvoice(invoice1Id, clerk);
    expect(unauthorised.statusCode).toBe(403);
    expect(unauthorised.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');

    // No state code: the split is undecidable.
    const noState = await submitInvoice(invoice1Id);
    expect(noState.statusCode).toBe(400);
    expect(noState.json<{ code: string }>().code).toBe('ORG_STATE_REQUIRED');

    // State but no GSTIN: the IRP payload could not name the seller.
    await patchProfile({ stateCode: '07' });
    const noGstin = await submitInvoice(invoice1Id);
    expect(noGstin.statusCode).toBe(400);
    expect(noGstin.json<{ code: string }>().code).toBe('ORG_GSTIN_REQUIRED');

    await patchProfile({
      gstin: ORG_GSTIN,
      address: ORG_ADDRESS,
      pincode: '110002',
      locality: 'New Delhi',
      invoiceNumberPrefix: 'P10',
    });

    // The organisation defines its own invoice series (migration 0039).
    // '{PREFIX}{FY2}{SEQ:3}' with the house prefix P10 reproduces the
    // owner's live numbers; the product default is TI/<FY>/NNN.
    const series = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/number-series/tax_invoice',
      organisationId,
      payload: { template: '{PREFIX}{FY2}{SEQ:3}' },
    });
    expect(series.statusCode, series.body).toBe(200);
  });

  it('refuses a buyer whose contact cannot fill the snapshot', async () => {
    const swapped = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: invoiceBody(mb1.id, { buyerContactId: barePincodeBuyerId }),
    });
    expect(swapped.statusCode, swapped.body).toBe(200);
    const incomplete = await submitInvoice(invoice1Id);
    expect(incomplete.statusCode).toBe(400);
    const body = incomplete.json<{ code: string; message: string }>();
    expect(body.code).toBe('BUYER_PROFILE_INCOMPLETE');
    expect(body.message).toContain('stateCode');
    expect(body.message).toContain('pincode');

    const restored = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: invoiceBody(mb1.id),
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('computes the intra-state split exactly and freezes the record', async () => {
    const response = await submitInvoice(invoice1Id);
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<TaxInvoiceDetailResponse>();
    expect(detail.invoice).toMatchObject({
      status: 'submitted',
      invoiceNumber: 'P1025001',
      sequenceNumber: 1,
      fyLabel: '2025-26',
      // The MB total VERBATIM; round(25000 x 18 / 200, 2) each side.
      taxableValue: '25000.00',
      cgstAmount: '2250.00',
      sgstAmount: '2250.00',
      igstAmount: '0.00',
      totalAmount: '29500.00',
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
    expect(detail.issuedSnapshot).toMatchObject({
      templateVersion: 'ti-v1',
      amountInWords: 'Rupees Twenty-Nine Thousand Five Hundred Only',
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
      taxable_value: '25000.00',
      cgst_amount: '2250.00',
      sgst_amount: '2250.00',
      igst_amount: '0.00',
      total_amount: '29500.00',
      fy_label: '2025-26',
    });

    // Submitted means frozen: no resubmit, no edits.
    const again = await submitInvoice(invoice1Id);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('TAX_INVOICE_STATUS_CONFLICT');
    const edit = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
      payload: invoiceBody(mb1.id),
    });
    expect(edit.statusCode).toBe(409);
  });

  it('rounds the halves up where they land on a half-paisa (intra 295.60)', async () => {
    // MB2 total 250.50 at 18%: each half is round(22.545, 2) = 22.55, so
    // the intra total is 295.60 — one paisa MORE than the inter-state
    // 295.59 the next block computes on the same taxable value.
    const created = await createInvoice(mb2.id, { invoiceDate: '2026-03-31' });
    expect(created.statusCode, created.body).toBe(201);
    const invoiceId = created.json<TaxInvoiceDetailResponse>().invoice.id;
    const response = await submitInvoice(invoiceId);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      // Same FY as invoice 1 — the counter continues, gapless.
      invoiceNumber: 'P1025002',
      fyLabel: '2025-26',
      taxableValue: '250.50',
      cgstAmount: '22.55',
      sgstAmount: '22.55',
      igstAmount: '0.00',
      roundOff: '0.40',
      totalAmount: '296.00',
    });
  });

  it('computes IGST inter-state, on both sides of the FY boundary', async () => {
    mb3 = await finalizedMb('2025-08-03', '2');
    expect(mb3.total).toBe('500.00');
    // 1 April: the NEXT financial year's counter starts at 001.
    const i3 = await createInvoice(mb3.id, {
      invoiceDate: '2026-04-01',
      placeOfSupply: '27',
    });
    expect(i3.statusCode, i3.body).toBe(201);
    const i3Id = i3.json<TaxInvoiceDetailResponse>().invoice.id;
    const submitted3 = await submitInvoice(i3Id);
    expect(submitted3.statusCode, submitted3.body).toBe(201);
    expect(submitted3.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      invoiceNumber: 'P1026001',
      fyLabel: '2026-27',
      taxableValue: '500.00',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: '90.00',
      totalAmount: '590.00',
    });

    // The asymmetric rounding case: 250.50 at 18% inter-state is a
    // SINGLE round(45.09) = 45.09 — total 295.59, not the 295.60 the
    // twice-rounded intra split produced.
    mb4 = await finalizedMb('2025-08-04', '1.002');
    expect(mb4.total).toBe('250.50');
    const i4 = await createInvoice(mb4.id, {
      invoiceDate: '2026-04-02',
      placeOfSupply: '19',
    });
    expect(i4.statusCode, i4.body).toBe(201);
    const i4Id = i4.json<TaxInvoiceDetailResponse>().invoice.id;
    const submitted4 = await submitInvoice(i4Id);
    expect(submitted4.statusCode, submitted4.body).toBe(201);
    expect(submitted4.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      invoiceNumber: 'P1026002',
      fyLabel: '2026-27',
      taxableValue: '250.50',
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: '45.09',
      roundOff: '0.41',
      totalAmount: '296.00',
    });

    // Both FY counters agree with the numbers handed out.
    const counters = await admin<{ fy_label: string; next_value: number }[]>`
      select fy_label, next_value from tax_invoice_counters
      where organisation_id = ${organisationId}
      order by fy_label
    `;
    expect(counters).toEqual([
      { fy_label: '2025-26', next_value: 2 },
      { fy_label: '2026-27', next_value: 2 },
    ]);
  });

  it('serialises concurrent submits into distinct gapless numbers', async () => {
    mb5 = await finalizedMb('2025-08-05', '4');
    mb6 = await finalizedMb('2025-08-06', '5');
    const i5 = await createInvoice(mb5.id, { invoiceDate: '2026-01-10' });
    const i6 = await createInvoice(mb6.id, { invoiceDate: '2026-01-10' });
    expect(i5.statusCode, i5.body).toBe(201);
    expect(i6.statusCode, i6.body).toBe(201);
    const i5Id = i5.json<TaxInvoiceDetailResponse>().invoice.id;
    invoice6Id = i6.json<TaxInvoiceDetailResponse>().invoice.id;

    const [first, second] = await Promise.all([
      submitInvoice(i5Id),
      submitInvoice(invoice6Id),
    ]);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    const numbers = [
      first.json<TaxInvoiceDetailResponse>().invoice.invoiceNumber,
      second.json<TaxInvoiceDetailResponse>().invoice.invoiceNumber,
    ].sort();
    expect(numbers).toEqual(['P1025003', 'P1025004']);
  });
});

describe('the IRP payload and response', () => {
  it('serves the canonical NIC 1.1 JSON for a submitted invoice — golden', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${invoice1Id}/irp-payload`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toStrictEqual({
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N' },
      DocDtls: { Typ: 'INV', No: 'P1025001', Dt: '15/03/2026' },
      SellerDtls: {
        Gstin: ORG_GSTIN,
        LglNm: 'TI Constructions',
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
          UnitPrice: 25000,
          TotAmt: 25000,
          AssAmt: 25000,
          GstRt: 18,
          CgstAmt: 2250,
          SgstAmt: 2250,
          IgstAmt: 0,
          TotItemVal: 29500,
        },
      ],
      ValDtls: {
        AssVal: 25000,
        CgstVal: 2250,
        SgstVal: 2250,
        IgstVal: 0,
        // This invoice's taxable value lands on a whole rupee, so there
        // is nothing to round and NIC is told so explicitly.
        RndOffAmt: 0,
        TotInvVal: 29500,
      },
    });
  });

  it('answers the payload and the response only for a submitted invoice', async () => {
    // A fresh draft on a fresh MB: no number yet, so no payload and no
    // response to record.
    const mb = await finalizedMb('2025-08-06', '3');
    const created = await createInvoice(mb.id, { invoiceDate: '2026-01-15' });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json<TaxInvoiceDetailResponse>().invoice.id;

    const payload = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${draftId}/irp-payload`,
      organisationId,
    });
    expect(payload.statusCode).toBe(409);
    expect(payload.json<{ code: string }>().code).toBe('TAX_INVOICE_STATUS_CONFLICT');

    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${draftId}/irp-response`,
      organisationId,
      payload: {
        irn: '0123456789abcdef'.repeat(4),
        ackNumber: '112010036563',
        ackDate: '2026-03-16T10:30:00.000Z',
        ackDateText: '16/03/2026 16:00:00',
        signedQr: 'signed-qr-jws-payload',
      },
    });
    expect(recorded.statusCode).toBe(409);

    const rendered = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${draftId}/render`,
      organisationId,
    });
    expect(rendered.statusCode).toBe(409);
    expect(rendered.json<{ code: string }>().code).toBe('TAX_INVOICE_STATUS_CONFLICT');

    const dropped = await authed(owner, {
      method: 'DELETE',
      url: `/api/tax-invoices/${draftId}`,
      organisationId,
    });
    expect(dropped.statusCode, dropped.body).toBe(204);

    // Cancel the probe MB too: it was finalized after MB6, and the MB
    // rules cancel newest-first — the closure tests below cancel MB6.
    const mbCancelled = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb.id}/cancel`,
      organisationId,
      payload: { note: 'probe MB for the draft-payload refusal' },
    });
    expect(mbCancelled.statusCode, mbCancelled.body).toBe(200);
  });

  it('renders and serves a stored PDF only from the frozen submitted invoice', async () => {
    const pdf = Buffer.from('%PDF-1.7\npre-irp-tax-invoice\n%%EOF', 'utf8');
    let renderedHtml = '';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeInstanceOf(FormData);
        const file = (init?.body as FormData).get('files');
        expect(file).toBeInstanceOf(Blob);
        renderedHtml = await (file as Blob).text();
        return new Response(pdf, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      });

    // Prove the renderer does not read mutable party text. Branding is read
    // once for this render and frozen into its retained version.
    await admin`
      update organisations set name = 'MUTATED LIVE SUPPLIER'
      where id = ${organisationId}
    `;
    await admin`
      update contacts set designation = 'MUTATED LIVE BUYER'
      where id = ${buyerContactId}
    `;
    try {
      const denied = await authed(viewer, {
        method: 'POST',
        url: `/api/tax-invoices/${invoice1Id}/render`,
        organisationId,
      });
      expect(denied.statusCode).toBe(403);

      const hidden = await authed(outsider, {
        method: 'POST',
        url: `/api/tax-invoices/${invoice1Id}/render`,
        organisationId: outsiderOrganisationId,
      });
      expect(hidden.statusCode).toBe(404);

      const rendered = await authed(owner, {
        method: 'POST',
        url: `/api/tax-invoices/${invoice1Id}/render`,
        organisationId,
      });
      expect(rendered.statusCode, rendered.body).toBe(200);
      expect(rendered.json<TaxInvoiceDetailResponse>().invoice.renderedAvailable).toBe(
        true,
      );
      expect(renderedHtml).toContain('TI Constructions');
      expect(renderedHtml).toContain('Sr. DEE (G) NR');
      expect(renderedHtml).not.toContain('MUTATED LIVE SUPPLIER');
      expect(renderedHtml).not.toContain('MUTATED LIVE BUYER');
      expect(renderedHtml).not.toContain('IRP signed QR code');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const downloaded = await authed(viewer, {
        method: 'GET',
        url: `/api/tax-invoices/${invoice1Id}/pdf`,
        organisationId,
      });
      expect(downloaded.statusCode, downloaded.body).toBe(200);
      expect(downloaded.headers['content-type']).toContain('application/pdf');
      expect(downloaded.rawPayload.equals(pdf)).toBe(true);

      const foreignDownload = await authed(outsider, {
        method: 'GET',
        url: `/api/tax-invoices/${invoice1Id}/pdf`,
        organisationId: outsiderOrganisationId,
      });
      expect(foreignDownload.statusCode).toBe(404);

      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const [stored] = await admin<
        {
          template_version: string | null;
          rendered_object_key: string | null;
          rendered_sha256: string | null;
        }[]
      >`
        select template_version, rendered_object_key, rendered_sha256
        from tax_invoices where id = ${invoice1Id}
      `;
      expect(stored).toEqual({
        template_version: 'ti-v1',
        rendered_object_key: `${organisationId}/ti/${invoice1Id}-${sha256.slice(0, 16)}.pdf`,
        rendered_sha256: sha256,
      });
      firstRenderedInvoiceKey = stored?.rendered_object_key ?? '';
      const firstRenders = await admin<
        {
          version: number;
          object_key: string;
          pdf_sha256: string;
          source_sha256: string | null;
          source_evidence_missing: boolean;
          template_contract_legacy: boolean;
          object_key_scope_missing: boolean;
          logo_evidence_missing: boolean;
        }[]
      >`
        select version, object_key, pdf_sha256, source_sha256,
               source_evidence_missing, template_contract_legacy,
               object_key_scope_missing, logo_evidence_missing
        from tax_invoice_renders where tax_invoice_id = ${invoice1Id}
        order by version
      `;
      expect(firstRenders).toHaveLength(1);
      expect(firstRenders[0]).toMatchObject({
        version: 1,
        object_key: firstRenderedInvoiceKey,
        pdf_sha256: sha256,
        source_evidence_missing: false,
        template_contract_legacy: false,
        object_key_scope_missing: false,
        logo_evidence_missing: false,
      });
      expect(firstRenders[0]?.source_sha256).toMatch(/^[0-9a-f]{64}$/);
      const [audit] = await admin<
        { action: string; sha256: string | null; evidence: string | null }[]
      >`
        select action, details->>'sha256' as sha256,
               details->>'irpEvidenceIncluded' as evidence
        from audit_events
        where organisation_id = ${organisationId}
          and entity_id = ${invoice1Id}
          and action = 'tax_invoice.rendered'
        order by occurred_at desc
        limit 1
      `;
      expect(audit).toEqual({
        action: 'tax_invoice.rendered',
        sha256,
        evidence: 'false',
      });

      const storedPdfPath = path.join(
        storageDir,
        ...firstRenderedInvoiceKey.split('/'),
      );
      await writeFile(storedPdfPath, Buffer.from('%PDF-1.7\ntampered\n%%EOF'));
      try {
        const tampered = await authed(viewer, {
          method: 'GET',
          url: `/api/tax-invoices/${invoice1Id}/pdf`,
          organisationId,
        });
        expect(tampered.statusCode, tampered.body).toBe(409);
        expect(tampered.json<{ code: string }>().code).toBe(
          'RENDERED_PDF_INTEGRITY_FAILED',
        );
      } finally {
        await writeFile(storedPdfPath, pdf);
      }

      fetchMock.mockResolvedValueOnce(
        new Response('provider unavailable', { status: 503 }),
      );
      const failed = await authed(owner, {
        method: 'POST',
        url: `/api/tax-invoices/${invoice1Id}/render`,
        organisationId,
      });
      expect(failed.statusCode).toBe(502);
      expect(failed.json<{ code: string }>().code).toBe('RENDER_FAILED');
      const [unchanged] = await admin<
        { rendered_object_key: string | null; rendered_sha256: string | null }[]
      >`
        select rendered_object_key, rendered_sha256
        from tax_invoices where id = ${invoice1Id}
      `;
      expect(unchanged?.rendered_object_key).toBe(firstRenderedInvoiceKey);
      expect(unchanged?.rendered_sha256).toBe(sha256);
      const [renderCount] = await admin<{ count: number }[]>`
        select count(*)::int as count from tax_invoice_renders
        where tax_invoice_id = ${invoice1Id}
      `;
      expect(renderCount?.count).toBe(1);
    } finally {
      fetchMock.mockRestore();
      await admin`
        update organisations set name = 'TI Constructions'
        where id = ${organisationId}
      `;
      await admin`
        update contacts set designation = 'Sr. DEE (G) NR'
        where id = ${buyerContactId}
      `;
    }
  });

  it('records the IRP response once, and only once', async () => {
    // Derived, not invented: the manual door refuses an IRN that does not
    // reproduce from this invoice's own frozen identity (finding 2).
    const irn = await derivedIrnForInvoice(invoice1Id);
    const badIrn = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice1Id}/irp-response`,
      organisationId,
      payload: {
        irn: 'NOT-HEX',
        ackNumber: '112010036563',
        ackDate: '2026-03-16T10:30:00.000Z',
        ackDateText: '16/03/2026 16:00:00',
        signedQr: 'signed-qr-jws-payload',
      },
    });
    expect(badIrn.statusCode).toBe(400);

    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice1Id}/irp-response`,
      organisationId,
      payload: {
        irn,
        ackNumber: '112010036563',
        ackDate: '2026-03-16T10:30:00.000Z',
        ackDateText: '16/03/2026 16:00:00',
        signedQr: 'signed-qr-jws-payload',
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const detail = recorded.json<TaxInvoiceDetailResponse>();
    expect(detail.invoice.irn).toBe(irn);
    expect(detail.invoice.ackNumber).toBe('112010036563');
    expect(detail.invoice.ackDate).toBe('2026-03-16T10:30:00.000Z');
    expect(detail.signedQr).toBe('signed-qr-jws-payload');
    // Manually typed evidence lands in its own state (migration 0053):
    // never the provider-verified 'registered'.
    expect(detail.invoice.irpProvider).toBe('manual');
    expect(detail.invoice.irpProviderState).toBe('registered_unverified');

    const again = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice1Id}/irp-response`,
      organisationId,
      payload: {
        irn: 'fedcba9876543210'.repeat(4),
        ackNumber: '999999999999',
        ackDate: '2026-03-17T10:30:00.000Z',
        ackDateText: '17/03/2026 16:00:00',
        signedQr: 'other',
      },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('IRP_ALREADY_RECORDED');
    // The first recording stands untouched.
    const [row] = await admin<{ irn: string | null }[]>`
      select irn from tax_invoices where id = ${invoice1Id}
    `;
    expect(row?.irn).toBe(irn);
  });

  it('re-renders after registration with exact IRP text and an embedded signed QR', async () => {
    const pdf = Buffer.from('%PDF-1.7\nregistered-tax-invoice\n%%EOF', 'utf8');
    let renderedHtml = '';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        const file = (init?.body as FormData).get('files');
        renderedHtml = await (file as Blob).text();
        return new Response(pdf, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      });
    try {
      const rendered = await authed(owner, {
        method: 'POST',
        url: `/api/tax-invoices/${invoice1Id}/render`,
        organisationId,
      });
      expect(rendered.statusCode, rendered.body).toBe(200);
      expect(renderedHtml).toContain(await derivedIrnForInvoice(invoice1Id));
      expect(renderedHtml).toContain('112010036563');
      expect(renderedHtml).toContain('16/03/2026 16:00:00');
      expect(renderedHtml).toContain('Manual or legacy IRP evidence — unverified');
      expect(renderedHtml).toContain('data:image/svg+xml;base64,');
      expect(renderedHtml).toContain('alt="IRP signed QR code"');
      expect(renderedHtml).not.toContain('signed-qr-jws-payload');

      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const [stored] = await admin<
        { rendered_object_key: string | null; rendered_sha256: string | null }[]
      >`
        select rendered_object_key, rendered_sha256
        from tax_invoices where id = ${invoice1Id}
      `;
      expect(stored?.rendered_object_key).toBe(
        `${organisationId}/ti/${invoice1Id}-${sha256.slice(0, 16)}.pdf`,
      );
      expect(stored?.rendered_object_key).not.toBe(firstRenderedInvoiceKey);
      expect(stored?.rendered_sha256).toBe(sha256);
      const renderHistory = await admin<
        { version: number; object_key: string; pdf_sha256: string }[]
      >`
        select version, object_key, pdf_sha256
        from tax_invoice_renders where tax_invoice_id = ${invoice1Id}
        order by version
      `;
      expect(renderHistory).toEqual([
        expect.objectContaining({ version: 1, object_key: firstRenderedInvoiceKey }),
        {
          version: 2,
          object_key: stored?.rendered_object_key ?? '',
          pdf_sha256: sha256,
        },
      ]);
      const exported = await authed(owner, {
        method: 'GET',
        url: '/api/export',
        organisationId,
      });
      expect(exported.statusCode, exported.body).toBe(200);
      const exportBody = exported.json<{
        taxInvoiceRenders: { tax_invoice_id: string; object_key: string }[];
        objectManifest: { objectKey: string }[];
      }>();
      expect(
        exportBody.taxInvoiceRenders.filter((row) => row.tax_invoice_id === invoice1Id),
      ).toHaveLength(2);
      expect(exportBody.objectManifest.map((entry) => entry.objectKey)).toEqual(
        expect.arrayContaining([
          firstRenderedInvoiceKey,
          stored?.rendered_object_key ?? '',
        ]),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('MB closure: the invoice closes the MB, cancelling releases it', () => {
  it('lists the Work invoices with their MB numbers', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/tax-invoices`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { invoices } = response.json<TaxInvoiceListResponse>();
    expect(invoices.length).toBe(6);
    const byMb = new Map(
      invoices.map((invoice) => [invoice.measurementBookId, invoice]),
    );
    expect(byMb.get(mb1.id)?.mbNumber).toBe(mb1.number);
    expect(byMb.get(mb6.id)?.mbNumber).toBe(mb6.number);
    expect(byMb.get(mb1.id)?.invoiceNumber).toBe('P1025001');
  });

  it('the 0035 trigger refuses cancelling an invoiced MB, against ANY writer', async () => {
    // MB6 is the newest live MB (the only one the MB rules would let
    // cancel) and carries submitted invoice 6 — the database itself
    // refuses, so no route or script can sidestep the closure.
    await expect(
      admin`
        update measurement_books
        set status = 'cancelled', cancellation_note = 'closure trigger probe',
            cancelled_by_user_id = ${ownerUserId}, cancelled_at = now()
        where id = ${mb6.id}
      `,
    ).rejects.toThrowError(/closed by a tax invoice/);
  });

  it('cancelling the invoice releases the MB, which then cancels normally', async () => {
    const retainedPdf = Buffer.from('%PDF-1.7\ninvoice-kept-after-cancel\n%%EOF');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(retainedPdf, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    try {
      const rendered = await authed(owner, {
        method: 'POST',
        url: `/api/tax-invoices/${invoice6Id}/render`,
        organisationId,
      });
      expect(rendered.statusCode, rendered.body).toBe(200);
    } finally {
      fetchMock.mockRestore();
    }

    const unauthorised = await authed(clerk, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice6Id}/cancel`,
      organisationId,
      payload: { note: 'clerk cannot cancel' },
    });
    expect(unauthorised.statusCode).toBe(403);
    expect(unauthorised.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice6Id}/cancel`,
      organisationId,
      payload: { note: 'wrong buyer picked; re-invoicing' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const detail = cancelled.json<TaxInvoiceDetailResponse>();
    expect(detail.invoice.status).toBe('cancelled');
    // The number is kept forever (rule 8).
    expect(detail.invoice.invoiceNumber).toMatch(/^P102500[34]$/);
    expect(detail.invoice.cancellationNote).toBe('wrong buyer picked; re-invoicing');

    // The MB is released: its own cancel now succeeds through the API.
    const mbCancelled = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mb6.id}/cancel`,
      organisationId,
      payload: { note: 'released after invoice cancellation' },
    });
    expect(mbCancelled.statusCode, mbCancelled.body).toBe(200);
    expect(mbCancelled.json<MeasurementBookDetailResponse>().book.status).toBe(
      'cancelled',
    );

    // Cancellation retains the original issued evidence and only blocks a
    // new render. The already stored PDF remains readable.
    const retained = await authed(viewer, {
      method: 'GET',
      url: `/api/tax-invoices/${invoice6Id}/pdf`,
      organisationId,
    });
    expect(retained.statusCode, retained.body).toBe(200);
    expect(retained.rawPayload.equals(retainedPdf)).toBe(true);
    const rerenderCancelled = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice6Id}/render`,
      organisationId,
    });
    expect(rerenderCancelled.statusCode).toBe(409);
  });

  it('a cancelled invoice releases the one-live-per-MB slot too', async () => {
    // MB5's invoice is live; cancel it and a corrected draft can be
    // raised on the same MB.
    const [i5Row] = await admin<{ id: string }[]>`
      select id from tax_invoices
      where measurement_book_id = ${mb5.id} and status = 'submitted'
    `;
    expect(i5Row).toBeDefined();
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${i5Row?.id ?? ''}/cancel`,
      organisationId,
      payload: { note: 'superseded by a corrected invoice' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const corrected = await createInvoice(mb5.id, { invoiceDate: '2026-02-01' });
    expect(corrected.statusCode, corrected.body).toBe(201);
    const correctedId = corrected.json<TaxInvoiceDetailResponse>().invoice.id;

    // Drafts are deleted, never cancelled.
    const draftCancel = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${correctedId}/cancel`,
      organisationId,
      payload: { note: 'trying to cancel a draft' },
    });
    expect(draftCancel.statusCode).toBe(409);
    expect(draftCancel.json<{ code: string }>().code).toBe(
      'TAX_INVOICE_STATUS_CONFLICT',
    );
    const dropped = await authed(owner, {
      method: 'DELETE',
      url: `/api/tax-invoices/${correctedId}`,
      organisationId,
    });
    expect(dropped.statusCode, dropped.body).toBe(204);
  });
});

describe('tenancy and scope', () => {
  it('answers 404 across tenants and 401 without a session', async () => {
    const read = await authed(outsider, {
      method: 'GET',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId: outsiderOrganisationId,
    });
    expect(read.statusCode).toBe(404);

    const list = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workId}/tax-invoices`,
      organisationId: outsiderOrganisationId,
    });
    expect(list.statusCode).toBe(404);

    const edit = await authed(outsider, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId: outsiderOrganisationId,
      payload: invoiceBody(mb1.id),
    });
    expect(edit.statusCode).toBe(404);

    const payload = await authed(outsider, {
      method: 'GET',
      url: `/api/tax-invoices/${invoice1Id}/irp-payload`,
      organisationId: outsiderOrganisationId,
    });
    expect(payload.statusCode).toBe(404);

    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/tax-invoices/${invoice1Id}`,
      headers: { 'x-organisation-id': organisationId },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

/* An invoice need not bill a Measurement Book. A contractor also sells to
 * private customers, and that invoice descends from no LOA, no Work and
 * no MB — it states its own taxable value and is otherwise the same
 * document, down to the GST split and the number it takes from the same
 * gapless series. */
describe('direct invoices: no Work, no Measurement Book', () => {
  it('drafts, submits and taxes an invoice that names no Measurement Book', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-01-15',
        sacCode: '998734',
        serviceDescription: 'Supply and commissioning for a private customer.',
        gstRate: '18',
        // Same state as the organisation (07), so CGST+SGST.
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        taxableValue: '10000.00',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const detail = created.json<TaxInvoiceDetailResponse>();
    expect(detail.invoice).toMatchObject({
      workId: null,
      measurementBookId: null,
      statedTaxableValue: '10000.00',
      status: 'draft',
    });

    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/submit`,
      organisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(submitted.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      taxableValue: '10000.00',
      cgstAmount: '900.00',
      sgstAmount: '900.00',
      igstAmount: '0.00',
      // 11800 is already whole rupees, so nothing to round.
      roundOff: '0.00',
      totalAmount: '11800.00',
      // The same series the Work-backed invoices draw on: one gapless
      // sequence per financial year, whatever the invoice descends from.
      fyLabel: '2025-26',
    });

    const directPdf = Buffer.from('%PDF-1.7\ndirect-invoice\n%%EOF');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(directPdf, { status: 200 }));
    try {
      const rendered = await authed(owner, {
        method: 'POST',
        url: `/api/tax-invoices/${detail.invoice.id}/render`,
        organisationId,
      });
      expect(rendered.statusCode, rendered.body).toBe(200);
      expect(rendered.json<TaxInvoiceDetailResponse>().invoice.renderedAvailable).toBe(
        true,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('refuses a direct invoice that states no taxable value', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-01-15',
        sacCode: '998734',
        serviceDescription: 'Supply for a private customer.',
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
      },
    });
    // The schema names the missing field; without a value the invoice
    // would have no answer to what it is worth.
    expect(created.statusCode).toBe(400);
  });
});

/**
 * ITEMISED invoices (migration 0057). The owner's requirement: the
 * goods-vs-service shape is a PER-DOCUMENT choice — never derived from
 * the buyer — so the same organisation, the same railway consignee and
 * the same Work all keep working with either shape.
 *
 * What has to hold here: the per-line money is quantity x rate at the
 * LINE's own GST rate; the header is the exact SUM of the lines; the
 * frozen snapshot is v2 while a cumulative invoice keeps freezing v1
 * unchanged; the IRP ItemList becomes the mapped lines with IsServc and
 * HsnCd per line; and a full-value credit note against an itemised
 * invoice still works end to end.
 */
describe('itemised invoices (migration 0057)', () => {
  let itemisedInvoiceId: string;

  it('drafts, edits and submits an itemised direct invoice, summing the lines', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-01-20',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        lineShape: 'itemised',
        lines: [
          {
            isService: false,
            hsnSacCode: '85444999',
            description: 'Signalling cable, 4 core',
            quantity: '100.000',
            unitLabel: 'm',
            unitRate: '85.50',
            gstRate: '18',
          },
          {
            isService: true,
            hsnSacCode: '995461',
            description: 'Laying and termination',
            quantity: '1.000',
            unitLabel: 'job',
            unitRate: '4500.00',
            gstRate: '18',
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json<TaxInvoiceDetailResponse>();
    itemisedInvoiceId = draft.invoice.id;
    expect(draft.invoice).toMatchObject({
      lineShape: 'itemised',
      // An itemised invoice carries no header line at all.
      sacCode: null,
      serviceDescription: null,
      gstRate: null,
      // Derived from the lines, never asked for twice:
      // 100 x 85.50 = 8550.00 plus 1 x 4500.00.
      statedTaxableValue: '13050.00',
      status: 'draft',
    });
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[0]).toMatchObject({
      position: 1,
      isService: false,
      hsnSacCode: '85444999',
      unitRate: '85.50',
      // Draft money is open, exactly as the header's is.
      taxableValue: null,
      cgstAmount: null,
    });
    expect(draft.lines[1]).toMatchObject({ position: 2, isService: true });

    // Editing replaces the lines wholesale, like every other field.
    const edited = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${itemisedInvoiceId}`,
      organisationId,
      payload: {
        invoiceDate: '2026-01-20',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        lineShape: 'itemised',
        lines: [
          {
            isService: false,
            hsnSacCode: '85444999',
            description: 'Signalling cable, 4 core',
            quantity: '100.000',
            unitLabel: 'm',
            unitRate: '85.50',
            gstRate: '18',
          },
          {
            isService: true,
            hsnSacCode: '995461',
            description: 'Laying and termination',
            quantity: '1.000',
            unitLabel: 'job',
            unitRate: '5000.00',
            gstRate: '5',
          },
        ],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<TaxInvoiceDetailResponse>().invoice.statedTaxableValue).toBe(
      '13550.00',
    );

    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${itemisedInvoiceId}/submit`,
      organisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const issued = submitted.json<TaxInvoiceDetailResponse>();
    // Line 1: 8550.00 at 18% -> 769.50 each half.
    // Line 2: 5000.00 at 5%  -> 125.00 each half.
    // Header: 13550.00 taxable, 894.50 + 894.50, 15339.00 exactly.
    expect(issued.invoice).toMatchObject({
      taxableValue: '13550.00',
      cgstAmount: '894.50',
      sgstAmount: '894.50',
      igstAmount: '0.00',
      roundOff: '0.00',
      totalAmount: '15339.00',
    });
    expect(issued.lines).toHaveLength(2);
    expect(issued.lines[0]).toMatchObject({
      taxableValue: '8550.00',
      cgstAmount: '769.50',
      sgstAmount: '769.50',
      igstAmount: '0.00',
    });
    expect(issued.lines[1]).toMatchObject({
      taxableValue: '5000.00',
      cgstAmount: '125.00',
      sgstAmount: '125.00',
      igstAmount: '0.00',
    });

    // Snapshot v2: `lines`, and never a `line`.
    const snapshot = issued.issuedSnapshot as {
      templateVersion: string;
      lines: { position: number; isService: boolean; hsnSacCode: string }[];
      line?: unknown;
    };
    expect(snapshot.templateVersion).toBe('ti-v2');
    expect(snapshot.line).toBeUndefined();
    expect(snapshot.lines).toHaveLength(2);
    expect(snapshot.lines[0]).toMatchObject({
      position: 1,
      isService: false,
      hsnSacCode: '85444999',
    });
  });

  it('maps the IRP ItemList from the frozen lines, one item each', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${itemisedInvoiceId}/irp-payload`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const payload = response.json<{
      TranDtls: { SupTyp: string };
      ItemList: Record<string, unknown>[];
      ValDtls: Record<string, unknown>;
    }>();
    // The supply type is about the TRANSACTION, not the lines: a
    // registered buyer is B2B whether the lines are goods or services.
    expect(payload.TranDtls.SupTyp).toBe('B2B');
    expect(payload.ItemList).toStrictEqual([
      {
        SlNo: '1',
        PrdDesc: 'Signalling cable, 4 core',
        IsServc: 'N',
        HsnCd: '85444999',
        Qty: 100,
        Unit: 'OTH',
        UnitPrice: 85.5,
        TotAmt: 8550,
        AssAmt: 8550,
        GstRt: 18,
        CgstAmt: 769.5,
        SgstAmt: 769.5,
        IgstAmt: 0,
        TotItemVal: 10089,
      },
      {
        SlNo: '2',
        PrdDesc: 'Laying and termination',
        IsServc: 'Y',
        HsnCd: '995461',
        Qty: 1,
        Unit: 'OTH',
        UnitPrice: 5000,
        TotAmt: 5000,
        AssAmt: 5000,
        GstRt: 5,
        CgstAmt: 125,
        SgstAmt: 125,
        IgstAmt: 0,
        TotItemVal: 5250,
      },
    ]);
    expect(payload.ValDtls).toStrictEqual({
      AssVal: 13550,
      CgstVal: 894.5,
      SgstVal: 894.5,
      IgstVal: 0,
      RndOffAmt: 0,
      TotInvVal: 15339,
    });
  });

  it('renders the itemised document with a row per line', async () => {
    const pdf = Buffer.from('%PDF-1.7\nitemised-invoice\n%%EOF');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        // The HTML the renderer posted to Gotenberg is the assertion
        // subject; the PDF it answers with is a stand-in.
        const body = init?.body;
        if (body instanceof FormData) {
          const file = body.get('files');
          if (file instanceof Blob) renderedHtml = await file.text();
        }
        return new Response(pdf, { status: 200 });
      });
    let renderedHtml = '';
    try {
      const rendered = await authed(owner, {
        method: 'POST',
        url: `/api/tax-invoices/${itemisedInvoiceId}/render`,
        organisationId,
      });
      expect(rendered.statusCode, rendered.body).toBe(200);
    } finally {
      fetchMock.mockRestore();
    }
    expect(renderedHtml).toContain('HSN / SAC');
    expect(renderedHtml).toContain('85444999');
    expect(renderedHtml).toContain('995461');
    expect(renderedHtml).toContain('Laying and termination');
  });

  it('takes a full-value credit note against an itemised invoice', async () => {
    const drafted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${itemisedInvoiceId}/credit-notes`,
      organisationId,
      payload: {
        noteDate: '2026-01-25',
        reason: 'The itemised supply was returned in full.',
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const noteId = drafted.json<{ creditNote: { id: string } }>().creditNote.id;

    const issuedNote = await authed(owner, {
      method: 'POST',
      url: `/api/credit-notes/${noteId}/issue`,
      organisationId,
    });
    expect(issuedNote.statusCode, issuedNote.body).toBe(201);
    // 0051's rule, unchanged by the shape: the note copies the invoice's
    // frozen money in full and the invoice becomes superseded.
    expect(
      issuedNote.json<{ creditNote: Record<string, unknown> }>().creditNote,
    ).toMatchObject({
      status: 'issued',
      taxableValue: '13550.00',
      cgstAmount: '894.50',
      sgstAmount: '894.50',
      igstAmount: '0.00',
      totalAmount: '15339.00',
    });

    const invoiceAfter = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${itemisedInvoiceId}`,
      organisationId,
    });
    expect(invoiceAfter.statusCode, invoiceAfter.body).toBe(200);
    expect(invoiceAfter.json<TaxInvoiceDetailResponse>().invoice.status).toBe(
      'superseded',
    );

    // The CRN payload carries the invoice's own itemised lines.
    const crn = await authed(owner, {
      method: 'GET',
      url: `/api/credit-notes/${noteId}/irp-payload`,
      organisationId,
    });
    expect(crn.statusCode, crn.body).toBe(200);
    const crnPayload = crn.json<{
      DocDtls: { Typ: string };
      ItemList: { HsnCd: string; IsServc: string }[];
    }>();
    expect(crnPayload.DocDtls.Typ).toBe('CRN');
    expect(crnPayload.ItemList.map((item) => [item.HsnCd, item.IsServc])).toStrictEqual(
      [
        ['85444999', 'N'],
        ['995461', 'Y'],
      ],
    );
  });

  it('refuses an MB-backed itemised invoice whose lines miss the measured total', async () => {
    const book = await finalizedMb('2026-02-01', '3');
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/tax-invoices`,
      organisationId,
      payload: {
        measurementBookId: book.id,
        invoiceDate: '2026-02-02',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        lineShape: 'itemised',
        lines: [
          {
            isService: false,
            hsnSacCode: '85444999',
            description: 'Deliberately short of the measured total',
            quantity: '1.000',
            unitRate: '1.00',
            gstRate: '18',
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const invoiceId = created.json<TaxInvoiceDetailResponse>().invoice.id;

    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/submit`,
      organisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(409);
    expect(submitted.json<{ code: string }>().code).toBe(
      'ITEMISED_LINES_TOTAL_MISMATCH',
    );

    // Corrected to the measured total, the same invoice submits.
    const fixed = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoiceId}`,
      organisationId,
      payload: {
        invoiceDate: '2026-02-02',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        lineShape: 'itemised',
        lines: [
          {
            isService: false,
            hsnSacCode: '85444999',
            description: 'Exactly what the Measurement Book measured',
            quantity: '1.000',
            unitRate: book.total,
            gstRate: '18',
          },
        ],
      },
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
    const resubmitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/submit`,
      organisationId,
    });
    expect(resubmitted.statusCode, resubmitted.body).toBe(201);
    expect(resubmitted.json<TaxInvoiceDetailResponse>().invoice.taxableValue).toBe(
      book.total,
    );
  });

  it('refuses an eight-digit code on a service line, and a rate the master does not cover', async () => {
    const badCode = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-01-20',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        lineShape: 'itemised',
        lines: [
          {
            isService: true,
            hsnSacCode: '99546199',
            description: 'A SAC does not deepen to eight digits',
            quantity: '1.000',
            unitRate: '100.00',
            gstRate: '18',
          },
        ],
      },
    });
    expect(badCode.statusCode, badCode.body).toBe(400);
    expect(badCode.json<{ code: string }>().code).toBe('TAX_INVOICE_LINE_CODE_INVALID');

    const badRate = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-01-20',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        lineShape: 'itemised',
        lines: [
          {
            isService: false,
            hsnSacCode: '85444999',
            description: 'A rate nobody notified',
            quantity: '1.000',
            unitRate: '100.00',
            gstRate: '1.8',
          },
        ],
      },
    });
    expect(badRate.statusCode, badRate.body).toBe(400);
    expect(badRate.json<{ code: string; message: string }>()).toMatchObject({
      code: 'GST_RATE_NOT_NOTIFIED',
    });
    expect(badRate.json<{ message: string }>().message).toContain('Line 1');
  });

  it('keeps a CUMULATIVE invoice on snapshot v1, unchanged', async () => {
    // The golden proof that 0057 changed nothing for the document the
    // railway trade issues most: the first invoice of this suite was
    // frozen before any of this existed in the run's own history, and it
    // still says ti-v1 with a single `line` and no `lines`.
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${invoice1Id}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json<TaxInvoiceDetailResponse>();
    expect(detail.invoice.lineShape).toBe('service_cumulative');
    expect(detail.lines).toStrictEqual([]);
    const snapshot = detail.issuedSnapshot as {
      templateVersion: string;
      line: Record<string, unknown>;
      lines?: unknown;
    };
    expect(snapshot.templateVersion).toBe('ti-v1');
    expect(snapshot.lines).toBeUndefined();
    expect(snapshot.line).toMatchObject({
      sacCode: SAC,
      description: SERVICE_DESCRIPTION,
      quantity: '1.00',
    });
  });
});

describe('Whitebooks IRP provider routes', () => {
  it('registers and cancels once, preserving exact provider evidence', async () => {
    resetProviderMocks();
    const invoice = await submittedDirectInvoice('success');
    const evidence = irpEvidence('a');
    registerInvoiceProvider.mockResolvedValueOnce(evidence);
    cancelInvoiceProvider.mockResolvedValueOnce({
      cancelledAtText: '12/08/2026 15:00:00',
      cancelledAt: '2026-08-12T09:30:00.000Z',
      rawResponse: '{"status_cd":"1","CancelDate":"12/08/2026 15:00:00"}',
    });

    const registered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    expect(registered.statusCode, registered.body).toBe(200);
    expect(registered.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      irn: evidence.irn,
      ackNumber: evidence.ackNumber,
      ackDate: evidence.ackDate,
      ackDateText: evidence.ackDateText,
      irpProvider: 'whitebooks',
      irpProviderState: 'registered',
    });
    expect(registerInvoiceProvider).toHaveBeenCalledTimes(1);
    const [identity, payloadJson] = registerInvoiceProvider.mock.calls[0] ?? [];
    expect(identity).toEqual({
      gstin: ORG_GSTIN,
      documentNumber: invoice.invoice.invoiceNumber,
      documentDate: invoice.invoice.invoiceDate,
    });
    expect(JSON.parse(payloadJson ?? '{}')).toMatchObject({
      TranDtls: { RegRev: 'N' },
      DocDtls: { No: invoice.invoice.invoiceNumber },
    });

    const cancelled = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/cancel-irp`,
      organisationId,
      payload: { reasonCode: '2', remark: 'Data entry correction' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      irpProviderState: 'cancelled',
      irpCancelledAt: '2026-08-12T09:30:00.000Z',
      irpCancelledAtText: '12/08/2026 15:00:00',
      irpCancelReasonCode: '2',
      irpCancelRemark: 'Data entry correction',
    });
    expect(cancelInvoiceProvider).toHaveBeenCalledWith({
      gstin: ORG_GSTIN,
      irn: evidence.irn,
      reasonCode: '2',
      remark: 'Data entry correction',
    });

    const operations = await admin<
      {
        id: string;
        operation: string;
        status: string;
        provider: string;
        request_body: string | null;
        request_body_truncated: boolean;
        response_body: string | null;
        response_body_truncated: boolean;
        request_sha256: string;
      }[]
    >`
      select id, operation, status, provider,
             request_body, request_body_truncated,
             response_body, response_body_truncated, request_sha256
      from statutory_provider_operations
      where tax_invoice_id = ${invoice.invoice.id}
      order by started_at
    `;
    expect(operations).toMatchObject([
      { operation: 'register_irp', status: 'succeeded', provider: 'whitebooks' },
      { operation: 'cancel_irp', status: 'succeeded', provider: 'whitebooks' },
    ]);
    // Migration 0053: the ledger holds the raw bodies beside the hash —
    // the request is exactly the bytes request_sha256 hashes, and the
    // response is what the provider stub returned, verbatim.
    const registerOp = operations[0];
    expect(registerOp?.request_body).toBe(payloadJson);
    expect(registerOp?.request_sha256).toBe(
      createHash('sha256')
        .update(payloadJson ?? '', 'utf8')
        .digest('hex'),
    );
    expect(registerOp?.request_body_truncated).toBe(false);
    expect(registerOp?.response_body).toBe(evidence.rawResponse);
    expect(registerOp?.response_body_truncated).toBe(false);
    expect(operations[1]?.response_body).toBe(
      '{"status_cd":"1","CancelDate":"12/08/2026 15:00:00"}',
    );

    // Append-once: completed rows refuse any rewrite of either body.
    for (const [column, operationId] of [
      ['request_body', registerOp?.id],
      ['response_body', registerOp?.id],
    ] as const) {
      await expect(
        admin.unsafe(
          `update statutory_provider_operations set ${column} = '{"forged":true}' where id = $1`,
          [operationId ?? ''],
        ),
      ).rejects.toThrow(/immutable/);
    }
  });

  it('never repeats an unknown registration mutation and reconciles by lookup', async () => {
    resetProviderMocks();
    const invoice = await submittedDirectInvoice('unknown result');
    const evidence = irpEvidence('b');
    registerInvoiceProvider.mockRejectedValueOnce(
      new StatutoryProviderError('WHITEBOOKS_MUTATION_UNKNOWN', 'unknown', null, 503),
    );
    findInvoiceProvider.mockResolvedValueOnce(null).mockResolvedValueOnce(evidence);

    const uncertain = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    expect(uncertain.statusCode, uncertain.body).toBe(202);
    expect(uncertain.json<TaxInvoiceDetailResponse>().invoice.irpProviderState).toBe(
      'registration_unknown',
    );

    const reconciled = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      irn: evidence.irn,
      irpProviderState: 'registered',
    });
    expect(registerInvoiceProvider).toHaveBeenCalledTimes(1);
    expect(findInvoiceProvider).toHaveBeenCalledTimes(2);

    const operations = await admin<{ operation: string; status: string }[]>`
      select operation, status from statutory_provider_operations
      where tax_invoice_id = ${invoice.invoice.id}
      order by started_at
    `;
    expect(operations).toEqual([
      { operation: 'register_irp', status: 'unknown' },
      { operation: 'reconcile_irp', status: 'succeeded' },
    ]);
  });

  it('serialises concurrent registration so the provider mutation is sent once', async () => {
    resetProviderMocks();
    const invoice = await submittedDirectInvoice('single flight');
    const evidence = irpEvidence('c');
    let releaseProvider!: (value: typeof evidence) => void;
    registerInvoiceProvider.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseProvider = resolve;
      }),
    );

    const first = authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    await vi.waitFor(() => expect(registerInvoiceProvider).toHaveBeenCalledTimes(1));
    const second = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ code: string }>().code).toBe(
      'STATUTORY_OPERATION_IN_PROGRESS',
    );

    releaseProvider(evidence);
    const completed = await first;
    expect(completed.statusCode, completed.body).toBe(200);
    expect(registerInvoiceProvider).toHaveBeenCalledTimes(1);
  });

  it('does not commit provider evidence after issue authority is revoked', async () => {
    resetProviderMocks();
    const invoice = await submittedDirectInvoice('revoked authority');
    const evidence = irpEvidence('d');
    let releaseProvider!: (value: typeof evidence) => void;
    registerInvoiceProvider.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseProvider = resolve;
      }),
    );

    const request = authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    await vi.waitFor(() => expect(registerInvoiceProvider).toHaveBeenCalledTimes(1));
    await admin`
      update organisation_memberships set can_issue_documents = false
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
    releaseProvider(evidence);
    const denied = await request;
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');

    const [prepared] = await admin<
      { irp_provider_state: string; irn: string | null; operation_status: string }[]
    >`
      select i.irp_provider_state, i.irn, o.status as operation_status
      from tax_invoices i
      join statutory_provider_operations o on o.tax_invoice_id = i.id
      where i.id = ${invoice.invoice.id}
    `;
    expect(prepared).toEqual({
      irp_provider_state: 'registering',
      irn: null,
      operation_status: 'pending',
    });

    await admin`
      update organisation_memberships set can_issue_documents = true
      where organisation_id = ${organisationId} and user_id = ${ownerUserId}
    `;
    await expirePendingProviderOperation(invoice.invoice.id);
    const recovered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/recover-provider-operation`,
      organisationId,
    });
    expect(recovered.statusCode, recovered.body).toBe(202);
    expect(recovered.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      irn: null,
      irpProviderState: 'registration_unknown',
    });
    const [operation] = await admin<{ status: string; provider_code: string | null }[]>`
      select status, provider_code from statutory_provider_operations
      where tax_invoice_id = ${invoice.invoice.id}
    `;
    expect(operation).toEqual({
      status: 'unknown',
      provider_code: 'OPERATION_LEASE_EXPIRED',
    });
  });

  it('does not commit provider evidence after assigned Work access is revoked', async () => {
    resetProviderMocks();
    const mb = await finalizedMb('2026-03-01', '1');
    const created = await createInvoice(mb.id, { invoiceDate: '2026-03-10' });
    expect(created.statusCode, created.body).toBe(201);
    const submitted = await submitInvoice(
      created.json<TaxInvoiceDetailResponse>().invoice.id,
    );
    expect(submitted.statusCode, submitted.body).toBe(201);
    const invoice = submitted.json<TaxInvoiceDetailResponse>();
    const [clerkUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${clerkEmail}
    `;
    if (!clerkUser) throw new Error('clerk user missing');
    await admin`
      update organisation_memberships
      set work_scope = 'assigned', can_issue_documents = true
      where organisation_id = ${organisationId} and user_id = ${clerkUser.id}
    `;
    await admin`
      insert into work_assignments (
        organisation_id, work_id, user_id, created_by_user_id
      ) values (${organisationId}, ${workId}, ${clerkUser.id}, ${ownerUserId})
    `;

    const evidence = irpEvidence('e');
    let releaseProvider!: (value: typeof evidence) => void;
    registerInvoiceProvider.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseProvider = resolve;
      }),
    );
    const request = authedOn(providerApp, clerk, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    await vi.waitFor(() => expect(registerInvoiceProvider).toHaveBeenCalledTimes(1));
    await admin`
      delete from work_assignments
      where organisation_id = ${organisationId}
        and work_id = ${workId} and user_id = ${clerkUser.id}
    `;
    releaseProvider(evidence);
    const hidden = await request;
    expect(hidden.statusCode, hidden.body).toBe(404);
    expect(hidden.json<{ code: string }>().code).toBe('WORK_NOT_FOUND');

    const [prepared] = await admin<
      { irp_provider_state: string; irn: string | null }[]
    >`
      select irp_provider_state, irn from tax_invoices
      where id = ${invoice.invoice.id}
    `;
    expect(prepared).toEqual({ irp_provider_state: 'registering', irn: null });

    await admin`
      insert into work_assignments (
        organisation_id, work_id, user_id, created_by_user_id
      ) values (${organisationId}, ${workId}, ${clerkUser.id}, ${ownerUserId})
    `;
    await expirePendingProviderOperation(invoice.invoice.id);
    const recovered = await authedOn(providerApp, clerk, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/recover-provider-operation`,
      organisationId,
    });
    expect(recovered.statusCode, recovered.body).toBe(202);
    expect(recovered.json<TaxInvoiceDetailResponse>().invoice.irpProviderState).toBe(
      'registration_unknown',
    );

    await admin`
      delete from work_assignments
      where organisation_id = ${organisationId}
        and work_id = ${workId} and user_id = ${clerkUser.id}
    `;
    await admin`
      update organisation_memberships
      set work_scope = 'all', can_issue_documents = false
      where organisation_id = ${organisationId} and user_id = ${clerkUser.id}
    `;
  });
});

/* The owner's live series, composed the way their invoices are: P, the
 * railnet division code less its trailing zero, the financial year, and
 * a three-digit serial. Nothing about it is hard-coded — it is one
 * configuration of the series feature. */
describe('a division-derived number series', () => {
  it('composes P<div><fy><seq> from the buyer’s division code', async () => {
    const divisionBuyerId = randomUUID();
    await admin`
      insert into contacts (
        id, organisation_id, designation, address, gstin, pincode,
        state_code, locality, division_code, is_consignee, active,
        created_by_user_id
      )
      values (
        ${divisionBuyerId}, ${organisationId}, 'Sr. DSTE Mumbai CST',
        ${BUYER_ADDRESS}, ${BUYER_GSTIN}, '110055', '07', 'New Delhi', '100',
        true, true,
        ${ownerUserId}
      )
    `;
    const series = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/number-series/tax_invoice',
      organisationId,
      payload: { template: 'P{DIV}{FY2}{SEQ:3}' },
    });
    expect(series.statusCode, series.body).toBe(200);

    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-01-20',
        sacCode: '998734',
        serviceDescription: 'Provision of passenger amenity services.',
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId: divisionBuyerId,
        taxableValue: '1000.00',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${created.json<TaxInvoiceDetailResponse>().invoice.id}/submit`,
      organisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    // Division 100 -> 10, financial year 2025-26 -> 25.
    expect(submitted.json<TaxInvoiceDetailResponse>().invoice.invoiceNumber).toMatch(
      /^P1025\d{3}$/,
    );
  });

  it('refuses to mint a number with a hole where the division should be', async () => {
    // The buyer seeded for the rest of this suite has no division code,
    // so {DIV} cannot be filled. Half a number on a legal document is
    // worse than none.
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-01-21',
        sacCode: '998734',
        serviceDescription: 'Supply for a customer with no division.',
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        taxableValue: '1000.00',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${created.json<TaxInvoiceDetailResponse>().invoice.id}/submit`,
      organisationId,
    });
    expect(submitted.statusCode).toBe(400);
    expect(submitted.json<{ code: string }>().code).toBe('INVOICE_NUMBER_UNFILLABLE');
  });
});

describe('render-ledger and submit hardening', () => {
  beforeAll(async () => {
    // The division-series block above left '{DIV}' in the template, which
    // the suite's division-less buyer cannot fill; restore the canonical
    // series so direct submits number again.
    const series = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/number-series/tax_invoice',
      organisationId,
      payload: { template: '{PREFIX}{FY2}{SEQ:3}' },
    });
    expect(series.statusCode, series.body).toBe(200);
  });

  it('serialises concurrent renders of one invoice into distinct ledger versions', async () => {
    const invoice = await submittedDirectInvoice('concurrent render');
    const invoiceId = invoice.invoice.id;
    const pdf = Buffer.from('%PDF-1.7\nconcurrent-render\n%%EOF', 'utf8');
    // A fresh Response per call: both racing renders read a body.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(pdf, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      ),
    );
    try {
      const [first, second] = await Promise.all([
        authed(owner, {
          method: 'POST',
          url: `/api/tax-invoices/${invoiceId}/render`,
          organisationId,
        }),
        authed(owner, {
          method: 'POST',
          url: `/api/tax-invoices/${invoiceId}/render`,
          organisationId,
        }),
      ]);
      // The invoice row lock serialises the ledger writes: both renders
      // succeed, and each retained version is distinct and consecutive —
      // no duplicate version, no lost ledger row.
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const renders = await admin<{ version: number; pdf_sha256: string }[]>`
        select version, pdf_sha256 from tax_invoice_renders
        where tax_invoice_id = ${invoiceId}
        order by version
      `;
      expect(renders.map((row) => row.version)).toEqual([1, 2]);
      expect(renders.every((row) => row.pdf_sha256 === sha256)).toBe(true);
      const [pointer] = await admin<{ rendered_sha256: string | null }[]>`
        select rendered_sha256 from tax_invoices where id = ${invoiceId}
      `;
      expect(pointer?.rendered_sha256).toBe(sha256);
      const [audited] = await admin<{ count: number }[]>`
        select count(*)::int as count from audit_events
        where organisation_id = ${organisationId} and entity_id = ${invoiceId}
          and action = 'tax_invoice.rendered'
      `;
      expect(audited?.count).toBe(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('refuses concurrent submits of a reverse-charge invoice without minting a number', async () => {
    const [counterBefore] = await admin<{ next_value: number }[]>`
      select next_value from tax_invoice_counters
      where organisation_id = ${organisationId} and fy_label = '2025-26'
    `;
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-02-20',
        sacCode: '998734',
        serviceDescription: 'Reverse-charge concurrency probe.',
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: true,
        buyerContactId,
        taxableValue: '1000.00',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const invoiceId = created.json<TaxInvoiceDetailResponse>().invoice.id;

    // The reverse-charge refusal happens under the invoice row lock and
    // BEFORE numbering: two simultaneous submits both refuse, the draft
    // survives untouched, and the gapless FY counter never moves.
    const [first, second] = await Promise.all([
      submitInvoice(invoiceId),
      submitInvoice(invoiceId),
    ]);
    for (const response of [first, second]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('REVERSE_CHARGE_UNSUPPORTED');
    }
    const [row] = await admin<
      {
        status: string;
        invoice_number: string | null;
        sequence_number: number | null;
      }[]
    >`
      select status, invoice_number, sequence_number
      from tax_invoices where id = ${invoiceId}
    `;
    expect(row).toEqual({
      status: 'draft',
      invoice_number: null,
      sequence_number: null,
    });
    const [counterAfter] = await admin<{ next_value: number }[]>`
      select next_value from tax_invoice_counters
      where organisation_id = ${organisationId} and fy_label = '2025-26'
    `;
    expect(counterAfter?.next_value).toBe(counterBefore?.next_value);
  });

  it('refuses TRUNCATE on the render ledger from the application role', async () => {
    const [before] = await admin<{ count: number }[]>`
      select count(*)::int as count from tax_invoice_renders
      where organisation_id = ${organisationId}
    `;
    const appDb = createDatabasePool({
      url: appUrl,
      max: 1,
      applicationName: 'auto-mb-ti-truncate-probe',
    });
    try {
      // Wrapped in a transaction that always throws: if the TRUNCATE
      // revoke ever regresses, the data is rolled back and the test fails
      // on the wrong rejection instead of destroying the render ledger.
      await expect(
        appDb.begin(async (tx) => {
          await tx.unsafe('truncate tax_invoice_renders');
          throw new Error('truncate unexpectedly succeeded');
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await appDb.end();
    }
    const [after] = await admin<{ count: number }[]>`
      select count(*)::int as count from tax_invoice_renders
      where organisation_id = ${organisationId}
    `;
    expect(after?.count).toBe(before?.count);
    expect(after?.count).toBeGreaterThan(0);
  });
});

describe('numbering scope across financial years (finding 8)', () => {
  /* The invoice counter restarts each financial year while the number
   * is unique per organisation. A template with no financial year would
   * repeat this year's numbers next year — and because the counter
   * rolls back with the failed submit, every retry would request the
   * same number again: a wedged series with a finished invoice in hand.
   * The calendar-year tokens do not qualify either: FY 2026-27 dated
   * January 2027 and FY 2027-28 dated May 2027 both render {YYYY} as
   * 2027 over a restarted counter. */

  it('refuses an invoice template with no financial year when it is saved', async () => {
    for (const template of ['TI/{SEQ}', 'TI/{YYYY}/{SEQ:3}']) {
      const saved = await authed(owner, {
        method: 'PUT',
        url: '/api/organisation/number-series/tax_invoice',
        organisationId,
        payload: { template },
      });
      expect(saved.statusCode, `${template}: ${saved.body}`).toBe(400);
      expect(saved.json()).toMatchObject({ code: 'NUMBER_TEMPLATE_INVALID' });
      expect(saved.json<{ message: string }>().message).toMatch(/\{FY\} or \{FY2\}/);
    }
  });

  it('keeps two financial years collision-free under an {FY}-scoped series', async () => {
    const saved = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/number-series/tax_invoice',
      organisationId,
      payload: { template: '{PREFIX}/{FY}/{SEQ}' },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    // One invoice on each side of the 1 April boundary; each series
    // carries its own financial year, so the restarted counter cannot
    // collide across years.
    const numbers: string[] = [];
    for (const [invoiceDate, fyLabel] of [
      ['2026-03-20', '2025-26'],
      ['2026-04-20', '2026-27'],
    ] as const) {
      const created = await authed(owner, {
        method: 'POST',
        url: '/api/tax-invoices',
        organisationId,
        payload: {
          invoiceDate,
          sacCode: '998734',
          serviceDescription: `Numbering scope proof for FY ${fyLabel}.`,
          gstRate: '18',
          placeOfSupply: '07',
          reverseChargeApplicable: false,
          buyerContactId,
          taxableValue: '1000.00',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const submitted = await authed(owner, {
        method: 'POST',
        url: `/api/tax-invoices/${created.json<TaxInvoiceDetailResponse>().invoice.id}/submit`,
        organisationId,
      });
      expect(submitted.statusCode, submitted.body).toBe(201);
      const number = submitted.json<TaxInvoiceDetailResponse>().invoice.invoiceNumber;
      expect(number).toMatch(/^P10\/\d{4}-\d{2}\/\d+$/);
      expect(number?.startsWith(`P10/${fyLabel}/`), number ?? '').toBe(true);
      numbers.push(number ?? '');
    }
    expect(new Set(numbers).size).toBe(2);
  });
});

describe('GST rate master enforcement (finding 19)', () => {
  /* The org-editable gst_rates master (migration 0048) decides which
   * (rate, date) pairs an invoice may carry: rates are notifications with
   * effective windows, not free numbers. What has to hold: a live rate is
   * accepted today; an abolished rate is accepted only inside its window;
   * a rate outside its window — or a 1.8-instead-of-18 typo — is a named
   * 400; and the check runs AGAIN at submit, because both the invoice
   * date and the master itself can change between drafting and the money
   * moment. */

  async function draftDirect(overrides: Record<string, unknown> = {}) {
    return authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-02-15',
        sacCode: '998734',
        serviceDescription: 'GST rate master proof invoice.',
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        taxableValue: '500.00',
        ...overrides,
      },
    });
  }

  it('accepts a live rate today and an abolished rate inside its window', async () => {
    const live = await draftDirect();
    expect(live.statusCode, live.body).toBe(201);
    expect(live.json<TaxInvoiceDetailResponse>().invoice.gstRate).toBe('18.00');

    // 12% ended 21 Sep 2025 (GST 2.0); an invoice dated before that is
    // still legitimate history and must keep working.
    const historic = await draftDirect({ invoiceDate: '2025-09-01', gstRate: '12' });
    expect(historic.statusCode, historic.body).toBe(201);
    expect(historic.json<TaxInvoiceDetailResponse>().invoice.gstRate).toBe('12.00');
  });

  it('refuses an abolished rate after its window, naming rate, date, and the live rates', async () => {
    const refused = await draftDirect({ gstRate: '12' });
    expect(refused.statusCode).toBe(400);
    const body = refused.json<{ code: string; message: string }>();
    expect(body.code).toBe('GST_RATE_NOT_NOTIFIED');
    expect(body.message).toContain('12%');
    expect(body.message).toContain('2026-02-15');
    expect(body.message).toContain('18.00%');
  });

  it('refuses the 1.8-instead-of-18 typo as a named 400', async () => {
    const refused = await draftDirect({ gstRate: '1.8' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe('GST_RATE_NOT_NOTIFIED');
  });

  it('refuses a date edit that carries the rate out of its window', async () => {
    const created = await draftDirect({ invoiceDate: '2025-09-01', gstRate: '12' });
    expect(created.statusCode, created.body).toBe(201);
    const invoiceId = created.json<TaxInvoiceDetailResponse>().invoice.id;
    const moved = await authed(owner, {
      method: 'PUT',
      url: `/api/tax-invoices/${invoiceId}`,
      organisationId,
      payload: {
        invoiceDate: '2026-01-15',
        sacCode: '998734',
        serviceDescription: 'GST rate master proof invoice.',
        gstRate: '12',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
      },
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json<{ code: string }>().code).toBe('GST_RATE_NOT_NOTIFIED');
  });

  it('re-checks at submit, so an end-dated rate is never monetised', async () => {
    // The owner records a bespoke open-ended rate, drafts against it,
    // then ends it BEFORE submitting: the draft passed every write-time
    // check, so only a submit-time re-check can stop the money.
    const recorded = await authed(owner, {
      method: 'POST',
      url: '/api/masters/gst-rates',
      organisationId,
      payload: {
        rate: '7.5',
        label: 'Transitional 7.5% (proof rate)',
        effectiveFrom: '2017-07-01',
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const rateId = recorded.json<{ id: string }>().id;

    const created = await draftDirect({ gstRate: '7.5' });
    expect(created.statusCode, created.body).toBe(201);
    const invoiceId = created.json<TaxInvoiceDetailResponse>().invoice.id;

    const ended = await authed(owner, {
      method: 'POST',
      url: `/api/masters/gst-rates/${rateId}/end-date`,
      organisationId,
      payload: { effectiveTo: '2025-12-31' },
    });
    expect(ended.statusCode, ended.body).toBe(200);

    const submitted = await submitInvoice(invoiceId);
    expect(submitted.statusCode).toBe(400);
    expect(submitted.json<{ code: string }>().code).toBe('GST_RATE_NOT_NOTIFIED');

    // The draft survives the refusal, un-numbered and un-monetised.
    const [row] = await admin<{ status: string; invoice_number: string | null }[]>`
      select status, invoice_number from tax_invoices where id = ${invoiceId}
    `;
    expect(row).toEqual({ status: 'draft', invoice_number: null });
  });
});

describe('e-invoice applicability and the IRP reporting window (finding 20)', () => {
  // A dedicated organisation whose declaration these tests own. Its
  // invoices are DIRECT (no Work, no MB) so the fixture is exactly the
  // profile, one buyer, and the owner's authorities.
  let orgId: string;
  let buyerId: string;

  async function patchOrgProfile(payload: Record<string, unknown>) {
    return authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId: orgId,
      payload,
    });
  }

  /** One submitted direct invoice on the dedicated organisation. */
  async function submittedInvoice(
    invoiceDate: string,
    suffix: string,
  ): Promise<TaxInvoiceDetailResponse> {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId: orgId,
      payload: {
        invoiceDate,
        sacCode: '998734',
        serviceDescription: `Applicability probe ${suffix}.`,
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId: buyerId,
        taxableValue: '1000.00',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${created.json<TaxInvoiceDetailResponse>().invoice.id}/submit`,
      organisationId: orgId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    return submitted.json<TaxInvoiceDetailResponse>();
  }

  beforeAll(async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/organisations',
      payload: { name: 'TI Applicability', slug: `ti-f20-${runId}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    orgId = created.json<{ id: string }>().id;
    applicabilityOrganisationId = orgId;
    await admin`
      update organisation_memberships
      set can_issue_documents = true, can_cancel_documents = true
      where organisation_id = ${orgId} and user_id = ${ownerUserId}
    `;
    // Tax facts only — deliberately NO e-invoicing declaration yet.
    const profiled = await patchOrgProfile({
      stateCode: '07',
      gstin: ORG_GSTIN,
      address: ORG_ADDRESS,
      pincode: '110002',
      locality: 'New Delhi',
    });
    expect(profiled.statusCode, profiled.body).toBe(200);
    buyerId = randomUUID();
    await admin`
      insert into contacts (
        id, organisation_id, designation, contact_person, address, gstin,
        pincode, state_code, locality, is_consignee, active, created_by_user_id
      )
      values (${buyerId}, ${orgId}, 'Sr. DEE (G) NR', 'S K Verma',
              ${BUYER_ADDRESS}, ${BUYER_GSTIN}, '110055', '07', 'New Delhi',
              true, true, ${ownerUserId})
    `;
  }, 60_000);

  it('holds the declaration coherent and owner-only', async () => {
    // Non-owner writes are refused before anything else — the clerk is
    // an office member of the shared organisation.
    const denied = await authed(clerk, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { einvoiceApplicability: 'not_applicable' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('OWNER_REQUIRED');

    // Applicable without its date, a date without applicable, and a
    // window without applicable are each a 400, not a silent fix-up.
    for (const payload of [
      { einvoiceApplicability: 'applicable' },
      { einvoiceApplicableFrom: '2026-01-01' },
      { irpReportingWindowDays: 30 },
    ]) {
      const incoherent = await patchOrgProfile(payload);
      expect(incoherent.statusCode, incoherent.body).toBe(400);
      expect(incoherent.json<{ code: string }>().code).toBe(
        'E_INVOICE_DECLARATION_INCOHERENT',
      );
    }

    // The profile read reports the untouched declaration.
    const read = await authed(owner, {
      method: 'GET',
      url: '/api/organisation/profile',
      organisationId: orgId,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<OrganisationProfile>()).toMatchObject({
      einvoiceApplicability: 'undeclared',
      einvoiceApplicableFrom: null,
      irpReportingWindowDays: null,
    });
  });

  it('submits locally while undeclared but refuses the IRP transport', async () => {
    resetProviderMocks();
    // Local submit is NEVER blocked by the declaration.
    const detail = await submittedInvoice('2026-02-15', 'undeclared');
    expect(detail.invoice.irpReportingDeadline).toBeNull();
    expect(detail.invoice.irpReportingOverdue).toBe(false);

    const registered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/register-irp`,
      organisationId: orgId,
    });
    expect(registered.statusCode).toBe(409);
    expect(registered.json<{ code: string }>().code).toBe(
      'E_INVOICE_APPLICABILITY_UNDECLARED',
    );
    expect(registerInvoiceProvider).not.toHaveBeenCalled();

    // The manual compatibility door is the same transport.
    const manual = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/irp-response`,
      organisationId: orgId,
      payload: irpEvidence('d'),
    });
    expect(manual.statusCode).toBe(409);
    expect(manual.json<{ code: string }>().code).toBe(
      'E_INVOICE_APPLICABILITY_UNDECLARED',
    );

    // No provider operation was ever opened.
    const operations = await admin<{ id: string }[]>`
      select id from statutory_provider_operations
      where tax_invoice_id = ${detail.invoice.id}
    `;
    expect(operations).toHaveLength(0);
  });

  it('refuses the transport where e-invoicing is declared not applicable', async () => {
    resetProviderMocks();
    const declared = await patchOrgProfile({
      einvoiceApplicability: 'not_applicable',
    });
    expect(declared.statusCode, declared.body).toBe(200);

    const detail = await submittedInvoice('2026-02-15', 'not applicable');
    expect(detail.invoice.irpReportingDeadline).toBeNull();

    const registered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/register-irp`,
      organisationId: orgId,
    });
    expect(registered.statusCode).toBe(409);
    expect(registered.json<{ code: string }>().code).toBe('E_INVOICE_NOT_APPLICABLE');
    expect(registerInvoiceProvider).not.toHaveBeenCalled();

    const manual = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/irp-response`,
      organisationId: orgId,
      payload: irpEvidence('e'),
    });
    expect(manual.statusCode).toBe(409);
    expect(manual.json<{ code: string }>().code).toBe('E_INVOICE_NOT_APPLICABLE');
  });

  it('freezes the reporting deadline at submit from the declaration in force', async () => {
    const declared = await patchOrgProfile({
      einvoiceApplicability: 'applicable',
      einvoiceApplicableFrom: '2026-01-01',
      irpReportingWindowDays: 30,
    });
    expect(declared.statusCode, declared.body).toBe(200);
    expect(declared.json<OrganisationProfile>()).toMatchObject({
      einvoiceApplicability: 'applicable',
      einvoiceApplicableFrom: '2026-01-01',
      irpReportingWindowDays: 30,
    });

    // 2026-02-15 + 30 days = 2026-03-17, stamped in the submit
    // transaction, derived overdue against today.
    const windowed = await submittedInvoice('2026-02-15', 'windowed');
    expect(windowed.invoice.irpReportingDeadline).toBe('2026-03-17');
    expect(windowed.invoice.irpReportingOverdue).toBe(true);

    // Boundary: an invoice dated BEFORE the applicable-from date was
    // never covered by the mandate and stamps NULL.
    const preMandate = await submittedInvoice('2025-12-20', 'pre-mandate');
    expect(preMandate.invoice.irpReportingDeadline).toBeNull();
    expect(preMandate.invoice.irpReportingOverdue).toBe(false);

    // The stamp is FROZEN: widening the declared window afterwards does
    // not move an already-issued invoice's deadline.
    const widened = await patchOrgProfile({ irpReportingWindowDays: 365 });
    expect(widened.statusCode, widened.body).toBe(200);
    const reread = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${windowed.invoice.id}`,
      organisationId: orgId,
    });
    expect(reread.statusCode, reread.body).toBe(200);
    expect(reread.json<TaxInvoiceDetailResponse>().invoice.irpReportingDeadline).toBe(
      '2026-03-17',
    );
    const narrowed = await patchOrgProfile({ irpReportingWindowDays: 30 });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
  });

  it('refuses a fresh registration past the deadline but still reconciles an unknown one', async () => {
    resetProviderMocks();
    const detail = await submittedInvoice('2026-02-15', 'past deadline');
    expect(detail.invoice.irpReportingDeadline).toBe('2026-03-17');

    // Fresh registration: the window has lawfully closed.
    const refused = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/register-irp`,
      organisationId: orgId,
    });
    expect(refused.statusCode).toBe(409);
    const refusal = refused.json<{ code: string; message: string }>();
    expect(refusal.code).toBe('IRP_REPORTING_WINDOW_CLOSED');
    expect(refusal.message).toContain('2026-03-17');
    expect(registerInvoiceProvider).not.toHaveBeenCalled();

    // The manual compatibility door is gated identically.
    const manual = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/irp-response`,
      organisationId: orgId,
      payload: irpEvidence('f'),
    });
    expect(manual.statusCode).toBe(409);
    expect(manual.json<{ code: string }>().code).toBe('IRP_REPORTING_WINDOW_CLOSED');

    // An attempt made before the window closed whose outcome was lost:
    // reconciling it is a lookup of what already happened, not a new
    // report, and stays allowed. Simulated directly (triggers bypassed
    // exactly as the stale-operation helper does) because the window
    // has already closed by wall clock.
    await admin.unsafe(`set session_replication_role = 'replica'`);
    try {
      await admin`
        update tax_invoices
        set irp_provider = 'whitebooks', irp_provider_state = 'registration_unknown'
        where id = ${detail.invoice.id}
      `;
    } finally {
      await admin.unsafe(`set session_replication_role = 'origin'`);
    }
    const evidence = irpEvidence('9');
    findInvoiceProvider.mockResolvedValueOnce(evidence);
    const reconciled = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/register-irp`,
      organisationId: orgId,
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      irn: evidence.irn,
      irpProviderState: 'registered',
      irpReportingOverdue: false,
    });
    expect(registerInvoiceProvider).not.toHaveBeenCalled();
    expect(findInvoiceProvider).toHaveBeenCalledTimes(1);
  });

  it('still cancels an overdue never-registered invoice locally', async () => {
    const detail = await submittedInvoice('2026-02-15', 'overdue cancel');
    expect(detail.invoice.irpReportingDeadline).toBe('2026-03-17');
    expect(detail.invoice.irpReportingOverdue).toBe(true);

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/cancel`,
      organisationId: orgId,
      payload: { note: 'Reporting window missed; reissuing with a current date.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<TaxInvoiceDetailResponse>().invoice.status).toBe('cancelled');
  });

  it('counts due and overdue reporting windows on the dashboard', async () => {
    // One invoice whose window is still open: dated today in the
    // organisation timezone under the 365-day window.
    const widened = await patchOrgProfile({ irpReportingWindowDays: 365 });
    expect(widened.statusCode, widened.body).toBe(200);
    const [clock] = await admin<{ today: string }[]>`
      select (now() at time zone timezone)::date::text as today
      from organisations where id = ${orgId}
    `;
    if (!clock) throw new Error('organisation clock unavailable');
    const open = await submittedInvoice(clock.today, 'open window');
    expect(open.invoice.irpReportingDeadline).not.toBeNull();
    expect(open.invoice.irpReportingOverdue).toBe(false);

    const dashboard = await authed(owner, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId: orgId,
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const body = dashboard.json<{
      totals: { irpReportingDue: number; irpReportingOverdue: number };
      alerts: { kind: string; severity: string }[];
    }>();
    // Due: the invoice just issued. Overdue: the windowed invoice from
    // the freeze test — the reconciled one is registered and the
    // cancelled one is cancelled, so neither counts.
    expect(body.totals.irpReportingDue).toBe(1);
    expect(body.totals.irpReportingOverdue).toBe(1);
    const kinds = body.alerts.map((alert) => alert.kind);
    expect(kinds).toContain('irp_reporting_due');
    expect(kinds).toContain('irp_reporting_overdue');
  });

  it('rejects raw SQL moving a frozen reporting deadline on an issued row', async () => {
    // The dashboard test above widened the window to 365 days; restore
    // the 30-day declaration so this stamp is the familiar one.
    const narrowed = await patchOrgProfile({ irpReportingWindowDays: 30 });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const detail = await submittedInvoice('2026-02-15', 'raw sql');
    expect(detail.invoice.irpReportingDeadline).toBe('2026-03-17');

    // Even the table owner cannot move the frozen consequence: the 0049
    // guard recreation pins irp_reporting_deadline with the other
    // issued business facts (model:
    // packages/db/test/quantity-ceilings.integration.test.ts).
    const refusal = await admin`
      update tax_invoices
      set irp_reporting_deadline = '2099-01-01'
      where id = ${detail.invoice.id}
    `
      .then(() => null)
      .catch((error: unknown) => error as { code?: string; message: string });
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe('23514');
    expect(refusal?.message).toContain(
      'submitted tax invoice business facts are immutable',
    );
  });
});

describe('manual IRP evidence truth (migration 0053)', () => {
  it('walks the registered_unverified lifecycle: record, interlock, cancel', async () => {
    const detail = await submittedDirectInvoice('manual truth lifecycle');
    const invoiceId = detail.invoice.id;
    const irn = derivedIrnFor(detail);

    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/irp-response`,
      organisationId,
      payload: {
        irn,
        ackNumber: '112010099001',
        ackDate: '2026-08-01T10:30:00.000Z',
        ackDateText: '01/08/2026 16:00:00',
        signedQr: 'manual-signed-qr',
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      irn,
      irpProvider: 'manual',
      irpProviderState: 'registered_unverified',
    });

    // Behaves as registered for the local-cancel interlock: the invoice
    // cannot be cancelled locally while the (unverified) IRN stands.
    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/cancel`,
      organisationId,
      payload: { note: 'attempt while IRN stands' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe('IRP_CANCELLATION_REQUIRED');

    // Excluded from the provider-verified surface: the Whitebooks cancel
    // path refuses a manual record even where transport is configured.
    const providerCancel = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/cancel-irp`,
      organisationId,
      payload: { reasonCode: '2', remark: 'not a provider record' },
    });
    expect(providerCancel.statusCode).toBe(409);
    expect(providerCancel.json<{ code: string }>().code).toBe('IRP_STATE_CONFLICT');

    // Externally confirmed cancellation evidence closes the manual record…
    const externalCancel = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/irp-cancel-response`,
      organisationId,
      payload: {
        reasonCode: '2',
        remark: 'Cancelled on the portal',
        cancelledAt: '2026-08-02T09:00:00.000Z',
        cancelledAtText: '02/08/2026 14:30:00',
      },
    });
    expect(externalCancel.statusCode, externalCancel.body).toBe(200);
    expect(externalCancel.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      irpProviderState: 'cancelled',
      irpCancelledAtText: '02/08/2026 14:30:00',
    });

    // …and only then may the local invoice be cancelled.
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/cancel`,
      organisationId,
      payload: { note: 'corrected invoice follows' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
  });

  it('refuses raw SQL promoting manual evidence to the provider-verified state', async () => {
    const detail = await submittedDirectInvoice('manual truth raw sql');
    const invoiceId = detail.invoice.id;
    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/irp-response`,
      organisationId,
      payload: {
        irn: derivedIrnFor(detail),
        ackNumber: '112010099002',
        ackDate: '2026-08-01T11:30:00.000Z',
        ackDateText: '01/08/2026 17:00:00',
        signedQr: 'manual-signed-qr-2',
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);

    // The state machine refuses the transition outright…
    const guarded = await admin`
      update tax_invoices set irp_provider_state = 'registered'
      where id = ${invoiceId}
    `
      .then(() => null)
      .catch((error: unknown) => error as { code?: string; message: string });
    expect(guarded).not.toBeNull();
    expect(guarded?.code).toBe('23514');
    expect(guarded?.message).toContain('invalid IRP provider-state transition');

    // …and even with every trigger suspended, the 0053 CHECK constraint
    // still refuses a manual row claiming the provider-verified state.
    await admin.unsafe(`set session_replication_role = 'replica'`);
    try {
      const floored = await admin`
        update tax_invoices set irp_provider_state = 'registered'
        where id = ${invoiceId}
      `
        .then(() => null)
        .catch((error: unknown) => error as { code?: string; message: string });
      expect(floored).not.toBeNull();
      expect(floored?.code).toBe('23514');
      expect(floored?.message).toContain('tax_invoices_manual_unverified_shape');
    } finally {
      await admin.unsafe(`set session_replication_role = 'origin'`);
    }
  });
});

/**
 * Audit finding 4. The B2C refusal has existed since the adapter was
 * written — `SupTyp` is pinned to `'B2B'` and the snapshot throws when the
 * frozen buyer carries no GSTIN — but nothing proved it, so a later change
 * that quietly widened the payload to unregistered buyers would have gone
 * out green. A B2C invoice pushed through the B2B IRP model is a wrong
 * statutory filing, not a cosmetic defect.
 */
describe('finding 4: a B2C invoice is refused at the IRP boundary', () => {
  /** An invoice to a buyer with no GSTIN — the definition of B2C here. */
  async function submittedB2cInvoice(
    suffix: string,
  ): Promise<TaxInvoiceDetailResponse> {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-02-15',
        sacCode: '998734',
        serviceDescription: `Unregistered buyer probe ${suffix}.`,
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId: unregisteredBuyerId,
        taxableValue: '1000.00',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const submitted = await submitInvoice(
      created.json<TaxInvoiceDetailResponse>().invoice.id,
    );
    expect(submitted.statusCode, submitted.body).toBe(201);
    return submitted.json<TaxInvoiceDetailResponse>();
  }

  it('refuses IRP registration for an invoice whose frozen buyer has no GSTIN', async () => {
    const detail = await submittedB2cInvoice('register');
    // The buyer really is unregistered on the FROZEN snapshot, not merely
    // on live master data — that is the fact the refusal must read.
    expect(
      (detail.issuedSnapshot as { buyer: { gstin: string | null } }).buyer.gstin,
    ).toBeNull();

    const refused = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/register-irp`,
      organisationId,
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('E_INVOICE_B2C_UNSUPPORTED');

    // The refusal is a wall, not a state change: no provider operation was
    // opened and the invoice did not move into `registering`.
    const after = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${detail.invoice.id}`,
      organisationId,
    });
    expect(after.json<TaxInvoiceDetailResponse>().invoice.irpProviderState).toBe(
      'not_requested',
    );
    const [operations] = await admin<{ count: number }[]>`
      select count(*)::int as count from statutory_provider_operations
      where tax_invoice_id = ${detail.invoice.id}
    `;
    expect(operations?.count).toBe(0);
    expect(registerInvoiceProvider).not.toHaveBeenCalled();
  });

  it('refuses to even build the IRP payload for a B2C invoice', async () => {
    const detail = await submittedB2cInvoice('payload');
    // The payload endpoint is the operator's "what would we file?" view.
    // It must refuse for the same reason rather than rendering a payload
    // that claims B2B for an unregistered buyer.
    const refused = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${detail.invoice.id}/irp-payload`,
      organisationId,
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('E_INVOICE_B2C_UNSUPPORTED');
  });
});

/**
 * Audit finding 2 residue: local verification of provider evidence, and a
 * record of which portal answered.
 */
describe('finding 2: IRP evidence is verified locally, and the portal is recorded', () => {
  it('refuses a manually recorded IRN that does not derive from the invoice', async () => {
    const detail = await submittedDirectInvoice('manual irn derivation');
    const invoiceId = detail.invoice.id;
    // Well-formed — 64 hex characters, so the schema admits it — but it is
    // not the SHA-256 of THIS invoice's supplier GSTIN, document type,
    // number and financial year, so it is not this invoice's IRN. Before
    // this check it would have been written onto the legal document as the
    // government's own identifier.
    const foreignIrn = 'ab12'.repeat(16);
    expect(foreignIrn).not.toBe(derivedIrnFor(detail));

    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/irp-response`,
      organisationId,
      payload: {
        irn: foreignIrn,
        ackNumber: '112010099003',
        ackDate: '2026-08-01T10:30:00.000Z',
        ackDateText: '01/08/2026 16:00:00',
        signedQr: 'manual-signed-qr-foreign',
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('IRP_IRN_DERIVATION_MISMATCH');

    // Nothing was recorded: the invoice keeps no IRN and no provider.
    const after = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${invoiceId}`,
      organisationId,
    });
    expect(after.json<TaxInvoiceDetailResponse>().invoice).toMatchObject({
      irn: null,
      irpProvider: null,
      irpProviderState: 'not_requested',
    });

    // The correctly derived IRN for the same invoice is accepted — the
    // check refuses wrong evidence, not the manual door itself. It still
    // lands as registered_unverified: deriving correctly proves the IRN is
    // arithmetically this invoice's, not that the portal ever issued it.
    const accepted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/irp-response`,
      organisationId,
      payload: {
        irn: derivedIrnFor(detail),
        ackNumber: '112010099003',
        ackDate: '2026-08-01T10:30:00.000Z',
        ackDateText: '01/08/2026 16:00:00',
        signedQr: 'manual-signed-qr-derived',
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<TaxInvoiceDetailResponse>().invoice.irpProviderState).toBe(
      'registered_unverified',
    );
  });

  it('records which portal answered on the operation ledger, immutably', async () => {
    const detail = await submittedDirectInvoice('portal evidence');
    registerInvoiceProvider.mockResolvedValueOnce(irpEvidence('7'));

    const registered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${detail.invoice.id}/register-irp`,
      organisationId,
    });
    expect(registered.statusCode, registered.body).toBe(200);

    const [operation] = await admin<
      { id: string; provider: string; provider_portal: string | null }[]
    >`
      select id, provider, provider_portal
      from statutory_provider_operations
      where tax_invoice_id = ${detail.invoice.id} and operation = 'register_irp'
    `;
    // `provider` says which GSP the deployment bought; `provider_portal`
    // says which government portal actually answered. A later dispute
    // needs the second fact, and it was not recorded before.
    expect(operation?.provider).toBe('whitebooks');
    expect(operation?.provider_portal).toBe(STUB_PORTAL);

    // The completed row is frozen outright, so the portal cannot be
    // rewritten afterwards to name a different one (migration 0056 also
    // pins it into the pending-row identity ROW).
    const guarded = await admin`
      update statutory_provider_operations
      set provider_portal = 'NIC2 via elsewhere.example'
      where id = ${operation?.id ?? ''}
    `
      .then(() => null)
      .catch((error: unknown) => error as { code?: string; message: string });
    expect(guarded).not.toBeNull();
    expect(guarded?.code).toBe('23514');
    expect(guarded?.message).toContain(
      'completed statutory provider operations are immutable',
    );
  });
});
