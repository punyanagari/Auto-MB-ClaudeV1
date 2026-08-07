import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrations } from './migration-runner.js';

// readMigrations enforces filename shape, forbidden transaction control, and
// duplicate ids; this entry point exists so CI can run those checks without
// a database.
const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(here, '..', 'migrations');
const migrations = await readMigrations(directory);

console.log(`validated ${migrations.length} migration files`);
