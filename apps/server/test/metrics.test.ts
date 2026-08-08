import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMetricsRegistry } from '../src/metrics.js';
import { buildApp } from '../src/app.js';

describe('metrics registry', () => {
  it('renders Prometheus text format with bounded labels', () => {
    const registry = createMetricsRegistry();
    registry.observe('GET', '/healthz', 200, 0.02);
    registry.observe('GET', '/healthz', 200, 0.2);
    registry.observe('POST', '/api/loa-documents', 400, 1.5);
    const output = registry.render();
    expect(output).toContain(
      'http_requests_total{method="GET",route="/healthz",status="200"} 2',
    );
    expect(output).toContain(
      'http_requests_total{method="POST",route="/api/loa-documents",status="400"} 1',
    );
    expect(output).toContain('http_request_duration_seconds_bucket{le="+Inf"} 3');
    expect(output).toContain('http_request_duration_seconds_count 3');
  });
});

describe('metrics endpoint', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ metricsToken: 'metrics-test-token' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('requires the bearer token', async () => {
    const denied = await app.inject({ method: 'GET', url: '/metrics' });
    expect(denied.statusCode).toBe(401);
  });

  it('serves recorded request counts by route template', async () => {
    await app.inject({ method: 'GET', url: '/api/health' });
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-test-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain(
      'http_requests_total{method="GET",route="/api/health",status="200"}',
    );
  });
});
