import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import { MAX_PDF_UPLOAD_BYTES } from '../src/upload-guards.js';
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
  readonly format: 'pdf' | 'image';
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
];

/** What each format's shared refusal answers for a body whose signature
 * does not match. Both codes predate the shared guard, so clients keying
 * on them are unaffected by the de-duplication. */
const WRONG_SIGNATURE_CODE = {
  pdf: 'NOT_A_PDF',
  image: 'INVALID_IMAGE',
} as const;

const UPLOAD_CONTENT_TYPE = {
  pdf: 'application/pdf',
  image: 'image/png',
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
const MAGIC_BYTE_ALLOWLIST = new Set(['upload-guards.ts', 'pdf-render.ts']);

/** PDF, PNG and JPEG signatures as they are spelled in this codebase. */
const MAGIC_BYTE_PATTERNS = [
  /%PDF-/,
  /0x89,\s*0x50,\s*0x4e,\s*0x47/i,
  /0xff,\s*0xd8,\s*0xff/i,
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
