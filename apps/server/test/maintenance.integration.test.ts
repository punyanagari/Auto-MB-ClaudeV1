import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  MaintenanceDetailResponse,
  MaintenanceListResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  removeOrganisationResidue,
} from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * Maintenance — the site material request (migration 0088).
 *
 * What is proved here, in the order the module's own risks run:
 *
 *   1. NUMBERING — a gap-free per-organisation request series and a
 *      gap-free per-Work challan series, both under SIMULTANEOUS writes
 *      (engineering rule 9);
 *   2. the DERIVED quantities — reserved, dispatched and received-back
 *      come off the challans and the receipts, so the four columns the
 *      mock stores cannot drift;
 *   3. the STOCK LEDGER — a dispatch of a catalogue part moves the shelf
 *      and names its challan; a custom line moves nothing; a defective
 *      return moves nothing either;
 *   4. the CEILINGS — a dispatch cannot exceed what a line has left, a
 *      return cannot exceed what it owes back, and the same refusals hold
 *      in raw SQL with the route bypassed;
 *   5. the CLOSURE GATE — refused while anything is outstanding, and
 *      reachable only because a line can be written off;
 *   6. the WALLS — owner-only approval, the issue authority on the
 *      dispatch, work-scope on every read, and RLS for the other
 *      organisation.
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
const ownerEmail = `mnt-owner-${runId}@integration.test`;
const officeEmail = `mnt-office-${runId}@integration.test`;
const assignedEmail = `mnt-assigned-${runId}@integration.test`;
const outsiderEmail = `mnt-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let organisationId: string;
let outsiderOrganisationId: string;
let workId: string;
let otherWorkId: string;
let partId: string;
let scarcePartId: string;
let unrelatedPartId: string;
const workCode = `MN-${runId.toUpperCase()}`;
const otherWorkCode = `MO-${runId.toUpperCase()}`;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let assigned: CookieJar;
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

async function seedWork(code: string, organisation: string): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${id}, ${organisation}, ${code}, ${`L-${code}`}, '2026-01-05',
      ${`Maintenance fixture ${code}`}, '10000000.00', '9000000.00',
      'per_schedule', 'fixture'
    )
  `;
  return id;
}

/** A catalogue part with `onHand` already on the shelf, so a dispatch has
 * something to take. Seeded through the ledger rather than a balance
 * column, because there is no balance column (0087). */
async function seedPart(code: string, onHand: number): Promise<string> {
  const [item] = await admin<{ id: string }[]>`
    insert into production_items (
      organisation_id, item_code, name, category, unit, manufactured,
      created_by_user_id
    )
    values (
      ${organisationId}, ${code}, ${`Fixture ${code}`}, 'Power supplies',
      'Nos', false, 'fixture'
    )
    returning id
  `;
  if (!item) throw new Error('part seed failed');
  if (onHand > 0) {
    await admin`
      insert into stock_movements (
        organisation_id, production_item_id, movement_type, quantity,
        movement_date, reason, created_by_user_id
      )
      values (
        ${organisationId}, ${item.id}, 'adjustment_in', ${onHand},
        (select app_private.organisation_today(${organisationId})),
        'opening count for the maintenance fixture', 'fixture'
      )
    `;
  }
  return item.id;
}

async function onHandOf(itemId: string): Promise<number> {
  const [row] = await admin<{ balance: string }[]>`
    select app_private.stock_on_hand(${organisationId}, ${itemId})::text as balance
  `;
  return Number(row?.balance ?? '0');
}

interface RaiseOptions {
  readonly work?: string;
  readonly jar?: CookieJar;
  readonly organisation?: string;
  readonly lines?: readonly Record<string, unknown>[];
}

async function raise(options: RaiseOptions = {}) {
  return authed(options.jar ?? office, {
    method: 'POST',
    url: '/api/maintenance',
    organisationId: options.organisation ?? organisationId,
    payload: {
      workId: options.work ?? workId,
      station: 'Churchgate',
      requesterName: 'Amit Patil',
      priority: 'urgent',
      faultSummary: 'Replace failed platform display power supplies',
      lines: options.lines ?? [
        {
          itemId: partId,
          description: 'ignored',
          unit: 'ignored',
          quantity: '4',
          expectedReturnQuantity: '4',
        },
      ],
    },
  });
}

async function raiseAndApprove(options: RaiseOptions = {}): Promise<string> {
  const created = await raise(options);
  expect(created.statusCode, created.body).toBe(201);
  const { id } = created.json<{ id: string }>();
  const approved = await authed(owner, {
    method: 'POST',
    url: `/api/maintenance/${id}/approve`,
    organisationId,
    payload: { comment: 'Approved against available maintenance stock' },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return id;
}

async function detail(id: string, jar: CookieJar = owner) {
  const response = await authed(jar, {
    method: 'GET',
    url: `/api/maintenance/${id}`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<MaintenanceDetailResponse>();
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-maintenance-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
  });

  owner = await signUp(ownerEmail, 'Maintenance Owner');
  office = await signUp(officeEmail, 'Maintenance Office');
  assigned = await signUp(assignedEmail, 'Maintenance Assigned');
  outsider = await signUp(outsiderEmail, 'Maintenance Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Maintenance Constructions', slug: `mnt-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Maintenance Outsiders', slug: `mnt-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const email of [officeEmail, assignedEmail]) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role: 'office' },
    });
    expect(added.statusCode, added.body).toBe(201);
  }
  // The office member issues documents; the assigned member sees only
  // the Works they are on, which is the predicate every read is measured
  // against.
  await admin`
    update organisation_memberships set can_issue_documents = true
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${officeEmail})
  `;
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${assignedEmail})
  `;

  workId = await seedWork(workCode, organisationId);
  otherWorkId = await seedWork(otherWorkCode, organisationId);
  // The assigned member is on the FIRST Work and not the second, so the
  // authority test can reach a request they may read and the work-scope
  // test can reach one they may not.
  await admin`
    insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
    select ${organisationId}, ${workId}, u."id", 'fixture'
    from auth_users u where u."email" = ${assignedEmail}
  `;
  partId = await seedPart(`MP-${runId.toUpperCase()}`, 30);
  scarcePartId = await seedPart(`MS-${runId.toUpperCase()}`, 1);
  unrelatedPartId = await seedPart(`MU-${runId.toUpperCase()}`, 50);
}, 180_000);

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
});

describe('numbering', () => {
  it('numbers requests gap-free per organisation, even simultaneously', async () => {
    const [first, second, third] = await Promise.all([raise(), raise(), raise()]);
    for (const response of [first, second, third]) {
      expect(response?.statusCode, response?.body).toBe(201);
    }
    const numbers = [first, second, third].map(
      (response) => response?.json<{ number: string }>().number ?? '',
    );
    for (const number of numbers) {
      expect(number).toMatch(/^MR\/\d{2}-\d{2}\/\d{5}$/);
    }
    expect(new Set(numbers).size).toBe(3);

    // Gap-free within the series: the serials this organisation holds are
    // a contiguous run from one. Read from the column rather than from
    // the rendered string, because gaplessness is a fact about the
    // sequence and the string only renders it.
    const rows = await admin<{ sequence_number: number }[]>`
      select sequence_number from maintenance_requests
      where organisation_id = ${organisationId}
      order by sequence_number
    `;
    expect(rows.map((row) => Number(row.sequence_number))).toEqual(
      rows.map((_, index) => index + 1),
    );
  });

  it('numbers dispatch challans gap-free per Work', async () => {
    const id = await raiseAndApprove();
    for (let index = 0; index < 2; index += 1) {
      const response = await authed(office, {
        method: 'POST',
        url: `/api/maintenance/${id}/dispatches`,
        organisationId,
        payload: {
          stockLocation: 'Central store',
          receiverName: 'Site supervisor',
          lines: [{ lineId: (await detail(id)).lines[0]?.id ?? '', quantity: '1' }],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    const after = await detail(id);
    const numbers = after.dispatches.map((dispatch) => dispatch.challanNumber);
    expect(numbers.every((number) => number.startsWith(`${workCode}/MNT/`))).toBe(true);

    const rows = await admin<{ sequence_number: number }[]>`
      select sequence_number from maintenance_dispatches
      where organisation_id = ${organisationId} and work_id = ${workId}
      order by sequence_number
    `;
    expect(rows.map((row) => Number(row.sequence_number))).toEqual(
      rows.map((_, index) => index + 1),
    );
  });
});

describe('the derived quantities and the stock ledger', () => {
  it('derives reserved, dispatched and received-back, and moves the shelf', async () => {
    const before = await onHandOf(partId);
    const id = await raiseAndApprove();
    const opened = await detail(id);
    const line = opened.lines[0];
    expect(line).toBeDefined();
    if (!line) return;
    // Approval reserves nothing of its own: "reserved" is what the line
    // still owes, which before any dispatch is the whole of it.
    expect(line.outstandingQuantity).toBe('4.000');
    expect(line.dispatchedQuantity).toBe('0.000');
    expect(line.onHand).toBe(`${String(before)}.000`);

    const dispatched = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/dispatches`,
      organisationId,
      payload: {
        stockLocation: 'Central store',
        receiverName: 'Site supervisor',
        lines: [{ lineId: line.id, quantity: '3' }],
      },
    });
    expect(dispatched.statusCode, dispatched.body).toBe(200);
    const after = dispatched.json<MaintenanceDetailResponse>();
    expect(after.lines[0]?.dispatchedQuantity).toBe('3.000');
    expect(after.lines[0]?.outstandingQuantity).toBe('1.000');
    expect(after.request.status).toBe('partially_dispatched');

    // The shelf moved by exactly what left it, and the movement names the
    // challan that took it.
    expect(await onHandOf(partId)).toBe(before - 3);
    const [movement] = await admin<{ quantity: string; challan: string }[]>`
      select m.quantity::text as quantity, d.challan_number as challan
      from stock_movements m
      join maintenance_dispatches d
        on d.organisation_id = m.organisation_id
       and d.id = m.maintenance_dispatch_id
      where m.organisation_id = ${organisationId}
        and d.maintenance_request_id = ${id}
    `;
    expect(movement?.quantity).toBe('-3.000');
    expect(movement?.challan).toBe(after.dispatches[0]?.challanNumber);

    // The defective return moves NOTHING: a broken unit on a bench is not
    // available material.
    const shelfBeforeReturn = await onHandOf(partId);
    const received = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/returns`,
      organisationId,
      payload: {
        lineId: line.id,
        quantity: '2',
        conditionNote: 'Burnt output stage',
        repairDisposition: 'Bench repair',
        receivedBy: 'Store clerk',
      },
    });
    expect(received.statusCode, received.body).toBe(200);
    const withReturn = received.json<MaintenanceDetailResponse>();
    expect(withReturn.lines[0]?.receivedReturnQuantity).toBe('2.000');
    // ONE, not two. The line promised four back and only THREE went out,
    // so three is the most it can owe; two have arrived. Read against the
    // gross promise this would be 2, and a line that is later written off
    // short would owe units whose replacements never left the store.
    expect(withReturn.lines[0]?.returnDueQuantity).toBe('1.000');
    expect(await onHandOf(partId)).toBe(shelfBeforeReturn);
  });

  it('moves no stock for a line that names no catalogue part', async () => {
    const id = await raiseAndApprove({
      lines: [
        {
          description: 'Weatherproof gland kit',
          unit: 'Set',
          quantity: '2',
          expectedReturnQuantity: '0',
        },
      ],
    });
    const line = (await detail(id)).lines[0];
    expect(line?.itemId).toBeNull();
    expect(line?.onHand).toBeNull();

    const dispatched = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/dispatches`,
      organisationId,
      payload: {
        stockLocation: 'Central store',
        receiverName: 'Site supervisor',
        lines: [{ lineId: line?.id ?? '', quantity: '2' }],
      },
    });
    expect(dispatched.statusCode, dispatched.body).toBe(200);
    const [count] = await admin<{ n: string }[]>`
      select count(*)::text as n from stock_movements m
      join maintenance_dispatches d
        on d.organisation_id = m.organisation_id
       and d.id = m.maintenance_dispatch_id
      where d.maintenance_request_id = ${id}
    `;
    expect(count?.n).toBe('0');
  });
});

describe('the ceilings', () => {
  it('refuses a dispatch beyond what the line has left, in the route and in raw SQL', async () => {
    const id = await raiseAndApprove();
    const line = (await detail(id)).lines[0];
    const refused = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/dispatches`,
      organisationId,
      payload: {
        stockLocation: 'Central store',
        receiverName: 'Site supervisor',
        lines: [{ lineId: line?.id ?? '', quantity: '5' }],
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'MAINTENANCE_DISPATCH_EXCEEDS_OUTSTANDING',
    );

    // And with the route bypassed entirely: the guard is the arm that
    // holds when a writer reaches the table another way.
    const [dispatch] = await admin<{ id: string }[]>`
      insert into maintenance_dispatches (
        organisation_id, maintenance_request_id, work_id, challan_number,
        sequence_number, dispatch_date, stock_location, receiver_name,
        created_by_user_id
      )
      values (
        ${organisationId}, ${id}, ${workId}, ${`RAW-${runId}`}, 9001,
        (select app_private.organisation_today(${organisationId})),
        'Raw store', 'Raw receiver', 'fixture'
      )
      returning id
    `;
    await expect(
      admin`
        insert into maintenance_dispatch_lines (
          organisation_id, maintenance_dispatch_id, maintenance_request_line_id,
          quantity
        )
        values (${organisationId}, ${dispatch?.id ?? ''}, ${line?.id ?? ''}, 99)
      `,
    ).rejects.toMatchObject({ code: '23G02' });
  });

  it('refuses a return beyond what the line owes back', async () => {
    const id = await raiseAndApprove({
      lines: [
        {
          itemId: partId,
          description: 'ignored',
          unit: 'ignored',
          quantity: '2',
          expectedReturnQuantity: '1',
        },
      ],
    });
    const line = (await detail(id)).lines[0];
    const refused = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/returns`,
      organisationId,
      payload: {
        lineId: line?.id ?? '',
        quantity: '2',
        conditionNote: 'Burnt output stage',
        repairDisposition: 'Bench repair',
        receivedBy: 'Store clerk',
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'MAINTENANCE_RETURN_EXCEEDS_EXPECTED',
    );
  });

  it('refuses the dispatch that would take the shelf below zero', async () => {
    const id = await raiseAndApprove({
      lines: [
        {
          itemId: scarcePartId,
          description: 'ignored',
          unit: 'ignored',
          quantity: '4',
          expectedReturnQuantity: '0',
        },
      ],
    });
    const line = (await detail(id)).lines[0];
    // The line is within its own ceiling; the SHELF is what refuses, and
    // the refusal comes from the 0087 ledger through this module's map.
    const refused = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/dispatches`,
      organisationId,
      payload: {
        stockLocation: 'Central store',
        receiverName: 'Site supervisor',
        lines: [{ lineId: line?.id ?? '', quantity: '4' }],
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('STOCK_INSUFFICIENT');
    // Nothing partial survives the refusal: the whole dispatch rolled back.
    expect(await onHandOf(scarcePartId)).toBe(1);
    expect((await detail(id)).dispatches).toHaveLength(0);
  });

  it('serialises two simultaneous dispatches of the same last unit', async () => {
    const id = await raiseAndApprove({
      lines: [
        {
          itemId: partId,
          description: 'ignored',
          unit: 'ignored',
          quantity: '1',
          expectedReturnQuantity: '0',
        },
      ],
    });
    const lineId = (await detail(id)).lines[0]?.id ?? '';
    const body = {
      stockLocation: 'Central store',
      receiverName: 'Site supervisor',
      lines: [{ lineId, quantity: '1' }],
    };
    const [first, second] = await Promise.all([
      authed(office, {
        method: 'POST',
        url: `/api/maintenance/${id}/dispatches`,
        organisationId,
        payload: body,
      }),
      authed(office, {
        method: 'POST',
        url: `/api/maintenance/${id}/dispatches`,
        organisationId,
        payload: body,
      }),
    ]);
    const codes = [first?.statusCode, second?.statusCode].sort(
      (a, b) => Number(a) - Number(b),
    );
    expect(codes).toEqual([200, 409]);
    const after = await detail(id);
    expect(after.lines[0]?.dispatchedQuantity).toBe('1.000');
    expect(after.dispatches).toHaveLength(1);
  });
});

describe('the closure gate', () => {
  it('refuses closure while anything is outstanding, and opens once the balance is written off', async () => {
    const id = await raiseAndApprove({
      lines: [
        {
          itemId: partId,
          description: 'ignored',
          unit: 'ignored',
          quantity: '4',
          expectedReturnQuantity: '1',
        },
      ],
    });
    const line = (await detail(id)).lines[0];
    const lineId = line?.id ?? '';

    const tooEarly = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/close`,
      organisationId,
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(409);
    expect(tooEarly.json<{ code: string }>().code).toBe('MAINTENANCE_NOT_CLOSEABLE');

    const dispatched = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/dispatches`,
      organisationId,
      payload: {
        stockLocation: 'Central store',
        receiverName: 'Site supervisor',
        lines: [{ lineId, quantity: '1' }],
      },
    });
    expect(dispatched.statusCode, dispatched.body).toBe(200);

    // The remainder is never coming: write it off, which is the writer
    // the mock's own closure gate is missing.
    const writtenOff = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/lines/${lineId}/cancel`,
      organisationId,
      payload: { quantity: '3', reason: 'Site sourced the balance locally' },
    });
    expect(writtenOff.statusCode, writtenOff.body).toBe(200);
    expect(writtenOff.json<MaintenanceDetailResponse>().canClose).toBe(false);

    // Still blocked: one failed unit is owed back.
    const stillBlocked = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/close`,
      organisationId,
    });
    expect(stillBlocked.statusCode, stillBlocked.body).toBe(409);

    const received = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/returns`,
      organisationId,
      payload: {
        lineId,
        quantity: '1',
        conditionNote: 'Burnt output stage',
        repairDisposition: 'Bench repair',
        receivedBy: 'Store clerk',
      },
    });
    expect(received.statusCode, received.body).toBe(200);
    expect(received.json<MaintenanceDetailResponse>().canClose).toBe(true);

    const closed = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/close`,
      organisationId,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json<MaintenanceDetailResponse>().request.status).toBe('closed');

    // A closed request is terminal, in the database as well as the route.
    await expect(
      admin`
        update maintenance_requests set status = 'approved' where id = ${id}
      `,
    ).rejects.toMatchObject({ code: '23G01' });
  });

  it('closes a part-dispatched request whose balance is written off', async () => {
    // THE DEADLOCK THIS IS HERE FOR. Default fixture: 4 asked, 4 promised
    // back. Dispatch 1, write off the other 3, receive the 1 that
    // actually went out — and the gate must open. Computed against the
    // gross promise it never does: three units whose replacements were
    // never sent stay owed forever, and `expected_return_quantity` is
    // frozen, so nothing can lower it.
    const id = await raiseAndApprove();
    const lineId = (await detail(id)).lines[0]?.id ?? '';

    const dispatched = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/dispatches`,
      organisationId,
      payload: {
        stockLocation: 'Central store',
        receiverName: 'Site supervisor',
        lines: [{ lineId, quantity: '1' }],
      },
    });
    expect(dispatched.statusCode, dispatched.body).toBe(200);

    const writtenOff = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/lines/${lineId}/cancel`,
      organisationId,
      payload: { reason: 'The balance is not coming' },
    });
    expect(writtenOff.statusCode, writtenOff.body).toBe(200);
    const afterWriteOff = writtenOff.json<MaintenanceDetailResponse>();
    // The write-off takes the WHOLE outstanding balance — no quantity is
    // sent, so a partial one cannot leave the line unreachable.
    expect(afterWriteOff.lines[0]?.cancelledQuantity).toBe('3.000');
    expect(afterWriteOff.lines[0]?.outstandingQuantity).toBe('0.000');
    // …and the promise has collapsed to the one unit that actually left.
    expect(afterWriteOff.lines[0]?.returnDueQuantity).toBe('1.000');
    expect(afterWriteOff.canClose).toBe(false);

    const received = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/returns`,
      organisationId,
      payload: {
        lineId,
        quantity: '1',
        conditionNote: 'Burnt output stage',
        repairDisposition: 'Bench repair',
        receivedBy: 'Store clerk',
      },
    });
    expect(received.statusCode, received.body).toBe(200);
    expect(received.json<MaintenanceDetailResponse>().canClose).toBe(true);

    const closed = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/close`,
      organisationId,
    });
    expect(closed.statusCode, closed.body).toBe(200);
  });

  it('refuses a receipt for a replacement that never went out', async () => {
    // The other half of the same cap. Nothing has been dispatched, so the
    // line owes nothing back yet however much it promised — and the guard
    // says so with the route bypassed as well.
    const id = await raiseAndApprove();
    const lineId = (await detail(id)).lines[0]?.id ?? '';
    expect((await detail(id)).lines[0]?.returnDueQuantity).toBe('0.000');

    const refused = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/returns`,
      organisationId,
      payload: {
        lineId,
        quantity: '1',
        conditionNote: 'Burnt output stage',
        repairDisposition: 'Bench repair',
        receivedBy: 'Store clerk',
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'MAINTENANCE_RETURN_EXCEEDS_EXPECTED',
    );

    await expect(
      admin`
        insert into maintenance_returns (
          organisation_id, maintenance_request_id, maintenance_request_line_id,
          quantity, received_on, condition_note, repair_disposition, received_by,
          created_by_user_id
        )
        values (
          ${organisationId}, ${id}, ${lineId}, 1,
          (select app_private.organisation_today(${organisationId})),
          'Burnt output stage', 'Bench repair', 'Raw clerk', 'fixture'
        )
      `,
    ).rejects.toMatchObject({ code: '23G03' });
  });

  it("refuses a raised request's terms being edited at all", async () => {
    const id = await raiseAndApprove();
    await expect(
      admin`
        update maintenance_requests set station = 'Somewhere else' where id = ${id}
      `,
    ).rejects.toMatchObject({ code: '23G05' });
  });
});

describe('the append-only walls the route never reaches', () => {
  it('refuses a material line appended to an approved or closed request', async () => {
    // The application role holds INSERT on this table and the freeze only
    // covers UPDATE, so without the insert guard a line appended here is
    // material nobody approved — and on a CLOSED request it is quantity
    // that can never be dispatched, written off or closed again.
    const id = await raiseAndApprove();
    await expect(
      admin`
        insert into maintenance_request_lines (
          organisation_id, maintenance_request_id, description, unit, quantity,
          expected_return_quantity, position
        )
        values (
          ${organisationId}, ${id}, 'Smuggled material', 'Nos', 1, 0, 99
        )
      `,
    ).rejects.toMatchObject({ code: '23G01' });
  });

  it('refuses a stock issue naming a challan that never carried the part', async () => {
    // 0087's guard validates a job card and a purchase order arm by arm
    // and had no arm for the maintenance challan, so a movement could
    // name one with nothing binding the part or the quantity to it.
    const id = await raiseAndApprove();
    const lineId = (await detail(id)).lines[0]?.id ?? '';
    const dispatched = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/dispatches`,
      organisationId,
      payload: {
        stockLocation: 'Central store',
        receiverName: 'Site supervisor',
        lines: [{ lineId, quantity: '1' }],
      },
    });
    expect(dispatched.statusCode, dispatched.body).toBe(200);
    const [challan] = await admin<{ id: string }[]>`
      select id from maintenance_dispatches
      where organisation_id = ${organisationId} and maintenance_request_id = ${id}
    `;

    // A part the challan does not carry. Well stocked on purpose: 0087's
    // own guard runs first (`g` sorts before `m`), so a part short of
    // stock would be refused for the balance and prove nothing about the
    // arm under test.
    await expect(
      admin`
        insert into stock_movements (
          organisation_id, production_item_id, movement_type, quantity,
          movement_date, maintenance_dispatch_id, created_by_user_id
        )
        values (
          ${organisationId}, ${unrelatedPartId}, 'issue', -1,
          (select app_private.organisation_today(${organisationId})),
          ${challan?.id ?? ''}, 'fixture'
        )
      `,
    ).rejects.toMatchObject({ code: '23F02' });

    // …and more of a part it DOES carry than the paper says left: the
    // challan sent one, the shelf holds plenty, and five is still a lie.
    await expect(
      admin`
        insert into stock_movements (
          organisation_id, production_item_id, movement_type, quantity,
          movement_date, maintenance_dispatch_id, created_by_user_id
        )
        values (
          ${organisationId}, ${partId}, 'issue', -5,
          (select app_private.organisation_today(${organisationId})),
          ${challan?.id ?? ''}, 'fixture'
        )
      `,
    ).rejects.toMatchObject({ code: '23F02' });
  });
});

describe('the walls', () => {
  it('keeps approval to the owner and the dispatch to the issue authority', async () => {
    const created = await raise();
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<{ id: string }>();

    const byOffice = await authed(office, {
      method: 'POST',
      url: `/api/maintenance/${id}/approve`,
      organisationId,
      payload: { comment: 'Trying to approve my own request' },
    });
    expect(byOffice.statusCode, byOffice.body).toBe(403);

    const approved = await authed(owner, {
      method: 'POST',
      url: `/api/maintenance/${id}/approve`,
      organisationId,
      payload: { comment: 'Approved against available maintenance stock' },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    // The assigned member is on this Work and may read the request, and
    // holds no issue authority — which is the wall being measured here,
    // rather than work-scope. An owner is not the control: `authz.ts`
    // grants every document authority with the role.
    const withoutAuthority = await authed(assigned, {
      method: 'POST',
      url: `/api/maintenance/${id}/dispatches`,
      organisationId,
      payload: {
        stockLocation: 'Central store',
        receiverName: 'Site supervisor',
        lines: [{ lineId: (await detail(id)).lines[0]?.id ?? '', quantity: '1' }],
      },
    });
    expect(withoutAuthority.statusCode, withoutAuthority.body).toBe(403);
  });

  it('hides a request on a Work the caller is not assigned to', async () => {
    const id = await raiseAndApprove({ work: otherWorkId });
    const list = await authed(assigned, {
      method: 'GET',
      url: '/api/maintenance',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    const body = list.json<MaintenanceListResponse>();
    expect(body.requests.some((entry) => entry.id === id)).toBe(false);
    // Not merely absent from the page: every row this caller can see is
    // on the Work they are assigned to.
    expect(body.requests.every((entry) => entry.workId === workId)).toBe(true);
    // And the stage strip is scoped the same way, or it would leak the
    // size of a register the caller cannot read. Compared against the
    // OWNER's count of the same Work rather than a literal, because the
    // suite's other tests keep raising requests against it.
    const [visible] = await admin<{ n: string }[]>`
      select count(*)::text as n from maintenance_requests
      where organisation_id = ${organisationId} and work_id = ${workId}
    `;
    // Present on the FIRST page, which this is — a cursor page sends
    // null, because the strip describes the register and does not change
    // as the reader scrolls.
    expect(body.counts).not.toBeNull();
    const counts = body.counts ?? {
      awaitingApproval: -1,
      approved: 0,
      partiallyDispatched: 0,
      closed: 0,
    };
    expect(
      counts.awaitingApproval +
        counts.approved +
        counts.partiallyDispatched +
        counts.closed,
    ).toBe(Number(visible?.n ?? '-1'));

    const opened = await authed(assigned, {
      method: 'GET',
      url: `/api/maintenance/${id}`,
      organisationId,
    });
    expect(opened.statusCode, opened.body).toBe(404);
  });

  it('refuses a new request against a Work that has been withdrawn', async () => {
    // Supersession does not change `works.status`, so a read without
    // `deleted_at is null` answers with the withdrawn row and every
    // status check passes it. Both layers are measured: the route's, and
    // the insert guard's with the route bypassed.
    const withdrawnId = await seedWork(`MW-${runId.toUpperCase()}`, organisationId);
    // 0071 withdraws a Work only through a real supersession citing a
    // live approval, which is that module's own several-step flow. This
    // test is about what MAINTENANCE does with the resulting state, so
    // the fixture writes the state directly under replica mode — the
    // same escape `removeOrganisationResidue` uses, scoped to one row.
    await admin.begin(async (tx) => {
      await tx.unsafe(`set local session_replication_role = 'replica'`);
      await tx`update works set deleted_at = now() where id = ${withdrawnId}`;
    });

    const refused = await raise({ work: withdrawnId });
    expect(refused.statusCode, refused.body).toBe(404);

    await expect(
      admin`
        insert into maintenance_requests (
          organisation_id, work_id, request_number, financial_year,
          sequence_number, station, requester_name, priority, fault_summary,
          created_by_user_id
        )
        values (
          ${organisationId}, ${withdrawnId}, ${`MR/26-27/RAW${runId.slice(0, 2)}`},
          '2026-27', 9001, 'Churchgate', 'Amit Patil', 'urgent',
          'Raw insert against a withdrawn Work', 'fixture'
        )
      `,
    ).rejects.toMatchObject({ code: '23G01' });
  });

  it('answers the other organisation with nothing at all', async () => {
    const id = await raiseAndApprove();
    const foreign = await authed(outsider, {
      method: 'GET',
      url: `/api/maintenance/${id}`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreign.statusCode, foreign.body).toBe(404);

    const list = await authed(outsider, {
      method: 'GET',
      url: '/api/maintenance',
      organisationId: outsiderOrganisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<MaintenanceListResponse>().requests).toHaveLength(0);
  });
});
