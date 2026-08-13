import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';
import {
  SETUP_TIMEOUT_MS,
  adminUrl,
  migrationsDirectory,
} from './support/invariant-db.js';

/**
 * Foreign keys must be indexable, and that must stay true.
 *
 * Migration 0046 audited the schema for "foreign keys with no usable
 * index" and created the seven indexes that audit called for. The audit
 * was a one-off: nothing has re-run it since, so an FK added by a later
 * migration is unindexed until somebody happens to look again. Every
 * delete or key update on the parent then takes a sequential scan of the
 * child, and so does an ordinary lookup by the parent id.
 *
 * This test is that audit, standing. The rule is 0046's own, stated in its
 * comments: an FK is covered when some index LEADS with the FK's leading
 * columns. A two-column index over a three-column FK counts — 0046 created
 * `work_items_schedule_idx` on exactly that basis, noting the remaining
 * equality is "a cheap recheck on the fetched row". A partial index does
 * not count, because referential integrity cannot use one.
 *
 * The twenty-eight foreign keys 0046 left uncovered are recorded below as
 * a frozen baseline. The point of the baseline is direction: the list may
 * shrink, never grow. A new unindexed FK fails this test, and removing an
 * entry after adding its index is the intended way to shorten it.
 */

/**
 * `table(column, ...)` for every FK that has no leading index today.
 *
 * These are pre-existing, and this test deliberately does not re-litigate
 * them one by one — the 0046 audit is the record of that judgement. What
 * it does is stop the set from growing.
 */
const UNINDEXED_BASELINE: readonly string[] = [
  'bills(organisation_id, mb_id)',
  'budgetary_quotations(organisation_id, customer_contact_id)',
  'challan_item_serials(organisation_id, delivery_challan_item_id)',
  'correction_notices(organisation_id, approval_request_id)',
  'correction_notices(organisation_id, delivery_challan_id, work_id)',
  'delivery_challan_items(organisation_id, delivery_challan_id, work_id)',
  'delivery_challan_items(organisation_id, purchase_order_line_id)',
  'delivery_challan_items(organisation_id, work_item_id, work_id)',
  'delivery_challans(organisation_id, replaces_challan_id)',
  'installations(organisation_id, location_id)',
  'installations(organisation_id, work_item_id, work_id)',
  'issue_challan_lines(organisation_id, issue_challan_id, work_id)',
  'issue_challan_lines(organisation_id, work_item_id, work_id)',
  'issue_challans(organisation_id, replaces_issue_challan_id)',
  'loa_documents(organisation_id, parent_loa_document_id)',
  'mb_entries(organisation_id, bill_id)',
  'mb_entries(organisation_id, work_id)',
  'mb_entries(organisation_id, work_item_id, work_id)',
  'measurement_book_merge_provenance(organisation_id, work_id)',
  'measurement_books(organisation_id, consignee_contact_id)',
  'measurement_books(organisation_id, merged_into_id)',
  'pac_certificates(organisation_id, consignee_master_id)',
  'purchase_order_lines(organisation_id, work_item_id)',
  'purchase_orders(organisation_id, vendor_contact_id)',
  'tax_invoices(organisation_id, buyer_contact_id)',
  'tax_invoices(organisation_id, measurement_book_id)',
  'tax_invoices(organisation_id, ship_to_contact_id)',
  'work_items(organisation_id, source_approval_id)',
];

interface ForeignKey {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly columns: string[];
}

interface IndexRow {
  readonly table_name: string;
  readonly index_name: string;
  readonly columns: string[] | null;
  readonly partial: boolean;
}

function label(table: string, columns: readonly string[]): string {
  return `${table}(${columns.join(', ')})`;
}

/** 0046's rule: some non-partial index leads with the FK's leading
 * columns. At least two of them must match where the FK has two or more,
 * so an index on organisation_id alone — which every tenant table has —
 * never counts as covering a tenant-scoped FK. */
function covered(fk: ForeignKey, indexes: readonly IndexRow[]): boolean {
  const required = Math.min(2, fk.columns.length);
  return indexes.some((index) => {
    if (index.partial || index.columns === null) return false;
    const shared = Math.min(index.columns.length, fk.columns.length);
    if (shared < required) return false;
    for (let position = 0; position < shared; position += 1) {
      if (index.columns[position] !== fk.columns[position]) return false;
    }
    return true;
  });
}

let admin: Sql;
let foreignKeys: ForeignKey[];
let indexesByTable: Map<string, IndexRow[]>;

// Catalog reads only, so this suite uses the development database rather
// than creating one of its own: a full migration run per suite is what
// starves this package under parallel execution.
beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-fk-index-admin',
  });
  await admin`select 1 as ready`;
  await runMigrations(admin, migrationsDirectory);

  foreignKeys = await admin<ForeignKey[]>`
    select con.conrelid::regclass::text as table_name,
           con.conname as constraint_name,
           (select array_agg(att.attname order by key.ord)
              from unnest(con.conkey) with ordinality as key(attnum, ord)
              join pg_attribute att
                on att.attrelid = con.conrelid and att.attnum = key.attnum)
             as columns
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f' and n.nspname = 'public'
    order by 1, 2
  `;

  const indexes = await admin<IndexRow[]>`
    select i.indrelid::regclass::text as table_name,
           ic.relname as index_name,
           (select array_agg(att.attname order by key.ord)
              from unnest(i.indkey::int2[]) with ordinality as key(attnum, ord)
              join pg_attribute att
                on att.attrelid = i.indrelid and att.attnum = key.attnum)
             as columns,
           i.indpred is not null as partial
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_class ic on ic.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
  `;
  indexesByTable = new Map();
  for (const index of indexes) {
    const existing = indexesByTable.get(index.table_name) ?? [];
    existing.push(index);
    indexesByTable.set(index.table_name, existing);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await admin?.end();
}, SETUP_TIMEOUT_MS);

describe('foreign-key index coverage', () => {
  it('reads a non-empty catalog', () => {
    expect(foreignKeys.length).toBeGreaterThan(100);
    expect(indexesByTable.size).toBeGreaterThan(40);
  });

  it('proves the seven indexes 0046 created still cover their foreign keys', () => {
    // If any of these regressed, the baseline below would grow and the
    // next test would catch it — but naming them keeps the link to the
    // audit that created them.
    for (const name of [
      'challan_item_serials(organisation_id, delivery_challan_id, work_id)',
      'work_items(organisation_id, schedule_id, work_id)',
      'installation_serials(organisation_id, challan_item_serial_id, work_id)',
      'eway_bills(organisation_id, tax_invoice_id)',
      'measurement_book_merge_provenance(organisation_id, record_measurement_book_id)',
      'loa_documents(organisation_id, confirmed_work_id)',
      'mb_entries(organisation_id, delivery_challan_id, work_id)',
    ]) {
      const fk = foreignKeys.find(
        (candidate) => label(candidate.table_name, candidate.columns) === name,
      );
      expect(fk, `${name} is no longer a foreign key`).toBeDefined();
      if (!fk) continue;
      expect(covered(fk, indexesByTable.get(fk.table_name) ?? []), name).toBe(true);
    }
  });

  it('adds no foreign key without a leading index', () => {
    const uncovered = foreignKeys
      .filter((fk) => !covered(fk, indexesByTable.get(fk.table_name) ?? []))
      .map((fk) => label(fk.table_name, fk.columns))
      .sort();
    const added = uncovered.filter((entry) => !UNINDEXED_BASELINE.includes(entry));
    expect(
      added,
      `foreign keys with no index leading on their columns: ${added.join(', ')}. ` +
        'Create an index leading with the referencing columns (every one in ' +
        'this schema leads with organisation_id, matching the RLS predicate), ' +
        'or record the key in UNINDEXED_BASELINE with the reason it is safe.',
    ).toEqual([]);
  });

  it('keeps the baseline shrinking, never growing', () => {
    const uncovered = new Set(
      foreignKeys
        .filter((fk) => !covered(fk, indexesByTable.get(fk.table_name) ?? []))
        .map((fk) => label(fk.table_name, fk.columns)),
    );
    const fixed = UNINDEXED_BASELINE.filter((entry) => !uncovered.has(entry));
    expect(
      fixed,
      `these foreign keys are now indexed; delete them from ` +
        `UNINDEXED_BASELINE so the list keeps meaning what it says: ${fixed.join(', ')}`,
    ).toEqual([]);
  });
});
