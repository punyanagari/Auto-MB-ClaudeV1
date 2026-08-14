/**
 * Document handling that is not the HTTP layer's business: the object
 * store boundary, Poppler text extraction, and digital-signature
 * verification with its verdict shape.
 *
 * These four modules lived in `apps/server/src` until pack P18, correctly:
 * AGENTS.md says shared infrastructure stays inside the module that needs
 * it until a real second consumer exists, and until the worker ran a real
 * job there was exactly one consumer. `apps/worker` is now that second
 * consumer — the LOA intake job reads stored bytes, extracts their text
 * and verifies their signatures, which is the same work the upload route
 * used to do inline — so the bar the rule sets has been met rather than
 * anticipated.
 *
 * The alternative was for the worker to carry its own copy of the storage
 * path guard and the verifier. Two copies of a subtle security rule drift
 * apart, which this repository has already recorded as a lesson rather
 * than a worry, so there is one copy and both consumers import it.
 */
export * from './storage.js';
export * from './loa-extract.js';
export * from './pdf-signature.js';
export * from './document-signature-evidence.js';
export * from './pdf-signature/trust-anchors.js';
