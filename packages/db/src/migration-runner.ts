import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const FORBIDDEN_TRANSACTION_CONTROL = /^\s*(begin|commit|rollback)\b.*;?\s*$/im;

function stripDollarQuotedBodies(input: string): string {
  let output = '';
  let index = 0;

  while (index < input.length) {
    if (input[index] !== '$') {
      output += input[index];
      index += 1;
      continue;
    }

    const remainder = input.slice(index);
    const tag = remainder.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (!tag) {
      output += input[index];
      index += 1;
      continue;
    }

    const end = input.indexOf(tag, index + tag.length);
    if (end === -1)
      throw new Error(`unterminated dollar-quoted body beginning at byte ${index}`);

    output += ' '.repeat(end + tag.length - index);
    index = end + tag.length;
  }

  return output;
}

function transactionControlSurface(input: string): string {
  return stripDollarQuotedBodies(input)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '');
}

export interface MigrationFile {
  readonly id: string;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly sql: string;
}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  const migrations: MigrationFile[] = [];

  for (const fileName of names) {
    const absolutePath = path.join(directory, fileName);
    const sql = await readFile(absolutePath, 'utf8');
    if (FORBIDDEN_TRANSACTION_CONTROL.test(transactionControlSurface(sql))) {
      throw new Error(`${fileName}: top-level transaction control is forbidden`);
    }
    migrations.push({
      id: fileName.slice(0, 4),
      fileName,
      absolutePath,
      sha256: createHash('sha256').update(sql).digest('hex'),
      sql,
    });
  }

  if (migrations.length === 0) throw new Error(`No migrations found in ${directory}`);
  return migrations;
}

export async function runMigrations(sql: Sql, directory: string): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      id text primary key,
      file_name text not null unique,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = await sql<{ id: string; sha256: string }[]>`
    select id, sha256 from schema_migrations order by id
  `;
  const appliedById = new Map(applied.map((row) => [row.id, row.sha256]));

  for (const migration of await readMigrations(directory)) {
    const recordedHash = appliedById.get(migration.id);
    if (recordedHash !== undefined) {
      if (recordedHash !== migration.sha256) {
        throw new Error(`${migration.fileName}: applied migration hash changed`);
      }
      continue;
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx`
        insert into schema_migrations (id, file_name, sha256)
        values (${migration.id}, ${migration.fileName}, ${migration.sha256})
      `;
    });
    console.log(`applied ${migration.fileName}`);
  }
}
