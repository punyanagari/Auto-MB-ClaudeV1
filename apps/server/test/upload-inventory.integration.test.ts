import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import {
  MAX_CSV_UPLOAD_BYTES,
  MAX_TALLY_UPLOAD_BYTES,
  MAX_PDF_UPLOAD_BYTES,
  MAX_XLSX_UPLOAD_BYTES,
} from '../src/upload-guards.js';
import { tenantRoutesOf } from '../src/tenant-route.js';

/**
 * The upload inventory (improvement programme P4). Uploads are the one
 * request shape that spends real resources before anything is stored — a
 * 25 MB raw body, a malware scan, a Poppler text extraction — and until
 * this test existed the two controls over them were both hand-maintained
 * lists that a new upload route could be written without:
 *
 *   1. the magic-byte guard, copied verbatim into eight route handlers, and
 *   2. the per-address throttle, a path-pattern list in `app.ts` that had
 *      already fallen behind — `POST /api/approvals/:id/variation-order`
 *      matched none of its patterns and was served unthrottled.
 *
 * Both are now derived from one fact: an upload route is a route the
 * tenant-route registrar registered with a `bodyLimit`. This test walks
 * that inventory and proves, for every route in it, that the shared
 * `consumeUpload()` guard refuses a wrong-signature body and that the
 * throttle covers the route — and that the derivation has not become so
 * broad that ordinary routes are throttled too.
 */

/**
 * The committed inventory. Every raw-body upload route the app registers
 * appears here with the querystring its schema requires; a new upload
 * route is a visible diff in this table rather than a silent addition.
 */
interface UploadRouteExpectation {
  /** `"METHOD url"`, exactly the tenant-route registry's key. */
  readonly key: string;
  /** The route file that must call `consumeUpload()`. */
  readonly sourceFile: string;
  readonly format: 'pdf' | 'image' | 'xlsx' | 'csv' | 'tally-xml';
  readonly bodyLimit: number;
  /** Appended verbatim; the routes below either need one or take none. */
  readonly query?: string;
}

const LOGO_MAX_BYTES = 1024 * 1024;

const UPLOAD_ROUTES: readonly UploadRouteExpectation[] = [
  {
    key: 'POST /api/loa-documents',
    sourceFile: 'routes/loa.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    key: 'POST /api/loa-documents/:id/contract-sources',
    sourceFile: 'routes/contract-sources.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?kind=nit&filename=inventory.pdf',
  },
  {
    // The route the hand-maintained throttle list missed.
    key: 'POST /api/approvals/:id/variation-order',
    sourceFile: 'routes/amendments.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    // The one inbound document the agency receives rather than authors
    // (0066). Same magic-byte gate, same throttle, same 25 MB ceiling.
    key: 'POST /api/measurement-books/:id/received-railway-bill',
    sourceFile: 'routes/received-railway-bills.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    // The document that bill is raised from (0111): the railway's own
    // copy of a finalized Measurement Book. Same gate, same throttle,
    // same 25 MB ceiling as its sibling above it.
    key: 'POST /api/measurement-books/:id/railway-measurement',
    sourceFile: 'routes/railway-measurements.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    // The last railway bill an imported Work was paid on (0114): the
    // document its opening billing position rests on. Same gate, same
    // throttle, same ceiling.
    key: 'POST /api/works/:id/billing-baseline',
    sourceFile: 'routes/billing-baselines.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    // And the measurement sheet that bill was raised from, which is what
    // the per-item proposal is derived from.
    key: 'POST /api/billing-baselines/:id/measurement',
    sourceFile: 'routes/billing-baselines.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    // The vendor's own tax invoice (0109). Inbound paper like the railway
    // bill above, and the one upload in this application a state
    // transition depends on: a purchase order does not close until one
    // of its vendor invoices carries this file.
    key: 'POST /api/vendor-invoices/:id/document',
    sourceFile: 'routes/payments.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    // The company document library (0079): a credential and its first
    // version arrive together, and a renewal appends to the credential
    // it renews. Two addresses, one handler, the same gate as every
    // other upload here.
    key: 'POST /api/company-documents',
    sourceFile: 'routes/company-documents.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?title=Inventory&category=statutory&filename=inventory.pdf',
  },
  {
    key: 'POST /api/company-documents/:id/versions',
    sourceFile: 'routes/company-documents.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    // The inspection lifecycle (0082): the agency's inward call letter,
    // a checklist paper, and the certificate the dispatch gate reads.
    // Three addresses, the same gate as every other upload here.
    key: 'POST /api/inspection-calls/:id/call-letter',
    sourceFile: 'routes/inspections.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query:
      '?filename=call-letter.pdf&agencyCallNumber=RDSO/CALL/1&receivedOn=2026-01-02',
  },
  {
    key: 'POST /api/inspection-call-documents/:id/file',
    sourceFile: 'routes/inspections.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=datasheet.pdf',
  },
  {
    key: 'POST /api/inspection-calls/:id/certificate',
    sourceFile: 'routes/inspections.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query:
      '?filename=certificate.pdf&certificateNumber=IC/1&certificateDate=2026-01-05',
  },
  {
    // The tender notice (0083): the NIT is read for a proposal on the
    // request path, so the gate has to hold before pdftotext runs, not
    // only before storage.
    key: 'POST /api/tender-notices',
    sourceFile: 'routes/tenders.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query: '?filename=inventory.pdf',
  },
  {
    // The inward letter's scan (0086). The whole querystring is the
    // letter's metadata, so the gate has to hold before any of it is
    // trusted and before the bytes reach the scanner.
    key: 'POST /api/correspondence/inward',
    sourceFile: 'routes/correspondence.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
    query:
      '?filename=inward.pdf&receivedOn=2026-06-12&subject=Inventory' +
      '&contactId=00000000-0000-4000-8000-000000000001',
  },
  {
    key: 'POST /api/challans/:id/signed-copy',
    sourceFile: 'routes/challans.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
  },
  {
    key: 'POST /api/issue-challans/:id/signed-copy',
    sourceFile: 'routes/issue-challans.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
  },
  {
    key: 'POST /api/extension-requests/:id/response-document',
    sourceFile: 'routes/extensions.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
  },
  {
    key: 'POST /api/pac-certificates/:id/document',
    sourceFile: 'routes/pac.ts',
    format: 'pdf',
    bodyLimit: MAX_PDF_UPLOAD_BYTES,
  },
  {
    key: 'PUT /api/organisation/logo',
    sourceFile: 'routes/organisation.ts',
    format: 'image',
    bodyLimit: LOGO_MAX_BYTES,
  },
  {
    // The spreadsheet importer (0094). The one upload here whose bytes
    // are PARSED rather than stored, so it is also the one with a
    // smaller ceiling: a workbook is compressed text, and the row cap
    // bounds what the parser can be made to do long before 8 MB.
    key: 'POST /api/imports',
    sourceFile: 'routes/imports.ts',
    format: 'xlsx',
    bodyLimit: MAX_XLSX_UPLOAD_BYTES,
    query: '?target=contacts&filename=inventory.xlsx',
  },
  {
    // The historical Zoho Books invoice export (0115). The second upload
    // here whose bytes are PARSED rather than stored, and the only one
    // whose format has no signature at all — so its guard proves the body
    // is TEXT rather than proving it is a CSV, and the parser's own
    // refusals do the rest. A larger ceiling than the workbook above it
    // for the opposite reason: a .xlsx is compressed and a CSV is not.
    key: 'POST /api/imported-invoices/import',
    sourceFile: 'routes/imported-invoices.ts',
    format: 'csv',
    bodyLimit: MAX_CSV_UPLOAD_BYTES,
    query: '?mode=preview&filename=invoice.csv',
  },
  {
    // The TallyPrime All Masters export (0118). The largest ceiling here
    // by an order of magnitude, and the size is a property of Tally's
    // format rather than of anybody's data: it writes one tag per line,
    // ~165 tags per ledger of which ~150 are Yes/No engine flags, in
    // UTF-16 — so a 4,327-ledger chart of accounts is 133 MB. Its
    // signature is the UTF-16LE byte-order mark, which is the only one
    // the file has: Tally writes no XML declaration.
    key: 'POST /api/tally-masters/import',
    sourceFile: 'routes/tally-masters.ts',
    format: 'tally-xml',
    bodyLimit: MAX_TALLY_UPLOAD_BYTES,
    query: '?mode=preview&filename=Master.xml',
  },
  {
    // The TallyPrime sales-voucher export (0119). The SAME ceiling as the
    // masters import above and for a different reason: the file it takes
    // is a FILTERED export — the Day Book narrowed to Sales, Credit Note
    // and Debit Note — which is 61 MB against the 3.18 GB of every
    // voucher TallyPrime holds. The cap is what refuses the unfiltered
    // file; the route's own copy explains why the narrowing is the
    // intake rather than a workaround for it.
    key: 'POST /api/tally-invoices/import',
    sourceFile: 'routes/tally-invoices.ts',
    format: 'tally-xml',
    bodyLimit: MAX_TALLY_UPLOAD_BYTES,
    query: '?mode=preview&filename=Vouchers.xml',
  },
];

/** What each format's shared refusal answers for a body whose signature
 * does not match. Both codes predate the shared guard, so clients keying
 * on them are unaffected by the de-duplication. */
const WRONG_SIGNATURE_CODE = {
  pdf: 'NOT_A_PDF',
  image: 'INVALID_IMAGE',
  // The importer's guard answers the code the whole feature answers for
  // bytes it cannot read, rather than minting a NOT_AN_XLSX nobody else
  // would ever see: to an operator, a file that is not a workbook and a
  // file that is a broken workbook are the same problem with the same
  // fix, and the sentence names it (0094).
  xlsx: 'IMPORT_SHEET_UNREADABLE',
  // Same posture as the workbook, and it has to be: a CSV carries no
  // signature, so "this is not a CSV" and "this is a CSV that is not the
  // Zoho invoice export" are one refusal reached by two routes — the
  // binary check in the guard and the missing-columns check in the reader
  // (0115). The probe body below is plain text, so it is the reader that
  // answers, which is exactly the arm a signature check cannot have.
  csv: 'ZOHO_EXPORT_UNREADABLE',
  // The Tally export DOES have a signature — the UTF-16LE byte-order mark
  // and a first character of `<` — so unlike the two above this arm is
  // genuinely the guard's, not the reader's. One code either way, for the
  // workbook's reason: a file that is not Tally's XML and a file that is
  // Tally's XML with nothing readable in it are one problem with one fix.
  'tally-xml': 'TALLY_EXPORT_UNREADABLE',
} as const;

const UPLOAD_CONTENT_TYPE = {
  pdf: 'application/pdf',
  image: 'image/png',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  'tally-xml': 'application/xml',
} as const;

/**
 * The only files under `src/` allowed to name a file signature. Every
 * other magic-byte comparison is an upload guard that got copied instead
 * of imported.
 *
 * `pdf-render.ts` is not an upload path at all: it checks that the bytes
 * GOTENBERG returned are a PDF before they are stored as a rendered
 * document, which is an outbound-dependency check with its own bound and
 * timeout behaviour (see its own tests).
 */
const MAGIC_BYTE_ALLOWLIST = new Set([
  'upload-guards.ts',
  'pdf-render.ts',
  // The ZIP reader itself (0094). Its signature constants ARE the format
  // parser, not a copied upload guard — the guard in `upload-guards.ts`
  // proves the container and this proves the parts inside it.
  'xlsx.ts',
]);

/** PDF, PNG, JPEG and ZIP signatures as they are spelled in this
 * codebase. The ZIP one arrived with the spreadsheet importer (0094):
 * `xlsx.ts` reads the container itself and is allowlisted below, because
 * a reader that cannot recognise a local file header is not a reader. */
const MAGIC_BYTE_PATTERNS = [
  /%PDF-/,
  /0x89,\s*0x50,\s*0x4e,\s*0x47/i,
  /0xff,\s*0xd8,\s*0xff/i,
  /0x50,\s*0x4b,\s*0x03,\s*0x04/i,
];

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSourceDirectory = path.resolve(here, '..', 'src');
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
const uploaderEmail = `upload-inventory-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let uploaderCookie: string;
let organisationId: string;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

/** Concrete URL for a route pattern: the signature guard runs before any
 * lookup, so an id that matches nothing still reaches it. */
function concreteUrl(route: UploadRouteExpectation): string {
  const [, pattern] = route.key.split(' ') as [string, string];
  const url = pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? randomUUID() : segment))
    .join('/');
  return url + (route.query ?? '');
}

/** Every `.ts` file under `src/`, relative to it and with `/` separators. */
async function serverSourceFiles(): Promise<string[]> {
  const entries = await readdir(serverSourceDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) =>
      path
        .relative(
          serverSourceDirectory,
          path.join(entry.parentPath ?? serverSourceDirectory, entry.name),
        )
        .split(path.sep)
        .join('/'),
    );
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-upload-inventory-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-upload-inventory-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    // One hop of trusted proxy so each route below can be probed from its
    // own client address: the upload throttle is keyed on request.ip, and
    // a shared address would let one route exhaust another's window.
    trustProxyHops: 1,
    // A window of one turns "is this route throttled?" into two requests.
    rateLimits: {
      auth: { windowMs: 60_000, max: 1_000 },
      upload: { windowMs: 60_000, max: 1 },
    },
  });

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: uploaderEmail, password, name: 'Upload Inventory' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  uploaderCookie = extractCookies(signUp.headers['set-cookie']);

  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie: uploaderCookie },
    payload: { name: 'Upload Inventory Org', slug: `upload-inventory-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('upload inventory: one guard, one throttle, derived from the route table', () => {
  it('the registrar bodyLimit inventory is exactly the committed upload list', () => {
    const derived = [...tenantRoutesOf(app).values()]
      .filter((record) => record.bodyLimit !== undefined)
      .map((record) => `${record.method} ${record.url}`)
      .sort();
    const expected = UPLOAD_ROUTES.map((route) => route.key).sort();
    expect(
      derived,
      'a raw-body upload route must be declared in UPLOAD_ROUTES so its guard and its throttle are both proven below',
    ).toEqual(expected);

    for (const route of UPLOAD_ROUTES) {
      expect(
        tenantRoutesOf(app).get(route.key)?.bodyLimit,
        `${route.key} bodyLimit`,
      ).toBe(route.bodyLimit);
    }
  }, 30_000);

  it('every upload route file goes through the shared consumeUpload guard', async () => {
    for (const route of UPLOAD_ROUTES) {
      const source = await readFile(
        path.join(serverSourceDirectory, route.sourceFile),
        'utf8',
      );
      expect(
        source.includes('consumeUpload('),
        `${route.sourceFile} registers ${route.key} but does not call consumeUpload()`,
      ).toBe(true);
    }
  }, 30_000);

  it('no file outside upload-guards.ts re-states a file signature', async () => {
    const offenders: string[] = [];
    for (const file of await serverSourceFiles()) {
      if (MAGIC_BYTE_ALLOWLIST.has(path.basename(file))) continue;
      const source = await readFile(path.join(serverSourceDirectory, file), 'utf8');
      if (MAGIC_BYTE_PATTERNS.some((pattern) => pattern.test(source))) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      'file signatures belong in upload-guards.ts; a copied magic-byte check is a guard a future upload route can be written without',
    ).toEqual([]);
  }, 30_000);

  it('refuses a wrong-signature body on every upload route, then throttles it', async () => {
    for (const [index, route] of UPLOAD_ROUTES.entries()) {
      const [method] = route.key.split(' ') as [string, string];
      const headers = {
        cookie: uploaderCookie,
        'x-organisation-id': organisationId,
        'content-type': UPLOAD_CONTENT_TYPE[route.format],
        // Distinct client address per route: the throttle is shared
        // across upload routes by design, so each route needs its own
        // window to be measured on its own.
        'x-forwarded-for': `10.9.${String(index)}.1`,
      };
      const send = () =>
        app.inject({
          method: method as Exclude<InjectOptions['method'], undefined>,
          url: concreteUrl(route),
          headers,
          payload: Buffer.from('this is not a file of any accepted format'),
        });

      const guarded = await send();
      expect(
        guarded.statusCode,
        `${route.key} accepted a body with the wrong signature: ${guarded.body}`,
      ).toBe(400);
      expect(guarded.json<{ code: string }>().code).toBe(
        WRONG_SIGNATURE_CODE[route.format],
      );

      const throttled = await send();
      expect(
        throttled.statusCode,
        `${route.key} is not covered by the upload throttle: a second request from the same address answered ${throttled.statusCode}`,
      ).toBe(429);
      expect(throttled.json<{ code: string }>().code).toBe('RATE_LIMITED');
    }
  }, 120_000);

  it('does not throttle ordinary routes', async () => {
    // The derivation must be tight as well as complete: a route with no
    // raw-body limit shares no window with the uploads.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/works',
        headers: {
          cookie: uploaderCookie,
          'x-organisation-id': organisationId,
          'x-forwarded-for': '10.9.200.1',
        },
      });
      expect(
        response.statusCode,
        `GET /api/works answered ${response.statusCode} on attempt ${String(attempt)}: ${response.body}`,
      ).not.toBe(429);
    }
  }, 60_000);
});
