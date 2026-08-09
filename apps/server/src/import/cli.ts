/**
 * CLI driver for the v1 legacy-data cutover importer. The thin
 * repo-level entry point (scripts/import-v1.ts) delegates here so every
 * workspace dependency resolves from apps/server, where the engine lives.
 *
 * Usage:
 *   pnpm exec tsx scripts/import-v1.ts \
 *     --backup /path/to/v1-backup.sqlite \
 *     --mapping scripts/import-v1.mapping.json \
 *     --mode dry-run|apply \
 *     [--database DATABASE_ADMIN_URL] [--note "operator note"]
 *
 * --database names the ENVIRONMENT VARIABLE holding the administrator
 * connection URL (default DATABASE_ADMIN_URL). The importer refuses to
 * run on a non-administrator connection; every schema guard and trigger
 * stays active. dry-run executes the whole pipeline in one transaction
 * and rolls it back, printing the same reconciliation report apply would.
 */
import { readFile } from 'node:fs/promises';
import { createDatabasePool } from '@auto-mb/db';
import { sha256Hex } from './canonical.js';
import { runV1Import } from './importer.js';
import { parseMappingConfig } from './mapping.js';
import { renderRunReport } from './report.js';
import { readV1Backup } from './v1-backup.js';

interface CliArguments {
  backup: string;
  mapping: string;
  mode: 'dry-run' | 'apply';
  databaseEnv: string;
  note?: string | undefined;
}

export function parseImportArguments(argv: string[]): CliArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      throw new Error(`unexpected argument ${String(flag)}; flags take one value each`);
    }
    values.set(flag.slice(2), value);
  }
  const backup = values.get('backup');
  const mapping = values.get('mapping');
  const mode = values.get('mode');
  if (!backup || !mapping || (mode !== 'dry-run' && mode !== 'apply')) {
    throw new Error(
      'required: --backup <sqlite file> --mapping <json file> --mode dry-run|apply',
    );
  }
  return {
    backup,
    mapping,
    mode,
    databaseEnv: values.get('database') ?? 'DATABASE_ADMIN_URL',
    note: values.get('note'),
  };
}

export async function runImportCli(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const args = parseImportArguments(argv);
  const adminUrl = env[args.databaseEnv];
  if (!adminUrl) {
    console.error(`environment variable ${args.databaseEnv} is not set`);
    return 2;
  }

  const backupBytes = await readFile(args.backup);
  const mappingText = await readFile(args.mapping, 'utf8');
  const mapping = parseMappingConfig(JSON.parse(mappingText));
  const inputDigest = sha256Hex(
    Buffer.concat([backupBytes, Buffer.from(mappingText, 'utf8')]),
  );
  const backup = readV1Backup(args.backup);

  const sql = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-import-v1',
  });
  try {
    const report = await runV1Import(sql, {
      backup,
      mapping,
      mode: args.mode,
      inputDigest,
      operatorNote: args.note,
    });
    console.log(renderRunReport(report));
    console.log('');
    console.log(JSON.stringify(report, null, 2));
    const exceptionCount =
      report.runExceptions.length +
      report.organisations.reduce((sum, org) => sum + org.exceptions.length, 0);
    console.log(
      `\n${args.mode} complete: ${String(report.organisations.length)} organisation(s), ` +
        `${String(exceptionCount)} exception(s)${args.mode === 'dry-run' ? ' — all changes rolled back' : ''}`,
    );
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
