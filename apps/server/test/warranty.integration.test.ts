import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  Installation,
  LocationMaster,
  TimelineResponse,
  Warranty,
  WarrantyRegisterResponse,
  WorkWarrantyResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  removeOrganisationResidue,
} from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import { expectPinnedExportVersion } from './helpers/export-format.js';

/**
 * Defect liability periods over HTTP (migration 0099).
 *
 * What this file proves that the database suite cannot: the refusals an
 * operator actually meets. Every rule in the pack is enforced twice — once
 * by the route, with a named code and a sentence, and once by a trigger
 * that catches the writer who lost the race — and `packages/db`'s own
 * warranty suite attacks the second layer with raw SQL. This one attacks
 * the first, plus the surfaces the module joins: work-scope on the
 * register, the Work's Timeline, and the recovery export.
 *
 * The date fixtures are computed from the ORGANISATION's own today rather
 * than written as literals. A defect liability period is a window against
 * today by definition, so a literal expiry either drifts past the clock or
 * refuses to start, depending on which end of the calendar the suite runs
 * from.
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
const ownerEmail = `warr-owner-${runId}@integration.test`;
const siteEmail = `warr-site-${runId}@integration.test`;
const scopedEmail = `warr-scoped-${runId}@integration.test`;
const outsiderEmail = `warr-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let scopedUserId: string;
/** The Work every test in this file works on. */
let workId: string;
/** A SECOND Work, which the assigned-scope member is never given, so the
 * register's work-scope predicate has something to hide. */
let otherWorkId: string;
let itemId: string;
let otherItemId: string;
let locationId: string;

/** The organisation's own calendar date, and the two dates every fixture
 * is anchored to. `earliest` is the day after the LOA letter date, which
 * is the earliest an installation may be dated (the 0017 guard). */
let today: string;
let earliest: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let site: CookieJar;
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

/** One recorded installation, through the route the product uses. */
async function recordInstallation(options: {
  readonly work?: string;
  readonly item?: string;
  readonly installedOn?: string;
  readonly quantity?: string;
}): Promise<string> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${options.work ?? workId}/installations`,
    organisationId,
    payload: {
      workItemId: options.item ?? itemId,
      quantity: options.quantity ?? '1.000',
      installedOn: options.installedOn ?? today,
      locationId,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Installation>().id;
}

async function saveTerms(
  dlpMonths: number,
  startBasis: 'installation' | 'pac' | 'final_bill',
  work = workId,
) {
  return authed(owner, {
    method: 'PUT',
    url: `/api/works/${work}/warranty-terms`,
    organisationId,
    payload: { dlpMonths, startBasis },
  });
}

async function startPeriod(
  installationId: string,
  payload: Record<string, unknown> = {},
  jar: CookieJar = owner,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/installations/${installationId}/warranty`,
    organisationId,
    payload,
  });
}

async function readWorkWarranty(work = workId): Promise<WorkWarrantyResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/works/${work}/warranty`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<WorkWarrantyResponse>();
}

/** `date + days`, computed by PostgreSQL rather than in JavaScript: every
 * date in this pack is a legal date, and a UTC round trip through `Date`
 * is exactly the class of defect the pack is guarding. */
async function shiftDays(day: string, days: number): Promise<string> {
  const [row] = await admin<{ day: string }[]>`
    select (${day}::date + ${days}::int)::text as day
  `;
  if (!row) throw new Error('date shift returned no row');
  return row.day;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-warranty-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the warranty integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-warr-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'WARR Owner');
  site = await signUp(siteEmail, 'WARR Site');
  scoped = await signUp(scopedEmail, 'WARR Scoped');
  outsider = await signUp(outsiderEmail, 'WARR Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'WARR Constructions', slug: `warr-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'WARR Outsiders', slug: `warr-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [siteEmail, 'site'],
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

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" in (${ownerEmail}, ${scopedEmail})
  `;
  ownerUserId = users.find((user) => user.email === ownerEmail)?.id ?? '';
  scopedUserId = users.find((user) => user.email === scopedEmail)?.id ?? '';
  expect(ownerUserId).not.toBe('');
  expect(scopedUserId).not.toBe('');
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  workId = randomUUID();
  otherWorkId = randomUUID();
  const scheduleId = randomUUID();
  const otherScheduleId = randomUUID();
  itemId = randomUUID();
  otherItemId = randomUUID();
  for (const [id, code, schedule, item] of [
    [workId, 'WARRW', scheduleId, itemId],
    [otherWorkId, 'WARRX', otherScheduleId, otherItemId],
  ] as const) {
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${id}, ${organisationId}, ${`${code}-${runId.toUpperCase()}`},
        ${`${code}-letter-${runId}`}, '2025-06-01', 'Warranty fixture work',
        2000.00, 1800.00, 'per_schedule', ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (
        id, organisation_id, work_id, schedule_code, title, position
      )
      values (${schedule}, ${organisationId}, ${id}, 'A', 'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${item}, ${organisationId}, ${id}, ${schedule}, 'A/1',
        'Signalling relay', 'Nos', 500.000, 100.00
      )
    `;
  }

  // The assigned-scope member reaches only the first Work.
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${scopedUserId}
  `;
  await admin`
    insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
    values (${organisationId}, ${workId}, ${scopedUserId}, ${ownerUserId})
  `;

  const location = await authed(owner, {
    method: 'POST',
    url: '/api/masters/locations',
    organisationId,
    payload: { name: 'Warranty fixture station', kind: 'station' },
  });
  expect(location.statusCode, location.body).toBe(201);
  locationId = location.json<LocationMaster>().id;

  const [dates] = await admin<{ today: string; earliest: string }[]>`
    select app_private.organisation_today(${organisationId})::text as today,
           least(
             app_private.organisation_today(${organisationId}),
             w.letter_date + 1
           )::text as earliest
    from works w where w.id = ${workId}
  `;
  today = dates?.today ?? '';
  earliest = dates?.earliest ?? '';
}, 120_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
    await assertNoForeignKeyOrphans(admin);
  }
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe("the Work's warranty term", () => {
  it('is office work: site staff and outsiders are refused', async () => {
    const denied = await authed(site, {
      method: 'PUT',
      url: `/api/works/${workId}/warranty-terms`,
      organisationId,
      payload: { dlpMonths: 24, startBasis: 'installation' },
    });
    expect(denied.statusCode).toBe(403);

    const foreign = await authed(outsider, {
      method: 'PUT',
      url: `/api/works/${workId}/warranty-terms`,
      organisationId,
      payload: { dlpMonths: 24, startBasis: 'installation' },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('records, revises, and never leaves a second row behind', async () => {
    const saved = await saveTerms(24, 'installation');
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<{ dlpMonths: number }>().dlpMonths).toBe(24);

    const revised = await saveTerms(36, 'installation');
    expect(revised.statusCode, revised.body).toBe(200);
    expect(revised.json<{ dlpMonths: number }>().dlpMonths).toBe(36);

    const [count] = await admin<{ rows: string }[]>`
      select count(*)::text as rows from work_warranty_terms
      where work_id = ${workId}
    `;
    expect(count?.rows).toBe('1');

    // Back to 24 for the rest of the file.
    expect((await saveTerms(24, 'installation')).statusCode).toBe(200);
  });

  it('refuses a term outside the schema range without reaching the database', async () => {
    const tooLong = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/warranty-terms`,
      organisationId,
      payload: { dlpMonths: 240, startBasis: 'installation' },
    });
    expect(tooLong.statusCode).toBe(400);
  });
});

describe('starting a defect liability period', () => {
  it('refuses a Work with no term, naming the term as the remedy', async () => {
    const installation = await recordInstallation({
      work: otherWorkId,
      item: otherItemId,
    });
    const refused = await startPeriod(installation);
    expect(refused.statusCode, refused.body).toBe(409);
    const body = refused.json<{ code: string; remedy?: string }>();
    expect(body.code).toBe('WARRANTY_TERMS_NOT_SET');
    expect(body.remedy).toContain('Instruments tab');
  });

  it('derives the expiry from the term, and reads it back rather than predicting it', async () => {
    const installation = await recordInstallation({ installedOn: today });
    const started = await startPeriod(installation);
    expect(started.statusCode, started.body).toBe(201);
    const warranty = started.json<Warranty>();

    const [expected] = await admin<{ expiry: string }[]>`
      select app_private.warranty_expiry(${today}::date, 24)::text as expiry
    `;
    expect(warranty.dlpStartOn).toBe(today);
    expect(warranty.dlpExpiresOn).toBe(expected?.expiry);
    expect(warranty.originalExpiresOn).toBe(expected?.expiry);
    expect(warranty.standing).toBe('active');
    expect(warranty.status).toBe('active');
    // 24 months of countdown, not a stored figure.
    expect(warranty.daysToExpiry).toBeGreaterThan(700);

    const again = await startPeriod(installation);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('WARRANTY_ALREADY_STARTED');
  });

  it('refuses a cancelled installation, and an unknown one', async () => {
    const installation = await recordInstallation({});
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${installation}/cancel`,
      organisationId,
      payload: { note: 'recorded in error' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const refusedStart = await startPeriod(installation);
    expect(refusedStart.statusCode).toBe(409);
    expect(refusedStart.json<{ code: string }>().code).toBe(
      'WARRANTY_INSTALLATION_NOT_RECORDED',
    );

    const unknown = await startPeriod(randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ code: string }>().code).toBe('INSTALLATION_NOT_FOUND');
  });

  it('will not take a PAC certificate on the installation basis', async () => {
    const installation = await recordInstallation({});
    const refusedStart = await startPeriod(installation, {
      pacCertificateId: randomUUID(),
    });
    expect(refusedStart.statusCode).toBe(409);
    expect(refusedStart.json<{ code: string }>().code).toBe(
      'WARRANTY_PAC_BASIS_INVALID',
    );
  });

  it('starts from the certificate date on the PAC basis, and refuses everything else', async () => {
    expect((await saveTerms(12, 'pac')).statusCode).toBe(200);
    const installation = await recordInstallation({ installedOn: earliest });

    const noCertificate = await startPeriod(installation);
    expect(noCertificate.statusCode).toBe(409);
    expect(noCertificate.json<{ code: string }>().code).toBe(
      'WARRANTY_PAC_BASIS_INVALID',
    );

    const consignee = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation: 'Sr. DEE (G) Warranty',
        address: 'Bhusawal Division',
        roles: ['consignee'],
      },
    });
    expect(consignee.statusCode, consignee.body).toBe(201);
    const consigneeId = consignee.json<{ id: string }>().id;

    // A certificate that certifies NOTHING of this item.
    const bare = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/pac-certificates`,
      organisationId,
      payload: {
        reference: `PAC-BARE-${runId}`,
        issueDate: today,
        consigneeMasterId: consigneeId,
        items: [{ workItemId: itemId, certifiedQuantity: '1.000' }],
      },
    });
    expect(bare.statusCode, bare.body).toBe(201);
    const certificateId = bare.json<{ id: string }>().id;

    const started = await startPeriod(installation, {
      pacCertificateId: certificateId,
    });
    expect(started.statusCode, started.body).toBe(201);
    const warranty = started.json<Warranty>();
    // The start is the CERTIFICATE's date, not the installation's.
    expect(warranty.dlpStartOn).toBe(today);
    expect(warranty.startBasis).toBe('pac');
    expect(warranty.pacReference).toBe(`PAC-BARE-${runId}`);

    // A certificate of another organisation answers exactly like an
    // unknown id.
    const second = await recordInstallation({ installedOn: earliest });
    const foreign = await startPeriod(second, { pacCertificateId: randomUUID() });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json<{ code: string }>().code).toBe('PAC_CERTIFICATE_NOT_FOUND');

    expect((await saveTerms(24, 'installation')).statusCode).toBe(200);
  });
});

/**
 * The third start basis (migration 0112), over HTTP.
 *
 * `packages/db`'s warranty suite attacks the guard with raw SQL. What this
 * pair proves is the refusal an operator actually meets, and the date the
 * route writes when it does not refuse — the Work's final bill's date, and
 * never the installation date the other basis would have used.
 *
 * ON ITS OWN WORK. A Work carrying a live final Measurement Book refuses
 * new installations outright (migration 0027, restated by 0031), so
 * raising the fixture bill on the Work the rest of this file shares would
 * stop every later case from recording one. The order below is the
 * operator's real order: record the installation, raise the final bill,
 * then start the period.
 */
describe('the final-bill start basis', () => {
  const billedWorkId = randomUUID();
  const billedItemId = randomUUID();
  let installationId: string;
  /** The final bill's date: a day before today, while the units went in
   * over a year earlier. The two dates this basis could wrongly land on —
   * the installation's and the organisation's today — are therefore both
   * distinguishable from the right one. */
  let billDate: string;

  beforeAll(async () => {
    const scheduleId = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${billedWorkId}, ${organisationId}, ${`WARRB-${runId.toUpperCase()}`},
        ${`WARRB-letter-${runId}`}, '2025-06-01', 'A Work billed to its end',
        2000.00, 1800.00, 'per_schedule', ${ownerUserId}
      )
    `;
    await admin`
      insert into work_schedules (
        id, organisation_id, work_id, schedule_code, title, position
      )
      values (${scheduleId}, ${organisationId}, ${billedWorkId}, 'A',
              'Schedule A', 1)
    `;
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${billedItemId}, ${organisationId}, ${billedWorkId}, ${scheduleId},
        'A/1', 'Final-bill fixture item', 'Nos', 10.000, 100.00
      )
    `;
    billDate = await shiftDays(today, -1);
    installationId = await recordInstallation({
      work: billedWorkId,
      item: billedItemId,
      installedOn: earliest,
    });
  }, 60_000);

  it('refuses the basis while the Work has no final bill, and names what to raise', async () => {
    expect((await saveTerms(24, 'final_bill', billedWorkId)).statusCode).toBe(200);

    const refusedStart = await startPeriod(installationId);
    expect(refusedStart.statusCode, refusedStart.body).toBe(409);
    const body = refusedStart.json<{ code: string; message: string }>();
    expect(body.code).toBe('WARRANTY_FINAL_BILL_MISSING');
    // The remedy is an act, not a restatement of the refusal.
    expect(body.message).toContain('Measurement Book');

    // A certificate is not the missing piece either, and the refusal says
    // which basis this Work is actually on.
    const withCertificate = await startPeriod(installationId, {
      pacCertificateId: randomUUID(),
    });
    expect(withCertificate.statusCode).toBe(409);
    const certificateBody = withCertificate.json<{
      code: string;
      message: string;
    }>();
    expect(certificateBody.code).toBe('WARRANTY_PAC_BASIS_INVALID');
    expect(certificateBody.message).toContain('final bill');
  });

  it("starts on the final bill's date, not on the installation date", async () => {
    // The final bill, seeded as one really arrives: a final Measurement
    // Book finalised, and the bill prepared from it. There is no HTTP path
    // that raises one without a whole payment cycle behind it, and the
    // subject here is the date the bill carries, not how it came to exist.
    const bookId = randomUUID();
    await admin`
      insert into measurement_books (
        id, organisation_id, work_id, status, kind, mb_date, created_by_user_id
      )
      values (
        ${bookId}, ${organisationId}, ${billedWorkId}, 'draft', 'final',
        ${billDate}, ${ownerUserId}
      )
    `;
    await admin`
      update measurement_books
      set status = 'finalized', mb_number = ${`WARRB-${runId}-MB-FINAL`},
          sequence_number = 1, total_amount = 1000.00,
          remark_template_version = 'mb-remark-v1', finalized_at = now(),
          finalized_by_user_id = ${ownerUserId}
      where id = ${bookId}
    `;
    await admin`
      insert into bills (
        organisation_id, work_id, bill_number, lines_snapshot, total_amount,
        prepared_by_user_id, mb_id
      )
      values (
        ${organisationId}, ${billedWorkId}, 1, '[]'::jsonb, 1000.00,
        ${ownerUserId}, ${bookId}
      )
    `;

    const started = await startPeriod(installationId);
    expect(started.statusCode, started.body).toBe(201);
    const warranty = started.json<Warranty>();
    expect(warranty.startBasis).toBe('final_bill');
    expect(warranty.dlpStartOn).toBe(billDate);
    expect(warranty.installedOn).toBe(earliest);
    // No certificate is involved on this basis.
    expect(warranty.pacReference).toBeNull();
    // The expiry is the database's own, read back rather than predicted —
    // and measured from the bill date, which is the point of the basis.
    const [expected] = await admin<{ expiry: string }[]>`
      select app_private.warranty_expiry(${billDate}::date, 24)::text as expiry
    `;
    expect(warranty.dlpExpiresOn).toBe(expected?.expiry);
  });
});

describe('a live defect liability period', () => {
  it('extends forward only, and records the reason on the Work timeline', async () => {
    const installation = await recordInstallation({});
    const started = await startPeriod(installation);
    expect(started.statusCode, started.body).toBe(201);
    const warranty = started.json<Warranty>();

    const backwards = await authed(owner, {
      method: 'POST',
      url: `/api/warranties/${warranty.id}/extend`,
      organisationId,
      payload: {
        expiresOn: await shiftDays(warranty.dlpExpiresOn, -1),
        reason: 'typo',
      },
    });
    expect(backwards.statusCode).toBe(409);
    expect(backwards.json<{ code: string }>().code).toBe('WARRANTY_EXTENSION_INVALID');

    const past = await authed(owner, {
      method: 'POST',
      url: `/api/warranties/${warranty.id}/extend`,
      organisationId,
      payload: {
        expiresOn: await shiftDays(warranty.dlpStartOn, 4000),
        reason: 'far too long',
      },
    });
    expect(past.statusCode).toBe(409);
    expect(past.json<{ code: string }>().code).toBe('WARRANTY_EXTENSION_INVALID');

    const target = await shiftDays(warranty.dlpExpiresOn, 90);
    const extended = await authed(owner, {
      method: 'POST',
      url: `/api/warranties/${warranty.id}/extend`,
      organisationId,
      payload: { expiresOn: target, reason: 'Relay replaced under warranty' },
    });
    expect(extended.statusCode, extended.body).toBe(200);
    const after = extended.json<Warranty>();
    expect(after.dlpExpiresOn).toBe(target);
    // What the period BEGAN with survives, so an extended record still
    // says what it was.
    expect(after.originalExpiresOn).toBe(warranty.dlpExpiresOn);

    // The reason lives in the audit trail and nowhere else, which is why
    // the pack keeps no extension table.
    const timeline = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/timeline`,
      organisationId,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    const events = timeline.json<TimelineResponse>().events;
    const extension = events.find(
      (event) => event.action === 'installation_warranty.extended',
    );
    expect(extension, 'the extension is on the Work timeline').toBeDefined();
    expect(JSON.stringify(extension?.details)).toContain(
      'Relay replaced under warranty',
    );
  });

  it('refuses a discharge before the expiry and one in the future', async () => {
    const installation = await recordInstallation({});
    const warranty = (await startPeriod(installation)).json<Warranty>();

    const early = await authed(owner, {
      method: 'POST',
      url: `/api/warranties/${warranty.id}/close`,
      organisationId,
      payload: { closedOn: today, note: 'no defects reported' },
    });
    expect(early.statusCode).toBe(409);
    const body = early.json<{ code: string; remedy?: string }>();
    expect(body.code).toBe('WARRANTY_END_INVALID');
    expect(body.remedy).toContain('voided rather than closed');
  });

  it('discharges an elapsed period, and is terminal afterwards', async () => {
    // One month from the earliest date this Work admits has long since
    // elapsed.
    expect((await saveTerms(1, 'installation')).statusCode).toBe(200);
    const installation = await recordInstallation({ installedOn: earliest });
    const warranty = (await startPeriod(installation)).json<Warranty>();
    expect(warranty.standing).toBe('elapsed');
    expect(warranty.daysToExpiry).toBeLessThan(0);

    const future = await authed(owner, {
      method: 'POST',
      url: `/api/warranties/${warranty.id}/close`,
      organisationId,
      payload: {
        closedOn: await shiftDays(today, 1),
        note: 'no defects reported',
      },
    });
    expect(future.statusCode).toBe(409);
    expect(future.json<{ code: string }>().code).toBe('WARRANTY_END_INVALID');

    const closed = await authed(owner, {
      method: 'POST',
      url: `/api/warranties/${warranty.id}/close`,
      organisationId,
      payload: { closedOn: today, note: 'No defect reported in the period' },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const discharged = closed.json<Warranty>();
    expect(discharged.status).toBe('closed');
    expect(discharged.standing).toBe('closed');
    // A countdown on a period that is no longer running means nothing.
    expect(discharged.daysToExpiry).toBeNull();

    for (const action of ['close', 'extend', 'void']) {
      const again = await authed(owner, {
        method: 'POST',
        url: `/api/warranties/${warranty.id}/${action}`,
        organisationId,
        payload:
          action === 'extend'
            ? { expiresOn: await shiftDays(today, 30), reason: 'reopen it' }
            : action === 'close'
              ? { closedOn: today, note: 'again' }
              : { note: 'undo the discharge' },
      });
      expect(again.statusCode, `${action}: ${again.body}`).toBe(409);
      expect(again.json<{ code: string }>().code).toBe('WARRANTY_STATE');
    }

    // A DISCHARGED period makes its installation permanent, and the
    // refusal says so rather than pointing at a void that would itself
    // be refused.
    const cancel = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${installation}/cancel`,
      organisationId,
      payload: { note: 'recorded in error' },
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json<{ code: string; message: string }>().message).toContain(
      'permanent',
    );

    expect((await saveTerms(24, 'installation')).statusCode).toBe(200);
  });

  it('blocks its installation from being cancelled until it is voided', async () => {
    const installation = await recordInstallation({});
    const warranty = (await startPeriod(installation)).json<Warranty>();

    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${installation}/cancel`,
      organisationId,
      payload: { note: 'recorded in error' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe(
      'INSTALLATION_HAS_WARRANTY_PERIOD',
    );

    const voided = await authed(owner, {
      method: 'POST',
      url: `/api/warranties/${warranty.id}/void`,
      organisationId,
      payload: { note: 'started against the wrong installation' },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json<Warranty>().standing).toBe('voided');

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${installation}/cancel`,
      organisationId,
      payload: { note: 'recorded in error' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
  });
});

describe("the Work's warranty card", () => {
  it('offers only installations with no live period, and reports guarantee cover', async () => {
    const before = await readWorkWarranty();
    const offered = new Set(before.candidates.map((row) => row.installationId));
    const installation = await recordInstallation({});
    const after = await readWorkWarranty();
    expect(after.candidates.map((row) => row.installationId)).toContain(installation);

    const warranty = (await startPeriod(installation)).json<Warranty>();
    const started = await readWorkWarranty();
    expect(started.candidates.map((row) => row.installationId)).not.toContain(
      installation,
    );
    expect(offered.size).toBeGreaterThanOrEqual(0);

    // No guarantee recorded yet: cover runs to the furthest period, and
    // the shortfall has no answer rather than an answer of zero.
    expect(started.pbgCover.dlpCoverUntil).not.toBeNull();
    expect(started.pbgCover.instrumentExpiresOn).toBeNull();
    expect(started.pbgCover.shortfallDays).toBeNull();

    // A guarantee that lapses before the FURTHEST period does — the
    // cover reading is a Work-wide maximum, not this one period's expiry,
    // which is exactly the distinction an office gets wrong by hand.
    const coverUntil = started.pbgCover.dlpCoverUntil ?? warranty.dlpExpiresOn;
    const short = await shiftDays(coverUntil, -45);
    const instrument = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG/${runId}`,
        amount: '90000.00',
        issuedOn: today,
        expiresOn: short,
      },
    });
    expect(instrument.statusCode, instrument.body).toBe(201);

    const covered = await readWorkWarranty();
    expect(covered.pbgCover.instrumentReference).toBe(`BG/${runId}`);
    expect(covered.pbgCover.instrumentExpiresOn).toBe(short);
    expect(covered.pbgCover.shortfallDays).toBe(45);

    // A guarantee reaching past every period is no shortfall at all.
    const long = await shiftDays(covered.pbgCover.dlpCoverUntil ?? today, 30);
    const renewed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG/${runId}/R1`,
        amount: '90000.00',
        issuedOn: today,
        expiresOn: long,
      },
    });
    expect(renewed.statusCode, renewed.body).toBe(201);
    const renewedCover = await readWorkWarranty();
    expect(renewedCover.pbgCover.shortfallDays).toBeNull();
    expect(renewedCover.pbgCover.instrumentReference).toBe(`BG/${runId}/R1`);
  });

  it('clears the shortfall once every period has been discharged', async () => {
    /* The cover reading counts ACTIVE periods, and this walk is why. It
       used to count every period that was not voided — which includes the
       discharged ones, and a discharged period always expired on or before
       today. So a Work whose liability had been fully seen out reported a
       shortfall against a guarantee it was by then free to release, and no
       act left to the operator could ever clear it: the card said "extend
       this guarantee" about a guarantee that should have been released.

       The second Work is used because this one carries live periods from
       the tests above, and the point of the walk is a Work with none. */
    expect((await saveTerms(3, 'installation', otherWorkId)).statusCode).toBe(200);
    const installation = await recordInstallation({
      work: otherWorkId,
      item: otherItemId,
      installedOn: earliest,
    });
    const period = (await startPeriod(installation)).json<Warranty>();
    expect(period.standing).toBe('elapsed');

    // A guarantee that lapsed a month before the liability ran out: a
    // real shortfall for as long as the period is still standing.
    const lapsed = await shiftDays(period.dlpExpiresOn, -30);
    const instrument = await authed(owner, {
      method: 'POST',
      url: `/api/works/${otherWorkId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG/${runId}/DLP`,
        amount: '50000.00',
        issuedOn: earliest,
        expiresOn: lapsed,
      },
    });
    expect(instrument.statusCode, instrument.body).toBe(201);

    const standing = await readWorkWarranty(otherWorkId);
    expect(standing.pbgCover.dlpCoverUntil).toBe(period.dlpExpiresOn);
    expect(standing.pbgCover.shortfallDays).toBe(30);

    // The dashboard counts the SAME guarantee down on its own, and used
    // to do it with no reference to the warranty measuring it — so the
    // two instruments could contradict each other on the same day. The
    // alert now carries the cover date it is measured against.
    const dashboard = await authed(owner, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const alert = dashboard
      .json<{ alerts: { workId: string | null; message: string }[] }>()
      .alerts.find(
        (row) => row.workId === otherWorkId && row.message.includes(`BG/${runId}/DLP`),
      );
    expect(alert?.message).toContain(
      `Defect liability cover on this Work runs to ${period.dlpExpiresOn}`,
    );

    const closed = await authed(owner, {
      method: 'POST',
      url: `/api/warranties/${period.id}/close`,
      organisationId,
      payload: { closedOn: today, note: 'No defect reported in the period' },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json<Warranty>().status).toBe('closed');

    // Nothing is under warranty any more, so there is nothing left to
    // cover: the reading goes back to unanswerable rather than staying
    // stuck on a shortfall with no act behind it. The instrument is still
    // reported, because "which guarantee was this measured against" stays
    // a question the card can answer.
    const discharged = await readWorkWarranty(otherWorkId);
    expect(discharged.pbgCover.dlpCoverUntil).toBeNull();
    expect(discharged.pbgCover.shortfallDays).toBeNull();
    expect(discharged.pbgCover.instrumentReference).toBe(`BG/${runId}/DLP`);
  });
});

describe('the warranty register', () => {
  it('shows only the Works a member may see, and refuses a cursor from outside them', async () => {
    // Give the second Work a term and a period, which the assigned-scope
    // member must never see.
    expect((await saveTerms(24, 'installation', otherWorkId)).statusCode).toBe(200);
    const hidden = await recordInstallation({
      work: otherWorkId,
      item: otherItemId,
    });
    const hiddenWarranty = (await startPeriod(hidden)).json<Warranty>();

    const full = await authed(owner, {
      method: 'GET',
      url: '/api/warranties?limit=100',
      organisationId,
    });
    expect(full.statusCode, full.body).toBe(200);
    const everything = full.json<WarrantyRegisterResponse>().warranties;
    expect(everything.map((row) => row.id)).toContain(hiddenWarranty.id);

    const narrow = await authed(scoped, {
      method: 'GET',
      url: '/api/warranties?limit=100',
      organisationId,
    });
    expect(narrow.statusCode, narrow.body).toBe(200);
    const visible = narrow.json<WarrantyRegisterResponse>().warranties;
    expect(visible.map((row) => row.workId)).not.toContain(otherWorkId);
    expect(visible.length).toBeGreaterThan(0);

    // A cursor naming a row the caller may not list is refused exactly as
    // a nonexistent one is.
    const forged = await authed(scoped, {
      method: 'GET',
      url: `/api/warranties?limit=10&cursor=${hiddenWarranty.id}`,
      organisationId,
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json<{ code: string }>().code).toBe('CURSOR_INVALID');

    const nonexistent = await authed(scoped, {
      method: 'GET',
      url: `/api/warranties?limit=10&cursor=${randomUUID()}`,
      organisationId,
    });
    expect(nonexistent.statusCode).toBe(400);
    expect(nonexistent.json<{ code: string }>().code).toBe('CURSOR_INVALID');
  });

  it('orders by expiry and narrows by standing and horizon', async () => {
    const page = await authed(owner, {
      method: 'GET',
      url: '/api/warranties?limit=100',
      organisationId,
    });
    const rows = page.json<WarrantyRegisterResponse>().warranties;
    expect(rows.length).toBeGreaterThan(1);
    const expiries = rows.map((row) => row.dlpExpiresOn);
    expect([...expiries].sort()).toEqual(expiries);

    const closed = await authed(owner, {
      method: 'GET',
      url: '/api/warranties?limit=100&standing=closed',
      organisationId,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const discharged = closed.json<WarrantyRegisterResponse>().warranties;
    expect(discharged.length).toBeGreaterThan(0);
    expect(discharged.every((row) => row.standing === 'closed')).toBe(true);

    const horizon = await authed(owner, {
      method: 'GET',
      url: `/api/warranties?limit=100&expiresBefore=${today}`,
      organisationId,
    });
    expect(horizon.statusCode, horizon.body).toBe(200);
    expect(
      horizon
        .json<WarrantyRegisterResponse>()
        .warranties.every((row) => row.dlpExpiresOn <= today),
    ).toBe(true);
  });

  it('pages with a cursor that does not repeat or skip a row', async () => {
    const first = await authed(owner, {
      method: 'GET',
      url: '/api/warranties?limit=1',
      organisationId,
    });
    expect(first.statusCode, first.body).toBe(200);
    const firstPage = first.json<WarrantyRegisterResponse>();
    expect(firstPage.warranties).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await authed(owner, {
      method: 'GET',
      url: `/api/warranties?limit=1&cursor=${String(firstPage.nextCursor)}`,
      organisationId,
    });
    expect(second.statusCode, second.body).toBe(200);
    const secondPage = second.json<WarrantyRegisterResponse>();
    expect(secondPage.warranties[0]?.id).not.toBe(firstPage.warranties[0]?.id);
  });
});

describe('the recovery export', () => {
  it('carries both warranty tables under the pack’s format version', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const exported = response.json<{
      formatVersion: string;
      workWarrantyTerms: { work_id: string }[];
      installationWarranties: { dlp_expires_on: string; status: string }[];
    }>();
    expectPinnedExportVersion(exported.formatVersion);
    expect(exported.workWarrantyTerms.map((row) => row.work_id)).toContain(workId);
    expect(exported.installationWarranties.length).toBeGreaterThan(0);
    // The expiry travels as a stored legal date, which is what makes the
    // package self-sufficient: a restore does not recompute it from a
    // term the Work may since have corrected.
    expect(
      exported.installationWarranties.every(
        (row) => typeof row.dlp_expires_on === 'string',
      ),
    ).toBe(true);
  });
});
