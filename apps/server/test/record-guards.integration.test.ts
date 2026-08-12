import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  IssueChallanDetailResponse,
  MeasurementBookDetailResponse,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, jsonb, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * The date and coherence guards that anchor the operational record:
 *
 * - the LOA letter date confirmed onto a Work (the FLOOR every later
 *   date window measures from) is a real calendar date and never in the
 *   future, in the organisation's own timezone;
 * - an MB entry's measurement date sits inside that window;
 * - a Measurement Book's date never runs backwards behind the register;
 * - a contract instrument's issue/expiry dates and a PBG's amount are
 *   coherent enough to drive the dashboard;
 * - a final Measurement Book never finalizes over a live draft challan
 *   that its own existence would then strand.
 *
 * Every rule is paired with the legitimate workflow it must NOT break —
 * unrestricted back-dating above all, since a contractor onboarding from
 * paper records months of history at once.
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
const ownerEmail = `rg-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** The Works these tests seed all carry this LOA letter date, so the
 * legal window they all measure from is explicit. */
const LETTER_DATE = '2025-06-01';

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;

// The measurement / instrument fixture Work.
let workId: string;
let itemId: string;
let issuedChallanId: string;

// The Measurement Book register-order fixture Work.
let registerWorkId: string;
let registerItemId: string;

// The final-MB clean-state fixture Work.
let finalWorkId: string;
let finalItemId: string;

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

/** A date offset from the UTC day. The organisation runs on Asia/Kolkata
 * (UTC+5:30), so its own day is either the UTC day or the next one:
 * +2 is unambiguously in its future and -2 unambiguously in its past,
 * whichever side of 18:30 UTC the suite runs on. */
function daysFromToday(days: number): string {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** A Work seeded directly: these tests exercise the guards, not the
 * confirmation flow (which G1 below drives through the real route). */
async function seedWork(
  code: string,
  item: { itemNumber: string; quantity: string; rate: string; category?: string },
): Promise<{ workId: string; itemId: string }> {
  const id = randomUUID();
  const scheduleId = randomUUID();
  const newItemId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${id}, ${organisationId}, ${code}, ${`rg-letter-${code}-${runId}`},
      ${LETTER_DATE}, ${`Record guard work ${code}`},
      1000000.00, 900000.00, 'per_schedule', null, null, ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${id}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category
    )
    values (
      ${newItemId}, ${organisationId}, ${id}, ${scheduleId}, ${item.itemNumber},
      ${`Guard item ${item.itemNumber}`}, 'Nos', ${item.quantity}, ${item.rate},
      ${item.category ?? null}
    )
  `;
  return { workId: id, itemId: newItemId };
}

async function insertMatrixRow(
  targetWorkId: string,
  category: string,
  percentages: [string, string, string, string],
): Promise<void> {
  await admin`
    insert into payment_matrices (
      organisation_id, work_id, category, pct_supply, pct_installation,
      pct_pac, pct_final_bill, created_by_user_id
    )
    values (
      ${organisationId}, ${targetWorkId}, ${category}, ${percentages[0]},
      ${percentages[1]}, ${percentages[2]}, ${percentages[3]}, ${ownerUserId}
    )
  `;
}

/** Drafts a delivery challan and returns its id — left as a DRAFT. */
async function draftChallan(
  targetWorkId: string,
  targetItemId: string,
  prefix: string,
  quantity: string,
): Promise<string> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${targetWorkId}/challans`,
    organisationId,
    payload: {
      challanDate: daysFromToday(-2),
      prefix,
      consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
      items: [{ workItemId: targetItemId, quantity }],
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ChallanDetailResponse>().challan.id;
}

async function issueChallan(challanId: string): Promise<void> {
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
}

async function seedReviewDocument(filename: string): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into loa_documents (
      id, organisation_id, object_key, original_filename, sha256,
      media_type, size_bytes, extraction_status, extraction_payload,
      uploaded_by_user_id
    )
    values (
      ${id}, ${organisationId}, ${`${organisationId}/loa/${id}.pdf`},
      ${filename}, ${'e'.repeat(32) + id.replaceAll('-', '')},
      'application/pdf', 1000, 'review',
      ${jsonb(admin, { sourceText: 'RECORD GUARD LETTER TEXT' })},
      ${ownerUserId}
    )
  `;
  return id;
}

function confirmPayload(code: string, letterDate: string) {
  return {
    workCode: code,
    letterNumber: `L-${code}-${runId}`,
    letterDate,
    title: `Confirmed work ${code}`,
    advertisedValue: '50000.00',
    contractValue: '45000.00',
    pricingShape: 'per_schedule',
    schedules: [
      {
        scheduleCode: 'A',
        title: 'Schedule A',
        items: [
          {
            itemNumber: 'A/1',
            description: 'Confirmed item',
            unitCode: 'Nos',
            awardedQuantity: '10.000',
            effectiveRate: '100.00',
            manualEntry: true,
          },
        ],
      },
    ],
  };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-record-guards-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the record-guard integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-rg-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'RG Owner');
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'RG Constructions', slug: `rg-org-${runId}` },
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

  const code = runId.slice(0, 4).toUpperCase();
  const measured = await seedWork(`RGM${code}`, {
    itemNumber: 'A/1',
    quantity: '100.000',
    rate: '100.00',
  });
  workId = measured.workId;
  itemId = measured.itemId;
  issuedChallanId = await draftChallan(workId, itemId, `RGM${code}DC`, '20');
  await issueChallan(issuedChallanId);

  const register = await seedWork(`RGR${code}`, {
    itemNumber: 'A/1',
    quantity: '100.000',
    rate: '10.00',
    category: 'SUPPLY',
  });
  registerWorkId = register.workId;
  registerItemId = register.itemId;
  await insertMatrixRow(registerWorkId, 'SUPPLY', ['90.00', '0.00', '0.00', '10.00']);

  const final = await seedWork(`RGF${code}`, {
    itemNumber: 'A/1',
    quantity: '100.000',
    rate: '10.00',
    category: 'SUPPLY',
  });
  finalWorkId = final.workId;
  finalItemId = final.itemId;
  await insertMatrixRow(finalWorkId, 'SUPPLY', ['90.00', '0.00', '0.00', '10.00']);
}, 90_000);

afterAll(async () => {
  if (admin) {
    if (organisationId) {
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'work_assignments',
          'mb_sources',
          'measurement_book_lines',
          'measurement_book_counters',
          'bills',
          'measurement_books',
          'bill_counters',
          'payment_matrices',
          'mb_entries',
          'work_instruments',
          'challan_item_serials',
          'challan_receipts',
          'issue_challan_lines',
          'issue_challan_counters',
          'issue_challans',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'loa_documents',
          'work_items',
          'work_schedules',
          'works',
          'gst_rates',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [organisationId],
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

describe('G1 — the confirmed LOA letter date', () => {
  it('refuses a letter date in the future and one that is not a real day', async () => {
    const code = runId.slice(0, 4).toUpperCase();

    const future = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${await seedReviewDocument('future.pdf')}/confirm`,
      organisationId,
      payload: confirmPayload(`RGX1${code}`, daysFromToday(2)),
    });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json()).toMatchObject({ code: 'LETTER_DATE_INVALID' });

    // A day that does not exist used to reach Postgres and come back as
    // an opaque 500. What matters to the operator is the named 400 — it
    // may come from the request schema or from the handler's own guard,
    // whichever sees it first.
    const impossible = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${await seedReviewDocument('impossible.pdf')}/confirm`,
      organisationId,
      payload: confirmPayload(`RGX2${code}`, '2026-02-31'),
    });
    expect(impossible.statusCode, impossible.body).toBe(400);
    expect(['LETTER_DATE_INVALID', 'FST_ERR_VALIDATION'], impossible.body).toContain(
      impossible.json<{ code: string }>().code,
    );

    // Neither refusal may burn the work code or letter number.
    const [works] = await admin<{ count: string }[]>`
      select count(*)::text as count from works
      where organisation_id = ${organisationId}
        and work_code in (${`RGX1${code}`}, ${`RGX2${code}`})
    `;
    expect(works?.count).toBe('0');
  });

  it('still confirms a letter years old — back-dating stays unrestricted', async () => {
    const code = runId.slice(0, 4).toUpperCase();
    const documentId = await seedReviewDocument('paper-backlog.pdf');
    const confirmed = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: confirmPayload(`RGX3${code}`, '2019-04-01'),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    expect(confirmed.json<WorkDetailResponse>().work.letterDate).toBe('2019-04-01');

    // The boundary: today in the organisation's own timezone is fine.
    // Computed the same way the guard does, so an evening IST run does
    // not read as tomorrow.
    const [organisation] = await admin<{ today: string }[]>`
      select (now() at time zone timezone)::date::text as today
      from organisations where id = ${organisationId}
    `;
    const today = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${await seedReviewDocument('today.pdf')}/confirm`,
      organisationId,
      payload: confirmPayload(`RGX4${code}`, organisation?.today ?? ''),
    });
    expect(today.statusCode, today.body).toBe(201);
  });
});

describe('G18 — the MB entry measurement date', () => {
  it('refuses a measurement in the future or before the LOA letter date', async () => {
    const future = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId: itemId,
        measuredQuantity: '1',
        measuredOn: daysFromToday(2),
      },
    });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json()).toMatchObject({ code: 'MB_ENTRY_DATE_FUTURE' });

    const beforeLoa = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId: itemId,
        measuredQuantity: '1',
        measuredOn: '2025-05-31',
      },
    });
    expect(beforeLoa.statusCode, beforeLoa.body).toBe(400);
    expect(beforeLoa.json()).toMatchObject({ code: 'MB_ENTRY_DATE_BEFORE_LOA' });
    expect(beforeLoa.json<{ message: string }>().message).toContain(LETTER_DATE);

    const [stored] = await admin<{ count: string }[]>`
      select count(*)::text as count from mb_entries
      where work_item_id = ${itemId}
    `;
    expect(stored?.count).toBe('0');
  });

  it('accepts any date inside the window, letter date included', async () => {
    // The paper-backlog case: a site measurement typed up long after the
    // fact, on the earliest day the contract can carry.
    const onLetterDate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId: itemId,
        measuredQuantity: '2',
        measuredOn: LETTER_DATE,
        mbBookRef: 'MB-1/p7',
      },
    });
    expect(onLetterDate.statusCode, onLetterDate.body).toBe(201);
    expect(onLetterDate.json<{ measuredOn: string }>().measuredOn).toBe(LETTER_DATE);

    const recent = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId: itemId,
        deliveryChallanId: issuedChallanId,
        measuredQuantity: '3',
        measuredOn: daysFromToday(-2),
      },
    });
    expect(recent.statusCode, recent.body).toBe(201);
  });
});

describe('G20 — Measurement Book register order', () => {
  let firstMbDate: string;

  it('finalizes MB-01, then refuses a later MB dated before it', async () => {
    const dc1 = await draftChallan(
      registerWorkId,
      registerItemId,
      `RGR${runId.slice(0, 3).toUpperCase()}DC`,
      '10',
    );
    await issueChallan(dc1);

    firstMbDate = daysFromToday(-3);
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${registerWorkId}/measurement-books`,
      organisationId,
      payload: { mbDate: firstMbDate },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const mbId = draft.json<MeasurementBookDetailResponse>().book.id;
    const claimed = await authed(owner, {
      method: 'PUT',
      url: `/api/measurement-books/${mbId}/sources`,
      organisationId,
      payload: { sources: [{ sourceType: 'delivery_challan', sourceId: dc1 }] },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mbId}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const mbNumber = finalized.json<MeasurementBookDetailResponse>().book.mbNumber;

    const backwards = await authed(owner, {
      method: 'POST',
      url: `/api/works/${registerWorkId}/measurement-books`,
      organisationId,
      payload: { mbDate: daysFromToday(-4) },
    });
    expect(backwards.statusCode, backwards.body).toBe(400);
    expect(backwards.json()).toMatchObject({ code: 'MB_DATE_BEFORE_PREVIOUS' });
    // The refusal names the book it would have run behind.
    const message = backwards.json<{ message: string }>().message;
    expect(message).toContain(mbNumber ?? 'never');
    expect(message).toContain(firstMbDate);
  });

  it('allows a second MB on the SAME day as the previous one', async () => {
    const sameDay = await authed(owner, {
      method: 'POST',
      url: `/api/works/${registerWorkId}/measurement-books`,
      organisationId,
      payload: { mbDate: firstMbDate },
    });
    expect(sameDay.statusCode, sameDay.body).toBe(201);
    const bookId = sameDay.json<MeasurementBookDetailResponse>().book.id;

    const later = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${bookId}`,
      organisationId,
    });
    expect(later.statusCode, later.body).toBe(204);

    const forward = await authed(owner, {
      method: 'POST',
      url: `/api/works/${registerWorkId}/measurement-books`,
      organisationId,
      payload: { mbDate: daysFromToday(-1) },
    });
    expect(forward.statusCode, forward.body).toBe(201);
    const forwardId = forward.json<MeasurementBookDetailResponse>().book.id;
    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${forwardId}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);
  });
});

describe('G25/G26/G27 — contract instruments', () => {
  const issuedOn = daysFromToday(-5);

  it('refuses an expiry before issue, on create and on update', async () => {
    const transposed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG-TRANSPOSED-${runId}`,
        amount: '45000.00',
        issuedOn,
        expiresOn: daysFromToday(-370),
      },
    });
    expect(transposed.statusCode, transposed.body).toBe(400);
    expect(transposed.json()).toMatchObject({ code: 'INSTRUMENT_EXPIRY_INVALID' });

    // Same day is fine: a guarantee may be issued and expire on one day.
    const sameDay = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG-SAMEDAY-${runId}`,
        amount: '1000.00',
        issuedOn,
        expiresOn: issuedOn,
      },
    });
    expect(sameDay.statusCode, sameDay.body).toBe(201);
    const sameDayId = sameDay.json<{ id: string }>().id;

    // The PUT can move expires_on on its own; it obeys the same rule.
    const moved = await authed(owner, {
      method: 'PUT',
      url: `/api/instruments/${sameDayId}`,
      organisationId,
      payload: { expiresOn: daysFromToday(-6) },
    });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(moved.json()).toMatchObject({ code: 'INSTRUMENT_EXPIRY_INVALID' });

    // A real renewal still lands.
    const renewal = daysFromToday(400);
    const renewed = await authed(owner, {
      method: 'PUT',
      url: `/api/instruments/${sameDayId}`,
      organisationId,
      payload: { expiresOn: renewal },
    });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json<{ expiresOn: string }>().expiresOn).toBe(renewal);
  });

  it('refuses an issue date in the future but only WARNS before the LOA', async () => {
    const future = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `BG-FUTURE-${runId}`,
        amount: '45000.00',
        issuedOn: daysFromToday(2),
      },
    });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json()).toMatchObject({ code: 'INSTRUMENT_ISSUED_ON_INVALID' });

    // A tender document (or an EMD later converted) legitimately predates
    // the letter: accepted, and recorded as a warning on the trail.
    const preLoa = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'doc',
        reference: `DOC-PRELOA-${runId}`,
        // Six months before the LOA letter date.
        issuedOn: '2024-12-01',
      },
    });
    expect(preLoa.statusCode, preLoa.body).toBe(201);
    const preLoaId = preLoa.json<{ id: string }>().id;
    const [event] = await admin<{ flag: string | null }[]>`
      select details->>'issuedBeforeLetterDate' as flag
      from audit_events
      where entity_type = 'work_instruments' and entity_id = ${preLoaId}
        and action = 'instrument.created'
    `;
    expect(event?.flag).toBe('true');
  });

  it('requires a positive amount on a PBG and none on pac/doc', async () => {
    for (const [label, amount] of [
      ['missing', undefined],
      ['zero', '0'],
      ['zero with decimals', '0.00'],
    ] as const) {
      const response = await authed(owner, {
        method: 'POST',
        url: `/api/works/${workId}/instruments`,
        organisationId,
        payload: {
          kind: 'pbg',
          reference: `BG-${label.replaceAll(' ', '-')}-${runId}`,
          issuedOn,
          ...(amount === undefined ? {} : { amount }),
        },
      });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INSTRUMENT_AMOUNT_REQUIRED' });
    }

    // 'pac' and 'doc' instruments are reference records and carry no
    // amount — the rule must stay scoped to guarantees.
    for (const kind of ['pac', 'doc'] as const) {
      const response = await authed(owner, {
        method: 'POST',
        url: `/api/works/${workId}/instruments`,
        organisationId,
        payload: {
          kind,
          reference: `${kind.toUpperCase()}-NOAMOUNT-${runId}`,
          issuedOn,
        },
      });
      expect(response.statusCode, `${kind}: ${response.body}`).toBe(201);
    }
  });
});

describe('G17 — a final Measurement Book over open drafts', () => {
  let finalMbId: string;
  let draftChallanId: string;
  let draftIssueChallanId: string;

  it('refuses to finalize while a draft delivery or issue challan is open', async () => {
    const prefix = `RGF${runId.slice(0, 3).toUpperCase()}DC`;
    const swept = await draftChallan(finalWorkId, finalItemId, prefix, '10');
    await issueChallan(swept);

    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${finalWorkId}/measurement-books`,
      organisationId,
      payload: { mbDate: daysFromToday(-1), isFinal: true },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    finalMbId = draft.json<MeasurementBookDetailResponse>().book.id;
    const claimed = await authed(owner, {
      method: 'PUT',
      url: `/api/measurement-books/${finalMbId}/sources`,
      organisationId,
      payload: { sources: [{ sourceType: 'delivery_challan', sourceId: swept }] },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);

    // Two records still live on the Work, neither visible to the final
    // sweep (which only sees issued/recorded sources).
    draftChallanId = await draftChallan(finalWorkId, finalItemId, prefix, '2');
    const issueDraft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${finalWorkId}/issue-challans`,
      organisationId,
      payload: {
        challanDate: daysFromToday(-2),
        movementType: 'issue',
        issuedToName: 'SSE/Signal/Delhi',
        issuedToRole: 'Site engineer',
        location: 'Relay room, NDLS',
        lines: [{ description: 'Cable ties', unit: 'Pkt', quantity: '5' }],
      },
    });
    expect(issueDraft.statusCode, issueDraft.body).toBe(201);
    draftIssueChallanId = issueDraft.json<IssueChallanDetailResponse>().issueChallan.id;

    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${finalMbId}/finalize`,
      organisationId,
    });
    expect(refused.statusCode, refused.body).toBe(409);
    const body = refused.json<{
      code: string;
      message: string;
      details: { blockers: { kind: string; recordId: string; label: string }[] };
    }>();
    expect(body.code).toBe('MB_FINAL_DRAFTS_OPEN');
    const blockers = body.details.blockers.map(
      (blocker) => `${blocker.kind}:${blocker.recordId}`,
    );
    expect(blockers).toContain(`draft_delivery_challan:${draftChallanId}`);
    expect(blockers).toContain(`draft_issue_challan:${draftIssueChallanId}`);
    // The message is the operator's worklist, not a developer's.
    expect(body.message).toContain('Draft delivery challan dated');
    expect(body.message).toContain('Draft issue challan dated');

    // The refusal wrote nothing: no number was burnt, no lines snapshotted.
    const [state] = await admin<{ status: string; mb_number: string | null }[]>`
      select status, mb_number from measurement_books where id = ${finalMbId}
    `;
    expect(state?.status).toBe('draft');
    expect(state?.mb_number).toBeNull();
  });

  it('leaves the drafts a followable route back into the ledger', async () => {
    // The refusal is not a dead end. A final MB counts as live from the
    // moment it is drafted, so the draft challan cannot be issued while
    // this book exists — but the book is itself a draft, and drafts are
    // deletable. Delete it, issue the challan into the ledger, drop the
    // issue-challan draft, and raise the final MB again.
    const bookRemoved = await authed(owner, {
      method: 'DELETE',
      url: `/api/measurement-books/${finalMbId}`,
      organisationId,
    });
    expect(bookRemoved.statusCode, bookRemoved.body).toBe(204);

    await issueChallan(draftChallanId);
    const icRemoved = await authed(owner, {
      method: 'DELETE',
      url: `/api/issue-challans/${draftIssueChallanId}`,
      organisationId,
    });
    expect(icRemoved.statusCode, icRemoved.body).toBe(204);

    const reraised = await authed(owner, {
      method: 'POST',
      url: `/api/works/${finalWorkId}/measurement-books`,
      organisationId,
      payload: { mbDate: daysFromToday(-1), isFinal: true },
    });
    expect(reraised.statusCode, reraised.body).toBe(201);
    const bookId = reraised.json<MeasurementBookDetailResponse>().book.id;

    const issuedChallans = await admin<{ id: string }[]>`
      select id from delivery_challans
      where work_id = ${finalWorkId} and status = 'issued'
      order by created_at
    `;
    expect(issuedChallans).toHaveLength(2);
    const claimed = await authed(owner, {
      method: 'PUT',
      url: `/api/measurement-books/${bookId}/sources`,
      organisationId,
      payload: {
        sources: issuedChallans.map((row) => ({
          sourceType: 'delivery_challan',
          sourceId: row.id,
        })),
      },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);

    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${bookId}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const book = finalized.json<MeasurementBookDetailResponse>().book;
    expect(book.status).toBe('finalized');
    expect(book.isFinal).toBe(true);

    // Nothing was stranded: every issued challan reached the ledger.
    const [unclaimed] = await admin<{ count: string }[]>`
      select count(*)::text as count from delivery_challans dc
      where dc.work_id = ${finalWorkId} and dc.status = 'issued'
        and not exists (
          select 1 from mb_sources ms
          where ms.source_type = 'delivery_challan' and ms.source_id = dc.id
            and ms.released_at is null
        )
    `;
    expect(unclaimed?.count).toBe('0');
  });
});
