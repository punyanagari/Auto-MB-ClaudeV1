import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ConfirmWorkRequest,
  DashboardResponse,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import {
  loadLetter,
  resolveCanonicalUnitCode,
  reviewLoaLetter,
  type CorpusLetter,
  type LoaReviewPayload,
} from '@auto-mb/loa-parser';
import { buildApp } from '../src/app.js';

// Milestone 5 remaining slice + Milestone 6 review-row editing: the PBG
// REQUIREMENT the letter demands (works.pbg_*) as distinct from submitted
// 'pbg' instruments, and confirm-time add/remove of item rows.

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
const ownerEmail = `pbg-owner-${runId}@integration.test`;
const otherOwnerEmail = `pbg-other-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let otherOrganisationId: string;
let ownerUserId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let otherOwner: CookieJar;

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

/** Reduces a printed decimal to the contracts' DecimalString shape (same
 * helper as the corpus confirm suite). */
function normaliseDecimal(raw: string, maxDp: number): string {
  const cleaned = raw.replaceAll(',', '').trim();
  const dotParts = cleaned.split('.');
  const [intRaw, fracRaw] = dotParts;
  const digits = /^\d+$/;
  if (
    dotParts.length > 2 ||
    intRaw === undefined ||
    !digits.test(intRaw) ||
    (fracRaw !== undefined && !digits.test(fracRaw))
  ) {
    return '1';
  }
  const intPart = String(BigInt(intRaw));
  const frac = (fracRaw ?? '').slice(0, maxDp).replace(/0+$/, '');
  const value = frac.length > 0 ? `${intPart}.${frac}` : intPart;
  return value === '0' ? '1' : value;
}

/** The performance-guarantee requirement the letter demands, exactly as the
 * parser read it. The extracted-value lock refuses a confirmation that
 * drops a readable clause, so this is what a reviewer actually submits. */
function buildPbgRequirement(
  payload: LoaReviewPayload,
): ConfirmWorkRequest['pbgRequirement'] {
  const clause = payload.header.performanceGuarantee;
  if (
    clause.needsReview ||
    clause.amountFigures === null ||
    clause.submissionDays === null
  ) {
    return undefined;
  }
  return {
    requiredAmount: clause.amountFigures.toFixed(2),
    submissionDays: clause.submissionDays,
    ...(clause.extensionDays !== null ? { extensionDays: clause.extensionDays } : {}),
    ...(clause.penalInterestPercent !== null
      ? { penalInterestPercent: String(clause.penalInterestPercent) }
      : {}),
  };
}

/** The confirm request a reviewer would submit for a corpus letter, with a
 * unique work code per call so repeated confirms in this suite never
 * collide. The letter number comes from the SEEDED parse rather than the
 * work code: it is an extracted value, and the lock refuses a confirmation
 * that submits any other — `seedReviewDocument` is what makes each one
 * unique. */
function buildConfirmRequest(
  letter: CorpusLetter,
  payload: LoaReviewPayload,
  workCode: string,
): ConfirmWorkRequest {
  const manifest = letter.manifest;
  const shape = manifest.pricing_shape === 'A' ? 'letter_percentage' : 'per_schedule';

  const groups = new Map<string, LoaReviewPayload['items'][number][]>();
  for (const item of payload.items) {
    const scheduleId = item.schedule?.id ?? 'UNBOUND';
    const list = groups.get(scheduleId) ?? [];
    list.push(item);
    groups.set(scheduleId, list);
  }

  const letterDate = payload.header.letterDate.value;
  const title = payload.header.workDescription.value ?? manifest.id;
  const pbgRequirement = buildPbgRequirement(payload);
  return {
    workCode,
    letterNumber: payload.header.letterNumber.value ?? `${workCode}-${runId}`,
    letterDate:
      letterDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(letterDate)
        ? letterDate
        : '2025-01-01',
    title: title.length >= 3 ? title.slice(0, 1000) : manifest.id,
    advertisedValue: manifest.advertised_value.toFixed(2),
    contractValue: manifest.net_bid_value.toFixed(2),
    pricingShape: shape,
    ...(shape === 'letter_percentage'
      ? {
          letterPercentage: manifest.letter_percentage
            ? manifest.letter_percentage.value.toFixed(3)
            : '0',
          letterPercentageDirection: manifest.letter_percentage
            ? (manifest.letter_percentage.direction.toLowerCase() as 'below' | 'above')
            : ('at_par' as const),
        }
      : {}),
    ...(pbgRequirement !== undefined ? { pbgRequirement } : {}),
    schedules: [...groups.entries()].map(([scheduleId, items]) => ({
      scheduleCode: scheduleId,
      title: `Schedule ${scheduleId}`,
      items: items.map((item) => ({
        itemNumber: `${scheduleId}/${item.itemSno}`,
        description:
          item.description.trim().length >= 3
            ? item.description
            : `Item ${item.itemSno}`,
        unitCode: resolveCanonicalUnitCode(item.qtyUnit) ?? 'UNIT',
        awardedQuantity: normaliseDecimal(item.qty, 3),
        effectiveRate: normaliseDecimal(item.unitRate, 2),
        sourceRef: { scheduleId, itemSno: item.itemSno },
      })),
    })),
  };
}

/** Seeds one review document from a corpus letter, with a letter number
 * unique to this call written into the STORED parse.
 *
 * `works.letter_number` is unique forever, and the letter number is an
 * extracted value the confirm route now holds the payload to, so the two
 * requirements meet in one place: the seeded parse is the truth, the
 * confirmation repeats it, and every case still gets its own number. The
 * returned review is what the caller must build its request from. */
async function seedReviewDocument(
  letter: CorpusLetter,
  workCode: string,
): Promise<{ documentId: string; review: LoaReviewPayload }> {
  const parsed = reviewLoaLetter(letter.text);
  const review: LoaReviewPayload = {
    ...parsed,
    header: {
      ...parsed.header,
      letterNumber: {
        ...parsed.header.letterNumber,
        value: `${workCode}-${runId}`,
      },
    },
  };
  const payload = { sourceText: letter.text, review };
  const documentId = randomUUID();
  const sha256 = createHash('sha256')
    .update(`${letter.text}-${documentId}`)
    .digest('hex');
  await admin`
    insert into loa_documents (
      id, organisation_id, object_key, original_filename, sha256, media_type,
      size_bytes, extraction_status, extraction_payload, uploaded_by_user_id
    )
    values (
      ${documentId}, ${organisationId},
      ${`${organisationId}/loa/${documentId}.pdf`},
      ${`${letter.manifest.id}.pdf`}, ${sha256},
      'application/pdf', ${Buffer.byteLength(letter.text)}, 'review',
      ${admin.json(payload as never)}, ${ownerUserId}
    )
  `;
  return { documentId, review };
}

/** Seeds a Work carrying a PBG requirement directly (admin), with the
 * letter date expressed relative to current_date so due-window arithmetic
 * is deterministic for the dashboard assertions. */
async function seedRequirementWork(
  workCode: string,
  letterDaysAgo: number,
  submissionDays: number,
  extensionDays: number | null,
  requiredAmount: string,
): Promise<string> {
  const workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id,
      pbg_required_amount, pbg_submission_days, pbg_extension_days,
      pbg_requirement_source
    )
    values (
      ${workId}, ${organisationId}, ${workCode}, ${`L-${workCode}-${runId}`},
      current_date - ${letterDaysAgo}::int, 'PBG dashboard proof work',
      '1000000.00', '900000.00', 'per_schedule', ${ownerUserId},
      ${requiredAmount}, ${submissionDays}, ${extensionDays},
      ${admin.json({ provenance: 'corrected', raw: null, parser: null })}
    )
  `;
  return workId;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-pbg-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-pbg-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'PBG Owner');
  otherOwner = await signUp(otherOwnerEmail, 'PBG Other Owner');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'PBG Constructions', slug: `pbg-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const otherCreated = await authed(otherOwner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Other Constructions', slug: `pbg-other-${runId}` },
  });
  expect(otherCreated.statusCode, otherCreated.body).toBe(201);
  otherOrganisationId = otherCreated.json<{ id: string }>().id;

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing after sign-up');
  ownerUserId = ownerUser.id;
}, 60_000);

afterAll(async () => {
  if (admin) {
    // The catalog-driven cleanup rather than a hand list. Every list this
    // replaced went stale the moment migration 0089 seeded a new tenant
    // table at organisation creation, which is the exact failure
    // `removeOrganisationResidue` was written to end.
    await removeOrganisationResidue(admin, [organisationId, otherOrganisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
    await admin.end();
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('PBG requirement confirmation (Milestone 5)', () => {
  it('confirms the parser-proposed requirement from a real fixture with parser provenance', async () => {
    // PL273-JHS's printed clause: Rs. 152321.33 within 21 days, valid up
    // to completion plus 60 days, penal interest 12% p.a. — asserted as
    // exact values below, so a parser regression fails loudly here.
    const letter = loadLetter('PL273-JHS');
    const { documentId, review: payload } = await seedReviewDocument(
      letter,
      'PBG-PARSER-1',
    );
    const guarantee = payload.header.performanceGuarantee;
    expect(guarantee.amountFigures).toBe(152321.33);
    expect(guarantee.submissionDays).toBe(21);
    expect(guarantee.extensionDays).toBe(60);
    expect(guarantee.penalInterestPercent).toBe(12);
    expect(guarantee.needsReview).toBe(false);

    const request: ConfirmWorkRequest = {
      ...buildConfirmRequest(letter, payload, 'PBG-PARSER-1'),
      pbgRequirement: {
        requiredAmount: '152321.33',
        submissionDays: 21,
        extensionDays: 60,
        penalInterestPercent: '12',
      },
    };
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: request,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<WorkDetailResponse>();
    expect(detail.work.pbgRequiredAmount).toBe('152321.33');
    expect(detail.work.pbgSubmissionDays).toBe(21);
    expect(detail.work.pbgExtensionDays).toBe(60);
    expect(detail.work.pbgPenalInterestPercent).toBe('12.000');

    const [row] = await admin<{ source: unknown }[]>`
      select pbg_requirement_source as source from works where id = ${detail.work.id}
    `;
    const source = row?.source as {
      provenance: string;
      raw: string | null;
      parser: { amountFigures: number; submissionDays: number };
    };
    expect(source.provenance).toBe('parser');
    expect(source.raw).toContain('amounting to Rs. 152321.33');
    expect(source.parser.amountFigures).toBe(152321.33);
    expect(source.parser.submissionDays).toBe(21);

    const fetched = await authed(owner, {
      method: 'GET',
      url: `/api/works/${detail.work.id}`,
      organisationId,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<WorkDetailResponse>().work.pbgRequiredAmount).toBe('152321.33');
  }, 30_000);

  it('persists reviewer-established values with corrected provenance and the parser proposal retained', async () => {
    // PL281-BB's guarantee clause parses with `needsReview: true`, so the
    // extracted-value lock leaves the whole requirement to the reviewer —
    // this is the only shape in which a value can differ from the parser's
    // proposal at all. A clause the parser read cleanly is locked, and a
    // confirmation that changes it is refused by name
    // (loa.integration.test.ts, "the LOA extracted-value lock").
    const letter = loadLetter('PL281-BB');
    const { documentId, review: payload } = await seedReviewDocument(
      letter,
      'PBG-CORRECTED-1',
    );
    expect(payload.header.performanceGuarantee.needsReview).toBe(true);
    const request: ConfirmWorkRequest = {
      ...buildConfirmRequest(letter, payload, 'PBG-CORRECTED-1'),
      pbgRequirement: {
        requiredAmount: '210000.00',
        submissionDays: 30,
        extensionDays: 45,
        penalInterestPercent: '10.5',
      },
    };
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: request,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<WorkDetailResponse>();
    expect(detail.work.pbgRequiredAmount).toBe('210000.00');
    expect(detail.work.pbgSubmissionDays).toBe(30);
    expect(detail.work.pbgExtensionDays).toBe(45);
    expect(detail.work.pbgPenalInterestPercent).toBe('10.500');

    const [row] = await admin<{ source: unknown }[]>`
      select pbg_requirement_source as source from works where id = ${detail.work.id}
    `;
    const source = row?.source as {
      provenance: string;
      raw: string | null;
      parser: { amountFigures: number; submissionDays: number };
    };
    // Corrections never overwrite evidence: the parser's own proposal and
    // printed raw block ride along verbatim.
    expect(source.provenance).toBe('corrected');
    expect(source.raw).toContain('amounting to Rs. 7376797.39');
    expect(source.parser.amountFigures).toBe(7376797.39);
    expect(source.parser.submissionDays).toBe(21);
  }, 30_000);

  it('confirms without a PBG requirement when the parser could not read the clause', async () => {
    // Also PL281-BB's flagged clause: nothing about it is verified truth,
    // so recording no requirement at all is the reviewer's to decide. A
    // letter whose clause the parser DID read cannot be confirmed without
    // it — dropping it is a modification like any other.
    const letter = loadLetter('PL281-BB');
    const { documentId, review: payload } = await seedReviewDocument(
      letter,
      'PBG-NONE-1',
    );
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: buildConfirmRequest(letter, payload, 'PBG-NONE-1'),
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<WorkDetailResponse>();
    expect(detail.work.pbgRequiredAmount).toBeNull();
    expect(detail.work.pbgSubmissionDays).toBeNull();
    expect(detail.work.pbgExtensionDays).toBeNull();
    expect(detail.work.pbgPenalInterestPercent).toBeNull();

    const [row] = await admin<{ source: unknown }[]>`
      select pbg_requirement_source as source from works where id = ${detail.work.id}
    `;
    expect(row?.source).toBeNull();
  }, 30_000);

  it('rejects a non-positive required amount', async () => {
    const letter = loadLetter('PL273-JHS');
    const { documentId, review: payload } = await seedReviewDocument(
      letter,
      'PBG-ZERO-1',
    );
    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: {
        ...buildConfirmRequest(letter, payload, 'PBG-ZERO-1'),
        pbgRequirement: { requiredAmount: '0', submissionDays: 21 },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'PBG_AMOUNT_INVALID' });
  }, 30_000);
});

describe('review-row editing (Milestone 6)', () => {
  it('confirms a reviewer-added manual row with an explicit manual marker and zero unresolved evidence', async () => {
    const letter = loadLetter('PL276-GTL');
    const { documentId, review: payload } = await seedReviewDocument(
      letter,
      'PBG-MANUAL-1',
    );
    const request = buildConfirmRequest(letter, payload, 'PBG-MANUAL-1');
    const firstSchedule = request.schedules[0];
    if (!firstSchedule) throw new Error('fixture yielded no schedules');
    firstSchedule.items.push({
      itemNumber: `${firstSchedule.scheduleCode}/M1`,
      description: 'Reviewer-added supplementary item the parser could not read',
      unitCode: 'Nos',
      awardedQuantity: '4',
      effectiveRate: '250.00',
      manualEntry: true,
    });

    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: request,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<WorkDetailResponse>();
    const itemCount = detail.schedules.reduce(
      (total, schedule) => total + schedule.items.length,
      0,
    );
    expect(itemCount).toBe(letter.manifest.item_count + 1);

    // The manual row carries its explicit manual-entry marker…
    const [manualRow] = await admin<{ source_evidence: unknown }[]>`
      select source_evidence from work_items
      where work_id = ${detail.work.id}
        and item_number = ${`${firstSchedule.scheduleCode}/M1`}
    `;
    expect(manualRow?.source_evidence).toMatchObject({
      manualEntry: true,
      resolved: true,
    });

    // …and the confirm invariant holds Work-wide: zero unresolved links.
    const [evidence] = await admin<{ unresolved: string }[]>`
      select count(*) filter (
        where source_evidence->>'resolved' is distinct from 'true'
      )::text as unresolved
      from work_items where work_id = ${detail.work.id}
    `;
    expect(evidence?.unresolved).toBe('0');
  }, 30_000);

  it('confirms with a parsed row removed while the stored extraction payload stays intact', async () => {
    const letter = loadLetter('PL281-BB');
    const { documentId, review: payload } = await seedReviewDocument(
      letter,
      'PBG-REMOVE-1',
    );
    const request = buildConfirmRequest(letter, payload, 'PBG-REMOVE-1');
    const firstSchedule = request.schedules[0];
    if (!firstSchedule) throw new Error('fixture yielded no schedules');
    const removed = firstSchedule.items.pop();
    if (!removed) throw new Error('fixture schedule had no items');

    const response = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: request,
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = response.json<WorkDetailResponse>();
    const itemCount = detail.schedules.reduce(
      (total, schedule) => total + schedule.items.length,
      0,
    );
    expect(itemCount).toBe(letter.manifest.item_count - 1);

    // Removing a row at review time never edits the stored letter: the
    // document keeps its full extraction payload, all rows included.
    const [document] = await admin<{ extraction_payload: unknown }[]>`
      select extraction_payload from loa_documents where id = ${documentId}
    `;
    const retained = document?.extraction_payload as {
      sourceText: string;
      review: { items: unknown[] };
    };
    expect(retained.sourceText).toBe(letter.text);
    expect(retained.review.items).toHaveLength(letter.manifest.item_count);
  }, 30_000);

  it('refuses items lacking an evidence link, with a bogus sourceRef, or claiming both kinds', async () => {
    const letter = loadLetter('PL270-CRB');
    const { documentId, review: payload } = await seedReviewDocument(
      letter,
      'PBG-EVIDENCE-1',
    );

    const base = () => buildConfirmRequest(letter, payload, 'PBG-EVIDENCE-1');

    const noEvidence = base();
    const firstItem = noEvidence.schedules[0]?.items[0];
    if (!firstItem) throw new Error('fixture yielded no items');
    delete firstItem.sourceRef;
    const missing = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: noEvidence,
    });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'ITEM_EVIDENCE_REQUIRED' });

    const bogus = base();
    const bogusItem = bogus.schedules[0]?.items[0];
    if (!bogusItem) throw new Error('fixture yielded no items');
    bogusItem.sourceRef = { scheduleId: 'ZZ', itemSno: '99' };
    const unresolved = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: bogus,
    });
    expect(unresolved.statusCode, unresolved.body).toBe(400);
    expect(unresolved.json()).toMatchObject({ code: 'SOURCE_REF_UNRESOLVED' });

    const both = base();
    const bothItem = both.schedules[0]?.items[0];
    if (!bothItem) throw new Error('fixture yielded no items');
    bothItem.manualEntry = true;
    const conflicted = await authed(owner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId,
      payload: both,
    });
    expect(conflicted.statusCode, conflicted.body).toBe(400);
    expect(conflicted.json()).toMatchObject({ code: 'ITEM_EVIDENCE_CONFLICT' });

    // Every rejection rolled back whole: no Work was created.
    const [count] = await admin<{ count: string }[]>`
      select count(*)::text as count from works
      where organisation_id = ${organisationId} and work_code = 'PBG-EVIDENCE-1'
    `;
    expect(count?.count).toBe('0');
  }, 30_000);
});

describe('dashboard PBG alerts', () => {
  let missingSoonId: string;
  let overdueId: string;
  let missedId: string;
  let underId: string;
  let okId: string;

  beforeAll(async () => {
    // (a) required, nothing submitted, due in 20 days.
    missingSoonId = await seedRequirementWork('PBG-D-SOON', 1, 21, 60, '100000.00');
    // (a) required, nothing submitted, normal due passed 9 days ago but
    // the extension window still runs.
    overdueId = await seedRequirementWork('PBG-D-OVERDUE', 30, 21, 60, '100000.00');
    // (c) extended window passed 19 days ago with nothing submitted.
    missedId = await seedRequirementWork('PBG-D-MISSED', 100, 21, 60, '100000.00');
    // (b) submitted but below the required amount.
    underId = await seedRequirementWork('PBG-D-UNDER', 5, 21, null, '100000.00');
    await admin`
      insert into work_instruments (
        organisation_id, work_id, kind, reference, amount, issued_on,
        created_by_user_id
      )
      values (${organisationId}, ${underId}, 'pbg', ${`BG-UNDER-${runId}`},
              '60000.00', current_date - 2, ${ownerUserId})
    `;
    // Fully covered: no alert may fire.
    okId = await seedRequirementWork('PBG-D-OK', 5, 21, null, '100000.00');
    await admin`
      insert into work_instruments (
        organisation_id, work_id, kind, reference, amount, issued_on,
        created_by_user_id
      )
      values (${organisationId}, ${okId}, 'pbg', ${`BG-OK-${runId}`},
              '100000.00', current_date - 2, ${ownerUserId})
    `;
  });

  it('raises missing, overdue, window-missed, and under-value panels with exact day counts', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const dashboard = response.json<DashboardResponse>();

    const missing = dashboard.alerts.find(
      (alert) => alert.kind === 'pbg_missing' && alert.workCode === 'PBG-D-SOON',
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('warning');
    expect(missing?.dueInDays).toBe(20);
    expect(missing?.workId).toBe(missingSoonId);
    expect(missing?.message).toContain('100000.00');

    const overdue = dashboard.alerts.find(
      (alert) => alert.kind === 'pbg_missing' && alert.workCode === 'PBG-D-OVERDUE',
    );
    expect(overdue).toBeDefined();
    expect(overdue?.severity).toBe('danger');
    expect(overdue?.dueInDays).toBe(-9);
    expect(overdue?.workId).toBe(overdueId);

    const missed = dashboard.alerts.find(
      (alert) =>
        alert.kind === 'pbg_window_missed' && alert.workCode === 'PBG-D-MISSED',
    );
    expect(missed).toBeDefined();
    expect(missed?.severity).toBe('danger');
    expect(missed?.dueInDays).toBe(-19);
    expect(missed?.workId).toBe(missedId);
    // Missed outright is not double-reported as merely missing.
    expect(
      dashboard.alerts.filter(
        (alert) => alert.kind === 'pbg_missing' && alert.workCode === 'PBG-D-MISSED',
      ),
    ).toHaveLength(0);

    const under = dashboard.alerts.find(
      (alert) => alert.kind === 'pbg_undervalue' && alert.workCode === 'PBG-D-UNDER',
    );
    expect(under).toBeDefined();
    expect(under?.severity).toBe('warning');
    expect(under?.dueInDays).toBeNull();
    expect(under?.message).toContain('60000.00');
    expect(under?.message).toContain('100000.00');

    // The fully-covered Work raises nothing.
    expect(
      dashboard.alerts.filter((alert) => alert.workCode === 'PBG-D-OK'),
    ).toHaveLength(0);
  });
});

describe('cross-tenant denial', () => {
  it('hides another organisation’s review document from confirm', async () => {
    const letter = loadLetter('PL273-JHS');
    // Belongs to org A.
    const { documentId, review } = await seedReviewDocument(letter, 'PBG-EVIL-1');
    const response = await authed(otherOwner, {
      method: 'POST',
      url: `/api/loa-documents/${documentId}/confirm`,
      organisationId: otherOrganisationId,
      payload: {
        ...buildConfirmRequest(letter, review, 'PBG-EVIL-1'),
        pbgRequirement: { requiredAmount: '1.00', submissionDays: 21 },
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  }, 30_000);

  it('refuses a non-member binding the other organisation outright', async () => {
    const confirm = await authed(otherOwner, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(confirm.statusCode).toBe(403);
    expect(confirm.json()).toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('keeps PBG alerts and Work PBG fields inside their own organisation', async () => {
    const dashboard = await authed(otherOwner, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId: otherOrganisationId,
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const body = dashboard.json<DashboardResponse>();
    expect(body.alerts.filter((alert) => alert.kind.startsWith('pbg_'))).toHaveLength(
      0,
    );

    const [work] = await admin<{ id: string }[]>`
      select id from works
      where organisation_id = ${organisationId} and work_code = 'PBG-D-SOON'
    `;
    expect(work).toBeDefined();
    const denied = await authed(otherOwner, {
      method: 'GET',
      url: `/api/works/${work?.id ?? ''}`,
      organisationId: otherOrganisationId,
    });
    expect(denied.statusCode).toBe(404);
  });
});
