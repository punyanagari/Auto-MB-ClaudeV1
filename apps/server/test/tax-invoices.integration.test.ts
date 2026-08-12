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
  TaxInvoiceDetailResponse,
  TaxInvoiceListResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
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
 *   VERBATIM â€” asserted as 2dp strings, including the half-rounding
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
let ownerUserId: string;
let workId: string;
let itemId: string;
let buyerContactId: string;
let barePincodeBuyerId: string;
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

/** One finalized on-account MB fed by one fresh issued challan â€” the
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
  };
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
  ×ôæÚ$z{-®éÜj×¢s##bÓÓRrÀ¢646öFS¢s““ƒs3BrÀ¢6W'f–6TFW67&—F–öã¢u7WÇ’f÷"&—fFR7W7FöÖW"ârÀ¢w7E&FS¢s‚rÀ¢Æ6Töe7WÇ“¢srrÀ¢&WfW'6T6†&vTÆ–6&ÆS¢fÇ6RÀ¢'W–W$6öçF7D–BÀ¢ÒÀ¢Ò“°¢òòF†R66†VÖæÖW2F†RÖ—76–ærf–VÆC²v—F†÷WBfÇVRF†R–çfö–6P¢òòv÷VÆB†fRæòç7vW"Fòv†B—B—2v÷'F‚à¢W‡V7B†7&VFVBç7FGW46öFR’çFô&RƒC“°¢Ò“°§Ò“° ¦FW67&–&R‚uv†—FV&öö·2•%&÷f–FW"&÷WFW2rÂ‚’Óâ°¢—B‚w&Vv—7FW'2æB6æ6VÇ2öæ6RÂ&W6W'f–ærW†7B&÷f–FW"Wf–FVæ6RrÂ7–æ2‚’Óâ°¢&W6WE&÷f–FW$Öö6·2‚“°¢6öç7B–çfö–6RÒv—B7V&Ö—GFVDF—&V7D–çfö–6R‚w7V66W72r“°¢6öç7BWf–FVæ6RÒ—'Wf–FVæ6R‚vr“°¢&Vv—7FW$–çfö–6U&÷f–FW"æÖö6µ&W6öÇfVEfÇVTöæ6R†Wf–FVæ6R“°¢6æ6VÄ–çfö–6U&÷f–FW"æÖö6µ&W6öÇfVEfÇVTöæ6R‡°¢6æ6VÆÆVDEFW‡C¢s"ó‚ó##bS££rÀ¢6æ6VÆÆVDC¢s##bÓ‚Ó%C“£3£ã¢rÀ¢Ò“° ¢6öç7B&Vv—7FW&VBÒv—BWF†VDöâ‡&÷f–FW$Â÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&Vv—7FW"Ö—'À¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡&Vv—7FW&VBç7FGW46öFRÂ&Vv—7FW&VBæ&öG’’çFô&Rƒ#“°¢W‡V7B‡&Vv—7FW&VBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6R’çFôÖF6„ö&¦V7B‡°¢—&ã¢Wf–FVæ6Ræ—&âÀ¢6´çVÖ&W#¢Wf–FVæ6Ræ6´çVÖ&W"À¢6´FFS¢Wf–FVæ6Ræ6´FFRÀ¢6´FFUFW‡C¢Wf–FVæ6Ræ6´FFUFW‡BÀ¢—'&÷f–FW#¢wv†—FV&öö·2rÀ¢—'&÷f–FW%7FFS¢w&Vv—7FW&VBrÀ¢Ò“°¢W‡V7B‡&Vv—7FW$–çfö–6U&÷f–FW"’çFô†fT&VVä6ÆÆVEF–ÖW2ƒ“°¢6öç7B¶–FVçF—G’Â–ÆöD§6öåÒÒ&Vv—7FW$–çfö–6U&÷f–FW"æÖö6²æ6ÆÇ5³ÒóòµÓ°¢W‡V7B†–FVçF—G’’çFôWVÂ‡°¢w7F–ã¢õ$uôu5D”âÀ¢Fö7VÖVçDçVÖ&W#¢–çfö–6Ræ–çfö–6Ræ–çfö–6TçVÖ&W"À¢Fö7VÖVçDFFS¢–çfö–6Ræ–çfö–6Ræ–çfö–6TFFRÀ¢Ò“°¢W‡V7B„¥4ôâç'6R‡–ÆöD§6öâóòw·Òr’’çFôÖF6„ö&¦V7B‡°¢G&äGFÇ3¢²&Vu&Wc¢târÒÀ¢Fö4GFÇ3¢²æó¢–çfö–6Ræ–çfö–6Ræ–çfö–6TçVÖ&W"ÒÀ¢Ò“° ¢6öç7B6æ6VÆÆVBÒv—BWF†VDöâ‡&÷f–FW$Â÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒö6æ6VÂÖ—'À¢÷&væ—6F–öä–BÀ¢–ÆöC¢²&V6öä6öFS¢s"rÂ&VÖ&³¢tFFVçG'’6÷'&V7F–öârÒÀ¢Ò“°¢W‡V7B†6æ6VÆÆVBç7FGW46öFRÂ6æ6VÆÆVBæ&öG’’çFô&Rƒ#“°¢W‡V7B†6æ6VÆÆVBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6R’çFôÖF6„ö&¦V7B‡°¢—'&÷f–FW%7FFS¢v6æ6VÆÆVBrÀ¢—'6æ6VÆÆVDC¢s##bÓ‚Ó%C“£3£ã¢rÀ¢—'6æ6VÆÆVDEFW‡C¢s"ó‚ó##bS££rÀ¢—'6æ6VÅ&V6öä6öFS¢s"rÀ¢—'6æ6VÅ&VÖ&³¢tFFVçG'’6÷'&V7F–öârÀ¢Ò“°¢W‡V7B†6æ6VÄ–çfö–6U&÷f–FW"’çFô†fT&VVä6ÆÆVEv—F‚‡°¢w7F–ã¢õ$uôu5D”âÀ¢—&ã¢Wf–FVæ6Ræ—&âÀ¢&V6öä6öFS¢s"rÀ¢&VÖ&³¢tFFVçG'’6÷'&V7F–öârÀ¢Ò“° ¢6öç7B÷W&F–öç2Òv—BFÖ–ãÀ¢²÷W&F–öã¢7G&–æs²7FGW3¢7G&–æs²&÷f–FW#¢7G&–ærÕµĞ¢æ ¢6VÆV7B÷W&F–öâÂ7FGW2Â&÷f–FW ¢g&öÒ7FGWF÷'•÷&÷f–FW%ö÷W&F–öç0¢v†W&RF…ö–çfö–6Uö–BÒG¶–çfö–6Ræ–çfö–6Ræ–GĞ¢÷&FW"'’7F'FVEö@¢°¢W‡V7B†÷W&F–öç2’çFôWVÂ…°¢²÷W&F–öã¢w&Vv—7FW%ö—'rÂ7FGW3¢w7V66VVFVBrÂ&÷f–FW#¢wv†—FV&öö·2rÒÀ¢²÷W&F–öã¢v6æ6VÅö—'rÂ7FGW3¢w7V66VVFVBrÂ&÷f–FW#¢wv†—FV&öö·2rÒÀ¢Ò“°¢Ò“° ¢—B‚væWfW"&WVG2âVæ¶æ÷vâ&Vv—7G&F–öâ×WFF–öâæB&V6öæ6–ÆW2'’Æöö·WrÂ7–æ2‚’Óâ°¢&W6WE&÷f–FW$Öö6·2‚“°¢6öç7B–çfö–6RÒv—B7V&Ö—GFVDF—&V7D–çfö–6R‚wVæ¶æ÷vâ&W7VÇBr“°¢6öç7BWf–FVæ6RÒ—'Wf–FVæ6R‚v"r“°¢&Vv—7FW$–çfö–6U&÷f–FW"æÖö6µ&V¦V7FVEfÇVTöæ6R€¢æWr7FGWF÷'•&÷f–FW$W'&÷"‚ut„•DT$ôôµ5ôÕUDD”ôåõTä´äõtârÂwVæ¶æ÷vârÂçVÆÂÂS2’À¢“°¢f–æD–çfö–6U&÷f–FW"æÖö6µ&W6öÇfVEfÇVTöæ6R†çVÆÂ’æÖö6µ&W6öÇfVEfÇVTöæ6R†Wf–FVæ6R“° ¢6öç7BVæ6W'F–âÒv—BWF†VDöâ‡&÷f–FW$Â÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&Vv—7FW"Ö—'À¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡Væ6W'F–âç7FGW46öFRÂVæ6W'F–âæ&öG’’çFô&Rƒ#"“°¢W‡V7B‡Væ6W'F–âæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6Ræ—'&÷f–FW%7FFR’çFô&R€¢w&Vv—7G&F–öå÷Væ¶æ÷vârÀ¢“° ¢6öç7B&V6öæ6–ÆVBÒv—BWF†VDöâ‡&÷f–FW$Â÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&Vv—7FW"Ö—'À¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡&V6öæ6–ÆVBç7FGW46öFRÂ&V6öæ6–ÆVBæ&öG’’çFô&Rƒ#“°¢W‡V7B‡&V6öæ6–ÆVBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6R’çFôÖF6„ö&¦V7B‡°¢—&ã¢Wf–FVæ6Ræ—&âÀ¢—'&÷f–FW%7FFS¢w&Vv—7FW&VBrÀ¢Ò“°¢W‡V7B‡&Vv—7FW$–çfö–6U&÷f–FW"’çFô†fT&VVä6ÆÆVEF–ÖW2ƒ“°¢W‡V7B†f–æD–çfö–6U&÷f–FW"’çFô†fT&VVä6ÆÆVEF–ÖW2ƒ"“° ¢6öç7B÷W&F–öç2Òv—BFÖ–ãÇ²÷W&F–öã¢7G&–æs²7FGW3¢7G&–ærÕµÓæ ¢6VÆV7B÷W&F–öâÂ7FGW2g&öÒ7FGWF÷'•÷&÷f–FW%ö÷W&F–öç0¢v†W&RF…ö–çfö–6Uö–BÒG¶–çfö–6Ræ–çfö–6Ræ–GĞ¢÷&FW"'’7F'FVEö@¢°¢W‡V7B†÷W&F–öç2’çFôWVÂ…°¢²÷W&F–öã¢w&Vv—7FW%ö—'rÂ7FGW3¢wVæ¶æ÷vârÒÀ¢²÷W&F–öã¢w&V6öæ6–ÆUö—'rÂ7FGW3¢w7V66VVFVBrÒÀ¢Ò“°¢Ò“° ¢—B‚w6W&–Æ—6W26öæ7W'&VçB&Vv—7G&F–öâ6òF†R&÷f–FW"×WFF–öâ—26VçBöæ6RrÂ7–æ2‚’Óâ°¢&W6WE&÷f–FW$Öö6·2‚“°¢6öç7B–çfö–6RÒv—B7V&Ö—GFVDF—&V7D–çfö–6R‚w6–ævÆRfÆ–v‡Br“°¢6öç7BWf–FVæ6RÒ—'Wf–FVæ6R‚v2r“°¢ÆWB&VÆV6U&÷f–FW"¢‡fÇVS¢G—VöbWf–FVæ6R’Óâfö–C°¢&Vv—7FW$–çfö–6U&÷f–FW"æÖö6µ&WGW&åfÇVTöæ6R€¢æWr&öÖ—6R‚‡&W6öÇfR’Óâ°¢&VÆV6U&÷f–FW"Ò&W6öÇfS°¢Ò’À¢“° ¢6öç7Bf—'7BÒWF†VDöâ‡&÷f–FW$Â÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&Vv—7FW"Ö—'À¢÷&væ—6F–öä–BÀ¢Ò“°¢v—Bf’çv—Df÷"‚‚’ÓâW‡V7B‡&Vv—7FW$–çfö–6U&÷f–FW"’çFô†fT&VVä6ÆÆVEF–ÖW2ƒ’“°¢6öç7B6V6öæBÒv—BWF†VDöâ‡&÷f–FW$Â÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&Vv—7FW"Ö—'À¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡6V6öæBç7FGW46öFRÂ6V6öæBæ&öG’’çFô&RƒC’“°¢W‡V7B‡6V6öæBæ§6öãÇ²6öFS¢7G&–ærÓâ‚’æ6öFR’çFô&R€¢u5DEUDõ%•ôõU$D”ôåô”åõ$ôu$U52rÀ¢“° ¢&VÆV6U&÷f–FW"†Wf–FVæ6R“°¢6öç7B6ö×ÆWFVBÒv—Bf—'7C°¢W‡V7B†6ö×ÆWFVBç7FGW46öFRÂ6ö×ÆWFVBæ&öG’’çFô&Rƒ#“°¢W‡V7B‡&Vv—7FW$–çfö–6U&÷f–FW"’çFô†fT&VVä6ÆÆVEF–ÖW2ƒ“°¢Ò“° ¢—B‚vFöW2æ÷B6öÖÖ—B&÷f–FW"Wf–FVæ6RgFW"—77VRWF†÷&—G’—2&Wfö¶VBrÂ7–æ2‚’Óâ°¢&W6WE&÷f–FW$Öö6·2‚“°¢6öç7B–çfö–6RÒv—B7V&Ö—GFVDF—&V7D–çfö–6R‚w&Wfö¶VBWF†÷&—G’r“°¢6öç7BWf–FVæ6RÒ—'Wf–FVæ6R‚vBr“°¢ÆWB&VÆV6U&÷f–FW"¢‡fÇVS¢G—VöbWf–FVæ6R’Óâfö–C°¢&Vv—7FW$–çfö–6U&÷f–FW"æÖö6µ&WGW&åfÇVTöæ6R€¢æWr&öÖ—6R‚‡&W6öÇfR’Óâ°¢&VÆV6U&÷f–FW"Ò&W6öÇfS°¢Ò’À¢“° ¢6öç7B&WVW7BÒWF†VDöâ‡&÷f–FW$Â÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&Vv—7FW"Ö—'À¢÷&væ—6F–öä–BÀ¢Ò“°¢v—Bf’çv—Df÷"‚‚’ÓâW‡V7B‡&Vv—7FW$–çfö–6U&÷f–FW"’çFô†fT&VVä6ÆÆVEF–ÖW2ƒ’“°¢v—BFÖ–æ ¢WFFR÷&væ—6F–öåöÖVÖ&W'6†—26WB6åö—77VUöFö7VÖVçG2ÒfÇ6P¢v†W&R÷&væ—6F–öåö–BÒG¶÷&væ—6F–öä–GÒæBW6W%ö–BÒG¶÷væW%W6W$–GĞ¢°¢&VÆV6U&÷f–FW"†Wf–FVæ6R“°¢6öç7BFVæ–VBÒv—B&WVW7C°¢W‡V7B†FVæ–VBç7FGW46öFRÂFVæ–VBæ&öG’’çFô&RƒC2“°¢W‡V7B†FVæ–VBæ§6öãÇ²6öFS¢7G&–ærÓâ‚’æ6öFR’çFô&R‚tUD„õ$•E•õ$UT•$TBr“° ¢6öç7B·&W&VEÒÒv—BFÖ–ãÀ¢²—'÷&÷f–FW%÷7FFS¢7G&–æs²—&ã¢7G&–ærÂçVÆÃ²÷W&F–öå÷7FGW3¢7G&–ærÕµĞ¢æ ¢6VÆV7B’æ—'÷&÷f–FW%÷7FFRÂ’æ—&âÂòç7FGW22÷W&F–öå÷7FGW0¢g&öÒF…ö–çfö–6W2¢¦ö–â7FGWF÷'•÷&÷f–FW%ö÷W&F–öç2òöâòçF…ö–çfö–6Uö–BÒ’æ–@¢v†W&R’æ–BÒG¶–çfö–6Ræ–çfö–6Ræ–GĞ¢°¢W‡V7B‡&W&VB’çFôWVÂ‡°¢—'÷&÷f–FW%÷7FFS¢w&Vv—7FW&–ærrÀ¢—&ã¢çVÆÂÀ¢÷W&F–öå÷7FGW3¢wVæF–ærrÀ¢Ò“° ¢v—BFÖ–æ ¢WFFR÷&væ—6F–öåöÖVÖ&W'6†—26WB6åö—77VUöFö7VÖVçG2ÒG'VP¢v†W&R÷&væ—6F–öåö–BÒG¶÷&væ—6F–öä–GÒæBW6W%ö–BÒG¶÷væW%W6W$–GĞ¢°¢v—BW‡—&UVæF–æu&÷f–FW$÷W&F–öâ†–çfö–6Ræ–çfö–6Ræ–B“°¢6öç7B&V6÷fW&VBÒv—BWF†VDöâ‡&÷f–FW$Â÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&V6÷fW"×&÷f–FW"Ö÷W&F–öæÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡&V6÷fW&VBç7FGW46öFRÂ&V6÷fW&VBæ&öG’’çFô&Rƒ#"“°¢W‡V7B‡&V6÷fW&VBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6R’çFôÖF6„ö&¦V7B‡°¢—&ã¢çVÆÂÀ¢—'&÷f–FW%7FFS¢w&Vv—7G&F–öå÷Væ¶æ÷vârÀ¢Ò“°¢6öç7B¶÷W&F–öåÒÒv—BFÖ–ãÇ²7FGW3¢7G&–æs²&÷f–FW%ö6öFS¢7G&–ærÂçVÆÂÕµÓæ ¢6VÆV7B7FGW2Â&÷f–FW%ö6öFRg&öÒ7FGWF÷'•÷&÷f–FW%ö÷W&F–öç0¢v†W&RF…ö–çfö–6Uö–BÒG¶–çfö–6Ræ–çfö–6Ræ–GĞ¢°¢W‡V7B†÷W&F–öâ’çFôWVÂ‡°¢7FGW3¢wVæ¶æ÷vârÀ¢&÷f–FW%ö6öFS¢tõU$D”ôåôÄT4UôU…•$TBrÀ¢Ò“°¢Ò“° ¢—B‚vFöW2æ÷B6öÖÖ—B&÷f–FW"Wf–FVæ6RgFW"76–væVBv÷&²66W72—2&Wfö¶VBrÂ7–æ2‚’Óâ°¢&W6WE&÷f–FW$Öö6·2‚“°¢6öç7BÖ"Òv—Bf–æÆ—¦VDÖ"‚s##bÓ2ÓrÂsr“°¢6öç7B7&VFVBÒv—B7&VFT–çfö–6R†Ö"æ–BÂ²–çfö–6TFFS¢s##bÓ2ÓrÒ“°¢W‡V7B†7&VFVBç7FGW46öFRÂ7&VFVBæ&öG’’çFô&Rƒ#“°¢6öç7B7V&Ö—GFVBÒv—B7V&Ö—D–çfö–6R€¢7&VFVBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6Ræ–BÀ¢“°¢W‡V7B‡7V&Ö—GFVBç7FGW46öFRÂ7V&Ö—GFVBæ&öG’’çFô&Rƒ#“°¢6öç7B–çfö–6RÒ7V&Ö—GFVBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚“°¢6öç7B¶6ÆW&µW6W%ÒÒv—BFÖ–ãÇ²–C¢7G&–ærÕµÓæ ¢6VÆV7B&–B"g&öÒWF…÷W6W'2v†W&R&VÖ–Â"ÒG¶6ÆW&´VÖ–ÇĞ¢°¢–b‚6ÆW&µW6W"’F‡&÷ræWrW'&÷"‚v6ÆW&²W6W"Ö—76–ærr“°¢v—BFÖ–æ ¢WFFR÷&væ—6F–öåöÖVÖ&W'6†—0¢6WBv÷&µ÷66÷RÒv76–væVBrÂ6åö—77VUöFö7VÖVçG2ÒG'VP¢v†W&R÷&væ—6F–öåö–BÒG¶÷&væ—6F–öä–GÒæBW6W%ö–BÒG¶6ÆW&µW6W"æ–GĞ¢°¢v—BFÖ–æ ¢–ç6W'B–çFòv÷&µö76–væÖVçG2€¢÷&væ—6F–öåö–BÂv÷&µö–BÂW6W%ö–BÂ7&VFVEö'•÷W6W%ö–@¢’fÇVW2‚G¶÷&væ—6F–öä–GÒÂG·v÷&´–GÒÂG¶6ÆW&µW6W"æ–GÒÂG¶÷væW%W6W$–GÒ¢° ¢6öç7BWf–FVæ6RÒ—'Wf–FVæ6R‚vRr“°¢ÆWB&VÆV6U&÷f–FW"¢‡fÇVS¢G—VöbWf–FVæ6R’Óâfö–C°¢&Vv—7FW$–çfö–6U&÷f–FW"æÖö6µ&WGW&åfÇVTöæ6R€¢æWr&öÖ—6R‚‡&W6öÇfR’Óâ°¢&VÆV6U&÷f–FW"Ò&W6öÇfS°¢Ò’À¢“°¢6öç7B&WVW7BÒWF†VDöâ‡&÷f–FW$Â6ÆW&²Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&Vv—7FW"Ö—'À¢÷&væ—6F–öä–BÀ¢Ò“°¢v—Bf’çv—Df÷"‚‚’ÓâW‡V7B‡&Vv—7FW$–çfö–6U&÷f–FW"’çFô†fT&VVä6ÆÆVEF–ÖW2ƒ’“°¢v—BFÖ–æ ¢FVÆWFRg&öÒv÷&µö76–væÖVçG0¢v†W&R÷&væ—6F–öåö–BÒG¶÷&væ—6F–öä–GĞ¢æBv÷&µö–BÒG·v÷&´–GÒæBW6W%ö–BÒG¶6ÆW&µW6W"æ–GĞ¢°¢&VÆV6U&÷f–FW"†Wf–FVæ6R“°¢6öç7B†–FFVâÒv—B&WVW7C°¢W‡V7B††–FFVâç7FGW46öFRÂ†–FFVâæ&öG’’çFô&RƒCB“°¢W‡V7B††–FFVâæ§6öãÇ²6öFS¢7G&–ærÓâ‚’æ6öFR’çFô&R‚utõ$µôäõEôdõTäBr“° ¢6öç7B·&W&VEÒÒv—BFÖ–ãÀ¢²—'÷&÷f–FW%÷7FFS¢7G&–æs²—&ã¢7G&–ærÂçVÆÂÕµĞ¢æ ¢6VÆV7B—'÷&÷f–FW%÷7FFRÂ—&âg&öÒF…ö–çfö–6W0¢v†W&R–BÒG¶–çfö–6Ræ–çfö–6Ræ–GĞ¢°¢W‡V7B‡&W&VB’çFôWVÂ‡²—'÷&÷f–FW%÷7FFS¢w&Vv—7FW&–ærrÂ—&ã¢çVÆÂÒ“° ¢v—BFÖ–æ ¢–ç6W'B–çFòv÷&µö76–væÖVçG2€¢÷&væ—6F–öåö–BÂv÷&µö–BÂW6W%ö–BÂ7&VFVEö'•÷W6W%ö–@¢’fÇVW2‚G¶÷&væ—6F–öä–GÒÂG·v÷&´–GÒÂG¶6ÆW&µW6W"æ–GÒÂG¶÷væW%W6W$–GÒ¢°¢v—BW‡—&UVæF–æu&÷f–FW$÷W&F–öâ†–çfö–6Ræ–çfö–6Ræ–B“°¢6öç7B&V6÷fW&VBÒv—BWF†VDöâ‡&÷f–FW$Â6ÆW&²Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6Ræ–çfö–6Ræ–GÒ÷&V6÷fW"×&÷f–FW"Ö÷W&F–öæÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡&V6÷fW&VBç7FGW46öFRÂ&V6÷fW&VBæ&öG’’çFô&Rƒ#"“°¢W‡V7B‡&V6÷fW&VBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6Ræ—'&÷f–FW%7FFR’çFô&R€¢w&Vv—7G&F–öå÷Væ¶æ÷vârÀ¢“° ¢v—BFÖ–æ ¢FVÆWFRg&öÒv÷&µö76–væÖVçG0¢v†W&R÷&væ—6F–öåö–BÒG¶÷&væ—6F–öä–GĞ¢æBv÷&µö–BÒG·v÷&´–GÒæBW6W%ö–BÒG¶6ÆW&µW6W"æ–GĞ¢°¢v—BFÖ–æ ¢WFFR÷&væ—6F–öåöÖVÖ&W'6†—0¢6WBv÷&µ÷66÷RÒvÆÂrÂ6åö—77VUöFö7VÖVçG2ÒfÇ6P¢v†W&R÷&væ—6F–öåö–BÒG¶÷&væ—6F–öä–GÒæBW6W%ö–BÒG¶6ÆW&µW6W"æ–GĞ¢°¢Ò“°§Ò“° ¢ò¢F†R÷væW"w2Æ—fR6W&–W2Â6ö×÷6VBF†Rv’F†V—"–çfö–6W2&S¢ÂF†P¢¢&–ÆæWBF—f—6–öâ6öFRÆW72—G2G&–Æ–ær¦W&òÂF†Rf–ææ6–Â–V"Âæ@¢¢F‡&VRÖF–v—B6W&–Ââæ÷F†–ær&÷WB—B—2†&BÖ6öFVB(	B—B—2öæP¢¢6öæf–wW&F–öâöbF†R6W&–W2fVGW&Râ¢ğ¦FW67&–&R‚vF—f—6–öâÖFW&—fVBçVÖ&W"6W&–W2rÂ‚’Óâ°¢—B‚v6ö×÷6W2ÆF—cãÆg“ãÇ6Wâg&öÒF†R'W–W.(	—2F—f—6–öâ6öFRrÂ7–æ2‚’Óâ°¢6öç7BF—f—6–öä'W–W$–BÒ&æFöÕUT”B‚“°¢v—BFÖ–æ ¢–ç6W'B–çFò6öçF7G2€¢–BÂ÷&væ—6F–öåö–BÂFW6–væF–öâÂFG&W72Âw7F–âÂ–æ6öFRÀ¢7FFUö6öFRÂÆö6Æ—G’ÂF—f—6–öåö6öFRÂ—5ö6öç6–væVRÂ7F—fRÀ¢7&VFVEö'•÷W6W%ö–@¢¢fÇVW2€¢G¶F—f—6–öä'W–W$–GÒÂG¶÷&væ—6F–öä–GÒÂu7"âE5DR×VÖ&’55BrÀ¢G´%U”U%ôDE$U57ÒÂG´%U”U%ôu5D”çÒÂsSRrÂsrrÂtæWrFVÆ†’rÂsrÀ¢G'VRÂG'VRÀ¢G¶÷væW%W6W$–GĞ¢¢°¢6öç7B6W&–W2Òv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uUBrÀ¢W&Ã¢rö’ö÷&væ—6F–öâöçVÖ&W"×6W&–W2÷F…ö–çfö–6RrÀ¢÷&væ—6F–öä–BÀ¢–ÆöC¢²FV×ÆFS¢u´D•g×´e“'×µ4U£7ÒrÒÀ¢Ò“°¢W‡V7B‡6W&–W2ç7FGW46öFRÂ6W&–W2æ&öG’’çFô&Rƒ#“° ¢6öç7B7&VFVBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢rö’÷F‚Ö–çfö–6W2rÀ¢÷&væ—6F–öä–BÀ¢–ÆöC¢°¢–çfö–6TFFS¢s##bÓÓ#rÀ¢646öFS¢s““ƒs3BrÀ¢6W'f–6TFW67&—F–öã¢u&÷f—6–öâöb76VævW"ÖVæ—G’6W'f–6W2ârÀ¢w7E&FS¢s‚rÀ¢Æ6Töe7WÇ“¢srrÀ¢&WfW'6T6†&vTÆ–6&ÆS¢fÇ6RÀ¢'W–W$6öçF7D–C¢F—f—6–öä'W–W$–BÀ¢F†&ÆUfÇVS¢sãrÀ¢ÒÀ¢Ò“°¢W‡V7B†7&VFVBç7FGW46öFRÂ7&VFVBæ&öG’’çFô&Rƒ#“°¢6öç7B7V&Ö—GFVBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶7&VFVBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6Ræ–GÒ÷7V&Ö—FÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡7V&Ö—GFVBç7FGW46öFRÂ7V&Ö—GFVBæ&öG’’çFô&Rƒ#“°¢òòF—f—6–öâÓâÂf–ææ6–Â–V"##RÓ#bÓâ#Rà¢W‡V7B‡7V&Ö—GFVBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6Ræ–çfö–6TçVÖ&W"’çFôÖF6‚€¢õå#UÆG³7ÒBòÀ¢“°¢Ò“° ¢—B‚w&VgW6W2FòÖ–çBçVÖ&W"v—F‚†öÆRv†W&RF†RF—f—6–öâ6†÷VÆB&RrÂ7–æ2‚’Óâ°¢òòF†R'W–W"6VVFVBf÷"F†R&W7BöbF†—27V—FR†2æòF—f—6–öâ6öFRÀ¢òò6ò´D•gÒ6ææ÷B&Rf–ÆÆVBâ†ÆbçVÖ&W"öâÆVvÂFö7VÖVçB—0¢òòv÷'6RF†âæöæRà¢6öç7B7&VFVBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢rö’÷F‚Ö–çfö–6W2rÀ¢÷&væ—6F–öä–BÀ¢–ÆöC¢°¢–çfö–6TFFS¢s##bÓÓ#rÀ¢646öFS¢s““ƒs3BrÀ¢6W'f–6TFW67&—F–öã¢u7WÇ’f÷"7W7FöÖW"v—F‚æòF—f—6–öâârÀ¢w7E&FS¢s‚rÀ¢Æ6Töe7WÇ“¢srrÀ¢&WfW'6T6†&vTÆ–6&ÆS¢fÇ6RÀ¢'W–W$6öçF7D–BÀ¢F†&ÆUfÇVS¢sãrÀ¢ÒÀ¢Ò“°¢W‡V7B†7&VFVBç7FGW46öFRÂ7&VFVBæ&öG’’çFô&Rƒ#“°¢6öç7B7V&Ö—GFVBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷F‚Ö–çfö–6W2òG¶7&VFVBæ§6öãÅF„–çfö–6TFWF–Å&W7öç6Sâ‚’æ–çfö–6Ræ–GÒ÷7V&Ö—FÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡7V&Ö—GFVBç7FGW46öFR’çFô&RƒC“°¢W‡V7B‡7V&Ö—GFVBæ§6öãÇ²6öFS¢7G&–ærÓâ‚’æ6öFR’çFô&R‚t”ådô”4UôåTÔ$U%õTäd”ÄÄ$ÄRr“°¢Ò“°§Ò“° 