import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import { configureMfaEnforcement } from '../src/mfa-policy.js';
import { EXPECTED_EXPORT_VERSION } from './helpers/export-format.js';

/**
 * The platform controls over HTTP (migration 0096).
 *
 * `packages/db/test/platform-controls.integration.test.ts` attacks the
 * scheduler and the guards at the database. This suite proves the three
 * things only the route layer can:
 *
 *   THE AUTHORITY WALLS. `can_manage_entitlements` is owner-only IN
 *   EFFECT rather than by column, so the proof that matters is that a
 *   non-owner HOLDING the column is still refused. A test that only
 *   checked a member without it would pass against a route that had
 *   quietly dropped `role: 'owner'`.
 *
 *   THAT AN ENTITLEMENT ACTUALLY GATES ITS MODULE. A flag nothing reads
 *   is a switch wired to nothing, and that is the failure mode of every
 *   feature-flag system.
 *
 *   THE EXPORT'S WHOLE LIFE — request, build, download, expiry — through
 *   the same session-authenticated route an operator uses, including that
 *   another organisation's artefact id answers 404 rather than 403.
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
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let ownerCookie: string;
let organisationId: string;
let otherOwnerCookie: string;
let otherOrganisationId: string;
const createdOrganisations: string[] = [];

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

async function signUp(email: string, name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name },
  });
  expect(response.statusCode, `sign-up ${email}: ${response.body}`).toBe(200);
  return extractCookies(response.headers['set-cookie']);
}

async function createOrganisation(cookie: string, slug: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie },
    payload: { name: `Platform ${slug}`, slug },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ id: string }>().id;
  createdOrganisations.push(id);
  return id;
}

/** A member of the main organisation, with exactly the grants named. */
async function member(label: string, grants: Record<string, unknown>): Promise<string> {
  const email = `platform-${label}-${runId}@integration.test`;
  const cookie = await signUp(email, `Platform ${label}`);
  const added = await app.inject({
    method: 'POST',
    url: '/api/organisations/current/members',
    headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    payload: { email, role: 'viewer' },
  });
  expect(added.statusCode, added.body).toBe(201);
  const [account] = await admin<{ id: string }[]>`
    select id from auth_users where email = ${email}
  `;
  expect(account, `no account for ${email}`).toBeDefined();
  const userId = account?.id ?? '';
  if (Object.keys(grants).length > 0) {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/organisations/current/members/${userId}`,
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: grants,
    });
    expect(patched.statusCode, patched.body).toBe(200);
  }
  return cookie;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-platform-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-platform-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });
  // The owners below never enrol, and this suite is about the platform
  // walls rather than the finding-36 one.
  configureMfaEnforcement(false);

  ownerCookie = await signUp(
    `platform-owner-${runId}@integration.test`,
    'Platform Owner',
  );
  organisationId = await createOrganisation(ownerCookie, `platform-${runId}`);

  otherOwnerCookie = await signUp(
    `platform-other-${runId}@integration.test`,
    'Other Owner',
  );
  otherOrganisationId = await createOrganisation(
    otherOwnerCookie,
    `platform-other-${runId}`,
  );
}, 180_000);

afterAll(async () => {
  await app?.close();
  if ((admin as Sql | undefined) !== undefined && createdOrganisations.length > 0) {
    await removeOrganisationResidue(admin, createdOrganisations);
  }
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('entitlements', () => {
  it('lists both declared flags with their shipped defaults', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/entitlements',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { entitlements } = response.json<{
      entitlements: { key: string; enabled: boolean; configured: boolean }[];
    }>();
    expect(entitlements.map((flag) => flag.key).sort()).toEqual([
      'eway_bill',
      'outbound_signing',
    ]);
    // BOTH SHIP ENABLED. Landing the mechanism must not change what any
    // organisation can do on the day the migration applies.
    for (const flag of entitlements) {
      expect(flag.enabled, flag.key).toBe(true);
      expect(flag.configured, flag.key).toBe(false);
    }
  });

  it('refuses a member who holds the authority but is not an owner', async () => {
    // THE ASSERTION THAT MATTERS. `can_manage_entitlements` is a per-member
    // column so the finding-36 census can classify it, and it is owner-only
    // because every route also declares `role: 'owner'`. A route that
    // dropped the role would still pass a test that used a member without
    // the column, so this member HOLDS it.
    const cookie = await member('entitled-viewer', { canManageEntitlements: true });
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/entitlements',
      headers: { cookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('OWNER_REQUIRED');
  });

  it('gates the e-way bill module it names, and says so by name', async () => {
    const off = await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/eway_bill',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: false, note: 'waiting on NIC re-certification' },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<{ entitlement: { enabled: boolean } }>().entitlement.enabled).toBe(
      false,
    );

    // A flag nothing reads is a switch wired to nothing. The create route
    // is reached with a nonsense document id on purpose: the entitlement
    // is checked before anything about the document is, so the refusal
    // proves the gate rather than the document lookup.
    const refused = await app.inject({
      method: 'POST',
      url: `/api/challans/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/eway-bills`,
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: {
        transportMode: 'road',
        distanceKm: 10,
        fromPincode: '440001',
        toPincode: '400001',
      },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('ENTITLEMENT_DISABLED');

    const on = await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/eway_bill',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: true },
    });
    expect(on.statusCode, on.body).toBe(200);
  });

  it('gates the route that actually speaks to NIC, not only the create routes', async () => {
    // The flag's whole stated purpose is that an organisation whose NIC
    // re-certification has not landed cannot speak to the portal in its
    // name. Gating only the two create routes would have left the door it
    // exists to close standing open: /generate is the call that registers.
    // The route declares `authority: ['issue', 'statutory']`, and the
    // registrar checks a declared authority before the handler body runs.
    // The founder holds issue but not statutory — 0089's restraint — so
    // without this the test would prove the AUTHORITY wall rather than the
    // entitlement one.
    await admin`
      update organisation_memberships set can_manage_statutory_reporting = true
      where organisation_id = ${organisationId} and role = 'owner'
    `;
    await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/eway_bill',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: false },
    });
    const refused = await app.inject({
      method: 'POST',
      url: `/api/eway-bills/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/generate`,
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('ENTITLEMENT_DISABLED');
    await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/eway_bill',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: true },
    });
  });

  it('keeps a note through a plain toggle', async () => {
    // The screen sends only `{ enabled }` when somebody flips a switch,
    // so an absent-means-clear rule would erase "waiting on NIC
    // re-certification" on the first toggle — which is the one fact the
    // column exists to carry.
    await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/outbound_signing',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: false, note: 'waiting on the ESP procurement' },
    });
    const toggled = await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/outbound_signing',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: true },
    });
    expect(toggled.statusCode, toggled.body).toBe(200);
    const entitlement = toggled.json<{
      entitlement: { enabled: boolean; note: string | null };
    }>().entitlement;
    expect(entitlement.enabled).toBe(true);
    expect(entitlement.note).toBe('waiting on the ESP procurement');

    // …and an explicit null still clears it.
    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/outbound_signing',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: true, note: null },
    });
    expect(
      cleared.json<{ entitlement: { note: string | null } }>().entitlement.note,
    ).toBe(null);
  });

  it('refuses a flag key the database does not admit', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/not_a_module',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: false },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('does not leak one organisation setting into another', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/outbound_signing',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: false },
    });
    const theirs = await app.inject({
      method: 'GET',
      url: '/api/platform/entitlements',
      headers: {
        cookie: otherOwnerCookie,
        'x-organisation-id': otherOrganisationId,
      },
    });
    expect(theirs.statusCode, theirs.body).toBe(200);
    const signing = theirs
      .json<{ entitlements: { key: string; enabled: boolean }[] }>()
      .entitlements.find((flag) => flag.key === 'outbound_signing');
    expect(signing?.enabled).toBe(true);
    await app.inject({
      method: 'PUT',
      url: '/api/platform/entitlements/outbound_signing',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: true },
    });
  });
});

describe('recurring statutory checks', () => {
  it('creates a schedule stamped with the member who saved it', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/platform/job-schedules/instrument_expiry_review',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { enabled: true, cadence: 'daily', horizonDays: 30 },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { schedule } = response.json<{
      schedule: {
        cadence: string;
        horizonDays: number;
        enabled: boolean;
        authorityUserId: string;
      };
    }>();
    expect(schedule.cadence).toBe('daily');
    expect(schedule.horizonDays).toBe(30);
    expect(schedule.enabled).toBe(true);
    // ADR-0011: the schedule borrows a real membership rather than a
    // service identity, so this is a live user id.
    expect(schedule.authorityUserId.length).toBeGreaterThan(0);
  });

  it('lists schedules and an empty run history before anything has run', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/job-schedules',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ schedules: unknown[]; runs: unknown[] }>();
    expect(body.schedules).toHaveLength(1);
    // The run history is read through a definer function over
    // `worker_jobs`, which the application role cannot touch directly.
    // Reaching this line at all proves the grant is in place.
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it('refuses to adopt a check for a member who cannot see every Work', async () => {
    // The check reads every Work's instruments and puts what it found on
    // a screen, so adopting one is the same question the export asks —
    // and it answers with the same refusal.
    const cookie = await member('assigned-schedule', {
      role: 'owner',
      canManageEntitlements: true,
      workScope: 'assigned',
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/platform/job-schedules/instrument_expiry_review',
      headers: { cookie, 'x-organisation-id': organisationId },
      payload: { enabled: true },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('EXPORT_SCOPE_REQUIRED');
  });

  it('refuses a non-owner even when they hold the authority', async () => {
    const cookie = await member('entitled-viewer-two', {
      canManageEntitlements: true,
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/platform/job-schedules/instrument_expiry_review',
      headers: { cookie, 'x-organisation-id': organisationId },
      payload: { enabled: false },
    });
    expect(response.statusCode, response.body).toBe(403);
  });
});

/** Polls until the background build settles, or gives up loudly. */
async function settledExport(
  cookie: string,
  exportId: string,
): Promise<{
  state: string;
  sha256: string | null;
  formatVersion: string | null;
  failureReason: string | null;
}> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/exports',
      headers: { cookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const record = response
      .json<{
        exports: {
          id: string;
          state: string;
          sha256: string | null;
          formatVersion: string | null;
          failureReason: string | null;
        }[];
      }>()
      .exports.find((row) => row.id === exportId);
    expect(record, 'the export disappeared from the list').toBeDefined();
    if (
      record !== undefined &&
      record.state !== 'queued' &&
      record.state !== 'running'
    ) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the export never left the building states');
}

describe('the organisation export', () => {
  it('refuses a member without the authority', async () => {
    const cookie = await member('no-export', {});
    const response = await app.inject({
      method: 'POST',
      url: '/api/platform/exports',
      headers: { cookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
  });

  it('refuses a member whose Work scope is not full, by name', async () => {
    // The package is not Work-scoped: RLS scopes it to the organisation
    // and nothing filters it to assignments, so an assigned-scope member
    // holding the authority would receive every Work the product hides
    // from them. Refused rather than silently exporting less.
    const cookie = await member('assigned-export', {
      canExportOrg: true,
      workScope: 'assigned',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/platform/exports',
      headers: { cookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('EXPORT_SCOPE_REQUIRED');
  });

  it('builds an artefact and serves it back with the format it was written in', async () => {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/platform/exports',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    const exportId = accepted.json<{ export: { id: string } }>().export.id;

    const settled = await settledExport(ownerCookie, exportId);
    expect(settled.state, `the build failed: ${settled.failureReason ?? ''}`).toBe(
      'ready',
    );
    expect(settled.formatVersion).toBe(EXPECTED_EXPORT_VERSION);
    expect(settled.sha256).toMatch(/^[0-9a-f]{64}$/);

    const download = await app.inject({
      method: 'GET',
      url: `/api/platform/exports/${exportId}/download`,
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    });
    expect(download.statusCode, download.body.slice(0, 200)).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    const bundle = download.json<{ formatVersion: string; members: unknown[] }>();
    expect(bundle.formatVersion).toBe(EXPECTED_EXPORT_VERSION);
    expect(Array.isArray(bundle.members)).toBe(true);

    // THE WINDOW IS THIRTY DAYS, by the owner ruling of 2026-08-19. It
    // was seven, on the argument that an export is taken for somebody who
    // works to a week; the ruling is that the counterparty who asked for
    // it is working to a month-end, an audit cycle or a bank's own queue,
    // and an artefact that lapsed before they opened it meant the whole
    // export was made twice.
    //
    // Asserted on the ROW rather than on the constant, because the
    // constant is only a promise until the build writes it — the column
    // carries no DEFAULT and the sweep compares against `now()`, so this
    // one write is the whole definition of the window.
    const [row] = await admin<{ days: string }[]>`
      select round(extract(epoch from (expires_at - completed_at)) / 86400)::text
               as days
      from organisation_export_requests where id = ${exportId}
    `;
    expect(row?.days).toBe('30');
    // And the number the screen renders it from agrees.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/platform/exports',
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ retentionHours: number }>().retentionHours).toBe(720);
  });

  it('refuses the DOWNLOAD to an assigned-scope member too, not only the request', async () => {
    // One artefact serves the whole organisation, so a scope test only at
    // request time would leave the download as the way round it — a member
    // who may not see every Work could fetch the package somebody else
    // built. The 404-vs-403 order matters here: the scope refusal comes
    // first, so it answers the same way for a real id and a guessed one.
    const cookie = await member('assigned-download', {
      canExportOrg: true,
      workScope: 'assigned',
    });
    const [ready] = await admin<{ id: string }[]>`
      select id from organisation_export_requests
      where organisation_id = ${organisationId}
      order by requested_at desc limit 1
    `;
    expect(ready, 'no artefact to attempt').toBeDefined();
    const response = await app.inject({
      method: 'GET',
      url: `/api/platform/exports/${ready?.id ?? ''}/download`,
      headers: { cookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('EXPORT_SCOPE_REQUIRED');
  });

  it('refuses the LIST to an assigned-scope member as well', async () => {
    // The list is metadata rather than the package, but it names who took
    // a copy of the whole organisation and when, and SECURITY.md states
    // the export surface as a whole is behind full Work scope.
    const cookie = await member('assigned-list', {
      canExportOrg: true,
      workScope: 'assigned',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/exports',
      headers: { cookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('EXPORT_SCOPE_REQUIRED');
  });

  it('admits one build even when two requests race', async () => {
    // The route's own pre-check is the friendly arm; two requests can both
    // pass it before either inserts. Fired together, exactly one must be
    // accepted and the other must read the same sentence.
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/platform/exports',
        headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      }),
      app.inject({
        method: 'POST',
        url: '/api/platform/exports',
        headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes, `${first.body} | ${second.body}`).toEqual([202, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json<{ code: string }>().code).toBe('EXPORT_IN_PROGRESS');

    const accepted = first.statusCode === 202 ? first : second;
    const settled = await settledExport(
      ownerCookie,
      accepted.json<{ export: { id: string } }>().export.id,
    );
    expect(settled.state, settled.failureReason ?? '').toBe('ready');
  });

  it('answers 404 for another organisation artefact, not 403', async () => {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/platform/exports',
      headers: {
        cookie: otherOwnerCookie,
        'x-organisation-id': otherOrganisationId,
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    const theirId = accepted.json<{ export: { id: string } }>().export.id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/platform/exports/${theirId}/download`,
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    });
    // 404 rather than 403: RLS has already hidden the row, and a guessed
    // id must not confirm it exists somewhere else.
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('EXPORT_NOT_FOUND');
  });

  it('refuses a lapsed artefact even before the sweep reaches it', async () => {
    const [row] = await admin<{ id: string }[]>`
      select id from organisation_export_requests
      where organisation_id = ${organisationId} and state = 'ready'
      order by requested_at desc limit 1
    `;
    if (row === undefined) {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/platform/exports',
        headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
      const built = accepted.json<{ export: { id: string } }>().export.id;
      const rebuilt = await settledExport(ownerCookie, built);
      expect(rebuilt.state, rebuilt.failureReason ?? '').toBe('ready');
    }
    const [ready] = await admin<{ id: string }[]>`
      select id from organisation_export_requests
      where organisation_id = ${organisationId} and state = 'ready'
      order by requested_at desc limit 1
    `;
    expect(ready, 'no ready artefact to lapse').toBeDefined();
    // The sweep runs on the worker's tick, so between the instant an
    // artefact lapses and the instant the sweep reaches it the bytes are
    // still on disk. The route's own check is what makes that window
    // unreachable rather than merely short.
    // Backdating the expiry has to suspend the trigger: the 0096 guard
    // freezes `expires_at` the moment the artefact exists, which is the
    // property the previous test proves at the database. Replica mode is
    // `set local`, so it can never leak onto a pooled connection.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`
        update organisation_export_requests
           set expires_at = now() - interval '1 hour'
         where id = ${ready?.id ?? null}
      `;
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/platform/exports/${ready?.id ?? ''}/download`,
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('EXPORT_EXPIRED');
  });
});
