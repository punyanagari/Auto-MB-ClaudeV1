import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  NotificationChannelListResponse,
  NotificationConsentListResponse,
  NotificationConsentResponse,
  NotificationMessageListResponse,
  NotificationMessageResponse,
  NotificationTemplateListResponse,
  NotificationTemplateResponse,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, ensureClusterRoles, runMigrations } from '@auto-mb/db';
import { removeOrganisationResidue } from '@auto-mb/db/testing';
import { buildApp } from '../src/app.js';
import type {
  EmailTarget,
  NotificationTransports,
  TemplatedMessage,
  WhatsAppTarget,
} from '../src/notify/transport.js';
import {
  NotificationTransportError,
  verifyMetaSignature,
} from '../src/notify/transport.js';

/**
 * Notifications, end to end (migration 0092).
 *
 * What is proved here, in the order the module's risks run:
 *
 *   1. the happy path on both channels, and the automatic choice between
 *      them — WhatsApp first, email when WhatsApp cannot carry it;
 *   2. THE CONSENT RULE, which is why the caller cannot pass an address:
 *      no opt-in, an opt-out, and an opt-in recorded against a DIFFERENT
 *      address are each refused, by the route and by the trigger;
 *   3. the template lifecycle, including the two sendability rules that
 *      deliberately do not gate each other;
 *   4. the webhook's credential walls, which this suite owes standing
 *      tests for because `route-inventory.integration.test.ts` lists both
 *      webhook addresses as unbound and therefore skips them in its own
 *      401 and 403 sweeps;
 *   5. RECEIPTS ARE FORWARD ONLY and cross no tenant: a late receipt is a
 *      no-op, and one naming another organisation's phone number id moves
 *      nothing;
 *   6. the walls a browser caller meets — role, authority and the other
 *      organisation;
 *   7. the database's own arm, attacked with raw SQL.
 *
 * The WABA is absent, here and in CI, so the transport is the double
 * below — the seam `notify/transport.ts` exists for, and the same posture
 * `whitebooks.test.ts` takes towards the statutory provider.
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
const ownerEmail = `ntf-owner-${runId}@integration.test`;
const officeEmail = `ntf-office-${runId}@integration.test`;
const plainEmail = `ntf-plain-${runId}@integration.test`;
const viewerEmail = `ntf-viewer-${runId}@integration.test`;
const outsiderEmail = `ntf-outsider-${runId}@integration.test`;
const password = `integration-password-${runId}`;

const APP_SECRET = `webhook-app-secret-${'0'.repeat(32)}`;
const VERIFY_TOKEN = `verify-${runId}`;
/** Globally unique: the webhook resolves a tenant by it before any tenant
 * is bound, so two organisations must never share one. */
const phoneNumberId =
  `1${String(randomBytes(6).readUIntBE(0, 6)).padStart(14, '0')}`.slice(0, 15);
const foreignPhoneNumberId =
  `2${String(randomBytes(6).readUIntBE(0, 6)).padStart(14, '0')}`.slice(0, 15);

/** Every call the doubles were asked to make, so a test can assert what
 * reached the wire without the wire existing. */
interface SentCall {
  readonly channel: 'whatsapp' | 'email';
  readonly to: string;
  readonly template: string;
  readonly parameters: readonly string[];
}
const sent: SentCall[] = [];
/** Set by a test that wants the next provider call to fail. Typed as
 * `Error`, not `NotificationTransportError`, because the case that used
 * to strand a row in `queued` forever is a throw that is NOT a transport
 * error at all. */
let nextWhatsAppFailure: Error | null = null;

const transports: NotificationTransports = {
  whatsapp: {
    provider: 'meta_cloud',
    webhookVerifyToken: VERIFY_TOKEN,
    // The REAL implementation, not a hand-rolled one. A double that
    // re-implements a security check with `===` proves the tests pass
    // against a comparison the product does not use — which is the one
    // thing a double must never do.
    verifyWebhookSignature: (rawBody, header) =>
      verifyMetaSignature(APP_SECRET, rawBody, header),
    send(target: WhatsAppTarget, message: TemplatedMessage) {
      if (nextWhatsAppFailure !== null) {
        const failure = nextWhatsAppFailure;
        nextWhatsAppFailure = null;
        return Promise.reject(failure);
      }
      sent.push({
        channel: 'whatsapp',
        to: message.toAddress,
        template: message.templateName,
        parameters: message.parameters,
      });
      return Promise.resolve(`wamid.${target.phoneNumberId}.${String(sent.length)}`);
    },
  },
  email: {
    provider: 'smtp',
    send(_target: EmailTarget, message: TemplatedMessage) {
      sent.push({
        channel: 'email',
        to: message.toAddress,
        template: message.templateName,
        parameters: message.parameters,
      });
      return Promise.resolve(`<mail-${String(sent.length)}@integration.test>`);
    },
  },
};

let admin: Sql;
let app: FastifyInstance;
let organisationId: string;
let outsiderOrganisationId: string;
let contactId: string;
let emailContactId: string;
let outsiderContactId: string;
let approvedTemplateId: string;
let draftTemplateId: string;
let emailOnlyTemplateId: string;

interface CookieJar {
  cookie: string;
}
let owner: CookieJar;
let office: CookieJar;
let plain: CookieJar;
/** A viewer who DOES hold the notifications authority. The whole point of
 * the pairing: a refusal for them proves the ROLE wall ran, because the
 * authority wall cannot be what refused. */
let viewer: CookieJar;
let outsider: CookieJar;

const CONSENTED_PHONE = '+919812345678';
const CONSENTED_EMAIL = 'consignee@railways.example';

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

/** A webhook call, signed the way Meta signs one: HMAC-SHA256 over the
 * exact bytes, with the app secret. */
async function webhook(payload: unknown, options: { signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const signature =
    options.signature === undefined
      ? `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`
      : options.signature;
  return app.inject({
    method: 'POST',
    url: '/api/notifications/webhook',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'x-hub-signature-256': signature }),
    },
  });
}

function statusPayload(
  providerMessageId: string,
  status: string,
  options: { readonly phone?: string; readonly at?: number } = {},
): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '109876543210987',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: options.phone ?? phoneNumberId },
              statuses: [
                {
                  id: providerMessageId,
                  status,
                  timestamp: String(Math.floor((options.at ?? Date.now()) / 1000)),
                  recipient_id: '919812345678',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function send(
  body: Record<string, unknown>,
  jar: CookieJar = owner,
  org: string = organisationId,
) {
  return authed(jar, {
    method: 'POST',
    url: '/api/notifications',
    organisationId: org,
    payload: body,
  });
}

async function log(): Promise<NotificationMessageListResponse> {
  const response = await authed(owner, {
    method: 'GET',
    url: '/api/notifications',
    organisationId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<NotificationMessageListResponse>();
}

async function moveTemplate(templateId: string, status: string, reason?: string) {
  const response = await authed(owner, {
    method: 'POST',
    url: `/api/notification-templates/${templateId}/status`,
    organisationId,
    payload: reason === undefined ? { status } : { status, reason },
  });
  return response;
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 4,
    applicationName: 'auto-mb-notify-admin',
  });
  await admin`select 1 as ready`;
  await ensureClusterRoles(admin, appPassword);
  await runMigrations(admin, migrationsDirectory);

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl: 'http://127.0.0.1:3000',
    notificationTransports: transports,
  });

  owner = await signUp(ownerEmail, 'Notify Owner');
  office = await signUp(officeEmail, 'Notify Office');
  plain = await signUp(plainEmail, 'Notify Plain');
  viewer = await signUp(viewerEmail, 'Notify Viewer');
  outsider = await signUp(outsiderEmail, 'Notify Outsider');

  const created = await authed(owner, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Notify Constructions', slug: `ntf-org-${runId}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  organisationId = created.json<{ id: string }>().id;

  const foreign = await authed(outsider, {
    method: 'POST',
    url: '/api/organisations',
    payload: { name: 'Notify Outsiders', slug: `ntf-out-${runId}` },
  });
  expect(foreign.statusCode, foreign.body).toBe(201);
  outsiderOrganisationId = foreign.json<{ id: string }>().id;

  for (const [email, role] of [
    [officeEmail, 'office'],
    [plainEmail, 'office'],
    [viewerEmail, 'viewer'],
  ] as const) {
    const added = await authed(owner, {
      method: 'POST',
      url: '/api/organisations/current/members',
      organisationId,
      payload: { email, role },
    });
    expect(added.statusCode, added.body).toBe(201);
  }
  // The office member holds the notifications authority; the plain member
  // is given `can_issue_documents` and NOT the notifications authority, so
  // a refusal there proves the new authority is doing the work rather than
  // `issue` standing in for it.
  await admin`
    update organisation_memberships set can_manage_notifications = true
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${officeEmail})
  `;
  await admin`
    update organisation_memberships set can_issue_documents = true
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${plainEmail})
  `;
  await admin`
    update organisation_memberships set can_manage_notifications = true
    where organisation_id = ${organisationId}
      and user_id in (select "id" from auth_users where "email" = ${viewerEmail})
  `;

  for (const [org, jar, designation] of [
    [organisationId, owner, 'Sr. DEE (G) CR Nagpur'],
    [organisationId, owner, 'Dy. CME Ajni'],
    [outsiderOrganisationId, outsider, 'Foreign consignee'],
  ] as const) {
    const response = await authed(jar, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId: org,
      payload: { designation, isConsignee: true },
    });
    expect(response.statusCode, response.body).toBe(201);
    const { id } = response.json<{ id: string }>();
    if (org === outsiderOrganisationId) outsiderContactId = id;
    else if (designation.startsWith('Sr.')) contactId = id;
    else emailContactId = id;
  }

  // Both channels configured and switched on.
  for (const [channel, body] of [
    [
      'whatsapp',
      {
        enabled: true,
        wabaPhoneNumberId: phoneNumberId,
        wabaBusinessAccountId: '109876543210987',
        displayPhoneNumber: '+919000000001',
      },
    ],
    ['email', { enabled: true, fromAddress: 'no-reply@notify.example' }],
  ] as const) {
    const response = await authed(owner, {
      method: 'PUT',
      url: `/api/notification-channels/${channel}`,
      organisationId,
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  // The other organisation gets a WhatsApp channel too, so the
  // cross-tenant receipt test has a real second phone number id to aim at.
  const foreignChannel = await authed(outsider, {
    method: 'PUT',
    url: '/api/notification-channels/whatsapp',
    organisationId: outsiderOrganisationId,
    payload: {
      enabled: true,
      wabaPhoneNumberId: foreignPhoneNumberId,
      wabaBusinessAccountId: '209876543210987',
      displayPhoneNumber: '+919000000002',
    },
  });
  expect(foreignChannel.statusCode, foreignChannel.body).toBe(200);

  for (const [name, body, subject] of [
    [
      'challan_issued',
      'Challan {{1}} for work {{2}} has been issued.',
      'Challan issued',
    ],
    ['draft_note', 'Nothing has happened yet.', undefined],
    ['email_only', 'A note about {{1}}.', 'A note'],
  ] as const) {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/notification-templates',
      organisationId,
      payload: {
        name,
        language: 'en',
        category: 'utility',
        bodyText: body,
        ...(subject === undefined ? {} : { emailSubject: subject }),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const { template } = response.json<NotificationTemplateResponse>();
    if (name === 'challan_issued') approvedTemplateId = template.id;
    else if (name === 'draft_note') draftTemplateId = template.id;
    else emailOnlyTemplateId = template.id;
  }
  // Only the first walks Meta's lifecycle to approved. `email_only` stays
  // a draft ON PURPOSE: it is the negative control for the rule that a
  // subject line makes a template sendable by email without Meta's
  // approval.
  expect((await moveTemplate(approvedTemplateId, 'pending')).statusCode).toBe(200);
  expect((await moveTemplate(approvedTemplateId, 'approved')).statusCode).toBe(200);

  for (const [contact, channel, address] of [
    [contactId, 'whatsapp', CONSENTED_PHONE],
    [emailContactId, 'email', CONSENTED_EMAIL],
  ] as const) {
    const response = await authed(owner, {
      method: 'PUT',
      url: '/api/notification-consents',
      organisationId,
      payload: {
        contactId: contact,
        channel,
        address,
        state: 'opted_in',
        evidence: 'Signed the delivery acknowledgement on 12 Aug 2026',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  }
}, 180_000);

afterAll(async () => {
  await removeOrganisationResidue(admin, [organisationId, outsiderOrganisationId]);
  await admin`
    delete from identity_audit_events where user_id in (
      select "id" from auth_users where "email" like ${`%-${runId}@integration.test`}
    )
  `;
  await admin`
    delete from auth_users where "email" like ${`%-${runId}@integration.test`}
  `;
  await app?.close();
  await admin?.end();
}, 180_000);

describe('sending', () => {
  it('sends over WhatsApp and logs the whole ledger row', async () => {
    const before = sent.length;
    const response = await send({
      templateId: approvedTemplateId,
      contactId,
      parameters: ['DC/2026/0042', 'WR-BCT-2026'],
    });
    expect(response.statusCode, response.body).toBe(201);
    const { message } = response.json<NotificationMessageResponse>();
    expect(message.channel).toBe('whatsapp');
    expect(message.status).toBe('sent');
    expect(message.provider).toBe('meta_cloud');
    expect(message.providerMessageId).not.toBeNull();
    // The ADDRESS came from the consent record, not from the caller —
    // which is the whole rule, and the reason the request body has no
    // address field to send.
    expect(message.toAddress).toBe(CONSENTED_PHONE);
    expect(message.parameters).toEqual(['DC/2026/0042', 'WR-BCT-2026']);
    expect(sent.slice(before)).toEqual([
      {
        channel: 'whatsapp',
        to: CONSENTED_PHONE,
        template: 'challan_issued',
        parameters: ['DC/2026/0042', 'WR-BCT-2026'],
      },
    ]);
  });

  it('falls back to email when the contact consented there and not on WhatsApp', async () => {
    // No channel named: the send path picks. This contact has an email
    // opt-in and no WhatsApp one, so WhatsApp is unusable and email is
    // chosen — which is the behaviour the later document-delivery and
    // MSME packs are built on.
    const before = sent.length;
    const response = await send({
      templateId: approvedTemplateId,
      contactId: emailContactId,
      parameters: ['DC/2026/0043', 'WR-BCT-2026'],
    });
    expect(response.statusCode, response.body).toBe(201);
    const { message } = response.json<NotificationMessageResponse>();
    expect(message.channel).toBe('email');
    expect(message.provider).toBe('smtp');
    expect(message.toAddress).toBe(CONSENTED_EMAIL);
    expect(sent.slice(before).map((call) => call.channel)).toEqual(['email']);
  });

  it('records a provider refusal on the log and answers 502', async () => {
    nextWhatsAppFailure = new NotificationTransportError(
      '131047',
      'Re-engagement message',
      400,
    );
    const response = await send({
      templateId: approvedTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: ['DC/2026/0044', 'WR-BCT-2026'],
    });
    expect(response.statusCode, response.body).toBe(502);
    expect(response.json<{ code: string }>().code).toBe('NOTIFICATION_SEND_FAILED');
    // The attempt is ON THE RECORD, which is why the row is written
    // before the provider is called rather than after it answers.
    const { messages } = await log();
    const failed = messages.find((message) => message.status === 'failed');
    expect(failed?.failureCode).toBe('131047');
    expect(failed?.failedAt).not.toBeNull();
    expect(failed?.providerMessageId).toBeNull();
  });
});

describe('every outcome reaches the ledger', () => {
  it('records a NON-transport throw as failed rather than leaving the row queued', async () => {
    // The case that used to strand a row forever: the outcome shape
    // requires a queued row to carry a NULL provider message id, and a
    // receipt is looked up BY that id — so nothing could ever rescue it.
    nextWhatsAppFailure = new Error('a bug in this server, not a refusal');
    const response = await send({
      templateId: approvedTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: ['DC/2026/0600', 'WR-BCT-2026'],
    });
    expect(response.statusCode, response.body).toBe(502);
    const { messages } = await log();
    const stranded = messages.filter((message) => message.status === 'queued');
    expect(stranded, 'no notification may be left queued').toEqual([]);
    expect(messages[0]?.status).toBe('failed');
    expect(messages[0]?.failureCode).toBe('transport_error');
  });

  it('carries the provider’s own retryable classification onto the log', async () => {
    nextWhatsAppFailure = new NotificationTransportError(
      '130429',
      'Rate limit hit',
      429,
      true,
    );
    const response = await send({
      templateId: approvedTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: ['DC/2026/0601', 'WR-BCT-2026'],
    });
    expect(response.statusCode, response.body).toBe(502);
    // The refusal says so, because "try again" and "never try again" are
    // different instructions and the provider is the one that knows.
    expect(response.json<{ message: string }>().message).toMatch(/temporary/i);
    const { messages } = await log();
    expect(messages[0]?.failureCode).toBe('130429');
    expect(messages[0]?.failureDetail).toContain('retryable');
  });
});

describe('consent is the gate, and it is per address', () => {
  it('refuses a contact who never opted in', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: { designation: `Unconsented office ${runId}`, isConsignee: true },
    });
    expect(response.statusCode, response.body).toBe(201);
    const stranger = response.json<{ id: string }>().id;
    const refusal = await send({
      templateId: approvedTemplateId,
      contactId: stranger,
      parameters: ['DC/2026/0045', 'WR-BCT-2026'],
    });
    expect(refusal.statusCode, refusal.body).toBe(409);
    expect(refusal.json<{ code: string }>().code).toBe('NOTIFICATION_CONSENT_MISSING');
  });

  it('refuses after an opt-out and sends again after a fresh opt-in', async () => {
    const optOut = await authed(owner, {
      method: 'PUT',
      url: '/api/notification-consents',
      organisationId,
      payload: {
        contactId,
        channel: 'whatsapp',
        address: CONSENTED_PHONE,
        state: 'opted_out',
        evidence: 'Asked to stop on the site call of 14 Aug 2026',
      },
    });
    expect(optOut.statusCode, optOut.body).toBe(200);
    const refusal = await send({
      templateId: approvedTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: ['DC/2026/0046', 'WR-BCT-2026'],
    });
    expect(refusal.statusCode, refusal.body).toBe(409);
    expect(refusal.json<{ code: string }>().code).toBe('NOTIFICATION_CONSENT_MISSING');

    const optIn = await authed(owner, {
      method: 'PUT',
      url: '/api/notification-consents',
      organisationId,
      payload: {
        contactId,
        channel: 'whatsapp',
        address: CONSENTED_PHONE,
        state: 'opted_in',
        evidence: 'Asked to resume on 15 Aug 2026',
      },
    });
    expect(optIn.statusCode, optIn.body).toBe(200);
    const allowed = await send({
      templateId: approvedTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: ['DC/2026/0047', 'WR-BCT-2026'],
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it('refuses at the DATABASE when the consent is for a different address', async () => {
    // The route reads the consent and copies its address, so it can never
    // produce this row. Raw SQL is the only way to reach the guard, which
    // is the point of the two-layer rule: the arm that holds when a
    // writer arrives another way.
    await expect(
      admin`
        insert into notification_messages (
          organisation_id, channel, template_id, contact_id, to_address,
          parameters, provider, requested_by_user_id
        )
        values (
          ${organisationId}, 'whatsapp', ${approvedTemplateId}, ${contactId},
          '+919999999999', ${admin.json([
            'DC/2026/0048',
            'WR-BCT-2026',
          ] as never)}, 'meta_cloud',
          (select "id" from auth_users where "email" = ${ownerEmail})
        )
      `,
    ).rejects.toMatchObject({ code: '23K07' });
  });
});

describe('template lifecycle', () => {
  it('refuses a WhatsApp send from a template Meta has not approved', async () => {
    const response = await send({
      templateId: draftTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: [],
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
    );
  });

  it('sends an unapproved template by EMAIL, because the two rules do not gate each other', async () => {
    // `email_only` is a draft at Meta and has a subject line. An
    // organisation with no WABA at all must still be able to send mail,
    // which is exactly what this proves.
    const response = await send({
      templateId: emailOnlyTemplateId,
      contactId: emailContactId,
      channel: 'email',
      parameters: ['the August bill'],
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<NotificationMessageResponse>().message.channel).toBe('email');
  });

  it('refuses a WhatsApp send whose parameter count does not match the body', async () => {
    const response = await send({
      templateId: approvedTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: ['only one'],
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
    );
  });

  it('counts the parameters from the body rather than trusting a caller', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/notification-templates',
      organisationId,
      payload: {
        name: `counted_${runId}`,
        language: 'en',
        category: 'utility',
        // Deliberately skips {{2}}: Meta's components array is
        // positional, so the highest index is the count.
        bodyText: 'Bill {{1}} settled on {{3}}.',
        emailSubject: 'Bill settled',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<NotificationTemplateResponse>().template.parameterCount).toBe(
      3,
    );
  });

  it('walks Meta’s lifecycle forwards only, and never resubmits a rejection', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/notification-templates',
      organisationId,
      payload: {
        name: `lifecycle_${runId}`,
        language: 'en',
        category: 'utility',
        bodyText: 'A template about to be refused.',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { template } = created.json<NotificationTemplateResponse>();

    // A reason belongs to a decision Meta made.
    const early = await moveTemplate(template.id, 'pending', 'no reason yet');
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json<{ code: string }>().code).toBe('NOTIFICATION_TEMPLATE_STATE');

    expect((await moveTemplate(template.id, 'pending')).statusCode).toBe(200);
    const rejected = await moveTemplate(
      template.id,
      'rejected',
      'Template content violates policy',
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json<NotificationTemplateResponse>().template.statusReason).toBe(
      'Template content violates policy',
    );

    // A rejected template is RESUBMITTED, which is Meta's own remedy for
    // a rejection and what an appeal looks like from this register. An
    // earlier draft made `rejected` terminal, which was wrong twice: the
    // console will show the move, and `(organisation_id, name, language)`
    // is unique with no DELETE, so a dead end burned the name forever.
    const resubmit = await moveTemplate(template.id, 'pending');
    expect(resubmit.statusCode, resubmit.body).toBe(200);
    expect(resubmit.json<NotificationTemplateResponse>().template.status).toBe(
      'pending',
    );
    // …and the appeal lands.
    const approved = await moveTemplate(template.id, 'approved');
    expect(approved.statusCode, approved.body).toBe(200);
    expect(
      approved.json<NotificationTemplateResponse>().template.statusReason,
    ).toBeNull();
  });

  it('retires a draft nobody submitted, without burning its name', async () => {
    const created = await authed(owner, {
      method: 'POST',
      url: '/api/notification-templates',
      organisationId,
      payload: {
        name: `retired_${runId}`,
        language: 'en',
        category: 'utility',
        bodyText: 'Written by mistake.',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { template } = created.json<NotificationTemplateResponse>();
    const retired = await moveTemplate(template.id, 'disabled', 'Written by mistake');
    expect(retired.statusCode, retired.body).toBe(200);
    // Terminal, and it stays terminal: Meta withdrew it, and getting it
    // back is a new template.
    const revive = await moveTemplate(template.id, 'pending');
    expect(revive.statusCode, revive.body).toBe(409);
    expect(revive.json<{ code: string }>().code).toBe('NOTIFICATION_TEMPLATE_STATE');
  });

  it('refuses a body asking for more parameters than a template may take', async () => {
    // The column's CHECK caps this at 20; without the route's own refusal
    // it surfaced as a bare 23514, which an operator reads as a 500.
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/notification-templates',
      organisationId,
      payload: {
        name: `too_many_${runId}`,
        language: 'en',
        category: 'utility',
        bodyText: 'Values {{1}} and {{99}}.',
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe(
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
    );
  });

  it('refuses a second template with the same name and language', async () => {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/notification-templates',
      organisationId,
      payload: {
        name: 'challan_issued',
        language: 'en',
        category: 'utility',
        bodyText: 'A duplicate.',
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('NOTIFICATION_TEMPLATE_EXISTS');
  });
});

describe('channel configuration', () => {
  it('refuses to enable a half-configured channel, at the route and at the trigger', async () => {
    const route = await authed(owner, {
      method: 'PUT',
      url: '/api/notification-channels/email',
      organisationId,
      payload: { enabled: true },
    });
    expect(route.statusCode, route.body).toBe(409);
    expect(route.json<{ code: string }>().code).toBe('NOTIFICATION_CHANNEL_INCOMPLETE');

    await expect(
      admin`
        update notification_channels
        set enabled = true, from_address = null
        where organisation_id = ${organisationId} and channel = 'email'
      `,
    ).rejects.toMatchObject({ code: '23K02' });
  });

  it('refuses a phone number id another organisation already holds, without saying so', async () => {
    // The index is cluster-wide by necessity: Meta's webhook resolves a
    // tenant by this value before any tenant is bound. So one
    // organisation CAN type another's — the number is semi-public — and
    // before this refusal existed that was an unmapped 500, which both
    // blocked the true owner with no remedy and told the typist that the
    // number was registered somewhere.
    const response = await authed(outsider, {
      method: 'PUT',
      url: '/api/notification-channels/whatsapp',
      organisationId: outsiderOrganisationId,
      payload: { enabled: false, wabaPhoneNumberId: phoneNumberId },
    });
    expect(response.statusCode, response.body).toBe(409);
    const refusal = response.json<{ code: string; message: string; remedy?: string }>();
    expect(refusal.code).toBe('NOTIFICATION_CHANNEL_NUMBER_TAKEN');
    // Non-oracular: it must not name the holder, nor confirm there is one.
    expect(`${refusal.message} ${refusal.remedy ?? ''}`).not.toContain(
      'Notify Constructions',
    );
    expect(refusal.message).not.toMatch(/another organisation|already registered by/i);
  });

  it('reports whether the DEPLOYMENT can send, not only whether the organisation is set up', async () => {
    const response = await authed(owner, {
      method: 'GET',
      url: '/api/notification-channels',
      organisationId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const { channels } = response.json<NotificationChannelListResponse>();
    expect(channels.map((row) => row.channel).sort()).toEqual(['email', 'whatsapp']);
    for (const row of channels) expect(row.transportConfigured).toBe(true);
    // And no credential is on the wire, because none is in the schema.
    expect(JSON.stringify(channels)).not.toContain(APP_SECRET);
  });
});

describe('the webhook', () => {
  async function sendAndCapture(): Promise<string> {
    const response = await send({
      templateId: approvedTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: ['DC/2026/0100', 'WR-BCT-2026'],
    });
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json<NotificationMessageResponse>().message.providerMessageId;
    if (id === null) throw new Error('the send recorded no provider message id');
    return id;
  }

  async function statusOf(providerMessageId: string): Promise<string> {
    const [row] = await admin<{ status: string }[]>`
      select status from notification_messages
      where provider_message_id = ${providerMessageId}
    `;
    return row?.status ?? 'missing';
  }

  it('refuses an unsigned body, a malformed signature and a wrong secret', async () => {
    const providerMessageId = await sendAndCapture();
    const payload = statusPayload(providerMessageId, 'delivered');
    const raw = JSON.stringify(payload);

    for (const signature of [
      null,
      'not-a-signature',
      'sha256=short',
      `sha256=${createHmac('sha256', 'the-wrong-secret').update(raw).digest('hex')}`,
    ]) {
      const response = await webhook(payload, { signature });
      expect(response.statusCode, String(signature)).toBe(401);
      expect(response.json<{ code: string }>().code).toBe(
        'NOTIFICATION_WEBHOOK_UNVERIFIED',
      );
    }
    // …and nothing was recorded from any of them.
    expect(await statusOf(providerMessageId)).toBe('sent');
  });

  it('applies a signed receipt and answers 200', async () => {
    const providerMessageId = await sendAndCapture();
    const response = await webhook(statusPayload(providerMessageId, 'delivered'));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ applied: number }>().applied).toBe(1);
    expect(await statusOf(providerMessageId)).toBe('delivered');

    const read = await webhook(statusPayload(providerMessageId, 'read'));
    expect(read.statusCode).toBe(200);
    expect(await statusOf(providerMessageId)).toBe('read');
  });

  it('treats a late or duplicate receipt as a no-op, still answering 200', async () => {
    const providerMessageId = await sendAndCapture();
    expect((await webhook(statusPayload(providerMessageId, 'read'))).statusCode).toBe(
      200,
    );
    // `delivered` arriving after `read` is routine at Meta, and a non-200
    // would make Meta redeliver the batch forever.
    const late = await webhook(statusPayload(providerMessageId, 'delivered'));
    expect(late.statusCode).toBe(200);
    expect(late.json<{ applied: number }>().applied).toBe(0);
    expect(await statusOf(providerMessageId)).toBe('read');
  });

  it('moves nothing when the receipt names another organisation’s number', async () => {
    // THE TENANCY PROPERTY. The receipt arrives on an organisation this
    // cluster does know — it owns `foreignPhoneNumberId` — but names a
    // message belonging to somebody else. Scoping the lookup by BOTH the
    // phone number id and the message id is what makes that a miss
    // instead of a cross-tenant write.
    const providerMessageId = await sendAndCapture();
    const response = await webhook(
      statusPayload(providerMessageId, 'delivered', { phone: foreignPhoneNumberId }),
    );
    expect(response.json<{ applied: number }>().applied).toBe(0);
    expect(await statusOf(providerMessageId)).toBe('sent');
    // It reads as `missing` — that organisation has no such message — so
    // the receiver asks for a redelivery, which will miss identically.
    // Meta's own retry schedule is what bounds it; the alternative is
    // answering 200 to the race this status exists to catch.
    expect(response.statusCode).toBe(503);
  });

  it('answers 200, and never asks again, for a number no organisation here owns', async () => {
    // Another deployment sharing the same Meta app. It will never become
    // ours, so a retry would be a redelivery loop with no end.
    const response = await webhook(
      statusPayload(`wamid.SOMEBODYELSE.${runId}`, 'delivered', {
        phone: '999999999999999',
      }),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ applied: number }>().applied).toBe(0);
  });

  it('asks Meta to redeliver a receipt whose message row it cannot see yet', async () => {
    // The race the two-phase send opens: the provider has answered and
    // the completion transaction has not committed, so the receipt
    // arrives before the row carries its id. Answering 200 there loses
    // the delivery timestamp permanently, because Meta never sends it
    // again — so the receiver asks for a redelivery instead.
    const response = await webhook(
      statusPayload(`wamid.NOTYETCOMMITTED.${runId}`, 'delivered'),
    );
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json<{ applied: number; missing: number }>()).toMatchObject({
      applied: 0,
      missing: 1,
    });
  });

  it('applies the rest of a batch even when one entry is unusable', async () => {
    // A timestamp past the Date range used to build an Invalid Date whose
    // toISOString() threw, and the throw escaped the whole handler — so
    // one malformed entry 500ed a batch of forty and Meta redelivered
    // that same batch forever.
    const providerMessageId = await sendAndCapture();
    const payload = statusPayload(providerMessageId, 'delivered');
    const entry = (
      payload as { entry: { changes: { value: { statuses: unknown[] } }[] }[] }
    ).entry[0];
    entry?.changes[0]?.value.statuses.unshift({
      id: `wamid.BADCLOCK.${runId}`,
      status: 'read',
      timestamp: '999999999999999999',
    });
    const response = await webhook(payload);
    // The good receipt landed; the bad one was treated as a receipt for a
    // row that does not exist, which is what it is.
    expect([200, 503]).toContain(response.statusCode);
    expect(response.json<{ applied: number }>().applied).toBe(1);
    expect(await statusOf(providerMessageId)).toBe('delivered');
  });

  it('ignores an inbound reply that is not an opt-out, and anything it does not recognise', async () => {
    // Meta packs replies into the same body. Only one of them has a
    // meaning here — the opt-out of the owner ruling of 2026-08-19, which
    // `describe('an inbound STOP')` below proves. Everything else is
    // dropped: this product has no inbox, and a reply nobody can read is
    // not a reply it should pretend to have received.
    const response = await webhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: phoneNumberId },
                messages: [
                  { from: '919812345678', text: { body: 'Received, thank you' } },
                  { from: '919812345678', type: 'image', image: { id: 'media-1' } },
                  { nothing: 'that this receiver models' },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ applied: number; revoked: number }>()).toMatchObject({
      applied: 0,
      revoked: 0,
    });
    const [consent] = await admin<{ state: string }[]>`
      select state from notification_consents
      where organisation_id = ${organisationId} and contact_id = ${contactId}
        and channel = 'whatsapp'
    `;
    expect(consent?.state).toBe('opted_in');
  });

  it('echoes the subscription challenge only when the verify token matches', async () => {
    const good = await app.inject({
      method: 'GET',
      url: `/api/notifications/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1234567890`,
    });
    expect(good.statusCode, good.body).toBe(200);
    expect(good.body).toBe('1234567890');

    for (const query of [
      // Same length as the real token, so a comparison that returned
      // early on the first differing byte would still refuse — the point
      // is that it refuses without telling anyone WHERE it differs.
      `hub.mode=subscribe&hub.verify_token=${'x'.repeat(VERIFY_TOKEN.length)}&hub.challenge=1234567890`,
      'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234567890',
      `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1234567890`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/notifications/webhook?${query}`,
      });
      expect(response.statusCode, query).toBe(403);
    }
  });
});

/**
 * The owner ruling of 2026-08-19: "inbound STOP auto-revokes and audits".
 *
 * Migration 0092 left the `messages` array unread and said why — what a
 * reply of STOP does to a consent row was an owner's rule to state.
 * Migration 0104 states it, and these are the three properties that
 * matter: a STOP revokes and leaves a trail, an ordinary reply changes
 * nothing, and an address this organisation never opted in is a no-op
 * rather than a retry.
 */
describe('an inbound STOP', () => {
  function inboundPayload(
    body: unknown,
    options: { readonly from?: string; readonly phone?: string } = {},
  ): unknown {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '109876543210987',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: options.phone ?? phoneNumberId },
                messages: [
                  {
                    // Meta sends the sender WITHOUT a leading plus, which
                    // is the normalisation this path has to get right:
                    // the consent row stores one.
                    from: options.from ?? '919812345678',
                    id: `wamid.inbound-${randomBytes(4).toString('hex')}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  async function consentState(contact: string): Promise<string | undefined> {
    const [row] = await admin<{ state: string }[]>`
      select state from notification_consents
      where organisation_id = ${organisationId}
        and contact_id = ${contact} and channel = 'whatsapp'
    `;
    return row?.state;
  }

  async function reinstate(contact: string, address: string): Promise<void> {
    const response = await authed(owner, {
      method: 'PUT',
      url: '/api/notification-consents',
      organisationId,
      payload: {
        contactId: contact,
        channel: 'whatsapp',
        address,
        state: 'opted_in',
        evidence: 'Reinstated by the office after the automated revocation',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  it('revokes the consent on that address and audits it with no actor', async () => {
    expect(await consentState(contactId)).toBe('opted_in');

    const response = await webhook(inboundPayload('STOP'));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ revoked: number }>().revoked).toBe(1);

    expect(await consentState(contactId)).toBe('opted_out');

    // The trail. `actor_user_id` is NULL because no member did this — the
    // recipient did, and the recipient is not a user of this product.
    const [event] = await admin<
      { actor_user_id: string | null; details: { reason?: string } }[]
    >`
      select actor_user_id, details from audit_events
      where organisation_id = ${organisationId}
        and action = 'notification_consent.revoked'
      order by occurred_at desc limit 1
    `;
    expect(event?.actor_user_id).toBeNull();
    expect(event?.details.reason).toBe('inbound stop');

    // And the evidence on the row says how it happened, because that is
    // the column the register prints.
    const [consent] = await admin<{ evidence: string }[]>`
      select evidence from notification_consents
      where organisation_id = ${organisationId} and contact_id = ${contactId}
        and channel = 'whatsapp'
    `;
    expect(consent?.evidence).toContain('Inbound STOP');

    // The send path is the point of all of it.
    const refused = await send({
      contactId,
      channel: 'whatsapp',
      templateId: approvedTemplateId,
      parameters: ['DC-2026-0001'],
    });
    expect(refused.statusCode, refused.body).toBe(409);

    await reinstate(contactId, CONSENTED_PHONE);
  });

  it('honours UNSUBSCRIBE and a tapped opt-out button, and ignores an ordinary reply', async () => {
    for (const body of ['unsubscribe', 'Stop.', ' STOP ']) {
      const response = await webhook(inboundPayload(body));
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ revoked: number }>().revoked, String(body)).toBe(1);
      expect(await consentState(contactId)).toBe('opted_out');
      await reinstate(contactId, CONSENTED_PHONE);
    }

    // The button Meta sends INSTEAD of a text message when the recipient
    // taps a template's own opt-out control.
    const tapped = await webhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '109876543210987',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: phoneNumberId },
                messages: [
                  {
                    from: '919812345678',
                    id: 'wamid.button-stop',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'button',
                    button: { text: 'Stop promotions', payload: 'STOP' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(tapped.statusCode, tapped.body).toBe(200);
    expect(tapped.json<{ revoked: number }>().revoked).toBe(1);
    await reinstate(contactId, CONSENTED_PHONE);

    // AND AN ORDINARY REPLY CHANGES NOTHING. Substring matching on a
    // legal act is how a product opts somebody out for using a common
    // English verb, so these are all no-ops.
    for (const body of [
      'please don’t stop sending these',
      'STOPPED WORK ON SITE',
      'thanks',
      '',
    ]) {
      const response = await webhook(inboundPayload(body));
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ revoked: number }>().revoked, String(body)).toBe(0);
    }
    expect(await consentState(contactId)).toBe('opted_in');
  });

  it('is a no-op and a 200 for an address nobody opted in', async () => {
    // FAIL-SAFE. There is nothing to revoke, and a non-200 would make
    // Meta redeliver a message it delivered correctly, forever.
    const unknown = await webhook(inboundPayload('STOP', { from: '919000000009' }));
    expect(unknown.statusCode, unknown.body).toBe(200);
    expect(unknown.json<{ revoked: number }>().revoked).toBe(0);

    // And a number belonging to another deployment sharing the Meta app
    // resolves to no organisation at all.
    const foreign = await webhook(
      inboundPayload('STOP', { phone: 'phone-number-id-not-ours' }),
    );
    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json<{ revoked: number }>().revoked).toBe(0);

    expect(await consentState(contactId)).toBe('opted_in');
  });
});

/**
 * The employee half of the same ruling: "Employees: consent
 * auto-recorded at onboarding (mandatory by policy, still a visible
 * register row)."
 */
describe('recording consent for staff', () => {
  async function addStaff(designation: string, phone: string): Promise<string> {
    const response = await authed(owner, {
      method: 'POST',
      url: '/api/masters/contacts',
      organisationId,
      payload: { designation, isEmployee: true, phone },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  it('records the staff who have a usable address and reports the rest', async () => {
    const withNumber = await addStaff(`Fitter ${runId}`, '+919812340001');
    // Not in international form, so the consent table's address CHECK
    // would refuse it.
    await addStaff(`Storekeeper ${runId}`, '9812340002');

    const response = await authed(owner, {
      method: 'POST',
      url: '/api/notification-consents/staff',
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { channel: 'whatsapp' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{
      recorded: number;
      alreadyRecorded: number;
      withoutAddress: number;
    }>();
    expect(result.recorded).toBeGreaterThanOrEqual(1);
    // The one whose number is not in international form is REPORTED, not
    // skipped silently and not allowed to fail the whole act with a
    // 23514 from the address CHECK.
    expect(result.withoutAddress).toBeGreaterThanOrEqual(1);

    const [recorded] = await admin<{ state: string; evidence: string }[]>`
      select state, evidence from notification_consents
      where organisation_id = ${organisationId}
        and contact_id = ${withNumber} and channel = 'whatsapp'
    `;
    expect(recorded?.state).toBe('opted_in');
    expect(recorded?.evidence).toContain('Employment onboarding');

    const [event] = await admin<{ details: { source?: string } }[]>`
      select details from audit_events
      where organisation_id = ${organisationId}
        and action = 'notification_consent.recorded'
        and details->>'source' = 'employment onboarding'
      order by occurred_at desc limit 1
    `;
    expect(event?.details.source).toBe('employment onboarding');

    // A SECOND RUN WRITES NOTHING. The act never overwrites an existing
    // consent, which is what keeps somebody who texted STOP opted out.
    const again = await authed(owner, {
      method: 'POST',
      url: '/api/notification-consents/staff',
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { channel: 'whatsapp' },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<{ recorded: number }>().recorded).toBe(0);
    expect(again.json<{ alreadyRecorded: number }>().alreadyRecorded).toBe(
      result.recorded + result.alreadyRecorded,
    );
  });

  it('never re-opts in a member of staff who opted out', async () => {
    const staff = await addStaff(`Welder ${runId}`, '+919812340003');
    const optedOut = await authed(owner, {
      method: 'PUT',
      url: '/api/notification-consents',
      organisationId,
      payload: {
        contactId: staff,
        channel: 'whatsapp',
        address: '+919812340003',
        state: 'opted_out',
        evidence: 'Asked not to be messaged at the depot gate',
      },
    });
    expect(optedOut.statusCode, optedOut.body).toBe(200);

    const response = await authed(owner, {
      method: 'POST',
      url: '/api/notification-consents/staff',
      organisationId,
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { channel: 'whatsapp' },
    });
    expect(response.statusCode, response.body).toBe(200);

    const [row] = await admin<{ state: string }[]>`
      select state from notification_consents
      where organisation_id = ${organisationId}
        and contact_id = ${staff} and channel = 'whatsapp'
    `;
    expect(row?.state).toBe('opted_out');
  });
});

describe('the walls', () => {
  it('refuses a member without the notifications authority', async () => {
    for (const [method, url] of [
      ['GET', '/api/notification-channels'],
      ['GET', '/api/notification-templates'],
      ['GET', '/api/notification-consents'],
      ['GET', '/api/notifications'],
    ] as const) {
      const response = await authed(plain, { method, url, organisationId });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
    }
  });

  it('refuses a SEND without the authority, before the provider is called', async () => {
    // The send opens its own bound transactions rather than running
    // inside the route's, so the registrar's guard does not cover it and
    // the act carries its own `authorise` hook. This is the standing
    // proof of that: nothing reaches the transport double, and no row
    // reaches the log.
    const before = sent.length;
    const response = await send(
      {
        templateId: approvedTemplateId,
        contactId,
        channel: 'whatsapp',
        parameters: ['DC/2026/0500', 'WR-BCT-2026'],
      },
      plain,
    );
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('AUTHORITY_REQUIRED');
    expect(sent).toHaveLength(before);
  });

  it('refuses a NON-WRITER holding the authority before anything is sent', async () => {
    // The registrar's `role: 'writer'` runs inside the tenant callback,
    // and the send opens its own transactions — so before the role
    // travelled into the `authorise` hook, a site or viewer member with
    // the authority put a real message on the wire and only THEN met the
    // wall, with the audit row rolled back off a delivery that happened.
    const before = sent.length;
    const beforeLog = (await log()).messages.length;
    const response = await send(
      {
        templateId: approvedTemplateId,
        contactId,
        channel: 'whatsapp',
        parameters: ['DC/2026/0700', 'WR-BCT-2026'],
      },
      viewer,
    );
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('ROLE_FORBIDDEN');
    expect(sent, 'nothing may reach the transport').toHaveLength(before);
    expect((await log()).messages).toHaveLength(beforeLog);
  });

  it('writes the audit event in the same transaction that records the send', async () => {
    const response = await send({
      templateId: approvedTemplateId,
      contactId,
      channel: 'whatsapp',
      parameters: ['DC/2026/0701', 'WR-BCT-2026'],
    });
    expect(response.statusCode, response.body).toBe(201);
    const { message } = response.json<NotificationMessageResponse>();
    const [event] = await admin<{ action: string }[]>`
      select action from audit_events
      where organisation_id = ${organisationId} and entity_id = ${message.id}
    `;
    expect(event?.action).toBe('notification.sent');
  });

  it('lets a non-owner holding the authority read and send, but not save a channel', async () => {
    const read = await authed(office, {
      method: 'GET',
      url: '/api/notifications',
      organisationId,
    });
    expect(read.statusCode, read.body).toBe(200);

    const sent = await send(
      {
        templateId: approvedTemplateId,
        contactId,
        channel: 'whatsapp',
        parameters: ['DC/2026/0200', 'WR-BCT-2026'],
      },
      office,
    );
    expect(sent.statusCode, sent.body).toBe(201);

    const save = await authed(office, {
      method: 'PUT',
      url: '/api/notification-channels/whatsapp',
      organisationId,
      payload: { enabled: false },
    });
    expect(save.statusCode, save.body).toBe(403);
    expect(save.json<{ code: string }>().code).toBe('OWNER_REQUIRED');
  });

  it('cannot reach another organisation’s registers or its contacts', async () => {
    const cross = await authed(outsider, {
      method: 'GET',
      url: '/api/notifications',
      organisationId,
    });
    expect(cross.statusCode, cross.body).toBe(403);

    // …and a contact of the other organisation is simply not there.
    const stranger = await send({
      templateId: approvedTemplateId,
      contactId: outsiderContactId,
      parameters: ['DC/2026/0300', 'WR-BCT-2026'],
    });
    expect(stranger.statusCode, stranger.body).toBe(404);
    expect(stranger.json<{ code: string }>().code).toBe(
      'NOTIFICATION_CONTACT_NOT_FOUND',
    );
  });
});

describe('the database’s own arm', () => {
  it('freezes what a sent notification recorded', async () => {
    const [row] = await admin<{ id: string }[]>`
      select id from notification_messages
      where organisation_id = ${organisationId} and status = 'sent'
      limit 1
    `;
    if (!row) throw new Error('no sent notification to freeze');
    await expect(
      admin`
        update notification_messages set to_address = '+910000000000'
        where id = ${row.id}
      `,
    ).rejects.toMatchObject({ code: '23K08' });
  });

  it('refuses a delivery status that goes backwards', async () => {
    const [row] = await admin<{ id: string }[]>`
      select id from notification_messages
      where organisation_id = ${organisationId} and status = 'read'
      limit 1
    `;
    if (!row) throw new Error('no read notification to rewind');
    await expect(
      admin`update notification_messages set status = 'sent' where id = ${row.id}`,
    ).rejects.toMatchObject({ code: '23K09' });
  });

  it('refuses a message on a channel that is switched off', async () => {
    await admin`
      update notification_channels set enabled = false
      where organisation_id = ${organisationId} and channel = 'whatsapp'
    `;
    try {
      const refusal = await send({
        templateId: approvedTemplateId,
        contactId,
        channel: 'whatsapp',
        parameters: ['DC/2026/0400', 'WR-BCT-2026'],
      });
      expect(refusal.statusCode, refusal.body).toBe(409);
      expect(refusal.json<{ code: string }>().code).toBe(
        'NOTIFICATION_CHANNEL_NOT_CONFIGURED',
      );
    } finally {
      await admin`
        update notification_channels set enabled = true
        where organisation_id = ${organisationId} and channel = 'whatsapp'
      `;
    }
  });
});

describe('the registers', () => {
  it('reads back the consent register and the delivery log', async () => {
    const consents = await authed(owner, {
      method: 'GET',
      url: '/api/notification-consents',
      organisationId,
    });
    expect(consents.statusCode, consents.body).toBe(200);
    const consentBody = consents.json<NotificationConsentListResponse>();
    expect(consentBody.consents.length).toBeGreaterThanOrEqual(2);
    expect(consentBody.consents[0]?.contactDesignation).toBeTruthy();

    const templates = await authed(owner, {
      method: 'GET',
      url: '/api/notification-templates',
      organisationId,
    });
    expect(templates.statusCode, templates.body).toBe(200);
    expect(
      templates.json<NotificationTemplateListResponse>().templates.length,
    ).toBeGreaterThanOrEqual(3);

    const { messages } = await log();
    expect(messages.length).toBeGreaterThanOrEqual(3);
    // Newest first, and each row names the template it was rendered from
    // rather than carrying a second copy of the rendered text.
    expect(messages[0]?.templateName).toBeTruthy();
    expect(messages[0]?.parameters).toBeInstanceOf(Array);
  });

  it('pages the delivery log by keyset', async () => {
    const first = await authed(owner, {
      method: 'GET',
      url: '/api/notifications?limit=2',
      organisationId,
    });
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<NotificationMessageListResponse>();
    expect(page.messages).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    const second = await authed(owner, {
      method: 'GET',
      url: `/api/notifications?limit=2&cursor=${page.nextCursor ?? ''}`,
      organisationId,
    });
    expect(second.statusCode, second.body).toBe(200);
    const next = second.json<NotificationMessageListResponse>();
    const firstIds = new Set(page.messages.map((message) => message.id));
    for (const message of next.messages) expect(firstIds.has(message.id)).toBe(false);
  });

  it('records the consent as an unwritable-through response body', async () => {
    const response = await authed(owner, {
      method: 'PUT',
      url: '/api/notification-consents',
      organisationId,
      payload: {
        contactId: emailContactId,
        channel: 'email',
        address: CONSENTED_EMAIL,
        state: 'opted_in',
        evidence: 'Re-confirmed by email on 16 Aug 2026',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { consent } = response.json<NotificationConsentResponse>();
    expect(consent.evidence).toBe('Re-confirmed by email on 16 Aug 2026');
    expect(consent.address).toBe(CONSENTED_EMAIL);
  });
});
