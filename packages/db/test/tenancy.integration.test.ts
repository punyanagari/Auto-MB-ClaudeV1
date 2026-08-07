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

let admin: Sql;
let app: Sql;
let workAId: string;
let workBId: string;

async function seedOrganisation(
  organisationId: string,
  name: string,
  slug: string,
  userId: string,
  workCode: string,
): Promise<string> {
  return withTenant(app, { organisationId, userId }, async (tx) => {
    await tx`
      insert into organisations (id, name, slug)
      values (${organisationId}, ${name}, ${slug})
    `;
    await tx`
      insert into organisation_memberships (organisation_id, user_id, role)
      values (${organisationId}, ${userId}, 'owner')
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
    return work.id;
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
  const organisationIds = [organisationA.id, organisationB.id];
  await admin`delete from audit_events where organisation_id in ${admin(organisationIds)}`;
  await admin`delete from works where organisation_id in ${admin(organisationIds)}`;
  await admin`delete from organisation_memberships where organisation_id in ${admin(organisationIds)}`;
  await admin`delete from organisations where id in ${admin(organisationIds)}`;

  workAId = await seedOrganisation(
    organisationA.id,
    organisationA.name,
    'integration-org-a',
    userA,
    'INT-A-1',
  );
  workBId = await seedOrganisation(
    organisationB.id,
    organisationB.name,
    'integration-org-b',
    userB,
    'INT-B-1',
  );
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

describe('application role security posture', () => {
  it('is not superuser and cannot bypass RLS', async () => {
    const [role] = await app<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('is subject to forced RLS: without tenant context every table is empty', async () => {
    const [force] = await admin<
      { relforcerowsecurity: boolean }[]
    >`select relforcerowsecurity from pg_class where relname = 'works'`;
    expect(force?.relforcerowsecurity).toBe(true);

    const [adminCount] = await admin<{ count: string }[]>`
      select count(*) as count from works
      where organisation_id in ${admin([organisationA.id, organisationB.id])}
    `;
    expect(Number(adminCount?.count)).toBe(2);

    // Same query through the application role with no organisation context.
    const rows = await app`select id from works`;
    expect(rows).toHaveLength(0);
  });
});

describe('cross-tenant isolation', () => {
  it('hides Organisation B rows from Organisation A reads', async () => {
    await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const works = await tx<{ id: string }[]>`select id from works`;
        expect(works.map((row) => row.id)).toEqual([workAId]);

        const foreignWork = await tx`select id from works where id = ${workBId}`;
        expect(foreignWork).toHaveLength(0);

        const organisations = await tx<{ id: string }[]>`select id from organisations`;
        expect(organisations.map((row) => row.id)).toEqual([organisationA.id]);
      },
    );
  });

  it('makes Organisation B rows unreachable for Organisation A mutations', async () => {
    await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const updated = await tx`
        update works set title = 'tampered by organisation A'
        where id = ${workBId}
      `;
        expect(updated.count).toBe(0);

        const deleted = await tx`delete from works where id = ${workBId}`;
        expect(deleted.count).toBe(0);
      },
    );

    const [untouched] = await admin<
      { title: string }[]
    >`select title from works where id = ${workBId}`;
    expect(untouched?.title).toBe('Integration test work for tenant isolation');
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
  it('accepts inserts but refuses update and delete from the application role', async () => {
    const eventId = await withTenant(
      app,
      { organisationId: organisationA.id, userId: userA },
      async (tx) => {
        const [event] = await tx<{ id: string }[]>`
          insert into audit_events (organisation_id, actor_user_id, action, entity_type, entity_id)
          values (${organisationA.id}, ${userA}, 'integration.test', 'works', ${workAId})
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
  });
});
