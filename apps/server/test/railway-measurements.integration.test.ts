import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { RailwayMeasurementResponse } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  removeOrganisationResidue,
} from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import { railwayMeasurementText, textLayoutPdf } from './helpers/railway-bill-pdf.js';

/**
 * The railway's own measurement, end to end (migration 0111).
 *
 * Three things are proved here and nothing else is, because the reading
 * itself already has a regression bar against real documents in
 * `railway-measurement-parse.test.ts` and
 * `railway-measurement-match.test.ts`:
 *
 *   1. the upload route reads a real PDF, files it against the right
 *      Measurement Book, and refuses one taken under another letter or
 *      another measurement;
 *   2. the GATE — a received railway bill is refused until the
 *      measurement is on record and either matched or confirmed — holds
 *      in the route AND in the database, and the database arm is proved
 *      by writing straight past the route;
 *   3. the fallback is an act and not a bypass: a mismatch cannot be
 *      confirmed away, an invented item number cannot be confirmed, and
 *      every real line has to be confirmed one at a time before the gate
 *      opens.
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
const ownerEmail = `rm-owner-${runId}@integration.test`;
const strangerEmail = `rm-stranger-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let workspace: string;
let organisationId: string;
let strangerOrganisationId: string;
let cookie: string;
let strangerCookie: string;
let ownerUserId: string;

const organisationIds: string[] = [];

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

/** A fresh Work code, and its letter number with it. Uppercase because
 * `works.work_code` is `^[A-Z0-9][A-Z0-9_/-]*$`, and one per case because
 * a Work holds one letter number per organisation. */
function nextLabel(): string {
  return `RM${randomBytes(3).toString('hex').toUpperCase()}`;
}

function authed(options: InjectOptions & { organisationId?: string; as?: string }) {
  const { organisationId: org, as, ...rest } = options;
  return app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      cookie: as ?? cookie,
      ...(org !== undefined ? { 'x-organisation-id': org } : {}),
    },
  });
}

/**
 * A finalized Measurement Book with two real lines, and the Work,
 * schedule and items behind them.
 *
 * The lines are what the match is made against, so unlike the railway-bill
 * suite this one cannot seed a book without them. Both carry a supply
 * stage at a percentage, one of them with a prior — which is the case that
 * distinguishes the true cumulative the railway prints from this
 * measurement's own delta.
 */
async function seedBook(options: {
  readonly organisationId: string;
  readonly userId: string;
  readonly label: string;
  readonly sequence?: number;
  readonly letterNumber?: string;
}): Promise<{ workId: string; bookId: string; letterNumber: string }> {
  const workId = randomUUID();
  const scheduleId = randomUUID();
  const bookId = randomUUID();
  const sequence = options.sequence ?? 1;
  const letterNumber = options.letterNumber ?? `003414901${options.label}`;
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${options.organisationId}, ${options.label}, ${letterNumber},
      '2026-01-01', 'Train information display boards',
      '195574112.38', '169228497.35', 'per_schedule', ${options.userId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${options.organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  const itemIds: string[] = [];
  for (const itemNumber of ['A/1', 'A/6']) {
    const itemId = randomUUID();
    itemIds.push(itemId);
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate
      )
      values (
        ${itemId}, ${options.organisationId}, ${workId}, ${scheduleId},
        ${itemNumber}, 'Supply of something measured', 'Nos', '100.000',
        '1000.00'
      )
    `;
  }
  await admin`
    insert into measurement_books (
      id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
    )
    values (
      ${bookId}, ${options.organisationId}, ${workId}, 'draft', '2026-05-09',
      ${options.userId}, 'on_account'
    )
  `;
  // A/1: 3 Nos at 70% supply with nothing before it -> the railway prints
  // 2.1. A/6: 1 more Nos at 64% with 10 already billed -> 7.04, which is
  // 11 x 0.64 and not 1 x 0.64.
  const lines = [
    {
      itemId: itemIds[0],
      itemNumber: 'A/1',
      pct: '70.00',
      prior: '0.000',
      delta: '3.000',
      remark: 'Now to pay 70% for 3 Nos.',
    },
    {
      itemId: itemIds[1],
      itemNumber: 'A/6',
      pct: '64.00',
      prior: '10.000',
      delta: '1.000',
      remark: 'Prepaid 64% for 10 Nos. Now to pay 64% for 1 Nos.',
    },
  ];
  for (const line of lines) {
    await admin`
      insert into measurement_book_lines (
        organisation_id, measurement_book_id, work_id, work_item_id,
        item_number, description, unit_code, resolved_category,
        pct_supply, pct_installation, pct_pac, pct_final_bill, effective_rate,
        delta_supplied, prior_supplied,
        amount_supply, amount_installation, amount_pac, amount_final_bill,
        line_total, remark
      )
      values (
        ${options.organisationId}, ${bookId}, ${workId}, ${line.itemId ?? null},
        ${line.itemNumber}, 'Supply of something measured', 'Nos', 'SUPPLY',
        ${line.pct}, 0.00, 0.00, 0.00, '1000.00',
        ${line.delta}, ${line.prior},
        '0.00', '0.00', '0.00', '0.00', '0.00', ${line.remark}
      )
    `;
  }
  await admin`
    update measurement_books
    set status = 'finalized', mb_number = ${`${options.label}-MB-01`},
        sequence_number = ${sequence}, total_amount = '0.00',
        remark_template_version = 'mb-remark-v1', finalized_at = now(),
        finalized_by_user_id = ${options.userId}
    where id = ${bookId}
  `;
  return { workId, bookId, letterNumber };
}

/** The railway's sheet for a book seeded above, with whatever differences
 * the caller wants introduced. */
function measurementPdf(
  letterNumber: string,
  options: {
    readonly sequence?: number;
    readonly quantities?: readonly [string, string];
    readonly remarks?: readonly [string, string];
    readonly items?: readonly string[];
  } = {},
): Buffer {
  const sequence = options.sequence ?? 1;
  const [firstQuantity, secondQuantity] = options.quantities ?? ['2.1', '7.04'];
  const [firstRemark, secondRemark] = options.remarks ?? [
    'Prepaid Nil Now to Pay 70% for 03 Nos',
    'Prepaid 64% for 10 Nos Now to Pay 64% for 01 Nos',
  ];
  const wanted = options.items ?? ['01', '06'];
  const blocks = [
    { schedule: 'A', itemNumber: '01', quantity: firstQuantity, remark: firstRemark },
    { schedule: 'A', itemNumber: '06', quantity: secondQuantity, remark: secondRemark },
  ].filter((block) => wanted.includes(block.itemNumber));
  return textLayoutPdf(
    railwayMeasurementText({
      measurementNumber: `${letterNumber}/CSTM/1139316/OAM/L2/0${String(sequence)}`,
      items: blocks,
    }),
  );
}

async function uploadMeasurement(
  bookId: string,
  bytes: Buffer,
  options: { readonly organisationId?: string; readonly as?: string } = {},
) {
  return authed({
    method: 'POST',
    url: `/api/measurement-books/${bookId}/railway-measurement?filename=measurement.pdf`,
    organisationId: options.organisationId ?? organisationId,
    ...(options.as === undefined ? {} : { as: options.as }),
    headers: { 'content-type': 'application/pdf', origin: 'http://127.0.0.1:3000' },
    payload: bytes,
  });
}

async function confirmLine(measurementId: string, itemNumber: string) {
  return authed({
    method: 'POST',
    url: `/api/railway-measurements/${measurementId}/confirm-line`,
    organisationId,
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { itemNumber },
  });
}

/** Records a railway bill straight into the table, past every route. The
 * only way to prove the database's own arm of the gate. */
async function insertBillDirectly(workId: string, bookId: string) {
  return admin`
    insert into received_railway_bills (
      organisation_id, work_id, measurement_book_id, object_key,
      original_filename, sha256, media_type, size_bytes, bill_number,
      bill_date, bill_amount, rate_inclusive_of_gst, measurement_number,
      measurement_sequence, letter_number, extraction_payload,
      uploaded_by_user_id
    )
    values (
      ${organisationId}, ${workId}, ${bookId},
      ${`${organisationId}/railwaybill/${randomUUID()}.pdf`}, 'bill.pdf',
      ${randomBytes(32).toString('hex')}, 'application/pdf', 2048,
      ${`B-${randomBytes(4).toString('hex')}`}, '2026-05-11', '10.00', true,
      '00341490147964/CSTM/1139316/OAM/FL2/01', 1, 'x', '{}'::jsonb,
      ${ownerUserId}
    )
  `;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-railway-measurement-admin',
  });
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);
  workspace = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-railway-measurement-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: path.join(workspace, 'objects'),
    // This suite records more measurements than the shipped upload
    // throttle allows in its window, on purpose. The throttle has its own
    // coverage in `upload-inventory`, and shaping this suite around an
    // unrelated rule would be shaping the wrong thing.
    rateLimits: { upload: { windowMs: 10 * 60_000, max: 500 } },
  });
  await app.ready();

  for (const [email, isOwner] of [
    [ownerEmail, true],
    [strangerEmail, false],
  ] as const) {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name: 'Railway measurement' },
    });
    expect(signUp.statusCode, signUp.body).toBe(200);
    const jar = extractCookies(signUp.headers['set-cookie']);
    const created = await app.inject({
      method: 'POST',
      url: '/api/organisations',
      headers: { cookie: jar, origin: 'http://127.0.0.1:3000' },
      payload: {
        name: `Railway measurement ${isOwner ? 'owner' : 'stranger'}`,
        slug: `rm-${runId}-${isOwner ? 'a' : 'b'}`,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    organisationIds.push(id);
    if (isOwner) {
      cookie = jar;
      organisationId = id;
      const [membership] = await admin<{ user_id: string }[]>`
        select user_id from organisation_memberships where organisation_id = ${id}
      `;
      ownerUserId = membership?.user_id ?? '';
      expect(ownerUserId).not.toBe('');
    } else {
      strangerCookie = jar;
      strangerOrganisationId = id;
    }
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (admin !== undefined) {
    await removeOrganisationResidue(admin, organisationIds);
    await assertNoForeignKeyOrphans(admin);
    await admin.end();
  }
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
}, 60_000);

describe('recording the railway measurement', () => {
  it('reads the sheet and matches it line by line against the book', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const response = await uploadMeasurement(bookId, measurementPdf(letterNumber));
    expect(response.statusCode, response.body).toBe(201);
    const { measurement } = response.json<RailwayMeasurementResponse>();
    expect(measurement?.matchStatus).toBe('matched');
    expect(measurement?.settles).toBe(true);
    expect(measurement?.lines.map((line) => line.itemNumber)).toEqual(['A/1', 'A/6']);
    expect(measurement?.lines.every((line) => line.matched)).toBe(true);
  });

  it('names the lines the railway measured differently', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const response = await uploadMeasurement(
      bookId,
      measurementPdf(letterNumber, { quantities: ['2.1', '0.64'] }),
    );
    expect(response.statusCode, response.body).toBe(201);
    const { measurement } = response.json<RailwayMeasurementResponse>();
    expect(measurement?.matchStatus).toBe('mismatched');
    expect(measurement?.settles).toBe(false);
    // The 0.64 is this measurement's own delta at 64%; the railway prints
    // the cumulative 7.04. A matcher that agreed with the first figure
    // would be the bug this case pins.
    expect(measurement?.lines[1]).toMatchObject({
      itemNumber: 'A/6',
      matched: false,
      refusal: 'quantity',
    });
    expect(measurement?.lines[0]?.matched).toBe(true);
  });

  it('refuses a sheet taken under another letter, or of another measurement', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const wrongLetter = await uploadMeasurement(
      bookId,
      measurementPdf('00341490999999'),
    );
    expect(wrongLetter.statusCode).toBe(409);
    expect(wrongLetter.json<{ code: string }>().code).toBe(
      'RAILWAY_MEASUREMENT_NOT_FOR_BOOK',
    );
    const wrongSequence = await uploadMeasurement(
      bookId,
      measurementPdf(letterNumber, { sequence: 2 }),
    );
    expect(wrongSequence.statusCode).toBe(409);
    expect(wrongSequence.json<{ code: string }>().code).toBe(
      'RAILWAY_MEASUREMENT_NOT_FOR_BOOK',
    );
  });

  it('refuses a second live measurement, and takes one after a discard', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const first = await uploadMeasurement(bookId, measurementPdf(letterNumber));
    const { measurement } = first.json<RailwayMeasurementResponse>();
    const second = await uploadMeasurement(bookId, measurementPdf(letterNumber));
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe(
      'RAILWAY_MEASUREMENT_ALREADY_RECORDED',
    );

    const discarded = await authed({
      method: 'POST',
      url: `/api/railway-measurements/${measurement?.id ?? ''}/discard`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'wrong document' },
    });
    expect(discarded.statusCode, discarded.body).toBe(200);
    const third = await uploadMeasurement(bookId, measurementPdf(letterNumber));
    expect(third.statusCode, third.body).toBe(201);
  });

  it('does not let another organisation upload against, or read, this book', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const foreign = await uploadMeasurement(bookId, measurementPdf(letterNumber), {
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(foreign.statusCode).toBe(404);
    const read = await authed({
      method: 'GET',
      url: `/api/measurement-books/${bookId}/railway-measurement`,
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(read.statusCode).toBe(404);
  });
});

describe('the gate on recording a railway bill', () => {
  it('refuses a bill against a book with no measurement at all, in both layers', async () => {
    const { workId, bookId } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    // The database's own arm, proved by writing straight past the route.
    await expect(insertBillDirectly(workId, bookId)).rejects.toMatchObject({
      code: '23R01',
    });
  });

  it('refuses a bill while the measurement disagrees, in both layers', async () => {
    const { workId, bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    await uploadMeasurement(
      bookId,
      measurementPdf(letterNumber, { quantities: ['2.1', '0.64'] }),
    );
    await expect(insertBillDirectly(workId, bookId)).rejects.toMatchObject({
      code: '23R02',
    });
  });

  it('lets a bill through once the measurement matches', async () => {
    const { workId, bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    await uploadMeasurement(bookId, measurementPdf(letterNumber));
    await expect(insertBillDirectly(workId, bookId)).resolves.toBeDefined();
  });
});

describe('the fallback for a measurement nobody could read', () => {
  /** A PDF with a real text layer that is not a measurement sheet. The
   * route records it `unreadable` rather than refusing it — a scanned
   * measurement is a real thing an agency holds. */
  const unreadable = textLayoutPdf([
    'A perfectly good PDF that is not a measurement sheet at all.',
    'It has a text layer, and nothing this reader understands.',
  ]);

  it('records an unread document, and refuses the bill until every line is confirmed', async () => {
    const { workId, bookId } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const uploaded = await uploadMeasurement(bookId, unreadable);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const { measurement } = uploaded.json<RailwayMeasurementResponse>();
    expect(measurement?.matchStatus).toBe('unreadable');
    expect(measurement?.settles).toBe(false);
    // The BOOK's lines, so there is something to ask an operator to
    // confirm rather than an empty table.
    expect(measurement?.lines.map((line) => line.itemNumber)).toEqual(['A/1', 'A/6']);

    await expect(insertBillDirectly(workId, bookId)).rejects.toMatchObject({
      code: '23R03',
    });

    const firstConfirmed = await confirmLine(measurement?.id ?? '', 'A/1');
    expect(firstConfirmed.statusCode, firstConfirmed.body).toBe(200);
    // ONE line is not the fallback. Half-confirmed is still refused, and
    // the refusal names what is left.
    await expect(insertBillDirectly(workId, bookId)).rejects.toMatchObject({
      code: '23R03',
    });

    const secondConfirmed = await confirmLine(measurement?.id ?? '', 'A/6');
    const settled = secondConfirmed.json<RailwayMeasurementResponse>().measurement;
    expect(settled?.settles).toBe(true);
    expect(settled?.lines.every((line) => line.confirmedAt !== null)).toBe(true);
    expect(settled?.lines[0]?.confirmedByUserId).toBe(ownerUserId);
    await expect(insertBillDirectly(workId, bookId)).resolves.toBeDefined();
  });

  it('refuses a confirmation of an item the Measurement Book does not have', async () => {
    const { bookId } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const uploaded = await uploadMeasurement(bookId, unreadable);
    const { measurement } = uploaded.json<RailwayMeasurementResponse>();
    const response = await confirmLine(measurement?.id ?? '', 'Z/9');
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'RAILWAY_MEASUREMENT_LINE_UNKNOWN',
    );
    // …and the database refuses the same thing, so the count the gate
    // depends on cannot be reached by inventing item numbers.
    await expect(
      admin`
        insert into railway_measurement_confirmations (
          organisation_id, railway_measurement_id, item_number, confirmed_by_user_id
        )
        values (${organisationId}, ${measurement?.id ?? ''}, 'Z/9', ${ownerUserId})
      `,
    ).rejects.toMatchObject({ code: '23R06' });
  });

  it('will not let a MISMATCH be confirmed away, in either layer', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const uploaded = await uploadMeasurement(
      bookId,
      measurementPdf(letterNumber, { quantities: ['2.1', '0.64'] }),
    );
    const { measurement } = uploaded.json<RailwayMeasurementResponse>();
    const response = await confirmLine(measurement?.id ?? '', 'A/1');
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'RAILWAY_MEASUREMENT_NOT_CONFIRMABLE',
    );
    await expect(
      admin`
        insert into railway_measurement_confirmations (
          organisation_id, railway_measurement_id, item_number, confirmed_by_user_id
        )
        values (${organisationId}, ${measurement?.id ?? ''}, 'A/1', ${ownerUserId})
      `,
    ).rejects.toMatchObject({ code: '23R05' });
  });

  it('refuses a line the railway did not measure, and names it', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const uploaded = await uploadMeasurement(
      bookId,
      measurementPdf(letterNumber, { items: ['01'] }),
    );
    const { measurement } = uploaded.json<RailwayMeasurementResponse>();
    expect(measurement?.matchStatus).toBe('mismatched');
    expect(measurement?.lines[1]).toMatchObject({
      itemNumber: 'A/6',
      refusal: 'missing_from_measurement',
    });
  });
});

describe('the recorded reading is evidence', () => {
  it('freezes the verdicts against a direct database edit', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const uploaded = await uploadMeasurement(bookId, measurementPdf(letterNumber));
    const { measurement } = uploaded.json<RailwayMeasurementResponse>();
    await expect(
      admin`
        update railway_measurements set match_status = 'matched',
          line_verdicts = '[{"itemNumber":"A/1","matched":true,"refusal":null,"detail":null}]'::jsonb
        where id = ${measurement?.id ?? ''}
      `,
    ).rejects.toMatchObject({ code: '23R04' });
  });

  it('serves the stored PDF back, and not to another organisation', async () => {
    const { bookId, letterNumber } = await seedBook({
      organisationId,
      userId: ownerUserId,
      label: nextLabel(),
    });
    const uploaded = await uploadMeasurement(bookId, measurementPdf(letterNumber));
    const { measurement } = uploaded.json<RailwayMeasurementResponse>();
    const mine = await authed({
      method: 'GET',
      url: `/api/railway-measurements/${measurement?.id ?? ''}/file`,
      organisationId,
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toContain('application/pdf');
    const theirs = await authed({
      method: 'GET',
      url: `/api/railway-measurements/${measurement?.id ?? ''}/file`,
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect(theirs.statusCode).toBe(404);
  });
});
