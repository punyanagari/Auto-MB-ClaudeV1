import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  Bill,
  ChallanDetailResponse,
  MbEntry,
  SerialListResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import { seedConfirmedRailwayMeasurement } from './helpers/railway-measurement-seed.js';

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
const ownerEmail = `rt-owner-${runId}@integration.test`;
const clerkEmail = `rt-clerk-${runId}@integration.test`;
const viewerEmail = `rt-viewer-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let workId: string;
let itemAId: string;
let itemBId: string;
let challanId: string;
let challanItemAId: string;

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

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-retention-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the retention integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-rt-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'RT Owner');
  clerk = await signUp(clerkEmail, 'RT Clerk');
  viewer = await signUp(viewerEmail, 'RT Viewer');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'RT Constructions', slug: `rt-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

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
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  workId = randomUUID();
  const scheduleId = randomUUID();
  itemAId = randomUUID();
  itemBId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`RTW-${runId.toUpperCase()}`},
      ${`rt-letter-${runId}`}, '2025-06-01', 'Retention fixture work',
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
      unit_code, awarded_quantity, effective_rate, requires_serials
    )
    values
      -- Item A stays unflagged: these tests exercise the voluntary
      -- post-issue serial flow. Mandatory (requires_serials) coverage
      -- lives in serials.integration.test.ts, where issue is blocked
      -- until the draft lines are serial-complete.
      (${itemAId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Main switchboard', 'Nos', 5.000, 100.00, false),
      (${itemBId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/2',
       'Cable set', 'Set', 2.000, 250.50, false)
  `;

  // Draft and issue one challan (A: 3, B: 1.5) through the real API.
  const draft = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-08-08',
      prefix: 'DC',
      consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
      items: [
        { workItemId: itemAId, quantity: '3' },
        { workItemId: itemBId, quantity: '1.5' },
      ],
    },
  });
  expect(draft.statusCode, draft.body).toBe(201);
  challanId = draft.json<ChallanDetailResponse>().challan.id;
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  const detail = issued.json<ChallanDetailResponse>();
  const lineA = detail.items.find((item) => item.workItemId === itemAId);
  if (!lineA) throw new Error('challan line for item A missing');
  challanItemAId = lineA.id;
}, 60_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId]);
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

describe('delivery receipts', () => {
  it('records one receipt per issued challan, writer-only', async () => {
    const denied = await authed(viewer, {
      method: 'POST',
      url: `/api/challans/${challanId}/receipt`,
      organisationId,
      payload: { receivedOn: '2026-08-10', receivedBy: 'SSE / TRD Depot' },
    });
    expect(denied.statusCode).toBe(403);

    const recorded = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/receipt`,
      organisationId,
      payload: {
        receivedOn: '2026-08-10',
        receivedBy: 'SSE / TRD Depot',
        remarks: 'Two crates, seals intact.',
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    expect(recorded.json<{ receivedBy: string }>().receivedBy).toBe('SSE / TRD Depot');

    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/receipt`,
      organisationId,
      payload: { receivedOn: '2026-08-11', receivedBy: 'Someone Else' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'RECEIPT_EXISTS' });

    const fetched = await authed(viewer, {
      method: 'GET',
      url: `/api/challans/${challanId}/receipt`,
      organisationId,
    });
    expect(fetched.statusCode).toBe(200);
  });
});

describe('serial traceability', () => {
  it('caps serials at the shipped quantity and keeps them unique per Work', async () => {
    const first = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/serials`,
      organisationId,
      payload: { challanItemId: challanItemAId, serialNumbers: ['SN-1', 'SN-2'] },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json<SerialListResponse>().serials).toHaveLength(2);

    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/serials`,
      organisationId,
      payload: { challanItemId: challanItemAId, serialNumbers: ['SN-2'] },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'DUPLICATE_SERIAL' });

    const overflow = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/serials`,
      organisationId,
      payload: { challanItemId: challanItemAId, serialNumbers: ['SN-3', 'SN-4'] },
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json()).toMatchObject({ code: 'SERIAL_LIMIT' });

    const third = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/serials`,
      organisationId,
      payload: { challanItemId: challanItemAId, serialNumbers: ['SN-3'] },
    });
    expect(third.statusCode, third.body).toBe(201);
  });

  it('records installation and traces serials to their challan', async () => {
    const list = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/serials`,
      organisationId,
    });
    expect(list.statusCode).toBe(200);
    const serials = list.json<SerialListResponse>().serials;
    expect(serials).toHaveLength(3);
    expect(serials.every((serial) => serial.challanNumber === 'DC/1')).toBe(true);

    const target = serials.find((serial) => serial.serialNumber === 'SN-1');
    expect(target).toBeDefined();
    const installed = await authed(owner, {
      method: 'PUT',
      url: `/api/serials/${target?.id ?? ''}/installation`,
      organisationId,
      payload: { installedOn: '2026-08-12', remarks: 'Bay 4, TSS Alpha' },
    });
    expect(installed.statusCode, installed.body).toBe(200);
    const updated = installed
      .json<SerialListResponse>()
      .serials.find((serial) => serial.serialNumber === 'SN-1');
    expect(updated?.installedOn).toBe('2026-08-12');
  });
});

describe('contract instruments', () => {
  it('tracks PBG/PAC/DOC per Work with unique references', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `PBG-${runId}`,
        amount: '45000.00',
        issuedOn: '2026-08-01',
        expiresOn: '2027-08-01',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const instrumentId = created.json<{ id: string }>().id;

    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/instruments`,
      organisationId,
      payload: {
        kind: 'pbg',
        reference: `PBG-${runId}`,
        amount: '45000.00',
        issuedOn: '2026-08-01',
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'INSTRUMENT_EXISTS' });

    const released = await authed(owner, {
      method: 'PUT',
      url: `/api/instruments/${instrumentId}`,
      organisationId,
      payload: { status: 'released', notes: 'Returned by division office.' },
    });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json<{ status: string }>().status).toBe('released');

    const list = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${workId}/instruments`,
      organisationId,
    });
    expect(list.json<{ instruments: unknown[] }>().instruments).toHaveLength(1);
  });
});

describe('Measurement Book and the first partial-billing cycle', () => {
  it('caps cumulative measurement at the delivered quantity', async () => {
    const first = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId: itemAId,
        deliveryChallanId: challanId,
        measuredQuantity: '2',
        // Inside the measurement window: on or after the LOA letter date
        // and not in the future (the challan issued on this date proves
        // it is not).
        measuredOn: '2026-08-08',
        mbBookRef: 'MB-1/p3',
      },
    });
    expect(first.statusCode, first.body).toBe(201);

    const over = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId: itemAId,
        measuredQuantity: '1.5',
        measuredOn: '2026-08-08',
      },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ code: 'MEASUREMENT_EXCEEDS_DELIVERY' });

    const second = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
      payload: {
        workItemId: itemAId,
        measuredQuantity: '1',
        measuredOn: '2026-08-08',
      },
    });
    expect(second.statusCode, second.body).toBe(201);
  });

  it('prepares a bill from a finalized Measurement Book under issue authority', async () => {
    // The old Milestone 5 sweep (POST /api/works/:id/bills) is gone.
    const sweepGone = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/bills`,
      organisationId,
    });
    expect(sweepGone.statusCode).toBe(404);

    // Stage percentages resolve through the Work's payment matrix;
    // seeded directly — matrix rows are configuration, not documents.
    await admin`
      insert into payment_matrices (
        organisation_id, work_id, category, pct_supply, pct_installation,
        pct_pac, pct_final_bill, created_by_user_id
      )
      values (${organisationId}, ${workId}, 'UNCATEGORISED', 80.00, 10.00,
              0.00, 10.00, ${ownerUserId})
    `;
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-08' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const mbId = created.json<{ book: { id: string } }>().book.id;

    const withSources = await authed(owner, {
      method: 'PUT',
      url: `/api/measurement-books/${mbId}/sources`,
      organisationId,
      payload: {
        sources: [{ sourceType: 'delivery_challan', sourceId: challanId }],
      },
    });
    expect(withSources.statusCode, withSources.body).toBe(200);
    // Preview: A 3 x 100.00 x 80% = 240.00; B 1.5 x 250.50 x 80% =
    // 300.60 — line-rounded then summed (R13).
    expect(withSources.json<{ previewTotal: string }>().previewTotal).toBe('540.60');

    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mbId}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const finalizedBook = finalized.json<{
      book: { mbNumber: string | null; totalAmount: string | null };
    }>().book;
    expect(finalizedBook.mbNumber).toBe(`RTW-${runId.toUpperCase()}-MB-01`);
    expect(finalizedBook.totalAmount).toBe('540.60');

    // Preparing the bill is a financial act: issue authority required.
    const denied = await authed(clerk, {
      method: 'POST',
      url: `/api/measurement-books/${mbId}/bill`,
      organisationId,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    const prepared = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mbId}/bill`,
      organisationId,
    });
    expect(prepared.statusCode, prepared.body).toBe(201);
    const bill = prepared.json<Bill>();
    expect(bill.billNumber).toBe(1);
    expect(bill.status).toBe('prepared');
    expect(bill.totalAmount).toBe('540.60');
    expect(bill.mbId).toBe(mbId);
    const lines = bill.linesSnapshot as {
      itemNumber: string;
      lineTotal: string;
      remark: string;
    }[];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ itemNumber: 'A/1', lineTotal: '240.00' });
    expect(lines[1]).toMatchObject({ itemNumber: 'A/2', lineTotal: '300.60' });

    // 1:1 — a second bill from the same MB is refused.
    const duplicate = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${mbId}/bill`,
      organisationId,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'MB_ALREADY_BILLED' });

    // Site measurement evidence stays independent: mb_entries are no
    // longer stamped into bills (ADR-0006 decision 4).
    const entries = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/mb-entries`,
      organisationId,
    });
    const allUnstamped = entries
      .json<{ entries: MbEntry[] }>()
      .entries.every((entry) => entry.billId === null);
    expect(allUnstamped).toBe(true);
  });

  /**
   * Records a railway bill against `measurementBookId` and closes the book
   * with it, using the admin connection.
   *
   * Written directly rather than through the API because closing properly
   * needs a signed PDF and a trust-anchor store, which is what
   * `apps/server/test/received-railway-bills.integration.test.ts` sets up and proves. Here
   * the closure is a precondition of the status machine under test, not the
   * thing under test.
   */
  async function closeBookForPayment(measurementBookId: string): Promise<void> {
    const [book] = await admin<{ work_id: string }[]>`
    select work_id from measurement_books where id = ${measurementBookId}
  `;
    // 0111's precondition, on the same terms as the closure below it: the
    // gate is proved where it lives, and what this suite needs is its
    // result.
    await seedConfirmedRailwayMeasurement(admin, {
      organisationId,
      workId: book?.work_id ?? '',
      measurementBookId,
      userId: ownerUserId,
    });
    const [recorded] = await admin<{ id: string }[]>`
    insert into received_railway_bills (
      organisation_id, work_id, measurement_book_id, object_key,
      original_filename, sha256, media_type, size_bytes, bill_number,
      bill_date, bill_amount, rate_inclusive_of_gst, measurement_number,
      measurement_sequence, letter_number, extraction_payload,
      uploaded_by_user_id, signature_status, signature_verdict,
      signature_verified_at
    )
    values (
      ${organisationId}, ${book?.work_id ?? ''}, ${measurementBookId},
      ${`${organisationId}/railwaybill/${measurementBookId}.pdf`},
      'bill.pdf', ${'c'.repeat(64)}, 'application/pdf', 1024,
      'RETENTION/B1', '2026-02-10', '10.00', true,
      'RETENTION/CSTM/1/OAM/FL2/01', 1, 'RETENTION-LOA',
      '{"billNumber": "RETENTION/B1"}'::jsonb, 'retention-fixture',
      -- The 0066 closure guard reads the verdict, so the stand-in bill
      -- carries one: settleable status and the three signatures an
      -- accepted On-Account Bill has. The per-signature rule is the
      -- server's and is proved in the railway-bill suites; what the
      -- database asks for is this shape.
      'signed_and_intact',
      '{"signatures": [{"index": 1}, {"index": 2}, {"index": 3}]}'::jsonb,
      now()
    )
    returning id
  `;
    await admin`
    update measurement_books
    set closed_at = now(), closed_by_user_id = 'retention-fixture',
        closed_by_received_bill_id = ${recorded?.id ?? ''}
    where id = ${measurementBookId}
  `;
  }

  it('moves bill status forward only', async () => {
    const [bill] = await admin<{ id: string; mb_id: string }[]>`
      select id, mb_id from bills where organisation_id = ${organisationId} limit 1
    `;
    const submitted = await authed(owner, {
      method: 'POST',
      url: `/api/bills/${bill?.id ?? ''}/status`,
      organisationId,
      payload: { status: 'submitted' },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    // Migration 0066: a bill is not paid until the railway's own signed
    // On-Account Bill has closed the Measurement Book behind it. This
    // suite is about the forward-only status machine, not about railway
    // settlement, so the closure is written directly here; the gate
    // itself — route and trigger — is proved in
    // received-railway-bills.integration.test.ts.
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/bills/${bill?.id ?? ''}/status`,
      organisationId,
      payload: { status: 'paid' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'BILL_MEASUREMENT_BOOK_NOT_CLOSED',
    );
    await closeBookForPayment(bill?.mb_id ?? '');

    // Migration 0067: closure is no longer sufficient either. `paid` now
    // asserts that the money is accounted for, so a bill with an empty
    // payment register is refused however well the railway settled the
    // measurement. The register itself is proved in
    // bill-payments.integration.test.ts; what this suite needs is the one
    // receipt that makes the forward transition legal.
    const unaccounted = await authed(owner, {
      method: 'POST',
      url: `/api/bills/${bill?.id ?? ''}/status`,
      organisationId,
      payload: { status: 'paid' },
    });
    expect(unaccounted.statusCode, unaccounted.body).toBe(409);
    expect(unaccounted.json<{ code: string }>().code).toBe('BILL_NOT_FULLY_SETTLED');

    // The stand-in railway bill above is raised for 10.00, and the
    // railway's own figure is what the register is measured against.
    const receipt = await authed(owner, {
      method: 'POST',
      url: `/api/bills/${bill?.id ?? ''}/payments`,
      organisationId,
      payload: {
        receivedOn: '2026-02-20',
        receivedAmount: '8.00',
        deductions: [{ category: 'GST_TDS', amount: '2.00' }],
      },
    });
    expect(receipt.statusCode, receipt.body).toBe(201);

    const paid = await authed(owner, {
      method: 'POST',
      url: `/api/bills/${bill?.id ?? ''}/status`,
      organisationId,
      payload: { status: 'paid' },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    const backwards = await authed(owner, {
      method: 'POST',
      url: `/api/bills/${bill?.id ?? ''}/status`,
      organisationId,
      payload: { status: 'submitted' },
    });
    expect(backwards.statusCode).toBe(409);
  });

  it('writes the retention audit trail', async () => {
    const events = await admin<{ action: string }[]>`
      select distinct action from audit_events
      where organisation_id = ${organisationId}
    `;
    const actions = events.map((event) => event.action);
    for (const expected of [
      'challan.received',
      'serials.recorded',
      'serial.installed',
      'instrument.created',
      'instrument.updated',
      'mb.recorded',
      'measurement_book.created',
      'measurement_book.sources_updated',
      'measurement_book.finalized',
      'bill.prepared',
      'bill.submitted',
      'bill.paid',
    ]) {
      expect(actions, actions.join(', ')).toContain(expected);
    }
  });
});
