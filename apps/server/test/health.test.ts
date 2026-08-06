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
  });
});
