import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import {
  COMPANY_DOCUMENT_CATEGORIES,
  type CompanyDocument,
  type CompanyDocumentListResponse,
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
import { EXPIRY_WARNING_DAYS } from '../src/routes/shared.js';

/**
 * The company document library (migration 0079).
 *
 * What is proved here, in the order the module's own risks run:
 *
 *   1. the upload gate — magic bytes, and a key the storage layer's
 *      traversal guard accepts;
 *   2. versioning — numbers ascend, history is kept, the newest is the
 *      one the register reports;
 *   3. derived expiry — the same row reads valid, expiring or expired
 *      purely from where `current_date` falls, with nothing stored;
 *   4. archive — retiring a credential keeps its versions, refuses new
 *      ones, and frees the name;
 *   5. the walls — role for writes, the restricted financial category for
 *      reads, and RLS for the other organisation.
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
const ownerEmail = `cdoc-owner-${runId}@integration.test`;
const officeEmail = `cdoc-office-${runId}@integration.test`;
const viewerEmail = `cdoc-viewer-${runId}@integration.test`;
const outsiderEmail = `cdoc-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** A minimal but real PDF: the guard reads the signature, never the
 * declared content type. The counter makes each upload's sha256 unique,
 * which is what a version history has to be able to tell apart. */
let pdfCounter = 0;
function pdfBytes(): Buffer {
  pdfCounter += 1;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Seq ${String(pdfCounter)} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );
}

/**
 * `YYYY-MM-DD`, `days` from the DATABASE's today.
 *
 * Relative, because a hard-coded date is a test that starts failing on a
 * Tuesday in some future year. Anchored on `current_date` read from the
 * server rather than on `new Date()`, because those are two clocks in two
 * timezones and the route derives expiry from the first one: run this
 * from IST between midnight and 05:30 and a UTC-derived "400 days away"
 * is 399 days away to the database. Measured — that is exactly how this
 * failed once — and a CI runner on UTC would never have reproduced it.
 */
let serverToday: number;
function isoDaysFromToday(days: number): string {
  return new Date(serverToday + days * 86_400_000).toISOString().slice(0, 10);
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

function query(details: Record<string, string>): string {
  return new URLSearchParams(details).toString();
}

/** Files actually written under the storage root. A refusal that has
 * already spent a `storage.put` shows up here even when it answers 4xx. */
async function storedObjectCount(): Promise<number> {
  const entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).length;
}

async function upload(
  jar: CookieJar,
  details: Record<string, string>,
  organisation = organisationId,
  body: Buffer = pdfBytes(),
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/company-documents?${query(details)}`,
    organisationId: organisation,
    headers: { 'content-type': 'application/pdf' },
    payload: body,
  });
}

async function uploadVersion(
  jar: CookieJar,
  documentId: string,
  details: Record<string, string>,
  organisation = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/company-documents/${documentId}/versions?${query(details)}`,
    organisationId: organisation,
    headers: { 'content-type': 'application/pdf' },
    payload: pdfBytes(),
  });
}

async function library(
  jar: CookieJar = owner,
  organisation = organisationId,
): Promise<CompanyDocumentListResponse> {
  const response = await authed(jar, {
    method: 'GET',
    url: '/api/company-documents',
    organisationId: organisation,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CompanyDocumentListResponse>();
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-company-documents-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  const [today] = await admin<{ today: string }[]>`
    select current_date::text as today
  `;
  serverToday = Date.parse(`${today?.today ?? ''}T00:00:00.000Z`);
  expect(Number.isNaN(serverToday)).toBe(false);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-cdoc-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Library Owner');
  office = await signUp(officeEmail, 'Library Office');
  viewer = await signUp(viewerEmail, 'Library Viewer');
  outsider = await signUp(outsiderEmail, 'Library Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Library Constructions', slug: `cdoc-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Library Outsiders', slug: `cdoc-out-${runId}` },
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
}, 120_000);

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

describe('uploading a company credential', () => {
  it('stores the PDF under a traversal-proof tenant key and reads it back', async () => {
    const response = await upload(office, {
      title: 'GST registration certificate',
      category: 'statutory',
      filename: 'gst-registration.pdf',
      validFrom: '2026-04-01',
    });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<CompanyDocument>();
    expect(created.title).toBe('GST registration certificate');
    expect(created.category).toBe('statutory');
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]?.versionNumber).toBe(1);
    expect(created.versions[0]?.validFrom).toBe('2026-04-01');
    expect(created.versions[0]?.expiresOn).toBeNull();
    // Nothing expires, so nothing is expiring: `none` is not `valid`.
    expect(created.expiryStatus).toBe('none');
    expect(created.expiresInDays).toBeNull();

    // The stored key is `<org>/<area>/<uuid>.pdf` and the storage
    // layer's own guard accepts it — the guard is what refuses `..`, an
    // absolute path or a second extension, so asserting it accepts this
    // key is asserting the key was server-generated rather than taken
    // from the request.
    const [row] = await admin<{ object_key: string }[]>`
      select object_key from company_document_versions
      where organisation_id = ${organisationId}
    `;
    expect(row?.object_key.startsWith(`${organisationId}/orgdoc/`)).toBe(true);
    expect(() => {
      assertSafeObjectKey(row?.object_key ?? '');
    }).not.toThrow();

    const download = await authed(owner, {
      method: 'GET',
      url: `/api/company-document-versions/${created.versions[0]?.id ?? ''}/file`,
      organisationId,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses a body that is not a PDF, whatever the client calls it', async () => {
    const response = await authed(office, {
      method: 'POST',
      url: `/api/company-documents?${query({
        title: 'Not a PDF at all',
        category: 'company',
        filename: 'lies.pdf',
      })}`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('MZ\x90\x00 this is a Windows executable'),
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('NOT_A_PDF');

    // Nothing was written, so the refusal cost no row and no object.
    const [count] = await admin<{ n: string }[]>`
      select count(*)::text as n from company_documents
      where organisation_id = ${organisationId} and title = 'Not a PDF at all'
    `;
    expect(count?.n).toBe('0');
  });

  it('refuses a whitespace-only filename without storing anything', async () => {
    // The querystring schema's minLength admits a string of spaces, and
    // 0079's CHECK refuses one. Without the trim in the route the refusal
    // arrives as SQLSTATE 23514 — a 500, raised AFTER the bytes are in
    // object storage, so the caller gets an unexplained server error and
    // an orphan object is left behind.
    const before = await storedObjectCount();
    for (const attempt of [
      upload(office, {
        title: 'Blank filename on create',
        category: 'statutory',
        filename: '   ',
      }),
      (async () => {
        const created = await upload(office, {
          title: 'Blank filename on renewal',
          category: 'statutory',
          filename: 'first.pdf',
        });
        expect(created.statusCode, created.body).toBe(201);
        return uploadVersion(office, created.json<CompanyDocument>().id, {
          filename: ' ',
        });
      })(),
    ]) {
      const response = await attempt;
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('FIELD_TOO_SHORT');
    }
    // One object for the legitimate first.pdf above, and nothing from
    // either refusal.
    expect(await storedObjectCount()).toBe(before + 1);
  });

  it('refuses a whitespace-only title', async () => {
    const response = await upload(office, {
      title: '   ',
      category: 'statutory',
      filename: 'nameless.pdf',
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('FIELD_TOO_SHORT');
  });

  it('refuses an expiry that falls before the document takes effect', async () => {
    const response = await upload(office, {
      title: 'Backwards window',
      category: 'financial',
      filename: 'backwards.pdf',
      validFrom: '2026-06-01',
      expiresOn: '2026-05-01',
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe(
      'COMPANY_DOCUMENT_DATE_INVALID',
    );
  });

  it('refuses a second live credential with the same name, case-folded', async () => {
    const response = await upload(office, {
      title: 'gst REGISTRATION certificate',
      category: 'statutory',
      filename: 'again.pdf',
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'COMPANY_DOCUMENT_TITLE_EXISTS',
    );
  });
});

describe('versioning', () => {
  it('numbers renewals upward and keeps every earlier file', async () => {
    const created = await upload(office, {
      title: 'Bank solvency letter',
      category: 'financial',
      filename: 'solvency-2025.pdf',
      expiresOn: isoDaysFromToday(-30),
    });
    expect(created.statusCode, created.body).toBe(201);
    const documentId = created.json<CompanyDocument>().id;

    const renewed = await uploadVersion(office, documentId, {
      filename: 'solvency-2026.pdf',
      validFrom: isoDaysFromToday(-1),
      expiresOn: isoDaysFromToday(300),
    });
    expect(renewed.statusCode, renewed.body).toBe(201);
    const afterRenewal = renewed.json<CompanyDocument>();

    // Newest first, contiguous from one, and the earlier file survives
    // untouched — a bid that attached v1 must stay explicable.
    expect(afterRenewal.versions.map((version) => version.versionNumber)).toEqual([
      2, 1,
    ]);
    expect(afterRenewal.versions[0]?.originalFilename).toBe('solvency-2026.pdf');
    expect(afterRenewal.versions[1]?.originalFilename).toBe('solvency-2025.pdf');
    expect(afterRenewal.versions[0]?.sha256).not.toBe(afterRenewal.versions[1]?.sha256);

    // The register reports the NEWEST version's validity. v1 lapsed a
    // month ago and that is not what the credential says today.
    expect(afterRenewal.expiryStatus).toBe('valid');

    const stillThere = await authed(owner, {
      method: 'GET',
      url: `/api/company-document-versions/${afterRenewal.versions[1]?.id ?? ''}/file`,
      organisationId,
    });
    expect(stillThere.statusCode, stillThere.body).toBe(200);
  });

  it('hands two simultaneous renewals two different version numbers', async () => {
    const created = await upload(office, {
      title: 'Concurrent renewal fixture',
      category: 'certification',
      filename: 'iso-v1.pdf',
    });
    expect(created.statusCode, created.body).toBe(201);
    const documentId = created.json<CompanyDocument>().id;

    // The parent row lock serialises the max()+1 read; the unique
    // constraint on (organisation, document, version_number) is the
    // second layer. Either way, two v2s must be impossible.
    const [left, right] = await Promise.all([
      uploadVersion(office, documentId, { filename: 'iso-a.pdf' }),
      uploadVersion(owner, documentId, { filename: 'iso-b.pdf' }),
    ]);
    expect(left.statusCode, left.body).toBe(201);
    expect(right.statusCode, right.body).toBe(201);

    const numbers = await admin<{ version_number: number }[]>`
      select version_number from company_document_versions
      where company_document_id = ${documentId}
      order by version_number
    `;
    expect(numbers.map((row) => Number(row.version_number))).toEqual([1, 2, 3]);
  });

  it('refuses to rewrite a stored version, even from the application role', async () => {
    // The application role holds no UPDATE on the table and the trigger
    // refuses one anyway. Attacked here with raw SQL from the OWNER
    // pool, which has the privilege the app role lacks, so what is
    // measured is the trigger rather than the grant.
    const [version] = await admin<{ id: string }[]>`
      select id from company_document_versions
      where organisation_id = ${organisationId}
      limit 1
    `;
    await expect(
      admin`
        update company_document_versions
        set original_filename = 'rewritten.pdf'
        where id = ${version?.id ?? ''}
      `,
    ).rejects.toThrow(/immutable/);
  });
});

describe('derived expiry', () => {
  it('reads the same stored date as valid, expiring or expired', async () => {
    const cases = [
      { title: 'Expiry far away', days: 400, status: 'valid' },
      { title: 'Expiry inside the window', days: 20, status: 'expiring' },
      { title: 'Expiry passed', days: -5, status: 'expired' },
    ] as const;
    for (const kase of cases) {
      const response = await upload(office, {
        title: kase.title,
        category: 'eligibility',
        filename: 'certificate.pdf',
        expiresOn: isoDaysFromToday(kase.days),
      });
      expect(response.statusCode, response.body).toBe(201);
      const created = response.json<CompanyDocument>();
      expect(created.expiryStatus, kase.title).toBe(kase.status);
      expect(created.expiresInDays, kase.title).toBe(kase.days);
    }

    const list = await library();
    expect(list.expiryWarningDays).toBe(60);
    // Nothing about the reading is stored: the columns are the date and
    // nothing else, so the answer cannot go stale overnight.
    const columns = await admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'company_document_versions'
    `;
    const names = columns.map((row) => row.column_name);
    expect(names).toContain('expires_on');
    expect(names).not.toContain('expiry_status');
  });

  it('puts each edge of the window on the side the SQL says', async () => {
    // The four dates where the derivation changes its mind. The SQL is
    // `expires_on < current_date` for expired and `<= current_date + 60`
    // for expiring, so today itself is EXPIRING (a certificate is valid
    // through its last day, not until the morning of it) and day 60 is
    // the last expiring day.
    //
    // Day 0 is also the case that breaks first if anyone re-derives
    // "today" in JavaScript: `new Date().toISOString()` is a UTC round
    // trip of a wall clock, and run from IST between midnight and 05:30
    // it names YESTERDAY — so a document expiring today would be read as
    // expired. That is the trap AGENTS.md rule 6 exists to forbid, it is
    // how this suite failed once, and a CI runner on UTC would never
    // reproduce it. `serverToday` comes from `select current_date`, and
    // this case is what holds it there.
    const edges = [
      { days: -1, status: 'expired' },
      { days: 0, status: 'expiring' },
      { days: EXPIRY_WARNING_DAYS, status: 'expiring' },
      { days: EXPIRY_WARNING_DAYS + 1, status: 'valid' },
    ] as const;

    for (const edge of edges) {
      const label = `Window edge ${String(edge.days)}`;
      const response = await upload(office, {
        title: label,
        category: 'certification',
        filename: 'edge.pdf',
        expiresOn: isoDaysFromToday(edge.days),
      });
      expect(response.statusCode, response.body).toBe(201);
      const created = response.json<CompanyDocument>();
      expect(created.expiryStatus, label).toBe(edge.status);
      expect(created.expiresInDays, label).toBe(edge.days);
    }
  });
});

describe('archiving', () => {
  it('keeps the versions, refuses new ones, and frees the name', async () => {
    const created = await upload(office, {
      title: 'Retired certificate',
      category: 'company',
      filename: 'retired.pdf',
    });
    expect(created.statusCode, created.body).toBe(201);
    const documentId = created.json<CompanyDocument>().id;
    const versionId = created.json<CompanyDocument>().versions[0]?.id ?? '';

    const archived = await authed(office, {
      method: 'POST',
      url: `/api/company-documents/${documentId}/archive`,
      organisationId,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json<CompanyDocument>().archivedAt).not.toBeNull();
    expect(archived.json<CompanyDocument>().versions).toHaveLength(1);

    // The bytes stay reachable: a bid that cited this credential has to
    // stay explicable after it is retired.
    const download = await authed(owner, {
      method: 'GET',
      url: `/api/company-document-versions/${versionId}/file`,
      organisationId,
    });
    expect(download.statusCode).toBe(200);

    const renewal = await uploadVersion(office, documentId, {
      filename: 'too-late.pdf',
    });
    expect(renewal.statusCode, renewal.body).toBe(409);
    expect(renewal.json<{ code: string }>().code).toBe('COMPANY_DOCUMENT_ARCHIVED');

    // Archiving a name releases it, so the credential can be re-added.
    const again = await upload(office, {
      title: 'Retired certificate',
      category: 'company',
      filename: 'reinstated.pdf',
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json<CompanyDocument>().id).not.toBe(documentId);
  });

  it('answers 404 for a credential that does not exist', async () => {
    const response = await authed(office, {
      method: 'POST',
      url: `/api/company-documents/${randomUUID()}/archive`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('COMPANY_DOCUMENT_NOT_FOUND');
  });

  it('refuses to un-archive, or to rewrite provenance, from the owner pool', async () => {
    // No route does either; the guard is what makes that a property of
    // the schema rather than of the one writer that exists today. Driven
    // from the owner pool, which holds the UPDATE privilege the
    // application role's grant also carries, so the trigger is what is
    // being measured.
    const [row] = await admin<{ id: string }[]>`
      select id from company_documents
      where organisation_id = ${organisationId} and archived_at is not null
      limit 1
    `;
    const archivedId = row?.id ?? '';
    expect(archivedId).not.toBe('');

    await expect(
      admin`update company_documents set archived_at = null where id = ${archivedId}`,
    ).rejects.toThrow(/cannot be un-archived/);

    await expect(
      admin`
        update company_documents set created_by_user_id = 'someone-else'
        where id = ${archivedId}
      `,
    ).rejects.toThrow(/tenant and provenance are immutable/);
  });
});

describe('the walls', () => {
  it('lets a viewer read and download but not upload or archive', async () => {
    const list = await library(viewer);
    expect(list.documents.length).toBeGreaterThan(0);
    const nonFinancial = list.documents.find(
      (document) => document.versions.length > 0,
    );
    const versionId = nonFinancial?.versions[0]?.id ?? '';
    const download = await authed(viewer, {
      method: 'GET',
      url: `/api/company-document-versions/${versionId}/file`,
      organisationId,
    });
    expect(download.statusCode).toBe(200);

    const upload403 = await upload(viewer, {
      title: 'Viewer upload attempt',
      category: 'statutory',
      filename: 'nope.pdf',
    });
    expect(upload403.statusCode, upload403.body).toBe(403);
    expect(upload403.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');

    const archive403 = await authed(viewer, {
      method: 'POST',
      url: `/api/company-documents/${list.documents[0]?.id ?? ''}/archive`,
      organisationId,
    });
    expect(archive403.statusCode, archive403.body).toBe(403);
    expect(archive403.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');
  });

  it('keeps financial documents out of a non-writer’s reach entirely', async () => {
    // Owner decision, 2026-08-18: balance sheets, turnover certificates
    // and bank solvency letters are readable by owner/office only. Every
    // other category stays open to any member.
    const created = await upload(office, {
      title: 'Audited balance sheet 2025-26',
      category: 'financial',
      filename: 'balance-sheet.pdf',
    });
    expect(created.statusCode, created.body).toBe(201);
    const financial = created.json<CompanyDocument>();
    const financialVersionId = financial.versions[0]?.id ?? '';

    // A writer sees it, and can read the bytes.
    const writerList = await library(office);
    expect(writerList.documents.some((row) => row.id === financial.id)).toBe(true);
    const writerDownload = await authed(office, {
      method: 'GET',
      url: `/api/company-document-versions/${financialVersionId}/file`,
      organisationId,
    });
    expect(writerDownload.statusCode, writerDownload.body).toBe(200);

    // A viewer's list omits it — filtered in SQL, so its versions never
    // load either and no id leaks for them to try.
    const viewerList = await library(viewer);
    expect(viewerList.documents.some((row) => row.id === financial.id)).toBe(false);
    expect(viewerList.documents.every((row) => row.category !== 'financial')).toBe(
      true,
    );
    // ...and the rest of the library is still there, so the filter is a
    // filter rather than an outage.
    expect(viewerList.documents.length).toBeGreaterThan(0);
    expect(
      viewerList.documents.length,
      'the viewer should see every non-financial credential the writer sees',
    ).toBe(writerList.documents.filter((row) => row.category !== 'financial').length);

    // A viewer who learned the id anyway is refused 403, not 404: they
    // belong to the organisation that owns the file, so its existence is
    // not the secret — the bytes are, and a refusal they can act on beats
    // a lie that sends them looking.
    const viewerDownload = await authed(viewer, {
      method: 'GET',
      url: `/api/company-document-versions/${financialVersionId}/file`,
      organisationId,
    });
    expect(viewerDownload.statusCode, viewerDownload.body).toBe(403);
    expect(viewerDownload.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');
  });

  it('declares exactly the categories the schema admits', async () => {
    // The census the migration-contract test cannot run: `packages/db`
    // does not depend on `packages/contracts`, so the comparison between
    // the CHECK constraint and COMPANY_DOCUMENT_CATEGORIES lives here,
    // where both are in reach — and it reads the LIVE constraint rather
    // than the migration's text.
    const [constraint] = await admin<{ definition: string }[]>`
      select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'company_documents'
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like '%category%'
    `;
    const definition = constraint?.definition ?? '';
    const admitted = [...definition.matchAll(/'([a-z]+)'::text/g)]
      .map((match) => match[1])
      .sort();
    expect(admitted).toEqual([...COMPANY_DOCUMENT_CATEGORIES].sort());
  });

  it('shows one organisation nothing of the other', async () => {
    const theirs = await upload(
      outsider,
      {
        title: 'GST registration certificate',
        category: 'statutory',
        filename: 'theirs.pdf',
      },
      outsiderOrganisationId,
    );
    // The same NAME in another organisation is fine — the uniqueness is
    // per tenant, and a rule that leaked across would itself be a leak.
    expect(theirs.statusCode, theirs.body).toBe(201);
    const theirDocument = theirs.json<CompanyDocument>();

    const ours = await library();
    expect(ours.documents.some((row) => row.id === theirDocument.id)).toBe(false);

    // RLS, not a route filter: the outsider's own credential is
    // unreachable through OUR organisation header even by direct id, and
    // the version's bytes are unreachable with it.
    const crossArchive = await authed(owner, {
      method: 'POST',
      url: `/api/company-documents/${theirDocument.id}/archive`,
      organisationId,
    });
    expect(crossArchive.statusCode, crossArchive.body).toBe(404);

    const crossDownload = await authed(owner, {
      method: 'GET',
      url: `/api/company-document-versions/${theirDocument.versions[0]?.id ?? ''}/file`,
      organisationId,
    });
    expect(crossDownload.statusCode, crossDownload.body).toBe(404);
    expect(crossDownload.json<{ code: string }>().code).toBe(
      'COMPANY_DOCUMENT_VERSION_NOT_FOUND',
    );

    // And a member of neither organisation reaches neither.
    const notAMember = await authed(outsider, {
      method: 'GET',
      url: '/api/company-documents',
      organisationId,
    });
    expect(notAMember.statusCode, notAMember.body).toBe(403);
    expect(notAMember.json<{ code: string }>().code).toBe('NOT_A_MEMBER');
  });
});
