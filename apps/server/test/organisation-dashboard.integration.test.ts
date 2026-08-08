import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { DashboardResponse, OrganisationProfile } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, jsonb, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

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
const ownerEmail = `orgdash-owner-${runId}@integration.test`;
const viewerEmail = `orgdash-viewer-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let workId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let viewer: CookieJar;

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

/** PNG magic bytes plus filler — the endpoint validates magic, not decoding. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('auto-mb-logo-test-body'),
]);

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-orgdash-admin',
  });
  await admin`select 1 as ready`;
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-orgdash-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Org Owner');
  viewer = await signUp(viewerEmail, 'Org Viewer');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Dashboard Constructions', slug: `orgdash-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing after sign-up');
  ownerUserId = ownerUser.id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: viewerEmail, role: 'viewer' },
  });
  expect(added.statusCode, added.body).toBe(201);

  // Seed one Work with an expiring and an expired instrument, a distant
  // instrument that must stay silent, a prepared bill, and one LOA
  // document still in review.
  workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, 'DASH-1', 'L-77/2026', '2026-01-15',
      'Dashboard proof work', '5000000.00', '4520000.00', 'per_schedule',
      ${ownerUserId}
    )
  `;
  await admin`
    insert into work_instruments (
      organisation_id, work_id, kind, reference, amount, issued_on,
      expires_on, created_by_user_id
    )
    values
      (${organisationId}, ${workId}, 'pbg', 'BG/EXPIRED', '100000.00',
       current_date - 200, current_date - 5, ${ownerUserId}),
      (${organisationId}, ${workId}, 'pbg', 'BG/SOON', '100000.00',
       current_date - 100, current_date + 30, ${ownerUserId}),
      (${organisationId}, ${workId}, 'pac', 'PAC/FAR', null,
       current_date - 10, current_date + 300, ${ownerUserId})
  `;
  await admin`
    insert into bills (
      organisation_id, work_id, bill_number, total_amount, lines_snapshot,
      prepared_by_user_id
    )
    values (
      ${organisationId}, ${workId}, 1, '300.00', ${jsonb(admin, [])},
      ${ownerUserId}
    )
  `;
  const documentId = randomUUID();
  const sha256 = createHash('sha256').update('dash letter').digest('hex');
  await admin`
    insert into loa_documents (
      id, organisation_id, object_key, original_filename, sha256, media_type,
      size_bytes, extraction_status, extraction_payload, uploaded_by_user_id
    )
    values (
      ${documentId}, ${organisationId},
      ${`${organisationId}/loa/${documentId}.pdf`}, 'dash.pdf', ${sha256},
      'application/pdf', 42, 'review', ${jsonb(admin, { sourceText: 'x' })},
      ${ownerUserId}
    )
  `;
}, 60_000);

afterAll(async () => {
  if (admin) {
    if (organisationId) {
      await admin.unsafe(`set session_replication_role = 'replica'`);
      for (const table of [
        'audit_events',
        'bills',
        'work_instruments',
        'loa_documents',
        'works',
        'organisation_memberships',
        'organisations',
      ]) {
        await admin.unsafe(
          `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
          [organisationId],
        );
      }
      await admin.unsafe(`set session_replication_role = 'origin'`);
    }
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`
      delete from auth_users where "email" like ${`%-${runId}@integration.test`}
    `;
    await admin.end();
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('organisation profile', () => {
  it('starts empty, accepts owner edits, and refuses non-owners', async () => {
    const initial = await authed(owner, {
      method: 'GET',
      url: '/api/organisation/profile',
      organisationId,
    });
    expect(initial.statusCode, initial.body).toBe(200);
    const initialProfile = initial.json<OrganisationProfile>();
    expect(initialProfile.address).toBeNull();
    expect(initialProfile.hasLogo).toBe(false);

    const denied = await authed(viewer, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { address: 'Not allowed' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('OWNER_REQUIRED');

    const updated = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: {
        address: 'Plot 4, MIDC, Nashik 422010',
        gstin: '27ABCDE1234F1Z5',
        contactPhone: '+91 98220 00000',
        contactEmail: 'office@dashboard.example',
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const profile = updated.json<OrganisationProfile>();
    expect(profile.address).toBe('Plot 4, MIDC, Nashik 422010');
    expect(profile.gstin).toBe('27ABCDE1234F1Z5');

    const badGstin = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { gstin: 'short' },
    });
    expect(badGstin.statusCode).toBe(400);
  });

  it('accepts a PNG logo from the owner, streams it back, and removes it', async () => {
    const denied = await authed(viewer, {
      method: 'PUT',
      url: '/api/organisation/logo',
      organisationId,
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(denied.statusCode).toBe(403);

    const junk = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/logo',
      organisationId,
      headers: { 'content-type': 'image/png' },
      payload: Buffer.from('this is not an image'),
    });
    expect(junk.statusCode).toBe(400);
    expect(junk.json<{ code: string }>().code).toBe('INVALID_IMAGE');

    const uploaded = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/logo',
      organisationId,
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json<OrganisationProfile>().hasLogo).toBe(true);

    const streamed = await authed(viewer, {
      method: 'GET',
      url: '/api/organisation/logo',
      organisationId,
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers['content-type']).toBe('image/png');
    expect(streamed.rawPayload.equals(PNG_BYTES)).toBe(true);

    const removed = await authed(owner, {
      method: 'DELETE',
      url: '/api/organisation/logo',
      organisationId,
    });
    expect(removed.statusCode).toBe(204);
    const gone = await authed(owner, {
      method: 'GET',
      url: '/api/organisation/logo',
      organisationId,
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('dashboard', () => {
  it('aggregates totals and raises the seeded alerts for any member', async () => {
    const response = await authed(viewer, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const dashboard = response.json<DashboardResponse>();

    expect(dashboard.totals.works).toBe(1);
    expect(dashboard.totals.contractValue).toBe('4520000.00');
    expect(dashboard.totals.deliveredValue).toBe('0.00');
    expect(dashboard.totals.billedValue).toBe('300.00');
    expect(dashboard.totals.loaAwaitingReview).toBe(1);
    expect(dashboard.totals.openDrafts).toBe(0);

    const kinds = dashboard.alerts.map((alert) => alert.kind);
    expect(kinds).toContain('instrument_expired');
    expect(kinds).toContain('instrument_expiring');
    expect(kinds).toContain('loa_review_pending');
    expect(kinds).toContain('bill_unpaid');

    const expired = dashboard.alerts.find(
      (alert) => alert.kind === 'instrument_expired',
    );
    expect(expired?.severity).toBe('danger');
    expect(expired?.dueInDays).toBe(-5);
    expect(expired?.workCode).toBe('DASH-1');

    const expiring = dashboard.alerts.find(
      (alert) => alert.kind === 'instrument_expiring',
    );
    expect(expiring?.severity).toBe('warning');
    expect(expiring?.dueInDays).toBe(30);

    // The instrument 300 days out must not raise an alert.
    expect(
      dashboard.alerts.filter((alert) => alert.message.includes('PAC/FAR')),
    ).toHaveLength(0);

    const work = dashboard.works[0];
    expect(work?.workCode).toBe('DASH-1');
    expect(work?.issuedChallans).toBe(0);
  });
});
