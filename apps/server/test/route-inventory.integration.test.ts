import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import {
  registeredRoutesOf,
  tenantRoutesOf,
  type TenantRouteRecord,
} from '../src/tenant-route.js';

/**
 * The route-inventory test (2026-08-12 structure review, A1): the tenant
 * preamble — session, organisation header, membership-bound transaction —
 * became a mechanism (src/tenant-route.ts), and this test is what turns
 * the mechanism into a guarantee. It walks the full Fastify route table
 * captured at build time and proves that
 *
 *   1. every /api/* route outside the documented unbound set below was
 *      registered through the tenant-route wrapper (a route registered
 *      around it is a failure here, not a convention slip), and
 *   2. every wrapper route behaves like one: an unauthenticated request
 *      is refused 401 UNAUTHENTICATED, and an authenticated user who is
 *      not a member of the named organisation is refused 403 NOT_A_MEMBER
 *      before any tenant data is touched.
 *
 * The behavioural half needs requests that survive schema validation, so
 * request values are synthesised from each route's own TypeBox schema;
 * the few routes with handler guards ahead of the tenant transaction
 * carry explicit overrides.
 */

/**
 * The documented unbound set — the ONLY /api routes that answer without
 * the tenant preamble, each for a stated reason:
 *
 * - `/api/auth/*` (GET+POST): Better Auth's own surface; sessions are
 *   created here, so it cannot demand one.
 * - `GET /api/health`, `GET /api/ready`: liveness/readiness probes for
 *   the deployment, deliberately unauthenticated.
 * - `GET /api/me`: the signed-in user's identity and memberships —
 *   authenticated (requireUser) but organisation-less by nature.
 * - `GET /api/organisations`, `POST /api/organisations`: the organisation
 *   picker and bootstrap — authenticated, but they exist precisely for
 *   users who cannot yet send an organisation header.
 *
 * (`/metrics` and `/documentation` sit outside /api and outside this
 * test's scope; /metrics additionally only exists when a token is set.)
 */
const UNBOUND_ROUTES = new Set([
  'GET /api/auth/*',
  'POST /api/auth/*',
  'GET /api/health',
  'GET /api/ready',
  'GET /api/me',
  'GET /api/organisations',
  'POST /api/organisations',
]);

/**
 * Lists that answer in full, on purpose, with the reason (pack P12).
 *
 * The reconciled review counted about fifty list endpoints that read a
 * table and serialised all of it. Six of them — the ones whose row count
 * grows with the WORK rather than with the organisation's configuration —
 * are keyset-paginated now. The rest are here, each with the fact that
 * bounds it, so that "unpaginated" is a decision this file records rather
 * than the default a new list falls into.
 *
 * Adding a list means adding a row here or accepting `limit`/`cursor`.
 * That is the whole point: the next unbounded register should have to
 * argue for itself.
 *
 * What this map does NOT reach: a response that names a single entity
 * beside its arrays reads as a detail to the shape rule below, so
 * `GET /api/dashboard` (an unbounded `works` array beside the portfolio
 * summary) and `GET /api/works/:id/completion` (extension letters beside
 * the Work's completion facts) are outside it. The dashboard is a real
 * unbounded read and pack P11 owns that route this wave; it is recorded
 * here rather than left to be rediscovered.
 */
const UNPAGINATED_LISTS = new Map<string, string>([
  // --- Bounded by the organisation's configuration ------------------------
  [
    'GET /api/masters/contacts',
    'party master: one row per party the agency deals with',
  ],
  ['GET /api/masters/locations', 'site master, curated by hand'],
  ['GET /api/masters/units', 'unit master, seeded from a canonical list'],
  ['GET /api/masters/signatories', "the agency's own signing officers"],
  ['GET /api/masters/gst-rates', 'the notified GST rate slabs'],
  ['GET /api/organisation/number-series', 'four configurable document types'],
  ['GET /api/organisations/current/members', 'staff headcount'],

  // --- Bounded by the Work's own schedule ---------------------------------
  ['GET /api/works/:id/balance', 'one row per LOA schedule item'],
  ['GET /api/works/:id/payment-matrix', 'at most one row per payment matrix category'],
  ['GET /api/works/:id/completion-readiness', 'blockers, one per unfinished item'],
  ['GET /api/works/:id/consignees', 'the consignees linked to one Work'],
  [
    'GET /api/works/:id/supersede-eligibility',
    'blockers, at most one per downstream register',
  ],
  ['GET /api/works/:id/instruments', 'the PBG/PAC/DOC instruments of one Work'],
  [
    'GET /api/works/:id/received-railway-bills',
    "one railway bill per measurement, and a Work's measurements are its Measurement Books",
  ],
  [
    'GET /api/works/:id/bill-settlement',
    'one position per prepared bill, and a bill is prepared from a Measurement Book; the whole point of the answer is that it is a Work-wide total',
  ],
  [
    'GET /api/organisations/current/members/:userId/assignments',
    'work ids assigned to one member; the picker needs all of them at once',
  ],
  [
    'GET /api/loa-documents/:id/contract-source-context',
    "one letter's supporting tender documents and extracted clauses",
  ],
  [
    'GET /api/works/:id/contract-source-context',
    "one Work's supporting tender documents and extracted clauses",
  ],

  // --- Bounded by the parent document -------------------------------------
  ['GET /api/tax-invoices/:id/credit-notes', 'the credit notes against one invoice'],
  ['GET /api/tax-invoices/:id/eway-bills', 'the e-way bills of one invoice'],
  ['GET /api/challans/:id/correction-notices', 'the notices against one challan'],

  // --- Not registers at all -----------------------------------------------
  //
  // One record each, whose own parts sit flat beside its fields instead of
  // under a named object — so the shape test above cannot tell them from a
  // list, and they are named here rather than by loosening the test.
  ['GET /api/loa-documents/:id', 'one letter, with its extracted schedule'],
  ['GET /api/pac-certificates/:id', 'one certificate, with its items'],

  // --- Capped or streamed by the route itself ------------------------------
  ['GET /api/search', 'ten hits per group, with a `truncated` flag'],
  ['GET /api/serials/search', 'fifty matches, with a `truncated` flag'],
  [
    'GET /api/export',
    'the whole tenant record by definition — a page of it would not be an export; pack P11 made it stream, section by section, so it is bounded in memory rather than in rows',
  ],

  // --- Unbounded and still unpaginated ------------------------------------
  //
  // Named rather than excused. Each is a register that grows without limit
  // and would page the same way the six do; they are the next candidates,
  // and this block is the list a future pack works through.
  ['GET /api/works', 'grows per organisation — next candidate'],
  ['GET /api/loa-documents', 'grows per organisation — next candidate'],
  ['GET /api/credit-notes', 'grows per organisation — next candidate'],
  ['GET /api/budgetary-quotations', 'grows per organisation — next candidate'],
  ['GET /api/works/:id/issue-challans', 'grows per Work — next candidate'],
  ['GET /api/works/:id/tax-invoices', 'grows per Work — next candidate'],
  ['GET /api/works/:id/purchase-orders', 'grows per Work — next candidate'],
  ['GET /api/works/:id/correction-notices', 'grows per Work — next candidate'],
  ['GET /api/works/:id/pac-certificates', 'grows per Work — next candidate'],
  ['GET /api/works/:id/bills', 'grows per Work — next candidate'],
  [
    'GET /api/works/:id/measurement-books',
    'grows per Work; pack P11 owns this route this wave',
  ],
]);

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
const outsiderEmail = `inventory-outsider-${runId}@integration.test`;
const insiderEmail = `inventory-insider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
/** An organisation the outsider holds NO membership in. */
let foreignOrganisationId: string;
let outsiderCookie: string;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

// --- Request synthesis from the route's own TypeBox schema ------------------

/** Candidate strings tried against `pattern` constraints. Every pattern in
 * the contracts either matches one of these or earns a new candidate; the
 * sampler fails loudly with the pattern so the list stays honest. */
const STRING_CANDIDATES = [
  '2026-01-15',
  'SUPPLY',
  'works',
  '998739',
  '18.00',
  '5.000',
  '100.00',
  '110001',
  '07',
  'sample text for the inventory test',
  'SAMPLE',
  'ABCDE1234F1Z5',
  '07ABCDE1234F1Z5',
  'DL01AB1234',
  '123456789012',
  '1',
  'xx',
  'ab'.repeat(32), // sha256 hex digests
  '2026-01-15T10:30:00+05:30', // ack timestamps
];

interface JsonSchemaLike {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  minItems?: number;
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
}

function sampleString(schema: JsonSchemaLike): string {
  if (schema.format === 'uuid') return randomUUID();
  if (schema.format === 'date') return '2026-01-15';
  if (schema.format === 'date-time') return '2026-01-15T10:30:00.000Z';
  if (schema.format === 'email') return `inventory-${runId}@integration.test`;
  if (schema.pattern !== undefined) {
    // The pattern comes from this repository's own contracts schemas,
    // never from request input.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const pattern = new RegExp(schema.pattern);
    const fits = (value: string): boolean =>
      pattern.test(value) &&
      value.length >= (schema.minLength ?? 0) &&
      value.length <= (schema.maxLength ?? Number.POSITIVE_INFINITY);
    const uuid = randomUUID();
    if (fits(uuid)) return uuid;
    const candidate = STRING_CANDIDATES.find(fits);
    if (candidate !== undefined) return candidate;
    throw new Error(`no sample string matches pattern ${schema.pattern}`);
  }
  const minLength = Math.max(schema.minLength ?? 1, 1);
  return 'sample text for the inventory test'
    .slice(0, Math.max(minLength, 8))
    .padEnd(minLength, 'x');
}

function sampleValue(schema: JsonSchemaLike): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return sampleValue(schema.anyOf[0] as JsonSchemaLike);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return sampleValue(schema.oneOf[0] as JsonSchemaLike);
  }
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        if (required.has(key)) out[key] = sampleValue(property);
      }
      return out;
    }
    case 'array': {
      const length = Math.max(schema.minItems ?? 0, 1);
      const items = schema.items ?? {};
      return Array.from({ length }, () => sampleValue(items));
    }
    case 'string':
      return sampleString(schema);
    case 'number':
    case 'integer':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      throw new Error(`unsampleable schema: ${JSON.stringify(schema)}`);
  }
}

/**
 * Handler guards that run BEFORE the tenant transaction reject some
 * synthesised bodies with a 400; these routes carry hand-written values
 * that satisfy those guards, so the request provably reaches the
 * membership floor.
 */
/** Merged over the sampled body where only one field trips a pre-tenant
 * guard. */
const PAYLOAD_PATCHES = new Map<string, Record<string, unknown>>([
  // per_schedule needs no letterPercentage; the sampler picks the union's
  // first literal, whose companion fields it omits.
  ['POST /api/loa-documents/:id/confirm', { pricingShape: 'per_schedule' }],
  // The CORRECTION_EMPTY guard runs before the tenant transaction; the
  // sampler omits the optional statement.
  [
    'POST /api/challans/:id/corrections/notice',
    { statement: 'route-inventory probe statement' },
  ],
]);

const PAYLOAD_OVERRIDES = new Map<string, unknown>([
  // assertPercentagesSumTo100 runs before the tenant transaction.
  [
    'PUT /api/works/:id/payment-matrix/:category',
    { pctSupply: '100.00', pctInstallation: '0', pctPac: '0', pctFinalBill: '0' },
  ],
  // The AMENDMENT_EMPTY guard runs before the tenant transaction; the
  // sampler omits optional fields, so name one change explicitly.
  [
    'POST /api/works/:id/amendments',
    {
      workItemId: randomUUID(),
      reason: 'route-inventory probe reason',
      changes: { quantity: '5.000' },
    },
  ],
  // The exactly-one-of locationId/newLocation guard runs before the
  // tenant transaction; the sampler omits both optionals.
  [
    'POST /api/works/:id/installations',
    {
      workItemId: randomUUID(),
      quantity: '1.000',
      installedOn: '2026-01-15',
      locationId: randomUUID(),
    },
  ],
  // assertValidTemplate runs before the tenant transaction and requires
  // the {SEQ} token.
  ['PUT /api/organisation/number-series/:documentType', { template: '{PREFIX}/{SEQ}' }],
]);

const PDF_MAGIC = Buffer.from('%PDF-1.4 inventory probe');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

interface SynthesisedRequest {
  url: string;
  payload?: unknown;
  contentType?: string;
}

function synthesiseRequest(record: TenantRouteRecord): SynthesisedRequest {
  const schema = record.schema as {
    params?: JsonSchemaLike;
    querystring?: JsonSchemaLike;
    body?: JsonSchemaLike;
  };

  // path params: the route's own params schema first, uuid otherwise
  // (the :userId member routes deliberately declare no params schema).
  const paramProperties = schema.params?.properties ?? {};
  const url = record.url
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const name = segment.slice(1);
      const property = paramProperties[name];
      return property !== undefined ? String(sampleValue(property)) : randomUUID();
    })
    .join('/');

  // querystring: required properties only
  let query = '';
  if (schema.querystring !== undefined) {
    const sampled = sampleValue(schema.querystring) as Record<string, unknown>;
    const entries = Object.entries(sampled);
    if (entries.length > 0) {
      query =
        '?' +
        entries
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&');
    }
  }

  // body: JSON from the schema; raw magic bytes for the upload routes
  // (recognisable by their bodyLimit and missing body schema).
  const override = PAYLOAD_OVERRIDES.get(`${record.method} ${record.url}`);
  if (override !== undefined) return { url: url + query, payload: override };
  if (schema.body !== undefined) {
    const sampled = sampleValue(schema.body);
    const patch = PAYLOAD_PATCHES.get(`${record.method} ${record.url}`);
    return {
      url: url + query,
      payload:
        patch === undefined
          ? sampled
          : { ...(sampled as Record<string, unknown>), ...patch },
    };
  }
  // The logo route carries no bodyLimit of its own (the default 1 MB
  // limit covers it) but is still a raw-body upload.
  if (
    (record.bodyLimit !== undefined || record.url === '/api/organisation/logo') &&
    (record.method === 'POST' || record.method === 'PUT')
  ) {
    const isImageUpload = record.url.includes('/logo');
    return {
      url: url + query,
      payload: isImageUpload ? PNG_MAGIC : PDF_MAGIC,
      contentType: isImageUpload ? 'image/png' : 'application/pdf',
    };
  }
  return { url: url + query };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-route-inventory-admin',
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-inventory-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    // The behavioural sweep below sends two requests per route; the
    // default per-address upload window is smaller than the sweep.
    rateLimits: {
      auth: { windowMs: 60_000, max: 1_000 },
      upload: { windowMs: 60_000, max: 1_000 },
    },
  });

  const signUp = async (email: string, name: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name },
    });
    expect(response.statusCode, `sign-up ${email}: ${response.body}`).toBe(200);
    return extractCookies(response.headers['set-cookie']);
  };

  outsiderCookie = await signUp(outsiderEmail, 'Inventory Outsider');
  const insiderCookie = await signUp(insiderEmail, 'Inventory Insider');

  // The insider founds the organisation; the outsider never joins it.
  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie: insiderCookie },
    payload: { name: 'Inventory Foreign Org', slug: `inventory-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  foreignOrganisationId = created.json<{ id: string }>().id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

/** Sends the synthesised request for a route with the given extra headers
 * (the outsider's cookie for the 403 sweep; nothing for the 401 sweep). */
async function injectSynthesised(
  record: TenantRouteRecord,
  extraHeaders: Record<string, string>,
) {
  const { url, payload, contentType } = synthesiseRequest(record);
  const method = record.method as Exclude<InjectOptions['method'], undefined>;
  const headers: Record<string, string> = {
    'x-organisation-id': foreignOrganisationId,
    ...extraHeaders,
  };
  if (contentType !== undefined) headers['content-type'] = contentType;
  return payload !== undefined
    ? app.inject({
        method,
        url,
        headers,
        payload: payload as Exclude<InjectOptions['payload'], undefined>,
      })
    : app.inject({ method, url, headers });
}

describe('route inventory: the tenant preamble is a mechanism', () => {
  it('accounts for every /api route: tenant-route wrapper or documented unbound set', () => {
    const table = registeredRoutesOf(app);
    expect(table.size).toBeGreaterThan(100);
    const wrapper = tenantRoutesOf(app);

    const unaccounted = [...table].filter((entry) => {
      const [method, url] = entry.split(' ') as [string, string];
      // HEAD routes are Fastify's automatic mirrors of the GETs and run
      // the same handler; OPTIONS never registers here.
      if (method === 'HEAD' || method === 'OPTIONS') return false;
      if (!url.startsWith('/api/')) return false;
      if (UNBOUND_ROUTES.has(entry)) return false;
      return !wrapper.has(entry);
    });
    expect(
      unaccounted,
      'every /api route must go through createTenantRouteRegistrar or be added — deliberately — to the documented unbound set',
    ).toEqual([]);

    // The registry cannot claim routes the app does not actually serve.
    const phantom = [...wrapper.keys()].filter((entry) => !table.has(entry));
    expect(phantom).toEqual([]);
  });

  /*
   * Pack P12: two contract facts the inventory can prove from the route
   * table alone, without a request.
   */

  it('declares the throttle refusal on every tenant route', () => {
    // 429 is written by the sliding-window hook in app.ts, before any
    // handler runs, so no route file ever named it in its own `response`
    // map — and the published contract said two hundred endpoints could
    // not rate-limit. The registrar now declares it for every route it
    // registers; this asserts the declaration survived.
    const missing = [...tenantRoutesOf(app).values()]
      .filter((record) => {
        const response = (record.schema as { response?: Record<string, unknown> })
          .response;
        return response === undefined || !Object.hasOwn(response, '429');
      })
      .map((record) => `${record.method} ${record.url}`)
      .sort();

    expect(
      missing,
      'every tenant route must declare 429 in its response schema (createTenantRouteRegistrar adds it)',
    ).toEqual([]);
  });

  it('pages every list, or records why it does not', () => {
    // "Unpaginated" must be a decision. A route whose 200 payload carries
    // an array either accepts limit/cursor and answers with nextCursor,
    // or is named in UNPAGINATED_LISTS with the fact that bounds it.
    const offenders: string[] = [];
    const staleAllowlistEntries = new Set(UNPAGINATED_LISTS.keys());

    for (const record of tenantRoutesOf(app).values()) {
      const key = `${record.method} ${record.url}`;
      const schema = record.schema as {
        querystring?: JsonSchemaLike;
        response?: Record<string, JsonSchemaLike | undefined>;
      };
      const ok = schema.response?.['200'];
      const properties = ok?.properties ?? {};
      // What counts as a list, decided from the schema rather than from a
      // hand-kept name list: a GET whose 200 payload carries an array and
      // names no single entity beside it. A DETAIL response — `{ work,
      // items }`, `{ challan, items }` — carries arrays too, but they are
      // that record's own parts and page with the record; the object
      // property beside them is what tells the two apart. Mutations are
      // excluded for the same reason: a PUT answering with the register it
      // just changed is showing a result, not offering a page.
      const carriesArray = Object.values(properties).some(
        (property) => property.type === 'array',
      );
      const namesAnEntity = Object.values(properties).some(
        (property) => property.type === 'object',
      );
      if (record.method !== 'GET' || !carriesArray || namesAnEntity) continue;
      staleAllowlistEntries.delete(key);
      if (UNPAGINATED_LISTS.has(key)) continue;

      const query = schema.querystring?.properties ?? {};
      const paginated =
        query['limit'] !== undefined &&
        query['cursor'] !== undefined &&
        properties['nextCursor'] !== undefined;
      if (!paginated) offenders.push(key);
    }

    expect(
      offenders.sort(),
      'a list route must accept limit/cursor and answer with nextCursor, or be added — deliberately, with a reason — to UNPAGINATED_LISTS',
    ).toEqual([]);
    expect(
      [...staleAllowlistEntries].sort(),
      'UNPAGINATED_LISTS names routes that are no longer unpaginated lists',
    ).toEqual([]);
  });

  it('refuses every tenant route unauthenticated with 401 UNAUTHENTICATED', async () => {
    for (const record of tenantRoutesOf(app).values()) {
      const response = await injectSynthesised(record, {});
      expect(
        response.statusCode,
        `${record.method} ${record.url} without a session answered ${response.statusCode}: ${response.body}`,
      ).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('UNAUTHENTICATED');
    }
  }, 120_000);

  it('refuses every tenant route for a non-member with the named 403', async () => {
    for (const record of tenantRoutesOf(app).values()) {
      const response = await injectSynthesised(record, { cookie: outsiderCookie });
      expect(
        response.statusCode,
        `${record.method} ${record.url} for a non-member answered ${response.statusCode}: ${response.body}`,
      ).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('NOT_A_MEMBER');
    }
  }, 120_000);
});
