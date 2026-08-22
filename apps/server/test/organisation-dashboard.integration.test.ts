import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { DashboardResponse, OrganisationProfile } from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import { seedConfirmedRailwayMeasurement } from './helpers/railway-measurement-seed.js';

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
const ownerEmail = `orgdash-owner-${runId}@integration.test`;
const viewerEmail = `orgdash-viewer-${runId}@integration.test`;
const password = `integration-password-${runId}`;

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;
let workId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let viewer: CookieJar;

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

/** The organisation's own calendar day, `YYYY-MM-DD`. Every countdown the
 * dashboard prints is measured from this and not from the session's. */
async function organisationToday(): Promise<string> {
  const [row] = await admin<{ day: string }[]>`
    select (now() at time zone o.timezone)::date::text as day
    from organisations o
    where o.id = ${organisationId}
  `;
  return row?.day ?? '';
}

/** Whole days from one date-only string to another. Both are UTC-anchored
 * so the subtraction is exact — this is test arithmetic on legal dates,
 * never a timezone conversion. */
function daysBetween(from: string, to: string): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / day,
  );
}

/** PNG magic bytes plus filler — the endpoint validates magic, not decoding. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('auto-mb-logo-test-body'),
]);

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-orgdash-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-orgdash-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'Org Owner');
  viewer = await signUp(viewerEmail, 'Org Viewer');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Dashboard Constructions', slug: `orgdash-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing after sign-up');
  ownerUserId = ownerUser.id;

  const added = await authed(owner, {
    method: 'POST',
    url: '/api/organisations/current/members',
    organisationId,
    payload: { email: viewerEmail, role: 'viewer' },
  });
  expect(added.statusCode, added.body).toBe(201);

  // Seed one Work with an expiring and an expired instrument, a distant
  // instrument that must stay silent, a prepared bill, and one LOA
  // document still in review.
  workId = randomUUID();
  await admin`
    insert into works (
      id, organisation_id, work_code, letter_number, letter_date, title,
      advertised_value, contract_value, pricing_shape, created_by_user_id
    )
    values (
      ${workId}, ${organisationId}, 'DASH-1', 'L-77/2026', '2026-01-15',
      'Dashboard proof work', '5000000.00', '4520000.00', 'per_schedule',
      ${ownerUserId}
    )
  `;
  await admin`
    insert into work_instruments (
      organisation_id, work_id, kind, reference, amount, issued_on,
      expires_on, created_by_user_id
    )
    values
      (${organisationId}, ${workId}, 'pbg', 'BG/EXPIRED', '100000.00',
       current_date - 200, current_date - 5, ${ownerUserId}),
      (${organisationId}, ${workId}, 'pbg', 'BG/SOON', '100000.00',
       current_date - 100, current_date + 30, ${ownerUserId}),
      (${organisationId}, ${workId}, 'pac', 'PAC/FAR', null,
       current_date - 10, current_date + 300, ${ownerUserId})
  `;
  await admin`
    insert into bills (
      organisation_id, work_id, bill_number, total_amount, lines_snapshot,
      prepared_by_user_id
    )
    values (
      ${organisationId}, ${workId}, 1, '300.00', ${admin.json([] as never)},
      ${ownerUserId}
    )
  `;
  const documentId = randomUUID();
  const sha256 = createHash('sha256').update('dash letter').digest('hex');
  await admin`
    insert into loa_documents (
      id, organisation_id, object_key, original_filename, sha256, media_type,
      size_bytes, extraction_status, extraction_payload, uploaded_by_user_id
    )
    values (
      ${documentId}, ${organisationId},
      ${`${organisationId}/loa/${documentId}.pdf`}, 'dash.pdf', ${sha256},
      'application/pdf', 42, 'review', ${admin.json({ sourceText: 'x' })},
      ${ownerUserId}
    )
  `;
}, 60_000);

afterAll(async () => {
  if (admin) {
    await removeOrganisationResidue(admin, [organisationId]);
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`
      delete from auth_users where "email" like ${`%-${runId}@integration.test`}
    `;
    await admin.end();
  }
  if (app) await app.close();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

describe('organisation profile', () => {
  it('starts empty, accepts owner edits, and refuses non-owners', async () => {
    const initial = await authed(owner, {
      method: 'GET',
      url: '/api/organisation/profile',
      organisationId,
    });
    expect(initial.statusCode, initial.body).toBe(200);
    const initialProfile = initial.json<OrganisationProfile>();
    expect(initialProfile.address).toBeNull();
    expect(initialProfile.hasLogo).toBe(false);

    const denied = await authed(viewer, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { address: 'Not allowed' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('OWNER_REQUIRED');

    const updated = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: {
        address: 'Plot 4, MIDC, Nashik 422010',
        gstin: '27ABCDE1234F1Z5',
        contactPhone: '+91 98220 00000',
        contactEmail: 'office@dashboard.example',
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const profile = updated.json<OrganisationProfile>();
    expect(profile.address).toBe('Plot 4, MIDC, Nashik 422010');
    expect(profile.gstin).toBe('27ABCDE1234F1Z5');

    const badGstin = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: { gstin: 'short' },
    });
    expect(badGstin.statusCode).toBe(400);
  });

  it('accepts a PNG logo from the owner, streams it back, and removes it', async () => {
    const denied = await authed(viewer, {
      method: 'PUT',
      url: '/api/organisation/logo',
      organisationId,
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(denied.statusCode).toBe(403);

    const junk = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/logo',
      organisationId,
      headers: { 'content-type': 'image/png' },
      payload: Buffer.from('this is not an image'),
    });
    expect(junk.statusCode).toBe(400);
    expect(junk.json<{ code: string }>().code).toBe('INVALID_IMAGE');

    const uploaded = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/logo',
      organisationId,
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json<OrganisationProfile>().hasLogo).toBe(true);

    const streamed = await authed(viewer, {
      method: 'GET',
      url: '/api/organisation/logo',
      organisationId,
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers['content-type']).toBe('image/png');
    expect(streamed.rawPayload.equals(PNG_BYTES)).toBe(true);

    const removed = await authed(owner, {
      method: 'DELETE',
      url: '/api/organisation/logo',
      organisationId,
    });
    expect(removed.statusCode).toBe(204);
    const gone = await authed(owner, {
      method: 'GET',
      url: '/api/organisation/logo',
      organisationId,
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('dashboard', () => {
  it('aggregates totals and raises the seeded alerts for any member', async () => {
    const response = await authed(viewer, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const dashboard = response.json<DashboardResponse>();

    expect(dashboard.totals.works).toBe(1);
    expect(dashboard.totals.contractValue).toBe('4520000.00');
    expect(dashboard.totals.deliveredValue).toBe('0.00');
    expect(dashboard.totals.billedValue).toBe('300.00');
    expect(dashboard.totals.loaAwaitingReview).toBe(1);
    expect(dashboard.totals.openDrafts).toBe(0);

    // The GST basis (migration 0062). This Work was seeded without one, so
    // it carries the column default — the ordinary Indian works contract,
    // rates inclusive of 18%.
    const [seeded] = dashboard.works;
    expect(seeded?.gstBasis).toBe('inclusive');
    expect(seeded?.gstRate).toBe('18.00');
    // 300 billed against 4,520,000, computed on that basis and to four
    // decimal places. Computed on the SERVER: the browser used to divide
    // these two strings itself, where the basis was invisible.
    expect(seeded?.executedPercent).toBe('0.0066');
    expect(dashboard.totals.executedPercent).toBe('0.0066');

    const kinds = dashboard.alerts.map((alert) => alert.kind);
    expect(kinds).toContain('instrument_expired');
    expect(kinds).toContain('instrument_expiring');
    expect(kinds).toContain('loa_review_pending');
    // This bill was prepared without a Measurement Book, so no railway
    // figure exists to be outstanding against and the position reports
    // none. It used to be announced as "prepared but not submitted" with
    // nothing said about the money, which read exactly like a bill the
    // railway had certified and not paid.
    expect(kinds).toContain('bill_awaiting_closure');
    expect(kinds).not.toContain('bill_unpaid');
    const awaiting = dashboard.alerts.find(
      (alert) => alert.kind === 'bill_awaiting_closure',
    );
    expect(awaiting?.severity).toBe('notice');
    expect(awaiting?.settlement).toEqual({
      reference: null,
      received: '0.00',
      deducted: '0.00',
      outstanding: null,
    });
    // And it names a step this bill's operator can actually take. With no
    // Measurement Book there is nothing for the railway to have
    // certified, so sending them to record an On-Account Bill would point
    // at a document that cannot exist yet.
    expect(awaiting?.message).toContain('not backed by a Measurement Book');
    expect(awaiting?.message).toContain('Measurement Book and finalize it first');
    expect(awaiting?.message).not.toContain('On-Account Bill');

    const expired = dashboard.alerts.find(
      (alert) => alert.kind === 'instrument_expired',
    );
    expect(expired?.severity).toBe('danger');
    expect(expired?.dueInDays).toBe(-5);
    expect(expired?.workCode).toBe('DASH-1');

    const expiring = dashboard.alerts.find(
      (alert) => alert.kind === 'instrument_expiring',
    );
    expect(expiring?.severity).toBe('warning');
    expect(expiring?.dueInDays).toBe(30);

    // The instrument 300 days out must not raise an alert.
    expect(
      dashboard.alerts.filter((alert) => alert.message.includes('PAC/FAR')),
    ).toHaveLength(0);

    const work = dashboard.works[0];
    expect(work?.workCode).toBe('DASH-1');
    expect(work?.issuedChallans).toBe(0);
  });

  /* The landing screen's own figures (`docs/UX.md` § 40). Placed
   * immediately after the baseline case above and BEFORE the mixed-basis
   * one below, because that test inserts a second Work: these assertions
   * are about the seeded portfolio exactly as `beforeAll` leaves it. */
  it('states the ACTIVE portfolio, its receivable position, and the ninety-day feed', async () => {
    const response = await authed(viewer, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { signals, deadlines, execution, monthlyBilling } =
      response.json<DashboardResponse>();

    // One active Work, and the tiles state ITS value rather than the
    // register's. They agree here because nothing is completed yet — the
    // divergence is asserted where a completed Work exists.
    expect(signals.activeWorks).toBe(1);
    expect(signals.activeContractValue).toBe('4520000.00');
    expect(signals.activeBilledValue).toBe('300.00');
    expect(signals.activeExecutedPercent).toBe('0.0066');

    // The seeded bill has no Measurement Book, so the railway has
    // certified no figure: nothing is outstanding against it YET, which
    // is not the same as nothing being outstanding. It is counted, never
    // summed in at zero.
    expect(signals.receivableOutstanding).toBe('0.00');
    expect(signals.receivableIndeterminate).toBe(1);

    // No completion date is seeded on DASH-1 and nothing is queued for
    // the kiosk, so those lamps are dark rather than absent.
    expect(signals.completionsDue).toBe(0);
    expect(signals.completionsOverdue).toBe(0);
    expect(signals.unsignedDocuments).toBe(0);
    // Full-scope member, so the tiles describe the organisation and the
    // screen has no scope sentence to print.
    expect(signals.assignedScopeOnly).toBe(false);

    /* THE TWO INSTRUMENT STATES ARE COUNTED APART. One guarantee lapsed
     * five days ago and one expires in thirty, and the fixture holds both
     * precisely so a single "expiring" count cannot pass this. An expired
     * instrument is a terminal fact the forward-only ninety-day strip
     * below cannot show at all, so if the landing screen does not state
     * it here it does not state it anywhere. */
    expect(signals.instrumentsExpired).toBe(1);
    expect(signals.instrumentsExpiring).toBe(1);
    // Together they still account for exactly the instruments the alert
    // loop reported, which is what stops the lamps and the list from
    // disagreeing about the same guarantees.
    expect(signals.instrumentsExpired + signals.instrumentsExpiring).toBe(
      response
        .json<DashboardResponse>()
        .alerts.filter((alert) => alert.kind.startsWith('instrument_')).length,
    );

    // Ninety days FORWARD. The instrument thirty days out is on the
    // strip; the one that expired five days ago is not — an expired
    // guarantee is a fact the lamp above states in words, not a deadline —
    // and neither is the one three hundred days out.
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]?.kind).toBe('instrument');
    expect(deadlines[0]?.workCode).toBe('DASH-1');
    /* Measured against the ORGANISATION's calendar day, not the database
     * session's. The fixture seeds `current_date + 30`, and this
     * organisation's default timezone is `Asia/Kolkata` — five and a half
     * hours ahead of the UTC session — so for part of every day the two
     * clocks are on different dates and a hard-coded 30 would be wrong on
     * a schedule. The dedicated case below forces the divergence; this
     * one just refuses to assume it away. */
    expect(deadlines[0]?.dueInDays).toBe(
      daysBetween(await organisationToday(), deadlines[0]?.dueOn ?? ''),
    );

    // Supply and installation against contract value, both on the Work's
    // own basis and both computed here rather than in a browser.
    expect(execution).toHaveLength(1);
    expect(execution[0]?.workCode).toBe('DASH-1');
    expect(execution[0]?.suppliedPercent).toBe('0.0000');
    expect(execution[0]?.installedPercent).toBe('0.0000');
    expect(execution[0]?.dueOn).toBeNull();

    // Twelve CALENDAR months, ascending and distinct — the spine is
    // generated, so a quiet year is twelve empty months rather than a
    // shorter chart.
    expect(monthlyBilling).toHaveLength(12);
    expect(monthlyBilling.map((row) => row.month)).toEqual(
      [...monthlyBilling.map((row) => row.month)].sort(),
    );
    expect(new Set(monthlyBilling.map((row) => row.month)).size).toBe(12);
    for (const month of monthlyBilling) {
      expect(month.month).toMatch(/^\d{4}-\d{2}$/);
      // Nothing is invoiced or received in the fixture, and an absent
      // month reports zero rather than dropping out.
      expect(month.billed).toBe('0.00');
      expect(month.received).toBe('0.00');
    }
    // Nothing has been invoiced or received, so the organisation has no
    // billing history at all and the chart has no cutover to explain.
    expect(signals.billingSince).toBeNull();

    /* THE TILE'S THREE NUMBERS SHARE ONE BASIS. `activeExecutedPercent`
     * restates every term as taxable value before dividing, so the two
     * rupee figures a screen prints beside it have to be the taxable ones
     * or the sentence states a ratio true of neither. Asserted as
     * arithmetic rather than as a constant: 300 inclusive is 254.24
     * taxable, 4,520,000 inclusive is 3,830,508.47 taxable, and the
     * quotient is the percentage above. */
    expect(signals.activeContractTaxableValue).toBe('3830508.47');
    expect(signals.activeBilledTaxableValue).toBe('254.24');
    expect(
      Number(signals.activeBilledTaxableValue) /
        Number(signals.activeContractTaxableValue),
      // Six places, not more: the percentage is reported to four decimal
      // places, so the quotient can only agree with it to the precision
      // that rounding left.
    ).toBeCloseTo(Number(signals.activeExecutedPercent) / 100, 6);
  });

  /* A DOCUMENT NOBODY IS GOING TO SIGN IS NOT WAITING TO BE SIGNED.
   *
   * The lamp counted `failed` beside `pending` and `claimed`, so a
   * document whose signing attempt had stopped was reported as queued and
   * an operator reading "waiting to be signed" would have waited for a
   * kiosk that was never coming back to it. Migration 0091's open set is
   * the two, and the queue itself is where a failure is retried. */
  it('counts only the documents the kiosk is still going to pick up', async () => {
    /* One ISSUED challan per request, because 0091 refuses a signing
     * request against anything else — signing a draft would put the
     * organisation's certificate on bytes it is still free to change. */
    /* And one live kiosk agent holding the certificate every request is
     * pinned to: 0091 refuses a request the token could never satisfy. */
    const thumbprint = 'A'.repeat(40);
    const [agent] = await admin<{ id: string }[]>`
      insert into signing_agents (
        organisation_id, label, token_hash, certificate_thumbprint,
        certificate_subject, certificate_serial, certificate_not_after,
        certificate_chain_pem, operator_user_id, created_by_user_id
      )
      values (
        ${organisationId}, 'Dashboard kiosk', ${'c'.repeat(64)}, ${thumbprint},
        'CN=Test', '0A1B2C', now() + interval '365 days',
        '-----BEGIN CERTIFICATE-----test-----END CERTIFICATE-----',
        ${ownerUserId}, ${ownerUserId}
      )
      returning id
    `;
    let sequence = 900;
    const seedRequest = async (status: string) => {
      const challanId = randomUUID();
      sequence += 1;
      await admin`
        insert into delivery_challans (
          id, organisation_id, work_id, status, challan_date, challan_number,
          sequence_number, prefix, issued_snapshot, issued_at,
          created_by_user_id, issued_by_user_id
        )
        values (
          ${challanId}, ${organisationId}, ${workId}, 'issued', '2026-08-01',
          ${`DC/SIGN/${String(sequence)}`}, ${sequence}, 'DC',
          ${admin.json({})}, now(), ${ownerUserId}, ${ownerUserId}
        )
      `;
      await admin`
        insert into signing_requests (
          organisation_id, work_id, document_type, delivery_challan_id, status,
          signing_agent_id, certificate_thumbprint, source_object_key,
          source_sha256, authorised_digest, claimed_signing_time, signer_name,
          signing_reason, signing_location, requested_at, expires_at,
          claimed_at, completed_at, failure_reason, requested_by_user_id
        )
        values (
          ${organisationId}, ${workId}, 'delivery_challan', ${challanId},
          ${status}, ${agent?.id ?? null}, ${thumbprint},
          ${`${organisationId}/challans/${challanId}.pdf`}, ${'d'.repeat(64)},
          ${'b'.repeat(64)},
          now(), 'Test Signatory', 'Issued document', 'Nashik',
          now(), now() + interval '1 hour',
          -- Only a claimed row carries a claim time; the shape check
          -- refuses one on a pending row and does not ask for one on a
          -- failed row.
          ${status === 'claimed' ? new Date().toISOString() : null},
          -- A failed request is FINISHED, and the outcome shape refuses a
          -- half one: it carries the moment it stopped and the reason.
          -- That is exactly why it must not be counted as waiting.
          ${status === 'failed' ? new Date().toISOString() : null},
          ${status === 'failed' ? 'token withdrawn mid-signature' : null},
          ${ownerUserId}
        )
      `;
    };
    await seedRequest('pending');
    await seedRequest('claimed');
    await seedRequest('failed');
    try {
      const response = await authed(viewer, {
        method: 'GET',
        url: '/api/dashboard',
        organisationId,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<DashboardResponse>().signals.unsignedDocuments).toBe(2);
    } finally {
      await admin`delete from signing_requests where organisation_id = ${organisationId}`;
      await admin`delete from signing_agents where organisation_id = ${organisationId}`;
      /* The three challans stay: an ISSUED Delivery Challan is not
       * deletable and that rule is the product working. They carry no
       * items, so they add nothing to any delivered sum or challan count
       * the cases after this one read, and `removeOrganisationResidue`
       * clears them at teardown. */
    }
  });

  /* THE COUNTDOWNS ANSWER TO THE ORGANISATION'S CALENDAR, NOT THE
   * SERVER'S.
   *
   * `current_date` is the database session's day, and every deployment
   * runs it in UTC. An agency in IST crosses midnight five and a half
   * hours earlier, so for that slice of every day a guarantee expiring
   * tomorrow read as expiring in two days and a completion date that had
   * arrived read as one day away. Forced here rather than waited for, on
   * the pattern `challans.integration.test.ts` already uses: the
   * organisation is moved to a zone whose date is provably not UTC's, so
   * the divergence is a fact of the test rather than of the hour it runs
   * at. */
  it('measures every countdown against the organisation timezone', async () => {
    const [original] = await admin<{ timezone: string }[]>`
      select timezone from organisations where id = ${organisationId}
    `;
    expect(original).toBeDefined();
    try {
      await admin`
        update organisations
        set timezone = case
          when (now() at time zone 'Etc/GMT+12')::date <>
               (now() at time zone 'UTC')::date
            then 'Etc/GMT+12'
          else 'Pacific/Kiritimati'
        end
        where id = ${organisationId}
      `;
      const [clock] = await admin<{ day: string; sessionDay: string }[]>`
        select
          (now() at time zone o.timezone)::date::text as day,
          current_date::text as "sessionDay"
        from organisations o
        where o.id = ${organisationId}
      `;
      // The premise of everything below: the two clocks are on different
      // dates right now, so a statement reading the wrong one is visible.
      expect(clock?.day).not.toBe(clock?.sessionDay);
      const orgDay = clock?.day ?? '';

      const response = await authed(viewer, {
        method: 'GET',
        url: '/api/dashboard',
        organisationId,
      });
      expect(response.statusCode, response.body).toBe(200);
      const { deadlines, monthlyBilling } = response.json<DashboardResponse>();

      // The deadline strip: its day count is the distance from the
      // ORGANISATION's today, and reading the session's would be off by
      // exactly the one day the clocks differ by.
      const deadline = deadlines[0];
      expect(deadline).toBeDefined();
      expect(deadline?.dueInDays).toBe(daysBetween(orgDay, deadline?.dueOn ?? ''));
      expect(deadline?.dueInDays).not.toBe(
        daysBetween(clock?.sessionDay ?? '', deadline?.dueOn ?? ''),
      );

      // And the billing spine ends on the organisation's own month, which
      // is what decides whether the newest bar is this month or last.
      expect(monthlyBilling.at(-1)?.month).toBe(orgDay.slice(0, 7));
    } finally {
      await admin`
        update organisations set timezone = ${original?.timezone ?? 'Asia/Kolkata'}
        where id = ${organisationId}
      `;
    }
  });

  it('aggregates a MIXED-basis portfolio on one basis, not on printed rupees', async () => {
    // The regression the per-Work attribute exists for, at the API level.
    // DASH-1 is an inclusive Work worth 4,520,000 inclusive — 3,830,508.47
    // taxable. This second Work is an EXCLUSIVE one of exactly that
    // taxable size, so the two contracts are equal in real terms and the
    // portfolio percentage must be exactly half of DASH-1's own.
    const exclusiveWorkId = randomUUID();
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, gst_basis, gst_rate,
        created_by_user_id
      )
      values (
        ${exclusiveWorkId}, ${organisationId}, 'DASH-EXCL', 'L-78/2026',
        '2026-01-16', 'Rates quoted exclusive of GST', '4000000.00',
        '3830508.47', 'per_schedule', 'exclusive', 18.00, ${ownerUserId}
      )
    `;
    try {
      const response = await authed(viewer, {
        method: 'GET',
        url: '/api/dashboard',
        organisationId,
      });
      expect(response.statusCode, response.body).toBe(200);
      const dashboard = response.json<DashboardResponse>();

      const exclusive = dashboard.works.find((row) => row.workCode === 'DASH-EXCL');
      expect(exclusive?.gstBasis).toBe('exclusive');
      // Nothing billed on it, so it is pure denominator.
      expect(exclusive?.executedPercent).toBe('0.0000');

      // 0.0066 halved: the same 254.24 of taxable billing measured against
      // twice the taxable contract.
      expect(dashboard.totals.executedPercent).toBe('0.0033');

      // What adding the printed rupees would have said instead —
      // 300 / (4,520,000 + 3,830,508.47) = 0.0036%. It reads HIGH, because
      // the billed Work's figure carries GST that its neighbour's contract
      // value does not. Three ten-thousandths of a percent here; the same
      // error is 18% of the answer once both Works are actually executing.
      const naive = (300 / Number(dashboard.totals.contractValue)) * 100;
      expect(naive.toFixed(4)).toBe('0.0036');
      expect(dashboard.totals.executedPercent).not.toBe('0.0036');
    } finally {
      await admin`delete from works where id = ${exclusiveWorkId}`;
    }
  });

  /**
   * Three bills on one Work, identical but for their settlement register:
   * one the railway has certified and paid nothing of, one 97% settled
   * with an argument left over, and one settled to the rupee and waiting
   * only for somebody to move its status.
   *
   * Before the settlement register was read here all three raised the
   * same alert with the same sentence — "submitted and awaiting payment" —
   * which is the conflation this test exists to refuse. Run it against
   * the pre-fix tree and the distinct-kind and distinct-message
   * assertions both fail with three identical `bill_unpaid` rows.
   *
   * Seeded through `admin` rather than through the API: the payment
   * routes are proved by `bill-payments.integration.test.ts`, and what is
   * under test here is what the dashboard SAYS about a register, not how
   * the register is written. The residue is left to `afterAll`'s
   * `removeOrganisationResidue`, which knows the dependency order.
   */
  it('separates untouched, part-settled and fully settled bills', async () => {
    const payWorkId = randomUUID();
    const railwayAmount = '100000.00';
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id
      )
      values (
        ${payWorkId}, ${organisationId}, 'DASH-PAY', 'L-79/2026', '2026-02-01',
        'Three bills, three settlement positions', '400000.00', '300000.00',
        'per_schedule', ${ownerUserId}
      )
    `;

    /** A finalized Measurement Book, the railway's On-Account Bill that
     * closes it, and the bill prepared from it. */
    async function seedSettledBill(number: number): Promise<string> {
      const bookId = randomUUID();
      const billId = randomUUID();
      await admin`
        insert into measurement_books (
          id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
        )
        values (${bookId}, ${organisationId}, ${payWorkId}, 'draft', '2026-05-09',
                ${ownerUserId}, 'on_account')
      `;
      await admin`
        update measurement_books
        set status = 'finalized', mb_number = ${`DASH-PAY-MB-0${String(number)}`},
            sequence_number = ${number}, total_amount = ${railwayAmount},
            remark_template_version = 'mb-remark-v1', finalized_at = now(),
            finalized_by_user_id = ${ownerUserId}
        where id = ${bookId}
      `;
      await admin`
        insert into bills (
          id, organisation_id, work_id, bill_number, lines_snapshot, total_amount,
          prepared_by_user_id, mb_id, status, submitted_at
        )
        values (
          ${billId}, ${organisationId}, ${payWorkId}, ${number},
          ${admin.json([] as never)}, ${railwayAmount}, ${ownerUserId}, ${bookId},
          'submitted', now()
        )
      `;
      // 0111's precondition: a bill records only against a book whose
      // railway measurement is on file and settled.
      await seedConfirmedRailwayMeasurement(admin, {
        organisationId,
        workId: payWorkId,
        measurementBookId: bookId,
        userId: ownerUserId,
      });
      const [received] = await admin<{ id: string }[]>`
        insert into received_railway_bills (
          organisation_id, work_id, measurement_book_id, object_key,
          original_filename, sha256, media_type, size_bytes, bill_number,
          bill_date, bill_amount, rate_inclusive_of_gst, measurement_number,
          measurement_sequence, letter_number, extraction_payload,
          uploaded_by_user_id, signature_status, signature_verdict,
          signature_verified_at
        )
        values (
          ${organisationId}, ${payWorkId}, ${bookId},
          ${`${organisationId}/railwaybill/${bookId}.pdf`}, 'bill.pdf',
          ${'d'.repeat(64)}, 'application/pdf', 4096,
          ${`DASH-PAY/B${String(number)}`}, '2026-05-11', ${railwayAmount}, true,
          ${`DASH-PAY/OAM/FL2/0${String(number)}`}, ${number}, 'L-79/2026',
          ${admin.json({ billNumber: 'fixture' })}, ${ownerUserId},
          'signed_and_intact',
          ${admin.json({ signatures: [{ index: 1 }, { index: 2 }, { index: 3 }] })},
          now()
        )
        returning id
      `;
      await admin`
        update measurement_books
        set closed_at = now(), closed_by_user_id = ${ownerUserId},
            closed_by_received_bill_id = ${received?.id ?? ''}
        where id = ${bookId}
      `;
      return billId;
    }

    /** A finalized Measurement Book with no railway bill against it, and
     * the bill prepared from it. The other unclosed case: a measurement
     * exists, so the next step IS recording the railway's On-Account
     * Bill. */
    async function seedOpenBill(number: number): Promise<void> {
      const bookId = randomUUID();
      await admin`
        insert into measurement_books (
          id, organisation_id, work_id, status, mb_date, created_by_user_id, kind
        )
        values (${bookId}, ${organisationId}, ${payWorkId}, 'draft', '2026-05-09',
                ${ownerUserId}, 'on_account')
      `;
      await admin`
        update measurement_books
        set status = 'finalized', mb_number = ${`DASH-PAY-MB-0${String(number)}`},
            sequence_number = ${number}, total_amount = ${railwayAmount},
            remark_template_version = 'mb-remark-v1', finalized_at = now(),
            finalized_by_user_id = ${ownerUserId}
        where id = ${bookId}
      `;
      await admin`
        insert into bills (
          organisation_id, work_id, bill_number, lines_snapshot, total_amount,
          prepared_by_user_id, mb_id
        )
        values (
          ${organisationId}, ${payWorkId}, ${number}, ${admin.json([] as never)},
          ${railwayAmount}, ${ownerUserId}, ${bookId}
        )
      `;
    }

    /** One credit and its deductions. Both settle the bill — that is the
     * rule the register exists to state — so the pair below reaches the
     * railway's figure exactly on the third bill. */
    async function recordPayment(
      billId: string,
      amount: string,
      deductions: readonly { readonly category: string; readonly amount: string }[],
    ): Promise<void> {
      const [payment] = await admin<{ id: string }[]>`
        insert into bill_payments (
          organisation_id, bill_id, received_on, received_amount, reference,
          recorded_by_user_id
        )
        values (
          ${organisationId}, ${billId}, '2026-06-01', ${amount},
          ${`UTR-${billId.slice(0, 8)}`}, ${ownerUserId}
        )
        returning id
      `;
      for (const deduction of deductions) {
        await admin`
          insert into bill_payment_deductions (
            organisation_id, bill_payment_id, category, amount
          )
          values (${organisationId}, ${payment?.id ?? ''}, ${deduction.category},
                  ${deduction.amount})
        `;
      }
    }

    await seedSettledBill(1);
    const part = await seedSettledBill(2);
    const settled = await seedSettledBill(3);
    // 95,000 credited with 2,000 of GST TDS kept: 97,000 of 100,000
    // accounted for, 3,000 genuinely outstanding.
    await recordPayment(part, '95000.00', [{ category: 'GST_TDS', amount: '2000.00' }]);
    // The same credit, with the rest of the railway's figure accounted
    // for by deduction. Nothing is outstanding; the status has simply not
    // been moved, which §5.7 keeps as a manual act.
    await recordPayment(settled, '95000.00', [
      { category: 'GST_TDS', amount: '2000.00' },
      { category: 'INCOME_TAX_TDS', amount: '1000.00' },
      { category: 'SECURITY_DEPOSIT', amount: '2000.00' },
    ]);
    // The fourth: measured, but the railway has not certified it.
    await seedOpenBill(4);

    const response = await authed(viewer, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const dashboard = response.json<DashboardResponse>();
    const billAlerts = dashboard.alerts.filter(
      (alert) => alert.workCode === 'DASH-PAY',
    );
    // Warnings first and notices after, and inside each severity the
    // bill-number order the statement built — so bill 1 still precedes
    // bill 2, and bill 3 still precedes bill 4.
    expect(billAlerts.map((alert) => alert.kind)).toEqual([
      'bill_unpaid',
      'bill_part_settled',
      'bill_fully_settled',
      'bill_awaiting_closure',
    ]);

    // THE regression assertion. A bill 97% settled must not reach the
    // reader as the same statement as one nobody has paid a rupee of.
    const [untouchedAlert, partAlert, settledAlert, openAlert] = billAlerts;
    expect(partAlert?.message).not.toBe(untouchedAlert?.message);
    expect(partAlert?.settlement).not.toEqual(untouchedAlert?.settlement);
    expect(new Set(billAlerts.map((alert) => alert.message)).size).toBe(4);

    // The measured-but-uncertified bill names the step its operator can
    // take, which is not the step the Measurement-Book-less bill in the
    // first test is given.
    expect(openAlert?.severity).toBe('notice');
    expect(openAlert?.message).toContain('measurement is not closed');
    expect(openAlert?.message).toContain("record the railway's On-Account Bill first");
    expect(openAlert?.settlement).toEqual({
      reference: null,
      received: '0.00',
      deducted: '0.00',
      outstanding: null,
    });

    expect(untouchedAlert?.severity).toBe('warning');
    expect(untouchedAlert?.settlement).toEqual({
      reference: railwayAmount,
      received: '0.00',
      deducted: '0.00',
      outstanding: '100000.00',
    });
    expect(partAlert?.severity).toBe('warning');
    expect(partAlert?.settlement).toEqual({
      reference: railwayAmount,
      received: '95000.00',
      deducted: '2000.00',
      outstanding: '3000.00',
    });
    // Nothing to chase, so nothing that reads as due: the only thing left
    // is the status, and the alert says so.
    expect(settledAlert?.severity).toBe('notice');
    expect(settledAlert?.settlement).toEqual({
      reference: railwayAmount,
      received: '95000.00',
      deducted: '5000.00',
      outstanding: '0.00',
    });
    expect(settledAlert?.message).toContain('Mark it paid.');
  });

  /**
   * The list is ordered by urgency, not by which loop built it.
   *
   * A client shows the head of `alerts` and drops the tail — the web
   * dashboard shows seven — so the order decides what an operator never
   * sees. The list used to be section-ordered, with the PBG signals
   * pushed last of all, so enough low-severity rows ahead of them pushed
   * an overdue bank guarantee off the screen. Eight notices are enough.
   *
   * Run against the pre-fix tree and the first assertion fails: the
   * `pbg_missing` danger lands past the cap.
   */
  it('ranks danger ahead of notice, whichever loop built it', async () => {
    const rankWorkId = randomUUID();
    // A Work whose letter demands a PBG that was never submitted, with the
    // normal window closed and the extension window still open. Dates are
    // relative to `current_date` so the fixture cannot age into a
    // different branch.
    await admin`
      insert into works (
        id, organisation_id, work_code, letter_number, letter_date, title,
        advertised_value, contract_value, pricing_shape, created_by_user_id,
        pbg_required_amount, pbg_submission_days, pbg_extension_days,
        pbg_requirement_source
      )
      values (
        ${rankWorkId}, ${organisationId}, 'DASH-RANK', 'L-80/2026',
        current_date - 100, 'A danger built last, behind eight notices',
        '900000.00', '800000.00', 'per_schedule', ${ownerUserId},
        '80000.00', 30, 200,
        ${admin.json({ origin: 'fixture', raw: 'PBG 10% within 30 days' })}
      )
    `;
    // Eight bills with no Measurement Book: eight `bill_awaiting_closure`
    // notices, all built BEFORE the PBG loop runs.
    for (let number = 1; number <= 8; number++) {
      await admin`
        insert into bills (
          organisation_id, work_id, bill_number, lines_snapshot, total_amount,
          prepared_by_user_id
        )
        values (
          ${organisationId}, ${rankWorkId}, ${number}, ${admin.json([] as never)},
          '1000.00', ${ownerUserId}
        )
      `;
    }

    const response = await authed(viewer, {
      method: 'GET',
      url: '/api/dashboard',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const dashboard = response.json<DashboardResponse>();

    // The eight notices exist, so the crowding this guards against is
    // real rather than hypothetical.
    expect(
      dashboard.alerts.filter(
        (alert) =>
          alert.kind === 'bill_awaiting_closure' && alert.workCode === 'DASH-RANK',
      ),
    ).toHaveLength(8);

    // THE assertion: the danger survives the client's cap.
    const visible = dashboard.alerts.slice(0, 7);
    expect(visible.map((alert) => alert.kind)).toContain('pbg_missing');
    const pbg = dashboard.alerts.find((alert) => alert.kind === 'pbg_missing');
    expect(pbg?.severity).toBe('danger');
    expect(pbg?.workCode).toBe('DASH-RANK');

    // And the whole list is ranked, not just its head.
    const rank = { danger: 0, warning: 1, notice: 2 } as const;
    const ranks = dashboard.alerts.map((alert) => rank[alert.severity]);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));

    // Stable within a severity: the eight notices keep the bill-number
    // order the statement built them in.
    const numbers = dashboard.alerts
      .filter(
        (alert) =>
          alert.kind === 'bill_awaiting_closure' && alert.workCode === 'DASH-RANK',
      )
      .map((alert) => Number(/^Bill (\d+) /.exec(alert.message)?.[1] ?? '0'));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  /* EVERY INVOICE THIS ORGANISATION SUBMITTED, including the ones that
   * belong to no Work.
   *
   * The billed series joined the visible Works, so a direct invoice
   * (migration 0039) fell out of a chart whose own caption says "the tax
   * invoices this organisation submitted". An agency invoicing private
   * customers beside its railway contracts watched a third of its billing
   * vanish from its landing screen. */
  it('puts direct invoices in the billed series and dates the billing history', async () => {
    /* A money-carrying invoice needs the organisation's own state code:
     * without it the CGST+SGST / IGST split is undecidable and the
     * database refuses the row, exactly as the submit route does. */
    const [priorProfile] = await admin<{ stateCode: string | null }[]>`
      select state_code as "stateCode" from organisations where id = ${organisationId}
    `;
    await admin`
      update organisations set state_code = '27' where id = ${organisationId}
    `;
    const [contact] = await admin<{ id: string }[]>`
      insert into contacts (
        organisation_id, designation, is_client, created_by_user_id
      )
      values (${organisationId}, 'Direct customer', true, ${ownerUserId})
      returning id
    `;
    await admin`
      insert into tax_invoices (
        organisation_id, status, invoice_number, sequence_number, fy_label,
        invoice_date, sac_code, service_description, gst_rate,
        place_of_supply, buyer_contact_id, reverse_charge_applicable,
        stated_taxable_value, buyer_snapshot, taxable_value, cgst_amount,
        sgst_amount, igst_amount, total_amount, round_off, issued_snapshot,
        submitted_at, submitted_by_user_id, created_by_user_id
      )
      values (
        ${organisationId}, 'submitted', ${`DIRECT/${runId}`}, 9001, '2026-27',
        (select (now() at time zone o.timezone)::date from organisations o
         where o.id = ${organisationId}),
        '995461', 'Private supply', '18.00', '27', ${contact?.id ?? null}, false,
        '100000.00', ${admin.json({ designation: 'Direct customer' })},
        '100000.00', '9000.00', '9000.00', '0.00', '118000.00', '0.00',
        ${admin.json({})}, now(), ${ownerUserId}, ${ownerUserId}
      )
    `;
    try {
      const response = await authed(viewer, {
        method: 'GET',
        url: '/api/dashboard',
        organisationId,
      });
      expect(response.statusCode, response.body).toBe(200);
      const { signals, monthlyBilling } = response.json<DashboardResponse>();

      // The invoice belongs to no Work, and the chart is the poorer for
      // its absence rather than the safer.
      const current = monthlyBilling.at(-1);
      expect(current?.billed).toBe('118000.00');
      // And nothing reached the bank against it — a direct invoice has no
      // prepared bill, so there is no receipt register for one. The series
      // are asymmetric by construction and the screen says so.
      expect(current?.received).toBe('0.00');

      /* The cutover marker. By the time this case runs the fixture also
       * holds recorded receipts from the settlement case above, so the
       * earliest evidence is theirs and not this invoice's — which is
       * exactly what the figure means: the first month this application
       * holds ANY billing evidence for, invoiced or received. It is a
       * real month, no later than the invoice that certainly exists, and
       * it is not the head of the window (the first case in this file
       * proves it reads null when there is nothing at all). */
      expect(signals.billingSince).toMatch(/^\d{4}-\d{2}$/);
      // `YYYY-MM` sorts lexically, so this is a date comparison.
      expect((signals.billingSince ?? '') <= (current?.month ?? '')).toBe(true);
    } finally {
      /* The invoice is NOT deleted: a submitted one is an issued document
       * and the database refuses to destroy it, which is the rule
       * working. It is left for `removeOrganisationResidue` to clear at
       * teardown, and this case runs LAST in the file so nothing after it
       * reads a portfolio it has changed. */
      await admin`
        update organisations set state_code = ${priorProfile?.stateCode ?? null}
        where id = ${organisationId}
      `;
    }
  });
});
