import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const require = createRequire(import.meta.url);

let app: FastifyInstance | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  app = undefined;
});

describe('health API', () => {
  it('returns a stable health envelope', async () => {
    app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'auto-mb-server',
      version: '0.1.0',
    });
  });

  it('reports not ready when no database is configured', async () => {
    app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not-ready',
      reason: 'database-not-configured',
    });
  });

  // Bounded above the 2s readiness-probe timeout so a firewall-DROPped
  // (rather than refused) port still fails with the real assertion message.
  it(
    'reports 503, not 500, when the database is unreachable',
    { timeout: 15_000 },
    async () => {
      app = await buildApp({
        databaseUrl: 'postgres://127.0.0.1:9/auto_mb',
      });
      const response = await app.inject({ method: 'GET', url: '/api/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: 'not-ready',
        reason: 'database-unreachable',
      });
    },
  );
});

describe('error handling', () => {
  it('preserves client error status codes instead of masking them as 500', async () => {
    app = await buildApp();
    app.get('/test-client-error', () => {
      throw Object.assign(new Error('unsupported payload'), {
        statusCode: 415,
      });
    });
    const response = await app.inject({
      method: 'GET',
      url: '/test-client-error',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ message: 'unsupported payload' });
  });

  it('masks unexpected errors as a generic 500 without leaking details', async () => {
    app = await buildApp();
    app.get('/test-server-error', () => {
      throw new Error('secret internal detail');
    });
    const response = await app.inject({
      method: 'GET',
      url: '/test-server-error',
    });

    expect(response.statusCode).toBe(500);
    const body = response.json<{ code: string; message: string }>();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).not.toContain('secret internal detail');
  });
});

describe('documentation UI', () => {
  it('is served when NODE_ENV is development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/documentation/' });

    expect(response.statusCode).toBe(200);
  });

  it('fails closed when NODE_ENV is unset or production', async () => {
    for (const value of ['', 'production']) {
      vi.stubEnv('NODE_ENV', value);
      const closedApp = await buildApp();
      try {
        const response = await closedApp.inject({
          method: 'GET',
          url: '/documentation',
        });
        expect(response.statusCode, `NODE_ENV=${value}`).toBe(404);
      } finally {
        await closedApp.close();
      }
    }
  });

  it('loads the Swagger UI end to end', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/documentation/',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('swagger');
  });

  it('resolves the exact @fastify/static version the security override pins', () => {
    // GHSA-83w8-p2f5-377r: the override in pnpm-workspace.yaml cites this
    // test, so it must assert the resolved version, not just that the UI
    // renders (9.x renders the identical UI).
    const swaggerUiPackagePath = require.resolve('@fastify/swagger-ui/package.json');
    const swaggerUiRequire = createRequire(swaggerUiPackagePath);
    const staticPackage = swaggerUiRequire('@fastify/static/package.json') as {
      version: string;
    };
    expect(staticPackage.version).toBe('10.1.2');
  });

  it('is not registered when disabled', async () => {
    app = await buildApp({ enableDocsUi: false });
    const response = await app.inject({ method: 'GET', url: '/documentation' });

    expect(response.statusCode).toBe(404);
  });
});
