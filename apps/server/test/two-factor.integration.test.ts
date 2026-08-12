import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import { configureMfaEnforcement } from '../src/mfa-policy.js';

/**
 * Finding 36 (owner MFA): the privilege-holders hard wall. Any user holding
 * an owner role or a document authority in ANY organisation must complete
 * TOTP enrolment before tenant-scoped requests are served; disable is
 * refused for such users; enable/disable revoke the account's other
 * sessions; and every two-factor act lands in identity_audit_events.
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
const ownerEmail = `mfa-owner-${runId}@integration.test`;
const viewerEmail = `mfa-viewer-${runId}@integration.test`;
const promotedEmail = `mfa-promoted-${runId}@integration.test`;
const lockyEmail = `mfa-locky-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let organisationId: string;

interface CookieJar {
  cookie: string;
}

/** Collapses Set-Cookie headers into a Cookie header value. */
function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

/** Later cookies win by name, so a rotated session token replaces the old
 * one instead of riding beside it. */
function mergeCookies(jar: CookieJar, setCookie: string | string[] | undefined): void {
  const byName = new Map<string, string>();
  for (const pair of [jar.cookie, extractCookies(setCookie)]
    .join('; ')
    .split('; ')
    .filter((entry) => entry.includes('='))) {
    const name = pair.split('=')[0] ?? '';
    byName.set(name, pair);
  }
  jar.cookie = [...byName.values()].join('; ');
}

async function signUp(email: string, name: string): Promise<CookieJar> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name },
  });
  expect(response.statusCode, `sign-up ${email}: ${response.body}`).toBe(200);
  const cookie = extractCookies(response.headers['set-cookie']);
  expect(cookie).toContain('better-auth');
  return { cookie };
}

async function signIn(email: string): Promise<{
  jar: CookieJar;
  body: { twoFactorRedirect?: boolean };
}> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  expect(response.statusCode, `sign-in ${email}: ${response.body}`).toBe(200);
  return {
    jar: { cookie: extractCookies(response.headers['set-cookie']) },
    body: response.json<{ twoFactorRedirect?: boolean }>(),
  };
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

// --- Independent TOTP implementation (RFC 6238 over the otpauth URI) so the
// test proves interoperability with a real authenticator app, not merely
// that Better Auth agrees with itself through its own helper. ---

function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of encoded.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function secretFromTotpUri(totpURI: string): Buffer {
  const secret = new URL(totpURI).searchParams.get('secret');
  expect(secret, totpURI).toBeTruthy();
  return base32Decode(secret ?? '');
}

function totpCode(secret: Buffer, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 15;
  const truncated =
    (((digest[offset] ?? 0) & 127) << 24) |
    (((digest[offset + 1] ?? 0) & 255) << 16) |
    (((digest[offset + 2] ?? 0) & 255) << 8) |
    ((digest[offset + 3] ?? 0) & 255);
  return String(truncated % 1_000_000).padStart(6, '0');
}

function wrongCodeAgainst(correct: string): string {
  return correct === '000000' ? '000001' : '000000';
}

async function userIdOf(email: string): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${email}
  `;
  expect(row, email).toBeDefined();
  return row?.id ?? '';
}

async function auditActionsOf(userId: string): Promise<string[]> {
  const rows = await admin<{ action: string }[]>`
    select action from identity_audit_events
    where user_id = ${userId} and action like 'two_factor_%'
    order by occurred_at
  `;
  return rows.map((row) => row.action);
}

async function sessionCountOf(userId: string): Promise<number> {
  const [row] = await admin<{ count: string }[]>`
    select count(*)::text as count from auth_sessions where "userId" = ${userId}
  `;
  return Number(row?.count ?? '0');
}

/** Completes TOTP enrolment for a signed-in jar; returns the shared secret
 * and the one-time backup codes. */
async function enrol(
  jar: CookieJar,
): Promise<{ secret: Buffer; backupCodes: string[] }> {
  const enable = await authed(jar, {
    method: 'POST',
    url: '/api/auth/two-factor/enable',
    payload: { password },
  });
  expect(enable.statusCode, enable.body).toBe(200);
  const { totpURI, backupCodes } = enable.json<{
    totpURI: string;
    backupCodes: string[];
  }>();
  const secret = secretFromTotpUri(totpURI);
  expect(backupCodes.length).toBeGreaterThan(0);

  const verify = await authed(jar, {
    method: 'POST',
    url: '/api/auth/two-factor/verify-totp',
    payload: { code: totpCode(secret) },
  });
  expect(verify.statusCode, verify.body).toBe(200);
  // Enable-completion rotates the caller's session; adopt the new cookie.
  mergeCookies(jar, verify.headers['set-cookie']);
  return { secret, backupCodes };
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-two-factor-admin',
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

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    mfaEnforce: true,
    // The whole suite shares one client address; the deliberate limiter
    // proof below builds its own tightly-limited instance.
    rateLimits: { auth: { windowMs: 60_000, max: 1000 } },
  });
});

afterAll(async () => {
  configureMfaEnforcement(false);
  if (admin) {
    if (organisationId) {
      for (const table of [
        'audit_events',
        'organisation_memberships',
        // Organisation creation seeds the GST rate master (0048); the
        // rows must go before the organisation they reference.
        'gst_rates',
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
        where "email" like ${`mfa-%-${runId}@integration.test`}
      )
    `;
    // Cascades sessions, accounts, and two-factor rows.
    await admin`
      delete from auth_users where "email" like ${`mfa-%-${runId}@integration.test`}
    `;
  }
  await app?.close();
  await admin?.end();
});

describe('finding 36: MFA hard wall for privilege holders', () => {
  let owner: CookieJar;
  let viewer: CookieJar;
  let promoted: CookieJar;
  let ownerSecret: Buffer;
  let ownerBackupCodes: string[];

  it('signs up the actors and creates the organisation', async () => {
    owner = await signUp(ownerEmail, 'Mfa Owner');
    viewer = await signUp(viewerEmail, 'Mfa Viewer');
    promoted = await signUp(promotedEmail, 'Mfa Promoted');
    await signUp(lockyEmail, 'Mfa Locky');

    const created = await authed(owner, {
      method: 'POST',
      url: '/api/organisations',
      payload: { name: 'MFA Constructions', slug: `mfa-org-${runId}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    organisationId = created.json<{ id: string }>().id;
  });

  it('refuses tenant-scoped requests to a privileged, unenrolled user', async () => {
    const refused = await authed(owner, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId,
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'MFA_ENROLMENT_REQUIRED' });
  });

  it('keeps the enrolment path reachable: /api/me and /api/organisations still answer', async () => {
    const me = await authed(owner, { method: 'GET', url: '/api/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      mfaRequired: true,
      twoFactorEnabled: false,
      mfaEnforced: true,
    });

    const organisations = await authed(owner, {
      method: 'GET',
      url: '/api/organisations',
    });
    expect(organisations.statusCode).toBe(200);
  });

  it('admits the same user after dark-deploy enforcement is switched off (gate computes, refusal is flagged)', async () => {
    configureMfaEnforcement(false);
    try {
      const admitted = await authed(owner, {
        method: 'GET',
        url: '/api/organisations/current/members',
        organisationId,
      });
      expect(admitted.statusCode, admitted.body).toBe(200);
      // The gate still computes while dark: /api/me keeps telling the truth.
      const me = await authed(owner, { method: 'GET', url: '/api/me' });
      expect(me.json()).toMatchObject({ mfaRequired: true, mfaEnforced: false });
    } finally {
      configureMfaEnforcement(true);
    }
  });

  it('enrols the owner: enable returns the TOTP URI once, verify completes it, other sessions die', async () => {
    const ownerId = await userIdOf(ownerEmail);
    // A parallel pre-enrolment session that must not survive enrolment.
    const { jar: hijacked, body } = await signIn(ownerEmail);
    expect(body.twoFactorRedirect).toBeUndefined();
    expect((await authed(hijacked, { method: 'GET', url: '/api/me' })).statusCode).toBe(
      200,
    );

    const { secret, backupCodes } = await enrol(owner);
    ownerSecret = secret;
    ownerBackupCodes = backupCodes;

    // The enrolling session survives (rotated), every other session is gone.
    expect((await authed(owner, { method: 'GET', url: '/api/me' })).statusCode).toBe(
      200,
    );
    expect((await authed(hijacked, { method: 'GET', url: '/api/me' })).statusCode).toBe(
      401,
    );
    expect(await sessionCountOf(ownerId)).toBe(1);

    // The act is audited as enrolment completion, not a routine verify.
    expect(await auditActionsOf(ownerId)).toEqual(['two_factor_enabled']);

    const me = await authed(owner, { method: 'GET', url: '/api/me' });
    expect(me.json()).toMatchObject({ mfaRequired: true, twoFactorEnabled: true });
  });

  it('admits the enrolled owner to tenant-scoped requests and shows per-member enrolment', async () => {
    const members = await authed(owner, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId,
    });
    expect(members.statusCode, members.body).toBe(200);
    expect(
      members.json<{ members: { userId: string; twoFactorEnabled: boolean }[] }>()
        .members,
    ).toEqual([
      expect.objectContaining({
        userId: await userIdOf(ownerEmail),
        twoFactorEnabled: true,
      }),
    ]);
  });

  it('leaves an unprivileged viewer untouched by the wall', async () => {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email: viewerEmail, role: 'viewer' },
    });
    expect(added.statusCode, added.body).toBe(201);

    const viewerMe = await authed(viewer, { method: 'GET', url: '/api/me' });
    expect(viewerMe.json()).toMatchObject({
      mfaRequired: false,
      twoFactorEnabled: false,
    });

    const list = await authed(viewer, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId,
    });
    expect(list.statusCode, list.body).toBe(200);

    // The owner's member list shows who has and has not enrolled.
    const ownersView = await authed(owner, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId,
    });
    const rows = ownersView.json<{
      members: { userId: string; twoFactorEnabled: boolean }[];
    }>().members;
    expect(
      rows.find((row) => row.userId !== undefined && !row.twoFactorEnabled),
    ).toBeDefined();
  });

  it('starts refusing a member the moment issue authority is granted', async () => {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email: promotedEmail, role: 'viewer' },
    });
    expect(added.statusCode, added.body).toBe(201);

    const before = await authed(promoted, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId,
    });
    expect(before.statusCode, before.body).toBe(200);

    const grant = await authed(owner, {
      method: 'PATCH',
      url: `/api/organisations/current/members/${await userIdOf(promotedEmail)}`,
      organisationId,
      payload: { canIssueDocuments: true },
    });
    expect(grant.statusCode, grant.body).toBe(200);

    const after = await authed(promoted, {
      method: 'GET',
      url: '/api/organisations/current/members',
      organisationId,
    });
    expect(after.statusCode, after.body).toBe(403);
    expect(after.json()).toMatchObject({ code: 'MFA_ENROLMENT_REQUIRED' });
  });

  it('refuses two-factor disable for a required user before Better Auth sees it', async () => {
    const refused = await authed(owner, {
      method: 'POST',
      url: '/api/auth/two-factor/disable',
      payload: { password },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'MFA_REQUIRED_BY_POLICY' });

    const [row] = await admin<{ enabled: boolean | null }[]>`
      select "twoFactorEnabled" as enabled from auth_users
      where "email" = ${ownerEmail}
    `;
    expect(row?.enabled).toBe(true);
  });

  it('answers sign-in with twoFactorRedirect and no session (regression pin on Better Auth)', async () => {
    const ownerId = await userIdOf(ownerEmail);
    const sessionsBefore = await sessionCountOf(ownerId);

    const { jar: pending, body } = await signIn(ownerEmail);
    expect(body).toMatchObject({ twoFactorRedirect: true });
    expect(await sessionCountOf(ownerId)).toBe(sessionsBefore);
    // The challenge cookie is not a session.
    expect((await authed(pending, { method: 'GET', url: '/api/me' })).statusCode).toBe(
      401,
    );

    // ...and the TOTP code completes the sign-in on the challenge cookie.
    const verified = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: { cookie: pending.cookie },
      payload: { code: totpCode(ownerSecret) },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const signedIn: CookieJar = { cookie: pending.cookie };
    mergeCookies(signedIn, verified.headers['set-cookie']);
    expect((await authed(signedIn, { method: 'GET', url: '/api/me' })).statusCode).toBe(
      200,
    );
    expect(await auditActionsOf(ownerId)).toEqual([
      'two_factor_enabled',
      'two_factor_verified',
    ]);
  });

  it('accepts a backup code exactly once and audits its use', async () => {
    const ownerId = await userIdOf(ownerEmail);
    const code = ownerBackupCodes[0] ?? '';

    const { jar: pending } = await signIn(ownerEmail);
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-backup-code',
      headers: { cookie: pending.cookie },
      payload: { code },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(await auditActionsOf(ownerId)).toContain('two_factor_backup_code_used');

    // The same code is dead on the next challenge.
    const { jar: again } = await signIn(ownerEmail);
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-backup-code',
      headers: { cookie: again.cookie },
      payload: { code },
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('lets an unrequired user disable, audits it, and revokes their other sessions', async () => {
    const viewerId = await userIdOf(viewerEmail);
    await enrol(viewer);
    expect(await auditActionsOf(viewerId)).toEqual(['two_factor_enabled']);

    // A parallel session that must not survive the disable.
    const { jar: pendingOther } = await signIn(viewerEmail);
    const otherVerified = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: { cookie: pendingOther.cookie },
      payload: {
        code: totpCode(
          await (async () => {
            const uri = await authed(viewer, {
              method: 'POST',
              url: '/api/auth/two-factor/get-totp-uri',
              payload: { password },
            });
            expect(uri.statusCode, uri.body).toBe(200);
            return secretFromTotpUri(uri.json<{ totpURI: string }>().totpURI);
          })(),
        ),
      },
    });
    expect(otherVerified.statusCode, otherVerified.body).toBe(200);
    const other: CookieJar = { cookie: pendingOther.cookie };
    mergeCookies(other, otherVerified.headers['set-cookie']);
    expect((await authed(other, { method: 'GET', url: '/api/me' })).statusCode).toBe(
      200,
    );

    const disabled = await authed(viewer, {
      method: 'POST',
      url: '/api/auth/two-factor/disable',
      payload: { password },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    mergeCookies(viewer, disabled.headers['set-cookie']);

    expect((await authed(viewer, { method: 'GET', url: '/api/me' })).statusCode).toBe(
      200,
    );
    expect((await authed(other, { method: 'GET', url: '/api/me' })).statusCode).toBe(
      401,
    );
    expect(await sessionCountOf(viewerId)).toBe(1);
    expect(await auditActionsOf(viewerId)).toEqual([
      'two_factor_enabled',
      'two_factor_verified',
      'two_factor_disabled',
    ]);

    const me = await authed(viewer, { method: 'GET', url: '/api/me' });
    expect(me.json()).toMatchObject({ twoFactorEnabled: false });
  });

  it('audits the built-in verification lockout as two_factor_locked', async () => {
    const { jar: lockyJar } = await signIn(lockyEmail);
    const lockyId = await userIdOf(lockyEmail);
    const { secret } = await enrol(lockyJar);
    const wrong = () => wrongCodeAgainst(totpCode(secret));

    // Two five-attempt challenges exhaust the ten-failure account budget…
    for (let challenge = 0; challenge < 2; challenge += 1) {
      const { jar: pending, body } = await signIn(lockyEmail);
      expect(body).toMatchObject({ twoFactorRedirect: true });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await app.inject({
          method: 'POST',
          url: '/api/auth/two-factor/verify-totp',
          headers: { cookie: pending.cookie },
          payload: { code: wrong() },
        });
        expect(failed.statusCode, failed.body).toBe(401);
      }
    }

    // …so the next challenge answers 429 and the lock is audited against
    // the account the challenge cookie names.
    const { jar: locked } = await signIn(lockyEmail);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: { cookie: locked.cookie },
      payload: { code: totpCode(secret) },
    });
    expect(refused.statusCode, refused.body).toBe(429);
    expect(await auditActionsOf(lockyId)).toEqual([
      'two_factor_enabled',
      'two_factor_locked',
    ]);
  });

  it('rate-limits the two-factor endpoints per address', async () => {
    const limited = await buildApp({
      databaseUrl: appUrl,
      authSecret: `integration-secret-${'0'.repeat(32)}`,
      baseUrl: 'http://127.0.0.1:3000',
      rateLimits: { auth: { windowMs: 60_000, max: 3 } },
    });
    try {
      let lastStatus = 0;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await limited.inject({
          method: 'POST',
          url: '/api/auth/two-factor/verify-totp',
          payload: { code: '000000' },
        });
        lastStatus = response.statusCode;
      }
      expect(lastStatus).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
