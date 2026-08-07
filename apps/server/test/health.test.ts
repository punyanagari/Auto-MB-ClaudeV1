import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
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

  it('reports 503, not 500, when the database is unreachable', async () => {
    app = await buildApp({
      databaseUrl: 'postgres://nobody:nope@127.0.0.1:9/auto_mb',
    });
    const response = await app.inject({ method: 'GET', url: '/api/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not-ready',
      reason: 'database-unreachable',
    });
  });
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
  it('is served by default outside production', async () => {
    app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/documentation' });

    expect([200, 302]).toContain(response.statusCode);
  });

  it('is not registered when disabled', async () => {
    app = await buildApp({ enableDocsUi: false });
    const response = await app.inject({ method: 'GET', url: '/documentation' });

    expect(response.statusCode).toBe(404);
  });
});
