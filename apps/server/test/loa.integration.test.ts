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
 * exactly `text`, with a correct xref table â€” enough for pdftotext to
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
      where organisat×^z¶‰žËkºwµçQÉ¥¹œõmtù€(€€€€€€€Í•±•Ð½Õ¹Ð ¨¤™¥±Ñ•È€ (€€€€€€€€€Ý¡•É”Í½ÕÉ•}•Ù¥‘•¹”´øøÉ•Í½±Ù•œ¥Ì‘¥ÍÑ¥¹Ð™É½´€ÑÉÕ”œ(€€€€€€€€¤èéÑ•áÐ…ÌÕ¹É•Í½±Ù•(€€€€€€€™É½´Ý½É­}¥Ñ•µÌÝ¡•É”Ý½É­}¥€ô€‘í‘•Ñ…¥°¹Ý½É¬¹¥‘ô(€€€€€€ì(€€€€€•áÁ•Ð¡•Ù¥‘•¹”ü¹Õ¹É•Í½±Ù•¤¹Ñ½	” œÀœ¤ì((€€€€€½¹ÍÐ™•Ñ¡•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€€€µ•Ñ¡½è€Pœ°(€€€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘í‘•Ñ…¥°¹Ý½É¬¹¥‘õ€°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€ô¤ì(€€€€€•áÁ•Ð¡™•Ñ¡•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÈÀÀ¤ì(€€€€€•áÁ•Ð (€€€€€€€™•Ñ¡•(€€€€€€€€€€¹©Í½¸ñ]½É­•Ñ…¥±I•ÍÁ½¹Í”ø ¤(€€€€€€€€€€¹Í¡•‘Õ±•Ì¹É•‘Õ” ¡Ñ½Ñ…°°Ì¤€ôøÑ½Ñ…°€¬Ì¹¥Ñ•µÌ¹±•¹Ñ °€À¤°(€€€€€€¤¹Ñ½	”¡±•ÑÑ•È¹µ…¹¥™•ÍÐ¹¥Ñ•µ}½Õ¹Ð¤ì(€€€ô°(€€€€ÌÁ|ÀÀÀ°(€€¤ì((€¥Ð É•™ÕÍ•ÌÑ¼½¹™¥É´Ñ¡”Í…µ”‘½Õµ•¹ÐÑÝ¥”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐm½¹™¥Éµ•‘½t€ô…Ý…¥Ð…‘µ¥¸ñì¥èÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð¥™É½´±½…}‘½Õµ•¹ÑÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô…¹•áÑÉ…Ñ¥½¹}ÍÑ…ÑÕÌ€ô€½¹™¥Éµ•œ(€€€€€±¥µ¥Ð€Ä(€€€€ì(€€€•áÁ•Ð¡½¹™¥Éµ•‘½Œ¤¹Ñ½	••™¥¹• ¤ì(€€€½¹ÍÐ±•ÑÑ•È€ô½ÉÁÕÍlÁtì(€€€¥˜€ …±•ÑÑ•Èñð€…½¹™¥Éµ•‘½Œ¤Ñ¡É½Ü¹•ÜÉÉ½È µ¥ÍÍ¥¹œ½ÉÁÕÌ½™¥áÑÕÉ”‘½Œœ¤ì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½±½„µ‘½Õµ•¹ÑÌ¼‘í½¹™¥Éµ•‘½Œ¹¥‘ô½½¹™¥Éµ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‰Õ¥±‘½¹™¥ÉµI•ÅÕ•ÍÐ¡±•ÑÑ•È°É•Ù¥•Ý1½…1•ÑÑ•È¡±•ÑÑ•È¹Ñ•áÐ¤¤°(€€€€€€€Ý½É­½‘”è€IAP´Äœ°(€€€€€€€±•ÑÑ•É9Õµ‰•ÈèÉ•Á•…Ð´‘íÉÕ¹%‘õ€°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€=U59Q}9=Q}IY%]	1œô¤ì(€ô¤ì((€¥Ð É•™ÕÍ•Ì½¹™¥Éµ…Ñ¥½¸™É½´Ù¥•Ý•ÉÌœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ±•ÑÑ•È€ô½ÉÁÕÍlÁtì(€€€¥˜€ …±•ÑÑ•È¤Ñ¡É½Ü¹•ÜÉÉ½È •µÁÑä½ÉÁÕÌœ¤ì(€€€½¹ÍÐ‘½Õµ•¹Ñ%€ô…Ý…¥ÐÍ••‘I•Ù¥•Ý½Õµ•¹Ð¡±•ÑÑ•È¤ì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡Ù¥•Ý•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½±½„µ‘½Õµ•¹ÑÌ¼‘í‘½Õµ•¹Ñ%‘ô½½¹™¥Éµ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€€¸¸¹‰Õ¥±‘½¹™¥ÉµI•ÅÕ•ÍÐ¡±•ÑÑ•È°É•Ù¥•Ý1½…1•ÑÑ•È¡±•ÑÑ•È¹Ñ•áÐ¤¤°(€€€€€€€Ý½É­½‘”è€Y%]Hµ9%´Äœ°(€€€€€€€±•ÑÑ•É9Õµ‰•ÈèÙ¥•Ý•Èµ‘•¹¥•´‘íÉÕ¹%‘õ€°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀÌ¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€I=1}=I	%8œô¤ì(€ô¤ì((€¥Ð ±¥ÍÑÌ½¹™¥Éµ•]½É­Ì™½Èµ•µ‰•ÉÌ…¹­••ÁÌÑ¡”…Õ‘¥ÐÑÉ…¥°œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ±¥ÍÐ€ô…Ý…¥Ð…ÕÑ¡•¡Ù¥•Ý•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€œ½…Á¤½Ý½É­Ìœ°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡±¥ÍÐ¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð (€€€€€±¥ÍÐ¹©Í½¸ñìÝ½É­ÌèìÝ½É­½‘”èÍÑÉ¥¹œõmtôø ¤¹Ý½É­Ì¹±•¹Ñ °(€€€€¤¹Ñ½	•É•…Ñ•ÉQ¡…¹=ÉÅÕ…°¡½ÉÁÕÌ¹±•¹Ñ ¤ì((€€€½¹ÍÐ•Ù•¹ÑÌ€ô…Ý…¥Ð…‘µ¥¸ñì…Ñ¥½¸èÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð…Ñ¥½¸™É½´…Õ‘¥Ñ}•Ù•¹ÑÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô…¹…Ñ¥½¸€ô€Ý½É¬¹É•…Ñ•œ(€€€€ì(€€€•áÁ•Ð¡•Ù•¹ÑÌ¹±•¹Ñ ¤¹Ñ½	•É•…Ñ•ÉQ¡…¹=ÉÅÕ…°¡½ÉÁÕÌ¹±•¹Ñ ¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” µ…Ñ¡•Ñ•¹‘•È…¹½¹ÑÉ…ÐµÍ½ÕÉ”Á…­…”œ°€ ¤€ôøì(€…Íå¹Œ™Õ¹Ñ¥½¸Í••‘A…É•¹Ñ1½„ ¤èAÉ½µ¥Í”ñÍÑÉ¥¹œøì(€€€½¹ÍÐ¥€ôÉ…¹‘½µUU% ¤ì(€€€½¹ÍÐÁ…å±½…€ôì(€€€€€Í½ÕÉ•Q•áÐè€Íå¹Ñ¡•Ñ¥ŒÁ…É•¹Ð¥‘•¹Ñ¥Ñäœ°(€€€€€É•Ù¥•Üèì(€€€€€€€¡•…‘•Èèì(€€€€€€€€€Ñ•¹‘•É9Õµ‰•ÈèìÙ…±Õ”è€9HµM9P´ÈÀÈØ´ÀÀÐÈœô°(€€€€€€€€€Ý½É­•ÍÉ¥ÁÑ¥½¸èì(€€€€€€€€€€€Ù…±Õ”è(€€€€€€€€€€€€€€MÕÁÁ±ä¥¹ÍÑ…±±…Ñ¥½¸…¹½µµ¥ÍÍ¥½¹¥¹œ½˜%@5A1L•ÅÕ¥Áµ•¹Ð…Ð)¡…¹Í¤‘¥Ù¥Í¥½¸œ°(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€ô°(€€€ôì(€€€…Ý…¥Ð…‘µ¥¹€(€€€€€¥¹Í•ÉÐ¥¹Ñ¼±½…}‘½Õµ•¹ÑÌ€ (€€€€€€€¥°½É…¹¥Í…Ñ¥½¹}¥°½‰©•Ñ}­•ä°½É¥¥¹…±}™¥±•¹…µ”°Í¡„ÈÔØ°(€€€€€€€µ•‘¥…}ÑåÁ”°Í¥é•}‰åÑ•Ì°•áÑÉ…Ñ¥½¹}ÍÑ…ÑÕÌ°•áÑÉ…Ñ¥½¹}Á…å±½…°(€€€€€€€ÕÁ±½…‘•‘}‰å}ÕÍ•É}¥(€€€€€€¤(€€€€€Ù…±Õ•Ì€ (€€€€€€€€‘í¥‘ô°€‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘í€‘í½É…¹¥Í…Ñ¥½¹%‘ô½±½„¼‘í¥‘ô¹Á‘™ô°(€€€€€€€€µ…Ñ¡•µÁ…É•¹Ðµ±½„¹Á‘˜œ°€‘íÉ•…Ñ•!…Í  Í¡„ÈÔØœ¤¹ÕÁ‘…Ñ”¡¥¤¹‘¥•ÍÐ ¡•àœ¥ô°(€€€€€€€€…ÁÁ±¥…Ñ¥½¸½Á‘˜œ°€Ä°€É•Ù¥•Üœ°€‘í©Í½¹ˆ¡…‘µ¥¸°Á…å±½…¥ô°€‘í½Ý¹•ÉUÍ•É%‘ô(€€€€€€¤(€€€€ì(€€€É•ÑÕÉ¸¥ì(€ô((€™Õ¹Ñ¥½¸µ…Ñ¡¥¹Q•¹‘•ÉA‘˜ ¤è	Õ™™•Èì(€€€É•ÑÕÉ¸‰Õ¥±‘5Õ±Ñ¥±¥¹•Q•ÍÑA‘˜¡l(€€€€€€Q•¹‘•È9¼¸è9HµM9P´ÈÀÈØ´ÀÀÐÈœ°(€€€€€€9…µ”½˜]½É¬èMÕÁÁ±ä¥¹ÍÑ…±±…Ñ¥½¸…¹½µµ¥ÍÍ¥½¹¥¹œ½˜%@5A1L•ÅÕ¥Áµ•¹Ð…Ð)¡…¹Í¤‘¥Ù¥Í¥½¸œ°(€€€€€€A…åµ•¹ÐÑ•ÉµÌMÕÁÁ±ä…¹%¹ÍÑ…±±…Ñ¥½¸…Ñ•½Éäèœ°(€€€€€€œØÀ”½¸ÍÕÁÁ±ä°€ÈÔ”½¸ÍÕ•ÍÍ™Õ°¥¹ÍÑ…±±…Ñ¥½¸°€ÄÀ”½¸¥ÍÍÕ”½˜A…¹€Ô”½¸™¥¹…°…•ÁÑ…¹”¸œ°(€€€€€€]…ÉÉ…¹ÑäÁ•É¥½è€ÌØµ½¹Ñ¡Ì™½È%Ñ•´%Q4´ÀÀÄ™É½´½µµ¥ÍÍ¥½¹¥¹œ¸œ°(€€€€€€5…¥¹Ñ•¹…¹”Á•É¥½è€Ôå•…ÉÌ™½ÈÑ¡”½µÁ±•Ñ”Ý½É¬…™Ñ•ÈÝ…ÉÉ…¹Ñä¸œ°(€€€€€€Q¡”A•É™½Éµ…¹”	…¹¬Õ…É…¹Ñ•”A	Í¡…±°‰”É•±•…Í•…™Ñ•È™¥¹…°…•ÁÑ…¹”…¹•áÁ¥Éä½˜Ý…ÉÉ…¹Ñä½‰±¥…Ñ¥½¹Ì¸œ°(€€€€€€Q¡”M•ÕÉ¥Ñä•Á½Í¥ÐÍ¡…±°‰”É•ÑÕÉ¹•…™Ñ•È¥ÍÍÕ”½˜Ñ¡”½µÁ±•Ñ¥½¸•ÉÑ¥™¥…Ñ”…¹Í•ÑÑ±•µ•¹Ð½˜‘Õ•Ì¸œ°(€€€€€€%Ñ•´%Q4´ÀÀÄÑ•¡¹¥…°ÍÁ•¥™¥…Ñ¥½¸èI½ÕÑ•ÈÍ¡…±°½¹™½É´Ñ¼QH9¼QµHµQ`µ%A4´ÀÀÄ…¹ÍÕÁÁ½ÉÐ5A1LµQ¸œ°(€€€t¤ì(€ô((€™Õ¹Ñ¥½¸µ…Ñ¡¥¹]É…ÁÁ•‘Q•¹‘•ÉA‘˜ ¤è	Õ™™•Èì(€€€É•ÑÕÉ¸‰Õ¥±‘5Õ±Ñ¥±¥¹•Q•ÍÑA‘˜¡l(€€€€€€Q•¹‘•È9¼¸è9HµM9P´ÈÀÈØ´ÀÀÐÈœ°(€€€€€€9…µ”½˜]½É¬èMÕÁÁ±ä¥¹ÍÑ…±±…Ñ¥½¸…¹œ°(€€€€€€½µµ¥ÍÍ¥½¹¥¹œ½˜%@5A1L•ÅÕ¥Áµ•¹Ð…Ðœ°(€€€€€€)¡…¹Í¤‘¥Ù¥Í¥½¸œ°(€€€€€€Q•¹‘•È½Õµ•¹Ð½ÍÐèIÌ¸€À¸ÀÀœ°(€€€t¤ì(€ô((€¥Ð …•ÁÑÌ½¹±ä„µ…Ñ¡¥¹œÍ½ÕÉ”°•áÑÉ…ÑÌÑ¡”Ñ•¹‘•È½¹Ñ•áÐ…¹É•½É‘ÌÑ¡”¥µµÕÑ…‰±”É•±…Ñ¥½¹Í¡¥Àœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÁ…É•¹Ñ%€ô…Ý…¥ÐÍ••‘A…É•¹Ñ1½„ ¤ì(€€€½¹ÍÐÕÁ±½…€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½±½„µ‘½Õµ•¹ÑÌ¼‘íÁ…É•¹Ñ%‘ô½½¹ÑÉ…ÐµÍ½ÕÉ•Ìý­¥¹õÑ•¹‘•É}ÍÁ•¥™¥…Ñ¥½¸™™¥±•¹…µ”õÑ•¹‘•ÈµÍÁ•Œ¹Á‘™€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€¡•…‘•ÉÌèì€½¹Ñ•¹ÐµÑåÁ”œè€…ÁÁ±¥…Ñ¥½¸½Á‘˜œô°(€€€€€Á…å±½…èµ…Ñ¡¥¹Q•¹‘•ÉA‘˜ ¤°(€€€ô¤ì(€€€•áÁ•Ð¡ÕÁ±½…¹ÍÑ…ÑÕÍ½‘”°ÕÁ±½…¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ôÕÁ±½…¹©Í½¸ñì½¹Ñ•áÐè½¹ÑÉ…ÑM½ÕÉ•½¹Ñ•áÐôø ¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹½¹Ñ•áÐ¹‘½Õµ•¹ÑÌ¤¹Ñ½!…Ù•1•¹Ñ  Ä¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹½¹Ñ•áÐ¹Á…åµ•¹Ñ5…ÑÉ¥álÁt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€…Ñ•½Éäè€MUAA1e}9}%9MQ11Q%=8œ°(€€€€€ÁÑMÕÁÁ±äè€œØÀœ°(€€€€€ÁÑ%¹ÍÑ…±±…Ñ¥½¸è€œÈÔœ°(€€€€€ÁÑA…Œè€œÄÀœ°(€€€€€ÁÑ¥¹…±	¥±°è€œÔœ°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹½¹Ñ•áÐ¹Á•É¥½‘Ì¹µ…À ¡Á•É¥½¤€ôøÁ•É¥½¹­¥¹¤¹Í½ÉÐ ¤¤¹Ñ½ÅÕ…°¡l(€€€€€€µ…¥¹Ñ•¹…¹”œ°(€€€€€€Ý…ÉÉ…¹Ñäœ°(€€€t¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹½¹Ñ•áÐ¹É•±•…Í•±…ÕÍ•Ì¹µ…À ¡±…ÕÍ”¤€ôø±…ÕÍ”¹­¥¹¤¹Í½ÉÐ ¤¤¹Ñ½ÅÕ…° (€€€€€lÁ‰œœ°€Í•ÕÉ¥Ñå}‘•Á½Í¥Ðt°(€€€€¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹½¹Ñ•áÐ¹¥Ñ•µMÁ•¥™¥…Ñ¥½¹ÍlÁtü¹¥Ñ•µI•™•É•¹•Ì¤¹Ñ½½¹Ñ…¥¸ %Q4´ÀÀÄœ¤ì((€€€½¹ÍÐmÍÑ½É•‘t€ô…Ý…¥Ð…‘µ¥¸ð(€€€€€ì(€€€€€€€‘½Õµ•¹Ñ}­¥¹èÍÑÉ¥¹œì(€€€€€€€Á…É•¹Ñ}±½…}‘½Õµ•¹Ñ}¥èÍÑÉ¥¹œì(€€€€€€€µ…Ñ¡}ÍÑ…ÑÕÌèÍÑÉ¥¹œì(€€€€€õmt(€€€€ù€(€€€€€Í•±•Ð‘½Õµ•¹Ñ}­¥¹°Á…É•¹Ñ}±½…}‘½Õµ•¹Ñ}¥°µ…Ñ¡}ÍÑ…ÑÕÌ(€€€€€™É½´±½…}‘½Õµ•¹ÑÌ(€€€€€Ý¡•É”Á…É•¹Ñ}±½…}‘½Õµ•¹Ñ}¥€ô€‘íÁ…É•¹Ñ%‘ô(€€€€ì(€€€•áÁ•Ð¡ÍÑ½É•¤¹Ñ½ÅÕ…°¡ì(€€€€€‘½Õµ•¹Ñ}­¥¹è€Ñ•¹‘•É}ÍÁ•¥™¥…Ñ¥½¸œ°(€€€€€Á…É•¹Ñ}±½…}‘½Õµ•¹Ñ}¥èÁ…É•¹Ñ%°(€€€€€µ…Ñ¡}ÍÑ…ÑÕÌè€µ…Ñ¡•œ°(€€€ô¤ì(€ô¤ì((€¥Ð …•ÁÑÌ„µ…Ñ¡¥¹œ¹…µ”½˜Ý½É¬ÝÉ…ÁÁ•…É½ÍÌA±¥¹•Ìœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÁ…É•¹Ñ%€ô…Ý…¥ÐÍ••‘A…É•¹Ñ1½„ ¤ì(€€€½¹ÍÐÕÁ±½…€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½±½„µ‘½Õµ•¹ÑÌ¼‘íÁ…É•¹Ñ%‘ô½½¹ÑÉ…ÐµÍ½ÕÉ•Ìý­¥¹õ¹¥Ð™™¥±•¹…µ”õÝÉ…ÁÁ•µ¹¥Ð¹Á‘™€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€¡•…‘•ÉÌèì€½¹Ñ•¹ÐµÑåÁ”œè€…ÁÁ±¥…Ñ¥½¸½Á‘˜œô°(€€€€€Á…å±½…èµ…Ñ¡¥¹]É…ÁÁ•‘Q•¹‘•ÉA‘˜ ¤°(€€€ô¤ì((€€€•áÁ•Ð¡ÕÁ±½…¹ÍÑ…ÑÕÍ½‘”°ÕÁ±½…¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€•áÁ•Ð (€€€€€ÕÁ±½…¹©Í½¸ñì(€€€€€€€‘½Õµ•¹Ðèì(€€€€€€€€€¥‘•¹Ñ¥Ñå5…Ñ èì(€€€€€€€€€€€•áÑÉ…Ñ•‘]½É­•ÍÉ¥ÁÑ¥½¸èÍÑÉ¥¹œì(€€€€€€€€€€€Ý½É­•ÍÉ¥ÁÑ¥½¹5…Ñ¡•è‰½½±•…¸ì(€€€€€€€€€ôì(€€€€€€€ôì(€€€€€ôø ¤¹‘½Õµ•¹Ð¹¥‘•¹Ñ¥Ñå5…Ñ °(€€€€¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€•áÑÉ…Ñ•‘]½É­•ÍÉ¥ÁÑ¥½¸è(€€€€€€€€MÕÁÁ±ä¥¹ÍÑ…±±…Ñ¥½¸…¹½µµ¥ÍÍ¥½¹¥¹œ½˜%@5A1L•ÅÕ¥Áµ•¹Ð…Ð)¡…¹Í¤‘¥Ù¥Í¥½¸œ°(€€€€€Ý½É­•ÍÉ¥ÁÑ¥½¹5…Ñ¡•èÑÉÕ”°(€€€ô¤ì(€ô¤ì((€¥Ð É•©•ÑÌ„™½É•¥¸Ñ•¹‘•È‰•™½É”½‰©•Ðµ•Ñ…‘…Ñ„¥ÌÍÑ½É•…¹…Õ‘¥ÑÌ½¹±äÑ¡”É•™ÕÍ…°œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÁ…É•¹Ñ%€ô…Ý…¥ÐÍ••‘A…É•¹Ñ1½„ ¤ì(€€€½¹ÍÐ™½É•¥¸€ô‰Õ¥±‘5Õ±Ñ¥±¥¹•Q•ÍÑA‘˜¡l(€€€€€€Q•¹‘•È9¼¸è=I%8´ÀÀäœ°(€€€€€€9…µ”½˜]½É¬è½¹ÍÑÉÕÑ¥½¸½˜„ÍÑ…Ñ¥½¸‰Õ¥±‘¥¹œ…ÐÉ„œ°(€€€€€€A…åµ•¹ÐÑ•ÉµÌè€àÀ”½¸ÍÕÁÁ±ä…¹€ÈÀ”½¸¥¹ÍÑ…±±…Ñ¥½¸¸œ°(€€€t¤ì(€€€½¹ÍÐÍ¡„€ôÉ•…Ñ•!…Í  Í¡„ÈÔØœ¤¹ÕÁ‘…Ñ”¡™½É•¥¸¤¹‘¥•ÍÐ ¡•àœ¤ì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½±½„µ‘½Õµ•¹ÑÌ¼‘íÁ…É•¹Ñ%‘ô½½¹ÑÉ…ÐµÍ½ÕÉ•Ìý­¥¹õ¹¥Ð™™¥±•¹…µ”õ™½É•¥¸¹Á‘™€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€¡•…‘•ÉÌèì€½¹Ñ•¹ÐµÑåÁ”œè€…ÁÁ±¥…Ñ¥½¸½Á‘˜œô°(€€€€€Á…å±½…è™½É•¥¸°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€½‘”è€=9QIQ}M=UI}%9Q%Qe}5%M5Q œ°(€€€€€‘•Ñ…¥±Ìèì(€€€€€€€µ…Ñ¡•è™…±Í”°(€€€€€€€Ñ•¹‘•É9Õµ‰•É5…Ñ¡•è™…±Í”°(€€€€€€€Ý½É­•ÍÉ¥ÁÑ¥½¹5…Ñ¡•è™…±Í”°(€€€€€ô°(€€€ô¤ì(€€€½¹ÍÐmÍÑ½É•‘t€ô…Ý…¥Ð…‘µ¥¸ñì½Õ¹ÐèÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð½Õ¹Ð ¨¤èéÑ•áÐ…Ì½Õ¹Ð™É½´±½…}‘½Õµ•¹ÑÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô…¹Í¡„ÈÔØ€ô€‘íÍ¡…ô(€€€€ì(€€€•áÁ•Ð¡ÍÑ½É•ü¹½Õ¹Ð¤¹Ñ½	” œÀœ¤ì(€€€½¹ÍÐm…Õ‘¥Ñt€ô…Ý…¥Ð…‘µ¥¸ñì½Õ¹ÐèÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð½Õ¹Ð ¨¤èéÑ•áÐ…Ì½Õ¹Ð™É½´…Õ‘¥Ñ}•Ù•¹ÑÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô(€€€€€€€…¹…Ñ¥½¸€ô€½¹ÑÉ…Ñ}Í½ÕÉ”¹É•©•Ñ•œ(€€€€€€€…¹•¹Ñ¥Ñå}¥€ô€‘íÁ…É•¹Ñ%‘ô(€€€€ì(€€€•áÁ•Ð¡…Õ‘¥Ðü¹½Õ¹Ð¤¹Ñ½	” œÄœ¤ì(€ô¤ì((€¥Ð ½¹™¥ÉµÌÑ¡”É•Ù¥•Ý•Èµ•¹Ñ•É•¥¹¥Ñ¥…°µ…ÑÉ¥à…Ñ½µ¥…±±ä…¹±¥¹­ÌÍÕÁÁ½ÉÑ¥¹œ•Ù¥‘•¹”Ñ¼Ñ¡”]½É¬œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÁ…É•¹Ñ%€ô…Ý…¥ÐÍ••‘A…É•¹Ñ1½„ ¤ì(€€€½¹ÍÐÕÁ±½…€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½±½„µ‘½Õµ•¹ÑÌ¼‘íÁ…É•¹Ñ%‘ô½½¹ÑÉ…ÐµÍ½ÕÉ•Ìý­¥¹õÑ•¹‘•É}ÍÁ•¥™¥…Ñ¥½¸™™¥±•¹…µ”õÑ•¹‘•ÈµÍÁ•Œµ½¹™¥É´¹Á‘™€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€¡•…‘•ÉÌèì€½¹Ñ•¹ÐµÑåÁ”œè€…ÁÁ±¥…Ñ¥½¸½Á‘˜œô°(€€€€€Á…å±½…èµ…Ñ¡¥¹Q•¹‘•ÉA‘˜ ¤°(€€€ô¤ì(€€€•áÁ•Ð¡ÕÁ±½…¹ÍÑ…ÑÕÍ½‘”°ÕÁ±½…¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì((€€€½¹ÍÐ½¹™¥É´€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½±½„µ‘½Õµ•¹ÑÌ¼‘íÁ…É•¹Ñ%‘ô½½¹™¥Éµ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€Ý½É­½‘”èQ9H´‘íÉÕ¹%‘õ€¹Ñ½UÁÁ•É…Í” ¤¹Í±¥” À°€ÈÀ¤°(€€€€€€€±•ÑÑ•É9Õµ‰•Èè1=µQ9H´‘íÉÕ¹%‘õ€°(€€€€€€€±•ÑÑ•É…Ñ”è€œÈÀÈÔ´ÀÄ´ÀÄœ°(€€€€€€€Ñ¥Ñ±”è(€€€€€€€€€€MÕÁÁ±ä¥¹ÍÑ…±±…Ñ¥½¸…¹½µµ¥ÍÍ¥½¹¥¹œ½˜%@5A1L•ÅÕ¥Áµ•¹Ð…Ð)¡…¹Í¤‘¥Ù¥Í¥½¸œ°(€€€€€€€…‘Ù•ÉÑ¥Í•‘Y…±Õ”è€œÄÀÀÀÀÀœ°(€€€€€€€½¹ÑÉ…ÑY…±Õ”è€œäÀÀÀÀœ°(€€€€€€€ÁÉ¥¥¹M¡…Á”è€Á•É}Í¡•‘Õ±”œ°(€€€€€€€Á…åµ•¹Ñ5…ÑÉ¥àèl(€€€€€€€€€ì(€€€€€€€€€€€…Ñ•½Éäè€MUAA1e}9}%9MQ11Q%=8œ°(€€€€€€€€€€€ÁÑMÕÁÁ±äè€œÔÔœ°(€€€€€€€€€€€ÁÑ%¹ÍÑ…±±…Ñ¥½¸è€œÌÀœ°(€€€€€€€€€€€ÁÑA…Œè€œÄÀœ°(€€€€€€€€€€€ÁÑ¥¹…±	¥±°è€œÔœ°(€€€€€€€€€ô°(€€€€€€€t°(€€€€€€€Í¡•‘Õ±•Ìèl(€€€€€€€€€ì(€€€€€€€€€€€Í¡•‘Õ±•½‘”è€œ°(€€€€€€€€€€€Ñ¥Ñ±”è€M¡•‘Õ±”œ°(€€€€€€€€€€€¥Ñ•µÌèl(€€€€€€€€€€€€€ì(€€€€€€€€€€€€€€€¥Ñ•µ9Õµ‰•Èè€%Q4´ÀÀÄœ°(€€€€€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è€%@5A1L•‘”É½ÕÑ•Èœ°(€€€€€€€€€€€€€€€Õ¹¥Ñ½‘”è€9=Lœ°(€€€€€€€€€€€€€€€…Ý…É‘•‘EÕ…¹Ñ¥Ñäè€œÄÀœ°(€€€€€€€€€€€€€€€•™™•Ñ¥Ù•I…Ñ”è€œäÀÀÀœ°(€€€€€€€€€€€€€€€Á…åµ•¹Ñ…Ñ•½Éäè€MUAA1e}9}%9MQ11Q%=8œ°(€€€€€€€€€€€€€€€µ…¹Õ…±¹ÑÉäèÑÉÕ”°(€€€€€€€€€€€€€ô°(€€€€€€€€€€€t°(€€€€€€€€€ô°(€€€€€€€t°(€€€€€ôÍ…Ñ¥Í™¥•Ì½¹™¥Éµ]½É­I•ÅÕ•ÍÐ°(€€€ô¤ì(€€€•áÁ•Ð¡½¹™¥É´¹ÍÑ…ÑÕÍ½‘”°½¹™¥É´¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐÝ½É¬€ô½¹™¥É´¹©Í½¸ñ]½É­•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹Ý½É¬ì((€€€½¹ÍÐmµ…ÑÉ¥át€ô…Ý…¥Ð…‘µ¥¸ð(€€€€€ì(€€€€€€€ÁÑ}ÍÕÁÁ±äèÍÑÉ¥¹œì(€€€€€€€ÁÑ}¥¹ÍÑ…±±…Ñ¥½¸èÍÑÉ¥¹œì(€€€€€€€ÁÑ}Á…ŒèÍÑÉ¥¹œì(€€€€€€€ÁÑ}™¥¹…±}‰¥±°èÍÑÉ¥¹œì(€€€€€õmt(€€€€ù€(€€€€€Í•±•ÐÁÑ}ÍÕÁÁ±äèéÑ•áÐ°ÁÑ}¥¹ÍÑ…±±…Ñ¥½¸èéÑ•áÐ°ÁÑ}Á…ŒèéÑ•áÐ°(€€€€€€€€€€€€ÁÑ}™¥¹…±}‰¥±°èéÑ•áÐ(€€€€€™É½´Á…åµ•¹Ñ}µ…ÑÉ¥•ÌÝ¡•É”Ý½É­}¥€ô€‘íÝ½É¬¹¥‘ô(€€€€ì(€€€•áÁ•Ð¡µ…ÑÉ¥à¤¹Ñ½ÅÕ…°¡ì(€€€€€ÁÑ}ÍÕÁÁ±äè€œÔÔ¸ÀÀœ°(€€€€€ÁÑ}¥¹ÍÑ…±±…Ñ¥½¸è€œÌÀ¸ÀÀœ°(€€€€€ÁÑ}Á…Œè€œÄÀ¸ÀÀœ°(€€€€€ÁÑ}™¥¹…±}‰¥±°è€œÔ¸ÀÀœ°(€€€ô¤ì(€€€½¹ÍÐm±¥¹­•‘t€ô…Ý…¥Ð…‘µ¥¸ñì½¹™¥Éµ•‘}Ý½É­}¥èÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð½¹™¥Éµ•‘}Ý½É­}¥™É½´±½…}‘½Õµ•¹ÑÌ(€€€€€Ý¡•É”Á…É•¹Ñ}±½…}‘½Õµ•¹Ñ}¥€ô€‘íÁ…É•¹Ñ%‘ô(€€€€ì(€€€•áÁ•Ð¡±¥¹­•ü¹½¹™¥Éµ•‘}Ý½É­}¥¤¹Ñ½	”¡Ý½É¬¹¥¤ì((€€€½¹ÍÐ½¹Ñ•áÐ€ô…Ý…¥Ð…ÕÑ¡•¡Ù¥•Ý•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É¬¹¥‘ô½½¹ÑÉ…ÐµÍ½ÕÉ”µ½¹Ñ•áÑ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡½¹Ñ•áÐ¹ÍÑ…ÑÕÍ½‘”°½¹Ñ•áÐ¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð (€€€€€½¹Ñ•áÐ¹©Í½¸ñ½¹ÑÉ…ÑM½ÕÉ•½¹Ñ•áÐø ¤¹¥Ñ•µMÁ•¥™¥…Ñ¥½¹ÍlÁtü¹µ…ÁÁ•‘]½É­%Ñ•µ%‘Ì°(€€€€¤¹Ñ½!…Ù•1•¹Ñ  Ä¤ì(€ô¤ì((€¥Ð É•™ÕÍ•Ìµ…±™½Éµ•¥¹¥Ñ¥…°Á…åµ•¹ÐÉ½ÝÌÝ¥Ñ¡½ÕÐÉ•…Ñ¥¹œÑ¡”]½É¬œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÁ…É•¹Ñ%€ô…Ý…¥ÐÍ••‘A…É•¹Ñ1½„ ¤ì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½±½„µ‘½Õµ•¹ÑÌ¼‘íÁ…É•¹Ñ%‘ô½½¹™¥Éµ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€Ý½É­½‘”è	5P´‘íÉÕ¹%‘õ€¹Ñ½UÁÁ•É…Í” ¤¹Í±¥” À°€ÈÀ¤°(€€€€€€€±•ÑÑ•É9Õµ‰•Èè1=µ	µ5QI%`´‘íÉÕ¹%‘õ€°(€€€€€€€±•ÑÑ•É…Ñ”è€œÈÀÈÔ´ÀÄ´ÀÄœ°(€€€€€€€Ñ¥Ñ±”è(€€€€€€€€€€MÕÁÁ±ä¥¹ÍÑ…±±…Ñ¥½¸…¹½µµ¥ÍÍ¥½¹¥¹œ½˜%@5A1L•ÅÕ¥Áµ•¹Ð…Ð)¡…¹Í¤‘¥Ù¥Í¥½¸œ°(€€€€€€€…‘Ù•ÉÑ¥Í•‘Y…±Õ”è€œÄÀÀÀœ°(€€€€€€€½¹ÑÉ…ÑY…±Õ”è€œÄÀÀÀœ°(€€€€€€€ÁÉ¥¥¹M¡…Á”è€Á•É}Í¡•‘Õ±”œ°(€€€€€€€Á…åµ•¹Ñ5…ÑÉ¥àèl(€€€€€€€€€ì(€€€€€€€€€€€…Ñ•½Éäè€MUAA1dœ°(€€€€€€€€€€€ÁÑMÕÁÁ±äè€œàÀœ°(€€€€€€€€€€€ÁÑ%¹ÍÑ…±±…Ñ¥½¸è€œÄÀœ°(€€€€€€€€€€€ÁÑA…Œè€œÔœ°(€€€€€€€€€€€ÁÑ¥¹…±	¥±°è€œÐœ°(€€€€€€€€€ô°(€€€€€€€t°(€€€€€€€Í¡•‘Õ±•Ìèl(€€€€€€€€€ì(€€€€€€€€€€€Í¡•‘Õ±•½‘”è€œ°(€€€€€€€€€€€Ñ¥Ñ±”è€M¡•‘Õ±”œ°(€€€€€€€€€€€¥Ñ•µÌèl(€€€€€€€€€€€€€ì(€€€€€€€€€€€€€€€¥Ñ•µ9Õµ‰•Èè€%Q4´ÀÀÄœ°(€€€€€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è€Q•ÍÐ¥Ñ•´œ°(€€€€€€€€€€€€€€€Õ¹¥Ñ½‘”è€9=Lœ°(€€€€€€€€€€€€€€€…Ý…É‘•‘EÕ…¹Ñ¥Ñäè€œÄœ°(€€€€€€€€€€€€€€€•™™•Ñ¥Ù•I…Ñ”è€œÄÀÀÀœ°(€€€€€€€€€€€€€€€µ…¹Õ…±¹ÑÉäèÑÉÕ”°(€€€€€€€€€€€€€ô°(€€€€€€€€€€€t°(€€€€€€€€€ô°(€€€€€€€t°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÐÀÀ¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€Ae59Q}5QI%a}MU5}%9Y1%œô¤ì(€€€½¹ÍÐmÝ½É­t€ô…Ý…¥Ð…‘µ¥¸ñì½Õ¹ÐèÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð½Õ¹Ð ¨¤èéÑ•áÐ…Ì½Õ¹Ð™É½´Ý½É­Ì(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô(€€€€€€€…¹±•ÑÑ•É}¹Õµ‰•È€ô€‘í1=µ	µ5QI%`´‘íÉÕ¹%‘õô(€€€€ì(€€€•áÁ•Ð¡Ý½É¬ü¹½Õ¹Ð¤¹Ñ½	” œÀœ¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” ÕÁ±½…µ…±Ý…É”Í…¹¹¥¹œ€¡5¥±•ÍÑ½¹”€Ð¤œ°€ ¤€ôøì(€¥Ð É•©•ÑÌ„™±…•ÕÁ±½…‰•™½É”…¹åÑ¡¥¹œ¥ÌÍÑ½É•…¹…•ÁÑÌ±•…¸½¹•Ìœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ™±…•€ô‰Õ¥±‘Q•ÍÑA‘˜ %HµQMPµ5I-H¥¹Í¥‘”œ¤ì(€€€½¹ÍÐÉ•©•Ñ•€ô…Ý…¥ÐÍ…¹¹¥¹ÁÀ¹¥¹©•Ð¡ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€œ½…Á¤½±½„µ‘½Õµ•¹ÑÌý™¥±•¹…µ”õ™±…•¹Á‘˜œ°(€€€€€¡•…‘•ÉÌèì(€€€€€€€½½­¥”è½Ý¹•È¹½½­¥”°(€€€€€€€€àµ½É…¹¥Í…Ñ¥½¸µ¥œè½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€½¹Ñ•¹ÐµÑåÁ”œè€…ÁÁ±¥…Ñ¥½¸½Á‘˜œ°(€€€€€ô°(€€€€€Á…å±½…è™±…•°(€€€ô¤ì(€€€•áÁ•Ð¡É•©•Ñ•¹ÍÑ…ÑÕÍ½‘”°É•©•Ñ•¹‰½‘ä¤¹Ñ½	” ÐÀÀ¤ì(€€€•áÁ•Ð¡É•©•Ñ•¹©Í½¸ ¤¤¹Ñ½5…Ñ¡=‰©•Ð¡ì½‘”è€51]I}QQœô¤ì(€€€½¹ÍÐmÉ½Ýt€ô…Ý…¥Ð…‘µ¥¸ñì½Õ¹ÐèÍÑÉ¥¹œõmtù€(€€€€€Í•±•Ð½Õ¹Ð ¨¤èéÑ•áÐ…Ì½Õ¹Ð™É½´±½…}‘½Õµ•¹ÑÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô…¹Í¡„ÈÔØ€ô€‘íÉ•…Ñ•!…Í  Í¡„ÈÔØœ¤(€€€€€€€€¹ÕÁ‘…Ñ”¡™±…•¤(€€€€€€€€¹‘¥•ÍÐ ¡•àœ¥ô(€€€€ì(€€€•áÁ•Ð¡É½Üü¹½Õ¹Ð¤¹Ñ½	” œÀœ¤ì((€€€½¹ÍÐ±•…¸€ô…Ý…¥ÐÍ…¹¹¥¹ÁÀ¹¥¹©•Ð¡ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€œ½…Á¤½±½„µ‘½Õµ•¹ÑÌý™¥±•¹…µ”õ±•…¸¹Á‘˜œ°(€€€€€¡•…‘•ÉÌèì(€€€€€€€½½­¥”è½Ý¹•È¹½½­¥”°(€€€€€€€€àµ½É…¹¥Í…Ñ¥½¸µ¥œè½É…¹¥Í…Ñ¥½¹%°(€€€€€€€€½¹Ñ•¹ÐµÑåÁ”œè€…ÁÁ±¥…Ñ¥½¸½Á‘˜œ°(€€€€€ô°(€€€€€Á…å±½…è‰Õ¥±‘Q•ÍÑA‘˜ Á•É™•Ñ±ä±•…¸±•ÑÑ•Èœ¤°(€€€ô¤ì(€€€•áÁ•Ð¡±•…¸¹ÍÑ…ÑÕÍ½‘”°±•…¸¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€ô¤ì)ô¤ì(