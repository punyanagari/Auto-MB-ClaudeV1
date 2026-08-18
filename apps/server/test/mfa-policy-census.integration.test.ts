import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import {
  configureMfaEnforcement,
  MFA_EXEMPT_GRANT_COLUMNS,
  MFA_REQUIRING_AUTHORITIES,
  MFA_REQUIRING_GRANT_COLUMNS,
} from '../src/mfa-policy.js';

/**
 * The MFA authority census (improvement programme P4, reconciled
 * dimension 38: "a new authority column is silently MFA-exempt").
 *
 * The finding-36 wall asks one question — does this account hold anything
 * worth stealing? — and the answer used to be a hand-written OR chain
 * inside `mfaGate`'s SQL. Adding `can_manage_statutory_reporting` in
 * migration 0061 required remembering to extend that chain; nothing would
 * have failed if it had been forgotten, and the account holding the new
 * authority would simply have been exempt from MFA.
 *
 * Two things now stand between a new grant and a silent exemption:
 *
 *   1. `Record<DocumentAuthority, true>` in `mfa-policy.ts` — a new member
 *      of the authority union fails typechecking until it is classified.
 *      That is compile-time and needs no test.
 *   2. This census — a `can_%` column added to `organisation_memberships`
 *      must appear in `MFA_REQUIRING_GRANT_COLUMNS` or, with a stated
 *      reason, in `MFA_EXEMPT_GRANT_COLUMNS`. A column in neither fails
 *      here, so the decision cannot be made by omission.
 *
 * The behavioural half then proves the list is the wall rather than a
 * comment beside it: every column the list names, held alone, is enough to
 * make an account MFA-required as reported by `/api/me`.
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
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let ownerCookie: string;
let organisationId: string;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

async function signUp(email: string, name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name },
  });
  expect(response.statusCode, `sign-up ${email}: ${response.body}`).toBe(200);
  return extractCookies(response.headers['set-cookie']);
}

/** `can_manage_statutory_reporting` → `canManageStatutoryReporting`. The
 * grant column and the member-update field are the same fact in two
 * spellings, so the probe derives one from the other instead of carrying
 * a second hand-maintained map. */
function grantFieldFor(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Whether `/api/me` reports this account as MFA-required. */
async function mfaRequiredFor(cookie: string): Promise<boolean> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ mfaRequired: boolean }>().mfaRequired;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-mfa-census-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
  });
  // The census measures which grants the GATE names, not what the
  // refusals do with it, and the owner below has to keep managing members
  // while unenrolled.
  configureMfaEnforcement(false);

  ownerCookie = await signUp(
    `mfa-census-owner-${runId}@integration.test`,
    'Census Owner',
  );
  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie: ownerCookie },
    payload: { name: 'MFA Census Org', slug: `mfa-census-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

/** Signs a new account up, adds it to the organisation as a plain viewer,
 * and optionally grants it exactly one authority column. */
async function memberHolding(label: string, column: string | null): Promise<string> {
  const email = `mfa-census-${label}-${runId}@integration.test`;
  const cookie = await signUp(email, `Census ${label}`);

  const added = await app.inject({
    method: 'POST',
    url: '/api/organisations/current/members',
    headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
    payload: { email, role: 'viewer' },
  });
  expect(added.statusCode, added.body).toBe(201);

  if (column !== null) {
    const target = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });
    expect(target.statusCode, target.body).toBe(200);
    const targetUserId = target.json<{ user: { id: string } }>().user.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/organisations/current/members/${targetUserId}`,
      headers: { cookie: ownerCookie, 'x-organisation-id': organisationId },
      payload: { [grantFieldFor(column)]: true },
    });
    expect(
      patched.statusCode,
      `granting ${column} (as ${grantFieldFor(column)}): ${patched.body}`,
    ).toBe(200);
  }

  return cookie;
}

describe('MFA authority census', () => {
  it('classifies every can_% grant column on organisation_memberships', async () => {
    const rows = await admin<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'organisation_memberships'
        and column_name like 'can\\_%'
      order by column_name
    `;
    const catalogue = rows.map((row) => row.column_name);
    expect(catalogue.length).toBeGreaterThan(0);

    const classified = [
      ...MFA_REQUIRING_GRANT_COLUMNS,
      ...MFA_EXEMPT_GRANT_COLUMNS,
    ].sort();
    expect(
      [...catalogue].sort(),
      'a new can_% grant on organisation_memberships must be classified in mfa-policy.ts — MFA_REQUIRING_GRANT_COLUMNS, or MFA_EXEMPT_GRANT_COLUMNS with a stated reason. A column in neither is silently exempt from the finding-36 wall.',
    ).toEqual(classified);
  }, 30_000);

  it('never lists a column as both requiring and exempt', () => {
    const overlap = MFA_REQUIRING_GRANT_COLUMNS.filter((column) =>
      MFA_EXEMPT_GRANT_COLUMNS.includes(column),
    );
    expect(overlap).toEqual([]);
  });

  it('requires MFA for every document authority', () => {
    // The Record type makes this exhaustive at compile time; the runtime
    // half catches an authority being REMOVED from the union without the
    // wall being reconsidered.
    expect(Object.keys(MFA_REQUIRING_AUTHORITIES).sort()).toEqual([
      'cancel',
      // The import authority (migration 0094). Its damage is measured in
      // rows: a stolen session holding it can commit a prepared workbook
      // that rewrites every vendor's bank account in a single call, and
      // the payment advices generated afterwards look exactly like the
      // organisation's own.
      'import',
      'issue',
      // The payments authority (migration 0080) moves money out of the
      // organisation's bank, so it joins the wall rather than sitting
      // beside it.
      'payments',
      // The payroll authority (0089/0090) reveals every salary and PAN and
      // authorises the salaries a run pays, so it joins the wall too.
      'payroll',
      // The signing authority (migration 0091). A stolen session that can
      // queue a signature can get a signer standing at the token to put
      // the organisation's registered certificate on it.
      'sign',
      'statutory',
    ]);
    expect(Object.values(MFA_REQUIRING_AUTHORITIES)).not.toContain(false);
  });

  it('makes an account holding any single listed grant MFA-required', async () => {
    for (const column of MFA_REQUIRING_GRANT_COLUMNS) {
      const cookie = await memberHolding(column.replace(/_/g, '-'), column);
      expect(
        await mfaRequiredFor(cookie),
        `a member holding only ${column} was not MFA-required; the gate query and MFA_REQUIRING_GRANT_COLUMNS have drifted apart`,
      ).toBe(true);
    }
  }, 120_000);

  it('leaves an account holding no grant unrequired', async () => {
    const cookie = await memberHolding('plain-viewer', null);
    expect(await mfaRequiredFor(cookie)).toBe(false);
  }, 60_000);
});
