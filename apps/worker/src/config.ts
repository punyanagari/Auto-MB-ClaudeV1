import { hostname } from 'node:os';

/**
 * Everything the worker reads from its environment, resolved once at boot
 * so a misconfiguration is a refusal to start rather than a job that
 * fails at three in the morning.
 */
export interface WorkerConfig {
  readonly databaseUrl: string;
  /** Identifies this process in the queue's `claimed_by`. Operators read
   * it; nothing authorises on it. */
  readonly claimedBy: string;
  /** How long a claim is held before it lapses and the job returns to the
   * queue. Must comfortably exceed the slowest job. */
  readonly leaseSeconds: number;
  /** How long to wait before asking again when the queue was empty. */
  readonly idlePollMs: number;
  /** How rarely the scheduler tick may run (migration 0096). Not the poll
   * interval: an idle worker polls every second, and running two
   * cross-tenant sweeps that often would be a steady background load for
   * checks whose useful resolution is hours. */
  readonly tickIntervalMs: number;
  readonly objectStorageDir: string;
  readonly pdfTrustAnchorsPath: string | undefined;
}

export class WorkerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigurationError';
  }
}

function positiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new WorkerConfigurationError(`${name} must be a positive integer`);
  }
  return value;
}

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new WorkerConfigurationError('DATABASE_URL is required');
  }

  const objectStorageDir = env.OBJECT_STORAGE_DIR;
  if (objectStorageDir === undefined || objectStorageDir === '') {
    // The worker reads the bytes the request path stored. Pointing it at
    // the wrong directory would not fail loudly — every job would simply
    // report the document missing — so the variable is mandatory rather
    // than defaulted.
    throw new WorkerConfigurationError('OBJECT_STORAGE_DIR is required');
  }

  return {
    databaseUrl,
    claimedBy: `auto-mb-worker@${hostname()}:${process.pid}`,
    // Two minutes. The slowest job kind is LOA intake, whose pdftotext
    // call is itself capped at 30 seconds per view; the lease has to
    // survive both views plus signature verification plus the storage
    // read, with headroom, or a healthy worker's job is stolen from under
    // it and done twice.
    leaseSeconds: positiveInteger(
      'WORKER_LEASE_SECONDS',
      env.WORKER_LEASE_SECONDS,
      120,
    ),
    idlePollMs: positiveInteger('WORKER_IDLE_POLL_MS', env.WORKER_IDLE_POLL_MS, 1_000),
    // One minute. A daily or monthly statutory check does not care about
    // the difference between running at 09:00 and 09:01, and an expired
    // export artefact is already unreachable through the download route
    // before the sweep reaches it — so this interval governs how promptly
    // its BYTES are reclaimed, not how promptly it stops being served.
    tickIntervalMs: positiveInteger(
      'WORKER_TICK_INTERVAL_MS',
      env.WORKER_TICK_INTERVAL_MS,
      60_000,
    ),
    objectStorageDir,
    pdfTrustAnchorsPath: env.AUTO_MB_PDF_TRUST_ANCHORS,
  };
}
