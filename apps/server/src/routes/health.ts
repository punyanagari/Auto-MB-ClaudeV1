import net from 'node:net';
import { HealthResponseSchema, ReadinessResponseSchema } from '@auto-mb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import type { ObjectStorage } from '../storage.js';

// A wedged-but-connected dependency must surface as 503 within this
// bound; connection timeouts cover establishment only.
const PROBE_TIMEOUT_MS = 2_000;

type ComponentState = 'ok' | 'failed' | 'unconfigured';

export interface ReadinessDeps {
  readonly database?: Sql;
  readonly storage?: ObjectStorage;
  readonly gotenbergUrl?: string;
  readonly clamav?: { readonly host: string; readonly port: number };
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('readiness probe timed out'));
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeDatabase(database: Sql): Promise<void> {
  await withTimeout(Promise.resolve(database`select 1 as ready`));
}

/** Round-trips a marker object: catches a read-only or root-owned
 * volume, the failure mode a plain SELECT can never see. */
async function probeStorage(storage: ObjectStorage): Promise<void> {
  // Object keys are <uuid>/<area>/<name>; the nil UUID is the probe's
  // reserved tenant, never a real organisation. One FIXED key that every
  // probe overwrites — a per-probe random key would leave a new file
  // behind on every poll, forever (external re-audit: a one-minute
  // uptime monitor is half a million files a year).
  const key = '00000000-0000-4000-8000-000000000000/readiness/probe';
  await withTimeout(
    (async () => {
      await storage.put(key, Buffer.from('ready'));
      await storage.get(key);
    })(),
  );
}

async function probeGotenberg(baseUrl: string): Promise<void> {
  const response = await withTimeout(
    fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
  );
  if (!response.ok) throw new Error(`gotenberg answered ${String(response.status)}`);
}

/** clamd PING/PONG over one short-lived socket. */
function probeClamav(host: string, port: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host, port });
      const chunks: Buffer[] = [];
      socket.setTimeout(PROBE_TIMEOUT_MS, () => {
        socket.destroy(new Error('clamd probe timed out'));
      });
      socket.on('connect', () => {
        socket.write('zPING\0');
      });
      socket.on('data', (data) => {
        chunks.push(data);
        if (Buffer.concat(chunks).includes('PONG')) socket.end();
      });
      socket.on('error', reject);
      socket.on('close', () => {
        if (Buffer.concat(chunks).includes('PONG')) resolve();
        else reject(new Error('clamd did not answer PONG'));
      });
    }),
  );
}

async function probe(
  state: ComponentState,
  run: () => Promise<void>,
): Promise<ComponentState> {
  if (state === 'unconfigured') return state;
  try {
    await run();
    return 'ok';
  } catch {
    return 'failed';
  }
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: ReadinessDeps = {},
): void {
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
      const { database, storage, gotenbergUrl, clamav } = deps;
      const [databaseState, storageState, rendererState, scannerState] =
        await Promise.all([
          probe(database ? 'ok' : 'unconfigured', () =>
            database ? probeDatabase(database) : Promise.resolve(),
          ),
          probe(storage ? 'ok' : 'unconfigured', () =>
            storage ? probeStorage(storage) : Promise.resolve(),
          ),
          probe(gotenbergUrl !== undefined ? 'ok' : 'unconfigured', () =>
            gotenbergUrl !== undefined
              ? probeGotenberg(gotenbergUrl)
              : Promise.resolve(),
          ),
          probe(clamav !== undefined ? 'ok' : 'unconfigured', () =>
            clamav !== undefined
              ? probeClamav(clamav.host, clamav.port)
              : Promise.resolve(),
          ),
        ]);

      const components = {
        database: databaseState,
        objectStorage: storageState,
        pdfRenderer: rendererState,
        malwareScanner: scannerState,
      };
      // Every CONFIGURED dependency must answer: a dead scanner means
      // uploads fail closed and a dead renderer means no challan PDFs —
      // both are outages the uptime monitor must see, not paper over.
      const failed = Object.entries(components)
        .filter(([, state]) => state === 'failed')
        .map(([name]) => `${name}-unreachable`);
      if (deps.database === undefined) {
        return reply.status(503).send({
          status: 'not-ready',
          reason: 'database-not-configured',
          components,
        });
      }
      if (failed.length > 0) {
        request.log.error({ components }, 'readiness check failed');
        return reply.status(503).send({
          status: 'not-ready',
          reason: failed.join(','),
          components,
        });
      }
      return { status: 'ready' as const, components };
    },
  );
}
