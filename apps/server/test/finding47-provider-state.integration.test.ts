import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { TaxInvoiceDetailResponse } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations, withTenant } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Finding 47, money-and-legal subset, items (a) and (b).
 *
 * (a) Local cancellation with an active IRN must be refused — through the
 *     route AND against raw SQL, because the 0041 trigger is the guarantee
 *     that survives a buggy handler. A registered invoice is a fact on the
 *     government's register; the local row cannot walk away from it.
 *
 * (b) An ordinary writer (the application role inside a bound tenant
 *     transaction — exactly what a compromised or buggy handler would be)
 *     cannot invent provider status: every raw-SQL path that would forge,
 *     rewind or evidence-lessly advance the IRP / e-way-bill provider
 *     state machine must be refused by the 0041 transition and evidence
 *     guards.
 *
 * Each test names the guard message it discharges so a regression that
 * removes a guard fails loudly here.
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
const ownerEmail = `f47ps-owner-${runId}@integration.test`;
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

/** Submitted invoice with a MANUALLY RECORDED, ACTIVE IRN
 * (registered_unverified since migration 0053). */
let registeredInvoiceId: string;
/** Submitted invoice that never approached the IRP (not_requested). */
let untouchedInvoiceId: string;
/** Submitted invoice hosting the directly seeded generated e-way bill. */
let ewbInvoiceId: string;
let generatedEwbId: string;

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

async function submittedDirectInvoice(suffix: string): Promise<string> {
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/tax-invoices',
    organisationId,
    payload: {
      invoiceDate: '2026-02-15',
      sacCode: '998734',
      serviceDescription: `Finding-47 provider-state fixture ${suffix}.`,
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

/** Runs one raw statement as the ordinary application writer — the app DB
 * role inside a bound tenant transaction — and returns the refusal. */
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

async function invoiceState(id: string) {
  const [row] = await admin<
    {
      status: string;
      irn: string | null;
      irp_provider: string | null;
      irp_provider_state: string;
    }[]
  >`
    select status, irn, irp_provider, irp_provider_state
    from tax_invoices where id = ${id}
  `;
  if (!row) throw new Error('fixture invoice missing');
  return row;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-f47ps-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the finding-47 provider-state tests. ' +
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
    applicationName: 'auto-mb-f47ps-raw-writer',
  });

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-f47ps-objects-'));
  // Built WITHOUT a statutory provider, so the manual IRP compatibility
  // route is reachable and produces a manual registered invoice.
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'F47 PS Owner');
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'F47 Provider State', slug: `f47ps-${runId}` },
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
  await admin`
    insert into contacts (
      id, organisation_id, designation, contact_person, address, gstin,
      pincode, state_code, locality, is_consignee, active, created_by_user_id
    )
    values (
      ${buyerContactId}, ${organisationId}, 'Sr. DEE (G) NR', 'S K Verma',
      'DRM Office, State Entry Road, New Delhi, 110055', ${BUYER_GSTIN},
      '110055', '07', 'New Delhi', true, true, ${ownerUserId}
    )
  `;

  registeredInvoiceId = await submittedDirectInvoice('registered');
  untouchedInvoiceId = await submittedDirectInvoice('untouched');
  ewbInvoiceId = await submittedDirectInvoice('ewb-host');

  // Manual (provider-less) IRP registration through the compatibility
  // route: both invoices now carry an ACTIVE IRN. `registeredInvoiceId`
  // is consumed by the (a) cancellation arc; `ewbInvoiceId` stays
  // registered for the (b) rewind negatives.
  for (const [invoiceId, seed] of [
    [registeredInvoiceId, 'a'],
    [ewbInvoiceId, 'b'],
  ] as const) {
    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${invoiceId}/irp-response`,
      organisationId,
      payload: {
        irn: seed.repeat(64),
        ackNumber: '112010036563310',
        ackDate: '2026-02-15T09:00:00.000Z',
        ackDateText: '2026-02-15 14:30:00',
        signedQr: `signed-qr-f47ps-${seed}-${runId}`,
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    // Migration 0053: manually recorded evidence lands in its own state,
    // never the provider-verified 'registered'.
    expect(recorded.json<TaxInvoiceDetailResponse>().invoice.irpProviderState).toBe(
      'registered_unverified',
    );
  }

  // A generated manual e-way bill, seeded with complete NIC evidence —
  // the raw-negative subject for the e-way-bill state machine.
  generatedEwbId = randomUUID();
  await admin`
    insert into eway_bills (
      id, organisation_id, tax_invoice_id, status, transport_mode,
      vehicle_number, distance_km, from_pincode, to_pincode,
      ewb_number, ewb_date, valid_until, ewb_date_text, valid_until_text,
      provider, provider_state, legacy_evidence_missing,
      generated_by_user_id, generated_at, created_by_user_id
    ) values (
      ${generatedEwbId}, ${organisationId}, ${ewbInvoiceId}, 'generated',
      'road', 'DL01AB1234', 25, '110020', '110055', '123456789012',
      '2026-02-15T09:00:00.000Z', '2026-02-16T23:59:59.000Z',
      '15/02/2026 14:30:00', '16/02/2026 23:59:59',
      'manual', 'generated', false, ${ownerUserId}, now(), ${ownerUserId}
    )
  `;
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
          'document_number_series',
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

describe('finding 47(a) — local cancellation with an active IRN', () => {
  it('is refused through the route with the named 409', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${registeredInvoiceId}/cancel`,
      organisationId,
      payload: { note: 'Attempted local cancel under an active IRN.' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('IRP_CANCELLATION_REQUIRED');
    expect((await invoiceState(registeredInvoiceId)).status).toBe('submitted');
  });

  it('is refused against raw SQL: the 0041 trigger, not the handler, is the wall', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices
        set status = 'cancelled', cancelled_by_user_id = ${ownerUserId},
            cancelled_at = now(),
            cancellation_note = 'Raw write around the route guard.'
        where id = ${registeredInvoiceId}
      `,
    );
    expect(refusal).toMatch(
      /resolve provider registration\/cancellation before cancelling the local invoice/,
    );
    const state = await invoiceState(registeredInvoiceId);
    expect(state.status).toBe('submitted');
    expect(state.irp_provider_state).toBe('registered_unverified');
  });

  it('opens again only through recorded IRP cancellation evidence', async () => {
    // The refusal must not be a dead end: once external IRP cancellation
    // evidence is recorded, the local legal register can move.
    const evidence = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${registeredInvoiceId}/irp-cancel-response`,
      organisationId,
      payload: {
        cancelledAt: '2026-02-16T09:00:00.000Z',
        cancelledAtText: '2026-02-16 14:30:00',
        reasonCode: '2',
        remark: 'Data entry mistake; cancelled on the portal.',
      },
    });
    expect(evidence.statusCode, evidence.body).toBe(200);
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/tax-invoices/${registeredInvoiceId}/cancel`,
      organisationId,
      payload: { note: 'Local cancel after the IRP evidence arrived.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await invoiceState(registeredInvoiceId)).status).toBe('cancelled');
  });
});

describe('finding 47(b) — an ordinary writer cannot invent IRP status', () => {
  it('cannot mark a fresh invoice registered without registration evidence', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices
        set irp_provider = 'manual', irp_provider_state = 'registered'
        where id = ${untouchedInvoiceId}
      `,
    );
    expect(refusal).toMatch(/tax_invoices_irp_registration_evidence_shape/);
    expect((await invoiceState(untouchedInvoiceId)).irp_provider_state).toBe(
      'not_requested',
    );
  });

  it('cannot jump a fresh invoice into the cancellation half of the machine', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices
        set irp_provider = 'manual', irp_provider_state = 'cancelling'
        where id = ${untouchedInvoiceId}
      `,
    );
    expect(refusal).toMatch(/invalid IRP provider-state transition/);
  });

  it('cannot rewind a registered invoice to not_requested or failed', async () => {
    for (const target of ['not_requested', 'registration_failed'] as const) {
      const refusal = await rawWriteRefusal(
        (tx) => tx`
          update tax_invoices
          set irp_provider_state = ${target}
          where id = ${ewbInvoiceId}
        `,
      );
      expect(refusal, target).toMatch(/invalid IRP provider-state transition/);
    }
  });

  it('cannot declare an IRP cancellation without cancellation evidence', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices
        set irp_provider_state = 'cancelled'
        where id = ${ewbInvoiceId}
      `,
    );
    expect(refusal).toMatch(/tax_invoices_irp_cancel_evidence_shape/);
  });

  it('cannot erase the IRN or swap the provider identity', async () => {
    const erased = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices set irn = null where id = ${ewbInvoiceId}
      `,
    );
    expect(erased).toMatch(/IRP registration evidence is immutable/);

    const swapped = await rawWriteRefusal(
      (tx) => tx`
        update tax_invoices set irp_provider = 'whitebooks'
        where id = ${ewbInvoiceId}
      `,
    );
    expect(swapped).toMatch(/immutable/);
    const state = await invoiceState(ewbInvoiceId);
    expect(state.irn).not.toBeNull();
    expect(state.irp_provider).toBe('manual');
  });
});

describe('finding 47(b) — an ordinary writer cannot invent e-way bill provider status', () => {
  async function ewbState() {
    const [row] = await admin<
      { provider: string | null; provider_state: string; ewb_number: string | null }[]
    >`
      select provider, provider_state, ewb_number
      from eway_bills where id = ${generatedEwbId}
    `;
    if (!row) throw new Error('fixture e-way bill missing');
    return row;
  }

  it('cannot rewind a generated e-way bill to not_requested', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update eway_bills set provider_state = 'not_requested'
        where id = ${generatedEwbId}
      `,
    );
    expect(refusal).toMatch(/invalid e-way bill provider-state transition/);
    expect((await ewbState()).provider_state).toBe('generated');
  });

  it('cannot declare a provider cancellation without cancellation evidence', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update eway_bills set provider_state = 'cancelled'
        where id = ${generatedEwbId}
      `,
    );
    expect(refusal).toMatch(/eway_bills_provider_cancel_evidence_shape/);
  });

  it('cannot swap the provider identity under the generated document', async () => {
    const refusal = await rawWriteRefusal(
      (tx) => tx`
        update eway_bills set provider = 'whitebooks'
        where id = ${generatedEwbId}
      `,
    );
    expect(refusal).toMatch(/e-way bill provider identity is immutable/);
    expect((await ewbState()).provider).toBe('manual');
  });
});

// `registeredInvoiceId` ends the (a) arc cancelled, so the (b) negatives
// run against `ewbInvoiceId`, which must still be registered. Pin that so
// fixture drift cannot quietly turn the rewind negatives into no-ops.
describe('fixture self-check', () => {
  it('keeps a registered invoice available for the rewind negatives', async () => {
    const state = await invoiceState(ewbInvoiceId);
    // Manually recorded evidence: registered_unverified since 0053.
    expect(state.irp_provider_state).toBe('registered_unverified');
    expect(state.irn).not.toBeNull();
  });
});
