/**
 * Sending one templated notification (migration 0092).
 *
 * ## This module is the seam, not the route
 *
 * `sendTemplatedNotification` is what the notifications route calls
 * today, and it is deliberately the whole public surface of the feature:
 * a caller names a template and a contact, and gets back the id of a row
 * in the delivery log. It does not name a channel, an address or a
 * transport. Document delivery over WhatsApp and MSME payment alerting
 * are both built on this call, and neither of them should know or care
 * which road a message took — that is decided here, from the
 * organisation's channel configuration and the contact's own consent.
 *
 * The one field a caller conspicuously CANNOT pass is the recipient's
 * address. It comes from the consent record, because the consent record
 * is the only thing in the system that can say which address this contact
 * agreed to be reached at. A parameter would be a way to send somewhere
 * nobody agreed to, so the rule is expressed as a missing field.
 *
 * ## Three transactions, on purpose
 *
 * The row is written `queued` and committed BEFORE the provider is
 * called, and completed in a second transaction afterwards. This is
 * `gsp/provider-operations.ts`'s shape for the same reason: a process
 * that dies between "we called Meta" and "Meta answered" must leave
 * evidence that it called. A single transaction spanning a network call
 * would either hold a row lock across the internet or lose the attempt
 * entirely.
 */
import type { ErrorCode, NotificationChannelName } from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { httpError } from '../http.js';
import { withBoundTenant } from '../tenant-context.js';
import {
  NotificationTransportError,
  type EmailTarget,
  type NotificationTransports,
  type TemplatedMessage,
  type WhatsAppTarget,
} from './transport.js';

/**
 * Migration 0092's own refusals, mapped to named codes.
 *
 * Every rule below is checked by this module first, under no lock, so an
 * operator gets a 409 with a remedy. These are what an operator sees when
 * that check lost a race — a channel disabled, or a consent withdrawn,
 * between the read and the insert.
 */
export const NOTIFICATION_DATABASE_REFUSALS: Record<
  string,
  readonly [ErrorCode, string]
> = {
  '23K01': [
    'NOTIFICATION_CHANNEL_STATE',
    'Which organisation and which channel a configuration is for cannot be changed.',
  ],
  '23K02': [
    'NOTIFICATION_CHANNEL_INCOMPLETE',
    'This channel cannot be enabled until its own configuration is complete.',
  ],
  '23K03': [
    'NOTIFICATION_TEMPLATE_STATE',
    'The template moved on, or its reviewed body cannot be changed; reload the template list.',
  ],
  '23K04': [
    'NOTIFICATION_CONSENT_STATE',
    'A consent record names one contact on one channel and that cannot be re-pointed.',
  ],
  '23K05': [
    'NOTIFICATION_CHANNEL_NOT_CONFIGURED',
    'That channel is not configured and enabled for this organisation.',
  ],
  '23K06': [
    'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
    'That template cannot be sent on this channel with the parameters given.',
  ],
  '23K07': [
    'NOTIFICATION_CONSENT_MISSING',
    'There is no recorded opt-in for this contact at the address the message is addressed to.',
  ],
  '23K08': [
    'NOTIFICATION_MESSAGE_STATE',
    'What a notification recorded when it was sent cannot be changed afterwards.',
  ],
  '23K09': [
    'NOTIFICATION_MESSAGE_STATE',
    'A delivery status only ever moves forwards; reload the delivery log.',
  ],
};

/** Turns a 0092 trigger refusal into the same named 409 the route makes,
 * and lets anything else through as the 500 it is. */
export function rethrowNotificationWriteRefusal(error: unknown): never {
  const code: unknown =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  const refusal =
    typeof code === 'string' ? NOTIFICATION_DATABASE_REFUSALS[code] : undefined;
  if (refusal) throw httpError(409, refusal[0], refusal[1]);
  throw error;
}

export interface SendTemplatedNotificationInput {
  readonly organisationId: string;
  readonly userId: string;
  readonly templateId: string;
  readonly contactId: string;
  /** Omit to let the organisation's configuration and the contact's
   * consent decide. This is the intended shape for callers built on top
   * of this pack. */
  readonly channel?: NotificationChannelName;
  readonly parameters: readonly string[];
  /**
   * The caller's own authority check, run as the FIRST statement of the
   * first bound transaction — before any read, and long before the
   * provider is called.
   *
   * It is a parameter rather than a fixed `requireAuthorities(…,
   * ['notifications'])` because the authority a send needs belongs to the
   * ACT, not to the transport. Configuring a channel from the
   * notifications screen needs the notifications authority; delivering an
   * issued challan over WhatsApp will need the issue authority, and
   * making that caller also hold the notifications one would mean every
   * clerk who may issue a document could also repoint the organisation's
   * outbound number.
   *
   * It is not optional, and that is the point: this function opens its
   * own transactions rather than running inside the route's, so the
   * registrar's guard does not cover it. A caller that had nothing to
   * check would have to say so out loud.
   */
  readonly authorise: (tx: TransactionSql) => Promise<void>;
}

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly body_text: string;
  readonly parameter_count: number;
  readonly email_subject: string | null;
}

interface ChannelRow {
  readonly channel: NotificationChannelName;
  readonly enabled: boolean;
  readonly waba_phone_number_id: string | null;
  readonly api_base_url: string | null;
  readonly from_address: string | null;
  readonly reply_to_address: string | null;
}

interface ConsentRow {
  readonly channel: NotificationChannelName;
  readonly address: string;
  readonly state: string;
}

/** Why one candidate channel could not carry this message. Kept as a
 * pair rather than thrown immediately, because the automatic path tries
 * WhatsApp first and must be able to fall through to email without
 * losing the reason WhatsApp was unusable. */
type Refusal = readonly [ErrorCode, string];

function channelRefusal(
  channel: NotificationChannelName,
  template: TemplateRow,
  channels: readonly ChannelRow[],
  consents: readonly ConsentRow[],
  transports: NotificationTransports,
  parameters: readonly string[],
): Refusal | null {
  const configured = channels.find((row) => row.channel === channel);
  if (configured === undefined || !configured.enabled) {
    return [
      'NOTIFICATION_CHANNEL_NOT_CONFIGURED',
      `The ${channel} channel is not configured and enabled for this organisation.`,
    ];
  }
  if (channel === 'whatsapp' && transports.whatsapp === undefined) {
    return [
      'NOTIFICATION_TRANSPORT_NOT_CONFIGURED',
      'This deployment has no WhatsApp transport configured, so nothing can be sent even though the organisation is set up for it.',
    ];
  }
  if (channel === 'email' && transports.email === undefined) {
    return [
      'NOTIFICATION_TRANSPORT_NOT_CONFIGURED',
      'This deployment has no mail relay configured, so nothing can be sent even though the organisation is set up for it.',
    ];
  }
  if (channel === 'whatsapp' && template.status !== 'approved') {
    return [
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
      `Template ${template.name}/${template.language} is ${template.status} at Meta, and only an approved template may be sent over WhatsApp.`,
    ];
  }
  if (channel === 'email' && template.email_subject === null) {
    return [
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
      `Template ${template.name}/${template.language} has no subject line, so it cannot be sent by email.`,
    ];
  }
  if (parameters.length !== template.parameter_count) {
    return [
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
      `Template ${template.name}/${template.language} takes ${String(template.parameter_count)} parameters and was given ${String(parameters.length)}.`,
    ];
  }
  const consent = consents.find((row) => row.channel === channel);
  if (consent === undefined || consent.state !== 'opted_in') {
    return [
      'NOTIFICATION_CONSENT_MISSING',
      `This contact has no recorded opt-in for ${channel}.`,
    ];
  }
  return null;
}

/** WhatsApp first, email second: the ordering is a fact about the
 * customer's counterparties, not a preference. */
const CHANNEL_PREFERENCE: readonly NotificationChannelName[] = ['whatsapp', 'email'];

export async function sendTemplatedNotification(
  database: Sql,
  transports: NotificationTransports,
  input: SendTemplatedNotificationInput,
): Promise<string> {
  const prepared = await withBoundTenant(
    database,
    input.organisationId,
    input.userId,
    async (tx) => {
      // First statement of the first transaction: the membership floor
      // has just been proved by the bind, and this is the act's own
      // authority on top of it. Nothing is read and nothing is sent
      // before it passes.
      await input.authorise(tx);

      const [template] = await tx<TemplateRow[]>`
        select id, name, language, status, body_text, parameter_count, email_subject
        from notification_templates where id = ${input.templateId}
      `;
      if (!template) {
        throw httpError(
          404,
          'NOTIFICATION_TEMPLATE_NOT_FOUND',
          'No such notification template.',
        );
      }

      const [contact] = await tx<{ id: string }[]>`
        select id from contacts where id = ${input.contactId} and active
      `;
      if (!contact) {
        throw httpError(
          404,
          'NOTIFICATION_CONTACT_NOT_FOUND',
          'No such contact, or it has been retired.',
        );
      }

      const channels = await tx<ChannelRow[]>`
        select channel, enabled, waba_phone_number_id, api_base_url,
               from_address, reply_to_address
        from notification_channels
      `;
      const consents = await tx<ConsentRow[]>`
        select channel, address, state
        from notification_consents where contact_id = ${input.contactId}
      `;

      const candidates =
        input.channel === undefined ? CHANNEL_PREFERENCE : [input.channel];
      let firstRefusal: Refusal | null = null;
      let chosen: NotificationChannelName | null = null;
      for (const candidate of candidates) {
        const refusal = channelRefusal(
          candidate,
          template,
          channels,
          consents,
          transports,
          input.parameters,
        );
        if (refusal === null) {
          chosen = candidate;
          break;
        }
        firstRefusal ??= refusal;
      }
      if (chosen === null) {
        // `firstRefusal` is set whenever `chosen` is null, because the
        // candidate list is never empty. The fallback exists so the type
        // is honest rather than asserted.
        const [code, message] = firstRefusal ?? [
          'NOTIFICATION_CHANNEL_NOT_CONFIGURED' as const,
          'No notification channel is configured for this organisation.',
        ];
        throw httpError(409, code, message);
      }

      const channelRow = channels.find((row) => row.channel === chosen);
      const consent = consents.find((row) => row.channel === chosen);
      if (channelRow === undefined || consent === undefined) {
        throw new Error('the chosen notification channel disappeared while locked');
      }

      const provider =
        chosen === 'email' ? 'smtp' : (transports.whatsapp?.provider ?? 'meta_cloud');

      const [row] = await tx<{ id: string }[]>`
        insert into notification_messages (
          organisation_id, channel, template_id, contact_id, to_address,
          parameters, provider, requested_by_user_id
        )
        values (
          ${input.organisationId}, ${chosen}, ${template.id}, ${input.contactId},
          ${consent.address}, ${tx.json([...input.parameters] as never)},
          ${provider}, ${input.userId}
        )
        returning id
      `.catch(rethrowNotificationWriteRefusal);
      if (!row) throw new Error('the notification row was not written');

      const message: TemplatedMessage = {
        toAddress: consent.address,
        templateName: template.name,
        language: template.language,
        parameters: input.parameters,
        bodyText: template.body_text,
        subject: template.email_subject,
      };
      return { messageId: row.id, channel: chosen, channelRow, message };
    },
  );

  let providerMessageId: string | null = null;
  let failure: { readonly code: string; readonly detail: string | null } | null = null;
  try {
    if (prepared.channel === 'whatsapp') {
      const transport = transports.whatsapp;
      if (transport === undefined)
        throw new Error('the WhatsApp transport disappeared');
      const target: WhatsAppTarget = {
        // Both are non-null: the channel could not have been enabled
        // without them (0092's guard), and the row was read inside the
        // same transaction that proved it enabled.
        phoneNumberId: prepared.channelRow.waba_phone_number_id ?? '',
        apiBaseUrl: prepared.channelRow.api_base_url,
      };
      providerMessageId = await transport.send(target, prepared.message);
    } else {
      const transport = transports.email;
      if (transport === undefined) throw new Error('the email transport disappeared');
      const target: EmailTarget = {
        fromAddress: prepared.channelRow.from_address ?? '',
        replyToAddress: prepared.channelRow.reply_to_address,
      };
      providerMessageId = await transport.send(target, prepared.message);
    }
  } catch (cause) {
    if (!(cause instanceof NotificationTransportError)) throw cause;
    failure = { code: cause.providerCode, detail: cause.detail };
  }

  await withBoundTenant(database, input.organisationId, input.userId, async (tx) => {
    if (failure === null) {
      await tx`
        update notification_messages
        set status = 'sent', sent_at = now(), provider_message_id = ${providerMessageId}
        where id = ${prepared.messageId}
      `.catch(rethrowNotificationWriteRefusal);
      return;
    }
    await tx`
      update notification_messages
      set status = 'failed', failed_at = now(),
          failure_code = ${failure.code}, failure_detail = ${failure.detail}
      where id = ${prepared.messageId}
    `.catch(rethrowNotificationWriteRefusal);
  });

  if (failure !== null) {
    throw httpError(
      502,
      'NOTIFICATION_SEND_FAILED',
      `The ${prepared.channel} provider refused the message (${failure.code}). Nothing was delivered and the attempt is on the delivery log.`,
    );
  }
  return prepared.messageId;
}
