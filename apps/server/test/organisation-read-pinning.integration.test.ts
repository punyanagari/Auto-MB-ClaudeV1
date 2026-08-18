import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ChallanDetailResponse } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * Organisation reads must be pinned to the bound organisation.
 *
 * Migration 0004 adds organisations_member_select_policy so the unbound
 * organisation picker (`/api/organisations`) can list names. RLS policies
 * are OR'd, so under a bound tenant an unqualified
 * `select ... from organisations` sees every organisation the caller is
 * an active member of — for a multi-organisation user, WHICH row a
 * `const [organisation] =` read resolves depends on the planner. Several
 * such reads feed the organisation name, warranty text, and branding that
 * print on issued documents, so an unpinned read can stamp ANOTHER
 * tenant's identity onto a challan.
 *
 * These tests pin the fix: every organisations read inside a bound-tenant
 * transaction filters on `id = app_private.current_organisation_id()`.
 * As in cross-org-authority.integration.test.ts, the proof is made
 * deterministic instead of planner-lucky: organisation A carries an
 * all-zero-prefixed id and is inserted first, so an organisation-blind
 * read resolves it under both plausible plans (heap order and id-index
 * order) — and the same user issues and renders a challan bound to EACH
 * organisation in one test. An unpinned read returns the same first row
 * for both bindings, so it cannot answer both assertions correctly.
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
const multiOwnerEmail = `orgpin-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

// Sorts before any gen_random_uuid() value and is inserted first, so an
// organisation-blind read resolves organisation A whichever plan wins.
// (Distinct from cross-org-authority's ...0001 — the suites run
// concurrently against the same database.)
const organisationAId = '00000000-0000-4000-8000-0000000000aa';

const ORG_A_NAME = 'Alpha Yard Signals';
const ORG_B_NAME = 'Bravo Traction Works';
const ORG_A_ADDRESS = 'Alpha Depot Road, Solapur';
const ORG_B_ADDRESS = 'Bravo Loco Shed Lane, Nagpur';

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let fakeGotenberg: http.Server;
const gotenbergBodies: string[] = [];
let organisationBId: string;
let ownerUserId: string;

interface OrgFixture {
  workId: string;
  itemId: string;
}
const fixtures = new Map<string, OrgFixture>();

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
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

async function insertWorkFixture(
  organisationId: string,
  code: string,
): Promise<OrgFixture> {
  const workId = randomUUID();
  const scheduleId = randomUUID();
  const itemId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`${code}-${runId.toUpperCase()}`},
      ${`${code}-letter-${runId}`}, '2025-06-01', 'Pinning fixture work',
      1000.00, 900.00, 'per_schedule', null, null, ${ownerUserId}
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
    values (${itemId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
            'Point machine', 'Nos', 5.000, 100.00)
  `;
  return { workId, itemId };
}

async function issueAndRender(
  organisationId: string,
): Promise<{ snapshotName: string; html: string }> {
  const fixture = fixtures.get(organisationId);
  if (!fixture) throw new Error('missing fixture for organisation');
  const drafted = await authed(owner, {
    method: 'POST',
    url: `/api/works/${fixture.workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-08-08',
      prefix: 'DC',
      consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division, New Delhi' },
      items: [{ workItemId: fixture.itemId, quantity: '1' }],
    },
  });
  expect(drafted.statusCode, drafted.body).toBe(201);
  const draft = drafted.json<ChallanDetailResponse>();

  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${draft.challan.id}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  const detail = issued.json<ChallanDetailResponse>();
  const snapshot = detail.issuedSnapshot as { organisationName: string };

  const render = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${draft.challan.id}/render`,
    organisationId,
  });
  expect(render.statusCode, render.body).toBe(200);
  return {
    snapshotName: snapshot.organisationName,
    html: gotenbergBodies.at(-1) ?? '',
  };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-orgpin-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  // The stub PDF service from challans.integration.test.ts: bodies are
  // retained so the test can assert on the exact HTML the route sent.
  fakeGotenberg = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      gotenbergBodies.push(Buffer.concat(chunks).toString('utf8'));
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.from(`%PDF-1.4 stub ${runId}`));
    });
  });
  await new Promise<void>((resolve) => {
    fakeGotenberg.listen(0, '127.0.0.1', resolve);
  });
  const gotenbergAddress = fakeGotenberg.address();
  if (gotenbergAddress === null || typeof gotenbergAddress === 'string') {
    throw new Error('stub Gotenberg failed to bind a port');
  }

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-orgpin-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
  });

  const signedUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: multiOwnerEmail, password, name: 'Multi Org Owner' },
  });
  expect(signedUp.statusCode, signedUp.body).toBe(200);
  owner = { cookie: extractCookies(signedUp.headers['set-cookie']) };

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${multiOwnerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing');
  ownerUserId = ownerUser.id;

  // Organisation A: fixed all-zero id, inserted BEFORE organisation B, so
  // an organisation-blind read resolves it first under both plausible
  // plans — heap order (earlier row) and the id index (sorts first).
  await admin`
    insert into organisations (id, name, slug)
    values (${organisationAId}, ${ORG_A_NAME}, ${`orgpin-alpha-${runId}`})
  `;
  await admin`
    insert into organisation_memberships (
      id, organisation_id, user_id, role, work_scope,
      can_issue_documents, can_cancel_documents, can_approve_amendments, status
    )
    values (
      ${randomUUID()}, ${organisationAId}, ${ownerUserId},
      'owner', 'all', true, true, true, 'active'
    )
  `;

  // Organisation B: the ordinary product path; the same user owns it too.
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: ORG_B_NAME, slug: `orgpin-bravo-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationBId = created.json<{ id: string }>().id;

  // Distinct branding per organisation: the render route reads the
  // address live from the organisations table, so each masthead must
  // carry its own.
  for (const [organisationId, address] of [
    [organisationAId, ORG_A_ADDRESS],
    [organisationBId, ORG_B_ADDRESS],
  ] as const) {
    const patched = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { address },
    });
    expect(patched.statusCode, patched.body).toBe(200);
  }

  fixtures.set(organisationAId, await insertWorkFixture(organisationAId, 'PIN-A'));
  fixtures.set(organisationBId, await insertWorkFixture(organisationBId, 'PIN-B'));
}, 60_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationAId, organisationBId]);
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
  if (fakeGotenberg) {
    await new Promise<void>((resolve) => {
      fakeGotenberg.close(() => {
        resolve();
      });
    });
  }
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('organisation reads never leak across a multi-organisation user', () => {
  it('stamps each binding with its own organisation identity, issue and render alike', async () => {
    // The decisive regression guard. The issue route freezes the
    // organisation NAME into the immutable snapshot; the render route
    // reads the ADDRESS live for the masthead. Both reads run under a
    // bound tenant where the member-select policy also exposes the OTHER
    // organisation's row. Rendering against BOTH bindings in sequence
    // makes an unpinned read fail deterministically: it resolves the same
    // first row (organisation A, by construction) for both bindings, so
    // it cannot satisfy both halves of this test.
    const asAlpha = await issueAndRender(organisationAId);
    expect(asAlpha.snapshotName, 'issue bound to organisation A').toBe(ORG_A_NAME);
    expect(asAlpha.html).toContain(ORG_A_NAME);
    expect(asAlpha.html).toContain(ORG_A_ADDRESS);
    expect(asAlpha.html).not.toContain(ORG_B_NAME);
    expect(asAlpha.html).not.toContain(ORG_B_ADDRESS);

    const asBravo = await issueAndRender(organisationBId);
    expect(asBravo.snapshotName, 'issue bound to organisation B').toBe(ORG_B_NAME);
    expect(asBravo.html).toContain(ORG_B_NAME);
    expect(asBravo.html).toContain(ORG_B_ADDRESS);
    expect(asBravo.html).not.toContain(ORG_A_NAME);
    expect(asBravo.html).not.toContain(ORG_A_ADDRESS);
  });

  it('serves each binding its own organisation profile', async () => {
    for (const [organisationId, name, address] of [
      [organisationAId, ORG_A_NAME, ORG_A_ADDRESS],
      [organisationBId, ORG_B_NAME, ORG_B_ADDRESS],
    ] as const) {
      const response = await authed(owner, {
        method: 'GET',
        url: '/api/organisation/profile',
        organisationId,
      });
      expect(response.statusCode, response.body).toBe(200);
      const profile = response.json<{ id: string; name: string; address: string }>();
      expect(profile.id).toBe(organisationId);
      expect(profile.name).toBe(name);
      expect(profile.address).toBe(address);
    }
  });

  it('keeps the unbound organisation picker listing both organisations', async () => {
    // /api/organisations runs unbound on purpose: the member-select
    // policy is what makes the picker work, and the fix must not break it.
    const response = await app.inject({
      method: 'GET',
      url: '/api/organisations',
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const organisations = response.json<{
      organisations: { id: string }[];
    }>().organisations;
    expect(organisations.map((organisation) => organisation.id).sort()).toEqual(
      [organisationAId, organisationBId].sort(),
    );
  });
});
