import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  ChallanDetailResponse,
  Contact,
  EwayBillDetailResponse,
  MeasurementBookDetailResponse,
  PurchaseOrderDetailResponse,
  TaxInvoiceDetailResponse,
  WorkCompletionReadiness,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';

/**
 * The complete post-award lifecycle, end to end through the real API â€”
 * one Work walked from LOA confirmation to completion, with every money
 * figure asserted as the exact decimal string the API answers:
 *
 *  1. LOA PDF uploaded and confirmed into a Work carrying two supply
 *     items and a pure-installation item; organisation tax facts and the
 *     consignee/vendor/client contacts set first; item categories and the
 *     payment matrix written through their APIs.
 *  2. A purchase order to the vendor for the supply items, issued with a
 *     gapless number and a frozen vendor snapshot.
 *  3. A delivery challan whose items map onto the purchase-order lines;
 *     issuing it moves the derived received balance, and the order closes
 *     only once every line is fully received.
 *  4. The pure-installation item recorded installed on site.
 *  5. TWO consignees fill TWO record MBs in parallel over disjoint
 *     sources; the one-live-claim rule is proven while they run; the main
 *     consignee merges them into the on-account MB that finalizes as
 *     <work>-MB-01.
 *  6. The cumulative tax invoice (one service line at a SAC) submitted
 *     against MB-01 â€” FY number, intra-state split and totals exact â€”
 *     then the IRP response, the closure rule (an invoiced MB can no
 *     longer be cancelled), and the e-way bill through its NIC payload
 *     and response.
 *  7. The remainder delivered and installed, swept by a Measurement Book
 *     of kind FINAL (never an on-account) that finalizes as MB-02, is
 *     invoiced and submitted; no MB of any kind may follow it.
 *  8. The readiness endpoint answers ready, the Work completes, and a
 *     completed Work refuses new operational documents.
 *
 * Refusals are proven inline exactly where the lifecycle makes them
 * meaningful: closing a part-received order, a second claim on a claimed
 * source, cancelling a claimed challan, an incomplete final sweep,
 * cancelling the invoiced MB, raising an MB after the final one, and
 * drafting a challan against the completed Work.
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
const ownerEmail = `lc-owner-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const workCode = `LCW${runId.slice(0, 4).toUpperCase()}`;
const LETTER_DATE = '2025-06-01';

const ORG_NAME = 'Lifecycle Constructions';
const ORG_GSTIN = '07ABCDE1234F1Z5';
const ORG_ADDRESS = 'Plot 12, Industrial Area, New Delhi, 110002';
const BUYER_GSTIN = '07AAAGM0289C1ZL';
const BUYER_ADDRESS = 'DRM Office, State Entry Road, New Delhi, 110055';
const VENDOR_GSTIN = '27AABCB1234C1ZP';
const SERVICE_DESCRIPTION = 'Works contract services for signalling installation';
const SAC = '995421';
const TRANSPORTER_ID = '07ABCDE1234F1Z5';

let admin: Sql;
let app: FastifyInstance;
let storageDir: string;
let organisationId: string;
let ownerUserId: string;

// The lifecycle's running state, in the order the story builds it.
let consignee1Id: string; // fills record MB 1, then merges (the main consignee)
let consignee2Id: string; // fills record MB 2 in parallel
let vendorContactId: string;
let buyerContactId: string;
let workId: string;
let cableItemId: string; // item 1: SUPPLY, 100 Mtr @ 250.00
let relayItemId: string; // item 2: SUPPLY, 10 Nos @ 1200.00
let installItemId: string; // item 3: PURE_INSTALLATION, 5 Nos @ 400.00
let purchaseOrderId: string;
let poLineCableId: string;
let poLineRelayId: string;
let challan1Id: string;
let challan2Id: string;
let installation1Id: string;
let installation2Id: string;
let record1Id: string;
let record2Id: string;
let mb1Id: string;
let mb2Id: string;
let invoice1Id: string;
let ewayBillId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;

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

/** A minimal but structurally valid single-page PDF whose text layer is
 * exactly `text`, with a correct xref table â€” enough for pdftotext to
 * extract it without repair heuristics. ASCII input only. */
function buildTestPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    4: `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 1; index <= 5; index += 1) {
    offsets[index] = pdf.length;
    pdf += `${String(index)} 0 obj\n${objects[index] ?? ''}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let index = 1; index <= 5; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function createContact(body: Record<string, unknown>): Promise<Contact> {
  const response = await authed(owner, {
    method: 'POST',
    url: '/api/masters/contacts',
    organisationId,
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Contact>();
}

async function getPurchaseOrder(): Promise<PurchaseOrderDetailResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: `/api/purchase-orders/${purchaseOrderId}`,
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PurchaseOrderDetailResponse>();
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

async function finalize(mbId: string) {
  return authed(owner, {
    method: 'POST',
    url: `/api/measurement-books/${mbId}/finalize`,
    organisationId,
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-lc-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the lifecycle integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
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

  storageDir = await mkdtemp(path.join(os.tmpdir(), 'auto-mb-lc-objects-'));
  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    objectStorageDir: storageDir,
  });

  owner = await signUp(ownerEmail, 'LC Owner');
  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: ORG_NAME, slug: `lc-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const [ownerUser] = await admin<{ id: string }[]>`
    select "id" from auth_users where "email" = ${ownerEmail}
  `;
  if (!ownerUser) throw new Error('owner user missing');
  ownerUserId = ownerUser.id;
  // Issue and cancel are explicit authorities on top of the writer role.
  await admin`
    update organisation_memberships
    set can_issue_documents = true, can_cancel_documents = true
    where organisation_id = ${organisationId} and user_id = ${ownerUserId}
  `;
}, 120_000);

afterAll(async () => {
  if (admin) {
    if (organisationId) {
      // The immutability triggers (rightly) block deleting issued rows;
      // fixture cleanup is exactly what session_replication_role is for.
      await admin.unsafe(`set session_replication_role = 'replica'`);
      try {
        for (const table of [
          'audit_events',
          'work_assignments',
          'eway_bills',
          'tax_invoices',
          'tax_invoice_counters',
          'document_number_series',
          'mb_sources',
          'measurement_book_lines',
          'measurement_book_counters',
          'bills',
          'measurement_books',
          'bill_counters',
          'payment_matrices',
          'mb_entries',
          'installation_serials',
          'installations',
          'location_masters',
          'challan_item_serials',
          'challan_receipts',
          'delivery_challan_items',
          'delivery_challan_counters',
          'delivery_challans',
          'purchase_order_lines',
          'purchase_order_counters',
          'purchase_orders',
          'contacts',
          'loa_documents',
          'work_items',
          'work_schedules',
          'works',
          'organisation_memberships',
          'organisations',
        ]) {
          await admin.unsafe(
            `delete from ${table} where ${table === 'organisations' ? 'id' : 'organisation_id'} = $1`,
            [organisationId],
          );
        }
      } finally {
        await admin.unsafe(`set session_replication_role = 'origin'`);
      }
    }
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users
        where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
  }
  await app?.close();
  await admin?.end();
  if (storageDir !== undefined) {
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe('1 â€” LOA to Work', () => {
  it('sets the organisation tax facts and the consignee, vendor, and client contacts', async () => {
    const profile = await authed(owner, {
      method: 'PATCH',
      url: '/api/organisation/profile',
      organisationId,
      payload: {
        stateCode: '07',
        gstin: ORG_GSTIN,
        address: ORG_ADDRESS,
        pincode: '110002',
        locality: 'New Delhi',
        // The house number series. Invoice numbers are composed from it,
        // the financial year's opening year, and one gapless serial.
        invoiceNumberPrefix: 'P10',
      },
    });
    expect(profile.statusCode, profile.body).toBe(200);
    // The organisation's own invoice series (migration 0039); the
    // product default is TI/<FY>/NNN.
    const series = await authed(owner, {
      method: 'PUT',
      url: '/api/organisation/number-series/tax_invoice',
      organisationId,
      payload: { template: '{PREFIX}{FY2}{SEQ:3}' },
    });
    expect(series.statusCode, series.body).toBe(200);
    expect(profile.json<{ stateCode: string; gstin: string }>()).toMatchObject({
      stateCode: '07',
      gstin: ORG_GSTIN,
    });

    // Two consignees for the parallel record MBs.
    consignee1Id = (
      await createContact({
        designation: `Sr. DEE (TRD) CR ${runId}`,
        address: 'Divisional office, Delhi Division',
        stateCode: '07',
      })
    ).id;
    consignee2Id = (
      await createContact({
        designation: `Dy. CSTE (Con) CR ${runId}`,
        address: 'Construction office, Kashmere Gate',
        stateCode: '07',
      })
    ).id;

    // The vendor and the client (invoice buyer). The contacts API creates
    // every contact in the consignee role â€” the vendor/client role flags
    // are 0028 columns no route sets yet â€” so the roles are flipped with
    // admin SQL, exactly as the purchase-order suite seeds its vendors.
    vendorContactId = (
      await createContact({
        designation: `Bharat Cables Pvt Ltd ${runId}`,
        contactPerson: 'R. Nair',
        address: 'Plot 12, MIDC, Pune',
        gstin: VENDOR_GSTIN,
        pincode: '411019',
        stateCode: '27',
        locality: 'Pune',
      })
    ).id;
    await admin`
      update contacts set is_vendor = true, is_consignee = false
      where id = ${vendorContactId}
    `;
    buyerContactId = (
      await createContact({
        designation: 'Sr. DEE (G) NR',
        contactPerson: 'S K Verma',
        address: BUYER_ADDRESS,
        gstin: BUYER_GSTIN,
        pincode: '110055',
        stateCode: '07',
        locality: 'New Delhi',
      })
    ).id;
    await admin`
      update contacts set is_client = true where id = ${buyerContactId}
    `;
  }, 30_000);

  it('uploads the LOA PDF and confirms it into the Work', async () => {
    const uploaded = await authed(owner, {
      methëÍ}¶‰žËkºwµç}…µ½Õ¹Ðè€œÈÈÜÌ¸ÐÀœ°(€€€€€ÍÍÑ}…µ½Õ¹Ðè€œÈÈÜÌ¸ÐÀœ°(€€€€€¥ÍÑ}…µ½Õ¹Ðè€œÀ¸ÀÀœ°(€€€€€Ñ½Ñ…±}…µ½Õ¹Ðè€œÈäàÀÜ¸ÀÀœ°(€€€€€™å}±…‰•°è€œÈÀÈØ´ÈÜœ°(€€€ô¤ì(€ô¤ì((€¥Ð Ñ¡”ÍÕ‰µ¥ÑÑ•¥¹Ù½¥”1=ML5´ÀÄèÑ¡”€ÀÀÌÔÑÉ¥•ÈÉ•™ÕÍ•Ì¥ÑÌ…¹•°……¥¹ÍÐ…¹äÝÉ¥Ñ•Èœ°…Íå¹Œ€ ¤€ôøì(€€€…Ý…¥Ð•áÁ•Ð (€€€€€…‘µ¥¹€(€€€€€€€ÕÁ‘…Ñ”µ•…ÍÕÉ•µ•¹Ñ}‰½½­Ì(€€€€€€€Í•ÐÍÑ…ÑÕÌ€ô€…¹•±±•œ°…¹•±±…Ñ¥½¹}¹½Ñ”€ô€±½ÍÕÉ”ÉÕ±”ÁÉ½‰”œ°(€€€€€€€€€€€…¹•±±•‘}‰å}ÕÍ•É}¥€ô€‘í½Ý¹•ÉUÍ•É%‘ô°…¹•±±•‘}…Ð€ô¹½Ü ¤(€€€€€€€Ý¡•É”¥€ô€‘íµˆÅ%‘ô(€€€€€€°(€€€€¤¹É•©•ÑÌ¹Ñ½Q¡É½ÝÉÉ½È ½±½Í•‰ä„Ñ…à¥¹Ù½¥”¼¤ì(€€€½¹ÍÐm‰½½­t€ô…Ý…¥Ð…‘µ¥¸ñìÍÑ…ÑÕÌèÍÑÉ¥¹œõmtù€(€€€€€Í•±•ÐÍÑ…ÑÕÌ™É½´µ•…ÍÕÉ•µ•¹Ñ}‰½½­ÌÝ¡•É”¥€ô€‘íµˆÅ%‘ô(€€€€ì(€€€•áÁ•Ð¡‰½½¬ü¹ÍÑ…ÑÕÌ¤¹Ñ½	” ™¥¹…±¥é•œ¤ì(€ô¤ì((€¥Ð Í•ÉÙ•ÌÑ¡”…¹½¹¥…°9%€Ä¸Ä%I@Á…å±½……¹É•½É‘ÌÑ¡”%I@É•ÍÁ½¹Í”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÁ…å±½…€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘í¥¹Ù½¥”Å%‘ô½¥ÉÀµÁ…å±½…‘€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡Á…å±½…¹ÍÑ…ÑÕÍ½‘”°Á…å±½…¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡Á…å±½…¹©Í½¸ ¤¤¹Ñ½MÑÉ¥ÑÅÕ…°¡ì(€€€€€Y•ÉÍ¥½¸è€œÄ¸Äœ°(€€€€€QÉ…¹Ñ±ÌèìQ…áM è€MPœ°MÕÁQåÀè€Éœ°I•I•Øè€8œô°(€€€€€½Ñ±ÌèìQåÀè€%9Xœ°9¼è€@ÄÀÈØÀÀÄœ°Ðè€œÀä¼Àà¼ÈÀÈØœô°(€€€€€M•±±•ÉÑ±Ìèì(€€€€€€€ÍÑ¥¸è=I}MQ%8°(€€€€€€€1±9´è=I}95°(€€€€€€€‘‘ÈÄè=I}IML°(€€€€€€€1½Œè€9•Ü•±¡¤œ°(€€€€€€€A¥¸è€ÄÄÀÀÀÈ°(€€€€€€€MÑè€œÀÜœ°(€€€€€ô°(€€€€€	Õå•ÉÑ±Ìèì(€€€€€€€ÍÑ¥¸è	UeI}MQ%8°(€€€€€€€1±9´è€MÈ¸€¡¤9Hœ°(€€€€€€€A½Ìè€œÀÜœ°(€€€€€€€‘‘ÈÄè	UeI}IML°(€€€€€€€1½Œè€9•Ü•±¡¤œ°(€€€€€€€A¥¸è€ÄÄÀÀÔÔ°(€€€€€€€MÑè€œÀÜœ°(€€€€€ô°(€€€€€%Ñ•µ1¥ÍÐèl(€€€€€€€ì(€€€€€€€€€M±9¼è€œÄœ°(€€€€€€€€€AÉ‘•ÍŒèMIY%}MI%AQ%=8°(€€€€€€€€€%ÍM•ÉÙŒè€dœ°(€€€€€€€€€!Í¹èM°(€€€€€€€€€EÑäè€Ä°(€€€€€€€€€U¹¥Ðè€=Q œ°(€€€€€€€€€U¹¥ÑAÉ¥”è€ÈÔÈØÀ°(€€€€€€€€€Q½ÑµÐè€ÈÔÈØÀ°(€€€€€€€€€ÍÍµÐè€ÈÔÈØÀ°(€€€€€€€€€ÍÑIÐè€Äà°(€€€€€€€€€ÍÑµÐè€ÈÈÜÌ¸Ð°(€€€€€€€€€MÍÑµÐè€ÈÈÜÌ¸Ð°(€€€€€€€€€%ÍÑµÐè€À°(€€€€€€€€€Q½Ñ%Ñ•µY…°è€ÈäàÀØ¸à°(€€€€€€€ô°(€€€€€t°(€€€€€Y…±Ñ±Ìèì(€€€€€€€ÍÍY…°è€ÈÔÈØÀ°(€€€€€€€ÍÑY…°è€ÈÈÜÌ¸Ð°(€€€€€€€MÍÑY…°è€ÈÈÜÌ¸Ð°(€€€€€€€%ÍÑY…°è€À°(€€€€€€€€¼¼ÍÕ´¡Q½Ñ%Ñ•µY…°¤€¬I¹‘=™™µÐ€ôQ½Ñ%¹ÙY…°°9%Ì½Ý¸¥‘•¹Ñ¥Ñä¸(€€€€€€€I¹‘=™™µÐè€À¸È°(€€€€€€€Q½Ñ%¹ÙY…°è€ÈäàÀÜ°(€€€€€ô°(€€€ô¤ì((€€€½¹ÍÐ¥É¸€ô€œÀÄÈÌÐÔØÜàå…‰‘•˜œ¹É•Á•…Ð Ð¤ì(€€€½¹ÍÐÉ•½É‘•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘í¥¹Ù½¥”Å%‘ô½¥ÉÀµÉ•ÍÁ½¹Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€¥É¸°(€€€€€€€…­9Õµ‰•Èè€œÄÄÈÀÄÀÀÌØÔØÌœ°(€€€€€€€…­…Ñ”è€œÈÀÈØ´Àà´ÀåPÄÀèÌÀèÀÀ¸ÀÀÁhœ°(€€€€€€€…­…Ñ•Q•áÐè€œÀä¼Àà¼ÈÀÈØ€ÄØèÀÀèÀÀœ°(€€€€€€€Í¥¹•‘EÈè€Í¥¹•µÅÈµ©ÝÌµÁ…å±½…œ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•½É‘•¹ÍÑ…ÑÕÍ½‘”°É•½É‘•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐ‘•Ñ…¥°€ôÉ•½É‘•¹©Í½¸ñQ…á%¹Ù½¥••Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹¥¹Ù½¥”¹¥É¸¤¹Ñ½	”¡¥É¸¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹¥¹Ù½¥”¹…­9Õµ‰•È¤¹Ñ½	” œÄÄÈÀÄÀÀÌØÔØÌœ¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹Í¥¹•‘EÈ¤¹Ñ½	” Í¥¹•µÅÈµ©ÝÌµÁ…å±½…œ¤ì(€ô¤ì((€¥Ð µ½Ù•ÌÑ¡”¥¹Ù½¥”½¸…¸”µÝ…ä‰¥±°è‘É…™Ð°9%Á…å±½…°9%É•ÍÁ½¹Í”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘í¥¹Ù½¥”Å%‘ô½•Ý…äµ‰¥±±Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ5½‘”è€É½…œ°(€€€€€€€‘¥ÍÑ…¹•-´è€ÈÔ°(€€€€€€€™É½µA¥¹½‘”è€œÄÄÀÀÀÈœ°(€€€€€€€Ñ½A¥¹½‘”è€œÄÄÀÀÔÔœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€•Ý…å	¥±±%€ôÉ•…Ñ•¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¹¥ì(€€€•áÁ•Ð¡É•…Ñ•¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€Ñ…á%¹Ù½¥•%è¥¹Ù½¥”Å%°(€€€€€¥¹Ù½¥•9Õµ‰•Èè€@ÄÀÈØÀÀÄœ°(€€€€€ÍÑ…ÑÕÌè€‘É…™Ðœ°(€€€€€Ù•¡¥±•9Õµ‰•Èè¹Õ±°°(€€€ô¤ì((€€€€¼¼M•ÉÙ¥”µ¥¹Ù½¥”]ÕÍ•ÌÑ¡”]¡¥Ñ•‰½½­Ì•¹•É…Ñ”µ‰äµ%I8ÍÕÉ™…”¸(€€€€¼¼]¥Ñ ¹¼ÁÉ½Ù¥‘•È½¹™¥ÕÉ•°¹¼ÍÑ…¹‘…±½¹”Mµ…Ìµ½½‘ÌÁ…å±½…¥Ì•áÁ½Í•¸(€€€½¹ÍÐ¥¹½µÁ±•Ñ”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘í•Ý…å	¥±±%‘ô½¹¥ŒµÁ…å±½…‘€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¥¹½µÁ±•Ñ”¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡¥¹½µÁ±•Ñ”¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” (€€€€€€]e}	%11}9=Q}AA1%	1}Q=}MIY%}%9Y=%œ°(€€€€¤ì((€€€½¹ÍÐ•‘¥Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€AUPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘í•Ý…å	¥±±%‘õ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ5½‘”è€É½…œ°(€€€€€€€‘¥ÍÑ…¹•-´è€ÈÔ°(€€€€€€€™É½µA¥¹½‘”è€œÄÄÀÀÀÈœ°(€€€€€€€Ñ½A¥¹½‘”è€œÄÄÀÀÔÔœ°(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ•É%èQI9MA=IQI}%°(€€€€€€€ÑÉ…¹ÍÁ½ÉÑ•É9…µ”è€M¡…Éµ„I½…‘Ý…åÌœ°(€€€€€€€Ù•¡¥±•9Õµ‰•Èè€0ÀÅÄÈÌÐœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡•‘¥Ñ•¹ÍÑ…ÑÕÍ½‘”°•‘¥Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì((€€€½¹ÍÐ•¹•É…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½•Ý…äµ‰¥±±Ì¼‘í•Ý…å	¥±±%‘ô½¹¥ŒµÉ•ÍÁ½¹Í•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€•Ý‰9Õµ‰•Èè€œÄÈÌÐÔØÜàäÀÄÈœ°(€€€€€€€•Ý‰…Ñ”è€œÈÀÈØ´Àà´ÀåPÄÈèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€€€Ù…±¥‘U¹Ñ¥°è€œÈÀÈØ´Àà´ÄÁPÈÌèÔäèÔä¸ÀÀÁhœ°(€€€€€€€•Ý‰…Ñ•Q•áÐè€œÀä¼Àà¼ÈÀÈØ€ÄÜèÌÀèÀÀœ°(€€€€€€€Ù…±¥‘U¹Ñ¥±Q•áÐè€œÄÀ¼Àà¼ÈÀÈØ€ÈÌèÔäèÔäœ°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡•¹•É…Ñ•¹ÍÑ…ÑÕÍ½‘”°•¹•É…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡•¹•É…Ñ•¹©Í½¸ñÝ…å	¥±±•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹•Ý…å	¥±°¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€•¹•É…Ñ•œ°(€€€€€•Ý‰9Õµ‰•Èè€œÄÈÌÐÔØÜàäÀÄÈœ°(€€€€€•Ý‰…Ñ”è€œÈÀÈØ´Àà´ÀåPÄÈèÀÀèÀÀ¸ÀÀÁhœ°(€€€€€Ù…±¥‘U¹Ñ¥°è€œÈÀÈØ´Àà´ÄÁPÈÌèÔäèÔä¸ÀÀÁhœ°(€€€ô¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” œÜƒŠPÑ¡”É•µ…¥¹‘•È°…¹Ñ¡”%905•…ÍÕÉ•µ•¹Ð	½½¬œ°€ ¤€ôøì(€¥Ð Ñ¡”É•…‘¥¹•ÍÌ•¹‘Á½¥¹Ð¹…µ•Ì•á…Ñ±äÝ¡…Ð¥ÌÍÑ¥±°½Ý•œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½½µÁ±•Ñ¥½¸µÉ•…‘¥¹•ÍÍ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•ÍÁ½¹Í”¹ÍÑ…ÑÕÍ½‘”°É•ÍÁ½¹Í”¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐÉ•…‘¥¹•ÍÌ€ôÉ•ÍÁ½¹Í”¹©Í½¸ñ]½É­½µÁ±•Ñ¥½¹I•…‘¥¹•ÍÌø ¤ì(€€€•áÁ•Ð¡É•…‘¥¹•ÍÌ¹É•…‘ä¤¹Ñ½	”¡™…±Í”¤ì(€€€•áÁ•Ð¡É•…‘¥¹•ÍÌ¹‰±½­•ÉÌ¤¹Ñ½ÅÕ…°¡mt¤ì(€€€•áÁ•Ð¡É•…‘¥¹•ÍÌ¹Õ¹™¥¹¥Í¡•¤¹Ñ½!…Ù•1•¹Ñ  È¤ì(€€€•áÁ•Ð¡É•…‘¥¹•ÍÌ¹Õ¹™¥¹¥Í¡•‘lÁt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€Ý½É­%Ñ•µ%è…‰±•%Ñ•µ%°(€€€€€¥Ñ•µ9Õµ‰•Èè€œÄœ°(€€€€€É•ÅÕ¥É•µ•¹Ðè€‘•±¥Ù•Éäœ°(€€€€€‘¥É•Ñ¥½¸è€Í¡½ÉÐœ°(€€€€€É•ÅÕ¥É•‘EÕ…¹Ñ¥Ñäè€œÄÀÀ¸ÀÀÀœ°(€€€€€‘•±¥Ù•É•‘EÕ…¹Ñ¥Ñäè€œØÀ¸ÀÀÀœ°(€€€ô¤ì(€€€•áÁ•Ð¡É•…‘¥¹•ÍÌ¹Õ¹™¥¹¥Í¡•‘lÅt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€Ý½É­%Ñ•µ%è¥¹ÍÑ…±±%Ñ•µ%°(€€€€€¥Ñ•µ9Õµ‰•Èè€œÌœ°(€€€€€É•ÅÕ¥É•µ•¹Ðè€¥¹ÍÑ…±±…Ñ¥½¸œ°(€€€€€‘¥É•Ñ¥½¸è€Í¡½ÉÐœ°(€€€€€É•ÅÕ¥É•‘EÕ…¹Ñ¥Ñäè€œÔ¸ÀÀÀœ°(€€€€€¥¹ÍÑ…±±•‘EÕ…¹Ñ¥Ñäè€œÌ¸ÀÀÀœ°(€€€ô¤ì(€ô¤ì((€¥Ð ‘•±¥Ù•ÉÌ…¹¥¹ÍÑ…±±ÌÑ¡”É•µ…¥¹‘•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½¡…±±…¹Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€¡…±±…¹…Ñ”è€œÈÀÈØ´Àà´ÀØœ°(€€€€€€€ÁÉ•™¥àè€1œ°(€€€€€€€½¹Í¥¹•”èì(€€€€€€€€€¹…µ”èMÈ¸€¡QI¤H€‘íÉÕ¹%‘õ€°(€€€€€€€€€…‘‘É•ÍÌè€¥Ù¥Í¥½¹…°½™™¥”°•±¡¤¥Ù¥Í¥½¸œ°(€€€€€€€ô°(€€€€€€€¥Ñ•µÌèmìÝ½É­%Ñ•µ%è…‰±•%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÐÀœõt°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€¡…±±…¸É%€ôÉ•…Ñ•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¡…±±…¸¹¥ì(€€€½¹ÍÐ¥ÍÍÕ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½¡…±±…¹Ì¼‘í¡…±±…¸É%‘ô½¥ÍÍÕ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹ÍÑ…ÑÕÍ½‘”°¥ÍÍÕ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€•áÁ•Ð¡¥ÍÍÕ•¹©Í½¸ñ¡…±±…¹•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¡…±±…¸¹¡…±±…¹9Õµ‰•È¤¹Ñ½	” 1¼Èœ¤ì((€€€½¹ÍÐ¥¹ÍÑ…±±•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½¥¹ÍÑ…±±…Ñ¥½¹Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€Ý½É­%Ñ•µ%è¥¹ÍÑ…±±%Ñ•µ%°(€€€€€€€ÅÕ…¹Ñ¥Ñäè€œÈœ°(€€€€€€€¥¹ÍÑ…±±•‘=¸è€œÈÀÈØ´Àà´ÀØœ°(€€€€€€€¹•Ý1½…Ñ¥½¸èì¹…µ”è	•Ñ„…‰¥¸€‘íÉÕ¹%‘õ€°­¥¹è€ÍÑ…Ñ¥½¸œô°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡¥¹ÍÑ…±±•¹ÍÑ…ÑÕÍ½‘”°¥¹ÍÑ…±±•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€¥¹ÍÑ…±±…Ñ¥½¸É%€ô¥¹ÍÑ…±±•¹©Í½¸ñì¥èÍÑÉ¥¹œôø ¤¹¥ì(€ô¤ì((€¥Ð É…¥Í•ÌÑ¡”±…ÍÐ5…Ì­¥¹%90…¹µÕÍÐÍÝ••À•Ù•Éä½Á•¸Í½ÕÉ”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½µ•…ÍÕÉ•µ•¹Ðµ‰½½­Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èìµ‰…Ñ”è€œÈÀÈØ´Àà´ÀÜœ°­¥¹è€™¥¹…°œô°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ‰½½¬€ôÉ•…Ñ•¹©Í½¸ñ5•…ÍÕÉ•µ•¹Ñ	½½­•Ñ…¥±I•ÍÁ½¹Í”ø ¤¹‰½½¬ì(€€€µˆÉ%€ô‰½½¬¹¥ì(€€€•áÁ•Ð¡‰½½¬¹­¥¹¤¹Ñ½	” ™¥¹…°œ¤ì(€€€•áÁ•Ð¡‰½½¬¹¥Í¥¹…°¤¹Ñ½	”¡ÑÉÕ”¤ì((€€€€¼¼±…¥µ¥¹œ½¹±äÑ¡”¡…±±…¸±•…Ù•ÌÑ¡”¥¹ÍÑ…±±…Ñ¥½¸ÍÑÉ…¹‘•èÑ¡”(€€€€¼¼™¥¹…°ÍÝ••ÀÉ•™ÕÍ•Ì°¹…µ¥¹œ•á…Ñ±äÝ¡…Ð¥Ðµ¥ÍÍ•¸(€€€½¹ÍÐÁ…ÉÑ¥…°€ô…Ý…¥ÐÍ•ÑM½ÕÉ•Ì¡µˆÉ%°l(€€€€€ìÍ½ÕÉ•QåÁ”è€‘•±¥Ù•Éå}¡…±±…¸œ°Í½ÕÉ•%è¡…±±…¸É%ô°(€€€t¤ì(€€€•áÁ•Ð¡Á…ÉÑ¥…°¹ÍÑ…ÑÕÍ½‘”°Á…ÉÑ¥…°¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐÉ•™ÕÍ•€ô…Ý…¥Ð™¥¹…±¥é”¡µˆÉ%¤ì(€€€•áÁ•Ð¡É•™ÕÍ•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€½¹ÍÐ‰½‘ä€ôÉ•™ÕÍ•¹©Í½¸ñì(€€€€€½‘”èÍÑÉ¥¹œì(€€€€€‘•Ñ…¥±Ìèìµ¥ÍÍ•‘M½ÕÉ•ÌèìÍ½ÕÉ•QåÁ”èÍÑÉ¥¹œìÍ½ÕÉ•%èÍÑÉ¥¹œõmtôì(€€€ôø ¤ì(€€€•áÁ•Ð¡‰½‘ä¹½‘”¤¹Ñ½	” 5	}%91}M]A}%9=5A1Qœ¤ì(€€€•áÁ•Ð¡‰½‘ä¹‘•Ñ…¥±Ì¹µ¥ÍÍ•‘M½ÕÉ•Ì¤¹Ñ½!…Ù•1•¹Ñ  Ä¤ì(€€€•áÁ•Ð¡‰½‘ä¹‘•Ñ…¥±Ì¹µ¥ÍÍ•‘M½ÕÉ•ÍlÁt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€Í½ÕÉ•QåÁ”è€¥¹ÍÑ…±±…Ñ¥½¸œ°(€€€€€Í½ÕÉ•%è¥¹ÍÑ…±±…Ñ¥½¸É%°(€€€ô¤ì((€€€½¹ÍÐÍÝ•ÁÐ€ô…Ý…¥ÐÍ•ÑM½ÕÉ•Ì¡µˆÉ%°l(€€€€€ìÍ½ÕÉ•QåÁ”è€‘•±¥Ù•Éå}¡…±±…¸œ°Í½ÕÉ•%è¡…±±…¸É%ô°(€€€€€ìÍ½ÕÉ•QåÁ”è€¥¹ÍÑ…±±…Ñ¥½¸œ°Í½ÕÉ•%è¥¹ÍÑ…±±…Ñ¥½¸É%ô°(€€€t¤ì(€€€•áÁ•Ð¡ÍÝ•ÁÐ¹ÍÑ…ÑÕÍ½‘”°ÍÝ•ÁÐ¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€ô¤ì((€¥Ð ™¥¹…±¥é•Ì5´ÀÈÝ¥Ñ Ñ¡”•á…Ð™¥¹…°µ‰¥±°ÍÑ…”…µ½Õ¹ÑÌœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ™¥¹…±¥é•€ô…Ý…¥Ð™¥¹…±¥é”¡µˆÉ%¤ì(€€€•áÁ•Ð¡™¥¹…±¥é•¹ÍÑ…ÑÕÍ½‘”°™¥¹…±¥é•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐ‘•Ñ…¥°€ô™¥¹…±¥é•¹©Í½¸ñ5•…ÍÕÉ•µ•¹Ñ	½½­•Ñ…¥±I•ÍÁ½¹Í”ø ¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹‰½½¬¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€™¥¹…±¥é•œ°(€€€€€­¥¹è€™¥¹…°œ°(€€€€€¥Í¥¹…°èÑÉÕ”°(€€€€€µ‰9Õµ‰•Èè€‘íÝ½É­½‘•ôµ5´ÀÉ€°(€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€È°(€€€€€Ñ½Ñ…±µ½Õ¹Ðè€œÄÌÜÐÀ¸ÀÀœ°(€€€ô¤ì(€€€•áÁ•Ð¡‘•Ñ…¥°¹±¥¹•Ì¤¹Ñ½!…Ù•1•¹Ñ  Ì¤ì(€€€€¼¼MUAA1d‰É…¹ èÑ¡”™¥¹…°€ÄÀ”™…±±Ì½¸€ÄÀÀ”½˜Ñ¡”1%YI(€€€€¼¼ÅÕ…¹Ñ¥ÑäƒŠP€ÐÀµ½É”ÍÕÁÁ±¥•¹½Ü°€ÄÀÀÉ•±•…Í•™½ÈÑ¡”™¥¹…°‰¥±°¸(€€€•áÁ•Ð¡‘•Ñ…¥°¹±¥¹•ÍlÁt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€¥Ñ•µ9Õµ‰•Èè€œÄœ°(€€€€€‘•±Ñ…MÕÁÁ±¥•è€œÐÀ¸ÀÀÀœ°(€€€€€‘•±Ñ…¥¹…±	¥±°è€œÄÀÀ¸ÀÀÀœ°(€€€€€ÁÉ¥½ÉMÕÁÁ±¥•è€œØÀ¸ÀÀÀœ°(€€€€€…µ½Õ¹ÑMÕÁÁ±äè€œäÀÀÀ¸ÀÀœ°(€€€€€…µ½Õ¹Ñ¥¹…±	¥±°è€œÈÔÀÀ¸ÀÀœ°(€€€€€±¥¹•Q½Ñ…°è€œÄÄÔÀÀ¸ÀÀœ°(€€€ô¤ì(€€€€¼¼Õ±±ä‘•±¥Ù•É•½¸5´ÀÄè¹½Ñ¡¥¹œ‰ÕÐ¥ÑÌ™¥¹…°µ‰¥±°É•Ñ•¹Ñ¥½¸¸(€€€•áÁ•Ð¡‘•Ñ…¥°¹±¥¹•ÍlÅt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€¥Ñ•µ9Õµ‰•Èè€œÈœ°(€€€€€‘•±Ñ…¥¹…±	¥±°è€œÄÀ¸ÀÀÀœ°(€€€€€ÁÉ¥½ÉMÕÁÁ±¥•è€œÄÀ¸ÀÀÀœ°(€€€€€…µ½Õ¹ÑMÕÁÁ±äè€œÀ¸ÀÀœ°(€€€€€…µ½Õ¹Ñ¥¹…±	¥±°è€œÄÈÀÀ¸ÀÀœ°(€€€€€±¥¹•Q½Ñ…°è€œÄÈÀÀ¸ÀÀœ°(€€€ô¤ì(€€€€¼¼AUI}%9MQ11Q%=8‰É…¹ èÑ¡”™¥¹…°€ÈÀ”™…±±Ì½¸Ñ¡”%9MQ11(€€€€¼¼ÅÕ…¹Ñ¥Ñä½¹±ä¸(€€€•áÁ•Ð¡‘•Ñ…¥°¹±¥¹•ÍlÉt¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€¥Ñ•µ9Õµ‰•Èè€œÌœ°(€€€€€‘•±Ñ…%¹ÍÑ…±±•è€œÈ¸ÀÀÀœ°(€€€€€‘•±Ñ…¥¹…±	¥±°è€œÔ¸ÀÀÀœ°(€€€€€ÁÉ¥½É%¹ÍÑ…±±•è€œÌ¸ÀÀÀœ°(€€€€€…µ½Õ¹Ñ%¹ÍÑ…±±…Ñ¥½¸è€œØÐÀ¸ÀÀœ°(€€€€€…µ½Õ¹Ñ¥¹…±	¥±°è€œÐÀÀ¸ÀÀœ°(€€€€€±¥¹•Q½Ñ…°è€œÄÀÐÀ¸ÀÀœ°(€€€ô¤ì(€ô¤ì((€¥Ð Á•Éµ¥ÑÌ¹¼™ÕÉÑ¡•È5½˜9d­¥¹…™Ñ•ÈÑ¡”™¥¹…°½¹”œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐ½¹½Õ¹Ð€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½µ•…ÍÕÉ•µ•¹Ðµ‰½½­Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èìµ‰…Ñ”è€œÈÀÈØ´Àà´Ààœô°(€€€ô¤ì(€€€•áÁ•Ð¡½¹½Õ¹Ð¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡½¹½Õ¹Ð¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” %91}5	}a%MQLœ¤ì((€€€½¹ÍÐÉ•½É€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½µ•…ÍÕÉ•µ•¹Ðµ‰½½­Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€µ‰…Ñ”è€œÈÀÈØ´Àà´Ààœ°(€€€€€€€­¥¹è€É•½Éœ°(€€€€€€€½¹Í¥¹••½¹Ñ…Ñ%è½¹Í¥¹•”Å%°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•½É¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡É•½É¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” %91}5	}a%MQLœ¤ì(€ô¤ì((€¥Ð ¥¹Ù½¥•ÌÑ¡”™¥¹…°5…¹ÍÕ‰µ¥ÑÌ¥Ð½¸Ñ¡”Í…µ”d½Õ¹Ñ•Èœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½Ñ…àµ¥¹Ù½¥•Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€µ•…ÍÕÉ•µ•¹Ñ	½½­%èµˆÉ%°(€€€€€€€¥¹Ù½¥•…Ñ”è€œÈÀÈØ´Àà´ÄÀœ°(€€€€€€€Í…½‘”èM°(€€€€€€€Í•ÉÙ¥••ÍÉ¥ÁÑ¥½¸èMIY%}MI%AQ%=8°(€€€€€€€ÍÑI…Ñ”è€œÄàœ°(€€€€€€€Á±…•=™MÕÁÁ±äè€œÀÜœ°(€€€€€€€É•Ù•ÉÍ•¡…É•ÁÁ±¥…‰±”è™…±Í”°(€€€€€€€‰Õå•É½¹Ñ…Ñ%°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•…Ñ•¹ÍÑ…ÑÕÍ½‘”°É•…Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€½¹ÍÐ¥¹Ù½¥”É%€ôÉ•…Ñ•¹©Í½¸ñQ…á%¹Ù½¥••Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¥¹Ù½¥”¹¥ì((€€€½¹ÍÐÍÕ‰µ¥ÑÑ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ñ…àµ¥¹Ù½¥•Ì¼‘í¥¹Ù½¥”É%‘ô½ÍÕ‰µ¥Ñ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡ÍÕ‰µ¥ÑÑ•¹ÍÑ…ÑÕÍ½‘”°ÍÕ‰µ¥ÑÑ•¹‰½‘ä¤¹Ñ½	” ÈÀÄ¤ì(€€€•áÁ•Ð¡ÍÕ‰µ¥ÑÑ•¹©Í½¸ñQ…á%¹Ù½¥••Ñ…¥±I•ÍÁ½¹Í”ø ¤¹¥¹Ù½¥”¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€ÍÑ…ÑÕÌè€ÍÕ‰µ¥ÑÑ•œ°(€€€€€€¼¼…Á±•ÍÌÝ¥Ñ¡¥¸Ñ¡”™¥¹…¹¥…°å•…Èè€ÀÀÈ™½±±½ÝÌ€ÀÀÄ¸(€€€€€¥¹Ù½¥•9Õµ‰•Èè€@ÄÀÈØÀÀÈœ°(€€€€€Í•ÅÕ•¹•9Õµ‰•Èè€È°(€€€€€™å1…‰•°è€œÈÀÈØ´ÈÜœ°(€€€€€Ñ…á…‰±•Y…±Õ”è€œÄÌÜÐÀ¸ÀÀœ°(€€€€€ÍÑµ½Õ¹Ðè€œÄÈÌØ¸ØÀœ°(€€€€€ÍÍÑµ½Õ¹Ðè€œÄÈÌØ¸ØÀœ°(€€€€€¥ÍÑµ½Õ¹Ðè€œÀ¸ÀÀœ°(€€€€€€¼¼I½Õ¹‘Ì=]8¡•É”°Í¼Ñ¡”‘•±Ñ„¥Ì¹•…Ñ¥Ù”¸(€€€€€É½Õ¹‘=™˜è€œ´À¸ÈÀœ°(€€€€€Ñ½Ñ…±µ½Õ¹Ðè€œÄØÈÄÌ¸ÀÀœ°(€€€ô¤ì((€€€€¼¼Q¡”d½Õ¹Ñ•È…É••ÌÝ¥Ñ Ñ¡”¹Õµ‰•ÉÌ¡…¹‘•½ÕÐ¸(€€€½¹ÍÐ½Õ¹Ñ•ÉÌ€ô…Ý…¥Ð…‘µ¥¸ñì™å}±…‰•°èÍÑÉ¥¹œì¹•áÑ}Ù…±Õ”è¹Õµ‰•Èõmtù€(€€€€€Í•±•Ð™å}±…‰•°°¹•áÑ}Ù…±Õ”™É½´Ñ…á}¥¹Ù½¥•}½Õ¹Ñ•ÉÌ(€€€€€Ý¡•É”½É…¹¥Í…Ñ¥½¹}¥€ô€‘í½É…¹¥Í…Ñ¥½¹%‘ô(€€€€€½É‘•È‰ä™å}±…‰•°(€€€€ì(€€€•áÁ•Ð¡½Õ¹Ñ•ÉÌ¤¹Ñ½ÅÕ…°¡mì™å}±…‰•°è€œÈÀÈØ´ÈÜœ°¹•áÑ}Ù…±Õ”è€Èõt¤ì(€ô¤ì)ô¤ì()‘•ÍÉ¥‰” œàƒŠP½µÁ±•Ñ¥¹œÑ¡”]½É¬œ°€ ¤€ôøì(€¥Ð Ñ¡”É•…‘¥¹•ÍÌ•¹‘Á½¥¹ÐÍ…åÌÉ•…‘ä°…¹½µÁ±•Ñ¥½¸ÍÕ••‘Ìœ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•…‘¥¹•ÍÌ€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€Pœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½½µÁ±•Ñ¥½¸µÉ•…‘¥¹•ÍÍ€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€ô¤ì(€€€•áÁ•Ð¡É•…‘¥¹•ÍÌ¹ÍÑ…ÑÕÍ½‘”°É•…‘¥¹•ÍÌ¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€•áÁ•Ð¡É•…‘¥¹•ÍÌ¹©Í½¸ñ]½É­½µÁ±•Ñ¥½¹I•…‘¥¹•ÍÌø ¤¤¹Ñ½ÅÕ…°¡ì(€€€€€É•…‘äèÑÉÕ”°(€€€€€Õ¹™¥¹¥Í¡•èmt°(€€€€€‰±½­•ÉÌèmt°(€€€ô¤ì((€€€½¹ÍÐ½µÁ±•Ñ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½½µÁ±•Ñ•€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì¹½Ñ”è€±°¥Ñ•µÌ‘•±¥Ù•É•°¥¹ÍÑ…±±•°µ•…ÍÕÉ•°…¹‰¥±±•¸œô°(€€€ô¤ì(€€€•áÁ•Ð¡½µÁ±•Ñ•¹ÍÑ…ÑÕÍ½‘”°½µÁ±•Ñ•¹‰½‘ä¤¹Ñ½	” ÈÀÀ¤ì(€€€½¹ÍÐÝ½É¬€ô½µÁ±•Ñ•¹©Í½¸ñì(€€€€€Ý½É¬èì(€€€€€€€ÍÑ…ÑÕÌèÍÑÉ¥¹œì(€€€€€€€½µÁ±•Ñ•‘ÐèÍÑÉ¥¹œð¹Õ±°ì(€€€€€€€½µÁ±•Ñ¥½¹9½Ñ”èÍÑÉ¥¹œð¹Õ±°ì(€€€€€ôì(€€€ôø ¤¹Ý½É¬ì(€€€•áÁ•Ð¡Ý½É¬¹ÍÑ…ÑÕÌ¤¹Ñ½	” ½µÁ±•Ñ•œ¤ì(€€€•áÁ•Ð¡Ý½É¬¹½µÁ±•Ñ•‘Ð¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡Ý½É¬¹½µÁ±•Ñ¥½¹9½Ñ”¤¹Ñ½	” (€€€€€€±°¥Ñ•µÌ‘•±¥Ù•É•°¥¹ÍÑ…±±•°µ•…ÍÕÉ•°…¹‰¥±±•¸œ°(€€€€¤ì(€ô¤ì((€¥Ð „½µÁ±•Ñ•]½É¬É•™ÕÍ•Ì„¹•Ü‘•±¥Ù•Éä¡…±±…¸œ°…Íå¹Œ€ ¤€ôøì(€€€½¹ÍÐÉ•™ÕÍ•€ô…Ý…¥Ð…ÕÑ¡•¡½Ý¹•È°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€ÕÉ°è€½…Á¤½Ý½É­Ì¼‘íÝ½É­%‘ô½¡…±±…¹Í€°(€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€Á…å±½…èì(€€€€€€€¡…±±…¹…Ñ”è€œÈÀÈØ´Àà´Ààœ°(€€€€€€€ÁÉ•™¥àè€1œ°(€€€€€€€½¹Í¥¹•”èì(€€€€€€€€€¹…µ”èMÈ¸€¡QI¤H€‘íÉÕ¹%‘õ€°(€€€€€€€€€…‘‘É•ÍÌè€¥Ù¥Í¥½¹…°½™™¥”°•±¡¤¥Ù¥Í¥½¸œ°(€€€€€€€ô°(€€€€€€€¥Ñ•µÌèmìÝ½É­%Ñ•µ%è…‰±•%Ñ•µ%°ÅÕ…¹Ñ¥Ñäè€œÄœõt°(€€€€€ô°(€€€ô¤ì(€€€•áÁ•Ð¡É•™ÕÍ•¹ÍÑ…ÑÕÍ½‘”¤¹Ñ½	” ÐÀä¤ì(€€€•áÁ•Ð¡É•™ÕÍ•¹©Í½¸ñì½‘”èÍÑÉ¥¹œôø ¤¹½‘”¤¹Ñ½	” ]=I-}=5A1Qœ¤ì(€ô¤ì)ô¤ì(