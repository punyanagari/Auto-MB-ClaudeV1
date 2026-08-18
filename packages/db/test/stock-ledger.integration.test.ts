import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { withTenant } from '../src/tenant.js';
import {
  SETUP_TIMEOUT_MS,
  adminUrl,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
  dropTemporaryDatabase,
  migrateToHead,
  refused,
  seedTenant,
  type TemporaryDatabase,
  type Tenant,
} from './support/invariant-db.js';

/**
 * The stock ledger, proved at the database (migration 0087).
 *
 * These are the assertions the routes CANNOT make. A route checks the
 * balance before it writes and is right about it right up until a second
 * request checks the same balance at the same moment; the ledger's
 * correctness rests on `app_private.guard_stock_movement()` claiming the
 * per-item counter row before it reads anything, and on `balance_after`
 * carrying a CHECK that no writer can reach around.
 *
 * Every concurrency test here is built to FAIL without the lock. The
 * shape is deliberate: a burst of `Promise.all` writes, each individually
 * legal against the balance they all start from, and an assertion that
 * the ledger afterwards is arithmetically whole. Remove the counter
 * upsert from the guard and the burst either oversells the shelf or mints
 * two rows at one ledger position.
 */

const PREFIX = 'auto_mb_stock_test_';

/** Waits until SOME backend of this database is blocked on a lock, and
 * answers its pid.
 *
 * `quantity-ceilings.integration.test.ts` waits on a pid it already
 * knows; here the waiter is a connection the pool chose, so the wait is
 * for the CONDITION rather than for a particular backend. That is the
 * claim being made anyway — "a second writer cannot proceed" — and it is
 * a real observation of the lock rather than a sleep long enough to look
 * like one. */
async function waitUntilSomethingBlocks(pool: Sql): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await pool<{ pid: number }[]>`
      select pid from pg_stat_activity
      where wait_event_type = 'Lock' and datname = current_database()
      limit 1
    `;
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('no backend ever blocked on a lock');
}

/** Enough parallel writers to lose a race reliably on this hardware, and
 * few enough to stay inside the pool. */
const BURST = 8;

let admin: Sql;
let database: TemporaryDatabase;
let tenant: Tenant;
/** The organisation's own today. Every movement is dated here, because
 * the ledger refuses one dated ahead of it AND one dated behind the
 * part's last movement — a fixed literal would start failing the day the
 * clock passed it. */
let today: string;
/** A part nothing else in the suite touches, per test that needs one. */
let itemCounter = 0;

async function createItem(options?: {
  readonly manufactured?: boolean;
  readonly unit?: string;
}): Promise<string> {
  itemCounter += 1;
  const code = `PART-${String(itemCounter).padStart(3, '0')}`;
  const [row] = await database.pool<{ id: string }[]>`
    insert into production_items (
      organisation_id, item_code, name, category, unit, manufactured,
      serial_prefix, serial_controlled, created_by_user_id
    )
    values (
      ${tenant.organisationId}, ${code}, ${`Part ${code}`}, 'Electronics',
      ${options?.unit ?? 'Nos'}, ${options?.manufactured ?? false},
      ${options?.manufactured === true ? `SER${String(itemCounter).padStart(3, '0')}` : null},
      ${options?.manufactured ?? false}, ${tenant.userId}
    )
    returning id
  `;
  if (!row) throw new Error('item seed failed');
  return row.id;
}

/** One movement, written the way the application writes it: through the
 * unprivileged role, inside a membership-bound transaction, with the
 * ledger position and the balance left for the guard to fill in. */
async function post(
  itemId: string,
  movementType: string,
  quantity: string,
  extra: Record<string, string | null> = {},
): Promise<void> {
  await withTenant(
    database.appPool,
    { organisationId: tenant.organisationId, userId: tenant.userId },
    async (tx) => {
      await tx`
        insert into stock_movements ${tx({
          organisation_id: tenant.organisationId,
          production_item_id: itemId,
          movement_type: movementType,
          quantity,
          movement_date: today,
          created_by_user_id: tenant.userId,
          ...extra,
        })}
      `;
    },
  );
}

async function onHand(itemId: string): Promise<string> {
  const [row] = await database.pool<{ balance: string }[]>`
    select app_private.stock_on_hand(
      ${tenant.organisationId}, ${itemId}
    )::text as balance
  `;
  return row?.balance ?? 'missing';
}

/** The reconciliation the header promises: the running total the ledger
 * cached and the sum of what it recorded are the same number, and the
 * positions are 1..n with no gap and no repeat. */
async function assertLedgerWhole(itemId: string): Promise<void> {
  const [row] = await database.pool<
    {
      summed: string;
      cached: string;
      positions: number;
      distinct_positions: number;
      highest: number;
      negatives: string;
    }[]
  >`
    select coalesce(sum(quantity), 0)::text as summed,
           coalesce(
             (
               select balance_after from stock_movements last
               where last.organisation_id = ${tenant.organisationId}
                 and last.production_item_id = ${itemId}
               order by last.sequence_number desc limit 1
             ),
             0
           )::text as cached,
           count(*)::int as positions,
           count(distinct sequence_number)::int as distinct_positions,
           coalesce(max(sequence_number), 0)::int as highest,
           count(*) filter (where balance_after < 0)::text as negatives
    from stock_movements
    where organisation_id = ${tenant.organisationId}
      and production_item_id = ${itemId}
  `;
  if (!row) throw new Error('ledger read returned no row');
  expect(Number(row.summed), 'sum of movements equals the cached balance').toBe(
    Number(row.cached),
  );
  expect(row.distinct_positions, 'no two rows share a ledger position').toBe(
    row.positions,
  );
  expect(row.highest, 'the positions run 1..n with no gap').toBe(row.positions);
  expect(row.negatives, 'no row ever recorded a negative balance').toBe('0');
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-stock-admin',
  });
  await admin`select 1 as ready`;
  await dropStaleTemporaryDatabases(admin, PREFIX);
  database = await createTemporaryDatabase(admin, PREFIX);
  await migrateToHead(database);
  tenant = await seedTenant(database.pool);
  const [row] = await database.pool<{ today: string }[]>`
    select app_private.organisation_today(${tenant.organisationId})::text as today
  `;
  today = row?.today ?? '';
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (database !== undefined) await dropTemporaryDatabase(admin, database);
  await admin?.end();
}, SETUP_TIMEOUT_MS);

describe('the stock ledger', () => {
  it('computes the balance rather than accepting one', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '10', { reason: 'Opening count' });

    // The writer supplied neither the position nor the balance; both come
    // from the guard.
    const [row] = await database.pool<
      { sequence_number: number; balance_after: string }[]
    >`
      select sequence_number, balance_after::text as balance_after
      from stock_movements where production_item_id = ${item}
    `;
    expect(row?.sequence_number).toBe(1);
    expect(row?.balance_after).toBe('10.000');

    // …and a writer that DOES supply one is overruled rather than
    // believed: the column is not an input.
    await withTenant(
      database.appPool,
      { organisationId: tenant.organisationId, userId: tenant.userId },
      async (tx) => {
        await tx`
          insert into stock_movements (
            organisation_id, production_item_id, sequence_number, movement_type,
            quantity, balance_after, movement_date, reason, created_by_user_id
          )
          values (
            ${tenant.organisationId}, ${item}, 99, 'adjustment_in', 5, 4000,
            ${today}, 'Overstated on purpose', ${tenant.userId}
          )
        `;
      },
    );
    expect(await onHand(item)).toBe('15.000');
    await assertLedgerWhole(item);
  });

  it('refuses an issue that would take the balance below zero', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '4', { reason: 'Opening count' });

    const failure = await refused(
      post(item, 'issue', '-5', {
        production_job_card_id: null,
        work_id: tenant.workId,
      }),
    );
    expect(failure.code).toBe('23F01');
    expect(failure.message).toMatch(/cannot release/);
    expect(await onHand(item)).toBe('4.000');
  });

  it('refuses an adjustment out below zero too — you cannot lose more than you had', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '2', { reason: 'Opening count' });
    const failure = await refused(
      post(item, 'adjustment_out', '-3', { reason: 'Missing from the shelf' }),
    );
    expect(failure.code).toBe('23F01');
  });

  /**
   * THE GATE. Eight issues of 3 against a shelf holding 10: each one is
   * legal against the balance all eight start from, and only three can
   * actually be honoured.
   *
   * Without the counter lock in the guard, every writer reads 10, every
   * writer computes 7, and the shelf ends up at 7 having released 24 —
   * or the unique index on (organisation, item, position) rejects the
   * collisions and the count comes out wrong. With it, exactly three
   * commit and the ledger reconciles.
   */
  it('does not oversell one shelf to eight simultaneous issues', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '10', { reason: 'Opening count' });

    const outcomes = await Promise.all(
      Array.from({ length: BURST }, () =>
        post(item, 'issue', '-3', { work_id: tenant.workId }).then(
          () => 'committed' as const,
          () => 'refused' as const,
        ),
      ),
    );
    const committed = outcomes.filter((outcome) => outcome === 'committed').length;

    expect(committed, 'three issues of 3 fit inside a shelf of 10').toBe(3);
    expect(await onHand(item)).toBe('1.000');
    await assertLedgerWhole(item);
  });

  /**
   * The same race the other way: eight receipts, none of which can be
   * refused, all of which have to end up at distinct ledger positions
   * with a running total that adds up. This is the test that fails if the
   * counter is ever replaced by `max(sequence_number) + 1`.
   */
  it('gives eight simultaneous receipts eight distinct ledger positions', async () => {
    const item = await createItem();
    await Promise.all(
      Array.from({ length: BURST }, () =>
        post(item, 'adjustment_in', '5', { reason: 'Simultaneous count' }),
      ),
    );
    expect(await onHand(item)).toBe(String(BURST * 5) + '.000');
    await assertLedgerWhole(item);
  });

  /** Produce-versus-issue: a receipt and an issue landing together must
   * not lose either one, whichever order they serialise in. */
  it('keeps the running total whole when receipts and issues interleave', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '40', { reason: 'Opening count' });

    await Promise.all([
      ...Array.from({ length: BURST }, () =>
        post(item, 'adjustment_in', '2', { reason: 'Found on the shelf' }),
      ),
      ...Array.from({ length: BURST }, () =>
        post(item, 'issue', '-2', { work_id: tenant.workId }),
      ),
    ]);

    expect(await onHand(item)).toBe('40.000');
    await assertLedgerWhole(item);
  });

  it('is append-only: the application role holds no UPDATE and no DELETE', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '1', { reason: 'Opening count' });

    const update = await refused(
      withTenant(
        database.appPool,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) =>
          tx`update stock_movements set quantity = 99 where production_item_id = ${item}`,
      ),
    );
    expect(update.code, 'UPDATE is not granted').toBe('42501');

    const remove = await refused(
      withTenant(
        database.appPool,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) => tx`delete from stock_movements where production_item_id = ${item}`,
      ),
    );
    expect(remove.code, 'DELETE is not granted').toBe('42501');
  });

  it('refuses a movement dated after the organisation today', async () => {
    const item = await createItem();
    const failure = await refused(
      withTenant(
        database.appPool,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) => tx`
          insert into stock_movements (
            organisation_id, production_item_id, movement_type, quantity,
            movement_date, reason, created_by_user_id
          )
          values (
            ${tenant.organisationId}, ${item}, 'adjustment_in', 1,
            (app_private.organisation_today(${tenant.organisationId}) + 1),
            'Tomorrow', ${tenant.userId}
          )
        `,
      ),
    );
    expect(failure.code).toBe('23F03');
  });

  /**
   * TIME ONLY RUNS FORWARD, PER PART. The cache is a running total in
   * posting order, so a row posted after another and dated before it
   * would leave every earlier balance skipping a movement earlier than
   * itself.
   */
  it("refuses a movement dated behind the part's last movement", async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '5', { reason: 'Opening count' });

    const failure = await refused(
      withTenant(
        database.appPool,
        { organisationId: tenant.organisationId, userId: tenant.userId },
        (tx) => tx`
          insert into stock_movements (
            organisation_id, production_item_id, movement_type, quantity,
            movement_date, reason, created_by_user_id
          )
          values (
            ${tenant.organisationId}, ${item}, 'adjustment_in', 1,
            (${today}::date - 1), 'Yesterday''s docket', ${tenant.userId}
          )
        `,
      ),
    );
    expect(failure.code).toBe('23F04');
    expect(failure.message).toMatch(/cannot be posted behind it/);

    // Same date is fine: several movements land on one day routinely, and
    // `sequence_number` is what orders them.
    await post(item, 'adjustment_in', '2', { reason: 'Second count' });
    expect(await onHand(item)).toBe('7.000');
    await assertLedgerWhole(item);
  });

  /**
   * The backdating rule, under concurrency.
   *
   * Two writers, one part: the first posts at today and the second at
   * yesterday, and the second is only refused if it reads the first's
   * date. Both take the same counter lock, so the loser sees the winner's
   * row — which is the point. Moot in the sense that a serial run refuses
   * it too; the test exists because the refusal has to survive the
   * interleaving, not merely the happy path.
   */
  it('refuses a backdated movement even when it races a later one', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '5', { reason: 'Opening count' });

    const backdated = withTenant(
      database.appPool,
      { organisationId: tenant.organisationId, userId: tenant.userId },
      (tx) => tx`
        insert into stock_movements (
          organisation_id, production_item_id, movement_type, quantity,
          movement_date, reason, created_by_user_id
        )
        values (
          ${tenant.organisationId}, ${item}, 'adjustment_in', 1,
          (${today}::date - 1), 'Late docket', ${tenant.userId}
        )
      `,
    ).then(
      () => 'committed' as const,
      () => 'refused' as const,
    );
    const current = post(item, 'adjustment_in', '3', {
      reason: 'Count taken today',
    }).then(
      () => 'committed' as const,
      () => 'refused' as const,
    );

    const [backdatedOutcome, currentOutcome] = await Promise.all([backdated, current]);
    expect(backdatedOutcome).toBe('refused');
    expect(currentOutcome).toBe('committed');
    expect(await onHand(item)).toBe('8.000');
    await assertLedgerWhole(item);
  });

  /**
   * THE MUTEX, PROVED BY BLOCKING rather than by reading the file.
   *
   * The migration contract used to assert that the counter upsert appears
   * before the balance read by comparing substring offsets — which would
   * have passed if the balance read moved into a helper called from the
   * first line, and failed on a harmless reorder. This holds the actual
   * claim: a second writer against the SAME part cannot get as far as
   * reading a balance while the first is still open, because it is
   * waiting on a lock.
   */
  it('serialises two writers on one part before either reads a balance', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '10', { reason: 'Opening count' });

    // A transaction that posts a movement and then HOLDS, so the
    // counter row stays locked while a second writer tries the same
    // part.
    let openTheGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });
    let posted = (): void => undefined;
    const firstPosted = new Promise<void>((resolve) => {
      posted = resolve;
    });

    const holder = withTenant(
      database.appPool,
      { organisationId: tenant.organisationId, userId: tenant.userId },
      async (tx) => {
        await tx`
            insert into stock_movements (
              organisation_id, production_item_id, movement_type, quantity,
              movement_date, reason, created_by_user_id
            )
            values (
              ${tenant.organisationId}, ${item}, 'adjustment_in', 4,
              ${today}, 'Holds the counter', ${tenant.userId}
            )
          `;
        posted();
        await gate;
      },
    );
    await firstPosted;

    let settled = false;
    const contender = post(item, 'adjustment_in', '6', {
      reason: 'Waits for the lock',
    }).then(() => {
      settled = true;
    });

    // REAL blocking, observed in the catalog — not a sleep that is
    // probably long enough.
    await waitUntilSomethingBlocks(database.pool);
    expect(settled, 'the second writer is still waiting on the counter').toBe(false);

    openTheGate();
    await holder;
    await contender;

    // 10 + 4 + 6: the second writer's balance includes the first's,
    // which is only true because it read it after the lock was
    // released.
    expect(await onHand(item)).toBe('20.000');
    await assertLedgerWhole(item);
  }, 30_000);

  it('lets a retired part empty its shelf but takes nothing more in', async () => {
    const item = await createItem();
    await post(item, 'adjustment_in', '6', { reason: 'Opening count' });
    await database.pool`
      update production_items set active = false where id = ${item}
    `;

    const inbound = await refused(
      post(item, 'adjustment_in', '1', { reason: 'Late delivery' }),
    );
    expect(inbound.code).toBe('23F03');
    expect(inbound.message).toMatch(/retired/);

    // Out still works: the alternative is stock nobody can ever clear.
    await post(item, 'adjustment_out', '-6', { reason: 'Scrapped on retirement' });
    expect(await onHand(item)).toBe('0.000');
  });

  it('binds every source shape, and refuses the ones that name nothing', async () => {
    const item = await createItem();
    // Stocked first, deliberately. A BEFORE trigger runs ahead of the
    // table's CHECK constraints, so an issue against an EMPTY shelf is
    // refused for being an overdraft (23F01) before anything looks at
    // what it names. These assertions are about the shape rule, so the
    // shelf has to be able to afford the movement.
    await post(item, 'adjustment_in', '20', { reason: 'Opening count' });

    // An adjustment with no reason.
    expect((await refused(post(item, 'adjustment_in', '1'))).code).toBe('23514');
    // An issue naming neither a job card nor a Work.
    expect((await refused(post(item, 'issue', '-1'))).code).toBe('23514');
    // An issue naming BOTH.
    const [card] = await database.pool<{ id: string }[]>`
      select id from production_job_cards limit 1
    `;
    if (card) {
      expect(
        (
          await refused(
            post(item, 'issue', '-1', {
              work_id: tenant.workId,
              production_job_card_id: card.id,
            }),
          )
        ).code,
      ).toBe('23514');
    }
    // A receipt whose sign contradicts its type.
    expect(
      (await refused(post(item, 'adjustment_in', '-1', { reason: 'Backwards' }))).code,
    ).toBe('23514');
  });
});

describe('production despatch to stock', () => {
  /** The despatch boundary, exercised end to end: a manufactured item, a
   * job card, two serialised units, a despatch, and the receipt that puts
   * them on the shelf. */
  async function despatchTwoUnits(): Promise<{ itemId: string; dispatchId: string }> {
    const itemId = await createItem({ manufactured: true });
    const [prefixRow] = await database.pool<{ serial_prefix: string }[]>`
      select serial_prefix from production_items where id = ${itemId}
    `;
    const prefix = prefixRow?.serial_prefix ?? '';
    const [card] = await database.pool<{ id: string }[]>`
      insert into production_job_cards (
        organisation_id, fy_label, sequence_number, item_id, quantity, work_id,
        source_reference, due_date, created_by_user_id
      )
      values (
        ${tenant.organisationId}, '2026-27', ${itemCounter}, ${itemId}, 2,
        ${tenant.workId}, 'Schedule A2/1', '2026-12-01', ${tenant.userId}
      )
      returning id
    `;
    if (!card) throw new Error('job card seed failed');
    const serials: string[] = [];
    for (const sequence of [1, 2]) {
      const [serial] = await database.pool<{ id: string }[]>`
        insert into production_serials (
          organisation_id, job_card_id, item_id, serial_number, sequence_number,
          created_by_user_id
        )
        values (
          ${tenant.organisationId}, ${card.id}, ${itemId},
          ${`${prefix}-0000${String(sequence)}`}, ${sequence}, ${tenant.userId}
        )
        returning id
      `;
      if (!serial) throw new Error('serial seed failed');
      serials.push(serial.id);
    }
    const [dispatch] = await database.pool<{ id: string }[]>`
      insert into production_dispatches (
        organisation_id, job_card_id, sequence_number, dispatched_on,
        created_by_user_id
      )
      values (
        ${tenant.organisationId}, ${card.id}, 1, ${today}, ${tenant.userId}
      )
      returning id
    `;
    if (!dispatch) throw new Error('dispatch seed failed');
    for (const serialId of serials) {
      await database.pool`
        insert into production_dispatch_serials (
          organisation_id, production_dispatch_id, production_serial_id, job_card_id
        )
        values (
          ${tenant.organisationId}, ${dispatch.id}, ${serialId}, ${card.id}
        )
      `;
    }
    return { itemId, dispatchId: dispatch.id };
  }

  it('takes exactly the units the despatch released, and no other number', async () => {
    const { itemId, dispatchId } = await despatchTwoUnits();

    const wrong = await refused(
      post(itemId, 'production_receipt', '5', {
        production_dispatch_id: dispatchId,
      }),
    );
    expect(wrong.code).toBe('23F02');
    expect(wrong.message).toMatch(/released 2 units/);

    await post(itemId, 'production_receipt', '2', {
      production_dispatch_id: dispatchId,
    });
    expect(await onHand(itemId)).toBe('2.000');
  });

  it('receives one despatch once, however many receipts race for it', async () => {
    const { itemId, dispatchId } = await despatchTwoUnits();

    const outcomes = await Promise.all(
      Array.from({ length: BURST }, () =>
        post(itemId, 'production_receipt', '2', {
          production_dispatch_id: dispatchId,
        }).then(
          () => 'committed' as const,
          () => 'refused' as const,
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === 'committed').length).toBe(1);
    expect(await onHand(itemId)).toBe('2.000');
    await assertLedgerWhole(itemId);
  });

  it('closes the despatch delete path the moment stock rests on it', async () => {
    const { itemId, dispatchId } = await despatchTwoUnits();
    await post(itemId, 'production_receipt', '2', {
      production_dispatch_id: dispatchId,
    });

    // Migration 0084 § 7 promised this: "the moment Inventory's ledger
    // carries the foreign key above, PostgreSQL refuses the delete,
    // because stock has already moved on the strength of it".
    const failure = await refused(
      database.pool`delete from production_dispatches where id = ${dispatchId}`,
    );
    expect(failure.code).toBe('23503');
  });
});

describe('the outstanding bill-of-material requirement', () => {
  it('explodes every level and nets the units already built', async () => {
    const product = await createItem({ manufactured: true });
    const subAssembly = await createItem({ manufactured: true });
    const rawPart = await createItem();

    // product -> 3 sub-assemblies -> 4 raw parts each.
    await database.pool`
      insert into production_bom_lines (
        organisation_id, parent_item_id, component_item_id, quantity,
        created_by_user_id
      )
      values
        (${tenant.organisationId}, ${product}, ${subAssembly}, 3, ${tenant.userId}),
        (${tenant.organisationId}, ${subAssembly}, ${rawPart}, 4, ${tenant.userId})
    `;
    const [prefixRow] = await database.pool<{ serial_prefix: string }[]>`
      select serial_prefix from production_items where id = ${product}
    `;
    const [card] = await database.pool<{ id: string }[]>`
      insert into production_job_cards (
        organisation_id, fy_label, sequence_number, item_id, quantity, work_id,
        source_reference, due_date, created_by_user_id
      )
      values (
        ${tenant.organisationId}, '2026-27', ${900 + itemCounter}, ${product}, 10,
        ${tenant.workId}, 'Schedule A9/1', '2026-12-01', ${tenant.userId}
      )
      returning id
    `;
    if (!card) throw new Error('job card seed failed');

    const requirement = async (): Promise<Record<string, string>> => {
      const rows = await database.pool<
        { component_item_id: string; required: string }[]
      >`
        select r.component_item_id, r.required::text as required
        from app_private.stock_outstanding_requirement(${tenant.organisationId}) r
        where r.job_card_id = ${card.id}
      `;
      return Object.fromEntries(
        rows.map((row) => [row.component_item_id, row.required]),
      );
    };

    // Ten units outstanding: 30 sub-assemblies and 120 raw parts.
    expect(await requirement()).toEqual({
      [subAssembly]: '30.000',
      [rawPart]: '120.000',
    });

    // Build four. The material for those four is already consumed, so the
    // requirement drops to the six that are left.
    for (const sequence of [1, 2, 3, 4]) {
      await database.pool`
        insert into production_serials (
          organisation_id, job_card_id, item_id, serial_number, sequence_number,
          created_by_user_id
        )
        values (
          ${tenant.organisationId}, ${card.id}, ${product},
          ${`${prefixRow?.serial_prefix ?? ''}-1000${String(sequence)}`},
          ${sequence}, ${tenant.userId}
        )
      `;
    }
    expect(await requirement()).toEqual({
      [subAssembly]: '18.000',
      [rawPart]: '72.000',
    });

    // A finished or cancelled card asks for nothing at all.
    await database.pool`
      update production_job_cards set status = 'cancelled',
        cancellation_reason = 'Superseded by a later card'
      where id = ${card.id}
    `;
    expect(await requirement()).toEqual({});
  });
});
