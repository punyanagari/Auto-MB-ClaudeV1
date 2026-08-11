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
      extractionPayload: { sourceText: string; review: { items: unknown[] } };
    }>();
    expect(body.extractionStatus).toBe('review');
    expect(body.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(body.extractionPayload.sourceText).toContain(
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
      'Payment terms Supply and Installation category: 60% on supply, 25% on successful installation, 10% on issue of PAC and 5% on final acceptance.',
      'Warranty period: 36 months for Item ITM-001 from commissioning.',
      'Maintenance period: 5 years for the complete work after warranty.',
      'The Performance Bank Guarantee PBG shall be released after final acceptance and expiry of warranty obligations.',
      'The Security Deposit shall be returned after issue of the completion certificate and settlement of dues.',
      'Item ITM-001 technical specification: Router shall conform to TEC GR No TEC-GR-TX-IPM-001 and support MPLS-TE.',
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
