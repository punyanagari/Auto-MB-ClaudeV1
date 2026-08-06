import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from './pool.js';
import { runMigrations } from './migration-runner.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL is required');

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '..', 'migrations');
const sql = createDatabasePool({ url, max: 1, applicationName: 'auto-mb-migrator' });

try {
  await runMigrations(sql, migrationsDirectory);
} finally {
  await sql.end();
}
