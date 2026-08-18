import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  LdAssessment,
  RetentionRelease,
  WorkRetentionResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  removeOrganisationResidue,
} from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';

/**
 * Retention money, and liquidated damages (migration 0098).
 *
 * Three claims are proved here and everything else is scaffolding for
 * them:
 *
 *   1. What is HELD is derived from what the railway actually withheld,
 *      so a withdrawn receipt takes its retention out of the balance and
 *      nothing has to remember to keep a mirror table in step.
 *   2. A release can never take the balance negative, and the rule holds
 *      in BOTH layers — the route refuses it with a sentence, and the
 *      trigger refuses a writer that arrives around the route.
 *   3. The liquidated-damages arithmetic is the database's, once. The
 *      corpus below drives the three boundaries a railway argues about —
 *      "or part thereof", a delay that is not a delay, and the cap — and
 *      asserts the generated columns against figures worked out by hand.
 *
 * The bill and its closed Measurement Book are seeded with admin SQL for
 * the reason `bill-payments.integration.test.ts` gives about the same
 * fixture: the closure rules are proved end to end where they live, and
 * what this suite needs from them is only their result.
 */

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const runId = randomBytes(5).toString('hex');
const ownerEmail = `ret-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** The railway's own figure on every seeded bill. Round, so a reader of a
 * failure message can do the arithmetic in their head. */
const RAILWAY_BILL_AMOUNT = '1000000.00';
/** Every seeded Work is worth exactly one crore, for the same reason. */
const CONTRACT_VALUE = '10000000.00';
/** The completion date every seeded Work is contractually due on. */
const COMPLETION_DATE = '2023-01-01';

let admin: Sql;
let app: FastifyInstance;
let organisationId: string;
let cookie: string;
let ownerUserId: string;

const organisationIds: string[] = [];

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

function authed(options: InjectOptions & { organisationId?: string }) {
  const { organisationId: org, ...rest } = options;
  return app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      cookie,
      ...(org !== undefined ? { 'x-organisation-id': org } : {}),
    },
  });
}

function post(url: string, payload: Record<string, unknown>) {
  return authed({
    method: 'POST',
    url,
    organisationId,
    headers: { origin: 'http://127.0.0.1:3000' },
    payload,
  });
}

function put(url: string, payload: Record<string, unknown>) {
  return authed({
    method: 'PUT',
    url,
    organisationId,
    headers: { origin: 'http://127.0.0.1:3000' },
    payload,
  });
}

function read(workId: string) {
  return authed({
    method: 'GET',
    url: `/api/works/${workId}/retention`,
    organisationId,
  });
}

interface Fixture {
  readonly workId: string;
  readonly billId: string;
}

/** A Work with a closed Measurement Book and the bill prepared from it,
 * ready to take a payment advice. */
async function seedWork(label: string): Promise<Fixture> {
  const org = organisationId;
  const workId = randomUUID();
  const bookId = randomUUID();
  const billId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id,
      original_completion_date, current_completion_date
    )
    values (
      ${workId}, ${org}, ${`${label}-${runId.toUpperCase()}`},
      ${`LOA-${label}-${runId}`}, '2022-04-01',
      'Train information display boards', ${CONTRACT_VALUE}, ${CONTRACT_VALUE},
      'per_schedule', ${ownerUserId}, ${COMPLETION_DATE}, ${COMPLETION_DATE}
    )
  `;
  await admin`
    insert into measurement_books (
      id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
    )
    values (${bookId}, ${org}, ${workId}, 'draft', '2026-05-09', ${ownerUserId},
            'on_account')
  `;
  await admin`
    update measurement_books
    set status = 'finalized', mb_number = ${`${label}-MB-01`},
        sequence_number = 1, total_amount = ${RAILWAY_BILL_AMOUNT},
        remark_template_version = 'mb-remark-v1', finalized_at = now(),
        finalized_by_user_id = ${ownerUserId}
    where id = ${bookId}
  `;
  await admin`
    insert into bills (
      id, organisation_id, work_id, bill_number, lines_snapshot, total_amount,
      prepared_by_user_id, mb_id
    )
    values (
      ${billId}, ${org}, ${workId}, 1, '[]'::jsonb, ${RAILWAY_BILL_AMOUNT},
      ${ownerUserId}, ${bookId}
    )
  `;
  const [recorded] = await admin<{ id: string }[]>`
    insert into received_railway_bills (
      organisation_id, work_id, measurement_book_id, object_key,
      original_filename, sha256, media_type, size_bytes, bill_number,
      bill_date, bill_amount, rate_inclusive_of_gst, measurement_number,
      measurement_sequence, letter_number, extraction_payload,
      uploaded_by_user_id, signature_status, signature_verdict,
      signature_verified_at
    )
    values (
      ${org}, ${workId}, ${bookId}, ${`${org}/railwaybill/${bookId}.pdf`},
      'bill.pdf', ${'c'.repeat(64)}, 'application/pdf', 4096,
      ${`${label}/B1`}, '2026-05-11', ${RAILWAY_BILL_AMOUNT}, true,
      ${`${label}/OAM/FL2/01`}, 1, ${`LOA-${label}-${runId}`},
      '{"billNumber": "fixture"}'::jsonb, ${ownerUserId}, 'signed_and_intact',
      '{"signatures": [{"index": 1}, {"index": 2}, {"index": 3}]}'::jsonb,
      now()
    )
    returning id
  `;
  await admin`
    update measurement_books
    set closed_at = now(), closed_by_user_id = ${ownerUserId},
        closed_by_received_bill_id = ${recorded?.id ?? ''}
    where id = ${bookId}
  `;
  return { workId, billId };
}

/** A payment advice that withholds `securityDeposit` under the retention
 * head, recorded through the register that owns the fact. Returns the
 * payment id so a test can withdraw it. */
async function withhold(
  billId: string,
  receivedAmount: string,
  securityDeposit: string,
  reference: string,
  ldAmount?: string,
): Promise<string> {
  const response = await post(`/api/bills/${billId}/payments`, {
    receivedOn: '2026-06-01',
    receivedAmount,
    reference,
    deductions: [
      { category: 'SECURITY_DEPOSIT', amount: securityDeposit },
      ...(ldAmount === undefined
        ? []
        : [{ category: 'LIQUIDATED_DAMAGES', amount: ldAmount }]),
    ],
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

/** The contract's terms: 10% of each bill withheld to a 5% ceiling, and
 * damages at 0.5% per week capped at 10%. The rates every railway
 * conditions-of-contract example in this codebase uses. */
async function recordTerms(workId: string): Promise<void> {
  const response = await put(`/api/works/${workId}/retention-terms`, {
    retentionPercent: '10',
    retentionLimitPercent: '5',
    defectLiabilityMonths: 24,
    ldRatePercent: '0.5',
    ldPeriodDays: 7,
    ldCapPercent: '10',
    sourceClause: 'GCC 17B',
  });
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-retention-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the retention integration tests. ' +
        `Underlying error: ${String(error)}`,
    );
  }
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
  });
  await app.ready();

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: ownerEmail, password, name: 'Retention Owner' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  cookie = extractCookies(signUp.headers['set-cookie']);

  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'Retention Org', slug: `ret-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;
  organisationIds.push(organisationId);

  const [membership] = await admin<{ user_id: string }[]>`
    select user_id from organisation_memberships
    where organisation_id = ${organisationId}
  `;
  ownerUserId = membership?.user_id ?? '';
  expect(ownerUserId).not.toBe('');

  // The retention authority defaults to false and is deliberately NOT
  // granted to the founder by `create_organisation_with_owner` (0098's
  // header argues why), so the owner grants it to themselves here exactly
  // as they would on the Members screen. The issue authority is what the
  // payment register needs.
  await admin`
    update organisation_memberships
    set can_manage_retention = true, can_issue_documents = true,
        can_cancel_documents = true
    where organisation_id = ${organisationId}
  `;
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (admin !== undefined) {
    await removeOrganisationResidue(admin, organisationIds);
    await assertNoForeignKeyOrphans(admin);
    await admin.end();
  }
});

describe('the authority', () => {
  it('refuses every write to a member who does not hold it', async () => {
    const { workId } = await seedWork('RETAUTH');
    await admin`
      update organisation_memberships set can_manage_retention = false
      where organisation_id = ${organisationId}
    `;
    try {
      const terms = await put(`/api/works/${workId}/retention-terms`, {
        retentionPercent: '10',
      });
      expect(terms.statusCode, terms.body).toBe(403);
      expect(terms.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');

      const release = await post(`/api/works/${workId}/retention-releases`, {
        releasedOn: '2026-06-02',
        amount: '1.00',
        basis: 'pac',
      });
      expect(release.statusCode, release.body).toBe(403);

      // Reading is not gated: the position is part of the Work's own
      // financial picture, and a member who may see the Work may see what
      // the railway is holding against it.
      const position = await read(workId);
      expect(position.statusCode, position.body).toBe(200);
    } finally {
      await admin`
        update organisation_memberships set can_manage_retention = true
        where organisation_id = ${organisationId}
      `;
    }
  });
});

describe('the retention ledger', () => {
  it('derives what is held from the deductions the railway actually made', async () => {
    const { workId, billId } = await seedWork('RETHELD');
    const before = await read(workId);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json<WorkRetentionResponse>().position.retentionHeldTotal).toBe(
      '0.00',
    );

    await withhold(billId, '470000.00', '30000.00', 'UTR-RETHELD-1');
    const after = await read(workId);
    const position = after.json<WorkRetentionResponse>().position;
    expect(position.retentionHeldTotal).toBe('30000.00');
    expect(position.retentionReleasedTotal).toBe('0.00');
    expect(position.retentionBalance).toBe('30000.00');
  });

  it('takes the retention back out when the receipt that withheld it is withdrawn', async () => {
    const { workId, billId } = await seedWork('RETVOID');
    const paymentId = await withhold(billId, '470000.00', '30000.00', 'UTR-RETVOID-1');
    expect(
      (await read(workId)).json<WorkRetentionResponse>().position.retentionHeldTotal,
    ).toBe('30000.00');

    const withdrawn = await post(`/api/bill-payments/${paymentId}/void`, {
      reason: 'Advice was recorded against the wrong bill',
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);

    // The whole argument for deriving rather than mirroring: nothing in
    // this module was told the receipt went away, and the balance is
    // right anyway.
    const position = (await read(workId)).json<WorkRetentionResponse>().position;
    expect(position.retentionHeldTotal).toBe('0.00');
    expect(position.retentionBalance).toBe('0.00');
  });

  it('records a release, moves the balance, and refuses one that would take it negative', async () => {
    const { workId, billId } = await seedWork('RETREL');
    await withhold(billId, '470000.00', '30000.00', 'UTR-RETREL-1');

    const half = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '15000.00',
      basis: 'pac',
      reference: 'REL/RETREL/1',
    });
    expect(half.statusCode, half.body).toBe(201);
    expect(half.json<RetentionRelease>().amount).toBe('15000.00');

    const position = (await read(workId)).json<WorkRetentionResponse>().position;
    expect(position.retentionReleasedTotal).toBe('15000.00');
    expect(position.retentionBalance).toBe('15000.00');

    const tooMuch = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-11',
      amount: '15000.01',
      basis: 'defect_liability_end',
    });
    expect(tooMuch.statusCode, tooMuch.body).toBe(409);
    expect(tooMuch.json<{ code: string }>().code).toBe(
      'RETENTION_RELEASE_EXCEEDS_HELD',
    );
    // The refusal names what is left, because "too much" without a figure
    // sends the operator to a spreadsheet to work out what would fit.
    expect(tooMuch.json<{ message: string }>().message).toContain('15000.00');
  });

  /**
   * The other end of the same invariant, and it needs no concurrency to
   * open: the held side is DERIVED, so withdrawing the receipt that
   * withheld the retention can strand a release recorded against it. This
   * is the case the ceiling check in the release route cannot see, because
   * the act that breaks it does not write a release.
   */
  it('refuses to withdraw the receipt that withheld retention already released', async () => {
    const { workId, billId } = await seedWork('RETSTRAND');
    const paymentId = await withhold(
      billId,
      '470000.00',
      '30000.00',
      'UTR-RETSTRAND-1',
    );
    const release = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '30000.00',
      basis: 'pac',
    });
    expect(release.statusCode, release.body).toBe(201);

    const blocked = await post(`/api/bill-payments/${paymentId}/void`, {
      reason: 'Advice was recorded against the wrong bill',
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe('RETENTION_RELEASE_STRANDED');

    // And from the database, for a writer that arrives around the route.
    await expect(
      admin`
        update bill_payments
        set voided_at = now(), voided_by_user_id = ${ownerUserId},
            void_reason = 'Around the route'
        where id = ${paymentId}
      `,
    ).rejects.toMatchObject({ code: '23P08' });

    // The order the refusal asks for actually works, which is what makes
    // it a remedy rather than a dead end: withdraw the release, then the
    // receipt.
    const withdrawn = await post(
      `/api/retention-releases/${release.json<RetentionRelease>().id}/void`,
      { reason: 'Recorded against the wrong receipt' },
    );
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    const now = await post(`/api/bill-payments/${paymentId}/void`, {
      reason: 'Advice was recorded against the wrong bill',
    });
    expect(now.statusCode, now.body).toBe(200);
    const position = (await read(workId)).json<WorkRetentionResponse>().position;
    expect(position.retentionHeldTotal).toBe('0.00');
    expect(position.retentionReleasedTotal).toBe('0.00');
    expect(position.retentionBalance).toBe('0.00');
  });

  it('refuses the same release recorded twice, and frees the reference once it is withdrawn', async () => {
    const { workId, billId } = await seedWork('RETDUP');
    await withhold(billId, '470000.00', '30000.00', 'UTR-RETDUP-1');
    const first = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '1000.00',
      basis: 'pac',
      reference: 'REL/RETDUP/1',
    });
    expect(first.statusCode, first.body).toBe(201);

    const again = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '1000.00',
      basis: 'pac',
      reference: 'REL/RETDUP/1',
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe(
      'RETENTION_RELEASE_DUPLICATE_REFERENCE',
    );

    const withdrawn = await post(
      `/api/retention-releases/${first.json<RetentionRelease>().id}/void`,
      { reason: 'Keyed against the wrong Work' },
    );
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(
      (await read(workId)).json<WorkRetentionResponse>().position.retentionBalance,
    ).toBe('30000.00');

    const replacement = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '1000.00',
      basis: 'pac',
      reference: 'REL/RETDUP/1',
    });
    expect(replacement.statusCode, replacement.body).toBe(201);
  });

  it('refuses a release dated in the future, and a second withdrawal of one already withdrawn', async () => {
    const { workId, billId } = await seedWork('RETDATE');
    await withhold(billId, '470000.00', '30000.00', 'UTR-RETDATE-1');
    const future = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2099-01-01',
      amount: '1.00',
      basis: 'pac',
    });
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json<{ code: string }>().code).toBe('RETENTION_RELEASE_DATE_FUTURE');

    const release = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '1.00',
      basis: 'pac',
    });
    expect(release.statusCode, release.body).toBe(201);
    const releaseId = release.json<RetentionRelease>().id;
    expect(
      (await post(`/api/retention-releases/${releaseId}/void`, { reason: 'Mistake' }))
        .statusCode,
    ).toBe(200);
    const again = await post(`/api/retention-releases/${releaseId}/void`, {
      reason: 'Mistake again',
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe(
      'RETENTION_RELEASE_ALREADY_WITHDRAWN',
    );
  });

  it('needs a guarantee named when the basis is a substitution, and refuses one from another Work', async () => {
    const { workId, billId } = await seedWork('RETBG');
    const other = await seedWork('RETBG2');
    await withhold(billId, '470000.00', '30000.00', 'UTR-RETBG-1');

    const unnamed = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '1000.00',
      basis: 'bank_guarantee_substitution',
    });
    expect(unnamed.statusCode, unnamed.body).toBe(400);
    expect(unnamed.json<{ code: string }>().code).toBe('RETENTION_INSTRUMENT_REQUIRED');

    const [instrument] = await admin<{ id: string }[]>`
      insert into work_instruments (
        organisation_id, work_id, kind, reference, amount, issued_on,
        created_by_user_id
      )
      values (
        ${organisationId}, ${other.workId}, 'pbg', ${`BG/${runId}/1`},
        '30000.00', '2023-05-01', ${ownerUserId}
      )
      returning id
    `;
    const foreign = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '1000.00',
      basis: 'bank_guarantee_substitution',
      workInstrumentId: instrument?.id ?? '',
    });
    // A guarantee lodged against one contract does not secure a
    // different one, and the composite foreign key cannot see that —
    // both rows are in the same organisation.
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json<{ code: string }>().code).toBe('INSTRUMENT_NOT_FOUND');
  });

  it('refuses a release that would take the balance negative from the database as well', async () => {
    const { workId, billId } = await seedWork('RETTRIG');
    await withhold(billId, '470000.00', '100.00', 'UTR-RETTRIG-1');
    // Straight at the table, as the application role, bypassing the route
    // entirely. This is the arm that holds under concurrency and against
    // a writer that arrives another way.
    await expect(
      admin`
        insert into retention_releases (
          organisation_id, work_id, released_on, amount, basis,
          recorded_by_user_id
        )
        values (
          ${organisationId}, ${workId}, '2026-06-10', '100.01', 'pac',
          ${ownerUserId}
        )
      `,
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('refuses editing a recorded release, from the database', async () => {
    const { workId, billId } = await seedWork('RETIMM');
    await withhold(billId, '470000.00', '100.00', 'UTR-RETIMM-1');
    const release = await post(`/api/works/${workId}/retention-releases`, {
      releasedOn: '2026-06-10',
      amount: '50.00',
      basis: 'pac',
    });
    expect(release.statusCode, release.body).toBe(201);
    const releaseId = release.json<RetentionRelease>().id;
    await expect(
      admin`
        update retention_releases set amount = '10.00' where id = ${releaseId}
      `,
    ).rejects.toMatchObject({ code: '23P02' });
  });
});

describe('liquidated damages', () => {
  it('refuses an assessment on a Work whose contract terms have not been read', async () => {
    const { workId } = await seedWork('LDNOTERMS');
    const response = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2023-04-15',
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('LD_TERMS_MISSING');

    // And from the database, for a writer that arrives another way.
    await expect(
      admin`
        insert into ld_assessments (
          organisation_id, work_id, assessed_on, basis_amount, basis_label,
          scheduled_completion_date, assessed_to_date, ld_rate_percent,
          ld_period_days, ld_cap_percent, assessed_by_user_id
        )
        values (
          ${organisationId}, ${workId}, '2023-05-01', ${CONTRACT_VALUE},
          'Contract value', ${COMPLETION_DATE}, '2023-04-15', '0.5', 7, '10',
          ${ownerUserId}
        )
      `,
    ).rejects.toMatchObject({ code: '23P04' });
  });

  /**
   * The arithmetic, at the three boundaries a railway argues about.
   *
   * Every figure is worked out by hand from a one-crore basis at 0.5% per
   * week capped at 10%, so a failure names a number a reader can check
   * rather than a mismatch between two computations.
   */
  const CORPUS: readonly {
    readonly label: string;
    readonly to: string;
    readonly delayDays: number;
    readonly periods: number;
    readonly uncapped: string;
    readonly assessed: string;
  }[] = [
    // 104 days is 14 weeks and six days; "or part thereof" makes it 15.
    // 15 x 0.5% x 1,00,00,000 = 7,50,000, under the 10,00,000 cap.
    {
      label: 'rounds a part week up',
      to: '2023-04-15',
      delayDays: 104,
      periods: 15,
      uncapped: '750000.00',
      assessed: '750000.00',
    },
    // Exactly 14 weeks: 98 days, and no rounding to do. 7,00,000.
    {
      label: 'charges a whole number of weeks exactly',
      to: '2023-04-09',
      delayDays: 98,
      periods: 14,
      uncapped: '700000.00',
      assessed: '700000.00',
    },
    // One day late is one whole week: 50,000, which is the boundary an
    // agency is most often surprised by.
    {
      label: 'charges a whole period for one day late',
      to: '2023-01-02',
      delayDays: 1,
      periods: 1,
      uncapped: '50000.00',
      assessed: '50000.00',
    },
    // A delay that is not a delay: the assessment states nothing owed
    // rather than a negative levy.
    {
      label: 'assesses nothing when the work finished on time',
      to: COMPLETION_DATE,
      delayDays: 0,
      periods: 0,
      uncapped: '0.00',
      assessed: '0.00',
    },
    // 530 days is 75 weeks and five days, so 76 periods and 38% of the
    // basis uncapped — 38,00,000. The cap holds it at 10,00,000, which is
    // the fact worth arguing about and the reason both figures are stored.
    {
      label: 'holds the levy at the contractual cap',
      to: '2024-06-14',
      delayDays: 530,
      periods: 76,
      uncapped: '3800000.00',
      assessed: '1000000.00',
    },
  ];

  it('computes the damages in the database, at every boundary', async () => {
    for (const entry of CORPUS) {
      const { workId } = await seedWork(
        `LD${entry.periods}${entry.delayDays}`.slice(0, 12),
      );
      await recordTerms(workId);
      const response = await post(`/api/works/${workId}/ld-assessments`, {
        assessedOn: '2024-07-01',
        assessedToDate: entry.to,
      });
      expect(response.statusCode, `${entry.label}: ${response.body}`).toBe(201);
      const assessment = response.json<LdAssessment>();
      expect(assessment.delayDays, entry.label).toBe(entry.delayDays);
      expect(assessment.chargeablePeriods, entry.label).toBe(entry.periods);
      expect(assessment.uncappedAmount, entry.label).toBe(entry.uncapped);
      expect(assessment.capAmount, entry.label).toBe('1000000.00');
      expect(assessment.assessedAmount, entry.label).toBe(entry.assessed);
      expect(assessment.basisLabel, entry.label).toBe('Contract value');
    }
  });

  it('freezes the terms it was computed from, so a later edit rewrites nothing', async () => {
    const { workId } = await seedWork('LDFREEZE');
    await recordTerms(workId);
    const first = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2023-04-15',
    });
    expect(first.statusCode, first.body).toBe(201);
    const assessment = first.json<LdAssessment>();
    expect(assessment.assessedAmount).toBe('750000.00');

    // Double the rate and re-read. The assessment already made keeps its
    // own snapshot: master-data edits never rewrite history.
    const changed = await put(`/api/works/${workId}/retention-terms`, {
      retentionPercent: '10',
      retentionLimitPercent: '5',
      ldRatePercent: '1',
      ldPeriodDays: 7,
      ldCapPercent: '10',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const reread = (await read(workId)).json<WorkRetentionResponse>();
    expect(reread.assessments[0]?.ldRatePercent).toBe('0.500');
    expect(reread.assessments[0]?.assessedAmount).toBe('750000.00');

    // And the snapshot cannot be edited in place, from either layer.
    await expect(
      admin`
        update ld_assessments set ld_rate_percent = '1' where id = ${assessment.id}
      `,
    ).rejects.toMatchObject({ code: '23P05' });
  });

  it('refuses a window that runs backwards, and a second draft', async () => {
    const { workId } = await seedWork('LDWINDOW');
    await recordTerms(workId);
    const backwards = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2022-12-31',
    });
    expect(backwards.statusCode, backwards.body).toBe(400);
    expect(backwards.json<{ code: string }>().code).toBe(
      'LD_ASSESSMENT_WINDOW_INVALID',
    );

    const first = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2023-04-15',
    });
    expect(first.statusCode, first.body).toBe(201);
    const second = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-02',
      assessedToDate: '2023-04-16',
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('LD_DRAFT_EXISTS');
  });

  it('walks the decisions forwards and never back', async () => {
    const { workId } = await seedWork('LDDECIDE');
    await recordTerms(workId);
    const draft = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2023-04-15',
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const id = draft.json<LdAssessment>().id;

    const tooMuch = await post(`/api/ld-assessments/${id}/decision`, {
      decision: 'levy',
      leviedAmount: '750000.01',
    });
    expect(tooMuch.statusCode, tooMuch.body).toBe(409);
    expect(tooMuch.json<{ code: string }>().code).toBe('LD_LEVY_EXCEEDS_ASSESSMENT');

    const levied = await post(`/api/ld-assessments/${id}/decision`, {
      decision: 'levy',
      leviedAmount: '500000.00',
      levyReference: 'LD/2026/07',
    });
    expect(levied.statusCode, levied.body).toBe(200);
    expect(levied.json<LdAssessment>().status).toBe('levied');
    expect(levied.json<LdAssessment>().leviedAmount).toBe('500000.00');

    // A remission is real: a levy returned at final settlement keeps the
    // levied amount on the row, so the record says money was taken and
    // came back.
    const waived = await post(`/api/ld-assessments/${id}/decision`, {
      decision: 'waive',
      reason: 'Remitted at final settlement',
    });
    expect(waived.statusCode, waived.body).toBe(200);
    expect(waived.json<LdAssessment>().status).toBe('waived');
    expect(waived.json<LdAssessment>().leviedAmount).toBe('500000.00');

    const again = await post(`/api/ld-assessments/${id}/decision`, {
      decision: 'cancel',
      reason: 'Changed our mind',
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('LD_ASSESSMENT_STATUS_CONFLICT');

    // And the database refuses the rewind the route just refused.
    await expect(
      admin`update ld_assessments set status = 'draft' where id = ${id}`,
    ).rejects.toMatchObject({ code: '23P05' });
  });

  it('reports what was levied and what the railway deducted side by side, never netted', async () => {
    const { workId, billId } = await seedWork('LDBOTH');
    await recordTerms(workId);
    // The railway kept ₹4,00,000 under the damages head on its advice.
    await withhold(billId, '570000.00', '30000.00', 'UTR-LDBOTH-1', '400000.00');
    const draft = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2023-04-15',
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const levied = await post(
      `/api/ld-assessments/${draft.json<LdAssessment>().id}/decision`,
      { decision: 'levy', leviedAmount: '750000.00' },
    );
    expect(levied.statusCode, levied.body).toBe(200);

    const position = (await read(workId)).json<WorkRetentionResponse>().position;
    // Two claims about the same event, and the product states both. The
    // difference is a conversation with the railway; there is no third
    // figure claiming to be an outstanding balance.
    expect(position.ldLeviedTotal).toBe('750000.00');
    expect(position.ldDeductedTotal).toBe('400000.00');
    expect(position.retentionHeldTotal).toBe('30000.00');
  });

  it('states the ceiling in rupees from the recorded percentage', async () => {
    const { workId } = await seedWork('LDCEIL');
    await recordTerms(workId);
    const position = (await read(workId)).json<WorkRetentionResponse>().position;
    // 5% of one crore.
    expect(position.retentionCeilingAmount).toBe('500000.00');
    expect(position.contractValue).toBe(CONTRACT_VALUE);
  });

  it('names the basis a Work with no contract value cannot default, rather than raising a CHECK', async () => {
    const { workId } = await seedWork('LDZERO');
    await admin`
      update works set contract_value = '0.00' where id = ${workId}
    `;
    await recordTerms(workId);
    const response = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2023-04-15',
    });
    // Without the route check this is `basis_amount > 0` as a bare 23514,
    // which reaches the operator as "The request could not be completed."
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('LD_ASSESSMENT_WINDOW_INVALID');

    // And the way out works: state the basis the contract charges on.
    const withBasis = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2023-04-15',
      basisAmount: '1000000.00',
      basisLabel: 'Value of the delayed portion',
    });
    expect(withBasis.statusCode, withBasis.body).toBe(201);
    expect(withBasis.json<LdAssessment>().assessedAmount).toBe('75000.00');
  });
});

describe('the contract terms', () => {
  it('refuses two thirds of the damages triple and a record that states nothing', async () => {
    const { workId } = await seedWork('TERMSHAPE');
    const partial = await put(`/api/works/${workId}/retention-terms`, {
      ldRatePercent: '0.5',
      ldPeriodDays: 7,
    });
    expect(partial.statusCode, partial.body).toBe(400);
    expect(partial.json<{ code: string }>().code).toBe('RETENTION_TERMS_LD_INCOMPLETE');

    const empty = await put(`/api/works/${workId}/retention-terms`, {
      sourceClause: 'GCC 17B',
    });
    expect(empty.statusCode, empty.body).toBe(400);
    expect(empty.json<{ code: string }>().code).toBe('RETENTION_TERMS_EMPTY');
  });

  it('replaces the whole record, so a term recorded in error can be cleared', async () => {
    const { workId } = await seedWork('TERMCLEAR');
    await recordTerms(workId);
    const cleared = await put(`/api/works/${workId}/retention-terms`, {
      retentionPercent: '10',
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const terms = (await read(workId)).json<WorkRetentionResponse>().terms;
    expect(terms?.retentionPercent).toBe('10.000');
    // A patch would have left these standing, which is what makes an
    // over-read letter uncorrectable.
    expect(terms?.ldRatePercent).toBeNull();
    expect(terms?.defectLiabilityMonths).toBeNull();
  });

  it('clears them entirely, and leaves every assessment already made alone', async () => {
    const { workId } = await seedWork('TERMDEL');
    await recordTerms(workId);
    const assessed = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-01',
      assessedToDate: '2023-04-15',
    });
    expect(assessed.statusCode, assessed.body).toBe(201);

    const removed = await authed({
      method: 'DELETE',
      url: `/api/works/${workId}/retention-terms`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const after = (await read(workId)).json<WorkRetentionResponse>();
    expect(after.terms).toBeNull();
    // The not-empty CHECK means a terms row can never be edited down to
    // nothing, so without this route a Work whose letter was misread
    // would assert the wrong rates forever. What it must NOT do is
    // rewrite a figure already put in front of the railway.
    expect(after.assessments[0]?.ldRatePercent).toBe('0.500');
    expect(after.assessments[0]?.assessedAmount).toBe('750000.00');

    // And nothing new can be assessed until the terms are read again.
    const blocked = await post(`/api/works/${workId}/ld-assessments`, {
      assessedOn: '2023-05-02',
      assessedToDate: '2023-04-16',
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json<{ code: string }>().code).toBe('LD_TERMS_MISSING');

    const again = await authed({
      method: 'DELETE',
      url: `/api/works/${workId}/retention-terms`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
    });
    expect(again.statusCode, again.body).toBe(404);
    expect(again.json<{ code: string }>().code).toBe('RETENTION_TERMS_NOT_FOUND');
  });
});
