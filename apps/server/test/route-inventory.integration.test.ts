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
