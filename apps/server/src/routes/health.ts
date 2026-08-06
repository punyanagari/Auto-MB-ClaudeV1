import { HealthResponseSchema } from '@auto-mb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';

export async function registerHealthRoutes(
  app: FastifyInstance,
  database?: Sql,
): Promise<void> {
  app.get(
    '/api/health',
    {
      schema: {
        response: { 200: HealthResponseSchema },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'auto-mb-server',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    }),
  );

  app.get('/api/ready', async (_request, reply) => {
    if (!database) {
      return reply.status(503).send({ status: 'not-ready', reason: 'database-not-configured' });
    }
    await database`select 1 as ready`;
    return { status: 'ready' };
  });
}
