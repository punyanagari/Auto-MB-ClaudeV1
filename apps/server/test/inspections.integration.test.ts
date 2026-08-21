import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  Contact,
  InspectionCall,
  InspectionCallListResponse,
  WorkInspectionConfig,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  removeOrganisationResidue,
} from '@auto-mb/db/testing';
import { assertSafeObjectKey } from '@auto-mb/documents';
import { buildApp } from '../src/app.js';

/**
 * The railway inspection lifecycle (migration 0082).
 *
 * What is proved here, in the order the module's own risks run:
 *
 *   1. the clause mapping — who inspects what, and the one combination
 *      the schema refuses outright (a consignee item that gates
 *      despatch, which could never be despatched at all);
 *   2. the lifecycle — requested → scheduled → closed, the transitions
 *      that are refused, and the close gate's three conditions;
 *   3. THE DISPATCH INTERLOCK, which is the reason the pack exists:
 *      blocked with the gate on and no certificate, allowed once the
 *      certificate is live, allowed with the gate off, and blocked again
 *      the moment the certificate's call is withdrawn;
 *   4. the walls — role, work scope, and RLS for the other organisation.
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
const ownerEmail = `insp-owner-${runId}@integration.test`;
const officeEmail = `insp-office-${runId}@integration.test`;
const scopedEmail = `insp-scoped-${runId}@integration.test`;
const outsiderEmail = `insp-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** A minimal but real PDF: the upload guard reads the signature, never
 * the declared content type. The counter keeps every digest distinct. */
let pdfCounter = 0;
function pdfBytes(): Buffer {
  pdfCounter += 1;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Seq ${String(pdfCounter)} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );
}

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let workId: string;
let otherWorkId: string;
let gatedItemId: string;
let freeItemId: string;
let outsiderCallId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
/** An `assigned`-scope membership with no assignment to `workId`: the
 * work-scope wall's own subject. */
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

function query(details: Record<string, string>): string {
  return new URLSearchParams(details).toString();
}

/** A Work with two schedule items, seeded as admin SQL the way the other
 * integration fixtures do it: the subject under test is the inspection
 * module and the challan gate, not LOA intake. */
async function seedWork(code: string, organisation: string, userId: string) {
  const id = randomUUID();
  const scheduleId = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id,
      pbg_required_amount, pbg_submission_days, pbg_requirement_source
    )
    values (
      ${id}, ${organisation}, ${code}, ${`L-${code}`}, '2026-01-05',
      ${`Inspection fixture ${code}`}, '10000000.00', '9000000.00',
      'per_schedule', ${userId}, '450000.00', 30, '{"provenance": "fixture"}'::jsonb
    )
  `;
  await admin`
    insert into work_schedules (
      id, organisation_id, work_id, schedule_code, title, position
    )
    values (${scheduleId}, ${organisation}, ${id}, 'A', 'Schedule A', 1)
  `;
  await admin`
    insert into work_items (
      id, organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate, payment_category
    )
    select item.id, ${organisation}, ${id}, ${scheduleId}, item.number,
           'Inspection fixture item ' || item.number, 'nos', '100.000',
           '250.500000', 'SUPPLY_AND_INSTALLATION'
    from unnest(
      ${[first, second]}::uuid[],
      ${['A-0001', 'A-0002']}::text[]
    ) as item(id, number)
  `;
  return { id, first, second };
}

/** A draft delivery challan carrying one line for `itemId`, ready for the
 * real issue route. Seeded rather than drafted through the API because
 * the gate under test fires at ISSUE, and a draft is only its
 * precondition. */
async function seedDraftChallan(itemId: string, userId: string): Promise<string> {
  const challanId = randomUUID();
  await admin`
    insert into delivery_challans (
      id, organisation_id, work_id, challan_date, prefix, status,
      consignee_snapshot, created_by_user_id
    )
    values (
      ${challanId}, ${organisationId}, ${workId}, '2026-02-10', 'DC', 'draft',
      '{"name": "SSE/Signal", "address": "Depot Road"}'::jsonb, ${userId}
    )
  `;
  await admin`
    insert into delivery_challan_items (
      organisation_id, delivery_challan_id, work_id, work_item_id,
      description_snapshot, unit_snapshot, quantity, rate_snapshot,
      line_amount, position
    )
    values (
      ${organisationId}, ${challanId}, ${workId}, ${itemId},
      ${`Inspection fixture item ${itemId === gatedItemId ? 'A-0001' : 'A-0002'}`},
      'nos', '3.000', '250.500000', '751.50', 1
    )
  `;
  // The issue path refuses a draft whose snapshots have drifted from the
  // live item, so they are written from the item itself rather than
  // guessed.
  await admin`
    update delivery_challan_items dci
    set description_snapshot = coalesce(wi.effective_description, wi.description),
        unit_snapshot = coalesce(wi.effective_unit, wi.unit_code),
        rate_snapshot = coalesce(wi.effective_unit_rate, wi.effective_rate)
    from work_items wi
    where wi.id = dci.work_item_id and dci.delivery_challan_id = ${challanId}
  `;
  return challanId;
}

async function issueChallan(challanId: string) {
  return authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
}

/** Withdraws every closed call of this organisation through the real
 * route. Cancelling a closed call IS the certificate-withdrawal path, so
 * the reset the suite needs and the behaviour under test are the same
 * act — there is no back door here that the product does not have. */
async function withdrawEveryCertificate(): Promise<void> {
  const closed = await admin<{ id: string }[]>`
    select id from inspection_calls
    where organisation_id = ${organisationId} and status = 'closed'
  `;
  for (const call of closed) {
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/inspection-calls/${call.id}/cancel`,
      organisationId,
      payload: { reason: 'Certificate withdrawn by the agency' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
  }
}

async function discardChallan(challanId: string): Promise<void> {
  await admin`delete from delivery_challan_items where delivery_challan_id = ${challanId}`;
  await admin`delete from delivery_challans where id = ${challanId}`;
}

async function saveClauses(
  jar: CookieJar,
  clauses: WorkInspectionConfig['items'] extends readonly (infer _)[]
    ? readonly {
        workItemId: string;
        agency: 'RDSO' | 'RITES' | 'consignee' | null;
        inspectionQuantity: string | null;
        /** The structured premises (0116). Optional here as it is on the
         * wire, so the cases written before it still read as they did. */
        vendorContactId?: string | null;
        vendorAddressId?: string | null;
        vendorPremises: string | null;
        gatesDispatch: boolean;
      }[]
    : never,
  work = workId,
) {
  return authed(jar, {
    method: 'PUT',
    url: `/api/works/${work}/inspection-clauses`,
    organisationId,
    payload: { clauses },
  });
}

/** The gate on, the free item untouched. Re-applied by the tests that
 * need to put it back after turning it off. */
async function gateTheItem(gatesDispatch = true) {
  const response = await saveClauses(owner, [
    {
      workItemId: gatedItemId,
      agency: 'RDSO',
      inspectionQuantity: '100.000',
      vendorPremises: 'RailTech Components',
      gatesDispatch,
    },
  ]);
  expect(response.statusCode, response.body).toBe(200);
}

async function raiseCall(items: readonly string[] = [gatedItemId]) {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/inspection-calls`,
    organisationId,
    payload: {
      agency: 'RDSO',
      requestedOn: '2026-02-01',
      vendorPremises: 'RailTech Components',
      items: items.map((workItemId) => ({ workItemId, quantity: '10.000' })),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<InspectionCall>();
}

async function receiveLetter(callId: string, number: string) {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/inspection-calls/${callId}/call-letter?${query({
      filename: 'call-letter.pdf',
      agencyCallNumber: number,
      receivedOn: '2026-02-04',
    })}`,
    organisationId,
    headers: { 'content-type': 'application/pdf' },
    payload: pdfBytes(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<InspectionCall>();
}

async function uploadCertificate(callId: string, number: string, validUntil?: string) {
  return authed(owner, {
    method: 'POST',
    url: `/api/inspection-calls/${callId}/certificate?${query({
      filename: 'certificate.pdf',
      certificateNumber: number,
      certificateDate: '2026-02-06',
      ...(validUntil === undefined ? {} : { validUntil }),
    })}`,
    organisationId,
    headers: { 'content-type': 'application/pdf' },
    payload: pdfBytes(),
  });
}

/** Raises a call, walks it to closed, and answers its id. Every mandatory
 * checklist paper is uploaded on the way, because the close gate counts
 * them. */
async function certifyItem(
  items: readonly string[] = [gatedItemId],
  validUntil?: string,
): Promise<InspectionCall> {
  const call = await raiseCall(items);
  await receiveLetter(call.id, `RDSO/CALL/${call.callReference}`);
  const withLetter = await authed(owner, {
    method: 'GET',
    url: `/api/inspection-calls/${call.id}`,
    organisationId,
  });
  const loaded = withLetter.json<InspectionCall>();
  for (const document of loaded.documents) {
    if (document.kind !== 'evidence' || !document.mandatory) continue;
    const attached = await authed(owner, {
      method: 'POST',
      url: `/api/inspection-call-documents/${document.id}/file?${query({
        filename: 'evidence.pdf',
      })}`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: pdfBytes(),
    });
    expect(attached.statusCode, attached.body).toBe(200);
  }
  const certificate = await uploadCertificate(
    call.id,
    `IC/${call.callReference}`,
    validUntil,
  );
  expect(certificate.statusCode, certificate.body).toBe(200);
  const closed = await authed(owner, {
    method: 'POST',
    url: `/api/inspection-calls/${call.id}/close`,
    organisationId,
  });
  expect(closed.statusCode, closed.body).toBe(200);
  return closed.json<InspectionCall>();
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-inspections-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-insp-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Inspection Owner');
  office = await signUp(officeEmail, 'Inspection Office');
  scoped = await signUp(scopedEmail, 'Inspection Scoped');
  outsider = await signUp(outsiderEmail, 'Inspection Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Inspection Constructions', slug: `insp-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Inspection Outsiders', slug: `insp-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
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
  // The scoped member sees only Works it is assigned to, and it is
  // assigned to none. `assertWorkAccess` answers 404 rather than 403, so
  // a guessed id cannot confirm the Work exists.
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${scopedEmail})
  `;

  const [ownerRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  const [outsiderRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${outsiderEmail}
  `;
  if (!ownerRow || !outsiderRow) throw new Error('seeded users missing');

  const work = await seedWork(
    `INSP-${runId.toUpperCase()}`,
    organisationId,
    ownerRow.id,
  );
  workId = work.id;
  gatedItemId = work.first;
  freeItemId = work.second;

  const other = await seedWork(
    `OTHR-${runId.toUpperCase()}`,
    outsiderOrganisationId,
    outsiderRow.id,
  );
  otherWorkId = other.id;
  // A call belonging to the OTHER organisation, so the RLS assertions
  // have a real row to fail to reach rather than a made-up uuid.
  outsiderCallId = randomUUID();
  await admin`
    insert into inspection_calls (
      id, organisation_id, work_id, sequence_number, agency, requested_on,
      created_by_user_id
    )
    values (
      ${outsiderCallId}, ${outsiderOrganisationId}, ${otherWorkId}, 1, 'RDSO',
      '2026-02-01', ${outsiderRow.id}
    )
  `;
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
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('the inspection clause mapping', () => {
  it('maps an item to an agency and refuses a gated consignee item', async () => {
    const mapped = await saveClauses(owner, [
      {
        workItemId: gatedItemId,
        agency: 'RDSO',
        inspectionQuantity: '100.000',
        vendorPremises: 'RailTech Components',
        gatesDispatch: true,
      },
    ]);
    expect(mapped.statusCode, mapped.body).toBe(200);
    const config = mapped.json<WorkInspectionConfig>();
    const gated = config.items.find((item) => item.workItemId === gatedItemId);
    expect(gated?.agency).toBe('RDSO');
    expect(gated?.gatesDispatch).toBe(true);
    // The item nobody mapped is still listed, with no clause: the screen
    // is a table of ITEMS, and an unmapped row is the one to fill in.
    const free = config.items.find((item) => item.workItemId === freeItemId);
    expect(free?.agency).toBeNull();
    expect(free?.gatesDispatch).toBe(false);

    // A consignee inspects after arrival, so a certificate for it could
    // never exist before despatch. Refusing the combination is what stops
    // an item being configured into a state nothing can clear.
    const deadlock = await saveClauses(owner, [
      {
        workItemId: freeItemId,
        agency: 'consignee',
        inspectionQuantity: null,
        vendorPremises: null,
        gatesDispatch: true,
      },
    ]);
    expect(deadlock.statusCode, deadlock.body).toBe(400);
    expect(deadlock.json<{ code: string }>().code).toBe('INSPECTION_CLAUSE_INVALID');

    await gateTheItem();
  });

  it('lets only an owner move the dispatch gate', async () => {
    // Office may map: which agency inspects which item is clerical work.
    const mapping = await saveClauses(office, [
      {
        workItemId: gatedItemId,
        agency: 'RDSO',
        inspectionQuantity: '90.000',
        vendorPremises: 'RailTech Components',
        gatesDispatch: true,
      },
    ]);
    expect(mapping.statusCode, mapping.body).toBe(200);

    // Office may NOT change what despatch is allowed to ignore. Same
    // footing as `works.allow_excess_delivery`, and the same refusal.
    const gate = await saveClauses(office, [
      {
        workItemId: gatedItemId,
        agency: 'RDSO',
        inspectionQuantity: '90.000',
        vendorPremises: 'RailTech Components',
        gatesDispatch: false,
      },
    ]);
    expect(gate.statusCode, gate.body).toBe(403);
    expect(gate.json<{ code: string }>().code).toBe('OWNER_REQUIRED');

    await gateTheItem();
  });
});

describe('the call lifecycle', () => {
  it('walks requested -> scheduled -> closed and refuses the moves that skip', async () => {
    const checklist = await authed(owner, {
      method: 'PUT',
      url: `/api/works/${workId}/inspection-checklist`,
      organisationId,
      payload: {
        agency: 'RDSO',
        scope: 'work',
        fields: [
          { label: 'Routine Test Report', mandatory: true },
          { label: 'Datasheet', mandatory: false },
        ],
      },
    });
    expect(checklist.statusCode, checklist.body).toBe(200);

    const call = await raiseCall();
    expect(call.status).toBe('requested');
    expect(call.callReference).toMatch(/^INS\/INSP-[0-9A-F]+\/\d{3}$/i);
    // The checklist SNAPSHOT: copied at creation, so editing the template
    // afterwards cannot move the goalposts on a call in progress.
    expect(call.documents.map((document) => document.label).sort()).toEqual([
      'Datasheet',
      'Routine Test Report',
    ]);

    // The certificate answers an inspection that was actually called, so
    // it cannot arrive before the inward letter.
    const early = await uploadCertificate(call.id, 'IC/EARLY');
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json<{ code: string }>().code).toBe('INSPECTION_CALL_STATE_INVALID');

    const scheduledCall = await receiveLetter(call.id, 'RDSO/CALL/8821');
    expect(scheduledCall.status).toBe('scheduled');
    expect(scheduledCall.agencyCallNumber).toBe('RDSO/CALL/8821');
    // The inward letter is filed as a document of the call, under a key
    // the storage layer's traversal guard accepts.
    const letter = scheduledCall.documents.find(
      (document) => document.kind === 'call_letter',
    );
    expect(letter?.originalFilename).toBe('call-letter.pdf');
    const [stored] = await admin<{ object_key: string }[]>`
      select object_key from inspection_call_documents where id = ${letter?.id ?? ''}
    `;
    expect(stored?.object_key.startsWith(`${organisationId}/inspection/`)).toBe(true);
    expect(() => {
      assertSafeObjectKey(stored?.object_key ?? '');
    }).not.toThrow();

    // The close gate names what is missing rather than only refusing.
    const tooEarly = await authed(owner, {
      method: 'POST',
      url: `/api/inspection-calls/${call.id}/close`,
      organisationId,
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(409);
    expect(tooEarly.json<{ code: string }>().code).toBe('INSPECTION_CALL_INCOMPLETE');
    expect(tooEarly.json<{ message: string }>().message).toContain(
      'Routine Test Report',
    );
    // The optional paper is NOT named: the gate counts obligations, not
    // uploads.
    expect(tooEarly.json<{ message: string }>().message).not.toContain('Datasheet');
    expect(tooEarly.json<{ remedy?: string }>().remedy).toBeDefined();

    const closed = await certifyItem();
    expect(closed.status).toBe('closed');
    expect(closed.certificateLive).toBe(true);

    // A closed call is a finished record: its certificate cannot be
    // swapped after a challan rested on it.
    const swap = await uploadCertificate(closed.id, 'IC/REPLACEMENT');
    expect(swap.statusCode, swap.body).toBe(409);

    // Withdrawal, though, IS available: an agency does revoke a
    // certificate, and the gate has to hear about it.
    const withdrawn = await authed(owner, {
      method: 'POST',
      url: `/api/inspection-calls/${closed.id}/cancel`,
      organisationId,
      payload: { reason: 'Certificate withdrawn by RDSO' },
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const after = withdrawn.json<InspectionCall>();
    expect(after.status).toBe('cancelled');
    expect(after.certificateLive).toBe(false);
    expect(after.cancellationReason).toBe('Certificate withdrawn by RDSO');
  });

  it('refuses an item the clause has not mapped to the agency being called', async () => {
    const wrong = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/inspection-calls`,
      organisationId,
      payload: {
        agency: 'RITES',
        requestedOn: '2026-02-01',
        vendorPremises: null,
        items: [{ workItemId: gatedItemId, quantity: '5.000' }],
      },
    });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json<{ code: string }>().code).toBe('INSPECTION_CLAUSE_INVALID');
  });
});

describe('the dispatch interlock', () => {
  it('refuses to issue a challan for a gated item with no live certificate', async () => {
    await gateTheItem();
    // Everything already certified in this suite is withdrawn first, so
    // the assertion is about the gate and not about test order.
    await withdrawEveryCertificate();

    const challanId = await seedDraftChallan(gatedItemId, 'test');
    const refused = await issueChallan(challanId);
    expect(refused.statusCode, refused.body).toBe(409);
    const body = refused.json<{ code: string; message: string; remedy?: string }>();
    expect(body.code).toBe('INSPECTION_CERTIFICATE_MISSING');
    // The refusal names the item and the agency, and the remedy names
    // both ways out — certify it, or clear the gate.
    expect(body.message).toContain('A-0001');
    expect(body.message).toMatch(/certified/);
    expect(body.message).toContain('RDSO');
    expect(body.remedy).toContain('Inspection');
    await discardChallan(challanId);
  });

  it('lets the same challan through once the certificate is live', async () => {
    await certifyItem();
    const challanId = await seedDraftChallan(gatedItemId, 'test');
    const issued = await issueChallan(challanId);
    expect(issued.statusCode, issued.body).toBe(201);
    // Left where it is: an ISSUED challan is immutable and its lines
    // cannot be removed (the 0027 guard), and only a DRAFT would occupy
    // the one-open-draft slot the next case needs.
  });

  it('blocks again the moment the certifying call is withdrawn', async () => {
    // Cancellation is what a withdrawn certificate looks like here, and
    // the gate reads `closed` — so withdrawal puts the item straight back
    // behind the wall with nothing else having to change.
    await withdrawEveryCertificate();
    const challanId = await seedDraftChallan(gatedItemId, 'test');
    const refused = await issueChallan(challanId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'INSPECTION_CERTIFICATE_MISSING',
    );
    await discardChallan(challanId);
  });

  it('lets an expired certificate stop authorising despatch without anything being cancelled', async () => {
    // The window closed yesterday. Nothing was withdrawn and no status
    // moved; the gate simply compares against the database's own date.
    await withdrawEveryCertificate();
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await certifyItem([gatedItemId], yesterday.toISOString().slice(0, 10));
    const challanId = await seedDraftChallan(gatedItemId, 'test');
    const refused = await issueChallan(challanId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'INSPECTION_CERTIFICATE_MISSING',
    );
    await discardChallan(challanId);
  });

  it('issues freely with the gate off, and for an item no clause names', async () => {
    // Config OFF is the pilot default and the whole of the "no
    // retroactive blocking" promise: an item whose clause does not gate
    // despatch behaves exactly as it did before 0082.
    await gateTheItem(false);
    const gatedChallan = await seedDraftChallan(gatedItemId, 'test');
    const withGateOff = await issueChallan(gatedChallan);
    expect(withGateOff.statusCode, withGateOff.body).toBe(201);

    // And an item with NO clause row at all — the state every Work in the
    // database was left in by the migration.
    const freeChallan = await seedDraftChallan(freeItemId, 'test');
    const unmapped = await issueChallan(freeChallan);
    expect(unmapped.statusCode, unmapped.body).toBe(201);
    await gateTheItem();
  });

  it('refuses the issue in the database too, not only in the route', async () => {
    // The route's refusal is the one an operator meets. This is the layer
    // that holds for a writer that reached the table another way, which
    // is the posture recurring finding 2 asks for on a money rule.
    await gateTheItem();
    await withdrawEveryCertificate();
    const challanId = await seedDraftChallan(gatedItemId, 'test');
    await expect(
      admin`
        update delivery_challans
        set status = 'issued', challan_number = 'DC-RAW-1', sequence_number = 99,
            issued_at = now(), issued_by_user_id = 'test',
            issued_snapshot = '{}'::jsonb
        where id = ${challanId}
      `,
    ).rejects.toThrow(/inspection certificate missing for: A-0001/);
    await discardChallan(challanId);
  });
});

describe('under concurrency (engineering rule 9)', () => {
  it('gives two calls raised at once two different numbers', async () => {
    // The counter is claimed by upsert, not by reading max()+1, so the
    // loser of the race waits on the counter row rather than minting a
    // duplicate. Before the counter existed this took the WORKS row lock,
    // which serialised inspection calls against every other writer of the
    // Work for nothing but a sequence.
    await gateTheItem();
    const [first, second] = await Promise.all([
      authed(owner, {
        method: 'POST',
        url: `/api/works/${workId}/inspection-calls`,
        organisationId,
        payload: {
          agency: 'RDSO',
          requestedOn: '2026-02-01',
          vendorPremises: null,
          items: [{ workItemId: gatedItemId, quantity: '1.000' }],
        },
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/works/${workId}/inspection-calls`,
        organisationId,
        payload: {
          agency: 'RDSO',
          requestedOn: '2026-02-01',
          vendorPremises: null,
          items: [{ workItemId: gatedItemId, quantity: '1.000' }],
        },
      }),
    ]);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    const references = [
      first.json<InspectionCall>().callReference,
      second.json<InspectionCall>().callReference,
    ];
    expect(new Set(references).size, references.join(' / ')).toBe(2);
  });

  it('serialises an issue against a withdrawal of the certificate it rests on', async () => {
    // The race the FOR SHARE lock exists for: the gate reads a live call,
    // a withdrawal commits, and the challan would otherwise issue under a
    // certificate that no longer authorises it. Whichever order they land
    // in, the two outcomes that are allowed are "issued then withdrawn"
    // and "withdrawn then refused" — never "withdrawn AND issued under
    // it".
    await gateTheItem();
    await withdrawEveryCertificate();
    const certified = await certifyItem();
    const challanId = await seedDraftChallan(gatedItemId, 'test');

    const [issue, withdraw] = await Promise.all([
      issueChallan(challanId),
      authed(owner, {
        method: 'POST',
        url: `/api/inspection-calls/${certified.id}/cancel`,
        organisationId,
        payload: { reason: 'Certificate withdrawn mid-issue' },
      }),
    ]);
    expect(withdraw.statusCode, withdraw.body).toBe(200);
    expect([201, 409]).toContain(issue.statusCode);
    if (issue.statusCode === 409) {
      expect(issue.json<{ code: string }>().code).toBe(
        'INSPECTION_CERTIFICATE_MISSING',
      );
      await discardChallan(challanId);
    }
    // Either way the gate is closed AFTERWARDS, which is the invariant
    // that matters: the next despatch is refused.
    const next = await seedDraftChallan(gatedItemId, 'test');
    const refused = await issueChallan(next);
    expect(refused.statusCode, refused.body).toBe(409);
    await discardChallan(next);
  });

  it('serialises an evidence upload against the close it would complete', async () => {
    await gateTheItem();
    const call = await raiseCall();
    await receiveLetter(call.id, `RDSO/CALL/RACE-${runId}`);
    const loaded = await authed(owner, {
      method: 'GET',
      url: `/api/inspection-calls/${call.id}`,
      organisationId,
    });
    const pendingDocument = loaded
      .json<InspectionCall>()
      .documents.find((document) => document.kind === 'evidence' && document.mandatory);
    const certificate = uploadCertificate(call.id, `IC/RACE-${runId}`);
    const upload =
      pendingDocument === undefined
        ? Promise.resolve(null)
        : authed(owner, {
            method: 'POST',
            url: `/api/inspection-call-documents/${pendingDocument.id}/file?${query({
              filename: 'race.pdf',
            })}`,
            organisationId,
            headers: { 'content-type': 'application/pdf' },
            payload: pdfBytes(),
          });
    const close = authed(owner, {
      method: 'POST',
      url: `/api/inspection-calls/${call.id}/close`,
      organisationId,
    });
    const [certificateResult, uploadResult, closeResult] = await Promise.all([
      certificate,
      upload,
      close,
    ]);
    expect(certificateResult.statusCode, certificateResult.body).toBe(200);
    if (uploadResult !== null) {
      expect([200, 409]).toContain(uploadResult.statusCode);
    }
    // The close either waited and found everything, or ran first and
    // refused for what was outstanding. What it must never do is close a
    // call whose mandatory papers are missing — proved by re-reading.
    expect([200, 409]).toContain(closeResult.statusCode);
    const after = await authed(owner, {
      method: 'GET',
      url: `/api/inspection-calls/${call.id}`,
      organisationId,
    });
    const state = after.json<InspectionCall>();
    if (state.status === 'closed') {
      expect(
        state.documents.every(
          (document) => !document.mandatory || document.originalFilename !== null,
        ),
        'a closed call has every mandatory paper on file',
      ).toBe(true);
    }
  });
});

describe('the walls', () => {
  it('hides another organisation call behind RLS, not behind a 403', async () => {
    const read = await authed(owner, {
      method: 'GET',
      url: `/api/inspection-calls/${outsiderCallId}`,
      organisationId,
    });
    expect(read.statusCode, read.body).toBe(404);
    expect(read.json<{ code: string }>().code).toBe('INSPECTION_CALL_NOT_FOUND');

    // And the register never leaks it either.
    const register = await authed(owner, {
      method: 'GET',
      url: '/api/inspection-calls',
      organisationId,
    });
    expect(register.statusCode, register.body).toBe(200);
    const listed = register.json<InspectionCallListResponse>();
    expect(listed.calls.every((call) => call.workId !== otherWorkId)).toBe(true);
  });

  it('answers 404 to a work-scoped member with no assignment', async () => {
    // 404 and not 403, matching `assertWorkAccess`: a guessed id must not
    // confirm that the Work exists.
    const config = await authed(scoped, {
      method: 'GET',
      url: `/api/works/${workId}/inspection-config`,
      organisationId,
    });
    expect(config.statusCode, config.body).toBe(404);
    expect(config.json<{ code: string }>().code).toBe('WORK_NOT_FOUND');

    const raise = await authed(scoped, {
      method: 'POST',
      url: `/api/works/${workId}/inspection-calls`,
      organisationId,
      payload: {
        agency: 'RDSO',
        requestedOn: '2026-02-01',
        vendorPremises: null,
        items: [{ workItemId: gatedItemId, quantity: '1.000' }],
      },
    });
    expect(raise.statusCode, raise.body).toBe(404);

    // The register is filtered rather than refused: an assigned member
    // sees the calls of the Works it is assigned to, which here is none.
    const register = await authed(scoped, {
      method: 'GET',
      url: '/api/inspection-calls',
      organisationId,
    });
    expect(register.statusCode, register.body).toBe(200);
    expect(register.json<InspectionCallListResponse>().calls).toHaveLength(0);
    expect(register.json<InspectionCallListResponse>().awaitingCertificate).toBe(0);
  });

  it('refuses an outsider outright, before any record is named', async () => {
    const read = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${workId}/inspection-config`,
      organisationId,
    });
    expect(read.statusCode, read.body).toBe(403);
  });
});

/**
 * The structured inspection vendor and its address (migration 0116).
 *
 * The premises used to be free text on the clause and free text on the
 * call, retyped for every item. It is now a vendor-role contact and one
 * of that vendor's saved addresses — and the two records treat it
 * differently on purpose, which is what these cases prove: the CLAUSE
 * joins the master live, because it is configuration; the CALL copies the
 * name and the text, because it is a record of a request that went out.
 */
describe('the inspection vendor and its address (0116)', () => {
  let vendorId = '';
  let worksAddressId = '';
  let officeAddressId = '';

  async function newContact(body: Record<string, unknown>): Promise<string> {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  beforeAll(async () => {
    vendorId = await newContact({
      designation: `RailTech Components ${runId}`,
      address: 'Plot 14, Industrial Estate, Hosur',
      pincode: '635109',
      stateCode: '33',
      isVendor: true,
    });
    // The contact form's address became the vendor's PRIMARY address, so
    // the list starts with one row and the second is added beside it.
    const listed = await authed(owner, {
      method: 'GET',
      url: '/api/masters/contacts?role=vendor',
      organisationId,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const vendor = listed
      .json<{ contacts: readonly Contact[] }>()
      .contacts.find((contact) => contact.id === vendorId);
    expect(vendor?.addresses).toHaveLength(1);
    expect(vendor?.addresses?.[0]?.isPrimary).toBe(true);
    worksAddressId = vendor?.addresses?.[0]?.id ?? '';

    const second = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${vendorId}/addresses`,
      organisationId,
      payload: {
        label: 'Regd. office',
        address: '2nd Floor, Anna Salai, Chennai',
        pincode: '600002',
        stateCode: '33',
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    officeAddressId = second.json<{ id: string }>().id;
    // Added beside the primary, not instead of it.
    expect(second.json<{ isPrimary: boolean }>().isPrimary).toBe(false);
  });

  it('reads the clause vendor live, so a corrected address reaches the next call', async () => {
    const saved = await saveClauses(owner, [
      {
        workItemId: gatedItemId,
        agency: 'RDSO',
        inspectionQuantity: '100.000',
        vendorContactId: vendorId,
        vendorAddressId: officeAddressId,
        vendorPremises: null,
        gatesDispatch: true,
      },
    ]);
    expect(saved.statusCode, saved.body).toBe(200);
    const row = saved
      .json<WorkInspectionConfig>()
      .items.find((item) => item.workItemId === gatedItemId);
    expect(row?.vendorContactId).toBe(vendorId);
    expect(row?.vendorAddressId).toBe(officeAddressId);
    expect(row?.vendorAddress).toBe('2nd Floor, Anna Salai, Chennai');
    expect(row?.vendorPremises).toBe(null);

    // Correct the address in the master. The CLAUSE follows it, because
    // a clause is configuration and not a document.
    const corrected = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${vendorId}/addresses/${officeAddressId}`,
      organisationId,
      payload: {
        label: 'Regd. office',
        address: '3rd Floor, Anna Salai, Chennai',
        pincode: '600002',
        stateCode: '33',
      },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const reread = await authed(owner, {
      method: 'GET',
      url: `/api/works/${workId}/inspection-config`,
      organisationId,
    });
    expect(
      reread
        .json<WorkInspectionConfig>()
        .items.find((item) => item.workItemId === gatedItemId)?.vendorAddress,
    ).toBe('3rd Floor, Anna Salai, Chennai');
  });

  it('snapshots the vendor onto the call, immune to a later rename or retirement', async () => {
    const raised = await authed(owner, {
      method: 'POST',
      url: `/api/works/${workId}/inspection-calls`,
      organisationId,
      payload: {
        agency: 'RDSO',
        requestedOn: '2026-02-01',
        vendorContactId: vendorId,
        vendorAddressId: worksAddressId,
        vendorPremises: null,
        items: [{ workItemId: gatedItemId, quantity: '10.000' }],
      },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    const call = raised.json<InspectionCall>();
    expect(call.vendorContactId).toBe(vendorId);
    expect(call.vendorAddressId).toBe(worksAddressId);
    expect(call.vendorName).toBe(`RailTech Components ${runId}`);
    expect(call.vendorPremises).toBe('Plot 14, Industrial Estate, Hosur');

    // Rename the vendor and retire the address the call cited. The call
    // printed what it printed (AGENTS.md rule 7).
    const renamed = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${vendorId}`,
      organisationId,
      payload: {
        designation: `RailTech Components Pvt Ltd ${runId}`,
        address: 'Plot 14, Industrial Estate, Hosur',
        pincode: '635109',
        stateCode: '33',
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${vendorId}/addresses/${worksAddressId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);

    const after = await authed(owner, {
      method: 'GET',
      url: `/api/inspection-calls/${call.id}`,
      organisationId,
    });
    expect(after.statusCode, after.body).toBe(200);
    const frozen = after.json<InspectionCall>();
    expect(frozen.vendorName).toBe(`RailTech Components ${runId}`);
    expect(frozen.vendorPremises).toBe('Plot 14, Industrial Estate, Hosur');

    // Put the address back, so the rest of the suite finds the vendor as
    // it was left.
    const back = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${vendorId}/addresses/${worksAddressId}/reactivate`,
      organisationId,
    });
    expect(back.statusCode, back.body).toBe(200);
  });

  it('refuses a contact that is not a vendor, and an address that is not its own', async () => {
    const consigneeId = await newContact({
      designation: `Sr. DEE (G) Salem ${runId}`,
      address: 'Divisional Office, Salem',
    });
    const notAVendor = await saveClauses(owner, [
      {
        workItemId: gatedItemId,
        agency: 'RDSO',
        inspectionQuantity: '100.000',
        vendorContactId: consigneeId,
        vendorAddressId: null,
        vendorPremises: null,
        gatesDispatch: true,
      },
    ]);
    expect(notAVendor.statusCode, notAVendor.body).toBe(409);
    expect(notAVendor.json<{ code: string }>().code).toBe('INSPECTION_VENDOR_INVALID');

    // The database says the same thing when the route is not the writer:
    // 0116's own 23Y01, from the guard on the table.
    const direct = admin`
      update inspection_clauses set vendor_contact_id = ${consigneeId}
      where work_item_id = ${gatedItemId}
    `;
    await expect(direct).rejects.toMatchObject({ code: '23Y01' });

    // An address belonging to somebody else is refused by name, and the
    // composite foreign key refuses it again underneath.
    const consigneeAddress = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${consigneeId}/addresses`,
      organisationId,
      payload: { address: 'Goods Shed, Salem Junction' },
    });
    expect(consigneeAddress.statusCode, consigneeAddress.body).toBe(201);
    const borrowed = await saveClauses(owner, [
      {
        workItemId: gatedItemId,
        agency: 'RDSO',
        inspectionQuantity: '100.000',
        vendorContactId: vendorId,
        vendorAddressId: consigneeAddress.json<{ id: string }>().id,
        vendorPremises: null,
        gatesDispatch: true,
      },
    ]);
    expect(borrowed.statusCode, borrowed.body).toBe(404);
    expect(borrowed.json<{ code: string }>().code).toBe('CONTACT_ADDRESS_NOT_FOUND');
  });

  it('refuses a saved address and free text at once, and keeps free text alone working', async () => {
    const both = await saveClauses(owner, [
      {
        workItemId: gatedItemId,
        agency: 'RDSO',
        inspectionQuantity: '100.000',
        vendorContactId: vendorId,
        vendorAddressId: worksAddressId,
        vendorPremises: 'Some other shed',
        gatesDispatch: true,
      },
    ]);
    expect(both.statusCode, both.body).toBe(400);
    expect(both.json<{ code: string }>().code).toBe('CONTACT_ADDRESS_INVALID');

    // 0082's sub-vendor case survives untouched: no master row, free text
    // alone, exactly as before this migration.
    const free = await saveClauses(owner, [
      {
        workItemId: gatedItemId,
        agency: 'RDSO',
        inspectionQuantity: '100.000',
        vendorPremises: 'A sub-vendor shed with no master row',
        gatesDispatch: true,
      },
    ]);
    expect(free.statusCode, free.body).toBe(200);
    const row = free
      .json<WorkInspectionConfig>()
      .items.find((item) => item.workItemId === gatedItemId);
    expect(row?.vendorContactId).toBe(null);
    expect(row?.vendorPremises).toBe('A sub-vendor shed with no master row');
  });

  it('keeps one primary address per contact, and promotes an heir when it retires', async () => {
    const promoted = await authed(owner, {
      method: 'PUT',
      url: `/api/masters/contacts/${vendorId}/addresses/${officeAddressId}`,
      organisationId,
      payload: {
        label: 'Regd. office',
        address: '3rd Floor, Anna Salai, Chennai',
        pincode: '600002',
        stateCode: '33',
        isPrimary: true,
      },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json<{ isPrimary: boolean }>().isPrimary).toBe(true);

    // The mirror: `contacts.address` and its three companions now read
    // the new primary, which is what every existing document prefill and
    // the e-way bill's state code join go on reading.
    const [mirrored] = await admin<
      { address: string; pincode: string; state_code: string }[]
    >`
      select address, pincode, state_code from contacts where id = ${vendorId}
    `;
    expect(mirrored?.address).toBe('3rd Floor, Anna Salai, Chennai');
    expect(mirrored?.pincode).toBe('600002');

    // Exactly one primary, enforced by the partial unique index.
    const [count] = await admin<{ primaries: string }[]>`
      select count(*)::text as primaries from contact_addresses
      where contact_id = ${vendorId} and is_primary
    `;
    expect(count?.primaries).toBe('1');

    // Retiring the primary hands the flag on rather than leaving the
    // contact advertising nothing.
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${vendorId}/addresses/${officeAddressId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json<{ isPrimary: boolean }>().isPrimary).toBe(false);
    const [heir] = await admin<{ id: string }[]>`
      select id from contact_addresses
      where contact_id = ${vendorId} and is_primary
    `;
    expect(heir?.id).toBe(worksAddressId);
    const [afterHeir] = await admin<{ address: string }[]>`
      select address from contacts where id = ${vendorId}
    `;
    expect(afterHeir?.address).toBe('Plot 14, Industrial Estate, Hosur');
  });
});
