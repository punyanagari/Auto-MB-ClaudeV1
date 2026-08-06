import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(here, '..', 'migrations', '0001_core.sql');
const tenantTables = [
  'organisations',
  'organisation_memberships',
  'works',
  'work_schedules',
  'work_items',
  'loa_documents',
  'delivery_challans',
  'delivery_challan_items',
  'delivery_challan_counters',
  'audit_events',
];

describe('tenant migration contract', () => {
  it('enables and forces RLS on every tenant table', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    for (const table of tenantTables) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }
  });

  it('keeps audit events append-only for the application role', async () => {
    const guardrail = await readFile(
      path.resolve(here, '..', 'migrations', '0002_rls_guardrails.sql'),
      'utf8',
    );
    expect(guardrail).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON audit_events');
  });

  it('enforces one draft Delivery Challan per Work in the database', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('CREATE UNIQUE INDEX delivery_challans_one_draft_per_work');
    expect(sql).toContain("WHERE status = 'draft'");
  });
});
