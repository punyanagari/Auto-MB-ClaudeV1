import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createMetricsRegistry,
  recordAccountLockout,
  recordAuthFailure,
  recordRateLimitRejection,
  recordStatutoryProviderOutcome,
  recordTenantDenial,
  recordUploadScanFailure,
  resetOpsCountersForTests,
} from '../src/metrics.js';
import { buildApp } from '../src/app.js';

describe('metrics registry', () => {
  it('renders Prometheus text format with bounded labels', async () => {
    const registry = createMetricsRegistry();
    registry.observe('GET', '/healthz', 200, 0.02);
    registry.observe('GET', '/healthz', 200, 0.2);
    registry.observe('POST', '/api/loa-documents', 400, 1.5);
    const output = await registry.renderAll();
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

describe('operational counters (finding 37)', () => {
  beforeEach(() => {
    resetOpsCountersForTests();
  });

  it('declares every contracted signal, with HELP and TYPE, even at zero', async () => {
    const output = await createMetricsRegistry().renderAll();
    for (const name of [
      'auth_failures_total',
      'account_lockouts_total',
      'tenant_denials_total',
      'rate_limit_rejections_total',
      'statutory_provider_operations_total',
      'upload_scan_failures_total',
    ]) {
      expect(output, `${name} must be declared`).toContain(`# HELP ${name} `);
      expect(output).toContain(`# TYPE ${name} counter`);
    }
  });

  it('counts authentication failures by surface', async () => {
    recordAuthFailure('sign_in');
    recordAuthFailure('sign_in');
    recordAuthFailure('two_factor');
    const output = await createMetricsRegistry().renderAll();
    expect(output).toContain('auth_failures_total{surface="sign_in"} 2');
    expect(output).toContain('auth_failures_total{surface="two_factor"} 1');
  });

  it('counts lockouts, tenant denials, rate-limit rejections and scan failures', async () => {
    recordAccountLockout();
    recordTenantDenial('not_a_member');
    recordRateLimitRejection('auth');
    recordRateLimitRejection('account_lockout');
    recordUploadScanFailure('malware_detected');
    recordUploadScanFailure('scanner_unavailable');
    const output = await createMetricsRegistry().renderAll();
    expect(output).toContain('account_lockouts_total 1');
    expect(output).toContain('tenant_denials_total{reason="not_a_member"} 1');
    expect(output).toContain('rate_limit_rejections_total{scope="auth"} 1');
    expect(output).toContain('rate_limit_rejections_total{scope="account_lockout"} 1');
    expect(output).toContain('upload_scan_failures_total{reason="malware_detected"} 1');
    expect(output).toContain(
      'upload_scan_failures_total{reason="scanner_unavailable"} 1',
    );
  });

  it('counts statutory provider outcomes by operation and status', async () => {
    recordStatutoryProviderOutcome('register_irp', 'succeeded');
    recordStatutoryProviderOutcome('register_irp', 'failed');
    recordStatutoryProviderOutcome('cancel_crn', 'unknown');
    const output = await createMetricsRegistry().renderAll();
    expect(output).toContain(
      'statutory_provider_operations_total{operation="register_irp",status="succeeded"} 1',
    );
    expect(output).toContain(
      'statutory_provider_operations_total{operation="register_irp",status="failed"} 1',
    );
    expect(output).toContain(
      'statutory_provider_operations_total{operation="cancel_crn",status="unknown"} 1',
    );
  });

  it('collapses an unknown operation to a bounded label instead of minting one', async () => {
    recordStatutoryProviderOutcome('something_new', 'failed');
    const output = await createMetricsRegistry().renderAll();
    expect(output).toContain(
      'statutory_provider_operations_total{operation="other",status="failed"} 1',
    );
    expect(output).not.toContain('something_new');
  });
});

describe('database pool saturation gauge', () => {
  it('renders sampled connections by state against the configured budget', async () => {
    const registry = createMetricsRegistry({
      collectDatabasePool: () =>
        Promise.resolve({
          maxConnections: 10,
          connectionsByState: new Map([
            ['active', 2],
            ['idle', 3],
            ['idle in transaction', 1],
            ['fastpath function call', 1],
          ]),
        }),
    });
    const output = await registry.renderAll();
    expect(output).toContain('db_pool_connections{state="active"} 2');
    expect(output).toContain('db_pool_connections{state="idle"} 3');
    expect(output).toContain('db_pool_connections{state="idle_in_transaction"} 1');
    // Unrecognised pg_stat_activity states fold into one bounded label.
    expect(output).toContain('db_pool_connections{state="other"} 1');
    expect(output).toContain('db_pool_connections_max 10');
  });

  it('omits the series (never a fictional zero) when the sample fails', async () => {
    const registry = createMetricsRegistry({
      collectDatabasePool: () => Promise.reject(new Error('database down')),
    });
    const output = await registry.renderAll();
    expect(output).not.toContain('db_pool_connections');
    expect(output).toContain('http_requests_total');
  });

  it('omits the series when no collector is configured', async () => {
    expect(await createMetricsRegistry().renderAll()).not.toContain(
      'db_pool_connections',
    );
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
    const output = await registry.renderAll();
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
    expect(await registry.renderAll()).toContain(
      'backup_last_success_timestamp_seconds 1723100000',
    );
    await writeFile(markerPath, '1723186400\n');
    expect(await registry.renderAll()).toContain(
      'backup_last_success_timestamp_seconds 1723186400',
    );
  });

  it('omits the series entirely when no marker path is configured', async () => {
    const registry = createMetricsRegistry();
    expect(await registry.renderAll()).not.toContain(
      'backup_last_success_timestamp_seconds',
    );
  });

  it('omits the series when the marker file does not exist', async () => {
    const registry = createMetricsRegistry({
      backupMarkerPath: path.join(markerDir, 'missing'),
    });
    expect(await registry.renderAll()).not.toContain(
      'backup_last_success_timestamp_seconds',
    );
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
      const output = await registry.renderAll();
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
