import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organisationA, organisationB } from './fixtures.js';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';
import { withTenant, withUserContext } from '../src/tenant.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '..', 'migrations');

const userA = 'integration-user-a';
const userB = 'integration-user-b';

/** Every tenant-owned table, children after parents. Additions to the
 * schema must be added here so the isolation proofs stay complete; the
 * completeness test below fails if this list drifts from the database. */
const TENANT_TABLES = [
  'organisations',
  'organisation_memberships',
  'works',
  'work_schedules',
  'work_items',
  'loa_documents',
  'delivery_challans',
  'delivery_challan_items',
  'delivery_challan_counters',
  'issue_challans',
  'issue_challan_lines',
  'issue_challan_counters',
  'audit_events',
  'challan_receipts',
  'challan_item_serials',
  'work_instruments',
  'bill_counters',
  'bills',
  'mb_entries',
  'work_assignments',
  'consignee_masters',
  'location_masters',
  'unit_masters',
  'organisation_signatories',
  'extension_requests',
  'extension_request_counters',
  'approval_requests',
  'installations',
  'installation_serials',
] as const;

type TenantTable = (typeof TENANT_TABLES)[number];

/** audit_events has its own append-only proof: the application role has no
 * UPDATE/DELETE privilege at all, so generic zero-row mutation assertions
 * (which expect privilege to exist but RLS to hide rows) do not apply. */
const GENERIC_UPDATE_TABLES = TENANT_TABLES.filter(
  (table) => table !== 'audit_events' && table !== 'work_assignments',
);

/** Tables where 0003 revoked DELETE outright (reservation anchors and
 * numbering state): a delete attempt raises 42501 rather than matching
 * zero rows. */
const DELETE_REVOKED_TABLES = [
  'organisations',
  'works',
  'work_items',
  'loa_documents',
  'delivery_challan_counters',
  'issue_challan_counters',
  'challan_receipts',
  'work_instruments',
  'bill_counters',
  'bills',
  'mb_entries',
  // Masters retire via the active flag; the app role holds no DELETE (0013).
  'consignee_masters',
  'location_masters',
  'unit_masters',
  'organisation_signatories',
  'extension_request_counters',
  'approval_requests',
  // Installation records cancel with a note; attachments release (0017).
  'installations',
  'installation_serials',
] as const satisfies readonly TenantTable[];

/** Tables the application role may still DELETE (drafts, lines,
 * memberships, schedules): cross-tenant deletes match zero rows. */
const DELETE_ALLOWED_TABLES = [
  'organisation_memberships',
  'work_schedules',
  'delivery_challans',
  'delivery_challan_items',
  'issue_challans',
  'issue_challan_lines',
  'challan_item_serials',
  'work_assignments',
  'extension_requests',
] as const satisfies readonly TenantTable[];

/** organisations carries the tenant id in `id`; every other table in
 * `organisation_id`. */
function organisationColumn(table: TenantTable): string {
  return table === 'organisations' ? 'id' : 'organisation_id';
}

interface TenantGraph {
  readonly workId: string;
  readonly scheduleId: string;
  readonly workItemId: string;
  readonly challanId: string;
  readonly auditEventId: string;
}

let admin: Sql;
let app: Sql;
let graphA: TenantGraph;
let graphB: TenantGraph;

/** Deletes both fixture organisations' rows, children first. */
async function removeSeedResidue(): Promise<void> {
  const organisationIds = [organisationA.id, organisationB.id];
  // Fixture cleanup as superuser: the bill/MB immutability triggers
  // (rightly) block ordinary deletes.
  await admin.unsafe(`set session_replication_role = 'replica'`);
  try {
    for (const table of [...TENANT_TABLES].reverse()) {
      await admin.unsafe(
        `delete from ${table} where ${organisationColumn(table)} = any($1::uuid[])`,
        [organisationIds],
      );
    }
  } finally {
    await admin.unsafe(`set session_replication_role = 'origin'`);
  }
}

async function countAs(
  pool: Sql,
  table: TenantTable,
  organisationId: string,
): Promise<number> {
  // Table and column names come from the hard-coded list above, never from
  // input; only the organisation id is parameterised.
  const rows = (await pool.unsafe(
    `select count(*)::int as count from ${table} where ${organisationColumn(table)} = $1`,
    [organisationId],
  )) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

/**
 * Seeds one organisation with a row in every tenant-owned table, inserted
 * through the application role inside a tenant-scoped transaction — the
 * same path product code will use.
 */
async function seedTenantGraph(
  organisationId: string,
  name: string,
  slug: string,
  userId: string,
  workCode: string,
  shaFill: string,
): Promise<TenantGraph> {
  return withTenant(app, { organisationId, userId }, async (tx) => {
    // The bootstrap function is the only path that can create an
    // organisation under the membership floor: it atomically creates the
    // organisation, the owner membership, and the audit event.
    await tx`
      select app_private.create_organisation_with_owner(${name}, ${slug}, ${organisationId})
    `;
    const [work] = await tx<{ id: string }[]>`
      insert into works (
        organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${organisationId}, ${workCode}, ${`LOA/${workCode}`}, '2026-01-15',
        'Integration test work for tenant isolation',
        '100000.00', '95000.00', 'per_schedule', ${userId}
      )
      returning id
    `;
    if (!work) throw new Error('seed work insert returned no row');

    const [schedule] = await tx<{ id: string }[]>`
      insert into work_schedules (organisation_id, work_id, schedule_code, title, position)
      values (${organisationId}, ${work.id}, 'SCH-1', 'Integration schedule', 1)
      returning id
    `;
    if (!schedule) throw new Error('seed schedule insert returned no row');

    const [workItem] = await tx<{ id: string }[]>`
      insert into work_items (
        organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${organisationId}, ${work.id}, ${schedule.id}, '1',
        'Integration test item', 'Nos', '10.000', '100.00'
      )
      returning id
    `;
    if (!workItem) throw new Error('seed work item insert returned no row');

    await tx`
      insert into loa_documents (
        organisation_id, object_key, original_filename, sha256,
        media_type, size_bytes, uploaded_by_user_id
      )
      values (
        ${organisationId}, ${`${organisationId}/loa/${workCode}.pdf`}, ${`${workCode}.pdf`},
        ${shaFill.repeat(64)}, 'application/pdf', 1024, ${userId}
      )
    `;

    const [challan] = await tx<{ id: string }[]>`
      insert into delivery_challans (
        organisation_id, work_id, challan_date, prefix, created_by_user_id
      )
      values (${organisationId}, ${work.id}, '2026-02-01', 'DC', ${userId})
      returning id
    `;
    if (!challan) throw new Error('seed challan insert returned no row');

    await tx`
      insert into delivery_challan_items (
        organisation_id, delivery_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, rate_snapshot,
        line_amount, position
      )
      values (
        ${organisationId}, ${challan.id}, ${work.id}, ${workItem.id},
        'Integration test item', 'Nos', '1.000', '100.00', '100.00', 1
      )
    `;

    await tx`
      insert into delivery_challan_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;

    // Milestone 7 Issue Challan tables: one row each.
    const [issueChallan] = await tx<{ id: string }[]>`
      insert into issue_challans (
        organisation_id, work_id, movement_type, challan_date, prefix,
        issued_to_name, created_by_user_id
      )
      values (${organisationId}, ${work.id}, 'issue', '2026-02-01',
              ${`${workCode}-IC`}, 'Integration site engineer', ${userId})
      returning id
    `;
    if (!issueChallan) throw new Error('seed issue challan insert returned no row');
    await tx`
      insert into issue_challan_lines (
        organisation_id, issue_challan_id, work_id, work_item_id,
        description_snapshot, unit_snapshot, quantity, position
      )
      values (
        ${organisationId}, ${issueChallan.id}, ${work.id}, ${workItem.id},
        'Integration test item', 'Nos', '1.000', 1
      )
    `;
    await tx`
      insert into issue_challan_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;

    const [auditEvent] = await tx<{ id: string }[]>`
      insert into audit_events (organisation_id, actor_user_id, action, entity_type, entity_id)
      values (${organisationId}, ${userId}, 'integration.seed', 'works', ${work.id})
      returning id
    `;
    if (!auditEvent) throw new Error('seed audit insert returned no row');

    // Milestone 5 retention tables: one row each.
    const [challanItem] = await tx<{ id: string }[]>`
      select id from delivery_challan_items
      where delivery_challan_id = ${challan.id}
    `;
    if (!challanItem) throw new Error('seed challan item lookup returned no row');
    await tx`
      insert into challan_receipts (
        organisation_id, delivery_challan_id, work_id, received_on,
        received_by, recorded_by_user_id
      )
      values (${organisationId}, ${challan.id}, ${work.id}, '2026-02-02',
              'Integration consignee', ${userId})
    `;
    await tx`
      insert into challan_item_serials (
        organisation_id, work_id, delivery_challan_id,
        delivery_challan_item_id, serial_number
      )
      values (${organisationId}, ${work.id}, ${challan.id}, ${challanItem.id},
              ${`SN-${workCode}`})
    `;
    await tx`
      insert into work_assignments (
        organisation_id, work_id, user_id, created_by_user_id
      )
      values (${organisationId}, ${work.id}, ${userId}, ${userId})
    `;
    await tx`
      insert into work_instruments (
        organisation_id, work_id, kind, reference, issued_on,
        created_by_user_id
      )
      values (${organisationId}, ${work.id}, 'pbg', ${`PBG-${workCode}`},
              '2026-01-20', ${userId})
    `;
    await tx`
      insert into bill_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;
    await tx`
      insert into bills (
        organisation_id, work_id, bill_number, lines_snapshot, total_amount,
        prepared_by_user_id
      )
      values (${organisationId}, ${work.id}, 1, '[]'::jsonb, 0, ${userId})
    `;
    await tx`
      insert into mb_entries (
        organisation_id, work_id, work_item_id, measured_quantity,
        measured_on, recorded_by_user_id
      )
      values (${organisationId}, ${work.id}, ${workItem.id}, '1.000',
              '2026-02-03', ${userId})
    `;
    await tx`
      insert into approval_requests (
        organisation_id, entity_type, entity_id, work_id, proposed, diff,
        reason, requested_by_user_id
      )
      values (
        ${organisationId}, 'work_item_amendment', ${workItem.id}, ${work.id},
        '{"kind":"change_item"}'::jsonb, '[]'::jsonb,
        'Integration seed amendment', ${userId}
      )
    `;

    // Milestone 7 masters tables: one row each.
    await tx`
      insert into consignee_masters (
        organisation_id, designation, address, created_by_user_id
      )
      values (${organisationId}, ${`Sr. DEE ${workCode}`},
              'Integration division office', ${userId})
    `;
    const [locationMaster] = await tx<{ id: string }[]>`
      insert into location_masters (organisation_id, name, kind, created_by_user_id)
      values (${organisationId}, ${`Station ${workCode}`}, 'station', ${userId})
      returning id
    `;
    if (!locationMaster) throw new Error('seed location insert returned no row');
    await tx`
      insert into unit_masters (organisation_id, name, created_by_user_id)
      values (${organisationId}, ${`Unit-${workCode}`}, ${userId})
    `;
    await tx`
      insert into organisation_signatories (
        organisation_id, name, designation, created_by_user_id
      )
      values (${organisationId}, ${`Signatory ${workCode}`}, 'Director', ${userId})
    `;

    // Milestone 6 completion/extension tables: the one-time completion
    // date set (allowed by the works guard), then a draft extension.
    await tx`
      update works
      set original_completion_date = '2026-12-31',
          current_completion_date = '2026-12-31'
      where id = ${work.id}
    `;
    await tx`
      insert into extension_requests (
        organisation_id, work_id, proposed_completion_date, reason,
        addressee, created_by_user_id
      )
      values (${organisationId}, ${work.id}, '2027-03-31',
              'Integration test extension reason', 'Sr. DEE (G)', ${userId})
    `;
    await tx`
      insert into extension_request_counters (organisation_id, work_id)
      values (${organisationId}, ${work.id})
    `;

    // Milestone 7 installation tables: one recorded installation with a
    // serial attachment, the location name snapshotted from the master.
    const [installation] = await tx<{ id: string }[]>`
      insert into installations (
        organisation_id, work_id, work_item_id, quantity, installed_on,
        location_id, location_name, recorded_by_user_id
      )
      values (
        ${organisationId}, ${work.id}, ${workItem.id}, '1.000', '2026-02-03',
        ${locationMaster.id}, ${`Station ${workCode}`}, ${userId}
      )
      returning id
    `;
    if (!installation) throw new Error('seed installation insert returned no row');
    await tx`
      insert into installation_serials (
        organisation_id, installation_id, work_id, challan_item_serial_id
      )
      select ${organisationId}, ${installation.id}, ${work.id}, s.id
      from challan_item_serials s
      where s.work_id = ${work.id} and s.serial_number = ${`SN-${workCode}`}
    `;

    return {
      workId: work.id,
      scheduleId: schedule.id,
      workItemId: workItem.id,
      challanId: challan.id,
      auditEventId: auditEvent.id,
    };
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-db-integration-admin',
  });

  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for integration tests. Start it with ' +
        '`docker compose up -d postgres` (or point DATABASE_ADMIN_URL and ' +
        `DATABASE_URL at a running instance). Underlying error: ${String(error)}`,
    );
  }

  // The docker-compose init script creates the application role on first
  // boot; CI service containers and bare instances do not run it, so the
  // suite converges the role itself before migrating.
  const escapedPassword = appPassword.replaceAll("'", "''");
  await admin.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
        CREATE ROLE auto_mb_app LOGIN PASSWORD '${escapedPassword}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END
    $$;
  `);

  await runMigrations(admin, migrationsDirectory);

  app = createDatabasePool({
    url: appUrl,
    max: 5,
    applicationName: 'auto-mb-db-integration-app',
  });

  // Remove residue from earlier runs, children first (admin bypasses RLS).
  // The fixed fixture UUIDs make the suite deterministic and self-cleaning,
  // at the documented cost that two invocations must not run concurrently
  // against the same database.
  await removeSeedResidue();

  graphA = await seedTenantGraph(
    organisationA.id,
    organisationA.name,
    'integration-org-a',
    userA,
    'INT-A-1',
    'a',
  );
  graphB = await seedTenantGraph(
    organisationB.id,
    organisationB.name,
    'integration-org-b',
    userB,
    'INT-B-1',
    'b',
  );
});

afterAll(async () => {
  try {
    // beforeAll may have failed before the admin pool existed.
    if ((admin as Sql | undefined) !== undefined) await removeSeedResidue();
  } finally {
    await app?.end();
    await admin?.end();
  }
});

describe('application role security posture', () => {
  it('is not superuser and cannot bypass RLS', async () => {
    const [role] = await app<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('does not own any tenant table', async () => {
    const rows = await admin<{ tablename: string; tableowner: string }[]>`
      select tablename, tableowner from pg_tables
      where schemaname = 'public' and tablename = any(${admin.array([...TENANT_TABLES])})
      order by tablename
    `;
    expect(rows.map((row) => row.tablename).sort()).toEqual([...TENANT_TABLES].sort());
    for (const row of rows) {
      expect(row.tableowner).not.toBe('auto_mb_app');
    }
  });

  it('has RLS enabled and forced on every public table except the ledger, live in the catalog', async () => {
    const rows = await admin<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace
        and relkind = 'r'
        and relname <> 'schema_migrations'
      order by relname
    `;
    expect(rows.length).toBeGreaterThanOrEqual(TENANT_TABLES.length);
    for (const table of TENANT_TABLES) {
      expect(rows.map((row) => row.relname)).toContain(table);
    }
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    }
  });

  it('covers every organisation-scoped table in the database with this suite', async () => {
    // If a new table with an organisation_id column lands without being
    // added to TENANT_TABLES, this fails instead of silently narrowing the
    // proofs below.
    const rows = await admin<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'organisation_id'
      order by table_name
    `;
    const expected = TENANT_TABLES.filter((table) => table !== 'organisations');
    expect(rows.map((row) => row.table_name).sort()).toEqual([...expected].sort());
  });
});

describe('no-context behaviour on every tenant table', () => {
  it('returns zero rows from every tenant table without organisation context', async () => {
    for (const table of TENANT_TABLES) {
      // The data exists (verified through the admin connection)…
      const adminVisible =
        (await countAs(admin, table, organisationA.id)) +
        (await countAs(admin, table, organisationB.id));
      expect(adminVisible, `${table} seed data`).toBeGreaterThanOrEqual(2);

      // …but the application role sees none of it without tenant context.
      const rows = (await app.unsafe(
        `select count(*)::int as count from ${table}`,
      )) as unknown as { count: number }[];
      expect(rows[0]?.count, table).toBe(0);
    }
  });
});

describe('cross-tenant isolation on every tenant table', () => {
  it('hides Organisation B rows from Organisation A reads on every tenant table', async () => {
    await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        for (const table of TENANT_TABLES) {
          expect(
            await countAs(tx as unknown as Sql, table, organisationA.id),
            `${table} own rows`,
          ).toBeGreaterThanOrEqual(1);
          expect(
            await countAs(tx as unknown as Sql, table, organisationB.id),
            `${table} foreign rows`,
          ).toBe(0);
        }

        const works = await tx<{ id: string }[]>`select id from works`;
        expect(works.map((row) => row.id)).toEqual([graphA.workId]);
      },
    );
  });

  it('makes Organisation B rows unreachable for Organisation A updates and deletes', async () => {
    await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        for (const table of GENERIC_UPDATE_TABLES) {
          const column = organisationColumn(table);
          const updated = await tx.unsafe(
            `update ${table} set ${column} = ${column} where ${column} = $1`,
            [organisationB.id],
          );
          expect(updated.count, `${table} update`).toBe(0);
        }

        for (const table of DELETE_ALLOWED_TABLES) {
          const column = organisationColumn(table);
          const deleted = await tx.unsafe(`delete from ${table} where ${column} = $1`, [
            organisationB.id,
          ]);
          expect(deleted.count, `${table} delete`).toBe(0);
        }
      },
    );

    const [untouched] = await admin<
      { title: string }[]
    >`select title from works where id = ${graphB.workId}`;
    expect(untouched?.title).toBe('Integration test work for tenant isolation');
    expect(await countAs(admin, 'delivery_challan_items', organisationB.id)).toBe(1);
  });

  it('refuses DELETE outright on reservation-anchor tables, even inside the own tenant', async () => {
    for (const table of DELETE_REVOKED_TABLES) {
      const column = organisationColumn(table);
      await expect(
        withTenant(app, { organisationId: organisationA.id, userId: userA }, (tx) =>
          tx.unsafe(`delete from ${table} where ${column} = $1`, [organisationA.id]),
        ),
        `${table} delete`,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('maintains updated_at on modification through the touch trigger', async () => {
    const before = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [row] = await tx<{ updated_at: string }[]>`
          select updated_at from works where id = ${graphA.workId}
        `;
        await tx`
          update works set title = 'Integration test work for tenant isolation'
          where id = ${graphA.workId}
        `;
        return row?.updated_at;
      },
    );

    const [after] = await admin<{ newer: boolean }[]>`
      select updated_at > ${before ?? null}::timestamptz as newer
      from works where id = ${graphA.workId}
    `;
    expect(after?.newer).toBe(true);
  });

  it('rejects writing rows stamped with another organisation id', async () => {
    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          await tx`
          insert into works (
            organisation_id, work_code, letter_number, letter_date, title,
            advertised_value, contract_value, pricing_shape, created_by_user_id
          )
          values (
            ${organisationB.id}, 'INT-A-EVIL', 'LOA/INT-A-EVIL', '2026-01-15',
            'Attempted cross-tenant insert', '1.00', '1.00', 'per_schedule', ${userA}
          )
        `;
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          await tx`
            insert into audit_events (organisation_id, action, entity_type)
            values (${organisationB.id}, 'integration.evil', 'works')
          `;
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('membership floor', () => {
  it('does not bind tenant context for a non-member, even with a valid organisation id', async () => {
    // userB is not a member of organisation A: every read is empty and
    // every write is denied, no matter what the handler stamped.
    await withTenant(
      app,
      { organisationId: organisationA.id, userId: userB },
      async (tx) => {
        const [bound] = await tx<{ organisation_id: string | null }[]>`
          select app_private.current_organisation_id() as organisation_id
        `;
        expect(bound?.organisation_id).toBeNull();

        for (const table of TENANT_TABLES) {
          expect(
            await countAs(tx as unknown as Sql, table, organisationA.id),
            table,
          ).toBe(0);
        }
      },
    );

    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userB },
        (tx) => tx`
          insert into audit_events (organisation_id, action, entity_type)
          values (${organisationA.id}, 'integration.floor-breach', 'works')
        `,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('does not bind tenant context for a disabled membership', async () => {
    await admin`
      update organisation_memberships set status = 'disabled'
      where organisation_id = ${organisationB.id} and user_id = ${userB}
    `;
    try {
      await withTenant(
        app,
        { organisationId: organisationB.id, userId: userB },
        async (tx) => {
          const works = await tx`select id from works`;
          expect(works).toHaveLength(0);
        },
      );
    } finally {
      await admin`
        update organisation_memberships set status = 'active'
        where organisation_id = ${organisationB.id} and user_id = ${userB}
      `;
    }
  });

  it('refuses organisation bootstrap without a user context', async () => {
    await expect(
      app.begin(
        (tx) => tx`
        select app_private.create_organisation_with_owner('No User Org', 'no-user-org')
      `,
      ),
    ).rejects.toMatchObject({ code: '28000' });
  });

  it('lets a member list their organisations before selecting one', async () => {
    const organisations = await withUserContext(
      app,
      userA,
      (tx) =>
        tx<{ id: string; name: string }[]>`
          select id, name from organisations order by id
        `,
    );
    expect(organisations).toEqual([{ id: organisationA.id, name: organisationA.name }]);
  });
});

describe('membership listing before organisation selection', () => {
  it('lets a user see only their own memberships with no organisation context', async () => {
    const memberships = await withUserContext(
      app,
      userB,
      (tx) =>
        tx<{ organisation_id: string; user_id: string }[]>`
        select organisation_id, user_id from organisation_memberships
      `,
    );
    expect(memberships).toEqual([
      { organisation_id: organisationB.id, user_id: userB },
    ]);
  });
});

describe('audit trail append-only guarantee', () => {
  it('accepts inserts but refuses update, delete, and truncate from the application role', async () => {
    const eventId = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [event] = await tx<{ id: string }[]>`
          insert into audit_events (organisation_id, actor_user_id, action, entity_type, entity_id)
          values (${organisationA.id}, ${userA}, 'integration.test', 'works', ${graphA.workId})
          returning id
        `;
        if (!event) throw new Error('audit insert returned no row');
        return event.id;
      },
    );

    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          await tx`update audit_events set action = 'integration.tampered' where id = ${eventId}`;
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withTenant(
        app,
        { organisationId: organisationA.id, userId: userA },
        async (tx) => {
          await tx`delete from audit_events where id = ${eventId}`;
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Wrapped in a transaction that always throws: if the TRUNCATE revoke
    // ever regresses, the data is rolled back and the test fails on the
    // wrong rejection instead of destroying the shared audit table.
    await expect(
      app.begin(async (tx) => {
        await tx.unsafe('truncate audit_events');
        throw new Error('truncate unexpectedly succeeded');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
