import { createHash, timingSafeEqual } from 'node:crypto';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import pg from 'pg';
import { API_VERSION } from './api-version.js';
import type { AppInstance } from './app-instance.js';
import { createDatabasePool, withUserContext } from '@auto-mb/db';
import { assertProductionSecret, createAuth, type Auth } from './auth.js';
import { toWebHeaders, toWebRequest } from './http.js';
import {
  identityActionForPath,
  isTwoFactorPath,
  recordIdentityEvent,
  recordLoginLockout,
} from './identity-audit.js';
import {
  configureMfaEnforcement,
  mfaEnforcementEnabled,
  mfaGate,
  mfaRequiredByPolicyError,
} from './mfa-policy.js';
import { createClamdScanner, noScanner } from './malware-scan.js';
import {
  createMetricsRegistry,
  recordAuthFailure,
  recordTenantDenial,
  type AuthFailureSurface,
  type DatabasePoolSample,
} from './metrics.js';
import {
  accountLockoutKey,
  createAccountLockout,
  createPgAccountLockout,
  createPgRateLimiter,
  createRateLimiter,
  type AccountLockoutRule,
  type RateLimitRule,
} from './rate-limit.js';
import { remedyFor } from './remedies.js';
import { registerAmendmentRoutes } from './routes/amendments.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerExportRoutes } from './routes/export.js';
import { registerExtensionRoutes } from './routes/extensions.js';
import { registerOrganisationRoutes } from './routes/organisation.js';
import { registerChallanRoutes } from './routes/challans.js';
import { registerIssueChallanRoutes } from './routes/issue-challans.js';
import { registerCorrectionRoutes } from './routes/corrections.js';
import { registerContractSourceRoutes } from './routes/contract-sources.js';
import { registerReceivedRailwayBillRoutes } from './routes/received-railway-bills.js';
import { registerBillPaymentRoutes } from './routes/bill-payments.js';
import { registerCompanyDocumentRoutes } from './routes/company-documents.js';
import { registerInspectionRoutes } from './routes/inspections.js';
import { registerPaymentsWorkspaceRoutes } from './routes/payments.js';
import { registerTenderRoutes } from './routes/tenders.js';
import { registerCorrespondenceRoutes } from './routes/correspondence.js';
import { registerProductionRoutes } from './routes/production.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerLoaRoutes } from './routes/loa.js';
import { registerMasterRoutes } from './routes/masters.js';
import { registerRetentionRoutes } from './routes/retention.js';
import { registerTimelineRoutes } from './routes/timeline.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSerialRoutes } from './routes/serials.js';
import { registerInstallationRoutes } from './routes/installations.js';
import { registerPaymentRoutes } from './routes/payment.js';
import { registerPacRoutes } from './routes/pac.js';
import { registerPurchaseOrderRoutes } from './routes/purchase-orders.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerPlatformRoutes } from './routes/platform.js';
import { registerSigningRoutes } from './routes/signing.js';
import { registerHrRoutes } from './routes/hr.js';
import { registerMaintenanceRoutes } from './routes/maintenance.js';
import { registerMeasurementBookRoutes } from './routes/measurement-books/index.js';
import { registerTaxInvoiceRoutes } from './routes/tax-invoices/index.js';
import { registerCreditNoteRoutes } from './routes/credit-notes.js';
import { registerEwayBillRoutes } from './routes/eway-bills.js';
import { registerQuotationRoutes } from './routes/quotations.js';
import { registerWorkCompletionRoutes } from './routes/work-completion.js';
import { registerWorkSupersedeRoutes } from './routes/work-supersede.js';
import {
  createFileSystemStorage,
  EMPTY_TRUST_ANCHOR_STORE,
  type TrustAnchorStore,
} from '@auto-mb/documents';
import { recordRegisteredRoutes, tenantRoutesOf } from './tenant-route.js';
import { assertProductionMalwareScanning } from './upload-guards.js';
import type { StatutoryProvider } from './gsp/statutory-provider.js';
import { createMutationOriginGuard, isOriginExemptRoute } from './origin-guard.js';

interface BuildAppOptions {
  readonly logger?: boolean;
  readonly databaseUrl?: string;
  readonly enableDocsUi?: boolean;
  /** Enables authentication and the identity routes; requires databaseUrl. */
  readonly authSecret?: string;
  readonly baseUrl?: string;
  readonly trustedOrigins?: readonly string[];
  /** Optional statutory transport. Credentials live inside the injected
   * adapter and are never accepted by HTTP routes or persisted. */
  readonly statutoryProvider?: StatutoryProvider;
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
  /** Trust anchors for verifying digital signatures on inbound railway
   * PDFs (migration 0060). Loaded by main.ts from
   * AUTO_MB_PDF_TRUST_ANCHORS. Unset means signatures are still verified
   * cryptographically and recorded, but no trust decision is made and no
   * document can reach the `signed_and_intact` state — never that
   * signatures are ignored. */
  readonly pdfTrustAnchors?: TrustAnchorStore;
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
    readonly signing?: RateLimitRule;
    readonly accountLockout?: AccountLockoutRule;
  };
  /** Namespace for the PostgreSQL-backed throttle state (finding 38,
   * migration 0054). Every production replica keeps the default, so all
   * instances count the same attempts. Under an explicit test NODE_ENV an
   * unconfigured instance gets a random namespace of its own instead —
   * parallel suites share one database and one loopback address, and an
   * accidentally shared window would let one suite's sign-ins throttle
   * another's; this reproduces the per-process scope the in-memory maps
   * had and every existing suite was written against. The cross-instance
   * sharing proof passes an explicit shared namespace. */
  readonly throttleNamespace?: string;
  /** Turns the finding-36 MFA refusals on: privilege-holding users without
   * enrolled TOTP are refused tenant-scoped requests and refused two-factor
   * disable. The gate itself is always computed and reported by /api/me;
   * only the refusals are flag-gated, so the control deploys dark. When the
   * option is omitted the process-wide default (MFA_ENFORCE, read by
   * main.ts) stands. */
  readonly mfaEnforce?: boolean;
  /** Number of reverse-proxy hops to trust for client addressing. In the
   * production topology the server sits exactly one hop behind Caddy,
   * which replaces any client-supplied X-Forwarded-For with the real
   * peer address, so 1 is the correct (and narrow) setting there. Unset
   * trusts no proxy: request.ip is the socket peer, and forwarded
   * headers are ignored — the safe default when exposed directly. */
  readonly trustProxyHops?: number;
  /** Connection-pool and socket limits, wired from the environment by
   * main.ts (DATABASE_POOL_MAX / REQUEST_TIMEOUT_MS /
   * KEEP_ALIVE_TIMEOUT_MS). Defaults live in `SERVER_LIMITS`. */
  readonly limits?: {
    readonly poolMax?: number;
    readonly requestTimeoutMs?: number;
    readonly keepAliveTimeoutMs?: number;
  };
}

/**
 * Concurrency and socket limits, in one place because they are a single
 * decision about how much work one instance accepts.
 *
 * `poolMax` was 5, which — with a dashboard that used to take the better
 * part of a second — capped a single instance at roughly five concurrent
 * database-bound requests and made the pool, not PostgreSQL, the queue.
 * 20 is well inside a default `max_connections = 100` for the two pools
 * (postgres.js plus Better Auth's) of a small number of instances, and is
 * overridable per deployment.
 *
 * The two timeouts exist because a request that never completes and a
 * connection that is never reused both hold a slot in that pool
 * indefinitely. `requestTimeout` is deliberately longer than the slowest
 * legitimate synchronous route (PDF rendering through Gotenberg), and
 * `keepAliveTimeout` sits above the usual 60 s proxy idle timeout so the
 * server is not the side that races a proxy into a reset.
 */
export const SERVER_LIMITS = {
  poolMax: 20,
  requestTimeoutMs: 120_000,
  keepAliveTimeoutMs: 72_000,
} as const;

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

/**
 * The raw session token from a Better Auth Set-Cookie list. The cookie
 * value is `${token}.${signature}` (URI-encoded); the auth_sessions row
 * stores the bare token. Enable-completion and disable both ROTATE the
 * caller's session, so the token to preserve when revoking the user's
 * other sessions is the one this response just set, not the one the
 * request arrived with.
 */
function sessionTokenFromSetCookie(cookies: readonly string[]): string | null {
  for (const entry of cookies) {
    const match = /^(?:__Secure-)?better-auth\.session_token=([^;]*)/.exec(entry);
    if (match?.[1] !== undefined && match[1] !== '') {
      const token = decodeURIComponent(match[1]).split('.')[0];
      if (token !== undefined && token.length > 0) return token;
    }
  }
  return null;
}

/**
 * The pending two-factor challenge identifier from the request's Cookie
 * header. Better Auth's sign-in-time verification lockout fires before any
 * session exists, so the locked account can only be named through the
 * challenge cookie's verification row. The signature is deliberately not
 * verified here: the identifier is only used to LOOK UP a server-created
 * verification row for an audit fact, and a forged identifier simply finds
 * nothing.
 */
function twoFactorChallengeIdentifier(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined) return null;
  const match = /(?:^|;\s*)(?:__Secure-)?better-auth\.two_factor=([^;]*)/.exec(
    cookieHeader,
  );
  if (match?.[1] === undefined || match[1] === '') return null;
  const identifier = decodeURIComponent(match[1]).split('.')[0];
  return identifier !== undefined && identifier.length > 0 ? identifier : null;
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

export async function buildApp(options: BuildAppOptions = {}): Promise<AppInstance> {
  // Explicit only: an omitted option must not overwrite the process-wide
  // default (or another instance's explicit choice) with `false`.
  if (options.mfaEnforce !== undefined) {
    configureMfaEnforcement(options.mfaEnforce);
  }

  // Fail closed at boot, beside the auth-secret and MFA gates: the upload
  // routes exist only where authentication and a database do, and with
  // CLAMAV_HOST unset they come up behind `noScanner`, whose scan is a
  // no-op. The fail-closed behaviour docs/SECURITY.md describes therefore
  // only exists once scanning has been switched on, so a production
  // process refuses to start rather than serve uploads with nothing
  // behind them. Asserted here, before any pool or listener is created,
  // so the refusal cannot strand a half-built instance.
  if (options.authSecret !== undefined && options.databaseUrl !== undefined) {
    assertProductionMalwareScanning(options.clamav);
  }

  // The type provider is compile-time only (see app-instance.ts): route
  // schemas type request.params/body/query instead of `as` casts.
  const poolMax = options.limits?.poolMax ?? SERVER_LIMITS.poolMax;
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: 'x-request-id',
    genReqId: (request) =>
      request.headers['x-request-id']?.toString() ?? crypto.randomUUID(),
    disableRequestLogging: false,
    // A request that never finishes holds a pool slot forever; see
    // SERVER_LIMITS for why these two numbers are what they are.
    requestTimeout: options.limits?.requestTimeoutMs ?? SERVER_LIMITS.requestTimeoutMs,
    keepAliveTimeout:
      options.limits?.keepAliveTimeoutMs ?? SERVER_LIMITS.keepAliveTimeoutMs,
    // Without this, every request behind Caddy shares the proxy's own
    // address and the per-client rate limits collapse into one global
    // bucket (external re-audit).
    ...(options.trustProxyHops !== undefined
      ? { trustProxy: options.trustProxyHops }
      : {}),
  }).withTypeProvider<TypeBoxTypeProvider>();
  // Captures every route registration for the route-inventory test, which
  // proves the tenant preamble is a mechanism rather than a convention.
  recordRegisteredRoutes(app);

  const database = options.databaseUrl
    ? createDatabasePool({
        url: options.databaseUrl,
        max: poolMax,
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
      authPool = new pg.Pool({ connectionString: options.databaseUrl, max: poolMax });
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
          // Single-sourced from apps/server/package.json — see api-version.ts
          // for the scheme and why there is no literal here.
          version: API_VERSION,
          description:
            'Post-award works-contract execution API for Indian government ' +
            'contractors: LOA intake, delivery and issue challans, ' +
            'measurement books, statutory GST documents, and the audit ' +
            'trail over them. Every /api route outside the documented ' +
            'unbound set is tenant-scoped and requires the ' +
            'x-organisation-id header.',
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
      // Imported here rather than at module scope so the UI's assets are
      // only loaded by the environments that actually publish them. A
      // production image never evaluates this branch, which is why the
      // package is a devDependency and its absence must not break boot.
      const { default: swaggerUi } = await import('@fastify/swagger-ui');
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
    // Tenant-boundary denial signal (finding 37): every NOT_A_MEMBER
    // refusal — a request addressed to an organisation the authenticated
    // user holds no active membership in — passes through this handler,
    // so counting here covers every tenant-scoped route at once.
    if (
      statusCode === 403 &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'NOT_A_MEMBER'
    ) {
      recordTenantDenial('not_a_member');
    }
    const explicitlyPublic =
      error instanceof Error &&
      'expose' in error &&
      error.expose === true &&
      declaredStatusCode !== null;
    const body = databaseUnavailable
      ? {
          code: 'DATABASE_UNAVAILABLE',
          message:
            'The database is temporarily unavailable. Nothing was saved. Try again.',
          requestId: request.id,
        }
      : statusCode >= 500 && !explicitlyPublic
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
          };
    // The message states the fact; the remedy states the action. Attached
    // here rather than at 633 call sites because the action belongs to the
    // code — see apps/server/src/remedies.ts. A code with no reviewed
    // remedy sends no field at all, never filler.
    const remedy = remedyFor(body.code);
    void reply
      .status(statusCode)
      .send(remedy === undefined ? body : { ...body, remedy });
  });

  if (options.trustedOrigins !== undefined) {
    const guardMutationOrigin = createMutationOriginGuard(options.trustedOrigins);
    app.addHook('onRequest', (request, _reply, done) => {
      try {
        // `onRequest` runs AFTER routing in Fastify's lifecycle, so the
        // resolved route pattern is available here — which is what the
        // exemption is matched on. Never `request.url`: that is caller
        // input and a prefix test on it is a hole.
        guardMutationOrigin(
          request.method,
          request.headers.origin,
          request.routeOptions.url,
        );
        done();
      } catch (error) {
        done(error as Error);
      }
    });
  }

  if (options.metricsToken !== undefined) {
    // Database saturation (finding 37, docs/OPERATIONS.md §6): sampled at
    // scrape time from pg_stat_activity, which shows a non-superuser the
    // detail of its OWN role's backends — exactly this server's
    // connections. The denominator is the configured pool budget: the
    // app pool plus, when authentication is enabled, Better Auth's own
    // node-postgres pool. A failed or unconfigured sample omits the
    // series rather than reporting a fictional zero.
    const collectDatabasePool = database
      ? async (): Promise<DatabasePoolSample | null> => {
          const rows = await database<{ state: string; connections: number }[]>`
            select coalesce(state, 'unknown') as state, count(*)::int as connections
            from pg_stat_activity
            where datname = current_database() and usename = current_user
            group by 1
          `;
          return {
            maxConnections: authPool !== undefined ? 10 : 5,
            connectionsByState: new Map(
              rows.map((row) => [row.state, row.connections]),
            ),
          };
        }
      : undefined;
    const registry = createMetricsRegistry({
      ...(options.backupMarkerPath !== undefined
        ? { backupMarkerPath: options.backupMarkerPath }
        : {}),
      ...(collectDatabasePool !== undefined ? { collectDatabasePool } : {}),
    });
    // Constant-time bearer comparison: both sides are folded through
    // SHA-256 so the buffers timingSafeEqual compares always have equal
    // length — neither the token's length nor its bytes leak through
    // response timing (a plain `===` short-circuits on the first
    // mismatching character).
    const expectedAuthorization = createHash('sha256')
      .update(`Bearer ${options.metricsToken}`)
      .digest();
    const authorizationMatches = (header: string | undefined): boolean =>
      timingSafeEqual(
        createHash('sha256')
          .update(header ?? '')
          .digest(),
        expectedAuthorization,
      );
    app.addHook('onResponse', (request, reply, done) => {
      registry.observe(
        request.method,
        request.routeOptions.url ?? 'unmatched',
        reply.statusCode,
        reply.elapsedTime / 1000,
      );
      done();
    });
    app.get('/metrics', async (request, reply) => {
      if (!authorizationMatches(request.headers.authorization)) {
        void reply.status(401);
        return { code: 'UNAUTHENTICATED', message: 'Metrics require the token.' };
      }
      void reply.type('text/plain; version=0.0.4');
      return reply.send(await registry.renderAll());
    });
  }

  // Login and upload throttling (docs/SECURITY.md): both endpoints do
  // expensive work (password hashing; malware scans and extraction), so
  // they carry per-address sliding-window limits. The identical envelope
  // is shared with the account-scoped lockout below so a locked account
  // is indistinguishable from an exhausted address window.
  // This envelope is written straight to the reply rather than thrown, so
  // it reads its remedy from the same catalog by hand.
  const rateLimitedRemedy = remedyFor('RATE_LIMITED');
  const rateLimitedBody = (requestId: string) => ({
    code: 'RATE_LIMITED',
    message: 'Too many attempts; wait a few minutes and try again.',
    requestId,
    ...(rateLimitedRemedy === undefined ? {} : { remedy: rateLimitedRemedy }),
  });
  // Database-configured instances share the throttle state through
  // PostgreSQL (finding 38, migration 0054), so a second replica divides
  // nothing; only a database-less instance — which exposes no login or
  // upload surface — falls back to the in-process maps.
  const authRule = options.rateLimits?.auth ?? { windowMs: 5 * 60_000, max: 20 };
  const uploadRule = options.rateLimits?.upload ?? { windowMs: 10 * 60_000, max: 30 };
  // The kiosk signing agent (0091). Its two routes authenticate by bearer
  // token, so an unauthenticated caller can spend a database lookup per
  // request without ever holding a credential — cheap for them, not for
  // us. Sized against the LEGITIMATE poll rather than tightened to the
  // auth rule: the shipped agent polls every 15 seconds (4/minute), so 60
  // a minute leaves fifteen times the headroom a real kiosk needs and
  // still bounds a grinder.
  const signingRule = options.rateLimits?.signing ?? { windowMs: 60_000, max: 60 };
  const throttleNamespace =
    options.throttleNamespace ??
    (process.env.NODE_ENV === 'test' ? crypto.randomUUID() : 'deployment');
  const authLimiter = database
    ? createPgRateLimiter(database, 'auth', authRule, throttleNamespace)
    : createRateLimiter(authRule, 'auth');
  const uploadLimiter = database
    ? createPgRateLimiter(database, 'upload', uploadRule, throttleNamespace)
    : createRateLimiter(uploadRule, 'upload');
  const signingLimiter = database
    ? createPgRateLimiter(database, 'signing', signingRule, throttleNamespace)
    : createRateLimiter(signingRule, 'signing');
  // Second throttling dimension for sign-in only: the per-address window
  // above is trivially bypassed by rotating source addresses, so repeated
  // failures against ONE account (keyed by a hash of the normalised
  // email, never the raw address) earn a temporary account lock that is
  // checked in the auth route handler where the parsed body is available.
  const accountLockoutRule = options.rateLimits?.accountLockout ?? {
    windowMs: 15 * 60_000,
    maxFailures: 10,
    lockMs: 15 * 60_000,
  };
  const accountLockout = database
    ? createPgAccountLockout(database, accountLockoutRule, throttleNamespace)
    : createAccountLockout(accountLockoutRule);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    // Two-factor endpoints join the sign-in window: verify-totp and
    // verify-backup-code are code-guessing surfaces, and enable/disable
    // hash the submitted password exactly like sign-in does.
    const isAuthAttempt =
      request.method === 'POST' &&
      (path === '/api/auth/sign-in/email' ||
        path === '/api/auth/sign-up/email' ||
        path.startsWith('/api/auth/two-factor/'));
    // Which requests are uploads is DERIVED from the route table rather
    // than restated as a path list here. Every raw-body upload route
    // declares a `bodyLimit` through createTenantRouteRegistrar, so the
    // registrar's inventory is the definition of "upload" and a new upload
    // route is throttled from the moment it is registered.
    //
    // The hand-maintained list this replaces had already fallen behind:
    // POST /api/approvals/:id/variation-order — a 25 MB PDF body that runs
    // a malware scan and a Poppler text extraction — matched none of its
    // patterns and was served with no per-address limit at all.
    //
    // `request.routeOptions.url` is the MATCHED route pattern, because
    // Fastify routes before it runs onRequest hooks; an unmatched request
    // carries none and is not an upload. The registry is read per request
    // rather than snapshotted here on purpose: routes register after this
    // hook is installed.
    const routePattern = request.routeOptions.url;
    const isUpload =
      routePattern !== undefined &&
      tenantRoutesOf(app).get(`${request.method} ${routePattern}`)?.bodyLimit !==
        undefined;
    const isKioskSigning =
      routePattern !== undefined && isOriginExemptRoute(request.method, routePattern);
    const limiter = isAuthAttempt
      ? authLimiter
      : isUpload
        ? uploadLimiter
        : isKioskSigning
          ? signingLimiter
          : null;
    // Fail closed: a database failure here throws, and the error handler
    // answers 503 — the protected endpoints could not have served the
    // request without the database anyway.
    if (limiter !== null && !(await limiter.allow(request.ip))) {
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
            // Fail closed like the per-address hook above: a database
            // failure throws into the standard 503.
            if (await accountLockout.isLocked(lockoutKey)) {
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

        // Two-factor endpoints (finding 36): the acting user and their
        // pre-request enrolment state must be read BEFORE forwarding —
        // enable-completion and disable both rotate the session, and the
        // "did this verify complete enrolment?" question is only answerable
        // against the state the request found.
        const isTwoFactor = isTwoFactorPath(path) && request.method === 'POST';
        let twoFactorSession: { userId: string; token: string } | null = null;
        let twoFactorWasEnabled = false;
        if (isTwoFactor) {
          const session = await authInstance.api.getSession({
            headers: toWebHeaders(request),
          });
          if (session) {
            twoFactorSession = {
              userId: session.user.id,
              token: session.session.token,
            };
            const [enabledRow] = await database<{ enabled: boolean | null }[]>`
              select "twoFactorEnabled" as enabled
              from auth_users where "id" = ${session.user.id}
            `;
            twoFactorWasEnabled = enabledRow?.enabled === true;
          }
          // A privilege-holding user may rotate their enrolment but never
          // stand without one: disable is refused by policy before Better
          // Auth ever sees it. Same dark-deploy flag as the tenant wall.
          if (
            path === '/api/auth/two-factor/disable' &&
            twoFactorSession !== null &&
            mfaEnforcementEnabled()
          ) {
            const gate = await withUserContext(
              database,
              twoFactorSession.userId,
              (tx) => mfaGate(tx),
            );
            if (gate.required) throw mfaRequiredByPolicyError();
          }
        }

        const response = await authInstance.handler(toWebRequest(request));

        // Authentication failure signal (finding 37), read from the same
        // response the identity-audit hooks below already judge, so the
        // metric and the audit trail can never disagree. The surface label
        // comes from the matched path, never from request data.
        if (request.method === 'POST' && response.status >= 400) {
          const surface: AuthFailureSurface | null =
            path === '/api/auth/sign-in/email'
              ? 'sign_in'
              : path === '/api/auth/sign-up/email'
                ? 'sign_up'
                : isTwoFactorPath(path)
                  ? 'two_factor'
                  : null;
          if (surface !== null) recordAuthFailure(surface);
        }

        if (lockoutKey !== null) {
          // The auth response above already exists; this is bookkeeping,
          // and a lost update must not turn into a different response for
          // the caller (the pre-request isLocked gate stays fail-closed).
          try {
            if (response.status < 400) {
              await accountLockout.clear(lockoutKey);
            } else if (await accountLockout.recordFailure(lockoutKey)) {
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
          } catch (error) {
            request.log.error(
              { err: error },
              'account lockout bookkeeping failed after the auth response',
            );
          }
        }
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') void reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) void reply.header('set-cookie', cookies);
        const text = await response.text();

        if (isTwoFactor && action !== null) {
          // Success: audit the two-factor act. A verify-totp under a
          // session whose account was not yet enabled is the enrolment
          // completion, so it is recorded as two_factor_enabled rather
          // than two_factor_verified; the sign-in-time verify carries the
          // user in the response body instead of a session.
          if (response.status < 400) {
            const userId = twoFactorSession?.userId ?? userIdFromAuthBody(text);
            const resolvedAction =
              action === 'two_factor_verified' &&
              twoFactorSession !== null &&
              !twoFactorWasEnabled
                ? 'two_factor_enabled'
                : action;
            if (userId !== null) {
              try {
                await recordIdentityEvent(database, {
                  userId,
                  action: resolvedAction,
                  requestId: request.id,
                });
              } catch (error) {
                request.log.error(
                  { err: error, action: resolvedAction, userId },
                  'identity audit write failed',
                );
              }
              // Turning MFA on or off invalidates every OTHER session the
              // account holds: a hijacked pre-enrolment session must not
              // outlive enrolment, and a disable must not leave parallel
              // sessions running under the weaker posture. Better Auth
              // rotated the caller's own session, so the survivor is the
              // token this response just set (falling back to the
              // pre-request token if no rotation happened). Log-and-
              // continue: un-enabling MFA over a failed cleanup would be
              // worse than the stale sessions, which expire on their own.
              if (
                resolvedAction === 'two_factor_enabled' ||
                resolvedAction === 'two_factor_disabled'
              ) {
                const keepToken =
                  sessionTokenFromSetCookie(cookies) ?? twoFactorSession?.token;
                try {
                  if (keepToken !== undefined) {
                    await database`
                      delete from auth_sessions
                      where "userId" = ${userId} and "token" <> ${keepToken}
                    `;
                  }
                } catch (error) {
                  request.log.error(
                    { err: error, userId },
                    'two-factor session revocation failed',
                  );
                }
              }
            }
          } else if (
            response.status === 429 &&
            (path === '/api/auth/two-factor/verify-totp' ||
              path === '/api/auth/two-factor/verify-backup-code')
          ) {
            // Better Auth's built-in verification lockout
            // (auth_two_factors."lockedUntil") answers 429. It fires only
            // in the sign-in flow — before any session exists — so the
            // locked account is named through the challenge cookie's
            // verification row, which the lockout leaves in place.
            try {
              const identifier = twoFactorChallengeIdentifier(request.headers.cookie);
              const [challenge] =
                identifier === null
                  ? []
                  : await database<{ value: string }[]>`
                      select "value" from auth_verifications
                      where "identifier" = ${identifier}
                    `;
              if (challenge !== undefined) {
                await recordIdentityEvent(database, {
                  userId: challenge.value,
                  action: 'two_factor_locked',
                  requestId: request.id,
                });
              }
            } catch (error) {
              request.log.error(
                { err: error },
                'two-factor lockout audit write failed',
              );
            }
          }
        } else if (action !== null && response.status < 400) {
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
    registerPlatformRoutes(app, authInstance, database, storage);
    registerAmendmentRoutes(app, authInstance, database, storage, scanner);
    registerDashboardRoutes(app, authInstance, database);
    registerOrganisationRoutes(app, authInstance, database, storage, scanner);
    registerMasterRoutes(app, authInstance, database);
    registerRetentionRoutes(app, authInstance, database);
    registerQuotationRoutes(app, authInstance, database);
    registerPurchaseOrderRoutes(app, authInstance, database);
    registerInventoryRoutes(app, authInstance, database);
    registerMaintenanceRoutes(app, authInstance, database);
    registerTimelineRoutes(app, authInstance, database);
    registerSerialRoutes(app, authInstance, database);
    registerSearchRoutes(app, authInstance, database);
    registerInstallationRoutes(app, authInstance, database);
    registerPaymentRoutes(app, authInstance, database);
    registerBillPaymentRoutes(app, authInstance, database);
    registerCompanyDocumentRoutes(app, authInstance, database, storage, scanner);
    registerInspectionRoutes(app, authInstance, database, storage, scanner);
    registerPaymentsWorkspaceRoutes(app, authInstance, database);
    registerHrRoutes(app, authInstance, database);
    registerTenderRoutes(app, authInstance, database, storage, scanner);
    registerProductionRoutes(app, authInstance, database);
    const pdfTrustAnchors = options.pdfTrustAnchors ?? EMPTY_TRUST_ANCHOR_STORE;
    // Every PDF-rendering route below takes the same endpoint; the default
    // is the compose-provided local service, resolved once here so the
    // nine registrations cannot drift apart. Readiness probing above is
    // deliberately NOT defaulted — an unconfigured test environment must
    // not fail its health check on a Gotenberg that was never deployed.
    const gotenbergUrl = options.gotenbergUrl ?? 'http://127.0.0.1:3001';
    registerLoaRoutes(app, authInstance, database, storage, scanner);
    registerContractSourceRoutes(
      app,
      authInstance,
      database,
      storage,
      scanner,
      pdfTrustAnchors,
    );
    registerReceivedRailwayBillRoutes(
      app,
      authInstance,
      database,
      storage,
      scanner,
      pdfTrustAnchors,
    );
    // The third consumer of the trust anchors, and the first that verifies
    // a document this server produced rather than one it received
    // (0091, ADR-0012): the kiosk lane refuses to store a signature its
    // own verifier does not read as signed_and_intact.
    registerSigningRoutes(app, authInstance, database, storage, pdfTrustAnchors);
    registerChallanRoutes(app, authInstance, database, storage, gotenbergUrl, scanner);
    registerExtensionRoutes(
      app,
      authInstance,
      database,
      storage,
      gotenbergUrl,
      scanner,
    );
    registerIssueChallanRoutes(
      app,
      authInstance,
      database,
      storage,
      gotenbergUrl,
      scanner,
    );
    registerCorrectionRoutes(app, authInstance, database, storage, gotenbergUrl);
    registerPacRoutes(app, authInstance, database, storage, scanner);
    registerMeasurementBookRoutes(app, authInstance, database, storage, gotenbergUrl);
    registerTaxInvoiceRoutes(
      app,
      authInstance,
      database,
      storage,
      gotenbergUrl,
      options.statutoryProvider,
    );
    registerCreditNoteRoutes(
      app,
      authInstance,
      database,
      storage,
      gotenbergUrl,
      options.statutoryProvider,
    );
    registerEwayBillRoutes(
      app,
      authInstance,
      database,
      storage,
      gotenbergUrl,
      options.statutoryProvider,
    );
    registerCorrespondenceRoutes(
      app,
      authInstance,
      database,
      storage,
      gotenbergUrl,
      scanner,
    );
    registerWorkCompletionRoutes(app, authInstance, database);
    registerWorkSupersedeRoutes(app, authInstance, database);
  }

  return app;
}

export { assertProductionSecret };
