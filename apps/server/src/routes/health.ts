import { HealthResponseSchema, ReadinessResponseSchema } from '@auto-mb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';

// A wedged-but-connected database must surface as 503 within this bound;
// the pool's connect_timeout covers connection establishment only.
const READINESS_QUERY_TIMEOUT_MS = 2_000;

async function probeDatabase(database: Sql): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      database`select 1 as ready`,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('readiness query timed out'));
        }, READINESS_QUERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

  app.get(
    '/api/ready',
    {
      schema: {
        response: { 200: ReadinessResponseSchema, 503: ReadinessResponseSchema },
      },
    },
    async (request, reply) => {
      if (!database) {
        return reply
          .status(503)
          .send({ status: 'not-ready', reason: 'database-not-configured' });
      }
      try {
        await probeDatabase(database);
      } catch (error) {
        request.log.error({ err: error }, 'readiness check failed');
        return reply
          .status(503)
          .send({ status: 'not-ready', reason: 'database-unreachable' });
      }
      return { status: 'ready' as const };
    },
  );
}
