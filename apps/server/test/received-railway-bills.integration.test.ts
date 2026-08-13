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
/** Hierarchies whose certificates are all long expired. */
let expiredPkis: TestPki[];

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
  // Three hierarchies whose SIGNER CERTIFICATES are genuinely distinct —
  // different licensed CA, different serial. Three copies of one
  // certificate would be indistinguishable to the distinct-signer rule,
  // and a fixture that could not tell them apart would prove nothing about
  // a check whose whole job is telling them apart.
  signerPkis = [
    createTestPki({
      rootCommonName: 'CCA India 2022',
      caCommonName: 'XtraTrust Sub CA 2022',
      signerCommonName: 'CONTRACTOR SIGNATORY',
      serialBase: 100,
    }),
    createTestPki({
      rootCommonName: 'CCA India 2015',
      caCommonName: 'Capricorn Sub CA for Organisation DSC 2022',
      signerCommonName: 'RAILWAY ENGINEER REP',
      serialBase: 200,
    }),
    createTestPki({
      rootCommonName: 'CCA India 2014',
      caCommonName: 'SafeScrypt sub-CA for Class 3 Organization 2022',
      signerCommonName: 'RAILWAY SR DSTE',
      serialBase: 300,
    }),
  ];
  unknownPki = createTestPki({ rootCommonName: 'Some Other Root', serialBase: 400 });
  // Three distinct hierarchies again, all long expired, all with their
  // roots installed: the expiry ruling has to be provable independently of
  // the distinct-signer one.
  expiredPkis = [1, 2, 3].map((index) =>
    createTestPki({
      rootCommonName: `CCA India 201${String(index)}`,
      caCommonName: `Expired Licensed CA ${String(index)}`,
      signerCommonName: `EXPIRED SIGNATORY ${String(index)}`,
      serialBase: 500 + index * 10,
      notBefore: new Date('2012-01-01T00:00:00Z'),
      notAfter: new Date('2015-01-01T00:00:00Z'),
    }),
  );

  const anchorDir = path.join(workspace, 'anchors');
  await mkdir(anchorDir, { recursive: true });
  for (const [index, pki] of signerPkis.entries()) {
    await writeFile(path.join(anchorDir, `root-${String(index)}.pem`), pki.root.pem);
  }
  // The expired hierarchies' roots ARE installed: the point of the expiry
  // ruling is that a genuine chain to a known anchor stays acceptable once
  // its certificates age out, and that only works if the anchor is the one
  // being aged out with them.
  for (const [index, pki] of expiredPkis.entries()) {
    await writeFile(
      path.join(anchorDir, `root-expired-${String(index)}.pem`),
      pki.root.pem,
    );
  }

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    // The shipped upload throttle is 30 per ten minutes, and this suite
    // records more bills than that on purpose. The throttle has its own
    // tests (`upload-inventory`), and a suite that quietly stayed under
    // the limit would be shaping its coverage around an unrelated rule.
    rateLimits: { upload: { windowMs: 10 * 60_000, max: 500 } },
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
    // Every certificate in these chains expired in 2015 and the bill is
    // signed today, so the verifier reaches the installed anchors and
    // finds the paths outside their validity windows: `signed_chain_expired`.
    // Three distinct expired hierarchies, so this proves the EXPIRY rule
    // and not, accidentally, the distinct-signer one.
    const bookId = await bookWith('RBC2', (letterNumber) =>
      signedBill({ letterNumber, pkis: expiredPkis, signatures: 3 }),
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

  it('refuses three signatures made by ONE certificate', async () => {
    // The cardinality rule alone cannot tell three signers from one signer
    // signing three times, and one signer three times is what a forged
    // approval chain looks like. Owner ruling of 2026-08-14 -- see the
    // note in railway-bill-verdict.ts.
    const oneCertificate = signerPkis[0];
    if (oneCertificate === undefined) throw new Error('no signing hierarchy');
    const bookId = await bookWith('RBCS', (letterNumber) =>
      signedBill({ letterNumber, pkis: [oneCertificate], signatures: 3 }),
    );
    // The document verdict is perfectly green. That is the point.
    const [row] = await admin<{ signature_status: string }[]>`
      select signature_status from received_railway_bills
      where measurement_book_id = ${bookId}
    `;
    expect(row?.signature_status).toBe('signed_and_intact');

    const response = await close(bookId);
    expect(response.statusCode, response.body).toBe(409);
    const body = response.json<{ code: string; details?: { refusal: string } }>();
    expect(body.code).toBe('MB_RAILWAY_BILL_UNVERIFIED');
    expect(body.details?.refusal).toBe('signature_signers');
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

describe('closing and discarding cannot both win', () => {
  /*
   * The write skew this closes.
   *
   * Close locked the book; discard locked the bill. Under READ COMMITTED
   * neither sees the other's uncommitted write, so both could commit: the
   * measurement ended up permanently closed (closure is append-once)
   * against a bill that had been discarded, the partial one-live-bill
   * index -- WHERE discarded_at IS NULL -- then had a free slot, and the
   * payment gate, which reads only closed_at, went on saying yes.
   *
   * Both paths now take both locks, book first.
   */
  it('serialises a concurrent close and discard, in either arrival order', async () => {
    for (const closeFirst of [true, false]) {
      const { bookId, letterNumber } = await seedFinalizedBook({
        organisationId,
        userId: ownerUserId,
        label: closeFirst ? 'RBX1' : 'RBX2',
        sequence: 1,
      });
      const created = await upload(bookId, signedBill({ letterNumber }));
      expect(created.statusCode, created.body).toBe(201);
      const bill = created.json<ReceivedRailwayBill>();

      const discard = () =>
        authed({
          method: 'POST',
          url: `/api/received-railway-bills/${bill.id}/discard`,
          organisationId,
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: { reason: 'raced against the closure' },
        });

      // Issued together, so the two transactions genuinely overlap.
      const pair = closeFirst
        ? await Promise.all([close(bookId), discard()])
        : await Promise.all([discard(), close(bookId)]);
      const codes = pair.map((response) => response.statusCode);

      // Exactly one may succeed.
      expect(
        codes.filter((code) => code === 200).length,
        `${pair[0]?.body ?? ''} / ${pair[1]?.body ?? ''}`,
      ).toBe(1);

      const [after] = await admin<
        { closed_at: Date | null; discarded_at: Date | null }[]
      >`
        select m.closed_at, b.discarded_at
        from measurement_books m
        join received_railway_bills b on b.id = ${bill.id}
        where m.id = ${bookId}
      `;
      // The forbidden state: closed against a discarded bill.
      expect(
        after?.closed_at !== null && after?.discarded_at !== null,
        'a closed measurement is resting on a discarded bill',
      ).toBe(false);
    }
  });

  it('refuses a second bill against a closed measurement', async () => {
    // The same hazard deterministically: even with a bill discarded the
    // partial index would admit another, so the upload route reads
    // closed_at itself.
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBX3',
      sequence: 1,
    });
    expect((await upload(bookId, signedBill({ letterNumber }))).statusCode).toBe(201);
    expect((await close(bookId)).statusCode).toBe(200);

    const second = await upload(
      bookId,
      signedBill({ letterNumber, billNumber: 'CR/BBY/S&T/2026/0009/B9' }),
    );
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('MB_ALREADY_CLOSED');
  });

  it('refuses to discard any bill of a closed measurement', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBX4',
      sequence: 1,
    });
    const created = await upload(bookId, signedBill({ letterNumber }));
    const bill = created.json<ReceivedRailwayBill>();
    expect((await close(bookId)).statusCode).toBe(200);

    const discarded = await authed({
      method: 'POST',
      url: `/api/received-railway-bills/${bill.id}/discard`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { reason: 'after the closure' },
    });
    expect(discarded.statusCode, discarded.body).toBe(409);
    expect(discarded.json<{ code: string }>().code).toBe('MB_ALREADY_CLOSED');
  });

  it('refuses to cancel a closed Measurement Book, in words', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBX5',
      sequence: 1,
    });
    expect((await upload(bookId, signedBill({ letterNumber }))).statusCode).toBe(201);
    expect((await close(bookId)).statusCode).toBe(200);

    const cancelled = await authed({
      method: 'POST',
      url: `/api/measurement-books/${bookId}/cancel`,
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { note: 'withdrawing the measurement' },
    });
    // A route refusal, not the database trigger surfacing as a 500.
    expect(cancelled.statusCode, cancelled.body).toBe(409);
    expect(cancelled.json<{ code: string }>().code).toBe('MB_ALREADY_CLOSED');
    // ...and the database refuses it too, for a writer that never asked.
    await expect(
      admin`
        update measurement_books set status = 'cancelled',
            cancellation_note = 'raw', cancelled_by_user_id = 'x',
            cancelled_at = now()
        where id = ${bookId}
      `,
    ).rejects.toThrow(/closed by a railway bill cannot be cancelled/);
  });

  it('cannot be given the same measurement twice, by construction', async () => {
    // Worth stating as a test because the first draft of this route
    // carried a defensive scan for it. It is unreachable: a Work's
    // finalized Measurement Books are unique per measurement sequence, and
    // a bill is tied to its Work by the letter number it prints, so there
    // is no second book on this Work for the same measurement to reach.
    // The refusal below is the sequence check doing that work.
    const { workId, bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBX6',
      sequence: 1,
    });
    expect((await upload(bookId, signedBill({ letterNumber }))).statusCode).toBe(201);

    // A second finalized book on the same Work cannot take sequence 1...
    const clash = randomUUID();
    await admin`
      insert into measurement_books (
        id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
      )
      values (
        ${clash}, ${organisationId}, ${workId}, 'draft', '2026-05-09',
        ${ownerUserId}, 'on_account'
      )
    `;
    await expect(
      admin`
        update measurement_books
        set status = 'finalized', mb_number = 'RBX6-MB-09', sequence_number = 1,
            total_amount = '1.00', remark_template_version = 'mb-remark-v1',
            finalized_at = now(), finalized_by_user_id = ${ownerUserId}
        where id = ${clash}
      `,
    ).rejects.toThrow(/measurement_books_sequence_per_work/);
    await admin`delete from measurement_books where id = ${clash}`;

    // ...and a bill naming measurement 1 is refused by any other book.
    const second = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBX7',
      sequence: 2,
    });
    const response = await upload(
      second.bookId,
      signedBill({
        letterNumber: second.letterNumber,
        billNumber: 'CR/BBY/S&T/2026/0009/B8',
        measurementTail: '16/OAM/FL2/01',
      }),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'RAILWAY_BILL_MEASUREMENT_UNMATCHED',
    );
  });
});

describe('the database refuses what the route would have', () => {
  it('will not close a book against a bill that is not its own', async () => {
    const first = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBD1',
      sequence: 1,
    });
    const other = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBD2',
      sequence: 1,
    });
    const created = await upload(
      first.bookId,
      signedBill({ letterNumber: first.letterNumber }),
    );
    const bill = created.json<ReceivedRailwayBill>();

    await expect(
      admin`
        update measurement_books
        set closed_at = now(), closed_by_user_id = 'raw',
            closed_by_received_bill_id = ${bill.id}
        where id = ${other.bookId}
      `,
    ).rejects.toThrow(/settles a different measurement/);
  });

  it('will not close a book against an unverified or discarded bill', async () => {
    const { bookId, letterNumber } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBD3',
      sequence: 1,
    });
    // One signature only. Note what the DOCUMENT verdict says about it:
    // `signed_and_intact`, because that one signature is perfectly good.
    // The trigger refuses it on the count instead, which is why both arms
    // exist rather than one.
    const weak = await upload(bookId, signedBill({ letterNumber, signatures: 1 }));
    const weakBill = weak.json<ReceivedRailwayBill>();
    await expect(
      admin`
        update measurement_books
        set closed_at = now(), closed_by_user_id = 'raw',
            closed_by_received_bill_id = ${weakBill.id}
        where id = ${bookId}
      `,
    ).rejects.toThrow(/fewer than the three signatures/);

    // The status arm: an unsigned bill, refused on its verdict.
    await admin`
      update received_railway_bills set discarded_at = now(),
          discarded_by_user_id = 'raw'
      where id = ${weakBill.id}
    `;
    const unsigned = await upload(bookId, signedBill({ letterNumber, signatures: 0 }));
    const unsignedBill = unsigned.json<ReceivedRailwayBill>();
    await expect(
      admin`
        update measurement_books
        set closed_at = now(), closed_by_user_id = 'raw',
            closed_by_received_bill_id = ${unsignedBill.id}
        where id = ${bookId}
      `,
    ).rejects.toThrow(/signature verdict/);
    await admin`
      update received_railway_bills set discarded_at = now(),
          discarded_by_user_id = 'raw'
      where id = ${unsignedBill.id}
    `;

    const good = await upload(bookId, signedBill({ letterNumber }));
    const goodBill = good.json<ReceivedRailwayBill>();
    await admin`
      update received_railway_bills set discarded_at = now(),
          discarded_by_user_id = 'raw'
      where id = ${goodBill.id}
    `;
    await expect(
      admin`
        update measurement_books
        set closed_at = now(), closed_by_user_id = 'raw',
            closed_by_received_bill_id = ${goodBill.id}
        where id = ${bookId}
      `,
    ).rejects.toThrow(/discarded and cannot close/);
  });

  it('will not let a bill be BORN paid against an open measurement', async () => {
    // The 0006 CHECK admits status='paid' on a fresh row, so an
    // UPDATE-only guard would have watched the door with the window open.
    const { bookId, workId } = await seedFinalizedBook({
      organisationId,
      userId: ownerUserId,
      label: 'RBD4',
      sequence: 1,
    });
    await expect(
      admin`
        insert into bills (
          organisation_id, work_id, bill_number, lines_snapshot, total_amount,
          prepared_by_user_id, mb_id, status
        )
        values (
          ${organisationId}, ${workId}, 91, '[]'::jsonb, '1.00',
          ${ownerUserId}, ${bookId}, 'paid'
        )
      `,
    ).rejects.toThrow(/Measurement Book is not closed/);
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
