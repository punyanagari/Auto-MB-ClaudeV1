/**
 * Hand-rolled Prometheus text-format metrics (docs/DEPENDENCIES.md:
 * OpenTelemetry waits for a telemetry backend; a counter map and one
 * histogram do not justify an SDK). Request counts are labelled by
 * method/route/status — routes, not raw URLs, so tenant ids and document
 * ids never become label values. Durations feed a single global histogram
 * to keep cardinality bounded.
 */

import { readFileSync } from 'node:fs';

const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// ---------------------------------------------------------------------------
// Operational counters (audit finding 37: the observability contract at
// docs/OPERATIONS.md §6). Incremented at the choke points where the events
// actually happen — the app-level error handler, the rate-limit refusal
// paths, the statutory provider-operation ledger, and the upload malware
// gate — so no route has to remember to count anything. The state is
// module-level because those choke points (e.g. the ledger helpers, which
// see only a transaction handle) have no path to a per-app registry;
// counters are cumulative per process, which is exactly Prometheus counter
// semantics. Label values are drawn from closed unions below — never from
// request data — so cardinality stays bounded by construction.

export type AuthFailureSurface = 'sign_in' | 'sign_up' | 'two_factor';
type TenantDenialReason = 'not_a_member';
type RateLimitScope =
  'auth' | 'upload' | 'account_lockout' | 'signing' | 'notification_webhook';
type UploadScanFailureReason = 'malware_detected' | 'scanner_unavailable';
type StatutoryOutcomeStatus = 'succeeded' | 'failed' | 'unknown';

const STATUTORY_OPERATIONS = new Set([
  'register_irp',
  'reconcile_irp',
  'cancel_irp',
  'generate_eway_bill',
  'reconcile_eway_bill',
  'cancel_eway_bill',
  'register_crn',
  'reconcile_crn',
  'cancel_crn',
]);

interface OpsCounter {
  readonly help: string;
  /** label string (e.g. `surface="sign_in"`, or '' for none) → count */
  readonly series: Map<string, number>;
}

const opsCounters = {
  auth_failures_total: {
    help: 'Failed authentication attempts, by surface (sign_in, sign_up, two_factor).',
    series: new Map<string, number>(),
  },
  account_lockouts_total: {
    help: 'Account-scoped login lockouts engaged (counted once per episode, not per rejected attempt).',
    series: new Map<string, number>(),
  },
  tenant_denials_total: {
    help: 'Tenant-boundary denials: requests refused because the user holds no active membership in the addressed organisation.',
    series: new Map<string, number>(),
  },
  rate_limit_rejections_total: {
    help: 'Requests rejected 429 by the login/upload rate limits or the account lockout, by scope.',
    series: new Map<string, number>(),
  },
  statutory_provider_operations_total: {
    help: 'Statutory-provider (GSP) ledger operations completed, by operation and terminal status.',
    series: new Map<string, number>(),
  },
  upload_scan_failures_total: {
    help: 'Uploads refused by the malware gate, by reason (malware_detected, scanner_unavailable).',
    series: new Map<string, number>(),
  },
} satisfies Record<string, OpsCounter>;

function bump(counter: OpsCounter, labels: string): void {
  counter.series.set(labels, (counter.series.get(labels) ?? 0) + 1);
}

export function recordAuthFailure(surface: AuthFailureSurface): void {
  bump(opsCounters.auth_failures_total, `surface="${surface}"`);
}

export function recordAccountLockout(): void {
  bump(opsCounters.account_lockouts_total, '');
}

export function recordTenantDenial(reason: TenantDenialReason): void {
  bump(opsCounters.tenant_denials_total, `reason="${reason}"`);
}

export function recordRateLimitRejection(scope: RateLimitScope): void {
  bump(opsCounters.rate_limit_rejections_total, `scope="${scope}"`);
}

/** The operation label is validated against the closed ledger set; an
 * unrecognised operation collapses to `other` rather than minting a new
 * label value. */
export function recordStatutoryProviderOutcome(
  operation: string,
  status: StatutoryOutcomeStatus,
): void {
  const boundedOperation = STATUTORY_OPERATIONS.has(operation) ? operation : 'other';
  bump(
    opsCounters.statutory_provider_operations_total,
    `operation="${boundedOperation}",status="${status}"`,
  );
}

export function recordUploadScanFailure(reason: UploadScanFailureReason): void {
  bump(opsCounters.upload_scan_failures_total, `reason="${reason}"`);
}

/** Counters are process-cumulative by design; tests that assert exact
 * values reset them first. Never called by production code. */
export function resetOpsCountersForTests(): void {
  for (const counter of Object.values(opsCounters)) counter.series.clear();
}

function renderOpsCounters(lines: string[]): void {
  for (const [name, counter] of Object.entries(opsCounters)) {
    lines.push(`# HELP ${name} ${counter.help}`, `# TYPE ${name} counter`);
    for (const [labels, count] of [...counter.series.entries()].sort()) {
      lines.push(
        labels === ''
          ? `${name} ${String(count)}`
          : `${name}{${labels}} ${String(count)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

/** One sample of the server's PostgreSQL connection usage, collected at
 * scrape time (see app.ts): connections the server's database role holds,
 * grouped by pg_stat_activity state, against the configured pool budget. */
export interface DatabasePoolSample {
  /** Sum of the configured `max` of every pool the server opens. */
  readonly maxConnections: number;
  readonly connectionsByState: ReadonlyMap<string, number>;
}

const POOL_STATES = new Map<string, string>([
  ['active', 'active'],
  ['idle', 'idle'],
  ['idle in transaction', 'idle_in_transaction'],
  ['idle in transaction (aborted)', 'idle_in_transaction_aborted'],
]);

function renderDatabasePool(lines: string[], sample: DatabasePoolSample): void {
  lines.push(
    '# HELP db_pool_connections Server database connections by pg_stat_activity state, sampled at scrape time.',
    '# TYPE db_pool_connections gauge',
  );
  const byLabel = new Map<string, number>();
  for (const [state, count] of sample.connectionsByState) {
    const label = POOL_STATES.get(state) ?? 'other';
    byLabel.set(label, (byLabel.get(label) ?? 0) + count);
  }
  for (const [label, count] of [...byLabel.entries()].sort()) {
    lines.push(`db_pool_connections{state="${label}"} ${String(count)}`);
  }
  lines.push(
    '# HELP db_pool_connections_max Configured connection budget across the server pools; db_pool_connections / db_pool_connections_max is the saturation ratio.',
    '# TYPE db_pool_connections_max gauge',
    `db_pool_connections_max ${String(sample.maxConnections)}`,
  );
}

interface MetricsRegistryOptions {
  /** Path to the last-success marker written by scripts/backup.sh (epoch
   * seconds). When set and readable it is surfaced as the
   * backup_last_success_timestamp_seconds gauge; unset, missing, or
   * unparseable omits the series entirely — a fake 0 would read as "backup
   * epochs overdue" and drown the real signal. */
  readonly backupMarkerPath?: string;
  /** Collects a database-pool usage sample at scrape time. Resolving null
   * (database unreachable, no database configured) omits the series —
   * consistent with the backup gauge, absence is honest and a fake 0 would
   * lie. */
  readonly collectDatabasePool?: () => Promise<DatabasePoolSample | null>;
}

interface MetricsRegistry {
  observe(method: string, route: string, statusCode: number, seconds: number): void;
  /** The one render: runs the async collectors (absent or failing ones
   * simply omit their series), then renders everything. */
  renderAll(): Promise<string>;
}

/** Reads the marker fresh per render (a scrape every 15–60 s against a
 * one-line file) so the gauge never serves a stale cached value. Returns
 * null unless the file yields a positive integer epoch. */
function readBackupMarker(markerPath: string): number | null {
  let content: string;
  try {
    content = readFileSync(markerPath, 'utf8');
  } catch {
    return null;
  }
  const trimmed = content.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const epoch = Number(trimmed);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

export function createMetricsRegistry(
  options: MetricsRegistryOptions = {},
): MetricsRegistry {
  const requests = new Map<string, number>();
  const bucketCounts = new Array<number>(DURATION_BUCKETS.length).fill(0);
  let durationSum = 0;
  let durationCount = 0;

  function renderBody(poolSample: DatabasePoolSample | null): string {
    const lines = [
      '# HELP http_requests_total HTTP requests served, by method, route, and status.',
      '# TYPE http_requests_total counter',
    ];
    for (const [labels, count] of [...requests.entries()].sort()) {
      lines.push(`http_requests_total{${labels}} ${String(count)}`);
    }
    lines.push(
      '# HELP http_request_duration_seconds HTTP request duration.',
      '# TYPE http_request_duration_seconds histogram',
    );
    for (const [index, bound] of DURATION_BUCKETS.entries()) {
      lines.push(
        `http_request_duration_seconds_bucket{le="${String(bound)}"} ${String(bucketCounts[index] ?? 0)}`,
      );
    }
    lines.push(
      `http_request_duration_seconds_bucket{le="+Inf"} ${String(durationCount)}`,
      `http_request_duration_seconds_sum ${String(durationSum)}`,
      `http_request_duration_seconds_count ${String(durationCount)}`,
    );
    renderOpsCounters(lines);
    if (poolSample !== null) renderDatabasePool(lines, poolSample);
    const backupEpoch =
      options.backupMarkerPath !== undefined
        ? readBackupMarker(options.backupMarkerPath)
        : null;
    if (backupEpoch !== null) {
      lines.push(
        '# HELP backup_last_success_timestamp_seconds Unix time of the last backup whose dump, object archive, and manifest verification all succeeded (scripts/backup.sh).',
        '# TYPE backup_last_success_timestamp_seconds gauge',
        `backup_last_success_timestamp_seconds ${String(backupEpoch)}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  return {
    observe(method, route, statusCode, seconds) {
      const key = `method="${method}",route="${route}",status="${String(statusCode)}"`;
      requests.set(key, (requests.get(key) ?? 0) + 1);
      durationSum += seconds;
      durationCount += 1;
      for (const [index, bound] of DURATION_BUCKETS.entries()) {
        if (seconds <= bound) bucketCounts[index] = (bucketCounts[index] ?? 0) + 1;
      }
    },
    async renderAll() {
      let poolSample: DatabasePoolSample | null = null;
      if (options.collectDatabasePool !== undefined) {
        try {
          poolSample = await options.collectDatabasePool();
        } catch {
          poolSample = null;
        }
      }
      return renderBody(poolSample);
    },
  };
}
