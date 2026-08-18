import { randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import {
  EXPORTABLE_REGISTERS,
  type AuditFacetsResponse,
  type AuditRegisterResponse,
  type MisSummaryResponse,
} from '@auto-mb/contracts';
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
/** The party every seeded invoice is raised on, and therefore the ledger
 * every Tally voucher must name. */
const BUYER_NAME = 'North Eastern Railway & Sons';
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
    url: `/api/registers/${register_}/workbook.xlsx`,
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

/** The `code` of a refusal envelope, typed rather than read off `any`. */
function refusalCode(body: string): string {
  return (JSON.parse(body) as { code: string }).code;
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
      ${admin.json((event.details ?? {}) as never)}
    )
  `;
}

/**
 * Real accounting records, so the aggregates and the Tally envelope are
 * tested against data rather than against an empty organisation.
 *
 * Written with the admin pool rather than driven through the routes: this
 * suite is about the READ side, and issuing an invoice properly takes a
 * finalized Measurement Book, a railway bill and a numbering series that
 * five other suites already prove. The shapes below are the ones the
 * database's own CHECKs accept, which is the part that matters here.
 *
 * DIRECT invoices (0039) — no Work, no Measurement Book, a stated taxable
 * value — because that shape is seedable and it doubles as the proof that
 * the tax-invoice workbook keeps a work-less row.
 *
 * Three documents and one bill:
 *
 *   * an intra-state SUBMITTED invoice, CGST+SGST, no IGST;
 *   * an inter-state SUPERSEDED invoice, IGST alone;
 *   * the full-value credit note that superseded it;
 *   * a bill submitted 95 days ago, which lands in the 90+ ageing band.
 *
 * The first two share a month, so that month carries all three tax arms —
 * which is the mixed month `gstTotal` exists for.
 */
async function seedAccountingRecords(): Promise<void> {
  // The split guard refuses a money-carrying invoice in an organisation
  // with no state of its own.
  await admin`
    update organisations set state_code = '08' where id = ${organisationId}
  `;
  const [buyer] = await admin<{ id: string }[]>`
    insert into contacts (organisation_id, designation, is_client, created_by_user_id)
    values (${organisationId}, ${BUYER_NAME}, true, ${ownerUserId})
    returning id
  `;
  if (!buyer) throw new Error('buyer contact missing');

  const insertInvoice = async (invoice: {
    readonly number: string;
    readonly sequence: number;
    readonly date: string;
    readonly placeOfSupply: string;
    readonly taxable: string;
    readonly cgst: string;
    readonly sgst: string;
    readonly igst: string;
    readonly total: string;
  }): Promise<string> => {
    const [row] = await admin<{ id: string }[]>`
      insert into tax_invoices (
        organisation_id, status, invoice_number, sequence_number, fy_label,
        invoice_date, sac_code, service_description, gst_rate,
        place_of_supply, buyer_contact_id, reverse_charge_applicable,
        stated_taxable_value, buyer_snapshot, taxable_value, cgst_amount,
        sgst_amount, igst_amount, total_amount, round_off, issued_snapshot,
        submitted_at, submitted_by_user_id, created_by_user_id
      )
      values (
        ${organisationId}, 'submitted', ${invoice.number}, ${invoice.sequence},
        '2026-27', ${invoice.date}, '995461', 'Signalling works',
        '18.00', ${invoice.placeOfSupply}, ${buyer.id}, false,
        ${invoice.taxable},
        ${admin.json({ designation: BUYER_NAME, gstin: '08AAACR1234M1ZK' })},
        ${invoice.taxable}, ${invoice.cgst}, ${invoice.sgst}, ${invoice.igst},
        ${invoice.total}, '0.00', ${admin.json({})}, now(), ${ownerUserId},
        ${ownerUserId}
      )
      returning id
    `;
    if (!row) throw new Error('invoice not seeded');
    return row.id;
  };

  await insertInvoice({
    number: `${runId}/INTRA`,
    sequence: 9001,
    date: '2026-05-14',
    placeOfSupply: '08',
    taxable: '100000.00',
    cgst: '9000.00',
    sgst: '9000.00',
    igst: '0.00',
    total: '118000.00',
  });
  const superseded = await insertInvoice({
    number: `${runId}/INTER`,
    sequence: 9002,
    date: '2026-05-20',
    placeOfSupply: '29',
    taxable: '50000.00',
    cgst: '0.00',
    sgst: '0.00',
    igst: '9000.00',
    total: '59000.00',
  });
  await admin`
    insert into credit_notes (
      organisation_id, tax_invoice_id, status, note_number, sequence_number,
      fy_label, note_date, reason, taxable_value, cgst_amount, sgst_amount,
      igst_amount, round_off, total_amount, issued_snapshot, issued_at,
      issued_by_user_id, created_by_user_id
    )
    values (
      ${organisationId}, ${superseded}, 'issued', ${`${runId}/CN`}, 9001,
      '2026-27', '2026-05-25', 'Re-measured after joint inspection',
      '50000.00', '0.00', '0.00', '9000.00', '0.00', '59000.00',
      ${admin.json({})}, now(), ${ownerUserId}, ${ownerUserId}
    )
  `;
  // Superseded only AFTER its credit note exists, which is the order
  // 0051's guards require and the order the product performs.
  await admin`
    update tax_invoices set status = 'superseded' where id = ${superseded}
  `;

  // A stock movement that belongs to NO Work. 0087's shape CHECK allows
  // one (an opening adjustment, a production receipt), and the workbook's
  // join used to drop every one of them.
  const [item] = await admin<{ id: string }[]>`
    insert into production_items (
      organisation_id, item_code, name, category, unit, created_by_user_id
    )
    values (
      ${organisationId}, ${`AUD-${runId}`}, 'Audit fixture item', 'component',
      'Nos', ${ownerUserId}
    )
    returning id
  `;
  if (!item) throw new Error('production item missing');
  await admin`
    insert into stock_movements (
      organisation_id, production_item_id, sequence_number, movement_type,
      quantity, balance_after, movement_date, reason, created_by_user_id
    )
    values (
      ${organisationId}, ${item.id}, 1, 'adjustment_in', '10.000', '10.000',
      current_date, 'Opening stock, no Work', ${ownerUserId}
    )
  `;

  await admin`
    insert into bills (
      organisation_id, work_id, bill_number, status, lines_snapshot,
      total_amount, prepared_by_user_id, submitted_at
    )
    values (
      ${organisationId}, ${sharedWorkId}, 9001, 'submitted', ${admin.json([])},
      '250000.00', ${ownerUserId}, now() - interval '95 days'
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
  await seedAccountingRecords();
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
    expect(response.json<{ code: string }>().code).toBe('EXPORT_WINDOW_INVALID');
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
    // The applied window is in the NAME, so a file on a desktop a month
    // later still says which days it covers, and the headers say whether
    // the cap cut it short.
    expect(response.headers['content-disposition']).toMatch(
      /filename="audit-trail-\d{4}-\d{2}-\d{2}-to-now\.xlsx"/,
    );
    expect(response.headers['x-auto-mb-export-truncated']).toBe('false');
    expect(response.headers['x-auto-mb-export-window-to']).toBe('now');
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
    expect(refusalCode(sheet.body)).toBe('WORK_SCOPE_FORBIDDEN');
  });

  it('requires the register’s own authority on top of scope', async () => {
    const withoutPayroll = await workbook('employees', owner);
    // The owner of a new organisation holds payroll implicitly (0089), so
    // the negative control is the member who does not.
    expect(withoutPayroll.status).toBe(200);
    const refused = await workbook('employees', plain);
    expect(refused.status).toBe(403);
    expect(refusalCode(refused.body)).toBe('AUTHORITY_REQUIRED');
  });

  it('refuses a register name it does not know before the handler runs', async () => {
    // The param is an enum, so an unknown name never reaches the tenant
    // transaction — a probe cannot spend a database lookup.
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/registers/salaries/workbook.xlsx',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('does not export the audit trail through the shared register route', async () => {
    // It has its own route, its own retention clamp and its own authority.
    // Reaching it through the generic one would bypass all three, so the
    // name is not in the shared route's enum at all and validation
    // refuses it before the handler runs.
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/registers/audit-events/workbook.xlsx',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('RUNS every register statement, not just the two the walls exercise', async () => {
    // Four of the six statements were never executed by any test, so a
    // typo in one would have shipped: a workbook route answers 500 and
    // the operator sees a broken button. Every name in the contract's
    // own list is exercised here, so adding a register without a working
    // statement fails rather than waiting to be clicked.
    for (const register of EXPORTABLE_REGISTERS) {
      const response = await authed(owner, {
        method: 'GET',
        url: `/api/registers/${register}/workbook.xlsx`,
        organisationId,
      });
      expect(response.statusCode, `${register}: ${response.body}`).toBe(200);
      // Not merely bytes: the sheet's own header row, so a statement
      // whose column count drifted from its descriptor fails here.
      expect(sheetText(response.rawPayload)).toContain('<row r="1">');
      expect(response.headers['x-auto-mb-export-truncated']).toBe('false');
    }
  });

  it('keeps a work-less stock movement, which an inner join dropped', async () => {
    const sheet = await workbook('stock-movements', owner);
    expect(sheet.status).toBe(200);
    expect(sheet.sheet).toContain(`AUD-${runId}`);
  });

  it('keeps a DIRECT invoice, which belongs to no Work', async () => {
    // The same shape as the work-less stock movement: an inner join to
    // `works` silently dropped every direct invoice (0039) from the
    // workbook while the register's own screen listed them.
    const sheet = await workbook('tax-invoices', owner);
    expect(sheet.status).toBe(200);
    expect(sheet.sheet).toContain(`${runId}/INTRA`);
  });

  it('withholds a work-less row from an assigned-scope member', async () => {
    // A direct invoice is an organisation-level fact, so the row-level
    // scope predicate must withhold it rather than the join dropping it.
    const sheet = await workbook('tax-invoices', scoped);
    expect(sheet.status).toBe(200);
    expect(sheet.sheet).not.toContain(`${runId}/INTRA`);
  });

  it('lets a member who can READ the vendor ledger export it', async () => {
    // GET /api/vendor-invoices — the read behind the screen this button
    // sits on — declares no authority, and the founder of a new
    // organisation is not granted can_manage_payments at bootstrap. An
    // export must not be harder to obtain than the screen it exports.
    const sheet = await workbook('payments', owner);
    expect(sheet.status).toBe(200);
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
    // The one seeded bill: submitted, but its Measurement Book is not
    // closed by a railway bill, so no amount is certified against it yet.
    expect(body.indeterminateBills).toBe(1);
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

  it('counts a SUPERSEDED invoice beside its credit note', async () => {
    // The pair the first cut of this dropped: a superseded invoice
    // declared its liability and was reported, and its full-value credit
    // note reverses it. Counting the note without the invoice showed the
    // month as a credit against nothing.
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const may = response
      .json<MisSummaryResponse>()
      .outputTax.find((month) => month.month === '2026-05');
    expect(may, 'the seeded month is missing from the series').toBeDefined();
    expect(may?.invoiceCount).toBe(2);
    expect(may?.taxableValue).toBe('150000.00');
    expect(may?.creditNoteCount).toBe(1);
    expect(may?.creditTotal).toBe('59000.00');
  });

  it('sums the three tax arms server-side for a mixed month', async () => {
    // May carries one intra-state invoice and one inter-state one, so all
    // three arms are non-zero and no single one of them is "the GST".
    // The screen may not add them, so the server does.
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    const may = response
      .json<MisSummaryResponse>()
      .outputTax.find((month) => month.month === '2026-05');
    expect(may?.cgst).toBe('9000.00');
    expect(may?.sgst).toBe('9000.00');
    expect(may?.igst).toBe('9000.00');
    expect(may?.gstTotal).toBe('27000.00');
    // And it is NOT the invoice total, which is what the screen printed
    // as "GST" before this field existed.
    expect(may?.total).toBe('177000.00');
  });

  it('ages a bill submitted 95 days ago into the 90+ band', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/mis/summary',
      organisationId,
    });
    const body = response.json<MisSummaryResponse>();
    const overdue = body.receivablesAgeing.find((band) => band.bucket === '90+');
    // The bill's Measurement Book is not closed, so its outstanding
    // amount is UNKNOWN rather than zero: it is counted apart and does
    // not inflate a band with an amount nobody knows.
    expect(overdue?.billCount).toBe(0);
    expect(body.indeterminateBills).toBe(1);
  });
});

describe('the Tally export', () => {
  async function envelope(): Promise<string> {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/exports/tally.xml?from=2026-04-01&to=2027-03-31',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.body;
  }

  it('names the party the invoice named, from the snapshot', async () => {
    // The defect this pins: `buyer_snapshot` has never carried a `name`
    // key — the party is `designation`, as `routes/search.ts` and the
    // invoice register both read it — so the first cut of this file
    // posted every voucher to the "Unregistered" fallback. Asserted
    // against REAL snapshot JSON rather than a hand-built object,
    // because the bug was in the shape of the stored value.
    const xml = await envelope();
    expect(xml).toContain(
      `<PARTYLEDGERNAME>North Eastern Railway &amp; Sons</PARTYLEDGERNAME>`,
    );
    expect(xml).not.toContain('Unregistered');
  });

  it('emits the superseded sale as well as its credit note', async () => {
    const xml = await envelope();
    expect(xml).toContain(`<VOUCHERNUMBER>${runId}/INTER</VOUCHERNUMBER>`);
    expect(xml).toContain(`<VOUCHERNUMBER>${runId}/CN</VOUCHERNUMBER>`);
    expect(xml).toContain('<VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME>');
  });

  it('splits the tax arms the way each invoice was raised', async () => {
    const xml = await envelope();
    // The intra-state sale carries CGST and SGST; the inter-state one
    // carries IGST. Both come off the frozen columns, never a rate.
    expect(xml).toContain('<LEDGERNAME>Output CGST</LEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>Output SGST</LEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>Output IGST</LEDGERNAME>');
  });

  it('refuses a window wider than a financial year', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/exports/tally.xml?from=2024-01-01&to=2027-03-31',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('EXPORT_WINDOW_INVALID');
  });

  it('refuses a date that looks like one and is not', async () => {
    // 2026-02-31 matches a shape-only pattern and reaches PostgreSQL as a
    // cast, which is a 500 for what is a caller's typo.
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/exports/tally.xml?from=2026-02-31&to=2026-03-31',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(400);
  });

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
