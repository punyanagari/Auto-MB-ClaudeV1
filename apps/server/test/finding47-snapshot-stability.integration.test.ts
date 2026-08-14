import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { TaxInvoiceDetailResponse } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Finding 47, money-and-legal subset, item (e): payload byte-stability
 * after an organisation profile change.
 *
 * An issued tax invoice is an immutable snapshot (AGENTS.md rule 7); its
 * statutory IRP payload must be built only from the frozen submit-time
 * snapshot. The audit's fear: a regression that quietly rebuilds the
 * payload from live master data, so editing the organisation profile (or
 * the buyer's contact card) after issue would change what is submitted to
 * the government for a document that legally already exists.
 *
 * The proof is byte equality — not deep equality — because the IRP wire
 * format is exact decimal lexemes and key order; any rebuild would have to
 * reproduce the identical bytes to pass.
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
const ownerEmail = `f47ss-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const ORG_GSTIN = '07ABCDE1234F1Z5';
const BUYER_GSTIN = '07AAAGM0289C1ZL';
const ORIGINAL_ADDRESS = 'Plot 12, Industrial Area, New Delhi, 110002';

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let buyerContactId: string;
let invoiceId: string;

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

async function irpPayloadBytes(): Promise<string> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/tax-invoices/${invoiceId}/irp-payload`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.body;
}

async function issuedSnapshotBytes(): Promise<string> {
  const [row] = await admin<{ snapshot: string }[]>`
    select issued_snapshot::text as snapshot
    from tax_invoices where id = ${invoiceId}
  `;
  if (!row) throw new Error('fixture invoice missing');
  return row.snapshot;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-f47ss-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the finding-47 snapshot-stability tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-f47ss-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'F47 SS Owner');
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'F47 Snapshot Stability', slug: `f47ss-${runId}` },
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
      address: ORIGINAL_ADDRESS,
      pincode: '110002',
      locality: 'New Delhi',
      tradeName: 'Signal Cabin Works',
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

  const invoiceCreated = await authed(owner, {
    method: 'POST',
    url: '/api/tax-invoices',
    organisationId,
    payload: {
      invoiceDate: '2026-02-15',
      sacCode: '998734',
      serviceDescription: 'Finding-47 snapshot stability fixture invoice.',
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
}, 90_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId]);
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

describe('finding 47(e) — issued payload bytes survive an organisation profile change', () => {
  it('serves byte-identical IRP payload and snapshot before and after the edits', async () => {
    const payloadBefore = await irpPayloadBytes();
    const snapshotBefore = await issuedSnapshotBytes();

    // The frozen seller really is this organisation as it stood at
    // submit — so the profile edit below is the discriminating change.
    expect(payloadBefore).toContain(ORG_GSTIN);
    expect(payloadBefore).toContain(ORIGINAL_ADDRESS);

    // Every seller-facing profile field the payload draws on moves.
    const edited = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: {
        name: 'F47 Snapshot Stability (Renamed) Pvt Ltd',
        address: 'New Registered Office, Sector 62, Noida, 201309',
        pincode: '201309',
        locality: 'Noida',
        tradeName: 'Renamed Trade Name',
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    // The buyer's master card moves too: master-data edits never rewrite
    // issued history (AGENTS.md rule 7).
    await admin`
      update contacts
      set address = 'Relocated DRM Office, Kashmere Gate, Delhi, 110006',
          pincode = '110006', locality = 'Old Delhi',
          contact_person = 'A. N. Other'
      where id = ${buyerContactId}
    `;

    const payloadAfter = await irpPayloadBytes();
    const snapshotAfter = await issuedSnapshotBytes();

    expect(payloadAfter).toBe(payloadBefore);
    expect(snapshotAfter).toBe(snapshotBefore);

    // The frozen payload still names the submit-time facts, not the new
    // master data.
    expect(payloadAfter).toContain(ORIGINAL_ADDRESS);
    expect(payloadAfter).not.toContain('Noida');
    expect(payloadAfter).not.toContain('Relocated DRM Office');
  });

  it('renders the same frozen exact-decimal money after the edits', async () => {
    // Spot-pin the exact statutory lexemes so a future "helpful"
    // Number() round-trip (1000.00 -> 1000) fails here by name.
    const payload = await irpPayloadBytes();
    expect(payload).toContain('"AssVal":1000.00');
    expect(payload).toContain('"TotInvVal":1180.00');
  });
});
