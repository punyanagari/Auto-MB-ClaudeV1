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
 * the role/authority gates. No Work is involved anywhere â€” a quotation
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
 * be invisible â€” and unreachable â€” under the first one's header. */
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
// 3 x 100.50 = 301.50, 1 x 2500 = 2500.00 â€” computed in SQL numeric
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
    c×My¶‰žËkºwµç}‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í•µÁÑå%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡½¹”¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÐ¤ì(€€€•áÁ•Ð¡½¹”¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€	UQIe}EU=QQ%=9}9=Q}=U9œô¤ì(€ô¤ì((€¥Ð ¥ÍÍÕ•ÌÝ¥Ñ „…Á±•ÍÌ	Dµ98…¹™É••é•ÌÑ¡”Ñ½Ñ…°œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™É••Q•áÑ%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ‘•Ñ…¥°€ôÉ•ÍÁ½¹Í”¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€¥ÍÍÕ•œ°(€€€€€‰Å9Õµ‰•Èè€	D´ÀÄœ°(€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€Ä°(€€€€€Ñ½Ñ…±µ½Õ¹ÐèQ=Q1}5=U9P°(€€€ô¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹¥ÍÍÕ•‘Ð¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹ÁÉ•Ù¥•ÝQ½Ñ…°¤¹Ñ½	”¡Q=Q1}5=U9P¤ì(€€€€¼¼‘‘É•ÍÍ•Ñ¼„ÍÑÉ…¹•ÈèÑ¡•É”¥Ì¹¼½¹Ñ…ÐÑ¼Í¹…ÁÍ¡½Ð°…¹(€€€€¼¼…‘‘É•ÍÍ•‘Q½€¥ÌÑ¡”Ý¡½±”É•½É½˜Ý¡¼¥ÐÝ•¹ÐÑ¼¸(€€€•áÁ•Ð¡‘•Ñ…¥°¹ÕÍÑ½µ•ÉM¹…ÁÍ¡½Ð¤¹Ñ½	•9Õ±° ¤ì(€ô¤ì((€¥Ð Í¹…ÁÍ¡½ÑÌÑ¡”ÕÍÑ½µ•È…Ð¥ÍÍÕ”°¥µµÕ¹”Ñ¼±…Ñ•Èµ…ÍÑ•È•‘¥ÑÌœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í±¥•¹Ñ‘‘É•ÍÍ•‘%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ‘•Ñ…¥°€ôÉ•ÍÁ½¹Í”¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹‰Å9Õµ‰•È¤¹Ñ½	” 	D´ÀÈœ¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹Í•ÅÕ•¹•9Õµ‰•È¤¹Ñ½	” È¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹ÕÍÑ½µ•ÉM¹…ÁÍ¡½Ð¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€½¹Ñ…Ñ%è±¥•¹Ñ½¹Ñ…Ñ%°(€€€€€‘•Í¥¹…Ñ¥½¸è	D±¥•¹Ð€‘íÉÕ¹%‘õ€°(€€€€€ÍÑ¥¸è€œÀá ÜÐÀåHÅihœ°(€€€€€ÍÑ…Ñ•½‘”è€œÀàœ°(€€€ô¤ì((€€€€¼¼I•Ñ¥É¥¹œ…¹É•¹…µ¥¹œÑ¡”µ…ÍÑ•ÈµÕÍÐ¹•Ù•ÈÉ•ÝÉ¥Ñ”Ñ¡”‘½Õµ•¹Ð¸(€€€…Ý…¥Ð…‘µ¥¹€(€€€€€ÕÁ‘…Ñ”½¹Ñ…ÑÌ(€€€€€Í•Ð‘•Í¥¹…Ñ¥½¸€ô€‘í	D±¥•¹ÐI•¹…µ•€‘íÉÕ¹%‘õô°…Ñ¥Ù”€ô™…±Í”(€€€€€Ý¡•É”¥€ô€‘í±¥•¹Ñ½¹Ñ…Ñ%‘ô(€€€€ì(€€€½¹ÍÐÉ•É•…€ô…Ý…¥Ð…ÕÑ¡•¡Ù¥•Ý•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í±¥•¹Ñ‘‘É•ÍÍ•‘%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•É•…¹ÍÑ…ÑÕÍ½‘”°É•É•…¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð (€€€€€É•É•…¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹ÕÍÑ½µ•ÉM¹…ÁÍ¡½Ð°(€€€€¤¹Ñ½5…Ñ¡=‰©•Ð¡ì‘•Í¥¹…Ñ¥½¸è	D±¥•¹Ð€‘íÉÕ¹%‘õ€ô¤ì(€ô¤ì((€¥Ð ­••ÁÌ…¸¥ÍÍÕ•ÅÕ½Ñ…Ñ¥½¸¥µµÕÑ…‰±”Ñ¡É½Õ Ñ¡”A$…¹Ñ¡”‘…Ñ…‰…Í”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ•‘¥Ñ1¥¹•Ì€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™É••Q•áÑ%‘ô½±¥¹•Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…è1%9L°(€€€ô¤ì(€€€•áÁ•Ð¡•‘¥Ñ1¥¹•Ì¹ÍÑ…ÑÕÍ½‘”°•‘¥Ñ1¥¹•Ì¹‰½‘ä¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡•‘¥Ñ1¥¹•Ì¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€	E}MQQUM}=91%Pœô¤ì((€€€½¹ÍÐ•‘¥Ñ!•…‘•È€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™É••Q•áÑ%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…è‘É…™Ñ	½‘ä¡ìÍÕ‰©•Ðè€I•ÝÉ¥ÑÑ•¸…™Ñ•È¥ÍÍÕ”œô¤°(€€€ô¤ì(€€€•áÁ•Ð¡•‘¥Ñ!•…‘•È¹ÍÑ…ÑÕÍ½‘”°•‘¥Ñ!•…‘•È¹‰½‘ä¤¹Ñ½	” ÐÀä¤ì((€€€½¹ÍÐÉ•µ½Ù•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€1Qœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™É••Q•áÑ%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•µ½Ù•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì((€€€€¼¼Q¡”€ÀÀÌÌÑÉ¥•È¡½±‘ÌÑ¡”Í…µ”ÉÕ±”……¥¹ÍÐ„ÝÉ¥Ñ•ÈÑ¡…Ð¹•Ù•È(€€€€¼¼Á…ÍÍ•ÌÑ¡É½Õ Ñ¡”É½ÕÑ”…Ð…±°¸(€€€…Ý…¥Ð•áÁ•Ð (€€€€€…‘µ¥¹€(€€€€€€€¥¹Í•ÉÐ¥¹Ñ¼‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¹}±¥¹•Ì€ (€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¹}¥°±¥¹•}¹Õµ‰•È°‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€€Õ¹¥Ñ}½‘”°ÅÕ…¹Ñ¥Ñä°É…Ñ”°±¥¹•}…µ½Õ¹Ð(€€€€€€€€¤(€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘í™É••Q•áÑ%‘ô°€ää°€M¹•…­•¥¸…™Ñ•È¥ÍÍÕ”œ°(€€€€€€€€€€9½Ìœ°€Ä°€Ä°€Ä(€€€€€€€€¤(€€€€€€°(€€€€¤¹É•©•ÑÌ¹Ñ½Q¡É½ÝÉÉ½È ½±¥¹•Ì…É”™¥á•½¹”¥Ð¥Ì¥ÍÍÕ•¼¤ì(€€€…Ý…¥Ð•áÁ•Ð (€€€€€…‘µ¥¹€(€€€€€€€ÕÁ‘…Ñ”‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¹ÌÍ•ÐÍÕ‰©•Ð€ô€I•ÝÉ¥ÑÑ•¸Ñ¡É½Õ É…ÜME0œ(€€€€€€€Ý¡•É”¥€ô€‘í™É••Q•áÑ%‘ô(€€€€€€°(€€€€¤¹É•©•ÑÌ¹Ñ½Q¡É½ÝÉÉ½È ½‰ÕÍ¥¹•ÍÌ‘…Ñ„¥Ì¥µµÕÑ…‰±”¼¤ì((€€€€¼¼9½Ñ¡¥¹œ…‰½Ù”‘¥ÍÑÕÉ‰•Ñ¡”¥ÍÍÕ•É•½É¸(€€€½¹ÍÐÉ•É•…€ô…Ý…¥Ð…ÕÑ¡•¡Ù¥•Ý•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™É••Q•áÑ%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€½¹ÍÐ‘•Ñ…¥°€ôÉ•É•…¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€¥ÍÍÕ•œ°(€€€€€‰Å9Õµ‰•Èè€	D´ÀÄœ°(€€€€€ÍÕ‰©•Ðè€	Õ‘•Ñ…Éä½™™•È™½È€ÈÕ­XÍÝ¥Ñ¡•…Èœ°(€€€€€Ñ½Ñ…±µ½Õ¹ÐèQ=Q1}5=U9P°(€€€ô¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹±¥¹•Ì¤¹Ñ½!…Ù•1•¹Ñ  È¤ì(€ô¤ì((€¥Ð É•½É‘ÌÑ¡”Ñ¡É•”½ÕÑ½µ•Ì°…Ñ•‰äÑ¡”É¥¡Ð…ÕÑ¡½É¥Ñäœ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼]¥Ñ¡‘É…Ý…°¥ÌÑ¡”½¹ÑÉ…Ñ½ÈÑ…­¥¹œ„‘½Õµ•¹Ð‰…¬ƒŠPÑ¡”…¹•°(€€€€¼¼…ÕÑ¡½É¥ÑäÌ©½ˆ¸¸½™™¥”µ•µ‰•ÈÝ¥Ñ¡½ÕÐ¥Ðµ…ä¹½Ð¸(€€€½¹ÍÐ‘•¹¥•€ô…Ý…¥Ð…ÕÑ¡•¡±•É¬°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í±¥•¹Ñ‘‘É•ÍÍ•‘%‘ô½½ÕÑ½µ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì½ÕÑ½µ”è€Ý¥Ñ¡‘É…Ý¸œô°(€€€ô¤ì(€€€•áÁ•Ð¡‘•¹¥•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÌ¤ì(€€€•áÁ•Ð¡‘•¹¥•¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€UQ!=I%Qe}IEU%Iœô¤ì((€€€€¼¼I•½É‘¥¹œÑ¡…Ð…¸½™™•È]=8¥Ì½É‘¥¹…Éä‰½½­­••Á¥¹œ¸(€€€½¹ÍÐ½¹Ù•ÉÑ•€ô…Ý…¥Ð…ÕÑ¡•¡±•É¬°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™É••Q•áÑ%‘ô½½ÕÑ½µ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì½ÕÑ½µ”è€½¹Ù•ÉÑ•œô°(€€€ô¤ì(€€€•áÁ•Ð¡½¹Ù•ÉÑ•¹ÍÑ…ÑÕÍ½‘”°½¹Ù•ÉÑ•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐ½¹Ù•ÉÑ•‘•Ñ…¥°€ô½¹Ù•ÉÑ•¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ð¡½¹Ù•ÉÑ•‘•Ñ…¥°¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹ÍÑ…ÑÕÌ¤¹Ñ½	” ½¹Ù•ÉÑ•œ¤ì(€€€€¼¼Q¡”¹Õµ‰•È…¹Ñ¡”Ñ½Ñ…°ÍÕÉÙ¥Ù”Ñ¡”ÑÉ…¹Í¥Ñ¥½¸°™½É•Ù•È¸(€€€•áÁ•Ð¡½¹Ù•ÉÑ•‘•Ñ…¥°¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹‰Å9Õµ‰•È¤¹Ñ½	” 	D´ÀÄœ¤ì(€€€•áÁ•Ð¡½¹Ù•ÉÑ•‘•Ñ…¥°¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹Ñ½Ñ…±µ½Õ¹Ð¤¹Ñ½	”¡Q=Q1}5=U9P¤ì((€€€€¼¼ÅÕ½Ñ…Ñ¥½¸Ñ¡…Ð¡…Ì…±É•…‘ä±•™Ð¥ÍÍÕ•‘€Ñ…­•Ì¹¼Í•½¹½ÕÑ½µ”¸(€€€½¹ÍÐ……¥¸€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™É••Q•áÑ%‘ô½½ÕÑ½µ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì½ÕÑ½µ”è€•áÁ¥É•œô°(€€€ô¤ì(€€€•áÁ•Ð¡……¥¸¹ÍÑ…ÑÕÍ½‘”°……¥¸¹‰½‘ä¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡……¥¸¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€	E}MQQUM}=91%Pœô¤ì((€€€½¹ÍÐÝ¥Ñ¡‘É…Ý¸€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í±¥•¹Ñ‘‘É•ÍÍ•‘%‘ô½½ÕÑ½µ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì½ÕÑ½µ”è€Ý¥Ñ¡‘É…Ý¸œô°(€€€ô¤ì(€€€•áÁ•Ð¡Ý¥Ñ¡‘É…Ý¸¹ÍÑ…ÑÕÍ½‘”°Ý¥Ñ¡‘É…Ý¸¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð (€€€€€Ý¥Ñ¡‘É…Ý¸¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸°(€€€€¤¹Ñ½5…Ñ¡=‰©•Ð¡ìÍÑ…ÑÕÌè€Ý¥Ñ¡‘É…Ý¸œ°‰Å9Õµ‰•Èè€	D´ÀÈœô¤ì((€€€€¼¼¹…¸½™™•ÈÑ¡…ÐÍ¥µÁ±ä±…ÁÍ•¥Ì•áÁ¥É•‘€¸(€€€½¹ÍÐ±…ÁÍ¥¹%€ô…Ý…¥Ð‘É…™Ñ]¥Ñ¡1¥¹•Ì¡½É…¹¥Í…Ñ¥½¹%°ì(€€€€€ÍÕ‰©•Ðè€	Õ‘•Ñ…Éä½™™•ÈÑ¡…ÐÝ¥±°±…ÁÍ”œ°(€€€ô¤ì(€€€½¹ÍÐ¥ÍÍÕ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í±…ÁÍ¥¹%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€•áÁ•Ð (€€€€€¥ÍÍÕ•¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹‰Å9Õµ‰•È°(€€€€¤¹Ñ½	” 	D´ÀÌœ¤ì(€€€½¹ÍÐ•áÁ¥É•€ô…Ý…¥Ð…ÕÑ¡•¡±•É¬°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í±…ÁÍ¥¹%‘ô½½ÕÑ½µ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì½ÕÑ½µ”è€•áÁ¥É•œô°(€€€ô¤ì(€€€•áÁ•Ð¡•áÁ¥É•¹ÍÑ…ÑÕÍ½‘”°•áÁ¥É•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð (€€€€€•áÁ¥É•¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹ÍÑ…ÑÕÌ°(€€€€¤¹Ñ½	” •áÁ¥É•œ¤ì((€€€½¹ÍÐ‘•¹¥…±½ÉY¥•Ý•È€ô…Ý…¥Ð…ÕÑ¡•¡Ù¥•Ý•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í±…ÁÍ¥¹%‘ô½½ÕÑ½µ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì½ÕÑ½µ”è€½¹Ù•ÉÑ•œô°(€€€ô¤ì(€€€•áÁ•Ð¡‘•¹¥…±½ÉY¥•Ý•È¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÌ¤ì(€€€•áÁ•Ð¡‘•¹¥…±½ÉY¥•Ý•È¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€I=1}=I	%8œô¤ì(€ô¤ì((€¥Ð ±¥ÍÑÌÑ¡”½É…¹¥Í…Ñ¥½¸ÅÕ½Ñ…Ñ¥½¹Ì™½È•Ù•Éäµ•µ‰•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡Ù¥•Ý•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€œ½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ìœ°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐ±¥ÍÐ€ôÉ•ÍÁ½¹Í”¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹1¥ÍÑI•ÍÁ½¹Í”ø ¤ì(€€€½¹ÍÐ¹Õµ‰•ÉÌ€ô±¥ÍÐ¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹Ì(€€€€€€¹µ…À ¡ÅÕ½Ñ…Ñ¥½¸¤€ôøÅÕ½Ñ…Ñ¥½¸¹‰Å9Õµ‰•È¤(€€€€€€¹™¥±Ñ•È ¡¹Õµ‰•È¤è¹Õµ‰•È¥ÌÍÑÉ¥¹œ€ôø¹Õµ‰•È€„ôô¹Õ±°¤(€€€€€€¹Í½ÉÐ ¤ì(€€€•áÁ•Ð¡¹Õµ‰•ÉÌ¤¹Ñ½ÅÕ…°¡l	D´ÀÄœ°€	D´ÀÈœ°€	D´ÀÌt¤ì(€ô¤ì((€¥Ð ÝÉ¥Ñ•ÌÑ¡”…Õ‘¥ÐÑÉ…¥°™½ÈÑ¡”Ý¡½±”±¥™•å±”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ•Ù•¹ÑÌ€ô…Ý…¥Ð…‘µ¥¸ñì…Ñ¥½¸èÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð…Ñ¥½¸™É½´…Õ‘¥Ñ}•Ù•¹ÑÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô…¹•¹Ñ¥Ñå}¥€ô€‘í™É••Q•áÑ%‘ô(€€€€€½É‘•È‰ä½ÕÉÉ•‘}…Ð(€€€€ì(€€€•áÁ•Ð¡•Ù•¹ÑÌ¹µ…À ¡•Ù•¹Ð¤€ôø•Ù•¹Ð¹…Ñ¥½¸¤¤¹Ñ½ÅÕ…°¡l(€€€€€€‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¸¹É•…Ñ•œ°(€€€€€€‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¸¹±¥¹•Í}Í…Ù•œ°(€€€€€€‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¸¹±¥¹•Í}Í…Ù•œ°(€€€€€€‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¸¹¥ÍÍÕ•œ°(€€€€€€‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¸¹½¹Ù•ÉÑ•œ°(€€€t¤ì((€€€½¹ÍÐÝ¥Ñ¡‘É…Ý…±Ì€ô…Ý…¥Ð…‘µ¥¸ñì…Ñ¥½¸èÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð…Ñ¥½¸™É½´…Õ‘¥Ñ}•Ù•¹ÑÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô(€€€€€€€…¹•¹Ñ¥Ñå}¥€ô€‘í±¥•¹Ñ‘‘É•ÍÍ•‘%‘ô(€€€€€€€…¹…Ñ¥½¸€ô€‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¸¹Ý¥Ñ¡‘É…Ý¸œ(€€€€ì(€€€•áÁ•Ð¡Ý¥Ñ¡‘É…Ý…±Ì¤¹Ñ½!…Ù•1•¹Ñ  Ä¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” É½ÍÌµÑ•¹…¹Ð…•ÍÌœ°€ ¤€ôøì(€±•Ð™½É•¥¹%èÍÑÉ¥¹œì((€‰•™½É•±°¡…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€œ½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ìœ°(€€€€€½É…¹¥Í…Ñ¥½¹%è½Ñ¡•É=É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…è‘É…™Ñ	½‘ä¡ìÍÕ‰©•Ðè€=™™•ÈÑ¡…Ð‰•±½¹ÌÑ¼Ñ¡”½Ñ¡•ÈÑ•¹…¹Ðœô¤°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€™½É•¥¹%€ôÉ•…Ñ•¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸¹¥ì(€ô°€ÌÁ|ÀÀÀ¤ì((€¥Ð …¹ÍÝ•ÉÌ€ÐÀÐ™½È…¹½Ñ¡•È½É…¹¥Í…Ñ¥½¸ÅÕ½Ñ…Ñ¥½¸°½¸•Ù•ÉäÙ•Éˆœ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼Q¡”½Ý¹•È¥Ì„µ•µ‰•È½˜	=Q ½É…¹¥Í…Ñ¥½¹Ì°Í¼Ñ¡”µ•µ‰•ÉÍ¡¥À™±½½È(€€€€¼¼±•ÑÌÑ¡”É•ÅÕ•ÍÐ¥¸è¥Ð¥ÌI1L°…¹½¹±äI1L°Ñ¡…Ð¡¥‘•ÌÑ¡”É½ÜƒŠP(€€€€¼¼…¹Ñ¡”…¹ÍÝ•È¥Ì€ÐÀÐ°¹•Ù•È€ÐÀÌ°Í¼„Õ•ÍÍ•¥…¹¹½Ð½¹™¥É´Ñ¡”(€€€€¼¼‘½Õµ•¹Ð•á¥ÍÑÌÍ½µ•Ý¡•É”•±Í”¸(€€€½¹ÍÐÉ•…€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™½É•¥¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•…¹ÍÑ…ÑÕÍ½‘”°É•…¹‰½‘ä¤¹Ñ½	” ÐÀÐ¤ì(€€€•áÁ•Ð¡É•…¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€	UQIe}EU=QQ%=9}9=Q}=U9œô¤ì((€€€½¹ÍÐ•‘¥Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™½É•¥¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…è‘É…™Ñ	½‘ä¡ìÍÕ‰©•Ðè€Q…­•¸½Ù•È™É½´…¹½Ñ¡•ÈÑ•¹…¹Ðœô¤°(€€€ô¤ì(€€€•áÁ•Ð¡•‘¥Ñ•¹ÍÑ…ÑÕÍ½‘”°•‘¥Ñ•¹‰½‘ä¤¹Ñ½	” ÐÀÐ¤ì((€€€½¹ÍÐ±¥¹•Ì€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™½É•¥¹%‘ô½±¥¹•Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…è1%9L°(€€€ô¤ì(€€€•áÁ•Ð¡±¥¹•Ì¹ÍÑ…ÑÕÍ½‘”°±¥¹•Ì¹‰½‘ä¤¹Ñ½	” ÐÀÐ¤ì((€€€½¹ÍÐ¥ÍÍÕ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™½É•¥¹%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÐÀÐ¤ì((€€€½¹ÍÐÉ•µ½Ù•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€1Qœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™½É•¥¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•µ½Ù•¹ÍÑ…ÑÕÍ½‘”°É•µ½Ù•¹‰½‘ä¤¹Ñ½	” ÐÀÐ¤ì((€€€€¼¼9½Ñ¡¥¹œ±•…­•¥¹Ñ¼Ñ¡”½Ñ¡•ÈÑ•¹…¹ÐÌ±¥ÍÐ•¥Ñ¡•ËŠ˜(€€€½¹ÍÐ±¥ÍÐ€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€œ½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ìœ°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð (€€€€€±¥ÍÐ(€€€€€€€€¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹1¥ÍÑI•ÍÁ½¹Í”ø ¤(€€€€€€€€¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹Ì¹µ…À ¡ÅÕ½Ñ…Ñ¥½¸¤€ôøÅÕ½Ñ…Ñ¥½¸¹¥¤°(€€€€¤¹¹½Ð¹Ñ½½¹Ñ…¥¸¡™½É•¥¹%¤ì((€€€€¼¼ƒŠ™…¹Ñ¡”É•½É¥ÑÍ•±˜¥ÌÕ¹Ñ½Õ¡•Ý¡•É”¥Ð‘½•Ì‰•±½¹œ¸(€€€½¹ÍÐ¡½µ”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™½É•¥¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%è½Ñ¡•É=É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¡½µ”¹ÍÑ…ÑÕÍ½‘”°¡½µ”¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð (€€€€€¡½µ”¹©Í½¸ñ	Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹‰Õ‘•Ñ…ÉåEÕ½Ñ…Ñ¥½¸°(€€€€¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€‘É…™Ðœ°(€€€€€ÍÕ‰©•Ðè€=™™•ÈÑ¡…Ð‰•±½¹ÌÑ¼Ñ¡”½Ñ¡•ÈÑ•¹…¹Ðœ°(€€€ô¤ì(€ô¤ì((€¥Ð É•™ÕÍ•Ì„µ•µ‰•È½˜¹•¥Ñ¡•È½É…¹¥Í…Ñ¥½¸‰•™½É”…¹äÉ½Ü¥ÌÉ•…œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ‘•¹¥•€ô…Ý…¥Ð…ÕÑ¡•¡±•É¬°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í™½É•¥¹%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%è½Ñ¡•É=É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡‘•¹¥•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÌ¤ì(€€€•áÁ•Ð¡‘•¹¥•¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€9=Q}}55	Hœô¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” 	D¹Õµ‰•É¥¹œÕ¹‘•È½¹ÕÉÉ•¹äœ°€ ¤€ôøì(€¥Ð ¹Õµ‰•ÉÌ™½ÕÈÍ¥µÕ±Ñ…¹•½ÕÌ¥ÍÍÕ•Ì…Á±•ÍÍ±ä°½¹”¹Õµ‰•È•… œ°…Íå¹Œ€ ¤€ôøì(€€€€¼¼™É•Í ½É…¹¥Í…Ñ¥½¸°Í¼¥ÑÌ½Õ¹Ñ•ÈÍÑ…ÉÑÌ…Ð½¹”…¹Ñ¡”¹Õµ‰•ÉÌ(€€€€¼¼…¸‰”¹…µ••á…Ñ±ä¸(€€€½¹ÍÐ¥‘Ì€ô…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l(€€€€€‘É…™Ñ]¥Ñ¡1¥¹•Ì¡É…•=É…¹¥Í…Ñ¥½¹%°ìÍÕ‰©•Ðè€I…”½™™•Èœô¤°(€€€€€‘É…™Ñ]¥Ñ¡1¥¹•Ì¡É…•=É…¹¥Í…Ñ¥½¹%°ìÍÕ‰©•Ðè€I…”½™™•Èœô¤°(€€€€€‘É…™Ñ]¥Ñ¡1¥¹•Ì¡É…•=É…¹¥Í…Ñ¥½¹%°ìÍÕ‰©•Ðè€I…”½™™•Èœô¤°(€€€€€‘É…™Ñ]¥Ñ¡1¥¹•Ì¡É…•=É…¹¥Í…Ñ¥½¹%°ìÍÕ‰©•Ðè€I…”½™™•Èœô¤°(€€€t¤ì((€€€½¹ÍÐÉ•ÍÁ½¹Í•Ì€ô…Ý…¥ÐAÉ½µ¥Í”¹…±° (€€€€€¥‘Ì¹µ…À¡…Íå¹Œ€¡¥¤€ôø(€€€€€€€…ÕÑ¡•¡½Ý¹•È°ì(€€€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘í¥‘ô½¥ÍÍÕ•€°(€€€€€€€€€½É…¹¥Í…Ñ¥½¹%èÉ…•=É…¹¥Í…Ñ¥½¹%°(€€€€€€€ô¤°(€€€€€€¤°(€€€€¤ì(€€€™½È€¡½¹ÍÐÉ•ÍÁ½¹Í”½˜É•ÍÁ½¹Í•Ì¤ì(€€€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€ô((€€€½¹ÍÐÉ½ÝÌ€ô…Ý…¥Ð…‘µ¥¸ñì‰Å}¹Õµ‰•ÈèÍÑÉ¥¹œìÍ•ÅÕ•¹•}¹Õµ‰•Èè¹Õµ‰•Èõmtù€(€€€€€Í•±•Ð‰Å}¹Õµ‰•È°Í•ÅÕ•¹•}¹Õµ‰•È™É½´‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¹Ì(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘íÉ…•=É…¹¥Í…Ñ¥½¹%‘ô…¹ÍÑ…ÑÕÌ€ô€¥ÍÍÕ•œ(€€€€€½É‘•È‰äÍ•ÅÕ•¹•}¹Õµ‰•È(€€€€ì(€€€•áÁ•Ð¡É½ÝÌ¹µ…À ¡É½Ü¤€ôøÉ½Ü¹‰Å}¹Õµ‰•È¤¤¹Ñ½ÅÕ…°¡l(€€€€€€	D´ÀÄœ°(€€€€€€	D´ÀÈœ°(€€€€€€	D´ÀÌœ°(€€€€€€	D´ÀÐœ°(€€€t¤ì(€€€•áÁ•Ð¡É½ÝÌ¹µ…À ¡É½Ü¤€ôøÉ½Ü¹Í•ÅÕ•¹•}¹Õµ‰•È¤¤¹Ñ½ÅÕ…°¡lÄ°€È°€Ì°€Ñt¤ì(€ô°€ÌÁ|ÀÀÀ¤ì((€¥Ð ±•ÑÌ•á…Ñ±ä½¹”½˜ÑÝ¼Í¥µÕ±Ñ…¹•½ÕÌ¥ÍÍÕ•ÌÝ¥¸°½¹ÍÕµ¥¹œ½¹”¹Õµ‰•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ…•%€ô…Ý…¥Ð‘É…™Ñ]¥Ñ¡1¥¹•Ì¡É…•=É…¹¥Í…Ñ¥½¹%°ì(€€€€€ÍÕ‰©•Ðè€I…”½™™•Èœ°(€€€ô¤ì(€€€½¹ÍÐm™¥ÉÍÐ°Í•½¹‘t€ô…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l(€€€€€…ÕÑ¡•¡½Ý¹•È°ì(€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘íÉ…•%‘ô½¥ÍÍÕ•€°(€€€€€€€½É…¹¥Í…Ñ¥½¹%èÉ…•=É…¹¥Í…Ñ¥½¹%°(€€€€€ô¤°(€€€€€…ÕÑ¡•¡½Ý¹•È°ì(€€€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€€€ÕÉ°è€½…Á¤½‰Õ‘•Ñ…ÉäµÅÕ½Ñ…Ñ¥½¹Ì¼‘íÉ…•%‘ô½¥ÍÍÕ•€°(€€€€€€€½É…¹¥Í…Ñ¥½¹%èÉ…•=É…¹¥Í…Ñ¥½¹%°(€€€€€ô¤°(€€€t¤ì(€€€•áÁ•Ð¡m™¥ÉÍÐ¹ÍÑ…ÑÕÍ½‘”°Í•½¹¹ÍÑ…ÑÕÍ½‘•t¹Í½ÉÐ ¤¤¹Ñ½ÅÕ…°¡lÈÀÄ°€ÐÀåt¤ì((€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥Ð…‘µ¥¸ñì‰Å}¹Õµ‰•ÈèÍÑÉ¥¹œìÍ•ÅÕ•¹•}¹Õµ‰•Èè¹Õµ‰•Èõmtù€(€€€€€Í•±•Ð‰Å}¹Õµ‰•È°Í•ÅÕ•¹•}¹Õµ‰•È™É½´‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¹Ì(€€€€€Ý¡•É”¥€ô€‘íÉ…•%‘ô…¹ÍÑ…ÑÕÌ€ô€¥ÍÍÕ•œ(€€€€ì(€€€•áÁ•Ð¡É½Üü¹‰Å}¹Õµ‰•È¤¹Ñ½	” 	D´ÀÔœ¤ì((€€€€¼¼Q¡”±½Í•ÈÌÑÉ…¹Í…Ñ¥½¸É½±±•¥ÑÌ½Õ¹Ñ•È¥¹É•µ•¹Ð‰…¬Ý¥Ñ ¥Ð°(€€€€¼¼Í¼Ñ¡”Í•ÅÕ•¹”¥ÌÍÑ¥±°…Á±•ÍÌèÑ¡”½Õ¹Ñ•ÈÍÑ…¹‘Ì…Ð•á…Ñ±äÑ¡”(€€€€¼¼¹Õµ‰•ÈÑ¡…ÐÝ…Ì…ÑÕ…±±ä¡…¹‘•½ÕÐ¸(€€€½¹ÍÐm½Õ¹Ñ•Ét€ô…Ý…¥Ð…‘µ¥¸ñì¹•áÑ}Ù…±Õ”è¹Õµ‰•Èõmtù€(€€€€€Í•±•Ð¹•áÑ}Ù…±Õ”™É½´‰Õ‘•Ñ…Éå}ÅÕ½Ñ…Ñ¥½¹}½Õ¹Ñ•ÉÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘íÉ…•=É…¹¥Í…Ñ¥½¹%‘ô(€€€€ì(€€€•áÁ•Ð¡½Õ¹Ñ•Èü¹¹•áÑ}Ù…±Õ”¤¹Ñ½	” Ô¤ì(€ô°€ÌÁ|ÀÀÀ¤ì)ô¤ì(