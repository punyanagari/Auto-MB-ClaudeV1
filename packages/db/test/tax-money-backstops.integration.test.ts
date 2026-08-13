import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';

// These tests prove the database-level tax-invoice MONEY backstops
// introduced by migration 0052 (12 August 2026 security review): the tax
// heads must reconcile with the GST rate, and the CGST+SGST/IGST split
// must match the place of supply against the organisation's state. Both
// rules previously lived only in the submit route; every write here is
// raw SQL — the exact writer class the triggers exist to bind.
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';

const here = path.dirname(fileURLToPath(import.meta.url));
const realMigrationsDirectory = path.resolve(here, '..', 'migrations');

const TEST_TIMEOUT_MS = 120_000;
const STAGED_TIMEOUT_MS = 180_000;

let admin: Sql;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-tax-money-admin',
  });
  await admin`select 1 as ready`;
});

afterAll(async () => {
  try {
    // Sweep databases leaked by a crashed earlier run; the per-test
    // finally cannot help when the process itself was killed.
    const stale = await admin<{ datname: string }[]>`
      select datname from pg_database
      where datname like 'auto_mb_tax_money_test_%'
    `;
    for (const database of stale) {
      await admin.unsafe(`drop database if exists ${database.datname} with (force)`);
    }
  } finally {
    await admin?.end();
  }
}, STAGED_TIMEOUT_MS);

interface TemporaryDatabase {
  readonly name: string;
  readonly pool: Sql;
}

async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const name = `auto_mb_tax_money_test_${randomBytes(6).toString('hex')}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    name,
    pool: createDatabasePool({
      url: url.toString(),
      max: 4,
      applicationName: 'auto-mb-tax-money-test',
    }),
  };
}

async function dropTemporaryDatabase(database: TemporaryDatabase): Promise<void> {
  try {
    await database.pool.end({ timeout: 5 });
  } catch {
    // A wedged pool must not stop the drop below; `with (force)`
    // terminates whatever the pool left behind.
  }
  await admin.unsafe(`drop database if exists ${database.name} with (force)`);
}

/** Copies the migrations whose four-digit id is at most `throughId`. */
async function stageMigrations(directory: string, throughId: string): Promise<void> {
  const names = (await readdir(realMigrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names.filter((name) => name.slice(0, 4) <= throughId)) {
    await copyFile(
      path.join(realMigrationsDirectory, name),
      path.join(directory, name),
    );
  }
}

interface Tenant {
  readonly organisationId: string;
  readonly buyerId: string;
}

/** One organisation in state 27 with a client contact and the notified
 * rates a direct invoice in these tests needs (18% and nil). Each call is
 * independent, so tests never contend for the same rows. */
async function seedTenant(
  pool: Sql,
  options: { readonly stateCode?: string | null } = {},
): Promise<Tenant> {
  const suffix = randomBytes(4).toString('hex');
  const stateCode = options.stateCode === undefined ? '27' : options.stateCode;
  const [organisation] = await pool<{ id: string }[]>`
    insert into organisations (name, slug, state_code)
    values (${`Tax money tenant ${suffix}`}, ${`tax-money-${suffix}`}, ${stateCode})
    returning id
  `;
  if (!organisation) throw new Error('organisation seed failed');
  const [buyer] = await pool<{ id: string }[]>`
    insert into contacts (
      organisation_id, designation, address, gstin, pincode, state_code,
      is_client, created_by_user_id
    )
    values (
      ${organisation.id}, 'Tax Money Buyer', 'Buyer address',
      '27AAAGM0289C1ZL', '400001', '27', true, 'tax-money-test'
    )
    returning id
  `;
  if (!buyer) throw new Error('buyer seed failed');
  await pool`
    insert into gst_rates (
      organisation_id, rate, label, effective_from, created_by_user_id
    )
    values
      (${organisation.id}, '18.00', 'Standard 18%', '2017-07-01', 'tax-money-test'),
      (${organisation.id}, '0.00', 'Nil-rated', '2017-07-01', 'tax-money-test')
  `;
  return { organisationId: organisation.id, buyerId: buyer.id };
}

interface Money {
  readonly gstRate: string;
  readonly placeOfSupply: string;
  readonly taxable: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
  readonly roundOff: string;
  readonly total: string;
}

let sequence = 0;

/** The exact write a compromised or buggy application-side caller would
 * make: a direct SUBMITTED invoice, straight SQL, no route in between —
 * shaped to satisfy every pre-0052 constraint (draft shape, split
 * coherence, total reconciliation, whole-rupee total, gst_rates cover) so
 * that only the 0052 backstops can refuse it. */
function submittedInvoice(pool: Sql, tenant: Tenant, money: Money): Promise<unknown> {
  sequence += 1;
  return pool`
    insert into tax_invoices (
      organisation_id, status, invoice_number, sequence_number, fy_label,
      invoice_date, sac_code, service_description, gst_rate, place_of_supply,
      buyer_contact_id, buyer_snapshot, stated_taxable_value, taxable_value,
      cgst_amount, sgst_amount, igst_amount, round_off, total_amount,
      issued_snapshot, reverse_charge_applicable,
      submitted_at, submitted_by_user_id, created_by_user_id
    )
    values (
      ${tenant.organisationId}, 'submitted',
      ${`TI/BACKSTOP/${randomBytes(4).toString('hex')}/${String(sequence)}`},
      ${sequence}, '2025-26', '2026-02-15', '998734',
      'Tax money backstop raw-SQL proof', ${money.gstRate},
      ${money.placeOfSupply}, ${tenant.buyerId},
      ${pool.json({ designation: 'Tax Money Buyer' })},
      ${money.taxable}, ${money.taxable},
      ${money.cgst}, ${money.sgst}, ${money.igst},
      ${money.roundOff}, ${money.total},
      ${pool.json({ templateVersion: 'backstop-test', supplier: { stateCode: '27' } })},
      false, now(), 'tax-money-test', 'tax-money-test'
    )
  `;
}

interface RefusedWrite {
  readonly code: string | undefined;
  readonly message: string;
}

/** Awaits a write that must be refused, returning SQLSTATE and message. */
async function refused(write: Promise<unknown>): Promise<RefusedWrite> {
  const outcome = await write.then(
    (value: unknown) => value,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) {
    throw new Error('the write was accepted, but it should have been refused');
  }
  const failure = outcome as Error & { code?: unknown };
  return {
    code: typeof failure.code === 'string' ? failure.code : undefined,
    message: failure.message,
  };
}

describe('tax invoice money backstops (0052 triggers)', () => {
  let database: TemporaryDatabase;
  let pool: Sql;

  beforeAll(async () => {
    database = await createTemporaryDatabase();
    pool = database.pool;
    await runMigrations(pool, realMigrationsDirectory);
  }, STAGED_TIMEOUT_MS);

  // Draining the pool and force-dropping the temporary database can
  // exceed the 10s default hook budget under a fully parallel suite run;
  // same explicit budget as the staged setup.
  afterAll(async () => {
    await dropTemporaryDatabase(database);
  }, STAGED_TIMEOUT_MS);

  it('refuses a submitted 18% invoice carrying zero tax heads', async () => {
    const tenant = await seedTenant(pool);
    // Before 0052 this row passed every CHECK: split coherence holds
    // (igst = 0), and the total faithfully re-adds the wrong parts.
    const refusal = await refused(
      submittedInvoice(pool, tenant, {
        gstRate: '18.00',
        placeOfSupply: '27',
        taxable: '100.00',
        cgst: '0.00',
        sgst: '0.00',
        igst: '0.00',
        roundOff: '0.00',
        total: '100.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('do not reconcile');
  });

  it('accepts a correct intra-state split', async () => {
    const tenant = await seedTenant(pool);
    await submittedInvoice(pool, tenant, {
      gstRate: '18.00',
      placeOfSupply: '27',
      taxable: '100.00',
      cgst: '9.00',
      sgst: '9.00',
      igst: '0.00',
      roundOff: '0.00',
      total: '118.00',
    });
  });

  it('accepts a correct inter-state IGST invoice', async () => {
    const tenant = await seedTenant(pool);
    await submittedInvoice(pool, tenant, {
      gstRate: '18.00',
      placeOfSupply: '29',
      taxable: '100.00',
      cgst: '0.00',
      sgst: '0.00',
      igst: '18.00',
      roundOff: '0.00',
      total: '118.00',
    });
  });

  it('refuses an inter-state invoice carrying a CGST/SGST split', async () => {
    const tenant = await seedTenant(pool);
    // The amount is right (18.00 in total), so the heads guard passes;
    // only the 0052 split-placement guard can see the heads are wrong —
    // the 0035 coherence CHECK accepts this shape as a plausible
    // intra-state split.
    const refusal = await refused(
      submittedInvoice(pool, tenant, {
        gstRate: '18.00',
        placeOfSupply: '29',
        taxable: '100.00',
        cgst: '9.00',
        sgst: '9.00',
        igst: '0.00',
        roundOff: '0.00',
        total: '118.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('inter-state supply');
  });

  it('refuses an intra-state invoice carrying IGST', async () => {
    const tenant = await seedTenant(pool);
    const refusal = await refused(
      submittedInvoice(pool, tenant, {
        gstRate: '18.00',
        placeOfSupply: '27',
        taxable: '100.00',
        cgst: '0.00',
        sgst: '0.00',
        igst: '18.00',
        roundOff: '0.00',
        total: '118.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('intra-state supply');
  });

  it('accepts a rate-0 invoice with zero heads', async () => {
    const tenant = await seedTenant(pool);
    await submittedInvoice(pool, tenant, {
      gstRate: '0.00',
      placeOfSupply: '27',
      taxable: '100.00',
      cgst: '0.00',
      sgst: '0.00',
      igst: '0.00',
      roundOff: '0.00',
      total: '100.00',
    });
  });

  it('accepts an off-by-a-paisa figure and refuses an off-by-two-rupees one', async () => {
    const tenant = await seedTenant(pool);
    // 18.01 against the expected 18.00: inside the one-rupee tolerance
    // that absorbs paisa-level rounding drift in imported history.
    await submittedInvoice(pool, tenant, {
      gstRate: '18.00',
      placeOfSupply: '27',
      taxable: '100.00',
      cgst: '9.01',
      sgst: '9.00',
      igst: '0.00',
      roundOff: '-0.01',
      total: '118.00',
    });
    // 20.00 against the expected 18.00: a materially wrong charge.
    const refusal = await refused(
      submittedInvoice(pool, tenant, {
        gstRate: '18.00',
        placeOfSupply: '27',
        taxable: '100.00',
        cgst: '10.00',
        sgst: '10.00',
        igst: '0.00',
        roundOff: '0.00',
        total: '120.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('do not reconcile');
  });

  it('refuses a money-carrying insert while the organisation has no state code', async () => {
    const tenant = await seedTenant(pool, { stateCode: null });
    // The split is undecidable without an organisation state; the trigger
    // fails closed exactly as the submit route's ORG_STATE_REQUIRED does.
    const refusal = await refused(
      submittedInvoice(pool, tenant, {
        gstRate: '18.00',
        placeOfSupply: '27',
        taxable: '100.00',
        cgst: '9.00',
        sgst: '9.00',
        igst: '0.00',
        roundOff: '0.00',
        total: '118.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('no GST state code');
  });

  it('still cancels an issued invoice after the organisation moved states', async () => {
    // The org state is mutable while issued invoices are frozen. A cancel
    // touches status only, so the frozen split must NOT be re-judged
    // against the new state — otherwise a legitimate cancel would wedge.
    const tenant = await seedTenant(pool);
    const id = randomUUID();
    await pool`
      insert into tax_invoices (
        id, organisation_id, status, invoice_number, sequence_number,
        fy_label, invoice_date, sac_code, service_description, gst_rate,
        place_of_supply, buyer_contact_id, buyer_snapshot,
        stated_taxable_value, taxable_value, cgst_amount, sgst_amount,
        igst_amount, round_off, total_amount, issued_snapshot,
        reverse_charge_applicable, submitted_at, submitted_by_user_id,
        created_by_user_id
      )
      values (
        ${id}, ${tenant.organisationId}, 'submitted', 'TI/BACKSTOP/CANCEL/1',
        901, '2025-26', '2026-02-15', '998734', 'Frozen-split cancel proof',
        '18.00', '27', ${tenant.buyerId},
        ${pool.json({ designation: 'Tax Money Buyer' })},
        '100.00', '100.00', '9.00', '9.00', '0.00', '0.00', '118.00',
        ${pool.json({ templateVersion: 'backstop-test', supplier: { stateCode: '27' } })},
        false, now(), 'tax-money-test', 'tax-money-test'
      )
    `;
    await pool`
      update organisations set state_code = '29'
      where id = ${tenant.organisationId}
    `;
    await pool`
      update tax_invoices
      set status = 'cancelled', cancelled_at = now(),
          cancelled_by_user_id = 'tax-money-test',
          cancellation_note = 'released for the frozen-split proof'
      where id = ${id}
    `;
    const [row] = await pool<{ status: string }[]>`
      select status from tax_invoices where id = ${id}
    `;
    expect(row?.status).toBe('cancelled');
  });
});

/** One line of a raw-SQL itemised invoice. */
interface RawLine {
  readonly quantity: string;
  readonly unitRate: string;
  readonly gstRate: string;
  readonly taxable: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
}

/**
 * The itemised equivalent of `submittedInvoice`: the exact write a
 * compromised or buggy caller would make against migration 0057's shape —
 * an itemised header (no SAC, no description, no header rate) over its
 * own lines, straight SQL, no route in between.
 *
 * One transaction, because the 0057 deferred constraint trigger judges
 * the invoice and its lines by the transaction's RESULT: the lines are
 * written and priced while the header is still a draft (the only window
 * the mutation guard leaves open), then the header moves to submitted.
 */
function submittedItemisedInvoice(
  pool: Sql,
  tenant: Tenant,
  options: {
    readonly placeOfSupply: string;
    readonly lines: readonly RawLine[];
    readonly taxable: string;
    readonly cgst: string;
    readonly sgst: string;
    readonly igst: string;
    readonly roundOff: string;
    readonly total: string;
  },
): Promise<unknown> {
  sequence += 1;
  const label = `TI/ITEMISED/${randomBytes(4).toString('hex')}/${String(sequence)}`;
  const ordinal = sequence;
  return pool.begin(async (tx) => {
    const [invoice] = await tx<{ id: string }[]>`
      insert into tax_invoices (
        organisation_id, status, line_shape, invoice_date, place_of_supply,
        buyer_contact_id, stated_taxable_value, reverse_charge_applicable,
        created_by_user_id
      )
      values (
        ${tenant.organisationId}, 'draft', 'itemised', '2026-02-15',
        ${options.placeOfSupply}, ${tenant.buyerId}, ${options.taxable}, false,
        'tax-money-test'
      )
      returning id
    `;
    if (!invoice) throw new Error('itemised invoice seed failed');
    let position = 0;
    for (const line of options.lines) {
      position += 1;
      await tx`
        insert into tax_invoice_lines (
          organisation_id, tax_invoice_id, position, is_service, hsn_sac_code,
          description, quantity, unit_label, unit_rate, gst_rate
        )
        values (
          ${tenant.organisationId}, ${invoice.id}, ${position}, false,
          '85444999', 'Raw SQL itemised line', ${line.quantity}, 'no',
          ${line.unitRate}, ${line.gstRate}
        )
      `;
      await tx`
        update tax_invoice_lines
        set taxable_value = ${line.taxable}, cgst_amount = ${line.cgst},
            sgst_amount = ${line.sgst}, igst_amount = ${line.igst}
        where tax_invoice_id = ${invoice.id} and position = ${position}
      `;
    }
    await tx`
      update tax_invoices
      set status = 'submitted', invoice_number = ${label},
          sequence_number = ${ordinal}, fy_label = '2025-26',
          number_prefix = 'TI',
          buyer_snapshot = ${tx.json({ designation: 'Tax Money Buyer' })},
          issued_snapshot = ${tx.json({
            templateVersion: 'ti-v2',
            supplier: { stateCode: '27' },
          })},
          taxable_value = ${options.taxable}, cgst_amount = ${options.cgst},
          sgst_amount = ${options.sgst}, igst_amount = ${options.igst},
          round_off = ${options.roundOff}, total_amount = ${options.total},
          submitted_at = now(), submitted_by_user_id = 'tax-money-test'
      where id = ${invoice.id}
    `;
    return invoice.id;
  });
}

/** `seedTenant` plus the 5% merit rate, so an itemised fixture can carry
 * two DIFFERENT per-line rates — which is the whole point of the shape,
 * and what the 0057 per-line rate guard is there to police. */
async function seedItemisedTenant(pool: Sql): Promise<Tenant> {
  const tenant = await seedTenant(pool);
  await pool`
    insert into gst_rates (
      organisation_id, rate, label, effective_from, created_by_user_id
    )
    values (${tenant.organisationId}, '5.00', 'Merit 5%', '2017-07-01',
            'tax-money-test')
  `;
  return tenant;
}

describe('itemised tax invoice money backstops (0057 triggers)', () => {
  let database: TemporaryDatabase;
  let pool: Sql;

  beforeAll(async () => {
    database = await createTemporaryDatabase();
    pool = database.pool;
    await runMigrations(pool, realMigrationsDirectory);
  }, STAGED_TIMEOUT_MS);

  afterAll(async () => {
    await dropTemporaryDatabase(database);
  }, STAGED_TIMEOUT_MS);

  // Two lines at DIFFERENT rates, which is what a header rate cannot
  // express: 2 x 50.00 at 18% (halves 9.00 / 9.00) and 1 x 100.00 at 5%
  // (halves 2.50 / 2.50). The header therefore carries 200.00 taxable
  // with 11.50 CGST and 11.50 SGST, and 223.00 lands on a whole rupee.
  const INTRA_LINES: readonly RawLine[] = [
    {
      quantity: '2.000',
      unitRate: '50.00',
      gstRate: '18.00',
      taxable: '100.00',
      cgst: '9.00',
      sgst: '9.00',
      igst: '0.00',
    },
    {
      quantity: '1.000',
      unitRate: '100.00',
      gstRate: '5.00',
      taxable: '100.00',
      cgst: '2.50',
      sgst: '2.50',
      igst: '0.00',
    },
  ];

  it('accepts an itemised invoice whose heads are the sum of its lines', async () => {
    const tenant = await seedItemisedTenant(pool);
    await submittedItemisedInvoice(pool, tenant, {
      placeOfSupply: '27',
      lines: INTRA_LINES,
      taxable: '200.00',
      cgst: '11.50',
      sgst: '11.50',
      igst: '0.00',
      roundOff: '0.00',
      total: '223.00',
    });
  });

  it('refuses an itemised invoice carrying zero tax heads', async () => {
    const tenant = await seedItemisedTenant(pool);
    // Every pre-0057 constraint passes: split coherence holds (igst = 0),
    // the total re-adds the parts, and there is no header rate to judge
    // against — which is exactly the hole the recreated guard closes.
    const refusal = await refused(
      submittedItemisedInvoice(pool, tenant, {
        placeOfSupply: '27',
        lines: INTRA_LINES,
        taxable: '200.00',
        cgst: '0.00',
        sgst: '0.00',
        igst: '0.00',
        roundOff: '0.00',
        total: '200.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('do not reconcile with the itemised lines');
  });

  it('refuses a header taxable value that is not the sum of the lines', async () => {
    const tenant = await seedItemisedTenant(pool);
    const refusal = await refused(
      submittedItemisedInvoice(pool, tenant, {
        placeOfSupply: '27',
        lines: INTRA_LINES,
        taxable: '150.00',
        cgst: '11.50',
        sgst: '11.50',
        igst: '0.00',
        roundOff: '0.00',
        total: '173.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('is not the sum of its');
  });

  it('refuses a line whose money is not quantity x rate at its own GST rate', async () => {
    const tenant = await seedItemisedTenant(pool);
    const refusal = await refused(
      submittedItemisedInvoice(pool, tenant, {
        placeOfSupply: '27',
        lines: [
          {
            quantity: '2.000',
            unitRate: '50.00',
            gstRate: '18.00',
            // 2 x 50 is 100, not 90.
            taxable: '90.00',
            cgst: '8.10',
            sgst: '8.10',
            igst: '0.00',
          },
        ],
        taxable: '90.00',
        cgst: '8.10',
        sgst: '8.10',
        igst: '0.00',
        roundOff: '-0.20',
        total: '106.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain(
      'tax_invoice_lines_taxable_is_quantity_times_rate',
    );
  });

  it('keeps the CUMULATIVE branch exactly as 0052 left it', async () => {
    const tenant = await seedItemisedTenant(pool);
    // The same two proofs the 0052 suite makes, re-run against the
    // recreated function so the itemised branch cannot have weakened it.
    await submittedInvoice(pool, tenant, {
      gstRate: '18.00',
      placeOfSupply: '27',
      taxable: '100.00',
      cgst: '9.00',
      sgst: '9.00',
      igst: '0.00',
      roundOff: '0.00',
      total: '118.00',
    });
    const refusal = await refused(
      submittedInvoice(pool, tenant, {
        gstRate: '18.00',
        placeOfSupply: '27',
        taxable: '100.00',
        cgst: '0.00',
        sgst: '0.00',
        igst: '0.00',
        roundOff: '0.00',
        total: '100.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('do not reconcile with the GST rate');
  });

  it('still applies the 0052 split-place guard to an itemised invoice', async () => {
    const tenant = await seedItemisedTenant(pool);
    // Place of supply 29 against organisation state 27 is inter-state, so
    // a CGST/SGST split is a contradiction the HEADER guard owns — it
    // reads no line and was deliberately left untouched by 0057.
    const refusal = await refused(
      submittedItemisedInvoice(pool, tenant, {
        placeOfSupply: '29',
        lines: INTRA_LINES,
        taxable: '200.00',
        cgst: '11.50',
        sgst: '11.50',
        igst: '0.00',
        roundOff: '0.00',
        total: '223.00',
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('CGST and SGST must be 0');
  });

  it('refuses a cumulative invoice that carries line rows, and an itemised one that carries none', async () => {
    const tenant = await seedItemisedTenant(pool);
    const withLines = await refused(
      pool.begin(async (tx) => {
        const [invoice] = await tx<{ id: string }[]>`
          insert into tax_invoices (
            organisation_id, status, invoice_date, sac_code,
            service_description, gst_rate, place_of_supply, buyer_contact_id,
            stated_taxable_value, created_by_user_id
          )
          values (
            ${tenant.organisationId}, 'draft', '2026-02-15', '998734',
            'Cumulative draft', '18.00', '27', ${tenant.buyerId}, '100.00',
            'tax-money-test'
          )
          returning id
        `;
        if (!invoice) throw new Error('cumulative invoice seed failed');
        await tx`
          insert into tax_invoice_lines (
            organisation_id, tax_invoice_id, position, is_service,
            hsn_sac_code, description, quantity, unit_rate, gst_rate
          )
          values (
            ${tenant.organisationId}, ${invoice.id}, 1, false, '85444999',
            'A line a cumulative invoice may not have', '1.000', '100.00',
            '18.00'
          )
        `;
      }),
    );
    expect(withLines.code).toBe('23514');
    expect(withLines.message).toContain('must have no tax_invoice_lines rows');

    const withoutLines = await refused(
      pool`
        insert into tax_invoices (
          organisation_id, status, line_shape, invoice_date, place_of_supply,
          buyer_contact_id, stated_taxable_value, created_by_user_id
        )
        values (
          ${tenant.organisationId}, 'draft', 'itemised', '2026-02-15', '27',
          ${tenant.buyerId}, '100.00', 'tax-money-test'
        )
      `,
    );
    expect(withoutLines.code).toBe('23514');
    expect(withoutLines.message).toContain(
      'must have at least one tax_invoice_lines row',
    );
  });

  it('refuses every line write once the invoice has left draft', async () => {
    const tenant = await seedItemisedTenant(pool);
    const invoiceId = (await submittedItemisedInvoice(pool, tenant, {
      placeOfSupply: '27',
      lines: INTRA_LINES,
      taxable: '200.00',
      cgst: '11.50',
      sgst: '11.50',
      igst: '0.00',
      roundOff: '0.00',
      total: '223.00',
    })) as string;

    const edited = await refused(
      pool`
        update tax_invoice_lines set description = 'rewritten after issue'
        where tax_invoice_id = ${invoiceId}
      `,
    );
    expect(edited.code).toBe('23514');
    expect(edited.message).toContain('mutable only while the invoice is draft');

    const deleted = await refused(
      pool`delete from tax_invoice_lines where tax_invoice_id = ${invoiceId}`,
    );
    expect(deleted.code).toBe('23514');
    expect(deleted.message).toContain('mutable only while the invoice is draft');
  });

  it('freezes line_shape on an issued invoice', async () => {
    const tenant = await seedItemisedTenant(pool);
    const invoiceId = (await submittedItemisedInvoice(pool, tenant, {
      placeOfSupply: '27',
      lines: INTRA_LINES,
      taxable: '200.00',
      cgst: '11.50',
      sgst: '11.50',
      igst: '0.00',
      roundOff: '0.00',
      total: '223.00',
    })) as string;
    const refusal = await refused(
      pool`
        update tax_invoices set line_shape = 'service_cumulative'
        where id = ${invoiceId}
      `,
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('business facts are immutable');
  });
});

describe('0052 preflight over stored invoices', () => {
  it(
    'refuses the upgrade while a stored invoice breaks either invariant, naming it, and honours the frozen supplier state',
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-tax-money-'));
      const database = await createTemporaryDatabase();
      try {
        const pool = database.pool;
        await stageMigrations(directory, '0050');
        await runMigrations(pool, directory);

        // A pre-0052 database legitimately holds this row: an 18%
        // submitted invoice with zero heads passed every CHECK.
        const tenant = await seedTenant(pool);
        const poisonedId = randomUUID();
        await pool`
          insert into tax_invoices (
            id, organisation_id, status, invoice_number, sequence_number,
            fy_label, invoice_date, sac_code, service_description, gst_rate,
            place_of_supply, buyer_contact_id, buyer_snapshot,
            stated_taxable_value, taxable_value, cgst_amount, sgst_amount,
            igst_amount, round_off, total_amount, issued_snapshot,
            reverse_charge_applicable, submitted_at, submitted_by_user_id,
            created_by_user_id
          )
          values (
            ${poisonedId}, ${tenant.organisationId}, 'submitted',
            'TI/POISON/1', 1, '2025-26', '2026-01-10', '998734',
            'Pre-0052 zero-head invoice', '18.00', '27', ${tenant.buyerId},
            ${pool.json({ designation: 'Tax Money Buyer' })},
            '100.00', '100.00', '0.00', '0.00', '0.00', '0.00', '100.00',
            ${pool.json({ templateVersion: 'backstop-test', supplier: { stateCode: '27' } })},
            false, now(), 'tax-money-test', 'tax-money-test'
          )
        `;

        // A HEALTHY historical row whose organisation later moved states:
        // its snapshot froze supplier state 27 and its intra split was
        // right at issue. The preflight must judge it by the FROZEN state
        // and not name it — the live org state says inter, and judging by
        // that would wedge the upgrade on a false positive.
        const movedTenant = await seedTenant(pool);
        const frozenId = randomUUID();
        await pool`
          insert into tax_invoices (
            id, organisation_id, status, invoice_number, sequence_number,
            fy_label, invoice_date, sac_code, service_description, gst_rate,
            place_of_supply, buyer_contact_id, buyer_snapshot,
            stated_taxable_value, taxable_value, cgst_amount, sgst_amount,
            igst_amount, round_off, total_amount, issued_snapshot,
            reverse_charge_applicable, submitted_at, submitted_by_user_id,
            created_by_user_id
          )
          values (
            ${frozenId}, ${movedTenant.organisationId}, 'submitted',
            'TI/FROZEN/1', 1, '2025-26', '2026-01-10', '998734',
            'Issued before the organisation moved states', '18.00', '27',
            ${movedTenant.buyerId},
            ${pool.json({ designation: 'Tax Money Buyer' })},
            '100.00', '100.00', '9.00', '9.00', '0.00', '0.00', '118.00',
            ${pool.json({ templateVersion: 'backstop-test', supplier: { stateCode: '27' } })},
            false, now(), 'tax-money-test', 'tax-money-test'
          )
        `;
        await pool`
          update organisations set state_code = '29'
          where id = ${movedTenant.organisationId}
        `;

        await copyFile(
          path.join(realMigrationsDirectory, '0052_tax_money_backstops.sql'),
          path.join(directory, '0052_tax_money_backstops.sql'),
        );
        const failure = await refused(runMigrations(pool, directory));
        expect(failure.message).toContain('do not reconcile');
        expect(failure.message).toContain(poisonedId);
        expect(failure.message).not.toContain(frozenId);

        // The failed migration rolled back whole: no triggers, no ledger row.
        const [ledger] = await pool<{ id: string | null }[]>`
          select max(id) as id from schema_migrations
        `;
        expect(ledger?.id).toBe('0050');

        // The operator follows the message — corrects the poisoned row in
        // a maintenance session that disables the 0041 money freeze around
        // the repair, exactly as the preflight message directs (0043
        // style) — and the rerun succeeds, proving the moved-state row
        // never blocks.
        expect(failure.message).toContain('maintenance session');
        await pool.unsafe(
          'alter table tax_invoices disable trigger tax_invoices_issued_update_guard',
        );
        try {
          await pool`
            update tax_invoices
            set cgst_amount = '9.00', sgst_amount = '9.00',
                total_amount = '118.00'
            where id = ${poisonedId}
          `;
        } finally {
          await pool.unsafe(
            'alter table tax_invoices enable trigger tax_invoices_issued_update_guard',
          );
        }
        await runMigrations(pool, directory);

        // And a split offender is named by the second preflight: rebuild
        // the staged directory one migration short, poison, retry.
        const splitDirectory = await mkdtemp(
          path.join(os.tmpdir(), 'auto-mb-tax-money-'),
        );
        const splitDatabase = await createTemporaryDatabase();
        try {
          const splitPool = splitDatabase.pool;
          await stageMigrations(splitDirectory, '0050');
          await runMigrations(splitPool, splitDirectory);
          const splitTenant = await seedTenant(splitPool);
          const splitPoisonedId = randomUUID();
          await splitPool`
            insert into tax_invoices (
              id, organisation_id, status, invoice_number, sequence_number,
              fy_label, invoice_date, sac_code, service_description, gst_rate,
              place_of_supply, buyer_contact_id, buyer_snapshot,
              stated_taxable_value, taxable_value, cgst_amount, sgst_amount,
              igst_amount, round_off, total_amount, issued_snapshot,
              reverse_charge_applicable, submitted_at, submitted_by_user_id,
              created_by_user_id
            )
            values (
              ${splitPoisonedId}, ${splitTenant.organisationId}, 'submitted',
              'TI/POISON/2', 1, '2025-26', '2026-01-10', '998734',
              'Pre-0052 inter-state CGST/SGST invoice', '18.00', '29',
              ${splitTenant.buyerId},
              ${splitPool.json({ designation: 'Tax Money Buyer' })},
              '100.00', '100.00', '9.00', '9.00', '0.00', '0.00', '118.00',
              ${splitPool.json({ templateVersion: 'backstop-test', supplier: { stateCode: '27' } })},
              false, now(), 'tax-money-test', 'tax-money-test'
            )
          `;
          await copyFile(
            path.join(realMigrationsDirectory, '0052_tax_money_backstops.sql'),
            path.join(splitDirectory, '0052_tax_money_backstops.sql'),
          );
          const splitFailure = await refused(runMigrations(splitPool, splitDirectory));
          expect(splitFailure.message).toContain('contradicts their place of supply');
          expect(splitFailure.message).toContain(splitPoisonedId);
        } finally {
          await dropTemporaryDatabase(splitDatabase);
          await rm(splitDirectory, { recursive: true, force: true });
        }
      } finally {
        await dropTemporaryDatabase(database);
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
