import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import { createPgRateLimiter } from '../src/rate-limit.js';

/**
 * Ops-batch behaviours: rate limiting on authentication attempts, the
 * account-scoped login lockout, and the component-aware readiness probe.
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

let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-ops-'));
});

afterAll(async () => {
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('rate limiting', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    await app.close();
  });

  it('answers 429 once the auth window is exhausted', async () => {
    app = await buildApp({
      objectStorageDir: storageDir,
      rateLimits: { auth: { windowMs: 60_000, max: 3 } },
    });
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'x@example.test', password: 'irrelevant' },
      });
    for (let index = 0; index < 3; index += 1) {
      const response = await attempt();
      expect(response.statusCode).not.toBe(429);
    }
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code: string }>().code).toBe('RATE_LIMITED');

    // Other endpoints stay unthrottled.
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });

  it('covers the PAC document and extension response uploads with the upload window', async () => {
    // Both endpoints take 25MB PDF bodies through the malware scan, so
    // they must share the per-address upload limiter with the other
    // scan-bearing uploads (review hardening; previously unlimited).
    const uploads = await buildApp({
      objectStorageDir: storageDir,
      rateLimits: { upload: { windowMs: 60_000, max: 2 } },
    });
    try {
      const paths = [
        '/api/pac-certificates/6b1f8f4e-5c15-4dc5-9d94-111111111111/document',
        '/api/extension-requests/6b1f8f4e-5c15-4dc5-9d94-222222222222/response-document',
      ];
      const attempt = (url: string) =>
        uploads.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/pdf' },
          payload: Buffer.from('%PDF-1.4 limiter probe'),
        });
      // The shared window spans both endpoints (2 allowed, third 429s) —
      // unauthenticated probes are fine: the limiter runs before auth.
      expect((await attempt(paths[0] ?? '')).statusCode).not.toBe(429);
      expect((await attempt(paths[1] ?? '')).statusCode).not.toBe(429);
      const limited = await attempt(paths[0] ?? '');
      expect(limited.statusCode).toBe(429);
      expect(limited.json<{ code: string }>().code).toBe('RATE_LIMITED');
      // A read of the same document path is NOT an upload and stays open.
      const read = await uploads.inject({ method: 'GET', url: paths[0] ?? '' });
      expect(read.statusCode).not.toBe(429);
    } finally {
      await uploads.close();
    }
  });

  it('keys per forwarded client behind a trusted proxy hop', async () => {
    // Production topology: every connection reaches Fastify from the
    // Caddy container, which stamps the real client into
    // X-Forwarded-For. Without trustProxy the limiter saw one shared
    // address for the whole site (external re-audit).
    const proxied = await buildApp({
      objectStorageDir: storageDir,
      trustProxyHops: 1,
      rateLimits: { auth: { windowMs: 60_000, max: 2 } },
    });
    try {
      const attempt = (client: string) =>
        proxied.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { 'x-forwarded-for': client },
          payload: { email: 'x@example.test', password: 'irrelevant' },
        });
      for (let index = 0; index < 2; index += 1) {
        expect((await attempt('203.0.113.7')).statusCode).not.toBe(429);
      }
      // The first client's window is exhausted…
      expect((await attempt('203.0.113.7')).statusCode).toBe(429);
      // …while a different forwarded client is unaffected.
      expect((await attempt('203.0.113.8')).statusCode).not.toBe(429);
    } finally {
      await proxied.close();
    }
  });

  it('ignores forwarded headers when no proxy hop is trusted', async () => {
    // Exposed directly, X-Forwarded-For is client-controlled: it must
    // not let an attacker mint fresh rate-limit identities.
    const direct = await buildApp({
      objectStorageDir: storageDir,
      rateLimits: { auth: { windowMs: 60_000, max: 2 } },
    });
    try {
      const attempt = (client: string) =>
        direct.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { 'x-forwarded-for': client },
          payload: { email: 'x@example.test', password: 'irrelevant' },
        });
      expect((await attempt('203.0.113.1')).statusCode).not.toBe(429);
      expect((await attempt('203.0.113.2')).statusCode).not.toBe(429);
      // Third request claims yet another client, but the socket peer is
      // the same — the shared window is exhausted.
      expect((await attempt('203.0.113.3')).statusCode).toBe(429);
    } finally {
      await direct.close();
    }
  });
});

describe('account-scoped login lockout', () => {
  // Unique per run so this suite can never collide with other suites or
  // an earlier crashed run.
  const runId = randomBytes(5).toString('hex');
  const password = `ops-lockout-password-${runId}`;
  const targetEmail = `lockout-target-${runId}@integration.test`;
  const clearingEmail = `lockout-clearing-${runId}@integration.test`;
  const concurrentEmail = `lockout-concurrent-${runId}@integration.test`;
  const expiryEmail = `lockout-expiry-${runId}@integration.test`;
  const ghostEmail = `lockout-ghost-${runId}@integration.test`;

  // Mirrors accountLockoutKey in src/rate-limit.ts: the audit trail and
  // the lockout map key on the sha256 of the normalised email.
  const emailHash = (email: string): string =>
    createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

  let admin: Sql;
  let app: FastifyInstance;

  const signIn = (
    email: string,
    attemptPassword: string,
    clientIp: string,
    requestId?: string,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'x-forwarded-for': clientIp,
        ...(requestId !== undefined ? { 'x-request-id': requestId } : {}),
      },
      payload: { email, password: attemptPassword },
    });

  const signUp = async (email: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name: 'Lockout Fixture' },
    });
    expect(response.statusCode, `sign-up ${email}: ${response.body}`).toBe(200);
  };

  beforeAll(async () => {
    admin = createDatabasePool({
      url: adminUrl,
      max: 1,
      applicationName: 'auto-mb-ops-lockout-admin',
    });
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
      objectStorageDir: storageDir,
      trustProxyHops: 1,
      rateLimits: {
        // Generous per-address window so every 429 in this suite is the
        // account lock, not the address limiter.
        auth: { windowMs: 60_000, max: 1_000 },
        accountLockout: { windowMs: 60_000, maxFailures: 3, lockMs: 60_000 },
      },
    });
    await signUp(targetEmail);
    await signUp(clearingEmail);
    await signUp(concurrentEmail);
    await signUp(expiryEmail);
  });

  afterAll(async () => {
    if (admin) {
      const hashes = [
        targetEmail,
        clearingEmail,
        concurrentEmail,
        expiryEmail,
        ghostEmail,
      ].map((email) => `email-sha256:${emailHash(email)}`);
      await admin`
        delete from identity_audit_events where user_id = any(${hashes})
      `;
      await admin`
        delete from identity_audit_events
        where user_id in (
          select "id" from auth_users
          where "email" like ${`lockout-%-${runId}@integration.test`}
        )
      `;
      await admin`
        delete from auth_users
        where "email" like ${`lockout-%-${runId}@integration.test`}
      `;
    }
    await app?.close();
    await admin?.end();
  });

  it('locks one account after failures from DIFFERENT addresses', async () => {
    // Rotating source addresses walks straight past the per-IP window;
    // the account dimension must still slam shut.
    for (const clientIp of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      const failed = await signIn(targetEmail, 'wrong-password-guess', clientIp);
      expect(failed.statusCode, failed.body).toBe(401);
    }
    const locked = await signIn(targetEmail, 'wrong-password-guess', '198.51.100.4');
    expect(locked.statusCode).toBe(429);
    expect(locked.json<{ code: string }>().code).toBe('RATE_LIMITED');

    // Even the CORRECT password is refused while the lock holds — the
    // response must not become a password oracle either.
    const correctWhileLocked = await signIn(targetEmail, password, '198.51.100.5');
    expect(correctWhileLocked.statusCode).toBe(429);
  });

  it('answers byte-identically for a NONEXISTENT locked account', async () => {
    for (const clientIp of ['198.51.100.6', '198.51.100.7', '198.51.100.8']) {
      const failed = await signIn(ghostEmail, 'wrong-password-guess', clientIp);
      expect(failed.statusCode).toBe(401);
    }
    // Pinning the request id makes the two locked responses comparable
    // byte for byte: any remaining difference would be an existence
    // oracle.
    const requestId = `lockout-oracle-${runId}`;
    const ghostLocked = await signIn(
      ghostEmail,
      'wrong-password-guess',
      '198.51.100.9',
      requestId,
    );
    const realLocked = await signIn(
      targetEmail,
      'wrong-password-guess',
      '198.51.100.9',
      requestId,
    );
    expect(ghostLocked.statusCode).toBe(429);
    expect(realLocked.statusCode).toBe(429);
    expect(ghostLocked.body).toBe(realLocked.body);
    expect(ghostLocked.headers['content-type']).toBe(
      realLocked.headers['content-type'],
    );
  });

  it('keeps the per-address limit for failures spread across accounts', async () => {
    // The account dimension must not replace the address dimension: one
    // address hammering MANY accounts still exhausts its own window.
    const tightIp = await buildApp({
      databaseUrl: appUrl,
      authSecret: `integration-secret-${'0'.repeat(32)}`,
      baseUrl: 'http://127.0.0.1:3000',
      objectStorageDir: storageDir,
      trustProxyHops: 1,
      rateLimits: {
        auth: { windowMs: 60_000, max: 3 },
        accountLockout: { windowMs: 60_000, maxFailures: 3, lockMs: 60_000 },
      },
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        const response = await tightIp.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { 'x-forwarded-for': '198.51.100.40' },
          payload: {
            email: `spread-${String(index)}-${runId}@integration.test`,
            password: 'wrong-password-guess',
          },
        });
        // One failure per account: far below the account threshold.
        expect(response.statusCode, response.body).toBe(401);
      }
      const limited = await tightIp.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { 'x-forwarded-for': '198.51.100.40' },
        payload: {
          email: `spread-3-${runId}@integration.test`,
          password: 'wrong-password-guess',
        },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json<{ code: string }>().code).toBe('RATE_LIMITED');
    } finally {
      await tightIp.close();
    }
  });

  it('clears the failure count on successful login', async () => {
    for (const clientIp of ['198.51.100.10', '198.51.100.11']) {
      const failed = await signIn(clearingEmail, 'wrong-password-guess', clientIp);
      expect(failed.statusCode).toBe(401);
    }
    const success = await signIn(clearingEmail, password, '198.51.100.12');
    expect(success.statusCode, success.body).toBe(200);

    // Two more failures land on a CLEARED counter: four lifetime failures
    // would have locked (threshold three) had the success not reset it.
    for (const clientIp of ['198.51.100.13', '198.51.100.14']) {
      const failed = await signIn(clearingEmail, 'wrong-password-guess', clientIp);
      expect(failed.statusCode).toBe(401);
    }
    const again = await signIn(clearingEmail, password, '198.51.100.15');
    expect(again.statusCode, again.body).toBe(200);
  });

  it('audits the lockout once per episode with no password or raw email', async () => {
    // Concurrent burst: simultaneous failures must produce ONE lockout
    // transition, not one audit row per racing request.
    const burst = await Promise.all(
      [
        '198.51.100.20',
        '198.51.100.21',
        '198.51.100.22',
        '198.51.100.23',
        '198.51.100.24',
      ].map((clientIp) => signIn(concurrentEmail, 'wrong-password-guess', clientIp)),
    );
    for (const response of burst) {
      expect([401, 429]).toContain(response.statusCode);
    }
    const locked = await signIn(
      concurrentEmail,
      'wrong-password-guess',
      '198.51.100.25',
    );
    expect(locked.statusCode).toBe(429);

    const concurrentRows = await admin<
      { user_id: string; request_id: string | null; details: unknown }[]
    >`
      select user_id, request_id, details from identity_audit_events
      where action = 'login_locked'
        and user_id = ${`email-sha256:${emailHash(concurrentEmail)}`}
    `;
    expect(concurrentRows).toHaveLength(1);

    // The earlier suites locked the real target and the ghost: both are
    // audited identically, keyed by hash.
    for (const email of [targetEmail, ghostEmail]) {
      const rows = await admin<{ user_id: string }[]>`
        select user_id from identity_audit_events
        where action = 'login_locked'
          and user_id = ${`email-sha256:${emailHash(email)}`}
      `;
      expect(rows, email).toHaveLength(1);
    }

    // No password material, no raw email anywhere in the audit rows.
    const allRows = await admin<Record<string, unknown>[]>`
      select * from identity_audit_events where action = 'login_locked'
    `;
    const serialised = JSON.stringify(allRows);
    expect(serialised).not.toContain('wrong-password-guess');
    expect(serialised).not.toContain(password);
    expect(serialised).not.toContain('@integration.test');
    expect(serialised).not.toContain(`lockout-target-${runId}`);
  });

  it('expires the lock after its window', async () => {
    const expiring = await buildApp({
      databaseUrl: appUrl,
      authSecret: `integration-secret-${'0'.repeat(32)}`,
      baseUrl: 'http://127.0.0.1:3000',
      objectStorageDir: storageDir,
      trustProxyHops: 1,
      rateLimits: {
        auth: { windowMs: 60_000, max: 1_000 },
        // Short lock, and a window that outlives the test so only the
        // lock expiry (not failure decay) can unlock the account.
        accountLockout: { windowMs: 60_000, maxFailures: 3, lockMs: 400 },
      },
    });
    try {
      const attempt = (attemptPassword: string, clientIp: string) =>
        expiring.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { 'x-forwarded-for': clientIp },
          payload: { email: expiryEmail, password: attemptPassword },
        });
      for (const clientIp of ['198.51.100.30', '198.51.100.31', '198.51.100.32']) {
        expect((await attempt('wrong-password-guess', clientIp)).statusCode).toBe(401);
      }
      expect((await attempt(password, '198.51.100.33')).statusCode).toBe(429);

      await new Promise((resolve) => setTimeout(resolve, 500));
      // The lock has lapsed: the legitimate owner signs straight in (and
      // the success clears the lingering failure history).
      const recovered = await attempt(password, '198.51.100.34');
      expect(recovered.statusCode, recovered.body).toBe(200);
    } finally {
      await expiring.close();
    }
  });
});

describe('shared PostgreSQL throttle state (finding 38)', () => {
  // Two app instances over one database and one explicit shared
  // namespace stand in for two production replicas: the windows and the
  // account lock must count attempts ACROSS instances, where the old
  // in-process maps each counted their own.
  const runId = randomBytes(5).toString('hex');
  const namespace = `finding38-${runId}`;
  const password = `ops-shared-password-${runId}`;
  const sharedEmail = `shared-lock-${runId}@integration.test`;

  let admin: Sql;
  let replicaA: FastifyInstance;
  let replicaB: FastifyInstance;

  const buildReplica = () =>
    buildApp({
      databaseUrl: appUrl,
      authSecret: `integration-secret-${'0'.repeat(32)}`,
      baseUrl: 'http://127.0.0.1:3000',
      objectStorageDir: storageDir,
      trustProxyHops: 1,
      throttleNamespace: namespace,
      rateLimits: {
        auth: { windowMs: 60_000, max: 4 },
        accountLockout: { windowMs: 60_000, maxFailures: 3, lockMs: 60_000 },
      },
    });

  const signInOn = (
    instance: FastifyInstance,
    email: string,
    attemptPassword: string,
    clientIp: string,
  ) =>
    instance.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'x-forwarded-for': clientIp },
      payload: { email, password: attemptPassword },
    });

  beforeAll(async () => {
    admin = createDatabasePool({
      url: adminUrl,
      max: 1,
      applicationName: 'auto-mb-ops-shared-admin',
    });
    await runMigrations(admin, migrationsDirectory);
    replicaA = await buildReplica();
    replicaB = await buildReplica();
    const signedUp = await replicaA.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: sharedEmail, password, name: 'Shared Lock Fixture' },
    });
    expect(signedUp.statusCode, signedUp.body).toBe(200);
  });

  afterAll(async () => {
    if (admin) {
      await admin`
        delete from identity_audit_events
        where user_id in (
          select "id" from auth_users
          where "email" = ${sharedEmail}
        )
      `;
      await admin`
        delete from identity_audit_events
        where user_id = ${`email-sha256:${createHash('sha256')
          .update(sharedEmail.trim().toLowerCase())
          .digest('hex')}`}
      `;
      await admin`delete from auth_users where "email" = ${sharedEmail}`;
    }
    await replicaA?.close();
    await replicaB?.close();
    await admin?.end();
  });

  it('exhausts one per-address window across two instances', async () => {
    // The sign-up in beforeAll keyed on the loopback socket address; the
    // forwarded client below has a fresh window. Four attempts split 2/2
    // across the instances fill it — with the old per-process maps each
    // instance would have allowed four of its own.
    const clientIp = '198.51.100.60';
    expect(
      (await signInOn(replicaA, sharedEmail, 'wrong-guess', clientIp)).statusCode,
    ).toBe(401);
    expect((await signInOn(replicaB, sharedEmail, password, clientIp)).statusCode).toBe(
      200,
    );
    expect((await signInOn(replicaA, sharedEmail, password, clientIp)).statusCode).toBe(
      200,
    );
    expect((await signInOn(replicaB, sharedEmail, password, clientIp)).statusCode).toBe(
      200,
    );
    // Fifth attempt: EITHER instance refuses, because the count is shared.
    const limitedOnB = await signInOn(replicaB, sharedEmail, password, clientIp);
    expect(limitedOnB.statusCode).toBe(429);
    expect(limitedOnB.json<{ code: string }>().code).toBe('RATE_LIMITED');
    const limitedOnA = await signInOn(replicaA, sharedEmail, password, clientIp);
    expect(limitedOnA.statusCode).toBe(429);
  });

  it('locks an account across instances and clears it on success anywhere', async () => {
    // Three failures spread over BOTH instances and rotating addresses:
    // the shared account dimension slams shut on every replica.
    expect(
      (await signInOn(replicaA, sharedEmail, 'wrong-guess', '198.51.100.61'))
        .statusCode,
    ).toBe(401);
    expect(
      (await signInOn(replicaB, sharedEmail, 'wrong-guess', '198.51.100.62'))
        .statusCode,
    ).toBe(401);
    expect(
      (await signInOn(replicaA, sharedEmail, 'wrong-guess', '198.51.100.63'))
        .statusCode,
    ).toBe(401);
    const lockedOnB = await signInOn(replicaB, sharedEmail, password, '198.51.100.64');
    expect(lockedOnB.statusCode).toBe(429);
    const lockedOnA = await signInOn(replicaA, sharedEmail, password, '198.51.100.65');
    expect(lockedOnA.statusCode).toBe(429);
  });

  it('measures the per-attempt cost of the shared limiter', async () => {
    // The number the PR reports: sequential allow() round-trips through
    // the application pool, warm connection, local PostgreSQL. The
    // assertion bound is deliberately loose (CI machines vary); the
    // measurement itself is the deliverable.
    const pool = createDatabasePool({
      url: appUrl,
      max: 1,
      applicationName: 'auto-mb-throttle-cost',
    });
    try {
      const limiter = createPgRateLimiter(
        pool,
        'auth',
        { windowMs: 60_000, max: 1_000_000 },
        `cost-${runId}`,
      );
      // Warm-up establishes the connection outside the measurement.
      await limiter.allow('warm-up');
      const attempts = 100;
      const startedAt = performance.now();
      for (let index = 0; index < attempts; index += 1) {
        await limiter.allow('203.0.113.99');
      }
      const totalMs = performance.now() - startedAt;
      const perAttemptMs = totalMs / attempts;
      console.info(
        `[finding 38] shared limiter cost: ${perAttemptMs.toFixed(2)} ms/attempt over ${String(attempts)} sequential attempts`,
      );
      expect(perAttemptMs).toBeLessThan(100);
    } finally {
      await pool.end({ timeout: 5 });
    }
  });
});

describe('readiness components', () => {
  it('reports database and storage ok, unconfigured externals excluded', async () => {
    const app = await buildApp({
      databaseUrl: appUrl,
      objectStorageDir: storageDir,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/ready' });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{
        status: string;
        components: Record<string, string>;
      }>();
      expect(body.status).toBe('ready');
      expect(body.components.database).toBe('ok');
      expect(body.components.objectStorage).toBe('ok');
      expect(body.components.pdfRenderer).toBe('unconfigured');
      expect(body.components.malwareScanner).toBe('unconfigured');

      // The storage probe overwrites ONE reserved key: repeated polls
      // must not leave a growing trail of files (external re-audit — a
      // one-minute monitor probing for a year is half a million files).
      await app.inject({ method: 'GET', url: '/api/ready' });
      await app.inject({ method: 'GET', url: '/api/ready' });
      const probeDir = path.join(
        storageDir,
        '00000000-0000-4000-8000-000000000000',
        'readiness',
      );
      expect(await readdir(probeDir)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('degrades to 503 naming the dead component', async () => {
    const app = await buildApp({
      databaseUrl: appUrl,
      objectStorageDir: storageDir,
      // A port nothing listens on: the renderer probe must fail.
      gotenbergUrl: 'http://127.0.0.1:9',
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/ready' });
      expect(response.statusCode).toBe(503);
      const body = response.json<{
        status: string;
        reason?: string;
        components: Record<string, string>;
      }>();
      expect(body.status).toBe('not-ready');
      expect(body.reason).toContain('pdfRenderer');
      expect(body.components.database).toBe('ok');
    } finally {
      await app.close();
    }
  }, 15_000);

  it('does not wait for clamd to close after it replies PONG', async () => {
    const clamd = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('PONG\0');
        // Real clamd keeps the connection open. Readiness must settle from
        // the complete reply instead of waiting for a remote FIN forever.
      });
    });
    await new Promise<void>((resolve, reject) => {
      clamd.once('error', reject);
      clamd.listen(0, '127.0.0.1', resolve);
    });
    const address = clamd.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test clamd did not bind a TCP port');
    }
    const app = await buildApp({
      databaseUrl: appUrl,
      objectStorageDir: storageDir,
      clamav: { host: '127.0.0.1', port: address.port },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/ready' });
      expect(response.statusCode, response.body).toBe(
        process.env.DATABASE_URL === undefined ? 503 : 200,
      );
      expect(
        response.json<{ components: Record<string, string> }>().components,
      ).toMatchObject({ malwareScanner: 'ok' });
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => {
        clamd.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it(
    'aborts an in-flight clamd probe when its readiness deadline expires',
    { timeout: 10_000 },
    async () => {
      const clamd = net.createServer((socket) => {
        socket.once('data', () => {
          // Accept and remain silent: this models a wedged clamd socket.
        });
      });
      await new Promise<void>((resolve, reject) => {
        clamd.once('error', reject);
        clamd.listen(0, '127.0.0.1', resolve);
      });
      const address = clamd.address();
      if (address === null || typeof address === 'string') {
        throw new Error('test clamd did not bind a TCP port');
      }
      const app = await buildApp({
        databaseUrl: appUrl,
        objectStorageDir: storageDir,
        clamav: { host: '127.0.0.1', port: address.port },
      });
      try {
        const startedAt = Date.now();
        const response = await app.inject({ method: 'GET', url: '/api/ready' });
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(response.statusCode).toBe(503);
        expect(
          response.json<{ components: Record<string, string> }>().components,
        ).toMatchObject({ malwareScanner: 'failed' });
      } finally {
        await app.close();
        await new Promise<void>((resolve, reject) => {
          clamd.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      }
    },
  );
});
