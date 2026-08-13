import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  CreditNoteDetailResponse,
  MeasurementBookDetailResponse,
  TaxInvoiceDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import type { StatutoryProvider } from '../src/gsp/statutory-provider.js';

/**
 * Finding 5's residue (migration 0051): the 24-hour IRN cancellation
 * window and the Section 34 credit note. What has to hold:
 *
 * - stage 1 window honesty: the closing instant is exposed, a cancel
 *   past it is refused BEFORE any provider operation opens and the
 *   refusal names the credit-note remedy; legacy-manual rows are
 *   treated window-CLOSED, never unknown-open;
 * - issuing a credit note copies the invoice's frozen money in full
 *   (database-proven), supersedes the invoice in the same transaction,
 *   and releases its Measurement Book for a corrected invoice;
 * - credit-note numbering is gap-free per organisation per financial
 *   year (the finding-8 posture);
 * - one live credit note per invoice, with the database as arbiter;
 * - local cancel of the note revives the invoice ONLY while the MB has
 *   not been re-invoiced — both arms proven;
 * - the 0049 applicability/window gates bind the CRN transport
 *   identically, and the provider ledger is single-flight for
 *   register_crn;
 * - raw-SQL negatives hold against the new triggers and the invoice
 *   guard's new transitions.
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
const ownerEmail = `cn-owner-${runId}@integration.test`;
const secondOwnerEmail = `cn-second-${runId}@integration.test`;
const password = `integration-password-${runId}`;
const workCode = `CNW${runId.slice(0, 4).toUpperCase()}`;

const ORG_GSTIN = '07ABCDE1234F1Z5';
const ORG_ADDRESS = 'Plot 12, Industrial Area, New Delhi, 110002';
const BUYER_GSTIN = '07AAAGM0289C1ZL';
const BUYER_ADDRESS = 'DRM Office, State Entry Road, New Delhi, 110055';
const SAC = '995421';

let admin: Sql;
let app: FastifyInstance;
let providerApp: FastifyInstance;
let storageDir: string;
let organisationId: string;
/** Second organisation whose e-invoicing declaration stays UNDECLARED —
 * the 0049 gate proof for the CRN transport. */
let undeclaredOrganisationId: string;
let ownerUserId: string;
let workId: string;
let itemId: string;
let buyerContactId: string;
let undeclaredBuyerContactId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let secondOwner: CookieJar;

const registerInvoiceProvider = vi.fn<StatutoryProvider['registerInvoice']>();
const findInvoiceProvider = vi.fn<StatutoryProvider['findInvoiceByDocument']>();
const cancelInvoiceProvider = vi.fn<StatutoryProvider['cancelInvoice']>();
const STUB_PORTAL = 'NIC1 via apisandbox.whitebooks.in';
const providerStub: StatutoryProvider = {
  name: 'whitebooks',
  portal: STUB_PORTAL,
  environment: 'sandbox',
  registerInvoice: registerInvoiceProvider,
  findInvoiceByDocument: findInvoiceProvider,
  cancelInvoice: cancelInvoiceProvider,
  generateEwayBillByIrn: vi.fn(),
  findEwayBillByIrn: vi.fn(),
  cancelEwayBill: vi.fn(),
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

async function authed(
  jar: CookieJar,
  options: InjectOptions & { organisationId?: string },
) {
  return authedOn(app, jar, options);
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
    payload: { sources: [{ sourceType: 'delivery_challan', sourceId: challanId }] },
  });
  expect(sources.statusCode, sources.body).toBe(200);
  const finalized = await authed(owner, {
    method: 'POST',
    url: `/api/measurement-books/${mbId}/finalize`,
    organisationId,
  });
  expect(finalized.statusCode, finalized.body).toBe(200);
  const book = finalized.json<MeasurementBookDetailResponse>().book;
  return { id: mbId, number: book.mbNumber ?? '', total: book.totalAmount ?? '' };
}

async function submittedMbInvoice(
  mbId: string,
  invoiceDate: string,
): Promise<TaxInvoiceDetailResponse> {
  const created = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/tax-invoices`,
    organisationId,
    payload: {
      measurementBookId: mbId,
      invoiceDate,
      sacCode: SAC,
      serviceDescription: 'Works contract services for signalling installation',
      gstRate: '18',
      placeOfSupply: '07',
      reverseChargeApplicable: false,
      buyerContactId,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const submitted = await authed(owner, {
    method: 'POST',
    url: `/api/tax-invoices/${created.json<TaxInvoiceDetailResponse>().invoice.id}/submit`,
    organisationId,
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  return submitted.json<TaxInvoiceDetailResponse>();
}

async function submittedDirectInvoice(
  suffix: string,
  invoiceDate = '2026-06-15',
): Promise<TaxInvoiceDetailResponse> {
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/tax-invoices',
    organisationId,
    payload: {
      invoiceDate,
      sacCode: '998734',
      serviceDescription: `Credit note direct probe ${suffix}.`,
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
  return submitted.json<TaxInvoiceDetailResponse>();
}

async function draftCreditNote(
  invoiceId: string,
  noteDate: string,
  reason = 'Wrong particulars discovered after the IRP window closed.',
  jar: CookieJar = owner,
  org = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/tax-invoices/${invoiceId}/credit-notes`,
    organisationId: org,
    payload: { noteDate, reason },
  });
}

async function issuedCreditNote(
  invoiceId: string,
  noteDate: string,
  org = organisationId,
  jar: CookieJar = owner,
): Promise<CreditNoteDetailResponse> {
  const created = await authed(jar, {
    method: 'POST',
    url: `/api/tax-invoices/${invoiceId}/credit-notes`,
    organisationId: org,
    payload: {
      noteDate,
      reason: 'Wrong particulars discovered after the IRP window closed.',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const issued = await authed(jar, {
    method: 'POST',
    url: `/api/credit-notes/${created.json<CreditNoteDetailResponse>().creditNote.id}/issue`,
    organisationId: org,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  return issued.json<CreditNoteDetailResponse>();
}

/** DD/MM/YYYY HH:mm:ss in IST (UTC+05:30), the NIC portal's text form. */
function istText(instant: Date): string {
  const ist = new Date(instant.getTime() + (5 * 60 + 30) * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${pad(ist.getUTCDate())}/${pad(ist.getUTCMonth() + 1)}/${ist.getUTCFullYear()} ` +
    `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`
  );
}

function irpEvidence(seed: string, ackDate: string) {
  return {
    irn: seed.repeat(64).slice(0, 64),
    ackNumber: '900719925474099312345',
    // The real adapter derives ackDate by parsing the portal's IST text
    // (whitebooks.ts), so the two forms always describe one instant.
    // Deriving the text here keeps the stub honest and avoids the frozen
    // literal that time-bombed tax-invoices.integration.test.ts.
    ackDateText: istText(new Date(ackDate)),
    ackDate,
    signedQr: `signed-qr-${seed}`,
    signedInvoice: `signed-invoice-${seed}`,
    rawResponse: `{"status_cd":"1","seed":"${seed}"}`,
    // The stub replaces the adapter, so it bypasses the local IRN and
    // signed-QR verification the real one runs (audit finding 2; proved in
    // whitebooks.test.ts). The portal must still be present: the operation
    // ledger records which portal answered.
    portal: STUB_PORTAL,
  };
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

async function patchProfile(
  payload: Record<string, unknown>,
  jar = owner,
  org?: string,
) {
  const response = await authed(jar, {
    method: 'PATCH',
    url: '/api/organisation/profile',
    organisationId: org ?? organisationId,
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-cn-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the credit note integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-cn-objects-'));
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

  owner = await signUp(ownerEmail, 'CN Owner');
  secondOwner = await signUp(secondOwnerEmail, 'CN Second Owner');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'CN Constructions', slug: `cn-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const second = await authedOn(app, secondOwner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'CN Undeclared', slug: `cn-und-${runId}` },
  });
  expect(second.statusCode, second.body).toBe(201);
  undeclaredOrganisationId = second.json<{ id: string }>().id;

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
    where user_id = ${ownerUserId}
  `;
  const [secondUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${secondOwnerEmail}
  `;
  if (!secondUser) throw new Error('second owner user missing');
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true,
        -- Migration 0061: the statutory provider routes now demand the
        -- dedicated compliance authority ON TOP of issue/cancel. Without
        -- this grant every IRP/NIC case in this file 403s, which is
        -- exactly the proof that the new gate binds.
        can_manage_statutory_reporting = true
    where user_id = ${secondUser.id}
  `;

  // Organisation 1: declared applicable, no reporting window; profile
  // complete so submit and the IRP payload are reachable.
  await patchProfile({
    stateCode: '07',
    gstin: ORG_GSTIN,
    address: ORG_ADDRESS,
    pincode: '110002',
    locality: 'New Delhi',
    invoiceNumberPrefix: 'P10',
    einvoiceApplicability: 'applicable',
    einvoiceApplicableFrom: '2017-07-01',
  });
  // Organisation 2 stays UNDECLARED deliberately; only its profile is
  // completed so a direct invoice can be submitted.
  await patchProfile(
    {
      stateCode: '07',
      gstin: '07FGHIJ5678K1Z3',
      address: ORG_ADDRESS,
      pincode: '110002',
      locality: 'New Delhi',
    },
    secondOwner,
    undeclaredOrganisationId,
  );

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
      '2025-06-01', 'Credit note fixture work', '10000000.00', '9000000.00',
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
      'Signalling cable', 'mtr', 100000.000, 250.00
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
  undeclaredBuyerContactId = randomUUID();
  await admin`
    insert into contacts (
      id, organisation_id, designation, contact_person, address, gstin,
      pincode, state_code, locality, is_consignee, active, created_by_user_id
    )
    values
      (${buyerContactId}, ${organisationId}, 'Sr. DEE (G) NR', 'S K Verma',
       ${BUYER_ADDRESS}, ${BUYER_GSTIN}, '110055', '07', 'New Delhi', true, true,
       ${ownerUserId}),
      (${undeclaredBuyerContactId}, ${undeclaredOrganisationId}, 'Private Client',
       null, ${BUYER_ADDRESS}, ${BUYER_GSTIN}, '110055', '07', 'New Delhi', true,
       true, ${ownerUserId})
  `;
}, 120_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId, undeclaredOrganisationId]);
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

describe('stage 1: the 24-hour IRN cancellation window', () => {
  it('exposes the closing instant and refuses a late cancel, naming the credit-note remedy', async () => {
    registerInvoiceProvider.mockReset();
    cancelInvoiceProvider.mockReset();
    const invoice = await submittedDirectInvoice('window closed');
    registerInvoiceProvider.mockResolvedValueOnce(irpEvidence('a', hoursAgo(72)));
    const registered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const detail = registered.json<TaxInvoiceDetailResponse>().invoice;
    expect(detail.irpCancelWindowOpen).toBe(false);
    expect(detail.irpCancelWindowClosesAt).not.toBeNull();
    expect(new Date(detail.irpCancelWindowClosesAt ?? '').getTime()).toBeLessThan(
      Date.now(),
    );

    // Refused BEFORE any provider operation opens, with the remedy named.
    const cancel = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/cancel-irp`,
      organisationId,
      payload: { reasonCode: '2', remark: 'Entered against the wrong contract.' },
    });
    expect(cancel.statusCode, cancel.body).toBe(409);
    const refusal = cancel.json<{ code: string; message: string }>();
    expect(refusal.code).toBe('IRP_CANCEL_WINDOW_CLOSED');
    expect(refusal.message).toContain('credit note');
    expect(cancelInvoiceProvider).not.toHaveBeenCalled();
    const [operations] = await admin<{ count: number }[]>`
      select count(*)::int as count from statutory_provider_operations
      where tax_invoice_id = ${invoice.invoice.id} and operation = 'cancel_irp'
    `;
    expect(operations?.count).toBe(0);

    // The local cancel names the same remedy.
    const localCancel = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/cancel`,
      organisationId,
      payload: { note: 'Trying to cancel a walled-in invoice.' },
    });
    expect(localCancel.statusCode).toBe(409);
    const localRefusal = localCancel.json<{ code: string; message: string }>();
    expect(localRefusal.code).toBe('IRP_CANCELLATION_REQUIRED');
    expect(localRefusal.message).toContain('credit note');
  });

  it('keeps the window open within 24 hours and lets the provider cancel proceed', async () => {
    registerInvoiceProvider.mockReset();
    cancelInvoiceProvider.mockReset();
    const invoice = await submittedDirectInvoice('window open');
    registerInvoiceProvider.mockResolvedValueOnce(irpEvidence('b', hoursAgo(1)));
    const registered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/register-irp`,
      organisationId,
    });
    expect(registered.statusCode, registered.body).toBe(200);
    expect(
      registered.json<TaxInvoiceDetailResponse>().invoice.irpCancelWindowOpen,
    ).toBe(true);
    const cancelledAt = new Date();
    cancelInvoiceProvider.mockResolvedValueOnce({
      cancelledAtText: istText(cancelledAt),
      cancelledAt: cancelledAt.toISOString(),
      rawResponse: `{"status_cd":"1","CancelDate":"${istText(cancelledAt)}"}`,
    });
    const cancel = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoice.invoice.id}/cancel-irp`,
      organisationId,
      payload: { reasonCode: '2', remark: 'Caught inside the window.' },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json<TaxInvoiceDetailResponse>().invoice.irpProviderState).toBe(
      'cancelled',
    );
  });

  it('treats legacy manual evidence with no provable ack instant as window-closed', async () => {
    // Since migration 0053 a legacy manual row stands in
    // registered_unverified — the pair manual + 'registered' is
    // constitutionally forbidden (tax_invoices_manual_unverified_shape),
    // and this insert is exactly what 0053's reclassification leaves
    // behind for pre-0053 legacy evidence.
    const legacyId = randomUUID();
    await admin`
      insert into tax_invoices (
        id, organisation_id, status, invoice_number, sequence_number,
        fy_label, invoice_date, sac_code, service_description, gst_rate,
        place_of_supply, reverse_charge_applicable, buyer_contact_id,
        buyer_snapshot, stated_taxable_value, taxable_value, cgst_amount,
        sgst_amount, igst_amount, round_off, total_amount, issued_snapshot,
        irn, irp_provider, irp_provider_state, irp_legacy_evidence_missing,
        submitted_at, submitted_by_user_id, created_by_user_id
      )
      values (
        ${legacyId}, ${organisationId}, 'submitted',
        ${`LEG/${runId}/1`}, 9001, '2025-26', '2025-06-01', '998734',
        'Legacy manual evidence row', '18.00', '07', false,
        ${buyerContactId}, ${admin.json({ name: 'Legacy buyer' })}, '1000.00',
        '1000.00', '90.00', '90.00', '0.00', '0.00', '1180.00',
        ${admin.json({ templateVersion: 'ti-v1' })},
        ${'f'.repeat(64)}, 'manual', 'registered_unverified', true,
        now(), ${ownerUserId}, ${ownerUserId}
      )
    `;
    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${legacyId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const invoice = detail.json<TaxInvoiceDetailResponse>().invoice;
    expect(invoice.irpLegacyEvidenceMissing).toBe(true);
    // No provable ack instant: closed, never unknown-open.
    expect(invoice.irpCancelWindowOpen).toBe(false);
    expect(invoice.irpCancelWindowClosesAt).toBeNull();
    const localCancel = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${legacyId}/cancel`,
      organisationId,
      payload: { note: 'Legacy row cancel attempt.' },
    });
    expect(localCancel.statusCode).toBe(409);
    expect(localCancel.json<{ code: string; message: string }>().message).toContain(
      'credit note',
    );
  });
});

describe('issue: full value, supersession, Measurement Book release', () => {
  let mbA: { id: string; number: string; total: string };
  let invoiceA: TaxInvoiceDetailResponse;
  let noteA: CreditNoteDetailResponse;

  it('drafts only against a submitted invoice and only with a sane date', async () => {
    mbA = await finalizedMb('2026-03-01', '100');
    const draftInvoice = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/tax-invoices`,
      organisationId,
      payload: {
        measurementBookId: mbA.id,
        invoiceDate: '2026-03-15',
        sacCode: SAC,
        serviceDescription: 'Works contract services for signalling installation',
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId,
      },
    });
    expect(draftInvoice.statusCode, draftInvoice.body).toBe(201);
    const draftInvoiceId = draftInvoice.json<TaxInvoiceDetailResponse>().invoice.id;

    const onDraft = await draftCreditNote(draftInvoiceId, '2026-04-01');
    expect(onDraft.statusCode).toBe(409);
    expect(onDraft.json<{ code: string }>().code).toBe('TAX_INVOICE_STATUS_CONFLICT');

    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${draftInvoiceId}/submit`,
      organisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    invoiceA = submitted.json<TaxInvoiceDetailResponse>();

    const early = await draftCreditNote(invoiceA.invoice.id, '2026-03-01');
    expect(early.statusCode).toBe(400);
    expect(early.json<{ code: string }>().code).toBe('CREDIT_NOTE_DATE_BEFORE_INVOICE');
    const future = await draftCreditNote(invoiceA.invoice.id, '2027-01-01');
    expect(future.statusCode).toBe(400);
    expect(future.json<{ code: string }>().code).toBe('CREDIT_NOTE_DATE_IN_FUTURE');
  });

  it('issues at full invoice value, supersedes the invoice, and frees the MB for a corrected invoice', async () => {
    const created = await draftCreditNote(invoiceA.invoice.id, '2026-04-02');
    expect(created.statusCode, created.body).toBe(201);
    const noteId = created.json<CreditNoteDetailResponse>().creditNote.id;

    // One live note per invoice — the friendly refusal.
    const secondDraft = await draftCreditNote(invoiceA.invoice.id, '2026-04-02');
    expect(secondDraft.statusCode).toBe(409);
    expect(secondDraft.json<{ code: string }>().code).toBe('CREDIT_NOTE_EXISTS');

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/credit-notes/${noteId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    noteA = issued.json<CreditNoteDetailResponse>();
    expect(noteA.creditNote.status).toBe('issued');
    // FY 2026-27 from the note date, under the default CN template.
    expect(noteA.creditNote.fyLabel).toBe('2026-27');
    expect(noteA.creditNote.noteNumber).toMatch(/^CN\/2026-27\/[0-9]{3}$/);
    // FULL VALUE: the money is the invoice's frozen money verbatim.
    expect(noteA.creditNote.taxableValue).toBe(invoiceA.invoice.taxableValue);
    expect(noteA.creditNote.cgstAmount).toBe(invoiceA.invoice.cgstAmount);
    expect(noteA.creditNote.sgstAmount).toBe(invoiceA.invoice.sgstAmount);
    expect(noteA.creditNote.igstAmount).toBe(invoiceA.invoice.igstAmount);
    expect(noteA.creditNote.roundOff).toBe(invoiceA.invoice.roundOff);
    expect(noteA.creditNote.totalAmount).toBe(invoiceA.invoice.totalAmount);
    // No reporting window declared: no deadline stamped.
    expect(noteA.creditNote.irpReportingDeadline).toBeNull();

    const invoiceAfter = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${invoiceA.invoice.id}`,
      organisationId,
    });
    expect(invoiceAfter.statusCode).toBe(200);
    expect(invoiceAfter.json<TaxInvoiceDetailResponse>().invoice.status).toBe(
      'superseded',
    );

    // The MB is released: a corrected invoice against the SAME MB both
    // drafts and submits (the recreated partial unique index no longer
    // sees the superseded invoice).
    const corrected = await submittedMbInvoice(mbA.id, '2026-04-05');
    expect(corrected.invoice.status).toBe('submitted');
    expect(corrected.invoice.measurementBookId).toBe(mbA.id);

    // Both arms of the revert rule, in sequence:
    // (a) with a successor on the MB, cancelling the note is refused —
    //     the superseded invoice cannot be revived.
    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/credit-notes/${noteA.creditNote.id}/cancel`,
      organisationId,
      payload: { note: 'Attempting to revive under a successor.' },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe('MEASUREMENT_BOOK_REINVOICED');

    // (b) once the successor is cancelled, the note cancels and the
    //     invoice reverts superseded -> submitted through the guarded
    //     trigger arm.
    const dropSuccessor = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${corrected.invoice.id}/cancel`,
      organisationId,
      payload: { note: 'Clearing the successor for the revert arm.' },
    });
    expect(dropSuccessor.statusCode, dropSuccessor.body).toBe(200);
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/credit-notes/${noteA.creditNote.id}/cancel`,
      organisationId,
      payload: { note: 'The credit note itself was raised in error.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<CreditNoteDetailResponse>().creditNote.status).toBe(
      'cancelled',
    );
    const revived = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${invoiceA.invoice.id}`,
      organisationId,
    });
    expect(revived.json<TaxInvoiceDetailResponse>().invoice.status).toBe('submitted');
  });

  it('numbers credit notes gap-free per financial year across two FYs', async () => {
    // Two more MB invoices dated in March 2026 (FY 2025-26).
    const mbB = await finalizedMb('2026-03-02', '10');
    const mbC = await finalizedMb('2026-03-03', '20');
    const invoiceB = await submittedMbInvoice(mbB.id, '2026-03-10');
    const invoiceC = await submittedMbInvoice(mbC.id, '2026-03-11');

    // First note of FY 2025-26 — the counter starts at 1 for the new FY.
    const noteFy1 = await issuedCreditNote(invoiceB.invoice.id, '2026-03-31');
    expect(noteFy1.creditNote.fyLabel).toBe('2025-26');
    expect(noteFy1.creditNote.sequenceNumber).toBe(1);
    expect(noteFy1.creditNote.noteNumber).toBe('CN/2025-26/001');

    // A note of FY 2026-27 continues THAT year's counter consecutively.
    const [before] = await admin<{ next_value: number | null }[]>`
      select next_value from credit_note_counters
      where organisation_id = ${organisationId} and fy_label = '2026-27'
    `;
    const expected = (before?.next_value ?? 0) + 1;
    const noteFy2 = await issuedCreditNote(invoiceC.invoice.id, '2026-04-10');
    expect(noteFy2.creditNote.fyLabel).toBe('2026-27');
    expect(noteFy2.creditNote.sequenceNumber).toBe(expected);
    expect(noteFy2.creditNote.noteNumber).toBe(
      `CN/2026-27/${String(expected).padStart(3, '0')}`,
    );
  });
});

describe('database guards (raw SQL negatives)', () => {
  it('refuses a credit note whose money differs from the invoice in any column', async () => {
    const invoice = await submittedDirectInvoice('full value negative');
    const attempt = admin`
      insert into credit_notes (
        organisation_id, tax_invoice_id, work_id, status, note_number,
        sequence_number, fy_label, note_date, reason,
        taxable_value, cgst_amount, sgst_amount, igst_amount, round_off,
        total_amount, issued_snapshot, issued_at, issued_by_user_id,
        created_by_user_id
      )
      values (
        ${organisationId}, ${invoice.invoice.id}, null, 'issued',
        ${`CNX/${runId}/1`}, 9001, '2026-27', '2026-07-01', 'Mismatched money.',
        '999.00', '90.00', '90.00', '0.00', '0.00', '1179.00',
        ${admin.json({ templateVersion: 'cn-v1' })}, now(), ${ownerUserId},
        ${ownerUserId}
      )
    `;
    await expect(attempt).rejects.toThrow(
      /credit note money must equal the superseded invoice/,
    );
  });

  it('lets the database arbitrate one live credit note per invoice', async () => {
    const invoice = await submittedDirectInvoice('one live raw');
    const first = await draftCreditNote(invoice.invoice.id, '2026-07-01');
    expect(first.statusCode, first.body).toBe(201);
    const second = admin`
      insert into credit_notes (
        organisation_id, tax_invoice_id, work_id, note_date, reason,
        created_by_user_id
      )
      values (
        ${organisationId}, ${invoice.invoice.id}, null, '2026-07-02',
        'Racing duplicate credit note.', ${ownerUserId}
      )
    `;
    await expect(second).rejects.toThrow(/credit_notes_one_live_per_invoice/);
  });

  it('refuses superseding a submitted invoice with no issued credit note', async () => {
    const invoice = await submittedDirectInvoice('no note supersede');
    const attempt = admin`
      update tax_invoices set status = 'superseded'
      where id = ${invoice.invoice.id}
    `;
    await expect(attempt).rejects.toThrow(/superseded only by an issued credit note/);
  });

  it('keeps superseded terminal and pinned while its issued note exists', async () => {
    const invoice = await submittedDirectInvoice('terminal supersede');
    await issuedCreditNote(invoice.invoice.id, '2026-07-01');

    const toCancelled = admin`
      update tax_invoices
      set status = 'cancelled', cancelled_at = now(),
          cancelled_by_user_id = ${ownerUserId},
          cancellation_note = 'Trying to cancel a superseded invoice.'
      where id = ${invoice.invoice.id}
    `;
    await expect(toCancelled).rejects.toThrow(/terminal/);

    const toSubmitted = admin`
      update tax_invoices set status = 'submitted'
      where id = ${invoice.invoice.id}
    `;
    await expect(toSubmitted).rejects.toThrow(
      /stays superseded while an issued credit note exists/,
    );
  });

  it('freezes issued credit-note facts and the provider-state matrix', async () => {
    const invoice = await submittedDirectInvoice('cn immutability');
    const note = await issuedCreditNote(invoice.invoice.id, '2026-07-02');

    const renumber = admin`
      update credit_notes set note_number = 'CN/FORGED/999'
      where id = ${note.creditNote.id}
    `;
    await expect(renumber).rejects.toThrow(
      /issued credit note business facts are immutable/,
    );

    const badTransition = admin`
      update credit_notes
      set irp_provider = 'whitebooks', irp_provider_state = 'registration_failed'
      where id = ${note.creditNote.id}
    `;
    await expect(badTransition).rejects.toThrow(
      /invalid credit note IRP provider-state transition/,
    );
  });
});

describe('the CRN transport under the 0049 gates and the provider ledger', () => {
  it('refuses register-irp while the declaration is undeclared', async () => {
    const created = await authedOn(app, secondOwner, {
      method: 'POST',
      url: '/api/tax-invoices',
      organisationId: undeclaredOrganisationId,
      payload: {
        invoiceDate: '2026-06-15',
        sacCode: '998734',
        serviceDescription: 'Undeclared organisation probe.',
        gstRate: '18',
        placeOfSupply: '07',
        reverseChargeApplicable: false,
        buyerContactId: undeclaredBuyerContactId,
        taxableValue: '500.00',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const submitted = await authedOn(app, secondOwner, {
      method: 'POST',
      url: `/api/tax-invoices/${created.json<TaxInvoiceDetailResponse>().invoice.id}/submit`,
      organisationId: undeclaredOrganisationId,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const note = await issuedCreditNote(
      submitted.json<TaxInvoiceDetailResponse>().invoice.id,
      '2026-06-20',
      undeclaredOrganisationId,
      secondOwner,
    );
    const register = await authedOn(providerApp, secondOwner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/register-irp`,
      organisationId: undeclaredOrganisationId,
    });
    expect(register.statusCode, register.body).toBe(409);
    expect(register.json<{ code: string }>().code).toBe(
      'E_INVOICE_APPLICABILITY_UNDECLARED',
    );
  });

  it('registers the CRN once under single-flight, then cancels inside its own window', async () => {
    registerInvoiceProvider.mockReset();
    cancelInvoiceProvider.mockReset();
    const invoice = await submittedDirectInvoice('crn single flight');
    const note = await issuedCreditNote(invoice.invoice.id, '2026-07-03');

    const evidence = irpEvidence('d', hoursAgo(1));
    let releaseProvider!: (value: typeof evidence) => void;
    registerInvoiceProvider.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseProvider = resolve;
      }),
    );

    const first = authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/register-irp`,
      organisationId,
    });
    await vi.waitFor(() => expect(registerInvoiceProvider).toHaveBeenCalledTimes(1));
    const second = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/register-irp`,
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
    const registered = completed.json<CreditNoteDetailResponse>().creditNote;
    expect(registered.irpProviderState).toBe('registered');
    expect(registered.irn).toBe(evidence.irn);
    expect(registered.irpCancelWindowOpen).toBe(true);

    // The identity sent to the provider names the CRN document type.
    const [identity] = registerInvoiceProvider.mock.calls[0] ?? [];
    expect(identity?.documentType).toBe('CRN');
    expect(identity?.documentNumber).toBe(registered.noteNumber);

    const [ledger] = await admin<{ operation: string; status: string }[]>`
      select operation, status from statutory_provider_operations
      where credit_note_id = ${note.creditNote.id}
      order by started_at desc limit 1
    `;
    expect(ledger).toEqual({ operation: 'register_crn', status: 'succeeded' });

    // Cancel the CRN IRN inside its own 24-hour window.
    const crnCancelledAt = new Date();
    cancelInvoiceProvider.mockResolvedValueOnce({
      cancelledAtText: istText(crnCancelledAt),
      cancelledAt: crnCancelledAt.toISOString(),
      rawResponse: `{"status_cd":"1","CancelDate":"${istText(crnCancelledAt)}"}`,
    });
    const cancel = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/cancel-irp`,
      organisationId,
      payload: { reasonCode: '2', remark: 'Note raised in error.' },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json<CreditNoteDetailResponse>().creditNote.irpProviderState).toBe(
      'cancelled',
    );

    // With the IRN cancelled, the local cancel revives the invoice.
    const localCancel = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/cancel`,
      organisationId,
      payload: { note: 'Reverting the supersession after IRN cancel.' },
    });
    expect(localCancel.statusCode, localCancel.body).toBe(200);
    const revived = await authed(owner, {
      method: 'GET',
      url: `/api/tax-invoices/${invoice.invoice.id}`,
      organisationId,
    });
    expect(revived.json<TaxInvoiceDetailResponse>().invoice.status).toBe('submitted');
  });

  it("refuses cancelling a CRN IRN past the note's own 24-hour window, and pins the note locally", async () => {
    registerInvoiceProvider.mockReset();
    cancelInvoiceProvider.mockReset();
    const invoice = await submittedDirectInvoice('crn window closed');
    const note = await issuedCreditNote(invoice.invoice.id, '2026-07-04');
    registerInvoiceProvider.mockResolvedValueOnce(irpEvidence('e', hoursAgo(48)));
    const registered = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/register-irp`,
      organisationId,
    });
    expect(registered.statusCode, registered.body).toBe(200);
    expect(
      registered.json<CreditNoteDetailResponse>().creditNote.irpCancelWindowOpen,
    ).toBe(false);

    const cancelIrp = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/cancel-irp`,
      organisationId,
      payload: { reasonCode: '2', remark: 'Too late for NIC.' },
    });
    expect(cancelIrp.statusCode, cancelIrp.body).toBe(409);
    expect(cancelIrp.json<{ code: string }>().code).toBe('IRP_CANCEL_WINDOW_CLOSED');
    expect(cancelInvoiceProvider).not.toHaveBeenCalled();

    // And the local cancel is pinned while the IRN stands.
    const localCancel = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/cancel`,
      organisationId,
      payload: { note: 'Local cancel with a live IRN.' },
    });
    expect(localCancel.statusCode).toBe(409);
    expect(localCancel.json<{ code: string }>().code).toBe('IRP_CANCELLATION_REQUIRED');
  });

  it('stamps the frozen reporting deadline at issue and refuses a late fresh CRN registration', async () => {
    // Declare a 30-day window; notes issued from here stamp deadlines.
    await patchProfile({ irpReportingWindowDays: 30 });
    const invoice = await submittedDirectInvoice('crn deadline', '2026-06-01');
    const note = await issuedCreditNote(invoice.invoice.id, '2026-06-05');
    expect(note.creditNote.irpReportingDeadline).toBe('2026-07-05');
    expect(note.creditNote.irpReportingOverdue).toBe(true);

    const register = await authedOn(providerApp, owner, {
      method: 'POST',
      url: `/api/credit-notes/${note.creditNote.id}/register-irp`,
      organisationId,
    });
    expect(register.statusCode, register.body).toBe(409);
    expect(register.json<{ code: string }>().code).toBe('IRP_REPORTING_WINDOW_CLOSED');
  });
});
