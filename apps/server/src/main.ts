import { assertProductionSecret, buildApp } from './app.js';

const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? '3000');

// If a close hook hangs (e.g. the database pool waiting on a wedged
// connection), the process must still exit so the orchestrator does not
// have to escalate to SIGKILL.
const SHUTDOWN_DEADLINE_MS = 10_000;

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error('API_PORT must be a valid TCP port');
}

const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

const app = await buildApp({
  logger: true,
  ...(process.env.METRICS_TOKEN ? { metricsToken: process.env.METRICS_TOKEN } : {}),
  ...(process.env.DATABASE_URL
    ? {
        databaseUrl: process.env.DATABASE_URL,
        authSecret: assertProductionSecret(process.env.AUTH_SECRET),
        baseUrl: `http://${host}:${String(port)}`,
        trustedOrigins: [webOrigin],
        ...(process.env.OBJECT_STORAGE_DIR
          ? { objectStorageDir: process.env.OBJECT_STORAGE_DIR }
          : {}),
        ...(process.env.GOTENBERG_URL
          ? { gotenbergUrl: process.env.GOTENBERG_URL }
          : {}),
        ...(process.env.CLAMAV_HOST
          ? {
              clamav: {
                host: process.env.CLAMAV_HOST,
                port: Number(process.env.CLAMAV_PORT ?? '3310'),
              },
            }
          : {}),
      }
    : {}),
});

const stop = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => {
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
  process.exit(0);
};

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

await app.listen({ host, port });
