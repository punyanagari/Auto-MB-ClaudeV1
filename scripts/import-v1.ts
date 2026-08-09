/**
 * Auto-MB v1 legacy-data cutover importer — repo-level entry point.
 *
 *   pnpm exec tsx scripts/import-v1.ts --backup <sqlite> \
 *     --mapping scripts/import-v1.mapping.json --mode dry-run|apply
 *
 * ARCHITECTURE NOTE: the engine lives in apps/server/src/import/ — it is
 * an operational orchestrator of database writes that reuses the server's
 * issued-snapshot shapes (challan-html.ts), so the server module owns the
 * logic and this file stays a thin shell that runs under tsx from the
 * repo root. check-architecture.mjs allows this: its boundaries forbid
 * apps/web importing @auto-mb/db and packages/loa-parser importing any
 * workspace package; an operational script delegating INTO apps/server
 * crosses neither line, and no new package is created for a single
 * consumer (AGENTS.md).
 */
import process from 'node:process';
import { runImportCli } from '../apps/server/src/import/cli.js';

process.exitCode = await runImportCli(process.argv.slice(2), process.env);
