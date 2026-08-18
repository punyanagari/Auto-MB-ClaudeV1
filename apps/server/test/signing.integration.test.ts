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
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
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
 * The real-token proof is `tools/kiosk-signing-check.ps1`, run by the
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
  // The office member holds BOTH authorities, which is what makes the
  // negative control below meaningful: the scoped member is given
  // `can_issue_documents` and NOT `can_sign_documents`, so a refusal there
  // proves the signing authority is doing the work rather than issue
  // standing in for it.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_sign_documents = true
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${officeEmail})
  `;
  await admin`
    update organisation_memberships set can_issue_documents = true
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${scopedEmail})
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
    // Tenant-prefixed, in its own storage area, and a server-minted uuid:
    // the three things `assertSafeObjectKey` holds a key to on the way in.
    expect(key.startsWith(`${organisationId}/sig/`)).toBe(true);
    expect(key.slice(`${organisationId}/sig/`.length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/,
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

  it('revokes a kiosk that is HOLDING a pending request, and the revocation sticks', async () => {
    // THE CASE THE TEST ABOVE DOES NOT COVER, and the one that was broken:
    // there, the spare kiosk held nothing, because raising against it had
    // been refused for two-kiosk ambiguity. Here the kiosk being revoked
    // is the only one, so it owns a real pending request — and the
    // revocation and the request's failure are ONE transaction. With
    // `pending -> failed` missing from the state machine the bulk update
    // raised 23J01, the whole transaction rolled back, and the kiosk
    // stayed live: a credential that could not be revoked because it had
    // work queued, which is exactly when revoking matters.
    const challan = await seedIssuedChallan('Held when the kiosk was revoked');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    expect(created.status).toBe('pending');

    const revoked = await authed(owner, {
      method: 'POST',
      url: `/api/signing-agents/${kioskAgentId}/revoke`,
      organisationId,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    // The revocation is real and committed…
    const [agentRow] = await admin<{ revoked_at: Date | null }[]>`
      select revoked_at from signing_agents where id = ${kioskAgentId}
    `;
    expect(agentRow?.revoked_at).not.toBeNull();

    // …the credential is dead…
    const afterRevoke = await asKiosk({
      method: 'POST',
      url: '/api/signing/agent/claim',
    });
    expect(afterRevoke.statusCode).toBe(401);

    // …and the request it was holding says why it will never move.
    const [row] = await admin<{ status: string; failure_reason: string | null }[]>`
      select status, failure_reason from signing_requests where id = ${created.id}
    `;
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toContain('revoked');

    // Re-register for the tests that follow: this suite shares one kiosk.
    const replacement = await authed(owner, {
      method: 'POST',
      url: '/api/signing-agents',
      organisationId,
      payload: {
        label: 'Cabin kiosk (replacement)',
        certificateChainPem: [pki.signer.pem, pki.intermediate.pem, pki.root.pem].join(
          '',
        ),
        certificateThumbprint: thumbprintOf(pki.signer.pem),
      },
    });
    expect(replacement.statusCode, replacement.body).toBe(201);
    const body = replacement.json<RegisterSigningAgentResponse>();
    kioskToken = body.token;
    kioskAgentId = body.agent.id;
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

/**
 * A kiosk that dies mid-signature used to wedge its document forever: the
 * claim query skipped the row, cancel refused a non-pending one, the
 * partial unique index refused any replacement request, and past the
 * expiry even a failure report was refused. Every door out is tested here.
 */
describe('a claim whose lease lapsed', () => {
  /**
   * Ages a request past its lease.
   *
   * `expires_at` is one of the authorised facts the guard freezes, and
   * the guard is right to — it is inside the signed preparation's own
   * contract. That leaves no way to simulate a week passing except to
   * turn the trigger off around the edit, which is what migration 0043
   * does for its one-time reclassification and is the same posture: the
   * guard is disabled for exactly one statement, by the owner role, and
   * turned back on in a `finally` so a failing assertion cannot leave it
   * off for the rest of the suite.
   *
   * The guard being in the way here is itself worth noticing — it is the
   * reason a production operator cannot extend a lease either, and why
   * the exit is "withdraw and raise again" rather than "give it longer".
   */
  async function lapse(requestId: string): Promise<void> {
    await admin`ALTER TABLE signing_requests DISABLE TRIGGER signing_requests_guard`;
    try {
      await admin`
        update signing_requests set expires_at = now() - interval '1 minute'
        where id = ${requestId}
      `;
    } finally {
      await admin`ALTER TABLE signing_requests ENABLE TRIGGER signing_requests_guard`;
    }
  }

  /** Claims and completes everything already queued, so each test below
   * reasons about ONE request. The suite shares a queue, and "the kiosk
   * was offered nothing" is an assertion several of these make. */
  async function drain(): Promise<void> {
    for (;;) {
      const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
      const { job } = claim.json<ClaimSigningJobResponse>();
      if (job === null) return;
      await asKiosk({
        method: 'POST',
        url: `/api/signing/agent/requests/${job.requestId}/result`,
        payload: { signature: signDigest(job.digest) },
      });
    }
  }

  async function claimOne(expected: string): Promise<string> {
    const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    expect(claim.statusCode, claim.body).toBe(200);
    const { job } = claim.json<ClaimSigningJobResponse>();
    if (job === null) throw new Error('no job offered');
    expect(job.requestId).toBe(expected);
    return job.requestId;
  }

  it('lets the operator withdraw it — door one', async () => {
    await drain();
    const challan = await seedIssuedChallan('Abandoned at the kiosk');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    await claimOne(created.id);

    // While the lease is live the request belongs to the kiosk.
    const early = await authed(owner, {
      method: 'POST',
      url: `/api/signing-requests/${created.id}/cancel`,
      organisationId,
      payload: { reason: 'Too soon' },
    });
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json<{ message: string }>().message).toContain('lease lapses');

    await lapse(created.id);
    const late = await authed(owner, {
      method: 'POST',
      url: `/api/signing-requests/${created.id}/cancel`,
      organisationId,
      payload: { reason: 'The kiosk never came back' },
    });
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json<SigningRequestResponse>().request.status).toBe('cancelled');

    // The document is free again, which is the whole point.
    expect((await raise(challan.challanId)).statusCode).toBe(201);
    await runKiosk();
  });

  it('is offered to the kiosk again — door two', async () => {
    await drain();
    const challan = await seedIssuedChallan('The kiosk restarted');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    await claimOne(created.id);

    // Live: nothing more to claim.
    const whileLive = await asKiosk({
      method: 'POST',
      url: '/api/signing/agent/claim',
    });
    expect(whileLive.json<ClaimSigningJobResponse>().job).toBeNull();

    await lapse(created.id);
    const again = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<ClaimSigningJobResponse>().job?.requestId).toBe(created.id);

    // Clear it before the second half, so what follows is the only thing
    // the queue holds.
    await authed(owner, {
      method: 'POST',
      url: `/api/signing-requests/${created.id}/cancel`,
      organisationId,
      payload: { reason: 'Fixture cleanup' },
    });

    // A LAPSED PENDING REQUEST IS NOT RE-OFFERED — the asymmetry is
    // deliberate. Nobody picked it up, so its authorisation expired the
    // way ADR-0012 intends and it must be raised again; there is no
    // abandoned lease to recover, which is the only thing re-offering is
    // for.
    const untouched = await seedIssuedChallan('Never picked up');
    const stale = (await raise(untouched.challanId)).json<SigningRequestResponse>()
      .request;
    await lapse(stale.id);
    const offered = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    expect(offered.json<ClaimSigningJobResponse>().job).toBeNull();

    await authed(owner, {
      method: 'POST',
      url: `/api/signing-requests/${stale.id}/cancel`,
      organisationId,
      payload: { reason: 'Fixture cleanup' },
    });
  });

  it('accepts a failure report but never a signature — door three', async () => {
    await drain();
    const challan = await seedIssuedChallan('Lapsed under the PIN dialog');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    const { job } = claim.json<ClaimSigningJobResponse>();
    if (job === null) throw new Error('no job offered');
    await lapse(created.id);

    // A SIGNATURE IS REFUSED: the digest was derived a week ago and the
    // authorisation is spent. Terminal, so a kiosk that retries cannot
    // re-wedge the row it was just re-offered.
    const signature = await asKiosk({
      method: 'POST',
      url: `/api/signing/agent/requests/${job.requestId}/result`,
      payload: { signature: signDigest(job.digest) },
    });
    expect(signature.statusCode, signature.body).toBe(409);
    expect(signature.json<{ code: string }>().code).toBe('SIGNING_REQUEST_EXPIRED');
    const [afterSignature] = await admin<{ status: string }[]>`
      select status from signing_requests where id = ${created.id}
    `;
    expect(afterSignature?.status).toBe('failed');

    // A FAILURE REPORT IS ACCEPTED even past the lease, on a fresh one:
    // a kiosk saying "I could not do this" is the cheapest way a row ever
    // terminates, and refusing it is what left the wedge.
    const second = await seedIssuedChallan('Reported late');
    const later = (await raise(second.challanId)).json<SigningRequestResponse>()
      .request;
    const secondClaim = await asKiosk({
      method: 'POST',
      url: '/api/signing/agent/claim',
    });
    const secondJob = secondClaim.json<ClaimSigningJobResponse>().job;
    if (secondJob === null) throw new Error('no job offered');
    await lapse(later.id);
    const reported = await asKiosk({
      method: 'POST',
      url: `/api/signing/agent/requests/${secondJob.requestId}/result`,
      payload: { failureReason: 'The token was unplugged overnight' },
    });
    expect(reported.statusCode, reported.body).toBe(200);
    expect(reported.json<SubmitSignatureResponse>().status).toBe('failed');
  });
});

describe('the document has to still be a document', () => {
  it('refuses a signature after the challan was cancelled', async () => {
    // The digest binding does NOT catch this: cancelling a challan
    // changes no bytes, so the preparation re-derives identically. Only
    // the status re-check stands between a withdrawn document and the
    // organisation's certificate.
    const challan = await seedIssuedChallan('Cancelled under the kiosk');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    const { job } = claim.json<ClaimSigningJobResponse>();
    if (job === null) throw new Error('no job offered');

    await admin`
      update delivery_challans
      set status = 'cancelled', cancellation_note = 'Wrong consignee',
          cancelled_at = now(), cancelled_by_user_id = ${ownerUserId}
      where id = ${challan.challanId}
    `;

    const result = await asKiosk({
      method: 'POST',
      url: `/api/signing/agent/requests/${job.requestId}/result`,
      payload: { signature: signDigest(job.digest) },
    });
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json<{ code: string }>().code).toBe('SIGNING_DOCUMENT_NOT_RENDERED');
    const [row] = await admin<{ status: string; failure_reason: string | null }[]>`
      select status, failure_reason from signing_requests where id = ${created.id}
    `;
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toContain('left its issued state');
  });
});

describe('the Origin guard, and the hole it must not become', () => {
  /**
   * The CSRF guard refuses any mutation without an exact-match `Origin`,
   * and PowerShell sends none — so with `trustedOrigins` configured (which
   * is production, and only production) the whole kiosk lane was dead, and
   * dead SILENTLY: the agent reads a 403 as a transport blip and backs off.
   *
   * Both directions are proved here, because an exemption that is too wide
   * is worse than the bug it fixes.
   */
  let guarded: FastifyInstance;

  beforeAll(async () => {
    guarded = await buildApp({
      databaseUrl: appUrl,
      authSecret: `integration-secret-${'0'.repeat(32)}`,
      baseUrl: 'http://127.0.0.1:3000',
      objectStorageDir: storageDir,
      pdfTrustAnchors: anchors,
      trustedOrigins: ['https://app.example.test'],
    });
  }, 120_000);

  afterAll(async () => {
    await guarded?.close();
  }, 60_000);

  it('lets the kiosk poll with no Origin header at all', async () => {
    const response = await guarded.inject({
      method: 'POST',
      url: '/api/signing/agent/claim',
      headers: { authorization: `Bearer ${kioskToken}` },
    });
    // 200 with or without a job — what matters is that it is not the
    // guard's 403.
    expect(response.statusCode, response.body).toBe(200);
  });

  it('still refuses a cookie-authenticated mutation with no Origin', async () => {
    // The exemption must not have widened into "mutations may skip the
    // guard". Same server, same missing header, a session-authenticated
    // route: still 403.
    const response = await guarded.inject({
      method: 'POST',
      url: '/api/signing-requests',
      headers: { cookie: owner.cookie, 'x-organisation-id': organisationId },
      payload: { documentType: 'delivery_challan', documentId: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('ORIGIN_FORBIDDEN');
  });

  it('refuses an unauthenticated kiosk call even though the guard let it past', async () => {
    // The exemption removes CSRF, not authentication. A caller with no
    // bearer token gets the credential wall, not a free pass.
    const response = await guarded.inject({
      method: 'POST',
      url: '/api/signing/agent/claim',
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('SIGNING_UNAUTHENTICATED');
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
  it('refuses a member who holds issue but not the signing authority', async () => {
    // THE NEGATIVE CONTROL for the owner's 2026-08-18 ruling. The scoped
    // member CAN issue documents; what they cannot do is put one in front
    // of a signer. If `issue` were still the gate this would pass.
    const challan = await seedIssuedChallan('Authority required');
    const response = await raise(challan.challanId, scoped);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
    expect(response.json<{ message: string }>().message).toContain('signing authority');
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

  it('refuses a second signature against a request already signed', async () => {
    // The double-submit: a kiosk that retries after a response it did not
    // see. The row is terminal, so the second attempt finds nothing at
    // the kiosk rather than producing a second signed copy.
    const challan = await seedIssuedChallan('Submitted twice');
    (await raise(challan.challanId)).json<SigningRequestResponse>();
    const claim = await asKiosk({ method: 'POST', url: '/api/signing/agent/claim' });
    const { job } = claim.json<ClaimSigningJobResponse>();
    if (job === null) throw new Error('no job offered');
    const body = { signature: signDigest(job.digest) };
    const url = `/api/signing/agent/requests/${job.requestId}/result`;

    const first = await asKiosk({ method: 'POST', url, payload: body });
    expect(first.statusCode, first.body).toBe(200);
    const second = await asKiosk({ method: 'POST', url, payload: body });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('SIGNING_REQUEST_STATE');

    // One request, one signed copy, and the copy is the FIRST attempt's.
    const rows = await admin<{ status: string; signed_sha256: string | null }[]>`
      select status, signed_sha256 from signing_requests
      where delivery_challan_id = ${challan.challanId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('signed');
    expect(rows[0]?.signed_sha256).toBe(
      first.json<SubmitSignatureResponse>().signedSha256,
    );
  });

  it('refuses to withdraw a request that is already signed', async () => {
    const challan = await seedIssuedChallan('Signed, then withdrawn');
    const created = (await raise(challan.challanId)).json<SigningRequestResponse>()
      .request;
    await runKiosk();
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/signing-requests/${created.id}/cancel`,
      organisationId,
      payload: { reason: 'Second thoughts' },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('SIGNING_REQUEST_STATE');
  });

  it('refuses a certificate chain too large for the signature reservation', async () => {
    // M2's pre-flight, at the route. Discovering this AFTER a token has
    // signed is a 500 with a real signature and nowhere to put it, so the
    // question is asked once, when the kiosk registers.
    //
    // The chain is padded with enough certificates to overflow the
    // 8192-byte reservation; the leaf is still the real signer, so the
    // thumbprint check passes and this is the only thing that can refuse.
    const bulky = createTestPki({
      signerCommonName: 'BULKY SIGNER',
      serialBase: 11_000,
    });
    const filler = Array.from({ length: 12 }, (_, index) =>
      createTestPki({ serialBase: 12_000 + index * 10 }),
    );
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/signing-agents',
      organisationId,
      payload: {
        label: 'Overstuffed kiosk',
        certificateChainPem: [
          bulky.signer.pem,
          bulky.intermediate.pem,
          bulky.root.pem,
          ...filler.flatMap((extra) => [extra.intermediate.pem, extra.root.pem]),
        ].join(''),
        certificateThumbprint: thumbprintOf(bulky.signer.pem),
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('SIGNING_CERTIFICATE_INVALID');
    expect(response.json<{ message: string }>().message).toContain('too large');
    // Thirteen key pairs to build one over-sized chain, which is the
    // cost of proving the refusal against real certificates rather than
    // a padded string. Comfortable locally, over the 5s default on a
    // loaded runner: budgeted like the other slow integration tests
    // rather than made faster with fake bytes the parser would reject.
  }, 30_000);

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
