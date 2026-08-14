import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  EwayBillDetailResponse,
  EwayBillListResponse,
  MeasurementBookDetailResponse,
  TaxInvoiceDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import {
  StatutoryProviderError,
  type StatutoryProvider,
} from '../src/gsp/statutory-provider.js';

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
const TRANSPORTER_ID = '07ABCDE1234F1Z5';

let admin: Sql;
let app: FastifyInstance;
let providerApp: FastifyInstance;
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
let fakeGotenberg: http.Server | undefined;
let owner: CookieJar;
let clerk: CookieJar;
let viewer: CookieJar;
let outsider: CookieJar;

const registerInvoiceProvider = vi.fn<StatutoryProvider['registerInvoice']>();
const findInvoiceProvider = vi.fn<StatutoryProvider['findInvoiceByDocument']>();
const cancelInvoiceProvider = vi.fn<StatutoryProvider['cancelInvoice']>();
const generateEwayBillProvider = vi.fn<StatutoryProvider['generateEwayBillByIrn']>();
const generateEwayBillDirectProvider = vi.fn<StatutoryProvider['generateEwayBill']>();
const findEwayBillProvider = vi.fn<StatutoryProvider['findEwayBillByIrn']>();
const cancelEwayBillProvider = vi.fn<StatutoryProvider['cancelEwayBill']>();
const providerStub: StatutoryProvider = {
  name: 'whitebooks',
  portal: 'NIC1 via apisandbox.whitebooks.in',
  environment: 'sandbox',
  registerInvoice: registerInvoiceProvider,
  findInvoiceByDocument: findInvoiceProvider,
  cancelInvoice: cancelInvoiceProvider,
  generateEwayBillByIrn: generateEwayBillProvider,
  generateEwayBill: generateEwayBillDirectProvider,
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

  // ITEMISED, and its one line is GOODS. ADR-0013 keys e-way bill
  // applicability on line content rather than on who the buyer is, so a
  // Work-backed railway invoice that happens to supply goods is as valid
  // a movement source as a direct one — and a SAC-only railway invoice
  // still is not, which `serviceInvoiceOn` below is the proof of. The
  // line sums to the Measurement Book total the submit route checks.
  const invoice = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/tax-invoices`,
    organisationId,
    payload: {
      measurementBookId: mbId,
      invoiceDate,
      placeOfSupply: '07',
      reverseChargeApplicable: false,
      buyerContactId,
      lineShape: 'itemised',
      lines: [
        {
          isService: false,
          hsnSacCode: '85444999',
          description: 'Signalling cable, 4 core',
          quantity: `${quantity}.000`,
          unitLabel: 'm',
          unitRate: '100.00',
          gstRate: '18',
        },
      ],
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

/** A submitted direct invoice that MOVES GOODS.
 *
 * ADR-0013 keys e-way bill applicability on line content, so the movement
 * document this suite exercises has to sit behind a document that carries
 * at least one HSN goods line. The service-only refusal is proved
 * separately by `submittedServiceInvoice` below rather than by making
 * every case in the suite an accidental test of it. */
async function submittedDirectInvoice(suffix: string): Promise<string> {
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/tax-invoices',
    organisationId,
    payload: {
      invoiceDate: '2026-08-08',
      placeOfSupply: '07',
      reverseChargeApplicable: false,
      buyerContactId,
      lineShape: 'itemised',
      lines: [
        {
          isService: false,
          hsnSacCode: '85444999',
          description: `Signalling cable, 4 core (${suffix})`,
          quantity: '100.000',
          unitLabel: 'm',
          unitRate: '10.00',
          gstRate: '18',
        },
      ],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<TaxInvoiceDetailResponse>().invoice.id;
  const submitted = await authed(owner, {
    method: 'POST',
    url: `/api/tax-invoices/${id}/submit`,
    organisationId,
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  return id;
}

/** A submitted direct invoice whose every line is a SERVICE — the
 * document the 2026-08-10 disposition was about, and the one NIC refuses
 * with error 4009. */
async function submittedServiceInvoice(suffix: string): Promise<string> {
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/tax-invoices',
    organisationId,
    payload: {
      invoiceDate: '2026-08-08',
      sacCode: '998734',
      serviceDescription: `Whitebooks EWB cancellation probe ${suffix}.`,
      gstRate: '18',
      placeOfSupply: '07',
      reverseChargeApplicable: false,
      buyerContactId,
      taxableValue: '1000.00',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<TaxInvoiceDetailResponse>().invoice.id;
  const submitted = await authed(owner, {
    method: 'POST',
    url: `/api/tax-invoices/${id}/submit`,
    organisationId,
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  return id;
}

async function seedWhitebooksEwayBill(
  invoiceId: string,
  ewbNumber: string,
): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into eway_bills (
      id, organisation_id, tax_invoice_id, status, transport_mode,
      vehicle_number, distance_km, from_pincode, to_pincode,
      ewb_number, ewb_date, valid_until, ewb_date_text, valid_until_text,
      provider, provider_state, legacy_evidence_missing,
      generated_by_user_id, generated_at, created_by_user_id
    ) values (
      ${id}, ${organisationId}, ${invoiceId}, 'generated', 'road',
      'DL01AB1234', 25, '110020', '110055', ${ewbNumber},
      '2026-08-08T09:00:00.000Z', '2026-08-09T23:59:59.000Z',
      '08/08/2026 14:30:00', '09/08/2026 23:59:59',
      'whitebooks', 'generated', false, ${ownerUserId}, now(), ${ownerUserId}
    )
  `;
  return id;
}

function resetProviderMocks(): void {
  registerInvoiceProvider.mockReset();
  findInvoiceProvider.mockReset();
  cancelInvoiceProvider.mockReset();
  generateEwayBillProvider.mockReset();
  generateEwayBillDirectProvider.mockReset();
  findEwayBillProvider.mockReset();
  cancelEwayBillProvider.mockReset();
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
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ewb-objects-'));
  // The printable e-way bill summary renders through the same Gotenberg
  // path every other document uses, so the suite stands one up.
  fakeGotenberg = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.from(`%PDF-1.4 stub ${runId}`));
    });
  });
  await new Promise<void>((resolve) => {
    fakeGotenberg?.listen(0, '127.0.0.1', resolve);
  });
  const gotenbergAddress = fakeGotenberg.address();
  if (gotenbergAddress === null || typeof gotenbergAddress === 'string') {
    throw new Error('stub Gotenberg failed to bind a port');
  }
  const gotenbergUrl = `http://127.0.0.1:${String(gotenbergAddress.port)}`;

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl,
  });
  providerApp = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl,
    statutoryProvider: providerStub,
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
    set can_issue_documents = true, can_cancel_documents = true,
        -- Migration 0061: the statutory provider routes now demand the
        -- dedicated compliance authority ON TOP of issue/cancel. Without
        -- this grant every IRP/NIC case in this file 403s, which is
        -- exactly the proof that the new gate binds.
        can_manage_statutory_reporting = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  const profile = await authed(owner, {
    method: 'PATCH',
    url: '/api/organisation/profile',
    organisationId,
    payload: {
      stateCode: '07',
      gstin: ORG_GSTIN,
      address: ORG_ADDRESS,
      pincode: '110002',
      locality: 'New Delhi',
      invoiceNumberPrefix: 'P10',
    },
  });
  expect(profile.statusCode, profile.body).toBe(200);
  const series = await authed(owner, {
    method: 'PUT',
    url: '/api/organisation/number-series/tax_invoice',
    organisationId,
    payload: { template: '{PREFIX}{FY2}{SEQ:3}' },
  });
  expect(series.statusCode, series.body).toBe(200);

  workId = randomUUID();
  const scheduleId = randomUUID();
  itemId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, gst_basis,
      created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${workCode}, ${`L-${workCode}`},
      '2025-06-01', 'E-way bill fixture work', '1000000.00', '900000.00',
      -- GST-EXCLUSIVE on purpose: this suite is about the e-way bill, not
      -- about the GST basis, and on an exclusive Work the measured total is
      -- the taxable value so the invoice figures stay round (0062/0063).
      'per_schedule', 'exclusive', ${ownerUserId}
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
      pincode, state_code, locality, is_consignee, active, created_by_user_id
    )
    values (${buyerContactId}, ${organisationId}, 'Sr. DEE (G) NR', 'S K Verma',
            ${BUYER_ADDRESS}, ${BUYER_GSTIN}, '110055', '07', 'New Delhi', true, true,
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
  expect(invoice.invoiceNumber).toBe('P1026001');
  expect(invoice.taxableValue).toBe('1000.00');
  expect(invoice.totalAmount).toBe('1180.00');

  // Invoice 2: left in draft — the "no legal number to move" case.
  draftInvoiceId = await draftInvoiceOn('2026-08-02', '20', '2026-08-06');
}, 120_000);

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
  await providerApp?.close();
  await app?.close();
  await new Promise<void>((resolve) => {
    if (fakeGotenberg === undefined) {
      resolve();
      return;
    }
    fakeGotenberg.close(() => {
      resolve();
    });
  });
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
      invoiceNumber: 'P1026001',
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
    // The payload is assembled for real now (ADR-0013), so an incomplete
    // carriage is refused where it is missing rather than swallowed by a
    // blanket 409 that used to answer this route unconditionally.
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
        ewbDateText: '06/08/2026 15:30:00',
        validUntilText: '07/08/2026 23:59:59',
      },
    });
    expect(generated.statusCode).toBe(400);
    expect(generated.json<{ code: string }>().code).toBe('VEHICLE_REQUIRED');
  });

  it('serves the real NIC payload once the carriage is complete', async () => {
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

    // The invoice path generates BY IRN, and this fixture invoice was
    // never registered at the IRP, so the payload route says exactly that
    // rather than showing a body that could not be sent.
    const response = await authed(owner, {
      method: 'GET',
      url: `/api/eway-bills/${roadEwbId}/nic-payload`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'EWAY_IRP_REGISTRATION_REQUIRED',
    );

    // On the app built WITHOUT Whitebooks transport, the missing provider
    // is the first thing in the way and says so: nothing downstream can
    // happen without it, whatever else is also incomplete.
    const generate = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/generate`,
      organisationId,
    });
    expect(generate.statusCode, generate.body).toBe(409);
    expect(generate.json<{ code: string }>().code).toBe(
      'STATUTORY_PROVIDER_NOT_CONFIGURED',
    );
  });

  it('records the NIC response verbatim, moving draft -> generated once', async () => {
    // Imported portal evidence requires issue authority.
    const denied = await authed(clerk, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/nic-response`,
      organisationId,
      payload: {
        ewbNumber: '123456789012',
        ewbDate: '2026-08-06T10:00:00.000Z',
        validUntil: '2026-08-07T23:59:59.000Z',
        ewbDateText: '06/08/2026 15:30:00',
        validUntilText: '07/08/2026 23:59:59',
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');

    const generated = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/nic-response`,
      organisationId,
      payload: {
        ewbNumber: '123456789012',
        ewbDate: '2026-08-06T10:00:00.000Z',
        validUntil: '2026-08-07T23:59:59.000Z',
        ewbDateText: '06/08/2026 15:30:00',
        validUntilText: '07/08/2026 23:59:59',
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
        ewbDateText: '06/08/2026 16:30:00',
        validUntilText: '08/08/2026 23:59:59',
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

    const externalCancellation = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/manual-cancel-response`,
      organisationId,
      payload: {
        reasonCode: '2',
        remark: 'Order cancelled before dispatch',
        cancelledAt: '2026-08-06T11:00:00.000Z',
        cancelledAtText: '06/08/2026 16:30:00',
      },
    });
    expect(externalCancellation.statusCode, externalCancellation.body).toBe(200);
    expect(externalCancellation.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      providerState: 'cancelled',
      providerCancelledAt: '2026-08-06T11:00:00.000Z',
      providerCancelledAtText: '06/08/2026 16:30:00',
      providerCancelReasonCode: '2',
      providerCancelRemark: 'Order cancelled before dispatch',
    });

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${roadEwbId}/cancel`,
      organisationId,
      payload: { note: 'vehicle broke down before dispatch' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const bill = cancelled.json<EwayBillDetailResponse>().ewayBill;
    expect(bill.status).toBe('cancelled');
    // Cancellation retains the official identity and exact portal evidence.
    expect(bill.ewbNumber).toBe('123456789012');
    expect(bill.ewbDateText).toBe('06/08/2026 15:30:00');
    expect(bill.validUntilText).toBe('07/08/2026 23:59:59');
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
  it('drafts on the freed slot and names the missing IRN', async () => {
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
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'EWAY_IRP_REGISTRATION_REQUIRED',
    );
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
        ewbDateText: '07/08/2026 14:30:00',
        validUntilText: '10/08/2026 23:59:59',
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
        ewbDateText: '07/08/2026 14:30:00',
        validUntilText: '10/08/2026 23:59:59',
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

    const externalCancellation = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${railEwbId}/manual-cancel-response`,
      organisationId,
      payload: {
        reasonCode: '2',
        remark: 'Order cancelled before rail dispatch',
        cancelledAt: '2026-08-07T10:00:00.000Z',
        cancelledAtText: '07/08/2026 15:30:00',
      },
    });
    expect(externalCancellation.statusCode, externalCancellation.body).toBe(200);

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
    expect(ewayBills.every((bill) => bill.invoiceNumber === 'P1026001')).toBe(true);
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

describe('Whitebooks e-way bill provider cancellation', () => {
  it('cancels once and retains exact provider evidence in the ledger', async () => {
    resetProviderMocks();
    const invoiceId = await submittedDirectInvoice('success');
    const ewayBillId = await seedWhitebooksEwayBill(invoiceId, '301234567890');
    cancelEwayBillProvider.mockResolvedValueOnce({
      cancelledAtText: '08/08/2026 16:00:00',
      cancelledAt: '2026-08-08T10:30:00.000Z',
      rawResponse: '{"status_cd":"1","cancelDate":"08/08/2026 16:00:00"}',
    });

    const response = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/eway-bills/${ewayBillId}/cancel-provider`,
      organisationId,
      payload: { reasonCode: '2', remark: '  Order cancelled before dispatch  ' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      status: 'generated',
      provider: 'whitebooks',
      providerState: 'cancelled',
      providerCancelledAt: '2026-08-08T10:30:00.000Z',
      providerCancelledAtText: '08/08/2026 16:00:00',
      providerCancelReasonCode: '2',
      providerCancelRemark: 'Order cancelled before dispatch',
    });
    expect(cancelEwayBillProvider).toHaveBeenCalledTimes(1);
    expect(cancelEwayBillProvider).toHaveBeenCalledWith({
      gstin: ORG_GSTIN,
      ewbNumber: '301234567890',
      reasonCode: '2',
      remark: 'Order cancelled before dispatch',
    });
    const [operation] = await admin<
      {
        operation: string;
        status: string;
        provider: string;
        environment: string;
        completed: boolean;
      }[]
    >`
      select operation, status, provider, environment,
             completed_at is not null as completed
      from statutory_provider_operations where eway_bill_id = ${ewayBillId}
    `;
    expect(operation).toEqual({
      operation: 'cancel_eway_bill',
      status: 'succeeded',
      provider: 'whitebooks',
      environment: 'sandbox',
      completed: true,
    });
  });

  it('does not repeat an unknown cancellation mutation', async () => {
    resetProviderMocks();
    const invoiceId = await submittedDirectInvoice('unknown result');
    const ewayBillId = await seedWhitebooksEwayBill(invoiceId, '401234567890');
    cancelEwayBillProvider.mockRejectedValueOnce(
      new StatutoryProviderError(
        'WHITEBOOKS_MUTATION_UNKNOWN',
        'unknown',
        'WB-503',
        503,
      ),
    );

    const uncertain = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/eway-bills/${ewayBillId}/cancel-provider`,
      organisationId,
      payload: { reasonCode: '2', remark: 'Vehicle did not move' },
    });
    expect(uncertain.statusCode, uncertain.body).toBe(202);
    expect(uncertain.json<EwayBillDetailResponse>().ewayBill.providerState).toBe(
      'cancellation_unknown',
    );

    const repeated = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/eway-bills/${ewayBillId}/cancel-provider`,
      organisationId,
      payload: { reasonCode: '2', remark: 'Vehicle did not move' },
    });
    expect(repeated.statusCode, repeated.body).toBe(409);
    expect(repeated.json<{ code: string }>().code).toBe('EWAY_PROVIDER_STATE_CONFLICT');
    expect(cancelEwayBillProvider).toHaveBeenCalledTimes(1);

    const [operation] = await admin<
      { status: string; provider_code: string | null; http_status: number | null }[]
    >`
      select status, provider_code, http_status
      from statutory_provider_operations where eway_bill_id = ${ewayBillId}
    `;
    expect(operation).toEqual({
      status: 'unknown',
      provider_code: 'WB-503',
      http_status: 503,
    });

    const resolved = await authed(owner, {
      method: 'POST',
      url: `/api/eway-bills/${ewayBillId}/manual-cancel-response`,
      organisationId,
      payload: {
        reasonCode: '2',
        remark: 'Vehicle did not move',
        cancelledAt: '2026-08-08T10:45:00.000Z',
        cancelledAtText: '08/08/2026 16:15:00',
      },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json<EwayBillDetailResponse>().ewayBill.providerState).toBe(
      'cancelled',
    );
  });
});

describe('concurrency', () => {
  it('lets exactly one of two simultaneous drafts claim the live slot', async () => {
    const invoiceId = await submittedDirectInvoice('concurrent draft');
    const [first, second] = await Promise.all([
      createEwayBill(invoiceId, roadBody()),
      createEwayBill(invoiceId, roadBody()),
    ]);
    // The invoice row lock serialises the creates: one live e-way bill,
    // and the loser's conflict names it.
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses, `${first.body} then ${second.body}`).toEqual([201, 409]);
    const winner = first.statusCode === 201 ? first : second;
    const loser = first.statusCode === 201 ? second : first;
    const winnerId = winner.json<EwayBillDetailResponse>().ewayBill.id;
    const conflict = loser.json<{
      code: string;
      details?: { existingRecordId: string };
    }>();
    expect(conflict.code).toBe('EWAY_BILL_EXISTS');
    expect(conflict.details?.existingRecordId).toBe(winnerId);
    const rows = await admin<{ id: string }[]>`
      select id from eway_bills where tax_invoice_id = ${invoiceId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(winnerId);
  });

  it('lets exactly one of two simultaneous provider cancellations reach Whitebooks', async () => {
    resetProviderMocks();
    const invoiceId = await submittedDirectInvoice('concurrent cancel');
    const ewayBillId = await seedWhitebooksEwayBill(invoiceId, '501234567890');
    cancelEwayBillProvider.mockImplementation(() =>
      Promise.resolve({
        cancelledAtText: '12/08/2026 17:00:00',
        cancelledAt: '2026-08-12T11:30:00.000Z',
        rawResponse: '{"status_cd":"1","cancelDate":"12/08/2026 17:00:00"}',
      }),
    );

    const cancelRequest = () =>
      authedOn(providerApp, owner, {
        method: 'POST',
        url: `/api/eway-bills/${ewayBillId}/cancel-provider`,
        organisationId,
        payload: { reasonCode: '2', remark: 'Movement abandoned at the depot' },
      });
    const [first, second] = await Promise.all([cancelRequest(), cancelRequest()]);

    // The row lock plus the pending-operation lease keep the provider
    // mutation single-flight: exactly one request reaches Whitebooks,
    // the other refuses without resending — a duplicate NIC cancellation
    // is never risked.
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses, `${first.body} then ${second.body}`).toEqual([200, 409]);
    const loser = first.statusCode === 200 ? second : first;
    expect(loser.json<{ code: string }>().code).toBe('EWAY_PROVIDER_STATE_CONFLICT');
    expect(cancelEwayBillProvider).toHaveBeenCalledTimes(1);

    const operations = await admin<{ operation: string; status: string }[]>`
      select operation, status from statutory_provider_operations
      where eway_bill_id = ${ewayBillId}
    `;
    expect(operations).toEqual([
      { operation: 'cancel_eway_bill', status: 'succeeded' },
    ]);

    const read = await authed(owner, {
      method: 'GET',
      url: `/api/eway-bills/${ewayBillId}`,
      organisationId,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      status: 'generated',
      providerState: 'cancelled',
      providerCancelledAt: '2026-08-12T11:30:00.000Z',
    });
  });
});

/**
 * ADR-0013: applicability is a property of the LINES, never of the
 * document kind.
 *
 * Three cases, because three is what the rule actually has: a document
 * whose every line is a service is refused, a mixed one proceeds, and a
 * goods-only one proceeds. The first is the 2026-08-10 disposition
 * surviving intact — a SAC-only invoice still cannot raise an e-way bill,
 * and NIC's own error 4009 is why.
 */
describe('applicability keys on line content', () => {
  it('refuses a service-only invoice with the code it has always had', async () => {
    const serviceInvoiceId = await submittedServiceInvoice('service only');
    const refused = await createEwayBill(serviceInvoiceId, roadBody());
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'EWAY_BILL_NOT_APPLICABLE_TO_SERVICE_INVOICE',
    );
  });

  it('admits a MIXED invoice: one goods line among services is enough', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId,
      payload: {
        invoiceDate: '2026-08-08',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
        lineShape: 'itemised',
        lines: [
          {
            isService: true,
            hsnSacCode: '995461',
            description: 'Laying and termination',
            quantity: '1.000',
            unitLabel: 'job',
            unitRate: '5000.00',
            gstRate: '18',
          },
          {
            isService: false,
            hsnSacCode: '85444999',
            description: 'Signalling cable, 4 core',
            quantity: '10.000',
            unitLabel: 'm',
            unitRate: '100.00',
            gstRate: '18',
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const mixedId = created.json<TaxInvoiceDetailResponse>().invoice.id;
    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${mixedId}/submit`,
      organisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);

    const drafted = await createEwayBill(
      mixedId,
      roadBody({ vehicleNumber: 'DL01AB1234' }),
    );
    expect(drafted.statusCode, drafted.body).toBe(201);
    expect(drafted.json<EwayBillDetailResponse>().ewayBill.source).toBe('tax_invoice');
  });
});

/**
 * The challan path (ADR-0013, migrations 0075 and 0076).
 *
 * A standalone Delivery Challan carrying goods to a private customer is a
 * goods movement in its own right, so it raises its own e-way bill —
 * direct generation, no IRN anywhere in it.
 */
describe('the standalone delivery challan as an e-way bill source', () => {
  let goodsChallanId: string;
  let serviceChallanId: string;

  async function standaloneChallan(
    lines: readonly Record<string, unknown>[],
    statutory: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'SDC',
        consigneeContactId: buyerContactId,
        items: lines,
        ...statutory,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<ChallanDetailResponse>().challan.id;
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${id}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    return id;
  }

  it('records the stage-3b facts on the draft and freezes them at issue', async () => {
    goodsChallanId = await standaloneChallan(
      [
        {
          description: 'Signalling cable, 4 core',
          unit: 'm',
          quantity: '40',
          rate: '100.00',
          hsnSacCode: '85444999',
          isService: false,
        },
      ],
      {
        movementReason: 'supply',
        vehicleNumber: 'DL01AB1234',
        transportDistanceKm: 25,
      },
    );
    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/challans/${goodsChallanId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json<ChallanDetailResponse>();
    expect(body.challan).toMatchObject({
      movementReason: 'supply',
      vehicleNumber: 'DL01AB1234',
      transportDistanceKm: 25,
      // Defaulted from the contacts master at draft time, then frozen.
      consigneeGstin: BUYER_GSTIN,
      ewayBillEligible: true,
    });
    expect(body.items[0]).toMatchObject({
      hsnSacCode: '85444999',
      isService: false,
    });

    // The issued challan is immutable, statutory facts included: the
    // 0075 guard is what lets the e-way bill path trust them.
    await expect(
      admin`
        update delivery_challans set movement_reason = 'job_work'
        where id = ${goodsChallanId}
      `,
    ).rejects.toThrow(/issued Delivery Challan business data is immutable/);
  });

  it('refuses a half-stated line classification by name', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'SDC',
        consigneeContactId: buyerContactId,
        items: [
          {
            description: 'Cable drum',
            unit: 'nos',
            quantity: '1',
            rate: '10.00',
            hsnSacCode: '85444999',
          },
        ],
      },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe('LINE_SHAPE_INVALID');
  });

  it('raises a bill from the goods challan and generates it directly', async () => {
    const drafted = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/challans/${goodsChallanId}/eway-bills`,
      organisationId,
      payload: roadBody({ vehicleNumber: 'DL01AB1234' }),
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const bill = drafted.json<EwayBillDetailResponse>().ewayBill;
    expect(bill).toMatchObject({
      source: 'delivery_challan',
      deliveryChallanId: goodsChallanId,
      taxInvoiceId: null,
    });

    // The payload states everything itself: no IRN, and the items NIC
    // needs to see that this movement is goods.
    const payload = await authedOn(providerApp, owner, {
      method: 'GET',
      url: `/api/eway-bills/${bill.id}/nic-payload`,
      organisationId,
    });
    expect(payload.statusCode, payload.body).toBe(200);
    const body = payload.json<{
      docType: string;
      subSupplyType: string;
      toGstin: string;
      itemList: { hsnCode: string; taxableAmount: string }[];
    }>();
    expect(body.docType).toBe('CHL');
    expect(body.subSupplyType).toBe('1');
    expect(body.toGstin).toBe(BUYER_GSTIN);
    expect(body.itemList).toEqual([
      expect.objectContaining({ hsnCode: '85444999', taxableAmount: '4000' }),
    ]);

    generateEwayBillDirectProvider.mockResolvedValueOnce({
      ewbNumber: '881234567890',
      ewbDateText: '08/08/2026 12:00:00',
      ewbDate: '2026-08-08T06:30:00.000Z',
      validUntilText: '09/08/2026 23:59:59',
      validUntil: '2026-08-09T18:29:59.000Z',
      rawResponse: '{"ewayBillNo":881234567890}',
    });
    const generated = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/eway-bills/${bill.id}/generate`,
      organisationId,
    });
    expect(generated.statusCode, generated.body).toBe(200);
    expect(generated.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      status: 'generated',
      providerState: 'generated',
      ewbNumber: '881234567890',
    });
    // Direct generation, never the by-IRN door.
    expect(generateEwayBillDirectProvider).toHaveBeenCalledTimes(1);
    expect(generateEwayBillProvider).not.toHaveBeenCalled();

    const [operation] = await admin<{ operation: string; status: string }[]>`
      select operation, status from statutory_provider_operations
      where eway_bill_id = ${bill.id}
    `;
    expect(operation).toEqual({
      operation: 'generate_eway_bill',
      status: 'succeeded',
    });

    // The printable summary: a convenience print that says on its face
    // that the NIC portal holds the statutory original.
    const rendered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/eway-bills/${bill.id}/render`,
      organisationId,
    });
    expect(rendered.statusCode, rendered.body).toBe(200);
    expect(rendered.json<EwayBillDetailResponse>().ewayBill).toMatchObject({
      renderedAvailable: true,
      renderedVersion: 1,
    });
    const pdf = await authedOn(providerApp, owner, {
      method: 'GET',
      url: `/api/eway-bills/${bill.id}/pdf`,
      organisationId,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    // Append-only, exactly like tax_invoice_renders.
    await expect(
      admin`delete from eway_bill_renders where eway_bill_id = ${bill.id}`,
    ).rejects.toThrow(/e-way bill renders are append-only/);
  });

  it('refuses a service-only challan with the same code an invoice gets', async () => {
    serviceChallanId = await standaloneChallan(
      [
        {
          description: 'Site survey',
          unit: 'job',
          quantity: '1',
          rate: '500.00',
          hsnSacCode: '995461',
          isService: true,
        },
      ],
      { movementReason: 'supply' },
    );
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${serviceChallanId}/eway-bills`,
      organisationId,
      payload: roadBody({ vehicleNumber: 'DL01AB1234' }),
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'EWAY_BILL_NOT_APPLICABLE_TO_SERVICE_INVOICE',
    );
  });

  it('refuses a challan that never recorded its statutory facts', async () => {
    const bareId = await standaloneChallan([
      {
        description: 'Cable drum',
        unit: 'nos',
        quantity: '1',
        rate: '10.00',
        hsnSacCode: '85444999',
        isService: false,
      },
    ]);
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${bareId}/eway-bills`,
      organisationId,
      payload: roadBody({ vehicleNumber: 'DL01AB1234' }),
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'CHALLAN_STATUTORY_FACTS_REQUIRED',
    );
  });

  it('refuses a work-scoped user and another tenant alike', async () => {
    // A standalone challan belongs to no Work, so work scope has nothing
    // to bind through: organisation-wide reach or nothing (0056's rule).
    await admin`
      update organisation_memberships
      set work_scope = 'assigned'
      where organisation_id = ${organisationId}
        and user_id = (select "id" from auth_users where "email" = ${clerkEmail})
    `;
    const scoped = await authed(clerk, {
      method: 'GET',
      url: `/api/challans/${goodsChallanId}/eway-bills`,
      organisationId,
    });
    expect(scoped.statusCode, scoped.body).toBe(404);
    await admin`
      update organisation_memberships
      set work_scope = 'all'
      where organisation_id = ${organisationId}
        and user_id = (select "id" from auth_users where "email" = ${clerkEmail})
    `;

    const foreign = await authed(outsider, {
      method: 'GET',
      url: `/api/challans/${goodsChallanId}/eway-bills`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('holds one live bill per challan and refuses a second source', async () => {
    const second = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${goodsChallanId}/eway-bills`,
      organisationId,
      payload: roadBody({ vehicleNumber: 'DL01AB1234' }),
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('EWAY_BILL_EXISTS');

    // And the database refuses a bill that names both documents, which is
    // the 0076 CHECK rather than anything the route decides. The invoice
    // has to be a LIVE submitted one, or 0076's insert guard refuses the
    // row first and the CHECK never gets to speak.
    const liveInvoiceId = await submittedServiceInvoice('two sources');
    await expect(
      admin`
        insert into eway_bills (
          organisation_id, tax_invoice_id, delivery_challan_id, distance_km,
          from_pincode, to_pincode, vehicle_number, created_by_user_id
        )
        values (
          ${organisationId}, ${liveInvoiceId}, ${serviceChallanId}, 10,
          '110020', '110055', 'DL01AB1234', ${ownerUserId}
        )
      `,
    ).rejects.toThrow(/eway_bills_source_shape/);

    // Neither is refused by the same CHECK.
    await expect(
      admin`
        insert into eway_bills (
          organisation_id, distance_km, from_pincode, to_pincode,
          vehicle_number, created_by_user_id
        )
        values (
          ${organisationId}, 10, '110020', '110055', 'DL01AB1234',
          ${ownerUserId}
        )
      `,
    ).rejects.toThrow(/eway_bills_source_shape/);
  });

  it('refuses a bill raised from a work challan or a draft one', async () => {
    const draft = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'SDC',
        consigneeContactId: buyerContactId,
        movementReason: 'supply',
        items: [
          {
            description: 'Cable drum',
            unit: 'nos',
            quantity: '1',
            rate: '10.00',
            hsnSacCode: '85444999',
            isService: false,
          },
        ],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json<ChallanDetailResponse>().challan.id;
    const onDraft = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftId}/eway-bills`,
      organisationId,
      payload: roadBody({ vehicleNumber: 'DL01AB1234' }),
    });
    expect(onDraft.statusCode, onDraft.body).toBe(409);
    expect(onDraft.json<{ code: string }>().code).toBe('CHALLAN_STATUS_CONFLICT');
    expect(draft.json<ChallanDetailResponse>().challan.ewayBillEligible).toBe(false);
    await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${draftId}`,
      organisationId,
    });

    // A WORK challan moves under its Work; ADR-0013 admits the standalone
    // only, and the 0076 insert guard says the same to raw SQL.
    const workChallan = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-07-01',
        prefix: `${workCode}DC`,
        consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
        items: [{ workItemId: itemId, quantity: '1' }],
      },
    });
    expect(workChallan.statusCode, workChallan.body).toBe(201);
    const workChallanId = workChallan.json<ChallanDetailResponse>().challan.id;
    const onWork = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${workChallanId}/eway-bills`,
      organisationId,
      payload: roadBody({ vehicleNumber: 'DL01AB1234' }),
    });
    expect(onWork.statusCode, onWork.body).toBe(409);
    expect(onWork.json<{ code: string }>().code).toBe('CHALLAN_NOT_STANDALONE');
    await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${workChallanId}`,
      organisationId,
    });
  });
});
