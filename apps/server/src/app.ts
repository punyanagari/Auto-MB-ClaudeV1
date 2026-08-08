import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { createDatabasePool } from '@auto-mb/db';
import { assertProductionSecret, createAuth, type Auth } from './auth.js';
import { toWebHeaders, toWebRequest } from './http.js';
import { identityActionForPath, recordIdentityEvent } from './identity-audit.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerLoaRoutes } from './routes/loa.js';
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

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: 'x-request-id',
    genReqId: (request) =>
      request.headers['x-request-id']?.toString() ?? crypto.randomUUID(),
    disableRequestLogging: false,
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
    const statusCode =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode <= 599
        ? error.statusCode
        : 500;
    void reply.status(statusCode).send(
      statusCode >= 500
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
          },
    );
  });

  registerHealthRoutes(app, database);

  if (auth && database) {
    const authInstance = auth;
    app.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      handler: async (request, reply) => {
        const action = identityActionForPath(request.url.split('?')[0] ?? '');
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

    // Raw application/pdf bodies for the LOA upload endpoint; every other
    // route keeps the default JSON-only content types.
    app.addContentTypeParser(
      'application/pdf',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );
    registerLoaRoutes(
      app,
      authInstance,
      database,
      createFileSystemStorage(options.objectStorageDir ?? './local-data/objects'),
    );
  }

  return app;
}

export { assertProductionSecret };
