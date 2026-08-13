import net from 'node:net';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HealthResponseSchema, ReadinessResponseSchema } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { API_VERSION } from '../api-version.js';
import type { ObjectStorage } from '../storage.js';
import type { AppInstance } from '../app-instance.js';

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

/* --- schema-version gate ---------------------------------------------- */

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Where the migrations this build expects live. The production image sets
 * `AUTO_MB_MIGRATIONS_DIR` explicitly, because the compiled bundle no
 * longer sits beside the workspace source (deploy/Dockerfile.server);
 * running from source falls back to the workspace path, which is what the
 * test suites use. Read per request rather than cached, so a test can point
 * the gate at a directory it controls. */
function resolveMigrationsDirectory(): string {
  const configured = process.env.AUTO_MB_MIGRATIONS_DIR;
  if (configured !== undefined && configured !== '') return configured;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/server/src/routes -> repository root -> packages/db/migrations
  return path.resolve(here, '..', '..', '..', '..', 'packages', 'db', 'migrations');
}

// The migration directory inside an image never changes while the process
// lives, so it is read once per directory rather than on every probe: an
// uptime monitor polls this endpoint every minute forever.
const migrationIdCache = new Map<string, readonly string[]>();

async function shippedMigrationIds(directory: string): Promise<readonly string[]> {
  const cached = migrationIdCache.get(directory);
  if (cached !== undefined) return cached;
  const ids = (await readdir(directory))
    .map((name) => MIGRATION_FILE.exec(name)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();
  if (ids.length === 0) throw new Error(`no migrations found in ${directory}`);
  migrationIdCache.set(directory, ids);
  return ids;
}

export type SchemaVersionVerdict =
  | { readonly state: 'ok' }
  | { readonly state: 'behind'; readonly pending: readonly string[] }
  | { readonly state: 'unreadable'; readonly detail: string };

/**
 * Compares the applied-migration ledger with the migration directory this
 * image carries. A container that starts against a database the deploy
 * never migrated answers every request against a schema its code does not
 * expect; before this gate it also answered `/api/ready` with `ready`, so
 * the deploy's own readiness check and the uptime monitor both certified
 * it (reconciled review, production-readiness).
 *
 * Only the BEHIND direction fails. A ledger AHEAD of the image is the
 * documented rollback posture — migrations are forward-only and are
 * deliberately not rolled back with the image (docs/OPERATIONS.md §4), so
 * the previous release running against a migrated schema is expected and
 * must stay ready.
 */
export async function checkSchemaVersion(
  database: Sql,
  directory: string,
): Promise<SchemaVersionVerdict> {
  let shipped: readonly string[];
  try {
    shipped = await shippedMigrationIds(directory);
  } catch (error) {
    return {
      state: 'unreadable',
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }

  let applied: Set<string>;
  try {
    applied = await withTimeout(async () => {
      // to_regclass rather than a catalog join: an unmigrated database has
      // no ledger at all, which is "behind by everything", not an error.
      const [present] = await database<{ present: boolean }[]>`
        select to_regclass('public.schema_migrations') is not null as present
      `;
      if (present?.present !== true) return new Set<string>();
      const rows = await database<{ id: string }[]>`
        select id from schema_migrations
      `;
      return new Set(rows.map((row) => row.id));
    });
  } catch (error) {
    return {
      state: 'unreadable',
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }

  const pending = shipped.filter((id) => !applied.has(id));
  return pending.length === 0 ? { state: 'ok' } : { state: 'behind', pending };
}

async function withTimeout<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('readiness probe timed out'));
      }, PROBE_TIMEOUT_MS);
    });
    return await Promise.race([start(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function probeDatabase(database: Sql): Promise<void> {
  await withTimeout(() => Promise.resolve(database`select 1 as ready`));
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
  await withTimeout(async () => {
    await storage.put(key, Buffer.from('ready'));
    await storage.get(key);
  });
}

async function probeGotenberg(baseUrl: string): Promise<void> {
  const response = await withTimeout((signal) =>
    fetch(`${baseUrl}/health`, { signal }),
  );
  if (!response.ok) throw new Error(`gotenberg answered ${String(response.status)}`);
}

/** clamd PING/PONG over one short-lived socket. */
function probeClamav(host: string, port: number): Promise<void> {
  return withTimeout(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port });
        const chunks: Buffer[] = [];
        let settled = false;
        const settle = (error?: Error): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error === undefined) resolve();
          else reject(error);
        };
        signal.addEventListener(
          'abort',
          () => settle(new Error('clamd probe timed out')),
          { once: true },
        );
        socket.setTimeout(PROBE_TIMEOUT_MS, () => {
          settle(new Error('clamd probe timed out'));
        });
        socket.on('connect', () => {
          socket.write('zPING\0');
        });
        socket.on('data', (data) => {
          chunks.push(data);
          if (Buffer.concat(chunks).includes('PONG')) settle();
        });
        socket.on('error', (error) => settle(error));
        socket.on('close', () => {
          if (settled) return;
          if (Buffer.concat(chunks).includes('PONG')) settle();
          else settle(new Error('clamd did not answer PONG'));
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

export function registerHealthRoutes(app: AppInstance, deps: ReadinessDeps = {}): void {
  app.get(
    '/api/health',
    {
      schema: {
        response: { 200: HealthResponseSchema },
      },
    },
    // The version reads the one source (`api-version.ts` → the server
    // package's own version), like the OpenAPI document does. It used to
    // be the scaffold's literal '0.1.0' — a second copy of a number, which
    // is why it had already drifted three minor versions behind by the
    // time the reconciled review measured it. An uptime monitor and a
    // deploy check both read this field to tell one release from another,
    // so a frozen string made them agree about nothing.
    () => ({
      status: 'ok' as const,
      service: 'auto-mb-server',
      version: API_VERSION,
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
      // Narrowing the destructured binding rather than `deps.database`, so
      // the schema-version gate below sees a defined connection.
      if (database === undefined) {
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

      // The database answered, so the schema it answered from must be the
      // one this image was built against. The pending ids go to the log,
      // never to the response: readiness is public through Caddy, and the
      // reason word is what the deploy gate and the uptime monitor match on.
      const schema = await checkSchemaVersion(database, resolveMigrationsDirectory());
      if (schema.state !== 'ok') {
        const reason =
          schema.state === 'behind'
            ? 'schema-migrations-behind'
            : 'schema-migrations-unreadable';
        request.log.error(
          schema.state === 'behind'
            ? { pending: schema.pending }
            : { detail: schema.detail },
          `readiness check failed: ${reason}`,
        );
        return reply.status(503).send({
          status: 'not-ready',
          reason,
          components,
        });
      }

      return { status: 'ready' as const, components };
    },
  );
}
