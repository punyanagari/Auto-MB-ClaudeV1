import { randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { AuditFacetsResponse, AuditRegisterResponse } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * The audit register, the management summary and the register workbooks
 * (migration 0095).
 *
 * What is proved here, in the order the module's risks run:
 *
 *   1. the two walls on the register — the `audit` authority and full work
 *      scope — and that neither stands in for the other;
 *   2. the retention window, which is the whole of the "retention policy":
 *      it narrows what the register shows and it never deletes a row;
 *   3. the filters, including that the cursor pages a filtered trail;
 *   4. WORK SCOPE ON AN EXPORT, which is the property with the most ways
 *      to be silently wrong: an assigned-scope member's workbook holds
 *      their Works' rows and no others, and an organisation-wide register
 *      refuses them outright rather than answering an empty file;
 *   5. the authority a register carries on top of scope (payroll on the
 *      employee register), and the MIS payroll panel's absence without it;
 *   6. the other organisation, on every read.
 *
 * The workbook assertions unpack the .xlsx the way `test/xlsx.test.ts`
 * does — there is no unzip dependency in this repository — and read the
 * sheet's inline strings, because a scope test that only counted bytes
 * would pass on a workbook containing the wrong Work.
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
const ownerEmail = `aud-owner-${runId}@integration.test`;
const auditorEmail = `aud-auditor-${runId}@integration.test`;
const scopedEmail = `aud-scoped-${runId}@integration.test`;
const plainEmail = `aud-plain-${runId}@integration.test`;
const outsiderEmail = `aud-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let organisationId: string;
let outsiderOrganisationId: string;
/** Assigned to the scoped member. */
let sharedWorkId: string;
/** Never assigned to anyone — the row an assigned-scope export must not
 * contain. */
let privateWorkId: string;
let ownerUserId: string;
let auditorUserId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let auditor: CookieJar;
let scoped: CookieJar;
let plain: CookieJar;
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

async function register(
  query = '',
  jar: CookieJar = auditor,
): Promise<AuditRegisterResponse> {
  const response = await authed(jar, {
    method: 'GET',
    url: `/api/audit-events${query}`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AuditRegisterResponse>();
}

/** The worksheet's text, for a workbook the routes just produced. Reads
 * the central directory rather than scanning, exactly as
 * `test/xlsx.test.ts` does. */
function sheetText(archive: Buffer): string {
  const end = archive.lastIndexOf(Buffer.from('504b0506', 'hex'));
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === 'xl/worksheets/sheet1.xml') {
      const bodyStart =
        localOffset +
        30 +
        archive.readUInt16LE(localOffset + 26) +
        archive.readUInt16LE(localOffset + 28);
      return inflateRawSync(
        archive.subarray(bodyStart, bodyStart + compressedSize),
      ).toString('utf8');
    }
    cursor += 46 + nameLength;
  }
  throw new Error('no worksheet in the workbook');
}

async function workbook(
  register_: string,
  jar: CookieJar,
): Promise<{ status: number; sheet: string; body: string }> {
  const response = await authed(jar, {
    method: 'GET',
    url: `/api/registers/${register_}.xlsx`,
    organisationId,
  });
  if (response.statusCode !== 200) {
    return { status: response.statusCode, sheet: '', body: response.body };
  }
  return {
    status: 200,
    sheet: sheetText(response.rawPayload),
    body: '',
  };
}

async function seedWork(code: string): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${id}, ${organisationId}, ${code}, ${`L-${code}`}, '2026-01-05',
      ${`Audit fixture ${code}`}, '10000000.00', '9000000.00', 'per_schedule',
      ${ownerUserId}
    )
  `;
  return id;
}

/** An audit row written directly, so the register's filters can be aimed
 * at known values without driving twenty routes to produce them. The
 * capture side is already covered by every module's own suite; this suite
 * is about the READ. */
async function seedEvent(event: {
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly actor?: string;
  readonly occurredAt: string;
  readonly details?: Record<string, unknown>;
}): Promise<void> {
  await admin`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id,
      occurred_at, details
    )
    values (
      ${organisationId}, ${event.actor ?? ownerUserId}, ${event.action},
      ${event.entityType}, ${event.entityId ?? null}, ${event.occurredAt},
      ${admin.json(event.details ?? {})}
    )
  `;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-audit-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
  });

  owner = await signUp(ownerEmail, 'Audit Owner');
  auditor = await signUp(auditorEmail, 'Audit Reader');
  scoped = await signUp(scopedEmail, 'Audit Scoped');
  plain = await signUp(plainEmail, 'Audit Plain');
  outsider = await signUp(outsiderEmail, 'Audit Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Audit Constructions', slug: `aud-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Audit Outsiders', slug: `aud-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const email of [auditorEmail, scopedEmail, plainEmail]) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role: 'office' },
    });
    expect(added.statusCode, added.body).toBe(201);
  }

  // The auditor holds the authority and full scope — the only combination
  // the register serves. The scoped member holds the SAME authority and
  // `work_scope = 'assigned'`, which is what makes the scope refusal a
  // real proof rather than an authority refusal wearing its clothes. The
  // plain member holds neither.
  await admin`
    update organisation_memberships set can_view_audit_trail = true
    where organisation_id = ${organisationId}
      and user_id in (
        select "id" from auth_users where "email" in (${auditorEmail}, ${scopedEmail})
      )
  `;
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${scopedEmail})
  `;
  // The scoped member also holds the PAYMENTS authority. Without it the
  // organisation-wide refusal below would be the authority wall wearing
  // the scope wall's clothes, and the test would prove nothing.
  await admin`
    update organisation_memberships set can_manage_payments = true
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${scopedEmail})
  `;

  const [ownerRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  const [auditorRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${auditorEmail}
  `;
  const [scopedRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${scopedEmail}
  `;
  if (!ownerRow || !auditorRow || !scopedRow) throw new Error('seeded users missing');
  ownerUserId = ownerRow.id;
  auditorUserId = auditorRow.id;

  sharedWorkId = await seedWork(`AUD-${runId.toUpperCase()}`);
  privateWorkId = await seedWork(`AUDP-${runId.toUpperCase()}`);
  await admin`
    insert into work_assignments (
      organisation_id, work_id, user_id, created_by_user_id
    )
    values (${organisationId}, ${sharedWorkId}, ${scopedRow.id}, ${ownerUserId})
  `;

  // Four events across three years, so the retention clamp has something
  // to clamp and the date filters have something to exclude.
  await seedEvent({
    action: 'work.created',
    entityType: 'works',
    entityId: sharedWorkId,
    occurredAt: '2026-08-01T06:00:00Z',
  });
  await seedEvent({
    action: 'challan.issued',
    entityType: 'delivery_challans',
    entityId: randomUUID(),
    actor: auditorUserId,
    occurredAt: '2026-08-05T06:00:00Z',
    details: { before: { status: 'draft' }, after: { status: 'issued' } },
  });
  await seedEvent({
    action: 'work.created',
    entityType: 'works',
    entityId: privateWorkId,
    occurredAt: '2026-08-03T06:00:00Z',
  });
  await seedEvent({
    action: 'membership.updated',
    entityType: 'organisation_memberships',
    occurredAt: '2026-07-01T06:00:00Z',
  });
  await seedEvent({
    action: 'work.created',
    entityType: 'works',
    entityId: privateWorkId,
    // Eleven years back: outside the default 96-month window and inside a
    // 132-month one, which is the pair the retention test moves between.
    occurredAt: '2015-06-01T06:00:00Z',
  });
}, 180_000);

afterAll(async () => {
  await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
  await admin`
    delete from identity_audit_events where user_id in (
      select "id" from auth_users where "email" like ${`%-${runId}@integration.test`}
    )
  `;
  await admin`
    delete from auth_users where "email" like ${`%-${runId}@integration.test`}
  `;
  await app.close();
  await admin.end();
});

describe('the walls on the audit register', () => {
  it('refuses a member without the audit authority', async () => {
    const response = await authed(plain, {
      method: 'GET',
      url: '/api/audit-events',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
  });

  it('refuses an assigned-scope member who DOES hold the authority', async () => {
    // The pair that matters: the same grant, a narrower scope, a different
    // refusal. If the register ever narrowed silently instead, this would
    // pass with a 200 and nobody would notice the missing organisation-level
    // events.
    const response = await authed(scoped, {
      method: 'GET',
      url: '/api/audit-events',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('WORK_SCOPE_FORBIDDEN');
  });

  it('refuses a member of another organisation', async () => {
    const response = await authed(outsider, {
      method: 'GET',
      url: '/api/audit-events',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('answers an unauthenticated caller with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit-events',
      headers: { 'x-organisation-id': organisationId },
    });
    expect(response.statusCode).toBe(401);
  });

  it('serves the auditor', async () => {
    const page = await register();
    expect(page.events.length).toBeGreaterThan(0);
  });
});

describe('the retention window', () => {
  it('defaults to the statutory eight years and hides what is older', async () => {
    const page = await register();
    expect(page.retentionMonths).toBe(96);
    expect(page.events.some((event) => event.occurredAt.startsWith('2015'))).toBe(
      false,
    );
  });

  it('reaches the older event once the organisation widens the window', async () => {
    const patched = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { auditRetentionMonths: 240 },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const page = await register();
    expect(page.retentionMonths).toBe(240);
    expect(page.events.some((event) => event.occurredAt.startsWith('2015'))).toBe(true);
    const restored = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { auditRetentionMonths: 96 },
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('refuses a window below the statutory floor', async () => {
    // Two layers, and this proves the outer one. The column's CHECK is the
    // backstop that must never fire; the schema refuses first, so the
    // operator gets a 400 rather than a 500 from SQLSTATE 23514.
    const response = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { auditRetentionMonths: 12 },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('leaves the older rows in the table it hides them from', async () => {
    // The whole argument of migration 0095 § 2: the policy is a viewing
    // window and it destroys nothing. A retention feature that quietly
    // deleted rows would pass every assertion above and break the law.
    const [row] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId}
        and occurred_at < '2016-01-01T00:00:00Z'
    `;
    expect(Number(row?.count ?? '0')).toBe(1);
  });

  it('refuses a window that starts after it ends', async () => {
    const response = await authed(auditor, {
      method: 'GET',
      url: '/api/audit-events?from=2026-08-10&to=2026-08-01',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('AUDIT_WINDOW_INVALID');
  });
});

describe('the register filters', () => {
  it('narrows by actor', async () => {
    const page = await register(`?actorUserId=${encodeURIComponent(auditorUserId)}`);
    expect(page.events.length).toBe(1);
    expect(page.events[0]?.action).toBe('challan.issued');
  });

  it('narrows by entity type and by action', async () => {
    const byType = await register('?entityType=works');
    expect(byType.events.every((event) => event.entityType === 'works')).toBe(true);
    const byAction = await register('?action=membership.updated');
    expect(byAction.events.length).toBe(1);
    expect(byAction.events[0]?.entityId).toBeNull();
  });

  it('narrows by an inclusive date window in the organisation timezone', async () => {
    const page = await register('?from=2026-08-05&to=2026-08-05');
    expect(page.events.length).toBe(1);
    expect(page.events[0]?.action).toBe('challan.issued');
  });

  it('carries the diff the mutation recorded, verbatim', async () => {
    const page = await register('?action=challan.issued');
    expect(page.events[0]?.details).toEqual({
      before: { status: 'draft' },
      after: { status: 'issued' },
    });
  });

  it('pages a FILTERED trail rather than the whole one', async () => {
    // The cursor and the filters have to be applied by the same predicate.
    // A page-two that forgot the filter is the classic shape of this bug.
    const first = await register('?entityType=works&limit=1');
    expect(first.events.length).toBe(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await register(
      `?entityType=works&limit=1&cursor=${String(first.nextCursor)}`,
    );
    expect(second.events.every((event) => event.entityType === 'works')).toBe(true);
    expect(second.events[0]?.id).not.toBe(first.events[0]?.id);
  });

  it('refuses a cursor that names nothing', async () => {
    const response = await authed(auditor, {
      method: 'GET',
      url: `/api/audit-events?cursor=${randomUUID()}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('CURSOR_INVALID');
  });

  it('offers filter values drawn from the trail itself', async () => {
    const response = await authed(auditor, {
      method: 'GET',
      url: '/api/audit-events/facets',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const facets = response.json<AuditFacetsResponse>();
    expect(facets.actions).toContain('challan.issued');
    expect(facets.entityTypes).toContain('organisation_memberships');
    expect(facets.actors.some((actor) => actor.userId === auditorUserId)).toBe(true);
  });
});

describe('the audit workbook', () => {
  it('answers an .xlsx and records that it was taken', async () => {
    const response = await authed(auditor, {
      method: 'GET',
      url: '/api/audit-events.xlsx',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml');
    expect(response.headers['content-disposition']).toContain('audit-trail.xlsx');
    expect(sheetText(response.rawPayload)).toContain('challan.issued');
    // Downloading every colleague's actions in one file is itself an act
    // worth recording.
    const [row] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId} and action = 'audit_trail.exported'
    `;
    expect(Number(row?.count ?? '0')).toBe(1);
  });

  it('refuses the export on the same two walls as the register', async () => {
    for (const jar of [plain, scoped]) {
      const response = await authed(jar, {
        method: 'GET',
        url: '/api/audit-events.xlsx',
        organisationId,
      });
      expect(response.statusCode, response.body).toBe(403);
    }
  });
});

describe('register workbooks and work scope', () => {
  it('gives a full-scope member every Work', async () => {
    const sheet = await workbook('works', owner);
    expect(sheet.status).toBe(200);
    expect(sheet.sheet).toContain(`AUD-${runId.toUpperCase()}`);
    expect(sheet.sheet).toContain(`AUDP-${runId.toUpperCase()}`);
  });

  it('gives an assigned-scope member ONLY their assigned Works', async () => {
    // The property with the most ways to be silently wrong, and the one
    // the brief for this pack singles out. Asserted on the sheet's own
    // text: a byte count would pass on a workbook holding the wrong Work.
    const sheet = await workbook('works', scoped);
    expect(sheet.status).toBe(200);
    expect(sheet.sheet).toContain(`AUD-${runId.toUpperCase()}`);
    expect(sheet.sheet).not.toContain(`AUDP-${runId.toUpperCase()}`);
  });

  it('refuses an assigned-scope member an organisation-wide register', async () => {
    // Vendor payments and employees belong to the company, not to a Work,
    // so there is nothing to narrow — and an empty workbook would read as
    // "there are none" rather than "this is not yours".
    const sheet = await workbook('payments', scoped);
    expect(sheet.status).toBe(403);
    expect(JSON.parse(sheet.body).code).toBe('WORK_SCOPE_FORBIDDEN');
  });

  it('requires the register’s own authority on top of scope', async () => {
    const withoutPayroll = await workbook('employees', owner);
    // The owner of a new organisation holds payroll implicitly (0089), so
    // the negative control is the member who does not.
    expect(withoutPayroll.status).toBe(200);
    const refused = await workbook('employees', plain);
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body).code).toBe('AUTHORITY_REQUIRED');
  });

  it('refuses a register name it does not know', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/registers/salaries.xlsx',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('REGISTER_UNKNOWN');
  });

  it('does not export the audit trail through the shared register route', async () => {
    // It has its own route, its own retention clamp and its own authority.
    // Reaching it through the generic one would bypass all three.
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/registers/audit-events.xlsx',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(404);
  });

  it('records every register export in the trail', async () => {
    const [row] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId} and action = 'register.exported'
    `;
    expect(Number(row?.count ?? '0')).toBeGreaterThan(0);
  });
});

describe('the management summary', () => {
  it('answers a full-scope member and refuses an assigned-scope one', async () => {
    const served = await authed(owner, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    expect(served.statusCode, served.body).toBe(200);
    const refused = await authed(scoped, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    expect(refused.statusCode, refused.body).toBe(403);
  });

  it('returns every ageing bucket every time, in a fixed order', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    const body = response.json<{
      receivablesAgeing: { bucket: string; outstanding: string }[];
      indeterminateBills: number;
      payrollCost: unknown;
    }>();
    expect(body.receivablesAgeing.map((bucket) => bucket.bucket)).toEqual([
      'unsubmitted',
      '0-30',
      '31-60',
      '61-90',
      '90+',
    ]);
    // Decimal strings summed by PostgreSQL, never a JavaScript number.
    for (const bucket of body.receivablesAgeing) {
      expect(bucket.outstanding).toMatch(/^-?\d+\.\d{2}$/);
    }
    expect(body.indeterminateBills).toBe(0);
  });

  it('answers the payroll panel only for a member who may read payroll', async () => {
    const asOwner = await authed(owner, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    expect(asOwner.json<{ payrollCost: unknown }>().payrollCost).toEqual([]);

    // The auditor holds the audit authority and full scope but not
    // payroll: the summary is still served, with that one panel absent.
    const asAuditor = await authed(auditor, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    expect(asAuditor.statusCode, asAuditor.body).toBe(200);
    expect(asAuditor.json<{ payrollCost: unknown }>().payrollCost).toBeNull();
  });

  it('refuses a member of another organisation', async () => {
    const response = await authed(outsider, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(403);
  });
});

describe('the Tally export', () => {
  it('is owner-only', async () => {
    const response = await authed(auditor, {
      method: 'GET',
      url: '/api/exports/tally.xml?from=2026-04-01&to=2027-03-31',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('answers an envelope for the owner', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/exports/tally.xml?from=2026-04-01&to=2027-03-31',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('xml');
    expect(response.body).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
  });

  it('refuses a window that starts after it ends', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/exports/tally.xml?from=2027-03-31&to=2026-04-01',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(400);
  });
});
