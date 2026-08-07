import { buildApp } from './app.js';

const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? '3000');

// If a close hook hangs (e.g. the database pool waiting on a wedged
// connection), the process must still exit so the orchestrator does not
// have to escalate to SIGKILL.
const SHUTDOWN_DEADLINE_MS = 10_000;

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error('API_PORT must be a valid TCP port');
}

const app = await buildApp({
  logger: true,
  ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {}),
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
