import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * Ops-batch behaviours: rate limiting on authentication attempts and the
 * component-aware readiness probe.
 */

const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';

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
});
