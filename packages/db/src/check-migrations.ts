import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrations } from './migration-runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(here, '..', 'migrations');
const migrations = await readMigrations(directory);

const ids = new Set<string>();
for (const migration of migrations) {
  if (ids.has(migration.id)) throw new Error(`duplicate migration id: ${migration.id}`);
  ids.add(migration.id);
}

console.log(`validated ${migrations.length} migration files`);
