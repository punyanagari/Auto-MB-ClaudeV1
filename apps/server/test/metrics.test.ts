import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

describe('backup last-success gauge', () => {
  let markerDir: string;

  beforeAll(async () => {
    markerDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-metrics-'));
  });

  afterAll(async () => {
    await rm(markerDir, { recursive: true, force: true });
  });

  it('exposes the marker epoch with HELP/TYPE lines when the file is readable', async () => {
    const markerPath = path.join(markerDir, 'last-success');
    await writeFile(markerPath, '1723100000\n');
    const registry = createMetricsRegistry({ backupMarkerPath: markerPath });
    const output = registry.render();
    expect(output).toContain(
      '# HELP backup_last_success_timestamp_seconds Unix time of the last backup',
    );
    expect(output).toContain('# TYPE backup_last_success_timestamp_seconds gauge');
    expect(output).toContain('backup_last_success_timestamp_seconds 1723100000');
  });

  it('reads the marker fresh on every render', async () => {
    const markerPath = path.join(markerDir, 'refreshed');
    await writeFile(markerPath, '1723100000\n');
    const registry = createMetricsRegistry({ backupMarkerPath: markerPath });
    expect(registry.render()).toContain(
      'backup_last_success_timestamp_seconds 1723100000',
    );
    await writeFile(markerPath, '1723186400\n');
    expect(registry.render()).toContain(
      'backup_last_success_timestamp_seconds 1723186400',
    );
  });

  it('omits the series entirely when no marker path is configured', () => {
    const registry = createMetricsRegistry();
    expect(registry.render()).not.toContain('backup_last_success_timestamp_seconds');
  });

  it('omits the series when the marker file does not exist', () => {
    const registry = createMetricsRegistry({
      backupMarkerPath: path.join(markerDir, 'missing'),
    });
    expect(registry.render()).not.toContain('backup_last_success_timestamp_seconds');
  });

  it('omits the series (never 0) when the marker content is not a positive epoch', async () => {
    for (const [name, content] of [
      ['garbage', 'not-a-number\n'],
      ['zero', '0\n'],
      ['negative', '-5\n'],
      ['empty', ''],
    ] as const) {
      const markerPath = path.join(markerDir, name);
      await writeFile(markerPath, content);
      const registry = createMetricsRegistry({ backupMarkerPath: markerPath });
      const output = registry.render();
      expect(output, `${name} marker must omit the series`).not.toContain(
        'backup_last_success_timestamp_seconds',
      );
    }
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
    expect(response.body).not.toContain('backup_last_success_timestamp_seconds');
  });

  it('serves the backup gauge when a readable marker path is configured', async () => {
    const markerDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-metrics-app-'));
    const markerPath = path.join(markerDir, 'last-success');
    await writeFile(markerPath, '1723100000\n');
    const markerApp = await buildApp({
      metricsToken: 'metrics-test-token',
      backupMarkerPath: markerPath,
    });
    try {
      const response = await markerApp.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer metrics-test-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        'backup_last_success_timestamp_seconds 1723100000',
      );
    } finally {
      await markerApp.close();
      await rm(markerDir, { recursive: true, force: true });
    }
  });
});
