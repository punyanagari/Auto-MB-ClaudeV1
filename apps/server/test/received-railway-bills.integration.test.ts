import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  MeasurementBookDetailResponse,
  ReceivedRailwayBill,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { assertNoForeignKeyOrphans, removeOrganisationResidue } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import { loadTrustAnchors } from '../src/pdf-signature.js';
import { appendSignature, createTestPki, type TestPki } from './helpers/signed-pdf.js';
import { railwayBillText, textLayoutPdf } from './helpers/railway-bill-pdf.js';

/**
 * The railway bill, end to end: recorded against the Measurement Book it
 * settles, and gating the two acts that must not rest on an unverified
 * document — closing the measurement, and recording payment.
 *
 * The signature cases are the point of this suite rather than an aside.
 * The owner's 2026-08-13 rulings are that a bill settles when its
 * signatures are INTACT and CHAIN to an installed anchor, and that
 * certificate EXPIRY is ignored, and the third of those is the one no
 * amount of reading the code proves: it has to be signed with an expired
 * certificate and then accepted.
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
const ownerEmail = `rb-owner-${runId}@integration.test`;
const strangerEmail = `rb-stranger-${runId}@integration.test`;
const password = `integration-password-${runId}`;
const LETTER_NUMBER = '00341490147964';

let admin: Sql;
let app: FastifyInstance;
let workspace: string;
let organisationId: string;
let strangerOrganisationId: string;
let cookie: string;
let strangerCookie: string;
let ownerUserId: string;
/** Three licensed CAs under three roots, as the real bill has. */
let signerPkis: TestPki[];
/** A hierarchy whose root is deliberately NOT installed. */
let unknownPki: TestPki;
/** A hierarchy whose certificates are all long expired. */
let expiredPki: TestPki;

const organisationIds: string[] = [];

function extractCookies(setCookie: string | string[] | undefined): string {
  const raw = setCookie === undefined ? [] : ([] as string[]).concat(setCookie);
  return raw.map((entry) => entry.split(';')[0] ?? '').join('; ');
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
 * A bill PDF signed the way IWRCMS signs one: three incremental
 * revisions, so only the last signature covers the whole file.
 */
function signedBill(
  options: {
    readonly pkis?: readonly TestPki[];
    readonly signatures?: number;
    readonly text?: readonly string[];
    readonly letterNumber?: string;
    readonly measurementTail?: string;
    readonly billNumber?: string;
    readonly billAmount?: string;
    readonly corruptSignature?: boolean;
  } = {},
): Buffer {
  const pkis = options.pkis ?? signerPkis;
  const count = options.signatures ?? 3;
  const roles = [
    'Bill Signing by Contractor',
    'Bill Signing by ASTE/Tele/BY',
    'Bill Signing by SRDSTECO/BB',
  ];
  let bytes = textLayoutPdf(
    options.text ??
      railwayBillText({
        letterNumber: options.letterNumber ?? LETTER_NUMBER,
        ...(options.measurementTail === undefined
          ? {}
          : { measurementTail: options.measurementTail }),
        ...(options.billNumber === undefined ? {} : { billNumber: options.billNumber }),
        ...(options.billAmount === undefined ? {} : { billAmount: options.billAmount }),
      }),
  );
  for (let index = 0; index < count; index += 1) {
    const pki = pkis[index % pkis.length];
    if (pki === undefined) throw new Error('no signing hierarchy for this signature');
    bytes = appendSignature(bytes, {
      pki,
      shape: 'adbe.pkcs7.sha1',
      signerName: `RAILWAY SIGNATORY ${String(index + 1)}`,
      reason: roles[index] ?? 'Bill Signing',
      corruptSignature: options.corruptSignature === true && index === count - 1,
    });
  }
  return bytes;
}

async function seedFinalizedBook(options: {
  readonly organisationId: string;
  readonly userId: string;
  readonly label: string;
  readonly sequence: number;
  readonly letterNumber?: string;
  readonly withBill?: boolean;
}): Promise<{
  workId: string;
  bookId: string;
  billId: string;
  letterNumber: string;
}> {
  const workId = randomUUID();
  const bookId = randomUUID();
  const billId = randomUUID();
  // `works` holds one Work per letter number per organisation, so each
  // seeded Work needs its own letter — and the bill uploaded against it
  // has to print the same one, which is what the link is checked on.
  const letterNumber = options.letterNumber ?? `003414901${options.label}`;
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${options.organisationId}, ${options.label},
      ${letterNumber}, '2026-01-01',
      'Train information display boards', '195574112.38', '169228497.35',
      'per_schedule', ${options.userId}
    )
  `;
  await admin`
    insert into measurement_books (
      id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
    )
    values (
      ${bookId}, ${options.organisationId}, ${workId}, 'draft', '2026-05-09',
      ${options.userId}, 'on_account'
    )
  `;
  await admin`
    update measurement_books
    set status = 'finalized', mb_number = ${`${options.label}-MB-0${String(options.sequence)}`},
        sequence_number = ${options.sequence}, total_amount = '24516112.00',
        remark_template_version = 'mb-remark-v1', finalized_at = now(),
        finalized_by_user_id = ${options.userId}
    where id = ${bookId}
  `;
  // Only the payment gate needs a prepared bill. The other twenty seeded
  // books were each creating one and never using it, which is twenty
  // rows of churn in a database P11's block budgets are measured against
  // while this suite runs.
  if (options.withBill === true) {
    await admin`
      insert into bills (
        id, organisation_id, work_id, bill_number, lines_snapshot, total_amount,
        prepared_by_user_id, mb_id
      )
      values (
        ${billId}, ${options.organisationId}, ${workId}, 1, '[]'::jsonb,
        '24516112.00', ${options.userId}, ${bookId}
      )
    `;
  }
  return { workId, bookId, billId, letterNumber };
}

async function upload(
  bookId: string,
  bytes: Buffer,
  options: { readonly organisationId?: string; readonly as?: string } = {},
) {
  return authed({
    method: 'POST',
    url: `/api/measurement-books/${bookId}/received-railway-bill?filename=bill.pdf`,
    organisationId: options.organisationId ?? organisationId,
    ...(options.as === undefined ? {} : { as: options.as }),
    headers: { 'content-type': 'application/pdf', origin: 'http://127.0.0.1:3000' },
    payload: bytes,
  });
}

async function close(bookId: string) {
  return authed({
    method: 'POST',
    url: `/api/measurement-books/${bookId}/close`,
    organisationId,
    headers: { origin: 'http://127.0.0.1:3000' },
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-railway-bill-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the received-railway-bill integration tests. ' +
        `Underlying error: ${String(error)}`,
    );
  }
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

  workspace = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-rb-int-'));
  const storageDir = path.join(workspace, 'objects');
  await mkdir(storageDir, { recursive: true });

  // Three roots installed, one not, and one expired-but-installed — the
  // three trust outcomes the gate has to tell apart.
  signerPkis = [
    createTestPki({
      rootCommonName: 'CCA India 2022',
      signerCommonName: 'CONTRACTOR SIGNATORY',
    }),
    createTestPki({
      rootCommonName: 'CCA India 2015',
      signerCommonName: 'RAILWAY ENGINEER REP',
    }),
    createTestPki({
      rootCommonName: 'CCA India 2014',
      signerCommonName: 'RAILWAY SR DSTE',
    }),
  ];
  unknownPki = createTestPki({ rootCommonName: 'Some Other Root' });
  expiredPki = createTestPki({
    rootCommonName: 'CCA India 2011',
    signerCommonName: 'RAILWAY SR DSTE',
    notBefore: new Date('2012-01-01T00:00:00Z'),
    notAfter: new Date('2015-01-01T00:00:00Z'),
  });

  const anchorDir = path.join(workspace, 'anchors');
  await mkdir(anchorDir, { recursive: true });
  for (const [index, pki] of signerPkis.entries()) {
    await writeFile(path.join(anchorDir, `root-${String(index)}.pem`), pki.root.pem);
  }
  // The expired hierarchy's root IS installed: the point of the expiry
  // ruling is that a genuine chain to a known anchor stays acceptable
  // once its certificates age out, and that only works if the anchor is
  // the one being aged out with them.
  await writeFile(path.join(anchorDir, 'root-expired.pem'), expiredPki.root.pem);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    pdfTrustAnchors: await loadTrustAnchors(anchorDir),
  });
  await app.ready();

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: ownerEmail, password, name: 'Railway Bill Owner' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  cookie = extractCookies(signUp.headers['set-cookie']);

  const created = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'Railway Bill Org', slug: `rb-org-${runId}` },
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

  const strangerSignUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email: strangerEmail, password, name: 'Stranger' },
  });
  expect(strangerSignUp.statusCode, strangerSignUp.body).toBe(200);
  strangerCookie = extractCookies(strangerSignUp.headers['set-cookie']);
  const strangerOrg = await app.inject({
    method: 'POST',
    url: '/api/organisations',
    headers: { cookie: strangerCookie, origin: 'http://127.0.0.1:3000' },
    payload: { name: 'Stranger Org', slug: `rb-stranger-${runId}` },
  });
  expect(strangerOrg.statusCode, strangerOrg.body).toBe(201);
  strangerOrganisationId = strangerOrg.json<{ id: string }>().id;
  organisationIds.push(strangerOrganisationId);
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (admin !== undefined) {
    await removeOrganisationResidue(admin, organisationIds);
    await assertNoForeignKeyOrphans(admin);
    await admin.end();
  }
  await rm(workspace, { recursive: true, force: true });
});

describe('recording the railway bill', () => {
  it('reads the bill out of the PDF and links it by measurement sequence', async () => {
    const { bookId, workId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBW1',
      sequence: 1,
    });
    const response = await upload(bookId, signedBill({ letterNumber }));
    expect(response.statusCode, response.body).toBe(201);
    const bill = response.json<ReceivedRailwayBill>();

    expect(bill.billNumber).toBe('CR/BBY/S&T/2026/0009/B1');
    expect(bill.billDate).toBe('2026-05-11');
    expect(bill.billAmount).toBe('24516112.00');
    expect(bill.rateInclusiveOfGst).toBe(true);
    expect(bill.measurementSequence).toBe(1);
    expect(bill.measurementBookId).toBe(bookId);
    expect(bill.workId).toBe(workId);

    // The wrap survived a real PDF and a real Poppler, not just the unit
    // test's committed text: `.../CSTM/11393` and `16/OAM/FL2/01` are two
    // fragments on the page and one measurement number here.
    expect(bill.measurementNumber).toBe('00341490147964/CSTM/1139316/OAM/FL2/01');

    // Three signatures, all chaining to an installed anchor, the last
    // covering the file.
    expect(bill.signatureStatus).toBe('signed_and_intact');
    expect(bill.signatureVerdict?.signatures).toHaveLength(3);
    expect(bill.settleable).toBe(true);

    // Nothing about the bill was asserted over the wire, so nothing about
    // it can be wrong in a way the document does not also say.
    const [row] = await admin<{ extraction_payload: { billNumber: string } }[]>`
      select extraction_payload from received_railway_bills where id = ${bill.id}
    `;
    expect(row?.extraction_payload.billNumber).toBe('CR/BBY/S&T/2026/0009/B1');
  });

  it('refuses a bill whose measurement sequence is another book’s', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBW2',
      sequence: 2,
    });
    // The default fixture is measurement 01; this book is measurement 02.
    const response = await upload(bookId, signedBill({ letterNumber }));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'RAILWAY_BILL_MEASUREMENT_UNMATCHED',
    );

    // ...and accepts the bill that does name it, proving the refusal is
    // about the sequence and not about the book.
    const matching = await upload(
      bookId,
      signedBill({
        letterNumber,
        billNumber: 'CR/BBY/S&T/2026/0009/B2',
        measurementTail: '16/OAM/FL2/02',
        billAmount: '8057057.0',
      }),
    );
    expect(matching.statusCode, matching.body).toBe(201);
    const bill = matching.json<ReceivedRailwayBill>();
    expect(bill.measurementSequence).toBe(2);
    // The trailing `.0` the railway prints and the scale the column keeps.
    expect(bill.billAmount).toBe('8057057.00');
  });

  it('refuses a bill raised under a different letter', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBW3',
      sequence: 1,
      letterNumber: '00000000000001',
    });
    expect(letterNumber).toBe('00000000000001');
    // The bill prints the corpus letter; this Work is a different one.
    const response = await upload(bookId, signedBill({ letterNumber: LETTER_NUMBER }));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('RAILWAY_BILL_NOT_FOR_WORK');
  });

  it('refuses a second live bill against the same measurement', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBW4',
      sequence: 1,
    });
    expect((await upload(bookId, signedBill({ letterNumber }))).statusCode).toBe(201);
    const second = await upload(bookId, signedBill({ letterNumber }));
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('RAILWAY_BILL_ALREADY_RECORDED');
  });

  it('refuses a PDF with no readable bill in it, naming the field', async () => {
    const { bookId } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBW5',
      sequence: 1,
    });
    const response = await upload(
      bookId,
      signedBill({ text: ['Not a railway bill at all.'] }),
    );
    expect(response.statusCode, response.body).toBe(400);
    const body = response.json<{ code: string; details?: { field: string } }>();
    expect(body.code).toBe('RAILWAY_BILL_EXTRACTION_FAILED');
    expect(body.details?.field).toBe('measurementNumber');
  });

  it('refuses a body that is not a PDF at all', async () => {
    const { bookId } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBW6',
      sequence: 1,
    });
    const response = await upload(bookId, Buffer.from('%NOT-A-PDF'));
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('NOT_A_PDF');
  });

  it('does not let another organisation see or record against the book', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBW7',
      sequence: 1,
    });
    const stranger = await upload(bookId, signedBill({ letterNumber }), {
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect([403, 404]).toContain(stranger.statusCode);
  });
});

describe('the verdict gate on closing a measurement', () => {
  async function bookWith(
    label: string,
    bill: (letterNumber: string) => Buffer,
  ): Promise<string> {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label,
      sequence: 1,
    });
    const response = await upload(bookId, bill(letterNumber));
    expect(response.statusCode, response.body).toBe(201);
    return bookId;
  }

  it('closes on three intact signatures chaining to an installed anchor', async () => {
    const bookId = await bookWith('RBC1', (letterNumber) =>
      signedBill({ letterNumber }),
    );
    const response = await close(bookId);
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json<MeasurementBookDetailResponse>();
    expect(detail.book.closedAt).not.toBeNull();
    expect(detail.book.closedByReceivedBillId).not.toBeNull();
    // Closure is not a status change: the book is still finalized, and
    // migration 0035's invoice-close guard is untouched by it.
    expect(detail.book.status).toBe('finalized');
  });

  it('IGNORES certificate expiry, which is the ruling that needed proving', async () => {
    // Every certificate in this chain expired in 2015 and the bill is
    // signed today, so the verifier reaches the installed anchor and
    // finds the path outside its validity window: `signed_chain_expired`.
    const bookId = await bookWith('RBC2', (letterNumber) =>
      signedBill({ letterNumber, pkis: [expiredPki], signatures: 3 }),
    );
    const [row] = await admin<{ signature_status: string }[]>`
      select signature_status from received_railway_bills
      where measurement_book_id = ${bookId}
    `;
    expect(row?.signature_status).toBe('signed_chain_expired');

    // ...and it closes anyway. Indian DSC signing certificates run two to
    // three years and none of these bills carries a timestamp, so every
    // bill the agency holds would eventually stop settling if expiry were
    // fatal.
    const response = await close(bookId);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('refuses a chain that reaches no installed anchor', async () => {
    const bookId = await bookWith('RBC3', (letterNumber) =>
      signedBill({ letterNumber, pkis: [unknownPki] }),
    );
    const response = await close(bookId);
    expect(response.statusCode, response.body).toBe(409);
    const body = response.json<{ code: string; details?: { refusal: string } }>();
    expect(body.code).toBe('MB_RAILWAY_BILL_UNVERIFIED');
    expect(body.details?.refusal).toBe('document_status');
  });

  it('refuses a bill carrying fewer than three signatures', async () => {
    const bookId = await bookWith('RBC4', (letterNumber) =>
      signedBill({ letterNumber, signatures: 2 }),
    );
    const response = await close(bookId);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ details?: { refusal: string } }>().details?.refusal).toBe(
      'signature_count',
    );
  });

  it('refuses an unsigned bill however complete it reads', async () => {
    const bookId = await bookWith('RBC5', (letterNumber) =>
      signedBill({ letterNumber, signatures: 0 }),
    );
    const response = await close(bookId);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ details?: { refusal: string } }>().details?.refusal).toBe(
      'document_status',
    );
  });

  it('refuses a bill whose last signature does not verify', async () => {
    const bookId = await bookWith('RBC6', (letterNumber) =>
      signedBill({ letterNumber, corruptSignature: true }),
    );
    const response = await close(bookId);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('MB_RAILWAY_BILL_UNVERIFIED');
  });

  it('refuses to close a measurement with no railway bill at all', async () => {
    const { bookId } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBC7',
      sequence: 1,
    });
    const response = await close(bookId);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('MB_RAILWAY_BILL_MISSING');
  });

  it('closes exactly once', async () => {
    const bookId = await bookWith('RBC8', (letterNumber) =>
      signedBill({ letterNumber }),
    );
    expect((await close(bookId)).statusCode).toBe(200);
    const again = await close(bookId);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('MB_ALREADY_CLOSED');

    // And the database says so too, not merely the handler: reopening is
    // refused with the application role's own privileges.
    await expect(
      admin`
        update measurement_books set closed_at = null, closed_by_user_id = null,
            closed_by_received_bill_id = null
        where id = ${bookId}
      `,
    ).rejects.toThrow(/cannot be reopened or re-closed/);
  });

  it('will not let the bill that closed a measurement be discarded', async () => {
    const bookId = await bookWith('RBC9', (letterNumber) =>
      signedBill({ letterNumber }),
    );
    const [bill] = await admin<{ id: string }[]>`
      select id from received_railway_bills where measurement_book_id = ${bookId}
    `;
    expect((await close(bookId)).statusCode).toBe(200);
    const response = await authed({
      method: 'POST',
      url: `/api/received-railway-bills/${bill?.id ?? ''}/discard`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'attached to the wrong measurement' },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('MB_ALREADY_CLOSED');
  });

  it('lets a bill that closed nothing be discarded, and another recorded', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBCA',
      sequence: 1,
    });
    expect(
      (await upload(bookId, signedBill({ letterNumber, signatures: 1 }))).statusCode,
    ).toBe(201);
    const [bill] = await admin<{ id: string }[]>`
      select id from received_railway_bills where measurement_book_id = ${bookId}
    `;
    const discarded = await authed({
      method: 'POST',
      url: `/api/received-railway-bills/${bill?.id ?? ''}/discard`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'the railway re-issued it with all three signatures' },
    });
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(discarded.json<ReceivedRailwayBill>().discardedAt).not.toBeNull();

    // The one-live-bill-per-measurement index counts live rows only.
    expect((await upload(bookId, signedBill({ letterNumber }))).statusCode).toBe(201);
    expect((await close(bookId)).statusCode).toBe(200);
  });

  it('freezes the recorded facts against a direct database edit', async () => {
    const bookId = await bookWith('RBCB', (letterNumber) =>
      signedBill({ letterNumber }),
    );
    const [bill] = await admin<{ id: string }[]>`
      select id from received_railway_bills where measurement_book_id = ${bookId}
    `;
    await expect(
      admin`
        update received_railway_bills set bill_amount = '1.00'
        where id = ${bill?.id ?? ''}
      `,
    ).rejects.toThrow(/bytes and extracted facts are immutable/);
    // The 0060 append-once guard, reused verbatim, covers the verdict —
    // and it fires on a CHANGE, so the attack has to name a verdict other
    // than the one this bill already carries.
    await expect(
      admin`
        update received_railway_bills set signature_status = 'unsigned',
            signature_verdict = null, signature_verified_at = null
        where id = ${bill?.id ?? ''}
      `,
    ).rejects.toThrow(/append-once/);
  });
});

describe('the verdict gate on recording payment', () => {
  it('refuses to mark a bill paid before the railway has settled it', async () => {
    const { bookId, billId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBP1',
      sequence: 1,
      withBill: true,
    });
    const submit = await authed({
      method: 'POST',
      url: `/api/bills/${billId}/status`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { status: 'submitted' },
    });
    expect(submit.statusCode, submit.body).toBe(200);

    const paid = await authed({
      method: 'POST',
      url: `/api/bills/${billId}/status`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { status: 'paid' },
    });
    expect(paid.statusCode, paid.body).toBe(409);
    expect(paid.json<{ code: string }>().code).toBe('BILL_MEASUREMENT_BOOK_NOT_CLOSED');

    // The money rule is enforced TWICE. Bypassing the handler entirely and
    // writing the status with the application role's own privileges is
    // refused by the trigger, which is the half that survives a future
    // route forgetting to ask.
    await expect(
      admin`update bills set status = 'paid', paid_at = now() where id = ${billId}`,
    ).rejects.toThrow(/Measurement Book is not closed/);

    // Once the railway's signed bill closes the measurement, payment is
    // recordable and nothing else changed.
    expect((await upload(bookId, signedBill({ letterNumber }))).statusCode).toBe(201);
    expect((await close(bookId)).statusCode).toBe(200);
    const again = await authed({
      method: 'POST',
      url: `/api/bills/${billId}/status`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { status: 'paid' },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<{ status: string }>().status).toBe('paid');
  });
});

describe('the register', () => {
  it('lists a Work’s railway bills with their settlement reading', async () => {
    const { workId, bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBL1',
      sequence: 1,
    });
    expect(
      (await upload(bookId, signedBill({ letterNumber, signatures: 1 }))).statusCode,
    ).toBe(201);

    const response = await authed({
      method: 'GET',
      url: `/api/works/${workId}/received-railway-bills`,
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { bills } = response.json<{ bills: ReceivedRailwayBill[] }>();
    expect(bills).toHaveLength(1);
    // The screen reads the same rule the gate does, so a bill shown as
    // settleable can never meet a route that disagrees.
    expect(bills[0]?.settleable).toBe(false);
    expect(bills[0]?.settlementRefusal).toBe('signature_count');
    expect(bills[0]?.measurementBookNumber).toBe('RBL1-MB-01');
  });

  it('serves the stored PDF back, and not to another organisation', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBL2',
      sequence: 1,
    });
    const created = await upload(bookId, signedBill({ letterNumber }));
    const bill = created.json<ReceivedRailwayBill>();

    const file = await authed({
      method: 'GET',
      url: `/api/received-railway-bills/${bill.id}/file`,
      organisationId,
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const stranger = await authed({
      method: 'GET',
      url: `/api/received-railway-bills/${bill.id}/file`,
      organisationId: strangerOrganisationId,
      as: strangerCookie,
    });
    expect([403, 404]).toContain(stranger.statusCode);
  });
});
