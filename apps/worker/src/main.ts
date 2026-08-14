import { createDatabasePool } from '@auto-mb/db';
import { EMPTY_TRUST_ANCHOR_STORE, createFileSystemStorage } from '@auto-mb/documents';
import { loadTrustAnchors } from '@auto-mb/documents';
import { readWorkerConfig } from './config.js';
import { createLoaDocumentIntakeHandler } from './handlers/loa-document-intake.js';
import { runWorkerLoop, type JobHandlers, type JobLogger } from './runtime.js';

/**
 * The worker process.
 *
 * ADR-0008 kept `apps/worker` as an empty boundary declaration and set a
 * tripwire: the first pull request to land a real asynchronous workflow
 * must also give the worker a deployment, because nothing would run it.
 * Pack P18 is that pull request — the queue is migration 0072, the
 * execution model is ADR-0011, and the deployment is the `worker` service
 * in `deploy/docker-compose.prod.yml`.
 *
 * It connects as `auto_mb_app`, exactly like the API, and holds no
 * privilege a request handler does not. Every job runs inside
 * `withTenant` with the `(organisation, user)` its enqueuing transaction
 * recorded, so the membership is re-proved in the database at execution
 * time and RLS applies unchanged.
 */

const log: JobLogger = {
  info(fields) {
    console.info(
      JSON.stringify({ level: 'info', service: 'auto-mb-worker', ...fields }),
    );
  },
  error(fields) {
    console.error(
      JSON.stringify({ level: 'error', service: 'auto-mb-worker', ...fields }),
    );
  },
};

const config = readWorkerConfig();

// Trust anchors are loaded at boot and the failure is loud, mirroring
// `apps/server/src/main.ts`: a configured-but-unreadable path must refuse
// to start rather than quietly degrade every railway document to "issuer
// not checked". An unset path is the documented development default.
const trustAnchors =
  config.pdfTrustAnchorsPath === undefined || config.pdfTrustAnchorsPath === ''
    ? EMPTY_TRUST_ANCHOR_STORE
    : await loadTrustAnchors(config.pdfTrustAnchorsPath);

const sql = createDatabasePool({
  url: config.databaseUrl,
  // One connection per worker process. The loop runs one job at a time,
  // and a job opens at most one transaction at a time; concurrency comes
  // from running more worker containers, which the SKIP LOCKED claim was
  // chosen to make safe. A larger pool here would only buy idle sockets.
  max: 2,
  applicationName: 'auto-mb-worker',
});

const handlers: JobHandlers = {
  loa_document_intake: createLoaDocumentIntakeHandler({
    storage: createFileSystemStorage(config.objectStorageDir),
    trustAnchors,
  }),
};

const controller = new AbortController();

function stop(signal: string): void {
  log.info({ signal, message: 'stopping' });
  controller.abort();
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

log.info({
  message: 'worker started',
  claimedBy: config.claimedBy,
  leaseSeconds: config.leaseSeconds,
  kinds: Object.keys(handlers),
});

try {
  await runWorkerLoop(sql, {
    claimedBy: config.claimedBy,
    leaseSeconds: config.leaseSeconds,
    idlePollMs: config.idlePollMs,
    signal: controller.signal,
    handlers,
    log,
  });
} finally {
  // A job in flight keeps its claim until the lease expires; another
  // worker picks it up then. That is the deliberate trade — draining
  // cleanly would mean holding SIGTERM open for the length of the slowest
  // job, and the lease already makes an abrupt exit recoverable.
  await sql.end({ timeout: 5 });
  log.info({ message: 'stopped' });
}
