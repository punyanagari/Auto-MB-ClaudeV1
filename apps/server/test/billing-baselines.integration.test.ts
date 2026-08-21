import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  MeasurementBookDetailResponse,
  WorkBillingBaselineResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import {
  railwayBillText,
  railwayMeasurementText,
  textLayoutPdf,
} from './helpers/railway-bill-pdf.js';

/**
 * The opening billing position of a pre-system Work, end to end
 * (migration 0114; owner ruling, live-testing corrections item 23).
 *
 * The reading itself already has its regression bar against real
 * documents — `billing-baseline-propose.test.ts` proposes from MB-3 of
 * the settlement corpus and `railway-bill-parse.test.ts` reads the bills.
 * What is proved HERE is everything only a database and a live app can
 * answer:
 *
 *   1. the propose-and-prove loop: an uploaded sheet fills the lines,
 *      editing one un-confirms it, and the lock counts confirmations;
 *   2. RESUMPTION — the locked baseline moves the Work's Measurement Book
 *      counter to the railway's own sequence plus one, and seeds the
 *      engine's prior-cumulative memory so the next book bills the delta
 *      rather than re-billing what the railway already paid;
 *   3. every refusal in BOTH layers, with the database arm proved by
 *      writing straight past the route.
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
const ownerEmail = `bb-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let workspace: string;
let organisationId: string;
let ownerUserId: string;
let cookie: string;
let fakeGotenberg: http.Server;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

function authed(options: InjectOptions) {
  return app.inject({
    ...options,
    headers: {
      ...(options.headers ?? {}),
      cookie,
      'x-organisation-id': organisationId,
      origin: 'http://127.0.0.1:3000',
    },
  });
}

function nextLabel(): string {
  return `BB${randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * A Work as the v1 cutover leaves one: schedule, items, a payment matrix,
 * and NO Measurement Book at all. The whole point of the baseline is that
 * this Work has been billed for years and this product cannot be told.
 */
async function seedImportedWork(): Promise<{
  workId: string;
  label: string;
  itemIds: readonly string[];
}> {
  const workId = randomUUID();
  const scheduleId = randomUUID();
  const label = nextLabel();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${label}, ${`00341490147${label}`},
      '2026-01-01', 'Imported pre-system work',
      '1000000.00', '900000.00', 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  const itemIds: string[] = [];
  for (const itemNumber of ['A/1', 'A/6']) {
    const itemId = randomUUID();
    itemIds.push(itemId);
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (
        ${itemId}, ${organisationId}, ${workId}, ${scheduleId},
        ${itemNumber}, 'Supply of something measured', 'Nos', '100.000',
        '1000.00', 'SUPPLY'
      )
    `;
  }
  await admin`
    insert into payment_matrices (
      organisation_id, work_id, category, pct_supply, pct_installation,
      pct_pac, pct_final_bill, created_by_user_id
    )
    values (
      ${organisationId}, ${workId}, 'SUPPLY', '70.00', '20.00', '0.00', '10.00',
      ${ownerUserId}
    )
  `;
  return { workId, label, itemIds };
}

/** The Work's last railway bill, as a PDF whose own text this product can
 * read. Sequence 04, so the resumption assertion has something to prove:
 * the next book this product numbers must be 05. */
function billPdf(sequence = '04'): Buffer {
  return textLayoutPdf(
    railwayBillText({
      billNumber: `CR/BBY/S&T/2026/${runId}/B${sequence}`,
      measurementTail: `16/OAM/FL2/${sequence}`,
      billAmount: '2100000',
    }),
  );
}

/** The measurement sheet that bill was raised from: A/1 has been paid 70%
 * on 20 Nos, A/6 nothing at all. */
function measurementPdf(): Buffer {
  return textLayoutPdf(
    railwayMeasurementText({
      measurementNumber: '00341490147964/CSTM/1139316/OAM/L2/04',
      items: [
        {
          schedule: 'A',
          itemNumber: '01',
          quantity: '14',
          remark: 'Prepaid 70% for 12 Nos Now to Pay 70% for 08 Nos',
        },
        {
          schedule: 'A',
          itemNumber: '06',
          quantity: '0',
          remark: 'Prepaid Nil Now to Pay Nil',
        },
      ],
    }),
  );
}

async function uploadBill(workId: string, bytes: Buffer, query = '') {
  return authed({
    method: 'POST',
    url: `/api/works/${workId}/billing-baseline?filename=bill.pdf${query}`,
    headers: { 'content-type': 'application/pdf' },
    payload: bytes,
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-billing-baseline-admin',
  });
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);
  workspace = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-billing-baseline-'));
  // A stub PDF service (the challan integration pattern): the resumption
  // test issues a real delivery challan so the next draft has a line to
  // read its baseline-seeded prior off, and issuing renders a PDF.
  fakeGotenberg = http.createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      response.setHeader('content-type', 'application/pdf');
      response.end(Buffer.from(`%PDF-1.4 stub ${runId}`));
    });
  });
  await new Promise<void>((resolve) => {
    fakeGotenberg.listen(0, '127.0.0.1', resolve);
  });
  const gotenbergAddress = fakeGotenberg.address();
  if (gotenbergAddress === null || typeof gotenbergAddress === 'string') {
    throw new Error('stub Gotenberg failed to bind a port');
  }
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: path.join(workspace, 'objects'),
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
    rateLimits: { upload: { windowMs: 10 * 60_000, max: 500 } },
  });
  await app.ready();

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: ownerEmail, password, name: 'Billing baseline' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  cookie = extractCookies(signUp.headers['set-cookie']);
  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: `Billing baseline ${runId}`, slug: `bb-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;
  const [member] = await admin<{ user_id: string }[]>`
    select user_id from organisation_memberships
    where organisation_id = ${organisationId}
  `;
  ownerUserId = member?.user_id ?? '';
}, 120_000);

afterAll(async () => {
  await app?.close();
  fakeGotenberg?.close();
  if (organisationId) await removeOrganisationResidue(admin, [organisationId]);
  await admin?.end();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe('the opening billing position', () => {
  it('proposes from the railway sheet, un-confirms an edited line, and locks on a full count', async () => {
    const work = await seedImportedWork();

    const created = await uploadBill(work.workId, billPdf());
    expect(created.statusCode, created.body).toBe(201);
    const first = created.json<WorkBillingBaselineResponse>();
    // The bill's own text supplied every figure, so the row records that
    // nobody typed them.
    expect(first.baseline?.billSource).toBe('extracted');
    expect(first.baseline?.lastMbSequenceNumber).toBe(4);
    // One line per priced item, empty and unconfirmed. A baseline states
    // a position for EVERY item; a stage left silently at zero because
    // nobody made a row for it is what this shape prevents.
    expect(first.lines).toHaveLength(2);
    expect(first.lines.every((line) => line.confirmedAt === null)).toBe(true);
    expect(first.grossBilledToDate).toBe('0.00');
    const baselineId = first.baseline?.id ?? '';

    const proposed = await authed({
      method: 'POST',
      url: `/api/billing-baselines/${baselineId}/measurement?filename=sheet.pdf`,
      headers: { 'content-type': 'application/pdf' },
      payload: measurementPdf(),
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const withProposal = proposed.json<WorkBillingBaselineResponse>();
    const a1 = withProposal.lines.find((line) => line.itemNumber === 'A/1');
    // "Prepaid 70% for 12 Nos Now to Pay 70% for 08 Nos" — one cumulative
    // per stage, both halves of the sentence summed.
    // Rendered at the column's own scale — quantity_amount is
    // numeric(18,3), the same domain measurement_book_lines.prior_* uses.
    expect(a1?.proposedSupplied).toBe('20.000');
    expect(a1?.priorSupplied).toBe('20.000');
    // 20 x 1000.00 x 0.70 = 14000.00, priced through the same
    // computeStageAmounts a Measurement Book line is.
    expect(a1?.proposedAmount).toBe('14000.00');
    expect(a1?.proposedFromRemark).toContain('Prepaid 70% for 12 Nos');
    expect(withProposal.grossBilledToDate).toBe('14000.00');
    // Proposing is not confirming. Nothing here is signed by anybody yet.
    expect(withProposal.lines.every((line) => line.confirmedAt === null)).toBe(true);

    // The lock refuses while a single line is unconfirmed, and names the
    // ones somebody still has to look at.
    const early = await authed({
      method: 'POST',
      url: `/api/billing-baselines/${baselineId}/lock`,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'BILLING_BASELINE_LINES_UNCONFIRMED' });
    expect(early.json<{ message: string }>().message).toContain('A/1');

    for (const itemNumber of ['A/1', 'A/6']) {
      const confirmed = await authed({
        method: 'POST',
        url: `/api/billing-baselines/${baselineId}/lines/confirm`,
        payload: { itemNumber },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
    }

    // AN EDIT UN-CONFIRMS. The confirmation was a statement about the
    // figures that were there, and carrying it across an edit would put a
    // member's name on a number they never saw.
    const edited = await authed({
      method: 'PUT',
      url: `/api/billing-baselines/${baselineId}/lines`,
      payload: {
        lines: [
          {
            workItemId: a1?.workItemId,
            priorSupplied: '18.000',
            priorInstalled: '0.000',
            priorPac: '0.000',
            priorFinalBill: '0.000',
            amount: '12600.00',
          },
        ],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const afterEdit = edited.json<WorkBillingBaselineResponse>();
    expect(
      afterEdit.lines.find((line) => line.itemNumber === 'A/1')?.confirmedAt,
    ).toBeNull();
    // A/6 was not in the request and keeps its confirmation: this endpoint
    // states the lines it names and leaves the rest alone.
    expect(
      afterEdit.lines.find((line) => line.itemNumber === 'A/6')?.confirmedAt,
    ).not.toBeNull();
    // The proposal is still there beside the stated figure, so the change
    // is legible rather than silent.
    expect(
      afterEdit.lines.find((line) => line.itemNumber === 'A/1')?.proposedSupplied,
    ).toBe('20.000');

    const reconfirmed = await authed({
      method: 'POST',
      url: `/api/billing-baselines/${baselineId}/lines/confirm`,
      payload: { itemNumber: 'A/1' },
    });
    expect(reconfirmed.statusCode, reconfirmed.body).toBe(200);

    const locked = await authed({
      method: 'POST',
      url: `/api/billing-baselines/${baselineId}/lock`,
    });
    expect(locked.statusCode, locked.body).toBe(200);
    expect(
      locked.json<WorkBillingBaselineResponse>().baseline?.lockedAt,
    ).not.toBeNull();

    // RESUMPTION, half one: the numbering. The counter is seeded at the
    // railway's own sequence — the finalize counter is increment-then-use,
    // so a counter holding 4 numbers the next book 5. (Seeding 5 here was
    // this pack's original off-by-one: it numbered the resumed book MB-06.)
    const [counter] = await admin<{ next_value: number }[]>`
      select next_value from measurement_book_counters where work_id = ${work.workId}
    `;
    expect(counter?.next_value).toBe(4);

    // RESUMPTION, half two: the memory. A draft raised now must bill the
    // DELTA over the 18 Nos the railway already paid for, and its remark
    // must narrate that history rather than a fresh one. A computed line
    // only exists where something was measured, so the fixture delivers
    // two more units first — which is also the honest shape of the flow:
    // the baseline is locked, work resumes, the next challan goes out.
    const challan = await authed({
      method: 'POST',
      url: `/api/works/${work.workId}/challans`,
      payload: {
        challanDate: '2026-08-14',
        prefix: `${work.label}DC`,
        consignee: { name: 'Sr. DSTE (G) CR', address: 'Mumbai Division' },
        items: [{ workItemId: a1?.workItemId ?? '', quantity: '2.000' }],
      },
    });
    expect(challan.statusCode, challan.body).toBe(201);
    const challanId = challan.json<ChallanDetailResponse>().challan.id;
    const issued = await authed({
      method: 'POST',
      url: `/api/challans/${challanId}/issue`,
    });
    expect(issued.statusCode, issued.body).toBe(201);

    const draft = await authed({
      method: 'POST',
      url: `/api/works/${work.workId}/measurement-books`,
      payload: { mbDate: '2026-08-15' },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const bookId = draft.json<MeasurementBookDetailResponse>().book.id;
    const claimed = await authed({
      method: 'PUT',
      url: `/api/measurement-books/${bookId}/sources`,
      payload: {
        sources: [{ sourceType: 'delivery_challan', sourceId: challanId }],
      },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const detail = claimed.json<MeasurementBookDetailResponse>();
    const line = detail.lines.find((entry) => entry.itemNumber === 'A/1');
    // The delta is the challan's two units; the PRIOR is what the locked
    // baseline stated, added to a system-native prior of nothing.
    expect(line?.deltaSupplied).toBe('2.000');
    expect(line?.priorSupplied).toBe('18.000');
    // And the remark narrates the railway's own history: 18 Nos prepaid
    // at the supply stage before this product billed anything.
    expect(line?.remark).toContain('Prepaid 70% for 18');

    // RESUMPTION, proved to the number: the finalized book CONTINUES the
    // railway's series. The finalize counter is increment-then-use, so
    // this is the assertion that would have caught a seed of N+1 — the
    // railway is at 04 and the first book this product numbers must be
    // MB-05, not MB-06 and not MB-01.
    const finalized = await authed({
      method: 'POST',
      url: `/api/measurement-books/${bookId}/finalize`,
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const book = finalized.json<MeasurementBookDetailResponse>().book;
    expect(book.sequenceNumber).toBe(5);
    expect(book.mbNumber).toBe(`${work.label}-MB-05`);
  });

  it('refuses every act on a locked baseline, in the route and in the database', async () => {
    const work = await seedImportedWork();
    const created = await uploadBill(work.workId, billPdf('02'));
    expect(created.statusCode, created.body).toBe(201);
    const baseline = created.json<WorkBillingBaselineResponse>();
    const baselineId = baseline.baseline?.id ?? '';
    for (const line of baseline.lines) {
      await authed({
        method: 'POST',
        url: `/api/billing-baselines/${baselineId}/lines/confirm`,
        payload: { itemNumber: line.itemNumber },
      });
    }
    expect(
      (
        await authed({
          method: 'POST',
          url: `/api/billing-baselines/${baselineId}/lock`,
        })
      ).statusCode,
    ).toBe(200);

    const editRefused = await authed({
      method: 'PUT',
      url: `/api/billing-baselines/${baselineId}/lines`,
      payload: {
        lines: [
          {
            workItemId: baseline.lines[0]?.workItemId,
            priorSupplied: '1.000',
            priorInstalled: '0.000',
            priorPac: '0.000',
            priorFinalBill: '0.000',
            amount: '1.00',
          },
        ],
      },
    });
    expect(editRefused.statusCode).toBe(409);
    expect(editRefused.json()).toMatchObject({ code: 'BILLING_BASELINE_LOCKED' });

    const deleteRefused = await authed({
      method: 'DELETE',
      url: `/api/billing-baselines/${baselineId}`,
    });
    expect(deleteRefused.statusCode).toBe(409);

    // The second layer, and the reason it exists: a writer that never went
    // through the route gets the same answer.
    await expect(
      admin`
        update work_billing_baseline_lines set prior_supplied = 5
        where work_billing_baseline_id = ${baselineId}
      `,
    ).rejects.toThrow(/lines of a locked billing baseline are frozen/);
    await expect(
      admin`
        update work_billing_baselines set bill_number = 'rewritten'
        where id = ${baselineId}
      `,
    ).rejects.toThrow(/locked and states its opening position permanently/);
    await expect(
      admin`delete from work_billing_baselines where id = ${baselineId}`,
    ).rejects.toThrow(/locked; every Measurement Book raised since counts from it/);

    // And the Work is no longer supersedable: the locked position is the
    // settlement memory every book after it counts from, and 0114's own
    // insert guard would refuse the successor a second one — the history
    // would be lost with no way back (0114 § 9 blocks in the database,
    // the register census here).
    const eligibility = await authed({
      method: 'GET',
      url: `/api/works/${work.workId}/supersede-eligibility`,
    });
    expect(eligibility.statusCode, eligibility.body).toBe(200);
    const blockers = eligibility.json<{
      blockers: readonly { register: string }[];
    }>().blockers;
    expect(blockers.map((entry) => entry.register)).toContain('work_billing_baselines');
  });

  it('refuses a baseline on a Work this product has already billed, in both layers', async () => {
    const work = await seedImportedWork();
    // A finalized Measurement Book of this system's own: the Work's
    // history is recorded HERE, so there is no pre-system position to
    // open and a second one would be counted twice.
    const bookId = randomUUID();
    await admin`
      insert into measurement_books (
        id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
      )
      values (
        ${bookId}, ${organisationId}, ${work.workId}, 'draft', '2026-05-09',
        ${ownerUserId}, 'on_account'
      )
    `;
    await admin`
      update measurement_books
      set status = 'finalized', mb_number = ${`${work.label}-MB-01`},
          sequence_number = 1, total_amount = '0.00',
          remark_template_version = 'mb-remark-v1', finalized_at = now(),
          finalized_by_user_id = ${ownerUserId}
      where id = ${bookId}
    `;

    const refused = await uploadBill(work.workId, billPdf('03'));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'BILLING_BASELINE_WORK_ALREADY_BILLED',
    });

    await expect(
      admin`
        insert into work_billing_baselines (
          organisation_id, work_id, bill_object_key, bill_filename, bill_sha256,
          bill_media_type, bill_size_bytes, bill_source, bill_number, bill_date,
          bill_amount, last_mb_sequence_number, created_by_user_id
        )
        values (
          ${organisationId}, ${work.workId},
          ${`${organisationId}/billingbaseline/${randomUUID()}.pdf`}, 'b.pdf',
          ${randomBytes(32).toString('hex')}, 'application/pdf', 1024, 'recorded',
          'B-1', '2026-05-11', '10.00', 1, ${ownerUserId}
        )
      `,
    ).rejects.toThrow(/has finalized a Measurement Book in this system/);

    // And the same Work takes no opening deductions: pre-system
    // withholdings on a Work whose billing history is native to this
    // system would be subtracted from a gross that never existed.
    const deductionsRefused = await authed({
      method: 'PUT',
      url: `/api/works/${work.workId}/deductions`,
      payload: { deductions: [{ head: 'retention', amount: '1.00' }] },
    });
    expect(deductionsRefused.statusCode).toBe(409);
    expect(deductionsRefused.json()).toMatchObject({
      code: 'BILLING_BASELINE_WORK_ALREADY_BILLED',
    });
  });

  it('refuses to lock while a live item has no line, in both layers', async () => {
    const work = await seedImportedWork();
    const created = await uploadBill(work.workId, billPdf('07'));
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<WorkBillingBaselineResponse>();
    const baselineId = body.baseline?.id ?? '';
    for (const line of body.lines) {
      await authed({
        method: 'POST',
        url: `/api/billing-baselines/${baselineId}/lines/confirm`,
        payload: { itemNumber: line.itemNumber },
      });
    }

    // An item lands on the schedule AFTER the lines were seeded — the one
    // gap the confirmation count cannot see, because there is nothing
    // unconfirmed, only something absent.
    const [schedule] = await admin<{ schedule_id: string }[]>`
      select schedule_id from work_items where id = ${work.itemIds[0] ?? ''}
    `;
    await admin`
      insert into work_items (
        organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (
        ${organisationId}, ${work.workId}, ${schedule?.schedule_id ?? ''},
        'A/9', 'Item added after the lines were made', 'Nos', '5.000',
        '100.00', 'SUPPLY'
      )
    `;

    const refused = await authed({
      method: 'POST',
      url: `/api/billing-baselines/${baselineId}/lock`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'BILLING_BASELINE_LINES_MISSING' });
    expect(refused.json<{ message: string }>().message).toContain('A/9');

    // The second layer: a lock written straight past the route gets the
    // same refusal from 0114's guard (23W07).
    await expect(
      admin`
        update work_billing_baselines
        set locked_at = now(), locked_by_user_id = ${ownerUserId}
        where id = ${baselineId}
      `,
    ).rejects.toThrow(/have no baseline line/);
  });

  it('records a bill whose own text cannot be read, and refuses to be told twice', async () => {
    const work = await seedImportedWork();
    // A PDF with a text layer that is not a bill at all — the shape of a
    // scan, from this reader's point of view.
    const unreadable = textLayoutPdf(['A scanned page with no bill grid on it.']);

    const withoutFigures = await uploadBill(work.workId, unreadable);
    expect(withoutFigures.statusCode).toBe(400);
    expect(withoutFigures.json()).toMatchObject({
      code: 'BILLING_BASELINE_BILL_UNREADABLE',
    });

    const recorded = await uploadBill(
      work.workId,
      unreadable,
      '&billNumber=CR/HAND/1&billDate=2026-05-11&billAmount=90000.00&lastMbSequenceNumber=3',
    );
    expect(recorded.statusCode, recorded.body).toBe(201);
    const body = recorded.json<WorkBillingBaselineResponse>();
    // An ACT with an author, and the row says which path it came down.
    expect(body.baseline?.billSource).toBe('recorded');
    expect(body.baseline?.billNumber).toBe('CR/HAND/1');
    expect(body.baseline?.lastMbSequenceNumber).toBe(3);

    // And the other direction: a bill this product CAN read refuses to
    // have its figures typed over the top, because that is two claims
    // about one document with no honest way to pick.
    await authed({
      method: 'DELETE',
      url: `/api/billing-baselines/${body.baseline?.id ?? ''}`,
    });
    const contradicted = await uploadBill(
      work.workId,
      billPdf('05'),
      '&billNumber=CR/HAND/2&billDate=2026-05-11&billAmount=1.00&lastMbSequenceNumber=1',
    );
    expect(contradicted.statusCode).toBe(409);
    expect(contradicted.json()).toMatchObject({
      code: 'BILLING_BASELINE_BILL_UNREADABLE',
    });
  });

  it('carries the deductions gross to net, and freezes them with the baseline', async () => {
    const work = await seedImportedWork();

    // Recorded BEFORE any baseline exists: nothing is locked, so there is
    // nothing to be inconsistent with.
    const set = await authed({
      method: 'PUT',
      url: `/api/works/${work.workId}/deductions`,
      payload: {
        deductions: [
          { head: 'security_deposit', amount: '50000.00', note: 'SD to date' },
          { head: 'income_tax_tds', amount: '21000.00' },
          { head: 'gst_tds', amount: '0.00' },
        ],
      },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<WorkBillingBaselineResponse>().deductionsTotal).toBe('71000.00');
    // No lines yet, so the gross is nothing and the net is floored at
    // zero rather than reported as a negative receivable.
    expect(set.json<WorkBillingBaselineResponse>().netReceivable).toBe('0.00');

    const created = await uploadBill(work.workId, billPdf('06'));
    expect(created.statusCode, created.body).toBe(201);
    const baselineId = created.json<WorkBillingBaselineResponse>().baseline?.id ?? '';
    const lines = created.json<WorkBillingBaselineResponse>().lines;
    const stated = await authed({
      method: 'PUT',
      url: `/api/billing-baselines/${baselineId}/lines`,
      payload: {
        lines: lines.map((line, index) => ({
          workItemId: line.workItemId,
          priorSupplied: '10.000',
          priorInstalled: '0.000',
          priorPac: '0.000',
          priorFinalBill: '0.000',
          amount: index === 0 ? '100000.00' : '20000.00',
        })),
      },
    });
    expect(stated.statusCode, stated.body).toBe(200);
    const position = stated.json<WorkBillingBaselineResponse>();
    expect(position.grossBilledToDate).toBe('120000.00');
    expect(position.netReceivable).toBe('49000.00');

    for (const line of lines) {
      await authed({
        method: 'POST',
        url: `/api/billing-baselines/${baselineId}/lines/confirm`,
        payload: { itemNumber: line.itemNumber },
      });
    }
    expect(
      (
        await authed({
          method: 'POST',
          url: `/api/billing-baselines/${baselineId}/lock`,
        })
      ).statusCode,
    ).toBe(200);

    const refused = await authed({
      method: 'PUT',
      url: `/api/works/${work.workId}/deductions`,
      payload: { deductions: [{ head: 'retention', amount: '1.00' }] },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'BILLING_BASELINE_LOCKED' });

    await expect(
      admin`
        update work_deduction_entries set amount = 1
        where work_id = ${work.workId} and head = 'security_deposit'
      `,
    ).rejects.toThrow(/locked with its billing baseline/);
  });
});
