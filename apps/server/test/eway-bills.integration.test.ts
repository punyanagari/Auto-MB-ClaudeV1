import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import {
  StatutoryProviderError,
  type StatutoryProvider,
} from '../src/gsp/statutory-provider.js';

/**
 * The e-way bill (migration 0035): the movement document for a
 * SUBMITTED tax invoice. What has to hold:
 *
 * - only a submitted invoice takes an e-way bill â€” refused by the route
 *   and by the 0035 insert trigger against raw SQL;
 * - one live e-way bill per invoice, the conflict naming the live one;
 * - the NIC payload is the canonical EWB JSON, pinned by golden
 *   deep-equals for BOTH carriage shapes: road (vehicleNo) and rail
 *   (transDocNo/transDocDate) â€” with the incomplete-carriage refusals
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
const providerStub: StatutoryProvider = {
  name: 'whitebooks',
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
      reverseChargeApplicable: false,
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

async function submittedDirectInvoice(suffix: string): Promise<string> {
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
  providerApp = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
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
      pincode, state_code, locality, is_consignee, activÛÍ{¶‰žËkºwµçXÜàäÀÄÈœ°(€€€€€€€•Ý‰…Ñ”è€œÈÀÈØ´Àà´ÀÙPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€Ù…±¥‘U¹Ñ¥°è€œÈÀÈØ´Àà´ÀÝPÈÌèÔäèÔä¸ÀÀÁhœ°(€€€€€€€•Ý‰…Ñ•Q•áÐè€œÀØ¼Àà¼ÈÀÈØ€ÄÔèÌÀèÀÀœ°(€€€€€€€Ù…±¥‘U¹Ñ¥±Q•áÐè€œÀÜ¼Àà¼ÈÀÈØ€ÈÌèÔäèÔäœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡•¹•É…Ñ•¹ÍÑ…ÑÕÍ½‘”°•¹•É…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐ‰¥±°€ô•¹•É…Ñ•¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°ì(€€€•áÁ•Ð¡‰¥±°¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€•¹•É…Ñ•œ°(€€€€€•Ý‰9Õµ‰•Èè€œÄÈÌÐÔØÜàäÀÄÈœ°(€€€€€•Ý‰…Ñ”è€œÈÀÈØ´Àà´ÀÙPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€Ù…±¥‘U¹Ñ¥°è€œÈÀÈØ´Àà´ÀÝPÈÌèÔäèÔä¸ÀÀÁhœ°(€€€ô¤ì(€€€•áÁ•Ð¡‰¥±°¹•¹•É…Ñ•‘Ð¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì((€€€€¼¼•¹•É…Ñ•¥Ì™É½é•¸è¹¼Í•½¹É•ÍÁ½¹Í”°¹¼•‘¥ÑÌ°¹¼‘•±•Ñ”¸(€€€½¹ÍÐ……¥¸€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ½…‘Ý‰%‘ô½¹¥ŒµÉ•ÍÁ½¹Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€•Ý‰9Õµ‰•Èè€œääääääääääääœ°(€€€€€€€•Ý‰…Ñ”è€œÈÀÈØ´Àà´ÀÙPÄÄèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€Ù…±¥‘U¹Ñ¥°è€œÈÀÈØ´Àà´ÀáPÈÌèÔäèÔä¸ÀÀÁhœ°(€€€€€€€•Ý‰…Ñ•Q•áÐè€œÀØ¼Àà¼ÈÀÈØ€ÄØèÌÀèÀÀœ°(€€€€€€€Ù…±¥‘U¹Ñ¥±Q•áÐè€œÀà¼Àà¼ÈÀÈØ€ÈÌèÔäèÔäœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡……¥¸¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€½¹ÍÐ•‘¥Ð€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ½…‘Ý‰%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èÉ½…‘	½‘ä¡ìÙ•¡¥±•9Õµ‰•Èè€0ÀÅÄÈÌÐœô¤°(€€€ô¤ì(€€€•áÁ•Ð¡•‘¥Ð¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€½¹ÍÐ‘•°€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€1Qœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ½…‘Ý‰%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡‘•°¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì((€€€€¼¼Q¡”…ÉÉ¥…”!,¥ÌÑ¡”‘…Ñ…‰…Í”Ì½Ý¸èÉ…ÜME0…¹¹½ÐÍÑÉ¥ÀÑ¡”(€€€€¼¼Ù•¡¥±”½™˜„•¹•É…Ñ•É½…µ½Ù•µ•¹Ð•¥Ñ¡•È¸(€€€…Ý…¥Ð•áÁ•Ð (€€€€€…‘µ¥¹ÕÁ‘…Ñ”•Ý…å}‰¥±±ÌÍ•ÐÙ•¡¥±•}¹Õµ‰•È€ô¹Õ±°Ý¡•É”¥€ô€‘íÉ½…‘Ý‰%‘õ€°(€€€€¤¹É•©•ÑÌ¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€œÈÌÔÄÐœô¤ì(€ô¤ì((€¥Ð ¡½±‘ÌÑ¡”…¹•°½É‘•Èè¥¹Ù½¥”É•™ÕÍ•ÌÕ¹‘•È„±¥Ù””µÝ…ä‰¥±°œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ¥¹Ù½¥•…¹•°€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘íÍÕ‰µ¥ÑÑ•‘%¹Ù½¥•%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€ÑÉå¥¹œÑ¼…¹•°Õ¹‘•È„±¥Ù”µ½Ù•µ•¹Ðœô°(€€€ô¤ì(€€€•áÁ•Ð¡¥¹Ù½¥•…¹•°¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡¥¹Ù½¥•…¹•°¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” ]e}	%11}1%Yœ¤ì((€€€½¹ÍÐÕ¹…ÕÑ¡½É¥Í•€ô…Ý…¥Ð…ÕÑ¡•¡±•É¬°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ½…‘Ý‰%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€±•É¬…¹¹½Ð…¹•°œô°(€€€ô¤ì(€€€•áÁ•Ð¡Õ¹…ÕÑ¡½É¥Í•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÌ¤ì(€€€•áÁ•Ð¡Õ¹…ÕÑ¡½É¥Í•¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” UQ!=I%Qe}IEU%Iœ¤ì((€€€½¹ÍÐ•áÑ•É¹…±…¹•±±…Ñ¥½¸€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ½…‘Ý‰%‘ô½µ…¹Õ…°µ…¹•°µÉ•ÍÁ½¹Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€É•…Í½¹½‘”è€œÈœ°(€€€€€€€É•µ…É¬è€=É‘•È…¹•±±•‰•™½É”‘¥ÍÁ…Ñ œ°(€€€€€€€…¹•±±•‘Ðè€œÈÀÈØ´Àà´ÀÙPÄÄèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€…¹•±±•‘ÑQ•áÐè€œÀØ¼Àà¼ÈÀÈØ€ÄØèÌÀèÀÀœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡•áÑ•É¹…±…¹•±±…Ñ¥½¸¹ÍÑ…ÑÕÍ½‘”°•áÑ•É¹…±…¹•±±…Ñ¥½¸¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡•áÑ•É¹…±…¹•±±…Ñ¥½¸¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÁÉ½Ù¥‘•ÉMÑ…Ñ”è€…¹•±±•œ°(€€€€€ÁÉ½Ù¥‘•É…¹•±±•‘Ðè€œÈÀÈØ´Àà´ÀÙPÄÄèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€ÁÉ½Ù¥‘•É…¹•±±•‘ÑQ•áÐè€œÀØ¼Àà¼ÈÀÈØ€ÄØèÌÀèÀÀœ°(€€€€€ÁÉ½Ù¥‘•É…¹•±I•…Í½¹½‘”è€œÈœ°(€€€€€ÁÉ½Ù¥‘•É…¹•±I•µ…É¬è€=É‘•È…¹•±±•‰•™½É”‘¥ÍÁ…Ñ œ°(€€€ô¤ì((€€€½¹ÍÐ…¹•±±•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ½…‘Ý‰%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€Ù•¡¥±”‰É½­”‘½Ý¸‰•™½É”‘¥ÍÁ…Ñ œô°(€€€ô¤ì(€€€•áÁ•Ð¡…¹•±±•¹ÍÑ…ÑÕÍ½‘”°…¹•±±•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐ‰¥±°€ô…¹•±±•¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°ì(€€€•áÁ•Ð¡‰¥±°¹ÍÑ…ÑÕÌ¤¹Ñ½	” …¹•±±•œ¤ì(€€€€¼¼…¹•±±…Ñ¥½¸É•Ñ…¥¹ÌÑ¡”½™™¥¥…°¥‘•¹Ñ¥Ñä…¹•á…ÐÁ½ÉÑ…°•Ù¥‘•¹”¸(€€€•áÁ•Ð¡‰¥±°¹•Ý‰9Õµ‰•È¤¹Ñ½	” œÄÈÌÐÔØÜàäÀÄÈœ¤ì(€€€•áÁ•Ð¡‰¥±°¹•Ý‰…Ñ•Q•áÐ¤¹Ñ½	” œÀØ¼Àà¼ÈÀÈØ€ÄÔèÌÀèÀÀœ¤ì(€€€•áÁ•Ð¡‰¥±°¹Ù…±¥‘U¹Ñ¥±Q•áÐ¤¹Ñ½	” œÀÜ¼Àà¼ÈÀÈØ€ÈÌèÔäèÔäœ¤ì(€€€•áÁ•Ð¡‰¥±°¹…¹•±±…Ñ¥½¹9½Ñ”¤¹Ñ½	” Ù•¡¥±”‰É½­”‘½Ý¸‰•™½É”‘¥ÍÁ…Ñ œ¤ì(€€€½¹ÍÐm•Ù•¹Ñt€ô…Ý…¥Ð…‘µ¥¸ñì‘•Ñ…¥±Ìèì•Ý‰9Õµ‰•ÈüèÍÑÉ¥¹œôõmtù€(€€€€€Í•±•Ð‘•Ñ…¥±Ì™É½´…Õ‘¥Ñ}•Ù•¹ÑÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô(€€€€€€€…¹•¹Ñ¥Ñå}ÑåÁ”€ô€•Ý…å}‰¥±±Ìœ…¹•¹Ñ¥Ñå}¥€ô€‘íÉ½…‘Ý‰%‘ô(€€€€€€€…¹…Ñ¥½¸€ô€•Ý…å}‰¥±°¹…¹•±±•œ(€€€€€½É‘•È‰ä½ÕÉÉ•‘}…Ð‘•ÍŒ°¥‘•ÍŒ(€€€€€±¥µ¥Ð€Ä(€€€€ì(€€€•áÁ•Ð¡•Ù•¹Ðü¹‘•Ñ…¥±Ì¹•Ý‰9Õµ‰•È¤¹Ñ½	” œÄÈÌÐÔØÜàäÀÄÈœ¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” É…¥°…ÉÉ¥…”œ°€ ¤€ôøì(€¥Ð ‘É…™ÑÌ½¸Ñ¡”™É••Í±½Ð…¹É•™ÕÍ•ÌÑ¡”±•…äÉ…¥°Á…å±½…œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥ÐÉ•…Ñ•Ý…å	¥±°¡ÍÕ‰µ¥ÑÑ•‘%¹Ù½¥•%°ì(€€€€€ÑÉ…¹ÍÁ½ÉÑ5½‘”è€É…¥°œ°(€€€€€ÑÉ…¹ÍÁ½ÉÑ½9Õµ‰•Èè€IH´ÄÈÌÐÔØœ°(€€€€€ÑÉ…¹ÍÁ½ÉÑ½…Ñ”è€œÈÀÈØ´Àà´ÀØœ°(€€€€€‘¥ÍÑ…¹•-´è€äÀÀ°(€€€€€™É½µA¥¹½‘”è€œÄÄÀÀÈÀœ°(€€€€€Ñ½A¥¹½‘”è€œÄÄÀÀÔÔœ°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€É…¥±Ý‰%€ôÉ•…Ñ•¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¹¥ì((€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘ô½¹¥ŒµÁ…å±½…‘€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” (€€€€€€]e}	%11}9=Q}AA1%	1}Q=}MIY%}%9Y=%œ°(€€€€¤ì(€ô¤ì((€¥Ð ‘•µ…¹‘ÌÑ¡”ÑÉ…¹ÍÁ½ÉÐ‘½Õµ•¹Ð‰•™½É”9%…¸…¹ÍÝ•Èœ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼É½ÀÑ¡”‘½Œ‘…Ñ”èÑ¡”…ÉÉ¥…”¥Ì¥¹½µÁ±•Ñ”……¥¸¸(€€€½¹ÍÐÍÑÉ¥ÁÁ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ5½‘”è€É…¥°œ°(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ½9Õµ‰•Èè€IH´ÄÈÌÐÔØœ°(€€€€€€€‘¥ÍÑ…¹•-´è€äÀÀ°(€€€€€€€™É½µA¥¹½‘”è€œÄÄÀÀÈÀœ°(€€€€€€€Ñ½A¥¹½‘”è€œÄÄÀÀÔÔœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡ÍÑÉ¥ÁÁ•¹ÍÑ…ÑÕÍ½‘”°ÍÑÉ¥ÁÁ•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì((€€€½¹ÍÐÉ•™ÕÍ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘ô½¹¥ŒµÉ•ÍÁ½¹Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€•Ý‰9Õµ‰•Èè€œÈÄÀäàÜØÔÐÌÈÄœ°(€€€€€€€•Ý‰…Ñ”è€œÈÀÈØ´Àà´ÀÝPÀäèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€Ù…±¥‘U¹Ñ¥°è€œÈÀÈØ´Àà´ÄÁPÈÌèÔäèÔä¸ÀÀÁhœ°(€€€€€€€•Ý‰…Ñ•Q•áÐè€œÀÜ¼Àà¼ÈÀÈØ€ÄÐèÌÀèÀÀœ°(€€€€€€€Ù…±¥‘U¹Ñ¥±Q•áÐè€œÄÀ¼Àà¼ÈÀÈØ€ÈÌèÔäèÔäœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•™ÕÍ•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÀ¤ì(€€€•áÁ•Ð¡É•™ÕÍ•¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” QI9MA=IQ}=}IEU%Iœ¤ì((€€€½¹ÍÐÉ•ÍÑ½É•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ5½‘”è€É…¥°œ°(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ½9Õµ‰•Èè€IH´ÄÈÌÐÔØœ°(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ½…Ñ”è€œÈÀÈØ´Àà´ÀØœ°(€€€€€€€‘¥ÍÑ…¹•-´è€äÀÀ°(€€€€€€€™É½µA¥¹½‘”è€œÄÄÀÀÈÀœ°(€€€€€€€Ñ½A¥¹½‘”è€œÄÄÀÀÔÔœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÑ½É•¹ÍÑ…ÑÕÍ½‘”°É•ÍÑ½É•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì((€€€½¹ÍÐ•¹•É…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘ô½¹¥ŒµÉ•ÍÁ½¹Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€•Ý‰9Õµ‰•Èè€œÈÄÀäàÜØÔÐÌÈÄœ°(€€€€€€€•Ý‰…Ñ”è€œÈÀÈØ´Àà´ÀÝPÀäèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€Ù…±¥‘U¹Ñ¥°è€œÈÀÈØ´Àà´ÄÁPÈÌèÔäèÔä¸ÀÀÁhœ°(€€€€€€€•Ý‰…Ñ•Q•áÐè€œÀÜ¼Àà¼ÈÀÈØ€ÄÐèÌÀèÀÀœ°(€€€€€€€Ù…±¥‘U¹Ñ¥±Q•áÐè€œÄÀ¼Àà¼ÈÀÈØ€ÈÌèÔäèÔäœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡•¹•É…Ñ•¹ÍÑ…ÑÕÍ½‘”°•¹•É…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡•¹•É…Ñ•¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€•¹•É…Ñ•œ°(€€€€€•Ý‰9Õµ‰•Èè€œÈÄÀäàÜØÔÐÌÈÄœ°(€€€€€ÑÉ…¹ÍÁ½ÉÑ5½‘”è€É…¥°œ°(€€€€€ÑÉ…¹ÍÁ½ÉÑ½9Õµ‰•Èè€IH´ÄÈÌÐÔØœ°(€€€€€ÑÉ…¹ÍÁ½ÉÑ½…Ñ”è€œÈÀÈØ´Àà´ÀØœ°(€€€ô¤ì(€ô¤ì((€¥Ð ±½Í•ÌÑ¡”Ý¡½±”¡…¥¸è”µÝ…ä‰¥±°…¹•±±•°Ñ¡•¸Ñ¡”¥¹Ù½¥”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ‰±½­•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘íÍÕ‰µ¥ÑÑ•‘%¹Ù½¥•%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€ÍÑ¥±°µ½Ù¥¹œÕ¹‘•ÈÑ¡”É…¥°”µÝ…ä‰¥±°œô°(€€€ô¤ì(€€€•áÁ•Ð¡‰±½­•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡‰±½­•¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” ]e}	%11}1%Yœ¤ì((€€€½¹ÍÐ•áÑ•É¹…±…¹•±±…Ñ¥½¸€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘ô½µ…¹Õ…°µ…¹•°µÉ•ÍÁ½¹Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€É•…Í½¹½‘”è€œÈœ°(€€€€€€€É•µ…É¬è€=É‘•È…¹•±±•‰•™½É”É…¥°‘¥ÍÁ…Ñ œ°(€€€€€€€…¹•±±•‘Ðè€œÈÀÈØ´Àà´ÀÝPÄÀèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€…¹•±±•‘ÑQ•áÐè€œÀÜ¼Àà¼ÈÀÈØ€ÄÔèÌÀèÀÀœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡•áÑ•É¹…±…¹•±±…Ñ¥½¸¹ÍÑ…ÑÕÍ½‘”°•áÑ•É¹…±…¹•±±…Ñ¥½¸¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì((€€€½¹ÍÐ•Ý‰…¹•±±•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€½¹Í¥¹µ•¹Ð‘¥¹½Ðµ½Ù”œô°(€€€ô¤ì(€€€•áÁ•Ð¡•Ý‰…¹•±±•¹ÍÑ…ÑÕÍ½‘”°•Ý‰…¹•±±•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì((€€€½¹ÍÐ¥¹Ù½¥•…¹•±±•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘íÍÕ‰µ¥ÑÑ•‘%¹Ù½¥•%‘ô½…¹•±€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€‰¥±±¥¹œÁ•É¥½É”µ…ÍÐœô°(€€€ô¤ì(€€€•áÁ•Ð¡¥¹Ù½¥•…¹•±±•¹ÍÑ…ÑÕÍ½‘”°¥¹Ù½¥•…¹•±±•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡¥¹Ù½¥•…¹•±±•¹©Í½¸ñQ…á%¹Ù½¥••Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¥¹Ù½¥”¹ÍÑ…ÑÕÌ¤¹Ñ½	” (€€€€€€…¹•±±•œ°(€€€€¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” ±¥ÍÑ¥¹œ°Ñ•¹…¹ä°…¹Í½Á”œ°€ ¤€ôøì(€¥Ð ±¥ÍÑÌÑ¡”¥¹Ù½¥”µ½Ù•µ•¹ÑÌ°¹•Ý•ÍÐ™¥ÉÍÐ°Ý¥Ñ Ñ¡”¥¹Ù½¥”¹Õµ‰•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘íÍÕ‰µ¥ÑÑ•‘%¹Ù½¥•%‘ô½•Ý…äµ‰¥±±Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐì•Ý…å	¥±±Ìô€ôÉ•ÍÁ½¹Í”¹©Í½¸ñÝ…å	¥±±1¥ÍÑI•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ð¡•Ý…å	¥±±Ì¹±•¹Ñ ¤¹Ñ½	” È¤ì(€€€•áÁ•Ð¡•Ý…å	¥±±Ì¹•Ù•Éä ¡‰¥±°¤€ôø‰¥±°¹ÍÑ…ÑÕÌ€ôôô€…¹•±±•œ¤¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð¡•Ý…å	¥±±Ì¹•Ù•Éä ¡‰¥±°¤€ôø‰¥±°¹¥¹Ù½¥•9Õµ‰•È€ôôô€@ÄÀÈØÀÀÄœ¤¤¹Ñ½	”¡ÑÉÕ”¤ì(€ô¤ì((€¥Ð …¹ÍÝ•ÉÌ€ÐÀÐ…É½ÍÌÑ•¹…¹ÑÌ…¹€ÐÀÄÝ¥Ñ¡½ÕÐ„Í•ÍÍ¥½¸œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…€ô…Ý…¥Ð…ÕÑ¡•¡½ÕÑÍ¥‘•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%è½ÕÑÍ¥‘•É=É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•…¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÐ¤ì((€€€½¹ÍÐ±¥ÍÐ€ô…Ý…¥Ð…ÕÑ¡•¡½ÕÑÍ¥‘•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘íÍÕ‰µ¥ÑÑ•‘%¹Ù½¥•%‘ô½•Ý…äµ‰¥±±Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%è½ÕÑÍ¥‘•É=É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡±¥ÍÐ¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÐ¤ì((€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡•¡½ÕÑÍ¥‘•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘ô½¹¥ŒµÁ…å±½…‘€°(€€€€€½É…¹¥Í…Ñ¥½¹%è½ÕÑÍ¥‘•É=É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡Á…å±½…¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÐ¤ì((€€€½¹ÍÐ•‘¥Ð€ô…Ý…¥Ð…ÕÑ¡•¡½ÕÑÍ¥‘•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%è½ÕÑÍ¥‘•É=É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èÉ½…‘	½‘ä ¤°(€€€ô¤ì(€€€•áÁ•Ð¡•‘¥Ð¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÐ¤ì((€€€½¹ÍÐ…¹½¹åµ½ÕÌ€ô…Ý…¥Ð…ÁÀ¹¥¹©•Ð¡ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘íÉ…¥±Ý‰%‘õ€°(€€€€€¡•…‘•ÉÌèì€àµ½É…¹¥Í…Ñ¥½¸µ¥œè½É…¹¥Í…Ñ¥½¹%ô°(€€€ô¤ì(€€€•áÁ•Ð¡…¹½¹åµ½ÕÌ¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÄ¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” ]¡¥Ñ•‰½½­Ì”µÝ…ä‰¥±°ÁÉ½Ù¥‘•È…¹•±±…Ñ¥½¸œ°€ ¤€ôøì(€¥Ð …¹•±Ì½¹”…¹É•Ñ…¥¹Ì•á…ÐÁÉ½Ù¥‘•È•Ù¥‘•¹”¥¸Ñ¡”±•‘•Èœ°…Íå¹Œ€ ¤€ôøì(€€€É•Í•ÑAÉ½Ù¥‘•É5½­Ì ¤ì(€€€½¹ÍÐ¥¹Ù½¥•%€ô…Ý…¥ÐÍÕ‰µ¥ÑÑ•‘¥É•Ñ%¹Ù½¥” ÍÕ•ÍÌœ¤ì(€€€½¹ÍÐ•Ý…å	¥±±%€ô…Ý…¥ÐÍ••‘]¡¥Ñ•‰½½­ÍÝ…å	¥±°¡¥¹Ù½¥•%°€œÌÀÄÈÌÐÔØÜàäÀœ¤ì(€€€…¹•±Ý…å	¥±±AÉ½Ù¥‘•È¹µ½­I•Í½±Ù•‘Y…±Õ•=¹”¡ì(€€€€€…¹•±±•‘ÑQ•áÐè€œÀà¼Àà¼ÈÀÈØ€ÄØèÀÀèÀÀœ°(€€€€€…¹•±±•‘Ðè€œÈÀÈØ´Àà´ÀáPÄÀèÌÀèÀÀ¸ÀÀÁhœ°(€€€ô¤ì((€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•‘=¸¡ÁÉ½Ù¥‘•ÉÁÀ°½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘í•Ý…å	¥±±%‘ô½…¹•°µÁÉ½Ù¥‘•É€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èìÉ•…Í½¹½‘”è€œÈœ°É•µ…É¬è€œ€=É‘•È…¹•±±•‰•™½É”‘¥ÍÁ…Ñ €€œô°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€•¹•É…Ñ•œ°(€€€€€ÁÉ½Ù¥‘•Èè€Ý¡¥Ñ•‰½½­Ìœ°(€€€€€ÁÉ½Ù¥‘•ÉMÑ…Ñ”è€…¹•±±•œ°(€€€€€ÁÉ½Ù¥‘•É…¹•±±•‘Ðè€œÈÀÈØ´Àà´ÀáPÄÀèÌÀèÀÀ¸ÀÀÁhœ°(€€€€€ÁÉ½Ù¥‘•É…¹•±±•‘ÑQ•áÐè€œÀà¼Àà¼ÈÀÈØ€ÄØèÀÀèÀÀœ°(€€€€€ÁÉ½Ù¥‘•É…¹•±I•…Í½¹½‘”è€œÈœ°(€€€€€ÁÉ½Ù¥‘•É…¹•±I•µ…É¬è€=É‘•È…¹•±±•‰•™½É”‘¥ÍÁ…Ñ œ°(€€€ô¤ì(€€€•áÁ•Ð¡…¹•±Ý…å	¥±±AÉ½Ù¥‘•È¤¹Ñ½!…Ù•	••¹…±±•‘Q¥µ•Ì Ä¤ì(€€€•áÁ•Ð¡…¹•±Ý…å	¥±±AÉ½Ù¥‘•È¤¹Ñ½!…Ù•	••¹…±±•‘]¥Ñ ¡ì(€€€€€ÍÑ¥¸è=I}MQ%8°(€€€€€•Ý‰9Õµ‰•Èè€œÌÀÄÈÌÐÔØÜàäÀœ°(€€€€€É•…Í½¹½‘”è€œÈœ°(€€€€€É•µ…É¬è€=É‘•È…¹•±±•‰•™½É”‘¥ÍÁ…Ñ œ°(€€€ô¤ì(€€€½¹ÍÐm½Á•É…Ñ¥½¹t€ô…Ý…¥Ð…‘µ¥¸ð(€€€€€ì(€€€€€€€½Á•É…Ñ¥½¸èÍÑÉ¥¹œì(€€€€€€€ÍÑ…ÑÕÌèÍÑÉ¥¹œì(€€€€€€€ÁÉ½Ù¥‘•ÈèÍÑÉ¥¹œì(€€€€€€€•¹Ù¥É½¹µ•¹ÐèÍÑÉ¥¹œì(€€€€€€€½µÁ±•Ñ•è‰½½±•…¸ì(€€€€€õmt(€€€€ù€(€€€€€Í•±•Ð½Á•É…Ñ¥½¸°ÍÑ…ÑÕÌ°ÁÉ½Ù¥‘•È°•¹Ù¥É½¹µ•¹Ð°(€€€€€€€€€€€€½µÁ±•Ñ•‘}…Ð¥Ì¹½Ð¹Õ±°…Ì½µÁ±•Ñ•(€€€€€™É½´ÍÑ…ÑÕÑ½Éå}ÁÉ½Ù¥‘•É}½Á•É…Ñ¥½¹ÌÝ¡•É”•Ý…å}‰¥±±}¥€ô€‘í•Ý…å	¥±±%‘ô(€€€€ì(€€€•áÁ•Ð¡½Á•É…Ñ¥½¸¤¹Ñ½ÅÕ…°¡ì(€€€€€½Á•É…Ñ¥½¸è€…¹•±}•Ý…å}‰¥±°œ°(€€€€€ÍÑ…ÑÕÌè€ÍÕ••‘•œ°(€€€€€ÁÉ½Ù¥‘•Èè€Ý¡¥Ñ•‰½½­Ìœ°(€€€€€•¹Ù¥É½¹µ•¹Ðè€Í…¹‘‰½àœ°(€€€€€½µÁ±•Ñ•èÑÉÕ”°(€€€ô¤ì(€ô¤ì((€¥Ð ‘½•Ì¹½ÐÉ•Á•…Ð…¸Õ¹­¹½Ý¸…¹•±±…Ñ¥½¸µÕÑ…Ñ¥½¸œ°…Íå¹Œ€ ¤€ôøì(€€€É•Í•ÑAÉ½Ù¥‘•É5½­Ì ¤ì(€€€½¹ÍÐ¥¹Ù½¥•%€ô…Ý…¥ÐÍÕ‰µ¥ÑÑ•‘¥É•Ñ%¹Ù½¥” Õ¹­¹½Ý¸É•ÍÕ±Ðœ¤ì(€€€½¹ÍÐ•Ý…å	¥±±%€ô…Ý…¥ÐÍ••‘]¡¥Ñ•‰½½­ÍÝ…å	¥±°¡¥¹Ù½¥•%°€œÐÀÄÈÌÐÔØÜàäÀœ¤ì(€€€…¹•±Ý…å	¥±±AÉ½Ù¥‘•È¹µ½­I•©•Ñ•‘Y…±Õ•=¹” (€€€€€¹•ÜMÑ…ÑÕÑ½ÉåAÉ½Ù¥‘•ÉÉÉ½È (€€€€€€€€]!%Q	==-M}5UQQ%=9}U9-9=]8œ°(€€€€€€€€Õ¹­¹½Ý¸œ°(€€€€€€€€]´ÔÀÌœ°(€€€€€€€€ÔÀÌ°(€€€€€€¤°(€€€€¤ì((€€€½¹ÍÐÕ¹•ÉÑ…¥¸€ô…Ý…¥Ð…ÕÑ¡•‘=¸¡ÁÉ½Ù¥‘•ÉÁÀ°½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘í•Ý…å	¥±±%‘ô½…¹•°µÁÉ½Ù¥‘•É€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èìÉ•…Í½¹½‘”è€œÈœ°É•µ…É¬è€Y•¡¥±”‘¥¹½Ðµ½Ù”œô°(€€€ô¤ì(€€€•áÁ•Ð¡Õ¹•ÉÑ…¥¸¹ÍÑ…ÑÕÍ½‘”°Õ¹•ÉÑ…¥¸¹‰½‘ä¤¹Ñ½	” ÈÀÈ¤ì(€€€•áÁ•Ð¡Õ¹•ÉÑ…¥¸¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¹ÁÉ½Ù¥‘•ÉMÑ…Ñ”¤¹Ñ½	” (€€€€€€…¹•±±…Ñ¥½¹}Õ¹­¹½Ý¸œ°(€€€€¤ì((€€€½¹ÍÐÉ•Á•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•‘=¸¡ÁÉ½Ù¥‘•ÉÁÀ°½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘í•Ý…å	¥±±%‘ô½…¹•°µÁÉ½Ù¥‘•É€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èìÉ•…Í½¹½‘”è€œÈœ°É•µ…É¬è€Y•¡¥±”‘¥¹½Ðµ½Ù”œô°(€€€ô¤ì(€€€•áÁ•Ð¡É•Á•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•Á•…Ñ•¹‰½‘ä¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡É•Á•…Ñ•¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” ]e}AI=Y%I}MQQ}=91%Pœ¤ì(€€€•áÁ•Ð¡…¹•±Ý…å	¥±±AÉ½Ù¥‘•È¤¹Ñ½!…Ù•	••¹…±±•‘Q¥µ•Ì Ä¤ì((€€€½¹ÍÐm½Á•É…Ñ¥½¹t€ô…Ý…¥Ð…‘µ¥¸ð(€€€€€ìÍÑ…ÑÕÌèÍÑÉ¥¹œìÁÉ½Ù¥‘•É}½‘”èÍÑÉ¥¹œð¹Õ±°ì¡ÑÑÁ}ÍÑ…ÑÕÌè¹Õµ‰•Èð¹Õ±°õmt(€€€€ù€(€€€€€Í•±•ÐÍÑ…ÑÕÌ°ÁÉ½Ù¥‘•É}½‘”°¡ÑÑÁ}ÍÑ…ÑÕÌ(€€€€€™É½´ÍÑ…ÑÕÑ½Éå}ÁÉ½Ù¥‘•É}½Á•É…Ñ¥½¹ÌÝ¡•É”•Ý…å}‰¥±±}¥€ô€‘í•Ý…å	¥±±%‘ô(€€€€ì(€€€•áÁ•Ð¡½Á•É…Ñ¥½¸¤¹Ñ½ÅÕ…°¡ì(€€€€€ÍÑ…ÑÕÌè€Õ¹­¹½Ý¸œ°(€€€€€ÁÉ½Ù¥‘•É}½‘”è€]´ÔÀÌœ°(€€€€€¡ÑÑÁ}ÍÑ…ÑÕÌè€ÔÀÌ°(€€€ô¤ì((€€€½¹ÍÐÉ•Í½±Ù•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘í•Ý…å	¥±±%‘ô½µ…¹Õ…°µ…¹•°µÉ•ÍÁ½¹Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€É•…Í½¹½‘”è€œÈœ°(€€€€€€€É•µ…É¬è€Y•¡¥±”‘¥¹½Ðµ½Ù”œ°(€€€€€€€…¹•±±•‘Ðè€œÈÀÈØ´Àà´ÀáPÄÀèÐÔèÀÀ¸ÀÀÁhœ°(€€€€€€€…¹•±±•‘ÑQ•áÐè€œÀà¼Àà¼ÈÀÈØ€ÄØèÄÔèÀÀœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•Í½±Ù•¹ÍÑ…ÑÕÍ½‘”°É•Í½±Ù•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡É•Í½±Ù•¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¹ÁÉ½Ù¥‘•ÉMÑ…Ñ”¤¹Ñ½	” (€€€€€€…¹•±±•œ°(€€€€¤ì(€ô¤ì)ô¤ì