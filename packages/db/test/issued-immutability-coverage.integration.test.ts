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
 * Immutability coverage: no column may be added to a guarded table without
 * a decision being recorded about it.
 *
 * The issued-document guards freeze business facts by comparing a ROW of
 * NEW columns against the same ROW of OLD columns. That list is written by
 * hand in the migration, which makes it a DENYLIST: a column added later
 * and not added to the list is silently mutable on an issued document. It
 * has already happened once — `tax_invoices.reverse_charge_applicable`
 * (0044) went in without joining the freeze and needed its own trigger
 * afterwards.
 *
 * This suite closes that shape. For every table whose triggers compare any
 * column for change, it derives the frozen set FROM THE DATABASE (the
 * function bodies as PostgreSQL stores them, not the migration text) and
 * requires
 *
 *     frozen  ∪  declared-mutable  ≡  the table's columns
 *
 * with the two sides disjoint. A new column is therefore a test failure
 * until somebody writes it into the freeze or names it here as mutable —
 * which is the decision that was previously skippable.
 *
 * Behavioural immutability itself is proved elsewhere and is not repeated
 * here: `apps/server/test/finding47-parent-immutability.integration.test.ts`
 * and the 0052/0057 suites attack the guards with raw SQL. What is proved
 * here is COVERAGE, and the last test proves the coverage rule itself is
 * not vacuous by putting an unknown column through it.
 *
 * Every read below is a catalog read, so this suite runs against the
 * development database rather than creating one of its own — a full
 * migration run per suite is what starves this package under parallel
 * execution.
 */

/**
 * Columns that may legitimately change after the row is written, per
 * table. Everything else must be compared for change by a trigger.
 *
 * Three recurring groups appear throughout:
 *
 *   surrogate/timestamp — `id` is the primary key (a changed primary key
 *     is a different row, and the FKs that reference it refuse the move);
 *     `updated_at` is maintained by `touch_updated_at`.
 *   lifecycle — `status` moves through a state machine that each table's
 *     own guard polices arm by arm, and the cancellation evidence written
 *     alongside it (`cancelled_at`, `cancelled_by_user_id`,
 *     `cancellation_note`) is written exactly once at cancel time, held
 *     coherent by a CHECK, and frozen thereafter where the table freezes
 *     it.
 *   render pointers — `template_version`, `rendered_object_key`,
 *     `rendered_sha256` and the signed-copy pair are written AFTER the
 *     document is issued, because rendering and uploading a signed copy
 *     happen after issue. They are evidence about the document, not facts
 *     of it.
 */
const DECLARED_MUTABLE: Record<string, readonly string[]> = {
  // The amendment decision ledger: everything proposed is frozen, the
  // decision is what gets written.
  approval_requests: [
    'id',
    'status',
    'decided_by_user_id',
    'decided_at',
    'decision_note',
  ],

  // A recorded receipt of money (0067). Every fact of it is frozen the
  // moment it is written — there is no edit path at all — and the only
  // later act is the void, which is the three columns below plus the
  // maintained timestamp.
  bill_payments: ['id', 'updated_at', 'voided_at', 'voided_by_user_id', 'void_reason'],

  // The legacy bill record (0006). Its money and lines snapshot are
  // frozen; submission and payment are the two later facts.
  bills: ['id', 'status', 'submitted_at', 'paid_at'],

  // 0045 froze the budgetary quotation whole once it is not a draft:
  // nothing but the maintained timestamp is outside the freeze.
  budgetary_quotations: ['updated_at'],

  correction_notices: [
    'id',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    'rendered_object_key',
    'rendered_sha256',
  ],

  credit_notes: [
    'id',
    'updated_at',
    'status',
    // The recipient's ITC reversal is confirmed after the note is issued —
    // it is a fact about the counterparty, not about the document.
    'recipient_itc_status',
    'template_version',
    'rendered_object_key',
    'rendered_sha256',
  ],

  // created_at is outside this table's freeze, unlike tax_invoices and
  // credit_notes, which do freeze it. It is set by DEFAULT now() and never
  // written by the product; recorded here so the difference is visible
  // rather than accidental.
  delivery_challans: [
    'id',
    'created_at',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    'rendered_object_key',
    'rendered_sha256',
    'signed_copy_object_key',
    'signed_copy_sha256',
  ],

  // The render pointer (0076) moves every time the printable summary is
  // regenerated, exactly as it does on delivery_challans and credit_notes
  // above: the PDF is a convenience print of frozen facts, so reprinting
  // one changes which bytes the pointer names and nothing that NIC said.
  eway_bills: [
    'id',
    'updated_at',
    'status',
    'rendered_object_key',
    'rendered_sha256',
    'rendered_version',
  ],

  extension_requests: [
    'id',
    'updated_at',
    'status',
    'rendered_object_key',
    'rendered_sha256',
  ],

  installations: [
    'id',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
  ],

  // The serial released when its installation is cancelled: the release
  // itself is frozen by the guard, so only the key is outside it.
  installation_serials: ['id'],

  // Same created_at note as delivery_challans.
  issue_challans: [
    'id',
    'created_at',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    'rendered_object_key',
    'rendered_sha256',
    'signed_copy_object_key',
    'signed_copy_sha256',
  ],

  // The uploaded contract source document: object key, digest, extraction
  // payload and signature verdict are all frozen by 0040/0055/0060.
  loa_documents: ['id', 'created_at', 'updated_at'],

  // The claim a measurement book draws a source from; the release is
  // inside the freeze.
  mb_sources: ['id'],

  // A finalized measurement book freezes its number, date, kind and total.
  // consignee_contact_id, merged_into_id and is_final sit outside that
  // freeze: the first two are set as part of the merge the book takes
  // part in and the third marks the closing book of a Work, and all three
  // are written by routes that check the book's state themselves rather
  // than by a trigger.
  //
  // The three railway-closure columns 0066 adds are deliberately NOT here:
  // the restated guard compares them, so closure is append-once in the
  // database and not merely in the route that writes it.
  measurement_books: [
    'id',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    'template_version',
    'rendered_object_key',
    'rendered_sha256',
    'consignee_contact_id',
    'merged_into_id',
    'is_final',
  ],

  pac_certificates: [
    'id',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    // The scanned certificate is attached after the record is created.
    'document_object_key',
    'document_sha256',
  ],

  // 0045 froze the purchase order whole once it is not a draft.
  purchase_orders: ['updated_at'],

  // The railway's own On-Account Bill (0066). Its bytes and every fact
  // extracted from them are frozen by
  // `guard_received_railway_bill_update`, and its signature verdict by
  // 0060's append-once function reused verbatim. What is left is the
  // discard evidence — written once when a bill turns out to be attached
  // to the wrong Measurement Book, and made terminal by the same guard.
  received_railway_bills: [
    'id',
    'updated_at',
    'discarded_at',
    'discarded_by_user_id',
    'discard_reason',
  ],

  // The provider attempt ledger (0041): the request is frozen at start,
  // and the outcome is the append that closes it.
  statutory_provider_operations: [
    'id',
    'status',
    'provider_code',
    'http_status',
    'completed_at',
  ],

  tax_invoices: [
    'id',
    'updated_at',
    'status',
    'template_version',
    'rendered_object_key',
    'rendered_sha256',
  ],

  // Not an issued document: a PBG/security instrument whose STATUS is the
  // guarded fact (0008 refuses any transition out of a non-active state).
  // Its fields stay editable while it is live, so the whole row is
  // declared mutable and the state machine is the invariant.
  work_instruments: [
    'id',
    'organisation_id',
    'work_id',
    'kind',
    'reference',
    'amount',
    'issued_on',
    'expires_on',
    'notes',
    'created_by_user_id',
    'created_at',
    'updated_at',
  ],

  // Not an issued document either: the contract line. 0012 freezes the
  // AWARDED baseline (awarded_quantity, effective_rate, amendment_added,
  // the approval that moved it) so an amendment cannot rewrite history;
  // everything else is amendable master data, and 0030 polices the floors
  // that the amendable columns must respect.
  work_items: [
    'id',
    'schedule_id',
    'item_number',
    'description',
    'unit_code',
    'requires_serials',
    'payment_category',
    'source_evidence',
    'updated_at',
    'deleted_at',
    'effective_quantity',
    'effective_unit_rate',
    'effective_description',
    'effective_unit',
    'hsn_code',
    'gst_rate',
    'is_service',
    'advertised_rate',
    // Derived, and mutable precisely because it is derived: the 0077
    // trigger recomputes it on every write of this row, so it tracks the
    // installed total rather than recording a decision anyone made. It
    // carries no contract fact that freezing could protect — and freezing
    // it would freeze the recomputation itself.
    'pending_variation',
  ],

  // The Work itself. 0031 freezes the completion and reopen evidence and
  // 0011 the completion dates; the contract header stays editable, which
  // is what the amendment and review flows exist to do.
  works: [
    'id',
    'organisation_id',
    'work_code',
    'letter_number',
    'letter_date',
    'title',
    'advertised_value',
    'contract_value',
    'pricing_shape',
    'letter_percentage',
    'letter_percentage_direction',
    'allow_excess_delivery',
    'status',
    'created_by_user_id',
    'created_at',
    'updated_at',
    'deleted_at',
    'pbg_required_amount',
    'pbg_submission_days',
    'pbg_extension_days',
    'pbg_penal_interest_percent',
    'pbg_requirement_source',
    'gst_basis',
    'gst_rate',
  ],

  // A supersession record (0071) is written whole when a Work is
  // withdrawn, and admits exactly two later facts, mutually exclusive and
  // each written once: the Work that replaced it, or the discarding of the
  // letter that would have produced one. Both are bind-once, and the guard
  // freezes each the moment it stops being NULL — exactly as
  // `approval_requests.entity_id` is bound once by an approved apply —
  // which is why neither appears here. Nothing but the maintained
  // timestamp is outside the freeze.
  work_supersessions: ['updated_at'],
};

/**
 * Columns a trigger compares for change, read out of the stored function
 * body: the `ROW(NEW...) IS DISTINCT FROM ROW(OLD...)` freezes plus the
 * scalar `NEW.x IS DISTINCT FROM OLD.x` form some guards use for a single
 * column.
 */
function frozenColumns(definition: string): Set<string> {
  const found = new Set<string>();
  const rowBlock = /ROW\s*\(([\s\S]*?)\)\s*\r?\n?\s*IS DISTINCT FROM\s*ROW\s*\(/gi;
  for (const block of definition.matchAll(rowBlock)) {
    for (const column of (block[1] ?? '').matchAll(/\bNEW\.([a-z_][a-z0-9_]*)/gi)) {
      found.add((column[1] ?? '').toLowerCase());
    }
  }
  const scalar =
    /\bNEW\.([a-z_][a-z0-9_]*)\s+IS DISTINCT FROM\s+OLD\.([a-z_][a-z0-9_]*)/gi;
  for (const match of definition.matchAll(scalar)) {
    const left = (match[1] ?? '').toLowerCase();
    const right = (match[2] ?? '').toLowerCase();
    if (left === right) found.add(left);
  }
  return found;
}

interface TriggerRow {
  readonly table_name: string;
  readonly definition: string;
}

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
}

async function readFrozen(pool: Sql): Promise<Map<string, Set<string>>> {
  const triggers = await pool<TriggerRow[]>`
    select c.relname as table_name, pg_get_functiondef(p.oid) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and n.nspname = 'public'
      and (t.tgtype & 1) <> 0 and (t.tgtype & 2) <> 0 and (t.tgtype & 16) <> 0
  `;
  const byTable = new Map<string, Set<string>>();
  for (const trigger of triggers) {
    const frozen = frozenColumns(trigger.definition);
    if (frozen.size === 0) continue;
    const existing = byTable.get(trigger.table_name) ?? new Set<string>();
    for (const column of frozen) existing.add(column);
    byTable.set(trigger.table_name, existing);
  }
  return byTable;
}

async function readColumns(pool: Sql): Promise<Map<string, string[]>> {
  const rows = await pool<ColumnRow[]>`
    select c.relname as table_name, a.attname as column_name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `;
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byTable.get(row.table_name) ?? [];
    existing.push(row.column_name);
    byTable.set(row.table_name, existing);
  }
  return byTable;
}

/** Everything a guarded table's columns are judged against, for one
 * table: what a trigger compares for change, and what is declared free. */
function uncoveredColumns(
  catalog: readonly string[],
  frozenHere: ReadonlySet<string>,
  declared: readonly string[],
): string[] {
  return catalog.filter(
    (column) => !frozenHere.has(column) && !declared.includes(column),
  );
}

let admin: Sql;
let frozen: Map<string, Set<string>>;
let columns: Map<string, string[]>;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-immutability-admin',
  });
  await admin`select 1 as ready`;
  await runMigrations(admin, migrationsDirectory);
  frozen = await readFrozen(admin);
  columns = await readColumns(admin);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await admin?.end();
}, SETUP_TIMEOUT_MS);

describe('issued-document immutability coverage', () => {
  it('reads a non-empty freeze out of the database', () => {
    // A regex that stopped matching would make every assertion below pass
    // vacuously; these two are the canary.
    expect(frozen.size).toBeGreaterThanOrEqual(20);
    expect([...(frozen.get('tax_invoices') ?? [])]).toEqual(
      expect.arrayContaining([
        'taxable_value',
        'invoice_number',
        'reverse_charge_applicable',
      ]),
    );
  });

  it('declares every table whose triggers freeze a column, and no others', () => {
    const discovered = [...frozen.keys()].sort();
    const declared = Object.keys(DECLARED_MUTABLE).sort();
    const undeclared = discovered.filter((table) => !declared.includes(table));
    const stale = declared.filter((table) => !discovered.includes(table));
    expect(
      undeclared,
      `tables whose triggers freeze columns but that are absent from ` +
        `DECLARED_MUTABLE: ${undeclared.join(', ')}. Add each with the list of ` +
        'columns that may legitimately change after the row is written.',
    ).toEqual([]);
    expect(
      stale,
      `DECLARED_MUTABLE entries whose table no longer freezes anything: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it.each(Object.keys(DECLARED_MUTABLE).sort())(
    'accounts for every column of %s',
    (table) => {
      const catalog = columns.get(table);
      expect(catalog, `${table} is not a table in the database`).toBeDefined();
      const declared = DECLARED_MUTABLE[table] ?? [];
      const frozenHere = frozen.get(table) ?? new Set<string>();

      const unknown = declared.filter((column) => !(catalog ?? []).includes(column));
      expect(
        unknown,
        `${table}: DECLARED_MUTABLE names columns the table does not have: ${unknown.join(', ')}`,
      ).toEqual([]);

      const both = declared.filter((column) => frozenHere.has(column));
      expect(
        both,
        `${table}: declared mutable but frozen by a trigger: ${both.join(', ')}. ` +
          'One of the two statements is wrong.',
      ).toEqual([]);

      const uncovered = uncoveredColumns(catalog ?? [], frozenHere, declared);
      expect(
        uncovered,
        `${table}: neither frozen by a trigger nor declared mutable: ` +
          `${uncovered.join(', ')}. A column added to a guarded table has to be ` +
          'written into the freeze or named in DECLARED_MUTABLE — the denylist ' +
          'shape of the ROW guards means it is otherwise silently editable on ' +
          'an issued document.',
      ).toEqual([]);
    },
  );

  it('catches a column added to the most heavily guarded table', () => {
    // The proof that the rule is not fail-open, run through exactly the
    // comparison the per-table assertions use, with the real frozen set
    // and the real declaration for tax_invoices — only the catalog is
    // extended, by the column a future migration would add.
    const declared = DECLARED_MUTABLE.tax_invoices ?? [];
    const frozenHere = frozen.get('tax_invoices') ?? new Set<string>();
    const catalog = columns.get('tax_invoices') ?? [];
    expect(uncoveredColumns(catalog, frozenHere, declared)).toEqual([]);
    expect(
      uncoveredColumns([...catalog, 'coverage_probe'], frozenHere, declared),
    ).toEqual(['coverage_probe']);
  });
});
