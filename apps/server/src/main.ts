import { assertProductionSecret, buildApp, SERVER_LIMITS } from './app.js';
import { WhitebooksProvider, readWhitebooksConfig } from './gsp/whitebooks.js';
import { assertProductionMfaEnforcement } from './mfa-policy.js';
import { TRUST_ANCHOR_PATH_ENV, loadTrustAnchors } from './pdf-signature.js';

const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? '3000');

// If a close hook hangs (e.g. the database pool waiting on a wedged
// connection), the process must still exit so the orchestrator does not
// have to escalate to SIGKILL.
const SHUTDOWN_DEADLINE_MS = 10_000;

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error('API_PORT must be a valid TCP port');
}

const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const whitebooksConfig = readWhitebooksConfig(process.env);

/** A positive-integer environment override, or the built-in default. A
 * misconfigured limit refuses to boot rather than silently falling back:
 * `DATABASE_POOL_MAX=0` would otherwise start an instance that can serve
 * nothing. */
const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};
const limits = {
  poolMax: positiveIntEnv('DATABASE_POOL_MAX', SERVER_LIMITS.poolMax),
  requestTimeoutMs: positiveIntEnv(
    'REQUEST_TIMEOUT_MS',
    SERVER_LIMITS.requestTimeoutMs,
  ),
  keepAliveTimeoutMs: positiveIntEnv(
    'KEEP_ALIVE_TIMEOUT_MS',
    SERVER_LIMITS.keepAliveTimeoutMs,
  ),
};

const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? '0');
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
  throw new Error('TRUST_PROXY_HOPS must be a non-negative integer');
}

// Production config gates, beside the auth-secret gate below: a process
// that is not explicitly development or test refuses to boot with the
// finding-36 MFA refusals resolved off. mfa-policy.ts reads the same
// variable with the same `=== 'true'` rule, so the value asserted here is
// exactly the value the refusals will run with.
const mfaEnforceResolved = assertProductionMfaEnforcement(
  process.env.MFA_ENFORCE === 'true',
);

// Trust anchors for verifying digital signatures on inbound railway PDFs.
// Loaded at boot and FAIL-LOUD, on the same reasoning as the Poppler probe
// in loa-extract.ts: a configured-but-unreadable anchor directory would
// leave the server reporting every genuinely-signed Railway document as
// having an unchecked chain, and a reviewer who is told "not checked"
// about good documents stops reading the field. Unset is a legitimate
// posture (no trust decision is made and nothing can reach the green
// state); unset-by-accident is not something this can distinguish, so the
// value is documented in .env.example and docs/OPERATIONS.md.
const pdfTrustAnchors = await loadTrustAnchors(process.env[TRUST_ANCHOR_PATH_ENV]);

const app = await buildApp({
  pdfTrustAnchors,
  logger: true,
  limits,
  // Finding 36: MFA refusals for privilege holders deploy dark and are
  // switched on with MFA_ENFORCE=true. Passed only when the variable is
  // set so the mfa-policy default (also read from MFA_ENFORCE) stands.
  ...(process.env.MFA_ENFORCE !== undefined ? { mfaEnforce: mfaEnforceResolved } : {}),
  ...(trustProxyHops > 0 ? { trustProxyHops } : {}),
  ...(process.env.METRICS_TOKEN ? { metricsToken: process.env.METRICS_TOKEN } : {}),
  ...(process.env.BACKUP_MARKER_PATH
    ? { backupMarkerPath: process.env.BACKUP_MARKER_PATH }
    : {}),
  ...(process.env.DATABASE_URL
    ? {
        databaseUrl: process.env.DATABASE_URL,
        authSecret: assertProductionSecret(process.env.AUTH_SECRET),
        // Better Auth's static base URL takes priority over forwarded
        // headers when constructing callback/verification URLs, so it
        // must be the PUBLIC origin (the web origin fronting /api), never
        // the container bind address.
        baseUrl: process.env.WEB_ORIGIN ?? `http://${host}:${String(port)}`,
        trustedOrigins: [webOrigin],
        ...(whitebooksConfig === null
          ? {}
          : { statutoryProvider: new WhitebooksProvider(whitebooksConfig) }),
        ...(process.env.OBJECT_STORAGE_DIR
          ? { objectStorageDir: process.env.OBJECT_STORAGE_DIR }
          : {}),
        ...(process.env.GOTENBERG_URL
          ? { gotenbergUrl: process.env.GOTENBERG_URL }
          : {}),
        ...(process.env.CLAMAV_HOST
          ? {
              clamav: {
                host: process.env.CLAMAV_HOST,
                port: Number(process.env.CLAMAV_PORT ?? '3310'),
              },
            }
          : {}),
      }
    : {}),
});

const stop = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => {
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
  process.exit(0);
};

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

await app.listen({ host, port });
