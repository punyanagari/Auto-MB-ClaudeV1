import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { API_VERSION } from '../src/api-version.js';

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
      version: API_VERSION,
    });
  });

  /*
   * The probe and the OpenAPI document must publish ONE version.
   *
   * `/api/health` carried the scaffold's literal '0.1.0' while the
   * document read the package version; by the time the reconciled review
   * measured it the two disagreed by three minor versions (0.1.0 vs
   * 0.11.0), and the field an uptime monitor reads was the wrong one.
   * Asserting against the package version rather than a literal is what
   * makes a future bump a one-file edit again.
   */
  it('publishes the same version through /api/health and the OpenAPI document', async () => {
    app = await buildApp();
    const packageVersion = (require('../package.json') as { version: string }).version;

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const document = app.swagger() as unknown as { info: { version: string } };

    expect(health.json<{ version: string }>().version).toBe(packageVersion);
    expect(document.info.version).toBe(packageVersion);
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

  it('turns nested database connection failures into a safe retryable 503', async () => {
    app = await buildApp();
    app.get('/test-database-error', () => {
      const connectionError = Object.assign(
        new Error('connect ECONNREFUSED postgres://secret@127.0.0.1:55432'),
        { code: 'ECONNREFUSED' },
      );
      throw new AggregateError([connectionError], 'database connection failed');
    });
    const response = await app.inject({
      method: 'GET',
      url: '/test-database-error',
    });

    expect(response.statusCode).toBe(503);
    const body = response.json<{ code: string; message: string; requestId: string }>();
    expect(body).toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database is temporarily unavailable. Nothing was saved. Try again.',
    });
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('127.0.0.1');
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
