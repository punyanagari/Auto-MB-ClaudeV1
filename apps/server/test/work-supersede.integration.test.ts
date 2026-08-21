import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ApprovalRequest,
  ConfirmWorkRequest,
  SupersedeEligibilityResponse,
  WorkDetailResponse,
  WorkSupersession,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import {
  DOWNSTREAM_REGISTERS,
  WORK_CHILD_TABLES_EXEMPT,
} from '../src/work-supersede.js';

/**
 * Superseding a confirmed Work (pack P19, migration 0071): the correction
 * deadlock migration 0063's header prescribes a remedy for and the product
 * had no path to.
 *
 * The lifecycle proved end to end below is the whole point of the pack:
 * confirm a letter into a Work, discover the extracted values are wrong,
 * ask for the Work to be superseded, have an approver with the cancel
 * authority approve it, and confirm the SAME letter again into a successor
 * that carries the same work code — with the withdrawal, its reason, its
 * approval and both ends of the provenance on the record afterwards.
 *
 * The database's own half of the rule (the eligibility census, the
 * soft-delete guard, the release guard, and the two holes that existed
 * before 0071) is proved in `packages/db/test/work-supersession.integration.test.ts`.
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
const supersedeMigration = path.join(migrationsDirectory, '0071_work_supersession.sql');
const guardRestatement = path.join(
  migrationsDirectory,
  '0114_work_billing_baseline.sql',
);

/** The soft-delete guard as the schema at head actually holds it: 0071
 * wrote it, 0114 § 9 restated it (last writer wins, the founder-grant
 * discipline), so the comparison below reads the restatement. Extracting
 * the function body keeps the register census from counting `FROM … t`
 * text that belongs to anything else in the restating file. */
async function latestSoftDeleteGuard(): Promise<string> {
  const restated = await readFile(guardRestatement, 'utf8');
  const body =
    /CREATE (?:OR REPLACE )?FUNCTION app_private\.guard_work_soft_delete\(\)[\s\S]*?\n\$\$;/.exec(
      restated,
    );
  if (body !== null) return body[0];
  return readFile(supersedeMigration, 'utf8');
}

const runId = randomBytes(5).toString('hex');
const ownerEmail = `sup-owner-${runId}@integration.test`;
const officeEmail = `sup-office-${runId}@integration.test`;
const approverEmail = `sup-approver-${runId}@integration.test`;
const viewerEmail = `sup-viewer-${runId}@integration.test`;
const scopedEmail = `sup-scoped-${runId}@integration.test`;
const outsiderEmail = `sup-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
/** Holds can_approve_amendments but NOT can_cancel_documents. */
let approver: CookieJar;
let viewer: CookieJar;
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

/**
 * A document waiting in review whose stored parse asserts nothing.
 *
 * The extracted-value lock derives what is locked from the payload, so a
 * payload with no parser provenance locks nothing and the confirm request
 * is free — which is what these tests want, because the subject here is
 * the Work's lifecycle rather than the parser's. The lock's own behaviour
 * is proved against real corpus letters in `loa.integration.test.ts`.
 */
async function seedReviewDocument(label: string): Promise<string> {
  const documentId = randomUUID();
  await admin`
    insert into loa_documents (
      id, organisation_id, object_key, original_filename, sha256, media_type,
      size_bytes, extraction_status, extraction_payload, uploaded_by_user_id
    )
    values (
      ${documentId}, ${organisationId},
      ${`${organisationId}/loa/${documentId}.pdf`}, ${`${label}.pdf`},
      ${createHash('sha256').update(documentId).digest('hex')},
      'application/pdf', 4096, 'review',
      ${admin.json({ error: 'seeded without a parse for the lifecycle tests' })},
      ${ownerUserId}
    )
  `;
  return documentId;
}

function confirmBody(workCode: string, letterNumber: string): ConfirmWorkRequest {
  return {
    workCode,
    letterNumber,
    letterDate: '2026-01-15',
    title: 'Signalling works at Bhusawal yard',
    advertisedValue: '500000.00',
    contractValue: '450000.00',
    pricingShape: 'per_schedule',
    schedules: [
      {
        scheduleCode: 'A',
        title: 'Schedule A',
        items: [
          {
            itemNumber: 'A/1',
            description: 'Signalling cable, 6 core',
            unitCode: 'Mtr',
            awardedQuantity: '100.000',
            effectiveRate: '250.00',
            manualEntry: true,
          },
        ],
      },
    ],
  };
}

/** Confirms a seeded review document into a Work, the way the review
 * screen does. Returns the created Work. */
async function confirmWork(
  documentId: string,
  workCode: string,
  letterNumber: string,
): Promise<WorkDetailResponse> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/loa-documents/${documentId}/confirm`,
    organisationId,
    payload: confirmBody(workCode, letterNumber),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<WorkDetailResponse>();
}

async function eligibility(workId: string): Promise<SupersedeEligibilityResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/works/${workId}/supersede-eligibility`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SupersedeEligibilityResponse>();
}

async function propose(
  workId: string,
  reason = 'The rates were confirmed at the advertised figures; the letter is 14.35% below par.',
  jar: CookieJar = office,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/works/${workId}/supersede-requests`,
    organisationId,
    payload: { reason },
  });
}

async function approve(approvalId: string, jar: CookieJar = owner) {
  return authed(jar, {
    method: 'POST',
    url: `/api/approvals/${approvalId}/approve`,
    organisationId,
    payload: { note: 'Confirmed against the letter; the accepted rates are wrong.' },
  });
}

/** One Work, confirmed and ready to be superseded, with its own letter. */
async function freshWork(tag: string): Promise<{
  readonly documentId: string;
  readonly work: WorkDetailResponse['work'];
  readonly workItemId: string;
}> {
  const documentId = await seedReviewDocument(tag);
  const confirmed = await confirmWork(
    documentId,
    `SUP${tag}${runId.slice(0, 4)}`.toUpperCase().slice(0, 20),
    `LOA/${tag}/${runId}`,
  );
  const workItemId = confirmed.schedules[0]?.items[0]?.id;
  if (workItemId === undefined) throw new Error('confirmed Work carries no item');
  return { documentId, work: confirmed.work, workItemId };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-supersede-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the work-supersede integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-sup-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Sup Owner');
  office = await signUp(officeEmail, 'Sup Office');
  approver = await signUp(approverEmail, 'Sup Approver');
  viewer = await signUp(viewerEmail, 'Sup Viewer');
  scoped = await signUp(scopedEmail, 'Sup Scoped');
  outsider = await signUp(outsiderEmail, 'Sup Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Supersede Constructions', slug: `sup-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Supersede Outsiders', slug: `sup-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [approverEmail, 'office'],
    [viewerEmail, 'viewer'],
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

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing');
  ownerUserId = ownerUser.id;
  // The owner decides: approval authority AND the cancel authority a
  // withdrawal demands.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true,
        can_approve_amendments = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  // The approver holds the approval authority alone — the separation the
  // supersede branch of applyApproval exists to enforce.
  await admin`
    update organisation_memberships
    set can_approve_amendments = true, can_cancel_documents = false
    where organisation_id = ${organisationId}
      and user_id = (select "id" from auth_users where "email" = ${approverEmail})
  `;
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId}
      and user_id = (select "id" from auth_users where "email" = ${scopedEmail})
  `;
}, 120_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
    await admin`
      delete from auth_users
      where "email" in (${ownerEmail}, ${officeEmail}, ${approverEmail},
                        ${viewerEmail}, ${scopedEmail}, ${outsiderEmail})
    `;
    await admin.end({ timeout: 5 });
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
}, 60_000);

describe('the correction deadlock, before the exit exists', () => {
  it('refuses to discard the letter a Work was confirmed from', async () => {
    const { documentId } = await freshWork('DEAD');
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/discard`,
      organisationId,
      payload: { reason: 'The rates were read at the advertised figures.' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'DOCUMENT_CONFIRMED' });
  });
});

describe('supersede eligibility', () => {
  it('reports a clean confirmed Work as eligible, and names its letter', async () => {
    const { documentId, work } = await freshWork('CLEAN');
    const result = await eligibility(work.id);
    expect(result).toMatchObject({
      workId: work.id,
      eligible: true,
      blockers: [],
      loaDocumentId: documentId,
      pendingRequestId: null,
    });
  });

  it('names every register that holds a document, and refuses the proposal', async () => {
    const { work, workItemId } = await freshWork('BLOCK');
    const challan = await authed(owner, {
      method: 'POST',
      url: `/api/works/${work.id}/challans`,
      organisationId,
      payload: {
        challanDate: '2026-02-01',
        prefix: 'DC',
        consignee: { name: 'Sr. DEE (G) CR', address: 'Bhusawal Division' },
        items: [{ workItemId, quantity: '10.000' }],
      },
    });
    expect(challan.statusCode, challan.body).toBe(201);

    const result = await eligibility(work.id);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual([
      { register: 'delivery_challans', label: 'delivery challans' },
    ]);

    const refused = await propose(work.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'WORK_HAS_DOWNSTREAM_DOCUMENTS' });
    expect(refused.json<{ message: string }>().message).toContain('delivery challans');
  });

  it('is denied to a member the Work is out of scope for', async () => {
    const { work } = await freshWork('SCOPE');
    const denied = await authed(scoped, {
      method: 'GET',
      url: `/api/works/${work.id}/supersede-eligibility`,
      organisationId,
    });
    expect(denied.statusCode, denied.body).toBe(404);
    expect(denied.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });

    const proposal = await propose(work.id, undefined, scoped);
    expect(proposal.statusCode, proposal.body).toBe(404);
  });

  it('is denied across organisations and to viewers', async () => {
    const { work } = await freshWork('CROSS');
    const foreign = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${work.id}/supersede-eligibility`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreign.statusCode, foreign.body).toBe(404);

    const readOnly = await propose(work.id, undefined, viewer);
    expect(readOnly.statusCode, readOnly.body).toBe(403);
    expect(readOnly.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });
});

describe('the supersede decision', () => {
  it('never applies on filing, however much authority the filer holds', async () => {
    const { work } = await freshWork('QUEUE');
    // Filed by the owner, who holds both the approval and cancel
    // authorities: an amendment would apply immediately, a withdrawal does
    // not.
    const filed = await propose(work.id, undefined, owner);
    expect(filed.statusCode, filed.body).toBe(201);
    expect(filed.json<ApprovalRequest>()).toMatchObject({
      entityType: 'work_supersede',
      entityId: work.id,
      status: 'pending',
    });

    const [row] = await admin<{ deleted_at: Date | null }[]>`
      select deleted_at from works where id = ${work.id}
    `;
    expect(row?.deleted_at).toBeNull();
  });

  it('admits one pending request per Work', async () => {
    const { work } = await freshWork('ONCE');
    const first = await propose(work.id);
    expect(first.statusCode, first.body).toBe(201);
    const second = await propose(work.id);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ code: 'PENDING_EXISTS' });
  });

  it('refuses an approver who does not hold the cancel authority', async () => {
    const { work } = await freshWork('AUTH');
    const filed = await propose(work.id);
    const approvalId = filed.json<ApprovalRequest>().id;

    const refused = await approve(approvalId, approver);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'AUTHORITY_REQUIRED' });

    // The failed apply rolled back: the request is still pending and the
    // Work is untouched.
    const [request] = await admin<{ status: string }[]>`
      select status from approval_requests where id = ${approvalId}
    `;
    expect(request?.status).toBe('pending');
    const [row] = await admin<{ deleted_at: Date | null }[]>`
      select deleted_at from works where id = ${work.id}
    `;
    expect(row?.deleted_at).toBeNull();
  });
});

describe('the whole remedy, end to end', () => {
  it('withdraws the Work, releases its letter, and confirms a successor under the same work code', async () => {
    const { documentId, work } = await freshWork('WHOLE');
    const workCode = work.workCode;
    const letterNumber = work.letterNumber;

    const filed = await propose(work.id);
    expect(filed.statusCode, filed.body).toBe(201);
    const approvalId = filed.json<ApprovalRequest>().id;

    const decided = await approve(approvalId);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json<ApprovalRequest>().status).toBe('approved');

    // The Work is gone from the product: out of the register, and a direct
    // read no longer resolves.
    const register = await authed(owner, {
      method: 'GET',
      url: '/api/works',
      organisationId,
    });
    expect(register.statusCode, register.body).toBe(200);
    expect(
      register.json<{ works: { id: string }[] }>().works.map((entry) => entry.id),
    ).not.toContain(work.id);
    const gone = await authed(owner, {
      method: 'GET',
      url: `/api/works/${work.id}`,
      organisationId,
    });
    expect(gone.statusCode, gone.body).toBe(404);

    // The letter is back where an unconfirmed letter belongs.
    const document = await authed(owner, {
      method: 'GET',
      url: `/api/loa-documents/${documentId}`,
      organisationId,
    });
    expect(document.statusCode, document.body).toBe(200);
    expect(document.json()).toMatchObject({
      extractionStatus: 'review',
      confirmedWorkId: null,
    });

    // And it confirms again — under the same work code and the same letter
    // number, because it is the same contract.
    const successor = (await confirmWork(documentId, workCode, letterNumber)).work;
    expect(successor.id).not.toBe(work.id);
    expect(successor.workCode).toBe(workCode);
    expect(successor.letterNumber).toBe(letterNumber);

    // Provenance, both directions, from the supersession record.
    const [supersession] = await admin<
      {
        superseded_work_id: string;
        successor_work_id: string | null;
        loa_document_id: string;
        approval_request_id: string;
        reason: string;
        successor_bound_at: Date | null;
      }[]
    >`
      select superseded_work_id, successor_work_id, loa_document_id,
             approval_request_id, reason, successor_bound_at
      from work_supersessions where superseded_work_id = ${work.id}
    `;
    expect(supersession).toMatchObject({
      superseded_work_id: work.id,
      successor_work_id: successor.id,
      loa_document_id: documentId,
      approval_request_id: approvalId,
    });
    expect(supersession?.reason).toContain('14.35% below par');
    expect(supersession?.successor_bound_at).not.toBeNull();

    // The trail says what happened, in the approval engine's own register.
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId}
        and entity_id in (${approvalId}, ${successor.id})
      order by occurred_at
    `;
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'work.supersede_proposed',
        'work.superseded',
        'work.created',
      ]),
    );
  });

  it('refuses a second supersession of a Work already withdrawn', async () => {
    const { work } = await freshWork('TWICE');
    const filed = await propose(work.id);
    const approvalId = filed.json<ApprovalRequest>().id;
    expect((await approve(approvalId)).statusCode).toBe(200);

    // Every Work-addressed route treats a withdrawn Work as absent.
    const again = await propose(work.id);
    expect(again.statusCode, again.body).toBe(404);
    expect(again.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });
  });
});

/**
 * The identity half of the rule.
 *
 * Freeing the work code opens a question the approval never answered: who
 * gets it. Without these three refusals, superseding is a work-code rename
 * with no approval behind it — the approver reads a reason for withdrawing
 * one contract and approves that, and whoever confirms the released letter
 * afterwards decides what it becomes.
 */
describe('the successor identity', () => {
  /** Supersedes a fresh Work and returns the released letter. */
  async function releasedLetter(tag: string) {
    const fixture = await freshWork(tag);
    const filed = await propose(fixture.work.id);
    expect(filed.statusCode, filed.body).toBe(201);
    expect((await approve(filed.json<ApprovalRequest>().id)).statusCode).toBe(200);
    return fixture;
  }

  it('refuses a successor confirmed under a different work code', async () => {
    const { documentId, work } = await releasedLetter('IDENT');
    const renamed = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: {
        ...confirmBody(`RENAMED${runId.slice(0, 4)}`.toUpperCase(), work.letterNumber),
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(409);
    expect(renamed.json()).toMatchObject({
      code: 'SUCCESSOR_IDENTITY_MISMATCH',
      details: {
        expectedWorkCode: work.workCode,
        expectedLetterNumber: work.letterNumber,
      },
    });

    // The refusal saved nothing: no Work, and the letter still in review.
    const works = await admin<{ id: string }[]>`
      select id from works
      where organisation_id = ${organisationId} and deleted_at is null
        and work_code like ${'RENAMED%'}
    `;
    expect(works).toHaveLength(0);
    const [document] = await admin<{ extraction_status: string }[]>`
      select extraction_status from loa_documents where id = ${documentId}
    `;
    expect(document?.extraction_status).toBe('review');
  });

  it('refuses a successor confirmed under a different letter number', async () => {
    const { documentId, work } = await releasedLetter('LETTR');
    const renamed = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: confirmBody(work.workCode, `LOA/RENAMED/${runId}`),
    });
    expect(renamed.statusCode, renamed.body).toBe(409);
    expect(renamed.json()).toMatchObject({ code: 'SUCCESSOR_IDENTITY_MISMATCH' });
  });

  it('reserves the freed identity for the successor, and frees it on discard', async () => {
    const { documentId, work } = await releasedLetter('RESRV');

    // A DIFFERENT letter cannot take the freed identity while the released
    // one is still waiting for it.
    const otherDocument = await seedReviewDocument('RESRV-OTHER');
    const stolen = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${otherDocument}/confirm`,
      organisationId,
      payload: confirmBody(work.workCode, `LOA/OTHER/${runId}`),
    });
    expect(stolen.statusCode, stolen.body).toBe(409);
    expect(stolen.json()).toMatchObject({ code: 'WORK_IDENTITY_RESERVED' });

    // Discarding the released letter ends the reservation: no successor can
    // arrive through it any more, which is exactly the documented
    // discard-and-re-upload remedy (docs/PRODUCT.md §5.6).
    const discarded = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/discard`,
      organisationId,
      payload: { reason: 'The scan is illegible at the schedule headers.' },
    });
    expect(discarded.statusCode, discarded.body).toBe(200);

    const reused = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${otherDocument}/confirm`,
      organisationId,
      payload: confirmBody(work.workCode, `LOA/OTHER/${runId}`),
    });
    expect(reused.statusCode, reused.body).toBe(201);
    // And it is unlinked, by design: the document the link is kept on was
    // thrown away, so the supersession stays without a successor.
    const [supersession] = await admin<{ successor_work_id: string | null }[]>`
      select successor_work_id from work_supersessions
      where superseded_work_id = ${work.id}
    `;
    expect(supersession?.successor_work_id).toBeNull();
  });

  it('refuses a confirmer who could not see the Work being replaced', async () => {
    const { documentId, work } = await releasedLetter('SCOPED');
    // An 'assigned'-scope office member: the writer role alone passes, and
    // before this refusal the work_scope was never consulted on this path.
    const denied = await authed(scoped, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: confirmBody(work.workCode, work.letterNumber),
    });
    expect(denied.statusCode, denied.body).toBe(404);
    expect(denied.json()).toMatchObject({ code: 'WORK_NOT_FOUND' });
  });

  it("carries the withdrawn Work's assignments to its successor", async () => {
    const { documentId, work } = await freshWork('ASSIGN');
    const [scopedUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${scopedEmail}
    `;
    const [siteUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${viewerEmail}
    `;
    if (!scopedUser || !siteUser) throw new Error('assignment fixture users missing');
    await admin`
      insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
      values (${organisationId}, ${work.id}, ${scopedUser.id}, ${ownerUserId}),
             (${organisationId}, ${work.id}, ${siteUser.id}, ${ownerUserId})
    `;

    const filed = await propose(work.id);
    expect((await approve(filed.json<ApprovalRequest>().id)).statusCode).toBe(200);
    const successor = (await confirmWork(documentId, work.workCode, work.letterNumber))
      .work;

    const carried = await admin<{ user_id: string }[]>`
      select user_id from work_assignments
      where work_id = ${successor.id} order by user_id
    `;
    expect(carried.map((row) => row.user_id).sort()).toEqual(
      [scopedUser.id, siteUser.id].sort(),
    );
    const [event] = await admin<{ details: unknown }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'work.assignments_carried' and entity_id = ${successor.id}
    `;
    expect(event).toBeDefined();
  });

  it('holds a supporting document in the package for the whole window', async () => {
    const { documentId, work } = await freshWork('SUPPORT');
    const supporting = randomUUID();
    await admin`
      insert into loa_documents (
        id, organisation_id, object_key, original_filename, sha256, media_type,
        size_bytes, extraction_status, uploaded_by_user_id, document_kind,
        parent_loa_document_id, confirmed_work_id, match_status, identity_match
      )
      values (
        ${supporting}, ${organisationId},
        ${`${organisationId}/source/${supporting}.pdf`}, 'tender-spec.pdf',
        ${createHash('sha256').update(supporting).digest('hex')},
        'application/pdf', 2048, 'confirmed', ${ownerUserId}, 'tender_specification',
        ${documentId}, ${work.id}, 'matched',
        ${admin.json({ letterNumber: 'matched by the seed' })}
      )
    `;

    const filed = await propose(work.id);
    expect((await approve(filed.json<ApprovalRequest>().id)).statusCode).toBe(200);

    // Mid-window the supersede has cleared confirmed_work_id, which is the
    // very column the ordinary discard rule tests — so without the
    // supersession check this would succeed and empty the package out from
    // under the successor.
    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/contract-source-documents/${supporting}/discard`,
      organisationId,
      payload: { reason: 'Attached to the wrong letter.' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'SUPERSEDE_IN_PROGRESS' });

    // Once the successor is confirmed, the ordinary rule applies again —
    // and it refuses for its own reason, the package being a Work's
    // evidence once more.
    await confirmWork(documentId, work.workCode, work.letterNumber);
    const afterwards = await authed(owner, {
      method: 'POST',
      url: `/api/contract-source-documents/${supporting}/discard`,
      organisationId,
      payload: { reason: 'Attached to the wrong letter.' },
    });
    expect(afterwards.statusCode, afterwards.body).toBe(409);
    expect(afterwards.json()).toMatchObject({ code: 'CONTRACT_SOURCE_CONFIRMED' });
  });
});

describe('reading where a Work came from', () => {
  it("answers with the withdrawn Work's identity, reason and date", async () => {
    const { documentId, work } = await freshWork('PROV');
    const filed = await propose(work.id);
    const approvalId = filed.json<ApprovalRequest>().id;
    expect((await approve(approvalId)).statusCode).toBe(200);
    const successor = (await confirmWork(documentId, work.workCode, work.letterNumber))
      .work;

    const provenance = await authed(owner, {
      method: 'GET',
      url: `/api/works/${successor.id}/supersession`,
      organisationId,
    });
    expect(provenance.statusCode, provenance.body).toBe(200);
    expect(
      provenance.json<{ supersession: WorkSupersession }>().supersession,
    ).toMatchObject({
      supersededWorkId: work.id,
      supersededWorkCode: work.workCode,
      supersededLetterNumber: work.letterNumber,
      successorWorkId: successor.id,
      loaDocumentId: documentId,
      approvalRequestId: approvalId,
    });
  });

  it('answers null for a Work that replaced nothing, and 404 across organisations', async () => {
    const { work } = await freshWork('NOPROV');
    const own = await authed(owner, {
      method: 'GET',
      url: `/api/works/${work.id}/supersession`,
      organisationId,
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({ supersession: null });

    const foreign = await authed(outsider, {
      method: 'GET',
      url: `/api/works/${work.id}/supersession`,
      organisationId: outsiderOrganisationId,
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
  });
});

describe('concurrency: a document racing the withdrawal', () => {
  /**
   * AGENTS.md asks for a simultaneous-request test on anything
   * concurrency-sensitive, and this is the shape that matters: the
   * eligibility census is only as good as the lock it runs under. Both
   * orders are exercised, because the answer must be the same either way —
   * exactly one of the two acts succeeds, and the loser is refused rather
   * than leaving an instrument on a withdrawn Work.
   */
  async function race(instrumentFirst: boolean) {
    const { work } = await freshWork(instrumentFirst ? 'RACEA' : 'RACEB');
    const filed = await propose(work.id);
    const approvalId = filed.json<ApprovalRequest>().id;

    const instrument = () =>
      authed(owner, {
        method: 'POST',
        url: `/api/works/${work.id}/instruments`,
        organisationId,
        payload: {
          kind: 'PBG',
          reference: `PBG/${work.workCode}`,
          amount: '100000.00',
          issuedOn: '2026-02-01',
        },
      });
    const supersede = () => approve(approvalId);

    const [first, second] = instrumentFirst
      ? await Promise.all([instrument(), supersede()])
      : await Promise.all([supersede(), instrument()]);
    return { work, first, second };
  }

  it('takes the works row lock every sibling child-creating route takes', async () => {
    // The two-order race below is a STANDING guard: it asserts the
    // invariant but cannot force the interleaving that breaks it, so it
    // passes on the pre-fix tree too. This assertion is the one that
    // bites — the hazard is a read-then-insert with no lock between them,
    // and that is a property of the statement, visible in the source.
    //
    // Without `for update`, an instrument insert and a supersede can both
    // see the Work live: the census finds no instrument, the Work is
    // withdrawn, and the instrument lands on it afterwards.
    const source = await readFile(
      fileURLToPath(new URL('../src/routes/retention.ts', import.meta.url)),
      'utf8',
    );
    const instrumentRoute = source.slice(
      source.indexOf("url: '/api/works/:id/instruments'"),
    );
    const worksRead = instrumentRoute.slice(
      instrumentRoute.indexOf('from works w'),
      instrumentRoute.indexOf('WORK_NOT_FOUND'),
    );
    expect(
      worksRead,
      'POST /api/works/:id/instruments must lock the works row it reads, like ' +
        'every other route that creates a child of a Work — otherwise its ' +
        'read and its insert straddle a concurrent supersede',
    ).toContain('for update of w');
  });

  for (const instrumentFirst of [true, false]) {
    it(`serialises an instrument against the withdrawal (${instrumentFirst ? 'instrument first' : 'supersede first'})`, async () => {
      const { work, first, second } = await race(instrumentFirst);
      const codes = [first.statusCode, second.statusCode];
      // One side wins; the other is refused. Nothing here may 500, and
      // nothing may leave an instrument attached to a withdrawn Work.
      expect(codes.filter((code) => code < 400)).toHaveLength(1);
      expect(codes.every((code) => code < 500)).toBe(true);

      const [withdrawn] = await admin<{ deleted_at: Date | null }[]>`
        select deleted_at from works where id = ${work.id}
      `;
      const instruments = await admin<{ id: string }[]>`
        select id from work_instruments where work_id = ${work.id}
      `;
      if (withdrawn?.deleted_at === null) {
        // The instrument won: the Work is live and carries it.
        expect(instruments).toHaveLength(1);
      } else {
        // The supersede won: the Work is withdrawn and carries nothing,
        // because the census that admitted it held the row lock.
        expect(instruments).toHaveLength(0);
      }
    });
  }
});

describe('the eligibility census', () => {
  /** Every table that reaches `works` through a chain of foreign keys, not
   * only the direct children — a document hanging off an EXEMPT parent
   * would otherwise be invisible to the rule. */
  async function tablesReachingWorks(): Promise<readonly string[]> {
    const rows = await admin<{ table_name: string }[]>`
      with recursive reaches(table_name) as (
        select child.relname::text
        from pg_constraint c
        join pg_class child on child.oid = c.conrelid
        join pg_class parent on parent.oid = c.confrelid
        join pg_namespace n on n.oid = child.relnamespace
        where c.contype = 'f' and parent.relname = 'works'
          and child.relname <> 'works' and n.nspname = 'public'
        union
        select child.relname::text
        from reaches
        join pg_class parent on parent.relname::text = reaches.table_name
        join pg_constraint c on c.confrelid = parent.oid and c.contype = 'f'
        join pg_class child on child.oid = c.conrelid
        join pg_namespace n on n.oid = child.relnamespace
        where child.relname::text <> reaches.table_name
          and child.relname <> 'works' and n.nspname = 'public'
      )
      select distinct table_name from reaches order by table_name
    `;
    return [...new Set(rows.map((row) => row.table_name))];
  }

  it('classifies every table that reaches works, however many hops away', async () => {
    const classified = new Set<string>([
      ...DOWNSTREAM_REGISTERS.map((entry) => entry.register),
      ...Object.keys(WORK_CHILD_TABLES_EXEMPT),
    ]);
    const unclassified = (await tablesReachingWorks()).filter(
      (name) => !classified.has(name),
    );

    expect(
      unclassified,
      'a table that can reach works — directly or through a parent that is itself ' +
        'exempt — must be declared a downstream document or exempt in ' +
        'apps/server/src/work-supersede.ts, and added to migration 0071’s guard ' +
        'if it blocks. A document hanging off an exempt parent is exactly the ' +
        'case a direct-children-only census cannot see.',
    ).toEqual([]);
  });

  it('keeps the migration guard and the server list saying the same thing', async () => {
    const guard = await latestSoftDeleteGuard();
    for (const { register } of DOWNSTREAM_REGISTERS) {
      expect(guard, `${register} must appear in the soft-delete guard`).toContain(
        `FROM ${register} t`,
      );
    }
    // And nothing extra: a table the guard blocks on but the server does
    // not know about would refuse a proposal the eligibility screen called
    // clean.
    const blocked = [...guard.matchAll(/FROM (\w+) t\b/g)].map((match) => match[1]);
    expect([...new Set(blocked)].sort()).toEqual(
      [...DOWNSTREAM_REGISTERS.map((entry) => entry.register)].sort(),
    );
  });

  it('keeps the two censuses saying the same thing about approval requests', async () => {
    // Register names agreeing is not the whole comparison: the one
    // register with a PREDICATE is the one where the two could disagree
    // silently. If the server counted rejected requests and the guard did
    // not, the screen would refuse a supersede the database would allow —
    // or worse, the reverse. Both predicates are read out and compared as
    // normalised text.
    const guard = await latestSoftDeleteGuard();
    const sqlClause =
      /AND t\.entity_type <> 'work_supersede'\s*\n\s*AND t\.status IN \(([^)]*)\)/.exec(
        guard,
      );
    expect(sqlClause, 'the guard must qualify approval_requests').not.toBeNull();

    const source = await readFile(
      fileURLToPath(new URL('../src/work-supersede.ts', import.meta.url)),
      'utf8',
    );
    const tsClause = /entity_type <> 'work_supersede' and status in \(([^)]*)\)/.exec(
      source,
    );
    expect(tsClause, 'the server census must qualify approval_requests').not.toBeNull();

    const statuses = (raw: string): readonly string[] =>
      [...raw.matchAll(/'(\w+)'/g)].map((match) => match[1] as string).sort();
    expect(statuses(sqlClause?.[1] ?? '')).toEqual(statuses(tsClause?.[1] ?? ''));
    expect(statuses(sqlClause?.[1] ?? '')).toEqual(['approved', 'pending']);

    // The second predicated register, held to the same bar: only a
    // LOCKED opening baseline blocks, in both layers (0114 § 9).
    expect(
      guard,
      'the guard must qualify work_billing_baselines to locked rows',
    ).toMatch(/FROM work_billing_baselines t\s[\s\S]*?locked_at IS NOT NULL/);
    expect(
      source,
      'the server census must qualify work_billing_baselines to locked rows',
    ).toContain("'work_billing_baselines'");
    expect(source).toContain('locked_at is not null');
  });
});
