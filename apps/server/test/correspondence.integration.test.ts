import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { CorrespondenceListResponse } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import {
  assertNoForeignKeyOrphans,
  removeOrganisationResidue,
} from '@auto-mb/db/testing';
import { assertSafeObjectKey } from '@auto-mb/documents';
import { buildApp } from '../src/app.js';

/**
 * The correspondence register (migration 0086).
 *
 * What is proved here, in the order the module's own risks run:
 *
 *   1. NUMBERING — two independent series, three digits, the financial
 *      year the letter's own date falls in, and gap-free under
 *      SIMULTANEOUS registration (engineering rule 9);
 *   2. the derived statuses — `replied` appears because a later letter
 *      cites an earlier one, and disappears from nowhere else;
 *   3. immutability and cancellation — a letter cannot be edited, keeps
 *      its number when cancelled, and cannot be cancelled out from under
 *      a reply that cites it;
 *   4. the upload gate on the inward scan — magic bytes, a key the
 *      storage traversal guard accepts, and no object written by a
 *      refusal;
 *   5. the PROJECTIONS — the extension and inspection tabs read the
 *      modules that own those letters and write nothing;
 *   6. the walls — role for writes, work-scope for reads and for the
 *      cursor, and RLS for the other organisation.
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
const ownerEmail = `corr-owner-${runId}@integration.test`;
const officeEmail = `corr-office-${runId}@integration.test`;
const viewerEmail = `corr-viewer-${runId}@integration.test`;
const assignedEmail = `corr-assigned-${runId}@integration.test`;
const outsiderEmail = `corr-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

/** A minimal but real PDF: the guard reads the signature, never the
 * declared content type. */
let pdfCounter = 0;
function pdfBytes(): Buffer {
  pdfCounter += 1;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Seq ${String(pdfCounter)} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );
}

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let outsiderOrganisationId: string;
let contactId: string;
let ownerUserId: string;
let secondContactId: string;
let openWorkId: string;
let closedWorkId: string;
/** Work codes are uppercase and at most twenty characters (0001). */
const openWorkCode = `CO-${runId.toUpperCase()}`;
const otherWorkCode = `CX-${runId.toUpperCase()}`;
/** Today in the organisation's timezone, which is the date the routes
 * measure "in the future" against. Every letter date below is derived
 * from it: a hard-coded date is a test that starts failing on some future
 * Tuesday, and these routes refuse a letter dated after today. */
let today: string;
let todayMs: number;

function daysAgo(days: number): string {
  return new Date(todayMs - days * 86_400_000).toISOString().slice(0, 10);
}

/** The April-to-March label the letter number abbreviates: '2026-27' for
 * a date in July 2026. Mirrors `financial-year.ts` rather than importing
 * it, so a change there is caught here instead of agreeing with itself. */
function fyOf(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${String(start).slice(2)}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The last day of the PREVIOUS financial year, which is always in the
 * past and always in a different series from today's. */
function lastDayOfPreviousFy(): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return `${String(month >= 4 ? year : year - 1)}-03-31`;
}

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let viewer: CookieJar;
let assigned: CookieJar;
let outsider: CookieJar;

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
}

async function signUp(email: string, name: string): Promise<CookieJar> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name },
  });
  expect(response.statusCode, `sign-up ${email}: ${response.body}`).toBe(200);
  return { cookie: extractCookies(response.headers['set-cookie']) };
}

async function authed(
  jar: CookieJar,
  options: InjectOptions & { organisationId?: string },
) {
  const { organisationId: org, ...rest } = options;
  return app.inject({
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      cookie: jar.cookie,
      ...(org !== undefined ? { 'x-organisation-id': org } : {}),
    },
  });
}

function query(details: Record<string, string>): string {
  return new URLSearchParams(details).toString();
}

/** Files actually written under the storage root. A refusal that has
 * already spent a `storage.put` shows up here even when it answers 4xx. */
async function storedObjectCount(): Promise<number> {
  const entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).length;
}

async function writeOutward(
  payload: Record<string, unknown>,
  jar: CookieJar = owner,
  organisation = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: '/api/correspondence/outward',
    organisationId: organisation,
    payload,
  });
}

async function registerInward(
  details: Record<string, string>,
  jar: CookieJar = owner,
  organisation = organisationId,
  body: Buffer = pdfBytes(),
) {
  return authed(jar, {
    method: 'POST',
    url: `/api/correspondence/inward?${query(details)}`,
    organisationId: organisation,
    headers: { 'content-type': 'application/pdf' },
    payload: body,
  });
}

async function register(
  tab: string,
  jar: CookieJar = owner,
  organisation = organisationId,
  extra: Record<string, string> = {},
): Promise<CorrespondenceListResponse> {
  const response = await authed(jar, {
    method: 'GET',
    url: `/api/correspondence?${query({ tab, ...extra })}`,
    organisationId: organisation,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CorrespondenceListResponse>();
}

async function seedWork(code: string, organisation = organisationId): Promise<string> {
  const id = randomUUID();
  // A completion date ahead of today, because an extension request must
  // propose a date beyond it (0011) and the projection test raises one.
  const completionDate = daysAgo(-100);
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id,
      original_completion_date, current_completion_date
    )
    values (
      ${id}, ${organisation}, ${code}, ${`L-${code}`}, '2026-01-05',
      ${`Correspondence fixture ${code}`}, '10000000.00', '9000000.00',
      'per_schedule', 'fixture', ${completionDate}, ${completionDate}
    )
  `;
  return id;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-correspondence-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-corr-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Letters Owner');
  office = await signUp(officeEmail, 'Letters Office');
  viewer = await signUp(viewerEmail, 'Letters Viewer');
  assigned = await signUp(assignedEmail, 'Letters Assigned');
  outsider = await signUp(outsiderEmail, 'Letters Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Letters Constructions', slug: `corr-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Letters Outsiders', slug: `corr-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [viewerEmail, 'viewer'],
    [assignedEmail, 'office'],
  ] as const) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role },
    });
    expect(added.statusCode, added.body).toBe(201);
  }
  // The assigned member sees only the Works they are on, which is the
  // predicate every read below is measured against.
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId}
      and user_id in (
        select "id" from auth_users where "email" = ${assignedEmail}
      )
  `;

  // Two contacts of DIFFERENT master roles, because the composer's
  // picker offers every contact: the awarding authority a letter is
  // addressed to is the client and is never a consignee (rule R16), and
  // the consignee office is the other half of the register's traffic.
  for (const designation of ['Sr. DSTE/MMCT', 'SSE/Tele/Planning/MMCT']) {
    const contact = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: {
        designation,
        address: 'Mumbai Central Division',
        ...(designation === 'Sr. DSTE/MMCT' ? { isClient: true } : {}),
      },
    });
    expect(contact.statusCode, contact.body).toBe(201);
    if (designation === 'Sr. DSTE/MMCT') contactId = contact.json<{ id: string }>().id;
    else secondContactId = contact.json<{ id: string }>().id;
  }

  const [row] = await admin<{ today: string }[]>`
    select (now() at time zone o.timezone)::date::text as today
    from organisations o where o.id = ${organisationId}
  `;
  today = row?.today ?? '';
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  todayMs = Date.parse(`${today}T00:00:00.000Z`);
  expect(Number.isNaN(todayMs)).toBe(false);

  const [ownerRow] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  ownerUserId = ownerRow?.id ?? '';
  expect(ownerUserId).not.toBe('');

  openWorkId = await seedWork(openWorkCode);
  closedWorkId = await seedWork(otherWorkCode);
}, 180_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
    await assertNoForeignKeyOrphans(admin);
  }
  await app?.close();
  await admin?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('numbering the two letter series', () => {
  it('numbers each direction on its own gap-free financial-year series', async () => {
    const first = await writeOutward({
      letterDate: daysAgo(40),
      contactId,
      workId: openWorkId,
      subject: 'Submission of approved makes and technical datasheets',
      body: 'The approved makes and datasheets are enclosed for approval.',
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json<{ number: string }>().number).toBe(
      `OUT/${fyOf(daysAgo(40))}/001`,
    );

    const second = await writeOutward({
      letterDate: daysAgo(30),
      contactId,
      subject: 'Reply to clarification on UPS battery autonomy',
      body: 'The battery autonomy offered is ninety minutes at full load.',
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json<{ number: string }>().number).toBe(
      `OUT/${fyOf(daysAgo(30))}/002`,
    );

    // A different direction is a different series, starting at one again.
    const inward = await registerInward({
      filename: 'approval.pdf',
      receivedOn: daysAgo(35),
      contactId,
      workId: openWorkId,
      subject: 'Approval of IP speaker make and model',
      senderReference: 'S&T/PA/Approval/118',
      senderLetterDate: daysAgo(36),
      responseDueOn: daysAgo(0),
    });
    expect(inward.statusCode, inward.body).toBe(201);
    expect(inward.json<{ number: string }>().number).toBe(
      `IN/${fyOf(daysAgo(35))}/001`,
    );

    // A March date belongs to the PREVIOUS financial year and restarts
    // that series at one, which is the boundary a calendar year gets
    // wrong.
    const earlier = await writeOutward({
      letterDate: lastDayOfPreviousFy(),
      contactId,
      subject: 'Acknowledgement of drawing approval',
      body: 'The approved drawings are acknowledged with thanks.',
    });
    expect(earlier.statusCode, earlier.body).toBe(201);
    const previousFy = fyOf(lastDayOfPreviousFy());
    expect(previousFy).not.toBe(fyOf(today));
    expect(earlier.json<{ number: string }>().number).toBe(`OUT/${previousFy}/001`);
  });

  it('hands out no number twice when two letters are written at once', async () => {
    const before = await register('outward');
    const written = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        writeOutward({
          letterDate: daysAgo(28),
          contactId,
          subject: `Concurrent letter ${String(index)}`,
          body: 'Filed simultaneously to prove the counter serialises.',
        }),
      ),
    );
    for (const response of written) {
      expect(response.statusCode, response.body).toBe(201);
    }
    const numbers = written.map(
      (response) => response.json<{ number: string }>().number,
    );
    expect(new Set(numbers).size, numbers.join(', ')).toBe(6);

    // Gap-free: the six numbers are consecutive from where the series
    // stood, with nothing skipped and nothing repeated.
    const serials = numbers
      .map((number) => Number(number.slice(-3)))
      .sort((left, right) => left - right);
    const first = serials[0] ?? 0;
    expect(serials).toEqual(
      Array.from({ length: 6 }, (_unused, index) => first + index),
    );
    expect((await register('outward')).counts.outward).toBe(before.counts.outward + 6);
  });

  it('refuses a letter dated after today in the organisation timezone', async () => {
    const tomorrow = new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const response = await writeOutward({
      letterDate: tomorrow,
      contactId,
      subject: 'A letter from tomorrow',
      body: 'This letter has not been written yet.',
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe(
      'CORRESPONDENCE_DATE_IN_FUTURE',
    );
  });
});

describe('the derived statuses', () => {
  it('reads replied only because a later letter cites the earlier one', async () => {
    const question = await registerInward({
      filename: 'clarification.pdf',
      receivedOn: daysAgo(26),
      contactId,
      subject: 'Clarification sought on UPS battery autonomy',
    });
    expect(question.statusCode, question.body).toBe(201);
    const questionId = question.json<{ id: string }>().id;

    const before = await register('inward');
    expect(before.entries.find((entry) => entry.id === questionId)?.status).toBe(
      'received',
    );

    const answer = await writeOutward({
      letterDate: daysAgo(25),
      contactId,
      replyToLetterId: questionId,
      subject: 'Reply on UPS battery autonomy',
      body: 'Ninety minutes at full load, as the datasheet states.',
    });
    expect(answer.statusCode, answer.body).toBe(201);

    const after = await register('inward');
    const replied = after.entries.find((entry) => entry.id === questionId);
    expect(replied?.status).toBe('replied');
    // Nothing was written to the answered letter: the status is a fact
    // about the register, computed on read.
    const [stored] = await admin<{ updated_at: Date; created_at: Date }[]>`
      select updated_at, created_at from correspondence_letters
      where id = ${questionId}
    `;
    expect(stored?.updated_at.getTime()).toBe(stored?.created_at.getTime());

    // The reply carries the answered letter's number in its reference
    // slot, which is the trail the register renders.
    const outward = await register('outward');
    const replyRow = outward.entries.find(
      (entry) => entry.subject === 'Reply on UPS battery autonomy',
    );
    expect(replyRow?.reference).toBe(`IN/${fyOf(daysAgo(26))}/002`);
  });

  it('shows the sender reference and the date on their paper together', async () => {
    const inward = await register('inward');
    const approval = inward.entries.find(
      (entry) => entry.subject === 'Approval of IP speaker make and model',
    );
    expect(approval?.reference).toBe(`S&T/PA/Approval/118 · ${daysAgo(36)}`);
    expect(approval?.replyDueOn).toBe(daysAgo(0));
  });
});

describe('immutability and cancellation', () => {
  it('keeps the number, refuses the edit, and refuses to reinstate', async () => {
    const written = await writeOutward({
      letterDate: daysAgo(24),
      contactId,
      subject: 'Letter filed against the wrong Work',
      body: 'This one was misfiled and will be cancelled.',
    });
    expect(written.statusCode, written.body).toBe(201);
    const { id, number } = written.json<{ id: string; number: string }>();

    const cancelled = await authed(owner, {
      method: 'POST',
      url: `/api/correspondence/${id}/cancel`,
      organisationId,
      payload: { reason: 'Filed against the wrong Work.' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const again = await authed(owner, {
      method: 'POST',
      url: `/api/correspondence/${id}/cancel`,
      organisationId,
      payload: { reason: 'Trying twice.' },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('CORRESPONDENCE_LETTER_CANCELLED');

    // The number is retained forever and is not handed out again.
    const listed = await register('outward');
    const row = listed.entries.find((entry) => entry.id === id);
    expect(row?.number).toBe(number);
    expect(row?.status).toBe('cancelled');

    const next = await writeOutward({
      letterDate: daysAgo(23),
      contactId,
      subject: 'The letter that should have been filed',
      body: 'Filed against the right Work this time.',
    });
    expect(next.json<{ number: string }>().number).not.toBe(number);
  });

  it('refuses a raw edit of a registered letter at the database', async () => {
    const written = await writeOutward({
      letterDate: daysAgo(22),
      contactId,
      subject: 'A letter nobody may rewrite',
      body: 'The body of this letter is frozen at insert.',
    });
    const { id } = written.json<{ id: string }>();
    // Bound as the tenant, because the table FORCEs row-level security on
    // its owner too: an unbound administrative statement matches no rows
    // and would prove nothing about the guard.
    await expect(
      admin.begin(async (tx) => {
        await tx`select app_private.bind_tenant(${organisationId}::uuid, ${ownerUserId})`;
        await tx`
          update correspondence_letters set subject = 'rewritten' where id = ${id}
        `;
      }),
    ).rejects.toMatchObject({ code: '23E01' });
    await expect(
      admin.begin(async (tx) => {
        await tx`select app_private.bind_tenant(${organisationId}::uuid, ${ownerUserId})`;
        await tx`
          update correspondence_letters set letter_number = 'OUT/99-00/999'
          where id = ${id}
        `;
      }),
    ).rejects.toMatchObject({ code: '23E01' });
  });

  it('refuses to cancel a letter a live reply still cites', async () => {
    const question = await registerInward({
      filename: 'query.pdf',
      receivedOn: daysAgo(21),
      contactId,
      subject: 'Query that will be answered',
    });
    const questionId = question.json<{ id: string }>().id;
    const answer = await writeOutward({
      letterDate: daysAgo(20),
      contactId,
      replyToLetterId: questionId,
      subject: 'The answer to the query',
      body: 'Answered as asked.',
    });
    const answerId = answer.json<{ id: string }>().id;

    const refused = await authed(owner, {
      method: 'POST',
      url: `/api/correspondence/${questionId}/cancel`,
      organisationId,
      payload: { reason: 'Recorded in error.' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe(
      'CORRESPONDENCE_LETTER_ANSWERED',
    );

    // The thread unwinds from its newest end, and then it does.
    const reply = await authed(owner, {
      method: 'POST',
      url: `/api/correspondence/${answerId}/cancel`,
      organisationId,
      payload: { reason: 'Recorded in error.' },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    const now = await authed(owner, {
      method: 'POST',
      url: `/api/correspondence/${questionId}/cancel`,
      organisationId,
      payload: { reason: 'Recorded in error.' },
    });
    expect(now.statusCode, now.body).toBe(200);
  });

  it('refuses to answer a cancelled letter', async () => {
    const written = await writeOutward({
      letterDate: daysAgo(19),
      contactId,
      subject: 'A letter about to be cancelled',
      body: 'Cancelled before anybody answered it.',
    });
    const { id } = written.json<{ id: string }>();
    await authed(owner, {
      method: 'POST',
      url: `/api/correspondence/${id}/cancel`,
      organisationId,
      payload: { reason: 'Recorded in error.' },
    });
    const reply = await writeOutward({
      letterDate: daysAgo(18),
      contactId,
      replyToLetterId: id,
      subject: 'Answering a cancelled letter',
      body: 'This should not be filed.',
    });
    expect(reply.statusCode, reply.body).toBe(409);
    expect(reply.json<{ code: string }>().code).toBe('CORRESPONDENCE_LETTER_CANCELLED');
  });
});

describe('the inward scan', () => {
  it('refuses anything that is not a PDF, before it reaches storage', async () => {
    const before = await storedObjectCount();
    const response = await registerInward(
      {
        filename: 'not-a-letter.pdf',
        receivedOn: daysAgo(17),
        contactId,
        subject: 'A letter that is really a spreadsheet',
      },
      owner,
      organisationId,
      Buffer.from('PK this is a zip'),
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('NOT_A_PDF');
    expect(await storedObjectCount()).toBe(before);
  });

  it('stores the scan under a key the traversal guard accepts', async () => {
    const response = await registerInward({
      filename: 'letter.pdf',
      receivedOn: daysAgo(16),
      contactId,
      subject: 'Received letter with its scan on file',
    });
    expect(response.statusCode, response.body).toBe(201);
    const { id } = response.json<{ id: string }>();
    const [stored] = await admin<{ scan_object_key: string }[]>`
      select scan_object_key from correspondence_letters where id = ${id}
    `;
    expect(stored?.scan_object_key.startsWith(`${organisationId}/letters/`)).toBe(true);
    expect(() => {
      assertSafeObjectKey(stored?.scan_object_key ?? '');
    }).not.toThrow();

    // The scan comes back as it went in.
    const download = await authed(owner, {
      method: 'GET',
      url: `/api/correspondence/${id}/document`,
      organisationId,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('writes no object when the metadata is refused', async () => {
    const before = await storedObjectCount();
    const response = await registerInward({
      filename: 'orphan.pdf',
      receivedOn: daysAgo(15),
      contactId: randomUUID(),
      subject: 'Addressed to a contact that does not exist',
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('CONTACT_NOT_FOUND');
    expect(await storedObjectCount()).toBe(before);
  });
});

describe('the date-order rules', () => {
  it('accepts a reply due on the day the letter arrived and refuses the day before', async () => {
    const received = daysAgo(7);
    const boundary = await registerInward({
      filename: 'due-today.pdf',
      receivedOn: received,
      contactId,
      subject: 'A letter whose reply is due the day it arrived',
      responseDueOn: received,
    });
    expect(boundary.statusCode, boundary.body).toBe(201);

    const before = await storedObjectCount();
    const refused = await registerInward({
      filename: 'due-yesterday.pdf',
      receivedOn: received,
      contactId,
      subject: 'A letter whose reply was due before it arrived',
      responseDueOn: daysAgo(8),
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe(
      'CORRESPONDENCE_RESPONSE_DUE_BEFORE_LETTER',
    );
    // Refused BEFORE the scan is stored: a 400 raised after the object
    // was written would leave an orphan behind, which is the whole reason
    // the rule is repeated at the route.
    expect(await storedObjectCount()).toBe(before);
  });

  it("accepts a sender's date equal to the received date and refuses the day after", async () => {
    const received = daysAgo(6);
    const boundary = await registerInward({
      filename: 'same-day.pdf',
      receivedOn: received,
      contactId,
      subject: 'A letter received the day it was written',
      senderLetterDate: received,
    });
    expect(boundary.statusCode, boundary.body).toBe(201);

    const before = await storedObjectCount();
    const refused = await registerInward({
      filename: 'future-sender.pdf',
      receivedOn: daysAgo(6),
      contactId,
      subject: 'A letter dated after it arrived',
      senderLetterDate: daysAgo(5),
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe(
      'CORRESPONDENCE_SENDER_DATE_AFTER_LETTER',
    );
    expect(await storedObjectCount()).toBe(before);
  });

  it('carries neither date on the outward route, which has no sender and asks nothing', async () => {
    // The other direction's route cannot hold them: the schema declares
    // neither field, Fastify strips what it does not declare, and 0086's
    // outward shape CHECK refuses a row that somehow carried one. So the
    // assertion is that they never reach the record — an outward letter
    // has no sender to date it and asks for no reply of its own, and the
    // two guards above have nothing to bite on here.
    const written = await writeOutward({
      letterDate: daysAgo(2),
      contactId,
      subject: 'An outward letter carrying inward fields',
      body: 'Both inward-only dates should be dropped on the way in.',
      responseDueOn: daysAgo(1),
      senderLetterDate: daysAgo(1),
    });
    expect(written.statusCode, written.body).toBe(201);
    const { id } = written.json<{ id: string }>();
    const [stored] = await admin<
      { response_due_on: string | null; sender_letter_date: string | null }[]
    >`
      select response_due_on::text, sender_letter_date::text
      from correspondence_letters where id = ${id}
    `;
    expect(stored?.response_due_on).toBeNull();
    expect(stored?.sender_letter_date).toBeNull();

    const listed = await register('outward');
    expect(listed.entries.find((row) => row.id === id)?.replyDueOn).toBeNull();
  });
});

describe('work-scope on the dependent reads', () => {
  it('does not change a visible letter when a hidden Work replies to it', async () => {
    const question = await registerInward({
      filename: 'scoped-question.pdf',
      receivedOn: daysAgo(45),
      contactId,
      workId: openWorkId,
      subject: 'A question filed on the assigned Work',
    });
    expect(question.statusCode, question.body).toBe(201);
    const questionId = question.json<{ id: string }>().id;

    const [assignedUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${assignedEmail}
    `;
    await admin`
      insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
      values (${organisationId}, ${openWorkId}, ${assignedUser?.id ?? ''}, 'fixture')
      on conflict do nothing
    `;

    const seenBefore = await register('inward', assigned);
    const before = seenBefore.entries.find((row) => row.id === questionId);
    expect(before?.status).toBe('received');
    expect(before?.reference).toBeNull();

    // The reply is filed on the Work this member is NOT on.
    const answer = await writeOutward({
      letterDate: daysAgo(44),
      contactId,
      workId: closedWorkId,
      replyToLetterId: questionId,
      subject: 'A reply filed on a Work the assigned member cannot see',
      body: 'Answered from a Work outside the reader scope.',
    });
    expect(answer.statusCode, answer.body).toBe(201);

    // The owner sees the thread close.
    const owned = await register('inward');
    expect(owned.entries.find((row) => row.id === questionId)?.status).toBe('replied');

    // The assigned member's register is UNCHANGED. A status chip that
    // moved, or a reference cell that filled in, would be an inference
    // channel out of a Work they were deliberately not assigned to.
    const seenAfter = await register('inward', assigned);
    const after = seenAfter.entries.find((row) => row.id === questionId);
    expect(after?.status).toBe('received');
    expect(after?.reference).toBeNull();
  });

  it('renders a letter of a superseded Work as general correspondence', async () => {
    const written = await writeOutward({
      letterDate: daysAgo(43),
      contactId,
      workId: closedWorkId,
      subject: 'A letter about a Work that is about to be withdrawn',
      body: 'The letter survives the supersession; the link does not.',
    });
    const { id } = written.json<{ id: string }>();
    expect(
      (await register('outward')).entries.find((row) => row.id === id)?.workCode,
    ).not.toBeNull();

    // 0071 refuses a hand-written soft delete: a Work is withdrawn only
    // by a real supersession. That guard is correct and is not what this
    // test is about — the register's READ is — so it is stepped around
    // for exactly one statement rather than staging a whole successor
    // Work, and restored immediately.
    await admin`alter table works disable trigger works_supersede_guard`;
    await admin`update works set deleted_at = now() where id = ${closedWorkId}`;
    await admin`alter table works enable trigger works_supersede_guard`;
    try {
      const row = (await register('outward')).entries.find((entry) => entry.id === id);
      expect(row?.workCode).toBeNull();
      expect(row?.workId).toBeNull();
      // The row is still THERE — the letter is a record of what was sent.
      expect(row?.number).toBe(written.json<{ number: string }>().number);
    } finally {
      await admin`alter table works disable trigger works_supersede_guard`;
      await admin`update works set deleted_at = null where id = ${closedWorkId}`;
      await admin`alter table works enable trigger works_supersede_guard`;
    }
  });
});

describe('the cancellation is a record of its own', () => {
  it('refuses a raw rewrite of the cancellation triple', async () => {
    const written = await writeOutward({
      letterDate: daysAgo(42),
      contactId,
      subject: 'A letter cancelled once and for all',
      body: 'The reason recorded here cannot be edited afterwards.',
    });
    const { id } = written.json<{ id: string }>();
    await authed(owner, {
      method: 'POST',
      url: `/api/correspondence/${id}/cancel`,
      organisationId,
      payload: { reason: 'Recorded in error.' },
    });

    for (const rewrite of ['reason', 'actor'] as const) {
      await expect(
        admin.begin(async (tx) => {
          await tx`select app_private.bind_tenant(${organisationId}::uuid, ${ownerUserId})`;
          if (rewrite === 'reason') {
            await tx`
              update correspondence_letters
              set cancellation_reason = 'A different story'
              where id = ${id}
            `;
          } else {
            await tx`
              update correspondence_letters set cancelled_by_user_id = 'someone-else'
              where id = ${id}
            `;
          }
        }),
      ).rejects.toMatchObject({ code: '23E01' });
    }
  });

  it('lets exactly one of a simultaneous reply and cancellation win', async () => {
    const target = await writeOutward({
      letterDate: daysAgo(41),
      contactId,
      subject: 'A letter answered and cancelled at the same moment',
      body: 'The FOR SHARE lock decides which of the two orderings happened.',
    });
    const targetId = target.json<{ id: string }>().id;

    const [reply, cancelled] = await Promise.all([
      registerInward({
        filename: 'racing-reply.pdf',
        receivedOn: daysAgo(40),
        contactId,
        replyToLetterId: targetId,
        subject: 'The racing reply',
      }),
      authed(owner, {
        method: 'POST',
        url: `/api/correspondence/${targetId}/cancel`,
        organisationId,
        payload: { reason: 'Cancelled in the same instant.' },
      }),
    ]);

    // Both orderings are legal and both are consistent; what must never
    // happen is BOTH succeeding, which would leave a live reply citing a
    // cancelled letter. The parent's FOR SHARE lock in the insert guard
    // and the FOR UPDATE in the cancel route are what serialise them.
    const wins = [reply.statusCode, cancelled.statusCode].filter(
      (status) => status < 400,
    );
    expect(wins, `${reply.body} / ${cancelled.body}`).toHaveLength(1);

    const loser = reply.statusCode < 400 ? cancelled : reply;
    expect([
      'CORRESPONDENCE_LETTER_ANSWERED',
      'CORRESPONDENCE_LETTER_CANCELLED',
    ]).toContain(loser.json<{ code: string }>().code);
  });
});

describe('the projections', () => {
  it('reads extension requests from the extensions module and writes none', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${openWorkId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: daysAgo(-300),
        reason: 'Site was not handed over on the date the LOA assumed.',
        addressee: 'Sr. DSTE/MMCT',
        letterDate: daysAgo(5),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const extensionId = created.json<{ extensionRequest: { id: string } }>()
      .extensionRequest.id;

    const listed = await register('extensions');
    const entry = listed.entries.find((row) => row.id === extensionId);
    expect(entry?.source).toBe('extension');
    expect(entry?.status).toBe('draft');
    expect(entry?.extensionUntil).toBe(daysAgo(-300));
    expect(entry?.counterparty).toBe('Sr. DSTE/MMCT');

    // No row was copied into this module's own table.
    const [copied] = await admin<{ count: string }[]>`
      select count(*) as count from correspondence_letters
      where organisation_id = ${organisationId}
        and subject like 'Request for extension%'
    `;
    expect(Number(copied?.count)).toBe(0);

    // Finalising it moves the projection to `sent` and lights the
    // register's banner, which is the one place the two modules meet.
    const finalised = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${extensionId}/finalise`,
      organisationId,
    });
    expect(finalised.statusCode, finalised.body).toBe(201);
    const after = await register('extensions');
    expect(after.entries.find((row) => row.id === extensionId)?.status).toBe('sent');
    expect(after.awaitingExtensionResponses).toBeGreaterThanOrEqual(1);
  });

  it('reads the railway response as the second half of the extension pair', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: `/api/works/${openWorkId}/extension-requests`,
      organisationId,
      payload: {
        proposedCompletionDate: daysAgo(-320),
        reason: 'A second request, this one answered by the railway.',
        addressee: 'Sr. DSTE/MMCT',
        letterDate: daysAgo(4),
      },
    });
    const extensionId = created.json<{ extensionRequest: { id: string } }>()
      .extensionRequest.id;
    await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${extensionId}/finalise`,
      organisationId,
    });

    const beforeReply = await register('extensions');
    expect(beforeReply.entries.filter((row) => row.id === extensionId)).toHaveLength(1);

    const responded = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${extensionId}/response-document`,
      organisationId,
      headers: { 'content-type': 'application/pdf' },
      payload: pdfBytes(),
    });
    expect(responded.statusCode, responded.body).toBe(200);
    const answered = await authed(owner, {
      method: 'POST',
      url: `/api/extension-requests/${extensionId}/respond`,
      organisationId,
      payload: { outcome: 'accepted' },
    });
    expect(answered.statusCode, answered.body).toBe(200);

    const listed = await register('extensions');
    const pair = listed.entries.filter((row) => row.id === extensionId);
    expect(pair).toHaveLength(2);
    const [request, reply] = pair;
    // The request now reads `replied`, the same derived word a letter
    // gets: it is the ANSWER that was accepted, not the letter that asked.
    expect(request?.direction).toBe('outward');
    expect(request?.status).toBe('replied');
    expect(reply?.direction).toBe('inward');
    expect(reply?.status).toBe('approved');
    expect(reply?.reference).toBe(request?.number);
    expect(reply?.extensionUntil).toBe(daysAgo(-320));

    // A request the railway has answered counts as the two rows it is.
    expect(listed.counts.extensions).toBe(listed.entries.length);
  });

  it('excludes a back-filled paper letter from the awaiting-response banner', async () => {
    const before = (await register('extensions')).awaitingExtensionResponses;
    const backfilled = await authed(owner, {
      method: 'POST',
      url: `/api/works/${openWorkId}/extension-requests/backfill`,
      organisationId,
      payload: {
        reference: 'PL-281/EOT/PAPER/1',
        letterDate: daysAgo(3),
        proposedCompletionDate: daysAgo(-330),
        reason: 'A paper letter posted before this product was adopted.',
        addressee: 'Sr. DSTE/MMCT',
      },
    });
    expect(backfilled.statusCode, backfilled.body).toBe(201);

    const after = await register('extensions');
    // It IS a row on the tab — it is a real letter that went out.
    expect(after.entries.some((row) => row.reference === 'PL-281/EOT/PAPER/1')).toBe(
      true,
    );
    // It is NOT a prompt to chase anybody: the banner counts what this
    // product sent and can still be told the answer to.
    expect(after.awaitingExtensionResponses).toBe(before);
  });

  it('reads an inspection call as its outward request and its inward letter', async () => {
    const [call] = await admin<{ id: string }[]>`
      insert into inspection_calls (
        organisation_id, work_id, sequence_number, agency, requested_on,
        agency_call_number, call_letter_received_on, created_by_user_id
      )
      values (
        ${organisationId}, ${openWorkId}, 1, 'RDSO', ${daysAgo(31)},
        'RDSO/CALL/8821', ${daysAgo(27)}, 'fixture'
      )
      returning id
    `;
    await admin`
      insert into inspection_call_counters (organisation_id, work_id, next_value)
      values (${organisationId}, ${openWorkId}, 2)
      on conflict do nothing
    `;
    const listed = await register('inspection');
    const rows = listed.entries.filter((entry) => entry.id === call?.id);
    expect(rows).toHaveLength(2);
    const [outward, inward] = rows;
    expect(outward?.direction).toBe('outward');
    expect(outward?.number).toBe(`INS/${openWorkCode}/1`);
    expect(outward?.subject).toBe('RDSO inspection call placing request');
    expect(inward?.direction).toBe('inward');
    expect(inward?.number).toBe('RDSO/CALL/8821');
    expect(inward?.reference).toBe(`INS/${openWorkCode}/1`);
    expect(inward?.status).toBe('received');
    // A call with an inward letter counts as the two letters it is.
    expect(listed.counts.inspection).toBe(2);

    // Withdrawing the call withdraws the letter that answered it: BOTH
    // rows read cancelled, or the register would show a live inward
    // letter belonging to a call that no longer stands.
    await admin`
      update inspection_calls
      set status = 'cancelled',
          cancelled_at = now(),
          cancelled_by_user_id = 'fixture',
          cancellation_reason = 'Withdrawn for the test'
      where id = ${call?.id ?? ''}
    `;
    const withdrawn = (await register('inspection')).entries.filter(
      (entry) => entry.id === call?.id,
    );
    expect(withdrawn.map((entry) => entry.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('the walls', () => {
  it('refuses a write from a viewer and reads from another organisation', async () => {
    const refused = await writeOutward(
      {
        letterDate: daysAgo(14),
        contactId,
        subject: 'A letter a viewer may not write',
        body: 'Viewers read the register; they do not write to it.',
      },
      viewer,
    );
    expect(refused.statusCode, refused.body).toBe(403);

    // The other organisation's register is empty, not forbidden: RLS
    // hides the rows rather than the endpoint.
    const foreign = await register('outward', outsider, outsiderOrganisationId);
    expect(foreign.entries).toHaveLength(0);
    expect(foreign.counts).toEqual({
      outward: 0,
      inward: 0,
      extensions: 0,
      inspection: 0,
    });
  });

  it('hides letters of a Work an assigned member is not on, counts included', async () => {
    const onOpen = await writeOutward({
      letterDate: daysAgo(13),
      contactId,
      workId: openWorkId,
      subject: 'Letter on the assigned Work',
      body: 'Visible to the member assigned to this Work.',
    });
    const onClosed = await writeOutward({
      letterDate: daysAgo(12),
      contactId: secondContactId,
      workId: closedWorkId,
      subject: 'Letter on the unassigned Work',
      body: 'Not visible to a member assigned elsewhere.',
    });
    const general = await writeOutward({
      letterDate: daysAgo(11),
      contactId,
      subject: 'General correspondence, filed against no Work',
      body: 'An invitation to quote arrives before there is a Work.',
    });
    for (const response of [onOpen, onClosed, general]) {
      expect(response.statusCode, response.body).toBe(201);
    }
    const [assignedUser] = await admin<{ id: string }[]>`
      select "id" from auth_users where "email" = ${assignedEmail}
    `;
    const assignedUserId = assignedUser?.id ?? '';
    expect(assignedUserId).not.toBe('');
    await admin`
      insert into work_assignments (organisation_id, work_id, user_id, created_by_user_id)
      values (${organisationId}, ${openWorkId}, ${assignedUserId}, 'fixture')
      on conflict do nothing
    `;

    const scoped = await register('outward', assigned);
    const subjects = scoped.entries.map((entry) => entry.subject);
    expect(subjects).toContain('Letter on the assigned Work');
    expect(subjects).toContain('General correspondence, filed against no Work');
    expect(subjects).not.toContain('Letter on the unassigned Work');

    // The count obeys the same predicate, or the tab label would leak the
    // size of a register this member cannot read.
    const full = await register('outward');
    expect(scoped.counts.outward).toBeLessThan(full.counts.outward);
    expect(scoped.counts.outward).toBe(scoped.entries.length);
  });

  it('refuses a cursor naming a letter the caller may not read', async () => {
    const hidden = await writeOutward({
      letterDate: daysAgo(10),
      contactId,
      workId: closedWorkId,
      subject: 'A letter behind the work-scope wall',
      body: 'Its id must not work as a cursor for somebody outside the scope.',
    });
    const hiddenId = hidden.json<{ id: string }>().id;
    const probe = await authed(assigned, {
      method: 'GET',
      url: `/api/correspondence?tab=outward&limit=5&cursor=${hiddenId}`,
      organisationId,
    });
    expect(probe.statusCode, probe.body).toBe(400);
    expect(probe.json<{ code: string }>().code).toBe('CURSOR_INVALID');
  });

  it('pages the register without repeating or skipping a letter', async () => {
    const all = await register('outward');
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const answer: CorrespondenceListResponse = await register(
        'outward',
        owner,
        organisationId,
        { limit: '3', ...(cursor === null ? {} : { cursor }) },
      );
      seen.push(...answer.entries.map((entry) => entry.id));
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all.entries.map((entry) => entry.id));
  });
});

describe('writing an outward letter', () => {
  it('snapshots the addressee so a later rename cannot readdress it', async () => {
    const written = await writeOutward(
      {
        letterDate: daysAgo(9),
        contactId: secondContactId,
        subject: 'Addressed before the office was renamed',
        body: 'The name on this letter is the name it went out under.',
      },
      office,
    );
    expect(written.statusCode, written.body).toBe(201);
    const { id } = written.json<{ id: string }>();

    await authed(owner, {
      method: 'PATCH',
      url: `/api/masters/contacts/${secondContactId}`,
      organisationId,
      payload: { designation: 'SSE/Tele/Planning/BCT' },
    });

    const listed = await register('outward');
    expect(listed.entries.find((entry) => entry.id === id)?.counterparty).toBe(
      'SSE/Tele/Planning/MMCT',
    );
  });

  it('refuses a retired contact at the moment of writing', async () => {
    const contact = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: { designation: 'Retired office', address: 'Nowhere' },
    });
    const retiredId = contact.json<{ id: string }>().id;
    const retired = await authed(owner, {
      method: 'POST',
      url: `/api/masters/contacts/${retiredId}/retire`,
      organisationId,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    const response = await writeOutward({
      letterDate: daysAgo(8),
      contactId: retiredId,
      subject: 'Addressed to a retired office',
      body: 'This office no longer exists in the masters.',
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('CONTACT_RETIRED');
  });
});
