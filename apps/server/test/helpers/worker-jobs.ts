import type { Sql } from '@auto-mb/db';
import type { ObjectStorage, TrustAnchorStore } from '@auto-mb/documents';
import { EMPTY_TRUST_ANCHOR_STORE } from '@auto-mb/documents';
import { createInstrumentExpiryReviewHandler } from '@auto-mb/worker/handlers/instrument-expiry-review';
import { createLoaDocumentIntakeHandler } from '@auto-mb/worker/handlers/loa-document-intake';
import { drainJobs, type JobHandlers, type JobLogger } from '@auto-mb/worker/runtime';

/**
 * Runs the queued jobs an HTTP request enqueued, so an integration test
 * can assert the state the product actually ends in.
 *
 * Since pack P18 an LOA upload answers before the letter has been read:
 * the route stores the bytes, writes the row as `pending` and enqueues
 * the reading. A test that asserts on the extraction therefore has two
 * halves to run, and this is the second one — the REAL worker handler,
 * not a stand-in, because a stand-in would let the two drift and the
 * tests would stop describing the product.
 *
 * It is synchronous by design: no background process, no polling, no
 * sleeping. The queue is drained at a point the test chooses, which is
 * what makes these assertions deterministic rather than timing-dependent.
 */
export async function runQueuedJobs(
  database: Sql,
  storage: ObjectStorage,
  trustAnchors: TrustAnchorStore = EMPTY_TRUST_ANCHOR_STORE,
): Promise<number> {
  const log: JobLogger = { info: () => {}, error: () => {} };
  const handlers: JobHandlers = {
    loa_document_intake: createLoaDocumentIntakeHandler({ storage, trustAnchors }),
    instrument_expiry_review: createInstrumentExpiryReviewHandler(),
  };
  return drainJobs(database, { handlers, log });
}
