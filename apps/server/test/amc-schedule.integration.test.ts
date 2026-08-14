import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  MeasurementBookDetailResponse,
  PacCapExceededDetails,
  WorkBalanceResponse,
  PacCertificateListResponse,
  UnfinishedWorkItem,
  WorkCompletionReadiness,
  WorkNotFullyExecutedDetails,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * The AMC schedule category (migration 0068).
 *
 * THE DEFECT. A railway LOA routinely prices annual maintenance as its
 * own schedule, quoted in `Year`. The flagship corpus letter PL270-CRB
 * carries two — Schedule B, "AMC for SCH A items for the period of 5
 * year", 5 Year at 3,623,698.84, and Schedule D at 1,877,965.44 — which
 * together are 27,508,321.40 of its 169,228,497.35 net bid value, about
 * 16% of the contract. Nothing is ever delivered against such an item
 * and nothing is ever installed against it: a period of maintenance is
 * SERVED, and the railway CERTIFIES that it was.
 *
 * With four payment categories every item resolved to a delivery
 * requirement, an installation requirement, or both, so an AMC item
 * demanded that five years of maintenance be DELIVERED. The R8 predicate
 * — completion only at 100% executed value — was therefore unsatisfiable
 * on any Work carrying a maintenance schedule unless somebody issued a
 * Delivery Challan claiming five years had moved on a lorry.
 *
 * WHAT THIS SUITE HOLDS. The fixture Work is PL270-shaped: one supply
 * item and one 5-Year AMC item. The suite walks the honest route from
 * end to end — the AMC item resolves to a SERVICE requirement, refuses
 * every movement record at both the API and the database, is discharged
 * by acceptance certificates capped at its SANCTIONED quantity rather
 * than at an installed total that is structurally zero, and the Work
 * completes when the last period is certified and not before.
 *
 * ON THE PRE-FIX TREE THE `beforeAll` ITSELF FAILS: `payment_category =
 * 'AMC'` violates `work_items_payment_category_check`, which named only
 * the four 0021 categories. That is the intended proof — the vocabulary
 * this suite exercises did not exist.
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
const ownerEmail = `amc-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let workId: string;
let scheduleAId: string;
let scheduleBId: string;
/** Schedule A, SUPPLY, awarded 4.000 — the physical half of the Work. */
let supplyItemId: string;
/** Schedule B, AMC, awarded 5.000 Year — PL270's maintenance shape. */
let amcItemId: string;
/** A second Work, used only by the write-skew race. It stays out of the
 * completion walk above so a half-finished race cannot alter it. */
let raceWorkId: string;
let raceItemId: string;
let raceAmcItemId: string;
let raceIssueItemId: string;
/** A third Work, for the final-Measurement-Book billing path. Its own
 * Work so the MB lifecycle cannot disturb the completion walk. */
let billWorkId: string;
let billAmcItemId: string;
let consigneeId: string;
let locationId: string;

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

/** Records one acceptance certificate, the discharge route of an AMC
 * item. `reference` must be unique among the non-cancelled. */
async function certify(reference: string, workItemId: string, quantity: string) {
  return authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/pac-certificates`,
    organisationId,
    payload: {
      reference,
      issueDate: '2026-08-05',
      consigneeMasterId: consigneeId,
      items: [{ workItemId, certifiedQuantity: quantity }],
    },
  });
}

async function readiness(): Promise<WorkCompletionReadiness> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/works/${workId}/completion-readiness`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<WorkCompletionReadiness>();
}

function unfinishedFor(
  report: WorkCompletionReadiness,
  itemNumber: string,
): UnfinishedWorkItem | undefined {
  return report.unfinished.find((item) => item.itemNumber === itemNumber);
}

async function complete() {
  return authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/complete`,
    organisationId,
    payload: { note: 'Supply delivered and all five maintenance years certified.' },
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-amc-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the AMC integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-amc-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'AMC Owner');
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'AMC Constructions', slug: `amc-org-${runId}` },
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
    set can_issue_documents = true, can_cancel_documents = true,
        can_approve_amendments = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;

  workId = randomUUID();
  scheduleAId = randomUUID();
  scheduleBId = randomUUID();
  supplyItemId = randomUUID();
  amcItemId = randomUUID();

  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`AMCW${runId.slice(0, 5).toUpperCase()}`},
      ${`amc-letter-${runId}`}, '2025-06-01',
      'IPIS with five-year AMC (PL270 shape)',
      100000.00, 90000.00, 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values
      (${scheduleAId}, ${organisationId}, ${workId}, 'A', 'Schedule A — systems', 1),
      (${scheduleBId}, ${organisationId}, ${workId}, 'B',
       'Schedule B — AMC for complete Sch A systems', 2)
  `;
  // The AMC item is the corpus shape verbatim: quantity 5, unit Year,
  // and a description that does NOT contain the word "installation", so
  // the uncategorised fallback would have sent it down the delivery
  // branch had the category not existed.
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category
    )
    values
      (${supplyItemId}, ${organisationId}, ${workId}, ${scheduleAId}, 'A/1',
       'Integrated Passenger Information System, complete', 'Nos', 4.000,
       12000.00, 'SUPPLY'),
      (${amcItemId}, ${organisationId}, ${workId}, ${scheduleBId}, 'B/1',
       'AMC for SCH A items for the period of 5 year', 'Year', 5.000,
       3623698.84, 'AMC')
  `;

  // The race Work: one SUPPLY item, nothing else. Kept separate from the
  // fixture above so the concurrency test can leave it in whichever
  // state the race produces without touching the completion walk.
  raceWorkId = randomUUID();
  raceItemId = randomUUID();
  raceAmcItemId = randomUUID();
  raceIssueItemId = randomUUID();
  const raceScheduleId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${raceWorkId}, ${organisationId}, ${`AMCR${runId.slice(0, 5).toUpperCase()}`},
      ${`amc-race-letter-${runId}`}, '2025-06-01', 'Write-skew fixture work',
      50000.00, 45000.00, 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${raceScheduleId}, ${organisationId}, ${raceWorkId}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category
    )
    values
      (${raceItemId}, ${organisationId}, ${raceWorkId}, ${raceScheduleId}, 'A/1',
       'Cable drum', 'Nos', 10.000, 500.00, 'SUPPLY'),
      (${raceAmcItemId}, ${organisationId}, ${raceWorkId}, ${raceScheduleId}, 'A/2',
       'AMC for the Cable drum installation, 5 year', 'Year', 5.000, 1000.00, 'AMC'),
      (${raceIssueItemId}, ${organisationId}, ${raceWorkId}, ${raceScheduleId}, 'A/3',
       'Junction box', 'Nos', 10.000, 300.00, 'SUPPLY')
  `;

  // The billing Work: one AMC item and nothing else, so a final
  // Measurement Book over it bills exactly the maintenance line.
  billWorkId = randomUUID();
  billAmcItemId = randomUUID();
  const billScheduleId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${billWorkId}, ${organisationId}, ${`AMCB${runId.slice(0, 5).toUpperCase()}`},
      ${`amc-bill-letter-${runId}`}, '2025-06-01', 'AMC billing fixture work',
      20000.00, 18000.00, 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${billScheduleId}, ${organisationId}, ${billWorkId}, 'B', 'Schedule B — AMC', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category
    )
    values (
      ${billAmcItemId}, ${organisationId}, ${billWorkId}, ${billScheduleId}, 'B/1',
      'AMC for SCH A items for the period of 2 year', 'Year', 2.000, 1000.00, 'AMC'
    )
  `;

  const consignee = await authed(owner, {
    method: 'POST',
    url: '/api/masters/contacts',
    organisationId,
    payload: { designation: 'DSTE (East) CR', address: 'Mumbai CST Division' },
  });
  expect(consignee.statusCode, consignee.body).toBe(201);
  consigneeId = consignee.json<{ id: string }>().id;

  const location = await authed(owner, {
    method: 'POST',
    url: '/api/masters/locations',
    organisationId,
    payload: { name: 'Kalyan station', kind: 'station' },
  });
  expect(location.statusCode, location.body).toBe(201);
  locationId = location.json<{ id: string }>().id;
}, 90_000);

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
    await assertNoForeignKeyOrphans(admin);
  }
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
}, 60_000);

describe('the completion requirement of an AMC schedule', () => {
  it('is certification, not delivery, and states the certified total', async () => {
    // This is the assertion the pre-fix tree could not make. There, the
    // AMC item's category did not exist; had it been left uncategorised
    // its description does not say "installation", so it resolved to
    // 'delivery' and asked for 5 Year of despatched maintenance.
    const report = await readiness();
    expect(report.ready).toBe(false);

    const amc = unfinishedFor(report, 'B/1');
    expect(amc).toMatchObject({
      category: 'AMC',
      requirement: 'service',
      direction: 'short',
      requiredQuantity: '5.000',
      deliveredQuantity: '0.000',
      installedQuantity: '0.000',
      certifiedQuantity: '0.000',
    });

    // The supply half is untouched by any of this: same category, same
    // requirement, same delivery measurement.
    expect(unfinishedFor(report, 'A/1')).toMatchObject({
      category: 'SUPPLY',
      requirement: 'delivery',
      requiredQuantity: '4.000',
    });
  });

  it('names the certificate as the remedy, not a short closure', async () => {
    // "Amend the quantity down" is a legal short closure of a
    // maintenance contract but it is the wrong first instruction: the
    // ordinary reason an AMC item is short is that a period has been
    // served and its certificate is not recorded yet. The two arms of
    // the message are separate so the maintenance clerk is not told to
    // deliver something.
    const refused = await complete();
    expect(refused.statusCode, refused.body).toBe(409);
    const body = refused.json<{
      message: string;
      details: WorkNotFullyExecutedDetails;
    }>();
    expect(body).toMatchObject({ code: 'WORK_NOT_FULLY_EXECUTED' } as never);
    expect(body.message).toContain(
      '1 maintenance item(s) are not fully certified: B/1',
    );
    expect(body.message).toContain('Record the acceptance certificate');
    // The supply item keeps the movement sentence, and B/1 is not in it.
    expect(body.message).toContain('1 item(s) are short: A/1');
    expect(body.details.unfinishedItems.map((item) => item.itemNumber).sort()).toEqual([
      'A/1',
      'B/1',
    ]);
  });
});

describe('an AMC item takes no movement record', () => {
  it('refuses a Delivery Challan line naming it, in the database', async () => {
    // Raw SQL as the administrator: the trigger is the backstop for
    // every writer, present and future, not a restatement of a route
    // check. Migration 0068 section 3.
    const challanId = randomUUID();
    await admin`
      insert into delivery_challans (
        id, organisation_id, work_id, status, challan_date, prefix,
        created_by_user_id
      )
      values (
        ${challanId}, ${organisationId}, ${workId}, 'draft', '2026-08-05',
        'DC', ${ownerUserId}
      )
    `;
    await expect(
      admin`
        insert into delivery_challan_items (
          organisation_id, delivery_challan_id, work_id, work_item_id,
          description_snapshot, unit_snapshot, quantity, rate_snapshot,
          line_amount, position
        )
        values (
          ${organisationId}, ${challanId}, ${workId}, ${amcItemId},
          'AMC for SCH A items', 'Year', 1.000, 3623698.84, 3623698.84, 1
        )
      `,
    ).rejects.toThrow(/is an AMC item.*not delivered/s);

    // The same line naming the SUPPLY item is accepted, so the trigger
    // is refusing the category and not the shape of the insert.
    await admin`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position
      )
      values (
        ${organisationId}, ${challanId}, ${workId}, ${supplyItemId},
        'IPIS, complete', 'Nos', 1.000, 12000.00, 12000.00, 1
      )
    `;
    await admin`delete from delivery_challan_items where delivery_challan_id = ${challanId}`;
    await admin`delete from delivery_challans where id = ${challanId}`;
  });

  it('refuses an installation record naming it, in the database', async () => {
    await expect(
      admin`
        insert into installations (
          organisation_id, work_id, work_item_id, quantity, installed_on,
          location_id, location_name, recorded_by_user_id
        )
        values (
          ${organisationId}, ${workId}, ${amcItemId}, 1.000, '2026-08-05',
          ${locationId}, 'Kalyan station', ${ownerUserId}
        )
      `,
    ).rejects.toThrow(/is an AMC item.*not installed/s);
  });

  it('refuses a Delivery Challan line naming it, at the API', async () => {
    // The trigger is the floor; this is the sentence the operator reads.
    // Before this refusal existed the draft save reached the trigger and
    // the clerk got an unhandled 500 with a PL/pgSQL message in it.
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'DC',
        consignee: { name: 'DSTE (East) CR', address: 'Mumbai CST Division' },
        items: [{ workItemId: amcItemId, quantity: '1.000' }],
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'ITEM_NOT_DELIVERABLE' });
    expect(refused.json<{ message: string }>().message).toContain('B/1');
    expect(refused.json<{ message: string }>().message).toContain(
      'acceptance certificate',
    );
  });

  it('refuses an installation record naming it, at the API', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/installations`,
      organisationId,
      payload: {
        workItemId: amcItemId,
        quantity: '1.000',
        installedOn: '2026-08-05',
        locationId,
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'ITEM_NOT_INSTALLABLE' });
    expect(refused.json<{ message: string }>().message).toContain('B/1');
  });

  it('keeps it out of the delivery balance the challan editor picks from', async () => {
    // The editors build their item pickers straight from this register,
    // so an AMC item left in it would be offered for delivery and then
    // refused at save. Its delivery balance is not a small number — it
    // is not a number.
    const balance = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    expect(balance.statusCode, balance.body).toBe(200);
    const items = balance.json<WorkBalanceResponse>().items;
    expect(items.map((item) => item.itemNumber)).toEqual(['A/1']);
  });

  it('refuses recategorising an item into AMC while it carries movement', async () => {
    // The triggers above cannot speak about rows already written, so the
    // route closes the other direction: an item that HAS moved may not
    // become a maintenance schedule by relabelling.
    const installed = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/installations`,
      organisationId,
      payload: {
        workItemId: supplyItemId,
        quantity: '1.000',
        installedOn: '2026-08-01',
        locationId,
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    const installationId = installed.json<{ id: string }>().id;

    const refused = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${supplyItemId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'AMC' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'ITEM_HAS_MOVEMENT' });
    expect(refused.json<{ message: string }>().message).toContain('installation dated');

    // The same refusal through the payment-setup save, which changes
    // many items at once and evaluates this guard over the SET rather
    // than per item. A set-based guard that named no item, or named the
    // wrong one, would still be a 409 — so the item number is asserted.
    const refusedInBulk = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/payment-setup`,
      organisationId,
      payload: {
        matrixRows: [],
        itemCategories: [{ workItemId: supplyItemId, paymentCategory: 'AMC' }],
      },
    });
    expect(refusedInBulk.statusCode, refusedInBulk.body).toBe(409);
    expect(refusedInBulk.json()).toMatchObject({ code: 'ITEM_HAS_MOVEMENT' });
    expect(refusedInBulk.json<{ message: string }>().message).toContain('A/1');

    // Put the fixture back: the completion walk below measures A/1 on
    // delivery, and a stray installation is not part of that story.
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/installations/${installationId}/cancel`,
      organisationId,
      payload: { note: 'Recorded against the wrong item during the category test.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    // Released, so the relabel is now merely wrong rather than blocked —
    // and it is blocked for the other reason it should be, which is
    // nothing at all. Restore the category either way.
    const allowed = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${supplyItemId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'AMC' },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const restored = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${supplyItemId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'SUPPLY' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });
});

describe('certification of an AMC item', () => {
  it('caps at the sanctioned quantity, because nothing is installed', async () => {
    // R18's original ceiling is the installed total, which is
    // structurally zero here — that ceiling is exactly what made the
    // item uncertifiable. The AMC ceiling is the sanctioned quantity,
    // the same one R5 puts on installation.
    const list = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/pac-certificates`,
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    const summaries = list.json<PacCertificateListResponse>().itemSummaries;
    expect(summaries.find((row) => row.workItemId === amcItemId)).toEqual({
      workItemId: amcItemId,
      itemNumber: 'B/1',
      installedQuantity: '0.000',
      certificationBasis: 'sanctioned',
      supportingQuantity: '5.000',
      pacCertifiedQuantity: '0.000',
      availableQuantity: '5.000',
    });
    // The supply item keeps the installed basis in the same response.
    expect(summaries.find((row) => row.workItemId === supplyItemId)).toMatchObject({
      certificationBasis: 'installed',
      supportingQuantity: '0.000',
    });
  });

  it('accepts the served periods and refuses one beyond the sanction', async () => {
    const firstTwo = await certify('AMC-YEAR-1-2', amcItemId, '2.000');
    expect(firstTwo.statusCode, firstTwo.body).toBe(201);

    const overshoot = await certify('AMC-YEAR-3-6', amcItemId, '4.000');
    expect(overshoot.statusCode, overshoot.body).toBe(409);
    const refusal = overshoot.json<{
      code: string;
      message: string;
      details: PacCapExceededDetails;
    }>();
    expect(refusal.code).toBe('PAC_EXCEEDS_SANCTIONED');
    expect(refusal.message).toContain('sanctioned 5.000');
    expect(refusal.details.items).toEqual([
      {
        workItemId: amcItemId,
        itemNumber: 'B/1',
        basis: 'sanctioned',
        supporting: '5.000',
        covered: '2.000',
        available: '3.000',
      },
    ]);
  });

  it('refuses moving the item OUT of AMC while certificates stand against it', async () => {
    // The symmetric half of the movement guard, and the more dangerous
    // half. An AMC item certifies against its SANCTIONED quantity with
    // nothing installed; every other category certifies against its
    // INSTALLED total. Relabelling it here would leave 2.000 certified
    // against 0.000 installed — a state R18 exists to make unreachable,
    // which shows up as a negative available quantity on the PAC screen
    // and as certified quantities billing through a stage percentage
    // with no installation behind them.
    const refused = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${amcItemId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'PURE_INSTALLATION' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'ITEM_HAS_CERTIFICATION' });
    expect(refused.json<{ message: string }>().message).toContain('AMC-YEAR-1-2');

    // Clearing the category entirely is the same move and is refused the
    // same way — the guard is about leaving AMC, not about the
    // destination.
    const cleared = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${amcItemId}/payment-category`,
      organisationId,
      payload: { paymentCategory: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(409);
    expect(cleared.json()).toMatchObject({ code: 'ITEM_HAS_CERTIFICATION' });

    // And through the payment-setup save, whose guard runs over the set
    // of items leaving AMC rather than over one.
    const refusedInBulk = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/payment-setup`,
      organisationId,
      payload: {
        matrixRows: [],
        itemCategories: [
          { workItemId: amcItemId, paymentCategory: 'PURE_INSTALLATION' },
        ],
      },
    });
    expect(refusedInBulk.statusCode, refusedInBulk.body).toBe(409);
    expect(refusedInBulk.json()).toMatchObject({ code: 'ITEM_HAS_CERTIFICATION' });
    expect(refusedInBulk.json<{ message: string }>().message).toContain('AMC-YEAR-1-2');

    // Still AMC, and still certified 2.000 — the refusals changed
    // nothing.
    const [item] = await admin<{ payment_category: string | null }[]>`
      select payment_category from work_items where id = ${amcItemId}
    `;
    expect(item?.payment_category).toBe('AMC');
  });

  it('caps certification in the database as well as in the route', async () => {
    // R18 lived in exactly one layer, which is the shape recurring
    // finding 2 names. Raw SQL as the administrator, straight past the
    // route: the ceiling holds anyway.
    //
    // Run against the SEPARATE race Work, whose AMC item is sanctioned
    // 5.000 and certified nothing. A certificate line cannot be deleted
    // once written (0022's mutation guard refuses UPDATE and DELETE), so
    // an accepted insert is permanent — and doing that to the flagship
    // fixture would move the completion predicate the walk below
    // measures.
    const certificateId = randomUUID();
    await admin`
      insert into pac_certificates (
        id, organisation_id, work_id, reference, issue_date,
        consignee_master_id, consignee_designation, recorded_by_user_id
      )
      values (
        ${certificateId}, ${organisationId}, ${raceWorkId}, ${`RAW-${runId}`},
        '2026-08-05', ${consigneeId}, 'DSTE (East) CR', ${ownerUserId}
      )
    `;
    // Sanctioned 5.000, certified nothing, so 6.000 is over.
    await expect(
      admin`
        insert into pac_certificate_items (
          organisation_id, pac_certificate_id, work_id, work_item_id,
          certified_quantity
        )
        values (
          ${organisationId}, ${certificateId}, ${raceWorkId}, ${raceAmcItemId}, 6.000
        )
      `,
    ).rejects.toThrow(/certification ceiling.*sanctioned quantity 5\.000/s);

    // 5.000 exactly reaches the ceiling and is accepted, so the trigger
    // holds a ceiling rather than refusing every write.
    await admin`
      insert into pac_certificate_items (
        organisation_id, pac_certificate_id, work_id, work_item_id,
        certified_quantity
      )
      values (
        ${organisationId}, ${certificateId}, ${raceWorkId}, ${raceAmcItemId}, 5.000
      )
    `;

    // An installable item with nothing installed caps at zero, which is
    // the original R18 rule still in force for every other category.
    await expect(
      admin`
        insert into pac_certificate_items (
          organisation_id, pac_certificate_id, work_id, work_item_id,
          certified_quantity
        )
        values (
          ${organisationId}, ${certificateId}, ${raceWorkId}, ${raceItemId}, 1.000
        )
      `,
    ).rejects.toThrow(/certification ceiling.*installed quantity 0\.000/s);
  });

  it('moves the completion predicate as each period is certified', async () => {
    const partway = unfinishedFor(await readiness(), 'B/1');
    expect(partway).toMatchObject({
      requirement: 'service',
      requiredQuantity: '5.000',
      certifiedQuantity: '2.000',
    });

    const rest = await certify('AMC-YEAR-3-5', amcItemId, '3.000');
    expect(rest.statusCode, rest.body).toBe(201);

    // Fully certified, so it leaves the worklist entirely.
    const report = await readiness();
    expect(unfinishedFor(report, 'B/1')).toBeUndefined();
    expect(report.unfinished.map((item) => item.itemNumber)).toEqual(['A/1']);
  });
});

describe('the Work completes once the maintenance is certified', () => {
  it('closes at 100% executed value with no fabricated challan line', async () => {
    // Deliver the physical half through the real issue path, so the only
    // Delivery Challan on this Work is the one that carries material
    // that actually moved.
    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'DC',
        consignee: { name: 'DSTE (East) CR', address: 'Mumbai CST Division' },
        items: [{ workItemId: supplyItemId, quantity: '4.000' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const challanId = draft.json<ChallanDetailResponse>().challan.id;
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const report = await readiness();
    expect(report.unfinished).toEqual([]);
    expect(report.blockers).toEqual([]);
    expect(report.ready).toBe(true);

    const completed = await complete();
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({ work: { status: 'completed' } });

    // And the AMC value was never routed through a movement document:
    // no Delivery Challan line and no installation names the item.
    const [movement] = await admin<{ lines: string; installs: string }[]>`
      select
        (select count(*) from delivery_challan_items
          where work_item_id = ${amcItemId})::text as lines,
        (select count(*) from installations
          where work_item_id = ${amcItemId})::text as installs
    `;
    expect(movement).toEqual({ lines: '0', installs: '0' });
  });
});

describe('a completed Work refuses a category change', () => {
  it('refuses the payment-category PATCH once the Work is completed', async () => {
    // R8: a completed Work is closed to edits. The category decides
    // WHICH quantity the completion predicate measured, so changing it
    // afterwards would rewrite the basis of a closure already recorded —
    // and the route took no works lock and no operable check at all
    // before this, unlike its sibling tax-facts PATCH.
    const refused = await authed(owner, {
      method: 'PATCH',
      url: `/api/work-items/${supplyItemId}/payment-category`,
      organisationId,
      payload: { paymentCategory: 'SPARE_SUPPLY' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'WORK_COMPLETED' });
  });
});

describe('a category change and a challan line cannot interleave', () => {
  it('serialises a simultaneous draft save and recategorisation', async () => {
    // The write skew this closes: the draft save used to join
    // `work_items` lock-free while holding only the works lock, so it
    // could read SUPPLY from an item a concurrent PATCH was turning into
    // AMC — and neither transaction could see the other. Migration
    // 0068's trigger cannot catch it (it fires on the line, and issuing
    // a challan updates the challan's status rather than the line), so
    // the guarantee has to come from the lock.
    //
    // Whichever order the two land in, the tree must stay consistent:
    // either the item is AMC and no line names it, or the line exists
    // and the item is not AMC. The one outcome that must never occur is
    // both.
    const [saved, patched] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/works/${raceWorkId}/challans`,
        organisationId,
        payload: {
          challanDate: '2026-08-08',
          prefix: 'DC',
          consignee: { name: 'DSTE (East) CR', address: 'Mumbai CST Division' },
          items: [{ workItemId: raceItemId, quantity: '1.000' }],
        },
      }),
      authed(owner, {
        method: 'PATCH',
        url: `/api/work-items/${raceItemId}/payment-category`,
        organisationId,
        payload: { paymentCategory: 'AMC' },
      }),
    ]);

    const [state] = await admin<{ category: string | null; lines: string }[]>`
      select wi.payment_category as category,
             (select count(*) from delivery_challan_items dci
               join delivery_challans dc on dc.id = dci.delivery_challan_id
               where dci.work_item_id = ${raceItemId}
                 and dc.status <> 'cancelled')::text as lines
      from work_items wi where wi.id = ${raceItemId}
    `;
    const bothWon = state?.category === 'AMC' && state.lines !== '0';
    expect(
      bothWon,
      `save ${String(saved.statusCode)} ${saved.body} | patch ${String(patched.statusCode)} ${patched.body}`,
    ).toBe(false);

    // And each response agrees with the state that survived, rather than
    // reporting a success the tree does not show.
    if (state?.category === 'AMC') {
      expect(patched.statusCode, patched.body).toBe(200);
      // The save either lost the race outright or was refused by the
      // category guard it can now see.
      expect([409, 201]).toContain(saved.statusCode);
      if (saved.statusCode === 409) {
        expect(saved.json()).toMatchObject({ code: 'ITEM_NOT_DELIVERABLE' });
      }
    } else {
      expect(saved.statusCode, saved.body).toBe(201);
      expect(patched.statusCode, patched.body).toBe(409);
      expect(patched.json()).toMatchObject({ code: 'ITEM_HAS_MOVEMENT' });
    }
  });
});

describe('the issue transition re-reads the category', () => {
  it('refuses to issue a challan whose line became an AMC item', async () => {
    // The second end of the write skew, made deterministic. A draft line
    // is written legally against a SUPPLY item; the category then moves
    // to AMC by raw SQL, which is what a lost race would leave behind.
    //
    // Nothing else catches this. Migration 0068's trigger fires on the
    // LINE, and issuing a challan updates `delivery_challans.status`
    // rather than the line, so it never gets a second look — without the
    // gate at the issue transition, issued delivery quantity would stand
    // against an item that can never be delivered, and the completion
    // predicate would measure it on a dimension nothing can move.
    // R3 allows one open draft per Work, and the race above may or may
    // not have left one behind depending on which side won. Clear it
    // first so this test starts from the same place either way.
    const existing = await admin<{ id: string }[]>`
      select id from delivery_challans
      where work_id = ${raceWorkId} and status = 'draft'
    `;
    for (const stale of existing) {
      const discarded = await authed(owner, {
        method: 'DELETE',
        url: `/api/challans/${stale.id}`,
        organisationId,
      });
      expect(discarded.statusCode, discarded.body).toBe(204);
    }

    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${raceWorkId}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-08-08',
        prefix: 'DC',
        consignee: { name: 'DSTE (East) CR', address: 'Mumbai CST Division' },
        items: [{ workItemId: raceIssueItemId, quantity: '2.000' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const challanId = draft.json<ChallanDetailResponse>().challan.id;

    await admin`
      update work_items set payment_category = 'AMC' where id = ${raceIssueItemId}
    `;

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(409);
    expect(issued.json()).toMatchObject({ code: 'ITEM_NOT_DELIVERABLE' });
    expect(issued.json<{ message: string }>().message).toContain('A/3');

    // Still a draft, so nothing was delivered against the AMC item.
    const [row] = await admin<{ status: string; issued: string }[]>`
      select dc.status,
             (select count(*) from delivery_challan_items dci
               join delivery_challans d on d.id = dci.delivery_challan_id
               where dci.work_item_id = ${raceIssueItemId}
                 and d.status = 'issued')::text as issued
      from delivery_challans dc where dc.id = ${challanId}
    `;
    expect(row).toEqual({ status: 'draft', issued: '0' });

    // Put it back so the draft can be discarded cleanly.
    await admin`
      update work_items set payment_category = 'SUPPLY' where id = ${raceIssueItemId}
    `;
  });
});

describe('the final Measurement Book bills the AMC item on its certified quantity', () => {
  it('earns the final-bill stage on the certified quantity, not on 0', async () => {
    // The wiring this holds: `resolveFinalBillBase` sends an AMC item
    // down a 'certified' branch, and the certified total reaches it
    // through `loadAmcCertified` + `computeForBook` rather than through
    // the Measurement Book loader (see that function's note for why it
    // is not a seventh CTE). If the overlay were missing the base would
    // silently be 0 — a final bill that pays nothing for the maintenance
    // — and every other assertion in this suite would still pass.
    const matrix = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${billWorkId}/payment-matrix/AMC`,
      organisationId,
      payload: {
        pctSupply: '0.00',
        pctInstallation: '0.00',
        pctPac: '60.00',
        pctFinalBill: '40.00',
      },
    });
    expect(matrix.statusCode, matrix.body).toBe(200);

    // Two years served and certified, at the sanctioned ceiling.
    const certificate = await authed(owner, {
      method: 'POST',
      url: `/api/works/${billWorkId}/pac-certificates`,
      organisationId,
      payload: {
        reference: `AMC-BILL-${runId}`,
        issueDate: '2026-08-05',
        consigneeMasterId: consigneeId,
        items: [{ workItemId: billAmcItemId, certifiedQuantity: '2.000' }],
      },
    });
    expect(certificate.statusCode, certificate.body).toBe(201);
    const certificateId = certificate.json<{ id: string }>().id;

    const draft = await authed(owner, {
      method: 'POST',
      url: `/api/works/${billWorkId}/measurement-books`,
      organisationId,
      payload: { mbDate: '2026-08-08', kind: 'final' },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const bookId = draft.json<MeasurementBookDetailResponse>().book.id;

    const sources = await authed(owner, {
      method: 'PUT',
      url: `/api/measurement-books/${bookId}/sources`,
      organisationId,
      payload: {
        sources: [{ sourceType: 'pac_certificate', sourceId: certificateId }],
      },
    });
    expect(sources.statusCode, sources.body).toBe(200);

    const finalized = await authed(owner, {
      method: 'POST',
      url: `/api/measurement-books/${bookId}/finalize`,
      organisationId,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const detail = finalized.json<MeasurementBookDetailResponse>();
    const line = detail.lines.find((entry) => entry.itemNumber === 'B/1');

    // The certification stage bills the delta this MB claimed; the
    // final-bill stage bills the CERTIFIED base — 2.000, the number that
    // would be 0 if the overlay never ran.
    expect(line).toMatchObject({
      paymentCategory: 'AMC',
      deltaPac: '2.000',
      deltaFinalBill: '2.000',
      amountPac: '1200.00',
      amountFinalBill: '800.00',
    });
    // 2 Year x 1000.00 = 2000.00, split 60/40 across the two stages an
    // AMC row may bill on, and nothing on supply or installation.
    expect(line).toMatchObject({
      amountSupply: '0.00',
      amountInstallation: '0.00',
      lineTotal: '2000.00',
    });
  });
});

describe('the AMC payment-matrix row', () => {
  it('refuses value on a stage an AMC item can never move, at the API', async () => {
    // The DB CHECK below is the backstop. This is the refusal an
    // operator can act on: before it, the constraint violation reached
    // the screen as an opaque failure with a constraint name in it.
    const refused = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/payment-matrix/AMC`,
      organisationId,
      payload: {
        pctSupply: '80.00',
        pctInstallation: '0.00',
        pctPac: '10.00',
        pctFinalBill: '10.00',
      },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'PAYMENT_MATRIX_AMC_STAGE_INVALID' });
    expect(refused.json<{ message: string }>().message).toContain('supply');

    // Both stages named at once when both are wrong.
    const bothWrong = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/payment-matrix/AMC`,
      organisationId,
      payload: {
        pctSupply: '50.00',
        pctInstallation: '30.00',
        pctPac: '10.00',
        pctFinalBill: '10.00',
      },
    });
    expect(bothWrong.statusCode, bothWrong.body).toBe(400);
    expect(bothWrong.json<{ message: string }>().message).toContain(
      'supply and installation',
    );

    // The legal shape is accepted, so the rule is not refusing the row.
    const accepted = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/payment-matrix/AMC`,
      organisationId,
      payload: {
        pctSupply: '0.00',
        pctInstallation: '0.00',
        pctPac: '90.00',
        pctFinalBill: '10.00',
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    // And the same percentages on a category that CAN move them stay
    // legal, so the rule is scoped to AMC.
    const supplyRow = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/payment-matrix/SUPPLY`,
      organisationId,
      payload: {
        pctSupply: '80.00',
        pctInstallation: '0.00',
        pctPac: '10.00',
        pctFinalBill: '10.00',
      },
    });
    expect(supplyRow.statusCode, supplyRow.body).toBe(200);

    await admin`
      delete from payment_matrices
      where work_id = ${workId} and category in ('AMC', 'SUPPLY')
    `;
  });

  it('refuses value on a stage an AMC item can never move', async () => {
    // pct_supply and pct_installation bill delta_supplied and
    // delta_installed, both permanently zero for an AMC item. A row that
    // parks contract value there makes the value unbillable and points
    // the operator back at the fabricated challan.
    await expect(
      admin`
        insert into payment_matrices (
          organisation_id, work_id, category, pct_supply, pct_installation,
          pct_pac, pct_final_bill, created_by_user_id
        )
        values (
          ${organisationId}, ${workId}, 'AMC', 80.00, 0.00, 10.00, 10.00,
          ${ownerUserId}
        )
      `,
    ).rejects.toThrow(/payment_matrices_amc_bills_on_certification/);

    const accepted = await admin`
      insert into payment_matrices (
        organisation_id, work_id, category, pct_supply, pct_installation,
        pct_pac, pct_final_bill, created_by_user_id
      )
      values (
        ${organisationId}, ${workId}, 'AMC', 0.00, 0.00, 90.00, 10.00,
        ${ownerUserId}
      )
      returning id
    `;
    expect(accepted).toHaveLength(1);
  });
});
