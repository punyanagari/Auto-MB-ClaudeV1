import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  CompanyDocument,
  TenderDetail,
  TenderListResponse,
  TenderNotice,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  createDatabasePool,
  ensureClusterRoles,
  removeOrganisationResidue,
  runMigrations,
} from '@auto-mb/db';
import { assertSafeObjectKey } from '@auto-mb/documents';
import { buildApp } from '../src/app.js';

/**
 * The tender pipeline (migration 0083).
 *
 * What is proved here, in the order the module's own risks run:
 *
 *   1. propose-then-confirm — the upload reads the notice and writes
 *      NOTHING authoritative; the tender exists only after a human sends
 *      back the values they accepted, and it carries THEIR values, not
 *      the machine's;
 *   2. the intake's honest failure — a PDF with no text layer is stored
 *      anyway, flagged `failed`, and still confirmable by hand;
 *   3. checklist validity AGAINST THE CLOSING DATE — the same credential
 *      reads valid for one tender and expired for another purely from
 *      where each tender closes, with nothing stored;
 *   4. the status trail — legal moves are recorded with their trail row,
 *      illegal ones are refused by name, and submission is refused while
 *      a mandatory line is unanswered;
 *   5. award conversion — the letter is recorded against the tender and
 *      the Work is read through it, never written here;
 *   6. the walls — role for writes, and RLS for the other organisation.
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
const ownerEmail = `tender-owner-${runId}@integration.test`;
const officeEmail = `tender-office-${runId}@integration.test`;
const viewerEmail = `tender-viewer-${runId}@integration.test`;
const outsiderEmail = `tender-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** One text run: x and y in PDF points (origin bottom-left) and its text. */
type TextRun = readonly [x: number, y: number, text: string];

/**
 * A single-page PDF with a REAL text layer, placing each run at its exact
 * coordinates. Uncompressed, with a real cross-reference table, so the
 * assertions depend on Poppler's reading and not on a PDF library's
 * choices — the same construction
 * `packages/documents/test/loa-extract-roundtrip.test.ts` uses, and built
 * here rather than committed for the same reason: the fixture has to be
 * readable beside the field it causes.
 */
function buildPdf(runs: readonly TextRun[]): Buffer {
  const content = `BT\n/F1 10 Tf\n${runs
    .map(
      ([x, y, text]) =>
        `1 0 0 1 ${String(x)} ${String(y)} Tm ` +
        `(${text.replace(/([()\\])/g, '\\$1')}) Tj`,
    )
    .join('\n')}\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(Buffer.byteLength(content, 'latin1'))} >>\n` +
      `stream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(startxref)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function noticePdf(tenderNumber: string): Buffer {
  return buildPdf([
    [72, 740, 'WESTERN RAILWAY'],
    [72, 720, 'NOTICE INVITING E-TENDER'],
    [72, 690, `Tender No.: ${tenderNumber}`],
    [72, 675, 'Inviting Authority: Western Railway, Mumbai Central Division'],
    [72, 660, 'Name of Work: Supply and commissioning of passenger information'],
    [72, 648, 'systems at twelve stations.'],
    [72, 630, 'Closing Date & Time: 18-09-2026 15:00 hrs'],
    [72, 615, 'Estimated Cost: Rs. 8,40,00,000/-'],
    [72, 600, 'EMD: Rs 16.80 Lakh'],
    [72, 585, 'Eligibility Criteria: Similar railway S&T works in three years.'],
  ]);
}

/** A structurally valid PDF with no text layer at all: the magic-byte
 * guard accepts it, and Poppler finds nothing to read. */
let scanCounter = 0;
function imageOnlyPdf(): Buffer {
  scanCounter += 1;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Seq ${String(scanCounter)} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );
}

let pdfCounter = 0;
function loaPdf(): Buffer {
  pdfCounter += 1;
  return buildPdf([
    [72, 720, 'LETTER OF ACCEPTANCE'],
    [72, 700, `Letter No.: LOA/${String(pdfCounter)}/2026`],
  ]);
}

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let viewer: CookieJar;
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

async function uploadNotice(
  jar: CookieJar,
  body: Buffer,
  organisation = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: '/api/tender-notices?filename=nit.pdf',
    organisationId: organisation,
    headers: { 'content-type': 'application/pdf' },
    payload: body,
  });
}

/** The whole intake in one call, for the cases whose subject is what
 * happens AFTER a tender exists. */
async function createTender(
  overrides: Partial<{
    tenderNumber: string;
    authority: string;
    title: string;
    bidClosesAtLocal: string;
    estimatedValue: string;
    emdAmount: string;
    eligibilitySummary: string;
  }> = {},
): Promise<TenderDetail> {
  const tenderNumber = overrides.tenderNumber ?? `WR/${randomBytes(4).toString('hex')}`;
  const uploaded = await uploadNotice(office, noticePdf(tenderNumber));
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const notice = uploaded.json<TenderNotice>();
  const confirmed = await authed(office, {
    method: 'POST',
    url: `/api/tender-notices/${notice.id}/confirm`,
    organisationId,
    payload: {
      tenderNumber,
      authority: 'Western Railway',
      title: 'Supply and commissioning of passenger information systems',
      bidClosesAtLocal: '2026-09-18T15:00',
      ...overrides,
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(201);
  return confirmed.json<TenderDetail>();
}

async function addLine(
  tenderId: string,
  title: string,
  mandatory = true,
): Promise<TenderDetail> {
  const response = await authed(office, {
    method: 'POST',
    url: `/api/tenders/${tenderId}/checklist`,
    organisationId,
    payload: { title, mandatory },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<TenderDetail>();
}

async function attach(
  tenderId: string,
  itemId: string,
  companyDocumentId: string | null,
) {
  return authed(office, {
    method: 'POST',
    url: `/api/tenders/${tenderId}/checklist/${itemId}/document`,
    organisationId,
    payload: { companyDocumentId },
  });
}

async function transition(
  tenderId: string,
  status: string,
  extra: Record<string, string> = {},
) {
  return authed(office, {
    method: 'POST',
    url: `/api/tenders/${tenderId}/status`,
    organisationId,
    payload: { status, ...extra },
  });
}

/** `YYYY-MM-DD`, `days` from today. Relative because a hard-coded date is
 * a test that starts failing on a Tuesday in some future year. */
function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A credential in the library (migration 0079), which is what the
 * checklist consumes. */
async function credential(
  title: string,
  expiresOn?: string,
  category = 'statutory',
): Promise<CompanyDocument> {
  const query = new URLSearchParams({
    title,
    category,
    filename: 'credential.pdf',
    ...(expiresOn === undefined ? {} : { expiresOn }),
  });
  const response = await authed(office, {
    method: 'POST',
    url: `/api/company-documents?${query.toString()}`,
    organisationId,
    headers: { 'content-type': 'application/pdf' },
    payload: imageOnlyPdf(),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<CompanyDocument>();
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-tenders-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-tender-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    // The upload throttle is 30 in ten minutes in production, and this
    // suite posts a notice per case. Raised rather than worked around:
    // `test/ops.integration.test.ts` owns the throttle's own proof, and
    // an unrelated suite tripping it would only teach the next author to
    // delete cases. Nothing else about the gate changes.
    rateLimits: { upload: { windowMs: 60_000, max: 500 } },
  });

  owner = await signUp(ownerEmail, 'Tender Owner');
  office = await signUp(officeEmail, 'Tender Office');
  viewer = await signUp(viewerEmail, 'Tender Viewer');
  outsider = await signUp(outsiderEmail, 'Tender Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Tender Constructions', slug: `tender-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Tender Outsiders', slug: `tender-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [viewerEmail, 'viewer'],
  ] as const) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role },
    });
    expect(added.statusCode, added.body).toBe(201);
  }
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

describe('NIT intake proposes and never commits', () => {
  it('reads the notice and creates no tender until a human confirms', async () => {
    const tenderNumber = `WR/PROPOSE/${runId}`;
    const response = await uploadNotice(office, noticePdf(tenderNumber));
    expect(response.statusCode, response.body).toBe(201);
    const notice = response.json<TenderNotice>();

    expect(notice.extractionStatus).toBe('review');
    expect(notice.confirmedTenderId).toBeNull();
    expect(notice.proposal?.tenderNumber.value).toBe(tenderNumber);
    expect(notice.proposal?.authority.value).toBe(
      'Western Railway, Mumbai Central Division',
    );
    expect(notice.proposal?.bidClosesAtLocal.value).toBe('2026-09-18T15:00');
    expect(notice.proposal?.estimatedValue.value).toBe('84000000.00');
    expect(notice.proposal?.emdAmount.value).toBe('1680000.00');

    // The whole point of rule 10: the extraction has run and there is
    // still no authoritative record anywhere.
    const [count] = await admin<{ n: string }[]>`
      select count(*)::text as n from tenders
      where organisation_id = ${organisationId}
        and tender_number = ${tenderNumber}
    `;
    expect(count?.n).toBe('0');

    // The stored object lives under a key the traversal guard accepts.
    const [row] = await admin<{ object_key: string }[]>`
      select object_key from tender_notices where id = ${notice.id}
    `;
    expect(row?.object_key.startsWith(`${organisationId}/nit/`)).toBe(true);
    expect(() => {
      assertSafeObjectKey(row?.object_key ?? '');
    }).not.toThrow();
  });

  it('records the values the reviewer sent, not the ones the machine read', async () => {
    const tenderNumber = `WR/CORRECTED/${runId}`;
    const uploaded = await uploadNotice(office, noticePdf(tenderNumber));
    const notice = uploaded.json<TenderNotice>();

    const confirmed = await authed(office, {
      method: 'POST',
      url: `/api/tender-notices/${notice.id}/confirm`,
      organisationId,
      payload: {
        tenderNumber,
        // The reviewer disagreed with the reading and typed the division
        // out in full. The record must be theirs.
        authority: 'Western Railway — Mumbai Central',
        title: 'Supply and commissioning of passenger information systems',
        bidClosesAtLocal: '2026-09-18T15:00',
        estimatedValue: '84000000.00',
        emdAmount: '1680000.00',
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const tender = confirmed.json<TenderDetail>();
    expect(tender.authority).toBe('Western Railway — Mumbai Central');
    expect(tender.status).toBe('drafted');
    expect(tender.noticeFilename).toBe('nit.pdf');
    // The wall clock survives the round trip through the organisation's
    // timezone: a 15:00 close is still 15:00 when it is read back.
    expect(tender.bidClosesAtLocal).toBe('2026-09-18T15:00');
    // Creation writes the first row of the trail.
    expect(tender.statusEvents).toHaveLength(1);
    expect(tender.statusEvents[0]?.fromStatus).toBeNull();
    expect(tender.statusEvents[0]?.toStatus).toBe('drafted');

    // One notice, one tender.
    const again = await authed(office, {
      method: 'POST',
      url: `/api/tender-notices/${notice.id}/confirm`,
      organisationId,
      payload: {
        tenderNumber: `${tenderNumber}-B`,
        authority: 'Western Railway',
        title: 'A second tender from the same notice',
        bidClosesAtLocal: '2026-09-18T15:00',
      },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('TENDER_NOTICE_ALREADY_CONFIRMED');
  });

  it('stores a scan it cannot read and still lets it be typed in by hand', async () => {
    const response = await uploadNotice(office, imageOnlyPdf());
    expect(response.statusCode, response.body).toBe(201);
    const notice = response.json<TenderNotice>();
    expect(notice.extractionStatus).toBe('failed');
    expect(notice.proposal).toBeNull();
    expect(notice.extractionError).not.toBeNull();

    const confirmed = await authed(office, {
      method: 'POST',
      url: `/api/tender-notices/${notice.id}/confirm`,
      organisationId,
      payload: {
        tenderNumber: `WR/TYPED/${runId}`,
        authority: 'Central Railway',
        title: 'Typed from a photocopied notice',
        bidClosesAtLocal: '2026-11-02T14:30',
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
  });

  it('refuses a closing date the calendar does not have with a 400, not a 500', async () => {
    const uploaded = await uploadNotice(office, noticePdf(`WR/BADDATE/${runId}`));
    const response = await authed(office, {
      method: 'POST',
      url: `/api/tender-notices/${uploaded.json<TenderNotice>().id}/confirm`,
      organisationId,
      payload: {
        tenderNumber: `WR/BADDATE/${runId}`,
        authority: 'Western Railway',
        title: 'A tender closing on the thirty-first of February',
        bidClosesAtLocal: '2027-02-31T15:00',
      },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('refuses a filename of nothing but spaces in words', async () => {
    const response = await authed(office, {
      method: 'POST',
      url: '/api/tender-notices?filename=%20%20%20',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: noticePdf(`WR/BLANKNAME/${runId}`),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('FIELD_TOO_SHORT');
  });

  it('refuses a body that is not a PDF', async () => {
    const response = await uploadNotice(office, Buffer.from('not a pdf at all'));
    expect(response.statusCode).toBe(400);
  });

  it('refuses a second tender with the same number, case-folded', async () => {
    const tenderNumber = `WR/DUP/${runId}`;
    await createTender({ tenderNumber });
    const uploaded = await uploadNotice(office, noticePdf(tenderNumber));
    const notice = uploaded.json<TenderNotice>();
    const clash = await authed(office, {
      method: 'POST',
      url: `/api/tender-notices/${notice.id}/confirm`,
      organisationId,
      payload: {
        tenderNumber: tenderNumber.toLowerCase(),
        authority: 'Western Railway',
        title: 'The same tender typed in lower case',
        bidClosesAtLocal: '2026-09-18T15:00',
      },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json<{ code: string }>().code).toBe('TENDER_EXISTS');
  });
});

describe('the bid checklist reads validity against the closing date', () => {
  it('calls the same credential valid for one tender and expired for another', async () => {
    // One certificate, lapsing in 40 days.
    const gst = await credential(`GST registration ${runId}`, isoDaysFromToday(40));

    // Two tenders: one closing before that, one closing after.
    const soon = await createTender({
      tenderNumber: `WR/SOON/${runId}`,
      bidClosesAtLocal: `${isoDaysFromToday(10)}T15:00`,
    });
    const later = await createTender({
      tenderNumber: `WR/LATER/${runId}`,
      bidClosesAtLocal: `${isoDaysFromToday(90)}T15:00`,
    });

    for (const tender of [soon, later]) {
      const withLine = await addLine(tender.id, 'GST registration certificate');
      const line = withLine.checklist[0];
      expect(line?.validity).toBeNull();
      expect(line?.blocking).toBe(true);
      const attached = await attach(tender.id, line?.id ?? '', gst.id);
      expect(attached.statusCode, attached.body).toBe(200);
    }

    const soonAfter = await authed(office, {
      method: 'GET',
      url: `/api/tenders/${soon.id}`,
      organisationId,
    });
    const laterAfter = await authed(office, {
      method: 'GET',
      url: `/api/tenders/${later.id}`,
      organisationId,
    });

    // Closing in 10 days, certificate good for 40: valid at close, and
    // inside the 60-day window afterwards, so "expiring" rather than a
    // flat green — the renewal is due while the contract is being won.
    const soonLine = soonAfter.json<TenderDetail>().checklist[0];
    expect(soonLine?.validity).toBe('expiring');
    expect(soonLine?.expiresInDaysAtClose).toBe(30);
    expect(soonLine?.blocking).toBe(false);

    // Closing in 90 days, certificate dead at 40: the bid would be opened
    // with a lapsed certificate attached. Blocking.
    const laterLine = laterAfter.json<TenderDetail>().checklist[0];
    expect(laterLine?.validity).toBe('expired');
    expect(laterLine?.expiresInDaysAtClose).toBe(-50);
    expect(laterLine?.blocking).toBe(true);
  });

  it('leaves a credential with no expiry outside the question', async () => {
    const pan = await credential(`PAN card ${runId}`);
    const tender = await createTender({ tenderNumber: `WR/PAN/${runId}` });
    const withLine = await addLine(tender.id, 'PAN card');
    const attached = await attach(tender.id, withLine.checklist[0]?.id ?? '', pan.id);
    const line = attached.json<TenderDetail>().checklist[0];
    expect(line?.validity).toBe('none');
    expect(line?.expiresInDaysAtClose).toBeNull();
    expect(line?.blocking).toBe(false);
  });

  it('does not block on an optional line, and detaches back to unanswered', async () => {
    const iso = await credential(`ISO 9001 ${runId}`, isoDaysFromToday(400));
    const tender = await createTender({ tenderNumber: `WR/OPT/${runId}` });
    const withLine = await addLine(tender.id, 'ISO 9001 certificate', false);
    const line = withLine.checklist[0];
    expect(line?.blocking).toBe(false);

    const attached = await attach(tender.id, line?.id ?? '', iso.id);
    expect(attached.json<TenderDetail>().checklist[0]?.validity).toBe('valid');

    const detached = await attach(tender.id, line?.id ?? '', null);
    expect(detached.statusCode, detached.body).toBe(200);
    const after = detached.json<TenderDetail>().checklist[0];
    expect(after?.companyDocumentId).toBeNull();
    expect(after?.validity).toBeNull();
  });

  it('refuses a duplicate line and an archived credential', async () => {
    const retired = await credential(`Retired letter ${runId}`);
    const archived = await authed(office, {
      method: 'POST',
      url: `/api/company-documents/${retired.id}/archive`,
      organisationId,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const tender = await createTender({ tenderNumber: `WR/ARCH/${runId}` });
    const withLine = await addLine(tender.id, 'Bank solvency certificate');
    const duplicate = await authed(office, {
      method: 'POST',
      url: `/api/tenders/${tender.id}/checklist`,
      organisationId,
      payload: { title: 'bank solvency certificate' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ code: string }>().code).toBe(
      'TENDER_CHECKLIST_ITEM_EXISTS',
    );

    const attached = await attach(
      tender.id,
      withLine.checklist[0]?.id ?? '',
      retired.id,
    );
    expect(attached.statusCode).toBe(409);
    expect(attached.json<{ code: string }>().code).toBe('COMPANY_DOCUMENT_ARCHIVED');
  });

  it('removes a mistyped line while the bid is a draft, and never after', async () => {
    const tender = await createTender({ tenderNumber: `WR/RM/${runId}` });
    const withLine = await addLine(tender.id, 'Powr of Attorney', false);
    const removed = await authed(office, {
      method: 'DELETE',
      url: `/api/tenders/${tender.id}/checklist/${withLine.checklist[0]?.id ?? ''}`,
      organisationId,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json<TenderDetail>().checklist).toHaveLength(0);

    const submitted = await transition(tender.id, 'submitted');
    expect(submitted.statusCode, submitted.body).toBe(200);
    const locked = await authed(office, {
      method: 'POST',
      url: `/api/tenders/${tender.id}/checklist`,
      organisationId,
      payload: { title: 'Too late' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json<{ code: string }>().code).toBe('TENDER_CHECKLIST_LOCKED');
  });
});

describe('the iREPS status trail', () => {
  it('records each step with its trail row and the acknowledgement', async () => {
    const tender = await createTender({ tenderNumber: `WR/TRAIL/${runId}` });

    const submitted = await transition(tender.id, 'submitted', {
      irepsReference: 'IREPS-ACK-99321',
      note: 'Uploaded at 14:40 by the office.',
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json<TenderDetail>().irepsReference).toBe('IREPS-ACK-99321');

    const opened = await transition(tender.id, 'opened');
    expect(opened.statusCode, opened.body).toBe(200);

    const awarded = await transition(tender.id, 'awarded');
    expect(awarded.statusCode, awarded.body).toBe(200);
    const detail = awarded.json<TenderDetail>();
    expect(detail.status).toBe('awarded');
    expect(detail.statusEvents.map((event) => event.toStatus)).toEqual([
      'drafted',
      'submitted',
      'opened',
      'awarded',
    ]);
    // The acknowledgement is not overwritten by a later step that does
    // not carry one.
    expect(detail.irepsReference).toBe('IREPS-ACK-99321');
  });

  it('refuses a move the trail does not allow, and a terminal one entirely', async () => {
    const tender = await createTender({ tenderNumber: `WR/ILLEGAL/${runId}` });

    const skipped = await transition(tender.id, 'opened');
    expect(skipped.statusCode).toBe(409);
    expect(skipped.json<{ code: string }>().code).toBe('TENDER_STATUS_CONFLICT');

    expect((await transition(tender.id, 'lost')).statusCode).toBe(200);
    const revived = await transition(tender.id, 'submitted');
    expect(revived.statusCode).toBe(409);
    expect(revived.json<{ message: string }>().message).toMatch(/final|cannot move/);
  });

  it('refuses a submission while a mandatory line is unanswered', async () => {
    const tender = await createTender({ tenderNumber: `WR/BLOCK/${runId}` });
    await addLine(tender.id, 'Bank solvency certificate');

    const refused = await transition(tender.id, 'submitted');
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ message: string }>().message).toMatch(/1 mandatory/);

    const solvency = await credential(`Bank solvency ${runId}`, isoDaysFromToday(365));
    const detail = await authed(office, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId,
    });
    await attach(
      tender.id,
      detail.json<TenderDetail>().checklist[0]?.id ?? '',
      solvency.id,
    );
    expect((await transition(tender.id, 'submitted')).statusCode).toBe(200);
  });
});

describe('award conversion', () => {
  it('records the letter against the tender and reads the Work through it', async () => {
    const tender = await createTender({ tenderNumber: `WR/AWARD/${runId}` });
    await transition(tender.id, 'submitted');
    await transition(tender.id, 'awarded');

    const uploaded = await authed(office, {
      method: 'POST',
      url: '/api/loa-documents?filename=loa.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: loaPdf(),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const loaDocumentId = uploaded.json<{ id: string }>().id;

    const linked = await authed(office, {
      method: 'POST',
      url: `/api/tenders/${tender.id}/award-letter`,
      organisationId,
      payload: { loaDocumentId },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    const detail = linked.json<TenderDetail>();
    expect(detail.award?.loaDocumentId).toBe(loaDocumentId);
    expect(detail.award?.loaFilename).toBe('loa.pdf');
    // The letter has not been confirmed into a Work yet, and the record
    // says exactly that rather than pretending.
    expect(detail.award?.workId).toBeNull();

    // One letter, one tender.
    const second = await createTender({ tenderNumber: `WR/AWARD2/${runId}` });
    await transition(second.id, 'submitted');
    await transition(second.id, 'awarded');
    const stolen = await authed(office, {
      method: 'POST',
      url: `/api/tenders/${second.id}/award-letter`,
      organisationId,
      payload: { loaDocumentId },
    });
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json<{ code: string }>().code).toBe('TENDER_ALREADY_AWARDED');
  });

  it('takes the same letter twice and a different one never', async () => {
    const tender = await createTender({ tenderNumber: `WR/RELINK/${runId}` });
    await transition(tender.id, 'submitted');
    await transition(tender.id, 'awarded');

    const letters = await Promise.all([
      authed(office, {
        method: 'POST',
        url: '/api/loa-documents?filename=first.pdf',
        organisationId,
        headers: { 'content-type': 'application/pdf' },
        payload: loaPdf(),
      }),
      authed(office, {
        method: 'POST',
        url: '/api/loa-documents?filename=second.pdf',
        organisationId,
        headers: { 'content-type': 'application/pdf' },
        payload: loaPdf(),
      }),
    ]);
    const [firstId, secondId] = letters.map(
      (response) => response.json<{ id: string }>().id,
    );

    const link = async (loaDocumentId: string) =>
      authed(office, {
        method: 'POST',
        url: `/api/tenders/${tender.id}/award-letter`,
        organisationId,
        payload: { loaDocumentId },
      });

    expect((await link(firstId as string)).statusCode).toBe(200);
    // The upload screen retries the link, so recording the SAME letter
    // again has to keep working.
    expect((await link(firstId as string)).statusCode).toBe(200);

    // A DIFFERENT letter would move the tender onto another Work, because
    // the Work is read through the letter. Refused.
    const repointed = await link(secondId as string);
    expect(repointed.statusCode).toBe(409);
    expect(repointed.json<{ code: string }>().code).toBe('TENDER_ALREADY_AWARDED');
    const still = await authed(office, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId,
    });
    expect(still.json<TenderDetail>().award?.loaDocumentId).toBe(firstId);
  });

  it('refuses a letter against a tender that was not won', async () => {
    const tender = await createTender({ tenderNumber: `WR/NOTWON/${runId}` });
    const uploaded = await authed(office, {
      method: 'POST',
      url: '/api/loa-documents?filename=loa.pdf',
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: loaPdf(),
    });
    const refused = await authed(office, {
      method: 'POST',
      url: `/api/tenders/${tender.id}/award-letter`,
      organisationId,
      payload: { loaDocumentId: uploaded.json<{ id: string }>().id },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('TENDER_NOT_AWARDED');
  });
});

describe('under concurrency', () => {
  /** How many of a pair answered with each status, so a race reads as a
   * count rather than as an argument about which request "won". */
  function statuses(responses: readonly { statusCode: number }[]): number[] {
    return responses.map((response) => response.statusCode).sort((a, b) => a - b);
  }

  it('confirms one notice once when two reviewers press the button together', async () => {
    const tenderNumber = `WR/RACE-NOTICE/${runId}`;
    const uploaded = await uploadNotice(office, noticePdf(tenderNumber));
    const notice = uploaded.json<TenderNotice>();
    const body = {
      authority: 'Western Railway',
      title: 'Supply and commissioning of passenger information systems',
      bidClosesAtLocal: '2026-09-18T15:00',
    };

    // Two DIFFERENT tender numbers, so the tender-number index cannot be
    // what refuses: the subject here is the notice's own one-way
    // confirmation link and the row lock that serialises it.
    const [first, second] = await Promise.all([
      authed(office, {
        method: 'POST',
        url: `/api/tender-notices/${notice.id}/confirm`,
        organisationId,
        payload: { ...body, tenderNumber: `${tenderNumber}-A` },
      }),
      authed(office, {
        method: 'POST',
        url: `/api/tender-notices/${notice.id}/confirm`,
        organisationId,
        payload: { ...body, tenderNumber: `${tenderNumber}-B` },
      }),
    ]);

    expect(statuses([first, second])).toEqual([201, 409]);
    const [count] = await admin<{ n: string }[]>`
      select count(*)::text as n from tender_notices
      where id = ${notice.id} and confirmed_tender_id is not null
    `;
    expect(count?.n).toBe('1');
  });

  it('admits one tender per number when two confirmations race for it', async () => {
    const tenderNumber = `WR/RACE-NUMBER/${runId}`;
    const [noticeA, noticeB] = await Promise.all([
      uploadNotice(office, noticePdf(`${tenderNumber}-src-a`)),
      uploadNotice(office, noticePdf(`${tenderNumber}-src-b`)),
    ]);
    const body = {
      tenderNumber,
      authority: 'Western Railway',
      title: 'Two notices, one tender number',
      bidClosesAtLocal: '2026-09-18T15:00',
    };

    const [first, second] = await Promise.all([
      authed(office, {
        method: 'POST',
        url: `/api/tender-notices/${noticeA.json<TenderNotice>().id}/confirm`,
        organisationId,
        payload: body,
      }),
      authed(office, {
        method: 'POST',
        // Case-folded, because the index is: the loser must be refused by
        // the index rather than admitted as a second spelling.
        url: `/api/tender-notices/${noticeB.json<TenderNotice>().id}/confirm`,
        organisationId,
        payload: { ...body, tenderNumber: tenderNumber.toLowerCase() },
      }),
    ]);

    expect(statuses([first, second])).toEqual([201, 409]);
    const [count] = await admin<{ n: string }[]>`
      select count(*)::text as n from tenders
      where organisation_id = ${organisationId}
        and lower(tender_number) = ${tenderNumber.toLowerCase()}
    `;
    expect(count?.n).toBe('1');
  });

  it('never records a submission beside a checklist line added in the same moment', async () => {
    const tender = await createTender({ tenderNumber: `WR/RACE-LOCK/${runId}` });

    // The submission passes its own blocking check (the checklist is
    // empty) while a mandatory line is being inserted. Both take the
    // tender's row lock, so one of them sees the other's result: either
    // the line lands first and the submission is refused, or the
    // submission lands first and the line is refused as locked. What must
    // not happen is BOTH succeeding, which would leave a submitted bid
    // carrying a blocking line.
    const [submitted, added] = await Promise.all([
      transition(tender.id, 'submitted'),
      authed(office, {
        method: 'POST',
        url: `/api/tenders/${tender.id}/checklist`,
        organisationId,
        payload: { title: 'Bank solvency certificate' },
      }),
    ]);

    expect(statuses([submitted, added])).toEqual([expect.any(Number), 409]);
    expect([submitted.statusCode, added.statusCode]).toContain(409);

    const detail = await authed(office, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId,
    });
    const after = detail.json<TenderDetail>();
    if (after.status === 'submitted') expect(after.checklistBlocking).toBe(0);
  });
});

describe('the checklist keeps reading its credential', () => {
  it('blocks the bid again when an attached credential is archived afterwards', async () => {
    const licence = await credential(`Labour licence ${runId}`, isoDaysFromToday(365));
    const tender = await createTender({ tenderNumber: `WR/ARCHIVE-AFTER/${runId}` });
    const withLine = await addLine(tender.id, 'Labour licence');
    const attached = await attach(
      tender.id,
      withLine.checklist[0]?.id ?? '',
      licence.id,
    );
    expect(attached.json<TenderDetail>().checklist[0]?.validity).toBe('valid');
    expect(attached.json<TenderDetail>().checklist[0]?.blocking).toBe(false);

    // Archiving happens in the library, which knows nothing about bids.
    const archived = await authed(office, {
      method: 'POST',
      url: `/api/company-documents/${licence.id}/archive`,
      organisationId,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const after = await authed(office, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId,
    });
    const line = after.json<TenderDetail>().checklist[0];
    // Archived is its own fact, NOT a validity reading: the certificate
    // is still in date, and telling an operator it "expired" would send
    // them to renew a document that needs putting back in the library.
    expect(line?.companyDocumentArchived).toBe(true);
    expect(line?.validity).toBe('valid');
    expect(line?.blocking).toBe(true);

    // And the submission it was blocking is refused again.
    const refused = await transition(tender.id, 'submitted');
    expect(refused.statusCode).toBe(409);
  });
});

describe('the extraction is a proposal, not a promise', () => {
  it('serves a stable code for a scan it could not read, never the extractor diagnostic', async () => {
    const response = await uploadNotice(office, imageOnlyPdf());
    expect(response.statusCode, response.body).toBe(201);
    const notice = response.json<TenderNotice>();
    expect(notice.extractionStatus).toBe('failed');
    // A closed set. The thrown message names the temporary file the
    // bytes were written to and echoes whatever the binary said about
    // the document, and this column is permanent and exported.
    expect(notice.extractionError).toBe('pdf_unreadable');

    const [row] = await admin<{ payload: { error?: string } }[]>`
      select extraction_payload as payload from tender_notices
      where id = ${notice.id}
    `;
    expect(row?.payload.error).toBe('pdf_unreadable');
    // Nothing that looks like a path, an argv or a stderr echo.
    expect(JSON.stringify(row?.payload)).not.toMatch(
      /pdftotext|Command failed|[/\\]tmp/i,
    );
  });

  it('degrades a payload from an older shape to no proposal instead of a 500', async () => {
    // A row as some earlier version of this code might have left it: the
    // review object is there, the summary the screen counts from is not.
    // Written directly, because the 0083 evidence guard refuses to let
    // one be EDITED into existence — which is itself the right answer,
    // and is why this shape can only ever arrive from an older writer.
    const [older] = await admin<{ id: string }[]>`
      insert into tender_notices (
        organisation_id, object_key, original_filename, sha256, media_type,
        size_bytes, extraction_status, extraction_payload, uploaded_by_user_id
      )
      values (
        ${organisationId},
        ${`${organisationId}/nit/older-${runId}.pdf`},
        'older.pdf', ${'c'.repeat(64)}, 'application/pdf', 1024, 'review',
        ${admin.json({
          sourceText: 'x',
          review: { tenderNumber: { value: 'A', raw: null, needsReview: false } },
        })},
        'seed-user'
      )
      returning id
    `;

    const response = await authed(office, {
      method: 'GET',
      url: `/api/tender-notices/${older?.id ?? ''}`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const served = response.json<TenderNotice>();
    expect(served.proposal).toBeNull();
    expect(served.extractionError).toBeNull();
  });
});

describe('the restricted credential category', () => {
  it('keeps a financial credential nameless to a viewer without moving the count', async () => {
    const solvency = await credential(
      `Restricted solvency ${runId}`,
      isoDaysFromToday(400),
      'financial',
    );
    const tender = await createTender({ tenderNumber: `WR/RESTRICTED/${runId}` });
    const withLine = await addLine(tender.id, 'Bank solvency certificate');
    await attach(tender.id, withLine.checklist[0]?.id ?? '', solvency.id);

    const asWriter = await authed(office, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId,
    });
    const asViewer = await authed(viewer, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId,
    });
    expect(asViewer.statusCode, asViewer.body).toBe(200);

    const writerLine = asWriter.json<TenderDetail>().checklist[0];
    const viewerLine = asViewer.json<TenderDetail>().checklist[0];

    expect(writerLine?.restricted).toBe(false);
    expect(writerLine?.companyDocumentTitle).toBe(`Restricted solvency ${runId}`);

    // The identity is gone; everything the checklist is FOR survives.
    expect(viewerLine?.restricted).toBe(true);
    expect(viewerLine?.companyDocumentId).toBeNull();
    expect(viewerLine?.companyDocumentTitle).toBeNull();
    expect(viewerLine?.companyDocumentVersionNumber).toBeNull();
    expect(viewerLine?.expiresOn).toBeNull();
    expect(viewerLine?.expiresInDaysAtClose).toBeNull();

    // The two readers agree on every number, which is the whole reason
    // this redacts rather than excludes.
    expect(viewerLine?.validity).toBe(writerLine?.validity);
    expect(viewerLine?.blocking).toBe(writerLine?.blocking);
    expect(asViewer.json<TenderDetail>().checklistTotal).toBe(
      asWriter.json<TenderDetail>().checklistTotal,
    );
    expect(asViewer.json<TenderDetail>().checklistBlocking).toBe(
      asWriter.json<TenderDetail>().checklistBlocking,
    );
  });

  it('leaves every other category named for everyone', async () => {
    const pan = await credential(`PAN open ${runId}`);
    const tender = await createTender({ tenderNumber: `WR/OPENCAT/${runId}` });
    const withLine = await addLine(tender.id, 'PAN card');
    await attach(tender.id, withLine.checklist[0]?.id ?? '', pan.id);

    const asViewer = await authed(viewer, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId,
    });
    const line = asViewer.json<TenderDetail>().checklist[0];
    expect(line?.restricted).toBe(false);
    expect(line?.companyDocumentTitle).toBe(`PAN open ${runId}`);
  });
});

describe('correcting the facts of a draft', () => {
  it('fixes a mistyped notice and refuses once the bid has gone out', async () => {
    const tender = await createTender({ tenderNumber: `WR/TYPO/${runId}` });

    const corrected = await authed(office, {
      method: 'PATCH',
      url: `/api/tenders/${tender.id}`,
      organisationId,
      payload: {
        tenderNumber: `WR/TYPO-FIXED/${runId}`,
        authority: 'Central Railway',
        title: 'The name of work as the notice actually prints it',
        bidClosesAtLocal: '2026-10-09T11:30',
        estimatedValue: '1250000.00',
      },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const detail = corrected.json<TenderDetail>();
    expect(detail.tenderNumber).toBe(`WR/TYPO-FIXED/${runId}`);
    expect(detail.authority).toBe('Central Railway');
    // The closing moment is corrected through the organisation's own
    // timezone, exactly as the confirmation writes it.
    expect(detail.bidClosesAtLocal).toBe('2026-10-09T11:30');
    expect(detail.estimatedValue).toBe('1250000.00');

    await addLine(tender.id, 'PAN card', false);
    expect((await transition(tender.id, 'submitted')).statusCode).toBe(200);

    const locked = await authed(office, {
      method: 'PATCH',
      url: `/api/tenders/${tender.id}`,
      organisationId,
      payload: {
        tenderNumber: `WR/TOO-LATE/${runId}`,
        authority: 'Central Railway',
        title: 'Renamed after the bid went out',
        bidClosesAtLocal: '2026-10-09T11:30',
      },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json<{ code: string }>().code).toBe('TENDER_STATUS_CONFLICT');
  });

  it('refuses a correction onto a number another tender already holds', async () => {
    const first = await createTender({ tenderNumber: `WR/HELD/${runId}` });
    const second = await createTender({ tenderNumber: `WR/MOVER/${runId}` });
    const clash = await authed(office, {
      method: 'PATCH',
      url: `/api/tenders/${second.id}`,
      organisationId,
      payload: {
        tenderNumber: `WR/HELD/${runId}`,
        authority: 'Western Railway',
        title: 'Renamed onto a number that is taken',
        bidClosesAtLocal: '2026-09-18T15:00',
      },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json<{ code: string }>().code).toBe('TENDER_EXISTS');
    expect(first.tenderNumber).toBe(`WR/HELD/${runId}`);
  });

  it('refuses a viewer', async () => {
    const tender = await createTender({ tenderNumber: `WR/VIEWERPATCH/${runId}` });
    const refused = await authed(viewer, {
      method: 'PATCH',
      url: `/api/tenders/${tender.id}`,
      organisationId,
      payload: {
        tenderNumber: `WR/VIEWERPATCH-2/${runId}`,
        authority: 'Western Railway',
        title: 'A viewer should not reach this',
        bidClosesAtLocal: '2026-09-18T15:00',
      },
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe('the database guards, attacked directly', () => {
  it('refuses to re-point a tender or its checklist line at another tenant', async () => {
    const tender = await createTender({ tenderNumber: `WR/PROVENANCE/${runId}` });
    await addLine(tender.id, 'PAN card', false);

    await expect(
      admin`
        update tenders set organisation_id = ${outsiderOrganisationId}
        where id = ${tender.id}
      `,
    ).rejects.toThrow(/tenant and provenance are immutable/);

    await expect(
      admin`update tenders set created_at = now() where id = ${tender.id}`,
    ).rejects.toThrow(/tenant and provenance are immutable/);

    const [line] = await admin<{ id: string }[]>`
      select id from tender_checklist_items where tender_id = ${tender.id}
    `;
    const other = await createTender({ tenderNumber: `WR/PROVENANCE-2/${runId}` });
    await expect(
      admin`
        update tender_checklist_items set tender_id = ${other.id}
        where id = ${line?.id ?? ''}
      `,
    ).rejects.toThrow(/tender and provenance are immutable/);
  });

  it('refuses to relabel who vouched for an attached credential', async () => {
    const pan = await credential(`PAN vouch ${runId}`);
    const tender = await createTender({ tenderNumber: `WR/VOUCH/${runId}` });
    const withLine = await addLine(tender.id, 'PAN card');
    await attach(tender.id, withLine.checklist[0]?.id ?? '', pan.id);

    await expect(
      admin`
        update tender_checklist_items set attached_by_user_id = 'somebody-else'
        where id = ${withLine.checklist[0]?.id ?? ''}
      `,
    ).rejects.toThrow(/moves only with its credential/);
  });
});

describe('the walls', () => {
  it('lets a viewer read the pipeline and write none of it', async () => {
    const tender = await createTender({ tenderNumber: `WR/VIEWER/${runId}` });

    const list = await authed(viewer, {
      method: 'GET',
      url: '/api/tenders',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      list.json<TenderListResponse>().tenders.some((row) => row.id === tender.id),
    ).toBe(true);

    for (const attempt of [
      authed(viewer, {
        method: 'POST',
        url: '/api/tender-notices?filename=nit.pdf',
        organisationId,
        headers: { 'content-type': 'application/pdf' },
        payload: noticePdf(`WR/VIEWER-UPLOAD/${runId}`),
      }),
      authed(viewer, {
        method: 'POST',
        url: `/api/tenders/${tender.id}/checklist`,
        organisationId,
        payload: { title: 'Something a viewer wants' },
      }),
      authed(viewer, {
        method: 'POST',
        url: `/api/tenders/${tender.id}/status`,
        organisationId,
        payload: { status: 'submitted' },
      }),
    ]) {
      const response = await attempt;
      expect(response.statusCode, response.body).toBe(403);
    }
  });

  it('hides one organisation’s tenders from another', async () => {
    const tender = await createTender({ tenderNumber: `WR/RLS/${runId}` });

    // The outsider is a member of their own organisation only, so both
    // the header they hold and the header they do not are refused —
    // the first by RLS finding nothing, the second by the membership
    // binding.
    const withOwnHeader = await authed(outsider, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId: outsiderOrganisationId,
    });
    expect(withOwnHeader.statusCode).toBe(404);

    const withForeignHeader = await authed(outsider, {
      method: 'GET',
      url: `/api/tenders/${tender.id}`,
      organisationId,
    });
    expect(withForeignHeader.statusCode).toBe(403);

    const foreignList = await authed(outsider, {
      method: 'GET',
      url: '/api/tenders',
      organisationId: outsiderOrganisationId,
    });
    expect(foreignList.statusCode, foreignList.body).toBe(200);
    expect(foreignList.json<TenderListResponse>().tenders).toHaveLength(0);

    // And the notice's bytes are no more reachable than its row.
    const [notice] = await admin<{ id: string }[]>`
      select id from tender_notices where confirmed_tender_id = ${tender.id}
    `;
    const stolenFile = await authed(outsider, {
      method: 'GET',
      url: `/api/tender-notices/${notice?.id ?? ''}/file`,
      organisationId: outsiderOrganisationId,
    });
    expect(stolenFile.statusCode).toBe(404);
  });

  it('serves the notice back to its own organisation as a PDF', async () => {
    const tender = await createTender({ tenderNumber: `WR/FILE/${runId}` });
    const [notice] = await admin<{ id: string }[]>`
      select id from tender_notices where confirmed_tender_id = ${tender.id}
    `;
    const response = await authed(viewer, {
      method: 'GET',
      url: `/api/tender-notices/${notice?.id ?? ''}/file`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
