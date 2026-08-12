import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  BudgetaryQuotationDetailResponse,
  BudgetaryQuotationListResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Budgetary quotations (migration 0033), end to end against real
 * PostgreSQL: the full draft -> issued -> expired/converted/withdrawn
 * lifecycle, gapless `BQ-NN` numbering per ORGANISATION under the counter
 * row lock, the immutability of an issued offer, cross-tenant denial, and
 * the role/authority gates. No Work is involved anywhere — a quotation
 * precedes any award, so there is nothing to scope it to but the
 * organisation.
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
const ownerEmail = `bq-owner-${runId}@integration.test`;
const clerkEmail = `bq-clerk-${runId}@integration.test`;
const viewerEmail = `bq-viewer-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let ownerUserId: string;

/** The organisation under test. */
let organisationId: string;
/** A second organisation the same owner belongs to: its quotations must
 * be invisible — and unreachable — under the first one's header. */
let otherOrganisationId: string;
/** A third, untouched organisation, so the numbering race starts its
 * counter at one and the assertion can name the exact numbers. */
let raceOrganisationId: string;

let clientContactId: string;
let consigneeOnlyContactId: string;
let retiredClientContactId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
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

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    addressedTo: 'M/s Northern Traction Works',
    subject: 'Budgetary offer for 25kV switchgear',
    bqDate: '2026-08-01',
    ...overrides,
  };
}

const LINES = {
  lines: [
    {
      description: 'Main switchboard, 25kV outdoor type',
      hsnCode: '85371000',
      unitCode: 'Nos',
      quantity: '3',
      rate: '100.50',
      gstRate: '18',
    },
    {
      description: 'Erection, testing and commissioning',
      unitCode: 'Job',
      quantity: '1',
      rate: '2500',
      gstRate: '18.5',
    },
  ],
};
// 3 x 100.50 = 301.50, 1 x 2500 = 2500.00 — computed in SQL numeric
// arithmetic, never in JavaScript floating point.
const LINE_ONE_AMOUNT = '301.50';
const LINE_TWO_AMOUNT = '2500.00';
const TOTAL_AMOUNT = '2801.50';

async function createOrganisation(slug: string, name: string): Promise<string> {
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name, slug },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<{ id: string }>().id;
}

/** A contact with role flags the masters API does not yet expose (the
 * client role wakes with this wave), inserted directly so the quotation
 * routes can be proven against every combination they must refuse. */
async function insertContact(options: {
  designation: string;
  isClient: boolean;
  active: boolean;
}): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into contacts (
      id, organisation_id, designation, contact_person, address, phone, email,
      gstin, pincode, state_code, is_consignee, is_client, active,
      created_by_user_id
    )
    values (
      ${id}, ${organisationId}, ${options.designation}, 'A. Sharma',
      'Plot 7, Industrial Area, Jaipur', '9876543210', 'sales@example.test',
      '08AAACH7409R1ZZ', '302013', '08', ${!options.isClient},
      ${options.isClient}, ${options.active}, ${ownerUserId}
    )
  `;
  return id;
}

/** A draft with the standard two lines, ready to issue. */
async function draftWithLines(
  org: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/budgetary-quotations',
    organisationId: org,
    payload: draftBody(overrides),
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation.id;
  const saved = await authed(owner, {
    method: 'PUT',
    url: `/api/budgetary-quotations/${id}/lines`,
    organisationId: org,
    payload: LINES,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return id;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-quotation-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the budgetary quotation integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-bq-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'BQ Owner');
  clerk = await signUp(clerkEmail, 'BQ Clerk');
  viewer = await signUp(viewerEmail, 'BQ Viewer');

  organisationId = await createOrganisation(`bq-org-${runId}`, 'BQ Constructions');
  otherOrganisationId = await createOrganisation(
    `bq-other-${runId}`,
    'BQ Rival Constructions',
  );
  raceOrganisationId = await createOrganisation(
    `bq-race-${runId}`,
    'BQ Race Constructions',
  );

  for (const [email, role] of [
    [clerkEmail, 'office'],
    [viewerEmail, 'viewer'],
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

  // Issue and cancel are explicit authorities, granted to the owner only:
  // the clerk keeps drafting rights without either.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where user_id = ${ownerUserId}
  `;

  clientContactId = await insertContact({
    designation: `BQ Client ${runId}`,
    isClient: true,
    active: true,
  });
  consigneeOnlyContactId = await insertContact({
    designation: `BQ Consignee ${runId}`,
    isClient: false,
    active: true,
  });
  retiredClientContactId = await insertContact({
    designation: `BQ Retired Client ${runId}`,
    isClient: true,
    active: false,
  });
}, 60_000);

afterAll(async () => {
  if (admin) {
    // The 0033 line guard (rightly) refuses to delete the lines of an
    // issued quotation; fixture cleanup is exactly the case
    // session_replication_role exists for.
    await admin.unsafe(`set session_replication_role = 'replica'`);
    try {
      for (const org of [organisationId, otherOrganisationId, raceOrganisationId]) {
        if (!org) continue;
        for (const table of [
          'audit_events',
          'budgetary_quotation_lines',
          'budgetary_quotation_counters',
          'budgetary_quotations',
          'contacts',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [org],
          );
        }
      }
    } finally {
      await admin.unsafe(`set session_replication_role = 'origin'`);
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

describe('budgetary quotation lifecycle', () => {
  let freeTextId: string;
  let clientAddressedId: string;

  it('drafts a quotation addressed to free text, with no number and no total', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId,
      payload: draftBody({
        validUntil: '2026-09-30',
        notes: '  Prices hold for thirty days.  ',
      }),
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<BudgetaryQuotationDetailResponse>();
    freeTextId = detail.budgetaryQuotation.id;
    expect(detail.budgetaryQuotation).toMatchObject({
      status: 'draft',
      bqNumber: null,
      sequenceNumber: null,
      totalAmount: null,
      issuedAt: null,
      customerContactId: null,
      bqDate: '2026-08-01',
      validUntil: '2026-09-30',
      // Stored trimmed, so the record says what the operator meant.
      notes: 'Prices hold for thirty days.',
    });
    expect(detail.lines).toEqual([]);
    expect(detail.customerSnapshot).toBeNull();
    expect(detail.previewTotal).toBe('0.00');
  });

  it('refuses drafting to a read-only role', async () => {
    const denied = await authed(viewer, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId,
      payload: draftBody(),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });

  it('refuses an offer that expires before it is dated', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId,
      payload: draftBody({ bqDate: '2026-08-01', validUntil: '2026-07-31' }),
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: 'BQ_VALIDITY_INVALID' });
  });

  it('saves lines from an office member, pricing them in exact decimals', async () => {
    const saved = await authed(clerk, {
      method: 'PUT',
      url: `/api/budgetary-quotations/${freeTextId}/lines`,
      organisationId,
      payload: LINES,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const detail = saved.json<BudgetaryQuotationDetailResponse>();
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[0]).toMatchObject({
      lineNumber: 1,
      description: 'Main switchboard, 25kV outdoor type',
      hsnCode: '85371000',
      unitCode: 'Nos',
      quantity: '3.000',
      rate: '100.50',
      gstRate: '18.00',
      lineAmount: LINE_ONE_AMOUNT,
    });
    expect(detail.lines[1]).toMatchObject({
      lineNumber: 2,
      hsnCode: null,
      quantity: '1.000',
      rate: '2500.00',
      gstRate: '18.50',
      lineAmount: LINE_TWO_AMOUNT,
    });
    // The draft screen reads its value from the server, not from
    // JavaScript arithmetic over the lines.
    expect(detail.previewTotal).toBe(TOTAL_AMOUNT);
    expect(detail.budgetaryQuotation.totalAmount).toBeNull();

    // A wholesale replacement renumbers from one.
    const replaced = await authed(clerk, {
      method: 'PUT',
      url: `/api/budgetary-quotations/${freeTextId}/lines`,
      organisationId,
      payload: LINES,
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(
      replaced
        .json<BudgetaryQuotationDetailResponse>()
        .lines.map((line) => line.lineNumber),
    ).toEqual([1, 2]);
  });

  it('refuses a line whose unit code is blank once the database trims it', async () => {
    const response = await authed(owner, {
      method: 'PUT',
      url: `/api/budgetary-quotations/${freeTextId}/lines`,
      organisationId,
      payload: {
        lines: [
          {
            description: 'Tab-only unit code',
            // Satisfies the contract pattern (btrim removes spaces, not
            // tabs) and would reach the column as a CHECK violation.
            unitCode: '\t',
            quantity: '1',
            rate: '10',
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: 'LINE_UNIT_REQUIRED' });
    expect(response.json<{ message: string }>().message).toContain('Line 1');

    // The refusal left the saved lines untouched.
    const reread = await authed(viewer, {
      method: 'GET',
      url: `/api/budgetary-quotations/${freeTextId}`,
      organisationId,
    });
    expect(reread.json<BudgetaryQuotationDetailResponse>().lines).toHaveLength(2);
  });

  it('only accepts an active client contact as the addressee', async () => {
    const notClient = await authed(owner, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId,
      payload: draftBody({ customerContactId: consigneeOnlyContactId }),
    });
    expect(notClient.statusCode, notClient.body).toBe(409);
    expect(notClient.json()).toMatchObject({ code: 'CONTACT_NOT_CLIENT' });

    const retired = await authed(owner, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId,
      payload: draftBody({ customerContactId: retiredClientContactId }),
    });
    expect(retired.statusCode, retired.body).toBe(409);
    expect(retired.json()).toMatchObject({ code: 'CONTACT_RETIRED' });

    const missing = await authed(owner, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId,
      payload: draftBody({ customerContactId: randomUUID() }),
    });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'CONTACT_NOT_FOUND' });

    const accepted = await authed(owner, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId,
      payload: draftBody({
        customerContactId: clientContactId,
        subject: 'Budgetary offer for feeder cables',
      }),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    clientAddressedId =
      accepted.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation.id;
    const saved = await authed(owner, {
      method: 'PUT',
      url: `/api/budgetary-quotations/${clientAddressedId}/lines`,
      organisationId,
      payload: LINES,
    });
    expect(saved.statusCode, saved.body).toBe(200);
  });

  it('requires explicit issue authority', async () => {
    const denied = await authed(clerk, {
      method: 'POST',
      url: `/api/budgetary-quotations/${freeTextId}/issue`,
      organisationId,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });
  });

  it('refuses to issue a quotation with nothing to offer', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId,
      payload: draftBody({ subject: 'Empty offer' }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const emptyId =
      created.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation.id;

    const blocked = await authed(owner, {
      method: 'POST',
      url: `/api/budgetary-quotations/${emptyId}/issue`,
      organisationId,
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'BQ_EMPTY' });

    // A draft is not a document: it deletes, and takes nothing with it.
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/budgetary-quotations/${emptyId}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const gone = await authed(owner, {
      method: 'GET',
      url: `/api/budgetary-quotations/${emptyId}`,
      organisationId,
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ code: 'BUDGETARY_QUOTATION_NOT_FOUND' });
  });

  it('issues with a gapless BQ-NN and freezes the total', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/budgetary-quotations/${freeTextId}/issue`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<BudgetaryQuotationDetailResponse>();
    expect(detail.budgetaryQuotation).toMatchObject({
      status: 'issued',
      bqNumber: 'BQ-01',
      sequenceNumber: 1,
      totalAmount: TOTAL_AMOUNT,
    });
    expect(detail.budgetaryQuotation.issuedAt).not.toBeNull();
    expect(detail.previewTotal).toBe(TOTAL_AMOUNT);
    // Addressed to a stranger: there is no contact to snapshot, and
    // `addressedTo` is the whole record of who it went to.
    expect(detail.customerSnapshot).toBeNull();
  });

  it('snapshots the customer at issue, immune to later master edits', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/budgetary-quotations/${clientAddressedId}/issue`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<BudgetaryQuotationDetailResponse>();
    expect(detail.budgetaryQuotation.bqNumber).toBe('BQ-02');
    expect(detail.budgetaryQuotation.sequenceNumber).toBe(2);
    expect(detail.customerSnapshot).toMatchObject({
      contactId: clientContactId,
      designation: `BQ Client ${runId}`,
      gstin: '08AAACH7409R1ZZ',
      stateCode: '08',
    });

    // Retiring and renaming the master must never rewrite the document.
    await admin`
      update contacts
      set designation = ${`BQ Client Renamed ${runId}`}, active = false
      where id = ${clientContactId}
    `;
    const reread = await authed(viewer, {
      method: 'GET',
      url: `/api/budgetary-quotations/${clientAddressedId}`,
      organisationId,
    });
    expect(reread.statusCode, reread.body).toBe(200);
    expect(
      reread.json<BudgetaryQuotationDetailResponse>().customerSnapshot,
    ).toMatchObject({ designation: `BQ Client ${runId}` });
  });

  it('keeps an issued quotation immutable through the API and the database', async () => {
    const editLines = await authed(owner, {
      method: 'PUT',
      url: `/api/budgetary-quotations/${freeTextId}/lines`,
      organisationId,
      payload: LINES,
    });
    expect(editLines.statusCode, editLines.body).toBe(409);
    expect(editLines.json()).toMatchObject({ code: 'BQ_STATUS_CONFLICT' });

    const editHeader = await authed(owner, {
      method: 'PUT',
      url: `/api/budgetary-quotations/${freeTextId}`,
      organisationId,
      payload: draftBody({ subject: 'Rewritten after issue' }),
    });
    expect(editHeader.statusCode, editHeader.body).toBe(409);

    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/budgetary-quotations/${freeTextId}`,
      organisationId,
    });
    expect(removed.statusCode).toBe(409);

    // The 0033 trigger holds the same rule against a writer that never
    // passes through the route at all.
    await expect(
      admin`
        insert into budgetary_quotation_lines (
          organisation_id, budgetary_quotation_id, line_number, description,
          unit_code, quantity, rate, line_amount
        )
        values (
          ${organisationId}, ${freeTextId}, 99, 'Sneaked in after issue',
          'Nos', 1, 1, 1
        )
      `,
    ).rejects.toThrowError(/lines are fixed once it is issued/);
    await expect(
      admin`
        update budgetary_quotations set subject = 'Rewritten through raw SQL'
        where id = ${freeTextId}
      `,
    ).rejects.toThrowError(/business data is immutable/);

    // Nothing above disturbed the issued record.
    const reread = await authed(viewer, {
      method: 'GET',
      url: `/api/budgetary-quotations/${freeTextId}`,
      organisationId,
    });
    const detail = reread.json<BudgetaryQuotationDetailResponse>();
    expect(detail.budgetaryQuotation).toMatchObject({
      status: 'issued',
      bqNumber: 'BQ-01',
      subject: 'Budgetary offer for 25kV switchgear',
      totalAmount: TOTAL_AMOUNT,
    });
    expect(detail.lines).toHaveLength(2);
  });

  it('records the three outcomes, gated by the right authority', async () => {
    // Withdrawal is the contractor taking a document back — the cancel
    // authority's job. An office member without it may not.
    const denied = await authed(clerk, {
      method: 'POST',
      url: `/api/budgetary-quotations/${clientAddressedId}/outcome`,
      organisationId,
      payload: { outcome: 'withdrawn' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    // Recording that an offer WON is ordinary bookkeeping.
    const converted = await authed(clerk, {
      method: 'POST',
      url: `/api/budgetary-quotations/${freeTextId}/outcome`,
      organisationId,
      payload: { outcome: 'converted' },
    });
    expect(converted.statusCode, converted.body).toBe(200);
    const convertedDetail = converted.json<BudgetaryQuotationDetailResponse>();
    expect(convertedDetail.budgetaryQuotation.status).toBe('converted');
    // The number and the total survive the transition, forever.
    expect(convertedDetail.budgetaryQuotation.bqNumber).toBe('BQ-01');
    expect(convertedDetail.budgetaryQuotation.totalAmount).toBe(TOTAL_AMOUNT);

    // A quotation that has already left `issued` takes no second outcome.
    const again = await authed(owner, {
      method: 'POST',
      url: `/api/budgetary-quotations/${freeTextId}/outcome`,
      organisationId,
      payload: { outcome: 'expired' },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ code: 'BQ_STATUS_CONFLICT' });

    const withdrawn = await authed(owner, {
      method: 'POST',
      url: `/api/budgetary-quotations/${clientAddressedId}/outcome`,
      organisationId,
      payload: { outcome: 'withdrawn' },
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(
      withdrawn.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation,
    ).toMatchObject({ status: 'withdrawn', bqNumber: 'BQ-02' });

    // And an offer that simply lapsed is `expired`.
    const lapsingId = await draftWithLines(organisationId, {
      subject: 'Budgetary offer that will lapse',
    });
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/budgetary-quotations/${lapsingId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(
      issued.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation.bqNumber,
    ).toBe('BQ-03');
    const expired = await authed(clerk, {
      method: 'POST',
      url: `/api/budgetary-quotations/${lapsingId}/outcome`,
      organisationId,
      payload: { outcome: 'expired' },
    });
    expect(expired.statusCode, expired.body).toBe(200);
    expect(
      expired.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation.status,
    ).toBe('expired');

    const denialForViewer = await authed(viewer, {
      method: 'POST',
      url: `/api/budgetary-quotations/${lapsingId}/outcome`,
      organisationId,
      payload: { outcome: 'converted' },
    });
    expect(denialForViewer.statusCode).toBe(403);
    expect(denialForViewer.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });

  it('lists the organisation quotations for every member', async () => {
    const response = await authed(viewer, {
      method: 'GET',
      url: '/api/budgetary-quotations',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const list = response.json<BudgetaryQuotationListResponse>();
    const numbers = list.budgetaryQuotations
      .map((quotation) => quotation.bqNumber)
      .filter((number): number is string => number !== null)
      .sort();
    expect(numbers).toEqual(['BQ-01', 'BQ-02', 'BQ-03']);
  });

  it('writes the audit trail for the whole lifecycle', async () => {
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${freeTextId}
      order by occurred_at
    `;
    expect(events.map((event) => event.action)).toEqual([
      'budgetary_quotation.created',
      'budgetary_quotation.lines_saved',
      'budgetary_quotation.lines_saved',
      'budgetary_quotation.issued',
      'budgetary_quotation.converted',
    ]);

    const withdrawals = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId}
        and entity_id = ${clientAddressedId}
        and action = 'budgetary_quotation.withdrawn'
    `;
    expect(withdrawals).toHaveLength(1);
  });
});

describe('cross-tenant access', () => {
  let foreignId: string;

  beforeAll(async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/budgetary-quotations',
      organisationId: otherOrganisationId,
      payload: draftBody({ subject: 'Offer that belongs to the other tenant' }),
    });
    expect(created.statusCode, created.body).toBe(201);
    foreignId = created.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation.id;
  }, 30_000);

  it('answers 404 for another organisation quotation, on every verb', async () => {
    // The owner is a member of BOTH organisations, so the membership floor
    // lets the request in: it is RLS, and only RLS, that hides the row —
    // and the answer is 404, never 403, so a guessed id cannot confirm the
    // document exists somewhere else.
    const read = await authed(owner, {
      method: 'GET',
      url: `/api/budgetary-quotations/${foreignId}`,
      organisationId,
    });
    expect(read.statusCode, read.body).toBe(404);
    expect(read.json()).toMatchObject({ code: 'BUDGETARY_QUOTATION_NOT_FOUND' });

    const edited = await authed(owner, {
      method: 'PUT',
      url: `/api/budgetary-quotations/${foreignId}`,
      organisationId,
      payload: draftBody({ subject: 'Taken over from another tenant' }),
    });
    expect(edited.statusCode, edited.body).toBe(404);

    const lines = await authed(owner, {
      method: 'PUT',
      url: `/api/budgetary-quotations/${foreignId}/lines`,
      organisationId,
      payload: LINES,
    });
    expect(lines.statusCode, lines.body).toBe(404);

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/budgetary-quotations/${foreignId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(404);

    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/budgetary-quotations/${foreignId}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(404);

    // Nothing leaked into the other tenant's list either…
    const list = await authed(owner, {
      method: 'GET',
      url: '/api/budgetary-quotations',
      organisationId,
    });
    expect(
      list
        .json<BudgetaryQuotationListResponse>()
        .budgetaryQuotations.map((quotation) => quotation.id),
    ).not.toContain(foreignId);

    // …and the record itself is untouched where it does belong.
    const home = await authed(owner, {
      method: 'GET',
      url: `/api/budgetary-quotations/${foreignId}`,
      organisationId: otherOrganisationId,
    });
    expect(home.statusCode, home.body).toBe(200);
    expect(
      home.json<BudgetaryQuotationDetailResponse>().budgetaryQuotation,
    ).toMatchObject({
      status: 'draft',
      subject: 'Offer that belongs to the other tenant',
    });
  });

  it('refuses a member of neither organisation before any row is read', async () => {
    const denied = await authed(clerk, {
      method: 'GET',
      url: `/api/budgetary-quotations/${foreignId}`,
      organisationId: otherOrganisationId,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'NOT_A_MEMBER' });
  });
});

describe('BQ numbering under concurrency', () => {
  it('numbers four simultaneous issues gaplessly, one number each', async () => {
    // A fresh organisation, so its counter starts at one and the numbers
    // can be named exactly.
    const ids = await Promise.all([
      draftWithLines(raceOrganisationId, { subject: 'Race offer A' }),
      draftWithLines(raceOrganisationId, { subject: 'Race offer B' }),
      draftWithLines(raceOrganisationId, { subject: 'Race offer C' }),
      draftWithLines(raceOrganisationId, { subject: 'Race offer D' }),
    ]);

    const responses = await Promise.all(
      ids.map(async (id) =>
        authed(owner, {
          method: 'POST',
          url: `/api/budgetary-quotations/${id}/issue`,
          organisationId: raceOrganisationId,
        }),
      ),
    );
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(201);
    }

    const rows = await admin<{ bq_number: string; sequence_number: number }[]>`
      select bq_number, sequence_number from budgetary_quotations
      where organisation_id = ${raceOrganisationId} and status = 'issued'
      order by sequence_number
    `;
    expect(rows.map((row) => row.bq_number)).toEqual([
      'BQ-01',
      'BQ-02',
      'BQ-03',
      'BQ-04',
    ]);
    expect(rows.map((row) => row.sequence_number)).toEqual([1, 2, 3, 4]);
  }, 30_000);

  it('lets exactly one of two simultaneous issues win, consuming one number', async () => {
    const raceId = await draftWithLines(raceOrganisationId, {
      subject: 'Race offer E',
    });
    const [first, second] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/budgetary-quotations/${raceId}/issue`,
        organisationId: raceOrganisationId,
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/budgetary-quotations/${raceId}/issue`,
        organisationId: raceOrganisationId,
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);

    const [row] = await admin<{ bq_number: string; sequence_number: number }[]>`
      select bq_number, sequence_number from budgetary_quotations
      where id = ${raceId} and status = 'issued'
    `;
    expect(row?.bq_number).toBe('BQ-05');

    // The loser's transaction rolled its counter increment back with it,
    // so the sequence is still gapless: the counter stands at exactly the
    // number that was actually handed out.
    const [counter] = await admin<{ next_value: number }[]>`
      select next_value from budgetary_quotation_counters
      where organisation_id = ${raceOrganisationId}
    `;
    expect(counter?.next_value).toBe(5);
  }, 30_000);
});
