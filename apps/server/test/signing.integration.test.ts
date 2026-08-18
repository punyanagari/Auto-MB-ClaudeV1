import {
  constants,
  createHash,
  privateEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ClaimSigningJobResponse,
  RegisterSigningAgentResponse,
  SigningQueueResponse,
  SigningRequestResponse,
  SubmitSignatureResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import {
  createFileSystemStorage,
  loadTrustAnchors,
  verifyPdfSignatures,
  type TrustAnchorStore,
} from '@auto-mb/documents';
import { buildApp } from '../src/app.js';
import { createTestPki, unsignedPdf, type TestPki } from './helpers/signed-pdf.js';

/**
 * The signing queue, end to end (migration 0091, ADR-0012 lane 2).
 *
 * What is proved here, in the order the module's risks run:
 *
 *   1. the happy path, all the way to a stored PDF the 0060 verifier
 *      reads as `signed_and_intact`, and a queue row that says so;
 *   2. THE BINDING — the reason the digest is stored and re-derived: a
 *      document re-rendered under a pending authorisation is refused,
 *      and the request is failed rather than left looking healthy;
 *   3. the kiosk's own credential walls, which this suite owes standing
 *      tests for because `route-inventory.integration.test.ts` lists the
 *      agent routes as unbound and therefore skips them in its own 401
 *      and 403 sweeps;
 *   4. THE RACE: two kiosks polling one queue, where the claim is the
 *      mutex;
 *   5. the walls a browser caller meets — role, authority, work scope,
 *      and the other organisation;
 *   6. the database's own arm, attacked with raw SQL: a signed request
 *      is evidence and cannot be rewritten.
 *
 * The token is absent, here and in CI, so the one operation it performs
 * is the `DetachedDigestSigner` double described in `pdf-signing.test.ts`.
 * The real-token proof is `tools/kiosk-signing-check.mjs`, run by the
 * owner at the kiosk.
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
const ownerEmail = `sig-owner-${runId}@integration.test`;
const officeEmail = `sig-office-${runId}@integration.test`;
const scopedEmail = `sig-scoped-${runId}@integration.test`;
const outsiderEmail = `sig-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let anchorDir: string;
let anchors: TrustAnchorStore;
let pki: TestPki;
let organisationId: string;
let outsiderOrganisationId: string;
let workId: string;
let privateWorkId: string;
let ownerUserId: string;
let outsiderUserId: string;
let kioskToken: string;
let kioskAgentId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
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

/** A kiosk call: bearer token, no cookie, no organisation header — the
 * organisation is what the token names. */
async function asKiosk(options: InjectOptions & { token?: string | null }) {
  const { token, ...rest } = options;
  const bearer = token === undefined ? kioskToken : token;
  return app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
  });
}

/**
 * An issued challan whose render is a real, signable PDF on disk.
 *
 * Inserted with the admin pool rather than driven through the challan
 * routes: this suite is about what happens to an issued document, not
 * about how it came to be issued, and the Gotenberg stub the challan
 * suite uses answers with a string that is not a PDF at all.
 */
async function seedIssuedChallan(
  text: string,
  options: { readonly work?: string } = {},
): Promise<{ challanId: string; objectKey: string; sha256: string }> {
  const challanId = randomUUID();
  const work = options.work ?? workId;
  const bytes = unsignedPdf(text);
  const objectKey = `${organisationId}/dc/${challanId}.pdf`;
  await createFileSystemStorage(storageDir).put(objectKey, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const [sequence] = await admin<{ next: number }[]>`
    select coalesce(max(sequence_number), 0)::int + 1 as next
    from delivery_challans where organisation_id = ${organisationId}
  `;
  await admin`
    insert into delivery_challans (
      id, organisation_id, work_id, status, challan_date, challan_number,
      sequence_number, prefix, issued_snapshot, issued_at,
      rendered_object_key, rendered_sha256, created_by_user_id, issued_by_user_id
    )
    values (
      ${challanId}, ${organisationId}, ${work}, 'issued', '2026-08-01',
      ${`DC/${runId.toUpperCase()}/${String(sequence?.next ?? 1)}`},
      ${sequence?.next ?? 1}, 'DC', ${admin.json({ text })}, now(),
      ${objectKey}, ${sha256}, ${ownerUserId}, ${ownerUserId}
    )
  `;
  return { challanId, objectKey, sha256 };
}

/** Replaces a challan's render in place, exactly as
 * `POST /api/challans/:id/render` does — the same key, different bytes.
 * This is the event the digest binding exists to catch. */
async function reRender(challanId: string, objectKey: string): Promise<void> {
  const bytes = unsignedPdf('A quietly different challan');
  await createFileSystemStorage(storageDir).put(objectKey, bytes);
  await admin`
    update delivery_challans
    set rendered_sha256 = ${createHash('sha256').update(bytes).digest('hex')}
    where id = ${challanId}
  `;
}

/** The kiosk's one operation, as `RSACng.SignHash(hash, SHA256, Pkcs1)`
 * performs it. See `pdf-signing.test.ts` for why this spelling and not
 * `crypto.sign`. */
function signDigest(digestBase64: string): string {
  const digestInfo = Buffer.concat([
    Buffer.from('3031300d060960864801650304020105000420', 'hex'),
    Buffer.from(digestBase64, 'base64'),
  ]);
  return privateEncrypt(
    { key: pki.signer.privateKey, padding: constants.RSA_PKCS1_PADDING },
    digestInfo,
  ).toString('base64');
}

async function raise(
  challanId: string,
  jar: CookieJar = owner,
  org: string = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: '/api/signing-requests',
    organisationId: org,
    payload: { documentType: 'delivery_challan', documentId: challanId },
  });
}

async function queue(jar: CookieJar = owner, org: string = organisationId) {
  const response = await authed(jar, {
    method: 'GET',
    url: '/api/signing-requests',
    organisationId: org,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SigningQueueResponse>();
}

/** Claim, sign and submit — the kiosk's whole loop, once. */
async function runKiosk(): Promise<SubmitSignatureResponse> {
  const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
  expect(claim.statusCode, claim.body).toBe(200);
  const { job } = claim.json<ClaimSigningJobResponse>();
  if (job === null) throw new Error('the kiosk was offered no job');
  const result = await asKiosk({
    method: 'POST',
    url: `/api/signing/agent/requests/${job.requestId}/result`,
    payload: { signature: signDigest(job.digest) },
  });
  expect(result.statusCode, result.body).toBe(200);
  return result.json<SubmitSignatureResponse>();
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-signing-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  pki = createTestPki({
    signerCommonName: 'A K SHARMA',
    signerOrganisation: 'SIGNING CONSTRUCTIONS',
    serialBase: 8000,
  });
  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-sig-objects-'));
  anchorDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-sig-anchors-'));
  await mkdir(anchorDir, { recursive: true });
  await writeFile(path.join(anchorDir, 'root.pem'), pki.root.pem);
  anchors = await loadTrustAnchors(anchorDir);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    pdfTrustAnchors: anchors,
  });

  owner = await signUp(ownerEmail, 'Signing Owner');
  office = await signUp(officeEmail, 'Signing Office');
  scoped = await signUp(scopedEmail, 'Signing Scoped');
  outsider = await signUp(outsiderEmail, 'Signing Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Signing Constructions', slug: `sig-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Signing Outsiders', slug: `sig-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const email of [officeEmail, scopedEmail]) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role: 'office' },
    });
    expect(added.statusCode, added.body).toBe(201);
  }
  // The office member signs; the scoped member sees only assigned Works
  // and holds no issue authority, which is two walls in one fixture.
  await admin`
    update organisation_memberships set can_issue_documents = true
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${officeEmail})
  `;
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
  ownerUserId = ownerRow.id;
  outsiderUserId = outsiderRow.id;

  for (const [target, code] of [
    ['work', `SIG-${runId.toUpperCase()}`],
    ['private', `SIGP-${runId.toUpperCase()}`],
  ] as const) {
    const id = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${id}, ${organisationId}, ${code}, ${`L-${code}`}, '2026-01-05',
        'Signing fixture work', '10000000.00', '9000000.00', 'per_schedule',
        ${ownerUserId}
      )
    `;
    if (target === 'work') workId = id;
    else privateWorkId = id;
  }

  const registered = await authed(owner, {
    method: 'POST',
    url: '/api/signing-agents',
    organisationId,
    payload: {
      label: 'Cabin kiosk',
      certificateChainPem: [pki.signer.pem, pki.intermediate.pem, pki.root.pem].join(
        '',
      ),
      certificateThumbprint: thumbprintOf(pki.signer.pem),
    },
  });
  expect(registered.statusCode, registered.body).toBe(201);
  const body = registered.json<RegisterSigningAgentResponse>();
  kioskToken = body.token;
  kioskAgentId = body.agent.id;
}, 180_000);

function thumbprintOf(pem: string): string {
  const der = Buffer.from(
    pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replaceAll(/\s+/g, ''),
    'base64',
  );
  return createHash('sha1').update(der).digest('hex').toUpperCase();
}

afterAll(async () => {
  await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
  await admin`
    delete from identity_audit_events where user_id in (
      select "id" from auth_users where "email" like ${`%-${runId}@integration.test`}
    )
  `;
  await admin`
    delete from auth_users where "email" like ${`%-${runId}@integration.test`}
  `;
  await app?.close();
  await admin?.end();
  await rm(storageDir, { recursive: true, force: true });
  await rm(anchorDir, { recursive: true, force: true });
}, 180_000);

describe('registering a kiosk', () => {
  it('returns the token exactly once and never stores it', async () => {
    const [row] = await admin<{ token_hash: string }[]>`
      select token_hash from signing_agents where id = ${kioskAgentId}
    `;
    expect(row?.token_hash).toBe(
      createHash('sha256').update(kioskToken, 'utf8').digest('hex'),
    );
    // The plaintext is nowhere in the table. Asserted over the whole row
    // rather than the one column, because "we did not store it" has to
    // mean no column holds it.
    const [full] = await admin<{ dump: string }[]>`
      select to_jsonb(a)::text as dump from signing_agents a where a.id = ${kioskAgentId}
    `;
    expect(full?.dump).not.toContain(kioskToken);
  });

  it('refuses a chain whose leaf is not the thumbprint given', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/signing-agents',
      organisationId,
      payload: {
        label: 'Mismatched kiosk',
        certificateChainPem: [pki.intermediate.pem, pki.root.pem].join(''),
        certificateThumbprint: thumbprintOf(pki.signer.pem),
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('SIGNING_CERTIFICATE_INVALID');
  });

  it('is owner-only: it hands out a credential', async () => {
    const response = await authed(office, {
      method: 'POST',
      url: '/api/signing-agents',
      organisationId,
      payload: {
        label: 'Office kiosk',
        certificateChainPem: pki.signer.pem,
        certificateThumbprint: thumbprintOf(pki.signer.pem),
      },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('OWNER_REQUIRED');
  });
});

describe('the signing round trip', () => {
  it('signs an issued challan and stores a document the verifier accepts', async () => {
    const challan = await seedIssuedChallan('Delivery challan for signing');
    const raised = await raise(challan.challanId);
    expect(raised.statusCode, raised.body).toBe(201);
    const created = raised.json<SigningRequestResponse>().request;
    expect(created.status).toBe('pending');
    expect(created.sourceSha256).toBe(challan.sha256);
    expect(created.certificateThumbprint).toBe(thumbprintOf(pki.signer.pem));

    const result = await runKiosk();
    expect(result.status).toBe('signed');
    expect(result.signedSha256).not.toBeNull();

    const after = await queue();
    const row = after.requests.find((entry) => entry.id === created.id);
    expect(row?.status).toBe('signed');
    expect(row?.signedSha256).toBe(result.signedSha256);
    expect(row?.signatureVerdict?.status).toBe('signed_and_intact');
    expect(row?.completedAt).not.toBeNull();

    // The bytes, read back from the store and verified independently of
    // whatever the server recorded about them.
    const [stored] = await admin<{ signed_object_key: string }[]>`
      select signed_object_key from signing_requests where id = ${created.id}
    `;
    const key = stored?.signed_object_key ?? '';
    // A NEW key, tenant-prefixed, never the unsigned render's.
    expect(key).not.toBe(challan.objectKey);
    expect(key).toMatch(
      new RegExp(
        `^${organisationId}/sig/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`,
      ),
    );
    const bytes = await createFileSystemStorage(storageDir).get(key);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.signedSha256);
    expect(verifyPdfSignatures(bytes, { trustAnchors: anchors }).status).toBe(
      'signed_and_intact',
    );

    // The unsigned render is untouched: a signed PDF is a new version, not
    // an overwrite.
    const original = await createFileSystemStorage(storageDir).get(challan.objectKey);
    expect(createHash('sha256').update(original).digest('hex')).toBe(challan.sha256);

    // Every transition is on the Work's trail.
    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where entity_type = 'signing_requests' and entity_id = ${created.id}
      order by occurred_at
    `;
    expect(events.map((event) => event.action)).toEqual([
      'signing_request.raised',
      'signing_request.signed',
    ]);
  });

  it('offers nothing when the queue is empty', async () => {
    const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json<ClaimSigningJobResponse>().job).toBeNull();
  });

  it('refuses a second open request against one document', async () => {
    const challan = await seedIssuedChallan('One request only');
    expect((await raise(challan.challanId)).statusCode).toBe(201);
    const second = await raise(challan.challanId);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('SIGNING_REQUEST_OPEN');
    await runKiosk();
  });

  it('refuses a document that is not issued', async () => {
    const draftId = randomUUID();
    await admin`
      insert into delivery_challans (
        id, organisation_id, work_id, status, challan_date, prefix,
        created_by_user_id
      )
      values (
        ${draftId}, ${organisationId}, ${workId}, 'draft', '2026-08-01', 'DC',
        ${ownerUserId}
      )
    `;
    const response = await raise(draftId);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'SIGNING_DOCUMENT_NOT_RENDERED',
    );
  });

  it('withdraws a pending request with its reason', async () => {
    const challan = await seedIssuedChallan('To be withdrawn');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/signing-requests/${created.id}/cancel`,
      organisationId,
      payload: { reason: 'The consignee address was wrong' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const row = cancelled.json<SigningRequestResponse>().request;
    expect(row.status).toBe('cancelled');
    expect(row.failureReason).toBe('The consignee address was wrong');
    // And the queue is free again, which is what a withdrawal is for.
    expect((await raise(challan.challanId)).statusCode).toBe(201);
    await runKiosk();
  });
});

describe('the authorisation is bound to the bytes', () => {
  it('refuses a signature after the document was re-rendered, and fails the request', async () => {
    const challan = await seedIssuedChallan('The reviewed challan');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;

    const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    const { job } = claim.json<ClaimSigningJobResponse>();
    if (job === null) throw new Error('no job offered');

    // The event this whole mechanism exists for: the render route rewrites
    // the same object key while the kiosk holds the authorisation.
    await reRender(challan.challanId, challan.objectKey);

    const result = await asKiosk({
      method: 'POST',
      url: `/api/signing/agent/requests/${job.requestId}/result`,
      payload: { signature: signDigest(job.digest) },
    });
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json<{ code: string }>().code).toBe('SIGNING_SOURCE_CHANGED');

    // Failed, not left claimed: a queue that stops must say why.
    const row = (await queue()).requests.find((entry) => entry.id === created.id);
    expect(row?.status).toBe('failed');
    expect(row?.failureReason).toContain('changed after this signature was authorised');
    expect(row?.signedSha256).toBeNull();
  });

  it('refuses a signature made over some other digest', async () => {
    const challan = await seedIssuedChallan('Signed with the wrong hand');
    (await raise(challan.challanId)).json<SigningRequestResponse>();
    const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    const { job } = claim.json<ClaimSigningJobResponse>();
    if (job === null) throw new Error('no job offered');

    const result = await asKiosk({
      method: 'POST',
      url: `/api/signing/agent/requests/${job.requestId}/result`,
      payload: {
        signature: signDigest(Buffer.alloc(32, 0x5a).toString('base64')),
      },
    });
    // The bytes are right, so the digest check passes; the signature does
    // not verify under the certificate, so the 0060 verifier refuses the
    // output and nothing is stored.
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json<{ code: string }>().code).toBe('SIGNED_OUTPUT_REJECTED');
    const [row] = await admin<{ status: string; signed_object_key: string | null }[]>`
      select status, signed_object_key from signing_requests
      where delivery_challan_id = ${challan.challanId}
    `;
    expect(row?.status).toBe('failed');
    expect(row?.signed_object_key).toBeNull();
  });
});

describe('the kiosk credential', () => {
  it('refuses a request with no token, a malformed header, or an unknown token', async () => {
    for (const token of [
      null,
      '',
      'not-a-token',
      randomBytes(32).toString('base64url'),
    ]) {
      const response = await asKiosk({
        method: 'POST',
        url: '/api/signing/agent/claim',
        token,
      });
      expect(response.statusCode, `token ${String(token)}: ${response.body}`).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('SIGNING_UNAUTHENTICATED');
    }
  });

  it('stops the moment the kiosk is revoked, and fails the work it was holding', async () => {
    const spare = createTestPki({ signerCommonName: 'SPARE SIGNER', serialBase: 9000 });
    const registered = await authed(owner, {
      method: 'POST',
      url: '/api/signing-agents',
      organisationId,
      payload: {
        label: 'Spare kiosk',
        certificateChainPem: [
          spare.signer.pem,
          spare.intermediate.pem,
          spare.root.pem,
        ].join(''),
        certificateThumbprint: thumbprintOf(spare.signer.pem),
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const spareAgent = registered.json<RegisterSigningAgentResponse>();

    // Two live kiosks make the certificate ambiguous, so raising is
    // refused rather than guessing which one an operator meant.
    const challan = await seedIssuedChallan('Two kiosks are one too many');
    const ambiguous = await raise(challan.challanId);
    expect(ambiguous.statusCode, ambiguous.body).toBe(409);
    expect(ambiguous.json<{ code: string }>().code).toBe('SIGNING_KIOSK_UNAVAILABLE');

    const revoked = await authed(owner, {
      method: 'POST',
      url: `/api/signing-agents/${spareAgent.agent.id}/revoke`,
      organisationId,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    // Its credential is dead immediately.
    const afterRevoke = await asKiosk({
      method: 'POST',
      url: '/api/signing/agent/claim',
      token: spareAgent.token,
    });
    expect(afterRevoke.statusCode).toBe(401);

    // …and revoking is one way, at the database as well as the route.
    await expect(
      admin`
        update signing_agents set revoked_at = null, revoked_by_user_id = null
        where id = ${spareAgent.agent.id}
      `,
    ).rejects.toThrow(/cannot be restored/);

    // The original kiosk is unambiguous again.
    expect((await raise(challan.challanId)).statusCode).toBe(201);
    await runKiosk();
  });

  it('cannot see another organisation’s queue', async () => {
    // The outsider's own kiosk, registered in their own organisation.
    const theirs = createTestPki({
      signerCommonName: 'OUTSIDE SIGNER',
      serialBase: 9500,
    });
    const registered = await authed(outsider, {
      method: 'POST',
      url: '/api/signing-agents',
      organisationId: outsiderOrganisationId,
      payload: {
        label: 'Outsider kiosk',
        certificateChainPem: [
          theirs.signer.pem,
          theirs.intermediate.pem,
          theirs.root.pem,
        ].join(''),
        certificateThumbprint: thumbprintOf(theirs.signer.pem),
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const theirToken = registered.json<RegisterSigningAgentResponse>().token;

    const challan = await seedIssuedChallan('Not for the outsider');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;

    // Their kiosk polls and is offered nothing: RLS scopes the claim to
    // their organisation before the agent predicate is even reached.
    const claim = await asKiosk({
      method: 'POST',
      url: '/api/signing/agent/claim',
      token: theirToken,
    });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json<ClaimSigningJobResponse>().job).toBeNull();

    // Nor can they answer for a request they can name.
    const result = await asKiosk({
      method: 'POST',
      url: `/api/signing/agent/requests/${created.id}/result`,
      token: theirToken,
      payload: { failureReason: 'Trying it on' },
    });
    expect(result.statusCode, result.body).toBe(404);
    await runKiosk();
  });

  it('records a failure the operator reported at the PIN dialog', async () => {
    const challan = await seedIssuedChallan('The PIN dialog was cancelled');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    const { job } = claim.json<ClaimSigningJobResponse>();
    if (job === null) throw new Error('no job offered');

    const result = await asKiosk({
      method: 'POST',
      url: `/api/signing/agent/requests/${job.requestId}/result`,
      payload: { failureReason: 'The token PIN dialog was cancelled' },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json<SubmitSignatureResponse>().status).toBe('failed');
    const row = (await queue()).requests.find((entry) => entry.id === created.id);
    expect(row?.failureReason).toBe('The token PIN dialog was cancelled');
  });
});

describe('two kiosks polling one queue', () => {
  it('hands the request to exactly one of them', async () => {
    // Drained first, so what is proved is the mutex and not the depth of
    // the queue an earlier test happened to leave behind.
    for (;;) {
      const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
      const { job } = claim.json<ClaimSigningJobResponse>();
      if (job === null) break;
      await asKiosk({
        method: 'POST',
        url: `/api/signing/agent/requests/${job.requestId}/result`,
        payload: { signature: signDigest(job.digest) },
      });
    }
    const challan = await seedIssuedChallan('Only one of you may have this');
    expect((await raise(challan.challanId)).statusCode).toBe(201);

    const [first, second] = await Promise.all([
      asKiosk({ method: 'POST', url: '/api/signing/agent/claim' }),
      asKiosk({ method: 'POST', url: '/api/signing/agent/claim' }),
    ]);
    const jobs = [first, second]
      .map((response) => response.json<ClaimSigningJobResponse>().job)
      .filter((job) => job !== null);
    expect(jobs).toHaveLength(1);

    const job = jobs[0];
    if (!job) throw new Error('no job was claimed');
    const result = await asKiosk({
      method: 'POST',
      url: `/api/signing/agent/requests/${job.requestId}/result`,
      payload: { signature: signDigest(job.digest) },
    });
    expect(result.statusCode, result.body).toBe(200);
  });
});

describe('the walls a browser caller meets', () => {
  it('refuses a member without the issue authority', async () => {
    const challan = await seedIssuedChallan('Authority required');
    const response = await raise(challan.challanId, scoped);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
  });

  it('hides a Work an assigned-scope member cannot reach', async () => {
    const mine = await seedIssuedChallan('Assigned', { work: workId });
    const theirs = await seedIssuedChallan('Not assigned', { work: privateWorkId });
    expect((await raise(mine.challanId)).statusCode).toBe(201);
    expect((await raise(theirs.challanId)).statusCode).toBe(201);
    await admin`
      insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
      values (
        ${organisationId}, ${workId},
        (select "id" from auth_users where "email" = ${scopedEmail}),
        ${ownerUserId}
      )
      on conflict do nothing
    `;

    const visible = await queue(scoped);
    const codes = new Set(visible.requests.map((entry) => entry.workCode));
    expect(codes.has(`SIG-${runId.toUpperCase()}`)).toBe(true);
    expect(codes.has(`SIGP-${runId.toUpperCase()}`)).toBe(false);

    await runKiosk();
    await runKiosk();
  });

  it('refuses the other organisation outright', async () => {
    const challan = await seedIssuedChallan('Cross-tenant');
    const response = await raise(challan.challanId, outsider, organisationId);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('NOT_A_MEMBER');
    // …and in their OWN organisation the document is simply absent —
    // 404, the same answer a made-up id gets, so a guessed uuid cannot
    // confirm that another tenant's challan exists.
    const inTheirOwn = await raise(challan.challanId, outsider, outsiderOrganisationId);
    expect(inTheirOwn.statusCode, inTheirOwn.body).toBe(404);
    expect(inTheirOwn.json<{ code: string }>().code).toBe('SIGNING_REQUEST_NOT_FOUND');
    const invented = await raise(randomUUID(), outsider, outsiderOrganisationId);
    expect(invented.statusCode).toBe(404);
    expect(invented.json<{ code: string }>().code).toBe('SIGNING_REQUEST_NOT_FOUND');
    expect(outsiderUserId).not.toBe(ownerUserId);
  });
});

describe('the database’s own arm', () => {
  it('refuses to rewrite a signed request, or its authorised facts', async () => {
    const challan = await seedIssuedChallan('Evidence, not a draft');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    await runKiosk();

    // Terminal is terminal, even for a writer holding the owner role and
    // raw SQL.
    await expect(
      admin`
        update signing_requests set failure_reason = 'rewritten'
        where id = ${created.id}
      `,
    ).rejects.toThrow(/already signed and cannot change again/);

    // And the authorisation is frozen on a live row too.
    const pending = await seedIssuedChallan('Frozen while pending');
    const live = (await raise(pending.challanId)).json<SigningRequestResponse>()
      .request;
    await expect(
      admin`
        update signing_requests set authorised_digest = ${'e'.repeat(64)}
        where id = ${live.id}
      `,
    ).rejects.toThrow(/written once and never change/);
    await runKiosk();
  });

  it('refuses a state that skips the kiosk', async () => {
    const challan = await seedIssuedChallan('No shortcuts');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    await expect(
      admin`
        update signing_requests
        set status = 'signed', completed_at = now(),
            signed_object_key = ${`${organisationId}/sig/${randomUUID()}.pdf`},
            signed_sha256 = ${'f'.repeat(64)},
            signature_status = 'signed_and_intact', signature_verified_at = now()
        where id = ${created.id}
      `,
    ).rejects.toThrow(/cannot move from pending to signed/);
    await runKiosk();
  });
});
