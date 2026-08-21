import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  Contact,
  DeliveryChallanRegisterEntry,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * The Delivery Challan MODULE (migration 0056).
 *
 * The Delivery Challan is the movement document, and it now covers three
 * cases: LOA supply against a Work, non-LOA installation material riding
 * on the same Work challan, and a standalone despatch with no Work at
 * all.
 *
 * The invariant every one of these tests exists to defend is LEDGER
 * INERTNESS: only a line that names a work_item, on a challan that names
 * a Work, may move the quantity ledger. The proofs are deliberately at
 * the level the invariant lives — raw SQL against the delivery-ceiling
 * guard, not just an HTTP response code — because the guard is what a
 * direct-SQL writer, an importer, or a future handler will meet.
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
const ownerEmail = `dcm-owner-${runId}@integration.test`;
const scopedEmail = `dcm-scoped-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let fakeGotenberg: http.Server;
let organisationId: string;
let ownerUserId: string;
let scopedUserId: string;
let workId: string;
let itemAId: string;
let consigneeContactId: string;
let secondConsigneeContactId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let scoped: CookieJar;

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

const CONSIGNEE = { name: 'Sr. DEE (G) NR', address: 'Delhi Division, New Delhi' };

/** The organisation's own today, which is what every document-date rule
 * is measured against — not the server clock. */
async function organisationToday(): Promise<string> {
  const [row] = await admin<{ today: string }[]>`
    select (now() at time zone o.timezone)::date::text as today
    from organisations o where o.id = ${organisationId}
  `;
  if (!row) throw new Error('organisation missing');
  return row.today;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-dc-module-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the Delivery Challan module tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  fakeGotenberg = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.from(`%PDF-1.4 stub ${runId}`));
    });
  });
  await new Promise<void>((resolve) => {
    fakeGotenberg.listen(0, '127.0.0.1', resolve);
  });
  const gotenbergAddress = fakeGotenberg.address();
  if (gotenbergAddress === null || typeof gotenbergAddress === 'string') {
    throw new Error('stub Gotenberg failed to bind a port');
  }

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-dcm-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
  });

  owner = await signUp(ownerEmail, 'DC Module Owner');
  scoped = await signUp(scopedEmail, 'DC Module Site');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'DC Module Works', slug: `dcm-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: scopedEmail, role: 'office' },
  });
  expect(added.statusCode, added.body).toBe(201);

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" in (${ownerEmail}, ${scopedEmail})
  `;
  ownerUserId = users.find((row) => row.email === ownerEmail)?.id ?? '';
  scopedUserId = users.find((row) => row.email === scopedEmail)?.id ?? '';
  expect(ownerUserId).not.toBe('');
  expect(scopedUserId).not.toBe('');

  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  // The scoped member is an office writer with issue and cancel
  // authority and full drafting rights — everything EXCEPT organisation-
  // wide reach. That is the point: the only thing standing between them
  // and a standalone challan must be the work-scope gate itself, not a
  // role or an authority they happen to lack.
  await admin`
    update organisation_memberships
    set work_scope = 'assigned', can_issue_documents = true,
        can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${scopedUserId}
  `;

  // Fixture Work: one item, 5.000 awarded at 100.00.
  workId = randomUUID();
  const scheduleId = randomUUID();
  itemAId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, letter_percentage,
      letter_percentage_direction, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${`DCMW-${runId.toUpperCase()}`},
      ${`dcm-letter-${runId}`}, '2025-06-01', 'Delivery challan module work',
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
      unit_code, awarded_quantity, effective_rate
    )
    values
      (${itemAId}, ${organisationId}, ${workId}, ${scheduleId}, 'A/1',
       'Signal relay', 'Nos', 5.000, 100.00)
  `;
  // The scoped member is assigned to this Work, so their inability to see
  // a standalone challan cannot be confused with having no reach at all.
  await admin`
    insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
    values (${organisationId}, ${workId}, ${scopedUserId}, ${ownerUserId})
  `;

  for (const designation of [
    `Modern Rail Systems ${runId}`,
    `Sundar Job Works ${runId}`,
  ]) {
    const contact = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation,
        address: 'Plot 4, Industrial Estate, Nashik',
        isClient: true,
      },
    });
    expect(contact.statusCode, contact.body).toBe(201);
    if (consigneeContactId === undefined) {
      consigneeContactId = contact.json<Contact>().id;
    } else {
      secondConsigneeContactId = contact.json<Contact>().id;
    }
  }
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
  if (fakeGotenberg) {
    await new Promise<void>((resolve) => {
      fakeGotenberg.close(() => {
        resolve();
      });
    });
  }
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('manual (non-LOA) lines on a work challan', () => {
  let mixedChallanId: string;

  it('refuses a purchase-order link on a manual line, by name', async () => {
    // A receipt is received against an ORDERED item of the Work. A manual
    // line names no such item, so the link has nothing to fulfil — and
    // the purchase-order balance must never be moved by a line the
    // quantity ledger cannot see.
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'DCM',
        consignee: CONSIGNEE,
        items: [
          {
            description: 'Galvanised pole',
            unit: 'Nos',
            quantity: '2',
            rate: '450.00',
            purchaseOrderLineId: randomUUID(),
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe(
      'PO_LINE_REQUIRES_WORK_ITEM_LINE',
    );
  });

  it('refuses a half-filled manual line, by name', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'DCM',
        consignee: CONSIGNEE,
        items: [{ description: 'Galvanised pole', quantity: '2' }],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('MANUAL_LINE_INCOMPLETE');
  });

  it('drafts and issues a work challan carrying both kinds of line', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'DCM',
        consignee: CONSIGNEE,
        items: [
          // The whole sanctioned quantity, so the ceiling has no room
          // left after this — which is what makes the inertness proof
          // below meaningful.
          { workItemId: itemAId, quantity: '5' },
          {
            description: 'Galvanised pole',
            unit: 'Nos',
            quantity: '2',
            rate: '450.00',
          },
          { description: 'Anchor bolt set', unit: 'Set', quantity: '4', rate: '75.50' },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const detail = created.json<ChallanDetailResponse>();
    mixedChallanId = detail.challan.id;
    expect(detail.challan.kind).toBe('work');
    expect(detail.items).toHaveLength(3);
    // The work item line snapshots the schedule; the manual lines carry
    // their own text and their amounts are exact decimal arithmetic.
    expect(detail.items[0]).toMatchObject({
      workItemId: itemAId,
      description: 'Signal relay',
      lineAmount: '500.00',
    });
    expect(detail.items[1]).toMatchObject({
      workItemId: null,
      description: 'Galvanised pole',
      lineAmount: '900.00',
    });
    expect(detail.items[2]).toMatchObject({ workItemId: null, lineAmount: '302.00' });

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${mixedChallanId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json<ChallanDetailResponse>().challan.challanNumber).toBe('DCM/1');
  });

  it('LEDGER INERTNESS 1: a manual line does not move the delivered sum a later ceiling check sees', async () => {
    // The issued challan above delivered the WHOLE sanctioned quantity
    // (5 of 5) on its work item line, and 6 more units across two manual
    // lines. If manual lines counted, the delivered sum would read 11.
    const [ledger] = await admin<{ delivered: string; every_line: string }[]>`
      select
        coalesce(sum(line.quantity) filter (where line.work_item_id is not null), 0)
          ::text as delivered,
        coalesce(sum(line.quantity), 0)::text as every_line
      from delivery_challan_items line
      join delivery_challans dc on dc.id = line.delivery_challan_id
      where dc.organisation_id = ${organisationId} and dc.status = 'issued'
        and dc.work_id = ${workId}
    `;
    expect(ledger?.delivered).toBe('5.000');
    expect(ledger?.every_line).toBe('11.000');

    // And the ceiling guard agrees. A second challan for ONE more unit of
    // the same item must be refused: 5 are already delivered against a
    // sanctioned 5. If the guard had counted the manual lines it would
    // still refuse — but for the wrong reason, and a guard that refuses
    // for the wrong reason will accept for the wrong reason too. So the
    // number in its own message is what is asserted.
    const second = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'DCM',
        consignee: CONSIGNEE,
        items: [{ workItemId: itemAId, quantity: '1' }],
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json<ChallanDetailResponse>().challan.id;

    // Raw SQL, straight at the 0046 guard: no route, no application
    // check, just the database deciding.
    let message = '';
    try {
      await admin`
        update delivery_challans
        set status = 'issued', challan_number = ${`DCM-RAW-${runId}`},
            sequence_number = 99, issued_snapshot = '{}'::jsonb,
            issued_at = now(), issued_by_user_id = ${ownerUserId}
        where id = ${secondId}
      `;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // '6 against 5.000' — the work item line's 5 plus this challan's 1.
    // Eleven would mean the manual lines had leaked into the aggregate.
    expect(message).toMatch(/delivery ceiling/);
    expect(message).toMatch(/6\.000 against 5\.000/);
    expect(message).not.toMatch(/1[12]\.000/);

    const discarded = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${secondId}`,
      organisationId,
    });
    expect(discarded.statusCode, discarded.body).toBe(204);
  });

  it('refuses serials against a manual line, by name', async () => {
    const [manualLine] = await admin<{ id: string }[]>`
      select id from delivery_challan_items
      where delivery_challan_id = ${mixedChallanId} and work_item_id is null
      order by position
    `;
    expect(manualLine).toBeDefined();
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${mixedChallanId}/serials`,
      organisationId,
      payload: {
        challanItemId: manualLine?.id ?? '',
        serialNumbers: [`POLE-${runId}-1`],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe(
      'SERIALS_REQUIRE_WORK_ITEM_LINE',
    );

    // And the database says the same thing to a direct writer.
    await expect(
      admin`
        insert into challan_item_serials (
          organisation_id, work_id, delivery_challan_id,
          delivery_challan_item_id, serial_number
        )
        values (
          ${organisationId}, ${workId}, ${mixedChallanId},
          ${manualLine?.id ?? ''}, ${`RAW-${runId}`}
        )
      `,
    ).rejects.toThrowError(/serials are recorded against LOA item lines/i);
  });

  it('leaves the work-completion maths and MB sourcing untouched', async () => {
    // Both read the ledger through work_item_id. The item is fully
    // delivered (5 of 5) on its work item line alone, so completion sees
    // no shortfall — and no surplus from the six manual units either.
    const [completion] = await admin<{ delivered: string }[]>`
      select coalesce((
        select sum(dci.quantity)
        from delivery_challan_items dci
        join delivery_challans dc on dc.id = dci.delivery_challan_id
        where dci.work_item_id = ${itemAId} and dc.status = 'issued'
      ), 0)::numeric(18,3)::text as delivered
    `;
    expect(completion?.delivered).toBe('5.000');

    const balance = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/balance`,
      organisationId,
    });
    expect(balance.statusCode, balance.body).toBe(200);
    expect(
      balance.json<{ items: { deliveredQuantity: string }[] }>().items[0],
    ).toMatchObject({ deliveredQuantity: '5.000', remainingQuantity: '0.000' });
  });
});

describe('standalone Delivery Challans', () => {
  let standaloneId: string;

  it('refuses a work item line on a standalone challan, by name', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId,
        items: [{ workItemId: itemAId, quantity: '1' }],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe(
      'STANDALONE_LINE_MUST_BE_MANUAL',
    );
  });

  it('drafts a standalone challan against a contacts-master consignee', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId,
        items: [
          { description: 'Relay casing', unit: 'Nos', quantity: '10', rate: '125.00' },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<ChallanDetailResponse>();
    standaloneId = detail.challan.id;
    expect(detail.challan).toMatchObject({
      kind: 'standalone',
      workId: null,
      consigneeContactId,
      fyLabel: null,
    });
    // Rule 7: the party is SNAPSHOTTED, not re-read. A later edit to the
    // contact must never rewrite an issued document.
    expect(detail.challan.consignee.name).toContain('Modern Rail Systems');
    expect(detail.items[0]).toMatchObject({
      workItemId: null,
      description: 'Relay casing',
      lineAmount: '1250.00',
    });
  });

  it('copies the chosen address onto the challan and keeps the copy when the master moves', async () => {
    // The second address a consignee keeps (migration 0116). The one the
    // contact form gave it is the primary; this is the other one, and
    // choosing it must change WHICH text the challan copies without
    // changing that it copies.
    const second = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${secondConsigneeContactId}/addresses`,
      organisationId,
      payload: { label: 'Site store', address: 'Gate 3, Yard Road, Manmad' },
    });
    expect(second.statusCode, second.body).toBe(201);
    const siteStoreId = second.json<{ id: string }>().id;

    const draft = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId: secondConsigneeContactId,
        consigneeAddressId: siteStoreId,
        items: [{ description: 'Clamp', unit: 'Nos', quantity: '2', rate: '40.00' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const drafted = draft.json<ChallanDetailResponse>();
    expect(drafted.challan.consignee.address).toBe('Gate 3, Yard Road, Manmad');

    // Rule 7, through the new control: edit the address in the master and
    // retire it, and the draft still says what it copied.
    const edited = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${secondConsigneeContactId}/addresses/${siteStoreId}`,
      organisationId,
      payload: { label: 'Site store', address: 'Gate 9, Yard Road, Manmad' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${secondConsigneeContactId}/addresses/${siteStoreId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);

    const reread = await authed(owner, {
      method: 'GET',
      url: `/api/challans/${drafted.challan.id}`,
      organisationId,
    });
    expect(reread.statusCode, reread.body).toBe(200);
    expect(reread.json<ChallanDetailResponse>().challan.consignee.address).toBe(
      'Gate 3, Yard Road, Manmad',
    );

    // A retired address is refused for a NEW challan, which is the other
    // half of the same rule: history keeps it, the picker does not.
    const afterRetire = await authed(owner, {
      method: 'PUT',
      url: `/api/delivery-challans/${drafted.challan.id}`,
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId: secondConsigneeContactId,
        consigneeAddressId: siteStoreId,
        items: [{ description: 'Clamp', unit: 'Nos', quantity: '2', rate: '40.00' }],
      },
    });
    expect(afterRetire.statusCode, afterRetire.body).toBe(409);
    expect(afterRetire.json<{ code: string }>().code).toBe('CONTACT_ADDRESS_RETIRED');

    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${drafted.challan.id}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);
  });

  it('keeps the chosen address across a PUT that does not resend it', async () => {
    const added = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${secondConsigneeContactId}/addresses`,
      organisationId,
      payload: { label: 'Depot store', address: 'Depot Lane, Manmad' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const depotId = added.json<{ id: string }>().id;

    const draft = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId: secondConsigneeContactId,
        consigneeAddressId: depotId,
        items: [{ description: 'Clamp', unit: 'Nos', quantity: '2', rate: '40.00' }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const drafted = draft.json<ChallanDetailResponse>();
    // The choice is on the snapshot as provenance, so a client CAN
    // round-trip it.
    expect(drafted.challan.consignee).toMatchObject({
      address: 'Depot Lane, Manmad',
      addressId: depotId,
    });

    // A PUT that omits the id — every caller predating the address list —
    // keeps the stored choice rather than silently reverting the paper to
    // the primary address.
    const edited = await authed(owner, {
      method: 'PUT',
      url: `/api/delivery-challans/${drafted.challan.id}`,
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId: secondConsigneeContactId,
        items: [{ description: 'Clamp', unit: 'Nos', quantity: '3', rate: '40.00' }],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<ChallanDetailResponse>().challan.consignee).toMatchObject({
      address: 'Depot Lane, Manmad',
      addressId: depotId,
    });

    const removed = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${drafted.challan.id}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(204);
  });

  it('allows one open draft per consignee, and another consignee its own', async () => {
    const repeat = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId,
        items: [{ description: 'Spare', unit: 'Nos', quantity: '1', rate: '10.00' }],
      },
    });
    expect(repeat.statusCode, repeat.body).toBe(409);
    expect(
      repeat.json<{ code: string; details?: { existingRecordId?: string } }>(),
    ).toMatchObject({
      code: 'DRAFT_EXISTS',
      details: { existingRecordId: standaloneId },
    });

    const other = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId: secondConsigneeContactId,
        items: [{ description: 'Jig', unit: 'Nos', quantity: '1', rate: '10.00' }],
      },
    });
    expect(other.statusCode, other.body).toBe(201);
    const otherId = other.json<ChallanDetailResponse>().challan.id;
    const discarded = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${otherId}`,
      organisationId,
    });
    expect(discarded.statusCode, discarded.body).toBe(204);
  });

  it('leaves the per-Work one-open-draft rule exactly as it was', async () => {
    // The 0001 index is on (organisation_id, work_id) WHERE draft, and a
    // standalone row's NULL work_id self-excludes from it. A Work with a
    // live standalone draft in the organisation must still accept its own
    // first draft.
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/challans`,
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'DCM',
        consignee: CONSIGNEE,
        items: [
          { description: 'Cable tie', unit: 'Pkt', quantity: '3', rate: '20.00' },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const draftId = response.json<ChallanDetailResponse>().challan.id;
    const discarded = await authed(owner, {
      method: 'DELETE',
      url: `/api/challans/${draftId}`,
      organisationId,
    });
    expect(discarded.statusCode, discarded.body).toBe(204);
  });

  it('issues with a gap-free number scoped to the financial year', async () => {
    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${standaloneId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const detail = issued.json<ChallanDetailResponse>();
    const today = await organisationToday();
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const startYear = month >= 4 ? year : year - 1;
    const fyLabel = `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;
    expect(detail.challan.fyLabel).toBe(fyLabel);
    expect(detail.challan.challanNumber).toBe(`DC/${fyLabel}/001`);
    expect(detail.challan.sequenceNumber).toBe(1);

    // The counter is real, per financial year, and forward-only.
    const [counter] = await admin<{ next_value: number }[]>`
      select next_value from standalone_challan_counters
      where organisation_id = ${organisationId} and fy_label = ${fyLabel}
    `;
    expect(counter?.next_value).toBe(1);
    await expect(
      admin`
        update standalone_challan_counters set next_value = 0
        where organisation_id = ${organisationId} and fy_label = ${fyLabel}
      `,
    ).rejects.toThrowError(/standalone challan counters must not decrease/);
  });

  it('LEDGER INERTNESS 2: issuing a standalone challan never enters the ceiling path', async () => {
    // The fixture Work has ZERO remaining quantity — its whole sanctioned
    // 5.000 is delivered. If a standalone challan touched the ceiling
    // path at all, the guard would have to consult a Work it has not got,
    // and either refuse or read someone else's ceiling. It does neither:
    // it is issued, and the Work's delivered figure is unchanged by it.
    const before = await admin<{ delivered: string }[]>`
      select coalesce(sum(dci.quantity), 0)::text as delivered
      from delivery_challan_items dci
      join delivery_challans dc on dc.id = dci.delivery_challan_id
      where dci.work_item_id = ${itemAId} and dc.status = 'issued'
    `;
    expect(before[0]?.delivered).toBe('5.000');

    const draft = await authed(owner, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId,
        items: [
          // Deliberately the same shape and size as the sanctioned item:
          // a guard that leaked would have every excuse to trip here.
          { description: 'Signal relay', unit: 'Nos', quantity: '5', rate: '100.00' },
        ],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = draft.json<ChallanDetailResponse>().challan.id;

    const issued = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${draftId}/issue`,
      organisationId,
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json<ChallanDetailResponse>().challan.sequenceNumber).toBe(2);

    const after = await admin<{ delivered: string }[]>`
      select coalesce(sum(dci.quantity), 0)::text as delivered
      from delivery_challan_items dci
      join delivery_challans dc on dc.id = dci.delivery_challan_id
      where dci.work_item_id = ${itemAId} and dc.status = 'issued'
    `;
    expect(after[0]?.delivered).toBe('5.000');
  });

  it('renders and serves the PDF a standalone consignee signs for', async () => {
    // The document is the whole point of the module: an operator who
    // cannot print it has a record, not a challan.
    const rendered = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${standaloneId}/render`,
      organisationId,
    });
    expect(rendered.statusCode, rendered.body).toBe(200);
    expect(rendered.json<ChallanDetailResponse>().challan.renderedAvailable).toBe(true);

    const pdf = await authed(owner, {
      method: 'GET',
      url: `/api/challans/${standaloneId}/pdf`,
      organisationId,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('refuses a Work-only operation on a standalone challan, by name', async () => {
    const receipt = await authed(owner, {
      method: 'POST',
      url: `/api/challans/${standaloneId}/receipt`,
      organisationId,
      payload: { receivedOn: await organisationToday(), receivedBy: 'Store keeper' },
    });
    expect(receipt.statusCode, receipt.body).toBe(400);
    expect(receipt.json<{ code: string }>().code).toBe('CHALLAN_NOT_WORK_BOUND');
  });
});

describe('the database holds the module’s shape against direct SQL', () => {
  it('refuses a work item line on a standalone challan', async () => {
    const [standalone] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where organisation_id = ${organisationId} and challan_kind = 'standalone'
      order by created_at limit 1
    `;
    await expect(
      admin`
        insert into delivery_challan_items (
          organisation_id, delivery_challan_id, work_id, work_item_id,
          description_snapshot, unit_snapshot, quantity, rate_snapshot,
          line_amount, position
        )
        values (
          ${organisationId}, ${standalone?.id ?? ''}, ${workId}, ${itemAId},
          'Signal relay', 'Nos', 1.000, 100.00, 100.00, 99
        )
      `,
    ).rejects.toThrowError(/standalone Delivery Challan carries no work item lines/);
  });

  it('refuses a challan that is standalone but names a Work, and the reverse', async () => {
    await expect(
      admin`
        insert into delivery_challans (
          organisation_id, work_id, challan_kind, consignee_contact_id,
          challan_date, prefix, consignee_snapshot, created_by_user_id
        )
        values (
          ${organisationId}, ${workId}, 'standalone', ${consigneeContactId},
          current_date, 'BAD', '{}'::jsonb, ${ownerUserId}
        )
      `,
    ).rejects.toThrowError(/delivery_challans_kind_shape/);
    await expect(
      admin`
        insert into delivery_challans (
          organisation_id, work_id, challan_kind, challan_date, prefix,
          consignee_snapshot, created_by_user_id
        )
        values (
          ${organisationId}, null, 'work', current_date, 'BAD',
          '{}'::jsonb, ${ownerUserId}
        )
      `,
    ).rejects.toThrowError(/delivery_challans_kind_shape/);
  });

  it('keeps a challan’s kind fixed once it exists', async () => {
    const [standalone] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where organisation_id = ${organisationId} and challan_kind = 'standalone'
      order by created_at limit 1
    `;
    await expect(
      admin`
        update delivery_challans set challan_kind = 'work'
        where id = ${standalone?.id ?? ''}
      `,
    ).rejects.toThrowError(/kind is fixed when it is created/);
  });

  it('lets a challan carry more than one manual line', async () => {
    // The 0001 UNIQUE (organisation, challan, work_item_id) became a
    // PARTIAL index: two manual lines both read NULL there, and the
    // constraint had no meaning left to enforce over them.
    const [count] = await admin<{ manual: string }[]>`
      select count(*)::text as manual from delivery_challan_items
      where organisation_id = ${organisationId} and work_item_id is null
        and delivery_challan_id in (
          select id from delivery_challans
          where organisation_id = ${organisationId} and challan_kind = 'work'
        )
    `;
    expect(Number(count?.manual ?? '0')).toBeGreaterThanOrEqual(2);
  });

  it('binds the standalone challan to the number-series scope rule (finding 8)', async () => {
    // 0047's CHECK ends in ELSE true. Without an explicit arm, a
    // standalone_challan row would be exempted from the scope rule and
    // the series could wedge at the financial-year boundary with a
    // finished document in hand.
    await expect(
      admin`
        insert into document_number_series (organisation_id, document_type, template)
        values (${organisationId}, 'standalone_challan', 'DC/{SEQ:3}')
      `,
    ).rejects.toThrowError(/document_number_series_scope/);
    await admin`
      insert into document_number_series (organisation_id, document_type, template)
      values (${organisationId}, 'standalone_challan', 'DC/{FY2}/{SEQ:3}')
    `;
    await admin`
      delete from document_number_series
      where organisation_id = ${organisationId} and document_type = 'standalone_challan'
    `;
  });
});

describe('the register and its permission gate', () => {
  it('shows every movement, naming which of the three it is', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/delivery-challans',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json<{ challans: DeliveryChallanRegisterEntry[] }>().challans;
    const movements = new Set(rows.map((row) => row.movement));
    expect(movements).toEqual(new Set(['work_material', 'standalone']));

    const mixed = rows.find((row) => row.movement === 'work_material');
    expect(mixed).toMatchObject({ kind: 'work', lineCount: 3, manualLineCount: 2 });
    expect(mixed?.workCode).toContain('DCMW-');
    // 500.00 + 900.00 + 302.00, summed in SQL numeric.
    expect(mixed?.totalAmount).toBe('1702.00');

    const standalone = rows.find((row) => row.movement === 'standalone');
    expect(standalone).toMatchObject({
      kind: 'standalone',
      workId: null,
      workCode: null,
      manualLineCount: 1,
    });
    expect(standalone?.consigneeName).toContain('Modern Rail Systems');
  });

  /**
   * `?work=` is the module's deep link, and it narrows the REGISTER, not
   * the page. Filtering client-side over the loaded page — which is what
   * the screen did before this parameter existed — showed a Work only as
   * many of its movements as happened to land on that page.
   */
  it('narrows to one Work, inside the work-scope predicate rather than beside it', async () => {
    const narrowed = await authed(owner, {
      method: 'GET',
      url: `/api/delivery-challans?work=${workId}`,
      organisationId,
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const rows = narrowed.json<{ challans: DeliveryChallanRegisterEntry[] }>().challans;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workId === workId)).toBe(true);
    // The standalone challans the unnarrowed register carries are gone —
    // they belong to no Work, so no Work names them.
    expect(rows.some((row) => row.movement === 'standalone')).toBe(false);

    // It narrows the register itself, so the page it answers with is a
    // page OF that Work rather than the register's page filtered after
    // the fact. With limit=1 the cursor still walks this Work only.
    const firstPage = await authed(owner, {
      method: 'GET',
      url: `/api/delivery-challans?work=${workId}&limit=1`,
      organisationId,
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    const page = firstPage.json<{
      challans: DeliveryChallanRegisterEntry[];
      nextCursor: string | null;
    }>();
    expect(page.challans).toHaveLength(1);
    expect(page.challans[0]?.workId).toBe(workId);

    // A Work of another organisation matches nothing rather than
    // refusing: the work-scope predicate above still decides what exists,
    // so a guessed id cannot be used to confirm one.
    const foreign = await authed(owner, {
      method: 'GET',
      url: `/api/delivery-challans?work=${randomUUID()}`,
      organisationId,
    });
    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json<{ challans: unknown[] }>().challans).toEqual([]);

    // And a value that is not a uuid is a schema refusal, not a query.
    const malformed = await authed(owner, {
      method: 'GET',
      url: '/api/delivery-challans?work=not-a-uuid',
      organisationId,
    });
    expect(malformed.statusCode, malformed.body).toBe(400);
  });

  it('hides standalone challans from a member without organisation-wide reach', async () => {
    // The scoped member is an office writer WITH issue and cancel
    // authority, assigned to the fixture Work — so they see its challans.
    // A standalone challan has no Work for work-scope to bind to, and no
    // assignment could ever grant it, so they must not see it at all.
    const response = await authed(scoped, {
      method: 'GET',
      url: '/api/delivery-challans',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json<{ challans: DeliveryChallanRegisterEntry[] }>().challans;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.kind === 'work')).toBe(true);
    expect(rows.some((row) => row.movement === 'standalone')).toBe(false);
  });

  /**
   * The register's cursor is part of the same scope boundary as its rows.
   *
   * A cursor proven only against the organisation would answer 200 for a
   * standalone challan's id and 400 for a nonexistent one, disclosing the
   * document's existence — and the keyset comparison would then run
   * against that challan's (challan_date, created_at, id), so a caller
   * paging with chosen cursors could recover its date and creation instant
   * without ever being sent a row of it.
   */
  it('refuses a cursor naming a challan out of scope, exactly as a nonexistent one', async () => {
    const [standalone] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where organisation_id = ${organisationId} and challan_kind = 'standalone'
      order by created_at limit 1
    `;
    const standaloneId = standalone?.id ?? '';

    const forbidden = await authed(scoped, {
      method: 'GET',
      url: `/api/delivery-challans?limit=1&cursor=${standaloneId}`,
      organisationId,
    });
    expect(forbidden.statusCode, forbidden.body).toBe(400);
    expect(forbidden.json<{ code: string }>().code).toBe('CURSOR_INVALID');

    const absent = await authed(scoped, {
      method: 'GET',
      url: `/api/delivery-challans?limit=1&cursor=${randomUUID()}`,
      organisationId,
    });
    expect(absent.statusCode, absent.body).toBe(400);
    expect(absent.json<{ message: string }>().message).toBe(
      forbidden.json<{ message: string }>().message,
    );

    // Positive control on the SAME id: the owner reaches every challan, so
    // for them the cursor is a position rather than a refusal.
    const allowed = await authed(owner, {
      method: 'GET',
      url: `/api/delivery-challans?limit=1&cursor=${standaloneId}`,
      organisationId,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    // And the scoped member still pages their own Work's challans.
    const firstPage = await authed(scoped, {
      method: 'GET',
      url: '/api/delivery-challans?limit=1',
      organisationId,
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    const first = firstPage.json<{ challans: DeliveryChallanRegisterEntry[] }>()
      .challans[0];
    if (!first) throw new Error('scoped register unexpectedly empty');
    const onward = await authed(scoped, {
      method: 'GET',
      url: `/api/delivery-challans?limit=1&cursor=${first.id}`,
      organisationId,
    });
    expect(onward.statusCode, onward.body).toBe(200);
  });

  it('answers a standalone challan they guessed the id of as unknown', async () => {
    const [standalone] = await admin<{ id: string }[]>`
      select id from delivery_challans
      where organisation_id = ${organisationId} and challan_kind = 'standalone'
      order by created_at limit 1
    `;
    // 404, not 403: a guessed id must not confirm the document exists.
    const read = await authed(scoped, {
      method: 'GET',
      url: `/api/challans/${standalone?.id ?? ''}`,
      organisationId,
    });
    expect(read.statusCode, read.body).toBe(404);
    expect(read.json<{ code: string }>().code).toBe('CHALLAN_NOT_FOUND');

    const created = await authed(scoped, {
      method: 'POST',
      url: '/api/delivery-challans',
      organisationId,
      payload: {
        challanDate: await organisationToday(),
        prefix: 'SDC',
        consigneeContactId,
        items: [{ description: 'Spare', unit: 'Nos', quantity: '1', rate: '10.00' }],
      },
    });
    expect(created.statusCode, created.body).toBe(404);
  });
});
