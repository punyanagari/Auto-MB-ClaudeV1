import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabasePool } from '@auto-mb/db';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  readonly logger?: boolean;
  readonly databaseUrl?: string;
  readonly enableDocsUi?: boolean;
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

  try {
    if (database) {
      app.addHook('onClose', async () => {
        await database.end();
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
  return app;
}
