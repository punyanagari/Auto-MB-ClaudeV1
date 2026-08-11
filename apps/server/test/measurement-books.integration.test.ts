import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  Bill,
  ChallanDetailResponse,
  MeasurementBookDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations, withTenant } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * Milestone 8 phase 2: the stage-wise Measurement Book lifecycle
 * (ADR-0006; spec Â§5.9, R19). Three Works:
 *
 * - Work 1 drives the agency workbook scenario (matrix 80/10/0/10, unit
 *   mtr) through MB1..MB4 including a cancellation, proving the remark
 *   wording character-for-character and the TRUE-cumulative memory.
 * - Work 2 proves percentage-resolution failure, the final-MB sweep,
 *   the final-bill stage bases, and no-MB-after-final.
 * - Work 3 proves gapless numbering and claim uniqueness under
 *   concurrency.
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

interface WorkbookFixture {
  readonly case: {
    readonly measurementBooks: ReadonlyArray<{
      readonly mb: number;
      readonly expectedRemark: string;
    }>;
  };
}
const workbook = JSON.parse(
  readFileSync(
    new URL('./fixtures/mb-remark-workbook.v1.json', import.meta.url),
    'utf8',
  ),
) as WorkbookFixture;
const expectedRemark = (mb: number): string => {
  const row = workbook.case.measurementBooks.find((entry) => entry.mb === mb);
  if (!row) throw new Error(`workbook fixture has no MB ${String(mb)}`);
  return row.expectedRemark;
};

const runId = randomBytes(5).toString('hex');
const ownerEmail = `mb-owner-${runId}@integration.test`;
const clerkEmail = `mb-clerk-${runId}@integration.test`;
const siteEmail = `mb-site-${runId}@integration.test`;
const outsiderEmail = `mb-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const work1Code = `MB1W${runId.slice(0, 4).toUpperCase()}`;
const work2Code = `MB2W${runId.slice(0, 4).toUpperCase()}`;
const work3Code = `MB3W${runId.slice(0, 4).toUpperCase()}`;

let admin: Sql;
let appPool: Sql;
let app: FastifyInstance;
let storageDir: string;
let fakeGotenberg: http.Server;
const gotenbergBodies: string[] = [];
let organisationId: string;
let outsiderOrganisationId: string;
let ownerUserId: string;
let consigneeMasterId: string;

let work1Id: string;
let cableItemId: string;
let work2Id: string;
let supplyItemId: string;
let installItemId: string;
let work3Id: string;
let w3ItemId: string;

// Work 1 running state.
let dc1Id: string;
let dc2Id: string;
let dc3Id: string;
let inst1Id: string;
let inst2Id: string;
let mb1Id: string;
let mb2Id: string;
let mb3Id: string;
let mb4Id: string;
// Work 2 running state.
let dcAId: string;
let instAId: string;
let instBId: string;
let pac1Id: string;
let finalMbId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let clerk: CookieJar;
let site: CookieJar;
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

async function seedWork(input: {
  code: string;
  items: {
    id: string;
    itemNumber: string;
    description: string;
    unit: string;
    quantity: string;
    rate: string;
    paymentCategory: string | null;
  }[];
}): Promise<string> {
  const workId = randomUUID();
  const scheduleId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, ${input.code}, ${`L-${input.code}`},
      '2025-06-01', ${`MB lifecycle work ${input.code}`}, '100000.00',
      '90000.00', 'per_schedule', ${ownerUserId}
    )
  `;
  await admin`
    insert into work_schedules (id, organisation_id, work_id, schedule_code, title, position)
    values (${scheduleId}, ${organisationId}, ${workId}, 'A', 'Schedule A', 1)
  `;
  for (const item of input.items) {
    await admin`
      insert into work_items (
        id, organisation_id, work_id, schedule_id, item_number, description,
        unit_code, awarded_quantity, effective_rate, payment_category
      )
      values (
        ${item.id}, ${organisationId}, ${workId}, ${scheduleId},
        ${item.itemNumber}, ${item.description}, ${item.unit},
        ${item.quantity}, ${item.rate}, ${item.paymentCategory}
      )
    `;
  }
  return workId;
}

async function insertMatrixRow(
  workId: string,
  category: string,
  pct: [string, string, string, string],
): Promise<void> {
  await admin`
    insert into payment_matrices (
      organisation_id, work_id, category, pct_supply, pct_installation,
      pct_pac, pct_final_bill, created_by_user_id
    )
    values (${organisationId}, ${workId}, ${category}, ${pct[0]}, ${pct[1]},
            ${pct[2]}, ${pct[3]}, ${ownerUserId})
  `;
}

async function issueChallan(
  workId: string,
  prefix: string,
  items: { workItemId: string; quantity: string }[],
): Promise<string> {
  const draft = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/challans`,
    organisationId,
    payload: {
      challanDate: '2026-07-01',
      prefix,
      consignee: { name: 'Sr. DEE (G) NR', address: 'Delhi Division' },
      items,
    },
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const challanId = draft.json<ChallanDetailResponse>().challan.id;
  const issued = await authed(owner, {
    method: 'POST',
    url: `/api/challans/${challanId}/issue`,
    organisationId,
  });
  expect(issued.statusCode, issued.body).toBe(201);
  return challanId;
}

async function recordInstallation(
  workId: string,
  workItemId: string,
  quantity: string,
): Promise<string> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/installations`,
    organisationId,
    payload: {
      workItemId,
      quantity,
      installedOn: '2026-07-15',
      newLocation: { name: `Station MB ${randomUUID().slice(0, 8)}`, kind: 'station' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function recordPac(
  workId: string,
  reference: string,
  items: { workItemId: string; certifiedQuantity: string }[],
): Promise<string> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/pac-certificates`,
    organisationId,
    payload: {
      reference,
      issueDate: '2026-08-01',
      consigneeMasterId,
      items,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function createDraft(
  workId: string,
  body: {
    mbDate: string;
    isFinal?: boolean;
    kind?: 'record' | 'on_account' | 'final';
    consigneeContactId?: string;
  },
): Promise<MeasurementBookDetailResponse> {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/works/${workId}/measurement-books`,
    organisationId,
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<MeasurementBookDetailResponse>();
}

async function setSources(
  mbId: string,
  sources: { sourceType: string; sourceId: string }[],
) {
  return authed(owner, {
    method: 'PUT',
    url: `/api/measurement-books/${mbId}/sources`,
    organisationId,
    payload: { sources },
  });
}

async function finalize(mbId: string, jar: CookieJar = owner) {
  return authed(jar, {
    method: 'POST',
    url: `/api/measurement-books/${mbId}/finalize`,
    organisationId,
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-mb-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the measurement book integration ' +
        `tests. Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
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

  appPool = createDatabasePool({
    url: appUrl,
    max: 4,
    applicationName: 'auto-mb-mb-app-pool',
  });

  // A stub PDF service (the challan integration pattern): the render and
  // preview endpoints run their full HTTP path against it, and request
  // bodies are retained so tests can assert on the exact HTML sent.
  fakeGotenberg = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      gotenbergBodies.push(Buffer.concat(chunks).toString('utf8'));
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-mb-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
    gotenbergUrl: `http://127.0.0.1:${String(gotenbergAddress.port)}`,
  });

  owner = await signUp(ownerEmail, 'MB Owner');
  clerk = await signUp(clerkEmail, 'MB Clerk');
  site = await signUp(siteEmail, 'MB Site');
  outsider = await signUp(outsiderEmail, 'MB Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'MB Constructions', slug: `mb-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const outsiderOrg = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'MB Outsiders', slug: `mb-out-${runId}` },
  });
  expect(outsiderOrg.statusCode, outsiderOrg.body).toBe(201);
  outsiderOrganisationId = outsiderOrg.json<{ id: string }>().id;

  for (const [email, role] of [
    [clerkEmail, 'office'],
    [siteEmail, 'site'],
  ] as const) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role },
    });
    expect(added.statusCode, added.body).toBe(201);
  }

  const users = await admin<{ id: string; email: string }[]>`
    select "id", "email" from auth_users
    where "email" like ${`%-${runId}@integration.test`}
  `;
  const byEmail = new Map(users.map((row) => [row.email, row.id]));
  ownerUserId = byEmail.get(ownerEmail) ?? '';
  const siteUserId = byEmail.get(siteEmail) ?? '';
  expect(ownerUserId && siteUserId).toBeTruthy();
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
  // The site member sees only assigned Works â€” and holds no assignment.
  await admin`
    update organisation_memberships set work_scope = 'assigned'
    where organisation_id = ${organisationId} and user_id = ${siteUserId}
  `;

  cableItemId = randomUUID();
  work1Id = await seedWork({
    code: work1Code,
    items: [
      {
        id: cableItemId,
        itemNumber: '1',
        description: 'Power cable',
        unit: 'mtr',
        quantity: '10000.000',
        rate: '1.00',
        paymentCategory: null,
      },
    ],
  });
  await insertMatrixRow(work1Id, 'UNCATEGORISED', ['80.00', '10.00', '0.00', '10.00']);

  supplyItemId = randomUUID();
  installItemId = randomUUID();
  work2Id = await seedWork({
    code: work2Code,
    items: [
      {
        id: supplyItemId,
        itemNumber: 'S/1',
        description: 'Point machine supply',
        unit: 'Nos',
        quantity: '100.000',
        rate: '10.00',
        paymentCategory: 'SUPPLY',
      },
      {
        id: installItemId,
        itemNumber: 'S/2',
        description: 'Signal gear erection works',
        unit: 'Nos',
        quantity: '100.000',
        rate: '20.00',
        paymentCategory: 'PURE_INSTALLATION',
      },
    ],
  });

  w3ItemId = randomUUID();
  work3Id = await seedWork({
    code: work3Code,
    items: [
      {
        id: w3ItemId,
        itemNumber: 'C/1',
        description: 'Cable trench',
        unit: 'RMT',
        quantity: '1000.000',
        rate: '5.00',
        paymentCategory: null,
      },
    ],
  });
  await insertMatrixRow(work3Id, 'UNCATEGORISED', ['70.00', '20.00', '0.00', '10.00']);

  consigneeMasterId = randomUUID();
  await admin`
    insert into consignee_masters (
      id, organisation_id, designation, address, created_by_user_id
    )
    values (${consigneeMasterId}, ${organisationId}, 'Sr. DEE (G) NR',
            'Delhi Division office', ${ownerUserId})
  `;
}, 90_000);

afterAll(async () => {
  if (adminÛ¾øæÚ$z{-®éÜj×†FWF–Âæ&öö²æ¶–æB’çFô&R‚vöåö66÷VçBr“°¢W‡V7B†FWF–Âæ&öö²ç7FGW2’çFô&R‚vG&gBr“°¢W‡V7B†FWF–Âæ&öö²æ—4f–æÂ’çFô&R†fÇ6R“°¢òòF†RVæ–öâöbF†R&V6÷&G2r6÷W&6W2Â6Æ–ÖVBÆ—fRöâF†RF&vWBà¢W‡V7B†FWF–Âç6÷W&6W2’çFô†fTÆVæwF‚ƒ2“°¢W‡V7B†FWF–Âç6÷W&6W2æWfW'’‚‡6÷W&6R’Óâ6÷W&6Rç&VÆV6VDBÓÓÒçVÆÂ’’çFô&R‡G'VR“°¢6öç7B¶W—2ÒFWF–Âç6÷W&6W2æÖ‚‡2’ÓâG·2ç6÷W&6UG—WÓ¢G·2ç6÷W&6T–GÖ’ç6÷'B‚“°¢W‡V7B†¶W—2’çFôWVÂ€¢°¢FVÆ—fW'•ö6†ÆÆã¢G¶F4³–GÖÀ¢FVÆ—fW'•ö6†ÆÆã¢G¶F4³$–GÖÀ¢–ç7FÆÆF–öã¢G¶–ç7D³–GÖÀ¢Òç6÷'B‚’À¢“°¢òòF†R6ö×WFVB&Wf–Wr6÷fW'2&÷F‚&V6÷&G2rÖV7W&VÖVçG3 ¢òòS‚"ã‚ƒR²3‚"ã‚RÒ#C²bà¢W‡V7B†FWF–Âç&Wf–WuF÷FÂ’çFô&R‚s#Cbãr“° ¢òòV6‚&V6÷&B—2ÖW&vVBÂö–çG2BF†R'6÷&&W"ÂæB†öÆG2æò6Æ–×2à¢f÷"†6öç7B&V6÷&D–Böb·#–BÂ#$–EÒ’°¢6öç7B&V6÷&BÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢ttUBrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·&V6÷&D–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡&V6÷&Bç7FGW46öFRÂ&V6÷&Bæ&öG’’çFô&Rƒ#“°¢6öç7B&V6÷&DFWF–ÂÒ&V6÷&Bæ§6öãÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ‚“°¢W‡V7B‡&V6÷&DFWF–Âæ&öö²ç7FGW2’çFô&R‚vÖW&vVBr“°¢W‡V7B‡&V6÷&DFWF–Âæ&öö²æÖW&vVD–çFô–B’çFô&R‡F&vWD–B“°¢W‡V7B‡&V6÷&DFWF–Âæ&öö²æÖ$çVÖ&W"’çFô&TçVÆÂ‚“°¢W‡V7B‡&V6÷&DFWF–Âç6÷W&6W2’çFôWVÂ…µÒ“°¢W‡V7B‡&V6÷&DFWF–ÂæÆ–æW2’çFôWVÂ…µÒ“°¢Ğ¢òòW†7FÇ’öæRÆ—fR6Æ–ÒW"6÷W&6RÂÆÂöâF†RF&vWBà¢6öç7B¶6Æ–×5ÒÒv—BFÖ–ãÇ²6÷VçC¢7G&–ærÕµÓæ ¢6VÆV7B6÷VçB‚¢“£§FW‡B26÷VçBg&öÒÖ%÷6÷W&6W0¢v†W&RÖV7W&VÖVçEö&ööµö–BÒG·F&vWD–GÒæB&VÆV6VEöB—2çVÆÀ¢°¢W‡V7B†6Æ–×3òæ6÷VçB’çFô&R‚s2r“°¢6öç7B·&V6÷&D6Æ–×5ÒÒv—BFÖ–ãÇ²6÷VçC¢7G&–ærÕµÓæ ¢6VÆV7B6÷VçB‚¢“£§FW‡B26÷VçBg&öÒÖ%÷6÷W&6W0¢v†W&RÖV7W&VÖVçEö&ööµö–B–â‚G·#–GÒÂG·#$–GÒ¢°¢W‡V7B‡&V6÷&D6Æ–×3òæ6÷VçB’çFô&R‚sr“°¢òòF†RÖW&vR—2VF—FVBöâF†RF&vWBv—F‚—G2&÷fVææ6R–ÆöBà¢6öç7B¶VF—E&÷uÒÒv—BFÖ–ãÇ²FWF–Ç3¢Væ¶æ÷vâÕµÓæ ¢6VÆV7BFWF–Ç2g&öÒVF—EöWfVçG0¢v†W&R÷&væ—6F–öåö–BÒG¶÷&væ—6F–öä–GĞ¢æB7F–öâÒvÖV7W&VÖVçEö&öö²æÖW&vVBræBVçF—G•ö–BÒG·F&vWD–GĞ¢°¢W‡V7B†VF—E&÷r’çFô&TFVf–æVB‚“°¢Ò“° ¢—B‚vÖW&vVB&V6÷&BÔ"—2–Ö×WF&ÆRBF†R’æBF†RFF&6RrÂ7–æ2‚’Óâ°¢òòæò6÷W&6RVF—G2à¢6öç7B6÷W&6TVF—BÒv—B6WE6÷W&6W2‡#–BÂµÒ“°¢W‡V7B‡6÷W&6TVF—Bç7FGW46öFR’çFô&RƒC’“°¢W‡V7B‡6÷W&6TVF—Bæ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢tÔ%õ5DEU5ô4ôädÄ”5BrÒ“°¢òòæWfW"f–æÆ—¦VB†ÖW&vVB÷"æ÷B’à¢6öç7Bf–æÆ—¦U&VgW6VBÒv—Bf–æÆ—¦R‡#–B“°¢W‡V7B†f–æÆ—¦U&VgW6VBç7FGW46öFR’çFô&RƒC’“°¢W‡V7B†f–æÆ—¦U&VgW6VBæ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢tÔ%õ$T4õ$EôäõEô$”ÄÄ$ÄRrÒ“°¢òòæ÷B6æ6VÆÆVBæBæ÷BFVÆWFVB(	BVâÖÖW&vR—2F†RöæÇ’v’&6²à¢6öç7B6æ6VÅ&VgW6VBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·#–GÒö6æ6VÆÀ¢÷&væ—6F–öä–BÀ¢–ÆöC¢²æ÷FS¢tÖW&vVB&V6÷&G2×W7B&VgW6R6æ6VÆÆF–öâârÒÀ¢Ò“°¢W‡V7B†6æ6VÅ&VgW6VBç7FGW46öFR’çFô&RƒC’“°¢W‡V7B†6æ6VÅ&VgW6VBæ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢tÔ%õ5DEU5ô4ôädÄ”5BrÒ“°¢6öç7BFVÆWFU&VgW6VBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢tDTÄUDRrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·#–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B†FVÆWFU&VgW6VBç7FGW46öFR’çFô&RƒC’“°¢W‡V7B†FVÆWFU&VgW6VBæ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢tÔ%õ5DEU5ô4ôädÄ”5BrÒ“°¢òòæ÷B&RÖÖW&vVBV—F†W#¢v†–ÆRF†R'6÷&&–ærG&gB—2÷VâÂF†P¢òòöæRÖ&–ÆÆ–ærÖG&gB'VÆRç7vW'2f—'7BÂæÖ–ær—Bà¢6öç7B&VÖW&vRÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷v÷&·2òG·v÷&´´–GÒöÖV7W&VÖVçBÖ&öö·2öÖW&vVÀ¢÷&væ—6F–öä–BÀ¢–ÆöC¢²&V6÷&DÖ$–G3¢·#–EÒÂÖ$FFS¢s##bÓ‚ÓRrÒÀ¢Ò“°¢W‡V7B‡&VÖW&vRç7FGW46öFR’çFô&RƒC’“°¢W‡V7B‡&VÖW&vRæ§6öâ‚’’çFôÖF6„ö&¦V7B‡°¢6öFS¢tÔ%ôE$eEôU„•5E2rÀ¢FWF–Ç3¢²W†—7F–æu&V6÷&D–C¢F&vWD–BÒÀ¢Ò“°¢òòF†RFF&6R&VgW6W26Æ–×2öçFòÖW&vVBÔ.(
`¢v—BW‡V7B€¢v—F…FVæçB†ööÂÂ²÷&væ—6F–öä–BÂW6W$–C¢÷væW%W6W$–BÒÂ7–æ2‡G‚’Óâ°¢v—BG† ¢–ç6W'B–çFòÖ%÷6÷W&6W2€¢÷&væ—6F–öåö–BÂÖV7W&VÖVçEö&ööµö–BÂv÷&µö–BÂ6÷W&6U÷G—RÂ6÷W&6Uö–@¢¢fÇVW2‚G¶÷&væ—6F–öä–GÒÂG·#–GÒÂG·v÷&´´–GÒÂvFVÆ—fW'•ö6†ÆÆârÀ¢G¶F4³–GÒ¢°¢Ò’À¢’ç&V¦V7G2çFõF‡&÷tW'&÷"‚öG&gBò“°¢òò(
fæBç’7FGW2W66R‡&V6÷&B²f–æÆ—¦VBf–öÆFW23B6ö†W&Væ6R’à¢v—BW‡V7B€¢v—F…FVæçB†ööÂÂ²÷&væ—6F–öä–BÂW6W$–C¢÷væW%W6W$–BÒÂ7–æ2‡G‚’Óâ°¢v—BG† ¢WFFRÖV7W&VÖVçEö&öö·26WB7FGW2Òvf–æÆ—¦VBp¢v†W&R–BÒG·#–GĞ¢°¢Ò’À¢’ç&V¦V7G2çFõF‡&÷tW'&÷"‚ö6†V6·Æ6öç7G&–çBö’“°¢Ò“° ¢—B‚vFVÆWF–ærF†R'6÷&&–ærG&gB—2&VgW6VBv†–ÆR—B†öÆG2ÖW&vVB&V6÷&G2rÂ7–æ2‚’Óâ°¢6öç7B&VgW6VBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢tDTÄUDRrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·F&vWD–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡&VgW6VBç7FGW46öFR’çFô&RƒC’“°¢6öç7B&öG’Ò&VgW6VBæ§6öãÇ²6öFS¢7G&–æs²FWF–Ç3¢²&V6÷&DÖ$–G3¢7G&–æuµÒÒÓâ‚“°¢W‡V7B†&öG’æ6öFR’çFô&R‚tÔ%ô„5ôÔU$tTEõ$T4õ$E2r“°¢W‡V7B…²ââæ&öG’æFWF–Ç2ç&V6÷&DÖ$–G5Òç6÷'B‚’’çFôWVÂ…·#–BÂ#$–EÒç6÷'B‚’“°¢Ò“° ¢—B‚wVâÖÖW&vR&W7F÷&W2F†R&V6÷&G2æBF†V—"W†7B6Æ–×2ÂF†VâFVÆWFW2F†RG&gBrÂ7–æ2‚’Óâ°¢òòVâÖÖW&vR—2f÷"'6÷&&–ærG&gG2öæÇ’à¢6öç7BÆ–âÒv—B7&VFTG&gB‡v÷&³4–BÂ²Ö$FFS¢s##bÓ‚ÓbrÒ“°¢6öç7Bæ÷DÖW&vVBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·Æ–âæ&öö²æ–GÒ÷VæÖW&vVÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B†æ÷DÖW&vVBç7FGW46öFR’çFô&RƒC’“°¢W‡V7B†æ÷DÖW&vVBæ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢tÔ%ôäõôÔU$tTEõ$T4õ$E2rÒ“°¢6öç7BÆ–ävöæRÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢tDTÄUDRrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·Æ–âæ&öö²æ–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡Æ–ävöæRç7FGW46öFR’çFô&Rƒ#B“° ¢òòF†R'6÷&&–ærG&gB7F—2âVF—F&ÆRG&gC¢6Æ–ÒöæRÔõ$R6÷W&6P¢òògFW"F†RÖW&vR(	BVâÖÖW&vR×W7B&VÆV6R—Bv—F‚F†RFVÆWFVBG&gBÀ¢òòæ÷BW6‚—BöçFòç’&V6÷&Bà¢F4³4–BÒv—B—77VT6†ÆÆâ‡v÷&´´–BÂG·v÷&´´6öFWÔD6Â°¢²v÷&´—FVÔ–C¢´—FVÔ–BÂVçF—G“¢s#rÒÀ¢Ò“°¢6öç7Bv–FVæVBÒv—B6WE6÷W&6W2‡F&vWD–BÂ°¢²6÷W&6UG—S¢vFVÆ—fW'•ö6†ÆÆârÂ6÷W&6T–C¢F4³–BÒÀ¢²6÷W&6UG—S¢vFVÆ—fW'•ö6†ÆÆârÂ6÷W&6T–C¢F4³$–BÒÀ¢²6÷W&6UG—S¢v–ç7FÆÆF–öârÂ6÷W&6T–C¢–ç7D³–BÒÀ¢²6÷W&6UG—S¢vFVÆ—fW'•ö6†ÆÆârÂ6÷W&6T–C¢F4³4–BÒÀ¢Ò“°¢W‡V7B‡v–FVæVBç7FGW46öFRÂv–FVæVBæ&öG’’çFô&Rƒ#“° ¢6öç7BVæÖW&vVBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·F&vWD–GÒ÷VæÖW&vVÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡VæÖW&vVBç7FGW46öFRÂVæÖW&vVBæ&öG’’çFô&Rƒ#B“° ¢òòF†R'6÷&&–ærG&gB—2vöæRà¢6öç7BvöæRÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢ttUBrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·F&vWD–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B†vöæRç7FGW46öFR’çFô&RƒCB“° ¢òòV6‚&V6÷&B—2G&gBv–â†öÆF–ærU„5DÅ’v†B—B6öçG&–'WFVBà¢6öç7B&W7F÷&VCÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢ttUBrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·#–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢6öç7BFWF–ÃÒ&W7F÷&VCæ§6öãÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ‚“°¢W‡V7B†FWF–Ãæ&öö²ç7FGW2’çFô&R‚vG&gBr“°¢W‡V7B†FWF–Ãæ&öö²æÖW&vVD–çFô–B’çFô&TçVÆÂ‚“°¢W‡V7B†FWF–Ãæ&öö²æ6öç6–væVT6öçF7D–B’çFô&R†6öç6–væVS–B“°¢W‡V7B†FWF–Ãç6÷W&6W2æÖ‚‡2’ÓâG·2ç6÷W&6UG—WÓ¢G·2ç6÷W&6T–GÖ’’çFôWVÂ…°¢FVÆ—fW'•ö6†ÆÆã¢G¶F4³–GÖÀ¢Ò“° ¢6öç7B&W7F÷&VC"Òv—BWF†VB†÷væW"Â°¢ÖWF†öC¢ttUBrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·#$–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢6öç7BFWF–Ã"Ò&W7F÷&VC"æ§6öãÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ‚“°¢W‡V7B†FWF–Ã"æ&öö²ç7FGW2’çFô&R‚vG&gBr“°¢W‡V7B†FWF–Ã"æ&öö²æÖW&vVD–çFô–B’çFô&TçVÆÂ‚“°¢W‡V7B†FWF–Ã"ç6÷W&6W2æÖ‚‡2’ÓâG·2ç6÷W&6UG—WÓ¢G·2ç6÷W&6T–GÖ’ç6÷'B‚’’çFôWVÂ€¢¶FVÆ—fW'•ö6†ÆÆã¢G¶F4³$–GÖÂ–ç7FÆÆF–öã¢G¶–ç7D³–GÖÒç6÷'B‚’À¢“° ¢òòF†R÷7BÖÖW&vRW‡G&6Æ–Òv2&VÆV6VBv—F‚F†RG&gBÂæBWfW'¢òò&W7F÷&VB6÷W&6R†2W†7FÇ’öæRÆ—fR6Æ–Òà¢6öç7B¶³46Æ–×5ÒÒv—BFÖ–ãÇ²6÷VçC¢7G&–ærÕµÓæ ¢6VÆV7B6÷VçB‚¢“£§FW‡B26÷VçBg&öÒÖ%÷6÷W&6W0¢v†W&R6÷W&6U÷G—RÒvFVÆ—fW'•ö6†ÆÆâræB6÷W&6Uö–BÒG¶F4³4–GĞ¢æB&VÆV6VEöB—2çVÆÀ¢°¢W‡V7B†³46Æ–×3òæ6÷VçB’çFô&R‚sr“°¢6öç7B¶Æ—fT6Æ–×5ÒÒv—BFÖ–ãÇ²6÷VçC¢7G&–ærÕµÓæ ¢6VÆV7B6÷VçB‚¢“£§FW‡B26÷VçBg&öÒÖ%÷6÷W&6W0¢v†W&RÖV7W&VÖVçEö&ööµö–B–â‚G·#–GÒÂG·#$–GÒ’æB&VÆV6VEöB—2çVÆÀ¢°¢W‡V7B†Æ—fT6Æ–×3òæ6÷VçB’çFô&R‚s2r“° ¢6öç7B¶VF—E&÷uÒÒv—BFÖ–ãÇ²6÷VçC¢7G&–ærÕµÓæ ¢6VÆV7B6÷VçB‚¢“£§FW‡B26÷VçBg&öÒVF—EöWfVçG0¢v†W&R÷&væ—6F–öåö–BÒG¶÷&væ—6F–öä–GĞ¢æB7F–öâÒvÖV7W&VÖVçEö&öö²çVæÖW&vVBræBVçF—G•ö–BÒG·F&vWD–GĞ¢°¢W‡V7B†VF—E&÷sòæ6÷VçB’çFô&R‚sr“°¢Ò“° ¢—B‚v6öæ7W'&VçBÖW&vW3¢W†7FÇ’öæRöâÖ66÷VçBG&gB'6÷&'2F†R&V6÷&G2rÂ7–æ2‚’Óâ°¢6öç7BÖW&vRÒ‚’Óà¢WF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷v÷&·2òG·v÷&´´–GÒöÖV7W&VÖVçBÖ&öö·2öÖW&vVÀ¢÷&væ—6F–öä–BÀ¢–ÆöC¢²&V6÷&DÖ$–G3¢·#–BÂ#$–EÒÂÖ$FFS¢s##bÓ‚ÓRrÒÀ¢Ò“°¢6öç7B¶f—'7BÂ6V6öæEÒÒv—B&öÖ—6RæÆÂ…¶ÖW&vR‚’ÂÖW&vR‚•Ò“°¢6öç7B7FGW6W2Ò¶f—'7Bç7FGW46öFRÂ6V6öæBç7FGW46öFUÒç6÷'B‚“°¢W‡V7B‡7FGW6W2ÂG¶f—'7Bæ&öG—ÒÂG·6V6öæBæ&öG—Ö’çFôWVÂ…³#ÂC•Ò“°¢6öç7Bv–ææW"Òf—'7Bç7FGW46öFRÓÓÒ#òf—'7B¢6V6öæC°¢6öç7BÆ÷6W"Òf—'7Bç7FGW46öFRÓÓÒ#ò6V6öæB¢f—'7C°¢W‡V7B…²tÔ%ôE$eEôU„•5E2rÂtÔ%ôÔU$tUôäõEõ$T4õ$EôE$eBuÒ’çFô6öçF–â€¢Æ÷6W"æ§6öãÇ²6öFS¢7G&–ærÓâ‚’æ6öFRÀ¢“°¢F&vWC$–BÒv–ææW"æ§6öãÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ‚’æ&öö²æ–C°¢òòöæRF&vWBÂF‡&VR6Æ–×2Â&÷F‚&V6÷&G2ÖW&vVB–çFò—Bà¢6öç7B·7FFUÒÒv—BFÖ–ãÇ²6Æ–×3¢7G&–æs²ÖW&vVC¢7G&–ærÕµÓæ ¢6VÆV7@¢‡6VÆV7B6÷VçB‚¢’g&öÒÖ%÷6÷W&6W0¢v†W&RÖV7W&VÖVçEö&ööµö–BÒG·F&vWC$–GĞ¢æB&VÆV6VEöB—2çVÆÂ“£§FW‡B26Æ–×2À¢‡6VÆV7B6÷VçB‚¢’g&öÒÖV7W&VÖVçEö&öö·0¢v†W&RÖW&vVEö–çFõö–BÒG·F&vWC$–GĞ¢æB7FGW2ÒvÖW&vVBr“£§FW‡B2ÖW&vV@¢°¢W‡V7B‡7FFR’çFôÖF6„ö&¦V7B‡²6Æ–×3¢s2rÂÖW&vVC¢s"rÒ“°¢Ò“° ¢—B‚'F†RÖW&vVBöâÖ66÷VçBÔ"f–æÆ—¦W2æB&–ÆÇ2F†R&V6÷&G2rÖV7W&VÖVçG2öæ6R"Â7–æ2‚’Óâ°¢6öç7Bf–æÆ—¦VBÒv—Bf–æÆ—¦R‡F&vWC$–B“°¢W‡V7B†f–æÆ—¦VBç7FGW46öFRÂf–æÆ—¦VBæ&öG’’çFô&Rƒ#“°¢6öç7BFWF–ÂÒf–æÆ—¦VBæ§6öãÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ‚“°¢W‡V7B†FWF–Âæ&öö²æ¶–æB’çFô&R‚vöåö66÷VçBr“°¢W‡V7B†FWF–Âæ&öö²æÖ$çVÖ&W"’çFô&R†G·v÷&´´6öFWÒÔÔ"Ó“°¢W‡V7B†FWF–Âæ&öö²çF÷FÄÖ÷VçB’çFô&R‚s#Cbãr“° ¢òòöæ6Rf–æÆ—¦VBÂF†RÖW&vR—2&–ÆÆVBf÷"vööC¢æòVâÖÖW&vRà¢6öç7BVæÖW&vU&VgW6VBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·F&vWC$–GÒ÷VæÖW&vVÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡VæÖW&vU&VgW6VBç7FGW46öFR’çFô&RƒC’“°¢W‡V7B‡VæÖW&vU&VgW6VBæ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢tÔ%õ5DEU5ô4ôädÄ”5BrÒ“° ¢òòv—F‚æò&–ÆÆ–ærG&gB÷VâÂÖW&v–ærÔU$tTB&V6÷&B—2&VgW6VBöà¢òò—G2÷vâ7FFRà¢6öç7B&VÖW&vRÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷v÷&·2òG·v÷&´´–GÒöÖV7W&VÖVçBÖ&öö·2öÖW&vVÀ¢÷&væ—6F–öä–BÀ¢–ÆöC¢²&V6÷&DÖ$–G3¢·#–EÒÂÖ$FFS¢s##bÓ‚ÓRrÒÀ¢Ò“°¢W‡V7B‡&VÖW&vRç7FGW46öFR’çFô&RƒC’“°¢W‡V7B‡&VÖW&vRæ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢tÔ%ôÔU$tUôäõEõ$T4õ$EôE$eBrÒ“° ¢òòF†R&V6÷&G27F’ÖW&vVBf÷&WfW"ÂçVÖ&W&ÆW72à¢6öç7B&V6÷&BÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢ttUBrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·#–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢6öç7B&V6÷&DFWF–ÂÒ&V6÷&Bæ§6öãÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ‚“°¢W‡V7B‡&V6÷&DFWF–Âæ&öö²ç7FGW2’çFô&R‚vÖW&vVBr“°¢W‡V7B‡&V6÷&DFWF–Âæ&öö²æÖW&vVD–çFô–B’çFô&R‡F&vWC$–B“°¢W‡V7B‡&V6÷&DFWF–Âæ&öö²æÖ$çVÖ&W"’çFô&TçVÆÂ‚“°¢Ò“° ¢—B‚w&V6÷&B6†VWG2&RW†V×Bg&öÒF†R&Vv—7FW"ÖFFR'VÆS²&–ÆÆ–ærG&gG2&Ræ÷BrÂ7–æ2‚’Óâ°¢òòF†Rf–æÆ—¦VBÔ"Ó—2FFVB##bÓ‚ÓRâ&V6÷&B6†VWBÖ’&P¢òòFFVBV&Æ–W"(	B—BæWfW"F¶W2çVÖ&W"æBæWfW"æ'&FW2F†P¢òò&–÷"7V×VÆF—f^(
`¢6öç7B&V6÷&BÒv—B7&VFTG&gB‡v÷&´´–BÂ°¢Ö$FFS¢s##bÓ‚ÓrÀ¢¶–æC¢w&V6÷&BrÀ¢6öç6–væVT6öçF7D–C¢6öç6–væVS–BÀ¢Ò“°¢6öç7B&VÖ÷fVBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢tDTÄUDRrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·&V6÷&Bæ&öö²æ–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B‡&VÖ÷fVBç7FGW46öFR’çFô&Rƒ#B“°¢òò(
gv†–ÆRF†R&–ÆÆ–ær&Vv—7FW"×W7Bæ÷B'Vâ&6·v&G2à¢6öç7B&–ÆÆ–ærÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷v÷&·2òG·v÷&´´–GÒöÖV7W&VÖVçBÖ&öö·6À¢÷&væ—6F–öä–BÀ¢–ÆöC¢²Ö$FFS¢s##bÓ‚ÓrÒÀ¢Ò“°¢W‡V7B†&–ÆÆ–ærç7FGW46öFR’çFô&RƒC“°¢W‡V7B†&–ÆÆ–æræ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢tÔ%ôDDUô$Tdõ$Uõ$Ud”õU2rÒ“°¢Ò“° ¢—B‚wF†Rf–æÂ¶–æB†¶–æBæB—4f–æÂw&VR’6Æ÷6W2F†Rv÷&²f÷"&V6÷&B6†VWG2FöòrÂ7–æ2‚’Óâ°¢òòF†R&RÓ3BÆ–27F–ÆÂ7&VFW2F†Rf–æÂÔ.(
`¢6öç7Bf–Æ–2Òv—B7&VFTG&gB‡v÷&´´–BÂ°¢Ö$FFS¢s##bÓ‚ÓbrÀ¢—4f–æÃ¢G'VRÀ¢Ò“°¢W‡V7B‡f–Æ–2æ&öö²æ¶–æB’çFô&R‚vf–æÂr“°¢W‡V7B‡f–Æ–2æ&öö²æ—4f–æÂ’çFô&R‡G'VR“°¢6öç7BÆ–4vöæRÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢tDTÄUDRrÀ¢W&Ã¢ö’öÖV7W&VÖVçBÖ&öö·2òG·f–Æ–2æ&öö²æ–GÖÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢W‡V7B†Æ–4vöæRç7FGW46öFR’çFô&Rƒ#B“°¢òò(
fæBF†R¶–æBf–VÆB—2F†R&WVW7BG'WF‚vö–ærf÷'v&Bà¢6öç7Bf–æÄG&gBÒv—B7&VFTG&gB‡v÷&´´–BÂ°¢Ö$FFS¢s##bÓ‚ÓbrÀ¢¶–æC¢vf–æÂrÀ¢Ò“°¢W‡V7B†f–æÄG&gBæ&öö²æ¶–æB’çFô&R‚vf–æÂr“°¢W‡V7B†f–æÄG&gBæ&öö²æ—4f–æÂ’çFô&R‡G'VR“°¢òòF†R7vVW6VW2öæÇ’õTâ6÷W&6W3¢F†RÖW&vVB&V6÷&G2r6÷W&6W2&P¢òò6Æ–ÖVB'’f–æÆ—¦VBÔ"ÓÂ6òöæÇ’F†RVâÖÖW&vVB³2&VÖ–ç2à¢6öç7B7vWBÒv—B6WE6÷W&6W2†f–æÄG&gBæ&öö²æ–BÂ°¢²6÷W&6UG—S¢vFVÆ—fW'•ö6†ÆÆârÂ6÷W&6T–C¢F4³4–BÒÀ¢Ò“°¢W‡V7B‡7vWBç7FGW46öFRÂ7vWBæ&öG’’çFô&Rƒ#“°¢6öç7Bf–æÆ—¦VBÒv—Bf–æÆ—¦R†f–æÄG&gBæ&öö²æ–B“°¢W‡V7B†f–æÆ—¦VBç7FGW46öFRÂf–æÆ—¦VBæ&öG’’çFô&Rƒ#“°¢6öç7BFWF–ÂÒf–æÆ—¦VBæ§6öãÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ‚“°¢W‡V7B†FWF–Âæ&öö²æ¶–æB’çFô&R‚vf–æÂr“°¢W‡V7B†FWF–Âæ&öö²æ—4f–æÂ’çFô&R‡G'VR“°¢W‡V7B†FWF–Âæ&öö²æÖ$çVÖ&W"’çFô&R†G·v÷&´´6öFWÒÔÔ"Ó&“° ¢òòæògW'F†W"Ô"öbå’¶–æB(	B&V6÷&B6†VWG2–æ6ÇVFVBà¢6öç7B&V6÷&E&VgW6VBÒv—BWF†VB†÷væW"Â°¢ÖWF†öC¢uõ5BrÀ¢W&Ã¢ö’÷v÷&·2òG·v÷&´´–GÒöÖV7W&VÖVçBÖ&öö·6À¢÷&væ—6F–öä–BÀ¢–ÆöC¢°¢Ö$FFS¢s##bÓ‚ÓbrÀ¢¶–æC¢w&V6÷&BrÀ¢6öç6–væVT6öçF7D–C¢6öç6–væVS–BÀ¢ÒÀ¢Ò“°¢W‡V7B‡&V6÷&E&VgW6VBç7FGW46öFR’çFô&RƒC’“°¢W‡V7B‡&V6÷&E&VgW6VBæ§6öâ‚’’çFôÖF6„ö&¦V7B‡²6öFS¢td”äÅôÔ%ôU„•5E2rÒ“°¢Ò“°§Ò“°