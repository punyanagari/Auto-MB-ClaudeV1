import {
  CreateNotificationTemplateSchema,
  NotificationChannelListResponseSchema,
  NotificationChannelResponseSchema,
  NotificationConsentListResponseSchema,
  NotificationConsentResponseSchema,
  NotificationMessageListResponseSchema,
  NotificationMessageResponseSchema,
  NotificationTemplateListResponseSchema,
  NotificationTemplateResponseSchema,
  RecordNotificationConsentSchema,
  SaveNotificationChannelSchema,
  SendNotificationSchema,
  SetNotificationTemplateStatusSchema,
  withKeysetQuery,
  type NotificationChannel,
  type NotificationChannelName,
  type NotificationConsent,
  type NotificationMessage,
  type NotificationTemplate,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { FastifyRequest } from 'fastify';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { requireAuthorities } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import {
  rethrowNotificationWriteRefusal,
  sendTemplatedNotification,
} from '../notify/send.js';
import type { NotificationTransports } from '../notify/transport.js';
import { keysetPage, sqlLimit } from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  audit,
  errorResponses,
  IdParamsSchema,
  upstreamErrorResponses,
} from './shared.js';

/**
 * Notifications (migration 0092).
 *
 * ## The shape of the thing
 *
 * Four registers and one act. An owner configures the channels the
 * organisation speaks through, maintains the templates it is allowed to
 * say, and records each recipient's consent; anyone holding the
 * notifications authority can then send a template to a consenting
 * contact and read what became of it. WhatsApp is the primary channel and
 * email the secondary one, and the send path picks between them from the
 * configuration and the consent rather than from a caller's opinion —
 * see `notify/send.ts`, which is the surface the later document-delivery
 * and MSME-alerting packs are built on.
 *
 * ## What this file never holds
 *
 * A WhatsApp access token, a Meta app secret or an SMTP password. Those
 * are the deployment's, read from the environment into an injected
 * adapter (`notify/meta-cloud.ts`, `notify/smtp.ts`), exactly as the
 * statutory transport works. No route accepts one and no column stores
 * one. What the routes DO accept is identity — a phone number id, a
 * display number, a sender address — which an operator must be able to
 * read back and compare against the Meta console.
 *
 * ## Why the webhook routes are unbound
 *
 * Meta is not a member of anything. A delivery receipt is a fact from
 * outside the organisation, arriving on a public address with nobody's
 * authority behind it, so there is no session for `requireUser` to prove
 * and no member to bind a transaction as. What stands in place of a
 * session is the HMAC: `POST /api/notifications/webhook` verifies
 * Meta's `X-Hub-Signature-256` over the RAW request body before it reads
 * a single field, and refuses everything it cannot verify — a missing
 * header, a malformed one and a wrong digest alike. The write it then
 * makes is one narrow SECURITY DEFINER call that can move at most one
 * row, forwards only (migration 0092 § 5).
 *
 * The two addresses are listed in
 * `test/route-inventory.integration.test.ts`'s `UNBOUND_ROUTES`, and
 * because that listing exempts them from the inventory's 401 and 403
 * sweeps, `test/notifications.integration.test.ts` carries the
 * replacements: an unsigned request, a wrongly-signed one and one signed
 * with the wrong secret are each proved to be refused.
 *
 * ## Permissions
 *
 * Everything a member does here carries the `notifications` authority
 * (0092, owner-rules pattern). Configuring a channel is owner-only on top
 * of that: it decides which number the organisation speaks from, which is
 * the same class of decision as handing out a kiosk credential.
 */

/** The register's default page. Sized like the signing queue's: a
 * delivery log is scrolled rather than paged through. */
const PAGE_LIMIT = 100;

/* --- Rows and mappers ------------------------------------------------------ */

interface ChannelRow {
  id: string;
  channel: NotificationChannelName;
  enabled: boolean;
  waba_phone_number_id: string | null;
  waba_business_account_id: string | null;
  display_phone_number: string | null;
  api_base_url: string | null;
  from_address: string | null;
  reply_to_address: string | null;
  updated_at: Date;
}

interface TemplateRow {
  id: string;
  name: string;
  language: string;
  category: NotificationTemplate['category'];
  status: NotificationTemplate['status'];
  status_reason: string | null;
  body_text: string;
  parameter_count: number;
  email_subject: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ConsentRow {
  id: string;
  contact_id: string;
  contact_designation: string;
  channel: NotificationChannelName;
  address: string;
  state: NotificationConsent['state'];
  evidence: string;
  recorded_by_user_id: string;
  recorded_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  channel: NotificationChannelName;
  template_id: string;
  template_name: string;
  template_language: string;
  contact_id: string;
  contact_designation: string;
  to_address: string;
  parameters: unknown;
  status: NotificationMessage['status'];
  provider: NotificationMessage['provider'];
  provider_message_id: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  requested_by_user_id: string;
  queued_at: Date;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  failed_at: Date | null;
}

function toChannel(row: ChannelRow, transports: NotificationTransports): NotificationChannel {
  return {
    id: row.id,
    channel: row.channel,
    enabled: row.enabled,
    wabaPhoneNumberId: row.waba_phone_number_id,
    wabaBusinessAccountId: row.waba_business_account_id,
    displayPhoneNumber: row.display_phone_number,
    apiBaseUrl: row.api_base_url,
    fromAddress: row.from_address,
    replyToAddress: row.reply_to_address,
    transportConfigured:
      row.channel === 'whatsapp'
        ? transports.whatsapp !== undefined
        : transports.email !== undefined,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toTemplate(row: TemplateRow): NotificationTemplate {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    statusReason: row.status_reason,
    bodyText: row.body_text,
    parameterCount: row.parameter_count,
    emailSubject: row.email_subject,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toConsent(row: ConsentRow): NotificationConsent {
  return {
    id: row.id,
    contactId: row.contact_id,
    contactDesignation: row.contact_designation,
    channel: row.channel,
    address: row.address,
    state: row.state,
    evidence: row.evidence,
    recordedByUserId: row.recorded_by_user_id,
    recordedAt: row.recorded_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMessage(row: MessageRow): NotificationMessage {
  const parameters = parseJsonbColumn(row.parameters);
  return {
    id: row.id,
    channel: row.channel,
    templateId: row.template_id,
    templateName: row.template_name,
    templateLanguage: row.template_language,
    contactId: row.contact_id,
    contactDesignation: row.contact_designation,
    toAddress: row.to_address,
    parameters: Array.isArray(parameters) ? parameters.map((value) => String(value)) : [],
    status: row.status,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    requestedByUserId: row.requested_by_user_id,
    queuedAt: row.queued_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    readAt: row.read_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
  };
}

const MESSAGE_COLUMNS = `
  m.id, m.channel, m.template_id, t.name as template_name,
  t.language as template_language, m.contact_id,
  c.designation as contact_designation, m.to_address, m.parameters, m.status,
  m.provider, m.provider_message_id, m.failure_code, m.failure_detail,
  m.requested_by_user_id, m.queued_at, m.sent_at, m.delivered_at, m.read_at,
  m.failed_at`;

async function readMessage(tx: TransactionSql, id: string): Promise<NotificationMessage> {
  const [row] = await tx<MessageRow[]>`
    select ${tx.unsafe(MESSAGE_COLUMNS)}
    from notification_messages m
    join notification_templates t on t.id = m.template_id
    join contacts c on c.id = m.contact_id
    where m.id = ${id}
  `;
  if (!row) throw new Error(`notification ${id} disappeared after it was sent`);
  return toMessage(row);
}

/* --- Meta's webhook payload ------------------------------------------------ */

const WEBHOOK_STATUS_MAP: Readonly<Record<string, 'sent' | 'delivered' | 'read' | 'failed'>> =
  {
    sent: 'sent',
    delivered: 'delivered',
    read: 'read',
    failed: 'failed',
  };

interface Receipt {
  readonly phoneNumberId: string;
  readonly providerMessageId: string;
  readonly status: 'sent' | 'delivered' | 'read' | 'failed';
  readonly occurredAt: Date;
  readonly failureCode: string | null;
  readonly failureDetail: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The delivery receipts inside one webhook body, and nothing else.
 *
 * Meta packs several unrelated things into `entry[].changes[].value`: the
 * `statuses` array this reads, a `messages` array carrying inbound
 * replies, and occasional account-level events. Only `statuses` is read.
 * Inbound replies are deliberately ignored rather than half-handled —
 * deciding what a reply of "STOP" does to a consent record is an owner's
 * rule to state, not a keyword list to infer — and anything unrecognised
 * is dropped without comment, because a webhook receiver that fails on a
 * field Meta added last week is a receiver that stops recording
 * deliveries.
 *
 * Written as a total function over `unknown`: this input is attacker-
 * shaped even after the signature check, because the signature proves who
 * sent the bytes and not what is in them.
 */
export function receiptsOf(payload: unknown): readonly Receipt[] {
  const receipts: Receipt[] = [];
  const entries = record(payload)?.entry;
  if (!Array.isArray(entries)) return receipts;
  for (const entry of entries) {
    const changes = record(entry)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = record(record(change)?.value);
      if (value === null) continue;
      const phoneNumberId = readString(record(value.metadata)?.phone_number_id);
      const statuses = value.statuses;
      if (phoneNumberId === null || !Array.isArray(statuses)) continue;
      for (const raw of statuses) {
        const status = record(raw);
        if (status === null) continue;
        const providerMessageId = readString(status.id);
        const mapped = WEBHOOK_STATUS_MAP[readString(status.status) ?? ''];
        if (providerMessageId === null || mapped === undefined) continue;
        // Meta sends a UNIX second count as a decimal string.
        const seconds = Number(readString(status.timestamp) ?? '');
        const occurredAt =
          Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
        const errors = status.errors;
        const firstError = Array.isArray(errors) ? record(errors[0]) : null;
        const failureCode =
          firstError === null
            ? null
            : (readString(firstError.code) ?? String(firstError.code ?? '')) || null;
        receipts.push({
          phoneNumberId,
          providerMessageId,
          status: mapped,
          occurredAt,
          // Only a symbolic code and Meta's own short title. Never
          // `error_data.details`, which quotes the recipient's number.
          failureCode: failureCode === null ? null : failureCode.slice(0, 64),
          failureDetail: readString(firstError?.title)?.slice(0, 500) ?? null,
        });
      }
    }
  }
  return receipts;
}

/** Fastify parses JSON before a handler runs, so the raw bytes the
 * signature covers have to be captured on the way past. Registered as a
 * content-type parser scoped to the webhook route's own plugin instance
 * by `registerNotificationRoutes` below. */
interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

/* --- The routes ------------------------------------------------------------ */

export function registerNotificationRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  transports: NotificationTransports = {},
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  /* --- Channels ----------------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/notification-channels',
      schema: {
        response: { 200: NotificationChannelListResponseSchema, ...errorResponses },
      },
      authority: 'notifications',
    },
    async ({ tenant }) =>
      tenant(async (tx) => {
        const rows = await tx<ChannelRow[]>`
          select id, channel, enabled, waba_phone_number_id, waba_business_account_id,
                 display_phone_number, api_base_url, from_address, reply_to_address,
                 updated_at
          from notification_channels order by channel
        `;
        return { channels: rows.map((row) => toChannel(row, transports)) };
      }),
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/notification-channels/:channel',
      schema: {
        params: Type.Object(
          {
            channel: Type.Union([Type.Literal('whatsapp'), Type.Literal('email')]),
          },
          { additionalProperties: false },
        ),
        body: SaveNotificationChannelSchema,
        response: { 200: NotificationChannelResponseSchema, ...errorResponses },
      },
      // Owner-only ON TOP of the authority, for the reason the signing
      // kiosk is: this decides which telephone number the organisation
      // speaks from, and pointing it somewhere else is not an editing
      // mistake anybody notices from the register.
      role: 'owner',
      authority: 'notifications',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { channel } = request.params;
      const body = request.body;
      // Each channel carries only its own fields, which is what 0092's
      // shape CHECK says. Normalising here rather than trusting the body
      // means an email row can never arrive holding a phone number id
      // just because a client sent one.
      const whatsapp = channel === 'whatsapp';
      const values = {
        wabaPhoneNumberId: whatsapp ? (body.wabaPhoneNumberId ?? null) : null,
        wabaBusinessAccountId: whatsapp ? (body.wabaBusinessAccountId ?? null) : null,
        displayPhoneNumber: whatsapp ? (body.displayPhoneNumber ?? null) : null,
        apiBaseUrl: whatsapp ? (body.apiBaseUrl ?? null) : null,
        fromAddress: whatsapp ? null : (body.fromAddress ?? null),
        replyToAddress: whatsapp ? null : (body.replyToAddress ?? null),
      };
      const saved = await tenant(async (tx) => {
        // The route makes the same refusal 0092's guard makes, first and
        // under no lock, so the operator gets a remedy rather than a
        // SQLSTATE.
        //
        // INSIDE the bound transaction, not before it: the registrar
        // proves membership, role and authority as this callback opens,
        // and a state refusal that ran ahead of them would answer a
        // non-member with 409 instead of 403. The route inventory's
        // non-member sweep is what caught that.
        if (
          body.enabled &&
          whatsapp &&
          (values.wabaPhoneNumberId === null ||
            values.wabaBusinessAccountId === null ||
            values.displayPhoneNumber === null)
        ) {
          throw httpError(
            409,
            'NOTIFICATION_CHANNEL_INCOMPLETE',
            'The WhatsApp channel needs its phone number id, business account id and display number before it can be enabled.',
          );
        }
        if (body.enabled && !whatsapp && values.fromAddress === null) {
          throw httpError(
            409,
            'NOTIFICATION_CHANNEL_INCOMPLETE',
            'The email channel needs a sender address before it can be enabled.',
          );
        }
        const [row] = await tx<ChannelRow[]>`
          insert into notification_channels (
            organisation_id, channel, enabled, waba_phone_number_id,
            waba_business_account_id, display_phone_number, api_base_url,
            from_address, reply_to_address, configured_by_user_id
          )
          values (
            ${organisationId}, ${channel}, ${body.enabled},
            ${values.wabaPhoneNumberId}, ${values.wabaBusinessAccountId},
            ${values.displayPhoneNumber}, ${values.apiBaseUrl},
            ${values.fromAddress}, ${values.replyToAddress}, ${user.id}
          )
          on conflict (organisation_id, channel) do update
          set enabled = excluded.enabled,
              waba_phone_number_id = excluded.waba_phone_number_id,
              waba_business_account_id = excluded.waba_business_account_id,
              display_phone_number = excluded.display_phone_number,
              api_base_url = excluded.api_base_url,
              from_address = excluded.from_address,
              reply_to_address = excluded.reply_to_address,
              configured_by_user_id = excluded.configured_by_user_id
          returning id, channel, enabled, waba_phone_number_id,
                    waba_business_account_id, display_phone_number, api_base_url,
                    from_address, reply_to_address, updated_at
        `.catch(rethrowNotificationWriteRefusal);
        if (!row) throw new Error('the notification channel was not written');
        await audit(
          tx,
          organisationId,
          user.id,
          'notification_channel.saved',
          'notification_channels',
          row.id,
          { channel, enabled: body.enabled },
        );
        return row;
      });
      return { channel: toChannel(saved, transports) };
    },
  );

  /* --- Templates ---------------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/notification-templates',
      schema: {
        querystring: withKeysetQuery(Type.Object({}, { additionalProperties: false })),
        response: { 200: NotificationTemplateListResponseSchema, ...errorResponses },
      },
      authority: 'notifications',
    },
    async ({ request, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        const limit = query.limit ?? PAGE_LIMIT;
        const rows = await tx<TemplateRow[]>`
          select id, name, language, category, status, status_reason, body_text,
                 parameter_count, email_subject, created_at, updated_at
          from notification_templates
          where (
            ${query.cursor ?? null}::uuid is null
            or (name, language, id) >
               (select name, language, id from notification_templates
                where id = ${query.cursor ?? null})
          )
          order by name, language, id
          limit ${sqlLimit(limit)}
        `;
        const page = keysetPage(rows, limit, (row) => row.id);
        return { templates: page.rows.map(toTemplate), nextCursor: page.nextCursor };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/notification-templates',
      schema: {
        body: CreateNotificationTemplateSchema,
        response: { 201: NotificationTemplateResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'notifications',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      // Counted here rather than stored blindly: the number the database
      // enforces against every send has to be the number this body
      // actually takes, and a client-supplied count would be a second
      // thing that can be wrong.
      const parameterCount = parameterCountOf(body.bodyText);
      const template = await tenant(async (tx) => {
        const [row] = await tx<TemplateRow[]>`
          insert into notification_templates (
            organisation_id, name, language, category, body_text, parameter_count,
            email_subject, created_by_user_id
          )
          values (
            ${organisationId}, ${body.name}, ${body.language}, ${body.category},
            ${body.bodyText}, ${parameterCount}, ${body.emailSubject ?? null}, ${user.id}
          )
          returning id, name, language, category, status, status_reason, body_text,
                    parameter_count, email_subject, created_at, updated_at
        `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'NOTIFICATION_TEMPLATE_EXISTS',
              `A template named ${body.name} in ${body.language} already exists; Meta identifies a template by both.`,
            );
          }
          return rethrowNotificationWriteRefusal(error);
        });
        if (!row) throw new Error('the notification template was not written');
        await audit(
          tx,
          organisationId,
          user.id,
          'notification_template.created',
          'notification_templates',
          row.id,
          { name: body.name, language: body.language },
        );
        return row;
      });
      return reply.status(201).send({ template: toTemplate(template) });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/notification-templates/:id/status',
      schema: {
        params: IdParamsSchema,
        body: SetNotificationTemplateStatusSchema,
        response: { 200: NotificationTemplateResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'notifications',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const template = await tenant(async (tx) => {
        const [current] = await tx<{ status: string }[]>`
          select status from notification_templates where id = ${id} for update
        `;
        if (!current) {
          throw httpError(
            404,
            'NOTIFICATION_TEMPLATE_NOT_FOUND',
            'No such notification template.',
          );
        }
        // A reason belongs to a decision Meta made, and 0092's CHECK says
        // so. Refused here first so the operator is told which field to
        // clear rather than meeting a 23514.
        if (
          body.reason !== undefined &&
          !['rejected', 'paused', 'disabled'].includes(body.status)
        ) {
          throw httpError(
            409,
            'NOTIFICATION_TEMPLATE_STATE',
            'A reason records what Meta said when it refused, paused or withdrew a template, so it cannot accompany a submission or an approval.',
          );
        }
        const [row] = await tx<TemplateRow[]>`
          update notification_templates
          set status = ${body.status}, status_reason = ${body.reason ?? null}
          where id = ${id}
          returning id, name, language, category, status, status_reason, body_text,
                    parameter_count, email_subject, created_at, updated_at
        `.catch(rethrowNotificationWriteRefusal);
        if (!row) throw new Error(`notification template ${id} disappeared while locked`);
        await audit(
          tx,
          organisationId,
          user.id,
          'notification_template.status_recorded',
          'notification_templates',
          id,
          { from: current.status, to: body.status },
        );
        return row;
      });
      return { template: toTemplate(template) };
    },
  );

  /* --- Consent ------------------------------------------------------------ */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/notification-consents',
      schema: {
        querystring: withKeysetQuery(Type.Object({}, { additionalProperties: false })),
        response: { 200: NotificationConsentListResponseSchema, ...errorResponses },
      },
      authority: 'notifications',
    },
    async ({ request, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        const limit = query.limit ?? PAGE_LIMIT;
        const rows = await tx<ConsentRow[]>`
          select n.id, n.contact_id, c.designation as contact_designation, n.channel,
                 n.address, n.state, n.evidence, n.recorded_by_user_id, n.recorded_at,
                 n.updated_at
          from notification_consents n
          join contacts c on c.id = n.contact_id
          where (
            ${query.cursor ?? null}::uuid is null
            or (n.recorded_at, n.id) <
               (select recorded_at, id from notification_consents
                where id = ${query.cursor ?? null})
          )
          order by n.recorded_at desc, n.id desc
          limit ${sqlLimit(limit)}
        `;
        const page = keysetPage(rows, limit, (row) => row.id);
        return { consents: page.rows.map(toConsent), nextCursor: page.nextCursor };
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/notification-consents',
      schema: {
        body: RecordNotificationConsentSchema,
        response: { 200: NotificationConsentResponseSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'notifications',
    },
    async ({ request, user, organisationId, tenant }) => {
      const body = request.body;
      const address = body.address.trim();
      const consent = await tenant(async (tx) => {
        const [contact] = await tx<{ id: string }[]>`
          select id from contacts where id = ${body.contactId} and active
        `;
        if (!contact) {
          throw httpError(
            404,
            'NOTIFICATION_CONTACT_NOT_FOUND',
            'No such contact, or it has been retired.',
          );
        }
        const [row] = await tx<ConsentRow[]>`
          with saved as (
            insert into notification_consents (
              organisation_id, contact_id, channel, address, state, evidence,
              recorded_by_user_id
            )
            values (
              ${organisationId}, ${body.contactId}, ${body.channel}, ${address},
              ${body.state}, ${body.evidence.trim()}, ${user.id}
            )
            on conflict (organisation_id, contact_id, channel) do update
            set address = excluded.address, state = excluded.state,
                evidence = excluded.evidence,
                recorded_by_user_id = excluded.recorded_by_user_id
            returning *
          )
          select saved.id, saved.contact_id, c.designation as contact_designation,
                 saved.channel, saved.address, saved.state, saved.evidence,
                 saved.recorded_by_user_id, saved.recorded_at, saved.updated_at
          from saved join contacts c on c.id = saved.contact_id
        `.catch(rethrowNotificationWriteRefusal);
        if (!row) throw new Error('the consent record was not written');
        await audit(
          tx,
          organisationId,
          user.id,
          'notification_consent.recorded',
          'notification_consents',
          row.id,
          { channel: body.channel, state: body.state },
        );
        return row;
      });
      return { consent: toConsent(consent) };
    },
  );

  /* --- The delivery log --------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/notifications',
      schema: {
        querystring: withKeysetQuery(Type.Object({}, { additionalProperties: false })),
        response: { 200: NotificationMessageListResponseSchema, ...errorResponses },
      },
      authority: 'notifications',
    },
    async ({ request, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        const limit = query.limit ?? PAGE_LIMIT;
        const rows = await tx<MessageRow[]>`
          select ${tx.unsafe(MESSAGE_COLUMNS)}
          from notification_messages m
          join notification_templates t on t.id = m.template_id
          join contacts c on c.id = m.contact_id
          where (
            ${query.cursor ?? null}::uuid is null
            or (m.queued_at, m.id) <
               (select queued_at, id from notification_messages
                where id = ${query.cursor ?? null})
          )
          order by m.queued_at desc, m.id desc
          limit ${sqlLimit(limit)}
        `;
        const page = keysetPage(rows, limit, (row) => row.id);
        return { messages: page.rows.map(toMessage), nextCursor: page.nextCursor };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/notifications',
      schema: {
        body: SendNotificationSchema,
        response: { 201: NotificationMessageResponseSchema, ...upstreamErrorResponses },
      },
      role: 'writer',
      authority: 'notifications',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      // `sendTemplatedNotification` opens its OWN bound transactions, so
      // the registrar's role and authority guard — which runs inside the
      // `tenant()` callback below — does not cover it. The act states
      // its own authority instead, checked as the first statement of the
      // first transaction, before any read and long before the provider
      // is called.
      const messageId = await sendTemplatedNotification(database, transports, {
        organisationId,
        userId: user.id,
        templateId: body.templateId,
        contactId: body.contactId,
        ...(body.channel === undefined ? {} : { channel: body.channel }),
        parameters: body.parameters ?? [],
        authorise: (tx) => requireAuthorities(tx, user.id, ['notifications']),
      });
      const message = await tenant(async (tx) => {
        const sent = await readMessage(tx, messageId);
        await audit(
          tx,
          organisationId,
          user.id,
          'notification.sent',
          'notification_messages',
          messageId,
          { channel: sent.channel, templateId: sent.templateId, status: sent.status },
        );
        return sent;
      });
      return reply.status(201).send({ message });
    },
  );

  /* --- Meta's webhook ----------------------------------------------------- */

  // ENCAPSULATED, so that the raw-body parser below applies to these two
  // addresses and to nothing else. The signature is computed over the
  // exact bytes Meta sent, and a re-serialised object is not those bytes,
  // so the receiver has to hold the buffer — but every other route in the
  // product must keep Fastify's ordinary JSON parsing, and a
  // content-type parser registered on the root instance would change all
  // of them. A child scope is how Fastify says "here and no further".
  void app.register((scope, _options, done) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (request: RawBodyRequest, body: Buffer, parsed) => {
        request.rawBody = body;
        if (body.length === 0) {
          parsed(null, {});
          return;
        }
        try {
          parsed(null, JSON.parse(body.toString('utf8')) as unknown);
        } catch (cause) {
          parsed(cause as Error, undefined);
        }
      },
    );

    /**
     * The subscription handshake. Meta calls this once when the webhook
     * is configured and expects the challenge echoed back as plain text
     * if — and only if — the verify token matches the one the app was
     * configured with.
     *
     * A GET with no side effect, so it is outside the tenant registrar
     * and needs no origin guard. It still fails closed: an unconfigured
     * deployment, a wrong mode and a wrong token all answer 403 rather
     * than echoing anything.
     */
    scope.get('/api/notifications/webhook', async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const transport = transports.whatsapp;
      if (
        transport === undefined ||
        query['hub.mode'] !== 'subscribe' ||
        query['hub.verify_token'] !== transport.webhookVerifyToken ||
        query['hub.challenge'] === undefined
      ) {
        throw httpError(
          403,
          'NOTIFICATION_WEBHOOK_UNVERIFIED',
          'This webhook subscription could not be verified.',
        );
      }
      void reply.type('text/plain; charset=utf-8');
      return reply.send(query['hub.challenge']);
    });

    /**
     * Delivery receipts.
     *
     * SIGNATURE FIRST, ALWAYS. The HMAC is checked over the raw bytes
     * before any field is read, and a body that cannot be verified is
     * refused with 401 — there is no branch that records anything from an
     * unverified payload.
     *
     * AFTER that, the answer is 200 whatever the receipts turn out to be,
     * and that is Meta's rule rather than a shrug: a non-200 makes Meta
     * retry the whole batch, so a receipt this server has already
     * applied — or one for a message it does not know, which is every
     * receipt belonging to another deployment sharing the same Meta
     * app — would be redelivered forever. Nothing is lost by answering
     * 200, because the definer function is idempotent by construction: it
     * only ever moves a row forwards.
     */
    scope.post('/api/notifications/webhook', async (request: RawBodyRequest, reply) => {
      const transport = transports.whatsapp;
      if (transport === undefined) {
        // No app secret means no signature can be checked, and a
        // receiver that cannot check one must not accept anything.
        throw httpError(
          503,
          'NOTIFICATION_TRANSPORT_NOT_CONFIGURED',
          'This deployment has no WhatsApp transport, so webhook receipts cannot be verified.',
        );
      }
      const raw = request.rawBody;
      const header = request.headers['x-hub-signature-256'];
      if (
        raw === undefined ||
        !transport.verifyWebhookSignature(
          raw,
          typeof header === 'string' ? header : undefined,
        )
      ) {
        throw httpError(
          401,
          'NOTIFICATION_WEBHOOK_UNVERIFIED',
          'This webhook body did not carry a valid signature.',
        );
      }

      let applied = 0;
      for (const receipt of receiptsOf(request.body)) {
        const [row] = await database<{ record_notification_receipt: boolean }[]>`
          select app_private.record_notification_receipt(
            ${receipt.phoneNumberId}, ${receipt.providerMessageId}, ${receipt.status},
            ${receipt.occurredAt}, ${receipt.failureCode}, ${receipt.failureDetail}
          )
        `;
        if (row?.record_notification_receipt === true) applied += 1;
      }
      // A count and nothing else. Never a message id, a telephone number
      // or a template body (AGENTS.md rule 11).
      request.log.info({ applied, message: 'notification receipts applied' });
      return reply.status(200).send({ applied });
    });
    done();
  });
}

/** How many ordered `{{n}}` placeholders a template body takes, defined
 * as the HIGHEST index rather than the count of distinct ones: a body
 * using `{{1}}` and `{{3}}` takes three parameters at Meta, because the
 * components array is positional. */
export function parameterCountOf(bodyText: string): number {
  let highest = 0;
  for (const match of bodyText.matchAll(/\{\{(\d{1,2})\}\}/g)) {
    highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}
