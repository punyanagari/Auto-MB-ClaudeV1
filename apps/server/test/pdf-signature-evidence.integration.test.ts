import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { LoaDocumentDetail } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  createDatabasePool,
  ensureClusterRoles,
  jsonb,
  runMigrations,
} from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import { createFileSystemStorage, loadTrustAnchors } from '@auto-mb/documents';
import { runQueuedJobs } from './helpers/worker-jobs.js';
import {
  appendSignature,
  createTestPki,
  unsignedPdf,
  type TestPki,
} from './helpers/signed-pdf.js';

/**
 * The verdict as stored EVIDENCE: written with the document it describes,
 * readable back through the API, carried into the organisation export, and
 * append-once at the database.
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
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let workspace: string;
let storageDir: string;
let organisationId: string;
let cookie: string;
let pki: TestPki;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

function authed(options: InjectOptions & { organisationId?: string }) {
  const { organisationId: org, ...rest } = options;
  return app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      cookie,
      ...(org !== undefined ? { 'x-organisation-id': org } : {}),
    },
  });
}

async function upload(bytes: Buffer, filename: string) {
  return authed({
    method: 'POST',
    url: `/api/loa-documents?filename=${encodeURIComponent(filename)}`,
    organisationId,
    headers: { 'content-type': 'application/pdf', origin: 'http://127.0.0.1:3000' },
    payload: bytes,
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-signature-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the signature-evidence integration tests. ' +
        `Underlying error: ${String(error)}`,
    );
  }
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  workspace = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-sig-int-'));
  storageDir = path.join(workspace, 'objects');
  await mkdir(storageDir, { recursive: true });

  pki = createTestPki({
    signerCommonName: 'R K MEENA',
    signerOrganisation: 'CENTRAL RAILWAY',
  });
  const anchorDir = path.join(workspace, 'anchors');
  await mkdir(anchorDir, { recursive: true });
  await writeFile(path.join(anchorDir, 'root.pem'), pki.root.pem);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    pdfTrustAnchors: await loadTrustAnchors(anchorDir),
  });
  await app.ready();

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: ownerEmail, password, name: 'Signature Owner' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  cookie = extractCookies(signUp.headers['set-cookie']);

  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'Signature Org', slug: `sig-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await rm(workspace, { recursive: true, force: true });
});

/**
 * Uploads a letter and then runs the reading the upload enqueued.
 *
 * Since pack P18 the verdict is not in the upload response: the route
 * accepts the bytes and the worker verifies them, so the document is born
 * `not_checked` and reaches a real verdict a job later. Every assertion
 * below is about the verdict that is finally STORED, which is what it was
 * always about — only the moment it exists has moved.
 */
async function uploadAndVerify(
  bytes: Buffer,
  filename: string,
): Promise<LoaDocumentDetail> {
  const response = await upload(bytes, filename);
  expect(response.statusCode, response.body).toBe(201);
  const accepted = response.json<LoaDocumentDetail>();
  expect(accepted.signatureStatus).toBe('not_checked');

  await runQueuedJobs(
    admin,
    createFileSystemStorage(storageDir),
    await loadTrustAnchors(path.join(workspace, 'anchors')),
  );

  const detail = await authed({
    method: 'GET',
    url: `/api/loa-documents/${accepted.id}`,
    organisationId,
  });
  expect(detail.statusCode, detail.body).toBe(200);
  return detail.json<LoaDocumentDetail>();
}

describe('signature verdicts are stored with the document', () => {
  it('records a trusted verdict at upload time and returns it', async () => {
    const bytes = appendSignature(unsignedPdf('Letter of Acceptance 11 of 22-23'), {
      pki,
      reason: 'Variation Signing By SSE/Tele',
    });
    const detail = await uploadAndVerify(bytes, 'signed-loa.pdf');

    expect(detail.signatureStatus).toBe('signed_and_intact');
    expect(detail.signatureVerdict?.signatures).toHaveLength(1);
    expect(detail.signatureVerdict?.signatures[0]?.signer.commonName).toBe('R K MEENA');
    expect(detail.signatureVerdict?.signatures[0]?.chain.status).toBe('trusted');

    const [row] = await admin<
      {
        signature_status: string;
        signature_verdict: unknown;
        signature_verified_at: Date;
      }[]
    >`
      select signature_status, signature_verdict, signature_verified_at
      from loa_documents where id = ${detail.id}
    `;
    expect(row?.signature_status).toBe('signed_and_intact');
    expect(row?.signature_verdict).not.toBeNull();
    expect(row?.signature_verified_at).toBeInstanceOf(Date);

    // The list shape carries the status too, so a register can show which
    // intake documents need a human without opening each of them.
    const list = await authed({
      method: 'GET',
      url: '/api/loa-documents',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    const listed = list
      .json<{ documents: { id: string; signatureStatus: string }[] }>()
      .documents.find((entry) => entry.id === detail.id);
    expect(listed?.signatureStatus).toBe('signed_and_intact');
  });

  it('records an unsigned upload as unsigned, and accepts it', async () => {
    const detail = await uploadAndVerify(
      unsignedPdf('Letter of Acceptance with no signature'),
      'plain-loa.pdf',
    );
    // Nothing is gated on the verdict in this change: an unsigned letter
    // is still the letter the organisation was sent, and turning a bad
    // verdict into a refusal is the owner's decision per document type.
    expect(detail.signatureStatus).toBe('unsigned');
    expect(detail.signatureVerdict?.signatureCount).toBe(0);
  });

  it('records a document appended to after signing, without refusing it', async () => {
    const signed = appendSignature(unsignedPdf('Letter appended after signing'), {
      pki,
    });
    const tampered = Buffer.concat([
      signed,
      Buffer.from('\n% added later\n', 'latin1'),
    ]);
    const detail = await uploadAndVerify(tampered, 'appended-loa.pdf');
    expect(detail.signatureStatus).toBe('signed_but_modified_after_signing');
    expect(detail.signatureVerdict?.unsignedTrailingBytes).toBe(15);
    expect(detail.signatureVerdict?.signatures[0]?.integrity).toBe('intact');
  });

  it('refuses to rewrite a stored verdict', async () => {
    const bytes = appendSignature(unsignedPdf('Letter whose verdict is evidence'), {
      pki,
    });
    const detail = await uploadAndVerify(bytes, 'append-once.pdf');
    expect(detail.signatureStatus).toBe('signed_and_intact');

    // Straight at the database, with the owning role — the guard is not a
    // route check. Editing an inconvenient verdict away while the bytes it
    // describes stay identical is the one thing evidence must not permit.
    await expect(
      admin`
        update loa_documents set signature_status = 'unsigned'
        where id = ${detail.id}
      `,
    ).rejects.toThrow(/append-once/);

    await expect(
      admin`
        update loa_documents set signature_verdict = ${jsonb(admin, { status: 'unsigned' })}
        where id = ${detail.id}
      `,
    ).rejects.toThrow(/append-once/);

    await expect(
      admin`
        update loa_documents set signature_verified_at = now()
        where id = ${detail.id}
      `,
    ).rejects.toThrow(/append-once/);

    const [after] = await admin<{ signature_status: string }[]>`
      select signature_status from loa_documents where id = ${detail.id}
    `;
    expect(after?.signature_status).toBe('signed_and_intact');
  });

  it('allows a row that predates verification to be verified once', async () => {
    // The single permitted transition: not_checked to a real verdict, so a
    // row from before migration 0060 can be verified without re-uploading.
    // Simulated exactly as the migration leaves such a row.
    const [fresh] = await admin<{ id: string; signature_status: string }[]>`
      insert into loa_documents (
        organisation_id, object_key, original_filename, sha256, media_type,
        size_bytes, extraction_status, uploaded_by_user_id
      )
      values (
        ${organisationId}, ${`${organisationId}/loa/${crypto.randomUUID()}.pdf`},
        'pre-0060.pdf', ${randomBytes(32).toString('hex')}, 'application/pdf', 100,
        'review', 'seed-user'
      )
      returning id, signature_status
    `;
    expect(fresh?.signature_status).toBe('not_checked');
    const id = fresh?.id ?? '';

    await admin`
      update loa_documents
      set signature_status = 'unsigned',
          signature_verdict = ${jsonb(admin, { status: 'unsigned' })},
          signature_verified_at = now()
      where id = ${id}
    `;
    const [verified] = await admin<{ signature_status: string }[]>`
      select signature_status from loa_documents where id = ${id}
    `;
    expect(verified?.signature_status).toBe('unsigned');

    // ...and exactly once. The second write is refused like any other.
    await expect(
      admin`
        update loa_documents set signature_status = 'signed_and_intact'
        where id = ${id}
      `,
    ).rejects.toThrow(/append-once/);
  });

  it('refuses a verdict with no evidence behind it', async () => {
    // The shape CHECK: a status other than not_checked must carry both a
    // verdict object and the instant it was computed.
    await expect(
      admin`
        insert into loa_documents (
          organisation_id, object_key, original_filename, sha256, media_type,
          size_bytes, extraction_status, uploaded_by_user_id, signature_status
        )
        values (
          ${organisationId}, ${`${organisationId}/loa/${crypto.randomUUID()}.pdf`},
          'claim-without-evidence.pdf', ${'c'.repeat(64)}, 'application/pdf', 100,
          'review', 'seed-user', 'signed_and_intact'
        )
      `,
    ).rejects.toThrow(/signature_shape_check/);
  });

  it('carries the verdict into the organisation export', async () => {
    const bytes = appendSignature(unsignedPdf('Exported letter'), { pki });
    const detail = await uploadAndVerify(bytes, 'exported.pdf');

    const exported = await authed({
      method: 'GET',
      url: '/api/export',
      organisationId,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const body = exported.json<{
      formatVersion: string;
      loaDocuments: {
        id: string;
        signature_status: string;
        signature_verdict: { status: string } | null;
      }[];
    }>();
    expect(body.formatVersion).toBe('export-v12');
    const document = body.loaDocuments.find((entry) => entry.id === detail.id);
    // The export is the incident procedure's evidence snapshot; a document
    // exported without the verdict relied on when it was accepted is
    // missing the part that says whether it was authentic.
    expect(document?.signature_status).toBe('signed_and_intact');
    expect(document?.signature_verdict?.status).toBe('signed_and_intact');
  });
});
