import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { createDatabasePool } from '@auto-mb/db';
import { assertProductionSecret, createAuth, type Auth } from './auth.js';
import { toWebHeaders, toWebRequest } from './http.js';
import {
  identityActionForPath,
  recordIdentityEvent,
  recordLoginLockout,
} from './identity-audit.js';
import { createClamdScanner, noScanner } from './malware-scan.js';
import { createMetricsRegistry } from './metrics.js';
import {
  accountLockoutKey,
  createAccountLockout,
  createRateLimiter,
  type AccountLockoutRule,
  type RateLimitRule,
} from './rate-limit.js';
import { registerAmendmentRoutes } from './routes/amendments.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerExportRoutes } from './routes/export.js';
import { registerExtensionRoutes } from './routes/extensions.js';
import { registerOrganisationRoutes } from './routes/organisation.js';
import { registerChallanRoutes } from './routes/challans.js';
import { registerIssueChallanRoutes } from './routes/issue-challans.js';
import { registerCorrectionRoutes } from './routes/corrections.js';
import { registerContractSourceRoutes } from './routes/contract-sources.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerLoaRoutes } from './routes/loa.js';
import { registerMasterRoutes } from './routes/masters.js';
import { registerRetentionRoutes } from './routes/retention.js';
import { registerTimelineRoutes } from './routes/timeline.js';
import { registerSerialRoutes } from './routes/serials.js';
import { registerInstallationRoutes } from './routes/installations.js';
import { registerPaymentRoutes } from './routes/payment.js';
import { registerPacRoutes } from './routes/pac.js';
import { registerPurchaseOrderRoutes } from './routes/purchase-orders.js';
import { registerMeasurementBookRoutes } from './routes/measurement-books.js';
import { registerTaxInvoiceRoutes } from './routes/tax-invoices.js';
import { registerEwayBillRoutes } from './routes/eway-bills.js';
import { registerQuotationRoutes } from './routes/quotations.js';
import { registerWorkCompletionRoutes } from './routes/work-completion.js';
import { createFileSystemStorage } from './storage.js';

export interface BuildAppOptions {
  readonly logger?: boolean;
  readonly databaseUrl?: string;
  readonly enableDocsUi?: boolean;
  /** Enables authentication and the identity routes; requires databaseUrl. */
  readonly authSecret?: string;
  readonly baseUrl?: string;
  readonly trustedOrigins?: readonly string[];
  /** Root directory for uploaded objects (LOA PDFs). Defaults to
   * ./local-data/objects (gitignored); tests point it at a disposable
   * directory. */
  readonly objectStorageDir?: string;
  /** Gotenberg base URL for Delivery Challan PDF rendering. Defaults to
   * the compose-provided local service. */
  readonly gotenbergUrl?: string;
  /** clamd endpoint for upload malware scanning. Unset disables scanning
   * (development posture — docs/SECURITY.md); production sets it. */
  readonly clamav?: { readonly host: string; readonly port: number };
  /** Enables GET /metrics (Prometheus text format) behind this bearer
   * token. Unset disables the endpoint entirely. */
  readonly metricsToken?: string;
  /** Path to the backup last-success marker written by scripts/backup.sh
   * (wired from BACKUP_MARKER_PATH). When readable it is exposed as the
   * backup_last_success_timestamp_seconds gauge on /metrics; unset or
   * unreadable omits the series. */
  readonly backupMarkerPath?: string;
  /** Overrides for the built-in login/upload rate limits and the
   * account-scoped login lockout (tests use tight windows; production
   * keeps the defaults). */
  readonly rateLimits?: {
    readonly auth?: RateLimitRule;
    readonly upload?: RateLimitRule;
    readonly accountLockout?: AccountLockoutRule;
  };
  /** Number of reverse-proxy hops to trust for client addressing. In the
   * production topology the server sits exactly one hop behind Caddy,
   * which replaces any client-supplied X-Forwarded-For with the real
   * peer address, so 1 is the correct (and narrow) setting there. Unset
   * trusts no proxy: request.ip is the socket peer, and forwarded
   * headers are ignored — the safe default when exposed directly. */
  readonly trustProxyHops?: number;
}

/** Better Auth's sign-up/sign-in responses carry the user object; the
 * audit trail needs only its id. Anything unparseable yields null. */
function userIdFromAuthBody(text: string): string | null {
  try {
    const body = JSON.parse(text) as { user?: { id?: unknown } };
    return typeof body.user?.id === 'string' ? body.user.id : null;
  } catch {
    return null;
  }
}

const DATABASE_UNAVAILABLE_CODES = new Set([
  'CONNECT_TIMEOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

/** postgres.js and node-postgres may expose a connection failure directly,
 * through `cause`, or inside an AggregateError. Recognise only stable network
 * and PostgreSQL availability codes; messages may contain credentials and
 * must never be used for classification or returned to the client. */
function isDatabaseUnavailableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      if (
        current.code.startsWith('08') ||
        DATABASE_UNAVAILABLE_CODES.has(current.code)
      ) {
        return true;
      }
    }
    if ('cause' in current) pending.push(current.cause);
    if ('errors' in current && Array.isArray(current.errors)) {
      for (const nestedError of current.errors as unknown[]) {
        pending.push(nestedError);
      }
    }
  }
  return false;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: 'x-request-id',
    genReqId: (request) =>
      request.headers['x-request-id']?.toString() ?? crypto.randomUUID(),
    disableRequestLogging: false,
    // Without this, every request behind Caddy shares the proxy's own
    // address and the per-client rate limits collapse into one global
    // bucket (external re-audit).
    ...(options.trustProxyHops !== undefined
      ? { trustProxy: options.trustProxyHops }
      : {}),
  });

  const database = options.databaseUrl
    ? createDatabasePool({
        url: options.databaseUrl,
        max: 5,
        applicationName: 'auto-mb-server',
      })
    : undefined;

  let auth: Auth | undefined;
  let authPool: pg.Pool | undefined;

  try {
    if (database) {
      app.addHook('onClose', async () => {
        await database.end();
      });
    }

    if (options.authSecret !== undefined && options.databaseUrl !== undefined) {
      // Better Auth manages its own tables through node-postgres; the pool
      // is separate from the app's postgres.js pool and closed with it.
      authPool = new pg.Pool({ connectionString: options.databaseUrl, max: 5 });
      const pool = authPool;
      app.addHook('onClose', async () => {
        await pool.end();
      });
      auth = createAuth({
        pool,
        secret: options.authSecret,
        baseUrl: options.baseUrl ?? 'http://127.0.0.1:3000',
        ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
      });
    }

    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Auto-MB API',
          version: '0.1.0',
          description: 'Post-award works-contract execution API.',
        },
      },
    });
    // Fail closed: the docs UI is served only when the environment is
    // explicitly non-production. An unset NODE_ENV (e.g. a bare
    // `pnpm start`) must not publish it.
    const enableDocsUi =
      options.enableDocsUi ??
      ['development', 'test'].includes(process.env.NODE_ENV ?? '');
    if (enableDocsUi) {
      await app.register(swaggerUi, { routePrefix: '/documentation' });
    }
  } catch (error) {
    // The caller never receives the instance, so onClose will not run.
    await database?.end();
    await authPool?.end();
    await app.close();
    throw error;
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, 'request failed');
    const declaredStatusCode =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode <= 599
        ? error.statusCode
        : null;
    const databaseUnavailable =
      (declaredStatusCode === null || declaredStatusCode >= 500) &&
      isDatabaseUnavailableError(error);
    const statusCode = databaseUnavailable ? 503 : (declaredStatusCode ?? 500);
    void reply.status(statusCode).send(
      databaseUnavailable
        ? {
            code: 'DATABASE_UNAVAILABLE',
            message:
              'The database is temporarily unavailable. Nothing was saved. Try again.',
            requestId: request.id,
          }
        : statusCode >= 500
          ? {
              code: 'INTERNAL_ERROR',
              message: 'The request could not be completed.',
              requestId: request.id,
            }
          : {
              code:
                error instanceof Error &&
                'code' in error &&
                typeof error.code === 'string'
                  ? error.code
                  : 'REQUEST_ERROR',
              message: error instanceof Error ? error.message : 'Request failed.',
              requestId: request.id,
              // Structured conflict payloads (e.g. the one-draft 409s'
              // { existingRecordId }) ride along verbatim.
              ...(error instanceof Error &&
              'details' in error &&
              error.details !== undefined
                ? { details: error.details }
                : {}),
            },
    );
  });

  if (options.metricsToken !== undefined) {
    const registry = createMetricsRegistry(
      options.backupMarkerPath !== undefined
        ? { backupMarkerPath: options.backupMarkerPath }
        : {},
    );
    const token = options.metricsToken;
    app.addHook('onResponse', (request, reply, done) => {
      registry.observe(
        request.method,
        request.routeOptions.url ?? 'unmatched',
        reply.statusCode,
        reply.elapsedTime / 1000,
      );
      done();
    });
    app.get('/metrics', (request, reply) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        void reply.status(401);
        return { code: 'UNAUTHENTICATED', message: 'Metrics require the token.' };
      }
      void reply.type('text/plain; version=0.0.4');
      return reply.send(registry.render());
    });
  }

  // Login and upload throttling (docs/SECURITY.md): both endpoints do
  // expensive work (password hashing; malware scans and extraction), so
  // they carry per-address sliding-window limits. The identical envelope
  // is shared with the account-scoped lockout below so a locked account
  // is indistinguishable from an exhausted address window.
  const rateLimitedBody = (requestId: string) => ({
    code: 'RATE_LIMITED',
    message: 'Too many attempts; wait a few minutes and try again.',
    requestId,
  });
  const authLimiter = createRateLimiter(
    options.rateLimits?.auth ?? { windowMs: 5 * 60_000, max: 20 },
  );
  const uploadLimiter = createRateLimiter(
    options.rateLimits?.upload ?? { windowMs: 10 * 60_000, max: 30 },
  );
  // Second throttling dimension for sign-in only: the per-address window
  // above is trivially bypassed by rotating source addresses, so repeated
  // failures against ONE account (keyed by a hash of the normalised
  // email, never the raw address) earn a temporary account lock that is
  // checked in the auth route handler where the parsed body is available.
  const accountLockout = createAccountLockout(
    options.rateLimits?.accountLockout ?? {
      windowMs: 15 * 60_000,
      maxFailures: 10,
      lockMs: 15 * 60_000,
    },
  );
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const isAuthAttempt =
      request.method === 'POST' &&
      (path === '/api/auth/sign-in/email' || path === '/api/auth/sign-up/email');
    const isUpload =
      (request.method === 'POST' || request.method === 'PUT') &&
      (path === '/api/loa-documents' ||
        (path.startsWith('/api/loa-documents/') &&
          path.endsWith('/contract-sources')) ||
        path === '/api/organisation/logo' ||
        path.endsWith('/signed-copy') ||
        // PAC scanned-certificate and extension railway-response uploads:
        // both are 25MB PDF bodies that run the malware scan, so they
        // carry the same per-address limit as every other scan-bearing
        // upload.
        (path.startsWith('/api/pac-certificates/') && path.endsWith('/document')) ||
        path.endsWith('/response-document'));
    const limiter = isAuthAttempt ? authLimiter : isUpload ? uploadLimiter : null;
    if (limiter !== null && !limiter.allow(request.ip)) {
      return reply.status(429).send(rateLimitedBody(request.id));
    }
    return undefined;
  });

  const storage = createFileSystemStorage(
    options.objectStorageDir ?? './local-data/objects',
  );
  registerHealthRoutes(app, {
    ...(database ? { database } : {}),
    storage,
    // Only explicitly configured externals are probed: a defaulted URL
    // in a test environment must not fail readiness.
    ...(options.gotenbergUrl !== undefined
      ? { gotenbergUrl: options.gotenbergUrl }
      : {}),
    ...(options.clamav ? { clamav: options.clamav } : {}),
  });

  if (auth && database) {
    const authInstance = auth;
    app.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      handler: async (request, reply) => {
        const path = request.url.split('?')[0] ?? '';
        const action = identityActionForPath(path);

        // Account-scoped login lockout: keyed by a hash of the submitted
        // email, so it holds across rotating source addresses. The check
        // runs BEFORE the request reaches Better Auth, and the locked
        // response is the exact rate-limit envelope whether or not the
        // account exists — no existence oracle, in content or in timing.
        let lockoutKey: string | null = null;
        if (request.method === 'POST' && path === '/api/auth/sign-in/email') {
          const email = (request.body as { email?: unknown } | null | undefined)?.email;
          if (typeof email === 'string' && email.trim() !== '') {
            lockoutKey = accountLockoutKey(email);
            if (accountLockout.isLocked(lockoutKey)) {
              return reply.status(429).send(rateLimitedBody(request.id));
            }
          }
        }

        // Sign-out revokes the session, so the acting user must be read
        // BEFORE the request is forwarded — afterwards the cookie is dead.
        let signOutUserId: string | null = null;
        if (action === 'sign_out') {
          const session = await authInstance.api.getSession({
            headers: toWebHeaders(request),
          });
          signOutUserId = session?.user.id ?? null;
        }

        const response = await authInstance.handler(toWebRequest(request));

        if (lockoutKey !== null) {
          if (response.status < 400) {
            accountLockout.clear(lockoutKey);
          } else if (accountLockout.recordFailure(lockoutKey)) {
            // The lockout just engaged: audit it once per episode. Only
            // the email hash is recorded — never the raw email or any
            // password material — and a lost audit row must not turn
            // into a different response for the caller.
            try {
              await recordLoginLockout(database, {
                emailHash: lockoutKey,
                requestId: request.id,
              });
            } catch (error) {
              request.log.error({ err: error }, 'login lockout audit write failed');
            }
          }
        }
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') void reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) void reply.header('set-cookie', cookies);
        const text = await response.text();

        if (action !== null && response.status < 400) {
          const userId =
            action === 'sign_out' ? signOutUserId : userIdFromAuthBody(text);
          if (userId !== null) {
            // The auth response above already succeeded; failing the
            // request over a lost audit row would desync the client from
            // the session that now exists, so log loudly and continue.
            try {
              await recordIdentityEvent(database, {
                userId,
                action,
                requestId: request.id,
              });
            } catch (error) {
              request.log.error(
                { err: error, action, userId },
                'identity audit write failed',
              );
            }
          }
        }
        return reply.send(text.length > 0 ? text : null);
      },
    });
    registerIdentityRoutes(app, authInstance, database);

    // Raw bodies for the upload endpoints (LOA PDFs, organisation logo);
    // every other route keeps the default JSON-only content types.
    for (const contentType of ['application/pdf', 'image/png', 'image/jpeg']) {
      app.addContentTypeParser(
        contentType,
        { parseAs: 'buffer' },
        (_request, body, done) => {
          done(null, body);
        },
      );
    }
    const scanner = options.clamav
      ? createClamdScanner(options.clamav.host, options.clamav.port)
      : noScanner;
    registerExportRoutes(app, authInstance, database);
    registerAmendmentRoutes(app, authInstance, database);
    registerDashboardRoutes(app, authInstance, database);
    registerOrganisationRoutes(app, authInstance, database, storage, scanner);
    registerMasterRoutes(app, authInstance, database);
    registerRetentionRoutes(app, authInstance, database);
    registerQuotationRoutes(app, authInstance, database);
    registerPurchaseOrderRoutes(app, authInstance, database);
    registerTimelineRoutes(app, authInstance, database);
    registerSerialRoutes(app, authInstance, database);
    registerInstallationRoutes(app, authInstance, database);
    registerPaymentRoutes(app, authInstance, database);
    registerLoaRoutes(app, authInstance, database, storage, scanner);
    registerContractSourceRoutes(app, authInstance, database, storage, scanner);
    registerChallanRoutes(
      app,
      authInstance,
      database,
      storage,
      options.gotenbergUrl ?? 'http://127.0.0.1:3001',
      scanner,
    );
    registerExtensionRoutes(
      app,
      authInstance,
      database,
      storage,
      options.gotenbergUrl ?? 'http://127.0.0.1:3001',
      scanner,
    );
    registerIssueChallanRoutes(
      app,
      authInstance,
      database,
      storage,
      options.gotenbergUrl ?? 'http://127.0.0.1:3001',
      scanner,
    );
    registerCorrectionRoutes(
      app,
      authInstance,
      database,
      storage,
      options.gotenbergUrl ?? 'http://127.0.0.1:3001',
    );
    registerPacRoutes(app, authInstance, database, storage, scanner);
    registerMeasurementBookRoutes(
      app,
      authInstance,
      database,
      storage,
      options.gotenbergUrl ?? 'http://127.0.0.1:3001',
    );
    registerTaxInvoiceRoutes(app, authInstance, database);
    registerEwayBillRoutes(app, authInstance, database);
    registerWorkCompletionRoutes(app, authInstance, database);
  }

  return app;
}

export { assertProductionSecret };
