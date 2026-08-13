import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  PacCapExceededDetails,
  PacCertificateListResponse,
  UnfinishedWorkItem,
  WorkCompletionReadiness,
  WorkNotFullyExecutedDetails,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  createDatabasePool,
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

describe('the AMC payment-matrix row', () => {
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
