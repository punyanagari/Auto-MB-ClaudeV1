import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  PacCapExceededDetails,
  PacCertificate,
  PacCertificateListResponse,
  TimelineResponse,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * PAC certificate lifecycle (Milestone 8 phase 1, legacy §5.5 and rule
 * R18): the exact-arithmetic installed-minus-covered cap under row locks
 * (with the three numbers in the error), consignee snapshot-on-use,
 * cancel-with-note releasing certified quantities, reference uniqueness
 * among the non-cancelled, scanned-document upload, and the audit /
 * timeline / export / tenancy surfaces.
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
const ownerEmail = `pac-owner-${runId}@integration.test`;
const officeEmail = `pac-office-${runId}@integration.test`;
const siteEmail = `pac-site-${runId}@integration.test`;
const viewerEmail = `pac-viewer-${runId}@integration.test`;
const scopedEmail = `pac-scoped-${runId}@integration.test`;
const outsiderEmail = `pac-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let workId: string;
let itemAId: string; // installed 3.000 of awarded 10.000
let itemBId: string; // installed 2.000 of awarded 2.000 (cap fixture)
let consigneeId: string;
let secondConsigneeId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let site: CookieJar;
let viewer: CookieJar;
let scoped: CookieJar;
let outsider: CookieJar;

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

async function record(
  jar: CookieJar,
  payload: Record<string, unknown>,
  organisation = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/works/${workId}/pac-certificates`,
    organisationId: organisation,
    payload,
  });
}

async function listCertificates(): Promise<PacCertificateListResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/works/${workId}/pac-certificates`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PacCertificateListResponse>();
}

function summaryOf(list: PacCertificateListResponse, itemId: string) {
  return list.itemSummaries.find((summary) => summary.workItemId === itemId);
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-pac-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the PAC integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-pac-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'PAC Owner');
  office = await signUp(officeEmail, 'PAC Office');
  site = await signUp(siteEmail, 'PAC Site');
  viewer = await signUp(viewerEmail, 'PAC Viewer');
  scoped = await signUp(scopedEmail, 'PAC Scoped');
  outsider = await signUp(outsiderEmail, 'PAC Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'PAC Constructions', slug: `pac-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'PAC Outsiders', slug: `pac-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [siteEmail, 'site'],
    [viewerEmail, 'viewer'],
    [scopedEmail, 'office'],
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

  // The scoped office member sees only assigned Works — and is assigned
  // to none, so every PAC route must answer 404 for them.
  const [scopedUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${scopedEmail}
  `;
  if (!scopedUser) throw new Error('scoped user missing');
  await admin`
    update organisation_memberships
    set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${scopedUser.id}
  `;

  workId = randomUUID();
  const scheduleId = randomUUID();
  itemAId = randomUUID();
  itemBId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`PACW-${runId.toUpperCase()}`},
      ${`pac-letter-${runId}`}, '2025-06-01', 'PAC fixture work',
      3000.00, 2700.00, 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, requires_serials
    )
    values
      (${itemAId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Cable set', 'Set', 10.000, 250.00, false),
      (${itemBId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Junction box', 'Nos', 2.000, 120.00, false)
  `;

  // Installed quantities the caps certify against: A 3.000, B 2.000 —
  // recorded through the real installation route so the PAC cap consumes
  // the authoritative aggregate.
  const location = await authed(owner, {
    method: 'POST',
    url: '/api/masters/locations',
    organisationId,
    payload: { name: 'Nashik Road station', kind: 'station' },
  });
  expect(location.statusCode, location.body).toBe(201);
  const locationId = location.json<{ id: string }>().id;
  for (const [workItemId, quantity] of [
    [itemAId, '3.000'],
    [itemBId, '2.000'],
  ] as const) {
    const installed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/installations`,
      organisationId,
      payload: {
        workItemId,
        quantity,
        installedOn: '2026-08-01',
        locationId,
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);
  }

  const consignee = await authed(owner, {
    method: 'POST',
    url: '/api/masters/consignees',
    organisationId,
    payload: { designation: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
  });
  expect(consignee.statusCode, consignee.body).toBe(201);
  consigneeId = consignee.json<{ id: string }>().id;

  const secondConsignee = await authed(owner, {
    method: 'POST',
    url: '/api/masters/consignees',
    organisationId,
    payload: { designation: 'Sr. DSTE CR', address: 'Mumbai Division' },
  });
  expect(secondConsignee.statusCode, secondConsignee.body).toBe(201);
  secondConsigneeId = secondConsignee.json<{ id: string }>().id;
}, 60_000);

afterAll(async () => {
  if (admin) {
    for (const orgId of [organisationId, outsiderOrganisationId]) {
      if (!orgId) continue;
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'pac_certificate_items',
          'pac_certificates',
          'installation_serials',
          'installations',
          'work_instruments',
          'location_masters',
          'consignee_masters',
          'work_items',
          'work_schedules',
          'loa_documents',
          'works',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [orgId],
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
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('recording PAC certificates (§5.5)', () => {
  it('lets office staff record; viewers and site staff are denied', async () => {
    for (const jar of [viewer, site]) {
      const denied = await record(jar, {
        reference: 'PAC-DENIED',
        issueDate: '2026-08-05',
        consigneeMasterId: consigneeId,
        items: [{ workItemId: itemAId, certifiedQuantity: '1.000' }],
      });
      expect(denied.statusCode, denied.body).toBe(403);
    }

    const recorded = await record(office, {
      reference: 'PAC-1',
      issueDate: '2026-08-05',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '1.000' }],
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const certificate = recorded.json<PacCertificate>();
    expect(certificate.reference).toBe('PAC-1');
    expect(certificate.status).toBe('recorded');
    expect(certificate.consigneeDesignation).toBe('Sr. DEE (G) CR');
    expect(certificate.items).toEqual([
      {
        workItemId: itemAId,
        itemNumber: 'A/1',
        certifiedQuantity: '1.000',
        // Display-only released value: null until the payment-matrix
        // resolver is wired — never a stored or fabricated number.
        releasedValue: null,
      },
    ]);
    expect(certificate.releasedValue).toBeNull();
    expect(certificate.documentAvailable).toBe(false);

    const list = await listCertificates();
    expect(summaryOf(list, itemAId)).toEqual({
      workItemId: itemAId,
      itemNumber: 'A/1',
      installedQuantity: '3.000',
      pacCertifiedQuantity: '1.000',
      availableQuantity: '2.000',
    });
  });

  it('rejects the same item twice in one certificate', async () => {
    const response = await record(office, {
      reference: 'PAC-DUP-ITEM',
      issueDate: '2026-08-05',
      consigneeMasterId: consigneeId,
      items: [
        { workItemId: itemAId, certifiedQuantity: '0.500' },
        { workItemId: itemAId, certifiedQuantity: '0.500' },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('PAC_ITEMS_DUPLICATED');
  });

  it('holds the reference unique per Work among non-cancelled certificates, case-insensitively', async () => {
    const response = await record(office, {
      reference: 'pac-1',
      issueDate: '2026-08-05',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '0.500' }],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('PAC_REFERENCE_EXISTS');
  });

  it('refuses an unknown work item and a foreign work item id', async () => {
    const response = await record(office, {
      reference: 'PAC-NO-ITEM',
      issueDate: '2026-08-05',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: randomUUID(), certifiedQuantity: '1.000' }],
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('WORK_ITEM_NOT_FOUND');
  });
});

describe('issue-date guards (§5.5: >= LOA date, not future)', () => {
  it('rejects a future issue date and one before the LOA letter date', async () => {
    const future = await record(office, {
      reference: 'PAC-FUTURE',
      issueDate: '2030-01-01',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '0.100' }],
    });
    expect(future.statusCode).toBe(400);
    expect(future.json<{ code: string }>().code).toBe('PAC_DATE_FUTURE');

    const early = await record(office, {
      reference: 'PAC-EARLY',
      issueDate: '2025-05-31',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '0.100' }],
    });
    expect(early.statusCode).toBe(400);
    expect(early.json<{ code: string }>().code).toBe('PAC_DATE_BEFORE_LOA');
  });

  it('holds the date invariant in the database against every writer', async () => {
    const attempt = admin`
      insert into pac_certificates (
        organisation_id, work_id, reference, issue_date, consignee_master_id,
        consignee_designation, recorded_by_user_id
      )
      values (
        ${organisationId}, ${workId}, 'PAC-DB-GUARD', '2030-01-01',
        ${consigneeId}, 'Sr. DEE (G) CR', ${ownerUserId}
      )
    `;
    await expect(attempt).rejects.toThrow(/in the future/);
  });
});

describe('the R18 cap: certified <= installed minus already certified', () => {
  it('rejects over-certification by 0.001 with installed, covered and available', async () => {
    // A: installed 3.000, covered 1.000 (PAC-1) -> available 2.000.
    const over = await record(office, {
      reference: 'PAC-OVER',
      issueDate: '2026-08-05',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '2.001' }],
    });
    expect(over.statusCode, over.body).toBe(409);
    const body = over.json<{
      code: string;
      message: string;
      details: PacCapExceededDetails;
    }>();
    expect(body.code).toBe('PAC_EXCEEDS_INSTALLED');
    // R18: the error states all three numbers.
    expect(body.message).toContain('installed 3.000');
    expect(body.message).toContain('already certified 1.000');
    expect(body.message).toContain('available 2.000');
    expect(body.details).toEqual({
      items: [
        {
          workItemId: itemAId,
          itemNumber: 'A/1',
          installed: '3.000',
          covered: '1.000',
          available: '2.000',
        },
      ],
    });
  });

  it('accepts the exact boundary and then rejects any further certification', async () => {
    const boundary = await record(office, {
      reference: 'PAC-2',
      issueDate: '2026-08-06',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '2.000' }],
    });
    expect(boundary.statusCode, boundary.body).toBe(201);

    const list = await listCertificates();
    expect(summaryOf(list, itemAId)?.pacCertifiedQuantity).toBe('3.000');
    expect(summaryOf(list, itemAId)?.availableQuantity).toBe('0.000');

    // Multi-PAC accumulation: PAC-1 (1.000) + PAC-2 (2.000) fully cover
    // the installed 3.000; even 0.001 more must fail.
    const exhausted = await record(office, {
      reference: 'PAC-3',
      issueDate: '2026-08-06',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '0.001' }],
    });
    expect(exhausted.statusCode).toBe(409);
    const body = exhausted.json<{ code: string; message: string }>();
    expect(body.code).toBe('PAC_EXCEEDS_INSTALLED');
    expect(body.message).toContain('installed 3.000');
    expect(body.message).toContain('already certified 3.000');
    expect(body.message).toContain('available 0.000');
  });

  it('holds the cap under simultaneous certifications of the last available quantity', async () => {
    // B: installed 2.000, covered 0. Two concurrent 2.000 certifications
    // both pass a stale read — the work_items row lock serialises them,
    // so exactly one commits.
    const [first, second] = await Promise.all([
      record(office, {
        reference: 'PAC-B1',
        issueDate: '2026-08-06',
        consigneeMasterId: consigneeId,
        items: [{ workItemId: itemBId, certifiedQuantity: '2.000' }],
      }),
      record(owner, {
        reference: 'PAC-B2',
        issueDate: '2026-08-06',
        consigneeMasterId: consigneeId,
        items: [{ workItemId: itemBId, certifiedQuantity: '2.000' }],
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body} | ${second.body}`).toEqual([201, 409]);
    const list = await listCertificates();
    expect(summaryOf(list, itemBId)?.pacCertifiedQuantity).toBe('2.000');
    expect(summaryOf(list, itemBId)?.availableQuantity).toBe('0.000');
  });
});

describe('cancellation releases certified quantities', () => {
  let cancelledId: string;
  let cancelledReference: string;

  it('cancels with a mandatory note under owner/office; viewers and site denied', async () => {
    const list = await listCertificates();
    const winner = list.certificates.find(
      (certificate) =>
        certificate.status === 'recorded' &&
        certificate.items.some((line) => line.workItemId === itemBId),
    );
    if (!winner) throw new Error('concurrency winner missing from list');
    cancelledId = winner.id;
    cancelledReference = winner.reference;

    for (const jar of [viewer, site]) {
      const denied = await authed(jar, {
        method: 'POST',
        url: `/api/pac-certificates/${cancelledId}/cancel`,
        organisationId,
        payload: { note: 'Not allowed anyway' },
      });
      expect(denied.statusCode).toBe(403);
    }

    const missingNote = await authed(office, {
      method: 'POST',
      url: `/api/pac-certificates/${cancelledId}/cancel`,
      organisationId,
      payload: { note: 'no' },
    });
    expect(missingNote.statusCode).toBe(400);

    const cancelled = await authed(office, {
      method: 'POST',
      url: `/api/pac-certificates/${cancelledId}/cancel`,
      organisationId,
      payload: { note: 'Certificate superseded by the railway' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const certificate = cancelled.json<PacCertificate>();
    expect(certificate.status).toBe('cancelled');
    expect(certificate.cancellationNote).toBe('Certificate superseded by the railway');
    // The certified lines stay on the cancelled record's story.
    expect(certificate.items).toHaveLength(1);

    const again = await authed(office, {
      method: 'POST',
      url: `/api/pac-certificates/${cancelledId}/cancel`,
      organisationId,
      payload: { note: 'Cancelling twice' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe(
      'PAC_CERTIFICATE_ALREADY_CANCELLED',
    );
  });

  it('frees the cap and the reference for re-recording', async () => {
    const list = await listCertificates();
    expect(summaryOf(list, itemBId)?.pacCertifiedQuantity).toBe('0.000');
    expect(summaryOf(list, itemBId)?.availableQuantity).toBe('2.000');

    // Reuse the cancelled certificate's reference: unique only among the
    // non-cancelled, so the railway can re-issue under the same number.
    const reRecorded = await record(office, {
      reference: cancelledReference,
      issueDate: '2026-08-07',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemBId, certifiedQuantity: '2.000' }],
    });
    expect(reRecorded.statusCode, reRecorded.body).toBe(201);
  });
});

describe('consignee snapshot-on-use', () => {
  it('keeps the recorded designation when the master is renamed', async () => {
    const list = await listCertificates();
    const first = list.certificates.find(
      (certificate) => certificate.reference === 'PAC-1',
    );
    if (!first) throw new Error('PAC-1 missing from list');

    const renamed = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/consignees/${consigneeId}`,
      organisationId,
      payload: { designation: 'Sr. DEE (G) WR', address: 'Bhusawal Division' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/pac-certificates/${first.id}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<PacCertificate>().consigneeDesignation).toBe('Sr. DEE (G) CR');
  });

  it('refuses a retired consignee and an unknown one', async () => {
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/consignees/${secondConsigneeId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);

    const refused = await record(office, {
      reference: 'PAC-RETIRED-CONSIGNEE',
      issueDate: '2026-08-07',
      consigneeMasterId: secondConsigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '0.100' }],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('CONSIGNEE_MASTER_RETIRED');

    const unknown = await record(office, {
      reference: 'PAC-NO-CONSIGNEE',
      issueDate: '2026-08-07',
      consigneeMasterId: randomUUID(),
      items: [{ workItemId: itemAId, certifiedQuantity: '0.100' }],
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ code: string }>().code).toBe('CONSIGNEE_MASTER_NOT_FOUND');
  });
});

describe('scanned document upload and download', () => {
  let certificateId: string;

  it('accepts only a real PDF from owner/office', async () => {
    const list = await listCertificates();
    const first = list.certificates.find(
      (certificate) => certificate.reference === 'PAC-1',
    );
    if (!first) throw new Error('PAC-1 missing from list');
    certificateId = first.id;

    const notPdf = await authed(office, {
      method: 'POST',
      url: `/api/pac-certificates/${certificateId}/document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('plain text, not a pdf'),
    });
    expect(notPdf.statusCode).toBe(400);
    expect(notPdf.json<{ code: string }>().code).toBe('NOT_A_PDF');

    const denied = await authed(viewer, {
      method: 'POST',
      url: `/api/pac-certificates/${certificateId}/document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF_BYTES,
    });
    expect(denied.statusCode).toBe(403);

    const uploaded = await authed(office, {
      method: 'POST',
      url: `/api/pac-certificates/${certificateId}/document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF_BYTES,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json<PacCertificate>().documentAvailable).toBe(true);
  });

  it('streams the stored bytes back to any member with access', async () => {
    const downloaded = await authed(viewer, {
      method: 'GET',
      url: `/api/pac-certificates/${certificateId}/document`,
      organisationId,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toContain('application/pdf');
    expect(downloaded.rawPayload.equals(PDF_BYTES)).toBe(true);
  });

  it('refuses uploads against a cancelled certificate and 404s when absent', async () => {
    const list = await listCertificates();
    const cancelled = list.certificates.find(
      (certificate) => certificate.status === 'cancelled',
    );
    if (!cancelled) throw new Error('cancelled certificate missing from list');

    const refused = await authed(office, {
      method: 'POST',
      url: `/api/pac-certificates/${cancelled.id}/document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF_BYTES,
    });
    expect(refused.statusCode).toBe(409);

    const absent = await authed(owner, {
      method: 'GET',
      url: `/api/pac-certificates/${cancelled.id}/document`,
      organisationId,
    });
    expect(absent.statusCode).toBe(404);
    expect(absent.json<{ code: string }>().code).toBe('PDF_NOT_AVAILABLE');
  });
});

describe('tenancy and work scope', () => {
  it('answers 404 across tenants for every PAC surface', async () => {
    const list = await listCertificates();
    const first = list.certificates[0];
    if (!first) throw new Error('certificate fixture missing');

    const foreignList = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workId}/pac-certificates`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreignList.statusCode).toBe(404);

    const foreignDetail = await authed(outsider, {
      method: 'GET',
      url: `/api/pac-certificates/${first.id}`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreignDetail.statusCode).toBe(404);

    const foreignCancel = await authed(outsider, {
      method: 'POST',
      url: `/api/pac-certificates/${first.id}/cancel`,
      organisationId: outsiderOrganisationId,
      payload: { note: 'Cross-tenant attempt' },
    });
    expect(foreignCancel.statusCode).toBe(404);

    const foreignDocument = await authed(outsider, {
      method: 'GET',
      url: `/api/pac-certificates/${first.id}/document`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreignDocument.statusCode).toBe(404);
  });

  it('hides the Work from an assigned-scope member without the assignment', async () => {
    const denied = await authed(scoped, {
      method: 'GET',
      url: `/api/works/${workId}/pac-certificates`,
      organisationId,
    });
    expect(denied.statusCode).toBe(404);

    const recordDenied = await record(scoped, {
      reference: 'PAC-SCOPED',
      issueDate: '2026-08-07',
      consigneeMasterId: consigneeId,
      items: [{ workItemId: itemAId, certifiedQuantity: '0.100' }],
    });
    expect(recordDenied.statusCode).toBe(404);
  });
});

describe('audit trail, timeline, Work detail and export surfaces', () => {
  it('writes recorded / cancelled / document_uploaded events with before/after', async () => {
    const list = await listCertificates();
    const cancelled = list.certificates.find(
      (certificate) => certificate.status === 'cancelled',
    );
    if (!cancelled) throw new Error('cancelled certificate missing from list');

    const entity = await authed(owner, {
      method: 'GET',
      url: `/api/audit/entity/pac_certificates/${cancelled.id}`,
      organisationId,
    });
    expect(entity.statusCode, entity.body).toBe(200);
    const events = entity.json<TimelineResponse>().events;
    const actions = events.map((event) => event.action);
    expect(actions).toContain('pac_certificate.recorded');
    expect(actions).toContain('pac_certificate.cancelled');
    const cancelEvent = events.find(
      (event) => event.action === 'pac_certificate.cancelled',
    );
    expect(cancelEvent?.details).toMatchObject({
      before: { status: 'recorded' },
      after: { status: 'cancelled' },
    });

    const workTimeline = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/timeline?entityTypes=pac_certificates`,
      organisationId,
    });
    expect(workTimeline.statusCode, workTimeline.body).toBe(200);
    const timelineActions = workTimeline
      .json<TimelineResponse>()
      .events.map((event) => event.action);
    expect(timelineActions).toContain('pac_certificate.recorded');
    expect(timelineActions).toContain('pac_certificate.document_uploaded');
  });

  it('exposes pacCertifiedQuantity on the Work detail items', async () => {
    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const items = detail
      .json<WorkDetailResponse>()
      .schedules.flatMap((schedule) => schedule.items);
    expect(items.find((item) => item.id === itemAId)?.pacCertifiedQuantity).toBe(
      '3.000',
    );
    expect(items.find((item) => item.id === itemBId)?.pacCertifiedQuantity).toBe(
      '2.000',
    );
  });

  it('exports certificates, lines and the document manifest entry', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<{
      pacCertificates: { id: string; reference: string; status: string }[];
      pacCertificateItems: { pac_certificate_id: string }[];
      objectManifest: { kind: string; objectKey: string; sha256: string | null }[];
    }>();
    expect(exported.pacCertificates.length).toBeGreaterThanOrEqual(4);
    expect(exported.pacCertificateItems.length).toBeGreaterThanOrEqual(4);
    const manifestKinds = exported.objectManifest.map((entry) => entry.kind);
    expect(manifestKinds).toContain('pac-certificate-document');
    const documentEntry = exported.objectManifest.find(
      (entry) => entry.kind === 'pac-certificate-document',
    );
    expect(documentEntry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('coexistence and database guards', () => {
  it('keeps reference-level instrument PACs (Milestone 5) independent', async () => {
    // work_instruments kind 'pac' is a banking-reference record; the new
    // quantity-bearing certificate shares nothing with it, so the same
    // reference may exist in both without conflict.
    const instrument = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: { kind: 'pac', reference: 'PAC-1', issuedOn: '2026-08-05' },
    });
    expect(instrument.statusCode, instrument.body).toBe(201);
  });

  it('freezes recorded business data, lines, and refuses deletes in the database', async () => {
    const [certificate] = await admin<{ id: string }[]>`
      select id from pac_certificates
      where organisation_id = ${organisationId} and status = 'recorded'
      limit 1
    `;
    if (!certificate) throw new Error('recorded certificate missing');

    await expect(
      admin`update pac_certificates set reference = 'PAC-TAMPERED' where id = ${certificate.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      admin`delete from pac_certificates where id = ${certificate.id}`,
    ).rejects.toThrow(/never deleted/);
    await expect(
      admin`update pac_certificate_items set certified_quantity = 999
            where pac_certificate_id = ${certificate.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      admin`delete from pac_certificate_items where pac_certificate_id = ${certificate.id}`,
    ).rejects.toThrow(/never deleted/);
  });
});
