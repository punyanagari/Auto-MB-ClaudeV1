import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
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
 * The defect liability period, proved at the database (migration 0099).
 *
 * These are the assertions the routes cannot make. Every one below is
 * written through the UNPRIVILEGED application role, inside a
 * membership-bound transaction, with raw SQL — which is the shape a
 * future route, an import, or a hand-typed correction would have. A rule
 * that only the route holds is a rule with a door in it.
 *
 * The date arithmetic gets the same treatment. The boundary a defect
 * liability period turns on is "the last day the liability stands", and
 * an off-by-one there is a day of cover the agency either owes and does
 * not know about or does not owe and is still holding a guarantee
 * against. `app_private.warranty_expiry` is the one definition, so it is
 * attacked directly as well as through the guard that calls it.
 */

const PREFIX = 'auto_mb_warranty_test_';

let admin: Sql;
let database: TemporaryDatabase;
let tenant: Tenant;
/** The organisation's own today, which is what every date rule here is
 * measured against. Read once rather than written as a literal: a fixed
 * date would start failing the day the clock passed it. */
let today: string;
let workItemId: string;
/** The day after the Work's LOA letter date — the earliest an installation
 * may be dated (the 0017 guard). Every test that needs a period which has
 * already elapsed starts from here rather than from a literal, because a
 * literal either drifts past the letter date or past today depending on
 * which end of the calendar the suite is run from. */
let earliestInstalledOn: string;
let locationId: string;
let installationCounter = 0;

/** One recorded installation, dated far enough back that a 24-month
 * period started on it has already elapsed unless a test says otherwise. */
async function recordInstallation(installedOn: string): Promise<string> {
  installationCounter += 1;
  const [row] = await database.pool<{ id: string }[]>`
    insert into installations (
      organisation_id, work_id, work_item_id, quantity, installed_on,
      location_id, location_name, recorded_by_user_id
    )
    values (
      ${tenant.organisationId}, ${tenant.workId}, ${workItemId}, '1.000',
      ${installedOn}, ${locationId},
      ${`Station ${String(installationCounter)}`}, ${tenant.userId}
    )
    returning id
  `;
  if (!row) throw new Error('installation seed failed');
  return row.id;
}

/** Starts a period the way the application starts one: unprivileged role,
 * bound tenant, and the two expiry columns left for the guard to derive. */
async function startPeriod(
  installationId: string,
  options?: {
    readonly months?: number;
    readonly startOn?: string;
    readonly basis?: 'installation' | 'pac';
    readonly pacCertificateId?: string;
    readonly installedOn?: string;
  },
): Promise<string> {
  return withTenant(
    database.appPool,
    { organisationId: tenant.organisationId, userId: tenant.userId },
    async (tx) => {
      const startOn = options?.startOn ?? options?.installedOn ?? today;
      const [row] = await tx<{ id: string }[]>`
        insert into installation_warranties (
          organisation_id, work_id, installation_id, dlp_months, start_basis,
          pac_certificate_id, dlp_start_on, original_expires_on,
          dlp_expires_on, started_by_user_id
        )
        values (
          ${tenant.organisationId}, ${tenant.workId}, ${installationId},
          ${options?.months ?? 24}, ${options?.basis ?? 'installation'},
          ${options?.pacCertificateId ?? null}, ${startOn}, ${startOn},
          ${startOn}, ${tenant.userId}
        )
        returning id
      `;
      if (!row) throw new Error('warranty insert returned no row');
      return row.id;
    },
  );
}

function asTenant<T>(work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withTenant(
    database.appPool,
    { organisationId: tenant.organisationId, userId: tenant.userId },
    work,
  );
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-warranty-admin',
  });
  await admin`select 1 as ready`;
  await dropStaleTemporaryDatabases(admin, PREFIX);
  database = await createTemporaryDatabase(admin, PREFIX);
  await migrateToHead(database);
  tenant = await seedTenant(database.pool);

  const [schedule] = await database.pool<{ id: string }[]>`
    insert into work_schedules (
      organisation_id, work_id, schedule_code, title, position
    )
    values (${tenant.organisationId}, ${tenant.workId}, 'A', 'Schedule A', 1)
    returning id
  `;
  if (!schedule) throw new Error('schedule seed failed');
  const [item] = await database.pool<{ id: string }[]>`
    insert into work_items (
      organisation_id, work_id, schedule_id, item_number, description,
      unit_code, awarded_quantity, effective_rate
    )
    values (
      ${tenant.organisationId}, ${tenant.workId}, ${schedule.id}, '1',
      'Warranty fixture item', 'Nos', 500.000, 100.00
    )
    returning id
  `;
  if (!item) throw new Error('work item seed failed');
  workItemId = item.id;

  const [location] = await database.pool<{ id: string }[]>`
    insert into location_masters (organisation_id, name, kind, created_by_user_id)
    values (${tenant.organisationId}, 'Warranty fixture station', 'station',
            ${tenant.userId})
    returning id
  `;
  if (!location) throw new Error('location seed failed');
  locationId = location.id;

  const [row] = await database.pool<{ today: string; earliest: string }[]>`
    select app_private.organisation_today(${tenant.organisationId})::text as today,
           least(
             app_private.organisation_today(${tenant.organisationId}),
             w.letter_date + 1
           )::text as earliest
    from works w where w.id = ${tenant.workId}
  `;
  today = row?.today ?? '';
  earliestInstalledOn = row?.earliest ?? today;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (database !== undefined) await dropTemporaryDatabase(admin, database);
  await admin?.end();
}, SETUP_TIMEOUT_MS);

describe('when a defect liability period ends', () => {
  it('counts the anniversary, and stops on the day before it', async () => {
    // The whole pack turns on this one arithmetic. A 24-month period
    // starting 3 February 2026 covers up to and including 2 February
    // 2028: the anniversary is the first day OUT of cover.
    const [row] = await database.pool<
      { two_years: string; leap: string; month_end: string; ceiling: string }[]
    >`
      select app_private.warranty_expiry('2026-02-03'::date, 24)::text as two_years,
             app_private.warranty_expiry('2024-02-29'::date, 12)::text as leap,
             app_private.warranty_expiry('2026-03-31'::date, 12)::text as month_end,
             app_private.warranty_expiry('2026-02-03'::date, 120)::text as ceiling
    `;
    expect(row?.two_years).toBe('2028-02-02');
    // A period starting on a leap day ends the day before the following
    // 28 February, because PostgreSQL clamps the month addition — the
    // anniversary convention, not a day count.
    expect(row?.leap).toBe('2025-02-27');
    expect(row?.month_end).toBe('2027-03-30');
    expect(row?.ceiling).toBe('2036-02-02');
  });

  it('derives the expiry rather than believing the writer', async () => {
    const installation = await recordInstallation(today);
    // Both expiry columns were sent as the START date; the guard
    // overwrites them, so a writer cannot mint a period that runs to
    // whatever it liked.
    const id = await startPeriod(installation, { months: 24, startOn: today });
    const [row] = await database.pool<
      { dlp_expires_on: string; original_expires_on: string }[]
    >`
      select dlp_expires_on::text as dlp_expires_on,
             original_expires_on::text as original_expires_on
      from installation_warranties where id = ${id}
    `;
    const [expected] = await database.pool<{ expiry: string }[]>`
      select app_private.warranty_expiry(${today}::date, 24)::text as expiry
    `;
    expect(row?.dlp_expires_on).toBe(expected?.expiry);
    expect(row?.original_expires_on).toBe(expected?.expiry);
  });
});

describe('starting a defect liability period', () => {
  it('refuses an installation that is not recorded', async () => {
    const installation = await recordInstallation(today);
    await database.pool`
      update installations
      set status = 'cancelled', cancellation_note = 'fixture cancel',
          cancelled_by_user_id = ${tenant.userId}, cancelled_at = now()
      where id = ${installation}
    `;
    const failure = await refused(startPeriod(installation));
    expect(failure.code).toBe('23Q01');
  });

  it('refuses a start before the installation date, and one in the future', async () => {
    const installation = await recordInstallation(today);
    const early = await refused(startPeriod(installation, { startOn: '2025-06-02' }));
    expect(early.code).toBe('23Q02');

    const [ahead] = await database.pool<{ day: string }[]>`
      select (${today}::date + 1)::text as day
    `;
    const future = await refused(
      startPeriod(installation, { startOn: ahead?.day ?? today }),
    );
    expect(future.code).toBe('23Q02');
  });

  it('holds one live period per installation, and releases the slot on void', async () => {
    const installation = await recordInstallation(today);
    const first = await startPeriod(installation);
    const second = await refused(startPeriod(installation));
    // The partial unique index, not a guard: a second live period loses
    // this race however it arrives.
    expect(second.code).toBe('23505');

    await asTenant(async (tx) => {
      await tx`
        update installation_warranties
        set status = 'voided', void_note = 'started in error',
            voided_by_user_id = ${tenant.userId}, voided_at = now()
        where id = ${first}
      `;
    });
    // Voiding releases the slot, which is what makes void-and-start-again
    // the correction path.
    await expect(startPeriod(installation)).resolves.toBeTypeOf('string');
  });

  it('refuses a PAC basis whose certificate does not certify the item', async () => {
    // Dated well back, so the wrong-day probe below lands AFTER the
    // installation and therefore reaches the PAC rule rather than being
    // stopped by the start-before-installation one.
    const installation = await recordInstallation(earliestInstalledOn);
    const [certificate] = await database.pool<{ id: string }[]>`
      insert into pac_certificates (
        organisation_id, work_id, reference, issue_date, consignee_master_id,
        consignee_designation, recorded_by_user_id
      )
      values (
        ${tenant.organisationId}, ${tenant.workId},
        ${`PAC-${String(installationCounter)}`}, ${today}, ${tenant.buyerId},
        'Sr. DEE fixture', ${tenant.userId}
      )
      returning id
    `;
    if (!certificate) throw new Error('PAC seed failed');

    // No line for this item yet.
    const uncovered = await refused(
      startPeriod(installation, {
        basis: 'pac',
        pacCertificateId: certificate.id,
        startOn: today,
      }),
    );
    expect(uncovered.code).toBe('23Q03');

    await database.pool`
      insert into pac_certificate_items (
        organisation_id, pac_certificate_id, work_id, work_item_id,
        certified_quantity
      )
      values (${tenant.organisationId}, ${certificate.id}, ${tenant.workId},
              ${workItemId}, '1.000')
    `;
    // Covered now, but the start date must BE the certificate's issue
    // date; a period may not start from a day the certificate does not
    // carry.
    const [earlier] = await database.pool<{ day: string }[]>`
      select (${today}::date - 1)::text as day
    `;
    const wrongDay = await refused(
      startPeriod(installation, {
        basis: 'pac',
        pacCertificateId: certificate.id,
        startOn: earlier?.day ?? today,
      }),
    );
    expect(wrongDay.code).toBe('23Q03');

    await expect(
      startPeriod(installation, {
        basis: 'pac',
        pacCertificateId: certificate.id,
        startOn: today,
      }),
    ).resolves.toBeTypeOf('string');
  });
});

describe('a live defect liability period', () => {
  it('freezes the facts it was started with', async () => {
    const installation = await recordInstallation(today);
    const id = await startPeriod(installation);
    const failure = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update installation_warranties set dlp_months = 36 where id = ${id}
          `,
      ),
    );
    expect(failure.code).toBe('23Q05');
  });

  it('extends forward only, and never past ten years from the start', async () => {
    const installation = await recordInstallation(today);
    const id = await startPeriod(installation, { months: 12 });
    const [dates] = await database.pool<
      { back: string; forward: string; over: string }[]
    >`
      select (dlp_expires_on - 1)::text as back,
             (dlp_expires_on + 30)::text as forward,
             (app_private.warranty_expiry(dlp_start_on, 120) + 1)::text as over
      from installation_warranties where id = ${id}
    `;
    const backwards = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update installation_warranties
            set dlp_expires_on = ${dates?.back ?? today} where id = ${id}
          `,
      ),
    );
    expect(backwards.code).toBe('23Q06');

    const past = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update installation_warranties
            set dlp_expires_on = ${dates?.over ?? today} where id = ${id}
          `,
      ),
    );
    expect(past.code).toBe('23Q06');

    await asTenant(async (tx) => {
      await tx`
        update installation_warranties
        set dlp_expires_on = ${dates?.forward ?? today} where id = ${id}
      `;
    });
    const [row] = await database.pool<
      { dlp_expires_on: string; original_expires_on: string }[]
    >`
      select dlp_expires_on::text as dlp_expires_on,
             original_expires_on::text as original_expires_on
      from installation_warranties where id = ${id}
    `;
    // The figure the period BEGAN with survives the extension, so an
    // extended record still says what it was.
    expect(row?.dlp_expires_on).toBe(dates?.forward);
    expect(row?.original_expires_on).not.toBe(dates?.forward);
  });

  it('refuses a discharge before the expiry, and one in the future', async () => {
    const installation = await recordInstallation(today);
    const id = await startPeriod(installation, { months: 12 });
    const early = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update installation_warranties
            set status = 'closed', closed_on = ${today},
                closure_note = 'no defects reported',
                closed_by_user_id = ${tenant.userId}, closed_at = now()
            where id = ${id}
          `,
      ),
    );
    expect(early.code).toBe('23Q07');
  });

  it('discharges once the period has run out, and is terminal afterwards', async () => {
    // A period started at the earliest date this Work admits and running
    // one month has elapsed long since, which is the only state a
    // discharge is legal from.
    const installation = await recordInstallation(earliestInstalledOn);
    const id = await startPeriod(installation, {
      months: 1,
      startOn: earliestInstalledOn,
    });
    await asTenant(async (tx) => {
      await tx`
        update installation_warranties
        set status = 'closed', closed_on = ${today},
            closure_note = 'no defects reported',
            closed_by_user_id = ${tenant.userId}, closed_at = now()
        where id = ${id}
      `;
    });

    const reopened = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update installation_warranties set status = 'active' where id = ${id}
          `,
      ),
    );
    expect(reopened.code).toBe('23Q04');

    // A discharged period cannot be voided either: the cycle is complete,
    // and the record it rests on is permanent from that point.
    const voided = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update installation_warranties
            set status = 'voided', void_note = 'changed my mind',
                voided_by_user_id = ${tenant.userId}, voided_at = now()
            where id = ${id}
          `,
      ),
    );
    expect(voided.code).toBe('23Q04');
  });

  it('is voided with a note, never deleted', async () => {
    const installation = await recordInstallation(today);
    const id = await startPeriod(installation);
    const noNote = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update installation_warranties
            set status = 'voided', voided_by_user_id = ${tenant.userId},
                voided_at = now()
            where id = ${id}
          `,
      ),
    );
    // The mapped code, not the shape CHECK's own 23514: an unmapped
    // constraint violation reaches an operator as a 500.
    expect(noNote.code).toBe('23Q07');

    const removed = await refused(
      asTenant(
        async (tx) => await tx`delete from installation_warranties where id = ${id}`,
      ),
    );
    // The application role holds no DELETE at all, so the privilege wall
    // answers before the guard does.
    expect(removed.code).toBe('42501');

    // The owner connection HAS the privilege, and meets the guard.
    const guarded = await refused(
      database.pool`delete from installation_warranties where id = ${id}`,
    );
    expect(guarded.code).toBe('23Q08');
  });
});

describe('what a period does to its installation', () => {
  it('refuses to cancel an installation carrying a period that is not voided', async () => {
    const installation = await recordInstallation(today);
    const id = await startPeriod(installation);
    const blocked = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update installations
            set status = 'cancelled', cancellation_note = 'recorded in error',
                cancelled_by_user_id = ${tenant.userId}, cancelled_at = now()
            where id = ${installation}
          `,
      ),
    );
    expect(blocked.code).toBe('23Q09');

    await asTenant(async (tx) => {
      await tx`
        update installation_warranties
        set status = 'voided', void_note = 'started in error',
            voided_by_user_id = ${tenant.userId}, voided_at = now()
        where id = ${id}
      `;
    });
    await asTenant(async (tx) => {
      await tx`
        update installations
        set status = 'cancelled', cancellation_note = 'recorded in error',
            cancelled_by_user_id = ${tenant.userId}, cancelled_at = now()
        where id = ${installation}
      `;
    });
    const [row] = await database.pool<{ status: string }[]>`
      select status from installations where id = ${installation}
    `;
    expect(row?.status).toBe('cancelled');
  });

  it('says nothing about any other change to an installation', async () => {
    // The cancel guard is WHEN-gated, so an ordinary touch of a record
    // carrying a live period is untouched by it.
    const installation = await recordInstallation(today);
    await startPeriod(installation);
    await asTenant(async (tx) => {
      await tx`
        update installations set remarks = remarks where id = ${installation}
      `;
    });
    const [row] = await database.pool<{ status: string }[]>`
      select status from installations where id = ${installation}
    `;
    expect(row?.status).toBe('recorded');
  });
});

describe("the Work's warranty term", () => {
  it('is editable, but keeps its tenant, Work and provenance', async () => {
    await asTenant(async (tx) => {
      await tx`
        insert into work_warranty_terms (
          organisation_id, work_id, dlp_months, start_basis, recorded_by_user_id
        )
        values (${tenant.organisationId}, ${tenant.workId}, 24, 'installation',
                ${tenant.userId})
        on conflict (organisation_id, work_id) do update
          set dlp_months = excluded.dlp_months
      `;
      await tx`
        update work_warranty_terms set dlp_months = 36, start_basis = 'pac'
        where work_id = ${tenant.workId}
      `;
    });
    const [row] = await database.pool<{ dlp_months: number; start_basis: string }[]>`
      select dlp_months, start_basis from work_warranty_terms
      where work_id = ${tenant.workId}
    `;
    expect(row?.dlp_months).toBe(36);
    expect(row?.start_basis).toBe('pac');

    const moved = await refused(
      asTenant(
        async (tx) =>
          await tx`
            update work_warranty_terms
            set recorded_by_user_id = 'someone-else' where work_id = ${tenant.workId}
          `,
      ),
    );
    expect(moved.code).toBe('23Q10');
  });

  it('holds one term per Work', async () => {
    const duplicate = await refused(
      asTenant(
        async (tx) =>
          await tx`
            insert into work_warranty_terms (
              organisation_id, work_id, dlp_months, start_basis,
              recorded_by_user_id
            )
            values (${tenant.organisationId}, ${tenant.workId}, 12,
                    'installation', ${tenant.userId})
          `,
      ),
    );
    expect(duplicate.code).toBe('23505');
  });
});
