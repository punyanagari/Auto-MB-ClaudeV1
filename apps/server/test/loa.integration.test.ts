import { createHash, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ConfirmWorkRequest,
  ContractSourceContext,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, jsonb, runMigrations } from '@auto-mb/db';
import {
  loadCorpus,
  loadLetter,
  resolveCanonicalUnitCode,
  reviewLoaLetter,
  type CorpusLetter,
  type LoaReviewPayload,
} from '@auto-mb/loa-parser';
import { buildApp } from '../src/app.js';

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
const ownerEmail = `loa-owner-${runId}@integration.test`;
const viewerEmail = `loa-viewer-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let scanningApp: FastifyInstance;
let clamd: net.Server;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
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

/** A minimal but structurally valid single-page PDF whose text layer is
 * exactly `text`, with a correct xref table — enough for pdftotext to
 * extract it without repair heuristics. ASCII input only. */
function buildTestPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    4: `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 1; index <= 5; index += 1) {
    offsets[index] = pdf.length;
    pdf += `${String(index)} 0 obj\n${objects[index] ?? ''}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let index = 1; index <= 5; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** A text-layer PDF with one positioned text object per input line.
 * Supporting-document identity and clause extraction is line-sensitive, so
 * this fixture preserves the same line boundaries pdftotext sees in real
 * searchable tender documents. */
function buildMultilineTestPdf(lines: readonly string[]): Buffer {
  const escape = (line: string) =>
    line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const commands = lines
    .map((line, index) =>
      index === 0
        ? `BT /F1 9 Tf 48 748 Td (${escape(line)}) Tj`
        : `0 -14 Td (${escape(line)}) Tj`,
    )
    .join('\n');
  const content = `${commands}\nET`;
  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    4: `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 1; index <= 5; index += 1) {
    offsets[index] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${String(index)} 0 obj\n${objects[index] ?? ''}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let index = 1; index <= 5; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Reduces a printed decimal to the contracts' DecimalString shape:
 * thousands separators dropped, bounded fraction, no leading zeros. The
 * '1' fallback stands in for a reviewer-corrected value on rows whose
 * printed figure did not parse (none in the six-letter corpus). */
function normaliseDecimal(raw: string, maxDp: number): string {
  const cleaned = raw.replaceAll(',', '').trim();
  const dotParts = cleaned.split('.');
  const [intRaw, fracRaw] = dotParts;
  const digits = /^\d+$/;
  if (
    dotParts.length > 2 ||
    intRaw === undefined ||
    !digits.test(intRaw) ||
    (fracRaw !== undefined && !digits.test(fracRaw))
  ) {
    return '1';
  }
  const intPart = String(BigInt(intRaw));
  const frac = (fracRaw ?? '').slice(0, maxDp).replace(/0+$/, '');
  const value = frac.length > 0 ? `${intPart}.${frac}` : intPart;
  return value === '0' ? '1' : value;
}

/** The performance-guarantee requirement the letter demands, exactly as
 * the parser read it. The extracted-value lock refuses a confirmation that
 * drops a readable clause, so this is what a reviewer actually submits. */
function buildPbgRequirement(
  payload: LoaReviewPayload,
): ConfirmWorkRequest['pbgRequirement'] {
  const clause = payload.header.performanceGuarantee;
  if (
    clause.needsReview ||
    clause.amountFigures === null ||
    clause.submissionDays === null
  ) {
    return undefined;
  }
  return {
    requiredAmount: clause.amountFigures.toFixed(2),
    submissionDays: clause.submissionDays,
    ...(clause.extensionDays !== null ? { extensionDays: clause.extensionDays } : {}),
    ...(clause.penalInterestPercent !== null
      ? { penalInterestPercent: String(clause.penalInterestPercent) }
      : {}),
  };
}

/** Builds the confirm request a reviewer would submit for a corpus letter:
 * parsed values where the parser found them, manifest ground truth as the
 * reviewer's correction where it did not. Every item carries a sourceRef
 * back into the extraction payload. */
function buildConfirmRequest(
  letter: CorpusLetter,
  payload: LoaReviewPayload,
): ConfirmWorkRequest {
  const manifest = letter.manifest;
  const shape = manifest.pricing_shape === 'A' ? 'letter_percentage' : 'per_schedule';

  const groups = new Map<string, LoaReviewPayload['items'][number][]>();
  for (const item of payload.items) {
    const scheduleId = item.schedule?.id ?? 'UNBOUND';
    const list = groups.get(scheduleId) ?? [];
    list.push(item);
    groups.set(scheduleId, list);
  }

  const letterDate = payload.header.letterDate.value;
  const title = payload.header.workDescription.value ?? manifest.id;
  const pbgRequirement = buildPbgRequirement(payload);
  return {
    workCode: manifest.id,
    letterNumber: payload.header.letterNumber.value ?? manifest.id,
    letterDate:
      letterDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(letterDate)
        ? letterDate
        : '2025-01-01',
    title: title.length >= 3 ? title.slice(0, 1000) : manifest.id,
    advertisedValue: manifest.advertised_value.toFixed(2),
    contractValue: manifest.net_bid_value.toFixed(2),
    pricingShape: shape,
    ...(shape === 'letter_percentage'
      ? {
          letterPercentage: manifest.letter_percentage
            ? manifest.letter_percentage.value.toFixed(3)
            : '0',
          letterPercentageDirection: manifest.letter_percentage
            ? (manifest.letter_percentage.direction.toLowerCase() as 'below' | 'above')
            : ('at_par' as const),
        }
      : {}),
    ...(pbgRequirement !== undefined ? { pbgRequirement } : {}),
    schedules: [...groups.entries()].map(([scheduleId, items]) => ({
      scheduleCode: scheduleId,
      title: `Schedule ${scheduleId}`,
      items: items.map((item) => ({
        itemNumber: `${scheduleId}/${item.itemSno}`,
        description:
          item.description.trim().length >= 3
            ? item.description
            : `Item ${item.itemSno}`,
        unitCode: resolveCanonicalUnitCode(item.qtyUnit) ?? 'UNIT',
        awardedQuantity: normaliseDecimal(item.qty, 3),
        effectiveRate: normaliseDecimal(item.unitRate, 2),
        sourceRef: { scheduleId, itemSno: item.itemSno },
      })),
    })),
  };
}

async function seedReviewDocument(letter: CorpusLetter): Promise<string> {
  const payload = { sourceText: letter.text, review: reviewLoaLetter(letter.text) };
  const documentId = randomUUID();
  const sha256 = createHash('sha256').update(letter.text).digest('hex');
  await admin`
    insert into loa_documents (
      id, organisation_id, object_key, original_filename, sha256, media_type,
      size_bytes, extraction_status, extraction_payload, uploaded_by_user_id
    )
    values (
      ${documentId}, ${organisationId},
      ${`${organisationId}/loa/${documentId}.pdf`},
      ${`${letter.manifest.id}.pdf`}, ${sha256}, 'application/pdf',
      ${Buffer.byteLength(letter.text)}, 'review',
      ${jsonb(admin, payload)}, ${ownerUserId}
    )
  `;
  return documentId;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-loa-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the LOA integration tests. ' +
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  // A second app instance with scanning enabled against a stub clamd,
  // sharing the same database (and therefore the same sessions).
  clamd = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (data) => chunks.push(data));
    socket.on('end', () => {
      const infected = Buffer.concat(chunks).includes('EICAR-TEST-MARKER');
      socket.end(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
    });
  });
  await new Promise<void>((resolve) => {
    clamd.listen(0, '127.0.0.1', resolve);
  });
  const clamdAddress = clamd.address();
  if (clamdAddress === null || typeof clamdAddress === 'string') {
    throw new Error('stub clamd failed to bind');
  }
  scanningApp = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    clamav: { host: '127.0.0.1', port: clamdAddress.port },
  });

  owner = await signUp(ownerEmail, 'LOA Owner');
  viewer = await signUp(viewerEmail, 'LOA Viewer');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'LOA Constructions', slug: `loa-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing after sign-up');
  ownerUserId = ownerUser.id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: viewerEmail, role: 'viewer' },
  });
  expect(added.statusCode, added.body).toBe(201);
}, 60_000);

afterAll(async () => {
  if (admin) {
    if (organisationId) {
      for (const table of [
        'audit_events',
        'payment_matrices',
        'work_items',
        'work_schedules',
        'loa_documents',
        'works',
        'gst_rates',
        'organisation_memberships',
        'organisations',
      ]) {
        await admin.unsafe(
          `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
          [organisationId],
        );
      }
    }
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
  await scanningApp?.close();
  await admin?.end();
  if (clamd) {
    await new Promise<void>((resolve) => {
      clamd.close(() => {
        resolve();
      });
    });
  }
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('LOA upload and extraction', () => {
  it('uploads a PDF, extracts its text, and lands it in review', async () => {
    const pdf = buildTestPdf('Auto-MB extraction smoke line');
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/loa-documents?filename=smoke.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: pdf,
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<{
      id: string;
      extractionStatus: string;
      sha256: string;
      extractionPayload: {
        sourceText: string;
        rawSourceText: string;
        review: { items: unknown[] };
      };
    }>();
    expect(body.extractionStatus).toBe('review');
    expect(body.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(body.extractionPayload.sourceText).toContain(
      'Auto-MB extraction smoke line',
    );
    expect(body.extractionPayload.rawSourceText).toContain(
      'Auto-MB extraction smoke line',
    );

    // The original object is stored under the tenant-prefixed key.
    const stored = await readFile(
      path.join(storageDir, organisationId, 'loa', `${body.id}.pdf`),
    );
    expect(stored.equals(pdf)).toBe(true);

    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${body.id}
    `;
    expect(events.map((event) => event.action)).toContain('loa.uploaded');

    const list = await authed(owner, {
      method: 'GET',
      url: '/api/loa-documents',
      organisationId,
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ documents: { id: string }[] }>().documents.map((d) => d.id),
    ).toContain(body.id);
  });

  it('rejects non-PDF bytes despite a PDF content type', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/loa-documents?filename=junk.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('this is not a pdf at all'),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'NOT_A_PDF' });
  });

  it('refuses uploads from viewers', async () => {
    const response = await authed(viewer, {
      method: 'POST',
      url: '/api/loa-documents?filename=viewer.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: buildTestPdf('viewer upload'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });
});

describe('review and confirm across the legacy corpus', () => {
  // The Milestone 2 exit criterion: every one of the six legacy LOA
  // fixtures can be reviewed and confirmed without losing source evidence.
  const corpus = loadCorpus();

  it.each(corpus.map((letter) => [letter.manifest.id, letter] as const))(
    'confirms %s into a Work with full source evidence',
    async (_id, letter) => {
      const documentId = await seedReviewDocument(letter);
      const payload = reviewLoaLetter(letter.text);
      const request = buildConfirmRequest(letter, payload);

      const response = await authed(owner, {
        method: 'POST',
        url: `/api/loa-documents/${documentId}/confirm`,
        organisationId,
        payload: request,
      });
      expect(response.statusCode, response.body).toBe(201);
      const detail = response.json<WorkDetailResponse>();

      expect(detail.schedules).toHaveLength(letter.manifest.schedule_count);
      const itemCount = detail.schedules.reduce(
        (total, schedule) => total + schedule.items.length,
        0,
      );
      expect(itemCount).toBe(letter.manifest.item_count);
      expect(detail.work.contractValue).toBe(letter.manifest.net_bid_value.toFixed(2));

      // Confirming must not lose the source: payload retained verbatim,
      // document linked to the created Work.
      const [document] = await admin<
        {
          extraction_status: string;
          confirmed_work_id: string | null;
          extraction_payload: unknown;
        }[]
      >`
        select extraction_status, confirmed_work_id, extraction_payload
        from loa_documents where id = ${documentId}
      `;
      expect(document?.extraction_status).toBe('confirmed');
      expect(document?.confirmed_work_id).toBe(detail.work.id);
      const retained = document?.extraction_payload as {
        sourceText: string;
        review: { items: unknown[] };
      };
      expect(retained.sourceText).toBe(letter.text);
      expect(retained.review.items).toHaveLength(letter.manifest.item_count);

      // Every created item carries resolved parser evidence.
      const [evidence] = await admin<{ unresolved: string }[]>`
        select count(*) filter (
          where source_evidence->>'resolved' is distinct from 'true'
        )::text as unresolved
        from work_items where work_id = ${detail.work.id}
      `;
      expect(evidence?.unresolved).toBe('0');

      const fetched = await authed(owner, {
        method: 'GET',
        url: `/api/works/${detail.work.id}`,
        organisationId,
      });
      expect(fetched.statusCode).toBe(200);
      expect(
        fetched
          .json<WorkDetailResponse>()
          .schedules.reduce((total, s) => total + s.items.length, 0),
      ).toBe(letter.manifest.item_count);
    },
    30_000,
  );

  it('refuses to confirm the same document twice', async () => {
    const [confirmedDoc] = await admin<{ id: string }[]>`
      select id from loa_documents
      where organisation_id = ${organisationId} and extraction_status = 'confirmed'
      limit 1
    `;
    expect(confirmedDoc).toBeDefined();
    const letter = corpus[0];
    if (!letter || !confirmedDoc) throw new Error('missing corpus/fixture doc');
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${confirmedDoc.id}/confirm`,
      organisationId,
      payload: {
        ...buildConfirmRequest(letter, reviewLoaLetter(letter.text)),
        workCode: 'REPEAT-1',
        letterNumber: `repeat-${runId}`,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'DOCUMENT_NOT_REVIEWABLE' });
  });

  it('refuses confirmation from viewers', async () => {
    const letter = corpus[0];
    if (!letter) throw new Error('empty corpus');
    const documentId = await seedReviewDocument(letter);
    const response = await authed(viewer, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: {
        ...buildConfirmRequest(letter, reviewLoaLetter(letter.text)),
        workCode: 'VIEWER-DENIED-1',
        letterNumber: `viewer-denied-${runId}`,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });

  it('lists confirmed Works for members and keeps the audit trail', async () => {
    const list = await authed(viewer, {
      method: 'GET',
      url: '/api/works',
      organisationId,
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ works: { workCode: string }[] }>().works.length,
    ).toBeGreaterThanOrEqual(corpus.length);

    const events = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and action = 'work.created'
    `;
    expect(events.length).toBeGreaterThanOrEqual(corpus.length);
  });
});

/**
 * The extracted-value lock (owner ruling, 2026-08-13). The review screen
 * renders locked values as read-only text, but the screen is not the
 * control: these tests drive the confirm route directly, the way any other
 * client could, and prove the refusal lives on the server.
 *
 * Each case seeds its own document from a real corpus letter with one
 * edit to the STORED parse — a unique letter number, because
 * `works.letter_number` is unique forever and the corpus letters are
 * already confirmed above. Everything else, including the values under
 * test, is what the parser actually read.
 */
describe('the LOA extracted-value lock', () => {
  interface LockCase {
    readonly documentId: string;
    readonly request: ConfirmWorkRequest;
    readonly workCode: string;
  }

  let lockSequence = 0;

  /** Seeds one review document whose stored parse is the letter's own,
   * and the confirm request a reviewer would submit against it. */
  async function seedLockCase(letterId: string): Promise<LockCase> {
    lockSequence += 1;
    const letter = loadLetter(letterId);
    const parsed = reviewLoaLetter(letter.text);
    const letterNumber = `LOCK-${String(lockSequence)}-${runId}`;
    const review: LoaReviewPayload = {
      ...parsed,
      header: {
        ...parsed.header,
        letterNumber: { ...parsed.header.letterNumber, value: letterNumber },
      },
    };
    const documentId = randomUUID();
    await admin`
      insert into loa_documents (
        id, organisation_id, object_key, original_filename, sha256, media_type,
        size_bytes, extraction_status, extraction_payload, uploaded_by_user_id
      )
      values (
        ${documentId}, ${organisationId},
        ${`${organisationId}/loa/${documentId}.pdf`},
        ${`${letterId}-lock-${String(lockSequence)}.pdf`},
        ${createHash('sha256').update(documentId).digest('hex')},
        'application/pdf', ${Buffer.byteLength(letter.text)}, 'review',
        ${jsonb(admin, { sourceText: letter.text, review })}, ${ownerUserId}
      )
    `;
    const workCode = `LK${String(lockSequence)}${runId}`.toUpperCase().slice(0, 20);
    return {
      documentId,
      workCode,
      request: { ...buildConfirmRequest(letter, review), workCode, letterNumber },
    };
  }

  async function confirmLock(lockCase: LockCase, request: ConfirmWorkRequest) {
    return authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${lockCase.documentId}/confirm`,
      organisationId,
      payload: request,
    });
  }

  /** Every refusal must also be a no-op: no Work, and the document still
   * waiting for review rather than burned. */
  async function expectNothingSaved(lockCase: LockCase): Promise<void> {
    const works = await admin<{ id: string }[]>`
      select id from works
      where organisation_id = ${organisationId} and work_code = ${lockCase.workCode}
    `;
    expect(works).toHaveLength(0);
    const [document] = await admin<{ extraction_status: string }[]>`
      select extraction_status from loa_documents where id = ${lockCase.documentId}
    `;
    expect(document?.extraction_status).toBe('review');
  }

  it('confirms a payload that matches the stored parse, and audits the verdict', async () => {
    // PL270-CRB parses without a single review flag, so this is the lock
    // at its strictest: 129 rows of extracted truth, all held.
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, lockCase.request);
    expect(response.statusCode, response.body).toBe(201);
    const workId = response.json<WorkDetailResponse>().work.id;

    const [event] = await admin<{ details: Record<string, unknown> }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'work.created' and entity_id = ${workId}
    `;
    const lock = event?.details['extractedValueLock'] as
      | {
          lockedFieldsVerified: number;
          letterHolesFilled: string[];
          itemHolesFilled: number;
          manualRows: number;
          parsedRowsOmitted: number;
        }
      | undefined;
    expect(lock).toBeDefined();
    // Three header fields, both totals figures, the pricing shape and four
    // PBG values, plus a unit, quantity and rate on every one of the 129
    // rows — all verified against the letter rather than trusted.
    expect(lock?.lockedFieldsVerified).toBe(10 + 129 * 3);
    // The holes the parser itself declared: a per-schedule letter prints no
    // percentage, and without the PDF's reading order no description
    // boundary is exact.
    expect(lock?.letterHolesFilled).toContain('letterPercentage');
    expect(lock?.letterHolesFilled).toContain('letterPercentageDirection');
    expect(lock?.itemHolesFilled).toBe(129);
    expect(lock?.manualRows).toBe(0);
    expect(lock?.parsedRowsOmitted).toBe(0);
  }, 30_000);

  /* --- the GST basis (migration 0062) -------------------------------- */

  it('defaults the GST basis to inclusive at 18% when the payload omits it', async () => {
    // The common case, and the one an older client sends. PL270-CRB is an
    // inclusive letter (the corpus records the evidence), so the default
    // is also the right answer here.
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, lockCase.request);
    expect(response.statusCode, response.body).toBe(201);
    const work = response.json<WorkDetailResponse>().work;
    expect(work.gstBasis).toBe('inclusive');
    expect(work.gstRate).toBe('18.00');

    const [row] = await admin<{ gst_basis: string; gst_rate: string }[]>`
      select gst_basis, gst_rate::text as gst_rate from works where id = ${work.id}
    `;
    expect(row?.gst_basis).toBe('inclusive');
    expect(row?.gst_rate).toBe('18.00');
  }, 30_000);

  /* --- the accepted rate (ruling 1, migration 0063) ------------------ */

  it('stores the ACCEPTED rate, not the advertised one the letter prints', async () => {
    // PL270-CRB is a per-schedule letter; Schedule A was won at 14.35%
    // below par. The letter's item table prints advertised rates, and the
    // railway's own bill prints the agreement rate this must reproduce:
    // 2,490,000.00 x 0.8565 = 2,132,685.00 exactly.
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, lockCase.request);
    expect(response.statusCode, response.body).toBe(201);
    const workId = response.json<WorkDetailResponse>().work.id;

    const rows = await admin<
      {
        item_number: string;
        advertised_rate: string;
        effective_rate: string;
        accepted_percentage: string;
        accepted_percentage_direction: string;
      }[]
    >`
      select i.item_number,
             i.advertised_rate::text as advertised_rate,
             i.effective_rate::text as effective_rate,
             s.accepted_percentage::text as accepted_percentage,
             s.accepted_percentage_direction
      from work_items i
      join work_schedules s on s.id = i.schedule_id
      where i.work_id = ${workId}
      order by s.position, i.item_number
    `;
    expect(rows.length).toBe(129);

    const first = rows[0];
    expect(first?.accepted_percentage).toBe('14.350');
    expect(first?.accepted_percentage_direction).toBe('below');
    // The printed rate is kept...
    expect(Number(first?.advertised_rate)).toBe(2490000);
    // ...and the stored rate is the one the railway pays.
    expect(Number(first?.effective_rate)).toBe(2132685);

    // Every row moved, and none kept the advertised figure by accident.
    for (const row of rows) {
      expect(Number(row.effective_rate)).toBeLessThan(Number(row.advertised_rate));
    }
  }, 30_000);

  it('bills the Work to its own contract value, not its advertised value', async () => {
    // The end-to-end statement of the fix: sum(qty x rate) used to come to
    // the letter's ADVERTISED value (195,574,112.38) and now comes to its
    // Net Bid Value (169,228,497.35) — the figure the Work's own
    // contract_value carries.
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, lockCase.request);
    expect(response.statusCode, response.body).toBe(201);
    const workId = response.json<WorkDetailResponse>().work.id;

    const [sums] = await admin<
      { accepted: string; advertised: string; contract_value: string }[]
    >`
      select sum(i.awarded_quantity * i.effective_rate)::numeric(18,2)::text
               as accepted,
             sum(i.awarded_quantity * i.advertised_rate)::numeric(18,2)::text
               as advertised,
             (select w.contract_value::text from works w where w.id = ${workId})
               as contract_value
      from work_items i
      where i.work_id = ${workId}
    `;
    // Within a rupee: each of the 129 rates is rounded to the rate
    // column's six places before it is multiplied out.
    expect(
      Math.abs(Number(sums?.accepted) - Number(sums?.contract_value)),
    ).toBeLessThan(1);
    expect(Number(sums?.advertised)).toBeCloseTo(195574112.38, 2);
    // And the two are a long way apart, which is the defect this closes.
    expect(Number(sums?.advertised) - Number(sums?.accepted)).toBeGreaterThan(
      26_000_000,
    );
  }, 30_000);

  it('records an EXCLUSIVE letter when the reviewer says so', async () => {
    // The rare case the attribute exists for. It is accepted as a value,
    // not refused as a modification: the parser asserts nothing about GST,
    // so there is no extracted truth here to contradict.
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      gstBasis: 'exclusive',
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<WorkDetailResponse>().work.gstBasis).toBe('exclusive');
  }, 30_000);

  it('audits the basis and whether a human stated it', async () => {
    // The basis appears in no document, so this audit row is the only
    // evidence of which way the question was answered if a Work's
    // execution percentage is ever disputed.
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      gstBasis: 'exclusive',
    });
    expect(response.statusCode, response.body).toBe(201);
    const workId = response.json<WorkDetailResponse>().work.id;
    const [event] = await admin<{ details: Record<string, unknown> }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'work.created' and entity_id = ${workId}
    `;
    expect(event?.details['gst']).toEqual({
      basis: 'exclusive',
      rate: '18.00',
      stated: true,
    });
    // And the lock records it as a hole the reviewer filled — never as a
    // locked field, on any letter, because no parse asserts it.
    const lock = event?.details['extractedValueLock'] as
      { letterHolesFilled: string[] } | undefined;
    expect(lock?.letterHolesFilled).toContain('gstBasis');
  }, 30_000);

  it('refuses a GST rate the organisation has not notified on the letter date', async () => {
    // Same master and same refusal every other tax-bearing document uses,
    // asked as of the LETTER date rather than today: the basis is a fact
    // about rates quoted in a letter signed then.
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      gstRate: '17.00',
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('GST_RATE_NOT_NOTIFIED');
    await expectNothingSaved(lockCase);
  }, 30_000);

  it('refuses a changed letter date, naming the field and both values', async () => {
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      letterDate: '2026-01-02',
    });
    expect(response.statusCode, response.body).toBe(400);
    const body = response.json<{
      code: string;
      message: string;
      details: { field: string; extracted: string; submitted: string };
    }>();
    expect(body.code).toBe('LOA_EXTRACTED_VALUE_MODIFIED');
    expect(body.details.field).toBe('letterDate');
    expect(body.details.extracted).toBe('"2026-01-01"');
    expect(body.details.submitted).toBe('"2026-01-02"');
    // The remedy is named, because under this ruling there is only one.
    expect(body.message).toContain('discard this LOA document');
    await expectNothingSaved(lockCase);
  }, 30_000);

  it('refuses a changed accepted value', async () => {
    const lockCase = await seedLockCase('PL270-CRB');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      contractValue: '1.00',
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ details: { field: string } }>().details.field).toBe(
      'contractValue',
    );
    await expectNothingSaved(lockCase);
  }, 30_000);

  it('refuses a changed above/below percentage — the ruling’s own example', async () => {
    // PL280-ADI prints 0.5% below par.
    const lockCase = await seedLockCase('PL280-ADI');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      letterPercentage: '1.000',
    });
    expect(response.statusCode, response.body).toBe(400);
    const details = response.json<{
      details: { field: string; extracted: string };
    }>().details;
    expect(details.field).toBe('letterPercentage');
    expect(details.extracted).toBe('"0.5"');
    await expectNothingSaved(lockCase);
  }, 30_000);

  it('refuses a changed item quantity and rate', async () => {
    for (const [field, patch] of [
      ['item A#01.awardedQuantity', { awardedQuantity: '7' }],
      ['item A#01.effectiveRate', { effectiveRate: '2490001.00' }],
      ['item A#01.unitCode', { unitCode: 'PAIR' }],
    ] as const) {
      const lockCase = await seedLockCase('PL270-CRB');
      const [first, ...rest] = lockCase.request.schedules;
      if (first === undefined) throw new Error('no schedules parsed');
      const [firstItem, ...otherItems] = first.items;
      if (firstItem === undefined) throw new Error('no items parsed');
      const response = await confirmLock(lockCase, {
        ...lockCase.request,
        schedules: [
          { ...first, items: [{ ...firstItem, ...patch }, ...otherItems] },
          ...rest,
        ],
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ details: { field: string } }>().details.field).toBe(field);
      await expectNothingSaved(lockCase);
    }
  }, 60_000);

  it('refuses dropping the performance guarantee the letter demands', async () => {
    const lockCase = await seedLockCase('PL270-CRB');
    const { pbgRequirement: _dropped, ...withoutPbg } = lockCase.request;
    const response = await confirmLock(lockCase, withoutPbg);
    expect(response.statusCode, response.body).toBe(400);
    const details = response.json<{
      details: { field: string; submitted: string };
    }>().details;
    expect(details.field).toBe('pbgRequirement');
    expect(details.submitted).toBe('nothing');
    await expectNothingSaved(lockCase);
  }, 30_000);

  it('accepts a unit for the row the parser flagged as unresolved', async () => {
    // PL276-GTL's RKM row (B1#13) is the corpus's only `unresolved_unit`:
    // the printed spelling resolves to no canonical unit, so the parser
    // asks the question and the reviewer answers it.
    const lockCase = await seedLockCase('PL276-GTL');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      schedules: lockCase.request.schedules.map((schedule) => ({
        ...schedule,
        items: schedule.items.map((item) =>
          item.sourceRef?.scheduleId === 'B1' && item.sourceRef.itemSno === '13'
            ? { ...item, unitCode: 'ROUTE_KILOMETRE' }
            : item,
        ),
      })),
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<WorkDetailResponse>();
    const filled = detail.schedules
      .flatMap((schedule) => schedule.items)
      .find((item) => item.itemNumber === 'B1/13');
    expect(filled?.unitCode).toBe('ROUTE_KILOMETRE');
  }, 30_000);

  it('still refuses a changed unit on an unflagged row of the same letter', async () => {
    const lockCase = await seedLockCase('PL276-GTL');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      schedules: lockCase.request.schedules.map((schedule) => ({
        ...schedule,
        items: schedule.items.map((item) =>
          item.sourceRef?.scheduleId === 'A1' && item.sourceRef.itemSno === '1'
            ? { ...item, unitCode: 'KILOMETRE' }
            : item,
        ),
      })),
    });
    expect(response.statusCode, response.body).toBe(400);
    const details = response.json<{
      details: { field: string; extracted: string };
    }>().details;
    expect(details.field).toBe('item A1#1.unitCode');
    expect(details.extracted).toBe('"Metre"');
    await expectNothingSaved(lockCase);
  }, 30_000);

  it('accepts a row the reviewer adds, and keeps it marked manual', async () => {
    const lockCase = await seedLockCase('PL270-CRB');
    const [first, ...rest] = lockCase.request.schedules;
    if (first === undefined) throw new Error('no schedules parsed');
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      schedules: [
        {
          ...first,
          items: [
            ...first.items,
            {
              itemNumber: 'A/MANUAL-1',
              description: 'Row the letter prints but the parser did not read',
              unitCode: 'NUMBERS',
              awardedQuantity: '2',
              effectiveRate: '1000.00',
              manualEntry: true,
            },
          ],
        },
        ...rest,
      ],
    });
    expect(response.statusCode, response.body).toBe(201);
    const workId = response.json<WorkDetailResponse>().work.id;
    const [manual] = await admin<{ manual_entry: boolean }[]>`
      select (source_evidence->>'manualEntry')::boolean as manual_entry
      from work_items
      where work_id = ${workId} and item_number = 'A/MANUAL-1'
    `;
    expect(manual?.manual_entry).toBe(true);
    const [event] = await admin<{ details: Record<string, unknown> }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'work.created' and entity_id = ${workId}
    `;
    expect(
      (event?.details['extractedValueLock'] as { manualRows: number } | undefined)
        ?.manualRows,
    ).toBe(1);
  }, 30_000);

  it('leaves a performance-guarantee clause the parser flagged to the reviewer', async () => {
    // PL281-BB's clause parses with `needsReview: true`; nothing about it
    // is verified truth, so the reviewer establishes all of it — including
    // whether the letter demands one at all.
    const lockCase = await seedLockCase('PL281-BB');
    expect(lockCase.request.pbgRequirement).toBeUndefined();
    const response = await confirmLock(lockCase, {
      ...lockCase.request,
      pbgRequirement: { requiredAmount: '7376797.39', submissionDays: 30 },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<WorkDetailResponse>().work.pbgSubmissionDays).toBe(30);
  }, 30_000);
});

describe('matched tender and contract-source package', () => {
  async function seedParentLoa(): Promise<string> {
    const id = randomUUID();
    const payload = {
      sourceText: 'synthetic parent identity',
      review: {
        header: {
          tenderNumber: { value: 'NCR-SNT-2026-0042' },
          workDescription: {
            value:
              'Supply installation and commissioning of IP MPLS equipment at Jhansi division',
          },
        },
      },
    };
    await admin`
      insert into loa_documents (
        id, organisation_id, object_key, original_filename, sha256,
        media_type, size_bytes, extraction_status, extraction_payload,
        uploaded_by_user_id
      )
      values (
        ${id}, ${organisationId}, ${`${organisationId}/loa/${id}.pdf`},
        'matched-parent-loa.pdf', ${createHash('sha256').update(id).digest('hex')},
        'application/pdf', 1, 'review', ${jsonb(admin, payload)}, ${ownerUserId}
      )
    `;
    return id;
  }

  function matchingTenderPdf(): Buffer {
    return buildMultilineTestPdf([
      'Tender No.: NCR-SNT-2026-0042',
      'Name of Work: Supply installation and commissioning of IP MPLS equipment at Jhansi division',
      'Payment terms Supply and Installation category:',
      '60% on supply, 25% on successful installation, 10% on issue of PAC and 5% on final acceptance.',
      'Warranty period: 36 months for Item ITM-001 from commissioning.',
      'Maintenance period: 5 years for the complete work after warranty.',
      'The Performance Bank Guarantee PBG shall be released after final acceptance and expiry of warranty obligations.',
      'The Security Deposit shall be returned after issue of the completion certificate and settlement of dues.',
      'Item ITM-001 technical specification: Router shall conform to TEC GR No TEC-GR-TX-IPM-001 and support MPLS-TE.',
    ]);
  }

  function matchingWrappedTenderPdf(): Buffer {
    return buildMultilineTestPdf([
      'Tender No.: NCR-SNT-2026-0042',
      'Name of Work: Supply installation and',
      'commissioning of IP MPLS equipment at',
      'Jhansi division',
      'Tender Document Cost: Rs. 0.00',
    ]);
  }

  it('accepts only a matching source, extracts the tender context and records the immutable relationship', async () => {
    const parentId = await seedParentLoa();
    const upload = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/contract-sources?kind=tender_specification&filename=tender-spec.pdf`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: matchingTenderPdf(),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const response = upload.json<{ context: ContractSourceContext }>();
    expect(response.context.documents).toHaveLength(1);
    expect(response.context.paymentMatrix[0]).toMatchObject({
      category: 'SUPPLY_AND_INSTALLATION',
      pctSupply: '60',
      pctInstallation: '25',
      pctPac: '10',
      pctFinalBill: '5',
    });
    expect(response.context.periods.map((period) => period.kind).sort()).toEqual([
      'maintenance',
      'warranty',
    ]);
    expect(response.context.releaseClauses.map((clause) => clause.kind).sort()).toEqual(
      ['pbg', 'security_deposit'],
    );
    expect(response.context.itemSpecifications[0]?.itemReferences).toContain('ITM-001');

    const [stored] = await admin<
      {
        document_kind: string;
        parent_loa_document_id: string;
        match_status: string;
      }[]
    >`
      select document_kind, parent_loa_document_id, match_status
      from loa_documents
      where parent_loa_document_id = ${parentId}
    `;
    expect(stored).toEqual({
      document_kind: 'tender_specification',
      parent_loa_document_id: parentId,
      match_status: 'matched',
    });
  });

  it('accepts a matching name of work wrapped across PDF lines', async () => {
    const parentId = await seedParentLoa();
    const upload = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/contract-sources?kind=nit&filename=wrapped-nit.pdf`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: matchingWrappedTenderPdf(),
    });

    expect(upload.statusCode, upload.body).toBe(201);
    expect(
      upload.json<{
        document: {
          identityMatch: {
            extractedWorkDescription: string;
            workDescriptionMatched: boolean;
          };
        };
      }>().document.identityMatch,
    ).toMatchObject({
      extractedWorkDescription:
        'Supply installation and commissioning of IP MPLS equipment at Jhansi division',
      workDescriptionMatched: true,
    });
  });

  it('rejects a foreign tender before object metadata is stored and audits only the refusal', async () => {
    const parentId = await seedParentLoa();
    const foreign = buildMultilineTestPdf([
      'Tender No.: FOREIGN-009',
      'Name of Work: Construction of a station building at Agra',
      'Payment terms: 80% on supply and 20% on installation.',
    ]);
    const sha = createHash('sha256').update(foreign).digest('hex');
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/contract-sources?kind=nit&filename=foreign.pdf`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: foreign,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'CONTRACT_SOURCE_IDENTITY_MISMATCH',
      details: {
        matched: false,
        tenderNumberMatched: false,
        workDescriptionMatched: false,
      },
    });
    const [stored] = await admin<{ count: string }[]>`
      select count(*)::text as count from loa_documents
      where organisation_id = ${organisationId} and sha256 = ${sha}
    `;
    expect(stored?.count).toBe('0');
    const [audit] = await admin<{ count: string }[]>`
      select count(*)::text as count from audit_events
      where organisation_id = ${organisationId}
        and action = 'contract_source.rejected'
        and entity_id = ${parentId}
    `;
    expect(audit?.count).toBe('1');
  });

  it('confirms the reviewer-entered initial matrix atomically and links supporting evidence to the Work', async () => {
    const parentId = await seedParentLoa();
    const upload = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/contract-sources?kind=tender_specification&filename=tender-spec-confirm.pdf`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: matchingTenderPdf(),
    });
    expect(upload.statusCode, upload.body).toBe(201);

    const confirm = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/confirm`,
      organisationId,
      payload: {
        workCode: `TENDER-${runId}`.toUpperCase().slice(0, 20),
        letterNumber: `LOA-TENDER-${runId}`,
        letterDate: '2025-01-01',
        title:
          'Supply installation and commissioning of IP MPLS equipment at Jhansi division',
        advertisedValue: '100000',
        contractValue: '90000',
        pricingShape: 'per_schedule',
        paymentMatrix: [
          {
            category: 'SUPPLY_AND_INSTALLATION',
            pctSupply: '55',
            pctInstallation: '30',
            pctPac: '10',
            pctFinalBill: '5',
          },
        ],
        schedules: [
          {
            scheduleCode: 'A',
            title: 'Schedule A',
            items: [
              {
                itemNumber: 'ITM-001',
                description: 'IP MPLS edge router',
                unitCode: 'NOS',
                awardedQuantity: '10',
                effectiveRate: '9000',
                paymentCategory: 'SUPPLY_AND_INSTALLATION',
                manualEntry: true,
              },
            ],
          },
        ],
      } satisfies ConfirmWorkRequest,
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    const work = confirm.json<WorkDetailResponse>().work;

    const [matrix] = await admin<
      {
        pct_supply: string;
        pct_installation: string;
        pct_pac: string;
        pct_final_bill: string;
      }[]
    >`
      select pct_supply::text, pct_installation::text, pct_pac::text,
             pct_final_bill::text
      from payment_matrices where work_id = ${work.id}
    `;
    expect(matrix).toEqual({
      pct_supply: '55.00',
      pct_installation: '30.00',
      pct_pac: '10.00',
      pct_final_bill: '5.00',
    });
    const [linked] = await admin<{ confirmed_work_id: string }[]>`
      select confirmed_work_id from loa_documents
      where parent_loa_document_id = ${parentId}
    `;
    expect(linked?.confirmed_work_id).toBe(work.id);

    const context = await authed(viewer, {
      method: 'GET',
      url: `/api/works/${work.id}/contract-source-context`,
      organisationId,
    });
    expect(context.statusCode, context.body).toBe(200);
    expect(
      context.json<ContractSourceContext>().itemSpecifications[0]?.mappedWorkItemIds,
    ).toHaveLength(1);
  });

  it('refuses malformed initial payment rows without creating the Work', async () => {
    const parentId = await seedParentLoa();
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/confirm`,
      organisationId,
      payload: {
        workCode: `BADMAT-${runId}`.toUpperCase().slice(0, 20),
        letterNumber: `LOA-BAD-MATRIX-${runId}`,
        letterDate: '2025-01-01',
        title:
          'Supply installation and commissioning of IP MPLS equipment at Jhansi division',
        advertisedValue: '1000',
        contractValue: '1000',
        pricingShape: 'per_schedule',
        paymentMatrix: [
          {
            category: 'SUPPLY',
            pctSupply: '80',
            pctInstallation: '10',
            pctPac: '5',
            pctFinalBill: '4',
          },
        ],
        schedules: [
          {
            scheduleCode: 'A',
            title: 'Schedule A',
            items: [
              {
                itemNumber: 'ITM-001',
                description: 'Test item',
                unitCode: 'NOS',
                awardedQuantity: '1',
                effectiveRate: '1000',
                manualEntry: true,
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: 'PAYMENT_MATRIX_SUM_INVALID' });
    const [work] = await admin<{ count: string }[]>`
      select count(*)::text as count from works
      where organisation_id = ${organisationId}
        and letter_number = ${`LOA-BAD-MATRIX-${runId}`}
    `;
    expect(work?.count).toBe('0');
  });
});

describe('upload malware scanning (Milestone 4)', () => {
  it('rejects a flagged upload before anything is stored and accepts clean ones', async () => {
    const flagged = buildTestPdf('EICAR-TEST-MARKER inside');
    const rejected = await scanningApp.inject({
      method: 'POST',
      url: '/api/loa-documents?filename=flagged.pdf',
      headers: {
        cookie: owner.cookie,
        'x-organisation-id': organisationId,
        'content-type': 'application/pdf',
      },
      payload: flagged,
    });
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json()).toMatchObject({ code: 'MALWARE_DETECTED' });
    const [row] = await admin<{ count: string }[]>`
      select count(*)::text as count from loa_documents
      where organisation_id = ${organisationId} and sha256 = ${createHash('sha256')
        .update(flagged)
        .digest('hex')}
    `;
    expect(row?.count).toBe('0');

    const clean = await scanningApp.inject({
      method: 'POST',
      url: '/api/loa-documents?filename=clean.pdf',
      headers: {
        cookie: owner.cookie,
        'x-organisation-id': organisationId,
        'content-type': 'application/pdf',
      },
      payload: buildTestPdf('perfectly clean letter'),
    });
    expect(clean.statusCode, clean.body).toBe(201);
  });
});

/** Seeds a reviewable LOA whose STORED extraction payload carries exactly
 * this letter number — the field the review screen's collision warning is
 * built from. Seeded rather than uploaded because the synthetic
 * single-line PDFs these tests build carry no clause the parser can read
 * a letter number out of, and the behaviour under test is the server's
 * matching, not the parser's extraction. */
async function seedDocumentWithLetterNumber(
  filename: string,
  letterNumber: string,
): Promise<string> {
  const documentId = randomUUID();
  const payload = {
    sourceText: `letter ${letterNumber}`,
    rawSourceText: `letter ${letterNumber}`,
    review: {
      header: {
        letterNumber: { value: letterNumber, raw: letterNumber, needsReview: false },
      },
      items: [],
    },
  };
  await admin`
    insert into loa_documents (
      id, organisation_id, object_key, original_filename, sha256, media_type,
      size_bytes, extraction_status, extraction_payload, uploaded_by_user_id
    )
    values (
      ${documentId}, ${organisationId},
      ${`${organisationId}/loa/${documentId}.pdf`}, ${filename},
      ${createHash('sha256').update(documentId).digest('hex')}, 'application/pdf',
      512, 'review', ${jsonb(admin, payload)}, ${ownerUserId}
    )
  `;
  return documentId;
}

describe('duplicate LOA uploads', () => {
  const duplicatePdf = () => buildTestPdf(`duplicate letter ${runId}`);
  let firstUploadId: string;

  it('refuses a byte-identical re-upload, naming the document already held', async () => {
    const first = await authed(owner, {
      method: 'POST',
      url: '/api/loa-documents?filename=duplicate-original.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: duplicatePdf(),
    });
    expect(first.statusCode, first.body).toBe(201);
    firstUploadId = first.json<{ id: string }>().id;

    const again = await authed(owner, {
      method: 'POST',
      url: '/api/loa-documents?filename=duplicate-again.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: duplicatePdf(),
    });
    expect(again.statusCode, again.body).toBe(409);
    const error = again.json<{
      code: string;
      message: string;
      details: {
        existingRecordId: string;
        originalFilename: string;
        extractionStatus: string;
        confirmedWorkId: string | null;
      };
    }>();
    expect(error.code).toBe('LOA_DOCUMENT_DUPLICATE');
    // The refusal names the file, not merely the fact of a collision.
    expect(error.message).toContain('duplicate-original.pdf');
    expect(error.message).toContain('has not been confirmed into a Work');
    expect(error.details).toMatchObject({
      existingRecordId: firstUploadId,
      originalFilename: 'duplicate-original.pdf',
      extractionStatus: 'review',
      confirmedWorkId: null,
    });

    // Nothing of the refused upload survives.
    const [count] = await admin<{ count: string }[]>`
      select count(*)::text as count from loa_documents
      where organisation_id = ${organisationId}
        and original_filename = 'duplicate-again.pdf'
    `;
    expect(count?.count).toBe('0');
  });

  it('accepts the very same file again once the earlier upload is discarded', async () => {
    const discarded = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${firstUploadId}/discard`,
      organisationId,
      payload: { reason: 'wrong letter attached to the intake' },
    });
    expect(discarded.statusCode, discarded.body).toBe(200);

    const again = await authed(owner, {
      method: 'POST',
      url: '/api/loa-documents?filename=duplicate-replacement.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: duplicatePdf(),
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json<{ id: string }>().id).not.toBe(firstUploadId);
  });

  it('warns about an earlier document carrying the same letter number instead of refusing it', async () => {
    const letterNumber = `LN-WARN-${runId}`;
    const earlier = await seedDocumentWithLetterNumber(
      'earlier-intake.pdf',
      letterNumber,
    );
    const revised = await seedDocumentWithLetterNumber(
      'revised-intake.pdf',
      letterNumber,
    );

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/loa-documents/${revised}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const matches = detail.json<{
      letterNumberMatches: {
        kind: string;
        id: string;
        label: string;
        letterNumber: string;
      }[];
    }>().letterNumberMatches;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      kind: 'document',
      id: earlier,
      label: 'earlier-intake.pdf',
      letterNumber,
    });

    // The warning is symmetric and never names the document itself.
    const own = await authed(owner, {
      method: 'GET',
      url: `/api/loa-documents/${earlier}`,
      organisationId,
    });
    expect(
      own
        .json<{ letterNumberMatches: { id: string }[] }>()
        .letterNumberMatches.map((match) => match.id),
    ).toEqual([revised]);
  });

  it('names the Work when the earlier intake became one', async () => {
    const [work] = await admin<{ letter_number: string; work_code: string }[]>`
      select letter_number, work_code from works
      where organisation_id = ${organisationId}
      order by created_at
      limit 1
    `;
    if (!work) throw new Error('no confirmed Work to match against');
    const documentId = await seedDocumentWithLetterNumber(
      'same-number-as-a-work.pdf',
      work.letter_number,
    );
    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/loa-documents/${documentId}`,
      organisationId,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(
      detail.json<{
        letterNumberMatches: { kind: string; label: string }[];
      }>().letterNumberMatches,
    ).toContainEqual(expect.objectContaining({ kind: 'work', label: work.work_code }));
  });

  it('does not warn about a discarded earlier intake', async () => {
    const letterNumber = `LN-GONE-${runId}`;
    const earlier = await seedDocumentWithLetterNumber('withdrawn.pdf', letterNumber);
    const later = await seedDocumentWithLetterNumber('kept.pdf', letterNumber);
    const discard = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${earlier}/discard`,
      organisationId,
      payload: {},
    });
    expect(discard.statusCode, discard.body).toBe(200);

    const detail = await authed(owner, {
      method: 'GET',
      url: `/api/loa-documents/${later}`,
      organisationId,
    });
    expect(
      detail.json<{ letterNumberMatches: unknown[] }>().letterNumberMatches,
    ).toEqual([]);
  });
});

describe('discarding an unconfirmed LOA intake package', () => {
  /** An LOA whose stored identity a supporting tender document can match
   * against, mirroring the contract-source suite's own fixture. */
  async function seedMatchableParent(): Promise<string> {
    const id = randomUUID();
    const payload = {
      sourceText: 'synthetic parent identity',
      review: {
        header: {
          tenderNumber: { value: 'NCR-SNT-2026-0042' },
          workDescription: {
            value:
              'Supply installation and commissioning of IP MPLS equipment at Jhansi division',
          },
        },
      },
    };
    await admin`
      insert into loa_documents (
        id, organisation_id, object_key, original_filename, sha256,
        media_type, size_bytes, extraction_status, extraction_payload,
        uploaded_by_user_id
      )
      values (
        ${id}, ${organisationId}, ${`${organisationId}/loa/${id}.pdf`},
        'discardable-parent-loa.pdf',
        ${createHash('sha256').update(id).digest('hex')},
        'application/pdf', 1, 'review', ${jsonb(admin, payload)}, ${ownerUserId}
      )
    `;
    return id;
  }

  function matchingSpecPdf(): Buffer {
    return buildMultilineTestPdf([
      'Tender No.: NCR-SNT-2026-0042',
      'Name of Work: Supply installation and commissioning of IP MPLS equipment at Jhansi division',
      'Payment terms Supply and Installation category:',
      '60% on supply, 25% on successful installation, 10% on issue of PAC and 5% on final acceptance.',
      'Warranty period: 36 months for Item ITM-001 from commissioning.',
    ]);
  }

  async function seedSupportingDocument(parentId: string): Promise<string> {
    const id = randomUUID();
    await admin`
      insert into loa_documents (
        id, organisation_id, object_key, original_filename, sha256, media_type,
        size_bytes, extraction_status, extraction_payload, uploaded_by_user_id,
        document_kind, parent_loa_document_id, match_status, identity_match
      )
      values (
        ${id}, ${organisationId}, ${`${organisationId}/contractsource/${id}.pdf`},
        'tender-spec.pdf', ${createHash('sha256').update(id).digest('hex')},
        'application/pdf', 256, 'review',
        ${jsonb(admin, { sourceText: 'spec', review: {} })}, ${ownerUserId},
        'tender_specification', ${parentId}, 'matched',
        ${jsonb(admin, { matched: true })}
      )
    `;
    return id;
  }

  it('discards the letter with its supporting documents, hides it, and audits both', async () => {
    const documentId = await seedDocumentWithLetterNumber(
      'to-discard.pdf',
      `LN-DISCARD-${runId}`,
    );
    const supportingId = await seedSupportingDocument(documentId);

    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/discard`,
      organisationId,
      payload: { reason: 'uploaded the wrong scan' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      document: { id: string; extractionStatus: string };
      discardedSupportingDocumentIds: string[];
    }>();
    expect(body.document).toMatchObject({
      id: documentId,
      extractionStatus: 'discarded',
    });
    expect(body.discardedSupportingDocumentIds).toEqual([supportingId]);

    // Gone from the working list...
    const list = await authed(owner, {
      method: 'GET',
      url: '/api/loa-documents',
      organisationId,
    });
    expect(
      list.json<{ documents: { id: string }[] }>().documents.map((row) => row.id),
    ).not.toContain(documentId);

    // ...but still on record for the writers who run intake.
    const withDiscarded = await authed(owner, {
      method: 'GET',
      url: '/api/loa-documents?includeDiscarded=true',
      organisationId,
    });
    expect(
      withDiscarded
        .json<{ documents: { id: string; extractionStatus: string }[] }>()
        .documents.filter((row) => row.id === documentId),
    ).toEqual([expect.objectContaining({ extractionStatus: 'discarded' })]);

    // The stored row keeps who withdrew it, when, and why.
    const [stored] = await admin<
      {
        extraction_status: string;
        discarded_at: Date | null;
        discarded_by_user_id: string | null;
        discard_reason: string | null;
      }[]
    >`
      select extraction_status, discarded_at, discarded_by_user_id, discard_reason
      from loa_documents where id = ${documentId}
    `;
    expect(stored?.extraction_status).toBe('discarded');
    expect(stored?.discarded_at).not.toBeNull();
    expect(stored?.discarded_by_user_id).toBe(ownerUserId);
    expect(stored?.discard_reason).toBe('uploaded the wrong scan');

    const events = await admin<{ action: string; entity_id: string }[]>`
      select action, entity_id from audit_events
      where organisation_id = ${organisationId}
        and entity_id in (${documentId}, ${supportingId})
        and action in ('loa.discarded', 'contract_source.discarded')
    `;
    expect(events).toEqual(
      expect.arrayContaining([
        { action: 'loa.discarded', entity_id: documentId },
        { action: 'contract_source.discarded', entity_id: supportingId },
      ]),
    );
  });

  it('discards one supporting document on its own and drops its evidence from the package', async () => {
    const parentId = await seedMatchableParent();
    const upload = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/contract-sources?kind=tender_specification&filename=discardable-spec.pdf`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: matchingSpecPdf(),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const documentId = upload.json<{ document: { id: string } }>().document.id;
    expect(
      upload.json<{ context: ContractSourceContext }>().context.paymentMatrix.length,
    ).toBeGreaterThan(0);

    const discard = await authed(owner, {
      method: 'POST',
      url: `/api/contract-source-documents/${documentId}/discard`,
      organisationId,
      payload: { reason: 'attached the wrong tender' },
    });
    expect(discard.statusCode, discard.body).toBe(200);
    // The package answers with what is left: no document, and none of the
    // clauses that document contributed.
    const context = discard.json<ContractSourceContext>();
    expect(context.documents).toEqual([]);
    expect(context.paymentMatrix).toEqual([]);
    expect(context.periods).toEqual([]);

    // And the letter can no longer take a new supporting document once it
    // is itself discarded.
    const discardParent = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/discard`,
      organisationId,
      payload: {},
    });
    expect(discardParent.statusCode, discardParent.body).toBe(200);
    const rejected = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${parentId}/contract-sources?kind=tender_specification&filename=too-late.pdf`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: matchingSpecPdf(),
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json()).toMatchObject({ code: 'LOA_DOCUMENT_DISCARDED' });
  });

  it('refuses a second discard and freezes the discarded document', async () => {
    const documentId = await seedDocumentWithLetterNumber(
      'discard-twice.pdf',
      `LN-TWICE-${runId}`,
    );
    const first = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/discard`,
      organisationId,
      payload: {},
    });
    expect(first.statusCode, first.body).toBe(200);
    const second = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/discard`,
      organisationId,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'DOCUMENT_ALREADY_DISCARDED' });

    // Terminal at the database too: not even the table-owning role revives it.
    await expect(
      admin`
        update loa_documents set extraction_status = 'review',
          discarded_at = null, discarded_by_user_id = null, discard_reason = null
        where id = ${documentId}
      `,
    ).rejects.toThrow(/discarded LOA documents are immutable/);
  });

  it('refuses to confirm a discarded document', async () => {
    const letter = loadCorpus()[0];
    if (!letter) throw new Error('empty corpus');
    const documentId = await seedReviewDocument(letter);
    const discard = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/discard`,
      organisationId,
      payload: {},
    });
    expect(discard.statusCode, discard.body).toBe(200);

    const confirm = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: {
        ...buildConfirmRequest(letter, reviewLoaLetter(letter.text)),
        workCode: `DISCARDED-1`,
        letterNumber: `discarded-${runId}`,
      },
    });
    expect(confirm.statusCode, confirm.body).toBe(409);
    expect(confirm.json()).toMatchObject({ code: 'DOCUMENT_DISCARDED' });
  });

  it('refuses to discard a document already confirmed into a Work, at the route and at the database', async () => {
    const [confirmed] = await admin<{ id: string; confirmed_work_id: string }[]>`
      select id, confirmed_work_id from loa_documents
      where organisation_id = ${organisationId}
        and extraction_status = 'confirmed'
        and confirmed_work_id is not null
      limit 1
    `;
    if (!confirmed) throw new Error('no confirmed document to test against');

    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${confirmed.id}/discard`,
      organisationId,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(409);
    const error = response.json<{ code: string; message: string }>();
    expect(error.code).toBe('DOCUMENT_CONFIRMED');
    expect(error.message).toContain('source of truth');

    // Defence in depth: the trigger refuses the same move for every
    // writer, including the table-owning role the API never runs as.
    await expect(
      admin`
        update loa_documents
        set extraction_status = 'discarded', discarded_at = now(),
            discarded_by_user_id = ${ownerUserId}
        where id = ${confirmed.id}
      `,
    ).rejects.toThrow(/confirmed into a Work/);

    const [unchanged] = await admin<{ extraction_status: string }[]>`
      select extraction_status from loa_documents where id = ${confirmed.id}
    `;
    expect(unchanged?.extraction_status).toBe('confirmed');
  });

  it('refuses a discard from viewers', async () => {
    const documentId = await seedDocumentWithLetterNumber(
      'viewer-cannot-discard.pdf',
      `LN-VIEWER-${runId}`,
    );
    const response = await authed(viewer, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/discard`,
      organisationId,
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
  });
});
