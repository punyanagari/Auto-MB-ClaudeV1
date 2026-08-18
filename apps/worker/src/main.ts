import {
  createDatabasePool,
  enqueueDueStatutoryJobs,
  expireLapsedOrganisationExports,
} from '@auto-mb/db';
import {
  EMPTY_TRUST_ANCHOR_STORE,
  assertPopplerPdfToText,
  createFileSystemStorage,
  loadTrustAnchors,
} from '@auto-mb/documents';
import { readWorkerConfig } from './config.js';
import { createInstrumentExpiryReviewHandler } from './handlers/instrument-expiry-review.js';
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

// Poppler, at boot rather than at the first job.
//
// `config.ts` refuses to start on a missing DATABASE_URL or
// OBJECT_STORAGE_DIR, and pdftotext belongs in the same category: it is a
// system dependency of the only job kind this worker runs, and an image
// or a host missing it produces a worker that starts cleanly, claims
// every job, and fails every one. The probe is a `-v` banner read, so it
// also catches the subtler fault the extractor already guards against at
// run time — Xpdf's same-named binary, whose -layout output the LOA
// corpus is not calibrated against.
//
// Deliberately fatal. A worker that cannot do its work should not be
// holding claims and burning attempts on them.
try {
  await assertPopplerPdfToText();
} catch (error) {
  log.error({
    message: 'refusing to start: pdftotext is not usable',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

const sql = createDatabasePool({
  url: config.databaseUrl,
  // One connection per worker process. The loop runs one job at a time,
  // and a job opens at most one transaction at a time; concurrency comes
  // from running more worker containers, which the SKIP LOCKED claim was
  // chosen to make safe. A larger pool here would only buy idle sockets.
  max: 2,
  applicationName: 'auto-mb-worker',
});

const storage = createFileSystemStorage(config.objectStorageDir);

const handlers: JobHandlers = {
  loa_document_intake: createLoaDocumentIntakeHandler({ storage, trustAnchors }),
  instrument_expiry_review: createInstrumentExpiryReviewHandler(),
};

/**
 * The periodic work that is not a job (migration 0096).
 *
 * Both halves are cross-tenant definer calls that take no organisation, so
 * neither can be pointed at a tenant; both are the same
 * `auto_mb_app` role everything else here runs as.
 *
 * The expiry sweep marks the row first and deletes the bytes afterwards,
 * which is why the delete is best-effort: the failure this order produces
 * is an orphan file whose key is on no row, and the failure the other
 * order produces is a download button that fails for a reason nobody can
 * see. A file that survives one sweep is not retried — nothing points at
 * it — so it is reported rather than silently swallowed.
 */
async function tick(): Promise<void> {
  const enqueued = await enqueueDueStatutoryJobs(sql, 50);
  if (enqueued > 0) log.info({ message: 'scheduled checks enqueued', enqueued });

  const lapsed = await expireLapsedOrganisationExports(sql, 50);
  for (const key of lapsed) {
    try {
      await storage.remove(key);
    } catch (error) {
      log.error({
        message: 'an expired export artefact could not be deleted; it is orphaned',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (lapsed.length > 0) {
    log.info({ message: 'export artefacts expired', expired: lapsed.length });
  }
}

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
    tick,
    tickIntervalMs: config.tickIntervalMs,
  });
} finally {
  // A job in flight keeps its claim until the lease expires; another
  // worker picks it up then. That is the deliberate trade — draining
  // cleanly would mean holding SIGTERM open for the length of the slowest
  // job, and the lease already makes an abrupt exit recoverable.
  await sql.end({ timeout: 5 });
  log.info({ message: 'stopped' });
}
