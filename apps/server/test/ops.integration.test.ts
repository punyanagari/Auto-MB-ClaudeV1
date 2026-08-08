import { mkdtemp, rm } from 'node:fs/promises';
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
