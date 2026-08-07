import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabasePool } from '@auto-mb/db';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  readonly logger?: boolean;
  readonly databaseUrl?: string;
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
  await app.register(swaggerUi, { routePrefix: '/documentation' });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, 'request failed');
    void reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.',
      requestId: request.id,
    });
  });

  await registerHealthRoutes(app, database);
  return app;
}
