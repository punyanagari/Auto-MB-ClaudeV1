import { HealthResponseSchema } from '@auto-mb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';

export function registerHealthRoutes(app: FastifyInstance, database?: Sql): void {
  app.get(
    '/api/health',
    {
      schema: {
        response: { 200: HealthResponseSchema },
      },
    },
    () => ({
      status: 'ok' as const,
      service: 'auto-mb-server',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    }),
  );

  app.get('/api/ready', async (request, reply) => {
    if (!database) {
      return reply
        .status(503)
        .send({ status: 'not-ready', reason: 'database-not-configured' });
    }
    try {
      await database`select 1 as ready`;
    } catch (error) {
      request.log.error({ err: error }, 'readiness check failed');
      return reply
        .status(503)
        .send({ status: 'not-ready', reason: 'database-unreachable' });
    }
    return { status: 'ready' };
  });
}
